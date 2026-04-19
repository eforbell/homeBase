const test = require('node:test');
const assert = require('node:assert/strict');
const { HealthAlertNotifier } = require('../src/services/notifications');

test('health alert notifier deduplicates critical alerts during cooldown', async () => {
  let nowMs = Date.UTC(2026, 3, 18, 12, 0, 0);
  const posted = [];
  const notifier = new HealthAlertNotifier({
    now: () => nowMs,
    cooldownMs: 60_000,
    postJson: async (url, body) => {
      posted.push({ url, body });
    },
  });

  const snapshot = {
    apps: [{
      appId: 'family-help',
      runtimeStatus: 'service-down',
      recoveryHint: 'Service is down',
      checkedAt: '2026-04-18T12:00:00.000Z',
    }],
  };
  const config = {
    healthAlertsEnabled: true,
    healthAlertsWebhookUrl: 'https://alerts.example.test/hook',
    defaultHostname: 'homebase',
    defaultDomain: 'tailnet',
  };

  const first = await notifier.notifySnapshot(snapshot, config);
  const second = await notifier.notifySnapshot(snapshot, config);

  assert.equal(first.sent, 1);
  assert.equal(second.sent, 0);
  assert.equal(second.skipped, 1);
  assert.equal(posted.length, 1);

  nowMs += 61_000;
  const third = await notifier.notifySnapshot(snapshot, config);
  assert.equal(third.sent, 1);
  assert.equal(posted.length, 2);
});
