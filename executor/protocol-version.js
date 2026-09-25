// Deliberately dependency-free: the web process reads this without loading the executor's plan
// compiler (and its JSON Schema dependencies). v2: callers name actions; the executor compiles plans.
const PROTOCOL_VERSION = 2;

module.exports = { PROTOCOL_VERSION };
