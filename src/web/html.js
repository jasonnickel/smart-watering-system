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
    'settings-saved': { tone: 'success', text: 'Settings saved. Login password changes take effect immediately. Restart the web UI only if you changed the host or port.' },
    'settings-error': { tone: 'error', text: 'Settings were not saved. Review the form values and try again.' },
    'setup-saved': { tone: 'success', text: 'Guided setup saved. Run smart-water doctor or refresh the dashboard to verify connectivity.' },
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
    { id: 'logs', label: 'Run History', path: '/logs' },
    { id: 'zones', label: 'Zones', path: '/zones' },
    { id: 'charts', label: 'Charts', path: '/charts' },
    { id: 'briefing', label: 'Briefing', path: '/briefing' },
    { id: 'satellite', label: 'Satellite', path: '/satellite' },
    { id: 'settings', label: 'Settings', path: '/settings' },
    { id: 'setup', label: 'Guided Setup', path: '/setup' },
  ];

  const navHtml = showNav
    ? `<nav class="nav" aria-label="Primary">
        ${tabs.map(tab => `<a href="${tab.path}"${activeTab === tab.id ? ' aria-current="page"' : ''}>${tab.label}</a>`).join('')}
      </nav>`
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
  <title>${escapeHtml(title)} - Smart Water</title>
  <link rel="stylesheet" href="/styles.css">
  <script src="/theme.js"></script>
  <script src="/ai.js" defer></script>
  <script src="/satellite.js" defer></script>
  <link rel="manifest" href="/manifest.json">
  <meta name="theme-color" content="#0b5fff">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <meta name="apple-mobile-web-app-title" content="Smart Water">
  <link rel="apple-touch-icon" href="/icon-192.svg">
</head>
<body>
  <a class="skip-link" href="#main">Skip to main content</a>
  <header class="header">
    <div class="header-inner">
      <div>
        <h1>Smart Water System</h1>
        <p>Optional browser setup for non-coders, plus the same file-and-CLI workflow for power users.</p>
      </div>
      ${headerActionsHtml}
    </div>
  </header>
  ${navHtml}
  <main id="main" class="container">
    ${content}
  </main>
</body>
</html>`;
}
