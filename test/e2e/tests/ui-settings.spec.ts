import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { stateFilePath } from './state-file';

// Settings-dialog choices live in ~/.crit/ui-settings.json, shared by every
// review on the machine. These tests run their own crit daemons with their
// own temp HOME, so they never touch the git fixture's (or the developer's)
// settings file, and parallel projects never see each other's.

function critBin(): string {
  const raw = fs.readFileSync(stateFilePath(process.env.CRIT_TEST_PORT || '3123'), 'utf8');
  const line = raw.split('\n').find(l => l.startsWith('CRIT_BIN='));
  if (!line) throw new Error('CRIT_BIN not set in state file');
  return line.slice('CRIT_BIN='.length);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

interface Review { proc: ChildProcess; port: number; stderr: () => string }

const running: Review[] = [];
let home = '';
let settingsPath = '';

function tempDir(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// Starts a crit daemon (`crit _serve`) in a fresh directory holding one file.
async function startReview(opts: { file?: string; content?: string; dir?: string; args?: string[] } = {}): Promise<Review> {
  const dir = opts.dir ?? tempDir('crit-ui-settings-review-');
  const file = opts.file ?? 'plan.md';
  fs.writeFileSync(path.join(dir, file), opts.content ?? '# Plan\n\n- one\n- two\n\n```go\nfunc main() { fmt.Println("a really long line that keeps going and going and going and going and going") }\n```\n');
  const port = await freePort();
  let err = '';
  const args = opts.args ?? [file];
  const proc = spawn(critBin(), ['_serve', '--no-open', '--port', String(port), ...args], {
    cwd: dir,
    env: { ...process.env, HOME: home, USERPROFILE: home, CRIT_NO_UPDATE_CHECK: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  proc.stderr!.on('data', d => { err += d.toString(); });
  const review = { proc, port, stderr: () => err };
  running.push(review);
  await expect.poll(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/api/health`)).status; } catch { return 0; }
  }, { timeout: 15_000 }).toBe(200);
  return review;
}

async function stopReview(r: Review) {
  if (r.proc.exitCode !== null) return;
  const exited = new Promise(resolve => r.proc.once('exit', resolve));
  r.proc.kill('SIGTERM');
  await exited;
}

function stored(): Record<string, unknown> | null {
  try { return JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { return null; }
}

// Code-review page, booted far enough that the Settings dialog works.
async function openReview(page: Page, url: string) {
  await page.goto(url);
  await expect(page.locator('#settingsToggle')).toBeVisible();
  await expect(page.locator('[data-line], .line-block').first()).toBeVisible();
}

async function openSettings(page: Page) {
  await expect(async () => {
    await page.locator('#settingsToggle').click();
    await expect(page.locator('#settingsPane [data-settings-theme="dark"]')).toBeVisible({ timeout: 1000 });
  }).toPass();
}

async function closeSettings(page: Page) {
  await page.keyboard.press('Escape');
  await expect(page.locator('#settingsPane [data-settings-theme="dark"]')).toBeHidden();
}


test.beforeEach(() => {
  home = tempDir('crit-ui-settings-home-');
  settingsPath = path.join(home, '.crit', 'ui-settings.json');
});

test.afterEach(async () => {
  await Promise.all(running.splice(0).map(stopReview));
  fs.rmSync(home, { recursive: true, force: true });
});

test('CRIT-02.1 a theme chosen in one review applies to another review on another port and host', async ({ browser }) => {
  const a = await startReview();
  const b = await startReview();
  expect(stored()).toBeNull();
  const ctx = await browser.newContext();
  const pageA = await ctx.newPage();
  const pageB = await ctx.newPage();
  // Different ports and different host names (separate cookie jars).
  await openReview(pageA, `http://localhost:${a.port}/`);
  await openReview(pageB, `http://127.0.0.1:${b.port}/`);

  await openSettings(pageA);
  await pageA.locator('[data-settings-theme="dark"]').click();
  await expect(pageA.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(() => stored()).toEqual({ theme: 'dark' });

  await pageB.reload();
  await expect(pageB.locator('html')).toHaveAttribute('data-theme', 'dark');
  await ctx.close();
});

test('CRIT-02.2 every Settings-dialog choice survives a daemon restart in another directory', async ({ page }) => {
  const first = await startReview();
  await openReview(page, `http://localhost:${first.port}/`);
  await openSettings(page);
  const selects: Record<string, string> = {
    lightPaletteSelect: 'ayu-light',
    darkPaletteSelect: 'nord',
    lineNumbersSelect: 'off',
    boostContrastSelect: 'on',
    codeOverflowSelect: 'wrap',
    inlineDiffSelect: 'char',
    changeIndicatorsSelect: 'classic',
    unchangedContextSelect: 'expanded',
    codeFontSelect: 'system',
  };
  await page.locator('[data-settings-theme="dark"]').click();
  for (const [id, value] of Object.entries(selects)) {
    await page.locator('#' + id).selectOption(value);
  }
  await page.locator('[data-settings-width="wide"]').click();
  await page.locator('#hideResolvedToggle').check({ force: true });
  await page.locator('.settings-tab[data-tab="shortcuts"]').click();
  await page.locator('[data-shortcut-id="next_block"]').click();
  await page.keyboard.press('y');
  await expect(page.locator('[data-shortcut-id="next_block"]')).toHaveClass(/is-customized/);
  await expect.poll(() => stored()).toEqual({
    theme: 'dark', lightPalette: 'ayu-light', darkPalette: 'nord', lineNumbers: 'off', boostContrast: 'on',
    codeOverflow: 'wrap', inlineDiff: 'char', changeIndicators: 'classic', unchangedContext: 'expanded',
    codeFont: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', width: 'wide', hideResolved: true,
    shortcuts: { next_block: 'y' },
  });

  await stopReview(first);
  const second = await startReview();
  await openReview(page, `http://localhost:${second.port}/`);
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await expect(html).toHaveAttribute('data-crit-palette', 'nord');
  await expect(html).toHaveAttribute('data-width', 'wide');
  await expect(html).toHaveAttribute('data-line-numbers', 'off');
  await expect(html).toHaveAttribute('data-code-overflow', 'wrap');
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--crit-font-code'))).toContain('ui-monospace');
  await expect(page.locator('body')).toHaveClass(/hide-resolved/);

  await openSettings(page);
  await expect(page.locator('[data-settings-theme="dark"]')).toHaveAttribute('aria-pressed', 'true');
  for (const [id, value] of Object.entries(selects)) {
    await expect(page.locator('#' + id)).toHaveValue(value);
  }
  await expect(page.locator('[data-settings-width="wide"]')).toHaveClass(/active/);
  await expect(page.locator('#hideResolvedToggle')).toBeChecked();
  await page.locator('.settings-tab[data-tab="shortcuts"]').click();
  await expect(page.locator('[data-shortcut-id="next_block"]')).toHaveClass(/is-customized/);
  await expect(page.locator('[data-shortcut-id="next_block"]')).toContainText('y');
});

test('CRIT-02.3 per-review state stays out of the settings file and out of other reviews', async ({ browser }) => {
  const a = await startReview();
  const b = await startReview();
  const ctx = await browser.newContext();
  const pageA = await ctx.newPage();
  await openReview(pageA, `http://localhost:${a.port}/`);
  // The per-review keys the UI writes for tree width, live panel and tree state.
  await pageA.evaluate(() => {
    const s = (window as any).crit.shared;
    s.setSetting('fileTreeWidth', 333);
    s.setSetting('live_commentsPanelWidth', 444);
    s.setSetting('live_commentsPanelOpen', false);
    s.setSetting('fileTree', 'collapsed');
  });
  // A Settings choice in the same session does create the file.
  await openSettings(pageA);
  await pageA.locator('[data-settings-theme="dark"]').click();
  await expect.poll(() => stored()).toEqual({ theme: 'dark' });

  const pageB = await ctx.newPage();
  await openReview(pageB, `http://127.0.0.1:${b.port}/`);
  const inherited = await pageB.evaluate(() => {
    const s = (window as any).crit.shared;
    return ['fileTreeWidth', 'live_commentsPanelWidth', 'live_commentsPanelOpen', 'fileTree'].map(k => s.getSetting(k, null));
  });
  // fileTree is written by the page itself on load ("open"), never inherited.
  expect(inherited).toEqual([null, null, null, 'open']);
  expect(stored()).toEqual({ theme: 'dark' });
  await ctx.close();
});

test('CRIT-02.4 the first load imports the Settings keys of an old cookie, once', async ({ browser }) => {
  const a = await startReview();
  const b = await startReview();
  const ctx = await browser.newContext();
  const cookie = { theme: 'light', lightPalette: 'ayu-light', fileTreeWidth: 300, live_commentsPanelWidth: 420, live_commentsPanelOpen: false };
  await ctx.addCookies([{ name: 'crit-settings', value: encodeURIComponent(JSON.stringify(cookie)), url: `http://localhost:${a.port}` }]);
  const page = await ctx.newPage();
  await openReview(page, `http://localhost:${a.port}/`);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('html')).toHaveAttribute('data-crit-palette', 'ayu-light');
  expect(stored()).toEqual({ theme: 'light', lightPalette: 'ayu-light' });
  const before = fs.readFileSync(settingsPath, 'utf8');

  // Another host's cookie no longer matters once the file exists.
  await ctx.addCookies([{ name: 'crit-settings', value: encodeURIComponent(JSON.stringify({ theme: 'dark', lightPalette: 'github-light-default' })), url: `http://127.0.0.1:${b.port}` }]);
  const other = await ctx.newPage();
  await openReview(other, `http://127.0.0.1:${b.port}/`);
  await expect(other.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
  await ctx.close();
});

test('CRIT-02.5 the first painted frame already uses the stored Dark theme on Slow 3G', async ({ browser }) => {
  test.setTimeout(120_000);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({ theme: 'dark' }));
  const r = await startReview();
  const ctx = await browser.newContext({ colorScheme: 'light' });
  const page = await ctx.newPage();
  // Every data-theme value <html> ever has, and the theme + page background
  // in each of the first animation frames (each runs right before a paint).
  await page.addInitScript(() => {
    const w = window as any;
    w.__themeChanges = [];
    w.__frames = [];
    let last: string | null | undefined;
    const record = () => {
      const el = document.documentElement;
      if (!el) return;
      const v = el.getAttribute('data-theme');
      if (v !== last) { last = v; w.__themeChanges.push({ theme: v, bodyParsed: !!document.body }); }
    };
    new MutationObserver(record).observe(document, { attributes: true, childList: true, subtree: true });
    const frame = () => {
      const el = document.documentElement;
      w.__frames.push({ theme: el && el.getAttribute('data-theme'), bg: getComputedStyle(document.body || el).backgroundColor });
      if (w.__frames.length < 10) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  // Chrome DevTools' "Slow 3G" preset.
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 2000, downloadThroughput: 50_000, uploadThroughput: 50_000 });
  await page.goto(`http://localhost:${r.port}/`, { waitUntil: 'commit' });
  await page.waitForFunction(() => (window as any).__frames.length >= 3, null, { timeout: 100_000 });
  const { changes, frames } = await page.evaluate(() => ({ changes: (window as any).__themeChanges, frames: (window as any).__frames }));
  // data-theme goes straight to dark, while <head> is still being parsed.
  expect(changes.filter((c: { theme: string | null }) => c.theme !== null)).toEqual([{ theme: 'dark', bodyParsed: false }]);
  expect(frames.every((f: { theme: string }) => f.theme === 'dark')).toBe(true);
  // ...and the first frame is painted with the dark page background.
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(frames[0].bg).toBe(darkBg);
  await ctx.close();
});

test('CRIT-02.6 another open tab keeps its theme until it is reloaded', async ({ browser }) => {
  const a = await startReview();
  const b = await startReview();
  const ctx = await browser.newContext({ colorScheme: 'light' });
  const first = await ctx.newPage();
  const second = await ctx.newPage();
  await openReview(first, `http://localhost:${a.port}/`);
  await openReview(second, `http://localhost:${b.port}/`);
  await openSettings(first);
  await first.locator('[data-settings-theme="dark"]').click();
  await expect.poll(() => stored()).toEqual({ theme: 'dark' });
  await expect(second.locator('html')).not.toHaveAttribute('data-theme', 'dark');
  await second.reload();
  await expect(second.locator('html')).toHaveAttribute('data-theme', 'dark');
  await ctx.close();
});

for (const [name, content] of [
  ['unknown values', '{"theme":"purple","darkPalette":"no-such-palette","lineNumbers":"off"}'],
  ['invalid JSON', '{"theme": "dark", "lineNumbers": "off",'],
]) {
  test(`CRIT-02.7 ${name}: crit starts, valid values apply, one warning, file untouched until a change`, async ({ browser }) => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, content);
    const r = await startReview();
    const ctx = await browser.newContext({ colorScheme: 'dark' });
    const page = await ctx.newPage();
    await openReview(page, `http://localhost:${r.port}/`);
    const html = page.locator('html');
    await expect(html).not.toHaveAttribute('data-theme', /./);
    await expect(html).toHaveAttribute('data-crit-palette', 'tokyo-night');
    await expect(html).toHaveAttribute('data-line-numbers', name === 'invalid JSON' ? 'on' : 'off');
    const warnings = r.stderr().split('\n').filter(l => l.includes(settingsPath));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(name === 'invalid JSON' ? /invalid JSON/ : /theme: "purple".*|darkPalette: "no-such-palette"/);
    await page.reload();
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(content);

    await openSettings(page);
    await page.locator('#codeOverflowSelect').selectOption('wrap');
    await expect.poll(() => stored()).toEqual(name === 'invalid JSON'
      ? { codeOverflow: 'wrap' }
      : { lineNumbers: 'off', codeOverflow: 'wrap' });
    await ctx.close();
  });
}

test('CRIT-02.8 an unwritable settings file keeps the new theme and names the file', async ({ page }) => {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, '{"theme":"light"}');
  fs.chmodSync(settingsPath, 0o444);
  const r = await startReview();
  const pageErrors: Error[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', e => pageErrors.push(e));
  page.on('console', (m: ConsoleMessage) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  await openReview(page, `http://localhost:${r.port}/`);
  await openSettings(page);
  await page.locator('[data-settings-theme="dark"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const toast = page.locator('.mini-toast--error');
  await expect(toast).toContainText('not saved');
  await expect(toast).toContainText(settingsPath);
  expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{"theme":"light"}');
  expect(pageErrors).toEqual([]);
  // The only console line is the browser's own note about the 500 response.
  expect(consoleErrors.filter(t => !/Failed to load resource.*500/.test(t))).toEqual([]);
});

test('CRIT-02.10 settings-like keys in a project config never change the stored settings', async ({ page }) => {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, '{"theme":"dark","darkPalette":"nord"}\n');
  const before = fs.readFileSync(settingsPath, 'utf8');
  const dir = tempDir('crit-ui-settings-project-');
  fs.writeFileSync(path.join(dir, '.crit.config.json'), JSON.stringify({
    theme: 'light', darkPalette: 'dracula', lightPalette: 'ayu-light', ui_settings: { theme: 'light' }, settings: { theme: 'light' },
  }));
  const r = await startReview({ dir });
  await openReview(page, `http://localhost:${r.port}/`);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-crit-palette', 'nord');
  expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
});

test('CRIT-02.11 stale tabs on two reviews each change only their own setting', async ({ browser }) => {
  const a = await startReview();
  const b = await startReview();
  const ctx = await browser.newContext();
  const first = await ctx.newPage();
  const second = await ctx.newPage();
  await openReview(first, `http://localhost:${a.port}/`);
  await openReview(second, `http://localhost:${b.port}/`);

  await openSettings(second);
  await second.locator('#lightPaletteSelect').selectOption('ayu-light');
  await expect.poll(() => stored()).toEqual({ lightPalette: 'ayu-light' });

  // The first tab still holds the old (default) palette in memory.
  await openSettings(first);
  await first.locator('[data-settings-theme="dark"]').click();
  await expect.poll(() => stored()).toEqual({ lightPalette: 'ayu-light', theme: 'dark' });
  await ctx.close();
});

test('CRIT-02.12 HTML preview and code review share the stored theme', async ({ browser }) => {
  const code = await startReview();
  const ctx = await browser.newContext({ colorScheme: 'light' });
  const page = await ctx.newPage();
  await openReview(page, `http://localhost:${code.port}/`);
  await openSettings(page);
  await page.locator('[data-settings-theme="dark"]').click();
  await expect.poll(() => stored()).toEqual({ theme: 'dark' });

  const htmlDir = tempDir('crit-ui-settings-preview-');
  const htmlFile = path.join(htmlDir, 'page.html');
  fs.writeFileSync(htmlFile, '<!doctype html><html><body><h1 id="t">Preview</h1></body></html>');
  const preview = await startReview({ dir: htmlDir, file: 'page.html', content: fs.readFileSync(htmlFile, 'utf8'), args: ['--preview-file', htmlFile] });
  const live = await ctx.newPage();
  await live.goto(`http://localhost:${preview.port}/preview`);
  await expect(live.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(async () => {
    await live.locator('#settingsToggle').click();
    await expect(live.locator('#settingsPane [data-settings-theme="light"]')).toBeVisible({ timeout: 1000 });
  }).toPass();
  await live.locator('#settingsPane [data-settings-theme="light"]').click();
  await expect(live.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect.poll(() => stored()).toEqual({ theme: 'light' });

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await ctx.close();
});
