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
export function advance(room) {
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
  room.playback = { status: room.current ? 'playing' : 'idle', revision: room.playback.revision + 1 };
}

export function refreshPresence(room, now = Date.now()) {
  const active = room.members.filter(member => now - member.lastSeen < 90000);
  const activeIds = new Set(active.map(member => member.id));
  room.members = active;
  for (const id of Object.keys(room.votes)) if (!activeIds.has(id)) delete room.votes[id];
  for (const id of Object.keys(room.skipVotes)) if (!activeIds.has(id)) delete room.skipVotes[id];
  if (!activeIds.has(room.playerId)) {
    room.playerId = active[0]?.id || null;
    room.playback.revision++;
  }
  if (room.current && active.length && Object.keys(room.skipVotes).length >= Math.floor(active.length / 2) + 1) advance(room);
}
