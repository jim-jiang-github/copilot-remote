import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] || 'device';
if (!['device', 'relay'].includes(target)) {
  throw new Error('Build target must be device or relay.');
}
const output = resolve(root, 'dist', `${target}.exe`);
const version = process.versions.node.split('.').map(Number);

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('Build the Windows x64 executor apps on Windows x64.');
}
if (version[0] < 22 || (version[0] === 22 && version[1] < 12)) {
  throw new Error('Node.js 22.12 or later is required to build the executor apps.');
}

async function binary(packageName, command) {
  const packageJson = JSON.parse(await readFile(
    join(root, 'node_modules', packageName, 'package.json'), 'utf8'));
  const entry = typeof packageJson.bin === 'string'
    ? packageJson.bin : packageJson.bin?.[command];
  if (!entry) throw new Error(`Could not find ${command} executable in ${packageName}`);
  return resolve(root, 'node_modules', packageName, entry);
}

function run(executable, args) {
  const result = spawnSync(executable, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable} failed with exit code ${result.status}`);
}

const temporary = await mkdtemp(join(tmpdir(), 'copilot-executor-sea-'));
try {
  const bundle = join(temporary, `${target}.cjs`);
  const blob = join(temporary, 'sea.blob');
  const config = join(temporary, 'sea-config.json');
  run(process.execPath, [
    await binary('esbuild', 'esbuild'),
    join(root, `${target}-cli.mjs`),
    '--bundle', '--platform=node', '--format=cjs', '--target=node22',
    '--define:process.env.WS_NO_BUFFER_UTIL=true',
    '--define:process.env.WS_NO_UTF_8_VALIDATE=true',
    '--define:import.meta.url=""',
    `--outfile=${bundle}`,
  ]);
  await writeFile(config, JSON.stringify({ main: bundle, output: blob }));
  run(process.execPath, ['--experimental-sea-config', config]);

  await mkdir(dirname(output), { recursive: true });
  await copyFile(process.execPath, output);
  run(process.execPath, [
    await binary('postject', 'postject'),
    output, 'NODE_SEA_BLOB', blob,
    '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ]);
  console.log(`Built ${output}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
