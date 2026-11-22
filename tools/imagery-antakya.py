"""Crops Maxar Open Data imagery (CC BY-NC 4.0) for the Antakya case and reprojects it to Web Mercator.

Pre-event : 2022-12-22, catalog 10300100DF6BFE00 (0.51 m GSD)
Post-event: 2023-02-11, catalog 10300100E18CB600 (0.67 m GSD)

Writes public/data/antakya/imagery/{pre,post}_{inner,outer}.jpg and imagery.json (corner coordinates for MapLibre image sources).
Run in WSL with a rasterio environment:
  ~/aegis_geo_venv/bin/python tools/imagery-antakya.py
"""
import json, math, os, sys
import numpy as np
import rasterio
from rasterio.warp import reproject, Resampling, transform_bounds
from rasterio.transform import from_bounds
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "data", "antakya", "imagery")
os.makedirs(OUT, exist_ok=True)
meta = json.load(open(os.path.join(ROOT, "public", "data", "antakya", "meta.json")))

BASE = "https://maxar-opendata.s3.amazonaws.com/events/Kahramanmaras-turkey-earthquake-23/ard/37/031133023302"
SCENES = {
    "pre": {"url": f"{BASE}/2022-12-22/10300100DF6BFE00-visual.tif", "date": "2022-12-22", "gsd": 0.51, "catalog": "10300100DF6BFE00"},
    "post": {"url": f"{BASE}/2023-02-11/10300100E18CB600-visual.tif", "date": "2023-02-11", "gsd": 0.67, "catalog": "10300100E18CB600"},
}
os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
os.environ.setdefault("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".tif")

def expand(b, m):
    lat = (b[1] + b[3]) / 2
    dlon, dlat = m / (111320 * math.cos(math.radians(lat))), m / 111320
    return [b[0] - dlon, b[1] - dlat, b[2] + dlon, b[3] + dlat]

EXTENTS = {
    "inner": {"bounds": meta["contextBounds"], "px": 4096},          # ≈0.6 m/px over the 2 km context area
    "outer": {"bounds": expand(meta["contextBounds"], 2200), "px": 3072},  # ≈2 m/px over ~6.4 km for the horizon
}

result = {"source": "Maxar Open Data Program, CC BY-NC 4.0", "url": "https://www.maxar.com/open-data", "scenes": {}}
for key, sc in SCENES.items():
    with rasterio.open("/vsicurl/" + sc["url"]) as src:
        scene_ll = transform_bounds(src.crs, "EPSG:4326", *src.bounds)
        result["scenes"][key] = {k: sc[k] for k in ("date", "gsd", "catalog")} | {"layers": {}}
        for ek, ex in EXTENTS.items():
            b = ex["bounds"]
            # clip to the scene footprint so no black borders are produced
            b = [max(b[0], scene_ll[0]), max(b[1], scene_ll[1]), min(b[2], scene_ll[2]), min(b[3], scene_ll[3])]
            mb = transform_bounds("EPSG:4326", "EPSG:3857", *b)
            w = ex["px"]; h = max(1, round(w * (mb[3] - mb[1]) / (mb[2] - mb[0])))
            dst = np.zeros((3, h, w), dtype=np.uint8)
            reproject(source=rasterio.band(src, [1, 2, 3]), destination=dst, dst_transform=from_bounds(*mb, w, h), dst_crs="EPSG:3857",
                      resampling=Resampling.bilinear if ek == "inner" else Resampling.average, num_threads=4)
            name = f"{key}_{ek}.jpg"
            Image.fromarray(np.transpose(dst, (1, 2, 0))).save(os.path.join(OUT, name), quality=84, optimize=True, progressive=True)
            ll = transform_bounds("EPSG:3857", "EPSG:4326", *mb)
            result["scenes"][key]["layers"][ek] = {"file": name, "coordinates": [[ll[0], ll[3]], [ll[2], ll[3]], [ll[2], ll[1]], [ll[0], ll[1]]], "px": [w, h]}
            print(key, ek, name, w, h, f"{os.path.getsize(os.path.join(OUT, name)) / 1e6:.1f} MB", flush=True)

json.dump(result, open(os.path.join(OUT, "imagery.json"), "w"), indent=2)
print("done")
