async function defaultPostJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(body || {}),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Notification request failed (${response.status}): ${text || 'no response body'}`);
  }
}

function buildPublicBase(config = {}) {
  const hostname = config.defaultHostname || 'homebase';
  const domain = config.defaultDomain || 'tailnet';
  return `https://${hostname}.${domain}`;
}

// helper-failing is deliberately excluded: a failed timer run stays flagged until
// its next run (up to a week for weekly timers), so a 15-minute cooldown would page
// repeatedly for one failure. It surfaces on the dashboard instead.
function isCriticalRuntimeStatus(status) {
  return ['service-down', 'http-failing', 'readiness-failing'].includes(String(status || ''));
}

class HealthAlertNotifier {
  constructor({ postJson = defaultPostJson, cooldownMs = 15 * 60 * 1000, now = () => Date.now() } = {}) {
    this.postJson = postJson;
    this.cooldownMs = cooldownMs;
    this.now = now;
    this.lastSentByKey = new Map();
  }

  async notifySnapshot(snapshot, config = {}) {
    if (!config.healthAlertsEnabled || !config.healthAlertsWebhookUrl) {
      return { enabled: false, sent: 0, skipped: 0 };
    }

    const publicBase = buildPublicBase(config);
    const alerts = (snapshot?.apps || []).filter((appHealth) => isCriticalRuntimeStatus(appHealth.runtimeStatus));
    let sent = 0;
    let skipped = 0;
    let failed = 0;
    const errors = [];

    for (const alert of alerts) {
      const key = `${alert.appId}:${alert.runtimeStatus}`;
      const lastSent = this.lastSentByKey.get(key) || 0;
      const nowMs = this.now();
      if (nowMs - lastSent < this.cooldownMs) {
        skipped += 1;
        continue;
      }

      try {
        await this.postJson(config.healthAlertsWebhookUrl, {
          source: 'homebase',
          event: 'app-health-critical',
          appId: alert.appId,
          runtimeStatus: alert.runtimeStatus,
          recoveryHint: alert.recoveryHint,
          checkedAt: alert.checkedAt,
          appDetailUrl: `${publicBase}/apps/${encodeURIComponent(alert.appId)}#health`,
        });
        this.lastSentByKey.set(key, nowMs);
        sent += 1;
      } catch (error) {
        failed += 1;
        errors.push({
          appId: alert.appId,
          runtimeStatus: alert.runtimeStatus,
          error: error.message || 'Notification send failed',
        });
      }
    }

    return { enabled: true, sent, skipped, failed, errors };
  }

  async sendTestAlert(config = {}) {
    if (!config.healthAlertsEnabled) {
      const error = new Error('Health alerts are disabled. Enable alerts before sending a test message.');
      error.code = 'ALERTS_DISABLED';
      throw error;
    }
    if (!config.healthAlertsWebhookUrl) {
      const error = new Error('healthAlertsWebhookUrl is required before sending a test alert.');
      error.code = 'ALERT_TARGET_MISSING';
      throw error;
    }

    const publicBase = buildPublicBase(config);
    await this.postJson(config.healthAlertsWebhookUrl, {
      source: 'homebase',
      event: 'app-health-test',
      message: 'Home Base test alert',
      sentAt: new Date(this.now()).toISOString(),
      dashboardUrl: `${publicBase}/`,
    });

    return { ok: true };
  }
}

module.exports = {
  HealthAlertNotifier,
  defaultPostJson,
  isCriticalRuntimeStatus,
};
