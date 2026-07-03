"""Export the processed parquets as compact JSON for the static web app.

The GitHub Pages front-end (docs/) does all filtering/aggregation client-side,
so this ships per-game player rows in a dictionary-encoded columnar layout
(small ints instead of repeated strings), plus pre-collapsed team-games and
the gol.gg solo-kill table.

Outputs (docs/data/):
    games.json      player-game rows, columnar
    teamgames.json  one row per (game, team) - for the team tab
    solokills.json  gol.gg solo kills, name-override applied, key normalized
    meta.json       update timestamp + dataset summary

Usage:
    py src/export_web.py
"""

from __future__ import annotations

import datetime as _dt
import json
import sys
from pathlib import Path

import pandas as pd

try:
    sys.stdout.reconfigure(encoding="utf-8")
except (AttributeError, ValueError):
    pass

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
import queries as q  # noqa: E402  (reuses load_data/load_solokills/_norm)

OUT_DIR = ROOT / "docs" / "data"

# (parquet column, json key, decimals or None for int, allow-null)
NUM_COLS = [
    ("result", "win", 0),
    ("kills", "k", 0),
    ("deaths", "d", 0),
    ("assists", "a", 0),
    ("teamkills", "tk", 0),
    ("teamdeaths", "td", 0),
    ("gamelength", "len", 0),
    # per-minute source columns (dpm/gpm/cspm/vspm) are NOT shipped: the
    # totals below are present wherever they are, and the client computes
    # true time-weighted rates from totals ÷ minutes.
    ("damagetochampions", "dmg", 0),
    ("earnedgold", "gold", 0),
    ("total cs", "cs", 0),
    ("visionscore", "vs", 0),
    # decimals must keep quantization error well under half a display ulp of
    # any aggregated metric, or the JS-Python parity check hits boundaries
    ("damageshare", "dshare", 6),
    ("damagetakenperminute", "dtpm", 2),
    ("damagemitigatedperminute", "dmpm", 2),
    ("golddiffat15", "gd15", 0),
    ("csdiffat15", "csd15", 2),
    ("xpdiffat15", "xpd15", 2),
    ("firstbloodkill", "fbk", 0),
    ("firstbloodassist", "fba", 0),
    ("firstbloodvictim", "fbv", 0),
]
DICT_COLS = [
    ("playerid", "pid"),
    ("playername", "name"),
    ("teamname", "team"),
    ("position", "pos"),
    ("champion", "champ"),
    ("league", "league"),
    ("split_label", "split"),
    ("round_label", "round"),
    ("patch", "patch"),
]


def _dict_encode(series: pd.Series) -> dict:
    vals = series.fillna("").astype(str)
    cats = pd.Categorical(vals)
    return {"d": list(cats.categories), "i": cats.codes.tolist()}


def _num(series: pd.Series, nd: int) -> list:
    s = pd.to_numeric(series, errors="coerce").round(nd)
    if nd == 0:
        return [None if pd.isna(v) else int(v) for v in s]
    return [None if pd.isna(v) else float(v) for v in s]


def export_games(df: pd.DataFrame) -> dict:
    cols: dict = {}
    for src, key in DICT_COLS:
        cols[key] = _dict_encode(df[src] if src in df.columns
                                 else pd.Series([""] * len(df)))
    for src, key, nd in NUM_COLS:
        cols[key] = _num(df[src] if src in df.columns
                         else pd.Series([float("nan")] * len(df)), nd)
    cols["year"] = _num(df["year"], 0)
    cols["lck"] = df["is_lck_team"].fillna(False).astype(int).tolist()
    cols["ok"] = (df["datacompleteness"].astype(str) == "complete").astype(int).tolist()
    # display name per playerid = most recent handle
    names = (
        df.sort_values("date").groupby("playerid")["playername"].last()
        if "date" in df.columns else
        df.groupby("playerid")["playername"].last()
    )
    return {"n": len(df), "cols": cols, "displayName": names.to_dict()}


def export_teamgames(df: pd.DataFrame) -> dict:
    tg = (
        df.groupby(["gameid", "teamname"], dropna=True)
        .agg(
            result=("result", "max"),
            side=("side", "first"),
            year=("year", "first"),
            league=("league", "first"),
            split=("split_label", "first"),
            round=("round_label", "first"),
            patch=("patch", "first"),
            lck=("is_lck_team", "first"),
            ok=("datacompleteness", lambda s: int((s.astype(str) == "complete").all())),
        )
        .reset_index()
    )
    cols: dict = {}
    for c in ("teamname", "league", "split", "round", "patch"):
        cols[c if c != "teamname" else "team"] = _dict_encode(tg[c])
    cols["year"] = _num(tg["year"], 0)
    cols["win"] = _num(tg["result"], 0)
    cols["blue"] = (tg["side"].astype(str) == "Blue").astype(int).tolist()
    cols["lck"] = tg["lck"].fillna(False).astype(int).tolist()
    cols["ok"] = tg["ok"].tolist()
    return {"n": len(tg), "cols": cols}


def export_solokills() -> list[dict]:
    sk = q.load_solokills()
    if sk is None:
        return []
    out = []
    for _, r in sk.iterrows():
        g = r.get("games_gg")
        out.append({
            "key": r["_key"],  # normalized, overrides already applied
            "year": int(r["year"]),
            "league": r["league"],
            "sk": int(r["solo_kills"]),
            "g": None if pd.isna(g) else int(g),
        })
    return out


def _write(path: Path, obj) -> None:
    path.write_text(
        json.dumps(obj, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"  {path.relative_to(ROOT)}  {path.stat().st_size / 1e6:.2f} MB")


def main() -> None:
    print("web export -> docs/data/")
    df = q.load_data()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR.parent / ".nojekyll").touch()

    _write(OUT_DIR / "games.json", export_games(df))
    _write(OUT_DIR / "teamgames.json", export_teamgames(df))
    _write(OUT_DIR / "solokills.json", export_solokills())
    yrs = df["year"].dropna()
    _write(OUT_DIR / "meta.json", {
        "updated": _dt.date.today().isoformat(),
        "rows": len(df),
        "players": int(df["playerid"].nunique()),
        "years": [int(yrs.min()), int(yrs.max())],
    })


if __name__ == "__main__":
    main()
