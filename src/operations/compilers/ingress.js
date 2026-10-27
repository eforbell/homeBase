const { operation, planEnvelope } = require('./common');
const { validateInstance } = require('../ingress-layout');

// Feature-10 SID-001. Cutover moves nginx from the TCP gateway to one root-only socket per service;
// rollback restores the TCP gateway. Order matters both ways (runbook section 0): rollback refuses while
// any app still trusts identity headers, because a TCP path lets any local process forge them.

// A plain coded error, like the other compilers: the web process loads this without the schema validator.
function refuse(message) { throw Object.assign(new Error(message), { code: 'POLICY_DENIED' }); }

// Installations whose app reads identity from X-Sovereign-* headers. Until SID-007 no app does, but the
// rollback rule is enforced from the start so it cannot be forgotten later.
function appsInTailnetMode(installations = {}) {
  return Object.entries(installations || {})
    .filter(([, installation]) => installation?.identityMode === 'tailnet')
    .map(([appId]) => appId)
    .sort();
}

// legacyService: the pre-SID-001 managed service (svc:home), which targets nginx's TCP :443 and so stops
// answering once the socket gateway replaces it. Retiring it is part of the cutover.
function buildIngressCutoverPlan({ instance, domain, legacyService = null, generatedAt, catalogRevision } = {}) {
  const problem = validateInstance(instance);
  if (problem) refuse(`Cannot plan the ingress cutover: ${problem}.`);
  const tailnetDomain = String(domain || '').toLowerCase();
  if (!/\.ts\.net$/.test(tailnetDomain)) refuse('Cannot plan the ingress cutover: the domain must be the tailnet domain (<tailnet>.ts.net).');
  const operations = [
    operation({ id: 'install-socket-gateway', type: 'nginx.ensure-socket-gateway', title: 'Install the per-service nginx socket gateway', instance, domain: tailnetDomain }),
    operation({ id: 'reload-nginx', type: 'nginx.validate-and-reload', title: 'Validate and reload nginx', dependsOn: ['install-socket-gateway'] }),
    ...(legacyService ? [operation({ id: 'retire-legacy-service', type: 'tailscale.retire-service', title: `Retire ${legacyService} from this host`, risk: 'destructive', dependsOn: ['reload-nginx'], service: legacyService })] : []),
  ];
  return planEnvelope({ kind: 'ingress-cutover', target: 'local-host', policyProfile: 'ingress-cutover-v1', operations, generatedAt, catalogRevision });
}

function buildIngressRollbackPlan({ installations, generatedAt, catalogRevision } = {}) {
  const trusting = appsInTailnetMode(installations);
  if (trusting.length) {
    refuse(`Cannot restore TCP ingress while ${trusting.join(', ')} ${trusting.length === 1 ? 'is' : 'are'} in tailnet mode: return ${trusting.length === 1 ? 'it' : 'them'} to local mode first.`);
  }
  const operations = [
    operation({ id: 'restore-tcp-gateway', type: 'nginx.restore-tcp-gateway', title: 'Restore the TCP nginx gateway', risk: 'destructive' }),
    operation({ id: 'reload-nginx', type: 'nginx.validate-and-reload', title: 'Validate and reload nginx', dependsOn: ['restore-tcp-gateway'] }),
    // Serve last: its restored services target nginx's TCP :443, which now listens again.
    operation({ id: 'restore-serve', type: 'tailscale.restore-serve-snapshot', title: 'Restore the Serve services from before the cutover', risk: 'destructive', dependsOn: ['reload-nginx'] }),
  ];
  return planEnvelope({ kind: 'ingress-rollback', target: 'local-host', policyProfile: 'ingress-rollback-v1', operations, generatedAt, catalogRevision });
}

// One service per plan: each is gated on its own D23 verification before the plan is built.
function buildServicePublishPlan({ serviceKey, generatedAt, catalogRevision } = {}) {
  const operations = [operation({ id: 'publish-service', type: 'tailscale.publish-service', title: `Publish the ${serviceKey} service on its nginx socket`, serviceKey })];
  return planEnvelope({ kind: 'service-publish', target: 'local-host', policyProfile: 'service-publish-v1', operations, generatedAt, catalogRevision });
}

module.exports = { appsInTailnetMode, buildIngressCutoverPlan, buildIngressRollbackPlan, buildServicePublishPlan };
