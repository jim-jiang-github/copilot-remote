import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function lockDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, 'lock');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`State directory locked: ${lock}. Stop its owner before removing a stale lock.`);
    }
    throw error;
  }
  await writeFile(join(lock, 'pid'), String(process.pid), { mode: 0o600 });
  return () => rm(lock, { recursive: true });
}

export async function loadJson(path, initial) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return initial;
    throw error;
  }
}

export async function saveJson(path, value) {
  await writeFile(`${path}.tmp`, JSON.stringify(value), { mode: 0o600, flush: true });
  await rename(`${path}.tmp`, path);
  if (process.platform !== 'win32') {
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
}
