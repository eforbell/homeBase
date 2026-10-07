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
