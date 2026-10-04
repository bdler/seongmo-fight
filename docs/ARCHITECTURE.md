# ARCHITECTURE — 젤리 던전 (어린이용 벨트스크롤 액션)

> 이 문서는 **모듈 간 계약서**입니다. 여러 모듈을 따로 개발해도 합쳐졌을 때 맞물리도록, 공개 API·데이터 모양·이벤트 이름을 여기서 고정합니다.
> 구현 중 계약을 바꿔야 하면 코드만 바꾸지 말고 **소유자에게 변경 요청**(7장)을 남기세요.

## 0. 기본 원칙

- **모듈 시스템 없음.** 각 `src/js_*.html` 은 `<script>` 하나이고, 최상위 `const` 로 전역 이름을 정의합니다. (Apps Script `HtmlService` 와 로컬 빌드 양쪽에서 똑같이 동작)
- **로드 순서:** `js_core → js_player → js_enemies → js_stage → js_ui → js_server → js_main`
- **로드 시점(최상위 코드)에서는 자기 파일과 `js_core` 의 이름만 참조.** 다른 모듈은 함수 *안에서*(런타임에) 참조합니다.
- 모듈 간 소통 = ① 아래 공개 API 호출 ② `Events` 이벤트. 다른 모듈의 내부 상태를 직접 고치지 않습니다.
- **논리 해상도 960×540**, **60fps 고정 타임스텝**. 모든 시간 단위는 *프레임*(1/60초).
- 난수는 `rand() / randInt() / pick() / chance()` 만 사용 (시드 가능 → 테스트 재현). **`Math.random` 금지.**
- 화면 텍스트는 한국어, 코드 주석도 한국어(기존 `prototype/` 과 같은 톤). 이모지는 UI 라벨에만.
- **이미지/오디오 파일 없음.** 모든 그림은 Canvas 도형으로, 모든 소리는 WebAudio 합성으로 만듭니다.
- Apps Script 제약(11장)을 항상 지킵니다.

## 1. 파일 소유권

| 파일 | 소유 모듈 |
|------|-----------|
| `src/js_core.html`, `src/js_main.html`, `tools/test-all.mjs`, `tools/tests/core.test.mjs` | **core** |
| `src/js_player.html`, `tools/tests/player.test.mjs` | **player** |
| `src/js_enemies.html`, `tools/tests/enemies.test.mjs` | **enemies** |
| `src/js_stage.html`, `tools/tests/stage.test.mjs` | **stage** |
| `src/js_ui.html`, `src/style.html`, `tools/tests/ui.test.mjs` | **ui** |
| `src/js_server.html`, `src/Code.gs`, `src/appsscript.json`, `tools/tests/server.test.mjs`, `tools/tests/code-gs.test.mjs` | **server** |
| `src/index.html`, `tools/build-local.mjs`, `tools/lib/*`, `package.json` | 공용(수정 시 이유를 보고) |
| `docs/ARCHITECTURE.md`, `GUIDE.md`, `prototype/*` | 읽기 전용 |

**자기 소유가 아닌 파일은 수정하지 않습니다.** 필요하면 7장 형식으로 요청하세요.

## 2. 좌표·엔티티 모델

```
x : 좌우 (월드 좌표, 0 ~ Game.world.width)
y : 깊이 = 화면의 세로 위치 (FLOOR_TOP=330 ~ FLOOR_BOTTOM=500). 클수록 화면 아래(가까움)
z : 땅에서 떠 있는 높이 (0 = 바닥). 화면에는 (x, y - z) 에 그린다. 그림자는 항상 (x, y)
```

상수(전역, core): `W=960, H=540, FLOOR_TOP=330, FLOOR_BOTTOM=500, GRAVITY=0.6`

### 엔티티 기본 필드 (`Entities.make(props)` 가 채워 줌)

| 필드 | 기본값 | 의미 |
|------|--------|------|
| `id` | 자동 | 고유 번호 |
| `kind` | `''` | `'player' \| 'enemy' \| 'boss' \| 'pickup' \| 'marker' \| 'proj'` |
| `team` | `'neutral'` | `'player' \| 'enemy' \| 'neutral'` (피격 판정 대상 구분) |
| `x, y, z` | 0, 420, 0 | 위치 |
| `vx, vy` | 0 | **한 프레임짜리 이동 의도** — 커널이 적분한 뒤 0으로 되돌림 (매 프레임 모듈이 설정) |
| `vz` | 0 | 수직 속도(점프/띄우기). 커널이 중력 적용 |
| `kx` | 0 | 넉백 속도. 커널이 매 프레임 ×0.85 감쇠 |
| `w, h` | 40, 80 | 몸 너비/높이 (피격 판정용) |
| `face` | 1 | 바라보는 방향 (1 오른쪽, -1 왼쪽) |
| `hp, maxHp` | 1 | 체력 |
| `dead` | false | 죽음. 죽은 엔티티는 `update` 안 부르고 피격 불가, `draw` 는 계속 호출 |
| `removeT` | 0 | 죽은 뒤 (바닥에 닿은 상태에서) 이 값이 0이 되면 제거 — 죽음 연출 시간 |
| `stun` | 0 | 경직 프레임. >0 이면 `update` 호출 안 됨. **공중에 있는 동안은 줄지 않음** |
| `flash` | 0 | >0 이면 하얗게 번쩍(draw 에서 처리). 커널이 매 프레임 -1 |
| `invuln` | 0 | >0 이면 피격 무시. 커널이 매 프레임 -1 |
| `superArmor` | false | true 면 경직/넉백/띄우기 무시 (보스 패턴 중) |
| `heavy` | false | true 면 띄우기만 무시 |
| `noGravity` | false | true 면 중력 미적용 (구름처럼 떠다니는 적: 모듈이 `z` 직접 제어) |
| `untargetable` | false | true 면 피격 판정에서 제외 (등장 연출 중 등) |
| `persistent` | false | true 면 죽어도 커널이 제거하지 않음 (플레이어) |
| `clampWorld` | true | true 면 x 를 `[w/2, world.width-w/2]`, y 를 바닥 띠로 고정 |
| `shadow` | true | false 면 그림자 안 그림 |
| `layer` | `undefined` | `'ground'` 면 그림자 다음, 캐릭터보다 먼저 그림 (바닥 마커) |
| `tick(e)` | null | **항상** 매 프레임 호출 (스턴/죽음 중에도) — 쿨타임 같은 타이머용 |
| `update(e)` | null | 살아 있고 `stun<=0` 일 때만 호출 — AI/조작 |
| `draw(ctx, e)` | null | 월드 좌표계에서 그림. `(e.x, e.y - e.z)` 기준 |
| `onHit(e, hb, dmg)` | null | 피격 직후 호출 |
| `onDeath(e, hb)` | null | hp 0 이 된 직후 1회 호출 (여기서 `removeT`, `vz` 등 연출 세팅) |
| `onLand(e)` | null | 공중에서 바닥에 닿은 순간 |

## 3. core 공개 API (`src/js_core.html`)

### 3-1. 유틸

```js
clamp(v, lo, hi)  lerp(a, b, t)  dist(a, b)         // dist: x,y 평면 거리
RNG.seed(n)  rand()  randInt(a, b)  pick(arr)  chance(p)    // randInt 는 양끝 포함
Store.get(key, fallback)  Store.set(key, value)     // localStorage 래퍼, 'jd:' 접두어, 전부 try/catch (실패 시 메모리 폴백)
COLORS = { pink:'#ff8ad8', mint:'#7bd88f', yellow:'#ffd93d', sky:'#7ad7f0', purple:'#8b5cf6',
           red:'#ff6b6b', cream:'#fff4e0', ink:'#2b1b3a', night:'#2b2d42', white:'#fff' }
CFG.font   // canvas/CSS 공용 폰트 스택 ('Jua' 우선, 한글 시스템 폰트 폴백)
```

### 3-2. `CFG`

```js
const CFG = {
  title: '젤리 던전',
  playerInvuln: 45,          // 플레이어가 맞은 뒤 무적 프레임
  comboWindow: 90,           // 콤보 유지 프레임
  breakReminderMinutes: 30,  // 휴식 알림
  difficulty: {
    easy:   { label:'쉬움',   desc:'게임 오버가 없어요!',  dmgTaken:0.5, enemyHp:0.8, enemySpeed:0.9, windupMul:1.3, lives:Infinity, revivePenalty:0.1, maxAttackers:1 },
    normal: { label:'보통',   desc:'목숨 3개',            dmgTaken:1.0, enemyHp:1.0, enemySpeed:1.0, windupMul:1.0, lives:3,        revivePenalty:0,   maxAttackers:2 },
    hard:   { label:'어려움', desc:'목숨 1개, 도전!',      dmgTaken:1.5, enemyHp:1.3, enemySpeed:1.1, windupMul:0.8, lives:1,        revivePenalty:0,   maxAttackers:3 },
  },
};
```

### 3-3. `Game` (전역 상태, 단일 객체)

```js
const Game = {
  scene: 'boot',              // 'boot' | 'title' | 'play' | 'result'
  paused: false,
  difficulty: 'normal',       // 'easy' | 'normal' | 'hard'
  nickname: '',
  touch: false,               // 터치 기기 여부 (core 가 감지, 첫 touchstart 때 true 로 갱신)
  frame: 0,                   // play 씬에서 실제로 진행된 update 수 (일시정지/히트스톱 제외)
  score: 0, kills: 0, deaths: 0, lives: 3,   // lives: Infinity 가능
  combo: { count: 0, timer: 0, max: 0 },
  player: null,               // 플레이어 엔티티
  boss: null,                 // 보스 엔티티 (없으면 null) — HUD 가 보스 체력바를 그림
  world: { width: 960 },      // 현재 방 너비
  stage: { id: '', name: '', roomIndex: 0, roomCount: 0, roomName: '' },   // HUD 표시용 (stage 가 갱신)
  result: null,               // 런이 끝나면 stage 가 채움 (6-4 참고)
  get diff() { return CFG.difficulty[this.difficulty]; },
  setScene(name),             // 이전 씬 exit() → 전환 → 새 씬 enter() → Input.clear() → Events 'sceneChanged'
  pause(on),                  // Game.paused 설정 + Input.clear() + Events 'paused'
  resetRun({difficulty, nickname}),  // score/kills/deaths/lives/combo/boss/result 초기화 (Entities/FX 는 건드리지 않음)
  addScore(n),                // score += round(n)
};
```

### 3-4. `Events`

```js
Events.on(name, fn)  Events.off(name, fn)  Events.emit(name, data)   // 핸들러 예외는 잡아서 console.error — 루프를 죽이지 않음
```
**리스너는 파일 로드 시점에 한 번만 등록**하세요 (`Stage.start()` 때마다 등록하면 중복됨). 이벤트 목록은 8장.

### 3-5. `Input`

```js
Input.down        // { [KeyboardEvent.code]: true }   누르는 중
Input.pressed     // { [code]: true }                 이번 update 에서 막 눌림 (update 끝나면 비워짐)
Input.isDown(code)   Input.wasPressed(code)
Input.press(code)  Input.release(code)    // 프로그램/터치/테스트용 — keydown/keyup 과 동일 의미
Input.endFrame()   // pressed 비움 (Loop 가 호출 — 모듈은 호출 금지)
Input.clear()      // 전부 해제 (씬 전환, 창 포커스 잃음 시)
Input.bindButton(el, code)   // 터치/마우스 버튼 연결 (pointer events + setPointerCapture, touch-action:none)
```

**키 배치 (`e.code` 기준 — 한글 입력 상태에서도 동작):**

| 동작 | 코드 |
|------|------|
| 이동 | `ArrowLeft/Right/Up/Down` |
| 공격 | `KeyZ` (`Space` 는 `KeyZ` 로 별칭 처리) |
| 점프 | `KeyX` |
| 스킬 1/2/3 | `KeyA` / `KeyS` / `KeyD` |
| 일시정지 | `Escape`, `KeyP` |
| 음소거 | `KeyM` |

- 방향키/Space 는 `preventDefault()` (페이지 스크롤 방지). **그 외 키는 막지 않음.**
- **`INPUT/TEXTAREA/SELECT` 에 포커스가 있을 때의 키 이벤트는 무시** (닉네임 입력이 게임 키로 새면 안 됨).
- 창 `blur` / 탭 숨김 → `Input.clear()` + `Events.emit('windowBlur')` (UI 가 자동 일시정지 처리).

### 3-6. `SFX`, `Music` (WebAudio 합성, 파일 없음)

```js
SFX.init()               // 사용자 클릭/키 입력 안에서 호출. AudioContext 생성/resume. 여러 번 호출해도 안전. 미지원이면 조용히 no-op
SFX.play(name, opts?)    // 알 수 없는 이름/미초기화/음소거면 아무 일도 안 함 (절대 throw 금지)
SFX.muted  SFX.setMuted(bool)   // 값은 Store 에 저장
Music.play('title' | 'stage' | 'boss' | null)   // 코드로 만든 짧은 칩튠 반복, 볼륨 낮게, 음소거 연동. null 이면 정지
```
SFX 이름: `swing hit hitBig jump land skill1 skill2 ultimate hurt enemyDie bossHit bossDie coin heal ui go clear gameover warn star`

### 3-7. `FX` (연출)

```js
FX.freeze(n)                   // 히트스톱: 남은 프레임을 max(현재, n) 로. 읽기: FX.hitstop
FX.shake(mag, frames)          // 화면 흔들림 (더 큰 값이 우선)
FX.popup(x, y, text, {color, size, life, vy})   // 월드 좌표(x, 화면 y). 위로 떠오르며 사라짐. 동시에 최대 40개
FX.burst(x, y, {kind, count, colors, speed, life, gravity, size})   // 입자. kind: 'spark'|'star'|'candy'|'puff'|'ring'. 전체 최대 300개
FX.flash(color, frames)        // 화면 전체 번쩍
FX.update()                    // play 씬이 매 프레임 1회 호출 (히트스톱 중엔 호출되지 않음 → 같이 멈춤)
FX.drawWorld(ctx)              // 카메라 변환 안에서 입자/팝업 그림
FX.drawScreen(ctx)             // 카메라 변환 밖에서 번쩍임 그림
FX.clear()
```

### 3-8. `Entities`

```js
Entities.make(props) → 엔티티 (기본값 채움)     Entities.add(e)  Entities.remove(e)  Entities.clear()
Entities.list                 // 살아있는 배열 (순회 중 add/remove 해도 안전하게 구현)
Entities.byTeam(team)         // 죽지 않은 해당 팀 엔티티 배열
Entities.updateAll()          // 매 프레임: tick → (죽음 처리) → update(스턴 아닐 때) → 물리 적분
Entities.drawAll(ctx)         // 그림자 전부 → layer:'ground' → 나머지를 y(그다음 id) 순서로 draw
```

`updateAll` 의 물리(커널이 담당, 모듈은 중복 구현 금지):

```
이동:   x += vx + kx;  y += vy;  z += vz;      그 뒤 vx = vy = 0,  kx *= 0.85 (|kx|<0.05 → 0)
중력:   (z > 0 || vz > 0) && !noGravity  →  vz -= GRAVITY;   z <= 0 && vz <= 0 이면 z=0, vz=0, onLand(e)
경계:   clampWorld 면 x ∈ [w/2, Game.world.width - w/2],  y ∈ [FLOOR_TOP, FLOOR_BOTTOM]
타이머: flash/invuln 매 프레임 -1,  stun 은 z<=0 일 때만 -1
죽음:   dead 면 update 생략, 물리는 계속, z<=0 에서 removeT 를 줄여 0 이 되면 (persistent 아니면) 제거
```

### 3-9. `Combat`

```js
Combat.applyHitbox(hb)   // → 이번 호출에서 새로 맞은 엔티티 배열
Combat.frontBox(owner, reach, extra?)   // owner 앞쪽 사각형 hb 생성 (extra 로 필드 덮어쓰기)
Combat.aroundBox(owner, rx, extra?)     // owner 좌우 대칭 사각형 hb 생성
Combat.damage(target, amount, hb?)      // 낮은 수준 API (함정/낙뢰 등). hb 없으면 기본 반응
```

**hb(히트박스) 필드**

| 필드 | 기본 | 의미 |
|------|------|------|
| `team` | owner.team | **공격하는 쪽** 팀. 자기 팀과 `'neutral'` 은 안 맞음 |
| `owner` | — | 공격자 엔티티 |
| `x1, x2` | — | 공격 사각형의 x 범위 (월드 좌표) |
| `y` | owner.y | 공격 기준 깊이 |
| `depth` | 26 | `|target.y - hb.y| < depth` 일 때만 맞음 ← **벨트스크롤의 핵심** |
| `zMin, zMax` | owner.z-10, owner.z+owner.h | 높이 범위 — 타깃의 `[z, z+h]` 와 겹쳐야 함 |
| `damage` | — | 기본 피해량 (최종은 ±10% 흔들림, 최소 1) |
| `knock` | 6 | 넉백 세기 (방향은 owner 의 반대쪽으로 자동. `hb.dir` 로 강제 가능) |
| `launch` | 0 | >0 이면 target.vz = launch (띄우기). `superArmor`/`heavy` 면 무시 |
| `stun` | 14 | 경직 프레임 (`superArmor` 면 0) |
| `freeze` | 3 | 히트스톱 프레임 |
| `shake` | 0 | 화면 흔들림 크기 |
| `sfx` | `'hit'` | 맞는 순간 효과음 |
| `fx` | `'spark'` | 맞는 순간 입자 종류 |
| `hitSet` | 자동 | 이 공격이 이미 맞힌 엔티티 집합 → **한 번 휘두를 때 한 번만 맞음.** 다단히트는 hb 를 여러 개 만든다 |

**`Combat.damage` 처리 순서 (커널이 전담)**

1. `dead / untargetable / invuln>0` 이면 무시
2. 피해량 = `amount × (0.9~1.1)`, 맞는 쪽이 플레이어팀이면 `× Game.diff.dmgTaken`. 최소 1, 반올림
3. `hp` 감소, `flash=6`, 데미지 팝업(플레이어가 맞으면 빨간색), 입자(`hb.fx`), 효과음(`hb.sfx`), `FX.freeze(hb.freeze)`, `FX.shake(hb.shake)`
4. `superArmor` 가 아니면 `kx`(넉백)·`stun`·`launch` 적용. 이미 공중인 타깃이 `launch=0` 으로 맞으면 **저글링**: `vz = max(vz, 3)` (타깃당 최대 6회, `e._juggle` 카운트)
5. 맞은 쪽이 `kind==='player'` 이면 `invuln = CFG.playerInvuln`, `Game.combo.count = 0`
6. 때린 쪽이 플레이어팀이면 `Game.combo.count++`, `timer = CFG.comboWindow`, `max` 갱신
7. `target.onHit?.(target, hb, dmg)` → 이벤트 `entityHit`, 플레이어가 맞았으면 `playerHit`
8. `hp<=0` → `hp=0, dead=true`, `onDeath?.(target, hb)`, 이벤트 `entityDied`, 그리고 **커널이** `enemyKilled`(`team==='enemy'`), `bossKilled`(`boss===true` 추가), `playerDied`(`kind==='player'`) 를 emit — **모듈은 이 이벤트를 직접 emit 하지 않음**

디버그: `Debug.god = true` 이면 플레이어팀 타깃의 피해를 무시 (테스트/봇 용).

### 3-10. `Cam`, `Draw`

```js
Cam.x                                  // 화면 왼쪽 끝의 월드 x
Cam.follow(target)                     // 부드럽게 추적: Cam.x += (원하는값 - Cam.x) * 0.12, [0, world.width - W] 로 clamp
Cam.snap(target?)                      // 즉시 이동 (방 전환 직후)
Cam.apply(ctx)                         // ctx.save() 후 translate(-round(Cam.x) + shake.x, shake.y).  짝: ctx.restore()

Draw.text(ctx, str, x, y, {size=20, color='#fff', stroke=COLORS.ink, lw=4, align='center', weight='bold', alpha=1})   // 윤곽선 글자
Draw.bar(ctx, x, y, w, h, ratio, {fg, bg, border})                 // 체력바 등
Draw.roundRect(ctx, x, y, w, h, r)                                 // path 만 만든다 (fill/stroke 는 호출자가)
Draw.shadow(ctx, e)                                                // Entities.drawAll 이 호출
```

### 3-11. `Scenes`, `Loop`

```js
const Scenes = {};     // 각 모듈이 채움:  Scenes.title / Scenes.play / Scenes.result = { enter(), exit(), update(), draw(ctx) }
Loop.start()           // requestAnimationFrame 시작, Loop.started = true
Loop.tick()            // 고정 update 1회: (paused 면 건너뜀) hooks → FX.hitstop>0 이면 hitstop-- 만 / 아니면 Scenes[Game.scene].update(); Game.frame++ (play 씬일 때) → Input.endFrame()
Loop.step(n)           // tick 을 n번 동기 실행 (그리기 없음) — 테스트용
Loop.manual            // true 면 RAF 루프는 그리기만 하고 update 는 안 함 (테스트가 step 으로만 진행)
Loop.hooks             // 함수 배열. 매 tick 의 update 직전에 호출 (봇/디버그 용)
```
**히트스톱 중에는 `Input.endFrame()` 을 부르지 않아** 눌린 키가 버퍼링됩니다 (공격 입력이 씹히지 않음).
고정 타임스텝은 `acc += min(dt, 100ms); while (acc >= 1000/60) tick()`.

`Scenes.play.update` (stage 소유) 의 권장 순서: `Entities.updateAll() → Stage 진행 → Cam.follow(Game.player) → FX.update() → 콤보 타이머 감소`.
`Scenes.play.draw` 의 권장 순서는 5-5 참고.

## 4. 공통 스타일 가이드 (아트)

- **귀엽고 통통한 젤리 스타일**: 둥근 도형 + **굵은 어두운 윤곽선**(`COLORS.ink`, 3px), 단색 면 + 하이라이트 한 점. 눈은 흰자+동공+반짝임.
- **스쿼시 & 스트레치**: 점프 올라갈 때 세로로 길게, 착지/피격 시 납작하게. 정적인 사각형 금지.
- 피·잔인한 표현 금지. 쓰러지면 **별/사탕 입자가 "펑!"** 하고 터지며 사라진다.
- 큰 글씨(HUD 최소 18px), 윤곽선 글자(`Draw.text`)로 어떤 배경에서도 읽히게.
- 색 팔레트는 `COLORS` 를 쓴다 (스테이지 '사탕 숲': 분홍·하늘·민트·크림).

## 5. 모듈별 계약

### 5-1. player — `Player` (`src/js_player.html`)

```js
Player.create(x, y)       // 엔티티 생성 + Entities.add + Game.player 설정 후 반환
Player.revive(p, {invuln=120})   // 부활: hp=maxHp, state='idle', 무적, 연출. Events 'playerRevived'
Player.heal(p, n)         // hp 회복 (maxHp 초과 불가) + 초록 팝업/효과음
PLAYER_DEF                // 데이터 테이블 (스탯/콤보/스킬 수치 — 숫자만 바꿔도 밸런싱 가능)
```

- 엔티티: `kind:'player', team:'player', persistent:true, w:40, h:80, hp/maxHp:100`, `atk: 6`.
- `p.state`: `'idle'|'walk'|'jump'|'attack'|'skill'|'hurt'|'down'`
- `p.skills = [{ id, key, label, icon, cdMax, cd }]` ← **HUD 가 이 배열을 읽어 쿨타임을 그린다.** (3개: A, S, D)
- **조작:** 이동(방향키: 좌우 4px/f, 깊이 3px/f), 점프 `KeyX`(vz=11), 공격 `KeyZ`/Space, 스킬 `KeyA/S/D`.
- **기본 콤보 3타** (공격 중 다음 입력은 버퍼링되어 후딜 후반에 이어짐): 배율 1.0 / 1.0 / 1.5, 3타는 띄우기(`launch≈7`) + 큰 넉백. 각 타는 "준비 → 판정 ON(몇 프레임) → 후딜" 구간으로 나눔. 공격 중엔 이동 불가(스킬 취소 불가).
- **점프 공격:** 공중에서 `KeyZ` → 아래로 내려찍는 판정(배율 1.2), 띄운 적을 공중 콤보로 이을 수 있어야 함.
- **스킬 (쿨타임식, MP 없음):** A `회오리 베기`(주변 360°, 다단히트 합계 ≈2.0배, cd 300f) / S `돌진 찌르기`(앞으로 돌진하며 관통 2.5배, cd 480f) / D `별빛 대폭발`(발동 중 무적, 화면 플래시+히트스톱, 화면 안 전체 5.0배·띄우기, cd 1800f).
- 피격 시 `state='hurt'`(커널이 stun 부여), 무적 중 깜빡임. 죽으면 `state='down'` 으로 쓰러진 모습 유지 (제거되지 않음). **부활/게임오버 판단은 stage 의 몫.**
- 효과음: `swing/hit/jump/land/skill1/skill2/ultimate/hurt`. 타격감 체크리스트(히트스톱·넉백·번쩍임·데미지 숫자·효과음·화면 흔들림)는 `Combat` 이 처리하므로 **스윙 이펙트(칼 궤적), 스킬 이펙트**를 모듈에서 그린다.
- 터치 기기에서는 `Input.press/release` 로 같은 코드가 동작하므로 별도 처리 불필요.

### 5-2. enemies — `Enemies` (`src/js_enemies.html`)

```js
ENEMY_DEFS                           // 데이터 테이블
Enemies.spawn(type, x, y, opts?)     // 엔티티 생성 + Entities.add + 반환. opts: { drop:true(위에서 떨어지며 등장), hpMul, minion:true }
Enemies.aliveCount()                 // 살아있는 적 수 (보스·소환수 포함)
Enemies.clear()                      // 모든 적/마커 제거 + Game.boss = null
```

- 엔티티: `kind:'enemy'`(보스는 `'boss'`, `boss:true`), `team:'enemy'`, `type`, `score`(처치 점수 — stage 가 읽음).
  hp 는 `def.hp × Game.diff.enemyHp × opts.hpMul`, 이동 속도는 `× Game.diff.enemySpeed`.
- **AI 는 상태 머신** (`idle → chase → windup → attack → recover`), **예고(windup) 동작이 반드시 먼저 보여야 함**:
  머리 위 `!` 표시 + 몸이 움찔/번쩍. windup 프레임 = `def.windup × Game.diff.windupMul`, **어떤 난이도에서도 24프레임 미만 금지.**
- **동시 공격자 제한:** `Game.diff.maxAttackers` 명을 넘어 동시에 `windup/attack` 상태가 되지 않게 한다 (나머지는 맴돌며 대기). 접촉만으로는 피해 없음.
- 맞으면(`stun`) 움찔·번쩍·넉백(커널 처리). 죽으면 `onDeath`: `FX.burst`(별+사탕)·효과음 `enemyDie`·`removeT≈22`, 죽음 연출 그림. **아이템 드롭은 모듈이 하지 않음** (stage 가 `enemyKilled` 로 처리).
- 적끼리 겹치지 않게 약한 밀어내기, 플레이어가 죽어 있으면 배회/대기.

| type | 이름 | HP | 공격력 | 속도 | windup | 행동 | 점수 |
|------|------|----|--------|------|--------|------|------|
| `slime` | 사탕 슬라임 | 20 | 5 | 1.2 | 30 | 천천히 다가와 짧은 박치기(작게 웅크렸다 튀어나감) | 100 |
| `soldier` | 장난감 병정 | 35 | 8 | 1.6 | 36 | 사거리 안에서 창 찌르기(앞으로 길게). 가까이서 맴돌며 간격 유지 | 200 |
| `cloud` | 심술 구름 | 25 | 8 | 1.0 | 50 | `noGravity`, 공중(z≈90)에 떠서 플레이어 위치로 이동 → **바닥에 번개 그림자 마커를 먼저 표시**(≥45f) → 낙뢰(원형 판정). 맞으면 살짝 아래로 내려옴 | 200 |
| `jellyKing` | 젤리 대왕(보스) | 300 | 10~15 | 1.0 | 패턴별 | `boss:true, heavy:true`. 아래 3패턴을 순환 | 3000 |

**보스 패턴** (패턴 사이 `recover` 60f 이상 — 반격 타이밍. 패턴 중에는 `superArmor`, 그 외 `stun` 가능):
1. **점프 찍기:** 웅크림(예고) → 높이 점프 → 플레이어 위치에 **착지 마커(≥45f 전부터 표시)** → 착지 충격파(원형 판정, `shake`)
2. **슬라임 소환:** 포효(예고) → `Enemies.spawn('slime', …, {drop:true, minion:true})` 2마리 (살아있는 minion 이 4 이상이면 소환 생략)
3. **돌진:** 몸을 뒤로 당김(예고) → 직선 돌진(관통 판정) → 벽/끝에서 멈춰 어지러운 `recover` (가장 큰 반격 기회)

- 보스 등장 시 `Game.boss = e` + `Events.emit('bossSpawned', e)`. 사망 시 `Game.boss = null` 은 **커널의 `bossKilled` 이벤트를 받아** 처리, 남은 minion 은 함께 터진다. 체력 50% 이하에서 패턴이 빨라지는 2페이즈(색 변화 + `warn` 효과음 + 팝업 "화났다!").

### 5-3. stage — `Stage` (`src/js_stage.html`)

```js
STAGES                                   // 데이터 테이블 (방 목록·웨이브)
Stage.start({ difficulty, nickname, stageIndex=0 })   // 새 런 시작: Game.resetRun → Entities.clear → FX.clear → Enemies.clear → Player.create → 첫 방 → Game.setScene('play')
Stage.dropPickup(x, y, type)             // type: 'candy'(HP 회복 20) | 'coin'(+50 점)
Stage.drawBackground(ctx)                // 카메라 변환 안에서 호출됨
Stage.drawOverlay(ctx)                   // 화면 좌표계: GO ▶, 방 이름 배너, 페이드, 튜토리얼 힌트, 보스 경고
Stage.calcStars({cleared, deaths})       // 0~3
Scenes.play = { enter, exit, update, draw }
```

- **방(room) 흐름:** `intro`(방 이름 배너 ~90f) → `fight`(웨이브가 전멸하면 다음 웨이브 소환) → `clear`(`GO ▶` 깜빡임 + 효과음 `go`, 플레이어가 방 오른쪽 끝에 닿으면 진행) → `transition`(페이드 아웃/인 ~40f, 새 `Game.world.width`, 플레이어 x=60, `Cam.snap`) → 다음 방 … → 보스방 → `victory`(보스 처치 후 슬로모/플래시, `CLEAR!` 배너 ~150f) → `Game.result` 채우고 `Game.setScene('result')`.
- 웨이브 소환: 좁은 방(960)은 `drop:true` (위에서 떨어짐), 넓은 방은 화면 오른쪽 바깥에서 걸어 들어옴(`x = Cam.x + W + 40 + …`). 한 번에 화면에 있는 적은 최대 6.
- `Game.stage` (이름·방 번호·방 이름) 를 항상 최신으로 유지 (HUD 가 표시).
- **스테이지 1 '사탕 숲'** (데이터로 정의, `STAGES[0]`) — 5분~8분 분량:

| 방 | 이름 | 너비 | 웨이브 |
|----|------|------|--------|
| 1 | 숲 입구 | 960 | ① 슬라임×2 ② 슬라임×3 (+튜토리얼 힌트: 이동/공격/점프) |
| 2 | 달콤한 오솔길 | 1920 | ① 슬라임×3 ② 슬라임×2 + 병정×1 · 클리어 보상 사탕 |
| 3 | 초콜릿 시냇가 | 1920 | ① 병정×2 + 슬라임×2 ② 구름×2 + 슬라임×2 |
| 4 | 젤리 동굴 입구 | 1920 | ① 구름×1 + 병정×2 ② 슬라임×3 + 병정×2 + 구름×1 · 클리어 보상 사탕 |
| 5 | 젤리 대왕의 방 | 960 | 보스 (등장 연출 + "⚠ 보스 등장!" 경고, 보스 체력 50% 때 사탕 1개 드롭) |

- **튜토리얼 힌트:** 방 1 에서 월드 좌표에 떠 있는 안내 문구 — `Game.touch` 이면 "버튼" 표현, 아니면 키 이름 표현. 첫 적을 처음 때리면 사라지는 식으로.
- **점수:** 처치 시 `e.score × (1 + min(Game.combo.count, 30) × 0.02)` 를 `Game.addScore`. 방 클리어 +300, 스테이지 클리어 +1000, 무사망 클리어 +500.
- **드롭:** `enemyKilled` 에서 코인 35%, 사탕 12% (보스 제외). 픽업은 `kind:'pickup'` 엔티티(둥둥 떠다님), 플레이어가 가까이(|dx|<36, |dy|<30) 오면 획득 + `Events 'pickup'`. 일정 시간 후 사라짐(깜빡임 경고).
- **플레이어 사망 처리 (`playerDied` 수신):** `Game.deaths++`, 90f 후 → `Game.lives` 가 남아 있으면(Infinity 포함) `lives--`(유한일 때만)·`Player.revive`·`Game.diff.revivePenalty` 만큼 점수 차감(`score × penalty`), 아니면 게임 오버 → `Game.result` (`cleared:false`) 채우고 `Game.setScene('result')`. 이벤트 `playerRevived`/`gameOver`.
- **결과(`Game.result`):**
```js
{ cleared: bool, score, stars: 0~3, timeFrames, kills, deaths, maxCombo, difficulty, stageId, stageName, rooms: 클리어한 방 수 }
```
  별: 클리어 시 1개 + 사망 ≤2회면 +1 + 사망 0회면 +1 (게임 오버면 0개).
- **배경:** 이미지 없이 Canvas 로 '사탕 숲' (하늘 그라디언트, 멀리 산/구름 패럴랙스, 막대사탕 나무·젤리 바위·솜사탕 덤불 — 고정 시드로 위치 고정, 바닥 타일). 보스방은 어둡고 붉은 분위기로.
- `Scenes.play.draw` 순서: `ctx.save → Cam.apply → Stage.drawBackground → Entities.drawAll → FX.drawWorld → ctx.restore → FX.drawScreen → Stage.drawOverlay → UI.drawHUD`.

### 5-4. ui — `UI` (`src/js_ui.html`, `src/style.html`)

```js
UI.drawHUD(ctx)          // play 씬 마지막에 호출됨 (캔버스 HUD)
UI.toast(text, ms=2500)  // 화면 상단 알림
Scenes.title = {...}  Scenes.result = {...}
UI.showRanking()  UI.hideRanking()
```

- DOM 오버레이는 `#ui`(타이틀/결과/일시정지/랭킹/토스트), 터치 컨트롤은 `#touch` 안에 JS 로 생성. (index.html 은 수정하지 않음)
- **화면 크기:** `#app` 은 16:9 레터박스. CSS 변수 `--u`(= 캔버스 실제 폭/960 px)를 `resize` 때 갱신해 오버레이 글자/버튼 크기를 비례 조정. 화면이 작아도 버튼은 **최소 44px**.
- **타이틀:** 게임 제목, 닉네임 입력(2~8자, 마지막 값 `Store` 에 기억, `Server.validateNickname` 으로 검증·오류 문구 표시), 난이도 3버튼(라벨+설명, `CFG.difficulty`), **「시작!」 버튼**(`SFX.init()` + `Music.play` + `Stage.start`), 「조작법」 패널, 「랭킹」 버튼, 음소거 토글. 캔버스에는 귀여운 애니메이션 배경(`Scenes.title.update/draw`).
- **HUD(캔버스):** 좌상단 HP바(숫자 포함)+목숨(하트, 쉬움은 ∞), 하단 좌측 스킬 3개 아이콘(키 표시 + 쿨타임 부채꼴/숫자, 준비되면 반짝), 우상단 점수, 콤보(`3 HIT!` 크게, 콤보가 쌓일수록 커짐), 상단 중앙 `Game.stage.roomName`+방 진행도(●○○○○), 하단 중앙 보스 체력바(`Game.boss`, 이름 `젤리 대왕`), 우상단 작은 일시정지/음소거 버튼(DOM).
- **일시정지:** `Escape`/`KeyP`/버튼 → `Game.pause(true)`, DOM 오버레이(계속하기/다시 시작/처음으로). `windowBlur` 이벤트 시 play 씬이면 자동 일시정지.
- **결과 화면:** 별 1~3개 순서대로 팝(효과음 `star`), 점수 내역(처치/콤보/클리어 보너스는 `Game.result` 필드 기준으로 표시), 게임 오버면 "아쉬워요! 다시 도전!" 처럼 **격려 문구**. 열리자마자 `Server.saveScore` 호출 → 상태 문구("저장 중…" → "저장됐어요!" / "내 기기에만 저장됐어요" / "저장 실패 — 다시 시도" 버튼), 이어서 `Server.getTopScores(10)` 로 랭킹 표시(내 닉네임 강조). 버튼: 「다시 하기」(같은 난이도로 `Stage.start`), 「처음으로」.
- **휴식 알림:** `Game.frame` 이 아닌 *실제 play 씬 진행 시간* 이 `CFG.breakReminderMinutes` 를 넘으면 `UI.toast('잠깐 쉬어요! 눈과 손을 풀어 볼까요? 🙆')` (런당 1회 반복 가능).
- **터치:** `Game.touch` 이면 `#touch` 에 왼쪽 가상 조이스틱(방향키 4개를 임계값으로 `Input.press/release`), 오른쪽 `공격(Z)`·`점프(X)`·스킬 3개(A/S/D) 버튼 (`Input.bindButton`). 키보드 기기에선 숨김. 첫 `touchstart` 에 자동 표시.
- **금지:** `alert/confirm/prompt` (샌드박스 iframe 에서 막힐 수 있음), 외부 이미지/스크립트. 폰트는 Google Fonts `Jua` 를 **논블로킹**으로 불러오되(`media="print" onload` 기법) 실패해도 폴백 폰트로 정상 동작.

### 5-5. server — `Server` (`src/js_server.html`, `src/Code.gs`, `src/appsscript.json`)

```js
Server.available                         // google.script.run 사용 가능 여부
Server.validateNickname(raw)             // → { ok:true, value } | { ok:false, error:'한글 문구' }   (2~8자, 한글/영문/숫자/공백, 금칙어 포함 여부)
Server.saveScore({ nickname, score, stageId, difficulty, stars, cleared, timeSec })   // → Promise<{ ok:true, source:'server'|'local', rank? }>  (절대 reject 하지 않고, 서버 실패 시 local 폴백 + warning)
Server.getTopScores(n=10, difficulty?)   // → Promise<Array<{ rank, nickname, score, stars, difficulty }>>  (실패 시 로컬 랭킹)
Server.call(fn, ...args)                 // google.script.run → Promise (10초 타임아웃). 서버 없으면 reject
```

- **로컬 폴백:** `Store` 의 `'scores'` 키에 상위 50개를 보관. 서버가 없거나 실패하면 거기에 저장/조회.
- **`Code.gs`:** `doGet`, `include`, `saveScore(payload)`, `getTopScores(n, difficulty)`.
  - 스프레드시트 자동 준비: 스크립트 속성 `SHEET_ID` → 없으면 컨테이너 바인딩 시트 → 없으면 새로 만들어 ID 저장. `Scores` 시트가 없으면 만들고 헤더(`시간|닉네임|점수|별|난이도|스테이지|시간(초)`) 작성.
  - **검증:** 닉네임 정리(공백/길이/허용문자/금칙어/**앞의 `= + - @` 제거 — 시트 수식 주입 방지**), 점수 `0~999999` 정수, 별 `0~3`, 난이도 화이트리스트, `timeSec` 범위. 잘못되면 한글 메시지로 throw.
  - `LockService` 로 동시 쓰기 보호, `CacheService` 로 같은 닉네임·점수 10초 내 중복 저장 차단, 랭킹 조회 결과는 30초 캐시(저장 시 무효화).
  - `google.script.run` 으로 `Date` 를 돌려주지 않는다. 닉네임별 최고 점수만 랭킹에 표시.
  - **개인정보:** 닉네임 외에는 수집하지 않는다. `Session.getActiveUser()` 등 사용자 식별 API 금지.
- `src/appsscript.json`: `timeZone Asia/Seoul`, `runtimeVersion V8`, `webapp {executeAs: USER_DEPLOYING, access: ANYONE_ANONYMOUS}`.

### 5-6. core 부팅 — `js_main.html`

```js
// 모든 모듈 로드 후 실행
Loop.start();
Game.setScene(Scenes.title ? 'title' : (Scenes.play ? 'play' : 'boot'));   // 'boot' 씬(로딩 문구)은 core 가 기본 제공
```
전역 `window.onerror`/`unhandledrejection` 은 `console.error` 로 남기되 게임을 멈추지 않는다.

## 6. 데이터 모양 요약

```js
// Stage 데이터
STAGES = [{ id:'stage1', name:'사탕 숲', theme:'candy',
  rooms: [{ name:'숲 입구', width:960, waves:[[{type:'slime',count:2}], [{type:'slime',count:3}]], reward:null|'candy', boss:false }, ...] }];
```

## 7. 변경 요청 형식 (소유자가 아닌 파일/계약을 바꿔야 할 때)

작업 보고서의 `contractRequests` 에 한 줄씩: `{ file, owner, what, why }`.
예) `{ file:'src/js_core.html', owner:'core', what:'Combat.damage 에 hb.armorPierce 추가', why:'보스 슈퍼아머 무시 공격 필요' }`

## 8. 이벤트 카탈로그

| 이벤트 | 발행자 | 데이터 | 구독자(예) |
|--------|--------|--------|-----------|
| `sceneChanged` | core | `{from, to}` | UI |
| `paused` | core | `{on}` | UI |
| `windowBlur` | core | — | UI(자동 일시정지) |
| `entityHit` | core | `{target, hb, dmg}` | — |
| `entityDied` | core | `{target, hb}` | — |
| `enemyKilled` | core | `target`(적 엔티티) | Stage(점수/드롭), Game.kills++ 은 core |
| `bossKilled` | core | `target` | Stage(승리 연출), Enemies(Game.boss=null, minion 정리) |
| `playerHit` | core | `{target, hb, dmg}` | UI(화면 빨간 번쩍 등) |
| `playerDied` | core | `target` | Stage |
| `playerRevived` | Player | `player` | UI/Stage |
| `comboChanged` | core | `{count, max}` | UI |
| `bossSpawned` | Enemies | `boss` | Stage(경고 배너), Music |
| `roomStarted` / `roomCleared` | Stage | `{index, room}` | UI/Music |
| `stageCleared` / `gameOver` | Stage | `Game.result` | UI/Music |
| `pickup` | Stage | `{type, x, y}` | — |

## 9. 밸런스 기준 (어린이 눈높이)

- 플레이어 HP 100. 보통 난이도에서 **3~4번 맞으면 위험**, 몬스터 하나에 **기본 공격 3~5번**.
- 기본 콤보 한 바퀴(1·1·1.5 배)로 슬라임(20)은 약 1바퀴, 병정(35)은 약 2바퀴.
- 한 방 20~40초, 던전 전체 5~8분. 쉬움 난이도는 **죽어도 즉시 부활**(게임 오버 없음).

## 10. 테스트 규약

- 빌드: `node tools/build-local.mjs [--out dist/_이름.html]` → `src/` 를 합쳐 단일 HTML 생성. `<script>` 안 JS 문법 오류는 **파일명과 함께** 보고하고 종료 코드 1.
  - **여러 에이전트가 동시에 작업하므로 각자 `--out dist/_자기이름.html` 로 빌드하고, 테스트는 `GAME_HTML=dist/_자기이름.html node tools/tests/xxx.test.mjs` 로 실행.**
- 테스트 도구: `tools/lib/browser.mjs`(`openGame`, `step`), `tools/lib/check.mjs`(`check`, `finish`). Playwright + 헤드리스 Chromium (네트워크 없음 — 외부 요청은 빈 응답으로 막음).
- **결정적 테스트:** `openGame()` 은 기본으로 `Loop.manual = true` — `await step(page, n)`(= `Loop.step(n)`)으로 프레임을 직접 진행. 입력은 `Input.press('KeyZ')` / `Input.release('KeyZ')`. 난수는 `RNG.seed(1)`.
- 다른 모듈 파일이 아직 비어 있거나 깨져 있을 수 있음: 문법 오류가 **남의 파일**이면 잠시 후 재시도하고, 그동안 `const X = {}` 형태의 스텁이라면 테스트에서 필요한 메서드를 `page.evaluate` 로 임시 주입해도 됨.
- 테스트는 **의미 있는 단언**을 해야 한다 (예: "맞는다"뿐 아니라 "깊이가 다르면 안 맞는다").

## 11. Apps Script 호환 제약 (전 모듈 공통)

- `index.html` 에서만 `<?!= include('...') ?>` 사용. **include 되는 `*.html` 안 JS 에는 `</script>` 문자열을 쓰지 않는다.**
- 외부 스크립트/이미지 금지. 외부 요청은 Google Fonts 스타일시트 하나뿐(논블로킹, 실패해도 정상 동작).
- `alert/confirm/prompt/document.write/eval` 금지. 전체화면 API 에 의존하지 않는다.
- `localStorage` 는 항상 `Store` 로(try/catch). 쿠키 금지.
- `google.script.run` 은 `js_server.html` 에서만 사용. 서버로 보내는 값은 숫자/문자열/객체/배열만 (Date/함수 금지).
- iframe 안이므로 포커스가 없을 수 있음 → 「시작」 버튼 클릭으로 포커스 확보, `blur` 시 입력 해제.
