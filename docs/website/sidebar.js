/**
 * sidebar.js — sidebar navigation, mobile menu, active-section tracking,
 * table-of-contents scroll spy, reading progress bar, and copy-code buttons.
 * No dependencies.
 */
(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', function () {
    initMobileMenu();
    initSidebarActiveLink();
    initSyntaxHighlighting();
    initCopyButtons();
    initReadingProgress();
    initTocScrollSpy();
    initAnchorLinks();
    initPrevNextKeyboardNav();
  });

  function initMobileMenu() {
    var toggle = document.querySelector('[data-menu-toggle]');
    var sidebar = document.querySelector('.sidebar');
    if (!toggle || !sidebar) return;

    toggle.addEventListener('click', function () {
      var isOpen = sidebar.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    });

    document.addEventListener('click', function (event) {
      if (!sidebar.classList.contains('is-open')) return;
      if (sidebar.contains(event.target) || toggle.contains(event.target)) return;
      sidebar.classList.remove('is-open');
      toggle.setAttribute('aria-expanded', 'false');
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && sidebar.classList.contains('is-open')) {
        sidebar.classList.remove('is-open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  function initSidebarActiveLink() {
    var links = document.querySelectorAll('.sidebar__link');
    var currentPath = window.location.pathname.split('/').pop() || 'index.html';
    var currentHash = window.location.hash;

    for (var i = 0; i < links.length; i++) {
      var link = links[i];
      var href = link.getAttribute('href') || '';
      var linkPath = href.split('#')[0] || currentPath;
      var linkHash = href.indexOf('#') >= 0 ? '#' + href.split('#')[1] : '';

      var samePage = linkPath === '' || linkPath === currentPath;
      var sameHash = currentHash ? linkHash === currentHash : linkHash === '';

      if (samePage && sameHash) {
        link.classList.add('is-active');
        link.setAttribute('aria-current', 'true');
      }
    }
  }

  /**
   * initSyntaxHighlighting — a small, dependency-free tokenizer for the
   * language labels used in this site's code blocks (typescript/javascript,
   * bash, mermaid, json). It runs once per .code-block <pre><code> on load,
   * replacing the code element's textContent with tokenized HTML built from
   * the ORIGINAL plain text — so copy-to-clipboard (which reads
   * `codeEl.textContent` after highlighting) still returns clean, unmarked
   * source, never the injected <span> markup.
   *
   * Deliberately not a full-grammar highlighter (no framework, no grammar
   * files) — it recognizes comments, strings, numbers, common keywords, and
   * function-call identifiers via a handful of ordered regexes, which is
   * sufficient for the short, illustrative snippets used throughout the
   * documentation.
   */
  function initSyntaxHighlighting() {
    var blocks = document.querySelectorAll('.code-block');
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      var codeEl = block.querySelector('pre > code');
      if (!codeEl || codeEl.getAttribute('data-highlighted') === 'true') continue;

      var langLabel = block.querySelector('.code-block__header span');
      var lang = langLabel ? langLabel.textContent.trim().toLowerCase() : 'text';
      var source = codeEl.textContent || '';

      codeEl.innerHTML = highlight(source, lang);
      codeEl.setAttribute('data-highlighted', 'true');
    }
  }

  var KEYWORDS = [
    'import', 'export', 'from', 'const', 'let', 'var', 'function', 'async', 'await',
    'return', 'if', 'else', 'try', 'catch', 'finally', 'throw', 'new', 'class',
    'extends', 'implements', 'interface', 'type', 'enum', 'default', 'void', 'null',
    'undefined', 'true', 'false', 'typeof', 'instanceof', 'this', 'super', 'readonly',
    'public', 'private', 'protected', 'static', 'as', 'in', 'of', 'for', 'while',
    'do', 'break', 'continue', 'switch', 'case', 'yield', 'delete', 'npm', 'install',
    'add', 'run', 'sequenceDiagram', 'participant'
  ];
  var KEYWORD_RE = new RegExp('\\b(' + KEYWORDS.join('|') + ')\\b', 'g');

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /**
   * Tokenize a single line of source into escaped HTML with <span class="tok-*">
   * wrappers, in a fixed precedence order so a token already claimed by an
   * earlier rule (e.g. a string) is never re-matched by a later one (e.g. a
   * keyword appearing inside that string's text).
   */
  function highlightLine(line) {
    // Placeholder-based approach: extract comments and strings first (they
    // must never have their contents re-tokenized), replace with markers,
    // tokenize what's left, then restore.
    var slots = [];

    function stash(match, className) {
      var token = '\u0000' + slots.length + '\u0000';
      slots.push('<span class="' + className + '">' + escapeHtml(match) + '</span>');
      return token;
    }

    var working = line
      // Line comments: // ... or # ...
      .replace(/(\/\/.*$)/g, function (m) { return stash(m, 'tok-com'); })
      .replace(/(^\s*#.*$)/g, function (m) { return stash(m, 'tok-com'); })
      // Strings: 'single', "double", or `template` (non-greedy, no escape handling
      // needed for the short illustrative snippets in this documentation)
      .replace(/('[^'\n]*'|"[^"\n]*"|`[^`\n]*`)/g, function (m) { return stash(m, 'tok-str'); });

    // Numbers (after strings/comments are stashed, so digits inside them are untouched)
    working = working.replace(/\b(\d+(?:\.\d+)?)\b/g, function (m) {
      return '\u0001' + m + '\u0001';
    });

    // Escape remaining plain text, then reinstate keyword spans and number markers.
    var escaped = escapeHtml(working)
      .replace(KEYWORD_RE, '<span class="tok-kw">$1</span>')
      .replace(/\u0001([\d.]+)\u0001/g, '<span class="tok-num">$1</span>')
      // Function-call heuristic: identifier immediately followed by '('
      .replace(/\b([A-Za-z_$][\w$]*)(?=\()/g, '<span class="tok-fn">$1</span>');

    // Restore stashed comment/string spans (already HTML-safe from stash()).
    escaped = escaped.replace(/\u0000(\d+)\u0000/g, function (_, idx) {
      return slots[Number(idx)];
    });

    return escaped;
  }

  function highlight(source, lang) {
    if (lang === 'text' || lang === 'plaintext') return escapeHtml(source);
    var lines = source.split('\n');
    var out = new Array(lines.length);
    for (var i = 0; i < lines.length; i++) {
      out[i] = highlightLine(lines[i]);
    }
    return out.join('\n');
  }


  function initCopyButtons() {
    var blocks = document.querySelectorAll('.code-block');
    for (var i = 0; i < blocks.length; i++) {
      (function (block) {
        var button = block.querySelector('.copy-btn');
        var codeEl = block.querySelector('code');
        if (!button || !codeEl) return;

        button.addEventListener('click', function () {
          var text = codeEl.textContent || '';
          copyToClipboard(text).then(function () {
            var original = button.textContent;
            button.textContent = 'Copied';
            button.classList.add('is-copied');
            setTimeout(function () {
              button.textContent = original;
              button.classList.remove('is-copied');
            }, 1600);
          });
        });
      })(blocks[i]);
    }
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () {
        return fallbackCopy(text);
      });
    }
    return fallbackCopy(text);
  }

  function fallbackCopy(text) {
    return new Promise(function (resolve) {
      var textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
      } catch (err) {
        /* best effort */
      }
      document.body.removeChild(textarea);
      resolve();
    });
  }

  function initReadingProgress() {
    var bar = document.querySelector('.reading-progress');
    var article = document.querySelector('.content article');
    if (!bar || !article) return;

    function update() {
      var docHeight = article.offsetHeight;
      var scrollTop = window.scrollY;
      var winHeight = window.innerHeight;
      var total = Math.max(1, docHeight - winHeight);
      var pct = Math.min(100, Math.max(0, (scrollTop / total) * 100));
      bar.style.width = pct + '%';
    }

    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    update();
  }

  function initTocScrollSpy() {
    var tocLinks = document.querySelectorAll('.toc__link');
    if (!tocLinks.length) return;

    var headings = [];
    for (var i = 0; i < tocLinks.length; i++) {
      var href = tocLinks[i].getAttribute('href') || '';
      var id = href.replace('#', '');
      var el = document.getElementById(id);
      if (el) headings.push({ el: el, link: tocLinks[i] });
    }
    if (!headings.length) return;

    function onScroll() {
      var activeIndex = 0;
      var scrollPos = window.scrollY + 100;
      for (var j = 0; j < headings.length; j++) {
        if (headings[j].el.offsetTop <= scrollPos) activeIndex = j;
      }
      for (var k = 0; k < headings.length; k++) {
        headings[k].link.classList.toggle('is-active', k === activeIndex);
      }
    }

    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  function initAnchorLinks() {
    var headings = document.querySelectorAll('.content h2[id], .content h3[id]');
    for (var i = 0; i < headings.length; i++) {
      var heading = headings[i];
      if (heading.querySelector('.anchor-link')) continue;
      var anchor = document.createElement('a');
      anchor.className = 'anchor-link';
      anchor.href = '#' + heading.id;
      anchor.setAttribute('aria-label', 'Link to this section');
      anchor.textContent = '#';
      heading.appendChild(anchor);
    }
  }

  function initPrevNextKeyboardNav() {
    document.addEventListener('keydown', function (event) {
      // Ignore when typing in an input/textarea or a modifier key is held.
      var tag = (event.target && event.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === 'ArrowLeft') {
        var prev = document.querySelector('.prev-next__link--prev');
        if (prev) window.location.href = prev.getAttribute('href');
      } else if (event.key === 'ArrowRight') {
        var next = document.querySelector('.prev-next__link--next');
        if (next) window.location.href = next.getAttribute('href');
      }
    });
  }
})();
