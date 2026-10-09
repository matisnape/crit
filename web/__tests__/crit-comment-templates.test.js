const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

// --- Sandbox setup ---
// A minimal DOM with a cookie jar, plus the real crit-shared.js, so tests can
// check that no crit-templates cookie is read or written.

function makeSandbox() {
  var cookieJar = '';
  var doc = {
    get cookie() { return cookieJar; },
    set cookie(v) { cookieJar = v; },
    createElement: function (tag) {
      var el = {
        tagName: tag.toUpperCase(),
        className: '',
        textContent: '',
        title: '',
        style: {},
        children: [],
        // populate() clears the bar with innerHTML = ''.
        set innerHTML(v) { if (v === '') el.children = []; },
        get innerHTML() { return ''; },
        _listeners: {},
        appendChild: function (child) { el.children.push(child); return child; },
        addEventListener: function (evt, fn) {
          if (!el._listeners[evt]) el._listeners[evt] = [];
          el._listeners[evt].push(fn);
        },
      };
      return el;
    },
  };
  var win = { crit: { shared: {} } };

  // Load crit-shared.js to get real getCookie/setCookie.
  var sharedSrc = fs.readFileSync(path.join(__dirname, '..', 'crit-shared.js'), 'utf8');
  var sharedFn = new Function('window', 'document', sharedSrc);
  sharedFn(win, doc);

  // Now load the module under test.
  var src = fs.readFileSync(path.join(__dirname, '..', 'crit-comment-templates.js'), 'utf8');
  var fn = new Function('window', 'document', 'module', src + '\nreturn window;');
  var mod = { exports: {} };
  fn(win, doc, mod);

  return { win: win, doc: doc, mod: mod, setCookieRaw: function (v) { cookieJar = v; } };
}

// --- Tests ---

test('CommonJS module.exports matches window.crit.commentTemplates', () => {
  var sb = makeSandbox();
  assert.strictEqual(sb.mod.exports, sb.win.crit.commentTemplates);
});

// --- Shared settings file (~/.crit/ui-settings.json via window.crit.uiSettings) ---

// A fake ~/.crit/ui-settings.json behind GET/PATCH /api/ui-settings. Every
// sandbox is one browser tab; tabs given the same file share it, and each one
// starts from a copy taken when it loaded, like the page's embedded snapshot.
function fakeFile(settings) {
  return { settings: Object.assign({}, settings) };
}

function sandboxWithStore(settings, file) {
  var sb = makeSandbox();
  var f = file || fakeFile(settings);
  var patches = [];
  var create = require('../crit-ui-settings.js').create;
  function reply(body) {
    return Promise.resolve({ ok: true, json: function () { return Promise.resolve(body); } });
  }
  sb.win.crit.uiSettings = create({ settings: JSON.parse(JSON.stringify(f.settings)) }, {
    fetch: function (url, opts) {
      if (opts && opts.method === 'PATCH') {
        var body = JSON.parse(opts.body);
        patches.push(body);
        Object.assign(f.settings, body);
      }
      return reply({ exists: true, path: '/tmp/ui-settings.json', settings: JSON.parse(JSON.stringify(f.settings)) });
    },
  });
  sb.patches = patches;
  sb.file = f;
  return sb;
}

function chipDelete(bar, i) {
  var del = bar.children[i].children[1];
  del._listeners.click[0]({ preventDefault: function () {}, stopPropagation: function () {} });
}

test('getTemplates returns an empty list when none are stored', () => {
  var sb = sandboxWithStore({});
  assert.deepEqual(sb.win.crit.commentTemplates.getTemplates(), []);
});

test('saveTemplates + getTemplates roundtrip', () => {
  var sb = sandboxWithStore({});
  var api = sb.win.crit.commentTemplates;
  api.saveTemplates(['Fix typo', 'LGTM']);
  assert.deepEqual(api.getTemplates(), ['Fix typo', 'LGTM']);
});

test('buildTemplateBar returns a DOM element with correct class', () => {
  var sb = sandboxWithStore({ templates: ['Nice!'] });
  var bar = sb.win.crit.commentTemplates.buildTemplateBar({ onInsert: function () {} });
  assert.equal(bar.className, 'comment-template-bar');
  assert.equal(bar.children.length, 1);
  assert.equal(bar.children[0].className, 'template-chip');
});

test('buildTemplateBar hides when no templates', () => {
  var sb = sandboxWithStore({});
  var bar = sb.win.crit.commentTemplates.buildTemplateBar({ onInsert: function () {} });
  assert.equal(bar.style.display, 'none');
});

test('CRIT-06.1 templates come from the shared settings file, not the cookie', () => {
  var sb = sandboxWithStore({ templates: ['Fix typo'] });
  sb.setCookieRaw('crit-templates=' + encodeURIComponent('["From cookie"]'));
  var bar = sb.win.crit.commentTemplates.buildTemplateBar({ onInsert: function () {} });
  assert.equal(bar.children.length, 1);
  assert.equal(bar.children[0].title, 'Fix typo');
});

// The store PATCHes in a microtask; let it run.
function settle() { return new Promise(function (r) { setImmediate(r); }); }

test('CRIT-06.1 saving a template sends the whole list to the settings file', async () => {
  var sb = sandboxWithStore({ templates: ['Fix typo'] });
  var bar = sb.win.crit.commentTemplates.buildTemplateBar({ onInsert: function () {} });
  bar._saveNew('LGTM');
  await settle();
  assert.deepEqual(sb.patches, [{ templates: ['Fix typo', 'LGTM'] }]);
  assert.deepEqual(sb.win.crit.commentTemplates.getTemplates(), ['Fix typo', 'LGTM']);
  assert.equal(sb.doc.cookie, '', 'no crit-templates cookie written');
});

test('CRIT-06.3 deleting a template sends the remaining list; the last one leaves []', async () => {
  var sb = sandboxWithStore({ templates: ['Fix typo', 'LGTM'] });
  var bar = sb.win.crit.commentTemplates.buildTemplateBar({ onInsert: function () {} });
  chipDelete(bar, 0);
  await settle();
  chipDelete(bar, 0);
  await settle();
  assert.deepEqual(sb.patches, [{ templates: ['LGTM'] }, { templates: [] }]);
  assert.equal(bar.style.display, 'none');
});

test('CRIT-06.4 a stored value that is not a list offers no templates', () => {
  var sb = sandboxWithStore({ templates: '["Fix typo"' });
  assert.deepEqual(sb.win.crit.commentTemplates.getTemplates(), []);
});

// Two tabs opened before either saved: the second tab's copy is stale.
test('CRIT-06.3 a stale tab saving a template keeps the one another tab saved', async () => {
  var file = fakeFile({ templates: [] });
  var a = sandboxWithStore(null, file);
  var b = sandboxWithStore(null, file);
  var barA = a.win.crit.commentTemplates.buildTemplateBar({ onInsert: function () {} });
  var barB = b.win.crit.commentTemplates.buildTemplateBar({ onInsert: function () {} });
  barA._saveNew('X');
  await settle();
  barB._saveNew('Y');
  await settle();
  assert.deepEqual(file.settings.templates, ['X', 'Y']);
  assert.deepEqual(barB.children.map(function (c) { return c.title; }), ['X', 'Y']);
});

test('CRIT-06.3 a stale tab deleting a template does not bring back one another tab deleted', async () => {
  var file = fakeFile({ templates: ['X', 'Y'] });
  var a = sandboxWithStore(null, file);
  var b = sandboxWithStore(null, file);
  var barA = a.win.crit.commentTemplates.buildTemplateBar({ onInsert: function () {} });
  var barB = b.win.crit.commentTemplates.buildTemplateBar({ onInsert: function () {} });
  chipDelete(barA, 0); // X
  await settle();
  chipDelete(barB, 1); // Y, in B's bar that still shows X
  await settle();
  assert.deepEqual(file.settings.templates, []);
  assert.equal(barB.style.display, 'none');
});

test('CRIT-06.3 when the file cannot be read, a delete sends nothing and shows an error', async () => {
  var sb = makeSandbox();
  var calls = [];
  var toasts = [];
  sb.win.crit.uiSettings = require('../crit-ui-settings.js').create(
    { path: '/home/u/.crit/ui-settings.json', settings: { templates: ['Fix typo'] } },
    {
      fetch: function (url, opts) { calls.push(opts && opts.method); return Promise.resolve({ ok: false, status: 500 }); },
      showToast: function () { return function (msg, o) { toasts.push({ msg: msg, o: o }); }; },
    });
  var bar = sb.win.crit.commentTemplates.buildTemplateBar({ onInsert: function () {} });
  chipDelete(bar, 0);
  await settle();
  assert.deepEqual(calls, [undefined], 'one GET, no PATCH');
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].o.kind, 'error');
  assert.ok(toasts[0].msg.includes('/home/u/.crit/ui-settings.json'));
  assert.equal(bar.children.length, 1, 'the template is still offered');
});
