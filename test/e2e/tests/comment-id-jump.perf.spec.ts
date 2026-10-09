import { test, expect } from '@playwright/test';
import { loadPage, clearAllComments, addComment } from './helpers';

// plan-big.md sorts last in the 301-file perf fixture: far below the visible
// area and past the eager load limit (25), so its diff is not loaded on open.
const TAIL_FILE = 'plan-big.md';

test.beforeEach(async ({ request }) => {
  await clearAllComments(request);
});

test('CRIT-05.1 CRIT-05.3 opening #<id> of a comment in a far, not-yet-loaded file jumps to it', async ({ page, request }) => {
  const c = await addComment(request, TAIL_FILE, 1, 'Far away target');
  await loadPage(page);
  // A full load with the hash, not a same-document hash change.
  await page.goto('about:blank');
  await page.goto('/#' + c.id);
  const target = page.locator(`.main-content .comment-card[data-comment-id="${c.id}"]`);
  await expect(target).toHaveClass(/comment-ref-flash/, { timeout: 15_000 });
  await expect.poll(() => target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const header = document.querySelector('.header');
    const top = header ? header.getBoundingClientRect().bottom : 0;
    return r.height > 0 && r.top >= top && r.top < window.innerHeight;
  })).toBe(true);
});
