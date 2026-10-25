import { REFLECTION_REASONS, REFLECTION_RATINGS, summarizeReflections } from '../public/reflections.js';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const songInfo = song => ({ id: song.id, videoId: song.videoId, title: song.title, artist: song.artist || 'YouTube' });
export const hasParticipated = (room, device) => Boolean(room.participants?.[device] || room.members.some(member => member.device === device));

export function recordReflection(room, device, input) {
  if (typeof input.songId !== 'string' || !input.songId || input.songId.length > 100 || typeof input.rating !== 'string' || !Object.hasOwn(REFLECTION_RATINGS, input.rating) || !Array.isArray(input.reasons) || input.reasons.length > 4 || input.reasons.some(reason => typeof reason !== 'string' || !Object.hasOwn(REFLECTION_REASONS, reason))) fail('감상과 이유를 확인해 주세요.');
  if (input.rating !== 'like' && input.reasons.length) fail('좋았던 이유는 좋았어요를 선택했을 때 기록할 수 있어요.');
  const previous = room.reflections?.[device] || {};
  const song = [room.current, ...room.history].find(song => song?.id === input.songId) || previous[input.songId]?.song;
  if (!song) fail('현재 곡이나 최근에 재생한 곡에만 감상을 남길 수 있어요.', 409);
  if (!previous[input.songId] && Object.keys(previous).length >= 200) fail('한 모임에서 감상은 최대 200곡까지 기록할 수 있어요.');
  const reviews = ((room.reflections ||= {})[device] ||= {});
  reviews[input.songId] = { song: songInfo(song), rating: input.rating, reasons: [...new Set(input.reasons)], updatedAt: Date.now() };
}

export function reflectionSnapshot(room, device) {
  if (!hasParticipated(room, device)) return null;
  const mine = Object.values(room.reflections?.[device] || {}).sort((a, b) => b.updatedAt - a.updatedAt || a.song.id.localeCompare(b.song.id));
  const bySong = new Map();
  let respondents = 0;
  for (const reviews of Object.values(room.reflections || {})) {
    if (Object.keys(reviews).length) respondents++;
    for (const review of Object.values(reviews)) {
      const item = bySong.get(review.song.id) || { song: review.song, total: 0, like: 0, neutral: 0, dislike: 0 };
      item.total++; item[review.rating]++;
      bySong.set(review.song.id, item);
    }
  }
  const groupSongs = [...bySong.values()].sort((a, b) => b.total - a.total || a.song.id.localeCompare(b.song.id));
  const unique = new Map();
  for (const song of [room.current, ...[...room.history].reverse(), ...mine.map(review => review.song)]) if (song && !unique.has(song.id)) unique.set(song.id, songInfo(song));
  return {
    mine, tracks: [...unique.values()], personal: summarizeReflections(mine),
    group: { respondents, ratedSongs: groupSongs.length, shared: groupSongs.filter(item => item.total >= 2 && item.like === item.total), different: groupSongs.filter(item => item.like > 0 && item.dislike > 0) },
  };
}
