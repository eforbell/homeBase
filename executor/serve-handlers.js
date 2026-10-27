const fs = require('fs');
const { runApproved } = require('./spawn');
const { readIngressRecord, writeFileAtomic, lstatOrNull, readSmallFileNoFollow, deny, ROOT_ENV } = require('./handlers');
const { catalog } = require('../src/catalog');
const { ingressServices, serveTarget } = require('../src/operations/ingress-layout');

// Tailscale Services for socket ingress (Feature-10 SID-001). Only a cut-over host publishes, and only the
// services its own cutover record names (svc:<instance>-<key>), so a plan can never point Serve anywhere
// else. Serve is changed with `serve set-config --all`, which declaratively sets every service this host
// serves and leaves the node's own Serve entries alone. Never `set-raw`: on 1.102.4 it replaces the whole
// Serve config, dropping node entries and leaving services with null endpoints.

const TAILSCALE = '/usr/bin/tailscale';
const SERVE_STATE_DIR = '/var/lib/homebase-executor';
// The Serve config as it was before the first socket-ingress publish; rollback re-applies it.
const PRE_INGRESS_SNAPSHOT = `${SERVE_STATE_DIR}/serve-before-ingress.json`;
const SERVE_CONFIG_FILE = `${SERVE_STATE_DIR}/serve-config.json`;
const HTTPS_ENDPOINT = 'tcp:443';

function serviceEndpoints(key) {
  return { [HTTPS_ENDPOINT]: `https://${serveTarget(key)}` };
}

function sameEndpoints(left, right) {
  const a = left && typeof left === 'object' ? left : {};
  const b = right && typeof right === 'object' ? right : {};
  return Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([endpoint, target]) => b[endpoint] === target);
}

// A services config file: { version, services: { name: { endpoints, advertised? } } }.
function parseServicesConfig(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch (error) { deny(`tailscale serve get-config --all returned unreadable JSON: ${error.message}`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) deny('tailscale serve get-config --all returned something other than a config object.');
  const services = parsed.services == null ? {} : parsed.services;
  if (typeof services !== 'object' || Array.isArray(services)) deny('tailscale serve get-config --all has a malformed services map.');
  return { version: parsed.version || '0.0.1', services };
}

function createServeHandlers({ fsImpl = fs, run = runApproved } = {}) {
  const rootIdentity = { uid: 0, gid: 0 };
  const tailscale = (args, timeoutMs) => run({ binary: TAILSCALE, args, ...rootIdentity, timeoutMs, env: ROOT_ENV, outputLimit: 1024 * 1024 });
  const readConfig = async (timeoutMs) => parseServicesConfig(String((await tailscale(['serve', 'get-config', '--all'], timeoutMs)).stdout || ''));
  const applyConfig = async (config, timeoutMs) => {
    writeFileAtomic(fsImpl, SERVE_CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, 0o600);
    await tailscale(['serve', 'set-config', '--all', SERVE_CONFIG_FILE], timeoutMs);
  };
  const ingressOrDeny = () => readIngressRecord(fsImpl) || deny('This host is not cut over to socket ingress; run the ingress cutover first.');
  const servicesFor = (ingress) => ingressServices({ instance: ingress.instance, domain: ingress.domain, apps: catalog });

  return {
    'tailscale.publish-service': async (operation) => {
      const ingress = ingressOrDeny();
      const service = servicesFor(ingress).find((entry) => entry.key === operation.serviceKey);
      if (!service) deny(`${operation.serviceKey} is not a service this host can serve.`);
      // Serve refuses untagged service hosts anyway; refusing here says why (D2: tagged hosts only).
      let self;
      try { self = JSON.parse(String((await tailscale(['status', '--json', '--peers=false'], operation.timeoutMs)).stdout || '{}')).Self; } catch { self = null; }
      if (!self) deny('Could not read tailscale status for this host.');
      if (!Array.isArray(self.Tags) || !self.Tags.length) deny('This host is user-owned (untagged); service hosts must be tagged, or local processes would arrive as its owner.');

      const current = await readConfig(operation.timeoutMs);
      if (!lstatOrNull(fsImpl, PRE_INGRESS_SNAPSHOT)) writeFileAtomic(fsImpl, PRE_INGRESS_SNAPSHOT, `${JSON.stringify(current, null, 2)}\n`, 0o600);
      const desired = serviceEndpoints(service.key);
      const existing = current.services[service.name];
      if (existing && existing.endpoints && Object.keys(existing.endpoints).length && !sameEndpoints(existing.endpoints, desired)) {
        deny(`${service.name} already has other endpoints on this host (${JSON.stringify(existing.endpoints)}); clear them with "tailscale serve clear ${service.name}" if they are stale.`);
      }
      if (existing && sameEndpoints(existing.endpoints, desired) && existing.advertised !== false) return `${service.name} already targets ${serveTarget(service.key)}`;
      const merged = { ...current, services: { ...current.services, [service.name]: { endpoints: desired } } };
      await applyConfig(merged, operation.timeoutMs);
      const after = await readConfig(operation.timeoutMs);
      if (!sameEndpoints(after.services[service.name]?.endpoints, desired)) deny(`Serve did not keep ${service.name} → ${serveTarget(service.key)}; check "tailscale serve get-config --all".`);
      for (const [name, value] of Object.entries(current.services)) {
        if (name !== service.name && !sameEndpoints(after.services[name]?.endpoints, value?.endpoints)) deny(`Publishing ${service.name} changed ${name}; check "tailscale serve get-config --all".`);
      }
      return `published ${service.name} → ${serveTarget(service.key)}`;
    },
    'tailscale.retire-service': async (operation) => {
      // Removes a pre-SID-001 service from this host (for example svc:home → localhost:443), which has no
      // TCP listener behind it once the host is cut over. Socket services are not retired this way.
      const ingress = ingressOrDeny();
      if (servicesFor(ingress).some((entry) => entry.name === operation.service)) deny(`${operation.service} is a socket-ingress service; it is not retired this way.`);
      const current = await readConfig(operation.timeoutMs);
      if (!current.services[operation.service]) return `${operation.service} is not served by this host`;
      if (!lstatOrNull(fsImpl, PRE_INGRESS_SNAPSHOT)) writeFileAtomic(fsImpl, PRE_INGRESS_SNAPSHOT, `${JSON.stringify(current, null, 2)}\n`, 0o600);
      const services = { ...current.services };
      delete services[operation.service];
      await applyConfig({ ...current, services }, operation.timeoutMs);
      const after = await readConfig(operation.timeoutMs);
      if (after.services[operation.service]) deny(`Serve still has ${operation.service}; check "tailscale serve get-config --all".`);
      return `retired ${operation.service} from this host`;
    },
    'tailscale.restore-serve-snapshot': async (operation) => {
      // Rollback: the services exactly as they were before the first socket-ingress change.
      const stat = lstatOrNull(fsImpl, PRE_INGRESS_SNAPSHOT);
      if (!stat) return 'no pre-ingress Serve snapshot; Serve was not changed by the cutover';
      if (!stat.isFile()) deny(`${PRE_INGRESS_SNAPSHOT} is not a regular file.`);
      const snapshot = parseServicesConfig(readSmallFileNoFollow(fsImpl, PRE_INGRESS_SNAPSHOT, 1024 * 1024) || '');
      await applyConfig(snapshot, operation.timeoutMs);
      fsImpl.unlinkSync(PRE_INGRESS_SNAPSHOT);
      return `restored the Serve services from before the cutover (${Object.keys(snapshot.services).join(', ') || 'none'})`;
    },
  };
}

module.exports = { PRE_INGRESS_SNAPSHOT, SERVE_CONFIG_FILE, createServeHandlers, parseServicesConfig, serviceEndpoints };
