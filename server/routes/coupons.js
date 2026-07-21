const express = require('express');
const router = express.Router();
const db = require('../db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
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

// 文件内容 MD5（重复录入的图片指纹比对，用于拦截同一张截图被多次入库）
function computeFileHash(filePath) {
  try { return crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex'); }
  catch (e) { return null; }
}

// 查找与待录入券重复的「未售」券：按券号精确匹配 + 按图片指纹匹配
// 返回 [{id, merchant, amount, coupon_code, expiry_date, quantity, match_by}]
function findDuplicates({ coupon_code, image_hash }) {
  const conds = [];
  const params = [];
  if (coupon_code) {
    conds.push('(coupon_code IS NOT NULL AND coupon_code <> ? AND coupon_code = ?)');
    params.push('', coupon_code);
  }
  if (image_hash) {
    conds.push('(image_hash IS NOT NULL AND image_hash = ?)');
    params.push(image_hash);
  }
  if (!conds.length) return [];
  const rows = db.prepare(
    `SELECT id, merchant, amount, coupon_code, expiry_date, quantity, image_hash
     FROM coupons WHERE status = 'unsold' AND (${conds.join(' OR ')})`
  ).all(...params);
  return rows.map(r => ({
    id: r.id, merchant: r.merchant, amount: r.amount,
    coupon_code: r.coupon_code, expiry_date: r.expiry_date, quantity: r.quantity,
    match_by: (image_hash && r.image_hash === image_hash) ? 'image' : 'code'
  }));
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
    // 分词搜索：每个空格分隔的词都要命中任一字段（商家/券号/所有人/平台/备注/拼音/面值）
    // 预处理：中文与数字之间自动补空格，使「许家菜100」等价于「许家菜 100」（移动端常连打不带空格）
    const normQ = String(q).trim()
      .replace(/([\u4e00-\u9fff])(\d)/g, '$1 $2')
      .replace(/(\d)([\u4e00-\u9fff])/g, '$1 $2');
    const tokens = normQ.split(/\s+/).filter(Boolean);
    tokens.forEach(tok => {
      const like = '%' + tok + '%';
      const likePy = '%' + tok.toLowerCase() + '%';
      sql += ' AND (merchant LIKE ? OR coupon_code LIKE ? OR owner_name LIKE ? OR platform LIKE ? OR note LIKE ? OR pinyin LIKE ? OR CAST(amount AS TEXT) LIKE ?)';
      params.push(like, like, like, like, like, likePy, like);
    });
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
  const cost = unsoldUnexpired.reduce((s, c) => s + (c.cost || 0) * (c.quantity || 1), 0);
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

// 全部去重商家名（录入自动补全用，避免「星巴克」/「星 巴克」分裂）
router.get('/merchants', authMiddleware, (req, res) => {
  const rows = db.prepare(
    `SELECT DISTINCT merchant FROM coupons WHERE merchant IS NOT NULL AND merchant <> '' ORDER BY merchant`
  ).all();
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
  const image_hash = req.file ? computeFileHash(req.file.path) : null;
  const force = String(b.force || '').trim() === '1';

  // 重复录入拦截：入库前比对未售券（券号 / 图片指纹），命中则提示确认，不入库
  if (!force) {
    const dups = findDuplicates({ coupon_code, image_hash });
    if (dups.length) return res.status(409).json({ error: '疑似重复录入', duplicates: dups });
  }

  const info = db.prepare(`INSERT INTO coupons
    (merchant, amount, coupon_code, quantity, expiry_date, cost, owner_name, platform, owner_user_id, image_filename, image_hash, note, created_by, created_at, pinyin)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(merchant, amount, coupon_code, quantity, expiry_date, cost, owner_name, platform, req.user.id, image_filename, image_hash, note, req.user.id, nowLocal(), toPinyin(merchant, owner_name, platform, note));
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
  const force = String(req.body.force || '').trim() === '1';

  // 重复录入拦截：逐张比对未售券，命中则整批返回疑似重复列表，由前端确认后强制录入
  if (!force) {
    const dups = [];
    files.forEach((file, i) => {
      const b = items[i] || {};
      const coupon_code = (b.coupon_code || '').toString().trim();
      const image_hash = computeFileHash(file.path);
      const found = findDuplicates({ coupon_code, image_hash });
      if (found.length) dups.push({ index: i, file: file.originalname, matches: found });
    });
    if (dups.length) return res.status(409).json({ error: '疑似重复录入', duplicates: dups });
  }

  const created = [];
  const createdDetails = [];
  const errors = [];
  const insert = db.prepare(`INSERT INTO coupons
    (merchant, amount, coupon_code, quantity, expiry_date, cost, owner_name, platform, owner_user_id, image_filename, image_hash, note, created_by, created_at, pinyin)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
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
      const image_hash = computeFileHash(file.path);
      try {
        const info = insert.run(merchant, amount, coupon_code, quantity, expiry_date, cost, owner_name, platform, req.user.id, file.filename, image_hash, note, req.user.id, nowLocal(), toPinyin(merchant, owner_name, platform, note));
        created.push(info.lastInsertRowid);
        createdDetails.push({ merchant, amount, quantity, owner_name });
      } catch (e) {
        errors.push({ index: i, file: file.originalname, error: '入库失败：' + e.message });
      }
    });
  });
  try { tx(); } catch (e) { return res.status(500).json({ error: '批量入库失败：' + e.message }); }
  if (created.length) {
    // 对象：去重商家名（单商家直接用商家名；多商家取前 3 个并标注家数）
    const merchants = [...new Set(createdDetails.map(c => c.merchant))];
    const target = merchants.length === 1
      ? merchants[0]
      : merchants.slice(0, 3).join('、') + (merchants.length > 3 ? ` 等${merchants.length}家` : '');
    // 详情：逐券「商家 ¥面值 ×张数」摘要
    const detail = `批量入库 ${created.length} 张：` + createdDetails.map(c => `${c.merchant} ¥${c.amount} ×${c.quantity}`).join('，');
    logOp(req, 'batch_add', target, detail);
  }
  res.json({ count: created.length, created, errors });
});

// 每日运营小结：今日录入 / 售出 / 结算额 + 当前库存总值 + 将过期（开局一眼看全局）
router.get('/daily', authMiddleware, (req, res) => {
  const today = todayLocal();
  const start = today + ' 00:00:00';
  const end = today + ' 23:59:59';
  const all = db.prepare('SELECT * FROM coupons').all();
  const inRange = t => t && t >= start && t <= end;
  const added = all.filter(c => inRange(c.created_at));
  const addedFace = added.reduce((s, c) => s + (c.amount || 0) * (c.quantity || 1), 0);
  const soldToday = all.filter(c => inRange(c.sold_at));
  const soldFace = soldToday.reduce((s, c) => s + (c.amount || 0) * (c.quantity || 1), 0);
  const settledToday = all.filter(c => inRange(c.settled_at));
  const settledAmount = settledToday.reduce((s, c) => s + (parseFloat(c.settle_amount) || 0), 0);
  const unsoldUnexpired = all.filter(c => c.status === 'unsold' && (!c.expiry_date || c.expiry_date >= today));
  const faceValue = unsoldUnexpired.reduce((s, c) => s + (c.amount || 0) * (c.quantity || 1), 0);
  // 7 天内到期
  const [y, m, d] = today.split('-').map(Number);
  const dt = new Date(y, m - 1, d); dt.setDate(dt.getDate() + 7);
  const off = dt.getTimezoneOffset();
  const soon = new Date(dt.getTime() - off * 60000).toISOString().slice(0, 10);
  const expiringSoon = unsoldUnexpired.filter(c => c.expiry_date && c.expiry_date <= soon).length;
  const r = n => Math.round(n * 100) / 100;
  res.json({
    added_count: added.length,
    added_face: r(addedFace),
    sold_count: soldToday.length,
    sold_face: r(soldFace),
    settled_amount: r(settledAmount),
    inventory_value: r(faceValue),
    expiring_soon: expiringSoon
  });
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
    db.prepare("UPDATE coupons SET settled = 0, settled_at = NULL, updated_at = datetime('now') WHERE id = ?").run(row.id);
    logOp(req, 'unsettle', row.merchant, `取消结算 #${row.id}`);
    return res.json({ ok: true, settled: false });
  }
  // 标记结算（确认已付款给所有人）。售出价通常已在标记售出时录入；兼容历史数据可在此补填
  const sp = row.sold_price != null ? row.sold_price : (parseFloat(req.body && req.body.sold_price));
  if (!(sp >= 0)) return res.status(400).json({ error: '请先标记售出并填写售出价' });
  const fee = Math.round(sp * 0.016 * 100) / 100;
  const amt = Math.round((sp - fee) * 100) / 100;
  db.prepare("UPDATE coupons SET settled = 1, sold_price = ?, settle_amount = ?, settled_at = ?, updated_at = datetime('now') WHERE id = ?").run(sp, amt, nowLocal(), row.id);
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
