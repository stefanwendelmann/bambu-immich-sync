import { Client } from 'basic-ftp';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { isTimelapse, remoteSignature, remoteJoin, required, shouldProcess } from './helpers.mjs';

export function structuredLog(stage, data = {}) {
  const safe = Object.fromEntries(Object.entries(data).filter(([key]) =>
    !/key|secret|password|code/i.test(key)));
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    stage,
    ...safe,
  }));
}

export async function loadState(stateFile) {
  try {
    const text = await fs.readFile(stateFile, 'utf8');
    const state = JSON.parse(text);
    state.schemaVersion ||= 2;
    state.observed ||= {};
    state.uploaded ||= {};
    state.records ||= {};
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: 2, observed: {}, uploaded: {}, records: {} };
    if (error instanceof SyntaxError) {
      await fs.rename(stateFile, `${stateFile}.corrupt-${Date.now()}`);
      structuredLog('state_recovered', { reason: 'invalid_json' });
      return { schemaVersion: 2, observed: {}, uploaded: {}, records: {} };
    }
    throw error;
  }
}

export async function saveState(stateFile, state) {
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  const temp = `${stateFile}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await fs.rename(temp, stateFile);
}

export function uploadToImmich(file, albumName, spawnImpl = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl('immich', [
      'upload',
      '--album-name', albumName,
      '--no-progress',
      file,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Immich CLI exited ${code}: ${stderr.trim().slice(0, 500)}`));
    });
  });
}

export async function verifyAlbumMembership(instanceUrl, apiKey, albumName, filename, fetchImpl = fetch) {
  const base = instanceUrl.replace(/\/+$/, '');
  const headers = { 'x-api-key': apiKey, accept: 'application/json' };
  const albumsResponse = await fetchImpl(`${base}/albums`, { headers });
  if (!albumsResponse.ok) throw new Error(`Immich album lookup failed (${albumsResponse.status})`);
  const albums = await albumsResponse.json();
  const album = Array.isArray(albums) ? albums.find(item => item.albumName === albumName) : undefined;
  if (!album) throw new Error(`Immich album "${albumName}" was not found after upload`);
  const detailResponse = await fetchImpl(`${base}/albums/${encodeURIComponent(album.id)}`, { headers });
  if (!detailResponse.ok) throw new Error(`Immich album detail failed (${detailResponse.status})`);
  const detail = await detailResponse.json();
  const found = Array.isArray(detail.assets) && detail.assets.some(asset =>
    asset.originalFileName === filename
    || asset.originalPath?.endsWith(`/${filename}`)
  );
  if (!found) throw new Error(`Immich album "${albumName}" does not contain ${filename}`);
  return true;
}

export function cliConfirmedAlbumAssignment(result) {
  const output = `${result?.stdout || ''}\n${result?.stderr || ''}`;
  return /Successfully updated [1-9]\d* assets?/i.test(output)
    || /Successfully uploaded [1-9]\d* assets?/i.test(output);
}

export async function syncOnce(config, dependencies = {}) {
  const client = dependencies.clientFactory ? dependencies.clientFactory() : new Client(30000);
  await fs.mkdir(config.videoDir, { recursive: true });
  const state = await loadState(config.stateFile);
  try {
    await client.access({
      host: config.host,
      port: config.port,
      user: 'bblp',
      password: config.accessCode,
      secure: 'implicit',
      secureOptions: {
        host: config.host,
        servername: config.host,
        rejectUnauthorized: config.verifyTls,
        minVersion: 'TLSv1.2',
        maxVersion: 'TLSv1.2',
      },
    });

    const entries = (await client.list(config.remotePath))
      .filter(entry => entry.isFile && isTimelapse(entry.name));
    structuredLog('discovered', { count: entries.length });

    for (const entry of entries) {
      const name = entry.name;
      const signature = remoteSignature(entry);
      const existing = state.observed[name];
      const ready = shouldProcess(entry, existing, config.interval);

      if (!existing || existing.signature !== signature) {
        state.observed[name] = { signature, firstSeenAt: Date.now(), status: 'discovered' };
        await saveState(config.stateFile, state);
      }
      state.records[name] = { ...(state.records[name] || {}), status: existing?.status === 'stable' ? 'stable' : 'discovered' };
      await saveState(config.stateFile, state);

      if (!ready) continue;
      state.observed[name].status = 'stable';
      state.records[name].status = 'stable';
      await saveState(config.stateFile, state);
      if (state.uploaded[name]?.status === 'album-assigned'
        && state.uploaded[name].signature === signature) continue;

      const destination = path.join(config.videoDir, name);
      const partial = `${destination}.part`;
      try {
        let localSize = -1;
        try { localSize = (await fs.stat(destination)).size; } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        if (localSize !== entry.size) {
          await fs.rm(partial, { force: true });
          await client.downloadTo(partial, remoteJoin(config.remotePath, name));
          const downloadedSize = (await fs.stat(partial)).size;
          if (downloadedSize !== entry.size) {
            throw new Error(`Downloaded size ${downloadedSize} differs from listed size ${entry.size}`);
          }
          const postEntries = await client.list(config.remotePath);
          const postEntry = postEntries.find(item => item.isFile && item.name === name);
          if (!postEntry) throw new Error('Remote file disappeared before transfer validation');
          if (remoteSignature(postEntry) !== signature) {
            state.observed[name] = { signature: remoteSignature(postEntry), firstSeenAt: Date.now(), status: 'discovered' };
            state.records[name].status = 'failed_retryable';
            await saveState(config.stateFile, state);
            throw new Error('Remote file changed during download; transfer discarded');
          }
          await fs.rename(partial, destination);
          state.records[name].status = 'downloaded';
          await saveState(config.stateFile, state);
        }

        structuredLog('upload_start', { filename: name, album: config.albumName });
        const uploadResult = await (dependencies.uploadImpl
          ? dependencies.uploadImpl(destination, config.albumName)
          : uploadToImmich(destination, config.albumName));

        let albumConfirmed = false;
        try {
          await (dependencies.verifyAlbumImpl
            ? dependencies.verifyAlbumImpl(config.instanceUrl, config.apiKey, config.albumName, name)
            : verifyAlbumMembership(config.instanceUrl, config.apiKey, config.albumName, name));
          albumConfirmed = true;
        } catch (error) {
          if (cliConfirmedAlbumAssignment(uploadResult)) albumConfirmed = true;
          else throw error;
        }
        if (!albumConfirmed) throw new Error(`Immich album "${config.albumName}" could not be confirmed`);

        state.uploaded[name] = { signature, status: 'album-assigned', uploadedAt: Date.now() };
        state.records[name].status = 'album-assigned';
        await saveState(config.stateFile, state);
        if (config.deleteLocal) await fs.rm(destination, { force: true });
        structuredLog('upload_complete', { filename: name, album: config.albumName });
      } catch (error) {
        await fs.rm(partial, { force: true });
        state.records[name] = { ...(state.records[name] || {}), status: 'failed_retryable', error: error.message };
        await saveState(config.stateFile, state);
        structuredLog('file_failed', { filename: name, error: error.message });
      }
    }
  } finally {
    client.close();
  }
}

export function readConfig(env = process.env) {
  const host = requiredEnv(env, 'BAMBU_HOST');
  const accessCode = requiredEnv(env, 'BAMBU_ACCESS_CODE');
  const instanceUrl = requiredEnv(env, 'IMMICH_INSTANCE_URL');
  const apiKey = requiredEnv(env, 'IMMICH_API_KEY');
  const port = Number(env.BAMBU_FTPS_PORT || 990);
  const interval = Number(env.SYNC_INTERVAL || 300);
  const remotePath = env.BAMBU_REMOTE_PATH || '/timelapse';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('BAMBU_FTPS_PORT must be a valid TCP port');
  if (!Number.isInteger(interval) || interval < 10) throw new Error('SYNC_INTERVAL must be an integer >= 10');
  if (!remotePath.startsWith('/')) throw new Error('BAMBU_REMOTE_PATH must be absolute');
  let parsedUrl;
  try { parsedUrl = new URL(instanceUrl); } catch { throw new Error('IMMICH_INSTANCE_URL must be an absolute HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('IMMICH_INSTANCE_URL must use HTTP or HTTPS');
  const dataDir = env.DATA_DIR || '/data';
  return {
    host, accessCode, instanceUrl, apiKey, port, interval, remotePath,
    verifyTls: env.BAMBU_TLS_VERIFY === 'true',
    deleteLocal: env.DELETE_LOCAL_AFTER_UPLOAD === 'true',
    albumName: env.IMMICH_ALBUM_NAME || 'Bambu Lab Timelapses',
    dataDir,
    videoDir: path.join(dataDir, 'videos'),
    stateFile: path.join(dataDir, 'state.json'),
  };
}

function requiredEnv(env, name) {
  const value = env[name];
  if (!value?.trim()) throw new Error(`Missing required environment variable ${name}`);
  return value.trim();
}

async function main() {
  let config;
  try { config = readConfig(); } catch (error) {
    structuredLog('startup_failed', { error: error.message });
    process.exitCode = 1;
    return;
  }
  await fs.mkdir(config.dataDir, { recursive: true });
  let stopping = false;
  process.on('SIGTERM', () => { stopping = true; structuredLog('shutdown_requested', { signal: 'SIGTERM' }); });
  process.on('SIGINT', () => { stopping = true; structuredLog('shutdown_requested', { signal: 'SIGINT' }); });

  const once = process.env.RUN_ONCE === 'true';
  do {
    try { await syncOnce(config); }
    catch (error) {
      structuredLog('sync_cycle_failed', { error: error.message });
      if (once) process.exitCode = 1;
    }
    if (once || stopping) break;
    for (let elapsed = 0; elapsed < config.interval && !stopping; elapsed++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } while (!stopping);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) await main();
