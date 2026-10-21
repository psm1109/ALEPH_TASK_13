// Only unavailable/private videos and denied embedding justify an automatic skip.
export function youtubeError(code) {
  if (code !== 'api' && (!Number.isSafeInteger(code) || code < 0 || code > 10000)) code = 0;
  const errors = {
    100: ['unavailable', true, '삭제되었거나 비공개인 영상이에요. 다음 곡으로 넘어가요.'],
    101: ['restricted', true, '외부 사이트에서 재생할 수 없는 영상이에요. 다음 곡으로 넘어가요.'],
    150: ['restricted', true, '외부 사이트에서 재생할 수 없는 영상이에요. 다음 곡으로 넘어가요.'],
    2: ['request', false, '영상 재생 요청을 처리하지 못했어요. 다시 시도해 주세요.'],
    5: ['player', false, '플레이어에서 음악을 재생하지 못했어요. 다시 시도해 주세요.'],
    153: ['configuration', false, 'YouTube 연결 정보를 확인하지 못했어요. 다시 시도해 주세요.'],
    api: ['api', false, 'YouTube 플레이어를 불러오지 못했어요. 연결을 확인하고 다시 시도해 주세요.'],
  };
  const [kind, skip, message] = (Object.hasOwn(errors, code) ? errors[code] : null) || ['unknown', false, '재생 중 오류가 발생했어요. 곡을 유지하고 있으니 다시 시도해 주세요.'];
  return { code, kind, skip, message };
}

// One pending request is shared; failure removes its script and resets the cache.
// Wrap Window timers so the helper object is never passed as their receiver.
export function createYoutubeLoader(environment, document, timers = { setTimeout: (...args) => setTimeout(...args), clearTimeout: (...args) => clearTimeout(...args) }) {
  let pending = null;
  return function loadYoutube() {
    if (environment.YT?.Player) return Promise.resolve();
    if (pending) return pending;
    const attempt = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const previousReady = environment.onYouTubeIframeAPIReady;
      let settled = false, timeout;
      const finish = error => {
        if (settled) return;
        settled = true;
        timers.clearTimeout(timeout);
        script.onerror = null;
        if (environment.onYouTubeIframeAPIReady === ready) environment.onYouTubeIframeAPIReady = previousReady;
        if (error) { script.remove(); reject(error); }
        else resolve();
      };
      const ready = () => {
        if (settled || !environment.YT?.Player) return;
        finish();
        if (typeof previousReady === 'function') previousReady();
      };
      environment.onYouTubeIframeAPIReady = ready;
      script.src = 'https://www.youtube.com/iframe_api';
      script.onerror = () => finish(Error(youtubeError('api').message));
      timeout = timers.setTimeout(() => finish(Error('YouTube 플레이어 응답이 늦어지고 있어요. 다시 시도해 주세요.')), 15000);
      try { document.head.append(script); } catch (error) { finish(error); }
    });
    const cached = attempt.catch(error => { if (pending === cached) pending = null; throw error; });
    pending = cached;
    return cached;
  };
}
