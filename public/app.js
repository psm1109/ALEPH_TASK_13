import { positionAt, playbackLabel } from './session.js';
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
let room = null, pollBusy = false, lastSnapshot = '', searchItems = [], player = null, playerReady = false, loadedSong = null, youtubePromise;
let lastHeartbeat = 0, lastRefresh = 0, serverClockOffset = 0;
let localPaused = false, localBlocked = false, durationSentFor = null, durationBusy = false;
const playbackSession = crypto.randomUUID();
let claimedSong = null, claimedRevision = null, reportSequence = 0, lastPlaybackReport = 0, lastClaim = 0;
let internalPause = false, awaitingPlayback = false;
let pendingControl = null;
let syncBusy = false, reportBusy = false, playbackFailure = false, unavailableSong = null;
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
function stopPlayer() { $('.room-turntable')?.classList.remove('is-playing'); pendingControl = null; if (player) player.destroy(); player = null; playerReady = false; loadedSong = null; durationSentFor = null; localPaused = false; localBlocked = false; claimedSong = null; claimedRevision = null; lastClaim = 0; unavailableSong = null; awaitingPlayback = false; }
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
  $('#app').innerHTML = `<section class="room-heading"><div><span class="eyebrow"><span class="dot"></span> OUR LISTENING ROOM</span><h1 id="room-title">모임에 연결 중…</h1><p class="muted">서로의 취향 사이에서, 함께 듣기 좋은 한 곡.</p></div><button id="invite" class="outline">초대 링크 복사 ↗</button></section><div id="connection" class="connection" role="status"></div><div class="room-grid"><section class="left-column"><article class="panel player-panel"><div class="panel-heading"><span class="eyebrow">NOW PLAYING</span><span class="badge" id="player-role"></span></div><div class="room-turntable"><div class="room-vinyl" aria-hidden="true"><div class="room-vinyl-label"><span>SAI</span><small>LISTEN TOGETHER</small></div></div><img class="tonearm" src="/tonearm.svg" alt="" draggable="false"><div id="player-stage" aria-hidden="true" inert hidden><div id="youtube-player"></div></div></div><div id="transport-controls" class="transport-controls" hidden><button id="play-song" class="primary" type="button">▶ 재생</button><button id="pause-song" class="outline" type="button">Ⅱ 일시정지</button></div><div id="player-placeholder" class="player-placeholder"><div class="record"><div class="record-center">sai</div></div><p>우리의 첫 곡을 기다리는 중</p><span>곡을 신청하고 함께 재생해 보세요.</span></div><p id="host-status" class="small muted" role="status"></p><div id="current-info"></div><p id="player-message" class="small muted" role="status"></p><div id="play-controls"></div></article><article class="panel request-panel"><div class="panel-heading"><h2>다음엔 뭐 들을까요?</h2><span class="muted small">REQUEST A SONG</span></div><div id="request-content"></div></article></section><aside class="right-column"><section class="panel queue-panel"><div class="panel-heading"><h2>함께 고른 다음 곡 <span id="queue-count" class="count">0</span></h2><span class="small muted">투표순</span></div><p class="small muted queue-help">듣고 싶어요 +1 · 이번엔 패스 −1. 점수가 높은 곡부터, 동점은 신청순으로 들어요. 첫 곡은 바로 시작하니 한 곡 더 신청해 투표해 보세요.</p><div id="queue"></div></section><section class="panel people-panel"><div class="panel-heading"><h2>함께 듣는 사람들</h2><span id="people-count" class="small muted"></span></div><div id="people"></div><p class="small muted">접속을 90초 동안 확인하지 못한 참여자는 자동으로 퇴장해요.</p></section><div class="rule-note"><span>↳</span><p>말하기 어려운 취향도, 한 표면 충분해요.<br><b>투표한 사람의 이름은 공개하지 않아요.</b></p></div></aside></div>`;
  $('#app').insertAdjacentHTML('afterbegin', '<div class="room-backdrop" aria-hidden="true"></div>');
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
  $('#people-count').textContent = `${room.members.length}명`;
  $('#people').innerHTML = room.members.map(m => `<span class="person"><span class="avatar">${m.id === room.me?.id ? '나' : esc(m.name.slice(0, 1))}</span>${esc(m.name)}</span>`).join('');
  const song = room.current;
  $('#current-info').innerHTML = song ? `<div class="playing-label"><span class="equalizer">ııı</span><span id="playback-status">${playbackLabel(room, serverNow())}</span></div><h2>${esc(song.title)}</h2><p class="muted">${esc(song.artist || 'YouTube')} <span class="separator">/</span> ${esc(song.addedByName)} 님의 신청곡</p><a class="external small" href="https://www.youtube.com/watch?v=${song.videoId}" target="_blank" rel="noopener">YouTube에서 보기 ↗</a>` : '<h2>첫 곡은 어떤 음악일까요?</h2><p class="muted">아래에서 듣고 싶은 곡을 신청해 주세요.</p>';
  if (!room.isCreator) {
    $('#player-placeholder').hidden = false;
    $('#player-placeholder p').textContent = song ? '음악은 방장 기기에서 재생돼요' : '우리의 첫 곡을 기다리는 중';
    $('#player-placeholder span').textContent = '음악은 방을 만든 사람에게만 재생돼요. 곡 신청과 투표로 함께해요.';
  } else $('#player-placeholder').hidden = Boolean(song);
  $('#play-controls').innerHTML = song ? `<button class="skip-button ${song.mySkip ? 'selected' : ''}" id="skip" ${!room.me ? 'disabled' : ''}>${song.mySkip ? '✓ 건너뛰기 동의 취소' : '↦ 이 곡 건너뛰기 투표'} <b>${song.skipCount} / ${room.threshold}</b></button><p class="small muted center">현재 참여 ${room.members.length}명 중 ${room.threshold}명이 동의하면 다음 곡으로 넘어가요.</p>` : '<p class="small muted">첫 곡을 신청하면 바로 자동 재생돼요. 이후 곡은 투표 순서로 이어져요.</p>';
  if ($('#skip')) $('#skip').onclick = () => safe(() => act('skip', { songId: room.current.id, value: !room.current.mySkip }));
  $('#play-controls').insertAdjacentHTML('beforeend', '<p id="session-position" class="small muted center" aria-live="off"></p>');
  renderLocalPlayback();
  $('#queue').innerHTML = room.queue.length ? room.queue.map((s, index) => `<article class="song-row"><span class="song-rank">${String(index + 1).padStart(2, '0')}</span><img src="https://i.ytimg.com/vi/${s.videoId}/default.jpg" alt="" loading="lazy"><div class="song-detail"><h3>${esc(s.title)}</h3><p>${esc(s.artist || 'YouTube')} · ${esc(s.addedByName)} 신청</p><div class="vote-actions"><button data-song="${s.id}" data-vote="1" class="vote ${s.myVote === 1 ? 'selected' : ''}" aria-pressed="${s.myVote === 1}" ${!room.me ? 'disabled' : ''}>♡ 듣고 싶어요 <b>${s.likes}</b></button><button data-song="${s.id}" data-vote="-1" class="vote ${s.myVote === -1 ? 'selected' : ''}" aria-pressed="${s.myVote === -1}" ${!room.me ? 'disabled' : ''}>− 이번엔 패스 <b>${s.passes}</b></button></div></div></article>`).join('') : '<div class="empty-queue"><span>＋</span><h3>아직 조용한 대기열</h3><p>좋아하는 곡 하나로<br>이 공간을 채워 주세요.</p></div>';
  document.querySelectorAll('[data-vote]').forEach(button => button.onclick = () => {
    const song = room.queue.find(s => s.id === button.dataset.song), value = Number(button.dataset.vote);
    safe(() => act('votes', { songId: song.id, value: song.myVote === value ? 0 : value }));
  });
  // Preserve in-progress inputs while room updates arrive.
  const mode = room.me ? 'request' : 'join';
  if ($('#request-content').dataset.mode !== mode) {
    $('#request-content').dataset.mode = mode;
    if (!room.me) {
      $('#request-content').innerHTML = '<p class="muted">닉네임을 입력하고 신청과 투표에 참여해 주세요.</p><form id="join-form" class="inline-form"><label class="grow">닉네임<input name="name" placeholder="나의 닉네임" maxlength="20" required></label><button class="primary">참여하기 ↗</button></form>';
      $('#join-form').onsubmit = event => { event.preventDefault(); safe(() => act('join', Object.fromEntries(new FormData(event.target)))); };
    } else {
      $('#request-content').innerHTML = `<div class="tabs" role="tablist" aria-label="곡 신청 방식"><button role="tab" aria-selected="true" id="search-tab">제목으로 검색</button><button role="tab" aria-selected="false" id="link-tab">유튜브 링크</button></div><div id="search-pane" role="tabpanel"><form id="search-form" class="search-form"><input name="q" placeholder="곡 제목 또는 아티스트를 입력해 주세요" aria-label="곡 제목 또는 아티스트" maxlength="100" required><button class="primary" ${room.searchEnabled ? '' : 'disabled'}>검색 ↗</button></form>${room.searchEnabled ? '<p class="small muted">YouTube에서 앱 내 재생이 가능한 영상을 검색해요.</p>' : '<p class="api-note">제목 검색은 준비 중이에요. <button id="use-link" class="text-link">유튜브 링크로 바로 신청하기 ↗</button></p>'}<div id="search-results" aria-live="polite"></div></div><div id="link-pane" role="tabpanel" hidden><form id="link-form"><label>유튜브 영상 링크<input name="url" type="url" placeholder="https://www.youtube.com/watch?v=…" required></label><div class="two-inputs"><label>곡 제목<input name="title" placeholder="표시할 곡 제목" maxlength="160" required></label><label>아티스트 <span class="muted">선택</span><input name="artist" placeholder="아티스트 이름" maxlength="100"></label></div><button class="primary wide">대기열에 신청하기 ＋</button></form><p class="small muted">앱 내 재생이 제한된 영상은 재생되지 않을 수 있어요.</p></div>`;
      const tab = which => { const search = which === 'search'; $('#search-pane').hidden = !search; $('#link-pane').hidden = search; $('#search-tab').setAttribute('aria-selected', search); $('#link-tab').setAttribute('aria-selected', !search); };
      $('#search-tab').onclick = () => tab('search'); $('#link-tab').onclick = () => tab('link');
      if ($('#use-link')) $('#use-link').onclick = () => tab('link');
      if (!room.searchEnabled) tab('link');
      $('#link-form').onsubmit = event => { event.preventDefault(); const form = event.target; safe(async () => { await act('songs', Object.fromEntries(new FormData(form))); form.reset(); notify('신청했어요. 재생 중인 곡이 없으면 바로 시작돼요.'); }); };
      $('#search-form').onsubmit = event => { event.preventDefault(); safe(async () => {
        const button = event.submitter; button.disabled = true; $('#search-results').textContent = '곡을 찾고 있어요…';
        try { const result = await request(`search?q=${encodeURIComponent(new FormData(event.target).get('q'))}`); searchItems = result.items;
          $('#search-results').innerHTML = searchItems.length ? searchItems.map((item, i) => `<article class="search-result"><img src="https://i.ytimg.com/vi/${item.videoId}/default.jpg" alt=""><div><b>${esc(decodeTitle(item.title))}</b><p class="small muted">${esc(decodeTitle(item.artist))}</p></div><button class="outline" data-add="${i}" aria-label="${esc(decodeTitle(item.title))} 신청">＋</button></article>`).join('') : '<p class="muted">검색 결과가 없어요. 다른 검색어를 입력해 주세요.</p>';
          document.querySelectorAll('[data-add]').forEach(b => b.onclick = () => safe(async () => { const item = searchItems[Number(b.dataset.add)]; await act('songs', { ...item, title: decodeTitle(item.title), artist: decodeTitle(item.artist) }); notify('신청했어요. 재생 중인 곡이 없으면 바로 시작돼요.'); }));
        } catch (error) { $('#search-results').textContent = error.message; } finally { button.disabled = false; }
      }); };
    }
  }
}
function decodeTitle(text) { const node = document.createElement('textarea'); node.innerHTML = text; return node.value; }
async function safe(fn) { try { await fn(); } catch (error) { notify(error.message); } }
function loadYoutube() {
  if (youtubePromise) return youtubePromise;
  youtubePromise = new Promise((resolve, reject) => {
    if (window.YT?.Player) return resolve();
    window.onYouTubeIframeAPIReady = resolve;
    const script = document.createElement('script'); script.src = 'https://www.youtube.com/iframe_api';
    script.onerror = () => reject(Error('유튜브 플레이어에 연결하지 못했어요. 네트워크를 확인하고 새로고침해 주세요.'));
    setTimeout(() => { if (!window.YT?.Player) reject(Error('유튜브 플레이어 응답이 늦어지고 있어요. 네트워크를 확인하고 새로고침해 주세요.')); }, 15000);
    document.head.append(script);
  }); return youtubePromise;
}
function loadedVideoMatches() {
  try { return new URL(player.getVideoUrl()).searchParams.get('v') === room?.current?.videoId; } catch { return false; }
}
function controlPlayback(command) {
  if (pendingControl || !room?.isCreator || !room.current || !playerReady || claimedSong !== room.current.id || loadedSong !== room.current.id) return;
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
  const ready = hasVideo && playerReady && claimedSong === room.current.id && loadedSong === room.current.id && !pendingControl && !syncBusy;
  if ($('#play-song')) $('#play-song').disabled = !ready || (!localPaused && !localBlocked && room.playback.status === 'playing');
  if ($('#pause-song')) $('#pause-song').disabled = !ready || localPaused || room.playback.paused;
  $('.player-panel')?.classList.toggle('has-video', hasVideo);
  const fresh = room?.playback.status === 'playing' && Number.isFinite(room.playback.reportedAt) && serverNow() - room.playback.reportedAt < room.playback.leaseMs;
  const spinning = Boolean(room?.current && fresh && (room.isCreator
    ? playerReady && loadedSong === room.current.id && !localPaused && !localBlocked && player.getPlayerState() === YT.PlayerState.PLAYING
    : true));
  $('.room-turntable')?.classList.toggle('is-playing', spinning);
  const label = playbackLabel(room, serverNow());
  if ($('#host-status')) $('#host-status').textContent = (room?.creatorConnection === 'connected' && label !== '방장 연결 확인 중' && label !== '방장 연결 끊김' ? '방장 연결됨 · ' : '') + label + (room?.playback.status === 'disconnected' ? ' · 마지막 확인 위치에서 기다려요.' : '');
  if ($('#playback-status')) $('#playback-status').textContent = label;
  if ($('#session-position')) {
    const seconds = Math.floor(positionAt(room?.playback, serverNow()));
    $('#session-position').textContent = room?.current ? `재생 위치 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} · 방장 기기에서 재생돼요` : '';
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
  if (!room?.isCreator || !room.current || !playerReady || loadedSong !== room.current.id || claimedSong !== loadedSong || reportBusy || syncBusy || !loadedVideoMatches() || Date.now() - lastPlaybackReport < 3000) return;
  const songId = loadedSong, revision = claimedRevision;
  reportBusy = true; lastPlaybackReport = Date.now();
  try {
    // Reconnect before sampling again: no locally elapsed, unconfirmed time is saved.
    if (playbackFailure || !Number.isFinite(room.playback.reportedAt) || serverNow() - room.playback.reportedAt >= room.playback.leaseMs) {
      claimedSong = null; lastClaim = 0;
      accept(await request());
      return;
    }
    await reportDuration();
    if (room?.current?.id !== songId) return;
    const state = player.getPlayerState();
    const status = localBlocked ? 'blocked' : awaitingPlayback ? (localPaused ? 'paused' : state === YT.PlayerState.BUFFERING ? 'buffering' : 'waiting') : ({ 1: 'playing', 2: 'paused', 3: 'buffering' })[state] || 'waiting';
    const control = pendingControl?.songId === songId ? pendingControl : null;
    const command = unavailableSong === songId ? 'unavailable' : control ? control.command : !awaitingPlayback && state === YT.PlayerState.ENDED ? 'ended' : 'progress';
    // loadVideoById is asynchronous; ignore its old playhead until playback starts.
    const position = control?.command === 'pause' ? control.position : awaitingPlayback ? room.playback.position : player.getCurrentTime();
    const result = await request('control', { command, songId, sessionId: playbackSession, revision, sequence: ++reportSequence, status, position });
    playbackFailure = false;
    if (pendingControl === control) pendingControl = null;
    accept(result);
    renderLocalPlayback();
  } catch (error) {
    if (room?.current?.id !== songId) return;
    if (error.status === 409) { claimedSong = null; lastClaim = 0; await refresh(); }
    else { playbackFailure = true; if ($('#connection')) $('#connection').textContent = '재생 상태를 전송하지 못했어요. 연결 복구 후 마지막 확인 위치에서 이어 들어요.'; }
  } finally { reportBusy = false; }
}
async function syncPlayer() {
  if (syncBusy) return;
  if (!room?.isCreator) { stopPlayer(); renderLocalPlayback(); return; }
  if (!room.current) {
    if (playerReady) { loadedSong = null; player.stopVideo(); }
    claimedSong = null; pendingControl = null; renderLocalPlayback(); return;
  }
  if (pendingControl && pendingControl.songId !== room.current.id) pendingControl = null;
  syncBusy = true;
  try {
    if (claimedSong !== room.current.id || claimedRevision !== room.playback.revision || room.playback.status === 'disconnected') {
      if (Date.now() - lastClaim < 3000) return;
      lastClaim = Date.now();
      const songId = room.current.id;
      if (playerReady) { internalPause = true; player.pauseVideo(); }
      const result = await request('control', { command: 'attach', songId, sessionId: playbackSession });
      if (result.current?.id !== songId) { accept(result); return; }
      claimedSong = songId; claimedRevision = result.playback.revision; reportSequence = 0;
      loadedSong = null; playbackFailure = false; unavailableSong = null;
      accept(result);
      localPaused = Boolean(room.playback.paused && pendingControl?.command !== 'resume') || localPaused;
    }
    if (!player) {
      await loadYoutube();
      if (!room?.isCreator || !room.current) return;
      if (!$('#youtube-player')) { const mount = document.createElement('div'); mount.id = 'youtube-player'; $('#player-stage').append(mount); }
      player = new YT.Player('youtube-player', { width: '100%', height: '100%', playerVars: { playsinline: 1, controls: 0, disablekb: 1, fs: 0, origin: location.origin }, events: {
        onReady: () => { if (!player) return; playerReady = true; const iframe = player.getIframe(); iframe.title = '함께 듣는 YouTube 플레이어'; iframe.tabIndex = -1; iframe.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture'); syncPlayer(); },
        onStateChange: event => {
          if (!room?.isCreator || !room.current || loadedSong !== room.current.id || !loadedVideoMatches()) return;
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
        onAutoplayBlocked: () => { localBlocked = true; if ($('#player-message')) $('#player-message').textContent = '재생 버튼을 누르면 멈춘 위치에서 음악을 시작해요.'; playbackChanged(); },
        onError: () => { if (room?.isCreator && loadedSong === room.current?.id && loadedVideoMatches()) { unavailableSong = loadedSong; if ($('#player-message')) $('#player-message').textContent = '재생할 수 없는 영상이에요. 다음 곡으로 넘어가요.'; playbackChanged(); } },
      } });
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
    claimedSong = null;
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
document.addEventListener('visibilitychange', () => { if (!document.hidden) { refresh(); } });
