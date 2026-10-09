import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { clearAllComments, loadPage, addComment, revealFile, fileHeader, reviewScroller } from './helpers';

// CRIT-05: a comment ID in the address (#c_…, #r_…, #rp_…) or in another
// comment's text jumps to that comment.

const FILE = 'server.go';

async function hunkLines(request: APIRequestContext, path: string): Promise<number[]> {
  const data = await (await request.get(`/api/file/diff?path=${encodeURIComponent(path)}`)).json();
  const hunks = Array.isArray(data) ? data : (data.hunks || []);
  expect(hunks.length).toBeGreaterThan(1);
  return hunks.map((h: { NewStart: number }) => h.NewStart);
}

async function addReply(request: APIRequestContext, path: string, commentId: string, body: string) {
  const res = await request.post(`/api/comment/${commentId}/replies?path=${encodeURIComponent(path)}`, { data: { body } });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

async function addReviewComment(request: APIRequestContext, body: string) {
  const res = await request.post('/api/comments', { data: { body } });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

async function resolve(request: APIRequestContext, path: string, commentId: string) {
  const res = await request.put(`/api/comment/${commentId}/resolve?path=${encodeURIComponent(path)}`, { data: { resolved: true } });
  expect(res.ok()).toBeTruthy();
}

function card(page: Page, id: string): Locator {
  return page.locator(`.main-content .comment-card[data-comment-id="${id}"]`);
}

function reply(page: Page, id: string): Locator {
  return page.locator(`.main-content .comment-reply[data-reply-id="${id}"]`);
}

// Flashed, and on screen below the sticky header.
async function expectJumpedTo(target: Locator) {
  await expect(target).toHaveClass(/comment-ref-flash/);
  await expect.poll(() => target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const header = document.querySelector('.header');
    const top = header ? header.getBoundingClientRect().bottom : 0;
    return r.height > 0 && r.top >= top && r.top < window.innerHeight;
  })).toBe(true);
}

async function scrollToTop(page: Page) {
  await reviewScroller(page).evaluate((el) => { el.scrollTop = 0; });
}

// A full page load with #<id> (goto from '/' to '/#id' would only change the hash).
async function openFresh(page: Page, id: string) {
  await page.goto('about:blank');
  await page.goto('/#' + id);
  await expect(page.locator('.loading')).toBeHidden({ timeout: 10_000 });
}

async function setHash(page: Page, id: string) {
  await page.evaluate((h) => { window.location.hash = h; }, '#' + id);
}

test.describe('Jump to a comment by ID', () => {
  test.beforeEach(async ({ request }) => {
    await clearAllComments(request);
  });

  test('CRIT-05.2 changing the hash jumps to a comment, a reply and a review comment without reload', async ({ page, request }) => {
    const [line] = await hunkLines(request, FILE);
    const c = await addComment(request, FILE, line, 'Target comment');
    const rp = await addReply(request, FILE, c.id, 'Target reply');
    const r = await addReviewComment(request, 'Target review comment');
    await loadPage(page);
    await page.evaluate(() => { (window as unknown as { __noReload: boolean }).__noReload = true; });
    await scrollToTop(page);

    await setHash(page, c.id);
    await expectJumpedTo(card(page, c.id));
    await setHash(page, rp.id);
    await expectJumpedTo(reply(page, rp.id));
    await setHash(page, r.id);
    await expectJumpedTo(page.locator(`#reviewConversation .comment-card[data-comment-id="${r.id}"]`));
    expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
  });

  test('CRIT-05.1 opening the page with #<id> jumps there and the highlight lasts about 2 seconds', async ({ page, request }) => {
    const [line] = await hunkLines(request, FILE);
    const c = await addComment(request, FILE, line, 'Flash me');
    await loadPage(page);
    await openFresh(page, c.id);
    const target = card(page, c.id);
    await expectJumpedTo(target);
    await expect(target).not.toHaveClass(/comment-ref-flash/, { timeout: 3_000 });
  });

  test('CRIT-05.3 a comment in a file marked viewed is revealed', async ({ page, request }) => {
    const [line] = await hunkLines(request, FILE);
    const c = await addComment(request, FILE, line, 'In a viewed file');
    await loadPage(page);
    await revealFile(page, FILE);
    await fileHeader(page, FILE).locator('.file-header-viewed input').check();
    await expect(card(page, c.id)).toHaveCount(0);
    await scrollToTop(page);
    await setHash(page, c.id);
    await expectJumpedTo(card(page, c.id));
  });

  test('CRIT-05.3 a comment in a collapsed file is revealed', async ({ page, request }) => {
    const [line] = await hunkLines(request, FILE);
    const c = await addComment(request, FILE, line, 'In a collapsed file');
    await loadPage(page);
    await revealFile(page, FILE);
    await fileHeader(page, FILE).locator('.file-header-chevron').click();
    await expect(card(page, c.id)).toHaveCount(0);
    await scrollToTop(page);
    await setHash(page, c.id);
    await expectJumpedTo(card(page, c.id));
  });

  test('CRIT-05.3 a resolved, collapsed comment is expanded', async ({ page, request }) => {
    const [line] = await hunkLines(request, FILE);
    const c = await addComment(request, FILE, line, 'Resolved target');
    await resolve(request, FILE, c.id);
    await loadPage(page);
    await setHash(page, c.id);
    const target = card(page, c.id);
    await expectJumpedTo(target);
    await expect(target).not.toHaveClass(/\bcollapsed\b/);
  });

  test('CRIT-05.3 an outdated comment is revealed', async ({ page, request }) => {
    const c = await addComment(request, FILE, 9999, 'Outdated target');
    await loadPage(page);
    await setHash(page, c.id);
    await expectJumpedTo(card(page, c.id));
  });

  test('CRIT-05.3 a reply in a collapsed thread is revealed', async ({ page, request }) => {
    const [line] = await hunkLines(request, FILE);
    const c = await addComment(request, FILE, line, 'Collapsed parent');
    const rp = await addReply(request, FILE, c.id, 'Hidden reply');
    await resolve(request, FILE, c.id);
    await loadPage(page);
    await setHash(page, rp.id);
    await expectJumpedTo(reply(page, rp.id));
    await expect(card(page, c.id)).not.toHaveClass(/\bcollapsed\b/);
  });

  test('CRIT-05.4 an unknown ID shows a message and leaves the page alone', async ({ page }) => {
    await loadPage(page);
    await openFresh(page, 'c_000000');
    await expect(page.locator('.mini-toast')).toHaveText('Comment c_000000 not found in this review');
    expect(await reviewScroller(page).evaluate((el) => el.scrollTop)).toBe(0);
    // The rest of the page still works.
    await revealFile(page, FILE);
  });

  test('CRIT-05.5 IDs in comment text are links that jump and set the address', async ({ page, request }) => {
    const [line, line2] = await hunkLines(request, FILE);
    const c = await addComment(request, FILE, line, 'Target comment');
    const rp = await addReply(request, FILE, c.id, 'Target reply');
    const r = await addReviewComment(request, 'Target review comment');
    const src = await addComment(request, FILE, line2, `See ${c.id}, ${r.id} and ${rp.id}.`);
    await loadPage(page);
    await revealFile(page, FILE);
    const links = card(page, src.id).locator('a.comment-ref');
    await expect(links).toHaveText([c.id, r.id, rp.id]);

    await links.nth(0).click();
    await expectJumpedTo(card(page, c.id));
    await expect(page).toHaveURL(new RegExp(`#${c.id}$`));

    await revealFile(page, FILE);
    await card(page, src.id).locator('a.comment-ref').nth(1).click();
    await expectJumpedTo(page.locator(`#reviewConversation .comment-card[data-comment-id="${r.id}"]`));
    await expect(page).toHaveURL(new RegExp(`#${r.id}$`));

    await revealFile(page, FILE);
    await card(page, src.id).locator('a.comment-ref').nth(2).click();
    await expectJumpedTo(reply(page, rp.id));
    await expect(page).toHaveURL(new RegExp(`#${rp.id}$`));
  });

  test('CRIT-05.6 unknown IDs, IDs inside words and IDs in code stay plain text', async ({ page, request }) => {
    const [line, line2] = await hunkLines(request, FILE);
    const c = await addComment(request, FILE, line, 'Real target');
    const body = `Missing c_000000, glued x${c.id}, code \`${c.id}\`.\n\n\`\`\`\n${c.id}\n\`\`\``;
    const src = await addComment(request, FILE, line2, body);
    await loadPage(page);
    await revealFile(page, FILE);
    const srcCard = card(page, src.id);
    await expect(srcCard).toContainText(`Missing c_000000, glued x${c.id}, code ${c.id}.`);
    await expect(srcCard.locator('.comment-body code')).toHaveCount(2);
    await expect(srcCard.locator('.comment-ref')).toHaveCount(0);
  });
});
