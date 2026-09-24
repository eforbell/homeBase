const { spawn } = require('child_process');
const { redactText } = require('../src/operations/redact');

const ALLOWED_BINARIES = new Set([
  '/usr/bin/apt-get', '/usr/sbin/useradd', '/usr/bin/git', '/usr/bin/npm', '/usr/bin/psql', '/usr/bin/systemctl', '/usr/sbin/nginx', '/usr/bin/id',
]);
// Values for these keys are always composed by handlers from fixed strings, never from plan fields.
const ALLOWED_ENV_KEYS = new Set([
  'HOME', 'LANG', 'LC_ALL', 'NODE_ENV', 'PATH',
  'DEBIAN_FRONTEND', 'NEEDRESTART_MODE', 'GIT_SSH_COMMAND', 'GIT_TERMINAL_PROMPT', 'GIT_CONFIG_SYSTEM',
]);

function runApproved({ binary, args = [], uid, gid, cwd, env = {}, stdin = null, timeoutMs, outputLimit = 64 * 1024, secrets = [], spawnImpl = spawn }) {
  if (!ALLOWED_BINARIES.has(binary)) throw new Error('Executor attempted an unapproved binary.');
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new Error('Executor arguments must be a string argv array.');
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) throw new Error('Executor child identity is required.');
  if (args.some((arg) => arg.includes('\0'))) throw new Error('Executor arguments may not contain NUL bytes.');
  if (Object.keys(env).some((key) => !ALLOWED_ENV_KEYS.has(key))) throw new Error('Executor environment contains an unapproved key.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error('Executor timeout is required.');
  if (stdin != null && typeof stdin !== 'string') throw new Error('Executor stdin must be a string when provided.');

  return new Promise((resolve, reject) => {
    // A child without explicit stdin gets /dev/null so an unexpected prompt fails fast instead of hanging.
    const stdio = [stdin == null ? 'ignore' : 'pipe', 'pipe', 'pipe'];
    const child = spawnImpl(binary, args, { shell: false, uid, gid, cwd, env: { ...env }, stdio });
    if (stdin != null && child.stdin) child.stdin.end(stdin);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let truncated = false;
    // Keep the tail: apt, npm, and git report the actionable failure last.
    const append = (current, chunk) => {
      const next = `${current}${chunk.toString('utf8')}`;
      if (next.length <= outputLimit) return next;
      truncated = true;
      return next.slice(-outputLimit);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1000).unref();
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const output = {
        code,
        signal,
        timedOut,
        stdout: redactText(stdout, secrets),
        stderr: redactText(stderr, secrets),
        truncated,
      };
      if (timedOut) {
        const error = new Error('Approved process timed out.');
        error.code = 'OPERATION_TIMEOUT';
        error.output = output;
        reject(error);
      } else if (code !== 0) {
        const error = new Error(`Approved process exited with code ${code}.`);
        error.code = 'OPERATION_FAILED';
        error.output = output;
        reject(error);
      } else resolve(output);
    });
  });
}

module.exports = { ALLOWED_BINARIES, runApproved };
