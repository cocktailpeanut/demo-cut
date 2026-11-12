import { cameraAt, validatePoints, clamp, MIN_DURATION } from './motion.js';

const $ = (id) => document.getElementById(id);
const video = $('source-video'), canvas = $('preview'), ctx = canvas.getContext('2d');
let recording = null, points = [], selected = null, mode = 'edit', repositioning = false;
let uploading = false, exportStarting = false, exportId = null, pollTimer = null, saveTimer = null, saveChain = Promise.resolve(), pendingSaves = 0, failedSave = false;
let animation = null, dragDepth = 0;
const time = (value, precise = false) => {
  const seconds = Math.max(0, Number.isFinite(value) ? value : 0);
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${(precise ? (seconds % 60).toFixed(2) : String(Math.floor(seconds % 60))).padStart(precise ? 5 : 2, '0')}`;
};
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
function notice(message, error = false) {
  $('notice-message').textContent = message;
  $('notice').classList.toggle('error', error);
  $('notice').hidden = false;
}
$('dismiss-notice').onclick = () => { $('notice').hidden = true; };

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}
function updateSaveStatus() {
  $('save-status').textContent = failedSave ? 'Changes not saved' : pendingSaves ? 'Saving…' : recording ? 'Saved locally' : 'Local workspace';
}
function saveProject() {
  if (!recording) return Promise.resolve();
  clearTimeout(saveTimer);
  saveTimer = null;
  const id = recording.id, snapshot = points.map((p) => ({ ...p }));
  pendingSaves++; updateSaveStatus();
  saveChain = saveChain.catch(() => {}).then(() => api(`/api/videos/${id}/project`, { method: 'PUT', body: JSON.stringify({ points: snapshot }) })).then(() => {
    failedSave = false;
  }).catch((error) => { failedSave = true; notice(`Could not save focus points: ${error.message} Change a setting to retry.`, true); }).finally(() => {
    pendingSaves--; updateSaveStatus();
  });
  return saveChain;
}
function scheduleSave() {
  clearTimeout(saveTimer);
  $('save-status').textContent = 'Saving…';
  saveTimer = setTimeout(() => { saveTimer = null; void saveProject(); }, 250);
}
window.addEventListener('beforeunload', (event) => {
  if (pendingSaves || saveTimer || uploading || failedSave) { event.preventDefault(); event.returnValue = ''; }
});

function setMode(next) {
  mode = next;
  for (const value of ['edit', 'preview']) {
    $(`${value}-tab`).classList.toggle('active', mode === value);
    $(`${value}-tab`).setAttribute('aria-pressed', String(mode === value));
  }
  if (mode === 'edit') video.pause();
  $('markers').hidden = mode !== 'edit';
  $('zoom-badge').hidden = mode !== 'preview' || !recording;
  updateHint(); draw();
}
function updateHint() {
  $('viewer-hint').textContent = !recording ? 'Import a recording to begin.' : repositioning ? 'Click the new position for this focus point.' : mode === 'edit' ? 'Pause at a moment, then click the recording to add focus.' : 'Previewing zooms. Pause and click to add a focus point.';
  $('stage').classList.toggle('is-repositioning', repositioning);
}
$('edit-tab').onclick = () => setMode('edit');
$('preview-tab').onclick = () => { repositioning = false; setMode('preview'); };

function resizeCanvas() {
  if (!recording) return;
  const stage = $('stage');
  const ratio = recording.width / recording.height;
  let width = stage.clientWidth - 2, height = width / ratio;
  if (height > stage.clientHeight - 2) { height = stage.clientHeight - 2; width = height * ratio; }
  $('video-wrap').style.width = `${width}px`;
  $('video-wrap').style.height = `${height}px`;
  canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.round(width * pixelRatio));
  canvas.height = Math.max(1, Math.round(height * pixelRatio));
  draw();
}
new ResizeObserver(resizeCanvas).observe($('stage'));
function draw() {
  if (!recording || video.readyState < 2) return;
  const camera = mode === 'preview' ? cameraAt(points, video.currentTime) : { zoom: 1, x: 0, y: 0 };
  ctx.drawImage(video, camera.x * video.videoWidth, camera.y * video.videoHeight, video.videoWidth / camera.zoom, video.videoHeight / camera.zoom, 0, 0, canvas.width, canvas.height);
  $('zoom-badge').textContent = `${camera.zoom.toFixed(1)}×`;
  updateTime();
}
function animate() { draw(); animation = !video.paused && !video.ended ? requestAnimationFrame(animate) : null; }
function updateTime() {
  $('current-time').textContent = time(video.currentTime, true);
  $('scrubber').value = video.currentTime || 0;
  $('playhead').style.left = `${recording ? clamp(video.currentTime / recording.duration, 0, 1) * 100 : 0}%`;
}
video.addEventListener('loadeddata', () => { resizeCanvas(); draw(); });
video.addEventListener('seeked', draw);
video.addEventListener('timeupdate', () => { updateTime(); if (video.paused) draw(); });
video.addEventListener('play', () => {
  $('play-button').innerHTML = icon('pause'); $('play-button').setAttribute('aria-label', 'Pause');
  if (!animation) animation = requestAnimationFrame(animate);
});
video.addEventListener('pause', () => {
  $('play-button').innerHTML = icon('play'); $('play-button').setAttribute('aria-label', 'Play');
  if (animation) { cancelAnimationFrame(animation); animation = null; } draw();
});
video.addEventListener('error', () => { if (recording) notice('This recording could not be played. Reload the app or import it again.', true); });
function seek(value) { if (recording) { video.currentTime = clamp(value, 0, recording.duration); updateTime(); } }
async function togglePlay() {
  if (!recording || uploading) return;
  if (!video.paused) return video.pause();
  repositioning = false; setMode('preview');
  if (video.ended || video.currentTime >= recording.duration - 0.01) seek(0);
  try { await video.play(); } catch (error) { notice(`Could not play the recording: ${error.message}`, true); }
}
$('play-button').onclick = togglePlay;
$('restart-button').onclick = () => { video.pause(); seek(0); };
$('scrubber').oninput = (event) => { video.pause(); seek(Number(event.target.value)); };
$('mute-button').onclick = () => {
  video.muted = !video.muted;
  $('mute-button').setAttribute('aria-label', video.muted ? 'Unmute preview' : 'Mute preview');
  $('mute-button').title = video.muted ? 'Unmute preview (export keeps audio)' : 'Mute preview';
  $('mute-button').style.color = video.muted ? 'var(--danger)' : '';
};

function renderPoints() {
  $('point-count').textContent = points.length;
  $('point-empty').hidden = points.length > 0;
  $('point-form').hidden = !selected;
  $('point-list').replaceChildren(); $('markers').replaceChildren(); $('focus-track').replaceChildren();
  points.forEach((point, index) => {
    const number = String(index + 1).padStart(2, '0');
    const row = document.createElement('button'); row.className = 'point-row'; row.setAttribute('aria-pressed', String(point.id === selected));
    row.innerHTML = `<span class="point-number">${number}</span><span class="point-row-name">Focus ${number}<span class="point-row-time">${time(point.time, true)} – ${time(point.time + point.duration, true)}</span></span><span class="point-row-zoom">${point.zoom.toFixed(1)}×</span>`;
    row.onclick = () => selectPoint(point.id); $('point-list').append(row);
    const marker = document.createElement('button'); marker.className = `focus-marker${point.id === selected ? ' selected' : ''}`;
    marker.style.left = `${point.x * 100}%`; marker.style.top = `${point.y * 100}%`; marker.textContent = index + 1;
    marker.title = `Select focus ${index + 1}`; marker.setAttribute('aria-label', marker.title);
    marker.onclick = (event) => { event.stopPropagation(); selectPoint(point.id); }; $('markers').append(marker);
    const block = document.createElement('button'); block.className = 'focus-block';
    block.style.left = `${point.time / recording.duration * 100}%`; block.style.width = `${point.duration / recording.duration * 100}%`;
    block.textContent = `${number} · ${point.zoom.toFixed(1)}×`;
    block.setAttribute('aria-pressed', String(point.id === selected)); block.setAttribute('aria-label', `Focus ${index + 1}, ${time(point.time)} to ${time(point.time + point.duration)}, ${point.zoom.toFixed(1)} times zoom`);
    block.title = block.getAttribute('aria-label'); block.onclick = () => selectPoint(point.id); $('focus-track').append(block);
  });
  $('timeline-help').textContent = recording ? `${points.length} focus ${points.length === 1 ? 'point' : 'points'} · click the track to seek` : 'Your focus points will appear here';
  const point = points.find((p) => p.id === selected);
  if (point) {
    $('selected-title').textContent = `Focus ${String(points.indexOf(point) + 1).padStart(2, '0')}`;
    $('zoom-input').value = point.zoom; $('zoom-value').textContent = `${point.zoom.toFixed(1)}×`;
    $('time-input').value = +point.time.toFixed(2); $('time-input').max = recording.duration - MIN_DURATION;
    $('duration-input').value = +point.duration.toFixed(2); $('duration-input').max = recording.duration;
  }
  draw();
}
function selectPoint(id) {
  selected = id; repositioning = false; $('point-error').hidden = true;
  setMode('edit');
  const point = points.find((p) => p.id === id); if (point) seek(point.time);
  renderPoints();
}
function addPoint(x, y) {
  if (!recording || uploading) return;
  video.pause();
  if (repositioning && selected) {
    points = points.map((p) => p.id === selected ? { ...p, x, y } : p);
    repositioning = false; setMode('edit'); renderPoints(); scheduleSave(); return;
  }
  const start = Math.round(video.currentTime * 100) / 100;
  const active = points.find((p) => start >= p.time && start < p.time + p.duration - 0.001);
  if (active) { selectPoint(active.id); notice('There is already a focus point here. Adjust it, or seek to a free part of the timeline.'); return; }
  const next = points.find((p) => p.time > start);
  const available = Math.min(next ? next.time - start : Infinity, recording.duration - start);
  if (available < MIN_DURATION) { notice('Move the playhead earlier to leave room for the zoom.', true); return; }
  const point = { id: Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join(""), time: start, duration: Math.min(3, available), zoom: 2, x, y };
  try { points = validatePoints([...points, point], recording.duration); } catch (error) { notice(error.message, true); return; }
  selected = point.id; setMode('edit'); $('point-error').hidden = true; renderPoints(); scheduleSave();
}
canvas.onclick = (event) => {
  const rect = canvas.getBoundingClientRect();
  const camera = mode === 'preview' ? cameraAt(points, video.currentTime) : { zoom: 1, x: 0, y: 0 };
  addPoint(clamp(camera.x + (event.clientX - rect.left) / rect.width / camera.zoom, 0, 1), clamp(camera.y + (event.clientY - rect.top) / rect.height / camera.zoom, 0, 1));
};
canvas.onkeydown = (event) => { if (event.key === 'Enter') { event.preventDefault(); addPoint(.5, .5); } };
$('add-button').onclick = () => { video.pause(); setMode('edit'); addPoint(.5, .5); };
$('reposition-button').onclick = () => { repositioning = true; setMode('edit'); canvas.focus(); };
$('delete-point').onclick = () => {
  const index = points.findIndex((p) => p.id === selected); points = points.filter((p) => p.id !== selected);
  selected = points[Math.min(index, points.length - 1)]?.id || null; repositioning = false;
  $('point-error').hidden = true; updateHint(); renderPoints(); scheduleSave();
};
$('point-form').onsubmit = (event) => event.preventDefault();
function editPoint(event) {
  if (!selected) return;
  const key = { 'zoom-input': 'zoom', 'time-input': 'time', 'duration-input': 'duration' }[event.target.id];
  const changes = { [key]: Number(event.target.value) };
  try {
    if (!event.target.value) throw new Error('Enter a start time and duration in seconds.');
    points = validatePoints(points.map((p) => p.id === selected ? { ...p, ...changes } : p), recording.duration);
    $('point-error').hidden = true;
    renderPoints(); scheduleSave();
  } catch (error) { $('point-error').textContent = error.message; $('point-error').hidden = false; }
}
$('zoom-input').oninput = editPoint;
$('time-input').onchange = editPoint;
$('duration-input').onchange = editPoint;

function populateRuler() {
  $('time-ruler').replaceChildren();
  const length = recording?.duration || 30;
  for (let i = 0; i <= 5; i++) { const label = document.createElement('span'); label.textContent = time(length * i / 5); $('time-ruler').append(label); }
}
async function loadRecording(data) {
  video.pause(); recording = data; points = validatePoints(data.points || [], data.duration); selected = null; repositioning = false;
  video.src = data.url; video.muted = false; video.load();
  $('project-name').textContent = data.name;
  $('project-name').title = data.name;
  $('total-time').textContent = time(data.duration, true);
  $('frame-info').textContent = `${data.width} × ${data.height} · ${Math.round(data.fps * 100) / 100} fps`;
  $('output-size').textContent = `${data.width} × ${data.height}`;
  $('output-audio').textContent = data.hasAudio ? 'Original audio' : 'No audio in source';
  $('audio-info').textContent = data.hasAudio ? 'Original audio kept' : 'Source has no audio';
  $('track-name').textContent = data.name; $('recording-track').classList.remove('empty');
  $('drop-zone').hidden = true; $('video-wrap').hidden = false;
  $('scrubber').max = data.duration; $('scrubber').value = 0;
  for (const id of ['play-button','restart-button','add-button','scrubber','export-button']) $(id).disabled = false;
  $('export-button').disabled = exportStarting || !!exportId;
  $('mute-button').disabled = !data.hasAudio; $('mute-button').style.color = ''; $('mute-button').setAttribute('aria-label', 'Mute preview');
  try { localStorage.setItem('demo-cut-video', data.id); } catch {}
  failedSave = false; updateSaveStatus(); setMode('edit'); renderPoints(); populateRuler(); resizeCanvas(); updateTime();
  $('footer-status').textContent = 'Ready';
}
function chooseFile() { if (!uploading) $('file-input').click(); }
$('import-button').onclick = chooseFile; $('choose-button').onclick = chooseFile;
$('file-input').onchange = (event) => { if (event.target.files[0]) void importFile(event.target.files[0]); event.target.value = ''; };
async function importFile(file) {
  if (uploading) return;
  if (file.size > 2 * 1024 * 1024 * 1024) { notice('This recording is larger than 2 GB. Import a smaller recording.', true); return; }
  if (!file.size) { notice('This file is empty. Choose a video recording.', true); return; }
  if (!(file.type.startsWith('video/') || /\.(mp4|mov|webm|mkv|avi|m4v|mpeg|mpg|mts)$/i.test(file.name))) { notice('Choose a video file, such as MP4, MOV or WebM.', true); return; }
  video.pause(); uploading = true;
  $('busy-overlay').hidden = false; $('busy-title').textContent = 'Importing recording…'; $('busy-detail').textContent = 'Your recording stays on this computer.'; $('upload-progress').value = 0;
  $('import-button').disabled = true; $('choose-button').disabled = true; $('export-button').disabled = true;
  $('footer-status').textContent = 'Importing…';
  try {
    if (recording) { await saveProject(); if (failedSave) { $('footer-status').textContent = 'Changes not saved'; return; } }
    const data = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest(); xhr.open('POST', `/api/videos?name=${encodeURIComponent(file.name)}`); xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) $('upload-progress').value = event.loaded / event.total * 100;
      };
      xhr.upload.onload = () => { $('busy-title').textContent = 'Preparing recording…'; $('busy-detail').textContent = 'Preparing playback and audio. Long recordings take more time.'; $('upload-progress').removeAttribute('value'); };
      xhr.onerror = () => reject(new Error('Connection lost. Check that Demo Cut is still running, then try again.'));
      xhr.onabort = () => reject(new Error('Import cancelled.'));
      xhr.onload = () => {
        let data; try { data = JSON.parse(xhr.responseText); } catch { reject(new Error('The app returned an unreadable response. Try again.')); return; }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data); else reject(new Error(data.error || 'Could not import this recording.'));
      };
      xhr.send(file);
    });
    await loadRecording(data); notice('Recording ready. Pause at a moment and click to add focus.');
  } catch (error) { notice(error.message, true); $('footer-status').textContent = 'Import failed'; }
  finally { uploading = false; $('busy-overlay').hidden = true; $('import-button').disabled = false; $('choose-button').disabled = false; $('export-button').disabled = !recording || exportStarting || !!exportId; }
}
document.addEventListener('dragenter', (event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); dragDepth++; $('drag-overlay').hidden = false; } });
document.addEventListener('dragover', (event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); });
document.addEventListener('dragleave', (event) => { if (event.dataTransfer.types.includes('Files')) { dragDepth--; if (dragDepth <= 0) $('drag-overlay').hidden = true; } });
document.addEventListener('drop', (event) => { event.preventDefault(); dragDepth = 0; $('drag-overlay').hidden = true; if (event.dataTransfer.files[0]) void importFile(event.dataTransfer.files[0]); });

$('export-button').onclick = async () => {
  if (!recording || exportStarting || exportId || uploading) return;
  if (!$('point-error').hidden) { notice('Fix the focus timing before exporting.', true); return; }
  exportStarting = true;
  $('export-button').disabled = true;
  video.pause(); await saveProject();
  if (failedSave) { exportStarting = false; $('export-button').disabled = false; return; }
  $('export-panel').hidden = false; $('export-title').textContent = 'Rendering MP4';
  $('export-detail').textContent = 'Applying focus points and keeping the source audio.';
  $('export-progress').hidden = false; $('export-progress').value = 0;
  $('download-link').hidden = true; $('close-export').hidden = true; $('cancel-export').hidden = false;
  try {
    const job = await api('/api/exports', { method: 'POST', body: JSON.stringify({ videoId: recording.id, points }) });
    exportId = job.id; exportStarting = false; $('footer-status').textContent = 'Exporting…'; void pollExport();
  } catch (error) { finishExportError(error.message); }
};
async function pollExport() {
  if (!exportId) return;
  try {
    const job = await api(`/api/exports/${exportId}`);
    $('export-progress').value = clamp(job.progress || 0, 0, 1) * 100;
    $('export-title').textContent = job.status === 'queued' ? 'Waiting to export' : `Rendering MP4 · ${Math.round((job.progress || 0) * 100)}%`;
    if (job.status === 'complete') {
      $('export-title').textContent = 'MP4 ready'; $('export-detail').textContent = 'Your export is ready to download.';
      $('export-progress').hidden = true; $('cancel-export').hidden = true;
      $('download-link').href = job.url; $('download-link').hidden = false; $('close-export').hidden = false;
      $('footer-status').textContent = 'Export ready'; exportId = null; $('export-button').disabled = false; return;
    }
    if (job.status === 'error') throw new Error(job.error || 'Export failed. Try exporting again.');
    if (job.status === 'cancelled') { finishExportError('Export cancelled. Your recording and focus points are unchanged.', 'Export cancelled'); return; }
    pollTimer = setTimeout(pollExport, 450);
  } catch (error) { finishExportError(error.message); }
}
function finishExportError(message, title = 'Could not export') {
  exportId = null; exportStarting = false; clearTimeout(pollTimer); $('export-button').disabled = !recording || uploading;
  $('export-title').textContent = title; $('export-detail').textContent = message;
  $('export-progress').hidden = true; $('cancel-export').hidden = true; $('close-export').hidden = false;
  $('footer-status').textContent = title;
}
$('cancel-export').onclick = async () => {
  if (!exportId) return;
  try { await api(`/api/exports/${exportId}`, { method: 'DELETE' }); } catch (error) { notice(`Could not cancel: ${error.message}`, true); }
};
$('close-export').onclick = () => { $('export-panel').hidden = true; };
document.addEventListener('keydown', (event) => {
  if (/^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(event.target.tagName) || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.code === 'Space') { event.preventDefault(); void togglePlay(); }
  if (event.code === 'ArrowLeft' && recording) { event.preventDefault(); video.pause(); seek(video.currentTime - 1 / recording.fps); }
  if (event.code === 'ArrowRight' && recording) { event.preventDefault(); video.pause(); seek(video.currentTime + 1 / recording.fps); }
});

$('recording-track').classList.add('empty'); populateRuler();
try {
  const all = await api('/api/videos');
  let last = null; try { last = localStorage.getItem('demo-cut-video'); } catch {}
  const previous = all.find((v) => v.id === last) || all.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (previous) await loadRecording(await api(`/api/videos/${previous.id}`));
} catch (error) { notice(`Could not open the local workspace: ${error.message}`, true); }
