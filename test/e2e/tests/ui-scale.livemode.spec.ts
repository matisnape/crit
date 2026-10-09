import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  clearAllLivePins, getIframe, getMarkerCount, openPinComposerNoNav, waitForAgentReady, PIN_TARGET,
} from './livemode-helpers';

// Interface scale (CRIT-03) in live mode: crit's own chrome is zoomed, the
// reviewed page inside the frame is not.

// Rendered size over layout size: the zoom an element is actually shown at.
async function shownAt(target: Locator) {
  return target.evaluate(el => el.getBoundingClientRect().width / (el as HTMLElement).offsetWidth);
}

async function openSettings(page: Page) {
  await expect(async () => {
    await page.locator('#settingsToggle').click();
    await expect(page.locator('#settingsPane')).toBeVisible({ timeout: 1000 });
  }).toPass();
}

test.describe('Interface scale in live mode', () => {
  test.beforeEach(async ({ request }) => {
    await clearAllLivePins(request);
    await expect(await request.patch('/api/ui-settings', { data: { scale: 80 } })).toBeOK();
  });

  test('CRIT-03.5 at 80% the chrome shrinks, the reviewed page keeps its size, and a pin lands on the clicked element', async ({ page, request }) => {
    await waitForAgentReady(page);

    expect(await shownAt(page.locator('.header #settingsToggle'))).toBeCloseTo(0.8, 1);
    expect(await shownAt(page.locator('#commentsPanel'))).toBeCloseTo(0.8, 1);
    await openSettings(page);
    expect(await shownAt(page.locator('#settingsOverlay .settings-dialog'))).toBeCloseTo(0.8, 1);
    await expect(page.getByLabel('Interface scale')).toHaveValue('80');
    await page.keyboard.press('Escape');

    // The frame and the page in it are at 100%.
    expect(await shownAt(page.locator('#critLiveIframe'))).toBeCloseTo(1, 2);
    const target = getIframe(page).locator(PIN_TARGET);
    const shown = (await target.boundingBox())!;
    const layout = await target.evaluate(el => (el as HTMLElement).offsetWidth);
    expect(shown.width / layout).toBeCloseTo(1, 2);

    await openPinComposerNoNav(page, PIN_TARGET);
    await page.locator('.crit-live-composer-body').fill('Scaled pin');
    await page.locator('.crit-live-composer-save').click();
    await expect(page.locator('.crit-live-composer')).toHaveCount(0);
    await expect.poll(() => getMarkerCount(page)).toBe(1);

    const pins = await (await request.get('/api/file/comments?path=%2F')).json();
    expect(pins.map((c: { dom_anchor: { css_selector: string } }) => c.dom_anchor.css_selector)).toEqual([PIN_TARGET]);
    // The marker sits on the element that was clicked.
    const marker = (await getIframe(page).locator('.crit-live-marker').boundingBox())!;
    const box = (await target.boundingBox())!;
    expect(marker.x + marker.width).toBeGreaterThan(box.x - 1);
    expect(marker.x).toBeLessThan(box.x + box.width + 1);
    expect(marker.y + marker.height).toBeGreaterThan(box.y - 1);
    expect(marker.y).toBeLessThan(box.y + box.height + 1);
  });
});
