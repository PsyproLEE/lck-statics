# LCK 선수 통계 대시보드

LCK 프로 선수 통계를 **년도 / 시즌(Spring·Summer) / 라운드(정규·플레이오프) / 팀 / 국제대회**별로
필터링해서 보는 웹 대시보드입니다. 데이터 범위: **LCK 2015~현재**
(솔킬은 gol.gg 보강분 **2021~2026**, 연·리그 단위).

**▶ 사이트: <https://psyprolee.github.io/lck-statics/>** (GitHub Pages 정적
사이트 — 서버 없음, 필터·집계는 전부 브라우저에서 처리)

## 데이터 출처

**1) [Oracle's Elixir](https://oracleselixir.com/tools/downloads)** — 메인. 프로 LoL
경기별 선수 통계. 연도별 파일 1개, 매일 갱신. **2015~2019 `.xlsx`, 2020~ `.csv`**.
분석가·해설자·팬용 무료(비상업). 일부 Leaguepedia(CC-BY-SA 3.0) 제공.

**2) [gol.gg](https://gol.gg)** — 솔킬 전용(v2). OE에는 솔킬이 없어서, gol.gg의
토너먼트별 선수 목록 페이지에서 `Solo Kills`만 스크랩해 보강. 범위 2021~2026.
토너먼트 목록은 gol.gg 시즌별 목록 API에서 **자동 발견**하므로 명칭 추측이
필요 없고, 새 대회(LCK Cup, First Stand 등)도 자동 포함됩니다.

> **솔킬 주의 (gol.gg 제약):**
> - gol.gg **자체 정의**(어시 없는 단독 킬)의 파생 지표 — 공식 라이엇 수치 아님
> - **연·리그 단위 집계만** 가능(경기별·정규/플옵·포지션/팀 분리 불가)
> - `피솔킬`(당한 솔킬)은 gol.gg에 없음 → 미제공
> - gol.gg는 해당 시즌 솔킬 0인 선수를 목록에서 빼는 듯 → 일부 주전 공란 가능
> - MSI 2024는 gol.gg 페이지 자체에 Solo Kills 컬럼이 없어 수집 불가(공란)

## 설치

```powershell
py -m pip install -r requirements.txt
```

## 데이터 준비

1. <https://oracleselixir.com/tools/downloads> 에서 연도별 매치 데이터 파일을 받습니다
   (원하는 범위, 예: 2015~2026). 파일명 형식:
   `YYYY_LoL_esports_match_data_from_OraclesElixir.csv` (구버전은 `.xlsx`).
2. 받은 파일을 **`data/raw/`** 폴더에 그대로 넣습니다.
3. 인제스트 실행 (모든 파일 병합·정제 → `data/processed/lck.parquet`):

   ```powershell
   py src/ingest.py
   ```

   LCK / LCKC / MSI / Worlds / First Stand 등 관련 대회만 남기고(2015년 이후),
   연도별로 다른 스키마를 자동 정규화합니다. (없는 통계 컬럼은 자동으로 비움
   처리) 선수 식별은 핸들이 아닌 OE `playerid` 기준이라 동명이인이 합산되지
   않습니다.

### 갱신 (증분 업데이트)

시즌 진행 중 최신 경기를 반영할 때는 전체 재다운로드 없이:

```powershell
py src/update.py                # 올해 파일만 OE에서 받아 기존 parquet에 병합
py src/update.py --years 2025 2026   # 특정 연도들
py src/update.py --full         # data/raw/ 전체 재인제스트
```

OE가 현재 데이터를 공개 Google Drive 폴더로 제공하므로 `update.py`가 폴더를
읽어 해당 연도 CSV만 내려받고, 그 연도 행만 교체합니다.

4. (선택) 솔킬 보강 — gol.gg 스크랩 → `data/processed/solokills.parquet`:

   ```powershell
   py src/scrape_golgg.py
   ```

   토너먼트당 페이지 1개만 받고 `data/raw/golgg_cache/`에 캐시(재실행 시 재요청
   안 함). 정중한 UA·요청 간격 1.5초. 누락 명칭은 건너뛰고 커버리지 보고.
   특정 토너먼트만: `py src/scrape_golgg.py --only "LCK Spring 2024"`.
   solokills.parquet이 없어도 대시보드는 솔킬만 빠진 채 정상 동작합니다.

## 웹 대시보드 (GitHub Pages)

<https://psyprolee.github.io/lck-statics/> — `docs/` 폴더가 그대로 서빙되는
정적 사이트입니다. 데이터는 `docs/data/*.json`(≈12MB, gzip 전송 ≈2.6MB)로
내보내고, 필터·집계(시간가중 DPM, 솔킬 조인 포함)는 전부 브라우저 JS가
`src/queries.py`와 동일한 로직으로 수행합니다.

- **선수 리더보드** — 선수별 집계(승률·KDA·DPM·GPM·CS/분·KP% 등), 컬럼 클릭
  정렬, CSV 내려받기. DPM/GPM/CS 등 분당 지표는 경기 시간 가중(총량 ÷ 총 시간).
- **선수 상세** — 시즌 추이 그래프 + 시즌별/챔피언별 표 (더블클릭으로 이동,
  동명이인은 활동 연도로 구분)
- **팀** — 팀 승률 + 블루/레드 진영별 승률 (포지션·챔피언 필터는 팀 탭에 미적용)

`LCK 소속 팀만` 토글을 끄면 국제대회 상대 팀까지 포함됩니다.
켜진 상태에서 대회를 `MSI`/`WLDs`로 바꾸면 LCK 팀들의 국제대회 성적을 봅니다.
고급 필터에서 패치·챔피언·partial 제외를 조절합니다.

로컬 미리보기:

```powershell
py src/export_web.py                      # parquet -> docs/data/*.json
py -m http.server 8600 --directory docs   # http://localhost:8600
```

> 데이터가 공개 저장소에 올라갑니다. 개인·비상업 + 출처 표기(사이트 하단·README)
> 전제이며, OE/gol.gg는 비상업 한정입니다. 상업 전환 시 출처 정책 재확인.

## 자동 업데이트 (GitHub Actions)

GitHub에 푸시하면 [update-data.yml](.github/workflows/update-data.yml) 워크플로가
**매주 월요일 03:30 KST**(주말 경기 종료 후)에 자동 실행됩니다:

1. `python src/update.py` — OE에서 올해 CSV를 받아 lck.parquet에 증분 병합
2. `python src/scrape_golgg.py --no-cache` — gol.gg 솔킬 재수집
   (실패해도 기존 parquet 유지)
3. `python src/export_web.py` — 웹용 JSON 재생성
4. 바뀌었을 때만 자동 커밋·푸시 → GitHub Pages 자동 재배포

수동 실행: GitHub 저장소 → Actions → *Update data* → Run workflow.
로컬 수동 갱신도 동일: `py src/update.py` + `py src/scrape_golgg.py` +
`py src/export_web.py` 후 커밋·푸시하면 됩니다.

## 구조

```
data/raw/             OE 원본(.csv/.xlsx) + golgg_cache/ — git 제외
data/processed/       lck.parquet, solokills.parquet (생성물·소형, 커밋)
src/ingest.py         OE 원본 → 정제 parquet (playerid 보존, 2015+ 필터)
src/update.py         OE Drive에서 연도별 CSV 다운로드 + 증분 병합 (srcyear 기준)
src/scrape_golgg.py   gol.gg 솔킬 스크랩 (토너먼트 자동 발견) → solokills.parquet
src/queries.py        집계/필터 + 솔킬 조인 (파이썬 기준 구현, 테스트 대상)
src/export_web.py     parquet → docs/data/*.json (웹 프론트용)
docs/                 GitHub Pages 정적 사이트 (index.html, app.js, style.css, data/)
src/golgg_name_overrides.json  (선택) gol.gg→OE 선수명 보정 맵
tests/                pytest 단위 테스트 (py -m pytest)
.github/workflows/update-data.yml  주간 자동 데이터 갱신
```

## 라이선스 / 출처 표기

개인·비상업 용도. 출처 표기: *Data courtesy of Oracle's Elixir
(oracleselixir.com)*, 솔킬은 *gol.gg (Games of Legends)*.

- gol.gg는 공식 API가 없어 HTML 스크랩 — 저용량(토너먼트당 1페이지)·캐시·요청
  간격 준수로 정중하게 수집하며 개인·비상업 한정. 사이트 구조 변경 시 깨질 수
  있음(파서는 누락을 건너뛰고 보고).
- 상업적 사용으로 전환 시 Oracle's Elixir → Leaguepedia API 기반으로 교체,
  gol.gg 스크랩은 사용 조건 재확인 필요.
