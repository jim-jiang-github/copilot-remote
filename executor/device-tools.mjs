import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { lstat, readdir, realpath, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { identifier } from './core.mjs';
import { loadJson, saveJson } from './storage.mjs';

const LIMIT = 512 * 1024;

function contained(root, path) {
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Path is outside the configured device root');
  }
  return path;
}

export async function devicePath(root, value, writing = false) {
  if (typeof value !== 'string' || !value || value.includes('\0') || isAbsolute(value)) {
    throw new Error('Use a nonempty path relative to the configured device root');
  }
  const candidate = contained(root, resolve(root, value));
  try {
    const info = await lstat(candidate);
    if (info.isSymbolicLink()) throw new Error('Symbolic link targets are not supported');
    return contained(root, await realpath(candidate));
  } catch (error) {
    if (!writing || error.code !== 'ENOENT') throw error;
    contained(root, await realpath(dirname(candidate)));
    return candidate;
  }
}

async function stopTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const script = '$ErrorActionPreference="Stop"; function StopTree([int]$targetId) { '
      + 'Get-CimInstance Win32_Process -Filter ("ParentProcessId="+$targetId) | '
      + 'ForEach-Object { StopTree $_.ProcessId }; '
      + 'if (Get-Process -Id $targetId -ErrorAction SilentlyContinue) { Stop-Process -Id $targetId -Force } }; '
      + `StopTree ${child.pid}`;
    await new Promise((resolveStop, reject) => {
      const stopper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let errorText = '';
      stopper.stderr.on('data', (chunk) => { errorText += chunk.toString().slice(0, 4096); });
      stopper.on('error', reject);
      stopper.on('close', (code) => code === 0 ? resolveStop()
        : reject(new Error(`Process tree cleanup failed: ${errorText}`)));
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

export function runProcess(executable, args, cwd, timeoutMs, signal, onOutput = () => {}) {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(executable, args, {
      cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', bytes = 0, failure;
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    let cleanup = Promise.resolve();
    let stopping = false;
    const stop = (message) => {
      if (stopping) return;
      stopping = true;
      failure = new Error(message);
      cleanup = stopTree(child);
      cleanup.catch((error) => { failure = error; child.kill(); });
    };
    const timer = setTimeout(() => stop('Process timed out and was stopped'), timeoutMs);
    const abort = () => stop('Device stopping; process cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const output = (name, chunk) => {
      bytes += chunk.length;
      if (bytes > LIMIT) { stop('Process output exceeded 512 KiB and was stopped'); return; }
      const text = decoders[name].write(chunk);
      if (name === 'stdout') stdout += text;
      else stderr += text;
      if (text) onOutput(name, text);
    };
    child.stdout.on('data', (chunk) => output('stdout', chunk));
    child.stderr.on('data', (chunk) => output('stderr', chunk));
    child.on('error', (error) => { failure = error; });
    child.on('close', async (exitCode, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      try {
        await cleanup;
        stdout += decoders.stdout.end();
        stderr += decoders.stderr.end();
        if (failure) reject(failure);
        else resolveProcess({ exitCode, signal: exitSignal, stdout, stderr });
      } catch (error) { reject(error); }
    });
  });
}

export class DeviceTools {
  constructor({ root, directory, approve, executables = [], onOutput = () => {} }) {
    this.root = root;
    this.directory = directory;
    this.approve = approve;
    this.executables = executables;
    this.onOutput = onOutput;
    this.queue = Promise.resolve();
    this.abortController = new AbortController();
    this.active = new Map();
    this.cancelGeneration = new Map();
  }

  async initialize() {
    this.root = await realpath(this.root);
    this.executables = await Promise.all(this.executables.map(async (path) => {
      if (!isAbsolute(path)) throw new Error('Allowed executables must be absolute paths');
      return realpath(path);
    }));
    this.ledgerPath = join(this.directory, 'requests.json');
    this.ledger = await loadJson(this.ledgerPath, {});
  }

  execute(command) {
    const generation = this.cancelGeneration.get(command?.sessionId) || 0;
    const next = this.queue.then(() => this.perform(command, generation));
    this.queue = next.catch(() => {});
    return next;
  }

  async perform(command, generation) {
    identifier(command.requestId);
    if (this.abortController.signal.aborted) throw new Error('Device stopping');
    const hash = createHash('sha256').update(JSON.stringify(command)).digest('hex');
    if (Object.hasOwn(this.ledger, command.requestId)) {
      const previous = this.ledger[command.requestId];
      if (previous.hash !== hash) throw new Error('Request ID reused with different content');
      return previous;
    }
    const entry = { hash, status: 'uncertain' };
    this.ledger[command.requestId] = entry;
    await saveJson(this.ledgerPath, this.ledger);
    const controller = new AbortController();
    this.active.set(command.requestId, { sessionId: command.sessionId, controller });
    const signal = AbortSignal.any([controller.signal, this.abortController.signal]);
    try {
      if (generation !== (this.cancelGeneration.get(command.sessionId) || 0)) {
        throw new Error('Queued request cancelled before execution');
      }
      if (!['info', 'list', 'read', 'write', 'exec'].includes(command.tool)) throw new Error('Unknown remote tool');
      if (!await this.approve(command, signal)) throw new Error('Device owner denied this request');
      if (signal.aborted) throw new Error('Request cancelled before execution');
      const args = command.args || {};
      switch (command.tool) {
        case 'info':
          entry.result = { platform: process.platform, root: this.root,
            tools: ['info', 'list', 'read', 'write', 'exec'], executables: this.executables,
            limitations: ['No desktop/browser automation', 'No interactive PTY', 'Not an OS sandbox'] };
          break;
        case 'list': {
          const path = await devicePath(this.root, args.path);
          const names = await readdir(path, { withFileTypes: true });
          if (names.length > 2000) throw new Error('Directory exceeds 2000 entries');
          entry.result = names.map((name) => ({ name: name.name,
            kind: name.isSymbolicLink() ? 'symlink' : name.isDirectory() ? 'directory' : 'file' }));
          break;
        }
        case 'read': {
          const path = await devicePath(this.root, args.path);
          const stat = await lstat(path);
          if (!stat.isFile() || stat.size > LIMIT) throw new Error('Read requires a regular file <=512 KiB');
          const content = await readFile(path);
          if (content.length > LIMIT) throw new Error('File grew beyond the read limit');
          entry.result = { content: content.toString('utf8') };
          break;
        }
        case 'write': {
          if (typeof args.content !== 'string' || Buffer.byteLength(args.content) > LIMIT) {
            throw new Error('Write requires UTF-8 content <=512 KiB');
          }
          const path = await devicePath(this.root, args.path, true);
          try {
            if (!(await lstat(path)).isFile()) throw new Error('Write requires a regular file');
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
          await writeFile(path, args.content, { mode: 0o600 });
          entry.result = { written: Buffer.byteLength(args.content) };
          break;
        }
        case 'exec': {
          if (typeof args.executable !== 'string' || !isAbsolute(args.executable)) {
            throw new Error('Executable must be an absolute path from device_info');
          }
          const executable = await realpath(args.executable);
          if (!this.executables.includes(executable)) throw new Error('Executable is not allowed by device owner');
          if (!Array.isArray(args.args) || args.args.length > 100
            || args.args.some((arg) => typeof arg !== 'string' || arg.includes('\0') || arg.length > 10_000)) {
            throw new Error('Invalid argument array');
          }
          const timeout = args.timeoutMs ?? 30_000;
          if (!Number.isInteger(timeout) || timeout < 100 || timeout > 120_000) {
            throw new Error('Timeout must be 100..120000 milliseconds');
          }
          const cwd = await devicePath(this.root, args.cwd || '.');
          entry.result = await runProcess(executable, args.args, cwd, timeout, signal,
            (stream, text) => this.onOutput(command, stream, text));
          break;
        }
      }
      entry.status = 'completed';
    } catch (error) {
      entry.status = 'failed';
      entry.error = error.message;
    } finally {
      this.active.delete(command.requestId);
    }
    await saveJson(this.ledgerPath, this.ledger);
    return entry;
  }

  async close() {
    this.abortController.abort();
    await this.queue;
  }

  cancelSession(sessionId) {
    identifier(sessionId);
    this.cancelGeneration.set(sessionId, (this.cancelGeneration.get(sessionId) || 0) + 1);
    let cancelled = 0;
    for (const operation of this.active.values()) {
      if (operation.sessionId === sessionId) {
        operation.controller.abort();
        cancelled++;
      }
    }
    return { cancelled, queuedRequestsCancelled: true };
  }
}
