const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg'); // Новая библиотека для базы
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Подключение к базе данных Render
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Обязательно для Render
});

// Создаем таблицы при запуске
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      name TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS groups (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS group_members (
      group_id INTEGER,
      user_name TEXT,
      PRIMARY KEY (group_id, user_name)
    );
    CREATE TABLE IF NOT EXISTS group_messages (
      id SERIAL PRIMARY KEY,
      group_id INTEGER,
      from_name TEXT,
      text TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      from_name TEXT NOT NULL,
      to_name TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
initDB();

app.use(express.json());
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

// Регистрация
app.post('/register', async (req, res) => {
  const { name, password } = req.body;
  if (!name || !password) return res.status(400).json({ error: 'Имя и пароль обязательны' });

  const exists = await pool.query('SELECT name FROM users WHERE name = $1', [name]);
  if (exists.rows.length > 0) return res.status(400).json({ error: 'Такое имя уже занято' });

  const hash = await bcrypt.hash(password, 10);
  await pool.query('INSERT INTO users (name, password_hash) VALUES ($1, $2)', [name, hash]);
  res.json({ ok: true });
});

// Логин
app.post('/login', async (req, res) => {
  const { name, password } = req.body;
  const user = await pool.query('SELECT * FROM users WHERE name = $1', [name]);
  if (user.rows.length === 0) return res.status(400).json({ error: 'Неверное имя или пароль' });

  const ok = await bcrypt.compare(password, user.rows[0].password_hash);
  if (!ok) return res.status(400).json({ error: 'Неверное имя или пароль' });

  res.json({ ok: true });
});

// История личных
app.get('/history', async (req, res) => {
  const { user1, user2 } = req.query;
  if (!user1 || !user2) return res.json([]);
  const result = await pool.query(`
    SELECT from_name, to_name, text FROM messages
    WHERE (from_name = $1 AND to_name = $2) OR (from_name = $2 AND to_name = $1)
    ORDER BY id ASC LIMIT 200
  `, [user1, user2]);
  res.json(result.rows);
});

// История группы
app.get('/group-history', async (req, res) => {
  const { groupId } = req.query;
  if (!groupId) return res.json([]);
  const result = await pool.query(`
    SELECT from_name, text FROM group_messages
    WHERE group_id = $1 ORDER BY id ASC LIMIT 200
  `, [groupId]);
  res.json(result.rows);
});

// Мои группы
app.get('/my-groups', async (req, res) => {
  const { name } = req.query;
  if (!name) return res.json([]);
  const result = await pool.query(`
    SELECT g.id, g.name FROM groups g
    JOIN group_members gm ON gm.group_id = g.id
    WHERE gm.user_name = $1
  `, [name]);
  res.json(result.rows);
});

// Список всех пользователей
app.get('/users', async (req, res) => {
  const result = await pool.query('SELECT name FROM users');
  res.json(result.rows.map(r => r.name));
});

const onlineUsers = new Map();

io.on('connection', (socket) => {
  socket.on('register', (name) => {
    socket.name = name;
    socket.join(name);
    onlineUsers.set(name, socket.id);
    io.emit('online users', Array.from(onlineUsers.keys()));
  });

  socket.on('private message', async (msg) => {
    await pool.query('INSERT INTO messages (from_name, to_name, text) VALUES ($1, $2, $3)', [msg.from, msg.to, msg.text]);
    io.to(msg.to).emit('private message', msg);
    io.to(msg.from).emit('private message', msg);
  });

  socket.on('create group', async ({ name, members }, callback) => {
    const info = await pool.query('INSERT INTO groups (name) VALUES ($1) RETURNING id', [name]);
    const groupId = info.rows[0].id;
    for (let m of members) {
      await pool.query('INSERT INTO group_members (group_id, user_name) VALUES ($1, $2)', [groupId, m]);
      io.to(m).emit('groups updated');
    }
    callback({ id: groupId, name });
  });

  socket.on('group message', async (msg) => {
    await pool.query('INSERT INTO group_messages (group_id, from_name, text) VALUES ($1, $2, $3)', [msg.groupId, msg.from, msg.text]);
    const members = await pool.query('SELECT user_name FROM group_members WHERE group_id = $1', [msg.groupId]);
    members.rows.forEach(m => io.to(m.user_name).emit('group message', msg));
  });

  socket.on('disconnect', () => {
    if (socket.name) {
      onlineUsers.delete(socket.name);
      io.emit('online users', Array.from(onlineUsers.keys()));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Сервер работает на порту ' + PORT));