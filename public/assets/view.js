import { loadTour, buildViewerConfig, escapeHtml } from './tour.js';

// URL-Parameter:
//   tour=<id>        Pflicht
//   scene=<id>       Startszene (auch per #scene=<id>)
//   title=1          Tour-Titel oben einblenden
//   nav=0            Szenenleiste ausblenden
//   thumbs=1         Szenenleiste aufgeklappt starten
//   autorotate=<n>   Auto-Rotation überschreiben (0 = aus)
const params = new URLSearchParams(location.search);
const hash = new URLSearchParams(location.hash.slice(1));
const tourId = params.get('tour');

function showError(message) {
  document.body.insertAdjacentHTML('beforeend', `<div class="error-box">${escapeHtml(message)}</div>`);
}

async function main() {
  if (!tourId) return showError('Keine Tour angegeben (?tour=...).');

  let tour;
  try {
    tour = await loadTour(tourId);
  } catch (err) {
    return showError(err.message);
  }

  document.title = tour.title ? `${tour.title} – 360°` : '360° Rundgang';

  const overrides = {};
  const startScene = hash.get('scene') || params.get('scene');
  if (startScene && tour.scenes?.[startScene]) overrides.firstScene = startScene;
  if (params.has('autorotate')) overrides.autoRotate = Number(params.get('autorotate')) || 0;

  const base = `tours/${tourId}/`;
  const config = buildViewerConfig(tour, (file) => base + file, overrides);
  const viewer = pannellum.viewer('pano', config);

  if (tour.title && params.get('title') === '1') {
    const el = document.getElementById('title');
    el.textContent = tour.title;
    el.hidden = false;
  }

  const sceneIds = Object.keys(tour.scenes || {});
  const nav = document.getElementById('scenes');
  const list = document.createElement('div');
  list.className = 'scene-list';
  if (sceneIds.length > 1 && params.get('nav') !== '0') {
    const hasThumbs = sceneIds.some((id) => tour.scenes[id].thumb);
    nav.classList.toggle('with-thumbs', hasThumbs);
    for (const id of sceneIds) {
      const scene = tour.scenes[id];
      const btn = document.createElement('button');
      btn.dataset.scene = id;
      btn.title = scene.title || id;
      if (hasThumbs && scene.thumb) {
        const img = document.createElement('img');
        img.src = base + scene.thumb;
        img.alt = scene.title || id;
        img.loading = 'lazy';
        btn.append(img);
      } else {
        btn.textContent = scene.title || id;
      }
      btn.addEventListener('click', () => {
        if (viewer.getScene() !== id) viewer.loadScene(id);
      });
      list.append(btn);
    }
    const toggle = document.createElement('button');
    toggle.className = 'scene-toggle';
    toggle.setAttribute('aria-label', 'Ansichten ein-/ausblenden');
    const setOpen = (open) => {
      nav.classList.toggle('collapsed', !open);
      toggle.textContent = open ? '▾' : '▴ Ansichten';
    };
    toggle.addEventListener('click', () => setOpen(nav.classList.contains('collapsed')));
    setOpen(params.get('thumbs') === '1');
    nav.append(toggle, list);
    nav.hidden = false;
  }

  const markCurrent = (id) => {
    for (const btn of list.children) {
      const current = btn.dataset.scene === id;
      btn.classList.toggle('current', current);
      if (current) btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    history.replaceState(null, '', `#scene=${encodeURIComponent(id)}`);
  };
  markCurrent(config.default.firstScene);
  viewer.on('scenechange', markCurrent);
}

main();
