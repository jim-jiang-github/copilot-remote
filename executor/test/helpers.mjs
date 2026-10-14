import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { Peer } from '../wire.mjs';
import { createRelay } from '../relay.mjs';

export async function temporary(t) {
  const parent = resolve('.executor');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'test-'));
  return directory;
}

export function cleanupTemporary(t, directory) {
  t.after(() => rm(directory, { recursive: true }));
}

export function secrets() {
  return Object.fromEntries(['agent', 'device', 'operator'].map((role) => [role, randomBytes(32).toString('base64url')]));
}

export async function network(t) {
  const tokens = secrets();
  const relay = createRelay({ secrets: tokens, port: 0 });
  const address = await relay.start();
  const url = `ws://127.0.0.1:${address.port}`;
  const peers = {};
  t.after(async () => {
    for (const peer of Object.values(peers)) peer.close();
    await relay.close();
  });
  for (const role of ['agent', 'device', 'operator']) {
    const peer = new Peer({ url, role, secret: tokens[role], timeout: 5000 });
    peers[role] = peer;
    peer.on('fault', () => {});
    const ready = once(peer, 'ready');
    peer.connect();
    await ready;
  }
  while (Object.values(peers).some((peer) => peer.peers.length !== 3)) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  return { relay, peers, tokens, url };
}
