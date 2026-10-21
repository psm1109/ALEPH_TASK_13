export const REQUEST_INTERVAL_SECONDS = 30;
export const MAX_PENDING_SONGS = 3;

const fail = (message, status) => { throw Object.assign(new Error(message), { status }); };

// Check the video resource itself: search results and client metadata are untrusted.
export async function verifyMusicVideo(videoId, youtubeFetch = fetch) {
  if (!process.env.YOUTUBE_API_KEY) fail('곡 검증을 위해 서버에 YOUTUBE_API_KEY를 설정해 주세요.', 503);
  const params = new URLSearchParams({ key: process.env.YOUTUBE_API_KEY, part: 'snippet,status', id: videoId });
  let result;
  try {
    const response = await youtubeFetch(`https://www.googleapis.com/youtube/v3/videos?${params}`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw Error();
    result = await response.json();
  } catch { fail('영상 정보를 확인하지 못했어요. 잠시 후 다시 신청해 주세요.', 502); }
  if (!Array.isArray(result?.items)) fail('영상 정보를 확인하지 못했어요. 잠시 후 다시 신청해 주세요.', 502);
  const video = result.items.find(item => item.id === videoId);
  if (!video || video.status?.privacyStatus !== 'public' || video.status?.embeddable !== true || video.status?.uploadStatus !== 'processed') fail('공개되어 있고 앱 내 재생이 가능한 영상만 신청할 수 있어요.', 400);
  if (video.snippet?.categoryId !== '10') fail('YouTube 음악 카테고리의 영상만 신청할 수 있어요.', 400);
  if (video.snippet.liveBroadcastContent !== 'none') fail('실시간 방송이나 예정된 방송은 신청할 수 없어요.', 400);
  if (typeof video.snippet.title !== 'string' || !video.snippet.title.trim() || typeof video.snippet.channelId !== 'string') fail('영상 정보를 확인하지 못했어요. 잠시 후 다시 신청해 주세요.', 502);
  return { title: video.snippet.title.trim().slice(0, 160), artist: (video.snippet.channelTitle || '').slice(0, 100), channelId: video.snippet.channelId };
}

export function publicSong({ addedByDevice, ...song }) { return song; }

export function checkSongRequest(room, member, device, videoId) {
  if (room.songs.some(song => song.videoId === videoId) || room.current?.videoId === videoId) fail('이미 신청된 곡이에요. 기존 곡에 투표해 주세요.', 400);
  if (room.songs.length >= 100) fail('대기열은 최대 100곡이에요.', 400);
  if (room.songs.filter(song => song.addedByDevice === device || song.addedBy === member.id).length >= MAX_PENDING_SONGS) fail(`한 사람의 대기곡은 최대 ${MAX_PENDING_SONGS}곡이에요. 기존 곡이 재생되면 다시 신청해 주세요.`, 429);
}
