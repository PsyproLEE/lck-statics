"""Unit tests for the aggregation/query layer (src/queries.py).

Run:
    py -m pytest
"""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import queries as q  # noqa: E402


def _rows(**over) -> dict:
    """One player-game row with sane defaults; override per test."""
    base = {
        "gameid": "g1", "league": "LCK", "year": 2024, "split_label": "Spring",
        "round_label": "정규시즌", "playername": "Faker", "playerid": "oe:1",
        "teamname": "T1", "position": "mid", "champion": "Azir",
        "side": "Blue", "patch": "14.01", "datacompleteness": "complete",
        "result": 1, "kills": 3, "deaths": 1, "assists": 5, "teamkills": 15,
        "teamdeaths": 8, "gamelength": 1800, "dpm": 500.0, "earned gpm": 250.0,
        "cspm": 9.0, "vspm": 1.2, "damageshare": 0.28,
        "damagetochampions": 15000.0, "earnedgold": 7500.0, "total cs": 270.0,
        "visionscore": 36.0, "is_lck_team": True, "is_international": False,
        "date": pd.Timestamp("2024-01-15"),
    }
    base.update(over)
    return base


@pytest.fixture
def df() -> pd.DataFrame:
    return pd.DataFrame([
        # Faker: 2 games (1 win, 1 loss); the second game is twice as long.
        _rows(),
        _rows(gameid="g2", result=0, kills=1, deaths=3, assists=2,
              gamelength=3600, damagetochampions=36000.0, earnedgold=12000.0,
              side="Red", date=pd.Timestamp("2024-01-20")),
        # A second, different player who uses the SAME handle (name clash).
        _rows(gameid="g3", playerid="oe:2", playername="Faker",
              teamname="KT", year=2015, kills=10,
              date=pd.Timestamp("2015-03-01")),
    ])


def test_leaderboard_separates_same_handle_players(df):
    lb = q.player_leaderboard(df, min_games=1)
    assert len(lb) == 2  # oe:1 and oe:2 stay separate despite equal handles
    assert set(lb["playerid"]) == {"oe:1", "oe:2"}


def test_leaderboard_basic_aggregates(df):
    lb = q.player_leaderboard(df, min_games=2)
    row = lb[lb["playerid"] == "oe:1"].iloc[0]
    assert row["경기수"] == 2
    assert row["승"] == 1
    assert row["승률%"] == 50.0
    # KDA = (4+7)/4
    assert row["KDA"] == round(11 / 4, 2)


def test_dpm_is_time_weighted_not_per_game_mean(df):
    lb = q.player_leaderboard(df, min_games=2)
    row = lb[lb["playerid"] == "oe:1"].iloc[0]
    # totals: (15000+36000) dmg / (1800+3600)/60 min = 51000/90 ≈ 566.7
    assert row["DPM"] == round(51000 / 90, 1)
    # naive per-game dpm mean would have been 500.0 -> must NOT be that
    assert row["DPM"] != 500.0


def test_apply_filters_champion_patch_completeness(df):
    assert len(q.apply_filters(df, champions=["Azir"])) == 3
    assert len(q.apply_filters(df, champions=["Zed"])) == 0
    assert len(q.apply_filters(df, patches=["14.01"])) == 3
    df2 = df.copy()
    df2.loc[df2["gameid"] == "g2", "datacompleteness"] = "partial"
    assert len(q.apply_filters(df2, complete_only=True)) == 2


def test_team_leaderboard_side_winrates(df):
    tl = q.team_leaderboard(df, min_games=1)
    t1 = tl[tl["팀"] == "T1"].iloc[0]
    assert t1["경기수"] == 2
    assert t1["블루승률%"] == 100.0  # g1 Blue win
    assert t1["레드승률%"] == 0.0    # g2 Red loss


def test_attach_solokills_with_override_and_missing_games():
    df = pd.DataFrame([
        _rows(),
        _rows(gameid="g2", year=2023, date=pd.Timestamp("2023-06-01")),
    ])
    sk = pd.DataFrame({
        "playername": ["Faker", "Faker"],
        "_key": ["faker", "faker"],
        "year": pd.array([2024, 2023], dtype="Int64"),
        "league": ["LCK", "LCK"],
        "solo_kills": [7, 5],
        "games_gg": [40.0, float("nan")],  # 2023 games unknown
    })
    lb = q.player_leaderboard(df, min_games=1, solokills=sk)
    row = lb.iloc[0]
    assert row["솔킬"] == 12          # sums across both seasons
    assert pd.isna(row["솔킬/G"])     # unknown denominator -> NA, not inflated


def test_player_options_disambiguates_duplicate_handles(df):
    opts = q.player_options(df)
    labels = opts["label"].tolist()
    assert len(opts) == 2
    # both entries carry year ranges since the handle collides
    assert all("(" in lab for lab in labels)


def test_player_seasonal_by_playerid(df):
    s = q.player_seasonal(df, "oe:1")
    assert len(s) == 1
    assert s.iloc[0]["경기수"] == 2
    assert q.player_seasonal(df, "oe:2").iloc[0]["K"] == 10
