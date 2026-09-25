const fs = require('fs');
const { runApproved } = require('./spawn');
const {
  SOVEREIGN_HOME, lookupSystemUser, runAsUser, readExistingDatabasePassword,
  lstatOrNull, writeFileAtomic, requireLayout, deny,
} = require('./handlers');
const { parseDotEnv, renderEnv } = require('../src/operations/env');

// Backup, restore, and uninstall primitives. Anything inside app-owned directories (the checkout,
// .env, backups, storage) is read, written, or removed as sovereign; root only touches root-owned
// paths derived from the catalog layout (unit files, the nginx snippet, the git mirror).

const { BACKUP_ROOT } = require('../src/operations/paths');
// Legacy restore semantics: the backup's .env comes back, but live database wiring is kept.
const PRESERVED_DB_ENV_KEYS = ['DATABASE_URL', 'HELM_DATABASE_URL', 'DB_BACKEND', 'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'SQLITE_DB_PATH'];

function createLifecycleHandlers({ fsImpl = fs, run = runApproved, lookupUser = (name) => lookupSystemUser(name, fsImpl), asUser = runAsUser, now = () => new Date() } = {}) {
  const sovereignOrDeny = () => lookupUser('sovereign') || deny('The sovereign identity does not exist.');
  const isRealDir = (target) => { const stat = lstatOrNull(fsImpl, target); return Boolean(stat && !stat.isSymbolicLink() && stat.isDirectory()); };
  const isRealFile = (target) => { const stat = lstatOrNull(fsImpl, target); return Boolean(stat && !stat.isSymbolicLink() && stat.isFile()); };
  const archiveDirFor = (layout, archiveName) => `${BACKUP_ROOT}/${layout.app.id}/${archiveName}`;
  const pgEnvironment = (layout, password) => ({
    PATH: '/usr/bin:/bin', HOME: SOVEREIGN_HOME, LANG: 'C',
    PGHOST: '127.0.0.1', PGPORT: '5432', PGUSER: layout.database.user, PGDATABASE: layout.database.name, PGPASSWORD: password,
  });
  const databasePassword = (layout) => {
    const password = readExistingDatabasePassword({ layout, fsImpl, lookupUser, asUser });
    if (!password) deny(`${layout.app.name} has no database wiring in its .env.`);
    return password;
  };
  const asSovereign = (sovereign, spec) => run({ ...spec, uid: sovereign.uid, gid: sovereign.gid });
  // Integrity reads list archive members (file and table names); keep those out of web-visible job logs.
  const verifyAsSovereign = async (sovereign, spec) => {
    try { return await asSovereign(sovereign, spec); } catch (error) {
      if (error.output) error.output = { ...error.output, stdout: '' };
      throw error;
    }
  };
  // Create tool output files 0600 up front: pg_dump and tar would otherwise create them under the
  // executor's 0022 umask, leaving a database dump world-readable until the job finished.
  const createPrivateFile = (sovereign, target) => asUser(sovereign, () => fsImpl.closeSync(fsImpl.openSync(target, 'wx', 0o600)));

  return {
    'backup.create': async (operation, { layout } = {}) => {
      requireLayout(layout);
      const sovereign = sovereignOrDeny();
      const password = layout.database ? databasePassword(layout) : null;
      const appDir = `${BACKUP_ROOT}/${layout.app.id}`;
      const archiveDir = archiveDirFor(layout, operation.archiveName);
      const included = [];
      asUser(sovereign, () => {
        if (!isRealDir(BACKUP_ROOT)) deny(`${BACKUP_ROOT} is missing; run host bootstrap.`);
        if (!lstatOrNull(fsImpl, appDir)) fsImpl.mkdirSync(appDir, { mode: 0o755 });
        if (!isRealDir(appDir)) deny(`${appDir} is not a real directory.`);
        // Listable by Home Base's inventory; every secret-bearing file inside is 0600. Modes are set
        // explicitly so they never depend on the process umask (or on how an older release made them).
        fsImpl.chmodSync(appDir, 0o755);
        fsImpl.mkdirSync(archiveDir, { mode: 0o755 });
        fsImpl.chmodSync(archiveDir, 0o755);
        if (isRealFile(layout.envPath)) {
          writeFileAtomic(fsImpl, `${archiveDir}/.env.backup`, fsImpl.readFileSync(layout.envPath, 'utf8'), 0o600);
          included.push('.env.backup');
        }
      });
      if (layout.database) {
        createPrivateFile(sovereign, `${archiveDir}/database.dump`);
        await asSovereign(sovereign, { binary: '/usr/bin/pg_dump', args: ['--no-password', '-Fc', '-f', `${archiveDir}/database.dump`], timeoutMs: operation.timeoutMs, env: pgEnvironment(layout, password), secrets: [password] });
        included.push('database.dump');
      }
      for (const subpath of layout.storage?.subpaths || []) {
        const present = asUser(sovereign, () => isRealDir(`${layout.storage.root}/${subpath}`));
        if (!present) continue;
        createPrivateFile(sovereign, `${archiveDir}/${subpath}.tgz`);
        await asSovereign(sovereign, { binary: '/usr/bin/tar', args: ['-C', layout.storage.root, '-czf', `${archiveDir}/${subpath}.tgz`, subpath], timeoutMs: operation.timeoutMs, env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
        included.push(`${subpath}.tgz`);
      }
      asUser(sovereign, () => writeFileAtomic(fsImpl, `${archiveDir}/backup-generated-at.txt`, `${now().toISOString()}\n`, 0o644));
      return `created backup ${operation.archiveName} (${included.join(', ') || 'no files'})`;
    },

    // Proves a restore source is usable before a restore plan stops anything: the archive exists, a
    // database-backed app has its dump, and every archive present passes an integrity read.
    'backup.verify': async (operation, { layout } = {}) => {
      requireLayout(layout);
      const sovereign = sovereignOrDeny();
      const archiveDir = archiveDirFor(layout, operation.archiveName);
      const present = asUser(sovereign, () => ({
        archive: isRealDir(archiveDir),
        dump: isRealFile(`${archiveDir}/database.dump`),
        storage: (layout.storage?.subpaths || []).filter((subpath) => isRealFile(`${archiveDir}/${subpath}.tgz`)),
      }));
      if (!present.archive) deny(`Backup ${operation.archiveName} does not exist for ${layout.app.name}.`);
      if (layout.database && !present.dump) deny(`Backup ${operation.archiveName} has no database dump; refusing to restore ${layout.app.name} from an incomplete backup.`);
      const checked = [];
      if (layout.database) {
        await verifyAsSovereign(sovereign, { binary: '/usr/bin/pg_restore', args: ['--list', `${archiveDir}/database.dump`], timeoutMs: operation.timeoutMs, env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
        checked.push('database.dump');
      }
      for (const subpath of present.storage) {
        await verifyAsSovereign(sovereign, { binary: '/usr/bin/tar', args: ['-tzf', `${archiveDir}/${subpath}.tgz`], timeoutMs: operation.timeoutMs, env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
        checked.push(`${subpath}.tgz`);
      }
      const missingStorage = (layout.storage?.subpaths || []).filter((subpath) => !present.storage.includes(subpath));
      const note = missingStorage.length ? `; not in this backup, so kept as-is: ${missingStorage.join(', ')}` : '';
      return `verified ${operation.archiveName} (${checked.join(', ') || 'no archives'})${note}`;
    },

    'backup.restore': async (operation, { layout } = {}) => {
      requireLayout(layout);
      const sovereign = sovereignOrDeny();
      const archiveDir = archiveDirFor(layout, operation.archiveName);
      const present = asUser(sovereign, () => ({
        archive: isRealDir(archiveDir),
        env: isRealFile(`${archiveDir}/.env.backup`),
        dump: isRealFile(`${archiveDir}/database.dump`),
        storage: (layout.storage?.subpaths || []).filter((subpath) => isRealFile(`${archiveDir}/${subpath}.tgz`)),
      }));
      if (!present.archive) deny(`Backup ${operation.archiveName} does not exist for ${layout.app.name}.`);
      // Never report success for a database-backed app without restoring its database.
      if (layout.database && !present.dump) deny(`Backup ${operation.archiveName} has no database dump; refusing a partial restore of ${layout.app.name}.`);
      const restored = [];
      if (present.env) {
        asUser(sovereign, () => {
          const restoredEnv = parseDotEnv(fsImpl.readFileSync(`${archiveDir}/.env.backup`, 'utf8'));
          const current = isRealFile(layout.envPath) ? parseDotEnv(fsImpl.readFileSync(layout.envPath, 'utf8')) : {};
          for (const key of PRESERVED_DB_ENV_KEYS) {
            if (!current[key]) continue;
            delete restoredEnv[key];
            restoredEnv[key] = current[key];
          }
          writeFileAtomic(fsImpl, layout.envPath, renderEnv(restoredEnv), 0o640);
        });
        restored.push('.env');
      }
      if (layout.database && present.dump) {
        // As the app's own role, never the superuser: a crafted dump can only affect this app's database.
        const password = databasePassword(layout);
        await asSovereign(sovereign, { binary: '/usr/bin/pg_restore', args: ['--no-password', '--clean', '--if-exists', '-d', layout.database.name, `${archiveDir}/database.dump`], timeoutMs: operation.timeoutMs, env: pgEnvironment(layout, password), secrets: [password] });
        restored.push('database');
      }
      for (const subpath of present.storage) {
        const target = `${layout.storage.root}/${subpath}`;
        asUser(sovereign, () => {
          if (!isRealDir(layout.storage.root)) deny(`${layout.storage.root} is missing; reinstall ${layout.app.name} first.`);
          fsImpl.rmSync(target, { recursive: true, force: true });
        });
        await asSovereign(sovereign, { binary: '/usr/bin/tar', args: ['-C', layout.storage.root, '--no-same-owner', '-xzf', `${archiveDir}/${subpath}.tgz`], timeoutMs: operation.timeoutMs, env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
        restored.push(subpath);
      }
      return `restored ${operation.archiveName} (${restored.join(', ') || 'nothing to restore'})`;
    },

    'backup.remove-all': async (operation, { layout } = {}) => {
      requireLayout(layout);
      const sovereign = sovereignOrDeny();
      asUser(sovereign, () => fsImpl.rmSync(`${BACKUP_ROOT}/${layout.app.id}`, { recursive: true, force: true }));
      return `removed ${layout.app.name} backups`;
    },

    'filesystem.remove-app-artifacts': async (operation, { layout } = {}) => {
      requireLayout(layout);
      const removed = [];
      // All of these live in root-owned directories; unlink removes a planted symlink, never its target.
      for (const target of [...layout.unitNames.map((unit) => `/etc/systemd/system/${unit}`), layout.nginxSnippet]) {
        const stat = lstatOrNull(fsImpl, target);
        if (!stat) continue;
        if (stat.isDirectory()) deny(`${target} is a directory.`);
        fsImpl.unlinkSync(target);
        removed.push(target);
      }
      const mirror = lstatOrNull(fsImpl, layout.mirror);
      if (mirror) {
        if (mirror.isSymbolicLink() || !mirror.isDirectory() || mirror.uid !== 0) deny(`${layout.mirror} is not the root-owned git mirror.`);
        fsImpl.rmSync(layout.mirror, { recursive: true, force: true });
        removed.push(layout.mirror);
      }
      return `removed ${removed.length} artifacts`;
    },

    'filesystem.remove-checkout': async (operation, { layout } = {}) => {
      requireLayout(layout);
      const sovereign = sovereignOrDeny();
      asUser(sovereign, () => fsImpl.rmSync(layout.checkout, { recursive: true, force: true }));
      return `removed ${layout.checkout}`;
    },

    'postgres.drop-database': async (operation, { layout } = {}) => {
      requireLayout(layout);
      const postgres = lookupUser('postgres');
      if (!postgres || !layout.database || operation.database !== layout.database.name || operation.owner !== layout.database.user) deny('Database drop does not match this app.');
      const { name, user } = layout.database; // validated, non-reserved simple identifiers (app-layout.js)
      const sql = `DROP DATABASE IF EXISTS "${name}" WITH (FORCE);\nDROP ROLE IF EXISTS "${user}";\n`;
      await run({ binary: '/usr/bin/psql', args: ['-v', 'ON_ERROR_STOP=1', '-d', 'postgres'], uid: postgres.uid, gid: postgres.gid, stdin: sql, timeoutMs: operation.timeoutMs, env: { PATH: '/usr/bin:/bin', HOME: '/var/lib/postgresql', LANG: 'C' } });
      return `dropped database ${name} and role ${user}`;
    },
  };
}

module.exports = { BACKUP_ROOT, createLifecycleHandlers };
