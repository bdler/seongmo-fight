/**
 * 젤리 던전 - Google Apps Script 서버 (Code.gs)
 *
 * 하는 일
 *   1) doGet / include : 게임 화면(index.html)을 웹 앱으로 보여 줘요.
 *   2) saveScore       : 점수를 스프레드시트('Scores' 시트)에 한 줄 저장해요.
 *   3) getTopScores    : 닉네임별 최고 점수 랭킹을 돌려줘요.
 *
 * 꼭 지키는 약속
 *   - 클라이언트가 보낸 값은 절대 믿지 않아요. 전부 여기서 다시 검사해요. (아래 validateScore_ / checkNickname_)
 *   - 개인정보는 닉네임과 게임 숫자만 저장해요. 이메일, 접속 정보, 신원 확인 API 는 쓰지 않아요.
 *   - google.script.run 으로는 숫자/문자열/객체/배열만 돌려줘요. (Date, 함수 금지)
 *   - 이름이 밑줄(_)로 끝나는 함수는 비공개예요: 브라우저(google.script.run)에서 부를 수 없어요.
 *     공개 함수는 doGet, include, saveScore, getTopScores, setup 뿐이에요.
 *
 * 배포 방법은 docs/DEPLOY.md 를 보세요.
 */

// ===========================================================================
// 1. 설정 (숫자와 문구는 여기서만 바꿔요)
// ===========================================================================
const APP_TITLE_ = '젤리 던전';                 // 브라우저 탭 제목
const SHEET_NAME_ = 'Scores';                   // 점수를 적는 시트 이름
const SHEET_FILE_NAME_ = '젤리 던전 랭킹';       // 스프레드시트를 새로 만들 때의 파일 이름
const SHEET_ID_PROP_ = 'SHEET_ID';              // 스크립트 속성 이름 (직접 지정하거나, 자동으로 만든 뒤 기억해 둠)
const HEADER_ = ['시간', '닉네임', '점수', '별', '난이도', '스테이지', '시간(초)'];
const COL_ = { TIME: 0, NICK: 1, SCORE: 2, STARS: 3, DIFF: 4, STAGE: 5, SEC: 6 };   // 열 번호 (0부터)

const LIMITS_ = {
  nickMin: 2, nickMax: 8,        // 닉네임 글자 수
  scoreMax: 999999,              // 점수 0 ~ 999999
  starsMax: 3,                   // 별 0 ~ 3
  timeSecMax: 86400,             // 플레이 시간(초) 0 ~ 24시간
  stageIdMax: 20,                // 스테이지 이름 길이
  rankMax: 50,                   // 랭킹은 최대 50명까지
  rankDefault: 10,               // n 을 안 주면 10명
};
const DIFFICULTIES_ = ['easy', 'normal', 'hard'];   // 허용하는 난이도 (CFG.difficulty 와 같아야 해요)
const DEFAULT_STAGE_ = 'stage1';
const DUP_SECONDS_ = 10;            // 같은 닉네임+점수를 이 시간(초) 안에 또 저장하면 무시 (더블클릭/재시도 방지)
const RANK_CACHE_SECONDS_ = 30;     // 랭킹 조회 결과를 기억해 두는 시간(초)
const LOCK_WAIT_MS_ = 10000;        // 동시에 쓰려는 사람이 있을 때 기다릴 최대 시간(밀리초)
const BUSY_TAG_ = '[busy]';         // "잠깐 뒤에 다시 하면 되는" 오류 표시 (클라이언트가 이 글자를 보고 한 번 더 시도해요)

// ===========================================================================
// 2. 닉네임 금칙어 (js_server.html 의 NICKNAME_BLOCKLIST 와 똑같이 유지해요 - 테스트가 비교해요)
//    * 영어는 소문자로, 띄어쓰기 없이 적어요. 숫자를 글자 대신 쓴 것(sh1t)과 숫자를 끼워 넣은 것도 걸러요.
//    * 이 목록은 시작용이에요. 완벽하지 않으니, 어른이 가끔 랭킹을 훑어봐 주세요.
//    * 새 단어를 넣으려면 아래 배열에 한 줄 추가하고, js_server.html 에도 똑같이 추가해요.
// ===========================================================================
// ==== BLOCKLIST START ====
const BLOCKLIST_ = [
  // 한국어 욕설
  '시발', '씨발', '씨팔', '시팔', 'ㅅㅂ', 'ㅆㅂ', '병신', '븅신', 'ㅂㅅ', '지랄', 'ㅈㄹ',
  '개새끼', '좆', '존나', 'ㅈㄴ', '썅', '쌍년', '염병', '엠창', '느금마', '니애미', '씹',
  '미친놈', '미친년', '또라이', '돌아이', '닥쳐', '꺼져',
  // 한국어 성적 표현 / 위험한 말
  '섹스', '야동', '포르노', '자지', '보지', '창녀', '걸레', '자살',
  // 한국어 차별/혐오 표현
  '한남충', '김치녀', '맘충', '틀딱', '급식충',
  // 영어
  'fuck', 'shit', 'bitch', 'asshole', 'bastard', 'dickhead', 'cunt', 'pussy', 'slut', 'whore',
  'nigger', 'nigga', 'faggot', 'retard', 'porn', 'sex', 'penis', 'vagina', 'hitler',
];
// ==== BLOCKLIST END ====

// 숫자를 글자 대신 쓴 경우를 되돌리는 표 (sh1t -> shit)
const LEET_ = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b' };

// 닉네임에 쓸 수 있는 글자: 숫자, 영어, 한글 자모(ㅋㅋ), 한글 완성형, 공백
const NICK_ALLOWED_ = /^[0-9A-Za-z\u3131-\u318E\uAC00-\uD7A3 ]+$/;

// ===========================================================================
// 3. 웹 앱 (화면)
// ===========================================================================

/** 웹 앱 주소로 들어오면 게임 화면을 보여 줘요. */
function doGet(e) {
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle(APP_TITLE_)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** index.html 안에서 <?!= include('js_core') ?> 처럼 다른 html 파일 내용을 끼워 넣어요. */
function include(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(name)) throw new Error('파일 이름이 올바르지 않아요.');
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/**
 * 처음 한 번 편집기에서 실행해 보는 함수예요 (권한 허용 + 랭킹 시트 미리 만들기).
 * 결과는 '실행 로그'에 나와요. 여러 번 실행해도 안전해요.
 */
function setup() {
  const sheet = withLock_(function () { return ensureSheet_(); });
  let url = '';
  try { url = sheet.getParent().getUrl(); } catch (err) { url = ''; }
  Logger.log('준비 끝! 랭킹이 저장되는 시트: ' + url);
}

// ===========================================================================
// 4. 점수 저장
// ===========================================================================

/**
 * 점수 한 줄을 저장해요.
 * payload: { nickname, score, stageId, difficulty, stars, cleared, timeSec }
 * 돌려주는 값: { ok:true, rank:숫자 }  (같은 기록이 방금 저장됐으면 { ok:true, duplicate:true, rank })
 * 잘못된 값이면 한글 메시지로 Error 를 던져요.
 */
function saveScore(payload) {
  const rec = validateScore_(payload);             // 검사는 잠금(lock) 밖에서 - 잘못된 요청이 줄을 서지 않게

  return withLock_(function () {
    const dupKey = 'jd:dup:' + nickKey_(rec.nickname) + ':' + rec.score;
    if (cacheGet_(dupKey)) {                        // 방금 같은 기록이 저장됐어요: 한 번 더 쓰지 않아요 (결과는 성공으로 알려 줘요)
      return { ok: true, duplicate: true, rank: safeRank_(rec.nickname, true) };
    }
    const sheet = ensureSheet_();
    sheet.appendRow([
      now_(),
      neutralize_(rec.nickname),
      rec.score,
      rec.stars,
      rec.difficulty,
      neutralize_(rec.stageId),
      rec.timeSec,
    ]);
    cachePut_(dupKey, '1', DUP_SECONDS_);
    cacheInvalidateRanking_();
    return { ok: true, rank: safeRank_(rec.nickname, false) };
  });
}

/** 받은 값을 전부 검사하고, 깨끗하게 정리한 새 객체를 돌려줘요. 하나라도 이상하면 Error. */
function validateScore_(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('저장할 기록이 올바르지 않아요.');

  const nickname = checkNickname_(p.nickname);

  const score = p.score;
  if (!isInt_(score) || score < 0 || score > LIMITS_.scoreMax) throw new Error('점수가 올바르지 않아요. (0 ~ ' + LIMITS_.scoreMax + ')');

  let stars = p.stars;
  if (stars === undefined || stars === null) stars = 0;
  if (!isInt_(stars) || stars < 0 || stars > LIMITS_.starsMax) throw new Error('별 개수가 올바르지 않아요. (0 ~ ' + LIMITS_.starsMax + ')');

  const difficulty = p.difficulty;
  if (typeof difficulty !== 'string' || DIFFICULTIES_.indexOf(difficulty) < 0) throw new Error('난이도가 올바르지 않아요.');

  let stageId = p.stageId;
  if (stageId === undefined || stageId === null) stageId = DEFAULT_STAGE_;
  if (typeof stageId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(stageId) || stageId.length > LIMITS_.stageIdMax) throw new Error('스테이지 정보가 올바르지 않아요.');

  let timeSec = p.timeSec;
  if (timeSec === undefined || timeSec === null) timeSec = 0;
  if (typeof timeSec !== 'number' || !isFinite(timeSec) || timeSec < 0 || timeSec > LIMITS_.timeSecMax) throw new Error('플레이 시간이 올바르지 않아요.');
  timeSec = Math.round(timeSec);

  let cleared = p.cleared;
  if (cleared === undefined || cleared === null) cleared = false;
  if (typeof cleared !== 'boolean') throw new Error('클리어 정보가 올바르지 않아요.');
  // 참고: cleared 는 검사만 하고 시트에는 적지 않아요 (시트 열은 계약서의 7개 그대로).

  return { nickname: nickname, score: score, stars: stars, difficulty: difficulty, stageId: stageId, timeSec: timeSec, cleared: cleared };
}

/**
 * 닉네임 검사 + 정리. 통과하면 정리된 닉네임을, 아니면 한글 메시지로 Error 를 던져요.
 * (js_server.html 의 Server.validateNickname 과 같은 규칙이에요 - 테스트가 둘을 비교해요)
 * 순서: 정리(NFC, 공백) -> 앞의 = + - @ 제거(스프레드시트 수식 주입 방지) -> 글자 종류 -> 길이 -> 금칙어
 */
function checkNickname_(raw) {
  if (typeof raw !== 'string') throw new Error('이름을 적어 주세요!');
  let s = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  s = s.replace(/^[=+\-@ ]+/, '');                  // 맨 앞의 수식 문자와 그 뒤 공백 제거
  if (!s) throw new Error('이름을 적어 주세요!');
  if (!NICK_ALLOWED_.test(s)) throw new Error('이름에는 한글, 영어, 숫자만 쓸 수 있어요.');
  if (s.length < LIMITS_.nickMin) throw new Error('이름은 ' + LIMITS_.nickMin + '글자 이상으로 적어 주세요.');
  if (s.length > LIMITS_.nickMax) throw new Error('이름은 ' + LIMITS_.nickMax + '글자까지만 쓸 수 있어요.');
  if (hasBadWord_(s)) throw new Error('이 이름은 쓸 수 없어요. 다른 이름을 적어 줄래요?');
  return s;
}

/** 금칙어가 들어 있는지: 그대로 / 숫자를 글자로 바꿔서 / 숫자를 빼고 - 세 가지 모양으로 살펴봐요. */
function hasBadWord_(s) {
  const lower = s.toLowerCase().replace(/ /g, '');
  const forms = [
    lower,
    lower.replace(/[0-9]/g, function (c) { return LEET_[c] || c; }),
    lower.replace(/[0-9]/g, ''),
  ];
  for (let i = 0; i < forms.length; i++) {
    for (let j = 0; j < BLOCKLIST_.length; j++) {
      if (forms[i].indexOf(BLOCKLIST_[j]) >= 0) return true;
    }
  }
  return false;
}

/** 시트에 쓰기 전 마지막 안전장치: 수식으로 읽힐 수 있는 글자로 시작하면 앞에 ' 를 붙여 글자로 만들어요. */
function neutralize_(text) {
  const s = String(text);
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

function isInt_(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v; }

/** 닉네임 비교용 키 (대소문자 무시) */
function nickKey_(nick) { return String(nick).normalize('NFC').toLowerCase(); }

/** 지금 시각 (테스트에서 바꿔 끼울 수 있게 따로 둠). 시트에는 Date 로 쓰지만, 밖으로 돌려주지는 않아요. */
function now_() { return new Date(); }

// ===========================================================================
// 5. 랭킹 조회
// ===========================================================================

/**
 * 랭킹 상위 n 명 (닉네임별 최고 점수만).
 * n: 1 ~ 50 (기본 10), difficulty: 'easy' | 'normal' | 'hard' | 없음(전체)
 * 돌려주는 값: [{ rank, nickname, score, stars, difficulty }, ...]
 */
function getTopScores(n, difficulty) {
  const limit = normalizeLimit_(n);
  const diff = normalizeDifficultyFilter_(difficulty);
  return rankingList_(diff).slice(0, limit);
}

function normalizeLimit_(n) {
  if (n === undefined || n === null || n === '') return LIMITS_.rankDefault;
  const v = Math.floor(Number(n));
  if (!isFinite(v)) return LIMITS_.rankDefault;
  return Math.max(1, Math.min(LIMITS_.rankMax, v));
}

function normalizeDifficultyFilter_(d) {
  if (d === undefined || d === null || d === '' || d === 'all') return null;
  if (typeof d !== 'string' || DIFFICULTIES_.indexOf(d) < 0) throw new Error('난이도가 올바르지 않아요.');
  return d;
}

function rankCacheKey_(diff) { return 'jd:top:' + (diff || 'all'); }

/** 캐시에 있으면 그걸, 없으면 시트를 읽어 만든 뒤 30초 동안 기억해요. (항상 최대 50명짜리 전체 목록을 기억하고 호출한 쪽이 자름) */
function rankingList_(diff) {
  const key = rankCacheKey_(diff);
  const cached = cacheGet_(key);
  if (cached) {
    try {
      const list = JSON.parse(cached);
      if (Array.isArray(list)) return list;
    } catch (err) { /* 깨진 캐시는 무시하고 다시 만들어요 */ }
  }
  const list = buildRanking_(diff);
  cachePut_(key, JSON.stringify(list), RANK_CACHE_SECONDS_);
  return list;
}

/** 시트의 모든 줄을 읽어 순위표를 만들어요. 시트가 아직 없으면 빈 목록. */
function buildRanking_(diff) {
  const sheet = findSheet_();
  if (!sheet) return [];
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const values = sheet.getRange(2, 1, last - 1, HEADER_.length).getValues();

  const best = {};                                   // 닉네임 키 -> 가장 좋은 기록
  for (let i = 0; i < values.length; i++) {
    const r = parseRow_(values[i], i);
    if (!r) continue;                                // 손으로 고쳐서 이상해진 줄은 건너뜀
    if (diff && r.difficulty !== diff) continue;
    const cur = best[r.key];
    if (!cur || isBetter_(r, cur)) best[r.key] = r;
  }
  const rows = Object.keys(best).map(function (k) { return best[k]; });
  rows.sort(function (a, b) { return isBetter_(a, b) ? -1 : (isBetter_(b, a) ? 1 : 0); });

  return rows.slice(0, LIMITS_.rankMax).map(function (r, i) {
    return { rank: i + 1, nickname: r.nickname, score: r.score, stars: r.stars, difficulty: r.difficulty };
  });
}

/** a 가 b 보다 순위가 높은가: 점수 높은 쪽 -> 같으면 먼저 달성한 쪽 -> 그래도 같으면 윗줄 */
function isBetter_(a, b) {
  if (a.score !== b.score) return a.score > b.score;
  if (a.ts !== b.ts) return a.ts < b.ts;
  return a.idx < b.idx;
}

/** 시트 한 줄을 읽기 좋은 모양으로. 쓸 수 없는 줄이면 null. */
function parseRow_(row, idx) {
  const nickname = String(row[COL_.NICK] === undefined || row[COL_.NICK] === null ? '' : row[COL_.NICK]).trim();
  const score = Number(row[COL_.SCORE]);
  const difficulty = String(row[COL_.DIFF]);
  if (!nickname || row[COL_.SCORE] === '' || !isFinite(score) || DIFFICULTIES_.indexOf(difficulty) < 0) return null;
  let stars = Math.round(Number(row[COL_.STARS]));
  if (!isFinite(stars)) stars = 0;
  return {
    nickname: nickname, key: nickKey_(nickname),
    score: Math.round(score), stars: Math.max(0, Math.min(LIMITS_.starsMax, stars)),
    difficulty: difficulty, ts: toMillis_(row[COL_.TIME]), idx: idx,
  };
}

/** 시간 칸 -> 밀리초 숫자. (Date 객체이든 글자이든 숫자로만 바꿔서 써요 - 어차피 밖으로는 안 나가요) */
function toMillis_(v) {
  if (v && typeof v.getTime === 'function') { const t = v.getTime(); return isFinite(t) ? t : Number.MAX_SAFE_INTEGER; }
  const t = Date.parse(String(v));
  return isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
}

/** 전체 순위표에서 이 닉네임의 등수 (못 찾거나 오류면 0). 저장이 이미 끝났으니 여기서 오류가 나도 저장 결과는 성공이에요. */
function safeRank_(nickname, useCache) {
  try {
    const list = useCache ? rankingList_(null) : buildRanking_(null);
    const key = nickKey_(nickname);
    for (let i = 0; i < list.length; i++) if (nickKey_(list[i].nickname) === key) return list[i].rank;
  } catch (err) { Logger.log('rank 계산 실패: ' + err); }
  return 0;
}

// ===========================================================================
// 6. 스프레드시트 자동 준비
// ===========================================================================

/**
 * 이미 있는 스프레드시트를 찾아요. 못 찾으면 null (새로 만들지는 않아요).
 * 순서: 스크립트 속성 SHEET_ID -> 이 스크립트가 붙어 있는(컨테이너 바인딩) 스프레드시트.
 * SHEET_ID 가 적혀 있는데 열 수 없으면 오류예요: 조용히 새 시트를 만들어 버리면 예전 기록을 잃어버리니까요.
 */
function findSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty(SHEET_ID_PROP_);
  if (id) {
    try { return SpreadsheetApp.openById(id); }
    catch (err) {
      Logger.log('SHEET_ID 로 시트를 열지 못했어요: ' + err);
      throw new Error('랭킹 시트를 열 수 없어요. 관리자에게 알려 주세요.');
    }
  }
  try {
    const bound = SpreadsheetApp.getActiveSpreadsheet();
    if (bound) return bound;
  } catch (err) { /* 붙어 있는 시트가 없는 독립 스크립트 */ }
  return null;
}

/** 읽기용: 'Scores' 시트가 있으면 돌려주고, 없으면 null. (읽기만 하는 동안은 아무것도 새로 만들지 않아요) */
function findSheet_() {
  const ss = findSpreadsheet_();
  return ss ? ss.getSheetByName(SHEET_NAME_) : null;
}

/** 쓰기용: 스프레드시트와 'Scores' 시트와 머리글 줄이 없으면 만들어요. (잠금 안에서 불러야 안전해요) */
function ensureSheet_() {
  let ss = findSpreadsheet_();
  let created = false;
  if (!ss) {
    ss = SpreadsheetApp.create(SHEET_FILE_NAME_);
    PropertiesService.getScriptProperties().setProperty(SHEET_ID_PROP_, ss.getId());   // 다음에도 같은 시트를 쓰도록 기억
    created = true;
  }
  let sheet = ss.getSheetByName(SHEET_NAME_);
  if (!sheet) {
    if (created) { sheet = ss.getSheets()[0]; sheet.setName(SHEET_NAME_); }              // 새 파일의 빈 기본 시트를 이름만 바꿔서 써요
    else sheet = ss.insertSheet(SHEET_NAME_);
  }
  if (sheet.getLastRow() === 0) prepareSheet_(sheet);
  return sheet;
}

/** 머리글 줄을 쓰고, 열 모양을 정해요. (닉네임/스테이지 열은 '글자'로 고정 - 123 이나 1e5 같은 이름이 숫자로 바뀌지 않게) */
function prepareSheet_(sheet) {
  sheet.getRange(1, 1, 1, HEADER_.length).setValues([HEADER_]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  const rows = Math.max(sheet.getMaxRows(), 2);
  sheet.getRange(1, COL_.TIME + 1, rows, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sheet.getRange(1, COL_.NICK + 1, rows, 1).setNumberFormat('@');
  sheet.getRange(1, COL_.STAGE + 1, rows, 1).setNumberFormat('@');
}

// ===========================================================================
// 7. 잠금(Lock) / 캐시 도우미
// ===========================================================================

/** 한 번에 한 사람만 쓰도록 스크립트 잠금을 잡고 fn 을 실행해요. (오류가 나도 반드시 풀어요) */
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(LOCK_WAIT_MS_); }
  catch (err) { throw new Error(BUSY_TAG_ + ' 지금 저장하는 친구가 많아요. 잠시 뒤에 다시 해 봐요!'); }
  try { return fn(); }
  finally { try { lock.releaseLock(); } catch (err) { /* 이미 풀렸어요 */ } }
}

// 캐시는 "있으면 좋은 것"이라서, 캐시가 고장 나도 저장/조회가 멈추면 안 돼요.
function cacheGet_(key) { try { return CacheService.getScriptCache().get(key); } catch (err) { return null; } }
function cachePut_(key, value, seconds) { try { CacheService.getScriptCache().put(key, value, seconds); } catch (err) { /* 무시 */ } }
function cacheInvalidateRanking_() {
  try {
    CacheService.getScriptCache().removeAll([rankCacheKey_(null)].concat(DIFFICULTIES_.map(rankCacheKey_)));
  } catch (err) { /* 무시 */ }
}
