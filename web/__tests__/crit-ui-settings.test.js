'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { create, KEYS } = require('../crit-ui-settings.js');

function harness(snapshot, respond) {
  const calls = [];
  const toasts = [];
  const store = create(snapshot, {
    fetch: (url, opts) => { calls.push({ url, opts, body: JSON.parse(opts.body) }); return respond(); },
    showToast: () => (msg, o) => toasts.push({ msg, o }),
  });
  return { store, calls, toasts };
}
const ok = () => Promise.resolve({ ok: true, text: () => Promise.resolve('{}') });

test('CRIT-02.11 saving sends only the changed key', async () => {
  const { store, calls } = harness({ exists: true, settings: { theme: 'light', lightPalette: 'ayu-light' } }, ok);
  assert.equal(await store.set('theme', 'dark'), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/ui-settings');
  assert.equal(calls[0].opts.method, 'PATCH');
  assert.deepEqual(calls[0].body, { theme: 'dark' });
  assert.equal(store.get('theme'), 'dark');
});

test('CRIT-02.7 setting an unchanged value does not write the file', async () => {
  const { store, calls } = harness({ exists: true, settings: { theme: 'dark', shortcuts: { next_block: 'x' } } }, ok);
  await store.set('theme', 'dark');
  await store.set('shortcuts', { next_block: 'x' });
  await store.set('codeFont', undefined);
  assert.equal(calls.length, 0);
});

test('CRIT-02.8 a failed save keeps the new value and shows an error naming the file', async () => {
  const path = '/home/u/.crit/ui-settings.json';
  const fail = () => Promise.resolve({ ok: false, text: () => Promise.resolve(JSON.stringify({ error: 'could not save settings to ' + path + ': permission denied', path })) });
  const { store, toasts } = harness({ exists: true, path, settings: {} }, fail);
  assert.equal(await store.set('theme', 'dark'), false);
  assert.equal(store.get('theme'), 'dark');
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].o.kind, 'error');
  assert.match(toasts[0].msg, /not saved/);
  assert.ok(toasts[0].msg.includes(path));
});

test('CRIT-02.8 a network failure resolves (no unhandled rejection) and names the file', async () => {
  const path = '/home/u/.crit/ui-settings.json';
  const { store, toasts } = harness({ exists: true, path, settings: {} }, () => Promise.reject(new TypeError('Failed to fetch')));
  assert.equal(await store.set('lineNumbers', 'off'), false);
  assert.ok(toasts[0].msg.includes(path));
});

test('CRIT-02.5 applyTheme sets data-theme from the stored theme', () => {
  const attrs = {};
  const html = { setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: k => { delete attrs[k]; } };
  let paletteRoot = null;
  const store = create({ settings: { theme: 'dark' } }, { themePalette: () => ({ applySaved: r => { paletteRoot = r; } }) });
  store.applyTheme(html);
  assert.equal(attrs['data-theme'], 'dark');
  assert.equal(paletteRoot, html);
  create({ settings: {} }, {}).applyTheme(html);
  assert.equal(attrs['data-theme'], undefined);
});

test('CRIT-02.3 per-review state is not a stored setting', () => {
  for (const k of ['fileTreeWidth', 'commentsPanelWidth', 'storyRailWidth', 'live_commentsPanelOpen', 'live_commentsPanelWidth', 'fileTree', 'toc', 'diffScope', 'diffMode', 'live_viewport']) {
    assert.ok(!KEYS.includes(k), k);
  }
});

test('CRIT-02.3 the store exposes a cookie-safe review identity', () => {
  assert.equal(create({ review: 'abc123' }, {}).review, 'abc123');
  assert.equal(create({ review: 'a;b=c d' }, {}).review, 'abcd');
  assert.equal(create({}, {}).review, '');
});

test('CRIT-06.3 refresh drops a key the file no longer has', async () => {
  const store = create({ settings: { templates: ['X'], theme: 'dark' } }, {
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ settings: { theme: 'dark' } }) }),
  });
  assert.equal(await store.refresh('templates'), true);
  assert.equal(store.get('templates'), undefined);
  assert.equal('templates' in store.all(), false);
});
