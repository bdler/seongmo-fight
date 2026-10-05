#!/usr/bin/env node
// 로컬 빌드: src/index.html 의 <?!= include('이름') ?> 를 src/이름.html 로 치환해 단일 HTML 을 만든다.
// (Apps Script 가 서버에서 하는 일을 로컬에서 똑같이 흉내 내는 것 — 결과 파일은 더블클릭으로 바로 실행 가능)
//
// 사용법:
//   node tools/build-local.mjs [--out dist/index.html]   빌드 (문제가 있으면 파일을 만들지 않고 종료 코드 1)
//   node tools/build-local.mjs --check [--out 파일]      빌드는 메모리에서만 하고, 이미 있는 dist/index.html(또는 --out 파일)과 똑같은지 비교
//                                                        (src 를 고치고 빌드를 안 한 채 커밋/배포하는 실수를 잡아요 → npm run check:dist)
//
// 빌드가 "성공"이라고 하면서 깨진 게임을 만들지 않도록 아래를 모두 검사해요:
//   1. include 한 파일이 없음 / 같은 include 가 두 번 / src/*.html 이 index.html 에서 빠짐 / js_core 가 첫째, js_main 이 마지막이 아님
//   2. <script> 짝이 안 맞음, 각 <script> 의 JS 문법 오류 (속성이 붙은 태그도 검사)
//   3. 속성이 붙은 <script> (src/type=module/async/defer …) — Apps Script 가 다르게 처리할 수 있어서 금지
//   4. 파일끼리 최상위 const/let/var/function/class 이름이 겹침 (브라우저에서는 두 번째 파일이 통째로 실행되지 않아요)
//   5. 처리되지 않은 <? 스크립틀릿이 결과에 남음
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = resolve(root, 'src');
const argv = process.argv.slice(2);
const checkMode = argv.includes('--check');
const outIdx = argv.indexOf('--out');
if (outIdx >= 0 && (!argv[outIdx + 1] || argv[outIdx + 1].startsWith('--'))) { console.error('--out 뒤에 파일 경로가 필요해요 (예: --out dist/_내이름.html)'); process.exit(1); }
const out = resolve(root, outIdx >= 0 ? argv[outIdx + 1] : 'dist/index.html');
const rel = p => p.replace(root + '/', '');

const INCLUDE = /<\?!=\s*include\(\s*['"]([\w-]+)['"]\s*\)\s*\?>/g;
const GLOBAL_LOCKED = new Set(['window', 'document', 'location', 'top', 'undefined', 'NaN', 'Infinity']);   // 전역 객체에 지울 수 없게 붙어 있는 이름 (const/function 으로 다시 선언하면 오류)
let problems = 0;
const fail = msg => { console.error('✗ ' + msg); problems++; };

// ---------------------------------------------------------------------------
// JS 최상위 선언 이름 뽑기 (파일 사이 이름 충돌 검사용)
//   문자열·주석·정규식·템플릿 리터럴을 건너뛰고 (), [], {} 깊이를 세어서 "깊이 0" 의 const/let/var/function/class 만 모아요.
//   문법 오류는 vm.Script 가 따로 잡으니, 여기서는 문법이 맞는 코드만 들어온다고 가정해요.
// ---------------------------------------------------------------------------
const KW_BEFORE_REGEX = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const ID_START = /[\p{ID_Start}$_]/u, ID_PART = /[\p{ID_Continue}$‌‍]/u;

function tokenize(c) {
  const T = [];
  let i = 0, line = 1;
  const n = c.length;
  const push = (type, v, startLine) => T.push({ type, v, line: startLine });
  const skipString = q => {                                      // c[i] === q 에서 시작 → 닫는 따옴표 다음 위치
    i++;
    while (i < n && c[i] !== q) { if (c[i] === '\\') { if (c[i + 1] === '\n') line++; i += 2; continue; } if (c[i] === '\n') line++; i++; }
    i++;
  };
  const skipTemplate = () => {                                   // c[i] === '`'
    i++;
    while (i < n) {
      const ch = c[i];
      if (ch === '\\') { if (c[i + 1] === '\n') line++; i += 2; continue; }
      if (ch === '`') { i++; return; }
      if (ch === '$' && c[i + 1] === '{') { i += 2; skipBraces(); continue; }
      if (ch === '\n') line++;
      i++;
    }
  };
  const skipBraces = () => {                                     // '${' 바로 다음 → 짝이 맞는 '}' 다음
    let depth = 1;
    while (i < n) {
      const ch = c[i];
      if (ch === '"' || ch === "'") { skipString(ch); continue; }
      if (ch === '`') { skipTemplate(); continue; }
      if (ch === '/' && c[i + 1] === '/') { while (i < n && c[i] !== '\n') i++; continue; }
      if (ch === '/' && c[i + 1] === '*') { const e = c.indexOf('*/', i + 2); const stop = e < 0 ? n : e + 2; for (; i < stop; i++) if (c[i] === '\n') line++; continue; }
      if (ch === '\n') line++;
      if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) { i++; return; }
      i++;
    }
  };
  while (i < n) {
    const ch = c[i];
    if (ch === '\n') { line++; i++; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === ' ' || ch === '﻿') { i++; continue; }
    if (ch === '/' && c[i + 1] === '/') { while (i < n && c[i] !== '\n') i++; continue; }
    if (ch === '/' && c[i + 1] === '*') { const e = c.indexOf('*/', i + 2); const stop = e < 0 ? n : e + 2; for (; i < stop; i++) if (c[i] === '\n') line++; continue; }
    const startLine = line, last = T[T.length - 1];
    if (ch === '"' || ch === "'") { skipString(ch); push('s', '', startLine); continue; }
    if (ch === '`') { skipTemplate(); push('s', '', startLine); continue; }
    if (ch === '/') {                                            // 나누기 아니면 정규식
      const regexOk = !last || (last.type === 'p' && ![')', ']', '}'].includes(last.v)) || (last.type === 'id' && KW_BEFORE_REGEX.has(last.v));
      if (regexOk) {
        i++;
        let inClass = false;
        while (i < n && c[i] !== '\n') {
          if (c[i] === '\\') { i += 2; continue; }
          if (c[i] === '[') inClass = true; else if (c[i] === ']') inClass = false; else if (c[i] === '/' && !inClass) break;
          i++;
        }
        i++;
        while (i < n && /[a-z]/i.test(c[i])) i++;                // 플래그
        push('s', '', startLine); continue;
      }
    }
    if (ID_START.test(ch)) { let j = i + 1; while (j < n && ID_PART.test(c[j])) j++; push('id', c.slice(i, j), startLine); i = j; continue; }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(c[i + 1] || ''))) { let j = i + 1; while (j < n && /[\w.]/.test(c[j])) { if ((c[j] === 'e' || c[j] === 'E') && (c[j + 1] === '+' || c[j + 1] === '-')) j++; j++; } push('s', '', startLine); i = j; continue; }
    if (ch === '.' && c[i + 1] === '.' && c[i + 2] === '.') { push('p', '...', startLine); i += 3; continue; }
    push('p', ch, startLine); i++;
  }
  return T;
}

function topLevelDecls(code) {
  const T = tokenize(code);
  // 괄호 짝 찾기 (match[열린 위치] = 닫힌 위치). 짝이 안 맞으면 스캐너가 JS 를 잘못 읽은 것
  const match = new Array(T.length).fill(-1), stack = [];
  const depthAt = new Array(T.length).fill(0);
  const OPEN = { '(': ')', '[': ']', '{': '}' };
  let depth = 0;
  for (let k = 0; k < T.length; k++) {
    const t = T[k];
    if (t.type === 'p' && OPEN[t.v]) { depthAt[k] = depth; stack.push(k); depth++; }
    else if (t.type === 'p' && (t.v === ')' || t.v === ']' || t.v === '}')) {
      depth--;
      const o = stack.pop();
      if (o === undefined || OPEN[T[o].v] !== t.v) throw new Error(`괄호 짝이 안 맞아요 (줄 ${t.line})`);
      match[o] = k; depthAt[k] = depth;
    } else depthAt[k] = depth;
  }
  if (stack.length) throw new Error(`닫히지 않은 괄호가 있어요 (줄 ${T[stack[0]].line})`);

  const isP = (t, v) => !!t && t.type === 'p' && t.v === v;
  const isOpener = t => !!t && t.type === 'p' && !!OPEN[t.v];
  const skipExpr = (q, stop) => { while (q < stop && !isP(T[q], ',')) q = isOpener(T[q]) ? match[q] + 1 : q + 1; return q; };   // 기본값 식 건너뛰기
  function target(p) {                                           // 바인딩 대상: 이름 / [배열 패턴] / {객체 패턴} → [이름들, 다음 위치]
    const t = T[p];
    if (!t) return [[], p];
    if (t.type === 'id') return [[t.v], p + 1];
    if (isP(t, '[') || isP(t, '{')) {
      const close = match[p], names = [], obj = t.v === '{';
      let q = p + 1;
      while (q < close) {
        if (isP(T[q], ',')) { q++; continue; }
        if (isP(T[q], '...')) { q++; const [ns, nq] = target(q); names.push(...ns); q = nq; continue; }
        if (obj) {                                               // { key, key: 대상, key = 기본값, [계산된키]: 대상 }
          const keyTok = T[q];
          q = isP(keyTok, '[') ? match[q] + 1 : q + 1;
          if (isP(T[q], ':')) { const [ns, nq] = target(q + 1); names.push(...ns); q = nq; }
          else if (keyTok.type === 'id') names.push(keyTok.v);
        } else { const [ns, nq] = target(q); names.push(...ns); q = nq; }
        if (isP(T[q], '=')) q = skipExpr(q + 1, close);
      }
      return [names, close + 1];
    }
    return [[], p + 1];
  }

  const found = [];
  const statementStart = k => {                                  // k 번째 토큰이 문장의 시작인가
    const prev = T[k - 1];
    if (!prev) return true;
    if (isP(prev, ';') || isP(prev, '}')) return true;
    return T[k].line > prev.line && (prev.type !== 'p' || prev.v === ')' || prev.v === ']');   // 세미콜론 없이 줄바꿈으로 끝난 문장 (ASI)
  };
  let k = 0;
  while (k < T.length) {
    const t = T[k];
    if (depthAt[k] !== 0 || t.type !== 'id') { k++; continue; }
    if ((t.v === 'const' || t.v === 'let' || t.v === 'var') && !isP(T[k - 1], '.')) {
      let q = k + 1;
      for (;;) {                                                 // 선언자들: a = 1, { b, c } = x, [d] = y
        const [names, nq] = target(q);
        for (const nm of names) found.push({ name: nm, kind: t.v, line: T[k].line });
        q = nq;
        if (isP(T[q], '=')) {                                    // 초기값 식은 , ; 가 깊이 0 에 나올 때까지 건너뜀
          q++;
          while (q < T.length && !isP(T[q], ',') && !isP(T[q], ';')) {
            if (isOpener(T[q])) { q = match[q] + 1; continue; }
            const u = T[q];
            if (u.type === 'id' && (u.v === 'const' || u.v === 'let' || u.v === 'var' || u.v === 'function' || u.v === 'class') && statementStart(q)) break;   // 세미콜론 없는 다음 문장
            q++;
          }
        }
        if (isP(T[q], ',')) { q++; continue; }
        break;
      }
      k = Math.max(q, k + 1);
      continue;
    }
    if ((t.v === 'function' || t.v === 'class') && (statementStart(k) || (T[k - 1] && T[k - 1].type === 'id' && T[k - 1].v === 'async' && statementStart(k - 1)))) {
      let q = k + 1;
      if (isP(T[q], '*')) q++;
      if (T[q] && T[q].type === 'id') found.push({ name: T[q].v, kind: t.v, line: T[k].line });
    }
    k++;
  }
  return found;
}

// ---------------------------------------------------------------------------
// <script> 검사
// ---------------------------------------------------------------------------
const SCRIPT_TAG = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const PLAIN_JS_TYPE = /^\s*type\s*=\s*["']?(?:text|application)\/javascript["']?\s*$/i;   // 속성 없는 <script> 와 똑같이 동작하는 유일한 형태
const scripts = [];                                              // [{ file, body, lineOffset }] — include 순서(= 실행 순서)

function checkScripts(name, text) {
  // 1) <script> 태그가 짝이 맞는지 (JS 문자열 안의 '</script>' 는 Apps Script 에서도 페이지를 깨뜨림)
  const opens = (text.match(/<script[\s>]/gi) || []).length;
  const closes = (text.match(/<\/script\s*>/gi) || []).length;
  if (opens !== closes) fail(`${name}.html: <script> 여는 태그 ${opens}개 / 닫는 태그 ${closes}개 — 짝이 안 맞아요`);
  for (const m of text.matchAll(SCRIPT_TAG)) {
    const attrs = m[1], body = m[2];
    const lineOffset = (text.slice(0, m.index + 7 + attrs.length + 1).match(/\n/g) || []).length;   // 본문 첫 줄이 이 html 파일의 몇 번째 줄인지 (0부터)
    // 2) 속성이 붙은 <script> 는 Apps Script/브라우저가 다르게 처리할 수 있어서 쓰지 않아요 (type="text/javascript" 는 같은 뜻이라 허용)
    const attributed = attrs.trim() !== '' && !PLAIN_JS_TYPE.test(attrs);
    if (attributed) {
      fail(`${name}.html: <script${attrs}> — 속성이 붙은 script 태그는 쓰지 않아요 (Apps Script 가 다르게 처리할 수 있어요: src 는 외부 파일, type="module" 은 전역이 공유되지 않아 파일끼리 서로를 못 찾고, async/defer 는 실행 순서가 바뀌어요). 속성 없는 <script> 로 써 주세요`);
      continue;
    }
    // 3) 각 <script> 안 JS 문법 검사 (실행하지 않고 컴파일만, 줄 번호는 html 파일 기준)
    try { new vm.Script(body, { filename: `${name}.html`, lineOffset }); }
    catch (e) { fail(`${name}.html: ${String(e.stack).split('\n').slice(0, 4).join(' | ')}`); continue; }
    scripts.push({ file: name, body, lineOffset });
  }
}

// 여러 파일을 합쳐서 보는 검사: 최상위 이름 충돌
function checkGlobals() {
  const owners = new Map();                                      // 이름 → [{ file, kind, line }]
  for (const s of scripts) {
    let decls;
    try { decls = topLevelDecls(s.body); }
    catch (e) { fail(`${s.file}.html: 최상위 이름을 읽다가 실패했어요 (tools/build-local.mjs 의 스캐너가 이 코드를 해석하지 못함): ${e.message}`); continue; }
    for (const d of decls) {
      if (!owners.has(d.name)) owners.set(d.name, []);
      owners.get(d.name).push({ file: s.file, kind: d.kind, line: d.line + s.lineOffset });
    }
  }
  let dup = 0;
  for (const [nm, list] of owners) {
    const files = [...new Set(list.map(o => o.file))];
    if (files.length > 1) {
      dup++;
      fail(`최상위 이름 '${nm}' 이(가) 여러 파일에 선언돼 있어요: ${list.map(o => `${o.file}.html:${o.line} (${o.kind})`).join(', ')} — 브라우저에서는 두 번째 const/let/class 선언부터 그 파일이 통째로 실행되지 않고(함수는 조용히 덮어써져요), 게임이 깨져요. 한쪽 이름을 바꿔 주세요`);
    }
    if (GLOBAL_LOCKED.has(nm)) fail(`최상위 이름 '${nm}' 은(는) 브라우저가 이미 쓰는 전역 이름이라 다시 선언할 수 없어요: ${list.map(o => `${o.file}.html:${o.line}`).join(', ')}`);
  }
  if (dup) return;
  // 안전망: 스캐너가 놓친 충돌이 있더라도 V8 이 직접 잡도록, 전부 이어 붙여서 한 번 더 컴파일해 봐요
  //   (파일마다 'use strict' 가 따로 적용되는 브라우저와 같게 하려고 맨 앞 지시문은 지우고 — 줄 번호는 그대로 — 문법 오류는 위의 파일별 검사가 이미 맡았어요)
  const segs = [];
  let text = '', ln = 0;
  for (const s of scripts) {
    const b = s.body.replace(/^(\s*)(['"])use strict\2;?/, (m, sp) => sp + ' '.repeat(m.length - sp.length));
    segs.push({ file: s.file, from: ln + 1, lineOffset: s.lineOffset });
    text += b + '\n'; ln += b.split('\n').length;
  }
  try { new vm.Script(text, { filename: 'all-scripts.js' }); }
  catch (e) {
    const m = /all-scripts\.js:(\d+)/.exec(String(e.stack));
    let where = '';
    if (m) { const L = Number(m[1]); const seg = [...segs].reverse().find(s => s.from <= L); if (seg) where = ` (${seg.file}.html:${L - seg.from + 1 + seg.lineOffset})`; }
    fail(`모든 <script> 를 이어 붙여 보니 오류가 나요${where}: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// 조립
// ---------------------------------------------------------------------------
const indexPath = resolve(srcDir, 'index.html');
if (!existsSync(indexPath)) { console.error('src/index.html 이 없어요'); process.exit(1); }

const indexText = readFileSync(indexPath, 'utf8');
const seenInclude = new Map();                                   // 이름 → index.html 에 나온 횟수
for (const m of indexText.matchAll(INCLUDE)) seenInclude.set(m[1], (seenInclude.get(m[1]) || 0) + 1);
for (const [nm, cnt] of seenInclude) if (cnt > 1) fail(`include('${nm}') 가 index.html 에 ${cnt}번 들어 있어요 — 같은 코드가 두 번 실행돼서 const 가 다시 선언되고 게임이 깨져요`);
// 실행 순서: js_core(공통 커널)가 맨 먼저, js_main(부팅)이 맨 마지막이어야 해요 — 다른 모듈은 core 의 이름을 쓰고, main 은 모든 모듈이 로드된 뒤에 Loop.start() 를 불러요
const jsOrder = [...indexText.matchAll(INCLUDE)].map(m => m[1]).filter(nm => /^js_/.test(nm));
if (jsOrder.includes('js_core') && jsOrder[0] !== 'js_core') fail(`include('js_core') 가 맨 먼저 와야 해요 (지금은 '${jsOrder[0]}' 가 먼저) — 다른 모듈이 core 의 Game/Entities 같은 이름을 쓰는데 아직 없으면 게임이 깨져요`);
if (jsOrder.includes('js_main') && jsOrder[jsOrder.length - 1] !== 'js_main') fail(`include('js_main') 이 맨 마지막이어야 해요 (지금은 '${jsOrder[jsOrder.length - 1]}' 가 마지막) — main 은 모든 모듈이 로드된 뒤에 Loop.start() 를 불러요`);
if (/<script\b/i.test(indexText.replace(INCLUDE, ''))) fail('index.html 에 <script> 가 직접 들어 있어요 — 코드는 src/js_*.html 로 분리해서 include 해 주세요');
// index.html 에서 빠진 파일: src 에 있는데 include 되지 않은 *.html (실수로 지워졌거나 새 파일을 안 붙인 경우)
for (const f of readdirSync(srcDir).filter(f => /\.html$/.test(f) && f !== 'index.html').sort()) {
  const nm = f.replace(/\.html$/, '');
  if (!seenInclude.has(nm)) fail(`src/${f} 이(가) index.html 에서 include 되지 않았어요 — <?!= include('${nm}') ?> 가 빠졌나요? (이 파일은 게임에 들어가지 않아요)`);
}

const html = indexText.replace(INCLUDE, (m, name) => {
  const p = resolve(srcDir, name + '.html');
  if (!existsSync(p)) { fail(`include('${name}') — src/${name}.html 파일이 없어요`); return ''; }
  const text = readFileSync(p, 'utf8');
  checkScripts(name, text);
  return text;
});

checkGlobals();

if (/<\?/.test(html)) fail('빌드 결과에 처리되지 않은 <? 스크립틀릿이 남아 있어요 (JS 문자열 안의 "<?" 도 Apps Script 템플릿을 깨뜨릴 수 있어요)');

if (problems) {
  console.error(checkMode ? `\n검사 실패 — src/ 자체에 문제 ${problems}개` : `\n빌드 실패 — 문제 ${problems}개 (출력 파일은 만들지 않았어요)`);
  process.exit(1);
}

if (checkMode) {
  // 이미 만들어 둔 결과물(배포용으로 커밋하는 dist/index.html)이 지금 src/ 로 빌드한 것과 똑같은지 비교
  if (!existsSync(out)) { console.error(`✗ ${rel(out)} 이(가) 없어요 — 'npm run build' 로 만들어 주세요`); process.exit(1); }
  const have = readFileSync(out, 'utf8');
  if (have !== html) {
    const a = have.split('\n'), b = html.split('\n');
    let d = 0; while (d < a.length && d < b.length && a[d] === b[d]) d++;
    console.error(`✗ ${rel(out)} 이(가) 최신이 아니에요 — src/ 를 고친 뒤 다시 빌드하지 않았어요 (${d + 1}번째 줄부터 달라요: 지금 ${have.length}자, src 로 빌드하면 ${html.length}자).`);
    console.error(`  → 'npm run build' 를 실행한 다음 다시 해 주세요. (dist/index.html 은 Apps Script 에 복사해서 쓰는 파일이라 항상 src/ 와 같아야 해요)`);
    process.exit(1);
  }
  console.log(`✓ ${rel(out)} 이(가) src/ 로 새로 빌드한 것과 똑같아요`);
  process.exit(0);
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(`✓ ${rel(out)}  (${(html.length / 1024).toFixed(1)} KB)`);
