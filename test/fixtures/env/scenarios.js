// Shared by the golden-snapshot capture and the parity test. Renders every catalog app's .env through
// the legacy install planner across reinstall scenarios, with deterministic "random" secrets.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function withDeterministicRandom(fn) {
  const original = crypto.randomBytes;
  let counter = 0;
  crypto.randomBytes = (size) => {
    counter += 1;
    return Buffer.alloc(size, counter);
  };
  try { return fn(); } finally { crypto.randomBytes = original; }
}

const OPERATOR_EDITS = (fresh) => {
  const edits = {};
  for (const key of Object.keys(fresh)) {
    if (/API_KEY/.test(key)) edits[key] = 'sk-operator-value';
    if (/MODEL$/.test(key)) edits[key] = 'operator-model';
    if (key === 'PORT') edits[key] = '9999';
    if (/URL$/.test(key) && /tailnet/.test(fresh[key])) edits[key] = 'https://oldhost.tailnet/stale/';
    if (/SECRET/.test(key)) edits[key] = `kept-${key.toLowerCase()}`;
  }
  edits.CUSTOM_OPERATOR_FLAG = 'on';
  edits.DATABASE_URL = 'postgresql://custom_user:custom%40pw@localhost:5432/custom_db';
  return edits;
};

const SCENARIOS = {
  'fresh-install': { hostname: 'homebase', existing: () => null },
  'reinstall-operator-edits-new-hostname': { hostname: 'newhost', existing: (fresh) => ({ ...fresh, ...OPERATOR_EDITS(fresh) }) },
  'reinstall-pg-and-sqlite-keys': { hostname: 'homebase', existing: () => ({ PGUSER: 'pg_user', PGPASSWORD: 'pg-pass', PGDATABASE: 'pg_db', DB_BACKEND: 'sqlite', SQLITE_DB_PATH: '/var/lib/app/ledger.db', EXTRA_KEY: 'x y' }) },
};

function renderAll(buildInstallPlan, parseDotEnv) {
  const { catalog } = require('../../../src/catalog');
  const out = {};
  for (const app of catalog) {
    for (const [name, scenario] of Object.entries(SCENARIOS)) {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-env-golden-'));
      const config = { port: 3080, serviceUser: 'sovereign', baseInstallDir: base, homeBaseSharedRoot: base, homeBaseAssetsRoot: path.join(base, 'assets'), defaultHostname: scenario.hostname, defaultDomain: 'tailnet', householdTimezone: 'America/Chicago' };
      const fresh = withDeterministicRandom(() => parseDotEnv(buildInstallPlan({ appId: app.id, state: { installations: {} }, options: {}, config }).files['.env']));
      const existing = scenario.existing(fresh);
      if (existing) {
        fs.mkdirSync(path.join(base, app.repoKey), { recursive: true });
        fs.writeFileSync(path.join(base, app.repoKey, '.env'), Object.entries(existing).map(([k, v]) => `${k}=${v}`).join('\n'));
      }
      const plan = withDeterministicRandom(() => buildInstallPlan({ appId: app.id, state: { installations: {} }, options: {}, config }));
      out[`${app.id}::${name}`] = plan.files['.env'].split(base).join('<BASE>');
      fs.rmSync(base, { recursive: true, force: true });
    }
  }
  return out;
}

module.exports = { SCENARIOS, renderAll, withDeterministicRandom };
