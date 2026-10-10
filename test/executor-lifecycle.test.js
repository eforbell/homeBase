const test = require('node:test');
const assert = require('node:assert/strict');
const { createLifecycleHandlers } = require('../executor/lifecycle-handlers');
const { buildAppRestartPlan, buildAppBackupPlan, buildAppRestorePlan, buildAppUninstallPlan, archiveNameFor } = require('../src/operations/compilers/lifecycle');
const { validateOperationPolicy } = require('../src/operations/policy');
const { appLayout } = require('../src/operations/app-layout');
const { getAppById } = require('../src/catalog');
const { createFakeFs } = require('./fixtures/fake-fs');

const SOURCE = appLayout(getAppById('home-source'));
const SOVEREIGN = { uid: 1001, gid: 1002 };
const ENV = '/opt/sovereign-home/apps/homeSource/.env';
const ARCHIVE = '/var/lib/sovereign-home/backups/home-source/20260924T101010Z';

function op(type, fields = {}) {
  return { id: 'op', type, title: 't', risk: 'write', timeoutMs: 1000, dependsOn: [], preconditions: [], secretRefs: [], ...fields };
}

// The marker backup.create writes last; restore sources without it are refused as unfinished.
const done = (dir) => ({ [`${dir}/backup-generated-at.txt`]: { kind: 'file', content: '2026-09-24T10:10:10.000Z\n', uid: 1001 } });

function harness(files = {}) {
  const fsImpl = createFakeFs({
    '/var/lib/sovereign-home/backups': { kind: 'dir', uid: 1001 },
    [ENV]: { kind: 'file', content: 'DATABASE_URL=postgresql://homesource:Live-pass-123@127.0.0.1:5432/homesource\nSMTP_HOST=live.example\n', uid: 1001 },
    '/var/lib/sovereign-home/home-source/data/documents': { kind: 'dir', uid: 1001 },
    ...files,
  });
  const calls = [];
  const identities = [];
  const modesAtSpawn = [];
  let current = 'root';
  const asUser = (user, fn) => { identities.push(user.uid); const previous = current; current = 'sovereign'; try { return fn(); } finally { current = previous; } };
  const handlers = createLifecycleHandlers({
    fsImpl, asUser, now: () => new Date('2026-09-24T10:10:10.000Z'),
    lookupUser: (name) => (name === 'postgres' ? { uid: 999, gid: 999 } : SOVEREIGN),
    run: async (input) => {
      calls.push({ ...input, as: current });
      // Simulate tools creating their output files.
      // Like the real tools, write into the pre-created file (keeping its mode) and record the mode seen.
      for (const flag of ['-f', '-czf']) {
        const index = input.args.indexOf(flag);
        if (index < 0) continue;
        const target = fsImpl.entries.get(input.args[index + 1]);
        modesAtSpawn.push(target ? target.mode : 'missing');
        if (target) target.content = 'data';
      }
      return { stdout: '' };
    },
  });
  return { fsImpl, calls, identities, handlers, modesAtSpawn };
}

test('backup runs entirely as sovereign, keeps secrets 0600, and never passes credentials in argv', async () => {
  const { fsImpl, calls, handlers, modesAtSpawn } = harness();
  const output = await handlers['backup.create'](op('backup.create', { archiveName: '20260924T101010Z' }), { layout: SOURCE });
  assert.match(output, /\.env\.backup, database\.dump, documents\.tgz/);
  const dump = calls.find((call) => call.binary === '/usr/bin/pg_dump');
  assert.equal(dump.uid, 1001);
  assert.deepEqual(dump.args, ['--no-password', '-Fc', '-f', `${ARCHIVE}/database.dump`]);
  assert.doesNotMatch(JSON.stringify(dump.args), /Live-pass/);
  assert.equal(dump.env.PGPASSWORD, 'Live-pass-123');
  assert.deepEqual(dump.secrets, ['Live-pass-123']);
  const tar = calls.find((call) => call.binary === '/usr/bin/tar');
  assert.deepEqual([tar.uid, tar.args], [1001, ['-C', '/var/lib/sovereign-home/home-source/data', '-czf', `${ARCHIVE}/documents.tgz`, 'documents']]);
  assert.deepEqual(modesAtSpawn, [0o600, 0o600], 'dump and archives are private before the tools write a byte');
  assert.equal(fsImpl.entries.get(`${ARCHIVE}/.env.backup`).mode, 0o600);
  assert.equal(fsImpl.entries.get(`${ARCHIVE}/database.dump`).mode, 0o600);
  assert.equal(fsImpl.entries.get(`${ARCHIVE}`).mode, 0o755, 'listable by the Home Base inventory');
  assert.equal(fsImpl.readFileSync(`${ARCHIVE}/backup-generated-at.txt`), '2026-09-24T10:10:10.000Z\n');
  await assert.rejects(() => handlers['backup.create'](op('backup.create', { archiveName: '20260924T101010Z' }), { layout: SOURCE }), (error) => error.code === 'EEXIST', 'archives are never overwritten');
});

test('restore brings back env, database (as the app role), and storage while keeping live database wiring', async () => {
  const { fsImpl, calls, handlers } = harness({
    [`${ARCHIVE}/.env.backup`]: { kind: 'file', content: 'DATABASE_URL=postgresql://homesource:Old-pass-999@127.0.0.1:5432/homesource\nSMTP_HOST=from-backup.example\nEXTRA=1\n', uid: 1001 },
    ...done(ARCHIVE),
    [`${ARCHIVE}/database.dump`]: { kind: 'file', content: 'dump', uid: 1001 },
    [`${ARCHIVE}/documents.tgz`]: { kind: 'file', content: 'tgz', uid: 1001 },
  });
  await handlers['backup.restore'](op('backup.restore', { risk: 'destructive', archiveName: '20260924T101010Z' }), { layout: SOURCE });
  const env = fsImpl.readFileSync(ENV);
  assert.match(env, /^SMTP_HOST=from-backup\.example$/m);
  assert.match(env, /^EXTRA=1$/m);
  assert.match(env, /Live-pass-123/, 'live database wiring is preserved');
  assert.doesNotMatch(env, /Old-pass/);
  const restore = calls.find((call) => call.binary === '/usr/bin/pg_restore');
  assert.deepEqual([restore.uid, restore.env.PGUSER], [1001, 'homesource'], 'runs as sovereign with the app role, never postgres');
  assert.deepEqual(restore.args, ['--no-password', '--clean', '--if-exists', '-d', 'homesource', `${ARCHIVE}/database.dump`]);
  const extract = calls.find((call) => call.binary === '/usr/bin/tar');
  assert.deepEqual([extract.uid, extract.args], [1001, ['-C', '/var/lib/sovereign-home/home-source/data', '--no-same-owner', '-xzf', `${ARCHIVE}/documents.tgz`]]);
  await assert.rejects(() => handlers['backup.restore'](op('backup.restore', { risk: 'destructive', archiveName: '20200101T000000Z' }), { layout: SOURCE }), /does not exist/);
});

test('uninstall removes only root-owned layout artifacts as root and app files as sovereign', async () => {
  const { fsImpl, calls, identities, handlers } = harness({
    '/etc/systemd/system/home-source.service': 'unit',
    '/etc/systemd/system/home-source-continuity-check.timer': 'unit',
    '/etc/nginx/sovereign-home.d/home-source.conf': 'snippet',
    '/etc/systemd/system/sshd.service': 'not ours',
    '/var/lib/sovereign-home/git-mirrors/homeSource.git': { kind: 'dir', uid: 0 },
    '/opt/sovereign-home/apps/homeSource/server.js': 'code',
  });
  await handlers['filesystem.remove-app-artifacts'](op('filesystem.remove-app-artifacts', { risk: 'destructive' }), { layout: SOURCE });
  assert.equal(fsImpl.existsSync('/etc/systemd/system/home-source.service'), false);
  assert.equal(fsImpl.existsSync('/etc/nginx/sovereign-home.d/home-source.conf'), false);
  assert.equal(fsImpl.existsSync('/var/lib/sovereign-home/git-mirrors/homeSource.git'), false);
  assert.equal(fsImpl.existsSync('/etc/systemd/system/sshd.service'), true);
  const before = identities.length;
  await handlers['filesystem.remove-checkout'](op('filesystem.remove-checkout', { risk: 'destructive' }), { layout: SOURCE });
  assert.equal(identities.length, before + 1, 'checkout removal runs as sovereign');
  assert.equal(fsImpl.existsSync('/opt/sovereign-home/apps/homeSource'), false);
  assert.equal(fsImpl.existsSync('/var/lib/sovereign-home/home-source/data/documents'), true, 'external storage is kept');
  await handlers['postgres.drop-database'](op('postgres.drop-database', { risk: 'destructive', database: 'homesource', owner: 'homesource' }), { layout: SOURCE });
  const drop = calls.at(-1);
  assert.equal(drop.uid, 999);
  assert.equal(drop.stdin, 'SET search_path = pg_catalog, pg_temp;\nDROP DATABASE IF EXISTS "homesource" WITH (FORCE);\nDROP ROLE IF EXISTS "homesource";\n');
  await assert.rejects(() => handlers['postgres.drop-database'](op('postgres.drop-database', { risk: 'destructive', database: 'family_dinner', owner: 'family_dinner' }), { layout: SOURCE }), (error) => error.code === 'POLICY_DENIED');

  const planted = harness({ '/var/lib/sovereign-home/git-mirrors/homeSource.git': { kind: 'link', target: '/etc' } });
  await assert.rejects(() => planted.handlers['filesystem.remove-app-artifacts'](op('filesystem.remove-app-artifacts', { risk: 'destructive' }), { layout: SOURCE }), /not the root-owned git mirror/);
});

test('lifecycle plans validate, and destructive operations exist only where an operator confirms them', () => {
  const at = '2026-09-24T10:10:10.123Z';
  assert.equal(archiveNameFor(at), '20260924T101010123Z');
  assert.equal(archiveNameFor('2026-09-24T10:10:10.000Z'), '20260924T101010Z', 'matches the legacy planner naming');
  for (const plan of [
    buildAppRestartPlan({ appId: 'home-source', generatedAt: at }),
    buildAppBackupPlan({ appId: 'home-source', generatedAt: at }),
    buildAppRestorePlan({ appId: 'home-source', backupId: '20260101T000000Z', generatedAt: at }),
    buildAppUninstallPlan({ appId: 'home-source', keepBackups: true, generatedAt: at }),
    buildAppUninstallPlan({ appId: 'family-dinner', keepBackups: false, generatedAt: at }),
  ]) assert.equal(validateOperationPolicy(plan), plan);

  const restore = buildAppRestorePlan({ appId: 'home-source', backupId: '20260101T000000Z', generatedAt: at });
  assert.deepEqual(restore.operations.slice(0, 2).map((entry) => entry.type), ['backup.verify', 'backup.create'], 'verify the source, then take a safety backup, before stopping anything');
  assert.ok(restore.operations.findIndex((entry) => entry.type === 'backup.verify') < restore.operations.findIndex((entry) => entry.action === 'stop'));
  const backup = buildAppBackupPlan({ appId: 'home-source', generatedAt: at });
  const smuggled = { ...backup, operations: [...backup.operations, { ...restore.operations.find((entry) => entry.type === 'backup.restore'), dependsOn: [backup.operations[0].id] }] };
  assert.throws(() => validateOperationPolicy(smuggled), (error) => error.code === 'POLICY_DENIED');
  const understated = JSON.parse(JSON.stringify(restore));
  understated.operations.find((entry) => entry.type === 'backup.restore').risk = 'write';
  assert.throws(() => validateOperationPolicy(understated), /must declare risk "destructive"/);
  const relabelled = { ...buildAppUninstallPlan({ appId: 'home-source', generatedAt: at }), kind: 'app-restart' };
  assert.throws(() => validateOperationPolicy(relabelled), /kind does not match/);
});

test('executePlan hands every app plan kind its catalog layout, and bootstrap none', async () => {
  const { executePlan } = require('../executor/execute');
  const { buildHostBootstrapPlan } = require('../src/operations/compilers/bootstrap');
  const seen = [];
  const record = async (operation, context) => { seen.push([operation.type, context.layout?.app.id ?? null]); };
  const handlers = new Proxy({}, { get: () => record });
  for (const plan of [
    buildAppBackupPlan({ appId: 'home-source' }),
    buildAppRestartPlan({ appId: 'family-dinner' }),
    buildAppUninstallPlan({ appId: 'home-source' }),
  ]) await executePlan({ plan, secretBindings: {} }, { handlers });
  await executePlan({ plan: buildHostBootstrapPlan(), secretBindings: {} }, { handlers });
  assert.deepEqual(seen.find(([type]) => type === 'backup.create'), ['backup.create', 'home-source']);
  assert.ok(seen.filter(([type]) => type === 'systemd.ensure-service').some(([, app]) => app === 'family-dinner'));
  assert.ok(seen.filter(([type]) => type === 'host.assert-debian-family').every(([, app]) => app === null));
});

test('restoring a backup that predates the storage env key re-points the app at the archived storage root', async () => {
  const PULSE = appLayout(getAppById('family-pulse'));
  const pulseEnv = '/opt/sovereign-home/apps/familyPulse/.env';
  const archive = '/var/lib/sovereign-home/backups/family-pulse/20260924T101010Z';
  const { fsImpl, handlers } = harness({
    [pulseEnv]: { kind: 'file', content: 'DATABASE_URL=postgresql://familypulse:Live-pass-123@127.0.0.1:5432/familypulse\nFP_TRANSACTION_FILES_DIR=/var/lib/sovereign-home/family-pulse/data/transaction-files\n', uid: 1001 },
    [`${archive}/.env.backup`]: { kind: 'file', content: 'DATABASE_URL=postgresql://familypulse:Old-pass-999@127.0.0.1:5432/familypulse\nPORT=3003\n', uid: 1001 },
    ...done(archive),
    [`${archive}/database.dump`]: { kind: 'file', content: 'dump', uid: 1001 },
  });
  await handlers['backup.restore'](op('backup.restore', { risk: 'destructive', archiveName: '20260924T101010Z' }), { layout: PULSE });
  const env = fsImpl.readFileSync(pulseEnv);
  assert.match(env, /^FP_TRANSACTION_FILES_DIR=\/var\/lib\/sovereign-home\/family-pulse\/data\/transaction-files$/m);
  assert.match(env, /^PORT=3003$/m, 'other restored values are kept');
});

test('restore sources are verified before anything stops, and incomplete or corrupt archives are refused', async () => {
  const unfinished = harness({ [`${ARCHIVE}/.env.backup`]: { kind: 'file', content: 'X=1\n', uid: 1001 }, [`${ARCHIVE}/database.dump`]: { kind: 'file', content: 'dump', uid: 1001 } });
  await assert.rejects(() => unfinished.handlers['backup.verify'](op('backup.verify', { risk: 'read', archiveName: '20260924T101010Z' }), { layout: SOURCE }), /never finished/);
  await assert.rejects(() => unfinished.handlers['backup.restore'](op('backup.restore', { risk: 'destructive', archiveName: '20260924T101010Z' }), { layout: SOURCE }), /never finished/);
  assert.equal(unfinished.calls.length, 0, 'nothing ran against an unfinished archive');
  const incomplete = harness({ ...done(ARCHIVE), [`${ARCHIVE}/.env.backup`]: { kind: 'file', content: 'X=1\n', uid: 1001 } });
  await assert.rejects(() => incomplete.handlers['backup.verify'](op('backup.verify', { risk: 'read', archiveName: '20260924T101010Z' }), { layout: SOURCE }), /no database dump/);
  await assert.rejects(() => incomplete.handlers['backup.restore'](op('backup.restore', { risk: 'destructive', archiveName: '20260924T101010Z' }), { layout: SOURCE }), /no database dump/);
  assert.equal(incomplete.calls.length, 0, 'nothing ran against an incomplete archive');

  const complete = harness({
    ...done(ARCHIVE),
    [`${ARCHIVE}/database.dump`]: { kind: 'file', content: 'dump', uid: 1001 },
    [`${ARCHIVE}/documents.tgz`]: { kind: 'file', content: 'tgz', uid: 1001 },
  });
  const output = await complete.handlers['backup.verify'](op('backup.verify', { risk: 'read', archiveName: '20260924T101010Z' }), { layout: SOURCE });
  assert.deepEqual(complete.calls.map((call) => [call.binary, call.args[0], call.uid]), [['/usr/bin/pg_restore', '--list', 1001], ['/usr/bin/tar', '-tzf', 1001]]);
  assert.match(output, /kept as-is: thumbnails, exports/);

  const corrupt = harness({ ...done(ARCHIVE), [`${ARCHIVE}/database.dump`]: { kind: 'file', content: 'garbage', uid: 1001 } });
  const failing = createLifecycleHandlers({ fsImpl: corrupt.fsImpl, asUser: (user, fn) => fn(), lookupUser: () => SOVEREIGN, run: async () => { throw Object.assign(new Error('pg_restore: error: input file does not appear to be a valid archive'), { code: 'OPERATION_FAILED' }); } });
  await assert.rejects(() => failing['backup.verify'](op('backup.verify', { risk: 'read', archiveName: '20260924T101010Z' }), { layout: SOURCE }), /valid archive/);
});

test('a safety backup is recorded as soon as it exists, even if the restore then fails; uninstall keeps records it keeps', async () => {
  const { JobRunner } = require('../src/services/job-runner');
  const recorded = [];
  const deleted = [];
  const jobs = {};
  const store = {
    createJob: (job) => { const id = Object.keys(jobs).length + 1; jobs[id] = { ...job, log: '' }; return { id }; },
    updateJob: (id, fields) => Object.assign(jobs[id], fields),
    appendJobLog: (id, text) => { jobs[id].log += text; },
    recordBackup: (record) => recorded.push(record.archiveDir),
    deleteInstallation: (appId) => deleted.push(`installation:${appId}`),
    deleteBackups: (appId) => deleted.push(`backups:${appId}`),
  };
  const restorePlan = buildAppRestorePlan({ appId: 'home-source', backupId: '20260101T000000Z', generatedAt: '2026-09-24T10:10:10.000Z' });
  const runner = new JobRunner(store, {
    busyRetry: { attempts: 1, delayMs: 1 },
    runExecutorAction: async (socket, fields, { onEvent }) => {
      onEvent({ eventType: 'plan.accepted', planDigest: 'sha256:x', plan: restorePlan });
      onEvent({ eventType: 'operation.completed', operationId: 'verify-backup' });
      onEvent({ eventType: 'operation.completed', operationId: 'safety-backup' });
      throw Object.assign(new Error('restore failed midway'), { code: 'OPERATION_FAILED' });
    },
  });
  const id = runner.startTypedRestoreJob({ appId: 'home-source', backupId: '20260101T000000Z' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(jobs[id].status, 'failed');
  assert.deepEqual(recorded, ['/var/lib/sovereign-home/backups/home-source/20260924T101010Z']);

  const uninstallPlan = buildAppUninstallPlan({ appId: 'home-source', keepBackups: true });
  const uninstaller = new JobRunner(store, { runExecutorAction: async (socket, fields, { onEvent }) => { onEvent({ eventType: 'plan.accepted', plan: uninstallPlan }); return {}; } });
  uninstaller.startTypedUninstallJob({ appId: 'home-source', keepBackups: true });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(deleted, ['installation:home-source'], 'backup records survive an uninstall that keeps backups');
});

test('verify failures keep archive listings out of job logs', async () => {
  const { fsImpl } = harness({ ...done(ARCHIVE), [`${ARCHIVE}/database.dump`]: { kind: 'file', content: 'garbage', uid: 1001 } });
  const handlers = createLifecycleHandlers({ fsImpl, asUser: (user, fn) => fn(), lookupUser: () => SOVEREIGN, run: async () => { throw Object.assign(new Error('exit 1'), { code: 'OPERATION_FAILED', output: { stdout: 'TABLE public secret_table_name', stderr: 'pg_restore: error: corrupt' } }); } });
  await assert.rejects(() => handlers['backup.verify'](op('backup.verify', { risk: 'read', archiveName: '20260924T101010Z' }), { layout: SOURCE }), (error) => error.output.stdout === '' && /corrupt/.test(error.output.stderr));
});

test('an uninstall re-run after the database was dropped backs up what remains instead of failing', async () => {
  const pgAnswers = { exists: '' };
  const { fsImpl, calls, handlers } = (() => {
    const h = harness();
    const handlers = createLifecycleHandlers({
      fsImpl: h.fsImpl, asUser: (user, fn) => fn(), now: () => new Date('2026-09-24T10:10:10.000Z'),
      lookupUser: (name) => (name === 'postgres' ? { uid: 999, gid: 999 } : SOVEREIGN),
      run: async (input) => { h.calls.push(input); return { stdout: input.binary === '/usr/bin/psql' ? pgAnswers.exists : '' }; },
    });
    return { ...h, handlers };
  })();
  const output = await handlers['backup.create'](op('backup.create', { archiveName: '20260924T101010Z', whatRemains: true }), { layout: SOURCE });
  assert.equal(calls.some((call) => call.binary === '/usr/bin/pg_dump'), false, 'no dump of a database that no longer exists');
  assert.match(output, /\.env\.backup/);
  assert.equal(fsImpl.existsSync(`${ARCHIVE}/database.dump`), false);

  pgAnswers.exists = '1\n';
  const withDb = harness();
  const strict = createLifecycleHandlers({
    fsImpl: withDb.fsImpl, asUser: (user, fn) => fn(),
    lookupUser: (name) => (name === 'postgres' ? { uid: 999, gid: 999 } : SOVEREIGN),
    run: async (input) => { withDb.calls.push(input); if (input.binary === '/usr/bin/pg_dump') throw Object.assign(new Error('dump failed'), { code: 'OPERATION_FAILED' }); return { stdout: input.binary === '/usr/bin/psql' ? '1\n' : '' }; },
  });
  await assert.rejects(() => strict['backup.create'](op('backup.create', { archiveName: '20260924T101010Z', whatRemains: true }), { layout: SOURCE }), /dump failed/, 'an existing database must still dump successfully');
});

test('only uninstall may take a "what remains" backup', () => {
  const restore = buildAppRestorePlan({ appId: 'home-source', backupId: '20260101T000000Z' });
  restore.operations.find((entry) => entry.id === 'safety-backup').whatRemains = true;
  assert.throws(() => validateOperationPolicy(restore), /Only uninstall safety backups/);
  const uninstall = buildAppUninstallPlan({ appId: 'home-source', keepBackups: true });
  assert.equal(uninstall.operations[0].whatRemains, true);
  assert.equal(validateOperationPolicy(uninstall), uninstall);
});

test('a database-free app backs up and restores its storage alone, and refuses an unfinished archive', async () => {
  const DROP = appLayout(getAppById('home-drop'));
  const dropEnv = '/opt/sovereign-home/apps/homeDrop/.env';
  const archive = '/var/lib/sovereign-home/backups/home-drop/20260924T101010Z';
  const live = { [dropEnv]: { kind: 'file', content: 'PUBLISH_TOKEN=live-token\nPORT=3012\n', uid: 1001 }, '/opt/sovereign-home/apps/homeDrop/shares': { kind: 'dir', uid: 1001 } };

  const backup = harness(live);
  const output = await backup.handlers['backup.create'](op('backup.create', { archiveName: '20260924T101010Z' }), { layout: DROP });
  assert.match(output, /\.env\.backup, shares\.tgz/);
  assert.deepEqual(backup.calls.map((call) => call.binary), ['/usr/bin/tar'], 'no pg_dump, and no PostgreSQL probe');
  assert.equal(backup.fsImpl.readFileSync(`${archive}/backup-generated-at.txt`), '2026-09-24T10:10:10.000Z\n');

  // Interrupted after the .env copy: the only thing that tells it apart from a share-less backup is the marker.
  const unfinished = harness({ ...live, [`${archive}/.env.backup`]: { kind: 'file', content: 'PUBLISH_TOKEN=old-token\n', uid: 1001 } });
  await assert.rejects(() => unfinished.handlers['backup.verify'](op('backup.verify', { risk: 'read', archiveName: '20260924T101010Z' }), { layout: DROP }), /never finished/);
  await assert.rejects(() => unfinished.handlers['backup.restore'](op('backup.restore', { risk: 'destructive', archiveName: '20260924T101010Z' }), { layout: DROP }), /never finished/);
  assert.equal(unfinished.fsImpl.readFileSync(dropEnv), 'PUBLISH_TOKEN=live-token\nPORT=3012\n', 'the live token was not rolled back');

  const finished = harness({ ...live, ...done(archive), [`${archive}/.env.backup`]: { kind: 'file', content: 'PUBLISH_TOKEN=old-token\nPORT=3012\n', uid: 1001 }, [`${archive}/shares.tgz`]: { kind: 'file', content: 'tgz', uid: 1001 } });
  await finished.handlers['backup.verify'](op('backup.verify', { risk: 'read', archiveName: '20260924T101010Z' }), { layout: DROP });
  await finished.handlers['backup.restore'](op('backup.restore', { risk: 'destructive', archiveName: '20260924T101010Z' }), { layout: DROP });
  assert.deepEqual(finished.calls.map((call) => [call.binary, call.args.includes('-xzf') ? 'extract' : call.args[0]]), [['/usr/bin/tar', '-tzf'], ['/usr/bin/tar', 'extract']]);
  assert.match(finished.fsImpl.readFileSync(dropEnv), /^PUBLISH_TOKEN=old-token$/m);
});
