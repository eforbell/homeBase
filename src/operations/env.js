// App .env rendering and reinstall-merge rules, shared by the legacy install planner and the root
// executor so the two can never drift. See docs/executor-app-runbook.md ("Environment files").
//
// Reinstall contract: an existing, non-empty value SURVIVES when any of these hold
//   1. the key is listed in the app's config.preserveExistingKeys
//   2. the catalog default is '' (operator-supplied, e.g. OPENAI_API_KEY)
//   3. the catalog default is a generated secret ({{secret1}}..{{secret3}})
//   4. the key is database wiring (DATABASE_URL, PG*, DB_BACKEND, SQLITE_DB_PATH)
//   5. the key name looks sensitive (SECRET|TOKEN|PASSWORD|PASSPHRASE|API_KEY|CLIENT_ID|AUTH_)
//   6. the key is not in the catalog template at all (operator-added)
// Every other catalog key is RE-DERIVED on each install (ports, URLs from hostname, mount paths,
// timezone, font URLs, non-listed defaults), so host/config changes propagate.

const PLACEHOLDER_PATTERN = /\{\{([A-Za-z0-9_.-]+)\}\}/g;
const DATABASE_KEYS = Object.freeze(['DATABASE_URL', 'DB_BACKEND', 'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'SQLITE_DB_PATH']);
const SENSITIVE_KEY_PATTERN = /(SECRET|TOKEN|PASSWORD|PASSPHRASE|API_KEY|CLIENT_SECRET|CLIENT_ID|AUTH_)/i;
const SIMPLE_ENV_VALUE = /^[A-Za-z0-9_./:@-]*$/;

class EnvTemplateError extends Error {
  constructor(message) {
    super(message);
    this.code = 'ENV_TEMPLATE_UNRESOLVED';
  }
}

// Same semantics as the planner's helper: strip one trailing slash ('/' becomes '').
function trimTrailingSlash(value) {
  const text = String(value);
  return text.endsWith('/') ? text.slice(0, -1) : text;
}

function quoteEnvValue(value) {
  const stringValue = value == null ? '' : String(value);
  if (SIMPLE_ENV_VALUE.test(stringValue)) return stringValue;
  return JSON.stringify(stringValue);
}

function renderEnv(envMap) {
  return `${Object.entries(envMap)
    .map(([key, value]) => `${key}=${quoteEnvValue(value)}`)
    .join('\n')}\n`;
}

function parseDotEnv(content) {
  const env = {};
  const lines = String(content || '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

// Placeholder name -> value for a render context. Sidecar ports appear as sidecar.<name>.port.
function placeholderValues(ctx) {
  const values = {
    databaseUrl: ctx.databaseUrl,
    port: ctx.port,
    externalUrl: ctx.externalUrl,
    publicUrl: ctx.publicUrl,
    dbUser: ctx.dbUser,
    dbPassword: ctx.dbPassword,
    dbName: ctx.dbName,
    mountBasePath: ctx.mountPath == null ? undefined : trimTrailingSlash(ctx.mountPath),
    secret1: ctx.secret1,
    secret2: ctx.secret2,
    secret3: ctx.secret3,
    householdTimezone: ctx.householdTimezone,
    sovereignFontSource: ctx.sovereignFontSource,
    sovereignFontSansCssUrl: ctx.sovereignFontSansCssUrl,
    sovereignFontMonoCssUrl: ctx.sovereignFontMonoCssUrl,
    sovereignFontSansCssUrlLocal: ctx.sovereignFontSansCssUrlLocal,
    sovereignFontMonoCssUrlLocal: ctx.sovereignFontMonoCssUrlLocal,
  };
  for (const [name, sidecarPort] of Object.entries(ctx.sidecarPorts || {})) values[`sidecar.${name}.port`] = sidecarPort;
  return values;
}

function templatePlaceholders(template) {
  const names = new Set();
  for (const value of Object.values(template || {})) {
    for (const match of String(value).matchAll(PLACEHOLDER_PATTERN)) names.add(match[1]);
  }
  return [...names];
}

// strict: every placeholder must resolve to a defined value, or rendering throws. The executor always
// renders strictly so a missing input can never become a silently empty secret or URL. The legacy
// planner keeps its historical lenient behavior (unknown placeholders left as-is).
function resolveEnvTemplate(template, ctx, { strict = false } = {}) {
  const values = placeholderValues(ctx);
  const resolved = {};
  for (const [key, value] of Object.entries(template || {})) {
    resolved[key] = String(value).replace(PLACEHOLDER_PATTERN, (whole, name) => {
      if (!Object.hasOwn(values, name) || values[name] === undefined || values[name] === null) {
        if (strict) throw new EnvTemplateError(`Env template ${key} needs {{${name}}}, which this install cannot provide.`);
        return Object.hasOwn(values, name) ? String(values[name]) : whole;
      }
      return String(values[name]);
    });
  }
  return resolved;
}

function parseDatabaseUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    const dbName = parsed.pathname ? parsed.pathname.replace(/^\//, '') : '';
    return {
      databaseUrl: String(value),
      dbUser: parsed.username ? decodeURIComponent(parsed.username) : '',
      dbPassword: parsed.password ? decodeURIComponent(parsed.password) : '',
      dbName,
    };
  } catch (_error) {
    return null;
  }
}

function getDatabaseUrlEnvKey(app = {}) {
  return app.database?.urlEnvKey || 'DATABASE_URL';
}

function resolveExistingDbContext(existing = {}, defaults = {}, app = {}) {
  const next = { ...defaults };
  const databaseUrlEnvKey = getDatabaseUrlEnvKey(app);
  const existingDatabaseUrl = existing[databaseUrlEnvKey] || existing.DATABASE_URL;

  if (existingDatabaseUrl) {
    const parsed = parseDatabaseUrl(existingDatabaseUrl);
    if (parsed) {
      if (parsed.dbUser) next.dbUser = parsed.dbUser;
      if (parsed.dbPassword) next.dbPassword = parsed.dbPassword;
      if (parsed.dbName) next.dbName = parsed.dbName;
      next.databaseUrl = parsed.databaseUrl;
    }
  }

  if (existing.PGUSER) next.dbUser = existing.PGUSER;
  if (existing.PGPASSWORD) next.dbPassword = existing.PGPASSWORD;
  if (existing.PGDATABASE) next.dbName = existing.PGDATABASE;

  if (existing.DB_BACKEND) next.dbBackend = existing.DB_BACKEND;
  if (existing.SQLITE_DB_PATH) next.sqliteDbPath = existing.SQLITE_DB_PATH;

  if (!next.databaseUrl && next.dbUser && next.dbPassword && next.dbName) {
    next.databaseUrl = `postgresql://${next.dbUser}:${next.dbPassword}@127.0.0.1:5432/${next.dbName}`;
  }

  return next;
}

function hasExistingDbConfig(existing = {}, app = {}) {
  const databaseUrlEnvKey = getDatabaseUrlEnvKey(app);
  return Boolean(
    existing[databaseUrlEnvKey]
      || (databaseUrlEnvKey !== 'DATABASE_URL' && existing.DATABASE_URL)
      || existing.PGUSER
      || existing.PGPASSWORD
      || existing.PGDATABASE
      || existing.SQLITE_DB_PATH
  );
}

function shouldPreserveExistingEnvValue(key, templateValue, preserveExistingKeys = []) {
  const template = String(templateValue == null ? '' : templateValue);
  if (preserveExistingKeys.includes(key)) return true;
  if (template === '') return true;
  if (template.includes('{{secret')) return true;
  if (DATABASE_KEYS.includes(key)) return true;
  if (SENSITIVE_KEY_PATTERN.test(key)) return true;
  return false;
}

function mergeExistingEnvValues({ template, resolved, existing, preserveExistingKeys = [] }) {
  const next = { ...resolved };
  for (const [key, templateValue] of Object.entries(template || {})) {
    const existingValue = existing[key];
    if (!existingValue) continue;
    if (!shouldPreserveExistingEnvValue(key, templateValue, preserveExistingKeys)) continue;
    next[key] = existingValue;
  }
  for (const [key, existingValue] of Object.entries(existing || {})) {
    if (!existingValue) continue;
    if (key in next) continue;
    if (!shouldPreserveExistingEnvValue(key, '', preserveExistingKeys)) continue;
    next[key] = existingValue;
  }
  return next;
}

// Resolve the template and apply the reinstall contract in one step.
function renderAppEnv({ app, ctx, existing = null, strict = false }) {
  const resolved = resolveEnvTemplate(app.config.env, ctx, { strict });
  const env = existing
    ? mergeExistingEnvValues({ template: app.config.env, resolved, existing, preserveExistingKeys: app.config.preserveExistingKeys || [] })
    : resolved;
  return { env, content: renderEnv(env) };
}

// Catalog env keys whose literal default points inside the app's external storage root (e.g.
// FP_TRANSACTION_FILES_DIR). Backups archive that root, so a restore must keep the app pointed at it
// even when the restored .env predates the key.
// Where the app listens (Feature-10 SID-002), never left to an old .env: a socket only nginx's group can
// reach, or loopback for apps that don't support one (never every interface, which the tailnet reaches).
// The other mode's key goes, so an app switching modes, or restored from an older backup, never keeps
// listening where nginx no longer points. Returns a new object.
function applyListenEnv(env, layout) {
  const { HOST: _host, SOVEREIGN_LISTEN: _listen, ...rest } = env;
  return layout.listen?.kind === 'unix' ? { ...rest, SOVEREIGN_LISTEN: `unix:${layout.listen.socket}` } : { ...rest, HOST: '127.0.0.1' };
}

// Which identity the app trusts (Feature-10 SID-007), never left to an old .env either. SOVEREIGN_AUTH_MODE is
// what sovereignAuth reads, and it refuses to start without one, so an app that supports tailnet identity always
// gets one. The Home Base user's uid, which the snapshot reader needs, comes with tailnet mode only.
// SOVEREIGN_IDENTITY_MODE, a name used before the contract settled, is dropped.
const IDENTITY_ENV_KEYS = Object.freeze(['SOVEREIGN_AUTH_MODE', 'SOVEREIGN_HOMEBASE_UID', 'SOVEREIGN_IDENTITY_MODE']);
// The form renderEnv writes: one KEY=value per line, the value simple or JSON-quoted, nothing spanning lines,
// no comments. dotenv reads such a file exactly as its lines say (no value continues, nothing else is an
// assignment), so only a file in this form is read line by line here; any other is a hand edit.
const CANONICAL_LINE = /^[A-Za-z_][A-Za-z0-9_]*=(?:[A-Za-z0-9_./:@-]*|"(?:[^"\\\r\n]|\\.)*")$/;
function canonicalEnv(content) {
  const text = String(content || '');
  if (text.includes('\r')) return null;
  const rows = text.split('\n');
  if (rows.at(-1) === '') rows.pop();
  if (!rows.every((row) => CANONICAL_LINE.test(row))) return null;
  return rows.map((row) => {
    const index = row.indexOf('=');
    const raw = row.slice(index + 1);
    return [row.slice(0, index), raw.startsWith('"') ? JSON.parse(raw) : raw];
  });
}
const MODE_KEYS = ['SOVEREIGN_AUTH_MODE', 'SOVEREIGN_IDENTITY_MODE'];

// The executor's rollback guard: does this .env put the app in tailnet mode? Fail closed, since this only ever
// refuses a rollback. A file in renderEnv's form trusts unless every mode it sets is local; any other file trusts
// if a mode key's name appears in it at all (dotenv never splits a key name, however it lays out the rest).
function trustsIdentityHeaders(content) {
  const entries = canonicalEnv(content);
  if (!entries) return MODE_KEYS.some((key) => String(content || '').includes(key));
  return entries.some(([key, value]) => MODE_KEYS.includes(key) && value !== 'local');
}

// The mode an update or restore keeps. Tailnet only in a file in renderEnv's form, with exactly the executor's
// two lines; a hand edit never turns trust on (it would skip every gate). Anything else falls back to local, the
// safe direction: the guard above still counts a hand-edited file that names the mode, and Home Base's record
// stays tailnet, so a rollback waits until the administrator returns the app to its own sign-in.
function currentIdentity(content) {
  const entries = canonicalEnv(content);
  const modes = (entries || []).filter(([key]) => MODE_KEYS.includes(key));
  const uids = (entries || []).filter(([key]) => key === 'SOVEREIGN_HOMEBASE_UID');
  if (modes.length === 1 && modes[0][0] === 'SOVEREIGN_AUTH_MODE' && modes[0][1] === 'tailnet' && uids.length === 1 && /^[1-9][0-9]*$/.test(uids[0][1])) {
    return { mode: 'tailnet', homeBaseUid: Number(uids[0][1]) };
  }
  return { mode: 'local' };
}

// parseDotEnv keeps `export KEY` as a key; those go too.
function withoutIdentityEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !IDENTITY_ENV_KEYS.includes(String(key).replace(/^export\s+/, '').trim())));
}
// mode: 'tailnet' (with homeBaseUid) or 'local'. Returns a new object.
function setIdentityEnv(env, { mode, homeBaseUid = null }) {
  if (mode === 'tailnet') {
    if (!Number.isInteger(homeBaseUid) || homeBaseUid <= 0) throw new Error('tailnet mode needs the Home Base user\'s uid');
    return { ...withoutIdentityEnv(env), SOVEREIGN_AUTH_MODE: 'tailnet', SOVEREIGN_HOMEBASE_UID: String(homeBaseUid) };
  }
  if (mode !== 'local') throw new Error(`unknown identity mode ${mode}`);
  return { ...withoutIdentityEnv(env), SOVEREIGN_AUTH_MODE: 'local' };
}
// What a re-rendered or restored .env says about identity: the app's current .env (its raw content) decides,
// never the template or a backup. An app that can't trust the directory gets no mode at all.
function keepIdentityEnv(env, currentContent, layout) {
  if (!layout.identityModes?.includes('tailnet')) return withoutIdentityEnv(env);
  return setIdentityEnv(env, currentIdentity(currentContent));
}

function storageEnvOverrides(app) {
  const root = String(app?.storage?.absoluteRoot || '').replace(/\/+$/, '');
  if (!root) return {};
  const overrides = {};
  for (const [key, value] of Object.entries(app.config?.env || {})) {
    const text = String(value == null ? '' : value);
    if (text.includes('{{')) continue;
    if (text === root || text.startsWith(`${root}/`)) overrides[key] = text;
  }
  return overrides;
}

module.exports = {
  EnvTemplateError,
  applyListenEnv,
  IDENTITY_ENV_KEYS,
  trustsIdentityHeaders,
  currentIdentity,
  setIdentityEnv,
  keepIdentityEnv,
  storageEnvOverrides,
  DATABASE_KEYS,
  quoteEnvValue,
  renderEnv,
  parseDotEnv,
  templatePlaceholders,
  resolveEnvTemplate,
  parseDatabaseUrl,
  getDatabaseUrlEnvKey,
  resolveExistingDbContext,
  hasExistingDbConfig,
  shouldPreserveExistingEnvValue,
  mergeExistingEnvValues,
  renderAppEnv,
};
