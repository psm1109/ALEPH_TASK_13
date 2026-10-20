export function voteCounts(room, songId) {
  const values = room.members.map(m => room.votes[m.id]?.[songId] || 0);
  const likes = values.filter(v => v === 1).length;
  const passes = values.filter(v => v === -1).length;
  return { likes, passes, score: likes - passes };
}
export function queue(room) {
  return [...room.songs].sort((a, b) => voteCounts(room, b.id).score - voteCounts(room, a.id).score || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}
export const PLAYBACK_LEASE_MS = 10000;

export function advance(room) {
  if (room.current) {
    room.history.push(room.current);
    room.history = room.history.slice(-30);
  }
  room.current = queue(room)[0] || null;
  if (room.current) {
    room.songs = room.songs.filter(s => s.id !== room.current.id);
    for (const votes of Object.values(room.votes)) delete votes[room.current.id];
  }
  room.skipVotes = {};
  room.unavailable = {};
  room.playback = { status: room.current ? 'waiting' : 'idle', revision: room.playback.revision + 1, position: 0, reportedAt: null, startedAt: null, leaseMs: PLAYBACK_LEASE_MS };
}

// Expire a playback lease without advancing the track or guessing unheard progress.
export function settlePlayback(room, now = Date.now()) {
  const playback = room.playback;
  if (!Number.isFinite(playback.position)) {
    room.playback = { status: room.current ? 'waiting' : 'idle', revision: playback.revision + 1, position: 0, reportedAt: null, startedAt: null, leaseMs: PLAYBACK_LEASE_MS };
    return true;
  }
  const creatorPresent = room.members.some(member => member.device === room.creatorDevice && now - member.lastSeen < 90000);
  if (room.current && playback.status !== 'disconnected' && (!creatorPresent || (Number.isFinite(playback.reportedAt) && now - playback.reportedAt >= PLAYBACK_LEASE_MS))) {
    playback.status = 'disconnected';
    playback.startedAt = null;
    return true;
  }
  return false;
}

export function creatorConnection(room, now = Date.now()) {
  const creator = room.members.find(member => member.device === room.creatorDevice);
  if (!creator || now - creator.lastSeen >= 30000) return 'disconnected';
  if (room.current && room.playback.status === 'disconnected') return Number.isFinite(room.playback.reportedAt) && now - room.playback.reportedAt >= 30000 ? 'disconnected' : 'reconnecting';
  return 'connected';
}

export function refreshPresence(room, now = Date.now()) {
  const active = room.members.filter(member => now - member.lastSeen < 90000);
  const activeIds = new Set(active.map(member => member.id));
  room.members = active;
  for (const id of Object.keys(room.votes)) if (!activeIds.has(id)) delete room.votes[id];
  for (const id of Object.keys(room.skipVotes)) if (!activeIds.has(id)) delete room.skipVotes[id];
  room.unavailable ||= {};
  for (const id of Object.keys(room.unavailable)) if (!activeIds.has(id)) delete room.unavailable[id];
  if (room.current && active.length && Math.max(Object.keys(room.skipVotes).length, Object.keys(room.unavailable).length) >= Math.floor(active.length / 2) + 1) advance(room);
}
