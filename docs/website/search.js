/**
 * search.js — client-side offline search index over the documentation.
 *
 * The index (PULSE_DOC_INDEX) is a plain array of section records baked
 * into each HTML page (see the inline <script id="pulse-doc-index"> block).
 * This script builds a simple inverted-index-free ranking (token overlap +
 * substring boost) entirely in the browser — no network request, no
 * external search service.
 */
(function () {
  'use strict';

  function getIndex() {
    var el = document.getElementById('pulse-doc-index');
    if (!el) return [];
    try {
      return JSON.parse(el.textContent || '[]');
    } catch (err) {
      return [];
    }
  }

  var INDEX = getIndex();

  function tokenize(text) {
    return (text.toLowerCase().match(/[a-z0-9_.]+/g) || []);
  }

  /**
   * Rank every index entry against a query. Score = token overlap count
   * (weighted higher for title matches) plus a substring-match bonus.
   * Pure client-side, deterministic, no external dependency.
   */
  function search(query, limit) {
    var q = query.trim().toLowerCase();
    if (!q) return [];
    var queryTokens = tokenize(q);
    if (!queryTokens.length) return [];

    var results = [];
    for (var i = 0; i < INDEX.length; i++) {
      var entry = INDEX[i];
      var titleTokens = tokenize(entry.title);
      var bodyTokens = tokenize(entry.body);
      var score = 0;

      for (var t = 0; t < queryTokens.length; t++) {
        var token = queryTokens[t];
        if (titleTokens.indexOf(token) >= 0) score += 5;
        if (bodyTokens.indexOf(token) >= 0) score += 1;
        if (entry.title.toLowerCase().indexOf(token) >= 0) score += 2;
      }

      if (entry.title.toLowerCase().indexOf(q) >= 0) score += 8;
      if (entry.body.toLowerCase().indexOf(q) >= 0) score += 3;

      if (score > 0) {
        results.push({ entry: entry, score: score });
      }
    }

    results.sort(function (a, b) { return b.score - a.score; });
    return results.slice(0, limit || 8).map(function (r) { return r.entry; });
  }

  function snippet(body, query) {
    var idx = body.toLowerCase().indexOf(query.toLowerCase());
    var start = idx >= 0 ? Math.max(0, idx - 40) : 0;
    var text = body.slice(start, start + 140);
    if (start > 0) text = '…' + text;
    if (start + 140 < body.length) text += '…';
    return highlightMatch(text, query);
  }

  function highlightMatch(text, query) {
    var escaped = escapeHtml(text);
    if (!query) return escaped;
    var re = new RegExp('(' + escapeRegex(escapeHtml(query)) + ')', 'ig');
    return escaped.replace(re, '<mark>$1</mark>');
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // ─── UI wiring ──────────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', function () {
    var overlay = document.querySelector('.search-overlay');
    var input = document.getElementById('search-input');
    var resultsEl = document.querySelector('.search-panel__results');
    var triggers = document.querySelectorAll('[data-search-trigger]');
    var closeBtn = document.querySelector('[data-search-close]');
    if (!overlay || !input || !resultsEl) return;

    var activeIndex = -1;
    var currentResults = [];

    function open() {
      overlay.classList.add('is-open');
      input.value = '';
      renderResults('');
      setTimeout(function () { input.focus(); }, 0);
    }

    function close() {
      overlay.classList.remove('is-open');
    }

    function renderResults(query) {
      currentResults = query ? search(query, 8) : [];
      activeIndex = currentResults.length ? 0 : -1;

      if (!query) {
        resultsEl.innerHTML = '<div class="search-empty">Type to search the documentation…</div>';
        return;
      }
      if (!currentResults.length) {
        resultsEl.innerHTML = '<div class="search-empty">No results for "' + escapeHtml(query) + '"</div>';
        return;
      }

      var html = '';
      for (var i = 0; i < currentResults.length; i++) {
        var entry = currentResults[i];
        html +=
          '<a class="search-result' + (i === 0 ? ' is-active' : '') + '" href="' + entry.url + '" data-index="' + i + '">' +
          '<div class="search-result__title">' + highlightMatch(entry.title, query) + '</div>' +
          '<div class="search-result__section">' + escapeHtml(entry.page) + '</div>' +
          '<div class="search-result__snippet">' + snippet(entry.body, query) + '</div>' +
          '</a>';
      }
      resultsEl.innerHTML = html;
    }

    function moveActive(delta) {
      if (!currentResults.length) return;
      activeIndex = (activeIndex + delta + currentResults.length) % currentResults.length;
      var items = resultsEl.querySelectorAll('.search-result');
      for (var i = 0; i < items.length; i++) {
        items[i].classList.toggle('is-active', i === activeIndex);
      }
      if (items[activeIndex]) items[activeIndex].scrollIntoView({ block: 'nearest' });
    }

    for (var i = 0; i < triggers.length; i++) {
      triggers[i].addEventListener('click', open);
    }
    if (closeBtn) closeBtn.addEventListener('click', close);

    overlay.addEventListener('click', function (event) {
      if (event.target === overlay) close();
    });

    input.addEventListener('input', function () {
      renderResults(input.value);
    });

    input.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        moveActive(1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        moveActive(-1);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        var items = resultsEl.querySelectorAll('.search-result');
        if (items[activeIndex]) window.location.href = items[activeIndex].getAttribute('href');
      } else if (event.key === 'Escape') {
        close();
      }
    });

    // Global keyboard shortcut: Cmd/Ctrl+K opens search from anywhere.
    document.addEventListener('keydown', function (event) {
      var isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      var modifierPressed = isMac ? event.metaKey : event.ctrlKey;
      if (modifierPressed && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        open();
      }
      if (event.key === '/' && document.activeElement !== input) {
        var tag = (document.activeElement && document.activeElement.tagName) || '';
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
          event.preventDefault();
          open();
        }
      }
    });
  });

  // Exposed for chatbot.js to reuse the same offline index/ranking logic.
  window.PulseSearch = { search: search, snippet: snippet, index: INDEX };
})();
