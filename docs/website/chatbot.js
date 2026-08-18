/**
 * chatbot.js — documentation-grounded assistant.
 *
 * Hard requirement: this bot answers ONLY using content present in the
 * page's baked-in documentation index (the same index search.js uses). It
 * never calls an external API and never generates text beyond what is
 * extracted from indexed sections. If no indexed section matches the
 * question well enough, it returns the exact fallback string below —
 * never a fabricated answer.
 */
(function () {
  'use strict';

  var FALLBACK = "I couldn't find this information in the documentation.";
  var MIN_SCORE_FOR_ANSWER = 3;

  function getIndex() {
    if (window.PulseSearch && window.PulseSearch.index) return window.PulseSearch.index;
    var el = document.getElementById('pulse-doc-index');
    if (!el) return [];
    try {
      return JSON.parse(el.textContent || '[]');
    } catch (err) {
      return [];
    }
  }

  function tokenize(text) {
    return (text.toLowerCase().match(/[a-z0-9_.]+/g) || []);
  }

  var STOPWORDS = ['the', 'is', 'are', 'a', 'an', 'to', 'of', 'and', 'or', 'what', 'how', 'do', 'does',
    'i', 'my', 'in', 'for', 'with', 'this', 'that', 'can', 'why', 'it', 'on', 'be', 'not', 'when'];

  function meaningfulTokens(text) {
    var tokens = tokenize(text);
    var out = [];
    for (var i = 0; i < tokens.length; i++) {
      if (STOPWORDS.indexOf(tokens[i]) === -1 && tokens[i].length > 1) out.push(tokens[i]);
    }
    return out;
  }

  /**
   * Rank indexed sections against the question using the same token-overlap
   * strategy as search.js, so the chatbot's notion of "relevant" matches
   * what a user would find via the search box.
   */
  function findRelevantSections(question, limit) {
    var index = getIndex();
    var queryTokens = meaningfulTokens(question);
    if (!queryTokens.length) return [];

    var scored = [];
    for (var i = 0; i < index.length; i++) {
      var entry = index[i];
      var titleTokens = tokenize(entry.title);
      var bodyTokens = tokenize(entry.body);
      var score = 0;

      for (var t = 0; t < queryTokens.length; t++) {
        var token = queryTokens[t];
        if (titleTokens.indexOf(token) >= 0) score += 4;
        if (bodyTokens.indexOf(token) >= 0) score += 1;
      }

      if (score > 0) scored.push({ entry: entry, score: score });
    }

    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.slice(0, limit || 3);
  }

  /**
   * Extract the sentence(s) from a section's body that best match the
   * question's tokens, rather than dumping the entire section — this keeps
   * answers grounded and traceable to a specific passage.
   */
  function extractRelevantSentences(body, queryTokens, maxSentences) {
    var sentences = body.split(/(?<=[.!?])\s+/);
    var scored = [];
    for (var i = 0; i < sentences.length; i++) {
      var sentence = sentences[i];
      var lower = sentence.toLowerCase();
      var score = 0;
      for (var t = 0; t < queryTokens.length; t++) {
        if (lower.indexOf(queryTokens[t]) >= 0) score += 1;
      }
      if (score > 0) scored.push({ text: sentence.trim(), score: score, index: i });
    }
    scored.sort(function (a, b) { return b.score - a.score || a.index - b.index; });
    return scored.slice(0, maxSentences || 2).map(function (s) { return s.text; });
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ─── Intent classification ─────────────────────────────────────────────
  //
  // docsprompt.md requires the chatbot to support distinct lookup
  // categories (search ranking, code lookup, API lookup, configuration
  // lookup, FAQ lookup, architecture lookup) rather than one undifferentiated
  // search. classifyIntent() inspects the question for category-specific
  // markers and, when a category is detected, biases which indexed pages/
  // sections are considered and how the answer is framed — all still
  // grounded in the same baked-in index, never inventing content.

  var INTENT_MARKERS = {
    api: ['capture', 'startspan', 'withspan', 'flush', 'shutdown', 'function', 'method',
      'signature', 'parameter', 'return', 'api', 'setuser', 'settag', 'setcontext'],
    configuration: ['config', 'option', 'apikey', 'baseurl', 'setting', 'field', 'default',
      'shutdowntimeoutms', 'maxbreadcrumbs', 'env', 'environment variable'],
    faq: ['faq', 'question', 'why', 'how do i', 'frequently'],
    architecture: ['architecture', 'internal', 'boot', 'pipeline', 'lifecycle', 'design',
      'shutdown sequence', 'batching', 'sampling algorithm', 'design decision'],
    code: ['example', 'sample', 'snippet', 'import', 'code']
  };

  /**
   * Classify a question into zero or one lookup category by counting marker
   * hits per category and returning the highest-scoring one (ties broken by
   * declaration order above). Returns null for a generic query, which falls
   * through to plain search-ranking behavior.
   */
  function classifyIntent(question) {
    var lower = question.toLowerCase();
    var best = null;
    var bestScore = 0;
    for (var category in INTENT_MARKERS) {
      var markers = INTENT_MARKERS[category];
      var score = 0;
      for (var i = 0; i < markers.length; i++) {
        if (lower.indexOf(markers[i]) >= 0) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        best = category;
      }
    }
    return best;
  }

  /**
   * Map a lookup category to the indexed page(s) most likely to hold the
   * answer, and to a URL-fragment prefix used to further bias section
   * selection. Both sdk.html and internal.html use predictable anchor
   * naming (see their <h2 id="..."> values), so a category like
   * "configuration" can prefer sections whose url contains "#configuration"
   * before falling back to full-index ranking.
   */
  var CATEGORY_HINTS = {
    api: { pages: ['SDK Docs'], urlHint: '#manual-api-reference' },
    configuration: { pages: ['SDK Docs'], urlHint: '#configuration' },
    faq: { pages: ['SDK Docs'], urlHint: '#faq' },
    architecture: { pages: ['Internal Guide'], urlHint: null },
    code: { pages: ['SDK Docs'], urlHint: '#manual-api-reference' }
  };

  function findRelevantSectionsForCategory(question, category, limit) {
    var index = getIndex();
    var queryTokens = meaningfulTokens(question);
    var hint = CATEGORY_HINTS[category];
    if (!hint || !queryTokens.length) return findRelevantSections(question, limit);

    var scored = [];
    for (var i = 0; i < index.length; i++) {
      var entry = index[i];
      var titleTokens = tokenize(entry.title);
      var bodyTokens = tokenize(entry.body);
      var score = 0;

      for (var t = 0; t < queryTokens.length; t++) {
        var token = queryTokens[t];
        if (titleTokens.indexOf(token) >= 0) score += 4;
        if (bodyTokens.indexOf(token) >= 0) score += 1;
      }
      if (score === 0) continue;

      // Category bonus: same-page match, and — when the category has a
      // predictable anchor prefix (e.g. "#configuration") — an extra bonus
      // for sections whose url already lives under that anchor.
      if (hint.pages.indexOf(entry.page) >= 0) score += 3;
      if (hint.urlHint && entry.url.indexOf(hint.urlHint) >= 0) score += 3;

      scored.push({ entry: entry, score: score });
    }

    scored.sort(function (a, b) { return b.score - a.score; });
    // If category-biased ranking found nothing, fall back to the plain
    // cross-index search so a mis-classified intent never produces the
    // fallback message when a genuine answer exists elsewhere.
    return scored.length ? scored.slice(0, limit || 3) : findRelevantSections(question, limit);
  }

  /**
   * Build an answer strictly from indexed content. Returns null (meaning:
   * use the fallback string) if nothing scores above the confidence floor.
   *
   * Category-aware: classifyIntent() determines whether this looks like an
   * API, configuration, FAQ, architecture, or code-example question and
   * biases section selection accordingly (findRelevantSectionsForCategory).
   * A generic/unclassified question falls through to plain search ranking
   * (findRelevantSections) — so "search ranking" itself remains one of the
   * supported lookup modes, not replaced by categorization.
   */
  function answerFromDocs(question) {
    var category = classifyIntent(question);
    var sections = category
      ? findRelevantSectionsForCategory(question, category, 3)
      : findRelevantSections(question, 3);

    if (!sections.length || sections[0].score < MIN_SCORE_FOR_ANSWER) {
      return null;
    }

    var queryTokens = meaningfulTokens(question);
    var pieces = [];

    for (var i = 0; i < sections.length; i++) {
      var entry = sections[i].entry;
      var sentences = extractRelevantSentences(entry.body, queryTokens, 2);
      if (!sentences.length) continue;
      pieces.push({
        page: entry.page,
        title: entry.title,
        url: entry.url,
        text: sentences.join(' '),
        category: category,
      });
    }

    if (!pieces.length) return null;
    return pieces;
  }

  function renderAnswer(pieces) {
    var html = '';
    var category = pieces[0] && pieces[0].category;
    if (category) {
      html += '<div style="font-size:10px;text-transform:uppercase;letter-spacing:0.05em;opacity:0.6;margin-bottom:6px;">' +
        escapeHtml(category) + ' lookup</div>';
    }
    for (var i = 0; i < pieces.length; i++) {
      var p = pieces[i];
      html += '<div>' + escapeHtml(p.text) + '</div>';
      html += '<div style="margin-top:4px;font-size:11px;opacity:0.75;">Source: <a href="' + p.url + '">' +
        escapeHtml(p.page) + ' — ' + escapeHtml(p.title) + '</a></div>';
      if (i < pieces.length - 1) html += '<hr style="border:none;border-top:1px solid rgba(120,120,120,0.25);margin:8px 0;">';
    }
    return html;
  }

  // ─── UI wiring ──────────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', function () {
    var toggle = document.querySelector('[data-chatbot-toggle]');
    var panel = document.querySelector('.chatbot-panel');
    var messagesEl = document.querySelector('.chatbot-panel__messages');
    var form = document.querySelector('[data-chatbot-form]');
    var input = document.querySelector('[data-chatbot-input]');
    var closeBtn = document.querySelector('[data-chatbot-close]');

    if (!toggle || !panel || !messagesEl || !form || !input) return;

    var greeted = false;

    function addMessage(html, role) {
      var el = document.createElement('div');
      el.className = 'chat-msg chat-msg--' + role;
      el.innerHTML = html;
      messagesEl.appendChild(el);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function openPanel() {
      panel.classList.add('is-open');
      toggle.setAttribute('aria-expanded', 'true');
      if (!greeted) {
        greeted = true;
        addMessage(
          'Ask me anything about this SDK. I answer only using the documentation on this site — ' +
          'if I can\'t find something, I\'ll tell you rather than guess.',
          'bot'
        );
      }
      setTimeout(function () { input.focus(); }, 0);
    }

    function closePanel() {
      panel.classList.remove('is-open');
      toggle.setAttribute('aria-expanded', 'false');
    }

    toggle.addEventListener('click', function () {
      panel.classList.contains('is-open') ? closePanel() : openPanel();
    });
    if (closeBtn) closeBtn.addEventListener('click', closePanel);

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var question = input.value.trim();
      if (!question) return;

      addMessage(escapeHtml(question), 'user');
      input.value = '';

      // Search-then-answer: look up the docs first, and only ever surface
      // what was found. No external call, no generation beyond extraction.
      var pieces = answerFromDocs(question);
      if (pieces) {
        addMessage(renderAnswer(pieces), 'bot');
      } else {
        addMessage(escapeHtml(FALLBACK), 'bot');
      }
    });
  });

  // Exposed for testing / reuse; also gives other scripts a way to confirm
  // the exact fallback string without duplicating it.
  window.PulseChatbot = { answerFromDocs: answerFromDocs, FALLBACK: FALLBACK };
})();
