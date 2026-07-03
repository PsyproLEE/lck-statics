/* LCK 선수 통계 — static front-end.
   All filtering/aggregation happens client-side over docs/data/*.json,
   mirroring src/queries.py (playerid identity, time-weighted rates). */
'use strict';

// ---------------------------------------------------------------- data
let G = null;      // games: {n, cols, displayName}
let TG = null;     // teamgames
let SKMAP = null;  // "namelow|year|league" -> {sk, g}
let META = null;

const $ = (id) => document.getElementById(id);

async function loadAll() {
  const [g, tg, sk, meta] = await Promise.all([
    fetch('data/games.json').then(r => r.json()),
    fetch('data/teamgames.json').then(r => r.json()),
    fetch('data/solokills.json').then(r => r.json()).catch(() => []),
    fetch('data/meta.json').then(r => r.json()).catch(() => ({})),
  ]);
  G = g; TG = tg; META = meta;
  SKMAP = new Map();
  for (const r of sk) SKMAP.set(`${r.key}|${r.year}|${r.league}`, { sk: r.sk, g: r.g });
  // lowercase name dictionary for solo-kill joins
  G.nameLow = G.cols.name.d.map(s => s.trim().toLowerCase());
}

// ---------------------------------------------------------------- state
const state = {
  lckOnly: true,
  years: null, leagues: new Set(['LCK']), splits: null, rounds: null,
  positions: null, teams: null, patches: null, champs: null,
  completeOnly: false, minGames: 5,
  metrics: null,           // Set of visible metric keys (null until init)
  sortKey: '경기수', sortDir: -1,
  tab: 'lb', pid: null, chartMetric: 'KDA',
  teamSortKey: '승률%', teamSortDir: -1,
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
  '솔킬/G': 'gol.gg 솔킬 ÷ gol.gg 경기수 (연·리그 기준)',
  '블루승률%': '블루 진영 승률', '레드승률%': '레드 진영 승률',
};

// [key, decimals] in display order
const METRICS = [
  ['경기수', 0], ['승', 0], ['승률%', 1], ['KDA', 2], ['K', 2], ['D', 2],
  ['A', 2], ['KP%', 1], ['DPM', 1], ['딜비중%', 1], ['GPM', 1], ['CS/분', 2],
  ['GD@15', 0], ['CSD@15', 1], ['XPD@15', 1], ['FB%', 1], ['피FB%', 1],
  ['데스/분', 2], ['데스지분%', 1], ['받은딜/분', 0], ['완화/분', 0],
  ['DPG', 3], ['시야/분', 2], ['챔프수', 0], ['솔킬', 0], ['솔킬/G', 3],
];
const DEC = Object.fromEntries(METRICS);
const CHART_METRICS = ['KDA', 'DPM', 'GPM', 'CS/분', '승률%', 'KP%'];

// ---------------------------------------------------------------- filtering
function codeSet(dictCol, values) {
  if (!values) return null;
  const s = new Set();
  dictCol.d.forEach((v, c) => { if (values.has(v)) s.add(c); });
  return s;
}

function filterRows() {
  const c = G.cols, n = G.n;
  const fLeague = codeSet(c.league, state.leagues);
  const fSplit = codeSet(c.split, state.splits);
  const fRound = codeSet(c.round, state.rounds);
  const fPos = codeSet(c.pos, state.positions);
  const fTeam = codeSet(c.team, state.teams);
  const fPatch = codeSet(c.patch, state.patches);
  const fChamp = codeSet(c.champ, state.champs);
  const out = [];
  for (let i = 0; i < n; i++) {
    if (state.lckOnly && !c.lck[i]) continue;
    if (state.years && !state.years.has(c.year[i])) continue;
    if (fLeague && !fLeague.has(c.league.i[i])) continue;
    if (fSplit && !fSplit.has(c.split.i[i])) continue;
    if (fRound && !fRound.has(c.round.i[i])) continue;
    if (fPos && !fPos.has(c.pos.i[i])) continue;
    if (fTeam && !fTeam.has(c.team.i[i])) continue;
    if (fPatch && !fPatch.has(c.patch.i[i])) continue;
    if (fChamp && !fChamp.has(c.champ.i[i])) continue;
    if (state.completeOnly && !c.ok[i]) continue;
    out.push(i);
  }
  return out;
}

// ---------------------------------------------------------------- aggregation
// Accumulator mirroring queries._agg_block (time-weighted per-minute rates).
function newAcc() {
  return {
    games: 0, wins: 0, k: 0, d: 0, a: 0, tk: 0, td: 0, len: 0,
    dmg: 0, dmgLen: 0, gold: 0, goldLen: 0, cs: 0, csLen: 0, vs: 0, vsLen: 0,
    dshare: 0, dshareN: 0, dtpmW: 0, dtpmLen: 0, dmpmW: 0, dmpmLen: 0,
    gd15: 0, gd15N: 0, csd15: 0, csd15N: 0, xpd15: 0, xpd15N: 0,
    fb: 0, fbN: 0, fbv: 0, fbvN: 0,
    champs: new Set(), teams: new Map(), poss: new Map(), skKeys: new Set(),
  };
}

function accAdd(acc, i) {
  const c = G.cols;
  acc.games++;
  acc.wins += c.win[i] || 0;
  acc.k += c.k[i] || 0; acc.d += c.d[i] || 0; acc.a += c.a[i] || 0;
  acc.tk += c.tk[i] || 0; acc.td += c.td[i] || 0;
  const len = c.len[i] || 0;
  acc.len += len;
  if (c.dmg[i] != null) { acc.dmg += c.dmg[i]; acc.dmgLen += len; }
  if (c.gold[i] != null) { acc.gold += c.gold[i]; acc.goldLen += len; }
  if (c.cs[i] != null) { acc.cs += c.cs[i]; acc.csLen += len; }
  if (c.vs[i] != null) { acc.vs += c.vs[i]; acc.vsLen += len; }
  if (c.dshare[i] != null) { acc.dshare += c.dshare[i]; acc.dshareN++; }
  if (c.dtpm[i] != null) { acc.dtpmW += c.dtpm[i] * len; acc.dtpmLen += len; }
  if (c.dmpm[i] != null) { acc.dmpmW += c.dmpm[i] * len; acc.dmpmLen += len; }
  if (c.gd15[i] != null) { acc.gd15 += c.gd15[i]; acc.gd15N++; }
  if (c.csd15[i] != null) { acc.csd15 += c.csd15[i]; acc.csd15N++; }
  if (c.xpd15[i] != null) { acc.xpd15 += c.xpd15[i]; acc.xpd15N++; }
  if (c.fbk[i] != null || c.fba[i] != null) {
    acc.fb += (c.fbk[i] || 0) + (c.fba[i] || 0); acc.fbN++;
  }
  if (c.fbv[i] != null) { acc.fbv += c.fbv[i]; acc.fbvN++; }
  const ch = c.champ.d[c.champ.i[i]];
  if (ch) acc.champs.add(ch);
  const tm = c.team.d[c.team.i[i]];
  acc.teams.set(tm, (acc.teams.get(tm) || 0) + 1);
  const ps = c.pos.d[c.pos.i[i]];
  acc.poss.set(ps, (acc.poss.get(ps) || 0) + 1);
  acc.skKeys.add(`${G.nameLow[c.name.i[i]]}|${c.year[i]}|${c.league.d[c.league.i[i]]}`);
}

function accFinish(acc) {
  const mins = acc.len / 60;
  const rate = (sum, secs) => secs > 0 ? sum / (secs / 60) : null;
  const dpm = rate(acc.dmg, acc.dmgLen);
  const gpm = rate(acc.gold, acc.goldLen);
  let sk = null, skG = 0, skGnull = false, matched = false;
  for (const key of acc.skKeys) {
    const hit = SKMAP.get(key);
    if (!hit) continue;
    matched = true;
    sk = (sk || 0) + hit.sk;
    if (hit.g == null) skGnull = true; else skG += hit.g;
  }
  return {
    '경기수': acc.games,
    '승': acc.wins,
    '승률%': acc.games ? 100 * acc.wins / acc.games : null,
    'KDA': acc.d > 0 ? (acc.k + acc.a) / acc.d : acc.k + acc.a,
    'K': acc.games ? acc.k / acc.games : null,
    'D': acc.games ? acc.d / acc.games : null,
    'A': acc.games ? acc.a / acc.games : null,
    'KP%': acc.tk > 0 ? 100 * (acc.k + acc.a) / acc.tk : null,
    'DPM': dpm,
    '딜비중%': acc.dshareN ? 100 * acc.dshare / acc.dshareN : null,
    'GPM': gpm,
    'CS/분': rate(acc.cs, acc.csLen),
    'GD@15': acc.gd15N ? acc.gd15 / acc.gd15N : null,
    'CSD@15': acc.csd15N ? acc.csd15 / acc.csd15N : null,
    'XPD@15': acc.xpd15N ? acc.xpd15 / acc.xpd15N : null,
    'FB%': acc.fbN ? 100 * acc.fb / acc.fbN : null,
    '피FB%': acc.fbvN ? 100 * acc.fbv / acc.fbvN : null,
    '데스/분': mins > 0 ? acc.d / mins : null,
    '데스지분%': acc.td > 0 ? 100 * acc.d / acc.td : null,
    '받은딜/분': acc.dtpmLen > 0 ? acc.dtpmW / acc.dtpmLen : null,
    '완화/분': acc.dmpmLen > 0 ? acc.dmpmW / acc.dmpmLen : null,
    'DPG': dpm != null && gpm ? dpm / gpm : null,
    '시야/분': rate(acc.vs, acc.vsLen),
    '챔프수': acc.champs.size,
    '솔킬': matched ? sk : null,
    '솔킬/G': matched && !skGnull && skG > 0 ? sk / skG : null,
  };
}

const topOf = (map) => {
  let best = '', n = -1;
  for (const [k, v] of map) if (v > n) { n = v; best = k; }
  return best;
};

function aggregateBy(rows, keyFn) {
  const m = new Map();
  for (const i of rows) {
    const key = keyFn(i);
    let acc = m.get(key);
    if (!acc) { acc = newAcc(); m.set(key, acc); }
    accAdd(acc, i);
  }
  return m;
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

  const inst = { options, key, btn, panel, format };
  msInstances[key] = inst;

  function selected() { return state[key]; }
  function labelText() {
    const sel = selected();
    if (!sel) return `전체 (${options.length})`;
    if (sel.size === 0) return `전체 (${options.length})`;
    if (sel.size === 1) return String([...sel][0]);
    return `${sel.size}개 선택`;
  }
  function syncBtn() {
    btn.textContent = labelText();
    btn.classList.toggle('some', !!(selected() && selected().size));
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

    let list = options;
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
    for (const v of list) {
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
  inst.rebuild = rebuild;
  return inst;
}

function closeAllMS() {
  document.querySelectorAll('.ms-panel').forEach(p => { p.hidden = true; });
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.ms')) closeAllMS();
  if (!e.target.closest('.player-search')) $('playerList').hidden = true;
});

// ---------------------------------------------------------------- helpers
function fmt(v, nd) {
  if (v == null || Number.isNaN(v)) return '–';
  return v.toLocaleString('ko-KR', { minimumFractionDigits: nd, maximumFractionDigits: nd });
}
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function patchSort(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  if (pa.some(isNaN) || pb.some(isNaN)) return a < b ? -1 : 1;
  return (pa[0] - pb[0]) || (pa[1] - pb[1]);
}

function visibleMetrics() {
  return METRICS.map(m => m[0]).filter(k => !state.metrics || state.metrics.has(k));
}

// ---------------------------------------------------------------- rendering
let renderTimer = null;
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderAll, 90);
}

let curRows = [];        // filtered row indices
let curLB = [];          // leaderboard row objects

function renderAll() {
  curRows = filterRows();
  renderSummary();
  renderLeaderboard();
  renderDetail();
  renderTeams();
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

function buildLeaderboard() {
  const c = G.cols;
  const byPid = aggregateBy(curRows, i => c.pid.i[i]);
  const rows = [];
  for (const [pidCode, acc] of byPid) {
    if (acc.games < state.minGames) continue;
    const pidStr = c.pid.d[pidCode];
    const m = accFinish(acc);
    m['선수'] = G.displayName[pidStr] || topOf(acc.teams);
    m['팀'] = topOf(acc.teams);
    m['포지션'] = topOf(acc.poss);
    m._pid = pidStr;
    rows.push(m);
  }
  return rows;
}

function sortRows(rows, key, dir) {
  const isTxt = key === '선수' || key === '팀' || key === '포지션';
  rows.sort((a, b) => {
    const va = a[key], vb = b[key];
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (isTxt) return dir * String(va).localeCompare(String(vb), 'ko');
    return dir * (va - vb);
  });
}

function renderLeaderboard() {
  curLB = buildLeaderboard();
  sortRows(curLB, state.sortKey, state.sortDir);
  const mets = visibleMetrics();
  const showSK = mets.includes('솔킬') || mets.includes('솔킬/G');
  $('skNote').hidden = !(showSK && SKMAP.size);
  $('lbNote').innerHTML = curLB.length
    ? `<b>${curLB.length}</b>명 (최소 ${state.minGames}경기)`
    : '';
  if (!curLB.length) {
    $('lbWrap').innerHTML = `<div class="empty">조건을 만족하는 선수가 없습니다. 필터를 완화해 보세요.</div>`;
    return;
  }
  const head = ['#', '선수', '팀', '포지션', ...mets];
  const ths = head.map(h => {
    if (h === '#') return '<th>#</th>';
    const sorted = state.sortKey === h;
    const arr = sorted ? `<span class="arr">${state.sortDir < 0 ? '▼' : '▲'}</span>` : '';
    const cls = (h === '선수' || h === '팀' || h === '포지션') ? 'txt' : '';
    const help = METRIC_HELP[h] ? ` title="${esc(METRIC_HELP[h])}"` : '';
    return `<th class="${cls}${sorted ? ' sorted' : ''}" data-k="${esc(h)}"${help}>${esc(h)}${arr}</th>`;
  }).join('');
  const body = curLB.map((r, idx) => {
    const tds = mets.map(k => {
      let cls = '';
      if (k === '승률%' && r[k] != null) cls = r[k] >= 55 ? ' class="pct-hi"' : (r[k] < 45 ? ' class="pct-lo"' : '');
      return `<td${cls}>${fmt(r[k], DEC[k])}</td>`;
    }).join('');
    return `<tr data-pid="${esc(r._pid)}"><td class="rank">${idx + 1}</td>` +
      `<td class="txt player">${esc(r['선수'])}</td>` +
      `<td class="txt">${esc(r['팀'])}</td><td class="txt badge">${esc(r['포지션'])}</td>${tds}</tr>`;
  }).join('');
  $('lbWrap').innerHTML = `<table><thead><tr>${ths}</tr></thead><tbody>${body}</tbody></table>`;

  $('lbWrap').querySelectorAll('th[data-k]').forEach(th => {
    th.onclick = () => {
      const k = th.dataset.k;
      if (state.sortKey === k) state.sortDir *= -1;
      else { state.sortKey = k; state.sortDir = (k === '선수' || k === '팀' || k === '포지션') ? 1 : -1; }
      renderLeaderboard();
    };
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
      const v = k === '선수' || k === '팀' || k === '포지션' ? r[k] : r[k];
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
  const groups = new Map(); // key -> {year, split, round, league, acc}
  for (const i of curRows) {
    if (c.pid.i[i] !== pidCode) continue;
    const y = c.year[i], s = c.split.d[c.split.i[i]],
      rd = c.round.d[c.round.i[i]], lg = c.league.d[c.league.i[i]];
    const key = `${y}|${s}|${rd}|${lg}`;
    let g = groups.get(key);
    if (!g) { g = { year: y, split: s, round: rd, league: lg, acc: newAcc() }; groups.set(key, g); }
    accAdd(g.acc, i);
  }
  const arr = [...groups.values()];
  arr.sort((a, b) => (a.year - b.year) ||
    a.split.localeCompare(b.split) || a.round.localeCompare(b.round, 'ko') ||
    a.league.localeCompare(b.league));
  return arr.map(g => ({ ...g, m: accFinish(g.acc) }));
}

function champGroups(pidStr) {
  const c = G.cols;
  const pidCode = c.pid.d.indexOf(pidStr);
  const byChamp = new Map();
  for (const i of curRows) {
    if (c.pid.i[i] !== pidCode) continue;
    const ch = c.champ.d[c.champ.i[i]];
    let acc = byChamp.get(ch);
    if (!acc) { acc = newAcc(); byChamp.set(ch, acc); }
    accAdd(acc, i);
  }
  const arr = [...byChamp.entries()].map(([ch, acc]) => ({ champ: ch, m: accFinish(acc) }));
  arr.sort((a, b) => b.m['경기수'] - a.m['경기수']);
  return arr;
}

function lineChartSVG(labels, values, metric) {
  const W = 920, H = 300, padL = 46, padR = 16, padT = 24, padB = 64;
  const pts = values.map((v, i) => ({ v, i })).filter(p => p.v != null);
  if (!pts.length) return '<div class="empty">데이터 없음</div>';
  const vmin = Math.min(...pts.map(p => p.v)), vmax = Math.max(...pts.map(p => p.v));
  const span = (vmax - vmin) || 1;
  const y = v => padT + (H - padT - padB) * (1 - (v - vmin + span * .08) / (span * 1.16));
  const x = i => labels.length === 1 ? W / 2 :
    padL + (W - padL - padR) * (i / (labels.length - 1));
  let grid = '', gtxt = '';
  for (let g = 0; g <= 3; g++) {
    const gv = vmin + span * g / 3;
    grid += `<line class="c-grid" x1="${padL}" x2="${W - padR}" y1="${y(gv)}" y2="${y(gv)}"/>`;
    gtxt += `<text class="c-txt" x="${padL - 6}" y="${y(gv) + 3}" text-anchor="end">${fmt(gv, DEC[metric] ?? 1)}</text>`;
  }
  const poly = pts.map(p => `${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const dots = pts.map(p =>
    `<circle class="c-dot" cx="${x(p.i).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="3.4"><title>${esc(labels[p.i])}: ${fmt(p.v, DEC[metric] ?? 2)}</title></circle>` +
    `<text class="c-val" x="${x(p.i).toFixed(1)}" y="${(y(p.v) - 8).toFixed(1)}" text-anchor="middle">${fmt(p.v, DEC[metric] ?? 1)}</text>`
  ).join('');
  const step = Math.ceil(labels.length / 16);
  const xlab = labels.map((lb, i) => (i % step) ? '' :
    `<text class="c-txt" x="${x(i).toFixed(1)}" y="${H - padB + 14}" text-anchor="end" transform="rotate(-32 ${x(i).toFixed(1)} ${H - padB + 14})">${esc(lb)}</text>`
  ).join('');
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">` +
    grid + gtxt + `<polyline class="c-line" points="${poly}"/>` + dots + xlab + '</svg>';
}

function metricTable(idCols, rows, mets) {
  const ths = [...idCols, ...mets].map(h => {
    const cls = idCols.includes(h) ? ' class="txt"' : '';
    const help = METRIC_HELP[h] ? ` title="${esc(METRIC_HELP[h])}"` : '';
    return `<th${cls}${help} style="cursor:default">${esc(h)}</th>`;
  }).join('');
  const body = rows.map(r =>
    '<tr>' + idCols.map(k => `<td class="txt">${esc(r[k] ?? '')}</td>`).join('') +
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
  const champs = champGroups(pid);
  const mets = visibleMetrics();

  const labels = seas.map(s => `${s.year} ${s.split} · ${s.round}`);
  const values = seas.map(s => s.m[state.chartMetric]);
  const seasRows = seas.map(s => ({
    '년도': s.year, '시즌': s.split, '라운드': s.round, '대회': s.league, ...s.m,
  }));
  const champRows = champs.map(cch => ({ '챔피언': cch.champ, ...cch.m }));

  body.innerHTML =
    `<h3 class="detail-h"><b>${esc(name)}</b> — 시즌별 추이 <span style="color:var(--muted);font-size:13px;font-weight:400">(${state.chartMetric})</span></h3>` +
    `<div class="chart-box">${lineChartSVG(labels, values, state.chartMetric)}</div>` +
    metricTable(['년도', '시즌', '라운드', '대회'], seasRows, mets) +
    `<h3 class="detail-h"><b>${esc(name)}</b> — 챔피언 폭 <span style="color:var(--muted);font-size:13px;font-weight:400">(${champs.length}챔피언)</span></h3>` +
    metricTable(['챔피언'], champRows, mets);
}

// ---------------------------------------------------------------- teams
function filterTeamGames() {
  const c = TG.cols;
  const fLeague = codeSet(c.league, state.leagues);
  const fSplit = codeSet(c.split, state.splits);
  const fRound = codeSet(c.round, state.rounds);
  const fTeam = codeSet(c.team, state.teams);
  const fPatch = codeSet(c.patch, state.patches);
  const out = [];
  for (let i = 0; i < TG.n; i++) {
    if (state.lckOnly && !c.lck[i]) continue;
    if (state.years && !state.years.has(c.year[i])) continue;
    if (fLeague && !fLeague.has(c.league.i[i])) continue;
    if (fSplit && !fSplit.has(c.split.i[i])) continue;
    if (fRound && !fRound.has(c.round.i[i])) continue;
    if (fTeam && !fTeam.has(c.team.i[i])) continue;
    if (fPatch && !fPatch.has(c.patch.i[i])) continue;
    if (state.completeOnly && !c.ok[i]) continue;
    out.push(i);
  }
  return out;
}

function renderTeams() {
  const c = TG.cols;
  const idxs = filterTeamGames();
  const by = new Map();
  for (const i of idxs) {
    const t = c.team.d[c.team.i[i]];
    let o = by.get(t);
    if (!o) { o = { team: t, g: 0, w: 0, bg: 0, bw: 0, rg: 0, rw: 0 }; by.set(t, o); }
    o.g++; o.w += c.win[i] || 0;
    if (c.blue[i]) { o.bg++; o.bw += c.win[i] || 0; }
    else { o.rg++; o.rw += c.win[i] || 0; }
  }
  let rows = [...by.values()].filter(o => o.g >= state.minGames).map(o => ({
    '팀': o.team, '경기수': o.g, '승': o.w,
    '승률%': 100 * o.w / o.g,
    '블루승률%': o.bg ? 100 * o.bw / o.bg : null,
    '레드승률%': o.rg ? 100 * o.rw / o.rg : null,
  }));
  if (!rows.length) {
    $('teamWrap').innerHTML = '<div class="empty">조건을 만족하는 팀이 없습니다.</div>';
    $('teamBars').innerHTML = '';
    return;
  }
  const k = state.teamSortKey, dir = state.teamSortDir;
  rows.sort((a, b) => {
    const va = a[k], vb = b[k];
    if (va == null) return 1; if (vb == null) return -1;
    if (k === '팀') return dir * String(va).localeCompare(String(vb), 'ko');
    return dir * (va - vb);
  });
  const cols = ['팀', '경기수', '승', '승률%', '블루승률%', '레드승률%'];
  const ths = cols.map(h => {
    const sorted = k === h;
    const arr = sorted ? `<span class="arr">${dir < 0 ? '▼' : '▲'}</span>` : '';
    const help = METRIC_HELP[h] ? ` title="${esc(METRIC_HELP[h])}"` : '';
    return `<th class="${h === '팀' ? 'txt' : ''}${sorted ? ' sorted' : ''}" data-k="${h}"${help}>${h}${arr}</th>`;
  }).join('');
  const body = rows.map(r => `<tr><td class="txt player">${esc(r['팀'])}</td>` +
    cols.slice(1).map(cc => `<td>${fmt(r[cc], cc === '경기수' || cc === '승' ? 0 : 1)}</td>`).join('') + '</tr>').join('');
  $('teamWrap').innerHTML = `<table><thead><tr>${ths}</tr></thead><tbody>${body}</tbody></table>`;
  $('teamWrap').querySelectorAll('th[data-k]').forEach(th => {
    th.onclick = () => {
      const kk = th.dataset.k;
      if (state.teamSortKey === kk) state.teamSortDir *= -1;
      else { state.teamSortKey = kk; state.teamSortDir = kk === '팀' ? 1 : -1; }
      renderTeams();
    };
  });
  const byWr = [...rows].sort((a, b) => b['승률%'] - a['승률%']);
  $('teamBars').innerHTML = byWr.map(r =>
    `<div class="tb-row"><div class="tb-name">${esc(r['팀'])}</div>` +
    `<div class="tb-track"><div class="tb-fill" style="width:${r['승률%'].toFixed(1)}%"></div></div>` +
    `<div class="tb-val">${r['승률%'].toFixed(1)}%</div></div>`).join('');
}

// ---------------------------------------------------------------- tabs & init
function switchTab(t) {
  state.tab = t;
  document.querySelectorAll('.tab').forEach(el =>
    el.classList.toggle('active', el.dataset.tab === t));
  document.querySelectorAll('.pane').forEach(el =>
    el.classList.toggle('active', el.id === 'pane-' + t));
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

  if (!leagues.includes('LCK')) state.leagues = null;

  makeMS('msYear', 'years', '년도', years);
  makeMS('msLeague', 'leagues', '대회 / 리그', leagues);
  makeMS('msSplit', 'splits', '시즌', splits);
  makeMS('msRound', 'rounds', '라운드', rounds);
  makeMS('msPos', 'positions', '포지션', poss);
  const teamMS = makeMS('msTeam', 'teams', '팀', lckTeams, { searchable: true });
  makeMS('msPatch', 'patches', '패치', patches, { searchable: true });
  makeMS('msChamp', 'champs', '챔피언', champs, { searchable: true });
  makeMS('msMetrics', 'metrics', '표시할 지표', METRICS.map(m => m[0]));

  $('fLckOnly').onchange = () => {
    state.lckOnly = $('fLckOnly').checked;
    state.teams = null;
    teamMS.options.length = 0;
    teamMS.options.push(...(state.lckOnly ? lckTeams : allTeams));
    teamMS.syncBtn();
    scheduleRender();
  };
  $('fCompleteOnly').onchange = () => {
    state.completeOnly = $('fCompleteOnly').checked; scheduleRender();
  };
  $('fMinGames').oninput = () => {
    state.minGames = +$('fMinGames').value;
    $('minGamesVal').textContent = state.minGames;
    scheduleRender();
  };
  $('btnReset').onclick = () => {
    Object.assign(state, {
      lckOnly: true, years: null,
      leagues: leagues.includes('LCK') ? new Set(['LCK']) : null,
      splits: null, rounds: null, positions: null, teams: null,
      patches: null, champs: null, completeOnly: false, minGames: 5,
      metrics: null, sortKey: '경기수', sortDir: -1,
    });
    $('fLckOnly').checked = true;
    $('fCompleteOnly').checked = false;
    $('fMinGames').value = 5;
    $('minGamesVal').textContent = '5';
    Object.values(msInstances).forEach(ms => ms.syncBtn());
    scheduleRender();
  };

  $('tabs').querySelectorAll('.tab').forEach(b => {
    b.onclick = () => switchTab(b.dataset.tab);
  });
  $('btnCsv').onclick = csvDownload;

  const sel = $('chartMetric');
  sel.innerHTML = CHART_METRICS.map(m => `<option>${m}</option>`).join('');
  sel.onchange = () => { state.chartMetric = sel.value; renderDetail(); };

  $('playerSearch').oninput = () => renderPlayerList($('playerSearch').value);
  $('playerSearch').onfocus = () => renderPlayerList($('playerSearch').value);

  $('filterToggle').onclick = () => $('sidebar').classList.toggle('open');

  $('topMeta').textContent =
    `데이터: ${META.years ? META.years.join('–') : ''} · ${(META.rows || 0).toLocaleString()}행 · 갱신 ${META.updated || '-'}`;
}

(async function main() {
  try {
    await loadAll();
    initControls();
    renderAll();
  } catch (err) {
    $('loading').innerHTML = `<p>데이터 로딩 실패: ${esc(err.message)}</p>`;
    return;
  }
  $('loading').remove();
})();
