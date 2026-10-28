const fs = require('fs');
const { runApproved } = require('./spawn');
const { resolveAppIdentity } = require('./identity');
const {
  lookupSystemUser, runAsUser, readExistingDatabasePassword,
  lstatOrNull, readSmallFileNoFollow, SUPERUSER_SQL_PREAMBLE, writeFileAtomic, requireLayout, deny,
} = require('./handlers');
const { parseDotEnv, renderEnv, storageEnvOverrides } = require('../src/operations/env');

// Backup, restore, and uninstall primitives. Anything inside app-owned directories (the checkout,
// .env, backups, storage) is read, written, or removed as the app's user (its own for a sensitive app,
// SID-002, otherwise sovereign); root only touches root-owned paths derived from the catalog layout
// (unit files, the nginx snippet, the git mirror) and the root-owned apps/ and backups/ directories.

const { BACKUP_ROOT } = require('../src/operations/paths');
// Legacy restore semantics: the backup's .env comes back, but live database wiring is kept.
// backup.create writes this last; an archive without it was interrupted (also what the inventory dates by).
const COMPLETION_MARKER = 'backup-generated-at.txt';
const PRESERVED_DB_ENV_KEYS = ['DATABASE_URL', 'HELM_DATABASE_URL', 'DB_BACKEND', 'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'SQLITE_DB_PATH'];

function createLifecycleHandlers({ fsImpl = fs, run = runApproved, lookupUser = (name) => lookupSystemUser(name, fsImpl), asUser = runAsUser, now = () => new Date() } = {}) {
  const ownerOf = (layout) => resolveAppIdentity(layout, { fsImpl, lookupUser });
  const isRealDir = (target) => { const stat = lstatOrNull(fsImpl, target); return Boolean(stat && !stat.isSymbolicLink() && stat.isDirectory()); };
  const isRealFile = (target) => { const stat = lstatOrNull(fsImpl, target); return Boolean(stat && !stat.isSymbolicLink() && stat.isFile()); };
  const archiveDirFor = (layout, archiveName) => `${BACKUP_ROOT}/${layout.app.id}/${archiveName}`;
  const pgEnvironment = (layout, owner, password) => ({
    PATH: '/usr/bin:/bin', HOME: owner.home, LANG: 'C',
    PGHOST: '127.0.0.1', PGPORT: '5432', PGUSER: layout.database.user, PGDATABASE: layout.database.name, PGPASSWORD: password,
  });
  const databasePassword = (layout) => {
    const password = readExistingDatabasePassword({ layout, fsImpl, lookupUser, asUser });
    if (!password) deny(`${layout.app.name} has no database wiring in its .env.`);
    return password;
  };
  const asOwner = (owner, spec) => run({ ...spec, uid: owner.uid, gid: owner.gid });
  const databaseExists = async (layout) => {
    const postgres = lookupUser('postgres') || deny('The postgres identity does not exist.');
    // The name is a validated, non-reserved identifier (app-layout.js).
    const result = await run({ binary: '/usr/bin/psql', args: ['-X', '-v', 'ON_ERROR_STOP=1', '-d', 'postgres', '-tA'], uid: postgres.uid, gid: postgres.gid, stdin: `${SUPERUSER_SQL_PREAMBLE}SELECT 1 FROM pg_database WHERE datname = '${layout.database.name}';\n`, timeoutMs: 30000, env: { PATH: '/usr/bin:/bin', HOME: '/var/lib/postgresql', LANG: 'C' } });
    return String(result.stdout || '').trim() === '1';
  };
  // Integrity reads list archive members (file and table names); keep those out of web-visible job logs.
  const verifyAsOwner = async (owner, spec) => {
    try { return await asOwner(owner, spec); } catch (error) {
      if (error.output) error.output = { ...error.output, stdout: '' };
      throw error;
    }
  };
  // Create tool output files 0600 up front: pg_dump and tar would otherwise create them under the
  // executor's 0022 umask, leaving a database dump world-readable until the job finished.
  const createPrivateFile = (owner, target) => asUser(owner, () => fsImpl.closeSync(fsImpl.openSync(target, 'wx', 0o600)));
  // backups/ is root-owned (SID-002); hosts from before it had it owned by sovereign, so root takes it back
  // through a no-follow descriptor (its parent, /var/lib/sovereign-home, is root-owned).
  const rootOwnBackupRoot = () => {
    const stat = lstatOrNull(fsImpl, BACKUP_ROOT);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) deny(`${BACKUP_ROOT} is missing; run host bootstrap.`);
    if (stat.uid === 0) return;
    const fd = fsImpl.openSync(BACKUP_ROOT, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { fsImpl.fchownSync(fd, 0, 0); fsImpl.fchmodSync(fd, 0o755); } finally { fsImpl.closeSync(fd); }
  };
  // The app's backup directory, owned by its user: private for a sensitive app, listable by Home Base's
  // inventory otherwise. Root creates it inside the root-owned backups/ and hands it over by descriptor.
  const ensureBackupDir = (layout, owner) => {
    rootOwnBackupRoot();
    const appDir = `${BACKUP_ROOT}/${layout.app.id}`;
    const stat = lstatOrNull(fsImpl, appDir);
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) deny(`${appDir} is not a real directory.`);
    if (!stat) fsImpl.mkdirSync(appDir, { mode: 0o700 });
    const fd = fsImpl.openSync(appDir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      fsImpl.fchownSync(fd, owner.uid, owner.gid);
      fsImpl.fchmodSync(fd, owner.own ? 0o700 : 0o755);
    } finally { fsImpl.closeSync(fd); }
    return appDir;
  };
  // Empties an app-owned directory as its user, then root removes the directory itself from its
  // root-owned parent (the user can no longer unlink entries there).
  const removeOwnedDirectory = (owner, target) => {
    const stat = lstatOrNull(fsImpl, target);
    if (!stat) return;
    if (stat.isSymbolicLink() || !stat.isDirectory()) deny(`${target} is not a real directory.`);
    asUser(owner, () => {
      for (const entry of fsImpl.readdirSync(target)) fsImpl.rmSync(`${target}/${entry}`, { recursive: true, force: true });
    });
    fsImpl.rmdirSync(target);
  };

  return {
    'backup.create': async (operation, { layout } = {}) => {
      requireLayout(layout);
      const owner = ownerOf(layout);
      // A normal backup requires the database. An uninstall's "what remains" backup asks PostgreSQL
      // (read-only, as postgres) whether the database still exists: if it does, the dump must succeed;
      // if an interrupted uninstall already dropped it, there is nothing to dump.
      const dumpDatabase = Boolean(layout.database) && (!operation.whatRemains || await databaseExists(layout));
      const password = dumpDatabase ? databasePassword(layout) : null;
      ensureBackupDir(layout, owner);
      const archiveDir = archiveDirFor(layout, operation.archiveName);
      const included = [];
      // A shared app's archive is listable by Home Base's inventory, and every secret-bearing file inside is
      // 0600; a sensitive app's is private to its user. Modes are set explicitly so they never depend on the
      // process umask (or on how an older release made them).
      const archiveMode = owner.own ? 0o700 : 0o755;
      asUser(owner, () => {
        fsImpl.mkdirSync(archiveDir, { mode: archiveMode });
        fsImpl.chmodSync(archiveDir, archiveMode);
        const envContent = readSmallFileNoFollow(fsImpl, layout.envPath);
        if (envContent != null) {
          writeFileAtomic(fsImpl, `${archiveDir}/.env.backup`, envContent, 0o600);
          included.push('.env.backup');
        }
      });
      if (dumpDatabase) {
        createPrivateFile(owner, `${archiveDir}/database.dump`);
        await asOwner(owner, { binary: '/usr/bin/pg_dump', args: ['--no-password', '-Fc', '-f', `${archiveDir}/database.dump`], timeoutMs: operation.timeoutMs, env: pgEnvironment(layout, owner, password), secrets: [password] });
        included.push('database.dump');
      }
      for (const subpath of layout.storage?.subpaths || []) {
        const present = asUser(owner, () => isRealDir(`${layout.storage.root}/${subpath}`));
        if (!present) continue;
        createPrivateFile(owner, `${archiveDir}/${subpath}.tgz`);
        await asOwner(owner, { binary: '/usr/bin/tar', args: ['-C', layout.storage.root, '-czf', `${archiveDir}/${subpath}.tgz`, subpath], timeoutMs: operation.timeoutMs, env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
        included.push(`${subpath}.tgz`);
      }
      // Written last: its presence is what marks the archive complete (verify and restore require it).
      asUser(owner, () => writeFileAtomic(fsImpl, `${archiveDir}/${COMPLETION_MARKER}`, `${now().toISOString()}\n`, 0o644));
      return `created backup ${operation.archiveName} (${included.join(', ') || 'no files'})`;
    },

    // Proves a restore source is usable before a restore plan stops anything: the archive exists and was
    // finished, a database-backed app has its dump, and every archive present passes an integrity read.
    'backup.verify': async (operation, { layout } = {}) => {
      requireLayout(layout);
      const owner = ownerOf(layout);
      const archiveDir = archiveDirFor(layout, operation.archiveName);
      const present = asUser(owner, () => ({
        archive: isRealDir(archiveDir),
        complete: isRealFile(`${archiveDir}/${COMPLETION_MARKER}`),
        dump: isRealFile(`${archiveDir}/database.dump`),
        storage: (layout.storage?.subpaths || []).filter((subpath) => isRealFile(`${archiveDir}/${subpath}.tgz`)),
      }));
      if (!present.archive) deny(`Backup ${operation.archiveName} does not exist for ${layout.app.name}.`);
      if (!present.complete) deny(`Backup ${operation.archiveName} never finished; refusing to restore ${layout.app.name} from an incomplete backup.`);
      if (layout.database && !present.dump) deny(`Backup ${operation.archiveName} has no database dump; refusing to restore ${layout.app.name} from an incomplete backup.`);
      const checked = [];
      if (layout.database) {
        await verifyAsOwner(owner, { binary: '/usr/bin/pg_restore', args: ['--list', `${archiveDir}/database.dump`], timeoutMs: operation.timeoutMs, env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
        checked.push('database.dump');
      }
      for (const subpath of present.storage) {
        await verifyAsOwner(owner, { binary: '/usr/bin/tar', args: ['-tzf', `${archiveDir}/${subpath}.tgz`], timeoutMs: operation.timeoutMs, env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
        checked.push(`${subpath}.tgz`);
      }
      const missingStorage = (layout.storage?.subpaths || []).filter((subpath) => !present.storage.includes(subpath));
      const note = missingStorage.length ? `; not in this backup, so kept as-is: ${missingStorage.join(', ')}` : '';
      return `verified ${operation.archiveName} (${checked.join(', ') || 'no archives'})${note}`;
    },

    'backup.restore': async (operation, { layout } = {}) => {
      requireLayout(layout);
      const owner = ownerOf(layout);
      const archiveDir = archiveDirFor(layout, operation.archiveName);
      const present = asUser(owner, () => ({
        archive: isRealDir(archiveDir),
        complete: isRealFile(`${archiveDir}/${COMPLETION_MARKER}`),
        env: isRealFile(`${archiveDir}/.env.backup`),
        dump: isRealFile(`${archiveDir}/database.dump`),
        storage: (layout.storage?.subpaths || []).filter((subpath) => isRealFile(`${archiveDir}/${subpath}.tgz`)),
      }));
      if (!present.archive) deny(`Backup ${operation.archiveName} does not exist for ${layout.app.name}.`);
      // An archive without the marker was interrupted mid-write: its storage may simply be missing, which
      // would otherwise read as "not in this backup, kept as-is" (the only check a database-free app gets).
      if (!present.complete) deny(`Backup ${operation.archiveName} never finished; refusing a partial restore of ${layout.app.name}.`);
      // Never report success for a database-backed app without restoring its database.
      if (layout.database && !present.dump) deny(`Backup ${operation.archiveName} has no database dump; refusing a partial restore of ${layout.app.name}.`);
      const restored = [];
      if (present.env) {
        asUser(owner, () => {
          const restoredEnv = parseDotEnv(readSmallFileNoFollow(fsImpl, `${archiveDir}/.env.backup`) ?? deny('The backup .env is not a regular file.'));
          const current = parseDotEnv(readSmallFileNoFollow(fsImpl, layout.envPath) ?? '');
          for (const key of PRESERVED_DB_ENV_KEYS) {
            if (!current[key]) continue;
            delete restoredEnv[key];
            restoredEnv[key] = current[key];
          }
          // A backup taken before the catalog declared its storage env key must not point the app away from the archived root.
          Object.assign(restoredEnv, storageEnvOverrides(layout.app));
          writeFileAtomic(fsImpl, layout.envPath, renderEnv(restoredEnv), owner.own ? 0o600 : 0o640);
        });
        restored.push('.env');
      }
      if (layout.database && present.dump) {
        // As the app's own role, never the superuser: a crafted dump can only affect this app's database.
        const password = databasePassword(layout);
        await asOwner(owner, { binary: '/usr/bin/pg_restore', args: ['--no-password', '--clean', '--if-exists', '-d', layout.database.name, `${archiveDir}/database.dump`], timeoutMs: operation.timeoutMs, env: pgEnvironment(layout, owner, password), secrets: [password] });
        restored.push('database');
      }
      for (const subpath of present.storage) {
        const target = `${layout.storage.root}/${subpath}`;
        asUser(owner, () => {
          if (!isRealDir(layout.storage.root)) deny(`${layout.storage.root} is missing; reinstall ${layout.app.name} first.`);
          fsImpl.rmSync(target, { recursive: true, force: true });
        });
        await asOwner(owner, { binary: '/usr/bin/tar', args: ['-C', layout.storage.root, '--no-same-owner', '-xzf', `${archiveDir}/${subpath}.tgz`], timeoutMs: operation.timeoutMs, env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
        restored.push(subpath);
      }
      return `restored ${operation.archiveName} (${restored.join(', ') || 'nothing to restore'})`;
    },

    'backup.remove-all': async (operation, { layout } = {}) => {
      requireLayout(layout);
      const owner = ownerOf(layout);
      rootOwnBackupRoot();
      removeOwnedDirectory(owner, `${BACKUP_ROOT}/${layout.app.id}`);
      return `removed ${layout.app.name} backups`;
    },

    'filesystem.remove-app-artifacts': async (operation, { layout } = {}) => {
      requireLayout(layout);
      const removed = [];
      // All of these live in root-owned directories; unlink removes a planted symlink, never its target.
      const socketFiles = layout.listen?.kind === 'unix' ? [layout.listen.tmpfiles] : [];
      for (const target of [...layout.unitNames.map((unit) => `/etc/systemd/system/${unit}`), layout.nginxSnippet, layout.legacyNginxSnippet, ...socketFiles]) {
        const stat = lstatOrNull(fsImpl, target);
        if (!stat) continue;
        if (stat.isDirectory()) deny(`${target} is a directory.`);
        fsImpl.unlinkSync(target);
        removed.push(target);
      }
      // The socket directory is the app's (its parent, /run/sovereign-apps, is root's).
      if (layout.listen?.kind === 'unix' && lstatOrNull(fsImpl, layout.listen.directory)) {
        removeOwnedDirectory(ownerOf(layout), layout.listen.directory);
        removed.push(layout.listen.directory);
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
      const owner = ownerOf(layout);
      removeOwnedDirectory(owner, layout.checkout);
      return `removed ${layout.checkout}`;
    },

    'postgres.drop-database': async (operation, { layout } = {}) => {
      requireLayout(layout);
      const postgres = lookupUser('postgres');
      if (!postgres || !layout.database || operation.database !== layout.database.name || operation.owner !== layout.database.user) deny('Database drop does not match this app.');
      const { name, user } = layout.database; // validated, non-reserved simple identifiers (app-layout.js)
      const sql = `${SUPERUSER_SQL_PREAMBLE}DROP DATABASE IF EXISTS "${name}" WITH (FORCE);\nDROP ROLE IF EXISTS "${user}";\n`;
      await run({ binary: '/usr/bin/psql', args: ['-X', '-v', 'ON_ERROR_STOP=1', '-d', 'postgres'], uid: postgres.uid, gid: postgres.gid, stdin: sql, timeoutMs: operation.timeoutMs, env: { PATH: '/usr/bin:/bin', HOME: '/var/lib/postgresql', LANG: 'C' } });
      return `dropped database ${name} and role ${user}`;
    },
  };
}

module.exports = { BACKUP_ROOT, createLifecycleHandlers };
