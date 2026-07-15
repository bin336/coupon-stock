const express = require('express');
const router = express.Router();
const db = require('../db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { authMiddleware, adminOnly } = require('../middleware/auth');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    const name = Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext;
    cb(null, name);
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// 本地日期（避免 UTC 时区导致的过期判断偏移，适合中国时区）
function todayLocal() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

// 列表 / 筛选 / 搜索
router.get('/', authMiddleware, (req, res) => {
  const { status, expired, q, owner } = req.query;
  const params = [];
  let sql = 'SELECT * FROM coupons WHERE 1=1';
  if (status === 'unsold' || status === 'sold') {
    sql += ' AND status = ?';
    params.push(status);
  }
  const today = todayLocal();
  if (expired === '0') {
    sql += ' AND (expiry_date IS NULL OR expiry_date >= ?)';
    params.push(today);
  }
  if (expired === '1') {
    sql += ' AND expiry_date IS NOT NULL AND expiry_date < ?';
    params.push(today);
  }
  if (q) {
    sql += ' AND (merchant LIKE ? OR coupon_code LIKE ? OR owner_name LIKE ? OR note LIKE ?)';
    const like = '%' + q + '%';
    params.push(like, like, like, like);
  }
  if (owner) {
    sql += ' AND owner_name LIKE ?';
    params.push('%' + owner + '%');
  }
  if (status === 'sold') {
    // 已售页：未结算优先排上方，已结算沉到下方；组内按最近更新排前
    sql += ' ORDER BY settled ASC, updated_at DESC, id DESC';
  } else {
    sql += ' ORDER BY (expiry_date IS NULL), expiry_date ASC, id DESC';
  }
  const rows = db.prepare(sql).all(...params);
  res.json({ coupons: rows });
});

// 统计概览
router.get('/stats', authMiddleware, (req, res) => {
  const today = todayLocal();
  const all = db.prepare('SELECT * FROM coupons').all();
  const unsoldUnexpired = all.filter(c => c.status === 'unsold' && (!c.expiry_date || c.expiry_date >= today));
  const sold = all.filter(c => c.status === 'sold');
  const expiredUnsold = all.filter(c => c.status === 'unsold' && c.expiry_date && c.expiry_date < today);
  const faceValue = unsoldUnexpired.reduce((s, c) => s + (c.amount || 0) * (c.quantity || 1), 0);
  const cost = unsoldUnexpired.reduce((s, c) => s + (c.cost || 0), 0);
  const potential = faceValue - cost;
  res.json({
    unsold_unexpired: unsoldUnexpired.length,
    face_value: Math.round(faceValue * 100) / 100,
    cost: Math.round(cost * 100) / 100,
    potential: Math.round(potential * 100) / 100,
    sold: sold.length,
    expired_unsold: expiredUnsold.length
  });
});

// 新增
router.post('/', authMiddleware, upload.single('image'), (req, res) => {
  const b = req.body || {};
  const merchant = (b.merchant || '').toString().trim();
  if (!merchant) return res.status(400).json({ error: '商家名称必填' });
  const amount = parseFloat(b.amount) || 0;
  const coupon_code = (b.coupon_code || '').toString().trim();
  const quantity = parseInt(b.quantity) || 1;
  const expiry_date = b.expiry_date ? b.expiry_date.toString().trim() : null;
  const cost = parseFloat(b.cost) || 0;
  const owner_name = (b.owner_name || '').toString().trim() || req.user.display_name;
  const note = (b.note || '').toString().trim();
  const image_filename = req.file ? req.file.filename : null;

  const info = db.prepare(`INSERT INTO coupons
    (merchant, amount, coupon_code, quantity, expiry_date, cost, owner_name, owner_user_id, image_filename, note, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(merchant, amount, coupon_code, quantity, expiry_date, cost, owner_name, req.user.id, image_filename, note, req.user.id);
  const row = db.prepare('SELECT * FROM coupons WHERE id = ?').get(info.lastInsertRowid);
  res.json({ coupon: row });
});

// 批量入库：一次提交多张截图 + 对应条目（items 与 images 顺序一致）
const uploadArray = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } }).array('images', 50);
router.post('/batch', authMiddleware, uploadArray, (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: '请至少选择一张截图' });
  let items = [];
  try { items = req.body.items ? JSON.parse(req.body.items) : []; } catch (e) { return res.status(400).json({ error: '条目数据格式错误' }); }
  if (!Array.isArray(items) || items.length !== files.length) {
    return res.status(400).json({ error: '条目数量与图片数量不一致' });
  }
  const created = [];
  const errors = [];
  const insert = db.prepare(`INSERT INTO coupons
    (merchant, amount, coupon_code, quantity, expiry_date, cost, owner_name, owner_user_id, image_filename, note, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const tx = db.transaction(() => {
    files.forEach((file, i) => {
      const b = items[i] || {};
      const merchant = (b.merchant || '').toString().trim();
      if (!merchant) { errors.push({ index: i, file: file.originalname, error: '商家名称必填' }); return; }
      const amount = parseFloat(b.amount) || 0;
      const coupon_code = (b.coupon_code || '').toString().trim();
      const quantity = parseInt(b.quantity) || 1;
      const expiry_date = b.expiry_date ? b.expiry_date.toString().trim() : null;
      const cost = parseFloat(b.cost) || 0;
      const owner_name = (b.owner_name || '').toString().trim() || req.user.display_name;
      const note = (b.note || '').toString().trim();
      try {
        const info = insert.run(merchant, amount, coupon_code, quantity, expiry_date, cost, owner_name, req.user.id, file.filename, note, req.user.id);
        created.push(info.lastInsertRowid);
      } catch (e) {
        errors.push({ index: i, file: file.originalname, error: '入库失败：' + e.message });
      }
    });
  });
  try { tx(); } catch (e) { return res.status(500).json({ error: '批量入库失败：' + e.message }); }
  res.json({ count: created.length, created, errors });
});

// 详情
router.get('/:id', authMiddleware, (req, res) => {
  const row = db.prepare('SELECT * FROM coupons WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '未找到该券' });
  res.json({ coupon: row });
});

// 更新
router.put('/:id', authMiddleware, upload.single('image'), (req, res) => {
  const row = db.prepare('SELECT * FROM coupons WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '未找到该券' });
  // 权限：仅管理员或券的所有者可编辑
  if (req.user.role !== 'admin' && row.owner_user_id !== req.user.id) {
    return res.status(403).json({ error: '只能编辑自己录入的券' });
  }
  const b = req.body || {};
  const merchant = b.merchant !== undefined ? b.merchant.toString().trim() : row.merchant;
  const amount = b.amount !== undefined ? (parseFloat(b.amount) || 0) : row.amount;
  const coupon_code = b.coupon_code !== undefined ? b.coupon_code.toString().trim() : row.coupon_code;
  const quantity = b.quantity !== undefined ? (parseInt(b.quantity) || 1) : row.quantity;
  const expiry_date = b.expiry_date !== undefined ? (b.expiry_date ? b.expiry_date.toString().trim() : null) : row.expiry_date;
  const cost = b.cost !== undefined ? (parseFloat(b.cost) || 0) : row.cost;
  const owner_name = b.owner_name !== undefined ? (b.owner_name.toString().trim() || row.owner_name) : row.owner_name;
  const note = b.note !== undefined ? b.note.toString().trim() : row.note;
  let image_filename = row.image_filename;
  if (req.file) image_filename = req.file.filename;

  db.prepare(`UPDATE coupons SET
    merchant=?, amount=?, coupon_code=?, quantity=?, expiry_date=?, cost=?, owner_name=?, note=?, image_filename=?, updated_at=datetime('now')
    WHERE id=?`)
    .run(merchant, amount, coupon_code, quantity, expiry_date, cost, owner_name, note, image_filename, row.id);
  const updated = db.prepare('SELECT * FROM coupons WHERE id = ?').get(row.id);
  res.json({ coupon: updated });
});

// 删除
router.delete('/:id', authMiddleware, (req, res) => {
  const row = db.prepare('SELECT * FROM coupons WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '未找到该券' });
  // 权限：仅管理员或券的所有者可删除
  if (req.user.role !== 'admin' && row.owner_user_id !== req.user.id) {
    return res.status(403).json({ error: '只能删除自己录入的券' });
  }
  if (row.image_filename) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, row.image_filename)); } catch (e) {}
  }
  db.prepare('DELETE FROM coupons WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// 标记售出 / 取消售出（仅管理员）
router.post('/:id/sold', authMiddleware, adminOnly, (req, res) => {
  const row = db.prepare('SELECT * FROM coupons WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '未找到该券' });
  const newStatus = row.status === 'sold' ? 'unsold' : 'sold';
  db.prepare("UPDATE coupons SET status = ?, settled = 0, updated_at = datetime('now') WHERE id = ?").run(newStatus, row.id);
  res.json({ ok: true, status: newStatus });
});

// 标记结算 / 取消结算（仅已售券可用，仅管理员）
router.post('/:id/settle', authMiddleware, adminOnly, (req, res) => {
  const row = db.prepare('SELECT * FROM coupons WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '未找到该券' });
  if (row.status !== 'sold') return res.status(400).json({ error: '只有已售出的券才能标记结算' });
  const newSettled = row.settled ? 0 : 1;
  db.prepare("UPDATE coupons SET settled = ?, updated_at = datetime('now') WHERE id = ?").run(newSettled, row.id);
  res.json({ ok: true, settled: newSettled });
});

module.exports = router;
module.exports.UPLOAD_DIR = UPLOAD_DIR;
