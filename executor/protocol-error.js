class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

module.exports = { ProtocolError };
