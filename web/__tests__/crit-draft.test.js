const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const store = {};
global.localStorage = {
  getItem: (k) => store[k] ?? null,
  setItem: (k, v) => { store[k] = v; },
  removeItem: (k) => { delete store[k]; },
  get length() { return Object.keys(store).length; },
  key: (i) => Object.keys(store)[i] ?? null,
};

global.window = { crit: {} };

const draft = require('../crit-draft.js');

describe('crit-draft', () => {
  beforeEach(() => {
    Object.keys(store).forEach(k => delete store[k]);
  });

  it('saveDraftImmediate writes to localStorage', () => {
    draft.saveDraftImmediate('test-key', { body: 'hello' });
    const loaded = draft.loadDraft('test-key');
    assert.deepEqual(loaded, { body: 'hello' });
  });

  it('clearDraft removes from localStorage', () => {
    draft.saveDraftImmediate('test-key', { body: 'hello' });
    draft.clearDraft('test-key');
    assert.equal(draft.loadDraft('test-key'), null);
  });

  it('clearAllDrafts removes matching keys', () => {
    draft.saveDraftImmediate('file-a', { body: 'a' });
    draft.saveDraftImmediate('file-b', { body: 'b' });
    draft.saveDraftImmediate('live-c', { body: 'c' });
    draft.clearAllDrafts('file-');
    assert.equal(draft.loadDraft('file-a'), null);
    assert.equal(draft.loadDraft('file-b'), null);
    assert.deepEqual(draft.loadDraft('live-c'), { body: 'c' });
  });

  it('loadDraft returns null for missing key', () => {
    assert.equal(draft.loadDraft('nonexistent'), null);
  });
});

describe('CRIT-02.3 drafts are kept per review', () => {
  beforeEach(() => {
    Object.keys(store).forEach(k => delete store[k]);
  });
  const as = (review, fn) => {
    window.crit.uiSettings = { review };
    try { return fn(); } finally { delete window.crit.uiSettings; }
  };

  it('CRIT-02.3 another review on the same origin does not see the draft', () => {
    as('aaa111', () => draft.saveDraftImmediate('plan.md:1:1:', { body: 'mine' }));
    assert.equal(as('bbb222', () => draft.loadDraft('plan.md:1:1:')), null);
    assert.deepEqual(as('aaa111', () => draft.loadDraft('plan.md:1:1:')), { body: 'mine' });
    assert.ok(as('aaa111', () => draft.isOwnKey(draft.keyPrefix() + 'plan.md:1:1:')));
    assert.ok(!as('bbb222', () => draft.isOwnKey('crit-draft~aaa111~plan.md:1:1:')));
  });

  it('CRIT-02.3 an old unprefixed draft is read once for the same form, then dropped', () => {
    store['crit-draft-plan.md:1:1:'] = JSON.stringify({ body: 'old' });
    assert.deepEqual(as('aaa111', () => draft.loadDraft('plan.md:1:1:')), { body: 'old' });
    assert.equal(store['crit-draft-plan.md:1:1:'], undefined);
    // Moved into this review, so a reload before typing keeps it.
    assert.deepEqual(as('aaa111', () => draft.loadDraft('plan.md:1:1:')), { body: 'old' });
    assert.equal(as('bbb222', () => draft.loadDraft('plan.md:1:1:')), null);
  });
});
