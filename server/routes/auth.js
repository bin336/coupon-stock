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

// 某用户拥有的券数量（删除前确认用）
router.get('/users/:id/coupon-count', authMiddleware, adminOnly, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT COUNT(*) AS c FROM coupons WHERE owner_user_id = ?').get(id);
  res.json({ count: row ? row.c : 0 });
});

// 删除用户（管理员，不能删自己；不能删最后一个管理员）
// 删除时处理其名下券：转移给接手人(mode=transfer,toUserId) 或 保留为无主(mode=keep，清空 owner_user_id 但保留 owner_name)
router.delete('/users/:id', authMiddleware, adminOnly, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: '不能删除当前登录的账号' });
  const u = db.prepare('SELECT id, role FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  // ② 保护最后一个管理员
  if (u.role === 'admin') {
    const adminCount = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get().c;
    if (adminCount <= 1) return res.status(400).json({ error: '不能删除最后一个管理员' });
  }
  const body = req.body || {};
  const mode = body.mode === 'transfer' ? 'transfer' : 'keep';
  const cnt = db.prepare('SELECT COUNT(*) AS c FROM coupons WHERE owner_user_id = ?').get(id).c;
  let detail = '删除用户';
  if (mode === 'transfer') {
    const toId = Number(body.toUserId);
    const toUser = db.prepare('SELECT id, display_name FROM users WHERE id = ?').get(toId);
    if (!toUser) return res.status(400).json({ error: '接手人不存在' });
    db.prepare('UPDATE coupons SET owner_user_id = ?, owner_name = ? WHERE owner_user_id = ?')
      .run(toUser.id, toUser.display_name, id);
    detail = `删除用户（${cnt} 张券转移给 ${toUser.display_name}）`;
  } else {
    // ① 保留券，置空 owner_user_id（owner_name 文本保留，仍为原所有人姓名）
    db.prepare('UPDATE coupons SET owner_user_id = NULL WHERE owner_user_id = ?').run(id);
    detail = `删除用户（${cnt} 张券保留为无主）`;
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  db.logOperation({ user_id: req.user.id, username: req.user.username, action: 'delete_user', target: String(id), detail });
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
