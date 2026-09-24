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
  assert.doesNotMatch(executorService, /NoNewPrivileges=/);
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
  assert.match(repaired.stdout, /repairing managed executor code/i);
  assert.equal(fs.existsSync(env.HOMEBASE_EXECUTOR_SOCKET_UNIT), true);
  assert.match(fs.readFileSync(path.join(env.HOMEBASE_INSTALL_DIR, 'executor', 'server.js'), 'utf8'), /executor fixture/);
  assert.match(fs.readFileSync(env.HOMEBASE_ENV_FILE, 'utf8'), /OPERATOR_SETTING=preserved/);
  assert.equal(fs.readFileSync(env.HOMEBASE_SYSTEMD_UNIT, 'utf8'), 'web unit must survive executor repair\n');
});
