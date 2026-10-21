import { createHash } from 'node:crypto';

// Compare and write inside Redis atomically; a stale function must not overwrite a vote.
export const COMPARE_AND_SET = `
local current = redis.call('GET', KEYS[1])
if not current then return -1 end
if current ~= ARGV[1] then return 0 end
if ARGV[2] == '' then redis.call('DEL', KEYS[1]) return 1 end
if ARGV[3] == 'KEEP' then redis.call('SET', KEYS[1], ARGV[2], 'KEEPTTL')
else redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3]) end
return 1
`;
export const ROOM_TTL = 90;
export const DELETE_ROOM = Symbol('delete-room');
export const UNCHANGED = Symbol('unchanged');
const digest = value => createHash('sha256').update(value).digest('hex');
const unavailable = message => Object.assign(new Error(message), { status: 503 });
const missing = () => Object.assign(new Error('방을 찾을 수 없거나 보관 기간이 지났어요. 새 방을 만들어 주세요.'), { status: 404 });

export function createRedisBackend({ url, token, prefix = 'sai:v1:development', fetchImpl = fetch }) {
  let endpoint;
  try { endpoint = new URL(url); } catch { throw unavailable('DB 주소 설정을 확인해 주세요.'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || !token) throw unavailable('DB 연결 설정을 확인해 주세요.');
  async function command(...args) {
    let response, data;
    try {
      response = await fetchImpl(endpoint.href, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args), signal: AbortSignal.timeout(4000), cache: 'no-store', redirect: 'error' });
      data = await response.json();
    } catch { throw unavailable('DB에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.'); }
    // Provider errors can include credentials or command data; never expose them.
    if (!response.ok || data.error || !Object.hasOwn(data, 'result')) throw unavailable('DB 요청이 거절됐어요. 연결 정보와 사용 한도를 확인해 주세요.');
    return data.result;
  }
  return {
    async read(key) { return command('GET', `${prefix}:${key}`); },
    async create(key, value, ttl) { return (await command('SET', `${prefix}:${key}`, value, 'NX', 'EX', ttl)) === 'OK'; },
    async compare(key, before, after, ttl) { return Number(await command('EVAL', COMPARE_AND_SET, 1, `${prefix}:${key}`, before, after, ttl)); },
    async put(key, value, ttl) { await command('SET', `${prefix}:${key}`, value, 'EX', ttl); },
  };
}

// Also used by integration tests to run distinct function instances against one store.
export function createRoomStore(backend) {
  return {
    async getRoom(id) {
      const value = await backend.read(`room:${id}`);
      if (value === null) throw missing();
      const record = JSON.parse(value);
      return { ...record.room, stateVersion: record.version };
    },
    async createRoom(room) {
      if (!await backend.create(`room:${room.id}`, JSON.stringify({ version: 1, room }), ROOM_TTL)) throw Object.assign(new Error('방 생성이 겹쳤어요. 다시 시도해 주세요.'), { status: 409 });
      return room;
    },
    async updateRoom(id, mutate, { keepTtl = false } = {}) {
      const deadline = Date.now() + 12000;
      for (let attempt = 0; attempt < 8 && Date.now() < deadline; attempt++) {
        const before = await backend.read(`room:${id}`);
        if (before === null) throw missing();
        const record = JSON.parse(before);
        // Mutation is synchronous and side-effect free because it can run again on conflict.
        const outcome = mutate(record.room);
        if (outcome === UNCHANGED) return { ...record.room, stateVersion: record.version };
        record.version++;
        const result = await backend.compare(`room:${id}`, before, outcome === DELETE_ROOM ? '' : JSON.stringify(record), keepTtl ? 'KEEP' : ROOM_TTL);
        if (result === 1) return outcome === DELETE_ROOM ? null : { ...record.room, stateVersion: record.version };
        if (result === -1) throw missing();
      }
      throw Object.assign(new Error('동시에 많은 요청이 들어왔어요. 잠시 후 다시 시도해 주세요.'), { status: 409 });
    },
    async cachedSearch(query) {
      const cached = await backend.read(`search:${digest(query.toLowerCase())}`);
      return cached === null ? null : JSON.parse(cached);
    },
    async saveSearch(query, result) { await backend.put(`search:${digest(query.toLowerCase())}`, JSON.stringify(result), 300); },
    async claimSearch(roomId, device) { return backend.create(`search-limit:${roomId}:${device}`, '1', 3); },
    async claimSongRequest(roomId, device, seconds) { return backend.create(`song-limit:${roomId}:${device}`, '1', seconds); },
  };
}

let storePromise;
async function initializeStore() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (url || token) {
    if (!url || !token) throw unavailable('DB 주소와 토큰을 모두 설정해 주세요.');
    const prefix = process.env.REDIS_KEY_PREFIX || `sai:v1:${process.env.VERCEL_ENV || 'development'}`;
    return createRoomStore(createRedisBackend({ url, token, prefix }));
  } else {
    if (process.env.VERCEL) throw unavailable('배포 환경에 Upstash Redis 주소와 토큰을 등록하고 다시 배포해 주세요.');
    const { createLocalBackend } = await import('./storage-local.js');
    return createRoomStore(createLocalBackend());
  }
}
export function getStore() {
  if (!storePromise) storePromise = initializeStore().catch(error => { storePromise = undefined; throw error; });
  return storePromise;
}
