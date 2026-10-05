// player 모듈 테스트 (src/js_player.html)
//   실행: node tools/build-local.mjs --out dist/_player.html && GAME_HTML=dist/_player.html node tools/tests/player.test.mjs
//   스크린샷(상태 모음 시트)은 SHOT_DIR (기본: 임시 폴더/jd-player-shots) 에 저장돼요. 저장소 안에는 쓰지 않아요.
//
//   테스트는 자기만의 play 씬(Entities.updateAll → FX.update → Game.tickCombo)과 허수아비(dummy) 적을 써서
//   Stage/Enemies 가 없어도 돌아가요. (Enemies 가 구현돼 있으면 마지막에 실제 적과의 연동도 확인)
import { openGame } from '../lib/browser.mjs';
import { check, finish } from '../lib/check.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SHOT_DIR = process.env.SHOT_DIR || join(tmpdir(), 'jd-player-shots');
mkdirSync(SHOT_DIR, { recursive: true });

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const section = async (name, fn) => {            // 한 구역이 예외로 죽어도 나머지는 계속
  try { await fn(); } catch (e) { check(`[${name}] 구역이 예외 없이 끝남`, false, String(e && e.stack || e).split('\n').slice(0, 3).join(' | ')); }
};
// 피해량 ±10% 흔들림 범위 (커널: 반올림, 최소 1)
const lo = base => Math.max(1, Math.round(base * 0.9)), hi = base => Math.max(1, Math.round(base * 1.1));

const { page, errors, close } = await openGame();
const ev = (fn, arg) => page.evaluate(fn, arg);

// ----- 페이지 안 도우미 (TT) -----
await ev(() => {
  const T = window.TT = { sfx: [], fx: [], offs: [], tiles: [] };
  SFX.play = (n) => { T.sfx.push(n); };                                        // 효과음 이름만 기록 (소리는 안 남)
  ['flash', 'freeze', 'shake'].forEach(k => { const o = FX[k].bind(FX); FX[k] = (...a) => { T.fx.push([k, ...a]); return o(...a); }; });
  Scenes.play = {                                                              // 테스트용 play 씬 (Stage 의 권장 순서와 같음)
    update() { Entities.updateAll(); FX.update(); Game.tickCombo(); window.__upd++; },
    draw(ctx) {
      ctx.fillStyle = '#c8e6c9'; ctx.fillRect(0, 0, W, H);                      // 단색 배경 → 픽셀 검사가 쉬움
      ctx.save(); Cam.apply(ctx); Entities.drawAll(ctx); FX.drawWorld(ctx); ctx.restore(); FX.drawScreen(ctx);
    },
  };
  window.__upd = 0;
  // 깨끗한 판 + 주인공 만들기
  T.reset = (o = {}) => {
    T.offs.forEach(f => f()); T.offs = [];
    Entities.clear(); FX.clear(); Input.clear(); Loop.manual = true;
    Game.resetRun({ difficulty: o.difficulty || 'normal' });
    Game.world.width = o.width || 960; Cam.x = o.cam || 0;
    Debug.noVariance = o.noVariance !== false; Debug.god = false;
    RNG.seed(o.seed || 1);
    window.__upd = 0; T.sfx.length = 0; T.fx.length = 0;
    if (Game.scene !== 'play') Game.setScene('play');
    window.P = Player.create(o.x === undefined ? 200 : o.x, o.y === undefined ? 420 : o.y);
    return window.P;
  };
  // update 가 n 번 일어날 때까지 tick (히트스톱 틱은 세지 않음)
  T.run = n => { let c = 0, g = 0; while (c < n && g++ < 50000) { const b = window.__upd; Loop.tick(); if (window.__upd > b) c++; } return c; };
  T.tap = code => { Input.press(code); T.run(1); Input.release(code); };
  T.dummy = (x, y, o) => Entities.add(Entities.make(Object.assign({ kind: 'enemy', team: 'enemy', x, y, hp: 9999, maxHp: 9999, w: 40, h: 60,
    draw(ctx, e) {
      ctx.fillStyle = e.flash > 0 ? '#fff' : '#ff8ad8'; ctx.strokeStyle = '#2b1b3a'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.ellipse(e.x, e.y - e.z - 28, 22, 28, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    } }, o || {})));
  T.hits = () => { const log = []; const f = d => log.push({ id: d.target.id, dmg: d.dmg, z: d.target.z, team: d.target.team });
    Events.on('entityHit', f); T.offs.push(() => Events.off('entityHit', f)); return log; };
  T.events = names => { const log = []; names.forEach(n => { const f = d => log.push([n, d]); Events.on(n, f); T.offs.push(() => Events.off(n, f)); }); return log; };
  // 적이 플레이어를 때리는 판정 (커널과 똑같은 경로)
  T.enemyHit = (o = {}) => { const e = window.__foe || (window.__foe = Entities.make({ kind: 'enemy', team: 'enemy', x: P.x + 80, y: P.y }));
    return Combat.damage(P, o.dmg === undefined ? 10 : o.dmg, Object.assign({ owner: e, team: 'enemy' }, o.hb || {})); };
  T.px = (x, y) => { const d = Loop.canvas.getContext('2d').getImageData(Math.round(x * Loop.dpr), Math.round(y * Loop.dpr), 1, 1).data; return [d[0], d[1], d[2]]; };
  // 화면에서 배경과 다른 픽셀: 주인공 기준 좌/우 개수와 경계 상자
  T.ink = (x0, y0, w, h, darkOnly) => {                                         // darkOnly: 굵은 윤곽선(어두운 픽셀)만 셈 → 그림자·옅은 입자는 제외
    Loop.draw();
    const dpr = Loop.dpr, d = Loop.canvas.getContext('2d').getImageData(x0 * dpr, y0 * dpr, w * dpr, h * dpr).data, n = w * dpr;
    let L = 0, R = 0, minx = 1e9, maxx = -1, miny = 1e9, maxy = -1;
    for (let i = 0; i < d.length; i += 4) {
      if (darkOnly ? d[i] + d[i + 1] + d[i + 2] > 200 : Math.abs(d[i] - 200) + Math.abs(d[i + 1] - 230) + Math.abs(d[i + 2] - 201) < 24) continue;
      const px = (i / 4) % n, py = Math.floor(i / 4 / n);
      if (px / dpr < w / 2) L++; else R++;
      minx = Math.min(minx, px); maxx = Math.max(maxx, px); miny = Math.min(miny, py); maxy = Math.max(maxy, py);
    }
    return { L, R, bw: (maxx - minx + 1) / dpr, bh: (maxy - miny + 1) / dpr };
  };
  // 스크린샷 시트용 타일
  T.tile = (label, scale = 1.4) => {
    Loop.draw();
    const cx = P.x - 130, cy = P.y - P.z - 150, w = 280, h = 190, dpr = Loop.dpr;
    const c = document.createElement('canvas'); c.width = w * scale; c.height = h * scale + 16;
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    x.drawImage(Loop.canvas, cx * dpr, cy * dpr, w * dpr, h * dpr, 0, 0, w * scale, h * scale);
    x.fillStyle = '#000'; x.font = '12px sans-serif'; x.fillText(label, 4, h * scale + 12);
    T.tiles.push(c);
  };
  T.sheet = cols => {
    const it = T.tiles, w = it[0].width, h = it[0].height, rows = Math.ceil(it.length / cols);
    const c = document.createElement('canvas'); c.width = w * cols; c.height = h * rows;
    const x = c.getContext('2d'); x.fillStyle = '#ddd'; x.fillRect(0, 0, c.width, c.height);
    it.forEach((t, i) => x.drawImage(t, (i % cols) * w, Math.floor(i / cols) * h));
    T.tiles = [];
    return c.toDataURL('image/png');
  };
});

// ========================================================================================
await section('계약: Player.create / 엔티티 / PLAYER_DEF', async () => {
  const r = await ev(() => {
    TT.reset();
    const p = Game.player;
    const fxLayers = Entities.list.filter(e => e.kind === 'fx');
    return {
      same: p === P, inList: Entities.list.includes(p), kind: p.kind, team: p.team, persistent: p.persistent,
      w: p.w, h: p.h, hp: p.hp, maxHp: p.maxHp, atk: p.atk, state: p.state, face: p.face, clamp: p.clampWorld, shadow: p.shadow,
      hooks: ['tick', 'update', 'draw', 'onHit', 'onDeath', 'onLand'].every(k => typeof p[k] === 'function'),
      skills: p.skills.map(s => ({ ...s })),
      def: typeof PLAYER_DEF === 'object' && Array.isArray(PLAYER_DEF.combo) && PLAYER_DEF.combo.length === 3 && Array.isArray(PLAYER_DEF.skills),
      layerCount: fxLayers.length, layerTeam: fxLayers[0] && fxLayers[0].team, layerUntargetable: fxLayers[0] && fxLayers[0].untargetable,
      enemies: Entities.byTeam('enemy').length,
      at: Player.create(333, 444) && { x: Game.player.x, y: Game.player.y },
      keys: Object.keys(Player).sort(),
    };
  });
  check('Player.create 가 엔티티를 만들고 Entities 에 넣고 Game.player 로 설정', r.same && r.inList);
  check('kind player / team player / persistent', r.kind === 'player' && r.team === 'player' && r.persistent === true);
  check('몸 크기 40x80, hp/maxHp 100, atk 6', r.w === 40 && r.h === 80 && r.hp === 100 && r.maxHp === 100 && r.atk === 6);
  check('처음 상태 idle, 오른쪽을 봄', r.state === 'idle' && r.face === 1);
  check('커널 훅(tick/update/draw/onHit/onDeath/onLand)이 모두 있음', r.hooks);
  check('PLAYER_DEF 데이터 표(콤보 3타, 스킬 배열)가 있음', r.def);
  check('p.skills = A/S/D 3개 { id,key,label,icon,cdMax,cd }',
    r.skills.length === 3 && r.skills.map(s => s.key).join('') === 'ASD' &&
    r.skills.every(s => s.id && s.label && s.icon && s.cdMax > 0 && s.cd === 0) &&
    r.skills.map(s => s.cdMax).join() === '300,480,1800', JSON.stringify(r.skills.map(s => [s.key, s.cdMax])));
  check('이펙트 층(kind fx)은 중립 팀 + 피격 제외 → 적 목록에 섞이지 않음', r.layerCount === 1 && r.layerTeam === 'neutral' && r.layerUntargetable === true && r.enemies === 0);
  check('Player.create(x, y) 가 위치를 지정함', r.at.x === 333 && r.at.y === 444);
  check('공개 API: create / revive / heal', ['create', 'heal', 'revive'].every(k => r.keys.includes(k)), r.keys.join());
});

await section('이동·경계', async () => {
  const r = await ev(() => {
    const o = {};
    TT.reset(); Input.press('ArrowRight'); TT.run(10); o.right = { x: P.x, face: P.face, state: P.state };
    Input.release('ArrowRight'); TT.run(1); o.stop = { state: P.state, x: P.x };
    TT.reset(); Input.press('ArrowLeft'); TT.run(10); o.left = { x: P.x, face: P.face };
    TT.reset(); Input.press('ArrowDown'); TT.run(10); o.down = { y: P.y, face: P.face, x: P.x };
    TT.reset(); Input.press('ArrowUp'); TT.run(10); o.up = { y: P.y };
    TT.reset(); Input.press('ArrowRight'); Input.press('ArrowDown'); TT.run(10); o.diag = { x: P.x, y: P.y };
    TT.reset(); Input.press('ArrowRight'); Input.press('ArrowLeft'); TT.run(10); o.both = { x: P.x };
    // 경계
    TT.reset(); Input.press('ArrowLeft'); Input.press('ArrowUp'); TT.run(200); o.tl = { x: P.x, y: P.y };
    TT.reset(); Input.press('ArrowRight'); Input.press('ArrowDown'); TT.run(300); o.br = { x: P.x, y: P.y };
    TT.reset({ width: 1920 }); Input.press('ArrowRight'); TT.run(600); o.wide = { x: P.x };
    // 같은 이름 키가 계속 눌려도 상태가 걷기
    TT.reset(); Input.press('ArrowRight'); TT.run(3); o.walkState = P.state;
    return o;
  });
  check('→ 10프레임 = 40px (좌우 4px/프레임), 오른쪽을 보고 walk', r.right.x === 240 && r.right.face === 1 && r.right.state === 'walk', JSON.stringify(r.right));
  check('키를 떼면 다음 프레임에 idle, 더 안 움직임', r.stop.state === 'idle' && r.stop.x === 240);
  check('← 10프레임 = -40px, 왼쪽을 봄', r.left.x === 160 && r.left.face === -1, JSON.stringify(r.left));
  check('↓ 10프레임 = +30px (깊이 3px/프레임), 방향은 안 바뀜', r.down.y === 450 && r.down.face === 1 && r.down.x === 200, JSON.stringify(r.down));
  check('↑ 10프레임 = -30px', r.up.y === 390, JSON.stringify(r.up));
  check('대각선은 두 축이 동시에 (4, 3)', r.diag.x === 240 && r.diag.y === 450, JSON.stringify(r.diag));
  check('좌우를 동시에 누르면 안 움직임', r.both.x === 200);
  check('왼쪽 위 경계: x = w/2 = 20, y = FLOOR_TOP = 330', r.tl.x === 20 && r.tl.y === 330, JSON.stringify(r.tl));
  check('오른쪽 아래 경계: x = 960-20 = 940, y = FLOOR_BOTTOM = 500', r.br.x === 940 && r.br.y === 500, JSON.stringify(r.br));
  check('넓은 방(1920): 오른쪽 끝 x = 1900', r.wide.x === 1900, String(r.wide.x));
});

await section('점프: 포물선·착지·공중 조종', async () => {
  const r = await ev(() => {
    const o = {};
    TT.reset();
    TT.tap('KeyX');
    o.afterTap = { vz: P.vz, z: P.z, state: P.state };
    let maxZ = 0, frames = 1, states = new Set([P.state]);
    while (P.z > 0 && frames < 200) { TT.run(1); frames++; maxZ = Math.max(maxZ, P.z); states.add(P.state); }
    o.maxZ = maxZ; o.air = frames; o.landState = P.state; o.landZ = P.z; o.states = [...states];
    TT.run(1); o.after = P.state; o.sq = P.sq;
    o.sfx = TT.sfx.slice();
    // 공중에서 또 X: 두 번 점프 안 됨
    TT.reset(); TT.tap('KeyX'); TT.run(10); const vz0 = P.vz; TT.tap('KeyX'); o.dbl = { before: vz0, after: P.vz };
    // 공중 조종 70%
    TT.reset(); TT.tap('KeyX'); const x0 = P.x, y0 = P.y; Input.press('ArrowRight'); Input.press('ArrowDown'); TT.run(10);
    o.steer = { dx: P.x - x0, dy: P.y - y0 };
    // 땅에서의 속도와 비교
    // 점프 중 방향 전환
    TT.reset(); TT.tap('KeyX'); Input.press('ArrowLeft'); TT.run(3); o.airFace = P.face;
    // 키를 꾹 눌러도(반복) 한 번만 점프
    TT.reset(); Input.press('KeyX'); TT.run(80); o.hold = { z: P.z, state: P.state };
    return o;
  });
  check('X: 같은 프레임에 vz=11 로 떠오름 (적분 후 z=11, vz=10.4), 상태 jump', near(r.afterTap.z, 11) && near(r.afterTap.vz, 10.4) && r.afterTap.state === 'jump', JSON.stringify(r.afterTap));
  check('점프 높이 약 106px (100~112)', r.maxZ > 100 && r.maxZ < 112, String(r.maxZ));
  check('공중에 약 38프레임 (36~40)', r.air >= 36 && r.air <= 40, String(r.air));
  check('공중에서는 상태 jump, 착지하면 z=0 으로 돌아옴', r.states.includes('jump') && r.landZ === 0);
  check('착지 후 한 프레임 뒤 idle', r.after === 'idle', r.after);
  check('착지하면 납작해짐(sq>0)', r.sq > 0.1, String(r.sq));
  check('효과음: jump → land', r.sfx.includes('jump') && r.sfx.includes('land') && r.sfx.indexOf('jump') < r.sfx.indexOf('land'), r.sfx.join());
  check('공중에서 X 를 또 눌러도 다시 안 뜸 (두 번 점프 없음)', r.dbl.after < r.dbl.before, JSON.stringify(r.dbl));
  check('공중 조종은 70% 속도: 10프레임 x +28, y +21', near(r.steer.dx, 28, 1e-6) && near(r.steer.dy, 21, 1e-6), JSON.stringify(r.steer));
  check('공중에서 방향을 바꿔 몸을 돌릴 수 있음', r.airFace === -1);
  check('X 꾹 누르기는 한 번만 점프 (착지 후 다시 안 뜸)', r.hold.z === 0 && r.hold.state === 'idle', JSON.stringify(r.hold));
});

await section('기본 콤보: 프레임 데이터·3타·버퍼', async () => {
  const r = await ev(() => {
    const o = {};
    // --- 프레임 데이터: 판정은 준비 5프레임 뒤 (누른 프레임이 0) ---
    TT.reset(); const d = TT.dummy(250, 420); const hits = TT.hits();
    TT.tap('KeyZ'); o.state1 = { state: P.state, type: P.act && P.act.type, step: P.act && P.act.step, t: P.act && P.act.t };
    TT.run(4); o.hp5 = d.hp; o.hits5 = hits.length;
    TT.run(1); o.hp6 = d.hp; o.hits6 = hits.length; o.dmg6 = hits[0] && hits[0].dmg; o.hitstop = FX.hitstop; o.kx = d.kx; o.stun = d.stun;
    o.swingSfx = TT.sfx.includes('swing'); o.hitSfx = TT.sfx.includes('hit');
    TT.run(10); o.hitsAfter = hits.length;                       // 판정이 3프레임 켜져 있어도 한 번 휘두르면 한 번만 맞음
    // --- 3타 연결 (후반에 누르기): 6, 6, 9 + 3타는 띄우기 ---
    TT.reset(); const d3 = TT.dummy(250, 420); const h3 = TT.hits(); const dm = [];
    TT.tap('KeyZ');
    TT.run(11); TT.tap('KeyZ');                                  // 1타의 t=12 (후반 40% 안)
    TT.run(5); o.step2 = { step: P.act && P.act.step, t: P.act && P.act.t };
    TT.run(11); TT.tap('KeyZ');                                  // 2타의 t=12
    TT.run(5); o.step3 = { step: P.act && P.act.step, t: P.act && P.act.t };
    { let g = 0; while (h3.length < 3 && g++ < 40) TT.run(1); o.hit3At = P.act && P.act.t; }   // 3타 준비(startup) 가 끝나 판정이 나올 때까지
    o.after3 = { hits: h3.map(h => h.dmg), vz: d3.vz, z: d3.z, stun: d3.stun, hitstop: FX.hitstop, kx: d3.kx, shake: T_shake() };
    function T_shake() { return TT.fx.filter(f => f[0] === 'shake').length; }
    TT.run(40); o.end = { act: P.act, state: P.state, step: P.step, combo: Game.combo.count };
    return o;
  });
  check('눌린 프레임이 곧바로 공격 시작 (state attack, act combo 1타)', r.state1.state === 'attack' && r.state1.type === 'combo' && r.state1.step === 0 && r.state1.t === 1, JSON.stringify(r.state1));
  check('판정은 준비 5프레임 뒤: 5번째 update 까지는 안 맞음', r.hp5 === 9999 && r.hits5 === 0, `hp ${r.hp5}`);
  check('6번째 update 에 정확히 6 피해 (atk 6 × 1.0)', r.hp6 === 9993 && r.hits6 === 1 && r.dmg6 === 6, `hp ${r.hp6} dmg ${r.dmg6}`);
  check('맞는 순간: 히트스톱 3프레임, 넉백, 경직(≥14), 효과음 swing+hit', r.hitstop === 3 && r.kx !== 0 && r.stun >= 14 && r.swingSfx && r.hitSfx, `hitstop ${r.hitstop} kx ${r.kx} stun ${r.stun}`);
  check('판정이 3프레임 켜져 있어도 한 번 휘두르면 한 번만 맞음 (hitSet)', r.hitsAfter === 1);
  check('1타 후반(t=12)에 누르면 틈 없이 2타가 이어짐 (18번째 update 에 act.step=1)', r.step2.step === 1 && r.step2.t === 1, JSON.stringify(r.step2));
  check('2타 후반에 누르면 3타가 이어짐', r.step3.step === 2 && r.step3.t === 1, JSON.stringify(r.step3));
  check('세 번 맞은 피해 = 6, 6, 9 (배율 1.0 / 1.0 / 1.5)', r.after3.hits.join() === '6,6,9', r.after3.hits.join());
  check('3타는 띄우기(vz>0 또는 공중) + 긴 경직(≥30) + 히트스톱 6 + 화면 흔들림', (r.after3.vz > 0 || r.after3.z > 0) && r.after3.stun >= 30 && r.after3.hitstop === 6 && r.after3.shake >= 1, JSON.stringify(r.after3));
  check('3타 판정은 준비(startup) 9프레임 뒤에 나옴 (1·2타의 5프레임보다 묵직)', r.hit3At === 10, String(r.hit3At));
  check('3타 후 동작이 끝나면 idle, 콤보 수 3', r.end.act === null && r.end.state === 'idle' && r.end.combo === 3, JSON.stringify(r.end));

  const q = await ev(() => {
    const o = {};
    // --- 일찍 누른 입력은 이어지지 않음 ---
    TT.reset(); TT.dummy(250, 420); TT.tap('KeyZ'); TT.run(1); TT.tap('KeyZ');   // 1타의 t=2 (너무 이름)
    TT.run(15);                                                                  // 총 18번째 update
    o.early = { act: P.act, state: P.state, step: P.step };
    TT.run(5); TT.tap('KeyZ'); o.earlyThen = { step: P.act && P.act.step };      // 그 뒤 다시 누르면 이어진 게 아니라 "다시" 이어서(링크 안이라 2타)
    // --- 입력이 전혀 없으면 콤보가 끊김 ---
    TT.reset(); TT.dummy(250, 420); TT.tap('KeyZ'); TT.run(17);
    o.idleAfter = { act: P.act, step: P.step, link: P.link };
    TT.run(20); o.reset = { step: P.step, link: P.link };
    TT.tap('KeyZ'); o.restart = { step: P.act && P.act.step };
    // --- 링크 구간: 끝난 뒤 몇 프레임 안에 누르면 이어짐 ---
    TT.reset(); TT.dummy(250, 420); TT.tap('KeyZ'); TT.run(17); TT.run(2); TT.tap('KeyZ'); o.linkIn = { step: P.act && P.act.step };
    TT.reset(); TT.dummy(250, 420); TT.tap('KeyZ'); TT.run(17); TT.run(12); TT.tap('KeyZ'); o.linkOut = { step: P.act && P.act.step };
    // --- 3타 후반(마지막 40%)에 누르면 1타부터 다시 (3타 다음 타는 없음) ---
    TT.reset(); TT.dummy(250, 420, { superArmor: true });
    TT.tap('KeyZ'); TT.run(11); TT.tap('KeyZ'); TT.run(16); TT.tap('KeyZ');         // 2타 후반에 눌러 3타 예약
    let g = 0; while (!(P.act && P.act.step === 2 && P.act.t >= 21) && g++ < 80) TT.run(1);   // 3타(총 30프레임)의 t=21 : 후반 40% 안
    const at = P.act && P.act.step === 2 ? P.act.t : -1; TT.tap('KeyZ');
    g = 0; while (P.act && P.act.step === 2 && g++ < 60) TT.run(1);
    o.wrap = { at, step: P.act && P.act.step, t: P.act && P.act.t };
    // --- 3타 후반인데 너무 일찍(t=3) 누르면 이어지지 않음 ---
    TT.reset(); TT.dummy(250, 420, { superArmor: true });
    TT.tap('KeyZ'); TT.run(11); TT.tap('KeyZ'); TT.run(16); TT.tap('KeyZ');
    g = 0; while (!(P.act && P.act.step === 2 && P.act.t === 3) && g++ < 80) TT.run(1);
    TT.tap('KeyZ'); g = 0; while (P.act && g++ < 80) TT.run(1);
    o.wrapEarly = { act: P.act, state: P.state };
    return o;
  });
  check('너무 일찍(t=2) 누른 입력은 다음 타로 이어지지 않음 → 동작이 끝나면 idle', q.early.act === null && q.early.state === 'idle', JSON.stringify({ s: q.early.state, step: q.early.step }));
  check('  (끝난 뒤 링크 안에서 다시 누르면 그때서야 2타)', q.earlyThen.step === 1, JSON.stringify(q.earlyThen));
  check('입력이 없으면 링크 시간이 지난 뒤 콤보가 끊김(step -1)', q.idleAfter.act === null && q.idleAfter.step === 0 && q.idleAfter.link > 0 && q.reset.step === -1 && q.reset.link === 0, JSON.stringify([q.idleAfter, q.reset]));
  check('끊긴 뒤에 누르면 다시 1타부터', q.restart.step === 0, JSON.stringify(q.restart));
  check('끝난 직후(링크 안)에 누르면 2타로 이어짐', q.linkIn.step === 1, JSON.stringify(q.linkIn));
  check('링크 시간(10프레임)이 지나서 누르면 1타부터 다시', q.linkOut.step === 0, JSON.stringify(q.linkOut));
  check('3타 후반에 누르면 1타로 돌아가 새 콤보 (3타 다음은 없음)', q.wrap.at >= 21 && q.wrap.step === 0 && q.wrap.t === 1, JSON.stringify(q.wrap));
  check('[부정] 3타 초반(t=3)에 누른 입력은 이어지지 않음 → 끝나면 idle', q.wrapEarly.act === null && q.wrapEarly.state === 'idle', JSON.stringify(q.wrapEarly));

  const m = await ev(() => {
    // --- 연타(7프레임마다): 6,6,9 가 반복 ---
    TT.reset(); TT.dummy(250, 420, { superArmor: true }); const h = TT.hits();
    for (let i = 0; i < 300; i++) { if (i % 7 === 0) Input.press('KeyZ'); else Input.release('KeyZ'); TT.run(1); }   // 한 바퀴 = 17+17+30 = 64프레임 → 300프레임이면 4바퀴 남짓
    Input.release('KeyZ');
    return { dmg: h.map(x => x.dmg) };
  });
  check('연타하면 6,6,9 가 계속 반복 (4바퀴 남짓 = 13번 이상)', m.dmg.length >= 13 && m.dmg.every((d, i) => d === [6, 6, 9][i % 3]), m.dmg.join());
});

await section('기본 콤보: 이동 불가·방향·판정 범위', async () => {
  const r = await ev(() => {
    const o = {};
    // 공격 중엔 방향키로 못 걷고 칼과 함께 살짝 파고들기만 함 (런지 3.2 × 6프레임)
    TT.reset(); Input.press('ArrowRight'); TT.tap('KeyZ'); TT.run(16);
    o.lunge = P.x - 200; o.stateAtk = P.state;
    TT.run(1); o.afterEnd = P.x;                                  // 끝나면 다시 걷기 시작
    TT.reset(); Input.press('ArrowRight'); TT.run(17); o.walk17 = P.x - 200;
    // 누른 방향으로 몸을 돌려서 공격, 공격 중엔 못 돌아봄
    TT.reset(); Input.press('ArrowLeft'); TT.tap('KeyZ'); o.turn = { face: P.face }; TT.run(3); Input.release('ArrowLeft'); Input.press('ArrowRight'); TT.run(5); o.lock = { face: P.face, x: P.x };
    // 뒤에 있는 적: 가만히 누르면 안 맞고, 뒤쪽 방향키를 누르며 공격하면 맞음
    TT.reset(); const back = TT.dummy(150, 420); TT.tap('KeyZ'); TT.run(15); o.backNo = back.hp;
    TT.reset(); const back2 = TT.dummy(150, 420); Input.press('ArrowLeft'); TT.tap('KeyZ'); TT.run(15); o.backYes = back2.hp;
    // 깊이: 40 달라서 안 맞음 / 20 달라서 맞음
    TT.reset(); const far = TT.dummy(250, 460); TT.tap('KeyZ'); TT.run(15); o.depthFar = far.hp;
    TT.reset(); const mid = TT.dummy(250, 440); TT.tap('KeyZ'); TT.run(15); o.depthNear = mid.hp;
    TT.reset(); const mid2 = TT.dummy(250, 400); TT.tap('KeyZ'); TT.run(15); o.depthNear2 = mid2.hp;
    // 높이: 공중(z=100)에 떠 있는 적은 땅 공격이 안 맞음
    TT.reset(); const sky = TT.dummy(250, 420, { z: 120, noGravity: true }); TT.tap('KeyZ'); TT.run(15); o.sky = sky.hp;
    TT.reset(); const cloud = TT.dummy(250, 420, { z: 92, h: 46, noGravity: true }); TT.tap('KeyZ'); TT.run(15); o.cloud = cloud.hp;     // 심술 구름 높이: 서서도 칠 수 있음
    TT.reset(); const low = TT.dummy(250, 420, { z: 30, noGravity: true }); TT.tap('KeyZ'); TT.run(15); o.low = low.hp;
    // 사거리
    TT.reset(); const edge = TT.dummy(300, 420); TT.tap('KeyZ'); TT.run(15); o.reachIn = edge.hp;
    TT.reset(); const out = TT.dummy(330, 420); TT.tap('KeyZ'); TT.run(15); o.reachOut = out.hp;
    // 런지는 적이 바로 앞이면 파고들지 않음 (겹쳐 서지 않게)
    TT.reset(); TT.dummy(230, 420, { superArmor: true }); TT.tap('KeyZ'); TT.run(10); o.blocked = P.x - 200;
    // 한 번 휘두르면 겹친 여러 적이 모두 맞음 (각자 한 번)
    TT.reset(); const a1 = TT.dummy(250, 420), a2 = TT.dummy(270, 425), a3 = TT.dummy(240, 415); TT.tap('KeyZ'); TT.run(15);
    o.multi = [a1.hp, a2.hp, a3.hp];
    // 같은 팀/중립은 안 맞음
    TT.reset(); const ally = TT.dummy(250, 420, { team: 'player', kind: 'pet' }), neutral = TT.dummy(240, 420, { team: 'neutral', kind: 'marker' }); TT.tap('KeyZ'); TT.run(15);
    o.friendly = [ally.hp, neutral.hp];
    return o;
  });
  check('공격 중엔 →를 눌러도 못 걸음: 17프레임 동안 런지만 +19.2px (걷기였다면 +68)', near(r.lunge, 19.2, 0.01) && near(r.walk17, 68, 0.01) && r.stateAtk === 'attack', `lunge ${r.lunge} walk ${r.walk17}`);
  check('동작이 끝나면 곧바로 걷기 재개 (+4px)', near(r.afterEnd - 200 - r.lunge, 4, 0.01), String(r.afterEnd));
  check('방향키를 누른 채 공격하면 그쪽으로 돌아서 공격', r.turn.face === -1);
  check('공격 중에는 반대 방향키를 눌러도 몸을 못 돌림(왼쪽으로 파고듦)', r.lock.face === -1 && r.lock.x < 200, JSON.stringify(r.lock));
  check('[부정] 뒤에 있는 적은 가만히 공격하면 안 맞음', r.backNo === 9999);
  check('뒤쪽 방향키를 누르며 공격하면 뒤의 적도 맞음', r.backYes === 9993, String(r.backYes));
  check('[부정] 깊이(y)가 40 다르면 안 맞음', r.depthFar === 9999);
  check('깊이가 ±20 다르면 맞음', r.depthNear === 9993 && r.depthNear2 === 9993, `${r.depthNear} ${r.depthNear2}`);
  check('[부정] 공중(z=120)에 떠 있는 적은 땅 공격이 안 맞음', r.sky === 9999);
  check('심술 구름 높이(z=92)는 서서 휘둘러도 맞음 (머리 위 14px 까지 닿음)', r.cloud === 9993, String(r.cloud));
  check('낮게 뜬 적(z=30)은 맞음', r.low === 9993);
  check('사거리 안(적 몸 끝이 닿음)은 맞고', r.reachIn === 9993);
  check('[부정] 사거리 밖은 안 맞음', r.reachOut === 9999);
  check('적이 바로 앞이면 그 앞에서 멈춰서 겹쳐 서지 않음 (런지 ≤ 8px)', r.blocked >= 0 && r.blocked <= 8, String(r.blocked));
  check('겹친 여러 적이 한 번에 각자 한 번씩 맞음', r.multi.every(h => h === 9993), r.multi.join());
  check('[부정] 같은 팀·중립은 안 맞음', r.friendly[0] === 9999 && r.friendly[1] === 9999);
});

await section('점프 공격·공중 콤보', async () => {
  const r = await ev(() => {
    const o = {};
    // 점프 → 공격: 아래로 내려찍는 판정 (배율 1.2 = 7.2 → 7)
    TT.reset(); const d = TT.dummy(260, 420); const h = TT.hits();
    TT.tap('KeyX'); TT.run(5); TT.tap('KeyZ');
    o.start = { state: P.state, type: P.act && P.act.type, z: P.z };
    TT.run(12); o.dmg = h.map(x => x.dmg); o.zAtHit = P.z;
    o.sfx = TT.sfx.slice();
    // 착지하면 점프 공격은 끝남
    TT.run(60); o.land = { state: P.state, act: P.act, z: P.z };
    // [부정] 사거리 밖 / 깊이 다름 / 너무 높이 떠 있음
    TT.reset(); const far = TT.dummy(420, 420), deep = TT.dummy(260, 480), sky = TT.dummy(260, 420, { z: 300, noGravity: true });
    TT.tap('KeyX'); TT.run(5); TT.tap('KeyZ'); TT.run(30);
    o.neg = [far.hp, deep.hp, sky.hp];
    // 공중 공격 중에도 살짝(50%) 조종
    TT.reset(); TT.tap('KeyX'); TT.run(5); TT.tap('KeyZ'); const x0 = P.x; Input.press('ArrowRight'); TT.run(6); o.steer = P.x - x0;
    // 올라가는 중에 눌러도 위로 더 솟구치지 않고 훅 꺾여 내려찍음 (점프 공격은 낮게 이어서 쓰는 기술)
    TT.reset(); TT.tap('KeyX'); TT.run(2); const vzUp = P.vz; TT.tap('KeyZ'); o.clamp = { before: vzUp, after: P.vz };
    // 땅에 있는 적에게도 맞음(낮은 점프)
    TT.reset(); const g = TT.dummy(250, 420); TT.tap('KeyX'); TT.tap('KeyZ'); TT.run(15); o.low = g.hp;
    return o;
  });
  check('점프 중 Z → 점프 공격 (state attack, act air)', r.start.state === 'attack' && r.start.type === 'air' && r.start.z > 0, JSON.stringify(r.start));
  check('점프 공격은 정확히 7 피해 (6 × 1.2 = 7.2)', r.dmg.join() === '7', r.dmg.join());
  check('효과음 jump → swing → hit', ['jump', 'swing', 'hit'].every(s => r.sfx.includes(s)), r.sfx.join());
  check('착지하면 점프 공격이 끝나고 idle', r.land.state === 'idle' && r.land.act === null && r.land.z === 0, JSON.stringify(r.land));
  check('[부정] 사거리 밖 / 깊이 다름 / 너무 높은 적은 안 맞음', r.neg.join() === '9999,9999,9999', r.neg.join());
  check('점프 공격 중 →: 6프레임 +12px (50% 조종)', near(r.steer, 12, 0.01), String(r.steer));
  check('낮은 점프로도 땅의 적을 맞힘', r.low < 9999);
  check('올라가는 중(vz>8)에 점프 공격을 쓰면 위로 솟구치지 않고 꺾여 내려옴 (vz ≤ 2)', r.clamp.before > 8 && r.clamp.after <= 2, JSON.stringify(r.clamp));

  const c = await ev(() => {
    const o = {};
    // 공중 콤보: 3타(띄우기) → 점프 → 점프 공격이 떠 있는 적에게 맞음
    TT.reset(); const d = TT.dummy(250, 420); const log = TT.hits();
    TT.tap('KeyZ'); TT.run(11); TT.tap('KeyZ'); TT.run(16); TT.tap('KeyZ');
    let g = 0; while (log.length < 3 && g++ < 30) TT.run(1);
    o.third = { dmg: log.map(l => l.dmg), vz: d.vz };
    // 3타가 맞은 직후 X → 후딜을 취소하고 점프
    TT.tap('KeyX'); o.cancel = { state: P.state, act: P.act, vz: P.vz, step: P.step };
    Input.press('ArrowRight'); TT.run(3);
    TT.tap('KeyZ'); TT.run(12);
    Input.release('ArrowRight');
    o.air = log.slice(3).map(l => ({ dmg: l.dmg, z: Math.round(l.z) }));
    o.combo = Game.combo.count;
    // 방향키 없이도(어린이 배려) 앞에 선 적(거리 60)을 3타로 띄운 뒤 바로 점프하면, 앞으로 살짝 따라붙어 점프 공격이 이어짐
    TT.reset({ x: 300 }); TT.dummy(360, 420); const l2 = TT.hits();
    TT.tap('KeyZ'); TT.run(11); TT.tap('KeyZ'); TT.run(16); TT.tap('KeyZ');
    let g2 = 0; while (l2.length < 3 && g2++ < 60) TT.run(1);
    TT.tap('KeyX'); o.hop = P.kx;
    for (let f = 0; f < 30; f++) { if (f === 3) Input.press('KeyZ'); if (f === 4) Input.release('KeyZ'); TT.run(1); }
    o.noSteer = l2.map(l => l.dmg);
    // [부정] 3타를 헛치면 점프로 취소되지 않음 (맞혔을 때만)
    TT.reset(); TT.tap('KeyZ'); TT.run(11); TT.tap('KeyZ'); TT.run(16); TT.tap('KeyZ'); TT.run(14);
    TT.tap('KeyX'); o.whiff = { state: P.state, type: P.act && P.act.type, z: P.z };
    // [부정] 1·2타는 맞혀도 점프 취소가 안 됨
    TT.reset(); TT.dummy(250, 420, { superArmor: true }); TT.tap('KeyZ'); TT.run(8); TT.tap('KeyX'); o.noCancel1 = { state: P.state, type: P.act && P.act.type };
    return o;
  });
  check('3타 = 6,6,9 로 띄운 뒤', c.third.dmg.join() === '6,6,9' && c.third.vz > 0, JSON.stringify(c.third));
  check('3타가 맞은 직후 X → 후딜을 취소하고 점프(공중, 콤보 기억 지움)', c.cancel.state === 'jump' && c.cancel.act === null && c.cancel.vz > 5 && c.cancel.step === -1, JSON.stringify(c.cancel));
  check('떠 있는 적(z>0)에게 점프 공격이 맞음 = 공중 콤보 (7 피해)', c.air.length === 1 && c.air[0].dmg === 7 && c.air[0].z > 0, JSON.stringify(c.air));
  check('점프 취소 때 앞으로 살짝 따라붙음(kx>0) → 방향키 없이도 거리 60 의 적에게 점프 공격이 이어짐 (6,6,9,7)', c.hop > 2 && c.noSteer.length === 4 && c.noSteer[3] === 7, JSON.stringify([c.hop, c.noSteer]));
  check('콤보 카운터가 4 로 이어짐 (6,6,9,7)', c.combo === 4, String(c.combo));
  check('[부정] 3타를 헛치면 X 로 후딜을 취소할 수 없음 (공격 중 이동 불가)', c.whiff.state === 'attack' && c.whiff.type === 'combo' && c.whiff.z === 0, JSON.stringify(c.whiff));
  check('[부정] 1타는 맞혀도 점프 취소 불가', c.noCancel1.state === 'attack' && c.noCancel1.type === 'combo', JSON.stringify(c.noCancel1));
});

await section('스킬: 피해 합계·범위·관통·전체', async () => {
  const r = await ev(() => {
    const o = {};
    // ---------- A 회오리 베기: 360°, 4번 × 3 = 합계 12 (2.0배) ----------
    TT.reset({ x: 400 });
    const front = TT.dummy(450, 420), behind = TT.dummy(350, 420), deepNear = TT.dummy(400, 460), deepFar = TT.dummy(400, 470), farX = TT.dummy(540, 420);
    const h = TT.hits();
    TT.tap('KeyA'); o.spinStart = { state: P.state, type: P.act.type, cd: P.skills[0].cd, sfx: TT.sfx.slice() };
    TT.run(7); o.spinT7 = { hp: 9999 - front.hp, z: front.z, vz: front.vz };            // 첫 판정 직후: 아직 안 띄움
    TT.run(40);
    const cnt = id => h.filter(x => x.id === id).length;
    o.spin = {
      front: 9999 - front.hp, behind: 9999 - behind.hp, deepNear: 9999 - deepNear.hp, deepFar: 9999 - deepFar.hp, farX: 9999 - farX.hp,
      hitsFront: cnt(front.id), hitsBehind: cnt(behind.id), dmgs: h.filter(x => x.id === front.id).map(x => x.dmg).join(),
      stunFront: front.stun, maxVz: front.vz,
    };
    // 마지막 바퀴에서 띄움: 다시 해서 마지막 판정 직후 확인
    TT.reset({ x: 400 }); const f2 = TT.dummy(450, 420); TT.tap('KeyA'); TT.run(7 + 18); o.spinLast = { z: f2.z, vz: f2.vz, hp: 9999 - f2.hp };
    // ---------- S 돌진 찌르기: 관통 2.5배 = 15 ----------
    TT.reset({ x: 100 });
    const t1 = TT.dummy(200, 420), t2 = TT.dummy(260, 420), t3 = TT.dummy(295, 425), tDeep = TT.dummy(200, 470), tFar = TT.dummy(700, 420);
    const h2 = TT.hits(); const x0 = P.x;
    TT.tap('KeyS'); o.thrustStart = { state: P.state, cd: P.skills[1].cd, sfx: TT.sfx.slice() };
    TT.run(40);
    const c2 = id => h2.filter(x => x.id === id).length;
    o.thrust = {
      d1: 9999 - t1.hp, d2: 9999 - t2.hp, d3: 9999 - t3.hp, deep: 9999 - tDeep.hp, far: 9999 - tFar.hp,
      n1: c2(t1.id), n2: c2(t2.id), n3: c2(t3.id), dx: P.x - x0, stun: t1.stun,
    };
    TT.reset({ x: 100 }); const l1 = TT.dummy(200, 420); TT.tap('KeyS'); TT.run(9 + 6); o.thrustLaunch = { vz: l1.vz, z: l1.z, hp: 9999 - l1.hp };
    // 왼쪽을 보고 쓰면 왼쪽으로 돌진
    TT.reset({ x: 600 }); const lt = TT.dummy(500, 420); Input.press('ArrowLeft'); TT.tap('KeyS'); Input.release('ArrowLeft'); TT.run(40); o.thrustLeft = { dx: P.x - 600, hp: 9999 - lt.hp, face: P.face };
    // ---------- D 별빛 대폭발: 카메라 화면 안 전체, 5.0배 = 30, 한 번씩 ----------
    TT.reset({ x: 300, width: 1920 });
    const nA = TT.dummy(60, 350), nB = TT.dummy(900, 500), nC = TT.dummy(600, 420, { z: 150, noGravity: true }), nD = TT.dummy(1500, 420), nE = TT.dummy(980, 420);
    const h3 = TT.hits();
    TT.tap('KeyD'); o.novaStart = { state: P.state, cd: P.skills[2].cd, sfx: TT.sfx.slice() };
    const CH = PLAYER_DEF.skills[2].charge;                                              // 모으는 프레임 (누른 프레임이 첫 update)
    TT.run(CH - 1); o.novaBefore = nA.hp; o.novaFxBefore = TT.fx.map(f => f[0]).join();   // 아직 모으는 중 (폭발 한 프레임 전)
    TT.run(1); o.novaHitstop = FX.hitstop; o.novaFx = TT.fx.map(f => f[0]); o.novaFlash = FX.flashAlpha;
    TT.run(80);
    const c3 = id => h3.filter(x => x.id === id).length;
    o.nova = { A: 9999 - nA.hp, B: 9999 - nB.hp, C: 9999 - nC.hp, D: 9999 - nD.hp, E: 9999 - nE.hp, nA: c3(nA.id), nB: c3(nB.id), nC: c3(nC.id), stunA: nA.stun, launched: nA.vz > 0 || nA.z > 0 || nA.stun > 0 };
    // 카메라가 오른쪽 절반을 보고 있으면 왼쪽 끝 적은 화면 밖
    TT.reset({ x: 1300, width: 1920, cam: 960 });
    const wl = TT.dummy(100, 420), wr = TT.dummy(1500, 420); TT.tap('KeyD'); TT.run(40);
    o.novaCam = { left: 9999 - wl.hp, right: 9999 - wr.hp };
    return o;
  });
  check('A: 상태 skill / 회오리 act / 쿨타임이 곧바로 300 / 효과음 skill1', r.spinStart.state === 'skill' && r.spinStart.type === 'spin' && r.spinStart.cd === 300 && r.spinStart.sfx.includes('skill1'), JSON.stringify(r.spinStart));
  check('A: 첫 번째 판정은 준비 7프레임 뒤, 아직 띄우지 않음', r.spinT7.hp === 3 && r.spinT7.z === 0 && r.spinT7.vz === 0, JSON.stringify(r.spinT7));
  check('A: 앞의 적은 3 × 4번 = 합계 12 (2.0배), 각 판정 3', r.spin.front === 12 && r.spin.hitsFront === 4 && r.spin.dmgs === '3,3,3,3', JSON.stringify(r.spin));
  check('A: 360° — 뒤의 적도 똑같이 4번(12)', r.spin.behind === 12 && r.spin.hitsBehind === 4, String(r.spin.behind));
  check('A: 깊이 40 차이(44 안)는 맞고 [부정] 깊이 70 차이·사거리 밖은 안 맞음', r.spin.deepNear === 12 && r.spin.deepFar === 0 && r.spin.farX === 0, JSON.stringify([r.spin.deepNear, r.spin.deepFar, r.spin.farX]));
  check('A: 마지막 바퀴에서 띄워 날림 + 그동안 경직 유지', (r.spinLast.vz > 0 || r.spinLast.z > 0) && r.spinLast.hp === 12 && r.spin.stunFront > 0, JSON.stringify(r.spinLast));
  check('S: 돌진 act, 쿨타임 480, 효과음 skill2', r.thrustStart.state === 'skill' && r.thrustStart.cd === 480 && r.thrustStart.sfx.includes('skill2'), JSON.stringify(r.thrustStart));
  check('S: 일렬로 선 세 적을 관통해 각각 한 번씩 15 (2.5배)', r.thrust.d1 === 15 && r.thrust.d2 === 15 && r.thrust.d3 === 15 && r.thrust.n1 === 1 && r.thrust.n2 === 1 && r.thrust.n3 === 1, JSON.stringify(r.thrust));
  check('S: [부정] 깊이가 다른 적·멀리 있는 적은 안 맞음', r.thrust.deep === 0 && r.thrust.far === 0);
  check('S: 앞으로 약 150~175px 돌진하고 멈춤', r.thrust.dx > 150 && r.thrust.dx < 180, String(r.thrust.dx));
  check('S: 맞은 적은 띄워 날림', r.thrustLaunch.vz > 0 || r.thrustLaunch.z > 0, JSON.stringify(r.thrustLaunch));
  check('S: 왼쪽 방향키를 누르며 쓰면 왼쪽으로 돌진해 맞힘', r.thrustLeft.dx < -150 && r.thrustLeft.hp === 15 && r.thrustLeft.face === -1, JSON.stringify(r.thrustLeft));
  check('D: 쿨타임 1800 / 효과음 ultimate / 모으는 동안엔 피해 없음', r.novaStart.cd === 1800 && r.novaStart.sfx.includes('ultimate') && r.novaBefore === 9999 && r.novaFxBefore === '', JSON.stringify(r.novaStart));
  check('D: 폭발 순간 FX.flash 1번 + FX.freeze + FX.shake, 히트스톱 켜짐', r.novaFx.filter(x => x === 'flash').length === 1 && r.novaFx.includes('freeze') && r.novaFx.includes('shake') && r.novaHitstop >= 10 && r.novaFlash > 0 && r.novaFlash <= 0.6, JSON.stringify([r.novaFx, r.novaHitstop, r.novaFlash]));
  check('D: 화면 안의 모든 적(다른 깊이·공중 포함)이 각자 한 번씩 30 (5.0배)', r.nova.A === 30 && r.nova.B === 30 && r.nova.C === 30 && r.nova.nA === 1 && r.nova.nB === 1 && r.nova.nC === 1, JSON.stringify(r.nova));
  check('D: [부정] 카메라 화면 밖(x=1500, 980 은 화면 끝 밖)의 적은 안 맞음', r.nova.D === 0 && r.nova.E === 0, JSON.stringify([r.nova.D, r.nova.E]));
  check('D: 맞은 적은 오래 경직/띄워짐', r.nova.launched);
  check('D: 카메라가 움직이면 범위도 따라감 (왼쪽 끝 적 안 맞고 오른쪽 맞음)', r.novaCam.left === 0 && r.novaCam.right === 30, JSON.stringify(r.novaCam));

  // ---- ±10% 흔들림 범위 ----
  const v = await ev(() => {
    const res = { combo1: [], combo3: [], air: [], spin: [], thrust: [], nova: [] };
    for (let seed = 1; seed <= 30; seed++) {
      TT.reset({ seed, noVariance: false, x: 200 });
      let d = TT.dummy(250, 420, { superArmor: true }); let h = TT.hits();
      TT.tap('KeyZ'); TT.run(11); TT.tap('KeyZ'); TT.run(16); TT.tap('KeyZ'); TT.run(40);
      res.combo1.push(h[0].dmg); res.combo3.push(h[2].dmg);
      TT.reset({ seed, noVariance: false, x: 200 }); d = TT.dummy(260, 420); TT.tap('KeyX'); TT.run(5); TT.tap('KeyZ'); TT.run(15); res.air.push(9999 - d.hp);
      TT.reset({ seed, noVariance: false, x: 200 }); d = TT.dummy(250, 420); TT.tap('KeyA'); TT.run(60); res.spin.push(9999 - d.hp);
      TT.reset({ seed, noVariance: false, x: 200 }); d = TT.dummy(260, 420); TT.tap('KeyS'); TT.run(40); res.thrust.push(9999 - d.hp);
      TT.reset({ seed, noVariance: false, x: 200 }); d = TT.dummy(400, 420); TT.tap('KeyD'); TT.run(70); res.nova.push(9999 - d.hp);
    }
    return res;
  });
  const within = (arr, base) => arr.every(x => x >= lo(base) && x <= hi(base));
  const avg = a => a.reduce((s, x) => s + x, 0) / a.length;
  check(`1타 피해는 6 의 ±10% 범위 (${lo(6)}~${hi(6)}), 30번 모두`, within(v.combo1, 6) && new Set(v.combo1).size >= 2, [...new Set(v.combo1)].sort().join());
  check(`3타 피해는 9 의 ±10% 범위 (${lo(9)}~${hi(9)})`, within(v.combo3, 9) && new Set(v.combo3).size >= 2, [...new Set(v.combo3)].sort().join());
  check(`점프 공격은 7.2 의 ±10% (${lo(7.2)}~${hi(7.2)})`, within(v.air, 7.2), [...new Set(v.air)].sort().join());
  check('회오리 합계는 3×4 = 12 (판정당 3 이 반올림으로 안 흔들림)', v.spin.every(x => x === 12), [...new Set(v.spin)].join());
  check(`돌진 찌르기는 15 의 ±10% (${lo(15)}~${hi(15)}), 평균 ≈ 15`, within(v.thrust, 15) && new Set(v.thrust).size >= 3 && Math.abs(avg(v.thrust) - 15) < 1, `평균 ${avg(v.thrust).toFixed(2)} ${[...new Set(v.thrust)].sort().join()}`);
  check(`별빛 대폭발은 30 의 ±10% (${lo(30)}~${hi(30)}), 평균 ≈ 30`, within(v.nova, 30) && new Set(v.nova).size >= 3 && Math.abs(avg(v.nova) - 30) < 1.5, `평균 ${avg(v.nova).toFixed(2)} ${[...new Set(v.nova)].sort().join()}`);
});

await section('쿨타임·스킬 입력', async () => {
  const r = await ev(() => {
    const o = {};
    // 시작/카운트다운
    TT.reset(); const sk = P.skills[0];
    o.initial = P.skills.map(s => s.cd);
    TT.tap('KeyA'); o.start = sk.cd;
    TT.run(10); o.after10 = sk.cd;
    // 재사용 막힘: 쿨타임 중 다시 눌러도 발동 안 함 (동작이 끝난 뒤)
    TT.run(40); o.idle = { act: P.act, state: P.state };
    TT.tap('KeyA'); TT.run(15); o.blocked = { act: P.act, cd: sk.cd, state: P.state };
    TT.run(220); o.cdLeft = sk.cd;                                 // 누른 지 총 ~287 프레임
    TT.tap('KeyA'); TT.run(15); o.blockedLate = { act: P.act, cd: sk.cd };
    TT.run(40); o.cd0 = sk.cd;
    TT.tap('KeyA'); o.recast = { type: P.act && P.act.type, cd: sk.cd };
    // 다른 스킬은 서로의 쿨타임과 상관없음
    TT.reset(); TT.tap('KeyA'); TT.run(50); TT.tap('KeyS'); o.otherSkill = { type: P.act && P.act.type, cds: P.skills.map(s => s.cd) };
    // 스턴 중에도 쿨타임이 흘러감 (tick)
    TT.reset(); TT.tap('KeyA'); TT.run(3); const cd0 = P.skills[0].cd;
    TT.enemyHit({ hb: { stun: 30, knock: 0 } });                      // 스킬 도중에 맞음 → 스킬 취소·경직
    o.hurtCancel = { state: P.state, act: P.act, stun: P.stun };
    TT.run(20); o.stunCd = { before: cd0, after: P.skills[0].cd, stun: P.stun, state: P.state };
    // 스턴이 풀린 뒤에도 쿨타임 중이라 못 씀
    TT.run(15); P.invuln = 0; TT.tap('KeyA'); TT.run(3); o.afterStun = { act: P.act, state: P.state, cd: P.skills[0].cd };
    // 쿨타임이 막 끝나기 직전에 누르면 입력 기억 덕분에 발동
    TT.reset(); P.skills[0].cd = 4; TT.tap('KeyA'); TT.run(6); o.bufferedCast = P.act && P.act.type;
    TT.reset(); P.skills[0].cd = 30; TT.tap('KeyA'); TT.run(30); o.tooEarly = { act: P.act, cd: P.skills[0].cd };
    // 공격 중에는 스킬로 취소 불가 → 동작이 끝난 뒤에 입력이 남아 있으면 발동
    TT.reset(); TT.dummy(250, 420, { superArmor: true }); TT.tap('KeyZ'); TT.run(2); TT.tap('KeyA');
    o.noCancel = { state: P.state, type: P.act.type, cd: P.skills[0].cd };
    TT.run(30); o.earlyDropped = { act: P.act, cd: P.skills[0].cd };    // 너무 일찍 눌러서 잊혀짐
    TT.reset(); TT.dummy(250, 420, { superArmor: true }); TT.tap('KeyZ'); TT.run(11); TT.tap('KeyA'); TT.run(1);
    o.stillAtk = { type: P.act.type };
    TT.run(7); o.afterAtk = { type: P.act && P.act.type, cd: P.skills[0].cd };
    // 기본 공격 → 스킬 사이에서 콤보 기억은 지워짐
    TT.reset(); const p = P; p.skills[1].cd = 0; TT.tap('KeyS'); TT.run(60); o.stepAfterSkill = p.step;
    // 공중에서도 스킬(그 자리에 떠서 회오리)
    TT.reset(); TT.dummy(260, 420); TT.tap('KeyX'); TT.run(8); const z0 = P.z; TT.tap('KeyA'); TT.run(10); o.airSpin = { type: P.act && P.act.type, z: P.z, z0 };
    TT.run(60); o.airLand = { z: P.z, state: P.state };
    return o;
  });
  check('처음엔 세 스킬 모두 cd=0 (바로 쓸 수 있음)', r.initial.join() === '0,0,0');
  check('발동하는 순간 cd = cdMax(300), 매 프레임 -1 로 카운트다운', r.start === 300 && r.after10 === 290, `${r.start} → ${r.after10}`);
  check('[부정] 쿨타임 중에는 다시 눌러도 발동하지 않음 (동작 끝난 뒤)', r.idle.act === null && r.blocked.act === null && r.blocked.state === 'idle' && r.blocked.cd < 260, JSON.stringify(r.blocked));
  check('[부정] 쿨타임이 한참 남았을 때(cd≥12)도 발동 안 함', r.cdLeft > 12 && r.blockedLate.act === null, JSON.stringify([r.cdLeft, r.blockedLate]));
  check('쿨타임이 0 이 되면 다시 발동 (cd 다시 300)', r.cd0 === 0 && r.recast.type === 'spin' && r.recast.cd === 300, JSON.stringify([r.cd0, r.recast]));
  check('다른 스킬은 서로의 쿨타임과 상관없이 쓸 수 있음', r.otherSkill.type === 'thrust' && r.otherSkill.cds[0] > 0 && r.otherSkill.cds[1] === 480 && r.otherSkill.cds[2] === 0, JSON.stringify(r.otherSkill));
  check('스킬 도중 맞으면 스킬이 취소되고 hurt', r.hurtCancel.state === 'hurt' && r.hurtCancel.act === null && r.hurtCancel.stun >= 30);
  check('스턴 중에도 쿨타임은 계속 흘러감 (20프레임 = -20)', r.stunCd.after === r.stunCd.before - 20, JSON.stringify(r.stunCd));
  check('스턴이 풀려도 쿨타임 중이면 다시 못 씀', r.afterStun.act === null && r.afterStun.cd > 0, JSON.stringify(r.afterStun));
  check('쿨타임이 4프레임 남았을 때 눌러도 입력 기억으로 곧 발동', r.bufferedCast === 'spin', String(r.bufferedCast));
  check('[부정] 쿨타임이 30프레임 남았을 때 눌러서 기억이 만료되면 발동 안 함', r.tooEarly.act === null && r.tooEarly.cd === 0, JSON.stringify(r.tooEarly));
  check('공격 중에 스킬 키를 눌러도 공격이 취소되지 않음 (쿨타임도 안 씀)', r.noCancel.state === 'attack' && r.noCancel.type === 'combo' && r.noCancel.cd === 0, JSON.stringify(r.noCancel));
  check('  (너무 일찍 눌러 기억이 만료됐다면 이후에도 발동 안 함)', r.earlyDropped.act === null && r.earlyDropped.cd === 0, JSON.stringify(r.earlyDropped));
  check('  (공격이 끝나기 직전에 누르면 끝난 직후 스킬 발동)', r.stillAtk.type === 'combo' && r.afterAtk.type === 'spin' && r.afterAtk.cd > 250, JSON.stringify([r.stillAtk, r.afterAtk]));
  check('스킬을 쓰면 기본 콤보 기억이 지워짐', r.stepAfterSkill === -1, String(r.stepAfterSkill));
  check('공중에서도 스킬: 그 자리에 떠서 회오리 → 끝나면 내려옴', r.airSpin.type === 'spin' && r.airSpin.z > 20 && Math.abs(r.airSpin.z - r.airSpin.z0) < 3 && r.airLand.z === 0 && r.airLand.state === 'idle', JSON.stringify([r.airSpin, r.airLand]));
});

await section('궁극기 무적', async () => {
  const r = await ev(() => {
    const o = { dmg: [] };
    const ND = PLAYER_DEF.skills[2], TOTAL = ND.charge + ND.recovery;              // 발동 동작 길이 (54)
    o.total = TOTAL; o.after = ND.invulnAfter;
    TT.reset(); TT.dummy(400, 420);
    TT.tap('KeyD'); o.invulnStart = P.invuln;                                       // 발동 update 끝에 커널이 -1 한 값
    // 발동 동작 동안(TOTAL 프레임)과 여운(invulnAfter) 동안, 5프레임마다 때려 봄 (무적이니 피해 0)
    for (let i = 1; i < TOTAL + ND.invulnAfter - 1; i++) {
      TT.run(1);
      if (i % 5 === 0) { const inv = P.invuln; o.dmg.push([i, TT.enemyHit({ dmg: 20 }), P.hp, inv]); }
    }
    // 무적이 다 끝날 때까지 기다린 뒤에는 맞음
    let g = 0; while (P.invuln > 0 && g++ < 200) TT.run(1);
    o.end = { invuln: P.invuln, hp: P.hp, act: P.act, state: P.state };
    o.afterHit = TT.enemyHit({ dmg: 20 }); o.afterHp = P.hp; o.afterInv = P.invuln;
    // 궁극기를 쓰기 전에는 맞음 (대조)
    TT.reset(); o.control = TT.enemyHit({ dmg: 20 });
    // 모으는 동안엔 깜빡임 대신 후광 (act 유지)
    TT.reset(); TT.tap('KeyD'); TT.run(10); o.charging = { state: P.state, type: P.act.type };
    return o;
  });
  check(`발동하자마자 무적 (invuln = 길이 ${r.total} + 여운 ${r.after} 에서 1 프레임 지난 값)`, r.invulnStart === r.total + r.after - 1, String(r.invulnStart));
  const during = r.dmg.filter(([i]) => i < r.total);
  check(`[부정] 발동 중(${r.total}프레임) 내내 맞아도 피해 0, hp 100 그대로`, during.length >= 10 && during.every(([i, d, hp, inv]) => d === 0 && hp === 100 && inv > 0), JSON.stringify(during.slice(0, 3)));
  const grace = r.dmg.filter(([i]) => i >= r.total);
  check(`끝난 뒤 여운(${r.after}프레임) 동안도 무적 (동작은 끝났는데도 피해 0)`, grace.length >= 3 && grace.every(([i, d, hp, inv]) => d === 0 && hp === 100 && inv > 0), JSON.stringify(grace));
  check('무적이 끝나면 다시 맞음 (일반 피해 20, 그 뒤 새 무적 45)', r.end.invuln === 0 && r.end.act === null && r.afterHit === 20 && r.afterHp === 80 && r.afterInv === 45, JSON.stringify([r.end, r.afterHit, r.afterInv]));
  check('[대조] 궁극기 없이는 맞음', r.control === 20);
  check('궁극기를 모으는 중에는 skill 상태', r.charging.state === 'skill' && r.charging.type === 'nova');
});

await section('피격·경직·죽음·부활·회복', async () => {
  const r = await ev(() => {
    const o = {};
    // 맞기
    TT.reset(); const log = TT.events(['playerHit']); Game.combo.count = 3;
    o.dmg = TT.enemyHit({ dmg: 10, hb: { knock: 0, stun: 14 } });
    o.hurt = { hp: P.hp, state: P.state, stun: P.stun, invuln: P.invuln, flash: P.flash, combo: Game.combo.count, sfx: TT.sfx.slice(), ev: log.length };
    // 경직 동안은 조작 불가(방향키를 눌러도 안 움직임), 끝나면 idle
    Input.press('ArrowRight'); const x0 = P.x; TT.run(10); o.stunMove = P.x - x0; o.stunState = P.state;
    TT.run(5); o.recovered = { state: P.state, x: P.x - x0 }; Input.release('ArrowRight');
    // 최소 경직: 적 공격이 stun 0 이어도 잠깐은 움찔
    TT.reset(); TT.enemyHit({ hb: { stun: 0, knock: 0 } }); o.minStun = { stun: P.stun, state: P.state };
    // 무적 중에는 또 안 맞음, 끝나면 맞음
    TT.reset(); TT.enemyHit(); const hpA = P.hp; o.second = TT.enemyHit(); o.hpSame = P.hp === hpA; TT.run(46); o.third = TT.enemyHit();
    // 공격 도중에 맞으면 콤보 취소 + 1타부터
    TT.reset(); TT.dummy(250, 420, { superArmor: true }); TT.tap('KeyZ'); TT.run(3); TT.enemyHit({ hb: { knock: 0 } });
    o.cancel = { act: P.act, step: P.step, state: P.state, link: P.link };
    TT.run(60); TT.tap('KeyZ'); o.restart = P.act && P.act.step;
    // 공중에서 맞으면: 땅에 닿을 때까지 hurt, 닿고 경직이 풀리면 idle
    TT.reset(); TT.tap('KeyX'); TT.run(10); TT.enemyHit({ hb: { knock: 0 } });
    o.airHurt = { state: P.state, z: P.z }; let g = 0; while (P.z > 0 && g++ < 100) TT.run(1);
    o.landedHurt = P.state; TT.run(30); o.airRecovered = P.state;
    // 난이도: 쉬움은 받는 피해 절반
    TT.reset({ difficulty: 'easy' }); o.easy = TT.enemyHit({ dmg: 10 });
    TT.reset({ difficulty: 'hard' }); o.hard = TT.enemyHit({ dmg: 10 });
    // 죽음
    TT.reset(); const dev = TT.events(['playerDied']); P.hp = 5;
    TT.enemyHit({ dmg: 10, hb: { knock: 4 } });
    o.dead = { dead: P.dead, state: P.state, hp: P.hp, vz: P.vz, died: dev.length, inList: Entities.list.includes(P) };
    TT.run(300);
    o.deadLater = { state: P.state, inList: Entities.list.includes(P), z: P.z, hp: P.hp, died: dev.length };
    const xDead = P.x; Input.press('ArrowRight'); TT.run(30); o.deadMove = P.x - xDead;
    TT.tap('KeyA'); TT.tap('KeyZ'); TT.tap('KeyX'); TT.run(5); o.deadActs = { act: P.act, cd: P.skills[0].cd, z: P.z, state: P.state };
    Input.release('ArrowRight');
    P.skills[1].cd = 50; TT.run(30); o.deadCd = P.skills[1].cd;                      // 쓰러져 있어도 tick 은 돎
    // 부활
    const rev = TT.events(['playerRevived']);
    P.x = 500; Player.revive(P);
    o.revived = { hp: P.hp, dead: P.dead, state: P.state, invuln: P.invuln, stun: P.stun, act: P.act, ev: rev.length, evIsP: rev[0] && rev[0][1] === P, sfx: TT.sfx.includes('heal') };
    Input.press('ArrowRight'); TT.run(5); o.reviveMove = P.x - 500; Input.release('ArrowRight');
    TT.run(10); o.reviveInv = P.invuln;
    Player.revive(P, { invuln: 30 }); o.reviveInv30 = P.invuln;
    // 부활 직후에도 정상으로 공격 가능
    P.invuln = 0; TT.dummy(P.x + 50, P.y); TT.tap('KeyZ'); o.reviveAtk = P.state;
    // 회복
    TT.reset(); P.hp = 50; const ret = Player.heal(P, 30); o.heal = { ret, hp: P.hp, popup: FX.popups.some(p => p.text === '+30'), sfx: TT.sfx.includes('heal') };
    o.heal2 = { ret: Player.heal(P, 100), hp: P.hp }; o.heal3 = { ret: Player.heal(P, 20), hp: P.hp };
    o.healNeg = { ret: Player.heal(P, -10), hp: P.hp };
    TT.reset(); P.hp = 0; P.dead = true; P.state = 'down'; o.healDead = { ret: Player.heal(P, 50), hp: P.hp };
    return o;
  });
  check('맞으면 hp -10, state hurt, 무적 45프레임(playerInvuln), 번쩍임, 콤보 끊김, 효과음 hurt, playerHit 이벤트',
    r.dmg === 10 && r.hurt.hp === 90 && r.hurt.state === 'hurt' && r.hurt.invuln === 45 && r.hurt.flash > 0 && r.hurt.combo === 0 && r.hurt.sfx.includes('hurt') && r.hurt.ev === 1, JSON.stringify(r.hurt));
  check('경직(stun ≥ 14) 동안 방향키를 눌러도 못 움직이고 hurt 유지', r.hurt.stun >= 14 && r.stunMove === 0 && r.stunState === 'hurt', `${r.stunMove} ${r.stunState}`);
  check('경직이 풀리면 idle 로 돌아와 다시 걸음', r.recovered.state === 'walk' || r.recovered.state === 'idle', r.recovered.state);
  check('적 공격이 stun 0 이어도 최소 10프레임은 움찔', r.minStun.stun === 10 && r.minStun.state === 'hurt', JSON.stringify(r.minStun));
  check('[부정] 무적 중엔 또 안 맞음(피해 0), 무적이 끝나면 맞음', r.second === 0 && r.hpSame && r.third === 10, `${r.second} ${r.third}`);
  check('공격 도중에 맞으면 콤보 취소 (act 없음, 기억 지움), 다음엔 1타부터', r.cancel.act === null && r.cancel.step === -1 && r.cancel.state === 'hurt' && r.cancel.link === 0 && r.restart === 0, JSON.stringify([r.cancel, r.restart]));
  check('공중에서 맞으면 땅에 닿을 때까지 hurt, 착지 후 경직이 풀리면 idle', r.airHurt.state === 'hurt' && r.airHurt.z > 0 && r.landedHurt === 'hurt' && r.airRecovered === 'idle', JSON.stringify([r.airHurt, r.landedHurt, r.airRecovered]));
  check('난이도: 쉬움 5 / 보통 10 / 어려움 17 (커널 dmgTaken 0.5 / 1.0 / 1.7)', r.easy === 5 && r.dmg === 10 && r.hard === 17, `${r.easy} ${r.dmg} ${r.hard}`);
  check('죽으면 dead, state down, 뿅 튕김, playerDied 한 번, 목록에서 안 사라짐', r.dead.dead && r.dead.state === 'down' && r.dead.hp === 0 && r.dead.vz > 0 && r.dead.died === 1 && r.dead.inList, JSON.stringify(r.dead));
  check('300프레임 뒤에도 쓰러진 채 그대로 (제거 안 됨, 땅에 누움, 이벤트 중복 없음)', r.deadLater.state === 'down' && r.deadLater.inList && r.deadLater.z === 0 && r.deadLater.died === 1, JSON.stringify(r.deadLater));
  check('[부정] 쓰러지면 방향키/공격/스킬/점프가 먹지 않음', r.deadMove === 0 && r.deadActs.act === null && r.deadActs.cd === 0 && r.deadActs.z === 0 && r.deadActs.state === 'down', JSON.stringify([r.deadMove, r.deadActs]));
  check('쓰러진 동안에도 쿨타임은 흘러감 (tick)', r.deadCd === 20, String(r.deadCd));
  check('부활: hp 가득, dead=false, idle, 무적 120, 경직 없음, playerRevived 이벤트(주인공), 효과음 heal',
    r.revived.hp === 100 && !r.revived.dead && r.revived.state === 'idle' && r.revived.invuln === 120 && r.revived.stun === 0 && r.revived.act === null && r.revived.ev === 1 && r.revived.evIsP && r.revived.sfx, JSON.stringify(r.revived));
  check('부활 뒤 다시 걸을 수 있음 (5프레임 +20px), 무적은 줄어듦, invuln 옵션 적용', r.reviveMove === 20 && r.reviveInv === 105 && r.reviveInv30 === 30, `${r.reviveMove} ${r.reviveInv} ${r.reviveInv30}`);
  check('부활 직후 공격 가능', r.reviveAtk === 'attack');
  check('heal: 50 + 30 = 80 (초록 +30 팝업·효과음), 반환값은 실제 회복량', r.heal.ret === 30 && r.heal.hp === 80 && r.heal.popup && r.heal.sfx, JSON.stringify(r.heal));
  check('heal 은 maxHp(100) 를 넘지 않음 (+100 → 100, 반환 20)', r.heal2.hp === 100 && r.heal2.ret === 20, JSON.stringify(r.heal2));
  check('가득 찬 상태에서 heal = 0, 음수 heal 도 hp 를 깎지 않음', r.heal3.ret === 0 && r.heal3.hp === 100 && r.healNeg.hp === 100 && r.healNeg.ret === 0, JSON.stringify([r.heal3, r.healNeg]));
  check('[부정] 쓰러진 상대는 heal 로 살아나지 않음', r.healDead.ret === 0 && r.healDead.hp === 0, JSON.stringify(r.healDead));
});

await section('그리기: 모든 상태가 오류 없이 그려지고 모양이 다름', async () => {
  const r = await ev(() => {
    const o = { shots: {} };
    const sample = (label, x = 200, y = 420) => { o.shots[label] = TT.ink(x - 150, y - 200, 300, 230); TT.tile(label); };
    TT.reset({ x: 480 }); TT.run(10); sample('idle', 480);
    const idle = o.shots.idle;
    o.idleHigh = TT.ink(480 - 150, 420 - 112, 300, 50, true);
    Input.press('ArrowRight'); TT.run(7); sample('walk', P.x); Input.release('ArrowRight'); TT.run(2);
    TT.tap('KeyX'); TT.run(4); sample('jump up', P.x); TT.run(14); sample('jump down', P.x); TT.run(30);
    TT.run(1); sample('land', P.x);
    TT.reset({ x: 480 }); TT.dummy(540, 420, { superArmor: true }); TT.tap('KeyZ'); TT.run(6); sample('combo1', 480);
    TT.run(11); TT.tap('KeyZ'); TT.run(4); sample('combo2', P.x);
    TT.run(11); TT.tap('KeyZ'); TT.run(12); sample('combo3', P.x);
    TT.reset({ x: 480 }); TT.dummy(540, 420); TT.tap('KeyX'); TT.run(5); TT.tap('KeyZ'); TT.run(6); sample('air attack', P.x);
    TT.reset({ x: 480 }); TT.dummy(430, 420); TT.dummy(540, 425); TT.tap('KeyA'); TT.run(18); sample('spin', P.x);
    TT.reset({ x: 380 }); TT.dummy(540, 420); TT.tap('KeyS'); TT.run(16); sample('thrust', P.x);
    TT.reset({ x: 480 }); TT.dummy(540, 420); TT.tap('KeyD'); TT.run(16); sample('nova charge', P.x);
    TT.run(11); sample('nova blast', P.x);
    TT.reset({ x: 480 }); TT.enemyHit({ hb: { knock: 4 } }); TT.run(4); sample('hurt', P.x);
    TT.reset({ x: 480 }); P.hp = 1; TT.enemyHit({ dmg: 10, hb: { knock: 4 } }); TT.run(40); sample('down', P.x);
    o.down = o.shots.down;
    o.downHigh = TT.ink(480 - 150, 420 - 112, 300, 50, true);                          // 키 62~112px 높이 띠: 서 있으면 머리·삐죽머리가 있는 곳
    o.downLow = TT.ink(480 - 150, 420 - 40, 300, 40, true);                            // 땅에서 40px 이내 띠: 누우면 몸이 여기에 가로로 깔림
    Player.revive(P); TT.run(6); sample('revive', P.x);
    TT.run(130); P.cheer = true; TT.run(5); sample('cheer', P.x); P.cheer = false;
    // 얼굴 방향 뒤집기: 같은 휘두름 장면이 좌우 대칭
    TT.reset({ x: 480 }); TT.dummy(540, 420, { superArmor: true }); TT.tap('KeyZ'); TT.run(6); const R1 = TT.ink(330, 220, 300, 230);
    TT.reset({ x: 480 }); TT.dummy(420, 420, { superArmor: true }); Input.press('ArrowLeft'); TT.tap('KeyZ'); Input.release('ArrowLeft'); TT.run(6); const L1 = TT.ink(330, 220, 300, 230);
    o.mirror = { R1, L1, face: P.face };
    // 색: 평상시 튜닉 하늘색, 번쩍이면(flash) 흰색
    TT.reset({ x: 480 }); TT.run(5); Loop.draw(); o.tunic = TT.px(476, 397);
    P.flash = 6; Loop.draw(); o.flashPx = TT.px(476, 397);
    // 무적 깜빡임: 같은 위치 색이 프레임마다 달라짐
    TT.reset({ x: 480 }); P.invuln = 90; const cols = new Set(); for (let i = 0; i < 30; i++) { TT.run(1); Loop.draw(); cols.add(TT.px(476, 397).join()); }
    o.flicker = cols.size;
    // 돌진 잔상이 쌓였다가 사라짐
    TT.reset({ x: 380 }); TT.tap('KeyS'); TT.run(24); o.ghosts = P.ghosts.length; TT.run(60); o.ghostsGone = P.ghosts.length;
    // 이펙트 층: 몸 그리기와 별개로 그려짐 / 주인공이 사라지면 같이 정리
    TT.reset(); const layer = P.fxLayer; o.layerIn = Entities.list.includes(layer); Entities.remove(P); Loop.draw(); o.layerOut = Entities.list.includes(layer);
    o.debugErrors = Debug.errors.slice();
    return { idle, ...o };
  });
  const s = r.shots;
  check('모든 상태(서기·걷기·점프·3타·공중·스킬 3개·피격·쓰러짐·부활·만세)가 오류 없이 그려짐', Object.keys(s).length >= 17 && Object.values(s).every(v => v.L + v.R > 400), Object.entries(s).map(([k, v]) => `${k}:${v.L + v.R}`).join(' '));
  check('서 있는 모습은 세로로 길다 (키 > 폭)', s.idle.bh > s.idle.bw * 0.9 && s.idle.bh > 70, `${s.idle.bw}x${s.idle.bh}`);
  check('쓰러진 모습은 가로로 누워 있다 (서 있을 때 머리가 있던 높이 띠는 거의 비고, 땅 가까운 띠에 몸이 넓게 깔림)',
    r.downHigh.L + r.downHigh.R < (r.idleHigh.L + r.idleHigh.R) * 0.3 && r.downLow.bw > 60, `머리 높이 윤곽 ${r.downHigh.L + r.downHigh.R} (서 있을 때 ${r.idleHigh.L + r.idleHigh.R}), 낮은 띠 폭 ${r.downLow.bw}`);
  check('3타 큰 휘두름은 서 있을 때보다 훨씬 넓게 그려짐', s.combo3.bw > s.idle.bw * 1.3, `${s.combo3.bw} vs ${s.idle.bw}`);
  check('스킬 이펙트(회오리/궁극기)는 넓게 퍼짐', s.spin.bw > s.idle.bw * 1.5 && s['nova blast'].bw > 250, `${s.spin.bw} ${s['nova blast'].bw}`);
  check('공격 장면은 칼 쪽(오른쪽)이 훨씬 많이 그려지고, 왼쪽을 보면 정확히 반대로 대칭', r.mirror.R1.R > r.mirror.R1.L * 1.2 && r.mirror.L1.L > r.mirror.L1.R * 1.2 && Math.abs(r.mirror.R1.R - r.mirror.L1.L) / r.mirror.R1.R < 0.2,
    JSON.stringify(r.mirror));
  check('평상시 튜닉은 하늘색(파랑>빨강), 번쩍이면(flash) 하얗게', r.tunic[2] > r.tunic[0] + 40 && r.flashPx.every(v => v > 235), `${r.tunic} → ${r.flashPx}`);
  check('무적 깜빡임: 같은 자리의 색이 프레임마다 변함', r.flicker >= 4, String(r.flicker));
  check('돌진 잔상이 쌓이고 시간이 지나면 사라짐', r.ghosts >= 3 && r.ghostsGone === 0, `${r.ghosts} → ${r.ghostsGone}`);
  check('주인공이 사라지면 이펙트 층도 스스로 정리', r.layerIn && !r.layerOut);
  check('그리기 중 커널이 잡은 오류 없음 (Debug.errors)', r.debugErrors.length === 0, r.debugErrors.join(' | '));

  // 스크린샷 시트
  const url = await ev(() => TT.sheet(4));
  writeFileSync(join(SHOT_DIR, 'player-states.png'), Buffer.from(url.split(',')[1], 'base64'));
  console.log('  (스크린샷: ' + join(SHOT_DIR, 'player-states.png') + ')');
});

await section('Enemies 와 함께', async () => {
  const has = await ev(() => typeof Enemies === 'object' && typeof Enemies.spawn === 'function');
  check('Enemies 모듈이 로드됨 (없으면 아래 통합 검사가 통째로 빠지니 파일을 실패시켜요)', has);   // 스텁 시절의 "조용히 건너뜀" 대신 강제 확인
  if (!has) return;
  const r = await ev(() => {
    const o = {};
    // 진짜 슬라임을 때려 눕히기: 3타 콤보로 슬라임(20) 처치
    TT.reset({ x: 300, noVariance: true }); Game.difficulty = 'normal'; const hurtLog = TT.events(['playerHit', 'enemyKilled']);
    const s = Enemies.spawn('slime', 380, 420); s.hp = s.maxHp = 20;
    s.update = null; s.tick = null;                                   // 이번엔 얌전히 맞기만 (AI 끔)
    TT.tap('KeyZ'); TT.run(11); TT.tap('KeyZ'); TT.run(16); TT.tap('KeyZ'); TT.run(60);
    o.slime = { dead: s.dead, killed: hurtLog.filter(x => x[0] === 'enemyKilled').length, kills: Game.kills };
    // 궁극기: 슬라임 3마리 즉사, 병정(35)은 남음
    TT.reset({ x: 400, noVariance: false, seed: 3 }); Game.difficulty = 'normal';
    const sl = [Enemies.spawn('slime', 300, 380), Enemies.spawn('slime', 600, 460), Enemies.spawn('slime', 520, 420)];
    const so = Enemies.spawn('soldier', 700, 400);
    for (const e of [...sl, so]) { e.update = null; e.tick = null; }
    TT.tap('KeyD'); TT.run(90);
    o.nova = { slimesDead: sl.every(e => e.dead), soldierHp: so.hp, soldierMax: so.maxHp, soldierDead: so.dead };
    // 실제 적의 AI 가 플레이어를 때릴 수 있고, 그때 상태/무적/콤보가 정상
    TT.reset({ x: 300, noVariance: true }); Game.difficulty = 'normal'; Debug.god = false;
    const hits = TT.events(['playerHit']);
    const sl2 = Enemies.spawn('slime', 360, 420);
    let g = 0; while (!hits.length && g++ < 900) TT.run(1);
    o.aiHit = { got: hits.length, frames: g, hp: P.hp, state: P.state, invuln: P.invuln };
    TT.run(60); o.aiAfter = { state: P.state };
    o.err = Debug.errors.slice();
    return o;
  });
  check('진짜 슬라임(20): 3타 콤보(6+6+9=21)로 처치, enemyKilled 1번', r.slime.dead && r.slime.killed === 1 && r.slime.kills === 1, JSON.stringify(r.slime));
  check('진짜 적과 궁극기: 슬라임 3마리 처치 + 병정(35)은 30±10% 만 깎여 생존', r.nova.slimesDead && !r.nova.soldierDead && r.nova.soldierHp >= r.nova.soldierMax - 33 && r.nova.soldierHp <= r.nova.soldierMax - 27, JSON.stringify(r.nova));
  check('진짜 적 AI 가 플레이어를 때림 → hp 감소, hurt, 무적 45', r.aiHit.got >= 1 && r.aiHit.hp < 100 && r.aiHit.invuln === 45 && r.aiHit.state === 'hurt', JSON.stringify(r.aiHit));
  check('맞은 뒤 다시 정상 상태로 돌아옴', ['idle', 'walk', 'jump'].includes(r.aiAfter.state), r.aiAfter.state);
  check('적과 어울리는 동안 오류 없음', r.err.length === 0, r.err.join(' | '));
});

check('페이지 오류(pageerror/console.error) 없음', errors.length === 0, errors.slice(0, 3).join(' | '));
await close();
finish('player');
