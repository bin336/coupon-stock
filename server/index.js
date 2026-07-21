require('dotenv').config();

// 进程级兜底：OCR 底层（leptonico/libpng）遇到损坏图片会触发原生 Abort，
// 这类异常不在 Promise 链内、会直接崩进程。作为 24/7 服务，这里只记录、不退出，
// 避免单张坏图拖垮整个库存系统；每次 OCR 都会新建 worker，互不影响。
process.on('uncaughtException', (err) => {
  console.error('[兜底] 捕获未处理异常（已阻止进程退出）:', (err && err.message) || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[兜底] 捕获未处理 Promise 拒绝:', (reason && reason.message) || reason);
});

const express = require('express');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const db = require('./db'); // sql.js 异步初始化
const authRoutes = require('./routes/auth');
const couponRoutes = require('./routes/coupons');
const ocrRoutes = require('./routes/ocr');
const rankingRoutes = require('./routes/rankings');
const { authMiddleware, JWT_SECRET } = require('./middleware/auth');
const jwt = require('jsonwebtoken');

async function main() {
  // 等待数据库初始化（纯 JS SQLite，首次加载 WASM + 建表）
  await db.init();

  // 补全历史券的拼音索引（支持拼音/首字母搜索）
  try { couponRoutes.backfillPinyin(); } catch (e) { console.error('[backfill]', e.message); }

  const app = express();
  app.use(compression()); // gzip 压缩：远程/Tailscale 慢链路上显著减小传输体积
  app.use(express.json());

  const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  app.use('/api/auth', authRoutes);
  app.use('/api/coupons', couponRoutes);
  app.use('/api/ocr', ocrRoutes);
  app.use('/api/rankings', rankingRoutes);

  // 受保护的图片访问（登录后才能看二维码截图；支持 ?token= 以便 <img> 直接加载）
  app.get('/uploads/:file', (req, res) => {
    const token = req.query.token || (req.headers.authorization && req.headers.authorization.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '');
    try {
      jwt.verify(token, JWT_SECRET);
    } catch (e) {
      return res.status(401).end();
    }
    const f = path.join(UPLOAD_DIR, path.basename(req.params.file));
    if (fs.existsSync(f)) {
      res.setHeader('Cache-Control', 'public, max-age=604800'); // 二维码截图缓存 7 天（文件名唯一，不会变）
      res.sendFile(f);
    } else res.status(404).end();
  });

  // 静态前端（带缓存：HTML 不缓存以便更新即时生效，JS/CSS/图片缓存 10 分钟加速重复打开）
  app.use(express.static(path.join(__dirname, '..', 'public'), {
    maxAge: '10m',
    setHeaders: (res, filePath) => {
      if (path.extname(filePath) === '.html') res.setHeader('Cache-Control', 'no-cache');
    }
  }));

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`📦 券库服务已启动: http://localhost:${PORT}`);
  });

  // 关机时保存数据库（防止丢失最近写入的数据）
  ['SIGINT','SIGTERM'].forEach(sig => process.on(sig, () => {
    console.log('\n[shutdown] 正在保存数据…');
    db.save(); process.exit(0);
  }));
}

main().catch(err => {
  console.error('启动失败:', err.message);
  process.exit(1);
});
