// Dark mode toggle - persists preference in localStorage
(function () {
  var STORAGE_KEY = 'taproot-theme';
  var html = document.documentElement;

  function getPreferred() {
    var stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
    return null;
  }

  function apply(theme) {
    if (theme) {
      html.setAttribute('data-theme', theme);
    } else {
      // No stored preference - detect from OS and set explicitly so CSS
      // only needs [data-theme] selectors (no duplicated @media block).
      var auto = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      html.setAttribute('data-theme', auto);
    }
    updateIcon();
  }

  function isDark() {
    var theme = html.getAttribute('data-theme');
    if (theme === 'dark') return true;
    if (theme === 'light') return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function updateIcon() {
    var btn = document.getElementById('theme-toggle');
    if (!btn) return;
    btn.textContent = isDark() ? '\u2600' : '\u263D';
    btn.setAttribute('aria-label', isDark() ? 'Switch to light mode' : 'Switch to dark mode');
  }

  function toggle() {
    var next = isDark() ? 'light' : 'dark';
    localStorage.setItem(STORAGE_KEY, next);
    apply(next);
  }

  // Apply stored preference immediately (before paint)
  apply(getPreferred());

  // Bind toggle button and register service worker after DOM loads
  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('theme-toggle');
    if (btn) btn.addEventListener('click', toggle);
    updateIcon();

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(function () {});
    }
  });
})();
