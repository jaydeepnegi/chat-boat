# NexTalk — Real-time Chat App

A full-stack real-time chat application with WebSockets, JWT auth, and a Super Admin panel.

---

## 🚀 Quick Start

### Prerequisites
- **Node.js v16+** installed → https://nodejs.org

### Setup & Run

```bash
# 1. Extract the zip / enter the folder
cd nextalk

# 2. Install dependencies (only needed once)
npm install

# 3. Start the server
npm start
```

Server starts at → **http://localhost:3000**

---

## 👥 Test Real-time Multi-User Chat

Open **multiple browser tabs or windows** at `http://localhost:3000`:

| Tab | Account | Password |
|-----|---------|----------|
| Tab 1 | alex@demo.com | Alex@1234 |
| Tab 2 | jordan@demo.com | Jordan@1234 |
| Tab 3 | sam@demo.com | Sam@1234 |
| Tab 4 | admin@nextalk.io | Admin@1234 (Super Admin) |
| Tab 5 | chris@demo.com | Chris@1234 (Admin) |

Messages appear **instantly** across all open tabs — true real-time via WebSockets.

---

## ✅ Features

### 💬 Real-time Chat
- Instant WebSocket messaging between users
- **Typing indicators** (see when someone is typing)
- **Online/Offline presence** (live green dot)
- Message history loaded on chat open
- Delete individual messages (right-click)
- Delete entire conversation history
- Auto-reconnect on disconnect

### 👤 User Management
- Register with strong password validation
- JWT-based session auth (7-day tokens)
- Profile editing (name, bio)
- Password change with current password verification
- Unread message badges
- Last seen timestamps

### ✉️ Invitations
- Send invitations by email address
- Track invitation status (pending/accepted)
- Admin can view all platform invitations

### 🛡️ Admin Panel (admin / superadmin)
- Live user stats dashboard (total, online, suspended, banned)
- Full user table with real-time presence
- Ban/Suspend/Activate users (kicks active WebSocket sessions)
- Super Admin can change user roles
- **🔒 No access to any user's chat messages** — enforced at server level

### 🔐 Security
- Passwords hashed with bcrypt (10 rounds)
- JWT tokens with 7-day expiry
- Role-based access control (user / admin / superadmin)
- Banned/Suspended users are immediately disconnected
- Admins cannot read private chat data (server enforces this)

---

## 🏗️ Architecture

```
nextalk/
├── server.js          # Express + WebSocket server
├── public/
│   └── index.html     # Full SPA frontend
└── package.json
```

- **Backend**: Node.js, Express, ws (WebSockets), bcryptjs, jsonwebtoken
- **Frontend**: Vanilla JS SPA, WebSocket client
- **Database**: In-memory (resets on server restart)

> To add persistence, replace the `db` object in server.js with MongoDB/PostgreSQL/SQLite.

---

## 🌐 WebSocket Message Protocol

| Type | Direction | Description |
|------|-----------|-------------|
| `auth` | C→S | Authenticate with JWT token |
| `send_message` | C→S | Send a chat message |
| `message` | S→C | Receive a chat message |
| `typing` | C↔S | Typing indicator |
| `get_history` | C→S | Load conversation history |
| `delete_message` | C→S | Delete own message |
| `delete_conversation` | C→S | Clear chat history |
| `user_online/offline` | S→C | Presence updates |
| `admin_update_user` | C→S | Admin: update user |
| `kicked` | S→C | Forced logout (ban/suspend) |

---

## 📌 Notes

- Data is **in-memory** and resets when you restart the server
- To persist data, integrate MongoDB with Mongoose or SQLite with better-sqlite3
- For production: add HTTPS, rate limiting, and a real email provider for invitations
