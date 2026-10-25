import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { queue, refreshPresence, advance, settlePlayback } from '../room.js';
import { positionAt, playablePosition, playbackLabel } from '../public/session.js';
import { youtubeError, createYoutubeLoader } from '../public/youtube.js';
import { createHandler as createRealHandler, videoId } from '../lib/handler.js';
import { verifyMusicVideo } from '../lib/songs.js';
import { createRoomStore, createRedisBackend, COMPARE_AND_SET } from '../lib/storage.js';
import { recordReflection, reflectionSnapshot } from '../lib/reflections.js';
import { summarizeReflections, rememberReport, readReports, REPORT_STORAGE_KEY } from '../public/reflections.js';

// Playback/voting tests isolate admission; admission tests below use the real verifier.
const testTitles = new Map();
function createHandler(storeProvider, youtubeFetch) {
  return createRealHandler(storeProvider, youtubeFetch, {
    requestIntervalSeconds: 0,
    verifySong: async id => ({ title: testTitles.get(id) || '검증된 곡', artist: '검증된 채널', channelId: 'test-channel' }),
  });
}
function musicVideo(id = 'abcdefghijk', overrides = {}) {
  return { id, snippet: { categoryId: '10', title: 'YouTube에서 확인한 제목', channelId: 'UCverified', channelTitle: '확인한 채널', liveBroadcastContent: 'none' }, status: { privacyStatus: 'public', embeddable: true, uploadStatus: 'processed' }, ...overrides };
}
function client(base) {
  let cookie = '';
  return { async call(path, data, headers = {}) {
    if (path.endsWith('/songs') && data) testTitles.set(videoId(data.videoId || data.url), data.title);
    const response = await fetch(base + path, { method: data === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, data: await response.json() };
  } };
}
async function attachPlayer(host, path, songId, sessionId = 'test-player-session-0001') {
  const attached = await host.call(path + '/control', { command: 'attach', songId, sessionId });
  assert.equal(attached.status, 200);
  let sequence = 0;
  return (command, details = {}) => host.call(path + '/control', { command, songId, sessionId, revision: attached.data.playback.revision, sequence: ++sequence, ...details });
}

async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
function emulator() {
  const records = new Map(), commands = [];
  let clock = Date.now(), conflicts = 0;
  function get(key) { const value = records.get(key); if (!value || value.until <= clock) { records.delete(key); return null; } return value.value; }
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'https://redis.example.test/');
    assert.equal(options.headers.Authorization, 'Bearer test-private-token');
    const args = JSON.parse(options.body); commands.push(args);
    const [command, key, value] = args; let result;
    if (command === 'GET') result = get(key);
    else if (command === 'SET') {
      if (args.includes('NX') && get(key) !== null) result = null;
      else { records.set(key, { value, until: clock + args.at(-1) * 1000 }); result = 'OK'; }
    } else if (command === 'EVAL') {
      assert.equal(args[1], COMPARE_AND_SET); assert.equal(args[2], 1);
      const [, , , roomKey, before, after, ttl] = args;
      if (get(roomKey) === null) result = -1;
      else if (get(roomKey) !== before) { conflicts++; result = 0; }
      else { if (after === '') records.delete(roomKey); else records.set(roomKey, { value: after, until: ttl === 'KEEP' ? records.get(roomKey).until : clock + ttl * 1000 }); result = 1; }
    } else assert.fail('Unexpected Redis command');
    await new Promise(resolve => setTimeout(resolve, 1));
    return { ok: true, json: async () => ({ result }) };
  };
  return { commands, records, tick(ms) { clock += ms; }, get conflicts() { return conflicts; }, backend() { return createRedisBackend({ url: 'https://redis.example.test', token: 'test-private-token', prefix: 'test:production', fetchImpl }); } };
}

test('방 확인이 성공해야 화면과 URL을 전환하고 실패하면 입장 화면을 유지한다', async () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const enterSource = source.slice(source.indexOf('async function enterRoom(code)'), source.indexOf('\nfunction landing()'));
  for (const outcome of ['success', 'missing', 'network']) {
    const buttons = [{ disabled: false }, { disabled: false }];
    const events = [];
    let resolve, reject;
    const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
    const context = {
      roomId: null, initialRoomId: null,
      $: selector => selector === '#code-form button' ? buttons[0] : buttons[1],
      request: (...args) => { events.push(['request', ...args]); return pending; },
      history: { replaceState: (...args) => events.push(['url', args[2]]) },
      shell: () => events.push(['shell']), accept: result => events.push(['accept', result.id]),
      notify: message => events.push(['notice', message]),
    };
    runInNewContext(enterSource, context);
    const entering = context.enterRoom('123456');
    await context.enterRoom('654321'); // Ignore repeated submissions during verification.
    assert.equal(context.roomId, null);
    assert.deepEqual(events, [['request', '', undefined, false, '123456']]);
    assert.ok(buttons.every(button => button.disabled));
    if (outcome === 'success') resolve({ id: '123456' });
    else reject(Object.assign(new Error('연결 실패'), { status: outcome === 'missing' ? 404 : 503 }));
    await entering;
    assert.ok(buttons.every(button => !button.disabled));
    assert.equal(context.enterRoom.busy, false);
    if (outcome === 'success') {
      assert.equal(context.roomId, '123456');
      assert.deepEqual(events.slice(1), [['url', '?room=123456'], ['shell'], ['accept', '123456']]);
    } else {
      assert.equal(context.roomId, null);
      assert.deepEqual(events.slice(1), [['notice', outcome === 'missing' ? '방이 없거나 비어 있어 삭제됐어요. 코드를 다시 확인해 주세요.' : '연결 실패']]);
    }
  }
});

test('신청자가 같아도 점수를 우선하고 동점은 등록순으로 정렬한다', () => {
  const room = { members: [{ id: 'one' }, { id: 'two' }], votes: { one: { a: 1, b: 1 }, two: { c: -1 } }, songs: [{ id: 'a', addedBy: 'one', createdAt: 1 }, { id: 'b', addedBy: 'one', createdAt: 2 }, { id: 'c', addedBy: 'two', createdAt: 3 }], lastRequester: null };
  assert.deepEqual(queue(room).map(s => s.id), ['a', 'b', 'c']);
  room.lastRequester = 'one'; assert.deepEqual(queue(room).map(s => s.id), ['a', 'b', 'c']);
});

test('로컬: 6자리 코드·즉시 재생·한 표·과반 전환·퇴장 삭제', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sai-test-'));
  process.env.DATA_DIR = dir; process.env.NODE_ENV = 'test';
  for (const key of ['YOUTUBE_API_KEY', 'VERCEL', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN']) delete process.env[key];
  const { createDevServer } = await import('../dev-server.js');
  const server = createDevServer(createHandler());
  const base = await listen(t, server);
  const tonearm = await fetch(base + '/tonearm.svg');
  assert.equal(tonearm.status, 200);
  assert.match(tonearm.headers.get('content-type'), /^image\/svg\+xml/);
  assert.equal(await tonearm.text(), readFileSync(new URL('../public/tonearm.svg', import.meta.url), 'utf8'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = client(base), a = client(base), b = client(base), stranger = client(base);
  const created = await host.call('/api/rooms', { title: '오후의 작업실', name: '재생 기기' });
  assert.equal(created.status, 201); assert.match(created.data.id, /^\d{6}$/); assert.equal(created.data.isPlayer, undefined);
  assert.equal(created.data.hostKey, undefined);
  const path = '/api/rooms/' + created.data.id;
  const joined = await a.call(path + '/join', { name: 'A' });
  const again = await a.call(path + '/join', { name: '다른 이름' });
  assert.equal(again.data.me.id, joined.data.me.id); assert.equal(again.data.members.length, 2);
  await b.call(path + '/join', { name: 'B' });
  const first = await host.call(path + '/songs', { url: 'https://youtu.be/abcdefghijk', title: '첫 곡' });
  assert.equal(first.data.current.videoId, 'abcdefghijk'); assert.equal(first.data.playback.status, 'waiting'); assert.equal(first.data.queue.length, 0);
  assert.equal((await a.call(path + '/songs', { videoId: 'abcdefghijk', title: '중복' })).status, 400);
  assert.equal((await host.call(path + '/songs', { url: 'https://youtube.com.evil.test/watch?v=abcdefghijk', title: '잘못된 링크' })).status, 400);
  const added = await a.call(path + '/songs', { videoId: 'lmnopqrstuv', title: '다음 곡' });
  const songId = added.data.queue[0].id;
  assert.equal((await stranger.call(path + '/votes', { songId, value: 1 })).status, 401);
  for (let i = 0; i < 4; i++) await a.call(path + '/votes', { songId, value: 1 });
  assert.equal((await a.call(path)).data.queue[0].likes, 1);
  let state = (await a.call(path + '/votes', { songId, value: -1 })).data;
  assert.equal(state.queue[0].likes, 0); assert.equal(state.queue[0].passes, 1);
  await a.call(path + '/votes', { songId, value: 0 });
  assert.equal((await host.call(path + '/control', { command: 'play' })).status, 400);
  assert.equal((await a.call(path + '/control', { command: 'ended', songId: first.data.current.id })).status, 403);
  assert.equal((await a.call(path + '/search?q=test')).status, 503);
  for (let i = 0; i < 4; i++) await a.call(path + '/skip', { songId: first.data.current.id, value: true });
  assert.equal((await a.call(path)).data.current.skipCount, 1);
  state = (await b.call(path + '/skip', { songId: first.data.current.id, value: true })).data;
  assert.equal(state.current.id, songId); assert.equal(state.current.skipCount, 0);
  assert.equal((await host.call(path + '/control', { command: 'ended', songId: first.data.current.id })).status, 409);
  const publicState = (await stranger.call(path)).data;
  assert.equal(publicState.isPlayer, undefined); assert.equal(publicState.me, null);
  assert.equal(publicState.votes, undefined); assert.ok(!JSON.stringify(publicState).includes('device'));
  assert.equal((await host.call(path + '/heartbeat', {}, { Origin: 'https://evil.test' })).status, 403);
  const saved = JSON.parse(readFileSync(join(dir, 'serverless-local.json'), 'utf8'));
  assert.equal(JSON.parse(saved['room:' + created.data.id].value).room.members.length, 3);
  const startedAt = state.playback.startedAt;
  await host.call(path + '/leave', {});
  assert.equal((await a.call(path)).data.playback.startedAt, startedAt);
  await a.call(path + '/skip', { songId, value: true });
  state = (await b.call(path + '/skip', { songId, value: true })).data;
  assert.equal(state.current, null);
  state = (await b.call(path + '/songs', { videoId: '12345678901', title: '다시 자동 재생' })).data;
  assert.equal(state.current.title, '다시 자동 재생');
  await a.call(path + '/leave', {});
  assert.equal((await b.call(path + '/leave', {})).data.deleted, true);
  assert.equal((await stranger.call(path)).status, 404);
  assert.equal(videoId('https://www.youtube.com/shorts/abcdefghijk'), 'abcdefghijk');
  assert.equal(videoId('javascript:alert(1)'), null);
  assert.equal(videoId('https://youtube.com/playlist?list=abcdefghijk'), null);
  const youtubeModule = await fetch(base + '/youtube.js'); assert.equal(youtubeModule.status, 200);
  assert.match(await youtubeModule.text(), /export function createYoutubeLoader/);
  const home = await fetch(base); assert.equal(home.status, 200); assert.match(await home.text(), /사이/);
  assert.match(home.headers.get('content-security-policy'), /frame-src https:\/\/www.youtube.com/);
  assert.equal((await fetch(base + '/data/serverless-local.json')).status, 404);
});

test('분산 함수: 동시 투표·신청·종료의 중복 방지와 공유 검색 캐시', async t => {
  const redis = emulator();
  const stores = [createRoomStore(redis.backend()), createRoomStore(redis.backend())];
  let youtubeCalls = 0, index = 0;
  const youtubeFetch = async url => {
    const params = new URL(url).searchParams;
    assert.equal(params.get('videoCategoryId'), '10');
    assert.equal(params.get('safeSearch'), 'strict');
    youtubeCalls++;
    return { ok: true, json: async () => ({ items: [{ id: { videoId: 'abcdefghijk' }, snippet: { title: '검색된 곡', channelTitle: '가수' } }] }) };
  };
  const handlers = stores.map(store => createHandler(async () => store, youtubeFetch));
  const base = await listen(t, http.createServer((req, res) => handlers[index++ % 2](req, res)));
  const host = client(base), a = client(base), b = client(base), c = client(base);
  const created = await host.call('/api/rooms', { title: '서버리스 방', name: '재생' });
  const path = '/api/rooms/' + created.data.id;
  const joined = await Promise.all([a.call(path + '/join', { name: 'A' }), b.call(path + '/join', { name: 'B' }), c.call(path + '/join', { name: 'C' })]);
  assert.ok(joined.every(result => result.status === 200));
  await Promise.all([a.call(path + '/join', { name: 'A' }), a.call(path + '/join', { name: 'A' })]);
  assert.equal((await host.call(path)).data.members.length, 4);
  const first = await host.call(path + '/songs', { videoId: 'abcdefghijk', title: '즉시 재생' });
  const added = await a.call(path + '/songs', { videoId: 'lmnopqrstuv', title: '투표할 곡' });
  const songId = added.data.queue[0].id;
  const votes = await Promise.all([a.call(path + '/votes', { songId, value: 1 }), b.call(path + '/votes', { songId, value: 1 }), c.call(path + '/votes', { songId, value: 1 })]);
  assert.ok(votes.every(v => v.status === 200)); assert.equal((await host.call(path)).data.queue[0].likes, 3);
  await Promise.all([a.call(path + '/votes', { songId, value: 1 }), a.call(path + '/votes', { songId, value: 1 })]);
  assert.equal((await host.call(path)).data.queue[0].likes, 3);
  const duplicates = await Promise.all([a.call(path + '/songs', { videoId: '12345678901', title: '중복 신청' }), b.call(path + '/songs', { videoId: '12345678901', title: '중복 신청' })]);
  assert.deepEqual(duplicates.map(v => v.status).sort(), [200, 400]);
  await host.call(path + '/control', { command: 'duration', songId: first.data.current.id, duration: 10 });
  const report = await attachPlayer(host, path, first.data.current.id);
  await report('progress', { status: 'playing', position: 9.5 });
  const ends = await Promise.all([report('ended', { position: 10 }), report('ended', { position: 10 })]);
  assert.deepEqual(ends.map(v => v.status).sort(), [200, 409]);
  let state = (await host.call(path)).data;
  assert.equal(state.history.length, 1); assert.equal(state.queue.length, 1);
  await Promise.all([a.call(path + '/skip', { songId: state.current.id, value: true }), b.call(path + '/skip', { songId: state.current.id, value: true })]);
  assert.equal((await host.call(path)).data.current.skipCount, 2);
  await c.call(path + '/skip', { songId: state.current.id, value: true });
  state = (await host.call(path)).data; assert.equal(state.history.length, 2);
  assert.equal((await createRoomStore(redis.backend()).getRoom(created.data.id)).history.length, 2);
  assert.ok(redis.conflicts > 0);
  process.env.YOUTUBE_API_KEY = 'test-youtube-key';
  try {
    assert.equal((await a.call(path + '/search?q=jazz')).status, 200);
    assert.equal((await b.call(path + '/search?q=jazz')).data.items[0].title, '검색된 곡');
    assert.equal(youtubeCalls, 1); assert.equal((await a.call(path + '/search?q=rock')).status, 429);
  } finally { delete process.env.YOUTUBE_API_KEY; }
  assert.equal(redis.commands.find(args => args[0] === 'SET' && args[1].includes('room:')).at(-1), 90);
  assert.ok(redis.commands.some(args => args[0] === 'SET' && args[1].includes('search:') && args.at(-1) === 300));
  // Redis automatically expires the room without calling any application endpoint.
  redis.tick(90001);
  assert.equal((await host.call(path)).status, 404);
});

test('방장 부재 시 곡을 보존하고 남은 참여자의 접속 확인으로 방 수명을 갱신한다', async t => {
  const redis = emulator(), store = createRoomStore(redis.backend());
  const base = await listen(t, http.createServer(createHandler(async () => store)));
  const host = client(base), guest = client(base);
  const created = await host.call('/api/rooms', { title: '접속 확인', name: '먼저 온 사람' });
  const path = '/api/rooms/' + created.data.id;
  await guest.call(path + '/join', { name: '남은 사람' });
  await host.call(path + '/songs', { videoId: 'abcdefghijk', title: '계속 흐르는 곡' });
  const before = await store.getRoom(created.data.id);
  await store.updateRoom(created.data.id, room => { room.members[0].lastSeen = Date.now() - 90001; });
  const renewed = await guest.call(path + '/heartbeat', {});
  assert.equal(renewed.data.members.length, 1);
  assert.equal(renewed.data.playback.startedAt, before.playback.startedAt);
  assert.equal(renewed.data.current.id, before.current.id);
  redis.tick(80000); assert.equal((await guest.call(path + '/heartbeat', {})).status, 200);
  redis.tick(80000); assert.equal((await guest.call(path)).status, 200);
  const left = await guest.call(path + '/leave', {}); assert.equal(left.data.deleted, true);
  assert.equal((await guest.call(path)).status, 404);
  assert.ok(!redis.records.has('test:production:room:' + created.data.id));
});

test('중간 입장은 실제 위치를 받고 곡 길이가 지나도 자동으로 건너뛰지 않는다', async t => {
  const redis = emulator(), store = createRoomStore(redis.backend());
  const base = await listen(t, http.createServer(createHandler(async () => store)));
  const host = client(base), guest = client(base), viewer = client(base);
  const created = await host.call('/api/rooms', { title: '실제 재생', name: '방장' });
  const path = '/api/rooms/' + created.data.id;
  const first = (await host.call(path + '/songs', { videoId: 'abcdefghijk', title: '현재 곡' })).data.current;
  assert.equal((await host.call(path + '/control', { command: 'duration', songId: first.id, duration: 0 })).status, 400);
  await host.call(path + '/control', { command: 'duration', songId: first.id, duration: 180 });
  const report = await attachPlayer(host, path, first.id);
  await report('progress', { status: 'playing', position: 80 });
  const late = await guest.call(path + '/join', { name: '참여자' });
  assert.ok(positionAt(late.data.playback, late.data.serverTime) >= 80);
  assert.ok(positionAt(late.data.playback, late.data.serverTime) < 82);
  await host.call(path + '/songs', { videoId: 'lmnopqrstuv', title: '다음 곡' });
  assert.equal((await guest.call(path + '/control', { command: 'ended', songId: first.id })).status, 403);
  await store.updateRoom(created.data.id, room => { room.playback.reportedAt = Date.now() - 185000; });
  const ttlBefore = redis.records.get('test:production:room:' + created.data.id).until;
  const elapsed = await viewer.call(path);
  assert.equal(elapsed.data.current.id, first.id);
  assert.equal(elapsed.data.playback.position, 80);
  assert.equal(elapsed.data.playback.status, 'disconnected');
  assert.equal(elapsed.data.history.length, 0);
  assert.equal(elapsed.data.queue.length, 1);
  assert.equal(redis.records.get('test:production:room:' + created.data.id).until, ttlBefore);
  assert.equal((await report('progress', { status: 'playing', position: 175 })).status, 409);
  const resumed = await attachPlayer(host, path, first.id);
  assert.equal((await viewer.call(path)).data.playback.position, 80);
  await resumed('progress', { status: 'playing', position: 82 });
  assert.equal((await viewer.call(path)).data.playback.position, 82);
});

test('공유 위치는 버퍼링·정지·보고 만료 시 마지막 확인 위치에서 멈춘다', () => {
  const playback = { status: 'playing', position: 8, reportedAt: 100000, leaseMs: 10000 };
  assert.equal(positionAt(playback, 102000), 10);
  assert.equal(positionAt(playback, 110000), 8);
  for (const status of ['buffering', 'paused', 'blocked', 'disconnected', 'waiting']) assert.equal(positionAt({ ...playback, status }, 108000), 8);
  assert.equal(playablePosition({ current: { duration: 10 }, playback }, 108000), 9.9);
  assert.equal(positionAt(null, 100000), 0);
  const room = { members: [{ device: 'host', lastSeen: 100000 }], creatorDevice: 'host', current: { id: 'a' }, history: [], playback };
  assert.equal(settlePlayback(room, 110000), true);
  assert.equal(room.current.id, 'a'); assert.equal(room.playback.position, 8);
  assert.equal(settlePlayback(room, 120000), false);
  assert.equal(playbackLabel({ ...room, creatorConnection: 'reconnecting' }, 120000), '방장 연결 확인 중');
  assert.equal(playbackLabel({ ...room, creatorConnection: 'disconnected' }, 120000), '방장 연결 끊김');
});

test('Vercel 재작성·파싱된 body·보안 쿠키·필수 DB 설정을 처리한다', async () => {
  const records = new Map();
  const handler = createHandler(async () => ({ async createRoom(room) { records.set(room.id, structuredClone(room)); }, async getRoom(id) { return records.get(id); } }));
  async function invoke(url, body) {
    const headers = {}; let status, result;
    await handler({ method: body === undefined ? 'GET' : 'POST', url, body, headers: { host: 'app.vercel.app', origin: 'https://app.vercel.app' } }, { setHeader(k, v) { headers[k.toLowerCase()] = v; }, writeHead(s) { status = s; }, end(v) { result = JSON.parse(v); } });
    return { headers, status, result };
  }
  process.env.VERCEL = '1';
  try {
    const created = await invoke('/api/index?__route=rooms', { title: '배포 경로', name: '나' });
    assert.equal(created.status, 201); assert.match(created.headers['set-cookie'], /; Secure/);
    assert.equal((await invoke(`/api/index?__route=rooms/${created.result.id}`)).result.title, '배포 경로');
    assert.equal((await invoke('/api/index?__route=rooms', '[]')).status, 400);
    assert.equal((await invoke('/api/index?__route=rooms', { title: 'x'.repeat(17000) })).status, 413);
    const { getStore } = await import('../lib/storage.js?missing-db');
    await assert.rejects(getStore(), error => error.status === 503 && /Upstash/.test(error.message));
  } finally { delete process.env.VERCEL; }
});

test('DB 장애·충돌·만료를 명시적으로 처리하고 토큰을 노출하지 않는다', async () => {
  const broken = createRedisBackend({ url: 'https://redis.example.test', token: 'secret', fetchImpl: async () => ({ ok: false, json: async () => ({ error: 'credential secret leaked' }) }) });
  await assert.rejects(broken.read('room:x'), error => error.status === 503 && !error.message.includes('secret'));
  const down = createRedisBackend({ url: 'https://redis.example.test', token: 'secret', fetchImpl: async () => { throw Error('URL and token'); } });
  await assert.rejects(down.read('room:x'), error => error.status === 503);
  assert.throws(() => createRedisBackend({ url: 'http://insecure.test', token: 'secret' }), error => error.status === 503);
  const conflict = createRoomStore({ async read() { return JSON.stringify({ version: 1, room: { title: 'before' } }); }, async compare() { return 0; } });
  await assert.rejects(conflict.updateRoom('x', room => { room.title = 'after'; }), error => error.status === 409);
  await assert.rejects(createRoomStore({ async read() { return null; } }).getRoom('expired'), error => error.status === 404);
  const room = { members: [{ id: 'x', lastSeen: 0 }], votes: { x: { a: 1 } }, skipVotes: { x: true }, playerId: 'x', playback: { revision: 0 }, current: null };
  refreshPresence(room, 90001); assert.equal(room.members.length, 0); assert.deepEqual(room.votes, {}); assert.deepEqual(room.skipVotes, {});
});

test('배포 경로·정적 파일·보안 정책을 구성한다', () => {
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.equal(config.outputDirectory, 'dist'); assert.equal(config.rewrites[0].destination, '/api/index?__route=:route*');
  assert.equal(config.functions['api/index.js'].maxDuration, 30);
  for (const name of ['index.html', 'app.js', 'style.css', 'youtube.js']) assert.ok(readFileSync(new URL(`../public/${name}`, import.meta.url)).length > 0);
});

test('찬성 2표 곡이 찬성 1·패스 1표 곡보다 먼저 표시되고 실제 다음 곡이 된다', async t => {
  const redis = emulator(), store = createRoomStore(redis.backend());
  const base = await listen(t, http.createServer(createHandler(async () => store)));
  const first = client(base), second = client(base);
  for (const transition of ['skip', 'ended']) {
    const created = await first.call('/api/rooms', { title: `점수 우선 ${transition}`, name: '먼저' });
    const path = '/api/rooms/' + created.data.id;
    await second.call(path + '/join', { name: '함께' });
    const playing = await first.call(path + '/songs', { videoId: 'abcdefghijk', title: '현재 곡' });
    const low = await second.call(path + '/songs', { videoId: 'lmnopqrstuv', title: '찬성 1 패스 1' });
    const lowId = low.data.queue[0].id;
    // The later, higher-scoring song has the same requester as the current song.
    const high = await first.call(path + '/songs', { videoId: '12345678901', title: '찬성 2' });
    const highId = high.data.queue.find(song => song.videoId === '12345678901').id;
    await first.call(path + '/votes', { songId: lowId, value: 1 });
    await second.call(path + '/votes', { songId: lowId, value: -1 });
    await first.call(path + '/votes', { songId: highId, value: 1 });
    let state = (await second.call(path + '/votes', { songId: highId, value: 1 })).data;
    assert.deepEqual(state.queue.map(song => [song.id, song.score]), [[highId, 2], [lowId, 0]]);
    await first.call(path + '/votes', { songId: highId, value: -1 });
    state = (await first.call(path)).data;
    assert.deepEqual(state.queue.map(song => [song.id, song.score]), [[lowId, 0], [highId, 0]]);
    await first.call(path + '/votes', { songId: highId, value: 1 });
    const displayedNext = (await second.call(path)).data.queue[0].id;
    if (transition === 'skip') {
      await first.call(path + '/skip', { songId: playing.data.current.id, value: true });
      state = (await second.call(path + '/skip', { songId: playing.data.current.id, value: true })).data;
    } else {
      await first.call(path + '/control', { command: 'duration', songId: playing.data.current.id, duration: 10 });
      const report = await attachPlayer(first, path, playing.data.current.id);
      await report('progress', { status: 'playing', position: 9.5 });
      state = (await report('ended', { position: 10 })).data;
    }
    assert.equal(displayedNext, highId);
    assert.equal(state.current.id, displayedNext);
    assert.equal(state.queue[0].id, lowId);
  }
});


test('방 생성자만 재생을 담당하고 퇴장 후에도 권한을 넘기지 않는다', async t => {
  const redis = emulator(), store = createRoomStore(redis.backend());
  const base = await listen(t, http.createServer(createHandler(async () => store)));
  const host = client(base), guest = client(base), viewer = client(base);
  const created = await host.call('/api/rooms', { title: '생성자 재생', name: '방장' });
  const path = '/api/rooms/' + created.data.id;
  assert.equal(created.data.isCreator, true);
  assert.equal((await viewer.call(path)).data.isCreator, false);
  assert.equal((await guest.call(path + '/join', { name: '참여자' })).data.isCreator, false);
  const song = (await guest.call(path + '/songs', { videoId: 'abcdefghijk', title: '신청곡' })).data.current;
  for (const command of ['duration', 'ended', 'unavailable']) {
    assert.equal((await guest.call(path + '/control', { command, songId: song.id, duration: 180 })).status, 403);
  }
  assert.equal((await host.call(path)).data.isCreator, true);
  const report = await attachPlayer(host, path, song.id);
  assert.equal((await report('unavailable', { errorCode: 100 })).data.current, null);
  await host.call(path + '/leave', {});
  assert.equal((await guest.call(path)).data.isCreator, false);
  assert.equal((await host.call(path + '/join', { name: '다시 방장' })).data.isCreator, true);
  assert.ok(!JSON.stringify((await guest.call(path)).data).includes('creatorDevice'));
});


test('재생 보고는 상태를 보존하고 오래된 순서·다른 탭·이전 연결·이른 종료를 거절한다', async t => {
  const redis = emulator(), store = createRoomStore(redis.backend());
  const base = await listen(t, http.createServer(createHandler(async () => store)));
  const host = client(base), guest = client(base);
  const created = await host.call('/api/rooms', { title: '보고 순서', name: '방장' });
  const path = '/api/rooms/' + created.data.id;
  await guest.call(path + '/join', { name: '함께' });
  const song = (await host.call(path + '/songs', { videoId: 'abcdefghijk', title: '현재 곡' })).data.current;
  await host.call(path + '/control', { command: 'duration', songId: song.id, duration: 180 });
  await host.call(path + '/songs', { videoId: 'lmnopqrstuv', title: '다음 곡' });
  const sessionId = 'first-player-session-0001';
  const attached = await host.call(path + '/control', { command: 'attach', songId: song.id, sessionId });
  const revision = attached.data.playback.revision;
  const send = details => host.call(path + '/control', { command: 'progress', songId: song.id, sessionId, revision, ...details });
  for (const [i, status] of ['playing', 'buffering', 'blocked', 'waiting', 'paused'].entries()) {
    const result = await send({ sequence: i + 1, status, position: 40 });
    assert.equal(result.status, 200); assert.equal(result.data.playback.status, status);
    if (status !== 'playing') assert.equal(positionAt(result.data.playback, result.data.serverTime + 5000), 40);
  }
  assert.equal((await send({ sequence: 4, status: 'playing', position: 90 })).status, 409);
  assert.equal((await send({ sequence: 6, status: 'wrong', position: 40 })).status, 400);
  assert.equal((await send({ sequence: 6, status: 'playing', position: -1 })).status, 400);
  assert.equal((await send({ command: 'ended', sequence: 6, position: 180 })).status, 409);
  assert.equal((await host.call(path + '/control', { command: 'attach', songId: song.id, sessionId: 'second-player-session-0002' })).status, 409);
  assert.equal((await guest.call(path + '/control', { command: 'progress', songId: song.id, sessionId, revision, sequence: 6, status: 'playing', position: 60 })).status, 403);
  const publicState = (await guest.call(path)).data;
  assert.equal(publicState.playback.sessionId, undefined); assert.equal(publicState.playback.sequence, undefined);
  await store.updateRoom(created.data.id, room => { room.playback.reportedAt = Date.now() - 11000; });
  assert.equal((await guest.call(path)).data.creatorConnection, 'reconnecting');
  await store.updateRoom(created.data.id, room => { room.playback.reportedAt = Date.now() - 31000; });
  assert.equal((await guest.call(path)).data.creatorConnection, 'disconnected');
  const resumed = await attachPlayer(host, path, song.id, 'second-player-session-0002');
  assert.equal((await send({ sequence: 7, status: 'playing', position: 170 })).status, 409);
  assert.equal((await guest.call(path)).data.playback.position, 40);
  await resumed('resume');
  await resumed('progress', { status: 'playing', position: 176 });
  const ended = await resumed('ended', { position: 180 });
  assert.equal(ended.status, 200); assert.equal(ended.data.history.length, 1);
  assert.equal(ended.data.current.title, '다음 곡'); assert.equal(ended.data.playback.position, 0);
  assert.equal((await resumed('ended', { position: 180 })).status, 409);
});

test('방장 퇴장은 즉시 연결 끊김을 표시하고 기존 시간 기반 방은 안전하게 대기한다', async t => {
  const redis = emulator(), store = createRoomStore(redis.backend());
  const base = await listen(t, http.createServer(createHandler(async () => store)));
  const host = client(base), guest = client(base);
  const created = await host.call('/api/rooms', { title: '퇴장과 이전 데이터', name: '방장' });
  const path = '/api/rooms/' + created.data.id;
  await guest.call(path + '/join', { name: '함께' });
  const song = (await host.call(path + '/songs', { videoId: 'abcdefghijk', title: '보존할 곡' })).data.current;
  const report = await attachPlayer(host, path, song.id);
  await report('progress', { status: 'playing', position: 24 });
  const left = await host.call(path + '/leave', {});
  assert.equal(left.data.creatorConnection, 'disconnected'); assert.equal(left.data.playback.status, 'disconnected');
  assert.equal(left.data.playback.position, 24); assert.equal(left.data.current.id, song.id);
  await host.call(path + '/join', { name: '돌아온 방장' });
  await store.updateRoom(created.data.id, room => { room.playback = { status: 'playing', revision: 1, startedAt: Date.now() - 999999 }; room.current.duration = 10; });
  const migrated = await guest.call(path);
  assert.equal(migrated.data.current.id, song.id); assert.equal(migrated.data.playback.status, 'waiting');
  assert.equal(migrated.data.playback.position, 0); assert.equal(migrated.data.history.length, 0);
});

function playerHarness() {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const playerSource = source.slice(source.indexOf('function loadedVideoMatches()'), source.indexOf("for (const name of ['rules'"));
  const messages = [], loads = [], elements = new Map();
  const now = Date.now(); let state = 1, currentTime = 23;
  const room = { isCreator: true, current: { id: 'song', videoId: 'abcdefghijk', duration: 180 }, playback: { position: 20, status: 'playing', reportedAt: now, revision: 2, leaseMs: 10000 } };
  const context = {
    URL, Date, youtubeError, clearTimeout() {}, setTimeout() { return 1; }, playerReadyTimer: null, playerFailure: null, retryingSong: null, location: { origin: 'https://sai.example.test' }, room, playerReady: true, loadedSong: 'song', claimedSong: 'song', claimedRevision: 2,
    playbackSession: 'test-browser-session-0001', reportSequence: 0, lastPlaybackReport: 0, lastClaim: 0,
    syncBusy: false, reportBusy: false, durationBusy: false, durationSentFor: null,
    pendingControl: null, playbackFailure: false, localPaused: false, localBlocked: false, internalPause: false, awaitingPlayback: false,
    serverNow: () => Date.now(), positionAt, playbackLabel,
    $: selector => { if (!elements.has(selector)) elements.set(selector, { textContent: '', hidden: false, classList: { toggle() {}, remove() {} } }); return elements.get(selector); },
    YT: { PlayerState: { PLAYING: 1, PAUSED: 2, BUFFERING: 3, ENDED: 0 } },
    player: {
      getVideoUrl: () => 'https://www.youtube.com/watch?v=abcdefghijk', getCurrentTime: () => currentTime,
      getPlayerState: () => state, getDuration: () => 180, getIframe: () => ({}), pauseVideo() {},
      loadVideoById: video => loads.push(video), cueVideoById: video => loads.push(video),
    },
    request: async (action, body) => { messages.push({ action, body }); return structuredClone(context.room); },
    accept: next => { context.room = next; }, refresh: async () => {}, stopPlayer() {},
  };
  runInNewContext(playerSource, context);
  return { context, messages, loads, setState(value) { state = value; }, setPosition(value) { currentTime = value; } };
}

test('브라우저는 실제 재생·버퍼링·정지·차단 상태와 종료를 자동 보고한다', async () => {
  const h = playerHarness(), c = h.context;
  for (const [state, status] of [[1, 'playing'], [3, 'buffering'], [2, 'paused']]) {
    h.setState(state); c.lastPlaybackReport = 0; await c.reportPlayback();
    assert.equal(h.messages.at(-1).body.status, status); assert.equal(h.messages.at(-1).body.position, 23);
  }
  c.localBlocked = true; c.lastPlaybackReport = 0; await c.reportPlayback();
  assert.equal(h.messages.at(-1).body.status, 'blocked');
  c.localBlocked = false; h.setState(0); h.setPosition(180); c.lastPlaybackReport = 0; await c.reportPlayback();
  assert.equal(h.messages.at(-1).body.command, 'ended');
  assert.equal(h.messages.at(-1).body.songId, 'song');
});

test('브라우저 복구는 확인된 위치를 로드하고 정상 재생을 서버 추정 위치로 강제 이동하지 않는다', async () => {
  const h = playerHarness(), c = h.context;
  c.room.playback.position = 40;
  await c.syncPlayer(); assert.equal(h.loads.length, 0);
  c.playbackFailure = true; h.setPosition(95);
  await c.reportPlayback();
  assert.equal(h.messages.at(-1).action, undefined);
  assert.equal(c.claimedSong, null);
  c.request = async (action, body) => {
    h.messages.push({ action, body });
    return { ...c.room, playback: { ...c.room.playback, status: 'waiting', position: 40, revision: 3 } };
  };
  await c.syncPlayer();
  assert.equal(h.loads.length, 1); assert.equal(h.loads[0].startSeconds, 40);
  assert.equal(c.claimedRevision, 3); assert.equal(c.reportSequence, 0);
  assert.equal(c.playbackFailure, false);
  await c.reportPlayback();
  assert.equal(h.messages.at(-1).body.position, 40); // The asynchronous load still exposes the old local playhead (95).
  assert.equal(h.messages.at(-1).body.status, 'waiting');
});


test('플레이어 상태 변경 이벤트가 재생 보고와 자동 종료로 이어진다', async () => {
  const h = playerHarness(), c = h.context;
  const fakePlayer = c.player;
  fakePlayer.getIframe = () => ({ setAttribute() {} });
  fakePlayer.pauseVideo = () => { h.setState(2); events.onStateChange({ data: 2 }); };
  let events;
  c.player = null; c.playerReady = false; c.loadedSong = null;
  c.loadYoutube = async () => {};
  c.YT.Player = function (mount, options) { events = options.events; return fakePlayer; };
  await c.syncPlayer();
  events.onReady();
  assert.equal(h.loads.length, 1); assert.equal(h.loads[0].startSeconds, 20);
  for (const [state, status] of [[1, 'playing'], [3, 'buffering'], [2, 'paused']]) {
    h.setState(state); events.onStateChange({ data: state });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.messages.at(-1).body.status, status);
  }
  c.localPaused = false;
  c.claimedSong = null; c.lastClaim = 0;
  await c.syncPlayer();
  assert.equal(c.localPaused, false); // An internal reconnect pause must not require a user click.
  h.setState(1); events.onStateChange({ data: 1 });
  await new Promise(resolve => setImmediate(resolve));
  h.setPosition(180); h.setState(0); events.onStateChange({ data: 0 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.messages.at(-1).body.command, 'ended');
});


test('병합: 방장 전용 일시정지·재개는 실제 재생 확인까지 시간을 진행하지 않는다', async t => {
  const redis = emulator(), store = createRoomStore(redis.backend());
  const base = await listen(t, http.createServer(createHandler(async () => store)));
  const host = client(base), guest = client(base);
  const created = await host.call('/api/rooms', { title: '멈춘 레코드', name: '방장' });
  const path = '/api/rooms/' + created.data.id;
  await guest.call(path + '/join', { name: '참여자' });
  const song = (await host.call(path + '/songs', { videoId: 'abcdefghijk', title: '현재 곡' })).data.current;
  await host.call(path + '/songs', { videoId: 'lmnopqrstuv', title: '대기곡' });
  await host.call(path + '/control', { command: 'duration', songId: song.id, duration: 180 });
  const report = await attachPlayer(host, path, song.id);
  for (const position of [-1, '45', 181]) assert.equal((await report('pause', { position })).status, 400);
  const paused = await report('pause', { position: 45.5 });
  assert.equal(paused.status, 200); assert.equal(paused.data.playback.status, 'paused');
  assert.equal(paused.data.playback.paused, true);
  assert.equal(positionAt(paused.data.playback, paused.data.serverTime + 3600000), 45.5);
  assert.equal((await report('pause', { position: 0 })).data.playback.position, 45.5);
  assert.equal((await report('progress', { status: 'playing', position: 95 })).data.playback.position, 45.5);
  assert.equal((await guest.call(path + '/control', { command: 'resume', songId: song.id })).status, 403);
  assert.equal((await guest.call(path + '/heartbeat', {})).data.playback.position, 45.5);
  const frozen = structuredClone(await store.getRoom(created.data.id));
  settlePlayback(frozen, paused.data.serverTime + 3600000);
  assert.equal(frozen.current.id, song.id); assert.equal(frozen.playback.position, 45.5);
  // Reopening the host tab keeps the durable pause after its former lease expires.
  await store.updateRoom(created.data.id, room => { room.playback.reportedAt = Date.now() - 11000; });
  const reattached = await attachPlayer(host, path, song.id, 'reopened-browser-session-0002');
  const refreshed = (await host.call(path)).data;
  assert.equal(refreshed.playback.status, 'paused'); assert.equal(refreshed.playback.position, 45.5);
  const resumed = await reattached('resume');
  assert.equal(resumed.data.playback.status, 'waiting'); assert.equal(resumed.data.playback.position, 45.5);
  assert.equal(positionAt(resumed.data.playback, resumed.data.serverTime + 5000), 45.5);
  const playing = await reattached('progress', { status: 'playing', position: 46 });
  assert.equal(playing.data.playback.status, 'playing'); assert.equal(playing.data.current.id, song.id);
  assert.equal(playing.data.queue.length, 1);
});

test('병합: 일시정지 중 과반 건너뛰기는 다음 곡의 처음에서 멈춘 상태를 유지한다', async t => {
  const redis = emulator(), store = createRoomStore(redis.backend());
  const base = await listen(t, http.createServer(createHandler(async () => store)));
  const host = client(base), guest = client(base);
  const created = await host.call('/api/rooms', { title: '멈춘 채 건너뛰기', name: '방장' });
  const path = '/api/rooms/' + created.data.id;
  await guest.call(path + '/join', { name: '참여자' });
  const song = (await host.call(path + '/songs', { videoId: 'abcdefghijk', title: '현재 곡' })).data.current;
  const next = (await guest.call(path + '/songs', { videoId: 'lmnopqrstuv', title: '다음 곡' })).data.queue[0];
  const report = await attachPlayer(host, path, song.id);
  await report('pause', { position: 45.5 });
  assert.equal((await host.call(path + '/skip', { songId: song.id, value: true })).data.current.id, song.id);
  const skipped = await guest.call(path + '/skip', { songId: song.id, value: true });
  assert.equal(skipped.status, 200); assert.equal(skipped.data.current.id, next.id);
  assert.equal(skipped.data.playback.status, 'paused'); assert.equal(skipped.data.playback.position, 0);
  assert.equal(skipped.data.playback.paused, true);
  assert.equal(positionAt(skipped.data.playback, skipped.data.serverTime + 3600000), 0);
  const nextReport = await attachPlayer(host, path, next.id);
  assert.equal((await host.call(path)).data.playback.status, 'paused');
  assert.equal((await nextReport('resume')).data.playback.position, 0);
  await nextReport('progress', { status: 'playing', position: 0.1 });
  await nextReport('pause', { position: 2 });
  await host.call(path + '/skip', { songId: next.id, value: true });
  const empty = await guest.call(path + '/skip', { songId: next.id, value: true });
  assert.equal(empty.data.current, null); assert.equal(empty.data.playback.status, 'idle');
});

test('병합: 재생 버튼은 확인 위치를 지키고 정지 버튼은 직렬 보고로 저장한다', async () => {
  const h = playerHarness(), c = h.context;
  c.player.playVideo = () => {};
  c.controlPlayback('pause');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(c.localPaused, true);
  assert.equal(h.messages.at(-1).body.command, 'pause');
  assert.equal(h.messages.at(-1).body.position, 23);
  c.room.playback.paused = true; c.room.playback.status = 'paused';
  c.controlPlayback('resume');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(c.localPaused, false);
  assert.equal(h.messages.at(-1).body.command, 'resume');
  assert.equal(h.loads.length, 0);
  c.room.isCreator = false;
  const count = h.messages.length;
  c.controlPlayback('pause');
  assert.equal(h.messages.length, count);
});


test('YouTube 오류는 삭제·비공개·외부 재생 금지만 자동 건너뛰기로 분류한다', () => {
  for (const code of [100, 101, 150]) assert.equal(youtubeError(code).skip, true);
  for (const code of [2, 5, 153, 0, 999, 'api', undefined, 'toString']) assert.equal(youtubeError(code).skip, false);
  assert.equal(youtubeError(153).kind, 'configuration');
  assert.equal(youtubeError(5).kind, 'player');
  assert.equal(youtubeError(999).kind, 'unknown');
});

function youtubeLoaderHarness() {
  const scripts = [], activeTimers = new Map(); let nextTimer = 0, previousCalls = 0;
  const previousReady = () => { previousCalls++; };
  const environment = { onYouTubeIframeAPIReady: previousReady };
  const document = {
    createElement: () => ({ removed: false, remove() { this.removed = true; } }),
    head: { append(script) { scripts.push(script); } },
  };
  const timers = { setTimeout(callback, delay) { assert.equal(delay, 15000); activeTimers.set(++nextTimer, callback); return nextTimer; }, clearTimeout(id) { activeTimers.delete(id); } };
  return { environment, scripts, activeTimers, previousReady, get previousCalls() { return previousCalls; }, load: createYoutubeLoader(environment, document, timers) };
}

test('기본 로더는 브라우저 타이머에 잘못된 this를 전달하지 않는다', async () => {
  const originalSetTimeout = globalThis.setTimeout, originalClearTimeout = globalThis.clearTimeout;
  const environment = {}, scripts = [], activeTimers = new Map();
  let timerId = 0;
  function checkReceiver(receiver) {
    if (receiver !== undefined && receiver !== globalThis) throw TypeError('Illegal invocation');
  }
  globalThis.setTimeout = function (callback) { checkReceiver(this); activeTimers.set(++timerId, callback); return timerId; };
  globalThis.clearTimeout = function (id) { checkReceiver(this); activeTimers.delete(id); };
  try {
    const load = createYoutubeLoader(environment, { createElement: () => ({ remove() {} }), head: { append: script => scripts.push(script) } });
    const pending = load();
    assert.equal(scripts.length, 1);
    assert.equal(activeTimers.size, 1);
    environment.YT = { Player() {} };
    environment.onYouTubeIframeAPIReady();
    await pending;
    assert.equal(activeTimers.size, 0);
  } finally { globalThis.setTimeout = originalSetTimeout; globalThis.clearTimeout = originalClearTimeout; }
});

test('API 로딩 실패는 요청·스크립트·타이머를 정리하고 동시 재시도를 하나로 합친다', async () => {
  const h = youtubeLoaderHarness();
  const first = h.load(); assert.equal(h.load(), first); assert.equal(h.scripts.length, 1);
  h.scripts[0].onerror();
  await assert.rejects(first, /다시 시도/);
  assert.equal(h.scripts[0].removed, true); assert.equal(h.activeTimers.size, 0);
  assert.equal(h.environment.onYouTubeIframeAPIReady, h.previousReady);
  const retry = h.load(); assert.notEqual(retry, first); assert.equal(h.load(), retry);
  assert.equal(h.scripts.length, 2);
  h.environment.YT = { Player() {} };
  h.environment.onYouTubeIframeAPIReady(); await retry;
  assert.equal(h.activeTimers.size, 0); assert.equal(h.previousCalls, 1);
  await h.load(); assert.equal(h.scripts.length, 2);
});

test('API 로딩 시간 초과 뒤 늦은 콜백은 다음 로딩 요청을 방해하지 않는다', async () => {
  const h = youtubeLoaderHarness();
  const first = h.load(), staleReady = h.environment.onYouTubeIframeAPIReady;
  [...h.activeTimers.values()][0]();
  await assert.rejects(first, /응답이 늦어/);
  assert.equal(h.activeTimers.size, 0); assert.equal(h.scripts[0].removed, true);
  const retry = h.load(), currentReady = h.environment.onYouTubeIframeAPIReady;
  h.environment.YT = { Player() {} };
  staleReady();
  assert.equal(h.environment.onYouTubeIframeAPIReady, currentReady);
  assert.equal(h.activeTimers.size, 1);
  currentReady(); await retry;
  assert.equal(h.activeTimers.size, 0);
});

test('일시적·설정·알 수 없는 오류는 곡과 위치를 보존하고 명시적 재시도로만 해제한다', async t => {
  const redis = emulator(), store = createRoomStore(redis.backend());
  const base = await listen(t, http.createServer(createHandler(async () => store)));
  const host = client(base), guest = client(base);
  const created = await host.call('/api/rooms', { title: '오류 복구', name: '방장' });
  const path = '/api/rooms/' + created.data.id;
  await guest.call(path + '/join', { name: '참여자' });
  const song = (await host.call(path + '/songs', { videoId: 'abcdefghijk', title: '보존할 곡' })).data.current;
  await guest.call(path + '/songs', { videoId: 'lmnopqrstuv', title: '대기곡' });
  const sessionId = 'retry-test-player-session-001';
  let attached = await host.call(path + '/control', { command: 'attach', songId: song.id, sessionId });
  let sequence = 0;
  const send = (command, details = {}) => host.call(path + '/control', { command, songId: song.id, sessionId, revision: attached.data.playback.revision, sequence: ++sequence, ...details });
  await send('progress', { status: 'playing', position: 42 });
  for (const errorCode of [2, 5, 153, 999, 'api']) {
    assert.equal((await send('unavailable', { errorCode })).status, 400);
    const failed = await send('error', { errorCode, position: 99 });
    assert.equal(failed.status, 200); assert.equal(failed.data.current.id, song.id);
    assert.equal(failed.data.playback.status, 'error'); assert.equal(failed.data.playback.errorCode, errorCode);
    assert.equal(positionAt(failed.data.playback, failed.data.serverTime + 60000), 42);
    assert.equal(failed.data.queue.length, 1); assert.equal(failed.data.history.length, 0);
    assert.equal((await send('progress', { status: 'playing', position: 99 })).status, 409);
    assert.equal((await send('ended', { position: 180 })).status, 409);
    const retained = await host.call(path + '/control', { command: 'attach', songId: song.id, sessionId });
    assert.equal(retained.data.playback.status, 'error'); // A refresh cannot silently retry.
    attached = await host.call(path + '/control', { command: 'attach', songId: song.id, sessionId, retry: true });
    sequence = 0;
    assert.equal(attached.data.playback.errorCode, undefined);
    assert.equal(attached.data.playback.status, 'waiting'); assert.equal(attached.data.playback.position, 42);
    const resumed = await send('progress', { status: 'playing', position: 42 });
    assert.equal(resumed.data.playback.status, 'playing');
  }
  assert.equal((await guest.call(path + '/control', { command: 'error', songId: song.id, errorCode: 5 })).status, 403);
  await send('pause', { position: 42 });
  await send('error', { errorCode: 5 });
  attached = await host.call(path + '/control', { command: 'attach', songId: song.id, sessionId, retry: true });
  assert.equal(attached.data.playback.status, 'paused'); assert.equal(attached.data.playback.position, 42);
  assert.equal(attached.data.playback.errorCode, undefined);
});

test('삭제·비공개와 외부 재생 금지 오류는 다음 곡을 한 번만 선택한다', async t => {
  const redis = emulator(), store = createRoomStore(redis.backend());
  const base = await listen(t, http.createServer(createHandler(async () => store)));
  const host = client(base);
  for (const errorCode of [100, 101, 150]) {
    const created = await host.call('/api/rooms', { title: '재생 금지', name: '방장' });
    const path = '/api/rooms/' + created.data.id;
    const song = (await host.call(path + '/songs', { videoId: 'abcdefghijk', title: '재생 불가' })).data.current;
    await host.call(path + '/songs', { videoId: 'lmnopqrstuv', title: '다음 곡' });
    const report = await attachPlayer(host, path, song.id);
    const skipped = await report('unavailable', { errorCode });
    assert.equal(skipped.status, 200); assert.equal(skipped.data.current.title, '다음 곡');
    assert.equal(skipped.data.history.length, 1);
    assert.equal((await report('unavailable', { errorCode })).status, 409);
  }
});

test('플레이어 오류는 재시도 버튼을 표시하고 마지막 확인 위치에서 새 플레이어를 만든다', async () => {
  const h = playerHarness(), c = h.context;
  c.showPlayerError(5);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.messages.at(-1).body.command, 'error'); assert.equal(h.messages.at(-1).body.errorCode, 5);
  assert.equal(c.$('#retry-playback').hidden, false);
  const count = h.messages.length;
  await c.syncPlayer(); assert.equal(h.loads.length, 0); assert.equal(h.messages.length, count);
  let destroyed = 0, events;
  const original = c.player;
  original.destroy = () => { destroyed++; };
  const replacement = { ...original, getIframe: () => ({ setAttribute() {} }) };
  c.loadYoutube = async () => {};
  c.YT.Player = function (mount, options) { events = options.events; return replacement; };
  await c.retryPlayback();
  assert.equal(destroyed, 1); assert.equal(c.player, replacement);
  assert.equal(h.messages.at(-1).body.retry, true);
  events.onReady({ target: replacement });
  assert.equal(h.loads.at(-1).startSeconds, 20);
  assert.equal(c.playerFailure, null); assert.equal(c.$('#retry-playback').hidden, true);
  events.onError({ target: original, data: 100 }); // A removed frame cannot skip this track.
  assert.equal(c.playerFailure, null);
  events.onError({ target: replacement, data: 153 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.messages.at(-1).body.command, 'error'); assert.equal(c.playerFailure.kind, 'configuration');
});

test('플레이어 API 실패는 자동 무한 재호출 없이 버튼으로 다시 불러온다', async () => {
  const h = playerHarness(), c = h.context;
  c.player = null; c.playerReady = false; c.loadedSong = null;
  let attempts = 0, events;
  c.loadYoutube = async () => { if (++attempts === 1) throw Error('network'); };
  c.YT.Player = function (mount, options) {
    events = options.events;
    return { getIframe: () => ({ setAttribute() {} }), loadVideoById: video => h.loads.push(video), cueVideoById: video => h.loads.push(video), getVideoUrl: () => 'https://www.youtube.com/watch?v=abcdefghijk', getDuration: () => 180, getPlayerState: () => 1, getCurrentTime: () => 20 };
  };
  await c.syncPlayer();
  assert.equal(c.playerFailure.kind, 'api'); assert.equal(c.$('#retry-playback').hidden, false);
  const api = c.YT; c.YT = undefined;
  await c.reportPlayback();
  c.YT = api;
  assert.equal(h.messages.at(-1).body.errorCode, 'api');
  await c.syncPlayer(); assert.equal(attempts, 1);
  await c.retryPlayback(); assert.equal(attempts, 2);
  events.onReady({ target: c.player });
  assert.equal(h.loads.at(-1).startSeconds, 20);
});


test('플레이어 준비 완료가 오지 않아도 시간 초과 후 재시도할 수 있다', async () => {
  const h = playerHarness(), c = h.context;
  c.player = null; c.playerReady = false; c.loadedSong = null;
  let readyTimeout;
  c.setTimeout = callback => { readyTimeout = callback; return 1; };
  c.loadYoutube = async () => {};
  c.YT.Player = function () { return {}; };
  await c.syncPlayer();
  assert.equal(c.playerFailure, null);
  readyTimeout();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(c.playerFailure.kind, 'api');
  assert.equal(c.$('#retry-playback').hidden, false);
  assert.equal(h.messages.at(-1).body.command, 'error');
  assert.equal(h.messages.at(-1).body.errorCode, 'api');
});

test('곡 검증은 음악·공개·외부 재생·처리 상태를 확인하고 클라이언트 제목을 신뢰하지 않는다', async t => {
  const previous = process.env.YOUTUBE_API_KEY;
  process.env.YOUTUBE_API_KEY = 'private-test-key';
  t.after(() => { if (previous === undefined) delete process.env.YOUTUBE_API_KEY; else process.env.YOUTUBE_API_KEY = previous; });
  const fetchVideo = video => async url => {
    const parsed = new URL(url);
    assert.equal(parsed.pathname, '/youtube/v3/videos');
    assert.equal(parsed.searchParams.get('part'), 'snippet,status');
    assert.equal(parsed.searchParams.get('id'), 'abcdefghijk');
    return { ok: true, json: async () => ({ items: video ? [video] : [] }) };
  };
  assert.deepEqual(await verifyMusicVideo('abcdefghijk', fetchVideo(musicVideo())), { title: 'YouTube에서 확인한 제목', artist: '확인한 채널', channelId: 'UCverified' });
  const valid = musicVideo();
  for (const video of [null, musicVideo('other123456'), musicVideo(undefined, { snippet: { ...valid.snippet, categoryId: '22' } }), musicVideo(undefined, { status: { ...valid.status, privacyStatus: 'private' } }), musicVideo(undefined, { status: { ...valid.status, privacyStatus: 'unlisted' } }), musicVideo(undefined, { status: { ...valid.status, embeddable: false } }), musicVideo(undefined, { status: { ...valid.status, uploadStatus: 'rejected' } }), musicVideo(undefined, { snippet: { ...valid.snippet, liveBroadcastContent: 'live' } }), musicVideo(undefined, { snippet: { ...valid.snippet, liveBroadcastContent: 'upcoming' } })]) {
    await assert.rejects(verifyMusicVideo('abcdefghijk', fetchVideo(video)), error => error.status === 400);
  }
  for (const fetchImpl of [async () => { throw Error('private-test-key'); }, async () => ({ ok: false }), async () => ({ ok: true, json: async () => { throw Error(); } }), async () => ({ ok: true, json: async () => ({}) })]) {
    await assert.rejects(verifyMusicVideo('abcdefghijk', fetchImpl), error => error.status === 502 && !error.message.includes('private-test-key'));
  }
  delete process.env.YOUTUBE_API_KEY;
  await assert.rejects(verifyMusicVideo('abcdefghijk', fetchVideo(valid)), error => error.status === 503);
});

test('신청은 공유 저장소로 30초에 한 번 제한하고 재입장·동시 요청·위조 메타데이터를 막는다', async t => {
  const redis = emulator(), store = createRoomStore(redis.backend());
  const previous = process.env.YOUTUBE_API_KEY;
  process.env.YOUTUBE_API_KEY = 'test-admission-key';
  t.after(() => { if (previous === undefined) delete process.env.YOUTUBE_API_KEY; else process.env.YOUTUBE_API_KEY = previous; });
  let calls = 0, category = '10', index = 0;
  const fetchVideo = async url => {
    calls++;
    const id = new URL(url).searchParams.get('id');
    const video = musicVideo(id);
    video.snippet.categoryId = category;
    return { ok: true, json: async () => ({ items: [video] }) };
  };
  const handlers = [store, createRoomStore(redis.backend())].map(shared => createRealHandler(async () => shared, fetchVideo));
  const base = await listen(t, http.createServer((req, res) => handlers[index++ % 2](req, res)));
  const host = client(base), guest = client(base), outsider = client(base);
  const created = await host.call('/api/rooms', { title: '검증된 신청', name: '방장' });
  const path = '/api/rooms/' + created.data.id;
  await guest.call(path + '/join', { name: '참여자' });
  assert.equal((await outsider.call(path + '/songs', { videoId: 'abcdefghijk' })).status, 401);
  assert.equal(calls, 0);
  const first = await host.call(path + '/songs', { videoId: 'abcdefghijk', title: '음악으로 위장한 제목', channelId: 'forged', categoryId: '10' });
  assert.equal(first.status, 200);
  assert.equal(first.data.current.title, 'YouTube에서 확인한 제목');
  assert.equal(first.data.current.channelId, 'UCverified');
  assert.equal(first.data.current.addedByDevice, undefined);
  const results = await Promise.all(['lmnopqrstuv', '12345678901'].map(videoId => guest.call(path + '/songs', { videoId })));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 429]);
  assert.equal(calls, 2);
  await guest.call(path + '/leave', {});
  await guest.call(path + '/join', { name: '재입장' });
  assert.equal((await guest.call(path + '/songs', { videoId: 'z2345678901' })).status, 429);
  assert.equal(calls, 2);
  redis.tick(30001);
  category = '22';
  assert.equal((await guest.call(path + '/songs', { videoId: 'z2345678901', categoryId: '10' })).status, 400);
  category = '10';
  assert.equal((await guest.call(path + '/songs', { videoId: 'z2345678901' })).status, 429);
  assert.equal(calls, 3);
  assert.equal((await host.call(path)).data.queue.length, 1);
  redis.tick(30001);
  assert.equal((await guest.call(path + '/songs', { videoId: 'z2345678901' })).status, 200);
  redis.tick(30001);
  assert.equal((await guest.call(path + '/songs', { videoId: 'y2345678901' })).status, 200);
  await guest.call(path + '/leave', {});
  await guest.call(path + '/join', { name: '다시 재입장' });
  redis.tick(30001);
  assert.equal((await guest.call(path + '/songs', { videoId: 'x2345678901' })).status, 429);
  assert.equal((await host.call(path)).data.queue.length, 3);
  const pending = (await host.call(path)).data.queue[0];
  assert.equal((await guest.call(path + '/remove-song', { songId: pending.id })).status, 403);
  await host.call(path + '/votes', { songId: pending.id, value: 1 });
  const before = await store.getRoom(created.data.id);
  const removed = await host.call(path + '/remove-song', { songId: pending.id });
  assert.equal(removed.status, 200);
  assert.equal(removed.data.queue.length, 2);
  assert.deepEqual(removed.data.playback, first.data.playback);
  const after = await store.getRoom(created.data.id);
  assert.ok(Object.values(after.votes).every(votes => !Object.hasOwn(votes, pending.id)));
  assert.equal(after.current.id, before.current.id);
  assert.equal((await host.call(path + '/remove-song', { songId: pending.id })).status, 409);
  assert.equal((await host.call(path + '/remove-song', { songId: first.data.current.id })).status, 409);
  assert.equal((await guest.call(path + '/songs', { videoId: 'x2345678901' })).status, 200);
  const state = (await outsider.call(path)).data;
  assert.ok(!JSON.stringify(state).includes('addedByDevice'));
  await host.call(path + '/skip', { songId: state.current.id, value: true });
  const advanced = (await guest.call(path + '/skip', { songId: state.current.id, value: true })).data;
  assert.ok(!JSON.stringify(advanced).includes('addedByDevice'));
  assert.equal(advanced.history.length, 1);
});

test('동시 신청에도 개인 대기곡은 3곡을 넘지 않는다', async t => {
  const redis = emulator(), store = createRoomStore(redis.backend());
  const handlers = [store, createRoomStore(redis.backend())].map(shared => createHandler(async () => shared));
  let index = 0;
  const base = await listen(t, http.createServer((req, res) => handlers[index++ % 2](req, res)));
  const host = client(base), guest = client(base);
  const created = await host.call('/api/rooms', { title: '동시 대기곡', name: '방장' });
  const path = '/api/rooms/' + created.data.id;
  await guest.call(path + '/join', { name: '참여자' });
  await host.call(path + '/songs', { videoId: 'abcdefghijk', title: '현재 곡' });
  const results = await Promise.all(['lmnopqrstuv', '12345678901', 'z2345678901', 'y2345678901'].map(videoId => guest.call(path + '/songs', { videoId })));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 200, 200, 429]);
  assert.equal((await host.call(path)).data.queue.length, 3);
});

test('대기곡 삭제 버튼은 방장에게만 표시되고 중복 클릭을 막으며 완료 후 풀린다', async () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const renderSource = source.slice(source.indexOf('function renderRoom()'), source.indexOf('function decodeTitle('));
  for (const isCreator of [true, false]) {
    const elements = new Map(), button = { dataset: { remove: 'pending-song' }, disabled: false }, calls = [];
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const get = selector => {
      if (!elements.has(selector)) elements.set(selector, { textContent: '', innerHTML: '', dataset: { mode: 'request' }, insertAdjacentHTML() {} });
      return elements.get(selector);
    };
    const context = {
      room: { isCreator, id: '123456', title: '삭제 버튼', me: { id: 'member' }, members: [], current: null, queue: [{ id: 'pending-song', videoId: 'abcdefghijk', title: '대기곡', addedByName: '신청자', likes: 0, passes: 0, myVote: 0 }] },
      $: get, document: { querySelectorAll: selector => selector === '[data-remove]' && get('#queue').innerHTML.includes('data-remove=') ? [button] : [] },
      esc: value => value, renderLocalPlayback() {}, notify: message => calls.push(message), safe: fn => fn(),
      act: async (action, input) => { calls.push([action, input.songId]); await pending; },
    };
    runInNewContext(renderSource, context);
    context.renderRoom();
    assert.equal(get('#queue').innerHTML.includes('data-remove="pending-song"'), isCreator);
    if (isCreator) {
      const deleting = button.onclick();
      assert.equal(button.disabled, true);
      assert.deepEqual(calls[0], ['remove-song', 'pending-song']);
      finish(); await deleting;
      assert.equal(button.disabled, false);
      assert.equal(calls[1], '대기곡을 삭제했어요.');
    } else assert.equal(button.onclick, undefined);
  }
});

test('감상 요약은 직접 평가한 곡만 세고 이유는 좋아한 곡에서 중복 없이 집계한다', () => {
  assert.deepEqual(summarizeReflections([]), { total: 0, counts: { like: 0, neutral: 0, dislike: 0 }, reasons: { melody: 0, lyrics: 0, memory: 0, atmosphere: 0 }, topReasons: [] });
  const summary = summarizeReflections([
    { rating: 'like', reasons: ['melody', 'melody', 'lyrics'] },
    { rating: 'neutral', reasons: ['memory'] },
    { rating: 'dislike', reasons: ['atmosphere'] },
    { rating: 'like', reasons: [] },
  ]);
  assert.equal(summary.total, 4);
  assert.deepEqual(summary.counts, { like: 2, neutral: 1, dislike: 1 });
  assert.deepEqual(summary.reasons, { melody: 1, lyrics: 1, memory: 0, atmosphere: 0 });
  assert.deepEqual(summary.topReasons, ['melody', 'lyrics']);
});

test('같은 브라우저의 감상은 수정·재입장해도 하나이며 다른 사람에게 개인 응답을 노출하지 않는다', async t => {
  const redis = emulator(), store = createRoomStore(redis.backend());
  const base = await listen(t, http.createServer(createHandler(async () => store)));
  const host = client(base), guest = client(base), stranger = client(base);
  const created = await host.call('/api/rooms', { title: '감상 모임', name: '방장' });
  const path = '/api/rooms/' + created.data.id;
  await guest.call(path + '/join', { name: '참여자' });
  const first = (await host.call(path + '/songs', { videoId: 'abcdefghijk', title: '처음 들은 곡' })).data.current;
  const queued = (await guest.call(path + '/songs', { videoId: 'lmnopqrstuv', title: '아직 안 들은 곡' })).data.queue[0];
  await guest.call(path + '/votes', { songId: queued.id, value: 1 });
  assert.equal((await guest.call(path)).data.reflections.personal.total, 0);
  assert.equal((await stranger.call(path + '/reflections', { songId: first.id, rating: 'like', reasons: [] })).status, 401);
  assert.equal((await guest.call(path + '/reflections', { songId: queued.id, rating: 'like', reasons: [] })).status, 409);
  assert.equal((await guest.call(path + '/reflections', { songId: first.id, rating: 'unknown', reasons: [] })).status, 400);
  assert.equal((await guest.call(path + '/reflections', { songId: { toString: null }, rating: 'like', reasons: [] })).status, 400);
  assert.equal((await guest.call(path + '/reflections', { songId: first.id, rating: 'like', reasons: ['not-a-reason'] })).status, 400);
  assert.equal((await guest.call(path + '/reflections', { songId: first.id, rating: 'neutral', reasons: ['lyrics'] })).status, 400);
  let response = await guest.call(path + '/reflections', { songId: first.id, rating: 'like', reasons: ['melody', 'melody'] });
  assert.equal(response.status, 200);
  assert.equal(response.data.current.id, first.id);
  assert.equal(response.data.queue[0].likes, 1);
  assert.deepEqual(response.data.reflections.mine[0].reasons, ['melody']);
  await guest.call(path + '/leave', {});
  await guest.call(path + '/join', { name: '바뀐 닉네임' });
  response = await guest.call(path + '/reflections', { songId: first.id, rating: 'dislike', reasons: [] });
  assert.equal(response.data.reflections.mine.length, 1);
  assert.equal(response.data.reflections.personal.counts.like, 0);
  assert.equal(response.data.reflections.personal.counts.dislike, 1);
  assert.equal(response.data.reflections.personal.reasons.melody, 0);
  const hostState = (await host.call(path)).data;
  assert.equal(hostState.reflections.mine.length, 0);
  assert.equal(hostState.reflections.group.respondents, 1);
  const publicState = (await stranger.call(path)).data;
  assert.equal(publicState.reflections, null);
  assert.ok(!JSON.stringify(publicState).includes('participants'));
  assert.ok(!JSON.stringify(hostState).includes('addedByDevice'));
});

test('분산 감상 저장은 동시 응답·중복 수정과 공통점·차이 집계를 보존한다', async t => {
  const redis = emulator(), stores = [createRoomStore(redis.backend()), createRoomStore(redis.backend())];
  let index = 0;
  const handlers = stores.map(store => createHandler(async () => store));
  const base = await listen(t, http.createServer((req, res) => handlers[index++ % 2](req, res)));
  const host = client(base), a = client(base), b = client(base);
  const created = await host.call('/api/rooms', { title: '서로 다른 감상', name: '방장' });
  const path = '/api/rooms/' + created.data.id;
  await Promise.all([a.call(path + '/join', { name: 'A' }), b.call(path + '/join', { name: 'B' })]);
  const song = (await host.call(path + '/songs', { videoId: 'abcdefghijk', title: '공통 곡' })).data.current;
  const input = { songId: song.id, rating: 'like', reasons: ['lyrics'] };
  const saved = await Promise.all([a.call(path + '/reflections', input), a.call(path + '/reflections', input), b.call(path + '/reflections', input)]);
  assert.ok(saved.every(result => result.status === 200));
  let report = (await host.call(path)).data.reflections;
  assert.equal(report.personal.total, 0);
  assert.equal(report.group.respondents, 2); // The host's missing response is not an inferred like.
  assert.equal(report.group.shared[0].total, 2);
  assert.equal(report.group.shared[0].like, 2);
  assert.equal(report.group.different.length, 0);
  await b.call(path + '/reflections', { ...input, rating: 'dislike', reasons: [] });
  report = (await a.call(path)).data.reflections;
  assert.equal(report.mine.length, 1);
  assert.equal(report.group.shared.length, 0);
  assert.equal(report.group.different[0].like, 1);
  assert.equal(report.group.different[0].dislike, 1);
  assert.ok(redis.conflicts > 0);
});

test('모임 종료는 방장만 가능하고 재생을 멈추며 종료 후 감상과 24시간 보관을 허용한다', async t => {
  const redis = emulator(), store = createRoomStore(redis.backend());
  const base = await listen(t, http.createServer(createHandler(async () => store)));
  const host = client(base), guest = client(base), stranger = client(base);
  const created = await host.call('/api/rooms', { title: '마칠 모임', name: '방장' });
  const path = '/api/rooms/' + created.data.id;
  await guest.call(path + '/join', { name: '참여자' });
  const first = (await host.call(path + '/songs', { videoId: 'abcdefghijk', title: '감상할 곡' })).data.current;
  const player = await attachPlayer(host, path, first.id);
  await player('progress', { status: 'playing', position: 24 });
  assert.equal((await guest.call(path + '/finish', {})).status, 403);
  assert.equal((await stranger.call(path + '/finish', {})).status, 403);
  const finished = (await host.call(path + '/finish', {})).data;
  assert.ok(finished.endedAt);
  assert.equal(finished.playback.status, 'idle');
  assert.equal(finished.playback.paused, true);
  assert.equal(finished.playback.position, 24);
  assert.equal(finished.playback.startedAt, null);
  const again = (await host.call(path + '/finish', {})).data;
  assert.equal(again.endedAt, finished.endedAt);
  assert.equal(again.playback.revision, finished.playback.revision);
  assert.equal((await player('progress', { status: 'playing', position: 25 })).status, 409);
  assert.equal((await guest.call(path + '/songs', { videoId: 'lmnopqrstuv' })).status, 409);
  assert.equal((await guest.call(path + '/skip', { songId: first.id, value: true })).status, 409);
  assert.equal((await stranger.call(path + '/join', { name: '뒤늦은 참여' })).status, 409);
  await guest.call(path + '/leave', {});
  const report = await guest.call(path + '/reflections', { songId: first.id, rating: 'like', reasons: ['memory'] });
  assert.equal(report.status, 200);
  assert.equal(report.data.reflections.personal.reasons.memory, 1);
  assert.equal((await stranger.call(path + '/reflections', { songId: first.id, rating: 'like', reasons: [] })).status, 401);
  await host.call(path + '/leave', {});
  const ttlCommands = redis.commands.filter(args => args[0] === 'EVAL' && args.at(-1) !== 'KEEP');
  assert.equal(ttlCommands.at(-1).at(-1), 86400);
  redis.tick(91000);
  assert.equal((await guest.call(path)).status, 200);
  assert.equal((await stranger.call(path)).data.reflections, null);
  redis.tick(86400000);
  assert.equal((await guest.call(path)).status, 404);
});

test('재생 이력에서 빠진 내 감상은 보존하고 수정하며 감상 수 상한은 새 기록에만 적용한다', () => {
  const device = 'private-device';
  const room = { members: [{ device }], current: { id: 'original', videoId: 'abcdefghijk', title: '첫 곡', artist: '가수' }, history: [] };
  recordReflection(room, device, { songId: 'original', rating: 'like', reasons: ['melody'] });
  room.current = null;
  for (let index = 0; index < 199; index++) room.reflections[device][`other-${index}`] = { song: { id: `other-${index}` }, rating: 'neutral', reasons: [], updatedAt: index };
  recordReflection(room, device, { songId: 'original', rating: 'neutral', reasons: [] });
  const result = reflectionSnapshot(room, device);
  assert.equal(result.mine.length, 200);
  assert.ok(result.tracks.some(song => song.id === 'original'));
  assert.equal(result.personal.counts.like, 0);
  room.current = { id: 'new', title: '한도 밖 새 곡' };
  assert.throws(() => recordReflection(room, device, { songId: 'new', rating: 'like', reasons: [] }), /최대 200곡/);
});

test('브라우저 기록은 모임별 갱신·최근 20개 보관을 하며 저장 거절과 깨진 데이터를 처리한다', () => {
  const map = new Map();
  const storage = { getItem: key => map.get(key) || null, setItem: (key, value) => map.set(key, value) };
  const report = id => ({ listeningId: String(id), title: '모임 ' + id, reflections: { mine: [] } });
  for (let index = 0; index < 23; index++) assert.equal(rememberReport(storage, report(index)), true);
  assert.equal(readReports(storage).length, 20);
  assert.equal(readReports(storage)[0].listeningId, '22');
  const updated = { ...report(20), title: '수정된 요약' };
  rememberReport(storage, updated);
  assert.equal(readReports(storage).length, 20);
  assert.equal(readReports(storage)[0].title, '수정된 요약');
  assert.equal(readReports(storage).filter(item => item.listeningId === '20').length, 1);
  const denied = { getItem() { throw Error('disabled'); }, setItem() { throw Error('disabled'); } };
  assert.equal(rememberReport(denied, report(1)), false);
  assert.deepEqual(readReports(denied), []);
  map.set(REPORT_STORAGE_KEY, '{broken');
  assert.deepEqual(readReports(storage), []);
  map.set(REPORT_STORAGE_KEY, '{}');
  assert.deepEqual(readReports(storage), []);
});
