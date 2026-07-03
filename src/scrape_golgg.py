"""Scrape per-tournament Solo Kills from gol.gg (Games of Legends).

gol.gg exposes one players-list page per tournament containing a table with a
``Solo Kills`` column:

    https://gol.gg/players/list/season-ALL/split-ALL/tournament-<NAME>/

This is the *only* solo-kill source we have (Oracle's Elixir has none).
gol.gg's solo kill is gol.gg's own derived definition (kill with no assists,
≈1v1), aggregated per tournament — no per-game / no "solo deaths".

We collect (player, year, league) -> total solo kills for LCK-relevant
tournaments 2021-2026. Pages are cached to data/raw/golgg_cache/ so re-runs
don't re-hit gol.gg (polite + robust + fast iteration).

Usage:
    py src/scrape_golgg.py                 # full 2021-2026 run
    py src/scrape_golgg.py --only "LCK Spring 2024"
    py src/scrape_golgg.py --no-cache      # force refetch
"""

from __future__ import annotations

import argparse
import re
import sys
import time
from io import StringIO
from pathlib import Path
from urllib.parse import quote

import pandas as pd
import requests

try:
    sys.stdout.reconfigure(encoding="utf-8")
except (AttributeError, ValueError):
    pass

ROOT = Path(__file__).resolve().parents[1]
CACHE_DIR = ROOT / "data" / "raw" / "golgg_cache"
OUT_PATH = ROOT / "data" / "processed" / "solokills.parquet"

BASE = "https://gol.gg/players/list/season-ALL/split-ALL/tournament-{name}/"
TRLIST_URL = "https://gol.gg/tournament/ajax.trlist.php"
HEADERS = {
    "User-Agent": "LCK-statics/0.1 (personal, non-commercial research)",
    "Accept": "text/html,application/xhtml+xml",
}
DELAY_SEC = 1.5
YEARS = range(2021, 2027)  # 2021-2026 (user-chosen scope)

# Map a gol.gg tournament name to an Oracle's Elixir league code.
# Order matters: more specific patterns first ("LCK CL" before "LCK").
_LEAGUE_PATTERNS: list[tuple[str, str]] = [
    ("lck cl", "LCKC"),
    ("lck challengers", "LCKC"),
    ("lck academy", ""),          # not in OE scope -> skip
    ("lck", "LCK"),
    ("mid-season invitational", "MSI"),
    ("msi", "MSI"),
    ("world championship", "WLDs"),
    ("worlds qualifying", ""),    # regional qualifier, not WLDs proper
    ("worlds", "WLDs"),
    ("first stand", "FST"),
    ("esports world cup", "EWC"),
    ("ewc", "EWC"),
    ("kespa", "KeSPA"),
]
_YEAR_RE = re.compile(r"\b(20\d\d)\b")


def _classify(trname: str) -> str | None:
    low = trname.lower()
    # Regional qualifiers (e.g. "EWC 2026 Online Qualifier - EMEA") are not
    # LCK-relevant — except Korea's own qualifier, which LCK teams play.
    if "qualifier" in low and "korea" not in low:
        return None
    for pat, league in _LEAGUE_PATTERNS:
        if pat in low:
            return league or None
    return None


def discover_tournaments() -> list[dict]:
    """Ask gol.gg for the real tournament list per season and keep LCK-relevant
    ones. This removes name-guessing: whatever gol.gg calls the event (e.g.
    "LCK 2025 Rounds 1-2", "Worlds 2025 Main Event") is used verbatim, so
    coverage gaps from renamed tournaments disappear.

    One POST per season; responses are tiny JSON lists. Falls back to the
    static candidate list if the endpoint fails.
    """
    out: list[dict] = []
    for y in YEARS:
        season = f"S{y - 2010}"  # gol.gg season codes: S5=2015 ... S16=2026
        try:
            r = requests.post(
                TRLIST_URL, data={"season": season},
                headers={**HEADERS, "Referer": "https://gol.gg/tournament/list/"},
                timeout=30,
            )
            r.raise_for_status()
            items = r.json()
        except (requests.RequestException, ValueError) as exc:
            print(f"  ! tournament list {season}: {exc}")
            return []  # caller falls back to the static list
        time.sleep(DELAY_SEC)
        for it in items:
            name = str(it.get("trname", "")).strip()
            league = _classify(name)
            if not league:
                continue
            m = _YEAR_RE.search(name)
            year = int(m.group(1)) if m else int(
                str(it.get("firstgame", ""))[:4] or y
            )
            if year not in YEARS:
                continue
            out.append({"gg": name, "year": year, "league": league})
    # De-dup (a tournament can span season lists).
    seen: set[str] = set()
    uniq = []
    for t in out:
        if t["gg"] not in seen:
            seen.add(t["gg"])
            uniq.append(t)
    return uniq


def _tournaments_fallback() -> list[dict]:
    """Static candidate names, used only if tournament discovery fails.

    Names gol.gg may not have are fine: the scraper skips missing pages and
    reports coverage. league maps to Oracle's Elixir league codes so the join
    is on (player, year, league) and is robust to split-naming differences.
    """
    out: list[dict] = []
    for y in YEARS:
        out += [
            {"gg": f"LCK Spring {y}", "year": y, "league": "LCK"},
            {"gg": f"LCK Summer {y}", "year": y, "league": "LCK"},
            # 2025+ LCK reformat candidates (skip-on-missing handles non-existent)
            {"gg": f"LCK Cup {y}", "year": y, "league": "LCK"},
            {"gg": f"LCK {y}", "year": y, "league": "LCK"},
            # internationals Korean teams attend
            {"gg": f"MSI {y}", "year": y, "league": "MSI"},
            {"gg": f"First Stand {y}", "year": y, "league": "FST"},
            {"gg": f"Worlds Play-In {y}", "year": y, "league": "WLDs"},
            {"gg": f"Worlds Main Event {y}", "year": y, "league": "WLDs"},
            {"gg": f"Esports World Cup {y}", "year": y, "league": "EWC"},
            {"gg": f"KeSPA Cup {y}", "year": y, "league": "KeSPA"},
            # challengers (optional; skipped if absent)
            {"gg": f"LCK CL Spring {y}", "year": y, "league": "LCKC"},
            {"gg": f"LCK CL Summer {y}", "year": y, "league": "LCKC"},
        ]
    # Targeted variants for gap years where the Play-In/Main-Event split names
    # were absent (2021/2022/2025). Combined-event names are added ONLY for
    # these years so they can't double-count with the split pages of 2023/2024.
    for y in (2021, 2022, 2025):
        out += [
            {"gg": f"Worlds {y}", "year": y, "league": "WLDs"},
            {"gg": f"World Championship {y}", "year": y, "league": "WLDs"},
        ]
    out += [
        {"gg": "LCK 2025 Season", "year": 2025, "league": "LCK"},
        {"gg": "LCK Summer 2025", "year": 2025, "league": "LCK"},
        {"gg": "Mid-Season Invitational 2024", "year": 2024, "league": "MSI"},
        {"gg": "Mid-Season Invitational 2025", "year": 2025, "league": "MSI"},
    ]
    return out


def _tournaments() -> list[dict]:
    discovered = discover_tournaments()
    if discovered:
        print(f"  discovered {len(discovered)} LCK-relevant tournaments from gol.gg")
        return discovered
    print("  ! discovery failed; using static candidate list")
    return _tournaments_fallback()


def _slug(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "_", name).strip("_")


def _get_html(name: str, use_cache: bool) -> str | None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache = CACHE_DIR / f"{_slug(name)}.html"
    if use_cache and cache.exists():
        return cache.read_text(encoding="utf-8", errors="ignore")
    url = BASE.format(name=quote(name))
    try:
        r = requests.get(url, headers=HEADERS, timeout=30)
    except requests.RequestException as exc:
        print(f"  ! {name}: request failed ({exc})")
        return None
    time.sleep(DELAY_SEC)  # be polite regardless of outcome
    if r.status_code != 200 or not r.text:
        print(f"  - {name}: HTTP {r.status_code} (skip)")
        return None
    cache.write_text(r.text, encoding="utf-8")
    return r.text


def _parse(html: str, name: str) -> pd.DataFrame | None:
    # Validate the page is actually this tournament's player list.
    if "player list from" not in html.lower():
        return None
    try:
        tables = pd.read_html(StringIO(html))
    except ValueError:
        return None
    for t in tables:
        cols = {str(c).strip(): c for c in t.columns}
        norm = {k.lower(): v for k, v in cols.items()}
        player_c = next((v for k, v in norm.items() if k == "player"), None)
        solo_c = next((v for k, v in norm.items() if "solo" in k), None)
        games_c = next((v for k, v in norm.items() if k == "games"), None)
        if player_c is None or solo_c is None:
            continue
        df = pd.DataFrame({
            "playername": t[player_c].astype(str).str.strip(),
            "solo_kills": pd.to_numeric(t[solo_c], errors="coerce"),
            "games_gg": (pd.to_numeric(t[games_c], errors="coerce")
                         if games_c is not None else float("nan")),
        })
        df = df[df["playername"].str.len() > 0]
        df = df.dropna(subset=["solo_kills"])
        df = df[~df["playername"].str.lower().isin(["nan", "total", "player"])]
        if len(df):
            return df.reset_index(drop=True)
    return None


def scrape(only: str | None, use_cache: bool) -> pd.DataFrame:
    targets = _tournaments()
    if only:
        targets = [t for t in targets if t["gg"].lower() == only.lower()]
        if not targets:
            targets = [{"gg": only, "year": 0, "league": "?"}]
    rows: list[pd.DataFrame] = []
    matched, skipped = [], []
    for t in targets:
        html = _get_html(t["gg"], use_cache)
        df = _parse(html, t["gg"]) if html else None
        if df is None or df.empty:
            skipped.append(t["gg"])
            continue
        df["year"] = t["year"]
        df["league"] = t["league"]
        df["gg_tournament"] = t["gg"]
        rows.append(df)
        matched.append(f"{t['gg']} ({len(df)})")

    print("\n=== coverage ===")
    print(f"matched ({len(matched)}): " + ", ".join(matched) or "none")
    print(f"skipped ({len(skipped)}): " + ", ".join(skipped) or "none")
    if not rows:
        return pd.DataFrame()
    allrows = pd.concat(rows, ignore_index=True)
    # games_gg: if ANY contributing tournament lacked a games count, the total
    # is unknown -> NaN (a partial denominator would inflate 솔킬/G downstream).
    agg = (
        allrows.groupby(["playername", "year", "league"], as_index=False)
        .agg(solo_kills=("solo_kills", "sum"),
             games_gg=("games_gg",
                       lambda s: s.sum() if s.notna().all() else float("nan")),
             gg_tournaments=("gg_tournament",
                             lambda s: ", ".join(sorted(set(s)))))
    )
    return agg


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default=None, help="single tournament name")
    ap.add_argument("--no-cache", action="store_true",
                    help="ignore HTML cache, refetch from gol.gg")
    args = ap.parse_args()

    print(f"gol.gg solo-kill scrape (cache={'off' if args.no_cache else 'on'})")
    df = scrape(args.only, use_cache=not args.no_cache)
    if df.empty:
        raise SystemExit("No solo-kill data scraped.")
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(OUT_PATH, index=False)
    print(
        f"\nplayers x (year,league): {len(df):,}\n"
        f"years    : {int(df['year'].min())}-{int(df['year'].max())}\n"
        f"leagues  : {', '.join(sorted(df['league'].unique()))}\n"
        f"total SK : {int(df['solo_kills'].sum()):,}\n"
        f"written  : {OUT_PATH}"
    )


if __name__ == "__main__":
    main()
