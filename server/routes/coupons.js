const express = require('express');
const router = express.Router();
const db = require('../db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { authMiddleware, adminOnly } = require('../middleware/auth');

// 拼音搜索：pinyin-pro 为可选依赖，缺失时自动降级（仅失去拼音/首字母搜索能力，不影响其它功能）
let pinyinLib = null;
try { pinyinLib = require('pinyin-pro'); } catch (e) { pinyinLib = null; }
// 将若干文本字段转为「全拼 + 首字母」小写串，存入 pinyin 列供模糊检索
// 例：「美团 饿了么」→ "meituan elms mt elm"
function toPinyin(...parts) {
  const text = parts.filter(Boolean).join(' ');
  if (!pinyinLib || !text) return '';
  try {
    const opt = { toneType: 'none', type: 'string', nonZh: 'consecutive' };
    const full = pinyinLib.pinyin(text, opt).replace(/\s+/g, '');
    const initials = pinyinLib.pinyin(text, { ...opt, pattern: 'first' }).replace(/\s+/g, '');
    return (full + ' ' + initials).toLowerCase();
  } catch (e) { return ''; }
}

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
    const like = '%' + q + '%';
    const likePy = '%' + q.toLowerCase() + '%';
    sql += ' AND (merchant LIKE ? OR coupon_code LIKE ? OR owner_name LIKE ? OR platform LIKE ? OR note LIKE ? OR pinyin LIKE ?)';
    params.push(like, like, like, like, like, likePy);
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
  const soldFaceValue = sold.reduce((s, c) => s + (c.amount || 0) * (c.quantity || 1), 0);
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
  const pendingAmount = Math.round(soldUnsettled.reduce((s, c) => s + (parseFloat(c.settle_amount) || 0), 0) * 100) / 100;
  res.json({
    unsold_unexpired: unsoldUnexpired.length,
    face_value: Math.round(faceValue * 100) / 100,
    cost: Math.round(cost * 100) / 100,
    potential: Math.round(potential * 100) / 100,
    sold: sold.length,
    sold_face_value: Math.round(soldFaceValue * 100) / 100,
    sold_unsettled: soldUnsettled.length,
    pending_amount: pendingAmount,
    expiring_soon: expiringSoon,
    expired_unsold: expiredUnsold.length
  });
});

// 热门券商家：按商家名在库存中的出现频次排序，取前 N（供首页「热门券商家」快捷筛选）
router.get('/popular-merchants', authMiddleware, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 8, 20);
  const rows = db.prepare(
    `SELECT merchant FROM coupons
     WHERE merchant IS NOT NULL AND merchant <> ''
     GROUP BY merchant ORDER BY COUNT(*) DESC, MAX(id) DESC LIMIT ?`
  ).all(limit);
  res.json({ merchants: rows.map(r => r.merchant) });
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
    settled_amount: 0, pending_amount: 0, total_amount: 0
  });
  rows.forEach(c => {
    const k = c.owner_name || '未指定';
    const g = byOwner[k] = byOwner[k] || blank();
    g.owner = k;
    const amt = (c.amount || 0) * (c.quantity || 1);
    g.qty += (c.quantity || 1);
    g.face_value += amt;
    g.cost += (c.cost || 0);
    if (c.settled) {
      g.settled_count += 1;
      const sa = (c.settle_amount != null ? c.settle_amount : 0);
      g.settled_amount += sa;
      g.total_amount += sa;
    } else {
      g.unsettled_count += 1;
      const pa = (c.settle_amount != null ? c.settle_amount : amt); // 优先用结算金额；历史无售出价时退回面值
      g.pending_amount += pa;
      g.total_amount += pa;
    }
  });

  const r = n => Math.round(n * 100) / 100;
  const clean = g => ({
    owner: g.owner, qty: g.qty, face_value: r(g.face_value), cost: r(g.cost),
    settled_count: g.settled_count, unsettled_count: g.unsettled_count,
    settled_amount: r(g.settled_amount), pending_amount: r(g.pending_amount),
    total_amount: r(g.total_amount)
  });
  const result = Object.keys(byOwner).map(k => byOwner[k]).map(clean);
  const totals = result.reduce((t, g) => {
    t.qty += g.qty; t.face_value += g.face_value; t.cost += g.cost;
    t.settled_count += g.settled_count; t.unsettled_count += g.unsettled_count;
    t.settled_amount += g.settled_amount; t.pending_amount += g.pending_amount;
    t.total_amount += g.total_amount;
    return t;
  }, { qty:0, face_value:0, cost:0, settled_count:0, unsettled_count:0, settled_amount:0, pending_amount:0, total_amount:0 });

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
    (merchant, amount, coupon_code, quantity, expiry_date, cost, owner_name, platform, owner_user_id, image_filename, note, created_by, pinyin)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(merchant, amount, coupon_code, quantity, expiry_date, cost, owner_name, platform, req.user.id, image_filename, note, req.user.id, toPinyin(merchant, owner_name, platform, note));
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
    (merchant, amount, coupon_code, quantity, expiry_date, cost, owner_name, platform, owner_user_id, image_filename, note, created_by, pinyin)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
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
        const info = insert.run(merchant, amount, coupon_code, quantity, expiry_date, cost, owner_name, platform, req.user.id, file.filename, note, req.user.id, toPinyin(merchant, owner_name, platform, note));
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
    merchant=?, amount=?, coupon_code=?, quantity=?, expiry_date=?, cost=?, owner_name=?, platform=?, note=?, image_filename=?, pinyin=?, updated_at=datetime('now')
    WHERE id=?`)
    .run(merchant, amount, coupon_code, quantity, expiry_date, cost, owner_name, platform, note, image_filename, toPinyin(merchant, owner_name, platform, note), row.id);
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
// 标记售出需录入「售出价」，系统按 售出价 − 平台手续费(售出价×1.6%) 计算结算金额，并记录销售人
router.post('/:id/sold', authMiddleware, adminOnly, (req, res) => {
  const row = db.prepare('SELECT * FROM coupons WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '未找到该券' });
  if (row.status === 'sold') {
    // 取消售出：清空售出/结算/销售人相关字段
    db.prepare("UPDATE coupons SET status = 'unsold', settled = 0, settle_amount = NULL, sold_price = NULL, sold_at = NULL, sold_by = NULL, sold_by_name = NULL, updated_at = datetime('now') WHERE id = ?").run(row.id);
    logOp(req, 'unmark_sold', row.merchant, `取消售出 #${row.id}`);
    return res.json({ ok: true, status: 'unsold' });
  }
  const sp = parseFloat(req.body && req.body.sold_price);
  if (!(sp >= 0)) return res.status(400).json({ error: '请输入售出价' });
  const fee = Math.round(sp * 0.016 * 100) / 100;
  const amt = Math.round((sp - fee) * 100) / 100;
  const uid = req.user ? req.user.id : null;
  const uname = (req.user && (req.user.display_name || req.user.username)) || '';
  db.prepare("UPDATE coupons SET status = 'sold', settled = 0, sold_price = ?, settle_amount = ?, sold_at = ?, sold_by = ?, sold_by_name = ?, updated_at = datetime('now') WHERE id = ?")
    .run(sp, amt, nowLocal(), uid, uname, row.id);
  logOp(req, 'mark_sold', row.merchant, `标记售出 售出价¥${sp} 手续费¥${fee} 结算金额¥${amt} 销售人:${uname} #${row.id}`);
  res.json({ ok: true, status: 'sold', sold_price: sp, settle_amount: amt, sold_by: uid, sold_by_name: uname });
});

// 标记结算 / 取消结算（仅已售券可用，仅管理员）
router.post('/:id/settle', authMiddleware, adminOnly, (req, res) => {
  const row = db.prepare('SELECT * FROM coupons WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '未找到该券' });
  if (row.status !== 'sold') return res.status(400).json({ error: '只有已售出的券才能标记结算' });
  if (row.settled) {
    // 取消结算：仅翻转结算状态（售出价/结算金额保留，便于重新结算）
    db.prepare("UPDATE coupons SET settled = 0, updated_at = datetime('now') WHERE id = ?").run(row.id);
    logOp(req, 'unsettle', row.merchant, `取消结算 #${row.id}`);
    return res.json({ ok: true, settled: false });
  }
  // 标记结算（确认已付款给所有人）。售出价通常已在标记售出时录入；兼容历史数据可在此补填
  const sp = row.sold_price != null ? row.sold_price : (parseFloat(req.body && req.body.sold_price));
  if (!(sp >= 0)) return res.status(400).json({ error: '请先标记售出并填写售出价' });
  const fee = Math.round(sp * 0.016 * 100) / 100;
  const amt = Math.round((sp - fee) * 100) / 100;
  db.prepare("UPDATE coupons SET settled = 1, sold_price = ?, settle_amount = ?, updated_at = datetime('now') WHERE id = ?").run(sp, amt, row.id);
  logOp(req, 'settle', row.merchant, `结算金额¥${amt} #${row.id}`);
  res.json({ ok: true, settled: true, sold_price: sp, settle_amount: amt });
});

// 历史数据拼音索引补全：对已存在但 pinyin 为空的券重新计算，使拼音/首字母搜索覆盖旧数据
function backfillPinyin() {
  try {
    const rows = db.prepare("SELECT id, merchant, owner_name, platform, note, pinyin FROM coupons WHERE pinyin IS NULL OR pinyin = ''").all();
    if (!rows.length) return;
    const upd = db.prepare("UPDATE coupons SET pinyin = ? WHERE id = ?");
    const tx = db.transaction(() => {
      rows.forEach(r => upd.run(toPinyin(r.merchant, r.owner_name, r.platform, r.note), r.id));
    });
    tx();
    console.log(`[backfill] 已补全拼音索引 ${rows.length} 条`);
  } catch (e) { console.error('[backfill]', e.message); }
}

module.exports = router;
module.exports.UPLOAD_DIR = UPLOAD_DIR;
module.exports.backfillPinyin = backfillPinyin;
