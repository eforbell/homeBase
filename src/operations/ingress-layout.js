// Identity-safe ingress (Feature-10 SID-001, D14/D20/D21). Each Tailscale Service targets its own root-only
// nginx socket; each socket's server block serves only that service's mounts. The planner's preview and
// the root executor both render from here, so the two deployment paths cannot drift apart.
//
// Services, per household instance (one host = one instance, D5):
//   svc:<instance>-home      low-friction apps
//   svc:<instance>-homebase  Home Base admin
//   svc:<instance>-<slug>    one per sensitive app (catalog network.dedicatedHostname), slug from its mount path
// Host paths use the bare service key (home, homebase, <slug>), so they never depend on the instance.

const SERVE_SOCKET_DIR = '/run/sovereign-serve';
const APP_SNIPPET_DIR = '/etc/nginx/sovereign-home.d';
const IDENTITY_SNIPPET = '/etc/nginx/sovereign-identity.conf';
const IDENTITY_LOCATION = '/_sovereign/identity';
const AUTH_MOUNT = '/_sovereign/auth/';
// Shared fonts, served on every hostname so each app loads them from its own origin (local font mode).
const FONTS_MOUNT = '/_sovereign/fonts/';
const FONTS_DIR = '/opt/sovereign-home/assets/fonts/';
// Home Base answers identity lookups on its own socket (D1); nginx reaches it, apps never do.
const HOMEBASE_IDENTITY_SOCKET = '/run/homebase-identity/identity.sock'; // inside HOMEBASE_RUNTIME_DIR
// Home Base admin stays on loopback TCP until SID-005 moves it to its socket.
const HOMEBASE_UPSTREAM = 'http://127.0.0.1:3080';
const HOME_SERVICE = 'home';
const HOMEBASE_SERVICE = 'homebase';
// First line of the socket gateway; the executor reads it to refuse writing a TCP gateway over it.
const SOCKET_GATEWAY_MARKER = '# sovereign-ingress: sockets';
const TMPFILES_PATH = '/etc/tmpfiles.d/sovereign-serve.conf';
// The identity socket's directory: Home Base listens there and only nginx's group may enter (D1). Not
// /run/homebase: that is the root executor's, and it must stay root-owned (executor/maintenance.js).
const HOMEBASE_RUNTIME_DIR = '/run/homebase-identity';
const TMPFILES_CONTENT = [
  '# Managed by Home Base (Feature-10 SID-001).',
  '# nginx sockets that Tailscale Serve targets: root only.',
  `d ${SERVE_SOCKET_DIR} 0700 root root -`,
  "# Home Base's identity socket: Home Base listens, nginx (www-data) connects, nobody else enters.",
  `d ${HOMEBASE_RUNTIME_DIR} 0750 homebase www-data -`,
  '',
].join('\n');

// A service key is one DNS label fragment without '--', so '<key>--*.conf' globs can never overlap.
const SERVICE_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// The instance prefixes every service name: svc:<instance>-<key> must stay a valid 63-character label.
const INSTANCE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const RESERVED_KEYS = new Set([HOME_SERVICE, HOMEBASE_SERVICE]);

class IngressLayoutError extends Error {}

function fail(message) { throw new IngressLayoutError(message); }

// The service key an app is served under. Sensitive apps get their own hostname, named after their mount.
function appServiceKey(app) {
  if (app?.network?.dedicatedHostname == null || app.network.dedicatedHostname === false) return HOME_SERVICE;
  if (app.network.dedicatedHostname !== true) fail('dedicatedHostname must be true or false');
  const slug = /^\/([a-z0-9-]+)\/$/.exec(app.network.preferredMountPath || '')?.[1];
  if (!slug || !SERVICE_KEY.test(slug)) fail("a dedicated hostname needs a mount path like /name/ without '--'");
  if (RESERVED_KEYS.has(slug)) fail(`mount path /${slug}/ is reserved for the ${slug} service`);
  return slug;
}

// Where an app's nginx locations live. The service prefix lets each socket block include only its own
// apps, while a pre-cutover gateway that includes sovereign-home.d/*.conf still serves every app.
function appSnippetPath(app) {
  return `${APP_SNIPPET_DIR}/${appServiceKey(app)}--${app.id}.conf`;
}

// Before SID-001 each app's snippet was sovereign-home.d/<app id>.conf; writing the new one removes it.
function legacyAppSnippetPath(app) {
  return `${APP_SNIPPET_DIR}/${app.id}.conf`;
}

function serviceKeys(apps) {
  const keys = [HOME_SERVICE, HOMEBASE_SERVICE];
  const owners = new Map();
  for (const app of apps) {
    let key;
    try { key = appServiceKey(app); } catch (error) { fail(`${app.id}: ${error.message}`); }
    if (key === HOME_SERVICE) continue;
    if (owners.has(key)) fail(`${app.id} and ${owners.get(key)} would share the ${key} service`);
    owners.set(key, app.id);
    keys.push(key);
  }
  return keys;
}

function validateInstance(instance) {
  const value = String(instance || '');
  if (!INSTANCE.test(value)) return 'instance must be lowercase letters, numbers, and single dashes, starting with a letter';
  if (value.length > 24) return 'instance must be 24 characters or fewer';
  return null;
}

function requireInstance(instance) {
  const problem = validateInstance(instance);
  if (problem) fail(problem);
  return instance;
}

function serviceName(instance, key) {
  return `svc:${requireInstance(instance)}-${key}`;
}

function serviceSocket(key) {
  return `${SERVE_SOCKET_DIR}/${key}.sock`;
}

// The hostname members use: <instance>-<key>.<tailnet domain>, e.g. smith-home.example-tailnet.ts.net.
function serviceHostname(instance, key, domain) {
  return `${requireInstance(instance)}-${key}.${domain}`;
}

// The address members use for an app: its service hostname once the host is cut over (ingress is the
// executor's cutover record, or Home Base's view of it), otherwise the host's own name.
function appPublicBase(app, { site, ingress = null }) {
  return ingress ? `https://${serviceHostname(ingress.instance, appServiceKey(app), ingress.domain)}` : `https://${site.hostname}.${site.domain}`;
}

// Low-friction apps share svc:<instance>-home; Home Base and sensitive apps are each their own site (D20).
function isStrictService(key) {
  return key !== HOME_SERVICE;
}

// Every service this host can serve, in a fixed order: home, homebase, then sensitive apps by key.
function ingressServices({ instance, domain, apps }) {
  requireInstance(instance);
  const [home, homebase, ...sensitive] = serviceKeys(apps);
  return [home, homebase, ...sensitive.sort()].map((key) => ({
    key,
    name: serviceName(instance, key),
    hostname: serviceHostname(instance, key, domain),
    socket: serviceSocket(key),
    strict: isStrictService(key),
    appIds: apps.filter((app) => appServiceKey(app) === key).map((app) => app.id),
  }));
}

function serveTarget(key) {
  return `unix:${serviceSocket(key)}`;
}

// Included inside every proxied location: nginx drops inherited proxy_set_header directives once a
// location sets any of its own, so identity must be set where the proxy_pass is. Every identity header
// is overwritten from the lookup's answer; an empty value means nginx omits the header (no identity).
// Serve already overwrote X-Forwarded-For and X-Forwarded-Host (spike 3), and the server block refused
// any X-Forwarded-Host that is not this service's hostname.
function renderIdentitySnippet() {
  return [
    '# Managed by Home Base: identity for every proxied location (Feature-10 D1). Do not edit.',
    `auth_request ${IDENTITY_LOCATION};`,
    'auth_request_set $sovereign_user_id $upstream_http_x_sovereign_user_id;',
    'auth_request_set $sovereign_login $upstream_http_x_sovereign_login;',
    'auth_request_set $sovereign_name $upstream_http_x_sovereign_name;',
    'proxy_set_header X-Sovereign-User-Id $sovereign_user_id;',
    'proxy_set_header X-Sovereign-Login $sovereign_login;',
    'proxy_set_header X-Sovereign-Name $sovereign_name;',
    'proxy_set_header Tailscale-User-Login "";',
    'proxy_set_header Tailscale-User-Name "";',
    'proxy_set_header Tailscale-User-Profile-Pic "";',
    'proxy_set_header Host $http_x_forwarded_host;',
    'proxy_set_header X-Forwarded-Host $http_x_forwarded_host;',
    'proxy_set_header X-Forwarded-For $http_x_forwarded_for;',
    'proxy_set_header X-Forwarded-Proto https;',
    '',
  ].join('\n');
}

// identity: socket ingress (the identity snippet sets every forwarded header). Otherwise the host still
// runs the pre-SID-001 TCP gateway, which has no identity lookup, so locations forward as they always did.
function proxyLocation({ mountPath, upstream, clientMaxBodySize = null, identity = true }) {
  const base = mountPath.replace(/\/$/, '');
  return [
    `location = ${base} {`,
    `    return 301 ${mountPath};`,
    '}',
    `location ${mountPath} {`,
    ...(clientMaxBodySize ? [`    client_max_body_size ${clientMaxBodySize};`] : []),
    `    proxy_pass ${upstream};`,
    ...(identity ? [`    include ${IDENTITY_SNIPPET};`] : [
      '    proxy_set_header Host $host;',
      '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
      '    proxy_set_header X-Forwarded-Proto $scheme;',
    ]),
    `    proxy_set_header X-Forwarded-Prefix ${base};`,
    '}',
  ];
}

// An app's locations (from its catalog layout), for a socket-ingress host (identity) or a TCP one.
// preserveMountPath passes /mount/... through unchanged (proxy_pass without a URI); otherwise nginx
// strips the mount path. Published sidecars get their own, longer (so more specific) location.
function renderAppLocations(layout, { identity = true } = {}) {
  return [
    `# ${layout.app.id}`,
    ...proxyLocation({ mountPath: layout.mountPath, upstream: `http://127.0.0.1:${layout.port}${layout.preserveMountPath ? '' : '/'}`, clientMaxBodySize: layout.clientMaxBodySize, identity }),
    ...layout.sidecars.filter((sidecar) => sidecar.nginx).flatMap((sidecar) => [
      `# ${sidecar.name}`,
      ...proxyLocation({ mountPath: sidecar.nginx.mountPath, upstream: `http://127.0.0.1:${sidecar.port}${sidecar.nginx.upstreamPath}`, identity }),
    ]),
    '',
  ].join('\n');
}

function nginxRegexLiteral(value) {
  return value.replace(/\./g, '\\.');
}

function renderServerBlock(service) {
  const indent = (lines) => lines.map((line) => (line ? `    ${line}` : line));
  const lookup = [
    `location = ${IDENTITY_LOCATION} {`,
    '    internal;',
    `    proxy_pass http://unix:${HOMEBASE_IDENTITY_SOCKET}:${IDENTITY_LOCATION};`,
    '    proxy_pass_request_body off;',
    '    proxy_pass_request_headers off;',
    '    proxy_set_header Content-Length "";',
    // Serve sets both from the tailnet connection, replacing client copies (spike 1, spike 3).
    '    proxy_set_header X-Sovereign-Client-Addr $http_x_forwarded_for;',
    '    proxy_set_header X-Sovereign-Serve-Login $http_tailscale_user_login;',
    `    proxy_set_header X-Sovereign-Service ${service.name};`,
    '}',
  ];
  const auth = service.strict ? [
    // The passkey service (SID-005). Never on the home hostname: ceremonies and credential management
    // only run where a sibling app cannot drive them (D17, D21).
    `location ${AUTH_MOUNT} {`,
    `    proxy_pass ${HOMEBASE_UPSTREAM};`,
    `    include ${IDENTITY_SNIPPET};`,
    '}',
  ] : [];
  const admin = service.key === HOMEBASE_SERVICE ? [
    'location / {',
    `    proxy_pass ${HOMEBASE_UPSTREAM};`,
    `    include ${IDENTITY_SNIPPET};`,
    '}',
  ] : [
    `include ${APP_SNIPPET_DIR}/${service.key}--*.conf;`,
    'location / {',
    '    return 404;',
    '}',
  ];
  return [
    `# ${service.name}: ${service.appIds.length ? service.appIds.join(', ') : (service.key === HOMEBASE_SERVICE ? 'Home Base admin' : 'no apps')}`,
    'server {',
    ...indent([
      `listen unix:${service.socket};`,
      'server_name _;',
      'absolute_redirect off;',
      // Serve sets X-Forwarded-Host to the hostname the member asked for; any other is a misrouted service.
      `if ($http_x_forwarded_host !~ "^${nginxRegexLiteral(service.hostname)}(:443)?$") {`,
      '    return 421;',
      '}',
      // Sensitive and Home Base pages are never framed, including the passkey pages (D20).
      ...(service.strict ? ['add_header Content-Security-Policy "frame-ancestors \'none\'" always;'] : []),
      '',
      ...lookup,
      '',
      `location ${FONTS_MOUNT} {`,
      `    alias ${FONTS_DIR};`,
      '}',
      ...(auth.length ? ['', ...auth] : []),
      '',
      ...admin,
    ]),
    '}',
  ].join('\n');
}

// The managed gateway site: one socket server block per service and no TCP listener (spike 1: a 0.0.0.0
// listener also blocks Serve's own :443). Every service block is rendered whether or not its apps are
// installed, so installing or removing an app never changes which hostnames nginx answers for.
function renderGatewaySite({ instance, domain, apps }) {
  const services = ingressServices({ instance, domain, apps });
  return [
    SOCKET_GATEWAY_MARKER,
    '# Managed by Home Base (Feature-10 SID-001). Tailscale Serve targets one socket per service;',
    '# nothing here listens on TCP. Apps mount from sovereign-home.d/<service>--<app>.conf.',
    '',
    services.map(renderServerBlock).join('\n\n'),
    '',
  ].join('\n');
}

module.exports = {
  APP_SNIPPET_DIR,
  AUTH_MOUNT,
  HOMEBASE_IDENTITY_SOCKET,
  HOMEBASE_RUNTIME_DIR,
  HOMEBASE_SERVICE,
  HOME_SERVICE,
  IDENTITY_LOCATION,
  IDENTITY_SNIPPET,
  IngressLayoutError,
  SERVE_SOCKET_DIR,
  SOCKET_GATEWAY_MARKER,
  TMPFILES_CONTENT,
  TMPFILES_PATH,
  appPublicBase,
  appServiceKey,
  appSnippetPath,
  ingressServices,
  legacyAppSnippetPath,
  renderAppLocations,
  renderGatewaySite,
  renderIdentitySnippet,
  serveTarget,
  serviceHostname,
  serviceName,
  serviceSocket,
  validateInstance,
};
