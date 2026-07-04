"""Cross-validation of the processed data against independent sources.

Manual tool (not CI — hits gol.gg cache / Leaguepedia API). Checks:

1. internal   — rows-per-game anomalies, duplicate (game, player) rows,
                LCK games per year
2. golgg      — per-player Games/KDA vs a cached gol.gg regular-season page
3. leaguepedia— season game counts vs the Leaguepedia Cargo API
                (OE folds promotion games into the following split, so
                Season+Promotion is the comparable LP total)

Usage:
    py src/validate.py                 # internal + golgg (offline)
    py src/validate.py --leaguepedia   # also query Leaguepedia (network)
"""

from __future__ import annotations

import argparse
import sys
import time
import urllib.parse
from io import StringIO
from pathlib import Path

import pandas as pd

try:
    sys.stdout.reconfigure(encoding="utf-8")
except (AttributeError, ValueError):
    pass

ROOT = Path(__file__).resolve().parents[1]
PARQUET = ROOT / "data" / "processed" / "lck.parquet"
CACHE = ROOT / "data" / "raw" / "golgg_cache"
UA = {"User-Agent": "LCK-statics/0.1 (personal, non-commercial research)"}


def check_internal(df: pd.DataFrame) -> None:
    print("=== internal ===")
    rpg = df.groupby("gameid").size()
    bad = rpg[rpg != 10]
    print(f"games with !=10 player rows: {len(bad)} "
          f"(upstream OE gaps; known: ~10 games in 2021/2023)")
    dup = df.duplicated(subset=["gameid", "playerid"]).sum()
    print(f"duplicate (game, player) rows: {dup}")
    g = df[df["league"] == "LCK"].groupby("year")["gameid"].nunique()
    flat = ", ".join(f"{y}:{n}" for y, n in g.items())
    print(f"LCK games/year: {flat}")
    odd = g[(g < 300) & (g.index < g.index.max())]
    if len(odd):
        print(f"  ! suspicious low counts: {odd.to_dict()}")


def check_golgg(df: pd.DataFrame, page: str, year: int, split: str) -> None:
    """Compare per-player Games/KDA vs a cached gol.gg regular-season page."""
    print(f"=== gol.gg: {page} ===")
    f = CACHE / (page.replace(" ", "_") + ".html")
    if not f.exists():
        print(f"  cache missing ({f.name}) — run scrape_golgg.py first")
        return
    tables = pd.read_html(StringIO(f.read_text(encoding="utf-8", errors="ignore")))
    gg = next((t for t in tables if "Player" in t.columns), None)
    if gg is None:
        print("  no player table found")
        return
    gg = gg[["Player", "Games", "KDA"]].copy()
    gg["_key"] = gg["Player"].astype(str).str.strip().str.casefold()
    ours = df[(df["year"] == year) & (df["league"] == "LCK")
              & (df["split"] == split) & (df["playoffs"] == 0)]
    oa = ours.groupby(ours["playername"].str.strip().str.casefold()).agg(
        games=("gameid", "nunique"), k=("kills", "sum"),
        d=("deaths", "sum"), a=("assists", "sum"))
    oa["kda"] = ((oa["k"] + oa["a"]) / oa["d"].where(oa["d"] > 0)).round(1)
    m = gg.merge(oa, left_on="_key", right_index=True, how="inner")
    gd = (m["Games"] - m["games"])
    kd = (pd.to_numeric(m["KDA"], errors="coerce") - m["kda"]).abs()
    print(f"  matched {len(m)}/{len(gg)} players | games exact: "
          f"{(gd == 0).sum()} | KDA within 0.2: {(kd <= 0.2).sum()}")
    for _, r in m[gd != 0].iterrows():
        print(f"  ! {r['Player']}: gol.gg {r['Games']} vs OE {r['games']} games")


def lp_count(overview: str) -> int | None:
    import requests
    url = ("https://lol.fandom.com/api.php?action=cargoquery&format=json"
           "&tables=ScoreboardGames&fields=COUNT(*)=n"
           "&where=" + urllib.parse.quote(f'OverviewPage="{overview}"'))
    for _ in range(4):
        j = requests.get(url, headers=UA, timeout=30).json()
        if "cargoquery" in j:
            return int(j["cargoquery"][0]["title"]["n"])
        time.sleep(4)
    return None


def check_leaguepedia(df: pd.DataFrame) -> None:
    print("=== Leaguepedia (Season [+Promotion] vs OE regular split) ===")
    checks = [
        (2023, "Summer"), (2024, "Spring"), (2019, "Spring"), (2016, "Summer"),
    ]
    for year, split in checks:
        season = lp_count(f"LCK/{year} Season/{split} Season")
        time.sleep(2)
        promo = lp_count(f"LCK/{year} Season/{split} Promotion") or 0
        time.sleep(2)
        oe = df[(df["year"] == year) & (df["league"] == "LCK")
                & (df["split"] == split) & (df["playoffs"] == 0)][
            "gameid"].nunique()
        if season is None:
            print(f"  {year} {split}: LP query failed (rate limit?)")
            continue
        total = season + promo
        mark = "OK" if abs(total - oe) <= 1 else "<<< CHECK"
        print(f"  {year} {split}: LP {season}+{promo} promo = {total} "
              f"vs OE {oe}  {mark}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--leaguepedia", action="store_true",
                    help="also query the Leaguepedia Cargo API (network)")
    args = ap.parse_args()
    df = pd.read_parquet(PARQUET)
    check_internal(df)
    print()
    check_golgg(df, "LCK Summer 2023", 2023, "Summer")
    check_golgg(df, "LCK Spring 2024", 2024, "Spring")
    if args.leaguepedia:
        print()
        check_leaguepedia(df)


if __name__ == "__main__":
    main()
