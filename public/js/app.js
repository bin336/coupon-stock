/* ===================== 券库 前端 ===================== */
const $app = document.getElementById('app');
const $modal = document.getElementById('modal-root');
const $toast = document.getElementById('toast');

const state = {
  token: localStorage.getItem('cs_token') || null,
  user: JSON.parse(localStorage.getItem('cs_user') || 'null'),
  scope: 'default',   // default | all | sold | expired
  settlement: false,  // 是否处于结算模块视图
  settlementView: 'mine',  // mine(我的) | all(全部)
  report: false,      // 是否处于售出/利润报表视图
  logs: false,        // 是否处于操作日志视图
  rankings: false,    // 是否处于数据报表（三大排行）视图
  q: '',
  coupons: [],
  stats: {},
  users: [],
  reportFilters: { owner: '', start: '', end: '' },
  logFilters: { action: '', user: '', q: '', start: '', end: '' }
};

/* ---------- 工具 ---------- */
function todayLocal() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}
function fmtMoney(n) {
  n = Number(n) || 0;
  return '¥' + (Math.round(n * 100) / 100).toLocaleString('zh-CN');
}
function escapeHtml(s) {
  return (s == null ? '' : String(s))
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function toast(msg) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => $toast.classList.remove('show'), 2200);
}
async function api(method, path, body, isForm) {
  const headers = { Authorization: 'Bearer ' + state.token };
  let payload;
  if (isForm) {
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch('/api' + path, { method, headers, body: payload });
  if (res.status === 401) { logout(); throw new Error('登录已失效'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}
function uploadUrl(file) {
  return '/uploads/' + encodeURIComponent(file) + '?token=' + encodeURIComponent(state.token);
}

/* ---------- 登录 / 登出 ---------- */
function logout() {
  localStorage.removeItem('cs_token');
  localStorage.removeItem('cs_user');
  state.token = null; state.user = null;
  render();
}
function renderLogin() {
  $app.innerHTML = `
  <div class="login-wrap">
    <div class="login-card">
      <div class="login-logo">
        <div class="mark">券</div>
        <h1>券库</h1>
        <p>囤券卖券 · 库存管理</p>
      </div>
      <form id="login-form">
        <div class="field">
          <label>账号</label>
          <input name="username" autocomplete="username" placeholder="请输入账号" required />
        </div>
        <div class="field">
          <label>密码</label>
          <input name="password" type="password" autocomplete="current-password" placeholder="请输入密码" required />
        </div>
        <button class="btn primary block" type="submit">登 录</button>
      </form>
    </div>
  </div>`;
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const data = await api('POST', '/auth/login', {
        username: f.username.value.trim(),
        password: f.password.value
      });
      state.token = data.token;
      state.user = data.user;
      localStorage.setItem('cs_token', data.token);
      localStorage.setItem('cs_user', JSON.stringify(data.user));
      toast('登录成功');
      render();
    } catch (err) {
      toast(err.message || '登录失败');
    }
  });
}

/* ---------- 主界面 ---------- */
function buildQuery() {
  const p = new URLSearchParams();
  if (state.scope === 'default') { p.set('status', 'unsold'); p.set('expired', '0'); }
  else if (state.scope === 'sold') { p.set('status', 'sold'); }
  else if (state.scope === 'expired') { p.set('status', 'unsold'); p.set('expired', '1'); }
  if (state.q.trim()) p.set('q', state.q.trim());
  return p.toString();
}
async function loadData() {
  const [list, stats] = await Promise.all([
    api('GET', '/coupons?' + buildQuery()),
    api('GET', '/coupons/stats')
  ]);
  state.coupons = list.coupons;
  state.stats = stats;
  renderStats();
  if (state.settlement) {
    renderSettlement(state.coupons.filter(c => c.status === 'sold' && !c.settled));
  } else {
    renderList();
  }
}
async function loadUsers() {
  if (state.user.role !== 'admin') return;
  const data = await api('GET', '/auth/users');
  state.users = data.users;
}

function render() {
  if (!state.token || !state.user) { renderLogin(); return; }
  renderApp();
  if (state.report) { loadReport(); }
  else if (state.logs) { loadLogs(); }
  else if (state.rankings) { loadRankings(); }
  else { loadData(); loadUsers(); }
}

function renderApp() {
  const s = state.stats;
  $app.innerHTML = `
  <div class="topbar">
    <div class="title">券库</div>
      <div class="user">
        <div class="avatar">${escapeHtml((state.user.display_name || '?').slice(0,1))}</div>
        <span>${escapeHtml(state.user.display_name)}</span>
        <button class="icon" id="btn-settings" style="display:${state.user.role==='admin'?'inline-block':'none'}">设置</button>
        <button class="icon" id="btn-logout">退出</button>
      </div>
  </div>

  <div class="stats">
    <div class="stat">
      <div class="label">未售 · 未过期</div>
      <div class="value">${s.unsold_unexpired || 0}</div>
      <div class="sub">张可售券 · 成本 ${fmtMoney(s.cost)}</div>
    </div>
    <div class="stat" id="stat-pending" style="cursor:pointer">
      <div class="label">已售 · 待结算</div>
      <div class="value">${s.sold_unsettled || 0}</div>
      <div class="sub">张未结算 · 点此看报表</div>
    </div>
    <div class="stat alert">
      <div class="label">7天内到期</div>
      <div class="value">${s.expiring_soon || 0}</div>
      <div class="sub">需尽快售出</div>
    </div>
    <div class="stat clickable" id="stat-sold" style="cursor:pointer">
      <div class="label">至今我们已售出</div>
      <div class="value">${s.sold || 0} <small>张</small></div>
      <div class="sub">面值 ${fmtMoney(s.sold_face_value)} · 点此看报表</div>
    </div>
  </div>

  ${getToolbar()}

  <div class="list" id="list"></div>

  <nav class="bottom-nav" id="bottom-nav">
    <button class="nav-item" data-nav="home"><span class="nav-ico">🏠</span><span>首页</span></button>
    <button class="nav-item" data-nav="report"><span class="nav-ico">📋</span><span>报表</span></button>
    <button class="nav-item" data-nav="rankings"><span class="nav-ico">📊</span><span>数据</span></button>
    <button class="nav-item" data-nav="settlement"><span class="nav-ico">💰</span><span>结算</span></button>
    <button class="nav-item" data-nav="logs"><span class="nav-ico">📜</span><span>日志</span></button>
  </nav>

  ${state.report || state.logs || state.settlement || state.rankings ? '' : `
  <div class="fab-backdrop" id="fab-backdrop" style="display:none"></div>
  <div class="fab-menu" id="fab-menu" style="display:none">
    <button class="fab-item" id="fab-batch">批量录入</button>
    <button class="fab-item" id="fab-single">快速入库</button>
  </div>
  <button class="fab" id="fab">+</button>`}`;

  document.getElementById('btn-logout').onclick = logout;
  const bs = document.getElementById('btn-settings');
  if (bs) bs.onclick = openSettings;

  // 统计卡片与底部导航在所有视图（含子页面）都保持可点击/可切换
  bindStatCards();
  bindBottomNav();

  // 报表 / 日志 / 结算 / 排行 视图：工具栏与列表独立渲染，不再绑定默认搜索/筛选
  if (state.report) { bindReportToolbar(); loadReport(); return; }
  if (state.logs) { bindLogToolbar(); loadLogs(); return; }
  if (state.settlement) {
    bindSettlementToolbar();
    return;
  }
  if (state.rankings) {
    bindRankingsToolbar();
    return;
  }

  const search = document.getElementById('search');
  let st;
  search.addEventListener('input', (e) => {
    clearTimeout(st);
    st = setTimeout(() => {
      state.q = e.target.value;
      const q = state.q.trim();
      if (q.length >= 1) { api('POST', '/coupons/search-log', { term: q }).catch(() => {}); }
      loadData();
    }, 250);
  });

  document.getElementById('chips').addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (!c) return;
    state.scope = c.dataset.scope;
    document.querySelectorAll('#chips .chip').forEach(x => x.classList.toggle('active', x === c));
    loadData();
  });

  const fab = document.getElementById('fab');
  const fabMenu = document.getElementById('fab-menu');
  const fabBack = document.getElementById('fab-backdrop');
  function closeFab() {
    if (fabMenu) fabMenu.style.display = 'none';
    if (fabBack) fabBack.style.display = 'none';
    if (fab) fab.classList.remove('open');
  }
  if (fab) {
    fab.onclick = (e) => {
      e.stopPropagation();
      const open = fabMenu && fabMenu.style.display === 'flex';
      if (open) { closeFab(); return; }
      if (fabMenu) fabMenu.style.display = 'flex';
      if (fabBack) fabBack.style.display = 'block';
      fab.classList.add('open');
    };
    const fSingle = document.getElementById('fab-single');
    const fBatch = document.getElementById('fab-batch');
    if (fSingle) fSingle.onclick = () => { closeFab(); openCouponModal(); };
    if (fBatch) fBatch.onclick = () => { closeFab(); openBatchModal(); };
    if (fabBack) fabBack.onclick = closeFab;
  }

  renderList();
  renderRecentSearches();
}

/* ---------- 统计卡片：跨页面常驻可点击 ---------- */
function bindStatCards() {
  const statPending = document.getElementById('stat-pending');
  if (statPending) statPending.onclick = openReport;
  const statSold = document.getElementById('stat-sold');
  if (statSold) statSold.onclick = openRankings;
}

/* ---------- 底部导航：跨页面一键切换 ---------- */
function activeNav() {
  if (state.rankings) return 'rankings';
  if (state.report) return 'report';
  if (state.settlement) return 'settlement';
  if (state.logs) return 'logs';
  return 'home';
}
function bindBottomNav() {
  const nav = document.getElementById('bottom-nav');
  if (!nav) return;
  nav.querySelectorAll('.nav-item').forEach(b => {
    b.onclick = () => {
      const v = b.dataset.nav;
      if (v === 'home') goHome();
      else if (v === 'report') openReport();
      else if (v === 'rankings') openRankings();
      else if (v === 'settlement') openSettlement();
      else if (v === 'logs') openLogs();
    };
  });
  nav.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.nav === activeNav()));
}
async function goHome() {
  state.report = false; state.logs = false; state.settlement = false; state.rankings = false;
  state.scope = 'default'; state.q = '';
  renderApp(); loadData(); loadUsers();
}

/* ---------- 工具栏（按当前视图切换） ---------- */
function getToolbar() {
  if (state.rankings) {
    return `<div class="toolbar">
      <button class="btn ghost" id="btn-back">← 返回</button>
      <div class="tb-title">📊 数据报表</div>
    </div>`;
  }
  if (state.settlement) {
    const v = state.settlementView;
    return `<div class="toolbar" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <button class="btn ghost" id="btn-back">← 返回</button>
      <div class="seg">
        <button class="btn ghost seg-btn ${v === 'mine' ? 'active' : ''}" id="sv-mine">我的</button>
        <button class="btn ghost seg-btn ${v === 'all' ? 'active' : ''}" id="sv-all">全部</button>
      </div>
    </div>`;
  }
  if (state.report) {
    const f = state.reportFilters;
    return `<div class="toolbar report-toolbar">
      <button class="btn ghost" id="btn-back">← 返回</button>
      <button class="btn ghost" id="rf-settle">结算</button>
      ${ownerSelect({ id: 'rf-owner', selected: f.owner, cls: 'search', emptyLabel: '所有人（全部）' })}
      <div class="dt-group">
        <input type="date" class="dt" id="rf-start" value="${escapeHtml(f.start)}" />
        <span class="dt-sep">至</span>
        <input type="date" class="dt" id="rf-end" value="${escapeHtml(f.end)}" />
      </div>
      <button class="btn primary" id="rf-go">查询</button>
    </div>`;
  }
  if (state.logs) {
    const f = state.logFilters;
    const actions = [['','全部'],['login','登录'],['add_coupon','新增券'],['batch_add','批量入库'],['edit_coupon','编辑券'],['delete_coupon','删除券'],['mark_sold','标记售出'],['unmark_sold','取消售出'],['settle','标记结算'],['unsettle','取消结算'],['add_user','新增用户'],['delete_user','删除用户'],['reset_password','修改密码']];
    return `<div class="toolbar log-toolbar">
      <button class="btn ghost" id="btn-back">← 返回</button>
      <select class="search" id="lf-action">${actions.map(a=>`<option value="${a[0]}" ${f.action===a[0]?'selected':''}>${a[1]}</option>`).join('')}</select>
      <input class="search" id="lf-user" placeholder="操作人" value="${escapeHtml(f.user)}" />
      <input class="search" id="lf-q" placeholder="关键词" value="${escapeHtml(f.q)}" />
      <div class="dt-group">
        <input type="date" class="dt" id="lf-start" value="${escapeHtml(f.start)}" />
        <span class="dt-sep">至</span>
        <input type="date" class="dt" id="lf-end" value="${escapeHtml(f.end)}" />
      </div>
      <button class="btn primary" id="lf-go">查询</button>
    </div>`;
  }
  return `<div class="toolbar">
    <input class="search" id="search" placeholder="搜商家 / 券号 / 所有人（支持拼音、首字母）" value="${escapeHtml(state.q)}" />
    <div class="recent" id="recent-searches"></div>
    <div class="chips" id="chips">
      <div class="chip ${state.scope==='default'?'active':''}" data-scope="default">未售·未过期</div>
      <div class="chip ${state.scope==='all'?'active':''}" data-scope="all">全部</div>
      <div class="chip ${state.scope==='sold'?'active':''}" data-scope="sold">已售</div>
      <div class="chip ${state.scope==='expired'?'active':''}" data-scope="expired">已过期</div>
    </div>
  </div>`;
}

/* ---------- 售出 / 利润报表 ---------- */
async function openReport() {
  state.report = true; state.rankings = false; state.logs = false; state.settlement = false; state.scope = 'default';
  renderApp(); await loadReport();
}
function bindReportToolbar() {
  const back = document.getElementById('btn-back');
  if (back) back.onclick = () => { state.report = false; renderApp(); loadData(); loadUsers(); };
  const settle = document.getElementById('rf-settle');
  if (settle) settle.onclick = openSettlement;
  const go = document.getElementById('rf-go');
  if (go) go.onclick = async () => {
    state.reportFilters.owner = document.getElementById('rf-owner').value.trim();
    state.reportFilters.start = document.getElementById('rf-start').value;
    state.reportFilters.end = document.getElementById('rf-end').value;
    await loadReport();
  };
}
async function loadReport() {
  const f = state.reportFilters;
  const p = new URLSearchParams();
  if (f.owner) p.set('owner', f.owner);
  if (f.start) p.set('start', f.start);
  if (f.end) p.set('end', f.end);
  try {
    const data = await api('GET', '/coupons/report?' + p.toString());
    renderReport(data);
  } catch (e) { toast(e.message); }
}
function renderReport(data) {
  const list = document.getElementById('list');
  if (!list) return;
  const rows = data.rows || [];
  const t = data.totals || {};
  if (!rows.length) { list.innerHTML = `<div class="empty">没有符合条件的已售记录</div>`; return; }
  const rHtml = r => `<tr>
    <td>${escapeHtml(r.owner)}</td>
    <td>${r.qty}</td>
    <td>${fmtMoney(r.face_value)}</td>
    <td>${fmtMoney(r.cost)}</td>
    <td class="sm">${r.settled_count}<br/><small>${fmtMoney(r.settled_amount)}</small></td>
    <td class="sm">${r.unsettled_count}<br/><small>${fmtMoney(r.pending_amount)}</small></td>
    <td class="strong">${fmtMoney(r.total_amount)}</td>
  </tr>`;
  list.innerHTML = `
  <div class="report-wrap">
    <div class="report-summary">
      <div><span>总售出</span><b>${t.qty||0} 张</b></div>
      <div><span>已结算金额</span><b class="pos">${fmtMoney(t.settled_amount)}</b></div>
      <div><span>待结算金额</span><b class="pos">${fmtMoney(t.pending_amount)}</b></div>
      <div><span>结算合计</span><b class="pos">${fmtMoney(t.total_amount)}</b></div>
    </div>
    <div class="table-scroll">
      <table class="data-table">
        <thead><tr>
          <th>所有人</th><th>售出(张)</th><th>面值合计</th><th>成本合计</th>
          <th>已结算<br/>(张/金额)</th><th>待结算<br/>(张/金额)</th><th>结算合计</th>
        </tr></thead>
        <tbody>
          ${rows.map(rHtml).join('')}
          <tr class="total-row">
            <td>合计</td>
            <td>${t.qty||0}</td>
            <td>${fmtMoney(t.face_value)}</td>
            <td>${fmtMoney(t.cost)}</td>
            <td class="sm">${t.settled_count||0}<br/><small>${fmtMoney(t.settled_amount)}</small></td>
            <td class="sm">${t.unsettled_count||0}<br/><small>${fmtMoney(t.pending_amount)}</small></td>
            <td class="strong pos">${fmtMoney(t.total_amount)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>`;
}

/* ---------- 数据报表（三大排行） ---------- */
async function openRankings() {
  state.rankings = true; state.report = false; state.logs = false; state.settlement = false; state.scope = 'default';
  renderApp(); await loadRankings();
}
function bindRankingsToolbar() {
  const back = document.getElementById('btn-back');
  if (back) back.onclick = () => { state.rankings = false; renderApp(); loadData(); loadUsers(); };
}
async function loadRankings() {
  try {
    const data = await api('GET', '/rankings');
    renderRankings(data);
  } catch (e) { toast(e.message); }
}

// 纯 CSS 横向条形图：items 已按值降序，返回每行 HTML（无第三方依赖，离线可用）
function barRows(items, getValue, format, subFn) {
  if (!items || !items.length) return '<div class="empty">暂无数据</div>';
  const max = Math.max(...items.map(getValue));
  if (max <= 0) return '<div class="empty">暂无数据</div>';
  return items.map((it, i) => {
    const v = getValue(it);
    const pct = Math.max(3, Math.round(v / max * 100));
    const sub = subFn ? `<span class="rank-sub">${subFn(it)}</span>` : '';
    const noCls = i < 3 ? 'rank-' + (i + 1) : 'rank-n';
    return `<div class="rank-row">
      <div class="rank-no ${noCls}">${i + 1}</div>
      <div class="rank-body">
        <div class="rank-top"><span class="rank-name">${escapeHtml(it.name)} ${sub}</span><span class="rank-val">${format(v)}</span></div>
        <div class="rank-bar"><div class="rank-fill" style="width:${pct}%"></div></div>
      </div>
    </div>`;
  }).join('');
}

function renderRankings(data) {
  const list = document.getElementById('list');
  if (!list) return;
  const d = data || {};
  const money = v => fmtMoney(v);
  const sales = (d.sales || []).map(s => ({ name: s.name, v: s.amount, count: s.count }));
  const hoard = (d.hoarder || []).map(h => ({ name: h.name, v: h.value, qty: h.quantity, count: h.count }));
  const work = (d.workhorse || []).map(w => ({ name: w.name, v: w.count }));
  list.innerHTML = `
    <div class="rank-wrap">
      <div class="rank-card">
        <div class="rank-head">🏆 销售业绩排行 <small>按售出结算金额</small></div>
        ${barRows(sales, it => it.v, money, it => `售出 ${it.count} 张`)}
      </div>
      <div class="rank-card">
        <div class="rank-head">🏠 囤券地主排行 <small>按未过期在售券面值</small></div>
        ${barRows(hoard, it => it.v, money, it => `${it.qty} 张在售`)}
      </div>
      <div class="rank-card">
        <div class="rank-head">🐎 牛马排行 <small>按操作次数</small></div>
        ${barRows(work, it => it.v, v => v + ' 次', null)}
      </div>
    </div>`;
}

/* ---------- 设置（汇总 日志 / 用户管理 入口） ---------- */
function openSettings() {
  $modal.innerHTML = `
  <div class="modal-mask" data-close="1">
    <div class="modal" onclick="event.stopPropagation()">
      <h3>设置</h3>
      <div class="settings-menu">
        <button class="settings-item" id="set-logs">
          <span class="si-ico">📋</span>
          <span class="si-text"><b>操作日志</b><small>查看全部操作留痕</small></span>
        </button>
        <button class="settings-item" id="set-users">
          <span class="si-ico">👥</span>
          <span class="si-text"><b>用户管理</b><small>账号、角色与密码</small></span>
        </button>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn ghost" data-close="1">关闭</button>
      </div>
    </div>
  </div>`;
  document.getElementById('set-logs').onclick = () => { closeModal(); openLogs(); };
  document.getElementById('set-users').onclick = () => { closeModal(); openUserModal(); };
  bindClose();
}

/* ---------- 操作日志 ---------- */
async function openLogs() {
  state.logs = true; state.report = false; state.rankings = false; state.settlement = false;
  renderApp(); await loadLogs();
}
function bindLogToolbar() {
  const back = document.getElementById('btn-back');
  if (back) back.onclick = () => { state.logs = false; renderApp(); loadData(); loadUsers(); };
  const go = document.getElementById('lf-go');
  if (go) go.onclick = async () => {
    state.logFilters.action = document.getElementById('lf-action').value;
    state.logFilters.user = document.getElementById('lf-user').value.trim();
    state.logFilters.q = document.getElementById('lf-q').value.trim();
    state.logFilters.start = document.getElementById('lf-start').value;
    state.logFilters.end = document.getElementById('lf-end').value;
    await loadLogs();
  };
}
async function loadLogs() {
  const f = state.logFilters;
  const p = new URLSearchParams();
  if (f.action) p.set('action', f.action);
  if (f.user) p.set('user', f.user);
  if (f.q) p.set('q', f.q);
  if (f.start) p.set('start', f.start);
  if (f.end) p.set('end', f.end);
  try {
    const data = await api('GET', '/coupons/logs?' + p.toString());
    renderLogs(data);
  } catch (e) { toast(e.message); }
}
const ACTION_LABELS = {
  login:'登录', add_coupon:'新增券', batch_add:'批量入库', edit_coupon:'编辑券',
  delete_coupon:'删除券', mark_sold:'标记售出', unmark_sold:'取消售出',
  settle:'标记结算', unsettle:'取消结算', add_user:'新增用户',
  delete_user:'删除用户', reset_password:'修改密码'
};
function renderLogs(data) {
  const list = document.getElementById('list');
  if (!list) return;
  const logs = data.logs || [];
  if (!logs.length) { list.innerHTML = `<div class="empty">暂无操作记录</div>`; return; }
  list.innerHTML = `
  <div class="report-wrap">
    <div class="table-scroll">
      <table class="data-table log-table">
        <thead><tr><th>时间</th><th>操作人</th><th>操作</th><th>对象</th><th>详情</th></tr></thead>
        <tbody>
          ${logs.map(l => `<tr>
            <td class="nowrap">${escapeHtml(l.created_at)}</td>
            <td>${escapeHtml(l.username || '—')}</td>
            <td><span class="tag tag-${escapeHtml(l.action)}">${ACTION_LABELS[l.action]||l.action}</span></td>
            <td>${escapeHtml(l.target || '—')}</td>
            <td>${escapeHtml(l.detail || '—')}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
  </div>`;
}

/* ---------- 近期搜索（服务端共享：所有用户搜索频次最高的词，点击即搜） ---------- */
async function renderRecentSearches() {
  const box = document.getElementById('recent-searches');
  if (!box) return;
  let terms = [];
  try {
    const data = await api('GET', '/coupons/recent-searches');
    terms = data.terms || [];
  } catch (e) { terms = []; }
  if (!terms.length) { box.innerHTML = ''; return; }
  box.innerHTML =
    `<span class="recent-label">大家都在搜</span>` +
    terms.map(t => `<span class="recent-tag" data-term="${escapeHtml(t)}">${escapeHtml(t)}</span>`).join('');
  box.querySelectorAll('.recent-tag').forEach(el => el.onclick = () => {
    const term = el.dataset.term;
    const s = document.getElementById('search');
    if (s) s.value = term;
    state.q = term;
    loadData();
  });
}

/* ---------- 统计区独立刷新（避免重绘整个 App） ---------- */
function renderStats() {
  const s = state.stats;
  const els = [
    { sel: '.stat:nth-child(1) .value', val: s.unsold_unexpired || 0, sub: '.stat:nth-child(1) .sub', subText: '张可售券 · 成本 ' + fmtMoney(s.cost || 0) },
    { sel: '.stat:nth-child(2) .value', val: s.sold_unsettled || 0, sub: '.stat:nth-child(2) .sub', subText: '张未结算' },
    { sel: '.stat:nth-child(3) .value', val: s.expiring_soon || 0, sub: '.stat:nth-child(3) .sub', subText: '需尽快售出' },
    { sel: '.stat:nth-child(4) .value', val: s.sold || 0, sub: '.stat:nth-child(4) .sub', subText: '面值 ' + fmtMoney(s.sold_face_value || 0) + ' · 点此看报表' }
  ];
  const container = document.querySelector('.stats');
  if (!container) return;
  els.forEach(e => {
    const el = container.querySelector(e.sel);
    if (el) el.textContent = e.val;
    if (e.sub) { const sub = container.querySelector(e.sub); if (sub) sub.textContent = e.subText; }
  });
}

function renderList() {
  const list = document.getElementById('list');
  if (!list) return;
  if (!state.coupons.length) {
    list.innerHTML = `<div class="empty">这里还没有券～<br/>点右下角 + 快速入库吧</div>`;
    return;
  }

  // 已售页面：按「结算」子状态分组（未结算优先排上方；已结算灰化沉到下方）
  if (state.scope === 'sold') {
    const unsettled = state.coupons.filter(c => !c.settled);
    const settled = state.coupons.filter(c => c.settled);
    list.innerHTML =
      groupHead('未结算', unsettled.length, '待回款') +
      (unsettled.length ? unsettled.map(c => couponCard(c, true)).join('') : `<div class="empty small">暂无未结算券</div>`) +
      groupHead('已结算', settled.length, '已回款') +
      (settled.length ? settled.map(c => couponCard(c, true)).join('') : `<div class="empty small">暂无已结算券</div>`);
    bindListEvents();
    return;
  }

  list.innerHTML = state.coupons.map(c => couponCard(c, false)).join('');
  bindListEvents();
}

function groupHead(title, count, sub) {
  return `<div class="group-head">
    <span class="gh-title">${escapeHtml(title)}</span>
    <span class="gh-count">${count}</span>
    ${sub ? `<span class="gh-sub">${escapeHtml(sub)}</span>` : ''}
  </div>`;
}

function couponCard(c, isSoldScope) {
  const today = todayLocal();
  const expired = c.expiry_date && c.expiry_date < today;
  const img = c.image_filename
    ? `<div class="thumb-wrap">
         <img class="thumb" src="${uploadUrl(c.image_filename)}" data-img="${escapeHtml(c.image_filename)}" />
         <button class="thumb-save" data-save="${escapeHtml(c.image_filename)}" data-name="${escapeHtml((c.merchant || 'coupon') + (c.coupon_code ? '_' + c.coupon_code : ''))}">↓ 存图</button>
       </div>`
    : `<div class="thumb" style="display:flex;align-items:center;justify-content:center;color:#ccc;font-size:11px">无图</div>`;
  const expClass = expired ? 'exp over' : 'exp';
  const expText = c.expiry_date ? (expired ? '已过期 ' + c.expiry_date : c.expiry_date) : '无期限';
  const sold = c.status === 'sold';
  const settled = !!c.settled;
  const isAdmin = state.user && state.user.role === 'admin';
  const isOwner = c.owner_user_id != null && state.user && c.owner_user_id === state.user.id;
  const canManage = isAdmin || isOwner;
  const cls = ['coupon'];
  if (expired) cls.push('expired');
  if (settled) cls.push('settled');
  // 权限：标记/取消售出、标记/取消结算 仅管理员；删除/编辑 仅自己或管理员
  let actions = '';
  if (isAdmin) {
    actions += `<button class="btn ${sold ? 'ghost' : 'primary'}" data-act="toggle" data-id="${c.id}">${sold ? '↩ 取消售出' : '✓ 标记售出'}</button>`;
  }
  if (isSoldScope && isAdmin) {
    actions += `<button class="btn ${settled ? 'ghost' : 'primary'}" data-act="settle" data-id="${c.id}">${settled ? '✓ 已结算' : '标记结算'}</button>`;
  }
  if (!isSoldScope) {
    actions += `<button class="btn ghost" data-act="share" data-id="${c.id}">分享</button>`;
    if (canManage) actions += `<button class="btn ghost" data-act="edit" data-id="${c.id}">编辑</button>`;
  }
  if (canManage) actions += `<button class="btn danger" data-act="del" data-id="${c.id}">删除</button>`;
  return `
  <div class="${cls.join(' ')}">
    <div class="row1">
      <div class="merchant">${escapeHtml(c.merchant)}</div>
      <div class="badge ${sold ? 'sold' : 'unsold'}">${sold ? '已售' : '在售'}</div>
    </div>
    <div class="body2">
      ${img}
      <div class="grid" style="flex:1">
        <div><span class="k">面值</span> <span class="v amount">${fmtMoney(c.amount)}</span> <span class="k">×${c.quantity || 1}张</span></div>
        <div><span class="k">券号</span> <span class="v" ${c.coupon_code ? `title="${escapeHtml(c.coupon_code)}"` : ''}>${escapeHtml(c.coupon_code ? (c.coupon_code.length > 4 ? '…' + c.coupon_code.slice(-4) : c.coupon_code) : '—')}</span></div>
        <div><span class="k">过期</span> <span class="${expClass}">${escapeHtml(expText)}</span></div>
        <div><span class="k">成本</span> <span class="v">${fmtMoney(c.cost)}</span></div>
        <div><span class="k">所有人</span> <span class="v">${escapeHtml(c.owner_name)}</span></div>
        ${c.platform ? `<div><span class="k">平台</span> <span class="v">${escapeHtml(c.platform)}</span></div>` : ''}
      </div>
    </div>
    ${c.note ? `<div class="note">备注：${escapeHtml(c.note)}</div>` : ''}
    <div class="actions">${actions}</div>
  </div>`;
}

function bindListEvents() {
  const list = document.getElementById('list');
  if (!list) return;
  list.querySelectorAll('[data-act]').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      const act = btn.dataset.act;
      if (act === 'toggle') {
        const c = state.coupons.find(x => x.id == id);
        if (!c) return;
        if (c.status === 'sold') {
          // 取消售出：直接调用
          try { await api('POST', '/coupons/' + id + '/sold'); toast('已取消售出'); loadData(); }
          catch (e) { toast(e.message); }
        } else {
          // 标记售出：弹框填售出价
          openSoldModal(c);
        }
      } else if (act === 'settle') {
        const c = state.coupons.find(x => x.id == id);
        if (!c) return;
        if (c.settled) {
          try { await api('POST', '/coupons/' + id + '/settle'); toast('已取消结算'); loadData(); }
          catch (e) { toast(e.message); }
        } else {
          openSettleModal(c);
        }
      } else if (act === 'edit') {
        const c = state.coupons.find(x => x.id == id);
        if (c) openCouponModal(c);
      } else if (act === 'share') {
        const c = state.coupons.find(x => x.id == id);
        if (c) shareToXianyu(c.image_filename, c);
      } else if (act === 'del') {
        if (!confirm('确定删除这张券？此操作不可恢复。')) return;
        try { await api('DELETE', '/coupons/' + id); toast('已删除'); loadData(); }
        catch (e) { toast(e.message); }
      }
    };
  });
  list.querySelectorAll('[data-img]').forEach(im => {
    im.onclick = () => openImageViewer(im.getAttribute('data-img'));
  });
  list.querySelectorAll('[data-save]').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      saveImage(btn.getAttribute('data-save'), btn.getAttribute('data-name'));
    };
  });
}

/* ---------- 结算模块 ---------- */
async function openSettlement() {
  state.report = false; state.logs = false; state.rankings = false;
  state.scope = 'sold';
  state.q = '';
  state.settlement = true;
  state.settlementView = 'mine';
  renderApp();
  loadData();
}
function bindSettlementToolbar() {
  const back = document.getElementById('btn-back');
  if (back) back.onclick = () => { state.settlement = false; state.scope = 'default'; renderApp(); loadData(); };
  const mine = document.getElementById('sv-mine');
  const all = document.getElementById('sv-all');
  if (mine) mine.onclick = () => { state.settlementView = 'mine'; renderApp(); loadData(); };
  if (all) all.onclick = () => { state.settlementView = 'all'; renderApp(); loadData(); };
}
// 单张券的结算明细行（显示商家/券号/方向/金额，可点「结算」）
function settleItemLine(c) {
  const amt = fmtMoney(parseFloat(c.settle_amount) || 0);
  const code = c.coupon_code ? ` · ${escapeHtml(c.coupon_code)}` : '';
  const dir = (c.sold_by_name ? `销售人 ${escapeHtml(c.sold_by_name)} → 所有人 ${escapeHtml(c.owner_name)}` : `所有人 ${escapeHtml(c.owner_name)}`);
  return `<div class="settle-item">
    <div class="si-main"><b>${escapeHtml(c.merchant)}</b>${code}</div>
    <div class="si-sub">${dir}</div>
    <div class="si-right">
      <div class="si-amt">${amt}</div>
      ${state.user && state.user.role === 'admin' ? `<button class="btn tiny" data-act="settle" data-id="${c.id}">结算</button>` : ''}
    </div>
  </div>`;
}

// 按某个字段分组渲染（key: 'owner_name' 收款方 / 'sold_by_name' 付款方）
function settleGroupHtml(coupons, key, fallback) {
  const groups = {};
  coupons.forEach(c => {
    const k = (c[key] || fallback) + '';
    (groups[k] = groups[k] || []).push(c);
  });
  return Object.keys(groups).map(k => {
    const cs = groups[k];
    const total = cs.reduce((s, c) => s + (parseFloat(c.settle_amount) || 0), 0);
    return `<div class="settle-group">
      <div class="sg-head"><span class="sg-name">${escapeHtml(k)}</span><span class="sg-meta">${cs.length} 张 · 合计 ${fmtMoney(total)}</span></div>
      <div class="sg-items">${cs.map(settleItemLine).join('')}</div>
    </div>`;
  }).join('');
}

// 视图A：我的（个性化双视角）
function renderSettleMine(pending) {
  const me = (state.user && (state.user.display_name || state.user.username)) || '';
  const iSold = pending.filter(c => (c.sold_by_name || '') === me);
  const iOwn = pending.filter(c => (c.owner_name || '') === me);
  let html = '';
  if (iSold.length) {
    html += `<div class="settle-sec-title">我需结算给别人的 <span class="badge-pay">付</span></div>`;
    html += `<div class="settle-sub">按收款方（所有人）分组</div>`;
    html += settleGroupHtml(iSold, 'owner_name', '（未指定所有人）');
  }
  if (iOwn.length) {
    html += `<div class="settle-sec-title">别人需结算给我的 <span class="badge-rec">收</span></div>`;
    html += `<div class="settle-sub">按付款方（销售人）分组</div>`;
    html += settleGroupHtml(iOwn, 'sold_by_name', '（未记录销售人）');
  }
  if (!iSold.length && !iOwn.length) {
    html += `<div class="empty">当前账号（${escapeHtml(me)}）没有待结算记录</div>`;
  }
  return html;
}

// 视图B：全部（以人为标签，分别显示需结算金额 / 待别人结算金额）
function renderSettleAll(pending) {
  const persons = {};
  const person = n => persons[n] = persons[n] || { pay: 0, payCount: 0, rec: 0, recCount: 0, payList: [], recList: [] };
  pending.forEach(c => {
    const seller = c.sold_by_name || '（未记录销售人）';
    const owner = c.owner_name || '（未指定所有人）';
    person(seller).pay += (parseFloat(c.settle_amount) || 0); person(seller).payCount++; person(seller).payList.push(c);
    person(owner).rec += (parseFloat(c.settle_amount) || 0); person(owner).recCount++; person(owner).recList.push(c);
  });
  const names = Object.keys(persons);
  if (!names.length) return `<div class="empty">没有待结算的券</div>`;
  return names.map(name => {
    const p = persons[name];
    return `<div class="person-card">
      <div class="pc-name">${escapeHtml(name)}</div>
      <div class="pc-rows">
        <div class="pc-row pay"><span>需结算金额（他付）</span><b>${fmtMoney(p.pay)}</b><small>${p.payCount} 张</small></div>
        <div class="pc-row rec"><span>待别人结算金额（他收）</span><b>${fmtMoney(p.rec)}</b><small>${p.recCount} 张</small></div>
      </div>
      ${p.payCount ? `<details class="pc-detail pc-pay-detail"><summary>需结算明细（${p.payCount} 张）</summary><div class="sg-items">${p.payList.map(settleItemLine).join('')}</div></details>` : ''}
      ${p.recCount ? `<details class="pc-detail pc-rec-detail"><summary>待收明细（${p.recCount} 张）</summary><div class="sg-items">${p.recList.map(settleItemLine).join('')}</div></details>` : ''}
    </div>`;
  }).join('');
}

function renderSettlement(coupons) {
  const list = document.getElementById('list');
  if (!list) return;
  const pending = coupons; // loadData 已过滤为 status='sold' && !settled
  if (!pending.length) { list.innerHTML = `<div class="empty">🎉 当前没有待结算的券</div>`; return; }
  list.innerHTML = (state.settlementView === 'all') ? renderSettleAll(pending) : renderSettleMine(pending);
  bindListEvents();
}
// 标记售出：录入售出价（自动算结算金额 + 记录销售人）
function openSoldModal(c) {
  $modal.innerHTML = `
  <div class="modal-mask" data-close="1">
    <div class="modal" onclick="event.stopPropagation()">
      <h3>标记售出</h3>
      <div class="field"><label>商家</label><div>${escapeHtml(c.merchant)}</div></div>
      <div class="field"><label>所有人</label><div>${escapeHtml(c.owner_name)}</div></div>
      <form id="sold-form">
        <div class="field">
          <label>售出价（手动输入）</label>
          <input name="sold_price" type="number" step="0.01" min="0" placeholder="实际卖出价" required />
        </div>
        <div class="field"><label>平台手续费（售出价 × 1.6%）</label><div id="fee-preview">—</div></div>
        <div class="field"><label>结算金额（售出价 − 手续费）</label><div id="settle-preview">—</div></div>
        <div class="modal-actions">
          <button type="button" class="btn ghost" data-close="1">取消</button>
          <button type="submit" class="btn primary">确认售出</button>
        </div>
      </form>
    </div>
  </div>`;
  const f = document.getElementById('sold-form');
  const sp = f.sold_price;
  const feeEl = document.getElementById('fee-preview');
  const settleEl = document.getElementById('settle-preview');
  sp.addEventListener('input', () => {
    const v = parseFloat(sp.value);
    if (isNaN(v)) { feeEl.textContent = '—'; settleEl.textContent = '—'; return; }
    const fee = Math.round(v * 0.016 * 100) / 100;
    const net = Math.round((v - fee) * 100) / 100;
    feeEl.textContent = fmtMoney(fee);
    settleEl.textContent = fmtMoney(net);
  });
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = parseFloat(sp.value);
    if (!(v >= 0)) { toast('请输入售出价'); return; }
    try {
      await api('POST', '/coupons/' + c.id + '/sold', { sold_price: v });
      toast('已标记售出');
      closeModal();
      loadData();
    } catch (e2) { toast(e2.message); }
  });
  bindClose();
}

// 标记结算：确认已付款给所有人（售出价已在标记售出时录入）
function openSettleModal(c) {
  const sp = (c.sold_price != null) ? c.sold_price : '';
  const hasPrice = c.sold_price != null;
  const net = hasPrice ? Math.round((c.sold_price - c.sold_price * 0.016) * 100) / 100 : null;
  $modal.innerHTML = `
  <div class="modal-mask" data-close="1">
    <div class="modal" onclick="event.stopPropagation()">
      <h3>标记结算</h3>
      <div class="field"><label>商家</label><div>${escapeHtml(c.merchant)}</div></div>
      <div class="field"><label>所有人</label><div>${escapeHtml(c.owner_name)}</div></div>
      <form id="settle-form">
        ${hasPrice ? '' : `<div class="field">
          <label>售出价（补填）</label>
          <input name="sold_price" type="number" step="0.01" min="0" placeholder="实际卖出价" required />
        </div>`}
        <div class="field"><label>结算金额${hasPrice ? '（售出价 ' + fmtMoney(c.sold_price) + ' − 手续费 1.6%）' : '（补填售出价后计算）'}</label><div id="settle-preview">${hasPrice ? fmtMoney(net) : '—'}</div></div>
        <div class="modal-actions">
          <button type="button" class="btn ghost" data-close="1">取消</button>
          <button type="submit" class="btn primary">确认已结算</button>
        </div>
      </form>
    </div>
  </div>`;
  const f = document.getElementById('settle-form');
  if (!hasPrice) {
    const spEl = f.sold_price;
    const settleEl = document.getElementById('settle-preview');
    spEl.addEventListener('input', () => {
      const v = parseFloat(spEl.value);
      settleEl.textContent = (!isNaN(v) && v >= 0) ? fmtMoney(Math.round((v - v * 0.016) * 100) / 100) : '—';
    });
  }
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = hasPrice ? c.sold_price : parseFloat(f.sold_price.value);
    if (!(v >= 0)) { toast('请输入售出价'); return; }
    try {
      await api('POST', '/coupons/' + c.id + '/settle', hasPrice ? {} : { sold_price: v });
      toast('已结算');
      closeModal();
      loadData();
    } catch (e2) { toast(e2.message); }
  });
  bindClose();
}

/* ---------- 所有人下拉选项 ----------
   候选来源：当前用户 + 全部用户(管理员可见) + 已加载券里出现过的 owner_name，
   保证编辑/历史数据里的旧值一定在列表中。 */
function ownerCandidates() {
  const names = [];
  const seen = new Set();
  const add = n => { n = (n || '').toString().trim(); if (n && !seen.has(n)) { seen.add(n); names.push(n); } };
  add(state.user && state.user.display_name);
  (state.users || []).forEach(u => add(u.display_name || u.username));
  (state.data || []).forEach(c => add(c.owner_name));
  (state.coupons || []).forEach(c => add(c.owner_name));
  return names.sort((a, b) => a.localeCompare(b, 'zh'));
}
function ownerSelect({ name, id, selected, cls, emptyLabel } = {}) {
  const list = ownerCandidates();
  if (selected && !list.includes(selected)) list.unshift(selected);
  let opts = '';
  if (emptyLabel != null) opts += `<option value="">${escapeHtml(emptyLabel)}</option>`;
  opts += list.map(n => `<option value="${escapeHtml(n)}"${n === selected ? ' selected' : ''}>${escapeHtml(n)}</option>`).join('');
  const attrs = [name ? `name="${name}"` : '', id ? `id="${id}"` : '', cls ? `class="${cls}"` : ''].filter(Boolean).join(' ');
  return `<select ${attrs}>${opts}</select>`;
}

/* ---------- 录入 / 编辑 弹窗 ---------- */
function openCouponModal(coupon) {
  const isEdit = !!coupon;
  const c = coupon || {};
  const today = todayLocal();
  const owner = c.owner_name || (state.user ? state.user.display_name : '');
  $modal.innerHTML = `
  <div class="modal-mask" data-close="1">
    <div class="modal" onclick="event.stopPropagation()">
      <h3>${isEdit ? '编辑券' : '快速入库'}</h3>
      <form id="coupon-form">
        <div class="field">
          <label>商家名称 <span class="req">*</span></label>
          <input name="merchant" value="${escapeHtml(c.merchant || '')}" placeholder="如：星巴克 / 美团" required />
        </div>
        <div class="two">
          <div class="field">
            <label>代金券金额</label>
            <input name="amount" type="number" step="0.01" value="${c.amount != null ? c.amount : ''}" placeholder="0" />
          </div>
          <div class="field">
            <label>张数</label>
            <input name="quantity" type="number" min="1" value="${c.quantity != null ? c.quantity : 1}" />
          </div>
        </div>
        <div class="two">
          <div class="field">
            <label>券号</label>
            <input name="coupon_code" value="${escapeHtml(c.coupon_code || '')}" placeholder="选填" />
            <div class="ocr-rawhint" id="coupon-rawhint" style="display:none"></div>
          </div>
          <div class="field">
            <label>过期时间 <span class="req">*</span></label>
            <input name="expiry_date" id="expiry-input" type="date" value="${escapeHtml(c.expiry_date || '')}" min="${today}" required />
          </div>
        </div>
        <div class="two">
          <div class="field">
            <label>成本 <span class="req">*</span></label>
            <input name="cost" type="number" step="0.01" value="${c.cost != null ? c.cost : ''}" placeholder="0" required />
          </div>
          <div class="field">
            <label>所有人</label>
            ${ownerSelect({ name: 'owner_name', selected: owner })}
          </div>
        </div>
        <div class="field">
          <label>平台</label>
          <input name="platform" value="${escapeHtml(c.platform || '')}" placeholder="如：闲鱼 / 转转（选填）" />
        </div>
        <div class="field">
          <label>备注</label>
          <input name="note" value="${escapeHtml(c.note || '')}" placeholder="选填" />
        </div>
        <div class="field">
          <label>二维码截图</label>
          <input type="file" name="image" accept="image/*" id="img-input" />
          <div class="img-preview" id="img-preview">
            ${c.image_filename ? `<img src="${uploadUrl(c.image_filename)}" />` : ''}
          </div>
        </div>
        <div id="ocr-status" class="ocr-status" style="display:none"></div>
        <div class="modal-actions">
          <button type="button" class="btn ghost" data-close="1">取消</button>
          <button type="submit" class="btn primary">${isEdit ? '保存修改' : '入库'}</button>
        </div>
      </form>
    </div>
  </div>`;

  const input = document.getElementById('img-input');
  const ocrStatus = document.getElementById('ocr-status');
  const couponRaw = document.getElementById('coupon-rawhint');

  // 过期时间为必填：没有无限期的券。OCR 没识别到 / 用户未填时，高亮字段并定制校验提示。
  const expiryInput = document.getElementById('expiry-input');
  const EXPIRY_MSG = '请填写过期时间（没有无限期的券）';
  function markExpiryNeeded() {
    if (expiryInput && !expiryInput.value) {
      expiryInput.setCustomValidity(EXPIRY_MSG);
      expiryInput.classList.add('need-fill');
    }
  }
  function clearExpiryNeeded() {
    if (expiryInput) { expiryInput.setCustomValidity(''); expiryInput.classList.remove('need-fill'); }
  }
  if (expiryInput) {
    expiryInput.addEventListener('input', clearExpiryNeeded);
    expiryInput.addEventListener('change', clearExpiryNeeded);
    markExpiryNeeded(); // 新券或编辑时为空 → 标记为必填
  }

  function showPreview(src) {
    document.getElementById('img-preview').innerHTML = `<img src="${src}" />`;
  }
  // 把识别值写入字段并打上 OCR 标记（编辑模式下只填空字段，避免覆盖已核对的值）
  function setOcrField(name, val) {
    const el = document.querySelector(`#coupon-form [name="${name}"]`);
    if (!el || val === '' || val == null) return;
    if (isEdit && el.value.trim() !== '') return;
    el.value = val;
    el.classList.add('ocr-hit');
    const lbl = el.closest('.field') && el.closest('.field').querySelector('label');
    if (lbl && !lbl.querySelector('.ocr-tag')) {
      const tag = document.createElement('span');
      tag.className = 'ocr-tag';
      tag.textContent = 'OCR';
      lbl.appendChild(tag);
    }
  }
  async function runOcr(file) {
    ocrStatus.style.display = 'block';
    ocrStatus.className = 'ocr-status loading';
    ocrStatus.textContent = '🤖 正在识别截图，请稍候…';
    if (couponRaw) couponRaw.style.display = 'none';
    try {
      const fd = new FormData();
      fd.append('image', file);
      const data = await api('POST', '/ocr', fd, true);
      const f = data.fields || {};
      const names = { amount: '金额', coupon_code: '券号', quantity: '张数', expiry_date: '过期时间' };
      const filled = [];
      ['amount', 'coupon_code', 'quantity', 'expiry_date'].forEach(n => {
        if (f[n] !== null && f[n] !== undefined && f[n] !== '') { setOcrField(n, f[n]); filled.push(names[n]); }
      });
      if (data.raw && couponRaw) { couponRaw.textContent = '识别原文（照着抄券号）：\n' + data.raw; couponRaw.style.display = 'block'; }
      if (filled.length) {
        ocrStatus.className = 'ocr-status ok';
        ocrStatus.innerHTML = `🤖 已自动识别 <b>${filled.length}</b> 项（${filled.join('、')}），<b>请逐项核对</b>后再入库`;
      } else {
        ocrStatus.className = 'ocr-status warn';
        ocrStatus.textContent = data.error ? '未能识别，请手动填写各项' : '未识别出关键信息，请手动填写';
      }
      // 过期时间未识别到 → 主动提示并高亮该字段（券都有有效期，没有无限期的券）
      if (!(f.expiry_date != null && f.expiry_date !== '')) {
        markExpiryNeeded();
        const note = document.createElement('div');
        note.className = 'ocr-note-warn';
        note.textContent = '⚠️ 未识别到过期时间，请务必手动填写（券都有有效期，没有无限期的券）';
        ocrStatus.appendChild(note);
      }
    } catch (e) {
      ocrStatus.className = 'ocr-status warn';
      ocrStatus.textContent = '识别失败，请手动填写';
    }
  }

  input.addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = ev => showPreview(ev.target.result);
    reader.readAsDataURL(f);
    runOcr(f);
  });

  document.getElementById('coupon-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    // 未选新图时不传 image 字段（编辑时保留旧图）
    if (!input.files.length) fd.delete('image');
    try {
      if (isEdit) await api('PUT', '/coupons/' + c.id, fd, true);
      else await api('POST', '/coupons', fd, true);
      closeModal();
      toast(isEdit ? '已保存' : '入库成功');
      loadData();
    } catch (err) {
      toast(err.message || '保存失败');
    }
  });

  bindClose();
}

/* ---------- 批量入库 弹窗 ---------- */
function rowInner() {
  return `
    <div class="br-head">
      <img class="br-thumb" alt="截图" />
      <div class="br-status">等待识别…</div>
      <button type="button" class="br-del" title="移除">✕</button>
    </div>
    <div class="two">
      <div class="field" style="margin:0"><label>商家 <span class="req">*</span></label><input name="merchant" placeholder="必填" /></div>
      <div class="field" style="margin:0"><label>券号</label><input name="coupon_code" placeholder="选填" /></div>
    </div>
    <div class="two">
      <div class="field" style="margin:0"><label>金额</label><input name="amount" type="number" step="0.01" placeholder="0" /></div>
      <div class="field" style="margin:0"><label>张数</label><input name="quantity" type="number" min="1" value="1" /></div>
    </div>
    <div class="two">
      <div class="field" style="margin:0"><label>过期时间 <span class="req">*</span></label><input name="expiry_date" type="date" required /></div>
      <div class="field" style="margin:0"><label>成本</label><input name="cost" type="number" step="0.01" placeholder="0" /></div>
    </div>
    <div class="field" style="margin:0"><label>所有人</label>${ownerSelect({ name: 'owner_name', selected: state.user ? state.user.display_name : '' })}</div>
    <div class="field" style="margin:0"><label>平台</label><input name="platform" placeholder="选填" /></div>
    <div class="field" style="margin:0"><label>备注</label><input name="note" placeholder="选填" /></div>`;
}

function openBatchModal() {
  $modal.innerHTML = `
  <div class="modal-mask" data-close="1">
    <div class="modal batch-modal" onclick="event.stopPropagation()">
      <h3>批量入库 <span style="font-size:12px;color:var(--muted);font-weight:400">多张截图一次录入</span></h3>

      <div class="batch-common">
        <div class="bc-title">通用填写（一键应用到全部）</div>
        <div class="two">
          <div class="field" style="margin:0">
            <label>商家名称</label>
            <input id="bc-merchant" placeholder="如：星巴克" />
          </div>
          <div class="field" style="margin:0">
            <label>所有人</label>
            ${ownerSelect({ id: 'bc-owner', selected: state.user ? state.user.display_name : '' })}
          </div>
        </div>
        <div class="field" style="margin:10px 0 0">
          <label>成本（每张，可留空）</label>
          <input id="bc-cost" type="number" step="0.01" placeholder="0" />
        </div>
        <button class="btn ghost" id="bc-apply" type="button">应用到全部</button>
      </div>

      <div class="field" style="margin-top:14px">
        <label>选择多张二维码截图</label>
        <input type="file" id="batch-files" accept="image/*" multiple />
      </div>

      <div id="batch-grid" class="batch-grid"></div>

      <div class="modal-actions">
        <button type="button" class="btn ghost" data-close="1">取消</button>
        <button type="button" class="btn primary" id="batch-submit">全部入库</button>
      </div>
    </div>
  </div>`;

  const grid = document.getElementById('batch-grid');
  const fileInput = document.getElementById('batch-files');
  const rows = []; // { file, imgSrc, node }

  function addFiles(fileList) {
    [...fileList].forEach(file => {
      const imgSrc = URL.createObjectURL(file);
      const node = document.createElement('div');
      node.className = 'batch-row';
      node.innerHTML = rowInner();
      node.querySelector('.br-thumb').src = imgSrc;
      node.querySelector('.br-del').onclick = () => {
        if (file.__url) URL.revokeObjectURL(file.__url);
        node.remove();
        const idx = rows.findIndex(r => r.node === node);
        if (idx >= 0) rows.splice(idx, 1);
      };
      grid.appendChild(node);
      const rec = { file, imgSrc, node };
      file.__url = imgSrc;
      rows.push(rec);
      runRowOcr(rec);
    });
  }

  async function runRowOcr(rec) {
    const statusEl = rec.node.querySelector('.br-status');
    statusEl.textContent = '🤖 识别中…';
    statusEl.className = 'br-status loading';
    try {
      const fd = new FormData();
      fd.append('image', rec.file);
      const data = await api('POST', '/ocr', fd, true);
      const f = data.fields || {};
      const names = { amount: '金额', coupon_code: '券号', quantity: '张数', expiry_date: '过期时间' };
      const filled = [];
      ['amount', 'coupon_code', 'quantity', 'expiry_date'].forEach(n => {
        if (f[n] != null && f[n] !== '') {
          const el = rec.node.querySelector(`[name="${n}"]`);
          if (el) { el.value = f[n]; el.classList.add('ocr-hit'); }
          filled.push(names[n]);
        }
      });
      if (data.raw) {
        const codeField = rec.node.querySelector('[name="coupon_code"]').closest('.field');
        if (!codeField.querySelector('.ocr-rawhint')) {
          const raw = document.createElement('div');
          raw.className = 'ocr-rawhint';
          raw.textContent = '识别原文：' + data.raw.replace(/\n/g, ' ').slice(0, 140);
          codeField.appendChild(raw);
        }
      }
      if (filled.length) {
        statusEl.className = 'br-status ok';
        statusEl.innerHTML = '✓ 识别 ' + filled.length + ' 项，<b>请核对</b>';
      } else {
        statusEl.className = 'br-status warn';
        statusEl.textContent = '未识别到关键信息，请手动填';
      }
    } catch (e) {
      statusEl.className = 'br-status warn';
      statusEl.textContent = '识别失败，请手动填';
    }
  }

  fileInput.addEventListener('change', e => { if (e.target.files.length) addFiles(e.target.files); e.target.value = ''; });

  document.getElementById('bc-apply').onclick = () => {
    const m = document.getElementById('bc-merchant').value.trim();
    const o = document.getElementById('bc-owner').value.trim();
    const c = document.getElementById('bc-cost').value.trim();
    rows.forEach(rec => {
      if (m) rec.node.querySelector('[name="merchant"]').value = m;
      if (o) rec.node.querySelector('[name="owner_name"]').value = o;
      if (c) rec.node.querySelector('[name="cost"]').value = c;
    });
    toast('已应用到全部');
  };

  document.getElementById('batch-submit').onclick = async () => {
    if (!rows.length) { toast('请先选择截图'); return; }
    const items = rows.map(rec => {
      const v = n => rec.node.querySelector(`[name="${n}"]`).value.trim();
      return {
        merchant: v('merchant'),
        amount: v('amount'),
        coupon_code: v('coupon_code'),
        quantity: v('quantity'),
        expiry_date: v('expiry_date'),
        cost: v('cost'),
        owner_name: v('owner_name'),
        platform: v('platform'),
        note: v('note')
      };
    });
    const missing = items.filter(it => !it.merchant).length;
    if (missing) { toast(`有 ${missing} 张未填商家名称`); }
    const fd = new FormData();
    rows.forEach(rec => fd.append('images', rec.file));
    fd.append('items', JSON.stringify(items));
    try {
      const data = await api('POST', '/coupons/batch', fd, true);
      const ok = data.count || 0;
      const errs = data.errors || [];
      if (errs.length) { toast(`入库 ${ok} 张，${errs.length} 张失败（详见控制台）`); console.warn('批量入库失败项：', errs); }
      else toast(`成功入库 ${ok} 张`);
      if (ok > 0) { closeModal(); loadData(); }
    } catch (e) { toast(e.message || '批量入库失败'); }
  };

  bindClose();
}

/* ---------- 保存券图片到手机（iOS 不支持 download，走长按保存） ---------- */
function saveImage(file, fallbackName) {
  if (!file) return;
  const url = uploadUrl(file);
  const ua = navigator.userAgent || '';
  const isIOS = /iPhone|iPad|iPod/i.test(ua);
  if (isIOS) {
    window.open(url, '_blank');
    toast('已打开图片，长按即可保存到相册');
    return;
  }
  const name = ((fallbackName || 'coupon').replace(/[\\/:*?"<>|]/g, '_')) + '_' + Date.now() + '.png';
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast('图片已保存到下载目录');
}

/* ---------- 分享到闲鱼（系统分享面板，选闲鱼后挑会话发送） ---------- */
function buildShareText(c) {
  if (!c) return '优惠券';
  const parts = [];
  if (c.merchant) parts.push(c.merchant);
  if (c.amount) parts.push('面值' + fmtMoney(c.amount));
  if (c.coupon_code) parts.push('券号' + c.coupon_code);
  if (c.expiry_date) parts.push('有效期至' + c.expiry_date);
  if (c.quantity > 1) parts.push('×' + c.quantity + '张');
  return parts.join(' ');
}

async function shareToXianyu(file, coupon) {
  if (!file) return;
  const text = buildShareText(coupon);
  const url = uploadUrl(file);
  // 优先带图分享；不支持则退化为纯文字分享；都没有则复制+打开图兜底
  try {
    if (navigator.share) {
      let fileObj = null;
      try {
        const res = await fetch(url, { headers: { Authorization: 'Bearer ' + state.token } });
        const blob = await res.blob();
        const fname = ((coupon ? (coupon.merchant + (coupon.coupon_code ? '_' + coupon.coupon_code : '')) : 'coupon')).replace(/[\\/:*?"<>|]/g, '_') + '.png';
        fileObj = new File([blob], fname, { type: blob.type || 'image/png' });
      } catch (e) { fileObj = null; }
      if (fileObj && navigator.canShare && navigator.canShare({ files: [fileObj] })) {
        await navigator.share({ files: [fileObj], text });
        return;
      }
      if (navigator.share) {
        await navigator.share({ title: '优惠券', text });
        return;
      }
    }
  } catch (e) { /* 用户取消或分享失败，落下兜底 */ }
  try { await navigator.clipboard.writeText(text); } catch (_) {}
  window.open(url, '_blank');
  toast('已复制券信息并打开图片，去闲鱼粘贴发送');
}

function openImageViewer(file) {
  const coupon = state.coupons.find(c => c.image_filename === file);
  const name = coupon ? (coupon.merchant + (coupon.coupon_code ? '_' + coupon.coupon_code : '')) : 'coupon';
  $modal.innerHTML = `
  <div class="modal-mask" data-close="1" style="align-items:center">
    <div style="max-width:92vw;max-height:90vh">
      <img src="${uploadUrl(file)}" style="max-width:92vw;max-height:80vh;border-radius:12px" />
      <div style="text-align:center;margin-top:12px;display:flex;gap:10px;justify-content:center">
        <button class="btn primary" id="iv-save" data-save="${escapeHtml(file)}" data-name="${escapeHtml(name)}">保存到手机</button>
        <button class="btn ghost" id="iv-share" data-save="${escapeHtml(file)}">分享到闲鱼</button>
      </div>
    </div>
  </div>`;
  const sb = document.getElementById('iv-save');
  if (sb) sb.onclick = () => saveImage(sb.getAttribute('data-save'), sb.getAttribute('data-name'));
  const sh = document.getElementById('iv-share');
  if (sh) sh.onclick = () => shareToXianyu(sh.getAttribute('data-save'), coupon);
  bindClose();
}

/* ---------- 用户管理（管理员） ---------- */
function openUserModal() {
  $modal.innerHTML = `
  <div class="modal-mask" data-close="1">
    <div class="modal" onclick="event.stopPropagation()">
      <h3>用户管理</h3>
      <div id="user-list"></div>
      <form id="user-form" style="margin-top:14px;border-top:1px solid var(--line);padding-top:14px">
        <div class="field"><label>新增账号</label>
          <input name="username" placeholder="登录账号" required /></div>
        <div class="two">
          <div class="field"><label>密码</label><input name="password" type="password" placeholder="初始密码" required /></div>
          <div class="field"><label>昵称</label><input name="display_name" placeholder="显示名" /></div>
        </div>
        <div class="field"><label>角色</label>
          <select name="role"><option value="user">普通成员</option><option value="admin">管理员</option></select></div>
        <div class="modal-actions">
          <button type="button" class="btn ghost" data-close="1">关闭</button>
          <button type="submit" class="btn primary">添加用户</button>
        </div>
      </form>
    </div>
  </div>`;
  renderUserList();
  document.getElementById('user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('POST', '/auth/users', {
        username: f.username.value.trim(),
        password: f.password.value,
        display_name: f.display_name.value.trim(),
        role: f.role.value
      });
      f.reset();
      toast('已添加');
      await loadUsers();
      renderUserList();
    } catch (err) { toast(err.message); }
  });
  bindClose();
}
function renderUserList() {
  const box = document.getElementById('user-list');
  if (!box) return;
  box.innerHTML = state.users.map(u => `
    <div class="user-item">
      <div class="meta">
        <div class="name">${escapeHtml(u.display_name)} <span style="color:#ccc;font-weight:400">@${escapeHtml(u.username)}</span></div>
        <div class="role">${u.role === 'admin' ? '管理员' : '成员'}</div>
      </div>
      <div style="display:flex;gap:6px">
        ${u.id === state.user.id
          ? `<button class="btn ghost" data-reset="${u.id}">修改我的密码</button>`
          : `<button class="btn ghost" data-reset="${u.id}">重置密码</button><button class="btn danger" data-del="${u.id}">删除</button>`}
      </div>
    </div>`).join('');
  box.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('删除该用户？')) return;
    try { await api('DELETE', '/auth/users/' + b.dataset.del); toast('已删除'); await loadUsers(); renderUserList(); }
    catch (e) { toast(e.message); }
  });
  box.querySelectorAll('[data-reset]').forEach(b => b.onclick = async () => {
    const p = prompt('输入新密码：');
    if (!p) return;
    try { await api('PUT', '/auth/users/' + b.dataset.reset + '/password', { password: p }); toast('密码已重置'); }
    catch (e) { toast(e.message); }
  });
}

/* ---------- Modal 通用 ---------- */
function closeModal() { $modal.innerHTML = ''; }
function bindClose() {
  $modal.querySelectorAll('[data-close]').forEach(el => el.onclick = closeModal);
}

/* ---------- 启动 ---------- */
render();
