/* ═══════════════════════════════════════════════════════════════════════════
   Kosh — minimal personal expense tracker
   Backed by your own Google Sheet via an Apps Script web app.
   Plain JavaScript, no build step. See README.md for architecture.
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

/* ─── tiny helpers ─────────────────────────────────────────────────────── */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const fmt = (n) => (n == null || n === '' || isNaN(n)) ? '—' : '₹' + inr.format(Math.round(n));
const fmtS = (n) => (n == null || isNaN(n)) ? '—' : inr.format(Math.round(n));

function timeAgo(iso) {
  const d = new Date(iso), s = (Date.now() - d) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  if (s < 86400 * 7) return Math.round(s / 86400) + 'd ago';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

/* FY months run April(0) … March(11) */
const fyMonthIdx = (d = new Date()) => (d.getMonth() + 9) % 12;
const fyLabelNow = (d = new Date()) => 'FY' + String((d.getFullYear() + (d.getMonth() >= 3 ? 1 : 0)) % 100);

/* ─── state ────────────────────────────────────────────────────────────── */
const store = {
  get(k, fb = null) { try { const v = localStorage.getItem('kh.' + k); return v ? JSON.parse(v) : fb; } catch { return fb; } },
  set(k, v) { try { localStorage.setItem('kh.' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('kh.' + k); } catch {} },
};

const S = {
  cfg: store.get('cfg', { url: '', token: '', fyId: '', fyTab: null, fyLabel: '', theme: 'auto' }),
  model: null,          // current FY model from the sheet
  fys: store.get('fys', []),
  logs: store.get('logs', []),
  outbox: store.get('outbox', []),
  loading: false,
  syncing: false,
};

function saveCfg() { store.set('cfg', S.cfg); }

/* ─── theme ────────────────────────────────────────────────────────────── */
function applyTheme() {
  const sys = matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = S.cfg.theme === 'dark' || (S.cfg.theme === 'auto' && sys);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const mc = $('meta[name=theme-color]:not([media])') || (() => {
    const m = document.createElement('meta'); m.name = 'theme-color'; document.head.appendChild(m); return m;
  })();
  mc.content = dark ? '#0E0E12' : '#F6F5F2';
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

/* ─── API client ───────────────────────────────────────────────────────── */
async function api(action, params = {}, { timeout = 30000 } = {}) {
  if (!S.cfg.url) throw new Error('Not set up yet');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(S.cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // simple request → no CORS preflight
      body: JSON.stringify({ token: S.cfg.token, action, ...params }),
      signal: ctrl.signal,
      redirect: 'follow',
    });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || 'Request failed');
    return j.data;
  } finally { clearTimeout(t); }
}

/* offline outbox: failed writes are queued and retried */
function queueWrite(action, params, label) {
  S.outbox.push({ id: Date.now() + Math.random(), action, params, label, at: new Date().toISOString() });
  store.set('outbox', S.outbox);
}
async function flushOutbox() {
  if (!S.outbox.length || S.syncing) return;
  S.syncing = true;
  const remaining = [];
  for (const item of S.outbox) {
    try { await api(item.action, item.params); }
    catch (e) {
      if (/token|formula|Bad/i.test(String(e.message))) { toast('Dropped: ' + item.label, true); }
      else remaining.push(item);
    }
  }
  S.outbox = remaining; store.set('outbox', S.outbox); S.syncing = false;
  if (!remaining.length) refresh(true);
  renderIfCurrent();
}
addEventListener('online', flushOutbox);

/* ─── data loading ─────────────────────────────────────────────────────── */
const fyKey = () => S.cfg.fyId + (S.cfg.fyTab ? '#' + S.cfg.fyTab : '');
function cachedModel() { return store.get('model.' + fyKey()); }

async function refresh(silent = false) {
  if (!S.cfg.url || !S.cfg.fyId) return;
  if (!silent) { S.loading = true; renderIfCurrent(); }
  try {
    const [model, log] = await Promise.all([
      api('get', { fyId: S.cfg.fyId, tab: S.cfg.fyTab, tab: S.cfg.fyTab }),
      api('log', { fyId: S.cfg.fyId, tab: S.cfg.fyTab, tab: S.cfg.fyTab, limit: 12 }).catch(() => ({ entries: S.logs })),
    ]);
    S.model = model; S.logs = log.entries || [];
    store.set('model.' + fyKey(), model);
    store.set('logs', S.logs);
  } catch (e) {
    if (!silent) toast(e.name === 'AbortError' ? 'Timed out — check connection' : e.message, true);
  }
  S.loading = false;
  renderIfCurrent();
}

async function loadFYs() {
  try {
    const d = await api('fys');
    S.fys = d.fys || []; store.set('fys', S.fys);
    if (!S.cfg.fyId && S.fys.length) {
      const now = fyLabelNow();
      const pick = S.fys.find((f) => f.label === now) || S.fys[0];
      S.cfg.fyId = pick.id; S.cfg.fyTab = pick.tab || null; S.cfg.fyLabel = pick.label; saveCfg();
    }
  } catch (e) { /* non-fatal */ }
}

/* model-derived getters (all tolerate a missing model) */
const M = {
  months: () => S.model?.months?.length ? S.model.months : ['April','May','June','July','Aug','Sep','Oct','Nov','Dec','Jan','Feb','Mar'],
  varRows: () => S.model?.variable?.rows || [],
  largeRows: () => S.model?.large?.rows || [],
  monthSpend: (i) => {
    const t = S.model?.variable?.totalCells;
    if (t && t[i] != null) return t[i];
    return M.varRows().reduce((a, r) => a + (r.cells[i] || 0), 0);
  },
  budget: () => S.model?.variable?.totalBudget ?? M.varRows().reduce((a, r) => a + (r.monthly || 0), 0),
  summaryVal: (label) => S.model?.summary?.find((s) => s.label.toLowerCase() === label.toLowerCase())?.value,

  /* Column B of a category row is what you PLANNED for the year;
     columns D..O are what actually went out. Keep the two apart. */
  varPlanned: () => M.varRows().reduce((a, r) => a + (r.total || 0), 0),
  varSpent: () => (S.model?.variable?.totalCells || []).reduce((a, v) => a + (v || 0), 0),
  varSaved: () => (S.model?.variable?.savingsCells || []).reduce((a, v) => a + (v || 0), 0),
  largePlanned: () => S.model?.large?.totalYear ?? M.largeRows().reduce((a, r) => a + (r.total || 0), 0),
  largeSpent: () => M.largeRows().reduce((a, r) => a + r.cells.reduce((b, c) => b + (c.v || 0), 0), 0),
  rowSpent: (r) => r.cells.reduce((a, c) => a + (c.v || 0), 0),
};

/* ─── UI primitives: toast + bottom sheet ──────────────────────────────── */
let toastT;
function toast(msg, err = false) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  el.className = err ? 'err show' : 'show';
  clearTimeout(toastT);
  toastT = setTimeout(() => { el.className = ''; setTimeout(() => (el.hidden = true), 350); }, err ? 3800 : 2000);
}

function openSheet(html, onOpen) {
  const bd = $('#sheet-backdrop'), sh = $('#sheet');
  sh.innerHTML = '<div class="grab"></div>' + html;
  bd.hidden = sh.hidden = false;
  requestAnimationFrame(() => { bd.classList.add('show'); sh.classList.add('show'); });
  bd.onclick = () => closeSheet();
  history.pushState({ sheet: true }, '');
  onOpen?.(sh);
}
function closeSheet(viaPop = false) {
  const bd = $('#sheet-backdrop'), sh = $('#sheet');
  if (sh.hidden) return;
  bd.classList.remove('show'); sh.classList.remove('show');
  setTimeout(() => { bd.hidden = sh.hidden = true; sh.innerHTML = ''; }, 320);
  if (viaPop !== true && history.state?.sheet) history.back();
}
addEventListener('popstate', () => { closeSheet(true); route(); });

/* ─── router ───────────────────────────────────────────────────────────── */
const routes = {};
function route() {
  const hash = location.hash || '#/';
  const [path, arg] = hash.replace(/^#\//, '').split('/');
  const name = !S.cfg.url ? 'setup' : (path || 'home');
  const view = routes[name] || routes.home;
  const tab = { home: 'home', months: 'months', large: 'large', year: 'year' }[name];
  $('#tabbar').hidden = !S.cfg.url || name === 'setup';
  $$('#tabbar a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
  const el = $('#view');
  el.innerHTML = view(arg);
  el.classList.remove('fade'); void el.offsetWidth; el.classList.add('fade');
  bindView(name, arg);
  scrollTo(0, 0);
}
function renderIfCurrent() { route(); }
addEventListener('hashchange', route);

const backBtn = `<button class="back" onclick="history.back()">‹</button>`;

/* ─── shared view fragments ────────────────────────────────────────────── */
function fyPill() { return `<button class="pill acc" data-act="fy">${esc(S.cfg.fyLabel || 'FY')}</button>`; }
function themeBtn() {
  const ic = { auto: '◐', light: '☀', dark: '☾' }[S.cfg.theme] || '◐';
  return `<button class="iconbtn" data-act="theme" title="Theme">${ic}</button>`;
}
function loadingCard() { return `<div class="spin"></div>`; }
const spentMonths = () => (S.model?.variable?.totalCells || []).filter((v) => v != null).length;
function manageBtn(section, label = 'Manage categories') {
  return `<a class="btn ghost sm" href="#/manage/${section}">⚙&nbsp; ${label}</a>`;
}

/* ─── view: setup / onboarding ─────────────────────────────────────────── */
routes.setup = () => `
  <img src="icons/icon-192.png" class="onboard-logo" alt="">
  <h1 class="center" style="font-size:26px;letter-spacing:-.02em">Kosh</h1>
  <p class="center mut small" style="margin:6px 0 26px">Your expense sheet, on your phone.<br>Data lives only in your Google Sheet.</p>
  <div class="card">
    <div class="field"><label>Apps Script web app URL</label>
      <input id="su-url" inputmode="url" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(S.cfg.url)}"></div>
    <div class="field"><label>Secret token</label>
      <input id="su-token" placeholder="same token as in Code.gs" value="${esc(S.cfg.token)}"></div>
    <button class="btn" id="su-go">Connect</button>
    <div class="gap"></div>
    <p class="small mut">One-time setup — see <code class="k">SETUP.md</code> in the repo for the 5-minute guide to deploying the script from your Google account.</p>
  </div>`;

function bindSetup() {
  $('#su-go').onclick = async () => {
    const url = $('#su-url').value.trim(), token = $('#su-token').value.trim();
    if (!url.startsWith('https://script.google.com/')) return toast('That doesn’t look like an Apps Script URL', true);
    if (!token) return toast('Token is required', true);
    const btn = $('#su-go'); btn.disabled = true; btn.textContent = 'Connecting…';
    S.cfg.url = url; S.cfg.token = token; saveCfg();
    try {
      await api('ping');
      toast('Connected ✓');
      await loadFYs();
      location.hash = '#/'; refresh();
    } catch (e) {
      S.cfg.url = ''; saveCfg();
      toast(e.message === 'Invalid token' ? 'Token doesn’t match Code.gs' : 'Could not connect: ' + e.message, true);
      btn.disabled = false; btn.textContent = 'Connect';
    }
  };
}

/* ─── view: home — the four year-end figures, nothing else ─────────────── */
routes.home = () => {
  const m = S.model;
  const sv = (l) => M.summaryVal(l);

  return `
  <div class="hdr">
    <h1>Kosh</h1>
    ${fyPill()} ${themeBtn()}
    <a class="iconbtn" href="#/settings" title="Settings">⚙</a>
  </div>

  ${S.outbox.length ? `<div class="card tight" style="border-color:var(--amber)"><div class="row">
      <div class="dot" style="background:var(--amber-soft);color:var(--amber)">↻</div>
      <div class="grow"><div class="t">${S.outbox.length} entr${S.outbox.length > 1 ? 'ies' : 'y'} waiting to sync</div>
      <div class="s">Will send automatically when online</div></div>
      <button class="pill" data-act="sync">Retry</button></div></div>` : ''}

  ${!m ? loadingCard() : `
  <div class="stats">
    <div class="stat"><div class="l">Total income</div>
      <div class="v num">${fmt(sv('Total income'))}</div>
      <div class="c">funds + savings</div></div>
    <div class="stat"><div class="l">Total expenses</div>
      <div class="v num">${fmt(sv('Total expenses'))}</div>
      <div class="c">planned for the year</div></div>
    <div class="stat"><div class="l">Savings from monthly expenses</div>
      <div class="v num ${M.varSaved() >= 0 ? 'good' : 'bad'}">${fmt(sv('Savings from monthly expenses'))}</div>
      <div class="c">under budget so far</div></div>
    <div class="stat"><div class="l">Remaining</div>
      <div class="v num ${sv('Remaining') < 0 ? 'bad' : ''}">${fmt(sv('Remaining'))}</div>
      <div class="c">after the full-year plan</div></div>
  </div>
  <p class="center small mut" style="margin-top:16px">
    ${esc(S.cfg.fyLabel)} · ${S.loading ? 'refreshing…' : 'straight from your sheet'}</p>`}`;
};

/* ─── view: months (full matrix) ───────────────────────────────────────── */
routes.months = () => {
  const m = S.model, mi = fyMonthIdx(), months = M.months();
  if (!m) return `<div class="hdr"><h1>Monthly</h1>${fyPill()}</div>` + loadingCard();
  const rows = M.varRows();
  const strip = months.map((mm, i) => `
    <div class="mcard ${i === mi ? 'cur' : ''}">
      <div class="m">${esc(mm)}</div>
      <div class="v num">${fmtS(M.monthSpend(i))}</div>
    </div>`).join('');
  const head = `<tr><th class="rowhead">Category</th><th>Planned</th>${months.map((mm, i) =>
    `<th class="${i === mi ? 'cur' : ''}">${esc(mm)}</th>`).join('')}</tr>`;
  const body = rows.map((r) => `<tr>
      <td class="rowhead">${esc(r.label)}</td>
      <td class="num plancell" data-act="plan" data-row="${r.row}" data-col="C"
          data-label="${esc(r.label)}" data-val="${r.monthly ?? ''}"
          data-fx="${r.monthlyLocked ? 1 : 0}">${fmtS(r.monthly)}</td>
      ${r.cells.map((v, i) => `<td class="num ${i === mi ? 'cur' : ''} ${!v ? 'zero' : ''}"
         data-cell="${r.row}:${i}">${fmtS(v || 0)}</td>`).join('')}
    </tr>`).join('');
  const totals = `<tr class="total"><td class="rowhead">Total</td>
    <td class="num">${fmtS(M.budget())}</td>
    ${months.map((_, i) => `<td class="num ${i === mi ? 'cur' : ''}">${fmtS(M.monthSpend(i))}</td>`).join('')}</tr>`;
  const savings = m.variable?.savingsCells ? `<tr><td class="rowhead mut">Saved</td><td></td>
    ${m.variable.savingsCells.map((v, i) => `<td class="num ${v > 0 ? 'good' : v < 0 ? 'bad' : 'zero'}">${v == null ? '' : fmtS(v)}</td>`).join('')}</tr>` : '';

  const planned = M.varPlanned(), spent = M.varSpent(), saved = M.varSaved();

  return `
  <div class="hdr"><h1>Monthly</h1><span class="sub">tap a cell to edit</span>${fyPill()}</div>
  <div class="stats">
    <div class="stat"><div class="l">Planned for the year</div>
      <div class="v num">${fmt(planned)}</div><div class="c">sum of monthly budgets</div></div>
    <div class="stat"><div class="l">Spent so far</div>
      <div class="v num">${fmt(spent)}</div><div class="c">${spentMonths()} months entered</div></div>
    <div class="stat"><div class="l">Saved so far</div>
      <div class="v num ${saved >= 0 ? 'good' : 'bad'}">${fmt(saved)}</div>
      <div class="c">budget minus actual</div></div>
    <div class="stat"><div class="l">Left for the year</div>
      <div class="v num ${planned - spent < 0 ? 'bad' : ''}">${fmt(planned - spent)}</div>
      <div class="c">planned minus spent</div></div>
  </div>
  <p class="small mut" style="margin:-4px 0 14px">These four cover variable expenses only — fixed
    monthly costs live on the Fixed tab.</p>
  <div class="mstrip">${strip}</div>
  <div class="matrix-wrap"><table class="matrix">
    <thead>${head}</thead><tbody>${body}${totals}${savings}</tbody>
  </table></div>
  <div class="gap"></div>
  <button class="btn" data-act="add">＋&nbsp; Add expense</button>
  <div class="gap"></div>
  ${manageBtn('variable')}`;
};

/* ─── view: large expenses / investments ───────────────────────────────── */
routes.large = (arg) => {
  const m = S.model;
  if (!m) return `<div class="hdr"><h1>Large</h1>${fyPill()}</div>` + loadingCard();
  if (arg != null) return largeDetail(Number(arg));
  const rows = M.largeRows();
  return `
  <div class="hdr"><h1>Large & Investments</h1>${fyPill()}</div>
  <div class="stats">
    <div class="stat"><div class="l">Planned for the year</div>
      <div class="v num">${fmt(M.largePlanned())}</div><div class="c">sum of the plans below</div></div>
    <div class="stat"><div class="l">Spent so far</div>
      <div class="v num">${fmt(M.largeSpent())}</div><div class="c">actual, all categories</div></div>
    <div class="stat wide"><div class="l">Left for the year</div>
      <div class="v num ${M.largePlanned() - M.largeSpent() < 0 ? 'bad' : ''}">${fmt(M.largePlanned() - M.largeSpent())}</div>
      <div class="c">planned minus spent</div></div>
  </div>
  <button class="btn" data-act="addlarge" style="margin-bottom:12px">＋&nbsp; Add large expense</button>
  <div class="card tight">
    ${rows.map((r) => {
      const spent = M.rowSpent(r);
      const notes = r.cells.filter((c) => c.note).length;
      const planned = r.total;
      return `<a class="row" href="#/large/${r.row}">
        <div class="dot">${esc(r.label[0])}</div>
        <div class="grow"><div class="t">${esc(r.label)}</div>
          <div class="s">${notes ? notes + ' note' + (notes > 1 ? 's' : '') : '&nbsp;'}</div></div>
        <div class="rightcol">
          <div class="amt num">${fmtS(spent)}</div>
          <button class="plan num ${planned > 0 ? '' : 'none'}" data-act="plan" data-row="${r.row}"
            data-label="${esc(r.label)}" data-val="${planned ?? ''}" data-fx="${r.totalLocked ? 1 : 0}"
          >${planned > 0 ? 'plan ' + fmtS(planned) : 'set plan'}</button>
        </div><span class="chev">›</span>
      </a>`;
    }).join('') || '<div class="empty">No large-expense rows found in the sheet</div>'}
  </div>
  ${manageBtn('large')}`;
};

function largeDetail(row) {
  const r = M.largeRows().find((x) => x.row === row);
  if (!r) return `<div class="hdr">${backBtn}<h1>Not found</h1></div>`;
  const months = M.months(), mi = fyMonthIdx();
  const spent = r.cells.reduce((a, c) => a + (c.v || 0), 0);
  return `
  <div class="hdr">${backBtn}<h1 style="font-size:19px">${esc(r.label)}</h1>${fyPill()}</div>
  <div class="stats">
    <div class="stat"><div class="l">Spent so far</div><div class="v num">${fmt(spent)}</div></div>
    <div class="stat" data-act="plan" data-row="${r.row}" data-label="${esc(r.label)}"
         data-val="${r.total ?? ''}" data-fx="${r.totalLocked ? 1 : 0}" style="cursor:pointer">
      <div class="l">Planned <span style="color:var(--acc-ink)">· edit</span></div>
      <div class="v num">${r.total > 0 ? fmt(r.total) : '—'}</div>
      <div class="c">${r.total > 0
        ? (spent > r.total ? fmt(spent - r.total) + ' over' : fmt(r.total - spent) + ' left')
        : 'tap to set a plan'}</div></div>
  </div>
  <button class="btn" data-act="addlarge" data-row="${r.row}" style="margin-bottom:14px">＋&nbsp; Add to ${esc(r.label)}</button>
  <div class="card tight">
    ${r.cells.map((c, i) => (c.v || c.note) ? `
      <div class="row" style="align-items:flex-start;flex-wrap:wrap">
        <div class="grow"><div class="t">${esc(months[i])}${i === mi ? ' <span class="small" style="color:var(--acc-ink)">· now</span>' : ''}</div>
          ${c.note ? `<div class="note">${esc(c.note)}</div>` : ''}</div>
        <div class="amt num">${fmtS(c.v || 0)}</div>
        <button class="pill" data-act="editcell" data-row="${r.row}" data-month="${i}" data-large="1" style="padding:6px 11px;font-size:12px">edit</button>
      </div>` : '').join('') || '<div class="empty">Nothing yet this year</div>'}
  </div>`;
}

/* ─── view: year (funds + fixed, both editable) ────────────────────────── */
routes.year = () => {
  const m = S.model;
  if (!m) return `<div class="hdr"><h1>Fixed</h1>${fyPill()}</div>` + loadingCard();
  return `
  <div class="hdr"><h1>Fixed</h1><span class="sub">income & monthly costs</span>${fyPill()}</div>

  <div class="card tight">
    <div class="row"><div class="grow kicker" style="padding:4px 0">Funds / income</div>
      <div class="amt num mut">${fmt(m.funds?.total)}</div></div>
    ${(m.funds?.rows || []).map((r) => `
      <div class="row" data-act="fixed" data-row="${r.row}" data-col="B" data-label="${esc(r.label)}"
           data-val="${r.value ?? ''}" data-fx="${r.locked ? 1 : 0}">
        <div class="grow"><div class="t">${esc(r.label)}</div>
          ${r.locked ? '<div class="s">calculated in the sheet</div>' : ''}</div>
        <div class="amt num">${fmtS(r.value)}</div><span class="chev">›</span>
      </div>`).join('')}
  </div>
  ${manageBtn('funds', 'Manage income rows')}
  <div class="gap"></div><div class="gap"></div>

  <div class="card tight">
    <div class="row"><div class="grow kicker" style="padding:4px 0">Fixed monthly expenses</div></div>
    ${(m.fixed || []).map((r) => `
      <div class="row" data-act="fixed" data-row="${r.row}" data-col="C" data-label="${esc(r.label)}"
           data-val="${r.monthly ?? ''}" data-fx="${r.monthlyLocked ? 1 : 0}">
        <div class="grow"><div class="t">${esc(r.label)}</div>
          <div class="s">${fmt(r.total)} / year</div></div>
        <div class="amt num">${fmtS(r.monthly)}<span class="small mut">/mo</span></div>
        <span class="chev">›</span>
      </div>`).join('')}
  </div>
  ${manageBtn('fixed', 'Manage fixed expenses')}
  <div class="gap"></div><div class="gap"></div>

  <div class="card tight">
    <a class="row" href="https://docs.google.com/spreadsheets/d/${esc(S.cfg.fyId)}" target="_blank" rel="noopener">
      <div class="dot" style="background:var(--good-soft);color:var(--good)">▤</div>
      <div class="grow"><div class="t">Open in Google Sheets</div>
        <div class="s">${esc(m.fy?.name || '')}</div></div><span class="chev">↗</span></a>
  </div>`;
};

/* ─── view: manage categories (shared by all four sections) ────────────── */
const SECTIONS = {
  variable: { title: 'Variable categories', noun: 'category',
              rows: () => M.varRows(), sub: 'Monthly Variable Expenses' },
  large:    { title: 'Large categories', noun: 'category',
              rows: () => M.largeRows(), sub: 'Large expenses / Investments' },
  funds:    { title: 'Income rows', noun: 'row',
              rows: () => S.model?.funds?.rows || [], sub: 'Funds' },
  fixed:    { title: 'Fixed expenses', noun: 'row',
              rows: () => S.model?.fixed || [], sub: 'Monthly Fixed Expenses' },
};

routes.manage = (section) => {
  const cfg = SECTIONS[section];
  if (!cfg) return `<div class="hdr">${backBtn}<h1>Unknown section</h1></div>`;
  if (!S.model) return `<div class="hdr">${backBtn}<h1>${cfg.title}</h1></div>` + loadingCard();
  const rows = cfg.rows();
  return `
  <div class="hdr">${backBtn}<h1 style="font-size:20px">${cfg.title}</h1></div>
  <p class="small mut" style="margin:-8px 0 16px">Edits go straight into the “${esc(cfg.sub)}” block of your sheet. Totals and formulas adjust themselves.</p>
  <div class="card tight">
    ${rows.map((r) => `
      <div class="row mrow">
        <div class="grow"><div class="t">${esc(r.label)}</div>
          <div class="s">row ${r.row}</div></div>
        <button class="pill" data-act="rename" data-section="${section}" data-row="${r.row}" data-label="${esc(r.label)}">Rename</button>
        <button class="pill" data-act="delrow" data-section="${section}" data-row="${r.row}" data-label="${esc(r.label)}"
          style="color:var(--bad)">Remove</button>
      </div>`).join('') || `<div class="empty">Nothing here yet</div>`}
  </div>
  <button class="btn" data-act="addrow" data-section="${section}">＋&nbsp; Add ${cfg.noun}</button>
  <div class="gap"></div>
  <p class="small mut center">Removing a ${cfg.noun} deletes its whole row — including every month’s amount and note. This can’t be undone from the app, but Google Sheets keeps version history.</p>`;
};

/* ─── view: settings ───────────────────────────────────────────────────── */
routes.settings = () => `
  <div class="hdr">${backBtn}<h1>Settings</h1></div>
  <div class="card">
    <h3>Connection</h3>
    <div class="field"><label>Apps Script URL</label><input id="st-url" value="${esc(S.cfg.url)}"></div>
    <div class="field"><label>Token</label><input id="st-token" value="${esc(S.cfg.token)}"></div>
    <button class="btn sm ghost" data-act="testconn">Test & save</button>
  </div>
  <div class="card">
    <h3>Appearance</h3>
    <div class="seg" id="st-theme">
      ${['auto', 'light', 'dark'].map((t) => `<button data-theme="${t}" class="${S.cfg.theme === t ? 'on' : ''}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}
    </div>
  </div>
  <div class="card">
    <h3>Financial year</h3>
    <div class="chips">${S.fys.map((f) => `<button class="chip ${f.id === S.cfg.fyId && (f.tab || null) === S.cfg.fyTab ? 'on' : ''}" data-fyid="${esc(f.id)}" data-fylabel="${esc(f.label)}" data-fytab="${esc(f.tab || '')}">${esc(f.label)}</button>`).join('') || '<span class="small mut">Connect first</span>'}</div>
    <div class="gap"></div>
    <button class="btn sm ghost" data-act="refys">Re-scan Drive for FY sheets</button>
  </div>
  <div class="card">
    <h3>Data</h3>
    <button class="btn sm ghost" data-act="hardrefresh">Refresh from sheet</button>
    <div class="gap"></div>
    <button class="btn sm danger" data-act="reset">Sign out (clear this device)</button>
  </div>
  <p class="center small mut">Kosh · data lives in your Google Sheet<br>github.com/ankit-icici/kosh</p>`;

/* ─── bottom sheets: entry ─────────────────────────────────────────────── */
function addExpenseSheet(pre = {}) {
  const months = M.months(), mi = pre.month ?? fyMonthIdx();
  const cats = M.varRows();
  let sel = pre.row ?? cats[0]?.row;
  openSheet(`
    <h2>Add expense</h2><div class="sub">Adds into the month’s running total</div>
    <div class="amount-input"><span class="cur">₹</span>
      <input id="ax-amt" inputmode="decimal" pattern="[0-9]*" placeholder="0" autocomplete="off"></div>
    <div class="gap"></div><div class="gap"></div>
    <div class="field"><label>Category</label>
      <div class="chips" id="ax-cats">${cats.map((c) =>
        `<button class="chip ${c.row === sel ? 'on' : ''}" data-row="${c.row}">${esc(c.label)}</button>`).join('')}</div></div>
    <div class="field"><label>Month</label>
      <div class="chiprow" id="ax-months">${months.map((mm, i) =>
        `<button class="chip ${i === mi ? 'on' : ''}" data-i="${i}">${esc(mm)}</button>`).join('')}</div></div>
    <div class="field"><label>Note (optional — saved to the log)</label>
      <input id="ax-note" placeholder="what was it?"></div>
    <button class="btn" id="ax-go">Add</button>
  `, (sh) => {
    let month = mi;
    $('.chiprow .chip.on', sh)?.scrollIntoView({ inline: 'center', block: 'nearest' });
    $('#ax-amt', sh).focus();
    $('#ax-cats', sh).onclick = (e) => { const b = e.target.closest('.chip'); if (!b) return;
      sel = +b.dataset.row; $$('#ax-cats .chip', sh).forEach((c) => c.classList.toggle('on', c === b)); };
    $('#ax-months', sh).onclick = (e) => { const b = e.target.closest('.chip'); if (!b) return;
      month = +b.dataset.i; $$('#ax-months .chip', sh).forEach((c) => c.classList.toggle('on', c === b)); };
    $('#ax-go', sh).onclick = () => {
      const amount = parseFloat($('#ax-amt', sh).value);
      if (!amount) return toast('Enter an amount', true);
      const note = $('#ax-note', sh).value.trim();
      const cat = cats.find((c) => c.row === sel);
      submitWrite('addVariable', { fyId: S.cfg.fyId, tab: S.cfg.fyTab, row: sel, month, amount, mode: 'add', note },
        `${cat?.label} +${fmtS(amount)}`, () => {
          if (cat) cat.cells[month] = (cat.cells[month] || 0) + amount;
          if (S.model?.variable?.totalCells) S.model.variable.totalCells[month] += amount;
        });
    };
  });
}

function addLargeSheet(preRow) {
  const months = M.months(), mi = fyMonthIdx();
  const cats = M.largeRows();
  let sel = preRow ?? cats[0]?.row;
  openSheet(`
    <h2>Add large expense</h2><div class="sub">Amount adds to the month cell; note is attached to it</div>
    <div class="amount-input"><span class="cur">₹</span>
      <input id="al-amt" inputmode="decimal" placeholder="0"></div>
    <div class="gap"></div><div class="gap"></div>
    <div class="field"><label>Category</label>
      <div class="chips" id="al-cats">${cats.map((c) =>
        `<button class="chip ${c.row === sel ? 'on' : ''}" data-row="${c.row}">${esc(c.label)}</button>`).join('')}</div></div>
    <div class="field"><label>Month</label>
      <div class="chiprow" id="al-months">${months.map((mm, i) =>
        `<button class="chip ${i === mi ? 'on' : ''}" data-i="${i}">${esc(mm)}</button>`).join('')}</div></div>
    <div class="field"><label>Note — so future-you remembers what this was</label>
      <textarea id="al-note" placeholder="e.g. Diwali gold coin from Tanishq"></textarea></div>
    <button class="btn" id="al-go">Add</button>
  `, (sh) => {
    let month = mi;
    $('.chiprow .chip.on', sh)?.scrollIntoView({ inline: 'center', block: 'nearest' });
    $('#al-amt', sh).focus();
    $('#al-cats', sh).onclick = (e) => { const b = e.target.closest('.chip'); if (!b) return;
      sel = +b.dataset.row; $$('#al-cats .chip', sh).forEach((c) => c.classList.toggle('on', c === b)); };
    $('#al-months', sh).onclick = (e) => { const b = e.target.closest('.chip'); if (!b) return;
      month = +b.dataset.i; $$('#al-months .chip', sh).forEach((c) => c.classList.toggle('on', c === b)); };
    $('#al-go', sh).onclick = () => {
      const amount = parseFloat($('#al-amt', sh).value);
      if (!amount) return toast('Enter an amount', true);
      const note = $('#al-note', sh).value.trim();
      const cat = cats.find((c) => c.row === sel);
      submitWrite('addLarge', { fyId: S.cfg.fyId, tab: S.cfg.fyTab, row: sel, month, amount, mode: 'add', note },
        `${cat?.label} +${fmtS(amount)}`, () => {
          if (cat) {
            cat.cells[month].v = (cat.cells[month].v || 0) + amount;
            if (note) cat.cells[month].note = (cat.cells[month].note ? cat.cells[month].note + '\n' : '') + note;
          }
        });
    };
  });
}

function editCellSheet(row, month, isLarge) {
  const months = M.months();
  const r = (isLarge ? M.largeRows() : M.varRows()).find((x) => x.row === row);
  if (!r) return;
  const cur = isLarge ? (r.cells[month].v || 0) : (r.cells[month] || 0);
  const note = isLarge ? r.cells[month].note : '';
  openSheet(`
    <h2>${esc(r.label)}</h2><div class="sub">${esc(months[month])} · currently ${fmt(cur)}</div>
    <div class="seg" id="ec-mode">
      <button class="on" data-m="add">Add amount</button>
      <button data-m="set">Set total</button>
    </div>
    <div class="gap"></div>
    <div class="amount-input"><span class="cur">₹</span>
      <input id="ec-amt" inputmode="decimal" placeholder="0"></div>
    ${isLarge ? `<div class="gap"></div><div class="field"><label>Note for this cell</label>
      <textarea id="ec-note">${esc(note)}</textarea></div>` : ''}
    <div class="gap"></div>
    <button class="btn" id="ec-go">Save</button>
  `, (sh) => {
    let mode = 'add';
    $('#ec-mode', sh).onclick = (e) => { const b = e.target.closest('button'); if (!b) return;
      mode = b.dataset.m; $$('#ec-mode button', sh).forEach((x) => x.classList.toggle('on', x === b));
      $('#ec-amt', sh).value = mode === 'set' ? cur : ''; };
    $('#ec-amt', sh).focus();
    $('#ec-go', sh).onclick = () => {
      const amount = parseFloat($('#ec-amt', sh).value);
      if (isNaN(amount)) return toast('Enter an amount', true);
      const noteNew = isLarge ? $('#ec-note', sh).value.trim() : '';
      const action = isLarge ? 'addLarge' : 'addVariable';
      const noteChanged = isLarge && noteNew !== (note || '');
      const doWrite = async () => {
        if (noteChanged) await api('setNote', { fyId: S.cfg.fyId, tab: S.cfg.fyTab, row, month, note: noteNew }).catch(() => {});
      };
      submitWrite(action, { fyId: S.cfg.fyId, tab: S.cfg.fyTab, row, month, amount, mode, note: '' },
        `${r.label} ${mode === 'set' ? '=' : '+'}${fmtS(amount)}`, () => {
          const next = mode === 'set' ? amount : cur + amount;
          if (isLarge) { r.cells[month].v = next; if (noteChanged) r.cells[month].note = noteNew; }
          else r.cells[month] = next;
        }, doWrite);
    };
  });
}

function fixedEditSheet(row, col, label, val, isFormula, kind) {
  const what = kind === 'plan'
    ? (col === 'C' ? 'Planned per month' : 'Planned for the year')
    : (col === 'C' ? 'Monthly amount' : 'Amount');
  openSheet(`
    <h2>${esc(label)}</h2><div class="sub">${what} · currently ${fmt(val)}</div>
    ${isFormula ? `<div class="warn">This cell is calculated by a formula in your sheet${
      kind === 'plan' && col === 'B' ? ' — it currently just adds up the months' : ''}.
      Saving a number here replaces that formula permanently.</div>` : ''}
    <div class="amount-input"><span class="cur">₹</span>
      <input id="fx-amt" inputmode="decimal" value="${val ?? ''}"></div>
    <div class="gap"></div>
    <button class="btn" id="fx-go">Save to sheet</button>
  `, (sh) => {
    $('#fx-amt', sh).focus(); $('#fx-amt', sh).select?.();
    $('#fx-go', sh).onclick = () => {
      const value = parseFloat($('#fx-amt', sh).value);
      if (isNaN(value)) return toast('Enter a number', true);
      submitWrite('setValue', { fyId: S.cfg.fyId, tab: S.cfg.fyTab, row, col, value }, `${label} = ${fmtS(value)}`);
    };
  });
}

/* ─── bottom sheets: category management ───────────────────────────────── */
function nameSheet({ title, sub, value = '', cta, onSave }) {
  openSheet(`
    <h2>${esc(title)}</h2><div class="sub">${esc(sub)}</div>
    <div class="field"><label>Name</label>
      <input id="nm-val" value="${esc(value)}" placeholder="e.g. Gifts & donations" autocapitalize="sentences"></div>
    <button class="btn" id="nm-go">${esc(cta)}</button>
  `, (sh) => {
    const input = $('#nm-val', sh);
    input.focus(); input.select?.();
    const go = () => {
      const v = input.value.trim();
      if (!v) return toast('Name can’t be empty', true);
      closeSheet(); onSave(v);
    };
    $('#nm-go', sh).onclick = go;
    input.onkeydown = (e) => { if (e.key === 'Enter') go(); };
  });
}

function confirmSheet({ title, body, danger = 'Remove', onYes }) {
  openSheet(`
    <h2>${esc(title)}</h2><div class="sub">${esc(body)}</div>
    <button class="btn danger" id="cf-yes">${esc(danger)}</button>
    <div class="gap"></div>
    <button class="btn ghost" id="cf-no">Cancel</button>
  `, (sh) => {
    $('#cf-yes', sh).onclick = () => { closeSheet(); onYes(); };
    $('#cf-no', sh).onclick = () => closeSheet();
  });
}

function switchFY(id, label, tab) {
  S.cfg.fyId = id; S.cfg.fyTab = tab || null; S.cfg.fyLabel = label; saveCfg();
  S.model = cachedModel(); S.logs = [];
  renderIfCurrent(); refresh(!!S.model);
}

function fyPickerSheet() {
  openSheet(`
    <h2>Financial year</h2><div class="sub">Each FY is its own Google Sheet</div>
    <div class="card tight" style="box-shadow:none">
    ${S.fys.map((f) => `<button class="row" style="width:100%;text-align:left" data-fyid="${esc(f.id)}" data-fylabel="${esc(f.label)}" data-fytab="${esc(f.tab || '')}">
      <div class="dot">${esc(f.label.slice(2))}</div>
      <div class="grow"><div class="t">${esc(f.label)}</div><div class="s">${esc(f.name)}</div></div>
      ${f.id === S.cfg.fyId && (f.tab || null) === S.cfg.fyTab ? '<span class="good">✓</span>' : ''}
    </button>`).join('') || '<div class="empty">No FY sheets found</div>'}
    </div>`, (sh) => {
    sh.onclick = (e) => {
      const b = e.target.closest('[data-fyid]'); if (!b) return;
      switchFY(b.dataset.fyid, b.dataset.fylabel, b.dataset.fytab || null); closeSheet();
    };
  });
}

/* ─── write helpers ────────────────────────────────────────────────────── */

/* amount writes: optimistic, queued to the outbox if the network fails */
async function submitWrite(action, params, label, optimistic, extra) {
  closeSheet();
  optimistic?.();
  renderIfCurrent();
  toast('Saving…');
  try {
    await api(action, params);
    await extra?.();
    toast('Saved ✓');
    refresh(true);
  } catch (e) {
    if (/token|formula|Bad|Unknown|required|section/i.test(String(e.message))) {
      toast(e.message, true); refresh(true);
    } else {
      queueWrite(action, params, label);
      toast('Offline — queued, will sync later');
      renderIfCurrent();
    }
  }
}

/* structural writes: never queued — row numbers would go stale.
   The script returns the rebuilt model so the app re-syncs immediately. */
async function structuralWrite(action, params, okMsg) {
  toast('Saving…');
  try {
    const model = await api(action, { fyId: S.cfg.fyId, tab: S.cfg.fyTab, ...params });
    S.model = model;
    store.set('model.' + fyKey(), model);
    toast(okMsg);
    renderIfCurrent();
  } catch (e) {
    toast(e.name === 'AbortError' ? 'Timed out — nothing was changed' : e.message, true);
  }
}

/* ─── event binding per view ───────────────────────────────────────────── */
function bindView(name, arg) {
  if (name === 'setup') return bindSetup();

  $('#view').onclick = (e) => {
    const cell = e.target.closest('[data-cell]');
    if (cell) { const [row, mi] = cell.dataset.cell.split(':').map(Number); return editCellSheet(row, mi, false); }
    const act = e.target.closest('[data-act]');
    if (!act) return;
    e.preventDefault();          // plan badges live inside the category link
    const a = act.dataset;
    switch (a.act) {
      case 'fy': return fyPickerSheet();
      case 'theme': {
        S.cfg.theme = { auto: 'light', light: 'dark', dark: 'auto' }[S.cfg.theme] || 'auto';
        saveCfg(); applyTheme(); renderIfCurrent();
        return toast('Theme: ' + S.cfg.theme);
      }
      case 'add': return addExpenseSheet();
      case 'addlarge': return addLargeSheet(a.row ? +a.row : undefined);
      case 'editcell': return editCellSheet(+a.row, +a.month, a.large === '1');
      case 'fixed': return fixedEditSheet(+a.row, a.col, a.label, a.val === '' ? null : +a.val, a.fx === '1');
      case 'plan':  return fixedEditSheet(+a.row, a.col || 'B', a.label, a.val === '' ? null : +a.val,
                                          a.fx === '1', 'plan');

      /* category management */
      case 'addrow': {
        const cfg = SECTIONS[a.section];
        return nameSheet({
          title: `New ${cfg.noun}`, sub: `Added to the end of “${cfg.sub}” in your sheet`,
          value: '', cta: 'Add to sheet',
          onSave: (label) => structuralWrite('addRow', { section: a.section, label }, `Added “${label}”`),
        });
      }
      case 'rename': {
        const cfg = SECTIONS[a.section];
        return nameSheet({
          title: 'Rename', sub: `Currently “${a.label}”`, value: a.label, cta: 'Save name',
          onSave: (label) => structuralWrite('renameRow', { section: a.section, row: +a.row, label }, `Renamed to “${label}”`),
        });
      }
      case 'delrow': {
        const cfg = SECTIONS[a.section];
        return confirmSheet({
          title: `Remove “${a.label}”?`,
          body: `This deletes the whole row from your sheet, including every month’s amount${a.section === 'large' ? ' and note' : ''}. Totals will re-calculate.`,
          danger: `Remove ${cfg.noun}`,
          onYes: () => structuralWrite('deleteRow', { section: a.section, row: +a.row }, `Removed “${a.label}”`),
        });
      }

      case 'sync': return flushOutbox();
      case 'hardrefresh': toast('Refreshing…'); return refresh();
      case 'refys': return loadFYs().then(() => { renderIfCurrent(); toast('FY list updated'); });
      case 'testconn': {
        S.cfg.url = $('#st-url').value.trim(); S.cfg.token = $('#st-token').value.trim(); saveCfg();
        return api('ping').then(() => { toast('Connected ✓'); refresh(true); })
                          .catch((err) => toast(err.message, true));
      }
      case 'reset': return confirmSheet({
        title: 'Sign out of this device?',
        body: 'Clears the saved connection and cached figures here. Your Google Sheet is untouched.',
        danger: 'Sign out',
        onYes: () => { localStorage.clear(); location.hash = '#/'; location.reload(); },
      });
    }
  };

  if (name === 'settings') {
    $('#st-theme').onclick = (e) => {
      const b = e.target.closest('[data-theme]'); if (!b) return;
      S.cfg.theme = b.dataset.theme; saveCfg(); applyTheme(); renderIfCurrent();
    };
    $$('.chip[data-fyid]').forEach((c) => (c.onclick = () => switchFY(c.dataset.fyid, c.dataset.fylabel, c.dataset.fytab || null)));
  }

  if (name === 'months') {
    // park the matrix so the current month sits at the right edge, history to its left
    const wrap = $('.matrix-wrap'), cur = $('.matrix thead th.cur');
    if (wrap && cur) wrap.scrollLeft = Math.max(0, cur.offsetLeft + cur.offsetWidth - wrap.clientWidth + 24);
  }
}

/* ─── boot ─────────────────────────────────────────────────────────────── */
applyTheme();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
if (S.cfg.url && S.cfg.fyId) {
  S.model = cachedModel();
  refresh(!!S.model);
  if (!S.fys.length) loadFYs();
  flushOutbox();
}
route();
