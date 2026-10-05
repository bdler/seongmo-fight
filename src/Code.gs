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
  scoreMax: 99999,               // 점수 0 ~ 99999 (진짜 게임의 최고점은 4만 점 안팎이라 넉넉하게 2배 이상)
  starsMax: 3,                   // 별 0 ~ 3 (별은 클리어했을 때만 받을 수 있어요)
  timeSecMax: 86400,             // 플레이 시간(초) 0 ~ 24시간
  clearTimeMin: 45,              // 클리어한 판의 플레이 시간은 최소 45초 (이보다 빨리 깰 수는 없어요)
  stageIdMax: 20,                // 스테이지 이름 길이
  rankMax: 50,                   // 랭킹은 최대 50명까지
  rankDefault: 10,               // n 을 안 주면 10명
};
const DIFFICULTIES_ = ['easy', 'normal', 'hard'];   // 허용하는 난이도 (CFG.difficulty 와 같아야 해요)
const STAGE_IDS_ = ['stage1'];                      // 허용하는 스테이지 이름 (STAGES 의 id 와 같아야 해요. 스테이지를 늘리면 여기에도 추가!)
const DEFAULT_STAGE_ = 'stage1';
const DUP_SECONDS_ = 10;            // 같은 닉네임+점수를 이 시간(초) 안에 또 저장하면 무시 (더블클릭/재시도 방지)
const RANK_CACHE_SECONDS_ = 30;     // 랭킹 조회 결과를 기억해 두는 시간(초)
const LOCK_WAIT_MS_ = 6000;         // 동시에 쓰려는 사람이 있을 때 기다릴 최대 시간(밀리초). 클라이언트의 호출 제한(10초)보다 짧아야 [busy] 가 먼저 도착해서 한 번 더 시도할 수 있어요
const BUSY_TAG_ = '[busy]';         // "잠깐 뒤에 다시 하면 되는" 오류 표시 (클라이언트가 이 글자를 보고 한 번 더 시도해요)
const BURST_MAX_PER_MIN_ = 300;     // 1분에 저장 요청이 이만큼을 넘으면 잠금을 잡기 전에 [busy] 로 돌려보내요 (한 반 30명이 한꺼번에 눌러도 한참 못 미치는 숫자)
const BURST_KEY_SECONDS_ = 90;      // 1분 단위 요청 수를 기억해 두는 시간(초)
const SHEET_ROWS_ = 3000;           // 시트에 미리 만들어 두는 빈 줄 수: 닉네임/스테이지 칸을 '글자' 서식으로 미리 맞춰 둬요 (123, 1e3, TRUE 같은 이름이 숫자로 바뀌지 않게)
const SHEET_ROWS_MARGIN_ = 200;     // 남은 빈 줄이 이보다 적으면 setup 을 다시 실행해 서식을 이어 주세요 (setup 이 알아서 빈 줄을 늘려 줘요)

// ===========================================================================
// 2. 닉네임 금칙어 + 정리 도구  (아이들이 보는 공개 랭킹이라서 가장 꼼꼼하게 막아요)
//    * 금칙어 목록과 정리 도구는 js_server.html 에도 똑같이 있어요. 테스트가 둘을 비교해요. (고칠 때는 두 파일을 같이!)
//    * 목록은 시작용이에요. 완벽하지 않으니, 어른이 가끔 랭킹을 훑어봐 주세요.
//    * 새 단어는 아래 배열에 한 줄 추가하면 바로 적용돼요. 영어는 소문자로, 띄어쓰기 없이 적어요.
//      (소리가 비슷한 것, 숫자를 끼워 넣은 것, 같은 글자를 늘여 쓴 것은 도구가 알아서 같이 걸러요. 자세한 규칙은 docs/DEPLOY.md)
// ===========================================================================
// ==== BLOCKLIST START ====
// (1) 이름 어디에 들어 있어도 걸러요.  ※ 띄어쓰기는 무시하고, 비슷한 모양은 자동으로 같게 봐요:
//     시발 = 씨발 = 씨빨 = ㅅㅣ발 = 시ㅂㅏㄹ = 시이발 = 시1발 = 시ㅋ발 (예사소리로 적으면 된소리도 같이 걸러요. 된소리로 적은 낱말은 된소리만)
const BLOCKLIST_ = [
  // 한국어 욕설
  '시발', '시팔', '시벌', '시봘', '쉬발', '쉬팔', '슈발', '슈팔', '십발', '시부럴', '시부랄', '시바놈', '시바년', '시바새끼',
  '병신', '빙신', '븅신', '병쉰', '지랄', '지럴', '염병', '옘병', '엠창', '앰창',
  '개새', '개세끼', '개쉐', '개쉑', '개색', '개섹', '개년', '개놈', '개자식', '개소리', '개돼지',
  '저새끼', '그새끼', '미친새끼', '미친놈', '미친년', '미친개', '쌍년', '쌍놈', '썅년', '썅놈', '썅새끼',
  '좆', '좃', '존나', '존내', '존니', '조낸', '십새', '십창', '씹보지',
  '또라이', '돌아이', '닥쳐', '닥처', '꺼져', '찐따', '느금마', '느그매', '니애미', '니애비', '니엄마', '니미럴', '패드립', '엿먹', '퍽큐', '뻐큐',
  '죽어버', '죽여버', '뒤져버', '뒈져버', '죽어라', '죽여라', '뒤져라', '디져라', '뒈져라',
  // 첫 글자만 자음으로 쓴 것 (홀로 쓴 자음일 때만 찾아요. 옷발 · 밥신 은 괜찮아요)
  'ㅅ발', 'ㅅ팔', 'ㅂ신', 'ㅁ친', 'ㅈ랄', 'ㅈ같', 'ㅈ까', 'ㅈ나',
  // 한국어 성적 표현 / 위험한 말
  '섹스', '섹시', '야동', '야설', '포르노', '음란', '창녀', '창년', '성폭행', '성추행', '성관계', '성행위', '성매매', '강제추행', '조건만남', '원나잇', '몸캠',
  '딸딸이', '딸치', '딸쳐', '꼴려', '꼴리', '젖꼭지', '젖탱', '빨통', '쭉빵', '보빨', '질싸', '사까시',
  '자살', '자해', '죽고싶', '살인마', '살인자', '살인범', '총기난사',
  // 한국어 차별/혐오 표현, 나쁜 약물
  '한남충', '김치녀', '김치남', '된장녀', '맘충', '틀딱', '급식충', '노인충', '짱깨', '짱개', '쪽바리', '쪽발이', '왜놈', '깜둥이', '조센징', '똥남아', '일베', '정신병자', '개독', '빨갱이', '노알라',
  '히틀러', '대마초', '필로폰', '히로뽕', '코카인', '마리화나', '엑스터시',
  // 한글 자판으로 안 바꾸고 영어로 친 것 (시발 = tlqkf) / 로마자
  'tlqkf', 'qudtls', 'wlfkf', 'sibal', 'ssibal', 'shibal', 'gaesaeki', 'gaesaekki', 'byeongsin', 'byungshin',
  // 자음만 쓴 줄임말 (이름 속에 자음 낱글자로 쓴 것만 찾아요. 글자 속 받침은 괜찮아요: 옷방, 없는)
  'ㅅㅂ', 'ㅂㅅ', 'ㅈㄹ', 'ㅈㄴ', 'ㅁㅊ', 'ㅅㅋ', 'ㅅㄲ', 'ㄱㅅㄲ', 'ㄲㅈ', 'ㄷㅊ', 'ㄴㄱㅁ',
  // 영어
  'fuck', 'fck', 'fcuk', 'fvck', 'phuck', 'fuxk', 'fuking', 'shit', 'shyt', 'bitch', 'biatch', 'bastard', 'asshole', 'arsehole', 'dumbass', 'jackass', 'fatass',
  'dickhead', 'cocksucker', 'penis', 'vagina', 'pussy', 'cunt', 'slut', 'whore', 'nigger', 'nigga', 'faggot', 'fagot', 'retard', 'tranny', 'shemale', 'lesbo',
  'porn', 'xvideos', 'sex', 'hentai', 'horny', 'dildo', 'orgasm', 'blowjob', 'handjob', 'jizz', 'cumshot', 'masturbat', 'jerkoff', 'erotic', 'bukkake', 'bollocks', 'wanker', 'molest', 'pedophile', 'rapist', 'sperm', 'nipple',
  'hitler', 'neonazi', 'terrorist', 'suicide', 'killme', 'killyou', 'killyourself', 'massacre', 'cocaine',
];

// (2) 이름 "전체"가 이 낱말일 때만 걸러요 (뜻이 둘이거나 다른 낱말 속에 흔히 들어 있는 짧은 말).
//     ※ 숫자·띄어쓰기·ㅋㅋ ㅎㅎ ㅠㅠ 는 무시하고 봐요: '보지' '보 지' '보지ㅋㅋ' '보지2' 는 걸리고, '보지마' '시바견' '걸레질' 은 괜찮아요.
const BLOCKLIST_WHOLE_ = [
  '시바', '십팔', '졸라', '미친', '별신', '니미', '새기', '새키', '색기', '쉐기', '섀기', '썅', '씹', 'ㅗ',
  '보지', '자지', '걸레', '갈보', '성기', '자위', '강간', '윤간', '불알', '변태', '몰카', '게이', '호모', '레즈',
  '한남', '한녀', '메갈', '워마드', '나치', '애자', '장애', '장애인', '마약', '아편', '테러', '운지',
  '죽어', '죽여', '죽일', '죽을래', '뒤져', '디져', '뒤질래', '뒈져',
  '애미', '애비', '멍청이', '찌질이', '찌질', '못생김', '왕따', '꼴통', '등신', '머저리', '쓰레기', '대가리', '아가리',
  '항문', '후장', '에로', '유두', '고환', '음경', '음순', '성교', '섹', '발기', '정액', '학살',
  'fuc', 'fuk', 'fuq', 'ass', 'arse', 'dick', 'cock', 'tit', 'tits', 'boob', 'boobs', 'anal', 'anus', 'cum', 'rape', 'nazi', 'kkk', 'gay', 'homo', 'dyke', 'fag',
  'wtf', 'stfu', 'kys', 'kms', 'hoe', 'crap', 'nude', 'nudes', 'naked', 'xxx', 'jap', 'chink', 'spic', 'kike', 'coon', 'paki', 'negro', 'tard', 'pedo', 'gook',
  'wank', 'twat', 'turd', 'prick', 'moron', 'spaz', 'cripple', 'midget', 'die', 'drug', 'drugs',
  'piss', 'boner', 'weed', 'meth', 'heroin', 'condom', 'semen', 'hooker', 'incest', 'thot', 'jerk', 'idiot', 'stupid', 'dumb', 'loser', 'ugly',
];
// ==== BLOCKLIST END ====

// ==== NICK-FILTER START ====
// 닉네임을 정리하고 금칙어를 찾는 도구 모음.
// !! 이 블록은 Code.gs 와 js_server.html 에 글자 하나까지 똑같아야 해요 (들여쓰기만 달라요 - 테스트가 비교해요).
// !! 금칙어 목록(BLOCKLIST_, BLOCKLIST_WHOLE_)은 이 블록 밖에 있어요.
//
// 닉네임에 쓸 수 있는 글자: 숫자, 영어, 보이는 한글 자모(ㅋㅋ: U+3131~U+3163), 한글 완성형, 공백.
//   한글 채움 문자(U+3164)와 옛 자모(U+3165~U+318E)는 일부러 뺐어요. 눈에 안 보이거나 거의 안 쓰는 글자라서
//   "빈 이름"이나 "금칙어 사이에 끼워 넣기"에 쓰일 수 있어요.
const NICK_ALLOWED_ = /^[0-9A-Za-z\u3131-\u3163\uAC00-\uD7A3 ]+$/;

// 눈에 안 보이는 글자(한글 채움, 폭 없는 공백, 방향 표시, 변형 선택자 ...)는 검사하기 전에 지워 버려요.
const NICK_INVISIBLE_ = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB]/g;

// 숫자를 글자 대신 쓴 경우를 되돌리는 표 (sh1t -> shit). 1 은 l 로도 읽어 봐요 (hit1er -> hitler).
const LEET_ = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b' };

// 한글을 낱글자(자모)로 풀 때 겹받침/겹모음은 낱글자로 나눠요 (ㅄ -> ㅂㅅ, ㅟ -> ㅜㅣ). 된소리(ㄲ ㄸ ㅃ ㅆ ㅉ)는 그대로 둬요.
const NICK_FOLD_ = {
  'ㄳ': 'ㄱㅅ', 'ㄵ': 'ㄴㅈ', 'ㄶ': 'ㄴㅎ', 'ㄺ': 'ㄹㄱ', 'ㄻ': 'ㄹㅁ', 'ㄼ': 'ㄹㅂ', 'ㄽ': 'ㄹㅅ', 'ㄾ': 'ㄹㅌ', 'ㄿ': 'ㄹㅍ', 'ㅀ': 'ㄹㅎ', 'ㅄ': 'ㅂㅅ',
  'ㅘ': 'ㅗㅏ', 'ㅙ': 'ㅗㅐ', 'ㅚ': 'ㅗㅣ', 'ㅝ': 'ㅜㅓ', 'ㅞ': 'ㅜㅔ', 'ㅟ': 'ㅜㅣ', 'ㅢ': 'ㅡㅣ',
};
const NICK_CHO_ = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ'.split('').map(nickFold_);
const NICK_JUNG_ = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ'.split('').map(nickFold_);
const NICK_JONG_ = [''].concat('ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ'.split('')).map(nickFold_);

// 금칙어 낱말 속 글자는 된소리도 같이 봐요: 예사소리로 적은 낱말(시발)은 된소리(씨발)도 걸러요. (거꾸로는 안 돼요: 된소리로 적은 낱말(찐따)은 된소리만)
const NICK_LOOSE_ = { 'ㄱ': '[ㄱㄲ]', 'ㄷ': '[ㄷㄸ]', 'ㅂ': '[ㅂㅃ]', 'ㅅ': '[ㅅㅆ]', 'ㅈ': '[ㅈㅉ]' };

const NICK_SYL_START_ = '\u0002';                    // 완성형 글자 하나의 시작 표시
const NICK_SYL_END_ = '\u0003';                      // 완성형 글자 하나의 끝 표시
const NICK_BARRIER_ = '\u0001';                      // "자모만 쓴 줄임말"을 찾을 때 완성형 글자 자리를 막아 두는 표시
const NICK_ELONG_ = /([ㅏ-ㅣ])(?:\u0003?\u0002?ㅇ\1)+/g;                // 시이발 -> 시발 (같은 모음을 ㅇ 로 이어 늘인 것)
const NICK_LAUGH_ = /[ ㅋㅎㅠㅜㅡ]/g;                           // 이름 전체 비교에서는 띄어쓰기와 웃음/울음 자모(ㅋ ㅎ ㅠ ㅜ ㅡ)를 무시해요
const NICK_LAUGH_LIGHT_ = /[ㅋㅎ]/g;                                        // 낱말 속에 끼워 넣은 ㅋ ㅎ 도 한 번 지워서 살펴봐요 (시ㅋ발)
const nickPatternMemo_ = new Map();                  // 금칙어 -> 비교용 정규식 (한 번만 만들어요. 배열에 단어를 더 넣으면 바로 적용돼요)

function nickFold_(c) { return NICK_FOLD_[c] || c; }

/**
 * 닉네임 정리: 눈에 안 보이는 글자 삭제 -> NFC -> 공백 정리 -> 맨 앞의 = + - @ 와 공백 제거 (시트 수식 주입 방지).
 * 아무것도 안 남으면 ''. (문자열만 넣어요)
 */
function nickClean_(text) {
  const s = text.replace(NICK_INVISIBLE_, '').normalize('NFC').replace(/\s+/g, ' ').trim();
  return s.replace(/^[=+\-@ ]+/, '');
}

/**
 * 비교용 "뼈대": 완성형 글자를 낱글자로 풀어요. 글자 하나는 시작/끝 표시로 감싸서, 옆 글자의 받침과 첫소리가 이어 붙어 보이는 일을 막아요.
 *   시발 -> \u0002ㅅㅣ\u0003\u0002ㅂㅏㄹ\u0003   (ㅅㅣ발 / 시ㅂㅏㄹ / ㅅㅣㅂㅏㄹ 처럼 섞어 써도 낱글자는 똑같이 나와요)
 */
function nickSkeleton_(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xAC00 && code <= 0xD7A3) {
      const n = code - 0xAC00;
      out += NICK_SYL_START_ + NICK_CHO_[(n / 588) | 0] + NICK_JUNG_[((n % 588) / 28) | 0] + NICK_JONG_[n % 28] + NICK_SYL_END_;
    } else out += nickFold_(text.charAt(i));
  }
  return out.replace(NICK_ELONG_, '$1');
}

/**
 * 금칙어 하나를 정규식으로: 글자마다 + 를 붙여서 같은 글자를 여러 번 써도(fuuuck, ㅅㅅㅂㅂ) 걸러요.
 * 완성형 글자 안의 낱글자는 붙어 있어야 하고(시바람 의 ㅂㅏ|ㄹ 은 시발이 아니에요), 글자와 글자 사이는 붙어 있든 떨어져 있든 괜찮아요.
 *   strong: 이름 어디에 들어 있어도 걸러요 (마지막 글자가 완성형이면 받침이 더 붙은 글자는 다른 글자로 봐요: 창녀 != 창녕)
 *   whole : 이름 전체가 이 낱말일 때만 걸러요 (보지 != 보지마)
 *   jamoOnly: 자음만 쓴 줄임말(ㅅㅂ)이에요. 이름 속에 자음 낱글자로 쓴 것만 찾아요 (옷방 의 ㅅ+ㅂ 은 괜찮아요)
 *   첫 글자만 자음으로 쓴 낱말(ㅅ발 ㅂ신 ㅈ같)은 홀로 쓴 자음일 때만 걸러요 (옷발 · 밥신 은 괜찮아요)
 */
function nickPattern_(entry) {
  let p = nickPatternMemo_.get(entry);
  if (p) return p;
  const e = String(entry).toLowerCase().replace(/\s/g, '');
  const groups = [];
  let lastIsSyllable = false;
  for (let i = 0; i < e.length; i++) {
    const code = e.charCodeAt(i);
    lastIsSyllable = code >= 0xAC00 && code <= 0xD7A3;
    if (lastIsSyllable) {
      const n = code - 0xAC00;
      groups.push(NICK_CHO_[(n / 588) | 0] + NICK_JUNG_[((n % 588) / 28) | 0] + NICK_JONG_[n % 28]);
    } else groups.push(nickFold_(e.charAt(i)));
  }
  const body = groups.map(function (g) {
    return g.split('').map(function (l) { return (NICK_LOOSE_[l] || l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) + '+'; }).join('');
  }).join(NICK_SYL_END_ + '?' + NICK_SYL_START_ + '?');
  p = { jamoOnly: /^[ㄱ-ㅎ]+$/.test(e), strong: null, whole: null };
  if (e) {
    const head = /^[ㄱ-ㅎ][가-힣]/.test(e) ? '^(?:[^\\u0002]|\\u0002[^\\u0003]*\\u0003)*' : '';   // 'ㅅ발' 처럼 첫 글자만 자음으로 쓴 낱말: 완성형 글자 사이(글자의 경계)에서 시작할 때만 걸러요. 옷발 의 받침 ㅅ 은 글자 안이라 괜찮아요
    p.strong = new RegExp(head + body + (lastIsSyllable ? '(?![\\u3131-\\u314E]+' + NICK_SYL_END_ + ')' : ''));
    p.whole = new RegExp('^' + NICK_SYL_START_ + '?' + body + NICK_SYL_END_ + '?$');
  }
  nickPatternMemo_.set(entry, p);
  return p;
}

/**
 * 이름을 여러 모양으로 바꿔 봐요: 그대로 / 숫자를 글자로(sh1t, hit1er) / 숫자를 빼고(시1발) - 각각 ㅋㅎ 를 지운 것도.
 * 한글이 들어 있으면 낱글자 자모를 뺀 것(시ㅇ발), 한글과 영어가 섞여 있으면 영어를 뺀 것(시a발) / 둘 다 뺀 것(시ㅇa발) / 한글을 뺀 것(fㅇuck) 도 같은 방법으로 봐요.
 * (엉뚱한 글자를 끼워 낱말을 갈라 숨기는 것을 막아요)
 */
function nickVariants_(s) {
  const base = s.toLowerCase();
  const hasKo = /[ㄱ-ㅣ가-힣]/.test(base), hasEn = /[a-z]/.test(base);
  const bases = [base];
  if (hasKo) bases.push(base.replace(/[ㄱ-ㅣ]/g, ''));
  if (hasKo && hasEn) bases.push(base.replace(/[a-z]/g, ''), base.replace(/[ㄱ-ㅣa-z]/g, ''), base.replace(/[ㄱ-ㅣ가-힣]/g, ''));
  const forms = [];
  bases.forEach(function (b) {
    forms.push(
      b,
      b.replace(/[0-9]/g, function (c) { return LEET_[c] || c; }),
      b.replace(/[0-9]/g, function (c) { return c === '1' ? 'l' : (LEET_[c] || c); }),
      b.replace(/[0-9]/g, '')
    );
  });
  const all = forms.concat(forms.map(function (f) { return f.replace(NICK_LAUGH_LIGHT_, ''); }));
  return all.filter(function (f, i) { return all.indexOf(f) === i; });
}

/** 금칙어가 들어 있는 이름인가 (이미 정리된 닉네임을 넣어요) */
function nickBlocked_(s) {
  const variants = nickVariants_(s);
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i];
    const flat = v.replace(/ /g, '');                                                  // 띄어쓰기는 없는 셈 (f u c k)
    const skeleton = nickSkeleton_(flat);
    const typed = nickSkeleton_(flat.replace(/[가-힣]/g, NICK_BARRIER_));      // 완성형 글자를 막아 둔 것: 자음 줄임말 찾기용
    for (let j = 0; j < BLOCKLIST_.length; j++) {
      const p = nickPattern_(BLOCKLIST_[j]);
      if (p.strong && p.strong.test(p.jamoOnly ? typed : skeleton)) return true;
    }
    const core = nickSkeleton_(v.replace(NICK_LAUGH_, ''));
    for (let j = 0; j < BLOCKLIST_WHOLE_.length; j++) {
      const p = nickPattern_(BLOCKLIST_WHOLE_[j]);
      if (p.whole && p.whole.test(core)) return true;
    }
  }
  return false;
}
// ==== NICK-FILTER END ====

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
 * 지워진 머리글을 다시 써 주고, 빈 줄이 모자라면 늘리면서 칸 서식도 다시 맞춰 줘요.
 * (이 함수는 웹에서도 불러 볼 수 있어서, 할 일이 없을 때는 잠금(lock)을 잡지 않아요 - 아무나 눌러도 저장을 막지 못하게)
 */
function setup() {
  let sheet = findSheet_();
  if (!sheet || sheetNeedsRepair_(sheet)) {
    sheet = withLock_(function () { const s = ensureSheet_(); repairSheet_(s); return s; });
  }
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
 * 순서: 검사(잠금 밖) -> 요청이 폭주하는지 살펴보기(잠금 밖) -> 잠금 안에서는 시트에 한 줄 쓰는 일만 -> 잠금을 풀고 등수 계산
 */
function saveScore(payload) {
  const rec = validateScore_(payload);             // 검사는 잠금(lock) 밖에서 - 잘못된 요청이 줄을 서지 않게
  burstGuard_();                                   // 1분에 너무 많이 몰리면 여기서 돌려보내요 (잠금을 잡지도 않아요)

  const saved = withLock_(function () {            // 잠금 안에서는 시트에 쓰는 일만: 시트 전체를 읽는 등수 계산은 밖에서 해요 (잠금을 오래 쥐고 있으면 뒷사람이 줄줄이 기다려요)
    const dupKey = 'jd:dup:' + nickKey_(rec.nickname) + ':' + rec.score;
    if (cacheGet_(dupKey)) return { ok: true, duplicate: true };   // 방금 같은 기록이 저장됐어요: 한 번 더 쓰지 않아요 (결과는 성공으로 알려 줘요)
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
    return { ok: true };
  });
  saved.rank = safeRank_(rec.nickname, true);      // 잠금이 풀린 뒤: 30초 캐시를 쓰고, 비어 있으면 한 번 만들어서 다음 랭킹 조회에도 써요
  return saved;
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
  if (typeof stageId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(stageId) || stageId.length > LIMITS_.stageIdMax || STAGE_IDS_.indexOf(stageId) < 0) throw new Error('스테이지 정보가 올바르지 않아요.');

  let timeSec = p.timeSec;
  if (timeSec === undefined || timeSec === null) timeSec = 0;
  if (typeof timeSec !== 'number' || !isFinite(timeSec) || timeSec < 0 || timeSec > LIMITS_.timeSecMax) throw new Error('플레이 시간이 올바르지 않아요.');
  timeSec = Math.round(timeSec);

  let cleared = p.cleared;
  if (cleared === undefined || cleared === null) cleared = false;
  if (typeof cleared !== 'boolean') throw new Error('클리어 정보가 올바르지 않아요.');
  // 참고: cleared 는 검사만 하고 시트에는 적지 않아요 (시트 열은 계약서의 7개 그대로).

  // 말이 되는 기록인지 (진짜 게임에서는 늘 지켜지는 규칙이라 정직한 기록은 걸리지 않아요. 콘솔에서 마음먹고 속이는 것까지는 못 막아요)
  if (stars > 0 && !cleared) throw new Error('별 개수가 올바르지 않아요. (클리어해야 별을 받아요)');
  if (cleared && timeSec < LIMITS_.clearTimeMin) throw new Error('플레이 시간이 올바르지 않아요. (클리어는 ' + LIMITS_.clearTimeMin + '초 이상)');

  return { nickname: nickname, score: score, stars: stars, difficulty: difficulty, stageId: stageId, timeSec: timeSec, cleared: cleared };
}

/**
 * 닉네임 검사 + 정리. 통과하면 정리된 닉네임을, 아니면 한글 메시지로 Error 를 던져요.
 * (js_server.html 의 Server.validateNickname 과 같은 규칙이에요 - 테스트가 둘을 비교해요)
 * 순서: 정리(안 보이는 글자 삭제, NFC, 공백, 앞의 = + - @ 제거: 스프레드시트 수식 주입 방지) -> 글자 종류 -> 길이 -> 금칙어
 */
function checkNickname_(raw) {
  if (typeof raw !== 'string') throw new Error('이름을 적어 주세요!');
  const s = nickClean_(raw);
  if (!s) throw new Error('이름을 적어 주세요!');
  if (!NICK_ALLOWED_.test(s)) throw new Error('이름에는 한글, 영어, 숫자만 쓸 수 있어요.');
  if (s.length < LIMITS_.nickMin) throw new Error('이름은 ' + LIMITS_.nickMin + '글자 이상으로 적어 주세요.');
  if (s.length > LIMITS_.nickMax) throw new Error('이름은 ' + LIMITS_.nickMax + '글자까지만 쓸 수 있어요.');
  if (nickBlocked_(s)) throw new Error('이 이름은 쓸 수 없어요. 다른 이름을 적어 줄래요?');
  return s;
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
  if (last < 1) return [];
  const values = sheet.getRange(1, 1, last, HEADER_.length).getValues();   // 1행부터: 머리글 줄은 점수 칸이 글자라 parseRow_ 가 건너뛰어요 (머리글이 지워진 시트에서도 첫 기록이 사라지지 않게)

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
  writeHeader_(sheet);
  formatSheet_(sheet);
}

function writeHeader_(sheet) {
  sheet.getRange(1, 1, 1, HEADER_.length).setValues([HEADER_]).setFontWeight('bold');
  sheet.setFrozenRows(1);
}

/**
 * 빈 줄을 SHEET_ROWS_ 만큼 미리 만들어 두고, 열 전체의 서식을 맞춰요. (줄이 새로 생길 때 서식이 이어지는지는 시트가 알아서 하는 일이라, 미리 서식을 입힌 빈 줄에 쓰게 해 둬요)
 * A:A 시간 모양 / B:B 닉네임, F:F 스테이지는 '글자'(@)
 */
function formatSheet_(sheet) {
  const free = sheet.getMaxRows() - sheet.getLastRow();
  if (free < SHEET_ROWS_) sheet.insertRowsAfter(sheet.getMaxRows(), SHEET_ROWS_ - free);
  sheet.getRange('A:A').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sheet.getRange('B:B').setNumberFormat('@');
  sheet.getRange('F:F').setNumberFormat('@');
}

/** 1행이 머리글이 아니라 기록처럼 보이는가 (점수 칸이 숫자). 머리글을 지워 버린 시트를 알아보는 데 써요. */
function firstRowIsRecord_(sheet) {
  if (sheet.getLastRow() < 1) return false;
  const row = sheet.getRange(1, 1, 1, HEADER_.length).getValues()[0];
  return row[COL_.SCORE] !== '' && isFinite(Number(row[COL_.SCORE])) && DIFFICULTIES_.indexOf(String(row[COL_.DIFF])) >= 0;
}

/** setup 이 손봐야 하는 시트인가: 아직 비어 있거나, 머리글이 지워졌거나, 미리 서식을 입힌 빈 줄이 거의 다 찼어요. (읽기만 해요) */
function sheetNeedsRepair_(sheet) {
  return sheet.getLastRow() === 0 || firstRowIsRecord_(sheet) || sheet.getMaxRows() - sheet.getLastRow() < SHEET_ROWS_MARGIN_;
}

/** 지워진 머리글을 위에 새로 끼워 넣고(기록은 그대로), 빈 줄과 서식을 다시 맞춰요. (잠금 안에서 불러요) */
function repairSheet_(sheet) {
  if (firstRowIsRecord_(sheet)) { sheet.insertRowBefore(1); writeHeader_(sheet); }
  formatSheet_(sheet);
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

/**
 * 저장 요청이 한꺼번에 몰리면 잠금을 잡기 전에 돌려보내요. 1분 단위로 센 숫자를 캐시에 적어 두고 BURST_MAX_PER_MIN_ 를 넘으면 [busy].
 * (콘솔에서 저장을 반복 호출하는 장난이 잠금을 계속 쥐고 있어서 진짜 친구들의 저장이 밀리는 것을 막는 가벼운 안전장치예요.
 *  캐시는 정확한 계산기가 아니라서 숫자는 대충이에요. 캐시가 고장 나면 그냥 통과시켜요.)
 */
function burstGuard_() {
  const key = 'jd:burst:' + Math.floor(now_().getTime() / 60000);
  const n = Number(cacheGet_(key)) || 0;
  if (n >= BURST_MAX_PER_MIN_) throw new Error(BUSY_TAG_ + ' 지금 저장하는 친구가 많아요. 잠시 뒤에 다시 해 봐요!');
  cachePut_(key, String(n + 1), BURST_KEY_SECONDS_);
}

// 캐시는 "있으면 좋은 것"이라서, 캐시가 고장 나도 저장/조회가 멈추면 안 돼요.
function cacheGet_(key) { try { return CacheService.getScriptCache().get(key); } catch (err) { return null; } }
function cachePut_(key, value, seconds) { try { CacheService.getScriptCache().put(key, value, seconds); } catch (err) { /* 무시 */ } }
function cacheInvalidateRanking_() {
  try {
    CacheService.getScriptCache().removeAll([rankCacheKey_(null)].concat(DIFFICULTIES_.map(rankCacheKey_)));
  } catch (err) { /* 무시 */ }
}
