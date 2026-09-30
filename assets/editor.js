import {
  TOUR_ID_PATTERN, loadTour, loadTourIndex, buildViewerConfig, slugify, escapeHtml,
} from './tour.js';
import { createZip } from './zip.js';

const MAX_WIDTH = 8192;
const JPEG_QUALITY = 0.88;

const $ = (sel) => document.querySelector(sel);

const state = {
  tour: emptyTour(),
  images: new Map(),   // Dateiname -> { url, blob? }
  index: [],           // Inhalt von tours/index.json
  loadedId: null,      // ID, unter der die Tour geladen wurde
  currentScene: null,
  selectedHotSpot: null,
  mode: null,          // 'scene' | 'info' | 'preview' | null
  dirty: false,
};

let viewer = null;
let shownHotSpotIds = [];

function emptyTour() {
  return { title: '', company: '', firstScene: null, autoRotate: -2, scenes: {} };
}

// ---------- Hilfsfunktionen ----------

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2500);
}

function markDirty() { state.dirty = true; }

const round = (n) => Math.round(n * 100) / 100;

function uniqueKey(base, taken) {
  let key = base;
  for (let i = 2; taken.has(key); i++) key = `${base}-${i}`;
  return key;
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function currentSceneData() {
  return state.tour.scenes[state.currentScene];
}

// ---------- Bilder ----------

async function prepareImage(file) {
  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;
  const ratio = width / height;
  if (Math.abs(ratio - 2) > 0.05) {
    toast(`Achtung: ${file.name} hat kein 2:1-Format (${width}×${height}).`);
  }
  if (width <= MAX_WIDTH) {
    bitmap.close();
    return { blob: file, ext: file.name.split('.').pop().toLowerCase() };
  }
  const canvas = document.createElement('canvas');
  canvas.width = MAX_WIDTH;
  canvas.height = Math.round(MAX_WIDTH / ratio);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
  return { blob, ext: 'jpg' };
}

async function addSceneFiles(files) {
  for (const file of files) {
    toast(`Lade ${file.name} …`);
    let prepared;
    try {
      prepared = await prepareImage(file);
    } catch (err) {
      toast(`${file.name} konnte nicht gelesen werden.`);
      continue;
    }
    const base = slugify(file.name.replace(/\.[^.]+$/, ''));
    const fileName = uniqueKey(base, new Set([...state.images.keys()].map((f) => f.replace(/\.[^.]+$/, '')))) + '.' + prepared.ext;
    const sceneId = uniqueKey(base, new Set(Object.keys(state.tour.scenes)));
    state.images.set(fileName, { url: URL.createObjectURL(prepared.blob), blob: prepared.blob });
    state.tour.scenes[sceneId] = {
      title: file.name.replace(/\.[^.]+$/, ''),
      panorama: fileName,
      yaw: 0, pitch: 0, hfov: 100,
      hotSpots: [],
    };
    if (!state.tour.firstScene) state.tour.firstScene = sceneId;
    markDirty();
    if (!state.currentScene) selectScene(sceneId);
  }
  renderScenes();
  toast('Panoramen hinzugefügt.');
}

// ---------- Viewer ----------

function destroyViewer() {
  if (viewer) viewer.destroy();
  viewer = null;
  shownHotSpotIds = [];
}

function editorHotSpot(hs, index) {
  const isScene = hs.type === 'scene';
  const target = isScene ? state.tour.scenes[hs.sceneId] : null;
  return {
    id: `hs-${index}`,
    type: 'info',
    pitch: hs.pitch,
    yaw: hs.yaw,
    text: isScene ? `→ ${hs.text || target?.title || hs.sceneId || '(kein Ziel)'}` : (hs.text || '(ohne Text)'),
    cssClass: `pnlm-hotspot pnlm-sprite pnlm-${isScene ? 'scene' : 'info'}${index === state.selectedHotSpot ? ' hs-selected' : ''}`,
    clickHandlerFunc: () => { state.selectedHotSpot = index; renderHotSpots(); },
  };
}

function refreshViewerHotSpots() {
  if (!viewer || state.mode === 'preview') return;
  for (const id of shownHotSpotIds) viewer.removeHotSpot(id);
  const hotSpots = currentSceneData()?.hotSpots || [];
  shownHotSpotIds = hotSpots.map((hs, i) => {
    viewer.addHotSpot(editorHotSpot(hs, i));
    return `hs-${i}`;
  });
}

function showEditViewer() {
  const scene = currentSceneData();
  const keepView = viewer && state.mode !== 'preview' && viewer._sceneId === state.currentScene
    ? { yaw: viewer.getYaw(), pitch: viewer.getPitch(), hfov: viewer.getHfov() }
    : null;
  destroyViewer();
  $('#placeholder').hidden = !!scene;
  $('#toolbar').hidden = !scene;
  if (!scene) return;
  viewer = pannellum.viewer('pano', {
    type: 'equirectangular',
    panorama: state.images.get(scene.panorama)?.url,
    autoLoad: true,
    yaw: keepView?.yaw ?? scene.yaw ?? 0,
    pitch: keepView?.pitch ?? scene.pitch ?? 0,
    hfov: keepView?.hfov ?? scene.hfov ?? 100,
    showFullscreenCtrl: false,
  });
  viewer._sceneId = state.currentScene;
  viewer.on('load', refreshViewerHotSpots);
}

function showPreviewViewer() {
  destroyViewer();
  const config = buildViewerConfig(
    state.tour,
    (file) => state.images.get(file)?.url,
    { firstScene: state.currentScene || state.tour.firstScene, autoRotate: 0 },
  );
  viewer = pannellum.viewer('pano', config);
  viewer.on('scenechange', (id) => {
    state.currentScene = id;
    state.selectedHotSpot = null;
    renderScenes();
  });
}

function setMode(mode) {
  const wasPreview = state.mode === 'preview';
  state.mode = state.mode === mode ? null : mode;
  for (const btn of document.querySelectorAll('#toolbar button')) {
    btn.classList.toggle('active', btn.dataset.mode === state.mode);
  }
  $('#stage').classList.toggle('placing', state.mode === 'scene' || state.mode === 'info');
  if (state.mode === 'preview') showPreviewViewer();
  else if (wasPreview) showEditViewer();
  if (state.mode === 'scene' || state.mode === 'info') toast('Jetzt ins Panorama klicken, um den Punkt zu setzen.');
}

// Klick (ohne Ziehen) ins Panorama setzt einen Hotspot.
let pointerStart = null;
$('#pano').addEventListener('pointerdown', (e) => { pointerStart = { x: e.clientX, y: e.clientY }; });
$('#pano').addEventListener('pointerup', (e) => {
  if (!pointerStart || !viewer) return;
  const moved = Math.hypot(e.clientX - pointerStart.x, e.clientY - pointerStart.y);
  pointerStart = null;
  if (moved > 5 || (state.mode !== 'scene' && state.mode !== 'info')) return;
  if (e.target.closest('.pnlm-controls-container, .pnlm-hotspot-base')) return;

  const [pitch, yaw] = viewer.mouseEventToCoords(e);
  const scene = currentSceneData();
  const hs = { type: state.mode, pitch: round(pitch), yaw: round(yaw), text: '' };
  if (state.mode === 'scene') {
    hs.sceneId = Object.keys(state.tour.scenes).find((id) => id !== state.currentScene) || '';
  }
  scene.hotSpots.push(hs);
  state.selectedHotSpot = scene.hotSpots.length - 1;
  markDirty();
  setMode(state.mode); // Platzier-Modus beenden
  refreshViewerHotSpots();
  renderHotSpots();
  if (hs.type === 'scene' && !hs.sceneId) toast('Tipp: Füge weitere Szenen hinzu, um sie zu verlinken.');
});

// ---------- Rendering Sidebar ----------

function renderTourFields() {
  $('#tour-id').value = state.loadedId || '';
  $('#tour-title').value = state.tour.title || '';
  $('#tour-company').value = state.tour.company || '';
  $('#tour-autorotate').value = state.tour.autoRotate ?? 0;
  const entry = state.index.find((t) => t.id === state.loadedId);
  $('#tour-listed').checked = entry ? entry.listed !== false : true;
}

function renderScenes({ panel = true } = {}) {
  const list = $('#scene-list');
  list.innerHTML = '';
  for (const [id, scene] of Object.entries(state.tour.scenes)) {
    const item = document.createElement('div');
    item.className = 'list-item' + (id === state.currentScene ? ' selected' : '');
    item.innerHTML = `
      <div class="head">
        <span>${escapeHtml(scene.title || id)}</span>
        <span>
          ${id === state.tour.firstScene ? '<span class="badge">Start</span>' : ''}
          <span class="badge">${scene.hotSpots.length} Hotspots</span>
        </span>
      </div>`;
    item.addEventListener('click', () => selectScene(id));
    list.append(item);
  }
  if (panel) renderScenePanel();
}

function renderScenePanel() {
  const scene = currentSceneData();
  $('#scene-panel').hidden = !scene;
  if (!scene) return;
  $('#scene-title').value = scene.title || '';
  $('#set-first').disabled = state.tour.firstScene === state.currentScene;
  renderHotSpots();
}

function renderHotSpots() {
  const scene = currentSceneData();
  const list = $('#hotspot-list');
  list.innerHTML = '';
  if (!scene) return;
  if (!scene.hotSpots.length) {
    list.innerHTML = '<p class="hint">Noch keine Hotspots in dieser Szene.</p>';
  }
  const sceneOptions = Object.entries(state.tour.scenes)
    .filter(([id]) => id !== state.currentScene)
    .map(([id, s]) => [id, s.title || id]);

  scene.hotSpots.forEach((hs, i) => {
    const item = document.createElement('div');
    item.className = 'list-item' + (i === state.selectedHotSpot ? ' selected' : '');
    const isScene = hs.type === 'scene';
    item.innerHTML = `
      <div class="head">
        <span>${isScene ? '📍 Szenen-Link' : 'ℹ️ Info-Punkt'}</span>
        <span class="row" style="margin:0">
          <button data-act="look" title="Hinsehen">👁</button>
          <button data-act="delete" class="danger" title="Löschen">✕</button>
        </span>
      </div>
      ${isScene ? `
        <label>Ziel-Szene</label>
        <select data-field="sceneId">
          ${sceneOptions.length ? '' : '<option value="">– keine weitere Szene –</option>'}
          ${sceneOptions.map(([id, title]) => `<option value="${escapeHtml(id)}" ${id === hs.sceneId ? 'selected' : ''}>${escapeHtml(title)}</option>`).join('')}
        </select>
        <label>Beschriftung (optional)</label>
        <input data-field="text" value="${escapeHtml(hs.text)}" placeholder="Name der Ziel-Szene">
      ` : `
        <label>Text</label>
        <input data-field="text" value="${escapeHtml(hs.text)}" placeholder="z. B. Unsere Werkstatt">
        <label>Link (optional)</label>
        <input data-field="url" value="${escapeHtml(hs.url || '')}" placeholder="https://…">
      `}`;
    item.querySelector('.head').addEventListener('click', (e) => {
      const act = e.target.closest('button')?.dataset.act;
      if (act === 'delete') {
        scene.hotSpots.splice(i, 1);
        state.selectedHotSpot = null;
        markDirty();
        refreshViewerHotSpots();
        renderScenes();
        return;
      }
      state.selectedHotSpot = i;
      if (act === 'look' && viewer && state.mode !== 'preview') viewer.lookAt(hs.pitch, hs.yaw);
      renderHotSpots();
      refreshViewerHotSpots();
    });
    for (const input of item.querySelectorAll('[data-field]')) {
      input.addEventListener('change', () => {
        const value = input.value.trim();
        if (value) hs[input.dataset.field] = value;
        else if (input.dataset.field === 'text') hs.text = '';
        else delete hs[input.dataset.field];
        markDirty();
        refreshViewerHotSpots();
      });
    }
    list.append(item);
  });
}

function selectScene(id) {
  state.currentScene = id;
  state.selectedHotSpot = null;
  if (state.mode === 'preview') {
    if (viewer.getScene() !== id) viewer.loadScene(id);
  } else {
    showEditViewer();
  }
  renderScenes();
}

// ---------- Tour laden / neu ----------

function resetTour() {
  for (const img of state.images.values()) if (img.blob) URL.revokeObjectURL(img.url);
  state.images.clear();
  state.tour = emptyTour();
  state.loadedId = null;
  state.currentScene = null;
  state.selectedHotSpot = null;
  state.dirty = false;
  if (state.mode) setMode(state.mode);
  destroyViewer();
}

function confirmDiscard() {
  return !state.dirty || confirm('Ungespeicherte Änderungen verwerfen?');
}

async function openTour(id) {
  const tour = await loadTour(id);
  resetTour();
  tour.scenes ||= {};
  for (const scene of Object.values(tour.scenes)) {
    scene.hotSpots ||= [];
    state.images.set(scene.panorama, { url: `tours/${id}/${scene.panorama}` });
  }
  state.tour = tour;
  state.loadedId = id;
  renderTourFields();
  selectScene(tour.firstScene || Object.keys(tour.scenes)[0] || null);
  history.replaceState(null, '', `?tour=${encodeURIComponent(id)}`);
}

// ---------- Export ----------

function cleanTourJson() {
  const tour = state.tour;
  const scenes = {};
  for (const [id, s] of Object.entries(tour.scenes)) {
    scenes[id] = {
      title: s.title,
      panorama: s.panorama,
      yaw: round(s.yaw ?? 0),
      pitch: round(s.pitch ?? 0),
      hfov: round(s.hfov ?? 100),
      hotSpots: s.hotSpots
        .filter((hs) => hs.type !== 'scene' || tour.scenes[hs.sceneId])
        .map((hs) => {
          const out = { type: hs.type, pitch: hs.pitch, yaw: hs.yaw };
          if (hs.type === 'scene') out.sceneId = hs.sceneId;
          if (hs.text) out.text = hs.text;
          if (hs.url) out.url = hs.url;
          return out;
        }),
    };
  }
  return {
    title: tour.title,
    company: tour.company,
    firstScene: tour.firstScene,
    autoRotate: Number(tour.autoRotate) || 0,
    scenes,
  };
}

function validateForExport() {
  const id = $('#tour-id').value.trim();
  if (!TOUR_ID_PATTERN.test(id)) {
    toast('Bitte eine gültige ID vergeben (nur a–z, 0–9, - und _).');
    $('#tour-id').focus();
    return null;
  }
  if (!Object.keys(state.tour.scenes).length) {
    toast('Die Tour hat noch keine Szenen.');
    return null;
  }
  const broken = Object.values(state.tour.scenes)
    .flatMap((s) => s.hotSpots)
    .filter((hs) => hs.type === 'scene' && !state.tour.scenes[hs.sceneId]);
  if (broken.length && !confirm(`${broken.length} Szenen-Link(s) ohne gültiges Ziel werden beim Export entfernt. Fortfahren?`)) {
    return null;
  }
  return id;
}

async function exportZip() {
  const id = validateForExport();
  if (!id) return;
  toast('ZIP wird erstellt …');
  const files = [{ name: `tours/${id}/tour.json`, data: JSON.stringify(cleanTourJson(), null, 2) + '\n' }];
  const used = new Set(Object.values(state.tour.scenes).map((s) => s.panorama));
  for (const name of used) {
    const img = state.images.get(name);
    let blob = img?.blob;
    if (!blob) {
      const res = await fetch(img.url);
      if (!res.ok) { toast(`Bild ${name} konnte nicht geladen werden.`); return; }
      blob = await res.blob();
    }
    files.push({ name: `tours/${id}/${name}`, data: blob });
  }

  const index = state.index.filter((t) => t.id !== id && t.id !== state.loadedId);
  index.push({
    id,
    title: state.tour.title || id,
    company: state.tour.company || '',
    ...(!$('#tour-listed').checked && { listed: false }),
  });
  index.sort((a, b) => (a.company || '').localeCompare(b.company || '') || a.title.localeCompare(b.title));
  files.push({ name: 'tours/index.json', data: JSON.stringify(index, null, 2) + '\n' });

  download(await createZip(files), `tour-${id}.zip`);
  state.index = index;
  state.dirty = false;
  if (state.loadedId && state.loadedId !== id) {
    toast(`Exportiert. Den alten Ordner tours/${state.loadedId}/ kannst du löschen.`);
  } else {
    toast('Exportiert. ZIP im Projektordner entpacken und pushen.');
  }
  state.loadedId = id;
}

function exportJson() {
  if (!validateForExport()) return;
  download(new Blob([JSON.stringify(cleanTourJson(), null, 2) + '\n'], { type: 'application/json' }), 'tour.json');
  state.dirty = false;
}

// ---------- Event-Handler ----------

$('#add-scenes').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', async (e) => {
  await addSceneFiles([...e.target.files]);
  e.target.value = '';
});

$('#tour-title').addEventListener('input', (e) => {
  state.tour.title = e.target.value;
  if (!state.loadedId && !$('#tour-id').dataset.touched) $('#tour-id').value = slugify(e.target.value);
  markDirty();
});
$('#tour-id').addEventListener('input', (e) => { e.target.dataset.touched = '1'; markDirty(); });
$('#tour-company').addEventListener('input', (e) => { state.tour.company = e.target.value; markDirty(); });
$('#tour-autorotate').addEventListener('input', (e) => { state.tour.autoRotate = Number(e.target.value) || 0; markDirty(); });
$('#tour-listed').addEventListener('change', markDirty);

$('#scene-title').addEventListener('input', (e) => {
  currentSceneData().title = e.target.value;
  markDirty();
  renderScenes({ panel: false });
});
$('#set-first').addEventListener('click', () => {
  state.tour.firstScene = state.currentScene;
  markDirty();
  renderScenes();
});
$('#set-view').addEventListener('click', () => {
  if (!viewer) return;
  const scene = currentSceneData();
  scene.yaw = round(viewer.getYaw());
  scene.pitch = round(viewer.getPitch());
  scene.hfov = round(viewer.getHfov());
  markDirty();
  toast('Startblick gespeichert.');
});
$('#delete-scene').addEventListener('click', () => {
  const id = state.currentScene;
  if (!confirm(`Szene „${currentSceneData().title || id}“ löschen? Links auf diese Szene werden ebenfalls entfernt.`)) return;
  const { panorama } = state.tour.scenes[id];
  delete state.tour.scenes[id];
  for (const s of Object.values(state.tour.scenes)) {
    s.hotSpots = s.hotSpots.filter((hs) => hs.sceneId !== id);
  }
  if (!Object.values(state.tour.scenes).some((s) => s.panorama === panorama)) {
    const img = state.images.get(panorama);
    if (img?.blob) URL.revokeObjectURL(img.url);
    state.images.delete(panorama);
  }
  const remaining = Object.keys(state.tour.scenes);
  if (state.tour.firstScene === id) state.tour.firstScene = remaining[0] || null;
  markDirty();
  if (state.mode === 'preview') setMode('preview');
  selectScene(remaining[0] || null);
});

for (const btn of document.querySelectorAll('#toolbar button')) {
  btn.addEventListener('click', () => setMode(btn.dataset.mode));
}

$('#new-tour').addEventListener('click', () => {
  if (!confirmDiscard()) return;
  resetTour();
  delete $('#tour-id').dataset.touched;
  $('#tour-select').value = '';
  renderTourFields();
  renderScenes();
  showEditViewer();
  history.replaceState(null, '', location.pathname);
});

$('#tour-select').addEventListener('change', async (e) => {
  const id = e.target.value;
  if (!id) return;
  if (!confirmDiscard()) { e.target.value = state.loadedId || ''; return; }
  try {
    await openTour(id);
  } catch (err) {
    toast(err.message);
  }
});

$('#export-zip').addEventListener('click', () => exportZip().catch((err) => toast(err.message)));
$('#export-json').addEventListener('click', exportJson);

window.addEventListener('beforeunload', (e) => {
  if (state.dirty) e.preventDefault();
});

// ---------- Start ----------

(async () => {
  state.index = await loadTourIndex();
  const select = $('#tour-select');
  for (const t of state.index) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.company ? `${t.company} – ${t.title}` : t.title;
    select.append(opt);
  }
  renderTourFields();
  renderScenes();
  const id = new URLSearchParams(location.search).get('tour');
  if (id) {
    select.value = id;
    try { await openTour(id); } catch (err) { toast(err.message); }
  }
})();
