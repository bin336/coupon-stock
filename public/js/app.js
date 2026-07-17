/* ===================== 券库 前端 ===================== */
const $app = document.getElementById('app');
const $modal = document.getElementById('modal-root');
const $toast = document.getElementById('toast');

const state = {
  token: localStorage.getItem('cs_token') || null,
  user: JSON.parse(localStorage.getItem('cs_user') || 'null'),
  scope: 'default',   // default | all | sold | expired
  settlement: false,  // 是否处于结算模块视图
  report: false,      // 是否处于售出/利润报表视图
  logs: false,        // 是否处于操作日志视图
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
    renderSettlement(state.coupons.filter(c => c.status === 'sold'));
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
        <button class="icon" id="btn-batch">批量</button>
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
    <div class="stat">
      <div class="label">至今我们已售出</div>
      <div class="value">${s.sold || 0}</div>
      <div class="sub">张券</div>
    </div>
  </div>

  ${getToolbar()}

  <div class="list" id="list"></div>

  ${state.report || state.logs || state.settlement ? '' : '<button class="fab" id="fab">+</button>'}`;

  document.getElementById('btn-logout').onclick = logout;
  const bs = document.getElementById('btn-settings');
  if (bs) bs.onclick = openSettings;

  // 报表 / 日志 / 结算 视图：工具栏与列表独立渲染，不再绑定默认搜索/筛选
  if (state.report) { bindReportToolbar(); loadReport(); return; }
  if (state.logs) { bindLogToolbar(); loadLogs(); return; }
  if (state.settlement) {
    const back = document.getElementById('btn-back');
    if (back) back.onclick = () => { state.settlement = false; state.scope = 'default'; renderApp(); loadData(); };
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

  document.getElementById('fab').onclick = () => openCouponModal();
  const bb = document.getElementById('btn-batch');
  if (bb) bb.onclick = openBatchModal;

  const statPending = document.getElementById('stat-pending');
  if (statPending) statPending.onclick = openReport;

  renderList();
  renderRecentSearches();
}

/* ---------- 工具栏（按当前视图切换） ---------- */
function getToolbar() {
  if (state.settlement) {
    return `<div class="toolbar" style="display:flex;align-items:center;gap:10px">
      <button class="btn ghost" id="btn-back">← 返回</button>
      <div style="font-weight:600;font-size:15px">结算 · 按所有人汇总</div>
    </div>`;
  }
  if (state.report) {
    const f = state.reportFilters;
    return `<div class="toolbar report-toolbar">
      <button class="btn ghost" id="btn-back">← 返回</button>
      <button class="btn ghost" id="rf-settle">结算</button>
      <input class="search" id="rf-owner" placeholder="所有人（留空=全部）" value="${escapeHtml(f.owner)}" />
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
  state.report = true; state.logs = false; state.settlement = false; state.scope = 'default';
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
  state.logs = true; state.report = false; state.settlement = false;
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
    { sel: '.stat:nth-child(4) .value', val: s.sold || 0, sub: '.stat:nth-child(4) .sub', subText: '张券' }
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
        try { await api('POST', '/coupons/' + id + '/sold'); toast('已更新'); loadData(); }
        catch (e) { toast(e.message); }
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
  state.report = false; state.logs = false;
  state.scope = 'sold';
  state.q = '';
  state.settlement = true;
  renderApp();
  loadData();
}
function renderSettlement(coupons) {
  const list = document.getElementById('list');
  if (!list) return;
  const sold = coupons.filter(c => c.status === 'sold');
  if (!sold.length) { list.innerHTML = `<div class="empty">还没有已售出的券</div>`; return; }
  const byOwner = {};
  sold.forEach(c => {
    const k = (c.owner_name || '未指定') + '';
    (byOwner[k] = byOwner[k] || []).push(c);
  });
  let html = '';
  Object.keys(byOwner).forEach(owner => {
    const cs = byOwner[owner];
    const unsettled = cs.filter(c => !c.settled);
    const settled = cs.filter(c => c.settled);
    const pending = unsettled.reduce((s, c) => s + (c.amount || 0) * (c.quantity || 1), 0);
    const done = settled.reduce((s, c) => s + ((c.settle_amount != null ? c.settle_amount : 0)), 0);
    html += `<div class="group-head">
      <span class="gh-title">${escapeHtml(owner)}</span>
      <span class="gh-sub">待结算金额 ${fmtMoney(pending)} · 已结算金额 ${fmtMoney(done)} · 待 ${unsettled.length} 张</span>
    </div>`;
    html += unsettled.length ? unsettled.map(c => couponCard(c, true)).join('') : `<div class="empty small">该所有人暂无可结算券</div>`;
    html += settled.length ? settled.map(c => couponCard(c, true)).join('') : '';
  });
  list.innerHTML = html;
  bindListEvents();
}
function openSettleModal(c) {
  $modal.innerHTML = `
  <div class="modal-mask" data-close="1">
    <div class="modal" onclick="event.stopPropagation()">
      <h3>标记结算</h3>
      <div class="field"><label>商家</label><div>${escapeHtml(c.merchant)}</div></div>
      <div class="field"><label>成本</label><div>${fmtMoney(c.cost)}</div></div>
      <form id="settle-form">
        <div class="field">
          <label>售出价（手动输入）</label>
          <input name="sold_price" type="number" step="0.01" min="0" placeholder="实际卖出价" required />
        </div>
        <div class="field"><label>平台手续费（售出价 × 1.6%）</label><div id="fee-preview">—</div></div>
        <div class="field"><label>结算金额（售出价 − 手续费）</label><div id="settle-preview">—</div></div>
        <div class="modal-actions">
          <button type="button" class="btn ghost" data-close="1">取消</button>
          <button type="submit" class="btn primary">确认结算</button>
        </div>
      </form>
    </div>
  </div>`;
  const f = document.getElementById('settle-form');
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
      const fee = Math.round(v * 0.016 * 100) / 100;
      const net = Math.round((v - fee) * 100) / 100;
      await api('POST', '/coupons/' + c.id + '/settle', { sold_price: v, settle_amount: net });
      toast('已结算，结算金额 ' + fmtMoney(net));
      closeModal();
      loadData();
    } catch (e2) { toast(e2.message); }
  });
  bindClose();
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
            <label>过期时间</label>
            <input name="expiry_date" type="date" value="${escapeHtml(c.expiry_date || '')}" min="${today}" />
          </div>
        </div>
        <div class="two">
          <div class="field">
            <label>成本 <span class="req">*</span></label>
            <input name="cost" type="number" step="0.01" value="${c.cost != null ? c.cost : ''}" placeholder="0" required />
          </div>
          <div class="field">
            <label>所有人</label>
            <input name="owner_name" value="${escapeHtml(owner)}" placeholder="默认录入人" />
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
      <div class="field" style="margin:0"><label>过期时间</label><input name="expiry_date" type="date" /></div>
      <div class="field" style="margin:0"><label>成本</label><input name="cost" type="number" step="0.01" placeholder="0" /></div>
    </div>
    <div class="field" style="margin:0"><label>所有人</label><input name="owner_name" value="${escapeHtml(state.user ? state.user.display_name : '')}" /></div>
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
            <input id="bc-owner" value="${escapeHtml(state.user ? state.user.display_name : '')}" placeholder="默认录入人" />
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
