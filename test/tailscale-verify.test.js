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
