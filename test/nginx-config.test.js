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
  assert.match(appSnippetIncludeProblem(split), /1 of 1 server block\(s\) that include \/etc\/nginx\/snippets\/\*\.conf \(in \/etc\/nginx\/sites-enabled\/erebor\.forbell\.com\) do not include \/etc\/nginx\/sovereign-home\.d\/\*\.conf/);
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

// Probes from the architecture review: configs the first parser passed although the public route would go.
test('fails safe: a legacy include reached through an intermediate file is refused', () => {
  const viaFile = dump([
    ['/etc/nginx/sites-enabled/a', 'server {\n  server_name erebor.forbell.com;\n  include /etc/nginx/app-routes.inc;\n}\nserver {\n  listen 8443;\n  include /etc/nginx/snippets/*.conf;\n  include /etc/nginx/sovereign-home.d/*.conf;\n}\n'],
    ['/etc/nginx/app-routes.inc', 'include /etc/nginx/snippets/*.conf;\n'],
  ]);
  assert.match(appSnippetIncludeProblem(viaFile), /outside a server block/);
});

test('fails safe: `#` inside a token is not a comment', () => {
  const hashInToken = EREBOR(`${LEGACY}\n  location = /x { return 301 /app/#top; }`, 'server {\n  listen 8443;\n  include /etc/nginx/snippets/*.conf;\n  include /etc/nginx/sovereign-home.d/*.conf;\n}\n');
  assert.match(appSnippetIncludeProblem(hashInToken), /1 of 2 server block\(s\)/);
});

test('fails safe: braces inside quoted strings do not close blocks', () => {
  const quoted = EREBOR(`  return 200 "}";\n${LEGACY}`, 'server {\n  listen 8443;\n  include /etc/nginx/snippets/*.conf;\n  include /etc/nginx/sovereign-home.d/*.conf;\n}\n');
  assert.match(appSnippetIncludeProblem(quoted), /1 of 2 server block\(s\)/);
  assert.equal(appSnippetIncludeProblem(EREBOR(`  return 200 '{"ok":true}';\n${BOTH}`)), null);
});

test('fails safe: unbalanced or truncated config is refused rather than partly read', () => {
  assert.match(appSnippetIncludeProblem(dump([['/etc/nginx/x', `server {\n${BOTH}\n  location / {\n}\n`]])), /could not read the nginx configuration reliably.*never close/);
  assert.match(appSnippetIncludeProblem(dump([['/etc/nginx/x', `server {\n${BOTH}\n}\n}\n`]])), /closes nothing/);
  assert.match(appSnippetIncludeProblem(dump([['/etc/nginx/x', 'server {\n  include /etc/nginx/snippets/*.conf\n}\n']])), /missing its ';'/);
  assert.match(appSnippetIncludeProblem(''), /no nginx server block/);
  assert.throws(() => operatorServesAppSnippets(dump([['/etc/nginx/x', 'server {\n']]), '/etc/nginx/sites-enabled/sovereign-home'), /never close/);
});

test('real nginx -T output: the split layout that passes nginx -t is refused; the correct one is accepted', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'nginx', name), 'utf8');
  const { appSnippetIncludeCheck } = require('../src/operations/nginx-config');
  const ok = appSnippetIncludeCheck(read('erebor-shaped-ok.nginx-T'));
  assert.equal(ok.problem, null);
  assert.match(ok.seen, /1 server block\(s\) serve legacy snippets: \/etc\/nginx\/sites-enabled\/erebor\.forbell\.com/);
  assert.match(appSnippetIncludeCheck(read('erebor-shaped-split.nginx-T')).problem, /do not include \/etc\/nginx\/sovereign-home\.d/);
});
