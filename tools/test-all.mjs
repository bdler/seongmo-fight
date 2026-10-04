#!/usr/bin/env node
// tools/tests/*.test.mjs 를 하나씩(순서대로) 실행하고 PASS/FAIL 표로 요약합니다.
//
// 사용법:
//   node tools/test-all.mjs                 전부 실행
//   node tools/test-all.mjs --quick         *.slow.test.mjs 는 건너뜀
//   node tools/test-all.mjs core stage      파일 이름에 core / stage 가 들어간 것만
//   node tools/test-all.mjs --verbose       통과한 테스트의 출력도 보여줌
//
// 환경변수는 그대로 자식 프로세스에 넘어가므로 GAME_HTML=dist/_내이름.html 도 그대로 적용됩니다.
// 하나라도 실패(또는 시간 초과)하면 종료 코드 1.
import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testsDir = resolve(root, 'tools', 'tests');
const args = process.argv.slice(2);
const quick = args.includes('--quick');
const verbose = args.includes('--verbose');
const filters = args.filter(a => !a.startsWith('--'));
const TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS) || 180000;   // 한 파일당 최대 시간

let files = [];
try { files = readdirSync(testsDir).filter(f => /\.test\.mjs$/.test(f)).sort(); } catch { /* 폴더 없음 */ }
if (quick) files = files.filter(f => !/\.slow\.test\.mjs$/.test(f));
if (filters.length) files = files.filter(f => filters.some(q => f.includes(q)));
if (!files.length) {
  console.error('실행할 테스트 파일이 없어요 (tools/tests/*.test.mjs)');
  process.exit(1);
}

// 한 파일 실행 → { code, out, ms, timedOut }
function runOne(file) {
  return new Promise(done => {
    const t0 = Date.now();
    let out = '', timedOut = false;
    const child = spawn(process.execPath, [resolve(testsDir, file)], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, TIMEOUT_MS);
    child.on('error', e => { clearTimeout(timer); done({ code: 1, out: out + String(e), ms: Date.now() - t0, timedOut }); });
    child.on('close', code => { clearTimeout(timer); done({ code: timedOut ? 1 : code, out, ms: Date.now() - t0, timedOut }); });
  });
}

const rows = [];
for (const file of files) {
  process.stdout.write(`▶ ${file} ...`);
  const r = await runOne(file);
  const m = [...r.out.matchAll(/(\d+)\/(\d+) 통과/g)].pop();       // check.mjs 의 요약 줄: "N/M 통과"
  const ok = r.code === 0;
  rows.push({ file, ok, timedOut: r.timedOut, passed: m ? Number(m[1]) : null, total: m ? Number(m[2]) : null, ms: r.ms });
  console.log(` ${ok ? 'PASS' : 'FAIL'} (${(r.ms / 1000).toFixed(1)}s)`);
  if (!ok || verbose) {
    const lines = r.out.trimEnd().split('\n');
    const interesting = ok ? lines : lines.filter(l => /^(FAIL|✗|.*Error|.*error)/.test(l)).slice(0, 40);
    const shown = ok ? lines : (interesting.length ? interesting : lines.slice(-30));
    console.log(shown.map(l => '    ' + l).join('\n'));
    if (r.timedOut) console.log(`    (시간 초과: ${TIMEOUT_MS / 1000}초)`);
  }
}

// 요약 표
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - [...String(s)].length));
const nameW = Math.max(12, ...rows.map(r => r.file.length));
console.log('\n' + pad('파일', nameW) + '  결과  통과/전체  시간');
console.log('-'.repeat(nameW + 28));
for (const r of rows) {
  const counts = r.passed === null ? '  -  ' : `${r.passed}/${r.total}`;
  console.log(`${pad(r.file, nameW)}  ${r.ok ? 'PASS' : 'FAIL'}  ${pad(counts, 9)}  ${(r.ms / 1000).toFixed(1)}s${r.timedOut ? ' (시간 초과)' : ''}`);
}
const failed = rows.filter(r => !r.ok).length;
const sumPassed = rows.reduce((n, r) => n + (r.passed || 0), 0), sumTotal = rows.reduce((n, r) => n + (r.total || 0), 0);
console.log('-'.repeat(nameW + 28));
console.log(`합계: 파일 ${rows.length - failed}/${rows.length} 통과, 검사 ${sumPassed}/${sumTotal}${failed ? `  — 실패 ${failed}개` : '  — 모두 통과!'}`);
process.exit(failed ? 1 : 0);
