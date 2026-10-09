// crit-comment-card-helpers.js — pure rendering helpers shared between the
// code-review comment card (app.js) and live-mode rows (live-mode.row.js).
//
// Rules for adding helpers here:
//   1. Pure: no closures over module state, no DOM mutation, no fetch.
//   2. Returns a string, primitive, or plain object.
//   3. Code review and live mode both render through these, so a change here
//      changes both renderers.
//
// Exports onto window.crit.commentCardHelpers. Loaded before app.js and
// live-mode.js via index.html script order.
'use strict';
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.crit = root.crit || {};
    root.crit.commentCardHelpers = api;
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {

  // escapeHtml — delegates to the canonical window.crit.shared.escapeHTML.
  // Alias preserves the lowercase-h export name for existing consumers.
  var escapeHtml = (typeof window !== 'undefined' && window.crit && window.crit.shared)
    ? window.crit.shared.escapeHTML
    : function (str) {
        return String(str == null ? '' : str)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      };

  // relativeTime — byte-identical to app.js's relativeTime.
  function relativeTime(dateStr) {
    var now = Date.now();
    var then = new Date(dateStr).getTime();
    var diff = Math.floor((now - then) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
    return Math.floor(diff / 604800) + 'w ago';
  }

  // parseTime — Date for a valid timestamp, null for missing/unparseable.
  function parseTime(isoStr) {
    if (!isoStr) return null;
    var d = new Date(isoStr);
    return isNaN(d.getTime()) ? null : d;
  }

  // formatTime — short header time (HH:MM in locale); '' when invalid.
  function formatTime(isoStr) {
    var d = parseTime(isoStr);
    return d ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  }

  // formatFullTime — header-time tooltip: local YYYY-MM-DD HH:MM:SS, 24h,
  // locale-independent; '' when invalid (callers then set no title).
  function formatFullTime(isoStr) {
    var d = parseTime(isoStr);
    if (!d) return '';
    function p(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  // authorColorIndex — byte-identical to app.js's authorColorIndex. Picks a
  // 0..N swatch slot for the author colour badge.
  var AUTHOR_COLOR_COUNT = 6;
  function authorColorIndex(name) {
    var s = String(name == null ? '' : name);
    var hash = 0;
    for (var i = 0; i < s.length; i++) {
      hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
    }
    return Math.abs(hash) % AUTHOR_COLOR_COUNT;
  }

  // formKeyFor — convention-based form-key for edit/reply/etc. forms keyed by
  // comment id. Used by the shared comment-card / comment-form modules and by
  // live-mode mounts so both controllers produce matching keys.
  // kind: 'edit' | 'reply' | string
  function formKeyFor(commentId, kind) {
    return 'comment:' + kind + ':' + commentId;
  }

  // chipLabel — canonical live-pin label heuristic. Prefers accessible_name,
  // then a short slice of textContent extracted from outer_html, then the leaf
  // tag from tag_chain, then a.role, and finally falls back to 'pin'.
  function chipLabel(a) {
    var name = (a.accessible_name || '').trim();
    if (name) return name.length > 60 ? name.slice(0, 60) + '…' : name;
    var html = a.outer_html || '';
    var text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text) return text.length > 60 ? text.slice(0, 60) + '…' : text;
    var chain = Array.isArray(a.tag_chain) ? a.tag_chain : [];
    var tag = chain.length ? chain[chain.length - 1] : '';
    if (tag) return '<' + tag.toLowerCase() + '>';
    if (a.role) return a.role;
    return 'pin';
  }

  // splitCommentRefs — split text around whole-word comment IDs (c_/r_/rp_)
  // for which exists(id) is true. Returns null when nothing matches, else an
  // array of strings and { id } parts.
  function splitCommentRefs(text, exists) {
    var re = /\b(?:c|r|rp)_[a-f0-9]{6,}\b/g;
    var parts = [];
    var last = 0, m;
    while ((m = re.exec(text)) !== null) {
      if (!exists(m[0])) continue;
      if (m.index > last) parts.push(text.slice(last, m.index));
      parts.push({ id: m[0] });
      last = m.index + m[0].length;
    }
    if (!parts.length) return null;
    if (last < text.length) parts.push(text.slice(last));
    return parts;
  }

  // linkifyCommentRefs — turn existing comment IDs in el's text into
  // <a class="comment-ref" href="#id"> links. Skips code, pre and links.
  function linkifyCommentRefs(el, exists) {
    var doc = el.ownerDocument;
    var walker = doc.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
    var nodes = [];
    var node;
    while ((node = walker.nextNode())) {
      if (!node.parentNode.closest('code, pre, a')) nodes.push(node);
    }
    nodes.forEach(function (tn) {
      var parts = splitCommentRefs(tn.nodeValue, exists);
      if (!parts) return;
      var frag = doc.createDocumentFragment();
      parts.forEach(function (p) {
        if (typeof p === 'string') { frag.appendChild(doc.createTextNode(p)); return; }
        var a = doc.createElement('a');
        a.className = 'comment-ref';
        a.href = '#' + p.id;
        a.dataset.refId = p.id;
        a.textContent = p.id;
        frag.appendChild(a);
      });
      tn.parentNode.replaceChild(frag, tn);
    });
  }

  // Standard class strings. These are deliberately simple constants so that
  // both renderers stay in sync if we tweak them later. Adding a class here
  // does NOT make every existing card pick it up — call sites still need to
  // include them — but having a single source-of-truth string makes drift
  // harder.
  var BTN_CLASS = 'btn';
  var BTN_SM_CLASS = 'btn btn-sm';
  var COMMENT_CARD_CLASS = 'comment-card';
  var COMMENT_BODY_CLASS = 'comment-body';
  var COMMENT_ACTIONS_CLASS = 'comment-actions';

  return {
    escapeHtml: escapeHtml,
    chipLabel: chipLabel,
    splitCommentRefs: splitCommentRefs,
    linkifyCommentRefs: linkifyCommentRefs,
    relativeTime: relativeTime,
    formatTime: formatTime,
    formatFullTime: formatFullTime,
    formKeyFor: formKeyFor,
    authorColorIndex: authorColorIndex,
    AUTHOR_COLOR_COUNT: AUTHOR_COLOR_COUNT,
    BTN_CLASS: BTN_CLASS,
    BTN_SM_CLASS: BTN_SM_CLASS,
    COMMENT_CARD_CLASS: COMMENT_CARD_CLASS,
    COMMENT_BODY_CLASS: COMMENT_BODY_CLASS,
    COMMENT_ACTIONS_CLASS: COMMENT_ACTIONS_CLASS,
  };
});
