import { test, expect } from '@playwright/test';
import { clearAllLivePins, openPinComposer } from './livemode-helpers';

// CRIT-04.4: live mode (and HTML preview, which loads the same live-mode panel
// scripts) shows comment and reply IDs in panel cards and copies them on click.

test.describe('live-mode comment ID copy', () => {
  test.beforeEach(async ({ request }) => {
    await clearAllLivePins(request);
  });

  test('CRIT-04.4 live pin and its reply show their ID; clicking copies it with the same confirmation', async ({ page, request, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openPinComposer(page);
    await page.locator('.crit-live-composer-body').fill('id pin');
    await page.locator('.crit-live-composer-save').click();
    await expect(page.locator('.crit-live-composer')).toHaveCount(0);

    const rowWrap = page.locator('#commentsPanelBody .crit-live-comment-row-wrap').first();
    const pinId = await rowWrap.locator('.crit-live-comment-row').first().getAttribute('data-comment-id');
    expect(pinId).toMatch(/^c_/);

    const replyRes = await request.post(`/api/comment/${pinId}/replies?path=%2F`, { data: { body: 'id reply' } });
    expect(replyRes.ok()).toBeTruthy();
    const reply = await replyRes.json();

    const pinBtn = rowWrap.locator('.comment-header-left .comment-time + .comment-id-btn').first();
    const replyBtn = rowWrap.locator(`.crit-live-comment-reply[data-reply-id="${reply.id}"] .comment-id-btn`);
    await expect(pinBtn).toHaveText(pinId!);
    await expect(replyBtn).toHaveText(reply.id);
    await expect(pinBtn).toHaveAttribute('aria-label', 'Copy comment ID ' + pinId);

    for (const [btn, id] of [[pinBtn, pinId!], [replyBtn, reply.id]] as const) {
      await btn.click();
      await expect(btn).toHaveText('✓ Copied');
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(id);
      await expect(page.locator('#copyStatus')).toHaveText('Copied ' + id);
      await expect(btn).toHaveText(id, { timeout: 4000 });
    }
  });
});
