// Feature-10 SID-006: every Home Base route, who may use it and at what level. Requests are matched here
// before any handler runs; a request that matches no entry is refused (fail closed), so a handler without an
// entry is unreachable and a route can't be added without saying who it is for.
//
// class:
//   public         nothing to protect: page shells (their data comes from the API), static assets, the
//                  lock state, and the health probe the installer runs on the host
//   self           member self-service: acts only on the caller's own credentials, checked by their stable
//                  user ID in the route's own module (the passkey service)
//   administrator  the administrator's
// authority (who decides, for administrator routes):
//   session        an unlocked admin session, checked here before the handler (and again by many handlers,
//                  after the body). Directory on: the administrator's passkey check in active Home Base, or
//                  their passphrase session in setup and recovery. Directory off: the passphrase session.
//   route          the route is how admin is opened, so it authorizes itself (the passphrase, and with the
//                  directory on the recorded administrator's tailnet identity)
// policy: the assurance policy key (sovereignAuth policy.json) the route's level comes from. privileged-plan
// routes run with the session today; the every-time hardware token is SID-006 slice 2.
//
// With the directory on, every administrator route with session authority, reads included, needs the
// unlocked administrator (members use Home Base for their own passkeys only). With it off (hosts not yet on
// Feature-10), only the unknown-route refusal applies here, and each handler keeps the gate it always had.

const ID = '[^/]+';

// [method, path, class, policy, authority]. Paths: literal, or with :id for one path segment.
const ROUTES = [
  // Page shells: the data behind each one is an administrator read.
  ['GET', '/', 'public'],
  ['GET', '/apps', 'public'],
  ['GET', '/apps/:id', 'public'],
  ['GET', '/jobs', 'public'],
  ['GET', '/jobs/:id', 'public'],
  ['GET', '/setup', 'public'],
  ['GET', '/settings', 'public'],
  ['GET', '/status', 'public'],
  ['GET', '/admin', 'public'],
  ['GET', '/config', 'public'],
  ['GET', '/network', 'public'],
  ['GET', '/sovereign-fonts.css', 'public'],
  ['GET', '/api/homebase/health', 'public'],
  ['GET', '/api/admin/status', 'public'],

  // Opening and closing admin.
  ['POST', '/api/admin/setup', 'administrator', 'open-admin', 'route'],
  ['POST', '/api/admin/unlock', 'administrator', 'open-admin', 'route'],
  ['POST', '/api/admin/lock', 'public'],
  ['POST', '/api/directory/recovery', 'administrator', 'open-admin', 'route'],
  ['POST', '/api/admin/rotate', 'administrator', 'privileged-plan'],

  // Member self-service.
  ['GET', '/api/identity/whoami', 'self', 'use-app', 'route'],
  // The administrator's view of the directory, or a member's own: who they are and the household's state.
  ['GET', '/api/directory', 'self', 'use-app', 'route'],
  ['GET', '/_sovereign/auth/stepup.js', 'public'],
  ['GET', '/_sovereign/auth/status', 'self', 'use-app', 'route'],
  ['POST', '/_sovereign/auth/enroll/options', 'self', 'manage-own-credential', 'route'],
  ['POST', '/_sovereign/auth/enroll/finish', 'self', 'manage-own-credential', 'route'],
  ['POST', '/_sovereign/auth/check/options', 'self', 'use-app', 'route'],
  ['POST', '/_sovereign/auth/check/finish', 'self', 'use-app', 'route'],
  ['POST', '/_sovereign/auth/credentials/revoke', 'self', 'manage-own-credential', 'route'],
  ['POST', '/_sovereign/auth/sign-out', 'self', 'use-app', 'route'],
  // The administrator's, in the passkey service: it requires the administrator and an every-time token itself.
  ['POST', '/_sovereign/auth/signing-key/rotate', 'administrator', 'privileged-plan', 'route'],

  // Administrator reads.
  ['GET', '/api/catalog', 'administrator', 'open-admin'],
  ['GET', '/api/state', 'administrator', 'open-admin'],
  ['GET', '/api/apps/health', 'administrator', 'open-admin'],
  ['GET', '/api/apps/updates', 'administrator', 'open-admin'],
  ['GET', '/api/apps/dependencies', 'administrator', 'open-admin'],
  ['GET', '/api/preflight', 'administrator', 'open-admin'],
  ['GET', '/api/homebase/foundation', 'administrator', 'open-admin'],
  ['GET', '/api/homebase/config', 'administrator', 'open-admin'],
  ['GET', '/api/homebase/status', 'administrator', 'open-admin'],
  ['GET', '/api/homebase/bootstrap-status', 'administrator', 'open-admin'],
  ['GET', '/api/homebase/update-plan', 'administrator', 'open-admin'],
  ['GET', '/api/manifest/schema', 'administrator', 'open-admin'],
  ['GET', '/api/network/tailscale', 'administrator', 'open-admin'],
  ['GET', '/api/network/tailscale/publish-plan', 'administrator', 'open-admin'],
  ['GET', '/api/network/tailscale/verify', 'administrator', 'open-admin'],
  ['GET', '/api/ingress', 'administrator', 'open-admin'],
  ['GET', '/api/jobs', 'administrator', 'open-admin'],
  ['GET', '/api/jobs/:id', 'administrator', 'open-admin'],
  ['GET', '/api/admin/audit', 'administrator', 'open-admin'],
  ['GET', '/api/apps/:id/actions', 'administrator', 'open-admin'],
  ['GET', '/api/apps/:id/identity', 'administrator', 'open-admin'],
  ['GET', '/api/apps/:id/backups', 'administrator', 'open-admin'],

  // Administrator changes: settings, the directory, and privileged plans.
  ['POST', '/api/homebase/config', 'administrator', 'privileged-plan'],
  ['POST', '/api/alerts/test', 'administrator', 'open-admin'],
  ['POST', '/api/apps/updates/refresh', 'administrator', 'open-admin'],
  ['POST', '/api/directory/members', 'administrator', 'change-role'],
  ['POST', '/api/directory/members/:id', 'administrator', 'change-role'],
  ['POST', '/api/directory/members/:id/grant', 'administrator', 'open-admin'],
  ['POST', '/api/directory/credentials/:id/revoke', 'administrator', 'open-admin'],
  ['POST', '/api/homebase/runtime-plan', 'administrator', 'open-admin'],
  ['POST', '/api/homebase/update-self', 'administrator', 'privileged-plan'],
  ['POST', '/api/homebase/install-self', 'administrator', 'privileged-plan'],
  ['POST', '/api/bootstrap/plan', 'administrator', 'open-admin'],
  ['POST', '/api/bootstrap/execute', 'administrator', 'privileged-plan'],
  ['POST', '/api/network/tailscale/publish-execute', 'administrator', 'privileged-plan'],
  ['POST', '/api/ingress/cutover', 'administrator', 'privileged-plan'],
  ['POST', '/api/ingress/rollback', 'administrator', 'privileged-plan'],
  ['POST', '/api/ingress/services/:id/confirm', 'administrator', 'privileged-plan'],
  ['POST', '/api/ingress/services/:id/publish', 'administrator', 'privileged-plan'],
  ['POST', '/api/apps/:id/discard-plan', 'administrator', 'open-admin'],
  ['POST', '/api/apps/:id/install-plan', 'administrator', 'open-admin'],
  ['POST', '/api/apps/:id/install', 'administrator', 'privileged-plan'],
  ['POST', '/api/apps/:id/execute', 'administrator', 'privileged-plan'],
  ['POST', '/api/apps/:id/adopt/execute', 'administrator', 'privileged-plan'],
  ['POST', '/api/apps/:id/adopt/abandon', 'administrator', 'open-admin'],
  ['POST', '/api/apps/:id/restart/execute', 'administrator', 'privileged-plan'],
  ['POST', '/api/apps/:id/move-user/execute', 'administrator', 'privileged-plan'],
  ['POST', '/api/apps/:id/backup-plan', 'administrator', 'open-admin'],
  ['POST', '/api/apps/:id/backup/execute', 'administrator', 'privileged-plan'],
  ['POST', '/api/apps/:id/restore-plan', 'administrator', 'open-admin'],
  ['POST', '/api/apps/:id/restore/execute', 'administrator', 'privileged-plan'],
  ['POST', '/api/apps/:id/uninstall/execute', 'administrator', 'privileged-plan'],
];

const CLASSES = new Set(['public', 'self', 'administrator']);
const AUTHORITIES = new Set(['session', 'route']);

function compile([method, path, routeClass, policy = null, authority = 'session']) {
  if (!CLASSES.has(routeClass)) throw new Error(`route ${method} ${path}: unknown class ${routeClass}`);
  if (routeClass !== 'public' && !AUTHORITIES.has(authority)) throw new Error(`route ${method} ${path}: unknown authority ${authority}`);
  if (routeClass !== 'public' && !policy) throw new Error(`route ${method} ${path}: a ${routeClass} route names its policy`);
  const pattern = new RegExp(`^${path.split('/').map((part) => (part === ':id' ? ID : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/')}$`);
  return Object.freeze({ method, path, class: routeClass, policy, authority: routeClass === 'public' ? null : authority, pattern });
}

const MATRIX = Object.freeze(ROUTES.map(compile));

// Static files (page scripts, styles, icons, fonts) are public, and only GETs of names like these. Fonts under
// a configured mount other than /_sovereign/fonts/ are matched by the font resolver in app.js.
const STATIC = /^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:js|css|svg|png|ico|webmanifest|woff2?|ttf|json|txt)$/;
const STATIC_ROUTE = Object.freeze({ method: 'GET', path: '<static file>', class: 'public', policy: null, authority: null, pattern: STATIC });

// The entry for a request, or null. HEAD is a GET without the body.
function routeFor(method, pathname) {
  const verb = method === 'HEAD' ? 'GET' : method;
  const entry = MATRIX.find((route) => route.method === verb && route.pattern.test(pathname));
  if (entry) return entry;
  const served = !pathname.startsWith('/api/') && (!pathname.startsWith('/_sovereign/') || pathname.startsWith('/_sovereign/fonts/'));
  return verb === 'GET' && served && STATIC.test(pathname) ? STATIC_ROUTE : null;
}

module.exports = { MATRIX, STATIC_ROUTE, routeFor };
