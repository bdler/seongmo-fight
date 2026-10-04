#!/usr/bin/env node
// 로컬 빌드: src/index.html 의 <?!= include('이름') ?> 를 src/이름.html 로 치환해 단일 HTML 을 만든다.
// (Apps Script 가 서버에서 하는 일을 로컬에서 똑같이 흉내 내는 것 — 결과 파일은 더블클릭으로 바로 실행 가능)
//
// 사용법: node tools/build-local.mjs [--out dist/index.html]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = resolve(root, 'src');
const outIdx = process.argv.indexOf('--out');
const out = resolve(root, outIdx > 0 ? process.argv[outIdx + 1] : 'dist/index.html');

const INCLUDE = /<\?!=\s*include\(\s*['"]([\w-]+)['"]\s*\)\s*\?>/g;
let problems = 0;
const fail = msg => { console.error('✗ ' + msg); problems++; };

function checkScripts(name, text) {
  // 1) <script> 태그가 짝이 맞는지 (JS 문자열 안의 '</script>' 는 Apps Script 에서도 페이지를 깨뜨림)
  const opens = (text.match(/<script[\s>]/g) || []).length;
  const closes = (text.match(/<\/script>/g) || []).length;
  if (opens !== closes) fail(`${name}.html: <script> 여는 태그 ${opens}개 / 닫는 태그 ${closes}개 — 짝이 안 맞아요`);
  // 2) 각 <script> 안 JS 문법 검사 (실행하지 않고 컴파일만)
  for (const m of text.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    try { new vm.Script(m[1], { filename: `${name}.html` }); }
    catch (e) { fail(`${name}.html: ${String(e.stack).split('\n').slice(0, 4).join(' | ')}`); }
  }
}

const indexPath = resolve(srcDir, 'index.html');
if (!existsSync(indexPath)) { console.error('src/index.html 이 없어요'); process.exit(1); }

const html = readFileSync(indexPath, 'utf8').replace(INCLUDE, (m, name) => {
  const p = resolve(srcDir, name + '.html');
  if (!existsSync(p)) { fail(`include('${name}') — src/${name}.html 파일이 없어요`); return ''; }
  const text = readFileSync(p, 'utf8');
  checkScripts(name, text);
  return text;
});

if (/<\?/.test(html)) fail('빌드 결과에 처리되지 않은 <? 스크립틀릿이 남아 있어요 (JS 문자열 안의 "<?" 도 Apps Script 템플릿을 깨뜨릴 수 있어요)');

if (problems) { console.error(`\n빌드 실패 — 문제 ${problems}개 (출력 파일은 만들지 않았어요)`); process.exit(1); }
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(`✓ ${out.replace(root + '/', '')}  (${(html.length / 1024).toFixed(1)} KB)`);
