// Feature-10 D23: does each service have exactly one approved host, and is it this device?
//
// The local host cannot see standby hosts (spike 3b: an approved standby showed no routes until failover),
// and a correct policy does not prove there is no stale approval (spike 3b: the old approval survived the
// policy change). So the deciding evidence is the service's host inventory from the Tailscale API
// (listServiceHosts), which lists every host and its approval level, standbys included. Policy and tag
// checks are reported as warnings. Without an API credential the administrator confirms the inventory
// from the console instead, and the service shows as "confirmed by administrator", never "verified".
// Everything here is pure: callers fetch, this decides, and anything it cannot account for fails closed.

const APPROVAL_LEVELS = new Set(['not-approved', 'approved:auto', 'approved:manual']);
const APPROVED = new Set(['approved:auto', 'approved:manual']);
const CONFIRMATION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const STABLE_NODE_ID = /^[A-Za-z0-9]{4,64}$/;

// The live API (checked 2026-10-27) names each host's stable device ID `nodeId`, the same value as the
// device list's nodeId and `tailscale status` Self.ID; the published schema calls it `stableNodeID`.
// Either is accepted; both present and different is unreadable.
function hostNodeId(host) {
  const ids = [host.nodeId, host.stableNodeID].filter((value) => value != null);
  if (!ids.length || ids.some((value) => value !== ids[0]) || !STABLE_NODE_ID.test(String(ids[0]))) return null;
  return String(ids[0]);
}

function unverified(service, reason, detail, extra = {}) {
  return { service, state: 'unverified', reason, detail, approvedHosts: [], ...extra };
}

// apiResult: { ok, status, body } from GET /tailnet/{tailnet}/services/{service}/devices, or
// { ok: false, error } when the request never got an answer.
function evaluateServiceHosts({ service, selfNodeId, apiResult }) {
  if (!STABLE_NODE_ID.test(String(selfNodeId || ''))) {
    return unverified(service, 'self-unknown', "this device's stable node ID is unknown (tailscale status --json Self.ID)");
  }
  if (!apiResult || apiResult.ok !== true) {
    const status = apiResult?.status ?? null;
    if (status === 401 || status === 403) {
      return unverified(service, 'credential-refused', `the Tailscale API refused the credential (HTTP ${status}); if its scopes are read-only, use administrator confirmation instead of a broader credential`, { status });
    }
    if (status === 404) return unverified(service, 'service-unknown', `the Tailscale API does not know ${service}; define it in the admin console first`, { status });
    return unverified(service, 'api-error', `the Tailscale API could not be evaluated (${status ? `HTTP ${status}` : apiResult?.error || 'no answer'})`, { status });
  }
  // A service with no hosts answers {} (checked on the live API, 2026-10-27): the empty list is omitted.
  // Only exactly that counts as empty; any other body without a hosts list is unreadable.
  const body = apiResult.body;
  const empty = body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0;
  const hosts = empty ? [] : body?.hosts;
  if (!Array.isArray(hosts)) return unverified(service, 'inventory-unparseable', 'the host inventory has no hosts list');
  const seen = new Set();
  const entries = [];
  for (const host of hosts) {
    // An entry this code cannot read could be an approved host it cannot see, so the whole inventory fails.
    const id = host && typeof host === 'object' ? hostNodeId(host) : null;
    if (!id || !APPROVAL_LEVELS.has(host.approvalLevel)) {
      return unverified(service, 'inventory-unparseable', `the host inventory has an entry this version cannot read: ${JSON.stringify(host).slice(0, 200)}`);
    }
    if (seen.has(id)) return unverified(service, 'inventory-unparseable', `the host inventory lists ${id} twice`);
    seen.add(id);
    entries.push({ nodeId: id, approvalLevel: host.approvalLevel });
  }
  const approvedHosts = entries.filter((host) => APPROVED.has(host.approvalLevel));
  const self = entries.find((host) => host.nodeId === selfNodeId);
  const others = approvedHosts.filter((host) => host.nodeId !== selfNodeId);
  if (others.length) {
    return unverified(service, 'other-host-approved', `${others.map((host) => `${host.nodeId} (${host.approvalLevel})`).join(', ')} ${others.length === 1 ? 'is' : 'are'} also approved for ${service}; remove ${others.length === 1 ? 'its' : 'their'} approval in the admin console`, { approvedHosts });
  }
  if (!self) return unverified(service, 'self-missing', `this device (${selfNodeId}) is not in ${service}'s host inventory; advertise the service from this host`, { approvedHosts });
  if (!APPROVED.has(self.approvalLevel)) return unverified(service, 'self-not-approved', `this device is not approved for ${service}; approve it in the admin console`, { approvedHosts });
  return { service, state: 'verified', reason: null, detail: `this device is the only approved host of ${service}`, approvedHosts };
}

// Confirmation branch: the administrator checked the console's Services page and confirmed this host is
// the only approved one. Valid for 30 days and only for the host it named; it covers one publish
// (publishedAt is set once a publish uses it), so every publish is confirmed afresh (D23).
function evaluateConfirmation({ service, selfNodeId, confirmation, now = Date.now() }) {
  if (!confirmation) return { service, state: 'unconfirmed', reason: 'not-confirmed', detail: `confirm ${service}'s hosts in the admin console, then in Home Base` };
  if (confirmation.service !== service || confirmation.hostNodeId !== selfNodeId) {
    return { service, state: 'unconfirmed', reason: 'confirmation-mismatch', detail: `the confirmation on record names ${confirmation.service} on ${confirmation.hostNodeId}, not this service on this device` };
  }
  const at = Date.parse(confirmation.confirmedAt);
  if (!Number.isFinite(at) || at > now) return { service, state: 'unconfirmed', reason: 'confirmation-invalid', detail: 'the confirmation on record has no valid time' };
  if (now - at > CONFIRMATION_MAX_AGE_MS) return { service, state: 'unconfirmed', reason: 'confirmation-expired', detail: `the confirmation from ${confirmation.confirmedAt} is older than 30 days; confirm again` };
  // Before SID-005 there is no hardware key, so confirmations are made in a passphrase session.
  const assurance = confirmation.assurance === 'hardware-key' ? 'hardware-key' : 'passphrase-session';
  const publishedAt = typeof confirmation.publishedAt === 'string' ? confirmation.publishedAt : null;
  return { service, state: 'confirmed', reason: null, assurance, publishedAt, detail: `confirmed by administrator ${confirmation.confirmedBy || ''} at ${confirmation.confirmedAt}`.replace('  ', ' ') };
}

// Policy and tag checks (D14), reported as warnings: they show what to fix before the next approval goes
// wrong, but never decide verification. policy is the tailnet policy as JSON; devices is the device list
// ({ nodeId, tags }); administratorLogin is the one login allowed to own the host tag.
function policyWarnings({ service, serviceTags = [], hostTag, selfNodeId, policy, devices, administratorLogin }) {
  const warnings = [];
  if (!hostTag) {
    warnings.push({ id: 'host-tag-unknown', detail: 'no host tag is configured; give this host its own tag (tag:<instance>-host)' });
    return warnings;
  }
  if (policy && typeof policy === 'object') {
    const owners = policy.tagOwners?.[hostTag];
    if (!Array.isArray(owners)) warnings.push({ id: 'host-tag-undefined', detail: `${hostTag} has no tagOwners entry` });
    // Until the directory records the administrator (SID-004), only "exactly one owner" can be checked.
    else if (owners.length !== 1 || (administratorLogin && owners[0] !== administratorLogin)) {
      warnings.push({ id: 'host-tag-owners', detail: `${hostTag} is owned by ${owners.join(', ') || 'nobody'}; it should be owned by the administrator alone` });
    }
    const rules = policy.autoApprovers?.services && typeof policy.autoApprovers.services === 'object' ? policy.autoApprovers.services : {};
    const matching = Object.entries(rules).filter(([key]) => key === service || serviceTags.includes(key));
    for (const [key, approvers] of matching) {
      const list = Array.isArray(approvers) ? approvers : [];
      const extra = list.filter((approver) => approver !== hostTag);
      if (extra.length) warnings.push({ id: 'shared-approver', detail: `autoApprovers.services["${key}"] also approves ${extra.join(', ')}; every approver for ${service} should be ${hostTag} alone` });
    }
    if (matching.length > 1) warnings.push({ id: 'extra-approver-rule', detail: `${matching.length} autoApprovers rules match ${service} (${matching.map(([key]) => key).join(', ')}); keep one` });
  } else {
    warnings.push({ id: 'policy-unreadable', detail: 'the tailnet policy could not be read, so approver rules were not checked' });
  }
  if (Array.isArray(devices)) {
    const holders = devices.filter((device) => Array.isArray(device?.tags) && device.tags.includes(hostTag) && device.nodeId !== selfNodeId);
    if (holders.length) warnings.push({ id: 'host-tag-shared', detail: `${holders.map((device) => device.name || device.nodeId).join(', ')} also ${holders.length === 1 ? 'holds' : 'hold'} ${hostTag}; only this host may` });
    if (!devices.some((device) => device?.nodeId === selfNodeId && Array.isArray(device.tags) && device.tags.includes(hostTag))) {
      warnings.push({ id: 'host-tag-missing', detail: `this device does not hold ${hostTag}` });
    }
  } else {
    warnings.push({ id: 'devices-unreadable', detail: 'the device list could not be read, so tag holders were not checked' });
  }
  return warnings;
}

// This host is not yet a host of the service (it appears in the inventory only once it advertises), but no
// other host is approved: publishing is what makes it the one.
const PUBLISHABLE_REASONS = new Set(['self-missing', 'self-not-approved']);

// May this service be published in socket mode, or enter tailnet mode?
//   none     no household directory yet (before SID-004): no app can trust identity and no hardware key
//            exists. Publishing needs the host evaluation; nothing enters tailnet mode.
//   setup    (D16/D23 bootstrap) only the Home Base service may be published, so the enrollment surface
//   recovery exists; nothing enters tailnet mode.
//   active   publishing and tailnet mode need this host verified, or confirmed by the administrator with
//            a hardware key.
// A confirmation already used by a publish never covers another one.
function serviceGate({ lifecycleState, serviceKey, action, evaluation }) {
  if (!['publish', 'tailnet-mode'].includes(action)) return { allowed: false, reason: `unknown action ${action}` };
  if (!['none', 'setup', 'recovery', 'active'].includes(lifecycleState)) return { allowed: false, reason: `unknown Home Base state ${lifecycleState}` };
  const ok = evaluation?.state === 'verified' || evaluation?.state === 'confirmed';
  if (action === 'tailnet-mode') {
    if (lifecycleState === 'none') return { allowed: false, reason: 'there is no household directory yet, so no app can use tailnet identity' };
    if (lifecycleState !== 'active') return { allowed: false, reason: `Home Base is in ${lifecycleState}; apps enter tailnet mode only once it is active` };
    if (evaluation?.state === 'confirmed' && evaluation.assurance !== 'hardware-key') return { allowed: false, reason: 'the confirmation on record was not made with a hardware key; confirm again' };
    return ok ? { allowed: true, reason: evaluation.detail } : { allowed: false, reason: evaluation?.detail || 'service hosts are not verified' };
  }
  if ((lifecycleState === 'setup' || lifecycleState === 'recovery') && serviceKey !== 'homebase') {
    return { allowed: false, reason: `Home Base is in ${lifecycleState}; only the Home Base service can be published until it is active` };
  }
  if (evaluation?.state === 'confirmed') {
    if (evaluation.publishedAt) return { allowed: false, reason: `the confirmation on record was used by the publish at ${evaluation.publishedAt}; check the console again and confirm before publishing` };
    if (lifecycleState === 'active' && evaluation.assurance !== 'hardware-key') return { allowed: false, reason: 'once Home Base is active, a publish needs a confirmation made with a hardware key; confirm again' };
  }
  if (ok || (evaluation?.state === 'unverified' && PUBLISHABLE_REASONS.has(evaluation.reason))) {
    return { allowed: true, reason: ok ? evaluation.detail : 'no other host is approved for this service' };
  }
  return { allowed: false, reason: evaluation?.detail || 'service hosts are not verified' };
}

module.exports = {
  CONFIRMATION_MAX_AGE_MS,
  evaluateConfirmation,
  evaluateServiceHosts,
  policyWarnings,
  serviceGate,
};
