import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queue, refreshPresence } from '../room.js';
import { createHandler, videoId } from '../lib/handler.js';
import { createRoomStore, createRedisBackend, COMPARE_AND_SET } from '../lib/storage.js';

function client(base) {
  let cookie = '';
  return { async call(path, data, headers = {}) {
    const response = await fetch(base + path, { method: data === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, data: await response.json() };
  } };
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
      else { if (after === '') records.delete(roomKey); else records.set(roomKey, { value: after, until: clock + ttl * 1000 }); result = 1; }
    } else assert.fail('Unexpected Redis command');
    await new Promise(resolve => setTimeout(resolve, 1));
    return { ok: true, json: async () => ({ result }) };
  };
  return { commands, records, tick(ms) { clock += ms; }, get conflicts() { return conflicts; }, backend() { return createRedisBackend({ url: 'https://redis.example.test', token: 'test-private-token', prefix: 'test:production', fetchImpl }); } };
}

test('점수·등록순과 신청자 연속 재생 방지를 반영한다', () => {
  const room = { members: [{ id: 'one' }, { id: 'two' }], votes: { one: { a: 1, b: 1 }, two: { c: -1 } }, songs: [{ id: 'a', addedBy: 'one', createdAt: 1 }, { id: 'b', addedBy: 'one', createdAt: 2 }, { id: 'c', addedBy: 'two', createdAt: 3 }], lastRequester: null };
  assert.deepEqual(queue(room).map(s => s.id), ['a', 'b', 'c']);
  room.lastRequester = 'one'; assert.deepEqual(queue(room).map(s => s.id), ['c', 'a', 'b']);
});

test('로컬: 6자리 코드·즉시 재생·한 표·과반 전환·퇴장 삭제', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sai-test-'));
  process.env.DATA_DIR = dir; process.env.NODE_ENV = 'test';
  for (const key of ['YOUTUBE_API_KEY', 'VERCEL', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN']) delete process.env[key];
  const { server } = await import('../dev-server.js');
  const base = await listen(t, server);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = client(base), a = client(base), b = client(base), stranger = client(base);
  const created = await host.call('/api/rooms', { title: '오후의 작업실', name: '재생 기기' });
  assert.equal(created.status, 201); assert.match(created.data.id, /^\d{6}$/); assert.equal(created.data.isPlayer, true);
  assert.equal(created.data.hostKey, undefined);
  const path = '/api/rooms/' + created.data.id;
  const joined = await a.call(path + '/join', { name: 'A' });
  const again = await a.call(path + '/join', { name: '다른 이름' });
  assert.equal(again.data.me.id, joined.data.me.id); assert.equal(again.data.members.length, 2);
  await b.call(path + '/join', { name: 'B' });
  const first = await host.call(path + '/songs', { url: 'https://youtu.be/abcdefghijk', title: '첫 곡' });
  assert.equal(first.data.current.videoId, 'abcdefghijk'); assert.equal(first.data.playback.status, 'playing'); assert.equal(first.data.queue.length, 0);
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
  assert.equal(publicState.isPlayer, false); assert.equal(publicState.me, null);
  assert.equal(publicState.votes, undefined); assert.ok(!JSON.stringify(publicState).includes('device'));
  assert.equal((await host.call(path + '/heartbeat', {}, { Origin: 'https://evil.test' })).status, 403);
  const saved = JSON.parse(readFileSync(join(dir, 'serverless-local.json'), 'utf8'));
  assert.equal(JSON.parse(saved['room:' + created.data.id].value).room.members.length, 3);
  assert.equal((await host.call(path + '/leave', {})).data.isPlayer, false);
  assert.equal((await a.call(path)).data.isPlayer, true); // Automatic speaker handover.
  state = (await a.call(path + '/control', { command: 'ended', songId })).data;
  assert.equal(state.current, null);
  state = (await b.call(path + '/songs', { videoId: '12345678901', title: '다시 자동 재생' })).data;
  assert.equal(state.current.title, '다시 자동 재생');
  await a.call(path + '/leave', {});
  assert.equal((await b.call(path + '/leave', {})).data.deleted, true);
  assert.equal((await stranger.call(path)).status, 404);
  assert.equal(videoId('https://www.youtube.com/shorts/abcdefghijk'), 'abcdefghijk');
  assert.equal(videoId('javascript:alert(1)'), null);
  assert.equal(videoId('https://youtube.com/playlist?list=abcdefghijk'), null);
  const home = await fetch(base); assert.equal(home.status, 200); assert.match(await home.text(), /사이/);
  assert.match(home.headers.get('content-security-policy'), /frame-src https:\/\/www.youtube.com/);
  assert.equal((await fetch(base + '/data/serverless-local.json')).status, 404);
});

test('분산 함수: 동시 투표·신청·종료의 중복 방지와 공유 검색 캐시', async t => {
  const redis = emulator();
  const stores = [createRoomStore(redis.backend()), createRoomStore(redis.backend())];
  let youtubeCalls = 0, index = 0;
  const youtubeFetch = async () => { youtubeCalls++; return { ok: true, json: async () => ({ items: [{ id: { videoId: 'abcdefghijk' }, snippet: { title: '검색된 곡', channelTitle: '가수' } }] }) }; };
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
  const ends = await Promise.all([host.call(path + '/control', { command: 'ended', songId: first.data.current.id }), host.call(path + '/control', { command: 'ended', songId: first.data.current.id })]);
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

test('접속 확인은 방 수명을 갱신하고 끊긴 재생 기기를 자동 교체한다', async t => {
  const redis = emulator(), store = createRoomStore(redis.backend());
  const base = await listen(t, http.createServer(createHandler(async () => store)));
  const host = client(base), guest = client(base);
  const created = await host.call('/api/rooms', { title: '접속 확인', name: '먼저 온 사람' });
  const path = '/api/rooms/' + created.data.id;
  await guest.call(path + '/join', { name: '남은 사람' });
  const before = await store.getRoom(created.data.id);
  await store.updateRoom(created.data.id, room => { room.members[0].lastSeen = Date.now() - 90001; });
  const renewed = await guest.call(path + '/heartbeat', {});
  assert.equal(renewed.data.members.length, 1); assert.equal(renewed.data.isPlayer, true);
  assert.notEqual((await store.getRoom(created.data.id)).playerId, before.playerId);
  redis.tick(80000); assert.equal((await guest.call(path + '/heartbeat', {})).status, 200);
  redis.tick(80000); assert.equal((await guest.call(path)).status, 200);
  const left = await guest.call(path + '/leave', {}); assert.equal(left.data.deleted, true);
  assert.equal((await guest.call(path)).status, 404);
  assert.ok(!redis.records.has('test:production:room:' + created.data.id));
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
  for (const name of ['index.html', 'app.js', 'style.css']) assert.ok(readFileSync(new URL(`../public/${name}`, import.meta.url)).length > 0);
});
