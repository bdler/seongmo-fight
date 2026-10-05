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
    reads: 0, readsWhileLocked: 0, opens: 0, opensWhileLocked: 0, appends: 0, failAppend: false,
    html: null, files: { index: '<html>INDEX</html>', js_core: '/* core */', style: '<style></style>' },
    logs: [],
  };
  const advance = sec => { st.now += sec * 1000; };

  class MockRange {
    constructor(sheet, row, col, nr, nc) { Object.assign(this, { sheet, row, col, nr, nc }); }
    getValues() {
      st.reads++;
      if (st.lockHeld) st.readsWhileLocked++;
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
    setNumberFormat(f) { this.sheet.formats.push({ col: this.col, format: f, rows: this.nr }); return this; }
  }
  class MockSheet {
    constructor(ss, name) { this.ss = ss; this.name = name; this.rows = []; this.formats = []; this.frozen = 0; this.maxRows = 1000; this.inserted = []; }
    getName() { return this.name; }
    setName(n) { this.name = n; return this; }
    getParent() { return this.ss; }
    getMaxRows() { return this.maxRows; }
    insertRowsAfter(pos, n) { this.maxRows += n; this.inserted.push(n); }
    insertRowBefore(pos) { this.rows.splice(pos - 1, 0, []); this.maxRows++; }
    getLastRow() { let last = 0; this.rows.forEach((r, i) => { if (r && r.some(v => v !== '' && v !== null && v !== undefined)) last = i + 1; }); return last; }
    getRange(row, col, nr = 1, nc = 1) {
      if (typeof row === 'string') {                     // A1 표기: 'B:B' (열 전체)
        const m = /^([A-Z]):([A-Z])$/.exec(row);
        if (!m) throw new Error('가짜 시트는 열 전체 A1 표기만 알아요: ' + row);
        return new MockRange(this, 1, m[1].charCodeAt(0) - 64, this.maxRows, m[2].charCodeAt(0) - m[1].charCodeAt(0) + 1);
      }
      return new MockRange(this, row, col, nr, nc);
    }
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
    openById(id) { st.opens++; if (st.lockHeld) st.opensWhileLocked++; if (!st.spreadsheets[id]) throw new Error('Exception: 문서를 열 수 없습니다 (가짜): ' + id); return st.spreadsheets[id]; },
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
  const res = save(env, { nickname: '  젤리   왕  ', score: 12345, stars: 3, difficulty: 'hard', stageId: 'stage1', timeSec: 421.6, cleared: true });   // (별 3 은 클리어했을 때만: 예전 값 stage2 / cleared:false 는 이제 거절돼요 - 아래 '말이 되는 기록' 구역)
  const row = env.rows()[0];
  check('[저장] 정상 저장은 정확히 1줄 추가', env.rows().length === 1 && env.st.appends === 1);
  check('[저장] 시간 칸에는 시각이 들어감 (가짜 시계 값)', row[0] && typeof row[0].getTime === 'function' && row[0].getTime() === START, String(row[0]));
  check('[저장] 닉네임은 공백을 정리한 값', row[1] === '젤리 왕', JSON.stringify(row[1]));
  check('[저장] 점수/별/난이도/스테이지가 그대로', row[2] === 12345 && row[3] === 3 && row[4] === 'hard' && row[5] === 'stage1');
  check('[저장] 시간(초)는 정수로 반올림', row[6] === 422, String(row[6]));
  check('[저장] 한 줄은 정확히 7칸 (머리글과 같음)', env.sheet().rows[1].length === 7);
  check('[저장] 응답은 { ok:true, rank } 뿐이고 Date 가 없음', plainProblem(res) === '' && Object.keys(res).sort().join() === 'ok,rank' && res.ok === true && res.rank === 1, JSON.stringify(res));
  check('[저장] 저장 후 쓴 잠금을 반드시 풀었음', env.st.lockAcquired === 1 && env.st.lockReleased === 1 && !env.st.lockHeld);
  check('[저장] 시트에 쓰는 동안 잠금을 잡고 있었음', env.st.appendsWhileLocked === 1 && env.st.appendsUnlocked === 0);

  // 경계값
  const e2 = makeEnv();
  check('[저장] 점수 0 과 99999(상한) 는 통과', msgOf(() => save(e2, { nickname: '경계일', score: 0 })) === null && msgOf(() => save(e2, { nickname: '경계이', score: 99999 })) === null);
  check('[저장] 별 0..3 통과, 별/클리어/시간/스테이지 생략하면 기본값', msgOf(() => save(e2, { nickname: '기본값', stars: undefined, cleared: undefined, timeSec: undefined, stageId: undefined })) === null);
  const dflt = e2.rows().find(r => r[1] === '기본값');
  check('[저장] 생략한 값의 기본: 별 0, 스테이지 stage1, 시간 0', dflt[3] === 0 && dflt[5] === 'stage1' && dflt[6] === 0);
  check('[저장] timeSec 0 (클리어 안 한 판) 과 86400 은 통과', msgOf(() => save(e2, { nickname: '시간영', timeSec: 0, cleared: false, stars: 0 })) === null && msgOf(() => save(e2, { nickname: '시간끝', timeSec: 86400 })) === null);

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
    ['한글 채움 문자(U+3164)만 있는 이름', { nickname: String.fromCharCode(0x3164).repeat(2) }, NICK_EMPTY],
    ['금칙어 사이에 한글 채움 문자(U+3164)', { nickname: '시' + String.fromCharCode(0x3164) + '발' }, NICK_BAD],
    ['금칙어 사이에 폭 없는 공백(U+200B)', { nickname: 'fu' + String.fromCharCode(0x200b) + 'ck' }, NICK_BAD],
    ['옛 자모(U+3165)는 글자 종류에서 거절', { nickname: String.fromCharCode(0x3165).repeat(2) }, NICK_CHARS],
    // 점수
    ['점수 -1', { score: -1 }, /점수가 올바르지/], ['점수 1000000', { score: 1000000 }, /점수가 올바르지/], ['점수 1e9', { score: 1e9 }, /점수가 올바르지/],
    ['점수 NaN', { score: NaN }, /점수가 올바르지/], ['점수 Infinity', { score: Infinity }, /점수가 올바르지/], ['점수 -Infinity', { score: -Infinity }, /점수가 올바르지/],
    ["점수 '12abc'", { score: '12abc' }, /점수가 올바르지/], ["점수 '123' (글자는 안 받음)", { score: '123' }, /점수가 올바르지/], ['점수 12.5 (소수)', { score: 12.5 }, /점수가 올바르지/],
    ['점수 없음', { score: undefined }, /점수가 올바르지/], ['점수 null', { score: null }, /점수가 올바르지/], ['점수 true', { score: true }, /점수가 올바르지/],
    ['점수 배열', { score: [5] }, /점수가 올바르지/], ['점수 -0.0001', { score: -0.0001 }, /점수가 올바르지/],
    ['점수 100000 (상한 99999 초과)', { score: 100000 }, /점수가 올바르지/], ['점수 999999 (예전 상한)', { score: 999999 }, /점수가 올바르지/],
    // 말이 되는 기록 (GAS-06 / KIDS-10)
    ['별 2개인데 클리어 안 함', { cleared: false }, /별 개수/], ['별 3개 + cleared 생략', { cleared: undefined, stars: 3 }, /별 개수/],
    ['클리어인데 44초', { timeSec: 44 }, /플레이 시간/], ['클리어인데 0초', { timeSec: 0 }, /플레이 시간/], ['클리어인데 44.4초(반올림 44)', { timeSec: 44.4 }, /플레이 시간/],
    ['모르는 스테이지 stage2', { stageId: 'stage2' }, /스테이지/], ['모르는 스테이지 zzz', { stageId: 'zzz' }, /스테이지/], ['모르는 스테이지 20자', { stageId: 'a'.repeat(20) }, /스테이지/], ['스테이지 대문자 STAGE1', { stageId: 'STAGE1' }, /스테이지/],
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
    const m = msgOf(() => save(fz, { nickname: s, score: i, timeSec: 60 }));   // (클리어한 판은 45초 이상이라 60초로)
    if (m === null) {
      stored++;
      const last = fz.rows()[fz.rows().length - 1][1];
      if (!/^[0-9A-Za-zㄱ-ㅣ가-힣 ]{2,8}$/.test(last) || /^[=+\-@ ]/.test(last) || / $/.test(last)) badStored++;
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
  for (let i = 0; i < 60; i++) save(e4, { nickname: nm(i), score: 1000 + i, timeSec: 60 + i });   // (클리어한 판은 45초 이상)
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
  save(env, { nickname: '캐시일', score: 100 });
  const warm0 = env.st.reads;
  env.ctx.getTopScores(10);
  check('[캐시] 저장 직후에는 랭킹 캐시가 이미 데워져 있어서, 바로 조회해도 시트를 다시 읽지 않음 (등수 계산이 만든 캐시를 다음 조회가 씀)', env.st.reads === warm0);
  env.advance(31);                                                   // (캐시 만료 후부터 확인)
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
// 11. 닉네임 필터: 걸려야 하는 이름 / 괜히 막으면 안 되는 이름 (아이들이 보는 공개 랭킹이라 가장 꼼꼼히)
// ===========================================================================
{
  const env = makeEnv();
  const FILL = String.fromCharCode(0x3164), ZW = String.fromCharCode(0x200b), ZWJ = String.fromCharCode(0x200d), BOM = String.fromCharCode(0xfeff), HFILL = String.fromCharCode(0xffa0);
  const verdict = n => { try { return { ok: true, value: env.ctx.checkNickname_(n) }; } catch (e) { return { ok: false, error: e.message }; } };
  const BAD = '이 이름은 쓸 수 없어요. 다른 이름을 적어 줄래요?';

  // ---- (a) 보이지 않는 글자 (GAS-01 / KIDS-02): 지워서 보고, 이름이 비면 빈 이름으로 거절
  const only = verdict(FILL + FILL);
  check('[필터] 한글 채움 문자(U+3164)만 있는 이름은 "이름을 적어 주세요" (빈 줄로 랭킹에 나오지 않음)', !only.ok && /이름을 적어 주세요/.test(only.error), JSON.stringify(only));
  check('[필터] 폭 없는 공백/ZWJ/BOM/반각 채움만 있는 이름도 빈 이름', [ZW + ZW, ZWJ + ZWJ, BOM + BOM, HFILL + HFILL, FILL + ZW + BOM].every(n => !verdict(n).ok && /이름을 적어 주세요/.test(verdict(n).error)));
  check('[필터] 맨 앞에 채움 문자를 붙여 남의 이름 흉내 내기: 채움 문자를 지운 값이 저장돼서 그냥 같은 이름이 됨', verdict(FILL + '민준').value === '민준' && verdict('민' + FILL + ZW + '준').value === '민준' && verdict('민준' + FILL).value === '민준');
  for (const [label, name] of [['한글 채움(U+3164)', '시' + FILL + '발'], ['폭 없는 공백(U+200B)', '시' + ZW + '발'], ['ZWJ', '병' + ZWJ + '신'], ['BOM', 'fu' + BOM + 'ck'], ['반각 채움(U+FFA0)', 'fu' + HFILL + 'ck'], ['채움 여러 개', 'f' + FILL + 'u' + FILL + 'c' + FILL + 'k']]) {
    check(`[필터] 금칙어 사이에 ${label} 를 끼워 넣어도 걸림`, verdict(name).error === BAD, JSON.stringify(verdict(name)));
  }
  check('[필터] 옛 자모(U+3165~U+318E)는 글자 종류에서 거절 (눈에 안 보이거나 안 쓰는 글자)', [0x3165, 0x3186, 0x318d, 0x318e].every(c => /한글, 영어, 숫자만/.test(verdict(String.fromCharCode(c).repeat(2)).error || '')));
  check('[필터] 보이는 자모 U+3131~U+3163 (ㄱ ㅋ ㅎ ㅏ ㅠ ㅣ) 는 그대로 쓸 수 있음', verdict('ㅋㅋ').value === 'ㅋㅋ' && verdict('ㅠㅠ').value === 'ㅠㅠ' && verdict('ㅎㅎㅎ').value === 'ㅎㅎㅎ' && verdict('ㄱㅏ').value === 'ㄱㅏ' && verdict('ㅣㅣ').value === 'ㅣㅣ');

  // ---- (b) 걸려야 하는 이름 (소리 비슷한 것, 자모로 풀어 쓴 것, 늘여 쓴 것, 숫자/띄어쓰기/ㅋㅋ 끼운 것 ...)
  const mustBlock = [
    // 한국어 욕설과 변형
    '시발', '씨발', '씨바', '시바', '씨빨', '씨벌', '씨팔', '시팔', '시벌', '쉬발', '슈발', '시이발', '시이이발', '씨바알', 'ㅅㅣㅂㅏㄹ', 'ㅆㅣㅂㅏㄹ', 'ㅅㅣ발', '시ㅂㅏㄹ', '씨ㅂㅏ', 'ㅅㅂ', 'ㅆㅂ', 'ㅅㅅㅂㅂ', 'ㅄㅄ', 'ㅄ1', 'ㅂㅅ',
    '시1발', 'ㅅ1ㅂ', 'ㅅ ㅂ', '시 발', '시ㅋ발', '시ㅋㅋ발', 'ㅅㅂ아', '아ㅅㅂ', '씨발놈', '시바새끼', '시발1', '십발', '씹발', '시부럴',
    '병신', '빙신', '븅신', '뼝신', '별신', 'ㅂㅅ', '병 신', '병1신', '지랄', '찌랄', 'ㅈㄹ', '염병', '옘병', '엠창',
    '개새끼', '개새키', '개세끼', '개쉐이', '개색', '십새', '십새끼', '씹새끼', '새끼', '쌔끼', '새키', '색기', '쉐기', '새끼ㅋㅋ', '새끼2',
    '미친', '미친놈', '미친년', 'ㅁㅊ', 'ㅁㅊㄴ', '또라이', '돌아이', '졸라', '조낸', '존나', '존내', '존니', '쫀나', 'ㅈㄴ', '좆1', '좆같네', '좃같네', '좆밥', '십팔',
    '뒤져', '디져', '뒈져', '죽어', '죽여', '죽일', '죽어버려', '뒤질래', '닥쳐', '꺼져', 'ㄲㅈ', 'ㄷㅊ', 'ㅅㅋ', 'ㅅㄲ', '찐따', '느금마', '니애미', '니미', '니미럴', 'ㅗㅗ', 'ㅗ1', '썅1', '썅년', '쌍년',
    // 성적/폭력/위험
    '보지', '자지', 'ㅋㅋ보지', '보지ㅋㅋ', '보지12', '보 지', '걸레', '성기', '자위', '강간', '변태', '섹스', '섹쓰', '쎅스', '섹시', '야동', '포르노', '창녀', '불알', '몰카', '자살', '자해', '죽고싶어', '살인마',
    // 차별/혐오/약물
    '한남충', '김치녀', '맘충', '틀딱', '급식충', '짱깨', '쪽바리', '깜둥이', '장애인', '게이', '호모', '메갈', '일베', '나치', '히틀러', '마약', '대마초',
    // 영어와 변형
    'fuck', 'FUCK', 'f u c k', 'fuuck', 'fuuuck', 'fck', 'fvck', 'phuck', 'fuk', 'fuc', 'shit', 'S H I T', 'sh1t', 'shiit', 'bitch', 'b1tch', 'asshole', 'assshole', 'ass', 'a55', 'dick', 'dickhead', 'cock', 'tits', 'boobs',
    'p0rn', 'p 0 r n', 'porn', 'sex', 'sexy', 'sex123', 'nazi', 'Nazi99', 'kkk', 'rape', 'gay', 'wtf', 'kys', 'suicide', 'killme', 'Hitler', 'hit1er', 'h1tler', 'nigga', 'cunt', 'pussy', 'slut', 'whore', 'jackass',
    'tlqkf', 'qudtls', 'sibal', 'ssibal', 'shibal',
    // 첫 글자만 자음으로 쓴 것 (ㅅ발 ㅂ신 ㅈ같 ㅁ친): 홀로 쓴 자음일 때만
    'ㅅ발', 'ㅆ발', 'ㅂ신', 'ㅁ친', 'ㅁ친놈', 'ㅈ같', 'ㅈ같네', 'ㅈ나', 'ㅈ랄', 'ㅇㅅ발', 'ㅋㅅ발', '아이ㅅ발', '옷ㅅ발', 'ㅅ 발', 'ㅅ1발',
    // 엉뚱한 낱자모·영어를 끼워 낱말을 갈라 숨기기 (한글이 들어 있으면 낱자모를, 섞어 썼으면 영어·숫자도 빼고 봐요)
    'ㅂㅎㅅ', 'ㅈㅋㄹ', 'ㅅㅎㅂ', '시ㅇ발', '시ㅇㅇ발', '병ㅁ신', '지ㅇ랄', '시a발', '시q발', '시ㅇa발', '시1ㅇ발', 'fㅇuck', 'fㅁㅁuck', 'sh1ㅇt', '시ㅇ바알', '3학년Ass',
    // QA(KIDS-01)가 빠졌다고 적은 것 / 아이들이 흔히 쓰는 말
    '애미', '애비', '니애비', '딸딸이', '좆만이', '좆도', '좃만', '죽어라', '죽여라', '뒈져라', '뒤져라', '디져라', '느그매', '야설', '성관계', '젖꼭지', '고환', '발기', '정액', '유두', '후장', '항문', '학살', '조건만남', '몸캠',
    '왕따', '멍청이', '찌질이', '쓰레기', '꼴통', '등신', '머저리', '대가리', '아가리', '개독', '빨갱이', '노알라', '한녀', '테러', '운지', '마리화나', '엑스터시', '아편',
    'fcuk', 'fuq', 'piss', 'boner', 'weed', 'meth', 'heroin', 'condom', 'idiot', 'stupid', 'dumb', 'loser', 'ugly', 'jerk', 'thot', 'sperm', 'nipple', 'massacre', 'cocaine', 'xvideos', 'tranny', 'hooker', 'incest', 'semen', 'gook',
  ];
  const slipped = mustBlock.filter(n => verdict(n).error !== BAD);
  check(`[필터] 걸려야 하는 이름 ${mustBlock.length}개가 전부 "쓸 수 없어요" 로 거절됨`, slipped.length === 0, slipped.slice(0, 12).join(' / '));
  for (const n of ['시발', '씨바', 'ㅅㅣㅂㅏㄹ', 'ㅆㅣㅂㅏㄹ', '시이발', '쉬발', 'ㅅㅣ발', '시ㅂㅏㄹ', '씨ㅂㅏ', 'fuuck', 'shiit', 'fuuuck', 'phuck', 'fvck', 'fuk', 'ㅁㅊ', 'ㅅㅂ', '졸라', '새끼', '뒤져', '죽어']) {
    check(`[필터] QA 가 찾아낸 우회: ${JSON.stringify(n)} → 거절`, verdict(n).error === BAD);   // (GAS-02 / KIDS-01 에 적힌 이름들)
  }

  // ---- (c) 괜히 막으면 안 되는 이름 (표로 확인: 하나라도 걸리면 어떤 이름인지 보여 줘요)
  const innocent = [
    // 한국어: 흔한 이름·낱말·귀여운 이름
    '말랑이', '말랑젤리', '사과', '시간', '젤리왕', '사탕공주', '별빛용사', '구름이', '푸딩왕', '마카롱', '솜사탕', '아이스크림', '초코쿠키', '딸기우유', '젤리곰', '용사', '민준', '서연', '하늘', '철수',
    '새끼고양이', '새끼곰', '호랑이새끼', '고양이새끼', '시바견', '시바이누', '걸레질', '씹던껌', '보지 못함', '나보지마', '잘자지마', '가자 지금', '보지마', '자지마',
    '조나단', '메갈로돈', '샹크스', '게이머', '게이트', '십자가', '오십', '십년후', '열한시', '장애물달리기', '마약김밥', '진달래', '창녕', '옷방', '밥사', '없는', '값진', '시바람', '시계', '시장', '신발', '신바람', '지렁이', '지우개', '개구쟁이', '개나리', '새벽', '졸업', '존경', '조사', '조선', '한남동', '한강', '변신', '변호사', '성공', '성인', '성냥', '자전거', '자유', '보름달', '보석', '걸그룹', '검둥이', '쫓아', '쫓기', '쌍둥이', '상놈', '샹들리에', '찐빵', '진단', 'ㅅㄱ', 'ㅋㅋ', 'ㅠㅠ', 'ㅎㅎㅎ', 'ㅇㅇ', 'ㅂㅂ', '아ㅋㅋ',
    // 영어: 흔한 이름·낱말 (안에 금칙어가 들어 있는 것들)
    'Jelly', 'Candy', 'Sunny', 'Mia', 'Tom', 'Cucumber', 'Scrape', 'Nazia', 'Dickens', 'Essen', 'grape', 'class', 'pass', 'Anna', 'Bobby', 'Aaron', 'Hannah', 'Jessica', 'Hancock', 'Peacock', 'Cocktail', 'Cockatoo', 'Dickie', 'Dickson',
    'Grassy', 'Assist', 'Bass', 'Cumin', 'Analysis', 'Canal', 'Gayle', 'Gaylord', 'Homer', 'Homework', 'Fukuoka', 'Fuki', 'Drape', 'Scrap', 'Banana', 'Japan', 'Raccoon', 'Pakistan', 'Niger', 'Diego', 'Shoe', 'Titan', 'Little', 'Kitty',
    'Spicy', 'Cocoon', 'Moronic', 'Soldier', 'Swank', 'Prickly', 'Shiba', 'Max', 'Alex', 'Texas',
    // 새로 넣은 낱말 때문에 괜히 막히면 안 되는 이름 (받침이 이어 붙어 보이는 것, 낱말 속에 들어 있는 것, 닮은 낱말)
    '옷발', '밥신', '좇아', '고환율', '성교육', '가발기', '정액권', '화학살충제', '유두리', '왕따봉', '쓰레기통', '에어로빅', '에로스', '골리앗', '죽어가는', '뒤져보자',
    '말랑jelly', '민준Kim', 'Mia하늘', '별빛Star', '젤리Bee', 'Sky구름', 'Max왕', '푸딩ㅋㅋ', '아ㅇ발', 's하i하t',
    '2018년생', '18년생', '열여덟', 'Heroine', 'Tweed', 'Methane', 'Idiotic', 'Uglydoll', 'Weeds', 'Stupidly', 'Jerky', 'Piston', 'Condor', 'Massa', 'Marina', 'Nippy',
  ];
  const wrong = innocent.filter(n => !verdict(n).ok);
  check(`[필터] 괜히 막으면 안 되는 이름 ${innocent.length}개가 전부 통과 (오탐 없음)`, wrong.length === 0, wrong.slice(0, 12).map(n => n + ' → ' + verdict(n).error).join(' / '));
  check('[필터] 통과한 이름은 정리된 값이 입력 그대로 (공백만 정리)', innocent.every(n => !verdict(n).ok || verdict(n).value === n.replace(/\s+/g, ' ').trim()));
  for (const n of ['말랑이', '사과', '시간', '시바견', '보지 못함', '가자 지금', '걸레질', '진달래', '창녕', '옷방', 'Cucumber', 'Essen', 'Dickens', 'grape', 'class', 'Nazia']) {
    check(`[필터] 괜찮은 이름 ${JSON.stringify(n)} → 통과`, verdict(n).ok === true, JSON.stringify(verdict(n)));
  }

  // ---- (d) 규칙의 경계 (일부러 이렇게 정했어요: 문서 docs/DEPLOY.md '금칙어 규칙')
  check('[필터] 짧고 뜻이 둘인 낱말은 "이름 전체"일 때만: 시바(걸림) / 시바견 · 시바이누(통과), 보지(걸림) / 보지마(통과), 걸레(걸림) / 걸레질(통과)', verdict('시바').error === BAD && verdict('시바견').ok && verdict('시바이누').ok && verdict('보지').error === BAD && verdict('보지마').ok && verdict('걸레').error === BAD && verdict('걸레질').ok);
  check('[필터] 이름 전체 규칙에서는 숫자·띄어쓰기·ㅋㅋ ㅎㅎ ㅠㅠ 는 무시: 보지2 / 보 지 / 보지ㅋㅋ / ㅎㅎ보지ㅠㅠ 모두 걸림', ['보지2', '보 지', '보지ㅋㅋ', 'ㅎㅎ보지ㅠㅠ', '시바1', '씨바ㅋㅋ'].every(n => verdict(n).error === BAD));
  check('[필터] 마지막 글자에 받침이 더 붙으면 다른 글자: 창녀(걸림) / 창녕(통과), 존나(걸림) / 존남(통과) — 자모로 따로 쓴 받침은 계속 걸림(창녀ㅇ)', verdict('창녀').error === BAD && verdict('창녕').ok && verdict('존나').error === BAD && verdict('존남').ok && verdict('창녀ㅇ').error === BAD);
  check('[필터] 글자 경계는 넘어가지 않음: 시바람 · 조나단 · 진달래 통과 (ㅂㅏ|ㄹ 이나 ㄴ|ㄴ 이 이어 붙어 보이는 오탐 없음)', verdict('시바람').ok && verdict('조나단').ok && verdict('진달래').ok);
  check('[필터] 자음만 쓴 줄임말은 자음 낱글자로 쓴 것만: ㅅㅂ 걸림 / 옷방 · 밥사 · 없는 · 값진 통과 (받침 ㅅ+ㅂ, ㅂ+ㅅ 오탐 없음)', verdict('ㅅㅂ').error === BAD && verdict('아ㅂㅅ').error === BAD && ['옷방', '밥사', '없는', '값진', '법사', '입사'].every(n => verdict(n).ok));
  check('[필터] 된소리: 예사소리로 적은 낱말은 된소리도 걸림(시발=씨발), 된소리로 적은 낱말은 된소리만(찐따 걸림 / 진달래 · 진단 통과, 쌍년 걸림 / 상놈 통과)', verdict('씨발').error === BAD && verdict('찐따').error === BAD && verdict('진단').ok && verdict('쌍년').error === BAD && verdict('상놈').ok);
  check('[필터] 영어: 같은 글자를 늘여 써도 걸림(fuuuck) 하지만 글자가 모자라거나 다른 낱말은 통과(Niger != nigger, Bob != boob, As != ass, Anna, Bobby)', verdict('fuuuck').error === BAD && verdict('nigger').error === BAD && verdict('Niger').ok && verdict('Bob').ok && verdict('boob').error === BAD && verdict('As').ok && verdict('ass').error === BAD && verdict('Anna').ok && verdict('Bobby').ok);
  check('[필터] 알려진 오탐은 일부러 막아 둠 (아이들 안전이 먼저): 시발점 · 병신년 · 꺼져라용 · 쫒아(쫓아의 틀린 맞춤법) · Essex · Sussex · Peniston · pussycat · Shiitake — 바꾸려면 이 줄을 같이 고쳐요', ['시발점', '병신년', '꺼져라용', '쫒아', 'Essex', 'Sussex', 'Peniston', 'pussycat', 'Shiitake'].every(n => verdict(n).error === BAD));
  check('[필터] 첫 글자만 자음으로 쓴 낱말(ㅅ발 ㅂ신)은 홀로 쓴 자음일 때만: ㅅ발 · ㅇㅅ발 · 아이ㅅ발 · 옷ㅅ발 걸림 / 옷발 · 밥신 · 밥발 통과 (앞 글자의 받침 ㅅ ㅂ 이 이어 붙어 보이는 오탐 없음)', ['ㅅ발', 'ㅇㅅ발', '아이ㅅ발', '옷ㅅ발', 'ㅂ신', '밥ㅂ신'].every(n => verdict(n).error === BAD) && ['옷발', '밥신', '밥발', '옷팔', '앞신', '집신'].every(n => verdict(n).ok));

  // ---- (e) 금칙어 목록 자체: 모든 단어가 (따로 입력해도) 걸리고, 흔한 모양으로 바꿔도 걸림 / 새 단어를 넣으면 바로 적용
  const strong = env.const('BLOCKLIST_'), whole = env.const('BLOCKLIST_WHOLE_');
  const notBlocked = [...strong, ...whole].filter(w => !env.ctx.nickBlocked_(w));
  check(`[필터] 목록의 모든 단어(${strong.length + whole.length}개)가 자기 자신을 거름`, notBlocked.length === 0, notBlocked.join(','));
  const variantsOf = w => [w + 'ㅋㅋ', w.split('').join(' '), 'ㅋ' + w + '1'];
  const escapes = [...strong, ...whole].flatMap(w => variantsOf(w).filter(v => !env.ctx.nickBlocked_(env.ctx.nickClean_(v))).map(v => w + ' → ' + v));
  check('[필터] 목록의 모든 단어는 끝에 ㅋㅋ / 글자마다 띄어쓰기 / 앞뒤에 ㅋ·숫자를 붙여도 걸림', escapes.length === 0, escapes.slice(0, 6).join(' | '));
  check('[필터] 목록 배열에 단어를 넣으면 바로 적용됨 (정규식은 처음 쓸 때 만들어 기억)', (() => {
    const before = !env.ctx.nickBlocked_('젤리괴물');
    strong.push('괴물');
    const mid = env.ctx.nickBlocked_('젤리괴물');
    strong.pop(); whole.push('괴수'); const w1 = env.ctx.nickBlocked_('괴수'), w2 = env.ctx.nickBlocked_('괴수왕'); whole.pop();
    return before && mid && w1 && !w2 && !env.ctx.nickBlocked_('젤리괴물');
  })());
  check('[필터] 빈 단어/공백 단어를 목록에 실수로 넣어도 모든 이름을 막아 버리지 않음', (() => { strong.push(''); strong.push('  '); whole.push(''); const r = env.ctx.nickBlocked_('말랑이'); strong.pop(); strong.pop(); whole.pop(); return r === false; })());
  check('[필터] 정규식 특수문자가 들어간 단어를 넣어도 오류 없이 동작', (() => { strong.push('a.b(c'); const r = [env.ctx.nickBlocked_('abc'), env.ctx.nickBlocked_('xa.b(cx')]; strong.pop(); return r[0] === false && r[1] === true; })());
}

// ===========================================================================
// 12. 말이 되는 기록 (GAS-06 / KIDS-10): 점수 상한 99999, 별은 클리어해야, 클리어는 45초 이상, 모르는 스테이지는 거절
// ===========================================================================
{
  const L = jsonClone(makeEnv().const('LIMITS_')), S = jsonClone(makeEnv().const('STAGE_IDS_'));
  check('[기록] 설정: 점수 상한 99999, 클리어 최소 45초, 스테이지는 stage1 뿐', L.scoreMax === 99999 && L.clearTimeMin === 45 && JSON.stringify(S) === '["stage1"]', JSON.stringify([L.scoreMax, L.clearTimeMin, S]));
  const env = makeEnv();
  const honest = [
    ['클리어 3별 4만 점 (정직한 최고 기록 근처)', { nickname: '정직일', score: 40000, stars: 3, cleared: true, timeSec: 420, difficulty: 'hard' }],
    ['클리어 1별 낮은 점수', { nickname: '정직이', score: 1200, stars: 1, cleared: true, timeSec: 180, difficulty: 'easy' }],
    ['클리어 0별 (죽어서 깬 판)', { nickname: '정직삼', score: 900, stars: 0, cleared: true, timeSec: 200, difficulty: 'normal' }],
    ['클리어 45초 딱 (경계)', { nickname: '정직사', score: 500, stars: 1, cleared: true, timeSec: 45 }],
    ['클리어 44.5초 → 반올림 45초', { nickname: '정직오', score: 500, stars: 1, cleared: true, timeSec: 44.5 }],
    ['게임 오버: 별 0, 짧은 시간도 정직함', { nickname: '정직육', score: 30, stars: 0, cleared: false, timeSec: 5 }],
    ['게임 오버: 점수 0, 시간 0', { nickname: '정직칠', score: 0, stars: 0, cleared: false, timeSec: 0 }],
    ['점수 상한 99999 딱', { nickname: '정직팔', score: 99999, stars: 3, cleared: true, timeSec: 600 }],
  ];
  for (const [name, rec] of honest) check(`[기록] 정직한 기록은 통과: ${name}`, msgOf(() => save(env, rec)) === null);
  check('[기록] 통과한 기록이 전부 시트에 한 줄씩', env.rows().length === honest.length);
  const before = env.rows().length;
  const forged = [
    ['999999점 + 별 3 + cleared 거짓 + 0초 + 이상한 스테이지 (QA 가 만든 위조 기록)', { nickname: 'hacker', score: 999999, stars: 3, cleared: false, timeSec: 0, difficulty: 'easy', stageId: 'zzz' }],
    ['콘솔 위조: 99999 초과', { nickname: '번개왕', score: 100000, stars: 3, cleared: true, timeSec: 300, stageId: 'stage1', difficulty: 'hard' }],
    ['콘솔 위조: 클리어 0초', { nickname: '번개왕', score: 50, stars: 3, cleared: true, timeSec: 0, stageId: 'stage1', difficulty: 'hard' }],
    ['별만 3개 (클리어 안 함)', { nickname: '번개왕', score: 50, stars: 3, cleared: false, timeSec: 100 }],
    ['스테이지 이름만 바꿔 보내기', { nickname: '번개왕', score: 50, stageId: 'stage99' }],
  ];
  for (const [name, rec] of forged) check(`[기록] 말이 안 되는 기록은 거절: ${name}`, msgOf(() => save(env, rec)) !== null && /[가-힣]/.test(msgOf(() => save(env, rec))));
  check('[기록] 거절된 위조 기록은 시트에 쓰이지 않고 잠금도 안 잡음', env.rows().length === before && env.st.lockAcquired === honest.length, `rows ${env.rows().length} lock ${env.st.lockAcquired}`);
}

// ===========================================================================
// 13. 잠금은 짧게 + 폭주 막기 (GAS-04 / GAS-05)
// ===========================================================================
{
  // (a) 잠금 안에서는 시트 전체를 읽지 않음 (등수 계산은 잠금을 푼 뒤)
  const env = makeEnv({ props: { SHEET_ID: 'BIG' } });
  const big = env.addSpreadsheet('BIG', 'big', ['Scores']);
  big.sheets[0].rows = [['시간', '닉네임', '점수', '별', '난이도', '스테이지', '시간(초)']];
  for (let i = 0; i < 3000; i++) big.sheets[0].rows.push([new Date(START - i * 1000), 'u' + i + 'q', 100 + i, 1, 'normal', 'stage1', 60]);
  env.st.reads = 0; env.st.opens = 0;
  const res = save(env, { nickname: '새친구', score: 3055 });                  // (3000명 중 46등: 랭킹은 50등까지만 보여서 그 안에 들어오는 점수로. 3055점은 이미 있어서 동점이면 먼저 낸 쪽이 위)
  check('[잠금] 3000줄 시트에서도 잠금 안에서는 시트를 한 번도 읽지 않음 (getValues 는 잠금을 푼 뒤 등수 계산에서만)', env.st.readsWhileLocked === 0 && env.st.reads === 1, `잠금 중 읽기 ${env.st.readsWhileLocked} / 전체 ${env.st.reads}`);
  check('[잠금] 잠금 안에서는 스프레드시트를 한 번만 열고 (등수 계산용으로 한 번 더는 잠금 밖에서)', env.st.opensWhileLocked === 1 && env.st.opens === 2, `잠금 중 ${env.st.opensWhileLocked} / 전체 ${env.st.opens}`);
  check('[잠금] 그래도 결과는 { ok:true, rank } (등수는 정확: 3055점은 위에 44명 + 같은 점수를 먼저 낸 1명 = 46등)', res.ok === true && res.rank === 46 && Object.keys(res).sort().join() === 'ok,rank', JSON.stringify(res));
  env.st.reads = 0;
  const dup = save(env, { nickname: '새친구', score: 3055 });
  check('[잠금] 중복 저장도 잠금 안에서 시트를 읽지 않고 { ok, duplicate, rank } 를 돌려줌', dup.duplicate === true && dup.ok === true && dup.rank === res.rank && env.st.readsWhileLocked === 0, JSON.stringify(dup));
  check('[잠금] 저장 뒤 랭킹 캐시가 데워져서 다음 조회는 시트를 읽지 않음', (() => { const r = env.st.reads; env.ctx.getTopScores(10); return env.st.reads === r; })());
  check('[잠금] 잠금은 저장 한 번에 한 번만 잡고 풀었음 (저장 2번 = 2번)', env.st.lockAcquired === 2 && env.st.lockReleased === 2);

  // (b) 폭주 막기: 1분에 BURST_MAX_PER_MIN_(300)번을 넘으면 잠금 전에 [busy]
  const e2 = makeEnv();
  const max = e2.const('BURST_MAX_PER_MIN_');
  check('[폭주] 1분 상한은 300 (한 반 30명이 한꺼번에 눌러도 한참 못 미침)', max === 300);
  let failed = -1;
  for (let i = 0; i < max; i++) { if (msgOf(() => save(e2, { nickname: '연타', score: i })) !== null) { failed = i; break; } }
  check('[폭주] 300번까지는 전부 저장됨 (정직한 사용을 막지 않음)', failed === -1 && e2.rows().length === max, `실패 ${failed} 줄 ${e2.rows().length}`);
  const locks = e2.st.lockAcquired;
  const m = msgOf(() => save(e2, { nickname: '연타', score: 5000 }));
  check('[폭주] 301번째는 [busy] 한글 오류 (클라이언트가 한 번 다시 시도하고 안 되면 내 기기에 저장)', m !== null && m.includes('[busy]') && /[가-힣]/.test(m), String(m));
  check('[폭주] 걸러진 요청은 잠금을 잡지도 시트에 쓰지도 않음 (잠금 시간을 쓰지 않으니 진짜 저장이 밀리지 않음)', e2.st.lockAcquired === locks && e2.rows().length === max);
  check('[폭주] 잘못된 요청은 검사에서 먼저 한글 오류로 돌아감 (상한에 걸려도 [busy] 가 아니라 이유를 알려 줌)', /쓸 수 없어요/.test(msgOf(() => save(e2, { nickname: '시발', score: 1 })) || ''));
  e2.advance(61);
  check('[폭주] 1분이 지나면 다시 저장됨', msgOf(() => save(e2, { nickname: '연타', score: 6000 })) === null);
  check('[폭주] 요청 수 캐시는 90초만 기억 (캐시가 쌓이지 않음)', e2.st.cachePuts.some(p => /^jd:burst:\d+$/.test(p.key) && p.seconds === 90));
  const e3 = makeEnv();
  e3.st.cacheBroken = true;
  check('[폭주] 캐시가 고장 나면 상한 없이 그냥 통과 (저장이 멈추지 않음)', msgOf(() => save(e3, { nickname: '캐시고장', score: 1 })) === null && e3.rows().length === 1);

  // (c) setup 은 할 일이 없으면 잠금을 잡지 않음 (웹에서 아무나 불러도 저장을 막지 못하게)
  const e4 = makeEnv();
  e4.ctx.setup();
  const l1 = e4.st.lockAcquired;
  for (let i = 0; i < 20; i++) e4.ctx.setup();
  check('[setup] 처음 한 번만 잠금을 잡고(시트 만들기), 이미 준비된 시트에서는 몇 번을 불러도 잠금을 잡지 않음', l1 === 1 && e4.st.lockAcquired === 1 && e4.st.created === 1, `lock ${l1} → ${e4.st.lockAcquired}`);
  check('[setup] 시트가 이미 있으면 잠금이 다른 사람에게 잡혀 있어도 바로 끝남 (기다리다 실패하지 않음)', (() => { e4.st.lockBusy = true; const r = msgOf(() => e4.ctx.setup()); e4.st.lockBusy = false; return r === null; })());
  const e5 = makeEnv();
  check('[잠금] 클라이언트 제한(10초)보다 서버 잠금 대기가 짧음: [busy] 가 먼저 도착해서 한 번 더 시도할 수 있음', e5.const('LOCK_WAIT_MS_') === 6000);
}

// ===========================================================================
// 14. 시트 손질: 머리글이 지워진 시트 (GAS-08) / 칸 서식과 빈 줄 (GAS-09)
// ===========================================================================
{
  const DATE = new Date(START);
  const rec = (nick, score) => [DATE, nick, score, 3, 'hard', 'stage1', 100];
  // (a) 머리글이 지워진 시트: 첫 기록이 랭킹에서 사라지지 않음
  let env = makeEnv({ props: { SHEET_ID: 'H' } });
  let sh = env.addSpreadsheet('H', 'h', ['Scores']).sheets[0];
  sh.rows = [rec('일등이', 9000), rec('이등이', 100)];
  const top = jsonClone(env.ctx.getTopScores(10));
  check('[머리글] 머리글(1행)이 지워져도 첫 줄 기록이 랭킹에 나옴 (일등이 9000)', top.map(r => r.nickname).join() === '일등이,이등이' && top[0].score === 9000, JSON.stringify(top));
  save(env, { nickname: '삼등이', score: 50 });
  check('[머리글] 그 뒤 저장해도 기록이 뒤에 붙고 랭킹은 전부 보임 (머리글은 setup 이 복구)', env.sheet().data().length === 3 && jsonClone(env.ctx.getTopScores(10)).length === 3);
  env.advance(31);
  const lockBefore = env.st.lockAcquired;
  env.ctx.setup();
  const d = env.sheet().data();
  check('[머리글] setup 을 실행하면 지워진 머리글을 맨 위에 다시 끼워 넣고 기록은 그대로', d[0][1] === '닉네임' && d[0][2] === '점수' && d.length === 4 && d[1][1] === '일등이' && d[3][1] === '삼등이', JSON.stringify(d.map(r => r[1])));
  check('[머리글] 복구는 잠금 안에서 하고, 머리글 줄 고정(frozen)도 다시 켬', env.st.lockAcquired === lockBefore + 1 && env.sheet().frozen === 1);
  check('[머리글] 복구 뒤에도 랭킹이 같음 (일등이 9000 이 그대로 1등)', (() => { env.advance(31); const t = jsonClone(env.ctx.getTopScores(10)); return t.length === 3 && t[0].nickname === '일등이'; })());
  env.ctx.setup();
  check('[머리글] 한 번 더 setup 해도 머리글을 또 끼워 넣지 않음', env.sheet().data().length === 4);

  // (b) 손으로 고친 머리글(HEAD1, HEAD2) 은 건드리지 않음
  env = makeEnv({ props: { SHEET_ID: 'X' } });
  sh = env.addSpreadsheet('X', 'x', ['Scores']).sheets[0];
  sh.rows = [['HEAD1', 'HEAD2'], rec('옛날친구', 777)];
  env.ctx.setup();
  check('[머리글] 사람이 바꾼 머리글(점수 칸이 숫자가 아님)은 그대로 둠', env.sheet().data().length === 2 && env.sheet().data()[0][0] === 'HEAD1');

  // (c) 새 시트: 빈 줄을 미리 만들고 닉네임/스테이지 열 전체를 글자 서식으로
  env = makeEnv();
  save(env);
  sh = env.sheet();
  const need = env.const('SHEET_ROWS_');
  const fmt = col => sh.formats.filter(f => f.col === col);
  check('[서식] 새 시트에는 빈 줄을 3000줄쯤 미리 만들어 둠', need === 3000 && sh.maxRows >= need && sh.maxRows - sh.getLastRow() >= need - 10, `줄 ${sh.maxRows} 기록 ${sh.getLastRow()}`);
  check('[서식] 닉네임(B) 열 전체와 스테이지(F) 열 전체가 글자(@) 서식, 시간(A) 열은 날짜 서식', fmt(2).some(f => f.format === '@' && f.rows >= need) && fmt(6).some(f => f.format === '@' && f.rows >= need) && fmt(1).some(f => /yyyy/.test(f.format) && f.rows >= need));
  check('[서식] 서식을 입힌 줄 수가 실제 시트 줄 수 전체 (미리 만든 빈 줄까지 서식이 입혀짐)', fmt(2).every(f => f.rows === sh.maxRows) && fmt(6).every(f => f.rows === sh.maxRows));
  check('[서식] 처음 저장한 뒤 setup 은 손볼 게 없음 (서식을 또 입히지 않고 잠금도 안 잡음)', (() => { const n = sh.formats.length, l = env.st.lockAcquired; env.ctx.setup(); return sh.formats.length === n && env.st.lockAcquired === l; })());

  // (d) 빈 줄이 거의 다 찬 시트: setup 이 빈 줄을 늘리고 서식을 다시 입힘
  env = makeEnv({ props: { SHEET_ID: 'F' } });
  sh = env.addSpreadsheet('F', 'f', ['Scores']).sheets[0];
  sh.rows = [['시간', '닉네임', '점수', '별', '난이도', '스테이지', '시간(초)']];
  for (let i = 0; i < 900; i++) sh.rows.push(rec('q' + i + 'z', i));
  const ins0 = sh.inserted.length;
  env.ctx.setup();
  check('[서식] 빈 줄이 200줄 밑으로 남은 시트(1000줄 중 901줄 사용)는 setup 이 빈 줄을 3000줄 이상으로 늘리고 서식을 다시 맞춤', sh.inserted.length === ins0 + 1 && sh.maxRows - sh.getLastRow() >= 3000 && sh.formats.some(f => f.col === 2 && f.format === '@' && f.rows === sh.maxRows));
  check('[서식] 늘린 뒤에도 기록 901줄은 그대로', sh.getLastRow() === 901 && jsonClone(env.ctx.getTopScores(50)).length === 50);
}

// ===========================================================================
// 15. 클라이언트(js_server.html)와 같은 규칙인지 비교
// ===========================================================================
{
  const between = (text, from, to) => text.slice(text.indexOf(from), text.indexOf(to) + to.length);
  const lists = (text, names) => vm.runInNewContext(between(text, '// ==== BLOCKLIST START ====', '// ==== BLOCKLIST END ====').replace(/\bconst\b/g, 'var') + `\n[${names.join(',')}]`);
  const [serverList, serverWhole] = lists(CODE, ['BLOCKLIST_', 'BLOCKLIST_WHOLE_']), [clientList, clientWhole] = lists(CLIENT_HTML, ['NICKNAME_BLOCKLIST', 'NICKNAME_BLOCKLIST_WHOLE']);
  check('[동기화] 금칙어 목록(이름에 들어 있으면 / 이름 전체)이 Code.gs 와 js_server.html 에서 똑같음', JSON.stringify(serverList) === JSON.stringify(clientList) && JSON.stringify(serverWhole) === JSON.stringify(clientWhole) && serverList.length >= 150 && serverWhole.length >= 80, `${serverList.length}+${serverWhole.length} vs ${clientList.length}+${clientWhole.length}`);
  const all = [...serverList, ...serverWhole];
  check('[금칙어] 모두 소문자이고 띄어쓰기가 없고 비어 있지 않음 (매칭이 소문자·공백 제거 기준이라서)', all.every(w => w === w.toLowerCase() && !/\s/.test(w) && w.length >= 1));
  check('[금칙어] 같은 단어가 두 번 적혀 있거나 두 목록에 다 있지 않음', new Set(serverList).size === serverList.length && new Set(serverWhole).size === serverWhole.length && !serverList.some(w => serverWhole.includes(w)));
  const hygieneEnv = makeEnv();
  const bodies = (list, key) => list.map(w => hygieneEnv.ctx.nickPattern_(w)[key].source);
  const dupBody = (list, key) => { const b = bodies(list, key); return list.filter((w, i) => b.indexOf(b[i]) !== i); };
  check('[금칙어] 소리 규칙으로 같아지는 군더더기 단어가 없음 (예: 시발 과 씨발 을 따로 적으면 안 돼요 - 예사소리로 적은 것 하나면 돼요)', dupBody(serverList, 'strong').length === 0 && dupBody(serverWhole, 'whole').length === 0, dupBody(serverList, 'strong').concat(dupBody(serverWhole, 'whole')).join(','));
  check('[금칙어] 한글/영어 글자 외의 글자는 목록에 없음', all.every(w => /^[0-9a-zㄱ-ㅣ가-힣]+$/.test(w)));

  // 정리·필터 도구 블록은 두 파일에서 들여쓰기만 빼고 글자 하나까지 같아야 해요
  const norm = text => between(text, '// ==== NICK-FILTER START ====', '// ==== NICK-FILTER END ====').split('\n').map(l => l.trim()).filter(Boolean).join('\n');
  const nb = norm(CODE);
  check('[동기화] 닉네임 정리·금칙어 도구(NICK-FILTER 블록)가 Code.gs 와 js_server.html 에서 글자 하나까지 똑같음', nb.length > 3000 && nb === norm(CLIENT_HTML), `${nb.length} vs ${norm(CLIENT_HTML).length}`);

  const script = CLIENT_HTML.match(/<script>([\s\S]*)<\/script>/)[1];
  const cctx = vm.createContext({ Store: { get: (k, d) => d, set() {}, remove() {} }, console });
  vm.runInContext(script, cctx, { filename: 'js_server.html' });
  const Client = vm.runInContext('Server', cctx);
  const env = makeEnv();

  // 도구가 같은 결과를 내는지: 모든 완성형 글자 11172개, 모든 자모, 영어/숫자, 무작위 문자열
  const bad = [];
  for (let c = 0xAC00; c <= 0xD7A3; c++) { const ch = String.fromCharCode(c); if (env.ctx.nickSkeleton_(ch) !== Client.nickSkeleton(ch)) bad.push(ch); }
  for (let c = 0x20; c <= 0x7e; c++) { const ch = String.fromCharCode(c); if (env.ctx.nickSkeleton_(ch) !== Client.nickSkeleton(ch)) bad.push(ch); }
  for (let c = 0x3100; c <= 0x3190; c++) { const ch = String.fromCharCode(c); if (env.ctx.nickSkeleton_(ch) !== Client.nickSkeleton(ch)) bad.push(ch); }
  check('[동기화] 한글 완성형 11172자 + 자모 + 영어/숫자 낱글자의 "뼈대"가 클라이언트와 서버에서 똑같음', bad.length === 0, bad.slice(0, 8).join(''));

  const FILL = String.fromCharCode(0x3164), ZW = String.fromCharCode(0x200b);
  const alphabet = ['시', '발', '씨', '바', '병', '신', '새', '끼', '보', '지', '자', '존', '나', '가', '민', '준', '창', '녀', '녕', '이', '아', '알', '옷', '방', '없', 'ㅅ', 'ㅂ', 'ㅈ', 'ㄹ', 'ㅁ', 'ㅊ', 'ㅋ', 'ㅎ', 'ㅣ', 'ㅏ', 'ㅓ', 'ㅇ', 'ㅄ', 'ㅆ', 'ㄲ', 'ㅠ',
    'f', 'u', 'c', 'k', 's', 'h', 'i', 't', 'a', 'A', 'S', '1', '5', '0', '7', ' ', ' ', '=', '-', FILL, ZW, '😀', '_'];
  let seed = 777;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  let skelDiff = 0, verdictDiff = 0, blockedN = 0, passedN = 0;
  const diffs = [];
  for (let i = 0; i < 6000; i++) {
    const len = 1 + Math.floor(rnd() * 9);
    let s = '';
    for (let k = 0; k < len; k++) s += alphabet[Math.floor(rnd() * alphabet.length)];
    if (env.ctx.nickSkeleton_(s) !== Client.nickSkeleton(s)) { skelDiff++; diffs.push('skeleton ' + JSON.stringify(s)); }
    const c = Client.validateNickname(s);
    let sv; try { sv = { ok: true, value: env.ctx.checkNickname_(s) }; } catch (e) { sv = { ok: false, error: e.message }; }
    if (c.ok !== sv.ok || (c.ok ? c.value !== sv.value : c.error !== sv.error)) { verdictDiff++; diffs.push(JSON.stringify(s)); }
    if (!sv.ok && /쓸 수 없어요/.test(sv.error)) blockedN++; else if (sv.ok) passedN++;
  }
  check('[동기화] 무작위 문자열 6000개(한글/자모/영어/숫자/채움 문자/이모지 섞음)에 대해 뼈대와 판단(통과 여부, 정리된 값, 오류 문구)이 똑같음', skelDiff === 0 && verdictDiff === 0, diffs.slice(0, 4).join(' | '));
  check('[동기화] (그 무작위 표가 걸림/통과 양쪽을 골고루 건드림)', blockedN > 60 && passedN > 200, `걸림 ${blockedN} / 통과 ${passedN}`);

  // 클라이언트 쪽 판단도 위의 표(걸려야 함/괜찮아야 함)와 같은지 한 번 더
  const spot = ['시발', '씨바', 'ㅅㅣㅂㅏㄹ', '시' + FILL + '발', 'fuuuck', '보지', '보지마', '시바견', '창녕', '진달래', 'Cucumber', 'Essen', 'ㅤㅤ'];
  const sdiff = spot.filter(s => { const c = Client.validateNickname(s); let sv; try { sv = { ok: true, value: env.ctx.checkNickname_(s) }; } catch (e) { sv = { ok: false, error: e.message }; } return JSON.stringify(c) !== JSON.stringify(sv); });
  check('[동기화] 대표 이름 13개(채움 문자 포함)의 클라이언트/서버 결과 전체(JSON)가 똑같음', sdiff.length === 0, sdiff.join(','));

  const table = [
    '', '   ', '가', 'a', '가나', '가나다라마바사아', '가나다라마바사아자', 'ABCDEFGHI', 'ab cd ef gh', 'a b', '  가  나  ', '=abc', '+abc', '@abc', '-abc', '=cmd()', '+1', '@x', '-a', '===',
    '=HYPERLINK("x")', 'ab!', 'a<b>c', 'a_b', '😀😀', '＝cmd', '漢字', "a'b", 'ㅋㅋ', 'ㅋㅋㅋㅋㅋㅋㅋㅋㅋ', '1234', '시발', '씨발놈', 'ㅅㅂ', 'FUCK', 'f u c k', 'sh1t', 'S H I T', '시1발', '착한fuck12', '=시발',
    'Jelly', 'jelly 99', 'grape', '새끼고양이', '\u1112\u1161\u11ab\u1100\u1173\u11af', 'a\tb', 'a\u3000b', '\u00a0\u00a0gh', '   =  =   mm', 'hit1er', 'h1tler', 'nazi', 'Nazi99', '0123', 'p0rn', 'p 0 r n',
    FILL + FILL, '시' + FILL + '발', FILL + '민준', '민' + ZW + '준', 'fu' + FILL + 'ck', String.fromCharCode(0x3165).repeat(2), '씨바', '시바견', '보지 못함', '창녀', '창녕',
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
  check('[동기화] 글자 수/점수/별/시간/클리어 최소 시간/스테이지/랭킹 한도가 클라이언트 설정과 같음', T.nick.min === L.nickMin && T.nick.max === L.nickMax && T.scoreMax === L.scoreMax && T.starsMax === L.starsMax && T.timeSecMax === L.timeSecMax && T.clearTimeMin === L.clearTimeMin && T.stageIdMax === L.stageIdMax && T.rankMax === L.rankMax && T.rankDefault === L.rankDefault);
  check('[동기화] 난이도 목록이 클라이언트와 같음', JSON.stringify(T.difficulties) === JSON.stringify(jsonClone(env.const('DIFFICULTIES_'))));
  check('[동기화] 스테이지 목록이 클라이언트와 같음', JSON.stringify(T.stageIds) === JSON.stringify(jsonClone(env.const('STAGE_IDS_'))));
  check('[동기화] 기본 스테이지 이름이 같고 허용 목록 안에 있음', T.defaultStage === env.const('DEFAULT_STAGE_') && T.stageIds.includes(T.defaultStage));
  check('[동기화] 서버 잠금 대기(6초) < 클라이언트 호출 제한(10초) < 전체 상한(11초)', env.const('LOCK_WAIT_MS_') < T.timeoutMs && T.timeoutMs < T.totalMs);
}

finish('code-gs');
