import path from 'node:path';

export function isTimelapse(name) {
  return typeof name === 'string'
    && /^video_[A-Za-z0-9_-]+\.mp4$/i.test(name)
    && path.posix.basename(name) === name
    && path.win32.basename(name) === name
    && !name.includes('\0');
}

export function remoteSignature(item) {
  const modified = item.rawModifiedAt
    ?? (item.modifiedAt instanceof Date ? item.modifiedAt.toISOString() : item.modifiedAt ?? '');
  return `${item.size}:${modified}`;
}

export function shouldProcess(entry, previous, syncIntervalSeconds) {
  const interval = Number(syncIntervalSeconds);
  return Boolean(previous
    && previous.signature === remoteSignature(entry)
    && Number.isFinite(previous.firstSeenAt)
    && Date.now() - previous.firstSeenAt >= interval * 1000);
}

export function required(name) {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`Missing required environment variable ${name}`);
  return value.trim();
}

export function remoteJoin(remotePath, name) {
  if (!isTimelapse(name)) throw new Error(`Unsafe remote filename: ${name}`);
  return `${remotePath.replace(/\/+$/, '')}/${name}`;
}
