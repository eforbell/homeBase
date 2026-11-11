const test = require('node:test');
const assert = require('node:assert/strict');
const { buildInstallPlan } = require('../src/services/install-planner');
const env = require('../src/operations/env');
const { renderAll } = require('./fixtures/env/scenarios');
const golden = require('./fixtures/env/legacy-golden.json');

// legacy-golden.json was captured from the install planner BEFORE the env rules moved into
// src/operations/env.js. It pins the reinstall contract for every catalog app. Regenerate it only for
// an intentional, reviewed behavior change.
test('every catalog app renders byte-identical .env files to the pre-refactor planner', () => {
  const current = renderAll(buildInstallPlan, env.parseDotEnv);
  assert.deepEqual(Object.keys(current).sort(), Object.keys(golden).sort());
  for (const key of Object.keys(golden)) assert.equal(current[key], golden[key], key);
});

test('the reinstall contract keeps operator values and secrets and re-derives host-derived values', () => {
  const dinner = golden['family-dinner::reinstall-operator-edits-new-hostname'];
  assert.match(dinner, /^OPENAI_API_KEY=sk-operator-value$/m, 'operator-supplied key survives');
  assert.match(dinner, /^OPENAI_MODEL=operator-model$/m, 'preserveExistingKeys survives');
  assert.match(dinner, /^CUSTOM_OPERATOR_FLAG=on$/m, 'operator-added key survives');
  assert.match(dinner, /^DATABASE_URL="postgresql:\/\/custom_user:custom%40pw@localhost:5432\/custom_db"$/m, 'database wiring kept verbatim');
  assert.match(dinner, /^PORT=3000$/m, 'derived port re-derived');
  const source = golden['home-source::reinstall-operator-edits-new-hostname'];
  assert.match(source, /^APP_URL=https:\/\/newhost\.tailnet\/source\/$/m, 'hostname change propagates');
});

test('strict rendering refuses unresolved placeholders instead of writing empty values', () => {
  const app = { config: { env: { SESSION_SECRET: '{{secret1}}', APP_URL: '{{externalUrl}}' } } };
  assert.throws(() => env.renderAppEnv({ app, ctx: { secret1: 'abc' }, strict: true }), (error) => error.code === 'ENV_TEMPLATE_UNRESOLVED' && /externalUrl/.test(error.message));
  assert.throws(() => env.renderAppEnv({ app: { config: { env: { X: '{{typo}}' } } }, ctx: {}, strict: true }), /typo/);
  const lenient = env.renderAppEnv({ app: { config: { env: { X: '{{typo}}' } } }, ctx: {} });
  assert.equal(lenient.env.X, '{{typo}}', 'legacy lenient behavior is unchanged');
  assert.deepEqual(env.templatePlaceholders({ A: '{{port}}/{{secret1}}', B: 'plain' }).sort(), ['port', 'secret1']);
});

test('placeholder substitution is single-pass, so values cannot inject further placeholders', () => {
  const resolved = env.resolveEnvTemplate({ DATABASE_URL: '{{databaseUrl}}' }, { databaseUrl: 'postgresql://u:{{port}}@h/db', port: 1 }, { strict: true });
  assert.equal(resolved.DATABASE_URL, 'postgresql://u:{{port}}@h/db');
});

test('the executor renders Family Dinner exactly like the legacy planner, plus the runtime NODE_ENV, its socket and its sign-in mode', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { renderAppEnvFile } = require('../executor/handlers');
  const { appLayout } = require('../src/operations/app-layout');
  const { getAppById } = require('../src/catalog');
  const layout = appLayout(getAppById('family-dinner'));
  const { createFakeFs } = require('./fixtures/fake-fs');
  const { withDeterministicRandom } = require('./fixtures/env/scenarios');
  const site = { hostname: 'newhost', domain: 'tailnet', householdTimezone: 'America/Chicago' };
  const noFonts = createFakeFs();

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-exec-parity-'));
  const config = { port: 3080, serviceUser: 'sovereign', baseInstallDir: base, homeBaseSharedRoot: base, homeBaseAssetsRoot: path.join(base, 'assets'), defaultHostname: site.hostname, defaultDomain: site.domain, householdTimezone: site.householdTimezone };
  const legacyFresh = env.parseDotEnv(withDeterministicRandom(() => buildInstallPlan({ appId: 'family-dinner', state: { installations: {} }, options: {}, config })).files['.env']);
  const password = env.parseDatabaseUrl(legacyFresh.DATABASE_URL).dbPassword;
  const executorFresh = env.parseDotEnv(renderAppEnvFile({ layout, password, site, fsImpl: noFonts }));
  // SOVEREIGN_LISTEN (SID-007): Dinner listens on its own socket, so the executor writes it instead of loopback HOST.
  const socket = 'unix:/run/sovereign-apps/family-dinner/app.sock';
  // Dinner can trust tailnet identity, so its .env always carries a mode; a fresh install starts local.
  assert.deepEqual(executorFresh, { ...legacyFresh, SOVEREIGN_LISTEN: socket, SOVEREIGN_AUTH_MODE: 'local', NODE_ENV: 'production' });
  assert.equal(executorFresh.APP_PUBLIC_URL, 'https://newhost.tailnet/dinner/');

  // Reinstall: operator edits, an operator-added key, stale derived values, same-role DB wiring.
  const existing = { ...legacyFresh, HOST: '0.0.0.0', OPENAI_API_KEY: 'sk-operator', OPENAI_MODEL: 'operator-model', RECIPE_IMPORT_USER_AGENT: 'stale agent', PORT: '9999', CUSTOM_FLAG: 'on', SOVEREIGN_FONT_SANS_CSS_URL_LOCAL: 'https://oldhost.tailnet/_sovereign/fonts/source-sans-3.css' };
  fs.mkdirSync(path.join(base, 'familyDinner'), { recursive: true });
  fs.writeFileSync(path.join(base, 'familyDinner', '.env'), env.renderEnv(existing));
  const legacyReinstall = env.parseDotEnv(withDeterministicRandom(() => buildInstallPlan({ appId: 'family-dinner', state: { installations: {} }, options: {}, config })).files['.env']);
  const executorReinstall = env.parseDotEnv(renderAppEnvFile({ layout, password, site, existingContent: env.renderEnv(existing), fsImpl: noFonts }));
  // An install from before the socket kept HOST; the executor drops it, since the app now listens on the socket.
  const { HOST: _legacyHost, ...legacyReinstallWithoutHost } = legacyReinstall;
  assert.deepEqual(executorReinstall, { ...legacyReinstallWithoutHost, SOVEREIGN_LISTEN: socket, SOVEREIGN_AUTH_MODE: 'local', NODE_ENV: 'production' });
  // Once the operator has switched it, an update keeps tailnet mode.
  const switched = env.parseDotEnv(renderAppEnvFile({ layout, password, site, existingContent: env.renderEnv({ ...existing, SOVEREIGN_AUTH_MODE: 'tailnet', SOVEREIGN_HOMEBASE_UID: '990' }), fsImpl: noFonts }));
  assert.equal(switched.SOVEREIGN_AUTH_MODE, 'tailnet');
  assert.equal(switched.SOVEREIGN_HOMEBASE_UID, '990');
  assert.equal(executorReinstall.OPENAI_API_KEY, 'sk-operator');
  assert.equal(executorReinstall.RECIPE_IMPORT_USER_AGENT, 'Home Base importer/0.1', 'non-listed defaults are re-derived');
  assert.equal(executorReinstall.PORT, '3000');
  assert.match(executorReinstall.SOVEREIGN_FONT_SANS_CSS_URL_LOCAL, /newhost/);
  fs.rmSync(base, { recursive: true, force: true });
});

test('the executor reuses any valid existing database wiring and refuses wiring for another role', () => {
  const { readExistingDatabasePassword } = require('../executor/handlers');
  const { appLayout } = require('../src/operations/app-layout');
  const { getAppById } = require('../src/catalog');
  const { createFakeFs } = require('./fixtures/fake-fs');
  const layout = appLayout(getAppById('family-dinner'));
  const envPath = '/opt/sovereign-home/apps/familyDinner/.env';
  const read = (content) => readExistingDatabasePassword({ layout, fsImpl: createFakeFs({ [envPath]: content }), lookupUser: () => ({ uid: 1, gid: 1 }), asUser: (user, fn) => fn() });
  assert.equal(read('DATABASE_URL="postgresql://family_dinner:p%40ss-word1@localhost:5432/family_dinner"\n'), 'p@ss-word1', 'quoted, non-canonical host is fine');
  assert.equal(read('PGUSER=family_dinner\nPGPASSWORD=Pg-pass-123\nPGDATABASE=family_dinner\n'), 'Pg-pass-123');
  assert.equal(read('OPENAI_API_KEY=x\n'), null);
  assert.throws(() => read('DATABASE_URL=postgresql://other_role:Long-pass-1@127.0.0.1:5432/family_dinner\n'), (error) => error.code === 'POLICY_DENIED' && /other_role/.test(error.message));
});

test('every catalog app: a fresh executor .env equals the legacy planner output plus its runtime env', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { renderAppEnvFile } = require('../executor/handlers');
  const { appLayout } = require('../src/operations/app-layout');
  const { catalog } = require('../src/catalog');
  const { createFakeFs } = require('./fixtures/fake-fs');
  const { withDeterministicRandom } = require('./fixtures/env/scenarios');
  const site = { hostname: 'newhost', domain: 'tailnet', householdTimezone: 'America/Chicago' };
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-exec-parity-all-'));
  const config = { port: 3080, serviceUser: 'sovereign', baseInstallDir: base, homeBaseSharedRoot: base, homeBaseAssetsRoot: path.join(base, 'assets'), defaultHostname: site.hostname, defaultDomain: site.domain, householdTimezone: site.householdTimezone };
  try {
    for (const app of catalog) {
      const layout = appLayout(app);
      const legacy = env.parseDotEnv(withDeterministicRandom(() => buildInstallPlan({ appId: app.id, state: { installations: {} }, options: {}, config })).files['.env']);
      const password = layout.database ? env.resolveExistingDbContext(legacy, {}, app).dbPassword : null;
      // Secrets are random per render; the reinstall contract keeps the legacy values, as on a real host.
      const executor = env.parseDotEnv(renderAppEnvFile({ layout, password, site, existingContent: env.renderEnv(legacy), fsImpl: createFakeFs() }));
      const listenEnv = layout.listen.kind === 'unix' ? { SOVEREIGN_LISTEN: `unix:${layout.listen.socket}` } : { HOST: '127.0.0.1' };
      // An app that can trust tailnet identity always carries a mode; a fresh install starts local.
      const identityEnv = layout.identityModes.includes('tailnet') ? { SOVEREIGN_AUTH_MODE: 'local' } : {};
      const runtimeEnv = { ...listenEnv, ...identityEnv, ...(layout.runtime.kind === 'node' ? { NODE_ENV: layout.runtime.nodeEnv } : {}) };
      assert.deepEqual(executor, { ...legacy, ...runtimeEnv }, app.id);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
