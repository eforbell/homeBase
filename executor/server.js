const net = require('net');
const { MAX_REQUEST_BYTES, MAX_LINE_BYTES, ProtocolError, PROTOCOL_VERSION, parseRequestLine, result } = require('./protocol');
const { executorCapabilities } = require('./context');
const { writeAudit } = require('./audit');
const { createBaseHandlers, deployKeyStatus } = require('./handlers');
const { createHostStatusCollector } = require('./host-status');
const { createAppUpdateStatusChecker } = require('./app-status');
const { compileAction } = require('./actions');
const { createLifecycleHandlers } = require('./lifecycle-handlers');
const { createJournal } = require('./journal');
const { createRunAction } = require('./run-action');

function encodeLine(payload) {
  const line = JSON.stringify(payload);
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) throw new Error('Executor response exceeds protocol line limit.');
  return `${line}\n`;
}

function createExecutorServer({ logger = console, requestTimeoutMs = 10000, runAction = null, planAction = (spec) => compileAction(spec), mutationsEnabled = false, probeDeployKey = () => 'missing', collectHostStatus = null, checkAppUpdateStatus = null, actionStatus = null } = {}) {
  // Replay protection for run-action only (a retried request must not run a plan twice). Read-only
  // requests are cheap to answer again and are not cached; the map is bounded either way.
  const completed = new Map();
  const REPLAY_LIMIT = 256;
  const remember = (requestId, response) => {
    completed.set(requestId, response);
    if (completed.size > REPLAY_LIMIT) completed.delete(completed.keys().next().value);
  };
  let activeMutation = false;
  return net.createServer((socket) => {
    let buffer = '';
    let settled = false;
    let accepted = false;
    socket.setEncoding('utf8');
    // A fixed (not idle) deadline, so a peer cannot trickle bytes to hold the connection open.
    const acceptDeadline = setTimeout(() => finish(new ProtocolError('INVALID_REQUEST', 'Request timed out before acceptance.')), requestTimeoutMs);
    const emit = (request, event) => socket.write(encodeLine({ protocolVersion: PROTOCOL_VERSION, requestId: request.requestId, jobId: request.jobId, sequence: event.sequence, timestamp: new Date().toISOString(), ...event }));
    function finish(error, response) {
      if (settled) return;
      // Encode before settling so an oversized response still yields a terminal error line.
      let payload;
      if (error) {
        const code = error.code || 'INVALID_REQUEST';
        writeAudit(logger, `rejected request code=${code}`);
        payload = encodeLine(result({ requestId: error.requestId || null, ok: false, code, message: error.message }));
      } else {
        try { payload = encodeLine(response); } catch {
          payload = encodeLine(result({ requestId: response?.requestId || null, ok: false, code: 'RESPONSE_TOO_LARGE', message: 'Executor response exceeds the protocol line limit.' }));
        }
      }
      settled = true;
      clearTimeout(acceptDeadline);
      // Reclaim the descriptor if the peer never closes its side after the terminal line.
      socket.setTimeout(requestTimeoutMs, () => socket.destroy());
      socket.end(payload);
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
        if (request.type === 'run-action') {
          if (activeMutation) throw new ProtocolError('EXECUTOR_BUSY', 'Another mutation plan is active.');
          if (!runAction) throw new ProtocolError('POLICY_DENIED', 'Executor mutations are not enabled.');
          activeMutation = true;
          ownsMutation = true;
          writeAudit(logger, `accepted run-action action=${request.actionSpec.action} app=${request.actionSpec.appId || '-'} jobId=${request.jobId} requestId=${request.requestId}`);
          let sequence = 0;
          const execution = await runAction(request.actionSpec, { emit: (event) => emit(request, { ...event, sequence: ++sequence }), jobId: request.jobId, requestId: request.requestId });
          activeMutation = false;
          ownsMutation = false;
          const response = result({ requestId: request.requestId, ok: true, result: execution });
          remember(request.requestId, response);
          return finish(null, response);
        }
        if (request.type === 'app-update-status') {
          if (!checkAppUpdateStatus) throw new ProtocolError('POLICY_DENIED', 'App update status is not enabled.');
          // Shares the mutation lock: it refreshes the same git mirrors an install plan writes.
          if (activeMutation) throw new ProtocolError('EXECUTOR_BUSY', 'Another mutation plan is active.');
          activeMutation = true;
          ownsMutation = true;
          const status = await checkAppUpdateStatus({ appId: request.appId, transport: request.transport, ref: request.ref });
          activeMutation = false;
          ownsMutation = false;
          return finish(null, result({ requestId: request.requestId, ok: true, result: status }));
        }
        if (request.type === 'action-status') {
          if (!actionStatus) throw new ProtocolError('POLICY_DENIED', 'Action status is not enabled.');
          return finish(null, result({ requestId: request.requestId, ok: true, result: actionStatus(request.jobId) }));
        }
        if (request.type === 'host-status') {
          if (!collectHostStatus) throw new ProtocolError('POLICY_DENIED', 'Host status is not enabled.');
          return finish(null, result({ requestId: request.requestId, ok: true, result: await collectHostStatus() }));
        }
        const response = request.type === 'hello'
          ? result({ requestId: request.requestId, ok: true, result: { capabilities: executorCapabilities({ mutationsEnabled, gitDeployKey: probeDeployKey() }), activePlan: activeMutation } })
          : result({ requestId: request.requestId, ok: true, result: planAction(request.actionSpec) });
        writeAudit(logger, `accepted request type=${request.type} requestId=${request.requestId}`);
        finish(null, response);
      } catch (error) { if (ownsMutation) activeMutation = false; finish(error); }
    });
    socket.on('error', () => { settled = true; clearTimeout(acceptDeadline); socket.destroy(); });
  });
}
function listenSystemd({ logger = console } = {}) {
  const handlers = { ...createBaseHandlers(), ...createLifecycleHandlers() };
  const journal = createJournal();
  journal.markInterrupted();
  const runAction = createRunAction({ handlers, journal });
  const server = createExecutorServer({ logger, runAction, mutationsEnabled: true, probeDeployKey: () => deployKeyStatus(), collectHostStatus: createHostStatusCollector(), checkAppUpdateStatus: createAppUpdateStatusChecker(), actionStatus: (jobId) => journal.status(jobId) });
  if (Number.parseInt(process.env.LISTEN_FDS || '0', 10) < 1) throw new Error('homebase-executor requires a systemd-passed listening socket.');
  server.listen({ fd: 3 });
  return server;
}
if (require.main === module) listenSystemd();
module.exports = { createExecutorServer, listenSystemd };
