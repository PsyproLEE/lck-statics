/* LCK 선수 통계 — aggregation core (no DOM).
   Runs in the browser (app.js) AND in Node (tests/parity/check.mjs), so the
   numbers users see are the exact code CI verifies against src/queries.py.

   data shape: { n, cols, displayName, nameLow }
     - dict columns (cols.pid/name/team/pos/champ/league/split/round/patch):
       {d: [values], i: [codes]}
     - numeric columns: arrays with null for missing
   filter shape: { lckOnly, years, leagues, splits, rounds, positions, teams,
                   patches, champs, completeOnly }  (null Set = no restriction)
*/
(function (root) {
  'use strict';

  // [key, display decimals]
  const METRICS = [
    ['경기수', 0], ['승', 0], ['승률%', 1], ['KDA', 2], ['K', 2], ['D', 2],
    ['A', 2], ['KP%', 1], ['DPM', 1], ['딜비중%', 1], ['GPM', 1], ['CS/분', 2],
    ['GD@15', 0], ['CSD@15', 1], ['XPD@15', 1], ['FB%', 1], ['피FB%', 1],
    ['데스/분', 2], ['데스지분%', 1], ['받은딜/분', 0], ['완화/분', 0],
    ['DPG', 3], ['시야/분', 2], ['챔프수', 0], ['솔킬', 0], ['솔킬/G', 3],
  ];
  const DEC = Object.fromEntries(METRICS);

  function codeSet(dictCol, values) {
    if (!values) return null;
    const s = new Set();
    dictCol.d.forEach((v, c) => { if (values.has(v)) s.add(c); });
    return s;
  }

  function filterRows(data, f) {
    const c = data.cols, n = data.n;
    const fLeague = codeSet(c.league, f.leagues);
    const fSplit = codeSet(c.split, f.splits);
    const fRound = codeSet(c.round, f.rounds);
    const fPos = codeSet(c.pos, f.positions);
    const fTeam = codeSet(c.team, f.teams);
    const fPatch = codeSet(c.patch, f.patches);
    const fChamp = codeSet(c.champ, f.champs);
    const out = [];
    for (let i = 0; i < n; i++) {
      if (f.lckOnly && !c.lck[i]) continue;
      if (f.years && !f.years.has(c.year[i])) continue;
      if (fLeague && !fLeague.has(c.league.i[i])) continue;
      if (fSplit && !fSplit.has(c.split.i[i])) continue;
      if (fRound && !fRound.has(c.round.i[i])) continue;
      if (fPos && !fPos.has(c.pos.i[i])) continue;
      if (fTeam && !fTeam.has(c.team.i[i])) continue;
      if (fPatch && !fPatch.has(c.patch.i[i])) continue;
      if (fChamp && !fChamp.has(c.champ.i[i])) continue;
      if (f.completeOnly && !c.ok[i]) continue;
      out.push(i);
    }
    return out;
  }

  // Accumulator mirroring src/queries.py _agg_block (time-weighted rates).
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

  function accAdd(acc, i, data) {
    const c = data.cols;
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
    // rows arrive in (roughly) chronological order, so the last one wins:
    // used to show a player's most RECENT team when the filter spans moves
    acc.lastTeam = tm;
    const ps = c.pos.d[c.pos.i[i]];
    acc.poss.set(ps, (acc.poss.get(ps) || 0) + 1);
    acc.skKeys.add(`${data.nameLow[c.name.i[i]]}|${c.year[i]}|${c.league.d[c.league.i[i]]}`);
  }

  function accFinish(acc, skmap) {
    const mins = acc.len / 60;
    const rate = (sum, secs) => secs > 0 ? sum / (secs / 60) : null;
    const dpm = rate(acc.dmg, acc.dmgLen);
    const gpm = rate(acc.gold, acc.goldLen);
    let sk = null, skG = 0, skGnull = false, matched = false;
    if (skmap) {
      for (const key of acc.skKeys) {
        const hit = skmap.get(key);
        if (!hit) continue;
        matched = true;
        sk = (sk || 0) + hit.sk;
        if (hit.g == null) skGnull = true; else skG += hit.g;
      }
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

  function buildLeaderboard(data, skmap, rows, minGames) {
    const c = data.cols;
    const byPid = new Map();
    for (const i of rows) {
      const key = c.pid.i[i];
      let acc = byPid.get(key);
      if (!acc) { acc = newAcc(); byPid.set(key, acc); }
      accAdd(acc, i, data);
    }
    const out = [];
    for (const [pidCode, acc] of byPid) {
      if (acc.games < minGames) continue;
      const pidStr = c.pid.d[pidCode];
      const m = accFinish(acc, skmap);
      m['선수'] = data.displayName[pidStr] || topOf(acc.teams);
      m['팀'] = acc.lastTeam || topOf(acc.teams);
      m['포지션'] = topOf(acc.poss);
      m._pid = pidStr;
      m._teams = [...acc.teams.entries()].sort((a, b) => b[1] - a[1]);
      out.push(m);
    }
    return out;
  }

  function buildChampions(data, rows, minGames) {
    const c = data.cols;
    const byChamp = new Map(); // champ code -> {acc, players Map(pidStr->n)}
    for (const i of rows) {
      const key = c.champ.i[i];
      let o = byChamp.get(key);
      if (!o) { o = { acc: newAcc(), players: new Map() }; byChamp.set(key, o); }
      accAdd(o.acc, i, data);
      const pidStr = c.pid.d[c.pid.i[i]];
      o.players.set(pidStr, (o.players.get(pidStr) || 0) + 1);
    }
    const out = [];
    for (const [code, o] of byChamp) {
      const name = c.champ.d[code];
      if (!name || o.acc.games < minGames) continue;
      const m = accFinish(o.acc, null);
      m['챔피언'] = name;
      m['선수수'] = o.players.size;
      const topPid = topOf(o.players);
      m['대표선수'] = `${data.displayName[topPid] || '?'} (${o.players.get(topPid)})`;
      out.push(m);
    }
    return out;
  }

  const RECORD_DEFS = [
    { id: 'k', label: '한 경기 최다 킬', dec: 0, get: (c, i) => c.k[i] },
    { id: 'a', label: '한 경기 최다 어시스트', dec: 0, get: (c, i) => c.a[i] },
    { id: 'dpm', label: '한 경기 최고 DPM', dec: 0,
      get: (c, i) => (c.dmg[i] != null && c.len[i]) ? c.dmg[i] / (c.len[i] / 60) : null },
    { id: 'dmg', label: '한 경기 최다 챔피언 딜', dec: 0, get: (c, i) => c.dmg[i] },
    { id: 'cs', label: '한 경기 최다 CS', dec: 0, get: (c, i) => c.cs[i] },
    { id: 'gold', label: '한 경기 최다 획득 골드', dec: 0, get: (c, i) => c.gold[i] },
    { id: 'gd15', label: '15분 최대 골드 리드', dec: 0, get: (c, i) => c.gd15[i] },
    { id: 'vs', label: '한 경기 최고 시야 점수', dec: 0, get: (c, i) => c.vs[i] },
    { id: 'd', label: '한 경기 최다 데스', dec: 0, get: (c, i) => c.d[i] },
  ];

  function buildRecords(data, rows, topN) {
    const c = data.cols;
    return RECORD_DEFS.map(def => {
      const hits = [];
      for (const i of rows) {
        const v = def.get(c, i);
        if (v != null) hits.push({ v, i });
      }
      hits.sort((a, b) => b.v - a.v);
      return { id: def.id, label: def.label, dec: def.dec, top: hits.slice(0, topN) };
    });
  }

  function filterTeamGames(tg, f) {
    const c = tg.cols;
    const fLeague = codeSet(c.league, f.leagues);
    const fSplit = codeSet(c.split, f.splits);
    const fRound = codeSet(c.round, f.rounds);
    const fTeam = codeSet(c.team, f.teams);
    const fPatch = codeSet(c.patch, f.patches);
    const out = [];
    for (let i = 0; i < tg.n; i++) {
      if (f.lckOnly && !c.lck[i]) continue;
      if (f.years && !f.years.has(c.year[i])) continue;
      if (fLeague && !fLeague.has(c.league.i[i])) continue;
      if (fSplit && !fSplit.has(c.split.i[i])) continue;
      if (fRound && !fRound.has(c.round.i[i])) continue;
      if (fTeam && !fTeam.has(c.team.i[i])) continue;
      if (fPatch && !fPatch.has(c.patch.i[i])) continue;
      if (f.completeOnly && !c.ok[i]) continue;
      out.push(i);
    }
    return out;
  }

  function buildTeams(tg, f, minGames) {
    const c = tg.cols;
    const by = new Map();
    for (const i of filterTeamGames(tg, f)) {
      const t = c.team.d[c.team.i[i]];
      let o = by.get(t);
      if (!o) { o = { team: t, g: 0, w: 0, bg: 0, bw: 0, rg: 0, rw: 0 }; by.set(t, o); }
      o.g++; o.w += c.win[i] || 0;
      if (c.blue[i]) { o.bg++; o.bw += c.win[i] || 0; }
      else { o.rg++; o.rw += c.win[i] || 0; }
    }
    return [...by.values()].filter(o => o.g >= minGames).map(o => ({
      '팀': o.team, '경기수': o.g, '승': o.w,
      '승률%': 100 * o.w / o.g,
      '블루승률%': o.bg ? 100 * o.bw / o.bg : null,
      '레드승률%': o.rg ? 100 * o.rw / o.rg : null,
    }));
  }

  root.LCKAGG = {
    METRICS, DEC, filterRows, newAcc, accAdd, accFinish, topOf,
    buildLeaderboard, buildChampions, buildRecords, RECORD_DEFS,
    filterTeamGames, buildTeams,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
