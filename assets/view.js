import { loadTour, buildViewerConfig, escapeHtml } from './tour.js';

// URL-Parameter:
//   tour=<id>        Pflicht
//   scene=<id>       Startszene (auch per #scene=<id>)
//   title=0          Titel ausblenden
//   nav=0            Szenenleiste ausblenden
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

  if (tour.title && params.get('title') !== '0') {
    const el = document.getElementById('title');
    el.textContent = tour.title;
    el.hidden = false;
  }

  const sceneIds = Object.keys(tour.scenes || {});
  const nav = document.getElementById('scenes');
  if (sceneIds.length > 1 && params.get('nav') !== '0') {
    for (const id of sceneIds) {
      const btn = document.createElement('button');
      btn.textContent = tour.scenes[id].title || id;
      btn.dataset.scene = id;
      btn.addEventListener('click', () => {
        if (viewer.getScene() !== id) viewer.loadScene(id);
      });
      nav.append(btn);
    }
    nav.hidden = false;
  }

  const markCurrent = (id) => {
    for (const btn of nav.children) btn.classList.toggle('current', btn.dataset.scene === id);
    history.replaceState(null, '', `#scene=${encodeURIComponent(id)}`);
  };
  markCurrent(config.default.firstScene);
  viewer.on('scenechange', markCurrent);
}

main();
