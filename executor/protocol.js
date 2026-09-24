const { getAppById } = require('../src/catalog');

// v2: callers request high-level actions; the executor compiles every plan it runs (v1 accepted plans).
const PROTOCOL_VERSION = 2;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const REQUEST_TYPES = new Set(['hello', 'host-status', 'app-update-status', 'plan-action', 'run-action']);

const { ProtocolError } = require('./protocol-error');
const { normalizeAction, ACTION_FIELDS } = require('./actions');

function requireExactKeys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProtocolError('INVALID_REQUEST', 'Request must be an object.');
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new ProtocolError('INVALID_REQUEST', `Unsupported request field: ${key}`);
}

const BASE_KEYS = ['protocolVersion', 'requestId', 'type'];

function validateRequest(request) {
  requireExactKeys(request, new Set([...BASE_KEYS, 'jobId', 'actor', 'issuedAt', 'appId', 'transport', 'ref', 'action', 'site', 'backupId', 'keepBackups']));
  if (request.protocolVersion !== PROTOCOL_VERSION) throw new ProtocolError('UNSUPPORTED_PROTOCOL', 'Unsupported executor protocol version.');
  if (typeof request.requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(request.requestId)) throw new ProtocolError('INVALID_REQUEST', 'requestId must be a UUID.');
  if (!REQUEST_TYPES.has(request.type)) throw new ProtocolError('INVALID_REQUEST', 'Unsupported request type.');
  if (request.type === 'hello' || request.type === 'host-status') {
    requireExactKeys(request, new Set(BASE_KEYS));
    return request;
  }
  if (request.type === 'app-update-status') {
    requireExactKeys(request, new Set([...BASE_KEYS, 'appId', 'transport', 'ref']));
    if (typeof request.appId !== 'string' || !getAppById(request.appId)) throw new ProtocolError('INVALID_REQUEST', 'appId must name a catalog app.');
    if (!['https', 'ssh'].includes(request.transport)) throw new ProtocolError('INVALID_REQUEST', 'transport must be https or ssh.');
    if (typeof request.ref !== 'string' || !/^(main|[a-f0-9]{40})$/.test(request.ref)) throw new ProtocolError('INVALID_REQUEST', 'ref must be main or a 40-character commit SHA.');
    return request;
  }
  const run = request.type === 'run-action';
  requireExactKeys(request, new Set([...BASE_KEYS, ...ACTION_FIELDS, ...(run ? ['jobId', 'actor', 'issuedAt'] : [])]));
  const action = normalizeAction(request);
  if (run) {
    if (typeof request.jobId !== 'string' || !/^[1-9][0-9]*$/.test(request.jobId)) throw new ProtocolError('INVALID_REQUEST', 'jobId must be a positive integer string.');
    requireExactKeys(request.actor, new Set(['kind', 'auditRef']));
    if (request.actor.kind !== 'homebase-admin-session' || typeof request.actor.auditRef !== 'string' || request.actor.auditRef.length > 128) throw new ProtocolError('INVALID_REQUEST', 'actor is invalid.');
    const issuedAt = Date.parse(request.issuedAt || '');
    if (!Number.isFinite(issuedAt) || Math.abs(Date.now() - issuedAt) > 5 * 60 * 1000) throw new ProtocolError('INVALID_REQUEST', 'issuedAt is outside the accepted clock skew.');
  }
  return { ...request, actionSpec: action };
}

function requestIdFromValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && typeof value.requestId === 'string'
    && /^[0-9a-f-]{36}$/i.test(value.requestId) ? value.requestId : null;
}

function parseRequestLine(line) {
  if (!line || !line.trim()) throw new ProtocolError('INVALID_REQUEST', 'Blank request is not allowed.');
  if (Buffer.byteLength(line, 'utf8') > MAX_REQUEST_BYTES) throw new ProtocolError('INVALID_REQUEST', 'Request exceeds the maximum size.');
  let request;
  try { request = JSON.parse(line); } catch { throw new ProtocolError('INVALID_REQUEST', 'Malformed JSON request.'); }
  try { return validateRequest(request); } catch (error) {
    error.requestId = requestIdFromValue(request);
    throw error;
  }
}

function result({ requestId, ok, code = null, message = null, result = null }) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: requestId || null,
    type: 'terminal',
    ok,
    ...(code ? { code } : {}),
    ...(message ? { message } : {}),
    ...(result ? { result } : {}),
  };
}

module.exports = { PROTOCOL_VERSION, MAX_REQUEST_BYTES, MAX_LINE_BYTES, ProtocolError, parseRequestLine, result };
