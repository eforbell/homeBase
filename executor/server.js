const net = require('net');
const { MAX_REQUEST_BYTES, MAX_LINE_BYTES, ProtocolError, parseRequestLine, result } = require('./protocol');
const { executorCapabilities } = require('./context');
const { digestOperationPlan } = require('../src/operations/digest');
const { writeAudit } = require('./audit');

function writeLine(socket, payload) {
  const line = JSON.stringify(payload);
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) throw new Error('Executor response exceeds protocol line limit.');
  socket.end(`${line}\n`);
}

function createExecutorServer({ logger = console, requestTimeoutMs = 10000 } = {}) {
  const completed = new Map();
  return net.createServer((socket) => {
    let buffer = '';
    let settled = false;
    socket.setEncoding('utf8');
    socket.setTimeout(requestTimeoutMs, () => finish(new ProtocolError('INVALID_REQUEST', 'Request timed out before acceptance.')));

    function finish(error, response) {
      if (settled) return;
      settled = true;
      if (error) {
        const code = error.code || 'INVALID_REQUEST';
        writeAudit(logger, `rejected request code=${code}`);
        writeLine(socket, result({ requestId: null, ok: false, code, message: error.message }));
        return;
      }
      writeLine(socket, response);
    }

    socket.on('data', (chunk) => {
      if (settled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_REQUEST_BYTES) return finish(new ProtocolError('INVALID_REQUEST', 'Request exceeds the maximum size.'));
      const firstNewline = buffer.indexOf('\n');
      if (firstNewline < 0) return;
      const line = buffer.slice(0, firstNewline).replace(/\r$/, '');
      const trailing = buffer.slice(firstNewline + 1);
      if (trailing.trim()) return finish(new ProtocolError('INVALID_REQUEST', 'Only one request is allowed per connection.'));
      try {
        const request = parseRequestLine(line);
        if (completed.has(request.requestId)) return finish(null, completed.get(request.requestId));
        const response = request.type === 'hello'
          ? result({ requestId: request.requestId, ok: true, result: { capabilities: executorCapabilities(), activePlan: false } })
          : result({ requestId: request.requestId, ok: true, result: { valid: true, planDigest: digestOperationPlan(request.plan), mutationsEnabled: false } });
        completed.set(request.requestId, response);
        writeAudit(logger, `accepted request type=${request.type} requestId=${request.requestId}`);
        finish(null, response);
      } catch (error) {
        finish(error);
      }
    });
    socket.on('error', () => { settled = true; });
  });
}

function listenSystemd({ logger = console } = {}) {
  const server = createExecutorServer({ logger });
  const fds = Number.parseInt(process.env.LISTEN_FDS || '0', 10);
  if (fds < 1) throw new Error('homebase-executor requires a systemd-passed listening socket.');
  server.listen({ fd: 3 });
  return server;
}

if (require.main === module) listenSystemd();

module.exports = { createExecutorServer, listenSystemd };
