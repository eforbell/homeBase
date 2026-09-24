// Preload that makes `ajv` unresolvable, simulating a legacy host whose npm ci did not complete.
const Module = require('module');
const resolve = Module._resolveFilename;
Module._resolveFilename = function blockAjv(request, ...rest) {
  if (/^ajv(\/|-|$)/.test(request)) throw Object.assign(new Error(`blocked ${request}`), { code: 'MODULE_NOT_FOUND' });
  return resolve.call(this, request, ...rest);
};
