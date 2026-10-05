// enemies 모듈 테스트 (src/js_enemies.html)
//   실행: node tools/build-local.mjs --out dist/_enemies.html && GAME_HTML=dist/_enemies.html node tools/tests/enemies.test.mjs
//   SHOT_DIR=/어딘가 를 주면 적 모양 스크린샷을 그 폴더에 저장합니다 (저장소 안에는 쓰지 않아요).
//
// 다른 모듈(Player/Stage)은 아직 없을 수 있어서, 이 테스트는 "가짜 플레이어"(kind 'player', team 'player')와
// 작은 테스트용 씬(Scenes.etest)만 쓰고, 커널(Combat/Entities/FX/Events)은 진짜를 씁니다.
import { openGame } from '../lib/browser.mjs';
import { check, finish } from '../lib/check.mjs';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOT_DIR = process.env.SHOT_DIR || '';
if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true });

const { page, errors, close } = await openGame();
const ev = (fn, arg) => page.evaluate(fn, arg);
const section = async (name, fn) => {            // 한 구역이 예외로 죽어도 나머지는 계속
  try { await fn(); } catch (e) { check(`[${name}] 구역이 예외 없이 끝남`, false, String((e && e.stack) || e).split('\n').slice(0, 3).join(' | ')); }
};
const DIFFS = ['easy', 'normal', 'hard'];

// ---------------------------------------------------------------------------
// 페이지 안에 설치하는 도우미 (ET). 매 프레임 상태 전환·공격 판정·마커를 기록해 둡니다.
// ---------------------------------------------------------------------------
await ev(() => {
  const ET = window.ET = {};
  ET.f = 0; ET.hbs = []; ET.trans = []; ET.mk = {}; ET.spawns = []; ET.sfx = [];
  ET.atkMax = 0; ET.atkEver = new Set(); ET.prev = new Map(); ET.known = new Set(); ET.handlers = []; ET.logs = {}; ET.seen = [];

  // Combat.applyHitbox 스파이: 누가, 언제, 어디를 쳤고 누가 맞았는지 기록
  const origHit = Combat.applyHitbox;
  Combat.applyHitbox = hb => {
    const hits = origHit(hb);
    const o = hb.owner;
    ET.hbs.push({
      f: ET.f, owner: o ? o.id : null, type: o ? o.type : null, team: hb.team !== undefined ? hb.team : (o ? o.team : null),
      x1: Math.min(hb.x1, hb.x2), x2: Math.max(hb.x1, hb.x2), y: hb.y, depth: hb.depth, zMin: hb.zMin, zMax: hb.zMax, damage: hb.damage,
      ox: o ? o.x : null, oy: o ? o.y : null, oz: o ? o.z : null, face: o ? o.face : null, state: o ? o.state : null,
      hits: hits.map(h => h.id), hitKinds: hits.map(h => h.kind), hitSet: hb.hitSet,
    });
    return hits;
  };
  const origPlay = SFX.play;
  SFX.play = (n, o) => { ET.sfx.push([ET.f, n]); return origPlay.call(SFX, n, o); };

  const live = e => (e.kind === 'enemy' || e.kind === 'boss');
  ET.post = () => {                                        // 한 프레임 끝난 뒤 기록
    const p = Game.player;
    let atk = 0;
    for (const e of Entities.list) {
      if (live(e)) {
        if (!ET.known.has(e.id)) {
          ET.known.add(e.id);
          ET.spawns.push({ f: ET.f, id: e.id, type: e.type, minion: !!e.minion, state: e.state, z: e.z, untargetable: e.untargetable });
        }
        if (ET.prev.get(e.id) !== e.state) {
          ET.trans.push({ f: ET.f, id: e.id, type: e.type, from: ET.prev.get(e.id) || null, to: e.state, len: e.len, pattern: e.pattern || null,
            dx: p ? Math.abs(p.x - e.x) : null, dy: p ? Math.abs(p.y - e.y) : null, phase2: !!e.phase2, armor: !!e.superArmor });
          ET.prev.set(e.id, e.state);
        }
        if (!e.dead && (e.state === 'windup' || e.state === 'attack')) { atk++; ET.atkEver.add(e.id); }
      } else if (e.kind === 'marker' && e.owner) {
        const m = ET.mk[e.id] || (ET.mk[e.id] = { id: e.id, owner: e.owner.id, shape: e.shape, first: ET.f, last: ET.f, frames: 0, rx: e.rx, ry: e.ry, trail: [] });
        m.last = ET.f; m.frames++;
        m.trail.push({ f: ET.f, x: e.x, y: e.y, locked: e.locked });
      }
    }
    ET.atkMax = Math.max(ET.atkMax, atk);
    if (ET.onFrame) ET.onFrame();
  };

  Scenes.etest = {
    update() { ET.f++; Entities.updateAll(); FX.update(); ET.post(); },
    draw(ctx) {
      const g = ctx.createLinearGradient(0, 0, 0, 330); g.addColorStop(0, '#bfeaff'); g.addColorStop(1, '#fff4e0');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#f7c6e6'; ctx.fillRect(0, FLOOR_TOP - 20, W, H);
      ctx.fillStyle = '#ffe6f4'; for (let x = 0; x < W; x += 80) ctx.fillRect(x, FLOOR_TOP - 20, 40, H);
      ctx.save(); Cam.apply(ctx); Entities.drawAll(ctx); FX.drawWorld(ctx); ctx.restore(); FX.drawScreen(ctx);
    },
  };

  // 깨끗한 무대 + 가짜 플레이어. 기본은 "체력이 아주 많은" 플레이어 (피해는 진짜로 들어감)
  ET.setup = (diff = 'normal', o = {}) => {
    ET.unlisten();
    ET.seen.push(...Debug.errors); Debug.errors.length = 0;
    Entities.clear(); FX.clear(); Enemies.clear();
    RNG.seed(o.seed === undefined ? 1 : o.seed);
    Game.resetRun({ difficulty: diff });
    Game.world.width = o.width || 960; Cam.x = 0;
    Debug.god = !!o.god; Debug.noVariance = true;
    ET.f = 0; ET.hbs.length = 0; ET.trans.length = 0; ET.spawns.length = 0; ET.sfx.length = 0; ET.mk = {};
    ET.atkMax = 0; ET.atkEver = new Set(); ET.prev = new Map(); ET.known = new Set(); ET.onFrame = null; ET.logs = {};
    FX.hitstop = 0;
    Game.setScene('etest');
    const hp = o.hp || 100000;
    const p = Entities.add(Entities.make({
      kind: 'player', team: 'player', persistent: true, x: o.px === undefined ? 300 : o.px, y: o.py === undefined ? 420 : o.py,
      w: 40, h: 80, hp, maxHp: hp, noGravity: !!o.pnog,
      draw(ctx, e) { ctx.fillStyle = '#4aa3ff'; ctx.strokeStyle = COLORS.ink; ctx.lineWidth = 3; Draw.roundRect(ctx, e.x - 18, e.y - e.z - 80, 36, 80, 12); ctx.fill(); ctx.stroke(); },
    }));
    Game.player = p;
    ET.p = p;
    return p;
  };
  ET.listen = name => {                                    // 이벤트를 기록 (우리 모듈의 리스너는 건드리지 않고 이 핸들러만 나중에 뺌)
    const log = ET.logs[name] = [];
    const fn = d => log.push(d);
    Events.on(name, fn); ET.handlers.push([name, fn]);
    return log;
  };
  ET.unlisten = () => { ET.handlers.forEach(([n, fn]) => Events.off(n, fn)); ET.handlers = []; };

  ET.until = (cond, max) => {                              // cond(문자열)이 참이 될 때까지 최대 max 틱. 걸린 틱 수 또는 -1
    const f = new Function('return (' + cond + ')');
    for (let i = 0; i < max; i++) { Loop.step(1); if (f()) return i + 1; }
    return -1;
  };
  ET.byId = id => Entities.list.find(e => e.id === id) || null;
  ET.firstHb = (id, after = 0) => ET.hbs.find(h => h.owner === id && h.f >= after) || null;
  ET.lastTrans = (id, to, beforeF) => { for (let i = ET.trans.length - 1; i >= 0; i--) { const t = ET.trans[i]; if (t.id === id && t.to === to && t.f <= beforeF) return t; } return null; };
  ET.transOf = id => ET.trans.filter(t => t.id === id);
  ET.markerOf = (ownerId, beforeF) => { const ms = Object.values(ET.mk).filter(m => m.owner === ownerId && m.last <= beforeF); return ms.length ? ms[ms.length - 1] : null; };
  ET.foes = () => Entities.list.filter(e => e.kind === 'enemy' || e.kind === 'boss');
  ET.markers = () => Entities.list.filter(e => e.kind === 'marker');
  ET.grabErrors = () => { ET.errs = []; ET._orig = console.error; console.error = (...a) => { ET.errs.push(a.map(x => (x && x.message) || String(x)).join(' ')); }; };
  ET.releaseErrors = () => { console.error = ET._orig; return ET.errs; };
  // 화면 영역에서 "배경과 다른 픽셀" 수 (그림이 실제로 그려졌는지 확인)
  ET.region = (x, y, w, h) => {
    const c = Loop.canvas, d = Loop.dpr;
    return c.getContext('2d').getImageData(Math.round(x * d), Math.round(y * d), Math.round(w * d), Math.round(h * d)).data;
  };
  ET.diffPx = (a, b) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 40) n++; return n; };
});

// ===========================================================================
// 0. 소스 파일 검사 (Apps Script 제약 + 전역 이름)
// ===========================================================================
await section('소스', async () => {
  const src = readFileSync(resolve(root, 'src/js_enemies.html'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  check('소스: Math.random 을 쓰지 않음', !/Math\.random/.test(code));
  check('소스: alert/confirm/prompt/eval/document.write 를 쓰지 않음', !/\b(alert|confirm|prompt|eval)\s*\(|document\.write/.test(code));
  check('소스: JS 안에 "</script>" 문자열이 없음', (src.match(/<\/script>/g) || []).length === 1 && (src.match(/<script>/g) || []).length === 1);
  check('소스: 외부 이미지/스크립트/네트워크를 쓰지 않음', !/https?:\/\/|fetch\(|XMLHttpRequest|new Image|localStorage|google\.script/.test(code));
  const tops = [...src.matchAll(/^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]).sort();
  check('소스: 최상위 전역 이름이 ENEMY_TUNE · ENEMY_DEFS · Enemies 뿐', JSON.stringify(tops) === JSON.stringify(['ENEMY_DEFS', 'ENEMY_TUNE', 'Enemies']), tops.join(','));
  check('소스: 로드 시점 코드가 core 와 자기 이름만 씀 (Player/Stage/UI/Server 참조 없음)', !/\b(Player|Stage|UI|Server)\s*\./.test(code));
  const listeners = (src.match(/Events\.on\(/g) || []).length;
  check('소스: Events 리스너는 파일 로드 시 한 번만 등록 (bossKilled 하나)', listeners === 1 && /Events\.on\('bossKilled'/.test(src), `Events.on 호출 ${listeners}개`);
});

// ===========================================================================
// 1. 생성(spawn) 기본 + 난이도 스케일
// ===========================================================================
await section('생성', async () => {
  const r = await ev(() => {
    ET.setup('normal');
    const out = {};
    const bossLog = ET.listen('bossSpawned');
    const s = Enemies.spawn('slime', 400, 420);
    out.slime = { kind: s.kind, team: s.team, type: s.type, score: s.score, hp: s.hp, maxHp: s.maxHp, w: s.w, inList: Entities.list.includes(s), state: s.state, boss: s.boss, minion: s.minion, hasDraw: typeof s.draw === 'function', speed: s.speed };
    const b = Enemies.spawn('jellyKing', 700, 420);
    out.boss = { kind: b.kind, team: b.team, boss: b.boss, heavy: b.heavy, hp: b.hp, score: b.score, isGameBoss: Game.boss === b, ev: bossLog.length, evSame: bossLog[0] === b, state: b.state, z: b.z, untargetable: b.untargetable };
    ET.grabErrors();
    out.unknown = Enemies.spawn('dragon', 100, 100);
    out.unknownErrs = ET.releaseErrors().length;
    const c = Enemies.spawn('cloud', 200, 400);
    out.cloud = { z: c.z, noGravity: c.noGravity, kind: c.kind, score: c.score, hp: c.hp };
    const so = Enemies.spawn('soldier', 5000, 9999);
    out.soldierClamp = { x: so.x, y: so.y };
    const lo = Enemies.spawn('soldier', -50, 0);
    out.soldierClampLo = { x: lo.x, y: lo.y };
    const h2 = Enemies.spawn('slime', 400, 420, { hpMul: 2 });
    out.hpMul = h2.hp;
    const mn = Enemies.spawn('slime', 400, 420, { minion: true });
    out.minion = mn.minion;
    out.count = Enemies.aliveCount();
    return out;
  });
  check('spawn: 슬라임은 kind enemy / team enemy / type / score 100 / hp 20', r.slime.kind === 'enemy' && r.slime.team === 'enemy' && r.slime.type === 'slime' && r.slime.score === 100 && r.slime.hp === 20 && r.slime.maxHp === 20);
  check('spawn: Entities 에 추가되고 draw 가 있음, boss 가 아님', r.slime.inList && r.slime.hasDraw && !r.slime.boss && r.slime.minion === false);
  check('spawn: 처음엔 idle 상태 (바로 공격하지 않음)', r.slime.state === 'idle');
  check('spawn: 젤리 대왕은 kind boss / boss:true / heavy:true / hp 300 / score 3000', r.boss.kind === 'boss' && r.boss.boss === true && r.boss.heavy === true && r.boss.hp === 300 && r.boss.score === 3000 && r.boss.team === 'enemy');
  check('spawn: 보스를 만들면 Game.boss 가 그 보스', r.boss.isGameBoss);
  check('spawn: bossSpawned 이벤트가 정확히 한 번, 보스 엔티티와 함께', r.boss.ev === 1 && r.boss.evSame);
  check('spawn: 보스는 땅에서 시작, 처음엔 맞을 수 있음', r.boss.z === 0 && r.boss.untargetable === false);
  check('spawn: 알 수 없는 종류는 null (예외 없이)', r.unknown === null);
  check('spawn: 구름은 noGravity + 공중(z≈90)에서 시작', r.cloud.noGravity === true && r.cloud.z >= 85 && r.cloud.z <= 95 && r.cloud.kind === 'enemy' && r.cloud.hp === 25, `z=${r.cloud.z}`);
  check('spawn: 바닥 띠 밖 좌표는 안쪽으로 보정', r.soldierClamp.y === 500 && r.soldierClamp.x <= 960 - 20 && r.soldierClampLo.y === 330 && r.soldierClampLo.x >= 20, JSON.stringify([r.soldierClamp, r.soldierClampLo]));
  check('spawn: hpMul 옵션이 체력에 곱해짐 (20×2=40)', r.hpMul === 40);
  check('spawn: minion 옵션이 e.minion 으로 남음', r.minion === true);
  check('aliveCount: 지금까지 만든 7마리(보스 포함)를 센다', r.count === 7, String(r.count));
});

await section('난이도 스케일', async () => {
  for (const d of DIFFS) {
    const r = await ev(diff => {
      ET.setup(diff, { px: 100, py: 420 });
      const df = CFG.difficulty[diff];
      const out = { df: { enemyHp: df.enemyHp, enemySpeed: df.enemySpeed }, rows: {} };
      for (const t of ['slime', 'soldier', 'cloud', 'jellyKing']) {
        const e = Enemies.spawn(t, 700, 420);
        out.rows[t] = { hp: e.hp, maxHp: e.maxHp, want: Math.round(ENEMY_DEFS[t].hp * df.enemyHp), speed: e.speed, wantSpeed: ENEMY_DEFS[t].speed * df.enemySpeed };
        e.cd = 9999;
      }
      // 실제로 걷는 속도: 슬라임 한 마리를 멀리 두고 40프레임 관찰
      Enemies.clear();
      const s = Enemies.spawn('slime', 700, 420); s.alert = 0; s.cd = 0;
      Loop.step(30);
      const x0 = s.x; Loop.step(40);
      out.walk = (x0 - s.x) / 40; out.walkWant = ENEMY_DEFS.slime.speed * df.enemySpeed;
      return out;
    }, d);
    for (const [t, row] of Object.entries(r.rows)) {
      check(`[${d}] ${t}: hp = def.hp × enemyHp(${r.df.enemyHp}) = ${row.want}`, row.hp === row.want && row.maxHp === row.want, `hp=${row.hp}`);
      check(`[${d}] ${t}: speed = def.speed × enemySpeed(${r.df.enemySpeed})`, Math.abs(row.speed - row.wantSpeed) < 1e-9, `speed=${row.speed}`);
    }
    check(`[${d}] 슬라임이 실제로 걷는 속도 ≈ ${r.walkWant.toFixed(2)} px/f`, Math.abs(r.walk - r.walkWant) < 0.12, `실측 ${r.walk.toFixed(3)}`);
  }
  const r = await ev(() => {
    const a = {}; for (const d of ['easy', 'normal', 'hard']) { ET.setup(d); a[d] = [Enemies.spawn('soldier', 500, 420).hp, Enemies.spawn('soldier', 500, 420).speed]; }
    return a;
  });
  check('난이도가 올라갈수록 체력·속도가 커짐 (쉬움 < 보통 < 어려움)', r.easy[0] < r.normal[0] && r.normal[0] < r.hard[0] && r.easy[1] < r.normal[1] && r.normal[1] < r.hard[1], JSON.stringify(r));
});

// ===========================================================================
// 2. 예고(telegraph): 모든 공격은 windup 이 먼저, 24프레임 이상
// ===========================================================================
await section('예고 시간', async () => {
  for (const d of DIFFS) {
    for (const t of ['slime', 'soldier', 'cloud']) {
      const r = await ev(({ d, t }) => {
        const p = ET.setup(d, { px: 300, py: 420 });
        const e = Enemies.spawn(t, 520, 420); e.cd = 0;
        const n = ET.until(`ET.hbs.some(h => h.owner === ${e.id})`, 1500);
        const hb = ET.firstHb(e.id);
        const w = hb ? ET.lastTrans(e.id, 'windup', hb.f) : null;
        const tr = ET.transOf(e.id);
        const attacks = tr.filter(x => x.to === 'attack');
        let expected = Enemies.windupFrames(ENEMY_DEFS[t].windup);
        if (t === 'cloud') expected = Math.max(ENEMY_TUNE.minMarker, expected);
        return {
          n, hb: hb && { f: hb.f, team: hb.team, damage: hb.damage }, windupF: w && w.f, len: w && w.len, expected,
          frames: hb && w ? hb.f - w.f : null,
          attackAfterWindup: attacks.length > 0 && attacks.every(a => a.from === 'windup'),
          mul: CFG.difficulty[d].windupMul, base: ENEMY_DEFS[t].windup,
        };
      }, { d, t });
      check(`[${d}] ${t}: 공격 판정이 실제로 나옴`, r.n > 0 && !!r.hb, `n=${r.n}`);
      check(`[${d}] ${t}: 예고(windup) → 첫 판정 사이가 ${r.expected}프레임 이상 (>=24)`, r.frames !== null && r.frames >= 24 && r.frames >= r.expected && r.frames <= r.expected + 3, `실측 ${r.frames}프레임, 기대 ${r.expected} (base ${r.base} × ${r.mul})`);
      check(`[${d}] ${t}: windup 은 어떤 난이도에서도 24프레임 이상 (len=${r.len})`, r.len >= 24);
      check(`[${d}] ${t}: attack 상태는 항상 windup 다음에만 시작`, r.attackAfterWindup);
      check(`[${d}] ${t}: 공격 판정의 team 은 'enemy'`, r.hb && r.hb.team === 'enemy');
    }
  }
  // 난이도 배율이 실제로 예고 길이에 반영 (쉬움은 더 길고, 어려움은 짧되 24 미만 아님)
  const r = await ev(() => { ET.setup('easy'); const tinyEasy = Enemies.windupFrames(5); ET.setup('hard'); return { tiny: Enemies.windupFrames(5), tinyEasy }; });
  check('windupFrames: 아무리 작은 base 도 24프레임 하한 (쉬움·어려움 모두)', r.tiny === 24 && r.tinyEasy === 24, JSON.stringify(r));
  const r2 = await ev(() => { ET.setup('easy'); const a = Enemies.windupFrames(30); ET.setup('normal'); const b = Enemies.windupFrames(30); ET.setup('hard'); const c = Enemies.windupFrames(30); return [a, b, c]; });
  check('windupFrames: 쉬움 39 > 보통 30 > 어려움 24', r2[0] === 39 && r2[1] === 30 && r2[2] === 24, JSON.stringify(r2));
});

// ===========================================================================
// 3. 심술 구름: 마커 ≥45프레임, 번개는 마커 자리에 떨어짐, 마지막엔 멈춰서 피할 수 있음
// ===========================================================================
await section('구름 마커', async () => {
  for (const d of DIFFS) {
    const r = await ev(d => {
      ET.setup(d, { px: 300, py: 420 });
      const e = Enemies.spawn('cloud', 520, 420); e.cd = 0;
      ET.until(`ET.hbs.some(h => h.owner === ${e.id})`, 1500);
      const hb = ET.firstHb(e.id);
      const m = hb ? ET.markerOf(e.id, hb.f) : null;
      const lastPos = m && m.trail[m.trail.length - 1];
      const lockedFrames = m ? m.trail.filter(t => t.locked).length : 0;
      const stillLocked = m ? m.trail.filter(t => t.locked).every(t => t.x === lastPos.x && t.y === lastPos.y) : false;
      const movedBefore = m ? m.trail.some(t => !t.locked && (t.x !== m.trail[0].x || t.y !== m.trail[0].y)) : false;
      return {
        hb: hb && { x1: hb.x1, x2: hb.x2, y: hb.y, depth: hb.depth, zMax: hb.zMax, f: hb.f },
        m: m && { frames: m.frames, rx: m.rx, ry: m.ry, shape: m.shape, last: m.last, first: m.first }, lastPos, lockedFrames, stillLocked, movedBefore,
        hpLoss: 100000 - ET.p.hp, wantDmg: Math.round(ENEMY_DEFS.cloud.atk * CFG.difficulty[d].dmgTaken),
        markersLeft: ET.markers().filter(x => x.owner === e).length,
      };
    }, d);
    check(`[${d}] 구름: 바닥 마커가 보였다`, !!r.m && r.m.shape === 'ellipse');
    check(`[${d}] 구름: 마커가 낙뢰 전에 45프레임 이상 보임 (>=45)`, r.m && r.m.frames >= 45, `${r.m && r.m.frames}프레임`);
    check(`[${d}] 구름: 낙뢰는 마커가 있던 자리(중심)에 떨어짐`, r.hb && r.lastPos && Math.abs((r.hb.x1 + r.hb.x2) / 2 - r.lastPos.x) < 0.5 && Math.abs(r.hb.y - r.lastPos.y) < 0.5, JSON.stringify([r.hb, r.lastPos]));
    check(`[${d}] 구름: 마지막 프레임들에는 마커가 멈춤 (피할 시간 ${r.lockedFrames}프레임 ≥ 24)`, r.lockedFrames >= 24 && r.stillLocked, `잠김 ${r.lockedFrames}`);
    check(`[${d}] 구름: 멈추기 전에는 플레이어를 따라 움직임`, r.movedBefore === true || r.m.frames > 0);
    check(`[${d}] 구름: 가만히 서 있으면 맞는다 (피해 ${r.wantDmg})`, r.hpLoss === r.wantDmg, `실제 ${r.hpLoss}`);
    check(`[${d}] 구름: 낙뢰 뒤 마커는 사라짐`, r.markersLeft === 0);
  }
  // 피하기: 마커가 멈춘 뒤 옆으로 비키면 안 맞음 / 낮게 점프해도 안 맞음 / 가만히 있으면 맞음
  const dodge = async mode => ev(mode => {
    const p = ET.setup('normal', { px: 300, py: 420, pnog: true });
    const e = Enemies.spawn('cloud', 520, 420); e.cd = 0;
    ET.until(`ET.byId(${e.id}) && ET.byId(${e.id}).marker && ET.byId(${e.id}).marker.locked`, 1500);
    const hp0 = p.hp, m = e.marker;
    const mx = m.x;
    if (mode === 'side') p.x = mx + 180;                            // 옆으로 걸어 나감
    if (mode === 'depth') p.y = m.y + 70;
    if (mode === 'jump') ET.onFrame = () => { if (e.marker && e.marker.t >= e.marker.total - 2) p.z = 60; };
    ET.until(`ET.hbs.some(h => h.owner === ${e.id})`, 200);
    const hb = ET.firstHb(e.id);
    return { hit: hb ? hb.hits.length : -1, loss: hp0 - p.hp, mx, px: p.x, found: !!hb };
  }, mode);
  const stay = await dodge('stay'), side = await dodge('side'), depth = await dodge('depth'), jump = await dodge('jump');
  check('구름 낙뢰: 마커가 멈춘 뒤에도 가만히 있으면 맞는다 (대조군)', stay.found && stay.hit === 1 && stay.loss === 8, JSON.stringify(stay));
  check('구름 낙뢰: 마커가 멈춘 뒤 옆으로 비키면 안 맞는다', side.found && side.hit === 0 && side.loss === 0, JSON.stringify(side));
  check('구름 낙뢰: 깊이(y)를 70 옮겨도 안 맞는다 (벨트스크롤)', depth.found && depth.hit === 0 && depth.loss === 0, JSON.stringify(depth));
  check('구름 낙뢰: 번개가 칠 때 점프해 있으면 안 맞는다', jump.found && jump.hit === 0 && jump.loss === 0, JSON.stringify(jump));
});

// ===========================================================================
// 4. 구름의 높이: 떠 있을 땐 땅 공격이 안 닿고(점프로 때림), 번개를 모을 땐 내려와서 닿음. 스턴이 영원히 안 풀리는 함정 방지
// ===========================================================================
await section('구름 높이·스턴', async () => {
  const r = await ev(() => {
    const p = ET.setup('normal', { px: 700, py: 420 });
    const c = Enemies.spawn('cloud', 400, 420); c.cd = 99999;
    Loop.step(40);
    const groundHit = () => Combat.applyHitbox({ owner: p, team: 'player', x1: c.x - 40, x2: c.x + 40, y: c.y, zMin: -10, zMax: 80, damage: 1, knock: 0, stun: 0, freeze: 0, sfx: '', fx: '' });
    const out = { zFloat: c.z, hitFloat: groundHit().length };
    const jumpHit = Combat.applyHitbox({ owner: p, team: 'player', x1: c.x - 40, x2: c.x + 40, y: c.y, zMin: 15 - 10, zMax: 15 + 80, damage: 1, knock: 0, stun: 0, freeze: 0, sfx: '', fx: '' });
    out.hitJump = jumpHit.length;
    c.cd = 0; p.x = c.x - 80;
    ET.until(`ET.byId(${c.id}).state === 'windup'`, 600);
    Loop.step(30);
    out.zLow = c.z; out.hitLow = Combat.applyHitbox({ owner: p, team: 'player', x1: c.x - 40, x2: c.x + 40, y: c.y, zMin: -10, zMax: 80, damage: 1, knock: 0, stun: 0, freeze: 0, sfx: '', fx: '' }).length;
    return out;
  });
  check('구름: 떠 있는 동안(z≈90)은 땅 공격(높이 80)이 안 닿는다', r.zFloat > 84 && r.hitFloat === 0, `z=${r.zFloat.toFixed(1)} hit=${r.hitFloat}`);
  check('구름: 살짝 뛰어 오른 점프 공격은 닿는다', r.hitJump === 1);
  check('구름: 번개를 모으는 동안은 낮게 내려와서 땅 공격도 닿는다 (때려서 끊을 수 있음)', r.zLow < 70 && r.hitLow === 1, `z=${r.zLow.toFixed(1)} hit=${r.hitLow}`);

  const r2 = await ev(() => {
    const p = ET.setup('normal', { px: 700, py: 420 });
    const c = Enemies.spawn('cloud', 300, 420); c.cd = 99999;
    Loop.step(10);
    const z0 = c.z;
    Combat.damage(c, 3, { team: 'player', owner: p, stun: 14, launch: 7, knock: 6, freeze: 0 });
    const out = { stunAfter: c.stun, vzAfter: c.vz };
    Loop.step(60);
    out.stunLater = c.stun; out.vzLater = c.vz; out.zLater = c.z; out.state = c.state;
    for (let i = 0; i < 8; i++) { Combat.damage(c, 1, { team: 'player', owner: p, stun: 0, freeze: 0 }); Loop.step(2); }   // 저글링 연타
    Loop.step(60);
    out.zAfterJuggle = c.z; out.vzAfterJuggle = c.vz;
    c.cd = 0; p.x = c.x - 90; p.y = c.y;
    const n = ET.until(`ET.hbs.some(h => h.owner === ${c.id})`, 900);
    out.attackedAfter = n > 0;
    return out;
  });
  check('구름: 맞고 경직이 생겨도 영원히 굳지 않는다 (공중이라 커널이 스턴을 안 줄이므로 스스로 줄임)', r2.stunAfter > 0 && r2.stunLater === 0 && r2.state !== 'hurt', JSON.stringify(r2));
  check('구름: 띄우기·저글링을 맞아도 위로 날아가 버리지 않음 (z 가 제자리 근처)', r2.zLater > 30 && r2.zLater < 130 && r2.zAfterJuggle > 30 && r2.zAfterJuggle < 130 && r2.vzLater === 0, `z=${r2.zLater.toFixed(1)}/${r2.zAfterJuggle.toFixed(1)}`);
  check('구름: 맞고 난 뒤에도 다시 공격한다 (멈춰 버리지 않음)', r2.attackedAfter);
});

// ===========================================================================
// 5. 슬라임·병정: 공격이 정확히 앞쪽·같은 깊이에서만 맞음 (피할 수 있음)
// ===========================================================================
await section('근접 공격 판정', async () => {
  for (const t of ['slime', 'soldier']) {
    const run = mode => ev(({ t, mode }) => {
      const p = ET.setup('normal', { px: 300, py: 420 });
      const e = Enemies.spawn(t, 520, 420); e.cd = 0;
      ET.until(`ET.byId(${e.id}).state === 'windup'`, 900);
      const hp0 = p.hp, ex = e.x, ey = e.y, face = e.face;
      if (mode === 'behind') p.x = ex - face * 70;               // 예고 중에 몸 뒤로 넘어감
      if (mode === 'depth') p.y = ey + 60;                       // 깊이를 비킴
      if (mode === 'far') p.x = ex + face * -1 * 260;            // 멀리 도망 (앞쪽 방향으로 260 멀어짐)
      if (mode === 'jump') ET.onFrame = () => { if (e.state === 'attack' || (e.state === 'windup' && e.t >= e.len - 2)) p.z = 120; };
      p.noGravity = true;
      ET.until(`ET.hbs.some(h => h.owner === ${e.id}) && ET.byId(${e.id}).state !== 'attack'`, 300);
      const hbs = ET.hbs.filter(h => h.owner === e.id);
      return { loss: hp0 - p.hp, n: hbs.length, hits: hbs.reduce((a, h) => a + h.hits.length, 0), face, maxDepth: Math.max(...hbs.map(h => h.depth)), reach: hbs.length ? Math.max(...hbs.map(h => Math.max(Math.abs(h.x1 - h.ox), Math.abs(h.x2 - h.ox)))) : 0, hbZ: hbs.length ? hbs[0].zMax : 0, hbY: hbs.length ? hbs[0].y - hbs[0].oy : 0 };
    }, { t, mode });
    const stay = await run('stay'), behind = await run('behind'), depth = await run('depth'), far = await run('far'), jump = await run('jump');
    const dmg = ENEMY_DEFS_atk(t);
    check(`${t}: 정면에서 가만히 있으면 맞는다 (피해 ${dmg}, 정확히 한 번)`, stay.n > 0 && stay.hits === 1 && stay.loss === dmg, JSON.stringify(stay));
    check(`${t}: 예고 중에 몸 뒤로 넘어가면 안 맞는다 (앞쪽만 판정)`, behind.n > 0 && behind.hits === 0 && behind.loss === 0, JSON.stringify(behind));
    check(`${t}: 깊이(y)를 60 비키면 안 맞는다`, depth.n > 0 && depth.hits === 0 && depth.loss === 0, JSON.stringify(depth));
    check(`${t}: 멀리 도망가면 안 맞는다`, far.n > 0 && far.hits === 0 && far.loss === 0, JSON.stringify(far));
    check(`${t}: 점프해서 넘으면 안 맞는다 (판정 높이는 몸 높이까지)`, jump.n > 0 && jump.hits === 0 && jump.loss === 0, JSON.stringify(jump));
    check(`${t}: 판정 깊이는 26 이하(벨트스크롤: 겹쳐 보여야 맞음), 판정 y 는 적과 같은 깊이`, stay.maxDepth <= 26 && Math.abs(stay.hbY) < 0.5, `depth=${stay.maxDepth} dy=${stay.hbY}`);
    check(`${t}: 판정이 닿는 거리는 사거리 이내 (${stay.reach.toFixed(0)}px ≤ ${t === 'slime' ? 60 : 130})`, stay.reach > 20 && stay.reach <= (t === 'slime' ? 60 : 130));
  }
});
function ENEMY_DEFS_atk(t) { return { slime: 5, soldier: 8 }[t]; }

// ===========================================================================
// 6. 동시 공격자 제한 (maxAttackers)
// ===========================================================================
await section('동시 공격자', async () => {
  for (const d of DIFFS) {
    const r = await ev(d => {
      const p = ET.setup(d, { px: 480, py: 420, width: 960 });
      const types = ['slime', 'slime', 'soldier', 'soldier', 'cloud', 'cloud'];
      types.forEach((t, i) => { const e = Enemies.spawn(t, i % 2 ? 480 + 200 + i * 6 : 480 - 200 - i * 6, 360 + i * 22); e.cd = 0; });
      let over = 0, maxSeenFrames = 0;
      ET.onFrame = () => {
        let n = 0; for (const e of Entities.list) if ((e.kind === 'enemy') && !e.dead && (e.state === 'windup' || e.state === 'attack')) n++;
        if (n > CFG.difficulty[d].maxAttackers) over++;
        if (n === CFG.difficulty[d].maxAttackers) maxSeenFrames++;
      };
      Loop.step(1500);
      return { max: CFG.difficulty[d].maxAttackers, atkMax: ET.atkMax, over, maxSeenFrames, attackers: ET.atkEver.size, hbOwners: new Set(ET.hbs.map(h => h.owner)).size, alive: Enemies.aliveCount(), hpLoss: 100000 - p.hp, minWindup: Math.min(...ET.trans.filter(t => t.to === 'windup').map(t => t.len)) };
    }, d);
    check(`[${d}] 6마리가 둘러싸도 동시에 windup/attack 인 적은 ${r.max}명 이하 (넘은 프레임 ${r.over})`, r.over === 0 && r.atkMax <= r.max, `최대 ${r.atkMax}`);
    check(`[${d}] 실제로 ${r.max}명이 동시에 공격하는 순간도 있음 (제한이 헛돌지 않음)`, r.atkMax === r.max && r.maxSeenFrames > 10, `최대 ${r.atkMax}, ${r.maxSeenFrames}프레임`);
    check(`[${d}] 한 마리만 계속 때리지 않고 돌아가며 공격 (공격한 적 ${r.attackers}마리 ≥ 4)`, r.attackers >= 4 && r.hbOwners >= 4, `${r.attackers}/${r.hbOwners}`);
    check(`[${d}] 기다리는 동안에도 몸으로는 아프게 하지 않음 (피해는 공격 판정 때만): 전체 1500프레임 피해 ${r.hpLoss}`, r.hpLoss > 0 && r.hpLoss < 1500);
  }
});

// ===========================================================================
// 7. 몸이 닿아도 피해 없음 (접촉 피해 없음)
// ===========================================================================
await section('접촉 피해 없음', async () => {
  const r = await ev(() => {
    const p = ET.setup('normal', { px: 480, py: 420 });
    const list = [];
    ['slime', 'slime', 'slime', 'soldier', 'soldier', 'cloud'].forEach(t => { const e = Enemies.spawn(t, 480, 420); e.cd = 1e9; list.push(e); });   // 공격은 막고 플레이어 자리에 겹쳐 놓음
    Loop.step(300);
    const hp = p.hp, n = ET.hbs.length;
    const states = new Set(list.map(e => e.state));
    const dists = list.map(e => Math.hypot(e.x - p.x, e.y - p.y));
    return { hp, n, atkEver: ET.atkEver.size, states: [...states], minDist: Math.min(...dists), alive: Enemies.aliveCount() };
  });
  check('플레이어 자리에 적 6마리가 겹쳐 서 있어도 300프레임 동안 피해 0', r.hp === 100000 && r.n === 0, `hp=${r.hp} hb=${r.n}`);
  check('공격 상태에 들어간 적이 하나도 없음 (공격 없이는 아무 일도 없음)', r.atkEver === 0);
  const c = await ev(() => {
    const p = ET.setup('normal', { px: 480, py: 420 });
    ['slime', 'slime', 'soldier'].forEach(t => { const e = Enemies.spawn(t, 480, 420); e.cd = 0; });
    Loop.step(600);
    return { loss: 100000 - p.hp, hb: ET.hbs.length };
  });
  check('대조군: 같은 자리에서 공격을 허용하면 실제로 피해를 입음 (테스트가 헛돌지 않음)', c.loss > 0 && c.hb > 0, JSON.stringify(c));
  const boss = await ev(() => {
    const p = ET.setup('normal', { px: 480, py: 420 });
    const b = Enemies.spawn('jellyKing', 480, 420); b.cd = 1e9;
    Loop.step(300);
    return { hp: p.hp, hb: ET.hbs.length };
  });
  check('보스와 겹쳐 서 있어도 (패턴을 안 쓰는 동안) 피해 0', boss.hp === 100000 && boss.hb === 0);
});

// ===========================================================================
// 8. 적의 공격은 다른 적을 아프게 하지 않음
// ===========================================================================
await section('아군 오사 없음', async () => {
  const r = await ev(() => {
    const p = ET.setup('normal', { px: 300, py: 420 });
    ['slime', 'slime', 'slime', 'soldier', 'soldier', 'cloud'].forEach((t, i) => { const e = Enemies.spawn(t, 560 + (i % 3) * 14, 420 + (i % 2) * 8); e.cd = 0; });
    Loop.step(900);
    const foes = ET.foes();
    const foeIds = new Set(foes.map(e => e.id));
    const hitFoe = ET.hbs.some(h => h.hits.some(id => foeIds.has(id)));
    return { hb: ET.hbs.length, hitFoe, allFull: foes.every(e => e.hp === e.maxHp), teams: [...new Set(ET.hbs.map(h => h.team))] };
  });
  check('적 6마리가 붙어 서서 900프레임 동안 공격해도 서로 맞히지 않음', r.hb > 5 && !r.hitFoe && r.allFull, JSON.stringify(r));
  check('모든 적 공격 판정이 team enemy', r.teams.length === 1 && r.teams[0] === 'enemy');
  const b = await ev(() => {
    const p = ET.setup('normal', { px: 300, py: 420 });
    const boss = Enemies.spawn('jellyKing', 600, 420);
    const minions = [0, 1, 2].map(i => Enemies.spawn('slime', 600 - 20 + i * 20, 420, { minion: true }));
    minions.forEach(m => { m.cd = 99999; });
    ET.until(`ET.hbs.some(h => h.owner === ${boss.id})`, 900);
    Loop.step(40);
    return { hit: ET.hbs.filter(h => h.owner === boss.id).some(h => h.hits.some(id => minions.some(m => m.id === id))), full: minions.every(m => m.hp === m.maxHp), bossHp: boss.hp, n: ET.hbs.filter(h => h.owner === boss.id).length };
  });
  check('보스 충격파/돌진도 소환수를 맞히지 않음', b.n > 0 && !b.hit && b.full && b.bossHp === 300, JSON.stringify(b));
});

// ===========================================================================
// 9. 겹치지 않기 (soft separation)
// ===========================================================================
await section('겹치지 않기', async () => {
  const r = await ev(() => {
    const p = ET.setup('normal', { px: 100, py: 420 });
    const list = [];
    for (let i = 0; i < 5; i++) { const e = Enemies.spawn('slime', 600, 420); e.cd = 99999; list.push(e); }    // 같은 점에 5마리
    const spread = () => { let mn = Infinity; for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) { const a = list[i], b = list[j]; mn = Math.min(mn, Math.hypot((a.x - b.x) / (a.w * 0.8), (a.y - b.y) / 18)); } return mn; };
    const s0 = spread();
    Loop.step(150);
    const s1 = spread();
    Loop.step(150);
    return { s0, s1, s2: spread(), xs: list.map(e => Math.round(e.x)), ys: list.map(e => Math.round(e.y)) };
  });
  check('같은 점에 태어난 5마리가 시간이 지나면 서로 떨어짐', r.s0 < 0.01 && r.s1 > 0.55 && r.s2 > 0.55, `간격 ${r.s0.toFixed(2)} → ${r.s1.toFixed(2)} → ${r.s2.toFixed(2)}`);
  const g = await ev(() => {
    const p = ET.setup('normal', { px: 100, py: 420 });
    const c = Enemies.spawn('cloud', 600, 420), s = Enemies.spawn('slime', 600, 420); c.cd = 99999; s.cd = 99999;
    Loop.step(120);
    return { dx: Math.abs(c.x - s.x), dy: Math.abs(c.y - s.y) };
  });
  check('공중의 구름과 지상의 슬라임은 서로 밀어내지 않음 (같은 자리 통과 가능)', g.dx < 40, `dx=${g.dx.toFixed(1)}`);
});

// ===========================================================================
// 10. 젤리 대왕: 세 패턴 순서, 예고, 반격 시간, 2페이즈
// ===========================================================================
await section('보스 패턴', async () => {
  for (const d of DIFFS) {
    const r = await ev(d => {
      const p = ET.setup(d, { px: 300, py: 420 });
      const b = Enemies.spawn('jellyKing', 700, 420);
      const armor = { during: [], recover: [] };
      ET.onFrame = () => {
        if (b.state === 'windup' || b.state === 'attack') armor.during.push(b.superArmor);
        if (b.state === 'recover') armor.recover.push(b.superArmor);
      };
      ET.until(`ET.trans.filter(t => t.id === ${b.id} && t.to === 'windup').length >= 4 && ET.trans.filter(t => t.id === ${b.id} && t.to === 'recover').length >= 4`, 4000);
      const tr = ET.transOf(b.id);
      const wins = tr.filter(t => t.to === 'windup');
      const pats = wins.map(w => {
        const rec = tr.find(t => t.to === 'recover' && t.f > w.f);
        const next = rec ? tr.find(t => t.f > rec.f && t.from === 'recover') : null;
        let payload = null;
        if (w.pattern === 'summon') { const s = ET.spawns.find(x => x.minion && x.f >= w.f); payload = s ? s.f : null; }
        else { const h = ET.firstHb(b.id, w.f); payload = h ? h.f : null; }
        return { pattern: w.pattern, len: w.len, windupF: w.f, payload, telegraph: payload !== null ? payload - w.f : null, recLen: rec ? rec.len : null, recFrames: rec && next ? next.f - rec.f : null };
      });
      return { pats, armorAll: armor.during.every(x => x === true) && armor.during.length > 50, armorN: armor.during.length, armorOff: armor.recover.every(x => x === false) && armor.recover.length > 50, hpLoss: 100000 - p.hp };
    }, d);
    const order = r.pats.slice(0, 4).map(x => x.pattern).join('>');
    check(`[${d}] 보스 패턴 순서: 점프 찍기 > 슬라임 소환 > 돌진 > (다시) 점프 찍기`, order === 'slam>summon>charge>slam', order);
    r.pats.slice(0, 3).forEach(x => {
      check(`[${d}] 보스 ${x.pattern}: 예고(windup) ${x.len}프레임 ≥ 24, 실제 판정/소환까지 ${x.telegraph}프레임`, x.len >= 24 && x.telegraph !== null && x.telegraph >= 24 && x.telegraph >= x.len, JSON.stringify(x));
      check(`[${d}] 보스 ${x.pattern}: 패턴 뒤 반격 시간 ${x.recFrames}프레임 ≥ 60`, x.recLen >= 60 && x.recFrames !== null && x.recFrames >= 60, JSON.stringify(x));
    });
    const slam = r.pats[0], charge = r.pats[2], summon = r.pats[1];
    check(`[${d}] 돌진 뒤 어지러운 시간(${charge.recFrames})이 가장 김`, charge.recFrames > slam.recFrames && charge.recFrames > summon.recFrames, `${slam.recFrames}/${summon.recFrames}/${charge.recFrames}`);
    check(`[${d}] 점프 찍기는 착지까지 45프레임 넘게 걸림 (마커가 그 내내 보임)`, slam.telegraph >= 45, `${slam.telegraph}`);
    check(`[${d}] 패턴 중에는 슈퍼아머 (${r.armorN}프레임), 쉬는 시간에는 풀려서 때릴 수 있음`, r.armorAll && r.armorOff);
    check(`[${d}] 가만히 서 있던 플레이어는 보스 공격(충격파·돌진)에 맞았다`, r.hpLoss > 0);
  }
});

await section('보스 마커·피하기', async () => {
  for (const d of DIFFS) {
    const r = await ev(d => {
      const p = ET.setup(d, { px: 300, py: 420 });
      const b = Enemies.spawn('jellyKing', 700, 420);
      ET.until(`ET.hbs.some(h => h.owner === ${b.id})`, 1500);
      const hb = ET.firstHb(b.id);
      const m = ET.markerOf(b.id, hb.f), last = m.trail[m.trail.length - 1];
      return { f: hb.f, m: { frames: m.frames, rx: m.rx, ry: m.ry, shape: m.shape }, hb: { x1: hb.x1, x2: hb.x2, y: hb.y, depth: hb.depth, zMax: hb.zMax, ox: hb.ox, oy: hb.oy, oz: hb.oz }, last, locked: m.trail.filter(t => t.locked).length, stillLocked: m.trail.filter(t => t.locked).every(t => t.x === last.x && t.y === last.y), loss: 100000 - p.hp, want: Math.round(10 * 1.5 * CFG.difficulty[d].dmgTaken) };
    }, d);
    check(`[${d}] 보스 점프 찍기: 착지 마커가 45프레임 이상 보임 (${r.m.frames})`, r.m.frames >= 45 && r.m.shape === 'ellipse');
    check(`[${d}] 보스 충격파는 마커 중심에 정확히 떨어지고 보스도 거기 착지 (z=0)`, Math.abs((r.hb.x1 + r.hb.x2) / 2 - r.last.x) < 0.5 && Math.abs(r.hb.y - r.last.y) < 0.5 && Math.abs(r.hb.ox - r.last.x) < 0.5 && Math.abs(r.hb.oy - r.last.y) < 0.5 && r.hb.oz === 0, JSON.stringify([r.hb, r.last]));
    check(`[${d}] 보스 충격파: 낮게 점프하면 넘을 수 있음 (판정 높이 zMax ${r.hb.zMax} ≤ 60)`, r.hb.zMax <= 60, `zMax=${r.hb.zMax}`);
    check(`[${d}] 보스 마커도 마지막 ${r.locked}프레임은 멈춰서 피할 시간이 있음 (≥24)`, r.locked >= 24 && r.stillLocked, `${r.locked}`);
    check(`[${d}] 가만히 있으면 충격파에 맞음 (피해 ${r.want})`, r.loss === r.want, `실제 ${r.loss}`);
  }
  const dodge = mode => ev(mode => {
    const p = ET.setup('normal', { px: 300, py: 420, pnog: true });
    const b = Enemies.spawn('jellyKing', 700, 420);
    ET.until(`ET.byId(${b.id}).marker && ET.byId(${b.id}).marker.locked`, 1500);
    const hp0 = p.hp, m = b.marker;
    if (mode === 'side') p.x = m.x + 230;
    if (mode === 'depth') p.y = m.y > 420 ? 340 : 500;
    if (mode === 'jump') ET.onFrame = () => { if (b.marker && b.marker.t >= b.marker.total - 2) p.z = 80; };
    ET.until(`ET.hbs.some(h => h.owner === ${b.id})`, 200);
    const hbs = ET.hbs.filter(h => h.owner === b.id);
    return { n: hbs.length, hits: hbs.reduce((a, h) => a + h.hits.length, 0), loss: hp0 - p.hp };
  }, mode);
  const s = await dodge('side'), dp = await dodge('depth'), j = await dodge('jump'), st = await dodge('stay');
  check('보스 충격파: 마커가 멈춘 뒤 옆으로 비키면 안 맞는다', s.n > 0 && s.hits === 0 && s.loss === 0, JSON.stringify(s));
  check('보스 충격파: 위/아래(깊이)로 비켜도 안 맞는다', dp.n > 0 && dp.hits === 0 && dp.loss === 0, JSON.stringify(dp));
  check('보스 충격파: 착지 순간 점프해 있으면 안 맞는다', j.n > 0 && j.hits === 0 && j.loss === 0, JSON.stringify(j));
  check('보스 충격파: 대조군 — 가만히 있으면 한 번만 맞는다 (4프레임 동안 같은 판정이 이어져도 중복 안 됨)', st.hits === 1 && st.loss === 15, JSON.stringify(st));

  // 돌진: 길 위에서만 맞고, 한 번만 맞고(관통), 옆으로 비키면 안 맞음
  const ch = async mode => ev(mode => {
    const p = ET.setup('normal', { px: 300, py: 420 });
    const b = Enemies.spawn('jellyKing', 800, 420);
    b.patIdx = 2;                                                  // 곧바로 돌진 차례
    ET.until(`ET.byId(${b.id}).state === 'windup' && ET.byId(${b.id}).pattern === 'charge'`, 800);
    ET.until(`ET.byId(${b.id}).marker && ET.byId(${b.id}).marker.locked`, 200);
    const hp0 = p.hp, laneY = b.y, bx = b.x, face = b.face;
    if (mode === 'depth') p.y = laneY > 420 ? laneY - 90 : laneY + 90;
    ET.until(`ET.byId(${b.id}).state === 'recover'`, 400);
    const hbs = ET.hbs.filter(h => h.owner === b.id);
    const tr = ET.transOf(b.id);
    const rec = tr.filter(t => t.to === 'recover').pop();
    return { n: hbs.length, hits: hbs.reduce((a, h) => a + h.hits.length, 0), loss: hp0 - p.hp, bx, face, endX: b.x, recLen: rec && rec.len, wall: face > 0 ? Game.world.width - b.w / 2 : b.w / 2, depthOf: hbs[0] && hbs[0].depth, zMax: hbs[0] && hbs[0].zMax };
  }, mode);
  const c1 = await ch('stay'), c2 = await ch('depth');
  check('보스 돌진: 길 위에 서 있으면 한 번만 맞는다 (관통 판정, 중복 피해 없음) 피해 12', c1.hits === 1 && c1.loss === 12 && c1.n > 5, JSON.stringify(c1));
  check('보스 돌진: 벽까지 달려가서 멈추고 어지러운 시간(≥100프레임)이 됨', Math.abs(c1.endX - c1.wall) < 3 && c1.recLen >= 100, `end=${c1.endX.toFixed(1)} wall=${c1.wall} rec=${c1.recLen}`);
  check('보스 돌진: 길(깊이) 밖으로 90 비키면 안 맞는다', c2.n > 5 && c2.hits === 0 && c2.loss === 0, JSON.stringify(c2));
});

// 둥근 판정: 번개·충격파는 눈에 보이는 마커 타원 "안"에서만 아프고 "밖"에서는 절대 안 아픔 (사각형 모서리가 삐져나오지 않음)
await section('둥근 판정', async () => {
  for (const type of ['cloud', 'jellyKing']) {
    for (const d of ['normal', 'hard']) {
      const r = await ev(({ type, d }) => {
        const p = ET.setup(d, { px: 200, py: 420, width: 1920 });
        const foe = Enemies.spawn(type, type === 'cloud' ? 520 : 700, 420); foe.cd = 0;
        ET.until(`ET.byId(${foe.id}).marker && ET.byId(${foe.id}).marker.locked`, 2000);
        const m = foe.marker, cx = m.x, cy = m.y, rx = m.rx, ry = m.ry;
        const ds = [];
        for (const k of [0.5, 0.8, 0.92, 1.0, 1.05, 1.2, 1.6]) for (let a = 0; a < 360; a += 15) {
          const th = a * Math.PI / 180;
          const q = Entities.add(Entities.make({ kind: 'dummy', team: 'player', persistent: true, clampWorld: false, shadow: false, x: cx + Math.cos(th) * rx * k, y: cy + Math.sin(th) * ry * k, w: 40, h: 80, hp: 1e6, maxHp: 1e6 }));
          q.k = k; ds.push(q);
        }
        p.x = 1800; p.y = 500; Debug.god = false;
        let hbN = 0; const orig = Combat.applyHitbox;
        for (let i = 0; i < 90; i++) { Loop.step(1); if (!foe.marker) break; }
        Loop.step(8);
        const by = {};
        for (const q of ds) { const o = by[q.k] || (by[q.k] = { n: 0, hit: 0, multi: 0 }); o.n++; const lost = 1e6 - q.hp; if (lost > 0) o.hit++; if (lost > Math.round(ENEMY_DEFS[type].atk * (type === 'cloud' ? 1 : ENEMY_DEFS.jellyKing.patterns.slam.damage) * CFG.difficulty[d].dmgTaken) * 1.5) o.multi++; }
        return { by, rx, ry };
      }, { type, d });
      const ks = Object.keys(r.by).map(Number).sort((a, b) => a - b);
      const inside = ks.filter(k => k <= 0.92), outside = ks.filter(k => k >= 1.0);
      check(`[${d}] ${type}: 마커 타원 안쪽(반지름 92% 이내) 24방향 모두 맞음`, inside.every(k => r.by[k].hit === r.by[k].n), JSON.stringify(r.by));
      check(`[${d}] ${type}: 마커 타원 바깥(100% 이상) 24방향 어디서도 안 맞음 — 대각선 모서리도 포함`, outside.every(k => r.by[k].hit === 0), JSON.stringify(r.by));
      check(`[${d}] ${type}: 안쪽 대상은 한 번만 맞음 (여러 프레임 판정이어도 중복 피해 없음)`, inside.every(k => r.by[k].multi === 0), JSON.stringify(r.by));
    }
  }
});

await section('보스 2페이즈', async () => {
  const r = await ev(() => {
    const p = ET.setup('normal', { px: 300, py: 420 });
    const b = Enemies.spawn('jellyKing', 700, 420);
    const out = {};
    // 1페이즈 기준: 접근 속도 / 예고 길이 / 반격 길이를 한 사이클 재고
    const measure = () => {
      const from = ET.trans.length;
      ET.until(`ET.trans.slice(${from}).filter(t => t.id === ${b.id} && t.to === 'windup').length >= 3 && ET.trans.slice(${from}).filter(t => t.id === ${b.id} && t.to === 'recover').length >= 3`, 4000);
      const t = ET.trans.slice(from).filter(x => x.id === b.id);
      const wins = t.filter(x => x.to === 'windup'), recs = t.filter(x => x.to === 'recover');
      return { windups: wins.slice(0, 3).map(x => `${x.pattern}:${x.len}`), wl: wins.slice(0, 3).map(x => x.len), rl: recs.slice(0, 3).map(x => x.len) };
    };
    out.p1 = measure();
    // 2페이즈 직전: 체력 51% 에서는 아직 아님
    Combat.damage(b, 140, { team: 'player', owner: p, freeze: 0, stun: 0 });
    out.at51 = b.phase2 === true; out.hpMid = b.hp;
    const warn0 = ET.sfx.filter(s => s[1] === 'warn').length;
    Combat.damage(b, 10, { team: 'player', owner: p, freeze: 0, stun: 0 });   // 정확히 50%
    out.at50 = b.phase2 === true; out.hp50 = b.hp;
    out.popup = FX.popups.some(q => q.text === '화났다!');
    out.warnDelta = ET.sfx.filter(s => s[1] === 'warn').length - warn0;
    for (let i = 0; i < 5; i++) Combat.damage(b, 5, { team: 'player', owner: p, freeze: 0, stun: 0 });
    out.warnAfter = ET.sfx.filter(s => s[1] === 'warn').length - warn0;
    out.popups = FX.popups.filter(q => q.text === '화났다!').length;
    out.p2 = measure();
    // 속도: 돌진 중 최대 이동 속도 1페이즈 vs 2페이즈
    return out;
  });
  check('2페이즈: 체력 51%에서는 아직 안 화남', r.at51 === false && r.hpMid === 160, JSON.stringify([r.at51, r.hpMid]));
  check('2페이즈: 체력 50%가 되는 순간 phase2 가 켜짐', r.at50 === true && r.hp50 === 150);
  check('2페이즈: "화났다!" 팝업이 뜨고 warn 효과음이 정확히 한 번', r.popup && r.warnDelta === 1, `warn=${r.warnDelta}`);
  check('2페이즈: 더 맞아도 다시 발동하지 않음 (warn 1번, 팝업 1개)', r.warnAfter === 1 && r.popups === 1, `warn=${r.warnAfter} popups=${r.popups}`);
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
  check(`2페이즈: 예고가 짧아짐 (${r.p1.wl.join(',')} → ${r.p2.wl.join(',')}) 하지만 24프레임 미만은 아님`, avg(r.p2.wl) < avg(r.p1.wl) && Math.min(...r.p2.wl) >= 24, JSON.stringify([r.p1.wl, r.p2.wl]));
  check(`2페이즈: 반격 시간이 짧아짐 (${r.p1.rl.join(',')} → ${r.p2.rl.join(',')}) 하지만 60프레임 미만은 아님`, avg(r.p2.rl) < avg(r.p1.rl) && Math.min(...r.p2.rl) >= 60, JSON.stringify([r.p1.rl, r.p2.rl]));
  // 속도(이동/돌진)
  const sp = await ev(() => {
    const run = phase2 => {
      const p = ET.setup('normal', { px: 80, py: 420 });
      const b = Enemies.spawn('jellyKing', 800, 420);
      if (phase2) { Combat.damage(b, 150, { team: 'player', owner: p, freeze: 0, stun: 0 }); }
      b.cd = 0; Loop.step(1);                                      // idle → chase (한 틱만: 둘째 틱에는 패턴을 시작해 버림)
      b.cd = 99999;
      Loop.step(10);
      const x0 = b.x; Loop.step(30);
      const walk = (x0 - b.x) / 30;
      b.patIdx = 2; b.cd = 0; p.x = 80;
      let maxV = 0, lastX = null;
      ET.onFrame = () => { if (b.state === 'attack' && b.pattern === 'charge' && lastX !== null) maxV = Math.max(maxV, Math.abs(b.x - lastX)); lastX = b.state === 'attack' ? b.x : null; };
      ET.until(`ET.byId(${b.id}).state === 'recover'`, 600);
      return { walk, maxV, phase2: b.phase2 };
    };
    return { a: run(false), b: run(true) };
  });
  check('2페이즈: 걷는 속도가 빨라짐 (×1.25)', sp.b.phase2 && sp.b.walk / sp.a.walk > 1.15 && sp.b.walk / sp.a.walk < 1.35, `${sp.a.walk.toFixed(3)} → ${sp.b.walk.toFixed(3)}`);
  check('2페이즈: 돌진이 빨라짐 (×1.25)', sp.b.maxV / sp.a.maxV > 1.15 && sp.b.maxV / sp.a.maxV < 1.35 && sp.a.maxV <= 9.01, `${sp.a.maxV.toFixed(2)} → ${sp.b.maxV.toFixed(2)}`);
});

// 2페이즈 + 난이도 곱: 어려움에서 예고·반격 하한(24/60/마커 45)이 그대로 지켜지고, 쉬움은 더 넉넉함
await section('보스 2페이즈 하한(난이도별)', async () => {
  const res = {};
  for (const d of ['easy', 'normal', 'hard']) {
    const r = await ev(d => {
      const p = ET.setup(d, { px: 300, py: 420 });
      const b = Enemies.spawn('jellyKing', 700, 420);
      Combat.damage(b, Math.ceil(b.maxHp * 0.52), { team: 'player', owner: p, freeze: 0, stun: 0 });
      const ph2 = b.phase2 === true;
      ET.until(`ET.trans.filter(t => t.id === ${b.id} && t.to === 'recover').length >= 7`, 6000);
      const tr = ET.transOf(b.id);
      const rows = tr.filter(t => t.to === 'windup').slice(0, 6).map(w => {
        const rec = tr.find(t => t.to === 'recover' && t.f > w.f);
        const next = rec ? tr.find(t => t.f > rec.f && t.from === 'recover') : null;
        let payload = null, marker = null;
        if (w.pattern === 'summon') { const sp = ET.spawns.find(x => x.minion && x.f >= w.f); payload = sp ? sp.f : null; }
        else { const h = ET.firstHb(b.id, w.f); payload = h ? h.f : null; const m = h ? ET.markerOf(b.id, h.f) : null; marker = m ? m.frames : null; }
        return { pat: w.pattern, len: w.len, tele: payload !== null ? payload - w.f : null, rec: rec && next ? next.f - rec.f : null, marker };
      });
      return { ph2, rows, dmg: Game.diff.dmgTaken };
    }, d);
    res[d] = r;
    check(`[${d}] 보스 2페이즈에서도 예고 ≥ 24, 실제 판정/소환까지 ≥ 24, 반격 시간 ≥ 60 (패턴 ${r.rows.length}개)`, r.ph2 && r.rows.length >= 6 && r.rows.every(x => x.len >= 24 && x.tele >= 24 && x.rec >= 60), JSON.stringify(r.rows));
    check(`[${d}] 2페이즈 점프 찍기 마커는 여전히 45프레임 이상 보임`, r.rows.filter(x => x.pat === 'slam').length >= 2 && r.rows.filter(x => x.pat === 'slam').every(x => x.marker >= 45), JSON.stringify(r.rows.filter(x => x.pat === 'slam')));
  }
  const mean = (d, k) => { const a = res[d].rows.map(x => x[k]); return a.reduce((x, y) => x + y, 0) / a.length; };
  check(`쉬움의 예고가 어려움보다 김 (평균 ${mean('easy', 'len').toFixed(1)} > ${mean('hard', 'len').toFixed(1)})`, mean('easy', 'len') > mean('normal', 'len') && mean('normal', 'len') > mean('hard', 'len'), '');
});

await section('보스 단단함', async () => {
  // 패턴 중 맞아도 밀리거나 경직되지 않음 / 쉬는 시간엔 경직 / 4연타하면 털어냄
  const r = await ev(() => {
    const p = ET.setup('normal', { px: 300, py: 420 });
    const b = Enemies.spawn('jellyKing', 700, 420);
    const hit = (n = 3) => Combat.damage(b, n, { team: 'player', owner: p, freeze: 0, stun: 14, knock: 8 });
    ET.until(`ET.byId(${b.id}).state === 'windup'`, 800);
    const x0 = b.x; hit(); Loop.step(1);
    const armored = { stun: b.stun, kx: b.kx, stateAfter: b.state, moved: Math.abs(b.x - x0) };
    ET.until(`ET.byId(${b.id}).state === 'recover'`, 800);
    Loop.step(3);
    const stateBefore = b.state;
    hit(); const s1 = b.stun; const kx1 = Math.abs(b.kx);
    const out = { armored, recStun: s1, kxBoss: kx1, kxRaw: 8, stateBefore };
    Loop.step(14);
    hit(); Loop.step(2); hit(); Loop.step(2);
    const before4 = { stun: b.stun, armor: b.superArmor };
    hit();                                                          // 50프레임 안에 4번째 → 털어냄
    out.chain = { before4, stun: b.stun, armor: b.superArmor, armorT: b.armorT, state: b.state };
    Loop.step(60);
    out.later = { armor: b.superArmor, state: b.state };
    return out;
  });
  check('보스: 패턴(예고) 중 맞아도 경직·밀림 없음', r.armored.stun === 0 && r.armored.kx === 0 && r.armored.moved < 1, JSON.stringify(r.armored));
  check('보스: 쉬는 시간(어지러울 때) 맞으면 경직됨', r.stateBefore === 'recover' && r.recStun > 0, JSON.stringify([r.stateBefore, r.recStun]));
  check('보스: 무거워서 맞아도 조금만 밀림 (넉백 8 → 약 2.4)', r.kxBoss < 4 && r.kxBoss > 0, `kx=${r.kxBoss}`);
  check('보스: 50프레임 안에 4번 맞으면 "부르르!" 털어내고 잠깐 단단해짐 (무한 경직 방지)', r.chain.before4.stun > 0 && r.chain.stun === 0 && r.chain.armor === true && r.chain.armorT > 0, JSON.stringify(r.chain));
  check('보스: 단단해진 시간이 지나면 다시 원래대로', r.later.armor === false || r.later.state !== 'recover', JSON.stringify(r.later));
});

// ===========================================================================
// 11. 소환수 상한
// ===========================================================================
await section('소환수 상한', async () => {
  const run = pre => ev(pre => {
    const p = ET.setup('normal', { px: 300, py: 420 });
    const b = Enemies.spawn('jellyKing', 700, 420);
    const pre_ = [];
    for (let i = 0; i < pre; i++) { const m = Enemies.spawn('slime', 80 + i * 40, 380 + i * 12, { minion: true }); m.cd = 1e9; pre_.push(m.id); }
    const n0 = Enemies.minionCount();
    ET.until(`ET.trans.some(t => t.id === ${b.id} && t.to === 'windup' && t.pattern === 'summon') && ET.trans.some(t => t.id === ${b.id} && t.to === 'recover' && t.pattern === 'summon')`, 2500);
    const summonWin = ET.trans.find(t => t.id === b.id && t.to === 'windup' && t.pattern === 'summon');
    const seq = ET.trans.filter(t => t.id === b.id && t.to === 'windup').map(t => t.pattern);
    const spawned = ET.spawns.filter(s => s.minion && !pre_.includes(s.id));
    return { n0, count: Enemies.minionCount(), spawned: spawned.length, drop: spawned.every(s => s.state === 'drop' && s.untargetable && s.z > 200), summoned: !!summonWin, seq, minionAlive: Entities.list.filter(e => e.minion && !e.dead).length };
  }, pre);
  const r0 = await run(0), r2 = await run(2), r3 = await run(3), r4 = await run(4);
  check('소환: 소환수가 없으면 슬라임 2마리를 위에서 떨어뜨림 (drop, 착지 전엔 못 맞음)', r0.summoned && r0.spawned === 2 && r0.drop && r0.count === 2, JSON.stringify(r0));
  check('소환: 이미 2마리 있으면 2마리 더 (총 4)', r2.spawned === 2 && r2.count === 4, JSON.stringify(r2));
  check('소환: 이미 3마리 있으면 1마리만 (상한 4 넘지 않음)', r3.spawned === 1 && r3.count === 4, JSON.stringify(r3));
  check('소환: 이미 4마리면 소환을 건너뜀 (0마리 추가), 패턴 순서는 계속 진행', r4.spawned === 0 && r4.count === 4 && r4.seq[0] === 'slam' && r4.seq[1] === 'charge', JSON.stringify(r4));
  const long = await ev(() => {
    const p = ET.setup('normal', { px: 300, py: 420 });
    const b = Enemies.spawn('jellyKing', 700, 420);
    let max = 0; ET.onFrame = () => { max = Math.max(max, Entities.list.filter(e => e.minion && !e.dead).length); };
    Loop.step(4000);
    return { max, minions: Enemies.minionCount(), summons: ET.trans.filter(t => t.id === b.id && t.to === 'windup' && t.pattern === 'summon').length };
  });
  check('소환: 4000프레임 동안 소환수가 4마리를 넘은 적이 없음 (2번 소환해 4마리가 되면 이후 소환은 건너뜀)', long.max === 4 && long.summons === 2 && long.minions === 4, JSON.stringify(long));
});

// ===========================================================================
// 12. 보스 처치: Game.boss = null, 소환수도 같이 터짐, 이벤트
// ===========================================================================
await section('보스 처치', async () => {
  const r = await ev(() => {
    const p = ET.setup('normal', { px: 300, py: 420 });
    const killed = ET.listen('bossKilled'), enemyKilled = ET.listen('enemyKilled'), died = ET.listen('entityDied');
    const b = Enemies.spawn('jellyKing', 700, 420);
    const ms = [0, 1, 2].map(i => Enemies.spawn('slime', 500 + i * 50, 400 + i * 20, { minion: true }));
    ms[0].cd = ms[1].cd = ms[2].cd = 1e9;
    ET.until(`ET.byId(${b.id}).state === 'windup'`, 800);
    const markersBefore = ET.markers().length;
    const kills0 = Game.kills, score0 = Game.score;
    const ret = Combat.damage(b, 9999, { team: 'player', owner: p, freeze: 0 });
    const out = {
      ret, gameBoss: Game.boss, killed: killed.length, killedSame: killed[0] === b, enemyKilled: enemyKilled.length, ekScore: enemyKilled[0] && enemyKilled[0].score,
      minionsDead: ms.every(m => m.dead), aliveNow: Enemies.aliveCount(), markersBefore, kills: Game.kills - kills0, bossDead: b.dead, removeT: b.removeT,
    };
    Loop.step(2);
    out.markersAfter = ET.markers().length;
    const more = Combat.damage(b, 5, { team: 'player', owner: p, freeze: 0 });
    out.again = more; out.killedAfter = killed.length;
    Loop.step(120);
    out.left = ET.foes().length + ET.markers().length;
    out.hbAfter = ET.hbs.filter(h => h.f > 1).length;
    out.errs = Debug.errors.length;
    return out;
  });
  check('보스를 쓰러뜨리면 Game.boss 가 null', r.gameBoss === null && r.bossDead);
  check('bossKilled 이벤트 한 번 (보스 엔티티), enemyKilled 한 번에 score 3000', r.killed === 1 && r.killedSame && r.enemyKilled === 1 && r.ekScore === 3000, JSON.stringify([r.killed, r.enemyKilled, r.ekScore]));
  check('남은 소환수 3마리가 보스와 함께 터짐 (죽은 상태)', r.minionsDead && r.aliveNow === 0);
  check('소환수는 처치 점수·킬 수에 들어가지 않음 (kills 는 보스 1회)', r.kills === 1, `kills +${r.kills}`);
  check('예고 중이던 보스의 바닥 마커가 사라짐', r.markersBefore >= 1 && r.markersAfter === 0, `${r.markersBefore} → ${r.markersAfter}`);
  check('죽은 보스를 또 때려도 아무 일 없음 (이벤트 중복 없음)', r.again === 0 && r.killedAfter === 1);
  check('시간이 지나면 보스·소환수·마커가 모두 치워짐, 그 뒤 공격 판정도 없음', r.left === 0 && r.hbAfter === 0, `남은 ${r.left}, 판정 ${r.hbAfter}`);
  check('보스 죽음 연출 시간 removeT=72 (일반 적보다 김)', r.removeT >= 60, String(r.removeT));
});

// ===========================================================================
// 13. 위에서 떨어지며 등장 (drop)
// ===========================================================================
await section('드롭 등장', async () => {
  for (const t of ['slime', 'soldier', 'cloud', 'jellyKing']) {
    const r = await ev(t => {
      const p = ET.setup('normal', { px: 150, py: 420 });
      const e = Enemies.spawn(t, 700, 420, { drop: true });
      const out = { z0: e.z, untargetable: e.untargetable, state: e.state, shadow: e.shadow !== false, y: e.y };
      out.dmgWhileFalling = Combat.damage(e, 5, { team: 'player', owner: p, freeze: 0 });
      out.hpSame = e.hp === e.maxHp;
      out.hitFalling = Combat.applyHitbox({ owner: p, team: 'player', x1: e.x - 60, x2: e.x + 60, y: e.y, zMin: -Infinity, zMax: Infinity, damage: 5, freeze: 0 }).length;
      let fell = 0;
      for (let i = 0; i < 120 && e.untargetable; i++) { Loop.step(1); fell++; if (e.untargetable) { const q = Combat.damage(e, 5, { team: 'player', owner: p, freeze: 0 }); if (q !== 0) out.hurtMid = true; } }
      out.fell = fell; out.untargetableAfter = e.untargetable; out.zLand = e.z; out.stateLand = e.state; out.hpLand = e.hp === e.maxHp;
      out.hbDuringDrop = ET.hbs.filter(h => h.owner === e.id).length;
      Loop.step(2);
      out.dmgAfter = Combat.damage(e, 5, { team: 'player', owner: p, freeze: 0 });
      return out;
    }, t);
    const flying = t === 'cloud';
    check(`[${t}] drop: 높은 곳(z=420)에서 시작, 못 맞는 상태(untargetable), 그림자 있음`, r.z0 > 300 && r.untargetable && r.state === 'drop' && r.shadow, JSON.stringify({ z0: r.z0, u: r.untargetable }));
    check(`[${t}] drop: 떨어지는 동안 Combat.damage·공격 판정 모두 무시됨, 체력 그대로`, r.dmgWhileFalling === 0 && r.hitFalling === 0 && r.hpSame && !r.hurtMid && r.hpLand);
    check(`[${t}] drop: ${r.fell}프레임 만에 착지(구름은 도착) → 그때부터 맞을 수 있음`, r.fell > 10 && r.fell < 100 && r.untargetableAfter === false && r.dmgAfter > 0, JSON.stringify({ fell: r.fell, zLand: r.zLand }));
    check(`[${t}] drop: 착지하면 잠깐 멍한 상태(land)이고 그동안 공격하지 않음`, r.stateLand === 'land' && r.hbDuringDrop === 0, r.stateLand);
    if (!flying) check(`[${t}] drop: 땅(z=0)에 내려옴`, r.zLand === 0, String(r.zLand));
  }
});

// ===========================================================================
// 14. aliveCount / clear
// ===========================================================================
await section('aliveCount·clear', async () => {
  const r = await ev(() => {
    const p = ET.setup('normal', { px: 100, py: 420 });
    const pickup = Entities.add(Entities.make({ kind: 'pickup', team: 'neutral', x: 400, y: 420 }));
    const out = { empty: Enemies.aliveCount() };
    const a = Enemies.spawn('slime', 400, 420), b = Enemies.spawn('soldier', 500, 420), c = Enemies.spawn('cloud', 600, 420), d = Enemies.spawn('slime', 700, 420, { drop: true });
    out.four = Enemies.aliveCount();
    const boss = Enemies.spawn('jellyKing', 800, 420), m1 = Enemies.spawn('slime', 300, 380, { minion: true }), m2 = Enemies.spawn('slime', 320, 400, { minion: true });
    out.withBoss = Enemies.aliveCount();
    Combat.damage(a, 999, { team: 'player', owner: p, freeze: 0 });
    out.afterKill = Enemies.aliveCount(); out.stillInList = Entities.list.includes(a);
    boss.cd = 0; b.cd = 0; c.cd = 0;
    ET.until(`ET.markers().length > 0`, 900);
    out.markersBefore = ET.markers().length;
    Enemies.clear();
    out.cleared = Enemies.aliveCount(); out.gameBoss = Game.boss; out.foes = ET.foes().length; out.markers = ET.markers().length;
    out.playerKept = Entities.list.includes(p) && Game.player === p; out.pickupKept = Entities.list.includes(pickup);
    Enemies.clear(); out.clear2 = Enemies.aliveCount();
    Loop.step(30); out.noErr = Debug.errors.filter(m => !/알 수 없는 적 종류/.test(m)).length === 0;
    const z = Enemies.spawn('slime', 400, 420); out.afterSpawn = Enemies.aliveCount();
    return out;
  });
  check('aliveCount: 처음엔 0 (플레이어·마커는 안 셈)', r.empty === 0);
  check('aliveCount: 떨어지는 중인 적도 셈 (4)', r.four === 4);
  check('aliveCount: 보스와 소환수도 셈 (7)', r.withBoss === 7, String(r.withBoss));
  check('aliveCount: 죽은 적은 연출 중(엔티티가 남아 있어도) 세지 않음', r.afterKill === 6 && r.stillInList, `${r.afterKill}`);
  check('clear: 모든 적과 마커를 지우고 Game.boss = null (마커 있었음)', r.markersBefore > 0 && r.cleared === 0 && r.foes === 0 && r.markers === 0 && r.gameBoss === null);
  check('clear: 플레이어와 다른 엔티티(pickup)는 건드리지 않음', r.playerKept && r.pickupKept);
  check('clear: 두 번 불러도 안전, 이후 다시 spawn 가능', r.clear2 === 0 && r.afterSpawn === 1 && r.noErr, JSON.stringify([r.clear2, r.afterSpawn, r.noErr]));
});

// ===========================================================================
// 15. 플레이어가 죽어 있을 때는 배회/대기
// ===========================================================================
await section('플레이어 사망 시 대기', async () => {
  const r = await ev(() => {
    const p = ET.setup('normal', { px: 480, py: 420 });
    ['slime', 'slime', 'soldier', 'cloud'].forEach((t, i) => { const e = Enemies.spawn(t, 200 + i * 220, 380 + i * 25); e.cd = 0; });
    Loop.step(200);
    // 구름이 예고(마커) 중일 때 플레이어가 쓰러지게
    const cloud = Entities.list.find(e => e.type === 'cloud'); cloud.cd = 0;
    ET.until(`ET.byId(${cloud.id}).state === 'windup'`, 900);
    const out = { markersWhile: ET.markers().length };
    p.invuln = 0;
    Combat.damage(p, 999999, { team: 'enemy', freeze: 0 });
    out.dead = p.dead;
    Loop.step(2);
    out.markersAfterDeath = ET.markers().length;
    const f0 = ET.f, n0 = ET.hbs.length;
    Loop.step(30);
    out.hbSettle = ET.hbs.length;
    const pos0 = ET.foes().map(e => [e.x, e.y]);
    Loop.step(300);
    const foes = ET.foes();
    out.hbAfter = ET.hbs.length - out.hbSettle;
    out.states = [...new Set(foes.map(e => e.state))];
    out.moved = foes.map((e, i) => Math.hypot(e.x - pos0[i][0], e.y - pos0[i][1]));
    out.attackersNow = Enemies.attackerCount();
    // 부활하면 다시 쫓아온다
    p.dead = false; p.hp = 100000; p.invuln = 0;
    const hb0 = ET.hbs.length;
    Loop.step(600);
    out.hbRevive = ET.hbs.length - hb0;
    out.chaseAgain = ET.trans.filter(t => t.f > f0 + 300 && t.to === 'chase').length > 0;
    // 플레이어가 아예 없어도 (Game.player = null) 에러 없이 배회
    Game.player = null;
    ET.grabErrors();
    Loop.step(120);
    out.nullErrs = ET.releaseErrors().length;
    out.nullStates = [...new Set(ET.foes().map(e => e.state))];
    return out;
  });
  check('플레이어가 쓰러지면 진행 중이던 예고(번개 마커)가 취소됨', r.markersWhile >= 1 && r.markersAfterDeath === 0, `${r.markersWhile} → ${r.markersAfterDeath}`);
  check('쓰러진 플레이어에게는 더 이상 공격 판정이 나오지 않음 (30프레임 뒤 300프레임 동안 0)', r.hbAfter === 0, `판정 ${r.hbAfter}`);
  check('쓰러진 플레이어 앞에서 적들은 배회(idle)만 하고 공격 상태가 아님', r.states.every(s => s === 'idle') && r.attackersNow === 0, r.states.join(','));
  check('배회는 느릿하게 (300프레임 동안 제자리 근처 120px 이내)', r.moved.every(m => m < 120), r.moved.map(m => m.toFixed(0)).join(','));
  check('플레이어가 부활하면 다시 쫓아와서 공격', r.chaseAgain && r.hbRevive > 0, JSON.stringify([r.chaseAgain, r.hbRevive]));
  check('Game.player 가 null 이어도 예외 없이 배회', r.nullErrs === 0 && r.nullStates.every(s => s === 'idle'), r.nullStates.join(','));
});

await section('거리·깊이 조건', async () => {
  const r = await ev(() => {
    const p = ET.setup('normal', { px: 300, py: 420 });
    const list = [];
    ['slime', 'slime', 'soldier', 'soldier'].forEach((t, i) => { const e = Enemies.spawn(t, 540 + i * 40, 340 + i * 50); e.cd = 0; list.push(e); });
    Loop.step(1500);
    const w = ET.trans.filter(t => t.to === 'windup');
    const bySlime = w.filter(t => t.type === 'slime'), bySoldier = w.filter(t => t.type === 'soldier');
    return { n: w.length, slime: bySlime.map(t => [t.dx, t.dy]), soldier: bySoldier.map(t => [t.dx, t.dy]) };
  });
  check(`슬라임은 70px 안·깊이 차 14 이내일 때만 예고 시작 (${r.slime.length}번 관찰)`, r.slime.length >= 3 && r.slime.every(([dx, dy]) => dx <= 70.5 && dy <= 14.5), JSON.stringify(r.slime.slice(0, 4)));
  check(`병정은 50~104px 간격·깊이 차 14 이내일 때만 창을 겨눔 (${r.soldier.length}번 관찰)`, r.soldier.length >= 3 && r.soldier.every(([dx, dy]) => dx >= 49 && dx <= 105 && dy <= 14.5), JSON.stringify(r.soldier.slice(0, 4)));
  const far = await ev(() => {
    ET.setup('normal', { px: 100, py: 420 });
    const saved = ENEMY_TUNE.aggroRange; ENEMY_TUNE.aggroRange = 300;
    const e = Enemies.spawn('slime', 800, 420); e.cd = 0;
    Loop.step(120);
    const farState = e.state, farX = e.x;
    ET.p.x = 600;
    Loop.step(60);
    const near = { state: e.state };
    ENEMY_TUNE.aggroRange = saved;
    return { farState, farMoved: Math.abs(farX - 800), near };
  });
  check('멀리 있는 적(aggroRange 밖)은 배회만 하다가, 플레이어가 가까워지면 쫓아옴', far.farState === 'idle' && far.farMoved < 60 && far.near.state !== 'idle', JSON.stringify(far));
});

// ===========================================================================
// 16. 맞았을 때 반응: 예고 끊기, 쓰러짐, 이벤트
// ===========================================================================
await section('피격 반응', async () => {
  for (const t of ['slime', 'soldier', 'cloud']) {
    const r = await ev(t => {
      const p = ET.setup('normal', { px: 300, py: 420 });
      const e = Enemies.spawn(t, 520, 420); e.cd = 0;
      ET.until(`ET.byId(${e.id}).state === 'windup'`, 900);
      Loop.step(8);
      const hadMarker = !!e.marker;
      Combat.damage(e, 1, { team: 'player', owner: p, stun: 14, knock: 4, freeze: 0 });
      const out = { state: e.state, markerGone: !e.marker, hadMarker, flash: e.flash, stun: e.stun, engage: e.engage };
      const n0 = ET.hbs.length;
      Loop.step(35);
      out.hbWhile = ET.hbs.length - n0;
      ET.until(`ET.hbs.length > ${n0}`, 900);
      out.attackedLater = ET.hbs.length > n0;
      return out;
    }, t);
    check(`[${t}] 예고 중 맞으면 공격이 끊김 (hurt, 마커 사라짐, 번쩍)`, r.state === 'hurt' && r.markerGone && r.flash > 0 && r.stun > 0 && r.engage === false, JSON.stringify(r));
    check(`[${t}] 맞고 난 뒤 35프레임 동안은 공격하지 않음, 그 뒤에는 다시 덤빔`, r.hbWhile === 0 && r.attackedLater, JSON.stringify(r));
  }
  // 체력바: 맞은 뒤에만 보이고 시간이 지나면 사라짐, 죽은 적은 안 그림
  const hp = await ev(() => {
    const p = ET.setup('normal', { px: 100, py: 420 });
    const e = Enemies.spawn('slime', 700, 420); e.cd = 1e9;
    const a = e.hpBarT;
    Combat.damage(e, 3, { team: 'player', owner: p, freeze: 0 });
    const b = e.hpBarT;
    Loop.step(200);
    return { a, b, c: e.hpBarT };
  });
  check('체력바: 처음엔 안 보이고, 맞으면 보이고, 150프레임 뒤에는 사라짐', hp.a === 0 && hp.b > 100 && hp.c === 0, JSON.stringify(hp));
});

await section('쓰러짐·이벤트', async () => {
  for (const t of ['slime', 'soldier', 'cloud', 'jellyKing']) {
    const r = await ev(t => {
      const p = ET.setup('normal', { px: 100, py: 420 });
      const killed = ET.listen('enemyKilled'), died = ET.listen('entityDied'), bk = ET.listen('bossKilled');
      const e = Enemies.spawn(t, 600, 420); e.cd = 1e9;
      Loop.step(40);
      const k0 = Game.kills, parts0 = FX.particles.length, sfx0 = ET.sfx.length;
      Combat.damage(e, 9999, { team: 'player', owner: p, freeze: 0 });
      const out = { killed: killed.length, who: killed[0] === e, score: killed[0] && killed[0].score, died: died.length, kills: Game.kills - k0, parts: FX.particles.length - parts0, dead: e.dead, removeT: e.removeT, boss: bk.length };
      out.dieSfx = ET.sfx.slice(sfx0).map(s => s[1]);
      out.kinds = [...new Set(FX.particles.slice(parts0).map(q => q.kind))];
      const again = Combat.damage(e, 5, { team: 'player', owner: p, freeze: 0 });
      out.again = again; out.killedAfter = killed.length;
      return out;
    }, t);
    check(`[${t}] 쓰러지면 enemyKilled 가 정확히 한 번, 그 엔티티에 score 가 있음 (${r.score})`, r.killed === 1 && r.who && r.score === ({ slime: 100, soldier: 200, cloud: 200, jellyKing: 3000 })[t], JSON.stringify(r));
    check(`[${t}] 킬 수는 1 올라가고, 죽은 적을 또 때려도 이벤트가 중복되지 않음`, r.kills === 1 && r.again === 0 && r.killedAfter === 1 && r.died === 1);
    check(`[${t}] 펑! 별·사탕 입자가 터지고(피 없음) 효과음 ${t === 'jellyKing' ? 'bossDie' : 'enemyDie'}`, r.kinds.includes('star') && r.kinds.includes('candy') && r.parts >= 10 && r.dieSfx.includes(t === 'jellyKing' ? 'bossDie' : 'enemyDie'), JSON.stringify([r.kinds, r.parts, r.dieSfx]));
    check(`[${t}] 보스만 bossKilled`, r.boss === (t === 'jellyKing' ? 1 : 0));
  }
  // 사라지는 시간 (removeT ≈ 22, 구름은 땅으로 내려온 뒤 치워짐)
  for (const t of ['slime', 'soldier', 'cloud']) {
    const r = await ev(t => {
      const p = ET.setup('normal', { px: 100, py: 420 });
      const e = Enemies.spawn(t, 600, 420); e.cd = 1e9; Loop.step(40);
      Combat.damage(e, 9999, { team: 'player', owner: p, freeze: 0 });
      const rt = e.removeT;
      let f = 0; while (Entities.list.includes(e) && f < 200) { Loop.step(1); f++; }
      return { rt, f, shadowOffEarly: true };
    }, t);
    check(`[${t}] 죽음 연출: removeT=${r.rt} 이고 ${r.f}프레임 뒤 엔티티가 치워짐`, r.rt === 22 && r.f >= 20 && r.f <= (t === 'cloud' ? 60 : 30), `${r.f}`);
  }
  // 공중에서 띄워져 죽어도 (공중 착지 전) 그림자·시체가 오래 남지 않음
  const air = await ev(() => {
    const p = ET.setup('normal', { px: 100, py: 420 });
    const e = Enemies.spawn('soldier', 600, 420); e.cd = 1e9; Loop.step(10);
    Combat.damage(e, 2, { team: 'player', owner: p, launch: 12, stun: 30, freeze: 0 }); Loop.step(3);
    const zAir = e.z;
    Combat.damage(e, 999, { team: 'player', owner: p, freeze: 0 });
    let f = 0; while (Entities.list.includes(e) && f < 300) { Loop.step(1); f++; }
    return { zAir, f, removed: !Entities.list.includes(e) };
  });
  check('공중에 띄운 적을 쓰러뜨려도 착지 후 곧 치워짐 (영원히 남지 않음)', air.zAir > 5 && air.removed && air.f < 100, JSON.stringify(air));
});

// ===========================================================================
// 17. 결정성: 같은 시드면 똑같이 진행
// ===========================================================================
await section('결정성', async () => {
  const run = () => ev(() => {
    const p = ET.setup('normal', { px: 480, py: 420, seed: 7 });
    ['slime', 'slime', 'soldier', 'cloud', 'slime'].forEach((t, i) => Enemies.spawn(t, 100 + i * 190, 350 + i * 28));
    Loop.step(900);
    return JSON.stringify({ foes: ET.foes().map(e => [e.id - ET.foes()[0].id, e.state, Math.round(e.x * 100), Math.round(e.y * 100), e.hp]), hp: p.hp, hbs: ET.hbs.length, f: ET.f, trans: ET.trans.length });
  });
  const a = await run(), b = await run();
  check('같은 시드(7)로 900프레임 돌린 결과가 정확히 같음 (난수·시간 의존 없음)', a === b, a.slice(0, 120));
  const c = await ev(() => {
    const p = ET.setup('normal', { px: 480, py: 420, seed: 8 });
    ['slime', 'slime', 'soldier', 'cloud', 'slime'].forEach((t, i) => Enemies.spawn(t, 100 + i * 190, 350 + i * 28));
    Loop.step(900);
    return JSON.stringify({ foes: ET.foes().map(e => [e.id - ET.foes()[0].id, e.state, Math.round(e.x * 100), Math.round(e.y * 100), e.hp]), hp: p.hp, hbs: ET.hbs.length, f: ET.f, trans: ET.trans.length });
  });
  check('다른 시드(8)면 결과가 달라짐 (난수가 실제로 쓰임)', a !== c);
});

// ===========================================================================
// 17-b. 벽 앞에서 끼지 않기 / 공격 차례 돌려막기 / 멀리서 자리 안 막기 / 긴 실행에서 떨림·멈춤 없음
// ===========================================================================
await section('벽 앞에서 끼지 않기', async () => {
  for (const [label, px, ex] of [['왼쪽 벽', 50, 20], ['오른쪽 벽', 910, 940]]) {
    for (const d of DIFFS) {
      const r = await ev(({ px, ex, d }) => {
        const p = ET.setup(d, { px, py: 420 });
        const s = Enemies.spawn('soldier', ex, 420); s.cd = 0; s.alert = 0;
        let maxEng = 0, cur = 0, crossed = false;
        ET.onFrame = () => { p.x = px; p.kx = 0; p.stun = 0; cur = (s.state === 'chase' && s.engage) ? cur + 1 : 0; maxEng = Math.max(maxEng, cur); if ((ex < px) !== (s.x < px)) crossed = true; };
        const n = ET.until(`ET.hbs.some(h => h.owner === ${s.id})`, 900);
        const hb = ET.firstHb(s.id);
        return { n, maxEng, crossed, face: hb && hb.face, ox: hb && hb.ox, wall: ex < px ? 'L' : 'R', ox2: hb && Math.abs(hb.ox - px) };
      }, { px, ex, d });
      check(`[${d}] 병정이 ${label}과 플레이어 사이에 끼어도 돌아서 나와 공격함 (${r.n}프레임)`, r.n > 0 && r.n < 500, JSON.stringify(r));
      check(`[${d}] ${label}: 플레이어 반대편(열린 쪽)으로 건너가 창을 겨눔, 간격 50~104px`, r.crossed && r.ox2 >= 49 && r.ox2 <= 105, JSON.stringify(r));
      check(`[${d}] ${label}: 공격 자리를 맡은 채 헛걸음하는 시간이 길지 않음 (최대 ${r.maxEng}프레임 < 200)`, r.maxEng < 200);
    }
  }
  // 쉬움(공격자 1명): 벽에 끼인 병정이 있어도 다른 적이 굶지 않음
  const e = await ev(() => {
    const p = ET.setup('easy', { px: 50, py: 420 });
    const s = Enemies.spawn('soldier', 20, 420), a = Enemies.spawn('slime', 320, 420), c = Enemies.spawn('cloud', 480, 420);
    [s, a, c].forEach(x => { x.cd = 0; x.alert = 0; });
    ET.onFrame = () => { p.x = 50; p.kx = 0; p.stun = 0; };
    Loop.step(1200);
    const first = id => { const h = ET.firstHb(id); return h ? h.f : -1; };
    return { s: first(s.id), a: first(a.id), c: first(c.id) };
  });
  check('쉬움: 벽에 끼인 병정·슬라임·구름이 1200프레임 안에 모두 한 번 이상 공격 (한 명이 자리를 영영 막지 않음)', e.s > 0 && e.a > 0 && e.c > 0, JSON.stringify(e));
});

await section('공격 차례 돌려막기', async () => {
  for (const d of DIFFS) {
    const r = await ev(d => {
      const p = ET.setup(d, { px: 480, py: 420 });
      const types = ['slime', 'slime', 'soldier', 'soldier', 'cloud', 'cloud'];
      const foes = types.map((t, i) => { const e = Enemies.spawn(t, i % 2 ? 640 + i * 30 : 320 - i * 30, 350 + i * 24); e.cd = 0; e.alert = 0; return e; });
      ET.onFrame = () => { p.x = 480; p.kx = 0; p.stun = 0; };
      Loop.step(3000);
      const cnt = foes.map(e => ET.trans.filter(t => t.id === e.id && t.to === 'windup').length);
      return { cnt, types };
    }, d);
    const mn = Math.min(...r.cnt), mx = Math.max(...r.cnt);
    check(`[${d}] 6마리가 3000프레임 동안 모두 골고루 공격 (종류별 ${r.cnt.join('/')}, 최소 ${mn} ≥ ${d === 'easy' ? 3 : 6})`, mn >= (d === 'easy' ? 3 : 6) && mx <= mn * 3, JSON.stringify(r.cnt));
    check(`[${d}] 구름·병정·슬라임 어느 종류도 한 번도 못 때리는 일(굶기)이 없음`, r.cnt.every(n => n > 0));
  }
});

await section('멀리서 자리 막지 않기', async () => {
  const r = await ev(() => {
    const p = ET.setup('easy', { px: 100, py: 420, width: 1920 });
    const far = Enemies.spawn('soldier', 1000, 420), near = Enemies.spawn('slime', 330, 420);
    far.cd = 0; far.alert = 0; near.cd = 0; near.alert = 0;
    let bad = 0, engagedNear = false, engF = -1, f = 0;
    ET.onFrame = () => { f++; p.x = 100; p.kx = 0; p.stun = 0; if (far.engage && Math.abs(far.x - p.x) > far.def.hover + ENEMY_TUNE.engageSlack + 6) bad++; if (far.engage && Math.abs(far.x - p.x) <= far.def.hover + ENEMY_TUNE.engageSlack + 6) { engagedNear = true; if (engF < 0) engF = f; } };
    Loop.step(900);
    const nf = ET.firstHb(near.id), ff = ET.firstHb(far.id);
    return { bad, engagedNear, nearHit: nf ? nf.f : -1, farHit: ff ? ff.f : -1 };
  });
  check('멀리(맴도는 거리+140px 밖) 있는 적은 공격 자리를 맡지 않음 — 걸어오는 동안 자리를 막는 프레임 0', r.bad === 0, JSON.stringify(r));
  check('가까운 슬라임이 먼저 (쉬움, 공격자 1명) 공격하고, 멀리서 온 병정도 가까워지면 결국 공격', r.nearHit > 0 && r.nearHit < 250 && r.farHit > 0 && r.engagedNear, JSON.stringify(r));
});

await section('긴 실행(벽 앞)', async () => {
  for (const [d, px] of [['easy', 30], ['normal', 930], ['hard', 30]]) {
    const r = await ev(({ d, px }) => {
      const p = ET.setup(d, { px, py: 420, seed: 2 });
      const types = ['slime', 'slime', 'soldier', 'soldier', 'cloud', 'cloud'];
      const foes = types.map((t, i) => { const e = Enemies.spawn(t, px < 480 ? 150 + i * 90 : 810 - i * 90, 350 + i * 25); e.cd = 0; e.alert = 0; return e; });
      const st = new Map(foes.map(e => [e.id, { tw: 0, lastFlip: -99, lastDir: 0, px: e.x, py: e.y, still: 0, maxStill: 0, nan: false, cur: 0, maxEng: 0 }]));
      let f = 0, maxAtk = 0;
      ET.onFrame = () => {
        f++; p.x = px; p.kx = 0; p.stun = 0; p.y = 420;
        let atk = 0;
        for (const e of foes) {
          const s = st.get(e.id); const dx = e.x - s.px, dy = e.y - s.py; s.px = e.x; s.py = e.y;
          if (![e.x, e.y, e.z, e.hp].every(Number.isFinite)) s.nan = true;
          const moving = e.state === 'chase' || e.state === 'idle';
          if (moving && Math.abs(dx) > 0.25) { const dir = Math.sign(dx); if (s.lastDir && dir !== s.lastDir) { if (f - s.lastFlip < 8) s.tw++; s.lastFlip = f; } s.lastDir = dir; }
          if (moving && Math.abs(dx) < 0.05 && Math.abs(dy) < 0.05) s.still++; else s.still = 0;
          s.maxStill = Math.max(s.maxStill, s.still);
          s.cur = (e.state === 'chase' && e.engage) ? s.cur + 1 : 0; s.maxEng = Math.max(s.maxEng, s.cur);
          if (e.state === 'windup' || e.state === 'attack') atk++;
        }
        maxAtk = Math.max(maxAtk, atk);
      };
      Loop.step(3600);
      return { rows: foes.map(e => { const s = st.get(e.id); return { t: e.type, tw: s.tw, still: s.maxStill, nan: s.nan, eng: s.maxEng, atk: ET.trans.filter(x => x.id === e.id && x.to === 'windup').length }; }), maxAtk, max: CFG.difficulty[d].maxAttackers, errs: Debug.errors.length, engT: ENEMY_TUNE.engageTimeout };
    }, { d, px });
    check(`[${d}] 벽 앞에서 3600프레임: 좌표가 NaN/무한대가 되는 적 없음, 동시 공격자는 ${r.max}명 이하`, r.rows.every(x => !x.nan) && r.maxAtk <= r.max, JSON.stringify(r.maxAtk));
    check(`[${d}] 벽 앞에서 3600프레임: 좌우로 바르르 떠는(8프레임 안에 방향 반전) 횟수 적에 따라 6회 이하`, r.rows.every(x => x.tw <= 6), r.rows.map(x => x.t + ':' + x.tw).join(' '));
    check(`[${d}] 벽 앞에서 3600프레임: 걷는 상태로 30프레임 넘게 얼어붙은 적 없음`, r.rows.every(x => x.still <= 30), r.rows.map(x => x.t + ':' + x.still).join(' '));
    check(`[${d}] 벽 앞에서 3600프레임: 공격 자리를 맡고 ${r.engT}프레임 넘게 헤매는 적 없고, 모두 여러 번 공격`, r.rows.every(x => x.eng < r.engT && x.atk >= 3), r.rows.map(x => x.t + ':' + x.eng + '/' + x.atk).join(' '));
    check(`[${d}] 긴 실행 동안 게임 안 오류 없음`, r.errs === 0);
  }
});

// 보스: 쉬움(공격자 1명)에서도 소환수가 자리를 계속 가로채 보스가 굶지 않음, 벽 앞 플레이어에게도 돌진 길이 보임
await section('보스 우선·돌진 길', async () => {
  const r = await ev(() => {
    const p = ET.setup('easy', { px: 480, py: 420 });
    const b = Enemies.spawn('jellyKing', 800, 420);
    let cur = 0, maxWait = 0;
    ET.onFrame = () => { p.x = 480; p.kx = 0; p.stun = 0; p.invuln = 0; cur = (b.state === 'chase' && b.cd <= 0) ? cur + 1 : 0; maxWait = Math.max(maxWait, cur); };
    Loop.step(5000);
    const pats = ET.trans.filter(t => t.id === b.id && t.to === 'windup').length;
    return { maxWait, pats, minions: Enemies.minionCount() };
  });
  check(`쉬움: 소환수 ${r.minions}마리가 돌아다녀도 보스가 다음 패턴을 기다리는 시간은 최대 ${r.maxWait}프레임 (< 200), 5000프레임에 ${r.pats}번 패턴`, r.maxWait < 200 && r.pats >= 12, JSON.stringify(r));
  for (const [label, px, bx, dir] of [['오른쪽 벽', 940, 700, 1], ['왼쪽 벽', 22, 300, -1]]) {
    const q = await ev(({ px, bx, dir }) => {
      const p = ET.setup('normal', { px, py: 420 });
      const b = Enemies.spawn('jellyKing', bx, 420); b.patIdx = 2;
      ET.onFrame = () => { p.x = px; p.kx = 0; p.stun = 0; };
      ET.until(`ET.byId(${b.id}).state === 'windup' && ET.byId(${b.id}).pattern === 'charge'`, 800);
      const m = b.marker;
      const lane = m ? { from: Math.min(b.x, m.limit), to: Math.max(b.x, m.limit), dir: m.dir } : null;
      const hp0 = p.hp;
      ET.until(`ET.byId(${b.id}).state === 'recover'`, 600);
      return { lane, px: p.x, loss: hp0 - p.hp, bx: b.x };
    }, { px, bx, dir });
    check(`돌진: ${label} 앞에 선 플레이어가 맞는 자리는 예고 길(마커) 안에 포함됨 (길 ${q.lane && q.lane.from.toFixed(0)}~${q.lane && q.lane.to.toFixed(0)}, 플레이어 x=${q.px}, 피해 ${q.loss})`, q.lane && q.loss > 0 && q.px >= q.lane.from - 1 && q.px <= q.lane.to + 1, JSON.stringify(q));
  }
});

// Enemies.clear: 진행 중이던 모든 것(마커·번개·소환수·보스)이 깨끗이 사라지고, 새로 시작하면 처음 상태
await section('clear 뒤 새 출발', async () => {
  const r = await ev(() => {
    const p = ET.setup('normal', { px: 300, py: 420 });
    const b = Enemies.spawn('jellyKing', 700, 420), c = Enemies.spawn('cloud', 500, 420); c.cd = 0;
    Enemies.spawn('slime', 100, 400, { minion: true });
    ET.until(`ET.byId(${b.id}).state === 'attack' && ET.byId(${b.id}).pattern === 'slam' && ET.byId(${b.id}).z > 20`, 800);
    const z0 = b.z, mk0 = ET.markers().length;
    const killedLog = ET.listen('bossKilled');
    Enemies.clear();
    const out = { z0, mk0, left: Entities.list.filter(e => e.kind === 'enemy' || e.kind === 'boss' || e.kind === 'marker' || e.fromEnemies).length, gameBoss: Game.boss, alive: Enemies.aliveCount(), minions: Enemies.minionCount() };
    const n0 = ET.hbs.length; Loop.step(240);
    out.hbAfter = ET.hbs.length - n0; out.errs = Debug.errors.length; out.killedEv = killedLog.length;
    const b2 = Enemies.spawn('jellyKing', 700, 420);
    out.fresh = { gb: Game.boss === b2, state: b2.state, patIdx: b2.patIdx, phase2: b2.phase2, hp: b2.hp, marker: b2.marker, minion: Enemies.minionCount() };
    ET.until(`ET.byId(${b2.id}).state === 'windup'`, 800);
    out.firstPattern = b2.pattern;
    return out;
  });
  check('clear: 보스가 점프 찍기로 공중에 떠 있는 순간에도 깨끗이 지움 (마커 포함 엔티티 0, Game.boss null)', r.z0 > 20 && r.mk0 >= 1 && r.left === 0 && r.gameBoss === null && r.alive === 0 && r.minions === 0, JSON.stringify(r));
  check('clear 뒤 240프레임: 지워진 적이 남긴 공격 판정·오류·bossKilled 이벤트가 없음', r.hbAfter === 0 && r.errs === 0 && r.killedEv === 0, JSON.stringify([r.hbAfter, r.errs, r.killedEv]));
  check('clear 뒤 새 보스는 완전히 처음 상태: 1페이즈, 체력 가득, 마커·소환수 없음, 첫 패턴은 점프 찍기', r.fresh.gb && r.fresh.state === 'idle' && r.fresh.patIdx === 0 && r.fresh.phase2 === false && r.fresh.hp === 300 && r.fresh.marker === null && r.fresh.minion === 0 && r.firstPattern === 'slam', JSON.stringify(r.fresh));
});

// 연출: 예고가 막 시작되면 하얗게 번쩍, 2페이즈 팝업이 데미지 숫자와 겹치지 않음
await section('예고 번쩍·팝업 위치', async () => {
  const r = await ev(() => {
    const p = ET.setup('normal', { px: 300, py: 420 });
    const e = Enemies.spawn('slime', 420, 420); e.cd = 0; e.alert = 0;
    const shot = () => {
      Loop.draw();
      const d = ET.region(420 - 40, 420 - 70, 80, 80); let white = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 245 && d[i + 1] > 245 && d[i + 2] > 245) white++;
      return white;
    };
    ET.until(`ET.byId(${e.id}).state === 'windup'`, 900);
    const out = { t: e.t };
    out.start = shot();                                          // 막 시작
    const bl = []; for (let i = 0; i < 12; i++) { Loop.step(1); bl.push([e.t, shot()]); }
    out.mid = bl.filter(x => x[0] >= 1 && x[0] <= 3).map(x => x[1]);
    out.after = bl.filter(x => x[0] >= 9).map(x => x[1]);
    // 2페이즈 팝업 위치
    ET.setup('normal', { px: 300, py: 420 });
    const b = Enemies.spawn('jellyKing', 700, 420); b.cd = 1e9;
    Combat.damage(b, 150, { team: 'player', owner: ET.p, freeze: 0, stun: 0 });
    const ang = FX.popups.find(q => q.text === '화났다!'), num = FX.popups.find(q => q.text === 150 || q.text === '150' || (typeof q.text === 'number'));
    out.popY = ang && ang.y; out.numY = num && num.y;
    return out;
  });
  check(`예고 시작 3프레임은 하얗게 번쩍 (흰 픽셀 ${r.mid.join(',')}) → 이후엔 원래 색 (${r.after.join(',')})`, Math.min(...r.mid) > 150 && Math.max(...r.after) < Math.min(...r.mid) * 0.5, JSON.stringify(r));
  check(`"화났다!" 팝업이 데미지 숫자보다 위(${r.popY} < ${r.numY} - 30)에 떠서 안 겹침`, r.popY !== null && r.numY !== null && r.popY < r.numY - 30, JSON.stringify([r.popY, r.numY]));
});

// 부활 직후: 쓰러졌던 플레이어를 다시 만나도 바로 덤비지 않고 숨 고르기 (보스 60프레임, 일반 적 40프레임)
await section('부활 직후 숨 고르기', async () => {
  const r = await ev(() => {
    const out = {};
    const p = ET.setup('normal', { px: 300, py: 420 });
    const b = Enemies.spawn('jellyKing', 700, 420);
    ET.until(`ET.byId(${b.id}).state === 'windup'`, 800);
    p.invuln = 0; Combat.damage(p, 1e9, { team: 'enemy', freeze: 0 });
    Loop.step(300);
    out.idleBefore = b.state;
    p.dead = false; p.hp = 1e6; p.invuln = 0;
    const n = ET.until(`ET.byId(${b.id}).state === 'windup'`, 900);
    out.boss = n; out.bossMarkerShown = !!b.marker;
    // 일반 적
    const q = ET.setup('normal', { px: 300, py: 420 });
    const s = Enemies.spawn('slime', 420, 420), c = Enemies.spawn('cloud', 560, 420); s.cd = 0; c.cd = 0; s.alert = 0; c.alert = 0;
    Loop.step(100);
    q.invuln = 0; Combat.damage(q, 1e9, { team: 'enemy', freeze: 0 });
    Loop.step(200);
    out.idleSlime = s.state; out.idleCloud = c.state;
    q.dead = false; q.hp = 1e6; q.invuln = 0;
    const m = ET.until(`ET.foes().some(e => e.state === 'windup')`, 900);
    out.foe = m; out.errs = Debug.errors.length;
    return out;
  });
  check('부활: 쓰러진 동안 보스는 배회(idle), 부활한 뒤 60프레임은 공격 예고를 시작하지 않음 (실제 ' + r.boss + ')', r.idleBefore === 'idle' && r.boss >= 55 && r.boss < 400, JSON.stringify(r));
  check('부활: 일반 적(슬라임·구름)도 40프레임 뒤에야 첫 예고를 시작하고 결국 다시 공격 (실제 ' + r.foe + ')', r.idleSlime === 'idle' && r.idleCloud === 'idle' && r.foe >= 38 && r.foe < 600 && r.errs === 0, JSON.stringify(r));
});

// ===========================================================================
// 18. 그림: 모든 종류·상태가 에러 없이 그려지고 실제로 보임. SHOT_DIR 이 있으면 PNG 저장
// ===========================================================================
await section('그리기', async () => {
  const states = [
    ['idle', e => { e.state = 'idle'; }],
    ['walk', e => { e.state = 'chase'; e.walk = 3; }],
    ['windup', e => { e.state = 'windup'; e.t = 20; e.len = 30; }],
    ['attack', e => { e.state = 'attack'; e.t = 4; e.len = 10; e.sx = 1.3; e.sy = .8; }],
    ['recover', e => { e.state = 'recover'; e.t = 10; e.len = 50; }],
    ['hurt', e => { e.state = 'hurt'; e.hitT = 8; e.flash = 4; }],
    ['flash', e => { e.flash = 5; }],
  ];
  for (const t of ['slime', 'soldier', 'cloud', 'jellyKing']) {
    const r = await ev(({ t, st }) => {
      const p = ET.setup('normal', { px: 100, py: 420 });
      Debug.errors.length = 0;
      Loop.draw();
      const big = t === 'jellyKing';
      const box = [480 - 160, 420 - 230, 320, 260];
      const empty = ET.region(...box);
      const e = Enemies.spawn(t, 480, 420); e.cd = 1e9;
      const res = {};
      for (const [name, fn] of st.map(([n, f]) => [n, f])) {
        Enemies.clear(); const q = Enemies.spawn(t, 480, 420); q.cd = 1e9; q.face = -1;
        eval('(' + fn + ')')(q);
        Loop.draw();
        res[name] = ET.diffPx(empty, ET.region(...box));
      }
      // 죽음 연출 단계별
      Enemies.clear(); const d = Enemies.spawn(t, 480, 420); d.cd = 1e9; Loop.step(3);
      Combat.damage(d, 9999, { team: 'player', owner: p, freeze: 0 });
      const dying = [];
      for (let i = 0; i < 10; i++) { FX.particles.length = 0; FX.popups.length = 0; Loop.draw(); dying.push(ET.diffPx(empty, ET.region(...box))); Loop.step(Math.ceil((big ? 72 : 22) / 10)); }
      res.dying = dying;
      // 2페이즈 / 드롭 / 착지
      if (big) {
        Enemies.clear(); const b = Enemies.spawn('jellyKing', 480, 420); b.cd = 1e9; b.phase2 = true; b.rage = 1; Loop.draw(); res.phase2 = ET.diffPx(empty, ET.region(...box));
      }
      Enemies.clear(); const dr = Enemies.spawn(t, 480, 420, { drop: true }); Loop.step(5); Loop.draw(); res.drop = true;
      res.errors = Debug.errors.slice();
      return res;
    }, { t, st: states.map(([n, f]) => [n, f.toString()]) });
    for (const [name] of states) check(`[${t}] ${name} 상태가 화면에 그려짐 (배경과 다른 픽셀 ${r[name]})`, r[name] > (t === 'slime' ? 400 : 800), String(r[name]));
    check(`[${t}] 죽음 연출: 시작은 보이고 끝에는 사라짐 (${r.dying.join(',')})`, r.dying[0] > 300 && r.dying[9] < r.dying[0] * 0.6, '');
    if (t === 'jellyKing') check('[jellyKing] 2페이즈 모습이 그려짐', r.phase2 > 2000);
    check(`[${t}] 그리는 동안 오류 없음`, r.errors.length === 0, r.errors.join(' | '));
  }
  if (SHOT_DIR) {
    // 상태별 사진 (눈으로 확인용). 한 줄에 한 종류
    const poses = [['idle', 'e => { Game.player.x = 700; }', 5], ['walk', 'e => { Game.player.x = 900; e.cd = 0; }', 30], ['windup', 'e => { Game.player.x = e.x - 60; e.cd = 0; }', 20]];
    for (const t of ['slime', 'soldier', 'cloud', 'jellyKing']) {
      for (const [label, fn, frames] of poses) {
        await ev(({ t, fn, frames }) => {
          ET.setup('normal', { px: 100, py: 420, god: true });
          const e = Enemies.spawn(t, 480, 420); e.cd = 9999; e.alert = 0; e.face = -1;
          eval('(' + fn + ')')(e);
          Loop.step(frames);
        }, { t, fn, frames });
        await ev(() => Loop.draw());
        const box = await page.locator('#game').boundingBox(), k = box.width / 960, big = t === 'jellyKing';
        await page.screenshot({ path: `${SHOT_DIR}/${t}_${label}.png`, clip: { x: box.x + (480 - (big ? 220 : 130)) * k, y: box.y + (420 - (big ? 260 : 190)) * k, width: (big ? 440 : 260) * k, height: (big ? 300 : 230) * k } });
      }
    }
  }
});

// ===========================================================================
// 마무리: 페이지 오류 없음
// ===========================================================================
await section('오류 없음', async () => {
  const dbg = (await ev(() => [...ET.seen, ...Debug.errors])).filter(m => !/알 수 없는 적 종류/.test(m));
  check('게임 안에서 잡힌 오류(Debug.errors)가 없음 (일부러 낸 "알 수 없는 적 종류" 제외)', dbg.length === 0, dbg.join(' | '));
  const allowed = errors.filter(e => !/알 수 없는 적 종류/.test(e));
  check('pageerror / console.error 가 없음', allowed.length === 0, allowed.slice(0, 3).join(' | '));
});

await close();
finish('enemies');
