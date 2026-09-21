const net = require('net');
const crypto = require('crypto');
const { PROTOCOL_VERSION } = require('../../executor/protocol');
const { digestOperationPlan } = require('../operations/digest');

function sendRequest(socketPath, request, { timeoutMs = 10000 } = {}) {
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
        const lines = buffer.trim().split('\n');
        if (lines.length !== 1 || !lines[0]) throw new Error('Executor response is malformed.');
        const response = JSON.parse(lines[0]);
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

function validatePlan(socketPath, plan, options) {
  return sendRequest(socketPath, { protocolVersion: PROTOCOL_VERSION, requestId: crypto.randomUUID(), type: 'validate-plan', planDigest: digestOperationPlan(plan), plan }, options);
}

module.exports = { sendRequest, hello, validatePlan };
