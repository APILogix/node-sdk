// ==========================================================================
// Pulse SDK Documentation - JavaScript
// Navigation, search, and interactive functionality
// ==========================================================================

document.addEventListener('DOMContentLoaded', function() {
  initTheme();
  initNavigation();
  initSearch();
  initCollapsibles();
  initCodeCopy();
  initMobileMenu();
});

// Theme Toggle
function initTheme() {
  const toggle = document.getElementById('theme-toggle');
  if (!toggle) return;

  const savedTheme = localStorage.getItem('docs-theme');
  if (savedTheme) {
    document.documentElement.setAttribute('data-theme', savedTheme);
  }

  toggle.addEventListener('click', function() {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('docs-theme', next);
  });
}

// Navigation Active State
function initNavigation() {
  const navLinks = document.querySelectorAll('.nav-link');
  const currentPage = window.location.pathname.split('/').pop() || 'index.html';

  navLinks.forEach(link => {
    const href = link.getAttribute('href');
    if (href && href.includes(currentPage) && currentPage !== '') {
      link.classList.add('active');
    }
  });

  // Set index as default active
  if (currentPage === '' || currentPage === 'docs') {
    const indexLink = document.querySelector('.nav-link[href="index.html"]');
    if (indexLink) indexLink.classList.add('active');
  }
}

// Search Functionality
function initSearch() {
  const searchBox = document.getElementById('search-input');
  if (!searchBox) return;

  searchBox.addEventListener('input', function(e) {
    const query = e.target.value.toLowerCase().trim();
    if (!query) {
      clearSearchHighlights();
      return;
    }
    performSearch(query);
  });
}

function performSearch(query) {
  clearSearchHighlights();
  
  const content = document.querySelector('.content-body');
  if (!content) return;

  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, null);
  const highlights = [];

  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = node.textContent.toLowerCase();
    
    if (text.includes(query)) {
      highlights.push(node.parentElement);
    }
  }

  highlights.forEach(el => {
    el.style.backgroundColor = 'var(--warning)';
    el.style.padding = '2px 4px';
    el.style.borderRadius = '4px';
  });

  if (highlights.length > 0) {
    highlights[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function clearSearchHighlights() {
  const highlighted = document.querySelectorAll('.content-body [style*="background-color: var(--warning)"]');
  highlighted.forEach(el => {
    el.style.backgroundColor = '';
    el.style.padding = '';
    el.style.borderRadius = '';
  });
}

// Collapsible Sections
function initCollapsibles() {
  const headers = document.querySelectorAll('.collapsible-header');
  
  headers.forEach(header => {
    header.addEventListener('click', function() {
      const collapsible = this.parentElement;
      collapsible.classList.toggle('open');
    });
  });
}

// Code Copy Button
function initCodeCopy() {
  const codeBlocks = document.querySelectorAll('pre');
  
  codeBlocks.forEach(block => {
    const wrapper = document.createElement('div');
    wrapper.className = 'code-wrapper';
    
    const header = document.createElement('div');
    header.className = 'code-header';
    
    const lang = detectLanguage(block.textContent);
    const langSpan = document.createElement('span');
    langSpan.className = 'code-lang';
    langSpan.textContent = lang;
    
    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.onclick = function() {
      navigator.clipboard.writeText(block.textContent).then(() => {
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
      });
    };
    
    header.appendChild(langSpan);
    header.appendChild(copyBtn);
    
    block.parentNode.insertBefore(wrapper, block);
    wrapper.appendChild(header);
    wrapper.appendChild(block);
  });
}

function detectLanguage(code) {
  if (code.includes('function') || code.includes('const ') || code.includes('=>')) {
    return 'TypeScript';
  }
  if (code.includes('<html') || code.includes('<!DOCTYPE')) {
    return 'HTML';
  }
  if (code.includes('{') && code.includes(':')) {
    return 'JSON';
  }
  return 'Code';
}

// Mobile Menu
function initMobileMenu() {
  const sidebar = document.querySelector('.sidebar');
  const menuToggle = document.createElement('button');
  menuToggle.className = 'mobile-menu-toggle';
  menuToggle.innerHTML = '&#9776;';
  menuToggle.style.cssText = 'display: none; position: fixed; top: 10px; left: 10px; z-index: 200; background: var(--accent-primary); color: white; border: none; padding: 10px; border-radius: 5px; cursor: pointer;';
  
  document.body.appendChild(menuToggle);
  
  menuToggle.addEventListener('click', function() {
    sidebar.classList.toggle('open');
  });
  
  const mediaQuery = window.matchMedia('(max-width: 768px)');
  if (mediaQuery.matches) {
    menuToggle.style.display = 'block';
  }
  
  mediaQuery.addEventListener('change', function(e) {
    menuToggle.style.display = e.matches ? 'block' : 'none';
    if (!e.matches) {
      sidebar.classList.remove('open');
    }
  });
}

// Keyboard shortcuts
document.addEventListener('keydown', function(e) {
  // "/" to focus search
  if (e.key === '/' && !e.ctrlKey && !e.metaKey) {
    const search = document.getElementById('search-input');
    if (search) {
      e.preventDefault();
      search.focus();
    }
  }
  
  // Escape to clear search
  if (e.key === 'Escape') {
    const search = document.getElementById('search-input');
    if (search) {
      search.value = '';
      clearSearchHighlights();
    }
  }
});