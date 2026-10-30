#!/usr/bin/env node
import { readFile, readdir, mkdir, lstat, mkdtemp, cp, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'skill');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(join(root, 'skill-manifest.json'), 'utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function exists(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function files(path, prefix = '') {
  const result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`심볼릭 링크가 포함되어 있습니다: ${name}`);
    if (entry.isDirectory()) result.push(...await files(join(path, entry.name), name));
    else if (entry.isFile()) result.push(name);
    else throw new Error(`지원하지 않는 파일 형식입니다: ${name}`);
  }
  return result.sort();
}
async function matches(path) {
  const entries = await files(path);
  if (JSON.stringify(entries) !== JSON.stringify(Object.keys(manifest).sort())) return false;
  for (const name of entries) if (digest(await readFile(join(path, name))) !== manifest[name]) return false;
  return true;
}
async function validatePackage() {
  for (const name of Object.keys(manifest)) {
    if (isAbsolute(name) || name.split(/[\\/]/).includes('..')) throw new Error('잘못된 스킬 파일 경로입니다.');
  }
  if (!await matches(source)) throw new Error('패키지의 스킬 파일이 검증 목록과 일치하지 않습니다. 다시 내려받아 주세요.');
}
function help() {
  console.log(`spec-to-ui ${pkg.version}

사용법:
  npx spec-to-ui install              사용자 스킬 폴더에 설치
  npx spec-to-ui install --project    현재 프로젝트에 설치
  npx spec-to-ui status               설치 상태 확인
  npx spec-to-ui install --replace    기존 설치를 백업하고 교체

옵션:
  --project             현재 폴더의 .agents/skills/spec-to-ui 사용
  --target <directory>  지정한 스킬 폴더 사용
  --replace             기존 폴더를 백업한 뒤 교체
  --help                도움말
  --version             버전

설치 후 Codex에서 $spec-to-ui를 호출합니다.
스킬이 목록에 나타나지 않으면 Codex를 다시 시작해 주세요.`);
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) { help(); return; }
  if (args.length === 1 && args[0] === '--version') { console.log(pkg.version); return; }
  const command = args.shift();
  if (!['install', 'status'].includes(command)) throw new Error('install 또는 status 명령을 사용해 주세요.');
  let project = false, replace = false, custom = null;
  while (args.length) {
    const flag = args.shift();
    if (flag === '--project' && !project) project = true;
    else if (flag === '--replace' && !replace) replace = true;
    else if (flag === '--target' && custom === null) {
      custom = args.shift();
      if (!custom || custom.startsWith('--')) throw new Error('--target 뒤에 폴더 경로가 필요합니다.');
    } else throw new Error(`지원하지 않거나 중복된 옵션입니다: ${flag}`);
  }
  if (custom && project) throw new Error('--target과 --project는 함께 사용할 수 없습니다.');
  if (command === 'status' && replace) throw new Error('--replace는 install에만 사용할 수 있습니다.');
  const target = custom ? resolve(custom) : join(project ? process.cwd() : homedir(), '.agents', 'skills', 'spec-to-ui');
  if (target === source || source.startsWith(target + '/') || target.startsWith(source + '/')) throw new Error('패키지 내부를 설치 대상으로 사용할 수 없습니다.');
  await validatePackage();
  const current = await exists(target);
  if (current && (!current.isDirectory() || current.isSymbolicLink())) throw new Error(`설치 대상이 일반 폴더가 아닙니다. 기존 경로를 유지합니다: ${target}`);
  if (command === 'status') {
    console.log(!current ? `설치되지 않았습니다: ${target}` : await matches(target) ? `동일한 스킬이 설치되어 있습니다: ${target}` : `다른 내용의 스킬이 설치되어 있습니다: ${target}`);
    return;
  }
  if (current && await matches(target)) { console.log(`동일한 스킬이 이미 설치되어 있습니다: ${target}`); return; }
  if (current && !replace) throw new Error(`기존 스킬을 유지했습니다: ${target}\n백업 후 교체하려면 --replace를 사용해 주세요.`);
  await mkdir(dirname(target), { recursive: true });
  const stage = await mkdtemp(join(dirname(target), '.spec-to-ui-install-'));
  let backup = null;
  try {
    await cp(source, stage, { recursive: true, force: false });
    if (!await matches(stage)) throw new Error('복사한 파일의 검증에 실패했습니다.');
    if (current) {
      // Backups stay outside the skills directory to avoid duplicate discovery.
      const backupRoot = join(dirname(dirname(target)), 'skill-backups', 'spec-to-ui');
      await mkdir(backupRoot, { recursive: true });
      backup = join(backupRoot, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`);
      await rename(target, backup);
    } else if (await exists(target)) throw new Error('설치 대상이 작업 중 생성되어 설치를 중단했습니다.');
    try { await rename(stage, target); }
    catch (error) { if (backup) await rename(backup, target); throw error; }
  } finally { await rm(stage, { recursive: true, force: true }); }
  console.log(`spec-to-ui ${pkg.version} 설치 완료: ${target}`);
  if (backup) console.log(`이전 스킬 백업: ${backup}`);
  console.log('Codex에서 $spec-to-ui를 호출해 주세요.');
}
try { await main(); }
catch (error) { console.error(`spec-to-ui: ${error.message}`); process.exitCode = 1; }
