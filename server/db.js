// 纯 JavaScript SQLite（sql.js），无需编译，任何电脑 npm install 即可跑通
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const dbPath = path.join(DATA_DIR, 'coupon.db');
let _db; // 内部 sql.js 实例

// 兼容 better-sqlite3 风格的 Statement 包装：支持 .all() / .get() / .run()
function makeStmt(sql) {
  const stmt = _db.prepare(sql);
  function run(...params) {
    stmt.bind(params.length ? params : []);
    while (stmt.step()) {} // 执行到完成
    // 注意：不在此处 stmt.free()！run() 可被同一 prepare 对象反复调用（如批量插入）
    return { lastInsertRowid: _db.getRowsModified() > 0 ? _db.exec("SELECT last_insert_rowid()")[0]?.values?.[0]?.[0] ?? null : null, changes: _db.getRowsModified() };
  }
  function get(...params) {
    stmt.bind(params.length ? params : []);
    const has = stmt.step();
    if (has) { const obj = stmt.getAsObject(); stmt.free(); return obj; }
    stmt.free(); return undefined;
  }
  function all(...params) {
    stmt.bind(params.length ? params : []);
    const rows = [];
    const cols = stmt.getColumnNames();
    while (stmt.step()) { const row = stmt.getAsObject(); rows.push(row); }
    stmt.free();
    return rows;
  }
  return { get, all, run };
}

function prepare(sql) { return makeStmt(sql); }

function exec(sql) { try { _db.exec(sql); } catch(e) { console.error('[db.exec]', e.message); } }

function pragma(str) { /* sql.js 不支持 pragma，忽略 */ }

// 事务包装：模拟 better-sqlite3 的 db.transaction(fn)
function transaction(fn) {
  return function(...args) {
    try {
      const result = fn(...args);
      saveDB(); // 事务完成后立即持久化到文件
      return result;
    } catch(e) {
      console.error('[transaction]', e.message);
      throw e;
    }
  };
}

// 写一条操作日志（审计留痕）。失败仅记录、不影响主流程。
function logOperation({ user_id, username, action, target, detail }) {
  if (!_db) return;
  try {
    const d = new Date();
    const off = d.getTimezoneOffset();
    const ts = new Date(d.getTime() - off * 60000).toISOString().slice(0, 19).replace('T', ' ');
    prepare("INSERT INTO operation_log (user_id, username, action, target, detail, created_at) VALUES (?,?,?,?,?,?)")
      .run(user_id != null ? user_id : null, username || '', action, target || '', detail || '', ts);
  } catch (e) { console.error('[logOperation]', e.message); }
}

module.exports = {
  logOperation,
  init: async function() {
    const SQL = await initSqlJs();
    let buf;
    if (fs.existsSync(dbPath)) buf = fs.readFileSync(dbPath);
    _db = new SQL.Database(buf || undefined);

    exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS coupons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  coupon_code TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  expiry_date TEXT,
  cost REAL NOT NULL DEFAULT 0,
  owner_name TEXT NOT NULL,
  platform TEXT,
  owner_user_id INTEGER,
  image_filename TEXT,
  status TEXT NOT NULL DEFAULT 'unsold',
  note TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  settle_amount REAL
);

CREATE TABLE IF NOT EXISTS search_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  term TEXT NOT NULL,
  user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS operation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  username TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

    // 字段迁移：已售券的「结算」子状态（0=未结算 默认，1=已结算）
    try {
      const ti = _db.exec("PRAGMA table_info(coupons)");
      const cols = ti.length ? ti[0].values.map(r => r[1]) : [];
      if (!cols.includes('settled')) {
        _db.exec("ALTER TABLE coupons ADD COLUMN settled INTEGER NOT NULL DEFAULT 0");
      }
      if (!cols.includes('settle_amount')) {
        _db.exec("ALTER TABLE coupons ADD COLUMN settle_amount REAL");
      }
      if (!cols.includes('platform')) {
        _db.exec("ALTER TABLE coupons ADD COLUMN platform TEXT");
      }
      if (!cols.includes('sold_at')) {
        _db.exec("ALTER TABLE coupons ADD COLUMN sold_at TEXT");
      }
    } catch (e) { console.error('[migrate]', e.message); }

    // 首次启动创建管理员
    const adminUser = process.env.ADMIN_USER || 'admin';
    const adminPass = process.env.ADMIN_PASS || 'admin123';
    const existing = prepare('SELECT id FROM users WHERE username = ?').get(adminUser);
    if (!existing) {
      const hash = bcrypt.hashSync(adminPass, 10);
      prepare('INSERT INTO users (username, password_hash, display_name, role) VALUES (?,?,?,?)')
        .run(adminUser, hash, adminUser, 'admin');
      console.log(`[init] 已创建管理员账号: ${adminUser}`);
    }

    // 定期自动持久化到文件
    setInterval(saveDB, 30000);
    return this;
  },
  save: saveDB,
  prepare, exec, pragma, transaction
};

// 持久化：把内存数据库写入文件
function saveDB() {
  if (!_db) return;
  try { const d = _db.export(); fs.writeFileSync(dbPath, Buffer.from(d)); } catch(_) {}
}
