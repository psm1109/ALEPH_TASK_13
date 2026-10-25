import { REFLECTION_REASONS, REFLECTION_RATINGS, summarizeReflections, readReports, rememberReport } from './reflections.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const dateLabel = value => new Date(value).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function createListeningNotes({ getRoom, save, finish, notify }) {
  const $ = selector => document.querySelector(selector);
  const dialog = $('#reflection-dialog'), recordsDialog = $('#listening-records'), form = $('#reflection-form');
  let storage;
  try { storage = localStorage; } catch {}
  let reports = readReports(storage), signature = '', renderedSignature = '', storageFailed = false, returnToRecords = false;
  const announcedEnds = new Set();

  function makeReport(room) {
    return room?.reflections ? { listeningId: room.listeningId, id: room.id, title: room.title, endedAt: room.endedAt, capturedAt: Date.now(), reflections: room.reflections } : null;
  }
  function capture(room, { leaving = false } = {}) {
    const report = makeReport(room);
    if (!report || (!leaving && !room.endedAt && !report.reflections.mine.length)) return report;
    const serialized = JSON.stringify({ ...report, capturedAt: 0 });
    if (serialized !== signature || leaving) {
      signature = serialized;
      reports = [report, ...reports.filter(item => item.listeningId !== report.listeningId)].slice(0, 20);
      storageFailed = !rememberReport(storage, report);
    }
    return report;
  }
  function availableReports() {
    const current = makeReport(getRoom());
    return current ? [current, ...reports.filter(item => item.listeningId !== current.listeningId)] : reports;
  }
  function selectedReport() { return availableReports().find(item => item.listeningId === $('#report-session').value); }
  function activeReport(report) {
    const room = getRoom();
    return Boolean(room && report && room.listeningId === report.listeningId && room.reflections);
  }
  function openRecords(listeningId) {
    const items = availableReports();
    $('#report-session').innerHTML = items.map(item => `<option value="${esc(item.listeningId)}">${esc(item.title)} · ${esc(dateLabel(item.capturedAt))}</option>`).join('');
    if (items.some(item => item.listeningId === listeningId)) $('#report-session').value = listeningId;
    $('#report-session').hidden = items.length < 2;
    $('label[for="report-session"]').hidden = items.length < 2;
    $('#finish-confirm').hidden = true;
    renderRecords();
    if (!recordsDialog.open) recordsDialog.showModal();
    const room = getRoom();
    if (room?.endedAt) announcedEnds.add(room.listeningId);
  }
  function renderRecords() {
    const report = selectedReport(), room = getRoom();
    const expanded = $('#report-content details')?.open;
    renderedSignature = JSON.stringify([report?.listeningId, report?.reflections, report?.endedAt, room?.isCreator]);
    $('#finish-controls').hidden = !(activeReport(report) && room.isCreator && !room.endedAt);
    $('#report-storage-note').textContent = storageFailed
      ? '이 브라우저에서 저장을 사용할 수 없어 기록은 현재 화면에만 남아요. 브라우저를 닫거나 새로고침하면 사라질 수 있어요.'
      : '최근 20개 모임의 요약은 이 브라우저에 저장돼요. 브라우저 데이터를 지우면 사라집니다. 다른 사람의 응답이 바뀐 경우 저장 당시의 요약과 다를 수 있어요.';
    if (!report) { $('#report-content').innerHTML = '<p class="muted">아직 모임 기록이 없어요. 함께 듣고 감상을 남기면 이곳에 모입니다.</p>'; return; }
    const { mine, tracks, group } = report.reflections;
    const personal = summarizeReflections(mine);
    const live = activeReport(report);
    const editable = live && (room.me || room.endedAt);
    const top = personal.topReasons.map(key => REFLECTION_REASONS[key]).join(', ');
    const description = !personal.total ? '아직 남긴 감상이 없어요. 직접 들은 곡에 감상을 남겨 주세요.'
      : `${personal.total}곡에 감상을 남겼고 ${personal.counts.like}곡을 좋아했어요.${top ? ` 좋았던 이유에서는 ${top} 선택이 가장 많았어요.` : ' 좋았던 이유는 아직 기록하지 않았어요.'}`;
    const mineBySong = new Map(mine.map(review => [review.song.id, review]));
    const groupList = (items, type) => items.length ? `<ul class="report-song-list">${items.slice(0, 5).map(item => `<li><b>${esc(item.song.title)}</b><span>${type === 'shared' ? `응답 ${item.total}명 모두 좋았어요` : `좋았어요 ${item.like} · 보통 ${item.neutral} · 아쉬웠어요 ${item.dislike}`}</span></li>`).join('')}</ul>` : `<p class="small muted">${type === 'shared' ? '두 명 이상이 응답하고 모두 좋아한 곡이 아직 없어요.' : '좋았어요와 아쉬웠어요가 함께 나온 곡이 아직 없어요.'}</p>`;
    $('#report-content').innerHTML = `<p class="report-session-state muted small">${esc(report.title)} · ${report.endedAt ? '모임 종료' : live ? '함께 듣는 중' : '저장 당시의 기록'}</p><section class="report-section"><h3>이번 모임에서 남긴 내 감상</h3><p>${esc(description)}</p>${personal.total ? `<div class="report-ratings"><span>좋았어요 <b>${personal.counts.like}</b></span><span>보통 <b>${personal.counts.neutral}</b></span><span>아쉬웠어요 <b>${personal.counts.dislike}</b></span></div><dl class="report-reasons">${Object.entries(REFLECTION_REASONS).map(([key, label]) => `<div><dt>${label}</dt><dd>${personal.reasons[key]}곡</dd></div>`).join('')}</dl><p class="small muted">이유는 좋았어요를 선택한 곡만 집계해요. 여러 이유를 고를 수 있어 합계가 곡 수와 다를 수 있어요.</p>` : ''}</section><section class="report-section"><h3>감상 남기기 · 수정하기</h3><details${personal.total ? '' : ' open'}><summary>현재·최근 재생곡과 내 기록 ${tracks.length}곡</summary><div class="report-track-list">${tracks.length ? tracks.map(song => `<article><div><b>${esc(song.title)}</b><p class="small muted">${mineBySong.has(song.id) ? esc(REFLECTION_RATINGS[mineBySong.get(song.id).rating]) : '아직 감상 없음'}</p></div>${editable ? `<button type="button" class="outline" data-reflect="${esc(song.id)}">${mineBySong.has(song.id) ? '수정' : '감상'}</button>` : ''}</article>`).join('') : '<p class="small muted">첫 곡을 함께 들은 뒤 기록할 수 있어요.</p>'}</div></details></section><section class="report-section"><h3>응답자 모두가 좋아한 곡</h3>${groupList(group.shared, 'shared')}<h3 class="report-subheading">서로 다르게 느낀 곡</h3>${groupList(group.different, 'different')}<p class="small muted">감상을 남긴 ${group.respondents}명의 응답만 집계해요. 곡마다 응답 인원은 다르며 미응답자의 취향은 추정하지 않아요.</p></section><p class="small muted report-scope">직접 남긴 이번 모임의 감상입니다. 성격이나 고정된 취향 유형을 판정하지 않아요.</p>`;
    if (expanded !== undefined) $('#report-content details').open = expanded;
    $('#report-content').querySelectorAll('[data-reflect]').forEach(button => button.onclick = () => openReflection(button.dataset.reflect, true));
  }
  function updateReasonChoices() {
    const liked = form.elements.rating.value === 'like';
    $('#reflection-reasons').disabled = !liked;
    if (!liked) form.querySelectorAll('[name="reason"]').forEach(input => { input.checked = false; });
  }
  function loadDraft() {
    const room = getRoom();
    const review = room?.reflections?.mine.find(item => item.song.id === form.elements.songId.value);
    form.querySelectorAll('[name="rating"]').forEach(input => { input.checked = input.value === review?.rating; });
    form.querySelectorAll('[name="reason"]').forEach(input => { input.checked = Boolean(review?.reasons.includes(input.value)); });
    $('#reflection-error').textContent = '';
    updateReasonChoices();
  }
  function openReflection(songId, fromRecords = false) {
    const room = getRoom();
    if (!room?.reflections || (!room.me && !room.endedAt)) { notify('먼저 모임에 참여해 주세요.'); return; }
    const tracks = room.reflections.tracks;
    if (!tracks.length) { notify('함께 들은 곡이 생기면 감상을 남길 수 있어요.'); return; }
    returnToRecords = fromRecords;
    if (recordsDialog.open) recordsDialog.close();
    form.elements.songId.innerHTML = tracks.map(song => `<option value="${esc(song.id)}">${esc(song.title)}</option>`).join('');
    if (tracks.some(song => song.id === songId)) form.elements.songId.value = songId;
    loadDraft();
    if (!dialog.open) dialog.showModal();
  }
  form.addEventListener('change', event => { if (event.target.name === 'rating') updateReasonChoices(); });
  $('#reflection-song').addEventListener('change', loadDraft);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const data = new FormData(form), submitter = form.querySelector('[type="submit"]');
    const input = { songId: data.get('songId'), rating: data.get('rating'), reasons: data.getAll('reason') };
    submitter.disabled = true; form.inert = true; form.setAttribute('aria-busy', 'true');
    $('#reflection-error').textContent = '';
    try {
      await save(input);
      dialog.close();
      notify(storageFailed ? '감상은 저장했지만 이 브라우저에는 보관할 수 없어요.' : '감상을 저장했어요.');
      if (returnToRecords || getRoom()?.endedAt) openRecords(getRoom()?.listeningId);
    } catch (error) { $('#reflection-error').textContent = error.message; if (!dialog.open) notify(error.message); }
    finally { submitter.disabled = false; form.inert = false; form.removeAttribute('aria-busy'); }
  });
  $('#records-open').onclick = () => openRecords(getRoom()?.listeningId);
  $('#report-session').onchange = () => { $('#finish-confirm').hidden = true; renderRecords(); };
  $('#finish-room').onclick = () => { $('#finish-confirm').hidden = false; $('#finish-confirm-button').focus(); };
  $('#finish-cancel').onclick = () => { $('#finish-confirm').hidden = true; $('#finish-room').focus(); };
  $('#finish-confirm-button').onclick = async () => {
    const button = $('#finish-confirm-button'); button.disabled = true;
    try { await finish(); $('#finish-confirm').hidden = true; openRecords(getRoom()?.listeningId); }
    catch (error) { notify(error.message); }
    finally { button.disabled = false; }
  };
  dialog.addEventListener('close', () => {
    const room = getRoom();
    if (room && (returnToRecords || (room.endedAt && !announcedEnds.has(room.listeningId)))) openRecords(room.listeningId);
    else if (!recordsDialog.open) $('#reflect-current')?.focus();
  });
  function update(room) {
    capture(room);
    const report = selectedReport();
    const nextSignature = JSON.stringify([report?.listeningId, report?.reflections, report?.endedAt, room.isCreator]);
    if (recordsDialog.open && report?.listeningId === room.listeningId && nextSignature !== renderedSignature) renderRecords();
    if (room.endedAt && room.reflections && !announcedEnds.has(room.listeningId) && !dialog.open) openRecords(room.listeningId);
  }
  return { update, capture, openReflection, openRecords };
}
