// ui 모듈 테스트 (src/js_ui.html, src/style.html)
//   실행: node tools/build-local.mjs --out dist/_ui.html && GAME_HTML=dist/_ui.html node tools/tests/ui.test.mjs
//   SHOT_DIR=/어딘가 를 주면 화면 스크린샷을 그 폴더에 저장해요 (저장소 안에는 쓰지 않아요). ONLY=글자 를 주면 이름에 그 글자가 든 구역만 실행해요.
//
//   Stage / Server 는 아직 없거나 따로 테스트되므로, 이 테스트는 둘 다 "가짜"로 바꿔 끼워서 UI 만 확인합니다.
//   (Stage.start 는 호출 인자를 기록하고, Server.saveScore/getTopScores 는 테스트가 결과를 마음대로 정함)
//   play 씬도 테스트용(HUD 를 그리는 단순한 씬)으로 바꿔요. 커널(Input/Game/Events/Loop/Draw/FX)은 진짜를 씁니다.
import { openGame, step } from '../lib/browser.mjs';
import { check, finish } from '../lib/check.mjs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SHOTS = !!process.env.SHOT_DIR;                                       // 스크린샷은 SHOT_DIR 를 줄 때만 저장 (평소엔 시간 절약)
const SHOT_DIR = process.env.SHOT_DIR || join(tmpdir(), 'jd-ui-shots');
if (SHOTS) mkdirSync(SHOT_DIR, { recursive: true });

const section = async (name, fn) => {            // 한 구역이 예외로 죽어도 나머지는 계속  (ONLY=글자 를 주면 이름에 그 글자가 든 구역만 실행)
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return;
  try { await fn(); } catch (e) { check(`[${name}] 구역이 예외 없이 끝남`, false, String((e && e.stack) || e).split('\n').slice(0, 3).join(' | ')); }
};
const wait = ms => new Promise(r => setTimeout(r, ms));
const UI_GUARD_WAIT = 600;                                                 // UI_TUNE.confirmGuardMs(500) 보다 조금 더
const SHOT_WAIT = 700;                                                     // 스크린샷 전에 CSS 애니메이션이 끝나길 기다리는 시간

// ---------------------------------------------------------------------------
// 새 페이지를 열고 가짜 Stage/Server/play 씬과 도우미(T, PX)를 심어요
// ---------------------------------------------------------------------------
async function fresh(opts = {}) {
  const g = await openGame(opts);                                             // (GAME_HTML 환경변수가 없으면 dist/index.html)
  const { page } = g;
  g.ev = (fn, arg) => page.evaluate(fn, arg);
  g.shot = async name => { if (!SHOTS) return; await wait(SHOT_WAIT); await page.evaluate(() => Loop.draw()); await page.screenshot({ path: join(SHOT_DIR, name + '.png') }); };
  g.state = () => page.evaluate(() => UI.state());
  g.done = async label => { check(`[${label}] 콘솔/페이지 오류가 없음`, g.errors.length === 0, g.errors.slice(0, 2).join(' | ')); await g.close(); };
  await g.ev(() => {
    const T = window.T = { started: [], sfx: [], music: [], saves: [], saveCbs: [], ranks: [], rankDiffs: [] };
    SFX.play = n => { T.sfx.push(n); };                                       // 효과음 이름만 기록
    const origInit = SFX.init.bind(SFX); T.inits = 0; SFX.init = () => { T.inits++; return origInit(); };
    Music.play = n => { T.music.push(n); };
    Stage.start = o => { T.started.push(o); Game.resetRun(o); Game.setScene('play'); };
    Server.validateNickname = undefined;                                       // 기본은 UI 안의 간단한 검사를 씀 (서버 검증은 따로 확인)
    Server.saveScore = p => new Promise((res, rej) => { T.saves.push(p); T.saveCbs.push({ res, rej }); });          // 테스트가 직접 resolve/reject
    Server.getTopScores = (n, d) => { T.ranks.push(n); T.rankDiffs.push(d); return Promise.resolve(window.ROWS || []); };
    window.ROWS = [
      { rank: 1, nickname: '용사민준', score: 98765, stars: 3, difficulty: 'hard' },
      { rank: 2, nickname: '별이', score: 80200, stars: 3, difficulty: 'normal' },
      { rank: 3, nickname: '하늘', score: 61000, stars: 2, difficulty: 'normal' },
      { rank: 4, nickname: '코코', score: 45100, stars: 2, difficulty: 'easy' },
    ];
    Scenes.play = {                                                            // HUD 를 그리는 테스트용 play 씬
      update() { Entities.updateAll(); FX.update(); Game.tickCombo(); },
      draw(ctx) {
        const gr = ctx.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, '#bfeaff'); gr.addColorStop(0.6, '#e8ffd9'); gr.addColorStop(1, '#8fe3a2');
        ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);
        ctx.save(); Cam.apply(ctx); Entities.drawAll(ctx); FX.drawWorld(ctx); ctx.restore(); FX.drawScreen(ctx);
        UI.drawHUD(ctx);
      },
    };
    // 픽셀 분석 도우미: 투명한 캔버스에 HUD 만 그린 뒤, 영역 안에서 조건에 맞는 픽셀 수를 센다 (draw 와 분석을 한 번에 → RAF 가 끼어들 수 없음)
    const P = {
      green: (r, g, b, a) => a > 200 && g > r + 40 && g > b + 40,
      red: (r, g, b, a) => a > 200 && r > 200 && g < 175 && b < 175 && r - g > 60,
      fill: (r, g, b, a) => a > 200 && r + g + b > 380,                       // 체력바/보스바의 채워진 부분 (어두운 바탕은 합이 작음)
      yellow: (r, g, b, a) => a > 200 && r > 230 && g > 190 && b < 120,
      alpha: (r, g, b, a) => a > 0,
      solid: (r, g, b, a) => a > 200,
      bright: (r, g, b, a) => a > 200 && r + g + b > 520,
    };
    window.PX = {
      draw(extra) { const c = Loop.canvas, ctx = c.getContext('2d'); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, c.width, c.height); ctx.setTransform(Loop.dpr, 0, 0, Loop.dpr, 0, 0); UI.drawHUD(ctx); if (extra) extra(ctx); return ctx; },
      run(rects) {
        const ctx = PX.draw(), d = Loop.dpr;
        return rects.map(r => { const im = ctx.getImageData(Math.round(r.x * d), Math.round(r.y * d), Math.max(1, Math.round(r.w * d)), Math.max(1, Math.round(r.h * d))).data; let n = 0; for (let i = 0; i < im.length; i += 4) if (P[r.pred](im[i], im[i + 1], im[i + 2], im[i + 3])) n++; return n; });
      },
      avg(rect) { const ctx = PX.draw(), d = Loop.dpr, im = ctx.getImageData(Math.round(rect.x * d), Math.round(rect.y * d), Math.max(1, Math.round(rect.w * d)), Math.max(1, Math.round(rect.h * d))).data; let n = 0, sum = 0; for (let i = 0; i < im.length; i += 4) if (im[i + 3] > 200) { n++; sum += im[i] + im[i + 1] + im[i + 2]; } return n ? sum / n : 0; },
      alphaAt(x, y) { const ctx = PX.draw(); return ctx.getImageData(x * Loop.dpr, y * Loop.dpr, 1, 1).data[3]; },
    };
  });
  return g;
}
// play 씬으로 들어가서 플레이어(진짜 Player 가 있으면 그걸, 없으면 가짜)를 세운다
const toPlay = (g, o = {}) => g.ev(o => {
  Game.resetRun({ difficulty: o.difficulty || 'normal', nickname: o.nickname || '테스트' });
  Entities.clear(); FX.clear();
  if (typeof Player !== 'undefined' && Player.create) Player.create(300, 420);
  else {
    const p = Entities.make({ kind: 'player', team: 'player', persistent: true, x: 300, y: 420, hp: 100, maxHp: 100 });
    p.skills = [{ id: 'a', key: 'A', label: '회오리 베기', icon: '🌪️', cdMax: 300, cd: 0 }, { id: 's', key: 'S', label: '돌진 찌르기', icon: '💨', cdMax: 480, cd: 0 }, { id: 'd', key: 'D', label: '별빛 대폭발', icon: '🌟', cdMax: 1800, cd: 0 }];
    p.draw = (ctx, e) => { ctx.fillStyle = '#c0f'; ctx.fillRect(e.x - 20, e.y - 80, 40, 80); };
    Entities.add(p); Game.player = p;
  }
  Game.stage = { id: 's1', name: '사탕 숲', roomIndex: 1, roomCount: 5, roomName: '달콤한 오솔길' };
  Game.setScene('play');
}, o);
const rectOf = (g, sel) => g.ev(sel => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, r: r.right, b: r.bottom, vis: !!(r.width && r.height) && getComputedStyle(e).visibility !== 'hidden' }; }, sel);
const fakeKey = (g, type, code, extra = {}) => g.ev(([type, code, extra]) => { window.dispatchEvent(new KeyboardEvent(type, { code, key: code, bubbles: true, cancelable: true, ...extra })); }, [type, code, extra]);

// ===========================================================================
// 1. 타이틀 흐름
// ===========================================================================
await section('타이틀', async () => {
  const g = await fresh();
  const { page } = g;
  let s = await g.state();
  check('시작하면 타이틀 씬이고 타이틀 화면이 보임', s.scene === 'title' && s.titleVisible);
  check('타이틀에는 일시정지 버튼이 없고(숨김) 소리 버튼은 있음', await g.ev(() => document.getElementById('ui-pause').hidden && !document.getElementById('ui-mute').hidden));
  check('난이도 카드가 CFG.difficulty 개수만큼 있고 라벨/설명이 들어 있음', await g.ev(() => {
    const cards = [...document.querySelectorAll('.diff-card')];
    return cards.length === Object.keys(CFG.difficulty).length && cards.every(c => { const d = CFG.difficulty[c.dataset.diff]; return c.textContent.includes(d.label) && c.textContent.includes(d.desc); });
  }));
  check('난이도: 처음엔 딱 하나(보통)만 선택됨', await g.ev(() => { const on = [...document.querySelectorAll('.diff-card[aria-checked="true"]')]; return on.length === 1 && on[0].dataset.diff === 'normal'; }));
  check('캔버스에 제목이 그려짐 (타이틀 배경이 투명이 아님)', await g.ev(() => { Loop.draw(); const c = Loop.canvas, d = c.getContext('2d').getImageData(c.width / 2 | 0, 100 * Loop.dpr | 0, 1, 1).data; return d[3] === 255; }));

  // --- 닉네임 검사: 막히고, 안 시작하고, 친절한 문구 ---
  const startBtn = page.locator('#ui-start');
  await page.fill('#ui-nick', '');
  await startBtn.click({ force: true });
  s = await g.state();
  check('빈 이름은 시작이 막히고 오류 문구가 보임', s.scene === 'title' && s.nickError.length > 0 && await g.ev(() => T.started.length === 0), s.nickError);
  check('오류 문구는 입력칸과 연결(aria-invalid)되고 이름 규칙(2~8)을 알려줌', await g.ev(() => document.getElementById('ui-nick').getAttribute('aria-invalid') === 'true' && /2/.test(document.getElementById('ui-nick-err').textContent) && /8/.test(document.getElementById('ui-nick-err').textContent)));
  await page.fill('#ui-nick', 'a'); await startBtn.click({ force: true });
  check('한 글자 이름도 막힘', (await g.state()).scene === 'title' && await g.ev(() => T.started.length === 0));
  await page.fill('#ui-nick', '<b>x</b>'); await startBtn.click({ force: true });
  const sErr = await g.state();
  check('특수문자(<b>) 이름은 막힘', sErr.scene === 'title' && sErr.nickError.length > 0 && await g.ev(() => T.started.length === 0), sErr.nickError);
  await page.fill('#ui-nick', '가나다라마바사아자차');
  check('이름 입력칸은 8글자까지만 받음 (maxlength)', await g.ev(() => document.getElementById('ui-nick').value.length <= 8 && document.getElementById('ui-nick').maxLength === 8));
  await page.fill('#ui-nick', 'ab'); 
  check('다시 입력하면 오류 문구가 사라짐', (await g.state()).nickError === '');

  // --- 서버 검증이 있으면 그 결과를 따른다 ---
  await g.ev(() => { Server.validateNickname = raw => raw === '금지어' ? { ok: false, error: '쓸 수 없는 말이에요' } : { ok: true, value: raw.trim() + '★' }; });
  await page.fill('#ui-nick', '금지어'); await startBtn.click({ force: true });
  s = await g.state();
  check('Server.validateNickname 이 거절하면 그 문구를 보여주고 시작하지 않음', s.scene === 'title' && s.nickError === '쓸 수 없는 말이에요' && await g.ev(() => T.started.length === 0), s.nickError);
  await page.fill('#ui-nick', '용사'); await startBtn.click({ force: true });
  check('Server.validateNickname 이 돌려준 value 로 시작함', await g.ev(() => T.started.length === 1 && T.started[0].nickname === '용사★'), JSON.stringify(await g.ev(() => T.started)));
  await g.done('타이틀 검사');
});

await section('타이틀: 시작 / Enter / 기억 / 난이도', async () => {
  const g = await fresh();
  const { page } = g;
  // 난이도 선택
  await page.click('.diff-card[data-diff="hard"]');
  check('난이도 카드를 누르면 그 카드만 선택됨 (aria-checked)', await g.ev(() => { const on = [...document.querySelectorAll('.diff-card')].filter(c => c.getAttribute('aria-checked') === 'true'); return on.length === 1 && on[0].dataset.diff === 'hard'; }));
  check('UI.state().difficulty 도 바뀜', (await g.state()).difficulty === 'hard');
  check('선택된 카드만 tabindex 0 (라디오 그룹)', await g.ev(() => [...document.querySelectorAll('.diff-card')].filter(c => c.tabIndex === 0).map(c => c.dataset.diff).join() === 'hard'));
  // 화살표 키로 난이도 고르기 (카드에 포커스가 있을 때)
  await g.ev(() => document.querySelector('.diff-card[data-diff="hard"]').focus());
  await page.keyboard.press('ArrowLeft');
  check('카드에서 ← 키로 이전 난이도(보통) 선택 + 포커스 이동', await g.ev(() => UI.state().difficulty === 'normal' && document.activeElement.dataset.diff === 'normal'));
  await page.keyboard.press('ArrowRight');
  check('→ 로 다음 난이도(어려움)', (await g.state()).difficulty === 'hard');
  await page.keyboard.press('ArrowRight');
  check('끝에서 → 는 처음(쉬움)으로 돎', (await g.state()).difficulty === 'easy');
  check('난이도 카드의 화살표 키가 게임 입력(Input)으로 새지 않음', await g.ev(() => !Input.isDown('ArrowRight') && !Input.wasPressed('ArrowRight') && !Input.isDown('ArrowLeft')));
  await page.click('.diff-card[data-diff="hard"]');

  // 닉네임 입력 중 글자가 게임 키로 새지 않음 (별명 칸에는 처음부터 만들어 준 별명이 들어 있으니 먼저 비워요)
  await page.fill('#ui-nick', '');
  await page.click('#ui-nick');
  const muted0 = await g.ev(() => SFX.muted);
  await page.keyboard.type('zxasdpm ', { delay: 5 });
  const leak = await g.ev(() => ({ down: Object.keys(Input.down), pressed: Object.keys(Input.pressed), muted: SFX.muted, paused: Game.paused, val: document.getElementById('ui-nick').value }));
  check("닉네임 칸에 'z' 등을 쳐도 공격/스킬 키(Input)가 눌리지 않음", leak.down.length === 0 && leak.pressed.length === 0, JSON.stringify(leak));
  check("닉네임 칸에서 'm' 을 쳐도 음소거가 토글되지 않고 'p' 로 일시정지되지 않음", leak.muted === muted0 && leak.paused === false);
  check('글자는 칸에 그대로 들어감', leak.val.startsWith('zxasdpm'), leak.val);
  // Space 는 입력 중이면 공백으로 들어가고 공격(KeyZ)으로 안 감
  check('입력 중 Space 도 공격으로 새지 않음', await g.ev(() => !Input.isDown('KeyZ')));

  // Enter 로 시작
  await page.fill('#ui-nick', '용사');
  await g.ev(() => { document.getElementById('ui-nick').focus(); });
  // 한글 조합을 끝내는 Enter(isComposing) 는 무시
  await g.ev(() => { document.getElementById('ui-nick').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true })); });
  check('한글 조합 중 Enter 는 시작하지 않음', (await g.state()).scene === 'title' && await g.ev(() => T.started.length === 0));
  await page.keyboard.press('Enter');
  const st = await g.ev(() => ({ started: T.started, scene: Game.scene, music: T.music.slice(), inits: T.inits, sfx: T.sfx.slice(), nick: Store.get('nickname'), diff: Store.get('difficulty') }));
  check('Enter 로 Stage.start({difficulty, nickname}) 호출 (고른 난이도, 입력한 이름)', st.started.length === 1 && st.started[0].difficulty === 'hard' && st.started[0].nickname === '용사', JSON.stringify(st.started));
  check('시작 때 SFX.init() 과 Music.play("stage") 를 부름', st.inits >= 1 && st.music.includes('stage'), JSON.stringify({ i: st.inits, m: st.music }));
  check('시작하면 씬이 play 로 바뀌고 타이틀 화면이 사라짐', st.scene === 'play' && !(await g.state()).titleVisible);
  check('마지막 닉네임/난이도가 Store 에 저장됨', st.nick === '용사' && st.diff === 'hard', JSON.stringify([st.nick, st.diff]));
  check('시작 후 포커스가 DOM 버튼/입력칸에 남지 않음 (Space 가 공격으로 갈 수 있게)', await g.ev(() => { const a = document.activeElement; return !a || a === document.body || !document.getElementById('ui').contains(a); }));
  check('Space 가 이제 게임 입력(KeyZ)으로 감', await (async () => { await page.keyboard.down('Space'); const d = await g.ev(() => Input.isDown('KeyZ')); await page.keyboard.up('Space'); return d; })());
  check('플레이 중에는 일시정지 버튼이 보임', await g.ev(() => !document.getElementById('ui-pause').hidden));

  // 처음으로 돌아오면 마지막 이름이 채워져 있음
  await g.ev(() => { Game.setScene('title'); });
  check('타이틀로 돌아오면 입력칸에 마지막 닉네임이 채워져 있음', await g.ev(() => document.getElementById('ui-nick').value === '용사'));
  check('돌아왔을 때 방금 난이도(어려움)가 선택돼 있음', (await g.state()).difficulty === 'hard');
  // 새 페이지에서도 Store 값 기억
  await g.ev(() => { Store.set('nickname', '별이'); Store.set('difficulty', 'easy'); Game.nickname = ''; Game.setScene('play'); Game.setScene('title'); });
  check('저장된 닉네임/난이도가 타이틀에 복원됨', await g.ev(() => document.getElementById('ui-nick').value === '별이' && UI.state().difficulty === 'easy'));

  // Space 로 포커스된 START 버튼 누르기 (키보드만으로 시작)
  await g.ev(() => { Game.setScene('title'); T.started.length = 0; });
  await g.ev(() => document.getElementById('ui-start').focus());
  await page.keyboard.press('Space');
  check('포커스된 「시작」 버튼은 Space 로도 눌림 (커널이 Space 를 막지 않게 UI 가 처리)', await g.ev(() => T.started.length === 1 && T.started[0].nickname === '별이'), JSON.stringify(await g.ev(() => T.started)));
  await g.done('타이틀 시작');
});

await section('소리(M) 토글과 버튼은 한 곳에서만', async () => {
  const g = await fresh();
  const { page } = g;
  await g.ev(() => document.activeElement && document.activeElement.blur());          // 타이틀은 닉네임 칸에 포커스가 있어서 (거기서 m 은 글자)
  const m0 = await g.ev(() => SFX.muted);
  await page.keyboard.press('KeyM');
  const m1 = await g.ev(() => SFX.muted);
  check('M 키 한 번에 음소거가 정확히 한 번 토글됨 (두 번 처리되지 않음)', m1 === !m0);
  await page.keyboard.press('KeyM');
  check('M 키 한 번 더 → 원래대로', (await g.ev(() => SFX.muted)) === m0);
  await page.click('#ui-mute');
  check('소리 버튼 클릭도 토글하고 aria-pressed/아이콘이 바뀜', await g.ev(m0 => SFX.muted === !m0 && document.getElementById('ui-mute').getAttribute('aria-pressed') === String(SFX.muted) && document.getElementById('ui-mute').textContent === (SFX.muted ? '🔇' : '🔊'), m0));
  await g.ev(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('KeyM');
  check('버튼을 누른 뒤에도 M 키는 한 번에 한 번만 토글', (await g.ev(() => SFX.muted)) === m0);
  await g.ev(() => SFX.setMuted(false));
  await g.done('소리 토글');
});

// ===========================================================================
// 2. 일시정지
// ===========================================================================
await section('일시정지', async () => {
  const g = await fresh();
  const { page } = g;
  await g.ev(() => { Game.nickname = '테스트'; Game.difficulty = 'normal'; });
  await toPlay(g);
  let s = await g.state();
  check('play 씬에서는 일시정지 오버레이가 숨겨져 있음', s.scene === 'play' && !s.pauseVisible && !s.paused);
  await page.keyboard.press('Escape');
  s = await g.state();
  check('Esc → Game.paused + 일시정지 화면', s.paused && s.pauseVisible);
  check('열리면 「계속하기」에 포커스 (키보드로 바로 조작)', await g.ev(() => document.activeElement && document.activeElement.id === 'ui-resume'));
  const f0 = await g.ev(() => Game.frame);
  await g.ev(() => Loop.step(30));
  check('일시정지 중에는 게임이 진행되지 않음 (Game.frame 고정)', (await g.ev(() => Game.frame)) === f0);
  await page.keyboard.press('Escape');
  s = await g.state();
  check('Esc 한 번 더 → 계속하기 (화면 사라짐)', !s.paused && !s.pauseVisible);
  check('계속한 뒤 포커스가 오버레이 버튼에 남지 않음', await g.ev(() => !document.getElementById('ui').contains(document.activeElement) || document.activeElement === document.body));
  await page.keyboard.press('KeyP');
  check('P → 일시정지', (await g.state()).paused);
  await page.keyboard.press('KeyP');
  check('P 한 번 더 → 계속', !(await g.state()).paused);
  await page.click('#ui-pause');
  check('일시정지 버튼 클릭 → 일시정지', (await g.state()).paused && (await g.state()).pauseVisible);
  // Space 로 포커스된 「계속하기」 누르기
  await page.keyboard.press('Space');
  check('「계속하기」 에 Space → 계속 (오버레이 안의 버튼은 Space 로 눌림)', !(await g.state()).paused);
  check('그 Space 가 공격(KeyZ)으로 새지 않음', await g.ev(() => !Input.isDown('KeyZ') && !Input.wasPressed('KeyZ')));
  await page.click('#ui-pause');
  await page.click('#ui-resume');
  check('「계속하기」 클릭 → 계속', !(await g.state()).paused);

  // 창 포커스 잃음 → 자동 일시정지 (play 씬에서만)
  await g.ev(() => Events.emit('windowBlur'));
  check('windowBlur → play 씬이면 자동 일시정지', (await g.state()).paused && (await g.state()).pauseVisible);
  await g.ev(() => Events.emit('windowBlur'));
  check('이미 멈춘 상태에서 blur 가 또 와도 멈춘 채 (토글되지 않음)', (await g.state()).paused);
  await page.click('#ui-resume');

  // Tab 이 일시정지 화면 안에서만 돎 (매 단계마다 확인 — 한 바퀴 돌아 우연히 안으로 돌아오는 경우를 걸러내기 위해)
  await page.click('#ui-pause');
  const tabIn = [];
  for (let i = 0; i < 6; i++) { await page.keyboard.press('Tab'); tabIn.push(await g.ev(() => document.getElementById('ui-pause-modal').contains(document.activeElement))); }
  check('Tab 을 6번 눌러도 매번 포커스가 일시정지 화면 안에 머묾 (뒤의 일시정지/소리 버튼으로 새지 않음)', tabIn.every(Boolean), JSON.stringify(tabIn));
  const shiftIn = [];
  for (let i = 0; i < 5; i++) { await page.keyboard.press('Shift+Tab'); shiftIn.push(await g.ev(() => document.getElementById('ui-pause-modal').contains(document.activeElement))); }
  check('Shift+Tab 으로 거꾸로 돌아도 화면 안에 머묾', shiftIn.every(Boolean), JSON.stringify(shiftIn));
  check('일시정지 화면에도 소리 켜기/끄기 버튼이 있고 눌림', await (async () => { const m0 = await g.ev(() => SFX.muted); await page.click('#ui-pause-mute'); const m1 = await g.ev(() => SFX.muted); await page.click('#ui-pause-mute'); return m1 === !m0 && (await g.ev(() => SFX.muted)) === m0; })());
  await page.keyboard.press('Escape');
  // 플레이 중 소리 버튼을 누른 뒤 포커스가 버튼에 남지 않음 (Space 가 게임으로 가게)
  await page.click('#ui-mute');
  check('플레이 중 소리 버튼을 누른 뒤 포커스가 그 버튼에 남지 않음', await g.ev(() => document.activeElement !== document.getElementById('ui-mute')));
  await page.click('#ui-mute');

  // 다시 시작 / 처음으로 는 한 번 더 눌러야 실행 (UI-02: 첫 클릭 직후의 빠른 두 번째 클릭은 무시 → 테스트에서는 기다림을 짧게 줄여 두고, 진짜 값(500ms)은 아래 따로 확인)
  await g.ev(() => { UI_TUNE.confirmGuardMs = 120; });
  const second = async sel => { await wait(160); await page.click(sel); };
  await g.ev(() => { T.started.length = 0; Game.nickname = '테스트'; });
  await page.click('#ui-pause');
  await page.click('#ui-restart');
  check('「다시 시작」 첫 클릭은 확인만 (아직 시작 안 함, 멈춘 채)', await g.ev(() => T.started.length === 0 && Game.paused) && /한 번 더/.test(await g.ev(() => document.getElementById('ui-restart').textContent)));
  await second('#ui-restart');
  const rs = await g.ev(() => ({ started: T.started, paused: Game.paused, scene: Game.scene }));
  check('두 번째 클릭에서 같은 난이도/닉네임으로 Stage.start, 일시정지 해제', rs.started.length === 1 && rs.started[0].difficulty === 'normal' && rs.started[0].nickname === '테스트' && !rs.paused && rs.scene === 'play', JSON.stringify(rs));
  await page.click('#ui-pause');
  await page.click('#ui-home');
  check('「처음으로」 첫 클릭은 확인만 (여전히 play 씬)', (await g.state()).scene === 'play');
  await page.click('#ui-restart');             // 다른 버튼을 누르면 확인이 풀림
  check('다른 버튼을 누르면 이전 확인 문구가 원래대로', /처음으로/.test(await g.ev(() => document.getElementById('ui-home').textContent)));
  await page.click('#ui-home'); await second('#ui-home');
  s = await g.state();
  check('「처음으로」 두 번 → 타이틀 씬, 일시정지 해제, 타이틀 화면 보임, 일시정지 화면 닫힘', s.scene === 'title' && !s.paused && s.titleVisible && !s.pauseVisible && ((await g.ev(() => T.music.slice(-1)[0])) === 'title'), JSON.stringify(s));

  // 타이틀/결과에서는 blur 로 멈추지 않음
  await g.ev(() => Events.emit('windowBlur'));
  check('타이틀에서는 blur 로 일시정지하지 않음', !(await g.state()).paused);
  // 타이틀에서 Esc/P 는 아무 일도 없음
  await page.keyboard.press('Escape'); await page.keyboard.press('KeyP');
  check('타이틀에서 Esc/P 는 일시정지 화면을 열지 않음', !(await g.state()).paused && !(await g.state()).pauseVisible);
  // 일시정지 확인 문구는 시간이 지나면 원래대로
  await toPlay(g);
  await g.ev(() => { UI_TUNE.confirmMs = 300; Game.pause(true); });
  await page.click('#ui-restart');
  await wait(500);
  check('확인 문구는 시간이 지나면 자동으로 원래대로 (실수 방지가 영원히 남지 않음)', /다시 시작/.test(await g.ev(() => document.getElementById('ui-restart').textContent)) && !/한 번 더/.test(await g.ev(() => document.getElementById('ui-restart').textContent)));
  await g.shot('pause');
  await g.done('일시정지');
});

// ===========================================================================
// 3. 결과 화면
// ===========================================================================
const RES = (o = {}) => ({ cleared: true, score: 52340, stars: 3, timeFrames: 11000, kills: 24, deaths: 0, maxCombo: 23, difficulty: 'normal', stageId: 'stage1', stageName: '사탕 숲', rooms: 5, ...o });
const toResult = (g, res) => g.ev(res => { Game.nickname = '하늘'; Game.difficulty = res.difficulty || 'normal'; Game.result = res; Game.setScene('result'); }, res);
const resInfo = g => g.ev(() => ({
  title: document.querySelector('.res-title').textContent, msg: document.querySelector('.res-msg').textContent,
  on: document.querySelectorAll('.star.on').length, stars: document.querySelectorAll('.star').length,
  total: document.querySelector('.total b').textContent, badge: !document.querySelector('.res-sub-row .badge').hidden,
  stat: [...document.querySelectorAll('.stat-grid li')].map(l => l.textContent).join('|'),
  save: document.querySelector('.save').dataset.state, saveText: document.querySelector('.save-text').textContent,
  retryVisible: !document.getElementById('ui-retry').hidden && !!document.getElementById('ui-retry').offsetWidth,
  rows: [...document.querySelectorAll('#ui-result .rank-row')].map(r => ({ rank: r.dataset.rank, me: r.dataset.me, cls: r.className, text: r.textContent })),
  rankStatus: document.querySelector('#ui-result .rank-status').textContent,
  sfx: T.sfx.slice(), saves: T.saves.length,
}));

await section('결과: 클리어 3별', async () => {
  const g = await fresh();
  const { page } = g;
  await toResult(g, RES());
  let r = await resInfo(g);
  check('결과 씬이 되면 결과 화면이 보이고 타이틀은 숨음', (await g.state()).resultVisible && !(await g.state()).titleVisible);
  check('클리어 제목', r.title.includes('클리어'), r.title);
  check('열리자마자 Server.saveScore 를 정확한 값으로 부름 (nickname/score/stageId/difficulty/stars/cleared/timeSec)', await g.ev(() => {
    const p = T.saves[0]; return T.saves.length === 1 && p.nickname === '하늘' && p.score === 52340 && p.stageId === 'stage1' && p.difficulty === 'normal' && p.stars === 3 && p.cleared === true && p.timeSec === Math.round(11000 / 60);
  }), JSON.stringify(await g.ev(() => T.saves)));
  check('저장 중 상태 문구 (저장 중…)', r.save === 'saving' && r.saveText.includes('저장 중'), r.saveText);
  check('처음에는 별이 하나도 안 켜져 있고(순서대로 팝), 소리도 아직', r.on === 0 && !r.sfx.includes('star'));
  check('클리어 팡파르(clear)는 stage 가 이미 울리므로 UI 는 다시 울리지 않음 (겹침 방지)', !r.sfx.includes('clear'));
  // 별이 하나씩 팝: 첫 별 시점 직전 → 0, 직후 → 1 ...
  const T0 = await g.ev(() => UI_TUNE.result);
  await step(page, T0.startDelay - 1);
  check('첫 별 직전에는 0개', (await resInfo(g)).on === 0);
  await step(page, 1);
  r = await resInfo(g);
  check('첫 별이 켜지고 효과음 star 한 번', r.on === 1 && r.sfx.filter(x => x === 'star').length === 1);
  await step(page, T0.starGap - 1);
  check('두 번째 별 직전에는 아직 1개', (await resInfo(g)).on === 1);
  await step(page, 1);
  r = await resInfo(g);
  check('두 번째 별', r.on === 2 && r.sfx.filter(x => x === 'star').length === 2);
  await step(page, T0.starGap);
  r = await resInfo(g);
  check('세 번째 별 → 3개 모두 켜짐, star 소리 3번', r.on === 3 && r.sfx.filter(x => x === 'star').length === 3, JSON.stringify([r.on, r.sfx]));
  check('별 상태가 접근성 라벨로 알려짐 (별 3개 중 3개)', await g.ev(() => document.querySelector('.stars').getAttribute('aria-label') === '별 3개 중 3개' && document.querySelector('.stars').dataset.shown === '3'));
  check('별 팝 위치에서 입자(FX)가 터짐', await g.ev(() => FX.particles.length > 0));
  await step(page, 200);
  r = await resInfo(g);
  check('점수는 세어 올라가 최종값(52,340)에서 멈춤', r.total === '52,340', r.total);
  check('Game.result 필드가 화면에 반영됨 (처치 24마리, 최고 콤보 23 HIT, 쓰러짐 0번, 시간 3분 3초)', ['24마리', '23 HIT', '0번', '3분 3초'].every(t => r.stat.includes(t)), r.stat);
  check('무사망 클리어 뱃지가 보임', r.badge);
  check('격려 문구는 3별 문구 중 하나', await g.ev(() => UI_TUNE.clearMsgs[3].includes(document.querySelector('.res-msg').textContent)), r.msg);
  // 저장 → 저장됨
  await g.ev(() => T.saveCbs[0].res({ ok: true, source: 'server', rank: 3 }));
  await wait(120);
  r = await resInfo(g);
  check('저장 성공(server) → "저장됐어요!"', r.save === 'saved' && r.saveText.includes('저장됐어요'), r.saveText);
  check('저장이 끝나면 Server.getTopScores(10) 로 랭킹을 가져옴', await g.ev(() => T.ranks.length === 1 && T.ranks[0] === 10));
  check('랭킹 4줄이 표시되고 순서가 유지됨', r.rows.length === 4 && r.rows.map(x => x.rank).join() === '1,2,3,4', JSON.stringify(r.rows.map(x => x.rank)));
  check('내 닉네임(하늘) 줄만 강조됨 (me 클래스 + 「나」 표시)', r.rows.filter(x => x.me === '1').length === 1 && r.rows.find(x => x.me === '1').text.includes('하늘') && r.rows.find(x => x.me === '1').text.includes('나') && r.rows.filter(x => x.cls.includes('me')).length === 1);
  check('랭킹 줄에 점수가 천 단위 쉼표로, 별/난이도가 보임', r.rows[0].text.includes('98,765') && r.rows[0].text.includes('어려움') && r.rows[0].text.includes('★★★'), r.rows[0].text);
  await g.shot('result_3star');
  // 버튼
  await g.ev(() => { T.started.length = 0; });
  await page.click('#ui-again');
  check('「다시 하기」 → 같은 난이도/닉네임으로 Stage.start', await g.ev(() => T.started.length === 1 && T.started[0].difficulty === 'normal' && T.started[0].nickname === '하늘' && Game.scene === 'play'), JSON.stringify(await g.ev(() => T.started)));
  check('다시 시작하면 결과 화면이 닫히고 음악이 stage 로', !(await g.state()).resultVisible && (await g.ev(() => T.music.slice(-1)[0])) === 'stage');
  await toResult(g, RES());
  await page.click('#ui-toTitle');
  const s = await g.state();
  check('「처음으로」 → 타이틀 씬 + 타이틀 화면, 결과 화면 닫힘', s.scene === 'title' && s.titleVisible && !s.resultVisible);
  await g.done('결과 3별');
});

await section('결과: 막 떴을 때 Space/Enter 연타로 버튼이 눌리지 않음', async () => {
  const g = await fresh();
  const { page } = g;
  await g.ev(() => { UI_TUNE.result.keyLockMs = 500; });
  await toPlay(g);
  await toResult(g, RES({ cleared: false, stars: 0, deaths: 3 }));
  check('(전제) 결과 화면이 열리고 「다시 하기」에 포커스', (await g.state()).resultVisible && (await g.ev(() => document.activeElement.id)) === 'ui-again');
  await page.keyboard.press('Space'); await page.keyboard.press('Enter'); await page.keyboard.press('Space');
  await step(page, 3);
  check('결과가 뜬 직후의 Space/Enter(공격 연타)는 「다시 하기」를 누르지 않음 → 아직 결과 화면', (await g.state()).scene === 'result' && (await g.ev(() => T.started.length)) === 0);
  check('그 사이에 눌린 Space 가 공격 입력으로 새지도 않음', await g.ev(() => !Input.isDown('KeyZ')));
  await wait(650);
  await page.keyboard.press('Space');
  await step(page, 3);
  check('잠깐 지나면 Space 로도 「다시 하기」가 눌림 (키보드로 조작 가능)', (await g.state()).scene === 'play' && (await g.ev(() => T.started.length)) === 1);
  // 마우스/터치 클릭은 바로 눌려야 함 (잠금은 키보드 연타만 막음)
  await toResult(g, RES());
  await page.click('#ui-toTitle');
  await step(page, 2);
  check('마우스 클릭은 잠금 없이 바로 동작 (「처음으로」)', (await g.state()).scene === 'title');
  await g.done('결과 키 잠금');
});

await section('결과: 2별 / 1별 / 게임 오버', async () => {
  const g = await fresh();
  const { page } = g;
  const T0 = await g.ev(() => UI_TUNE.result);
  const frames = T0.startDelay + 3 * T0.starGap + 120;
  await g.ev(() => { T.sfx.length = 0; });
  await toResult(g, RES({ stars: 2, deaths: 2, score: 31000, difficulty: 'hard' }));
  await step(page, frames);
  let r = await resInfo(g);
  check('2별: 정확히 2개만 켜지고 3번째는 꺼진 채', r.on === 2 && r.stars === 3 && r.sfx.filter(x => x === 'star').length === 2, JSON.stringify([r.on, r.sfx]));
  check('2별: 무사망 뱃지는 없음 (쓰러진 적 있음)', !r.badge);
  check('2별 격려 문구', await g.ev(() => UI_TUNE.clearMsgs[2].includes(document.querySelector('.res-msg').textContent)), r.msg);
  check('난이도(어려움)가 부제에 표시됨', await g.ev(() => document.querySelector('.res-sub').textContent.includes('어려움')));
  check('2별에서도 다시 하기는 결과의 난이도(hard)로', await (async () => { await g.ev(() => { T.started.length = 0; }); await page.click('#ui-again'); return g.ev(() => T.started[0] && T.started[0].difficulty === 'hard'); })());

  await g.ev(() => { T.sfx.length = 0; });
  await toResult(g, RES({ stars: 1, deaths: 5, score: 9000 }));
  await step(page, frames);
  r = await resInfo(g);
  check('1별: 정확히 1개', r.on === 1 && r.sfx.filter(x => x === 'star').length === 1);

  // 게임 오버
  await g.ev(() => { T.sfx.length = 0; });
  await toResult(g, RES({ cleared: false, stars: 0, deaths: 3, score: 8120, kills: 6, maxCombo: 5, rooms: 2 }));
  await step(page, frames);
  r = await resInfo(g);
  check('게임 오버: 제목이 "아쉬워요!"', r.title.includes('아쉬워요') && !r.title.includes('클리어'), r.title);
  check('게임 오버: 별이 하나도 켜지지 않고 star 소리도 없음', r.on === 0 && !r.sfx.includes('star'));
  check('게임 오버: 격려 문구 (overMsgs 중 하나, 비난 아님)', await g.ev(() => UI_TUNE.overMsgs.includes(document.querySelector('.res-msg').textContent)), r.msg);
  check('게임 오버 효과음(gameover) 이 한 번 나고 clear 는 아님', r.sfx.filter(x => x === 'gameover').length === 1 && !r.sfx.includes('clear'));
  check('게임 오버: 무사망 뱃지 없음, 다시 하기/처음으로 버튼이 보임', !r.badge && await g.ev(() => !!document.getElementById('ui-again').offsetWidth && !!document.getElementById('ui-toTitle').offsetWidth));
  check('게임 오버에서도 점수는 저장 요청됨 (cleared:false, stars:0)', await g.ev(() => { const p = T.saves[T.saves.length - 1]; return p.cleared === false && p.stars === 0 && p.score === 8120; }));
  check('게임 오버: 점수 8,120 표시', r.total === '8,120', r.total);
  check('게임 오버: 지나온 방/쓰러짐 등 통계 표시', r.stat.includes('3번') && r.stat.includes('6마리') && r.stat.includes('2개'), r.stat);
  await g.shot('result_gameover');
  // Game.result 가 비어 있어도 죽지 않음
  await g.ev(() => { Game.result = null; Game.setScene('title'); Game.setScene('result'); });
  await step(page, 10);
  check('Game.result 가 null 이어도 결과 화면이 열림 (오류 없음)', (await g.state()).resultVisible);
  await g.done('결과 게임오버');
});

await section('결과: 저장 상태(저장중→기기에만/실패→재시도)와 랭킹 예외', async () => {
  const g = await fresh();
  const { page } = g;
  await toResult(g, RES());
  await g.ev(() => T.saveCbs[0].res({ ok: true, source: 'local' }));
  await wait(100);
  let r = await resInfo(g);
  check('저장 결과가 local → "내 기기에만 저장됐어요"', r.save === 'local' && r.saveText.includes('내 기기에만'), r.saveText);
  check('local 일 때 재시도 버튼은 없음', !r.retryVisible);

  await toResult(g, RES());
  await g.ev(() => T.saveCbs[T.saveCbs.length - 1].rej(new Error('network')));
  await wait(100);
  r = await resInfo(g);
  check('저장 실패(reject) → 실패 문구 + 「다시 시도」 버튼', r.save === 'failed' && r.saveText.includes('실패') && r.retryVisible, r.saveText);
  check('저장이 실패해도 랭킹은 보여줌', r.rows.length === 4);
  const before = r.saves;
  await page.click('#ui-retry');
  r = await resInfo(g);
  check('「다시 시도」 → saveScore 를 한 번 더 부르고 다시 "저장 중"', r.saves === before + 1 && r.save === 'saving' && !r.retryVisible, JSON.stringify([r.saves, r.save]));
  await g.ev(() => T.saveCbs[T.saveCbs.length - 1].res({ ok: true, source: 'server' }));
  await wait(100);
  check('재시도 성공 → 저장됨', (await resInfo(g)).save === 'saved');

  // ok:false 도 실패로
  await toResult(g, RES());
  await g.ev(() => T.saveCbs[T.saveCbs.length - 1].res({ ok: false }));
  await wait(80);
  check('응답이 ok:false 면 실패로 취급', (await resInfo(g)).save === 'failed');

  // 응답이 영영 안 오면 시간 제한 뒤 실패
  await g.ev(() => { UI_TUNE.saveTimeoutMs = 300; });
  await toResult(g, RES());
  check('응답 대기 중에는 "저장 중"', (await resInfo(g)).save === 'saving');
  await wait(450);
  check('응답이 너무 늦으면 실패 + 재시도 버튼 (영원히 "저장 중"에 갇히지 않음)', (await resInfo(g)).save === 'failed' && (await resInfo(g)).retryVisible);
  await g.ev(() => { UI_TUNE.saveTimeoutMs = 12000; });

  // 늦게 도착한 이전 결과의 응답이 새 결과 화면을 덮어쓰지 않음
  await toResult(g, RES());
  const idxA = await g.ev(() => T.saveCbs.length - 1);
  await g.ev(() => Game.setScene('title'));
  await toResult(g, RES());
  const idxB = await g.ev(() => T.saveCbs.length - 1);
  await g.ev(i => T.saveCbs[i].res({ ok: true, source: 'server' }), idxA);
  await wait(80);
  check('이전 결과의 늦은 응답은 무시됨 (여전히 저장 중)', (await resInfo(g)).save === 'saving');
  await g.ev(i => T.saveCbs[i].res({ ok: true, source: 'local' }), idxB);
  await wait(80);
  check('현재 결과의 응답만 반영됨', (await resInfo(g)).save === 'local');

  // 랭킹 예외들
  await g.ev(() => { Server.getTopScores = () => Promise.reject(new Error('x')); });
  await toResult(g, RES());
  await g.ev(() => T.saveCbs[T.saveCbs.length - 1].res({ ok: true, source: 'server' }));
  await wait(100);
  r = await resInfo(g);
  check('랭킹을 못 불러오면 친절한 안내 문구 (목록은 비어 있음)', r.rows.length === 0 && r.rankStatus.length > 0, r.rankStatus);
  await g.ev(() => { Server.getTopScores = () => Promise.resolve([]); });
  await toResult(g, RES());
  await g.ev(() => T.saveCbs[T.saveCbs.length - 1].res({ ok: true, source: 'server' }));
  await wait(100);
  r = await resInfo(g);
  check('랭킹이 비어 있으면 첫 주인공 안내', r.rows.length === 0 && r.rankStatus.includes('아직 기록'), r.rankStatus);
  await g.ev(() => { Server.getTopScores = () => Promise.resolve([{ rank: 1, nickname: '<img src=x onerror=window.__xss=1>', score: 5, stars: 9, difficulty: 'zzz' }, null, { nickname: '하늘', score: 'abc' }]); });
  await toResult(g, RES());
  await g.ev(() => T.saveCbs[T.saveCbs.length - 1].res({ ok: true, source: 'server' }));
  await wait(120);
  check('서버가 준 닉네임은 글자로만 표시됨 (HTML 로 해석되지 않음)', await g.ev(() => !document.querySelector('#ui-result img') && document.querySelector('#ui-result .rank-nick').textContent.includes('<img') && !window.__xss));
  check('이상한 값(stars:9, null 줄, score:"abc")에도 죽지 않고 줄이 그려짐', (await resInfo(g)).rows.length === 3);
  // Server 가 아예 없어도 (스텁) 죽지 않음 → 저장 실패로 표시
  await g.ev(() => { delete Server.saveScore; delete Server.getTopScores; });
  await toResult(g, RES());
  await wait(80);
  r = await resInfo(g);
  check('Server.saveScore 가 없으면 "저장 실패"로 정직하게 표시 (죽지 않음)', r.save === 'failed' && r.retryVisible);
  await g.done('저장 상태');
});

// ===========================================================================
// 4. HUD (캔버스) — 던지지 않고, 값을 정확히 보여주는지 픽셀로 확인
// ===========================================================================
await section('HUD: 어떤 상태에서도 오류 없이 그려짐', async () => {
  const g = await fresh();
  await toPlay(g);
  const res = await g.ev(() => {
    const out = [], c = Loop.canvas, ctx = c.getContext('2d');
    const tryDraw = (name, setup) => {
      try {
        setup && setup();
        ctx.setTransform(Loop.dpr, 0, 0, Loop.dpr, 0, 0); ctx.globalAlpha = 1; ctx.clearRect(0, 0, c.width, c.height);
        UI.drawHUD(ctx);
        const tr = ctx.getTransform(), balanced = Math.abs(tr.a - Loop.dpr) < 1e-9 && tr.b === 0 && tr.c === 0 && Math.abs(tr.d - Loop.dpr) < 1e-9 && tr.e === 0 && tr.f === 0 && ctx.globalAlpha === 1;
        out.push([name, true, balanced]);
      } catch (e) { out.push([name, false, String(e && e.message)]); }
    };
    const P = Game.player;
    tryDraw('기본', null);
    tryDraw('플레이어 없음', () => { Game.player = null; });
    tryDraw('플레이어 skills 없음', () => { Game.player = { hp: 10, maxHp: 100 }; });
    tryDraw('플레이어 hp NaN/maxHp 0', () => { Game.player = { hp: NaN, maxHp: 0, skills: [] }; });
    tryDraw('skills 이상한 값', () => { Game.player = { hp: 50, maxHp: 100, skills: [{ cd: -5, cdMax: 0 }, { cd: Infinity, cdMax: 10 }, null] }; });
    tryDraw('플레이어 사망', () => { Game.player = P; P.dead = true; P.hp = 0; });
    tryDraw('플레이어 부활', () => { P.dead = false; P.hp = P.maxHp; });
    tryDraw('목숨 Infinity(쉬움)', () => { Game.difficulty = 'easy'; Game.lives = Infinity; });
    tryDraw('목숨 0', () => { Game.difficulty = 'hard'; Game.lives = 0; });
    tryDraw('목숨 음수/NaN', () => { Game.lives = NaN; });
    tryDraw('목숨 3(보통)', () => { Game.difficulty = 'normal'; Game.lives = 3; });
    tryDraw('보스 있음', () => { Game.boss = { name: '젤리 대왕', hp: 150, maxHp: 300, boss: true }; });
    tryDraw('보스 hp 0', () => { Game.boss.hp = 0; });
    tryDraw('보스 hp 넘침/NaN', () => { Game.boss.hp = 999; });
    tryDraw('보스 maxHp 0', () => { Game.boss = { hp: 0, maxHp: 0 }; });
    tryDraw('보스 이름 없음', () => { Game.boss = { hp: 5, maxHp: 10 }; });
    tryDraw('보스 사라짐', () => { Game.boss = null; });
    tryDraw('콤보 1', () => { Game.combo.count = 1; });
    tryDraw('콤보 큼', () => { Game.combo.count = 9999; Game.combo.timer = 90; });
    tryDraw('콤보 timer 음수', () => { Game.combo.count = 5; Game.combo.timer = -3; });
    tryDraw('콤보 끊김(ghost)', () => { Events.emit('comboChanged', { count: 5, max: 5 }); Events.emit('comboChanged', { count: 0, max: 5 }); Game.combo.count = 0; });
    tryDraw('점수 큼', () => { Game.score = 99999999; });
    tryDraw('점수 NaN/음수', () => { Game.score = NaN; });
    tryDraw('점수 음수', () => { Game.score = -5; });
    tryDraw('stage 비어 있음', () => { Game.stage = {}; });
    tryDraw('stage 방 많음', () => { Game.stage = { roomName: '아주아주아주아주아주 긴 방 이름입니다', roomIndex: 30, roomCount: 99 }; });
    tryDraw('stage roomIndex 음수', () => { Game.stage = { roomName: 'x', roomIndex: -3, roomCount: 5 }; });
    tryDraw('stage 없음', () => { Game.stage = null; });
    tryDraw('combo 없음', () => { const cb = Game.combo; Game.combo = undefined; Game.stage = { roomName: '', roomIndex: 0, roomCount: 0 }; try { UI.drawHUD(ctx); } finally { Game.combo = cb; } });
    tryDraw('터치 모드', () => { Game.touch = true; });
    tryDraw('조용히(reduceMotion)', () => { FX.reduceMotion = true; });
    tryDraw('playerHit 이벤트 직후', () => { FX.reduceMotion = false; Game.player = P; P.hp = 20; Events.emit('playerHit', { target: P, dmg: 5 }); });
    return out;
  });
  const bad = res.filter(r => !r[1]);
  check(`HUD 를 ${res.length}가지 상태(플레이어 없음/보스/목숨 ∞/이상한 값…)로 그려도 던지지 않음`, bad.length === 0, JSON.stringify(bad));
  const unbalanced = res.filter(r => r[1] && !r[2]);
  check('HUD 가 그린 뒤 캔버스 상태(변환/투명도)를 원래대로 돌려놓음 (save/restore 짝)', unbalanced.length === 0, JSON.stringify(unbalanced));
  await g.done('HUD 안전');
});

await section('HUD: 값이 정확히 그려짐 (HP·목숨·스킬·보스·위험 표시)', async () => {
  const g = await fresh();
  await toPlay(g);
  await g.ev(() => { FX.reduceMotion = true; Game.touch = false; Game.difficulty = 'normal'; Game.stage = { roomName: '', roomIndex: 0, roomCount: 0 }; Game.score = 0; Game.player.hp = Game.player.maxHp = 100; Game.player.skills.forEach(s => { s.cd = 0; }); });
  // HP 바: 초록 픽셀 수가 체력 비율에 비례
  const bar = hp => g.ev(hp => { Game.player.hp = hp; return PX.run([{ x: 64, y: 22, w: 234, h: 1, pred: 'fill' }])[0]; }, hp);
  const full = await bar(100), half = await bar(50), tenth = await bar(10), zero = await bar(0);
  check('HP 100% 에서 바가 거의 가득 참', full > 200, `fill px=${full}`);
  check('HP 50% 에서 바 채움이 절반 가까이', Math.abs(half / full - 0.5) < 0.12, `${half}/${full}`);
  check('HP 10% 에서는 훨씬 적음, 0% 에서는 비어 있음 (음성 확인)', tenth < half * 0.4 && zero === 0, `${tenth}, ${zero}`);
  // 체력이 낮을 때 색이 초록이 아니게(위험) — 초록 pixel 이 아니라 빨강
  const redBar = await g.ev(() => { Game.player.hp = 20; return PX.run([{ x: 64, y: 22, w: 234, h: 1, pred: 'red' }])[0]; });
  const greenBar = await g.ev(() => { Game.player.hp = 100; return PX.run([{ x: 64, y: 22, w: 234, h: 1, pred: 'red' }])[0]; });
  check('HP 20% 이하에서는 바가 빨간색 (가득 찬 초록 바에는 빨강이 없음)', redBar > 20 && greenBar === 0, `red px=${redBar}, at full=${greenBar}`);
  await g.ev(() => { Game.player.hp = 100; });
  // 목숨: 하트 수에 비례한 빨간 픽셀
  const hearts = (lives, diff = 'normal') => g.ev(([l, d]) => { Game.difficulty = d; Game.lives = l; return PX.run([{ x: 84, y: 56, w: 130, h: 32, pred: 'red' }])[0]; }, [lives, diff]);
  const h3 = await hearts(3), h2 = await hearts(2), h1 = await hearts(1), h0 = await hearts(0);
  check('목숨 3 → 하트 3개 분량', h3 > 150, `${h3}`);
  check('목숨 2 → 3개의 2/3 정도', Math.abs(h2 / h3 - 2 / 3) < 0.12, `${h2}/${h3}`);
  check('목숨 1 → 1/3 정도', Math.abs(h1 / h3 - 1 / 3) < 0.12, `${h1}/${h3}`);
  check('목숨 0 → 빨간 하트가 없음 (빈 하트만)', h0 === 0, `${h0}`);
  const inf = await hearts(Infinity, 'easy');
  check('쉬움(목숨 ∞)은 하트 하나 + 무한대 기호 (하트 3개가 아님)', inf > 20 && inf < h3 * 0.5, `${inf} vs ${h3}`);
  const infSym = await g.ev(() => { Game.difficulty = 'easy'; Game.lives = Infinity; return PX.run([{ x: 122, y: 58, w: 40, h: 26, pred: 'solid' }])[0]; });
  check('무한대(∞) 기호가 실제로 그려짐', infSym > 40, `${infSym}`);
  await g.ev(() => { Game.difficulty = 'normal'; Game.lives = 3; });

  // 위험 표시: 모서리 번짐
  const corner = hp => g.ev(hp => { Game.player.hp = hp; Game.player.dead = false; return PX.alphaAt(3, 3); }, hp);
  check('체력이 충분하면 화면 가장자리에 붉은 번짐 없음', (await corner(100)) === 0);
  const aLow = await corner(15);
  check('체력이 30% 이하이면 가장자리가 은은하게 붉어짐 (투명하지 않되 진하지 않음)', aLow > 8 && aLow < 120, `alpha=${aLow}`);
  check('체력 0(쓰러짐)이면 위험 표시를 끔', await g.ev(() => { Game.player.hp = 0; Game.player.dead = true; const a = PX.alphaAt(3, 3); Game.player.dead = false; return a === 0; }));
  const warnTxt = await g.ev(() => { Game.player.hp = 15; return PX.run([{ x: 240, y: 62, w: 70, h: 24, pred: 'yellow' }])[0]; });
  check('위험할 때 "위험!" 글자가 목숨 줄 오른쪽에 나타남 (색만으로 알리지 않음)', warnTxt > 10, `${warnTxt}`);
  check('체력이 충분하면 "위험!" 글자가 없음', await g.ev(() => { Game.player.hp = 100; return PX.run([{ x: 240, y: 62, w: 70, h: 24, pred: 'yellow' }])[0] === 0; }));
  await g.ev(() => { Game.player.hp = 100; });

  // 부드러운 숨쉬기: 프레임 사이 변화가 작고(깜빡임 없음), 상한이 낮음
  const pulse = await g.ev(() => {
    FX.reduceMotion = false; Game.player.hp = 15;
    const orig = performance.now.bind(performance); let t0 = 0, max = 0, maxStep = 0, last = null, min = 255;
    performance.now = () => t0;
    for (t0 = 0; t0 < 6000; t0 += 1000 / 60) { const a = PX.alphaAt(3, 3); max = Math.max(max, a); min = Math.min(min, a); if (last !== null) maxStep = Math.max(maxStep, Math.abs(a - last)); last = a; }
    performance.now = orig; Game.player.hp = 100;
    return { max, min, maxStep };
  });
  check('위험 표시는 천천히 숨 쉬듯 변함 (프레임 사이 변화 < 8/255, 번쩍임 아님)', pulse.maxStep < 8 && pulse.max > pulse.min, JSON.stringify(pulse));
  check('위험 표시의 최대 진하기는 낮음 (알파 < 130/255)', pulse.max < 130, JSON.stringify(pulse));
  const hit = await g.ev(() => {
    FX.reduceMotion = false; Game.player.hp = 100; const orig = performance.now.bind(performance); let t0 = 100000; performance.now = () => t0;
    Events.emit('playerHit', { target: Game.player, dmg: 5 });
    const samples = []; for (let i = 0; i < 40; i++) { t0 += 1000 / 60; samples.push(PX.alphaAt(3, 3)); }
    performance.now = orig; return samples;
  });
  check('맞았을 때 가장자리 붉은 번쩍은 한 번 나타났다 부드럽게 사라짐 (단조 감소, 24프레임 안에 끝)', hit[0] > 0 && hit.slice(0, 22).every((v, i, a) => i === 0 || v <= a[i - 1]) && hit[30] === 0 && Math.max(...hit) < 130, JSON.stringify(hit.slice(0, 26)));

  // 스킬 아이콘 (비터치): 준비됨은 노란 테두리, 쿨타임은 어둡게
  const skillBox = i => ({ x: 18 + i * 74, y: 106, w: 62, h: 62 });
  const yel = (cd) => g.ev(cd => { Game.touch = false; Game.player.skills[0].cd = cd; return PX.run([{ ...{ x: 18, y: 106, w: 62, h: 62 }, pred: 'yellow' }])[0]; }, cd);
  const ready = await yel(0), cool = await yel(300);
  check('스킬이 준비되면 노란 테두리/반짝이가 그려짐, 쿨타임 중에는 없음', ready > 60 && cool < ready * 0.3, `${ready} vs ${cool}`);
  const strip = (cd, side) => g.ev(([cd, side]) => { Game.player.skills[0].cd = cd; return PX.avg({ x: side === 'L' ? 21 : 18 + 62 - 17, y: 106 + 22, w: 13, h: 34 }); }, [cd, side]);
  const L0 = await strip(0, 'L'), L150 = await strip(150, 'L'), L300 = await strip(300, 'L'), R0 = await strip(0, 'R'), R150 = await strip(150, 'R'), R300 = await strip(300, 'R');
  check('쿨타임 부채꼴(왼쪽 띠): 준비됨은 밝고, 절반/가득 쿨타임은 어두움', L0 > L150 + 15 && L0 > L300 + 15, `${L0.toFixed(0)}, ${L150.toFixed(0)}, ${L300.toFixed(0)}`);
  check('쿨타임 부채꼴은 맨 위에서 시계 방향으로 걷힘: 절반 지났을 때 오른쪽(먼저 걷힌 쪽)은 왼쪽보다 밝고, 가득이면 오른쪽도 어두움', R150 > L150 + 40 && R150 > R300 + 40, `L150=${L150.toFixed(0)} R150=${R150.toFixed(0)} R300=${R300.toFixed(0)}`);
  check('스킬 3개가 모두 그려짐 (각 칸에 불투명 픽셀)', await g.ev(() => { Game.player.skills.forEach(s => { s.cd = 0; }); return PX.run([0, 1, 2].map(i => ({ x: 18 + i * 74, y: 106, w: 62, h: 62, pred: 'solid' }))).every(n => n > 1500); }));
  check('터치 기기(Game.touch, 화면을 만진 뒤)에서는 캔버스 스킬 칸을 그리지 않음 (DOM 터치 버튼이 대신함)', await g.ev(() => { window.dispatchEvent(new Event('touchstart')); Game.touch = true; const n = PX.run([{ x: 18, y: 106, w: 62, h: 62, pred: 'solid' }])[0]; Game.touch = false; return n === 0; }));

  // 보스 체력바
  const bossPx = () => g.ev(() => PX.run([{ x: 250, y: 140, w: 460, h: 26, pred: 'solid' }])[0]);
  check('보스가 없으면 보스 체력바 영역이 비어 있음', (await bossPx()) === 0);
  await g.ev(() => { Game.boss = { name: '젤리 대왕', hp: 300, maxHp: 300, boss: true }; FX.reduceMotion = true; });
  const b100 = await g.ev(() => PX.run([{ x: 252, y: 142, w: 456, h: 18, pred: 'solid' }])[0]);
  check('보스가 나오면 체력바가 그려짐', b100 > 5000, `${b100}`);
  // 보스 채움 폭 측정: 채움 색은 분홍 #ff8ad8 또는 빨강 #ff6b6b (r 이 높고 g 가 낮음)
  const fillW = hp => g.ev(hp => {
    Game.boss.hp = hp; Game.boss.maxHp = 300;
    for (let i = 0; i < 400; i++) PX.draw();                                  // 따라 내려오는 노란 바가 끝까지 내려오게
    const ctx = PX.draw(), d = ctx.getImageData(254 * Loop.dpr, 156 * Loop.dpr, 452 * Loop.dpr, 1).data; let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200 && d[i] > 230 && d[i + 1] < 160 && d[i + 2] > 80) n++;
    return n;
  }, hp);
  const f100 = await fillW(300), f50 = await fillW(150), f10 = await fillW(30);
  check('보스 체력 50% 일 때 체력바 채움이 절반 가까이', f100 > 300 && Math.abs(f50 / f100 - 0.5) < 0.1, `${f50}/${f100}`);
  check('보스 체력 10% 에서는 더 적음', f10 < f50 * 0.4, `${f10}`);
  await g.ev(() => { Game.boss = null; });
  check('보스가 사라지면 체력바도 사라짐', (await bossPx()) === 0);
  await g.ev(() => { Game.boss = { hp: 0, maxHp: 0 }; });
  check('maxHp 가 0 인 이상한 보스는 "NaN%" 같은 깨진 바를 그리지 않고 아무것도 그리지 않음', (await bossPx()) === 0);
  await g.ev(() => { Game.boss = null; });

  // HUD 는 바닥 띠(y 330~500, 캐릭터와 공격 예고 마커가 있는 곳)를 가리지 않음 — 통합 점검에서 보스 체력바·스킬 칸이 발밑 마커를 가리는 것을 찾아 위로 옮겼어요
  const floorCover = await g.ev(() => {
    Game.touch = false; FX.reduceMotion = true;
    Game.player.skills.forEach(s => { s.cd = 0; }); Game.combo.count = 66; Game.combo.timer = 90; Game.score = 987654; Game.lives = 3;
    Game.boss = { name: '젤리 대왕', hp: 120, maxHp: 300, boss: true };
    for (let i = 0; i < 400; i++) PX.draw();                                   // 보스 체력바가 다 내려오고 노란 지연 바도 따라오게
    const states = {};
    const probe = tag => { states[tag] = PX.run([{ x: 0, y: 330, w: 960, h: 170, pred: 'solid' }])[0]; };
    probe('boss+combo');
    Game.player.hp = 12; probe('low-hp');
    Game.player.skills[0].cd = 150; Game.player.skills[2].cd = 1800; probe('cooldowns');
    Game.boss = null; Game.combo.count = 0; probe('calm');
    return { states };
  });
  check('HUD(스킬 칸·보스 체력바·콤보·점수·체력판)가 바닥 띠(y 330~500)에 불투명 픽셀을 하나도 그리지 않음', Object.values(floorCover.states).every(n => n === 0), JSON.stringify(floorCover.states));
  await g.ev(() => { Game.boss = { name: '젤리 대왕', hp: 300, maxHp: 300, boss: true }; for (let i = 0; i < 400; i++) PX.draw(); });
  check('(측정 확인) 보스가 있을 때 위쪽 체력바 자리에는 불투명 픽셀이 있음', (await g.ev(() => PX.run([{ x: 240, y: 100, w: 480, h: 70, pred: 'solid' }])[0])) > 5000);
  await g.ev(() => { Game.boss = null; });
  // HUD 판끼리도 겹치지 않음: 체력판은 y 8~94 (x 10~314). 보스 체력바 카드는 그 아래(bossBarY-40 ≥ 94), 스킬 칸은 키 배지(위로 9px)까지 그 아래
  const lay = await g.ev(() => ({ bossTop: UI_TUNE.hud.bossBarY - 40, skillTop: UI_TUNE.hud.skillTop }));
  check('보스 체력바 카드가 체력판(y~94) 아래에서 시작하고 바닥 띠(330) 위에서 끝남', lay.bossTop >= 94 && lay.bossTop + 76 <= 330, JSON.stringify(lay));
  check('스킬 칸(키 배지 포함)이 체력판 아래에서 시작하고 바닥 띠(330) 위에서 끝남', lay.skillTop - 9 >= 94 && lay.skillTop + 62 <= 330, JSON.stringify(lay));

  // 점수판이 오른쪽 위 DOM 버튼과 겹치지 않음
  const inset = await g.ev(() => {
    Game.score = 123456; const e = document.getElementById('ui-pause'), c = document.getElementById('game').getBoundingClientRect(), u = c.width / W;
    UI.resize(); const left = (e.getBoundingClientRect().left - c.left) / u; const s = UI.state().hudInset;
    return { left, xr: W - s };
  });
  check('점수판 오른쪽 끝이 일시정지 버튼 왼쪽보다 안쪽 (겹치지 않음)', inset.xr <= inset.left, JSON.stringify(inset));
  await g.shot('hud_fake_play');
  await g.done('HUD 값');
});

await section('HUD: 콤보 · 점수 · 방 진행도', async () => {
  const g = await fresh();
  await toPlay(g);
  await g.ev(() => { FX.reduceMotion = true; Game.touch = false; Game.stage = { roomName: '', roomIndex: 0, roomCount: 0 }; });
  const combo = n => g.ev(n => { Game.combo.count = n; Game.combo.timer = 60; return PX.run([{ x: 760, y: 90, w: 190, h: 90, pred: 'solid' }])[0]; }, n);
  const c0 = await combo(0), c1 = await combo(1), c2 = await combo(2), c10 = await combo(10), c30 = await combo(30);
  check('콤보 0/1 에서는 콤보 표시가 없음 (2 부터 "N HIT!")', c0 === 0 && c1 === 0, `${c0}, ${c1}`);
  check('콤보 2 부터 표시됨', c2 > 300, `${c2}`);
  check('콤보가 쌓일수록 글자가 커짐 (2 < 10 < 30)', c10 > c2 && c30 > c10, `${c2} < ${c10} < ${c30}`);
  await g.ev(() => { Game.combo.count = 0; });
  // 방 진행도 점: 현재(노랑) 위치가 방 번호를 따라감. 방 수는 하드코딩하지 않아요 — Game.stage.roomCount (진짜 스테이지는 STAGES[0].rooms.length) 를 그대로 따라 그려야 해요.
  //   (캔버스 백버퍼는 창 크기에 따라 1.33배·1.5배… 가 될 수 있어서 getImageData 좌표에 Loop.dpr 을 곱해요)
  const dots = (idx, n) => g.ev(([idx, n]) => {
    Game.stage = { roomName: '방', roomIndex: idx, roomCount: n };
    const ctx = PX.draw(), d = Loop.dpr, out = [];
    for (let i = 0; i < n; i++) {
      const x = 480 + (i - (n - 1) / 2) * 24, im = ctx.getImageData(Math.round((x - 3) * d), Math.round(55 * d), Math.max(1, Math.round(7 * d)), Math.max(1, Math.round(7 * d))).data;
      let y = 0; for (let k = 0; k < im.length; k += 4) if (im[k + 3] > 200 && im[k] > 230 && im[k + 1] > 190 && im[k + 2] < 120) y++;
      out.push(y);
    }
    return out;
  }, [idx, n]);
  const realRooms = await g.ev(() => (typeof STAGES !== 'undefined' && STAGES[0] && STAGES[0].rooms.length) || 5);
  for (const n of [...new Set([3, realRooms, 9])]) {
    const first = await dots(0, n), mid = await dots(Math.floor(n / 2), n), last = await dots(n - 1, n);
    const only = (arr, i) => arr[i] > 10 && arr.filter((v, j) => j !== i).every(v => v === 0);
    check(`방 진행도(방 ${n}개${n === realRooms ? ' = 진짜 STAGES[0].rooms.length' : ''}): 노란 점은 현재 방 하나뿐이고 방 번호를 따라 이동 (처음/가운데/마지막)`, only(first, 0) && only(mid, Math.floor(n / 2)) && only(last, n - 1), JSON.stringify([first, mid, last]));
  }
  check('방 진행도: 점의 개수가 roomCount 를 따름 (3개일 때 점 3개 / 9개일 때 9개 — 5 로 굳어 있지 않음)', await g.ev(() => {
    const count = n => {                                                          // 마지막 방이면 앞의 점은 민트(지나온 방), 마지막이 노랑 → 한 줄을 훑어 색 덩어리를 센다
      Game.stage = { roomName: '방', roomIndex: n - 1, roomCount: n };
      const ctx = PX.draw(), d = Loop.dpr, w = Math.round(960 * d), im = ctx.getImageData(0, Math.round(58 * d), w, 1).data;
      let runs = 0, len = 0;
      for (let x = 0; x <= w; x++) {
        const k = x * 4, colored = x < w && im[k + 3] > 200 && ((im[k] > 230 && im[k + 1] > 190 && im[k + 2] < 120) || (im[k] > 100 && im[k] < 150 && im[k + 1] > 200 && im[k + 2] > 120 && im[k + 2] < 170));
        if (colored) len++; else { if (len >= 3) runs++; len = 0; }
      }
      return runs;
    };
    return count(3) === 3 && count(9) === 9;
  }));
  check('방 이름이 없고 방 수도 0이면 방 표시를 그리지 않음', await g.ev(() => { Game.stage = { roomName: '', roomIndex: 0, roomCount: 0 }; return PX.run([{ x: 340, y: 4, w: 260, h: 70, pred: 'solid' }])[0] === 0; }));
  // 점수 올라가는 연출: 점수가 바뀌면 곧 새 숫자에 도달
  const s = await g.ev(() => {
    Game.score = 0; for (let i = 0; i < 10; i++) PX.draw(); const a = PX.run([{ x: 640, y: 10, w: 200, h: 56, pred: 'solid' }])[0];
    FX.reduceMotion = false; Game.score = 99999; for (let i = 0; i < 80; i++) PX.draw(); const b = PX.run([{ x: 640, y: 10, w: 200, h: 56, pred: 'solid' }])[0]; return { a, b };
  });
  check('점수판이 그려지고 숫자가 늘면 더 많은 글자가 그려짐', s.a > 500 && s.b > s.a, JSON.stringify(s));
  await g.done('HUD 콤보');
});

// ===========================================================================
// 5. 휴식 알림 / 토스트
// ===========================================================================
await section('휴식 알림과 토스트', async () => {
  const g = await fresh();
  const { page } = g;
  await g.ev(() => { CFG.breakReminderMinutes = 0.01; UI.resetBreakTimer(); });        // 0.6초 = 36틱
  await step(page, 100);
  check('타이틀에서 흐른 시간은 휴식 시간으로 세지 않음', (await g.state()).playTicks === 0 && (await g.ev(() => document.querySelectorAll('.toast').length)) === 0);
  await toPlay(g);
  await step(page, 35);
  check('play 35틱: 아직 알림 없음 (기준 36틱)', (await g.ev(() => document.querySelectorAll('.toast').length)) === 0 && (await g.state()).playTicks === 35);
  await step(page, 2);
  const msg = '잠깐 쉬어요! 눈과 손을 풀어 볼까요? 🙆';
  check('기준을 넘으면 휴식 알림 토스트가 정확한 문구로 한 번 뜸', await g.ev(m => [...document.querySelectorAll('.toast')].filter(t => t.textContent === m).length === 1, msg), await g.ev(() => [...document.querySelectorAll('.toast')].map(t => t.textContent).join('|')));
  await step(page, 20);
  check('같은 구간에서 중복으로 뜨지 않음', (await g.ev(() => document.querySelectorAll('.toast').length)) === 1);
  await g.ev(() => Game.pause(true));
  const t1 = (await g.state()).playTicks;
  await step(page, 200);
  check('일시정지 중에는 시간이 세어지지 않음', (await g.state()).playTicks === t1);
  await g.ev(() => Game.pause(false));
  await step(page, 40);
  check('한 번 더 기준 시간이 지나면 또 알림 (반복)', (await g.state()).breakMsgs === 2, String((await g.state()).breakMsgs));
  check('여러 판을 해도(Stage.start 후에도) 휴식 시간은 이어서 셈', await g.ev(() => { const before = UI.state().playTicks; Stage.start({ difficulty: 'normal', nickname: 'x' }); return UI.state().playTicks === before; }));
  await g.ev(() => { CFG.breakReminderMinutes = 30; });

  // 토스트 API
  await g.ev(() => { document.querySelectorAll('.toast').forEach(t => t.remove()); UI.toast('안녕!', 250); });
  check('UI.toast 가 화면에 알림을 만듦 (aria-live 영역 안)', await g.ev(() => { const t = document.querySelector('.toast'); return !!t && t.textContent === '안녕!' && !!t.closest('[aria-live]'); }));
  await wait(900);
  check('UI.toast 는 시간이 지나면 사라짐', (await g.ev(() => document.querySelectorAll('.toast').length)) === 0);
  await g.ev(() => { for (let i = 0; i < 6; i++) UI.toast('t' + i, 5000); });
  check('토스트는 동시에 최대 3개만 쌓임 (오래된 것부터 지움)', await g.ev(() => { const t = [...document.querySelectorAll('.toast')].map(x => x.textContent); return t.length === 3 && t.join() === 't3,t4,t5'; }));
  await g.ev(() => { UI.toast('<b>굵게</b>', 3000); });
  check('토스트 글자는 HTML 로 해석되지 않음', await g.ev(() => !document.querySelector('.toast b')));
  await g.done('휴식 알림');
});

// ===========================================================================
// 6. 조작법 / 랭킹 모달
// ===========================================================================
await section('조작법 · 랭킹 모달', async () => {
  const g = await fresh();
  const { page } = g;
  await page.click('#ui-help');
  check('「조작법」 → 조작법 패널(대화상자)이 열림', await g.ev(() => !document.getElementById('ui-help-modal').hidden && UI.state().modal === 'help' && !!document.querySelector('#ui-help-modal [role=dialog][aria-modal=true]')));
  check('조작법에 방향키/Z/X/A/S/D/Esc/M 키가 적혀 있음', await g.ev(() => { const t = [...document.querySelectorAll('#ui-help-modal kbd')].map(k => k.textContent); return ['←', 'Z', 'X', 'A', 'S', 'D', 'Esc', 'M'].every(k => t.includes(k)); }));
  check('열리면 안쪽 버튼에 포커스', await g.ev(() => document.getElementById('ui-help-modal').contains(document.activeElement)));
  await page.keyboard.press('Escape');
  check('Esc → 닫히고 포커스가 「조작법」 버튼으로 돌아옴', await g.ev(() => document.getElementById('ui-help-modal').hidden && UI.state().modal === null && document.activeElement.id === 'ui-help'));
  await page.click('#ui-rank');
  await wait(100);
  check('「랭킹」 → 랭킹 대화상자가 열리고 서버 랭킹 4줄 표시', await g.ev(() => !document.getElementById('ui-rank-modal').hidden && document.querySelectorAll('#ui-rank-modal .rank-row').length === 4));
  check('랭킹은 Server.getTopScores(10) 로 가져옴', await g.ev(() => T.ranks.length >= 1 && T.ranks.every(n => n === 10)));
  await g.ev(() => { Game.nickname = '코코'; });
  await page.keyboard.press('Escape');
  await g.ev(() => UI.showRanking());
  await wait(100);
  check('내 닉네임(코코) 줄만 강조', await g.ev(() => { const me = [...document.querySelectorAll('#ui-rank-modal .rank-row.me')]; return me.length === 1 && me[0].textContent.includes('코코'); }));
  await page.keyboard.press('Escape');
  check('Esc 로 랭킹 닫힘, UI.hideRanking() 도 안전 (이미 닫힌 상태에서도 오류 없음)', await g.ev(() => { UI.hideRanking(); UI.hideRanking(); return UI.state().modal === null && document.getElementById('ui-rank-modal').hidden; }));
  check('열려 있는 동안 Tab 은 대화상자 안에서만 돎 (매번 확인)', await (async () => { await g.ev(() => UI.showRanking()); const r = []; for (let i = 0; i < 4; i++) { await page.keyboard.press('Tab'); r.push(await g.ev(() => document.getElementById('ui-rank-modal').contains(document.activeElement))); } return r.every(Boolean); })());
  await page.keyboard.press('Escape');
  check('랭킹 모달에서 Esc 를 눌러도 게임이 일시정지되지 않음 (타이틀)', !(await g.state()).paused);
  // 타이틀에서 모달이 열린 채 게임이 시작되면 닫힘
  await g.ev(() => { UI.showRanking(); Game.setScene('play'); });
  check('모달이 열린 채 씬이 바뀌어도 모달이 정리됨(타이틀 exit)', await g.ev(() => document.getElementById('ui-rank-modal').hidden && UI.state().modal === null));
  await g.shot('help_rank_done');
  await g.done('모달');
});

// ===========================================================================
// 7. 터치 컨트롤
// ===========================================================================
await section('터치 컨트롤: 터치가 아닌 환경에서는 숨김, 첫 touchstart 에 나타남', async () => {
  const g = await fresh({ viewport: { width: 844, height: 390 } });
  const pre = await g.ev(() => Game.touch);
  check('(전제) 마우스/키보드 환경에서는 Game.touch 가 false', pre === false);
  await toPlay(g);
  check('터치 환경이 아니면 play 중에도 터치 컨트롤이 숨겨져 있음', !(await g.state()).touchVisible && !(await rectOf(g, '.tc-atk')).vis);
  await g.ev(() => window.dispatchEvent(new Event('touchstart')));
  check('첫 touchstart → Game.touch 가 켜지고 터치 컨트롤이 나타남', await g.ev(() => Game.touch === true) && (await g.state()).touchVisible && (await rectOf(g, '.tc-atk')).vis);
  await g.done('터치 감지');
});

await section('터치 컨트롤: 조이스틱·버튼·멀티터치', async () => {
  const g = await fresh({ touch: true, viewport: { width: 844, height: 390 } });
  const { page } = g;
  check('터치 기기(hasTouch)에서는 Game.touch 가 처음부터 true', await g.ev(() => Game.touch === true));
  check('타이틀에서는 터치 컨트롤이 보이지 않음', !(await g.state()).touchVisible && !(await rectOf(g, '.tc-stick')).vis);
  await toPlay(g);
  check('play 에서 터치 컨트롤(조이스틱+버튼 5개)이 나타남', (await g.state()).touchVisible && (await rectOf(g, '.tc-stick')).vis && (await g.ev(() => document.querySelectorAll('.tc-btn').length)) === 5);
  const atk = await rectOf(g, '.tc-atk'), jump = await rectOf(g, '.tc-jump'), sA = await rectOf(g, '.tc-skill[data-key=KeyA]'), sD = await rectOf(g, '.tc-skill[data-key=KeyD]'), stick = await rectOf(g, '.tc-stick'), base = await rectOf(g, '.tc-base');
  check('공격 버튼이 점프 버튼보다 크고, 점프가 스킬보다 큼', atk.w > jump.w && jump.w > sA.w, JSON.stringify([atk.w, jump.w, sA.w]));
  check('모든 터치 버튼이 최소 44px (스킬 포함)', [atk, jump, sA, sD].every(r => r.w >= 44 && r.h >= 44), JSON.stringify([atk.w, jump.w, sA.w, sD.w]));
  check('조이스틱은 왼쪽, 버튼은 오른쪽에 있음', stick.x < 422 && atk.x > 422 && sA.x > 422);
  check('다섯 버튼이 서로 겹치지 않음', await g.ev(() => { const rs = [...document.querySelectorAll('.tc-btn')].map(e => e.getBoundingClientRect()); for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) { const a = rs[i], b = rs[j]; if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) return false; } return true; }));
  const inside = await g.ev(() => [...document.querySelectorAll('.tc-btn, .tc-stick')].every(e => { const r = e.getBoundingClientRect(); return r.left >= -0.5 && r.top >= -0.5 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5; }));
  check('모든 터치 버튼/조이스틱이 뷰포트 안에 완전히 들어옴', inside);

  // 가짜 포인터 이벤트 도우미
  const ptr = (sel, type, id, x, y) => g.ev(([sel, type, id, x, y]) => { const el = document.querySelector(sel); const r = el.getBoundingClientRect(); el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true, clientX: x === undefined ? r.left + r.width / 2 : x, clientY: y === undefined ? r.top + r.height / 2 : y })); }, [sel, type, id, x, y]);
  const down = () => g.ev(() => ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'KeyZ', 'KeyX', 'KeyA', 'KeyS', 'KeyD'].filter(k => Input.isDown(k)).join());
  const cx = base.x + base.w / 2, cy = base.y + base.h / 2, R = base.w / 2;

  await ptr('.tc-atk', 'pointerdown', 11);
  check('공격 버튼 누름 → KeyZ 눌림', (await down()) === 'KeyZ');
  await ptr('.tc-atk', 'pointerup', 11);
  check('버튼에서 손을 떼면 KeyZ 해제', (await down()) === '');
  await ptr('.tc-atk', 'pointerdown', 11); await ptr('.tc-jump', 'pointerdown', 12);
  check('멀티터치: 공격+점프를 동시에 누름 → KeyZ 와 KeyX 둘 다', (await down()) === 'KeyX,KeyZ' || (await down()) === 'KeyZ,KeyX', await down());
  await ptr('.tc-atk', 'pointerup', 11);
  check('한 손가락만 떼면 다른 버튼은 계속 눌려 있음', (await down()) === 'KeyX');
  await ptr('.tc-jump', 'pointerup', 12);
  check('둘 다 떼면 해제', (await down()) === '');
  for (const [k, code] of [['A', 'KeyA'], ['S', 'KeyS'], ['D', 'KeyD']]) { await ptr(`.tc-skill[data-key=${code}]`, 'pointerdown', 20); const d = await down(); await ptr(`.tc-skill[data-key=${code}]`, 'pointerup', 20); if (!check(`스킬 ${k} 버튼 → ${code}`, d === code, d)) break; }

  // 조이스틱
  await ptr('.tc-stick', 'pointerdown', 31, cx + R * 0.8, cy);
  check('조이스틱을 오른쪽으로 밀면 → 만 눌림', (await down()) === 'ArrowRight', await down());
  await ptr('.tc-stick', 'pointermove', 31, cx + R * 0.8, cy - R * 0.8);
  check('오른쪽 위로 밀면 대각선: → 와 ↑ 둘 다', (await down()).split(',').sort().join() === 'ArrowRight,ArrowUp', await down());
  await ptr('.tc-stick', 'pointermove', 31, cx - R * 0.8, cy + R * 0.8);
  check('왼쪽 아래로 옮기면 ← ↓ 로 바뀌고 → ↑ 는 풀림', (await down()).split(',').sort().join() === 'ArrowDown,ArrowLeft', await down());
  await ptr('.tc-stick', 'pointermove', 31, cx + R * 0.15, cy + R * 0.1);
  check('가운데(데드존) 근처로 돌아오면 모두 풀림', (await down()) === '', await down());
  await ptr('.tc-stick', 'pointermove', 31, cx + R * 0.3, cy);
  check('데드존 안쪽(30%) 에서는 방향키가 눌리지 않음 (음성 확인)', (await down()) === '', await down());
  await ptr('.tc-stick', 'pointermove', 31, cx + R * 0.45, cy);
  check('45% 이상 밀면 눌림', (await down()) === 'ArrowRight', await down());
  await ptr('.tc-stick', 'pointermove', 31, cx + R * 0.3, cy);
  check('이력(히스테리시스): 누른 뒤 30% 까지 돌아와도 아직 눌려 있음 (경계에서 깜빡이지 않음)', (await down()) === 'ArrowRight', await down());
  const knob = await g.ev(() => document.querySelector('.tc-knob').style.transform);
  check('조이스틱 손잡이가 손가락을 따라 움직임 (translate)', /translate\(/.test(knob) && !/translate\(0px,\s*0px\)/.test(knob), knob);
  await ptr('.tc-stick', 'pointerup', 31);
  check('손을 떼면 모든 방향키 해제 + 손잡이가 가운데로', (await down()) === '' && (await g.ev(() => document.querySelector('.tc-knob').style.transform)) === '');
  // 스틱 + 공격 동시 (멀티터치), 두 번째 손가락이 스틱을 가로채지 않음
  await ptr('.tc-stick', 'pointerdown', 41, cx + R * 0.8, cy);
  await ptr('.tc-atk', 'pointerdown', 42);
  check('멀티터치: 스틱(→)과 공격(Z)을 동시에', (await down()).split(',').sort().join() === 'ArrowRight,KeyZ', await down());
  await ptr('.tc-stick', 'pointerdown', 43, cx - R * 0.8, cy);
  check('조이스틱은 한 손가락만: 두 번째 손가락은 무시', (await down()).split(',').sort().join() === 'ArrowRight,KeyZ', await down());
  await ptr('.tc-stick', 'pointermove', 43, cx - R * 0.8, cy);
  check('무시된 손가락의 이동은 방향에 영향 없음', (await down()).includes('ArrowRight') && !(await down()).includes('ArrowLeft'));
  await ptr('.tc-atk', 'pointerup', 42);
  check('공격만 떼면 스틱 방향은 유지', (await down()) === 'ArrowRight', await down());
  // 일시정지하면 컨트롤이 사라지고 눌린 키가 모두 풀림
  await g.ev(() => Game.pause(true));
  check('일시정지하면 터치 컨트롤이 숨겨지고 눌린 키가 풀림', !(await g.state()).touchVisible && (await down()) === '');
  await g.ev(() => Game.pause(false));
  check('계속하면 다시 보임', (await g.state()).touchVisible);
  await ptr('.tc-stick', 'pointerup', 41);
  // 컨트롤이 숨겨질 때 손가락이 눌린 채여도 방향키가 고착되지 않음
  await ptr('.tc-stick', 'pointerdown', 51, cx + R * 0.8, cy);
  await g.ev(() => Game.setScene('title'));
  check('씬이 바뀌어 컨트롤이 사라질 때 눌려 있던 방향키가 고착되지 않음', (await down()) === '' && !(await g.state()).touchVisible);
  await toPlay(g);
  check('다시 play 로 오면 조이스틱이 깨끗한 상태', (await down()) === '' && (await g.ev(() => document.querySelector('.tc-knob').style.transform)) === '');
  await ptr('.tc-stick', 'pointerdown', 52, cx + R * 0.8, cy);
  check('이전 고착 없이 새 입력을 받음', (await down()) === 'ArrowRight');
  await ptr('.tc-stick', 'pointercancel', 52);
  check('pointercancel 로도 해제', (await down()) === '');

  // 터치 화면 + 물리 키보드 기기: 키보드로 플레이하면 터치 버튼이 치워지고, 화면을 만지면 돌아옴
  await page.keyboard.press('ArrowRight');
  let hs = await g.state();
  check('터치 기기에서 물리 키보드(방향키)를 쓰면 터치 버튼이 사라지고 캔버스 스킬 칸이 나옴', !hs.touchVisible && hs.kbdUsed && await g.ev(() => PX.run([{ x: 18, y: 106, w: 62, h: 62, pred: 'solid' }])[0] > 1500));
  await g.ev(() => window.dispatchEvent(new Event('touchstart')));
  hs = await g.state();
  check('다시 화면을 만지면 터치 버튼이 돌아오고 캔버스 스킬 칸은 숨음', hs.touchVisible && !hs.kbdUsed && await g.ev(() => PX.run([{ x: 18, y: 106, w: 62, h: 62, pred: 'solid' }])[0] === 0));
  await g.ev(() => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight', bubbles: true })); });
  check('합성(자동) 키 이벤트로는 터치 버튼이 사라지지 않음 (진짜 키보드만)', (await g.state()).touchVisible);

  // 스킬 쿨타임이 터치 버튼에 표시됨
  await g.ev(() => { Game.player.skills[0].cd = 150; Game.player.skills[0].cdMax = 300; Game.player.skills[1].cd = 0; Game.player.skills[2].cd = 1800; });
  await g.ev(() => Loop.draw());
  const sk = await g.ev(() => [...document.querySelectorAll('.tc-skill')].map(b => ({ key: b.dataset.key, ready: b.dataset.ready, sec: b.querySelector('.tc-sec').textContent, cd: b.style.getPropertyValue('--cd'), label: b.getAttribute('aria-label') })));
  check('쿨타임 중인 스킬은 남은 초(3초) 와 부채꼴(50%) 표시', sk[0].ready === '0' && sk[0].sec === '3' && sk[0].cd === '50', JSON.stringify(sk[0]));
  check('쓸 수 있는 스킬(S)은 숫자가 없고 준비됨 표시', sk[1].ready === '1' && sk[1].sec === '' && sk[1].cd === '0', JSON.stringify(sk[1]));
  check('긴 쿨타임(D 30초)도 초로 표시', sk[2].ready === '0' && sk[2].sec === '30' && sk[2].cd === '100', JSON.stringify(sk[2]));
  check('스킬 버튼 aria-label 에 이름·키·상태가 들어 있음', sk[0].label.includes('(A)') && sk[0].label.includes('3초') && sk[1].label.includes('쓸 수 있어요'), sk[0].label + ' / ' + sk[1].label);
  await g.ev(() => { Game.player.skills[0].cd = 0; });
  await g.ev(() => Loop.draw());
  check('쿨타임이 끝나면 다시 준비됨으로', await g.ev(() => document.querySelector('.tc-skill[data-key=KeyA]').dataset.ready === '1'));
  await g.shot('touch_844x390');
  await g.done('터치 컨트롤');
});

await section('터치: 진짜 멀티터치(CDP) — 조이스틱과 버튼을 동시에', async () => {
  const g = await fresh({ touch: true, viewport: { width: 844, height: 390 } });
  const { page, context } = g;
  await toPlay(g);
  const cdp = await context.newCDPSession(page);
  const base = await rectOf(g, '.tc-base'), atk = await rectOf(g, '.tc-atk');
  const bx = base.x + base.w * 0.85, by = base.y + base.h / 2, ax = atk.x + atk.w / 2, ay = atk.y + atk.h / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: bx, y: by, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: bx, y: by, id: 1 }, { x: ax, y: ay, id: 2 }] });
  const d1 = await g.ev(() => ({ r: Input.isDown('ArrowRight'), z: Input.isDown('KeyZ') }));
  check('실제 터치 두 개: 조이스틱(→)과 공격(Z) 동시에 눌림', d1.r && d1.z, JSON.stringify(d1));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ x: ax, y: ay, id: 2 }] });
  const d2 = await g.ev(() => ({ r: Input.isDown('ArrowRight'), z: Input.isDown('KeyZ') }));
  check('공격 손가락만 떼면 Z 해제, 스틱은 유지', d2.r && !d2.z, JSON.stringify(d2));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ x: bx, y: by, id: 1 }] });
  const d3 = await g.ev(() => ({ r: Input.isDown('ArrowRight'), z: Input.isDown('KeyZ') }));
  check('모두 떼면 전부 해제', !d3.r && !d3.z, JSON.stringify(d3));
  await g.done('실제 멀티터치');
});

// ===========================================================================
// 8. 화면 크기 / 세로 화면 / 움직임 줄이기
// ===========================================================================
await section('레이아웃: 844x390 / 1280x720 / 1920x1080', async () => {
  for (const [w, h] of [[844, 390], [1280, 720], [1920, 1080], [667, 375], [568, 320]]) {
    const g = await fresh({ viewport: { width: w, height: h } });
    const tag = `${w}x${h}`;
    const m = await g.ev(() => {
      const de = document.documentElement, app = document.getElementById('app').getBoundingClientRect(), cv = document.getElementById('game').getBoundingClientRect();
      return { sw: de.scrollWidth, cw: de.clientWidth, sh: de.scrollHeight, ch: de.clientHeight, app: { w: app.width, h: app.height, x: app.left, y: app.top }, cv: { w: cv.width, h: cv.height }, u: UI.state().u, cssU: parseFloat(getComputedStyle(de).getPropertyValue('--u')), bw: Loop.canvas.width, dpr: Loop.dpr };
    });
    check(`[${tag}] 가로/세로 스크롤이 생기지 않음`, m.sw <= m.cw && m.sh <= m.ch, JSON.stringify([m.sw, m.cw, m.sh, m.ch]));
    check(`[${tag}] #app 이 16:9 이고 화면 안에 꽉 맞게(레터박스) 들어감`, Math.abs(m.app.w / m.app.h - 16 / 9) < 0.02 && m.app.w <= w + 0.5 && m.app.h <= h + 0.5 && (Math.abs(m.app.w - w) < 1.5 || Math.abs(m.app.h - h) < 1.5), JSON.stringify(m.app));
    check(`[${tag}] 캔버스 CSS 크기 = #app 크기 (백버퍼 ${m.bw}px 에 끌려가지 않음)`, Math.abs(m.cv.w - m.app.w) < 1 && Math.abs(m.cv.h - m.app.h) < 1, JSON.stringify(m.cv));
    check(`[${tag}] --u 가 캔버스 폭/960 으로 계산됨`, Math.abs(m.cssU - m.cv.w / 960) < 0.002 && Math.abs(m.u - m.cv.w / 960) < 0.002, JSON.stringify([m.cssU, m.u, m.cv.w / 960]));
    // 타이틀 요소가 #app 안에 있고 잘리지 않음
    const t = await g.ev(() => {
      const app = document.getElementById('app').getBoundingClientRect(), out = {};
      const inApp = r => r.left >= app.left - 1 && r.right <= app.right + 1 && r.top >= app.top - 1 && r.bottom <= app.bottom + 1;
      const els = ['#ui-nick', '.diff-card[data-diff=easy]', '.diff-card[data-diff=normal]', '.diff-card[data-diff=hard]', '#ui-start', '#ui-help', '#ui-rank', '#ui-mute'];
      out.inside = els.map(s => [s, inApp(document.querySelector(s).getBoundingClientRect())]).filter(x => !x[1]).map(x => x[0]);
      out.small = [...document.querySelectorAll('#ui-title button, #ui-mute, #ui-title input')].filter(e => { const r = e.getBoundingClientRect(); return r.height && (r.width < 43.5 || r.height < 43.5); }).map(e => e.id || e.className);
      const panel = document.querySelector('.title-panel'); out.panelScroll = panel.scrollHeight - panel.clientHeight;
      const logoBottom = 175 * (app.width / 960) + app.top, nick = document.querySelector('.nick-row').getBoundingClientRect(); out.gap = nick.top - logoBottom;
      return out;
    });
    check(`[${tag}] 타이틀 입력칸/난이도/시작/조작법/랭킹 버튼이 모두 화면(#app) 안에 있음`, t.inside.length === 0, t.inside.join());
    check(`[${tag}] 타이틀 버튼/입력칸이 모두 44px 이상`, t.small.length === 0, t.small.join());
    check(`[${tag}] 타이틀 패널이 스크롤 없이 한눈에 들어옴`, t.panelScroll <= 1, `scroll=${t.panelScroll}`);
    check(`[${tag}] 타이틀 패널이 로고/부제와 겹치지 않음`, t.gap >= -2, `gap=${t.gap.toFixed(1)}`);
    await g.shot('title_' + tag);

    // 조작법 창 / 일시정지 창: 닫기·계속하기 같은 버튼이 화면 안에 완전히 보임 (작은 폰에서 아래가 잘리지 않음)
    await g.ev(() => document.getElementById('ui-help').click());
    await wait(80);
    const hm = await g.ev(() => {
      const app = document.getElementById('app').getBoundingClientRect(), b = document.querySelector('#ui-help-modal [data-first]').getBoundingClientRect(), card = document.querySelector('#ui-help-modal .modal');
      const kk = [...document.querySelectorAll('#ui-help-modal .keys li')].map(l => l.getBoundingClientRect());
      let overlap = false; for (let i = 0; i < kk.length; i++) for (let j = i + 1; j < kk.length; j++) { const a = kk[i], c = kk[j]; if (a.left < c.right - 1 && c.left < a.right - 1 && a.top < c.bottom - 1 && c.top < a.bottom - 1) overlap = true; }
      const labels = [...document.querySelectorAll('#ui-help-modal .keys li > span:last-child')].map(e => e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).fontSize));   // 줄 수 비슷한 값 (한 줄이면 1.2~1.5, 글자가 세로로 쪼개지면 5 이상)
      return { inside: b.left >= app.left - 1 && b.right <= app.right + 1 && b.top >= app.top - 1 && b.bottom <= app.bottom + 1, small: b.height < 43.5, scroll: card.scrollHeight - card.clientHeight, overlap, tall: Math.max(...labels) };
    });
    check(`[${tag}] 조작법 창: 「알겠어요!」 버튼이 화면 안에 완전히 보이고 44px 이상, 칸끼리 겹치지 않음, 글자가 세로로 쪼개지지 않음`, hm.inside && !hm.small && !hm.overlap && hm.tall < 2.4, JSON.stringify(hm));
    await g.shot('help_' + tag);
    await g.ev(() => document.querySelector('#ui-help-modal [data-first]').click());
    await toPlay(g);
    await g.ev(() => Game.pause(true));
    await wait(80);
    const pm = await g.ev(() => {
      const app = document.getElementById('app').getBoundingClientRect(), q = s => document.querySelector(s).getBoundingClientRect();
      const ids = ['#ui-resume', '#ui-restart', '#ui-home', '#ui-pause-mute'];
      return { outside: ids.filter(s => { const r = q(s); return !(r.left >= app.left - 1 && r.right <= app.right + 1 && r.top >= app.top - 1 && r.bottom <= app.bottom + 1); }), small: ids.filter(s => q(s).height < 43.5) };
    });
    check(`[${tag}] 일시정지 창: 버튼 4개가 모두 화면 안에 보이고 44px 이상`, pm.outside.length === 0 && pm.small.length === 0, JSON.stringify(pm));
    await g.shot('pause_' + tag);
    await g.ev(() => { Game.pause(false); Game.setScene('title'); });

    // 결과 화면 (가장 빽빽함: 별+통계+저장+버튼+랭킹)
    await toResult(g, RES());
    await step(g.page, 200);
    await g.ev(() => T.saveCbs[0].res({ ok: true, source: 'server' }));
    await wait(150);
    const r = await g.ev(() => {
      const app = document.getElementById('app').getBoundingClientRect();
      const inApp = r => r.left >= app.left - 1 && r.right <= app.right + 1 && r.top >= app.top - 1 && r.bottom <= app.bottom + 1;
      const q = s => document.querySelector(s);
      const mid = q('.res-mid');
      return {
        bad: ['.res-title', '.stars', '.res-msg', '#ui-again', '#ui-toTitle', '.save-text', '.rank-card'].filter(s => !inApp(q(s).getBoundingClientRect())),
        midClip: mid.scrollHeight - mid.clientHeight, small: ['#ui-again', '#ui-toTitle'].filter(s => { const r = q(s).getBoundingClientRect(); return r.width < 43.5 || r.height < 43.5; }),
        noHScroll: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        overlap: (() => { if (getComputedStyle(q('.res-msg')).display === 'none') return 0; const a = q('.res-msg').getBoundingClientRect(), b = q('.stars').getBoundingClientRect(); return b.bottom - a.top; })(),   // (아주 낮은 화면에선 격려 문구를 접어요 → 겹칠 일 없음)
      };
    });
    check(`[${tag}] 결과 화면: 제목/별/문구/버튼/랭킹이 모두 #app 안에 (잘리지 않음)`, r.bad.length === 0 && r.noHScroll, r.bad.join());
    check(`[${tag}] 결과 화면: 버튼 44px 이상`, r.small.length === 0, r.small.join());
    check(`[${tag}] 결과 화면: 별과 문구가 겹치지 않음`, r.overlap <= 2, `${r.overlap.toFixed(1)}`);
    if (w < 900) check(`[${tag}] 결과 화면: 점수 칸 5개가 잘리거나 스크롤 없이 모두 보임 (UI-04: 예전엔 80px 까지 잘려도 통과였어요)`, r.midClip <= 2, `clip=${r.midClip}`);
    await g.shot('result_' + tag);
    await g.done('레이아웃 ' + tag);
  }
});

await section('세로 화면: "가로로 돌려 주세요" 안내', async () => {
  const g = await fresh({ viewport: { width: 390, height: 844 } });
  const { page } = g;
  let s = await g.state();
  const ro = await g.ev(() => { const e = document.getElementById('ui-rotate'), r = e.getBoundingClientRect(); return { disp: getComputedStyle(e).display, w: r.width, h: r.height, text: e.textContent, z: getComputedStyle(e).zIndex }; });
  check('세로(390x844) 화면에서는 안내가 전체 화면을 덮음', s.portrait && ro.disp !== 'none' && ro.w >= 389 && ro.h >= 843, JSON.stringify(ro));
  check('안내 문구에 "가로로 돌려 주세요"', ro.text.includes('가로로 돌려 주세요'));
  check('그 위에는 아무 것도 올라오지 않음 (가장 높은 z-index)', Number(ro.z) >= 1000);
  check('세로 화면에서도 가로 스크롤이 없음', await g.ev(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  await g.shot('portrait_390x844');
  // play 중에 세로로 돌리면 자동 일시정지
  await page.setViewportSize({ width: 844, height: 390 });
  await wait(250);
  s = await g.state();
  check('가로로 돌리면 안내가 사라짐', !s.portrait && (await g.ev(() => getComputedStyle(document.getElementById('ui-rotate')).display)) === 'none');
  await toPlay(g);
  await page.setViewportSize({ width: 390, height: 844 });
  await wait(300);
  s = await g.state();
  check('play 중에 세로로 돌리면 자동 일시정지', s.portrait && s.paused);
  await page.setViewportSize({ width: 844, height: 390 });
  await wait(300);
  s = await g.state();
  check('다시 가로로 돌려도 자동으로 재개되지 않음 (일시정지 화면에서 사용자가 계속하기)', !s.portrait && s.paused && s.pauseVisible);
  // 데스크톱의 큰 세로 창(가로 700 이상, 마우스)은 안내 없이 게임을 보여줌
  await page.setViewportSize({ width: 900, height: 1200 });
  await wait(250);
  check('마우스 환경에서 폭이 넉넉한 세로 창(900x1200)은 안내 없이 게임 화면', !(await g.state()).portrait);
  await g.done('세로 화면');
});

await section('움직임 줄이기(prefers-reduced-motion)', async () => {
  const g = await fresh();
  const { page } = g;
  const sig = () => g.ev(() => { Loop.draw(); const c = Loop.canvas, d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let h = 0; for (let i = 0; i < d.length; i += 97) h = (h * 31 + d[i]) | 0; return h; });
  const a = await sig(); await step(page, 37); const b = await sig();
  check('(기본) 타이틀 배경이 움직임 (프레임이 지나면 그림이 달라짐)', a !== b && (await g.state()).motion === true);
  check('(기본) 「시작」 버튼에 맥박 애니메이션이 있음', await g.ev(() => getComputedStyle(document.getElementById('ui-start')).animationName !== 'none'));
  const rects = [];
  for (let i = 0; i < 6; i++) { rects.push(await g.ev(() => { const r = document.getElementById('ui-start').getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(v => Math.round(v * 100) / 100).join(); })); await wait(130); }
  check('「시작」 버튼은 두근거리는 중에도 크기·위치가 그대로 (자동 클릭 도구/보조기기가 움직이는 버튼을 못 누르는 일이 없음)', new Set(rects).size === 1, rects.join(' | '));
  check('(그래도 눈에 띄게) 밝기가 숨 쉬듯 변함 + 바깥 링 애니메이션이 따로 있음', await g.ev(() => getComputedStyle(document.getElementById('ui-start')).animationName === 'breathe' && getComputedStyle(document.getElementById('ui-start'), '::after').animationName === 'ping'));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await wait(100);
  const c1 = await sig(); await step(page, 37); const c2 = await sig();
  check('reduced-motion: 타이틀 배경이 멈춰 있음 (통통/떠다니는 장식 없음)', c1 === c2 && (await g.state()).motion === false);
  check('reduced-motion: 시작 버튼 맥박/토스트 애니메이션이 꺼짐', await g.ev(() => getComputedStyle(document.getElementById('ui-start')).animationName === 'none'));
  await g.ev(() => UI.toast('x', 3000));
  check('reduced-motion: 토스트 등장 애니메이션도 꺼짐', await g.ev(() => getComputedStyle(document.querySelector('.toast')).animationName === 'none'));
  // HUD 도 조용히
  await toPlay(g);
  const hp = await g.ev(() => { Game.player.hp = 15; const orig = performance.now.bind(performance); let t = 0; performance.now = () => t; const v = []; for (t = 0; t < 3000; t += 100) v.push(PX.alphaAt(3, 3)); performance.now = orig; return v; });
  check('reduced-motion: 위험 표시가 숨쉬지 않고 일정함', new Set(hp).size === 1 && hp[0] > 0, JSON.stringify(hp.slice(0, 5)));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await g.done('움직임 줄이기');
});

await section('시작 버튼은 평범한 클릭(force 없이)으로도 눌림', async () => {
  const g = await fresh();
  const { page } = g;
  await page.fill('#ui-nick', '별이');
  await page.click('#ui-start', { timeout: 4000 });                                   // Playwright 가 "안정된 버튼" 이라고 판단해야만 통과
  await step(page, 2);
  check('force 없는 일반 클릭으로 게임이 시작됨 (Stage.start 호출)', await g.ev(() => T.started.length === 1 && T.started[0].nickname === '별이'));
  await g.done('평범한 클릭');
});

await section('접근성: 진짜 버튼 · 이름표 · 포커스 링', async () => {
  const g = await fresh();
  const { page } = g;
  const a = await g.ev(() => {
    const out = {};
    out.nonButtons = [...document.querySelectorAll('#ui [onclick], #ui .btn, #ui .diff-card, #ui .round-btn')].filter(e => e.tagName !== 'BUTTON').map(e => e.tagName + '.' + e.className);
    out.unnamed = [...document.querySelectorAll('#ui button, #touch button, #ui input')].filter(e => !(e.getAttribute('aria-label') || e.textContent.trim() || (e.labels && e.labels.length))).map(e => e.id || e.className);
    out.roles = { radiogroup: !!document.querySelector('[role=radiogroup]'), radios: document.querySelectorAll('[role=radio]').length, dialogs: document.querySelectorAll('[role=dialog][aria-modal=true]').length, live: document.querySelectorAll('[aria-live]').length, h1: !!document.querySelector('#ui h1') };
    out.lang = document.documentElement.lang;
    return out;
  });
  check('모든 조작 요소가 진짜 <button> (div/span 버튼 없음)', a.nonButtons.length === 0, a.nonButtons.join());
  check('이름 없는 버튼/입력칸이 없음 (aria-label 또는 글자)', a.unnamed.length === 0, a.unnamed.join());
  check('난이도는 radiogroup/radio, 대화상자는 aria-modal, 알림은 aria-live, 제목 h1 이 있음', a.roles.radiogroup && a.roles.radios === 3 && a.roles.dialogs >= 3 && a.roles.live >= 2 && a.roles.h1, JSON.stringify(a.roles));
  check('문서 언어가 한국어', a.lang === 'ko');
  // 포커스 링이 보임
  await g.ev(() => document.getElementById('ui-help').focus());
  await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
  await wait(300);                                                                   // 포커스 링 전환(.08초)이 끝나길 기다림
  const ring = await g.ev(() => { const e = document.activeElement, cs = getComputedStyle(e); return { id: e.id, outline: cs.outlineStyle, w: parseFloat(cs.outlineWidth), shadow: cs.boxShadow }; });
  check('키보드로 포커스하면 두꺼운 포커스 링(outline ≥ 3px + 흰 링)이 보임', ring.outline === 'solid' && ring.w >= 3 && /255, 255, 255/.test(ring.shadow), JSON.stringify(ring));
  // 선택된 난이도는 색뿐 아니라 ✓ 표시/굵은 테두리로도 구분
  const sel = await g.ev(() => { const c = document.querySelector('.diff-card[aria-checked=true]'), o = document.querySelector('.diff-card[aria-checked=false]'); return { before: getComputedStyle(c.querySelector('.diff-label'), '::before').content, borderOn: parseFloat(getComputedStyle(c).borderTopWidth), borderOff: parseFloat(getComputedStyle(o).borderTopWidth), beforeOff: getComputedStyle(o.querySelector('.diff-label'), '::before').content }; });
  check('선택된 난이도는 ✓ 표시와 더 굵은 테두리로도 구분됨 (색만으로 알리지 않음)', sel.before.includes('✓') && !sel.beforeOff.includes('✓') && sel.borderOn > sel.borderOff, JSON.stringify(sel));
  // 글자 대비: 본문 글자(잉크색)와 카드 배경(크림)의 대비비 ≥ 7
  const cr = await g.ev(() => {
    const lum = c => { const v = c.map(x => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
    const rgb = s => s.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
    const ratio = (fg, bg) => { const a = lum(rgb(fg)), b = lum(rgb(bg)); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
    const card = document.querySelector('.diff-card[aria-checked=false]'), cs = getComputedStyle(card);
    const sel = document.querySelector('.diff-card[aria-checked=true]'), ss = getComputedStyle(sel);
    const err = document.getElementById('ui-nick-err');
    UI.startGame(); const es = getComputedStyle(err);
    return { card: ratio(cs.color, cs.backgroundColor), sel: ratio(ss.color, ss.backgroundColor), err: ratio(es.color, es.backgroundColor) };
  });
  check('난이도 카드/선택 카드/오류 문구의 글자 대비비가 4.5 이상 (WCAG AA)', cr.card >= 7 && cr.sel >= 4.5 && cr.err >= 4.5, JSON.stringify(cr));
  await g.done('접근성');
});

// ===========================================================================
// 12. 진짜 Stage / Player / Enemies 와 함께 (가짜 play 씬 없이)
//     위의 구역들은 Stage 를 가짜로 바꿔 끼워서 UI 만 따로 확인했어요. 여기서는 진짜 모듈 그대로 써서 이어 붙였을 때를 확인해요.
//     진짜 모듈이 로드되지 않았으면(스크립트 오류 등) "통과" 로 넘어가지 않고 실패로 기록해요 (R-04: 예전엔 건너뛰고 초록불이 켜졌어요).
// ===========================================================================
async function freshReal(opts = {}) {
  const g = await openGame(opts);
  const { page } = g;
  g.ev = (fn, arg) => page.evaluate(fn, arg);
  g.state = () => page.evaluate(() => UI.state());
  g.done = async label => { check(`[${label}] 콘솔/페이지 오류가 없음`, g.errors.length === 0, g.errors.slice(0, 2).join(' | ')); await g.close(); };
  g.real = await g.ev(() => {
    const real = typeof Stage !== 'undefined' && typeof Stage.start === 'function' && typeof Player !== 'undefined' && typeof Player.create === 'function' && typeof Enemies !== 'undefined' && typeof Enemies.spawn === 'function';
    if (!real) return false;
    const T = window.T = { started: [], saves: [], music: [] };
    Music.play = n => { T.music.push(n); };                                    // 소리만 기록 (재생은 안 함)
    const orig = Stage.start; Stage.start = o => { T.started.push(o); return orig.call(Stage, o); };   // 진짜 Stage.start 를 부르되 호출 인자를 기록
    window.__origStart = orig;
    if (typeof Server.saveScore !== 'function') Server.saveScore = p => { T.saves.push(p); return Promise.resolve({ ok: true, source: 'local' }); };
    else { const o = Server.saveScore; Server.saveScore = p => { T.saves.push(p); return o.call(Server, p); }; }
    if (typeof Server.getTopScores !== 'function') Server.getTopScores = () => Promise.resolve([]);
    return true;
  });
  check('[진짜 모듈] Stage / Player / Enemies 가 로드됨 (이게 실패하면 아래 통합 검사가 통째로 빠진 거예요)', g.real);
  return g;
}

await section('진짜 모듈: 시작 → 플레이 → 일시정지 → 게임 오버 → 결과 → 다시 하기 → 처음으로', async () => {
  const g = await freshReal();
  const { page } = g;
  if (!g.real) { await g.close(); return; }
  await page.fill('#ui-nick', '별이');
  await page.click('.diff-card[data-diff=hard]');
  await page.dblclick('#ui-start', { force: true, delay: 5 });
  await step(page, 5);
  let s = await g.state();
  const run = await g.ev(() => ({ n: T.started.length, a: T.started[0], scene: Game.scene, diff: Game.difficulty, nick: Game.nickname, lives: Game.lives, player: !!Game.player && Game.player.kind === 'player', roomName: Game.stage.roomName, rc: Game.stage.roomCount }));
  check('진짜 Stage.start 로 시작됨: play 씬 + 플레이어 + 방 이름', run.scene === 'play' && run.player && !!run.roomName && run.rc > 0, JSON.stringify(run));
  check('「시작」을 빠르게 두 번 눌러도 Stage.start 는 한 번만', run.n === 1, String(run.n));
  check('Stage.start 에 고른 난이도(hard)와 닉네임이 그대로 전달됨 (목숨 1개)', run.a.difficulty === 'hard' && run.a.nickname === '별이' && run.diff === 'hard' && run.lives === 1, JSON.stringify(run.a));
  check('타이틀 화면은 닫히고 일시정지/터치 컨트롤은 없음', !s.titleVisible && !s.pauseVisible && !s.touchVisible);
  check('시작 뒤 포커스가 DOM 버튼에 남아 있지 않음 (Space 가 버튼으로 새지 않음)', await g.ev(() => !document.activeElement || document.activeElement === document.body));
  check('일시정지/소리 버튼이 보임 (play 중)', await g.ev(() => !document.getElementById('ui-pause').hidden && !document.getElementById('ui-mute').hidden));

  // 진짜 키보드: Space 로 공격 → 진짜 플레이어가 공격 상태가 됨 (Input 이 화면 버튼에 먹히지 않음)
  await step(page, 150);                                                                  // 방 소개 연출이 끝나길
  await page.keyboard.down('Space'); await step(page, 3); await page.keyboard.up('Space');
  check('Space 키 → 진짜 플레이어가 공격', await g.ev(() => Game.player.state === 'attack'), await g.ev(() => Game.player.state));
  await step(page, 60);

  // HUD 가 진짜 상태를 그림 (오류 없이)
  await g.ev(() => { Game.combo.count = 6; Game.combo.timer = 60; Game.score = 4321; Events.emit('comboChanged', { count: 6, max: 6 }); Game.player.skills[0].cd = 150; });
  await step(page, 3);
  await g.ev(() => Loop.draw());
  const hud = await g.ev(() => { const c = Loop.canvas, ctx = c.getContext('2d'), d = Loop.dpr; const px = (x, y) => Array.from(ctx.getImageData(x * d | 0, y * d | 0, 1, 1).data); return { hp: px(120, 23), lives: px(100, 71) }; });
  check('진짜 플레이어 체력바가 초록색으로 그려짐 (HP 100%)', hud.hp[1] > hud.hp[0] + 40 && hud.hp[1] > hud.hp[2] + 40, JSON.stringify(hud.hp));
  check('쓰는 중인 스킬 쿨타임이 진짜 p.skills 에서 읽혀 숫자로 보임 (A: 150f → 3초)', await g.ev(() => Game.player.skills[0].cd > 0 && Game.player.skills[0].icon.length > 0));

  // 방 진행도 점 = 진짜 스테이지의 방 수 (STAGES[0].rooms.length). 스테이지가 7방으로 바뀌어도 HUD 는 그대로 따라가야 함 (5 로 굳히지 않음)
  const rooms = await g.ev(() => ({ rc: Game.stage.roomCount, n: STAGES[0].rooms.length }));
  check('Game.stage.roomCount 가 진짜 STAGES[0].rooms.length 와 같음', rooms.rc === rooms.n && rooms.n >= 3, JSON.stringify(rooms));
  const dotRuns = await g.ev(() => {
    const keep = Game.stage.roomIndex; Game.stage.roomIndex = Game.stage.roomCount - 1;           // 마지막 방이면 앞의 점은 민트, 마지막이 노랑 → 색 덩어리 수 = 방 수
    const c = Loop.canvas, ctx = c.getContext('2d'), d = Loop.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, c.width, c.height); ctx.setTransform(d, 0, 0, d, 0, 0); UI.drawHUD(ctx);
    const w = Math.round(960 * d), im = ctx.getImageData(0, Math.round(58 * d), w, 1).data; let runs = 0, len = 0;
    for (let x = 0; x <= w; x++) { const k = x * 4, on = x < w && im[k + 3] > 200 && ((im[k] > 230 && im[k + 1] > 190 && im[k + 2] < 120) || (im[k] > 100 && im[k] < 150 && im[k + 1] > 200 && im[k + 2] > 120 && im[k + 2] < 170)); if (on) len++; else { if (len >= 3) runs++; len = 0; } }
    Game.stage.roomIndex = keep; return runs;
  });
  check('HUD 방 진행도 점의 개수가 진짜 방 수와 같음', dotRuns === rooms.n, `${dotRuns} vs ${rooms.n}`);

  // 일시정지: 진짜 Stage 진행이 멈춤
  await page.keyboard.press('Escape');
  const f0 = await g.ev(() => ({ f: Game.frame, x: Game.player.x, c: Stage.state }));
  await step(page, 40);
  const f1 = await g.ev(() => ({ f: Game.frame, x: Game.player.x, c: Stage.state }));
  s = await g.state();
  check('Esc → 일시정지 화면 + 진짜 게임이 멈춤 (Game.frame 그대로)', s.paused && s.pauseVisible && f1.f === f0.f && f1.x === f0.x);
  await page.keyboard.press('KeyP');
  await step(page, 20);
  s = await g.state();
  check('P → 계속하기: 다시 진행됨', !s.paused && !s.pauseVisible && (await g.ev(() => Game.frame)) === f0.f + 20);

  // 창 크기를 바꿔도 게임이 계속되고 HUD 가 이어짐
  await page.setViewportSize({ width: 900, height: 500 });
  await wait(250);
  s = await g.state();
  const sz = await g.ev(() => { const c = document.getElementById('game').getBoundingClientRect(), a = document.getElementById('app').getBoundingClientRect(); return { cw: c.width, aw: a.width, ratio: c.width / c.height, ow: document.documentElement.scrollWidth <= innerWidth + 1 }; });
  check('플레이 중 창 크기를 바꾸면 --u 와 캔버스 크기가 따라가고 가로 스크롤이 없음', Math.abs(s.u - sz.cw / 960) < 0.01 && Math.abs(sz.cw - sz.aw) < 1 && Math.abs(sz.ratio - 16 / 9) < 0.02 && sz.ow && !s.paused, JSON.stringify([s.u, sz]));
  await page.setViewportSize({ width: 1280, height: 720 });
  await wait(250);

  // 보스가 나오면 보스 체력바가 그려짐 (진짜 젤리 대왕)
  await g.ev(() => { Enemies.clear(); const b = Enemies.spawn('jellyKing', 700, 420); b.hp = b.maxHp * 0.7; });
  await step(page, 30);
  await g.ev(() => Loop.draw()); await wait(600);                                        // 체력바가 위에서 미끄러져 내려오는 연출(0.4초)이 끝나길 (이 연출은 실제 시간 기준)
  const bossBar = await g.ev(() => {
    Loop.draw(); const c = Loop.canvas, ctx = c.getContext('2d'), d = Loop.dpr;
    const im = ctx.getImageData(Math.round(250 * d), Math.round(134 * d), Math.round(460 * d), Math.round(30 * d)).data; let pink = 0;
    for (let i = 0; i < im.length; i += 4) if (im[i] > 220 && im[i + 1] < 200 && im[i + 2] > 170 && im[i + 3] > 200) pink++;
    return { pink, boss: !!Game.boss, name: Game.boss && Game.boss.name };
  });
  check('진짜 보스(젤리 대왕)가 나오면 위쪽(방 이름 아래)에 분홍 체력바가 그려짐', bossBar.boss && bossBar.pink > 300, JSON.stringify(bossBar));
  await g.ev(() => { Enemies.clear(); });
  await step(page, 5);

  // 진짜 게임 오버: 어려움은 목숨 1개 → 쓰러지면 결과 화면
  await g.ev(() => { T.saves.length = 0; Combat.damage(Game.player, 9999, { sfx: 'hurt' }); });
  await step(page, 400);
  s = await g.state();
  const over = await g.ev(() => ({ scene: Game.scene, res: Game.result, saves: T.saves.slice(), title: document.querySelector('.res-title').textContent, msg: document.querySelector('.res-msg').textContent, on: document.querySelectorAll('.star.on').length }));
  check('목숨이 다 떨어지면 진짜 Stage 가 결과 씬으로 → 결과 화면이 보임', over.scene === 'result' && s.resultVisible && over.res && over.res.cleared === false, JSON.stringify(over.res));
  check('게임 오버 결과: 격려 제목/문구, 별 0개', over.title.includes('아쉬워요') && over.msg.length > 5 && over.on === 0 && s.starsTotal === 0, over.title + ' / ' + over.msg);
  check('결과가 열리자마자 saveScore 를 한 번 부름 (진짜 닉네임·난이도·클리어 여부)', over.saves.length === 1 && over.saves[0].nickname === '별이' && over.saves[0].difficulty === 'hard' && over.saves[0].cleared === false && over.saves[0].stars === 0 && Number.isFinite(over.saves[0].score) && Number.isFinite(over.saves[0].timeSec), JSON.stringify(over.saves));
  check('결과 화면에서 Esc/P 를 눌러도 일시정지 화면이 뜨지 않음', await (async () => { await page.keyboard.press('Escape'); await page.keyboard.press('KeyP'); const st = await g.state(); return !st.paused && !st.pauseVisible && st.resultVisible; })());

  // 다시 하기: 같은 난이도·닉네임으로 진짜 Stage.start
  await g.ev(() => { T.started.length = 0; });
  await page.click('#ui-again');
  await step(page, 5);
  const again = await g.ev(() => ({ a: T.started.slice(), scene: Game.scene, lives: Game.lives, score: Game.score, res: Game.result }));
  s = await g.state();
  check('「다시 하기」→ 같은 난이도(hard)·닉네임으로 새 판 (점수 0, 결과 화면 닫힘)', again.a.length === 1 && again.a[0].difficulty === 'hard' && again.a[0].nickname === '별이' && again.scene === 'play' && again.score === 0 && !s.resultVisible, JSON.stringify(again));

  // 일시정지에서 「처음으로」 (한 번 더 눌러야 실행) → 타이틀 + 이전 판 정리
  await page.keyboard.press('Escape');
  await page.click('#ui-home');
  check('「처음으로」 첫 클릭은 확인만 (아직 play 씬)', (await g.ev(() => Game.scene)) === 'play');
  await page.click('#ui-home');                                                          // 곧바로 이어진 두 번째 클릭 = 더블클릭: 확인으로 치지 않아요 (진짜 값 500ms 를 기다려야 눌림)
  check('「처음으로」를 곧바로 한 번 더 눌러도(더블클릭) 아직 play 씬 + 확인 문구 그대로', (await g.ev(() => Game.scene)) === 'play' && /한 번 더/.test(await g.ev(() => document.getElementById('ui-home').textContent)));
  await wait(UI_GUARD_WAIT);
  await page.click('#ui-home');
  await step(page, 3);
  s = await g.state();
  const home = await g.ev(() => ({ scene: Game.scene, paused: Game.paused, ents: Entities.list.length, enemies: Enemies.aliveCount(), nick: document.getElementById('ui-nick').value, music: T.music[T.music.length - 1] }));
  check('두 번째 클릭 → 타이틀로: 일시정지 해제, 엔티티 정리, 닉네임 기억, 타이틀 음악', home.scene === 'title' && !home.paused && s.titleVisible && !s.pauseVisible && home.ents === 0 && home.enemies === 0 && home.nick === '별이' && home.music === 'title', JSON.stringify(home));
  await g.done('진짜 모듈 흐름');
});

await section('진짜 모듈: 쉬움(목숨 ∞) · 열린 화면 중 장면 전환 · 세로 회전', async () => {
  const g = await freshReal();
  const { page } = g;
  if (!g.real) { await g.close(); return; }
  await page.fill('#ui-nick', '코코');
  await page.click('.diff-card[data-diff=easy]');
  await page.keyboard.press('Enter', { delay: 0 }).catch(() => {});
  await page.focus('#ui-nick'); await page.keyboard.press('Enter');
  await step(page, 150);
  let r = await g.ev(() => ({ scene: Game.scene, lives: Game.lives, diff: Game.difficulty }));
  check('입력칸에서 Enter → 쉬움으로 시작 (목숨 ∞)', r.scene === 'play' && r.diff === 'easy' && r.lives === Infinity, JSON.stringify(r));
  // 목숨 ∞ 는 하트 대신 ∞ 를 그림 (예외 없이, 하트 3개 자리가 아님)
  const inf = await g.ev(() => { Loop.draw(); const c = Loop.canvas, ctx = c.getContext('2d'), d = Loop.dpr; const count = (x0, x1) => { const im = ctx.getImageData(x0 * d | 0, 60 * d | 0, (x1 - x0) * d | 0, 22 * d | 0).data; let n = 0; for (let i = 0; i < im.length; i += 4) if (im[i] > 220 && im[i + 1] > 215 && im[i + 2] > 190 && im[i + 3] > 200) n++; return n; }; return { cream: count(118, 165), hearts: count(160, 260) }; });
  check('쉬움: 목숨 자리에 ∞ (크림색 선) 이 그려지고 여분의 하트는 없음', inf.cream > 40 && inf.hearts < inf.cream, JSON.stringify(inf));
  // 쉬움은 쓰러져도 게임 오버 없이 부활
  await g.ev(() => Combat.damage(Game.player, 9999, { sfx: 'hurt' }));
  await step(page, 300);
  r = await g.ev(() => ({ scene: Game.scene, lives: Game.lives, dead: Game.player.dead, deaths: Game.deaths }));
  check('쉬움: 쓰러져도 결과 화면 없이 부활 (목숨은 여전히 ∞)', r.scene === 'play' && r.lives === Infinity && !r.dead && r.deaths === 1, JSON.stringify(r));

  // 일시정지 화면이 떠 있는 채로 장면이 바뀌어도 화면이 남지 않음
  await page.keyboard.press('Escape');
  check('(전제) 일시정지 화면이 열림', (await g.state()).pauseVisible);
  await g.ev(() => Game.setScene('title'));
  let s = await g.state();
  check('일시정지 중에 타이틀로 바뀌면: 일시정지 해제 + 일시정지 화면 닫힘 + 타이틀 보임', !s.paused && !s.pauseVisible && s.titleVisible, JSON.stringify([s.paused, s.pauseVisible, s.titleVisible]));
  // 조작법 창이 열린 채 Stage.start 가 불려도 창이 남지 않음
  await page.click('#ui-help');
  check('(전제) 조작법 창이 열림', (await g.state()).modal === 'help');
  await g.ev(() => Stage.start({ difficulty: 'normal', nickname: '하늘' }));
  await step(page, 3);
  s = await g.state();
  check('조작법 창이 열린 채 게임이 시작돼도 창이 닫히고 play 화면', s.modal === null && s.scene === 'play' && !s.titleVisible && !(await g.ev(() => document.getElementById('ui-help-modal').offsetWidth)), JSON.stringify([s.modal, s.scene]));
  // 같은 Stage.start 를 연달아 불러도 오류 없이 새 판
  await g.ev(() => { Stage.start({ difficulty: 'normal', nickname: '하늘' }); Stage.start({ difficulty: 'hard', nickname: '하늘' }); });
  await step(page, 5);
  check('Stage.start 를 연달아 불러도 마지막 판으로 정상 진행 (hard, 목숨 1)', await g.ev(() => Game.scene === 'play' && Game.difficulty === 'hard' && Game.lives === 1 && !!Game.player));

  // 세로로 돌리면 자동 일시정지 → 가로로 돌려도 자동 재개하지 않고 계속하기 버튼에 포커스
  await page.setViewportSize({ width: 500, height: 900 });
  await wait(300);
  s = await g.state();
  check('플레이 중 세로로 돌리면 자동 일시정지 + 가로 안내', s.paused && s.portrait && (await g.ev(() => getComputedStyle(document.getElementById('ui-rotate')).display)) === 'flex');
  await page.setViewportSize({ width: 1280, height: 720 });
  await wait(300);
  s = await g.state();
  check('다시 가로로 → 안내는 사라지고 일시정지 화면(계속하기)이 남아 있음', s.paused && s.pauseVisible && !s.portrait && (await g.ev(() => document.activeElement && document.activeElement.id)) === 'ui-resume');
  await page.keyboard.press('Space');                                                   // 포커스된 「계속하기」 버튼이 Space 로 눌림 (게임 입력으로 새지 않음)
  await step(page, 5);
  check('계속하기 버튼에서 Space → 계속하기 (공격 입력으로 새지 않음)', await g.ev(() => !Game.paused && !Input.isDown('KeyZ') && Game.player.state !== 'attack'));
  await g.done('쉬움 · 장면 전환 · 회전');
});

await section('진짜 모듈: 터치 기기에서 조이스틱·버튼이 진짜 플레이어를 움직임', async () => {
  const g = await freshReal({ touch: true, viewport: { width: 844, height: 390 } });
  const { page } = g;
  if (!g.real) { await g.close(); return; }
  await page.fill('#ui-nick', '별이');
  await page.tap('#ui-start', { force: true });
  await g.ev(() => { RNG.seed(7); Debug.god = true; });                                   // 슬라임이 때려서 조작을 방해하지 않게 (UI 확인이 목적)
  await step(page, 150);
  let s = await g.state();
  check('터치 기기: 시작하면 터치 컨트롤이 나타남', s.touchVisible && s.scene === 'play');
  const ptr = (sel, type, id, x, y) => g.ev(([sel, type, id, x, y]) => { const el = document.querySelector(sel); const r = el.getBoundingClientRect(); el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true, clientX: x === undefined ? r.left + r.width / 2 : x, clientY: y === undefined ? r.top + r.height / 2 : y })); }, [sel, type, id, x, y]);
  const base = await rectOf(g, '.tc-base');
  const cx = base.x + base.w / 2, cy = base.y + base.h / 2, R = base.w / 2;
  const x0 = await g.ev(() => Game.player.x);
  await ptr('.tc-stick', 'pointerdown', 41, cx + R * 0.85, cy);
  await step(page, 30);
  const x1 = await g.ev(() => Game.player.x);
  check('조이스틱을 오른쪽으로 밀면 진짜 플레이어가 오른쪽으로 걸어감', x1 > x0 + 40, `${x0} → ${x1}`);
  await ptr('.tc-stick', 'pointerup', 41);
  await step(page, 10);
  const x2 = await g.ev(() => Game.player.x);
  await step(page, 10);
  check('손을 떼면 멈춤 (음성 확인)', (await g.ev(() => Game.player.x)) === x2);
  // 멀티터치: 스틱을 민 채로 점프 버튼 → 걸으면서 점프
  await ptr('.tc-stick', 'pointerdown', 42, cx + R * 0.85, cy);
  await ptr('.tc-jump', 'pointerdown', 43);
  await step(page, 4);
  const j = await g.ev(() => ({ z: Game.player.z, vx: Game.player.state, x: Game.player.x }));
  check('스틱을 민 채로 점프 버튼도 누를 수 있음 (멀티터치) → 진짜 플레이어가 떠오름', j.z > 0, JSON.stringify(j));
  await ptr('.tc-jump', 'pointerup', 43); await ptr('.tc-stick', 'pointerup', 42);
  await step(page, 80);
  // 공격 버튼
  await ptr('.tc-atk', 'pointerdown', 44);
  await step(page, 3);
  check('공격 버튼 → 진짜 플레이어가 공격', await g.ev(() => Game.player.state === 'attack'));
  await ptr('.tc-atk', 'pointerup', 44);
  await step(page, 60);
  // 스킬 버튼 → 쿨타임이 시작되고 버튼에 초가 표시됨
  await ptr('.tc-skill[data-key=KeyA]', 'pointerdown', 45);
  await step(page, 3);
  await ptr('.tc-skill[data-key=KeyA]', 'pointerup', 45);
  await step(page, 4);
  await g.ev(() => Loop.draw());
  const sk = await g.ev(() => { const b = document.querySelector('.tc-skill[data-key=KeyA]'); return { cd: Game.player.skills[0].cd, ready: b.dataset.ready, sec: b.querySelector('.tc-sec').textContent, label: b.getAttribute('aria-label') }; });
  check('스킬 A 를 쓰면 터치 버튼이 쿨타임(초 숫자)으로 바뀜', sk.cd > 0 && sk.ready === '0' && /^\d+$/.test(sk.sec), JSON.stringify(sk));
  // 일시정지 → 터치 컨트롤이 사라지고 눌린 키가 풀림
  await ptr('.tc-stick', 'pointerdown', 46, cx + R * 0.85, cy);
  await page.tap('#ui-pause', { force: true });
  s = await g.state();
  check('일시정지 버튼(터치) → 일시정지 화면, 터치 컨트롤은 숨고 눌려 있던 방향키도 풀림', s.paused && s.pauseVisible && !s.touchVisible && (await g.ev(() => !Input.isDown('ArrowRight'))), JSON.stringify([s.paused, s.pauseVisible, s.touchVisible]));
  await g.done('터치 + 진짜 모듈');
});

await section('진짜 Server 와 함께: 검증 문구 · 내 기기에만 저장 · 랭킹에 내 줄 강조', async () => {
  const g = await freshReal();
  const { page } = g;
  const realServer = await g.ev(() => typeof Server.validateNickname === 'function' && typeof Server.saveScore === 'function' && typeof Server.getTopScores === 'function' && Server.available === false && typeof Server.local !== 'undefined');
  check('[진짜 모듈] Server 가 로드됨 (validateNickname/saveScore/getTopScores/local)', realServer);
  if (!g.real || !realServer) { await g.close(); return; }
  // 서버의 닉네임 검증 문구가 그대로 화면에 나옴
  await page.fill('#ui-nick', 'a');
  await page.click('#ui-start', { force: true });
  const want = await g.ev(() => Server.validateNickname('a').error);
  check('서버 검증이 거절한 이름 → 서버가 준 한글 문구가 (「이름」만 「별명」으로 바뀌어) 표시되고 시작 안 함', want.length > 3 && (await g.state()).nickError === want.replace(/이름/g, '별명') && /별명/.test(want.replace(/이름/g, '별명')) && (await g.state()).scene === 'title' && (await g.ev(() => T.started.length)) === 0, want);
  await page.fill('#ui-nick', '  별이  ');
  await page.click('.diff-card[data-diff=hard]');
  await page.click('#ui-start', { force: true });
  check('서버가 다듬어 준 이름(앞뒤 공백 제거)으로 시작', await g.ev(() => Game.nickname === '별이' && document.getElementById('ui-nick').value === '별이' && T.started.length === 1));
  await step(page, 100);
  await g.ev(() => { Game.score = 1234; Combat.damage(Game.player, 9999, { sfx: 'hurt' }); });
  await step(page, 400);
  await wait(500);
  const r = await g.ev(() => ({ scene: Game.scene, save: UI.state().saveState, text: document.querySelector('.save-text').textContent, rows: [...document.querySelectorAll('#ui-result .rank-row')].map(x => ({ me: x.dataset.me, t: x.textContent })), saves: T.saves.length }));
  check('게임 오버 → 진짜 Server 가 기기에 저장: 「내 기기에만 저장됐어요」', r.scene === 'result' && r.save === 'local' && r.text.includes('내 기기에만') && r.saves === 1, JSON.stringify([r.scene, r.save, r.text]));
  check('랭킹에 내 기록이 나오고 「나」로 강조됨 (점수 1,234)', r.rows.length === 1 && r.rows[0].me === '1' && r.rows[0].t.includes('별이') && r.rows[0].t.includes('1,234'), JSON.stringify(r.rows));
  // 한 판 더 하고 더 높은 점수 → 같은 이름은 최고 점수 한 줄로
  await page.click('#ui-again');
  await step(page, 100);
  await g.ev(() => { Game.score = 5000; Combat.damage(Game.player, 9999, { sfx: 'hurt' }); });
  await step(page, 400); await wait(500);
  const r2 = await g.ev(() => [...document.querySelectorAll('#ui-result .rank-row')].map(x => x.textContent));
  check('같은 이름으로 다시 하면 랭킹에는 내 최고 점수 한 줄 (5,000)', r2.length === 1 && r2[0].includes('5,000'), JSON.stringify(r2));
  await page.click('#ui-toTitle');
  await page.click('#ui-rank');
  await wait(400);
  check('타이틀의 「랭킹」 창에도 같은 기록이 보임', await g.ev(() => document.querySelectorAll('#ui-rank-modal .rank-row').length === 1 && document.querySelector('#ui-rank-modal .rank-row').textContent.includes('5,000')));
  await g.done('진짜 Server');
});

// ===========================================================================
// 13. QA 수정 (2차): 세로 안내 · 결과/일시정지 키 보호 · 토스트 · 줄바꿈 · 접근성 · 터치
//     (각 구역은 "고치기 전 코드로는 실패" 하도록 만들었어요 — 고친 줄을 되돌려 확인함)
// ===========================================================================
const fakeKeyDown = (g, code, extra = {}) => fakeKey(g, 'keydown', code, extra);

await section('세로 안내가 떠 있을 때: 시작·다시 하기·계속하기가 안 보이는 채로 게임을 돌리지 않음 (GP-1/UI-03)', async () => {
  const g = await fresh({ viewport: { width: 600, height: 900 } });
  const { page } = g;
  await g.ev(() => { window.PAUSES = []; Events.on('paused', d => PAUSES.push(!!(d && d.on))); });
  check('(전제) 600x900 창(마우스)에서도 "가로로 돌려 주세요" 안내가 떠 있음', (await g.state()).portrait && (await g.ev(() => getComputedStyle(document.getElementById('ui-rotate')).display)) === 'flex');
  // 별명 칸에서 Enter 로 시작 (안내 뒤에서 눈먼 채로)
  await page.fill('#ui-nick', '세로'); await page.focus('#ui-nick'); await page.keyboard.press('Enter');
  await step(page, 120);
  let r = await g.ev(() => ({ scene: Game.scene, paused: Game.paused, frame: Game.frame }));
  check('세로 안내 위에서 Enter 로 시작해도 판은 "멈춘 채" 열리고 프레임이 흐르지 않음', r.scene === 'play' && r.paused && r.frame === 0, JSON.stringify(r));
  await page.keyboard.press('Escape'); await page.keyboard.press('KeyP');
  check('Esc/P 로도 안내 뒤에서 풀리지 않음', await g.ev(() => Game.paused));
  await g.ev(() => { PAUSES.length = 0; });
  await g.ev(() => UI.resume());
  await g.ev(() => document.getElementById('ui-resume').click());                              // (자동 포커스된 「계속하기」 에서 Enter 를 친 것과 같음)
  await step(page, 60);
  r = await g.ev(() => ({ paused: Game.paused, frame: Game.frame, ev: PAUSES.slice() }));
  check('「계속하기」(UI.resume/버튼)도 안내가 떠 있는 동안은 아무 일도 안 함 (풀었다 다시 멈추지도 않음: paused 이벤트 0번)', r.paused && r.frame === 0 && r.ev.length === 0, JSON.stringify(r));
  // 결과 화면의 「다시 하기」 도
  await toResult(g, RES({ cleared: false, stars: 0, deaths: 3 }));
  await g.ev(() => { UI_TUNE.result.keyLockMs = 0; });
  await g.ev(() => document.getElementById('ui-again').click());
  r = await g.ev(() => ({ scene: Game.scene, paused: Game.paused, started: T.started.length }));
  check('세로 안내 위에서 「다시 하기」를 눌러도 새 판은 멈춘 채 열림', r.scene === 'play' && r.paused && r.started >= 1, JSON.stringify(r));
  await step(page, 60);
  check('…그리고 프레임이 흐르지 않음 (목숨을 잃지 않음)', (await g.ev(() => Game.frame)) === 0);
  // 가로로 돌리면: 안내가 사라지고 일시정지 화면이 남아, 계속하기가 이제 됨
  await page.setViewportSize({ width: 1000, height: 700 });
  await wait(300);
  let s = await g.state();
  check('가로로 돌리면 안내가 사라지고 일시정지 화면이 보임 (자동 재개 안 함)', !s.portrait && s.paused && s.pauseVisible);
  await g.ev(() => UI.resume());
  s = await g.state();
  check('이제 계속하기가 됨', !s.paused && !s.pauseVisible);
  await g.done('세로 안내');
});

await section('결과: 꾹 누른 Space(자동 반복)와 연타로 「다시 하기」가 눌리지 않음 (UI-01)', async () => {
  const g = await fresh();
  const { page } = g;
  const lock = await g.ev(() => UI_TUNE.result.keyLockMs), tune = await g.ev(() => UI_TUNE.result);
  check('결과 직후 키 잠금 시간이 마지막 별이 뜨는 시점(시작 + 2×간격 프레임 ≈ 1.47초)보다 김', lock >= (tune.startDelay + 2 * tune.starGap) / 60 * 1000, `lock=${lock}`);
  // 1) 공격 키(Space)를 누른 채 결과 화면이 열림 → 잠금 시간이 지난 뒤에도 자동 반복 keydown 이 계속 옴 → 놓음
  await g.ev(() => { UI_TUNE.result.keyLockMs = 250; });                                         // (시간 잠금은 짧게: 반복 잠금이 시간과 상관없음을 보려고)
  await toPlay(g);
  await page.keyboard.down('Space');
  await toResult(g, RES({ cleared: false, stars: 0, deaths: 3 }));
  for (let i = 0; i < 6; i++) { await wait(120); await page.keyboard.down('Space'); }            // (이미 눌린 키를 또 down = repeat:true)
  await page.keyboard.up('Space');
  await step(page, 3);
  check('Space 를 꾹 누른 채(잠금 시간 뒤에도 반복 입력) 결과 화면이 열려도 「다시 하기」가 눌리지 않음', await g.ev(() => Game.scene === 'result' && T.started.length === 0), await g.ev(() => Game.scene + ' started=' + T.started.length));
  await page.keyboard.press('Space');
  await step(page, 3);
  check('일부러 새로 누른 Space(자동 반복이 아님)는 잠금 뒤에 「다시 하기」를 누름', await g.ev(() => Game.scene === 'play' && T.started.length === 1));
  // 2) 같은 일을 Enter 로
  await toResult(g, RES({ cleared: false, stars: 0, deaths: 3 }));
  await page.keyboard.down('Enter');
  for (let i = 0; i < 4; i++) { await wait(140); await page.keyboard.down('Enter'); }
  await page.keyboard.up('Enter');
  await step(page, 3);
  check('Enter 를 꾹 눌러도(자동 반복) 눌리지 않음', await g.ev(() => Game.scene === 'result' && T.started.length === 1));
  // 3) 연타(반복이 아닌 여러 번 누름)는 진짜 잠금 시간(1.6초) 안에서는 눌리지 않음
  await g.ev(() => { UI_TUNE.result.keyLockMs = 1600; });
  await toResult(g, RES({ cleared: false, stars: 0, deaths: 3 }));
  const tMash = Date.now();
  while (Date.now() - tMash < 1300) { await page.keyboard.press('Space'); await wait(150); }      // 1.3초 동안 150ms 마다 연타 (기계가 느려도 잠금 1.6초 안에서만 누름)
  await step(page, 3);
  check('결과가 뜬 뒤 1.3초 동안 150ms 마다 Space 를 연타해도(진짜 잠금 값 1600ms) 별이 다 뜨기 전에 다시 시작되지 않음', await g.ev(() => Game.scene === 'result' && T.started.length === 1), await g.ev(() => Game.scene));
  await g.done('결과 반복 잠금');
});

await section('일시정지: 더블클릭·Enter 꾹 누름이 「정말요? 한 번 더」 확인을 뚫지 못함 (UI-02)', async () => {
  const g = await fresh();
  const { page } = g;
  const guard = await g.ev(() => UI_TUNE.confirmGuardMs);
  check('확인 보호 시간(confirmGuardMs)이 있고 더블클릭보다 길며 확인 제한 시간보다 짧음', guard >= 300 && guard < (await g.ev(() => UI_TUNE.confirmMs)), String(guard));
  await g.ev(() => { Game.nickname = '테스트'; T.started.length = 0; });
  await toPlay(g);
  await g.ev(() => Game.pause(true));
  await page.dblclick('#ui-restart');
  let r = await g.ev(() => ({ started: T.started.length, paused: Game.paused, txt: document.getElementById('ui-restart').textContent }));
  check('「다시 시작」 더블클릭: 시작되지 않고 멈춘 채, 버튼은 아직 "한 번 더" 확인 상태', r.started === 0 && r.paused && /한 번 더/.test(r.txt), JSON.stringify(r));
  await page.dblclick('#ui-home');
  r = await g.ev(() => ({ scene: Game.scene, paused: Game.paused }));
  check('「처음으로」 더블클릭: 타이틀로 가지 않음', r.scene === 'play' && r.paused, JSON.stringify(r));
  await wait(guard + 100);
  await page.click('#ui-home');                                                                  // 보호 시간이 지난 뒤의 일부러 누름은 통함
  check('보호 시간이 지난 뒤 한 번 더 누르면 실행됨 (정상 확인은 그대로)', (await g.state()).scene === 'title');
  // Enter 꾹 누름: 첫 keydown(arm) 뒤로 자동 반복이 보호 시간(500ms)을 넘겨 계속 와도 실행되지 않음
  await g.ev(() => { Game.nickname = '테스트'; T.started.length = 0; UI_TUNE.confirmMs = 9000; });   // (느린 기계에서도 확인 제한 시간 안에서 확인)
  await toPlay(g);
  await g.ev(() => Game.pause(true));
  await g.ev(() => document.getElementById('ui-restart').focus());
  await page.keyboard.down('Enter');
  for (let i = 0; i < 9; i++) { await wait(110); await page.keyboard.down('Enter'); }            // 약 1초 동안 자동 반복
  await page.keyboard.up('Enter');
  r = await g.ev(() => ({ started: T.started.length, paused: Game.paused, txt: document.getElementById('ui-restart').textContent }));
  check('Enter 를 1초 꾹 눌러도 다시 시작되지 않음 (자동 반복 Enter 는 삼킴)', r.started === 0 && r.paused && /한 번 더/.test(r.txt), JSON.stringify(r));
  await page.keyboard.press('Enter');
  check('그 다음 새로 누른 Enter 는 확인으로 통해 다시 시작됨', await g.ev(() => T.started.length === 1 && !Game.paused));
  await g.done('일시정지 확인 보호');
});

await section('휴식 알림: 싸우는 중엔 잠깐 미루고, 토스트가 보스 체력바를 가리지 않음 (UI-08)', async () => {
  const g = await fresh({ viewport: { width: 844, height: 390 } });
  const { page } = g;
  await toPlay(g);
  await g.ev(() => { FX.reduceMotion = true; Game.touch = false; Game.score = 100; Game.boss = { name: '젤리 대왕', hp: 200, maxHp: 300, boss: true }; for (let i = 0; i < 5; i++) PX.draw(); UI.toast('휴식 알림 모양', 5000); });
  const geo = await g.ev(() => {
    const cv = document.getElementById('game').getBoundingClientRect(), u = cv.width / W, t = document.querySelector('.toast').getBoundingClientRect();
    const bar = { l: cv.left + 256 * u, r: cv.left + 704 * u, t: cv.top + (UI_TUNE.hud.bossBarY - 40) * u, b: cv.top + (UI_TUNE.hud.bossBarY + 36) * u };   // 보스 체력바 카드 (논리 좌표 x 256~704, y 98~174)
    const inter = !(t.right <= bar.l || t.left >= bar.r || t.bottom <= bar.t || t.top >= bar.b);
    return { inter, toastTop: (t.top - cv.top) / u, toastBottom: (t.bottom - cv.top) / u, barB: (bar.b - cv.top) / u };
  });
  check('보스 체력바가 떠 있는 동안 토스트는 체력바 카드(y 98~174) 아래에 놓임 (겹치지 않음)', !geo.inter && geo.toastTop >= geo.barB - 1, JSON.stringify(geo));
  await g.ev(() => { Game.boss = null; for (let i = 0; i < 3; i++) PX.draw(); document.querySelectorAll('.toast').forEach(t => t.remove()); });
  check('보스가 사라지면 토스트가 다시 위쪽 자리로', await g.ev(() => { UI.toast('x', 3000); const cv = document.getElementById('game').getBoundingClientRect(), u = cv.width / W, t = document.querySelector('.toast').getBoundingClientRect(); return (t.top - cv.top) / u < 130; }));
  // 휴식 알림 미루기
  await g.ev(() => { document.querySelectorAll('.toast').forEach(t => t.remove()); CFG.breakReminderMinutes = 0.01; UI.resetBreakTimer(); Stage.state = 'fight'; });
  await step(page, 120);
  check('싸우는 중(Stage.state=fight)에는 알림 시간이 지나도 휴식 알림이 미뤄짐', (await g.state()).breakMsgs === 0 && (await g.ev(() => document.querySelectorAll('.toast').length)) === 0);
  await g.ev(() => { Stage.state = 'clear'; });
  await step(page, 3);
  check('방을 깨고 숨 돌릴 때(clear) 곧바로 보임', (await g.state()).breakMsgs === 1 && (await g.ev(() => [...document.querySelectorAll('.toast')].some(t => t.textContent.includes('잠깐 쉬어요')))));
  // 너무 오래 싸우면 그래도 보여줌
  await g.ev(() => { document.querySelectorAll('.toast').forEach(t => t.remove()); UI.resetBreakTimer(); UI_TUNE.breakDeferTicks = 50; Stage.state = 'fight'; });
  await step(page, 36 + 40);
  check('(미루는 한도 안에서는 여전히 미룸)', (await g.state()).breakMsgs === 1);
  await step(page, 30);
  check('미루는 한도(breakDeferTicks)를 넘기면 싸우는 중이어도 그냥 보여줌 (영영 안 뜨지 않음)', (await g.state()).breakMsgs === 2);
  await g.ev(() => { Stage.state = 'idle'; CFG.breakReminderMinutes = 30; UI_TUNE.breakDeferTicks = 1800; });
  await g.done('휴식 알림 미루기');
});

await section('한글 줄바꿈은 낱말(띄어쓰기) 단위: "돌려 주세/요" 처럼 끝 글자만 남지 않음 (UI-09)', async () => {
  // el 안의 글자를 한 글자씩 훑어, 공백이 아닌 두 글자 사이에서 줄이 바뀐 곳이 있으면 그 위치를 돌려준다
  const midWordBreaks = sel => `(() => { const out = []; for (const el of document.querySelectorAll(${JSON.stringify(sel)})) { const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { const t = n.textContent, rect = i => { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 1); const b = r.getClientRects()[0]; return b ? Math.round(b.top) : null; }; for (let i = 0; i + 1 < t.length; i++) { if (/\\s/.test(t[i]) || /\\s/.test(t[i + 1])) continue; const a = rect(i), b = rect(i + 1); if (a !== null && b !== null && Math.abs(a - b) > 3) out.push(t.slice(Math.max(0, i - 3), i + 3)); } } } return out; })()`;
  let g = await fresh({ viewport: { width: 320, height: 568 } });
  check('세로 안내 문구(h2/p)의 줄바꿈이 word-break: keep-all', await g.ev(() => ['.rotate h2', '.rotate p'].every(s => getComputedStyle(document.querySelector(s)).wordBreak === 'keep-all')));
  let bad = await g.ev(midWordBreaks('.rotate h2, .rotate p'));
  check('320px 폭의 "가로로 돌려 주세요" 가 낱말 중간에서 끊기지 않음', bad.length === 0, JSON.stringify(bad));
  check('(줄이 실제로 바뀌는 좁은 폭이었음)', await g.ev(() => { const h = document.querySelector('.rotate h2'), lh = parseFloat(getComputedStyle(h).lineHeight) || parseFloat(getComputedStyle(h).fontSize) * 1.2; return h.getBoundingClientRect().height > lh * 1.5; }));
  await g.close();
  g = await fresh({ viewport: { width: 568, height: 320 } });
  bad = await g.ev(midWordBreaks('.diff-desc, .diff-label, .nick-hint, .corner-btns .btn'));
  check('568x320 타이틀: 난이도 설명 등이 낱말 중간에서 끊기지 않음 ("게임 오버가 없어/요!" 같은 일이 없음)', bad.length === 0, JSON.stringify(bad));
  await g.ev(() => document.getElementById('ui-help').click());
  await wait(80);
  bad = await g.ev(midWordBreaks('#ui-help-modal .help-note, #ui-help-modal .keys li'));
  check('568x320 조작법 창: 안내 글이 낱말 중간에서 끊기지 않음 ("버/튼으로" 같은 일이 없음)', bad.length === 0, JSON.stringify(bad));
  await g.done('줄바꿈');
});

await section('접근성: 캔버스 이름표 · 소리 버튼 이름은 그대로 + 눌림 상태 · 화면 읽기 알림 (UI-11)', async () => {
  const g = await fresh();
  const { page } = g;
  const cv = await g.ev(() => { const c = document.getElementById('game'); return { role: c.getAttribute('role'), label: c.getAttribute('aria-label') }; });
  check('게임 캔버스에 role=img 와 이름표(젤리 던전 게임 화면)가 있음', cv.role === 'img' && /젤리 던전/.test(cv.label || ''), JSON.stringify(cv));
  const mute = () => g.ev(() => { const b = document.getElementById('ui-mute'); return { label: b.getAttribute('aria-label'), pressed: b.getAttribute('aria-pressed'), muted: SFX.muted }; });
  const m0 = await mute();
  await g.ev(() => UI.toggleMute());
  const m1 = await mute();
  await g.ev(() => UI.toggleMute());
  const m2 = await mute();
  check('소리 버튼: 이름(aria-label)은 늘 같고, 켜짐/꺼짐은 aria-pressed 만 바뀜 ("소리 켜기, 눌림" 처럼 앞뒤가 안 맞게 읽히지 않음)', m0.label === m1.label && m1.label === m2.label && m0.pressed === String(m0.muted) && m1.pressed === String(m1.muted) && m0.pressed !== m1.pressed, JSON.stringify([m0, m1, m2]));
  const live = await g.ev(() => { const l = document.getElementById('ui-live'); return l ? { live: l.getAttribute('aria-live'), role: l.getAttribute('role'), vis: getComputedStyle(l).position === 'absolute' && l.getBoundingClientRect().width <= 2 } : null; });
  check('화면에는 안 보이고 읽기 도구에만 알려 주는 알림 칸(aria-live=polite)이 있음', !!live && live.live === 'polite' && live.vis, JSON.stringify(live));
  await toPlay(g);
  const say = fn => g.ev(fn).then(() => g.ev(() => document.getElementById('ui-live').textContent.replace(/​/g, '')));
  check('방이 시작되면 "방 2 / 5, 달콤한 오솔길. 체력 100, 목숨 3개" 처럼 방 이름과 체력·목숨을 알려 줌', (await say(() => Events.emit('roomStarted', { index: 1, room: { name: '달콤한 오솔길' } }))) === '방 2 / 5, 달콤한 오솔길. 체력 100, 목숨 3개');
  check('쉬움(목숨 ∞)이면 "목숨 무한"', (await say(() => { Game.lives = Infinity; Events.emit('roomStarted', { index: 0, room: { name: '숲 입구' } }); Game.lives = 3; })) === '방 1 / 5, 숲 입구. 체력 100, 목숨 무한');
  check('보스가 나타나면 알려 줌', /보스/.test(await say(() => Events.emit('bossSpawned', {}))));
  const low = await say(() => { Game.player.hp = 20; Events.emit('playerHit', { target: Game.player, dmg: 5 }); });
  check('체력이 위험해지면 한 번 알려 줌 (체력/남았어요)', /체력/.test(low) && /20/.test(low), low);
  await g.ev(() => { document.getElementById('ui-live').textContent = 'x'; Game.player.hp = 15; Events.emit('playerHit', { target: Game.player, dmg: 5 }); });
  check('위험 알림은 또 맞아도 반복해서 떠들지 않음 (다시 살아나면 다시 알림)', (await g.ev(() => document.getElementById('ui-live').textContent)) === 'x');
  await g.ev(() => { Events.emit('playerRevived', Game.player); Game.player.hp = 10; Events.emit('playerHit', { target: Game.player, dmg: 5 }); });
  check('부활 뒤에는 다시 알려 줌', /체력/.test(await g.ev(() => document.getElementById('ui-live').textContent)));
  await g.done('접근성 2');
});

await section('터치: 일시정지·Input.clear() 뒤에도 손가락이 아직 스틱 위에 있으면 다시 움직임 (R-09)', async () => {
  const g = await fresh({ touch: true, viewport: { width: 844, height: 390 } });
  const { page, context } = g;
  await toPlay(g);
  await g.ev(() => { Debug.god = true; });
  const cdp = await context.newCDPSession(page);
  const base = await rectOf(g, '.tc-base');
  const bx = base.x + base.w * 0.85, by = base.y + base.h / 2;
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 7 }] });
  const px = () => g.ev(() => Game.player.x);
  await touch('touchStart', bx, by);
  let x0 = await px(); await step(page, 30); let x1 = await px();
  check('(기준) 스틱을 오른쪽으로 밀면 플레이어가 걸어감', x1 > x0 + 40 && (await g.ev(() => Input.isDown('ArrowRight'))), `${x0} → ${x1}`);
  // 손가락을 댄 채로 일시정지 → 계속하기
  await g.ev(() => { Game.pause(true); Game.pause(false); });
  check('일시정지로 방향키가 풀림 (손가락은 그대로)', !(await g.ev(() => Input.isDown('ArrowRight'))));
  await touch('touchMove', bx + 1, by);                                                          // 손가락이 살짝 움직임 (새 touchStart 는 없음)
  await touch('touchMove', bx + 2, by);
  x0 = await px(); await step(page, 30); x1 = await px();
  check('일시정지 뒤 손가락이 스틱 위에서 움직이면 새로 안 눌러도 → 방향키가 다시 눌려 걸어감', (await g.ev(() => Input.isDown('ArrowRight'))) && x1 > x0 + 40, `${x0} → ${x1}`);
  // 일시정지 없이 Input.clear() 만 (장면 전환·창 포커스 등)
  await g.ev(() => Input.clear());
  await touch('touchMove', bx, by);
  await touch('touchMove', bx + 1, by);
  check('Input.clear() 뒤에도 같은 손가락의 다음 움직임으로 방향키가 다시 눌림', await g.ev(() => Input.isDown('ArrowRight')));
  await touch('touchEnd');
  await wait(50);
  check('손을 떼면 풀림 (고착 없음)', !(await g.ev(() => Input.isDown('ArrowRight'))));
  // 터치 화면 + 물리 키보드: 키보드로 방향키를 누르면 터치 컨트롤이 치워지면서 스틱을 놓는 처리가 불리는데, 그때 키보드로 누른 방향키까지 풀어 버리면 안 됨
  await page.keyboard.down('ArrowRight');
  check('키보드로 누른 →가 터치 컨트롤이 치워지는 순간에도 눌린 채', (await g.state()).kbdUsed && !(await g.state()).touchVisible && await g.ev(() => Input.isDown('ArrowRight')));
  await page.keyboard.up('ArrowRight');
  await g.done('터치 재개');
});


// ---------------------------------------------------------------------------
// 저장 실패 다시 보내기 / 랭킹 탭 / 이 기기 기록 표시 / 지난 판 랭킹 비우기
// ---------------------------------------------------------------------------
await section('결과: 서버에 못 올렸을 때 「다시 보내기」 (GAS-03) · 서버가 거절하면 버튼 없음', async () => {
  const g = await fresh();
  const { page } = g;
  const last = () => g.ev(() => T.saveCbs.length - 1);
  const answer = async (res) => { await toResult(g, RES()); await g.ev(r => T.saveCbs[T.saveCbs.length - 1].res(r), res); await wait(100); return resInfo(g); };
  let r = await answer({ ok: true, source: 'local', warning: 'server_failed', retryable: true, error: '서버가 10초 안에 답하지 않았어요' });
  check('서버 실패로 내 기기에만 저장되면 → "다시 보내 볼까요?" 문구와 「다시 보내기」 버튼이 보임', r.save === 'local' && r.saveText.includes('내 기기에만') && r.saveText.includes('다시 보내') && r.retryVisible && await g.ev(() => document.querySelector('#ui-result .save').dataset.retry === '1' && UI.state().saveRetry), JSON.stringify([r.save, r.saveText, r.retryVisible]));
  check('(그 상태에서도 랭킹은 보여줌)', r.rows.length === 4);
  const before = r.saves;
  await page.click('#ui-retry');
  r = await resInfo(g);
  check('「다시 보내기」 → 같은 기록으로 saveScore 를 한 번 더 부르고 "저장 중"', r.saves === before + 1 && r.save === 'saving' && !r.retryVisible, JSON.stringify([r.saves, r.save]));
  check('다시 보낸 기록이 처음과 똑같음 (같은 별명·점수·난이도)', await g.ev(() => { const a = T.saves[T.saves.length - 2], b = T.saves[T.saves.length - 1]; return JSON.stringify(a) === JSON.stringify(b); }));
  await g.ev(() => T.saveCbs[T.saveCbs.length - 1].res({ ok: true, source: 'server' }));
  await wait(100);
  check('다시 보내서 성공하면 "저장됐어요!"', (await resInfo(g)).save === 'saved');
  r = await answer({ ok: true, source: 'local', warning: 'server_failed', retryable: false, error: '점수가 너무 높아요' });
  check('서버가 기록 자체를 거절했으면(retryable:false) 다시 보내도 소용없으니 버튼 없음 (내 기기에만 저장)', r.save === 'local' && !r.retryVisible && await g.ev(() => document.querySelector('#ui-result .save').dataset.retry === '0'), JSON.stringify([r.save, r.retryVisible]));
  r = await answer({ ok: true, source: 'local', warning: 'no_server' });
  check('서버가 없는 환경(no_server)은 그냥 내 기기에만 (버튼 없음)', r.save === 'local' && !r.retryVisible);
  r = await answer({ ok: true, source: 'local' });
  check('경고 표시가 없는 local 응답도 버튼 없음', r.save === 'local' && !r.retryVisible);
  r = await answer({ ok: true, source: 'local', warning: 'server_failed', error: '?' });
  check('retryable 이 안 왔을 때(server_failed 만)는 다시 보내 볼 수 있다고 봄', r.save === 'local' && r.retryVisible);
  await g.done('저장 다시 보내기');
});

const CFG_LABEL = { easy: '쉬움', normal: '보통', hard: '어려움' };
await section('랭킹: 쉬움/보통/어려움 탭 (KIDS-09) · 이 기기 기록 표시 (GAS-07)', async () => {
  const g = await fresh();
  const { page } = g;
  const tabs = sel => g.ev(sel => [...document.querySelectorAll(sel + ' .rank-tab')].map(b => ({ d: b.dataset.diff, sel: b.getAttribute('aria-selected'), tab: b.tabIndex, text: b.textContent })), sel);
  // 결과 화면은 방금 한 난이도 탭으로 열림
  await toResult(g, RES({ difficulty: 'hard' }));
  let t = await tabs('#ui-result');
  check('결과 화면 랭킹에 탭 3개(쉬움/보통/어려움)가 있고 방금 한 난이도(어려움)가 선택됨', t.length === 3 && t.map(x => x.d).join() === 'easy,normal,hard' && t.filter(x => x.sel === 'true').map(x => x.d).join() === 'hard' && t.every(x => x.text.includes(CFG_LABEL[x.d])), JSON.stringify(t));
  check('선택된 탭만 tab 순서에 들어감 (roving tabindex) + 탭목록 역할', t.filter(x => x.tab === 0).length === 1 && await g.ev(() => document.querySelector('#ui-result .rank-tabs').getAttribute('role') === 'tablist' && document.querySelector('#ui-result .rank-tab').getAttribute('role') === 'tab'));
  await g.ev(() => T.saveCbs[0].res({ ok: true, source: 'server' }));
  await wait(120);
  check('저장이 끝나면 방금 난이도로 getTopScores(10, "hard") 를 부름', await g.ev(() => T.ranks.length === 1 && T.ranks[0] === 10 && T.rankDiffs[0] === 'hard'), JSON.stringify(await g.ev(() => [T.ranks, T.rankDiffs])));
  await page.click('#ui-result .rank-tab[data-diff="easy"]');
  await wait(100);
  t = await tabs('#ui-result');
  check('「쉬움」 탭을 누르면 getTopScores(10, "easy") 를 부르고 그 탭이 선택됨', await g.ev(() => T.rankDiffs[T.rankDiffs.length - 1] === 'easy' && T.ranks[T.ranks.length - 1] === 10) && t.filter(x => x.sel === 'true').map(x => x.d).join() === 'easy', JSON.stringify(t));
  // 키보드: 화살표로 탭 이동
  await g.ev(() => document.querySelector('#ui-result .rank-tab[data-diff="easy"]').focus());
  await page.keyboard.press('ArrowRight');
  await wait(100);
  check('탭에서 → 키: 다음 탭(보통)이 선택되고 그 난이도로 불러옴 + 포커스 이동', await g.ev(() => document.activeElement.dataset.diff === 'normal' && T.rankDiffs[T.rankDiffs.length - 1] === 'normal'));
  check('탭의 화살표 키가 게임 입력(Input)으로 새지 않음', await g.ev(() => !Input.isDown('ArrowRight') && !Input.wasPressed('ArrowRight')));
  // 늦게 온 이전 탭의 응답은 무시
  await g.ev(() => {
    window.PEND = [];
    Server.getTopScores = (n, d) => new Promise(res => PEND.push({ d, res }));
  });
  await page.click('#ui-result .rank-tab[data-diff="hard"]');
  await page.click('#ui-result .rank-tab[data-diff="easy"]');
  await g.ev(() => { PEND.find(p => p.d === 'easy').res([{ rank: 1, nickname: '쉬움친구', score: 100, stars: 1, difficulty: 'easy' }]); });
  await wait(60);
  await g.ev(() => { PEND.find(p => p.d === 'hard').res([{ rank: 1, nickname: '어려움친구', score: 999, stars: 3, difficulty: 'hard' }]); });
  await wait(60);
  check('먼저 누른 탭의 늦은 응답이 나중에 누른 탭 화면을 덮어쓰지 않음', await g.ev(() => { const n = [...document.querySelectorAll('#ui-result .rank-nick')].map(e => e.textContent); return n.length === 1 && n[0] === '쉬움친구'; }));
  // 서버 대신 이 기기의 기록이면 솔직하게
  const serve = src => g.ev(src => { Server.getTopScores = (n, d) => { T.ranks.push(n); T.rankDiffs.push(d); const rows = [{ rank: 1, nickname: '나', score: 5, stars: 1, difficulty: 'normal' }]; if (src) Object.defineProperty(rows, 'source', { value: src, enumerable: false }); return Promise.resolve(rows); }; }, src);
  const note = () => g.ev(() => { const n = document.querySelector('#ui-result .rank-note'); return { hidden: n.hidden, text: n.textContent, vis: !!n.offsetWidth }; });
  await serve('local');
  await page.click('#ui-result .rank-tab[data-diff="normal"]'); await wait(100);
  let nt = await note();
  check('서버 랭킹을 못 불러와 이 기기의 기록이면 "이 기기" 안내 줄이 보임 (서버 랭킹처럼 보이지 않게)', !nt.hidden && nt.vis && nt.text.includes('이 기기'), JSON.stringify(nt));
  await serve('server');
  await page.click('#ui-result .rank-tab[data-diff="hard"]'); await wait(100);
  nt = await note();
  check('서버 랭킹이면 그 안내 줄이 없음', nt.hidden && !nt.vis, JSON.stringify(nt));
  await serve(undefined);
  await page.click('#ui-result .rank-tab[data-diff="easy"]'); await wait(100);
  check('출처 표시(source)가 없는 응답에도 죽지 않고 안내 줄 없음', (await note()).hidden);
  await serve('local');
  await g.ev(() => Game.setScene('title'));
  await page.click('.diff-card[data-diff="hard"]');
  await page.click('#ui-rank'); await wait(120);
  check('타이틀의 「랭킹」 창: 고른 난이도(어려움) 탭으로 열리고 이 기기 안내가 보임', await g.ev(() => { const t = [...document.querySelectorAll('#ui-rank-modal .rank-tab')].filter(b => b.getAttribute('aria-selected') === 'true').map(b => b.dataset.diff); const n = document.querySelector('#ui-rank-modal .rank-note'); return t.join() === 'hard' && !n.hidden && n.textContent.includes('이 기기') && T.rankDiffs[T.rankDiffs.length - 1] === 'hard'; }));
  await page.click('#ui-rank-modal .rank-tab[data-diff="easy"]'); await wait(100);
  check('랭킹 창에서 다른 탭을 누르면 그 난이도로 다시 불러옴', await g.ev(() => T.rankDiffs[T.rankDiffs.length - 1] === 'easy' && UI.state().rankTab === 'easy'));
  await g.done('랭킹 탭');
});
await section('결과: 새 판 결과 화면에 지난 판의 랭킹과 「나」 표시가 남지 않음 (UI-07)', async () => {
  const g = await fresh();
  const { page } = g;
  await g.ev(() => { window.ROWS = [{ rank: 1, nickname: '하늘', score: 11111, stars: 3, difficulty: 'normal' }]; });
  await toResult(g, RES({ score: 11111 }));
  await g.ev(() => T.saveCbs[0].res({ ok: true, source: 'server' }));
  await wait(120);
  check('(전제) 첫 판: 내 줄(11,111)이 「나」로 표시됨', await g.ev(() => document.querySelectorAll('#ui-result .rank-row.me').length === 1 && document.querySelector('#ui-result .rank-score').textContent === '11,111'));
  await g.ev(() => Game.setScene('title'));
  await toResult(g, RES({ score: 222 }));                                                        // 새 판: 저장 응답이 아직 안 옴
  await wait(150);
  const r = await resInfo(g);
  check('새 판에서 저장 중일 때 지난 판의 랭킹 줄(11,111)과 「나」 강조가 남아 있지 않음', r.save === 'saving' && r.rows.length === 0 && (await g.ev(() => document.querySelectorAll('#ui-result .rank-row.me').length)) === 0, JSON.stringify(r.rows));
  check('대신 "불러오는 중" 문구', r.rankStatus.includes('불러오는 중'), r.rankStatus);
  check('이 기기 안내 줄도 지난 판 것이 남지 않음', await g.ev(() => document.querySelector('#ui-result .rank-note').hidden));
  await g.done('지난 랭킹 비우기');
});

// ---------------------------------------------------------------------------
// 별명(KIDS-07/08) · 움직임 줄이기(KIDS-06) · 게임 오버 문구(KIDS-13)
// ---------------------------------------------------------------------------
await section('별명: 「내 이름」이 아니라 「별명」 · 처음엔 만들어 준 별명으로 바로 시작 · 🎲 주사위 (KIDS-07/08)', async () => {
  const g = await fresh();
  const { page } = g;
  const t = await g.ev(() => ({
    label: document.querySelector('.nick-label').textContent, ph: document.getElementById('ui-nick').placeholder, aria: document.getElementById('ui-nick').getAttribute('aria-label'),
    hint: document.getElementById('ui-nick-hint').textContent, desc: document.getElementById('ui-nick').getAttribute('aria-describedby'), all: document.getElementById('ui-title').textContent,
    val: document.getElementById('ui-nick').value, real: typeof Server.randomNickname === 'function',
  }));
  check('(전제) 진짜 Server.randomNickname 이 있음', t.real);
  check('칸 이름이 「별명」, 안내 글(placeholder/aria-label)도 별명 (2~8글자)', t.label === '별명' && /별명/.test(t.ph) && /2~8/.test(t.ph) && /별명/.test(t.aria), JSON.stringify([t.label, t.ph, t.aria]));
  check('타이틀 어디에도 「내 이름」이 없음', !t.all.includes('내 이름') && !t.ph.includes('이름 ') && !/내 이름/.test(t.aria));
  check('"진짜 이름은 쓰지 마요 · 랭킹에 모두에게 보여요" 안내 줄이 있고 입력칸에 연결(aria-describedby)됨', /진짜 이름/.test(t.hint) && /랭킹/.test(t.hint) && t.desc.includes('ui-nick-hint'), t.hint);
  check('저장된 별명이 없으면 칸에 별명이 미리 만들어져 있음 (2~8글자, 검사 통과)', t.val.length >= 2 && t.val.length <= 8 && await g.ev(() => UI.validateNickname(document.getElementById('ui-nick').value).ok && !Server.nickBlocked(document.getElementById('ui-nick').value)), t.val);   // (fresh() 는 서버 검증을 빼고 UI 안의 간단한 검사만 쓰게 해 둬요)
  // 글자를 하나도 안 치고 「시작!」
  const shown = t.val;
  await page.click('#ui-start', { force: true });
  await step(page, 2);
  check('아무것도 안 치고 「시작!」 → 만들어 준 별명으로 바로 시작 (Stage.start 에 그 별명이 전달됨)', await g.ev(v => T.started.length === 1 && T.started[0].nickname === v && Game.scene === 'play', shown), JSON.stringify(await g.ev(() => T.started)));
  check('시작한 별명이 기억됨 (Store)', await g.ev(v => Store.get('nickname') === v, shown));
  await g.ev(() => Game.setScene('title'));
  check('다음에 타이틀로 돌아오면 그 별명이 그대로 (새로 만들지 않음)', await g.ev(v => document.getElementById('ui-nick').value === v, shown));
  // 주사위
  const vals = new Set();
  for (let i = 0; i < 8; i++) { await page.click('#ui-dice'); vals.add(await g.ev(() => document.getElementById('ui-nick').value)); }
  check('🎲 를 누를 때마다 새 별명이 칸에 들어옴 (여러 가지가 나오고 모두 2~8글자·검사 통과)', vals.size >= 3 && [...vals].every(v => v.length >= 2 && v.length <= 8), JSON.stringify([...vals]));
  check('주사위 별명 40개가 모두 서버 금칙어 검사를 통과함', await g.ev(() => { for (let i = 0; i < 40; i++) { const n = Server.randomNickname(); if (Server.nickBlocked(n)) return false; } return true; }));
  check('주사위 버튼은 이름표가 있고 44px 이상', await g.ev(() => { const b = document.getElementById('ui-dice'), r = b.getBoundingClientRect(); return !!b.getAttribute('aria-label') && r.width >= 43.5 && r.height >= 43.5; }));
  check('주사위를 누르면 이전 오류 문구가 사라짐', await (async () => { await page.fill('#ui-nick', ''); await page.click('#ui-start', { force: true }); const had = (await g.state()).nickError.length > 0; await page.click('#ui-dice'); return had && (await g.state()).nickError === ''; })());
  // 직접 지우면 여전히 막힘 (친절한 문구 + 주사위 안내)
  await page.fill('#ui-nick', ''); await g.ev(() => { T.started.length = 0; });
  await page.click('#ui-start', { force: true });
  const e = (await g.state()).nickError;
  check('칸을 비우고 시작하면 막히고 "별명 / 2~8글자 / 🎲" 안내', (await g.state()).scene === 'title' && /별명/.test(e) && /2/.test(e) && /8/.test(e) && /🎲/.test(e), e);
  await page.fill('#ui-nick', '용사'); await page.click('#ui-start', { force: true });
  check('직접 쓴 별명도 그대로 됨', await g.ev(() => T.started.length === 1 && T.started[0].nickname === '용사'));
  await g.ev(() => { Store.set('nickname', '별이'); Game.nickname = ''; Game.setScene('title'); });
  check('기억해 둔 별명이 있으면 새로 만들지 않고 그걸 보여줌', await g.ev(() => document.getElementById('ui-nick').value === '별이'));
  await g.done('별명');
});

await section('별명: 진짜 Server 와 함께 — 서버가 거절한 문구의 「이름」은 「별명」으로', async () => {
  const g = await fresh();
  const { page } = g;
  await g.ev(() => { Server.validateNickname = raw => raw === '금지' ? { ok: false, error: '이 이름은 쓸 수 없어요. 다른 이름을 적어 줄래요?' } : { ok: true, value: raw.trim() }; });
  await page.fill('#ui-nick', '금지'); await page.click('#ui-start', { force: true });
  check('서버 문구의 「이름」이 「별명」으로 바뀌어 보임 (조사는 그대로 맞음)', (await g.state()).nickError === '이 별명은 쓸 수 없어요. 다른 별명을 적어 줄래요?', (await g.state()).nickError);
  await g.done('별명 문구');
});

await section('움직임 줄이기 스위치 (KIDS-06): 타이틀·일시정지에 있고, FX 에 반영 + 기억 + 새로고침 뒤에도 유지', async () => {
  const g = await fresh();
  const { page } = g;
  const st = () => g.ev(() => ({ fx: FX.reduceMotion, stored: Store.get('reduceMotion', null), calm: document.documentElement.getAttribute('data-calm'), t: document.getElementById('ui-motion').getAttribute('aria-pressed'), txt: document.getElementById('ui-motion').textContent, anim: getComputedStyle(document.getElementById('ui-start')).animationName, motion: UI.state().motion }));
  let s0 = await st();
  check('(기본) 움직임 줄이기가 꺼져 있고 스위치에 그 상태가 적혀 있음', s0.fx === false && s0.calm === '0' && s0.t === 'false' && /움직임 줄이기/.test(s0.txt) && s0.anim === 'breathe' && s0.motion === true, JSON.stringify(s0));
  check('스위치가 타이틀 화면에 보이고 44px 이상, 이름표(aria-label)와 눌림 상태(aria-pressed)가 있음', await g.ev(() => { const b = document.getElementById('ui-motion'), r = b.getBoundingClientRect(); return !!r.width && r.width >= 43.5 && r.height >= 43.5 && !!b.getAttribute('aria-label') && b.hasAttribute('aria-pressed'); }));
  const sig = () => g.ev(() => { Loop.draw(); const c = Loop.canvas, d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let h = 0; for (let i = 0; i < d.length; i += 97) h = (h * 31 + d[i]) | 0; return h; });
  const a1 = await sig(); await step(page, 37); const a2 = await sig();
  check('(켜기 전) 타이틀 배경이 움직임', a1 !== a2);
  await page.click('#ui-motion');
  let s1 = await st();
  check('스위치를 켜면 FX.reduceMotion=true, Store 에 기억, html[data-calm=1], aria-pressed=true, 문구 「켜짐」', s1.fx === true && s1.stored === true && s1.calm === '1' && s1.t === 'true' && /켜짐/.test(s1.txt) && s1.motion === false, JSON.stringify(s1));
  const b1 = await sig(); await step(page, 37); const b2 = await sig();
  check('켜면 타이틀 배경이 멈춤 (통통 튀는 장식 없음)', b1 === b2);
  check('켜면 「시작」 버튼의 맥박 CSS 애니메이션도 꺼짐', s1.anim === 'none');
  await page.click('#ui-motion');
  const s2 = await st();
  check('다시 누르면 꺼짐 (FX 와 Store 도 false, 애니메이션 복귀)', s2.fx === false && s2.stored === false && s2.calm === '0' && s2.anim === 'breathe', JSON.stringify(s2));
  // 일시정지 메뉴의 스위치도 같은 값
  await page.click('#ui-motion');                                                                // (다시 켬)
  await toPlay(g);
  await g.ev(() => Game.pause(true));
  const p0 = await g.ev(() => { const b = document.getElementById('ui-pause-motion'); return { pressed: b.getAttribute('aria-pressed'), txt: b.textContent, ico: b.querySelector('.ico').textContent, title: b.title, vis: !!b.offsetWidth, h: b.getBoundingClientRect().height }; });
  check('일시정지 화면에도 「움직임 줄이기」 스위치가 있고 지금 상태(켜짐)를 보여줌 (✅ 아이콘 + aria-pressed + 툴팁), 44px 이상', p0.vis && p0.pressed === 'true' && p0.ico === '✅' && /켜짐/.test(p0.title) && /움직임 줄이기/.test(p0.txt) && p0.h >= 43.5, JSON.stringify(p0));
  await page.click('#ui-pause-motion');
  const p1 = await g.ev(() => ({ fx: FX.reduceMotion, stored: Store.get('reduceMotion'), title: document.getElementById('ui-motion').getAttribute('aria-pressed'), pause: document.getElementById('ui-pause-motion').getAttribute('aria-pressed'), paused: Game.paused }));
  check('일시정지 화면에서 끄면 FX/Store/타이틀 스위치까지 함께 바뀌고 게임은 계속 멈춘 채', p1.fx === false && p1.stored === false && p1.title === 'false' && p1.pause === 'false' && p1.paused, JSON.stringify(p1));
  await page.click('#ui-pause-motion');                                                          // 켬
  check('(일시정지 화면의 스위치를 눌러도 계속하기가 되지 않음)', await g.ev(() => Game.paused && FX.reduceMotion === true));
  // 새로고침 뒤에도 유지
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof Loop !== 'undefined' && Loop.started === true, null, { timeout: 8000, polling: 50 });
  const s3 = await g.ev(() => ({ fx: FX.reduceMotion, calm: document.documentElement.getAttribute('data-calm'), t: document.getElementById('ui-motion').getAttribute('aria-pressed') }));
  check('새로고침 뒤에도 켜진 채 (Store 에서 복원) — 스위치 상태도 맞음', s3.fx === true && s3.calm === '1' && s3.t === 'true', JSON.stringify(s3));
  await g.done('움직임 줄이기');
});

await section('움직임 줄이기: 기기 설정(reduced-motion)이 켜져 있으면 처음부터 켜짐, 스위치로 끄면 기기 설정보다 스위치가 먼저', async () => {
  const g = await fresh({ context: { reducedMotion: 'reduce' } });
  const { page } = g;
  const st = () => g.ev(() => ({ fx: FX.reduceMotion, calm: document.documentElement.getAttribute('data-calm'), t: document.getElementById('ui-motion').getAttribute('aria-pressed'), anim: getComputedStyle(document.getElementById('ui-start')).animationName }));
  let s = await st();
  check('기기 설정이 "움직임 줄이기" 면 처음부터 켜짐 (스위치도 켜짐, CSS 애니메이션 없음)', s.fx === true && s.calm === '1' && s.t === 'true' && s.anim === 'none', JSON.stringify(s));
  await page.click('#ui-motion');
  s = await st();
  check('스위치로 일부러 끄면 기기 설정이 켜져 있어도 꺼짐 (움직임이 돌아옴) — 사용자가 고른 값이 먼저', s.fx === false && s.calm === '0' && s.t === 'false' && s.anim === 'breathe', JSON.stringify(s));
  check('그 선택이 기억됨', await g.ev(() => Store.get('reduceMotion') === false));
  await g.done('기기 설정 + 스위치');
});

await section('결과: 게임 오버 문구는 어디까지 왔는지에 맞춤 · 쉬운 낱말 (KIDS-13)', async () => {
  const g = await fresh();
  const { page } = g;
  const over = res => g.ev(res => { Game.stage = { id: 's', name: 'x', roomIndex: 0, roomCount: 5, roomName: 'x' }; Game.nickname = '하늘'; Game.difficulty = 'normal'; Game.result = res; Game.setScene('title'); Game.setScene('result'); return { msg: document.querySelector('.res-msg').textContent, groups: UI_TUNE.overGroups }; }, res);
  const G = { cleared: false, stars: 0, difficulty: 'normal', stageId: 'stage1', stageName: '사탕 숲', timeFrames: 3000, maxCombo: 3 };
  // QA 가 보고한 경우: 첫 방에서 3번 쓰러진 판(점수 100, 처치 1, 쓰러짐 3) 이 "거의 다 왔어요!" 였음
  let r = await over({ ...G, score: 100, kills: 1, deaths: 3, rooms: 0 });
  check('첫 방에서 쓰러졌으면 "거의 다 왔어요" 가 아니라 처음 방용 격려 문구', r.groups.early.includes(r.msg) && !/거의 다/.test(r.msg), r.msg);
  r = await over({ ...G, score: 900, kills: 5, deaths: 1, rooms: 1 });
  check('방 1개를 깨고 쓰러졌어도 처음 방용 문구', r.groups.early.includes(r.msg), r.msg);
  for (const rooms of [2, 3]) { r = await over({ ...G, score: 4000, kills: 12, deaths: 1, rooms }); check(`방 ${rooms}개를 깨고 쓰러지면 중간 방용 문구 (몬스터 머리의 "!" / 점프·스킬 알려줌)`, r.groups.mid.includes(r.msg), r.msg); }
  r = await over({ ...G, score: 9000, kills: 20, deaths: 1, rooms: 4 });
  check('대왕의 방(마지막 방)까지 왔으면 "거의 다 왔어요" 류 문구', r.groups.boss.includes(r.msg) && /거의 다|대왕/.test(r.msg), r.msg);
  r = await over({ ...G, score: 9000, kills: 20, deaths: 1, rooms: 4, roomCount: 7 });
  check('방 수는 res.roomCount 가 있으면 그걸 따름 (7방 중 4개를 깼으면 아직 대왕 전 → 중간 문구)', r.groups.mid.includes(r.msg), r.msg);
  await g.ev(() => { Game.stage.roomCount = 7; });
  r = await g.ev(() => { Game.stage = { id: 's', name: 'x', roomIndex: 6, roomCount: 7, roomName: 'x' }; Game.result = { cleared: false, score: 9000, stars: 0, timeFrames: 3000, kills: 20, deaths: 1, maxCombo: 3, difficulty: 'normal', stageId: 'stage1', stageName: '사탕 숲', rooms: 6 }; Game.setScene('title'); Game.setScene('result'); return { msg: document.querySelector('.res-msg').textContent, groups: UI_TUNE.overGroups }; });
  check('방이 7개인 스테이지(Game.stage.roomCount=7)에서 6방을 깨면 대왕 문구 (방 수를 5 로 굳히지 않음)', r.groups.boss.includes(r.msg), r.msg);
  check('모든 게임 오버 문구는 비난·어려운 말 없이 격려 (실패/못했/바보/졌 없음), 한 문장이 짧음', await g.ev(() => UI_TUNE.overMsgs.length >= 6 && UI_TUNE.overMsgs.every(m => !/실패|못했|바보|졌/.test(m) && m.length <= 34) && UI_TUNE.overMsgs.length === Object.values(UI_TUNE.overGroups).flat().length));
  // 낱말
  await toResult(g, RES({ deaths: 0 }));
  const w = await g.ev(() => ({ stat: [...document.querySelectorAll('.stat-grid li')].map(l => l.textContent).join('|'), badge: document.querySelector('.res-sub-row .badge').textContent, badgeHidden: document.querySelector('.res-sub-row .badge').hidden }));
  check('통계 칸의 「처치」 대신 「물리친 몬스터 N마리」', /물리친 몬스터/.test(w.stat) && !w.stat.includes('처치') && /24마리/.test(w.stat), w.stat);
  check('무사망 뱃지 문구는 「한 번도 안 쓰러졌어요!」 ("사망" 이라는 무거운 말을 안 씀)', !w.badgeHidden && w.badge === '한 번도 안 쓰러졌어요!' && !w.badge.includes('사망'), w.badge);
  await g.done('게임 오버 문구');
});

await section('결과 화면 낮은 가로 폰(300~412px 높이): 점수 칸·버튼이 잘리지 않음 — 저장 성공/실패 둘 다 (UI-04)', async () => {
  // [너비, 높이, 저장 실패(다시 보내기 버튼이 한 줄 더 차지)에서도 점수 칸이 다 보여야 하는지]
  const cases = [[740, 360, true], [792, 360, true], [667, 375, true], [844, 390, true], [915, 412, true], [568, 320, true], [660, 300, false]];
  for (const [w, h, strict] of cases) {
    const g = await fresh({ viewport: { width: w, height: h }, touch: true });
    const { page } = g;
    for (const mode of ['ok', 'retry']) {
      await toResult(g, RES({ cleared: false, stars: 0, deaths: 3, score: 8765, kills: 24, maxCombo: 23, rooms: 3 }));
      await step(page, 200);
      await g.ev(m => T.saveCbs[T.saveCbs.length - 1].res(m === 'ok' ? { ok: true, source: 'server' } : { ok: true, source: 'local', warning: 'server_failed', retryable: true }), mode);
      await wait(150);
      const m = await g.ev(mode => {
        const q = s => document.querySelector(s), app = q('#app').getBoundingClientRect(), mid = q('.res-mid').getBoundingClientRect();
        const tiles = [...document.querySelectorAll('.stat-grid li')].map(l => { const r = l.getBoundingClientRect(); return r.top < mid.top - 1 || r.bottom > mid.bottom + 1; });
        const inApp = s => { const r = q(s).getBoundingClientRect(); return r.left >= app.left - 1 && r.right <= app.right + 1 && r.top >= app.top - 1 && r.bottom <= app.bottom + 1; };
        const wrapped = [...document.querySelectorAll('.stat-grid li')].filter(l => l.getBoundingClientRect().height > parseFloat(getComputedStyle(l).fontSize) * 2.4).length;   // 한 칸 안에서 낱말이 두 줄로 쪼개짐
        const left = q('.res-left').getBoundingClientRect(), inLeft = s => { const r = q(s).getBoundingClientRect(); return r.left >= left.left - 1 && r.right <= left.right + 1; };   // 왼쪽 칸 안에 (넘치면 .res-left 가 잘라 버려서 버튼 끝이 안 보임)
        const midEl = q('.res-mid');
        return { hidden: tiles.filter(Boolean).length, clip: midEl.scrollHeight - midEl.clientHeight, wrapped, home: inApp('#ui-toTitle'), again: inApp('#ui-again'), retry: mode === 'ok' || (inApp('#ui-retry') && !q('#ui-retry').hidden), saveRow: inLeft('.save-text') && (mode === 'ok' || inLeft('#ui-retry')) };
      }, mode);
      const tag = `[${w}x${h} 저장 ${mode === 'ok' ? '성공' : '실패'}]`;
      check(`${tag} 「처음으로」「다시 하기」${mode === 'ok' ? '' : '·「다시」'} 버튼이 화면 안에 완전히 보임`, m.home && m.again && m.retry, JSON.stringify(m));
      check(`${tag} 점수 칸 5개가 ${strict || mode === 'ok' ? '하나도 잘리지 않고(넘침 2px 이하)' : '(아주 좁아서 안쪽 스크롤은 허용)'} 낱말도 쪼개지지 않음`, (strict || mode === 'ok' ? m.hidden === 0 && m.clip <= 2 : true) && m.wrapped === 0, JSON.stringify(m));
      check(`${tag} 저장 문구${mode === 'ok' ? '' : '와 「다시」 버튼'}이 왼쪽 칸 밖으로 넘쳐 잘리지 않음`, m.saveRow, JSON.stringify(m));
    }
    await g.done(`낮은 결과 ${w}x${h}`);
  }
});

await section('HUD: 보스 체력바가 점수판·방 이름판 위를 지나가거나 가리지 않음 — 등장 연출 내내 (픽셀 검사)', async () => {
  const g = await fresh();
  await toPlay(g);
  // 같은 시각 순서(프레임마다 16.7ms)로 HUD 를 두 번 그려요: (A) 보스 없이 (B) 보스가 나타나는 연출. 위쪽 띠(y 0~96: 체력판·방 이름판·진행도 점·점수판)의 픽셀이 한 프레임도 다르면 보스 체력바가 거기를 건드린 것
  const pass = withBoss => g.ev(withBoss => {
    const orig = performance.now.bind(performance); let t = 500000; performance.now = () => t;
    Game.boss = withBoss ? { name: '젤리 대왕', hp: 270, maxHp: 300, boss: true } : null;        // 70% 이상 → 분홍색 체력바
    const band = [], pinkInBand = [], pinkCard = [];
    for (let k = 0; k <= 40; k++) {                                                              // 등장 연출 전체(24프레임) + 여유
      t = 500000 + k * (1000 / 60);
      const ctx = PX.draw(), d = Loop.dpr, w = Math.round(960 * d), h = Math.round(96 * d), im = ctx.getImageData(0, 0, w, h).data;
      let hash = 0, pk = 0;
      for (let i = 0; i < im.length; i += 4) { hash = (hash * 31 + im[i] + im[i + 1] * 3 + im[i + 2] * 7 + im[i + 3] * 11) | 0; if (im[i + 3] > 200 && im[i] > 240 && im[i + 1] > 120 && im[i + 1] < 160 && im[i + 2] > 195 && im[i + 2] < 235) pk++; }
      band.push(hash); pinkInBand.push(pk);
      const c2 = ctx.getImageData(Math.round(270 * d), Math.round(96 * d), Math.round(420 * d), Math.round(90 * d)).data; let n = 0;
      for (let i = 0; i < c2.length; i += 4) if (c2[i + 3] > 200 && c2[i] > 240 && c2[i + 1] > 120 && c2[i + 1] < 160 && c2[i + 2] > 195 && c2[i + 2] < 235) n++;
      pinkCard.push(n);
    }
    performance.now = orig; Game.boss = null; PX.draw();
    return { band, pinkInBand, pinkCard };
  }, withBoss);
  await g.ev(() => {
    FX.reduceMotion = false; Game.touch = false; Game.score = 9876543; Game.player.hp = 100;     // 점수판이 가장 넓은 7자리
    Game.stage = { roomName: '젤리 대왕의 방', roomIndex: 4, roomCount: 5 };
    for (let i = 0; i < 200; i++) PX.draw();                                                    // 점수 숫자가 다 올라가게
  });
  const A = await pass(false), B = await pass(true);
  const diff = A.band.map((h, k) => h !== B.band[k] ? k : -1).filter(k => k >= 0);
  check('보스가 나타나는 41프레임 내내 위쪽 띠(체력판·방 이름판·진행도 점·점수판, y<96)의 픽셀이 보스 없을 때와 똑같음 (예전엔 위에서 내려오며 점수판과 겹쳤음)', diff.length === 0, `달라진 프레임: ${diff.join(',')}`);
  check('위쪽 띠에 보스 체력바 색(분홍)이 한 픽셀도 없음', B.pinkInBand.every(n => n === 0), JSON.stringify(B.pinkInBand));
  check('(측정 확인) 연출이 끝나면 체력바 자리(y 96~186)에 체력바가 그려져 있음', B.pinkCard[40] > 1500, String(B.pinkCard[40]));
  check('(측정 확인) 등장은 아래쪽에서 점점 또렷해짐 (첫 프레임엔 거의 없고 끝에 가장 많음)', B.pinkCard[0] < B.pinkCard[40] * 0.2 && B.pinkCard[10] <= B.pinkCard[40], JSON.stringify([B.pinkCard[0], B.pinkCard[10], B.pinkCard[40]]));
  await g.done('보스 체력바 겹침');
});

await section('터치+키보드 노트북: 처음부터 포커스·Enter 로 시작, 화면을 만지기 전엔 터치 버튼을 숨김 (UI-12)', async () => {
  // (a) 마우스/터치패드가 기본인데 ontouchstart 도 있는 기기 (hasTouch 에뮬레이션은 터치가 기본 포인터라서 init 로 흉내)
  let g = await fresh({ init: () => { window.ontouchstart = null; } });
  let { page } = g;
  const hy = await g.ev(() => ({ touch: Game.touch, fine: matchMedia('(hover: hover) and (pointer: fine)').matches, active: document.activeElement && document.activeElement.id, sel: document.getElementById('ui-nick').selectionEnd - document.getElementById('ui-nick').selectionStart, len: document.getElementById('ui-nick').value.length }));
  check('(전제) 터치 이벤트가 있다고 감지됐고 기본 포인터는 마우스(정밀)', hy.touch === true && hy.fine === true, JSON.stringify(hy));
  check('이런 기기에서도 타이틀에 처음부터 별명 칸에 포커스가 있고 만들어 준 별명이 선택돼 있음 (바로 쳐서 바꿀 수 있음)', hy.active === 'ui-nick' && hy.sel === hy.len && hy.len >= 2, JSON.stringify(hy));
  await page.keyboard.press('Enter');
  await step(page, 2);
  check('Enter 만 눌러도 시작됨', await g.ev(() => Game.scene === 'play' && T.started.length === 1));
  let s = await g.state();
  check('화면을 아직 만지지 않았으면 터치 버튼이 안 보이고 캔버스 스킬 칸이 보임 (기본 포인터가 마우스인 노트북)', !s.touchVisible && await g.ev(() => PX.run([{ x: 18, y: 106, w: 62, h: 62, pred: 'solid' }])[0] > 1500), JSON.stringify(s));
  await g.ev(() => window.dispatchEvent(new Event('touchstart')));
  s = await g.state();
  check('화면을 실제로 만지면 터치 버튼이 나타남', s.touchVisible && s.touchSeen, JSON.stringify(s));
  await g.close();
  // (b) 폰/태블릿(기본 포인터가 손가락)에 외장 키보드: 키보드가 불쑥 뜨지 않게 포커스는 안 주되, Enter 로 시작할 수 있음
  g = await fresh({ touch: true, viewport: { width: 844, height: 390 } });
  page = g.page;
  check('손가락 기기의 타이틀은 별명 칸에 자동 포커스를 주지 않음 (화상 키보드가 불쑥 뜨지 않게)', await g.ev(() => document.activeElement === document.body));
  await page.keyboard.press('Enter');
  await step(page, 2);
  check('…그래도 외장 키보드의 Enter 로 시작됨 (포커스가 아무 데도 없을 때)', await g.ev(() => Game.scene === 'play' && T.started.length === 1 && T.started[0].nickname.length >= 2));
  s = await g.state();
  check('손가락 기기에서는 시작하면 터치 버튼이 바로 보임 (기존 동작 그대로)', s.touchVisible, JSON.stringify(s));
  await g.ev(() => Game.setScene('title'));
  await g.ev(() => document.getElementById('ui-nick').focus());
  await page.keyboard.press('Enter');
  await step(page, 2);
  check('별명 칸에서의 Enter 는 한 번만 시작함 (칸의 Enter 와 전역 Enter 가 겹쳐 두 번 시작하지 않음)', await g.ev(() => T.started.length === 2));
  await g.close();
  // (c) 모달이 열려 있을 때·타이핑 중일 때는 Enter 로 시작하지 않음
  g = await fresh({ touch: true, viewport: { width: 844, height: 390 } });
  page = g.page;
  await page.tap('#ui-help');
  await g.ev(() => document.activeElement.blur());
  await page.keyboard.press('Enter');
  await step(page, 2);
  check('조작법 창이 열려 있을 때는 포커스가 비어도 Enter 로 시작되지 않음', await g.ev(() => Game.scene === 'title' && T.started.length === 0));
  await g.done('터치+키보드');
});

finish('ui');
