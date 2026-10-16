// Use server time anchored to the browser's monotonic clock, not its wall clock.
export function positionAt(playback, serverNow) {
  if (playback?.status !== 'playing' || !Number.isFinite(playback.startedAt)) return 0;
  return Math.max(0, (serverNow - playback.startedAt) / 1000);
}

export function playablePosition(room, serverNow) {
  const position = positionAt(room?.playback, serverNow);
  return room?.current?.duration ? Math.min(position, Math.max(0, room.current.duration - 0.1)) : position;
}
