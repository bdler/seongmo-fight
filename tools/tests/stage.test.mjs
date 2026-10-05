// stage 모듈 테스트 (src/js_stage.html)
//   실행: node tools/build-local.mjs --out dist/_stage.html && GAME_HTML=dist/_stage.html node tools/tests/stage.test.mjs
//   SHOT_DIR=/어딘가 를 주면 방별 스크린샷을 그 폴더에 저장합니다 (저장소 안에는 쓰지 않아요).
//   STAGE_STANDIN=1 을 주면 진짜 Player/Enemies 대신 아주 작은 가짜(한 방에 죽는 적)를 끼워 넣고 같은 테스트를 돌려요.
//
// 진짜 Player / Enemies 모듈이 있으면 그대로 쓰고, 정말로 비어 있을 때만 가짜를 끼웁니다.
// 적은 Combat.damage 로 "한 방에" 처치해서 커널의 enemyKilled/bossKilled/playerDied 이벤트가 진짜처럼 흐르게 해요.
import { openGame, step } from '../lib/browser.mjs';
import { check, finish } from '../lib/check.mjs';
import { mkdirSync } from 'node:fs';

const SHOT_DIR = process.env.SHOT_DIR || '';
if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true });
const FORCE_STANDIN = !!process.env.STAGE_STANDIN;

const { page, errors, close } = await openGame();
const ev = (fn, arg) => page.evaluate(fn, arg);
const section = async (name, fn) => {            // 한 구역이 예외로 죽어도 나머지는 계속
  try { await fn(); } catch (e) { check(`[${name}] 구역이 예외 없이 끝남`, false, String((e && e.stack) || e).split('\n').slice(0, 3).join(' | ')); }
};
const shot = async name => {
  if (!SHOT_DIR) return;
  await ev(() => Loop.draw());
  await page.locator('#game').screenshot({ path: `${SHOT_DIR}/${name}.png` });
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------------
// 0. 페이지 안 도우미 (T) 설치. 필요하면 가짜 Player / Enemies 도 여기서.
// ---------------------------------------------------------------------------
const info = await ev(force => {
  const real = {
    player: typeof Player !== 'undefined' && typeof Player.create === 'function' && typeof Player.revive === 'function' && typeof Player.heal === 'function',
    enemies: typeof Enemies !== 'undefined' && typeof Enemies.spawn === 'function' && typeof Enemies.aliveCount === 'function' && typeof Enemies.clear === 'function',
  };
  if (!real.player || force) {
    Player.create = (x, y) => {
      const p = Entities.make({ kind: 'player', team: 'player', persistent: true, x, y, w: 40, h: 80, hp: 100, maxHp: 100, cheer: false,
        draw(ctx, e) { ctx.fillStyle = e.dead ? '#888' : '#4aa3ff'; ctx.fillRect(e.x - 20, e.y - e.z - 80, 40, 80); } });
      Entities.add(p); Game.player = p; return p;
    };
    Player.revive = (p, o) => { p = p || Game.player; p.hp = p.maxHp; p.dead = false; p.stun = 0; p.invuln = o && o.invuln !== undefined ? o.invuln : 120; Events.emit('playerRevived', p); };
    Player.heal = (p, n) => { p = p || Game.player; if (p.dead) return 0; const g = Math.max(0, Math.min(p.maxHp - p.hp, n)); p.hp += g; FX.popup(p.x, p.y - 100, '+' + g, {}); return g; };
  }
  if (!real.enemies || force) {
    const defs = { slime: [20, 100, 44, 40], soldier: [35, 200, 40, 78], cloud: [25, 200, 62, 46], jellyKing: [300, 3000, 130, 130] };
    Enemies.spawn = (type, x, y, opts) => {
      const d = defs[type]; if (!d) return null;
      const boss = type === 'jellyKing';
      const e = Entities.make({ kind: boss ? 'boss' : 'enemy', team: 'enemy', type, boss: boss ? true : undefined, x: clamp(x, d[2] / 2, Game.world.width - d[2] / 2), y: clamp(y, FLOOR_TOP, FLOOR_BOTTOM),
        w: d[2], h: d[3], hp: d[0], maxHp: d[0], score: d[1], untargetable: !!(opts && opts.drop && !boss), removeT: 10,
        draw(ctx, en) { ctx.fillStyle = '#e66'; ctx.fillRect(en.x - en.w / 2, en.y - en.z - en.h, en.w, en.h); } });
      if (opts && opts.drop) { e.fall = 30; e.update = en => { if (en.fall > 0 && --en.fall === 0) en.untargetable = false; }; }
      Entities.add(e);
      if (boss) { Game.boss = e; Events.emit('bossSpawned', e); }
      return e;
    };
    Enemies.aliveCount = () => Entities.list.filter(e => (e.kind === 'enemy' || e.kind === 'boss') && !e.dead && !e._removed).length;
    Enemies.clear = () => { for (const e of Entities.list.slice()) if (e.kind === 'enemy' || e.kind === 'boss') Entities.remove(e); Game.boss = null; };
    Events.on('bossKilled', () => { Game.boss = null; });
  }
  return { real, standin: !real.player || !real.enemies || force };
}, FORCE_STANDIN);
console.log(`모듈: Player ${info.real.player ? '진짜' : '없음'}, Enemies ${info.real.enemies ? '진짜' : '없음'}${info.standin ? '  → 가짜를 끼워 넣음' : ''}`);

await ev(() => {
  const T = window.T = {};
  T.events = []; T.sfx = []; T.txt = []; T.spawns = []; T.pickups = []; T.upd = { n: 0, fx: 0, combo: 0, order: [] };
  ['roomStarted', 'roomCleared', 'stageCleared', 'gameOver', 'pickup', 'playerRevived', 'bossSpawned', 'sceneChanged'].forEach(n =>
    Events.on(n, d => T.events.push({ n, index: d && d.index, type: d && d.type, d })));
  const so = SFX.play; SFX.play = function (n, o) { T.sfx.push(n); return so.call(SFX, n, o); };
  const dt = Draw.text; Draw.text = function (ctx, s, ...r) { T.txt.push(String(s)); return dt.call(Draw, ctx, s, ...r); };
  const sp = Enemies.spawn; Enemies.spawn = function (type, x, y, opts) { const e = sp.call(Enemies, type, x, y, opts); T.spawns.push({ type, x, y, opts, camX: Cam.x, id: e && e.id, f: Game.frame }); return e; };
  const ea = Entities.add; Entities.add = function (e) { if (e && e.kind === 'pickup') T.pickups.push(e.type); return ea.call(Entities, e); };
  // play 씬 update 한 번마다 FX.update / tickCombo 가 몇 번 불리는지, 순서는 어떤지
  const pu = Scenes.play.update; Scenes.play.update = function () { T.upd.n++; return pu.call(Scenes.play); };
  const fu = FX.update; FX.update = function () { T.upd.fx++; T.upd.order.push('fx'); return fu.call(FX); };
  const tc = Game.tickCombo; Game.tickCombo = function () { T.upd.combo++; T.upd.order.push('combo'); return tc.call(Game); };

  T.foes = () => Entities.list.filter(e => (e.kind === 'enemy' || e.kind === 'boss') && !e.dead && !e._removed);
  T.pk = () => Entities.list.filter(e => e.kind === 'pickup' && !e._removed);
  T.hit = (e, dmg) => Combat.damage(e, dmg === undefined ? 99999 : dmg, { owner: Game.player, team: 'player', sfx: null, freeze: 0 });
  T.killAll = () => { for (const e of T.foes()) T.hit(e); };
  // 조건이 될 때까지 한 프레임씩 진행 (싸움 중이면 적을 바로 처치). 돌려주는 값: 걸린 프레임, 못 되면 -1, 씬이 바뀌면 -2
  T.run = (pred, max = 3000, kill = true) => {
    for (let i = 0; i < max; i++) {
      if (pred()) return i;
      if (Game.scene !== 'play') return -2;
      if (kill && Stage.state === 'fight') T.killAll();
      Loop.step(1);
    }
    return pred() ? max : -1;
  };
  T.clearRoom = () => T.run(() => Stage.state === 'clear');
  T.exitRoom = () => { Game.player.x = Game.world.width - 20; return T.run(() => Stage.state === 'intro', 200, false); };
  T.toRoom = i => { while (Stage.roomIndex < i && Game.scene === 'play') { if (T.clearRoom() < 0) return false; if (T.exitRoom() < 0) return false; } return Stage.roomIndex === i; };
  T.last = () => STAGES[0].rooms.length - 1;                // 보스방(마지막 방) 번호 — 방 수를 하드코딩하지 않음
  T.toBossFight = () => { if (!T.toRoom(T.last())) return false; return T.run(() => Stage.state === 'fight' && !!Game.boss && !Game.boss.untargetable, 600, false) >= 0; };
  T.die = () => { const p = Game.player; p.invuln = 0; const g = Debug.god; Debug.god = false; const r = Combat.damage(p, 99999, { team: 'enemy', sfx: null, freeze: 0 }); Debug.god = g; return r; };
  T.fresh = (diff = 'normal', seed = 1, extra = {}) => {
    T.events.length = 0; T.sfx.length = 0; T.txt.length = 0; T.spawns.length = 0; T.pickups.length = 0;
    T.upd = { n: 0, fx: 0, combo: 0, order: [] };
    RNG.seed(seed); Debug.god = true; Debug.noVariance = true;
    Game.touch = false;
    Stage.start(Object.assign({ difficulty: diff, nickname: '시험' }, extra));
  };
  T.ctx = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c.getContext('2d'); };
  T.overlayTexts = () => { T.txt.length = 0; Stage.drawOverlay(T.ctx()); return T.txt.slice(); };
  T.snap = () => ({
    stage: Stage.snapshot(),
    ents: Entities.list.map(e => e.kind + (e.type ? ':' + e.type : '')).sort(),
    fx: [FX.particles.length, FX.popups.length, FX.hitstop, Math.round(FX.flashAlpha * 100)],
    game: { scene: Game.scene, paused: Game.paused, diff: Game.difficulty, score: Game.score, kills: Game.kills, deaths: Game.deaths, lives: String(Game.lives), frame: Game.frame,
      combo: Game.combo.count + '/' + Game.combo.max, boss: !!Game.boss, w: Game.world.width, stage: Object.assign({}, Game.stage), result: Game.result, player: !!Game.player },
    cam: Cam.x,
  });
});
const call = (fn, arg) => ev(fn, arg);
const snapOf = () => ev(() => Stage.snapshot());
const NEWGAME = (diff = 'normal', seed = 1, extra) => ev(a => T.fresh(a[0], a[1], a[2]), [diff, seed, extra]);

// ===========================================================================
// 1. 데이터: STAGES 표
// ===========================================================================
await section('데이터', async () => {
  const d = await ev(() => JSON.parse(JSON.stringify(STAGES)));
  check('STAGES[0] 은 사탕 숲 (id stage1, theme candy)', d.length >= 1 && d[0].id === 'stage1' && d[0].name === '사탕 숲' && d[0].theme === 'candy');
  const rooms = d[0].rooms;
  check('방이 7개 (평범한 방 6 + 보스방)', rooms.length === 7);
  check('방 이름이 표와 같음', eq(rooms.map(r => r.name), ['숲 입구', '달콤한 오솔길', '초콜릿 시냇가', '솜사탕 언덕', '젤리 동굴 입구', '반짝 수정 동굴', '젤리 대왕의 방']));
  check('방 너비 960/1920×5/960', eq(rooms.map(r => r.width), [960, 1920, 1920, 1920, 1920, 1920, 960]));
  const w = r => r.waves.map(wv => wv.map(g => `${g.type}x${g.count}`).join('+'));
  check('방1 웨이브: 슬라임3 → 슬라임4', eq(w(rooms[0]), ['slimex3', 'slimex4']));
  check('방2 웨이브: 슬라임4 → 슬라임3+병정1 → 슬라임2+병정2', eq(w(rooms[1]), ['slimex4', 'slimex3+soldierx1', 'slimex2+soldierx2']));
  check('방3 웨이브: 병정2+슬라임3 → 구름2+슬라임3 → 병정2+구름1+슬라임2', eq(w(rooms[2]), ['soldierx2+slimex3', 'cloudx2+slimex3', 'soldierx2+cloudx1+slimex2']));
  check('방4 웨이브: 슬라임4+구름1 → 병정3+슬라임2 → 구름2+병정2+슬라임2', eq(w(rooms[3]), ['slimex4+cloudx1', 'soldierx3+slimex2', 'cloudx2+soldierx2+slimex2']));
  check('방5 웨이브: 구름1+병정2+슬라임2 → 슬라임3+병정2+구름1 → 병정3+구름2+슬라임2', eq(w(rooms[4]), ['cloudx1+soldierx2+slimex2', 'slimex3+soldierx2+cloudx1', 'soldierx3+cloudx2+slimex2']));
  check('방6 웨이브: 병정2+구름2+슬라임3 → 슬라임4+병정3+구름2 → 병정3+구름2+슬라임3', eq(w(rooms[5]), ['soldierx2+cloudx2+slimex3', 'slimex4+soldierx3+cloudx2', 'soldierx3+cloudx2+slimex3']));
  const total = rooms.reduce((n, r) => n + r.waves.reduce((m, wv) => m + wv.reduce((k, g) => k + g.count, 0), 0), 0);
  check('방에 나오는 적은 모두 92마리 (보스·소환수 제외)', total === 92, String(total));
  check('보상: 보스방을 뺀 모든 방이 사탕 (6번)', eq(rooms.map(r => r.reward || null), ['candy', 'candy', 'candy', 'candy', 'candy', 'candy', null]));
  check('보스방만 boss:true, 웨이브 없음', eq(rooms.map(r => !!r.boss), [false, false, false, false, false, false, true]) && rooms[6].waves.length === 0);
  check('방 1 에만 튜토리얼', eq(rooms.map(r => !!r.tutorial), [true, false, false, false, false, false, false]));
  check('큰 방(1920) 은 웨이브가 3개씩, 방 1 은 2개', rooms.slice(1, 6).every(r => r.waves.length === 3) && rooms[0].waves.length === 2);
  const looks = await ev(() => Object.keys(STAGE_TUNE.looks));
  check('모든 방의 look 이 STAGE_TUNE.looks 에 있음', rooms.every(r => looks.includes(r.look)), rooms.map(r => r.look).join(','));
  check('룩: 솜사탕 언덕은 숲, 젤리 동굴 입구는 동굴, 반짝 수정 동굴은 수정 룩', rooms[3].look === 'forest' && rooms[4].look === 'cave' && rooms[5].look === 'crystal' && rooms[6].look === 'boss', rooms.map(r => r.look).join(','));
  check('한 번에 6마리 상한 / 드롭 15%·35% / 코인 +50 / 사탕 +40', await ev(() => STAGE_TUNE.maxOnScreen === 6 && STAGE_TUNE.drop.candy === 0.15 && STAGE_TUNE.drop.coin === 0.35 && STAGE_TUNE.pickup.coinScore === 50 && STAGE_TUNE.pickup.candyHeal === 40));
});

// ===========================================================================
// 2. 별점 계산
// ===========================================================================
await section('별점', async () => {
  const r = await ev(() => {
    const c = (cleared, deaths) => Stage.calcStars({ cleared, deaths });
    return { d0: c(true, 0), d1: c(true, 1), d2: c(true, 2), d3: c(true, 3), d9: c(true, 9), go0: c(false, 0), go5: c(false, 5), noDeaths: Stage.calcStars({ cleared: true }), none: Stage.calcStars(), detached: (0, Stage.calcStars)({ cleared: true, deaths: 0 }) };
  });
  check('무사망 클리어 = 별 3', r.d0 === 3);
  check('1번 쓰러지고 클리어 = 별 2', r.d1 === 2);
  check('2번 쓰러지고 클리어 = 별 2 (경계)', r.d2 === 2);
  check('3번 이상 쓰러지고 클리어 = 별 1 (경계)', r.d3 === 1 && r.d9 === 1);
  check('게임 오버는 쓰러진 횟수와 상관없이 별 0', r.go0 === 0 && r.go5 === 0);
  check('deaths 를 안 주면 0번으로, 인자가 없어도 안 죽고 0개', r.noDeaths === 3 && r.none === 0);
  check('this 없이 따로 불러도 동작', r.detached === 3);
});

// ===========================================================================
// 3. Stage.start 와 방 1 의 흐름 (intro → fight)
// ===========================================================================
await section('시작과 intro', async () => {
  await NEWGAME('hard', 3, { nickname: '용사' });
  const s = await ev(() => {
    const p = Game.player;
    return { state: Stage.state, ri: Stage.roomIndex, wi: Stage.waveIndex, scene: Game.scene, w: Game.world.width, stage: Object.assign({}, Game.stage), diff: Game.difficulty, lives: Game.lives,
      nick: Game.nickname, px: p && p.x, py: p && p.y, kind: p && p.kind, isPlayer: Game.player === Entities.list.find(e => e.kind === 'player'), boss: Game.boss, result: Game.result, foes: T.foes().length, paused: Game.paused };
  });
  check('start 직후: play 씬 / intro / 방 0 / 웨이브 -1', s.scene === 'play' && s.state === 'intro' && s.ri === 0 && s.wi === -1);
  check('난이도·닉네임이 Game 에 반영 (hard → 목숨 1)', s.diff === 'hard' && s.nick === '용사' && s.lives === 1);
  check('주인공이 만들어져 Game.player 로 등록, 왼쪽에서 시작', s.isPlayer && s.kind === 'player' && s.px === 60 && s.py === 420, `x=${s.px} y=${s.py}`);
  check('방 너비 960, Game.stage 가 HUD 용으로 채워짐', s.w === 960 && eq(s.stage, { id: 'stage1', name: '사탕 숲', roomIndex: 0, roomCount: 7, roomName: '숲 입구' }), JSON.stringify(s.stage));
  check('보스 없음, 결과 null, 적 없음', s.boss === null && s.result === null && s.foes === 0);
  const ev0 = await ev(() => T.events.filter(e => e.n === 'roomStarted').map(e => e.index));
  check("'roomStarted' 가 방 0 으로 한 번", eq(ev0, [0]), JSON.stringify(ev0));

  // intro 길이: 정확히 introFrames(90) 프레임, 그 동안 적이 안 나옴
  await step(page, 89);
  let q = await snapOf();
  check('intro 89프레임째까지는 intro 이고 적이 없음', q.state === 'intro' && q.foes === 0 && q.waveIndex === -1, JSON.stringify(q));
  await step(page, 1);
  q = await snapOf();
  check('intro 90프레임째에 fight 로 넘어가고 웨이브 0 시작 (슬라임 3마리 대기열)', q.state === 'fight' && q.waveIndex === 0 && q.queue === 3, JSON.stringify(q));
  const intro = await ev(() => STAGE_TUNE.introFrames);
  check('intro 길이 = 숫자표(90프레임, 1.5초)', intro === 90);

  // 방 이름 배너: intro 동안 방 이름이 그려지고, fight 가 되면 안 그려짐
  await NEWGAME('normal', 3);
  await step(page, 30);
  const t1 = await ev(() => T.overlayTexts());
  check('intro 중 오버레이에 방 이름과 "1 / 7" 이 그려짐 (방 수는 데이터에서)', t1.includes('숲 입구') && t1.some(s => s.includes('1 / 7')) && t1.some(s => s.includes('사탕 숲')), JSON.stringify(t1));
  await step(page, 70);
  const t2 = await ev(() => T.overlayTexts());
  check('fight 에서는 방 이름 배너가 사라짐 (부정)', !t2.includes('숲 입구'), JSON.stringify(t2));

  // 잘못된 인자
  await ev(() => { RNG.seed(1); Stage.start({ difficulty: 'nope', stageIndex: 99, nickname: 'x' }); });
  const bad = await ev(() => ({ d: Game.difficulty, id: Game.stage.id, st: Stage.state }));
  check('이상한 난이도/스테이지 번호도 안전 (직전 난이도 유지, 마지막 스테이지로 보정)', bad.d === 'normal' && bad.id === 'stage1' && bad.st === 'intro', JSON.stringify(bad));
  await ev(() => { Stage.start(); });
  check('인자 없이 Stage.start() 도 안 죽음', (await snapOf()).state === 'intro');
});

// ===========================================================================
// 4. 웨이브 순서: 2웨이브는 1웨이브를 다 잡은 뒤에만
// ===========================================================================
await section('웨이브', async () => {
  await NEWGAME('normal', 4);
  await step(page, 90 + 200);                             // 싸움 시작 + 아무도 안 잡고 한참 기다림
  let q = await snapOf();
  const spawned1 = await ev(() => T.spawns.length);
  check('웨이브 1 을 안 잡으면 웨이브 2 는 안 나옴 (슬라임 3마리뿐)', q.waveIndex === 0 && spawned1 === 3 && q.foes === 3 && q.queue === 0, JSON.stringify(q) + ' spawned=' + spawned1);
  const types1 = await ev(() => T.spawns.map(s => s.type));
  check('웨이브 1 은 슬라임 3마리', eq(types1, ['slime', 'slime', 'slime']));
  const drop = await ev(() => T.spawns.every(s => s.opts && s.opts.drop === true));
  check('좁은 방(960)은 위에서 떨어지며 등장 (drop:true)', drop);
  check('웨이브 적은 모두 hunt:true (거리와 상관없이 처음부터 플레이어를 쫓음)', await ev(() => T.spawns.every(s => s.opts && s.opts.hunt === true)));
  const xs = await ev(() => T.spawns.map(s => s.x));
  check('떨어지는 위치는 화면 안 (110~850)', xs.every(x => x >= 110 && x <= 850), JSON.stringify(xs));

  // 한 마리만 잡고 한참 기다려도 (한 마리가 남아 있으니) 다음 웨이브는 안 나옴 (부정)
  await ev(() => { T.run(() => T.foes().length === 3 && T.foes().every(e => !e.untargetable), 200, false); T.hit(T.foes()[0]); Game.player.invuln = 99999; });
  await step(page, 150);
  q = await snapOf();
  check('3마리 중 1마리만 잡고 150프레임이 지나도 웨이브 2 가 안 나옴 (부정)', q.waveIndex === 0 && q.foes === 2 && (await ev(() => T.spawns.length)) === 3, JSON.stringify(q));

  // 웨이브 1 처치 → waveGap 동안은 아무것도 안 나옴 → 웨이브 2
  await ev(() => { T.run(() => T.foes().every(e => !e.untargetable), 200, false); T.killAll(); });
  q = await snapOf();
  check('웨이브 1 을 다 잡은 직후: 아직 웨이브 0, 새 적 없음', q.waveIndex === 0 && q.foes === 0 && q.state === 'fight', JSON.stringify(q));
  const gap = await ev(() => STAGE_TUNE.waveGap);
  await step(page, gap - 2);
  q = await snapOf();
  check(`숨 돌리는 ${gap - 1}프레임 동안엔 다음 웨이브가 안 나옴 (부정)`, q.waveIndex === 0 && (await ev(() => T.spawns.length)) === 3, JSON.stringify(q));
  await step(page, 3);
  q = await snapOf();
  check('웨이브 갭 뒤에 웨이브 2 가 시작됨 (waveIndex 1, 슬라임 4마리 대기열)', q.waveIndex === 1 && q.queue >= 3 && q.state === 'fight', JSON.stringify(q));
  check("'다음 물결!' 안내가 뜸", (await snapOf()).banner === '다음 물결!');
  await step(page, 200);
  const types2 = await ev(() => T.spawns.map(s => s.type));
  check('웨이브 2 까지 슬라임 7마리 (3 + 4)', eq(types2, ['slime', 'slime', 'slime', 'slime', 'slime', 'slime', 'slime']), JSON.stringify(types2));
  await shot('r1_fight_wave2');

  // 방 2 의 두 번째 웨이브에는 병정이 섞임 (슬라임·병정 번갈아)
  await ev(() => { T.toRoom(1); T.spawns.length = 0; });
  await ev(() => { T.run(() => Stage.state === 'fight' && Stage.waveIndex === 1 && T.spawns.length >= 8, 1500); });
  const t3 = await ev(() => T.spawns.map(s => s.type));
  check('방 2: 웨이브1 슬라임4 → 웨이브2 슬라임3+병정1 (종류를 번갈아 내보냄)', eq(t3.slice(0, 4), ['slime', 'slime', 'slime', 'slime']) && eq(t3.slice(4, 8), ['slime', 'soldier', 'slime', 'slime']), JSON.stringify(t3));
});

// ===========================================================================
// 5. 소환 위치 / 6마리 상한
// ===========================================================================
await section('소환과 상한', async () => {
  // 넓은 방: 화면 오른쪽 바깥에서 걸어 들어옴
  await NEWGAME('normal', 5);
  await ev(() => { T.toRoom(1); T.spawns.length = 0; });
  await ev(() => { T.run(() => T.spawns.length >= 3, 600, false); });
  const sp = await ev(() => T.spawns.slice());
  check('넓은 방은 drop 없이 화면 오른쪽 바깥(Cam.x+W+40 이상)에서 들어옴', sp.length >= 3 && sp.every(s => !(s.opts && s.opts.drop) && s.x >= s.camX + 960 + 40 - 0.01), JSON.stringify(sp.map(s => [Math.round(s.x), Math.round(s.camX)])));
  check('넓은 방의 웨이브 적도 hunt:true (GP-3: aggroRange 밖에서 멍하니 서 있지 않음)', sp.every(s => s.opts && s.opts.hunt === true));
  check('소환 y 는 바닥 띠 안', sp.every(s => s.y >= 330 && s.y <= 500));

  // 6마리 상한: 12마리 웨이브를 가진 시험용 방을 잠깐 끼워 넣음
  await ev(() => {
    STAGES.push({ id: 'test', name: '시험', theme: 'candy', rooms: [
      { name: '많은 방', width: 960, look: 'forest', waves: [[{ type: 'slime', count: 12 }]], reward: null, boss: false },
      { name: '끝', width: 960, look: 'forest', waves: [], reward: null, boss: false },
    ] });
  });
  const ti = await ev(() => STAGES.length - 1);
  await ev(i => T.fresh('normal', 6, { stageIndex: i }), ti);
  await step(page, 90);
  let maxAlive = 0, maxQueue = 0;
  for (let i = 0; i < 40; i++) {
    await step(page, 10);
    const q = await snapOf(); maxAlive = Math.max(maxAlive, q.foes); maxQueue = Math.max(maxQueue, q.queue);
  }
  let q = await snapOf();
  check('아무도 안 잡으면 화면의 적은 정확히 6마리에서 멈춤 (상한)', maxAlive === 6 && q.foes === 6, `max=${maxAlive} now=${q.foes}`);
  check('나머지 6마리는 대기열에서 줄 서 있음', q.queue === 6 && (await ev(() => T.spawns.length)) === 6, JSON.stringify(q));
  check('아직 클리어가 아님 (대기열이 남음)', q.state === 'fight');
  await ev(() => { T.run(() => T.foes().every(e => !e.untargetable), 200, false); const f = T.foes()[0]; T.hit(f); });
  await step(page, 25);
  q = await snapOf();
  check('한 마리를 잡으면 대기열에서 한 마리가 채워져 다시 6마리', q.foes === 6 && q.queue === 5, JSON.stringify(q));
  // 계속 잡으면 12마리 모두 나오고 방이 클리어됨. 그 동안 6마리를 넘은 적이 없어야 함
  const res = await ev(() => {
    let over = 0, max = 0;
    for (let i = 0; i < 4000 && Stage.state === 'fight'; i++) {
      const a = Enemies.aliveCount(); max = Math.max(max, a); if (a > 6) over++;
      if (i % 25 === 0) { const t = T.foes().find(e => !e.untargetable); if (t) T.hit(t); }
      Loop.step(1);
    }
    return { over, max, spawned: T.spawns.length, state: Stage.state };
  });
  check('총 12마리가 모두 소환되고 한 번도 6마리를 넘지 않음', res.spawned === 12 && res.over === 0 && res.max === 6, JSON.stringify(res));
  check('다 잡자 방이 clear 로', res.state === 'clear');
  await ev(() => STAGES.pop());
  check('시험용 방을 치웠음', (await ev(() => STAGES.length)) === ti);
});

// ===========================================================================
// 5-2. 데이터를 바꿔도 동작: 마지막 방이 보스방이 아니어도 / 보스방이 중간에 있어도
// ===========================================================================
await section('데이터 구동', async () => {
  await ev(() => {
    STAGES.push({ id: 'tA', name: '짧은 숲', theme: 'candy', rooms: [
      { name: '하나', width: 960, look: 'forest', waves: [[{ type: 'slime', count: 1 }]], reward: null, boss: false },
      { name: '둘', width: 960, look: 'path', waves: [[{ type: 'slime', count: 1 }]], reward: null, boss: false },
    ] });
    STAGES.push({ id: 'tB', name: '중간 보스', theme: 'candy', rooms: [
      { name: '보스 먼저', width: 960, look: 'boss', waves: [], reward: null, boss: true, bossType: 'jellyKing' },
      { name: '그 다음', width: 960, look: 'forest', waves: [[{ type: 'slime', count: 1 }]], reward: null, boss: false },
    ] });
  });
  const n = await ev(() => STAGES.length);
  // (A) 마지막 방(보스 아님)을 깨면 clear 가 아니라 곧바로 스테이지 클리어
  await ev(i => T.fresh('normal', 60, { stageIndex: i }), n - 2);
  check('시험 스테이지 A: 이름/방 수가 Game.stage 에 반영', eq(await ev(() => Game.stage), { id: 'tA', name: '짧은 숲', roomIndex: 0, roomCount: 2, roomName: '하나' }));
  await ev(() => { T.clearRoom(); });
  check('A: 첫 방은 보통 clear (GO)', (await snapOf()).state === 'clear');
  await ev(() => { T.exitRoom(); });
  const seen = await ev(() => { const st = new Set(); for (let i = 0; i < 400 && Stage.state !== 'victory'; i++) { if (Stage.state === 'fight') T.killAll(); Loop.step(1); st.add(Stage.state); } return [...st]; });
  check('A: 마지막 방을 깨면 clear 를 거치지 않고 victory (그 방에서 또 전환하지 않음)', (await snapOf()).state === 'victory' && !seen.includes('clear') && !seen.includes('transition'), JSON.stringify(seen));
  await step(page, 185);
  const ra = await ev(() => Game.result);
  check('A: 결과 cleared:true, 방 2개, stageId tA', ra && ra.cleared && ra.rooms === 2 && ra.stageId === 'tA' && ra.stageName === '짧은 숲' && ra.stars === 3, JSON.stringify(ra));
  // (B) 보스방이 맨 앞: 보스를 잡으면 승리가 아니라 방 클리어 → 다음 방 → 마지막 방에서 승리
  await ev(i => T.fresh('normal', 61, { stageIndex: i }), n - 1);
  await ev(() => { T.run(() => !!Game.boss && !Game.boss.untargetable, 400, false); T.hit(Game.boss); });
  let q = await snapOf();
  check('B: 중간에 있는 보스를 잡으면 victory 가 아니라 clear', q.state === 'clear' && q.roomsCleared === 1 && (await ev(() => Game.boss)) === null, JSON.stringify(q));
  check('B: 보스방이어도 clear 에서는 GO 화살표가 그려짐', await ev(() => { const c = T.ctx(); T.txt.length = 0; for (let i = 0; i < 20; i++) { Loop.step(1); Stage.drawOverlay(c); } return T.txt.includes('GO!'); }));
  await ev(() => { T.exitRoom(); T.clearRoom(); });
  check('B: 다음(마지막) 방을 깨면 스테이지 클리어', (await snapOf()).state === 'victory');
  await ev(() => { STAGES.pop(); STAGES.pop(); });
  check('시험 스테이지를 치웠음', (await ev(() => STAGES.length)) === n - 2);
});

// ===========================================================================
// 6. 클리어 → GO → 못 나감 → 나감 → 전환
// ===========================================================================
await section('클리어와 전환', async () => {
  await NEWGAME('normal', 7);
  await ev(() => { const p = Game.player; p.x = 945; });
  await step(page, 95 + 40);                              // fight 중 오른쪽 끝에 서 보기
  let q = await snapOf();
  check('클리어 전에는 오른쪽 끝에 서도 안 넘어감 (부정)', q.state === 'fight' && q.roomIndex === 0, JSON.stringify(q));
  check('오른쪽 끝에서 "먼저 친구들을 물리쳐요!" 안내', await ev(() => FX.popups.some(p => p.text.includes('먼저'))));
  check('아직 방이 안 깨졌으니 roomCleared 이벤트 없음', (await ev(() => T.events.filter(e => e.n === 'roomCleared').length)) === 0);
  await ev(() => { Game.player.x = 200; T.sfx.length = 0; Game.score = 0; });
  const f = await ev(() => T.clearRoom());
  check('다 잡으면 clear 상태가 됨', f >= 0 && (await snapOf()).state === 'clear', 'frames=' + f);
  const evs = await ev(() => T.events.filter(e => e.n === 'roomCleared').map(e => e.index));
  check("'roomCleared' 방 0 으로 정확히 한 번", eq(evs, [0]), JSON.stringify(evs));
  check('클리어 효과음 go 가 한 번 울림', (await ev(() => T.sfx.filter(n => n === 'go').length)) === 1);
  check('"방 클리어!" 안내가 뜸', (await snapOf()).banner === '방 클리어!');
  await shot('r1_clear_go');
  const txt = await ev(() => { Stage.snapshot(); T.txt.length = 0; const c = T.ctx(); for (let i = 0; i < 44; i++) { Loop.step(1); Stage.drawOverlay(c); } return T.txt.filter(s => s === 'GO!').length; });
  check('GO 화살표가 깜빡임: 44프레임 중 일부만 그려짐 (전부도 0도 아님)', txt > 10 && txt < 44, 'GO 그린 프레임 ' + txt + '/44');

  const calm = await ev(() => { FX.reduceMotion = true; let n = 0; const c = T.ctx(); T.txt.length = 0; for (let i = 0; i < 44; i++) { Loop.step(1); Stage.drawOverlay(c); } n = T.txt.filter(s => s === 'GO!').length; FX.reduceMotion = false; return n; });
  check("'움직임 줄이기'를 켜면 GO 화살표가 깜빡이지 않고 계속 보임 (44프레임 모두)", calm === 44, String(calm));
  await ev(() => { Game.player.x = 200; });
  await step(page, 10);

  // clear 인데 오른쪽 끝이 아니면 머무름
  await ev(() => { Game.player.x = 300; });
  await step(page, 60);
  q = await snapOf();
  check('clear 에서 오른쪽 끝이 아니면 계속 clear (부정)', q.state === 'clear' && q.roomIndex === 0, JSON.stringify(q));
  // 나가기: 전환 중 월드가 멈추고, 중간에 방이 바뀜
  await ev(() => { Game.player.x = Game.world.width - 20; Input.press('ArrowRight'); });
  await step(page, 1);
  q = await snapOf();
  check('오른쪽 끝에 닿으면 transition', q.state === 'transition' && q.roomIndex === 0, JSON.stringify(q));
  await step(page, 15);
  const mid = await ev(() => ({ x: Game.player.x, w: Game.world.width, ri: Stage.roomIndex, st: Stage.state }));
  check('페이드 아웃 동안엔 월드가 멈춤 (오른쪽 키를 눌러도 안 움직임)', mid.x >= 939 && mid.st === 'transition' && mid.w === 960 && mid.ri === 0, JSON.stringify(mid));
  await step(page, 6);
  const sw = await ev(() => ({ x: Game.player.x, w: Game.world.width, ri: Stage.roomIndex, st: Stage.state, cam: Cam.x, name: Game.stage.roomName, rn: Game.stage.roomIndex, pk: T.pk().length, foes: T.foes().length, wi: Stage.waveIndex }));
  check('화면이 까매진 순간 방이 바뀜: 너비 1920, 주인공 x=60, 카메라 0', sw.w === 1920 && sw.x === 60 && sw.cam === 0 && sw.ri === 1, JSON.stringify(sw));
  check('Game.stage 가 새 방 이름/번호로 갱신', sw.name === '달콤한 오솔길' && sw.rn === 1);
  check('새 방에는 적/픽업/웨이브가 남아 있지 않음', sw.pk === 0 && sw.foes === 0 && sw.wi === -1);
  await step(page, 25);
  q = await snapOf();
  check('전환(40프레임)이 끝나면 새 방의 intro', q.state === 'intro' && q.roomIndex === 1, JSON.stringify(q));
  await ev(() => Input.release('ArrowRight'));
  const ro = await ev(() => T.events.filter(e => e.n === 'roomStarted').map(e => e.index));
  check("'roomStarted' 가 0, 1 순서로", eq(ro, [0, 1]), JSON.stringify(ro));
  const fade = await ev(() => { const c = T.ctx(); Game.player.x = 60; return null; });
  await shot('r2_intro');

  // 방을 넘어갈 때 카메라/픽업 정리: 방 2(넓음)에서 멀리 간 뒤 클리어하고 나가면 카메라가 0 으로 돌아옴
  await ev(() => { T.run(() => Stage.state === 'fight', 200, false); Game.player.x = 1500; Loop.step(120); });
  const cam1 = await ev(() => Cam.x);
  check('넓은 방에서 주인공을 따라 카메라가 움직임 (0 < Cam.x <= 960)', cam1 > 300 && cam1 <= 960, 'cam=' + cam1);
  await ev(() => { T.clearRoom(); Stage.dropPickup(Game.player.x + 50, 420, 'coin'); T.exitRoom(); });
  const after = await ev(() => ({ cam: Cam.x, x: Game.player.x, pk: T.pk().length, ri: Stage.roomIndex }));
  check('방 3 으로 넘어가면 카메라 0, 주인공 x=60, 바닥의 픽업은 치워짐', after.ri === 2 && after.cam === 0 && after.x === 60 && after.pk === 0, JSON.stringify(after));
  const rewards = await ev(() => T.pickups.slice());
  check('방 2 를 깨자 보상 사탕이 나왔음 (방 2 reward: candy)', rewards.includes('candy'), JSON.stringify(rewards));
});

// ===========================================================================
// 7. 방마다 너비 / 이벤트 / Game.stage 가 최신
// ===========================================================================
await section('방 순회', async () => {
  await NEWGAME('normal', 8);
  const n = await ev(() => STAGES[0].rooms.length);
  const seen = [];
  for (let i = 0; i < n; i++) {
    const ok = await ev(i => T.toRoom(i), i);
    seen.push(await ev(() => ({ i: Stage.roomIndex, w: Game.world.width, gs: Object.assign({}, Game.stage), state: Stage.state })));
    if (!ok) break;
  }
  check(`방 0~${n - 1} 에 차례로 도착 (방 수 ${n})`, n === 7 && seen.length === n && seen.every((s, i) => s.i === i), JSON.stringify(seen.map(s => s.i)));
  check('도착할 때마다 Game.world.width = 방 너비 (960/1920×5/960)', eq(seen.map(s => s.w), [960, 1920, 1920, 1920, 1920, 1920, 960]));
  check('Game.stage.roomIndex/roomCount/roomName 이 항상 최신 (roomCount = 방 수)', seen.every((s, i) => s.gs.roomIndex === i && s.gs.roomCount === n && s.gs.id === 'stage1') &&
    eq(seen.map(s => s.gs.roomName), ['숲 입구', '달콤한 오솔길', '초콜릿 시냇가', '솜사탕 언덕', '젤리 동굴 입구', '반짝 수정 동굴', '젤리 대왕의 방']));
  const cl = await ev(() => T.events.filter(e => e.n === 'roomCleared').map(e => e.index));
  check("보스방 앞까지 'roomCleared' 가 0..n-2 순서로 (보스방은 아직)", eq(cl, [0, 1, 2, 3, 4, 5]), JSON.stringify(cl));
  const rs = await ev(() => T.events.filter(e => e.n === 'roomStarted').map(e => e.index));
  check("'roomStarted' 0~n-1", eq(rs, [0, 1, 2, 3, 4, 5, 6]));
  check('스테이지가 끝나기 전엔 결과가 없음', (await ev(() => Game.result)) === null);
});

// ===========================================================================
// 8. 보스방: 경고 → 등장 → 사탕 → 승리 → 결과
// ===========================================================================
await section('보스와 승리', async () => {
  await NEWGAME('normal', 9);
  await ev(() => { T.toRoom(T.last() - 1); T.clearRoom(); T.sfx.length = 0; T.exitRoom(); T.spawns.length = 0; });
  let q = await snapOf();
  check('보스방 intro 에서 시작 (마지막 방)', q.state === 'intro' && q.roomIndex === 6 && !q.bossSpawned, JSON.stringify(q));
  check('보스방 입장 때 경고음 warn', await ev(() => T.sfx.includes('warn')));
  check('보스 음악으로 바뀜', (await ev(() => Music.current)) === 'boss');
  await step(page, 10);
  const wt = await ev(() => T.overlayTexts());
  check('경고 배너 "보스 등장!" + "젤리 대왕이 나타났다!"', wt.includes('보스 등장!') && wt.includes('젤리 대왕이 나타났다!') && wt.includes('젤리 대왕의 방'), JSON.stringify(wt));
  await shot('r5_boss_warning');
  const spawnAt = await ev(() => STAGE_TUNE.bossSpawnAt);
  await step(page, spawnAt - 10 - 1);
  check('보스는 경고가 시작된 뒤 바로가 아니라 70프레임째에 나타남 (그 전엔 없음)', !(await snapOf()).bossSpawned && !(await ev(() => Game.boss)));
  await step(page, 1);
  q = await snapOf();
  check('70프레임째: 보스가 위에서 떨어지며 등장, Game.boss 설정, bossSpawned 이벤트', q.bossSpawned && await ev(() => !!Game.boss && Game.boss.type === 'jellyKing' && T.events.some(e => e.n === 'bossSpawned')));
  const bx = await ev(() => Game.boss.x);
  check('보스는 주인공의 반대쪽(오른쪽)에 떨어짐', bx >= 560, 'x=' + bx);
  await step(page, 60);
  q = await snapOf();
  check('경고가 끝나기 전(130프레임째)에는 아직 intro', q.state === 'intro', JSON.stringify(q));
  await step(page, 20);
  q = await snapOf();
  check('150프레임째에 fight', q.state === 'fight' && q.waveIndex === -1 && q.queue === 0, JSON.stringify(q));
  check('보스방은 웨이브가 없어 졸개를 소환하지 않음', (await ev(() => T.spawns.filter(s => s.type !== 'jellyKing').length)) === 0);
  await ev(() => T.run(() => !!Game.boss && !Game.boss.untargetable, 200, false));
  await shot('r5_boss_fight');
  const noClear = await snapOf();
  check('보스가 살아 있는 동안은 clear/승리가 아님', noClear.state === 'fight' && noClear.roomsCleared === 6);
  const candy0 = await ev(() => T.pk().length);
  // 체력 절반 이하 → 사탕 한 개 (한 번만)
  await ev(() => { const b = Game.boss; T.hit(b, b.hp * 0.45); });
  await step(page, 2);
  check('보스 체력이 55% 일 때는 사탕이 없음 (부정)', (await ev(() => T.pk().length)) === candy0);
  await ev(() => { const b = Game.boss; T.hit(b, b.maxHp * 0.1); });
  await step(page, 2);
  let cands = await ev(() => T.pickups.filter(t => t === 'candy').length);
  check('보스 체력이 45% 로 내려가자 사탕이 나옴', (await ev(() => T.pk().length)) === candy0 + 1 && cands >= 1, 'pickups=' + (await ev(() => T.pk().length)));
  const cn = cands;
  await ev(() => { const b = Game.boss; T.hit(b, b.maxHp * 0.1); });
  await step(page, 5);
  check('사탕은 한 번만 (더 때려도 또 안 나옴)', (await ev(() => T.pickups.filter(t => t === 'candy').length)) === cn);

  // 쓰러뜨리기 → victory
  await ev(() => { Game.combo.count = 0; Game.score = 0; T.hit(Game.boss); });
  q = await snapOf();
  check('보스를 쓰러뜨린 순간 victory 상태', q.state === 'victory' && q.roomsCleared === 7, JSON.stringify(q));
  check('플레이어가 만세 포즈 (cheer)', await ev(() => Game.player.cheer === true));
  check('흰 번쩍임 연출', (await ev(() => FX.flashAlpha)) > 0);
  check('보스 음악이 멈춤', (await ev(() => Music.current)) === null);
  check('결과는 아직 없고 씬은 play', (await ev(() => Game.result)) === null && (await ev(() => Game.scene)) === 'play');
  const dropsAfter = await ev(() => T.pickups.length);
  await step(page, 25);
  const vt0 = await ev(() => T.overlayTexts());
  check('승리 직후 25프레임까지는 CLEAR! 글자가 아직 없음 (부정)', !vt0.includes('C') && !vt0.includes('스테이지 클리어!'), JSON.stringify(vt0));
  await step(page, 7);
  const vt = await ev(() => T.overlayTexts());
  check('승리 30프레임 뒤부터 CLEAR! 글자가 하나씩 튀어나옴 (처음엔 C 만, 아직 전부는 아님)', vt.includes('C') && !vt.includes('!') && !vt.includes('스테이지 클리어!'), JSON.stringify(vt));
  await step(page, 35);
  const vt2 = await ev(() => T.overlayTexts());
  check('이어서 "스테이지 클리어!" 와 CLEAR! 전체가 보임', 'CLEAR!'.split('').every(ch => vt2.includes(ch)) && vt2.includes('스테이지 클리어!'), JSON.stringify(vt2));
  await shot('r5_victory');
  // 슬로모션: 승리 처음 80프레임엔 월드가 두 프레임에 한 번만 움직임
  await NEWGAME('normal', 9);
  await ev(() => { T.toBossFight(); window.__n = 0; const e = Entities.make({ kind: 'fx', team: 'neutral', shadow: false, clampWorld: false, untargetable: true, update() { window.__n++; } }); Entities.add(e); });
  await step(page, 20);
  const nBefore = await ev(() => { const a = window.__n; Loop.step(40); return window.__n - a; });
  await ev(() => { T.hit(Game.boss); });
  const nSlow = await ev(() => { const a = window.__n; Loop.step(40); return window.__n - a; });
  check('평소엔 40프레임에 40번 갱신, 승리 슬로모션엔 약 절반(20번)', nBefore === 40 && nSlow >= 18 && nSlow <= 22, `평소 ${nBefore}, 슬로모 ${nSlow}`);
  const tcount = await ev(() => { T.upd = { n: 0, fx: 0, combo: 0, order: [] }; Loop.step(10); return T.upd; });
  check('슬로모션 중에도 tickCombo 는 업데이트마다 정확히 1번 (FX.update 는 일부 건너뜀)', tcount.combo === tcount.n && tcount.n === 10 && tcount.fx < tcount.n, JSON.stringify({ n: tcount.n, fx: tcount.fx, combo: tcount.combo }));

  // 결과로 넘어가는 시점: 승리 180프레임째
  await NEWGAME('normal', 9);
  await ev(() => { T.toBossFight(); T.hit(Game.boss); });
  const tot = await ev(() => STAGE_TUNE.victory.total);
  await step(page, tot - 1);
  check('승리 179프레임째까지는 아직 play 씬', (await ev(() => Game.scene)) === 'play' && (await ev(() => Game.result)) === null);
  await step(page, 1);
  const r = await ev(() => ({ scene: Game.scene, res: Game.result, st: Stage.state, evs: T.events.filter(e => e.n === 'stageCleared').length, go: T.events.filter(e => e.n === 'gameOver').length, same: T.events.find(e => e.n === 'stageCleared')?.d === Game.result, active: Stage.snapshot().active, frame: Game.frame, kills: Game.kills, score: Game.score, combo: Game.combo.max }));
  check('180프레임째에 result 씬으로 전환, stageCleared 이벤트 한 번(게임오버 아님)', r.scene === 'result' && r.evs === 1 && r.go === 0 && r.same, JSON.stringify({ scene: r.scene, evs: r.evs, go: r.go }));
  const keys = Object.keys(r.res || {}).sort();
  check('Game.result 모양: 계약서의 키 11개 그대로', eq(keys, ['cleared', 'deaths', 'difficulty', 'kills', 'maxCombo', 'rooms', 'score', 'stageId', 'stageName', 'stars', 'timeFrames']), keys.join(','));
  const x = r.res;
  check('결과 값: cleared / 별 3 / 사망 0 / 방 7 / 난이도·스테이지 / 점수·처치·콤보가 Game 과 같음',
    x.cleared === true && x.stars === 3 && x.deaths === 0 && x.rooms === 7 && x.difficulty === 'normal' && x.stageId === 'stage1' && x.stageName === '사탕 숲' &&
    x.score === r.score && x.kills === r.kills && x.maxCombo === r.combo && x.kills >= 12, JSON.stringify(x));
  check('timeFrames 는 양수이고 진행 프레임과 비슷', x.timeFrames > 600 && x.timeFrames <= r.frame, `timeFrames=${x.timeFrames} Game.frame=${r.frame}`);
  check('결과 값은 모두 숫자/문자/불리언 (서버로 보낼 수 있음)', Object.values(x).every(v => ['number', 'string', 'boolean'].includes(typeof v)));
  check('런이 끝나 Stage 가 더 이상 진행하지 않음 (active=false)', r.active === false && r.st === 'victory');
  const after = await ev(() => { const s0 = Game.score; Loop.step(30); return Game.score === s0 && Game.scene === 'result'; });
  check('결과 씬에서 계속 step 해도 안전 (점수 불변)', after);
});

// ===========================================================================
// 9. 점수: 콤보 배율 + 보너스
// ===========================================================================
await section('점수', async () => {
  await NEWGAME('normal', 10);
  await step(page, 5);
  const one = await ev(() => {
    const r = {};
    const kill = (type, combo) => { Game.combo.count = combo; const e = Enemies.spawn(type, 400, 420); const s0 = Game.score; T.hit(e); return Game.score - s0; };
    r.slime0 = kill('slime', 0);          // 맞는 순간 콤보 +1 → 배율 1.02
    r.slime10 = kill('slime', 10);        // 11 → 1.22
    r.soldier = kill('soldier', 4);       // 5 → 1.10
    r.cloud = kill('cloud', 4);
    r.cap = kill('slime', 40);            // 41 → 상한 30 → 1.6
    r.cap2 = kill('slime', 29);           // 30 → 1.6
    return r;
  });
  check('슬라임 100점, 콤보 1 → ×1.02 = 102', one.slime0 === 102, String(one.slime0));
  check('콤보 11 → ×1.22 = 122 (콤보가 높을수록 점수가 커짐)', one.slime10 === 122, String(one.slime10));
  check('병정 200점, 콤보 5 → ×1.10 = 220', one.soldier === 220, String(one.soldier));
  check('구름 200점, 콤보 5 → ×1.10 = 220', one.cloud === 220, String(one.cloud));
  check('콤보 배율 상한: 콤보 41/30 모두 ×1.6 = 160 (부정: 그 이상은 안 커짐)', one.cap === 160 && one.cap2 === 160, `${one.cap}, ${one.cap2}`);
  // 이미 죽은 적은 점수가 또 안 들어감 (부정)
  const twice = await ev(() => { const e = Enemies.spawn('slime', 400, 420); T.hit(e); const s0 = Game.score; const r = Combat.damage(e, 99, { team: 'player' }); return { r, d: Game.score - s0 }; });
  check('이미 쓰러진 적을 또 때려도 점수 없음', twice.r === 0 && twice.d === 0);

  // 방 클리어 +300 (다음 프레임에), 보스 처치 후 보너스
  await NEWGAME('normal', 10);
  await ev(() => { T.run(() => Stage.state === 'fight' && Stage.waveIndex === 1 && T.spawns.length === 7, 1500, true); });
  const sc = await ev(() => {
    T.run(() => Stage.state === 'fight' && T.spawns.length === 7 && T.foes().length > 0, 600, false);
    T.run(() => T.foes().every(e => !e.untargetable), 200, false);
    Game.combo.count = 0;
    const foes = T.foes(); let pre = Game.score; for (const e of foes) T.hit(e);
    const killScore = Game.score - pre;
    const before = Game.score; Loop.step(1);
    return { killScore, clearBonus: Game.score - before, state: Stage.state, n: foes.length };
  });
  check('방 클리어 보너스 +300 (마지막 적을 잡은 다음 프레임)', sc.state === 'clear' && sc.clearBonus === 300, JSON.stringify(sc));

  await NEWGAME('normal', 10);
  await ev(() => { T.toBossFight(); });
  const bonus = await ev(() => { Game.combo.count = 0; Game.deaths = 0; const b = Game.boss; const s0 = Game.score; T.hit(b); return Game.score - s0; });
  const mult = 1 + 1 * 0.02;
  check('보스 처치(3000×1.02) + 방 클리어 300 + 스테이지 클리어 1000 + 무사망 500', bonus === Math.round(3000 * mult) + 300 + 1000 + 500, `delta=${bonus} expect=${Math.round(3000 * mult) + 1800}`);
  await NEWGAME('normal', 10);
  await ev(() => { T.toBossFight(); });
  const bonus2 = await ev(() => { Game.combo.count = 0; Game.deaths = 1; const b = Game.boss; const s0 = Game.score; T.hit(b); return Game.score - s0; });
  check('한 번이라도 쓰러졌으면 무사망 보너스 500 이 빠짐 (부정)', bonus2 === Math.round(3000 * mult) + 300 + 1000, `delta=${bonus2}`);
  const noDrop = await ev(() => {
    for (const p of T.pk()) Entities.remove(p);
    const n0 = T.pickups.length;
    for (let i = 0; i < 200; i++) Events.emit('enemyKilled', { boss: true, score: 0, x: 400, y: 420 });
    const boss = T.pickups.length - n0, n1 = T.pickups.length;
    for (let i = 0; i < 200; i++) Events.emit('enemyKilled', { score: 0, x: 400, y: 420 });
    return { boss, normal: T.pickups.length - n1 };
  });
  check('보스는 아이템을 떨어뜨리지 않음 (200번 해도 0개), 일반 적은 약 절반이 떨어뜨림 (비교용)', noDrop.boss === 0 && noDrop.normal > 60, JSON.stringify(noDrop));
});

// ===========================================================================
// 10. 드롭 (시드 난수) / 11. 픽업
// ===========================================================================
await section('드롭', async () => {
  const run = seed => ev(seed => {
    T.fresh('normal', seed);
    T.pickups.length = 0;
    const types = [];
    for (let i = 0; i < 600; i++) {
      const e = Enemies.spawn('slime', 400, 420); const n0 = T.pickups.length; T.hit(e);
      types.push(T.pickups.length > n0 ? T.pickups[T.pickups.length - 1][0] : '-');   // c(andy) / c(oin) 구분용 첫 글자 → 아래에서 바꿈
      for (const p of T.pk()) Entities.remove(p);
    }
    return T.pickups.slice();
  }, seed);
  const a = await run(11), b = await run(11), c = await run(12);
  const rate = (arr, t) => arr.filter(x => x === t).length / 600;
  check('같은 시드면 드롭이 똑같음 (재현 가능)', eq(a, b), `${a.length}개`);
  check('시드가 다르면 드롭이 달라짐', !eq(a, c));
  check('코인 확률 ≈ 35% (±6%p)', Math.abs(rate(a, 'coin') - 0.35) < 0.06, (rate(a, 'coin') * 100).toFixed(1) + '%');
  check('사탕 확률 ≈ 15% (±5%p)', Math.abs(rate(a, 'candy') - 0.15) < 0.05, (rate(a, 'candy') * 100).toFixed(1) + '%');
  check('한 마리에서 두 개가 나오지 않음 (전체 드롭 ≤ 처치 수)', a.length <= 600 && a.length > 150, `드롭 ${a.length}/600`);
  // 드롭은 연출용 난수(RNG.fx)가 아니라 게임 난수만 씀: 연출이 달라도 드롭은 같음
  const d1 = await ev(() => { T.fresh('normal', 21); FX.burst(100, 100, { kind: 'star', count: 50 }); RNG.fx(); RNG.fx(); const o = []; for (let i = 0; i < 80; i++) { const e = Enemies.spawn('slime', 400, 420); const n0 = T.pickups.length; T.hit(e); o.push(T.pickups.length - n0); } return o; });
  const d2 = await ev(() => { T.fresh('normal', 21); const o = []; for (let i = 0; i < 80; i++) { const e = Enemies.spawn('slime', 400, 420); const n0 = T.pickups.length; T.hit(e); o.push(T.pickups.length - n0); } return o; });
  check('연출용 난수가 달라도 드롭 순서는 같음 (게임 난수와 분리)', eq(d1, d2));
});

await section('픽업', async () => {
  await NEWGAME('normal', 12);
  await step(page, 3);
  const e0 = await ev(() => { const p = Game.player; const e = Stage.dropPickup(p.x + 300, 430, 'candy'); return { kind: e.kind, team: e.team, type: e.type, neutral: e.team === 'neutral', inList: Entities.list.includes(e), life: e.life, z: e.z }; });
  check('dropPickup: kind pickup / team neutral / candy, 목록에 들어감', e0.kind === 'pickup' && e0.team === 'neutral' && e0.type === 'candy' && e0.inList);
  check('알 수 없는 종류는 코인으로', await ev(() => Stage.dropPickup(300, 400, 'banana').type === 'coin'));
  await ev(() => { for (const p of T.pk()) Entities.remove(p); });

  // 둥실둥실
  const bob = await ev(() => { const e = Stage.dropPickup(700, 440, 'coin'); const zs = []; for (let i = 0; i < 90; i++) { Loop.step(1); zs.push(e.z); } const late = zs.slice(30); return { min: Math.min(...late), max: Math.max(...late), first: zs[10] }; });
  check('픽업이 둥실둥실 떠다님 (z 가 변하고 땅에 안 박힘)', bob.max - bob.min > 4 && bob.min > 10, JSON.stringify(bob));
  await ev(() => { for (const p of T.pk()) Entities.remove(p); });

  // 사탕: HP +40, 상한 100
  const heal = await ev(() => {
    const p = Game.player; p.hp = 50; T.events.length = 0; p.x = 400; p.y = 420;
    const e = Stage.dropPickup(p.x + 10, p.y + 5, 'candy'); Loop.step(14);
    const r1 = { hp: p.hp, gone: !Entities.list.includes(e), evs: T.events.filter(x => x.n === 'pickup').map(x => x.type) };
    p.hp = 95; const e2 = Stage.dropPickup(p.x, p.y, 'candy'); Loop.step(14);
    return { r1, hp2: p.hp, gone2: !Entities.list.includes(e2), max: p.maxHp };
  });
  check('사탕을 주우면 HP +40 (50 → 90), 사라지고 pickup 이벤트', heal.r1.hp === 90 && heal.r1.gone && eq(heal.r1.evs, ['candy']), JSON.stringify(heal.r1));
  check('HP 95 에서 사탕을 주워도 maxHp(100) 를 넘지 않음', heal.hp2 === heal.max && heal.gone2, 'hp=' + heal.hp2);
  // 코인: 점수 +50
  const coin = await ev(() => { const p = Game.player; p.x = 400; p.y = 420; const s0 = Game.score; const e = Stage.dropPickup(p.x - 12, p.y, 'coin'); Loop.step(14); return { d: Game.score - s0, gone: !Entities.list.includes(e), popup: FX.popups.some(q => q.text === '+50') }; });
  check('코인을 주우면 점수 +50 과 +50 팝업', coin.d === 50 && coin.gone && coin.popup, JSON.stringify(coin));
  // 거리 조건 (부정)
  const far = await ev(() => {
    const p = Game.player; p.x = 400; p.y = 420; const s0 = Game.score;
    const a = Stage.dropPickup(p.x + 100, p.y, 'coin');         // 가로로 멀다 (≥36)
    const b = Stage.dropPickup(p.x, p.y + 60, 'coin');          // 깊이가 다르다 (≥30)
    const c = Stage.dropPickup(p.x - 100, p.y - 60, 'coin');
    Loop.step(20);
    return { a: Entities.list.includes(a), b: Entities.list.includes(b), c: Entities.list.includes(c), d: Game.score - s0 };
  });
  check('가로 100 / 깊이 60 떨어진 픽업은 못 줍는다 (부정)', far.a && far.b && far.c && far.d === 0, JSON.stringify(far));
  await ev(() => { for (const p of T.pk()) Entities.remove(p); });
  const edge = await ev(() => {
    const p = Game.player; p.x = 400; p.y = 420; const s0 = Game.score;
    const a = Stage.dropPickup(p.x + 20, p.y + 20, 'coin'); a.kx = 0;     // 가로 20, 깊이 20: 안쪽
    Loop.step(14); return { got: !Entities.list.includes(a), d: Game.score - s0 };
  });
  check('가로 20 / 깊이 20 (|dx|<36, |dy|<30 안쪽)은 주움', edge.got && edge.d === 50);
  // 떨어진 직후엔 바로 안 주워짐 (톡 튀는 모습 보이게), 쓰러진 주인공은 못 줍는다
  const delay = await ev(() => { const p = Game.player; p.x = 400; p.y = 420; const e = Stage.dropPickup(p.x, p.y, 'coin'); Loop.step(4); const early = Entities.list.includes(e); Loop.step(10); return { early, late: !Entities.list.includes(e) }; });
  check('떨어지고 4프레임엔 아직 바닥에 있고, 10프레임 뒤엔 주워짐', delay.early && delay.late, JSON.stringify(delay));
  const dead = await ev(() => { const p = Game.player; p.x = 400; p.y = 420; T.die(); const e = Stage.dropPickup(p.x, p.y, 'coin'); e.kx = 0; const s0 = Game.score; Loop.step(30); const r = { still: Entities.list.includes(e), d: Game.score - s0, st: Stage.state }; return r; });
  check('쓰러진 주인공은 픽업을 못 줍는다 (부정)', dead.still && dead.d === 0 && dead.st === 'dead', JSON.stringify(dead));
  await NEWGAME('normal', 12);

  // 사라짐: 수명이 다하면 사라지고, 그 전에 깜빡임 경고
  const life = await ev(() => {
    const p = Game.player; p.x = 100; p.y = 420;
    const e = Stage.dropPickup(800, 440, 'candy'); e.kx = 0;
    const mkctx = () => { const calls = { n: 0 }; const ctx = new Proxy({}, { get: (t, k) => (k === 'canvas' ? null : (k in t ? t[k] : (...a) => { calls.n++; })), set: (t, k, v) => { t[k] = v; return true; } }); return { ctx, calls }; };
    const drawn = age => { e.age = age; const { ctx, calls } = mkctx(); e.draw(ctx, e); return calls.n > 0; };
    const blink = STAGE_TUNE.pickup.blink, L = e.life;
    const early = [0, 5, 6, 7, 8, 9, 10, 11, 12, 20].map(k => drawn(L - blink - 5 - k));      // 경고 구간 전: 항상 보임
    const warn = []; for (let k = 0; k < 60; k++) warn.push(drawn(L - blink + 1 + k));              // 경고 구간: 켜졌다 꺼졌다
    const last = []; for (let k = 0; k < 40; k++) last.push(drawn(L - 50 + k));                     // 마지막 구간: 더 자주
    const toggles = a => a.reduce((n, v, i) => n + (i && v !== a[i - 1] ? 1 : 0), 0);
    e.age = 0;
    return { early: early.every(Boolean), warnOn: warn.filter(Boolean).length, warnOff: warn.filter(v => !v).length, toggles: toggles(warn), lastToggles: toggles(last), L, blink };
  });
  check('수명 15초(900f) 중 마지막 150프레임에 깜빡임 경고, 그 전엔 계속 보임', life.L === 900 && life.blink === 150 && life.early && life.warnOn > 10 && life.warnOff > 10, JSON.stringify(life));
  check('깜빡임이 마지막에 더 빨라짐 (초당 3번 이하라 눈이 편함)', life.lastToggles >= life.toggles * 0.5 && life.toggles <= 14, JSON.stringify({ t: life.toggles, last: life.lastToggles }));
  const expire = await ev(() => {
    Game.player.hp = 50;                                                  // (체력이 가득이면 사탕 수명이 멈추므로 다친 상태에서)
    const e = T.pk()[0]; e.age = e.life - 3; const before = Entities.list.includes(e); Loop.step(2); const mid = Entities.list.includes(e); Loop.step(3); return { before, mid, after: Entities.list.includes(e) };
  });
  check('수명이 다하면 바닥에서 사라짐 (직전엔 남아 있음)', expire.before && expire.mid && !expire.after, JSON.stringify(expire));
  const coinLife = await ev(() => Stage.dropPickup(200, 400, 'coin').life);
  check('코인은 사탕보다 일찍 사라짐 (600f)', coinLife === 600);
  const capd = await ev(() => { for (const p of T.pk()) Entities.remove(p); const made = []; for (let i = 0; i < 30; i++) made.push(Stage.dropPickup(100 + i * 25, 400, 'coin')); return { n: T.pk().length, oldestGone: !Entities.list.includes(made[0]), newestStays: Entities.list.includes(made[29]) }; });
  check('바닥의 픽업은 최대 14개 (넘치면 오래된 것부터 사라짐)', capd.n === 14 && capd.oldestGone && capd.newestStays, JSON.stringify(capd));
  await shot('pickups');
  await ev(() => { for (const p of T.pk()) Entities.remove(p); });
  await ev(() => { const p = Game.player; p.x = 300; p.y = 430; Stage.dropPickup(380, 420, 'candy'); Stage.dropPickup(450, 450, 'coin'); Stage.dropPickup(520, 400, 'coin'); Loop.step(25); });
  await shot('pickups2');
});

// ===========================================================================
// 12. 죽음 · 부활 · 게임 오버 (난이도별)
// ===========================================================================
await section('보통 난이도 죽음', async () => {
  await NEWGAME('normal', 13);
  await step(page, 95);                                    // fight 시작
  await ev(() => { T.run(() => T.spawns.length === 1, 200, false); });   // 첫 슬라임만 나온 순간 (나머지 두 마리는 대기열에 남음)
  check('정상: 목숨 3개로 시작', (await ev(() => Game.lives)) === 3);
  check('(준비) 대기열에 두 마리가 남은 채로 쓰러질 것', (await snapOf()).queue === 2);
  await ev(() => { Game.score = 1000; T.die(); });
  let q = await snapOf();
  const g1 = await ev(() => ({ deaths: Game.deaths, lives: Game.lives, dead: Game.player.dead, state: Stage.state, hp: Game.player.hp }));
  check('쓰러지면 dead 상태, 사망 +1, 목숨 3 → 2', q.state === 'dead' && g1.deaths === 1 && g1.lives === 2 && g1.dead, JSON.stringify(g1));
  const sp0 = await ev(() => T.spawns.length);
  await step(page, 89);
  q = await snapOf();
  check('쓰러진 뒤 89프레임까지는 아직 dead (부활 전, 부정)', q.state === 'dead' && (await ev(() => Game.player.dead)), JSON.stringify(q));
  await step(page, 1);
  const rv = await ev(() => ({ state: Stage.state, dead: Game.player.dead, hp: Game.player.hp, max: Game.player.maxHp, score: Game.score, lives: Game.lives, rev: T.events.filter(e => e.n === 'playerRevived').length, scene: Game.scene, inv: Game.player.invuln }));
  check('90프레임째 그 자리에서 부활: 체력 가득, 원래 상태(fight)로, playerRevived 이벤트', !rv.dead && rv.hp === rv.max && rv.state === 'fight' && rv.rev === 1, JSON.stringify(rv));
  check('보통 난이도는 부활해도 점수가 안 깎임 (penalty 0)', rv.score === 1000 && rv.lives === 2);
  check('부활 직후 무적 시간이 있음', rv.inv > 60, 'invuln=' + rv.inv);
  check('쓰러진 동안엔 새 적이 소환되지 않음 (대기열 일시정지, 부정)', sp0 === 1 && (await ev(() => T.spawns.length)) === 1);
  await step(page, 25);
  check('부활한 뒤에는 대기열이 이어져 두 번째 슬라임이 나옴', (await ev(() => T.spawns.length)) === 2);
  await shot('dead_then_revived');
  // 두 번째, 세 번째
  await ev(() => { T.die(); });
  await step(page, 90);
  const g2 = await ev(() => ({ deaths: Game.deaths, lives: Game.lives, state: Stage.state, scene: Game.scene }));
  check('두 번째 쓰러짐: 목숨 1, 다시 부활', g2.deaths === 2 && g2.lives === 1 && g2.state === 'fight' && g2.scene === 'play', JSON.stringify(g2));
  await ev(() => { T.die(); });
  await step(page, 40);
  await shot('dead_last');
  const lastTxt = await ev(() => T.overlayTexts());
  check('마지막 목숨이 다하면 격려 문구가 뜸', lastTxt.includes('모두 힘껏 싸웠어요!'), JSON.stringify(lastTxt));
  await step(page, 49);
  check('세 번째 쓰러진 뒤 89프레임까지는 아직 play (게임오버 전)', (await ev(() => Game.scene)) === 'play');
  await step(page, 1);
  const go = await ev(() => ({ scene: Game.scene, res: Game.result, st: Stage.state, evs: T.events.filter(e => e.n === 'gameOver').length, same: T.events.find(e => e.n === 'gameOver')?.d === Game.result, clearedEv: T.events.filter(e => e.n === 'stageCleared').length, lives: Game.lives, music: Music.current }));
  check('목숨 3개를 다 쓰면 게임 오버: result 씬, gameOver 이벤트 1번 (stageCleared 없음)', go.scene === 'result' && go.evs === 1 && go.same && go.clearedEv === 0 && go.st === 'over', JSON.stringify(go));
  check('게임 오버 결과: cleared:false, 별 0, 사망 3, 방 0, 점수/처치 반영', go.res && go.res.cleared === false && go.res.stars === 0 && go.res.deaths === 3 && go.res.rooms === 0 && go.res.score === 1000 && go.res.stageId === 'stage1' && go.res.difficulty === 'normal', JSON.stringify(go.res));
  check('게임오버 때 목숨 0, 판 음악(stage/boss)이 멈춤 (결과 화면이 다른 곡을 틀 수는 있음)', go.lives === 0 && go.music !== 'stage' && go.music !== 'boss', JSON.stringify({ lives: go.lives, music: go.music }));
  const keys = Object.keys(go.res || {}).sort();
  check('게임오버 결과도 같은 11개 키', eq(keys, ['cleared', 'deaths', 'difficulty', 'kills', 'maxCombo', 'rooms', 'score', 'stageId', 'stageName', 'stars', 'timeFrames']));
  // 결과 씬 이후에 늦게 온 playerDied 는 무시 (부정)
  const late = await ev(() => { Events.emit('playerDied', Game.player); Events.emit('enemyKilled', { score: 100, type: 'slime', x: 1, y: 400 }); Loop.step(5); return { d: Game.deaths, s: Game.score, r: Game.result.deaths }; });
  check('런이 끝난 뒤 늦게 도착한 playerDied/enemyKilled 는 무시', late.d === 3 && late.s === 1000 && late.r === 3, JSON.stringify(late));
});

await section('쉬움 난이도 죽음', async () => {
  await NEWGAME('easy', 14);
  check('쉬움: 목숨 무한', (await ev(() => Game.lives)) === Infinity);
  await step(page, 95);
  let score = 1000;
  for (let i = 1; i <= 5; i++) {
    await ev(s => { Game.score = s; T.die(); }, score);
    await step(page, 90);
    const r = await ev(() => ({ dead: Game.player.dead, lives: Game.lives, score: Game.score, deaths: Game.deaths, scene: Game.scene, state: Stage.state }));
    const expect = score - Math.round(score * 0.1);
    check(`쉬움 ${i}번째 쓰러짐: 부활, 목숨 ∞ 그대로, 점수 10% 감점 (${score} → ${expect})`, !r.dead && r.lives === Infinity && r.score === expect && r.deaths === i && r.scene === 'play' && r.state === 'fight', JSON.stringify(r));
    score = r.score;
  }
  check('쉬움은 게임 오버가 없음 (5번 쓰러져도 play 씬)', (await ev(() => Game.scene)) === 'play');
  await ev(() => { T.die(); });
  await step(page, 40);
  const t = await ev(() => T.overlayTexts());
  check('쓰러졌을 때 쉬움 전용 격려 문구', t.includes('괜찮아요! 다시 일어나요!') && t.includes('점수가 조금 줄어요'), JSON.stringify(t));
  await step(page, 50);
  // 점수가 0 일 땐 감점이 없고 음수가 되지 않음
  await ev(() => { Game.score = 0; T.die(); });
  await step(page, 90);
  check('점수 0 에서 쓰러져도 점수가 음수가 되지 않음', (await ev(() => Game.score)) === 0);
  // 쉬움으로 끝까지 클리어하면 사망 횟수에 따라 별 1개
  await ev(() => { T.toBossFight(); T.hit(Game.boss); Loop.step(STAGE_TUNE.victory.total); });
  const res = await ev(() => Game.result);
  check('쉬움: 7번 쓰러지고 클리어하면 cleared:true, 별 1, 사망 7', res && res.cleared === true && res.stars === 1 && res.deaths === 7, JSON.stringify(res));
});

await section('어려움 난이도 죽음', async () => {
  await NEWGAME('hard', 15);
  check('어려움: 목숨 1개', (await ev(() => Game.lives)) === 1);
  await step(page, 95);
  await ev(() => { T.die(); });
  check('어려움: 쓰러지면 목숨 0 (바로 dead)', (await ev(() => ({ l: Game.lives, s: Stage.state }))).l === 0);
  await step(page, 89);
  check('게임 오버 직전(89프레임)까지는 play', (await ev(() => Game.scene)) === 'play');
  await step(page, 1);
  const r = await ev(() => ({ scene: Game.scene, res: Game.result, rev: T.events.filter(e => e.n === 'playerRevived').length }));
  check('어려움: 첫 번째 쓰러짐에 곧바로 게임 오버 (부활 없음)', r.scene === 'result' && r.res.cleared === false && r.res.stars === 0 && r.res.deaths === 1 && r.rev === 0, JSON.stringify(r));
});

await section('죽음 예외 상황', async () => {
  // clear 상태에서 쓰러져도 부활하면 clear 로 돌아감
  await NEWGAME('normal', 16);
  await ev(() => { T.clearRoom(); T.die(); });
  check('clear 에서 쓰러지면 dead', (await snapOf()).state === 'dead');
  await step(page, 90);
  check('부활하면 clear 로 돌아와서 GO 가 다시 보임', (await snapOf()).state === 'clear');
  // intro 에서도 마찬가지, 타이머가 이어짐
  await NEWGAME('normal', 16);
  await step(page, 20);
  await ev(() => { T.die(); });
  await step(page, 90);
  const q = await snapOf();
  check('intro 에서 쓰러졌다 부활하면 intro 타이머가 이어짐 (t 가 20 근처)', q.state === 'intro' && q.t === 20, JSON.stringify(q));
  // 쓰러진 상태에서 playerDied 가 또 와도 사망 중복 집계 없음 (부정)
  await NEWGAME('normal', 16);
  await ev(() => { T.die(); Events.emit('playerDied', Game.player); Events.emit('playerDied', Game.player); });
  check('이미 dead 일 때 playerDied 가 또 와도 사망 1번만 집계', (await ev(() => Game.deaths)) === 1);
  // 승리 중에는 playerDied 를 무시
  await NEWGAME('normal', 16);
  await ev(() => { T.toBossFight(); T.hit(Game.boss); Events.emit('playerDied', Game.player); });
  check('승리 중 playerDied 는 무시 (사망·상태 불변)', (await ev(() => Game.deaths)) === 0 && (await snapOf()).state === 'victory');
  // 보스와 동시에 쓰러져도 승리가 이김
  await NEWGAME('normal', 16);
  await ev(() => { T.toBossFight(); T.die(); });
  check('보스전 중 쓰러져 dead 인 상태', (await snapOf()).state === 'dead');
  await ev(() => { T.hit(Game.boss); });
  const w = await ev(() => ({ st: Stage.state, dead: Game.player.dead, cheer: Game.player.cheer }));
  check('쓰러진 중에 보스가 쓰러져도 승리 (주인공도 일으켜 만세)', w.st === 'victory' && !w.dead && w.cheer, JSON.stringify(w));
  await step(page, 190);
  const res = await ev(() => Game.result);
  check('이때 결과: cleared:true, 사망 1 → 별 2', res && res.cleared && res.deaths === 1 && res.stars === 2, JSON.stringify(res));
});

// ===========================================================================
// 13. 일시정지 · tickCombo · 씬 enter
// ===========================================================================
await section('일시정지와 콤보', async () => {
  await NEWGAME('normal', 17);
  await step(page, 120);
  await ev(() => { Game.pause(true); });
  const a = await ev(() => T.snap());
  await step(page, 200);
  const b = await ev(() => T.snap());
  check('일시정지 중에는 200프레임을 step 해도 아무것도 안 변함 (상태/적/좌표)', eq(a, b));
  const pe = await ev(() => { const e = T.foes()[0]; return e ? [e.x, e.y] : null; });
  await ev(() => { Game.pause(false); });
  await step(page, 30);
  const c = await ev(() => T.snap());
  check('해제하면 다시 진행됨', c.stage.t !== a.stage.t || c.game.frame !== a.game.frame);

  // tickCombo: 업데이트마다 정확히 한 번, FX.update 바로 뒤
  const tc = await ev(() => { T.upd = { n: 0, fx: 0, combo: 0, order: [] }; Loop.step(30); return T.upd; });
  check('play 업데이트 30번 = tickCombo 30번 (정확히 1번씩, 중복 없음)', tc.n === 30 && tc.combo === 30 && tc.fx === 30, JSON.stringify({ n: tc.n, fx: tc.fx, combo: tc.combo }));
  check('순서는 FX.update → tickCombo', tc.order.length === 60 && tc.order.every((s, i) => s === (i % 2 === 0 ? 'fx' : 'combo')));
  const cb = await ev(() => { Game.combo.count = 5; Game.combo.timer = 3; T.events.length = 0; const seq = []; for (let i = 0; i < 4; i++) { Loop.step(1); seq.push([Game.combo.count, Game.combo.timer]); } return seq; });
  check('콤보 타이머가 3 → 0 으로 줄고 0 이 되면 콤보가 끊김 (직접 또 줄이지 않음)', eq(cb, [[5, 2], [5, 1], [0, 0], [0, 0]]), JSON.stringify(cb));
  // 전환(transition)·쓰러짐(dead) 중에도 한 번씩
  const tr = await ev(() => { T.clearRoom(); Loop.step(STAGE_TUNE.clearMin); Game.player.x = Game.world.width - 20; Loop.step(1); T.upd = { n: 0, fx: 0, combo: 0, order: [] }; Loop.step(20); return { st: Stage.state, u: T.upd }; });
  check('전환 중에도 tickCombo 는 업데이트마다 1번', tr.st === 'transition' && tr.u.combo === 20 && tr.u.n === 20, JSON.stringify(tr));
  // 히트스톱 중에는 update 가 안 불리니 tickCombo 도 안 불림 (정지 연출과 같이 멈춤)
  await ev(() => { T.run(() => Stage.state === 'intro', 100, false); FX.freeze(5); T.upd = { n: 0, fx: 0, combo: 0, order: [] }; Loop.step(5); });
  check('히트스톱 5프레임 동안엔 play update/FX/콤보가 같이 멈춤', await ev(() => T.upd.n === 0 && T.upd.combo === 0));

  // Stage.start 없이 바로 play 씬에 들어가도 런이 자동으로 시작됨
  await ev(() => { T.fresh('hard', 5); Loop.step(95); T.die(); Loop.step(90); });          // 런을 게임 오버로 끝내 둠 → result 씬
  check('(준비) 런이 끝나 result 씬', (await ev(() => Game.scene)) === 'result' && !(await snapOf()).active);
  await ev(() => { RNG.seed(1); Debug.god = true; Game.difficulty = 'easy'; Game.nickname = 'zz'; Game.setScene('play'); });
  const auto = await ev(() => ({ st: Stage.state, p: !!Game.player, lives: Game.lives, d: Game.difficulty, w: Game.world.width, gs: Game.stage.roomName }));
  check('Stage.start 없이 setScene("play") 만 해도 자동 시작 (난이도 유지)', auto.st === 'intro' && auto.p && auto.lives === Infinity && auto.d === 'easy' && auto.w === 960 && auto.gs === '숲 입구', JSON.stringify(auto));
  const nsc = await ev(() => T.events.filter(e => e.n === 'sceneChanged').slice(-1)[0].d);
  check('자동 시작 때 sceneChanged 가 play→play 로 겹쳐 나가지 않음', nsc.to === 'play' && nsc.from === 'result', JSON.stringify(nsc));
});

// ===========================================================================
// 14. 재시작: 남는 상태가 없어야 함
// ===========================================================================
await section('재시작', async () => {
  // (a) 더럽혀진 상태에서 Stage.start 하면 모두 처음처럼
  await NEWGAME('normal', 18);
  await ev(() => { T.toBossFight(); Game.score = 777; Game.kills = 9; Game.combo.count = 5; Game.combo.max = 12; Stage.dropPickup(300, 400, 'candy'); FX.burst(300, 300, { kind: 'star', count: 30 }); FX.popup(10, 10, 'x'); FX.flash('#fff', 20); FX.shake(8, 20); FX.freeze(8); T.die(); Game.pause(true); });
  const dirty = await ev(() => ({ boss: !!Game.boss, paused: Game.paused, state: Stage.state, ri: Stage.roomIndex }));
  check('(준비) 보스전 중 쓰러진 채 일시정지된 더러운 상태', dirty.boss && dirty.paused && dirty.state === 'dead' && dirty.ri === 6, JSON.stringify(dirty));
  await ev(() => { RNG.seed(2); Stage.start({ difficulty: 'normal', nickname: '시험' }); });
  const s = await ev(() => T.snap());
  const clean = s.game.score === 0 && s.game.kills === 0 && s.game.deaths === 0 && s.game.lives === '3' && s.game.combo === '0/0' && !s.game.boss && s.game.result === null && !s.game.paused && s.game.w === 960;
  check('재시작: 점수/처치/사망/목숨/콤보/보스/결과/일시정지가 모두 초기화', clean, JSON.stringify(s.game));
  check('재시작: 엔티티는 주인공 + (보이지 않는 이펙트 층)뿐, 적/픽업/마커 없음', s.ents.every(k => k === 'player' || k === 'fx') && s.ents.includes('player'), JSON.stringify(s.ents));
  check('재시작: FX 입자/팝업/히트스톱/번쩍임이 비워짐', eq(s.fx, [0, 0, 0, 0]), JSON.stringify(s.fx));
  check('재시작: 방 0 intro, 웨이브 -1, 카메라 0, 타이머 0, 안내 없음', s.stage.state === 'intro' && s.stage.roomIndex === 0 && s.stage.waveIndex === -1 && s.cam === 0 && s.stage.t === 0 && s.stage.banner === null && s.stage.queue === 0 && s.stage.roomsCleared === 0 && s.stage.pickups === 0 && !s.stage.bossSpawned && !s.stage.bossCandy, JSON.stringify(s.stage));
  check('재시작: 주인공은 새 것 (살아 있고 체력 가득, 만세 아님)', await ev(() => Game.player.hp === Game.player.maxHp && !Game.player.dead && !Game.player.cheer && Game.player.x === 60));
  check('재시작: Game.stage 가 방 0 으로', eq(s.game.stage, { id: 'stage1', name: '사탕 숲', roomIndex: 0, roomCount: 7, roomName: '숲 입구' }));
  check('재시작: 음악이 stage 로', (await ev(() => Music.current)) === 'stage');

  // (b) 같은 시드로 두 번 돌리면 똑같은 스냅샷 (전환 중간/승리 중간에서 재시작해도)
  const play = () => ev(() => {
    T.fresh('normal', 31);
    T.toRoom(2);
    Loop.step(70);
    for (const e of T.foes()) if (!e.untargetable) T.hit(e);
    Loop.step(80);
    return T.snap();
  });
  const r1 = await play();
  await ev(() => { T.toBossFight(); T.hit(Game.boss); Loop.step(30); });      // 승리 연출 중간에서
  const r2 = await play();
  check('같은 시드로 두 번 돌린 스냅샷이 같음 (이전 판의 찌꺼기 없음)', eq(r1, r2), eq(r1, r2) ? '' : JSON.stringify(r1.stage) + ' vs ' + JSON.stringify(r2.stage));
  await ev(() => { T.clearRoom(); Loop.step(STAGE_TUNE.clearMin); Game.player.x = Game.world.width - 20; Loop.step(10); });
  check('(준비) 전환 중간 상태', (await snapOf()).state === 'transition');
  await ev(() => { RNG.seed(3); Stage.start({ difficulty: 'normal' }); });
  const m = await ev(() => ({ st: Stage.state, ri: Stage.roomIndex, w: Game.world.width, cam: Cam.x, t: Stage.snapshot().t }));
  check('전환 중간에 재시작해도 방 0 intro, 너비 960, t=0 (페이드가 남지 않음)', m.st === 'intro' && m.ri === 0 && m.w === 960 && m.cam === 0 && m.t === 0, JSON.stringify(m));
  const fadeTxt = await ev(() => { const c = T.ctx(); Stage.drawOverlay(c); const d = c.getImageData(5, 5, 1, 1).data; return d[3]; });
  check('재시작 뒤 화면에 검은 페이드가 남지 않음 (모서리 픽셀이 투명)', fadeTxt === 0, 'alpha=' + fadeTxt);

  // (c) 리스너 중복 없음: Events.on 이 새로 안 불리고, 몇 번을 시작해도 점수는 한 번만 들어감
  const lst = await ev(() => {
    let reg = 0; const o = Events.on; Events.on = function (...a) { reg++; return o.apply(Events, a); };
    for (let i = 0; i < 4; i++) { RNG.seed(4); Stage.start({ difficulty: 'normal' }); Loop.step(5); }
    Events.on = o;
    Game.combo.count = 0; Game.combo.max = 0;
    const e = Enemies.spawn('slime', 400, 420); const s0 = Game.score, k0 = Game.kills; T.hit(e);
    return { reg, d: Game.score - s0, kills: Game.kills - k0 };
  });
  check('Stage.start 를 4번 불러도 리스너를 새로 등록하지 않음', lst.reg === 0, 'Events.on 호출 ' + lst.reg);
  check('4번 재시작한 뒤에도 한 마리 처치 점수는 한 번만 (102)', lst.d === 102 && lst.kills === 1, JSON.stringify(lst));
  const lst2 = await ev(() => { T.events.length = 0; T.clearRoom(); return { rc: T.events.filter(e => e.n === 'roomCleared').length }; });
  check('방 클리어 이벤트도 한 번만', lst2.rc === 1);

  // (d) 승리 후 / 게임오버 후 곧바로 다시 시작
  await ev(() => { T.fresh('hard', 5); Loop.step(95); T.die(); Loop.step(90); });
  check('(준비) 게임 오버로 result 씬', (await ev(() => Game.scene)) === 'result');
  await ev(() => { RNG.seed(1); Stage.start({ difficulty: 'normal', nickname: '다시' }); });
  const again = await ev(() => ({ scene: Game.scene, st: Stage.state, d: Game.difficulty, lives: Game.lives, res: Game.result, deaths: Game.deaths }));
  check('게임 오버 뒤 다시 시작: play 씬, intro, 난이도 normal, 목숨 3, 결과 null', again.scene === 'play' && again.st === 'intro' && again.d === 'normal' && again.lives === 3 && again.res === null && again.deaths === 0, JSON.stringify(again));
  await step(page, 150);
  check('다시 시작한 판이 정상 진행 (fight)', (await snapOf()).state === 'fight');
});

// ===========================================================================
// 15. 튜토리얼 힌트
// ===========================================================================
await section('튜토리얼', async () => {
  await NEWGAME('normal', 19);
  await step(page, 60);
  const kb = await ev(() => { Game.touch = false; return T.overlayTexts(); });
  check('키보드: Z / X 키와 "걸어가요/때려요!/폴짝!" 문구', kb.includes('Z') && kb.includes('X') && kb.includes('걸어가요') && kb.includes('때려요!') && kb.includes('폴짝!'), JSON.stringify(kb));
  check('키보드 모드에는 "버튼" 표현이 없음 (부정)', !kb.some(s => s.includes('버튼') || s.includes('조이스틱')));
  await shot('r1_hints_keyboard');
  const tc = await ev(() => { Game.touch = true; return T.overlayTexts(); });
  check('터치: "조이스틱 / 공격 버튼 / 점프 버튼" 표현', tc.includes('조이스틱') && tc.includes('공격 버튼') && tc.includes('점프 버튼'), JSON.stringify(tc));
  check('터치 모드에는 키 이름(Z/X)이 없음 (부정)', !tc.includes('Z') && !tc.includes('X'));
  await shot('r1_hints_touch');
  await ev(() => { Game.touch = false; });
  // 진행 표시: 걸으면 move ✓, 점프하면 jump ✓, 처음 때리면 hit ✓ 후 사라짐
  let t = (await snapOf()).tut;
  check('처음엔 아무 것도 안 해서 ✓ 가 없음', !t.moved && !t.jumped && !t.hit && t.fade === 0, JSON.stringify(t));
  await ev(() => { Game.player.x = 250; });
  await step(page, 3);
  t = (await snapOf()).tut;
  check('100px 넘게 걸으면 "걸어가요" 완료', t.moved && !t.jumped && !t.hit, JSON.stringify(t));
  await ev(() => { Game.player.vz = 11; });
  await step(page, 3);
  t = (await snapOf()).tut;
  check('점프하면 "폴짝!" 완료', t.jumped && !t.hit, JSON.stringify(t));
  await step(page, 100);
  const still = await ev(() => T.overlayTexts());
  check('첫 타격 전에는 힌트가 계속 남아 있음', still.includes('때려요!'));
  await ev(() => { const e = T.foes().find(f => !f.untargetable); T.hit(e, 1); });
  t = (await snapOf()).tut;
  check('첫 타격(플레이어 팀이 적을 맞힘)이 기록됨', t.hit && t.fade === 0, JSON.stringify(t));
  await step(page, 40);
  const fading = await ev(() => { const c = T.ctx(); T.txt.length = 0; Stage.drawOverlay(c); return { fade: Stage.snapshot().tut.fade, txt: T.txt.includes('때려요!') }; });
  check('타격 뒤 힌트가 서서히 사라지는 중 (0 < fade < 1)', fading.fade > 0 && fading.fade < 1 && fading.txt, JSON.stringify(fading));
  await step(page, 40);
  const gone = await ev(() => T.overlayTexts());
  check('완전히 사라진 뒤에는 힌트 글자가 안 그려짐', !gone.includes('때려요!') && !gone.includes('걸어가요') && !gone.includes('폴짝!'), JSON.stringify(gone));
  // 적이 적을 맞혀도(= 적에게 맞는 주인공) 힌트가 사라지지 않음: 새 판에서 확인
  await NEWGAME('normal', 19);
  await step(page, 100);
  await ev(() => { Debug.god = false; Game.player.invuln = 0; Combat.damage(Game.player, 3, { team: 'enemy', sfx: null, freeze: 0 }); Debug.god = true; });
  check('주인공이 맞아도 "첫 타격"으로 치지 않음 (부정)', !(await snapOf()).tut.hit);
  // 방 2 에는 힌트가 없음 (부정)
  await ev(() => { T.toRoom(1); Game.touch = false; });
  await step(page, 30);
  const r2 = await ev(() => T.overlayTexts());
  check('방 2 에서는 튜토리얼 힌트가 안 그려짐 (부정)', !r2.includes('때려요!') && !r2.includes('걸어가요'), JSON.stringify(r2));
});

// ===========================================================================
// 16. 배경 · 오버레이: 어떤 상태에서도 안 죽고, 깜빡이지 않고, 읽기 쉬움
// ===========================================================================
await section('배경 그리기', async () => {
  await NEWGAME('normal', 20);
  const r = await ev(() => {
    const out = { threw: [], ctxKept: [], rooms: [] };
    for (let i = 0; i < STAGES[0].rooms.length; i++) {
      for (const cx of [0, 137, 960, 5000]) {
        const ctx = T.ctx(); ctx.save(); ctx.translate(11, 7); ctx.globalAlpha = 0.6;
        const m0 = ctx.getTransform(), a0 = ctx.globalAlpha;
        const old = Cam.x; Cam.x = cx;
        try { ctx.save(); ctx.translate(-Math.round(Cam.x), 0); Stage.drawBackground(ctx, i); ctx.restore(); } catch (e) { out.threw.push(i + ':' + cx + ':' + e.message); }
        Cam.x = old;
        const m1 = ctx.getTransform();
        out.ctxKept.push(m0.a === m1.a && m0.e === m1.e && m0.f === m1.f && a0 === ctx.globalAlpha);
        ctx.restore();
      }
    }
    return out;
  });
  check('모든 방(7개) × 여러 카메라 위치에서 drawBackground 가 예외 없이 끝남', r.threw.length === 0, r.threw.join(' | '));
  check('drawBackground 가 ctx 변환/투명도를 망가뜨리지 않음 (save/restore 짝)', r.ctxKept.every(Boolean));
  const noArg = await ev(() => { try { const c = T.ctx(); Stage.drawBackground(c); return true; } catch (e) { return String(e); } });
  check('roomIndex 없이 부르면 현재 방 그림', noArg === true, String(noArg));

  // 고정 시드: 몇 번을 그려도, 난수 시드가 달라도 똑같은 그림 (깜빡임 없음) + 게임 난수열을 건드리지 않음
  const same = await ev(() => {
    const sum = (i, cam) => { const ctx = T.ctx(); const o = Cam.x; Cam.x = cam; ctx.save(); ctx.translate(-cam, 0); Stage.drawBackground(ctx, i); ctx.restore(); Cam.x = o; const d = ctx.getImageData(0, 0, W, H).data; let h = 0; for (let k = 0; k < d.length; k += 7) h = (h * 31 + d[k]) | 0; return h; };
    const res = [];
    for (let i = 0; i < STAGES[0].rooms.length; i++) { RNG.seed(1); const a = sum(i, 100); RNG.seed(999); const b = sum(i, 100); const c = sum(i, 100); res.push(a === b && b === c); }
    RNG.seed(3); const x = [rand(), rand(), rand()];
    RNG.seed(3); sum(0, 0); sum(STAGES[0].rooms.length - 1, 0); const y = [rand(), rand(), rand()];
    return { stable: res, rngKept: eq3(x, y) };
    function eq3(p, q) { return p[0] === q[0] && p[1] === q[1] && p[2] === q[2]; }
  });
  check('같은 장면을 여러 번·다른 난수 시드로 그려도 픽셀이 같음 (위치가 고정 시드)', same.stable.every(Boolean), JSON.stringify(same.stable));
  check('배경을 그려도 게임 난수 rand() 순서가 안 바뀜', same.rngKept);

  // 읽기 쉬움: 바닥은 중간 밝기·낮은 대비, 보스방은 어둡고 붉음, 하늘이 비어 있지 않음
  const px = await ev(() => {
    const lum = (r, g, b) => (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    const out = [];
    for (let i = 0; i < STAGES[0].rooms.length; i++) {
      const ctx = T.ctx(); Stage.drawBackground(ctx, i);
      const d = ctx.getImageData(0, 0, W, H).data, at = (x, y) => { const k = (y * W + x) * 4; return [d[k], d[k + 1], d[k + 2], d[k + 3]]; };
      // 바닥 띠(y 340~500) 평균 밝기와 밝기 표준편차
      let n = 0, s = 0, s2 = 0;
      for (let y = 340; y < 500; y += 4) for (let x = 0; x < W; x += 6) { const p = at(x, y); const l = lum(p[0], p[1], p[2]); s += l; s2 += l * l; n++; }
      const mean = s / n, sd = Math.sqrt(Math.max(0, s2 / n - mean * mean));
      const sky = at(480, 20), floor = at(480, 520);
      let wr = 0, wb = 0, wn = 0;                                   // 벽(y 60~280) 평균 색
      for (let y = 60; y < 280; y += 6) for (let x = 0; x < W; x += 8) { const p = at(x, y); wr += p[0]; wb += p[2]; wn++; }
      out.push({ i, mean, sd, skyA: sky[3], floorA: floor[3], skyLum: lum(sky[0], sky[1], sky[2]), wallR: wr / wn, wallB: wb / wn });
    }
    return out;
  });
  check('모든 방: 하늘과 바닥이 완전히 채워짐 (투명한 구멍 없음)', px.every(p => p.skyA === 255 && p.floorA === 255));
  check('바닥 띠는 중간 밝기(0.30~0.85)라 캐릭터가 눈에 띔', px.every(p => p.mean > 0.30 && p.mean < 0.85), px.map(p => p.mean.toFixed(2)).join(','));
  check('바닥 띠는 대비가 낮음 (밝기 표준편차 < 0.06)', px.every(p => p.sd < 0.06), px.map(p => p.sd.toFixed(3)).join(','));
  const bi = px.length - 1;
  check('보스방(마지막)은 숲 입구보다 훨씬 어두움', px[bi].skyLum < px[0].skyLum * 0.45, `보스 ${px[bi].skyLum.toFixed(2)} vs 숲 ${px[0].skyLum.toFixed(2)}`);
  check('보스방 벽은 붉은 기운 (평균 R > B), 숲 입구는 푸른 기운 (B > R)', px[bi].wallR > px[bi].wallB && px[0].wallB > px[0].wallR, `보스 R=${px[bi].wallR.toFixed(0)} B=${px[bi].wallB.toFixed(0)} / 숲 R=${px[0].wallR.toFixed(0)} B=${px[0].wallB.toFixed(0)}`);

  // 성능: 캐시된 뒤에는 한 프레임이 가볍다
  const perf = await ev(() => {
    const out = [];
    for (let i = 0; i < STAGES[0].rooms.length; i++) {
      const ctx = T.ctx(); Cam.x = 0; Stage.drawBackground(ctx, i);        // 첫 호출은 오프스크린에 그리느라 오래 걸림 (방 바뀔 때 페이드 중에 처리)
      const t0 = performance.now(); for (let k = 0; k < 40; k++) { Cam.x = Math.min(960, k * 20); ctx.save(); ctx.translate(-Cam.x, 0); Stage.drawBackground(ctx, i); ctx.restore(); } out.push((performance.now() - t0) / 40);
    }
    Cam.x = 0; return out;
  });
  check('캐시된 배경은 프레임당 가벼움 (평균 8ms 미만)', perf.every(v => v < 8), perf.map(v => v.toFixed(2) + 'ms').join(', '));

  // 모든 상태에서 오버레이 / 씬 draw 가 예외 없이
  const states = ['intro', 'fight', 'clear', 'transition', 'victory', 'dead', 'over', 'idle'];
  const ov = await ev(states => {
    const bad = [];
    for (const touch of [false, true]) for (const lives of [3, Infinity, 0]) for (const room of [0, STAGES[0].rooms.length - 1]) {
      T.fresh('normal', 22); Game.touch = touch; Game.lives = lives;
      if (room) T.toRoom(room);
      for (const st of states) {
        Stage.state = st;
        try { const c = T.ctx(); Stage.drawOverlay(c); Scenes.play.draw(c); } catch (e) { bad.push(st + ':' + e.message); }
      }
    }
    return bad;
  }, states);
  check('모든 상태(intro/fight/clear/transition/victory/dead/over/idle) × 터치/목숨/방 에서 오버레이와 play 씬 draw 가 예외 없음', ov.length === 0, ov.slice(0, 3).join(' | '));
  const dbg = await ev(() => Debug.errors.slice());
  check('Debug.logOnce 에 기록된 오류가 없음', dbg.length === 0, JSON.stringify(dbg));
});

// ===========================================================================
// 16-2. QA 수정: 넓은 방 웨이브가 멍하니 서 있지 않음 (GP-3) / 보상 놓치지 않기 (GP-5) / 사탕은 체력이 가득이면 남겨 둠 (GP-6)
//       보스 '화났다!' 와 사탕 글자가 겹치지 않음 (UI-10)
// ===========================================================================
await section('이 방부터 다시 시작 (Stage.start roomIndex)', async () => {
  await NEWGAME('normal', 82, { roomIndex: 3 });
  const a = await ev(() => ({ st: Stage.snapshot(), gs: Object.assign({}, Game.stage), w: Game.world.width, px: Game.player.x, music: Music.current, ev: T.events.filter(e => e.n === 'roomStarted').map(e => e.index), foes: T.foes().length }));
  check('roomIndex:3 으로 시작하면 방 4(솜사탕 언덕)의 intro 에서 시작 (너비 1920, 주인공 x=60)', a.st.state === 'intro' && a.st.roomIndex === 3 && a.st.startRoom === 3 && a.gs.roomIndex === 3 && a.gs.roomName === '솜사탕 언덕' && a.gs.roomCount === 7 && a.w === 1920 && a.px === 60, JSON.stringify(a));
  check("건너뛴 방은 깬 방으로 세지 않음 (roomsCleared 0), 'roomStarted' 는 3 한 번, 판 음악은 stage", a.st.roomsCleared === 0 && eq(a.ev, [3]) && a.music === 'stage', JSON.stringify(a));
  await step(page, 95);
  const f = await snapOf();
  check('90프레임 뒤에는 그 방의 첫 웨이브가 시작됨', f.state === 'fight' && f.waveIndex === 0 && f.queue >= 3, JSON.stringify(f));
  await ev(() => { T.run(() => Stage.state === 'clear', 4000); });
  check('그 방을 깨면 다음 방으로 이어지고 깬 방은 1개로 셈', (await snapOf()).state === 'clear' && (await snapOf()).roomsCleared === 1);

  // 보스방부터: 보스 음악 + 경고음 + 보스 등장 → 처치하면 스테이지 클리어, rooms 1
  await NEWGAME('normal', 83, { roomIndex: 6 });
  const b = await ev(() => ({ st: Stage.snapshot(), music: Music.current, warn: T.sfx.includes('warn'), width: Game.world.width }));
  check('roomIndex:6 이면 보스방 intro 에서 시작, 보스 음악, 경고음, 너비 960', b.st.state === 'intro' && b.st.roomIndex === 6 && b.music === 'boss' && b.warn && b.width === 960, JSON.stringify(b));
  await ev(() => { T.run(() => !!Game.boss && !Game.boss.untargetable && Stage.state === 'fight', 600, false); T.hit(Game.boss); Loop.step(STAGE_TUNE.victory.total + 5); });
  const rs = await ev(() => Game.result);
  check('보스방부터 시작해 보스를 잡으면 클리어, 깬 방 수는 1 (건너뛴 방 제외)', rs && rs.cleared === true && rs.rooms === 1, JSON.stringify(rs));

  // 잘못된 값은 안전하게
  const odd = await ev(() => {
    const out = {};
    for (const v of [99, -3, 'x', NaN, null, undefined, 2.7]) { T.fresh('normal', 84, { roomIndex: v }); out[String(v)] = Stage.roomIndex; }
    return out;
  });
  check('roomIndex 가 범위 밖/이상한 값이면 보정 (99→마지막 방, -3·x·NaN·null·없음→첫 방, 2.7→2)', odd['99'] === 6 && odd['-3'] === 0 && odd.x === 0 && odd.NaN === 0 && odd.null === 0 && odd.undefined === 0 && odd['2.7'] === 2, JSON.stringify(odd));
  await NEWGAME('normal', 85);
  check('roomIndex 를 안 주면 늘 첫 방, startRoom 0', (await snapOf()).roomIndex === 0 && (await snapOf()).startRoom === 0);
});

await section('배경 캐시 키에 화면 배율 포함 (N07)', async () => {
  await NEWGAME('normal', 69);
  const r = await ev(() => {
    const saved = Loop.dpr;
    let made = 0; const ce = document.createElement.bind(document);
    document.createElement = function (tag, ...a) { if (String(tag).toLowerCase() === 'canvas') made++; return ce(tag, ...a); };
    const draw = () => { const c = T.ctx(); const before = made; Stage.drawBackground(c, 1); return made - before; };
    const out = {};
    Loop.dpr = 1; draw();                                            // 이 배율로 한 번 만들어 둠
    out.again1 = draw();                                             // 같은 배율: 새로 안 만듦
    Loop.dpr = 4 / 3; out.scale133 = draw(); out.again133 = draw();  // 1.333 (1280x720 창): 다시 만듦, 그 뒤엔 그대로
    Loop.dpr = 2; out.scale2 = draw(); out.again2 = draw();
    Loop.dpr = 1; out.back1 = draw();                                // 배율이 다시 바뀌면 또 다시 만듦
    document.createElement = ce; Loop.dpr = saved;
    return out;
  });
  check('같은 화면 배율에서는 배경을 다시 만들지 않음 (캔버스 새로 안 만듦)', r.again1 === 0 && r.again133 === 0 && r.again2 === 0, JSON.stringify(r));
  check('화면 배율(Loop.dpr 1 → 1.33 → 2 → 1)이 바뀌면 배경을 새 배율로 다시 만듦 (캐시 키에 배율 포함)', r.scale133 > 0 && r.scale2 > 0 && r.back1 > 0, JSON.stringify(r));
});

await section('넓은 방 웨이브 (GP-3)', async () => {
  await NEWGAME('normal', 70);
  await ev(() => { T.toRoom(1); Debug.god = true; });
  // 주인공은 방 왼쪽 끝에서 꼼짝 않음: 첫 적은 x≈1000 에서 나와 거리가 900 을 넘음 (예전에는 aggroRange 밖이라 영영 안 다가옴)
  await ev(() => { T.run(() => Stage.state === 'fight' && T.foes().length >= 1, 400, false); Game.player.x = 60; });
  const first = await ev(() => { const p = Game.player; const f = T.foes().map(e => ({ id: e.id, d: Math.round(Math.hypot(e.x - p.x, e.y - p.y)), hunt: e.hunt })); return f; });
  check('(준비) 첫 적은 aggroRange(900)보다 멀리서 나옴, hunt 표시', first.length >= 1 && first.every(f => f.d > 900 && f.hunt === true), JSON.stringify(first));
  await ev(() => { Game.player.invuln = 99999; });
  for (let i = 0; i < 6; i++) await ev(() => { Game.player.x = 60; Loop.step(200); });
  const near = await ev(() => {
    const p = Game.player;
    return T.foes().map(e => ({ st: e.state, d: Math.round(Math.hypot(e.x - p.x, e.y - p.y)) })).sort((a, b) => a.d - b.d);
  });
  check('가만히 1200프레임을 기다려도 적이 다가와 가장 가까운 적이 300px 안으로 옴 (멍하니 서 있지 않음)', near.length >= 1 && near[0].d < 300 && near[0].st !== 'idle', JSON.stringify(near));
  check('멀리서도 쫓아오는 적은 idle 로 남지 않음', near.every(f => f.st !== 'idle'), JSON.stringify(near));
});

await section('방 보상과 오른쪽 끝 (GP-5)', async () => {
  await NEWGAME('normal', 71);
  await ev(() => { T.toRoom(1); T.run(() => Stage.state === 'fight', 400, false); Game.player.x = Game.world.width - 30; Game.player.y = 420; });
  const r = await ev(() => {
    const fr = T.run(() => Stage.state === 'clear', 3000);
    const p = Game.player, cw = Game.world.width;
    const out = { fr, px: Math.round(p.x), cw, states: [], candyX: null, maxExit: STAGE_TUNE.clearMin };
    const newest = () => T.pk().filter(e => e.type === 'candy').sort((a, b) => b.id - a.id)[0];   // 가장 나중에 떨어진 사탕 = 방 보상 (앞서 적이 떨군 사탕이 섞일 수 있음)
    const c0 = newest(); out.candyX = c0 ? Math.round(c0.x) : null; out.candyId = c0 ? c0.id : null;
    out.candyAt = [];
    for (let i = 0; i < 70; i++) { Game.player.x = cw - 30; Loop.step(1); out.states.push(Stage.state); out.candyAt.push(Entities.list.some(e => e.id === out.candyId && !e._removed)); }
    return out;
  });
  const firstT = r.states.indexOf('transition');
  check('오른쪽 끝(출구)에 서 있는 채로 방을 깨도 곧바로 넘어가지 않음: 처음 44프레임은 clear', r.states.slice(0, 44).every(s => s === 'clear'), r.states.slice(0, 50).join(','));
  check(`clearMin(${r.maxExit}프레임)이 지난 뒤에 transition 으로 넘어감`, firstT >= r.maxExit - 3 && firstT <= r.maxExit + 3, 'first transition @' + firstT);
  check('그 동안(전환 전) 보상 사탕이 바닥에 그대로 있음 (만들어지자마자 치워지지 않음)', r.candyId !== null && r.candyAt.slice(0, 44).every(Boolean), `candyX=${r.candyX} 방 너비=${r.cw}`);
  const reward = await ev(() => { T.fresh('normal', 72); T.toRoom(1); T.run(() => Stage.state === 'fight', 400, false); const p = Game.player; p.hp = 40; p.x = Game.world.width - 30; p.y = 420; T.run(() => Stage.state === 'clear', 3000); const c = T.pk().filter(e => e.type === 'candy').sort((a, b) => b.id - a.id)[0]; const cx = c ? c.x : -1; p.x = cx; p.y = c ? c.y : 420; Loop.step(20); return { had: !!c, hp: p.hp, state: Stage.state }; });
  check('출구에 서서 깬 방에서도 보상 사탕을 주울 수 있음 (HP 40 → 80)', reward.had && reward.hp === 80 && reward.state === 'clear', JSON.stringify(reward));
  // 방 가운데에서 깨면 보상은 주인공 앞 110px (예전 위치)
  const mid = await ev(() => { T.fresh('normal', 73); T.toRoom(1); T.run(() => Stage.state === 'fight', 400, false); const p = Game.player; p.x = 700; p.y = 420; T.run(() => Stage.state === 'clear', 3000); const c = T.pk().filter(e => e.type === 'candy').sort((a, b) => b.id - a.id)[0]; return { dx: c ? Math.round(c.x - p.x) : null }; });
  check('방 가운데에서 깨면 보상은 주인공 앞쪽(오른쪽) 약 110px', mid.dx !== null && mid.dx > 60 && mid.dx < 160, JSON.stringify(mid));
});

await section('사탕은 체력이 가득이면 남겨 둠 (GP-6)', async () => {
  await NEWGAME('normal', 74);
  await step(page, 3);
  const r = await ev(() => {
    const p = Game.player; p.hp = p.maxHp; p.x = 400; p.y = 420; T.events.length = 0;
    const e = Stage.dropPickup(p.x + 10, p.y + 5, 'candy'); e.kx = 0;
    Loop.step(40);
    const out = { stays: Entities.list.includes(e), hp: p.hp, evs: T.events.filter(x => x.n === 'pickup').length, said: FX.popups.some(q => q.text.includes('가득')) };
    // 사라지는 시간도 멈춤: 오래 두어도 그대로
    Loop.step(1200);
    out.stillAfter = Entities.list.includes(e);
    // 다치면 그때 먹을 수 있음 (같은 사탕)
    p.hp = 50; Loop.step(5);
    out.eaten = !Entities.list.includes(e); out.hpAfter = p.hp; out.evs2 = T.events.filter(x => x.n === 'pickup').map(x => x.type);
    return out;
  });
  check('체력이 가득이면 사탕 위에 서도 먹지 않음 (사탕 그대로, HP 그대로, pickup 이벤트 없음)', r.stays && r.hp === 100 && r.evs === 0, JSON.stringify(r));
  check('체력 가득 상태에서 사탕 위에 서면 "체력이 가득!" 안내 글자가 한 번 뜸', r.said);
  check('체력이 가득인 동안엔 사탕 수명도 멈춤 (1200프레임 뒤에도 남아 있음)', r.stillAfter, JSON.stringify(r));
  check('다친 뒤에는 같은 사탕을 먹고 HP 가 +40 오름 (50 → 90)', r.eaten && r.hpAfter === 90 && eq(r.evs2, ['candy']), JSON.stringify(r));
  const coin = await ev(() => { const p = Game.player; p.hp = p.maxHp; p.x = 400; p.y = 420; const s0 = Game.score; const e = Stage.dropPickup(p.x, p.y, 'coin'); e.kx = 0; Loop.step(14); return { got: !Entities.list.includes(e), d: Game.score - s0 }; });
  check('코인은 체력과 상관없이 주움 (+50)', coin.got && coin.d === 50);
  // 다쳐 있을 때 떨어진 사탕은 수명이 줄어든다 (영원히 안 남음)
  const decay = await ev(() => { const p = Game.player; p.hp = 50; p.x = 100; p.y = 420; const e = Stage.dropPickup(900, 440, 'candy'); e.kx = 0; Loop.step(e.life + 5); return !Entities.list.includes(e); });
  check('다친 상태에서는 사탕이 예전처럼 15초 뒤에 사라짐', decay);
});

await section('보스 사탕 글자가 화났다! 와 겹치지 않음 (UI-10)', async () => {
  await NEWGAME('normal', 75);
  await ev(() => { T.toBossFight(); Debug.god = true; });
  const r = await ev(() => {
    const b = Game.boss, delay = STAGE_TUNE.bossCandySayDelay, out = { delay, angryAt: -1, bannerAt: -1, overlap: 0, candyAt: -1, bannerBefore: null };
    const n0 = T.pk().filter(e => e.type === 'candy').length;
    b.superArmor = true;                                    // 시험 동안 보스가 밀리거나 패턴을 바꾸지 않게
    T.hit(b, b.hp - Math.floor(b.maxHp * 0.5) + 1);         // 정확히 50% 아래로
    for (let i = 0; i < delay + 40; i++) {
      Loop.step(1);
      const angry = FX.popups.some(q => q.text === '화났다!'), bn = Stage.snapshot().banner === '사탕이 나왔어요!';
      if (angry && out.angryAt < 0) out.angryAt = i;
      if (bn && out.bannerAt < 0) out.bannerAt = i;
      if (angry && bn) out.overlap++;
      if (out.candyAt < 0 && T.pk().filter(e => e.type === 'candy').length > n0) out.candyAt = i;
    }
    return out;
  });
  check('보스 체력 50% 아래: 사탕은 바로 떨어지고 (처음 몇 프레임 안)', r.candyAt >= 0 && r.candyAt <= 3, JSON.stringify(r));
  check("보스의 '화났다!' 글자가 먼저 뜸", r.angryAt >= 0 && r.angryAt <= 3, JSON.stringify(r));
  check("'사탕이 나왔어요!' 글자는 bossCandySayDelay(90)프레임 뒤에 뜸", r.bannerAt >= r.delay - 2 && r.bannerAt <= r.delay + 2, JSON.stringify(r));
  check("두 글자가 같은 프레임에 함께 보인 적이 없음 (겹침 0)", r.overlap === 0, JSON.stringify(r));
});

await section('튜토리얼 유지와 팁 (KIDS-12)', async () => {
  // (1) 먼저 때려도 점프를 아직 안 했으면 점프 카드는 남음
  await NEWGAME('normal', 76);
  await ev(() => { T.run(() => T.foes().some(f => !f.untargetable), 400, false); });
  await ev(() => { const e = T.foes().find(f => !f.untargetable); if (e) T.hit(e, 1); });
  await step(page, 100);
  let t = (await snapOf()).tut;
  check('때리고 100프레임이 지나도 안 한 동작(점프)의 카드는 남음: card.jumped < 1, fade 0', t.hit && !t.jumped && t.card.jumped === 0 && t.card.moved === 0 && t.card.hit === 1 && t.fade === 0, JSON.stringify(t));
  let txt = await ev(() => T.overlayTexts());
  check('"폴짝!" 과 "걸어가요" 카드는 아직 그려지고 "때려요!" 는 사라짐', txt.includes('폴짝!') && txt.includes('걸어가요') && !txt.includes('때려요!'), JSON.stringify(txt));
  await ev(() => { Game.player.x = 400; Game.player.vz = 11; });
  await step(page, 3);
  txt = await ev(() => T.overlayTexts());
  check('점프하면 "폴짝!" 카드에 ✓ (done) 가 붙고 아직은 보임', (await snapOf()).tut.jumped && txt.includes('폴짝!'));
  await step(page, 70);
  txt = await ev(() => T.overlayTexts());
  check('점프하고 fadeDelay+fadeFrames(60) 뒤에는 "폴짝!" 도 사라짐', !txt.includes('폴짝!') && txt.includes('걸어가요') === (!(await snapOf()).tut.moved), JSON.stringify(txt));
  // (2) 끝내 안 해도 giveUp 이 지나면 모두 접힘
  await NEWGAME('normal', 77);
  const gu = await ev(() => STAGE_TUNE.hint.giveUp);
  await step(page, gu - 20);
  txt = await ev(() => T.overlayTexts());
  check(`아무것도 안 해도 giveUp(${gu}프레임) 직전에는 카드 세 개가 모두 보임`, txt.includes('걸어가요') && txt.includes('때려요!') && txt.includes('폴짝!'), JSON.stringify(txt));
  await step(page, 100);
  txt = await ev(() => T.overlayTexts());
  const tg = (await snapOf()).tut;
  check('giveUp 이 지나면 카드가 모두 사라짐 (계속 떠 있지 않음)', tg.fade === 1 && !txt.includes('걸어가요') && !txt.includes('때려요!') && !txt.includes('폴짝!'), JSON.stringify([tg, txt]));
});

await section('첫 스킬·첫 ! 팁 (KIDS-12)', async () => {
  // 방 1 에는 스킬 팁이 없음, 방 2 의 싸움에서 한 번만
  await NEWGAME('normal', 78);
  await step(page, 120);
  check('방 1 에서는 스킬 팁이 안 뜸 (부정)', (await snapOf()).tip !== 'skill');
  await ev(() => { T.toRoom(1); T.run(() => Stage.state === 'fight', 300, false); });
  await step(page, 2);
  const s1 = await snapOf();
  check('방 2 싸움이 시작되고 첫 스킬을 쓸 수 있으면 팁이 한 번 뜸', s1.tip === 'skill' && s1.roomIndex === 1, JSON.stringify(s1));
  await step(page, 30);
  const kb = await ev(() => { Game.touch = false; return T.overlayTexts(); });
  check('키보드: "A" 키 모양과 "를 눌러 회오리!" 문구', kb.includes('A') && kb.includes('를 눌러 회오리!') && !kb.some(x => x.includes('버튼')), JSON.stringify(kb));
  await shot('tip_skill_keyboard');
  const tc = await ev(() => { Game.touch = true; const o = T.overlayTexts(); Game.touch = false; return o; });
  check('터치: "스킬 버튼을 눌러 회오리!" 문구, 키 이름(A) 없음', tc.some(x => x.includes('스킬 버튼을 눌러 회오리!')) && !tc.includes('A'), JSON.stringify(tc));
  // 스킬을 쓰면 팁이 사라지고, 쿨타임이 끝나도 다시 안 뜸 (한 번만)
  await ev(() => { Input.press('KeyA'); });
  await step(page, 2);
  await ev(() => { Input.release('KeyA'); });
  check('스킬을 쓰면 팁이 곧바로 사라짐', (await snapOf()).tip === null);
  await step(page, 400);
  check('쿨타임이 끝나 다시 쓸 수 있어도 팁은 다시 안 뜸 (한 번만)', (await snapOf()).tip === null);
  // 스킬을 이미 써 본 아이에게는 방 2 에서도 안 뜸
  await NEWGAME('normal', 79);
  await step(page, 100);
  await ev(() => { Game.player.skills[0].cd = 100; Loop.step(2); });
  await ev(() => { T.toRoom(1); T.run(() => Stage.state === 'fight', 300, false); });
  await step(page, 5);
  check('방 1 에서 스킬을 써 본 아이에게는 방 2 에서 스킬 팁이 안 뜸 (부정)', (await snapOf()).tip !== 'skill');
  // 팁은 시간이 지나면 저절로 사라짐
  await NEWGAME('normal', 80);
  await ev(() => { T.toRoom(1); T.run(() => Stage.state === 'fight', 300, false); });
  await step(page, 2);
  check('(준비) 스킬 팁이 떠 있음', (await snapOf()).tip === 'skill');
  await step(page, (await ev(() => STAGE_TUNE.tip.life)) + 5);
  check('아무것도 안 눌러도 팁은 life(300프레임) 뒤에 저절로 사라짐', (await snapOf()).tip === null);
  // 처음 '!' 팁 (방 1)
  await NEWGAME('normal', 81);
  await ev(() => { Debug.god = true; });
  const bang = await ev(() => { const o = { at: -1, txt: null }; for (let i = 0; i < 1500; i++) { Loop.step(1); if (Stage.snapshot().tip === 'bang') { o.at = i; Loop.step(12); o.txt = T.overlayTexts(); break; } } return o; });
  check("방 1 에서 처음 적이 '!' 로 예고하면 팁이 뜸 (머리 위에 ! 가 뜨면 피해요!)", bang.at >= 0 && bang.txt.some(x => x.includes('! 가 뜨면 피해요')), JSON.stringify(bang));
  await ev(() => { T.killAll(); });
  await step(page, 500);
  const again = await ev(() => { let n = 0; for (let i = 0; i < 400; i++) { Loop.step(1); if (Stage.snapshot().tip === 'bang') n++; } return n; });
  check("'!' 팁은 한 번만 (끝난 뒤 다시 안 뜸)", again === 0);
});

// ===========================================================================
// 17. 스크린샷 (눈으로 확인)
// ===========================================================================
await section('스크린샷', async () => {
  for (const [i, name] of [[0, 'r1_forest'], [1, 'r2_path'], [2, 'r3_river'], [3, 'r4_hill'], [4, 'r5_cave'], [5, 'r6_crystal']]) {
    await NEWGAME('normal', 40 + i);
    await ev(i => { T.toRoom(i); }, i);
    await ev(() => { T.run(() => Stage.state === 'fight' && T.foes().length >= 2, 800, false); });
    await ev(() => { const p = Game.player; p.x = Math.min(Game.world.width - 400, 560); p.y = 440; Cam.snap(p); });
    await ev(() => { Loop.step(90); });
    await ev(() => { const f = T.foes(); const p = Game.player; for (const e of f) { if (e.type !== 'cloud') { e.x = p.x + 130; } } });
    await ev(() => { Stage.dropPickup(Game.player.x + 90, 450, 'coin'); Stage.dropPickup(Game.player.x + 130, 400, 'candy'); Loop.step(18); });
    await shot(name + '_scene');
  }
  // 보스방 (경고 / 싸움)
  await NEWGAME('normal', 50);
  await ev(() => { T.toRoom(T.last()); Loop.step(95); });
  await shot('boss_warning_drop');
  await ev(() => { Loop.step(70); T.run(() => !!Game.boss && !Game.boss.untargetable, 200, false); Loop.step(60); });
  await shot('boss_room_fight');
  // GO 화살표가 있는 장면 / 쓰러진 장면 / 승리 장면
  await NEWGAME('normal', 51);
  await ev(() => { T.toRoom(1); T.clearRoom(); Game.player.x = 700; Cam.snap(Game.player); Loop.step(12); });
  await shot('go_arrow_wide');
  await ev(() => { T.exitRoom(); Loop.step(5); T.run(() => Stage.state === 'fight', 100, false); Loop.step(30); });
  await shot('r3_start_empty');
  await NEWGAME('normal', 52);
  await ev(() => { T.toBossFight(); T.hit(Game.boss); Loop.step(60); });
  await shot('victory_60');
  await ev(() => { Loop.step(40); });
  await shot('victory_100');
  check('스크린샷 장면이 오류 없이 만들어짐', true);
});

// ---------------------------------------------------------------------------
check('페이지 오류(pageerror/console.error)가 없음', errors.length === 0, errors.slice(0, 3).join(' | '));
await close();
finish('stage');
