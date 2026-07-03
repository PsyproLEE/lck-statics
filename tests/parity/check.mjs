/* JS-Python aggregation parity check.

   Loads docs/agg.js (the exact code the site runs), feeds it docs/data/*.json,
   and compares every metric of every player/team against expected.json
   produced by tests/parity/gen_expected.py from src/queries.py.

   Usage:  node tests/parity/check.mjs        (run gen_expected.py first)
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

// agg.js attaches LCKAGG to globalThis; it has no DOM dependencies.
(0, eval)(fs.readFileSync(path.join(ROOT, 'docs', 'agg.js'), 'utf8'));
const A = globalThis.LCKAGG;

const expected = JSON.parse(
  fs.readFileSync(path.join(HERE, 'expected.json'), 'utf8'));

const G = read('docs/data/games.json');
G.nameLow = G.cols.name.d.map((s) => s.trim().toLowerCase());
const TG = read('docs/data/teamgames.json');
const SKMAP = new Map();
for (const r of read('docs/data/solokills.json')) {
  SKMAP.set(`${r.key}|${r.year}|${r.league}`, { sk: r.sk, g: r.g });
}

// Python rounds to N decimals before writing; JS values are raw. A pair is
// consistent iff |raw - rounded| <= half an ulp of the rounding step.
const METRIC_DEC = {
  '경기수': 0, '승': 0, '승률%': 1, KDA: 2, K: 2, D: 2, A: 2, 'KP%': 1,
  DPM: 1, '딜비중%': 1, GPM: 1, 'CS/분': 2, 'GD@15': 0, 'CSD@15': 1,
  'XPD@15': 1, 'FB%': 1, '피FB%': 1, '데스/분': 2, '데스지분%': 1,
  '받은딜/분': 0, '완화/분': 0, DPG: 3, '시야/분': 2, '챔프수': 0,
  '솔킬': 0, '솔킬/G': 3,
};
const TEAM_DEC = { '경기수': 0, '승': 0, '승률%': 1, '블루승률%': 1, '레드승률%': 1 };

let checked = 0;
const errors = [];

function compare(where, key, exp, raw, dec) {
  checked++;
  if (exp == null && raw == null) return;
  if (exp == null || raw == null) {
    errors.push(`${where} ${key}: expected=${exp} js=${raw}`);
    return;
  }
  const tol = 0.5 * Math.pow(10, -dec) + 1e-9;
  if (Math.abs(raw - exp) > tol) {
    errors.push(`${where} ${key}: expected=${exp} js=${raw} (tol ${tol})`);
  }
}

for (const s of expected.scenarios) {
  const filter = {
    lckOnly: s.lckOnly,
    years: s.years ? new Set(s.years) : null,
    leagues: s.leagues ? new Set(s.leagues) : null,
    splits: null, rounds: null, positions: null, teams: null,
    patches: null, champs: null, completeOnly: false,
  };
  const rows = A.filterRows(G, filter);
  const lb = A.buildLeaderboard(G, SKMAP, rows, s.minGames);
  const byPid = new Map(lb.map((r) => [r._pid, r]));

  const expPids = Object.keys(s.players);
  if (expPids.length !== lb.length) {
    errors.push(`${s.id}: player count expected=${expPids.length} js=${lb.length}`);
  }
  for (const pid of expPids) {
    const jsRow = byPid.get(pid);
    if (!jsRow) { errors.push(`${s.id}: player ${pid} missing in JS`); continue; }
    for (const [k, dec] of Object.entries(METRIC_DEC)) {
      if (!(k in s.players[pid])) continue;
      compare(`${s.id}/${pid}`, k, s.players[pid][k], jsRow[k], dec);
    }
  }

  const teams = A.buildTeams(TG, filter, s.minGames);
  const byTeam = new Map(teams.map((r) => [r['팀'], r]));
  const expTeams = Object.keys(s.teams);
  if (expTeams.length !== teams.length) {
    errors.push(`${s.id}: team count expected=${expTeams.length} js=${teams.length}`);
  }
  for (const t of expTeams) {
    const jsRow = byTeam.get(t);
    if (!jsRow) { errors.push(`${s.id}: team ${t} missing in JS`); continue; }
    for (const [k, dec] of Object.entries(TEAM_DEC)) {
      compare(`${s.id}/team:${t}`, k, s.teams[t][k], jsRow[k], dec);
    }
  }
  console.log(`  ${s.id}: ${expPids.length} players, ${expTeams.length} teams OK-so-far`);
}

if (errors.length) {
  console.error(`\nPARITY FAILED — ${errors.length} mismatch(es) of ${checked} checks:`);
  for (const e of errors.slice(0, 40)) console.error('  ' + e);
  if (errors.length > 40) console.error(`  ... and ${errors.length - 40} more`);
  process.exit(1);
}
console.log(`\nparity OK: ${checked} value checks across ${expected.scenarios.length} scenarios`);
