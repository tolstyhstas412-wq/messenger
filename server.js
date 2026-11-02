const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs'); // Заменено на bcryptjs

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const db = new Database('messages.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    name TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS group_members (
    group_id INTEGER,
    user_name TEXT,
    PRIMARY KEY (group_id, user_name)
  );

  CREATE TABLE IF NOT EXISTS group_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER,
    from_name TEXT,
    text TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_name TEXT NOT NULL,
    to_name TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

app.use(express.json());
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

// Регистрация
app.post('/register', async (req, res) => {
  const { name, password } = req.body;
  if (!name || !password) return res.status(400).json({ error: 'Имя и пароль обязательны' });

  const exists = db.prepare('SELECT name FROM users WHERE name = ?').get(name);
  if (exists) return res.status(400).json({ error: 'Такое имя уже занято' });

  const hash = await bcrypt.hash(password, 10);
  db.prepare('INSERT INTO users (name, password_hash) VALUES (?, ?)').run(name, hash);
  res.json({ ok: true });
});

// Логин
app.post('/login', async (req, res) => {
  const { name, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE name = ?').get(name);
  if (!user) return res.status(400).json({ error: 'Неверное имя или пароль' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(400).json({ error: 'Неверное имя или пароль' });

  res.json({ ok: true });
});

// История личных
app.get('/history', (req, res) => {
  const { user1, user2 } = req.query;
  if (!user1 || !user2) return res.json([]);
  const rows = db.prepare(`
    SELECT from_name, to_name, text FROM messages
    WHERE (from_name = ? AND to_name = ?) OR (from_name = ? AND to_name = ?)
    ORDER BY id ASC LIMIT 200
  `).all(user1, user2, user2, user1);
  res.json(rows);
});

// История группы
app.get('/group-history', (req, res) => {
  const { groupId } = req.query;
  if (!groupId) return res.json([]);
  const rows = db.prepare(`
    SELECT from_name, text FROM group_messages
    WHERE group_id = ? ORDER BY id ASC LIMIT 200
  `).all(groupId);
  res.json(rows);
});

// Мои группы
app.get('/my-groups', (req, res) => {
  const { name } = req.query;
  if (!name) return res.json([]);
  const rows = db.prepare(`
    SELECT g.id, g.name FROM groups g
    JOIN group_members gm ON gm.group_id = g.id
    WHERE gm.user_name = ?
  `).all(name);
  res.json(rows);
});

// Список всех пользователей (для добавления в группы)
app.get('/users', (req, res) => {
  const rows = db.prepare('SELECT name FROM users').all();
  res.json(rows.map(r => r.name));
});

const onlineUsers = new Map();

io.on('connection', (socket) => {
  socket.on('register', (name) => {
    socket.name = name;
    socket.join(name);
    onlineUsers.set(name, socket.id);
    io.emit('online users', Array.from(onlineUsers.keys()));
  });

  socket.on('private message', (msg) => {
    db.prepare('INSERT INTO messages (from_name, to_name, text) VALUES (?, ?, ?)')
      .run(msg.from, msg.to, msg.text);
    io.to(msg.to).emit('private message', msg);
    io.to(msg.from).emit('private message', msg);
  });

  socket.on('create group', ({ name, members }, callback) => {
    const info = db.prepare('INSERT INTO groups (name) VALUES (?)').run(name);
    const groupId = info.lastInsertRowid;
    const insert = db.prepare('INSERT INTO group_members (group_id, user_name) VALUES (?, ?)');
    members.forEach(m => insert.run(groupId, m));
    members.forEach(m => io.to(m).emit('groups updated'));
    callback({ id: groupId, name });
  });

  socket.on('group message', (msg) => {
    db.prepare('INSERT INTO group_messages (group_id, from_name, text) VALUES (?, ?, ?)')
      .run(msg.groupId, msg.from, msg.text);
    const members = db.prepare('SELECT user_name FROM group_members WHERE group_id = ?').all(msg.groupId);
    members.forEach(m => io.to(m.user_name).emit('group message', msg));
  });

  socket.on('disconnect', () => {
    if (socket.name) {
      onlineUsers.delete(socket.name);
      io.emit('online users', Array.from(onlineUsers.keys()));
    }
  });
});

// ИСПРАВЛЕНО ДЛЯ RENDER
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Сервер работает на порту ' + PORT));