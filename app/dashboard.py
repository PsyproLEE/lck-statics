"""LCK 선수 통계 대시보드 (Streamlit).

실행:
    streamlit run app/dashboard.py
데이터: Oracle's Elixir (oracleselixir.com) — 비상업적 사용.
"""

from __future__ import annotations

import sys
from pathlib import Path

import altair as alt
import pandas as pd
import streamlit as st

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import queries as q  # noqa: E402

st.set_page_config(page_title="LCK 선수 통계", page_icon="📊", layout="wide")

# 지표 설명 (단일 출처: 컬럼 헤더 툴팁 + 하단 설명 패널 공용).
# 사용자 요청에 따라 KDA·경기수·솔킬은 자명하므로 제외.
METRIC_HELP = {
    "승": "승리한 경기 수",
    "승률%": "승 ÷ 경기수 × 100",
    "K": "경기당 평균 킬",
    "D": "경기당 평균 데스",
    "A": "경기당 평균 어시스트",
    "KP%": "킬 관여율 = (킬+어시) ÷ 팀 총 킬 ×100. 교전 기여도",
    "DPM": "분당 챔피언 피해량(총딜 ÷ 총 경기시간). 포지션별 절대값 차이 큼(서폿≪원딜)",
    "딜비중%": "내 챔프 딜 ÷ 팀 5명 총딜 ×100. 캐리 의존도",
    "GPM": "분당 실획득 골드(시작·패시브 제외, 총골드 ÷ 총 경기시간). 성장 속도",
    "CS/분": "분당 미니언+정글 처치 수 (총CS ÷ 총 경기시간)",
    "GD@15": "15분 시점 상대 라이너 대비 골드 차이 (+면 우위)",
    "CSD@15": "15분 시점 CS 차이",
    "XPD@15": "15분 시점 경험치 차이",
    "FB%": "퍼스트블러드 관여율 (게임 첫 킬 또는 첫 어시)",
    "피FB%": "퍼스트블러드 피살률 (게임 첫 희생자가 된 비율)",
    "데스/분": "분당 사망 수. 낮을수록 좋음",
    "데스지분%": "팀 총 데스 중 본인 비중. 자원 헌납도",
    "받은딜/분": "분당 받은 피해량. 탱킹/어그로 (탑·탱커)",
    "완화/분": "분당 피해 완화량. 탱커 방어 기여",
    "DPG": "골드당 딜 = DPM ÷ GPM. 자원 효율",
    "시야/분": "분당 시야 점수 (vspm)",
    "챔프수": "사용한 고유 챔피언 수",
    "솔킬/G": "gol.gg 솔킬 ÷ gol.gg 경기수 (연·리그 기준)",
    "블루승률%": "블루 진영에서의 승률",
    "레드승률%": "레드 진영에서의 승률",
}


def _colcfg(frame: pd.DataFrame) -> dict:
    """컬럼 헤더에 마우스를 올리면 설명(?)이 뜨도록 column_config 생성."""
    return {
        c: st.column_config.Column(help=h)
        for c, h in METRIC_HELP.items()
        if c in frame.columns
    }


@st.cache_data(show_spinner="데이터 로딩 중...")
def _load() -> pd.DataFrame:
    return q.load_data()


@st.cache_data(show_spinner=False)
def _load_sk():
    return q.load_solokills()


try:
    DF = _load()
except FileNotFoundError as exc:
    st.title("LCK 선수 통계")
    st.warning(str(exc))
    st.info(
        "1. Oracle's Elixir 연도별 파일을 `data/raw/`에 넣으세요 "
        "(2015~2019 .xlsx, 2020~ .csv).\n"
        "2. `py src/ingest.py` 실행.\n"
        "3. 이 페이지 새로고침."
    )
    st.stop()

SK = _load_sk()
OPTS = q.filter_options(DF)

st.title("📊 LCK 선수 통계")
st.caption("년도·시즌·라운드·팀·국제대회별 LCK 프로 선수 통계")

# ----------------------------- 사이드바 필터 -----------------------------
with st.sidebar:
    st.header("필터")
    lck_only = st.toggle("LCK 소속 팀만", value=True,
                         help="끄면 국제대회 상대 팀 등 모든 팀 포함")
    team_pool = OPTS["lck_teams"] if lck_only else OPTS["teams"]

    years = st.multiselect("년도", OPTS["years"], default=OPTS["years"])
    leagues = st.multiselect("대회 / 리그", OPTS["leagues"],
                             default=[l for l in OPTS["leagues"] if l == "LCK"]
                             or OPTS["leagues"])
    splits = st.multiselect("시즌", OPTS["splits"], default=OPTS["splits"])
    rounds = st.multiselect("라운드", OPTS["rounds"], default=OPTS["rounds"])
    positions = st.multiselect("포지션", OPTS["positions"],
                               default=OPTS["positions"])
    teams = st.multiselect("팀", team_pool, default=[])
    min_games = st.slider("최소 경기수", 1, 50, 5)

    with st.expander("고급 필터"):
        patches = st.multiselect("패치 (비우면 전체)", OPTS["patches"],
                                 default=[])
        champions = st.multiselect("챔피언 (비우면 전체)", OPTS["champions"],
                                   default=[])
        complete_only = st.toggle(
            "완전한 데이터만", value=False,
            help="Oracle's Elixir가 partial로 표시한 경기(일부 지표 결측, "
                 "주로 @15 골드차 등)를 제외합니다.",
        )

    CORE_METRICS = ["경기수", "승률%", "KDA", "K", "D", "A", "KP%",
                    "DPM", "딜비중%", "GPM", "CS/분"]
    EXTRA_METRICS = ["GD@15", "CSD@15", "XPD@15", "FB%", "피FB%",
                     "데스/분", "데스지분%", "받은딜/분", "완화/분",
                     "DPG", "시야/분", "챔프수", "승", "솔킬", "솔킬/G"]
    # 기본으로 전체 지표 표시(솔킬류는 gol.gg 데이터 있을 때만).
    all_metrics = CORE_METRICS + EXTRA_METRICS
    default_metrics = [
        m for m in all_metrics
        if SK is not None or m not in ("솔킬", "솔킬/G")
    ]
    chosen = st.multiselect(
        "표시 지표", all_metrics, default=default_metrics,
        help="기본은 전체 표시. 빼고 싶은 지표를 제거하면 됩니다. "
             "각 지표 설명은 표 위 '지표 설명' 패널 또는 컬럼 헤더의 ? 참고",
    )

base = DF[DF["is_lck_team"]] if lck_only else DF
fdf = q.apply_filters(
    base, years=years, leagues=leagues, splits=splits,
    rounds=rounds, teams=teams, positions=positions,
    patches=patches, champions=champions, complete_only=complete_only,
)

if fdf.empty:
    st.warning("선택한 필터에 해당하는 데이터가 없습니다. 조건을 완화해 보세요.")
    st.stop()

c1, c2, c3, c4 = st.columns(4)
c1.metric("경기 행 수", f"{len(fdf):,}")
c2.metric("선수 수", f"{fdf['playername'].nunique():,}")
c3.metric("팀 수", f"{fdf['teamname'].nunique():,}")
yr = fdf["year"].dropna()
c4.metric("기간", f"{int(yr.min())}–{int(yr.max())}" if len(yr) else "-")

with st.expander("ℹ️ 지표 설명 (KDA·경기수·솔킬은 자명하여 제외)"):
    st.dataframe(
        pd.DataFrame(
            {"지표": list(METRIC_HELP), "설명": list(METRIC_HELP.values())}
        ),
        width="stretch", hide_index=True, height=460,
    )
    st.caption(
        "표의 각 컬럼 헤더에 마우스를 올리면 같은 설명이 툴팁(?)으로 표시됩니다."
    )

tab_p, tab_d, tab_t = st.tabs(["선수 리더보드", "선수 상세", "팀"])

# ----------------------------- 선수 리더보드 -----------------------------
with tab_p:
    lb = q.player_leaderboard(fdf, min_games=min_games, solokills=SK)
    if SK is not None and ("솔킬" in chosen or "솔킬/G" in chosen):
        st.caption(
            "솔킬: gol.gg 기준(어시 없는 단독 킬). **연·리그 단위 집계**라 "
            "라운드(정규/플옵)·포지션·팀 필터와 무관하게 해당 연도·리그 전체 "
            "값으로 표시됩니다. 일부 국제대회·2025 본시즌은 미수집(공란)."
        )
    if lb.empty:
        st.info(f"최소 경기수({min_games}) 조건을 만족하는 선수가 없습니다.")
    else:
        show = ["선수"] + [c for c in chosen if c in lb.columns]
        st.dataframe(lb[show], width="stretch", hide_index=True,
                     height=600, column_config=_colcfg(lb[show]))
        # utf-8-sig (BOM) so Excel on Windows reads Korean headers correctly.
        st.download_button(
            "CSV 내려받기 (전체 지표)",
            lb.to_csv(index=False).encode("utf-8-sig"),
            "lck_players.csv", "text/csv",
        )

# ----------------------------- 선수 상세 -----------------------------
with tab_d:
    popts = q.player_options(fdf)
    labels = dict(zip(popts["playerid"], popts["label"]))
    pid = st.selectbox("선수 선택", popts["playerid"].tolist(),
                       format_func=lambda p: labels.get(p, p))
    if pid:
        player = labels.get(pid, pid)
        seasonal = q.player_seasonal(fdf, pid)
        champs = q.player_champions(fdf, pid)

        st.subheader(f"{player} — 시즌별 추이")
        if not seasonal.empty:
            seasonal = seasonal.copy()
            seasonal["구간"] = (
                seasonal["년도"].astype(str) + " " + seasonal["시즌"]
                + " · " + seasonal["라운드"]
            )
            metric = st.selectbox(
                "그래프 지표",
                ["KDA", "DPM", "GPM", "CS/분", "승률%", "KP%"],
            )
            chart = (
                alt.Chart(seasonal)
                .mark_line(point=True)
                .encode(
                    x=alt.X("구간:N", sort=None, title=None),
                    y=alt.Y(f"{metric}:Q"),
                    tooltip=["구간", "대회", "경기수", metric],
                )
                .properties(height=320)
            )
            st.altair_chart(chart, width="stretch")
            s_ids = ["년도", "시즌", "라운드", "대회"]
            s_show = s_ids + [c for c in chosen if c in seasonal.columns]
            st.dataframe(seasonal[s_show], width="stretch", hide_index=True,
                         column_config=_colcfg(seasonal[s_show]))

        st.subheader(f"{player} — 챔피언 폭")
        if not champs.empty:
            c_show = ["챔피언"] + [c for c in chosen if c in champs.columns]
            st.dataframe(champs[c_show], width="stretch", hide_index=True,
                         column_config=_colcfg(champs[c_show]))

# ----------------------------- 팀 -----------------------------
with tab_t:
    tl = q.team_leaderboard(fdf, min_games=min_games)
    if tl.empty:
        st.info("조건을 만족하는 팀이 없습니다.")
    else:
        st.dataframe(tl, width="stretch", hide_index=True,
                     column_config=_colcfg(tl))
        st.bar_chart(tl.set_index("팀")["승률%"])

st.caption(
    "데이터 출처: Oracle's Elixir (oracleselixir.com). "
    "비상업적 사용. 일부 데이터는 Leaguepedia (CC-BY-SA 3.0) 제공."
)
