# 데이터 출처 · 이용 조건 · 준수 사항

조사일: 2026-07-03 (원문 인용은 당시 각 사이트 게시 내용 기준).
이 프로젝트는 **개인·비상업** 용도이며, 아래 조건은 상업 전환 시 전부 재검토해야 한다.

## 요약

| 소스 | 용도 | 조건 | 우리의 사용 방식 |
|---|---|---|---|
| [Oracle's Elixir](https://oracleselixir.com) | 경기별 선수 통계 (메인) | 무료, 팬·분석가·해설자 용도. 파일은 하루 1회 갱신 | 주 1회 자동 다운로드 (연 1~2파일) |
| [gol.gg](https://gol.gg) | 솔로킬 보강 | 공식 API 없음, robots.txt 준수 스크랩 | 대회당 1페이지, 1.5초 간격, 캐시 |
| [Leaguepedia](https://lol.fandom.com) | (간접) OE 일부 데이터의 원천 + 검증용 API | CC BY-SA 3.0, 출처 표기 | 검증 시 Cargo API 소량 조회 |
| Riot Games | 원저작권자 (게임·대회) | 팬 콘텐츠 정책: 비상업 + 면책 문구 | 사이트 하단에 면책 문구 게시 |

## 1. Oracle's Elixir

다운로드 페이지 게시 문구 (2026-07 기준):

> "It is provided free of charge, and is intended for use by analysts,
> commentators, and fans."
>
> "Data files are updated **ONCE PER DAY**. There is no value in downloading
> the files more frequently than this."
>
> "Some content is provided courtesy of Leaguepedia, under a CC BY-SA 3.0."
>
> "*Oracle's Elixir* is not endorsed by Riot Games and doesn't reflect the
> views or opinions of Riot Games or anyone officially involved in producing
> or managing League of Legends."

- 명시적 라이선스 문서는 없고, 허용 범위가 불분명한 사용은 운영자(Tim
  Sevenhuysen)에게 문의하라고 안내함 → **상업적 사용 전 반드시 문의 필요**.
- 준수: 자동 갱신은 **주 1회**(월 03:30 KST), 갱신 대상 연도 파일만 다운로드.
  하루 1회 갱신 안내보다 훨씬 낮은 빈도.
- 표기: 사이트 하단 + README에 "Data courtesy of Oracle's Elixir" 표기.

## 2. gol.gg (Games of Legends)

- 공식 API·약관 문서 없음. **robots.txt**(2026-07 확인)는 일반 UA에 대해
  `/adm_lms/ /meta/ /week/ /raw/ /game/ajax.score.php /league-admin/ /user/
  /summoner/ /ranking/`만 차단 — 우리가 쓰는 `/players/list/…`(대회별 선수
  목록)와 `/tournament/ajax.trlist.php`(대회 목록)는 **차단 경로가 아님**.
- 준수: 대회당 1페이지, 요청 간 1.5초 지연, 식별 가능한 UA
  (`LCK-statics/0.1 (personal, non-commercial research)`), 로컬 캐시로 재요청
  방지, 주 1회 갱신.
- 수집 항목은 Solo Kills 컬럼 하나뿐이며, 사이트 콘텐츠를 재게시하지 않음.
- 표기: "솔킬: gol.gg (Games of Legends)".

## 3. Leaguepedia (lol.fandom.com)

- Fandom 위키 → 텍스트 콘텐츠는 **CC BY-SA 3.0**. OE 스스로 "Some content is
  provided courtesy of Leaguepedia, under a CC BY-SA 3.0"라고 명시하므로,
  OE를 쓰는 우리도 동일 표기를 유지한다 (사이트 하단·README).
- 직접 사용은 검증 스크립트(`src/validate.py --leaguepedia`)의 Cargo API
  소량 조회뿐 (요청 간 2초 지연).

## 4. Riot Games (원저작권자)

- 경기 데이터의 사실 정보(스코어·통계)는 사실(fact)이지만, 게임·리그 명칭과
  브랜드는 Riot 소유. Riot **팬 콘텐츠 정책**: 무료·비상업 팬 프로젝트 허용,
  Riot 로고·트레이드마크 사용 금지, 다음 면책 문구 게시 요구:
  > "[Project] was created under Riot Games' 'Legal Jibber Jabber' policy
  > using assets owned by Riot Games. Riot Games does not endorse or sponsor
  > this project."
- 이 사이트는 **챔피언 아이콘**을 Riot이 개발자용으로 공식 배포하는
  [Data Dragon](https://developer.riotgames.com/docs/lol#data-dragon) CDN에서
  직접 로드한다(재호스팅 없음, lazy 로딩). 팬 콘텐츠 정책상 비상업 프로젝트의
  에셋 사용에 해당하며, 요구되는 면책 문구를 하단에 게시한다. Riot 로고·
  트레이드마크는 사용하지 않는다.

## 데이터 정확성 · 알려진 한계 (교차검증 2026-07)

검증 방법과 결과는 README의 "데이터 정확성" 절 참고. 요약:

- OE 경기 수·KDA는 gol.gg 페이지, Leaguepedia와 표본 대조에서 사실상 일치.
- **승강전 재분류**: OE는 승강전을 다음 시즌 정규 스플릿에 포함하지만, 승강전
  136경기(2016~2020, Leaguepedia 승강전 페이지와 팀·날짜 1:1 대조)를 라운드
  "승강전"으로 재분류함 — 분리 후 2019 Spring 정규 208경기로 LP와 잔차 0.
- **결측 10경기**: 선수 행이 9개뿐인 경기 10개 (OE 원본 결측, 주로 2021 T1).
- **2015 한정 미측정 지표**: 시야점수·피해완화 등은 0으로 채워져 있어 결측
  처리함. 2015 이전 한국 리그(2012~2014 Champions)는 OE에 없음.
- **gol.gg 솔킬**: 대회 페이지에서 솔킬 0인 선수 생략 → 솔킬/G 분모는 OE
  경기수로 대체. MSI 2024는 gol.gg에 Solo Kills 컬럼 자체가 없음.
- Rift Rivals(2017~2019)는 OE에 데이터 없음.

## 상업 전환 시 체크리스트

1. Oracle's Elixir 운영자에게 사용 허가 문의 (필수)
2. gol.gg 스크랩 중단 또는 서면 허가
3. Leaguepedia CC BY-SA 3.0 → 파생물 동일 라이선스 공유 의무 검토
4. Riot 팬 콘텐츠 정책의 비상업 조건 위반 → Riot Developer API 등 공식 경로 검토
