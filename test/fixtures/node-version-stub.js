// Make a real Node.js process report another version, for testing version floors. Usage:
// NODE_STUB_VERSION=18.19.1 node --require test/fixtures/node-version-stub.js ...
const version = process.env.NODE_STUB_VERSION;
if (version) Object.defineProperty(process, 'versions', { value: { ...process.versions, node: version } });
