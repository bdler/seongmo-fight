// 헤드리스 Chromium 으로 게임을 여는 테스트 도우미.
//   const { page, errors, close } = await openGame();      // 기본: dist/index.html (환경변수 GAME_HTML 로 변경)
//   await step(page, 60);                                    // Loop.step(60) — 60프레임을 결정적으로 진행
//   const g = await openGame({ rafStub: true });            // requestAnimationFrame 을 가짜로 바꿔, 실제 시간 없이 프레임 타이밍을 흉내 (simulateFrames)
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, readdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const gameUrl = (file = process.env.GAME_HTML || 'dist/index.html') => pathToFileURL(resolve(root, file)).href;

export async function launch() {
  const { chromium } = require('playwright');
  const args = ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'];
  try { return await chromium.launch({ args }); } catch { /* 아래 폴백 */ }
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  const dir = existsSync(base) ? readdirSync(base).find(d => /^chromium-\d+$/.test(d)) : null;
  const executablePath = dir ? resolve(base, dir, 'chrome-linux', 'chrome') : undefined;
  return chromium.launch({ args, executablePath });
}

/**
 * opts: { file, manual=true, touch=false, viewport={width:1280,height:720}, waitForLoop=true,
 *         context={}   — browser.newContext 에 그대로 넘길 옵션 (예: { reducedMotion:'reduce', deviceScaleFactor:2 }),
 *         init=null    — 페이지 스크립트보다 먼저 실행할 함수 (addInitScript),
 *         rafStub=false — true 면 requestAnimationFrame 을 "마지막 콜백만 기억하는 가짜"로 바꿈 (simulateFrames 로 프레임을 직접 먹임) }
 * errors 배열에는 pageerror / console.error 가 모인다 (테스트 끝에 비어 있어야 함)
 */
export async function openGame(opts = {}) {
  const browser = await launch();
  const context = await browser.newContext({
    viewport: opts.viewport || { width: 1280, height: 720 },
    hasTouch: !!opts.touch, isMobile: false,
    ...(opts.context || {}),
  });
  const page = await context.newPage();
  if (opts.rafStub) await page.addInitScript(() => { window.__rafCb = null; window.requestAnimationFrame = cb => { window.__rafCb = cb; return 1; }; });
  if (opts.init) await page.addInitScript(opts.init);
  const errors = [];
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
  // 외부 요청(Google Fonts 등)은 빈 응답으로 — 네트워크 없이도 빠르고 에러 없이 로드
  await page.route(/^https?:/, r => r.fulfill({ status: 200, contentType: r.request().resourceType() === 'stylesheet' ? 'text/css' : 'text/plain', body: '' }));
  await page.goto(gameUrl(opts.file), { waitUntil: 'domcontentloaded' });
  if (opts.waitForLoop !== false) {
    await page.waitForFunction(() => typeof Loop !== 'undefined' && Loop.started === true, null, { timeout: 8000, polling: 50 });   // (기본 raf 폴링은 rafStub 일 때 멈춰 버림)
    if (opts.manual !== false) await page.evaluate(() => { Loop.manual = true; });
  }
  return { browser, context, page, errors, close: () => browser.close() };
}

export const step = (page, n = 1) => page.evaluate(k => Loop.step(k), n);

/**
 * 실제 시간 없이 "화면 주사율 hz 로 seconds 초" 동안의 requestAnimationFrame 콜백을 게임 루프(Loop.start 의 frame)에 먹여서 틱 수를 잰다.
 * (openGame({ rafStub: true }) 로 연 페이지에서만. 시작할 때 Loop.manual 로 한 번 맞춰서 acc/drift 를 0 으로 만들고, 끝나면 Loop.manual = true 로 되돌림)
 *   jitter: 각 프레임 시각에 ±jitter ms 의 (제한된) 흔들림을 더함 — 실제 화면 주기 + 시각 측정 오차를 흉내
 *   gaps: [{ at: 프레임 번호, ms: 그 프레임 앞에서 추가로 멈춘 시간 }]
 * 반환: { frames, ticks, seconds, rate(초당 틱), perFrame(프레임마다 돈 틱 수 배열) }
 */
export function simulateFrames(page, { hz = 60, seconds = 10, jitter = 0, gaps = [] } = {}) {
  return page.evaluate(({ hz, seconds, jitter, gaps }) => {
    const T = 1000 / hz, n = Math.round(hz * seconds);
    const base = performance.now();
    Loop.manual = true; window.__rafCb(base);               // lastTs 맞추고 acc/drift 초기화
    Loop.manual = false;
    let seed = 12345; const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1;
    const per = []; let extra = 0; const t0 = Loop.tickCount;
    const gapAt = new Map(gaps.map(g => [g.at, g.ms]));
    for (let k = 1; k <= n; k++) {
      if (gapAt.has(k)) extra += gapAt.get(k);
      const now = base + k * T + extra + (jitter ? rnd() * jitter : 0);
      const before = Loop.tickCount; window.__rafCb(now); per.push(Loop.tickCount - before);
    }
    Loop.manual = true;
    const ticks = Loop.tickCount - t0, secs = (n * T + extra) / 1000;
    return { frames: n, ticks, seconds: secs, rate: ticks / secs, perFrame: per };
  }, { hz, seconds, jitter, gaps });
}
