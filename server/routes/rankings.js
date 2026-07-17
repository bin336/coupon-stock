const express = require('express');
const router = express.Router();
const db = require('../db');
const { authMiddleware } = require('../middleware/auth');

function todayLocal() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}
const r2 = n => Math.round(n * 100) / 100;

// 数据报表：三大排行（销售业绩 / 囤券地主 / 牛马）
router.get('/', authMiddleware, (req, res) => {
  const today = todayLocal();
  const all = db.prepare('SELECT * FROM coupons').all();

  // ① 销售业绩：按销售人(sold_by_name) 汇总 售出张数 + 结算金额合计（历史无结算金额则退回面值）
  const salesMap = {};
  all.forEach(c => {
    if (c.status !== 'sold' || !c.sold_by_name) return;
    const k = c.sold_by_name;
    const g = salesMap[k] = salesMap[k] || { name: k, count: 0, amount: 0 };
    g.count += 1;
    g.amount += (c.settle_amount != null ? c.settle_amount : (c.amount || 0) * (c.quantity || 1));
  });
  const sales = Object.values(salesMap).sort((a, b) => b.amount - a.amount)
    .map(s => ({ name: s.name, count: s.count, amount: r2(s.amount) }));

  // ② 囤券地主：按所有人(owner_name) 汇总 未过期在售券面值合计 + 在售张数
  const hoardMap = {};
  all.forEach(c => {
    if (c.status !== 'unsold') return;
    if (c.expiry_date && c.expiry_date < today) return; // 已过期不算囤
    const k = c.owner_name || '（未指定）';
    const g = hoardMap[k] = hoardMap[k] || { name: k, value: 0, quantity: 0, count: 0 };
    g.value += (c.amount || 0) * (c.quantity || 1);
    g.quantity += (c.quantity || 1);
    g.count += 1;
  });
  const hoarder = Object.values(hoardMap).sort((a, b) => b.value - a.value)
    .map(h => ({ name: h.name, value: r2(h.value), quantity: h.quantity, count: h.count }));

  // ③ 牛马：按操作人(username) 汇总 操作次数
  const ops = db.prepare('SELECT username, COUNT(*) AS cnt FROM operation_log GROUP BY username ORDER BY cnt DESC').all();
  const workhorse = ops.map(o => ({ name: o.username || '（未知）', count: o.cnt }));

  res.json({ sales, hoarder, workhorse });
});

module.exports = router;
