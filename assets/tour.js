// Gemeinsame Hilfsfunktionen für Viewer und Editor.
//
// Tour-Format (tours/<id>/tour.json):
// {
//   "title": "Showroom",
//   "company": "Firma A",
//   "firstScene": "eingang",
//   "autoRotate": -2,              // Grad/Sekunde, 0 = aus
//   "scenes": {
//     "eingang": {
//       "title": "Eingang",
//       "panorama": "eingang.jpg",  // relativ zum Tour-Ordner
//       "yaw": 0, "pitch": 0, "hfov": 100,
//       "hotSpots": [
//         { "type": "scene", "sceneId": "halle", "pitch": -5, "yaw": 40, "text": "Zur Halle" },
//         { "type": "info", "pitch": 10, "yaw": -20, "text": "Unser Team", "url": "https://..." }
//       ]
//     }
//   }
// }

export const TOUR_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

export async function loadTour(id) {
  if (!TOUR_ID_PATTERN.test(id)) throw new Error(`Ungültige Tour-ID: ${id}`);
  const res = await fetch(`tours/${id}/tour.json`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Tour "${id}" nicht gefunden (${res.status})`);
  return res.json();
}

export async function loadTourIndex() {
  const res = await fetch('tours/index.json', { cache: 'no-cache' });
  if (!res.ok) return [];
  return res.json();
}

export function toPannellumHotSpot(hs, scenes) {
  if (hs.type === 'scene') {
    const target = scenes[hs.sceneId];
    return {
      type: 'scene',
      sceneId: hs.sceneId,
      pitch: hs.pitch,
      yaw: hs.yaw,
      text: hs.text || target?.title || hs.sceneId,
      ...(hs.targetYaw !== undefined && { targetYaw: hs.targetYaw }),
      ...(hs.targetPitch !== undefined && { targetPitch: hs.targetPitch }),
    };
  }
  return {
    type: 'info',
    pitch: hs.pitch,
    yaw: hs.yaw,
    text: hs.text || '',
    ...(hs.url && { URL: hs.url }),
  };
}

// Baut die Pannellum-Konfiguration für eine komplette Tour.
// resolvePanorama(fileName) liefert die URL des Bildes.
export function buildViewerConfig(tour, resolvePanorama, overrides = {}) {
  const scenes = {};
  for (const [id, scene] of Object.entries(tour.scenes || {})) {
    scenes[id] = {
      type: 'equirectangular',
      panorama: resolvePanorama(scene.panorama),
      yaw: scene.yaw ?? 0,
      pitch: scene.pitch ?? 0,
      hfov: scene.hfov ?? 100,
      hotSpots: (scene.hotSpots || []).map((hs) => toPannellumHotSpot(hs, tour.scenes)),
    };
  }
  return {
    default: {
      firstScene: tour.firstScene || Object.keys(scenes)[0],
      sceneFadeDuration: 700,
      autoLoad: true,
      autoRotate: tour.autoRotate ?? 0,
      autoRotateInactivityDelay: 8000,
      showZoomCtrl: true,
      showFullscreenCtrl: true,
      compass: false,
      ...overrides,
    },
    scenes,
  };
}

export function slugify(text) {
  return (
    String(text)
      .toLowerCase()
      .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
      .normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'szene'
  );
}

export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
