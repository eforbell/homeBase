const fs = require('fs');
const { runApproved } = require('./spawn');
const { deployKeyStatus } = require('./handlers');
const { parseNginxDump, APP_SNIPPETS } = require('../src/operations/nginx-config');

const NGINX_GATEWAY_SITE = '/etc/nginx/sites-available/sovereign-home';
const NGINX_GATEWAY_LINK = '/etc/nginx/sites-enabled/sovereign-home';
const NGINX_DEFAULT_LINK = '/etc/nginx/sites-enabled/default';
const CACHE_MS = 5000;
const SUMMARY_CHARS = 400;

function tail(text) {
  const trimmed = String(text || '').trim();
  return trimmed.length > SUMMARY_CHARS ? trimmed.slice(-SUMMARY_CHARS) : trimmed;
}

// Read-only answers to host questions the unprivileged web service is not allowed to inspect.
// Takes no caller input: the set of checks and every command/path is fixed here.
function createHostStatusCollector({ run = runApproved, fsImpl = fs, now = () => Date.now() } = {}) {
  let cached = null;
  return async function collectHostStatus() {
    if (cached && now() - cached.at < CACHE_MS) return cached.value;
    const checks = {};

    try {
      const result = await run({ binary: '/usr/sbin/nginx', args: ['-t'], uid: 0, gid: 0, timeoutMs: 5000, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' } });
      checks['nginx-config'] = { ok: true, summary: tail(result.stderr || result.stdout) || 'nginx -t passed' };
    } catch (error) {
      checks['nginx-config'] = error.code === 'ENOENT'
        ? { ok: false, summary: 'nginx is not installed yet; run host bootstrap.' }
        : { ok: false, summary: tail(error.output?.stderr || error.output?.stdout || error.message) };
    }

    try {
      const link = fsImpl.lstatSync(NGINX_GATEWAY_LINK);
      const linked = link.isSymbolicLink() && fsImpl.readlinkSync(NGINX_GATEWAY_LINK) === NGINX_GATEWAY_SITE;
      const defaultEnabled = fsImpl.existsSync(NGINX_DEFAULT_LINK);
      checks['nginx-gateway'] = linked && !defaultEnabled
        ? { ok: true, summary: `${NGINX_GATEWAY_LINK} is enabled` }
        : { ok: false, summary: linked ? 'The stock default site is still enabled alongside the managed gateway.' : `${NGINX_GATEWAY_LINK} does not point at the managed gateway site.` };
    } catch {
      checks['nginx-gateway'] = { ok: false, summary: 'The managed nginx gateway site is not enabled.', managedSiteMissing: true };
    }
    // Adopted legacy hosts keep the operator's own server block (for example erebor.forbell.com), which
    // includes the executor's snippets; the managed gateway is deliberately not installed beside it.
    if (checks['nginx-gateway'].managedSiteMissing) {
      delete checks['nginx-gateway'].managedSiteMissing;
      try {
        const dump = await run({ binary: '/usr/sbin/nginx', args: ['-T'], uid: 0, gid: 0, timeoutMs: 5000, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' }, outputLimit: 8 * 1024 * 1024 });
        const serving = parseNginxDump(dump.stdout).servers.filter((server) => server.file !== NGINX_GATEWAY_LINK && server.includes.includes(APP_SNIPPETS));
        if (serving.length) checks['nginx-gateway'] = { ok: true, summary: `Apps are served by the host's own server block (${[...new Set(serving.map((server) => server.file))].join(', ')}), which includes ${APP_SNIPPETS}.` };
      } catch { /* unreadable config: keep the warning */ }
    }

    const key = deployKeyStatus(fsImpl);
    checks['git-deploy-key'] = { ok: key === 'present', status: key };

    const value = { checks, collectedAt: new Date(now()).toISOString() };
    cached = { at: now(), value };
    return value;
  };
}

module.exports = { createHostStatusCollector };
