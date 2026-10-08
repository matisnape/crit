'use strict';
// Pin the process time zone before any Date is built: node --test runs each
// file in its own process, and Node re-reads TZ when it is assigned.
process.env.TZ = 'Europe/Warsaw';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('../crit-comment-card-helpers.js');

// Minimal DOM shim: a real DOM keeps `title` as a reflected property, so an
// element that never had `title` assigned reads back undefined here.
function makeEl(tag) {
  return {
    tagName: (tag || 'div').toUpperCase(),
    children: [],
    dataset: {},
    style: {},
    _attrs: {},
    classList: {
      _set: new Set(),
      add(...c) { c.forEach((x) => this._set.add(x)); },
      remove(...c) { c.forEach((x) => this._set.delete(x)); },
      contains(c) { return this._set.has(c); },
      toggle(c) { if (this._set.has(c)) { this._set.delete(c); return false; } this._set.add(c); return true; },
    },
    appendChild(c) { this.children.push(c); return c; },
    prepend(c) { this.children.unshift(c); return c; },
    insertBefore(n) { this.children.unshift(n); return n; },
    addEventListener() {},
    setAttribute(k, v) { this._attrs[k] = v; },
    getAttribute(k) { return this._attrs[k]; },
    querySelector() { return null; },
    set className(v) { this._cn = v; },
    get className() { return this._cn || ''; },
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html || ''; },
    set textContent(v) { this._text = v; },
    get textContent() { return this._text; },
  };
}

function findByClass(root, cls) {
  const hits = [];
  (function walk(el) {
    if (el.className && new RegExp('(^|\\s)' + cls + '(\\s|$)').test(el.className)) hits.push(el);
    for (const c of (el.children || [])) walk(c);
  })(root);
  return hits;
}

global.document = { createElement: (tag) => makeEl(tag) };
const card = require('../crit-comment-card.js');

function cardDeps() {
  return {
    commentMd: { render: (b) => '<p>' + (b || '') + '</p>' },
    formatTime: helpers.formatTime,
    formatFullTime: helpers.formatFullTime,
    renderReplyList: () => makeEl(),
    createReplyInput: () => makeEl(),
  };
}

const BAD_TEXT = /Invalid Date|NaN|undefined/;

test('CRIT-01.3 process runs in Europe/Warsaw (UTC+1 in January)', () => {
  assert.equal(new Date('2026-01-05T09:03:07Z').getTimezoneOffset(), -60);
});

test('CRIT-01.3 formats 2026-01-05T09:03:07Z as 2026-01-05 10:03:07 in Europe/Warsaw', () => {
  assert.equal(helpers.formatFullTime('2026-01-05T09:03:07Z'), '2026-01-05 10:03:07');
});

test('CRIT-01.3 zero-pads every field', () => {
  assert.equal(helpers.formatFullTime('2026-02-03T00:04:05Z'), '2026-02-03 01:04:05');
});

test('CRIT-01.3 uses the 24-hour clock with no AM/PM marker', () => {
  const out = helpers.formatFullTime('2026-01-05T17:03:07Z');
  assert.equal(out, '2026-01-05 18:03:07');
  assert.doesNotMatch(out, /AM|PM/i);
});

test('CRIT-01.4 formatFullTime and formatTime return "" for missing or unparseable times', () => {
  for (const bad of ['', 'not-a-date', undefined, null]) {
    assert.equal(helpers.formatFullTime(bad), '', 'formatFullTime(' + bad + ')');
    assert.equal(helpers.formatTime(bad), '', 'formatTime(' + bad + ')');
  }
});

test('CRIT-01.1 comment header time carries the full local timestamp as title, text unchanged', () => {
  const iso = '2026-10-06T16:07:23Z';
  const out = card.buildCommentCard({ id: 'c1', body: 'hi', created_at: iso }, 'a.go', { deps: cardDeps() });
  const [time] = findByClass(out.card, 'comment-time');
  assert.equal(time.title, '2026-10-06 18:07:23');
  assert.equal(time.textContent, helpers.formatTime(iso));
  assert.doesNotMatch(time.textContent, /2026/);
});

test('CRIT-01.4 comment with missing or invalid created_at gets no title and no bad text', () => {
  for (const bad of ['', 'not-a-date', undefined]) {
    const out = card.buildCommentCard({ id: 'c2', body: 'still renders', created_at: bad }, 'a.go', { deps: cardDeps() });
    const [time] = findByClass(out.card, 'comment-time');
    assert.equal(time.title, undefined, 'no title for ' + bad);
    assert.doesNotMatch(String(time.textContent || ''), BAD_TEXT);
    const [body] = findByClass(out.card, 'comment-body');
    assert.ok(body, 'body still renders');
  }
});

// Live mode / HTML preview: replies render through live-mode.row.js's own
// reply builder, and the card header through the shared buildCommentCard.
test('CRIT-01.2 live-mode rows forward formatFullTime and title reply times', () => {
  globalThis.window = globalThis;
  let captured;
  globalThis.crit = {
    commentCardHelpers: helpers,
    commentCard: {
      buildCommentCard: (c, p, opts) => { captured = opts; return { wrapper: makeEl(), card: makeEl(), actions: makeEl() }; },
    },
  };
  delete require.cache[require.resolve('../live-mode.row.js')];
  const { renderLivePinRow } = require('../live-mode.row.js');
  const comment = {
    id: 'p1',
    body: 'pin',
    dom_anchor: { pathname: '/' },
    created_at: '2026-10-06T16:07:23Z',
    replies: [
      { id: 'r1', body: 'ok', created_at: '2026-10-06T16:08:00Z' },
      { id: 'r2', body: 'bad', created_at: 'not-a-date' },
    ],
  };
  renderLivePinRow(comment, {
    commentMd: { render: (b) => b },
    formatTime: helpers.formatTime,
    formatFullTime: helpers.formatFullTime,
  });
  assert.equal(captured.deps.formatFullTime, helpers.formatFullTime, 'card deps forward formatFullTime');
  const list = captured.deps.renderReplyList(comment, '/');
  const times = findByClass(list, 'reply-time');
  assert.equal(times.length, 1, 'invalid reply time renders no time span');
  assert.equal(times[0].title, '2026-10-06 18:08:00');
  assert.doesNotMatch(times[0].textContent, /2026/);
});
