/**
 * Pulse Observability Platform - Client Engine
 * Provides Global Search, Waterfall Rendering, Span Inspector Drawer, and Filtering.
 */

// Shared Header Navigation Generator
export function renderTopNav(activePage = '') {
  const nav = document.createElement('nav');
  nav.className = 'top-nav';
  nav.innerHTML = `
    <div class="brand-section">
      <a href="index.html" class="brand-logo">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>
        </svg>
        <span>Pulse APM</span>
      </a>
      <span class="brand-badge">Cubicle Raw Telemetry</span>
    </div>

    <ul class="nav-links">
      <li class="nav-item ${activePage === 'overview' ? 'active' : ''}"><a href="index.html">Overview</a></li>
      <li class="nav-item ${activePage === 'requests' ? 'active' : ''}"><a href="requests.html">Requests</a></li>
      <li class="nav-item ${activePage === 'traces' ? 'active' : ''}"><a href="traces.html">Traces</a></li>
      <li class="nav-item ${activePage === 'errors' ? 'active' : ''}"><a href="errors.html">Errors</a></li>
      <li class="nav-item ${activePage === 'logs' ? 'active' : ''}"><a href="logs.html">Logs</a></li>
      <li class="nav-item ${activePage === 'databases' ? 'active' : ''}"><a href="databases.html">Databases</a></li>
      <li class="nav-item ${activePage === 'services' ? 'active' : ''}"><a href="services.html">Services</a></li>
      <li class="nav-item ${activePage === 'raw-events' ? 'active' : ''}"><a href="raw-events.html">Raw Events</a></li>
      <li class="nav-item ${activePage === 'diagnostics' ? 'active' : ''}"><a href="diagnostics.html">Diagnostics</a></li>
    </ul>

    <div class="nav-status">
      <div class="search-box">
        <span class="search-icon">🔍</span>
        <input type="text" id="global-search-input" placeholder="Search Trace / Span / ID / Error..." autocomplete="off">
        <div id="search-dropdown" class="search-results-dropdown" style="display:none;"></div>
      </div>
      <div class="status-indicator" title="Captured telemetry from cubicle-be">
        <span class="status-dot"></span>
        <span>@pulse-apm/node 8.1.2</span>
      </div>
    </div>
  `;

  document.body.prepend(nav);
  setupGlobalSearch();
}

// Global Search System (Section 20)
async function setupGlobalSearch() {
  const input = document.getElementById('global-search-input');
  const dropdown = document.getElementById('search-dropdown');
  if (!input || !dropdown) return;

  // Lazy cache of search targets
  let searchIndex = null;

  async function loadSearchIndex() {
    if (searchIndex) return searchIndex;
    try {
      const [tracesRes, reqsRes, errsRes] = await Promise.all([
        fetch('data/traces_index.json').then(r => r.json()),
        fetch('data/requests.json').then(r => r.json()),
        fetch('data/errors.json').then(r => r.json())
      ]);
      searchIndex = {
        traces: tracesRes,
        requests: reqsRes,
        errors: errsRes.errors
      };
      return searchIndex;
    } catch (e) {
      console.warn('Search index load failed:', e);
      return null;
    }
  }

  input.addEventListener('input', async () => {
    const q = input.value.trim().toLowerCase();
    if (!q || q.length < 2) {
      dropdown.style.display = 'none';
      return;
    }

    const idx = await loadSearchIndex();
    if (!idx) return;

    const matches = [];

    // Check traces
    for (const t of idx.traces) {
      if (t.traceId.toLowerCase().includes(q) || (t.name && t.name.toLowerCase().includes(q))) {
        matches.push({ type: 'Trace', id: t.traceId, title: t.name, link: `trace-detail.html?traceId=${t.traceId}`, sub: `${(t.duration || 0).toFixed(1)}ms - ${t.spanCount} spans` });
        if (matches.length >= 8) break;
      }
    }

    // Check requests
    for (const r of idx.requests) {
      if ((r.requestId && r.requestId.toLowerCase().includes(q)) || (r.url && r.url.toLowerCase().includes(q)) || (r.traceId && r.traceId.toLowerCase().includes(q))) {
        matches.push({ type: 'Request', id: r.requestId, title: `${r.method} ${r.url}`, link: `trace-detail.html?traceId=${r.traceId}`, sub: `Status ${r.statusCode} (${r.latency}ms)` });
        if (matches.length >= 15) break;
      }
    }

    // Check errors
    for (const e of idx.errors) {
      if ((e.message && e.message.toLowerCase().includes(q)) || (e.eventId && e.eventId.toLowerCase().includes(q)) || (e.traceId && e.traceId.toLowerCase().includes(q))) {
        matches.push({ type: 'Error', id: e.eventId, title: `${e.name}: ${e.message.slice(0, 40)}`, link: `errors.html#${e.eventId}`, sub: `Trace: ${e.traceId?.slice(0, 10)}...` });
        if (matches.length >= 20) break;
      }
    }

    if (matches.length === 0) {
      dropdown.innerHTML = `<div style="padding:10px 14px;color:#9ca3af;font-size:12px;">No matches for "${q}"</div>`;
    } else {
      dropdown.innerHTML = matches.map(m => `
        <a href="${m.link}" class="search-item" style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid #1e293b;color:#f3f4f6;text-decoration:none;">
          <div>
            <span class="badge badge-${m.type.toLowerCase()}" style="margin-right:6px;font-size:10px;">${m.type}</span>
            <span style="font-weight:500;font-size:12px;">${escapeHtml(m.title)}</span>
          </div>
          <span style="font-size:11px;color:#9ca3af;font-family:monospace;">${m.sub}</span>
        </a>
      `).join('');
    }

    Object.assign(dropdown.style, {
      display: 'block',
      position: 'absolute',
      top: '36px',
      right: '0',
      width: '450px',
      maxHeight: '380px',
      overflowY: 'auto',
      backgroundColor: '#111827',
      border: '1px solid #374151',
      borderRadius: '6px',
      boxShadow: '0 10px 25px rgba(0,0,0,0.8)',
      zIndex: '1500'
    });
  });

  document.addEventListener('click', (e) => {
    if (!input.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.style.display = 'none';
    }
  });
}

// Utility: HTML Escaping
export function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Utility: Format Duration
export function formatDuration(ms) {
  if (ms == null) return 'N/A';
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(2)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

// Utility: Format Timestamp
export function formatTime(ts) {
  if (!ts) return 'N/A';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
}

// Copy to Clipboard Utility
export function copyToClipboard(text, btnElement) {
  navigator.clipboard.writeText(text).then(() => {
    if (btnElement) {
      const orig = btnElement.innerText;
      btnElement.innerText = 'Copied!';
      setTimeout(() => btnElement.innerText = orig, 1500);
    }
  });
}
