// 통째로 플레이 테스트 (느림) — 봇이 타이틀 화면부터 결과 화면까지 진짜 UI 로 플레이한다.
//   실행:  GAME_HTML=dist/_integrate.html node tools/tests/playthrough.slow.test.mjs
//   (환경변수 SHOT_DIR=폴더 를 주면 결과 화면 스크린샷을 그 폴더에 저장 — 저장소 밖 폴더를 쓰세요)
//
// 규칙: 봇은 Loop.hooks + Input.press/release 로만 조작한다. 이기려고 내부 API 를 부르지 않는다.
//       (b 항목의 Debug.god 는 "끝까지 갈 수 있는가(완주 가능성)" 를 보는 용도로만 켠다)
//
// 확인하는 것
//   a. 쉬움(god 없음): 결과 씬 도착, cleared=true, 별 1~3, 점수>0, 걸린 시간
//   b. 보통·어려움(god): 5개 방과 보스의 3패턴·2페이즈까지 전부 도달해서 클리어
//   c. 결과 화면에 점수가 보이고, 랭킹 목록에 내 닉네임 줄이 있음 (서버 없음 → 내 기기 저장)
//   d. 처음부터 끝까지 console.error / pageerror 없음
//   e. 결과 화면의 「다시 하기」 → 깨끗한 새 판 (점수 0, 방 1, 남은 엔티티 없음)
//   f. 어려움(god 없음)에서 가만히 있으면 게임 오버 → cleared=false + 격려 문구
import { openGame, step, launch, gameUrl } from '../lib/browser.mjs';
import { check, finish } from '../lib/check.mjs';
import { startThroughUI, installBot, botStats, runUntil } from '../lib/bot.mjs';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CAP_FRAMES = 14 * 60 * 60;          // 하드 캡: 게임 시간 14분 (50400 프레임)
const MIN_SECONDS = 60;                   // 이보다 짧으면 방을 건너뛰었거나 보스가 순식간에 죽은 것 (설계 목표 5~8분과는 따로 아래에서 알려줌)
const DESIGN_FLOOR_SECONDS = 180;         // 과제가 요구한 "3분" — 못 미치면 경고만 출력 (이유는 최종 보고서에 적어 둠)
const SHOT_DIR = process.env.SHOT_DIR || '';
if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true });

const fmtT = f => { const s = f / 60; return `${Math.floor(s / 60)}분 ${(s % 60).toFixed(1)}초 (${f}f)`; };
const stat = (name, r) => console.log(`  [${name}] ${r}`);

// 한 판 플레이: 새 브라우저에서 타이틀 → (닉네임/난이도/시작 클릭) → 봇 → 결과 씬
async function playRun({ name, difficulty, god = false, skill = 'kid', mode = 'play', seed = 1, nickname = '봇용사', keep = false }) {
  const g = await openGame({ file: process.env.GAME_HTML });
  const { page, errors } = g;
  await page.evaluate(s => RNG.seed(s), 1000 + seed);                                   // 게임 난수도 시드 (거의 같은 판이 되지만, 화면을 그린 횟수에 따라 코인이 미끄러지는 거리가 조금 달라 완전히 같지는 않아요)
  const title0 = await page.evaluate(() => ({ scene: Game.scene, shown: !document.getElementById('ui-title').hidden }));
  // 기록용 훅 (관찰만 함) — 첫 방의 roomStarted 도 놓치지 않게 시작 버튼을 누르기 전에 설치
  await page.evaluate(() => {
    const rec = window.__rec = { patterns: [], rooms: [], phase2: false, bossSeen: false, maxFoes: 0, maxEnt: 0, bossMaxHp: 0, minHpRatio: 1, pauseOk: null };
    Loop.hooks.push(() => {
      const b = Game.boss;
      if (b) { rec.bossSeen = true; rec.bossMaxHp = b.maxHp; if (b.pattern && !rec.patterns.includes(b.pattern)) rec.patterns.push(b.pattern); if (b.phase2) rec.phase2 = true; }
      const n = Enemies.aliveCount(); if (n > rec.maxFoes) rec.maxFoes = n;
      if (Entities.list.length > rec.maxEnt) rec.maxEnt = Entities.list.length;
      if (Game.player) rec.minHpRatio = Math.min(rec.minHpRatio, Game.player.hp / Game.player.maxHp);
    });
    Events.on('roomStarted', d => rec.rooms.push(d.index));
  });
  await startThroughUI(page, { nickname, difficulty });
  const started = await page.evaluate(() => ({ scene: Game.scene, diff: Game.difficulty, nick: Game.nickname, titleHidden: document.getElementById('ui-title').hidden }));
  await installBot(page, { mode, seed, god, skill });
  const t0 = Date.now();
  const r = await runUntil(page, () => Game.scene === 'result', { capFrames: CAP_FRAMES, chunk: 600 });
  const wall = Date.now() - t0;
  const res = await page.evaluate(() => Game.result && JSON.parse(JSON.stringify(Game.result)));
  const rec = await page.evaluate(() => ({ ...window.__rec }));
  const bs = await botStats(page);
  const end = await page.evaluate(() => ({ lives: Game.lives, deaths: Game.deaths, maxCombo: Game.combo.max, resultShown: !document.getElementById('ui-result').hidden }));
  const out = { name, difficulty, god, g, page, errors, r, res, rec, bs, title0, started, end, wall };
  stat(name, `결과=${r.scene}${r.capped ? ' (캡 도달!)' : ''}  게임시간=${res ? fmtT(res.timeFrames) : '-'}  처치=${res?.kills}  쓰러짐=${res?.deaths}  최고콤보=${res?.maxCombo}  점수=${res?.score}  별=${res?.stars}  클리어=${res?.cleared}  맞은횟수=${bs?.hitsTaken}  (실제 ${(wall / 1000).toFixed(1)}초)`);
  if (!keep) await g.close();
  return out;
}

// ---------------------------------------------------------------------------
// a + c + d + e : 쉬움, god 없음, 사람 속도 봇
// ---------------------------------------------------------------------------
console.log('\n== a. 쉬움 (god 없음) — 타이틀부터 결과까지 ==');
const A = await playRun({ name: 'easy', difficulty: 'easy', skill: 'kid', keep: true });
{
  const { page, errors, res, rec, title0, started, r } = A;
  check('시작 전에는 타이틀 씬이고 타이틀 화면(DOM)이 보임', title0.scene === 'title' && title0.shown);
  check('「시작!」을 누르면 play 씬, 난이도·닉네임이 반영되고 타이틀 화면이 사라짐', started.scene === 'play' && started.diff === 'easy' && started.nick === '봇용사' && started.titleHidden);
  check('결과 씬에 도착 (캡 14분 안에)', r.scene === 'result' && !r.capped, JSON.stringify(r));
  check('Game.result 가 채워짐', !!res);
  check('쉬움: cleared = true (god 없이 스스로 클리어)', res?.cleared === true);
  check('별 1~3개', res && res.stars >= 1 && res.stars <= 3, `stars=${res?.stars}`);
  check('점수 > 0', res && res.score > 0, `score=${res?.score}`);
  check('5개 방을 전부 지남 (방 순서 0,1,2,3,4)', JSON.stringify(rec.rooms) === '[0,1,2,3,4]' && res?.rooms === 5, JSON.stringify(rec.rooms));
  check('보스가 나왔고 처치함 (kills ≥ 28: 표의 적 수)', rec.bossSeen && res && res.kills >= 28, `kills=${res?.kills}`);
  check('최고 콤보가 10 이상 (콤보 시스템이 실제로 이어짐)', res && res.maxCombo >= 10, `maxCombo=${res?.maxCombo}`);
  check('별점이 쓰러진 횟수와 맞음 (0번=3개, 1~2번=2개, 3번 이상=1개)', res && res.stars === (res.deaths === 0 ? 3 : res.deaths <= 2 ? 2 : 1), `deaths=${res?.deaths} stars=${res?.stars}`);
  const sec = res ? res.timeFrames / 60 : 0;
  check(`걸린 게임 시간이 ${MIN_SECONDS}초 이상 14분 이하 (실제 ${res ? fmtT(res.timeFrames) : '-'})`, sec >= MIN_SECONDS && sec <= 14 * 60);
  if (sec < DESIGN_FLOOR_SECONDS) {
    console.log(`  WARN 설계 목표(5~8분, 계약서 9장) / 과제의 3분 기준에 못 미침: 봇이 ${sec.toFixed(0)}초에 클리어. 봇은 사람보다 훨씬 효율적이라 아이는 더 오래 걸리겠지만, 콘텐츠 양(웨이브 표)이 목표보다 적을 수 있음 → 최종 보고서 knownIssues 참고`);
  }

  // c. 결과 화면 DOM: 점수 + 닉네임 + 랭킹 (서버 없음 → 로컬 폴백)
  await step(page, 150);                                                    // 별 팝/점수 올라가는 연출이 끝나도록
  await page.waitForFunction(() => document.querySelector('#ui-result .save').dataset.state !== 'saving', null, { timeout: 15000 });
  await page.waitForSelector('#ui-result .rank-row', { timeout: 8000 });
  const dom = await page.evaluate(() => {
    const q = s => document.querySelector(s);
    const rows = [...document.querySelectorAll('#ui-result .rank-row')].map(li => ({ me: li.dataset.me === '1', text: li.textContent, nick: li.querySelector('.rank-nick')?.textContent, score: li.querySelector('.rank-score')?.textContent }));
    return {
      shown: !q('#ui-result').hidden, title: q('#ui-res-title').textContent, total: q('#ui-result .total b').textContent,
      saveState: q('#ui-result .save').dataset.state, saveText: q('#ui-result .save-text').textContent,
      starsShown: q('#ui-result .stars').dataset.shown, starsTotal: q('#ui-result .stars').dataset.total,
      msg: q('#ui-result .res-msg').textContent, rows, sub: q('#ui-result .res-sub').textContent,
      stats: [...document.querySelectorAll('#ui-result .stat-grid li')].map(li => li.textContent),
      pauseBtnHidden: q('#ui-pause').hidden, titleHidden: q('#ui-title').hidden, scene: Game.scene, nickInGame: Game.nickname,
    };
  });
  const fmtN = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  check('결과 화면이 보이고 제목이 "스테이지 클리어!"', dom.shown && dom.title === '스테이지 클리어!', dom.title);
  check('결과 화면에 최종 점수가 표시됨 (Game.result.score 와 같음)', dom.total === fmtN(res.score), `${dom.total} vs ${fmtN(res.score)}`);
  check('별이 결과 별점만큼 켜짐', Number(dom.starsShown) === res.stars && Number(dom.starsTotal) === res.stars, `${dom.starsShown}/${dom.starsTotal}`);
  check('저장 상태: 서버가 없으면 "내 기기에만 저장됐어요" (local)', dom.saveState === 'local' && /내 기기/.test(dom.saveText), `${dom.saveState} ${dom.saveText}`);
  const mine = dom.rows.filter(x => x.me);
  check('랭킹 목록에 내 닉네임 줄이 정확히 1개 있고 닉네임이 맞음', mine.length === 1 && mine[0].nick === '봇용사', JSON.stringify(mine));
  check('랭킹의 내 점수가 결과 점수와 같음', mine[0] && mine[0].score === fmtN(res.score), `${mine[0]?.score}`);
  check('결과 격려 문구가 비어 있지 않음', dom.msg.trim().length > 4, dom.msg);
  check('걸린 시간·처치·콤보가 통계로 표시됨', dom.stats.length >= 4 && dom.stats.some(s => s.includes('처치')) && dom.stats.some(s => s.includes('콤보')), dom.stats.join(' | '));
  const stored = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('jd:scores') || '[]'); } catch { return null; } });
  check('로컬 저장소(jd:scores)에 내 기록이 1개 저장됨', Array.isArray(stored) && stored.length === 1 && stored[0].nickname === '봇용사' && stored[0].score === res.score, JSON.stringify(stored));
  if (SHOT_DIR) await page.screenshot({ path: join(SHOT_DIR, 'result-easy.png') });

  // e. 「다시 하기」 → 깨끗한 새 판
  await page.click('#ui-again');
  await page.waitForFunction(() => Game.scene === 'play', null, { timeout: 5000 });
  const fresh = await page.evaluate(() => ({
    scene: Game.scene, score: Game.score, kills: Game.kills, deaths: Game.deaths, lives: Game.lives, combo: { ...Game.combo }, room: Stage.roomIndex, wave: Stage.waveIndex, state: Stage.state,
    boss: !!Game.boss, result: Game.result, width: Game.world.width, diff: Game.difficulty, nick: Game.nickname, resultHidden: document.getElementById('ui-result').hidden,
    kinds: Entities.list.map(e => e.kind + (e.team === 'neutral' ? '/n' : '')).sort(), foes: Enemies.aliveCount(), hp: Game.player.hp, maxHp: Game.player.maxHp,
    pickups: Entities.list.filter(e => e.kind === 'pickup').length, markers: Entities.list.filter(e => e.kind === 'marker').length, cheer: !!Game.player.cheer, dead: Game.player.dead, x: Game.player.x,
    paused: Game.paused, popups: FX.popups.length, parts: FX.particles.length,
  }));
  check('다시 하기: play 씬, 점수 0 · 처치 0 · 쓰러짐 0 · 콤보 0', fresh.scene === 'play' && fresh.score === 0 && fresh.kills === 0 && fresh.deaths === 0 && fresh.combo.count === 0 && fresh.combo.max === 0, JSON.stringify(fresh.combo));
  check('다시 하기: 같은 난이도·닉네임, 목숨 Infinity(쉬움)', fresh.diff === 'easy' && fresh.nick === '봇용사' && fresh.lives === Infinity);
  check('다시 하기: 방 1(숲 입구), 상태 intro, 폭 960, 결과 화면 숨김', fresh.room === 0 && fresh.state === 'intro' && fresh.width === 960 && fresh.resultHidden && fresh.result === null, JSON.stringify({ room: fresh.room, state: fresh.state, w: fresh.width }));
  check('다시 하기: 남은 적·보스·아이템·마커·입자 없음', fresh.foes === 0 && !fresh.boss && fresh.pickups === 0 && fresh.markers === 0, JSON.stringify(fresh.kinds));
  check('다시 하기: 엔티티는 플레이어 + 효과 레이어뿐', fresh.kinds.filter(k => k.startsWith('player')).length === 1 && fresh.kinds.every(k => k === 'player' || k === 'fx/n'), JSON.stringify(fresh.kinds));
  check('다시 하기: 체력 가득, 만세 자세 해제, 시작 위치', fresh.hp === fresh.maxHp && !fresh.cheer && !fresh.dead && fresh.x < 120, `hp=${fresh.hp} x=${fresh.x}`);
  check('다시 하기: 일시정지 아님, 이전 판의 팝업/입자가 남지 않음', !fresh.paused && fresh.popups === 0, `popups=${fresh.popups} parts=${fresh.parts}`);
  // 두 번째 판도 정상 진행 (봇은 그대로 계속 돌고 있음)
  await step(page, 1500);
  const second = await page.evaluate(() => ({ scene: Game.scene, room: Stage.roomIndex, kills: Game.kills, score: Game.score, frame: Game.frame }));
  check('두 번째 판도 정상 진행: 처치가 쌓이고 첫 판 기록이 섞이지 않음', second.scene === 'play' && second.kills >= 2 && second.kills < 12 && second.frame > 1000 && second.frame < 1600, JSON.stringify(second));

  // 일시정지/재개를 진짜 키보드로 (Esc): 정지 중엔 게임 프레임이 안 흐르고, 재개하면 다시 흐름
  await page.keyboard.press('Escape');
  const p1 = await page.evaluate(() => ({ paused: Game.paused, frame: Game.frame, modal: !document.getElementById('ui-pause-modal').hidden }));
  await step(page, 120);
  const p2 = await page.evaluate(() => ({ frame: Game.frame }));
  check('Esc 로 일시정지: 메뉴가 뜨고 120틱을 돌려도 게임 프레임이 안 흐름', p1.paused && p1.modal && p2.frame === p1.frame, JSON.stringify({ p1, p2 }));
  await page.keyboard.press('Escape');
  await step(page, 30);
  const p3 = await page.evaluate(() => ({ paused: Game.paused, frame: Game.frame, modal: !document.getElementById('ui-pause-modal').hidden }));
  check('Esc 를 다시 누르면 재개되어 프레임이 흐름', !p3.paused && !p3.modal && p3.frame > p1.frame, JSON.stringify(p3));

  // 「처음으로」 로 돌아가 타이틀에서 다시 시작해도 정상
  await page.click('#ui-pause').catch(() => {});                              // (버튼으로도 일시정지 가능)
  const viaBtn = await page.evaluate(() => Game.paused);
  check('일시정지 버튼(⏸)으로도 일시정지', viaBtn === true);
  await page.click('#ui-home'); await page.click('#ui-home');                 // 두 번 눌러야 실행 (실수 방지)
  await page.waitForFunction(() => Game.scene === 'title', null, { timeout: 5000 });
  const t1 = await page.evaluate(() => ({ title: !document.getElementById('ui-title').hidden, ents: Entities.list.length, paused: Game.paused, nick: document.getElementById('ui-nick').value, diffSel: document.querySelector('.diff-card[aria-checked="true"]')?.dataset.diff }));
  check('처음으로 → 타이틀 복귀 (닉네임·난이도 기억, 일시정지 해제)', t1.title && !t1.paused && t1.nick === '봇용사' && t1.diffSel === 'easy', JSON.stringify(t1));
  await page.click('#ui-start');
  await page.waitForFunction(() => Game.scene === 'play', null, { timeout: 5000 });
  const again = await page.evaluate(() => ({ room: Stage.roomIndex, score: Game.score, state: Stage.state }));
  check('타이틀에서 다시 시작해도 깨끗한 새 판', again.room === 0 && again.score === 0 && again.state === 'intro', JSON.stringify(again));
  // 세 번 시작(처음 + 다시 하기 + 처음으로→시작)한 뒤에도 이벤트 리스너가 겹치지 않음: 가짜 enemyKilled 한 번에 점수가 정확히 한 번만 오름
  const leak = await page.evaluate(() => { Game.combo.count = 0; const s0 = Game.score; Events.emit('enemyKilled', { score: 100, x: 300, y: 420, team: 'enemy', kind: 'enemy', boss: false }); return Game.score - s0; });
  check('세 번 시작한 뒤에도 리스너가 겹치지 않음 (enemyKilled 한 번 → 점수 정확히 +100)', leak === 100, `+${leak}`);
  await step(page, 600);
  check('(d) 쉬움 전체 플레이(타이틀→결과→다시하기→처음으로→재시작) 동안 오류 없음', errors.length === 0, errors.slice(0, 3).join(' | '));
  await A.g.close();
}

// ---------------------------------------------------------------------------
// b : 보통 / 어려움 + god — 완주 가능성 (모든 방, 보스 3패턴, 2페이즈)
// ---------------------------------------------------------------------------
for (const difficulty of ['normal', 'hard']) {
  console.log(`\n== b. ${difficulty} + god — 완주 가능성 ==`);
  const R = await playRun({ name: `${difficulty}+god`, difficulty, god: true, skill: 'expert' });
  const { res, rec, errors, r } = R;
  check(`${difficulty}: 결과 씬 도착 (캡 안에)`, r.scene === 'result' && !r.capped);
  check(`${difficulty}+god: 클리어 (cleared=true), 방 5개`, res?.cleared === true && res?.rooms === 5, JSON.stringify(res));
  check(`${difficulty}+god: 방 순서 0→4 전부 지남`, JSON.stringify(rec.rooms) === '[0,1,2,3,4]', JSON.stringify(rec.rooms));
  check(`${difficulty}+god: 보스 3패턴(slam/summon/charge)을 전부 봄`, ['slam', 'summon', 'charge'].every(p => rec.patterns.includes(p)), JSON.stringify(rec.patterns));
  check(`${difficulty}+god: 보스 2페이즈(체력 50% 이하)까지 도달`, rec.phase2 === true);
  check(`${difficulty}+god: 화면의 적은 최대 6마리 + 보스 소환수 범위 (최대 ${rec.maxFoes}마리)`, rec.maxFoes <= 8, `maxFoes=${rec.maxFoes}`);
  check(`${difficulty}+god: 별 1~3, 점수>0`, res && res.stars >= 1 && res.stars <= 3 && res.score > 0, `stars=${res?.stars} score=${res?.score}`);
  check(`(d) ${difficulty}+god: 오류 없음`, errors.length === 0, errors.slice(0, 3).join(' | '));
}

// ---------------------------------------------------------------------------
// 공정성 참고: god 없이 보통/어려움 — 끝까지 가거나 게임 오버 (둘 다 결과 화면이어야 함)
// ---------------------------------------------------------------------------
for (const difficulty of ['normal', 'hard']) {
  console.log(`\n== 공정성 참고: ${difficulty} (god 없음, 사람 속도 봇) ==`);
  const R = await playRun({ name: `${difficulty}`, difficulty, god: false, skill: 'kid', seed: 3 });
  check(`${difficulty} (god 없음): 결과 화면에 도착 (클리어 또는 게임 오버)`, R.r.scene === 'result' && !R.r.capped && !!R.res);
  check(`${difficulty} (god 없음): 결과가 일관됨 (클리어면 별≥1, 게임 오버면 별 0)`, R.res && (R.res.cleared ? R.res.stars >= 1 : R.res.stars === 0), `cleared=${R.res?.cleared} stars=${R.res?.stars}`);
  check(`(d) ${difficulty} (god 없음): 오류 없음`, R.errors.length === 0, R.errors.slice(0, 3).join(' | '));
}

// 처음 해 보는 아이처럼 느리고 어설픈 봇 (반응 지연·느린 연타·자주 멈칫): 더 오래 걸리고 가끔 맞지만 끝까지 갈 수 있어야 함
console.log('\n== 처음 해 보는 아이 속도 (novice 봇, 쉬움) ==');
{
  const R = await playRun({ name: 'easy(novice)', difficulty: 'easy', god: false, skill: 'novice', seed: 3 });
  check('쉬움 + novice 봇: 결과 화면에 도착하고 클리어 (게임 오버가 없는 난이도)', R.r.scene === 'result' && !R.r.capped && R.res?.cleared === true, JSON.stringify(R.res));
  check(`쉬움 + novice 봇: ${MIN_SECONDS}초~14분 (실제 ${R.res ? fmtT(R.res.timeFrames) : '-'})`, R.res && R.res.timeFrames / 60 >= MIN_SECONDS && R.res.timeFrames / 60 <= 14 * 60);
  check('(d) 쉬움 + novice 봇: 오류 없음', R.errors.length === 0, R.errors.slice(0, 3).join(' | '));
}

// ---------------------------------------------------------------------------
// f : 어려움(목숨 1개) + god 없음 + 가만히 있기 → 게임 오버
// ---------------------------------------------------------------------------
console.log('\n== f. 어려움 + 가만히 있기 → 게임 오버 ==');
{
  const F = await playRun({ name: 'hard+idle', difficulty: 'hard', mode: 'idle', keep: true });
  const { page, res, errors, r, end } = F;
  check('가만히 있으면 (캡 안에) 결과 씬 도착', r.scene === 'result' && !r.capped, JSON.stringify(r));
  check('게임 오버: cleared=false, 별 0개', res?.cleared === false && res?.stars === 0, JSON.stringify(res));
  check('어려움은 목숨 1개: 쓰러진 횟수 1, 남은 목숨 0', res?.deaths === 1 && end.lives === 0, `deaths=${res?.deaths} lives=${end.lives}`);
  check('게임 오버는 이른 시간(5분 이내)에 일어남 — 가만히 서 있는 플레이어가 영원히 안 죽는 일 없음', res && res.timeFrames < 5 * 60 * 60, res ? fmtT(res.timeFrames) : '-');
  await step(page, 150);
  await page.waitForFunction(() => document.querySelector('#ui-result .save').dataset.state !== 'saving', null, { timeout: 15000 });
  const dom = await page.evaluate(() => ({
    title: document.querySelector('#ui-res-title').textContent, msg: document.querySelector('#ui-result .res-msg').textContent,
    overMsgs: UI_TUNE.overMsgs, shown: !document.getElementById('ui-result').hidden, starsShown: document.querySelector('#ui-result .stars').dataset.shown,
    total: document.querySelector('#ui-result .total b').textContent, badgeHidden: document.querySelector('#ui-result .badge').hidden,
    save: document.querySelector('#ui-result .save').dataset.state, mine: document.querySelectorAll('#ui-result .rank-row[data-me="1"]').length,
    againVisible: !!document.querySelector('#ui-again') && !document.querySelector('#ui-again').hidden,
  }));
  check('게임 오버 화면: 제목 "아쉬워요!" 이고 결과 화면이 보임', dom.shown && dom.title === '아쉬워요!', dom.title);
  check('게임 오버 격려 문구는 준비된 문구 중 하나이고, 비난하는 말이 없음', dom.overMsgs.includes(dom.msg) && !/실패|못했|바보|졌/.test(dom.msg), dom.msg);
  check('게임 오버: 별 0개, 무사망 뱃지 없음, 「다시 하기」 버튼이 있음', dom.starsShown === '0' && dom.badgeHidden && dom.againVisible, JSON.stringify({ s: dom.starsShown, b: dom.badgeHidden }));
  check('게임 오버 기록도 저장되고 랭킹에 내 줄이 보임', (dom.save === 'local' || dom.save === 'saved') && dom.mine === 1, `${dom.save} mine=${dom.mine}`);
  if (SHOT_DIR) await page.screenshot({ path: join(SHOT_DIR, 'result-gameover.png') });
  // 게임 오버 뒤 「다시 하기」 도 깨끗하게
  await page.click('#ui-again');
  await page.waitForFunction(() => Game.scene === 'play', null, { timeout: 5000 });
  const fr = await page.evaluate(() => ({ lives: Game.lives, deaths: Game.deaths, score: Game.score, room: Stage.roomIndex, hp: Game.player.hp, dead: Game.player.dead, state: Stage.state, foes: Enemies.aliveCount() }));
  check('게임 오버 후 다시 하기: 목숨 1 복구, 쓰러짐 0, 점수 0, 체력 가득, 방 1', fr.lives === 1 && fr.deaths === 0 && fr.score === 0 && fr.hp === 100 && !fr.dead && fr.room === 0 && fr.state === 'intro' && fr.foes === 0, JSON.stringify(fr));
  await step(page, 300);
  check('(d) 어려움 가만히 있기(게임 오버→다시 하기): 오류 없음', errors.length === 0, errors.slice(0, 3).join(' | '));
  await F.g.close();
}

// ---------------------------------------------------------------------------
// 쓰러짐 · 부활 흐름: 쉬움(무한 목숨, 부활 때 점수 10% 감소) / 보통(목숨 3개 → 3번째 쓰러짐에서 게임 오버)
// ---------------------------------------------------------------------------
console.log('\n== 쓰러짐과 부활 ==');
{
  // 쉬움: 점수를 번 뒤 가만히 서서 맞아 쓰러짐 → 90프레임 뒤 제자리 부활 → 이어서 클리어 (별은 2개)
  const g = await openGame({ file: process.env.GAME_HTML });
  const { page, errors } = g;
  await page.evaluate(() => RNG.seed(2024));
  await startThroughUI(page, { nickname: '부활봇', difficulty: 'easy' });
  await page.evaluate(() => { window.__ev = []; Events.on('playerDied', () => window.__ev.push('died')); Events.on('playerRevived', () => window.__ev.push('revived')); Events.on('gameOver', () => window.__ev.push('gameOver')); });
  await installBot(page, { mode: 'play', seed: 5, skill: 'kid' });
  await runUntil(page, () => Game.score >= 400, { capFrames: 4000, chunk: 60 });
  await page.evaluate(() => { window.__bot.cfg.mode = 'idle'; });
  const d = await runUntil(page, () => Stage.state === 'dead', { capFrames: 9000, chunk: 30 });
  const atDeath = await page.evaluate(() => ({ score: Game.score, deaths: Game.deaths, lives: Game.lives, dead: Game.player.dead, state: Game.player.state, room: Stage.roomIndex }));
  check('쉬움: 가만히 있으면 쓰러지고(Stage.state=dead) 쓰러진 횟수가 1', !d.capped && atDeath.deaths === 1 && atDeath.dead && atDeath.state === 'down', JSON.stringify(atDeath));
  check('쉬움: 목숨은 줄지 않음 (Infinity)', atDeath.lives === Infinity);
  await runUntil(page, () => Stage.state !== 'dead', { capFrames: 300, chunk: 5 });
  const afterRev = await page.evaluate(() => ({ score: Game.score, hp: Game.player.hp, maxHp: Game.player.maxHp, dead: Game.player.dead, invuln: Game.player.invuln, state: Stage.state, scene: Game.scene, ev: window.__ev.slice() }));
  const lost = Math.round(atDeath.score * 0.1);
  check('쉬움: 90프레임 뒤 제자리 부활 — 체력 가득, 무적, 싸우던 상태로 복귀', !afterRev.dead && afterRev.hp === afterRev.maxHp && afterRev.invuln > 0 && afterRev.state === 'fight' && afterRev.scene === 'play', JSON.stringify(afterRev));
  check(`쉬움: 부활할 때 점수가 정확히 10% 줄어듦 (${atDeath.score} → ${atDeath.score - lost})`, afterRev.score === atDeath.score - lost, `실제 ${afterRev.score}`);
  check('이벤트 순서: playerDied → playerRevived (gameOver 없음)', JSON.stringify(afterRev.ev) === '["died","revived"]', JSON.stringify(afterRev.ev));
  await page.evaluate(() => { window.__bot.cfg.mode = 'play'; });
  const r = await runUntil(page, () => Game.scene === 'result', { capFrames: 40000, chunk: 600 });
  const res = await page.evaluate(() => Game.result);
  check('쉬움: 한 번 쓰러졌어도 이어서 클리어 — cleared=true, 쓰러짐 1, 별 2개', !r.capped && res?.cleared === true && res?.deaths === 1 && res?.stars === 2, JSON.stringify(res));
  check('(d) 쉬움 쓰러짐·부활·클리어 흐름 동안 오류 없음', errors.length === 0, errors.slice(0, 3).join(' | '));
  await g.close();
}
{
  // 보통: 목숨 3개 — 가만히 있으면 3번 쓰러지고 게임 오버 (사이사이 2번 부활)
  const N = await playRun({ name: 'normal+idle', difficulty: 'normal', mode: 'idle', keep: true });
  const { page, res, r, errors } = N;
  check('보통 + 가만히: 결과 씬 도착, 게임 오버(cleared=false), 별 0', !r.capped && res?.cleared === false && res?.stars === 0, JSON.stringify(res));
  check('보통: 목숨 3개 → 쓰러짐 정확히 3번, 남은 목숨 0', res?.deaths === 3 && N.end.lives === 0, `deaths=${res?.deaths} lives=${N.end.lives}`);
  check('(d) 보통 가만히 있기: 오류 없음', errors.length === 0, errors.slice(0, 3).join(' | '));
  await N.g.close();
}

// ---------------------------------------------------------------------------
// Apps Script 와 같은 환경: 게임을 "origin 이 없는 샌드박스 iframe" 안에서 돌림 (localStorage 접근이 막힘)
//   → Store 의 메모리 폴백, 닉네임 기억, 랭킹(내 기기) 이 오류 없이 동작해야 함
// ---------------------------------------------------------------------------
console.log('\n== 샌드박스 iframe (Apps Script 환경 흉내, localStorage 막힘) ==');
{
  const dir = mkdtempSync(join(tmpdir(), 'jd-host-'));
  const hostFile = join(dir, 'host.html');
  writeFileSync(hostFile, `<!doctype html><html><body style="margin:0"><iframe id="f" src="${gameUrl(process.env.GAME_HTML)}" sandbox="allow-scripts" style="width:1280px;height:720px;border:0"></iframe></body></html>`);
  const browser = await launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
    await page.route(/^https?:/, r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    await page.goto('file://' + hostFile);
    await page.waitForFunction(() => document.getElementById('f') !== null);
    let frame = null;
    for (let i = 0; i < 40 && !frame; i++) { frame = page.frames().find(f => f !== page.mainFrame()); if (!frame) await page.waitForTimeout(100); }
    await frame.waitForFunction(() => typeof Loop !== 'undefined' && Loop.started === true, null, { timeout: 8000 });
    await frame.evaluate(() => { Loop.manual = true; });
    const ls = await frame.evaluate(() => { try { window.localStorage.getItem('x'); return 'accessible'; } catch (e) { return 'blocked'; } });
    check('샌드박스 iframe 에서는 localStorage 가 실제로 막혀 있음 (테스트 환경 확인)', ls === 'blocked', ls);
    await startThroughUI(frame, { nickname: '샌드박스', difficulty: 'easy' });
    await installBot(frame, { mode: 'play', seed: 1, skill: 'kid' });
    const r = await runUntil(frame, () => Game.scene === 'result', { capFrames: CAP_FRAMES, chunk: 600 });
    await frame.evaluate(() => Loop.step(150));
    await frame.waitForFunction(() => document.querySelector('#ui-result .save').dataset.state !== 'saving', null, { timeout: 15000 });
    await frame.waitForSelector('#ui-result .rank-row', { timeout: 8000 });
    const o = await frame.evaluate(() => ({ res: Game.result, save: document.querySelector('#ui-result .save').dataset.state, mine: document.querySelectorAll('#ui-result .rank-row[data-me="1"]').length, nick: Game.nickname }));
    check('샌드박스 iframe: 처음부터 끝까지 클리어 (결과 씬 도착)', !r.capped && o.res?.cleared === true, JSON.stringify(o.res));
    check('샌드박스 iframe: 저장소가 막혀도 기록이 내 기기(메모리)에 저장되고 랭킹에 내 줄이 보임', o.save === 'local' && o.mine === 1, `${o.save} mine=${o.mine}`);
    check('(d) 샌드박스 iframe 플레이 동안 오류 없음', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 실시간 루프 (Loop.manual 끄기): 진짜 requestAnimationFrame 으로 몇 초 돌려도 정상 속도·오류 없음
// ---------------------------------------------------------------------------
console.log('\n== 실시간 루프 (manual 끔) ==');
{
  const g = await openGame({ file: process.env.GAME_HTML, manual: false });
  const { page, errors } = g;
  await startThroughUI(page, { nickname: '실시간', difficulty: 'easy' });
  await installBot(page, { mode: 'play', seed: 1, skill: 'kid' });
  const a = await page.evaluate(() => ({ t: Loop.tickCount, g: Game.frame, now: performance.now(), manual: Loop.manual }));
  await page.waitForTimeout(4000);
  const b = await page.evaluate(() => ({ t: Loop.tickCount, g: Game.frame, now: performance.now(), kills: Game.kills, score: Game.score, scene: Game.scene }));
  const sec = (b.now - a.now) / 1000, tps = (b.t - a.t) / sec;
  check('실시간 루프: 초당 약 60틱 (25~75 사이)', !a.manual && tps > 25 && tps < 75, `${tps.toFixed(1)} 틱/초`);
  check('실시간 루프: 봇이 실제로 싸우고 있음 (처치 또는 점수가 쌓임)', b.scene === 'play' && (b.kills > 0 || b.score > 0 || b.g > 150), JSON.stringify(b));
  check('(d) 실시간 루프 4초 동안 오류 없음', errors.length === 0, errors.slice(0, 3).join(' | '));
  await g.close();
}

finish('playthrough');
