const test = require('node:test');
const assert = require('node:assert/strict');
const { serverBlocks, appSnippetIncludeProblem, operatorServesAppSnippets } = require('../src/operations/nginx-config');

// Shaped like `nginx -T`: every file after a "# configuration file <path>:" header, includes unexpanded.
const dump = (files) => files.map(([file, text]) => `# configuration file ${file}:\n${text}`).join('\n');

// numenor: the serving block sits in nginx.conf itself, next to an electrs stream server.
const NUMENOR = (serving) => dump([['/etc/nginx/nginx.conf', `stream {\n  server {\n    listen 50002 ssl;\n    proxy_pass 127.0.0.1:50001;\n  }\n}\nhttp {\n  server {\n    listen 443 ssl http2;\n    server_name numenor.example.ts.net;\n${serving}\n  }\n}\n`]]);
// erebor: a site file for erebor.forbell.com.
const EREBOR = (serving, extra = '') => dump([
  ['/etc/nginx/nginx.conf', 'http {\n  include /etc/nginx/sites-enabled/*;\n}\n'],
  ['/etc/nginx/sites-enabled/erebor.forbell.com', `server {\n  listen 443 ssl http2;\n  server_name erebor.forbell.com;\n${serving}\n  location /x { return 404; }\n}\nserver {\n  listen 80;\n  return 301 https://$host$request_uri;\n}\n${extra}`],
]);
const LEGACY = '  include /etc/nginx/snippets/*.conf;';
const BOTH = `${LEGACY}\n  include /etc/nginx/sovereign-home.d/*.conf;`;

test('both includes in the serving block pass, on either host layout', () => {
  assert.equal(appSnippetIncludeProblem(EREBOR(BOTH)), null);
  assert.equal(appSnippetIncludeProblem(NUMENOR(BOTH)), null);
  assert.equal(appSnippetIncludeProblem(NUMENOR(`${LEGACY}\n  include sovereign-home.d/*.conf;`)), null, 'relative include paths resolve against /etc/nginx');
});

test('the executor include in a different server block is refused (it would leave the public route broken)', () => {
  const split = EREBOR(LEGACY, 'server {\n  listen 8443;\n  include /etc/nginx/sovereign-home.d/*.conf;\n}\n');
  assert.match(appSnippetIncludeProblem(split), /sites-enabled\/erebor\.forbell\.com includes \/etc\/nginx\/snippets\/\*\.conf but not \/etc\/nginx\/sovereign-home\.d\/\*\.conf/);
  const httpLevel = dump([['/etc/nginx/nginx.conf', `http {\n  include /etc/nginx/sovereign-home.d/*.conf;\n  server {\n${LEGACY}\n  }\n}\n`]]);
  assert.ok(appSnippetIncludeProblem(httpLevel), 'an include at http level is not inside the serving block');
});

test('every block that serves legacy snippets needs the executor include, and commented includes do not count', () => {
  const twoServing = EREBOR(BOTH, `server {\n  listen 80 default_server;\n${LEGACY}\n}\n`);
  assert.ok(appSnippetIncludeProblem(twoServing));
  assert.ok(appSnippetIncludeProblem(EREBOR(`${LEGACY}\n  # include /etc/nginx/sovereign-home.d/*.conf;`)));
  assert.match(appSnippetIncludeProblem(EREBOR('  include /etc/nginx/sovereign-home.d/*.conf;')), /no nginx server block includes/);
});

test('stream servers are ignored and nested blocks keep the right server', () => {
  const blocks = serverBlocks(NUMENOR(BOTH));
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].includes, ['/etc/nginx/snippets/*.conf', '/etc/nginx/sovereign-home.d/*.conf']);
  const erebor = serverBlocks(EREBOR(BOTH));
  assert.equal(erebor.length, 2, 'the redirect server is its own block');
});

test("operator gateway detection ignores the executor's own gateway site", () => {
  const managed = dump([['/etc/nginx/sites-enabled/sovereign-home', 'server {\n  listen 443 ssl default_server;\n  include /etc/nginx/sovereign-home.d/*.conf;\n}\n']]);
  assert.equal(operatorServesAppSnippets(managed, '/etc/nginx/sites-enabled/sovereign-home'), false);
  assert.equal(operatorServesAppSnippets(EREBOR(BOTH), '/etc/nginx/sites-enabled/sovereign-home'), true);
  assert.equal(operatorServesAppSnippets(EREBOR(LEGACY), '/etc/nginx/sites-enabled/sovereign-home'), false);
});
