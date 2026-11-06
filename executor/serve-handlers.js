const fs = require('fs');
const { runApproved } = require('./spawn');
const { readIngressRecord, writeFileAtomic, lstatOrNull, readSmallFileNoFollow, deny, ROOT_ENV } = require('./handlers');
const { catalog } = require('../src/catalog');
const { SERVE_SOCKET_DIR, ingressServices, serveTarget } = require('../src/operations/ingress-layout');

// Tailscale Services for socket ingress (Feature-10 SID-001). Only a cut-over host publishes, and only the
// services its own cutover record names (svc:<instance>-<key>), so a plan can never point Serve anywhere
// else.
//
// Every change names one service. Never write the whole Serve config (`set-config --all`, `set-raw`): the
// export is lossy. An HTTPS frontend with an HTTP upstream exports as "http://…", which set-config reads as
// a plain-HTTP frontend, so replaying it fails ("want to serve http, but port 443 is already serving https")
// or, once the service is gone, silently downgrades it. Never depend on `get-config --all` either: one
// service with only a path handler makes it exit 1. `serve status --json` shows the real frontends and
// always answers. Measured on 1.104.4 (bugBase #156).

const TAILSCALE = '/usr/bin/tailscale';
const SERVE_STATE_DIR = '/var/lib/homebase-executor';
// What a rollback puts back: only the services Home Base retired, with the frontends the export can't show.
// Hosts cut over by an older Home Base hold the whole pre-cutover export here, with no frontends.
const PRE_INGRESS_SNAPSHOT = `${SERVE_STATE_DIR}/serve-before-ingress.json`;
const HTTPS_ENDPOINT = 'tcp:443';
const HTTPS_PORT = '443';
const SOCKET_TARGET = new RegExp(`^unix:${SERVE_SOCKET_DIR}/[a-z0-9][a-z0-9-]*\\.sock$`);
const SERVICE_NAME = /^svc:[a-z0-9][a-z0-9-]{0,62}$/;

function serviceEndpoints(key) {
  return { [HTTPS_ENDPOINT]: `https://${serveTarget(key)}` };
}

function sameEndpoints(left, right) {
  const a = left && typeof left === 'object' ? left : {};
  const b = right && typeof right === 'object' ? right : {};
  return Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([endpoint, target]) => b[endpoint] === target);
}

function parseObject(text, source) {
  let parsed;
  try { parsed = JSON.parse(text); } catch (error) { deny(`${source} is unreadable JSON: ${error.message}`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) deny(`${source} is not a config object.`);
  return parsed;
}

function parseSnapshot(text) {
  const parsed = parseObject(text, PRE_INGRESS_SNAPSHOT);
  const services = parsed.services == null ? {} : parsed.services;
  if (typeof services !== 'object' || Array.isArray(services)) deny(`${PRE_INGRESS_SNAPSHOT} has a malformed services map.`);
  const frontends = parsed.frontends && typeof parsed.frontends === 'object' ? parsed.frontends : {};
  return { version: parsed.version || '0.0.1', services, frontends };
}

// The `tailscale serve` arguments that recreate one endpoint. The export names the upstream; the frontend
// comes from `serve status`. A snapshot from an older Home Base has no frontends, and then an HTTP upstream is
// restored behind HTTPS: the wrong guess the other way would expose a service over plain HTTP.
function restoreArgs(name, endpoint, target, frontend) {
  const port = /^tcp:(\d{1,5})$/.exec(endpoint)?.[1];
  if (!port || typeof target !== 'string') deny(`${name} has an endpoint Home Base can't restore (${endpoint}).`);
  const scoped = ['serve', '--bg', '--yes', `--service=${name}`];
  if (target.startsWith('tcp://')) return [...scoped, `--tcp=${port}`, target];
  if (target.startsWith('tls-terminated-tcp://')) return [...scoped, `--tls-terminated-tcp=${port}`, target.replace(/^tls-terminated-tcp:/, 'tcp:')];
  if (!/^(https\+insecure|https|http):\/\//.test(target)) deny(`${name} has an endpoint Home Base can't restore (${endpoint} → ${target}).`);
  const flag = frontend?.HTTP ? 'http' : 'https';
  return [...scoped, `--${flag}=${port}`, target.replace(/^https?:\/\/unix:/, 'unix:')];
}

const hasPathHandlers = (entry) => Object.values(entry?.Web || {}).some((site) => Object.keys(site?.Handlers || {}).some((path) => path !== '/'));
const handlersOf = (entry) => Object.values(entry?.Web || {}).flatMap((site) => Object.entries(site?.Handlers || {}));
const usesSocket = (entry) => handlersOf(entry).some(([, handler]) => SOCKET_TARGET.test(String(handler?.Proxy || '')));
// Exactly what a publish creates. Anything more belongs at least partly to someone else, so a rollback must
// not clear it: `serve clear` removes the whole service.
function isSocketService(entry) {
  const ports = Object.keys(entry?.TCP || {});
  const handlers = handlersOf(entry);
  return ports.length === 1 && ports[0] === HTTPS_PORT && entry.TCP[HTTPS_PORT]?.HTTPS === true
    && handlers.length === 1 && handlers[0][0] === '/' && SOCKET_TARGET.test(String(handlers[0][1]?.Proxy || ''));
}
const exportsSocket = (target) => SOCKET_TARGET.test(String(target).replace(/^https?:\/\//, ''));

// What `serve status` shows differently, leaving out the services this operation changed on purpose.
function otherChanges(before, after, except) {
  const differs = (left, right) => JSON.stringify(left ?? null) !== JSON.stringify(right ?? null);
  const names = new Set([...Object.keys(before.Services || {}), ...Object.keys(after.Services || {})]);
  const changed = [...names].filter((name) => !except.includes(name) && differs(before.Services?.[name], after.Services?.[name])).sort();
  if (differs(before.TCP, after.TCP) || differs(before.Web, after.Web)) changed.push('node-level entries');
  return changed;
}

function createServeHandlers({ fsImpl = fs, run = runApproved } = {}) {
  const rootIdentity = { uid: 0, gid: 0 };
  const tailscale = (args, timeoutMs) => run({ binary: TAILSCALE, args, ...rootIdentity, timeoutMs, env: ROOT_ENV, outputLimit: 1024 * 1024 });
  const readStatus = async (timeoutMs) => parseObject(String((await tailscale(['serve', 'status', '--json'], timeoutMs)).stdout || '{}'), 'tailscale serve status --json');
  // One service's export; {} when this host doesn't serve it.
  const readService = async (name, timeoutMs) => parseObject(String((await tailscale(['serve', 'get-config', `--service=${name}`], timeoutMs)).stdout || '{}'), `tailscale serve get-config --service=${name}`);
  const readSnapshot = () => {
    const stat = lstatOrNull(fsImpl, PRE_INGRESS_SNAPSHOT);
    if (!stat) return null;
    if (!stat.isFile()) deny(`${PRE_INGRESS_SNAPSHOT} is not a regular file.`);
    return parseSnapshot(readSmallFileNoFollow(fsImpl, PRE_INGRESS_SNAPSHOT, 1024 * 1024) || '');
  };
  const writeSnapshot = (snapshot) => writeFileAtomic(fsImpl, PRE_INGRESS_SNAPSHOT, `${JSON.stringify(snapshot, null, 2)}\n`, 0o600);
  // Runs after the change, so it can't undo anything; it may also be an administrator's change made at the
  // same moment. Every operation here is safe to run again, which is how the job is finished once that's clear.
  const assertOthersUnchanged = (before, after, changed, action) => {
    const others = otherChanges(before, after, changed);
    if (others.length) deny(`${action} was applied, but ${others.join(', ')} also changed; check "tailscale serve status --json". If that was expected, run this again to finish.`);
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

      const desired = serviceEndpoints(service.key);
      const existing = await readService(service.name, operation.timeoutMs);
      if (existing.endpoints && Object.keys(existing.endpoints).length && !sameEndpoints(existing.endpoints, desired)) {
        deny(`${service.name} already has other endpoints on this host (${JSON.stringify(existing.endpoints)}); clear them with "tailscale serve clear ${service.name}" if they are stale.`);
      }
      if (sameEndpoints(existing.endpoints, desired) && existing.advertised !== false) return `${service.name} already targets ${serveTarget(service.key)}`;
      const before = await readStatus(operation.timeoutMs);
      await tailscale(['serve', '--bg', '--yes', `--service=${service.name}`, `--https=${HTTPS_PORT}`, serveTarget(service.key)], operation.timeoutMs);
      const after = await readService(service.name, operation.timeoutMs);
      if (!sameEndpoints(after.endpoints, desired)) deny(`Serve did not keep ${service.name} → ${serveTarget(service.key)}; check "tailscale serve status --json".`);
      assertOthersUnchanged(before, await readStatus(operation.timeoutMs), [service.name], `Publishing ${service.name}`);
      return `published ${service.name} → ${serveTarget(service.key)}`;
    },
    'tailscale.retire-service': async (operation) => {
      // Removes a pre-SID-001 service from this host (for example svc:home → localhost:443), which has no
      // TCP listener behind it once the host is cut over. Socket services are not retired this way.
      const ingress = ingressOrDeny();
      const name = operation.service;
      if (servicesFor(ingress).some((entry) => entry.name === name)) deny(`${name} is a socket-ingress service; it is not retired this way.`);
      if (!SERVICE_NAME.test(String(name))) deny(`${name} is not a Tailscale service name.`);
      const before = await readStatus(operation.timeoutMs);
      const live = before.Services?.[name];
      if (!live) return `${name} is not served by this host`;
      // A rollback has to be able to put it back, so everything that can't be restored stops here, unchanged.
      if (hasPathHandlers(live)) deny(`${name} has path handlers, which a rollback could not restore; remove it by hand ("tailscale serve clear ${name}", after noting its config), then run the cutover again.`);
      const config = await readService(name, operation.timeoutMs);
      const endpoints = config.endpoints && typeof config.endpoints === 'object' ? config.endpoints : {};
      const frontends = live.TCP || {};
      for (const [endpoint, target] of Object.entries(endpoints)) restoreArgs(name, endpoint, target, frontends[endpoint.slice(4)]);
      // Saved before the removal: an interruption between the two still leaves a complete record.
      const snapshot = readSnapshot() || { version: '0.0.1', services: {}, frontends: {} };
      snapshot.services[name] = { endpoints, ...(config.advertised === false ? { advertised: false } : {}) };
      snapshot.frontends[name] = frontends;
      writeSnapshot(snapshot);
      await tailscale(['serve', 'clear', name], operation.timeoutMs);
      const after = await readStatus(operation.timeoutMs);
      if (after.Services?.[name]) deny(`Serve still has ${name}; check "tailscale serve status --json".`);
      assertOthersUnchanged(before, after, [name], `Retiring ${name}`);
      return `retired ${name} from this host`;
    },
    'tailscale.restore-serve-snapshot': async (operation) => {
      // Rollback: takes the socket services down and puts back what the cutover retired. Other services were
      // never changed, so they aren't touched, including when an older snapshot lists them. Safe to run
      // again: the snapshot is removed last, and each step skips what is already done.
      const snapshot = readSnapshot();
      const before = await readStatus(operation.timeoutMs);
      const touched = [];
      const restored = [];
      const assumedHttps = [];
      for (const [name, saved] of Object.entries(snapshot?.services || {})) {
        if (!SERVICE_NAME.test(name)) deny(`${PRE_INGRESS_SNAPSHOT} names ${name}, which is not a Tailscale service name.`);
        const endpoints = saved?.endpoints && typeof saved.endpoints === 'object' ? saved.endpoints : {};
        // A socket service has nothing behind it once nginx is back on TCP.
        const targets = Object.values(endpoints);
        if (targets.length && targets.every(exportsSocket)) continue;
        const present = before.Services?.[name];
        // Older snapshots list every service, and one still present was not retired. Only an entry with
        // frontends can be a restore that stopped part way, so one is recorded before the first change.
        if (present && !snapshot.frontends[name]) continue;
        if (!snapshot.frontends[name]) {
          snapshot.frontends[name] = {};
          writeSnapshot(snapshot);
        }
        const frontends = snapshot.frontends[name];
        for (const [endpoint, target] of Object.entries(endpoints)) {
          if (!frontends[endpoint.slice(4)] && String(target).startsWith('http://')) assumedHttps.push(`${name} :${endpoint.slice(4)}`);
        }
        const live = present ? await readService(name, operation.timeoutMs) : {};
        const missing = Object.entries(endpoints).filter(([endpoint, target]) => live.endpoints?.[endpoint] !== target);
        // Publishing advertises, so a service that was drained before the cutover has to be drained again.
        const drain = saved?.advertised === false && (missing.length > 0 || live.advertised !== false);
        if (!missing.length && !drain) continue;
        touched.push(name);
        for (const [endpoint, target] of missing) await tailscale(restoreArgs(name, endpoint, target, frontends[endpoint.slice(4)]), operation.timeoutMs);
        if (drain) await tailscale(['serve', 'drain', name], operation.timeoutMs);
        const after = (await readService(name, operation.timeoutMs)).endpoints;
        if (!sameEndpoints(after, endpoints)) deny(`Serve did not restore ${name}; check "tailscale serve status --json". Run the rollback again once it is fixed.`);
        restored.push(name);
      }
      const removed = [];
      const leftInPlace = [];
      for (const [name, entry] of Object.entries(before.Services || {})) {
        if (!isSocketService(entry)) {
          if (usesSocket(entry)) leftInPlace.push(name);
          continue;
        }
        if (!SERVICE_NAME.test(name)) deny(`Serve lists ${name}, which is not a Tailscale service name.`);
        touched.push(name);
        await tailscale(['serve', 'clear', name], operation.timeoutMs);
        removed.push(name);
      }
      assertOthersUnchanged(before, await readStatus(operation.timeoutMs), touched, 'The rollback');
      if (snapshot) fsImpl.unlinkSync(PRE_INGRESS_SNAPSHOT);
      return [
        `restored ${restored.join(', ') || 'no retired services'}; removed ${removed.join(', ') || 'no socket services'}`,
        ...(assumedHttps.length ? [`${assumedHttps.join(', ')} came back on HTTPS because the older record doesn't name a frontend; change it by hand if it was plain HTTP`] : []),
        ...(leftInPlace.length ? [`left ${leftInPlace.join(', ')} in place because it also serves something else; remove its socket handler by hand`] : []),
      ].join('; ');
    },
  };
}

module.exports = { PRE_INGRESS_SNAPSHOT, createServeHandlers, parseSnapshot, restoreArgs, serviceEndpoints };
