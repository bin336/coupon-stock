const Tesseract = require('tesseract.js');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const TESS_CACHE = path.join(DATA_DIR, 'tessdata');
if (!fs.existsSync(TESS_CACHE)) fs.mkdirSync(TESS_CACHE, { recursive: true });

// 把「逐字符带空格」的疑似券号合并：如 "S B 2 0 2 6 - 7 7 8 8" -> "SB2026-7788"
// 仅当整行都由单字符的 ASCII 字母/数字/连字符组成时才合并，避免误伤正常文本
function collapseSpacedCodes(text) {
  return (text || '').split('\n').map(line => {
    const toks = line.trim().split(/\s+/).filter(Boolean);
    if (toks.length >= 5 && toks.every(t => /^[A-Za-z0-9-]$/.test(t))) {
      return toks.join('');
    }
    return line;
  }).join('\n');
}

// 从 OCR 原文中解析出结构化字段（金额 / 券号 / 张数 / 过期时间）
function parseFields(text) {
  const t = text || '';
  const fields = { amount: null, coupon_code: null, quantity: null, expiry_date: null };

  // 代金券金额：优先 ¥数字、数字+元，其次 面值/面额/金额 后紧跟（容忍少量噪声字符）的数字
  const amtPatterns = [
    /[¥￥]\s*(\d+(?:\.\d+)?)/,
    /(\d+(?:\.\d+)?)\s*元/,
    /(?:面额|面值|金额|代金券面额|券额)[^\d]{0,6}?(\d+(?:\.\d+)?)/,
    /(\d+(?:\.\d+)?)\s*(?:元|块)/
  ];
  for (const p of amtPatterns) {
    const m = t.match(p);
    if (m) { fields.amount = parseFloat(m[1]); break; }
  }

  // 券号：券号是 OCR 最易错的字段，且 OCR 常把中文标签逐字拆开（"券 码"）、把数字券号按组拆开（"0285 7178 0658"）。
  // 两层归一化：① collapseSpacedCodes 合并整行单字符；② 去掉夹在字母/数字之间的空格（"0285 7178 0658" -> "028571780658"）。
  // 标签词全部容错中文逐字空格（券\s*码 / 卡\s*号 / 兑\s*换\s*码 …），捕获组把连字符纳入券号本体并容错单字符间隔。
  const norm = collapseSpacedCodes(t).replace(/([A-Za-z0-9])\s+([A-Za-z0-9])/g, '$1$2');
  const codeLabeled = /(?:券\s*码|券\s*号|券码|券号|卡\s*号|卡号|兑\s*换\s*码|兑换码|密\s*码|密码|编\s*号|编号|单\s*号|单号|序\s*列\s*号|序列号|口\s*令|口令|NO\.?|No\.?)\s*[:：]?\s*([A-Za-z0-9-](?:[ -]?[A-Za-z0-9-]){3,})/i;
  const codeFallback = /([A-Za-z0-9-](?:[ -]?[A-Za-z0-9-]){3,})/;
  for (const src of [t, norm]) {
    const m = src.match(codeLabeled);
    if (m) { fields.coupon_code = m[1].replace(/\s/g, ''); break; }
  }
  if (!fields.coupon_code) {
    for (const src of [t, norm]) {
      const m = src.match(codeFallback);
      if (m) { fields.coupon_code = m[1].replace(/\s/g, ''); break; }
    }
    // 兜底结果净化：丢弃像日期（含 / 或 - 的年月日）或孤立 4 位年份的串，避免误把过期时间当券号
    if (fields.coupon_code) {
      const bad = /^\d{4}$/.test(fields.coupon_code) || /\d{4}[-/]\d{1,2}/.test(fields.coupon_code);
      if (bad) fields.coupon_code = null;
    }
  }

  // 张数：数字+张，或 ×数字 / x数字，或 共数字张
  const qPatterns = [
    /(\d+)\s*张/,
    /[×xX*]\s*(\d+)/,
    /(?:共|合计)\s*(\d+)\s*张/
  ];
  for (const p of qPatterns) {
    const m = t.match(p);
    if (m) { fields.quantity = parseInt(m[1], 10); break; }
  }

  // 过期时间：多种日期格式 -> YYYY-MM-DD（带合法性校验）
  const datePatterns = [
    /(\d{4})[-./年](\d{1,2})[-./月](\d{1,2})日?/,
    /(\d{4})年(\d{1,2})月(\d{1,2})日/,
    /有效期至[:：]?\s*(\d{4})[-./](\d{1,2})[-./](\d{1,2})/,
    /过期[:：]?\s*(\d{4})[-./](\d{1,2})[-./](\d{1,2})/
  ];
  for (const p of datePatterns) {
    const m = p.exec(t);
    if (m) {
      const y = +m[1], mo = +m[2], d = +m[3];
      const dt = new Date(y, mo - 1, d);
      if (dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d) {
        fields.expiry_date = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        break;
      }
    }
  }

  return fields;
}

async function recognize(imagePath) {
  // chi_sim+eng：中文 + 英文/数字；traineddata 首次自动下载并缓存到 data/tessdata
  const worker = await Tesseract.createWorker('chi_sim+eng', 1, { cachePath: TESS_CACHE });
  // 超时保护：损坏图片可能让底层原生 Abort 且不在 Promise 链内（unhandled），
  // 用超时兜底让请求一定能在阈值内以「识别失败」优雅结束，而非卡死。
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('OCR 处理超时（图片可能已损坏）')), 20000);
  });
  try {
    const pending = worker.recognize(imagePath);
    const { data } = await Promise.race([pending, timeout]);
    const raw = (data.text || '').replace(/\r/g, '').trim();
    return { raw, fields: parseFields(raw) };
  } finally {
    clearTimeout(timer);
    try { await worker.terminate(); } catch (_) {}
  }
}

module.exports = { recognize, parseFields };
