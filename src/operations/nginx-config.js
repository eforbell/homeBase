// Reads `nginx -T` output: which server blocks include which snippet directories. Adopt must know that
// the block serving an app's legacy route (it includes /etc/nginx/snippets/*.conf) also includes the
// executor's /etc/nginx/sovereign-home.d/*.conf; an include anywhere else in the config would pass
// `nginx -t` and loopback readiness while the public route disappears.

const LEGACY_SNIPPETS = '/etc/nginx/snippets/*.conf';
const APP_SNIPPETS = '/etc/nginx/sovereign-home.d/*.conf';

// nginx resolves relative include paths against its prefix (/etc/nginx on Debian-family hosts).
function normalizeInclude(target) {
  const value = String(target).replace(/^["']|["']$/g, '');
  return value.startsWith('/') ? value : `/etc/nginx/${value}`;
}

// Drops comments (outside quotes) so commented-out includes and braces never count.
function stripComments(text) {
  let out = '';
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      out += char;
      if (char === '\\') { out += text[index + 1] || ''; index += 1; } else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; out += char; continue; }
    if (char === '#') {
      while (index < text.length && text[index] !== '\n') index += 1;
      out += '\n';
      continue;
    }
    out += char;
  }
  return out;
}

// `nginx -T` prints every configuration file after a "# configuration file <path>:" header, with include
// directives left as written. Returns [{ file, includes: [normalized paths] }] for every `server { }` block
// in the http context (stream servers are skipped: they never serve app routes). Includes are counted
// anywhere inside the block, nested locations included.
function serverBlocks(nginxT) {
  const sections = String(nginxT || '').split(/^# configuration file (.+):$/m);
  const blocks = [];
  for (let index = 1; index < sections.length; index += 2) {
    const file = sections[index].trim();
    const text = stripComments(sections[index + 1] || '');
    // Track the enclosing block names so servers inside `stream { }` are ignored.
    const stack = [];
    const tokenPattern = /([A-Za-z_][A-Za-z0-9_]*)\s*(?:[^;{}]*?)\{|\}|include\s+([^;\s]+)\s*;/g;
    let open = null;
    let match;
    while ((match = tokenPattern.exec(text))) {
      if (match[0] === '}') {
        const closed = stack.pop();
        if (closed && open && closed === open.marker) {
          blocks.push({ file, includes: open.includes });
          open = null;
        }
        continue;
      }
      if (match[2] !== undefined) {
        if (open) open.includes.push(normalizeInclude(match[2]));
        continue;
      }
      const name = match[1];
      const marker = { name };
      stack.push(marker);
      if (name === 'server' && !open && !stack.some((entry) => entry.name === 'stream')) open = { marker, includes: [] };
    }
  }
  return blocks;
}

// Adopt's precondition. Every server block that serves legacy app snippets must also serve the executor's,
// in that same block, and at least one such block must exist.
function appSnippetIncludeProblem(nginxT) {
  const blocks = serverBlocks(nginxT);
  const legacy = blocks.filter((block) => block.includes.includes(LEGACY_SNIPPETS));
  if (!legacy.length) return `no nginx server block includes ${LEGACY_SNIPPETS}, so there is no legacy app route to take over`;
  const missing = legacy.filter((block) => !block.includes.includes(APP_SNIPPETS));
  if (missing.length) {
    return `the server block${missing.length > 1 ? 's' : ''} in ${[...new Set(missing.map((block) => block.file))].join(', ')} include${missing.length > 1 ? '' : 's'} ${LEGACY_SNIPPETS} but not ${APP_SNIPPETS}`;
  }
  return null;
}

// True when an operator-managed server block (not the executor's own gateway site) already serves the
// executor's snippets, so installing the managed default_server gateway would compete with it.
function operatorServesAppSnippets(nginxT, managedGatewayFile) {
  return serverBlocks(nginxT).some((block) => block.file !== managedGatewayFile && block.includes.includes(APP_SNIPPETS));
}

module.exports = { LEGACY_SNIPPETS, APP_SNIPPETS, serverBlocks, appSnippetIncludeProblem, operatorServesAppSnippets };
