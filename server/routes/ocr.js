const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { authMiddleware } = require('../middleware/auth');
const { recognize } = require('../ocr');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, 'ocr-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + path.extname(file.originalname || ''))
  }),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// 接收截图 -> 返回识别原文 + 解析字段；失败也优雅返回，绝不阻塞录入
router.post('/', authMiddleware, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传图片' });
  try {
    const result = await recognize(req.file.path);
    res.json(result);
  } catch (e) {
    console.error('[OCR] 识别失败:', e.message);
    res.json({ raw: '', fields: {}, error: '识别失败，请手动填写' });
  } finally {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
  }
});

module.exports = router;
