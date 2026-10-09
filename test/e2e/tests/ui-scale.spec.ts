import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import {
  clearAllComments, loadPage, goSection, mdSection, fileHeader, addComment, clearFocus,
  dragLineRange, openLineComment, diffLine, diffLineNumber, reviewScroller, switchToDocumentView,
  storedUISettings, setDiffStyle, selectedRows, mdDocument,
} from './helpers';

// Interface scale (CRIT-03): one zoom factor for crit's own interface, kept in
// ~/.crit/ui-settings.json. The browser's zoom stays at 100%.

async function openSettings(page: Page) {
  await expect(async () => {
    await page.locator('#settingsToggle').click();
    await expect(page.locator('#settingsPane')).toBeVisible({ timeout: 1000 });
  }).toPass();
  return page.getByLabel('Interface scale');
}

async function setScale(request: APIRequestContext, scale: number) {
  await expect(await request.patch('/api/ui-settings', { data: { scale } })).toBeOK();
}

async function height(target: Locator) {
  const box = await target.boundingBox();
  expect(box).toBeTruthy();
  return box!.height;
}

// The top edge content can be seen below: the page header and the top of the review pane.
async function visibleTop(page: Page) {
  return page.evaluate(() => Math.max(
    document.querySelector('.header')!.getBoundingClientRect().bottom,
    document.getElementById('filesContainer')!.getBoundingClientRect().top,
  ));
}

// The element is on screen, below the sticky chrome, and is what a click near its top hits.
async function expectUncovered(page: Page, target: Locator) {
  await expect(async () => {
    const top = await visibleTop(page);
    const ok = await target.evaluate((el, top) => {
      const r = el.getBoundingClientRect();
      if (r.top < top - 1 || r.top > window.innerHeight - 10) return `top ${r.top} outside [${top}, ${window.innerHeight}]`;
      const root = el.getRootNode() as Document | ShadowRoot;
      const hit = root.elementFromPoint(r.left + Math.min(40, r.width / 2), r.top + 4);
      return hit && (hit === el || el.contains(hit)) ? 'ok' : `covered by ${hit && hit.className}`;
    }, top);
    expect(ok).toBe('ok');
  }).toPass({ timeout: 10_000 });
}

test.describe('Interface scale', () => {
  test.beforeEach(async ({ request }) => {
    await clearAllComments(request);
  });

  test('CRIT-03.1 Settings offers the six scales, 100% selected when none is stored', async ({ page }) => {
    await loadPage(page);
    const select = await openSettings(page);
    await expect(select).toBeVisible();
    await expect(select.locator('option')).toHaveText(['75%', '80%', '90%', '100%', '110%', '125%']);
    await expect(select).toHaveValue('100');
  });

  test('CRIT-03.2 selecting 80% shrinks the whole interface at once, browser zoom untouched', async ({ page, request }) => {
    await addComment(request, 'server.go', 23, 'A card to measure');
    await loadPage(page);
    const item = await goSection(page);
    await openLineComment(page, item, 25);

    await switchToDocumentView(page);
    // CodeView only mounts files near the viewport: bring each one back before measuring.
    const measure = async () => {
      const out: Record<string, number> = {};
      const take = async (k: string, l: Locator) => {
        await expect(l, k).toBeVisible();
        out[k] = await height(l);
      };
      // A header control: the header's own height follows how its text wraps.
      await take('header', page.locator('.header #settingsToggle'));
      await take('treeRow', page.locator('.tree-file[data-tree-path="server.go"]'));
      await take('markdown', (await mdSection(page)).locator('.line-block').first());
      const go = await goSection(page);
      await take('fileHeader', fileHeader(page, 'server.go'));
      await take('codeLine', diffLine(go, 23).first());
      await take('gutter', diffLineNumber(go, 23).first());
      await take('card', page.locator('#filesContainer .comment-card').first());
      const textarea = page.locator('#filesContainer .comment-form textarea');
      if (await textarea.count() === 0) await openLineComment(page, go, 25);
      await take('form', textarea.first());
      return out;
    };
    const select = await openSettings(page);
    const dialog = page.locator('#settingsOverlay .settings-dialog');
    const dialogBefore = (await dialog.boundingBox())!.width;
    await page.keyboard.press('Escape');
    const before = await measure();

    await page.evaluate(() => { (window as unknown as { notReloaded: boolean }).notReloaded = true; });
    await openSettings(page);
    await select.selectOption('80');
    const dialogRatio = async () => (await dialog.boundingBox())!.width / dialogBefore;
    await expect.poll(dialogRatio).toBeGreaterThan(0.76);
    expect(await dialogRatio()).toBeLessThan(0.84);
    await page.keyboard.press('Escape');
    const after = await measure();

    for (const k of Object.keys(before)) {
      expect(after[k] / before[k], `${k}: ${before[k]} -> ${after[k]}`).toBeGreaterThan(0.76);
      expect(after[k] / before[k], `${k}: ${before[k]} -> ${after[k]}`).toBeLessThan(0.84);
    }
    expect(await page.evaluate(() => (window as unknown as { notReloaded: boolean }).notReloaded)).toBe(true);
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1);
    await expect.poll(() => storedUISettings(request)).toEqual({ scale: 80 });
  });

  for (const scale of [75, 125]) {
    test.describe(`at ${scale}%`, () => {
      test.beforeEach(async ({ request }) => {
        await setScale(request, scale);
      });

      test.describe('pointer', () => {
        // 125% of a 1280-wide window leaves 1024 CSS px. There the split code
        // column is narrower than its longest row, and the helpers' centre hit
        // test on that row lands outside the column: the same tests fail at 100%
        // in a 1024x576 window. A helper limit, not the scale's.
        if (scale === 125) test.use({ viewport: { width: 1600, height: 1000 } });
        test(`CRIT-03.3 at ${scale}% a drag selects exactly the lines passed over`, async ({ page }) => {
          await loadPage(page);
          const item = await goSection(page);
          const form = await dragLineRange(page, item, 23, 25);
          await expect(form.locator('.comment-form-header')).toHaveText('Comment on Lines 23-25');
        });

        test(`CRIT-03.3 at ${scale}% the + button opens the form under the clicked line`, async ({ page }) => {
          await loadPage(page);
          const item = await goSection(page);
          const form = await openLineComment(page, item, 24);
          await expect(form.locator('.comment-form-header')).toHaveText('Comment on Line 24');
          const line = (await diffLine(item, 24).first().boundingBox())!;
          const formBox = (await form.boundingBox())!;
          expect(formBox.y).toBeGreaterThanOrEqual(line.y + line.height - 1);
          expect(formBox.y).toBeLessThan(line.y + line.height + 40);
        });

        test(`CRIT-03.3 at ${scale}% a unified drag between deletions selects exactly the rows passed over`, async ({ page }) => {
          // Pierre sized its render window from getBoundingClientRect, which the
          // zoom scales: at 75% rows just below the pane's bottom edge were not mounted.
          await loadPage(page);
          await setDiffStyle(page, 'unified');
          const item = await goSection(page);
          await expect(item.locator('code[data-unified]')).toBeVisible();
          await expect(diffLine(item, 21, 'old')).toHaveAttribute('data-line-type', 'change-deletion');
          await diffLine(item, 21, 'old').scrollIntoViewIfNeeded();
          await expect(diffLine(item, 23, 'old')).toHaveAttribute('data-line-type', 'change-deletion');
          const form = await dragLineRange(page, item, 21, 23, 'old');
          await expect(form.locator('.comment-form-header')).toHaveText('Comment on Lines 21-23');
          await expect.poll(() => selectedRows(item)).toEqual(['21:change-deletion', '42:context', '23:change-deletion']);
        });
      });

      test(`CRIT-03.3 at ${scale}% a file-tree jump shows the file header below the sticky header`, async ({ page }) => {
        await loadPage(page);
        await reviewScroller(page).evaluate(el => { el.scrollTop = el.scrollHeight; });
        await expect(fileHeader(page, 'plan.md')).not.toBeInViewport();
        await page.locator('.tree-file[data-tree-path="plan.md"]').click();
        await expectUncovered(page, fileHeader(page, 'plan.md'));
        await page.locator('.tree-file[data-tree-path="handler.js"]').click();
        await expectUncovered(page, fileHeader(page, 'handler.js'));
      });

      test(`CRIT-03.3 at ${scale}% switching a file to Document view keeps its header in view`, async ({ page }) => {
        // The swap re-anchors the scroll by the item's on-screen move, which
        // must be converted to CSS px like scrollTop.
        await loadPage(page);
        const header = fileHeader(page, 'plan.md');
        await page.locator('.tree-file[data-tree-path="plan.md"]').click();
        await expectUncovered(page, header);
        await header.locator('.file-header-toggle .toggle-btn[data-mode="document"]').click();
        await expect(mdDocument(page).locator('.document-wrapper')).toBeVisible();
        await expectUncovered(page, header);
      });

      test(`CRIT-03.3 at ${scale}% the next-comment key lands each comment in view`, async ({ page, request }) => {
        // Far apart in the list, so the jumps scroll down and (wrapping) back up.
        const first = await addComment(request, 'config.yaml', 4, 'First comment');
        const second = await addComment(request, 'utils.go', 14, 'Second comment');
        await loadPage(page);
        await clearFocus(page);
        for (const want of [first.id, second.id, first.id]) {
          await page.keyboard.press(']');
          // The highlight lasts a second once the jump has landed.
          await expect(page.locator(`.comment-card.comment-nav-highlight[data-comment-id="${want}"]`)).toBeVisible();
          await expectUncovered(page, page.locator(`.main-content .comment-card[data-comment-id="${want}"]`));
        }
      });

      test(`CRIT-03.3 at ${scale}% the next-comment key lands each comment of a rendered document in view`, async ({ page, request }) => {
        const first = await addComment(request, 'plan.md', 1, 'First comment');
        const second = await addComment(request, 'plan.md', 5, 'Second comment');
        await loadPage(page);
        await switchToDocumentView(page);
        await clearFocus(page);
        // The first press picks the first card below the header, so the start depends on the scroll.
        const seen: string[] = [];
        for (let i = 0; i < 3; i++) {
          await page.keyboard.press(']');
          const lit = page.locator('.comment-card.comment-nav-highlight');
          await expect(lit).toHaveCount(1);
          const id = (await lit.getAttribute('data-comment-id'))!;
          await expectUncovered(page, page.locator(`.main-content .comment-card[data-comment-id="${id}"]`));
          seen.push(id);
          await expect(lit).toHaveCount(0);
        }
        expect(new Set(seen)).toEqual(new Set([first.id, second.id]));
      });
    });
  }
});
