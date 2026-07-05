/* LCK 선수 통계 — UI layer.
   Aggregation lives in agg.js (LCKAGG) so Node CI can verify it against
   src/queries.py. This file: data load, filters, URL state, rendering. */
'use strict';

const A = LCKAGG;
const METRICS = A.METRICS, DEC = A.DEC;

// ---------------------------------------------------------------- data
let G = null;      // games: {n, cols, displayName, nameLow}
let TG = null;     // teamgames
let SKMAP = null;  // "namelow|year|league" -> {sk, g}
let META = null;
let CHAMPIMG = null; // normalized champion name -> Data Dragon icon URL
let TEAMCOLORS = {}; // teamname -> brand accent hex (docs/team_colors.json)

const $ = (id) => document.getElementById(id);

function teamColor(name) {
  if (TEAMCOLORS[name]) return TEAMCOLORS[name];
  // deterministic pastel fallback for unmapped teams
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 45% 62%)`;
}
function teamDot(name) {
  return `<span class="tdot" style="background:${teamColor(name)}"></span>`;
}

// "most recent team (+ 외 N팀)" cell; hover lists every team with games.
// esc() is defined below but only called at render time, never at load.
function teamHistCell(r) {
  const cur = r['팀'];
  const hist = r._teams || [];
  const more = hist.length > 1
    ? ` <span class="tmore">외 ${hist.length - 1}팀</span>` : '';
  const tip = hist.length > 1
    ? ` title="${esc(hist.map(([t, n]) => `${t}: ${n}경기`).join('\n'))}"`
    : '';
  return `<span${tip}>${teamDot(cur)}${esc(cur)}${more}</span>`;
}

// Riot Data Dragon (official static assets). OE champion names match ddragon
// display names 1:1 (validated 171/171). Site degrades to text if offline.
async function loadDDragon() {
  try {
    const vers = await fetch('https://ddragon.leagueoflegends.com/api/versions.json')
      .then(r => r.json());
    const ver = vers[0];
    const data = await fetch(
      `https://ddragon.leagueoflegends.com/cdn/${ver}/data/en_US/champion.json`)
      .then(r => r.json());
    const map = {};
    for (const [id, o] of Object.entries(data.data)) {
      map[o.name.toLowerCase().replace(/[^a-z0-9]/g, '')] =
        `https://ddragon.leagueoflegends.com/cdn/${ver}/img/champion/${id}.png`;
    }
    CHAMPIMG = map;
  } catch { CHAMPIMG = null; }
}

function champCell(name) {
  if (!name) return '';
  const url = CHAMPIMG && CHAMPIMG[name.toLowerCase().replace(/[^a-z0-9]/g, '')];
  return (url ? `<img class="champ-ico" src="${url}" alt="" loading="lazy">` : '')
    + esc(name);
}

// icon only (name in tooltip) — for tight layouts like the records cards
function champIcon(name) {
  if (!name) return '';
  const url = CHAMPIMG && CHAMPIMG[name.toLowerCase().replace(/[^a-z0-9]/g, '')];
  return url
    ? `<img class="champ-ico" src="${url}" alt="${esc(name)}" title="${esc(name)}" loading="lazy">`
    : `<span title="${esc(name)}">${esc(name.slice(0, 6))}</span>`;
}

// Position -> Korean label + accent color (badges everywhere positions show)
const POS_BADGE = {
  top: ['탑', '#e0715c'], jng: ['정글', '#58b878'], mid: ['미드', '#5c9de0'],
  bot: ['원딜', '#c8aa6e'], sup: ['서폿', '#a97fd6'],
};
function posBadge(p) {
  const b = POS_BADGE[p];
  if (!b) return esc(p);
  return `<span class="posb" style="--pc:${b[1]}">${b[0]}</span>`;
}
const posLabel = (p) => POS_BADGE[p] ? POS_BADGE[p][0] : String(p);

async function loadAll() {
  const [g, tg, sk, meta, tc] = await Promise.all([
    fetch('data/games.json').then(r => r.json()),
    fetch('data/teamgames.json').then(r => r.json()),
    fetch('data/solokills.json').then(r => r.json()).catch(() => []),
    fetch('data/meta.json').then(r => r.json()).catch(() => ({})),
    fetch('team_colors.json').then(r => r.json()).catch(() => ({})),
    loadDDragon(),
  ]);
  TEAMCOLORS = tc || {};
  G = g; TG = tg; META = meta;
  SKMAP = new Map();
  for (const r of sk) SKMAP.set(`${r.key}|${r.year}|${r.league}`, { sk: r.sk, g: r.g });
  G.nameLow = G.cols.name.d.map(s => s.trim().toLowerCase());
}

// ---------------------------------------------------------------- state
// Casual-friendly default columns; the full 26-metric set is one click away.
const CORE_METRICS = ['경기수', '승률%', 'KDA', 'K', 'D', 'A', 'DPM', 'KP%'];

const state = {
  lckOnly: true,
  years: null, leagues: new Set(['LCK']), splits: null, rounds: null,
  positions: null, teams: null, patches: null, champs: null,
  completeOnly: false, minGames: 5,
  metrics: new Set(CORE_METRICS),   // null = all metrics
  sortKey: '경기수', sortDir: -1,
  tab: 'lb', pid: null, chartMetric: 'KDA',
  cmp: [], cmpMetric: 'KDA', rosterTeam: null,
  teamSortKey: '승률%', teamSortDir: -1,
  champSortKey: '경기수', champSortDir: -1,
};

const METRIC_HELP = {
  '승': '승리한 경기 수',
  '승률%': '승 ÷ 경기수 × 100',
  'KDA': '(킬+어시) ÷ 데스',
  'K': '경기당 평균 킬', 'D': '경기당 평균 데스', 'A': '경기당 평균 어시스트',
  'KP%': '킬 관여율 = (킬+어시) ÷ 팀 총 킬 ×100',
  'DPM': '분당 챔피언 피해량 (총딜 ÷ 총 경기시간). 포지션별 절대값 차이 큼',
  '딜비중%': '내 챔프 딜 ÷ 팀 5명 총딜 ×100. 캐리 의존도',
  'GPM': '분당 실획득 골드 (총골드 ÷ 총 경기시간)',
  'CS/분': '분당 미니언+정글 처치 (총CS ÷ 총 경기시간)',
  'GD@15': '15분 골드 차이 (상대 라이너 대비, + = 우위)',
  'CSD@15': '15분 CS 차이', 'XPD@15': '15분 경험치 차이',
  'FB%': '퍼스트블러드 관여율 (첫 킬 또는 첫 어시)',
  '피FB%': '퍼스트블러드 피살률',
  '데스/분': '분당 사망 수. 낮을수록 좋음',
  '데스지분%': '팀 총 데스 중 본인 비중',
  '받은딜/분': '분당 받은 피해량 (경기시간 가중)',
  '완화/분': '분당 피해 완화량 (경기시간 가중)',
  'DPG': '골드당 딜 = DPM ÷ GPM. 자원 효율',
  '시야/분': '분당 시야 점수',
  '챔프수': '사용한 고유 챔피언 수',
  '솔킬': 'gol.gg 기준 솔로킬 (연·리그 단위)',
  '솔킬/G': 'gol.gg 솔킬 ÷ 실제 출전 경기수(OE 기준, 연·리그)',
  '블루승률%': '블루 진영 승률', '레드승률%': '레드 진영 승률',
  '선수수': '이 챔피언을 플레이한 선수 수',
  '대표선수': '이 챔피언 최다 플레이어 (픽 수)',
};
const CHART_METRICS = ['KDA', 'DPM', 'GPM', 'CS/분', '승률%', 'KP%'];
const TABS = ['lb', 'detail', 'cmp', 'team', 'champs', 'records'];
const CMP_COLORS = ['#c8aa6e', '#5c9de0', '#e0715c'];
const RADAR_AXES = ['KDA', 'DPM', 'GPM', 'CS/분', 'KP%', '시야/분'];

function currentFilter() {
  return {
    lckOnly: state.lckOnly, years: state.years, leagues: state.leagues,
    splits: state.splits, rounds: state.rounds, positions: state.positions,
    teams: state.teams, patches: state.patches, champs: state.champs,
    completeOnly: state.completeOnly,
  };
}

// ---------------------------------------------------------------- URL state
// Sharable links: filters/tab/player live in the query string.
const URL_SETS = [
  ['years', 'y', true], ['leagues', 'lg', false], ['splits', 'sp', false],
  ['rounds', 'rd', false], ['positions', 'pos', false], ['teams', 'tm', false],
  ['patches', 'pt', false], ['champs', 'ch', false],
];

function stateToURL() {
  const p = new URLSearchParams();
  if (!state.lckOnly) p.set('lck', '0');
  for (const [key, short] of URL_SETS) {
    const sel = state[key];
    const isDefault = key === 'leagues'
      ? (sel && sel.size === 1 && sel.has('LCK'))
      : sel == null;
    if (isDefault) continue;
    p.set(short, sel == null ? 'all'
      : [...sel].map(v => encodeURIComponent(v)).join(','));
  }
  if (state.completeOnly) p.set('co', '1');
  if (state.metrics === null) p.set('mv', 'all');
  if (state.minGames !== 5) p.set('mg', String(state.minGames));
  if (state.tab !== 'lb') p.set('t', state.tab);
  if (state.tab === 'detail' && state.pid) p.set('p', state.pid);
  if (state.chartMetric !== 'KDA') p.set('cm', state.chartMetric);
  if (state.cmp.length) p.set('cmp', state.cmp.map(encodeURIComponent).join(','));
  if (state.rosterTeam) p.set('rt', state.rosterTeam);
  const qs = p.toString();
  history.replaceState(null, '', qs ? '?' + qs : location.pathname);
}

function urlToState() {
  const p = new URLSearchParams(location.search);
  if (p.get('lck') === '0') state.lckOnly = false;
  for (const [key, short, numeric] of URL_SETS) {
    const raw = p.get(short);
    if (raw == null) continue;
    if (raw === 'all') { state[key] = null; continue; }
    const vals = raw.split(',').map(decodeURIComponent);
    state[key] = new Set(numeric ? vals.map(Number) : vals);
  }
  if (p.get('co') === '1') state.completeOnly = true;
  if (p.get('mv') === 'all') state.metrics = null;
  const mg = parseInt(p.get('mg'), 10);
  if (mg >= 1 && mg <= 150) state.minGames = mg;
  if (TABS.includes(p.get('t'))) state.tab = p.get('t');
  if (p.get('p')) state.pid = p.get('p');
  if (CHART_METRICS.includes(p.get('cm'))) state.chartMetric = p.get('cm');
  if (p.get('cmp')) {
    state.cmp = p.get('cmp').split(',').map(decodeURIComponent).slice(0, 3);
  }
  if (p.get('rt')) state.rosterTeam = p.get('rt');
}

// ---------------------------------------------------------------- multiselect
const msInstances = {};

function makeMS(mountId, key, label, options, { searchable = false, format = null } = {}) {
  const mount = $(mountId);
  mount.innerHTML = '';
  mount.className = 'ms';
  const lab = document.createElement('div');
  lab.className = 'ms-label'; lab.textContent = label;
  const btn = document.createElement('button');
  btn.className = 'ms-btn'; btn.type = 'button';
  const panel = document.createElement('div');
  panel.className = 'ms-panel'; panel.hidden = true;
  mount.append(lab, btn, panel);

  const inst = { options, key, btn, panel };
  msInstances[key] = inst;

  function selected() { return state[key]; }
  function syncBtn() {
    const sel = selected();
    btn.textContent = (!sel || sel.size === 0) ? `전체 (${options.length})`
      : sel.size === 1 ? String([...sel][0]) : `${sel.size}개 선택`;
    btn.classList.toggle('some', !!(sel && sel.size));
  }
  inst.syncBtn = syncBtn;

  function rebuild() {
    panel.innerHTML = '';
    const tools = document.createElement('div');
    tools.className = 'ms-tools';
    const bAll = document.createElement('button');
    bAll.textContent = '전체'; bAll.type = 'button';
    bAll.onclick = () => { state[key] = null; syncBtn(); rebuild(); scheduleRender(); };
    const bNone = document.createElement('button');
    bNone.textContent = '해제'; bNone.type = 'button';
    bNone.onclick = () => { state[key] = new Set(); syncBtn(); rebuild(); scheduleRender(); };
    tools.append(bAll, bNone);
    panel.append(tools);

    if (searchable) {
      const inp = document.createElement('input');
      inp.className = 'ms-search'; inp.placeholder = '검색…';
      inp.oninput = () => {
        const qq = inp.value.trim().toLowerCase();
        panel.querySelectorAll('.ms-opt').forEach(el => {
          el.hidden = qq && !el.dataset.v.toLowerCase().includes(qq);
        });
      };
      panel.append(inp);
    }
    for (const v of options) {
      const row = document.createElement('label');
      row.className = 'ms-opt'; row.dataset.v = String(v);
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !selected() || selected().has(v);
      cb.onchange = () => {
        let sel = selected();
        if (!sel) { sel = new Set(options); state[key] = sel; }
        if (cb.checked) sel.add(v); else sel.delete(v);
        if (sel.size === options.length) state[key] = null;
        syncBtn(); scheduleRender();
      };
      const span = document.createElement('span');
      span.textContent = format ? format(v) : String(v);
      row.append(cb, span);
      panel.append(row);
    }
  }

  btn.onclick = (e) => {
    e.stopPropagation();
    const open = !panel.hidden;
    closeAllMS();
    if (!open) { rebuild(); panel.hidden = false; }
  };
  syncBtn();
  return inst;
}

function closeAllMS() {
  document.querySelectorAll('.ms-panel').forEach(p => { p.hidden = true; });
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.ms')) closeAllMS();
  if (!e.target.closest('.player-search')) {
    $('playerList').hidden = true;
    $('cmpList').hidden = true;
  }
});

// ---------------------------------------------------------------- helpers
function fmt(v, nd) {
  if (v == null || Number.isNaN(v)) return '–';
  return v.toLocaleString('ko-KR', { minimumFractionDigits: nd, maximumFractionDigits: nd });
}
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function patchSort(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  if (pa.some(isNaN) || pb.some(isNaN)) return a < b ? -1 : 1;
  return (pa[0] - pb[0]) || (pa[1] - pb[1]);
}
function visibleMetrics() {
  return METRICS.map(m => m[0]).filter(k => !state.metrics || state.metrics.has(k));
}

// Metrics where a LOW value is the good side (bar direction flips).
const LOWER_BETTER = new Set(['D', '데스/분', '데스지분%', '피FB%']);

// Per-column rank percentile over the displayed rows -> subtle gold bar in
// each cell, so relative standing reads at a glance without knowing the stat.
function colPercentiles(rows, keys) {
  const out = {};
  for (const k of keys) {
    const vals = rows.map(r => r[k]).filter(v => v != null && !Number.isNaN(v))
      .sort((a, b) => a - b);
    if (vals.length < 3) { out[k] = null; continue; }
    out[k] = (v) => {
      if (v == null || Number.isNaN(v)) return null;
      let lo = 0, hi = vals.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (vals[m] < v) lo = m + 1; else hi = m; }
      let p = lo / (vals.length - 1);
      if (p > 1) p = 1;
      return LOWER_BETTER.has(k) ? 1 - p : p;
    };
  }
  return out;
}

function pctBarStyle(pf, v) {
  const p = pf && pf(v);
  if (p == null) return '';
  return ` style="background:linear-gradient(90deg,rgba(200,170,110,.16) ${(p * 100).toFixed(0)}%,transparent 0)"`;
}
function rowSeason(i) {
  const c = G.cols;
  return `${c.year[i]} ${c.split.d[c.split.i[i]]} · ${c.round.d[c.round.i[i]]}`;
}

// ---------------------------------------------------------------- rendering
let renderTimer = null;
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderAll, 90);
}

let curRows = [];
let curLB = [];

function renderAll() {
  curRows = A.filterRows(G, currentFilter());
  stateToURL();
  renderSummary();
  renderLeaderboard();
  renderDetail();
  renderCompare();
  renderTeams();
  renderChampions();
  renderRecords();
}

function renderSummary() {
  const c = G.cols;
  const pids = new Set(), teams = new Set();
  let y0 = Infinity, y1 = -Infinity;
  for (const i of curRows) {
    pids.add(c.pid.i[i]); teams.add(c.team.i[i]);
    const y = c.year[i];
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const cards = [
    [curRows.length.toLocaleString(), '경기 행 수'],
    [pids.size.toLocaleString(), '선수 수'],
    [teams.size.toLocaleString(), '팀 수'],
    [curRows.length ? `${y0}–${y1}` : '–', '기간'],
  ];
  $('summaryCards').innerHTML = cards.map(([v, k]) =>
    `<div class="card"><div class="cv">${v}</div><div class="ck">${k}</div></div>`).join('');
}

function sortRows(rows, key, dir) {
  const isTxt = ['선수', '팀', '포지션', '챔피언', '대표선수'].includes(key);
  rows.sort((a, b) => {
    const va = a[key], vb = b[key];
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (isTxt) return dir * String(va).localeCompare(String(vb), 'ko');
    return dir * (va - vb);
  });
}

function sortableTable(wrapId, headCols, txtCols, rows, cellFn, sortState, onSort) {
  const ths = headCols.map(h => {
    if (h === '#') return '<th>#</th>';
    const sorted = sortState.key === h;
    const arr = sorted ? `<span class="arr">${sortState.dir < 0 ? '▼' : '▲'}</span>` : '';
    const cls = txtCols.includes(h) ? 'txt' : '';
    const help = METRIC_HELP[h] ? ` title="${esc(METRIC_HELP[h])}"` : '';
    return `<th class="${cls}${sorted ? ' sorted' : ''}" data-k="${esc(h)}"${help}>${esc(h)}${arr}</th>`;
  }).join('');
  const body = rows.map(cellFn).join('');
  $(wrapId).innerHTML = `<table><thead><tr>${ths}</tr></thead><tbody>${body}</tbody></table>`;
  $(wrapId).querySelectorAll('th[data-k]').forEach(th => {
    th.onclick = () => onSort(th.dataset.k, txtCols.includes(th.dataset.k));
  });
}

function renderLeaderboard() {
  curLB = A.buildLeaderboard(G, SKMAP, curRows, state.minGames);
  sortRows(curLB, state.sortKey, state.sortDir);
  const mets = visibleMetrics();
  const showSK = mets.includes('솔킬') || mets.includes('솔킬/G');
  $('skNote').hidden = !(showSK && SKMAP.size);
  $('lbNote').innerHTML = curLB.length
    ? `<b>${curLB.length}</b>명 (최소 ${state.minGames}경기)` : '';
  if (!curLB.length) {
    $('lbWrap').innerHTML = `<div class="empty">조건을 만족하는 선수가 없습니다. 필터를 완화해 보세요.</div>`;
    return;
  }
  $('btnMetricsMode').textContent = state.metrics === null ? '핵심 지표만' : '전체 지표 보기';
  const P = colPercentiles(curLB, mets);
  sortableTable('lbWrap', ['#', '선수', '팀', '포지션', ...mets], ['선수', '팀', '포지션'],
    curLB,
    (r, idx) => {
      const tds = mets.map(k => {
        let cls = '';
        if (k === '승률%' && r[k] != null) cls = r[k] >= 55 ? ' class="pct-hi"' : (r[k] < 45 ? ' class="pct-lo"' : '');
        return `<td${cls}${pctBarStyle(P[k], r[k])}>${fmt(r[k], DEC[k])}</td>`;
      }).join('');
      return `<tr data-pid="${esc(r._pid)}"><td class="rank">${idx + 1}</td>` +
        `<td class="txt player">${esc(r['선수'])}</td>` +
        `<td class="txt">${teamHistCell(r)}</td><td class="txt">${posBadge(r['포지션'])}</td>${tds}</tr>`;
    },
    { key: state.sortKey, dir: state.sortDir },
    (k, isTxt) => {
      if (state.sortKey === k) state.sortDir *= -1;
      else { state.sortKey = k; state.sortDir = isTxt ? 1 : -1; }
      renderLeaderboard();
    });
  $('lbWrap').querySelectorAll('tbody tr').forEach(tr => {
    tr.ondblclick = () => { selectPlayer(tr.dataset.pid); switchTab('detail'); };
  });
}

function csvDownload() {
  const mets = METRICS.map(m => m[0]);
  const head = ['선수', '팀', '포지션', ...mets];
  const lines = [head.join(',')];
  for (const r of curLB) {
    lines.push(head.map(k => {
      const v = r[k];
      if (v == null) return '';
      const s = String(typeof v === 'number' ? +v.toFixed(DEC[k] ?? 2) : v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(','));
  }
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'lck_players.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------------------------------------------------------------- detail
function playerPool() {
  const c = G.cols;
  const games = new Map();
  for (const i of curRows) {
    const p = c.pid.i[i];
    games.set(p, (games.get(p) || 0) + 1);
  }
  const arr = [...games.entries()].map(([code, n]) => {
    const pidStr = c.pid.d[code];
    return { pid: pidStr, name: G.displayName[pidStr] || '?', games: n };
  });
  arr.sort((a, b) => b.games - a.games);
  return arr;
}

function selectPlayer(pid) {
  state.pid = pid;
  $('playerSearch').value = G.displayName[pid] || '';
  renderDetail();
  stateToURL();
}

function renderPlayerList(query) {
  const pool = playerPool();
  const qq = (query || '').trim().toLowerCase();
  const list = pool.filter(p => !qq || p.name.toLowerCase().includes(qq)).slice(0, 60);
  const box = $('playerList');
  box.innerHTML = list.map(p =>
    `<div data-pid="${esc(p.pid)}"><span>${esc(p.name)}</span><small>${p.games}경기</small></div>`).join('');
  box.hidden = !list.length;
  box.querySelectorAll('div[data-pid]').forEach(el => {
    el.onclick = () => { box.hidden = true; selectPlayer(el.dataset.pid); };
  });
}

function seasonalGroups(pidStr) {
  const c = G.cols;
  const pidCode = c.pid.d.indexOf(pidStr);
  const groups = new Map();
  for (const i of curRows) {
    if (c.pid.i[i] !== pidCode) continue;
    const y = c.year[i], s = c.split.d[c.split.i[i]],
      rd = c.round.d[c.round.i[i]], lg = c.league.d[c.league.i[i]];
    const key = `${y}|${s}|${rd}|${lg}`;
    let g = groups.get(key);
    if (!g) { g = { year: y, split: s, round: rd, league: lg, acc: A.newAcc() }; groups.set(key, g); }
    A.accAdd(g.acc, i, G);
  }
  const arr = [...groups.values()];
  arr.sort((a, b) => (a.year - b.year) ||
    a.split.localeCompare(b.split) || a.round.localeCompare(b.round, 'ko') ||
    a.league.localeCompare(b.league));
  return arr.map(g => ({
    ...g, m: A.accFinish(g.acc, SKMAP),
    team: A.topOf(g.acc.teams), nTeams: g.acc.teams.size,
  }));
}

function champGroupsOf(pidStr) {
  const c = G.cols;
  const pidCode = c.pid.d.indexOf(pidStr);
  const byChamp = new Map();
  for (const i of curRows) {
    if (c.pid.i[i] !== pidCode) continue;
    const ch = c.champ.d[c.champ.i[i]];
    let acc = byChamp.get(ch);
    if (!acc) { acc = A.newAcc(); byChamp.set(ch, acc); }
    A.accAdd(acc, i, G);
  }
  const arr = [...byChamp.entries()].map(([ch, acc]) => ({ champ: ch, m: A.accFinish(acc, null) }));
  arr.sort((a, b) => b.m['경기수'] - a.m['경기수']);
  return arr;
}

function lineChartSVG(labels, fullLabels, values, metric) {
  // Fixed pixel scale (never stretched to the container), so text stays a
  // constant 10px; long careers scroll horizontally instead of squeezing.
  const n = labels.length;
  const pts = values.map((v, i) => ({ v, i })).filter(p => p.v != null);
  if (!pts.length) return '<div class="empty">데이터 없음</div>';
  const padL = 48, padR = 20, padT = 24, padB = 58, H = 280, per = 58;
  const W = Math.max(560, padL + padR + (n - 1) * per);
  const vmin = Math.min(...pts.map(p => p.v)), vmax = Math.max(...pts.map(p => p.v));
  const span = (vmax - vmin) || 1;
  const y = v => padT + (H - padT - padB) * (1 - (v - vmin + span * .08) / (span * 1.16));
  const x = i => n === 1 ? padL + (W - padL - padR) / 2 :
    padL + (W - padL - padR) * (i / (n - 1));
  let grid = '', gtxt = '';
  for (let g = 0; g <= 3; g++) {
    const gv = vmin + span * g / 3;
    grid += `<line class="c-grid" x1="${padL}" x2="${W - padR}" y1="${y(gv)}" y2="${y(gv)}"/>`;
    gtxt += `<text class="c-txt" x="${padL - 6}" y="${y(gv) + 3}" text-anchor="end">${fmt(gv, DEC[metric] ?? 1)}</text>`;
  }
  const poly = pts.map(p => `${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  // Value labels: every point when readable; min/max/last on long careers.
  let valIdx = null;
  if (n > 30) {
    valIdx = new Set([pts[pts.length - 1].i]);
    let lo = pts[0], hi = pts[0];
    for (const p of pts) { if (p.v < lo.v) lo = p; if (p.v > hi.v) hi = p; }
    valIdx.add(lo.i); valIdx.add(hi.i);
  }
  const dots = pts.map(p =>
    `<circle class="c-dot" cx="${x(p.i).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="3.2"><title>${esc(fullLabels[p.i])}: ${fmt(p.v, DEC[metric] ?? 2)}</title></circle>` +
    ((valIdx && !valIdx.has(p.i)) ? '' :
      `<text class="c-val" x="${x(p.i).toFixed(1)}" y="${(y(p.v) - 8).toFixed(1)}" text-anchor="middle">${fmt(p.v, DEC[metric] ?? 1)}</text>`)
  ).join('');
  const step = n > 60 ? 2 : 1;
  const xlab = labels.map((lb, i) => (i % step) ? '' :
    `<text class="c-txt" x="${x(i).toFixed(1)}" y="${H - padB + 14}" text-anchor="end" transform="rotate(-35 ${x(i).toFixed(1)} ${H - padB + 14})">${esc(lb)}</text>`
  ).join('');
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">` +
    grid + gtxt + `<polyline class="c-line" points="${poly}"/>` + dots + xlab + '</svg>';
}

function metricTable(idCols, rows, mets, fmtMap = {}) {
  const ths = [...idCols, ...mets].map(h => {
    const cls = idCols.includes(h) ? ' class="txt"' : '';
    const help = METRIC_HELP[h] ? ` title="${esc(METRIC_HELP[h])}"` : '';
    return `<th${cls}${help} style="cursor:default">${esc(h)}</th>`;
  }).join('');
  const body = rows.map(r =>
    '<tr>' + idCols.map(k => `<td class="txt">${
      fmtMap[k] ? fmtMap[k](r[k]) : esc(r[k] ?? '')
    }</td>`).join('') +
    mets.map(k => `<td>${fmt(r[k], DEC[k])}</td>`).join('') + '</tr>'
  ).join('');
  return `<div class="table-wrap"><table><thead><tr>${ths}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderDetail() {
  const body = $('detailBody');
  const pool = playerPool();
  if (!pool.length) { body.innerHTML = '<div class="empty">필터 조건에 해당하는 선수가 없습니다.</div>'; return; }
  if (!state.pid || !pool.some(p => p.pid === state.pid)) {
    state.pid = pool[0].pid;
    $('playerSearch').value = G.displayName[state.pid] || '';
  }
  const pid = state.pid;
  const name = G.displayName[pid] || '?';
  const seas = seasonalGroups(pid);
  const champs = champGroupsOf(pid);
  const mets = visibleMetrics();

  // profile header: overall stats over the current filter
  const c = G.cols;
  const pidCode = c.pid.d.indexOf(pid);
  const acc = A.newAcc();
  for (const i of curRows) if (c.pid.i[i] === pidCode) A.accAdd(acc, i, G);
  const tot = A.accFinish(acc, SKMAP);
  const headChips = [
    ['경기', fmt(tot['경기수'], 0)], ['승률', fmt(tot['승률%'], 1) + '%'],
    ['KDA', fmt(tot['KDA'], 2)], ['DPM', fmt(tot['DPM'], 0)],
    ['KP%', fmt(tot['KP%'], 1) + '%'],
  ].map(([k, v]) =>
    `<div class="ph-chip"><span>${k}</span><b>${v}</b></div>`).join('');
  const mainTeam = acc.lastTeam || A.topOf(acc.teams);
  const teamsTip = acc.teams.size > 1
    ? ` title="${esc([...acc.teams.entries()].sort((a, b) => b[1] - a[1])
        .map(([t, n]) => `${t}: ${n}경기`).join('\n'))}"`
    : '';
  const teamsMore = acc.teams.size > 1
    ? ` <span class="tmore">외 ${acc.teams.size - 1}팀</span>` : '';
  const headHtml =
    `<div class="player-head">` +
    `<div class="ph-name">${esc(name)}</div>` +
    `<div class="ph-meta"><span${teamsTip}>${teamDot(mainTeam)}${esc(mainTeam)}${teamsMore}</span> ${posBadge(A.topOf(acc.poss))}` +
    ` <button type="button" class="btn ghost slim" id="btnAddCmp">+ 비교</button></div>` +
    `<div class="ph-chips">${headChips}</div></div>`;

  // Short x-axis labels ("'23 Spring PO", "'24 MSI"); full text in tooltips.
  const shortLabel = s => {
    const sp = s.split === '기타/국제' ? s.league : s.split;
    const po = s.round === '플레이오프' ? ' PO' : '';
    return `'${String(s.year).slice(2)} ${sp}${po}`;
  };
  const labels = seas.map(shortLabel);
  const fullLabels = seas.map(s => `${s.year} ${s.split} · ${s.round} (${s.league})`);
  const values = seas.map(s => s.m[state.chartMetric]);
  const seasRows = seas.map(s => ({
    '년도': s.year, '시즌': s.split, '라운드': s.round, '대회': s.league,
    '팀': s.team + (s.nTeams > 1 ? ` 외 ${s.nTeams - 1}` : ''), ...s.m,
  }));
  const champRows = champs.map(cch => ({ '챔피언': cch.champ, ...cch.m }));

  body.innerHTML =
    headHtml +
    `<h3 class="detail-h">시즌별 추이 <span style="color:var(--muted);font-size:13px;font-weight:400">(${state.chartMetric})</span></h3>` +
    `<div class="chart-box"><div class="chart-scroll">${lineChartSVG(labels, fullLabels, values, state.chartMetric)}</div></div>` +
    metricTable(['년도', '시즌', '라운드', '대회', '팀'], seasRows, mets,
      { '팀': v => teamDot(String(v).replace(/ 외 \d+$/, '')) + esc(v) }) +
    `<h3 class="detail-h">챔피언 폭 <span style="color:var(--muted);font-size:13px;font-weight:400">(${champs.length}챔피언)</span></h3>` +
    metricTable(['챔피언'], champRows, mets, { '챔피언': champCell });
  // show the most recent seasons first on long careers
  const sc = body.querySelector('.chart-scroll');
  if (sc) sc.scrollLeft = sc.scrollWidth;
  const addBtn = body.querySelector('#btnAddCmp');
  if (addBtn) addBtn.onclick = () => { addToCmp(pid); switchTab('cmp'); };
}

// ---------------------------------------------------------------- compare
function addToCmp(pid) {
  if (!pid || state.cmp.includes(pid) || state.cmp.length >= 3) return;
  state.cmp.push(pid);
  renderCompare();
  stateToURL();
}

function positionPercentile(poolRows, pos, metric, value) {
  if (value == null) return null;
  let pool = poolRows.filter(r => r['포지션'] === pos)
    .map(r => r[metric]).filter(v => v != null);
  if (pool.length < 8) {
    pool = poolRows.map(r => r[metric]).filter(v => v != null);
  }
  if (pool.length < 2) return null;
  pool.sort((a, b) => a - b);
  let lo = 0, hi = pool.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (pool[m] < value) lo = m + 1; else hi = m; }
  return Math.min(1, lo / (pool.length - 1));
}

function radarSVG(sel, pool) {
  const W = 470, H = 430, cx = W / 2, cy = H / 2 + 4, R = 148;
  const N = RADAR_AXES.length;
  const pt = (k, r) => {
    const a = (-90 + k * 360 / N) * Math.PI / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };
  let grid = '';
  for (const frac of [0.25, 0.5, 0.75, 1]) {
    const ring = Array.from({ length: N }, (_, k) => pt(k, R * frac).map(v => v.toFixed(1)).join(',')).join(' ');
    grid += `<polygon class="r-grid" points="${ring}"/>`;
  }
  for (let k = 0; k < N; k++) {
    const [x, y] = pt(k, R);
    grid += `<line class="r-grid" x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>`;
    const [lx, ly] = pt(k, R + 22);
    grid += `<text class="r-lab" x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" text-anchor="middle">${esc(RADAR_AXES[k])}</text>`;
  }
  let shapes = '';
  sel.forEach((s, i) => {
    if (!s.row) return;
    const color = CMP_COLORS[i];
    const verts = RADAR_AXES.map((m, k) => {
      const v = s.row[m];
      const p = positionPercentile(pool, s.row['포지션'], m, v) ?? 0;
      return { m, v, p, xy: pt(k, R * p) };
    });
    const pts = verts.map(vv => vv.xy.map(n => n.toFixed(1)).join(',')).join(' ');
    shapes += `<polygon points="${pts}" fill="${color}26" stroke="${color}" stroke-width="2"/>`;
    shapes += verts.map(vv =>
      `<circle cx="${vv.xy[0].toFixed(1)}" cy="${vv.xy[1].toFixed(1)}" r="3.4" fill="${color}">` +
      `<title>${esc(s.row['선수'])} ${esc(vv.m)}: ${fmt(vv.v, DEC[vv.m])} (백분위 ${Math.round(vv.p * 100)})</title></circle>`
    ).join('');
  });
  return `<div class="chart-box radar-box">` +
    `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${grid}${shapes}</svg>` +
    `<p class="note dim">각 축은 현재 필터에서 <b>같은 포지션</b> 선수들(최소 ${state.minGames}경기) 대비 백분위(0~100). 점에 마우스를 올리면 실제 값이 표시됩니다.</p></div>`;
}

function cmpTrendSVG(sel) {
  const c = G.cols;
  const codeOf = new Map(sel.map(s => [s.pid, c.pid.d.indexOf(s.pid)]));
  const perYear = new Map(); // pid -> Map(year -> acc)
  for (const s of sel) perYear.set(s.pid, new Map());
  for (const i of curRows) {
    for (const s of sel) {
      if (c.pid.i[i] !== codeOf.get(s.pid)) continue;
      const ym = perYear.get(s.pid);
      let acc = ym.get(c.year[i]);
      if (!acc) { acc = A.newAcc(); ym.set(c.year[i], acc); }
      A.accAdd(acc, i, G);
    }
  }
  const years = [...new Set([].concat(...[...perYear.values()].map(m => [...m.keys()])))]
    .sort((a, b) => a - b);
  if (!years.length) return '';
  const series = sel.map((s, i) => ({
    name: G.displayName[s.pid] || '?', color: CMP_COLORS[i],
    vals: years.map(y => {
      const acc = perYear.get(s.pid).get(y);
      return acc ? A.accFinish(acc, null)[state.cmpMetric] : null;
    }),
  }));
  const padL = 48, padR = 20, padT = 30, padB = 34, H = 260;
  const W = Math.max(560, padL + padR + (years.length - 1) * 72);
  const all = series.flatMap(s => s.vals).filter(v => v != null);
  if (!all.length) return '';
  const vmin = Math.min(...all), vmax = Math.max(...all);
  const span = (vmax - vmin) || 1;
  const y = v => padT + (H - padT - padB) * (1 - (v - vmin + span * .08) / (span * 1.16));
  const x = i => years.length === 1 ? W / 2 : padL + (W - padL - padR) * (i / (years.length - 1));
  let out = '';
  for (let g = 0; g <= 3; g++) {
    const gv = vmin + span * g / 3;
    out += `<line class="c-grid" x1="${padL}" x2="${W - padR}" y1="${y(gv)}" y2="${y(gv)}"/>` +
      `<text class="c-txt" x="${padL - 6}" y="${y(gv) + 3}" text-anchor="end">${fmt(gv, DEC[state.cmpMetric] ?? 1)}</text>`;
  }
  out += years.map((yr, i) =>
    `<text class="c-txt" x="${x(i).toFixed(1)}" y="${H - 12}" text-anchor="middle">${yr}</text>`).join('');
  for (const s of series) {
    const pts = s.vals.map((v, i) => v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`)
      .filter(Boolean).join(' ');
    out += `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2"/>`;
    out += s.vals.map((v, i) => v == null ? '' :
      `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3.2" fill="${s.color}">` +
      `<title>${esc(s.name)} ${yr(years[i])}: ${fmt(v, DEC[state.cmpMetric] ?? 2)}</title></circle>`).join('');
  }
  function yr(v) { return v; }
  const legend = series.map(s =>
    `<span class="cl-item"><span class="cl-dot" style="background:${s.color}"></span>${esc(s.name)}</span>`).join('');
  const metricSel = `<select id="cmpMetricSel" class="select slim">` +
    CHART_METRICS.map(m => `<option${m === state.cmpMetric ? ' selected' : ''}>${m}</option>`).join('') + `</select>`;
  return `<div class="chart-box"><div class="cmp-trend-head">${metricSel}<div class="c-legend">${legend}</div></div>` +
    `<div class="chart-scroll"><svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${out}</svg></div></div>`;
}

function cmpTableHTML(sel) {
  const mets = visibleMetrics();
  const heads = sel.map((s, i) => {
    const nm = G.displayName[s.pid] || '?';
    const sub = s.row
      ? `${teamDot(s.row['팀'])}${esc(s.row['팀'])} · ${posLabel(s.row['포지션'])} · ${s.row['경기수']}경기`
      : '필터 내 데이터 없음';
    return `<th class="cmp-col" style="--cc:${CMP_COLORS[i]}"><div class="cmp-name">${esc(nm)}</div><div class="cmp-sub">${sub}</div></th>`;
  }).join('');
  const rows = mets.map(m => {
    const vals = sel.map(s => s.row ? s.row[m] : null);
    const usable = vals.filter(v => v != null);
    let bestIdx = -1;
    if (usable.length > 1) {
      const best = LOWER_BETTER.has(m) ? Math.min(...usable) : Math.max(...usable);
      const matches = vals.map((v, i) => v === best ? i : -1).filter(i => i >= 0);
      if (matches.length === 1) bestIdx = matches[0];
    }
    const help = METRIC_HELP[m] ? ` title="${esc(METRIC_HELP[m])}"` : '';
    return `<tr><td class="txt"${help}>${esc(m)}</td>` + vals.map((v, i) =>
      `<td class="${i === bestIdx ? 'cmp-best' : ''}">${fmt(v, DEC[m])}</td>`).join('') + '</tr>';
  }).join('');
  return `<div class="table-wrap cmp-table"><table><thead><tr><th class="txt">지표</th>${heads}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderCmpSlots() {
  $('cmpSlots').innerHTML = state.cmp.map((pid, i) =>
    `<span class="cmp-chip" style="--cc:${CMP_COLORS[i]}">${esc(G.displayName[pid] || pid)}` +
    `<button type="button" data-i="${i}" aria-label="제거">×</button></span>`).join('');
  $('cmpSlots').querySelectorAll('button').forEach(b => {
    b.onclick = () => {
      state.cmp.splice(+b.dataset.i, 1);
      renderCompare();
      stateToURL();
    };
  });
  const inp = $('cmpSearch');
  inp.disabled = state.cmp.length >= 3;
  inp.placeholder = state.cmp.length >= 3 ? '최대 3명' : '선수 추가 (최대 3명)…';
}

function renderCmpList(query) {
  const pool = playerPool().filter(p => !state.cmp.includes(p.pid));
  const qq = (query || '').trim().toLowerCase();
  const list = pool.filter(p => !qq || p.name.toLowerCase().includes(qq)).slice(0, 60);
  const box = $('cmpList');
  box.innerHTML = list.map(p =>
    `<div data-pid="${esc(p.pid)}"><span>${esc(p.name)}</span><small>${p.games}경기</small></div>`).join('');
  box.hidden = !list.length;
  box.querySelectorAll('div[data-pid]').forEach(el => {
    el.onclick = () => {
      box.hidden = true;
      $('cmpSearch').value = '';
      addToCmp(el.dataset.pid);
    };
  });
}

function renderCompare() {
  renderCmpSlots();
  const body = $('cmpBody');
  if (!state.cmp.length) {
    body.innerHTML = '<div class="empty">검색창에서 선수를 추가하세요 (2~3명 비교).<br>' +
      '선수 상세 탭의 "+ 비교" 버튼, 또는 리더보드 더블클릭 → 상세에서도 추가할 수 있습니다.</div>';
    return;
  }
  const lbAll = A.buildLeaderboard(G, SKMAP, curRows, 1);
  const by = new Map(lbAll.map(r => [r._pid, r]));
  const sel = state.cmp.map(pid => ({ pid, row: by.get(pid) || null }));
  const pool = A.buildLeaderboard(G, SKMAP, curRows, state.minGames);
  body.innerHTML = radarSVG(sel, pool) + cmpTrendSVG(sel) + cmpTableHTML(sel);
  const s = $('cmpMetricSel');
  if (s) s.onchange = () => { state.cmpMetric = s.value; renderCompare(); };
}

// ---------------------------------------------------------------- teams
function renderTeams() {
  const rows = A.buildTeams(TG, currentFilter(), state.minGames);
  if (!rows.length) {
    $('teamWrap').innerHTML = '<div class="empty">조건을 만족하는 팀이 없습니다.</div>';
    $('teamBars').innerHTML = '';
    renderRoster();
    return;
  }
  sortRows(rows, state.teamSortKey, state.teamSortDir);
  sortableTable('teamWrap', ['팀', '경기수', '승', '승률%', '블루승률%', '레드승률%'], ['팀'],
    rows,
    r => `<tr class="team-row${r['팀'] === state.rosterTeam ? ' me' : ''}" data-team="${esc(r['팀'])}">` +
      `<td class="txt player">${teamDot(r['팀'])}${esc(r['팀'])}</td>` +
      ['경기수', '승', '승률%', '블루승률%', '레드승률%'].map(cc =>
        `<td>${fmt(r[cc], cc === '경기수' || cc === '승' ? 0 : 1)}</td>`).join('') + '</tr>',
    { key: state.teamSortKey, dir: state.teamSortDir },
    (k, isTxt) => {
      if (state.teamSortKey === k) state.teamSortDir *= -1;
      else { state.teamSortKey = k; state.teamSortDir = isTxt ? 1 : -1; }
      renderTeams();
    });
  $('teamWrap').querySelectorAll('tr.team-row').forEach(tr => {
    tr.onclick = () => {
      state.rosterTeam = tr.dataset.team === state.rosterTeam ? null : tr.dataset.team;
      renderRoster();
      renderTeams();
      stateToURL();
      if (state.rosterTeam) $('rosterBox').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };
  });
  renderRoster();
  const byWr = [...rows].sort((a, b) => b['승률%'] - a['승률%']);
  $('teamBars').innerHTML = byWr.map(r => {
    const col = teamColor(r['팀']);
    return `<div class="tb-row"><div class="tb-name">${teamDot(r['팀'])}${esc(r['팀'])}</div>` +
      `<div class="tb-track"><div class="tb-fill" style="width:${r['승률%'].toFixed(1)}%;background:linear-gradient(90deg,color-mix(in srgb,${col} 45%,#333),${col})"></div></div>` +
      `<div class="tb-val">${r['승률%'].toFixed(1)}%</div></div>`;
  }).join('');
}

// ---------------------------------------------------------------- roster
const POS_ORDER = ['top', 'jng', 'mid', 'bot', 'sup'];

function buildRoster(team) {
  const c = G.cols;
  const code = c.team.d.indexOf(team);
  if (code < 0) return [];
  const seasons = new Map(); // "year|split" -> {year, split, players: Map(pidCode -> {games, pos Map})}
  for (const i of curRows) {
    if (c.team.i[i] !== code) continue;
    const key = `${c.year[i]}|${c.split.d[c.split.i[i]]}`;
    let s = seasons.get(key);
    if (!s) {
      s = { year: c.year[i], split: c.split.d[c.split.i[i]], players: new Map() };
      seasons.set(key, s);
    }
    const p = c.pid.i[i];
    let pl = s.players.get(p);
    if (!pl) { pl = { games: 0, pos: new Map() }; s.players.set(p, pl); }
    pl.games++;
    const ps = c.pos.d[c.pos.i[i]];
    pl.pos.set(ps, (pl.pos.get(ps) || 0) + 1);
  }
  const arr = [...seasons.values()]
    .sort((a, b) => (b.year - a.year) || a.split.localeCompare(b.split));
  return arr.map(s => {
    const byPos = { top: [], jng: [], mid: [], bot: [], sup: [], etc: [] };
    for (const [pcode, pl] of s.players) {
      const pidStr = c.pid.d[pcode];
      const slot = byPos[A.topOf(pl.pos)] || byPos.etc;
      slot.push({ pid: pidStr, name: G.displayName[pidStr] || '?', games: pl.games });
    }
    for (const k of Object.keys(byPos)) byPos[k].sort((a, b) => b.games - a.games);
    return { year: s.year, split: s.split, byPos };
  });
}

function renderRoster() {
  const box = $('rosterBox');
  if (!state.rosterTeam) { box.innerHTML = ''; return; }
  const team = state.rosterTeam;
  const seasons = buildRoster(team);
  const head = `<div class="roster-head">${teamDot(team)}<b>${esc(team)}</b> 시즌별 로스터` +
    ` <span class="note dim">(현재 필터 기준 · 괄호는 출전 경기수, 첫 번째가 주전)</span>` +
    `<button type="button" class="btn ghost slim" id="btnRosterClose">닫기 ×</button></div>`;
  if (!seasons.length) {
    box.innerHTML = `<div class="roster-box">${head}<div class="empty">현재 필터에 이 팀의 경기가 없습니다.</div></div>`;
  } else {
    const ths = ['시즌', ...POS_ORDER.map(p => posLabel(p))].map((h, i) =>
      `<th class="${i === 0 ? 'txt' : 'txt'}" style="cursor:default">${h}</th>`).join('');
    const rows = seasons.map(s => {
      const cells = POS_ORDER.map(p => {
        const list = s.byPos[p];
        if (!list.length) return '<td class="txt">–</td>';
        const html = list.map((pl, i) =>
          `<span class="ros-p${i === 0 ? ' main' : ''}" data-pid="${esc(pl.pid)}">${esc(pl.name)}<small>(${pl.games})</small></span>`
        ).join(' ');
        return `<td class="txt">${html}</td>`;
      }).join('');
      const etc = s.byPos.etc.length
        ? ` <span class="note dim">+${s.byPos.etc.length}</span>` : '';
      return `<tr><td class="txt ros-season">${s.year} ${esc(s.split)}${etc}</td>${cells}</tr>`;
    }).join('');
    box.innerHTML = `<div class="roster-box">${head}` +
      `<div class="table-wrap"><table><thead><tr>${ths}</tr></thead><tbody>${rows}</tbody></table></div></div>`;
  }
  $('btnRosterClose').onclick = () => {
    state.rosterTeam = null;
    renderRoster();
    renderTeams();   // clear selected-row highlight
    stateToURL();
  };
  box.querySelectorAll('.ros-p').forEach(el => {
    el.onclick = () => { selectPlayer(el.dataset.pid); switchTab('detail'); };
  });
}

// ---------------------------------------------------------------- champions
const CHAMP_COLS = ['경기수', '승률%', 'KDA', 'K', 'D', 'A', 'DPM', 'GPM',
  'CS/분', '딜비중%', '선수수', '대표선수'];

function renderChampions() {
  const rows = A.buildChampions(G, curRows, state.minGames);
  $('champNote').innerHTML = rows.length
    ? `<b>${rows.length}</b>챔피언 (최소 ${state.minGames}픽) — 필터 조건 내 픽 기준`
    : '';
  if (!rows.length) {
    $('champWrap').innerHTML = '<div class="empty">조건을 만족하는 챔피언이 없습니다.</div>';
    return;
  }
  sortRows(rows, state.champSortKey, state.champSortDir);
  const P = colPercentiles(rows, CHAMP_COLS.filter(k => k !== '대표선수'));
  sortableTable('champWrap', ['#', '챔피언', ...CHAMP_COLS], ['챔피언', '대표선수'],
    rows,
    (r, idx) => {
      const tds = CHAMP_COLS.map(k => {
        if (k === '대표선수') return `<td class="txt">${esc(r[k])}</td>`;
        let cls = '';
        if (k === '승률%' && r[k] != null) cls = r[k] >= 55 ? ' class="pct-hi"' : (r[k] < 45 ? ' class="pct-lo"' : '');
        return `<td${cls}${pctBarStyle(P[k], r[k])}>${fmt(r[k], k === '선수수' ? 0 : DEC[k])}</td>`;
      }).join('');
      return `<tr><td class="rank">${idx + 1}</td><td class="txt player">${champCell(r['챔피언'])}</td>${tds}</tr>`;
    },
    { key: state.champSortKey, dir: state.champSortDir },
    (k, isTxt) => {
      if (state.champSortKey === k) state.champSortDir *= -1;
      else { state.champSortKey = k; state.champSortDir = isTxt ? 1 : -1; }
      renderChampions();
    });
}

// ---------------------------------------------------------------- records
function renderRecords() {
  const c = G.cols;
  const recs = A.buildRecords(G, curRows, 10);
  const seasonShort = (i) => {
    const yy = `'${String(c.year[i]).slice(2)}`;
    const rd = c.round.d[c.round.i[i]];
    if (rd === '승강전') return `${yy} 승강전`;
    const spl = c.split.d[c.split.i[i]];
    let sp = spl === '기타/국제' ? c.league.d[c.league.i[i]] : spl;
    sp = sp.replace('Rounds ', 'R').replace('Season ', '');
    return `${yy} ${sp}${rd === '플레이오프' ? ' PO' : ''}`;
  };
  $('recordsGrid').innerHTML = recs.map(rec => {
    const rows = rec.top.map((h, n) => {
      const i = h.i;
      const full = `${c.name.d[c.name.i[i]]} · ${c.champ.d[c.champ.i[i]]} · ` +
        `${c.team.d[c.team.i[i]]} · ${rowSeason(i)} (${c.league.d[c.league.i[i]]})`;
      return `<tr title="${esc(full)}"><td class="rank">${n + 1}</td>` +
        `<td class="txt player">${esc(c.name.d[c.name.i[i]])}</td>` +
        `<td class="rc-champ">${champIcon(c.champ.d[c.champ.i[i]])}</td>` +
        `<td class="txt rc-season">${esc(seasonShort(i))}</td>` +
        `<td class="rc-val">${fmt(h.v, rec.dec)}</td></tr>`;
    }).join('');
    return `<div class="rec-card"><h3>${esc(rec.label)}</h3>` +
      (rec.top.length
        ? `<table><tbody>${rows}</tbody></table>`
        : '<div class="empty">데이터 없음</div>') +
      `</div>`;
  }).join('');
}

// ---------------------------------------------------------------- tabs & init
function switchTab(t) {
  state.tab = t;
  document.querySelectorAll('.tab').forEach(el =>
    el.classList.toggle('active', el.dataset.tab === t));
  document.querySelectorAll('.pane').forEach(el =>
    el.classList.toggle('active', el.id === 'pane-' + t));
  stateToURL();
}

function uniqueSorted(dictCol) {
  return [...dictCol.d].filter(v => v !== '').sort((a, b) => a.localeCompare(b, 'ko'));
}

function initControls() {
  const c = G.cols;
  const years = [...new Set(c.year)].sort((a, b) => a - b);
  const leagues = uniqueSorted(c.league);
  const splits = uniqueSorted(c.split);
  const rounds = uniqueSorted(c.round);
  const poss = uniqueSorted(c.pos);
  const patches = [...c.patch.d].filter(v => v !== '').sort(patchSort);
  const champs = uniqueSorted(c.champ);
  const lckTeams = [];
  {
    const seen = new Set();
    for (let i = 0; i < G.n; i++) if (c.lck[i]) seen.add(c.team.i[i]);
    for (const code of seen) lckTeams.push(c.team.d[code]);
    lckTeams.sort((a, b) => a.localeCompare(b, 'ko'));
  }
  const allTeams = uniqueSorted(c.team);

  if (state.leagues && state.leagues.size === 1 && state.leagues.has('LCK')
      && !leagues.includes('LCK')) state.leagues = null;

  makeMS('msYear', 'years', '년도', years);
  makeMS('msLeague', 'leagues', '대회 / 리그', leagues);
  makeMS('msSplit', 'splits', '시즌', splits);
  makeMS('msRound', 'rounds', '라운드', rounds);
  makeMS('msPos', 'positions', '포지션', poss, { format: posLabel });
  const teamMS = makeMS('msTeam', 'teams', '팀',
    state.lckOnly ? lckTeams : allTeams, { searchable: true });
  makeMS('msPatch', 'patches', '패치', patches, { searchable: true });
  makeMS('msChamp', 'champs', '챔피언', champs, { searchable: true });
  makeMS('msMetrics', 'metrics', '표시할 지표', METRICS.map(m => m[0]));

  $('fLckOnly').checked = state.lckOnly;
  $('fLckOnly').onchange = () => {
    state.lckOnly = $('fLckOnly').checked;
    state.teams = null;
    teamMS.options.length = 0;
    teamMS.options.push(...(state.lckOnly ? lckTeams : allTeams));
    teamMS.syncBtn();
    scheduleRender();
  };
  $('fCompleteOnly').checked = state.completeOnly;
  $('fCompleteOnly').onchange = () => {
    state.completeOnly = $('fCompleteOnly').checked; scheduleRender();
  };
  $('fMinGames').value = state.minGames;
  $('minGamesVal').textContent = state.minGames;
  $('fMinGames').oninput = () => {
    state.minGames = +$('fMinGames').value;
    $('minGamesVal').textContent = state.minGames;
    scheduleRender();
  };
  function applyState(patch) {
    Object.assign(state, patch);
    $('fLckOnly').checked = state.lckOnly;
    $('fCompleteOnly').checked = state.completeOnly;
    $('fMinGames').value = state.minGames;
    $('minGamesVal').textContent = String(state.minGames);
    Object.values(msInstances).forEach(ms => ms.syncBtn());
    closeAllMS();
    scheduleRender();
  }

  $('btnReset').onclick = () => applyState({
    lckOnly: true, years: null,
    leagues: leagues.includes('LCK') ? new Set(['LCK']) : null,
    splits: null, rounds: null, positions: null, teams: null,
    patches: null, champs: null, completeOnly: false, minGames: 5,
    metrics: new Set(CORE_METRICS), sortKey: '경기수', sortDir: -1,
  });

  $('btnMetricsMode').onclick = () => {
    state.metrics = state.metrics === null ? new Set(CORE_METRICS) : null;
    msInstances.metrics.syncBtn();
    scheduleRender();
  };

  // One-click starting points (reuse the filter state, land on a useful view)
  const nowYear = years[years.length - 1];
  const PRESETS = [
    { label: `${nowYear} 시즌`, patch: { years: new Set([nowYear]),
      leagues: new Set(['LCK']), positions: null, minGames: 5,
      sortKey: '경기수', sortDir: -1 } },
    { label: `${nowYear - 1} 시즌`, patch: { years: new Set([nowYear - 1]),
      leagues: new Set(['LCK']), positions: null, minGames: 5,
      sortKey: '경기수', sortDir: -1 } },
    { label: '역대 통산', patch: { years: null, leagues: new Set(['LCK']),
      positions: null, minGames: 100, sortKey: '경기수', sortDir: -1 } },
    { label: '국제대회', patch: { years: null,
      leagues: new Set(['MSI', 'WLDs', 'FST'].filter(l => leagues.includes(l))),
      positions: null, minGames: 10, sortKey: '경기수', sortDir: -1 } },
  ];
  $('presetChips').innerHTML = PRESETS.map((p, i) =>
    `<button class="chip" data-i="${i}">${esc(p.label)}</button>`).join('');
  $('presetChips').querySelectorAll('.chip').forEach(b => {
    b.onclick = () => {
      applyState({ lckOnly: true, splits: null, rounds: null, teams: null,
        patches: null, champs: null, completeOnly: false,
        ...PRESETS[+b.dataset.i].patch });
      switchTab('lb');
    };
  });

  $('tabs').querySelectorAll('.tab').forEach(b => {
    b.onclick = () => switchTab(b.dataset.tab);
  });
  $('btnCsv').onclick = csvDownload;

  const sel = $('chartMetric');
  sel.innerHTML = CHART_METRICS.map(m => `<option>${m}</option>`).join('');
  sel.value = state.chartMetric;
  sel.onchange = () => { state.chartMetric = sel.value; renderDetail(); stateToURL(); };

  $('playerSearch').oninput = () => renderPlayerList($('playerSearch').value);
  $('playerSearch').onfocus = () => renderPlayerList($('playerSearch').value);
  $('cmpSearch').oninput = () => renderCmpList($('cmpSearch').value);
  $('cmpSearch').onfocus = () => renderCmpList($('cmpSearch').value);

  $('filterToggle').onclick = () => $('sidebar').classList.toggle('open');

  switchTab(state.tab);
  $('topMeta').textContent =
    `데이터: ${META.years ? META.years.join('–') : ''} · ${(META.rows || 0).toLocaleString()}행 · 갱신 ${META.updated || '-'}`;
}

(async function main() {
  try {
    await loadAll();
    urlToState();
    initControls();
    renderAll();
  } catch (err) {
    $('loading').innerHTML = `<p>데이터 로딩 실패: ${esc(err.message)}</p>`;
    return;
  }
  $('loading').remove();
})();
