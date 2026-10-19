// The Node.js floor for Home Base and every Node-managed app, and the line install.sh provisions when a
// host has no Node.js. install.sh carries the same two values; test/node-runtime.test.js keeps them equal.
const NODE_MIN_MAJOR = 22;
const NODE_PROVISION_MAJOR = 24;

module.exports = { NODE_MIN_MAJOR, NODE_PROVISION_MAJOR };
