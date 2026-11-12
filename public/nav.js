(function homeBaseNav() {
  const navItems = [
    { id: 'dashboard', label: 'Dashboard', mobileLabel: 'Home Base', href: '/', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v10h14V10"/></svg>' },
    { id: 'apps', label: 'Apps', href: '/apps', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="8" height="8"/><rect x="13" y="3" width="8" height="8"/><rect x="3" y="13" width="8" height="8"/><rect x="13" y="13" width="8" height="8"/></svg>' },
    { id: 'jobs', label: 'Jobs', href: '/jobs', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/></svg>' },
    { id: 'status', label: 'Status', href: '/status', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12h4l2-5 4 10 2-5h4"/></svg>' },
    { id: 'network', label: 'Network', href: '/network', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="12" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><path d="M8 12h4"/><path d="M16.5 7.5 13 10"/><path d="M16.5 16.5 13 14"/></svg>' },
    { id: 'admin', label: 'Admin', href: '/admin', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l7 4v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V7l7-4z"/><path d="M9.5 12.5 11 14l3.5-4"/></svg>' },
    { id: 'config', label: 'Config', href: '/config', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>' },
  ];

  function renderLinks(activePage, items, { mobile = false } = {}) {
    return items.map((item) => {
      const activeClass = item.id === activePage ? ' is-active' : '';
      const label = (mobile && item.mobileLabel) ? item.mobileLabel : item.label;
      return `<a class="hb-nav-link${activeClass}" href="${item.href}">${item.icon}<span>${label}</span></a>`;
    }).join('');
  }

  let preflightStatus = 'yellow';
  function setStatusDot(status) {
    preflightStatus = status;
    document.querySelectorAll('.hb-status-dot').forEach((dot) => {
      dot.className = `hb-status-dot hb-status-dot--${status}`;
    });
  }

  async function refreshPreflightStatus() {
    const cacheKey = 'hb-preflight-summary-v1';
    const now = Date.now();
    const cachedRaw = sessionStorage.getItem(cacheKey);
    if (cachedRaw) {
      try {
        const cached = JSON.parse(cachedRaw);
        if (cached.expiresAt > now) {
          setStatusDot(cached.status);
          return;
        }
      } catch (_error) {
        // ignore bad cache
      }
    }

    let status = 'yellow';
    try {
      const data = await window.HB.getJson('/api/preflight');
      const checks = Array.isArray(data.checks) ? data.checks : [];
      // ok === null means "not evaluated", which is not a failure; an unreachable executor is its own critical check.
      const criticalFail = checks.some((check) => check.severity === 'critical' && check.ok === false);
      const anyFail = checks.some((check) => check.ok === false);
      status = criticalFail ? 'red' : (anyFail ? 'yellow' : 'green');
    } catch (_error) {
      status = 'yellow';
    }

    setStatusDot(status);
    sessionStorage.setItem(cacheKey, JSON.stringify({ status, expiresAt: now + (30 * 1000) }));
  }

  const LOADING_MSGS = [
    'Asking the server nicely…',
    'Waking up the household…',
    'Rattling the pipes…',
    'Consulting the job queue…',
    'Herding the bits…',
    'Checking in with your private cloud…',
    'Dusting off the dashboard…',
    'Querying the household mainframe…',
    'Pulling state from the VM…',
    'Sovereign home is thinking…',
    'Fetching from the tailnet…',
    'One moment, checking the vitals…',
  ];

  const loadingEl = document.getElementById('hb-loading-msg');
  if (loadingEl) {
    loadingEl.textContent = LOADING_MSGS[Math.floor(Math.random() * LOADING_MSGS.length)];
  }

  const body = document.body;
  body.classList.add('app-has-nav');
  const activePage = body.getAttribute('data-nav-page') || '';

  const sidebar = document.createElement('aside');
  sidebar.className = 'hb-app-sidebar';
  const bottom = document.createElement('nav');
  bottom.className = 'hb-app-bottom-bar';
  const moreSheet = document.createElement('div');
  moreSheet.className = 'hb-more-sheet hidden';
  let hadAdminNavigation = false;

  function updateHomeNavigation(home) {
    const full = home.state === 'legacy' || home.state === 'administrator';
    const homeLink = { ...navItems[0], label: 'Home' };
    const selfService = home.state === 'member';
    const lifecycle = home.state === 'setup' || home.state === 'recovery';
    const items = full ? navItems : [homeLink, ...(selfService || lifecycle ? [{ ...navItems[5],
      label: home.canUnlockAdmin || lifecycle ? 'Admin' : 'Passkeys',
    }] : [])];
    const mobileItems = full ? items.slice(0, 4) : items;
    const moreItems = full ? items.slice(4) : [];
    sidebar.innerHTML = `
      <div class="hb-nav-wordmark">
        <svg class="hb-nav-logo" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M10 2L1 9.5H4V18H9V14H11V18H16V9.5H19L10 2Z"/></svg>
        <span>Home <strong>Base</strong></span>
        ${full ? `<span class="hb-status-dot hb-status-dot--${preflightStatus}" aria-label="System status"></span>` : ''}
      </div>
      ${renderLinks(activePage, items)}
    `;

    const moreActive = moreItems.some((item) => item.id === activePage) ? ' is-active' : '';
    const moreButton = moreItems.length ? `
      <button class="hb-nav-link hb-nav-link--more${moreActive}" id="hb-more-nav-btn" type="button" aria-label="Home Base menu">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="5" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="19" r="1.5" fill="currentColor"/></svg>
        <span>Base</span>
      </button>
    ` : '';
    bottom.innerHTML = renderLinks(activePage, mobileItems, { mobile: true }) + moreButton;

    moreSheet.classList.add('hidden');
    moreSheet.innerHTML = '';
    if (moreItems.length) {
      moreSheet.innerHTML = `
        <div class="hb-more-sheet-backdrop"></div>
        <div class="hb-more-sheet-panel">
          <div class="hb-more-sheet-brand">
            <svg class="hb-nav-logo" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M10 2L1 9.5H4V18H9V14H11V18H16V9.5H19L10 2Z"/></svg>
            <div>
              <div class="hb-more-sheet-title">Home Base</div>
              <div class="hb-more-sheet-copy">Network, admin, and config</div>
            </div>
          </div>
          ${moreItems.map((item) => {
            const activeClass = item.id === activePage ? ' is-active' : '';
            return `<a class="hb-more-sheet-item${activeClass}" href="${item.href}">${item.icon}<span>${item.label}</span></a>`;
          }).join('')}
        </div>
      `;
    }

    showBootstrapBanner(home, full);
    if (full && !hadAdminNavigation) refreshPreflightStatus();
    hadAdminNavigation = full;
  }

  // Only non-home pages need a contextual banner. The landing controller owns its own lifecycle and
  // onboarding messages, so a member's useful Home view is never overlaid with an admin-lock warning.
  let banner = null;
  let bannerObserver = null;
  function showBootstrapBanner(home, full) {
    const main = document.getElementById('app');
    if (!main || activePage === 'dashboard' || activePage === 'admin') return;
    const messages = {
      setup: 'Home Base is in <strong>setup</strong>. The administrator must register two passkeys, including a hardware security key, and finish on Admin.',
      recovery: 'Home Base is in <strong>recovery</strong>. Every session has ended; the administrator must finish recovery on Admin with a hardware key.',
    };
    const message = messages[home.state] || (!full ? 'This page is for your household administrator. <a href="/">Find your apps on Home</a>.' : '');
    if (!message) {
      if (banner) banner.remove();
      banner = null;
      return;
    }
    if (!banner) {
      banner = document.createElement('div');
      banner.className = 'hb-card';
      banner.setAttribute('role', 'status');
      banner.style.cssText = 'border-color:var(--yellow);margin-bottom:1rem;';
    }
    banner.innerHTML = `<p style="margin:0;">${message} ${messages[home.state] ? '<a href="/admin">Go to Admin</a>.' : ''}</p>`;
    main.prepend(banner);
    if (!bannerObserver) {
      bannerObserver = new MutationObserver(() => { if (banner && main.firstElementChild !== banner) main.prepend(banner); });
      bannerObserver.observe(main, { childList: true });
    }
  }

  document.body.appendChild(sidebar);
  document.body.appendChild(bottom);
  document.body.appendChild(moreSheet);
  bottom.addEventListener('click', (event) => {
    if (event.target.closest('#hb-more-nav-btn')) moreSheet.classList.toggle('hidden');
  });
  moreSheet.addEventListener('click', (event) => {
    if (event.target.closest('.hb-more-sheet-backdrop')) moreSheet.classList.toggle('hidden');
  });
  window.HB.updateHomeNavigation = updateHomeNavigation;
  updateHomeNavigation({ state: 'loading' });
  window.HB.getHome().then(updateHomeNavigation).catch(() => updateHomeNavigation({ state: 'unavailable' }));
}());
