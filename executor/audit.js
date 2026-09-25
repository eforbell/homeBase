const { redactText } = require('../src/operations/redact');

function writeAudit(logger, message, secrets = []) {
  logger.info(`[homebase-executor] ${redactText(message, secrets)}`);
}

module.exports = { writeAudit };
