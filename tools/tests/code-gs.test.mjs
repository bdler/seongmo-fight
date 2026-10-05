// server 모듈 테스트 (1/2): src/Code.gs  - 브라우저 없이 node:vm 샌드박스 + 손으로 만든 가짜 Apps Script 서비스로 검사해요.
//   실행: node tools/tests/code-gs.test.mjs
//
// 가짜(mock): SpreadsheetApp(메모리 시트), LockService, PropertiesService, CacheService(가짜 시계로 만료 흉내),
//            HtmlService, Logger.  Code.gs 는 진짜 파일 그대로 읽어서 실행해요.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { check, finish } from '../lib/check.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CODE_PATH = resolve(root, 'src', 'Code.gs');
const CODE = readFileSync(CODE_PATH, 'utf8');
const CLIENT_HTML = readFileSync(resolve(root, 'src', 'js_server.html'), 'utf8');

// ---------------------------------------------------------------------------
// 가짜 Apps Script 서비스
// ---------------------------------------------------------------------------
const START = Date.UTC(2026, 9, 5, 0, 0, 0);          // 가짜 시계의 시작 (밀리초)

function makeEnv(opts = {}) {
  const st = {
    now: START,                                         // 가짜 시계 (밀리초). advance(sec) 로 흘려요
    spreadsheets: {}, created: 0, props: { ...(opts.props || {}) }, bound: null,
    cache: new Map(), cachePuts: [], cacheBroken: false, cacheRemoves: [],
    lockBusy: false, lockHeld: false, lockAcquired: 0, lockReleased: 0, appendsWhileLocked: 0, appendsUnlocked: 0,
    reads: 0, appends: 0, failAppend: false,
    html: null, files: { index: '<html>INDEX</html>', js_core: '/* core */', style: '<style></style>' },
    logs: [],
  };
  const advance = sec => { st.now += sec * 1000; };

  class MockRange {
    constructor(sheet, row, col, nr, nc) { Object.assign(this, { sheet, row, col, nr, nc }); }
    getValues() {
      st.reads++;
      const out = [];
      for (let r = 0; r < this.nr; r++) {
        const src = this.sheet.rows[this.row - 1 + r] || [];
        const line = [];
        for (let c = 0; c < this.nc; c++) { const v = src[this.col - 1 + c]; line.push(v === undefined ? '' : v); }
        out.push(line);
      }
      return out;
    }
    setValues(vals) {
      vals.forEach((line, r) => line.forEach((v, c) => {
        const rows = this.sheet.rows;
        (rows[this.row - 1 + r] = rows[this.row - 1 + r] || [])[this.col - 1 + c] = v;
      }));
      return this;
    }
    setFontWeight() { return this; }
    setNumberFormat(f) { this.sheet.formats.push({ col: this.col, format: f }); return this; }
  }
  class MockSheet {
    constructor(ss, name) { this.ss = ss; this.name = name; this.rows = []; this.formats = []; this.frozen = 0; }
    getName() { return this.name; }
    setName(n) { this.name = n; return this; }
    getParent() { return this.ss; }
    getMaxRows() { return 1000; }
    getLastRow() { let last = 0; this.rows.forEach((r, i) => { if (r && r.some(v => v !== '' && v !== null && v !== undefined)) last = i + 1; }); return last; }
    getRange(row, col, nr = 1, nc = 1) { return new MockRange(this, row, col, nr, nc); }
    appendRow(arr) {
      if (st.failAppend) throw new Error('append 실패(가짜)');
      st.appends++;
      if (st.lockHeld) st.appendsWhileLocked++; else st.appendsUnlocked++;
      this.rows[this.getLastRow()] = arr.slice();
    }
    setFrozenRows(n) { this.frozen = n; }
    data() { return this.rows.slice(0, this.getLastRow()).map(r => Array.from({ length: Math.max(r.length, 7) }, (_, i) => (r[i] === undefined ? '' : r[i]))); }
  }
  class MockSpreadsheet {
    constructor(id, name) { this.id = id; this.name = name; this.sheets = []; }
    getId() { return this.id; }
    getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id; }
    getSheets() { return this.sheets; }
    getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; }
    insertSheet(n) { const s = new MockSheet(this, n); this.sheets.push(s); return s; }
  }
  const addSpreadsheet = (id, name, sheetNames = ['Sheet1']) => {
    const ss = new MockSpreadsheet(id, name);
    sheetNames.forEach(n => ss.insertSheet(n));
    st.spreadsheets[id] = ss;
    return ss;
  };

  const SpreadsheetApp = {
    openById(id) { if (!st.spreadsheets[id]) throw new Error('Exception: 문서를 열 수 없습니다 (가짜): ' + id); return st.spreadsheets[id]; },
    getActiveSpreadsheet() { return st.bound; },
    create(name) { st.created++; return addSpreadsheet('NEWID' + st.created, name); },
  };
  const PropertiesService = {
    getScriptProperties() {
      return { getProperty: k => (k in st.props ? st.props[k] : null), setProperty: (k, v) => { st.props[k] = String(v); } };
    },
  };
  const CacheService = {
    getScriptCache() {
      const live = k => { const e = st.cache.get(k); if (!e) return null; if (e.exp <= st.now) { st.cache.delete(k); return null; } return e; };
      const boom = () => { if (st.cacheBroken) throw new Error('캐시 고장(가짜)'); };
      return {
        get(k) { boom(); const e = live(k); return e ? e.v : null; },
        put(k, v, sec) { boom(); st.cachePuts.push({ key: k, seconds: sec }); st.cache.set(k, { v: String(v), exp: st.now + (sec === undefined ? 600 : sec) * 1000 }); },
        remove(k) { boom(); st.cache.delete(k); },
        removeAll(keys) { boom(); st.cacheRemoves.push(keys.slice()); keys.forEach(k => st.cache.delete(k)); },
      };
    },
  };
  const LockService = {
    getScriptLock() {
      return {
        waitLock() { if (st.lockBusy || st.lockHeld) throw new Error('Exception: 잠금을 얻지 못했습니다 (가짜)'); st.lockHeld = true; st.lockAcquired++; },
        releaseLock() { st.lockHeld = false; st.lockReleased++; },
      };
    },
  };
  const HtmlService = {
    XFrameOptionsMode: { ALLOWALL: 'ALLOWALL', DEFAULT: 'DEFAULT' },
    createTemplateFromFile(name) {
      const out = { file: name, title: null, meta: [], xframe: null };
      st.html = out;
      const o = {
        setTitle(t) { out.title = t; return o; },
        addMetaTag(n, c) { out.meta.push([n, c]); return o; },
        setXFrameOptionsMode(m) { out.xframe = m; return o; },
      };
      return { evaluate() { return o; } };
    },
    createHtmlOutputFromFile(name) {
      if (!(name in st.files)) throw new Error('파일 없음(가짜): ' + name);
      return { getContent: () => st.files[name] };
    },
  };
  const Logger = { log: (...a) => st.logs.push(a.join(' ')) };

  const sandbox = { SpreadsheetApp, PropertiesService, CacheService, LockService, HtmlService, Logger, console };
  vm.createContext(sandbox);
  vm.runInContext(CODE, sandbox, { filename: 'Code.gs' });
  sandbox.now_ = () => new Date(st.now);                 // 시간을 가짜 시계로 (Code.gs 는 now_() 로만 시각을 얻어요)

  const env = {
    ctx: sandbox, st, advance, addSpreadsheet,
    /** Scores 시트 (없으면 null) */
    sheet() {
      const id = st.props.SHEET_ID;
      const ss = (id && st.spreadsheets[id]) || st.bound;
      return ss ? ss.getSheetByName('Scores') : null;
    },
    rows() { const s = env.sheet(); return s ? s.data().slice(1) : []; },     // 머리글 뺀 줄들
    const: name => vm.runInContext(name, sandbox),
  };
  return env;
}

const GOOD = { nickname: '민준이', score: 1000, stageId: 'stage1', difficulty: 'normal', stars: 2, cleared: true, timeSec: 300 };
const save = (env, over = {}) => env.ctx.saveScore({ ...GOOD, ...over });
const msgOf = fn => { try { fn(); return null; } catch (e) { return String(e && e.message); } };
const jsonClone = v => JSON.parse(JSON.stringify(v));

/** 값이 "숫자/문자열/불리언/null/객체/배열" 뿐인지 (Date, 함수, undefined, NaN 이 없는지) 확인 → 문제 설명 또는 '' */
function plainProblem(v, path = 'root') {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return '';
  if (typeof v === 'number') return Number.isFinite(v) ? '' : `${path} 는 유한하지 않은 숫자`;
  if (typeof v === 'undefined' || typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') return `${path} 는 ${typeof v}`;
  const tag = Object.prototype.toString.call(v);
  if (tag === '[object Array]') { for (let i = 0; i < v.length; i++) { const p = plainProblem(v[i], `${path}[${i}]`); if (p) return p; } return ''; }
  if (tag === '[object Object]') { for (const k of Object.keys(v)) { const p = plainProblem(v[k], `${path}.${k}`); if (p) return p; } return ''; }
  return `${path} 는 ${tag}`;
}

// ===========================================================================
// 1. 파일/문법/계약
// ===========================================================================
{
  let compiled = true;
  try { new vm.Script(CODE, { filename: 'Code.gs' }); } catch (e) { compiled = false; console.log(String(e)); }
  check('[문법] Code.gs 가 컴파일돼요 (vm.Script)', compiled);

  const dir = mkdtempSync(join(tmpdir(), 'jd-codegs-'));
  const copy = join(dir, 'Code.check.js');
  writeFileSync(copy, CODE);
  const r = spawnSync(process.execPath, ['--check', copy], { encoding: 'utf8' });
  check('[문법] Code.gs 복사본에 node --check 통과', r.status === 0, (r.stderr || '').split('\n')[0]);

  const manifest = JSON.parse(readFileSync(resolve(root, 'src', 'appsscript.json'), 'utf8'));
  check('[appsscript.json] 시간대 Asia/Seoul, 런타임 V8', manifest.timeZone === 'Asia/Seoul' && manifest.runtimeVersion === 'V8');
  check('[appsscript.json] 웹 앱: USER_DEPLOYING + ANYONE_ANONYMOUS', manifest.webapp && manifest.webapp.executeAs === 'USER_DEPLOYING' && manifest.webapp.access === 'ANYONE_ANONYMOUS');
  check('[appsscript.json] 넓은 oauthScopes 를 강제로 적어 두지 않음(자동 감지에 맡김)', manifest.oauthScopes === undefined);

  const fnNames = [...CODE.matchAll(/^function\s+([A-Za-z0-9_]+)/gm)].map(m => m[1]);
  const publicNames = fnNames.filter(n => !n.endsWith('_')).sort();
  check('[공개 함수] 밖에서 부를 수 있는 함수는 doGet/getTopScores/include/saveScore/setup 뿐', JSON.stringify(publicNames) === JSON.stringify(['doGet', 'getTopScores', 'include', 'saveScore', 'setup']), publicNames.join(','));
  check('[공개 함수] 도우미 함수는 전부 밑줄(_)로 끝남', fnNames.filter(n => n.endsWith('_')).length >= 10);

  check('[개인정보] 신원/접속 정보 API 를 쓰지 않음 (Session, getActiveUser, getEffectiveUser, 임시 사용자 키)', !/Session\s*\./.test(CODE) && !/getActiveUser|getEffectiveUser|getTemporaryActiveUserKey/.test(CODE));
  check('[개인정보] 이메일/IP 를 다루는 코드가 없음', !/e-?mail|remoteAddr|userAgent|getIp/i.test(CODE));
  check('[규칙] Math.random / eval / UrlFetchApp / DriveApp 같은 불필요한 서비스를 쓰지 않음', !/Math\.random|\beval\s*\(|UrlFetchApp|DriveApp|MailApp|GmailApp/.test(CODE));

  const env = makeEnv();
  check('[설정] 시트 머리글은 시간|닉네임|점수|별|난이도|스테이지|시간(초)', JSON.stringify(jsonClone(env.const('HEADER_'))) === JSON.stringify(['시간', '닉네임', '점수', '별', '난이도', '스테이지', '시간(초)']));
  check('[설정] 난이도 화이트리스트 easy/normal/hard', JSON.stringify(jsonClone(env.const('DIFFICULTIES_'))) === JSON.stringify(['easy', 'normal', 'hard']));
}

// ===========================================================================
// 2. doGet / include
// ===========================================================================
{
  const env = makeEnv();
  const out = env.ctx.doGet({});
  check('[doGet] index 템플릿을 평가해서 돌려줌', env.st.html && env.st.html.file === 'index' && !!out);
  check('[doGet] 제목은 젤리 던전', env.st.html.title === '젤리 던전', String(env.st.html.title));
  check('[doGet] viewport 메타 태그를 추가', env.st.html.meta.some(([n, c]) => n === 'viewport' && /width=device-width/.test(c) && /initial-scale=1/.test(c)));
  check('[doGet] iframe 안에서도 열리도록 XFrameOptionsMode.ALLOWALL', env.st.html.xframe === 'ALLOWALL');

  check('[include] 파일 내용을 그대로 돌려줌', env.ctx.include('js_core') === '/* core */' && env.ctx.include('style') === '<style></style>');
  for (const bad of ['../Code', 'a/b', 'a b', '', '.', 'x'.repeat(41), 5, null, undefined, {}, 'js_core.html\n']) {
    check(`[include] 이상한 이름은 거절: ${JSON.stringify(bad)}`, /파일 이름/.test(msgOf(() => env.ctx.include(bad)) || ''));
  }
  check('[include] 없는 파일은 오류 (조용히 빈 값을 주지 않음)', msgOf(() => env.ctx.include('nope')) !== null);
}

// ===========================================================================
// 3. 스프레드시트 자동 준비
// ===========================================================================
{
  // (a) 아무것도 없을 때: 새로 만들고, SHEET_ID 기억, 기본 시트 이름 변경, 머리글
  let env = makeEnv();
  check('[시트] 읽기만 해서는 아무것도 만들지 않음 (빈 랭킹)', JSON.stringify(jsonClone(env.ctx.getTopScores(10))) === '[]' && env.st.created === 0 && !('SHEET_ID' in env.st.props));
  const res = save(env);
  check('[시트] 처음 저장하면 스프레드시트를 1개 새로 만듦', env.st.created === 1);
  check('[시트] 만든 시트 ID 를 스크립트 속성 SHEET_ID 에 기억', env.st.props.SHEET_ID === 'NEWID1');
  const ss = env.st.spreadsheets.NEWID1;
  check('[시트] 새 파일의 빈 기본 시트를 Scores 로 이름만 바꿔 씀 (시트가 1개뿐)', ss.sheets.length === 1 && ss.sheets[0].name === 'Scores', ss.sheets.map(s => s.name).join(','));
  const data = env.sheet().data();
  check('[시트] 첫 줄은 머리글', JSON.stringify(data[0]) === JSON.stringify(['시간', '닉네임', '점수', '별', '난이도', '스테이지', '시간(초)']), JSON.stringify(data[0]));
  check('[시트] 머리글 줄 고정(frozen) + 닉네임/스테이지 열은 글자 형식(@)', env.sheet().frozen === 1 && env.sheet().formats.some(f => f.col === 2 && f.format === '@') && env.sheet().formats.some(f => f.col === 6 && f.format === '@'));
  check('[시트] 데이터 줄이 정확히 1줄', data.length === 2);
  check('[저장] 결과 { ok:true, rank:1 }', jsonClone(res).ok === true && res.rank === 1, JSON.stringify(res));
  save(env, { nickname: '다른친구', score: 5 });
  check('[시트] 두 번째 저장은 새 스프레드시트를 또 만들지 않음', env.st.created === 1 && env.rows().length === 2);

  // (b) 스크립트 속성 SHEET_ID 가 이미 있고 그 파일에 Scores 가 없으면 시트만 추가
  env = makeEnv({ props: { SHEET_ID: 'MINE' } });
  const mine = env.addSpreadsheet('MINE', '내 파일', ['메모']);
  save(env);
  check('[시트] SHEET_ID 가 있으면 그 파일을 씀 (새로 만들지 않음)', env.st.created === 0);
  check('[시트] 그 파일에 Scores 시트만 추가하고 기존 시트는 그대로', mine.sheets.map(s => s.name).join(',') === '메모,Scores' && mine.sheets[1].data().length === 2);

  // (c) 컨테이너 바인딩 스프레드시트
  env = makeEnv();
  env.st.bound = env.addSpreadsheet('BOUND', '묶인 시트', ['Sheet1']);
  save(env);
  check('[시트] SHEET_ID 가 없으면 컨테이너 바인딩 시트를 씀', env.st.created === 0 && env.st.bound.getSheetByName('Scores').data().length === 2);
  check('[시트] 바인딩 시트를 쓸 때는 SHEET_ID 를 건드리지 않음', !('SHEET_ID' in env.st.props));
  check('[시트] 바인딩 시트의 기존 Sheet1 은 건드리지 않음', env.st.bound.getSheetByName('Sheet1') !== null);

  // (d) SHEET_ID 가 있는데 열 수 없을 때: 조용히 새로 만들면 안 됨 (기록을 잃어버림)
  env = makeEnv({ props: { SHEET_ID: 'GONE' } });
  const m1 = msgOf(() => save(env)), m2 = msgOf(() => env.ctx.getTopScores(10));
  check('[시트] 열 수 없는 SHEET_ID: 저장은 한글 오류', /랭킹 시트를 열 수 없어요/.test(m1 || ''), String(m1));
  check('[시트] 열 수 없는 SHEET_ID: 조회도 한글 오류', /랭킹 시트를 열 수 없어요/.test(m2 || ''), String(m2));
  check('[시트] 열 수 없는 SHEET_ID: 새 파일을 만들지도, SHEET_ID 를 덮어쓰지도 않음', env.st.created === 0 && env.st.props.SHEET_ID === 'GONE');
  check('[시트] 열 수 없는 SHEET_ID: 그래도 잠금은 풀려 있음', !env.st.lockHeld);

  // (e) 이미 머리글과 기록이 있는 Scores 시트: 머리글을 다시 쓰지 않고 뒤에 붙임
  env = makeEnv({ props: { SHEET_ID: 'X' } });
  const x = env.addSpreadsheet('X', 'x', ['Scores']);
  x.sheets[0].rows = [['HEAD1', 'HEAD2'], [new Date(START - 1000), '옛날친구', 777, 3, 'hard', 'stage1', 100]];
  save(env);
  const xd = x.sheets[0].data();
  check('[시트] 있는 머리글은 그대로, 새 줄은 맨 아래에 추가', xd[0][0] === 'HEAD1' && xd.length === 3 && xd[2][1] === '민준이' && xd[1][1] === '옛날친구');

  // (f) 이름만 있고 비어 있는 Scores 시트: 머리글을 써 줌
  env = makeEnv({ props: { SHEET_ID: 'Y' } });
  const y = env.addSpreadsheet('Y', 'y', ['Scores']);
  save(env);
  check('[시트] 비어 있는 Scores 시트에는 머리글을 써 줌', y.sheets[0].data()[0][1] === '닉네임' && y.sheets[0].data().length === 2);

  // (g) setup(): 권한 허용용 함수 - 시트를 준비하고 로그만 남김
  env = makeEnv();
  const ret = env.ctx.setup();
  check('[setup] 시트를 만들어 두고 아무 값도 돌려주지 않음(주소를 밖으로 새지 않게)', ret === undefined && env.st.created === 1 && env.sheet().data().length === 1 && !env.st.lockHeld);
  check('[setup] 시트 주소는 실행 로그(Logger)에만 남김', env.st.logs.some(l => l.includes('docs.google.com/spreadsheets/d/NEWID1')));
  env.ctx.setup();
  check('[setup] 여러 번 실행해도 안전 (시트를 또 만들지 않음)', env.st.created === 1);
}

// ===========================================================================
// 4. 저장: 정상 / 한 줄 내용
// ===========================================================================
{
  const env = makeEnv();
  const res = save(env, { nickname: '  젤리   왕  ', score: 12345, stars: 3, difficulty: 'hard', stageId: 'stage2', timeSec: 421.6, cleared: false });
  const row = env.rows()[0];
  check('[저장] 정상 저장은 정확히 1줄 추가', env.rows().length === 1 && env.st.appends === 1);
  check('[저장] 시간 칸에는 시각이 들어감 (가짜 시계 값)', row[0] && typeof row[0].getTime === 'function' && row[0].getTime() === START, String(row[0]));
  check('[저장] 닉네임은 공백을 정리한 값', row[1] === '젤리 왕', JSON.stringify(row[1]));
  check('[저장] 점수/별/난이도/스테이지가 그대로', row[2] === 12345 && row[3] === 3 && row[4] === 'hard' && row[5] === 'stage2');
  check('[저장] 시간(초)는 정수로 반올림', row[6] === 422, String(row[6]));
  check('[저장] 한 줄은 정확히 7칸 (머리글과 같음)', env.sheet().rows[1].length === 7);
  check('[저장] 응답은 { ok:true, rank } 뿐이고 Date 가 없음', plainProblem(res) === '' && Object.keys(res).sort().join() === 'ok,rank' && res.ok === true && res.rank === 1, JSON.stringify(res));
  check('[저장] 저장 후 쓴 잠금을 반드시 풀었음', env.st.lockAcquired === 1 && env.st.lockReleased === 1 && !env.st.lockHeld);
  check('[저장] 시트에 쓰는 동안 잠금을 잡고 있었음', env.st.appendsWhileLocked === 1 && env.st.appendsUnlocked === 0);

  // 경계값
  const e2 = makeEnv();
  check('[저장] 점수 0 과 999999 는 통과', msgOf(() => save(e2, { nickname: '경계일', score: 0 })) === null && msgOf(() => save(e2, { nickname: '경계이', score: 999999 })) === null);
  check('[저장] 별 0..3 통과, 별/클리어/시간/스테이지 생략하면 기본값', msgOf(() => save(e2, { nickname: '기본값', stars: undefined, cleared: undefined, timeSec: undefined, stageId: undefined })) === null);
  const dflt = e2.rows().find(r => r[1] === '기본값');
  check('[저장] 생략한 값의 기본: 별 0, 스테이지 stage1, 시간 0', dflt[3] === 0 && dflt[5] === 'stage1' && dflt[6] === 0);
  check('[저장] timeSec 0 과 86400 은 통과, stageId 20자는 통과', msgOf(() => save(e2, { nickname: '시간영', timeSec: 0 })) === null && msgOf(() => save(e2, { nickname: '시간끝', timeSec: 86400, stageId: 'a'.repeat(20) })) === null);

  // 추가로 보낸 필드(이메일/IP 등)는 저장되지 않음
  const e3 = makeEnv();
  save(e3, { email: 'kid@example.com', ip: '10.1.2.3', userAgent: 'x', extra: { a: 1 } });
  const flat = JSON.stringify(e3.sheet().data().map(r => r.map(v => (v && v.getTime ? v.getTime() : v))));
  check('[개인정보] 보낸 이메일/IP 같은 추가 필드는 시트에 들어가지 않음', !/kid@example|10\.1\.2\.3|userAgent/.test(flat) && e3.sheet().rows[1].length === 7);
}

// ===========================================================================
// 5. 검증: 잘 못 보낸 값은 한글 메시지로 거절하고 아무것도 쓰지 않음
// ===========================================================================
{
  const NICK_EMPTY = /이름을 적어 주세요/, NICK_CHARS = /한글, 영어, 숫자만/, NICK_SHORT = /2글자 이상/, NICK_LONG = /8글자까지만/, NICK_BAD = /쓸 수 없어요/;
  const bad = [
    // 닉네임
    ['닉네임 빈 글자', { nickname: '' }, NICK_EMPTY], ['닉네임 공백만', { nickname: '    ' }, NICK_EMPTY],
    ['닉네임 없음(undefined)', { nickname: undefined }, NICK_EMPTY], ['닉네임 null', { nickname: null }, NICK_EMPTY],
    ['닉네임이 숫자 타입', { nickname: 12345 }, NICK_EMPTY], ['닉네임이 객체', { nickname: { a: 1 } }, NICK_EMPTY], ['닉네임이 배열', { nickname: ['가나다'] }, NICK_EMPTY],
    ['닉네임 1글자(한글)', { nickname: '가' }, NICK_SHORT], ['닉네임 1글자(영어)', { nickname: 'a' }, NICK_SHORT],
    ['닉네임 9글자(한글)', { nickname: '가나다라마바사아자' }, NICK_LONG], ['닉네임 9글자(영어)', { nickname: 'ABCDEFGHI' }, NICK_LONG],
    ['닉네임 공백 포함 11글자', { nickname: 'ab cd ef gh' }, NICK_LONG], ['닉네임 아주 긴 글자', { nickname: 'z'.repeat(500) }, NICK_LONG],
    ['닉네임 특수문자 !', { nickname: 'ab!' }, NICK_CHARS], ['닉네임 < >', { nickname: 'a<b>c' }, NICK_CHARS], ['닉네임 밑줄', { nickname: 'a_b' }, NICK_CHARS],
    ['닉네임 점', { nickname: 'abc.def' }, NICK_CHARS], ['닉네임 이모지', { nickname: '😀😀' }, NICK_CHARS], ['닉네임 따옴표', { nickname: "a'b" }, NICK_CHARS],
    ['닉네임 줄바꿈 속 따옴표', { nickname: 'a"b' }, NICK_CHARS], ['닉네임 한자', { nickname: '漢字' }, NICK_CHARS], ['닉네임 전각 등호', { nickname: '＝cmd' }, NICK_CHARS],
    ['닉네임 =cmd() (수식)', { nickname: '=cmd()' }, NICK_CHARS], ['닉네임 =HYPERLINK(...)', { nickname: '=HYPERLINK("http://x")' }, NICK_CHARS],
    ['닉네임 +1', { nickname: '+1' }, NICK_SHORT], ['닉네임 @x', { nickname: '@x' }, NICK_SHORT], ['닉네임 -a', { nickname: '-a' }, NICK_SHORT],
    ['닉네임 ===', { nickname: '===' }, NICK_EMPTY], ['닉네임 @@ +', { nickname: '@@ +' }, NICK_EMPTY],
    ['금칙어 시발', { nickname: '시발' }, NICK_BAD], ['금칙어 씨발놈', { nickname: '씨발놈' }, NICK_BAD], ['금칙어 자모 ㅅㅂ', { nickname: 'ㅅㅂ' }, NICK_BAD],
    ['금칙어 FUCK (대문자)', { nickname: 'FUCK' }, NICK_BAD], ['금칙어 띄어쓰기 f u c k', { nickname: 'f u c k' }, NICK_BAD],
    ['금칙어 sh1t (숫자로 바꿔 쓰기)', { nickname: 'sh1t' }, NICK_BAD], ['금칙어 S H I T', { nickname: 'S H I T' }, NICK_BAD],
    ['금칙어 시1발 (숫자 끼우기)', { nickname: '시1발' }, NICK_BAD], ['금칙어가 들어간 긴 이름', { nickname: '착한fuck12' }, NICK_BAD],
    ['금칙어 병신', { nickname: '병신' }, NICK_BAD], ['금칙어 앞의 = 를 지워도 걸림', { nickname: '=시발' }, NICK_BAD],
    // 점수
    ['점수 -1', { score: -1 }, /점수가 올바르지/], ['점수 1000000', { score: 1000000 }, /점수가 올바르지/], ['점수 1e9', { score: 1e9 }, /점수가 올바르지/],
    ['점수 NaN', { score: NaN }, /점수가 올바르지/], ['점수 Infinity', { score: Infinity }, /점수가 올바르지/], ['점수 -Infinity', { score: -Infinity }, /점수가 올바르지/],
    ["점수 '12abc'", { score: '12abc' }, /점수가 올바르지/], ["점수 '123' (글자는 안 받음)", { score: '123' }, /점수가 올바르지/], ['점수 12.5 (소수)', { score: 12.5 }, /점수가 올바르지/],
    ['점수 없음', { score: undefined }, /점수가 올바르지/], ['점수 null', { score: null }, /점수가 올바르지/], ['점수 true', { score: true }, /점수가 올바르지/],
    ['점수 배열', { score: [5] }, /점수가 올바르지/], ['점수 -0.0001', { score: -0.0001 }, /점수가 올바르지/],
    // 별
    ['별 5', { stars: 5 }, /별 개수/], ['별 4', { stars: 4 }, /별 개수/], ['별 -1', { stars: -1 }, /별 개수/], ['별 1.5', { stars: 1.5 }, /별 개수/],
    ["별 '3'", { stars: '3' }, /별 개수/], ['별 NaN', { stars: NaN }, /별 개수/],
    // 난이도
    ['난이도 모르는 값', { difficulty: 'impossible' }, /난이도/], ['난이도 빈 글자', { difficulty: '' }, /난이도/], ['난이도 대문자 EASY', { difficulty: 'EASY' }, /난이도/],
    ['난이도 없음', { difficulty: undefined }, /난이도/], ['난이도 숫자', { difficulty: 1 }, /난이도/], ['난이도 배열', { difficulty: ['easy'] }, /난이도/], ['난이도 앞뒤 공백', { difficulty: ' easy' }, /난이도/],
    ['난이도 __proto__', { difficulty: '__proto__' }, /난이도/], ['난이도 toString', { difficulty: 'toString' }, /난이도/],
    // 스테이지
    ['스테이지 빈 글자', { stageId: '' }, /스테이지/], ['스테이지 공백 포함', { stageId: 'a b' }, /스테이지/], ['스테이지 ../x', { stageId: '../x' }, /스테이지/],
    ['스테이지 21자', { stageId: 'x'.repeat(21) }, /스테이지/], ['스테이지 숫자 타입', { stageId: 5 }, /스테이지/], ['스테이지 =SUM(1)', { stageId: '=SUM(1)' }, /스테이지/],
    ['스테이지 한글', { stageId: '사탕숲' }, /스테이지/],
    // 시간
    ['시간 -1', { timeSec: -1 }, /플레이 시간/], ['시간 86401', { timeSec: 86401 }, /플레이 시간/], ['시간 NaN', { timeSec: NaN }, /플레이 시간/],
    ["시간 '30'", { timeSec: '30' }, /플레이 시간/], ['시간 Infinity', { timeSec: Infinity }, /플레이 시간/],
    // 클리어
    ["클리어 'true'", { cleared: 'true' }, /클리어 정보/], ['클리어 1', { cleared: 1 }, /클리어 정보/], ['클리어 0', { cleared: 0 }, /클리어 정보/], ['클리어 객체', { cleared: {} }, /클리어 정보/],
  ];
  const env = makeEnv();
  for (const [name, over, re] of bad) {
    const before = env.st.appends;
    const m = msgOf(() => save(env, over));
    check(`[검증] ${name} → 거절`, m !== null && re.test(m), String(m));
    if (env.st.appends !== before) check(`[검증] ${name} → 그런데 시트에 써 버림!`, false);
  }
  check('[검증] 거절된 요청은 시트에 한 줄도 쓰지 않았고 시트도 만들지 않았음', env.st.appends === 0 && env.st.created === 0, `appends=${env.st.appends} created=${env.st.created}`);
  check('[검증] 거절된 요청은 잠금도 잡지 않음 (검사는 잠금 밖)', env.st.lockAcquired === 0);

  for (const [name, payload] of [['null', null], ['undefined', undefined], ['글자', 'abc'], ['숫자', 5], ['배열', [GOOD]], ['true', true]]) {
    const m = msgOf(() => env.ctx.saveScore(payload));
    check(`[검증] 기록 자체가 ${name} → 거절`, m !== null && /기록이 올바르지/.test(m), String(m));
  }
  check('[검증] 모든 오류 메시지가 한글을 포함', bad.every(([, over]) => /[가-힣]/.test(msgOf(() => save(env, over)) || '')));
  check('[검증] 오류 메시지에 영어 스택/내부 이름이 섞이지 않음', bad.every(([, over]) => !/undefined|NaN|\[object|TypeError|at /.test(msgOf(() => save(env, over)) || '')));
}

// ===========================================================================
// 6. 수식 주입 방지 / 닉네임 정리
// ===========================================================================
{
  const env = makeEnv();
  const ok = [
    ['=abc', 'abc'], ['+abc', 'abc'], ['@abc', 'abc'], ['-abc', 'abc'], ['=  가나', '가나'], ['== @ +zz', 'zz'],
    ['  가  나  ', '가 나'], ['민준', '민준'], ['Jelly', 'Jelly'], ['jelly 99', 'jelly 99'], ['ㅋㅋ', 'ㅋㅋ'], ['가나다라마바사아', '가나다라마바사아'],
    ['a\tb', 'a b'], ['a\u3000b', 'a b'], ['a\nb', 'a b'], ['\u00a0\u00a0gh', 'gh'],
    ['\u1112\u1161\u11ab\u1100\u1173\u11af', '한글'],                   // 분해된(NFD) 한글도 완성형으로
    ['1234', '1234'], ['00', '00'],
  ];
  let n = 0;
  for (const [input, want] of ok) {
    const nick = `${input}`;
    const e = makeEnv();
    const m = msgOf(() => save(e, { nickname: nick, score: 100 + n++ }));
    const stored = e.rows()[0] && e.rows()[0][1];
    check(`[정리] ${JSON.stringify(input)} → ${JSON.stringify(want)} 로 저장`, m === null && stored === want, `err=${m} stored=${JSON.stringify(stored)}`);
  }
  // 어떤 입력이 와도, 시트에 들어간 닉네임은 수식으로 읽힐 수 없고 규칙을 만족해야 함 (무작위 입력 400개)
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const alphabet = ['=', '+', '-', '@', ' ', '\t', 'a', 'Z', '9', '가', '힣', 'ㅋ', '(', ')', '"', "'", '_', '😀', '\u200b', '시', '발', 'x', '1',
    'b', 'c', 'd', 'e', 'k', 'm', 'n', '나', '다', '라', '마', '2', 'Q', 'R', 'ㅎ', 'a', 'b', '가', '나', 'q', 'w', 'r', 't', 'y', '하', '늘'];   // 허용 글자를 더 많이 섞어서 저장/거절이 골고루 나오게
  const fz = makeEnv();
  let stored = 0, rejected = 0, badStored = 0;
  for (let i = 0; i < 400; i++) {
    const len = 1 + Math.floor(rnd() * 12);
    let s = '';
    for (let k = 0; k < len; k++) s += alphabet[Math.floor(rnd() * alphabet.length)];
    const m = msgOf(() => save(fz, { nickname: s, score: i, timeSec: 1 }));
    if (m === null) {
      stored++;
      const last = fz.rows()[fz.rows().length - 1][1];
      if (!/^[0-9A-Za-zㄱ-ㆎ가-힣 ]{2,8}$/.test(last) || /^[=+\-@ ]/.test(last) || / $/.test(last)) badStored++;
    } else rejected++;
  }
  check('[정리] 무작위 입력 400개: 저장된 닉네임은 전부 규칙을 지키고 =+-@ 나 공백으로 시작하지 않음', badStored === 0 && stored > 20 && rejected > 20, `저장 ${stored} / 거절 ${rejected} / 위반 ${badStored}`);
  check('[정리] 시트의 어느 칸도 = + - @ 로 시작하지 않음', fz.rows().every(r => r.every(v => typeof v !== 'string' || !/^[=+\-@\t\r]/.test(v))));
  check('[정리] neutralize_ 안전장치: 수식처럼 시작하면 앞에 \' 를 붙임', fz.ctx.neutralize_('=1+1') === "'=1+1" && fz.ctx.neutralize_('@a') === "'@a" && fz.ctx.neutralize_('+1') === "'+1" && fz.ctx.neutralize_('-3') === "'-3" && fz.ctx.neutralize_('abc') === 'abc' && fz.ctx.neutralize_('가나') === '가나');
}

// ===========================================================================
// 7. 중복 저장 방지 (같은 닉네임 + 점수, 10초)
// ===========================================================================
{
  const env = makeEnv();
  const r1 = save(env);
  const r2 = save(env);
  check('[중복] 같은 닉네임+점수를 바로 또 저장하면 시트에 쓰지 않음', env.rows().length === 1 && env.st.appends === 1);
  check('[중복] 중복은 오류가 아니라 { ok:true, duplicate:true, rank } 로 알려 줌 (다시 시도해도 안전)', r2.ok === true && r2.duplicate === true && r2.rank === 1 && r1.duplicate === undefined, JSON.stringify(r2));
  env.advance(9);
  save(env);
  check('[중복] 9초 뒤에도 여전히 막음', env.rows().length === 1);
  env.advance(2);
  save(env);
  check('[중복] 11초가 지나면 다시 저장됨', env.rows().length === 2);
  save(env, { score: 1001 });
  check('[중복] 점수가 다르면 바로 저장됨', env.rows().length === 3);
  save(env, { nickname: '다른애' });
  check('[중복] 닉네임이 다르면 같은 점수도 저장됨', env.rows().length === 4);
  save(env, { nickname: '영문Abc', score: 55 });
  save(env, { nickname: '영문aBC', score: 55 });
  check('[중복] 영어 대소문자만 다른 닉네임은 같은 사람으로 봄', env.rows().length === 5);
  check('[중복] 잠금은 매번 풀었음', env.st.lockAcquired === env.st.lockReleased && !env.st.lockHeld);
  check('[중복] 중복 기록용 캐시 항목의 유효시간은 10초', env.st.cachePuts.some(p => /jd:dup:/.test(p.key) && p.seconds === 10));
}

// ===========================================================================
// 8. 랭킹: 정렬 / 닉네임별 최고점 / 동점 / 개수 제한 / 난이도 필터
// ===========================================================================
{
  const env = makeEnv();
  save(env, { nickname: '가가가', score: 500, stars: 1, difficulty: 'easy' }); env.advance(11);
  save(env, { nickname: '나나나', score: 900, stars: 3, difficulty: 'hard' }); env.advance(11);
  save(env, { nickname: '다다다', score: 700, stars: 2, difficulty: 'normal' }); env.advance(11);
  const top = jsonClone(env.ctx.getTopScores(10));
  check('[랭킹] 점수 높은 순으로 정렬 + 등수 1,2,3', JSON.stringify(top.map(r => [r.rank, r.nickname, r.score])) === JSON.stringify([[1, '나나나', 900], [2, '다다다', 700], [3, '가가가', 500]]), JSON.stringify(top));
  check('[랭킹] 한 줄은 rank/nickname/score/stars/difficulty 5개 필드뿐', top.every(r => Object.keys(r).sort().join() === 'difficulty,nickname,rank,score,stars'));
  check('[랭킹] 별과 난이도가 그 기록의 값', top[0].stars === 3 && top[0].difficulty === 'hard' && top[2].difficulty === 'easy');
  check('[랭킹] 결과에 Date/함수/NaN 이 없음 (JSON 으로 왕복해도 같음)', plainProblem(env.ctx.getTopScores(10)) === '');

  // 닉네임별 최고점만
  const e2 = makeEnv();
  save(e2, { nickname: 'Bob', score: 100 }); e2.advance(11);
  save(e2, { nickname: 'Bob', score: 800, stars: 3 }); e2.advance(11);
  save(e2, { nickname: 'bob', score: 300 }); e2.advance(11);
  save(e2, { nickname: '앨리스', score: 400 }); e2.advance(11);
  const t2 = jsonClone(e2.ctx.getTopScores(10));
  check('[랭킹] 같은 닉네임(대소문자 무시)은 최고 점수 한 줄만', t2.length === 2 && t2[0].nickname === 'Bob' && t2[0].score === 800 && t2[1].nickname === '앨리스', JSON.stringify(t2));
  check('[랭킹] 시트에는 기록이 전부 남아 있음 (랭킹에서만 합침)', e2.rows().length === 4);

  // 동점: 먼저 달성한 쪽이 위
  const e3 = makeEnv();
  save(e3, { nickname: '먼저왔다', score: 500 }); e3.advance(30);
  save(e3, { nickname: '나중왔다', score: 500 }); e3.advance(30);
  save(e3, { nickname: '꼴등이', score: 100 });
  const t3 = jsonClone(e3.ctx.getTopScores(10));
  check('[랭킹] 동점이면 먼저 달성한 사람이 위 (등수는 1,2,3 으로 겹치지 않음)', JSON.stringify(t3.map(r => [r.rank, r.nickname])) === JSON.stringify([[1, '먼저왔다'], [2, '나중왔다'], [3, '꼴등이']]), JSON.stringify(t3));
  // 시트를 직접 손봐서 시간이 거꾸로 적혀 있어도 시간이 이김
  const e3b = makeEnv({ props: { SHEET_ID: 'S' } });
  const s3b = e3b.addSpreadsheet('S', 's', ['Scores']);
  s3b.sheets[0].rows = [['시간'], [new Date(START + 5000), '나중이', 500, 1, 'normal', 'stage1', 1], [new Date(START + 1000), '먼저이', 500, 1, 'normal', 'stage1', 1]];
  check('[랭킹] 시트 줄 순서가 뒤바뀌어도 시간이 더 빠른 쪽이 위', jsonClone(e3b.ctx.getTopScores(5)).map(r => r.nickname).join() === '먼저이,나중이');
  // 시간이 똑같으면 윗줄이 위
  const e3c = makeEnv({ props: { SHEET_ID: 'S' } });
  const s3c = e3c.addSpreadsheet('S', 's', ['Scores']);
  const same = new Date(START);
  s3c.sheets[0].rows = [['시간'], [same, '윗줄', 500, 1, 'normal', 'stage1', 1], [same, '아랫줄', 500, 1, 'normal', 'stage1', 1]];
  check('[랭킹] 시간까지 같으면 윗줄이 위', jsonClone(e3c.ctx.getTopScores(5)).map(r => r.nickname).join() === '윗줄,아랫줄');

  // 개수 제한 (60명 저장)
  const e4 = makeEnv();
  const nm = i => 'q' + String.fromCharCode(97 + Math.floor(i / 26)) + String.fromCharCode(97 + (i % 26)) + 'z';   // 숫자를 쓰면 sh1t 같은 변환 검사에 우연히 걸릴 수 있어서 글자만
  for (let i = 0; i < 60; i++) save(e4, { nickname: nm(i), score: 1000 + i, timeSec: i });
  const lens = [[100, 50], [50, 50], [51, 50], [5, 5], [1, 1], [0, 1], [-3, 1], ['7', 7], [3.9, 3], [undefined, 10], [null, 10], ['abc', 10], ['', 10], [NaN, 10]];
  for (const [n, want] of lens) check(`[랭킹] getTopScores(${typeof n === 'string' ? JSON.stringify(n) : String(n)}) → ${want}명`, e4.ctx.getTopScores(n).length === want, String(e4.ctx.getTopScores(n).length));
  const t4 = jsonClone(e4.ctx.getTopScores(100));
  check('[랭킹] 최대 50명: 1등은 가장 높은 점수, 마지막은 51번째로 높은 점수', t4[0].score === 1059 && t4[49].score === 1010 && t4.every((r, i) => r.rank === i + 1));
  check('[랭킹] 앞에서부터 자른 것 (getTopScores(5) 는 상위 5명)', JSON.stringify(jsonClone(e4.ctx.getTopScores(5)).map(r => r.score)) === '[1059,1058,1057,1056,1055]');

  // 난이도 필터
  const e5 = makeEnv();
  save(e5, { nickname: '혼합이', score: 900, difficulty: 'normal' }); e5.advance(11);
  save(e5, { nickname: '혼합이', score: 100, difficulty: 'hard', stars: 1 }); e5.advance(11);
  save(e5, { nickname: '하드왕', score: 600, difficulty: 'hard' }); e5.advance(11);
  save(e5, { nickname: '이지킹', score: 50, difficulty: 'easy' });
  const all = jsonClone(e5.ctx.getTopScores(10)), hard = jsonClone(e5.ctx.getTopScores(10, 'hard')), easy = jsonClone(e5.ctx.getTopScores(10, 'easy'));
  check('[랭킹] 난이도 hard 만: 하드 기록만, 닉네임별 최고(혼합이는 하드 100점)', JSON.stringify(hard.map(r => [r.rank, r.nickname, r.score, r.difficulty])) === JSON.stringify([[1, '하드왕', 600, 'hard'], [2, '혼합이', 100, 'hard']]), JSON.stringify(hard));
  check('[랭킹] 난이도 easy 만: 1명', easy.length === 1 && easy[0].nickname === '이지킹');
  check('[랭킹] 필터가 없으면 전체 중 닉네임별 최고(혼합이는 보통 900점)', all.length === 3 && all[0].nickname === '혼합이' && all[0].score === 900 && all[0].difficulty === 'normal');
  check('[랭킹] 난이도 normal 만: 1명', jsonClone(e5.ctx.getTopScores(10, 'normal')).length === 1);
  check("[랭킹] 'all' / null / 빈 글자 는 전체와 같음", ['all', null, ''].every(d => JSON.stringify(jsonClone(e5.ctx.getTopScores(10, d))) === JSON.stringify(all)));
  for (const d of ['impossible', 'HARD', 5, {}, ['hard'], '__proto__']) {
    check(`[랭킹] 모르는 난이도 ${JSON.stringify(d)} → 한글 오류`, /난이도/.test(msgOf(() => e5.ctx.getTopScores(10, d)) || ''));
  }
  check('[랭킹] 필터 결과가 없으면 빈 배열', JSON.stringify(jsonClone(makeEnv().ctx.getTopScores(10, 'hard'))) === '[]');

  // 손으로 고친 이상한 줄은 건너뜀
  const e6 = makeEnv({ props: { SHEET_ID: 'M' } });
  const s6 = e6.addSpreadsheet('M', 'm', ['Scores']);
  s6.sheets[0].rows = [
    ['시간', '닉네임', '점수', '별', '난이도', '스테이지', '시간(초)'],
    [new Date(START), '정상이', 300, 2, 'normal', 'stage1', 10],
    ['', '', '', '', '', '', ''],
    [new Date(START), '점수글자', '많이', 2, 'normal', 'stage1', 10],
    [new Date(START), '난이도이상', 999, 2, 'cheat', 'stage1', 10],
    [new Date(START), '', 999, 2, 'normal', 'stage1', 10],
    [new Date(START), '점수비어', '', 2, 'normal', 'stage1', 10],
    ['어제', '시간글자', '450', 9, 'hard', 'stage1', 10],            // 점수가 글자 "450" 이어도 숫자로 읽고, 별 9는 3으로 줄임
    [new Date(START), 12345, 200, 1, 'easy', 'stage1', 10],           // 닉네임 칸이 숫자(1e5 같은 것이 숫자로 바뀐 경우)여도 글자로 읽음
  ];
  const t6 = jsonClone(e6.ctx.getTopScores(10));
  check('[랭킹] 이상한 줄(빈 줄/점수 글자/난이도 이상/닉네임 빈 칸)은 건너뜀', JSON.stringify(t6.map(r => r.nickname)) === JSON.stringify(['시간글자', '정상이', '12345']), JSON.stringify(t6));
  check('[랭킹] 읽은 값은 숫자/글자로 정리 (별은 0~3 으로)', t6[0].score === 450 && t6[0].stars === 3 && typeof t6[2].nickname === 'string' && plainProblem(t6) === '');
}

// ===========================================================================
// 9. 캐시: 30초 / 저장하면 비움
// ===========================================================================
{
  const env = makeEnv();
  save(env, { nickname: '캐시일', score: 100 }); env.advance(11);
  const r0 = env.st.reads;
  env.ctx.getTopScores(10);
  const r1 = env.st.reads;
  env.ctx.getTopScores(10); env.ctx.getTopScores(3); env.ctx.getTopScores(50);
  check('[캐시] 첫 조회는 시트를 읽고, 이어지는 조회(다른 n 포함)는 시트를 읽지 않음', r1 === r0 + 1 && env.st.reads === r1, `읽기 ${r0} → ${r1} → ${env.st.reads}`);
  check('[캐시] 랭킹 캐시 유효시간은 30초', env.st.cachePuts.some(p => p.key === 'jd:top:all' && p.seconds === 30));
  // 시트를 몰래 바꿔도 캐시가 살아 있는 동안은 옛 값 (= 캐시가 실제로 쓰이고 있다는 증거)
  env.sheet().rows.push([new Date(START), '몰래추가', 99999, 3, 'normal', 'stage1', 1]);
  check('[캐시] 캐시가 살아 있는 동안에는 시트를 직접 고쳐도 옛 랭킹이 보임', jsonClone(env.ctx.getTopScores(10)).every(r => r.nickname !== '몰래추가'));
  env.advance(29);
  check('[캐시] 29초 후에도 아직 캐시', jsonClone(env.ctx.getTopScores(10)).every(r => r.nickname !== '몰래추가'));
  env.advance(2);
  check('[캐시] 31초가 지나면 만료되어 시트를 다시 읽음 (새 값이 보임)', jsonClone(env.ctx.getTopScores(10))[0].nickname === '몰래추가');

  // 저장하면 캐시 비움
  const e2 = makeEnv();
  save(e2, { nickname: '일번째', score: 100 }); e2.advance(11);
  e2.ctx.getTopScores(10); e2.ctx.getTopScores(10, 'hard');                      // 전체 + hard 캐시 채우기
  check('[캐시] 저장 전: 1명, hard 0명 (둘 다 캐시됨)', e2.ctx.getTopScores(10).length === 1 && e2.ctx.getTopScores(10, 'hard').length === 0);
  const reads = e2.st.reads;
  save(e2, { nickname: '이번째', score: 200, difficulty: 'hard' });
  const after = jsonClone(e2.ctx.getTopScores(10)), afterHard = jsonClone(e2.ctx.getTopScores(10, 'hard'));
  check('[캐시] 저장하면 전체 랭킹 캐시가 비워져 바로 새 기록이 보임', after.length === 2 && after[0].nickname === '이번째');
  check('[캐시] 저장하면 난이도별 캐시도 비워짐 (hard 에 새 기록이 보임)', afterHard.length === 1 && afterHard[0].nickname === '이번째');
  check('[캐시] 저장 뒤 조회는 시트를 다시 읽었음', e2.st.reads > reads);
  const removed = e2.st.cacheRemoves[e2.st.cacheRemoves.length - 1] || [];
  check('[캐시] removeAll 로 전체/easy/normal/hard 키를 모두 지움', ['jd:top:all', 'jd:top:easy', 'jd:top:normal', 'jd:top:hard'].every(k => removed.includes(k)), removed.join());
  check('[캐시] 중복 저장(시트를 안 건드린 저장)은 랭킹 캐시를 건드릴 필요가 없고 결과도 같음', (() => { const x = jsonClone(e2.ctx.getTopScores(10)); save(e2, { nickname: '이번째', score: 200, difficulty: 'hard' }); return JSON.stringify(x) === JSON.stringify(jsonClone(e2.ctx.getTopScores(10))); })());

  // 캐시가 망가져도 (용량/할당량 오류) 저장·조회는 계속 돼요
  const e3 = makeEnv();
  e3.st.cacheBroken = true;
  const m = msgOf(() => save(e3));
  const list = (() => { try { return jsonClone(e3.ctx.getTopScores(10)); } catch (e) { return null; } })();
  check('[캐시] 캐시 서비스가 오류를 내도 저장은 성공', m === null && e3.rows().length === 1);
  check('[캐시] 캐시 서비스가 오류를 내도 조회는 시트에서 읽어 성공', list && list.length === 1 && list[0].nickname === '민준이');
  // 깨진 캐시 값은 무시
  const e4 = makeEnv();
  save(e4); e4.advance(11);
  e4.st.cache.set('jd:top:all', { v: '{깨진json', exp: e4.st.now + 99999 });
  check('[캐시] 캐시에 깨진 값이 있어도 시트에서 다시 만듦', jsonClone(e4.ctx.getTopScores(10)).length === 1);
  e4.st.cache.set('jd:top:all', { v: '{"not":"array"}', exp: e4.st.now + 99999 });
  check('[캐시] 캐시 값이 배열이 아니어도 시트에서 다시 만듦', jsonClone(e4.ctx.getTopScores(10)).length === 1);
}

// ===========================================================================
// 10. 잠금(Lock)
// ===========================================================================
{
  let env = makeEnv();
  env.st.lockBusy = true;
  const m = msgOf(() => save(env));
  check('[잠금] 잠금을 못 얻으면 [busy] 표시가 붙은 한글 오류', m !== null && m.includes('[busy]') && /[가-힣]/.test(m), String(m));
  check('[잠금] 잠금을 못 얻으면 시트에 쓰지 않고, 시트도 만들지 않음', env.st.appends === 0 && env.st.created === 0);
  env.st.lockBusy = false;
  check('[잠금] 잠금이 풀리면 바로 다시 저장됨', msgOf(() => save(env)) === null && env.rows().length === 1);

  env = makeEnv();
  env.ctx.getTopScores(10);                                           // (시트 준비 없이도 조회는 잠금이 필요 없음)
  check('[잠금] 조회는 잠금을 쓰지 않음 (동시 조회가 서로 기다리지 않게)', env.st.lockAcquired === 0);

  env = makeEnv();
  save(env, { nickname: '먼저저장', score: 5 });
  env.st.failAppend = true;
  const m2 = msgOf(() => save(env, { nickname: '실패할거', score: 6 }));
  check('[잠금] 시트 쓰기가 실패하면 오류가 밖으로 나가고', m2 !== null && /append 실패/.test(m2), String(m2));
  check('[잠금] 오류가 나도 잠금은 반드시 풀림', !env.st.lockHeld && env.st.lockAcquired === env.st.lockReleased);
  env.st.failAppend = false;
  check('[잠금] 실패 뒤에도 다음 저장은 정상 (잠금이 걸린 채로 남지 않음)', msgOf(() => save(env, { nickname: '다음저장', score: 7 })) === null);
  check('[잠금] 실패한 저장은 중복 방지 표시를 남기지 않음 (바로 다시 시도 가능)', msgOf(() => save(env, { nickname: '실패할거', score: 6 })) === null && env.rows().some(r => r[1] === '실패할거'));
}

// ===========================================================================
// 11. 클라이언트(js_server.html)와 같은 규칙인지 비교
// ===========================================================================
{
  const between = (text, from = '==== BLOCKLIST START ====', to = '==== BLOCKLIST END ====') => text.slice(text.indexOf(from), text.indexOf(to));
  const arrayFrom = text => vm.runInNewContext(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
  const serverList = arrayFrom(between(CODE)), clientList = arrayFrom(between(CLIENT_HTML));
  check('[동기화] 금칙어 목록이 Code.gs 와 js_server.html 에서 똑같음', JSON.stringify(serverList) === JSON.stringify(clientList) && serverList.length >= 40, `${serverList.length} vs ${clientList.length}`);
  check('[금칙어] 모두 소문자이고 띄어쓰기/중복이 없음 (매칭이 소문자·공백 제거 기준이라서)', serverList.every(w => w === w.toLowerCase() && !/\s/.test(w) && w.length >= 1) && new Set(serverList).size === serverList.length);
  check('[금칙어] 흔한 단어를 괜히 막지 않음 (grape, class, pass, 새끼고양이, 젤리, 사탕 …)', (() => {
    const e = makeEnv();
    return ['grape', 'class', 'pass', 'Jelly', '새끼고양이', '젤리왕', '사탕', 'Candy', 'Mia', 'Tom', 'Sunny', 'Cucumber', 'Scrape', 'Nazia', 'Dickens', 'Essen'].every((n, i) => msgOf(() => save(e, { nickname: n, score: i })) === null);
  })());

  // 클라이언트 Server.validateNickname 과 서버 checkNickname_ 이 같은 결론을 내는지 (같은 표를 둘 다에 넣어 봄)
  const script = CLIENT_HTML.match(/<script>([\s\S]*)<\/script>/)[1];
  const cctx = vm.createContext({ Store: { get: (k, d) => d, set() {}, remove() {} }, console });
  vm.runInContext(script, cctx, { filename: 'js_server.html' });
  const Client = vm.runInContext('Server', cctx);
  const env = makeEnv();
  const table = [
    '', '   ', '가', 'a', '가나', '가나다라마바사아', '가나다라마바사아자', 'ABCDEFGHI', 'ab cd ef gh', 'a b', '  가  나  ', '=abc', '+abc', '@abc', '-abc', '=cmd()', '+1', '@x', '-a', '===',
    '=HYPERLINK("x")', 'ab!', 'a<b>c', 'a_b', '😀😀', '＝cmd', '漢字', "a'b", 'ㅋㅋ', 'ㅋㅋㅋㅋㅋㅋㅋㅋㅋ', '1234', '시발', '씨발놈', 'ㅅㅂ', 'FUCK', 'f u c k', 'sh1t', 'S H I T', '시1발', '착한fuck12', '=시발',
    'Jelly', 'jelly 99', 'grape', '새끼고양이', '\u1112\u1161\u11ab\u1100\u1173\u11af', 'a\tb', 'a\u3000b', '\u00a0\u00a0gh', '   =  =   mm', 'hit1er', 'h1tler', 'nazi', 'Nazi99', '0123', 'p0rn', 'p 0 r n',
  ];
  const mismatches = [];
  for (const s of table) {
    const c = Client.validateNickname(s);
    let sv; try { sv = { ok: true, value: env.ctx.checkNickname_(s) }; } catch (e) { sv = { ok: false, error: e.message }; }
    if (c.ok !== sv.ok || (c.ok ? c.value !== sv.value : c.error !== sv.error)) mismatches.push(`${JSON.stringify(s)}: 클라 ${JSON.stringify(c)} / 서버 ${JSON.stringify(sv)}`);
  }
  check(`[동기화] 닉네임 ${table.length}개에 대해 클라이언트와 서버의 판단(통과 여부, 정리된 값, 오류 문구)이 똑같음`, mismatches.length === 0, mismatches.slice(0, 3).join(' | '));
  // 설정값도 같은지
  const T = Client.config, L = jsonClone(env.const('LIMITS_'));
  check('[동기화] 글자 수/점수/별/시간/스테이지/랭킹 한도가 클라이언트 설정과 같음', T.nick.min === L.nickMin && T.nick.max === L.nickMax && T.scoreMax === L.scoreMax && T.starsMax === L.starsMax && T.timeSecMax === L.timeSecMax && T.stageIdMax === L.stageIdMax && T.rankMax === L.rankMax && T.rankDefault === L.rankDefault);
  check('[동기화] 난이도 목록이 클라이언트와 같음', JSON.stringify(T.difficulties) === JSON.stringify(jsonClone(env.const('DIFFICULTIES_'))));
  check('[동기화] 기본 스테이지 이름이 같음', T.defaultStage === env.const('DEFAULT_STAGE_'));
}

finish('code-gs');
