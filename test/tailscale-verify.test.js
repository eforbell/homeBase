const test = require('node:test');
const assert = require('node:assert/strict');
const { getTailscalePublishVerification } = require('../src/services/tailscale-verify');

function fakeRunner({ listen443 = true, serveConfig } = {}) {
  return (command) => {
    if (command === 'command -v tailscale') return { command, ok: true, exitCode: 0, stdout: '/usr/bin/tailscale\n', stderr: '' };
    if (command === 'tailscale version') return { command, ok: true, exitCode: 0, stdout: '1.96.4\n', stderr: '' };
    if (command === 'tailscale status --json') {
      return {
        command,
        ok: true,
        exitCode: 0,
        stdout: JSON.stringify({
          BackendState: 'Running',
          Self: { HostName: 'host-apps-1', DNSName: 'host-apps-1.example.ts.net.' },
          CurrentTailnet: { Name: 'example.tailnet' },
          MagicDNSSuffix: 'example.ts.net',
        }),
        stderr: '',
      };
    }
    if (command === 'tailscale serve get-config --all') {
      return {
        command,
        ok: true,
        exitCode: 0,
        stdout: JSON.stringify(serveConfig || {
          version: '0.0.1',
          services: {
            'svc:home': {
              endpoints: {
                'tcp:3080': 'http://127.0.0.1:3080',
                'tcp:443': 'https+insecure://localhost:443',
              },
            },
          },
        }),
        stderr: '',
      };
    }
    if (command.includes("ss -lnt")) {
      return {
        command,
        ok: listen443,
        exitCode: listen443 ? 0 : 1,
        stdout: listen443 ? '0.0.0.0:443\n' : '',
        stderr: listen443 ? '' : 'no listener',
      };
    }
    return { command, ok: false, exitCode: 127, stdout: '', stderr: 'unsupported command' };
  };
}

test('verify marks repair required when nginx is not listening on 443', () => {
  const payload = getTailscalePublishVerification({
    hostname: 'homebase',
    domain: 'tailnet',
    run: fakeRunner({ listen443: false }),
  });

  assert.equal(payload.repairRequired, true);
  assert.equal(payload.checks.find((c) => c.id === 'nginx-listen-443').ok, false);
});

test('verify marks stale config when hostname/domain differ from last published host', () => {
  const payload = getTailscalePublishVerification({
    hostname: 'homebase-new',
    domain: 'tailnet',
    run: fakeRunner({ listen443: true }),
    lastPublishedJob: {
      id: 77,
      finishedAt: '2026-04-25T18:00:00Z',
      resultJson: JSON.stringify({
        desiredHost: 'homebase-old',
        desiredDomain: 'tailnet',
        homebaseUrl: 'https://homebase-old.tailnet:3080',
        appsBaseUrl: 'https://homebase-old.tailnet',
      }),
    },
  });

  assert.equal(payload.staleBecauseConfigChanged, true);
  assert.equal(payload.repairRequired, true);
  assert.match(payload.staleReason, /homebase-new\.tailnet/);
  assert.match(payload.staleReason, /homebase-old\.tailnet/);
});

test('verify returns copyable recommended urls for current hostname/domain', () => {
  const payload = getTailscalePublishVerification({
    hostname: 'hb',
    domain: 'tailnet',
    run: fakeRunner({ listen443: true }),
  });

  assert.equal(payload.recommendedUrls.homebase, 'https://hb.tailnet:3080');
  assert.equal(payload.recommendedUrls.appsBase, 'https://hb.tailnet');
});


test('verify uses configurable managed service id in checks', () => {
  const payload = getTailscalePublishVerification({
    hostname: 'hb',
    domain: 'tailnet',
    managedServiceId: 'svc:test',
    run: fakeRunner({
      listen443: true,
      serveConfig: {
        version: '0.0.1',
        services: {
          'svc:test': {
            endpoints: {
              'tcp:3080': 'http://127.0.0.1:3080',
              'tcp:443': 'https+insecure://localhost:443',
            },
          },
        },
      },
    }),
  });

  assert.equal(payload.managedServiceId, 'svc:test');
  const serveCheck = payload.checks.find((c) => c.id === 'serve-home-endpoints');
  assert.match(serveCheck.title, /svc:test/);
  assert.equal(serveCheck.ok, true);
});

test('socket ingress: verified by sockets and per-service targets, never by a tcp:443 listener', () => {
  const { getIngressVerification } = require('../src/services/tailscale-verify');
  const services = (extra = {}) => ({ version: '0.0.1', services: { 'svc:smith-home': { endpoints: { 'tcp:443': 'https://unix:/run/sovereign-serve/home.sock' } }, ...extra } });
  // Recorded shape on the test VM: tailscaled itself listens on the host's tailnet addresses (Serve).
  const listeners = ['127.0.0.1:3080', '100.64.0.1:443', '[fd7a:115c:a1e0::1]:443', '100.64.0.1:3080'];
  const sockets = ['u_str LISTEN 0 511 /run/sovereign-serve/home.sock 41207 * 0', 'u_str LISTEN 0 4096 /run/homebase-identity/identity.sock 41210 * 0'];
  const run = ({ ss = listeners, unix = sockets, serve = services() } = {}) => (command) => {
    if (command.startsWith('ss -lxn')) return { ok: true, stdout: `Netid State Recv-Q Send-Q Local Address:Port Peer Address:Port\n${unix.join('\n')}\n` };
    if (command.startsWith('tailscale status')) return { ok: true, stdout: JSON.stringify({ Self: { TailscaleIPs: ['100.64.0.1', 'fd7a:115c:a1e0::1'] } }) };
    if (command.startsWith('ss ')) return { ok: true, stdout: `${ss.join('\n')}\n` };
    if (command.startsWith('tailscale serve get-config')) return { ok: true, stdout: JSON.stringify(serve) };
    return { ok: false, stdout: '' };
  };
  const rootDir = { isDirectory: () => true, uid: 0, mode: 0o40700 };
  const verify = (options = {}, statFn = () => rootDir) => getIngressVerification({ instance: 'smith', domain: 'example-tailnet.ts.net', run: run(options), statFn });
  const result = (checks) => Object.fromEntries(checks.map((check) => [check.id, check.ok]));
  assert.deepEqual(result(verify().checks), { 'no-suite-tcp-listener': true, 'serve-sockets-root-only': true, 'services-target-own-sockets': true, 'service-sockets-listening': true });
  assert.equal(verify().repairRequired, false);
  assert.equal(result(verify({ ss: [...listeners, '0.0.0.0:443'] }).checks)['no-suite-tcp-listener'], false, 'nginx back on TCP');
  assert.equal(result(verify({ ss: [...listeners, '[::]:80'] }).checks)['no-suite-tcp-listener'], false);
  assert.equal(result(verify({}, () => ({ ...rootDir, mode: 0o40755 })).checks)['serve-sockets-root-only'], false);
  assert.equal(result(verify({}, () => { throw new Error('ENOENT'); }).checks)['serve-sockets-root-only'], false);
  assert.equal(result(verify({ serve: services({ 'svc:smith-pulse': { endpoints: { 'tcp:443': 'https://unix:/run/sovereign-serve/home.sock' } } }) }).checks)['services-target-own-sockets'], false, 'a service on another service\'s socket');
  assert.equal(result(verify({ serve: services({ 'svc:home': { endpoints: { 'tcp:443': 'https+insecure://localhost:443' } } }) }).checks)['services-target-own-sockets'], false, 'the legacy service still targets TCP');
  assert.equal(result(verify({ serve: { version: '0.0.1' } }).checks)['services-target-own-sockets'], false);
  const stopped = verify({ unix: [] });
  assert.equal(result(stopped.checks)['service-sockets-listening'], false, 'nginx stopped: Serve still targets sockets nobody answers');
  assert.equal(stopped.repairRequired, true);
  assert.equal(result(verify({ unix: ['u_str LISTEN 0 511 /run/sovereign-serve/home.sock.old 1 * 0'] }).checks)['service-sockets-listening'], false, 'exact paths only');
});
