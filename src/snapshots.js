import { randomUUID } from 'node:crypto';

const ttlSeconds = Number.parseInt(process.env.SNAPSHOT_TTL_SECONDS ?? '1800', 10);
const snapshots = new Map();

function now() {
  return Date.now();
}

function cleanupExpired() {
  const ts = now();
  for (const [id, snapshot] of snapshots) {
    if (snapshot.expiresAt <= ts) snapshots.delete(id);
  }
}

const cleanupTimer = setInterval(cleanupExpired, 60_000);
cleanupTimer.unref?.();

export function createSnapshot({ accountId, mailbox, messages, chunkSize }) {
  cleanupExpired();

  const id = randomUUID();
  const createdAt = now();
  const chunks = [];

  for (let i = 0; i < messages.length; i += chunkSize) {
    chunks.push(messages.slice(i, i + chunkSize));
  }

  const snapshot = {
    id,
    accountId,
    mailbox,
    createdAt,
    expiresAt: createdAt + ttlSeconds * 1000,
    chunks,
    processedChunks: new Set(),
  };

  snapshots.set(id, snapshot);
  return snapshot;
}

export function getSnapshot(id) {
  cleanupExpired();
  const snapshot = snapshots.get(id);
  if (!snapshot) throw new Error('Snapshot not found or expired');
  return snapshot;
}

export function getSnapshotChunk(id, chunkNumber) {
  const snapshot = getSnapshot(id);
  const index = chunkNumber - 1;

  if (!Number.isInteger(chunkNumber) || index < 0 || index >= snapshot.chunks.length) {
    throw new Error(`Invalid chunk ${chunkNumber}; snapshot has ${snapshot.chunks.length} chunks`);
  }

  return { snapshot, messages: snapshot.chunks[index] };
}

export function markChunkProcessed(id, chunkNumber) {
  const snapshot = getSnapshot(id);
  snapshot.processedChunks.add(chunkNumber);
}

export function isChunkProcessed(id, chunkNumber) {
  return getSnapshot(id).processedChunks.has(chunkNumber);
}

export function releaseSnapshot(id) {
  return snapshots.delete(id);
}

export function snapshotSummary(snapshot) {
  return {
    snapshot_id: snapshot.id,
    account_id: snapshot.accountId,
    mailbox: snapshot.mailbox,
    message_count: snapshot.chunks.reduce((sum, chunk) => sum + chunk.length, 0),
    chunk_count: snapshot.chunks.length,
    chunk_size: snapshot.chunks[0]?.length ?? 0,
    expires_at: new Date(snapshot.expiresAt).toISOString(),
  };
}
