// /join: how a new person joins this household, and the code that does it. The QR code is this page's own
// address; the Home Base app's Join screen scans it and fills in the household's address, and the iPhone's
// Camera opens this page. Anyone on the tailnet may open it: the address is no secret, and joining still
// takes the tailnet and the administrator's approval. No navigation: the visitor may not be a member yet.
(function joinPage() {
  const root = document.getElementById('app');
  if (!root) return;
  const esc = (value) => window.HB.escapeHtml(value);
  const address = `${window.location.origin}/join`;
  // With any port: before the ingress cutover Home Base is on :3080, and the app needs it too.
  const host = window.location.host;

  function qrSvg(text) {
    if (typeof window.qrcode !== 'function') return '';
    const qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    const margin = 4;
    const size = count + margin * 2;
    let path = '';
    for (let row = 0; row < count; row += 1) {
      for (let col = 0; col < count; col += 1) {
        if (qr.isDark(row, col)) path += `M${col + margin} ${row + margin}h1v1h-1z`;
      }
    }
    return `<svg data-join-qr role="img" aria-label="This household's join code, for the Home Base app to scan" viewBox="0 0 ${size} ${size}" width="220" height="220" shape-rendering="crispEdges" style="display:block;margin:0.6rem 0;background:#ffffff;border-radius:8px;"><rect width="${size}" height="${size}" fill="#ffffff"/><path d="${path}" fill="#000000"/></svg>`;
  }

  function render(household) {
    const name = household ? esc(household) : 'your household';
    document.title = household ? `Join ${household} - Home Base` : 'Join - Home Base';
    root.innerHTML = `<div class="hb-stack">
      <section class="hb-card">
        <h1 style="margin:0;">Join ${name}</h1>
        <p class="hb-muted">Home Base runs this household's apps. On a new phone:</p>
        <ol style="padding-left:1.2rem;line-height:1.6;">
          <li>Install Tailscale and connect to the household's tailnet. Your administrator invites you.</li>
          <li>Install the Home Base app. Your administrator sends the invitation.</li>
          <li>Open the app, tap <strong>Scan a join code</strong> and scan the code below. Or type the address.</li>
        </ol>
        ${qrSvg(address)}
        <p style="margin:0.4rem 0 0;">Address: <code data-join-host>${esc(host)}</code></p>
        <div class="hb-actions" style="margin-top:0.8rem;">
          <button class="hb-btn" type="button" data-join-copy>Copy address</button>
          <a class="hb-btn" href="/">Open Home Base here</a>
        </div>
        <p class="hb-muted" data-join-copied role="status" style="margin:0.5rem 0 0;"></p>
      </section>
      <section class="hb-card">
        <p class="hb-muted" style="margin:0;">After you join, your administrator adds you in Admin → Members. Until then the app says it's waiting, and checks again on its own.</p>
      </section>
    </div>`;
  }

  root.addEventListener('click', (event) => {
    if (!event.target.closest('[data-join-copy]')) return;
    const status = root.querySelector('[data-join-copied]');
    const clipboard = window.navigator && window.navigator.clipboard;
    if (!clipboard) { if (status) status.textContent = host; return; }
    clipboard.writeText(host)
      .then(() => { if (status) status.textContent = 'Copied.'; })
      .catch(() => { if (status) status.textContent = host; });
  });

  render(null);
  // The household's name, when Home Base gives one: anyone on the tailnet gets it from /api/home.
  window.HB.getHome().then((home) => {
    if (home && typeof home.household === 'string' && home.household) render(home.household);
  }).catch(() => {});
}());
