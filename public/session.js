// Extrapolation is only for display; expired reports restore the confirmed position.
export function positionAt(playback, serverNow) {
  const position = Math.max(0, playback?.position || 0);
  if (playback?.status !== 'playing' || !Number.isFinite(playback.reportedAt)) return position;
  const elapsed = Math.max(0, serverNow - playback.reportedAt);
  return elapsed >= playback.leaseMs ? position : position + elapsed / 1000;
}

export function playablePosition(room, serverNow) {
  const position = positionAt(room?.playback, serverNow);
  return room?.current?.duration ? Math.min(position, Math.max(0, room.current.duration - 0.1)) : position;
}

export function playbackLabel(room, now) {
  const reportAge = room?.current && Number.isFinite(room.playback.reportedAt) ? now - room.playback.reportedAt : 0;
  if (room?.creatorConnection === 'disconnected' || reportAge >= 30000) return '방장 연결 끊김';
  if (room?.creatorConnection === 'reconnecting' || (room?.current && Number.isFinite(room.playback.reportedAt) && now - room.playback.reportedAt >= room.playback.leaseMs)) return '방장 연결 확인 중';
  return ({ error: '재생 오류 · 방장 재시도 대기', playing: '함께 듣는 중', buffering: '버퍼링 중', paused: '일시정지', blocked: '재생 시작 대기', waiting: '재생 준비 중', disconnected: '방장 연결 확인 중', idle: '신청곡 대기 중' })[room?.playback.status] || '재생 준비 중';
}
