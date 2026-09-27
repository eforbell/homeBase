const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { execFileSync, spawnSync } = require('child_process');

const installer = path.join(__dirname, '..', 'install.sh');
const releaseBuilder = path.join(__dirname, '..', 'scripts', 'build-release.sh');

function createReleaseFixture(tempDir, { version = 'v9.9.9' } = {}) {
  const releaseRoot = path.join(tempDir, `homebase-${version.slice(1)}`);
  fs.mkdirSync(path.join(releaseRoot, 'src'), { recursive: true });
  fs.mkdirSync(path.join(releaseRoot, 'executor'), { recursive: true });
  fs.writeFileSync(path.join(releaseRoot, 'package.json'), '{"name":"home-base-fixture"}\n');
  fs.writeFileSync(path.join(releaseRoot, 'package-lock.json'), '{"name":"home-base-fixture","lockfileVersion":3,"packages":{}}\n');
  fs.writeFileSync(path.join(releaseRoot, 'server.js'), 'console.log("fixture");\n');
  fs.writeFileSync(path.join(releaseRoot, 'executor', 'server.js'), 'console.log("executor fixture");\n');
  fs.writeFileSync(path.join(releaseRoot, 'src', 'app.js'), 'module.exports = {};\n');
  fs.mkdirSync(path.join(releaseRoot, 'schemas'), { recursive: true });
  fs.writeFileSync(path.join(releaseRoot, 'schemas', 'plan.schema.json'), '{}\n');

  const archive = path.join(tempDir, `homebase-${version.slice(1)}.tar.gz`);
  execFileSync('tar', ['-czf', archive, '-C', tempDir, path.basename(releaseRoot)]);
  const digest = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  const checksum = `${archive}.sha256`;
  fs.writeFileSync(checksum, `${digest}  ${path.basename(archive)}\n`);
  return { archive, checksum, releaseRoot, version };
}

function createSourceCheckout(tempDir, { version = 'v9.9.9' } = {}) {
  const fixture = createReleaseFixture(tempDir, { version });
  execFileSync('git', ['init', '--quiet', fixture.releaseRoot]);
  execFileSync('git', ['-C', fixture.releaseRoot, 'config', 'user.name', 'Home Base Test']);
  execFileSync('git', ['-C', fixture.releaseRoot, 'config', 'user.email', 'test@example.invalid']);
  execFileSync('git', ['-C', fixture.releaseRoot, 'add', '.']);
  execFileSync('git', ['-C', fixture.releaseRoot, 'commit', '--quiet', '-m', 'fixture']);
  return fixture;
}

function installerEnv(tempDir, fixture, overrides = {}) {
  return {
    ...process.env,
    HOMEBASE_TEST_MODE: '1',
    HOMEBASE_OS_ID: 'ubuntu',
    HOMEBASE_OS_VERSION_ID: '24.04',
    HOMEBASE_ARCHIVE_URL: pathToFileURL(fixture.archive).href,
    HOMEBASE_CHECKSUM_URL: pathToFileURL(fixture.checksum).href,
    HOMEBASE_INSTALL_DIR: path.join(tempDir, 'opt', 'homebase'),
    HOMEBASE_STATE_DIR: path.join(tempDir, 'var', 'homebase'),
    HOMEBASE_ENV_FILE: path.join(tempDir, 'etc', 'homebase.env'),
    HOMEBASE_SYSTEMD_UNIT: path.join(tempDir, 'systemd', 'homebase.service'),
    HOMEBASE_LEGACY_SUDOERS_FILE: path.join(tempDir, 'sudoers.d', 'homebase'),
    HOMEBASE_EXECUTOR_SOCKET_UNIT: path.join(tempDir, 'systemd', 'homebase-executor.socket'),
    HOMEBASE_EXECUTOR_SERVICE_UNIT: path.join(tempDir, 'systemd', 'homebase-executor.service'),
    HOMEBASE_EXECUTOR_SOCKET_PATH: path.join(tempDir, 'run', 'executor.sock'),
    ...overrides,
  };
}

function runInstaller(args, env) {
  return spawnSync('bash', [installer, ...args], {
    env,
    encoding: 'utf8',
  });
}

test('installer help states the plan-only privilege boundary', () => {
  const result = runInstaller(['--help'], process.env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /hardened, loopback-only, plan-first/i);
  assert.match(result.stdout, /does not grant Home Base sudo access/i);
});

test('release builder accepts only installer-compatible stable tags', () => {
  const result = spawnSync('bash', [releaseBuilder, 'v1.2.3-beta'], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /vX\.Y\.Z/);
});

test('installer dry-run resolves a non-mutating plan', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebase-installer-dry-'));
  const fixture = createReleaseFixture(tempDir);
  const env = installerEnv(tempDir, fixture);
  const result = runInstaller(['--version', fixture.version, '--dry-run'], env);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Execution mode: executor/);
  assert.match(result.stdout, /Privileged jobs: disabled/);
  assert.equal(fs.existsSync(env.HOMEBASE_INSTALL_DIR), false);
});

test('installer rejects malformed release tags and unsafe path overrides', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebase-installer-inputs-'));
  const fixture = createReleaseFixture(tempDir);
  const env = installerEnv(tempDir, fixture);

  const badVersion = runInstaller(['--version', 'main', '--dry-run'], env);
  assert.notEqual(badVersion.status, 0);
  assert.match(badVersion.stderr, /version must be a tag/i);

  const badPath = runInstaller(['--version', fixture.version, '--dry-run'], {
    ...env,
    HOMEBASE_INSTALL_DIR: path.join(tempDir, 'unsafe path'),
  });
  assert.notEqual(badPath.status, 0);
  assert.match(badPath.stderr, /may not contain whitespace/i);
});

test('installer verifies and installs a release with hardened defaults', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebase-installer-'));
  const fixture = createReleaseFixture(tempDir);
  const env = installerEnv(tempDir, fixture);
  const result = runInstaller(['--version', fixture.version, '--no-start'], env);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(env.HOMEBASE_INSTALL_DIR, '.homebase-version'), 'utf8').trim(), fixture.version);
  assert.equal(fs.existsSync(path.join(env.HOMEBASE_INSTALL_DIR, 'server.js')), true);

  const runtimeEnv = fs.readFileSync(env.HOMEBASE_ENV_FILE, 'utf8');
  assert.match(runtimeEnv, /HOME_BASE_BIND_HOST=127\.0\.0\.1/);
  assert.match(runtimeEnv, /HOME_BASE_EXECUTION_MODE=executor/);
  assert.match(runtimeEnv, /HOME_BASE_ENABLE_PRIVILEGED_JOBS=1/);
  assert.match(runtimeEnv, /HOME_BASE_AUTO_BOOTSTRAP=0/);
  assert.match(runtimeEnv, /HOME_BASE_EXECUTOR_SOCKET=/);

  const service = fs.readFileSync(env.HOMEBASE_SYSTEMD_UNIT, 'utf8');
  assert.match(service, /NoNewPrivileges=true/);
  assert.match(service, /ProtectSystem=strict/);
  assert.match(service, /ReadWritePaths=/);
  assert.doesNotMatch(service, /sudo|NOPASSWD/);

  const executorSocket = fs.readFileSync(env.HOMEBASE_EXECUTOR_SOCKET_UNIT, 'utf8');
  const executorService = fs.readFileSync(env.HOMEBASE_EXECUTOR_SERVICE_UNIT, 'utf8');
  assert.match(executorSocket, /SocketGroup=homebase-exec/);
  assert.match(executorSocket, /SocketMode=0660/);
  assert.match(executorService, /User=root/);
  // The root executor drives apt/dpkg, so it must not block their documented privilege transitions,
  // setuid file installs, or impose a restrictive umask on maintainer scripts.
  assert.doesNotMatch(executorService, /NoNewPrivileges=/);
  assert.doesNotMatch(executorService, /RestrictSUIDSGID=/);
  assert.doesNotMatch(executorService, /ProtectHome=/);
  assert.match(executorService, /UMask=0022/);
  const checkedIn = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'homebase-executor.service'), 'utf8');
  const directives = (unit) => unit.split('\n').filter((line) => /^[A-Z]\w+=/.test(line) && !/^ExecStart=/.test(line));
  assert.deepEqual(directives(executorService), directives(checkedIn));
});

test('installer provisions a root-only git deploy key and switches Home Base to SSH transport', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebase-installer-key-'));
  const fixture = createReleaseFixture(tempDir);
  const keyDir = path.join(tempDir, 'etc', 'git');
  const env = installerEnv(tempDir, fixture, { HOMEBASE_GIT_DEPLOY_KEY_DIR: keyDir });
  const keySource = path.join(tempDir, 'id_ed25519');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'homebase-test', '-f', keySource]);

  const result = runInstaller(['--version', fixture.version, '--no-start', '--git-ssh-key', keySource], env);
  assert.equal(result.status, 0, result.stderr);
  const installedKey = path.join(keyDir, 'deploy_key');
  assert.equal(fs.readFileSync(installedKey, 'utf8'), fs.readFileSync(keySource, 'utf8'));
  assert.equal(fs.statSync(installedKey).mode & 0o777, 0o600);
  const runtimeEnv = fs.readFileSync(env.HOMEBASE_ENV_FILE, 'utf8');
  assert.match(runtimeEnv, /^HOME_BASE_GIT_TRANSPORT=ssh-key$/m);
  assert.equal(runtimeEnv.match(/^HOME_BASE_GIT_TRANSPORT=/gm).length, 1);
  assert.match(runtimeEnv, new RegExp(`^HOME_BASE_GIT_SSH_KEY_PATH=${installedKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE KEY/);

  const encrypted = path.join(tempDir, 'encrypted_key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', 'passphrase', '-f', encrypted]);
  const rejected = runInstaller(['--version', fixture.version, '--no-start', '--git-ssh-key', encrypted], env);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /unencrypted/);

  const relative = runInstaller(['--version', fixture.version, '--no-start', '--git-ssh-key', 'id_ed25519'], env);
  assert.notEqual(relative.status, 0);
  assert.match(relative.stderr, /absolute path/);
});

test('installer packages a clean local checkout without contacting GitHub releases', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebase-installer-source-'));
  const fixture = createSourceCheckout(tempDir);
  const result = runInstaller(['--version', fixture.version, '--source-dir', fixture.releaseRoot, '--no-start'], installerEnv(tempDir, fixture, {
    HOMEBASE_ARCHIVE_URL: 'https://invalid.example/homebase.tar.gz',
    HOMEBASE_CHECKSUM_URL: 'https://invalid.example/homebase.tar.gz.sha256',
  }));

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /packaging Home Base .* from local commit/);
  assert.equal(fs.existsSync(path.join(tempDir, 'opt', 'homebase', 'server.js')), true);
});

test('installer refuses a dirty local checkout', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebase-installer-source-dirty-'));
  const fixture = createSourceCheckout(tempDir);
  fs.appendFileSync(path.join(fixture.releaseRoot, 'server.js'), '// dirty\n');
  const result = runInstaller(['--version', fixture.version, '--source-dir', fixture.releaseRoot, '--no-start'], installerEnv(tempDir, fixture));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must have a clean Git working tree/i);
});

test('installer keeps the release tag separate from os-release VERSION metadata', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebase-installer-os-release-'));
  const fixture = createReleaseFixture(tempDir);
  const osRelease = path.join(tempDir, 'os-release');
  fs.writeFileSync(osRelease, [
    'ID=ubuntu',
    'VERSION_ID="24.04"',
    'VERSION="24.04.4 LTS (Noble Numbat)"',
    '',
  ].join('\n'));
  const env = installerEnv(tempDir, fixture, {
    HOMEBASE_OS_ID: '',
    HOMEBASE_OS_VERSION_ID: '',
    HOMEBASE_OS_RELEASE_FILE: osRelease,
  });
  const result = runInstaller(['--version', fixture.version, '--no-start'], env);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(env.HOMEBASE_INSTALL_DIR, '.homebase-version'), 'utf8').trim(), fixture.version);
  assert.match(result.stdout, new RegExp(`Home Base ${fixture.version.replaceAll('.', '\\.')} installed`));
});

test('installer accepts Ubuntu 22.04 derivatives such as Linux Mint 21 and refuses older bases', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebase-installer-mint-'));
  const fixture = createReleaseFixture(tempDir);
  const osRelease = path.join(tempDir, 'os-release');
  const write = (lines) => fs.writeFileSync(osRelease, `${lines.join('\n')}\n`);
  const env = installerEnv(tempDir, fixture, { HOMEBASE_OS_ID: '', HOMEBASE_OS_VERSION_ID: '', HOMEBASE_OS_RELEASE_FILE: osRelease });
  // numenor's os-release.
  write(['NAME="Linux Mint"', 'VERSION="21.3 (Virginia)"', 'ID=linuxmint', 'ID_LIKE="ubuntu debian"', 'VERSION_ID="21.3"', 'UBUNTU_CODENAME=jammy']);
  const mint = runInstaller(['--version', fixture.version, '--no-start'], env);
  assert.equal(mint.status, 0, mint.stderr);

  write(['ID=linuxmint', 'ID_LIKE="ubuntu debian"', 'VERSION_ID="20.3"', 'UBUNTU_CODENAME=focal']);
  const old = runInstaller(['--version', fixture.version, '--no-start'], env);
  assert.notEqual(old.status, 0);
  assert.match(old.stderr, /Ubuntu base focal \(22\.04 jammy or newer required\)/);

  write(['ID=ubuntu', 'VERSION_ID="20.04"']);
  assert.match(runInstaller(['--version', fixture.version, '--no-start'], env).stderr, /Ubuntu 22\.04 or newer is required/);
});

test('installer rerun preserves existing environment state', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebase-installer-rerun-'));
  const fixture = createReleaseFixture(tempDir);
  const env = installerEnv(tempDir, fixture);
  const first = runInstaller(['--version', fixture.version, '--no-start'], env);
  assert.equal(first.status, 0, first.stderr);

  fs.appendFileSync(env.HOMEBASE_ENV_FILE, 'OPERATOR_SETTING=preserved\n');
  const second = runInstaller(['--version', fixture.version, '--no-start'], env);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /preserving code, config, and state/i);
  assert.match(fs.readFileSync(env.HOMEBASE_ENV_FILE, 'utf8'), /OPERATOR_SETTING=preserved/);
});

test('installer fails closed on checksum mismatch', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebase-installer-checksum-'));
  const fixture = createReleaseFixture(tempDir);
  fs.writeFileSync(fixture.checksum, `${'0'.repeat(64)}  bad.tar.gz\n`);
  const result = runInstaller(['--version', fixture.version, '--no-start'], installerEnv(tempDir, fixture));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /checksum verification failed/i);
});

test('installer refuses any pre-existing Home Base sudoers policy', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebase-installer-sudoers-'));
  const fixture = createReleaseFixture(tempDir);
  const env = installerEnv(tempDir, fixture);
  fs.mkdirSync(path.dirname(env.HOMEBASE_LEGACY_SUDOERS_FILE), { recursive: true });
  fs.writeFileSync(env.HOMEBASE_LEGACY_SUDOERS_FILE, 'homebase ALL=(ALL) NOPASSWD:ALL\n');
  const result = runInstaller(['--version', fixture.version, '--no-start'], env);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /existing Home Base sudoers policy detected/i);
});

test('installer refuses preserved environment settings that enable legacy execution', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebase-installer-legacy-env-'));
  const fixture = createReleaseFixture(tempDir);
  const env = installerEnv(tempDir, fixture);
  const first = runInstaller(['--version', fixture.version, '--no-start'], env);
  assert.equal(first.status, 0, first.stderr);

  fs.appendFileSync(env.HOMEBASE_ENV_FILE, 'HOME_BASE_EXECUTION_MODE="legacy-sudo"\n');
  const second = runInstaller(['--version', fixture.version, '--no-start'], env);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /existing environment enables unsafe or unknown execution settings/i);
});

test('installer accepts explicit quoted fail-closed environment settings', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebase-installer-safe-env-'));
  const fixture = createReleaseFixture(tempDir);
  const env = installerEnv(tempDir, fixture);
  const first = runInstaller(['--version', fixture.version, '--no-start'], env);
  assert.equal(first.status, 0, first.stderr);

  fs.writeFileSync(env.HOMEBASE_ENV_FILE, [
    'HOME_BASE_EXECUTION_MODE="plan-only"',
    'HOME_BASE_ENABLE_PRIVILEGED_JOBS="false"',
    'HOME_BASE_AUTO_BOOTSTRAP="off"',
    '',
  ].join('\n'));
  const second = runInstaller(['--version', fixture.version, '--no-start'], env);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /preserving existing environment file/i);
});


test('installer repair refreshes managed executor assets without replacing state or environment', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebase-installer-repair-executor-'));
  const fixture = createReleaseFixture(tempDir);
  const env = installerEnv(tempDir, fixture);
  assert.equal(runInstaller(['--version', fixture.version, '--no-start'], env).status, 0);
  fs.appendFileSync(env.HOMEBASE_ENV_FILE, 'OPERATOR_SETTING=preserved\n');
  fs.writeFileSync(env.HOMEBASE_SYSTEMD_UNIT, 'web unit must survive executor repair\n');
  fs.rmSync(env.HOMEBASE_EXECUTOR_SOCKET_UNIT);
  fs.writeFileSync(path.join(env.HOMEBASE_INSTALL_DIR, 'executor', 'server.js'), 'damaged\n');
  const repaired = runInstaller(['--version', fixture.version, '--repair-executor', '--no-start'], env);
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.match(repaired.stdout, /repairing executor code and the shared modules it loads/i);
  assert.equal(fs.existsSync(env.HOMEBASE_EXECUTOR_SOCKET_UNIT), true);
  assert.match(fs.readFileSync(path.join(env.HOMEBASE_INSTALL_DIR, 'executor', 'server.js'), 'utf8'), /executor fixture/);
  assert.match(fs.readFileSync(env.HOMEBASE_ENV_FILE, 'utf8'), /OPERATOR_SETTING=preserved/);
  assert.equal(fs.readFileSync(env.HOMEBASE_SYSTEMD_UNIT, 'utf8'), 'web unit must survive executor repair\n');
});

test('repair restores drifted executor-mode settings and repair-executor refreshes the shared code the executor loads', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebase-installer-repair-'));
  const fixture = createReleaseFixture(tempDir);
  const env = installerEnv(tempDir, fixture);
  assert.equal(runInstaller(['--version', fixture.version, '--no-start'], env).status, 0);

  const envFile = env.HOMEBASE_ENV_FILE;
  fs.writeFileSync(envFile, fs.readFileSync(envFile, 'utf8')
    .replace('HOME_BASE_ENABLE_PRIVILEGED_JOBS=1', 'HOME_BASE_ENABLE_PRIVILEGED_JOBS=0')
    .replace('HOME_BASE_BIND_HOST=127.0.0.1', 'HOME_BASE_BIND_HOST=0.0.0.0')
    .replace(/HOME_BASE_EXECUTOR_SOCKET=.*/, 'HOME_BASE_EXECUTOR_SOCKET=/tmp/elsewhere.sock')
    .concat('OPERATOR_SETTING=keep-me\n'));
  const repaired = runInstaller(['--version', fixture.version, '--no-start', '--repair'], env);
  assert.equal(repaired.status, 0, repaired.stderr);
  const after = fs.readFileSync(envFile, 'utf8');
  assert.match(after, /^HOME_BASE_ENABLE_PRIVILEGED_JOBS=1$/m);
  assert.match(after, /^HOME_BASE_BIND_HOST=127\.0\.0\.1$/m);
  assert.match(after, new RegExp(`^HOME_BASE_EXECUTOR_SOCKET=${env.HOMEBASE_EXECUTOR_SOCKET_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.match(after, /^HOME_BASE_EXECUTION_MODE=executor$/m);
  assert.match(after, /^OPERATOR_SETTING=keep-me$/m, 'unrelated settings are preserved');
  assert.equal(after.match(/^HOME_BASE_BIND_HOST=/gm).length, 1);

  for (const [dir, file] of [['executor', 'server.js'], ['src', 'app.js'], ['schemas', 'plan.schema.json']]) {
    fs.writeFileSync(path.join(fixture.releaseRoot, dir, file), `// refreshed ${dir}\n`);
  }
  const rebuilt = createReleaseFixture(tempDir);
  void rebuilt;
  fs.writeFileSync(path.join(env.HOMEBASE_INSTALL_DIR, 'src', 'app.js'), '// stale src\n');
  fs.writeFileSync(path.join(env.HOMEBASE_INSTALL_DIR, 'schemas', 'plan.schema.json'), '// stale schema\n');
  const executorRepair = runInstaller(['--version', fixture.version, '--no-start', '--repair-executor'], env);
  assert.equal(executorRepair.status, 0, executorRepair.stderr);
  assert.doesNotMatch(fs.readFileSync(path.join(env.HOMEBASE_INSTALL_DIR, 'src', 'app.js'), 'utf8'), /stale/);
  assert.doesNotMatch(fs.readFileSync(path.join(env.HOMEBASE_INSTALL_DIR, 'schemas', 'plan.schema.json'), 'utf8'), /stale/);
  assert.equal(fs.readFileSync(envFile, 'utf8'), after, 'repair-executor leaves the environment file alone');
});

function legacyHost(tempDir, fixture, { adopted = [], legacyApps = [], runningJobs = [], adopting = [] } = {}) {
  const env = installerEnv(tempDir, fixture, {
    HOMEBASE_COEXIST_EXECUTOR_DIR: path.join(tempDir, 'opt', 'homebase-executor'),
    HOMEBASE_STATE_DB: path.join(tempDir, 'var', 'homebase', 'home-base.sqlite3'),
    HOMEBASE_GIT_DEPLOY_KEY_DIR: path.join(tempDir, 'etc', 'git'),
    HOMEBASE_COEXIST_MARKER: path.join(tempDir, 'etc', 'legacy-coexistence'),
  });
  // What erebor looks like: a runtime-user-owned web checkout without a version marker, a sudoers
  // policy, and a legacy-sudo env file.
  fs.mkdirSync(env.HOMEBASE_INSTALL_DIR, { recursive: true });
  fs.writeFileSync(path.join(env.HOMEBASE_INSTALL_DIR, 'server.js'), '// legacy checkout\n');
  fs.mkdirSync(path.dirname(env.HOMEBASE_LEGACY_SUDOERS_FILE), { recursive: true });
  fs.writeFileSync(env.HOMEBASE_LEGACY_SUDOERS_FILE, 'homebase ALL=(ALL) NOPASSWD:ALL\n');
  fs.mkdirSync(path.dirname(env.HOMEBASE_ENV_FILE), { recursive: true });
  fs.writeFileSync(env.HOMEBASE_ENV_FILE, 'PORT=3080\nHOME_BASE_GIT_TRANSPORT=https\nHOME_BASE_EXECUTION_MODE=legacy-sudo\nHOME_BASE_ENABLE_PRIVILEGED_JOBS=1\nHOME_BASE_AUTO_BOOTSTRAP=1\n');
  fs.mkdirSync(path.dirname(env.HOMEBASE_STATE_DB), { recursive: true });
  const rows = [...adopted.map((id) => [id, 'executor']), ...legacyApps.map((id) => [id, null]), ...adopting.map((id) => [id, 'adopting'])];
  execFileSync('python3', ['-c', `
import sqlite3, sys, json
conn = sqlite3.connect(sys.argv[1])
conn.execute("CREATE TABLE installations (app_id TEXT PRIMARY KEY, status TEXT NOT NULL, managed_by TEXT)")
conn.execute("CREATE TABLE jobs (id INTEGER PRIMARY KEY, kind TEXT, target TEXT, status TEXT, dry_run INTEGER)")
for app_id, managed in json.loads(sys.argv[2]):
    conn.execute("INSERT INTO installations VALUES (?, ?, ?)", (app_id, 'planned' if managed == 'adopting' else 'installed', managed))
for kind, target in json.loads(sys.argv[3]):
    conn.execute("INSERT INTO jobs (kind, target, status, dry_run) VALUES (?, ?, 'running', 0)", (kind, target))
conn.commit()
`, env.HOMEBASE_STATE_DB, JSON.stringify(rows), JSON.stringify(runningJobs)]);
  return env;
}

test('--add-executor installs a root-owned executor beside a legacy host without changing its mode or git path', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebase-installer-add-'));
  const fixture = createSourceCheckout(tempDir);
  const env = legacyHost(tempDir, fixture);
  const key = path.join(tempDir, 'id_founder_homebase');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
  const result = runInstaller(['--version', fixture.version, '--source-dir', fixture.releaseRoot, '--add-executor', '--git-ssh-key', key], env);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(env.HOMEBASE_COEXIST_EXECUTOR_DIR, 'executor', 'server.js')));
  assert.match(fs.readFileSync(env.HOMEBASE_EXECUTOR_SERVICE_UNIT, 'utf8'), new RegExp(`ExecStart=\\S+ ${env.HOMEBASE_COEXIST_EXECUTOR_DIR.replaceAll('/', '\\/')}/executor/server\\.js`));
  const envFile = fs.readFileSync(env.HOMEBASE_ENV_FILE, 'utf8');
  assert.match(envFile, /^HOME_BASE_EXECUTION_MODE=legacy-sudo$/m);
  assert.match(envFile, /^HOME_BASE_GIT_TRANSPORT=https$/m, 'legacy apps keep their git path');
  assert.match(envFile, /^HOME_BASE_EXECUTOR_GIT_TRANSPORT=ssh$/m);
  assert.match(envFile, /^HOME_BASE_EXECUTOR_SOCKET=/m);
  assert.ok(fs.existsSync(path.join(env.HOMEBASE_GIT_DEPLOY_KEY_DIR, 'deploy_key')));
  // Nothing of the legacy service changed.
  assert.equal(fs.readFileSync(path.join(env.HOMEBASE_INSTALL_DIR, 'server.js'), 'utf8'), '// legacy checkout\n');
  assert.ok(fs.existsSync(env.HOMEBASE_LEGACY_SUDOERS_FILE));
  assert.equal(fs.existsSync(env.HOMEBASE_SYSTEMD_UNIT), false);
  assert.match(result.stdout, /include \/etc\/nginx\/sovereign-home\.d\/\*\.conf;/);
  assert.ok(fs.existsSync(env.HOMEBASE_COEXIST_MARKER), 'adopt is enabled while the host coexists');
});

test('--add-executor refuses while legacy jobs are running, because it restarts the web service', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebase-installer-add-busy-'));
  const fixture = createSourceCheckout(tempDir);
  const env = legacyHost(tempDir, fixture, { runningJobs: [['install', 'helm']] });
  const result = runInstaller(['--version', fixture.version, '--source-dir', fixture.releaseRoot, '--add-executor'], env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /legacy jobs are in progress \(1:install:helm\)/);
  assert.equal(runInstaller(['--version', fixture.version, '--source-dir', fixture.releaseRoot, '--add-executor', '--force'], env).status, 0);
});

test('--add-executor and --switch-to-executor refuse hosts that are not in legacy-sudo mode', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebase-installer-notlegacy-'));
  const fixture = createSourceCheckout(tempDir);
  const env = legacyHost(tempDir, fixture);
  fs.writeFileSync(env.HOMEBASE_ENV_FILE, 'HOME_BASE_EXECUTION_MODE=executor\n');
  for (const flag of ['--add-executor', '--switch-to-executor']) {
    const result = runInstaller(['--version', fixture.version, '--source-dir', fixture.releaseRoot, flag], env);
    assert.notEqual(result.status, 0, flag);
    assert.match(result.stderr, /is for legacy-sudo hosts/, flag);
  }
  const both = runInstaller(['--version', fixture.version, '--add-executor', '--repair'], env);
  assert.match(both.stderr, /mutually exclusive/);
});

test('--switch-to-executor refuses while any installed app is still legacy-managed', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebase-installer-switch-refuse-'));
  const fixture = createSourceCheckout(tempDir);
  const env = legacyHost(tempDir, fixture, { adopted: ['helm'], legacyApps: ['family-dinner', 'home-source'] });
  const added = runInstaller(['--version', fixture.version, '--source-dir', fixture.releaseRoot, '--add-executor'], env);
  assert.equal(added.status, 0, added.stderr);
  const result = runInstaller(['--version', fixture.version, '--source-dir', fixture.releaseRoot, '--switch-to-executor'], env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not adopted yet; adopt \(or uninstall\) them first: family-dinner home-source/);
  // --force does not skip this check.
  assert.notEqual(runInstaller(['--version', fixture.version, '--source-dir', fixture.releaseRoot, '--switch-to-executor', '--force'], env).status, 0);
  assert.ok(fs.existsSync(env.HOMEBASE_LEGACY_SUDOERS_FILE));
});

test('--switch-to-executor replaces the legacy checkout with the managed install and retires the sudo policy', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebase-installer-switch-'));
  const fixture = createSourceCheckout(tempDir);
  const env = legacyHost(tempDir, fixture, { adopted: ['helm', 'family-dinner'] });
  assert.equal(runInstaller(['--version', fixture.version, '--source-dir', fixture.releaseRoot, '--add-executor'], env).status, 0);
  const result = runInstaller(['--version', fixture.version, '--source-dir', fixture.releaseRoot, '--switch-to-executor'], env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(env.HOMEBASE_INSTALL_DIR, '.homebase-version'), 'utf8').trim(), fixture.version);
  const aside = fs.readdirSync(path.dirname(env.HOMEBASE_INSTALL_DIR)).find((name) => name.startsWith('homebase.legacy-'));
  assert.ok(aside, 'the legacy checkout is kept aside');
  assert.equal(fs.readFileSync(path.join(path.dirname(env.HOMEBASE_INSTALL_DIR), aside, 'server.js'), 'utf8'), '// legacy checkout\n');
  const envFile = fs.readFileSync(env.HOMEBASE_ENV_FILE, 'utf8');
  assert.match(envFile, /^HOME_BASE_EXECUTION_MODE=executor$/m);
  assert.match(envFile, /^HOME_BASE_AUTO_BOOTSTRAP=0$/m);
  assert.match(envFile, /^HOME_BASE_BIND_HOST=127\.0\.0\.1$/m);
  assert.equal(fs.existsSync(env.HOMEBASE_LEGACY_SUDOERS_FILE), false);
  assert.equal(fs.existsSync(env.HOMEBASE_COEXIST_EXECUTOR_DIR), false);
  assert.equal(fs.existsSync(env.HOMEBASE_COEXIST_MARKER), false, 'adopt is gone after the switch');
  const backup = fs.readdirSync(path.dirname(env.HOMEBASE_ENV_FILE)).find((name) => name.startsWith('switch-backup-'));
  assert.match(fs.readFileSync(path.join(path.dirname(env.HOMEBASE_ENV_FILE), backup, 'homebase.env'), 'utf8'), /^HOME_BASE_EXECUTION_MODE=legacy-sudo$/m, 'the pre-switch env is kept for rollback');
  assert.match(fs.readFileSync(env.HOMEBASE_EXECUTOR_SERVICE_UNIT, 'utf8'), new RegExp(`${env.HOMEBASE_INSTALL_DIR.replaceAll('/', '\\/')}/executor/server\\.js`));
  assert.match(fs.readFileSync(env.HOMEBASE_SYSTEMD_UNIT, 'utf8'), /^NoNewPrivileges=true$/m);
});

test('--switch-to-executor resumes after stopping partway, and refuses a state database the hardened unit cannot write', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebase-installer-resume-'));
  const fixture = createSourceCheckout(tempDir);
  const env = legacyHost(tempDir, fixture, { adopted: ['helm'] });
  assert.equal(runInstaller(['--version', fixture.version, '--source-dir', fixture.releaseRoot, '--add-executor'], env).status, 0);
  // A previous switch saved its backup, wrote executor mode, then stopped before removing sudoers and the
  // coexistence copy.
  const firstBackup = path.join(path.dirname(env.HOMEBASE_ENV_FILE), 'switch-backup-20260101000000');
  fs.mkdirSync(firstBackup);
  fs.copyFileSync(env.HOMEBASE_ENV_FILE, path.join(firstBackup, 'homebase.env'));
  fs.writeFileSync(env.HOMEBASE_ENV_FILE, fs.readFileSync(env.HOMEBASE_ENV_FILE, 'utf8').replace('HOME_BASE_EXECUTION_MODE=legacy-sudo', 'HOME_BASE_EXECUTION_MODE=executor'));
  const resumed = runInstaller(['--version', fixture.version, '--source-dir', fixture.releaseRoot, '--switch-to-executor'], env);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stdout, /resuming a --switch-to-executor that stopped partway/);
  // The resume keeps the first backup, the only one that still holds the pre-switch state.
  const backups = fs.readdirSync(path.dirname(env.HOMEBASE_ENV_FILE)).filter((name) => name.startsWith('switch-backup-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.existsSync(env.HOMEBASE_LEGACY_SUDOERS_FILE), false);

  const outside = legacyHost(fs.mkdtempSync(path.join(os.tmpdir(), 'homebase-installer-statedb-')), createSourceCheckout(fs.mkdtempSync(path.join(os.tmpdir(), 'homebase-installer-statedb-src-'))), { adopted: ['helm'] });
  assert.equal(runInstaller(['--version', fixture.version, '--source-dir', fixture.releaseRoot, '--add-executor'], outside).status, 0);
  const moved = path.join(path.dirname(path.dirname(outside.HOMEBASE_STATE_DB)), 'elsewhere.sqlite3');
  fs.copyFileSync(outside.HOMEBASE_STATE_DB, moved);
  const refused = runInstaller(['--version', fixture.version, '--source-dir', fixture.releaseRoot, '--switch-to-executor'], { ...outside, HOMEBASE_STATE_DB: moved });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /outside .* the only directory the hardened service may write/);
});

test('without HOME_BASE_STATE_DB in the env file the switch refuses instead of moving the state aside', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebase-installer-nostate-'));
  const fixture = createSourceCheckout(tempDir);
  const env = legacyHost(tempDir, fixture, { adopted: ['helm'] });
  assert.equal(runInstaller(['--version', fixture.version, '--source-dir', fixture.releaseRoot, '--add-executor'], env).status, 0);
  const { HOMEBASE_STATE_DB, ...withoutOverride } = env;
  const result = runInstaller(['--version', fixture.version, '--source-dir', fixture.releaseRoot, '--switch-to-executor'], withoutOverride);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /sets neither HOME_BASE_STATE_DB nor HOME_BASE_DATA_DIR/);
});

test('an adopt that never finished blocks the switch even if its record no longer says installed', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebase-installer-adopting-'));
  const fixture = createSourceCheckout(tempDir);
  const env = legacyHost(tempDir, fixture, { adopted: ['helm'], adopting: ['bitcoin-accounting'] });
  assert.equal(runInstaller(['--version', fixture.version, '--source-dir', fixture.releaseRoot, '--add-executor'], env).status, 0);
  const result = runInstaller(['--version', fixture.version, '--source-dir', fixture.releaseRoot, '--switch-to-executor'], env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not adopted yet.*: bitcoin-accounting/);
});

test('--switch-to-executor refuses --no-start, since cleanup must follow a verified start', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebase-installer-nostart-'));
  const fixture = createSourceCheckout(tempDir);
  const env = legacyHost(tempDir, fixture, { adopted: ['helm'] });
  assert.equal(runInstaller(['--version', fixture.version, '--source-dir', fixture.releaseRoot, '--add-executor'], env).status, 0);
  const result = runInstaller(['--version', fixture.version, '--source-dir', fixture.releaseRoot, '--switch-to-executor', '--no-start'], env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot be combined with --no-start/);
  assert.ok(fs.existsSync(env.HOMEBASE_LEGACY_SUDOERS_FILE), 'nothing was removed');
  assert.ok(fs.existsSync(env.HOMEBASE_COEXIST_MARKER));
  assert.ok(fs.existsSync(env.HOMEBASE_COEXIST_EXECUTOR_DIR));
});

test('a trailing slash on --source-dir works, and a missing release points to --source-dir', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebase-installer-slash-'));
  const fixture = createSourceCheckout(tempDir);
  const env = installerEnv(tempDir, fixture);
  const slashed = runInstaller(['--version', fixture.version, '--source-dir', `${fixture.releaseRoot}/`, '--no-start'], env);
  assert.equal(slashed.status, 0, slashed.stderr);
  const missing = runInstaller(['--version', fixture.version, '--no-start'], installerEnv(fs.mkdtempSync(path.join(os.tmpdir(), 'homebase-installer-404-')), fixture, { HOMEBASE_ARCHIVE_URL: pathToFileURL(path.join(tempDir, 'nope.tar.gz')).href }));
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /If no release is published yet, clone the repository as root and pass --source-dir/);
});
