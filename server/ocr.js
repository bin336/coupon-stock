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

  // ---------- 金额 ----------
  // 多候选收集，避免细价/运费/小字干扰「面值」。优先级：标签(面额/面值/金额) > 数字+元 > ¥数字；同级取较大值。
  // 支持千分位（1,000元）与「元」被误识别为 兀/园/无/亓 的常见情况。
  const amtCandidates = [];
  const pushAmt = (raw, prio) => {
    if (!raw) return;
    const n = parseFloat(String(raw).replace(/,/g, ''));
    if (!isNaN(n) && n > 0) amtCandidates.push({ n, prio });
  };
  let m;
  const labelRe = /(?:代金券面额|面额|面值|金额|券额|总额|价值)[^\d¥￥元]{0,8}?[¥￥]?\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)/g;
  while ((m = labelRe.exec(t))) pushAmt(m[1], 3);
  const yuanRe = /(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s*(?:元|兀|园|无|亓)/g;
  while ((m = yuanRe.exec(t))) pushAmt(m[1], 2);
  const yenRe = /[¥￥]\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)/g;
  while ((m = yenRe.exec(t))) pushAmt(m[1], 1);
  if (amtCandidates.length) {
    amtCandidates.sort((a, b) => b.prio - a.prio || b.n - a.n);
    fields.amount = amtCandidates[0].n;
  }

  // ---------- 券号 ----------
  // ① 带标签（券码/券号/卡号/兑换码/激活码/核销码/提货码/密码/序列号…），标签词容错中文逐字空格。
  //    捕获为「连续」字母数字（不跨空格），并用前瞻在遇到 元/¥/面额/余/价/张/有效期/过期 或文末时停止，
  //    避免把二维码旁那串数字与紧随其后的金额数字（如 "...100元"）误拼在一起；最后再剔除可能并入的末尾金额。
  // ② 兜底：二维码旁多为「一串数字」券码 → 直接在原文取最长的一段纯数字(>=6位)，排除像日期的串、以及紧挨「元」的金额数字。
  // ③ 再兜底：连续字母数字混合串（排除日期/孤立年份）。
  const codeLabeled = /(?:券\s*码|券\s*号|券码|券号|卡\s*号|卡号|兑\s*换\s*码|兑换码|激\s*活\s*码|激活码|核\s*销\s*码|核销码|提\s*货\s*码|提货码|密\s*码|密码|编\s*号|编号|单\s*号|单号|序\s*列\s*号|序列号|口\s*令|口令|NO\.?|No\.?)\s*[:：]?\s*([A-Za-z0-9-]+(?:[ -][A-Za-z0-9-]+)*?)(?=\s*(?:元|¥|面|额|余|价|张|总|有\s*效\s*期|过\s*期)|$)/i;
  let code = null;
  const ml = t.match(codeLabeled);
  if (ml) {
    code = ml[1].replace(/\s/g, '');
    // 安全网：若误并入了末尾的金额数字（如 "...100元" 被并成 "...100"），剔除之
    if (fields.amount != null) {
      const a = String(fields.amount);
      if (code.length > a.length && code.endsWith(a)) code = code.slice(0, code.length - a.length);
    }
  }
  if (!code) {
    const isDateLike = s => /^\d{4}[-/.]?\d{1,2}[-/.]?\d{1,2}$/.test(s) || /^\d{6}$/.test(s);
    const digitRe = /\d{6,}/g;
    const cands = [];
    let dm;
    while ((dm = digitRe.exec(t))) {
      const s = dm[0];
      if (isDateLike(s)) continue;
      const after = t.slice(dm.index + s.length, dm.index + s.length + 2);
      if (/^[元兀园无亓]/.test(after)) continue; // 这是金额数字，不是券码
      cands.push(s);
    }
    cands.sort((a, b) => b.length - a.length);
    if (cands.length) code = cands[0];
  }
  if (!code) {
    const codeFallback = /([A-Za-z0-9-]{4,})/;
    const mf = t.match(codeFallback);
    if (mf) {
      const v = mf[1];
      const bad = /^\d{4}$/.test(v) || /\d{4}[-/]\d{1,2}/.test(v);
      if (!bad) code = v;
    }
  }
  fields.coupon_code = code;

  // ---------- 张数 ----------
  const qPatterns = [
    /(\d+)\s*张/,
    /[×xX*]\s*(\d+)/,
    /(?:共|合计)\s*(\d+)\s*张/
  ];
  for (const p of qPatterns) {
    const m = t.match(p);
    if (m) { fields.quantity = parseInt(m[1], 10); break; }
  }

  // ---------- 过期时间 ----------
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
