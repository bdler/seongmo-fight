// server 모듈 테스트 (2/2): src/js_server.html  - 진짜 게임 페이지(헤드리스 Chromium) 안에서 Server 를 검사해요.
//   실행: node tools/build-local.mjs --out dist/_server.html && GAME_HTML=dist/_server.html node tools/tests/server.test.mjs
//
// google.script.run 은 page.addInitScript 로 "가짜"를 심어요 (성공 / 실패 / 영영 답 없음 / 처음만 실패 / 이상한 응답 ...).
// 가짜가 받은 호출 기록(window.__calls)으로 "무엇이, 몇 번, 어떤 모양으로" 서버에 갔는지도 검사해요.
// 가짜를 안 심은 페이지는 "게임 파일을 그냥 열었을 때"(서버 없음)와 같아요.
import { launch, gameUrl } from '../lib/browser.mjs';
import { check, finish } from '../lib/check.mjs';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = readFileSync(resolve(root, 'src', 'js_server.html'), 'utf8');

// ---------------------------------------------------------------------------
// 페이지 안에서 실행되는 가짜 google.script.run (addInitScript 로 주입 — 직렬화되어 가므로 바깥 변수를 쓰면 안 돼요)
// ---------------------------------------------------------------------------
function installGoogleMock(cfg) {
  const state = window.__srv = {
    mode: cfg.mode || 'ok', failCount: cfg.failCount || 0, delay: cfg.delay || 0, lateMs: cfg.lateMs || 600,
    names: cfg.names || ['saveScore', 'getTopScores'], throwSync: false,
    rows: cfg.rows || [
      { rank: 1, nickname: '서버1등', score: 9000, stars: 3, difficulty: 'hard' },
      { rank: 2, nickname: '서버2등', score: 8000, stars: 2, difficulty: 'normal' },
    ],
    saved: [], count: {},
  };
  const calls = window.__calls = [];
  const plain = v => {                                   // 숫자/글자/불리언/null/객체/배열만 참 (Date, 함수, undefined 는 거짓)
    if (v === null || ['string', 'boolean'].includes(typeof v)) return true;
    if (typeof v === 'number') return Number.isFinite(v);
    const tag = Object.prototype.toString.call(v);
    if (tag === '[object Array]') return v.every(plain);
    if (tag === '[object Object]') return Object.keys(v).every(k => plain(v[k]));
    return false;
  };
  const normal = (name, args) => {
    if (name === 'saveScore') { state.saved.push(args[0]); return { ok: { ok: true, rank: state.saved.length } }; }
    return { ok: state.rows.map(r => Object.assign({}, r)) };
  };
  const respond = (name, n, args) => {                   // null = 영영 답 없음
    switch (state.mode) {
      case 'hang': return null;
      case 'fail': return { fail: 'Service invoked too many times in a short time: exec qps' };
      case 'rejectKo': return { fail: '이 이름은 쓸 수 없어요. 다른 이름을 적어 줄래요?' };
      case 'busyKo': return { fail: '[busy] 지금 저장하는 친구가 많아요. 잠시 뒤에 다시 해 봐요!' };
      case 'flaky': return n <= state.failCount ? { fail: 'NetworkError: connection lost' } : normal(name, args);
      case 'failThenHang': return n === 1 ? { fail: 'NetworkError: connection lost' } : null;
      case 'late': { const r = normal(name, args); r.delay = state.lateMs; return r; }
      case 'garbage': return { ok: name === 'saveScore' ? 'ok?' : { not: 'an array' } };
      case 'saveNotOk': return name === 'saveScore' ? { ok: { ok: false } } : normal(name, args);
      case 'junkRows': return name === 'saveScore' ? normal(name, args) : { ok: [{ x: 1 }, null, 5] };
      case 'mixedRows': return name === 'saveScore' ? normal(name, args) : { ok: [{ rank: 1, nickname: '진짜', score: 50, stars: 9, difficulty: 'easy', secret: 'x' }, { x: 1 }, { nickname: '둘째', score: '40' }] };
      default: return normal(name, args);
    }
  };
  const runner = (ok, fail) => {
    const r = { withSuccessHandler: f => runner(f, fail), withFailureHandler: f => runner(ok, f) };
    state.names.forEach(name => {
      r[name] = (...args) => {
        if (state.throwSync) throw new TypeError('boom sync');
        state.count[name] = (state.count[name] || 0) + 1;
        const call = { name, args: JSON.parse(JSON.stringify(args)), t: performance.now(), plain: plain(args), n: state.count[name] };
        calls.push(call);
        const reply = respond(name, call.n, args);
        if (!reply) return;
        setTimeout(() => { if (reply.fail !== undefined) { if (fail) fail(new Error(reply.fail)); } else if (ok) ok(reply.ok); }, reply.delay !== undefined ? reply.delay : state.delay);
      };
    });
    return r;
  };
  window.google = { script: { run: runner(null, null) } };
}

// ---------------------------------------------------------------------------
// 페이지 열기
// ---------------------------------------------------------------------------
setTimeout(() => { console.log('FAIL 워치독: 테스트가 150초 안에 끝나지 않았어요 (어딘가에서 약속이 영영 안 끝나는 것 같아요)'); process.exit(1); }, 150000).unref();
const browser = await launch();
async function open(mock) {                               // mock: undefined 면 google 없음
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  if (mock) await context.addInitScript(installGoogleMock, mock);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
  await page.route(/^https?:/, r => r.fulfill({ status: 200, contentType: r.request().resourceType() === 'stylesheet' ? 'text/css' : 'text/plain', body: '' }));
  await page.goto(gameUrl(), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof Loop !== 'undefined' && Loop.started === true && typeof Server !== 'undefined' && typeof Server.saveScore === 'function', null, { timeout: 8000 });
  await page.evaluate(() => { Loop.manual = true; Server.config.retryDelayMs = 80; });         // 테스트가 오래 걸리지 않게 재시도 대기를 줄임
  return {
    page, errors,
    ev: (fn, arg) => page.evaluate(fn, arg),
    done: async label => { check(`[${label}] 콘솔/페이지 오류가 없음`, errors.length === 0, errors.slice(0, 2).join(' | ')); await context.close(); },
  };
}
const J = v => JSON.stringify(v);
const GOOD = { nickname: '민준이', score: 1234, stageId: 'stage1', difficulty: 'normal', stars: 2, cleared: true, timeSec: 321 };
const section = async (name, fn) => {
  try { await fn(); } catch (e) { check(`[${name}] 구역이 예외 없이 끝남`, false, String((e && e.stack) || e).split('\n').slice(0, 3).join(' | ')); }
};

// ===========================================================================
// 1. 정적 규칙 (파일 내용)
// ===========================================================================
await section('정적', async () => {
  check('[정적] </script> 문자열이 본문에 없음 (Apps Script include 가 깨짐)', (SRC.match(/<\/script>/g) || []).length === 1 && SRC.trimEnd().endsWith('</script>'));
  check('[정적] <? 로 시작하는 글자가 없음 (Apps Script 템플릿 오류)', !/<\?/.test(SRC));
  check('[정적] alert/confirm/prompt/eval/document.write/Math.random 을 쓰지 않음', !/\b(alert|confirm|prompt|eval)\s*\(|document\.write|Math\.random/.test(SRC));
  check('[정적] 외부 주소/스크립트/쿠키를 쓰지 않음', !/https?:\/\//.test(SRC) && !/document\.cookie|XMLHttpRequest|fetch\s*\(|sendBeacon|WebSocket/.test(SRC));
  check('[정적] localStorage 를 직접 만지지 않고 Store 만 씀', !/localStorage|sessionStorage|indexedDB/.test(SRC));
  check('[정적] google.script.run 은 이 파일에서 쓰고, 사용자 신원/이메일을 요구하지 않음', /google\.script/.test(SRC) && !/email|getActiveUser/i.test(SRC));
});

// ===========================================================================
// 2. 서버 없음 (게임 파일을 그냥 열었을 때)
// ===========================================================================
await section('서버없음', async () => {
  const g = await open();
  check('[서버없음] Server.available 은 false', (await g.ev(() => Server.available)) === false);
  const rej = await g.ev(async () => { try { await Server.call('saveScore', {}); return 'resolved'; } catch (e) { return e.code; } });
  check('[서버없음] Server.call 은 reject (code unavailable)', rej === 'unavailable', String(rej));

  const r1 = await g.ev(p => Server.saveScore(p), GOOD);
  check('[서버없음] saveScore 는 내 기기에 저장하고 { ok:true, source:local, warning:no_server, rank:1 }', r1.ok === true && r1.source === 'local' && r1.warning === 'no_server' && r1.rank === 1, J(r1));
  const stored = await g.ev(() => JSON.parse(localStorage.getItem('jd:scores')));
  check('[서버없음] Store(jd:scores) 에 기록이 1개 (닉네임/점수/별/난이도/스테이지/클리어/시간)', stored.length === 1 && stored[0].nickname === '민준이' && stored[0].score === 1234 && stored[0].stars === 2 && stored[0].difficulty === 'normal' && stored[0].stageId === 'stage1' && stored[0].cleared === true && stored[0].timeSec === 321, J(stored));
  check('[서버없음] 저장된 값은 전부 숫자/글자/불리언 (Date 없음, 개인정보 필드 없음)', stored.every(e => Object.values(e).every(v => ['string', 'number', 'boolean'].includes(typeof v))) && Object.keys(stored[0]).sort().join() === 'cleared,difficulty,nickname,score,stageId,stars,t,timeSec');

  // 랭킹: 정렬, 닉네임별 최고, 동점은 먼저 달성한 쪽
  await g.ev(() => { Server.local.clear(); let t = 1000; Server.now = () => t++; });
  for (const [nickname, score, difficulty] of [['가가가', 500, 'easy'], ['나나나', 900, 'hard'], ['다다다', 700, 'normal'], ['라라라', 700, 'normal']]) {
    await g.ev(p => Server.saveScore(p), { ...GOOD, nickname, score, difficulty });
  }
  let rows = await g.ev(() => Server.getTopScores());
  check('[서버없음] getTopScores: 점수 높은 순, 동점(700)은 먼저 저장한 다다다가 위, 등수 1~4', J(rows.map(r => [r.rank, r.nickname, r.score])) === J([[1, '나나나', 900], [2, '다다다', 700], [3, '라라라', 700], [4, '가가가', 500]]), J(rows));
  check('[서버없음] 랭킹 한 줄은 rank/nickname/score/stars/difficulty 5개 필드', rows.every(r => Object.keys(r).sort().join() === 'difficulty,nickname,rank,score,stars'));
  check('[서버없음] 랭킹 결과에 source 표시: local (목록 자체에는 안 보임)', (await g.ev(async () => { const r = await Server.getTopScores(); return [r.source, Object.keys(r).join(), JSON.stringify(r).includes('source')]; })).join() === 'local,0,1,2,3,false');
  rows = await g.ev(() => Server.getTopScores(2));
  check('[서버없음] getTopScores(2) 는 2명', rows.length === 2 && rows[0].nickname === '나나나');
  rows = await g.ev(() => Server.getTopScores(10, 'normal'));
  check('[서버없음] 난이도 필터 normal 은 normal 기록만, 등수는 다시 1부터', J(rows.map(r => [r.rank, r.nickname])) === J([[1, '다다다'], [2, '라라라']]), J(rows));
  check('[서버없음] 모르는 난이도 필터는 전체로 취급', (await g.ev(() => Server.getTopScores(10, 'xxx'))).length === 4);
  const lens = await g.ev(async () => [(await Server.getTopScores(0)).length, (await Server.getTopScores(-5)).length, (await Server.getTopScores(999)).length, (await Server.getTopScores('abc')).length, (await Server.getTopScores(null)).length, (await Server.getTopScores(NaN)).length]);
  check('[서버없음] n 이 이상해도 안전: 0→1명, -5→1명, 999→있는 만큼(4), abc/null/NaN→기본 10까지(4)', J(lens) === J([1, 1, 4, 4, 4, 4]), J(lens));

  // 닉네임별(+난이도별) 최고 기록만 보관
  await g.ev(() => Server.local.clear());
  await g.ev(p => Server.saveScore(p), { ...GOOD, nickname: 'Bob', score: 300 });
  await g.ev(p => Server.saveScore(p), { ...GOOD, nickname: 'bob', score: 100 });          // 더 낮음: 무시
  await g.ev(p => Server.saveScore(p), { ...GOOD, nickname: 'BOB', score: 800, stars: 3 });  // 더 높음: 교체
  await g.ev(p => Server.saveScore(p), { ...GOOD, nickname: 'Bob', score: 50, difficulty: 'hard' });   // 다른 난이도는 따로
  const st2 = await g.ev(() => Server.local.load());
  check('[서버없음] 같은 닉네임(대소문자 무시)+난이도는 최고 기록 하나만 보관', st2.length === 2 && st2.filter(e => e.difficulty === 'normal').length === 1 && st2.find(e => e.difficulty === 'normal').score === 800, J(st2));
  const rBob = await g.ev(async () => [await Server.getTopScores(10), await Server.getTopScores(10, 'hard')]);
  check('[서버없음] 전체 랭킹에서는 Bob 이 한 번만 (최고 800), hard 랭킹에서는 50점', rBob[0].length === 1 && rBob[0][0].score === 800 && rBob[0][0].nickname === 'BOB' && rBob[1].length === 1 && rBob[1][0].score === 50, J(rBob));
  const rSame = await g.ev(async () => { Server.local.clear(); await Server.saveScore({ nickname: 'Same', score: 300, difficulty: 'normal' }); await Server.saveScore({ nickname: 'Same', score: 300, difficulty: 'normal', stars: 3 }); return Server.local.load(); });
  check('[서버없음] 같은 점수를 또 달성해도 먼저 달성한 기록을 유지', rSame.length === 1 && rSame[0].stars === 0, J(rSame));

  // 50개 제한
  await g.ev(async () => {
    Server.local.clear();
    for (let i = 0; i < 60; i++) await Server.saveScore({ nickname: 'q' + String.fromCharCode(97 + Math.floor(i / 26)) + String.fromCharCode(97 + (i % 26)) + 'z', score: 1000 + i, difficulty: 'normal' });
  });
  const st60 = await g.ev(() => Store.get('scores', []));
  const scores60 = st60.map(e => e.score);
  check('[서버없음] 내 기기 기록은 최대 50개, 낮은 점수부터 밀려남', st60.length === 50 && Math.min(...scores60) === 1010 && Math.max(...scores60) === 1059, `len=${st60.length} min=${Math.min(...scores60)} max=${Math.max(...scores60)}`);
  check('[서버없음] 50개를 넘겨 저장해도 getTopScores(50) 은 50명', (await g.ev(() => Server.getTopScores(50))).length === 50);

  // 이상한 입력도 reject 하지 않음
  const bad = await g.ev(async () => {
    const out = [];
    for (const p of [null, undefined, 'abc', 5, [], {}, { nickname: '' }, { nickname: '시발', score: 1 }, { nickname: '=cmd()', score: 1 }, { nickname: 'a', score: 1 }]) {
      try { const r = await Server.saveScore(p); out.push([r.ok, r.source, typeof r.error]); } catch (e) { out.push(['REJECTED', String(e)]); }
    }
    return out;
  });
  check('[서버없음] 잘못된 기록은 reject 가 아니라 { ok:false, source:none, error } 로 알려 줌', bad.every(b => b[0] === false && b[1] === 'none' && b[2] === 'string'), J(bad));
  check('[서버없음] 잘못된 기록은 내 기기에 저장되지 않음', (await g.ev(() => Server.local.load())).every(e => e.nickname.startsWith('q')));

  // 값이 이상해도 친절하게 고쳐서 저장 (서버가 다시 엄격하게 검사함)
  const fixed = await g.ev(async () => {
    Server.local.clear();
    await Server.saveScore({ nickname: '  =가나다  ', score: 5e9, stars: 9, difficulty: 'cheat', stageId: '../x', timeSec: -5, cleared: 'yes' });
    await Server.saveScore({ nickname: '문자점수', score: '77', stars: '2', timeSec: '12.6', cleared: true });   // (별은 클리어했을 때만 남아요 - 아래 '말이 되는 기록' 구역)
    await Server.saveScore({ nickname: '엔에이엔', score: NaN, stars: NaN, timeSec: NaN });
    return Server.local.load();
  });
  const f1 = fixed.find(e => e.nickname === '가나다'), f2 = fixed.find(e => e.nickname === '문자점수'), f3 = fixed.find(e => e.nickname === '엔에이엔');
  check('[서버없음] 이상한 값은 범위 안으로 고침: 닉네임 정리, 점수 99999, 별 3, 난이도 normal, 스테이지 stage1, 시간 0, 클리어 true', f1 && f1.score === 99999 && f1.stars === 3 && f1.difficulty === 'normal' && f1.stageId === 'stage1' && f1.timeSec === 0 && f1.cleared === true, J(f1));
  check('[서버없음] 숫자 모양 글자는 숫자로 (77, 2, 13), NaN 은 0', f2 && f2.score === 77 && f2.stars === 2 && f2.timeSec === 13 && f3 && f3.score === 0 && f3.stars === 0 && f3.timeSec === 0, J([f2, f3]));

  // 망가진 저장소 값은 버림
  await g.ev(() => Store.set('scores', [{ nickname: '정상', score: 5, stars: 1, difficulty: 'easy' }, null, 5, 'x', { nickname: '', score: 1, difficulty: 'easy' }, { nickname: '난이도없음', score: 9 }, { nickname: '점수없음', difficulty: 'easy', score: 'abc' }]));
  const surv = await g.ev(() => Server.getTopScores());
  check('[서버없음] 저장소에 깨진 값이 섞여 있어도 쓸 수 있는 것만 보여줌', surv.length === 1 && surv[0].nickname === '정상');
  await g.ev(() => Store.set('scores', 'not-an-array'));
  check('[서버없음] 저장소 값이 배열이 아니어도 빈 랭킹', (await g.ev(() => Server.getTopScores())).length === 0);
  const afterSave = await g.ev(async () => { await Server.saveScore({ nickname: '복구됨', score: 1 }); return Server.local.load().length; });
  check('[서버없음] 깨진 저장소 위에서도 다음 저장은 정상', afterSave === 1);

  // 큰 숫자/점수 형식은 UI 가 보내는 모양 그대로 통과 (UI 호출 모양)
  const uiShape = await g.ev(() => Server.saveScore({ nickname: '용사', score: 4321, stageId: 'stage1', difficulty: 'hard', stars: 3, cleared: true, timeSec: 400 }));
  check('[서버없음] UI(js_ui.html)가 보내는 payload 모양이 그대로 통과', uiShape.ok === true && uiShape.source === 'local');
  await g.done('서버없음');
});

// ===========================================================================
// 3. validateNickname 표
// ===========================================================================
await section('닉네임', async () => {
  const g = await open();
  const FILL = String.fromCharCode(0x3164), ZW = String.fromCharCode(0x200b);                  // 한글 채움 문자 / 폭 없는 공백 (눈에 안 보여요)
  const EMPTY = '이름을 적어 주세요!', CHARS = '이름에는 한글, 영어, 숫자만 쓸 수 있어요.', SHORT = '이름은 2글자 이상으로 적어 주세요.', LONG = '이름은 8글자까지만 쓸 수 있어요.', BAD = '이 이름은 쓸 수 없어요. 다른 이름을 적어 줄래요?';
  const table = [
    // 통과
    ['민준', '민준'], ['젤리왕', '젤리왕'], ['Jelly', 'Jelly'], ['jelly 99', 'jelly 99'], ['가나다라마바사아', '가나다라마바사아'], ['ABCDEFGH', 'ABCDEFGH'], ['12', '12'], ['ㅋㅋ', 'ㅋㅋ'], ['가a1', '가a1'], ['a b', 'a b'],
    ['  가  나  ', '가 나'], ['  ab    cd  ', 'ab cd'], ['a\tb', 'a b'], ['a\u3000b', 'a b'], ['\u1112\u1161\u11ab\u1100\u1173\u11af', '한글'],
    ['=abc', 'abc'], ['+abc', 'abc'], ['@abc', 'abc'], ['-abc', 'abc'], ['= = 가나', '가나'],
    // 거절
    ['', null, EMPTY], ['     ', null, EMPTY], [undefined, null, EMPTY], [null, null, EMPTY], ['===', null, EMPTY],
    ['a', null, SHORT], ['가', null, SHORT], ['+1', null, SHORT], ['@x', null, SHORT], ['-a', null, SHORT],
    ['가나다라마바사아자', null, LONG], ['ABCDEFGHI', null, LONG], ['ab cd ef gh', null, LONG],
    ['=cmd()', null, CHARS], ['ab!', null, CHARS], ['a<b>c', null, CHARS], ['a_b', null, CHARS], ['😀😀', null, CHARS], ['＝cmd', null, CHARS], ['a.b', null, CHARS], ['漢字', null, CHARS], ['a@b', null, CHARS],
    ['시발', null, BAD], ['씨발놈', null, BAD], ['ㅅㅂ', null, BAD], ['FUCK', null, BAD], ['f u c k', null, BAD], ['sh1t', null, BAD], ['시1발', null, BAD], ['착한fuck12', null, BAD], ['=시발', null, BAD], ['SHIT', null, BAD],
    // 괜히 막으면 안 되는 이름
    ['grape', 'grape'], ['class', 'class'], ['새끼고양이', '새끼고양이'], ['Sunny', 'Sunny'], ['사탕공주', '사탕공주'], ['Nazia', 'Nazia'], ['Dickens', 'Dickens'], ['Essen', 'Essen'],
    ['dickhead', null, BAD], ['Hitler', null, BAD],
    // 눈에 안 보이는 글자 (GAS-01 / KIDS-02): 지워서 보고, 이름이 비면 빈 이름
    [FILL + FILL, null, EMPTY], [ZW + FILL + ZW, null, EMPTY], ['시' + FILL + '발', null, BAD], ['fu' + ZW + 'ck', null, BAD], ['f' + FILL + 'u' + FILL + 'c' + FILL + 'k', null, BAD],
    [FILL + '민준', '민준'], ['민' + ZW + '준', '민준'], [String.fromCharCode(0x3165).repeat(2), null, CHARS], ['ㅋㅋ', 'ㅋㅋ'], ['ㅠㅠ', 'ㅠㅠ'],
    // 소리 비슷한 것·자모로 풀어 쓴 것·늘여 쓴 것 (GAS-02 / KIDS-01)
    ['씨바', null, BAD], ['시바', null, BAD], ['ㅅㅣㅂㅏㄹ', null, BAD], ['ㅆㅣㅂㅏㄹ', null, BAD], ['쉬발', null, BAD], ['시이발', null, BAD], ['ㅅㅣ발', null, BAD], ['시ㅂㅏㄹ', null, BAD], ['fuuck', null, BAD], ['shiit', null, BAD], ['fvck', null, BAD], ['phuck', null, BAD], ['fuk', null, BAD], ['ㅁㅊ', null, BAD], ['졸라', null, BAD], ['새끼', null, BAD], ['뒤져', null, BAD], ['죽어', null, BAD], ['ㅅ1ㅂ', null, BAD], ['시ㅋ발', null, BAD],
    // 괜히 막으면 안 되는 이름 (짧고 뜻이 둘인 낱말은 이름 전체일 때만 걸러요)
    ['시바견', '시바견'], ['보지마', '보지마'], ['보지 못함', '보지 못함'], ['걸레질', '걸레질'], ['가자 지금', '가자 지금'], ['말랑이', '말랑이'], ['사과', '사과'], ['시간', '시간'], ['조나단', '조나단'], ['진달래', '진달래'], ['옷방', '옷방'], ['Cucumber', 'Cucumber'], ['Anna', 'Anna'], ['Bobby', 'Bobby'], ['Shiba', 'Shiba'],
    // 첫 글자만 자음으로 쓴 것 / 아이들이 흔히 쓰는 말 (홀로 쓴 자음일 때만: 옷발·밥신 은 통과)
    ['시ㅇ발', null, BAD], ['시a발', null, BAD], ['fㅇuck', null, BAD], ['ㅅ발', null, BAD], ['ㅆ발', null, BAD], ['ㅂ신', null, BAD], ['ㅁ친', null, BAD], ['ㅈ같', null, BAD], ['ㅇㅅ발', null, BAD], ['아이ㅅ발', null, BAD], ['애미', null, BAD], ['애비', null, BAD], ['딸딸이', null, BAD], ['좆만이', null, BAD], ['죽어라', null, BAD], ['멍청이', null, BAD], ['fcuk', null, BAD], ['idiot', null, BAD],
    ['옷발', '옷발'], ['밥신', '밥신'], ['말랑jelly', '말랑jelly'], ['Mia하늘', 'Mia하늘'], ['쓰레기통', '쓰레기통'], ['성교육', '성교육'], ['에어로빅', '에어로빅'], ['2018년생', '2018년생'], ['Heroine', 'Heroine'], ['Tweed', 'Tweed'],
  ];
  const got = await g.ev(rows => rows.map(([input]) => Server.validateNickname(input)), table);
  table.forEach(([input, want, err], i) => {
    const r = got[i];
    const label = input === undefined ? 'undefined' : J(input);
    if (want !== null) check(`[닉네임] ${label} → 통과, 값 ${J(want)}`, r.ok === true && r.value === want && Object.keys(r).sort().join() === 'ok,value', J(r));
    else check(`[닉네임] ${label} → 거절: ${err}`, r.ok === false && r.error === err && Object.keys(r).sort().join() === 'error,ok', J(r));
  });
  const odd = await g.ev(() => [Server.validateNickname(12345), Server.validateNickname({}), Server.validateNickname(['가나'])].map(r => [r.ok, r.value || r.error]));
  check('[닉네임] 숫자/객체/배열이 와도 throw 하지 않고 결과를 돌려줌', odd.length === 3 && odd[0][0] === true && odd[0][1] === '12345' && odd[1][0] === false);
  check('[닉네임] 오류 문구는 전부 한글이고 친절한 말투 (영어/내부 이름 없음)', got.filter(r => !r.ok).every(r => /[가-힣]/.test(r.error) && !/undefined|NaN|object|error/i.test(r.error)));
  const meta = await g.ev(() => ({ same: Server.blocklist === NICKNAME_BLOCKLIST, n: Server.blocklist.length, lower: Server.blocklist.every(w => w === w.toLowerCase() && !/\s/.test(w)), diffs: JSON.stringify(Object.keys(CFG.difficulty)) === JSON.stringify(Server.config.difficulties) }));
  check('[닉네임] 금칙어 목록은 한 군데(NICKNAME_BLOCKLIST + NICKNAME_BLOCKLIST_WHOLE)에 있고 소문자·공백 없음', meta.same && meta.n >= 150 && meta.lower);
  const meta2 = await g.ev(() => ({ same: Server.blocklistWhole === NICKNAME_BLOCKLIST_WHOLE, n: Server.blocklistWhole.length, lower: Server.blocklistWhole.every(w => w === w.toLowerCase() && !/\s/.test(w)) }));
  check('[닉네임] "이름 전체일 때만 거르는" 목록(blocklistWhole)도 노출되고 소문자·공백 없음', meta2.same && meta2.n >= 80 && meta2.lower, J(meta2));
  check('[설정] 난이도 목록이 게임의 CFG.difficulty 키와 같음', meta.diffs);
  // 목록을 늘리면 바로 걸러지는지 (쉽게 확장 가능)
  const ext = await g.ev(() => { const before = Server.validateNickname('젤리괴물').ok; Server.blocklist.push('괴물'); const after = Server.validateNickname('젤리괴물'); Server.blocklist.pop(); return [before, after.ok, after.error]; });
  check('[닉네임] 배열에 단어를 추가하면 바로 적용됨 (확장 쉬움)', ext[0] === true && ext[1] === false);
  await g.done('닉네임');
});

// ===========================================================================
// 4. 서버 있음: 성공
// ===========================================================================
await section('서버성공', async () => {
  const g = await open({ mode: 'ok' });
  check('[서버성공] Server.available 은 true', (await g.ev(() => Server.available)) === true);

  const v = await g.ev(() => Server.call('getTopScores', 3, null));
  const calls0 = await g.ev(() => window.__calls);
  check('[서버성공] Server.call 은 서버 응답으로 resolve', Array.isArray(v) && v.length === 2 && v[0].nickname === '서버1등');
  check('[서버성공] 인자를 그대로 전달 (3, null)', J(calls0[0].args) === '[3,null]');

  await g.ev(() => Server.call('getTopScores', undefined, new Date(0)));
  await g.ev(() => Server.call('saveScore', { when: new Date(0), fn: () => 1, u: undefined, nested: { d: new Date(5) }, list: [1, 'a', null] }));
  const c1 = await g.ev(() => window.__calls.slice(1));
  check('[서버성공] undefined 는 null 로, Date 는 글자로, 함수는 빼고 보냄 (google.script.run 규칙)', c1.every(c => c.plain) && J(c1[0].args) === '[null,"1970-01-01T00:00:00.000Z"]' && c1[1].args[0].fn === undefined && typeof c1[1].args[0].when === 'string' && typeof c1[1].args[0].nested.d === 'string', J(c1));

  for (const bad of ['saveScore_', 'a.b', '', 'constructor', 'toString', 'hasOwnProperty', 'withSuccessHandler', 'withFailureHandler', '1abc', 'a b', 'x'.repeat(5) + '()']) {
    const r = await g.ev(async n => { const t0 = performance.now(); try { await Server.call(n); return ['resolved']; } catch (e) { return [e.code, performance.now() - t0]; } }, bad);
    check(`[서버성공] 이상한 서버 함수 이름 ${J(bad)} → 바로 reject (nofunction, 시간 초과까지 안 기다림)`, r[0] === 'nofunction' && r[1] < 3000, J(r));
  }
  const nf = await g.ev(async () => { try { await Server.call('noSuchFn', 1); return 'resolved'; } catch (e) { return e.code; } });
  check('[서버성공] 서버에 없는 함수를 부르면 reject (nofunction)', nf === 'nofunction');

  // saveScore (앞 검사에서 쌓인 호출 기록은 비우고 시작)
  await g.ev(() => { Server.local.clear(); window.__calls.length = 0; window.__srv.count = {}; window.__srv.saved = []; });
  const r1 = await g.ev(p => Server.saveScore(p), { ...GOOD, nickname: '  젤리  왕 ', email: 'kid@example.com', ip: '1.2.3.4', extra: { a: 1 } });
  const sent = (await g.ev(() => window.__calls)).filter(c => c.name === 'saveScore');
  check('[서버성공] saveScore → { ok:true, source:server, rank:1 } (서버가 알려 준 등수)', r1.ok === true && r1.source === 'server' && r1.rank === 1 && r1.warning === undefined, J(r1));
  check('[서버성공] 서버 호출은 정확히 1번', sent.length === 1);
  check('[서버성공] 서버로 간 값은 정리된 7개 필드뿐 (이메일/IP/기타 필드는 안 감)', J(Object.keys(sent[0].args[0]).sort()) === J(['cleared', 'difficulty', 'nickname', 'score', 'stageId', 'stars', 'timeSec']) && sent[0].args[0].nickname === '젤리 왕' && sent[0].args[0].score === 1234, J(sent[0].args));
  check('[서버성공] 서버로 간 모든 인자가 순수한 값(숫자/글자/불리언/객체/배열)', (await g.ev(() => window.__calls)).every(c => c.plain));
  check('[서버성공] 서버 저장이 성공해도 내 기기 기록에도 남김 (나중에 서버가 안 될 때를 위해)', (await g.ev(() => Server.local.load())).some(e => e.nickname === '젤리 왕' && e.score === 1234));

  const r2 = await g.ev(p => Server.saveScore(p), { ...GOOD, nickname: '점수크게', score: 5e9, stars: 9, difficulty: 'cheat' });
  const sent2 = (await g.ev(() => window.__calls)).filter(c => c.name === 'saveScore')[1];
  check('[서버성공] 범위를 벗어난 값은 고쳐서 보냄 (점수 99999, 별 3, 난이도 normal)', r2.source === 'server' && sent2.args[0].score === 99999 && sent2.args[0].stars === 3 && sent2.args[0].difficulty === 'normal', J(sent2.args));
  const n0 = (await g.ev(() => window.__calls)).length;
  const r3 = await g.ev(() => Server.saveScore({ nickname: '시발', score: 1 }));
  check('[서버성공] 닉네임이 규칙에 어긋나면 서버에 보내지 않고 { ok:false } 로 끝', r3.ok === false && r3.source === 'none' && (await g.ev(() => window.__calls)).length === n0, J(r3));

  // getTopScores
  const t1 = await g.ev(() => Server.getTopScores(5, 'hard'));
  const gc = (await g.ev(() => window.__calls)).filter(c => c.name === 'getTopScores').pop();
  check('[서버성공] getTopScores(5,hard) → 서버 호출 인자 [5,"hard"]', J(gc.args) === '[5,"hard"]');
  check('[서버성공] getTopScores 는 서버 랭킹을 돌려주고 source 는 server', t1.length === 2 && t1[0].nickname === '서버1등' && (await g.ev(async () => (await Server.getTopScores()).source)) === 'server');
  await g.ev(() => Server.getTopScores());
  await g.ev(() => Server.getTopScores(500));
  await g.ev(() => Server.getTopScores(7, 'impossible'));
  await g.ev(() => Server.getTopScores(0));
  const args = (await g.ev(() => window.__calls)).filter(c => c.name === 'getTopScores').slice(-4).map(c => c.args);
  check('[서버성공] 인자 정리: 기본 [10,null], 500→[50,null], 모르는 난이도→null, 0→[1,null]', J(args) === J([[10, null], [50, null], [7, null], [1, null]]), J(args));
  const rows = await g.ev(async () => (await Server.getTopScores()).map(r => Object.assign({}, r)));
  check('[서버성공] 랭킹 한 줄은 5개 필드 그대로', rows.every(r => J(Object.keys(r).sort()) === J(['difficulty', 'nickname', 'rank', 'score', 'stars'])));
  check('[서버성공] 서버가 성공했을 때는 내 기기 랭킹으로 바꾸지 않음 (서버 1등이 보임)', rows[0].nickname === '서버1등');
  const empty = await g.ev(async () => { window.__srv.rows = []; const r = await Server.getTopScores(); return [r.length, r.source]; });
  check('[서버성공] 서버 랭킹이 진짜로 비어 있으면 빈 목록 그대로 (내 기기 기록으로 채워 넣지 않음)', J(empty) === J([0, 'server']));
  await g.done('서버성공');
});

// ===========================================================================
// 5. 서버 있음: 실패 / 재시도 / 시간 초과
// ===========================================================================
await section('서버실패', async () => {
  const g = await open({ mode: 'fail' });
  await g.ev(() => Server.local.clear());
  const t0 = Date.now();
  const r = await g.ev(p => Server.saveScore(p), GOOD);
  const dt = Date.now() - t0;
  const calls = (await g.ev(() => window.__calls)).filter(c => c.name === 'saveScore');
  check('[서버실패] 서버 오류여도 reject 하지 않고 { ok:true, source:local, warning:server_failed }', r.ok === true && r.source === 'local' && r.warning === 'server_failed' && r.rank === 1, J(r));
  check('[서버실패] 오류 문구를 error 에 남김', /Service invoked too many times/.test(r.error), J(r));
  check('[서버실패] 잠깐 실패(영어 시스템 오류)는 정확히 1번 더 시도 (총 2번)', calls.length === 2, `calls=${calls.length}`);
  check('[서버실패] 재시도는 retryDelayMs(80ms) 만큼 기다린 뒤', calls[1].t - calls[0].t >= 70 && dt < 6000, `간격 ${Math.round(calls[1].t - calls[0].t)}ms`);
  check('[서버실패] 실패해도 내 기기 랭킹에는 저장됨', (await g.ev(() => Server.local.load())).length === 1);
  const lt = await g.ev(async () => { const r = await Server.getTopScores(); return [r.length, r[0].nickname, r.source]; });
  check('[서버실패] getTopScores 도 서버가 실패하면 내 기기 랭킹으로 (source local)', J(lt) === J([1, '민준이', 'local']), J(lt));
  check('[서버실패] getTopScores 도 1번 재시도', (await g.ev(() => window.__calls)).filter(c => c.name === 'getTopScores').length === 2);

  await g.ev(() => { window.__calls.length = 0; window.__srv.count = {}; window.__srv.mode = 'rejectKo'; });
  const rj = await g.ev(p => Server.saveScore(p), { ...GOOD, nickname: '거절당함', score: 1 });
  check('[서버실패] 서버가 일부러 거절한 것(한글 문구)은 다시 시도하지 않음 (1번)', (await g.ev(() => window.__calls)).filter(c => c.name === 'saveScore').length === 1 && rj.warning === 'server_failed' && rj.source === 'local', J(rj));
  check('[서버실패] 거절 문구를 error 에 담음', /쓸 수 없어요/.test(rj.error));

  await g.ev(() => { window.__calls.length = 0; window.__srv.count = {}; window.__srv.mode = 'busyKo'; });
  const bz = await g.ev(p => Server.saveScore(p), { ...GOOD, nickname: '바쁜서버', score: 2 });
  check('[서버실패] 서버가 [busy](지금 바쁨)라고 하면 다시 시도 (2번)', (await g.ev(() => window.__calls)).filter(c => c.name === 'saveScore').length === 2 && bz.source === 'local', J(bz));

  await g.ev(() => { window.__calls.length = 0; window.__srv.count = {}; window.__srv.mode = 'fail'; Server.config.retries = 0; });
  await g.ev(p => Server.saveScore(p), { ...GOOD, nickname: '재시도끔', score: 3 });
  check('[서버실패] retries=0 이면 재시도하지 않음 (1번)', (await g.ev(() => window.__calls)).filter(c => c.name === 'saveScore').length === 1);
  await g.ev(() => { Server.config.retries = 1; });

  // 동기 예외 / 서버 함수 없음
  await g.ev(() => { window.__calls.length = 0; window.__srv.mode = 'ok'; window.__srv.throwSync = true; });
  const ts = await g.ev(async p => { const r = await Server.saveScore(p); const c = await Server.call('getTopScores').then(() => 'resolved', e => e.code); return [r, c]; }, { ...GOOD, nickname: '동기예외', score: 4 });
  check('[서버실패] google.script.run 이 곧바로 예외를 던져도 reject 없이 로컬 폴백 / call 은 failed', ts[0].ok === true && ts[0].source === 'local' && ts[0].warning === 'server_failed' && ts[1] === 'failed', J(ts));
  await g.done('서버실패');

  const g2 = await open({ mode: 'ok', names: ['getTopScores'] });                // saveScore 함수가 서버에 없음 (배포가 옛 버전일 때)
  const nf = await g2.ev(async p => { const r = await Server.saveScore(p); return [r, window.__calls.length]; }, GOOD);
  check('[서버실패] 서버에 saveScore 함수가 없으면(배포 버전이 낡음) 호출 없이 로컬 폴백', nf[0].ok === true && nf[0].source === 'local' && nf[0].warning === 'server_failed' && nf[1] === 0 && /saveScore/.test(nf[0].error), J(nf));
  await g2.done('함수없음');
});

await section('시간초과', async () => {
  const g = await open({ mode: 'hang' });
  await g.ev(() => { Server.config.timeoutMs = 250; Server.local.clear(); });
  const r = await g.ev(async () => { const t0 = performance.now(); try { await Server.call('saveScore', { a: 1 }); return ['resolved']; } catch (e) { return [e.code, Math.round(performance.now() - t0), e.message]; } });
  check('[시간초과] 응답이 없으면 timeoutMs(250ms) 뒤에 reject (code timeout)', r[0] === 'timeout' && r[1] >= 240 && r[1] < 3000, J(r));
  check('[시간초과] 시간 초과 문구는 한글', /[가-힣]/.test(r[2]));
  await g.ev(() => { window.__calls.length = 0; window.__srv.count = {}; });
  const s = await g.ev(async p => { const t0 = performance.now(); const r = await Server.saveScore(p); return [r, Math.round(performance.now() - t0)]; }, GOOD);
  const calls = await g.ev(() => window.__calls.filter(c => c.name === 'saveScore').length);
  check('[시간초과] saveScore 는 시간이 지나면 로컬 폴백 { source:local, warning:server_failed }', s[0].ok === true && s[0].source === 'local' && s[0].warning === 'server_failed' && s[0].rank === 1, J(s));
  check('[시간초과] 시간 초과는 다시 시도하지 않음 (서버 호출 1번, 약 timeoutMs 안에 끝남)', calls === 1 && s[1] >= 240 && s[1] < 3000, `calls=${calls} ${s[1]}ms`);
  const lt = await g.ev(async () => { const t0 = performance.now(); const r = await Server.getTopScores(); return [r.source, r.length, Math.round(performance.now() - t0)]; });
  check('[시간초과] getTopScores 도 시간 초과면 내 기기 랭킹', lt[0] === 'local' && lt[1] === 1 && lt[2] < 3000, J(lt));
  await g.ev(() => { Server.config.timeoutMs = 10000; });
  check('[시간초과] 기본 타임아웃은 10초', (await g.ev(() => Server.config.timeoutMs)) === 10000);
  await g.done('시간초과');

  // 늦게 온 응답은 무시 (이미 로컬 폴백으로 끝냈으니)
  const g2 = await open({ mode: 'late', lateMs: 500 });
  await g2.ev(() => { Server.config.timeoutMs = 150; Server.local.clear(); });
  const late = await g2.ev(async p => { const r = await Server.saveScore(p); await new Promise(res => setTimeout(res, 700)); return [r, await Server.call('getTopScores').then(() => 'ok', e => e.code)]; }, GOOD);
  check('[시간초과] 시간 초과 뒤에 늦게 도착한 성공 응답은 이미 끝난 결과를 바꾸지 못함', late[0].source === 'local' && late[0].warning === 'server_failed' && late[1] === 'timeout');
  await g2.done('늦은응답');
});

await section('전체시간', async () => {
  // 첫 호출은 곧바로 실패 → 재시도는 영영 답이 없음: 전체 상한(totalMs) 안에 끝나야 해요 (UI 의 저장 제한 12초보다 먼저)
  const g = await open({ mode: 'failThenHang' });
  await g.ev(() => { Server.config.timeoutMs = 5000; Server.config.totalMs = 700; Server.config.minRetryWindowMs = 100; Server.local.clear(); });
  const r = await g.ev(async p => { const t0 = performance.now(); const res = await Server.saveScore(p); return [res, Math.round(performance.now() - t0), window.__calls.filter(c => c.name === 'saveScore').length]; }, GOOD);
  check('[전체시간] 실패 뒤 재시도가 멈춰도 totalMs(700ms) 안에 로컬 폴백으로 끝남 (timeoutMs 5초를 다 기다리지 않음)', r[0].source === 'local' && r[0].warning === 'server_failed' && r[1] >= 600 && r[1] < 3000 && r[2] === 2, J(r));
  const lt = await g.ev(async () => { window.__calls.length = 0; window.__srv.count = {}; const t0 = performance.now(); const x = await Server.getTopScores(); return [x.source, Math.round(performance.now() - t0)]; });
  check('[전체시간] 랭킹 조회도 같은 상한을 지킴', lt[0] === 'local' && lt[1] < 3000, J(lt));

  // 남은 시간이 너무 짧으면 재시도 자체를 하지 않음
  await g.ev(() => { window.__calls.length = 0; window.__srv.count = {}; window.__srv.mode = 'fail'; Server.config.totalMs = 300; Server.config.retryDelayMs = 280; Server.config.minRetryWindowMs = 100; });
  const r2 = await g.ev(async p => { const res = await Server.saveScore(p); return [res.source, window.__calls.filter(c => c.name === 'saveScore').length]; }, { ...GOOD, nickname: '시간부족', score: 8 });
  check('[전체시간] 기다린 뒤 남을 시간이 minRetryWindowMs 보다 짧으면 재시도하지 않음 (1번)', J(r2) === J(['local', 1]), J(r2));

  const cfg = await open({ mode: 'ok' });
  const defaults = await cfg.ev(() => ({ t: Server.config.timeoutMs, total: Server.config.totalMs, retries: Server.config.retries }));
  check('[전체시간] 기본값: 호출 10초, 전체 11초(< UI 12초), 재시도 1번, 재시도 대기 1.5초', defaults.t === 10000 && defaults.total === 11000 && defaults.total < 12000 && defaults.retries === 1 && /retryDelayMs:\s*1500\b/.test(SRC), J(defaults));
  await cfg.done('전체시간-기본값');
  await g.done('전체시간');
});

await section('재시도성공', async () => {
  const g = await open({ mode: 'flaky', failCount: 1 });
  await g.ev(() => Server.local.clear());
  const r = await g.ev(p => Server.saveScore(p), GOOD);
  const calls = (await g.ev(() => window.__calls)).filter(c => c.name === 'saveScore');
  check('[재시도] 처음 1번만 실패하면 자동 재시도로 성공 → source server, warning 없음', r.ok === true && r.source === 'server' && r.warning === undefined && calls.length === 2, J(r));
  check('[재시도] 재시도에는 같은 값을 다시 보냄', J(calls[0].args) === J(calls[1].args));
  check('[재시도] 서버 쪽에는 1건만 저장됨', (await g.ev(() => window.__srv.saved.length)) === 1);

  await g.ev(() => { window.__calls.length = 0; window.__srv.count = {}; window.__srv.saved = []; window.__srv.failCount = 2; });
  const r2 = await g.ev(p => Server.saveScore(p), { ...GOOD, nickname: '두번실패', score: 5 });
  check('[재시도] 2번 연속 실패하면 포기하고 로컬 (재시도는 딱 1번이라 총 2번 호출)', r2.source === 'local' && r2.warning === 'server_failed' && (await g.ev(() => window.__calls)).filter(c => c.name === 'saveScore').length === 2, J(r2));

  await g.ev(() => { window.__calls.length = 0; window.__srv.count = {}; window.__srv.failCount = 1; });
  const lt = await g.ev(async () => { const r = await Server.getTopScores(); return [r.source, r.length, window.__calls.filter(c => c.name === 'getTopScores').length]; });
  check('[재시도] 랭킹 조회도 한 번 실패하면 재시도로 서버 랭킹을 보여줌', J(lt) === J(['server', 2, 2]), J(lt));
  await g.done('재시도성공');
});

// ===========================================================================
// 6. 더블클릭 / 동시 저장
// ===========================================================================
await section('더블클릭', async () => {
  const g = await open({ mode: 'ok', delay: 300 });
  await g.ev(() => Server.local.clear());
  const r = await g.ev(async p => {
    const a = Server.saveScore(p), b = Server.saveScore({ ...p, nickname: '  민준이 ' }), c = Server.saveScore({ ...p });
    const res = await Promise.all([a, b, c]);
    return { same: a === b && b === c, res, calls: window.__calls.filter(x => x.name === 'saveScore').length, local: Server.local.load().length };
  }, GOOD);
  check('[더블클릭] 저장 중에 같은 기록을 또 저장하면 같은 약속을 돌려줌', r.same === true);
  check('[더블클릭] 서버 호출은 1번뿐이고 내 기기에도 1건', r.calls === 1 && r.local === 1, J([r.calls, r.local]));
  check('[더블클릭] 세 번 모두 같은 결과 { ok:true, source:server }', r.res.every(x => x.ok === true && x.source === 'server') && J(r.res[0]) === J(r.res[2]));

  const r2 = await g.ev(async p => { const before = window.__calls.length; await Server.saveScore(p); return window.__calls.length - before; }, GOOD);
  check('[더블클릭] 저장이 끝난 뒤에 다시 저장하면 새로 서버에 보냄 (영원히 막지 않음)', r2 === 1);

  const r3 = await g.ev(async p => {
    const before = window.__calls.length;
    const a = Server.saveScore(p), b = Server.saveScore({ ...p, score: p.score + 1 }), c = Server.saveScore({ ...p, nickname: '다른이' }), d = Server.saveScore({ ...p, difficulty: 'hard' });
    await Promise.all([a, b, c, d]);
    return [window.__calls.length - before, new Set([a, b, c, d]).size];
  }, GOOD);
  check('[더블클릭] 점수/닉네임/난이도가 다른 기록은 따로 저장 (서버 4번)', J(r3) === J([4, 4]), J(r3));

  const r4 = await g.ev(async () => { const before = window.__calls.length; const x = Server.saveScore({ nickname: 'Mia', score: 7 }), y = Server.saveScore({ nickname: 'mia', score: 7 }); await Promise.all([x, y]); return [window.__calls.length - before, x === y]; });
  check('[더블클릭] 영어 대소문자만 다른 닉네임도 같은 기록으로 봄', J(r4) === J([1, true]), J(r4));

  // 실패한 뒤에도 막혀 있지 않음 (「다시 시도」 버튼이 동작해야 함)
  await g.ev(() => { window.__srv.mode = 'rejectKo'; });
  const f1 = await g.ev(p => Server.saveScore(p), { ...GOOD, nickname: '다시시도', score: 9 });
  await g.ev(() => { window.__srv.mode = 'ok'; });
  const f2 = await g.ev(p => Server.saveScore(p), { ...GOOD, nickname: '다시시도', score: 9 });
  check('[더블클릭] 실패한 저장 뒤 「다시 시도」 하면 서버에 다시 보내 성공', f1.source === 'local' && f2.source === 'server', J([f1.source, f2.source]));
  await g.done('더블클릭');
});

// ===========================================================================
// 7. 이상한 서버 응답
// ===========================================================================
await section('이상한응답', async () => {
  let g = await open({ mode: 'garbage' });
  await g.ev(() => Server.local.clear());
  let r = await g.ev(async p => [await Server.saveScore(p), (await Server.getTopScores()).source], GOOD);
  check('[이상한응답] 저장 응답이 {ok:true} 가 아니면(글자 "ok?") 실패로 보고 로컬 폴백', r[0].source === 'local' && r[0].warning === 'server_failed', J(r[0]));
  check('[이상한응답] 랭킹 응답이 배열이 아니면 내 기기 랭킹', r[1] === 'local');
  await g.done('garbage');

  g = await open({ mode: 'saveNotOk' });
  r = await g.ev(p => Server.saveScore(p), GOOD);
  check('[이상한응답] 서버가 { ok:false } 라고 하면 로컬 폴백', r.source === 'local' && r.warning === 'server_failed', J(r));
  await g.done('saveNotOk');

  g = await open({ mode: 'junkRows' });
  await g.ev(() => Server.local.clear());
  await g.ev(p => Server.saveScore(p), GOOD);
  r = await g.ev(async () => { const x = await Server.getTopScores(); return [x.source, x.length, x[0] && x[0].nickname]; });
  check('[이상한응답] 랭킹 줄이 전부 쓸 수 없는 값이면 내 기기 랭킹', J(r) === J(['local', 1, '민준이']), J(r));
  await g.done('junkRows');

  g = await open({ mode: 'mixedRows' });
  r = await g.ev(async () => { const x = await Server.getTopScores(); return [x.source, x.map(o => Object.assign({}, o))]; });
  check('[이상한응답] 일부만 이상하면 쓸 수 있는 줄만 정리해서 보여줌 (별 9→3, 글자 점수 "40"→40, 모르는 필드 제거)', r[0] === 'server' && J(r[1]) === J([{ rank: 1, nickname: '진짜', score: 50, stars: 3, difficulty: 'easy' }, { rank: 3, nickname: '둘째', score: 40, stars: 0, difficulty: '' }]), J(r));
  await g.done('mixedRows');
});

// ===========================================================================
// 8. 진짜 UI 와 맞물리는지 (js_ui.html 의 호출 모양 그대로)
// ===========================================================================
await section('UI연동', async () => {
  const RES = { cleared: true, score: 4321, stars: 3, timeFrames: 60 * 321, kills: 20, deaths: 0, maxCombo: 12, difficulty: 'hard', stageId: 'stage1', stageName: '사탕 숲', rooms: 5 };
  const toResult = (g, nick = '용사민준') => g.ev(([res, nk]) => { Game.nickname = nk; Game.result = res; Game.setScene('result'); }, [RES, nick]);
  const waitSave = g => g.page.waitForFunction(() => UI.state().saveState && UI.state().saveState !== 'saving', null, { timeout: 8000 });

  // (a) 서버 성공 → "저장됐어요" + 서버 랭킹 표시
  let g = await open({ mode: 'ok' });
  await g.ev(() => Server.local.clear());
  await toResult(g);
  await waitSave(g);
  let ui = await g.ev(() => ({ s: UI.state().saveState, rows: [...document.querySelectorAll('#ui-result .rank-row')].map(r => r.querySelector('.rank-nick').textContent), calls: window.__calls.map(c => [c.name, c.args]) }));
  check('[UI연동] 결과 화면 → Server.saveScore 호출 → 서버 성공이면 saveState 가 saved', ui.s === 'saved', J(ui));
  const saveCall = ui.calls.find(c => c[0] === 'saveScore');
  const sortedJ = o => J(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
  check('[UI연동] UI 가 만든 payload(점수 4321, 별 3, 난이도 hard, 시간 321초, 클리어)가 서버까지 그대로 감', !!saveCall && sortedJ(saveCall[1][0]) === sortedJ({ nickname: '용사민준', score: 4321, stageId: 'stage1', difficulty: 'hard', stars: 3, cleared: true, timeSec: 321 }), J(saveCall));
  check('[UI연동] 저장이 끝나면 UI 가 Server.getTopScores(10) 로 서버 랭킹을 보여줌', ui.calls.some(c => c[0] === 'getTopScores' && c[1][0] === 10) && ui.rows.join() === '서버1등,서버2등', J(ui));
  await g.done('UI연동-성공');

  // (b) 서버 없음 → "내 기기에만 저장됐어요" + 내 기기 랭킹
  g = await open();
  await g.ev(() => Server.local.clear());
  await toResult(g);
  await waitSave(g);
  ui = await g.ev(() => ({ s: UI.state().saveState, text: document.querySelector('#ui-result .save-text').textContent, rows: [...document.querySelectorAll('#ui-result .rank-row')].map(r => r.querySelector('.rank-nick').textContent) }));
  check('[UI연동] 서버가 없으면 UI 가 "내 기기에만 저장됐어요"(local) 를 보여주고 내 기록이 랭킹에 보임', ui.s === 'local' && /내 기기/.test(ui.text) && ui.rows.join() === '용사민준', J(ui));
  await g.done('UI연동-서버없음');

  // (c) 서버 실패 → 재시도 뒤 local (UI 의 12초 제한 안에 끝남)
  g = await open({ mode: 'fail' });
  await g.ev(() => Server.local.clear());
  const t0 = Date.now();
  await toResult(g);
  await waitSave(g);
  ui = await g.ev(() => UI.state().saveState);
  check('[UI연동] 서버가 계속 실패해도 UI 는 failed 가 아니라 local 로 마무리 (재시도 포함 몇 초 안)', ui === 'local' && Date.now() - t0 < 9000, `${ui} ${Date.now() - t0}ms`);
  await g.done('UI연동-실패');

  // (d) 서버 시간 초과 → 기본 타임아웃(10초)은 UI 의 12초 제한보다 짧아야 함
  g = await open({ mode: 'hang' });
  const limits = await g.ev(() => ({ srv: Server.config.timeoutMs, total: Server.config.totalMs, retry: Server.config.retryDelayMs }));
  check('[UI연동] Server 의 시간 초과(10초)·전체 상한(11초)이 UI 의 저장 제한(12초)보다 짧아서, 서버가 멈춰도 UI 가 먼저 포기하지 않음', limits.srv === 10000 && limits.srv < 12000 && limits.total === 11000);
  await g.ev(() => { Server.config.timeoutMs = 300; Server.local.clear(); });
  await toResult(g);
  await waitSave(g);
  check('[UI연동] 서버가 멈춰도(시간 초과) UI 는 local 로 마무리', (await g.ev(() => UI.state().saveState)) === 'local');
  await g.done('UI연동-멈춤');

  // (e) UI 의 닉네임 검사가 Server.validateNickname 을 그대로 씀
  g = await open();
  const nv = await g.ev(() => ({ ui: ['시발', '=abc', 'a', '  가  나  ', '민준'].map(s => UI.validateNickname(s)), sv: ['시발', '=abc', 'a', '  가  나  ', '민준'].map(s => Server.validateNickname(s)) }));
  check('[UI연동] UI.validateNickname 이 Server.validateNickname 의 결과(오류 문구/정리된 값)를 그대로 사용', nv.ui.every((r, i) => r.ok === nv.sv[i].ok && (r.ok ? r.value === nv.sv[i].value : r.error === nv.sv[i].error)) && nv.ui[1].value === 'abc' && nv.ui[3].value === '가 나', J(nv));
  await g.done('UI연동-닉네임');
});

// ===========================================================================
// 9. 닉네임 만들어 주기 Server.randomNickname() (주사위 버튼·기본 이름용)
// ===========================================================================
await section('랜덤닉네임', async () => {
  const g = await open();
  const first = await g.ev(() => { RNG.seed(1); return Server.randomNickname(); });
  check('[랜덤닉네임] 문자열을 돌려주고 낱말 둘 + 숫자 두 개 모양 (예: 말랑젤리37)', typeof first === 'string' && /^[가-힣]{4,5}[0-9]{2}$/.test(first), first);

  // 시드를 바꿔 가며 3000번: 늘 2~8글자이고 늘 validateNickname 을 통과하고 정리해도 값이 그대로
  const many = await g.ev(() => {
    const seen = new Set(), out = { bad: [], badLen: [], changed: [], n: 0 };
    for (let seed = 1; seed <= 3000; seed++) {
      RNG.seed(seed);
      const name = Server.randomNickname(), r = Server.validateNickname(name);
      out.n++; seen.add(name);
      if (!r.ok) out.bad.push(name);
      else if (r.value !== name) out.changed.push(name);
      if (typeof name !== 'string' || name.length < 2 || name.length > 8) out.badLen.push(name);
    }
    return { n: out.n, bad: out.bad.slice(0, 5), badLen: out.badLen.slice(0, 5), changed: out.changed.slice(0, 5), distinct: seen.size };
  });
  check('[랜덤닉네임] 시드 3000개: 전부 validateNickname 통과 + 2~8글자 + 정리해도 그대로', many.n === 3000 && many.bad.length === 0 && many.badLen.length === 0 && many.changed.length === 0, J(many));
  check('[랜덤닉네임] 이름이 골고루 달라짐 (3000번 중 서로 다른 이름 2000개 이상)', many.distinct > 2000, String(many.distinct));

  // 같은 시드 = 같은 이름 (게임 난수 rand/pick 을 써서 테스트에서 재현돼요), 난수열을 실제로 씀
  const det = await g.ev(() => { RNG.seed(42); const a = Server.randomNickname(); RNG.seed(42); const b = Server.randomNickname(); RNG.seed(43); const c = Server.randomNickname(); RNG.seed(7); Server.randomNickname(); const x = rand(); RNG.seed(7); const y = rand(); return [a === b, a !== c, x !== y]; });
  check('[랜덤닉네임] 같은 시드는 같은 이름, 다른 시드는 다른 이름, 게임 난수열(rand)을 소비함 (Math.random 안 씀)', det.every(Boolean), J(det));

  // 낱말 × 낱말 × 숫자 전부 (24 x 26 x 90 = 5만 6천 개): 어떤 짝이 나와도 막히지 않아야 해요
  const words = await g.ev(() => ({ adj: Server.nickWords.adj.slice(), noun: Server.nickWords.noun.slice() }));
  check('[랜덤닉네임] 낱말 목록: 꾸미는 말과 이름 말이 각각 20개 이상, 중복 없음, 한글 2~3글자, 예시(말랑·폭신·반짝·젤리·사탕·구름·별빛·용사)가 들어 있음',
    words.adj.length >= 20 && words.noun.length >= 20 && new Set(words.adj).size === words.adj.length && new Set(words.noun).size === words.noun.length &&
    [...words.adj, ...words.noun].every(w => /^[가-힣]{2,3}$/.test(w)) && ['말랑', '폭신', '반짝'].every(w => words.adj.includes(w)) && ['젤리', '사탕', '구름', '별빛', '용사'].every(w => words.noun.includes(w)), J([words.adj.length, words.noun.length]));
  const t0 = Date.now();
  const exhaustive = await g.ev(() => {
    const bad = []; let n = 0, maxLen = 0;
    for (const a of Server.nickWords.adj) for (const b of Server.nickWords.noun) for (let d = 10; d <= 99; d++) {
      const name = a + b + d; n++; maxLen = Math.max(maxLen, name.length);
      const r = Server.validateNickname(name);
      if (!r.ok || r.value !== name) bad.push(name);
    }
    return { n, maxLen, bad: bad.slice(0, 10), nbad: bad.length };
  });
  check(`[랜덤닉네임] 낱말 × 낱말 × 숫자(10~99) 전부 ${exhaustive.n}개가 validateNickname 을 통과 (가장 긴 이름 ${exhaustive.maxLen}글자 ≤ 8)  [${Math.round((Date.now() - t0) / 1000)}초]`, exhaustive.nbad === 0 && exhaustive.maxLen <= 8, J(exhaustive));
  // 안전망: 낱말 목록에 금칙어가 섞여 들어와도(누가 낱말을 잘못 늘렸을 때) 나쁜 이름이 나가지 않고, 늘 통과하는 이름이 돌아와요
  const safety = await g.ev(() => {
    const W = Server.nickWords, adj = W.adj.slice(), noun = W.noun.slice(), out = { names: [], bad: [] };
    W.adj.splice(0, W.adj.length, '시발'); W.noun.splice(0, W.noun.length, '병신');           // 모든 짝이 금칙어
    for (let seed = 1; seed <= 200; seed++) { RNG.seed(seed); const n = Server.randomNickname(); out.names.push(n); if (!Server.validateNickname(n).ok) out.bad.push(n); }
    W.adj.splice(0, W.adj.length, ...adj); W.noun.splice(0, W.noun.length, ...noun);
    out.n = new Set(out.names).size; out.sample = out.names[0]; out.names = null;
    return out;
  });
  check('[랜덤닉네임] 낱말이 전부 금칙어여도 나쁜 이름을 내보내지 않음 (안전망: 200번 모두 validateNickname 통과)', safety.bad.length === 0 && safety.n > 5 && /^[가-힣]+[0-9]{2}$/.test(safety.sample), J(safety));
  check('[랜덤닉네임] UI 의 닉네임 검사(UI.validateNickname)도 통과하고, 저장도 됨', await g.ev(async () => { RNG.seed(9); const n = Server.randomNickname(); const u = UI.validateNickname(n); const s = await Server.saveScore({ nickname: n, score: 5, difficulty: 'easy' }); return u.ok && u.value === n && s.ok === true; }));
  await g.done('랜덤닉네임');
});

// ===========================================================================
// 10. 말이 되는 기록 (GAS-06 / KIDS-10): 클라이언트 쪽 정리 + 서버와 같은 설정
// ===========================================================================
await section('말이되는기록', async () => {
  const g = await open({ mode: 'ok' });
  check('[기록] 점수 상한 99999 · 클리어 최소 45초 · 허용 스테이지가 게임의 STAGES 와 같음', await g.ev(() => Server.config.scoreMax === 99999 && Server.config.clearTimeMin === 45 && JSON.stringify(Server.config.stageIds) === JSON.stringify(STAGES.map(s => s.id)) && Server.config.stageIds.includes(Server.config.defaultStage)));
  await g.ev(() => { Server.local.clear(); window.__calls.length = 0; window.__srv.count = {}; window.__srv.saved = []; });
  await g.ev(async () => {
    await Server.saveScore({ nickname: '별만있음', score: 100, stars: 3, cleared: false, timeSec: 20, difficulty: 'easy' });          // 클리어 안 했는데 별 3
    await Server.saveScore({ nickname: '이상한곳', score: 100, stars: 1, cleared: true, timeSec: 100, stageId: 'stage9' });             // 없는 스테이지
    await Server.saveScore({ nickname: '큰점수', score: 123456, stars: 3, cleared: true, timeSec: 100 });                            // 상한 초과
    await Server.saveScore({ nickname: '빠른클리어', score: 100, stars: 1, cleared: true, timeSec: 30 });                             // 45초 미만 클리어: 클라이언트는 그대로 보내고 서버가 판단
  });
  const sent = (await g.ev(() => window.__calls)).filter(c => c.name === 'saveScore').map(c => c.args[0]);
  check('[기록] 별은 클리어했을 때만 서버로 보냄 (클리어 안 한 판의 별 3 → 0)', sent[0].stars === 0 && sent[0].cleared === false && sent[2].stars === 3, J(sent.slice(0, 3)));
  check('[기록] 모르는 스테이지는 stage1 로 고쳐서 보냄', sent[1].stageId === 'stage1', J(sent[1]));
  check('[기록] 점수는 99999 로 줄여서 보냄', sent[2].score === 99999, J(sent[2]));
  check('[기록] 45초 미만 클리어는 클라이언트가 고치지 않고 그대로 보냄 (서버가 거절 → 내 기기에 저장 + warning)', sent[3].timeSec === 30 && sent[3].cleared === true, J(sent[3]));
  const local = await g.ev(() => Server.local.load());
  check('[기록] 내 기기 기록에도 같은 정리(별 0, stage1, 99999)가 적용됨', local.find(e => e.nickname === '별만있음').stars === 0 && local.find(e => e.nickname === '이상한곳').stageId === 'stage1' && local.find(e => e.nickname === '큰점수').score === 99999);
  await g.done('말이되는기록');
});

// ===========================================================================
// 11. UI 가 쓰는 결과 모양 (GAS-03 / GAS-07: 다음 작업이 이 값을 읽어요)
// ===========================================================================
await section('UI계약', async () => {
  // saveScore: 서버에 못 올렸을 때는 늘 ok:true + source:local + warning:'server_failed' + error(이유). 서버가 없는 환경은 warning:'no_server'.
  for (const [mode, label] of [['fail', '시스템 오류'], ['rejectKo', '서버가 거절'], ['busyKo', '서버가 바쁨'], ['saveNotOk', '서버가 ok:false']]) {
    const g = await open({ mode });
    await g.ev(() => { Server.local.clear(); Server.config.retryDelayMs = 20; });
    const r = await g.ev(p => Server.saveScore(p), { ...GOOD, nickname: '실패' + mode.length, score: 11 });
    check(`[UI계약] 서버 실패(${label}) → { ok:true, source:'local', warning:'server_failed', error:문자열 } (UI 가 "다시 보내 볼까요?" 단추를 보일 근거)`, r.ok === true && r.source === 'local' && r.warning === 'server_failed' && typeof r.error === 'string' && r.error.length > 0, J(r));
    check(`[UI계약] 서버 실패(${label}) → retryable === ${mode !== 'rejectKo'} (서버가 기록 자체를 거절하면 false: 다시 보내도 소용없으니 단추를 안 보여도 돼요)`, r.retryable === (mode !== 'rejectKo'), J(r));
    await g.done('UI계약-' + mode);
  }
  let g = await open();
  const nr = await g.ev(p => Server.saveScore(p), { ...GOOD, nickname: '서버없음' });
  check("[UI계약] 서버가 아예 없는 환경은 warning:'no_server' (재시도 단추가 필요 없는 경우와 구별됨)", nr.ok === true && nr.source === 'local' && nr.warning === 'no_server', J(nr));
  await g.done('UI계약-서버없음');

  // getTopScores: 배열 + 숨은 속성 rows.source ('server' | 'local') - 같은 배열을 그대로 넘겨받아야 읽을 수 있어요 (복사하면 사라져요)
  g = await open({ mode: 'ok' });
  const okRows = await g.ev(async () => { const r = await Server.getTopScores(5); const d = Object.getOwnPropertyDescriptor(r, 'source'); return [Array.isArray(r), r.source, d && d.enumerable, JSON.stringify(r).includes('source'), r.slice().source === undefined]; });
  check("[UI계약] getTopScores 결과는 배열이고 rows.source === 'server' (숨은 속성: 목록에 끼지 않고 JSON 에도 안 나옴, slice() 하면 사라짐)", J(okRows) === J([true, 'server', false, false, true]), J(okRows));
  await g.done('UI계약-성공랭킹');
  for (const mode of ['fail', 'hang']) {
    g = await open({ mode });
    await g.ev(() => { Server.config.retryDelayMs = 20; Server.config.timeoutMs = 200; Server.config.totalMs = 600; Server.local.clear(); });
    const lr = await g.ev(async () => { await Server.saveScore({ nickname: '내기록', score: 77, difficulty: 'easy' }); const r = await Server.getTopScores(5); return [Array.isArray(r), r.source, r.map(x => x.nickname)]; });
    check(`[UI계약] 서버 ${mode === 'fail' ? '오류' : '멈춤'}이면 내 기기 랭킹 + rows.source === 'local' ("이 기기의 기록이에요" 표시의 근거)`, J(lr) === J([true, 'local', ['내기록']]), J(lr));
    await g.done('UI계약-로컬랭킹-' + mode);
  }
  g = await open();
  check("[UI계약] 서버가 없는 환경의 랭킹도 rows.source === 'local'", (await g.ev(async () => (await Server.getTopScores()).source)) === 'local');
  await g.done('UI계약-서버없음랭킹');
});

await browser.close();
finish('server');
