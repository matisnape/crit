(function () {
  'use strict';

  var DEBOUNCE_MS = 500;
  var timers = {};

  // Drafts belong to one review: localStorage is shared by every review
  // served on the same origin (a fixed `port`), so keys carry the review id
  // the server embeds in the page (crit-ui-settings.js). "crit-draft-<form>"
  // is the old unscoped shape, read once as a fallback (see loadDraft).
  var LEGACY_PREFIX = 'crit-draft-';
  function keyPrefix() {
    var review = window.crit && window.crit.uiSettings && window.crit.uiSettings.review;
    return review ? 'crit-draft~' + review + '~' : LEGACY_PREFIX;
  }
  function storageKey(formKey) {
    return keyPrefix() + formKey;
  }
  // Keys a review's draft restore may read: its own, plus old unscoped ones.
  function isOwnKey(key) {
    return !!key && (key.indexOf(keyPrefix()) === 0 || key.indexOf(LEGACY_PREFIX) === 0);
  }

  function saveDraft(formKey, data) {
    if (timers[formKey]) clearTimeout(timers[formKey]);
    timers[formKey] = setTimeout(function () {
      try {
        localStorage.setItem(storageKey(formKey), JSON.stringify(data));
      } catch (e) {}
      delete timers[formKey];
    }, DEBOUNCE_MS);
  }

  function saveDraftImmediate(formKey, data) {
    if (timers[formKey]) {
      clearTimeout(timers[formKey]);
      delete timers[formKey];
    }
    try {
      localStorage.setItem(storageKey(formKey), JSON.stringify(data));
    } catch (e) {}
  }

  function loadDraft(formKey) {
    try {
      var key = storageKey(formKey);
      var raw = localStorage.getItem(key);
      var legacy = LEGACY_PREFIX + formKey;
      if (!raw && legacy !== key) {
        raw = localStorage.getItem(legacy);
        if (raw) {
          localStorage.setItem(key, raw);
          localStorage.removeItem(legacy);
        }
      }
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function clearDraft(formKey) {
    if (timers[formKey]) {
      clearTimeout(timers[formKey]);
      delete timers[formKey];
    }
    try {
      localStorage.removeItem(storageKey(formKey));
    } catch (e) {}
  }

  function clearAllDrafts(prefix) {
    try {
      var toRemove = [];
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i);
        if (key && key.indexOf(keyPrefix() + (prefix || '')) === 0) {
          toRemove.push(key);
        }
      }
      for (var j = 0; j < toRemove.length; j++) {
        localStorage.removeItem(toRemove[j]);
      }
    } catch (e) {}
  }

  function flushAll() {
    var keys = Object.keys(timers);
    for (var i = 0; i < keys.length; i++) {
      var formKey = keys[i];
      clearTimeout(timers[formKey]);
      delete timers[formKey];
    }
  }

  var api = {
    saveDraft: saveDraft,
    saveDraftImmediate: saveDraftImmediate,
    loadDraft: loadDraft,
    clearDraft: clearDraft,
    clearAllDrafts: clearAllDrafts,
    flushAll: flushAll,
    keyPrefix: keyPrefix,
    isOwnKey: isOwnKey,
  };

  window.crit = window.crit || {};
  window.crit.draft = api;

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
})();
