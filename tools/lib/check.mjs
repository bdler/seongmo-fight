// 아주 작은 테스트 도우미: check(이름, 조건, 부가설명) 로 기록하고 finish() 로 요약 + 종료 코드 결정
const results = [];
export function check(name, ok, extra = '') {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra !== '' ? '  — ' + extra : ''}`);
  return !!ok;
}
export function finish(label = '') {
  const failed = results.filter(r => !r).length;
  console.log(`\n${label ? label + ': ' : ''}${results.length - failed}/${results.length} 통과${failed ? `, ${failed} 실패` : ''}`);
  process.exit(failed ? 1 : 0);
}
