#!/usr/bin/env node
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const version = '0.2.0';
const defaultMarketplace = 'suminkim8203/spec-to-ui';
const installId = 'spec-to-ui@spec-to-ui';

function files(folder) {
  const result = [];
  for (const name of readdirSync(folder).sort()) {
    const path = join(folder, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error('Symbolic link is not permitted: ' + relative(root, path));
    if (stat.isDirectory()) result.push(...files(path));
    else if (stat.isFile()) result.push(relative(root, path).split('\\').join('/'));
    else throw new Error('Unexpected file type: ' + relative(root, path));
  }
  return result.sort();
}

function checkBundle() {
  const manifest = JSON.parse(readFileSync(join(root, 'bundle-manifest.json'), 'utf8'));
  if (manifest.version !== version || !manifest.sha256 || typeof manifest.sha256 !== 'object') {
    throw new Error('Invalid bundle manifest');
  }
  for (const [path, expected] of Object.entries(manifest.sha256)) {
    if (!path || isAbsolute(path) || path.includes('\\') || path.split('/').some(p => p === '..' || p === '.')) {
      throw new Error('Invalid manifest path');
    }
    const full = join(root, path);
    if (!lstatSync(full).isFile() || lstatSync(full).isSymbolicLink()) throw new Error('Invalid bundle file: ' + path);
    const actual = createHash('sha256').update(readFileSync(full)).digest('hex');
    if (actual !== expected) throw new Error('Bundle file differs: ' + path);
  }
  const listed = Object.keys(manifest.sha256).filter(p => p.startsWith('skills/')).sort();
  const actual = files(join(root, 'skills'));
  if (JSON.stringify(listed) !== JSON.stringify(actual)) throw new Error('Skill file list differs');
  const plugin = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8'));
  if (plugin.name !== 'spec-to-ui' || plugin.version !== version) throw new Error('Plugin identity differs');
  return { version, skillFiles: listed.length, skills: readdirSync(join(root, 'skills')).sort() };
}

function help() {
  process.stdout.write(`spec-to-ui ${version}\n\nUsage:\n  spec-to-ui install [--codex <binary>] [--marketplace <source>] [--dry-run]\n  spec-to-ui status [--codex <binary>] [--dry-run]\n  spec-to-ui check\n  spec-to-ui --version\n\nInstall registers the marketplace and installs the spec-to-ui plugin through Codex.\nThe existing standalone skill and development plugin are not replaced.\nDefault marketplace: ${defaultMarketplace}\nRequires Node.js 22+ and a Codex version with plugin support.\nPython 3 is needed for companion search tools.\nOld --target, --project and --replace options are not supported by the plugin installer.\n`);
}

function main() {
  const args = process.argv.slice(2);
  if (!args.length || (args.length === 1 && ['--help', '-h', 'help'].includes(args[0]))) return help();
  if (args.length === 1 && ['--version', '-v'].includes(args[0])) return process.stdout.write(version + '\n');
  const command = args.shift();
  if (!['install', 'status', 'check'].includes(command)) throw new Error('Unknown command: ' + command);
  const options = { codex: 'codex', marketplace: defaultMarketplace, dryRun: false };
  const seen = new Set();
  while (args.length) {
    const flag = args.shift();
    if (seen.has(flag)) throw new Error('Duplicate option: ' + flag);
    seen.add(flag);
    if (flag === '--dry-run' && command !== 'check') options.dryRun = true;
    else if (flag === '--codex' && command !== 'check') {
      const value = args.shift();
      if (!value || value.startsWith('--')) throw new Error('Missing value: ' + flag);
      options.codex = value;
    } else if (flag === '--marketplace' && command === 'install') {
      const value = args.shift();
      if (!value || value.startsWith('--')) throw new Error('Missing value: ' + flag);
      options.marketplace = value;
    } else throw new Error('Unsupported option for ' + command + ': ' + flag);
  }
  const bundle = checkBundle();
  if (command === 'check') return process.stdout.write(JSON.stringify({ ok: true, ...bundle }, null, 2) + '\n');
  const commands = command === 'install'
    ? [['plugin', 'marketplace', 'add', options.marketplace, '--json'], ['plugin', 'add', installId, '--json']]
    : [['plugin', 'list', '--json']];
  if (options.dryRun) return process.stdout.write(JSON.stringify({ dryRun: true, commands: commands.map(args => ({ executable: options.codex, args })) }, null, 2) + '\n');
  for (const args of commands) {
    const result = spawnSync(options.codex, args, { stdio: 'inherit', shell: false });
    if (result.error) throw new Error('Could not start Codex: ' + result.error.message + '. Use --codex <binary> to select your CLI.');
    if (result.status !== 0) throw new Error('Codex command failed' + (result.signal ? ' (' + result.signal + ')' : ' with exit code ' + result.status));
  }
  if (command === 'install') process.stdout.write('Installed via Codex. Start a new session and call $spec-to-ui:spec-to-ui.\n');
}

try { main(); } catch (error) { process.stderr.write('spec-to-ui: ' + error.message + '\n'); process.exitCode = 1; }
