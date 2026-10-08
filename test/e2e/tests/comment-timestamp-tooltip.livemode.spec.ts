import { test, expect, type Locator } from '@playwright/test';
import { clearAllLivePins, openPinComposer } from './livemode-helpers';

// CRIT-01.2: live mode (and HTML preview, which loads the same live-mode
// panel scripts) shows the same full-local-time tooltip on comment and reply.
test.use({ timezoneId: 'Europe/Warsaw' });

async function expectedTitle(time: Locator, iso: string): Promise<string> {
  return time.evaluate((_el, s) => {
    const d = new Date(s);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }, iso);
}

async function expectTooltip(time: Locator, iso: string) {
  await expect(time).toBeVisible();
  await time.hover();
  const title = await time.getAttribute('title');
  expect(title).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  expect(title).toBe(await expectedTitle(time, iso));
  expect((await time.textContent()) || '').not.toContain(title!.slice(0, 10));
}

test.describe('live-mode comment timestamp tooltip', () => {
  test.beforeEach(async ({ request }) => {
    await clearAllLivePins(request);
  });

  test('CRIT-01.2 live pin and its reply show the full local time on hover', async ({ page, request }) => {
    await openPinComposer(page);
    await page.locator('.crit-live-composer-body').fill('tooltip pin');
    await page.locator('.crit-live-composer-save').click();
    await expect(page.locator('.crit-live-composer')).toHaveCount(0);

    const rowWrap = page.locator('#commentsPanelBody .crit-live-comment-row-wrap').first();
    const pinId = await rowWrap.locator('.crit-live-comment-row').first().getAttribute('data-comment-id');
    expect(pinId).toBeTruthy();

    const replyRes = await request.post(`/api/comment/${pinId}/replies?path=%2F`, { data: { body: 'tooltip reply' } });
    expect(replyRes.ok()).toBeTruthy();
    const reply = await replyRes.json();

    const comments = await (await request.get('/api/file/comments?path=%2F')).json();
    const pin = comments.find((c: { id: string }) => c.id === pinId);
    expect(pin).toBeTruthy();

    await expectTooltip(rowWrap.locator('.comment-time').first(), pin.created_at);
    await expectTooltip(rowWrap.locator('.crit-live-comment-reply .reply-time').first(), reply.created_at);
  });
});
