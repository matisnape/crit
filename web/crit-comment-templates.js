// crit-comment-templates.js — template bar and saved-snippet CRUD.
// Vanilla JS, no module loader. Exports onto window.crit.commentTemplates.
//
// Depends on: window.crit.uiSettings (templates live under `templates` in
// ~/.crit/ui-settings.json, shared by every review; the server imports an old
// `crit-templates` cookie once). index.html loads it in <head>, before this.

(function () {
  'use strict';

  var ns = (window.crit = window.crit || {});

  // --- CRUD ---

  function getTemplates() {
    var stored = ns.uiSettings.get('templates', []);
    // A copy: callers edit the list, and the store skips an unchanged value.
    return Array.isArray(stored) ? stored.slice() : [];
  }

  function saveTemplates(templates) {
    // [] rather than a removal once all are deleted, so the server never
    // re-imports an old crit-templates cookie.
    return ns.uiSettings.set('templates', templates);
  }

  // Adds or deletes against the file's current list, not this tab's copy from
  // page load, so a tab opened earlier keeps what another tab saved since.
  // Queued, so two quick edits in one tab cannot read the same list.
  // ponytail: two tabs editing in the same instant can still lose one edit
  // (GET then PATCH is not atomic); a server-side add/remove would close it.
  var pending = Promise.resolve();
  function changeTemplates(fn) {
    pending = pending.then(function () {
      return ns.uiSettings.refresh('templates').then(function (ok) {
        // A failed read already showed an error; saving the stale copy is the bug.
        if (ok) return saveTemplates(fn(getTemplates()));
      });
    });
    return pending;
  }

  // --- DOM ---

  /**
   * Build the template bar element.
   * @param {Object} opts
   * @param {function(string): void} opts.onInsert — called with template text when user picks one
   * @param {function(string): void} opts.onSaveNew — called with body text to save as a new template
   * @returns {HTMLElement} the bar element (caller inserts into DOM)
   */
  function buildTemplateBar(opts) {
    var onInsert = opts.onInsert;
    var onSaveNew = opts.onSaveNew;

    var bar = document.createElement('div');
    bar.className = 'comment-template-bar';

    function populate() {
      bar.innerHTML = '';
      var templates = getTemplates();
      if (templates.length === 0) {
        bar.style.display = 'none';
        return;
      }
      bar.style.display = '';
      templates.forEach(function (tmpl) {
        var chip = document.createElement('button');
        chip.className = 'template-chip';
        chip.title = tmpl;

        var label = document.createElement('span');
        label.className = 'template-chip-label';
        label.textContent = tmpl;
        chip.appendChild(label);

        var del = document.createElement('span');
        del.className = 'template-chip-delete';
        del.textContent = '×';
        del.title = 'Remove template';
        del.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          // By text: another tab may have changed the list since this render.
          changeTemplates(function (t) {
            var at = t.indexOf(tmpl);
            if (at !== -1) t.splice(at, 1);
            return t;
          }).then(populate);
        });
        chip.appendChild(del);

        chip.addEventListener('click', function (e) {
          e.preventDefault();
          if (onInsert) onInsert(tmpl);
        });

        bar.appendChild(chip);
      });
    }

    populate();

    // Expose a refresh handle so callers can re-populate after saving.
    bar._populate = populate;

    // Wire up the onSaveNew callback so external "save template" buttons can
    // call bar._saveNew(body) and the bar refreshes automatically.
    bar._saveNew = function (body) {
      if (!body) return;
      var done = changeTemplates(function (t) { t.push(body); return t; }).then(populate);
      if (onSaveNew) onSaveNew(body);
      return done;
    };

    return bar;
  }

  // --- Public API ---

  var api = {
    getTemplates: getTemplates,
    saveTemplates: saveTemplates,
    buildTemplateBar: buildTemplateBar,
  };

  ns.commentTemplates = api;

  // CommonJS dual-export for unit tests.
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
})();
