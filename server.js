const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const JWT_SECRET = 'nextalk_super_secret_jwt_key_2024';
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// IN-MEMORY DATABASE
// ============================================================
const db = {
  users: [],
  messages: {},      // { convKey: [{ id, fromId, text, ts, deleted }] }
  invitations: [],   // { id, fromId, toEmail, token, status, createdAt }
  sessions: new Map() // wsClientId -> userId
};

// Seed default users
async function seedUsers() {
  const users = [
    { name: 'Super Admin', email: 'admin@nextalk.io', password: 'Admin@1234', role: 'superadmin' },
    { name: 'Alex Morgan',  email: 'alex@demo.com',   password: 'Alex@1234',  role: 'user' },
    { name: 'Jordan Lee',   email: 'jordan@demo.com', password: 'Jordan@1234',role: 'user' },
    { name: 'Sam Rivera',   email: 'sam@demo.com',    password: 'Sam@1234',   role: 'user' },
    { name: 'Chris Park',   email: 'chris@demo.com',  password: 'Chris@1234', role: 'admin' },
  ];
  for (const u of users) {
    const hash = await bcrypt.hash(u.password, 10);
    db.users.push({
      id: uuidv4(),
      name: u.name,
      email: u.email,
      passwordHash: hash,
      role: u.role,
      status: 'active',
      bio: u.role === 'superadmin' ? 'Platform administrator' : 'Hey there, using NexTalk!',
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      avatar: null
    });
  }
  // Seed some messages
  const alex = db.users.find(u => u.email === 'alex@demo.com');
  const jordan = db.users.find(u => u.email === 'jordan@demo.com');
  if (alex && jordan) {
    const key = convKey(alex.id, jordan.id);
    db.messages[key] = [
      { id: uuidv4(), fromId: jordan.id, text: 'Hey Alex! Welcome to NexTalk 🚀', ts: new Date(Date.now() - 600000).toISOString(), deleted: false },
      { id: uuidv4(), fromId: alex.id,   text: 'Thanks Jordan! This looks amazing.', ts: new Date(Date.now() - 540000).toISOString(), deleted: false },
      { id: uuidv4(), fromId: jordan.id, text: 'Open multiple browser tabs to chat in real-time!', ts: new Date(Date.now() - 480000).toISOString(), deleted: false },
    ];
  }
  console.log('✅ Database seeded with demo users');
}

function convKey(a, b) { return [a, b].sort().join('::'); }
function getConv(a, b) { return db.messages[convKey(a, b)] || []; }

// ============================================================
// WebSocket CLIENTS MAP  wsId -> { ws, userId, alive }
// ============================================================
const clients = new Map();

function broadcast(data, excludeWsId = null) {
  const msg = JSON.stringify(data);
  clients.forEach((client, wsId) => {
    if (wsId !== excludeWsId && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(msg);
    }
  });
}

function sendToUser(userId, data) {
  const msg = JSON.stringify(data);
  clients.forEach((client) => {
    if (client.userId === userId && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(msg);
    }
  });
}

function getOnlineUsers() {
  const online = new Set();
  clients.forEach(c => { if (c.userId) online.add(c.userId); });
  return [...online];
}

function safeUser(u) {
  const { passwordHash, ...safe } = u;
  return { ...safe, online: getOnlineUsers().includes(u.id) };
}

// ============================================================
// WebSocket HANDLER
// ============================================================
wss.on('connection', (ws) => {
  const wsId = uuidv4();
  clients.set(wsId, { ws, userId: null, alive: true });

  ws.on('pong', () => {
    const c = clients.get(wsId);
    if (c) c.alive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handleWsMessage(wsId, msg);
  });

  ws.on('close', () => {
    const c = clients.get(wsId);
    if (c?.userId) {
      clients.delete(wsId);
      // Update last seen
      const user = db.users.find(u => u.id === c.userId);
      if (user) user.lastSeen = new Date().toISOString();
      // Check if user has any other connections
      const stillOnline = [...clients.values()].some(x => x.userId === c.userId);
      if (!stillOnline) {
        broadcast({ type: 'user_offline', userId: c.userId });
      }
    } else {
      clients.delete(wsId);
    }
  });

  ws.send(JSON.stringify({ type: 'connected', wsId }));
});

// Heartbeat
const heartbeat = setInterval(() => {
  clients.forEach((client, wsId) => {
    if (!client.alive) { client.ws.terminate(); clients.delete(wsId); return; }
    client.alive = false;
    client.ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

function handleWsMessage(wsId, msg) {
  const client = clients.get(wsId);
  if (!client) return;

  switch (msg.type) {
    case 'auth': {
      const user = verifyToken(msg.token);
      if (!user) { client.ws.send(JSON.stringify({ type: 'auth_error', message: 'Invalid token' })); return; }
      client.userId = user.id;
      client.ws.send(JSON.stringify({ type: 'auth_ok', user: safeUser(user) }));
      // Notify others this user is online
      broadcast({ type: 'user_online', userId: user.id }, wsId);
      // Send online users list to this client
      client.ws.send(JSON.stringify({ type: 'online_users', users: getOnlineUsers() }));
      break;
    }

    case 'send_message': {
      if (!client.userId) return;
      const sender = db.users.find(u => u.id === client.userId);
      if (!sender || sender.status !== 'active') return;
      const recipient = db.users.find(u => u.id === msg.toId);
      if (!recipient) return;

      const message = {
        id: uuidv4(),
        fromId: client.userId,
        toId: msg.toId,
        text: msg.text?.trim().slice(0, 4000),
        ts: new Date().toISOString(),
        deleted: false
      };
      if (!message.text) return;

      const key = convKey(client.userId, msg.toId);
      if (!db.messages[key]) db.messages[key] = [];
      db.messages[key].push(message);

      // Send to sender
      client.ws.send(JSON.stringify({ type: 'message', message }));
      // Send to recipient (all their connections)
      sendToUser(msg.toId, { type: 'message', message });
      break;
    }

    case 'delete_message': {
      if (!client.userId) return;
      const key = convKey(client.userId, msg.otherId);
      const msgs = db.messages[key] || [];
      const m = msgs.find(x => x.id === msg.messageId && x.fromId === client.userId);
      if (m) {
        m.deleted = true;
        m.text = '';
        // Notify both sides
        client.ws.send(JSON.stringify({ type: 'message_deleted', messageId: m.id, convKey: key }));
        sendToUser(msg.otherId, { type: 'message_deleted', messageId: m.id, convKey: key });
      }
      break;
    }

    case 'delete_conversation': {
      if (!client.userId) return;
      const key = convKey(client.userId, msg.otherId);
      db.messages[key] = [];
      client.ws.send(JSON.stringify({ type: 'conversation_cleared', otherId: msg.otherId }));
      break;
    }

    case 'typing': {
      if (!client.userId) return;
      sendToUser(msg.toId, { type: 'typing', fromId: client.userId, isTyping: msg.isTyping });
      break;
    }

    case 'get_history': {
      if (!client.userId) return;
      const msgs = getConv(client.userId, msg.otherId).filter(m => !m.deleted);
      client.ws.send(JSON.stringify({ type: 'history', otherId: msg.otherId, messages: msgs }));
      break;
    }

    case 'get_users': {
      if (!client.userId) return;
      const user = db.users.find(u => u.id === client.userId);
      if (!user) return;
      let list;
      if (user.role === 'superadmin' || user.role === 'admin') {
        list = db.users.map(safeUser);
      } else {
        list = db.users.filter(u => u.id !== client.userId && u.role !== 'superadmin').map(safeUser);
      }
      client.ws.send(JSON.stringify({ type: 'users', users: list }));
      break;
    }

    case 'update_profile': {
      if (!client.userId) return;
      const user = db.users.find(u => u.id === client.userId);
      if (!user) return;
      if (msg.name?.trim()) user.name = msg.name.trim().slice(0, 60);
      if (msg.bio !== undefined) user.bio = msg.bio.trim().slice(0, 200);
      client.ws.send(JSON.stringify({ type: 'profile_updated', user: safeUser(user) }));
      broadcast({ type: 'user_updated', user: safeUser(user) });
      break;
    }

    case 'change_password': {
      if (!client.userId) return;
      const user = db.users.find(u => u.id === client.userId);
      if (!user) return;
      bcrypt.compare(msg.current, user.passwordHash).then(ok => {
        if (!ok) { client.ws.send(JSON.stringify({ type: 'error', code: 'wrong_password', message: 'Current password incorrect' })); return; }
        bcrypt.hash(msg.newPass, 10).then(hash => {
          user.passwordHash = hash;
          client.ws.send(JSON.stringify({ type: 'password_changed' }));
        });
      });
      break;
    }

    case 'send_invitation': {
      if (!client.userId) return;
      const { email } = msg;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        client.ws.send(JSON.stringify({ type: 'error', code: 'invalid_email', message: 'Invalid email address' }));
        return;
      }
      const already = db.invitations.find(i => i.fromId === client.userId && i.toEmail.toLowerCase() === email.toLowerCase());
      if (already) {
        client.ws.send(JSON.stringify({ type: 'error', code: 'already_invited', message: 'Already invited this email' }));
        return;
      }
      const inv = { id: uuidv4(), fromId: client.userId, toEmail: email, token: uuidv4(), status: 'pending', createdAt: new Date().toISOString() };
      db.invitations.push(inv);
      client.ws.send(JSON.stringify({ type: 'invitation_sent', invitation: inv }));
      break;
    }

    case 'get_invitations': {
      if (!client.userId) return;
      const user = db.users.find(u => u.id === client.userId);
      const isAdmin = user?.role === 'superadmin' || user?.role === 'admin';
      const list = isAdmin ? db.invitations : db.invitations.filter(i => i.fromId === client.userId);
      client.ws.send(JSON.stringify({ type: 'invitations', invitations: list }));
      break;
    }

    // Admin only
    case 'admin_update_user': {
      if (!client.userId) return;
      const actor = db.users.find(u => u.id === client.userId);
      if (!actor || (actor.role !== 'superadmin' && actor.role !== 'admin')) return;
      const target = db.users.find(u => u.id === msg.userId);
      if (!target || target.id === actor.id) return;
      if (actor.role === 'admin' && target.role === 'superadmin') return; // can't modify superadmin
      if (msg.status) target.status = msg.status;
      if (msg.role && actor.role === 'superadmin') target.role = msg.role;
      // If banned/suspended, kick their WS connections
      if (target.status === 'banned' || target.status === 'suspended') {
        clients.forEach((c, id) => {
          if (c.userId === target.id) {
            c.ws.send(JSON.stringify({ type: 'kicked', reason: target.status }));
            setTimeout(() => c.ws.close(), 500);
          }
        });
      }
      broadcast({ type: 'user_updated', user: safeUser(target) });
      client.ws.send(JSON.stringify({ type: 'admin_action_ok', user: safeUser(target) }));
      break;
    }

    case 'admin_delete_user': {
      if (!client.userId) return;
      const actor = db.users.find(u => u.id === client.userId);
      if (!actor || actor.role !== 'superadmin') return;
      const idx = db.users.findIndex(u => u.id === msg.userId);
      if (idx === -1) return;
      db.users.splice(idx, 1);
      broadcast({ type: 'user_deleted', userId: msg.userId });
      client.ws.send(JSON.stringify({ type: 'admin_action_ok' }));
      break;
    }
  }
}

// ============================================================
// REST API (Auth only — no chat data exposed via REST)
// ============================================================
app.post('/api/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name?.trim() || !email || !password)
    return res.status(400).json({ error: 'All fields required' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Invalid email' });
  if (password.length < 8 || !/[A-Z]/.test(password) || !/[0-9]/.test(password))
    return res.status(400).json({ error: 'Password: min 8 chars, 1 uppercase, 1 number' });
  if (db.users.find(u => u.email.toLowerCase() === email.toLowerCase()))
    return res.status(409).json({ error: 'Email already registered' });

  const hash = await bcrypt.hash(password, 10);
  const user = {
    id: uuidv4(), name: name.trim(), email: email.toLowerCase(),
    passwordHash: hash, role: 'user', status: 'active',
    bio: '', createdAt: new Date().toISOString(), lastSeen: new Date().toISOString(), avatar: null
  };
  db.users.push(user);
  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
  broadcast({ type: 'user_updated', user: safeUser(user) });
  res.json({ token, user: safeUser(user) });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const user = db.users.find(u => u.email.toLowerCase() === email?.toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid email or password' });
  if (user.status === 'banned') return res.status(403).json({ error: 'Account banned. Contact support.' });
  if (user.status === 'suspended') return res.status(403).json({ error: 'Account suspended. Contact admin.' });
  user.lastSeen = new Date().toISOString();
  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: safeUser(user) });
});

app.get('/api/stats', (req, res) => {
  // Public stats (no private data)
  res.json({ users: db.users.length, online: getOnlineUsers().length });
});

function verifyToken(token) {
  try {
    const { id } = jwt.verify(token, JWT_SECRET);
    return db.users.find(u => u.id === id) || null;
  } catch { return null; }
}

// ============================================================
// START
// ============================================================
seedUsers().then(() => {
  server.listen(PORT, () => {
    console.log(`\n🚀 NexTalk Server running at http://localhost:${PORT}`);
    console.log(`📡 WebSocket ready`);
    console.log(`\n📋 Demo Accounts:`);
    console.log(`   Super Admin : admin@nextalk.io  / Admin@1234`);
    console.log(`   User (Alex) : alex@demo.com     / Alex@1234`);
    console.log(`   User (Jordan): jordan@demo.com  / Jordan@1234`);
    console.log(`   User (Sam)  : sam@demo.com      / Sam@1234`);
    console.log(`   Admin (Chris): chris@demo.com   / Chris@1234`);
    console.log(`\n💡 Open multiple browser tabs at http://localhost:${PORT}`);
    console.log(`   to test real-time messaging between users!\n`);
  });
});
