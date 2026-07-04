"""Aggregation/query layer over data/processed/lck.parquet.

Pure pandas, no Streamlit imports here so it can be unit-tested or reused.
Each row in the parquet is one player's performance in one game.
"""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
PARQUET = ROOT / "data" / "processed" / "lck.parquet"
SOLOKILLS = ROOT / "data" / "processed" / "solokills.parquet"
# Optional {gol.gg name: Oracle's Elixir name} overrides for handle mismatches.
NAME_OVERRIDES = ROOT / "src" / "golgg_name_overrides.json"


def _norm(name: str) -> str:
    return str(name).strip().casefold()


def load_solokills(
    path: Path = SOLOKILLS, games_source: Path = PARQUET
) -> pd.DataFrame | None:
    """gol.gg solo kills per (player, year, league). None if not scraped yet.

    Solo kills are gol.gg's own derived metric, aggregated per tournament and
    rolled up to (player, year, league) — they do NOT split by round/split,
    so they attach at season-league granularity only.

    Denominator correction: gol.gg omits players with no solo kills from a
    tournament page, so summing its per-page Games undercounts a player's
    real game count and inflates 솔킬/G (validated 2026-07: only 66% of
    (player, year, league) game counts matched OE). Where possible, games_gg
    is replaced by the exact OE game count for the same (name, year, league);
    the raw gol.gg figure stays untouched in solokills.parquet.
    """
    if not path.exists():
        return None
    sk = pd.read_parquet(path)
    overrides = {}
    if NAME_OVERRIDES.exists():
        overrides = json.loads(NAME_OVERRIDES.read_text(encoding="utf-8"))
    sk["_key"] = sk["playername"].map(
        lambda n: _norm(overrides.get(str(n).strip(), n))
    )
    sk["year"] = pd.to_numeric(sk["year"], errors="coerce").astype("Int64")
    if games_source and games_source.exists():
        oe = pd.read_parquet(
            games_source, columns=["playername", "year", "league", "gameid"]
        )
        oe["_key"] = oe["playername"].map(_norm)
        g = (
            oe.groupby(["_key", "year", "league"])["gameid"].nunique()
            .rename("games_oe").reset_index()
        )
        g["year"] = pd.to_numeric(g["year"], errors="coerce").astype("Int64")
        sk = sk.merge(g, on=["_key", "year", "league"], how="left")
        sk["games_gg"] = sk["games_oe"].where(
            sk["games_oe"].notna(), sk["games_gg"]
        )
        sk = sk.drop(columns=["games_oe"])
    return sk

_NUMERIC = [
    "result", "kills", "deaths", "assists", "teamkills", "dpm", "damageshare",
    "earned gpm", "cspm", "vspm", "gamelength", "damagetochampions",
    "earnedgold", "total cs", "visionscore",
]


def load_data(path: Path = PARQUET) -> pd.DataFrame:
    if not path.exists():
        raise FileNotFoundError(
            f"{path} not found. Run `py src/ingest.py` after placing "
            "Oracle's Elixir files in data/raw/."
        )
    df = pd.read_parquet(path)
    for col in _NUMERIC:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
    # Old parquets predate the playerid column; degrade to name-keyed identity.
    if "playerid" not in df.columns:
        df["playerid"] = "name:" + df["playername"].map(_norm)
    else:
        df["playerid"] = df["playerid"].fillna(
            "name:" + df["playername"].map(_norm)
        )
    return df


def _patch_key(p: str):
    try:
        return (0,) + tuple(int(x) for x in p.split("."))
    except ValueError:
        return (1, p)


def filter_options(df: pd.DataFrame) -> dict[str, list]:
    """Distinct values for each sidebar filter, ready to feed widgets."""
    years = sorted(int(y) for y in df["year"].dropna().unique())
    patches = sorted(
        {str(p) for p in df["patch"].dropna()} if "patch" in df.columns else [],
        key=_patch_key,
    )
    return {
        "years": years,
        "leagues": sorted(df["league"].dropna().unique().tolist()),
        "splits": sorted(df["split_label"].dropna().unique().tolist()),
        "rounds": sorted(df["round_label"].dropna().unique().tolist()),
        "positions": sorted(df["position"].dropna().unique().tolist()),
        "teams": sorted(df["teamname"].dropna().unique().tolist()),
        "lck_teams": sorted(
            df.loc[df["is_lck_team"], "teamname"].dropna().unique().tolist()
        ),
        "patches": patches,
        "champions": sorted(df["champion"].dropna().unique().tolist())
        if "champion" in df.columns else [],
    }


def apply_filters(
    df: pd.DataFrame,
    *,
    years: list[int] | None = None,
    leagues: list[str] | None = None,
    splits: list[str] | None = None,
    rounds: list[str] | None = None,
    teams: list[str] | None = None,
    positions: list[str] | None = None,
    patches: list[str] | None = None,
    champions: list[str] | None = None,
    complete_only: bool = False,
) -> pd.DataFrame:
    out = df
    if years:
        out = out[out["year"].isin(years)]
    if leagues:
        out = out[out["league"].isin(leagues)]
    if splits:
        out = out[out["split_label"].isin(splits)]
    if rounds:
        out = out[out["round_label"].isin(rounds)]
    if teams:
        out = out[out["teamname"].isin(teams)]
    if positions:
        out = out[out["position"].isin(positions)]
    if patches and "patch" in out.columns:
        out = out[out["patch"].astype(str).isin(patches)]
    if champions and "champion" in out.columns:
        out = out[out["champion"].isin(champions)]
    if complete_only and "datacompleteness" in out.columns:
        out = out[out["datacompleteness"] == "complete"]
    return out.copy()


def _kda(k: float, d: float, a: float) -> float:
    return (k + a) / d if d else float(k + a)


def _agg_block(g: pd.DataFrame) -> pd.Series:
    games = len(g)
    k, d, a = g["kills"].sum(), g["deaths"].sum(), g["assists"].sum()
    tk = g["teamkills"].sum()
    td = g["teamdeaths"].sum() if "teamdeaths" in g.columns else 0
    mins = g["gamelength"].sum() / 60.0

    def avg(col: str) -> float:
        return g[col].mean() if col in g.columns else float("nan")

    def wavg(col: str) -> float:
        """Game-length-weighted mean of a per-minute column (rows with a
        missing value contribute neither value nor weight)."""
        if col not in g.columns or "gamelength" not in g.columns:
            return avg(col)
        v = g[col]
        w = g["gamelength"].where(v.notna())
        tot = w.sum()
        return float((v * w).sum() / tot) if tot else float("nan")

    def per_min(total_col: str, permin_col: str) -> float:
        """True rate = sum(total) / minutes OF THE GAMES THAT HAVE THE STAT
        (mixing eras where a stat is unmeasured must not dilute the rate);
        falls back to the weighted mean of the per-minute column."""
        if total_col in g.columns and g[total_col].notna().any():
            v = g[total_col]
            secs = g["gamelength"].where(v.notna()).sum()
            if secs:
                return float(v.sum() / (secs / 60.0))
        return wavg(permin_col)

    # First blood: per-row kill+assist involvement, NaN-safe when one of the
    # two columns is entirely absent/missing for a subset of games.
    fb_cols = [c for c in ("firstbloodkill", "firstbloodassist") if c in g.columns]
    fb = g[fb_cols].sum(axis=1, min_count=1).mean() if fb_cols else float("nan")

    dpm = per_min("damagetochampions", "dpm")
    gpm = per_min("earnedgold", "earned gpm")
    return pd.Series(
        {
            "경기수": games,
            "승": int(g["result"].sum()),
            "승률%": round(100 * g["result"].mean(), 1),
            "KDA": round(_kda(k, d, a), 2),
            "K": round(g["kills"].mean(), 2),
            "D": round(g["deaths"].mean(), 2),
            "A": round(g["assists"].mean(), 2),
            "KP%": round(100 * (k + a) / tk, 1) if tk else float("nan"),
            "DPM": round(dpm, 1),
            "딜비중%": round(100 * avg("damageshare"), 1),
            "GPM": round(gpm, 1),
            "CS/분": round(per_min("total cs", "cspm"), 2),
            "GD@15": round(avg("golddiffat15"), 0),
            "CSD@15": round(avg("csdiffat15"), 1),
            "XPD@15": round(avg("xpdiffat15"), 1),
            "FB%": round(100 * fb, 1),
            "피FB%": round(100 * avg("firstbloodvictim"), 1),
            "데스/분": round(d / mins, 2) if mins else float("nan"),
            "데스지분%": round(100 * d / td, 1) if td else float("nan"),
            "받은딜/분": round(wavg("damagetakenperminute"), 0),
            "완화/분": round(wavg("damagemitigatedperminute"), 0),
            "DPG": round(dpm / gpm, 3) if gpm and pd.notna(gpm) else float("nan"),
            "시야/분": round(per_min("visionscore", "vspm"), 2),
            "챔프수": g["champion"].nunique() if "champion" in g.columns else 1,
        }
    )


def _display_names(df: pd.DataFrame) -> pd.DataFrame:
    """playerid -> most recent playername (handles renamed players)."""
    sub = df[["playerid", "playername"]].copy()
    if "date" in df.columns:
        sub = sub.assign(_d=df["date"]).sort_values("_d").drop(columns="_d")
    return sub.groupby("playerid", as_index=False)["playername"].last()


def _attach_solokills(
    res: pd.DataFrame, df: pd.DataFrame, sk: pd.DataFrame
) -> pd.DataFrame:
    """Add season-league solo kills: sum over the (year, league) pairs each
    player actually appears in within the filtered set. Not split-aware.
    gol.gg has no player ids, so the join is by normalized handle per
    (year, league), then rolled up to our playerid."""
    keys = (
        df[["playerid", "playername", "year", "league"]]
        .dropna(subset=["playername", "year", "league"])
        .copy()
    )
    keys["year"] = keys["year"].astype("Int64")
    keys["_key"] = keys["playername"].map(_norm)
    keys = keys.drop_duplicates(subset=["playerid", "_key", "year", "league"])
    j = keys.merge(sk, on=["_key", "year", "league"], how="inner")
    if j.empty:
        res["솔킬"] = pd.NA
        res["솔킬/G"] = pd.NA
        return res
    g = j.groupby("playerid", as_index=False).agg(
        솔킬=("solo_kills", "sum"),
        # unknown games for any contributing (year, league) -> unknown rate
        _g=("games_gg", lambda s: s.sum() if s.notna().all() else float("nan")),
    )
    g["솔킬/G"] = (g["솔킬"] / g["_g"]).round(3).where(g["_g"] > 0)
    return res.merge(g[["playerid", "솔킬", "솔킬/G"]], on="playerid", how="left")


def player_leaderboard(
    df: pd.DataFrame, min_games: int = 5, solokills: pd.DataFrame | None = None
) -> pd.DataFrame:
    if df.empty:
        return pd.DataFrame()
    res = (
        df.groupby("playerid", dropna=False)
        .apply(_agg_block, include_groups=False)
        .reset_index()
    )
    res = res.merge(_display_names(df), on="playerid", how="left").rename(
        columns={"playername": "선수"}
    )
    res = res[["playerid", "선수"] + [c for c in res.columns
                                      if c not in ("playerid", "선수")]]
    res = res[res["경기수"] >= min_games]
    res = res.sort_values("경기수", ascending=False).reset_index(drop=True)
    if solokills is not None and not solokills.empty:
        res = _attach_solokills(res, df, solokills)
    return res


def player_options(df: pd.DataFrame) -> pd.DataFrame:
    """Selectable players for the detail tab: playerid, display label, games.
    Same-handle players are disambiguated with their active years."""
    if df.empty:
        return pd.DataFrame(columns=["playerid", "label"])
    g = df.groupby("playerid").agg(
        games=("gameid", "count"),
        y0=("year", "min"), y1=("year", "max"),
    ).reset_index()
    opts = g.merge(_display_names(df), on="playerid", how="left")
    dup = opts["playername"].duplicated(keep=False)
    opts["label"] = opts["playername"]
    opts.loc[dup, "label"] = (
        opts["playername"] + " (" + opts["y0"].astype(str)
        + "–" + opts["y1"].astype(str) + ")"
    )
    return (
        opts.sort_values("games", ascending=False)
        [["playerid", "label"]].reset_index(drop=True)
    )


def team_leaderboard(df: pd.DataFrame, min_games: int = 5) -> pd.DataFrame:
    if df.empty:
        return pd.DataFrame()
    # One team-game = 5 player rows; collapse to team-game first for win/games.
    agg = {"result": ("result", "max")}
    if "side" in df.columns:
        agg["side"] = ("side", "first")
    tg = (
        df.groupby(["teamname", "gameid"], dropna=True)
        .agg(**agg)
        .reset_index()
    )
    rec = (
        tg.groupby("teamname")
        .agg(경기수=("result", "size"), 승=("result", "sum"))
        .reset_index()
    )
    rec["승률%"] = (100 * rec["승"] / rec["경기수"]).round(1)
    if "side" in tg.columns:
        side_wr = (
            tg.pivot_table(index="teamname", columns="side",
                           values="result", aggfunc="mean")
            .mul(100).round(1)
            .rename(columns={"Blue": "블루승률%", "Red": "레드승률%"})
            .reset_index()
        )
        keep = [c for c in ("teamname", "블루승률%", "레드승률%")
                if c in side_wr.columns]
        rec = rec.merge(side_wr[keep], on="teamname", how="left")
    rec = rec[rec["경기수"] >= min_games]
    return (
        rec.rename(columns={"teamname": "팀"})
        .sort_values("승률%", ascending=False)
        .reset_index(drop=True)
    )


def player_seasonal(df: pd.DataFrame, playerid: str) -> pd.DataFrame:
    """Per year / split / round breakdown for one player (trend table)."""
    sub = df[df["playerid"] == playerid]
    if sub.empty:
        return pd.DataFrame()
    res = (
        sub.groupby(["year", "split_label", "round_label", "league"], dropna=True)
        .apply(_agg_block, include_groups=False)
        .reset_index()
        .rename(
            columns={
                "year": "년도",
                "split_label": "시즌",
                "round_label": "라운드",
                "league": "대회",
            }
        )
    )
    return res.sort_values(["년도", "시즌", "라운드"]).reset_index(drop=True)


def player_champions(df: pd.DataFrame, playerid: str) -> pd.DataFrame:
    sub = df[df["playerid"] == playerid]
    if sub.empty:
        return pd.DataFrame()
    res = (
        sub.groupby("champion", dropna=True)
        .apply(_agg_block, include_groups=False)
        .reset_index()
        .rename(columns={"champion": "챔피언"})
    )
    return res.sort_values("경기수", ascending=False).reset_index(drop=True)
