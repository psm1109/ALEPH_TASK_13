import { youtubeError } from '../public/youtube.js';
import { randomBytes, randomInt, createHash } from 'node:crypto';
import { queue, advance, voteCounts, refreshPresence, settlePlayback, creatorConnection, PLAYBACK_LEASE_MS } from '../room.js';
import { getStore, DELETE_ROOM, UNCHANGED } from './storage.js';
import { securityHeaders } from './security.js';
const id = () => randomBytes(16).toString('hex');
const hash = value => createHash('sha256').update(value).digest('hex');
function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function field(value, label, max = 60) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(`${label}을(를) 1~${max}자로 입력해 주세요.`);
  return value.trim();
}
async function body(req) {
  function parse(raw) {
    try {
      const value = typeof raw === 'string' || Buffer.isBuffer(raw) ? JSON.parse(raw.toString()) : raw;
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
      if (Buffer.byteLength(JSON.stringify(value)) > 16384) fail('입력이 너무 큽니다.', 413);
      return value;
    } catch (error) { if (error.status) throw error; fail('입력 형식을 확인해 주세요.'); }
  }
  // Vercel may have parsed the request stream before invoking this handler.
  if (req.body !== undefined) return parse(req.body);
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 16384) fail('입력이 너무 큽니다.', 413); chunks.push(chunk); }
  return parse(Buffer.concat(chunks));
}
export function videoId(value) {
  if (typeof value !== 'string') return null;
  if (/^[\w-]{11}$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    let candidate;
    if (url.hostname === 'youtu.be') candidate = url.pathname.slice(1);
    else if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) {
      candidate = url.pathname === '/watch' ? url.searchParams.get('v') : url.pathname.match(/^\/(?:embed|shorts)\/([\w-]{11})$/)?.[1];
    }
    return /^[\w-]{11}$/.test(candidate || '') ? candidate : null;
  } catch { return null; }
}
function snapshot(room, device) {
  const me = room.members.find(m => m.device === device);
  const { sessionId, sequence, ...playback } = room.playback;
  return {
    id: room.id, title: room.title, stateVersion: room.stateVersion || 1, members: room.members.map(m => ({ id: m.id, name: m.name })),
    isCreator: Boolean(me && device === room.creatorDevice),
    me: me ? { id: me.id, name: me.name } : null, serverTime: Date.now(),
    queue: queue(room).map(s => ({ ...s, ...voteCounts(room, s.id), myVote: room.votes[me?.id]?.[s.id] || 0 })),
    current: room.current ? { ...room.current, skipCount: Object.keys(room.skipVotes).length, mySkip: Boolean(room.skipVotes[me?.id]) } : null,
    threshold: Math.floor(room.members.length / 2) + 1,
    playback, creatorConnection: creatorConnection(room), history: room.history.slice(-8).reverse(),
    searchEnabled: Boolean(process.env.YOUTUBE_API_KEY),
  };
}
export function createHandler(storeProvider = getStore, youtubeFetch = fetch) {
return async function handler(req, res) {
  const json = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  try {
    securityHeaders(res);
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/index') {
      const route = url.searchParams.get('__route') || req.query?.__route || '';
      url.pathname = `/api/${route}`;
    }
    const cookie = req.headers.cookie?.match(/(?:^|;\s*)listening_device=([a-f0-9]{32})(?:;|$)/)?.[1];
    const rawDevice = cookie || id();
    const secureCookie = process.env.COOKIE_SECURE === '1' || Boolean(process.env.VERCEL);
    if (!cookie) res.setHeader('Set-Cookie', `listening_device=${rawDevice}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secureCookie ? '; Secure' : ''}`);
    const device = hash(rawDevice);
    if (req.method === 'POST' && req.headers.origin) {
      let origin; try { origin = new URL(req.headers.origin); } catch { fail('잘못된 요청입니다.', 403); }
      if (origin.host !== req.headers.host) fail('다른 사이트에서 보낸 요청입니다.', 403);
    }
    if (url.pathname.startsWith('/api/')) {
      const match = url.pathname.match(/^\/api\/rooms(?:\/(\d{6})(?:\/(join|songs|votes|skip|control|search|heartbeat|leave))?)?$/);
      if (!match) fail('주소를 찾을 수 없습니다.', 404);
      const [, roomId, action] = match;
      const store = await storeProvider();
      if (!roomId && req.method === 'POST') {
        const input = await body(req);
        const member = { id: id(), device, name: field(input.name, '닉네임', 20), lastSeen: Date.now() };
        const room = { id: '', title: field(input.title, '방 이름'), creatorDevice: device, members: [member], songs: [], votes: {}, skipVotes: {}, unavailable: {}, current: null, history: [], playback: { status: 'idle', paused: false, revision: 0, position: 0, reportedAt: null, startedAt: null, leaseMs: PLAYBACK_LEASE_MS } };
        for (let attempt = 0; attempt < 5; attempt++) {
          room.id = String(randomInt(1000000)).padStart(6, '0');
          try { await store.createRoom(room); return json(snapshot(room, device), 201); }
          catch (error) { if (error.status !== 409) throw error; }
        }
        fail('방 코드를 만들지 못했어요. 다시 시도해 주세요.', 409);
      }
      if (!roomId) fail('지원하지 않는 요청입니다.', 405);
      let room = req.method === 'GET' ? await store.getRoom(roomId) : null;
      if (!action && req.method === 'GET') {
        if (settlePlayback(room)) room = await store.updateRoom(roomId, latest => settlePlayback(latest) ? undefined : UNCHANGED, { keepTtl: true });
        return json(snapshot(room, device));
      }
      const member = room?.members.find(m => m.device === device);
      if (action === 'search' && req.method === 'GET') {
        if (!member) fail('먼저 방에 참여해 주세요.', 401);
        if (!process.env.YOUTUBE_API_KEY) fail('제목 검색은 서버에 YOUTUBE_API_KEY를 설정하면 사용할 수 있어요. 지금은 유튜브 링크로 신청해 주세요.', 503);
        const q = field(url.searchParams.get('q'), '검색어', 100);
        const cached = await store.cachedSearch(q);
        if (cached) return json(cached);
        if (!await store.claimSearch(roomId, device)) fail('검색은 3초 후 다시 시도해 주세요.', 429);
        const params = new URLSearchParams({ key: process.env.YOUTUBE_API_KEY, part: 'snippet', type: 'video', videoEmbeddable: 'true', videoSyndicated: 'true', maxResults: '6', q });
        let response;
        try { response = await youtubeFetch(`https://www.googleapis.com/youtube/v3/search?${params}`, { signal: AbortSignal.timeout(10000) }); }
        catch { fail('유튜브 검색에 연결하지 못했어요. 링크로 신청하거나 잠시 후 다시 시도해 주세요.', 502); }
        if (!response.ok) fail('유튜브 검색을 사용할 수 없어요. API 설정·할당량을 확인하거나 링크로 신청해 주세요.', 502);
        let result;
        try { result = await response.json(); } catch { fail('유튜브 검색 응답을 확인하지 못했어요. 잠시 후 다시 시도해 주세요.', 502); }
        const data = { items: (result.items || []).filter(i => /^[\w-]{11}$/.test(i.id?.videoId || '')).map(i => ({ videoId: i.id.videoId, title: i.snippet.title, artist: i.snippet.channelTitle })) };
        await store.saveSearch(q, data); return json(data);
      }
      if (req.method !== 'POST') fail('지원하지 않는 요청입니다.', 405);
      const input = await body(req);
      // Each retry rechecks membership, votes and the current song from the latest record.
      const updated = await store.updateRoom(roomId, room => {
      refreshPresence(room);
      settlePlayback(room);
      const member = room.members.find(m => m.device === device);
      if (action === 'join') {
        const name = field(input.name, '닉네임', 20);
        if (member) { member.name = name; member.lastSeen = Date.now(); }
        else { if (room.members.length >= 50) fail('최대 50명까지 참여할 수 있어요.'); room.members.push({ id: id(), device, name, lastSeen: Date.now() }); }
      } else {
        if (!member) fail('먼저 방에 참여해 주세요.', 401);
        member.lastSeen = Date.now();
        if (action === 'leave') {
          room.members = room.members.filter(m => m.id !== member.id);
          if (!room.members.length) return DELETE_ROOM;
          refreshPresence(room);
          settlePlayback(room);
        } else if (action === 'heartbeat') {
          // Updating presence also renews the database TTL without a background server.
        } else
        if (action === 'songs') {
          if (room.songs.length >= 100) fail('대기열은 최대 100곡이에요.');
          const vid = videoId(input.videoId || input.url);
          if (!vid) fail('올바른 유튜브 영상 링크를 입력해 주세요.');
          if (room.songs.some(s => s.videoId === vid) || room.current?.videoId === vid) fail('이미 신청된 곡이에요. 기존 곡에 투표해 주세요.');
          room.songs.push({ id: id(), videoId: vid, title: field(input.title, '곡 제목', 160), artist: typeof input.artist === 'string' ? input.artist.trim().slice(0, 100) : '', addedBy: member.id, addedByName: member.name, createdAt: Date.now() });
          if (!room.current) advance(room);
        } else if (action === 'votes') {
          if (!room.songs.some(s => s.id === input.songId) || ![-1, 0, 1].includes(input.value)) fail('투표할 곡과 의견을 확인해 주세요.');
          (room.votes[member.id] ||= {})[input.songId] = input.value;
        } else if (action === 'skip') {
          if (!room.current || room.current.id !== input.songId) fail('현재 재생곡이 바뀌었어요. 다시 확인해 주세요.', 409);
          if (typeof input.value !== 'boolean') fail('투표 값을 확인해 주세요.');
          if (input.value) room.skipVotes[member.id] = true; else delete room.skipVotes[member.id];
          if (Object.keys(room.skipVotes).length >= Math.floor(room.members.length / 2) + 1) advance(room);
        } else if (action === 'control') {
          if (device !== room.creatorDevice) fail('음악 재생은 방을 만든 사람만 담당해요.', 403);
          if (!['attach', 'progress', 'ended', 'unavailable', 'duration', 'pause', 'resume', 'error'].includes(input.command)) fail('지원하지 않는 재생 요청입니다.');
          if (!room.current || input.songId !== room.current.id) fail('현재 곡이 바뀌었어요.', 409);
          const playback = room.playback, now = Date.now();
          if (input.command === 'duration') {
            if (!Number.isFinite(input.duration) || input.duration < 1 || input.duration > 43200) fail('유효한 영상 길이를 확인하지 못했어요.');
            if (!room.current.duration) room.current.duration = input.duration;
          } else if (input.command === 'attach') {
            if (typeof input.sessionId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(input.sessionId)) fail('재생 연결 정보를 확인해 주세요.');
            if (playback.sessionId && playback.status !== 'disconnected' && now - playback.reportedAt < PLAYBACK_LEASE_MS) {
              if (playback.sessionId !== input.sessionId) fail('다른 탭에서 음악을 재생하고 있어요.', 409);
            }
            playback.sessionId = input.sessionId;
            playback.sequence = 0;
            playback.revision++;
            playback.paused = Boolean(playback.paused || playback.status === 'paused');
            if (input.retry === true) delete playback.errorCode;
            playback.status = playback.errorCode != null ? 'error' : playback.paused ? 'paused' : 'waiting';
            playback.reportedAt = now;
            playback.startedAt = null;
          } else {
            if (playback.status === 'disconnected' || !playback.sessionId || input.sessionId !== playback.sessionId || input.revision !== playback.revision) fail('재생 연결을 다시 확인해 주세요.', 409);
            if (!Number.isSafeInteger(input.sequence) || input.sequence <= playback.sequence) fail('이전 재생 보고입니다.', 409);
            if (playback.errorCode != null && !['error', 'unavailable'].includes(input.command)) fail('재시도 버튼으로 플레이어를 다시 연결해 주세요.', 409);
            if (input.command === 'pause' || input.command === 'resume') {
              if (input.command === 'pause' && (!Number.isFinite(input.position) || input.position < 0 || input.position > (room.current.duration || 43200))) fail('유효한 재생 위치를 확인하지 못했어요.');
              if (input.command === 'pause' && !playback.paused) playback.position = input.position;
              playback.paused = input.command === 'pause';
              playback.status = playback.paused ? 'paused' : 'waiting';
              playback.startedAt = null;
              playback.reportedAt = now;
              playback.sequence = input.sequence;
            } else if (input.command === 'unavailable' || input.command === 'error') {
              if (input.errorCode !== 'api' && (!Number.isSafeInteger(input.errorCode) || input.errorCode < 0 || input.errorCode > 10000)) fail('재생 오류 정보를 확인해 주세요.');
              const error = youtubeError(input.errorCode);
              if ((input.command === 'unavailable') !== error.skip) fail('이 오류는 곡을 건너뛸 수 없어요. 다시 시도해 주세요.');
              if (error.skip) advance(room);
              else {
                playback.errorCode = input.errorCode;
                playback.status = 'error';
                playback.startedAt = null;
                playback.reportedAt = now;
                playback.sequence = input.sequence;
              }
            } else {
              if (!Number.isFinite(input.position) || input.position < 0 || input.position > (room.current.duration || 43200) + 1) fail('유효한 재생 위치를 확인하지 못했어요.');
              if (input.command === 'ended') {
                const duration = room.current.duration;
                if (!duration || playback.position < duration - Math.min(8, duration) || input.position < duration - 1) fail('실제 재생 종료를 아직 확인하지 못했어요.', 409);
                advance(room);
              } else {
                if (!['playing', 'buffering', 'paused', 'blocked', 'waiting'].includes(input.status)) fail('유효한 재생 상태를 확인하지 못했어요.');
                playback.sequence = input.sequence;
                if (!playback.paused) playback.position = Math.min(input.position, room.current.duration || 43200);
                if (input.status === 'paused') playback.paused = true;
                playback.status = playback.paused ? 'paused' : input.status;
                playback.reportedAt = now;
                playback.startedAt = playback.status === 'playing' ? now - playback.position * 1000 : null;
              }
            }
          }
        } else fail('주소를 찾을 수 없습니다.', 404);
      }
      });
      return json(updated ? snapshot(updated, device) : { deleted: true });
    }
    fail('주소를 찾을 수 없습니다.', 404);
  } catch (error) {
    if (!error.status) console.error('API request failed:', error.name);
    json({ error: error.status ? error.message : '처리 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.' }, error.status || 500);
  }
};
}
