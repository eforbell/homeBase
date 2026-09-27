// Reads `nginx -T` output: which server blocks include which snippet directories. Adopt must know that
// the block serving an app's legacy route (it includes /etc/nginx/snippets/*.conf) also includes the
// executor's /etc/nginx/sovereign-home.d/*.conf; an include anywhere else in the config would pass
// `nginx -t` and loopback readiness while the public route disappears. Anything this reader cannot
// account for is refused, never guessed.

const LEGACY_SNIPPETS = '/etc/nginx/snippets/*.conf';
const APP_SNIPPETS = '/etc/nginx/sovereign-home.d/*.conf';

class NginxParseError extends Error {}

// nginx resolves relative include paths against its prefix (/etc/nginx on Debian-family hosts).
function normalizeInclude(target) {
  return String(target).startsWith('/') ? String(target) : `/etc/nginx/${target}`;
}

// nginx's own lexing: whitespace separates tokens; `{`, `}`, and `;` are tokens of their own; a quoted
// string is one token (braces and `#` inside it are text); `#` starts a comment only at the start of a
// token, so `/app/#top` is a single word.
function tokenize(text, file) {
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (/\s/.test(char)) { index += 1; continue; }
    if (char === '#') {
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (char === '{' || char === '}' || char === ';') { tokens.push({ type: char }); index += 1; continue; }
    if (char === '"' || char === "'") {
      let value = '';
      index += 1;
      while (index < text.length && text[index] !== char) {
        if (text[index] === '\\' && index + 1 < text.length) { value += text[index + 1]; index += 2; continue; }
        value += text[index];
        index += 1;
      }
      if (index >= text.length) throw new NginxParseError(`${file}: unterminated quoted string`);
      index += 1;
      tokens.push({ type: 'word', value });
      continue;
    }
    let value = '';
    while (index < text.length && !/[\s{};]/.test(text[index])) {
      if ((text[index] === '"' || text[index] === "'") && value === '') break;
      value += text[index];
      index += 1;
    }
    tokens.push({ type: 'word', value });
  }
  return tokens;
}

// `nginx -T` prints every configuration file after a "# configuration file <path>:" header, with include
// directives left as written. Returns { servers, strayLegacyIncludes }:
//   servers: [{ file, includes }] for every `server { }` outside a `stream { }` block
//   strayLegacyIncludes: legacy snippet includes that are not directly inside such a server block (at http
//     level, or in an intermediate file whose server block cannot be known from here)
// Throws NginxParseError on anything structurally unbalanced.
function parseNginxDump(nginxT) {
  const sections = String(nginxT || '').split(/^# configuration file (.+):$/m);
  const servers = [];
  const strayLegacyIncludes = [];
  for (let section = 1; section < sections.length; section += 2) {
    const file = sections[section].trim();
    const tokens = tokenize(sections[section + 1] || '', file);
    const stack = [];
    let words = [];
    for (const token of tokens) {
      if (token.type === 'word') { words.push(token.value); continue; }
      if (token.type === '{') {
        if (!words.length) throw new NginxParseError(`${file}: a block without a name`);
        const block = { name: words[0] };
        if (block.name === 'server' && !stack.some((entry) => entry.name === 'stream')) {
          block.server = { file, includes: [] };
          servers.push(block.server);
        }
        stack.push(block);
        words = [];
        continue;
      }
      if (token.type === ';') {
        if (words[0] === 'include') {
          if (words.length !== 2) throw new NginxParseError(`${file}: include needs exactly one path`);
          const target = normalizeInclude(words[1]);
          const server = [...stack].reverse().find((entry) => entry.server)?.server;
          if (server) server.includes.push(target);
          else if (target === LEGACY_SNIPPETS) strayLegacyIncludes.push(file);
        }
        words = [];
        continue;
      }
      // '}'
      if (words.length) throw new NginxParseError(`${file}: a directive is missing its ';'`);
      if (!stack.length) throw new NginxParseError(`${file}: a '}' closes nothing`);
      stack.pop();
    }
    if (words.length) throw new NginxParseError(`${file}: a directive is missing its ';'`);
    if (stack.length) throw new NginxParseError(`${file}: ${stack.length} block(s) never close`);
  }
  return { servers, strayLegacyIncludes };
}

// Adopt's precondition, as { problem, seen }. Every server block that serves legacy app snippets must also
// serve the executor's, in that same block; at least one must exist; and every legacy include must be
// accounted for in such a block.
function appSnippetIncludeCheck(nginxT) {
  let parsed;
  try { parsed = parseNginxDump(nginxT); } catch (error) {
    return { problem: `could not read the nginx configuration reliably (${error.message}), so adopt cannot tell which server block serves the apps`, seen: '' };
  }
  const legacy = parsed.servers.filter((server) => server.includes.includes(LEGACY_SNIPPETS));
  const seen = `${legacy.length} server block(s) serve legacy snippets: ${legacy.map((server) => server.file).join(', ') || 'none'}`;
  if (parsed.strayLegacyIncludes.length) {
    return { problem: `${[...new Set(parsed.strayLegacyIncludes)].join(', ')} include(s) ${LEGACY_SNIPPETS} outside a server block (for example through an intermediate file), so adopt cannot tell which server block serves the apps; put both includes directly in the serving server block`, seen };
  }
  if (!legacy.length) return { problem: `no nginx server block includes ${LEGACY_SNIPPETS}, so there is no legacy app route to take over`, seen };
  const missing = legacy.filter((server) => !server.includes.includes(APP_SNIPPETS));
  if (missing.length) {
    return { problem: `${missing.length} of ${legacy.length} server block(s) that include ${LEGACY_SNIPPETS} (in ${[...new Set(missing.map((server) => server.file))].join(', ')}) do not include ${APP_SNIPPETS}`, seen };
  }
  return { problem: null, seen };
}

function appSnippetIncludeProblem(nginxT) {
  return appSnippetIncludeCheck(nginxT).problem;
}

// True when an operator-managed server block (not the executor's own gateway site) already serves the
// executor's snippets, so installing the managed default_server gateway would compete with it. Throws
// NginxParseError when the config cannot be read reliably (the caller refuses).
function operatorServesAppSnippets(nginxT, managedGatewayFile) {
  return parseNginxDump(nginxT).servers.some((server) => server.file !== managedGatewayFile && server.includes.includes(APP_SNIPPETS));
}

// Kept for tests and diagnostics.
function serverBlocks(nginxT) {
  return parseNginxDump(nginxT).servers;
}

module.exports = { LEGACY_SNIPPETS, APP_SNIPPETS, NginxParseError, parseNginxDump, serverBlocks, appSnippetIncludeCheck, appSnippetIncludeProblem, operatorServesAppSnippets };
