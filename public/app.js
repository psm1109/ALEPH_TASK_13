import { positionAt, playbackLabel } from './session.js';
import { youtubeError, createYoutubeLoader } from './youtube.js';
const loadYoutube = createYoutubeLoader(window, document);
const $ = selector => document.querySelector(selector);
let savedTheme;
try { savedTheme = localStorage.getItem('sai-theme'); } catch {}
function applyTheme(theme) {
  const dark = theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('#theme-toggle').setAttribute('aria-checked', String(dark));
  $('#theme-toggle span').textContent = dark ? '☾' : '☀';
  $('#theme-label').textContent = dark ? '다크 모드' : '라이트 모드';
  $('meta[name="theme-color"]').content = dark ? '#12131a' : '#f5f3ed';
}
applyTheme(['dark', 'light'].includes(savedTheme) ? savedTheme : 'dark');
$('#theme-toggle').onclick = () => {
  savedTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(savedTheme);
  try { localStorage.setItem('sai-theme', savedTheme); } catch {}
};
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const initialRoomId = new URLSearchParams(location.search).get('room');
let roomId = null;
let room = null, pollBusy = false, lastSnapshot = '', searchItems = [], player = null, playerReady = false, loadedSong = null;
let lastHeartbeat = 0, lastRefresh = 0, serverClockOffset = 0;
let localPaused = false, localBlocked = false, durationSentFor = null, durationBusy = false;
const playbackSession = crypto.randomUUID();
let claimedSong = null, claimedRevision = null, reportSequence = 0, lastPlaybackReport = 0, lastClaim = 0;
let internalPause = false, awaitingPlayback = false;
let pendingControl = null, playerFailure = null, retryingSong = null, playerReadyTimer = null;
let syncBusy = false, reportBusy = false, playbackFailure = false;
const serverNow = () => performance.now() + serverClockOffset;
let disposeLandingGuide = () => {};
function mountLandingGuide() {
  const guide = document.createElement('div');
  guide.className = 'landing-guide';
  const spacer = document.createElement('div');
  spacer.className = 'guide-scroll-space';
  spacer.setAttribute('aria-hidden', 'true');
  const footer = $('footer');
  guide.append($('.steps'), footer);
  $('#app').append(spacer, guide);
  const controller = new AbortController();
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const desktop = matchMedia('(min-width: 701px) and (min-height: 650px)');
  const copy = $('.landing-copy');
  const turntable = $('.ambient-turntable');
  const slot = document.createElement('div');
  slot.className = 'landing-copy-slot';
  copy.before(slot);
  slot.append(copy);
  let frame = 0;
  function update() {
    frame = 0;
    const height = guide.getBoundingClientRect().height;
    spacer.style.setProperty('--guide-height', `${height}px`);
    const pinned = desktop.matches && !motion.matches;
    $('.landing').classList.toggle('is-scene-pinned', pinned);
    slot.classList.toggle('is-pinned', pinned);
    // The label and the complete text block share one viewport-space center.
    const textBounds = (innerWidth <= 700 ? $('.landing-identity') : copy).getBoundingClientRect();
    turntable.style.left = `${textBounds.left + textBounds.width / 2}px`;
    turntable.style.top = `${textBounds.top + textBounds.height / 2}px`;
    const cardBottom = $('.create-card').getBoundingClientRect().bottom;
    const ready = pinned ? scrollY > 0 : scrollY > 16 && cardBottom <= innerHeight - height - 20;
    guide.classList.toggle('is-visible', ready || guide.contains(document.activeElement));
  }
  function schedule() { if (!controller.signal.aborted && !frame) frame = requestAnimationFrame(update); }
  window.addEventListener('scroll', schedule, { passive: true, signal: controller.signal });
  window.addEventListener('resize', schedule, { signal: controller.signal });
  guide.addEventListener('focusin', schedule, { signal: controller.signal });
  guide.addEventListener('focusout', schedule, { signal: controller.signal });
  motion.addEventListener('change', schedule, { signal: controller.signal });
  desktop.addEventListener('change', schedule, { signal: controller.signal });
  const observer = new ResizeObserver(schedule);
  observer.observe(guide);
  observer.observe(copy);
  document.fonts.ready.then(schedule);
  update();
  disposeLandingGuide = () => {
    controller.abort(); observer.disconnect(); cancelAnimationFrame(frame);
    document.body.insertBefore(footer, $('#notice'));
    disposeLandingGuide = () => {};
  };
}
function notify(message) { $('#notice').textContent = message; $('#notice').classList.add('show'); clearTimeout(notify.timer); notify.timer = setTimeout(() => $('#notice').classList.remove('show'), 4500); }
async function request(action = '', data, global = false, targetRoomId = roomId) {
  const path = global ? '/api/rooms' : `/api/rooms/${encodeURIComponent(targetRoomId)}${action ? '/' + action : ''}`;
  const sentAt = performance.now();
  const response = await fetch(path, { method: data === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(35000), headers: { 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const result = await response.json();
  Object.defineProperties(result, { _receivedAt: { value: performance.now() }, _roundTrip: { value: performance.now() - sentAt } });
  if (!response.ok) throw Object.assign(Error(result.error || '요청을 처리하지 못했어요.'), { status: response.status });
  return result;
}
async function act(action, data) { const result = await request(action, data); if (result.deleted) exitRoom(); else accept(result); return result; }
function stopPlayer() { $('.room-turntable')?.classList.remove('is-playing'); pendingControl = null; playerFailure = null; retryingSong = null; clearTimeout(playerReadyTimer); if (player) player.destroy(); player = null; playerReady = false; loadedSong = null; durationSentFor = null; localPaused = false; localBlocked = false; claimedSong = null; claimedRevision = null; lastClaim = 0; awaitingPlayback = false; }
function exitRoom() {
  stopPlayer(); room = null; roomId = null; lastSnapshot = ''; lastHeartbeat = 0;
  history.replaceState(null, '', '/'); document.title = '사이 — 우리 사이, 다음 한 곡'; landing();
}
async function enterRoom(code) {
  if (enterRoom.busy) return;
  enterRoom.busy = true;
  const buttons = [$('#code-form button'), $('#create-form button')].filter(Boolean);
  buttons.forEach(button => { button.disabled = true; });
  try {
    const result = await request('', undefined, false, code);
    roomId = result.id;
    history.replaceState(null, '', `?room=${roomId}`);
    shell(); accept(result);
  } catch (error) {
    if (initialRoomId && !roomId) history.replaceState(null, '', '/');
    notify(error.status === 404 ? '방이 없거나 비어 있어 삭제됐어요. 코드를 다시 확인해 주세요.' : error.message);
  } finally {
    enterRoom.busy = false;
    buttons.forEach(button => { button.disabled = false; });
  }
}
function landing() {
  disposeLandingGuide();
  // Decorative background belongs to this view and is removed when shell() renders.
  $('#app').innerHTML = `<section class="landing"><div class="landing-copy"><div class="landing-identity"><span class="eyebrow"><span class="dot"></span> A LITTLE LESS ME, A LITTLE MORE US</span><h1>내가 고른 음악이<br>우리의 음악이 되는 <em>사이</em></h1></div><p class="app-purpose">모임에서 함께 들을 음악을 고를 때, 성격만으로 서로의 취향을 단정하지 않아요. 각자 듣고 싶은 곡을 신청하고, 투표로 다음 곡을 함께 정해요.</p><div class="feature-row"><span>↗ 유튜브 곡 신청</span><span>♡ 한 곡에 한 표</span><span>♪ 함께 듣는 플레이어</span></div></div><section class="create-card"><div class="card-top"><span class="eyebrow"><span class="dot"></span> 함께 고르는 플레이리스트</span></div><h2>우리, 함께 들을까요?</h2><p class="muted">친구를 초대하고, 다음 곡을 함께 골라요.</p><form id="create-form"><label>방 이름<input name="title" placeholder="예: 오후의 작업실" maxlength="60" required></label><label>내 닉네임<input name="name" placeholder="사용할 닉네임" maxlength="20" required autocomplete="nickname"></label><button class="primary wide" type="submit">모임 만들기 <span aria-hidden="true">↗</span></button></form></section></section><section class="steps"><article><span>01 / JOIN</span><h3>방 만들기 · 참여하기</h3><p>방 이름과 닉네임으로 시작하거나<br>친구의 6자리 방 코드를 입력해요.</p></article><article><span>02 / REQUEST</span><h3>듣고 싶은 곡 신청</h3><p>곡을 검색하거나 유튜브 링크로 신청해요.<br>첫 곡은 바로 시작하고 다음 곡부터 대기해요.</p></article><article><span>03 / VOTE</span><h3>다음 곡에 한 표</h3><p>대기곡에 듣고 싶어요(+1) · 이번엔 패스(−1).<br>점수가 높은 순서로, 동점이면 신청순으로 들어요.</p></article></section>`;
  $('#app').insertAdjacentHTML('afterbegin', '<div class="landing-backdrop" aria-hidden="true"><div class="ambient-turntable"><div class="ambient-vinyl"><span class="ambient-label"></span></div></div></div>');
  $('.ambient-label').insertAdjacentHTML('beforeend', '<svg class="vinyl-lettering" viewBox="0 0 600 600" aria-hidden="true" focusable="false"><defs><path id="vinyl-label-type" d="M300 25 a275 275 0 1 1 -.01 0"/></defs><text><textPath href="#vinyl-label-type" textLength="1715" lengthAdjust="spacing">SAI / LISTEN TOGETHER · SAI / LISTEN TOGETHER · SAI / LISTEN TOGETHER · SAI / LISTEN TOGETHER · </textPath></text></svg>');
  $('#create-form').addEventListener('submit', async event => {
    event.preventDefault(); const button = event.submitter; button.disabled = true;
    try {
      const data = Object.fromEntries(new FormData(event.target));
      const result = await request('', data, true); roomId = result.id; lastHeartbeat = Date.now();
      history.replaceState(null, '', `?room=${roomId}`); shell(); accept(result);
    } catch (error) { notify(error.message); } finally { button.disabled = false; }
  });
  $('.create-card').insertAdjacentHTML('beforeend', `<div class="join-divider">초대받으셨나요?</div><form id="code-form" class="code-form"><label>방 코드<input name="code" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" placeholder="6자리 숫자" autocomplete="off" required></label><button class="outline">코드로 입장 ↗</button></form>`);
  $('#code-form').onsubmit = event => { event.preventDefault(); const code = new FormData(event.target).get('code').trim(); if (/^\d{6}$/.test(code)) enterRoom(code); };
  mountLandingGuide();
}
function shell() {
  disposeLandingGuide();
  $('#app').innerHTML = `<section class="room-heading"><h1 id="room-title">모임에 연결 중…</h1><button id="invite" class="outline">초대 링크 ↗</button></section><div id="connection" class="connection" role="status"></div><div class="room-grid"><section class="left-column"><article class="panel player-panel"><div class="panel-heading"><span class="eyebrow">NOW PLAYING</span><span class="badge" id="player-role"></span></div><div class="room-turntable"><div class="room-vinyl" aria-hidden="true"><div class="room-vinyl-label"><span>SAI</span><small>LISTEN TOGETHER</small></div></div><img class="tonearm" src="/tonearm.svg" alt="" draggable="false"><div id="player-stage" aria-hidden="true" inert hidden><div id="youtube-player"></div></div></div><div id="transport-controls" class="transport-controls" hidden><button id="play-song" class="primary" type="button">▶ 재생</button><button id="pause-song" class="outline" type="button">Ⅱ 일시정지</button></div><p id="host-status" class="small muted" role="status"></p><div id="current-info"></div><p id="player-message" class="small muted" role="status"></p><button id="retry-playback" class="outline" type="button" hidden>↻ 재시도</button><div id="play-controls"></div></article><article class="panel request-panel"><div class="panel-heading"><h2>곡 신청</h2><button class="help-button" type="button" data-room-help aria-label="곡 신청 안내">?</button></div><div id="request-content"></div></article></section><aside class="right-column"><section class="panel queue-panel"><div class="panel-heading"><h2>다음 곡 <span id="queue-count" class="count">0</span></h2><button class="help-button" type="button" data-room-help aria-label="대기열과 투표 안내">?</button></div><div id="queue"></div><nav id="queue-pagination" class="queue-pagination" aria-label="대기곡 페이지" hidden><button id="queue-prev" class="outline" type="button" aria-label="이전 대기곡">←</button><span id="queue-page" aria-live="polite"></span><button id="queue-next" class="outline" type="button" aria-label="다음 대기곡">→</button></nav></section><section class="panel people-panel"><div class="panel-heading"><h2>함께 듣는 사람</h2><button id="people-count" class="quiet" type="button" aria-haspopup="dialog" aria-label="전체 참여자 보기"></button></div><div id="people"></div></section></aside></div>`;
  $('#app').insertAdjacentHTML('afterbegin', '<div class="room-backdrop" aria-hidden="true"></div>');
  renderQueue.page = 0;
  document.querySelectorAll('[data-room-help]').forEach(button => button.onclick = () => $('#rules').showModal());
  $('#people-count').onclick = () => $('#people-dialog').showModal();
  $('#retry-playback').onclick = () => safe(retryPlayback);
  $('#play-song').onclick = () => controlPlayback('resume');
  $('#pause-song').onclick = () => controlPlayback('pause');
  $('#invite').onclick = async () => {
    const url = new URL(location.href); url.search = `?room=${roomId}`;
    try { await navigator.clipboard.writeText(url.href); notify('초대 링크를 복사했어요. 함께 들을 사람에게 보내 주세요.'); }
    catch { prompt('아래 초대 링크를 복사해 주세요.', url.href); }
  };
  $('#invite').parentElement.insertAdjacentHTML('beforeend', '<div class="room-tools"><button id="copy-code" class="outline">방 코드 <b id="room-code"></b> ⧉</button><button id="leave-room" class="quiet">퇴장하기 ↗</button></div>');
  $('#copy-code').onclick = async () => { try { await navigator.clipboard.writeText(roomId); notify('방 코드를 복사했어요.'); } catch { prompt('방 코드', roomId); } };
  $('#leave-room').onclick = () => safe(async () => { if (room?.me) await request('leave', {}); exitRoom(); });
  // Presence renewal runs separately from visible-screen polling.
  lastHeartbeat = 0;
}
function accept(next) {
  if (next.id !== roomId) return;
  if (room && next.id === room.id && next.stateVersion < room.stateVersion) return;
  if (Number.isFinite(next.serverTime)) serverClockOffset = next.serverTime + (next._roundTrip || 0) / 2 - (next._receivedAt || performance.now());
  room = next; const { serverTime, ...view } = next; const serialized = JSON.stringify(view);
  if (serialized !== lastSnapshot) { renderRoom(); lastSnapshot = serialized; }
  syncPlayer();
}
function renderRoom() {
  $('#room-title').textContent = room.title;
  document.title = `${room.title} — 사이`;
  $('#room-code').textContent = room.id;
  $('#player-role').textContent = room.isCreator ? '방장 · 음악 재생' : '방장 기기에서 음악 재생';
  $('#queue-count').textContent = room.queue.length;
  $('#people-count').textContent = `${room.members.length}명 ↗`;
  const personMarkup = m => `<span class="person" title="${esc(m.name)}"><span class="avatar">${m.id === room.me?.id ? '나' : esc(m.name.slice(0, 1))}</span><span class="person-name">${esc(m.name)}</span></span>`;
  $('#people').innerHTML = room.members.slice(0, 3).map(personMarkup).join('');
  $('#people-list').innerHTML = room.members.map(personMarkup).join('');
  const song = room.current;
  $('#current-info').innerHTML = song ? `<h2 title="${esc(song.title)}">${esc(song.title)}</h2><p class="muted">${esc(song.artist || 'YouTube')} · ${esc(song.addedByName)} 신청</p><a class="external small" href="https://www.youtube.com/watch?v=${song.videoId}" target="_blank" rel="noopener">YouTube ↗</a>` : '<h2>첫 곡을 신청해 주세요</h2>';
  $('#play-controls').innerHTML = song ? `<button class="skip-button ${song.mySkip ? 'selected' : ''}" id="skip" ${!room.me ? 'disabled' : ''}>${song.mySkip ? '✓ 건너뛰기 동의 취소' : '↦ 건너뛰기 투표'} <b>${song.skipCount} / ${room.threshold}</b></button>` : '';
  if ($('#skip')) $('#skip').onclick = () => safe(() => act('skip', { songId: room.current.id, value: !room.current.mySkip }));
  $('#play-controls').insertAdjacentHTML('beforeend', '<p id="session-position" class="small muted center" aria-live="off"></p>');
  renderLocalPlayback();
  renderQueue();
  // Preserve in-progress inputs while room updates arrive.
  const mode = room.me ? 'request' : 'join';
  if ($('#request-content').dataset.mode !== mode) {
    $('#request-content').dataset.mode = mode;
    if (!room.me) {
      $('#request-content').innerHTML = '<form id="join-form" class="inline-form"><label class="grow">닉네임<input name="name" placeholder="나의 닉네임" maxlength="20" required></label><button class="primary">참여하기 ↗</button></form>';
      $('#join-form').onsubmit = event => { event.preventDefault(); safe(() => act('join', Object.fromEntries(new FormData(event.target)))); };
    } else {
      $('#request-content').innerHTML = `<div class="tabs" role="tablist" aria-label="곡 신청 방식"><button role="tab" aria-selected="true" id="search-tab">제목으로 검색</button><button role="tab" aria-selected="false" id="link-tab">유튜브 링크</button></div><div id="search-pane" role="tabpanel"><form id="search-form" class="search-form"><input name="q" placeholder="곡 제목 또는 아티스트를 입력해 주세요" aria-label="곡 제목 또는 아티스트" maxlength="100" required><button class="primary" ${room.searchEnabled ? '' : 'disabled'}>검색 ↗</button></form></div><div id="link-pane" role="tabpanel" hidden><form id="link-form"><label>유튜브 영상 링크<input name="url" type="url" placeholder="https://www.youtube.com/watch?v=…" required></label><button class="primary wide" ${room.searchEnabled ? '' : 'disabled'}>대기열에 신청하기 ＋</button></form></div>`;
      if (!room.searchEnabled) $('#request-content').insertAdjacentHTML('afterbegin', '<p class="api-note">지금은 곡 신청을 사용할 수 없어요.</p>');
      const tab = which => { const search = which === 'search'; $('#search-pane').hidden = !search; $('#link-pane').hidden = search; $('#search-tab').setAttribute('aria-selected', search); $('#link-tab').setAttribute('aria-selected', !search); };
      $('#search-tab').onclick = () => tab('search'); $('#link-tab').onclick = () => tab('link');
      if (!room.searchEnabled) tab('link');
      $('#link-form').onsubmit = event => { event.preventDefault(); const form = event.target, button = event.submitter; safe(async () => { button.disabled = true; try { await act('songs', Object.fromEntries(new FormData(form))); form.reset(); notify('곡을 신청했어요.'); } finally { button.disabled = false; } }); };
      $('#search-form').onsubmit = event => { event.preventDefault(); safe(async () => {
        const button = event.submitter; button.disabled = true; $('#search-results').textContent = '곡을 찾고 있어요…'; $('#song-search').showModal();
        try { const result = await request(`search?q=${encodeURIComponent(new FormData(event.target).get('q'))}`); searchItems = result.items;
          $('#search-results').innerHTML = searchItems.length ? searchItems.map((item, i) => `<article class="search-result"><img src="https://i.ytimg.com/vi/${item.videoId}/default.jpg" alt=""><div><b>${esc(decodeTitle(item.title))}</b><p class="small muted">${esc(decodeTitle(item.artist))}</p></div><button class="outline" data-add="${i}" aria-label="${esc(decodeTitle(item.title))} 신청">＋</button></article>`).join('') : '<p class="muted">검색 결과가 없어요. 다른 검색어를 입력해 주세요.</p>';
          document.querySelectorAll('[data-add]').forEach(b => b.onclick = () => safe(async () => { const item = searchItems[Number(b.dataset.add)]; b.disabled = true; try { await act('songs', { videoId: item.videoId }); $('#song-search').close(); notify('곡을 신청했어요.'); } finally { b.disabled = false; } }));
        } catch (error) { $('#search-results').textContent = error.message; } finally { button.disabled = false; }
      }); };
    }
  }
}
function renderQueue() {
  const width = typeof innerWidth === 'number' ? innerWidth : 1280;
  const height = typeof innerHeight === 'number' ? innerHeight : 768;
  const pageSize = width >= 980 && height >= 600 ? Math.max(2, Math.min(5, Math.floor((height - 300) / 120))) : 5;
  const pages = Math.max(1, Math.ceil(room.queue.length / pageSize));
  renderQueue.page = Math.max(0, Math.min(renderQueue.page || 0, pages - 1));
  const visibleQueue = room.queue.slice(renderQueue.page * pageSize, (renderQueue.page + 1) * pageSize);
  $('#queue').innerHTML = visibleQueue.length ? visibleQueue.map((s, index) => `<article class="song-row"><span class="song-rank">${String(renderQueue.page * pageSize + index + 1).padStart(2, '0')}</span><img src="https://i.ytimg.com/vi/${s.videoId}/default.jpg" alt="" loading="lazy"><div class="song-detail"><h3>${esc(s.title)}</h3><p>${esc(s.artist || 'YouTube')} · ${esc(s.addedByName)} 신청</p><div class="vote-actions"><button data-song="${s.id}" data-vote="1" class="vote ${s.myVote === 1 ? 'selected' : ''}" aria-pressed="${s.myVote === 1}" ${!room.me ? 'disabled' : ''}>♡ 듣고 싶어요 <b>${s.likes}</b></button><button data-song="${s.id}" data-vote="-1" class="vote ${s.myVote === -1 ? 'selected' : ''}" aria-pressed="${s.myVote === -1}" ${!room.me ? 'disabled' : ''}>− 이번엔 패스 <b>${s.passes}</b></button>${room.isCreator ? `<button data-remove="${s.id}" class="vote" aria-label="${esc(s.title)} 대기곡 삭제">삭제</button>` : ''}</div></div></article>`).join('') : '<div class="empty-queue"><span aria-hidden="true">＋</span><h3>아직 신청곡이 없어요</h3></div>';
  document.querySelectorAll('[data-vote]').forEach(button => button.onclick = () => {
    const song = room.queue.find(s => s.id === button.dataset.song), value = Number(button.dataset.vote);
    safe(() => act('votes', { songId: song.id, value: song.myVote === value ? 0 : value }));
  });
  document.querySelectorAll('[data-remove]').forEach(button => button.onclick = () => safe(async () => {
    button.disabled = true;
    try { await act('remove-song', { songId: button.dataset.remove }); notify('대기곡을 삭제했어요.'); }
    finally { button.disabled = false; }
  }));
  $('#queue-pagination').hidden = pages <= 1;
  $('#queue-page').textContent = `${renderQueue.page + 1} / ${pages}`;
  $('#queue-prev').disabled = renderQueue.page === 0;
  $('#queue-next').disabled = renderQueue.page === pages - 1;
  $('#queue-prev').onclick = () => { renderQueue.page--; renderQueue(); };
  $('#queue-next').onclick = () => { renderQueue.page++; renderQueue(); };
}
function decodeTitle(text) { const node = document.createElement('textarea'); node.innerHTML = text; return node.value; }
async function safe(fn) { try { await fn(); } catch (error) { notify(error.message); } }
function loadedVideoMatches() {
  try { return new URL(player.getVideoUrl()).searchParams.get('v') === room?.current?.videoId; } catch { return false; }
}
function showPlayerError(code, songId = room?.current?.id) {
  if (!room?.isCreator || songId !== room.current?.id) return;
  const error = youtubeError(code);
  playerFailure = { ...error, songId };
  retryingSong = null; pendingControl = null;
  if (playerReady) { internalPause = true; player.pauseVideo(); }
  playbackChanged();
}
async function retryPlayback() {
  if (!room?.isCreator || !room.current || !playerFailure || playerFailure.skip || syncBusy || reportBusy) return;
  retryingSong = room.current.id;
  playerFailure = null; pendingControl = null;
  clearTimeout(playerReadyTimer);
  const previous = player; player = null; playerReady = false; loadedSong = null;
  if (previous) previous.destroy();
  claimedSong = null; lastClaim = 0; durationSentFor = null;
  localPaused = Boolean(room.playback.paused); localBlocked = false; awaitingPlayback = false;
  await syncPlayer();
}
function controlPlayback(command) {
  if (pendingControl || playerFailure || !room?.isCreator || !room.current || !playerReady || claimedSong !== room.current.id || loadedSong !== room.current.id) return;
  pendingControl = { command, songId: loadedSong, position: awaitingPlayback ? room.playback.position : player.getCurrentTime() };
  localPaused = command === 'pause';
  if (localPaused) player.pauseVideo();
  else { localBlocked = false; player.playVideo(); }
  playbackChanged();
}
function renderLocalPlayback() {
  const hasVideo = Boolean(room?.isCreator && room.current);
  if ($('#player-stage')) $('#player-stage').hidden = !hasVideo;
  if ($('#transport-controls')) $('#transport-controls').hidden = !hasVideo;
  const ready = hasVideo && playerReady && claimedSong === room.current.id && loadedSong === room.current.id && !pendingControl && !playerFailure && !syncBusy;
  if ($('#play-song')) $('#play-song').disabled = !ready || (!localPaused && !localBlocked && room.playback.status === 'playing');
  if ($('#pause-song')) $('#pause-song').disabled = !ready || localPaused || room.playback.paused;
  $('.player-panel')?.classList.toggle('has-video', hasVideo);
  const fresh = room?.playback.status === 'playing' && Number.isFinite(room.playback.reportedAt) && serverNow() - room.playback.reportedAt < room.playback.leaseMs;
  const spinning = Boolean(room?.current && fresh && (room.isCreator
    ? playerReady && loadedSong === room.current.id && !localPaused && !localBlocked && player.getPlayerState() === YT.PlayerState.PLAYING
    : true));
  $('.room-turntable')?.classList.toggle('is-playing', spinning);
  const failure = playerFailure?.songId === room?.current?.id ? playerFailure : room?.current && room.playback.errorCode != null ? youtubeError(room.playback.errorCode) : null;
  if ($('#retry-playback')) { $('#retry-playback').hidden = !(room?.isCreator && failure && !failure.skip); $('#retry-playback').disabled = syncBusy || reportBusy; }
  if (failure && $('#player-message')) $('#player-message').textContent = failure.message;
  const label = playbackLabel(room, serverNow());
  if ($('#host-status')) $('#host-status').textContent = (room?.creatorConnection === 'connected' && label !== '방장 연결 확인 중' && label !== '방장 연결 끊김' ? '방장 연결됨 · ' : '') + label + (room?.playback.status === 'disconnected' ? ' · 마지막 확인 위치에서 기다려요.' : '');
  if ($('#playback-status')) $('#playback-status').textContent = label;
  if ($('#session-position')) {
    const seconds = Math.floor(positionAt(room?.playback, serverNow()));
    $('#session-position').textContent = room?.current ? `재생 위치 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : '';
  }
}
async function reportDuration() {
  if (!room?.isCreator || !room.current || !playerReady || loadedSong !== room.current.id || durationBusy || room.current.duration || durationSentFor === loadedSong) return;
  const duration = player.getDuration();
  if (!Number.isFinite(duration) || duration < 1 || duration > 43200 || !loadedVideoMatches()) return;
  const songId = loadedSong; durationBusy = true;
  try { await act('control', { command: 'duration', songId, duration }); durationSentFor = songId; }
  catch (error) { if (error.status === 409) refresh(); }
  finally { durationBusy = false; }
}
function playbackChanged() { lastPlaybackReport = 0; reportPlayback(); renderLocalPlayback(); }
async function reportPlayback() {
  if (!room?.isCreator || !room.current || claimedSong !== room.current.id || reportBusy || syncBusy || Date.now() - lastPlaybackReport < 3000) return;
  let failure = playerFailure?.songId === room.current.id ? playerFailure : null;
  if (!failure && (!playerReady || loadedSong !== room.current.id || !loadedVideoMatches())) return;
  const songId = room.current.id, revision = claimedRevision;
  reportBusy = true; lastPlaybackReport = Date.now();
  try {
    // Reconnect before sampling again: no locally elapsed, unconfirmed time is saved.
    if (playbackFailure || !Number.isFinite(room.playback.reportedAt) || serverNow() - room.playback.reportedAt >= room.playback.leaseMs) {
      claimedSong = null; lastClaim = 0;
      accept(await request());
      return;
    }
    if (!failure) await reportDuration();
    if (room?.current?.id !== songId) return;
    failure = playerFailure?.songId === songId ? playerFailure : failure;
    const state = !failure && playerReady ? player.getPlayerState() : null;
    const status = failure ? 'waiting' : localBlocked ? 'blocked' : awaitingPlayback ? (localPaused ? 'paused' : state === YT.PlayerState.BUFFERING ? 'buffering' : 'waiting') : ({ 1: 'playing', 2: 'paused', 3: 'buffering' })[state] || 'waiting';
    const control = pendingControl?.songId === songId ? pendingControl : null;
    const command = failure ? (failure.skip ? 'unavailable' : 'error') : control ? control.command : !awaitingPlayback && state === YT.PlayerState.ENDED ? 'ended' : 'progress';
    // loadVideoById is asynchronous; ignore its old playhead until playback starts.
    const position = failure ? room.playback.position : control?.command === 'pause' ? control.position : awaitingPlayback ? room.playback.position : player.getCurrentTime();
    const result = await request('control', { command, songId, sessionId: playbackSession, revision, sequence: ++reportSequence, status, position, ...(failure ? { errorCode: failure.code } : {}) });
    playbackFailure = false;
    if (pendingControl === control) pendingControl = null;
    accept(result);
    renderLocalPlayback();
  } catch (error) {
    if (room?.current?.id !== songId) return;
    if (error.status === 409) { claimedSong = null; lastClaim = 0; await refresh(); }
    else { playbackFailure = true; if ($('#connection')) $('#connection').textContent = '재생 상태를 전송하지 못했어요. 연결 복구 후 마지막 확인 위치에서 이어 들어요.'; }
  } finally { reportBusy = false; renderLocalPlayback(); }
}
async function syncPlayer() {
  if (syncBusy) return;
  if (!room?.isCreator) { stopPlayer(); renderLocalPlayback(); return; }
  if (!room.current) {
    clearTimeout(playerReadyTimer);
    if (playerReady) { loadedSong = null; player.stopVideo(); }
    claimedSong = null; pendingControl = null; playerFailure = null; retryingSong = null; renderLocalPlayback(); return;
  }
  if (playerFailure && playerFailure.songId !== room.current.id) playerFailure = null;
  if (retryingSong && retryingSong !== room.current.id) retryingSong = null;
  if (room.playback.errorCode != null && !playerFailure && retryingSong !== room.current.id) playerFailure = { ...youtubeError(room.playback.errorCode), songId: room.current.id };
  if (pendingControl && pendingControl.songId !== room.current.id) pendingControl = null;
  syncBusy = true;
  try {
    if (claimedSong !== room.current.id || claimedRevision !== room.playback.revision || room.playback.status === 'disconnected') {
      if (Date.now() - lastClaim < 3000) return;
      lastClaim = Date.now();
      const songId = room.current.id;
      if (playerReady) { internalPause = true; player.pauseVideo(); }
      const result = await request('control', { command: 'attach', songId, sessionId: playbackSession, retry: retryingSong === songId });
      if (result.current?.id !== songId) { accept(result); return; }
      claimedSong = songId; claimedRevision = result.playback.revision; reportSequence = 0;
      loadedSong = null; playbackFailure = false;
      accept(result);
      if (retryingSong === songId) retryingSong = null;
      localPaused = Boolean(room.playback.paused && pendingControl?.command !== 'resume') || localPaused;
    }
    if (playerFailure?.songId === room.current.id) return;
    if (!player) {
      await loadYoutube();
      if (!room?.isCreator || !room.current || claimedSong !== room.current.id) return;
      if (!$('#youtube-player')) { const mount = document.createElement('div'); mount.id = 'youtube-player'; $('#player-stage').append(mount); }
      player = new YT.Player('youtube-player', { width: '100%', height: '100%', playerVars: { playsinline: 1, controls: 0, disablekb: 1, fs: 0, origin: location.origin }, events: {
        onReady: event => { if (!player || (event?.target && event.target !== player)) return; clearTimeout(playerReadyTimer); playerReady = true; const iframe = player.getIframe(); iframe.title = '함께 듣는 YouTube 플레이어'; iframe.tabIndex = -1; iframe.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture'); syncPlayer(); },
        onStateChange: event => {
          if ((event.target && event.target !== player) || playerFailure || !room?.isCreator || !room.current || loadedSong !== room.current.id || !loadedVideoMatches()) return;
          if (event.data !== YT.PlayerState.PLAYING) $('.room-turntable')?.classList.remove('is-playing');
          if (event.data === YT.PlayerState.PLAYING) {
            if (room.playback.paused && pendingControl?.command !== 'resume') { player.pauseVideo(); return; }
            awaitingPlayback = false; internalPause = false; localPaused = false; localBlocked = false;
            if ($('#player-message')) $('#player-message').textContent = '';
          } else if (event.data === YT.PlayerState.PAUSED) {
            if (internalPause) { internalPause = false; return; }
            localPaused = true;
          }
          playbackChanged();
        },
        onAutoplayBlocked: event => { if ((event?.target && event.target !== player) || playerFailure) return; localBlocked = true; if ($('#player-message')) $('#player-message').textContent = '재생 버튼을 누르면 멈춘 위치에서 음악을 시작해요.'; playbackChanged(); },
        onError: event => { if (player && (!event.target || event.target === player) && loadedSong === room?.current?.id) showPlayerError(event.data); },
      } });
      const instance = player, songId = room.current.id;
      clearTimeout(playerReadyTimer);
      playerReadyTimer = setTimeout(() => { if (player === instance && !playerReady) showPlayerError('api', songId); }, 15000);
    }
    if (!playerReady || claimedSong !== room.current?.id) return;
    player.getIframe().hidden = false;
    if (loadedSong !== room.current.id) {
      loadedSong = room.current.id; durationSentFor = null; awaitingPlayback = true;
      $('#player-message').textContent = '';
      // Always load the confirmed position, never the estimated wall-clock position.
      const video = { videoId: room.current.videoId, startSeconds: room.playback.position || 0 };
      const hold = (room.playback.paused && pendingControl?.command !== 'resume') || localPaused || localBlocked;
      localPaused = hold;
      if (hold) player.cueVideoById(video); else player.loadVideoById(video);
      lastPlaybackReport = 0;
    }
    reportDuration(); renderLocalPlayback();
  } catch (error) {
    if (!error.status) showPlayerError('api');
    else claimedSong = null;
    if ($('#player-message')) $('#player-message').textContent = error.message;
  } finally { syncBusy = false; renderLocalPlayback(); }
}
for (const name of ['rules', 'research']) $(`#${name}-open`).onclick = () => $(`#${name}`).showModal();
document.querySelectorAll('[data-close]').forEach(button => button.onclick = () => $(`#${button.dataset.close}`).close());
async function refresh() {
  if (!roomId || pollBusy || document.hidden) return; pollBusy = true; lastRefresh = Date.now();
  try { accept(await request()); $('#connection').textContent = ''; }
  catch (error) { if (error.status === 404) { exitRoom(); notify('방이 없거나 비어 있어 삭제됐어요. 코드를 다시 확인해 주세요.'); } else if ($('#connection')) $('#connection').textContent = error.message; }
  finally { pollBusy = false; }
}
async function heartbeat() {
  if (!roomId || !room?.me || heartbeat.busy || Date.now() - lastHeartbeat < 15000) return;
  heartbeat.busy = true;
  try { const result = await request('heartbeat', {}); lastHeartbeat = Date.now(); accept(result); }
  catch (error) { if (error.status === 404) { exitRoom(); notify('참여자가 없어 방이 자동 삭제됐어요.'); } else if (error.status === 401) { await refresh(); } else if ($('#connection')) $('#connection').textContent = error.message; }
  finally { heartbeat.busy = false; }
}
landing();
if (initialRoomId) enterRoom(initialRoomId);
setInterval(() => { if (Date.now() - lastRefresh >= 5000) refresh(); heartbeat(); syncPlayer(); reportPlayback(); renderLocalPlayback(); }, 1000);
window.addEventListener('resize', () => { if (room) renderQueue(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { refresh(); } });
