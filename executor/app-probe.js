const fs = require('fs');
const http = require('http');
const { ProtocolError } = require('./protocol');
const { getAppById } = require('../src/catalog');
const { appLayout } = require('../src/operations/app-layout');

// Health and readiness for apps Home Base can't reach itself (Feature-10 SID-002): a socket app listens
// where only its user and nginx's group can connect, and Home Base's user is in neither. Root asks the app
// on Home Base's behalf, at a path fixed by the catalog, and answers with the status (and, for the
// onboarding probe only, its small JSON body). The app is untrusted: replies are bounded and short-lived.

const PROBES = Object.freeze(['liveness', 'readiness', 'onboarding']);
const PATH = /^\/[A-Za-z0-9/_.-]{0,127}$/;
const BODY_LIMIT = 16 * 1024;

function probePath(app, probe) {
  if (probe === 'liveness') return app.network?.health?.livenessPath || null;
  if (probe === 'readiness') return app.network?.health?.readinessPath || null;
  return app.onboarding?.statusPath || null;
}

// An app whose catalog entry moved to a socket but that hasn't been updated since still listens on its
// loopback port: until the socket exists, ask there (as before SID-002) instead of reporting it down.
function socketExists(socket) {
  try { return fs.lstatSync(socket).isSocket(); } catch { return false; }
}

function createAppProber({ request = http.request, timeoutMs = 2500, hasSocket = socketExists } = {}) {
  return function probeApp({ appId, probe }) {
    const app = getAppById(appId);
    if (!app || !PROBES.includes(probe)) throw new ProtocolError('INVALID_REQUEST', 'appId and probe must name a catalog app and liveness, readiness, or onboarding.');
    const layout = appLayout(app);
    const path = probePath(app, probe);
    const via = layout.listen.kind === 'unix' && !hasSocket(layout.listen.socket) ? 'tcp-until-updated' : layout.listen.kind;
    if (!path) return Promise.resolve({ appId, probe, via, configured: false });
    if (!PATH.test(path)) throw new ProtocolError('POLICY_DENIED', `${app.name} has an unusable ${probe} path.`);
    const target = via === 'unix' ? { socketPath: layout.listen.socket } : { host: '127.0.0.1', port: layout.port };
    return new Promise((resolve) => {
      let settled = false;
      let deadline = null;
      const done = (fields) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        resolve({ appId, probe, via, configured: true, ...fields });
      };
      const req = request({ ...target, path, method: 'GET', headers: { host: 'localhost' }, timeout: timeoutMs }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (probe === 'onboarding' && size <= BODY_LIMIT) chunks.push(chunk);
          if (size > BODY_LIMIT) res.destroy();
        });
        res.on('close', () => {
          let payload = null;
          if (probe === 'onboarding' && size <= BODY_LIMIT) {
            try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { payload = null; }
          }
          done({ statusCode: Number(res.statusCode || 0), ...(probe === 'onboarding' ? { payload } : {}) });
        });
      });
      req.on('timeout', () => req.destroy(new Error(`no answer within ${timeoutMs} ms`)));
      // The idle timeout alone lets an app trickle bytes forever; the whole exchange gets the same budget.
      // Settled first, so the close the destroy causes can't report a half-read reply as an answer.
      deadline = setTimeout(() => {
        done({ statusCode: null, error: 'deadline' });
        req.destroy(new Error(`no complete answer within ${timeoutMs} ms`));
      }, timeoutMs);
      req.on('error', (error) => done({ statusCode: null, error: error.code || error.message }));
      req.end();
    });
  };
}

module.exports = { PROBES, createAppProber };
