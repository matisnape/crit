import { test, expect, type Locator, type APIRequestContext } from '@playwright/test';
import { clearAllComments, loadPage, mdSection, switchToDocumentView, addComment, getMdPath } from './helpers';

// CRIT-01: hovering a comment's header time shows the full local timestamp
// (YYYY-MM-DD HH:MM:SS, 24h) as a native title tooltip.
test.use({ timezoneId: 'Europe/Warsaw' });

const FULL = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/;

// Expected title computed from the server's created_at in the page's own
// (Europe/Warsaw) time zone, so the assertion is exact rather than a shape match.
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
  expect(title).toMatch(FULL);
  expect(title).toBe(await expectedTitle(time, iso));
  // Visible text stays the short time of day, without the date.
  const text = (await time.textContent()) || '';
  expect(text.trim()).not.toBe('');
  expect(text).not.toContain(title!.slice(0, 10));
}

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
  return { comment, reply, review };
}

test.describe('Comment timestamp tooltip — Git Mode', () => {
  test.beforeEach(async ({ request }) => {
    await clearAllComments(request);
  });

  test('CRIT-01.1 line comment, reply and review-level comment show the full local time on hover', async ({ page, request }) => {
    const { comment, reply, review } = await seed(request);
    await loadPage(page);
    await switchToDocumentView(page);
    const section = await mdSection(page);

    await expectTooltip(section.locator('.comment-card .comment-time').first(), comment.created_at);
    await expectTooltip(section.locator('.comment-reply .reply-time').first(), reply.created_at);
    await expectTooltip(page.locator('#reviewConversation .comment-card .comment-time').first(), review.created_at);
  });
});
