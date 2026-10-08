import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { clearAllComments, loadPage, mdSection, switchToDocumentView, addComment, getMdPath } from './helpers';

// CRIT-04: every comment, review-level comment and reply shows its ID in the
// header; clicking it (or Enter on it) copies exactly the ID.

async function seed(request: APIRequestContext) {
  const mdPath = await getMdPath(request);
  const comment = await addComment(request, mdPath, 1, 'line comment');
  const replyRes = await request.post(`/api/comment/${comment.id}/replies?path=${encodeURIComponent(mdPath)}`, {
    data: { body: 'a reply', author: 'agent' },
  });
  expect(replyRes.status()).toBe(201);
  const reply = await replyRes.json();
  const reviewRes = await request.post('/api/comments', { data: { body: 'review-level comment' } });
  expect(reviewRes.ok()).toBeTruthy();
  const review = await reviewRes.json();
  return { mdPath, comment, reply, review };
}

async function openSeeded(page: Page, request: APIRequestContext) {
  const ids = await seed(request);
  await loadPage(page);
  await switchToDocumentView(page);
  const section = await mdSection(page);
  return { ...ids, section };
}

// Errors raised after load (not fixture noise from boot).
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  return errors;
}

async function expectIdShown(btn: Locator, id: string) {
  await expect(btn).toBeVisible();
  await expect(btn).toHaveText(id);
  // Visible without hovering: not faded out or hidden by a hover-only rule.
  const style = await btn.evaluate((el) => {
    const s = getComputedStyle(el);
    return { opacity: s.opacity, visibility: s.visibility, font: s.fontFamily };
  });
  expect(style.opacity).toBe('1');
  expect(style.visibility).toBe('visible');
  expect(style.font.toLowerCase()).toMatch(/mono|consolas|courier/);
}

test.describe('Comment ID copy — Git Mode', () => {
  test.beforeEach(async ({ request }) => {
    await clearAllComments(request);
  });

  test('CRIT-04.1 line comment, reply and review-level comment show their ID next to the time', async ({ page, request }) => {
    const { comment, reply, review, section } = await openSeeded(page, request);
    await page.mouse.move(0, 0);

    expect(comment.id).toMatch(/^c_/);
    expect(reply.id).toMatch(/^rp_/);
    expect(review.id).toMatch(/^r_/);

    const card = section.locator(`.comment-card[data-comment-id="${comment.id}"]`);
    await expectIdShown(card.locator('.comment-header-left .comment-time + .comment-id-btn'), comment.id);
    await expectIdShown(section.locator(`.comment-reply[data-reply-id="${reply.id}"] .reply-time + .comment-id-btn`), reply.id);
    await expectIdShown(
      page.locator(`#reviewConversation .comment-card[data-comment-id="${review.id}"] .comment-time + .comment-id-btn`),
      review.id,
    );
  });

  test('CRIT-04.2 click and Enter copy exactly the ID, confirm, announce, and leave the comment as is', async ({ page, request, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const { comment, section } = await openSeeded(page, request);
    const card = section.locator(`.comment-card[data-comment-id="${comment.id}"]`);
    const btn = card.locator('.comment-id-btn');
    await expect(btn).toHaveText(comment.id);
    const cardClass = await card.getAttribute('class');

    for (const how of ['click', 'enter'] as const) {
      await page.evaluate(() => navigator.clipboard.writeText('sentinel'));
      // Let the previous confirmation finish so each pass sees the full cycle.
      await expect(btn).toHaveText(comment.id);
      const started = Date.now();
      if (how === 'click') {
        await btn.click();
      } else {
        await btn.focus();
        await page.keyboard.press('Enter');
      }
      await expect(btn).toHaveText('✓ Copied');
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(comment.id);
      await expect(page.locator('#copyStatus')).toHaveText('Copied ' + comment.id);
      await expect(btn).toHaveText(comment.id, { timeout: 4000 });
      const elapsed = Date.now() - started;
      expect(elapsed, `${how}: confirmation lasted about 1.5s`).toBeGreaterThanOrEqual(1200);
      expect(elapsed).toBeLessThan(3500);

      // No collapse/expand, no edit mode.
      expect(await card.getAttribute('class')).toBe(cardClass);
      await expect(card.locator('textarea')).toHaveCount(0);
      await expect(card.locator('.comment-body')).toBeVisible();
    }
  });

  for (const variant of ['rejects', 'missing'] as const) {
    test(`CRIT-04.6 clipboard ${variant}: no "✓ Copied", failure message with the ID, no console error`, async ({ page, request }) => {
      await page.addInitScript((v) => {
        if (v === 'missing') {
          Object.defineProperty(Navigator.prototype, 'clipboard', { get: () => undefined, configurable: true });
        } else {
          Object.defineProperty(navigator.clipboard, 'writeText', {
            value: () => Promise.reject(new DOMException('denied', 'NotAllowedError')),
          });
        }
      }, variant);
      const { comment, section } = await openSeeded(page, request);
      const errors = collectErrors(page);
      const btn = section.locator(`.comment-card[data-comment-id="${comment.id}"] .comment-id-btn`);
      await btn.click();

      const toast = page.locator('.mini-toast--error');
      await expect(toast).toBeVisible();
      await expect(toast).toContainText(comment.id);
      await expect(toast).toContainText(/could not copy/i);
      await expect(btn).toHaveText(comment.id);
      await expect(page.getByText('✓ Copied')).toHaveCount(0);
      await expect(page.locator('#copyStatus')).not.toHaveText('Copied ' + comment.id);
      expect(errors).toEqual([]);
    });
  }

  test('CRIT-04.5 a comment carried forward into round 2 shows the same ID', async ({ page, request }) => {
    const mdPath = await getMdPath(request);
    const comment = await addComment(request, mdPath, 1, 'carried id');
    const round1 = (await request.get('/api/session').then((r) => r.json())).review_round;

    await loadPage(page);
    await switchToDocumentView(page);
    const round1Text = await (await mdSection(page)).locator(`.comment-card[data-comment-id="${comment.id}"] .comment-id-btn`).first().textContent();
    expect(round1Text).toBe(comment.id);

    await request.post('/api/finish');
    await request.post('/api/round-complete');
    await expect(async () => {
      const s = await request.get('/api/session').then((r) => r.json());
      expect(s.review_round).toBeGreaterThan(round1);
    }).toPass({ timeout: 5000 });

    const carried = (await request.get(`/api/file/comments?path=${encodeURIComponent(mdPath)}`).then((r) => r.json()))
      .find((c: { body: string }) => c.body === 'carried id');
    expect(carried.carried_forward).toBe(true);
    expect(carried.id).toBe(comment.id);

    await loadPage(page);
    await switchToDocumentView(page);
    const card = (await mdSection(page)).locator('.comment-card').filter({ hasText: 'carried id' }).first();
    await expect(card.locator('.comment-round-badge')).toHaveText('R' + round1);
    await expect(card.locator('.comment-id-btn')).toHaveText(comment.id);
  });
});
