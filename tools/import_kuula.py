#!/usr/bin/env python3
"""Importiert eine öffentliche Kuula-Collection als Tour in tours/<id>/.

Verwendung:
    python3 tools/import_kuula.py <kuula-url-oder-collection-id> [--id tour-id] [--company "Firma"]

Übernommen werden Panoramen (höchste verfügbare Auflösung bis 8192 px), Szenenreihenfolge,
Startszene, Startblick und Szenen-Links. „Sticker“ am Boden (z. B. Logo über dem Stativ)
werden direkt ins Panorama eingerechnet (benötigt Pillow + numpy).

Koordinaten: Kuula speichert Hotspots als Richtungsvektor (x, y, z) mit y nach oben.
Die Bildspalte ergibt sich aus atan2(z, x) (0° = Bildmitte), die Höhe aus asin(y).
Der Startblick („heading“) ist dagegen um 90° versetzt: yaw = heading - 90°.
"""

import argparse
import base64
import json
import math
import re
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / 'public'
MAX_SIZE = 8192
IMAGE_CDN = 'https://files.kuula.io'
MEDIA_CDN = 'https://media.kuula.io'


def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (kuula-import)'})
    with urllib.request.urlopen(req, timeout=120) as res:
        return res.read()


def slugify(text):
    text = text.lower()
    for a, b in (('ä', 'ae'), ('ö', 'oe'), ('ü', 'ue'), ('ß', 'ss')):
        text = text.replace(a, b)
    return re.sub(r'[^a-z0-9]+', '-', text).strip('-') or 'tour'


def load_collection(ref):
    match = re.search(r'collection/(\w+)', ref)
    cid = match.group(1) if match else ref.strip()
    html = fetch(f'https://kuula.co/share/collection/{cid}').decode('utf-8')
    match = re.search(r'KUULA_COLLECTION=\{id:"\w+",data:"([^"]+)"', html)
    if not match:
        sys.exit(f'Keine Collection-Daten für {cid} gefunden (ist sie öffentlich?)')
    return json.loads(base64.b64decode(match.group(1)))


def norm_yaw(deg):
    return round((deg + 180) % 360 - 180, 2)


def vec_to_view(pos):
    x, y, z = pos['x'], pos['y'], pos['z']
    length = math.sqrt(x * x + y * y + z * z) or 1
    return round(math.degrees(math.asin(y / length)), 2), norm_yaw(math.degrees(math.atan2(z, x)))


def pick_size(photo):
    sizes = sorted(int(s) for s in photo['sizes'])
    fitting = [s for s in sizes if s <= MAX_SIZE]
    return fitting[-1] if fitting else sizes[0]


def shrink(path, size):
    from PIL import Image
    img = Image.open(path).convert('RGB')
    img.thumbnail((size, size))
    img.save(path, quality=82, optimize=True)


def bake_stickers(path, stickers):
    """Rechnet Boden-Sticker (Logo am Nadir) ins equirektangulare Bild ein."""
    import io
    import numpy as np
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = None

    pano = Image.open(path).convert('RGB')
    W, H = pano.size
    arr = np.asarray(pano).astype(np.float32)
    for sticker in stickers:
        img = Image.open(io.BytesIO(fetch(sticker['url']))).convert('RGBA')
        tex = np.asarray(img).astype(np.float32)
        th, tw = tex.shape[:2]
        # Sticker liegt flach auf dem Boden, Kamera 1 Einheit darüber.
        # half = halbe Kantenlänge in Boden-Einheiten (Kuula: size 100 ≈ 0.26).
        half = sticker['size'] / 100 * 0.26
        cx, cz = sticker['x'], sticker['z']
        max_angle = math.atan(math.hypot(cx, cz) + half * 1.5)
        rows = int(H * (1 - max_angle / math.pi)) - 1
        v = np.arange(rows, H)
        u = np.arange(W)
        U, V = np.meshgrid(u, v)
        lon = (U + 0.5) / W * 2 * np.pi - np.pi
        lat = np.pi / 2 - (V + 0.5) / H * np.pi
        dist = 1 / np.tan(-lat)                       # Abstand auf dem Boden
        px, pz = np.cos(lon) * dist, np.sin(lon) * dist
        sx = ((px - cx) / half + 1) / 2 * tw
        sz = ((pz - cz) / half + 1) / 2 * th
        inside = (sx >= 0) & (sx < tw) & (sz >= 0) & (sz < th)
        sxi = np.clip(sx.astype(int), 0, tw - 1)
        szi = np.clip(sz.astype(int), 0, th - 1)
        rgba = tex[szi, sxi]
        alpha = (rgba[..., 3:] / 255) * inside[..., None]
        region = arr[rows:H]
        arr[rows:H] = region * (1 - alpha) + rgba[..., :3] * alpha
    Image.fromarray(arr.clip(0, 255).astype(np.uint8)).save(path, quality=88, optimize=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('collection', help='Kuula-Link, iframe-Code oder Collection-ID')
    parser.add_argument('--id', help='Tour-ID (Ordnername), Standard: aus dem Namen')
    parser.add_argument('--company', default='', help='Firmenname für die Übersicht')
    parser.add_argument('--title', help='Titel (Standard: Name der Collection)')
    parser.add_argument('--autorotate', type=float, default=-2, help='Auto-Rotation in °/s (0 = aus)')
    args = parser.parse_args()

    data = load_collection(args.collection)
    title = args.title or data['name']
    tour_id = args.id or slugify(title)
    out_dir = ROOT / 'tours' / tour_id
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f'Collection „{data["name"]}“ → tours/{tour_id}/ ({len(data["posts"])} Szenen)')

    posts = sorted(data['posts'], key=lambda p: int(p.get('position') or 0))
    scene_ids = {p['id']: f'szene-{i + 1:02d}' for i, p in enumerate(posts)}
    scenes, downloads, stickers = {}, [], {}

    for i, post in enumerate(posts):
        sid = scene_ids[post['id']]
        photo = post['photos'][0]
        opts = photo.get('options') or {}
        size = pick_size(photo)
        file_name = f'{sid}.jpg'
        downloads.append((f'{IMAGE_CDN}/{post["uuid"]}/{photo["name"]}-{size}.jpg', out_dir / file_name))
        thumb_name = f'{sid}-thumb.jpg'
        cover = str(post.get('cover') or photo['name']).lstrip('n')
        downloads.append((f'{IMAGE_CDN}/{post["uuid"]}/{cover}-cover.jpg', out_dir / thumb_name))

        desc = (post.get('description') or '').strip()
        looks_like_file = re.match(r'^(IMG|Image|DSC|PXL|R00)\w*(\.\w+)?$', desc, re.I) or desc.lower().endswith(('.jpg', '.jpeg', '.png'))
        scene_title = desc if desc and not looks_like_file else f'Ansicht {i + 1}'

        # Kuula-Zoom 0 ≈ 80° vertikales Sichtfeld, +1 ≈ 120° → in horizontales Sichtfeld (16:9) umrechnen.
        vfov = 80 + 40 * float(opts.get('zoom') or 0)
        hfov = math.degrees(2 * math.atan(math.tan(math.radians(vfov) / 2) * 16 / 9))

        hot_spots = []
        for addon in json.loads(photo.get('addons') or '[]'):
            pos = (addon.get('pos') or {}).get('start')
            if not pos:
                continue
            action = addon.get('action') or {}
            target = (action.get('post') or {}).get('id')
            if action.get('type') == 1 and target in scene_ids:
                pitch, yaw = vec_to_view(pos)
                hot_spots.append({'type': 'scene', 'sceneId': scene_ids[target], 'pitch': pitch, 'yaw': yaw})
            elif 'sticker' in (addon.get('tags') or []):
                block = addon['blocks'][0]
                stickers.setdefault(file_name, []).append({
                    'url': f'{MEDIA_CDN}/{block["src"]}',
                    'size': block['size'][0],
                    'x': pos['x'] / -pos['y'] if pos['y'] < 0 else 0,
                    'z': pos['z'] / -pos['y'] if pos['y'] < 0 else 0,
                })
            elif action:
                print(f'  Hinweis: Hotspot-Typ {action.get("type")} in {sid} wird nicht übernommen')

        scenes[sid] = {
            'title': scene_title,
            'panorama': file_name,
            'thumb': thumb_name,
            'yaw': norm_yaw(math.degrees(float(opts.get('heading') or 0)) - 90),
            'pitch': round(math.degrees(float(opts.get('pitch') or 0)), 2),
            'hfov': round(min(120, max(50, hfov)), 1),
            'hotSpots': hot_spots,
        }

    # Wie Kuula: Nach einem Szenenwechsel vom Rückweg-Hotspot wegschauen.
    for sid, scene in scenes.items():
        for hs in scene['hotSpots']:
            back = next((b for b in scenes[hs['sceneId']]['hotSpots'] if b['sceneId'] == sid), None)
            if back:
                hs['targetYaw'] = norm_yaw(back['yaw'] + 180)

    def download(item):
        url, path = item
        if not path.exists():
            path.write_bytes(fetch(url))
            if path.name.endswith('-thumb.jpg'):
                shrink(path, 240)
        return path.name

    with ThreadPoolExecutor(max_workers=6) as pool:
        for name in pool.map(download, downloads):
            print(f'  ✓ {name}')

    for file_name, items in stickers.items():
        print(f'  Sticker → {file_name}')
        bake_stickers(out_dir / file_name, items)

    first = (data.get('settings') or {}).get('firstpost') or {}
    tour = {
        'title': title,
        'company': args.company,
        'firstScene': scene_ids.get(first.get('id'), next(iter(scenes))),
        'autoRotate': args.autorotate,
        'scenes': scenes,
    }
    (out_dir / 'tour.json').write_text(json.dumps(tour, indent=2, ensure_ascii=False) + '\n')

    index_path = ROOT / 'tours' / 'index.json'
    index = json.loads(index_path.read_text()) if index_path.exists() else []
    index = [t for t in index if t['id'] != tour_id]
    index.append({'id': tour_id, 'title': title, 'company': args.company})
    index.sort(key=lambda t: (t.get('company', ''), t['title']))
    index_path.write_text(json.dumps(index, indent=2, ensure_ascii=False) + '\n')
    print(f'Fertig: view.html?tour={tour_id}')


if __name__ == '__main__':
    main()
