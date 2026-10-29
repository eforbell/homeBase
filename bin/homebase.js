#!/usr/bin/env node
// Home Base's root shell commands. Feature-10 SID-004:
//
//   homebase admin reset [--administrator <login>]
//
// Returns the household directory to setup: every administrator credential and session is revoked, the
// global epoch moves (every assurance cookie stops working), and a new passphrase is set. The founder then
// unlocks with it from their own tailnet account. --administrator names a different tailnet login to be
// the next founder, for when the old administrator's account is gone. Root only; audited.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const USAGE = 'usage: homebase admin reset [--administrator <login>]';
const LOGIN = /^[\x21-\x7e]{1,320}$/;

function parseArgs(argv) {
  const [group, command, ...rest] = argv;
  if (group !== 'admin' || command !== 'reset') return { error: USAGE };
  let administratorLogin = null;
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === '--administrator' && LOGIN.test(rest[index + 1] || '')) {
      administratorLogin = rest[index + 1];
      index += 1;
    } else {
      return { error: USAGE };
    }
  }
  return { administratorLogin };
}

// The service's own settings (KEY=VALUE lines), under anything already in the environment.
function loadEnvFile(file, env) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && env[match[1]] === undefined) env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

// Lines piped on stdin (no terminal), read once and handed out in order; null after the input ends.
function createLineReader(input) {
  const lines = [];
  const waiting = [];
  let buffer = '';
  let ended = false;
  const flush = () => {
    while (waiting.length && (lines.length || ended)) waiting.shift()(lines.length ? lines.shift() : null);
  };
  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      lines.push(buffer.slice(0, at).replace(/\r$/, ''));
      buffer = buffer.slice(at + 1);
    }
    flush();
  });
  input.on('end', () => {
    if (buffer) lines.push(buffer);
    buffer = '';
    ended = true;
    flush();
  });
  return () => new Promise((resolve) => { waiting.push(resolve); flush(); });
}

let pipedLine = null;

// A line from the terminal without echo, or the next line piped on stdin. Null when the input ended.
function promptHidden(question) {
  const input = process.stdin;
  process.stderr.write(question);
  if (!input.isTTY) {
    pipedLine = pipedLine || createLineReader(input);
    return pipedLine().then((line) => { process.stderr.write('\n'); return line; });
  }
  return new Promise((resolve) => {
    let value = '';
    input.setRawMode(true);
    input.setEncoding('utf8');
    input.resume();
    const onKey = (key) => {
      if (key === '\u0003') { input.setRawMode(false); process.stderr.write('\n'); process.exit(130); }
      if (key === '\r' || key === '\n') {
        input.setRawMode(false);
        input.off('data', onKey);
        input.pause();
        process.stderr.write('\n');
        resolve(value);
      } else if (key === '\u007f') {
        value = value.slice(0, -1);
      } else {
        value += key;
      }
    };
    input.on('data', onKey);
  });
}

function dropTo(user) {
  const uid = Number(execFileSync('id', ['-u', user], { encoding: 'utf8' }).trim());
  const gid = Number(execFileSync('id', ['-g', user], { encoding: 'utf8' }).trim());
  process.initgroups(user, gid);
  process.setgid(gid);
  process.setuid(uid);
}

// Dependencies are parameters so tests can run it without root.
async function main(argv, { env = process.env, prompt = promptHidden, isRoot = () => process.getuid() === 0, becomeHomeBase = dropTo, out = (line) => console.log(line) } = {}) {
  const args = parseArgs(argv);
  if (args.error) { out(args.error); return 2; }
  if (!isRoot()) { out('homebase admin reset must run as root.'); return 1; }
  loadEnvFile(env.HOME_BASE_ENV_FILE || '/etc/sovereign-home/homebase.env', env);
  // The service runs from its code directory (WorkingDirectory=), and default paths are relative to it.
  process.chdir(path.resolve(__dirname, '..'));
  const { loadConfig } = require('../src/config');
  const config = loadConfig(env);
  if (!config.directory) { out('The household directory is off (HOME_BASE_DIRECTORY); there is nothing to reset.'); return 1; }

  const passphrase = await prompt('New admin passphrase: ') ?? '';
  if (passphrase.length < 8) { out('The passphrase must be at least 8 characters.'); return 1; }
  if (await prompt('Repeat it: ') !== passphrase) { out('The passphrases differ; nothing changed.'); return 1; }
  const who = args.administratorLogin ? `${args.administratorLogin} as the next administrator` : 'the same administrator';
  if (await prompt(`Reset Home Base to setup, revoking every administrator credential and session, with ${who}? Type RESET: `) !== 'RESET') {
    out('Nothing changed.');
    return 1;
  }

  // Everything below writes Home Base's own files, so it runs as Home Base: a file root created there
  // would be one Home Base can't write again.
  becomeHomeBase(config.homeBaseRuntimeUser || 'homebase');
  const { SqliteStateStore } = require('../src/state/sqlite-store');
  const { createDirectory } = require('../src/identity/directory');
  const { getCatalog } = require('../src/catalog');
  const { hashPassphrase } = require('../src/admin-auth');
  new SqliteStateStore(config.stateDbPath).init();
  const directory = createDirectory({
    dbPath: config.stateDbPath,
    catalog: getCatalog(),
    household: config.instance,
    snapshotFile: config.identitySnapshotFile,
    log: (line) => out(line),
  });
  directory.init();
  const result = directory.reset({ passphraseHash: hashPassphrase(passphrase), administratorLogin: args.administratorLogin });
  out(`Home Base is in setup. ${result.revokedCredentials} administrator credential(s) revoked; every session and assurance cookie has ended.`);
  out(args.administratorLogin
    ? `Unlock with the new passphrase from ${args.administratorLogin}'s tailnet account to become the administrator.`
    : 'Unlock with the new passphrase from the administrator\'s tailnet account, then enroll new credentials.');
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
    console.error(`homebase: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { createLineReader, main, parseArgs };
