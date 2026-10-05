// core 커널 테스트 (src/js_core.html, src/js_main.html, tools/test-all.mjs)
//   실행: node tools/build-local.mjs --out dist/_core.html && GAME_HTML=dist/_core.html node tools/tests/core.test.mjs
//   일부 구역만: CORE_ONLY='Loop|HiDPI' (구역 이름에 이 정규식이 들어간 것만 실행 — 고치는 중에 빠르게 돌려 볼 때)
//   디버그 씬 스크린샷은 SHOT_DIR (기본: 임시 폴더/jd-core-shots) 에 저장됩니다. 저장소 안에는 쓰지 않아요.
import { openGame, step, launch, gameUrl, simulateFrames } from '../lib/browser.mjs';
import { check, finish } from '../lib/check.mjs';
import { readFileSync, mkdirSync, writeFileSync, mkdtempSync, copyFileSync, existsSync, statSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOT_DIR = process.env.SHOT_DIR || join(tmpdir(), 'jd-core-shots');
mkdirSync(SHOT_DIR, { recursive: true });

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const tmpDirs = [];                              // 임시 저장소 복사본들 (끝에 지움)
const mkTmp = prefix => { const d = mkdtempSync(join(tmpdir(), prefix)); tmpDirs.push(d); return d; };
const section = async (name, fn) => {            // 한 구역이 예외로 죽어도 나머지는 계속
  if (process.env.CORE_ONLY && !new RegExp(process.env.CORE_ONLY).test(name)) return;
  try { await fn(); } catch (e) { check(`[${name}] 구역이 예외 없이 끝남`, false, String(e && e.stack || e).split('\n').slice(0, 3).join(' | ')); }
};

// 특수 환경(HiDPI, localStorage 막힘, AudioContext 없음 …)으로 새 페이지를 여는 도우미
async function openCustom({ init, contextOpts = {} } = {}) {
  const browser = await launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, ...contextOpts });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
  await page.route(/^https?:/, r => r.fulfill({ status: 200, contentType: 'text/plain', body: '' }));
  if (init) await page.addInitScript(init);
  await page.goto(gameUrl(), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof Loop !== 'undefined' && Loop.started === true, null, { timeout: 8000 });
  await page.evaluate(() => { Loop.manual = true; });
  return { browser, context, page, errors, close: () => browser.close() };
}

const { page, errors, close, browser } = await openGame();
const ev = (fn, arg) => page.evaluate(fn, arg);

// ----- 페이지 안에서 쓰는 도우미 (TT) + 매 구역 시작 시 깨끗한 상태로 -----
const installTT = () => ev(() => {
  window.TT = {
    mk: p => Entities.add(Entities.make(p)),
    upd: n => { for (let i = 0; i < n; i++) Entities.updateAll(); },
    evlog(names) {                                   // 이벤트를 [이름, 요약] 로 기록
      const log = [];
      names.forEach(n => Events.on(n, d => log.push([n, d && d.target ? d.target.id : (d && d.id !== undefined ? d.id : d)])));
      return log;
    },
    px(x, y) {                                       // 논리 좌표 (x,y) 의 화면 색
      const c = Loop.canvas, dpr = Loop.dpr;
      const d = c.getContext('2d').getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data;
      return [d[0], d[1], d[2]];
    },
    // console.error 를 가로채서 모음 (테스트 중 일부러 낸 오류가 "에러 없음" 검사를 망치지 않게)
    grabErrors() {
      TT.errs = []; TT._orig = console.error;
      console.error = (...a) => { TT.errs.push(a.map(x => (x && x.message) || String(x)).join(' ')); };
    },
    releaseErrors() { console.error = TT._orig; return TT.errs; },
  };
  Math.random = () => { throw new Error('Math.random 사용 금지'); };   // 이후 어디서든 쓰면 바로 들통
});
await installTT();
// 새로고침 뒤에도 같은 상태로 이어서 (도우미 다시 설치)
const reopen = async () => {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof Loop !== 'undefined' && Loop.started === true);
  await ev(() => { Loop.manual = true; });
  await installTT();
};
const reset = () => ev(() => {
  Events.clear(); Entities.clear(); FX.clear(); Input.clear();
  Loop.hooks.length = 0; Loop.manual = true;
  Game.paused = false; Game.world.width = 960; Game.player = null; Game.boss = null;
  Game.resetRun({ difficulty: 'normal', nickname: '' });
  Debug.god = false; Debug.noVariance = false; Debug.showHitboxes = false; FX.reduceMotion = false;
  Cam.x = 0; RNG.seed(1);
  if (TT._orig && console.error !== TT._orig) console.error = TT._orig;
  Scenes.T = {}; Game.scene = 'T';
});

// =====================================================================
await section('부팅과 계약 표면', async () => {
  const s = await ev(() => {
    const missing = [];
    ['clamp', 'lerp', 'dist', 'rand', 'randInt', 'pick', 'chance'].forEach(n => { if (typeof eval(n) !== 'function') missing.push(n); });
    const sets = [
      [RNG, ['seed']], [Store, ['get', 'set']], [Events, ['on', 'off', 'emit']],
      [Input, ['isDown', 'wasPressed', 'press', 'release', 'endFrame', 'clear', 'bindButton']],
      [SFX, ['init', 'play', 'setMuted']], [Music, ['play']],
      [FX, ['freeze', 'shake', 'popup', 'burst', 'flash', 'update', 'drawWorld', 'drawScreen', 'clear']],
      [Entities, ['make', 'add', 'remove', 'clear', 'byTeam', 'updateAll', 'drawAll']],
      [Combat, ['applyHitbox', 'frontBox', 'aroundBox', 'damage']],
      [Cam, ['follow', 'snap', 'apply']], [Draw, ['text', 'bar', 'roundRect', 'shadow']],
      [Loop, ['start', 'tick', 'step']], [Game, ['setScene', 'pause', 'resetRun', 'addScore']],
    ];
    sets.forEach(([obj, names]) => names.forEach(n => { if (typeof obj[n] !== 'function') missing.push(n + '()'); }));
    const props = [[Input, 'down', 'object'], [Input, 'pressed', 'object'], [SFX, 'muted', 'boolean'], [FX, 'hitstop', 'number'],
      [Entities, 'list', 'object'], [Cam, 'x', 'number'], [Loop, 'manual', 'boolean'], [Loop, 'hooks', 'object'], [Loop, 'started', 'boolean'],
      [Game, 'scene', 'string'], [Game, 'paused', 'boolean'], [Game, 'difficulty', 'string'], [Game, 'nickname', 'string'], [Game, 'touch', 'boolean'],
      [Game, 'frame', 'number'], [Game, 'score', 'number'], [Game, 'kills', 'number'], [Game, 'deaths', 'number'], [Game, 'lives', 'number'],
      [Game, 'combo', 'object'], [Game, 'world', 'object'], [Game, 'stage', 'object'], [CFG, 'font', 'string'], [CFG, 'difficulty', 'object']];
    props.forEach(([o, k, t]) => { if (typeof o[k] !== t) missing.push(`${k}:${typeof o[k]}≠${t}`); });
    return {
      missing, consts: [W, H, FLOOR_TOP, FLOOR_BOTTOM, GRAVITY],
      colors: JSON.stringify(COLORS), cfgKeys: Object.keys(CFG).sort().join(','), diffs: Object.keys(CFG.difficulty).join(','),
      bootScene: typeof Scenes.boot, sceneRule: Game.scene === (Scenes.title ? 'title' : (Scenes.play ? 'play' : 'boot')),
      onerror: typeof window.onerror, onrej: typeof window.onunhandledrejection, started: Loop.started,
    };
  });
  check('공개 API 이름이 계약서와 같다', s.missing.length === 0, s.missing.join(', '));
  check('상수 W,H,FLOOR_TOP,FLOOR_BOTTOM,GRAVITY', JSON.stringify(s.consts) === '[960,540,330,500,0.6]', JSON.stringify(s.consts));
  check('COLORS 팔레트 10색', JSON.parse(s.colors).pink === '#ff8ad8' && Object.keys(JSON.parse(s.colors)).length === 10);
  check('CFG 에 title/font/playerInvuln/comboWindow/breakReminderMinutes/difficulty', ['breakReminderMinutes', 'comboWindow', 'difficulty', 'font', 'playerInvuln', 'title'].every(k => s.cfgKeys.includes(k)), s.cfgKeys);
  check('난이도 3종 easy/normal/hard', s.diffs === 'easy,normal,hard');
  check("기본 'boot' 씬이 core 에 있음", s.bootScene === 'object');
  check('부팅 규칙: title → play → boot 순서로 첫 씬 결정', s.sceneRule);
  check('window.onerror / onunhandledrejection 설치됨', s.onerror === 'function' && s.onrej === 'function');
  check('Loop.started === true', s.started === true);

  const src = readFileSync(join(root, 'src', 'js_core.html'), 'utf8') + readFileSync(join(root, 'src', 'js_main.html'), 'utf8');
  check('소스에 Math.random 호출 없음', !/Math\.random\s*\(/.test(src));
  check('소스에 alert/confirm/prompt/eval/document.write 없음', !/\b(alert|confirm|prompt|eval)\s*\(|document\.write/.test(src));
  check('소스의 </script> 는 각 파일 끝의 한 번뿐 (Apps Script 안전)', [src.split('</script>').length - 1].every(n => n === 2), `${src.split('</script>').length - 1}개`);
  check('소스에 "<?" 문자열 없음 (Apps Script 템플릿 안전)', !/<\?/.test(src));
  check('소스에 fetch/XMLHttpRequest/외부 URL 없음', !/\bfetch\s*\(|XMLHttpRequest|https?:\/\//.test(src));
});

// =====================================================================
await section('유틸 · RNG · Store', async () => {
  await reset();
  const u = await ev(() => ({
    clamp: [clamp(5, 0, 3), clamp(-1, 0, 3), clamp(2, 0, 3)], lerp: [lerp(0, 10, 0.25), lerp(5, 5, 0.9), lerp(2, 4, 1.5)],
    dist: [dist({ x: 0, y: 0 }, { x: 3, y: 4 }), dist({ x: 1, y: 1, z: 99 }, { x: 1, y: 1, z: 0 })],
  }));
  check('clamp / lerp / dist', JSON.stringify(u.clamp) === '[3,0,2]' && JSON.stringify(u.lerp) === '[2.5,5,5]' && u.dist[0] === 5 && u.dist[1] === 0, JSON.stringify(u));

  const r = await ev(() => {
    const seq = n => Array.from({ length: n }, () => rand());
    RNG.seed(42); const a = seq(8);
    RNG.seed(42); const b = seq(8);
    RNG.seed(43); const c = seq(8);
    RNG.seed(7); const ints = Array.from({ length: 3000 }, () => randInt(3, 6));
    RNG.seed(7); const swapped = Array.from({ length: 200 }, () => randInt(6, 3));
    RNG.seed(9); const rs = seq(2000);
    RNG.seed(9); const arr = ['a', 'b', 'c'];
    const picks = Array.from({ length: 300 }, () => pick(arr));
    RNG.seed(9); const ch0 = Array.from({ length: 200 }, () => chance(0)), ch1 = Array.from({ length: 200 }, () => chance(1));
    RNG.seed(9); const half = Array.from({ length: 4000 }, () => chance(0.5)).filter(Boolean).length;
    // 연출 난수는 게임 난수열을 건드리지 않는다 (입자를 몇 개 만들든 데미지 난수는 그대로)
    RNG.seed(3); const x1 = [rand(), rand(), rand()];
    RNG.seed(3); FX.burst(100, 100, { kind: 'star', count: 40 }); FX.popup(1, 1, 'a'); FX.flash('#fff', 5); FX.clear();
    const x2 = [rand(), rand(), rand()];
    return {
      same: JSON.stringify(a) === JSON.stringify(b), diff: JSON.stringify(a) !== JSON.stringify(c),
      range: rs.every(v => v >= 0 && v < 1), mean: rs.reduce((s, v) => s + v, 0) / rs.length,
      ints: [Math.min(...ints), Math.max(...ints)], allInts: ints.every(Number.isInteger), swapped: [Math.min(...swapped), Math.max(...swapped)],
      pickOk: picks.every(p => arr.includes(p)), pickAll: new Set(picks).size, pickEmpty: pick([]), ch0: ch0.some(Boolean), ch1: ch1.every(Boolean), half,
      fxIndependent: JSON.stringify(x1) === JSON.stringify(x2),
    };
  });
  check('RNG: 같은 시드 → 같은 난수열, 다른 시드 → 다른 난수열', r.same && r.diff);
  check('rand() 는 [0,1) 이고 평균이 0.5 근처', r.range && Math.abs(r.mean - 0.5) < 0.03, r.mean.toFixed(3));
  check('randInt 는 양끝 포함 · 정수 · 범위 밖 없음', r.ints[0] === 3 && r.ints[1] === 6 && r.allInts, JSON.stringify(r.ints));
  check('randInt(6,3) 처럼 뒤집어도 3~6', r.swapped[0] === 3 && r.swapped[1] === 6);
  check('pick: 배열 원소만, 전부 나옴 / 빈 배열은 undefined', r.pickOk && r.pickAll === 3 && r.pickEmpty === undefined);
  check('chance(0) 은 절대 안 됨, chance(1) 은 항상 됨, chance(.5) ≈ 절반', !r.ch0 && r.ch1 && Math.abs(r.half - 2000) < 150, `${r.half}/4000`);
  check('FX 연출은 게임 난수열(rand)을 소모하지 않음', r.fxIndependent);

  // Store
  const s = await ev(() => {
    Store.set('t1', { a: 1, b: [1, 2, 3], s: '한글' }); Store.set('t2', 5); Store.set('t3', false); Store.set('t4', null);
    const obj = Store.get('t1'); obj.a = 99; obj.b.push(4);          // 꺼낸 값을 고쳐도 저장된 값은 그대로여야 함
    localStorage.setItem('jd:bad', '{oops');
    const res = {
      obj: JSON.stringify(Store.get('t1')), n: Store.get('t2'), f: Store.get('t3', 'x'), nul: Store.get('t4', 'x'),
      missing: Store.get('nope', 'fallback'), missingUndef: Store.get('nope'), bad: Store.get('bad', 'fb'),
      raw: localStorage.getItem('jd:t2'), noUnprefixed: localStorage.getItem('t2'),
    };
    Store.set('t2', undefined); res.removed = Store.get('t2', 'gone') + '|' + localStorage.getItem('jd:t2');
    return res;
  });
  check("Store: 객체/숫자/불리언/null 왕복, 꺼낸 값을 고쳐도 저장값 불변", s.obj === '{"a":1,"b":[1,2,3],"s":"한글"}' && s.n === 5 && s.f === false && s.nul === null, JSON.stringify(s));
  check('Store: 없는 키/깨진 값은 fallback', s.missing === 'fallback' && s.missingUndef === undefined && s.bad === 'fb');
  check("Store: 'jd:' 접두어로 localStorage 에 저장", s.raw === '5' && s.noUnprefixed === null);
  check('Store: undefined 를 저장하면 삭제', s.removed === 'gone|null', s.removed);
  await reopen();
  const persisted = await ev(() => Store.get('t1'));
  check('Store: 새로고침 뒤에도 값이 남아 있음', persisted && persisted.a === 1 && persisted.s === '한글');
  await ev(() => ['t1', 't3', 't4', 'bad'].forEach(k => Store.remove(k)));
});

await section('Store: localStorage 가 막혀도 동작', async () => {
  for (const [label, init] of [
    ['접근 자체가 예외 (쿠키 차단 등)', () => Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } })],
    ['setItem/getItem 이 예외 (용량 초과 등)', () => { Storage.prototype.setItem = () => { throw new Error('quota'); }; Storage.prototype.getItem = () => { throw new Error('blocked'); }; }],
  ]) {
    const t = await openCustom({ init });
    const r = await t.page.evaluate(() => {
      let threw = false, out = {};
      try {
        Store.set('score', { v: 10 }); Store.set('flag', true);
        out = { v: Store.get('score').v, flag: Store.get('flag'), missing: Store.get('zzz', 7) };
        SFX.setMuted(true); out.muted = Store.get('muted');
        SFX.setMuted(false);
      } catch (e) { threw = String(e); }
      return { threw, out };
    });
    check(`Store 메모리 폴백 (${label})`, r.threw === false && r.out.v === 10 && r.out.flag === true && r.out.missing === 7 && r.out.muted === true, JSON.stringify(r));
    check(`  └ 폴백 중에도 페이지 오류 없음 (${label})`, t.errors.length === 0, t.errors.join(' | '));
    await t.close();
  }
});

// =====================================================================
await section('물리: 중력·착지·경계·넉백', async () => {
  await reset();
  // 점프 곡선: 독립적으로 계산한 기대값과 프레임마다 비교
  const j = await ev(() => {
    let landCount = 0;
    const e = TT.mk({ x: 480, y: 420, z: 0, vz: 11, onLand: () => landCount++ });
    const zs = [], vzs = [];
    for (let i = 0; i < 60; i++) { Entities.updateAll(); zs.push(e.z); vzs.push(e.vz); }
    // 기대값: z += vz; vz -= 0.6 (공중일 때), z<=0 이면 착지
    const exp = []; let z = 0, vz = 11, landed = false, landFrame = -1;
    for (let i = 0; i < 60; i++) {
      if (z > 0 || vz > 0) { z += vz; vz -= 0.6; if (z <= 0 && vz <= 0) { z = 0; vz = 0; if (!landed) { landed = true; landFrame = i; } } }
      exp.push(z);
    }
    return { zs, exp, landCount, landFrame, finalVz: e.vz, peak: Math.max(...zs), firstZ: zs[0] };
  });
  check('점프 궤적이 중력 공식과 프레임마다 일치', j.zs.every((z, i) => near(z, j.exp[i], 1e-9)), `peak=${j.peak.toFixed(1)}`);
  check('정점이 올라갔다 내려옴 (포물선)', j.firstZ === 11 && j.peak > 80 && j.peak < 110, `peak=${j.peak.toFixed(1)}`);
  check(`onLand 는 착지 순간 정확히 1번만 (착지 프레임 ${j.landFrame})`, j.landCount === 1 && j.zs[j.landFrame] === 0 && j.zs[j.landFrame - 1] > 0);
  check('착지하면 z=0, vz=0 으로 고정', j.zs.slice(j.landFrame).every(z => z === 0) && j.finalVz === 0);

  const g = await ev(() => {
    let lands = 0, groundLands = 0;
    const drop = TT.mk({ x: 300, y: 400, z: 300, onLand: () => lands++ });
    const ground = TT.mk({ x: 400, y: 400, onLand: () => groundLands++ });
    const zs = []; for (let i = 0; i < 80; i++) { Entities.updateAll(); zs.push(drop.z); }
    const cloud = TT.mk({ x: 500, y: 400, z: 90, noGravity: true, onLand: () => lands += 100 });
    TT.upd(60);
    return { dropFell: zs[1] < 300 && zs.every((z, i) => i === 0 || z <= zs[i - 1]), dropEnd: drop.z, lands, groundLands, cloudZ: cloud.z, cloudVz: cloud.vz };
  });
  check('위에서 떨어지는 엔티티(z=300)는 가속하며 내려와 착지, onLand 1번', g.dropFell && g.dropEnd === 0 && g.lands === 1, JSON.stringify(g));
  check('땅에 서 있던 엔티티는 onLand 가 안 불림', g.groundLands === 0);
  check('noGravity 엔티티는 공중에 그대로 떠 있고 onLand 도 없음', g.cloudZ === 90 && g.cloudVz === 0);

  const c = await ev(() => {
    const r = {};
    const e = TT.mk({ x: -50, y: 100, w: 40 }); TT.upd(1); r.lowLeft = [e.x, e.y];
    e.x = 5000; e.y = 900; TT.upd(1); r.highRight = [e.x, e.y];
    Game.world.width = 1920; e.x = 5000; TT.upd(1); r.wide = e.x;
    e.x = 100; e.y = 330; TT.upd(1); r.edgeTop = [e.x, e.y]; e.y = 500; TT.upd(1); r.edgeBottom = e.y;
    const big = TT.mk({ x: 0, y: 420, w: 120 }); TT.upd(1); r.big = big.x;
    const free = TT.mk({ x: -999, y: -999, clampWorld: false }); TT.upd(1); r.free = [free.x, free.y];
    // 이동 의도: vx/vy 는 한 프레임만 쓰이고 0 이 됨
    const m = TT.mk({ x: 500, y: 420, vx: 5, vy: -2 }); TT.upd(1); r.move1 = [m.x, m.y, m.vx, m.vy]; TT.upd(1); r.move2 = [m.x, m.y];
    // 걸어가며 경계에 닿아도 y 가 바닥 띠 안
    const w = TT.mk({ x: 500, y: 335 }); for (let i = 0; i < 10; i++) { w.vy = -3; TT.upd(1); } r.wallY = w.y;
    return r;
  });
  check('x 경계: 왼쪽 끝 = w/2, 오른쪽 끝 = world.width - w/2', c.lowLeft[0] === 20 && c.highRight[0] === 940, JSON.stringify([c.lowLeft, c.highRight]));
  check('y 경계: FLOOR_TOP(330) ~ FLOOR_BOTTOM(500)', c.lowLeft[1] === 330 && c.highRight[1] === 500 && c.edgeTop[1] === 330 && c.edgeBottom === 500 && c.wallY === 330);
  check('world.width 가 넓어지면 경계도 따라 넓어짐 (1920 → 1900)', c.wide === 1900, String(c.wide));
  check('몸이 넓으면(w=120) 경계도 그만큼 안쪽 (x>=60)', c.big === 60, String(c.big));
  check('clampWorld:false 면 경계 무시', c.free[0] === -999 && c.free[1] === -999);
  check('vx,vy 는 한 프레임만 이동시키고 0 이 됨', c.move1[0] === 505 && c.move1[1] === 418 && c.move1[2] === 0 && c.move1[3] === 0 && c.move2[0] === 505 && c.move2[1] === 418, JSON.stringify([c.move1, c.move2]));

  const k = await ev(() => {
    Game.world.width = 1920;
    const e = TT.mk({ x: 100, y: 420, kx: 10 });
    const kxs = [], xs = [];
    for (let i = 0; i < 40; i++) { Entities.updateAll(); kxs.push(e.kx); xs.push(e.x); }
    return { kxs, xs };
  });
  check('kx 는 매 프레임 ×0.85 로 감쇠', near(j && k.kxs[0], 8.5, 1e-9) && near(k.kxs[1], 7.225, 1e-9) && near(k.kxs[9], 10 * Math.pow(0.85, 10), 1e-9));
  check('|kx| < 0.05 가 되면 정확히 0 (33프레임째), 그 전엔 0 이 아님', k.kxs[31] > 0.05 && k.kxs[32] === 0 && k.kxs.slice(32).every(v => v === 0), `${k.kxs[31]} ${k.kxs[32]}`);
  check('넉백으로 움직인 거리 = 10 + 8.5 + 7.225 + … (33프레임 동안)', near(k.xs[0], 110, 1e-9) && near(k.xs[1], 118.5, 1e-9) && near(k.xs[39] - 100, 10 * (1 - Math.pow(0.85, 33)) / 0.15, 0.001), `${k.xs[39]}`);
});

await section('경직·죽음·제거·순회 안전', async () => {
  await reset();
  const s = await ev(() => {
    const r = {};
    // 경직(stun): 공중에서는 안 줄고, 착지 후에만 줄어든다. 경직 중엔 update 가 안 불림, tick 은 항상 불림
    let upd = 0, tick = 0;
    const e = TT.mk({ x: 400, y: 420, z: 200, stun: 4, update: () => upd++, tick: () => tick++ });
    const rows = [];
    for (let i = 0; i < 60; i++) { Entities.updateAll(); rows.push([e.z, e.stun]); }
    r.airOk = rows.every(([z, st]) => z > 0 ? st === 4 : true);
    r.endStun = e.stun; r.ticks = tick; r.upds = upd; r.landedFrame = rows.findIndex(([z]) => z === 0);
    r.stunAfterLand = rows.slice(r.landedFrame).map(r2 => r2[1]).slice(0, 6);
    r.updatesOnlyAfterStun = upd > 0 && upd < 60;
    // 땅에서의 경직 감소: 3 → 0 이 정확히 3프레임
    Entities.clear(); let u2 = 0;
    const g = TT.mk({ x: 400, y: 420, stun: 3, update: () => u2++ });
    const seq = []; for (let i = 0; i < 5; i++) { Entities.updateAll(); seq.push([g.stun, u2]); }
    r.groundStun = JSON.stringify(seq);
    // flash / invuln 은 매 프레임 -1 (바닥에서도, 공중에서도)
    Entities.clear();
    const f = TT.mk({ x: 400, y: 420, flash: 3, invuln: 2 }); TT.upd(1); r.fi1 = [f.flash, f.invuln]; TT.upd(5); r.fi2 = [f.flash, f.invuln];
    const fa = TT.mk({ x: 450, y: 420, z: 300, flash: 3, invuln: 2 }); TT.upd(1); r.fiAir = [fa.flash, fa.invuln];
    return r;
  });
  check('공중에서는 stun 이 줄지 않음 (착지 전까지 4 유지)', s.airOk && s.landedFrame > 0);
  check('착지한 뒤에는 stun 이 줄어 0 이 됨', s.endStun === 0 && s.stunAfterLand[0] === 3 && s.stunAfterLand[3] === 0, JSON.stringify(s.stunAfterLand));
  check('경직 중엔 update 안 불리고 tick 은 항상 불림 (60프레임 모두)', s.ticks === 60 && s.updatesOnlyAfterStun, `tick=${s.ticks} update=${s.upds}`);
  check('땅에서 stun=3 → 3프레임 뒤 0, 그다음 프레임부터 update', s.groundStun === '[[2,0],[1,0],[0,0],[0,1],[0,2]]', s.groundStun);
  check('flash/invuln 은 매 프레임 -1 (공중에서도)', s.fi1[0] === 2 && s.fi1[1] === 1 && s.fi2[0] === 0 && s.fi2[1] === 0 && s.fiAir[0] === 2 && s.fiAir[1] === 1, JSON.stringify([s.fi1, s.fi2, s.fiAir]));

  const d = await ev(() => {
    Entities.clear();
    const r = {};
    let u = 0, t = 0;
    const e = TT.mk({ x: 400, y: 420, dead: true, removeT: 5, update: () => u++, tick: () => t++ });
    const inList = []; for (let i = 0; i < 7; i++) { Entities.updateAll(); inList.push(Entities.list.includes(e)); }
    r.removeSeq = JSON.stringify(inList); r.updateWhileDead = u; r.tickWhileDead = t;
    // 기본 removeT=0 이면 첫 프레임에 제거
    const z = TT.mk({ x: 300, y: 420, dead: true }); TT.upd(1); r.zeroRemoved = !Entities.list.includes(z);
    // persistent 는 죽어도 남음
    const p = TT.mk({ x: 300, y: 420, dead: true, removeT: 1, persistent: true }); TT.upd(100); r.persistentStays = Entities.list.includes(p) && p.removeT === 1;
    // 공중에서 죽으면 착지 뒤부터 removeT 가 줄어듦
    const a = TT.mk({ x: 300, y: 420, z: 150, dead: true, removeT: 3 });
    const rt = []; for (let i = 0; i < 40; i++) { Entities.updateAll(); rt.push([a.z, a.removeT, Entities.list.includes(a)]); }
    r.airborneRemoveT = rt.every(([z, v, inL]) => (z > 0 ? v === 3 && inL : true));
    const landIdx = rt.findIndex(([z]) => z === 0);
    r.removedAfterLand = !rt[rt.length - 1][2] && rt[landIdx][1] === 2 && rt[landIdx + 2][2] === false;
    // 죽은 엔티티도 물리는 계속 (넉백으로 밀림), 그리고 draw 는 제거 전까지 계속 호출됨
    let draws = 0;
    const m = TT.mk({ x: 300, y: 420, kx: 8, dead: true, removeT: 10, draw: () => draws++ });
    const ctx = Loop.ctx || document.getElementById('game').getContext('2d');
    for (let i = 0; i < 5; i++) { Entities.updateAll(); Entities.drawAll(ctx); }
    r.deadMoved = m.x > 320; r.deadDraws = draws;
    return r;
  });
  check('dead 엔티티는 update 안 불리고 tick 은 불림', d.updateWhileDead === 0 && d.tickWhileDead === 5, JSON.stringify([d.updateWhileDead, d.tickWhileDead]));
  check('removeT=5 → 정확히 5번째 updateAll 에서 제거', d.removeSeq === '[true,true,true,true,false,false,false]', d.removeSeq);
  check('removeT 기본값 0 → 바로 제거', d.zeroRemoved);
  check('persistent 는 죽어도 제거되지 않음', d.persistentStays);
  check('공중에서 죽으면 착지 전엔 removeT 불변, 착지 뒤부터 줄어 제거', d.airborneRemoveT && d.removedAfterLand);
  check('죽은 엔티티도 물리는 계속(넉백), draw 는 제거 전까지 호출', d.deadMoved && d.deadDraws === 5, `draws=${d.deadDraws}`);

  const it = await ev(() => {
    Entities.clear();
    const r = {}; const calls = [];
    let bObj, cObj;
    const a = TT.mk({ x: 100, y: 400, update: () => {
      calls.push('a');
      TT.mk({ x: 700, y: 400, update: () => calls.push('new') });   // 순회 중 추가: 이번 프레임엔 안 돎
      Entities.remove(bObj);                                      // 순회 중 제거: 이번 프레임에 안 돎
    } });
    bObj = TT.mk({ x: 200, y: 400, update: () => calls.push('b') });
    cObj = TT.mk({ x: 300, y: 400, update: () => calls.push('c') });
    Entities.updateAll();
    r.first = calls.join(','); r.listLen = Entities.list.length; r.bGone = !Entities.list.includes(bObj);
    calls.length = 0; Entities.remove(a); Entities.updateAll(); r.second = calls.join(',');
    // clear 도 순회 중 안전
    Entities.clear(); const x = TT.mk({ x: 100, y: 400, update: () => Entities.clear() }), y = TT.mk({ x: 120, y: 400, update: () => calls.push('y') });
    calls.length = 0; Entities.updateAll(); r.afterClear = calls.length + ':' + Entities.list.length;
    // 중복 add 방지 / 없는 것 remove 해도 안전
    Entities.clear(); const q = TT.mk({}); Entities.add(q); Entities.add(q); Entities.remove(q); Entities.remove(q); Entities.remove(null); r.dup = Entities.list.length;
    return r;
  });
  check('순회 중 add: 새 엔티티는 같은 프레임에 update 안 되고 목록에는 들어감', it.first === 'a,c' && it.listLen === 3, it.first + ' / len ' + it.listLen);
  check('순회 중 remove: 제거된 엔티티는 같은 프레임에 update 안 됨', it.bGone && !it.first.includes('b'));
  check('다음 프레임엔 새로 추가된 것도 정상 동작', it.second === 'c,new' || it.second === 'new,c', it.second);
  check('순회 중 Entities.clear() 해도 안전, 이미 지워진 건 건너뜀', it.afterClear === '0:0', it.afterClear);
  check('add 중복/remove 중복·null 도 안전', it.dup === 0, String(it.dup));

  const loops = await ev(() => {
    Entities.clear(); const r = {};
    const mkN = n => Array.from({ length: n }, (_, i) => TT.mk({ x: 100 + i, y: 400, team: 'enemy', tag: i }));
    mkN(6); let visited = 0; for (const e of Entities.list) { visited++; Entities.remove(e); } r.forOfRemoveAll = [visited, Entities.list.length];
    mkN(6); visited = 0; Entities.list.forEach(e => { visited++; Entities.remove(e); }); r.forEachRemoveAll = [visited, Entities.list.length];
    mkN(4); visited = 0; for (const e of Entities.list) { visited++; if (e.tag === 0) TT.mk({ x: 1, y: 400, tag: 'new' }); } r.addWhileLooping = [visited, Entities.list.length];
    Entities.clear(); mkN(5); const ref = Entities.list; Entities.add(Entities.make({})); Entities.remove(ref[0]); r.identity = [ref === Entities.list, ref.length, Array.isArray(ref), ref instanceof Array];
    r.plainResults = [Entities.list.filter(() => true).constructor === Array, Entities.list.slice().constructor === Array, Entities.byTeam('enemy').constructor === Array, Entities.list.map(e => e.id).length === ref.length];
    // removeT 가 NaN/undefined 여도 죽은 뒤 제거됨
    Entities.clear(); const z = TT.mk({ dead: true, removeT: NaN }), y = TT.mk({ dead: true }); y.removeT = undefined; Entities.updateAll(); r.nanRemoveT = Entities.list.length;
    return r;
  });
  check('Entities.list: for-of 로 돌면서 remove 해도 하나도 안 건너뜀 (6개 모두 방문·삭제)', JSON.stringify(loops.forOfRemoveAll) === '[6,0]', JSON.stringify(loops.forOfRemoveAll));
  check('Entities.list: forEach 로 돌면서 remove 해도 안전', JSON.stringify(loops.forEachRemoveAll) === '[6,0]', JSON.stringify(loops.forEachRemoveAll));
  check('Entities.list: 돌면서 add 하면 목록엔 들어가고 이번 순회엔 안 나옴', JSON.stringify(loops.addWhileLooping) === '[4,5]', JSON.stringify(loops.addWhileLooping));
  check('Entities.list: 같은 배열 객체가 계속 유지됨(살아있는 배열), 일반 Array 이고 filter/slice/map 결과는 평범한 배열', JSON.stringify(loops.identity) === '[true,5,true,true]' && loops.plainResults.every(Boolean), JSON.stringify([loops.identity, loops.plainResults]));
  check('removeT 가 NaN/undefined 인 죽은 엔티티도 제거됨 (영영 안 사라지는 일 방지)', loops.nanRemoveT === 0, String(loops.nanRemoveT));

  const m = await ev(() => {
    Entities.clear();
    const r = {};
    const a = Entities.make({}), b = Entities.make({ maxHp: 50 }), c = Entities.make({ hp: 3, maxHp: 9, x: 1 });
    r.defaults = JSON.stringify({ kind: a.kind, team: a.team, x: a.x, y: a.y, z: a.z, vx: a.vx, vy: a.vy, vz: a.vz, kx: a.kx, w: a.w, h: a.h, face: a.face, hp: a.hp, maxHp: a.maxHp, dead: a.dead, removeT: a.removeT, stun: a.stun, flash: a.flash, invuln: a.invuln, superArmor: a.superArmor, heavy: a.heavy, noGravity: a.noGravity, untargetable: a.untargetable, persistent: a.persistent, clampWorld: a.clampWorld, shadow: a.shadow, layer: a.layer, tick: a.tick, update: a.update, draw: a.draw, onHit: a.onHit, onDeath: a.onDeath, onLand: a.onLand });
    r.ids = [a.id, b.id, c.id]; r.hpFromMax = [b.hp, b.maxHp, c.hp, c.maxHp];
    const u = Entities.make({ z: undefined, y: undefined, hp: undefined, maxHp: 30, team: undefined, x: 5, w: undefined, draw: undefined });
    r.undef = JSON.stringify([u.z, u.y, u.hp, u.maxHp, u.team, u.x, u.w, u.draw]);
    const e1 = TT.mk({ team: 'enemy', x: 100 }), e2 = TT.mk({ team: 'enemy', x: 200, dead: true }), p = TT.mk({ team: 'player' });
    r.byTeam = [Entities.byTeam('enemy').length, Entities.byTeam('player').length, Entities.byTeam('neutral').length, Entities.byTeam('enemy')[0] === e1];
    return r;
  });
  const dflt = '{"kind":"","team":"neutral","x":0,"y":420,"z":0,"vx":0,"vy":0,"vz":0,"kx":0,"w":40,"h":80,"face":1,"hp":1,"maxHp":1,"dead":false,"removeT":0,"stun":0,"flash":0,"invuln":0,"superArmor":false,"heavy":false,"noGravity":false,"untargetable":false,"persistent":false,"clampWorld":true,"shadow":true,"tick":null,"update":null,"draw":null,"onHit":null,"onDeath":null,"onLand":null}';
  check('Entities.make 기본값이 계약서 2장 표와 같음', m.defaults === dflt, m.defaults);
  check('id 는 매번 새 번호', new Set(m.ids).size === 3 && m.ids[0] < m.ids[1] && m.ids[1] < m.ids[2], JSON.stringify(m.ids));
  check('maxHp 만 주면 hp 도 꽉 참 / 둘 다 주면 그대로', JSON.stringify(m.hpFromMax) === '[50,50,3,9]');
  check('make: undefined 값은 기본값을 덮어쓰지 않음 (opts.z 가 비어 있어도 z 가 NaN 이 되지 않음)', m.undef === '[0,420,30,30,"neutral",5,40,null]', m.undef);
  check('byTeam: 죽은 엔티티 제외, 팀별로 분류', JSON.stringify(m.byTeam) === '[1,1,0,true]', JSON.stringify(m.byTeam));
});

// =====================================================================
await section('Entities.drawAll 순서와 안전', async () => {
  await reset();
  const o = await ev(() => {
    const log = [];
    const origShadow = Draw.shadow;
    Draw.shadow = (ctx, e) => log.push('S' + e.tag);
    const ctx = document.getElementById('game').getContext('2d');
    const mk = (tag, y, extra = {}) => TT.mk({ tag, y, x: 100, draw: () => log.push('D' + tag), ...extra });
    mk('c', 450); mk('a', 350); mk('b', 400); mk('tie1', 420); mk('tie2', 420);
    mk('g', 480, { layer: 'ground', shadow: false });
    mk('ns', 360, { shadow: false });
    Entities.drawAll(ctx);
    Draw.shadow = origShadow;
    return log;
  });
  const firstDraw = o.findIndex(x => x[0] === 'D'), lastShadow = o.map(x => x[0]).lastIndexOf('S');
  check('그림자가 전부 먼저, 그다음 캐릭터', lastShadow < firstDraw && o.filter(x => x[0] === 'S').length === 5, o.join(' '));
  check("shadow:false 엔티티는 그림자 없음", !o.includes('Sg') && !o.includes('Sns'));
  check("layer:'ground' 는 y 가 가장 커도 캐릭터보다 먼저 그림", o.indexOf('Dg') < o.indexOf('Da'), o.join(' '));
  check('나머지는 y 오름차순(먼 것 먼저), 같은 y 는 id 순', o.filter(x => x[0] === 'D' && x !== 'Dg').join(' ') === 'Da Dns Db Dtie1 Dtie2 Dc', o.join(' '));

  const bad = await ev(() => {
    TT.grabErrors();
    const log = []; const ctx = document.getElementById('game').getContext('2d');
    TT.mk({ y: 400, draw: () => { ctx.save(); ctx.globalAlpha = 0.1; throw new Error('draw 폭발'); } });
    TT.mk({ y: 410, draw: () => log.push(ctx.globalAlpha) });
    for (let i = 0; i < 4; i++) Entities.drawAll(ctx);
    const errs = TT.releaseErrors();
    return { log, errs };
  });
  check('draw 가 예외를 던져도 다른 엔티티는 계속 그려지고 상태가 새지 않음(globalAlpha=1)', bad.log.length === 4 && bad.log.every(a => a === 1), JSON.stringify(bad.log));
  check('같은 오류는 한 번만 console.error (4프레임 → 1번)', bad.errs.length === 1, JSON.stringify(bad.errs));

  // 픽셀 검사: y-정렬(앞 캐릭터가 위), 그림자 모양
  await ev(() => {
    Entities.clear();
    Scenes.T = { draw(ctx) { ctx.fillStyle = '#e8c9a0'; ctx.fillRect(0, 0, W, H); Entities.drawAll(ctx); } };
    const body = color => (ctx, e) => { ctx.fillStyle = color; ctx.fillRect(e.x - 20, e.y - e.z - 80, 40, 80); };
    TT.mk({ x: 220, y: 440, draw: body('#0000ff') });          // 앞 (먼저 추가)
    TT.mk({ x: 200, y: 400, draw: body('#ff0000') });          // 뒤 (나중에 추가해도 뒤에 그려져야 함)
    TT.mk({ x: 600, y: 440 });                                 // 그림자만 (z=0)
    TT.mk({ x: 700, y: 440, z: 100 });                         // 그림자만 (공중)
    TT.mk({ x: 800, y: 440, z: 100, shadow: false });
    Loop.draw();
  });
  const pxs = await ev(() => {
    const row = (cx, y) => { let n = 0; for (let x = cx - 80; x <= cx + 80; x++) { const [r, g, b] = TT.px(x, y); if (Math.abs(r - 232) + Math.abs(g - 201) + Math.abs(b - 160) > 12) n++; } return n; };
    return { overlap: TT.px(210, 390), backOnly: TT.px(190, 330), frontOnly: TT.px(230, 430), floor: TT.px(500, 300), shGround: row(600, 440), shAir: row(700, 440), shOff: row(800, 440) };
  });
  check('y-정렬: 겹친 곳은 앞(y 큰) 캐릭터 색 (파랑), 뒤 캐릭터는 가려짐', pxs.overlap.join() === '0,0,255' && pxs.backOnly.join() === '255,0,0', JSON.stringify(pxs));
  check('그림자: 바닥에는 있고, 공중이면 더 작고, shadow:false 면 없음', pxs.shGround > 30 && pxs.shAir > 10 && pxs.shAir < pxs.shGround - 8 && pxs.shOff === 0, `ground=${pxs.shGround} air=${pxs.shAir} off=${pxs.shOff}`);
});

// =====================================================================
await section('Combat: 판정 규칙', async () => {
  await reset();
  const r = await ev(() => {
    Debug.noVariance = true;
    const out = {};
    const P = TT.mk({ kind: 'player', team: 'player', x: 200, y: 420, face: 1, hp: 100, maxHp: 100, persistent: true });
    const E = (x, y = 420, z = 0, extra = {}) => TT.mk({ team: 'enemy', x, y, z, hp: 1000, maxHp: 1000, ...extra });
    const hit = (owner, reach, target, extra) => { const hb = Combat.frontBox(owner, reach, { damage: 10, ...extra }); return Combat.applyHitbox(hb).includes(target); };
    const fresh = () => { Entities.list.filter(e => e.team === 'enemy').forEach(e => Entities.remove(e)); };

    // --- x 겹침 (오른쪽을 볼 때): hb = [200, 280], 몸 너비 40 ---
    let t = E(250); out.xRight = hit(P, 80, t);
    fresh(); t = E(299); out.xRightEdgeIn = hit(P, 80, t);      // 왼쪽 끝 279 < 280 → 맞음
    fresh(); t = E(300); out.xRightEdgeOut = hit(P, 80, t);     // 왼쪽 끝 280 → 안 맞음 (딱 붙기만)
    fresh(); t = E(100); out.xBehind = hit(P, 80, t);           // 뒤에 있음
    fresh(); t = E(185); out.xOverlapBody = hit(P, 80, t);      // 오른쪽 끝 205 > 200 → 몸이 겹쳐서 맞음
    fresh(); t = E(179); out.xJustBehind = hit(P, 80, t);       // 오른쪽 끝 199 < 200 → 안 맞음
    // --- 왼쪽을 볼 때: hb = [120, 200] ---
    P.face = -1;
    fresh(); t = E(150); out.xLeft = hit(P, 80, t);
    fresh(); t = E(101); out.xLeftEdgeOut = hit(P, 80, t);      // 오른쪽 끝 121 > 120 → 맞음(안쪽)
    fresh(); t = E(100); out.xLeftEdgeIn = hit(P, 80, t);       // 오른쪽 끝 120 → 안 맞음
    fresh(); t = E(300); out.xBehindLeft = hit(P, 80, t);       // 오른쪽에 있는데 왼쪽을 봄
    P.face = 1;

    // --- 깊이(y): |dy| < 26 ---
    fresh(); t = E(250, 420 + 25); out.dy25 = hit(P, 80, t);
    fresh(); t = E(250, 420 + 26); out.dy26 = hit(P, 80, t);
    fresh(); t = E(250, 420 - 25); out.dyM25 = hit(P, 80, t);
    fresh(); t = E(250, 420 - 30); out.dyM30 = hit(P, 80, t);
    fresh(); t = E(250, 480); out.dy60 = hit(P, 80, t);
    fresh(); t = E(250, 420 + 40); out.dy40default = hit(P, 80, t); fresh(); t = E(250, 420 + 40); out.dy40depth50 = hit(P, 80, t, { depth: 50 });
    fresh(); t = E(250, 400); out.hbYOverride = hit(P, 80, t, { y: 380 }) + ':' + (fresh(), hit(P, 80, E(250, 420), { y: 380 }));

    // --- 높이(z): 땅의 공격자는 [-10, 80] ---
    fresh(); t = E(250, 420, 79); out.z79 = hit(P, 80, t);
    fresh(); t = E(250, 420, 80); out.z80 = hit(P, 80, t);
    fresh(); t = E(250, 420, 150); out.z150 = hit(P, 80, t);
    P.z = 100;                                                   // 점프 중인 공격자: [90, 180]
    fresh(); t = E(250, 420, 0); out.jumperVsGround = hit(P, 80, t);        // 발밑(맨땅 적, 머리 80 < 90) → 안 맞음
    fresh(); t = E(250, 420, 20); out.jumperVsLow = hit(P, 80, t);          // 머리 100 > 90 → 맞음
    fresh(); t = E(250, 420, 100); out.jumperVsSame = hit(P, 80, t);
    P.z = 0;
    fresh(); t = E(250, 420, 50); out.zMaxOverride = hit(P, 80, t, { zMax: 40 }) + ':' + (fresh(), hit(P, 80, E(250, 420, 50), { zMin: 200, zMax: 300 }));

    // --- 팀 필터 ---
    fresh();
    const e1 = E(250), e2 = E(260), nn = TT.mk({ team: 'neutral', x: 255, y: 420, hp: 50 }), ally = TT.mk({ team: 'player', x: 255, y: 420, hp: 50 });
    const hb1 = Combat.frontBox(P, 80, { damage: 5 });
    const hit1 = Combat.applyHitbox(hb1);
    out.teamPlayerHits = hit1.length + ':' + hit1.includes(e1) + hit1.includes(e2) + ':' + (nn.hp === 50) + (ally.hp === 50) + ':' + hit1.includes(P);
    const ENEMY = E(320, 420, 0, { face: -1, w: 40 });
    const ehb = Combat.frontBox(ENEMY, 80, { damage: 5 });
    const e1hp = e1.hp, nnhp = nn.hp;
    const eh = Combat.applyHitbox(ehb);
    out.teamEnemyHits = eh.length + ':' + eh.includes(ally) + ':' + (e1.hp === e1hp) + ':' + (nn.hp === nnhp);   // 적의 공격은 적/중립을 안 때림
    ENEMY.x = 270; ENEMY.face = -1;                              // 같은 자리에서 적 hb 가 플레이어에게 닿도록
    const hb2 = Combat.aroundBox(ENEMY, 120, { damage: 5 });
    out.enemyHitsPlayer = Combat.applyHitbox(hb2).includes(P);
    const hb3 = { team: 'enemy', x1: 0, x2: 960, y: 420, damage: 3 };                // owner 없는 hb (함정 등) + 팀 직접 지정
    out.noOwner = Combat.applyHitbox(hb3).includes(ally) + ':' + (P.hp < 100);

    // --- 상태 필터: 죽음/타깃 제외/자기 자신 ---
    Entities.clear(); P.hp = 100; Entities.add(P);
    const dead = E(250, 420, 0, { dead: true }), unt = E(250, 420, 0, { untargetable: true }), ok = E(250);
    const h4 = Combat.applyHitbox(Combat.frontBox(P, 80, { damage: 5 }));
    out.statusFilter = h4.length + ':' + h4.includes(ok) + ':' + (dead.hp === 1000) + (unt.hp === 1000) + ':' + (P.hp === 100);
    return out;
  });
  const T = (name, v) => check(name, v, v ? '' : JSON.stringify(r));
  T('x: 앞(오른쪽)에 있으면 맞음', r.xRight === true);
  T('x: 오른쪽을 볼 때 몸이 한 칸이라도 겹치면 맞고(279), 딱 붙기만 하면(280) 안 맞음', r.xRightEdgeIn === true && r.xRightEdgeOut === false);
  T('x: 오른쪽을 볼 때 뒤에 있는 적은 안 맞음 (몸이 겹치면 맞음)', r.xBehind === false && r.xJustBehind === false && r.xOverlapBody === true);
  T('x: 왼쪽을 볼 때 왼쪽 적은 맞음', r.xLeft === true && r.xLeftEdgeOut === true);
  T('x: 왼쪽을 볼 때 경계 딱 붙기(120)는 안 맞음, 오른쪽 적은 안 맞음', r.xLeftEdgeIn === false && r.xBehindLeft === false);
  T('깊이: 차이 25 는 맞고, 26/30/60 은 안 맞음 (위·아래 모두)', r.dy25 === true && r.dyM25 === true && r.dy26 === false && r.dyM30 === false && r.dy60 === false);
  T('깊이: 기본 26, hb.depth 로 넓히면 40 차이도 맞음 / hb.y 로 기준 깊이 변경', r.dy40default === false && r.dy40depth50 === true && r.hbYOverride === 'true:false');
  T('높이: 땅의 공격은 z=79 맞고 z=80/150 은 안 맞음', r.z79 === true && r.z80 === false && r.z150 === false);
  T('높이: 점프 중인 공격자는 땅 위 적을 못 맞추지만 낮게 뜬 적은 맞춤', r.jumperVsGround === false && r.jumperVsLow === true && r.jumperVsSame === true);
  T('높이: hb.zMin/zMax 로 직접 지정', r.zMaxOverride === 'false:false');
  T('팀: 플레이어 공격은 적만 때림 (중립/아군/자기 자신 제외)', r.teamPlayerHits === '2:truetrue:truetrue:false');
  T('팀: 적의 공격은 적/중립을 안 때리고 아군(플레이어팀)만 때림', r.teamEnemyHits === '1:true:true:true' && r.enemyHitsPlayer === true);
  T('팀: owner 없는 hb 도 hb.team 으로 동작', r.noOwner === 'true:true');
  T('죽은/untargetable 엔티티는 안 맞고 자기 자신도 안 맞음', r.statusFilter === '1:true:truetrue:true');

  // hitSet: 한 번 휘두를 때 한 번만, 새 hb 는 다시 맞음
  const h = await ev(() => {
    Entities.clear(); Debug.noVariance = true;
    const P = TT.mk({ team: 'player', x: 200, y: 420, face: 1 });
    const E = TT.mk({ team: 'enemy', x: 250, y: 420, hp: 100, maxHp: 100 });
    const hb = Combat.frontBox(P, 80, { damage: 10, stun: 0, knock: 0 });
    const a = Combat.applyHitbox(hb), b = Combat.applyHitbox(hb), c = Combat.applyHitbox(hb);
    const afterSame = E.hp;
    const hb2 = Combat.frontBox(P, 80, { damage: 10, stun: 0, knock: 0 });
    const d = Combat.applyHitbox(hb2); const hpAfterSecond = E.hp;
    const shared = new Set();
    const s1 = Combat.applyHitbox(Combat.frontBox(P, 80, { damage: 10, hitSet: shared })), s2 = Combat.applyHitbox(Combat.frontBox(P, 80, { damage: 10, hitSet: shared }));
    // 무적이라 무시된 경우엔 "맞은 것"으로 치지 않아서, 무적이 끝나면 같은 hb 로 맞음
    const E2 = TT.mk({ team: 'enemy', x: 255, y: 420, hp: 100, maxHp: 100, invuln: 3 });
    const hb3 = Combat.frontBox(P, 80, { damage: 10, stun: 0, knock: 0 });
    const w1 = Combat.applyHitbox(hb3).includes(E2), hpDuring = E2.hp; E2.invuln = 0; const w2 = Combat.applyHitbox(hb3).includes(E2);
    // 한 번에 여러 명
    Entities.clear(); Entities.add(P);
    const m1 = TT.mk({ team: 'enemy', x: 240, y: 420, hp: 50 }), m2 = TT.mk({ team: 'enemy', x: 270, y: 430, hp: 50 }), m3 = TT.mk({ team: 'enemy', x: 270, y: 480, hp: 50 });
    const multi = Combat.applyHitbox(Combat.frontBox(P, 80, { damage: 5 }));
    return { counts: [a.length, b.length, c.length], afterSame, second: d.length, afterSecond: hpAfterSecond, shared: [s1.length, s2.length], invuln: [w1, hpDuring, w2], multi: multi.map(e => e.id).sort().join() === [m1.id, m2.id].sort().join(), set: hb.hitSet instanceof Set && hb.hitSet.has(E) };
  });
  check('hitSet: 같은 hb 는 몇 번 적용해도 한 번만 맞음 (hp 100 → 90)', JSON.stringify(h.counts) === '[1,0,0]' && h.afterSame === 90, JSON.stringify(h));
  check('hitSet 은 자동 생성되고 맞은 엔티티가 들어 있음', h.set);
  check('새 hb(= 다단히트의 두 번째 타)는 같은 적을 다시 맞힘', h.second === 1 && h.afterSecond === 80);
  check('hitSet 을 직접 공유하면 hb 를 새로 만들어도 한 번만', JSON.stringify(h.shared) === '[1,0]');
  check('무적이라 무시된 타깃은 hitSet 에 안 들어가서, 무적이 끝나면 맞음', JSON.stringify(h.invuln) === '[false,100,true]', JSON.stringify(h.invuln));
  check('한 번에 여러 명을 맞히되 깊이 다른 적은 제외', h.multi);

  // 넉백 방향
  const kd = await ev(() => {
    Entities.clear(); Debug.noVariance = true;
    const P = TT.mk({ team: 'player', x: 500, y: 420, face: 1 });
    const E = (x, extra = {}) => TT.mk({ team: 'enemy', x, y: 420, hp: 1000, ...extra });
    const o = {};
    let t = E(540); Combat.applyHitbox(Combat.frontBox(P, 80, { damage: 1, knock: 7 })); o.frontRight = t.kx;
    P.face = -1; t = E(460); Combat.applyHitbox(Combat.frontBox(P, 80, { damage: 1, knock: 7 })); o.frontLeft = t.kx; P.face = 1;
    t = E(490); Combat.applyHitbox(Combat.frontBox(P, 80, { damage: 1, knock: 7 })); o.frontOverlapBehind = t.kx;      // 몸이 겹쳐 중심이 뒤여도 앞으로 날아감
    const l = E(450), rr = E(550); Combat.applyHitbox(Combat.aroundBox(P, 100, { damage: 1, knock: 5 })); o.aroundLeft = l.kx; o.aroundRight = rr.kx;
    t = E(560); Combat.applyHitbox(Combat.aroundBox(P, 100, { damage: 1, knock: 5, dir: -1 })); o.dirOverride = t.kx;
    t = E(500); Combat.applyHitbox(Combat.aroundBox(P, 100, { damage: 1, knock: 5 })); o.sameX = t.kx;                  // 정확히 겹치면 owner 가 보는 쪽
    t = E(560); Combat.damage(t, 1, { x1: 0, x2: 100 }); o.noOwner = t.kx;                                              // owner 없음: hb 중심에서 멀어짐
    t = E(560, { face: 1 }); Combat.damage(t, 1); o.noHb = t.kx;                                                         // hb 도 없음: 뒤로
    const fb = Combat.frontBox(P, 80, { damage: 3 });
    o.box = [fb.x1, fb.x2, fb.y, fb.owner === P, fb.team, fb.damage];
    P.face = -1; const fbL = Combat.frontBox(P, 80); o.boxL = [fbL.x1, fbL.x2]; P.face = 1;
    const ab = Combat.aroundBox(P, 60, { damage: 2, depth: 40 }); o.around = [ab.x1, ab.x2, ab.y, ab.depth, ab.team];
    return o;
  });
  check('넉백: 오른쪽을 볼 때 앞의 적은 오른쪽(+), 왼쪽을 볼 때는 왼쪽(-)으로 knock 만큼', kd.frontRight === 7 && kd.frontLeft === -7, JSON.stringify(kd));
  check('넉백: frontBox 는 몸이 겹쳐 중심이 뒤에 있어도 앞쪽으로 날림', kd.frontOverlapBehind === 7);
  check('넉백: aroundBox 는 owner 에게서 멀어지는 쪽 (왼쪽 -, 오른쪽 +)', kd.aroundLeft === -5 && kd.aroundRight === 5);
  check('넉백: hb.dir 이 자동 방향을 덮어씀', kd.dirOverride === -5);
  check('넉백: 같은 x 면 owner 가 보는 쪽, owner 없으면 hb 중심 반대, hb 도 없으면 뒤로', kd.sameX === 5 && kd.noOwner === 6 && kd.noHb === -6, JSON.stringify([kd.sameX, kd.noOwner, kd.noHb]));
  check('frontBox/aroundBox 가 만드는 사각형과 extra 덮어쓰기', JSON.stringify(kd.box) === '[500,580,420,true,"player",3]' && JSON.stringify(kd.boxL) === '[420,500]' && JSON.stringify(kd.around) === '[440,560,420,40,"player"]', JSON.stringify([kd.box, kd.boxL, kd.around]));
});

// =====================================================================
await section('Debug.showHitboxes', async () => {
  await reset();
  const h = await ev(() => {
    Entities.clear(); Debug.noVariance = true;
    Scenes.T = { draw(ctx) { ctx.fillStyle = '#e8c9a0'; ctx.fillRect(0, 0, W, H); Entities.drawAll(ctx); } };
    const P = TT.mk({ team: 'player', x: 200, y: 420 }), E = TT.mk({ team: 'enemy', x: 600, y: 420, hp: 99 });
    const o = {};
    Combat.applyHitbox(Combat.frontBox(P, 80, { damage: 1 })); Loop.draw(); o.offByDefault = TT.px(240, 420).join();
    Debug.showHitboxes = true;
    Combat.applyHitbox(Combat.frontBox(P, 80, { damage: 1 })); Loop.draw(); o.on = TT.px(240, 420).join(); o.outsideDepth = TT.px(240, 460).join(); o.outsideX = TT.px(300, 420).join();
    for (let i = 0; i < 9; i++) Loop.draw(); o.expired = TT.px(240, 420).join();
    Debug.showHitboxes = false;
    return o;
  });
  check('Debug.showHitboxes: 꺼져 있으면 아무것도 안 그림', h.offByDefault === '232,201,160', h.offByDefault);
  check('Debug.showHitboxes: 켜면 판정 사각형(x 범위 × 깊이 ±26)이 반투명 하늘색으로 그려지고 밖은 그대로', h.on !== '232,201,160' && h.outsideDepth === '232,201,160' && h.outsideX === '232,201,160', JSON.stringify(h));
  check('Debug.showHitboxes: 몇 프레임 뒤에 사라짐', h.expired === '232,201,160', h.expired);
});

await section('Combat.damage: 8단계 파이프라인', async () => {
  await reset();
  const v = await ev(() => {
    const o = {};
    const P = TT.mk({ kind: 'player', team: 'player', x: 100, y: 420, hp: 1e9, maxHp: 1e9, persistent: true });
    const E = (extra = {}) => TT.mk({ team: 'enemy', x: 300, y: 420, hp: 1e9, maxHp: 1e9, ...extra });
    // 최소 1
    let t = E(); o.min = [Combat.damage(t, 0), Combat.damage((t.invuln = 0, t), 0.2), Combat.damage((t.invuln = 0, t), -5)];
    // ±10% 흔들림 (시드 고정, 3000번)
    RNG.seed(11);
    const vals100 = [], vals10 = [], vals1 = [];
    const dummy = E();
    for (let i = 0; i < 3000; i++) { vals100.push(Combat.damage(dummy, 100)); vals10.push(Combat.damage(dummy, 10)); vals1.push(Combat.damage(dummy, 1)); }
    const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
    o.v100 = [Math.min(...vals100), Math.max(...vals100), mean(vals100)];
    o.v10 = [Math.min(...vals10), Math.max(...vals10), [...new Set(vals10)].sort((a, b) => a - b).join()];
    o.v1 = [Math.min(...vals1), Math.max(...vals1)];
    RNG.seed(11); const again = []; for (let i = 0; i < 20; i++) again.push(Combat.damage(dummy, 100));
    RNG.seed(11); const again2 = []; for (let i = 0; i < 20; i++) again2.push(Combat.damage(dummy, 100));
    o.reproducible = JSON.stringify(again) === JSON.stringify(again2);
    // dmgTaken 은 플레이어팀만 (noVariance 로 정확히)
    Debug.noVariance = true;
    const dm = {};
    for (const d of ['easy', 'normal', 'hard']) {
      Game.difficulty = d;
      const pl = TT.mk({ kind: 'player', team: 'player', x: 100, y: 420, hp: 1e9, maxHp: 1e9, persistent: true }), en = E();
      dm[d] = [Combat.damage(pl, 10), Combat.damage(en, 10), Combat.damage((pl.invuln = 0, pl), 100)];
    }
    o.dmgTaken = dm;
    Game.difficulty = 'normal'; Debug.noVariance = false;
    // 플레이어팀이라도 kind 가 player 가 아니면(소환수 등) 난이도 배율은 팀 기준
    Game.difficulty = 'hard'; Debug.noVariance = true;
    const ally = TT.mk({ team: 'player', kind: 'pet', x: 100, y: 420, hp: 1e9 }); o.allyHard = Combat.damage(ally, 10);
    Game.difficulty = 'normal';
    return o;
  });
  check('최소 피해 1 (0, 0.2, 음수 → 1)', JSON.stringify(v.min) === '[1,1,1]', JSON.stringify(v.min));
  check('±10%: amount=100 → 90~110, 양 끝에 가깝게 퍼지고 평균 ≈ 100', v.v100[0] >= 90 && v.v100[1] <= 110 && v.v100[0] <= 91 && v.v100[1] >= 109 && Math.abs(v.v100[2] - 100) < 1, JSON.stringify(v.v100));
  check('±10%: amount=10 → 9~11 (정수만), 세 값이 다 나옴', v.v10[0] === 9 && v.v10[1] === 11 && v.v10[2] === '9,10,11', JSON.stringify(v.v10));
  check('±10%: amount=1 → 늘 1 (최소 1)', v.v1[0] === 1 && v.v1[1] === 1);
  check('같은 시드 → 같은 피해량 순서 (재현 가능)', v.reproducible);
  check('dmgTaken: 플레이어팀만 배율 (easy 0.5 / normal 1 / hard 1.7), 적은 항상 그대로', JSON.stringify(v.dmgTaken) === '{"easy":[5,10,50],"normal":[10,10,100],"hard":[17,10,170]}', JSON.stringify(v.dmgTaken));
  check('dmgTaken 은 team==="player" 기준 (kind 가 달라도)', v.allyHard === 17, String(v.allyHard));

  // 반응: 넉백·경직·띄우기·슈퍼아머·헤비·저글링
  const rx = await ev(() => {
    Debug.noVariance = true;
    const o = {}; const P = TT.mk({ team: 'player', x: 100, y: 420 });
    const E = (extra = {}) => TT.mk({ team: 'enemy', x: 300, y: 420, hp: 1000, maxHp: 1000, ...extra });
    let t = E(); Combat.damage(t, 10, { owner: P }); o.defaults = [t.kx, t.stun, t.flash, t.vz, t.z];
    t = E(); Combat.damage(t, 10, { owner: P, knock: 9, stun: 22, launch: 8 }); o.custom = [t.kx, t.stun, t.vz, t.z];
    t = E({ stun: 40 }); Combat.damage(t, 10, { owner: P, stun: 14 }); o.stunKeepsLonger = t.stun;
    t = E(); Combat.damage(t, 10, { owner: P, stun: 0, knock: 0 }); o.zeroReaction = [t.kx, t.stun];
    t = E({ superArmor: true }); const hpBefore = t.hp; Combat.damage(t, 10, { owner: P, knock: 9, stun: 22, launch: 8 }); o.superArmor = [t.kx, t.stun, t.vz, hpBefore - t.hp, t.flash];
    t = E({ heavy: true }); Combat.damage(t, 10, { owner: P, knock: 9, stun: 22, launch: 8 }); o.heavy = [t.kx, t.stun, t.vz];
    t = E({ heavy: true, z: 50, vz: -4 }); Combat.damage(t, 10, { owner: P }); o.heavyNoJuggle = t.vz;
    // 저글링: 공중 + launch=0 → vz = max(vz, 3), 타깃당 최대 6번
    t = E({ z: 50, vz: -5 }); const vzs = [];
    for (let i = 0; i < 8; i++) { t.vz = -5; t.invuln = 0; Combat.damage(t, 5, { owner: P }); vzs.push(t.vz); }
    o.juggle = vzs.join(); o.juggleCount = t._juggle;
    t.z = 1; t.vz = -5; Entities.updateAll(); o.landedReset = [t.z, t._juggle];                                    // 착지하면 저글링 횟수 초기화
    t.z = 50; t.vz = -5; t.invuln = 0; Combat.damage(t, 5, { owner: P }); o.jugglesAgain = t.vz;
    t = E({ z: 50, vz: 9 }); Combat.damage(t, 5, { owner: P }); o.jugglekeepsHigher = t.vz;                       // 이미 더 빨리 올라가는 중이면 그대로
    t = E({ z: 50, vz: -5 }); Combat.damage(t, 5, { owner: P, launch: 7 }); o.launchInAir = [t.vz, t._juggle];      // launch>0 은 저글링이 아니라 다시 띄우기
    t = E(); Combat.damage(t, 5, { owner: P }); o.groundNoJuggle = [t.vz, t._juggle];                              // 땅에서 launch=0 → 안 뜸
    // 띄운 뒤 실제로 올라갔다 내려옴
    t = E(); Combat.damage(t, 5, { owner: P, launch: 8 }); const zs = []; for (let i = 0; i < 40; i++) { Entities.updateAll(); zs.push(t.z); }
    o.launchArc = [zs[0] > 0, Math.max(...zs) > 40, zs[zs.length - 1]];
    return o;
  });
  check('기본 반응: kx=6(오른쪽으로), stun=14, flash=6, 땅에 있으면 안 뜸', JSON.stringify(rx.defaults) === '[6,14,6,0,0]', JSON.stringify(rx.defaults));
  check('hb.knock/stun/launch 가 반영됨 (launch → vz, z 는 그대로)', JSON.stringify(rx.custom) === '[9,22,8,0]', JSON.stringify(rx.custom));
  check('이미 더 긴 stun 이 있으면 줄이지 않음 / stun:0,knock:0 은 반응 없음', rx.stunKeepsLonger === 40 && JSON.stringify(rx.zeroReaction) === '[0,0]');
  check('superArmor: 피해·번쩍은 받지만 넉백/경직/띄우기는 없음', JSON.stringify(rx.superArmor) === '[0,0,0,10,6]', JSON.stringify(rx.superArmor));
  check('heavy: 띄우기·저글링만 무시, 넉백/경직은 받음', JSON.stringify(rx.heavy) === '[9,22,0]' && rx.heavyNoJuggle === -4, JSON.stringify([rx.heavy, rx.heavyNoJuggle]));
  check('저글링: 공중에서 launch=0 으로 맞으면 vz=3, 최대 6번까지만 (7·8번째는 효과 없음)', rx.juggle === '3,3,3,3,3,3,-5,-5' && rx.juggleCount === 6, rx.juggle);
  check('저글링 횟수는 착지하면 초기화', JSON.stringify(rx.landedReset) === '[0,0]' && rx.jugglesAgain === 3, JSON.stringify([rx.landedReset, rx.jugglesAgain]));
  check('저글링: 이미 더 빨리 올라가는 중이면 유지(vz=9), 땅에서는 안 뜸, launch>0 은 저글링 아님', rx.jugglekeepsHigher === 9 && JSON.stringify(rx.groundNoJuggle) === '[0,0]' && JSON.stringify(rx.launchInAir) === '[7,0]', JSON.stringify([rx.jugglekeepsHigher, rx.groundNoJuggle, rx.launchInAir]));
  check('띄운 적은 실제로 올라갔다가 내려와 착지', rx.launchArc[0] && rx.launchArc[1] && rx.launchArc[2] === 0, JSON.stringify(rx.launchArc));

  // 무적 · 팝업 · 입자 · 효과음 · 히트스톱 · 흔들림
  const fx = await ev(() => {
    Debug.noVariance = true; FX.clear();
    const o = {}; const P = TT.mk({ kind: 'player', team: 'player', x: 100, y: 420, hp: 100, maxHp: 100, persistent: true });
    const E = (extra = {}) => TT.mk({ team: 'enemy', x: 300, y: 420, hp: 1000, maxHp: 1000, ...extra });
    const events = TT.evlog(['entityHit', 'playerHit', 'entityDied']);
    let t = E({ invuln: 5 }); const r0 = Combat.damage(t, 10, { owner: P }); o.invulnBlocked = [r0, t.hp, t.flash, FX.popups.length, FX.particles.length, FX.hitstop, events.length];
    t.invuln = 0; o.afterInvuln = Combat.damage(t, 10, { owner: P });
    t = E({ untargetable: true }); o.untargetable = [Combat.damage(t, 10), t.hp];
    t = E({ dead: true }); o.deadIgnored = [Combat.damage(t, 10), t.hp];
    // 팝업
    FX.clear(); t = E(); Combat.damage(t, 10, { owner: P });
    const pe = FX.popups[FX.popups.length - 1]; o.enemyPopup = [pe.text, pe.color === COLORS.white || pe.color === COLORS.yellow, pe.y < t.y - t.h];
    FX.clear(); t = E(); Combat.damage(t, 30, { owner: P, launch: 6 }); o.bigPopup = FX.popups[0].color === COLORS.yellow;
    FX.clear(); const pl = TT.mk({ kind: 'player', team: 'player', x: 120, y: 420, hp: 100, maxHp: 100, persistent: true }); Combat.damage(pl, 12, { team: 'enemy' });
    o.playerPopup = [FX.popups[0].text, FX.popups[0].color === COLORS.red];
    // 입자
    FX.clear(); t = E(); Combat.damage(t, 10, { owner: P }); o.sparkDefault = [FX.particles.length > 0, FX.particles.every(p => p.kind === 'spark')];
    FX.clear(); t = E(); Combat.damage(t, 10, { owner: P, fx: 'star' }); o.fxStar = FX.particles.every(p => p.kind === 'star') && FX.particles.length > 0;
    FX.clear(); t = E(); Combat.damage(t, 10, { owner: P, fx: null }); o.fxNone = [FX.particles.length, FX.popups.length];
    // 효과음
    const played = []; const origPlay = SFX.play; SFX.play = (n, opts) => played.push(n);
    t = E(); Combat.damage(t, 10, { owner: P }); Combat.damage(t, 10, { owner: P, sfx: 'hitBig' }); Combat.damage(E(), 10, { owner: P, sfx: null }); Combat.damage(E(), 10);
    SFX.play = origPlay; o.sfx = played.join();
    // 히트스톱 / 흔들림
    FX.clear(); t = E(); Combat.damage(t, 10, { owner: P }); o.freezeDefault = FX.hitstop;
    t = E(); Combat.damage(t, 10, { owner: P, freeze: 8 }); o.freeze8 = FX.hitstop;
    t = E(); Combat.damage(t, 10, { owner: P, freeze: 2 }); o.freezeStaysMax = FX.hitstop;
    FX.clear(); t = E(); Combat.damage(t, 10, { owner: P, freeze: 0 }); o.freeze0 = FX.hitstop;
    FX.clear(); t = E(); Combat.damage(t, 10, { owner: P, shake: 6 }); const seen = []; for (let i = 0; i < 12; i++) { seen.push(Math.max(Math.abs(FX.shakeOff.x), Math.abs(FX.shakeOff.y))); FX.update(); }
    o.shake = [Math.max(...seen) > 0, Math.max(...seen) <= 6, seen[seen.length - 1]];
    FX.clear(); t = E(); Combat.damage(t, 10, { owner: P }); o.noShake = FX.shakeOff.x === 0 && FX.shakeOff.y === 0;
    return o;
  });
  check('무적(invuln>0): 피해·팝업·입자·히트스톱·이벤트 모두 없음, 끝나면 맞음', JSON.stringify(fx.invulnBlocked) === '[0,1000,0,0,0,0,0]' && fx.afterInvuln === 10, JSON.stringify(fx.invulnBlocked));
  check('untargetable / dead 는 피해 무시', JSON.stringify(fx.untargetable) === '[0,1000]' && JSON.stringify(fx.deadIgnored) === '[0,1000]');
  check('팝업: 적이 맞으면 흰색/노랑 숫자(머리 위), 큰 피해/띄우기는 노랑', fx.enemyPopup[0] === '10' && fx.enemyPopup[1] && fx.enemyPopup[2] && fx.bigPopup, JSON.stringify(fx.enemyPopup));
  check('팝업: 플레이어가 맞으면 빨간 숫자', fx.playerPopup[0] === '12' && fx.playerPopup[1] === true, JSON.stringify(fx.playerPopup));
  check('입자: 기본 spark, hb.fx 로 종류 변경, null 이면 입자 없이 팝업만', fx.sparkDefault[0] && fx.sparkDefault[1] && fx.fxStar && fx.fxNone[0] === 0 && fx.fxNone[1] === 1, JSON.stringify([fx.sparkDefault, fx.fxStar, fx.fxNone]));
  check("효과음: 기본 'hit', hb.sfx 로 변경, null 이면 소리 없음", fx.sfx === 'hit,hitBig,hit', fx.sfx);
  check('히트스톱: 기본 3, hb.freeze 로 변경, 더 긴 게 우선(max), 0 이면 없음', fx.freezeDefault === 3 && fx.freeze8 === 8 && fx.freezeStaysMax === 8 && fx.freeze0 === 0, JSON.stringify([fx.freezeDefault, fx.freeze8, fx.freezeStaysMax, fx.freeze0]));
  check('화면 흔들림: hb.shake 만큼(≤6) 흔들리다 멈춤, 기본은 흔들림 없음', fx.shake[0] && fx.shake[1] && fx.shake[2] === 0 && fx.noShake, JSON.stringify(fx.shake));
});

await section('Combat.damage: 훅·이벤트·콤보·무적', async () => {
  await reset();
  const v = await ev(() => {
    Debug.noVariance = true;
    const o = {}; const order = [];
    const P = TT.mk({ kind: 'player', team: 'player', x: 100, y: 420, hp: 100, maxHp: 100, persistent: true });
    Game.player = P;
    const log = TT.evlog(['entityHit', 'entityDied', 'enemyKilled', 'bossKilled', 'playerHit', 'playerDied', 'comboChanged']);
    const mk = (extra = {}) => TT.mk({ team: 'enemy', kind: 'enemy', x: 300, y: 420, hp: 20, maxHp: 20, ...extra });
    const names = () => log.map(l => l[0]).join(',');

    // 일반 적: 한 번 맞고(죽지 않음)
    let hitArgs = null;
    let t = mk({ onHit: (e, hb, dmg) => { order.push('onHit'); hitArgs = [e === t, typeof hb, dmg]; }, onDeath: () => order.push('onDeath') });
    Combat.damage(t, 5, { owner: P });
    o.hitOnce = [names(), hitArgs.join(), order.join(), t.hp, t.dead, Game.kills];
    // 쓰러뜨림: onHit → onDeath → entityHit → entityDied → enemyKilled
    log.length = 0; order.length = 0;
    Combat.damage(t, 50, { owner: P });
    o.kill = [names(), order.join(), t.hp, t.dead, Game.kills, log.filter(l => l[0] === 'enemyKilled')[0][1] === t.id];
    // 이미 쓰러진 적을 또 때려도 이벤트/킬 수 증가 없음
    log.length = 0; const kBefore = Game.kills; Combat.damage(t, 50, { owner: P }); o.again = [log.length, Game.kills - kBefore];
    // 보스: enemyKilled + bossKilled
    log.length = 0; const boss = mk({ kind: 'boss', boss: true, hp: 10 });
    Combat.damage(boss, 99, { owner: P }); o.boss = [names(), Game.kills];
    // 플레이어 사망: playerHit → playerDied, enemyKilled 는 아님
    log.length = 0; const kills2 = Game.kills; P.hp = 5; P.invuln = 0;
    Combat.damage(P, 50, { team: 'enemy' });
    o.playerDie = [names(), Game.kills - kills2, P.hp, P.dead];
    // 플레이어팀이어도 kind 가 player 가 아니면(소환수 등) playerHit 는 없음
    log.length = 0; Combat.damage(TT.mk({ team: 'player', kind: 'pet', hp: 50, x: 100, y: 420 }), 3, { team: 'enemy' }); o.petHit = names();
    // 일반 피격 시 playerHit 만 (enemyKilled 없음), 적이 맞을 땐 playerHit 없음
    P.dead = false; P.hp = 100; P.invuln = 0; log.length = 0; Combat.damage(P, 3, { team: 'enemy' }); o.playerOnlyHit = names();
    log.length = 0; Combat.damage(mk(), 1, { owner: P }); o.enemyNoPlayerHit = names();
    // 과잉 피해: hp 는 0 으로 고정
    const low = mk({ hp: 1 }); Combat.damage(low, 500, { owner: P }); o.overkill = [low.hp, low.dead];
    // 중립 엔티티를 직접 죽여도 enemyKilled 아님
    log.length = 0; const nn = TT.mk({ team: 'neutral', hp: 1 }); Combat.damage(nn, 5); o.neutralDie = names();
    // onHit/onDeath 가 예외를 던져도 파이프라인은 끝까지 간다
    TT.grabErrors(); log.length = 0;
    const bad = mk({ hp: 1, onHit: () => { throw new Error('onHit 폭발'); }, onDeath: () => { throw new Error('onDeath 폭발'); } });
    Combat.damage(bad, 5, { owner: P }); o.hooksThrow = [names(), bad.dead, TT.releaseErrors().length];
    // 훅 안에서 hb 가 그대로 전달되는지
    let seenHb = null; const hbObj = { owner: P, marker: 123 };
    Combat.damage(mk({ hp: 1, onDeath: (e, hb) => { seenHb = hb.marker; } }), 5, hbObj); o.deathHb = seenHb;
    return o;
  });
  check('일반 피격: entityHit 1번, 킬/죽음 이벤트 없음, onHit(e,hb,dmg) 호출, kills 불변', v.hitOnce[0] === 'entityHit,comboChanged' || v.hitOnce[0] === 'comboChanged,entityHit' || v.hitOnce[0] === 'entityHit', JSON.stringify(v.hitOnce));
  check('  └ onHit 인자와 상태', v.hitOnce[1] === 'true,object,5' && v.hitOnce[2] === 'onHit' && v.hitOnce[3] === 15 && v.hitOnce[4] === false && v.hitOnce[5] === 0, JSON.stringify(v.hitOnce));
  check('쓰러뜨림: onHit → onDeath → entityHit → entityDied → enemyKilled 가 각 정확히 1번, kills=1, hp=0·dead', v.kill[1] === 'onHit,onDeath' && v.kill[0].replace(/comboChanged,?/g, '').replace(/,$/, '') === 'entityHit,entityDied,enemyKilled' && v.kill[2] === 0 && v.kill[3] === true && v.kill[4] === 1 && v.kill[5], JSON.stringify(v.kill));
  check('이미 쓰러진 적을 또 때려도 이벤트도 kills 도 늘지 않음', JSON.stringify(v.again) === '[0,0]');
  check('보스: entityHit, entityDied, enemyKilled, bossKilled 순서로 각 1번 (kills 포함)', v.boss[0].replace(/comboChanged,?/g, '').replace(/,$/, '') === 'entityHit,entityDied,enemyKilled,bossKilled' && v.boss[1] === 2, JSON.stringify(v.boss));
  check('플레이어 사망: entityHit, playerHit, entityDied, playerDied (enemyKilled 아님, kills 불변, hp=0)', v.playerDie[0].replace(/comboChanged,?/g, '').replace(/,$/, '') === 'entityHit,playerHit,entityDied,playerDied' && v.playerDie[1] === 0 && v.playerDie[2] === 0 && v.playerDie[3] === true, JSON.stringify(v.playerDie));
  check('플레이어가 살아서 맞으면 entityHit+playerHit 만, 적이 맞으면 playerHit 없음', v.playerOnlyHit.replace(/comboChanged,?/g, '').replace(/,$/, '') === 'entityHit,playerHit' && !v.enemyNoPlayerHit.includes('playerHit'), JSON.stringify([v.playerOnlyHit, v.enemyNoPlayerHit]));
  check('플레이어팀 소환수(kind≠player)가 맞아도 playerHit 는 없음 (entityHit 만)', v.petHit.replace(/comboChanged,?/g, '').replace(/,$/, '') === 'entityHit', v.petHit);
  check('과잉 피해: hp 는 0 으로 (음수 없음)', JSON.stringify(v.overkill) === '[0,true]');
  check('중립이 죽어도 enemyKilled/playerDied 없음', !v.neutralDie.includes('enemyKilled') && !v.neutralDie.includes('playerDied') && v.neutralDie.includes('entityDied'), v.neutralDie);
  check('onHit/onDeath 가 예외를 던져도 쓰러짐 처리와 이벤트는 끝까지 진행 (오류 2개 기록)', v.hooksThrow[0].includes('entityDied') && v.hooksThrow[0].includes('enemyKilled') && v.hooksThrow[1] === true && v.hooksThrow[2] === 2, JSON.stringify(v.hooksThrow));
  check('onDeath 에 hb 가 그대로 전달됨', v.deathHb === 123);

  // 콤보
  const c = await ev(() => {
    Debug.noVariance = true; Entities.clear(); Events.clear();
    Game.resetRun({}); const o = {};
    const P = TT.mk({ kind: 'player', team: 'player', x: 100, y: 420, hp: 1000, maxHp: 1000, persistent: true });
    const E = () => TT.mk({ team: 'enemy', x: 300, y: 420, hp: 1000 });
    const changes = []; Events.on('comboChanged', d => changes.push(d.count + '/' + d.max));
    const t = E();
    Combat.damage(t, 1, { owner: P }); o.one = [Game.combo.count, Game.combo.timer, Game.combo.max];
    t.invuln = 0; Combat.damage(t, 1, { owner: P }); t.invuln = 0; Combat.damage(t, 1, { team: 'player' }); o.three = [Game.combo.count, Game.combo.max];
    Game.combo.timer = 10; t.invuln = 0; Combat.damage(t, 1, { owner: P }); o.timerRefreshed = Game.combo.timer;
    // 적이 때리거나 hb 가 없으면 콤보는 안 늘어남
    const enemyAtk = E(); const before = Game.combo.count;
    t.invuln = 0; Combat.damage(t, 1, { owner: enemyAtk }); t.invuln = 0; Combat.damage(t, 1); o.noGain = Game.combo.count - before;
    // 플레이어가 맞으면 count=0, max 유지, 무적 45
    const maxBefore = Game.combo.max; Combat.damage(P, 1, { team: 'enemy' }); o.afterHit = [Game.combo.count, Game.combo.max === maxBefore, P.invuln, Game.combo.timer];
    // 무적 중에는 콤보가 올라가지 않음 (피해가 안 들어갔으니까)
    const t2 = E(); t2.invuln = 5; const c0 = Game.combo.count; Combat.damage(t2, 1, { owner: P }); o.invulnNoCombo = Game.combo.count - c0;
    // 콤보 다시 쌓기 + max 갱신
    Game.resetRun({}); const t3 = E(); for (let i = 0; i < 5; i++) { t3.invuln = 0; Combat.damage(t3, 1, { owner: P }); } o.five = [Game.combo.count, Game.combo.max];
    P.invuln = 0; Combat.damage(P, 1, { team: 'enemy' }); for (let i = 0; i < 2; i++) { t3.invuln = 0; Combat.damage(t3, 1, { owner: P }); } o.maxKept = [Game.combo.count, Game.combo.max];
    // tickCombo: 타이머 감소 → 0 이면 끊김
    Game.combo.timer = 3; Game.combo.count = 4; const tk = []; for (let i = 0; i < 4; i++) { Game.tickCombo(); tk.push(Game.combo.count + ':' + Game.combo.timer); } o.tick = tk.join();
    o.changes = changes.slice(0, 4).join();
    // 파이프라인 5단계: 플레이어가 맞으면 invuln = CFG.playerInvuln
    o.cfg = [CFG.playerInvuln, CFG.comboWindow];
    return o;
  });
  check('콤보: 플레이어팀이 때리면 count+1, timer=comboWindow(90), max 갱신', JSON.stringify(c.one) === '[1,90,1]' && JSON.stringify(c.three) === '[3,3]', JSON.stringify([c.one, c.three]));
  check('콤보: 맞을 때마다 timer 가 다시 90', c.timerRefreshed === 90);
  check('콤보: 적이 때리거나 hb 없는 피해(함정)는 콤보를 올리지 않음', c.noGain === 0);
  check('콤보: 플레이어가 맞으면 count=0 (max·유지), 무적 CFG.playerInvuln(45)', c.afterHit[0] === 0 && c.afterHit[1] === true && c.afterHit[2] === 45 && c.afterHit[3] === 0, JSON.stringify(c.afterHit));
  check('콤보: 무적이라 무시된 타격은 콤보 증가 없음', c.invulnNoCombo === 0);
  check('콤보: 끊긴 뒤 다시 쌓이고 max 는 최고 기록 유지', JSON.stringify(c.five) === '[5,5]' && JSON.stringify(c.maxKept) === '[2,5]', JSON.stringify([c.five, c.maxKept]));
  check('Game.tickCombo(덤): 타이머가 줄어 0 이 되면 콤보 끊김', c.tick === '4:2,4:1,0:0,0:0', c.tick);
  check("comboChanged 이벤트가 {count,max} 로 매번 발행됨 (1/1, 2/2, 3/3 …)", c.changes.startsWith('1/1,2/2,3/3'), c.changes);

  // Debug.god
  const gd = await ev(() => {
    Entities.clear(); Events.clear(); FX.clear(); Debug.noVariance = true;
    const P = TT.mk({ kind: 'player', team: 'player', x: 100, y: 420, hp: 100, maxHp: 100, persistent: true });
    const E = TT.mk({ team: 'enemy', x: 300, y: 420, hp: 100 });
    const log = TT.evlog(['entityHit', 'playerHit']);
    Debug.god = true;
    const r1 = Combat.damage(P, 50, { team: 'enemy' });
    const o = { god: [r1, P.hp, P.invuln, P.flash, FX.popups.length, log.length, P.stun] };
    o.enemyStillHurt = Combat.damage(E, 10, { owner: P }) > 0 && E.hp === 90;
    const ally = TT.mk({ team: 'player', kind: 'pet', hp: 10, x: 100, y: 420 }); o.allyGod = Combat.damage(ally, 5) + ':' + ally.hp;
    Debug.god = false; o.afterGod = Combat.damage(P, 50, { team: 'enemy' }) > 0 && P.hp === 50;
    return o;
  });
  check('Debug.god: 플레이어팀은 피해·무적·번쩍·팝업·이벤트 전부 없음, 적은 그대로 피해', JSON.stringify(gd.god) === '[0,100,0,0,0,0,0]' && gd.enemyStillHurt && gd.allyGod === '0:10', JSON.stringify(gd));
  check('Debug.god=false 로 되돌리면 다시 맞음', gd.afterGod);
});

// =====================================================================
await section('히트스톱 · 입력 버퍼 · Loop', async () => {
  await reset();
  const r = await ev(() => {
    const o = {}; let updates = 0; const seen = [];
    Scenes.T = { update() { updates++; seen.push(Input.wasPressed('KeyZ')); } };
    Game.scene = 'T';
    Loop.step(3); o.plain = updates;
    FX.freeze(5); Loop.step(5); o.during = updates;                   // 5프레임 동안 update 안 돎
    Loop.step(1); o.after = updates; o.hitstopLeft = FX.hitstop;
    // 히트스톱 중에 누른 키는 멈춤이 끝난 뒤에도 눌린 상태로 남아 있다가 첫 update 에서 보임
    updates = 0; seen.length = 0; Input.clear();
    FX.freeze(4); Loop.step(2); Input.press('KeyZ'); Loop.step(1);
    o.pressedDuringFreeze = [Input.wasPressed('KeyZ'), updates];       // 아직 멈춤 중(3프레임째): pressed 유지
    Loop.step(1); o.stillAtEndOfFreeze = [Input.wasPressed('KeyZ'), updates];   // 4프레임째: hitstop 0 이 됨
    Loop.step(1); o.afterFreeze = [Input.wasPressed('KeyZ'), updates, seen.join(), Input.isDown('KeyZ')];
    // 평소에는 눌린 프레임의 update 에서 보이고 그 프레임 끝에 비워짐
    updates = 0; seen.length = 0; Input.clear(); Input.press('KeyZ'); Loop.step(2); o.normal = [seen.join(), Input.wasPressed('KeyZ'), Input.isDown('KeyZ')];
    // hooks: 매 tick 의 update 직전 (히트스톱 중에도), 일시정지 중엔 안 불림
    let hooks = 0, hookSawUpdate = null; const order = [];
    Scenes.T = { update() { order.push('update'); } };
    Loop.hooks.push(() => { hooks++; order.push('hook'); });
    Loop.step(2); o.hookOrder = order.join();
    FX.freeze(2); Loop.step(2); o.hookDuringFreeze = hooks;
    Game.paused = true; Loop.step(5); o.hookWhilePaused = hooks;
    Game.paused = false;
    // tick/step 카운트와 일시정지
    const c0 = Loop.tickCount; Loop.step(10); o.tickCount = Loop.tickCount - c0;
    Game.paused = true; const c1 = Loop.tickCount; Loop.step(10); o.pausedTicks = Loop.tickCount - c1; Game.paused = false;
    Loop.hooks.length = 0;
    // 훅이 예외를 던져도 루프는 계속
    TT.grabErrors(); Loop.hooks.push(() => { throw new Error('hook 폭발'); }); let u3 = 0; Scenes.T = { update() { u3++; } };
    Loop.step(4); o.hookThrow = [u3, TT.releaseErrors().length]; Loop.hooks.length = 0;
    return o;
  });
  check('Loop.step(n) 은 update 를 n번 돌림 (히트스톱이 없으면)', r.plain === 3);
  check('FX.freeze(5): 5틱 동안 scene.update 가 안 돌고, 6틱째부터 돎', r.during === 3 && r.after === 4 && r.hitstopLeft === 0, JSON.stringify([r.during, r.after, r.hitstopLeft]));
  check('입력 버퍼: 히트스톱 중에 누른 키가 멈춤이 끝나도 유지됨', r.pressedDuringFreeze[0] === true && r.stillAtEndOfFreeze[0] === true && r.stillAtEndOfFreeze[1] === 0, JSON.stringify([r.pressedDuringFreeze, r.stillAtEndOfFreeze]));
  check('입력 버퍼: 멈춤 뒤 첫 update 에서 pressed 로 보이고(공격이 안 씹힘), 그 틱 끝에 비워짐', r.afterFreeze[1] === 1 && r.afterFreeze[2] === 'true' && r.afterFreeze[0] === false && r.afterFreeze[3] === true, JSON.stringify(r.afterFreeze));
  check('평소에는 누른 프레임에만 pressed (두 번째 프레임엔 false), down 은 유지', r.normal[0] === 'true,false' && r.normal[1] === false && r.normal[2] === true, JSON.stringify(r.normal));
  check('hooks 는 update 직전에 불림 (hook,update 순서), 히트스톱 중에도 불림', r.hookOrder === 'hook,update,hook,update' && r.hookDuringFreeze === 4, JSON.stringify([r.hookOrder, r.hookDuringFreeze]));
  check('일시정지 중에는 tick 이 아무것도 안 함 (hooks 도 안 불림, tickCount 불변)', r.hookWhilePaused === 4 && r.tickCount === 10 && r.pausedTicks === 0);
  check('hooks 가 예외를 던져도 update 는 계속 (오류는 1번만 기록)', r.hookThrow[0] === 4 && r.hookThrow[1] === 1, JSON.stringify(r.hookThrow));

  const f = await ev(() => {
    const o = {}; let n = 0;
    const real = Scenes.play;
    Scenes.play = { update() { n++; } };
    Game.scene = 'play'; Game.frame = 0;
    Loop.step(5); o.playFrames = [Game.frame, n];
    FX.freeze(3); Loop.step(3); o.noFrameDuringFreeze = Game.frame;
    Game.paused = true; Loop.step(4); o.noFrameWhilePaused = Game.frame; Game.paused = false;
    Game.scene = 'T'; Scenes.T = { update() {} }; Loop.step(5); o.otherScene = Game.frame;
    Scenes.play = real; if (real === undefined) delete Scenes.play;
    return o;
  });
  check('Game.frame 은 play 씬의 실제 update 마다 +1 (히트스톱·일시정지·다른 씬 제외)', JSON.stringify(f.playFrames) === '[5,5]' && f.noFrameDuringFreeze === 5 && f.noFrameWhilePaused === 5 && f.otherScene === 5, JSON.stringify(f));

  // 연결: 실제 타격이 정확히 3틱 멈춤을 만든다
  const integ = await ev(() => {
    Entities.clear(); Debug.noVariance = true; let n = 0; Scenes.T = { update() { n++; Entities.updateAll(); } }; Game.scene = 'T';
    const P = TT.mk({ team: 'player', x: 100, y: 420 }), E = TT.mk({ team: 'enemy', x: 150, y: 420, hp: 99 });
    Combat.applyHitbox(Combat.frontBox(P, 80, { damage: 5 }));
    Loop.step(5); return [n, FX.hitstop, E.hp];
  });
  check('실제 타격(hb.freeze 기본 3) → 5틱 중 3틱 멈추고 update 는 2번만', integ[0] === 2 && integ[1] === 0 && integ[2] === 94, JSON.stringify(integ));
});

await section('Loop: 실제 시간으로 도는 루프', async () => {
  const t = await openCustom();
  await t.page.evaluate(() => { Loop.manual = false; Scenes.T = { update() {} }; Game.scene = 'T'; });
  const c0 = await t.page.evaluate(() => Loop.tickCount);
  await t.page.waitForTimeout(1000);
  const c1 = await t.page.evaluate(() => Loop.tickCount);
  const per = c1 - c0;
  check('manual=false 면 실시간 약 60 tick/초 (고정 타임스텝)', per >= 25 && per <= 75, `${per} tick/1초`);
  // 오래 멈췄다 와도 한 번에 100ms(= 약 6틱) 이상 몰아서 돌지 않음
  const burst = await t.page.evaluate(async () => {
    const b0 = Loop.tickCount, t0 = performance.now();
    while (performance.now() - t0 < 900) { /* 메인 스레드를 0.9초 막음 */ }
    await new Promise(r => requestAnimationFrame(() => r()));
    return Loop.tickCount - b0;
  });
  check('0.9초 멈췄다 와도 최대 100ms 치(≈6틱)만 따라잡음 (폭주 방지)', burst >= 0 && burst <= 9, `${burst}틱`);
  // manual=true 면 update 가 안 돎
  const m = await t.page.evaluate(async () => { Loop.manual = true; const a = Loop.tickCount; await new Promise(r => setTimeout(r, 300)); return Loop.tickCount - a; });
  check('manual=true 면 RAF 가 돌아도 update(tick) 는 안 돎', m === 0, String(m));
  check('실시간 루프 동안 페이지 오류 없음', t.errors.length === 0, t.errors.join(' | '));
  await t.close();
});

// =====================================================================
await section('Input', async () => {
  await reset();
  const r = await ev(() => {
    const o = {};
    const key = (type, code, extra = {}, target = window) => { const e = new KeyboardEvent(type, { code, key: extra.key || '', bubbles: true, cancelable: true, repeat: !!extra.repeat }); target.dispatchEvent(e); return e; };
    // 코드 기준: 한글 입력 상태(key='ㅋ')에서도 KeyZ
    key('keydown', 'KeyZ', { key: 'ㅋ' }); o.koreanDown = [Input.isDown('KeyZ'), Input.wasPressed('KeyZ'), Input.down.KeyZ === true, Input.pressed.KeyZ === true];
    key('keydown', 'KeyZ', { key: 'ㅋ', repeat: true }); Loop.step(1);                // 꾹 누름(반복) + 한 프레임 진행
    o.afterFrame = [Input.isDown('KeyZ'), Input.wasPressed('KeyZ')];
    key('keydown', 'KeyZ', { repeat: true }); o.repeatNoPress = Input.wasPressed('KeyZ');   // 이미 눌린 상태의 반복은 pressed 가 아님
    key('keyup', 'KeyZ'); o.up = [Input.isDown('KeyZ'), 'KeyZ' in Input.down];
    // Space → KeyZ 별칭
    const sp = key('keydown', 'Space'); o.space = [Input.isDown('KeyZ'), Input.down.Space, Input.wasPressed('KeyZ'), sp.defaultPrevented, Input.isDown('Space')];
    key('keyup', 'Space'); o.spaceUp = Input.isDown('KeyZ');
    Input.press('Space'); o.pressSpace = [Input.down.KeyZ, Input.down.Space]; Input.release('Space'); o.releaseSpace = Input.isDown('KeyZ');
    Loop.step(1);
    // preventDefault 는 방향키/Space 만
    o.prevented = {}; ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'KeyZ', 'KeyX', 'KeyA', 'KeyS', 'KeyD', 'KeyP', 'KeyM', 'Escape', 'Enter', 'Tab', 'F5', 'KeyR'].forEach(c => { o.prevented[c] = key('keydown', c).defaultPrevented; key('keyup', c); });
    Input.clear();
    // 여러 키 동시에, 순서 무관
    key('keydown', 'ArrowRight'); key('keydown', 'ArrowUp'); key('keydown', 'KeyX');
    o.multi = [Input.isDown('ArrowRight'), Input.isDown('ArrowUp'), Input.isDown('KeyX'), Input.isDown('ArrowLeft')];
    key('keyup', 'ArrowUp'); o.multiUp = [Input.isDown('ArrowRight'), Input.isDown('ArrowUp'), Input.isDown('KeyX')];
    // Input.clear 는 같은 객체를 비움 (참조를 들고 있는 모듈이 안전)
    const dRef = Input.down, pRef = Input.pressed; Input.clear(); o.sameObjects = [Input.down === dRef, Input.pressed === pRef, Object.keys(dRef).length, Object.keys(pRef).length];
    // press/release 프로그램 호출 = keydown/keyup 과 같은 의미
    Input.press('KeyA'); o.prog = [Input.isDown('KeyA'), Input.wasPressed('KeyA')]; Input.press('KeyA'); Input.endFrame(); o.progEnd = [Input.isDown('KeyA'), Input.wasPressed('KeyA')]; Input.release('KeyA'); o.progUp = Input.isDown('KeyA');
    Input.press('KeyB'); Input.press('KeyB'); Input.endFrame(); Input.press('KeyB'); o.noRepress = Input.wasPressed('KeyB');                 // 계속 눌려 있으면 다시 pressed 가 안 됨
    Input.clear();
    return o;
  });
  check('코드 기준: key 가 한글(ㅋ)이어도 KeyZ 로 동작, down+pressed 둘 다 켜짐', JSON.stringify(r.koreanDown) === '[true,true,true,true]', JSON.stringify(r.koreanDown));
  check('한 프레임 지나면 pressed 는 꺼지고 down 은 유지', JSON.stringify(r.afterFrame) === '[true,false]');
  check('키 반복(꾹 누름)은 pressed 를 다시 켜지 않음', r.repeatNoPress === false);
  check('keyup 하면 down 에서 사라짐', JSON.stringify(r.up) === '[false,false]');
  check('Space → KeyZ 별칭: Space 는 따로 안 남고 KeyZ 로 기록, preventDefault 됨', JSON.stringify(r.space) === '[true,null,true,true,true]' && r.spaceUp === false, JSON.stringify(r.space));
  check('Input.press/release("Space") 도 KeyZ 로 별칭', JSON.stringify(r.pressSpace) === '[true,null]' && r.releaseSpace === false, JSON.stringify(r.pressSpace));
  const wantPrevent = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space'];
  check('preventDefault: 방향키 4개와 Space 만', Object.entries(r.prevented).every(([c, p]) => p === wantPrevent.includes(c)), JSON.stringify(r.prevented));
  check('여러 키 동시 입력, 하나만 떼면 나머지는 유지', JSON.stringify(r.multi) === '[true,true,true,false]' && JSON.stringify(r.multiUp) === '[true,false,true]');
  check('Input.clear 는 down/pressed 객체를 그대로 두고 내용만 비움', JSON.stringify(r.sameObjects) === '[true,true,0,0]');
  check('press/release/endFrame 의 의미: 눌림→pressed, endFrame→pressed 꺼짐, 계속 눌림은 재-pressed 아님', JSON.stringify([r.prog, r.progEnd, r.progUp, r.noRepress]) === '[[true,true],[true,false],false,false]', JSON.stringify([r.prog, r.progEnd, r.progUp, r.noRepress]));

  // 입력칸(INPUT/TEXTAREA/SELECT)에 포커스가 있으면 게임 키로 새지 않음 — 진짜 키보드로
  await ev(() => {
    document.body.insertAdjacentHTML('beforeend', '<input id="tIn" style="position:fixed;left:0;top:0;z-index:99999"><textarea id="tTa" style="position:fixed;left:0;top:40px;z-index:99999"></textarea><select id="tSel" style="position:fixed;left:0;top:90px;z-index:99999"><option>a</option><option>b</option></select>');
    window.__prevented = [];
    window.addEventListener('keydown', e => window.__prevented.push(e.code + ':' + e.defaultPrevented), { capture: false });   // 게임 핸들러 다음에 불림(같은 window, 등록 순서)
  });
  await page.focus('#tIn');
  for (const k of ['KeyZ', 'KeyX', 'ArrowLeft', 'Space', 'KeyA']) await page.keyboard.press(k);
  const typed = await ev(() => ({ down: Object.keys(Input.down).join(), pressed: Object.keys(Input.pressed).join(), value: document.getElementById('tIn').value, prevented: window.__prevented.join() }));
  check('INPUT 에 포커스: 게임 키(Z/X/방향키/Space/A)가 Input 에 안 들어감', typed.down === '' && typed.pressed === '', JSON.stringify(typed));
  check('INPUT 에 포커스: 글자는 정상 입력되고(z x ← 공백 a 순서로 눌러 z ax), Space/방향키 기본동작도 막지 않음', typed.value === 'z ax' && !typed.prevented.includes('Space:true') && !typed.prevented.includes('ArrowLeft:true'), `value="${typed.value}" ${typed.prevented}`);
  await page.focus('#tTa'); await page.keyboard.press('KeyZ'); await page.keyboard.press('Space');
  await page.focus('#tSel'); await page.keyboard.press('KeyZ'); await page.keyboard.press('ArrowDown');
  check('TEXTAREA / SELECT 에서도 무시', await ev(() => Object.keys(Input.down).length + Object.keys(Input.pressed).length) === 0);
  await ev(() => { document.getElementById('tIn').blur(); document.getElementById('tTa').blur(); document.getElementById('tSel').blur(); document.activeElement && document.activeElement.blur && document.activeElement.blur(); });
  await page.evaluate(() => document.body.focus());
  await page.keyboard.press('KeyZ');
  const afterTyping = await ev(() => Input.wasPressed('KeyZ'));
  check('포커스가 입력칸을 떠나면 다시 게임 키가 먹음', afterTyping === true);
  await ev(() => { Input.clear(); });

  // 입력칸에 포커스가 가면 눌려 있던 키는 해제됨, 입력칸에서 떼는 keyup 은 그래도 반영됨(고착 방지)
  const stuck = await ev(() => {
    Input.press('ArrowRight'); Input.press('KeyZ');
    const inp = document.getElementById('tIn'); inp.focus();
    const a = Object.keys(Input.down).length;
    Input.press('KeyX'); inp.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyX', bubbles: true })); const b = Input.isDown('KeyX');
    inp.blur(); Input.clear();
    return [a, b];
  });
  check('입력칸으로 포커스가 가면 눌려 있던 키 해제 / 입력칸에서의 keyup 은 키 고착을 막기 위해 반영', stuck[0] === 0 && stuck[1] === false, JSON.stringify(stuck));
  await ev(() => ['tIn', 'tTa', 'tSel'].forEach(id => document.getElementById(id).remove()));

  // 창 포커스 잃음 / 탭 숨김
  const b = await ev(() => {
    const o = {}; let blurs = 0; Events.clear(); Events.on('windowBlur', () => blurs++);
    Input.press('ArrowRight'); Input.press('KeyZ'); window.dispatchEvent(new Event('blur'));
    o.blur = [Object.keys(Input.down).length, Object.keys(Input.pressed).length, blurs];
    Input.press('KeyX'); document.dispatchEvent(new Event('visibilitychange')); o.visibleNoBlur = [Input.isDown('KeyX'), blurs];      // 숨김이 아니면 아무 일 없음
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    o.hidden = [Object.keys(Input.down).length, blurs];
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange'));
    delete document.hidden;
    return o;
  });
  check('창 blur → 눌린 키 전부 해제 + windowBlur 이벤트 1번', JSON.stringify(b.blur) === '[0,0,1]', JSON.stringify(b.blur));
  check('탭이 보이는 상태의 visibilitychange 는 무시, 숨겨지면 해제 + windowBlur', JSON.stringify(b.visibleNoBlur) === '[true,1]' && JSON.stringify(b.hidden) === '[0,2]', JSON.stringify([b.visibleNoBlur, b.hidden]));
  await page.waitForTimeout(300);   // 오디오 suspend/resume 이 끝나길 기다림
});

await section('Input.bindButton (터치/마우스 버튼)', async () => {
  await reset();
  await ev(() => {
    document.body.insertAdjacentHTML('beforeend', '<div id="bA" style="position:fixed;left:300px;top:300px;width:100px;height:60px;background:#ccc;z-index:99999"></div><div id="bB" style="position:fixed;left:500px;top:300px;width:100px;height:60px;background:#ccc;z-index:99999"></div>');
    window.__unbindA = Input.bindButton(document.getElementById('bA'), 'KeyA');
    Input.bindButton(document.getElementById('bB'), 'Space');
  });
  const st = await ev(() => { const s = document.getElementById('bA').style; return [s.touchAction, s.userSelect]; });
  check('bindButton: touch-action:none 과 user-select:none 설정', st[0] === 'none' && st[1] === 'none', JSON.stringify(st));
  const keys = () => ev(() => [Input.isDown('KeyA'), Input.wasPressed('KeyA')]);
  await page.mouse.move(350, 330);
  await page.mouse.down();
  check('bindButton: 버튼을 누르면 down+pressed', JSON.stringify(await keys()) === '[true,true]');
  await ev(() => Loop.step(1));
  check('bindButton: 누르고 있는 동안 down 유지, pressed 는 1프레임뿐', JSON.stringify(await keys()) === '[true,false]');
  await page.mouse.move(700, 100, { steps: 5 });
  check('bindButton: 손가락(포인터)이 버튼 밖으로 나가도 계속 눌림 (setPointerCapture)', JSON.stringify(await keys()) === '[true,false]');
  await page.mouse.up();
  check('bindButton: 떼면 해제', (await keys())[0] === false);
  // 두 번째 버튼은 Space → KeyZ 별칭
  await page.mouse.move(550, 330); await page.mouse.down();
  const z1 = await ev(() => Input.isDown('KeyZ')); await page.mouse.up();
  check('bindButton: 코드 Space 를 연결해도 KeyZ 로 동작', z1 === true && (await ev(() => Input.isDown('KeyZ'))) === false);
  // 가짜 포인터(캡처 실패)·pointercancel·여러 손가락
  const pc = await ev(() => {
    const el = document.getElementById('bA'); const o = {};
    const pe = (type, id) => el.dispatchEvent(new PointerEvent(type, { pointerId: id, bubbles: true, cancelable: true }));
    pe('pointerdown', 77); o.fakeDown = Input.isDown('KeyA'); pe('pointercancel', 77); o.cancel = Input.isDown('KeyA');
    pe('pointerdown', 1); pe('pointerdown', 2); pe('pointerup', 1); o.twoFingersOneUp = Input.isDown('KeyA'); pe('pointerup', 2); o.bothUp = Input.isDown('KeyA');
    pe('pointerdown', 5); pe('pointerleave', 5); o.leaveWithoutCapture = Input.isDown('KeyA');
    const ctx = new MouseEvent('contextmenu', { bubbles: true, cancelable: true }); el.dispatchEvent(ctx); o.noMenu = ctx.defaultPrevented;
    pe('pointerdown', 9); window.__unbindA(); o.unbound = Input.isDown('KeyA'); pe('pointerdown', 10); o.afterUnbind = Input.isDown('KeyA');
    return o;
  });
  check('bindButton: 가짜 포인터 id 로 캡처가 실패해도 throw 없이 동작, pointercancel 로 해제', pc.fakeDown === true && pc.cancel === false, JSON.stringify(pc));
  check('bindButton: 손가락 두 개 중 하나만 떼면 유지, 둘 다 떼면 해제', pc.twoFingersOneUp === true && pc.bothUp === false);
  check('bindButton: 캡처 없이 포인터가 떠나면 해제 / 길게 눌러 뜨는 메뉴(contextmenu) 방지', pc.leaveWithoutCapture === false && pc.noMenu === true);
  check('bindButton 이 돌려주는 해제 함수: 호출하면 눌림이 풀리고 더는 반응 안 함', pc.unbound === false && pc.afterUnbind === false);
  await ev(() => { ['bA', 'bB'].forEach(id => document.getElementById(id).remove()); Input.clear(); });
});

await section('터치 기기 감지', async () => {
  const plain = await ev(() => Game.touch);
  check('터치 없는 데스크톱: Game.touch === false', plain === false);
  const up = await ev(() => {
    let n = 0; Events.on('touchDetected', () => n++);
    window.dispatchEvent(new Event('touchstart')); window.dispatchEvent(new Event('touchstart'));
    return [Game.touch, n];
  });
  check('첫 touchstart 에 Game.touch=true 로 갱신 (이벤트 touchDetected 는 1번)', up[0] === true && up[1] === 1, JSON.stringify(up));
  const t = await openGame({ touch: true });
  const tt = await t.page.evaluate(() => Game.touch);
  check('터치 지원 환경(hasTouch)에서는 시작부터 Game.touch === true', tt === true);
  await t.close();
  await ev(() => { Game.touch = false; });
});

// =====================================================================
await section('Store: 음소거 저장', async () => {
  await ev(() => { SFX.setMuted(true); });
  await reopen();
  const muted = await ev(() => [SFX.muted, Store.get('muted')]);
  check('SFX.setMuted(true) 는 Store 에 저장되고 새로고침 뒤에도 유지', JSON.stringify(muted) === '[true,true]', JSON.stringify(muted));
  await ev(() => { SFX.setMuted(false); });
  check('setMuted(false) → muted=false 저장', await ev(() => [SFX.muted, Store.get('muted')]).then(a => JSON.stringify(a) === '[false,false]'));
});

await section('SFX/Music: 초기화 전에도, 오디오가 없어도 절대 throw 안 함', async () => {
  const names = await ev(() => SFX.names);
  check('SFX 이름 19개가 계약서와 일치', JSON.stringify([...names].sort()) === JSON.stringify('swing hit hitBig jump land skill1 skill2 ultimate hurt enemyDie bossHit bossDie coin heal ui go clear gameover warn star'.split(' ').sort()), names.join(' '));

  const hostile = (label, init) => async () => {
    const t = await openCustom({ init });
    const r = await t.page.evaluate(() => {
      const fails = [];
      const tryit = (name, fn) => { try { fn(); } catch (e) { fails.push(name + ': ' + e.message); } };
      SFX.names.forEach(n => tryit('play ' + n, () => SFX.play(n)));
      [undefined, null, '', 'nope', 42, {}, [], 'hit '].forEach(v => tryit('play ' + String(v), () => SFX.play(v)));
      tryit('play opts', () => { SFX.play('hit', null); SFX.play('hit', 'x'); SFX.play('hit', { rate: NaN, vol: -5, delay: 'a' }); SFX.play('hit', 7); });
      ['title', 'stage', 'boss', null, undefined, 'nope', 123].forEach(v => tryit('music ' + String(v), () => Music.play(v)));
      tryit('init x3', () => { SFX.init(); SFX.init(); SFX.init(); });
      tryit('play after init', () => SFX.names.forEach(n => SFX.play(n)));
      tryit('music after init', () => { Music.play('stage'); Music.play('boss'); Music.play(null); });
      tryit('setMuted', () => { SFX.setMuted(true); SFX.play('hit'); Music.play('title'); SFX.setMuted(false); Music.play(null); });
      return { fails, active: SFX.active(), hasAC: typeof window.AudioContext };
    });
    return { r, errors: t.errors, close: t.close };
  };
  let t1 = await hostile('초기화 전', null)();
  check('초기화(init) 전: 모든 이름·이상한 값으로 play/Music.play 해도 throw 없음, 소리도 안 쌓임', t1.r.fails.length === 0 && t1.errors.length === 0, JSON.stringify(t1.r.fails) + t1.errors.join('|'));
  await t1.close();
  t1 = await hostile('AudioContext 없음', () => { delete window.AudioContext; delete window.webkitAudioContext; })();
  check('AudioContext 가 없는 브라우저: init/play/Music 전부 조용히 무시', t1.r.hasAC === 'undefined' && t1.r.fails.length === 0 && t1.r.active === 0 && t1.errors.length === 0, JSON.stringify(t1.r) + t1.errors.join('|'));
  await t1.close();
  t1 = await hostile('AudioContext 생성이 예외', () => { window.AudioContext = function () { throw new Error('no audio'); }; delete window.webkitAudioContext; })();
  check('AudioContext 생성자가 예외를 던져도 조용히 무시', t1.r.fails.length === 0 && t1.errors.length === 0, JSON.stringify(t1.r) + t1.errors.join('|'));
  await t1.close();

  // 사용자 제스처 없이 Music.play → 곡을 기억했다가 init 되면 시작
  const t2 = await openCustom();
  const lazy = await t2.page.evaluate(async () => {
    Music.play('stage'); const before = [Music.current, Music.isPlaying()];
    SFX.init(); const after = [Music.current, Music.isPlaying()];
    Music.play(null); return { before, after, stopped: [Music.current, Music.isPlaying()] };
  });
  check('init 전에 Music.play(곡) → 곡을 기억만 하고, SFX.init() 뒤에 실제로 시작, play(null) 이면 정지', JSON.stringify(lazy) === '{"before":["stage",false],"after":["stage",true],"stopped":[null,false]}', JSON.stringify(lazy));
  check('  └ 제스처 없는 호출에도 페이지 오류 없음', t2.errors.length === 0, t2.errors.join('|'));
  await t2.close();
});

await section('SFX/Music: 소리 품질 (오프라인 렌더로 파형 검사)', async () => {
  const t = await openCustom();
  const res = await t.page.evaluate(async () => {
    const out = { sfx: {}, names: SFX.names };
    for (const n of SFX.names) {
      const a = await SFX.render(n);
      let peak = 0, sumSq = 0, lastLoud = 0, bad = 0;
      for (let i = 0; i < a.length; i++) { const x = a[i]; if (!isFinite(x)) bad++; const ax = Math.abs(x); if (ax > peak) peak = ax; sumSq += x * x; if (ax > 0.003) lastLoud = i; }
      // 앞쪽 0.3초 안에 소리가 시작되는지
      let first = 0; while (first < a.length && Math.abs(a[first]) < 0.003) first++;
      out.sfx[n] = { len: a.length, peak, rms: Math.sqrt(sumSq / a.length), end: lastLoud / 44100, start: first / 44100, bad, info: SFX.info(n) };
    }
    return out;
  });
  const names = res.names;
  const sil = names.filter(n => res.sfx[n].peak < 0.02), clip = names.filter(n => res.sfx[n].peak > 0.26), nonfinite = names.filter(n => res.sfx[n].bad > 0);
  check('모든 효과음이 소리가 남 (조용하지 않음, 피크 > 0.02)', sil.length === 0, sil.join(' ') + ' ' + names.map(n => n + ':' + res.sfx[n].peak.toFixed(3)).join(' '));
  check('모든 효과음이 마스터(0.25) 이하로 찢어지지 않음 + NaN/Infinity 없음', clip.length === 0 && nonfinite.length === 0, clip.join(' '));
  const over = names.filter(n => res.sfx[n].end > res.sfx[n].info.dur + 0.1);
  check('각 소리는 선언한 길이(dur)+0.1초 안에 끝남 (동시 재생 수 계산이 정확)', over.length === 0, over.map(n => `${n}:${res.sfx[n].end.toFixed(2)}>${res.sfx[n].info.dur}`).join(' '));
  const late = names.filter(n => res.sfx[n].start > 0.12);
  check('소리가 지연 없이 바로 시작 (0.12초 이내)', late.length === 0, late.join(' '));
  check('길이 감각: ui/swing/hit/land/jump 는 짧고(<0.4초), 보스 쓰러짐/클리어/궁극기/게임오버는 길다(>0.8초)', ['ui', 'swing', 'hit', 'land', 'jump'].every(n => res.sfx[n].end < 0.4) && ['bossDie', 'clear', 'ultimate', 'gameover'].every(n => res.sfx[n].end > 0.8), names.map(n => `${n}=${res.sfx[n].end.toFixed(2)}`).join(' '));
  check('조용한 소리가 있고(ui) 큰 소리도 있음(hitBig, ultimate): 상대 크기 구분', res.sfx.ui.peak < res.sfx.hitBig.peak && res.sfx.ui.peak < res.sfx.ultimate.peak);

  // 서로 다른 소리인지: 앞 0.4초를 영점 상관으로 비교
  const dist = await t.page.evaluate(async () => {
    const sig = {};
    for (const n of SFX.names) { const a = await SFX.render(n); sig[n] = Array.from(a.slice(0, 17640)); }
    const pairs = [];
    const names = SFX.names;
    for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
      const a = sig[names[i]], b = sig[names[j]]; let ab = 0, aa = 0, bb = 0;
      for (let k = 0; k < 17640; k++) { const x = a[k] || 0, y = b[k] || 0; ab += x * y; aa += x * x; bb += y * y; }
      pairs.push([names[i], names[j], Math.abs(ab / Math.sqrt(aa * bb + 1e-12))]);
    }
    pairs.sort((x, y) => y[2] - x[2]);
    return pairs.slice(0, 3);
  });
  check('모든 효과음이 서로 다르게 들림 (파형 상관 < 0.8)', dist[0][2] < 0.8, dist.map(p => `${p[0]}~${p[1]}:${p[2].toFixed(2)}`).join(' '));

  // 전부 한꺼번에 울려도 찢어지지 않음
  const spam = await t.page.evaluate(async () => {
    const all = []; for (let i = 0; i < 4; i++) all.push(...SFX.names);
    const a = await SFX.render(all); let peak = 0, bad = 0; for (const x of a) { if (!isFinite(x)) bad++; if (Math.abs(x) > peak) peak = Math.abs(x); } return { peak, bad };
  });
  check('76개 소리를 동시에 렌더해도 피크 ≤ 마스터(0.25) — 클리핑 없음', spam.peak <= 0.26 && spam.bad === 0, spam.peak.toFixed(4));
  const pitched = await t.page.evaluate(async () => { const a = await SFX.render('star', { rate: 1 }), b = await SFX.render('star', { rate: 1.5 }), q = await SFX.render('star', { vol: 0.3 }); const pk = x => Math.max(...x.map(Math.abs)); let d = 0; for (let i = 0; i < 8000; i++) d += Math.abs(a[i] - b[i]); return { d, pa: pk(a), pq: pk(q) }; });
  check('opts.rate(음높이)·opts.vol(음량)이 실제로 소리를 바꿈', pitched.d > 5 && pitched.pq < pitched.pa * 0.6, JSON.stringify(pitched));

  // 음악
  const mu = await t.page.evaluate(async () => {
    const out = {};
    for (const n of Music.names) {
      const info = Music.info(n), a = await Music.render(n, 12);
      const sr = 22050, barLen = Math.floor(sr * 60 / info.bpm / 2 * 8);
      const bars = []; for (let b = 0; b < 6; b++) { let s = 0; for (let i = b * barLen; i < (b + 1) * barLen; i++) s += a[i] * a[i]; bars.push(Math.sqrt(s / barLen)); }
      let peak = 0, bad = 0, sq = 0; for (const x of a) { if (!isFinite(x)) bad++; if (Math.abs(x) > peak) peak = Math.abs(x); sq += x * x; }
      out[n] = { info, peak, bad, rms: Math.sqrt(sq / a.length), minBar: Math.min(...bars), maxBar: Math.max(...bars) };
    }
    out.names = Music.names;
    return out;
  });
  check("Music 곡 3개: title / stage / boss", JSON.stringify([...mu.names].sort()) === '["boss","stage","title"]');
  check('곡 데이터가 올바름: 마디마다 8칸(bad 없음), 총 64칸(8마디), 멜로디·베이스·아르페지오·드럼이 모두 있음', mu.names.every(n => mu[n].info.bad.length === 0 && mu[n].info.steps === 64 && mu[n].info.bars === 8 && Object.values(mu[n].info.notes).every(c => c > 8)), JSON.stringify(mu.title.info));
  check('곡이 모두 소리가 나고, 볼륨은 낮고(피크 < 0.12), 찢어지지 않음, 모든 마디에 소리가 있음', mu.names.every(n => mu[n].peak > 0.01 && mu[n].peak < 0.12 && mu[n].bad === 0 && mu[n].minBar > 0.002), mu.names.map(n => `${n}:peak ${mu[n].peak.toFixed(3)} rms ${mu[n].rms.toFixed(4)} minBar ${mu[n].minBar.toFixed(4)}`).join(' | '));
  check('곡마다 빠르기가 다름: title < stage < boss', mu.title.info.bpm < mu.stage.info.bpm && mu.stage.info.bpm < mu.boss.info.bpm, [mu.title.info.bpm, mu.stage.info.bpm, mu.boss.info.bpm].join('<'));
  check('음악은 잘 들리지만(RMS ≥ 0.004) 효과음 밑에 깔림(피크 < 타격음 피크의 85%, RMS < 0.02)', mu.names.every(n => mu[n].rms >= 0.004 && mu[n].rms < 0.02 && mu[n].peak < res.sfx.hit.peak * 0.85), mu.names.map(n => `${n} rms ${mu[n].rms.toFixed(4)} peak ${mu[n].peak.toFixed(3)}`).join(' | ') + ' vs hit peak ' + res.sfx.hit.peak.toFixed(3));
  check('품질 검사 중 페이지 오류 없음', t.errors.length === 0, t.errors.join('|'));
  await t.close();
});

await section('SFX/Music: 실제 재생 (동시 재생 제한 · 음소거 · 곡 전환)', async () => {
  const t = await openCustom();
  await t.page.evaluate(async () => {                       // 오디오가 실행 상태가 될 때까지 (최대 3초)
    SFX.init();
    for (let i = 0; i < 60; i++) { SFX.play('ui'); if (SFX.active() > 0) return; await new Promise(r => setTimeout(r, 50)); }
  });
  const r = await t.page.evaluate(async () => {
    const o = {};
    await new Promise(r => setTimeout(r, 200));
    const base = SFX.active();
    SFX.play('hit'); o.one = SFX.active() - base;
    for (let i = 0; i < 60; i++) SFX.play('hit'); o.sameSpam = SFX.active() - base;               // 같은 소리 연타는 최소 간격 때문에 1개만
    const nonPri = ['swing', 'hit', 'hitBig', 'jump', 'land', 'skill1', 'skill2', 'hurt', 'enemyDie', 'bossHit', 'coin', 'heal', 'ui', 'star'];
    for (let k = 0; k < 6; k++) nonPri.forEach(n => SFX.play(n));
    o.manyDistinct = SFX.active();                                                              // 동시에 10개 이상은 안 쌓임
    o.cap = CORE_TUNE.audio.maxSounds;
    SFX.play('clear'); SFX.play('gameover'); o.priority = SFX.active();                         // 중요한 소리는 제한 예외
    await new Promise(r => setTimeout(r, 2500)); o.drained = SFX.active();                      // 시간이 지나면 다 끝남
    // 음소거
    SFX.setMuted(true); const m0 = SFX.active(); SFX.play('hitBig'); SFX.play('coin'); o.mutedAdds = SFX.active() - m0; o.mutedFlag = SFX.muted;
    SFX.setMuted(false); await new Promise(r => setTimeout(r, 60)); SFX.play('hitBig'); o.unmutedAdds = SFX.active();
    SFX.muted = true; const m1 = SFX.active(); SFX.play('coin'); o.directMute = SFX.active() - m1; SFX.muted = false;
    await new Promise(r => setTimeout(r, 400));
    // 음악 전환
    Music.play('title'); o.m1 = [Music.current, Music.isPlaying()];
    Music.play('title'); o.m1same = [Music.current, Music.isPlaying()];
    await new Promise(r => setTimeout(r, 300));
    Music.play('boss'); o.m2 = [Music.current, Music.isPlaying()];
    await new Promise(r => setTimeout(r, 300));
    Music.play('stage'); o.m3 = [Music.current, Music.isPlaying()];
    Music.play('nope'); o.mUnknown = [Music.current, Music.isPlaying()];
    Music.play('stage'); SFX.setMuted(true); o.mMuted = [Music.current, Music.isPlaying()]; SFX.setMuted(false);
    Music.play(null); o.mStop = [Music.current, Music.isPlaying()];
    Music.stop(); o.mStop2 = Music.isPlaying();
    return o;
  });
  check('SFX.play 한 번 = 소리 1개가 살아 있음 (AudioContext 가 실제로 실행 중)', r.one === 1, JSON.stringify(r));
  check('같은 소리를 연타해도(60번) 최소 간격(30ms) 때문에 1개만', r.sameSpam === 1, String(r.sameSpam));
  check(`서로 다른 소리 84번을 요청해도 동시에 ${r.cap}개를 넘지 않음 (폭주 방지)`, r.manyDistinct <= r.cap && r.manyDistinct >= 5, String(r.manyDistinct));
  check('중요한 소리(clear/gameover)는 제한에 걸리지 않고 재생됨', r.priority >= r.manyDistinct + 2 || r.priority >= r.cap + 1, `${r.manyDistinct} → ${r.priority}`);
  check('시간이 지나면 살아 있는 소리 수가 0 으로 돌아옴', r.drained === 0, String(r.drained));
  check('음소거: setMuted(true) 이후 play 는 아무것도 추가하지 않음, 해제하면 다시 남', r.mutedAdds === 0 && r.mutedFlag === true && r.unmutedAdds >= 1, JSON.stringify([r.mutedAdds, r.mutedFlag, r.unmutedAdds]));
  check('SFX.muted 를 직접 바꿔도 소리가 멈춤', r.directMute === 0);
  check('Music.play: 곡 시작/같은 곡은 그대로/다른 곡으로 전환/정지', JSON.stringify([r.m1, r.m1same, r.m2, r.m3, r.mStop, r.mStop2]) === '[["title",true],["title",true],["boss",true],["stage",true],[null,false],false]', JSON.stringify([r.m1, r.m1same, r.m2, r.m3, r.mStop]));
  check('알 수 없는 곡 이름은 정지, 음소거 중에도 곡은 계속 돌고(켜면 이어짐)', JSON.stringify(r.mUnknown) === '[null,false]' && JSON.stringify(r.mMuted) === '["stage",true]', JSON.stringify([r.mUnknown, r.mMuted]));
  check('실제 재생 중 페이지 오류 없음', t.errors.length === 0, t.errors.join('|'));
  await t.close();
});

// =====================================================================
await section('FX: 상한 · 수명 · 번쩍임 안전', async () => {
  await reset();
  const r = await ev(() => {
    const o = {};
    // 팝업 상한 40 (넘치면 오래된 것부터)
    for (let i = 0; i < 100; i++) FX.popup(100 + i, 300, String(i));
    o.popups = [FX.popups.length, FX.popups[0].text, FX.popups[FX.popups.length - 1].text];
    FX.popup(NaN, 1, 'x'); FX.popup(1, Infinity, 'y'); o.badPopup = FX.popups.length;
    const p0 = FX.popups[FX.popups.length - 1]; FX.popup(5, 200, 7, { color: COLORS.red, size: 40, life: 5, vy: -3 }); const pp = FX.popups[FX.popups.length - 1];
    o.popupOpts = [pp.text, pp.color, pp.size, pp.life, pp.vy];
    // 입자 상한 300
    FX.clear(); for (let i = 0; i < 10; i++) FX.burst(100, 100, { kind: 'star', count: 80 });
    o.parts = FX.particles.length;
    FX.burst(0, 0, { kind: 'candy', count: 9999 }); o.partsHuge = FX.particles.length;
    // 모든 종류 + 기본 개수
    const kinds = {};
    for (const k of ['spark', 'star', 'candy', 'puff', 'ring']) { FX.clear(); FX.burst(300, 300, { kind: k }); kinds[k] = [FX.particles.length, FX.particles.every(p => p.kind === k)]; }
    o.kinds = kinds;
    FX.clear(); FX.burst(1, 1, { kind: 'banana', count: 4 }); o.unknownKind = [FX.particles.length, FX.particles[0].kind];
    FX.clear(); FX.burst(1, 1); o.defaultKind = FX.particles[0].kind;
    FX.clear(); FX.burst(NaN, 1, { count: 5 }); FX.burst(1, 1, { count: 0 }); FX.burst(1, 1, { count: -3 }); o.noParts = FX.particles.length;
    FX.clear(); FX.burst(1, 1, { kind: 'star', count: 30, colors: [COLORS.sky] }); o.colors = FX.particles.every(p => p.color === COLORS.sky);
    // 수명: 입자는 시간이 지나면 모두 사라지고 팝업은 life 만큼 보인 뒤 사라짐, 위로 떠오름
    FX.clear(); FX.burst(300, 300, { kind: 'spark', count: 20, life: 10 }); FX.popup(100, 300, 'a', { life: 6 });
    const y0 = FX.popups[0].y; FX.update(); FX.update(); o.rises = FX.popups[0].y < y0;
    for (let i = 0; i < 4; i++) FX.update(); o.popupGone = FX.popups.length;
    for (let i = 0; i < 20; i++) FX.update(); o.partsGone = FX.particles.length;
    // 입자가 움직이고 중력(떨어짐)이 적용됨
    FX.clear(); FX.burst(300, 300, { kind: 'star', count: 1, speed: 0, life: 50, gravity: 0.5 }); const sy = FX.particles[0].y; for (let i = 0; i < 10; i++) FX.update(); o.fall = FX.particles[0].y > sy + 5;
    FX.clear(); FX.burst(300, 300, { kind: 'spark', count: 12, life: 30, speed: 6 }); const spread0 = 0; for (let i = 0; i < 6; i++) FX.update(); o.spread = Math.max(...FX.particles.map(p => Math.hypot(p.x - 300, p.y - 300))) > 10;
    // 링은 지연을 두고 겹겹이
    FX.clear(); FX.burst(300, 300, { kind: 'ring', count: 3 }); o.ringDelays = FX.particles.map(p => p.delay).join();
    // 히트스톱/흔들림
    FX.clear(); FX.freeze(5); FX.freeze(3); o.freezeMax = FX.hitstop; FX.freeze(8); o.freeze8 = FX.hitstop; FX.freeze(1000); o.freezeCap = FX.hitstop; FX.clear(); FX.freeze(-5); FX.freeze(NaN); FX.freeze(0); o.freezeIgnored = FX.hitstop; FX.freeze(2.4); o.freezeRound = FX.hitstop;
    FX.clear(); FX.shake(10, 20); const offs = []; for (let i = 0; i < 24; i++) { offs.push([FX.shakeOff.x, FX.shakeOff.y]); FX.update(); }
    o.shakeBound = offs.every(([x, y]) => Math.abs(x) <= 10 && Math.abs(y) <= 10 && Number.isInteger(x) && Number.isInteger(y)); o.shakeMoves = offs.some(([x, y]) => x !== 0 || y !== 0); o.shakeEnds = offs.slice(21).every(([x, y]) => x === 0 && y === 0);
    o.shakeDecays = Math.max(...offs.slice(15, 20).map(([x, y]) => Math.max(Math.abs(x), Math.abs(y)))) <= 3;
    FX.clear(); FX.shake(10, 20); FX.shake(2, 30); const big = []; for (let i = 0; i < 5; i++) { FX.update(); big.push(Math.max(Math.abs(FX.shakeOff.x), Math.abs(FX.shakeOff.y))); } o.biggerWins = Math.max(...big) > 3;
    FX.clear(); FX.shake(2, 10); FX.shake(9, 10); const up = []; for (let i = 0; i < 3; i++) { up.push(Math.max(Math.abs(FX.shakeOff.x), Math.abs(FX.shakeOff.y))); FX.update(); } o.strongerReplaces = Math.max(...up) > 2;
    FX.clear(); FX.shake(999, 10); const hugeOffs = []; for (let i = 0; i < 10; i++) { hugeOffs.push(Math.max(Math.abs(FX.shakeOff.x), Math.abs(FX.shakeOff.y))); FX.update(); } o.shakeCap = Math.max(...hugeOffs) <= 16;
    FX.clear(); FX.shake(0, 10); FX.shake(5, 0); FX.shake(-3, 5); o.shakeNothing = FX.shakeOff.x === 0 && FX.shakeOff.y === 0;
    FX.reduceMotion = true; FX.clear(); FX.shake(10, 10); const rm = []; for (let i = 0; i < 10; i++) { rm.push(Math.max(Math.abs(FX.shakeOff.x), Math.abs(FX.shakeOff.y))); FX.update(); } o.reduceShake = Math.max(...rm) <= 3; FX.reduceMotion = false;
    // clear 는 전부 초기화
    FX.freeze(5); FX.shake(5, 5); FX.popup(1, 1, 'a'); FX.burst(1, 1, { count: 5 }); FX.flash('#fff', 10); FX.clear();
    o.cleared = [FX.hitstop, FX.popups.length, FX.particles.length, FX.flashAlpha, FX.shakeOff.x, FX.shakeOff.y];
    return o;
  });
  check('팝업 상한 40: 100개를 넣으면 40개만 남고 최신(60~99)이 보임', JSON.stringify(r.popups) === '[40,"60","99"]', JSON.stringify(r.popups));
  check('팝업: 좌표가 NaN/Infinity 면 무시, 옵션(color/size/life/vy) 반영, 숫자 text 는 문자열', r.badPopup === 40 && JSON.stringify(r.popupOpts) === '["7","#ff6b6b",40,5,-3]', JSON.stringify([r.badPopup, r.popupOpts]));
  check('입자 상한 300: 800개를 요청해도 300개, count=9999 도 상한 안', r.parts === 300 && r.partsHuge <= 300, JSON.stringify([r.parts, r.partsHuge]));
  check('입자 종류 spark/star/candy/puff/ring 이 모두 생성됨 (ring 은 기본 1개)', ['spark', 'star', 'candy', 'puff'].every(k => r.kinds[k][0] > 1 && r.kinds[k][1]) && r.kinds.ring[0] === 1 && r.kinds.ring[1], JSON.stringify(r.kinds));
  check('알 수 없는 kind 는 spark, 기본 kind 는 spark, NaN 좌표/count 0/음수는 무시', JSON.stringify(r.unknownKind) === '[4,"spark"]' && r.defaultKind === 'spark' && r.noParts === 0, JSON.stringify([r.unknownKind, r.defaultKind, r.noParts]));
  check('burst 의 colors 옵션이 반영됨', r.colors);
  check('팝업은 위로 떠오르고 life 가 지나면 사라짐, 입자도 수명이 다하면 모두 사라짐', r.rises && r.popupGone === 0 && r.partsGone === 0, JSON.stringify([r.rises, r.popupGone, r.partsGone]));
  check('입자는 퍼져 나가고(speed) 중력(gravity)으로 떨어짐', r.fall && r.spread);
  check('ring 여러 개는 지연을 두고 겹겹이 퍼짐', r.ringDelays === '0,4,8', r.ringDelays);
  check('FX.freeze: max(현재,n), 상한 30, 음수/NaN/0 무시, 반올림', r.freezeMax === 5 && r.freeze8 === 8 && r.freezeCap === 30 && r.freezeIgnored === 0 && r.freezeRound === 2, JSON.stringify([r.freezeMax, r.freeze8, r.freezeCap, r.freezeIgnored, r.freezeRound]));
  check('FX.shake: 크기 이내 정수 흔들림, 시간이 갈수록 줄어 멈춤', r.shakeBound && r.shakeMoves && r.shakeEnds && r.shakeDecays, JSON.stringify([r.shakeBound, r.shakeMoves, r.shakeEnds, r.shakeDecays]));
  check('FX.shake: 더 큰 흔들림이 우선 (작은 게 큰 걸 덮지 못함), 더 센 게 오면 교체', r.biggerWins && r.strongerReplaces);
  check('FX.shake: 상한 16px, 0/음수는 무시, reduceMotion 이면 크게 줄어듦', r.shakeCap && r.shakeNothing && r.reduceShake);
  check('FX.clear: 히트스톱·팝업·입자·번쩍임·흔들림 전부 초기화', JSON.stringify(r.cleared) === '[0,0,0,0,0,0]', JSON.stringify(r.cleared));

  // 번쩍임: 광과민성 안전
  const fl = await ev(() => {
    const o = {};
    FX.clear(); FX.flash('#fff', 10); o.first = [FX.flashAlpha, FX.flashColor];
    const traj = [FX.flashAlpha]; for (let i = 0; i < 14; i++) { FX.update(); traj.push(FX.flashAlpha); }
    o.fades = traj.every((a, i) => i === 0 || a <= traj[i - 1] + 1e-12) && traj[traj.length - 1] === 0; o.fadeLen = traj.findIndex(a => a === 0);
    // 20프레임 안의 두 번째 번쩍임은 합쳐짐: 진하기가 다시 올라가지 않음
    FX.clear(); FX.flash('#fff', 10); for (let i = 0; i < 5; i++) FX.update(); const mid = FX.flashAlpha; FX.flash('#f00', 10); o.mergedNoRise = FX.flashAlpha <= mid + 1e-12; o.mergedColor = FX.flashColor; const tail = []; for (let i = 0; i < 12; i++) { FX.update(); tail.push(FX.flashAlpha); } o.mergedExtends = tail[3] > 0; o.mergedMonotone = tail.every((a, i) => i === 0 || a <= tail[i - 1] + 1e-12);
    // 20프레임이 지나면 새 번쩍임이 가능
    FX.clear(); FX.flash('#fff', 5); for (let i = 0; i < 19; i++) FX.update(); FX.flash('#0f0', 5); o.at19 = FX.flashAlpha; FX.update(); FX.flash('#0f0', 5); o.at20 = [FX.flashAlpha > 0.4, FX.flashColor];
    // 난사: 3프레임마다 200프레임 동안 → 최대 진하기 ≤ 0.6, 새로 "켜지는" 순간이 20프레임 이상 간격
    FX.clear(); const rises = []; let prev = 0, maxA = 0;
    for (let f = 0; f < 200; f++) { if (f % 3 === 0) FX.flash(f % 2 ? '#fff' : '#ff0', 6 + (f % 7)); const a = FX.flashAlpha; if (a > prev + 0.05) rises.push(f); if (a > maxA) maxA = a; prev = a; FX.update(); }
    o.spamMax = maxA; o.spamRises = rises; o.spamGaps = rises.slice(1).map((x, i) => x - rises[i]);
    FX.clear(); FX.flash('#fff', 100000); const lens = []; for (let i = 0; i < 100; i++) { lens.push(FX.flashAlpha); FX.update(); } o.hugeFramesEnds = lens[lens.length - 1] === 0;
    FX.clear(); FX.flash('#fff', -4); o.negFrames = FX.flashAlpha > 0; FX.clear(); FX.flash(undefined, undefined); o.defaults = [FX.flashColor, FX.flashAlpha > 0];
    FX.reduceMotion = true; FX.clear(); FX.flash('#fff', 10); o.reduce = FX.flashAlpha; FX.reduceMotion = false;
    // 화면에 그리는 알파도 0.6 이하
    FX.clear(); FX.flash('#fff', 10); const calls = []; const fake = { save() {}, restore() {}, set globalAlpha(v) { this._a = v; }, get globalAlpha() { return this._a; }, set fillStyle(v) { this._f = v; }, fillRect(x, y, w, h) { calls.push([this._a, this._f, x, y, w, h]); } };
    FX.drawScreen(fake); o.draw = calls[0]; FX.clear(); calls.length = 0; FX.drawScreen(fake); o.drawNothing = calls.length;
    return o;
  });
  check('번쩍임 진하기 ≤ 0.6 (설계값 0.55), 색 기억, 서서히 사라짐', fl.first[0] > 0.3 && fl.first[0] <= 0.6 && fl.first[1] === '#fff' && fl.fades && fl.fadeLen >= 10 && fl.fadeLen <= 12, JSON.stringify([fl.first, fl.fades, fl.fadeLen]));
  check('20프레임 안의 두 번째 번쩍임은 합쳐짐: 진하기 안 올라가고, 사라지는 시간만 늘어남', fl.mergedNoRise && fl.mergedExtends && fl.mergedMonotone && fl.mergedColor === '#fff', JSON.stringify([fl.mergedNoRise, fl.mergedExtends, fl.mergedMonotone, fl.mergedColor]));
  check('19프레임째는 아직 합쳐지고, 20프레임째부터 새 번쩍임 가능', fl.at19 <= 0.1 && fl.at20[0] === true && fl.at20[1] === '#0f0', JSON.stringify([fl.at19, fl.at20]));
  check('번쩍임 난사(3프레임마다 200프레임): 최대 ≤ 0.6, 새로 켜지는 간격이 항상 20프레임 이상 → 초당 3번 이하', fl.spamMax <= 0.6 && fl.spamRises.length >= 8 && fl.spamRises.length <= 11 && fl.spamGaps.every(g => g >= 20), JSON.stringify([fl.spamMax, fl.spamRises, fl.spamGaps]));
  check('frames 가 말도 안 되게 크거나 음수/없음이어도 안전 (끝에 사라짐)', fl.hugeFramesEnds && fl.negFrames && fl.defaults[0] === '#fff' && fl.defaults[1], JSON.stringify([fl.hugeFramesEnds, fl.negFrames, fl.defaults]));
  check('reduceMotion 이면 번쩍임이 더 약함(≤0.25)', fl.reduce > 0 && fl.reduce <= 0.25, String(fl.reduce));
  check('drawScreen: 화면 전체(960×540)를 알파 ≤ 0.6 로 칠함, 번쩍임 없으면 아무것도 안 그림', fl.draw && fl.draw[0] <= 0.6 && fl.draw[0] > 0.3 && fl.draw[2] === 0 && fl.draw[3] === 0 && fl.draw[4] === 960 && fl.draw[5] === 540 && fl.drawNothing === 0, JSON.stringify([fl.draw, fl.drawNothing]));
});

await section('Cam · Draw 도우미', async () => {
  await reset();
  const c = await ev(() => {
    const o = {};
    Game.world.width = 1920; Cam.x = 0;
    const T = { x: 1000, y: 420 };
    Cam.follow(T); o.step1 = Cam.x;                                           // 0 + (1000-480-0)*0.12 = 62.4
    for (let i = 0; i < 200; i++) Cam.follow(T); o.converge = Cam.x;           // → 520
    const right = { x: 1900 }; for (let i = 0; i < 300; i++) Cam.follow(right); o.maxRight = Cam.x;   // [0, 1920-960=960]
    const left = { x: 10 }; for (let i = 0; i < 300; i++) Cam.follow(left); o.minLeft = Cam.x;
    Game.world.width = 960; Cam.x = 50; Cam.follow({ x: 700 }); o.narrow = Cam.x;            // 좁은 방: 항상 0
    Cam.follow(null); o.nullTarget = Cam.x;
    Game.world.width = 1920; Cam.x = 0; Cam.snap({ x: 1000 }); o.snap = Cam.x;
    Cam.snap({ x: 5000 }); o.snapMax = Cam.x; Cam.snap({ x: -100 }); o.snapMin = Cam.x;
    Game.player = { x: 700 }; Cam.snap(); o.snapPlayer = Cam.x; Game.player = null; Cam.x = 123; Cam.snap(); o.snapNone = Cam.x;
    // apply: translate(-round(Cam.x) + shake.x, shake.y), save/restore 짝
    Cam.x = 100.4; FX.shakeOff.x = 3; FX.shakeOff.y = -2;
    const calls = []; const fake = { save() { calls.push('save'); }, restore() { calls.push('restore'); }, translate(x, y) { calls.push(['translate', x, y]); } };
    Cam.apply(fake); o.apply = calls; FX.shakeOff.x = 0; FX.shakeOff.y = 0; Cam.x = 0;
    return o;
  });
  check('Cam.follow: 한 번에 (목표-현재)×0.12 만큼 이동, 계속하면 목표(x-480)에 수렴', near(c.step1, 62.4, 1e-9) && near(c.converge, 520, 0.01), JSON.stringify([c.step1, c.converge]));
  check('Cam.follow clamp: [0, world.width - 960] 를 벗어나지 않음 / 좁은 방은 0 고정 / null 은 무시', near(c.maxRight, 960, 0.01) && c.minLeft === 0 && c.narrow === 0 && c.nullTarget === 0, JSON.stringify([c.maxRight, c.minLeft, c.narrow, c.nullTarget]));
  check('Cam.snap: 즉시 이동, 범위 clamp, 인자 생략 시 Game.player, 둘 다 없으면 현재 위치 유지', c.snap === 520 && c.snapMax === 960 && c.snapMin === 0 && c.snapPlayer === 220 && c.snapNone === 123, JSON.stringify([c.snap, c.snapMax, c.snapMin, c.snapPlayer, c.snapNone]));
  check('Cam.apply: save 후 translate(-round(Cam.x)+shake.x, shake.y)', JSON.stringify(c.apply) === '["save",["translate",-97,-2]]', JSON.stringify(c.apply));

  const d = await ev(() => {
    const o = {};
    const make = () => { const calls = []; const ctx = { _a: 1, set globalAlpha(v) { this._a = v; calls.push(['alpha', v]); }, get globalAlpha() { return this._a; }, set font(v) { this._font = v; }, get font() { return this._font; }, textAlign: '', textBaseline: '', lineJoin: '', miterLimit: 0, lineWidth: 0, strokeStyle: '', fillStyle: '',
      save() { calls.push(['save']); }, restore() { calls.push(['restore']); }, strokeText(t, x, y) { calls.push(['stroke', t, x, y, this.lineWidth, this.strokeStyle]); }, fillText(t, x, y) { calls.push(['fill', t, x, y, this.fillStyle, this.textAlign, this.font, this.textBaseline]); },
      measureText(t) { return { width: t.length * 10 }; }, beginPath() { calls.push(['begin']); }, moveTo() {}, lineTo() {}, arcTo(...a) { calls.push(['arcTo', ...a]); }, closePath() { calls.push(['close']); }, clip() { calls.push(['clip']); }, fill() { calls.push(['fillPath', this.fillStyle]); }, stroke() { calls.push(['strokePath', this.strokeStyle, this.lineWidth]); },
      fillRect(x, y, w, h) { calls.push(['fillRect', x, y, w, h, this.fillStyle]); }, ellipse(...a) { calls.push(['ellipse', ...a]); }, arc() {} }; return { ctx, calls }; };
    // text
    let m = make(); const w = Draw.text(m.ctx, '안녕 젤리!', 100, 50, { size: 30 });
    const ops = m.calls.map(c => c[0]); const fi = m.calls.find(c => c[0] === 'fill'), si = m.calls.find(c => c[0] === 'stroke');
    o.text = { strokeFirst: ops.indexOf('stroke') < ops.indexOf('fill'), pos: [fi[2], fi[3]], fill: fi[4], align: fi[5], stroke: [si[4], si[5]], font: fi[6], baseline: fi[7], width: w, balanced: ops.filter(x => x === 'save').length === ops.filter(x => x === 'restore').length };
    m = make(); Draw.text(m.ctx, 'x', 0, 0, { size: 18, color: '#f00', stroke: '#00f', lw: 7, align: 'left', weight: 'normal', alpha: 0.5, baseline: 'middle' });
    const s2 = m.calls.find(c => c[0] === 'stroke'), f2 = m.calls.find(c => c[0] === 'fill'), a2 = m.calls.find(c => c[0] === 'alpha');
    o.textOpts = [s2[4], s2[5], f2[4], f2[5], f2[6].startsWith('normal 18px'), f2[7], a2[1]];
    m = make(); Draw.text(m.ctx, 'x', 0, 0, { lw: 0 }); o.noStrokeLw0 = !m.calls.some(c => c[0] === 'stroke');
    m = make(); Draw.text(m.ctx, 'x', 0, 0, { stroke: null }); o.noStrokeNull = !m.calls.some(c => c[0] === 'stroke');
    m = make(); const w2 = Draw.text(m.ctx, '첫째 줄\n둘째 줄', 10, 100, { size: 20 }); const fills = m.calls.filter(c => c[0] === 'fill'); o.multi = [fills.length, fills[0][3], fills[1][3], w2];
    m = make(); Draw.text(m.ctx, 12345, 0, 0); Draw.text(m.ctx, null, 0, 0); Draw.text(m.ctx, undefined, 0, 0); o.nonString = m.calls.filter(c => c[0] === 'fill').map(c => c[1]).join();
    // 실제 캔버스: 알파가 복원됨, 한글 렌더 (픽셀이 칠해짐)
    const real = document.createElement('canvas'); real.width = 300; real.height = 80; const rc = real.getContext('2d'); rc.fillStyle = '#fff'; rc.fillRect(0, 0, 300, 80);
    Draw.text(rc, '한글 텍스트 ABC 123', 150, 55, { size: 36, color: '#000', stroke: '#f00', lw: 3 });
    const real2 = document.createElement('canvas').getContext('2d'); real2.globalAlpha = 0.5; Draw.text(real2, '한글', 10, 20, { alpha: 0.5 }); o.realAlpha = real2.globalAlpha;
    const img = rc.getImageData(0, 0, 300, 80).data; let dark = 0, red = 0; for (let i = 0; i < img.length; i += 4) { if (img[i] < 80 && img[i + 1] < 80 && img[i + 2] < 80) dark++; if (img[i] > 180 && img[i + 1] < 80 && img[i + 2] < 80) red++; } o.realInk = [dark > 150, red > 50];
    // 정렬: left 는 x 오른쪽으로, right 는 x 왼쪽으로 글자가 나옴
    const spans = al => { const c2 = document.createElement('canvas'); c2.width = 400; c2.height = 60; const k = c2.getContext('2d'); Draw.text(k, 'ABCDEF', 200, 40, { size: 30, color: '#000', stroke: null, align: al }); const d2 = k.getImageData(0, 0, 400, 60).data; let min = 999, max = -1; for (let y = 0; y < 60; y++) for (let x = 0; x < 400; x++) if (d2[(y * 400 + x) * 4 + 3] > 100) { if (x < min) min = x; if (x > max) max = x; } return [min, max]; };
    const L = spans('left'), C = spans('center'), R = spans('right'); o.align = [L[0] >= 198 && L[1] > 250, C[0] < 200 && C[1] > 200 && Math.abs((C[0] + C[1]) / 2 - 200) < 8, R[1] <= 202 && R[0] < 150];
    // bar
    const barFg = ratio => { const k = make(); Draw.bar(k.ctx, 10, 20, 200, 16, ratio, { fg: '#0f0', bg: '#000', border: false }); return k.calls.filter(c => c[0] === 'fillRect' && c[5] === '#0f0').map(c => c[3]); };
    o.bar = { half: barFg(0.5), full: barFg(1), over: barFg(5), zero: barFg(0), neg: barFg(-3), nan: barFg(NaN), inf: barFg(Infinity), undef: barFg(undefined) };
    let k = make(); Draw.bar(k.ctx, 0, 0, 100, 10, 0.5); o.barBorderDefault = k.calls.some(c => c[0] === 'strokePath' && c[1] === COLORS.ink);
    k = make(); Draw.bar(k.ctx, 0, 0, 100, 10, 0.5, { border: null }); o.barNoBorder = !k.calls.some(c => c[0] === 'strokePath');
    o.barBalanced = (() => { const ops2 = k.calls.map(c => c[0]); return ops2.filter(x => x === 'save').length === ops2.filter(x => x === 'restore').length; })();
    // roundRect
    k = make(); Draw.roundRect(k.ctx, 5, 5, 100, 40, 12); o.rr = [k.calls[0][0], k.calls.filter(c => c[0] === 'arcTo').length, k.calls[k.calls.length - 1][0], k.calls.filter(c => c[0] === 'arcTo')[0].slice(5)];
    k = make(); Draw.roundRect(k.ctx, 0, 0, 20, 10, 999); o.rrClamp = k.calls.filter(c => c[0] === 'arcTo')[0][5];
    k = make(); Draw.roundRect(k.ctx, 0, 0, 20, 10, -5); o.rrNeg = k.calls.filter(c => c[0] === 'arcTo')[0][5];
    // shadow
    const sh = z => { const k2 = make(); Draw.shadow(k2.ctx, { x: 200, y: 400, z, w: 40 }); const e = k2.calls.find(c => c[0] === 'ellipse'); return [e[1], e[2], e[3], e[4]]; };
    o.shadow = { ground: sh(0), mid: sh(100), high: sh(1000), neg: sh(-20) };
    return o;
  });
  check('Draw.text: 윤곽선(strokeText)을 먼저, 글자(fillText)를 나중에, 기본 중앙정렬·굵게·잉크색 윤곽·너비 반환', d.text.strokeFirst && d.text.pos[0] === 100 && d.text.pos[1] === 50 && d.text.fill === '#fff' && d.text.align === 'center' && d.text.stroke[0] === 4 && d.text.stroke[1] === '#2b1b3a' && d.text.font.startsWith('bold 30px') && d.text.font.includes('Jua') && d.text.width === 60 && d.text.balanced, JSON.stringify(d.text));
  check('Draw.text 옵션: size/color/stroke/lw/align/weight/alpha/baseline', JSON.stringify(d.textOpts) === '[7,"#00f","#f00","left",true,"middle",0.5]', JSON.stringify(d.textOpts));
  check('Draw.text: lw=0 또는 stroke=null 이면 윤곽선 없음, 숫자/null/undefined 도 그림', d.noStrokeLw0 && d.noStrokeNull && d.nonString === '12345,null,undefined', JSON.stringify([d.noStrokeLw0, d.noStrokeNull, d.nonString]));
  check("Draw.text: '\\n' 로 여러 줄 (줄 간격 size×1.2), 가장 긴 줄 너비 반환", JSON.stringify(d.multi) === '[2,100,124,40]', JSON.stringify(d.multi));
  check('Draw.text: 실제 캔버스에서 한글+영문+숫자가 글자색(검정)과 윤곽선(빨강)으로 그려지고 globalAlpha 는 원래대로(0.5)', d.realAlpha === 0.5 && d.realInk[0] && d.realInk[1], JSON.stringify([d.realAlpha, d.realInk]));
  check('Draw.text: align left/center/right 가 x 기준으로 실제 위치가 달라짐', d.align.every(Boolean), JSON.stringify(d.align));
  check('Draw.bar: ratio 를 0~1 로 맞춤 (0.5→100px, 1→200, 5→200, 0/음수/NaN/undefined→안 그림, Infinity→200)', JSON.stringify(d.bar) === '{"half":[100],"full":[200],"over":[200],"zero":[],"neg":[],"nan":[],"inf":[200],"undef":[]}', JSON.stringify(d.bar));
  check('Draw.bar: 기본 윤곽선(잉크색), border:null 이면 없음, save/restore 짝', d.barBorderDefault && d.barNoBorder && d.barBalanced);
  check('Draw.roundRect: path 만 만듦(beginPath 로 시작, 호 4개, closePath), 반지름은 변 길이의 절반으로 제한, 음수는 0', d.rr[0] === 'begin' && d.rr[1] === 4 && d.rr[2] === 'close' && d.rr[3][0] === 12 && d.rrClamp === 5 && d.rrNeg === 0, JSON.stringify([d.rr, d.rrClamp, d.rrNeg]));
  // 이상한 값을 넣어도 진짜 캔버스에서 throw 하지 않음
  const weird = await ev(() => {
    const fails = []; const c = document.createElement('canvas'); c.width = 200; c.height = 100; const ctx = c.getContext('2d');
    const t = (name, fn) => { try { fn(); } catch (e) { fails.push(name + ': ' + e.message); } };
    const vals = [0, -1, NaN, Infinity, -Infinity, 1e9, undefined, null, '12', {}];
    for (const v of vals) {
      t('text ' + v, () => Draw.text(ctx, 'ab', v, v, { size: v, lw: v, alpha: v }));
      t('bar ' + v, () => Draw.bar(ctx, v, v, v, v, v));
      t('roundRect ' + v, () => Draw.roundRect(ctx, v, v, v, v, v));
      t('shadow ' + v, () => Draw.shadow(ctx, { x: v, y: v, z: v, w: v }));
      t('star ' + v, () => Draw.star(ctx, v, v, v, v, v, v));
      t('burst ' + v, () => { FX.clear(); FX.burst(10, 10, { kind: 'star', count: 3, size: v, speed: v, life: v, gravity: v }); FX.burst(10, 10, { kind: 'ring', count: 2, size: v }); FX.drawWorld(ctx); for (let i = 0; i < 3; i++) FX.update(); FX.drawWorld(ctx); });
      t('popup ' + v, () => { FX.clear(); FX.popup(10, 10, v, { size: v, life: v, vy: v, color: v }); FX.drawWorld(ctx); FX.update(); });
      t('flash/shake/freeze ' + v, () => { FX.clear(); FX.flash(v, v); FX.shake(v, v); FX.freeze(v); FX.update(); FX.drawScreen(ctx); FX.clear(); });
    }
    t('text empty/long', () => { Draw.text(ctx, '', 1, 1); Draw.text(ctx, 'ㅋ'.repeat(5000), 1, 1); Draw.text(ctx, '\n\n', 1, 1); });
    t('text no opts', () => Draw.text(ctx, 'x', 1, 1, null));
    t('particles all kinds with extreme life', () => { FX.clear(); for (const k of ['spark', 'star', 'candy', 'puff', 'ring']) FX.burst(50, 50, { kind: k, count: 5, life: 2 }); for (let i = 0; i < 5; i++) { FX.drawWorld(ctx); FX.update(); } });
    FX.clear();
    return fails;
  });
  check('Draw/FX 도우미는 0·음수·NaN·Infinity·undefined·null·문자열·객체를 넣어도 진짜 캔버스에서 throw 하지 않음', weird.length === 0, weird.slice(0, 4).join(' | '));
  check('Draw.shadow: 땅에서 가장 크고, 높이 뜰수록 작아지되 최소 크기가 있고, 음수 z 는 땅으로 취급', d.shadow.ground[2] > d.shadow.mid[2] && d.shadow.mid[2] > d.shadow.high[2] && d.shadow.high[2] >= 8 && d.shadow.neg[2] === d.shadow.ground[2] && d.shadow.ground[0] === 200 && d.shadow.ground[1] === 400 && d.shadow.ground[3] < d.shadow.ground[2], JSON.stringify(d.shadow));
});

// =====================================================================
await section('Game: 씬 전환 · 일시정지 · 새 런', async () => {
  await reset();
  const s = await ev(() => {
    const o = {}; const log = [];
    Scenes.A = { enter() { log.push('A.enter'); }, exit() { log.push('A.exit'); } };
    Scenes.B = { enter() { log.push('B.enter:down=' + Input.isDown('KeyZ')); }, exit() { log.push('B.exit'); } };
    Game.scene = 'A';
    Events.on('sceneChanged', d => log.push(`event:${d.from}->${d.to}:down=${Input.isDown('KeyZ')}`));
    Input.press('KeyZ');
    Game.setScene('B');
    o.order = log.join(' | '); o.scene = Game.scene; o.cleared = Object.keys(Input.down).length + Object.keys(Input.pressed).length;
    // 빈 씬 / 없는 씬 / 같은 씬으로 전환
    log.length = 0; Scenes.EMPTY = {}; Game.setScene('EMPTY'); Loop.step(5); Loop.draw(); Game.setScene('NOPE_SCENE'); Loop.step(3); Loop.draw(); Game.setScene('EMPTY');
    o.emptyOk = [Game.scene, log.join()];
    Game.setScene('A'); log.length = 0; Game.setScene('A'); o.same = log.join(' | ');
    // enter/exit 가 예외를 던져도 전환은 끝까지
    TT.grabErrors(); Scenes.BAD = { enter() { throw new Error('enter 폭발'); }, exit() { throw new Error('exit 폭발'); } };
    let ev2 = null; Events.on('sceneChanged', d => ev2 = d.from + '>' + d.to);
    Game.setScene('BAD'); Game.setScene('A'); o.throwing = [Game.scene, ev2, TT.releaseErrors().length];
    return o;
  });
  check('setScene 순서: 이전 exit → 새 enter(입력은 아직 남아 있음) → Input.clear → sceneChanged(이미 비워짐)', s.order === 'A.exit | B.enter:down=true | event:A->B:down=false' && s.scene === 'B' && s.cleared === 0, s.order);
  check('enter/exit/update/draw 가 하나도 없는 씬, 아예 없는 씬 이름으로 가도 크래시 없음', s.emptyOk[0] === 'EMPTY', JSON.stringify(s.emptyOk));
  check('같은 씬으로 setScene 해도 exit → enter 가 다시 불림(다시 시작에 쓰임)', s.same === 'A.exit | A.enter | event:A->A:down=false', s.same);
  check('enter/exit 가 예외를 던져도 전환·이벤트 완료 (오류는 기록)', s.throwing[0] === 'A' && s.throwing[1] === 'BAD>A' && s.throwing[2] === 2, JSON.stringify(s.throwing));

  const e = await ev(() => {
    const o = {}; TT.grabErrors();
    let n = 0; Scenes.U = { update() { n++; throw new Error('update 폭발 ' + (n > 3 ? 'B' : 'A')); } }; Game.scene = 'U';
    Loop.step(3); o.updatesRan = n; const errs1 = TT.errs.length;
    Loop.step(2); o.errsAfter = [errs1, TT.errs.length];                  // 3번 던져도 A 메시지는 1번만, 이후 B 메시지가 새로 1번
    let d = 0; Scenes.D = { draw() { d++; throw new Error('draw 폭발'); } }; Game.scene = 'D'; const e0 = TT.errs.length;
    for (let i = 0; i < 5; i++) Loop.draw(); o.draws = [d, TT.errs.length - e0];
    // 오류 뒤에도 정상 씬은 그려지고 캔버스 상태가 복구됨
    Scenes.G = { draw(ctx) { ctx.fillStyle = '#00ff00'; ctx.fillRect(0, 0, W, H); } }; Game.scene = 'G'; Loop.draw(); o.recovered = TT.px(480, 270).join();
    Scenes.D2 = { draw(ctx) { ctx.save(); ctx.save(); ctx.globalAlpha = 0.1; ctx.translate(500, 500); throw new Error('draw 폭발 2'); } }; Game.scene = 'D2'; Loop.draw(); Game.scene = 'G'; Loop.draw(); o.afterLeak = TT.px(480, 270).join() + ':' + document.getElementById('game').getContext('2d').globalAlpha;
    o.errMsgs = TT.errs.slice();
    TT.releaseErrors();
    return o;
  });
  check('update 가 예외를 던져도 루프는 계속 돌고, 같은 메시지는 한 번만 기록, 새 메시지는 다시 기록', e.updatesRan === 3 && JSON.stringify(e.errsAfter) === '[1,2]', JSON.stringify([e.updatesRan, e.errsAfter]));
  check('draw 가 예외를 던져도 계속 시도하고 같은 오류는 한 번만 기록 (5번 → 1번)', JSON.stringify(e.draws) === '[5,1]', JSON.stringify(e.draws));
  check('그림 오류 뒤에도 다음 씬이 정상으로 그려지고, 짝 안 맞는 save/transform/alpha 가 새지 않음', e.recovered === '0,255,0' && e.afterLeak === '0,255,0:1', JSON.stringify([e.recovered, e.afterLeak]));

  const p = await ev(() => {
    const o = {}; Events.clear(); const log = [];
    Events.on('paused', d => log.push(d.on));
    Input.press('KeyX'); Game.pause(true); o.on = [Game.paused, Object.keys(Input.down).length, log.join()];
    Game.pause(false); o.off = [Game.paused, log.join()];
    Game.pause(); o.defaultOn = Game.paused; Game.paused = false;
    // 일시정지 중 setScene 은 paused 를 건드리지 않음 (계약서 그대로)
    Game.pause(true); Game.setScene('EMPTY2'); o.pausedStays = Game.paused; Game.paused = false;
    return o;
  });
  check('Game.pause(on): paused 설정 + Input.clear + paused 이벤트 {on}', JSON.stringify(p.on) === '[true,0,"true"]' && JSON.stringify(p.off) === '[false,"true,false"]' && p.defaultOn === true, JSON.stringify(p));

  const rr = await ev(() => {
    const o = {};
    Entities.clear(); FX.clear(); Events.clear();
    const keep = TT.mk({ x: 1 }); FX.popup(1, 1, 'x');
    const combo = Game.combo; Game.score = 500; Game.kills = 7; Game.deaths = 2; Game.frame = 99; Game.boss = { x: 1 }; Game.result = { cleared: true }; Game.combo.count = 5; Game.combo.timer = 9; Game.combo.max = 12; Game.lives = 0;
    Game.resetRun({ difficulty: 'hard', nickname: '젤리' });
    o.hard = [Game.difficulty, Game.nickname, Game.score, Game.kills, Game.deaths, Game.frame, Game.lives, Game.boss, Game.result, JSON.stringify(Game.combo), Game.combo === combo, Entities.list.includes(keep), FX.popups.length];
    Game.resetRun({ difficulty: 'easy' }); o.easy = [Game.difficulty, Game.lives, Game.nickname]; o.easyInf = Game.lives === Infinity;
    Game.resetRun({ difficulty: 'normal' }); o.normal = Game.lives;
    Game.resetRun({ difficulty: 'impossible', nickname: 5 }); o.invalid = [Game.difficulty, Game.nickname];
    Game.resetRun(); o.noArgs = Game.difficulty;
    o.diff = [Game.diff.label, Game.diff.dmgTaken]; Game.difficulty = 'weird'; o.diffFallback = Game.diff.label; Game.difficulty = 'normal';
    Game.score = 0; Game.addScore(10.4); Game.addScore(10.6); Game.addScore(NaN); Game.addScore('abc'); Game.addScore(-3); Game.addScore(undefined); o.score = Game.score;
    o.cfg = [CFG.difficulty.easy.lives === Infinity, CFG.difficulty.normal.lives, CFG.difficulty.hard.lives, CFG.difficulty.easy.maxAttackers, CFG.difficulty.normal.maxAttackers, CFG.difficulty.hard.maxAttackers, CFG.difficulty.hard.windupMul, CFG.difficulty.easy.revivePenalty];
    // 난이도 숫자표 전체 (밸런스 결정: hard 는 받는 피해 1.7배 · 적 체력은 그대로 1.0 · poise 0.5)
    o.table = {}; for (const k of ['easy', 'normal', 'hard']) { const d = CFG.difficulty[k]; o.table[k] = [d.dmgTaken, d.enemyHp, d.enemySpeed, d.windupMul, d.maxAttackers, d.poise]; }
    // poise: 표에 없거나 이상한 값이어도 Game.diff.poise 는 항상 0~1 숫자 (없으면 0)
    const nm = CFG.difficulty.normal, saved = nm.poise, pz = [];
    delete nm.poise; Game.difficulty = 'normal'; pz.push(Game.diff.poise);
    for (const bad of [NaN, 'abc', null, -2, 7, undefined]) { nm.poise = bad; pz.push(Game.diff.poise); }
    nm.poise = 0.25; pz.push(Game.diff.poise);
    nm.poise = saved; o.poiseSafe = pz; o.poiseRestored = nm.poise;
    return o;
  });
  check('resetRun: score/kills/deaths/frame/boss/result/combo 초기화, 난이도·닉네임 설정, lives=난이도 값, Entities/FX 는 그대로', JSON.stringify(rr.hard) === '["hard","젤리",0,0,0,0,1,null,null,"{\\"count\\":0,\\"timer\\":0,\\"max\\":0}",true,true,1]', JSON.stringify(rr.hard));
  check('resetRun: easy → lives=Infinity, normal → 3, 잘못된 난이도/닉네임은 무시, 인자 없이도 OK', rr.easy[0] === 'easy' && rr.easyInf && rr.normal === 3 && JSON.stringify(rr.invalid) === '["normal","젤리"]', JSON.stringify([rr.easy, rr.normal, rr.invalid]));
  check('Game.diff: 현재 난이도 설정, 알 수 없는 난이도는 normal 로', rr.diff[0] === '보통' && rr.diff[1] === 1 && rr.diffFallback === '보통');
  check('Game.addScore: 반올림해서 더함 (10.4+10.6 → 10+11), NaN/문자/undefined 무시', rr.score === 18, String(rr.score));
  check('CFG.difficulty 값이 계약서와 같음 (lives/maxAttackers/windupMul/revivePenalty)', JSON.stringify(rr.cfg) === '[true,3,1,1,2,3,0.8,0.1]', JSON.stringify(rr.cfg));
  check('난이도 숫자표 [dmgTaken, enemyHp, enemySpeed, windupMul, maxAttackers, poise]: easy 0.5/0.8/0.9/1.3/1/0, normal 1/1/1/1/2/0, hard 1.7/1.0/1.1/0.8/3/0.5',
    JSON.stringify(rr.table) === '{"easy":[0.5,0.8,0.9,1.3,1,0],"normal":[1,1,1,1,2,0],"hard":[1.7,1,1.1,0.8,3,0.5]}', JSON.stringify(rr.table));
  check('Game.diff.poise: 표에 없거나(NaN/문자/null/음수/undefined) 범위 밖이면 0~1 로 보정, 정상 값은 그대로', JSON.stringify(rr.poiseSafe) === '[0,0,0,0,0,1,0,0.25]' && rr.poiseRestored === 0, JSON.stringify([rr.poiseSafe, rr.poiseRestored]));
});

await section('부팅 · 오류 처리', async () => {
  await reset();
  const before = await ev(() => Loop.tickCount);
  const msgs = await ev(async () => {
    TT.grabErrors();
    Promise.reject(new Error('거부된 약속'));
    setTimeout(() => { throw new Error('타이머 안 예외'); }, 0);
    await new Promise(r => setTimeout(r, 100));
    return TT.releaseErrors();
  });
  await page.waitForTimeout(50);
  check('unhandledrejection 은 console.error 로만 기록', msgs.some(m => m.includes('[unhandledrejection]') && m.includes('거부된 약속')), JSON.stringify(msgs));
  check('window.onerror 도 console.error 로만 기록', msgs.some(m => m.includes('[window.onerror]') && m.includes('타이머 안 예외')), JSON.stringify(msgs));
  const after = await ev(() => { Loop.step(5); return Loop.tickCount; });
  check('그래도 게임 루프는 멈추지 않음', after - before >= 5);
  // 일부러 낸 오류는 최종 "오류 없음" 검사에서 빼기
  for (let i = errors.length - 1; i >= 0; i--) if (/거부된 약속|타이머 안 예외/.test(errors[i])) errors.splice(i, 1);

  // boot 씬: 로딩 문구가 실제로 그려짐 (Scenes.boot 가 있고, 크래시 없이)
  const boot = await ev(() => {
    Game.scene = 'boot'; Loop.draw();
    let bright = 0; const c = document.getElementById('game').getContext('2d'); const d = c.getImageData(Math.round(380 * Loop.dpr), Math.round(215 * Loop.dpr), Math.round(200 * Loop.dpr), Math.round(60 * Loop.dpr)).data;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 220 && d[i + 1] > 200) bright++;
    return { bright, hasEnter: typeof Scenes.boot.draw, update: Scenes.boot.update, scene: Game.scene };
  });
  check("기본 'boot' 씬: '로딩 중...' 글자가 화면 중앙에 그려짐, update 없이도 안전", boot.bright > 100 && boot.hasEnter === 'function' && boot.update === undefined, JSON.stringify(boot));
  await ev(() => { Loop.step(3); });
});

// =====================================================================
await section('HiDPI 캔버스: 백버퍼 배율 = clamp(보이는 폭(실제 화소) / 960, 1, 2)', async () => {
  // [뷰포트, devicePixelRatio, 기대 배율]. #app 은 16:9 레터박스라 캔버스 CSS 폭 = min(뷰포트 폭, 높이*16/9).
  // 배율은 1/60 단위로 반올림 (960*k/60 × 540*k/60 이 정수) → 1280x720 창(dpr 1)은 1280x720 백버퍼로 화소가 1:1
  const cases = [
    [[1280, 720], 1, 80 / 60], [[1280, 720], 1.5, 2], [[1280, 720], 2, 2], [[1280, 720], 3, 2],       // 큰 화면은 dpr 이 얼마든 최대 2배(1920x1080)
    [[1920, 1080], 1, 2], [[2560, 1440], 1, 2], [[2560, 1440], 2, 2],                                   // R-10: 1080p/1440p 를 dpr 1 로 봐도 또렷하게, 비용은 1920x1080 까지
    [[800, 450], 1, 1], [[640, 360], 2, 1280 / 960],                                                    // 작은 창은 1배 밑으로 내려가지 않음 / dpr 2 면 1280x720
    [[1366, 768], 1, 85 / 60],                                                                          // 흔한 노트북 (CSS 폭 1365.33 → 1/60 단위로 85)
    [[390, 844], 3, 73 / 60],                                                                           // 세로로 든 폰: 390css x3 = 1170 화소 → 1.2167배 (1168x657)
  ];
  const cssBase = {};
  for (const [[vw, vh], dsf, want] of cases) {
    const t = await openCustom({ contextOpts: { viewport: { width: vw, height: vh }, deviceScaleFactor: dsf } });
    await t.page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const r = await t.page.evaluate(() => {
      const c = document.getElementById('game'), ctx = c.getContext('2d');
      Scenes.P = { draw(ctx) { ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, W, H); ctx.fillStyle = '#0000ff'; ctx.fillRect(W - 10, H - 10, 10, 10); } }; Game.scene = 'P'; Loop.draw();
      const tr = ctx.getTransform();
      const px = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3)).join();
      const box = c.getBoundingClientRect();
      return { w: c.width, h: c.height, a: tr.a, d: tr.d, dpr: window.devicePixelRatio, loopDpr: Loop.dpr, corner: px(c.width - 2, c.height - 2), origin: px(1, 1), mid: px(Math.round(c.width / 2), Math.round(c.height / 2)), cssW: box.width, cssH: box.height };
    });
    const tag = `${vw}x${vh} dpr ${dsf}`;
    const ww = Math.round(960 * want), hh = Math.round(540 * want);
    check(`[${tag}] 캔버스 ${ww}×${hh} (배율 ${want.toFixed(4)}), 변환도 같은 배율, Loop.dpr 도 같음`, r.w === ww && r.h === hh && near(r.a, want, 1e-6) && near(r.d, want, 1e-6) && near(r.loopDpr, want, 1e-6) && r.a === r.loopDpr && r.d === r.loopDpr, JSON.stringify(r));
    check(`  └ [${tag}] 백버퍼는 1920x1080 을 넘지 않고 960x540 밑으로도 안 내려감 (비용 상한)`, r.w <= 1920 && r.h <= 1080 && r.w >= 960 && r.h >= 540);
    check(`  └ [${tag}] 논리 좌표(960×540)로 그리면 캔버스 전체가 채워짐`, r.corner === '0,0,255' && r.origin === '255,0,0' && r.mid === '255,0,0', JSON.stringify({ c: r.corner, o: r.origin }));
    const key = `${vw}x${vh}`; if (cssBase[key] === undefined) cssBase[key] = r.cssW;
    check(`  └ [${tag}] 화면에 보이는 크기(CSS px)는 dpr 과 무관하게 같고 16:9`, Math.abs(r.cssW - cssBase[key]) < 1 && Math.abs(r.cssW / r.cssH - 16 / 9) < 0.01, JSON.stringify([r.cssW, r.cssH, cssBase[key]]));
    if (want >= 1 && want <= 2) {
      const ratio = r.w / (r.cssW * dsf);
      check(`  └ [${tag}] 백버퍼 화소 ÷ 화면 실제 화소 = ${ratio.toFixed(3)} (한도 안에서는 1:1 에 가까움 → 또렷)`, Math.abs(ratio - 1) < 0.012 || (want === 2 && ratio < 1) || (want === 1 && ratio > 1), `${r.w} / ${(r.cssW * dsf).toFixed(1)}`);
    }
    check(`  └ [${tag}] 오류 없음`, t.errors.length === 0, t.errors.join('|'));
    await t.close();
  }

  // 창 크기가 바뀌면 다시 계산 (resize 이벤트) — 뷰포트를 바꾸고 다음 그리기에서 따라감, 다시 돌아오면 원래 크기
  const t = await openCustom({ contextOpts: { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 } });
  const frames = () => t.page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const bw = () => t.page.evaluate(() => [Loop.canvas.width, Loop.canvas.height, Loop.dpr, Loop.ctx.getTransform().a]);
  const got = [];
  for (const [w, h] of [[1280, 720], [1920, 1080], [640, 360], [1600, 900], [1280, 720]]) { await t.page.setViewportSize({ width: w, height: h }); await frames(); got.push(await bw()); }
  check('창 크기를 1280→1920→640→1600→1280 으로 바꾸면 캔버스가 1280x720 → 1920x1080 → 960x540 → 1600x900 → 1280x720 으로 따라감', JSON.stringify(got.map(g => [g[0], g[1]])) === '[[1280,720],[1920,1080],[960,540],[1600,900],[1280,720]]', JSON.stringify(got));
  check('  └ 그때마다 변환 배율 = Loop.dpr = 캔버스 폭/960 (변환 행렬이 32비트라 getTransform().a 와 Loop.dpr 은 정확히 같음)', got.every(g => near(g[2], g[0] / 960, 1e-6) && g[3] === g[2]), JSON.stringify(got));
  // 실행 중에 DPR 이 바뀌어도(브라우저 확대/모니터 이동) 다음 그리기에서 따라감 (뷰포트 1280x720 고정: 1 → 1280, 1.5/2 → 상한 1920)
  const cdp = await t.context.newCDPSession(t.page);
  const sizes = [];
  for (const f of [1, 2, 1.5, 1]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: f, mobile: false });
    await frames();
    sizes.push(await t.page.evaluate(() => { const c = document.getElementById('game'); return [c.width, c.height, window.devicePixelRatio, c.getContext('2d').getTransform().a]; }));
  }
  check('실행 중 DPR 이 1→2→1.5→1 로 바뀌어도 캔버스 크기와 변환이 따라감 (1280→1920→1920→1280)', JSON.stringify(sizes.map(s => [s[0], Math.round(s[3] * 1000) / 1000])) === '[[1280,1.333],[1920,2],[1920,2],[1280,1.333]]', JSON.stringify(sizes));
  // 그리기 비용: 가장 큰 백버퍼(1920x1080)에서도 한 프레임 그리기가 느려지지 않음 (넉넉한 상한 — 소프트웨어 렌더링 헤드리스 기준)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await frames();
  const cost = await t.page.evaluate(() => {
    Scenes.P2 = { draw(ctx) { const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#9be3ff'); g.addColorStop(1, '#ffd6f2'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); Draw.text(ctx, '젤리 던전', W / 2, 200, { size: 60 }); } }; Game.scene = 'P2';
    Loop.draw(); const t0 = performance.now(); for (let i = 0; i < 20; i++) Loop.draw(); return { ms: (performance.now() - t0) / 20, w: Loop.canvas.width };
  });
  check(`1920x1080 백버퍼(${cost.w}px)에서 Loop.draw 한 번이 평균 ${cost.ms.toFixed(1)}ms (< 25ms, 컨텍스트 초기화 포함)`, cost.w === 1920 && cost.ms < 25, JSON.stringify(cost));
  check('창/DPR 이 바뀌는 동안 페이지 오류 없음', t.errors.length === 0, t.errors.join('|'));
  await t.close();

  // 창 크기가 아니라 CSS 만 바뀌어도(예: 화면 레이아웃이 #app 크기를 바꿈) ResizeObserver 가 같은 프레임 안에 따라감
  const grow = (page, css) => page.evaluate(css => { document.getElementById('app').style.cssText += css; }, css);
  const waitFrames = (page, n) => page.evaluate(n => new Promise(r => { const f = k => (k <= 0 ? r() : requestAnimationFrame(() => f(k - 1))); f(n); }), n);
  let t2 = await openCustom({ contextOpts: { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 } });
  await waitFrames(t2.page, 2);
  const w0 = await t2.page.evaluate(() => Loop.canvas.width);
  await grow(t2.page, ';width:1920px;height:1080px');
  await waitFrames(t2.page, 2);
  const w1 = await t2.page.evaluate(() => [Loop.canvas.width, Loop.canvas.height]);
  check('창 크기는 그대로 #app 의 CSS 크기만 1280→1920 으로 바뀌어도 (resize 이벤트 없이) 2프레임 안에 캔버스가 1920x1080 으로 따라감', w0 === 1280 && w1[0] === 1920 && w1[1] === 1080, JSON.stringify([w0, w1]));
  await t2.close();
  // ResizeObserver 가 없는 브라우저: resize 이벤트는 바로 반영하고, CSS 만 바뀐 경우는 30프레임 안에 다시 재서 반영
  t2 = await openCustom({ contextOpts: { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 }, init: () => { delete window.ResizeObserver; } });
  await waitFrames(t2.page, 2);
  check('(ResizeObserver 없음) 기준 크기 1280', await t2.page.evaluate(() => typeof window.ResizeObserver === 'undefined' && Loop.canvas.width) === 1280);
  await t2.page.setViewportSize({ width: 1920, height: 1080 });
  await waitFrames(t2.page, 2);
  check('(ResizeObserver 없음) 창을 키우면 resize 이벤트로 바로 1920 으로', await t2.page.evaluate(() => Loop.canvas.width) === 1920);
  await t2.page.setViewportSize({ width: 1280, height: 720 });
  await waitFrames(t2.page, 2);
  await grow(t2.page, ';width:1920px;height:1080px');
  await waitFrames(t2.page, 45);
  check('(ResizeObserver 없음) CSS 만 바뀌면 30프레임 안에 다시 재서 따라감', await t2.page.evaluate(() => Loop.canvas.width) === 1920);
  check('(ResizeObserver 없음) 오류 없음', t2.errors.length === 0, t2.errors.join('|'));
  await t2.close();
});

// =====================================================================
await section('디버그 씬 스크린샷 (눈으로 확인)', async () => {
  await reset();
  await ev(() => {
    RNG.seed(7);
    const jelly = color => (ctx, e) => {
      const cx = e.x, cy = e.y - e.z - e.h / 2, sq = 1 + Math.min(e.z, 80) / 400;
      ctx.save(); ctx.translate(cx, cy); ctx.scale(1 / sq, sq);
      ctx.lineWidth = 3; ctx.strokeStyle = COLORS.ink; ctx.fillStyle = e.flash > 0 ? '#fff' : color;
      ctx.beginPath(); ctx.ellipse(0, 0, e.w / 2 + 4, e.h / 2, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      for (const dx of [-9, 9]) {
        ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.ellipse(dx, -8, 6, 8, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = COLORS.ink; ctx.beginPath(); ctx.arc(dx + e.face * 2, -6, 3, 0, 7); ctx.fill();
      }
      ctx.restore();
      Draw.bar(ctx, e.x - 25, cy - e.h / 2 - 16, 50, 8, e.hp / e.maxHp, { fg: COLORS.red });
    };
    const mk = (x, y, z, c, w = 40, h = 80) => TT.mk({ x, y, z, w, h, hp: 14, maxHp: 20, team: 'enemy', draw: jelly(c) });
    mk(180, 400, 0, COLORS.pink); mk(260, 440, 0, COLORS.sky); mk(240, 480, 0, COLORS.mint);
    mk(420, 420, 70, COLORS.yellow); mk(560, 460, 140, COLORS.purple, 60, 60); mk(700, 380, 0, COLORS.red, 90, 120);
    TT.mk({ x: 820, y: 440, shadow: false, layer: 'ground', clampWorld: false, draw(ctx, e) { ctx.fillStyle = 'rgba(255,107,107,.35)'; ctx.strokeStyle = COLORS.red; ctx.lineWidth = 3; ctx.beginPath(); ctx.ellipse(e.x, e.y, 56, 20, 0, 0, 7); ctx.fill(); ctx.stroke(); } });
    Scenes.T = {
      update() { Entities.updateAll(); FX.update(); },
      draw(ctx) {
        const g = ctx.createLinearGradient(0, 0, 0, FLOOR_TOP); g.addColorStop(0, '#9be3ff'); g.addColorStop(1, '#ffd6f2');
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, FLOOR_TOP); ctx.fillStyle = '#e8c9a0'; ctx.fillRect(0, FLOOR_TOP - 10, W, H);
        Cam.apply(ctx); Entities.drawAll(ctx); FX.drawWorld(ctx); ctx.restore(); FX.drawScreen(ctx);
        Draw.text(ctx, '디버그 씬 — 별 · 사탕 · 반짝 · 뭉게 · 파동', W / 2, 40, { size: 26 });
        Draw.text(ctx, '왼쪽 정렬', 20, 80, { size: 20, align: 'left' }); Draw.text(ctx, '오른쪽 정렬', W - 20, 80, { size: 20, align: 'right' });
        Draw.bar(ctx, 20, 100, 200, 18, 0.6, { fg: COLORS.mint }); Draw.bar(ctx, 20, 126, 200, 18, 1, { fg: COLORS.pink }); Draw.bar(ctx, 20, 152, 200, 18, 0);
      },
    };
    const row = (kind, x, y) => FX.burst(x, y, { kind, count: kind === 'ring' ? 2 : 12 });
    row('spark', 120, 220); row('star', 260, 220); row('candy', 400, 220); row('puff', 540, 220); row('ring', 680, 220);
    FX.popup(180, 300, 12, { color: COLORS.white, size: 26 }); FX.popup(260, 320, 38, { color: COLORS.yellow, size: 36 }); FX.popup(700, 300, 25, { color: COLORS.red, size: 30 }); FX.popup(500, 260, '콤보 5!', { size: 28 });
  });
  await step(page, 9);
  await ev(() => Loop.draw());
  const shot1 = join(SHOT_DIR, 'core-debug-scene.png');
  await page.locator('#game').screenshot({ path: shot1 });
  await step(page, 6);
  await ev(() => { FX.flash('#ffffff', 14); FX.shake(8, 10); FX.update(); Loop.draw(); });
  const shot2 = join(SHOT_DIR, 'core-debug-scene-flash.png');
  await page.locator('#game').screenshot({ path: shot2 });
  console.log(`스크린샷: ${shot1}\n스크린샷: ${shot2}`);
  check('디버그 씬 스크린샷이 저장됨 (비어 있지 않은 PNG)', existsSync(shot1) && statSync(shot1).size > 8000 && existsSync(shot2) && statSync(shot2).size > 8000, `${statSync(shot1).size} / ${statSync(shot2).size} bytes`);
  const vis = await ev(() => {
    Scenes.T.update(); Loop.draw();
    const colors = new Set(); const c = document.getElementById('game').getContext('2d'); const d = c.getImageData(0, 0, c.canvas.width, c.canvas.height).data;
    for (let i = 0; i < d.length; i += 4 * 97) colors.add((d[i] >> 5) + ',' + (d[i + 1] >> 5) + ',' + (d[i + 2] >> 5));
    return { colors: colors.size, popups: FX.popups.length, parts: FX.particles.length };
  });
  check('디버그 씬에 다양한 색(캐릭터·입자·글자·그림자)이 그려짐', vis.colors > 25, JSON.stringify(vis));
  await ev(() => { FX.clear(); Entities.clear(); });
});

// =====================================================================
await section('FX.reduceMotion: 저장된 설정이 없으면 OS 의 동작 줄이기(prefers-reduced-motion)를 따라감', async () => {
  // 페이지 안에서: OS 설정(mq) / FX.reduceMotion / 흔들림 최대 폭 / 번쩍임 진하기
  const probe = t => t.page.evaluate(() => {
    const mq = matchMedia('(prefers-reduced-motion: reduce)').matches, rm = FX.reduceMotion;
    FX.clear(); FX.shake(10, 30); let sh = 0; for (let i = 0; i < 30; i++) { sh = Math.max(sh, Math.abs(FX.shakeOff.x), Math.abs(FX.shakeOff.y)); FX.update(); }
    FX.clear(); FX.flash('#fff', 20); const fl = FX.flashAlpha; FX.clear();
    return { mq, rm, sh, fl };
  });
  // 1) OS 가 '동작 줄이기' + 저장된 값 없음 → 켜짐: 흔들림 ≤ 3px, 번쩍임 ≤ 0.25
  let t = await openCustom({ contextOpts: { reducedMotion: 'reduce' } });
  const a = await probe(t);
  check('OS 동작 줄이기 + 저장 없음 → FX.reduceMotion = true, 흔들림 ≤ 3px, 번쩍임 ≤ 0.25', a.mq === true && a.rm === true && a.sh <= 3 && a.fl > 0 && a.fl <= 0.25, JSON.stringify(a));
  const plain = await t.page.evaluate(() => { const d = Object.getOwnPropertyDescriptor(FX, 'reduceMotion'); FX.reduceMotion = false; const x = FX.reduceMotion; FX.reduceMotion = true; return { plain: 'value' in d && d.writable, x, y: FX.reduceMotion }; });
  check('reduceMotion 은 그냥 대입 가능한 값 (getter 아님): false 로 바꿨다가 true 로', plain.plain && plain.x === false && plain.y === true, JSON.stringify(plain));
  check('  └ 오류 없음', t.errors.length === 0, t.errors.join('|')); await t.close();
  // 2) OS 설정이 없으면(기본) 꺼짐: 흔들림이 크게(>3px), 번쩍임이 진하게(>0.4)
  t = await openCustom({ contextOpts: { reducedMotion: 'no-preference' } });
  const b = await probe(t);
  check('OS 설정 없음 + 저장 없음 → FX.reduceMotion = false, 흔들림 > 3px, 번쩍임 > 0.4 (기존과 같음)', b.mq === false && b.rm === false && b.sh > 3 && b.fl > 0.4, JSON.stringify(b));
  await t.close();
  // 3) 저장된 설정이 있으면 그 값이 OS 보다 우선 (설정 화면에서 사용자가 고른 값)
  t = await openCustom({ contextOpts: { reducedMotion: 'reduce' }, init: () => { try { localStorage.setItem('jd:reduceMotion', 'false'); } catch (e) { /* 무시 */ } } });
  const c = await probe(t);
  check('저장된 reduceMotion=false 는 OS 동작 줄이기보다 우선 (OS 는 줄이기인데 FX 는 꺼짐)', c.mq === true && c.rm === false && c.sh > 3 && c.fl > 0.4, JSON.stringify(c));
  await t.close();
  t = await openCustom({ contextOpts: { reducedMotion: 'no-preference' }, init: () => { try { localStorage.setItem('jd:reduceMotion', 'true'); } catch (e) { /* 무시 */ } } });
  const d = await probe(t);
  check('저장된 reduceMotion=true 는 OS 설정이 없어도 켜짐', d.mq === false && d.rm === true && d.sh <= 3 && d.fl <= 0.25, JSON.stringify(d));
  await t.close();
  // 4) 게임 도중 OS 설정이 바뀌면 따라감 (저장된 값이 없을 때만)
  t = await openCustom({ contextOpts: { reducedMotion: 'no-preference' } });
  const flip = async mode => { await t.page.emulateMedia({ reducedMotion: mode }); await t.page.waitForTimeout(80); return t.page.evaluate(() => FX.reduceMotion); };
  const live = [await t.page.evaluate(() => FX.reduceMotion), await flip('reduce'), await flip('no-preference'), await flip('reduce')];
  check('게임 도중 OS 설정이 바뀌면 FX.reduceMotion 이 따라감 (꺼짐 → 켜짐 → 꺼짐 → 켜짐)', JSON.stringify(live) === '[false,true,false,true]', JSON.stringify(live));
  // 사용자가 설정 화면에서 직접 고르면(Store 에 저장 + FX.reduceMotion 대입) 그 뒤로는 OS 가 바뀌어도 그 값을 지킴
  await t.page.evaluate(() => { Store.set('reduceMotion', false); FX.reduceMotion = false; });
  const pinnedOff = [await flip('reduce'), await flip('no-preference'), await flip('reduce')];
  check('사용자가 "끔"으로 저장했으면 OS 가 동작 줄이기로 바뀌어도 꺼진 채 유지', JSON.stringify(pinnedOff) === '[false,false,false]', JSON.stringify(pinnedOff));
  await t.page.evaluate(() => { Store.set('reduceMotion', true); FX.reduceMotion = true; });
  const pinnedOn = [await flip('no-preference'), await flip('reduce'), await flip('no-preference')];
  check('사용자가 "켬"으로 저장했으면 OS 설정이 없어져도 켜진 채 유지', JSON.stringify(pinnedOn) === '[true,true,true]', JSON.stringify(pinnedOn));
  check('  └ 오류 없음', t.errors.length === 0, t.errors.join('|')); await t.close();
});

// =====================================================================
await section('Input: Ctrl/Cmd/Alt 가 눌린 키는 브라우저 단축키라 게임 키가 아님', async () => {
  await reset(); await ev(() => { Input.clear(); if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); document.body.focus(); });
  const snap = () => ev(() => ({ down: Object.keys(Input.down).sort().join(), pressed: Object.keys(Input.pressed).sort().join() }));
  // 대조군: 진짜 키보드 이벤트가 이 페이지까지 오는지 (안 오면 아래 "기록 안 됨" 검사가 공짜로 통과해 버림)
  await page.keyboard.press('KeyQ');
  check('대조군: 수정키 없이 누른 Q 는 Input 에 기록됨 (키보드 이벤트가 실제로 도착함)', (await snap()).pressed === 'KeyQ', JSON.stringify(await snap()));
  await ev(() => Input.clear());
  for (const combo of ['Control+KeyD', 'Control+KeyS', 'Control+KeyA', 'Meta+KeyD', 'Alt+KeyD', 'Control+Shift+KeyD', 'Control+Space', 'Control+KeyM']) {
    await page.keyboard.press(combo);
    const r = await snap();
    check(`${combo}: 게임 키로 기록되지 않음 (Ctrl+D 가 30초 궁극기를 쓰지 않게)`, r.down === '' && r.pressed === '', JSON.stringify(r));
  }
  // 조합이 아닌 평소 키는 그대로, Shift 는 단축키가 아님
  await page.keyboard.press('KeyD'); const plain = await snap();
  await page.keyboard.press('Shift+KeyZ'); const sh = await ev(() => Input.wasPressed('KeyZ'));
  check('Ctrl 없이 누른 D 는 평소처럼 기록됨, Shift+Z(대문자 입력)도 공격 키로 동작', plain.pressed === 'KeyD' && sh === true, JSON.stringify([plain, sh]));
  await ev(() => Input.clear());
  // 방향키는 예외: 달리는 중에 Ctrl/Alt/Cmd 를 스치듯 눌러도 멈추지 않음 (preventDefault 도 그대로)
  await page.keyboard.down('Control'); await page.keyboard.down('ArrowRight');
  const arrow = await ev(() => ({ r: Input.isDown('ArrowRight'), ctrl: Input.isDown('ControlLeft') }));
  await page.keyboard.up('ArrowRight'); await page.keyboard.up('Control');
  check('Ctrl 을 누른 채 방향키 → 방향키는 여전히 눌림으로 기록 (Ctrl 자체는 기록 안 함)', arrow.r === true && arrow.ctrl === false, JSON.stringify(arrow));
  // 고착 방지: 이미 눌려 있던 (방향키 아닌) 키는 수정키가 눌리는 순간 놓음 — Mac 은 Cmd 를 누른 동안 keyup 이 오지 않음
  await ev(() => Input.clear());
  await page.keyboard.down('KeyA'); await page.keyboard.down('ArrowLeft');
  const before = await snap();
  await page.keyboard.down('Meta');
  const after = await snap();
  await page.keyboard.up('Meta'); await page.keyboard.up('KeyA'); await page.keyboard.up('ArrowLeft');
  check('A 와 ← 를 누른 채 Cmd 를 누르면 A 만 놓임 (← 는 유지)', before.down === 'ArrowLeft,KeyA' && after.down === 'ArrowLeft', JSON.stringify([before, after]));
  await ev(() => Input.clear());
  await page.keyboard.press('KeyZ'); await page.keyboard.press('KeyX');
  check('수정키를 뗀 뒤에는 게임 키가 다시 정상 동작', await ev(() => Input.wasPressed('KeyZ') && Input.wasPressed('KeyX')) === true);
  await ev(() => Input.clear());
});

// =====================================================================
await section('오류 격리: Events.emit 과 Entities.updateAll 은 한 곳의 예외가 다른 곳을 멈추지 않음', async () => {
  await reset();
  const r = await ev(() => {
    const o = {};
    // Events: 던지는 핸들러 뒤의 핸들러도 돌고, emit 은 던지지 않고, 같은 오류는 한 번만 기록
    Events.clear(); let ran = 0, first = 0;
    Events.on('zz.격리', () => { first++; throw new Error('핸들러 폭발 격리'); });
    Events.on('zz.격리', () => ran++);
    TT.grabErrors(); let thrown = false;
    try { Events.emit('zz.격리', {}); Events.emit('zz.격리', {}); Events.emit('zz.격리', {}); } catch (e) { thrown = true; }
    const e1 = TT.releaseErrors();
    o.events = { first, ran, thrown, errs: e1.length, msg: e1[0] || '' };
    // 같은 이벤트에 다른 오류가 나면 새로 기록됨
    TT.grabErrors(); Events.clear('zz.격리'); Events.on('zz.격리', () => { throw new Error('다른 오류 격리'); }); Events.emit('zz.격리', {}); o.newMsg = TT.releaseErrors().length;
    // Entities: update/tick 이 던지는 엔티티가 있어도 나머지는 계속 돌고 updateAll 은 던지지 않음
    Entities.clear(); let u = 0, t = 0, moved = 0;
    TT.mk({ type: '격리A', x: 100, y: 400, update() { throw new Error('update 격리'); } });
    TT.mk({ type: '격리B', x: 200, y: 400, tick() { throw new Error('tick 격리'); } });
    const ok = TT.mk({ x: 300, y: 400, update(e) { u++; e.vx = 1; }, tick() { t++; } });
    const thrower = TT.mk({ type: '격리C', x: 50, y: 400, update(e) { e.vx = 2; throw new Error('물리 격리'); } });
    TT.grabErrors(); let thrown2 = false;
    try { for (let i = 0; i < 5; i++) Entities.updateAll(); } catch (e) { thrown2 = true; }
    const e2 = TT.releaseErrors();
    o.ents = { u, t, thrown2, errs: e2.length, x: ok.x, thrownX: thrower.x };
    // 씬 수준: update 가 던지는 적이 있어도 updateAll 뒤의 코드(= Stage 진행)가 매 틱 실행됨 (softlock 방지)
    Entities.clear(); let after = 0;
    TT.mk({ type: '격리D', x: 100, y: 400, update() { throw new Error('씬 격리'); } });
    Scenes.T = { update() { Entities.updateAll(); after++; } }; Game.scene = 'T';
    TT.grabErrors(); Loop.step(50); o.sceneErrs = TT.releaseErrors().length; o.scene = after;
    return o;
  });
  check('Events.emit: 앞 핸들러가 던져도 뒤 핸들러는 실행되고 emit 은 던지지 않음 (3번 emit → 앞 3번·뒤 3번)', r.events.first === 3 && r.events.ran === 3 && r.events.thrown === false, JSON.stringify(r.events));
  check('Events.emit: 같은 오류는 한 번만 console.error (3번 던져도 1번), 이벤트 이름이 메시지에 들어감', r.events.errs === 1 && /zz\.격리/.test(r.events.msg), JSON.stringify([r.events.errs, r.events.msg]));
  check('Events.emit: 다른 오류가 나면 다시 기록됨', r.newMsg === 1, String(r.newMsg));
  check('Entities.updateAll: update/tick 이 던지는 엔티티가 있어도 정상 엔티티는 5틱 모두 update/tick 실행, updateAll 은 던지지 않음, 오류는 던지는 엔티티·훅마다 1번씩(3번)', r.ents.u === 5 && r.ents.t === 5 && r.ents.thrown2 === false && r.ents.errs === 3, JSON.stringify(r.ents));
  check('Entities.updateAll: update 가 던져도 그 엔티티의 물리(이동)는 계속, 정상 엔티티도 이동', r.ents.x > 300 && r.ents.thrownX > 50, JSON.stringify([r.ents.x, r.ents.thrownX]));
  check('씬 update 안에서 엔티티 하나가 계속 던져도 updateAll 뒤의 코드가 매 틱 실행됨 (50틱 모두) — Stage 가 멈추지 않는 이유', r.scene === 50 && r.sceneErrs === 1, JSON.stringify([r.scene, r.sceneErrs]));
});

// =====================================================================
await section('Loop.draw: 그리기 오류가 캔버스 상태(save/clip)를 남기지 않음', async () => {
  await reset();
  const r = await ev(() => {
    const o = {}; TT.grabErrors();
    const ctx = Loop.canvas.getContext('2d');
    const green = () => { Scenes.GR = { draw(c) { c.fillStyle = '#00ff00'; c.fillRect(0, 0, W, H); } }; Game.scene = 'GR'; Loop.draw(); return TT.px(480, 270).join(); };
    o.baseline = green();
    // (a) 씬 안의 try/catch 가 오류를 삼켜도 (Scenes.play.draw 가 HUD/배경/오버레이에 하는 것처럼) 남은 clip 이 이후 모든 프레임을 자르지 않음
    Scenes.LK = { draw(c) { try { c.save(); c.beginPath(); c.rect(0, 0, 50, 50); c.clip(); throw new Error('clip 누수'); } catch (e) { /* 씬이 삼킴 */ } } };
    Game.scene = 'LK'; for (let i = 0; i < 6; i++) Loop.draw();
    o.afterSwallowedClip = green();
    // (b) 같은 일이 여러 프레임 계속돼도 (save 가 프레임마다 하나씩 새도) 그 다음 프레임은 깨끗하게 칠해짐
    Scenes.LK2 = { draw(c) { try { c.save(); c.save(); c.globalAlpha = 0.2; c.translate(300, 300); c.beginPath(); c.rect(0, 0, 10, 10); c.clip(); throw new Error('누수 둘'); } catch (e) { /* 삼킴 */ } } };
    Game.scene = 'LK2'; for (let i = 0; i < 200; i++) Loop.draw();
    o.afterManyLeaks = green();
    // (c) 오류가 씬 밖으로 나온 경우: 돌아오자마자(다음 프레임 전) 변환·알파가 원래대로 (짝 안 맞는 save 를 restore 로 정리)
    Scenes.TH = { draw(c) { c.save(); c.save(); c.globalAlpha = 0.1; c.translate(500, 500); c.scale(2, 2); throw new Error('draw 밖으로 예외'); } };
    Game.scene = 'TH'; Loop.draw();
    const tr = ctx.getTransform(); o.afterThrow = [tr.a, tr.e, tr.f, ctx.globalAlpha, Loop.dpr];
    o.errs = TT.releaseErrors().length;
    Game.scene = 'GR';
    return o;
  });
  check('기준: 평소에는 전체 화면이 칠해짐', r.baseline === '0,255,0', r.baseline);
  check('씬이 삼킨 clip(save+clip 뒤 예외)이 남아도 다음 프레임이 화면 전체를 칠함 (leaked clip 으로 화면이 얼어붙지 않음)', r.afterSwallowedClip === '0,255,0', r.afterSwallowedClip);
  check('save/clip 이 프레임마다 새는 씬을 200프레임 그려도 그 다음 프레임은 정상', r.afterManyLeaks === '0,255,0', r.afterManyLeaks);
  check('scene.draw 가 예외를 밖으로 던지면 곧바로 save 를 정리 (변환 = 배율만, 이동 0, 알파 1)', Math.abs(r.afterThrow[0] - r.afterThrow[4]) < 1e-6 && r.afterThrow[1] === 0 && r.afterThrow[2] === 0 && r.afterThrow[3] === 1, JSON.stringify(r.afterThrow));
  check('  └ 삼킨 오류와 던진 오류가 각각 한 번씩만 기록됨 (같은 메시지는 반복 안 함)', r.errs === 1, String(r.errs));   // LK/LK2 는 씬이 삼켜서 로그 없음, TH 만 1번

  // ctx.reset() 이 없는 구형 브라우저: 캔버스 크기를 다시 대입하는 대체 경로로도 같은 결과
  const t = await openCustom({ init: () => { delete CanvasRenderingContext2D.prototype.reset; } });
  const fb = await t.page.evaluate(() => {
    const o = { hasReset: typeof Loop.canvas.getContext('2d').reset };
    const green = () => { Scenes.GR = { draw(c) { c.fillStyle = '#00ff00'; c.fillRect(0, 0, W, H); } }; Game.scene = 'GR'; Loop.draw(); const c = Loop.canvas, d = Loop.ctx.getImageData(Math.round(480 * Loop.dpr), Math.round(270 * Loop.dpr), 1, 1).data; return [d[0], d[1], d[2]].join(); };
    Scenes.LK = { draw(c) { try { c.save(); c.beginPath(); c.rect(0, 0, 50, 50); c.clip(); throw new Error('clip 누수 (reset 없음)'); } catch (e) { /* 삼킴 */ } } };
    Game.scene = 'LK'; for (let i = 0; i < 5; i++) Loop.draw();
    o.afterClip = green();
    const t0 = performance.now(); for (let i = 0; i < 60; i++) Loop.draw(); o.ms = (performance.now() - t0) / 60;
    o.size = [Loop.canvas.width, Loop.canvas.height]; o.dpr = Loop.dpr;
    const tr = Loop.ctx.getTransform(); o.tr = [tr.a, tr.d, tr.e, tr.f];
    return o;
  });
  check('ctx.reset 이 없어도(구형 브라우저) 삼킨 clip 이 남지 않고, 캔버스 크기·변환이 유지되고 한 프레임 그리기도 느리지 않음', fb.hasReset === 'undefined' && fb.afterClip === '0,255,0' && fb.size[0] === Math.round(960 * fb.dpr) && fb.tr[0] === fb.dpr && fb.tr[1] === fb.dpr && fb.tr[2] === 0 && fb.tr[3] === 0 && fb.ms < 25, JSON.stringify(fb));
  check('  └ 오류 없음', t.errors.length === 0, t.errors.join('|'));
  await t.close();
});

// =====================================================================
await section('Loop: 실제 시간 경로 (rAF 콜백에 합성 타임스탬프) — 틱 속도 · 떨림 보정 · 100ms 상한', async () => {
  const g = await openGame({ rafStub: true });
  await g.page.evaluate(() => { Scenes.T = {}; Game.scene = 'T'; Game.paused = false; Loop.hooks.length = 0; });
  const rates = [30, 56, 57, 58, 59, 59.94, 60, 61, 62, 63, 64, 75, 120, 144, 240];
  const res = {};
  for (const hz of rates) res[hz] = await simulateFrames(g.page, { hz, seconds: 10 });
  const bad = rates.filter(hz => Math.abs(res[hz].rate / 60 - 1) > 0.01);
  check(`주사율 ${rates.join('/')}Hz 에서 10초 동안 초당 틱이 60 의 ±1% 안 (56~64Hz 에서도 게임 속도가 화면에 끌려가지 않음)`, bad.length === 0, bad.map(hz => `${hz}Hz=${res[hz].rate.toFixed(2)}`).join(' ') || rates.map(hz => `${hz}:${res[hz].rate.toFixed(1)}`).join(' '));
  const keyRates = [59, 60, 62, 64, 144].map(hz => `${hz}Hz=${res[hz].ticks}틱`).join(' ');
  check(`  └ 10초(= 600틱 기준) 틱 수: ${keyRates}`, [59, 60, 62, 64, 144].every(hz => res[hz].ticks >= 594 && res[hz].ticks <= 606));
  check('  └ 한 프레임에 몰아서 도는 틱은 56~64Hz 에서 최대 2개, 그 이상 주사율에서는 1개 이하 (소나기처럼 몰리지 않음)', [56, 57, 58, 59, 60, 61, 62, 63, 64].every(hz => Math.max(...res[hz].perFrame) <= 2) && [75, 120, 144, 240].every(hz => Math.max(...res[hz].perFrame) <= 1), rates.map(hz => `${hz}:${Math.max(...res[hz].perFrame)}`).join(' '));
  const ex = res[60].perFrame;
  check('정확히 60Hz: 프레임마다 틱이 딱 1개 (0개나 2개가 섞이는 떨림 없음)', ex.every(x => x === 1), `${ex.filter(x => x !== 1).length}개 프레임이 1틱이 아님`);
  const jit = await simulateFrames(g.page, { hz: 60, seconds: 10, jitter: 0.5 });
  check('60Hz + 시각 측정 오차 ±0.5ms: 그래도 프레임마다 틱 1개 (떨림 보정이 살아 있음) 이고 평균 60/초', jit.perFrame.every(x => x === 1) && Math.abs(jit.rate / 60 - 1) < 0.01, `1틱 아닌 프레임 ${jit.perFrame.filter(x => x !== 1).length}개, ${jit.rate.toFixed(2)}/초`);
  const j62 = await simulateFrames(g.page, { hz: 62, seconds: 10, jitter: 0.4 });
  check('62Hz + 오차 ±0.4ms: 평균 60/초, 한 프레임 최대 2틱', Math.abs(j62.rate / 60 - 1) < 0.01 && Math.max(...j62.perFrame) <= 2, `${j62.rate.toFixed(2)}/초 최대 ${Math.max(...j62.perFrame)}`);
  // 오래 멈췄다 와도 (백그라운드 탭) 한 프레임에 100ms(≈6틱) 이상 몰아서 돌지 않음, 짧은 멈춤은 따라잡음
  const gap = await simulateFrames(g.page, { hz: 60, seconds: 1, gaps: [{ at: 30, ms: 5000 }] });
  check('5초 멈췄다 돌아와도 그 프레임의 틱은 6개 이하 (폭주 방지: dt 상한 100ms)', Math.max(...gap.perFrame) <= 6 && gap.perFrame[29] <= 6, `프레임 30: ${gap.perFrame[29]}틱, 최대 ${Math.max(...gap.perFrame)}`);
  const hitch = await simulateFrames(g.page, { hz: 60, seconds: 1, gaps: [{ at: 30, ms: 33 }] });
  check('프레임 하나가 33ms 늦으면(한 번 버벅임) 그 프레임에서 2~3틱으로 따라잡음', hitch.perFrame[29] >= 2 && hitch.perFrame[29] <= 3, `프레임 30: ${hitch.perFrame[29]}틱`);
  const manual = await g.page.evaluate(() => { Loop.manual = true; const b = Loop.tickCount; const cb = window.__rafCb; const t0 = performance.now(); for (let i = 1; i <= 60; i++) cb(t0 + i * 16.667); return Loop.tickCount - b; });
  check('Loop.manual=true 면 rAF 콜백이 와도 틱은 0', manual === 0, String(manual));
  check('실시간 경로 시험 중 페이지 오류 없음', g.errors.length === 0, g.errors.join('|'));
  await g.close();
});

// =====================================================================
await section('오디오 생명주기: 탭이 숨겨지면 AudioContext 를 멈추고, 멈춰 있는 동안은 소리를 만들지 않음', async () => {
  const t = await openCustom({ init: () => {
    const Base = window.AudioContext; if (!Base) return;
    window.__acs = []; window.__nodes = 0;
    window.AudioContext = class extends Base {
      constructor(...a) { super(...a); window.__acs.push(this); }
      createOscillator(...a) { window.__nodes++; return super.createOscillator(...a); }
      createBufferSource(...a) { window.__nodes++; return super.createBufferSource(...a); }
    };
  } });
  const state = () => t.page.evaluate(() => (window.__acs[0] || {}).state);
  const until = async (want, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if ((await state()) === want) return true; await t.page.waitForTimeout(40); } return false; };
  const setHidden = h => t.page.evaluate(h => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => h }); document.dispatchEvent(new Event('visibilitychange')); }, h);
  await t.page.evaluate(() => SFX.init());
  check('SFX.init 뒤 AudioContext 가 실행 중(running)', await until('running'), String(await state()));
  const n0 = await t.page.evaluate(() => { const b = window.__nodes; SFX.play('hit'); return window.__nodes - b; });
  check('실행 중에는 SFX.play 가 소리 부품(oscillator/noise)을 만듦', n0 > 0, String(n0));
  await setHidden(true);
  check('탭이 숨겨지면(visibilitychange) AudioContext 가 suspended — 음악이 백그라운드에서 계속 나오지 않음', await until('suspended'), String(await state()));
  const n1 = await t.page.evaluate(() => { const b = window.__nodes; ['coin', 'swing', 'jump', 'ui'].forEach(n => SFX.play(n)); return window.__nodes - b; });
  check('멈춰 있는 동안(suspended) SFX.play 는 소리 부품을 하나도 만들지 않음 (풀리는 순간 한꺼번에 터지는 것 방지)', n1 === 0, String(n1));
  await setHidden(false);
  check('탭이 다시 보이면 AudioContext 가 running 으로 돌아옴', await until('running'), String(await state()));
  await t.page.waitForTimeout(60);
  const n2 = await t.page.evaluate(() => { const b = window.__nodes; SFX.play('heal'); return window.__nodes - b; });
  check('돌아온 뒤에는 다시 소리를 만듦', n2 > 0, String(n2));
  check('오디오 생명주기 시험 중 페이지 오류 없음', t.errors.length === 0, t.errors.join('|'));
  await t.close();
});

// =====================================================================
await section('tools/build-local.mjs: 깨진 빌드를 "성공"이라고 하지 않음 (src 임시 복사본으로 시험)', async () => {
  const mkEnv = () => {
    const dir = mkTmp('jd-build-');
    mkdirSync(join(dir, 'tools')); mkdirSync(join(dir, 'src'));
    copyFileSync(join(root, 'tools', 'build-local.mjs'), join(dir, 'tools', 'build-local.mjs'));
    for (const f of readdirSync(join(root, 'src'))) if (/\.html$/.test(f)) copyFileSync(join(root, 'src', f), join(dir, 'src', f));
    return dir;
  };
  const edit = (dir, file, fn) => { const p = join(dir, 'src', file); writeFileSync(p, fn(readFileSync(p, 'utf8'))); };
  const build = (dir, ...a) => spawnSync(process.execPath, [join(dir, 'tools', 'build-local.mjs'), ...a], { encoding: 'utf8', cwd: dir });
  const outOf = (dir, name = 'x.html') => join(dir, 'dist', name);
  const fails = (r, dir, re, name = 'x.html') => r.status === 1 && re.test(r.stderr) && !existsSync(outOf(dir, name));
  const msg = r => (r.stderr + r.stdout).split('\n').slice(0, 4).join(' | ').slice(0, 400);
  const openTag = '<script>';

  // 기준: 복사본이 그대로 빌드되고, 결과가 진짜 src 로 빌드한 것과 같음
  let dir = mkEnv();
  let r = build(dir, '--out', 'dist/x.html');
  const real = spawnSync(process.execPath, [join(root, 'tools', 'build-local.mjs'), '--out', join(dir, 'dist', 'real.html')], { encoding: 'utf8' });
  check('기준: src 복사본이 문제없이 빌드됨 (종료 0, 결과 파일 생성)', r.status === 0 && existsSync(outOf(dir)) && /✓/.test(r.stdout), msg(r));
  check('  └ 복사본 빌드 결과 = 진짜 저장소 src 로 빌드한 결과 (복사가 충실함)', real.status === 0 && readFileSync(outOf(dir), 'utf8') === readFileSync(join(dir, 'dist', 'real.html'), 'utf8'));

  // 1) 파일끼리 최상위 이름 충돌 (R-05 재현 1): const / let / class / function / 구조분해 / 쉼표 선언
  const dup = (label, code, re) => {
    const d = mkEnv(); edit(d, 'js_ui.html', t => t.replace(openTag, openTag + '\n' + code));
    const x = build(d, '--out', 'dist/x.html');
    check(`최상위 이름 충돌 — ${label}: 빌드 실패(종료 1), 두 파일 이름과 선언 이름을 알려줌, 결과 파일 없음`, fails(x, d, re) && /js_ui\.html/.test(x.stderr), msg(x));
  };
  dup('js_stage 의 const Stage 를 js_ui 에서 또 선언', 'const Stage = {};', /'Stage'.*js_stage\.html.*js_ui\.html|'Stage'.*js_ui\.html.*js_stage\.html/);
  dup('core 의 const 를 let 으로', 'let Loop = 1;', /'Loop'/);
  dup('class 로 core 의 이름을', 'class Cam {}', /'Cam'/);
  dup('function 이 core 의 const clamp 와', 'function clamp() {}', /'clamp'/);
  dup('구조분해 const { a, W } = x 의 W', 'const { q: W2, W } = {};', /'W'/);
  dup('배열 구조분해 const [Zed, FX] = …', 'const [Zed, FX] = [1, 2];', /'FX'/);
  dup('쉼표 선언 const a1 = 1, Game = 2', 'const a1 = 1, Game = 2;', /'Game'/);
  dup('var 로 core 이름을', 'var Entities = 1;', /'Entities'/);
  dup('브라우저가 이미 쓰는 전역 이름(location)', 'const location = 1;', /'location'/);
  // 같은 파일 안의 함수/블록 안 선언, 주석/문자열/템플릿/정규식 안의 글자는 충돌이 아님 (오탐 없음)
  dir = mkEnv();
  edit(dir, 'js_ui.html', t => t.replace(openTag, openTag + `
const UI_NOFALSE = { a: 1 };
function uiHelper() { const W = 1, Loop = 2; let clamp = 3; return W + Loop + clamp; }
{ const blockScoped = 1; }
for (const Stage of [1]) { void Stage; }
// const Game = 1;   /* class Cam {} */
const uiStr = 'const Stage = 1; function clamp() {}', uiTpl = \`const Loop = \${ \`function Cam() {} \${ 1 } \` }\`, uiRe = /const Game = [}]/g, uiDiv = 4 / 2 / 1;
const uiObj = { Game: 1, W: 2, method() { const FX = 1; return FX; } };
`));
  r = build(dir, '--out', 'dist/x.html');
  check('오탐 없음: 함수/블록/for 안의 선언과 주석·문자열·템플릿·정규식 안의 "const Stage" 같은 글자는 충돌로 보지 않음', r.status === 0 && existsSync(outOf(dir)), msg(r));

  // 2) 속성이 붙은 <script> (R-05 재현 2)
  dir = mkEnv();
  edit(dir, 'js_main.html', t => t.replace(openTag, '<script type="text/javascript">').replace('</script>', 'let = = ;\n</script>'));
  r = build(dir, '--out', 'dist/x.html');
  check('속성이 붙은 <script type="text/javascript"> 안의 문법 오류도 잡음 (파일 이름과 줄 번호)', fails(r, dir, /js_main\.html:\d+/), msg(r));
  dir = mkEnv();
  edit(dir, 'js_main.html', t => t.replace(openTag, '<script type="text/javascript">'));
  r = build(dir, '--out', 'dist/x.html');
  check('type="text/javascript" 는 속성 없는 <script> 와 같은 뜻이라 허용 (정상 코드면 빌드 성공)', r.status === 0 && existsSync(outOf(dir)), msg(r));
  for (const [label, tag] of [['type="module"', '<script type="module">'], ['src=', '<script src="https://example.com/x.js">'], ['async', '<script async>'], ['defer', '<script defer>'], ['type=text/template', '<script type="text/template">'], ['대문자 태그 + type=module', '<SCRIPT TYPE="module">']]) {
    dir = mkEnv(); edit(dir, 'js_main.html', t => t.replace(openTag, tag));
    r = build(dir, '--out', 'dist/x.html');
    check(`속성이 붙은 script 태그 ${label} 는 거부 (Apps Script 가 다르게 처리할 수 있음)`, fails(r, dir, /js_main\.html.*속성이 붙은 script/), msg(r));
  }
  dir = mkEnv(); edit(dir, 'js_ui.html', t => t.replace('</script>', '</script>\n<script>\nlet = = ;\n</script>'));
  r = build(dir, '--out', 'dist/x.html');
  check('한 파일에 <script> 가 여러 개여도 전부 검사 (두 번째의 문법 오류)', fails(r, dir, /js_ui\.html:\d+/), msg(r));
  dir = mkEnv(); edit(dir, 'js_ui.html', t => t.replace('</script>', "const s = '</script>';\n</script>"));
  r = build(dir, '--out', 'dist/x.html');
  check('JS 문자열 안의 </script> 는 짝이 안 맞는다고 실패', fails(r, dir, /js_ui\.html/), msg(r));
  dir = mkEnv(); edit(dir, 'index.html', t => t.replace('</body>', '<script>var x = 1;</script>\n</body>'));
  r = build(dir, '--out', 'dist/x.html');
  check('index.html 에 직접 쓴 <script> 는 거부 (코드는 js_*.html 로)', fails(r, dir, /index\.html.*<script>/), msg(r));
  dir = mkEnv(); edit(dir, 'js_ui.html', t => t.replace(openTag, openTag + "\nconst bad = '<?= 1 ?>';"));
  r = build(dir, '--out', 'dist/x.html');
  check('JS 문자열 안의 "<?" (Apps Script 템플릿을 깨뜨림) 는 실패', fails(r, dir, /스크립틀릿/), msg(r));

  // 3) include 가 빠지거나 겹치거나 없는 파일 (R-05 재현 3)
  dir = mkEnv(); edit(dir, 'index.html', t => t.replace("<?!= include('js_main') ?>\n", ''));
  r = build(dir, '--out', 'dist/x.html');
  check("index.html 에서 include('js_main') 가 빠지면 실패 (src/js_main.html 이 게임에 안 들어간다고 알려줌)", fails(r, dir, /js_main\.html.*include/), msg(r));
  dir = mkEnv(); edit(dir, 'index.html', t => t.replace("<?!= include('style') ?>\n", ''));
  r = build(dir, '--out', 'dist/x.html');
  check("style.html 이 빠져도 실패 (js 가 아닌 파일도 마찬가지)", fails(r, dir, /style\.html.*include/), msg(r));
  dir = mkEnv(); edit(dir, 'index.html', t => t.replace("<?!= include('js_ui') ?>", "<?!= include('js_ui') ?>\n<?!= include('js_ui') ?>"));
  r = build(dir, '--out', 'dist/x.html');
  check("같은 include('js_ui') 가 두 번 들어가면 실패 (const 가 두 번 선언돼 깨짐)", fails(r, dir, /include\('js_ui'\).*2번/), msg(r));
  dir = mkEnv(); edit(dir, 'index.html', t => t.replace("<?!= include('js_main') ?>", "<?!= include('js_main') ?>\n<?!= include('js_nope') ?>"));
  r = build(dir, '--out', 'dist/x.html');
  check("없는 파일을 include 하면 실패 (파일 이름을 알려줌)", fails(r, dir, /js_nope/), msg(r));
  dir = mkEnv(); edit(dir, 'index.html', t => t.replace("<?!= include('js_main') ?>\n", '').replace("<?!= include('js_core') ?>", "<?!= include('js_main') ?>\n<?!= include('js_core') ?>"));
  r = build(dir, '--out', 'dist/x.html');
  check("js_main 이 js_core 앞에 오도록 순서를 바꾸면 실패 (core 가 맨 먼저, main 이 맨 마지막이어야 함)", fails(r, dir, /js_core.*맨 먼저/) && /js_main.*맨 마지막/.test(r.stderr), msg(r));
  dir = mkEnv(); edit(dir, 'index.html', t => t.replace("<?!= include('js_ui') ?>\n", '').replace("<?!= include('js_main') ?>", "<?!= include('js_main') ?>\n<?!= include('js_ui') ?>"));
  r = build(dir, '--out', 'dist/x.html');
  check("js_main 뒤에 다른 모듈을 include 해도 실패", fails(r, dir, /js_main.*맨 마지막/), msg(r));
  dir = mkEnv(); writeFileSync(join(dir, 'src', 'js_extra.html'), '<script>\nconst Extra = 1;\n</script>\n');
  r = build(dir, '--out', 'dist/x.html');
  check("src 에 새 js_extra.html 을 만들고 index.html 에 안 붙이면 실패", fails(r, dir, /js_extra\.html.*include/), msg(r));
  dir = mkEnv(); edit(dir, 'js_ui.html', t => t.replace('</script>', '}\n</script>'));
  r = build(dir, '--out', 'dist/x.html');
  check('기존 검사 유지: 일반 문법 오류는 파일 이름과 함께 실패', fails(r, dir, /js_ui\.html/), msg(r));
  r = build(dir, '--out');
  check('--out 뒤에 경로가 없으면 안내하고 실패', r.status === 1 && /--out/.test(r.stderr), msg(r));

  // 4) --check: 이미 있는 dist 파일이 src 로 새로 빌드한 것과 같은지 (R-11)
  dir = mkEnv();
  r = build(dir);
  check('기본 출력은 dist/index.html', r.status === 0 && existsSync(join(dir, 'dist', 'index.html')), msg(r));
  r = build(dir, '--check');
  check('--check: 방금 빌드한 dist/index.html 과 같으면 종료 0', r.status === 0 && /똑같아요/.test(r.stdout), msg(r));
  edit(dir, 'js_main.html', t => t.replace('Loop.start();', 'Loop.start(); // 빌드 안 한 수정'));
  const before = readFileSync(join(dir, 'dist', 'index.html'), 'utf8');
  r = build(dir, '--check');
  check('--check: src 를 고치고 빌드를 안 했으면 종료 1 + npm run build 안내 + dist 는 건드리지 않음', r.status === 1 && /npm run build/.test(r.stderr) && /최신이 아니에요/.test(r.stderr) && readFileSync(join(dir, 'dist', 'index.html'), 'utf8') === before, msg(r));
  r = build(dir); r = build(dir, '--check');
  check('--check: 다시 빌드하면 통과', r.status === 0, msg(r));
  r = build(dir, '--check', '--out', 'dist/없는파일.html');
  check('--check: 파일이 없으면 종료 1 + npm run build 안내', r.status === 1 && /없어요/.test(r.stderr) && /npm run build/.test(r.stderr), msg(r));
  edit(dir, 'js_ui.html', t => t.replace(openTag, openTag + '\nconst Stage = 1;'));
  r = build(dir, '--check');
  check('--check: src 자체가 깨져 있으면 그 문제를 보여주고 종료 1', r.status === 1 && /'Stage'/.test(r.stderr), msg(r));
});

// =====================================================================
await section('tools/test-all.mjs', async () => {
  const dir = mkTmp('jd-testall-');
  mkdirSync(join(dir, 'tools', 'tests'), { recursive: true });
  copyFileSync(join(root, 'tools', 'test-all.mjs'), join(dir, 'tools', 'test-all.mjs'));
  const T = (name, body) => writeFileSync(join(dir, 'tools', 'tests', name), body);
  T('a.test.mjs', `console.log('PASS x'); console.log('\\n3/3 통과'); process.exit(0);`);
  T('b.slow.test.mjs', `console.log('slow ran'); console.log('\\n1/1 통과'); process.exit(0);`);
  T('c.test.mjs', `console.log('FAIL 뭔가 틀림'); console.log('\\n1/2 통과, 1 실패'); process.exit(1);`);
  T('d.test.mjs', `console.log('env=' + process.env.GAME_HTML); console.log('\\n2/2 통과'); process.exit(0);`);
  const run = (...a) => spawnSync(process.execPath, [join(dir, 'tools', 'test-all.mjs'), ...a], { encoding: 'utf8', env: { ...process.env, GAME_HTML: 'dist/_probe.html' }, cwd: dir });
  const all = run();
  check('test-all: 하나라도 실패하면 종료 코드 1, 표에 파일별 PASS/FAIL 과 통과/전체 수', all.status === 1 && /a\.test\.mjs\s+PASS\s+3\/3/.test(all.stdout) && /c\.test\.mjs\s+FAIL\s+1\/2/.test(all.stdout) && /b\.slow\.test\.mjs\s+PASS/.test(all.stdout), all.stdout.slice(-600));
  check('test-all: 실패한 테스트의 FAIL 줄을 보여줌 / 합계 줄', /FAIL 뭔가 틀림/.test(all.stdout) && /합계: 파일 3\/4 통과, 검사 7\/8/.test(all.stdout), all.stdout.slice(-400));
  const quick = run('--quick');
  check('test-all --quick: *.slow.test.mjs 는 건너뜀', !/b\.slow\.test\.mjs/.test(quick.stdout) && /a\.test\.mjs/.test(quick.stdout) && quick.status === 1);
  const filt = run('a.test', 'd.test');
  check('test-all: 이름 필터 + 모두 통과하면 종료 코드 0, GAME_HTML 이 자식에게 전달됨', filt.status === 0 && /모두 통과/.test(filt.stdout) && !/c\.test/.test(filt.stdout), filt.stdout.slice(-300));
  const verbose = run('d.test', '--verbose');
  check('test-all --verbose: 통과한 테스트의 출력도 보여주고 환경변수(GAME_HTML) 상속 확인', /env=dist\/_probe\.html/.test(verbose.stdout), verbose.stdout.slice(-300));
  const none = run('zzz_없는_파일');
  check('test-all: 실행할 파일이 없으면 종료 코드 1', none.status === 1 && /없어요/.test(none.stderr + none.stdout));
  const real = spawnSync(process.execPath, [join(root, 'tools', 'test-all.mjs'), '--quick', 'zzz_없는_파일'], { encoding: 'utf8' });
  check('test-all: 실제 tools/tests 폴더에서도 필터가 동작', real.status === 1);
});

// =====================================================================
await section('test-all / npm 스크립트: 커밋되는 dist/index.html 이 src 와 다르면 테스트 전에 실패 (R-11)', async () => {
  // 임시 저장소: tools/test-all.mjs + tools/build-local.mjs + src 복사본 + 통과하는 가짜 테스트 하나
  const dir = mkTmp('jd-dist-');
  mkdirSync(join(dir, 'tools', 'tests'), { recursive: true }); mkdirSync(join(dir, 'src'));
  for (const f of ['test-all.mjs', 'build-local.mjs']) copyFileSync(join(root, 'tools', f), join(dir, 'tools', f));
  for (const f of readdirSync(join(root, 'src'))) if (/\.html$/.test(f)) copyFileSync(join(root, 'src', f), join(dir, 'src', f));
  writeFileSync(join(dir, 'tools', 'tests', 'ok.test.mjs'), `console.log('PASS 가짜'); console.log('\\n1/1 통과'); process.exit(0);`);
  const run = (env, ...a) => spawnSync(process.execPath, [join(dir, 'tools', 'test-all.mjs'), ...a], { encoding: 'utf8', cwd: dir, env: { ...process.env, GAME_HTML: '', ...env } });
  const build = (...a) => spawnSync(process.execPath, [join(dir, 'tools', 'build-local.mjs'), ...a], { encoding: 'utf8', cwd: dir });
  const all = r => r.stdout + r.stderr;

  let r = run({});
  check('dist/index.html 이 아예 없으면 테스트를 돌리지 않고 종료 1 + npm run build 안내', r.status === 1 && /npm run build/.test(all(r)) && !/ok\.test\.mjs/.test(r.stdout), all(r).slice(-300));
  build();
  r = run({});
  check('방금 빌드한 dist/index.html 이면 확인 통과 → 테스트 실행 (종료 0)', r.status === 0 && /똑같아요/.test(r.stdout) && /ok\.test\.mjs\s+PASS/.test(r.stdout), all(r).slice(-300));
  const p = join(dir, 'src', 'js_main.html'); writeFileSync(p, readFileSync(p, 'utf8').replace('Loop.start();', 'Loop.start(); // 빌드 안 한 수정'));
  r = run({});
  check('src 만 고치고 빌드를 안 하면: 테스트 시작 전에 종료 1, "dist/index.html 이 src/ 와 달라" + npm run build 안내, 테스트 파일은 실행 안 함', r.status === 1 && /최신이 아니에요/.test(all(r)) && /npm run build/.test(all(r)) && !/ok\.test\.mjs\s+(PASS|FAIL)/.test(r.stdout), all(r).slice(-400));
  r = run({}, '--quick');
  check('--quick (npm run test:quick) 도 같은 확인을 함', r.status === 1 && /npm run build/.test(all(r)), all(r).slice(-200));
  r = run({}, 'ok');
  check('이름 필터를 줘도 확인함', r.status === 1 && /npm run build/.test(all(r)));
  r = run({ GAME_HTML: 'dist/_mine.html' });
  check('GAME_HTML 로 다른 빌드를 지정하면(개발 중 각자 빌드) 이 확인은 건너뜀', r.status === 0 && /ok\.test\.mjs\s+PASS/.test(r.stdout) && !/최신이 아니에요/.test(all(r)), all(r).slice(-200));
  r = run({}, '--no-dist-check');
  check('--no-dist-check 로 건너뛸 수 있음', r.status === 0 && /ok\.test\.mjs\s+PASS/.test(r.stdout));
  build();
  r = run({ GAME_HTML: 'dist/index.html' });
  check('GAME_HTML 이 dist/index.html 이면 그래도 확인함 (다시 빌드한 뒤라 통과)', r.status === 0 && /똑같아요/.test(r.stdout), all(r).slice(-200));

  // package.json: npm test / test:quick 은 test-all 을 직접 실행 (먼저 빌드하면 dist 를 덮어써서 확인이 의미가 없음), check:dist 가 따로 있음
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts;
  check('package.json: test = test-all (빌드로 dist 를 덮어쓰지 않음), test:quick = test-all --quick', pkg.test === 'node tools/test-all.mjs' && pkg['test:quick'] === 'node tools/test-all.mjs --quick', JSON.stringify(pkg));
  check('package.json: build 와 check:dist (= build-local --check) 스크립트가 있음', pkg.build === 'node tools/build-local.mjs' && pkg['check:dist'] === 'node tools/build-local.mjs --check', JSON.stringify(pkg));
});

// =====================================================================
check('테스트 전체에서 예상 밖의 페이지 오류(pageerror/console.error)가 없음', errors.length === 0, errors.slice(0, 5).join(' | '));
for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 무시 */ } }
await close();
finish('core');
