"""Ingest Oracle's Elixir yearly match-data files into a single cleaned parquet.

Reads every .csv / .xlsx in data/raw/ (Oracle's Elixir naming:
``YYYY_LoL_esports_match_data_from_OraclesElixir.{csv,xlsx}``), keeps LCK +
relevant international rows, normalizes the schema across years, and writes
data/processed/lck.parquet.

Usage:
    py src/ingest.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

# Windows consoles default to cp949 here; force UTF-8 so summary output
# (and any non-ASCII team/player names) never crash the run.
try:
    sys.stdout.reconfigure(encoding="utf-8")
except (AttributeError, ValueError):
    pass

ROOT = Path(__file__).resolve().parents[1]
RAW_DIR = ROOT / "data" / "raw"
OUT_PATH = ROOT / "data" / "processed" / "lck.parquet"

# Leagues kept. Domestic Korea + international events LCK teams attend.
DOMESTIC_LEAGUES = {"LCK", "LCKC", "KeSPA"}  # LCKC = LCK Challengers League
INTERNATIONAL_LEAGUES = {"MSI", "WLDs", "WCS", "IEM", "Rift Rivals", "ASE", "EWC",
                         "FST"}  # FST = First Stand (2025+)
KEEP_LEAGUES = DOMESTIC_LEAGUES | INTERNATIONAL_LEAGUES

# Dashboard scope is 2015+; a stray 2014 file in data/raw/ must not leak in.
YEAR_MIN = 2015

# Columns persisted to parquet (only those that exist in a given year are kept).
META_COLS = [
    "gameid", "datacompleteness", "league", "year", "split", "playoffs",
    "date", "patch", "side", "position", "playername", "playerid",
    "teamname", "teamid", "champion",
]
NUMERIC_COLS = [
    "gamelength", "result", "kills", "deaths", "assists", "teamkills",
    "teamdeaths", "damagetochampions", "dpm", "damageshare",
    "damagetakenperminute", "damagemitigatedperminute", "earnedgold",
    "earned gpm", "earnedgoldshare", "total cs", "cspm", "visionscore",
    "vspm", "wardsplaced", "wpm", "wcpm", "controlwardsbought",
    "firstbloodkill", "firstbloodassist", "firstbloodvictim",
    "goldat10", "xpat10", "csat10", "golddiffat10", "xpdiffat10",
    "csdiffat10", "goldat15", "csat15", "golddiffat15", "xpdiffat15",
    "csdiffat15",
]


def _read_one(path: Path) -> pd.DataFrame | None:
    """Read a single OE file (csv or xlsx). Return None if unreadable."""
    try:
        if path.suffix.lower() == ".csv":
            return pd.read_csv(path, low_memory=False)
        if path.suffix.lower() in (".xlsx", ".xls"):
            return pd.read_excel(path, engine="openpyxl")
    except Exception as exc:  # noqa: BLE001 - report & skip bad files
        print(f"  ! skip {path.name}: {exc}")
    return None


def _find_raw_files() -> list[Path]:
    files = sorted(
        p for p in RAW_DIR.glob("*")
        if p.suffix.lower() in (".csv", ".xlsx", ".xls") and p.name != ".gitkeep"
    )
    return files


def load_raw() -> pd.DataFrame:
    files = _find_raw_files()
    if not files:
        raise SystemExit(
            f"No data files found in {RAW_DIR}\n"
            "Download Oracle's Elixir yearly match-data files into data/raw/ "
            "first (see README.md)."
        )
    frames: list[pd.DataFrame] = []
    for path in files:
        print(f"  reading {path.name} ...")
        df = _read_one(path)
        if df is not None and len(df):
            frames.append(df)
    if not frames:
        raise SystemExit("No readable rows in data/raw/.")
    # Years have differing schemas; concat takes the column union (missing -> NaN).
    return pd.concat(frames, ignore_index=True, sort=False)


def clean(df: pd.DataFrame) -> pd.DataFrame:
    if "league" not in df.columns:
        raise SystemExit("Input is missing the 'league' column - not Oracle's Elixir data?")

    df = df[df["league"].isin(KEEP_LEAGUES)].copy()

    # Player rows only (drop the 2 per-game 'team' summary rows).
    if "position" in df.columns:
        df = df[df["position"].astype(str).str.lower() != "team"].copy()

    # Coerce numerics; absent columns are created as NaN so downstream is safe.
    for col in NUMERIC_COLS:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
        else:
            df[col] = pd.NA

    if "date" in df.columns:
        df["date"] = pd.to_datetime(df["date"], errors="coerce")
    if "year" in df.columns:
        df["year"] = pd.to_numeric(df["year"], errors="coerce").astype("Int64")
    elif "date" in df.columns:
        df["year"] = df["date"].dt.year.astype("Int64")
    df = df[df["year"] >= YEAR_MIN].copy()

    # split is often empty for international events.
    if "split" not in df.columns:
        df["split"] = ""
    df["split"] = df["split"].fillna("").astype(str).str.strip()
    df["split_label"] = df["split"].where(df["split"] != "", "기타/국제")

    # round: regular vs playoffs.
    if "playoffs" in df.columns:
        df["playoffs"] = pd.to_numeric(df["playoffs"], errors="coerce").fillna(0).astype(int)
    else:
        df["playoffs"] = 0
    df["round_label"] = df["playoffs"].map({1: "플레이오프"}).fillna("정규시즌")

    df["is_international"] = ~df["league"].isin(DOMESTIC_LEAGUES)

    keep = [c for c in META_COLS + NUMERIC_COLS if c in df.columns]
    keep += ["split_label", "round_label", "is_international"]
    df = df[keep].reset_index(drop=True)

    # Drop rows with no usable identity.
    df = df.dropna(subset=["playername", "teamname"], how="any")

    # Stable player identity: OE playerid when present, else a name-derived
    # fallback so grouping never silently merges missing-id rows.
    if "playerid" not in df.columns:
        df["playerid"] = pd.NA
    fallback = "name:" + df["playername"].astype(str).str.strip().str.casefold()
    df["playerid"] = df["playerid"].fillna(fallback)
    return df


def tag_lck_teams(df: pd.DataFrame) -> pd.DataFrame:
    """(Re)compute is_lck_team over the FULL dataset.

    Teams that appear in LCK / LCKC = "LCK teams"; tag their rows everywhere
    (so international games of those teams are reachable via the team filter).
    Kept separate from clean() so incremental updates (src/update.py) can
    recompute it after merging new rows with the existing parquet.
    """
    lck_teams = set(
        df.loc[df["league"].isin({"LCK", "LCKC"}), "teamname"].dropna().unique()
    )
    df = df.copy()
    df["is_lck_team"] = df["teamname"].isin(lck_teams)
    return df


def main() -> None:
    print(f"Oracle's Elixir ingest -> {OUT_PATH.relative_to(ROOT)}")
    raw = load_raw()
    print(f"  raw rows: {len(raw):,}")
    df = tag_lck_teams(clean(raw))
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(OUT_PATH, index=False)

    yrs = df["year"].dropna()
    print(
        f"  kept rows : {len(df):,}\n"
        f"  years     : {int(yrs.min())}-{int(yrs.max())}\n"
        f"  leagues   : {', '.join(sorted(df['league'].dropna().unique()))}\n"
        f"  LCK teams : {df.loc[df['is_lck_team'], 'teamname'].nunique()}\n"
        f"  players   : {df['playername'].nunique():,}"
    )
    print(f"  written   : {OUT_PATH}")


if __name__ == "__main__":
    sys.exit(main())
