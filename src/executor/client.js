const net = require('net');
const crypto = require('crypto');
const { PROTOCOL_VERSION } = require('../../executor/protocol');
const { digestOperationPlan } = require('../operations/digest');

function sendRequest(socketPath, request, { timeoutMs = 10000, onEvent = null } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error('Executor request timed out.')); }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk) => { buffer += chunk; });
    socket.on('error', (error) => { clearTimeout(timeout); reject(error); });
    socket.on('end', () => {
      clearTimeout(timeout);
      try {
        const lines = buffer.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
        for (const event of lines.slice(0, -1)) if (typeof onEvent === 'function') onEvent(event);
        const response = lines.at(-1);
        if (!response || response.type !== 'terminal') throw new Error('Executor response is malformed.');
        if (!response.ok) {
          const error = new Error(response.message || response.code || 'Executor rejected request.');
          error.code = response.code;
          reject(error);
          return;
        }
        resolve(response.result);
      } catch (error) { reject(error); }
    });
  });
}

function hello(socketPath, options) {
  return sendRequest(socketPath, { protocolVersion: PROTOCOL_VERSION, requestId: crypto.randomUUID(), type: 'hello' }, options);
}

function executePlan(socketPath, { jobId, plan, secretBindings, actor = { kind: 'homebase-admin-session', auditRef: 'local' } }, options) {
  return sendRequest(socketPath, { protocolVersion: PROTOCOL_VERSION, requestId: crypto.randomUUID(), type: 'execute-plan', jobId: String(jobId), actor, issuedAt: new Date().toISOString(), planDigest: digestOperationPlan(plan), plan, secretBindings }, options);
}

function validatePlan(socketPath, plan, options) {
  return sendRequest(socketPath, { protocolVersion: PROTOCOL_VERSION, requestId: crypto.randomUUID(), type: 'validate-plan', planDigest: digestOperationPlan(plan), plan }, options);
}

module.exports = { sendRequest, hello, validatePlan, executePlan };
