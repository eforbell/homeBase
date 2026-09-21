const { digestOperationPlan } = require('../src/operations/digest');
const { validateOperationPolicy } = require('../src/operations/policy');

const PROTOCOL_VERSION = 1;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const REQUEST_TYPES = new Set(['hello', 'validate-plan']);

class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function requireExactKeys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProtocolError('INVALID_REQUEST', 'Request must be an object.');
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new ProtocolError('INVALID_REQUEST', `Unsupported request field: ${key}`);
}

function validateRequest(request) {
  requireExactKeys(request, new Set(['protocolVersion', 'requestId', 'type', 'jobId', 'actor', 'issuedAt', 'planDigest', 'plan']));
  if (request.protocolVersion !== PROTOCOL_VERSION) throw new ProtocolError('UNSUPPORTED_PROTOCOL', 'Unsupported executor protocol version.');
  if (typeof request.requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(request.requestId)) throw new ProtocolError('INVALID_REQUEST', 'requestId must be a UUID.');
  if (!REQUEST_TYPES.has(request.type)) throw new ProtocolError('INVALID_REQUEST', 'Unsupported request type.');
  if (request.type === 'hello') {
    requireExactKeys(request, new Set(['protocolVersion', 'requestId', 'type']));
    return request;
  }
  requireExactKeys(request, new Set(['protocolVersion', 'requestId', 'type', 'planDigest', 'plan']));
  if (typeof request.planDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(request.planDigest)) throw new ProtocolError('INVALID_REQUEST', 'planDigest must be a SHA-256 digest.');
  validateOperationPolicy(request.plan);
  if (digestOperationPlan(request.plan) !== request.planDigest) throw new ProtocolError('PLAN_DIGEST_MISMATCH', 'Plan digest does not match the validated plan.');
  return request;
}

function parseRequestLine(line) {
  if (!line || !line.trim()) throw new ProtocolError('INVALID_REQUEST', 'Blank request is not allowed.');
  if (Buffer.byteLength(line, 'utf8') > MAX_REQUEST_BYTES) throw new ProtocolError('INVALID_REQUEST', 'Request exceeds the maximum size.');
  let request;
  try { request = JSON.parse(line); } catch { throw new ProtocolError('INVALID_REQUEST', 'Malformed JSON request.'); }
  return validateRequest(request);
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
