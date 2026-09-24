const net = require('net');
const { MAX_REQUEST_BYTES, MAX_LINE_BYTES, ProtocolError, parseRequestLine, result } = require('./protocol');
const { executorCapabilities } = require('./context');
const { digestOperationPlan } = require('../src/operations/digest');
const { writeAudit } = require('./audit');
const { executePlan: defaultExecutePlan } = require('./execute');
const { createBaseHandlers, deployKeyStatus } = require('./handlers');
const { createHostStatusCollector } = require('./host-status');

function encodeLine(payload) {
  const line = JSON.stringify(payload);
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) throw new Error('Executor response exceeds protocol line limit.');
  return `${line}\n`;
}

function createExecutorServer({ logger = console, requestTimeoutMs = 10000, executePlan = null, mutationsEnabled = false, probeDeployKey = () => 'missing', collectHostStatus = null } = {}) {
  const completed = new Map();
  let activeMutation = false;
  return net.createServer((socket) => {
    let buffer = '';
    let settled = false;
    let accepted = false;
    socket.setEncoding('utf8');
    // A fixed (not idle) deadline, so a peer cannot trickle bytes to hold the connection open.
    const acceptDeadline = setTimeout(() => finish(new ProtocolError('INVALID_REQUEST', 'Request timed out before acceptance.')), requestTimeoutMs);
    const emit = (request, event) => socket.write(encodeLine({ protocolVersion: 1, requestId: request.requestId, jobId: request.jobId, sequence: event.sequence, timestamp: new Date().toISOString(), ...event }));
    function finish(error, response) {
      if (settled) return;
      settled = true;
      clearTimeout(acceptDeadline);
      // Reclaim the descriptor if the peer never closes its side after the terminal line.
      socket.setTimeout(requestTimeoutMs, () => socket.destroy());
      if (error) {
        const code = error.code || 'INVALID_REQUEST';
        writeAudit(logger, `rejected request code=${code}`);
        socket.end(encodeLine(result({ requestId: error.requestId || null, ok: false, code, message: error.message })));
      } else socket.end(encodeLine(response));
    }
    socket.on('data', async (chunk) => {
      // After acceptance, extra bytes cannot restart processing while a plan runs.
      if (settled || accepted) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_REQUEST_BYTES) return finish(new ProtocolError('INVALID_REQUEST', 'Request exceeds the maximum size.'));
      const firstNewline = buffer.indexOf('\n');
      if (firstNewline < 0) return;
      const line = buffer.slice(0, firstNewline).replace(/\r$/, '');
      if (buffer.slice(firstNewline + 1).trim()) return finish(new ProtocolError('INVALID_REQUEST', 'Only one request is allowed per connection.'));
      let ownsMutation = false;
      try {
        const request = parseRequestLine(line);
        // The deadline only guards the pre-acceptance read; accepted plans run for as long as their
        // per-operation timeouts allow, often with long silent stretches (apt, npm ci).
        accepted = true;
        clearTimeout(acceptDeadline);
        if (completed.has(request.requestId)) return finish(null, completed.get(request.requestId));
        if (request.type === 'execute-plan') {
          if (activeMutation) throw new ProtocolError('EXECUTOR_BUSY', 'Another mutation plan is active.');
          if (!executePlan) throw new ProtocolError('POLICY_DENIED', 'Executor mutations are not enabled.');
          activeMutation = true;
          ownsMutation = true;
          let sequence = 0;
          const execution = await executePlan(request, { emit: (event) => emit(request, { ...event, sequence: ++sequence }) });
          activeMutation = false;
          ownsMutation = false;
          const response = result({ requestId: request.requestId, ok: true, result: execution });
          completed.set(request.requestId, response);
          return finish(null, response);
        }
        if (request.type === 'host-status') {
          if (!collectHostStatus) throw new ProtocolError('POLICY_DENIED', 'Host status is not enabled.');
          return finish(null, result({ requestId: request.requestId, ok: true, result: await collectHostStatus() }));
        }
        const response = request.type === 'hello'
          ? result({ requestId: request.requestId, ok: true, result: { capabilities: executorCapabilities({ mutationsEnabled, gitDeployKey: probeDeployKey() }), activePlan: activeMutation } })
          : result({ requestId: request.requestId, ok: true, result: { valid: true, planDigest: digestOperationPlan(request.plan), mutationsEnabled: false } });
        completed.set(request.requestId, response);
        writeAudit(logger, `accepted request type=${request.type} requestId=${request.requestId}`);
        finish(null, response);
      } catch (error) { if (ownsMutation) activeMutation = false; finish(error); }
    });
    socket.on('error', () => { settled = true; clearTimeout(acceptDeadline); socket.destroy(); });
  });
}
function listenSystemd({ logger = console } = {}) {
  const handlers = createBaseHandlers();
  const executePlan = (request, { emit }) => defaultExecutePlan(request, { handlers, emit });
  const server = createExecutorServer({ logger, executePlan, mutationsEnabled: true, probeDeployKey: () => deployKeyStatus(), collectHostStatus: createHostStatusCollector() });
  if (Number.parseInt(process.env.LISTEN_FDS || '0', 10) < 1) throw new Error('homebase-executor requires a systemd-passed listening socket.');
  server.listen({ fd: 3 });
  return server;
}
if (require.main === module) listenSystemd();
module.exports = { createExecutorServer, listenSystemd };
