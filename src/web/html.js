// HTML helpers, layout shell, and reusable UI components for the web UI.

export function csrfField(token) {
  if (!token) return '';
  return `<input type="hidden" name="_csrf" value="${escapeHtml(token)}">`;
}

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function selectedAttr(value, expected) {
  return value === expected ? ' selected' : '';
}

export function button(label, variant = 'primary', extra = '') {
  return `<button class="btn btn-${variant}" type="submit"${extra}>${label}</button>`;
}

export function badge(label, tone = 'neutral') {
  return `<span class="badge badge-${tone}">${escapeHtml(label)}</span>`;
}

export function moistureBar(pct) {
  const color = pct < 40 ? '#b42318' : pct < 60 ? '#a15c00' : '#0f7b3e';
  return `<div class="meter" aria-label="${pct}% soil moisture">
    <div class="meter-track">
      <div class="meter-fill" style="width:${Math.min(pct, 100)}%;background:${color};"></div>
    </div>
    <span class="meter-value">${pct}%</span>
  </div>`;
}

export function currentNotice(query) {
  const message = query?.get('msg');
  const notices = {
    'manual-started': { tone: 'info', text: 'Manual watering run started. Check Run History in a few seconds.' },
    'live-on': { tone: 'success', text: 'Live mode enabled. Future WATER decisions will actuate your Rachio controller.' },
    'shadow-on': { tone: 'warning', text: 'Shadow mode enabled. Future decisions will be logged without actuating Rachio.' },
    'zones-saved': { tone: 'success', text: 'Zone configuration saved.' },
    'zones-error': { tone: 'error', text: 'Zone configuration was not saved. Review the values and try again.' },
    'settings-saved': { tone: 'success', text: 'Settings saved. Credential and location changes take effect immediately. If you changed the dashboard URL or startup-service choice, refresh it with taproot service install-web.' },
    'settings-error': { tone: 'error', text: 'Settings were not saved. Review the form values and try again.' },
    'next-steps-saved': { tone: 'success', text: 'Next steps checklist saved.' },
    'setup-saved': { tone: 'success', text: 'Guided setup saved. Run taproot doctor, then taproot service install-web if you want the dashboard available at a stable bookmark URL.' },
    'setup-error': { tone: 'error', text: 'Guided setup was not saved. Review the form values and try again.' },
    'smoke-started': { tone: 'warning', text: 'Live smoke test started. Watch Run History and your controller for the result.' },
    'login-required': { tone: 'warning', text: 'Sign in to use the web UI.' },
    'bad-auth': { tone: 'error', text: 'The password was incorrect.' },
    'logged-out': { tone: 'info', text: 'You are signed out.' },
  };
  return notices[message] || null;
}

export function noticeBanner(query) {
  const notice = currentNotice(query);
  if (!notice) return '';
  return `<div class="card notice notice-${notice.tone}" role="${notice.tone === 'error' ? 'alert' : 'status'}" aria-live="polite">
    ${escapeHtml(notice.text)}
  </div>`;
}

export function layout(title, content, activeTab, options = {}) {
  const { showNav = true, authEnabled = false, csrf = '' } = options;
  const tabs = [
    { id: 'dashboard', label: 'Dashboard', path: '/' },
    { id: 'logs', label: 'History', path: '/logs' },
    { id: 'zones', label: 'Zones', path: '/zones' },
    { id: 'charts', label: 'Charts', path: '/charts' },
    { id: 'settings', label: 'Settings', path: '/settings' },
  ];

  const navHtml = showNav
    ? `<nav class="nav" aria-label="Primary">
        ${tabs.map(tab => `<a href="${tab.path}"${activeTab === tab.id ? ' aria-current="page"' : ''}>${tab.label}</a>`).join('')}
      </nav>`
    : '';

  const footerHtml = showNav
    ? `<footer class="footer" aria-label="Footer navigation">
        <nav class="footer-nav">
          ${tabs.map(tab => `<a href="${tab.path}"${activeTab === tab.id ? ' aria-current="page"' : ''}>${tab.label}</a>`).join('')}
        </nav>
      </footer>`
    : '';

  const headerActionsHtml = showNav ? `<div class="header-actions">
      <button id="theme-toggle" class="theme-toggle" type="button" aria-label="Toggle dark mode"></button>
      ${authEnabled ? `<form method="POST" action="/logout" style="margin:0">
        ${csrfField(csrf)}
        ${button('Sign Out', 'secondary')}
      </form>` : ''}
    </div>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)} - Taproot</title>
  <link rel="stylesheet" href="/styles.css?v=20260422">
  <script src="/theme.js?v=20260422"></script>
  <script src="/ai.js?v=20260422" defer></script>
  <script src="/satellite.js?v=20260422" defer></script>
  <link rel="manifest" href="/manifest.json">
  <link rel="icon" href="/icon-192.svg" type="image/svg+xml">
  <meta name="theme-color" content="#0b5fff">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <meta name="apple-mobile-web-app-title" content="Taproot">
  <link rel="apple-touch-icon" href="/icon-192.svg">
</head>
<body>
  <a class="skip-link" href="#main">Skip to main content</a>
  <header class="header">
    <div class="header-inner">
      <div class="header-spacer" aria-hidden="true"></div>
      <a class="header-title" href="/" aria-label="Go to dashboard">
        <span class="header-logo">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true" width="28" height="28">
            <path fill="currentColor" d="M12 2.5c-.6 0-1.14.32-1.44.83C8.9 6 5 12.07 5 15.5a7 7 0 0 0 14 0c0-3.43-3.9-9.5-5.56-12.17A1.67 1.67 0 0 0 12 2.5zm0 3.04c1.77 2.94 5 8.37 5 9.96a5 5 0 0 1-10 0c0-1.59 3.23-7.02 5-9.96z"/>
            <path fill="currentColor" opacity="0.5" d="M12 10.5c-1.66 0-3 1.34-3 3 0 .28.22.5.5.5s.5-.22.5-.5c0-1.1.9-2 2-2 .28 0 .5-.22.5-.5s-.22-.5-.5-.5z"/>
          </svg>
        </span>
        <span class="header-text">
          <h1>Taproot</h1>
          <p>Smart Irrigation System</p>
        </span>
      </a>
      ${headerActionsHtml}
    </div>
  </header>
  ${navHtml}
  <main id="main" class="container">
    ${content}
  </main>
  ${footerHtml}
</body>
</html>`;
}
