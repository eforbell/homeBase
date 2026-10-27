const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { runJson } = require('../identity/identity-endpoint');
const { ingressServices, serveTarget, validateInstance } = require('../operations/ingress-layout');
const { catalog } = require('../catalog');
const { evaluateServiceHosts, evaluateConfirmation, policyWarnings, serviceGate } = require('./service-host-verification');

// Feature-10 SID-001 from Home Base's side: what each socket-ingress service looks like on this host, whether
// it may be published or trusted (D23), and the administrator's confirmations when there is no API
// credential. Home Base reads Tailscale as its own (unprivileged) user; every change goes through the executor.

const CONFIRMATIONS_FILE = 'ingress-confirmations.json';
const WARM_TIMEOUT_MS = 90_000;

const tailscaleCli = (args) => runJson('tailscale', args, 8_000);

function readConfirmations(dataDir, fsImpl = fs) {
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(path.join(dataDir, CONFIRMATIONS_FILE), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    // An unreadable file is no confirmation at all, never a stale one.
    return {};
  }
}

function writeConfirmation(dataDir, record, fsImpl = fs) {
  const all = { ...readConfirmations(dataDir, fsImpl), [record.service]: record };
  const target = path.join(dataDir, CONFIRMATIONS_FILE);
  const temp = `${target}.tmp-${crypto.randomBytes(6).toString('hex')}`;
  fsImpl.writeFileSync(temp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  fsImpl.renameSync(temp, target);
  return record;
}

function expectedEndpoints(key) {
  return { 'tcp:443': `https://${serveTarget(key)}` };
}

function endpointsMatch(actual, key) {
  const expected = expectedEndpoints(key);
  return Boolean(actual) && Object.keys(actual).length === 1 && actual['tcp:443'] === expected['tcp:443'];
}

// The host's socket ingress as Home Base knows it: cut over when the latest completed ingress job is a
// cutover rather than a rollback, and an instance is configured. Null otherwise.
function currentIngress(jobs = [], config = {}) {
  if (!config.instance) return null;
  const latest = (jobs || [])
    .filter((job) => ['ingress-cutover', 'ingress-rollback'].includes(job.kind) && job.status === 'completed' && !job.dryRun)
    .sort((a, b) => String(a.finishedAt || '').localeCompare(String(b.finishedAt || '')) || a.id - b.id)
    .at(-1);
  return latest?.kind === 'ingress-cutover' ? { instance: config.instance, domain: String(config.defaultDomain || '').toLowerCase() } : null;
}

// What the administrator sets up in the Tailscale console (runbook section 2), for the services this
// household needs: home, homebase, and each installed sensitive app. Text to paste, never applied here.
function setupSheet({ instance, services, installedAppIds = [], administratorLogin = '' }) {
  const needed = services.filter((service) => service.key === 'home' || service.key === 'homebase' || service.apps.some((id) => installedAppIds.includes(id)));
  const hostTag = `tag:${instance}-host`;
  const owner = administratorLogin || '<administrator login>';
  const names = needed.map((service) => service.name);
  const pad = Math.max(...names.map((name) => name.length)) + 3;
  const policy = [
    '// Home Base: paste into your tailnet policy (runbook section 2.2), in this order:',
    '// 1. the tag owner, then add the tag to this host on the Machines page;',
    '"tagOwners": {',
    `  "${hostTag}": ["${owner}"],`,
    '},',
    '// 2. approvers: this host\'s tag only, never a tag several hosts share;',
    '"autoApprovers": {',
    '  "services": {',
    ...names.map((name) => `    ${`"${name}":`.padEnd(pad)} ["${hostTag}"],`),
    '  },',
    '},',
    '// 3. in "grants": who may reach which address (members using passkey apps also need the homebase one).',
    `{ "src": ["group:family"], "dst": [${names.map((name) => `"${name}"`).join(', ')}], "ip": ["tcp:443"] },`,
  ].join('\n');
  return {
    hostTag,
    services: needed.map((service) => ({ name: service.name, hostname: service.hostname, port: 'tcp:443', apps: service.apps })),
    policy,
  };
}

// Lifecycle until SID-004 adds the household directory: 'none'. apiProblem: a credential is configured but
// could not be loaded; automatic verification can't run, and it never falls back to confirmations.
function createIngressControl({ config, api = null, apiProblem = null, cli = tailscaleCli, fsImpl = fs, now = Date.now, lifecycleState = () => 'none' }) {
  const instance = config.instance || '';
  const domain = String(config.defaultDomain || '').toLowerCase();
  const hostTag = instance ? `tag:${instance}-host` : null;

  function configured() {
    const problem = validateInstance(instance) || (/\.ts\.net$/.test(domain) ? null : 'the domain must be the tailnet domain (<tailnet>.ts.net)');
    return problem ? { ok: false, problem: instance ? problem : 'HOME_BASE_INSTANCE is not set' } : { ok: true };
  }

  async function status() {
    const setup = configured();
    if (!setup.ok) return { configured: false, problem: setup.problem, services: [] };
    const state = lifecycleState();
    let self = null;
    let serve = null;
    const errors = [];
    try { self = (await cli(['status', '--json', '--peers=false'])).Self || null; } catch (error) { errors.push(`tailscale status: ${error.message}`); }
    try { serve = await cli(['serve', 'get-config', '--all']); } catch (error) { errors.push(`tailscale serve get-config: ${error.message}`); }
    const selfNodeId = self?.ID || null;
    const tagged = Array.isArray(self?.Tags) && self.Tags.length > 0;
    const [policy, devices] = api ? await Promise.all([api.getPolicy(), api.listDevices()]) : [null, null];
    const automatic = Boolean(api || apiProblem);
    const confirmations = automatic ? {} : readConfirmations(config.dataDir, fsImpl);
    const services = [];
    for (const service of ingressServices({ instance, domain, apps: catalog })) {
      const evaluation = apiProblem
        ? { service: service.name, state: 'unverified', reason: 'credential-unusable', detail: `the Tailscale API credential is configured but unusable (${apiProblem}); fix it, or remove it to confirm hosts by hand`, approvedHosts: [] }
        : api ? evaluateServiceHosts({ service: service.name, selfNodeId, apiResult: await api.listServiceHosts(service.name) })
        : evaluateConfirmation({ service: service.name, selfNodeId, confirmation: confirmations[service.name], now: now() });
      // Approver rules can name the service or one of its tags; a service whose tags can't be read can't be
      // checked against the tag rules, so that is a warning of its own.
      const info = api ? await api.getService(service.name) : null;
      const serviceTags = info?.ok && Array.isArray(info.body?.tags) ? info.body.tags : [];
      const warnings = api
        ? [
          ...policyWarnings({ service: service.name, serviceTags, hostTag, selfNodeId, policy: policy?.ok ? policy.body : null, devices: devices?.ok ? devices.body?.devices : null, administratorLogin: config.administratorLogin || null }),
          ...(info?.ok || info?.status === 404 ? [] : [{ id: 'service-unreadable', detail: `${service.name}'s definition could not be read, so approver rules for its tags were not checked` }]),
        ]
        : [{ id: 'policy-not-checked', detail: apiProblem ? 'the Tailscale API credential is unusable, so the policy and tags were not checked' : 'no Tailscale API credential, so the policy and tags were not checked' }];
      const publish = tagged
        ? serviceGate({ lifecycleState: state, serviceKey: service.key, action: 'publish', evaluation })
        : { allowed: false, reason: 'this host is user-owned (untagged); service hosts must be tagged (D2)' };
      services.push({
        key: service.key,
        name: service.name,
        hostname: service.hostname,
        apps: service.appIds,
        published: endpointsMatch(serve?.services?.[service.name]?.endpoints, service.key),
        verification: { mode: automatic ? 'automatic' : 'confirmation', ...evaluation },
        warnings,
        gates: { publish, tailnetMode: serviceGate({ lifecycleState: state, serviceKey: service.key, action: 'tailnet-mode', evaluation }) },
      });
    }
    return {
      configured: true,
      instance,
      domain,
      lifecycleState: state,
      self: self ? { nodeId: selfNodeId, tagged, hostTag, holdsHostTag: tagged && self.Tags.includes(hostTag) } : null,
      legacyService: config.tailscaleManagedServiceId || null,
      legacyServicePresent: Boolean(config.tailscaleManagedServiceId && serve?.services?.[config.tailscaleManagedServiceId]),
      errors,
      services,
    };
  }

  async function service(key) {
    const all = await status();
    return { all, entry: all.services.find((entry) => entry.key === key) || null };
  }

  // The administrator checked the console's Services page: no host other than this one is approved for
  // the service. Recorded per service and host; valid 30 days (evaluateConfirmation).
  async function confirm(key, { hostNodeId, confirmedBy, assurance = 'passphrase-session' }) {
    const { all, entry } = await service(key);
    if (!entry) throw Object.assign(new Error(`${key} is not a service this host can serve`), { code: 'NOT_FOUND' });
    if (!all.self?.nodeId || hostNodeId !== all.self.nodeId) throw Object.assign(new Error('the confirmation must name this host, as the console shows it'), { code: 'CONFIRMATION_MISMATCH' });
    return writeConfirmation(config.dataDir, { service: entry.name, hostNodeId, confirmedAt: new Date(now()).toISOString(), confirmedBy: confirmedBy || null, assurance }, fsImpl);
  }

  // Claims the confirmation a publish was authorized with, so the next publish needs a new one. Synchronous
  // on purpose: the caller claims and starts the job with no await between, so two overlapping publishes
  // can't both claim it. Throws (and nothing starts) if it is gone, already used, replaced, or can't be saved.
  function claimConfirmation(key, confirmedAt) {
    const name = ingressServices({ instance, domain, apps: catalog }).find((entry) => entry.key === key)?.name;
    const record = name ? readConfirmations(config.dataDir, fsImpl)[name] : null;
    if (!record || record.publishedAt || record.confirmedAt !== confirmedAt) {
      throw Object.assign(new Error(`the confirmation for ${name || key} was used or replaced meanwhile; check the console again and confirm`), { code: 'CONFIRMATION_USED' });
    }
    writeConfirmation(config.dataDir, { ...record, publishedAt: new Date(now()).toISOString() }, fsImpl);
  }

  // The first request to a new service hostname waits for its certificate (spike 3: 35-40 s). The host
  // cannot resolve its own service names, so the request goes to the service address directly.
  async function warmUp(key, { request = https.request } = {}) {
    if (!api) return { ok: false, skipped: true, detail: 'no Tailscale API credential, so the service address is unknown; the first visit may take up to a minute' };
    const { entry } = await service(key);
    const info = entry ? await api.getService(entry.name) : null;
    const address = info?.ok ? (info.body?.addrs || []).find((value) => /^\d+\.\d+\.\d+\.\d+$/.test(value)) : null;
    if (!address) return { ok: false, detail: `could not read ${entry?.name || key}'s address from the Tailscale API` };
    const started = now();
    return new Promise((resolve) => {
      const req = request({
        host: entry.hostname, servername: entry.hostname, path: '/', method: 'HEAD', timeout: WARM_TIMEOUT_MS,
        lookup: (_hostname, options, callback) => (options?.all ? callback(null, [{ address, family: 4 }]) : callback(null, address, 4)),
      }, (res) => {
        res.resume();
        resolve({ ok: true, status: res.statusCode, ms: now() - started, detail: `${entry.hostname} answered (HTTP ${res.statusCode})` });
      });
      req.on('timeout', () => req.destroy(new Error(`no answer within ${WARM_TIMEOUT_MS / 1000} s`)));
      req.on('error', (error) => resolve({ ok: false, ms: now() - started, detail: `${entry.hostname}: ${error.message}` }));
      req.end();
    });
  }

  return { configured, status, service, confirm, claimConfirmation, warmUp };
}

module.exports = { CONFIRMATIONS_FILE, createIngressControl, currentIngress, readConfirmations, setupSheet };
