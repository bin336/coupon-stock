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
// 本地时间字符串（YYYY-MM-DD HH:MM:SS），与前端一致，避免 UTC 偏移
function nowLocal() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 19).replace('T', ' ');
}
function logOp(req, action, target, detail) {
  db.logOperation({
    user_id: req.user ? req.user.id : null,
    username: req.user ? req.user.username : '',
    action, target, detail
  });
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
    sql += ' AND (merchant LIKE ? OR coupon_code LIKE ? OR owner_name LIKE ? OR platform LIKE ? OR note LIKE ?)';
    const like = '%' + q + '%';
    params.push(like, like, like, like, like);
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
  const soldUnsettled = sold.filter(c => !c.settled);
  const expiredUnsold = all.filter(c => c.status === 'unsold' && c.expiry_date && c.expiry_date < today);
  const faceValue = unsoldUnexpired.reduce((s, c) => s + (c.amount || 0) * (c.quantity || 1), 0);
  const cost = unsoldUnexpired.reduce((s, c) => s + (c.cost || 0), 0);
  const potential = faceValue - cost;
  // 7 天内到期（未售且未过期、到期日 <= 今天+7）
  const [y, m, d] = today.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + 7);
  const off = dt.getTimezoneOffset();
  const soon = new Date(dt.getTime() - off * 60000).toISOString().slice(0, 10);
  const expiringSoon = unsoldUnexpired.filter(c => c.expiry_date && c.expiry_date <= soon).length;
  res.json({
    unsold_unexpired: unsoldUnexpired.length,
    face_value: Math.round(faceValue * 100) / 100,
    cost: Math.round(cost * 100) / 100,
    potential: Math.round(potential * 100) / 100,
    sold: sold.length,
    sold_unsettled: soldUnsettled.length,
    expiring_soon: expiringSoon,
    expired_unsold: expiredUnsold.length
  });
});

// 记录一次搜索（供「所有用户共享的近期搜索」使用）
router.post('/search-log', authMiddleware, (req, res) => {
  const term = ((req.body && req.body.term) || '').trim();
  if (!term) return res.json({ ok: true });
  db.prepare('INSERT INTO search_log (term, user_id) VALUES (?, ?)').run(term, req.user.id);
  res.json({ ok: true });
});

// 所有用户搜索频次最高的词（团队共享快捷词）
router.get('/recent-searches', authMiddleware, (req, res) => {
  const rows = db.prepare(
    'SELECT term FROM search_log GROUP BY term ORDER BY COUNT(*) DESC, MAX(created_at) DESC LIMIT 8'
  ).all();
  res.json({ terms: rows.map(r => r.term) });
});

// 售出 / 利润报表：按「所有人」分组，支持时间段（sold_at）与所有人筛选。仅管理员。
router.get('/report', authMiddleware, adminOnly, (req, res) => {
  const { owner, start, end } = req.query;
  const params = [];
  let sql = "SELECT * FROM coupons WHERE status = 'sold'";
  if (start) { sql += ' AND sold_at >= ?'; params.push(start + ' 00:00:00'); }
  if (end) { sql += ' AND sold_at <= ?'; params.push(end + ' 23:59:59'); }
  if (owner) { sql += ' AND owner_name LIKE ?'; params.push('%' + owner + '%'); }
  const rows = db.prepare(sql).all(...params);

  const byOwner = {};
  const blank = () => ({
    owner: '', qty: 0, face_value: 0, cost: 0,
    settled_count: 0, unsettled_count: 0,
    settled_amount: 0, settled_profit: 0,
    pending_amount: 0, pending_profit: 0, total_profit: 0
  });
  rows.forEach(c => {
    const k = c.owner_name || '未指定';
    const g = byOwner[k] = byOwner[k] || blank();
    g.owner = k;
    const amt = (c.amount || 0) * (c.quantity || 1);
    const cost = (c.cost || 0);
    g.qty += (c.quantity || 1);
    g.face_value += amt;
    g.cost += cost;
    if (c.settled) {
      g.settled_count += 1;
      const sa = (c.settle_amount != null ? c.settle_amount : 0);
      g.settled_amount += sa;
      g.settled_profit += (sa - cost);
      g.total_profit += (sa - cost);
    } else {
      g.unsettled_count += 1;
      g.pending_amount += amt;
      g.pending_profit += (amt - cost);
      g.total_profit += (amt - cost);
    }
  });

  const r = n => Math.round(n * 100) / 100;
  const clean = g => ({
    owner: g.owner, qty: g.qty, face_value: r(g.face_value), cost: r(g.cost),
    settled_count: g.settled_count, unsettled_count: g.unsettled_count,
    settled_amount: r(g.settled_amount), settled_profit: r(g.settled_profit),
    pending_amount: r(g.pending_amount), pending_profit: r(g.pending_profit),
    total_profit: r(g.total_profit)
  });
  const result = Object.keys(byOwner).map(k => byOwner[k]).map(clean);
  const totals = result.reduce((t, g) => {
    t.qty += g.qty; t.face_value += g.face_value; t.cost += g.cost;
    t.settled_count += g.settled_count; t.unsettled_count += g.unsettled_count;
    t.settled_amount += g.settled_amount; t.settled_profit += g.settled_profit;
    t.pending_amount += g.pending_amount; t.pending_profit += g.pending_profit;
    t.total_profit += g.total_profit;
    return t;
  }, { qty:0, face_value:0, cost:0, settled_count:0, unsettled_count:0, settled_amount:0, settled_profit:0, pending_amount:0, pending_profit:0, total_profit:0 });

  res.json({
    rows: result,
    totals: clean(totals),
    filters: { owner: owner || '', start: start || '', end: end || '' }
  });
});

// 操作日志（审计留痕）：支持 action / 操作人 / 关键词 / 时间段筛选。仅管理员。
router.get('/logs', authMiddleware, adminOnly, (req, res) => {
  const { action, user, q, start, end, limit } = req.query;
  const params = [];
  let sql = 'SELECT * FROM operation_log WHERE 1=1';
  if (action) { sql += ' AND action = ?'; params.push(action); }
  if (user) { sql += ' AND username LIKE ?'; params.push('%' + user + '%'); }
  if (q) { sql += ' AND (target LIKE ? OR detail LIKE ?)'; params.push('%' + q + '%', '%' + q + '%'); }
  if (start) { sql += ' AND created_at >= ?'; params.push(start + ' 00:00:00'); }
  if (end) { sql += ' AND created_at <= ?'; params.push(end + ' 23:59:59'); }
  sql += ' ORDER BY id DESC LIMIT ' + (parseInt(limit) || 200);
  const rows = db.prepare(sql).all(...params);
  res.json({ logs: rows });
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
  const platform = (b.platform || '').toString().trim();
  const image_filename = req.file ? req.file.filename : null;

  const info = db.prepare(`INSERT INTO coupons
    (merchant, amount, coupon_code, quantity, expiry_date, cost, owner_name, platform, owner_user_id, image_filename, note, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(merchant, amount, coupon_code, quantity, expiry_date, cost, owner_name, platform, req.user.id, image_filename, note, req.user.id);
  const row = db.prepare('SELECT * FROM coupons WHERE id = ?').get(info.lastInsertRowid);
  logOp(req, 'add_coupon', merchant, `面值¥${amount} ×${quantity}张 成本¥${cost} 所有人:${owner_name}`);
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
    (merchant, amount, coupon_code, quantity, expiry_date, cost, owner_name, platform, owner_user_id, image_filename, note, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
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
      const platform = (b.platform || '').toString().trim();
      const note = (b.note || '').toString().trim();
      try {
        const info = insert.run(merchant, amount, coupon_code, quantity, expiry_date, cost, owner_name, platform, req.user.id, file.filename, note, req.user.id);
        created.push(info.lastInsertRowid);
      } catch (e) {
        errors.push({ index: i, file: file.originalname, error: '入库失败：' + e.message });
      }
    });
  });
  try { tx(); } catch (e) { return res.status(500).json({ error: '批量入库失败：' + e.message }); }
  if (created.length) logOp(req, 'batch_add', `${created.length}张`, `批量入库 ${created.length} 张`);
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
  const platform = b.platform !== undefined ? b.platform.toString().trim() : row.platform;
  let image_filename = row.image_filename;
  if (req.file) image_filename = req.file.filename;

  db.prepare(`UPDATE coupons SET
    merchant=?, amount=?, coupon_code=?, quantity=?, expiry_date=?, cost=?, owner_name=?, platform=?, note=?, image_filename=?, updated_at=datetime('now')
    WHERE id=?`)
    .run(merchant, amount, coupon_code, quantity, expiry_date, cost, owner_name, platform, note, image_filename, row.id);
  const updated = db.prepare('SELECT * FROM coupons WHERE id = ?').get(row.id);
  logOp(req, 'edit_coupon', merchant, `编辑券 #${row.id}`);
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
  logOp(req, 'delete_coupon', row.merchant, `删除券 #${row.id}`);
  res.json({ ok: true });
});

// 标记售出 / 取消售出（仅管理员）
router.post('/:id/sold', authMiddleware, adminOnly, (req, res) => {
  const row = db.prepare('SELECT * FROM coupons WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '未找到该券' });
  const newStatus = row.status === 'sold' ? 'unsold' : 'sold';
  if (newStatus === 'sold') {
    db.prepare("UPDATE coupons SET status = 'sold', settled = 0, sold_at = ?, updated_at = datetime('now') WHERE id = ?").run(nowLocal(), row.id);
    logOp(req, 'mark_sold', row.merchant, `标记售出 #${row.id}`);
  } else {
    db.prepare("UPDATE coupons SET status = 'unsold', settled = 0, settle_amount = NULL, sold_at = NULL, updated_at = datetime('now') WHERE id = ?").run(row.id);
    logOp(req, 'unmark_sold', row.merchant, `取消售出 #${row.id}`);
  }
  res.json({ ok: true, status: newStatus });
});

// 标记结算 / 取消结算（仅已售券可用，仅管理员）
router.post('/:id/settle', authMiddleware, adminOnly, (req, res) => {
  const row = db.prepare('SELECT * FROM coupons WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '未找到该券' });
  if (row.status !== 'sold') return res.status(400).json({ error: '只有已售出的券才能标记结算' });
  if (row.settled) {
    // 取消结算：清空结算金额
    db.prepare("UPDATE coupons SET settled = 0, settle_amount = NULL, updated_at = datetime('now') WHERE id = ?").run(row.id);
    logOp(req, 'unsettle', row.merchant, `取消结算 #${row.id}`);
    return res.json({ ok: true, settled: false });
  }
  // 标记结算：需录入结算金额（佣金 = 结算金额 − 成本）
  const amt = parseFloat(req.body && req.body.settle_amount);
  if (!(amt >= 0)) return res.status(400).json({ error: '请输入结算金额' });
  db.prepare("UPDATE coupons SET settled = 1, settle_amount = ?, updated_at = datetime('now') WHERE id = ?").run(amt, row.id);
  logOp(req, 'settle', row.merchant, `结算金额¥${amt} #${row.id}`);
  res.json({ ok: true, settled: true, settle_amount: amt });
});

module.exports = router;
module.exports.UPLOAD_DIR = UPLOAD_DIR;
