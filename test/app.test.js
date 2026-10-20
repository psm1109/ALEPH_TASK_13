import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { queue, refreshPresence, advance, settlePlayback } from '../room.js';
import { positionAt, playablePosition } from '../public/session.js';
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
  const { server } = await import('../dev-server.js');
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
  await stores[0].updateRoom(created.data.id, room => { room.current.duration = 10; room.playback.startedAt = Date.now() - 11000; });
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

test('누가 퇴장해도 재생 시각을 유지하고 접속 확인으로 방 수명만 갱신한다', async t => {
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

test('중간 입장은 서버의 현재 위치를 받고 시간 경과만으로 다음 곡을 이어 간다', async t => {
  const redis = emulator(), store = createRoomStore(redis.backend());
  const base = await listen(t, http.createServer(createHandler(async () => store)));
  const a = client(base), b = client(base), viewer = client(base);
  const created = await a.call('/api/rooms', { title: '공유 타임라인', name: '먼저' });
  const path = '/api/rooms/' + created.data.id;
  const added = await a.call(path + '/songs', { videoId: 'abcdefghijk', title: '이미 흐르는 곡' });
  const firstId = added.data.current.id;
  assert.equal((await a.call(path + '/control', { command: 'duration', songId: firstId, duration: 0 })).status, 400);
  await a.call(path + '/control', { command: 'duration', songId: firstId, duration: 180 });
  await store.updateRoom(created.data.id, room => { room.playback.startedAt = Date.now() - 80000; });
  const late = await b.call(path + '/join', { name: '나중' });
  assert.equal(late.data.current.id, firstId);
  assert.ok(positionAt(late.data.playback, late.data.serverTime) >= 80);
  assert.ok(positionAt(late.data.playback, late.data.serverTime) < 82);
  assert.equal((await b.call(path + '/control', { command: 'ended', songId: firstId })).status, 403);
  // One browser's video error cannot skip a song for the other participant.
  const failed = await b.call(path + '/control', { command: 'unavailable', songId: firstId });
  assert.equal(failed.status, 403);
  const queued = await a.call(path + '/songs', { videoId: 'lmnopqrstuv', title: '다음 곡' });
  const nextId = queued.data.queue[0].id;
  const start = Date.now() - 185000;
  await store.updateRoom(created.data.id, room => { room.playback.startedAt = start; room.songs[0].duration = 60; });
  const ttlBefore = redis.records.get('test:production:room:' + created.data.id).until;
  // No ended event: a read computes the next track from the shared clock.
  const elapsed = await viewer.call(path);
  assert.equal(elapsed.data.current.id, nextId);
  assert.equal(elapsed.data.playback.startedAt, start + 180000);
  assert.ok(positionAt(elapsed.data.playback, elapsed.data.serverTime) >= 5);
  assert.equal(redis.records.get('test:production:room:' + created.data.id).until, ttlBefore);
  const fresh = await b.call(path);
  assert.equal(fresh.data.current.id, nextId); assert.equal(fresh.data.history.length, 1);
  redis.tick(90001); assert.equal((await viewer.call(path)).status, 404);
});

test('공유 재생 위치 계산과 지연된 여러 곡 전환을 검증한다', () => {
  const room = { members: [], votes: {}, songs: [{ id: 'a', addedBy: 'x', duration: 10, createdAt: 0 }, { id: 'b', addedBy: 'x', duration: 20, createdAt: 1 }, { id: 'c', addedBy: 'y', duration: 30, createdAt: 2 }], current: null, history: [], playback: { status: 'idle', revision: 0 }, lastRequester: null };
  advance(room, 100000);
  assert.equal(positionAt(room.playback, 108000), 8);
  assert.equal(playablePosition(room, 120000), 9.9);
  assert.equal(positionAt({ status: 'idle', startedAt: null }, 120000), 0);
  assert.equal(settlePlayback(room, 145000), true);
  // Equal scores keep registration order; starts follow track ends rather than request time.
  assert.equal(room.current.id, 'c'); assert.equal(room.playback.startedAt, 130000);
  assert.equal(positionAt(room.playback, 145000), 15);
  settlePlayback(room, 170000); assert.equal(room.current, null); assert.equal(room.playback.startedAt, null);
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
      await store.updateRoom(created.data.id, room => { room.current.duration = 1; room.playback.startedAt = Date.now() - 2000; });
      state = (await first.call(path + '/control', { command: 'ended', songId: playing.data.current.id })).data;
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
  for (const command of ['duration', 'ended', 'unavailable', 'pause', 'resume']) {
    assert.equal((await guest.call(path + '/control', { command, songId: song.id, duration: 180 })).status, 403);
  }
  assert.equal((await host.call(path)).data.isCreator, true);
  assert.equal((await host.call(path + '/control', { command: 'unavailable', songId: song.id })).data.current, null);
  await host.call(path + '/leave', {});
  assert.equal((await guest.call(path)).data.isCreator, false);
  assert.equal((await host.call(path + '/join', { name: '다시 방장' })).data.isCreator, true);
  assert.ok(!JSON.stringify((await guest.call(path)).data).includes('creatorDevice'));
});

test('일시정지 중 과반 건너뛰기는 다음 곡의 시작에서 멈추고 재생 시 처음부터 시작한다', async t => {
  const redis = emulator(), store = createRoomStore(redis.backend());
  const base = await listen(t, http.createServer(createHandler(async () => store)));
  const host = client(base), guest = client(base);
  const created = await host.call('/api/rooms', { title: '멈춘 채 건너뛰기', name: '방장' });
  const path = '/api/rooms/' + created.data.id;
  await guest.call(path + '/join', { name: '참여자' });
  const song = (await host.call(path + '/songs', { videoId: 'abcdefghijk', title: '현재 곡' })).data.current;
  const next = (await guest.call(path + '/songs', { videoId: 'lmnopqrstuv', title: '다음 곡' })).data.queue[0];
  const paused = (await host.call(path + '/control', { command: 'pause', songId: song.id, position: 45.5 })).data;
  const minority = await host.call(path + '/skip', { songId: song.id, value: true });
  assert.equal(minority.data.current.id, song.id);
  assert.deepEqual(minority.data.playback, paused.playback);
  const skipped = await guest.call(path + '/skip', { songId: song.id, value: true });
  assert.equal(skipped.status, 200);
  assert.equal(skipped.data.current.id, next.id);
  assert.equal(skipped.data.current.skipCount, 0);
  assert.deepEqual(skipped.data.playback, { status: 'paused', revision: paused.playback.revision + 1, startedAt: null, position: 0 });
  assert.equal(positionAt(skipped.data.playback, skipped.data.serverTime + 3600000), 0);
  assert.deepEqual((await host.call(path)).data.playback, skipped.data.playback);
  const frozen = structuredClone(await store.getRoom(created.data.id));
  frozen.current.duration = 1;
  assert.equal(settlePlayback(frozen, skipped.data.serverTime + 3600000), false);
  const resumed = await host.call(path + '/control', { command: 'resume', songId: next.id });
  assert.equal(resumed.data.playback.status, 'playing');
  assert.ok(positionAt(resumed.data.playback, resumed.data.serverTime) < 0.1);
  await host.call(path + '/control', { command: 'pause', songId: next.id, position: 2 });
  await host.call(path + '/skip', { songId: next.id, value: true });
  const empty = await guest.call(path + '/skip', { songId: next.id, value: true });
  assert.equal(empty.data.current, null);
  assert.equal(empty.data.playback.status, 'idle');
  assert.equal(empty.data.playback.startedAt, null);
});

test('방장이 일시정지하면 재생 위치와 자동 전환이 멈추고 같은 위치부터 재개한다', async t => {
  const redis = emulator(), store = createRoomStore(redis.backend());
  const base = await listen(t, http.createServer(createHandler(async () => store)));
  const host = client(base), guest = client(base);
  const created = await host.call('/api/rooms', { title: '멈춘 레코드', name: '방장' });
  const path = '/api/rooms/' + created.data.id;
  await guest.call(path + '/join', { name: '참여자' });
  const song = (await host.call(path + '/songs', { videoId: 'abcdefghijk', title: '현재 곡' })).data.current;
  await host.call(path + '/songs', { videoId: 'lmnopqrstuv', title: '대기곡' });
  await host.call(path + '/control', { command: 'duration', songId: song.id, duration: 180 });
  for (const position of [-1, '45', 181]) assert.equal((await host.call(path + '/control', { command: 'pause', songId: song.id, position })).status, 400);
  const paused = await host.call(path + '/control', { command: 'pause', songId: song.id, position: 45.5 });
  assert.equal(paused.status, 200);
  assert.equal(paused.data.playback.status, 'paused');
  assert.equal(paused.data.playback.startedAt, null);
  const future = paused.data.serverTime + 3600000;
  assert.equal(positionAt(paused.data.playback, future), 45.5);
  assert.equal(playablePosition(paused.data, future), 45.5);
  const frozen = structuredClone(await store.getRoom(created.data.id));
  assert.equal(settlePlayback(frozen, future), false);
  assert.equal(frozen.current.id, song.id);
  assert.equal((await host.call(path + '/control', { command: 'ended', songId: song.id })).status, 409);
  const repeated = await host.call(path + '/control', { command: 'pause', songId: song.id, position: 0 });
  assert.deepEqual(repeated.data.playback, paused.data.playback);
  const heartbeat = await guest.call(path + '/heartbeat', {});
  assert.deepEqual(heartbeat.data.playback, paused.data.playback);
  assert.deepEqual((await host.call(path)).data.playback, paused.data.playback);
  assert.equal((await host.call(path + '/control', { command: 'resume', songId: 'stale' })).status, 409);
  const resumed = await host.call(path + '/control', { command: 'resume', songId: song.id });
  assert.equal(resumed.data.playback.status, 'playing');
  assert.ok(Math.abs(positionAt(resumed.data.playback, resumed.data.serverTime) - 45.5) < 0.1);
  assert.equal(resumed.data.current.id, song.id);
  assert.equal(resumed.data.queue.length, 1);
  const resumedAgain = await host.call(path + '/control', { command: 'resume', songId: song.id });
  assert.deepEqual(resumedAgain.data.playback, resumed.data.playback);
});
