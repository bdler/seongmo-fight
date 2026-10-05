// 플레이 봇 도우미 — 진짜 게임을 "키 입력만으로" 플레이하는 봇을 페이지 안에 심는다.
//   const { page, errors, close } = await openGame();
//   await startThroughUI(page, { nickname: '봇용사', difficulty: 'easy' });   // 타이틀 화면의 입력창/버튼을 실제로 누름
//   await installBot(page, { mode: 'play', seed: 1 });                        // Loop.hooks 에 봇 등록
//   const r = await runUntil(page, () => Game.scene === 'result', { capFrames: 50400 });
//
// 봇은 Input.press / Input.release 로만 조작하고, 게임 상태는 "읽기만" 한다 (Game.player, Entities.list …).
// 이기려고 내부 API(Combat.damage, Player.heal 등)를 부르지 않는다. (Debug.god 는 테스트가 따로 켠다)
//
// 봇이 하는 일 (사람이 하는 것처럼):
//   - 가장 가까운 적을 찾아 깊이(y)를 맞추고, 사거리까지 다가가서, 그쪽을 보고 공격 연타 (콤보)
//   - 공중에 뜬 적이 있으면 가끔 점프해서 내려찍기
//   - 적이 2마리 이상 모이면 회오리(A), 앞줄에 늘어서면 돌진(S), 3마리 이상/위험하면 대폭발(D)
//   - 예고 동작(머리 위 !, 바닥 마커)이 보이면 그 자리에서 비켜 서기
//   - 체력이 낮으면 사탕을 주우러 감, 방이 깨지면(GO) 오른쪽으로 걷기

/** 타이틀 화면에서 닉네임을 쓰고 → 난이도 카드를 누르고 → 「시작!」 을 누른다 (실제 DOM 클릭) */
export async function startThroughUI(page, { nickname = '봇용사', difficulty = 'easy' } = {}) {
  await page.waitForFunction(() => Game.scene === 'title', null, { timeout: 8000 });
  await page.fill('#ui-nick', nickname);
  await page.click(`.diff-card[data-diff="${difficulty}"]`);
  await page.click('#ui-start');
  await page.waitForFunction(() => Game.scene === 'play', null, { timeout: 8000 });
}

/** 봇 설치. cfg: { mode:'play'|'idle', seed, god } — 페이지 안에서 window.__bot 으로 통계가 쌓인다 */
export async function installBot(page, cfg = {}) {
  await page.evaluate(botMain, { mode: 'play', seed: 1, god: false, ...cfg });
}

export const botStats = page => page.evaluate(() => {
  const B = window.__bot;
  return B ? { ...B.stats, ticks: B.ticks } : null;
});

/**
 * 조건이 참이 될 때까지 chunk 프레임씩 진행. capFrames(Loop 틱 수)를 넘으면 멈추고 capped:true.
 * 돌려주는 값: { frames(Loop 틱), gameFrames(Game.frame), capped, scene }
 */
export async function runUntil(page, predicate, { capFrames = 50400, chunk = 600, onChunk } = {}) {
  let frames = 0;
  for (;;) {
    const n = Math.min(chunk, capFrames - frames);
    if (n <= 0) break;
    await page.evaluate(k => Loop.step(k), n);
    frames += n;
    const st = await page.evaluate(() => ({ scene: Game.scene, gameFrames: Game.frame, state: typeof Stage !== 'undefined' ? Stage.state : '' }));
    if (onChunk) await onChunk(st, frames);
    if (await page.evaluate(predicate)) return { frames, gameFrames: st.gameFrames, capped: false, scene: st.scene };
  }
  const st = await page.evaluate(() => ({ scene: Game.scene, gameFrames: Game.frame }));
  return { frames, gameFrames: st.gameFrames, capped: true, scene: st.scene };
}

// ---------------------------------------------------------------------------
// 아래 함수는 "페이지 안에서" 실행된다 (page.evaluate 로 문자열화되어 들어가므로 바깥 변수를 쓰면 안 됨)
// ---------------------------------------------------------------------------
function botMain(cfg) {
  const prev = window.__bot;
  if (prev) { const i = Loop.hooks.indexOf(prev.hook); if (i >= 0) Loop.hooks.splice(i, 1); }

  // 실력 프로필: expert = 반응 즉시·연타 빠름 / kid = 사람(초등학생) 속도 (생각하는 간격·반응 지연·느린 연타·가끔 멍때림) / novice = 처음 해 보는 아이
  const PROFILES = {
    expert: { think: 1, mashEvery: 4, dodgeLag: 0, hesitate: 0, look: 0, interruptRate: 0.5 },
    kid:    { think: 9, mashEvery: 7, dodgeLag: 15, hesitate: 0.06, look: 30, interruptRate: 0.15 },
    novice: { think: 22, mashEvery: 11, dodgeLag: 34, hesitate: 0.3, look: 70, interruptRate: 0 },     // 처음 해 보는 아이: 느린 반응·느린 연타·자주 멈칫
  };
  const P = PROFILES[cfg.skill] || PROFILES.expert;

  const B = window.__bot = {
    cfg, on: true, ticks: 0, hook: null,
    plan: { dirs: [], mash: false }, idleUntil: 0, threatSince: -1, lastTargets: 0,
    stats: { hitsTaken: 0, dodgeTicks: 0, jumps: 0, skillA: 0, skillS: 0, skillD: 0, candyWalks: 0, coinsGot: 0, pickups: 0, stuckEvents: 0, interrupts: 0 },
    lastProgress: { t: 0, kills: 0, room: 0, hp: 0 },
  };
  // 봇 전용 난수 (게임의 rand()/RNG 를 건드리면 안 됨)
  let seed = (cfg.seed >>> 0) || 1;
  const brand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };

  const KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'KeyZ', 'KeyX', 'KeyA', 'KeyS', 'KeyD'];
  const want = {};
  const set = (code, on = true) => { want[code] = !!on; };
  function flush() {
    for (const k of KEYS) {
      const w = !!want[k], d = Input.isDown(k);
      if (w && !d) Input.press(k); else if (!w && d) Input.release(k);
      want[k] = false;
    }
  }
  const sgn = v => (v < 0 ? -1 : 1);
  const isFoe = e => (e.kind === 'enemy' || e.kind === 'boss') && !e.dead && !e._removed;

  Events.on('playerHit', () => { B.stats.hitsTaken++; });
  Events.on('pickup', d => { B.stats.pickups++; if (d && d.type === 'coin') B.stats.coinsGot++; });

  // y 방향으로 비켜 설 수 있는 쪽 (바닥 띠 안에서)
  function sideY(p, fromY) {
    let dir = p.y >= fromY ? 1 : -1;
    if (dir > 0 && p.y > FLOOR_BOTTOM - 14) dir = -1;
    else if (dir < 0 && p.y < FLOOR_TOP + 14) dir = 1;
    return dir;
  }

  // 지금 맞을 것 같은 자리에 서 있나? → 피할 방향 {ax, ay} (-1/0/1) 또는 null
  function threat(p, foes, markers) {
    let best = null;
    for (const e of foes) {
      if (e.state !== 'windup' && e.state !== 'attack') continue;
      const def = e.def || {};
      if (e.type === 'slime' || e.type === 'soldier') {
        const reach = (def.reach || 60) + (e.type === 'slime' ? 40 : 24);
        const along = (p.x - e.x) * e.face;
        const dy = p.y - e.y;
        if (along > -30 && along < reach && Math.abs(dy) < (def.depth || 20) + 16 && p.z < 40) {
          best = { ax: 0, ay: sideY(p, e.y), why: e.type, e };
          break;
        }
      }
    }
    if (best) return best;
    for (const m of markers) {
      const o = m.owner;
      if (!o || o.dead) continue;
      if (m.shape === 'ellipse') {
        const rx = m.rx + 16, ry = m.ry + 12;
        const ux = (p.x - m.x) / rx, uy = (p.y - m.y) / ry;
        if (ux * ux + uy * uy < 1) {
          const tx = (rx - Math.abs(p.x - m.x)) / 4, ty = (ry - Math.abs(p.y - m.y)) / 3;     // 나가는 데 걸리는 프레임
          const dirY = sideY(p, m.y);
          const yOk = (dirY > 0 ? FLOOR_BOTTOM - p.y : p.y - FLOOR_TOP) > ry - Math.abs(p.y - m.y) + 6;
          if (yOk && ty <= tx + 4) return { ax: 0, ay: dirY, why: 'ellipse-y' };
          return { ax: p.x >= m.x ? 1 : -1, ay: 0, why: 'ellipse-x' };
        }
      } else if (m.shape === 'lane') {
        const along = (p.x - m.x) * m.dir;
        if (along > -60 && Math.abs(p.y - m.y) < m.ry + 14) return { ax: 0, ay: sideY(p, m.y), why: 'lane' };
      }
    }
    return null;
  }

  // 이번 틱의 결정을 담는 곳 (kid 프로필은 몇 틱마다 한 번만 새로 결정하고, 그 사이엔 지난 결정을 유지)
  const plan = B.plan;
  const dirKey = (ax, ay) => { if (ax) plan.dirs.push(ax > 0 ? 'ArrowRight' : 'ArrowLeft'); if (ay) plan.dirs.push(ay > 0 ? 'ArrowDown' : 'ArrowUp'); };
  const mashZ = () => { plan.mash = true; };
  const applyPlan = () => {
    for (const k of plan.dirs) set(k);
    if (plan.mash && B.ticks % P.mashEvery < Math.ceil(P.mashEvery / 2)) set('KeyZ');
    flush();
  };

  function hook() {
    if (!B.on) return;
    B.ticks++;
    const p = Game.player;
    const live = Game.scene === 'play' && p && !Game.paused && !p.dead && p.state !== 'down';
    const st = typeof Stage !== 'undefined' ? Stage.state : '';
    if (!live || cfg.mode === 'idle' || st === 'victory' || st === 'transition' || st === 'dead' || st === 'over') { plan.dirs = []; plan.mash = false; flush(); return; }
    if (B.idleUntil > B.ticks) { plan.dirs = []; plan.mash = false; flush(); return; }
    if (P.think > 1 && B.ticks % P.think !== 0) { applyPlan(); return; }      // 생각하는 틱이 아니면 지난 결정대로
    plan.dirs = []; plan.mash = false;

    const ents = Entities.list;
    const foes = [], markers = [], pickups = [];
    for (const e of ents) {
      if (isFoe(e)) foes.push(e);
      else if (e.kind === 'marker' && e.fromEnemies && e.shape) markers.push(e);
      else if (e.kind === 'pickup' && !e._removed) pickups.push(e);
    }
    const targets = foes.filter(e => !e.untargetable && e.state !== 'drop');
    const hpRatio = p.hp / p.maxHp;
    const air = p.z > 4 || p.vz > 0;
    const acting = p.state === 'attack' || p.state === 'skill' || p.state === 'hurt';

    // 새 적이 나타나면 잠깐 "어디 있나?" 하고 둘러봄 (사람 반응)
    if (targets.length > 0 && B.lastTargets === 0 && P.look) B.idleUntil = B.ticks + P.look;
    B.lastTargets = targets.length;
    // 가끔 멍때림
    if (P.hesitate && brand() < P.hesitate * 0.1 && !acting && !air) { B.idleUntil = B.ticks + 10 + Math.floor(brand() * 25); }

    // 진행이 멈췄는지 감시 (처치/방/체력 변화가 1800프레임 동안 없으면 기록)
    const prog = B.lastProgress;
    if (Game.kills !== prog.kills || Stage.roomIndex !== prog.room || Math.abs(p.hp - prog.hp) > 0.5 || st !== prog.st) {
      prog.t = B.ticks; prog.kills = Game.kills; prog.room = Stage.roomIndex; prog.hp = p.hp; prog.st = st;
    } else if (B.ticks - prog.t > 1800) { B.stats.stuckEvents++; prog.t = B.ticks; B.stats.lastStuck = { tick: B.ticks, room: Stage.roomIndex, state: st, foes: foes.length, px: Math.round(p.x), py: Math.round(p.y) }; }

    // ---- 1) 위험 피하기 ----
    const th = !air && !acting ? threat(p, foes, markers) : null;
    if (!th) B.threatSince = -1;
    else if (B.threatSince < 0) B.threatSince = B.ticks;
    // 위협한 적이 코앞이고 막 예고를 시작했다면 먼저 때려서 끊는다 (사람도 하는 플레이)
    let interrupt = false;
    if (th && th.e && !acting && !air) {
      const e = th.e, remain = (e.windupLen || 30) - (e.t || 0);
      const adx = Math.abs(e.x - p.x), ady = Math.abs(e.y - p.y);
      if (e.state === 'windup' && remain > 12 && adx < 60 && ady < 12 && hpRatio > 0.4 && brand() < P.interruptRate) interrupt = true;
    }
    if (th && !interrupt) {
      if (B.ticks - B.threatSince >= P.dodgeLag) {              // 반응 지연이 지나야 몸이 움직임
        B.stats.dodgeTicks++;
        dirKey(th.ax, th.ay);
        applyPlan(); return;
      }
    }

    // ---- 2) 스킬 ----
    const near = targets.filter(e => Math.abs(e.x - p.x) < 115 && Math.abs(e.y - p.y) < 46);
    const bossNear = near.some(e => e.boss);
    const sk = p.skills || [];
    const skillOK = P.think > 1 ? brand() < 0.5 : true;            // 사람은 스킬을 늘 제때 쓰지는 못해요
    if (!air && !acting && skillOK) {
      const ready = i => sk[i] && sk[i].cd === 0;
      if (ready(2) && (near.length >= 3 || (hpRatio < 0.4 && near.length >= 2) || (bossNear && brand() < 0.02))) { set('KeyD'); B.stats.skillD++; }
      else if (ready(0) && (near.length >= 2 || (bossNear && brand() < 0.04))) { set('KeyA'); B.stats.skillA++; }
      else if (ready(1)) {
        const front = targets.filter(e => (e.x - p.x) * p.face > 40 && (e.x - p.x) * p.face < 230 && Math.abs(e.y - p.y) < 26);
        if (front.length >= 2 || (front.length >= 1 && brand() < 0.01)) { set('KeyS'); B.stats.skillS++; }
      }
    }

    // ---- 3) 목표 정하기 ----
    let t = null, bd = 1e9;
    for (const e of targets) {
      const d = Math.abs(e.x - p.x) + Math.abs(e.y - p.y) * 1.5 - (e.state === 'windup' ? 25 : 0);
      if (d < bd) { bd = d; t = e; }
    }
    // 목표가 없으면 (아직 안 나왔거나 다 잡음): 방이 깨졌으면(GO) 오른쪽으로, 아니면 아이템 줍기 / 가만히
    const needHeal = hpRatio < 0.6;
    let goal = null;       // { x, y }  걸어가서 닿을 곳
    if (!t || (needHeal && pickups.some(e => e.type === 'candy') && (near.length === 0 || hpRatio < 0.35))) {
      let c = null, cd = 1e9;
      for (const e of pickups) {
        if (e.type === 'candy' ? !(needHeal || st === 'clear' && hpRatio < 0.9) : e.type !== 'coin') continue;
        const d = Math.abs(e.x - p.x) + Math.abs(e.y - p.y);
        if (d < cd && d < (e.type === 'candy' ? 600 : 160)) { cd = d; c = e; }
      }
      if (c) { goal = { x: c.x, y: c.y }; if (c.type === 'candy') B.stats.candyWalks++; }
    }
    if (!t) {
      if (goal) {
        walkTo(p, goal.x, goal.y, 8, 8);
      } else if (st === 'clear') {
        dirKey(1, 0);
        const dy = 430 - p.y; if (Math.abs(dy) > 12) dirKey(0, dy);
      }
      applyPlan(); return;
    }
    if (goal) { walkTo(p, goal.x, goal.y, 8, 8); applyPlan(); return; }

    // ---- 4) 싸우기 ----
    const dx = t.x - p.x, dy = t.y - p.y, adx = Math.abs(dx), ady = Math.abs(dy);
    const reach = 76;
    const hitDx = reach + t.w / 2 - 6;                        // 이 거리 안이면 콤보가 닿음
    const standDx = Math.min(hitDx - 8, 0.62 * reach + t.w / 2);     // 이만큼까지 다가가서 선다
    const bodyDx = (p.w + t.w) / 2 + 8;                        // 몸이 겹치는 거리 (이보다 가까이는 안 감)
    const inRangeX = adx <= hitDx;
    const aligned = ady < 12;
    const zClose = Math.abs((t.z || 0) - p.z) < 75;

    if (air) {
      // 공중: 적 쪽으로 조종하고 닿으면 내려찍기 연타
      if (adx > 40) dirKey(dx, 0);
      if (ady > 14) dirKey(0, dy);
      if (adx < 90 && ady < 26) mashZ();
      applyPlan(); return;
    }

    if (!acting) {
      if (ady > 10) dirKey(0, dy);
      if (adx > standDx) dirKey(dx, 0);
      else if (adx < bodyDx - 4 && aligned) dirKey(-dx, 0);                       // 너무 붙었으면 한 걸음 물러남
      else if (p.face !== sgn(dx) && adx < hitDx + 30) dirKey(dx, 0);              // 그쪽을 보게 방향키 톡
    }
    if (inRangeX && aligned && zClose) {
      mashZ();
      if (p.face !== sgn(dx)) dirKey(dx, 0);                                       // 공격하며 몸을 돌림
      if (interrupt) B.stats.interrupts++;
    }
    // 가끔 점프: 공중에 뜬 적(띄운 적)이 가까이 있으면
    if (!acting && (t.z || 0) > 26 && adx < 100 && ady < 20 && brand() < 0.05) { set('KeyX'); B.stats.jumps++; }
    else if (!acting && inRangeX && aligned && brand() < 0.0015) { set('KeyX'); B.stats.jumps++; }
    applyPlan();
  }

  function walkTo(p, gx, gy, tolX, tolY) {
    const dx = gx - p.x, dy = gy - p.y;
    if (Math.abs(dx) > tolX) dirKey(dx, 0);
    if (Math.abs(dy) > tolY) dirKey(0, dy);
  }

  B.hook = hook;
  Loop.hooks.push(hook);
  if (cfg.god) Debug.god = true;
}
