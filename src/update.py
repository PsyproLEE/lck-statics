"""Incremental data update: download fresh Oracle's Elixir files and merge.

Oracle's Elixir now hosts the yearly match-data CSVs in a public Google Drive
folder (linked from https://oracleselixir.com/tools/downloads). This script

1. lists that folder (no API key needed — public embedded folder view),
2. downloads the requested years into data/raw/ (overwriting stale copies),
3. re-cleans ONLY those years and splices them into data/processed/lck.parquet
   (rows of other years are kept from the existing parquet as-is),
4. recomputes the is_lck_team tag over the merged dataset.

So a CI runner only needs the committed parquet + the current-year CSV —
not the full 800MB of raw history.

Usage:
    py src/update.py                 # current year (+ previous year in Jan-Feb)
    py src/update.py --years 2025 2026
    py src/update.py --full          # re-ingest everything in data/raw/
"""

from __future__ import annotations

import argparse
import datetime as _dt
import re
import sys
from pathlib import Path

import pandas as pd
import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ingest  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8")
except (AttributeError, ValueError):
    pass

ROOT = Path(__file__).resolve().parents[1]
RAW_DIR = ROOT / "data" / "raw"
OUT_PATH = ROOT / "data" / "processed" / "lck.parquet"

# Public OE match-data folder (from oracleselixir.com/tools/downloads).
DRIVE_FOLDER_ID = "1gLSw0RLjBbtaNy0dgnGQDAZOHIgCe-HH"
FOLDER_VIEW = "https://drive.google.com/embeddedfolderview?id={fid}"
# usercontent endpoint streams large files without the virus-scan interstitial.
FILE_DL = "https://drive.usercontent.google.com/download?id={fid}&export=download&confirm=t"
FNAME_RE = re.compile(r"(20\d\d)_LoL_esports_match_data_from_OraclesElixir\.csv")
HEADERS = {"User-Agent": "LCK-statics/0.1 (personal, non-commercial research)"}


def list_drive_files() -> dict[int, tuple[str, str]]:
    """{year: (drive_file_id, filename)} for OE yearly CSVs in the folder."""
    r = requests.get(FOLDER_VIEW.format(fid=DRIVE_FOLDER_ID), headers=HEADERS,
                     timeout=60)
    r.raise_for_status()
    entries = re.findall(
        r'id="entry-([\w-]+)".*?flip-entry-title">([^<]+)<', r.text, re.S
    )
    out: dict[int, tuple[str, str]] = {}
    for fid, name in entries:
        m = FNAME_RE.fullmatch(name.strip())
        if m:
            out[int(m.group(1))] = (fid, name.strip())
    if not out:
        raise SystemExit(
            "Could not list the Oracle's Elixir Drive folder - page layout "
            "may have changed. Download files manually into data/raw/."
        )
    return out


def download_year(year: int, fid: str, fname: str) -> Path:
    dest = RAW_DIR / fname
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    print(f"  downloading {fname} ...")
    with requests.get(FILE_DL.format(fid=fid), headers=HEADERS, stream=True,
                      timeout=300) as r:
        r.raise_for_status()
        ctype = r.headers.get("Content-Type", "")
        if "text/html" in ctype:
            raise SystemExit(
                f"Drive returned an HTML page instead of the CSV for {year} "
                "(rate limit or layout change). Try again later."
            )
        tmp = dest.with_suffix(".part")
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(chunk_size=1 << 20):
                f.write(chunk)
        tmp.replace(dest)
    print(f"    -> {dest.stat().st_size / 1e6:.1f} MB")
    return dest


def default_years() -> list[int]:
    """Current year; include previous year through February (late fixes)."""
    today = _dt.date.today()
    years = [today.year]
    if today.month <= 2:
        years.insert(0, today.year - 1)
    return years


def merge_years(new_frames: list[pd.DataFrame], years: list[int]) -> pd.DataFrame:
    fresh = pd.concat(new_frames, ignore_index=True, sort=False)
    fresh = ingest.clean(fresh)
    if OUT_PATH.exists():
        old = pd.read_parquet(OUT_PATH)
        # Replace by SOURCE FILE year, not data year: a yearly OE file can
        # hold rows whose `year` is the following January (e.g. KeSPA Cup),
        # and dropping by data year would silently delete those rows when
        # their source file wasn't part of this refresh.
        if "srcyear" in old.columns:
            old = old[~old["srcyear"].isin(years)]
        else:  # legacy parquet without srcyear
            old = old[~old["year"].isin(years)]
        merged = pd.concat([old, fresh], ignore_index=True, sort=False)
    else:
        print("  (no existing parquet - result will cover downloaded years only)")
        merged = fresh
    return ingest.tag_lck_teams(merged)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--years", type=int, nargs="+", default=None,
                    help="years to refresh (default: current year)")
    ap.add_argument("--full", action="store_true",
                    help="no download/merge; full re-ingest of data/raw/")
    args = ap.parse_args()

    if args.full:
        ingest.main()
        return

    years = args.years or default_years()
    print(f"OE incremental update, years: {years}")
    files = list_drive_files()
    frames: list[pd.DataFrame] = []
    done: list[int] = []
    for y in years:
        if y not in files:
            print(f"  ! {y}: not in the OE Drive folder (skip)")
            continue
        fid, fname = files[y]
        path = download_year(y, fid, fname)
        df = pd.read_csv(path, low_memory=False)
        df["srcyear"] = y
        frames.append(df)
        done.append(y)
    if not frames:
        raise SystemExit("Nothing downloaded - no matching years in the folder.")

    merged = merge_years(frames, done)
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    merged.to_parquet(OUT_PATH, index=False)
    yrs = merged["year"].dropna()
    print(
        f"  refreshed  : {done}\n"
        f"  total rows : {len(merged):,}\n"
        f"  years      : {int(yrs.min())}-{int(yrs.max())}\n"
        f"  written    : {OUT_PATH}"
    )


if __name__ == "__main__":
    main()
