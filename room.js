export function voteCounts(room, songId) {
  const values = room.members.map(m => room.votes[m.id]?.[songId] || 0);
  const likes = values.filter(v => v === 1).length;
  const passes = values.filter(v => v === -1).length;
  return { likes, passes, score: likes - passes };
}
export function queue(room) {
  const sorted = [...room.songs].sort((a, b) => voteCounts(room, b.id).score - voteCounts(room, a.id).score || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  if (sorted[0]?.addedBy === room.lastRequester) {
    const alternate = sorted.findIndex(s => s.addedBy !== room.lastRequester);
    if (alternate > 0) sorted.unshift(...sorted.splice(alternate, 1));
  }
  return sorted;
}
export function advance(room, startedAt = Date.now()) {
  if (room.current) {
    room.history.push(room.current);
    room.history = room.history.slice(-30);
    room.lastRequester = room.current.addedBy;
  }
  room.current = queue(room)[0] || null;
  if (room.current) {
    room.songs = room.songs.filter(s => s.id !== room.current.id);
    for (const votes of Object.values(room.votes)) delete votes[room.current.id];
  }
  room.skipVotes = {};
  room.unavailable = {};
  room.playback = { status: room.current ? 'playing' : 'idle', revision: room.playback.revision + 1, startedAt: room.current ? startedAt : null };
}

export function playbackDue(room, now = Date.now()) {
  return Boolean(room.current?.duration > 0 && Number.isFinite(room.playback.startedAt) && now >= room.playback.startedAt + room.current.duration * 1000);
}

// Advance by the room clock, even if no browser sent an ended event.
export function settlePlayback(room, now = Date.now()) {
  let changed = false;
  while (playbackDue(room, now)) {
    const nextStart = room.playback.startedAt + room.current.duration * 1000;
    advance(room, nextStart);
    changed = true;
  }
  return changed;
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
