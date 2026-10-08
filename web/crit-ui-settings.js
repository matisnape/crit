// crit-ui-settings.js — the Settings-dialog choices, stored by the crit server
// in ~/.crit/ui-settings.json so every review on the machine shares them
// (browser storage is scoped to one host and port).
//
// The server embeds the stored snapshot in the page as window.critUISettings
// (internal/server/ui_settings.go), so this runs synchronously in <head> and
// the first paint already uses the saved theme. Saving sends only the changed
// key; the server merges it into the file, so a tab holding stale values never
// reverts another tab's choice. Other tabs pick a change up on reload.
//
// Reads: window.critUISettings, window.crit.themePalette (apply),
// window.crit.shared.showToast (save errors, when loaded).
(function () {
  'use strict';

  // Mirrors uisettings.IsSetting in Go. Everything else (panel widths, open
  // panels, diff scope, viewport) is per-review state and stays in the cookie.
  var KEYS = [
    'theme', 'lightPalette', 'darkPalette', 'codeFont', 'lineNumbers', 'boostContrast',
    'codeOverflow', 'inlineDiff', 'changeIndicators', 'unchangedContext', 'width',
    'hideResolved', 'ignoreWhitespace', 'live_hideResolved', 'shortcuts',
  ];

  function create(snapshot, deps) {
    var snap = snapshot || {};
    var settings = Object.assign({}, snap.settings || {});
    var path = snap.path || '~/.crit/ui-settings.json';
    var d = deps || {};

    function isSetting(key) { return KEYS.indexOf(key) !== -1; }
    function has(key) { return Object.prototype.hasOwnProperty.call(settings, key); }
    function get(key, fallback) { return has(key) ? settings[key] : fallback; }
    function all() { return Object.assign({}, settings); }

    function reportError(message) {
      var toast = d.showToast && d.showToast();
      if (toast) toast(message, { kind: 'error', timeout: 8000 });
    }

    // Applies at once and saves in the background. Resolves to whether the
    // file was written; never rejects, so callers need no error handling.
    function set(key, value) {
      var remove = value === undefined || value === null;
      if (remove ? !has(key) : (has(key) && JSON.stringify(settings[key]) === JSON.stringify(value))) {
        return Promise.resolve(true);
      }
      if (remove) delete settings[key];
      else settings[key] = value;
      var body = {};
      body[key] = remove ? null : value;
      return Promise.resolve()
        .then(function () {
          return d.fetch('/api/ui-settings', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
        })
        .then(function (r) {
          if (r.ok) return true;
          return r.text().then(function (text) {
            var msg = text;
            try { msg = JSON.parse(text).error || text; } catch (_) { /* plain text */ }
            reportError('Setting not saved: ' + (msg || ('could not save settings to ' + path)));
            return false;
          });
        })
        .catch(function () {
          reportError('Setting not saved: could not save settings to ' + path);
          return false;
        });
    }

    // <html data-theme> plus the light/dark UI palette, before first paint.
    function applyTheme(root) {
      var html = root || (typeof document !== 'undefined' && document.documentElement);
      if (!html) return;
      var t = get('theme', 'system');
      if (t === 'light' || t === 'dark') html.setAttribute('data-theme', t);
      else html.removeAttribute('data-theme');
      var palette = d.themePalette && d.themePalette();
      if (palette) palette.applySaved(html);
    }

    return { KEYS: KEYS, isSetting: isSetting, get: get, all: all, set: set, applyTheme: applyTheme, path: path };
  }

  var api = { KEYS: KEYS, create: create };
  if (typeof window !== 'undefined') {
    window.crit = window.crit || {};
    var store = create(window.critUISettings, {
      fetch: function (url, opts) { return window.fetch(url, opts); },
      showToast: function () { return window.crit.shared && window.crit.shared.showToast; },
      themePalette: function () { return window.crit.themePalette; },
    });
    store.create = create;
    window.crit.uiSettings = store;
  }
  if (typeof module === 'object' && module.exports) module.exports = api;
})();
