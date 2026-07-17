const express = require('express');
const router = express.Router();
const db = require('../db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { authMiddleware, adminOnly, JWT_SECRET } = require('../middleware/auth');

// 登录
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '请输入账号和密码' });
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!u || !bcrypt.compareSync(password, u.password_hash)) {
    return res.status(401).json({ error: '账号或密码错误' });
  }
  const token = jwt.sign(
    { id: u.id, username: u.username, display_name: u.display_name, role: u.role },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
  res.json({
    token,
    user: { id: u.id, username: u.username, display_name: u.display_name, role: u.role }
  });
  db.logOperation({ user_id: u.id, username: u.username, action: 'login', target: u.username, detail: '登录' });
});

// 当前登录用户
router.get('/me', authMiddleware, (req, res) => {
  const u = db.prepare('SELECT id,username,display_name,role,created_at FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: u });
});

// 用户列表（管理员）
router.get('/users', authMiddleware, adminOnly, (req, res) => {
  const users = db.prepare('SELECT id,username,display_name,role,created_at FROM users ORDER BY id').all();
  res.json({ users });
});

// 新增用户（管理员）
router.post('/users', authMiddleware, adminOnly, (req, res) => {
  const { username, password, display_name, role } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '账号和密码必填' });
  const dn = (display_name || username).trim();
  const r = role === 'admin' ? 'admin' : 'user';
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
    return res.status(409).json({ error: '账号已存在' });
  }
  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare('INSERT INTO users (username,password_hash,display_name,role) VALUES (?,?,?,?)')
    .run(username, hash, dn, r);
  db.logOperation({ user_id: req.user.id, username: req.user.username, action: 'add_user', target: username, detail: '新增用户' });
  res.json({ id: info.lastInsertRowid, username, display_name: dn, role: r });
});

// 删除用户（管理员，不能删自己）
router.delete('/users/:id', authMiddleware, adminOnly, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: '不能删除当前登录的账号' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  db.logOperation({ user_id: req.user.id, username: req.user.username, action: 'delete_user', target: String(id), detail: '删除用户' });
  res.json({ ok: true });
});

// 重置密码（管理员）—— 简单实现：用新密码覆盖
router.put('/users/:id/password', authMiddleware, adminOnly, (req, res) => {
  const id = Number(req.params.id);
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: '新密码必填' });
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
  db.logOperation({ user_id: req.user.id, username: req.user.username, action: 'reset_password', target: String(id), detail: '修改密码' });
  res.json({ ok: true });
});

module.exports = router;
