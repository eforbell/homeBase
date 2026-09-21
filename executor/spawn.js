const { spawn } = require('child_process');
const { redactText } = require('../src/operations/redact');

const ALLOWED_BINARIES = new Set([
  '/usr/bin/apt-get', '/usr/bin/git', '/usr/bin/npm', '/usr/bin/psql', '/usr/bin/systemctl', '/usr/sbin/nginx', '/usr/bin/id',
]);
const ALLOWED_ENV_KEYS = new Set(['HOME', 'LANG', 'LC_ALL', 'NODE_ENV', 'PATH']);

function runApproved({ binary, args = [], uid, gid, cwd, env = {}, timeoutMs, outputLimit = 64 * 1024, secrets = [], spawnImpl = spawn }) {
  if (!ALLOWED_BINARIES.has(binary)) throw new Error('Executor attempted an unapproved binary.');
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new Error('Executor arguments must be a string argv array.');
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) throw new Error('Executor child identity is required.');
  if (args.some((arg) => arg.includes('\0'))) throw new Error('Executor arguments may not contain NUL bytes.');
  if (Object.keys(env).some((key) => !ALLOWED_ENV_KEYS.has(key))) throw new Error('Executor environment contains an unapproved key.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error('Executor timeout is required.');

  return new Promise((resolve, reject) => {
    const child = spawnImpl(binary, args, { shell: false, uid, gid, cwd, env: { ...env } });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const append = (current, chunk) => {
      const next = `${current}${chunk.toString('utf8')}`;
      return next.length > outputLimit ? next.slice(0, outputLimit) : next;
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
        truncated: stdout.length >= outputLimit || stderr.length >= outputLimit,
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
