"""Generate expected aggregation values from src/queries.py (the reference
implementation) for the JS parity check (tests/parity/check.mjs).

The front-end re-implements the aggregation in docs/agg.js; this pair of
scripts fails CI whenever the two drift apart.

Usage:
    py tests/parity/gen_expected.py   # writes tests/parity/expected.json
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))
import queries as q  # noqa: E402

OUT = Path(__file__).resolve().parent / "expected.json"

# (metric key, python-side rounding decimals) — mirrors docs/agg.js METRICS.
METRIC_DEC = {
    "경기수": 0, "승": 0, "승률%": 1, "KDA": 2, "K": 2, "D": 2, "A": 2,
    "KP%": 1, "DPM": 1, "딜비중%": 1, "GPM": 1, "CS/분": 2, "GD@15": 0,
    "CSD@15": 1, "XPD@15": 1, "FB%": 1, "피FB%": 1, "데스/분": 2,
    "데스지분%": 1, "받은딜/분": 0, "완화/분": 0, "DPG": 3, "시야/분": 2,
    "챔프수": 0, "솔킬": 0, "솔킬/G": 3,
}

SCENARIOS = [
    {"id": "lck-2025", "lckOnly": True, "years": [2025], "leagues": ["LCK"],
     "minGames": 5},
    {"id": "lck-2015-ogn", "lckOnly": True, "years": [2015], "leagues": ["LCK"],
     "minGames": 5},
    {"id": "all-history", "lckOnly": True, "years": None, "leagues": None,
     "minGames": 20},
    {"id": "worlds-2023-all-teams", "lckOnly": False, "years": [2023],
     "leagues": ["WLDs"], "minGames": 3},
]


def _clean(v):
    if v is None or (isinstance(v, float) and pd.isna(v)) or v is pd.NA:
        return None
    if pd.isna(v):
        return None
    return float(v) if isinstance(v, (int, float)) else v


def main() -> None:
    df = q.load_data()
    sk = q.load_solokills()
    out = {"scenarios": []}
    for s in SCENARIOS:
        base = df[df["is_lck_team"]] if s["lckOnly"] else df
        f = q.apply_filters(base, years=s["years"], leagues=s["leagues"])
        lb = q.player_leaderboard(f, min_games=s["minGames"], solokills=sk)
        players = {}
        for _, r in lb.iterrows():
            players[r["playerid"]] = {
                k: _clean(r[k]) for k in METRIC_DEC if k in lb.columns
            }
        tl = q.team_leaderboard(f, min_games=s["minGames"])
        teams = {}
        for _, r in tl.iterrows():
            teams[r["팀"]] = {
                k: _clean(r.get(k)) for k in
                ("경기수", "승", "승률%", "블루승률%", "레드승률%")
            }
        out["scenarios"].append({**s, "players": players, "teams": teams})
        print(f"  {s['id']}: {len(players)} players, {len(teams)} teams")
    OUT.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    print(f"written: {OUT}")


if __name__ == "__main__":
    main()
