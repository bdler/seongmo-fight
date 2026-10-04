// 헤드리스 Chromium 으로 게임을 여는 테스트 도우미.
//   const { page, errors, close } = await openGame();      // 기본: dist/index.html (환경변수 GAME_HTML 로 변경)
//   await step(page, 60);                                    // Loop.step(60) — 60프레임을 결정적으로 진행
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
 * opts: { file, manual=true, touch=false, viewport={width:1280,height:720}, waitForLoop=true }
 * errors 배열에는 pageerror / console.error 가 모인다 (테스트 끝에 비어 있어야 함)
 */
export async function openGame(opts = {}) {
  const browser = await launch();
  const context = await browser.newContext({
    viewport: opts.viewport || { width: 1280, height: 720 },
    hasTouch: !!opts.touch, isMobile: false,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
  // 외부 요청(Google Fonts 등)은 빈 응답으로 — 네트워크 없이도 빠르고 에러 없이 로드
  await page.route(/^https?:/, r => r.fulfill({ status: 200, contentType: r.request().resourceType() === 'stylesheet' ? 'text/css' : 'text/plain', body: '' }));
  await page.goto(gameUrl(opts.file), { waitUntil: 'domcontentloaded' });
  if (opts.waitForLoop !== false) {
    await page.waitForFunction(() => typeof Loop !== 'undefined' && Loop.started === true, null, { timeout: 8000 });
    if (opts.manual !== false) await page.evaluate(() => { Loop.manual = true; });
  }
  return { browser, context, page, errors, close: () => browser.close() };
}

export const step = (page, n = 1) => page.evaluate(k => Loop.step(k), n);
