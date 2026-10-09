import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { clearAllLivePins, getIframe, seedLivePin } from './livemode-helpers';

// CRIT-05.8: #c_<id> and comment IDs in comment text work in live mode.

const ANCHOR = {
  pathname: '/',
  css_selector: '#primary-btn',
  tag_chain: ['BUTTON'],
  accessible_name: 'Primary',
  role: 'button',
  outer_html: '<button id="primary-btn">Primary</button>',
};

async function openLive(page: Page, hash = '') {
  await page.goto('/live' + hash);
  await expect(page.locator('#critLiveIframe')).toBeVisible({ timeout: 15_000 });
}

function row(page: Page, id: string): Locator {
  return page.locator(`#commentsPanel [data-comment-id="${id}"]`).first();
}

// Fillers so that the last pin's row starts below the panel fold.
async function seedFillers(request: APIRequestContext) {
  for (let i = 0; i < 14; i++) {
    await seedLivePin(request, `Filler pin ${i}\n\nwith a second paragraph to take some room`, ANCHOR);
  }
}

async function expectPanelJumpedTo(page: Page, id: string) {
  await expect(page.locator('#commentsPanel')).not.toHaveClass(/comments-panel-hidden/);
  const target = row(page, id);
  await expect(target).toHaveClass(/crit-live-thread-highlight/);
  await expect(target).toBeInViewport();
  await expect(getIframe(page).locator('#primary-btn')).toHaveClass(/crit-live-pending-highlight/);
}

test.describe('live mode — jump to a comment by ID', () => {
  test.beforeEach(async ({ request }) => {
    await clearAllLivePins(request);
  });

  test('CRIT-05.8 opening /live#<id> opens the panel, scrolls to the comment and highlights it', async ({ page, request }) => {
    const other = await seedLivePin(request, 'Second target', ANCHOR);
    await seedFillers(request);
    const pin = await seedLivePin(request, 'Pinned target', ANCHOR);
    await openLive(page);
    await expect(page.locator(`.comment-card[data-id="${pin.id}"]`)).toHaveCount(1);
    await expect(row(page, pin.id)).not.toBeInViewport();
    // Start with the panel closed (the choice is remembered for this review).
    await page.locator('.comments-panel-close').click();
    await expect(page.locator('#commentsPanel')).toHaveClass(/comments-panel-hidden/);
    // A fresh load, not a same-document hash change.
    await page.goto('about:blank');
    await openLive(page, '#' + pin.id);
    await expectPanelJumpedTo(page, pin.id);

    // Changing the address later jumps again without a reload.
    await expect(row(page, other.id)).not.toBeInViewport();
    await page.evaluate((h) => { window.location.hash = h; }, '#' + other.id);
    await expect(row(page, other.id)).toHaveClass(/crit-live-thread-highlight/);
    await expect(row(page, other.id)).toBeInViewport();
  });

  test('CRIT-05.8 an ID in another comment is a link to that comment', async ({ page, request }) => {
    const src = await seedLivePin(request, 'placeholder', ANCHOR);
    await seedFillers(request);
    const pin = await seedLivePin(request, 'Pinned target', ANCHOR);
    const res = await request.put(`/api/comment/${src.id}?path=${encodeURIComponent('/')}`, { data: { body: `See ${pin.id} and c_000000` } });
    expect(res.ok()).toBeTruthy();
    await openLive(page);
    const links = page.locator(`.comment-card[data-id="${src.id}"] a.comment-ref`);
    await expect(links).toHaveText([pin.id]);
    await expect.poll(() => page.evaluate(() => {
      const log = (window as unknown as { __critLiveMessages?: { type: string }[] }).__critLiveMessages;
      return Array.isArray(log) && log.some((e) => e.type === 'agent-ready');
    }), { timeout: 15_000 }).toBe(true);
    await expect(row(page, pin.id)).not.toBeInViewport();
    await links.first().click();
    await expectPanelJumpedTo(page, pin.id);
  });
});
