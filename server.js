/**
 * NexTalk Server — v2.0
 * Real-time chat · WebSockets · JWT Auth · Email Verification · Super Admin
 */

const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');
const path       = require('path');
const cors       = require('cors');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// ─── CONFIG ────────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'nextalk_jwt_secret_v2_2024';
const PORT       = process.env.PORT       || 3000;
const APP_URL    = process.env.APP_URL    || `http://localhost:${PORT}`;

// ─── EMAIL ─────────────────────────────────────────────────────────────────
// Uses Ethereal (free fake SMTP) for development.
// All sent emails are captured and viewable at the preview URL logged to console.
// For production: replace with real SMTP (SendGrid, Mailgun, AWS SES, etc.)
let transporter = null;

async function initMailer() {
  try {
    const acct = await nodemailer.createTestAccount();
    transporter = nodemailer.createTransport({
      host: 'smtp.ethereal.email', port: 587, secure: false,
      auth: { user: acct.user, pass: acct.pass },
    });
    console.log(`📧 Ethereal SMTP ready — View sent emails at https://ethereal.email/messages`);
  } catch {
    console.warn('⚠️  Could not reach Ethereal SMTP (offline?). Emails logged to console only.');
    transporter = null;
  }
}

async function sendMail({ to, subject, html }) {
  if (transporter) {
    try {
      const info = await transporter.sendMail({ from: '"NexTalk" <no-reply@nextalk.io>', to, subject, html });
      const url = nodemailer.getTestMessageUrl(info);
      if (url) console.log(`\n📨 Email preview → ${url}\n`);
      return { ok: true, preview: url || null };
    } catch (err) {
      console.error('Mail error:', err.message);
    }
  }
  // Fallback: print verification link to console
  console.log(`\n📧 EMAIL (console fallback) → To: ${to} | Subject: ${subject}`);
  const m = html.match(/href="([^"]*(?:verify|reset)[^"]*)"/);
  if (m) console.log(`   🔗 Link: ${m[1]}\n`);
  return { ok: false, preview: null };
}

// ─── IN-MEMORY DATABASE ────────────────────────────────────────────────────
const db = {
  users:       [],
  messages:    {},
  invitations: [],
};

// ─── HELPERS ───────────────────────────────────────────────────────────────
const convKey = (a, b) => [a, b].sort().join('::');
const rndTok  = (n = 40) => { let t=''; const c='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'; for(let i=0;i<n;i++) t+=c[Math.floor(Math.random()*c.length)]; return t; };

function getOnlineIds() {
  const s = new Set(); wsClients.forEach(c => { if (c.userId) s.add(c.userId); }); return [...s];
}

function safeUser(u) {
  if (!u) return null;
  const { passwordHash, verifyToken, verifyExpires, resetToken, resetExpires, ...safe } = u;
  return { ...safe, online: getOnlineIds().includes(u.id) };
}

function verifyJWT(token) {
  try { const { id } = jwt.verify(token, JWT_SECRET); return db.users.find(u => u.id === id) || null; }
  catch { return null; }
}

// ─── SEED ──────────────────────────────────────────────────────────────────
async function seedUsers() {
  const seeds = [
    { name: 'Super Admin',  email: 'admin@nextalk.io',  pass: 'Admin@1234',   role: 'superadmin', verified: true  },
    { name: 'Alex Morgan',  email: 'alex@demo.com',     pass: 'Alex@1234',    role: 'user',       verified: true  },
    { name: 'Jordan Lee',   email: 'jordan@demo.com',   pass: 'Jordan@1234',  role: 'user',       verified: true  },
    { name: 'Sam Rivera',   email: 'sam@demo.com',      pass: 'Sam@1234',     role: 'user',       verified: false }, // unverified demo
    { name: 'Chris Park',   email: 'chris@demo.com',    pass: 'Chris@1234',   role: 'admin',      verified: true  },
  ];
  for (const s of seeds) {
    db.users.push({
      id: uuidv4(), name: s.name, email: s.email,
      passwordHash:  await bcrypt.hash(s.pass, 10),
      role: s.role, status: 'active',
      emailVerified: s.verified,
      verifyToken: s.verified ? null : rndTok(),
      verifyExpires: s.verified ? null : Date.now() + 86400000,
      resetToken: null, resetExpires: null,
      bio: s.role === 'superadmin' ? 'Platform administrator' : '',
      createdAt: new Date().toISOString(),
      lastSeen:  new Date().toISOString(),
    });
  }
  // Seed messages between Alex & Jordan
  const alex   = db.users.find(u => u.email === 'alex@demo.com');
  const jordan = db.users.find(u => u.email === 'jordan@demo.com');
  if (alex && jordan) {
    db.messages[convKey(alex.id, jordan.id)] = [
      { id: uuidv4(), fromId: jordan.id, toId: alex.id,   text: 'Hey Alex! Welcome to NexTalk 🚀',                       ts: new Date(Date.now()-600000).toISOString(), deleted: false },
      { id: uuidv4(), fromId: alex.id,   toId: jordan.id, text: 'Thanks Jordan! The real-time is working great.',        ts: new Date(Date.now()-540000).toISOString(), deleted: false },
      { id: uuidv4(), fromId: jordan.id, toId: alex.id,   text: 'Open multiple browser tabs and message each other 😄',  ts: new Date(Date.now()-480000).toISOString(), deleted: false },
    ];
  }
  console.log('✅ Database seeded');
}

// ─── WEBSOCKET ─────────────────────────────────────────────────────────────
const wsClients = new Map(); // wsId → { ws, userId, alive }

function broadcast(data, excludeWsId = null) {
  const msg = JSON.stringify(data);
  wsClients.forEach((c, id) => { if (id !== excludeWsId && c.ws.readyState === WebSocket.OPEN) c.ws.send(msg); });
}
function sendToUser(userId, data) {
  const msg = JSON.stringify(data);
  wsClients.forEach(c => { if (c.userId === userId && c.ws.readyState === WebSocket.OPEN) c.ws.send(msg); });
}

wss.on('connection', ws => {
  const wsId = uuidv4();
  wsClients.set(wsId, { ws, userId: null, alive: true });

  ws.on('pong', () => { const c = wsClients.get(wsId); if (c) c.alive = true; });
  ws.on('message', raw => { let m; try { m = JSON.parse(raw); } catch { return; } handleWS(wsId, m); });
  ws.on('close', () => {
    const c = wsClients.get(wsId);
    if (c?.userId) {
      const u = db.users.find(x => x.id === c.userId);
      if (u) u.lastSeen = new Date().toISOString();
      wsClients.delete(wsId);
      if (![...wsClients.values()].some(x => x.userId === c.userId))
        broadcast({ type: 'user_offline', userId: c.userId });
    } else wsClients.delete(wsId);
  });

  ws.send(JSON.stringify({ type: 'connected' }));
});

const hb = setInterval(() => {
  wsClients.forEach((c, id) => {
    if (!c.alive) { c.ws.terminate(); wsClients.delete(id); return; }
    c.alive = false; c.ws.ping();
  });
}, 30000);
wss.on('close', () => clearInterval(hb));

// ─── WS MESSAGE HANDLER ────────────────────────────────────────────────────
function handleWS(wsId, msg) {
  const client = wsClients.get(wsId);
  if (!client) return;
  const send = d => client.ws.send(JSON.stringify(d));

  switch (msg.type) {

    case 'auth': {
      const user = verifyJWT(msg.token);
      if (!user)               return send({ type: 'auth_error', reason: 'invalid' });
      if (!user.emailVerified) return send({ type: 'auth_error', reason: 'unverified', message: 'Please verify your email before logging in.' });
      if (user.status === 'banned' || user.status === 'suspended') return send({ type: 'kicked', reason: user.status });
      client.userId = user.id;
      send({ type: 'auth_ok', user: safeUser(user) });
      broadcast({ type: 'user_online', userId: user.id }, wsId);
      send({ type: 'online_users', users: getOnlineIds() });
      break;
    }

    case 'send_message': {
      if (!client.userId) return;
      const sender = db.users.find(u => u.id === client.userId);
      if (!sender || sender.status !== 'active') return;
      const text = (msg.text || '').trim().slice(0, 4000);
      if (!text || !msg.toId) return;
      const m = { id: uuidv4(), fromId: client.userId, toId: msg.toId, text, ts: new Date().toISOString(), deleted: false };
      const key = convKey(client.userId, msg.toId);
      if (!db.messages[key]) db.messages[key] = [];
      db.messages[key].push(m);
      send({ type: 'message', message: m });
      sendToUser(msg.toId, { type: 'message', message: m });
      break;
    }

    case 'delete_message': {
      if (!client.userId) return;
      const m = (db.messages[convKey(client.userId, msg.otherId)] || []).find(x => x.id === msg.messageId && x.fromId === client.userId);
      if (m) {
        m.deleted = true; m.text = '';
        const p = { type: 'message_deleted', messageId: m.id };
        send(p); sendToUser(msg.otherId, p);
      }
      break;
    }

    case 'delete_conversation': {
      if (!client.userId) return;
      db.messages[convKey(client.userId, msg.otherId)] = [];
      send({ type: 'conversation_cleared', otherId: msg.otherId });
      break;
    }

    case 'typing': {
      if (!client.userId) return;
      sendToUser(msg.toId, { type: 'typing', fromId: client.userId, isTyping: !!msg.isTyping });
      break;
    }

    case 'get_history': {
      if (!client.userId) return;
      const msgs = (db.messages[convKey(client.userId, msg.otherId)] || []).filter(m => !m.deleted);
      send({ type: 'history', otherId: msg.otherId, messages: msgs });
      break;
    }

    case 'get_users': {
      if (!client.userId) return;
      const actor = db.users.find(u => u.id === client.userId);
      if (!actor) return;
      const isAdmin = actor.role === 'superadmin' || actor.role === 'admin';
      const list = isAdmin
        ? db.users.map(safeUser)
        : db.users.filter(u => u.id !== actor.id && u.role !== 'superadmin' && u.emailVerified && u.status === 'active').map(safeUser);
      send({ type: 'users', users: list });
      break;
    }

    case 'update_profile': {
      if (!client.userId) return;
      const u = db.users.find(x => x.id === client.userId);
      if (!u) return;
      if (msg.name?.trim()) u.name = msg.name.trim().slice(0, 60);
      if (msg.bio !== undefined) u.bio = (msg.bio || '').trim().slice(0, 200);
      send({ type: 'profile_updated', user: safeUser(u) });
      broadcast({ type: 'user_updated', user: safeUser(u) });
      break;
    }

    case 'change_password': {
      if (!client.userId) return;
      const u = db.users.find(x => x.id === client.userId);
      if (!u) return;
      bcrypt.compare(msg.current || '', u.passwordHash).then(ok => {
        if (!ok) return send({ type: 'error', code: 'wrong_password', message: 'Current password is incorrect' });
        if (!msg.newPass || msg.newPass.length < 8 || !/[A-Z]/.test(msg.newPass) || !/[0-9]/.test(msg.newPass))
          return send({ type: 'error', code: 'weak_password', message: 'Min 8 chars, 1 uppercase, 1 number' });
        if (msg.newPass !== msg.confirmPass)
          return send({ type: 'error', code: 'mismatch', message: 'Passwords do not match' });
        bcrypt.hash(msg.newPass, 10).then(hash => { u.passwordHash = hash; send({ type: 'password_changed' }); });
      });
      break;
    }

    case 'send_invitation': {
      if (!client.userId) return;
      const email = (msg.email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return send({ type: 'error', code: 'invalid_email', message: 'Invalid email address' });
      if (db.invitations.find(i => i.fromId === client.userId && i.toEmail === email))
        return send({ type: 'error', code: 'already_invited', message: 'Already invited this email' });
      const inv = { id: uuidv4(), fromId: client.userId, toEmail: email, token: uuidv4(), status: 'pending', createdAt: new Date().toISOString() };
      db.invitations.push(inv);
      const from = db.users.find(u => u.id === client.userId);
      const link = `${APP_URL}/register?ref=${inv.token}`;
      sendMail({
        to: email, subject: `${from?.name || 'Someone'} invited you to NexTalk`,
        html: `<div style="background:#09090f;padding:40px;font-family:Arial,sans-serif"><div style="max-width:500px;margin:auto;background:#0f1018;border:1px solid #2a2d4a;border-radius:16px;padding:32px">
          <div style="font-size:24px;font-weight:800;color:#5b8dee">Nex<span style="color:#e4e6f0">Talk</span></div>
          <h2 style="color:#e4e6f0;margin:18px 0 10px">You're invited!</h2>
          <p style="color:#8b90b8;font-size:14px"><strong style="color:#e4e6f0">${from?.name}</strong> invited you to NexTalk — secure real-time chat.</p>
          <a href="${link}" style="display:inline-block;margin-top:8px;background:#5b8dee;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700">Accept & Join →</a>
        </div></div>`,
      });
      send({ type: 'invitation_sent', invitation: inv });
      break;
    }

    case 'get_invitations': {
      if (!client.userId) return;
      const actor = db.users.find(u => u.id === client.userId);
      const isAdmin = actor?.role === 'superadmin' || actor?.role === 'admin';
      send({ type: 'invitations', invitations: isAdmin ? db.invitations : db.invitations.filter(i => i.fromId === client.userId) });
      break;
    }

    // ── ADMIN ──────────────────────────────────────────────────────────────
    case 'admin_update_user': {
      if (!client.userId) return;
      const actor = db.users.find(u => u.id === client.userId);
      if (!actor || (actor.role !== 'superadmin' && actor.role !== 'admin')) return;
      const target = db.users.find(u => u.id === msg.userId);
      if (!target || target.id === actor.id) return;
      if (actor.role === 'admin' && (target.role === 'superadmin' || target.role === 'admin')) return;

      if (msg.status) target.status = msg.status;
      if (msg.role   && actor.role === 'superadmin') target.role = msg.role;
      if (msg.emailVerified !== undefined && actor.role === 'superadmin') target.emailVerified = !!msg.emailVerified;

      if (target.status === 'banned' || target.status === 'suspended') {
        wsClients.forEach(c => {
          if (c.userId === target.id) { c.ws.send(JSON.stringify({ type: 'kicked', reason: target.status })); setTimeout(() => c.ws.close(), 400); }
        });
      }
      broadcast({ type: 'user_updated', user: safeUser(target) });
      send({ type: 'admin_action_ok', user: safeUser(target) });
      break;
    }

    case 'admin_delete_user': {
      if (!client.userId) return;
      const actor = db.users.find(u => u.id === client.userId);
      if (!actor || actor.role !== 'superadmin') return;
      const target = db.users.find(u => u.id === msg.userId);
      if (!target || target.id === actor.id) return;

      // Kick target's WS connections
      wsClients.forEach(c => {
        if (c.userId === target.id) { c.ws.send(JSON.stringify({ type: 'kicked', reason: 'deleted' })); setTimeout(() => c.ws.close(), 400); }
      });

      // Remove user + their data
      db.users.splice(db.users.indexOf(target), 1);
      Object.keys(db.messages).forEach(k => { if (k.includes(target.id)) delete db.messages[k]; });
      db.invitations = db.invitations.filter(i => i.fromId !== target.id);

      broadcast({ type: 'user_deleted', userId: target.id });
      send({ type: 'admin_action_ok' });
      break;
    }

    case 'admin_resend_verify': {
      if (!client.userId) return;
      const actor = db.users.find(u => u.id === client.userId);
      if (!actor || (actor.role !== 'superadmin' && actor.role !== 'admin')) return;
      const target = db.users.find(u => u.id === msg.userId);
      if (!target || target.emailVerified) return;
      target.verifyToken   = rndTok();
      target.verifyExpires = Date.now() + 86400000;
      const link = `${APP_URL}/verify-email?token=${target.verifyToken}`;
      sendMail({ to: target.email, subject: 'Verify your NexTalk email', html: verifyEmailHTML(target.name, link) });
      send({ type: 'ok', message: `Verification email resent to ${target.email}` });
      break;
    }
  }
}

// ─── REST API ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Register
app.post('/api/register', async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name?.trim())                                  return res.status(400).json({ error: 'Name is required' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))    return res.status(400).json({ error: 'Invalid email address' });
  if (!password || password.length < 8 || !/[A-Z]/.test(password) || !/[0-9]/.test(password))
    return res.status(400).json({ error: 'Password must be 8+ characters with 1 uppercase letter and 1 number' });
  if (db.users.find(u => u.email.toLowerCase() === email.toLowerCase()))
    return res.status(409).json({ error: 'Email already registered' });

  const tok = rndTok();
  const user = {
    id: uuidv4(), name: name.trim(), email: email.toLowerCase(),
    passwordHash: await bcrypt.hash(password, 10),
    role: 'user', status: 'active', emailVerified: false,
    verifyToken: tok, verifyExpires: Date.now() + 86400000,
    resetToken: null, resetExpires: null,
    bio: '', createdAt: new Date().toISOString(), lastSeen: new Date().toISOString(),
  };
  db.users.push(user);

  const link = `${APP_URL}/verify-email?token=${tok}`;
  const result = await sendMail({ to: user.email, subject: 'Verify your NexTalk email address', html: verifyEmailHTML(user.name, link) });
  broadcast({ type: 'user_updated', user: safeUser(user) });

  res.status(201).json({
    message: 'Account created! Please check your email to verify your account before logging in.',
    verifyLink: link, // Always returned so devs/testers can click it directly
    ...(result.preview ? { emailPreview: result.preview } : {}),
  });
});

// Login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  const user = db.users.find(u => u.email.toLowerCase() === (email || '').toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });
  if (!await bcrypt.compare(password || '', user.passwordHash)) return res.status(401).json({ error: 'Invalid email or password' });
  if (!user.emailVerified) return res.status(403).json({ error: 'Email not verified', code: 'email_unverified' });
  if (user.status === 'banned')    return res.status(403).json({ error: 'Account banned. Contact support.' });
  if (user.status === 'suspended') return res.status(403).json({ error: 'Account suspended. Contact an admin.' });
  user.lastSeen = new Date().toISOString();
  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: safeUser(user) });
});

// Verify email
app.get('/verify-email', (req, res) => {
  const user = db.users.find(u => u.verifyToken === req.query.token);
  if (!user)                          return res.send(resultPage('error', 'Invalid Link', 'This verification link is invalid or has already been used.'));
  if (user.verifyExpires < Date.now()) return res.send(resultPage('error', 'Link Expired', 'Your verification link has expired. Please request a new one.'));
  user.emailVerified = true; user.verifyToken = null; user.verifyExpires = null;
  broadcast({ type: 'user_updated', user: safeUser(user) });
  res.send(resultPage('success', 'Email Verified! 🎉', `Welcome aboard, <strong style="color:#e4e6f0">${user.name}</strong>! Your account is now active. You can close this tab and log in.`));
});

// Resend verification
app.post('/api/resend-verify', async (req, res) => {
  const user = db.users.find(u => u.email.toLowerCase() === (req.body?.email || '').toLowerCase());
  if (!user || user.emailVerified) return res.status(400).json({ error: user?.emailVerified ? 'Already verified' : 'Email not found' });
  user.verifyToken = rndTok(); user.verifyExpires = Date.now() + 86400000;
  const link = `${APP_URL}/verify-email?token=${user.verifyToken}`;
  const r = await sendMail({ to: user.email, subject: 'Verify your NexTalk email', html: verifyEmailHTML(user.name, link) });
  res.json({ message: 'Verification email sent. Check your inbox.', verifyLink: link, ...(r.preview ? { emailPreview: r.preview } : {}) });
});

// Forgot password
app.post('/api/forgot-password', async (req, res) => {
  const user = db.users.find(u => u.email.toLowerCase() === (req.body?.email || '').toLowerCase());
  if (user?.emailVerified) {
    user.resetToken = rndTok(); user.resetExpires = Date.now() + 3600000;
    const link = `${APP_URL}/reset-password?token=${user.resetToken}`;
    await sendMail({ to: user.email, subject: 'Reset your NexTalk password', html: passwordResetHTML(user.name, link) });
  }
  // Always same response to prevent email enumeration
  res.json({ message: 'If that email exists, a reset link has been sent.' });
});

// Reset password page
app.get('/reset-password', (req, res) => {
  const user = db.users.find(u => u.resetToken === req.query.token && u.resetExpires > Date.now());
  if (!user) return res.send(resultPage('error', 'Link Expired', 'This password reset link is invalid or has expired.'));
  res.send(resetPwPage(req.query.token));
});

// Reset password action
app.post('/api/reset-password', async (req, res) => {
  const { token, password } = req.body || {};
  const user = db.users.find(u => u.resetToken === token && u.resetExpires > Date.now());
  if (!user) return res.status(400).json({ error: 'Invalid or expired token' });
  if (!password || password.length < 8 || !/[A-Z]/.test(password) || !/[0-9]/.test(password))
    return res.status(400).json({ error: 'Password must be 8+ characters with 1 uppercase and 1 number' });
  user.passwordHash = await bcrypt.hash(password, 10); user.resetToken = null; user.resetExpires = null;
  res.json({ message: 'Password reset! You can now log in.' });
});

// ─── EMAIL TEMPLATES ───────────────────────────────────────────────────────
function verifyEmailHTML(name, link) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
  body{margin:0;background:#09090f;font-family:'Segoe UI',sans-serif}
  .w{max-width:520px;margin:40px auto;background:#0f1018;border:1px solid #2a2d4a;border-radius:18px;overflow:hidden}
  .h{padding:28px 36px;border-bottom:1px solid #2a2d4a;background:#111420}
  .logo{font-size:22px;font-weight:800;color:#5b8dee}.logo span{color:#e4e6f0}
  .b{padding:32px 36px}.h2{color:#e4e6f0;font-size:20px;margin:0 0 10px}
  p{color:#8b90b8;font-size:14px;line-height:1.6;margin:0 0 20px}
  .btn{display:inline-block;background:#5b8dee;color:#fff;text-decoration:none;padding:13px 28px;border-radius:9px;font-weight:700;font-size:14px}
  .box{background:#161822;border:1px solid #2a2d4a;border-radius:7px;padding:11px 14px;margin-top:14px;word-break:break-all;font-size:12px;color:#5b8dee}
  .f{padding:16px 36px;border-top:1px solid #2a2d4a;font-size:11px;color:#4a4f72;text-align:center}
  </style></head><body>
  <div class="w">
    <div class="h"><div class="logo">Nex<span>Talk</span></div></div>
    <div class="b">
      <div class="h2">Verify your email address</div>
      <p>Hi <strong style="color:#e4e6f0">${name}</strong>! Thanks for joining NexTalk. Click below to activate your account.</p>
      <a href="${link}" class="btn">Verify Email Address →</a>
      <div class="box">${link}</div>
      <p style="margin-top:20px;font-size:12px;color:#4a4f72">Link expires in <strong style="color:#8b90b8">24 hours</strong>.</p>
    </div>
    <div class="f">© ${new Date().getFullYear()} NexTalk</div>
  </div></body></html>`;
}

function passwordResetHTML(name, link) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
  body{margin:0;background:#09090f;font-family:'Segoe UI',sans-serif}
  .w{max-width:520px;margin:40px auto;background:#0f1018;border:1px solid #2a2d4a;border-radius:18px;overflow:hidden}
  .h{padding:28px 36px;border-bottom:1px solid #2a2d4a;background:#111420}
  .logo{font-size:22px;font-weight:800;color:#5b8dee}.logo span{color:#e4e6f0}
  .b{padding:32px 36px}.h2{color:#e4e6f0;font-size:20px;margin:0 0 10px}
  p{color:#8b90b8;font-size:14px;line-height:1.6;margin:0 0 20px}
  .btn{display:inline-block;background:#f05c5c;color:#fff;text-decoration:none;padding:13px 28px;border-radius:9px;font-weight:700;font-size:14px}
  .box{background:#161822;border:1px solid #2a2d4a;border-radius:7px;padding:11px 14px;margin-top:14px;word-break:break-all;font-size:12px;color:#5b8dee}
  .f{padding:16px 36px;border-top:1px solid #2a2d4a;font-size:11px;color:#4a4f72;text-align:center}
  </style></head><body>
  <div class="w">
    <div class="h"><div class="logo">Nex<span>Talk</span></div></div>
    <div class="b">
      <div class="h2">Reset your password</div>
      <p>Hi <strong style="color:#e4e6f0">${name}</strong>! Click below to set a new password.</p>
      <a href="${link}" class="btn">Reset Password →</a>
      <div class="box">${link}</div>
      <p style="margin-top:20px;font-size:12px;color:#4a4f72">Expires in <strong style="color:#8b90b8">1 hour</strong>. Ignore if you didn't request this.</p>
    </div>
    <div class="f">© ${new Date().getFullYear()} NexTalk</div>
  </div></body></html>`;
}

// ─── HTML UTILITY PAGES ────────────────────────────────────────────────────
function resultPage(type, title, body) {
  const ok = type === 'success';
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title} — NexTalk</title>
  <link href="https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=Instrument+Sans:wght@400;600&display=swap" rel="stylesheet">
  <style>*{margin:0;padding:0;box-sizing:border-box}body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#09090f;font-family:'Instrument Sans',sans-serif}
  .c{background:#0f1018;border:1px solid #2a2d4a;border-radius:20px;padding:44px 48px;max-width:460px;width:90%;text-align:center;box-shadow:0 40px 100px rgba(0,0,0,.5)}
  .ic{width:64px;height:64px;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 22px;font-size:28px;background:${ok?'rgba(62,207,142,.12)':'rgba(240,92,92,.12)'};color:${ok?'#3ecf8e':'#f05c5c'}}
  h1{font-family:'Syne',sans-serif;font-size:22px;color:#e4e6f0;margin-bottom:10px}p{color:#8b90b8;font-size:14px;line-height:1.6;margin-bottom:28px}
  .btn{display:inline-block;background:#5b8dee;color:#fff;text-decoration:none;padding:12px 26px;border-radius:8px;font-weight:600;font-size:14px}
  .logo{font-family:'Syne',sans-serif;font-size:18px;font-weight:800;color:#5b8dee;margin-bottom:28px}.logo span{color:#e4e6f0}
  </style></head><body><div class="c">
  <div class="logo">Nex<span>Talk</span></div>
  <div class="ic">${ok?'✓':'✗'}</div>
  <h1>${title}</h1><p>${body}</p>
  <a href="/" class="btn">${ok?'Go to NexTalk →':'Back to Home'}</a>
  </div></body></html>`;
}

function resetPwPage(token) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Reset Password — NexTalk</title>
  <link href="https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=Instrument+Sans:wght@400;600&display=swap" rel="stylesheet">
  <style>*{margin:0;padding:0;box-sizing:border-box}body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#09090f;font-family:'Instrument Sans',sans-serif}
  .c{background:#0f1018;border:1px solid #2a2d4a;border-radius:20px;padding:40px 44px;max-width:420px;width:90%;box-shadow:0 40px 100px rgba(0,0,0,.5)}
  .logo{font-family:'Syne',sans-serif;font-size:20px;font-weight:800;color:#5b8dee;margin-bottom:20px}.logo span{color:#e4e6f0}
  h2{font-family:'Syne',sans-serif;font-size:18px;color:#e4e6f0;margin-bottom:6px}p{color:#8b90b8;font-size:13px;margin-bottom:22px}
  label{display:block;font-size:11px;font-weight:600;color:#8b90b8;text-transform:uppercase;letter-spacing:.6px;margin-bottom:5px}
  input{width:100%;background:#161822;border:1px solid #2a2d4a;border-radius:7px;padding:11px 13px;color:#e4e6f0;font-family:inherit;font-size:14px;outline:none;margin-bottom:14px}
  input:focus{border-color:#5b8dee}.btn{width:100%;background:#5b8dee;color:#fff;border:none;border-radius:7px;padding:12px;font-family:inherit;font-size:14px;font-weight:700;cursor:pointer}
  .btn:hover{background:#3d6fcc}#msg{font-size:13px;margin-top:12px;text-align:center}.ok{color:#3ecf8e}.err{color:#f05c5c}
  </style></head><body><div class="c">
  <div class="logo">Nex<span>Talk</span></div>
  <h2>Set new password</h2><p>Enter your new password below.</p>
  <label>New Password</label><input type="password" id="p1" placeholder="Min 8 chars, 1 uppercase, 1 number"/>
  <label>Confirm Password</label><input type="password" id="p2" placeholder="Repeat password" onkeydown="if(event.key==='Enter')go()"/>
  <button class="btn" onclick="go()">Reset Password</button>
  <div id="msg"></div>
  </div>
  <script>async function go(){
    const p1=document.getElementById('p1').value,p2=document.getElementById('p2').value,m=document.getElementById('msg');
    if(p1!==p2){m.className='err';m.textContent='Passwords do not match';return;}
    const r=await fetch('/api/reset-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:'${token}',password:p1})});
    const d=await r.json();
    if(r.ok){m.className='ok';m.textContent=d.message+' Redirecting…';setTimeout(()=>location.href='/',2000);}
    else{m.className='err';m.textContent=d.error;}
  }</script></body></html>`;
}

// ─── START ─────────────────────────────────────────────────────────────────
initMailer().then(seedUsers).then(() => {
  server.listen(PORT, () => {
    console.log(`\n🚀 NexTalk v2.0 running at ${APP_URL}`);
    console.log(`📡 WebSocket live\n`);
    console.log(`📋 Demo Accounts:`);
    console.log(`   Super Admin : admin@nextalk.io  / Admin@1234   ✅ verified`);
    console.log(`   Alex (User) : alex@demo.com     / Alex@1234    ✅ verified`);
    console.log(`   Jordan      : jordan@demo.com   / Jordan@1234  ✅ verified`);
    console.log(`   Sam         : sam@demo.com      / Sam@1234     ❌ NOT verified`);
    console.log(`   Chris(Admin): chris@demo.com    / Chris@1234   ✅ verified`);
    console.log(`\n💡 Open multiple tabs at ${APP_URL} to test real-time!\n`);
  });
});
