# 🗡️ 어린이용 벨트스크롤 액션 게임 개발 가이드

> **던전앤파이터 스타일** 횡스크롤 액션 · **HTML5 Canvas + Google Apps Script(+ Google 스프레드시트)**
> 아이들이 즐길 수 있는 게임을 *아이와 함께* 만들어 가는 것을 전제로 한 가이드입니다.

## 목차

0. [지금 어디까지 왔나 (현재 상태)](#0-지금-어디까지-왔나-현재-상태)
1. [만들 게임 한눈에 보기](#1-만들-게임-한눈에-보기)
2. [아이들용 게임 설계 원칙](#2-아이들용-게임-설계-원칙)
3. [기술 구조](#3-기술-구조)
4. [개발 환경 준비](#4-개발-환경-준비)
5. [벨트스크롤 엔진 핵심 개념](#5-벨트스크롤-엔진-핵심-개념)
6. [Step 1 — 실행되는 프로토타입](#6-step-1--실행되는-프로토타입)
7. [콘텐츠 설계 (캐릭터·몬스터·스테이지)](#7-콘텐츠-설계-캐릭터몬스터스테이지)
8. [Apps Script 서버 기능 (저장·랭킹·배포)](#8-apps-script-서버-기능-저장랭킹배포)
9. [아트 & 사운드](#9-아트--사운드)
10. [로드맵 (마일스톤 체크리스트)](#10-로드맵-마일스톤-체크리스트)
11. [자주 겪는 문제](#11-자주-겪는-문제)
12. [결정이 필요한 것들](#12-결정이-필요한-것들)

---

## 0. 지금 어디까지 왔나 (현재 상태)

**플레이할 수 있는 게임이 완성됐어요!** 임시 이름은 **「젤리 던전」** — 귀여운 젤리 용사가 사탕 숲의 방 6개를 지나 보스 **젤리 대왕**을 잡는 벨트스크롤 액션입니다. 한 판에 약 4~7분.

### 바로 해 보기

**[`dist/index.html`](dist/index.html) 을 더블클릭**하면 열립니다. (서버·인터넷 없이 동작. 인터넷이 되면 귀여운 글꼴이 같이 로드돼요)

| 동작 | 키보드 | 터치 (태블릿·폰) |
|------|--------|------------------|
| 이동 | 방향키 | 왼쪽 조이스틱 |
| 공격 (연타하면 3연타 콤보) | `Z` 또는 `Space` | 공격 버튼 |
| 점프 | `X` | 점프 버튼 |
| 스킬 `회오리` / `돌진` / `대폭발` | `A` / `S` / `D` | 스킬 버튼 |
| 일시정지 / 소리 끄기 | `Esc`·`P` / `M` | 화면의 ⏸ / 🔊 버튼 |

난이도는 **쉬움**(게임 오버 없음) · **보통**(목숨 3개) · **어려움**(목숨 1개, 도전!) 중에서 고릅니다. 처음 켰을 때는 쉬움이 미리 골라져 있어요. 보통/어려움에서 쓰러지면 **「이 방부터 다시 하기」**로 도착한 방부터 이어서 할 수 있어요(이어서 한 판은 랭킹에 올라가지 않아요).

### 저장소 지도

```
seongmo-fight/
├─ GUIDE.md                ← 이 문서 (개념·설계 가이드)
├─ dist/index.html         ← ▶ 바로 실행하는 단일 파일 (src/ 를 합쳐 만든 결과 — 직접 고치지 말 것)
├─ src/                    ← 진짜 게임 소스 (Apps Script 로 올라가는 파일들)
│   ├─ index.html            껍데기(캔버스 + 오버레이) + <?!= include('...') ?>
│   ├─ style.html            화면 꾸밈(CSS)
│   ├─ js_core.html          엔진: 입력·물리·전투(히트스톱/넉백/띄우기)·효과·소리(WebAudio)·루프
│   ├─ js_player.html        플레이어: 3연타 콤보, 점프 공격, 스킬 3개
│   ├─ js_enemies.html       몬스터 3종 + 보스: 예고 동작이 있는 상태 머신 AI
│   ├─ js_stage.html         던전: 방·웨이브·픽업·점수·별·배경
│   ├─ js_ui.html            타이틀·HUD·결과·일시정지·랭킹·터치 컨트롤
│   ├─ js_server.html        랭킹 저장/조회 (서버 없으면 이 기기에 저장)
│   ├─ js_main.html          시작 코드
│   ├─ Code.gs               Apps Script 서버 (검증·시트 저장·랭킹)
│   └─ appsscript.json       웹앱 설정
├─ docs/
│   ├─ ARCHITECTURE.md       모듈 간 약속(공개 API·이벤트·데이터 모양) — 코드를 고치기 전에 읽기
│   └─ DEPLOY.md             Apps Script 에 올리는 방법 (비전문가용 단계별)
├─ tools/                  ← 빌드·테스트 도구 (build-local.mjs, test-all.mjs, 플레이 봇 …)
│   └─ tests/                8개 테스트 파일 (자동 검사 2800여 개)
└─ prototype/index.html    ← 6장의 학습용 프로토타입 (150줄)
```

### 개발할 때 쓰는 명령

```bash
npm run build                      # src/ → dist/index.html (src 를 고쳤으면 꼭! dist 도 같이 커밋)
node tools/test-all.mjs --quick    # 전체 자동 테스트 (빠른 것만)
node tools/test-all.mjs            # + 봇이 처음부터 끝까지 플레이하는 느린 테스트
GAME_HTML=dist/index.html node tools/tests/core.test.mjs   # 테스트 파일 하나만
```

숫자(몬스터 체력·공격력, 방 구성, 난이도 배율)는 파일 맨 위의 **데이터 표**에서 바꿉니다: `ENEMY_DEFS`(js_enemies), `STAGES`·`STAGE_TUNE`(js_stage), `PLAYER_DEF`(js_player), `CFG.difficulty`(js_core). 바꾼 뒤 `npm run build` → `dist/index.html` 새로고침.

### 마일스톤 상태

| 단계 | 상태 |
|------|------|
| M0 준비 | ✅ 저장소·가이드 · ⬜ 이름·세계관을 아이와 함께 정하기 (지금은 임시 이름) |
| M1 움직이는 캐릭터 | ✅ |
| M2 때리고 맞기 | ✅ 몬스터 AI·피격·부활·타격감 8종 전부 |
| M3 방 하나 완성 | ✅ 웨이브·`GO ▶`·카메라·콤보·스킬 |
| M4 던전 완성 | ✅ 방 7개(보스 포함)·결과 화면·난이도 3단계·터치 조작 |
| M5 Apps Script + 랭킹 | 🔶 코드 완성 + 모의 환경 테스트 통과 · ⬜ **실제 배포는 아직** (`docs/DEPLOY.md`) |
| M6 그림·소리 | 🔶 캐릭터·소리·배경을 **코드로 그려서** 완성(이미지 파일 없음) · ⬜ 아이가 그린 그림 넣기 |
| M7 확장 | 🔶 아이템 드롭(사탕·코인)만 · ⬜ 직업·레벨업·스테이지 2~3 |

### ⚠️ 아직 해 보지 못한 것 (정직하게)

- **실제 Apps Script 에 올려서 돌려 보기** — 서버 코드와 HTML 모두 로컬 모의 환경으로만 검증했어요. 첫 배포는 `docs/DEPLOY.md` 를 따라 해 보고, 막히면 알려 주세요.
- **소리를 사람 귀로 듣기** — 파형·주파수 분석으로만 확인했어요(터지는 소리·너무 큰 소리는 없음). 볼륨과 멜로디는 직접 들어 보고 조정이 필요할 수 있어요.
- **실제 태블릿/크롬북 터치, 고주사율(144Hz) 화면** — 헤드리스 브라우저로만 확인했어요.
- **아이들 플레이 테스트** — 난이도와 분량은 *봇*으로 맞춘 값이에요(쉬움 ≈6~7분, 보통 ≈4.5분, 어려움 ≈4.5분·숙련 봇 승률 약 65%). 실제 아이들 반응을 보고 위 데이터 표의 숫자를 조정하세요.
- 닉네임 **금칙어는 시작용 목록**이라 모든 변형을 막지 못해요. 랭킹은 어른이 가끔 확인해 주세요.

---

## 1. 만들 게임 한눈에 보기

### 한 줄 컨셉

> 귀여운 몬스터가 사는 던전을 방 단위로 돌파하며, 콤보와 스킬로 몬스터를 쓰러뜨리고 보스를 잡는 **어린이용 벨트스크롤 액션**.

### 던파에서 가져올 재미 (장르의 핵심)

| # | 재미 요소 | 구현 포인트 |
|---|-----------|-------------|
| 1 | **벨트스크롤 이동** — 좌우 + 앞뒤(깊이) 이동, 점프 | x / y / z 좌표 (5장) |
| 2 | **타격감** — 때리는 맛 | 히트스톱, 넉백, 하얗게 번쩍, 데미지 숫자, 효과음 |
| 3 | **콤보 & 스킬** | 3연타 기본공격 + 쿨타임 스킬 |
| 4 | **방 단위 던전 + 보스** | 방 클리어 → `GO ▶` → 다음 방 → 보스방 |
| 5 | **성장** | 레벨업, 장비, 골드, 스킬 해금 |

### 범위 (처음부터 욕심내지 않기)

| 단계 | 포함 |
|------|------|
| **1차 (MVP)** | 캐릭터 1종 · 몬스터 3종 · 방 3개 + 보스 1 · 점프/기본공격/스킬 2개 · 점수 + 닉네임 랭킹 |
| **2차** | 캐릭터 3종(직업) · 레벨업/장비 · 아이템 드롭 · 마을(상점) · 스테이지 여러 개 |
| **보류/제외** | 실시간 멀티플레이(Apps Script 응답 지연 때문에 사실상 불가), 채팅(아동 안전), 로그인, 결제 |

### ⚠️ 저작권 — "비슷한 장르"는 OK, "그대로 따라 하기"는 NO

던전앤파이터(넥슨/네오플)의 **캐릭터·몬스터·이름·이미지·음악·UI 디자인**은 저작물입니다.
*벨트스크롤 액션*이라는 장르와 조작 방식은 자유롭게 참고해도 되지만, 에셋은 **전부 직접 만들거나 CC0/무료 라이선스 에셋**을 쓰세요. 이름과 세계관도 우리만의 것으로 (예: 사탕 숲, 장난감 공장, 젤리 대왕).

---

## 2. 아이들용 게임 설계 원칙

| 영역 | 원칙 |
|------|------|
| **표현 수위** | 피·잔인한 연출 없음. 몬스터는 귀엽게, 쓰러지면 "펑!" 하고 별/사탕으로 터지며 사라짐 |
| **조작** | 키 5개 이내로 시작 (이동·공격·점프·스킬 2). 태블릿/크롬북을 위해 **터치 버튼**도 지원 |
| **난이도** | 쉬움/보통/어려움 선택. 쉬움은 **게임 오버 없음**(쓰러지면 제자리 부활, 점수만 감소) |
| **공정함** | 적 공격은 **예고 동작(0.5초 이상)** 이 먼저 보이게. "억울하게 죽는" 느낌이 없어야 함 |
| **글자** | 한글 UI, 큰 글씨, 짧은 문장. 설명 없이도 `GO ▶` 같은 화살표로 안내 |
| **플레이 시간** | 던전 1회 5~8분. 30분 넘게 하면 "쉬어요!" 알림 |
| **개인정보** | **닉네임만** 받는다. 실명·학교·사진·이메일 수집 금지 (만 14세 미만은 법정대리인 동의가 필요해서, *수집하지 않는 설계*가 가장 안전) |
| **랭킹** | 닉네임 길이 제한 + 금칙어 필터. 채팅/댓글 기능은 만들지 않음 |

---

## 3. 기술 구조

### 한 장 요약 — "게임은 브라우저에서, 저장만 서버에서"

```
 [아이의 브라우저]                              [Google 서버]
 ┌──────────────────────────┐   google.script.run   ┌─────────────────────────┐
 │ index.html (Canvas 게임)  │ ───────────────────▶ │ Code.gs (Apps Script)    │
 │  · 게임 루프 / 그리기      │ ◀─────────────────── │  · doGet: HTML 제공       │
 │  · 입력 / 충돌 / 전투 AI   │       (JSON)         │  · saveScore/getTopScores │
 │  · 전부 여기서 계산        │                      └───────────┬─────────────┘
 └──────────────────────────┘                                  ▼
                                                    Google 스프레드시트 (Scores 시트)
```

- **전투·이동·충돌은 100% 브라우저(JavaScript)** 에서 계산합니다. 서버를 프레임마다 부르면 안 됩니다.
- **Apps Script는 "시작할 때 불러오기 / 끝날 때 저장하기"** 에만 씁니다.

### Apps Script 웹앱의 특성 (알고 시작하기)

| 항목 | 내용 | 대처 |
|------|------|------|
| 서버 호출 지연 | `google.script.run` 한 번에 수백 ms ~ 수 초 | 게임 시작/종료/스테이지 클리어 때만 호출. 로딩 중 표시 |
| 동시 실행 한도 | 사용자(배포자)당 동시 실행 수 제한(현재 30)이 있음. 할당량은 바뀔 수 있으니 공식 문서 확인 | 저장 실패 시 재시도 + 로컬에 임시 보관 |
| iframe 안에서 실행 | 전체화면 API 등 일부 브라우저 기능 제한 가능 | 처음부터 CSS로 화면을 꽉 채우는 레이아웃 |
| 정적 파일 없음 | 이미지/js 파일을 따로 서빙하지 못함 | 코드는 HTML에 include, 이미지는 base64 또는 외부 호스팅 (9장) |
| 키보드 포커스 | iframe을 클릭해야 키 입력이 들어감 | **시작 버튼**을 눌러야 게임이 시작되게 (포커스 + 오디오 허용 둘 다 해결) |
| Workspace(조직) 계정 | 관리자 정책으로 "모든 사용자" 공개가 막혀 있을 수 있음 | 배포 전에 관리자에게 확인. 막혀 있으면 "조직 내 사용자"로 배포 |

### 구조 선택지

| 방식 | 설명 | 추천 |
|------|------|------|
| **A. 올인원 Apps Script** | 게임 화면(HTML)과 서버 기능을 한 프로젝트에서 배포 | ✅ **처음엔 이것** — 배포 한 번, 링크 하나 |
| B. GitHub Pages + Apps Script API | 게임은 GitHub Pages, 저장/랭킹만 Apps Script를 `fetch`로 호출 | 나중에 — 이 저장소가 GitHub이라 가능. CORS 때문에 `Content-Type: text/plain`으로 POST해야 하는 등 손볼 게 있음 |

> **개발 순서 팁:** 1단계는 *서버 없이 단일 `index.html`* 로 로컬에서 개발 (더블클릭하면 열림, 수정→새로고침으로 즉시 확인).
> 게임이 어느 정도 되면 그때 Apps Script로 옮겨서 저장/랭킹을 붙입니다.

---

## 4. 개발 환경 준비

### 경로 1 — 브라우저만 (입문, 가장 쉬움)

1. [script.google.com](https://script.google.com) → **새 프로젝트**
2. 파일 추가: `Code.gs`(서버), `index.html`(게임). 코드가 길어지면 `style.html`, `game.html`로 쪼갬
3. **배포 → 새 배포 → 웹 앱** (8장 참고)

### 경로 2 — GitHub + clasp (권장, 이 저장소 방식)

```bash
npm i -g @google/clasp
clasp login                     # 브라우저로 Google 로그인
# script.google.com/home/usersettings 에서 "Google Apps Script API" 켜기
mkdir -p src
clasp create --type webapp --title "던전 게임" --rootDir src
clasp push                      # 로컬 src/ → Apps Script 업로드
clasp open                      # 편집기 열기
```

### 폴더 구조

현재 저장소의 실제 구조는 위 **0장 "저장소 지도"** 를 보세요. 핵심만 다시 정리하면:

- `src/` 가 Apps Script 로 올라가는 파일 전부입니다 (`Code.gs` + `index.html` + `*.html` 조각들). `index.html` 이 `<?!= include('js_core') ?>` 처럼 조각을 이어 붙입니다.
- `dist/index.html` 은 `npm run build` 가 같은 이어 붙이기를 로컬에서 흉내 내 만든 **단일 파일**이라, 서버 없이 더블클릭으로 열립니다.
- 처음 시작할 때는 `prototype/index.html` 처럼 **단일 HTML 하나로 로컬에서 개발**하다가, 커지면 이렇게 조각으로 나누면 됩니다.

`src/appsscript.json`:

```json
{
  "timeZone": "Asia/Seoul",
  "runtimeVersion": "V8",
  "exceptionLogging": "STACKDRIVER",
  "webapp": { "executeAs": "USER_DEPLOYING", "access": "ANYONE_ANONYMOUS" }
}
```

- `executeAs: USER_DEPLOYING` — 배포한 사람 권한으로 실행 → 아이들은 스프레드시트에 접근할 수 없고, 로그인도 필요 없음
- `access`: `ANYONE_ANONYMOUS`(누구나) / `ANYONE`(Google 로그인 필요) / `DOMAIN`(조직 내) / `MYSELF`

---

## 5. 벨트스크롤 엔진 핵심 개념

### 5-1. 좌표계: x · y · z

던파식 화면은 **옆에서 본 모습이지만 바닥에 "깊이"가 있습니다.**

```
        ┌────────────────────────────────────┐
        │   벽 (배경)                          │
        │ ─ ─ ─ ─ ─ FLOOR_TOP ─ ─ ─ ─ ─ ─ ─ │  ← 바닥 띠의 위쪽 끝 (먼 곳)
        │      🧍←→ x : 좌우                  │
        │    ↕ y : 깊이 (화면에서는 위아래)    │
        │ ─ ─ ─ ─ FLOOR_BOTTOM ─ ─ ─ ─ ─ ─ ─ │  ← 바닥 띠의 아래쪽 끝 (가까운 곳)
        └────────────────────────────────────┘
        z : 땅에서 떠 있는 높이 (점프) → 그릴 때 화면 y에서 z를 뺀다
```

- 화면에 그리는 위치 = `(x, y - z)`, 그림자는 항상 `(x, y)`
- **y가 작은(먼) 캐릭터부터 그려야** 앞 캐릭터가 위에 덮임 → `y-sort`

### 5-2. 게임 루프 — 고정 타임스텝

`requestAnimationFrame`은 모니터마다 속도가 달라서(60Hz / 144Hz) 그대로 쓰면 게임 속도가 달라집니다.
**항상 1/60초 단위로 `update()`를 돌리고, `draw()`는 한 프레임에 한 번**만 합니다. (6장 코드에 있음)

### 5-3. 입력 — 반드시 `e.code`

- `e.key`는 한글 입력 상태에서 `Z` 대신 `ㅋ`이 들어와서 **키가 안 먹는 것처럼** 보입니다. → `e.code`(`KeyZ`, `ArrowLeft`)는 물리 키라 안전
- 방향키/스페이스는 `preventDefault()`로 **페이지 스크롤을 막아야** 함
- `down`(누르는 중) 과 `pressed`(막 눌린 순간)를 구분 — 점프/공격은 `pressed`, 이동은 `down`

### 5-4. 타격 판정 — "깊이가 비슷해야 맞는다"

공격 판정(히트박스)은 **세 축을 모두** 검사합니다.

```js
const inX      = enemy.x + 20 > x1 && enemy.x - 20 < x2;   // 공격 사각형(x1~x2)과 겹침
const inDepth  = Math.abs(enemy.y - player.y) < 25;       // ← 벨트스크롤의 핵심
const inHeight = Math.abs(enemy.z - player.z) < 60;
if (inX && inDepth && inHeight) hit();
```

또 공격 동작은 **프레임 구간**으로 나눕니다: `준비(0~5) → 타격 판정 ON(6~10) → 후딜(11~19)`.
판정이 켜지는 구간이 짧아야 "휘두르는 느낌"이 나고, 후딜이 있어야 연타가 무한 반복되지 않습니다.

### 5-5. 타격감 체크리스트 ⭐ (던파 느낌의 80%) — 「젤리 던전」에는 8가지 모두 들어 있어요

때렸을 때 **동시에** 이런 일이 일어나야 합니다. 하나씩 켜 보면서 느낌 차이를 아이와 같이 확인해 보세요.

- [x] **히트스톱** — 때린 순간 3~6프레임 멈춤 (6장 코드 `hitstop`)
- [x] **넉백** — 적이 뒤로 밀리며 감속
- [x] **피격 번쩍임** — 적이 5~6프레임 하얗게
- [x] **데미지 숫자** — 위로 떠오르며 사라짐
- [x] **효과음** — 타격 순간 "퍽/뿅"
- [x] **화면 흔들림** — 마지막 타/스킬에만 약하게
- [x] **콤보 카운터** — "3 HIT!"
- [x] **띄우기** — 마지막 타에 적이 공중으로 (z 속도 부여) — 던파의 상징

### 5-6. 적 AI — 상태 머신 + 예고 동작

적은 `if` 덩어리 대신 **상태**로 만듭니다. `windup`(예고)이 아이들 난이도의 열쇠입니다.

```js
// 개념 예시 (실제 구현은 M2에서)
function updateEnemy(e) {
  switch (e.state) {
    case 'idle':    if (dist(e, player) < 300) e.state = 'chase'; break;
    case 'chase':   moveToward(e, player);
                    if (inAttackRange(e)) { e.state = 'windup'; e.t = 30; } break;
    case 'windup':  if (--e.t <= 0) { e.state = 'attack'; e.t = 10; } break;   // ❗ 이때 머리 위에 "!" 표시
    case 'attack':  if (e.t === 10) tryHitPlayer(e);
                    if (--e.t <= 0) { e.state = 'recover'; e.t = 40; } break;
    case 'recover': if (--e.t <= 0) e.state = 'chase'; break;                  // 이때가 반격 찬스
  }
}
```

### 5-7. 데이터 주도 설계

몬스터/스킬/스테이지는 **코드가 아니라 데이터(객체)** 로 적습니다. 아이가 숫자와 이름을 바꿔 보며 새 몬스터를 만들 수 있어서 같이 하기 좋습니다.

```js
const ENEMIES = {
  slime:  { name: '사탕 슬라임', hp: 20, speed: 1.2, attack: 5, windup: 30, color: '#ff8ad8' },
  soldier:{ name: '장난감 병정', hp: 35, speed: 1.6, attack: 8, windup: 36, color: '#7bd88f' },
};
const STAGES = [
  { name: '사탕 숲', rooms: [
      { width: 960,  waves: [{ type: 'slime', count: 3 }] },
      { width: 1920, waves: [{ type: 'slime', count: 3 }, { type: 'soldier', count: 2 }] },
  ]},
];
```

### 5-8. 터치 조작 (태블릿/크롬북)

키보드 입력과 **같은 `down`/`pressed`에 연결**하면 게임 코드는 그대로 둔 채 터치 버튼만 추가됩니다.

```html
<button data-key="KeyZ">공격</button>
<button data-key="KeyX">점프</button>
```
```js
document.querySelectorAll('[data-key]').forEach(btn => {
  const k = btn.dataset.key;
  btn.addEventListener('pointerdown', e => { e.preventDefault(); if (!down[k]) pressed[k] = true; down[k] = true; });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => btn.addEventListener(ev, () => { down[k] = false; }));
});
```
(이동은 화면 왼쪽에 ◀ ▶ ▲ ▼ 버튼 4개를 같은 방식으로 `data-key="ArrowLeft"` 등으로 연결)

---

## 6. Step 1 — 실행되는 프로토타입

> 이 장은 **학습용 150줄 프로토타입**입니다. 진짜 게임(`src/`)은 이 아이디어(깊이 판정·히트스톱·고정 타임스텝)를 그대로 확장한 것이에요.

**이동(좌우+깊이) · 점프 · 공격 판정 · 히트스톱 · 넉백 · 데미지 숫자 · y-sort · 고정 타임스텝** 이 들어 있는 단일 파일입니다.
아래 코드는 이 저장소의 [`prototype/index.html`](prototype/index.html)에 그대로 들어 있으니, **더블클릭으로 열어 보세요.** (조작: **방향키** 이동 / **Z** 공격 / **X** 점프)

<!-- PROTOTYPE:BEGIN -->
```html
<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>미니 벨트스크롤</title>
<style>
  html, body { margin: 0; height: 100%; background: #111; display: grid; place-items: center; }
  canvas { width: min(100vw, 100vh * 16 / 9); aspect-ratio: 16 / 9; }
</style>
</head>
<body>
<canvas id="game" width="960" height="540"></canvas>
<script>
// ===== 1. 기본 설정 =====
const W = 960, H = 540;                       // 게임 내부 해상도 (화면 크기와 상관없이 고정)
const FLOOR_TOP = 330, FLOOR_BOTTOM = 500;    // 캐릭터가 걸어다닐 수 있는 바닥 띠 = '깊이' 범위
const GRAVITY = 0.6;
const ctx = document.getElementById('game').getContext('2d');
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ===== 2. 입력 =====
const down = {}, pressed = {};                // down: 누르는 중 / pressed: 막 눌린 순간
addEventListener('keydown', e => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  if (!down[e.code]) pressed[e.code] = true;
  down[e.code] = true;
});
addEventListener('keyup', e => { down[e.code] = false; });

// ===== 3. 캐릭터 데이터 =====
const player = { x: 200, y: 420, z: 0, vz: 0, face: 1, attackT: 0, hitDone: false };
const enemy  = { x: 600, y: 420, z: 0, vx: 0, hp: 30, maxHp: 30, flash: 0, respawn: 0 };
let hitstop = 0;                              // 타격감: 때린 순간 게임이 잠깐 멈춤
let popups = [];                              // 떠오르는 데미지 숫자

// ===== 4. 매 프레임 계산 (1/60초마다 한 번) =====
function update() {
  if (hitstop > 0) { hitstop--; return; }     // 멈춘 동안 눌린 키는 기억해 둠(입력 버퍼)

  // 이동
  const dx = (down.ArrowRight ? 1 : 0) - (down.ArrowLeft ? 1 : 0);
  const dy = (down.ArrowDown ? 1 : 0) - (down.ArrowUp ? 1 : 0);
  if (player.attackT === 0) {                 // 공격 중에는 못 움직임
    player.x += dx * 4;
    player.y += dy * 3;
    if (dx) player.face = dx;
  }
  player.x = clamp(player.x, 20, W - 20);
  player.y = clamp(player.y, FLOOR_TOP, FLOOR_BOTTOM);

  // 점프 (z = 땅에서 떠 있는 높이)
  if (pressed.KeyX && player.z === 0) player.vz = 11;
  if (player.z > 0 || player.vz > 0) {
    player.z += player.vz;
    player.vz -= GRAVITY;
    if (player.z <= 0) { player.z = 0; player.vz = 0; }
  }

  // 공격: 20프레임짜리 동작 중 6~10프레임에만 타격 판정이 켜짐
  if (pressed.KeyZ && player.attackT === 0) { player.attackT = 20; player.hitDone = false; }
  if (player.attackT > 0) {
    player.attackT--;
    const t = 20 - player.attackT;
    if (t >= 6 && t <= 10 && !player.hitDone) tryHit();
  }

  // 적
  enemy.x = clamp(enemy.x + enemy.vx, 20, W - 20);
  enemy.vx *= 0.85;                           // 넉백이 점점 느려짐
  if (enemy.flash > 0) enemy.flash--;
  if (enemy.hp <= 0 && --enemy.respawn <= 0) { enemy.hp = enemy.maxHp; enemy.x = 600; enemy.vx = 0; }

  // 떠오르는 숫자
  popups.forEach(p => { p.y -= 1; p.t--; });
  popups = popups.filter(p => p.t > 0);

  for (const k in pressed) delete pressed[k]; // '막 눌림'은 한 번만 처리
}

function tryHit() {
  const reach = 80;                           // 공격 사거리
  const x1 = player.face > 0 ? player.x : player.x - reach;
  const x2 = player.face > 0 ? player.x + reach : player.x;
  const inX = enemy.x + 20 > x1 && enemy.x - 20 < x2;
  const inDepth = Math.abs(enemy.y - player.y) < 25;    // 벨트스크롤의 핵심: 깊이(y)가 비슷해야 맞는다
  const inHeight = Math.abs(enemy.z - player.z) < 60;
  if (enemy.hp <= 0 || !(inX && inDepth && inHeight)) return;

  const dmg = 5 + Math.floor(Math.random() * 4);
  enemy.hp = Math.max(0, enemy.hp - dmg);
  enemy.flash = 6;                            // 하얗게 번쩍
  enemy.vx = player.face * 7;                 // 넉백
  if (enemy.hp === 0) enemy.respawn = 90;
  hitstop = 4;                                // 히트스톱
  popups.push({ x: enemy.x, y: enemy.y - 100, t: 40, text: dmg });
  player.hitDone = true;                      // 한 번 휘두르면 한 번만 맞게
}

// ===== 5. 그리기 =====
function drawActor(a, color) {
  const shadowScale = 1 - Math.min(a.z, 100) / 200;     // 높이 뜰수록 그림자가 작아짐
  ctx.fillStyle = 'rgba(0,0,0,.35)';
  ctx.beginPath(); ctx.ellipse(a.x, a.y, 26 * shadowScale, 8 * shadowScale, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = a.flash > 0 ? '#fff' : color;
  ctx.fillRect(a.x - 20, a.y - a.z - 80, 40, 80);       // 몸통 (나중에 스프라이트 이미지로 교체)
}

function draw() {
  ctx.fillStyle = '#2b2d42'; ctx.fillRect(0, 0, W, FLOOR_TOP - 40);   // 벽
  ctx.fillStyle = '#5c4b3a'; ctx.fillRect(0, FLOOR_TOP - 40, W, H);   // 바닥

  // y가 작은(화면 위쪽 = 먼) 캐릭터부터 그려야 앞 캐릭터가 위에 덮인다 (y-sort)
  const actors = [{ a: player, c: '#4aa3ff' }];
  if (enemy.hp > 0) actors.push({ a: enemy, c: '#ff6b6b' });
  actors.sort((p, q) => p.a.y - q.a.y).forEach(o => drawActor(o.a, o.c));

  // 칼 휘두르는 이펙트
  const t = 20 - player.attackT;
  if (player.attackT > 0 && t >= 4 && t <= 12) {
    ctx.fillStyle = 'rgba(255,255,255,.85)';
    ctx.fillRect(player.face > 0 ? player.x + 20 : player.x - 100, player.y - player.z - 60, 80, 10);
  }
  // 적 HP바
  if (enemy.hp > 0) {
    ctx.fillStyle = '#400'; ctx.fillRect(enemy.x - 25, enemy.y - 110, 50, 6);
    ctx.fillStyle = '#f44'; ctx.fillRect(enemy.x - 25, enemy.y - 110, 50 * enemy.hp / enemy.maxHp, 6);
  }
  // 데미지 숫자 + 안내 문구
  ctx.font = 'bold 26px sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#ffd93d';
  popups.forEach(p => ctx.fillText(p.text, p.x, p.y));
  ctx.font = '18px sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = '#fff';
  ctx.fillText('방향키: 이동   Z: 공격   X: 점프', 16, 28);
}

// ===== 6. 게임 루프: 어떤 모니터에서도 같은 속도로 =====
const STEP = 1000 / 60;
let last = performance.now(), acc = 0;
function frame(now) {
  acc += Math.min(now - last, 100);           // 탭을 오래 떠났다 와도 폭주하지 않게 제한
  last = now;
  while (acc >= STEP) { update(); acc -= STEP; }
  draw();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
</script>
</body>
</html>
```
<!-- PROTOTYPE:END -->

### 실험해 보기 (아이와 함께)

숫자 하나만 바꿔서 **바로 새로고침**하고 차이를 느껴 보세요.

| 바꿀 곳 | 바꾸면 |
|---------|--------|
| `player.vz = 11` | 점프 높이 |
| `hitstop = 4` → `0` / `10` | 타격감이 사라짐 / 묵직해짐 (제일 중요한 실험!) |
| `enemy.vx = player.face * 7` | 넉백 거리 |
| `t >= 6 && t <= 10` | 공격이 맞는 타이밍 |
| `Math.abs(enemy.y - player.y) < 25` | 깊이 판정 범위 — 줄이면 앞뒤를 맞춰야 맞음 |

---

## 7. 콘텐츠 설계 (캐릭터·몬스터·스테이지)

### 조작키

| 키 | PC | 터치 |
|----|----|------|
| 이동 | 방향키 | 왼쪽 ◀▶▲▼ |
| 기본공격 (3연타 콤보) | `Z` | 오른쪽 `공격` |
| 점프 | `X` | 오른쪽 `점프` |
| 스킬 1 / 2 / 3 | `A` / `S` / `D` | 오른쪽 스킬 버튼 |

### 직업 (처음엔 1종, 2차에서 확장)

| 직업 | 컨셉 | 특징 |
|------|------|------|
| 용사 | 칼 | 균형형, 입문용 |
| 권법가 | 주먹/발차기 | 빠르고 콤보가 길다, 사거리 짧음 |
| 마법사 | 지팡이 | 원거리, 체력 낮음 |

### 스킬 예시 (쿨타임 방식 — MP보다 아이들에게 쉬움)

| 키 | 스킬 | 효과 | 쿨타임 |
|----|------|------|-------|
| Z | 기본 3연타 | 배율 1.0 / 1.0 / 1.5 (마지막 타는 띄우기) | 없음 |
| A | 회오리 베기 | 주변 전체, 배율 2.0 | 5초 |
| S | 돌진 찌르기 | 앞으로 돌진하며 관통, 배율 2.5 | 8초 |
| D | 궁극기 | 화면 전체, 배율 5.0 | 30초 |

### 몬스터 예시 — 몬스터마다 "하나씩 가르치는 것"이 있게

| 몬스터 | 행동 | HP | 공격력 | 가르치는 것 |
|--------|------|----|--------|-------------|
| 사탕 슬라임 | 느리게 다가와 박치기 | 30 | 7 | 기본 공격 |
| 장난감 병정 | 가까이 오면 창 찌르기 (예고 0.6초) | 54 | 11 | 거리 두기, 예고 보고 피하기 |
| 심술 구름 | 공중에서 번개 (바닥에 그림자 먼저 표시) | 38 | 10 | 이동으로 피하기 |
| 🎪 **젤리 대왕 (보스)** | ① 점프 찍기 ② 슬라임 소환 ③ 돌진 (체력 절반 이하에서 더 빨라짐) | 760 | 12~18 | 패턴 읽기 + 스킬 사용 |

> 위 숫자는 **실제 게임의 값**(`ENEMY_DEFS`)입니다. 처음 설계의 20/35/25/300 은 봇으로 재 보니 너무 쉬워서(1~2분 만에 클리어) 올렸어요. 모든 공격은 **예고 동작이 0.4초 이상** 먼저 보이고, 바닥 마커는 0.75초 이상 보입니다.

### 던전 흐름

```
방1 숲 입구 → 방2 달콤한 오솔길 → 방3 초콜릿 시냇가 → 방4 솜사탕 언덕 → 방5 젤리 동굴 입구 → 방6 반짝 수정 동굴 → 보스방 젤리 대왕 → 결과 화면(점수·별 1~3개·랭킹 등록)
```

- 방 = `width`(960의 배수) + `waves`. 적을 전부 쓰러뜨리면 화면 오른쪽에 **`GO ▶`** 깜빡임, 오른쪽 끝으로 가면 다음 방
- 카메라는 플레이어를 따라 가로로만 스크롤 (방 `width` 범위 안에서 clamp)
- 방 하나 30~60초, 던전 전체 4~7분 (몬스터 92마리 + 보스)

### 밸런스 기본 공식 (처음엔 단순하게)

```
피해량   = 공격력 × 스킬배율 × (0.9 ~ 1.1 랜덤)
필요 경험치(레벨 L) = 50 × L^1.5   (L=1→50, 2→141, 3→260, 5→559)
몬스터 HP = 기본 HP × (1 + 0.15 × (스테이지-1))
```

- **플레이어 HP 100, 기본 공격력 5~8** 에서 시작
- 쉬움 모드: 받는 피해 ×0.5, 쓰러지면 제자리 부활(점수 -10%)
- 봇으로 측정한 기준: 보통 난이도에서 한 판에 **약 8~20번** 맞고, 몬스터 하나에 기본 공격 **3~6번**. **진짜 아이들이 해 본 뒤** 이 숫자를 다시 맞추세요.

---

## 8. Apps Script 서버 기능 (저장·랭킹·배포)

### 8-1. `Code.gs`

> 아래는 **개념을 설명하는 짧은 예시**입니다. 실제 구현은 [`src/Code.gs`](src/Code.gs) 이고, 닉네임 정규화·금칙어, 점수 개연성 검증, 락/캐시, 시트 자동 준비까지 들어 있어요. 올리는 방법은 [`docs/DEPLOY.md`](docs/DEPLOY.md).

```js
// 1) 웹앱 진입점: 접속하면 index.html을 보여줌
function doGet() {
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle('던전 게임')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// 2) index.html 안에서 <?!= include('game') ?> 로 다른 html 파일을 끼워 넣기
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

// 3) 설정: 스프레드시트 ID는 코드에 쓰지 않고 '스크립트 속성'에 저장
//    (프로젝트 설정 ⚙ → 스크립트 속성 → SHEET_ID 추가)
function getSheet_(name) {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  return SpreadsheetApp.openById(id).getSheetByName(name);   // 끝에 _ 붙은 함수는 외부에서 호출 불가
}

const BAD_WORDS = ['욕설1', '욕설2'];                          // 금칙어 목록 (직접 채우기)

function cleanNickname_(raw) {
  let s = String(raw || '').trim().slice(0, 8);
  s = s.replace(/^[=+\-@]+/, '');                             // 시트 수식 주입 방지 (=로 시작하면 수식으로 해석됨!)
  if (!s) throw new Error('닉네임을 입력해 주세요');
  if (BAD_WORDS.some(w => s.includes(w))) throw new Error('쓸 수 없는 닉네임이에요');
  return s;
}

// 4) 점수 저장: 게임이 끝날 때 한 번만 호출
function saveScore(nickname, score, stage) {
  const nick = cleanNickname_(nickname);
  const safeScore = Math.max(0, Math.min(Number(score) || 0, 9999999));  // 말도 안 되는 값 차단
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);                                        // 동시에 여러 명이 저장해도 안 섞이게
  try {
    getSheet_('Scores').appendRow([new Date(), nick, safeScore, Number(stage) || 1]);
  } finally {
    lock.releaseLock();
  }
  return { ok: true };
}

// 5) 랭킹 조회: 결과 화면에서 호출. ⚠ Date 객체는 클라이언트로 못 넘기므로 필요한 값만 골라서 반환
function getTopScores(n) {
  const rows = getSheet_('Scores').getDataRange().getValues().slice(1);   // 첫 줄은 헤더
  return rows
    .map(r => ({ nickname: r[1], score: r[2], stage: r[3] }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(Number(n) || 10, 50));
}
```

스프레드시트 `Scores` 시트 첫 줄(헤더): `시간 | 닉네임 | 점수 | 스테이지`

### 8-2. 클라이언트에서 부르기 (`game.html` 안)

```js
// google.script.run 을 Promise로 감싸기 (+ 로컬 테스트 땐 가짜로 대체)
const hasServer = typeof google !== 'undefined' && google.script && google.script.run;
const call = (fn, ...args) => hasServer
  ? new Promise((ok, ng) => google.script.run.withSuccessHandler(ok).withFailureHandler(ng)[fn](...args))
  : Promise.resolve(fn === 'getTopScores' ? [{ nickname: '테스트', score: 1234, stage: 1 }] : { ok: true });

// 게임 종료 시
call('saveScore', nickname, score, stage)
  .then(() => call('getTopScores', 10))
  .then(showRanking)
  .catch(err => showToast('저장에 실패했어요. 다시 시도해 볼까요?'));
```

> 로컬(`prototype/index.html`)에서는 `google`이 없으므로 가짜 응답이 돌아가서, 서버 없이도 같은 코드를 테스트할 수 있습니다.

### 8-3. 배포 절차 (브라우저)

1. **배포 → 새 배포** → 유형 **웹 앱**
2. 설명 입력 / **실행 사용자: 나** / **액세스 권한: 모든 사용자** (조직 정책으로 안 보이면 "조직 내 사용자")
3. **배포** → 처음 한 번 **권한 승인** (배포자 본인만 하면 됨) → 웹 앱 URL(`…/exec`) 복사
4. 이 URL을 QR코드로 만들어 아이들에게 공유

**코드를 고친 뒤 반영하기**

| 방법 | 설명 |
|------|------|
| 테스트 URL (`…/dev`) | 저장만 하면 최신 코드 반영. 배포자 본인만 접속 가능 → 개발 중 확인용 |
| 정식 URL (`…/exec`) | **배포 → 배포 관리 → ✏ → 버전: 새 버전 → 배포**. 이걸 안 하면 아이들 화면은 예전 그대로! |
| clasp | `clasp push` 후 `clasp deploy -i <배포ID>` (`-i` 없이 쓰면 새 URL이 생김) |

---

## 9. 아트 & 사운드

### 처음엔 그림 없이

1단계~M3까지는 **색 사각형 + 그림자**로 충분합니다. 재미가 확인된 뒤에 그림을 입히는 게 훨씬 빠릅니다. (아이가 직접 그린 그림을 쓰는 건 마지막 마일스톤에서)

### 스프라이트 규격

| 항목 | 권장 |
|------|------|
| 프레임 크기 | 캐릭터 64×64 또는 96×96 (픽셀아트), 보스는 192×192 |
| 시트 | 가로로 프레임을 나열한 PNG 1장 / 동작별로 1줄 |
| 최소 애니 | `idle`(4) · `walk`(6) · `attack`(6) · `hit`(2) · `jump`(3) |
| 그리기 | `ctx.imageSmoothingEnabled = false` — 안 끄면 픽셀아트가 흐려짐 |
| 도구 | [Piskel](https://www.piskelapp.com/)(웹, 무료), LibreSprite, Aseprite(유료) |

### Apps Script에서 이미지 쓰는 법

- Apps Script는 **정적 파일을 서빙하지 않습니다.**
- ✅ 작은 이미지는 **base64 data URI**로 `html` 파일에 넣기 (이미지 합쳐 수 MB 이내 권장)
- ✅ 또는 GitHub Pages 등 **외부 호스팅 URL** 사용
- ⚠ Google Drive 공유 링크를 `<img>`에 바로 쓰는 방식은 막히거나 불안정할 수 있어 권장하지 않음

### 사운드

- **효과음**: [jsfxr / sfxr.me](https://sfxr.me/) 로 브라우저에서 만들어 저장 (타격음·점프음·코인음)
- **무료 에셋**: [Kenney.nl](https://kenney.nl/assets) (CC0), OpenGameArt (**에셋마다 라이선스가 다르니 하나씩 확인**)
- 브라우저 정책상 **사용자가 클릭한 뒤에야** 소리가 납니다 → "시작" 버튼에서 `AudioContext.resume()` 호출

---

## 10. 로드맵 (마일스톤 체크리스트)

각 마일스톤은 **"아이가 직접 해보고 '재밌다'고 말하는 것"** 을 완료 기준으로 합니다.

### M0. 준비
- [x] GitHub 저장소 + `GUIDE.md`
- [ ] Google 계정/스프레드시트 준비, 배포 권한(조직 정책) 확인
- [ ] 게임 이름·세계관·주인공 정하기 (아이와 함께) — 지금은 임시 이름 「젤리 던전」

### M1. 움직이는 캐릭터
- [x] 6장 프로토타입 실행, 방향키/점프 동작
- [x] 숫자를 바꿔서 속도/점프가 달라지는 것 확인

### M2. 때리고 맞기
- [x] 적 1종이 플레이어를 쫓아와 공격 (상태 머신 + 예고 동작)
- [x] 플레이어 HP, 쓰러지면 부활
- [x] 5-5 타격감 체크리스트 중 5개 이상 적용

### M3. 방 하나 완성
- [x] 웨이브(적 3마리) → 전멸 시 `GO ▶`
- [x] 방 `width` 확장 + 카메라 스크롤
- [x] 기본 공격 3연타 콤보 + 스킬 1개(쿨타임 표시)

### M4. 던전 완성
- [x] 방 3개 + 보스 1 (패턴 3개)
- [x] 결과 화면(점수·별), 난이도 선택(쉬움/보통/어려움)
- [x] 터치 버튼으로 태블릿에서도 플레이 가능

### M5. Apps Script 이전 + 랭킹
- [ ] `clasp push`(또는 브라우저 편집기) 후 `/dev` URL에서 실행 — `docs/DEPLOY.md` 참고
- [x] 닉네임 입력 → 점수 저장 → 랭킹 표시
- [ ] 정식 배포(`/exec`) 후 다른 기기(태블릿/크롬북)에서 확인

### M6. 그림·소리 입히기
- [x] 스프라이트 교체 (사각형 → 캐릭터) — 이미지 파일 대신 Canvas 도형으로 그린 캐릭터
- [x] 효과음 + BGM, 음소거 버튼
- [ ] 아이가 만든 캐릭터/몬스터 추가

### M7. 확장 (2차)
- [ ] 직업 선택, 레벨업/장비, 아이템 드롭 (아이템 드롭(사탕·코인)만 구현됨)
- [ ] 스테이지 2~3 추가, 마을(상점)
- [ ] 진행 상황 저장(닉네임 기준 Players 시트)

> **매 마일스톤마다**: ① 친구/가족 1~2명에게 플레이 시키고 막히는 곳 관찰 ② 커밋 ③ 정식 URL 갱신

---

## 11. 자주 겪는 문제

| 증상 | 원인 → 해결 |
|------|-------------|
| 방향키를 누르면 **페이지가 스크롤**됨 | `keydown`에서 `e.preventDefault()` (6장 코드 참고) |
| 키가 **전혀 안 먹음** | iframe에 포커스가 없음 → "시작" 버튼을 눌러야 시작되게. 한글 입력 상태라면 `e.key` 대신 `e.code` 사용 |
| **소리가 안 남** | 브라우저는 클릭 전 자동재생을 막음 → 시작 버튼에서 오디오 초기화 |
| 코드를 고쳤는데 **그대로임** | 정식 URL은 "새 버전 배포"를 해야 반영 (8-3). 개발 중엔 `/dev` URL 사용 |
| 모니터가 빠른 PC에서 **게임이 너무 빠름** | `update()`를 프레임마다 부르지 말고 고정 타임스텝 사용 (5-2) |
| 그림이 **흐릿함** | 캔버스 내부 해상도는 고정(960×540), 화면 맞춤은 CSS로. `imageSmoothingEnabled = false` |
| `google.script.run` 호출 시 **알 수 없는 오류** | `Date`·함수 같은 값은 못 넘김 → 숫자/문자열/객체/배열만. 서버 함수 이름 오타 확인 |
| 저장 도중 **가끔 실패** | 동시 실행 한도/지연 → 자동 재시도 1~2회 + 실패 시 "다시 시도" 버튼 |
| 랭킹에 닉네임이 **`=`로 시작**해서 이상한 값이 나옴 | 시트 수식 주입 → 8-1의 `cleanNickname_` 처럼 앞의 `= + - @` 제거 |
| 아이들 접속 시 **로그인/권한 화면**이 뜸 | 배포 설정의 액세스 권한이 "모든 사용자"인지, 조직 정책이 막고 있지 않은지 확인 |

---

## 12. 결정이 필요한 것들

다음 단계로 넘어가기 전에 정하면 좋은 것들입니다. (기본값을 적어 두었으니, 그대로 가도 됩니다)

| # | 질문 | 기본값 |
|---|------|--------|
| 1 | 주 대상 **연령대**는? | 초등 저~고학년 |
| 2 | 주로 쓰는 **기기**는? (PC 키보드 / 태블릿 / 크롬북) | PC + 태블릿 터치 둘 다 |
| 3 | **혼자 플레이** vs **친구와 같이**? | 1차는 혼자. 같이 하기는 *한 키보드 2P*나 점수 경쟁(랭킹)으로 |
| 4 | **그림 스타일**? | 현재: 귀여운 젤리 스타일을 Canvas 도형으로 그림(이미지 파일 없음). 직접 그린 픽셀아트로 바꾸려면 9장 참고 |
| 5 | 아이들이 **계정/닉네임**을 어떻게 쓰나? | 닉네임만, 로그인 없음 |
| 6 | **사용 환경**: 개인 Google 계정 vs 기관(Workspace) 계정? | 배포 권한 확인 필요 |
| 7 | 게임 **이름/세계관**? | 임시 「젤리 던전」 — 아이와 함께 정해서 `CFG.title` 과 타이틀 문구를 바꾸기 |

---

### 다음 단계 제안

1. **직접 해 보기** — `dist/index.html` 을 열어 세 난이도를 모두 플레이해 보세요. (숫자를 바꿔 보는 실험은 6장 표 참고)
2. **Apps Script 에 올리기** — `docs/DEPLOY.md` 를 따라 해서 랭킹까지 확인 (태블릿/크롬북에서도).
3. **아이들 플레이 테스트** — 막히는 곳·지루한 곳·너무 쉬운/어려운 곳을 관찰하고, 데이터 표의 숫자를 조정.
4. **아이와 함께 꾸미기** — 이름·세계관·몬스터 이름을 정하고(M0), 아이가 그린 그림을 넣어 보기(M6).
5. **확장** — 직업 선택, 레벨업/장비, 스테이지 2~3 (`STAGES` 배열에 데이터를 추가하면 방·웨이브가 늘어납니다).
