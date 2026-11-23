import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {isTimelapse, shouldProcess, remoteSignature, remoteJoin} from '../src/helpers.mjs';
import {loadState, saveState, syncOnce, readConfig, uploadToImmich, cliConfirmedAlbumAssignment} from '../src/sync.mjs';

test('only final MP4 names are selected', () => {
 assert.equal(isTimelapse('video_2026-11-21_20-58-28.mp4'), true);
 assert.equal(isTimelapse('tmp.video'), false);
 assert.equal(isTimelapse('video_2026-11-21_20-58-28.jpg'), false);
 assert.equal(isTimelapse('../video_2026-11-21_20-58-28.mp4'), false);
 assert.equal(isTimelapse('video_test\\evil.mp4'), false);
 assert.equal(remoteJoin('/timelapse', 'video_test.mp4'), '/timelapse/video_test.mp4');
});
test('requires two size-stable observations separated by interval', () => {
 const e={size:123,rawModifiedAt:'Nov 21 20:58'};
 assert.equal(shouldProcess(e,null,300),false);
 assert.equal(shouldProcess(e,{signature:remoteSignature(e),firstSeenAt:Date.now()-301000},300),true);
 assert.equal(shouldProcess({...e,size:124},{signature:remoteSignature(e),firstSeenAt:Date.now()-301000},300),false);
});

test('corrupt state is quarantined and load returns a clean state', async () => {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bambu-state-'));
 const stateFile = path.join(dir, 'state.json');
 await fs.writeFile(stateFile, '{broken');
 const state = await loadState(stateFile);
 assert.deepEqual(state.uploaded, {});
 const files = await fs.readdir(dir);
 assert.ok(files.some(file => file.startsWith('state.json.corrupt-')));
});

test('state save and restart preserve album-assigned status', async () => {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bambu-state-'));
 const stateFile = path.join(dir, 'state.json');
 await saveState(stateFile, {schemaVersion:2,observed:{},uploaded:{'video_test.mp4':{signature:'1:',status:'album-assigned'}},records:{}});
 const state = await loadState(stateFile);
 assert.equal(state.uploaded['video_test.mp4'].status, 'album-assigned');
});

test('startup config rejects unsafe or missing values', () => {
 assert.throws(() => readConfig({BAMBU_HOST:'',BAMBU_ACCESS_CODE:'x',IMMICH_INSTANCE_URL:'http://immich/api',IMMICH_API_KEY:'x'}), /Missing required/);
 assert.throws(() => readConfig({BAMBU_HOST:'printer',BAMBU_ACCESS_CODE:'x',IMMICH_INSTANCE_URL:'not-a-url',IMMICH_API_KEY:'x'}), /absolute HTTP/);
 assert.throws(() => readConfig({BAMBU_HOST:'printer',BAMBU_ACCESS_CODE:'x',IMMICH_INSTANCE_URL:'http://immich/api',IMMICH_API_KEY:'x',BAMBU_REMOTE_PATH:'timelapse'}), /must be absolute/);
});

test('new stable file downloads once and album verification marks it complete', async () => {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bambu-cycle-'));
 const stateFile = path.join(dir, 'state.json');
 const videoDir = path.join(dir, 'videos');
 const entry = {name:'video_2026-11-21_20-58-28.mp4',isFile:true,size:5,rawModifiedAt:'stamp'};
 let uploadArgs;
 const client = {
  async access() {},
  async list() { return [entry]; },
  async downloadTo(partial) { await fs.writeFile(partial, 'hello'); },
  close() {},
 };
 await saveState(stateFile, {schemaVersion:2,observed:{[entry.name]:{signature:remoteSignature(entry),firstSeenAt:Date.now()-11000,status:'stable'}},uploaded:{},records:{}});
 const config = {host:'printer',accessCode:'secret',instanceUrl:'http://immich/api',apiKey:'key',port:990,interval:10,remotePath:'/timelapse',verifyTls:false,deleteLocal:false,albumName:'Test',videoDir,stateFile};
 await syncOnce(config, {
  clientFactory: () => client,
  uploadImpl: async (...args) => { uploadArgs = args; },
  verifyAlbumImpl: async () => true,
 });
 assert.equal((await fs.stat(path.join(videoDir, entry.name))).size, 5);
 assert.equal(uploadArgs[1], 'Test');
 const state = await loadState(stateFile);
 assert.equal(state.uploaded[entry.name].status, 'album-assigned');
});

test('still-growing file is not uploaded and tmp.video is ignored', async () => {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bambu-growing-'));
 const stateFile = path.join(dir, 'state.json');
 const videoDir = path.join(dir, 'videos');
 const entry = {name:'video_test.mp4',isFile:true,size:10,rawModifiedAt:'one'};
 let downloads = 0;
 let uploads = 0;
 const client = {
  async access() {},
  async list() { return [entry, {name:'tmp.video',isFile:true,size:20}]; },
  async downloadTo() { downloads++; },
  close() {},
 };
 const config = {host:'printer',accessCode:'secret',instanceUrl:'http://immich/api',apiKey:'key',port:990,interval:300,remotePath:'/timelapse',verifyTls:false,deleteLocal:false,albumName:'Test',videoDir,stateFile};
 await syncOnce(config,{clientFactory:()=>client,uploadImpl:async()=>{uploads++;},verifyAlbumImpl:async()=>true});
 assert.equal(downloads, 0);
 assert.equal(uploads, 0);
});

test('broken transfer is cleaned and failed upload is retryable', async () => {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bambu-broken-'));
 const stateFile = path.join(dir, 'state.json');
 const videoDir = path.join(dir, 'videos');
 const entry = {name:'video_test.mp4',isFile:true,size:5,rawModifiedAt:'stamp'};
 const client = {
  async access() {},
  async list() { return [entry]; },
  async downloadTo(partial) { await fs.writeFile(partial, 'bad'); },
  close() {},
 };
 await saveState(stateFile, {schemaVersion:2,observed:{[entry.name]:{signature:remoteSignature(entry),firstSeenAt:Date.now()-11000,status:'stable'}},uploaded:{},records:{}});
 const config = {host:'printer',accessCode:'secret',instanceUrl:'http://immich/api',apiKey:'key',port:990,interval:10,remotePath:'/timelapse',verifyTls:false,deleteLocal:false,albumName:'Test',videoDir,stateFile};
 await syncOnce(config,{clientFactory:()=>client,uploadImpl:async()=>{throw new Error('mock upload failure');},verifyAlbumImpl:async()=>true});
 const state = await loadState(stateFile);
 assert.equal(state.records[entry.name].status, 'failed_retryable');
 assert.equal(await fs.stat(path.join(videoDir, `${entry.name}.part`)).catch(()=>null), null);
});

test('remote file changes during transfer are discarded', async () => {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bambu-race-'));
 const stateFile = path.join(dir, 'state.json');
 const videoDir = path.join(dir, 'videos');
 const entry = {name:'video_test.mp4',isFile:true,size:5,rawModifiedAt:'old'};
 const changed = {...entry,rawModifiedAt:'new',size:6};
 let listCount = 0;
 const client = {
  async access() {},
  async list() { listCount++; return listCount === 1 ? [entry] : [changed]; },
  async downloadTo(partial) { await fs.writeFile(partial, 'hello'); },
  close() {},
 };
 await saveState(stateFile, {schemaVersion:2,observed:{[entry.name]:{signature:remoteSignature(entry),firstSeenAt:Date.now()-11000,status:'stable'}},uploaded:{},records:{}});
 const config = {host:'printer',accessCode:'secret',instanceUrl:'http://immich/api',apiKey:'key',port:990,interval:10,remotePath:'/timelapse',verifyTls:false,deleteLocal:false,albumName:'Test',videoDir,stateFile};
 let uploads = 0;
 await syncOnce(config,{clientFactory:()=>client,uploadImpl:async()=>{uploads++;},verifyAlbumImpl:async()=>true});
 assert.equal(uploads, 0);
 assert.equal(await fs.stat(path.join(videoDir, entry.name)).catch(()=>null), null);
});

test('offline printer cycle is retryable and does not crash state', async () => {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bambu-offline-'));
 const config = {host:'offline',accessCode:'secret',instanceUrl:'http://immich/api',apiKey:'key',port:990,interval:10,remotePath:'/timelapse',verifyTls:false,deleteLocal:false,albumName:'Test',videoDir:path.join(dir,'videos'),stateFile:path.join(dir,'state.json')};
 const client = {async access(){throw new Error('printer offline');},close(){}};
 await assert.rejects(() => syncOnce(config,{clientFactory:()=>client}), /printer offline/);
});

test('Immich CLI receives safe argument array and supported album flag', async () => {
 const child = new EventEmitter();
 child.stdout = new EventEmitter();
 child.stderr = new EventEmitter();
 let args;
 const spawnImpl = (_command, commandArgs) => {
  args = commandArgs;
  queueMicrotask(() => child.emit('close', 0));
  return child;
 };
 await uploadToImmich('/data/videos/video_test.mp4', '3D P2S Zeitraffer', spawnImpl);
 assert.deepEqual(args, ['upload','--album-name','3D P2S Zeitraffer','--no-progress','/data/videos/video_test.mp4']);
});

test('CLI duplicate/album update explicitly confirms album assignment', () => {
 assert.equal(cliConfirmedAlbumAssignment({stdout:'Found 0 new files and 1 duplicate\nSuccessfully updated 1 asset'}), true);
 assert.equal(cliConfirmedAlbumAssignment({stdout:'Upload failed'}), false);
});
