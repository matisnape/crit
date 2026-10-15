import { test, expect } from '@playwright/test';
import { clearAllComments, loadPage, addComment, getMdPath } from './helpers';

// CRIT-07: header "Approve" resolves every comment and approves the review.
test.describe('Force approve', () => {
  test.beforeEach(async ({ request }) => {
    await clearAllComments(request);
  });

  test('is absent with no comments', async ({ page }) => {
    await loadPage(page);
    await expect(page.locator('#finishBtn')).toHaveText('Approve');
    await expect(page.locator('#forceApproveBtn')).toHaveCount(1);
    await expect(page.locator('#forceApproveBtn')).toBeHidden();
  });

  test('confirm dialog names the count; go back changes nothing; confirm approves', async ({ page, request }) => {
    const mdPath = await getMdPath(request);
    await addComment(request, mdPath, 1, 'one');
    await addComment(request, mdPath, 2, 'two');
    await addComment(request, mdPath, 3, 'three');
    await request.post('/api/comments', { data: { body: 'review level', author: 'me' } });
    await loadPage(page);

    await expect(page.locator('#finishBtn')).toHaveText('Finish Review');
    const force = page.locator('#forceApproveBtn');
    await expect(force).toBeVisible();
    await expect(force).toHaveText('Approve');

    await force.click();
    await expect(page.locator('#forceApproveText')).toContainText('4');
    await page.locator('#forceApproveGoBack').click();
    await expect(page.locator('#forceApproveOverlay')).not.toHaveClass(/active/);
    const before = await request.get(`/api/file/comments?path=${encodeURIComponent(mdPath)}`).then(r => r.json());
    expect(before.every((c: any) => !c.resolved)).toBe(true);

    await force.click();
    await page.locator('#forceApproveConfirm').click();
    await expect(page.locator('#waitingHeading')).toHaveText('Approved');
    const after = await request.get(`/api/file/comments?path=${encodeURIComponent(mdPath)}`).then(r => r.json());
    expect(after.every((c: any) => c.resolved)).toBe(true);
  });

  test('failed resolve-all does not approve and leaves the button usable', async ({ page, request }) => {
    const mdPath = await getMdPath(request);
    await addComment(request, mdPath, 1, 'one');
    await loadPage(page);

    let calls = 0;
    await page.route('**/api/comments/resolve-all', route => {
      calls++;
      return route.fulfill({ status: 500, body: 'boom' });
    });

    await page.locator('#forceApproveBtn').click();
    await page.locator('#forceApproveConfirm').click();
    await expect(page.locator('.mini-toast')).toContainText('Failed to resolve');
    await expect(page.locator('#waitingOverlay')).not.toHaveClass(/active/);
    await expect(page.locator('#forceApproveBtn')).toBeEnabled();
    expect(calls).toBe(1);
    const comments = await request.get(`/api/file/comments?path=${encodeURIComponent(mdPath)}`).then(r => r.json());
    expect(comments.every((c: any) => !c.resolved)).toBe(true);
  });
});
