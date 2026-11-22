"""Cuts Maxar Open Data imagery (CC BY-NC 4.0) of central Antakya into Web-Mercator XYZ tiles (256 px JPEG).

Pre-event : 2022-12-22, catalog 10300100DF6BFE00 (0.51 m GSD)
Post-event: 2023-02-11, catalog 10300100E18CB600 (0.67 m GSD)
Four Maxar ARD scene tiles per date (UTM 37 grid 031133023302 / 303 / 320 / 321) are mosaicked: ~10 x 10 km of the city.

Source GeoTIFFs are downloaded once to ~/aegis_maxar/{pre,post}/<grid>.tif (see the download snippet in the README).
z13-z17 cover the whole mosaic, z18 (full resolution, ~0.6 m/px) the case area with a 900 m margin.

    ~/aegis_geo_venv/bin/python tools/tile-imagery.py [pre|post]     -> public/data/antakya/tiles/{pre,post}/{z}/{x}/{y}.jpg
"""
import glob, json, math, os, sys
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import from_bounds
from rasterio.warp import reproject, transform_bounds
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "data", "antakya", "tiles")
SRC = os.path.expanduser("~/aegis_maxar")
meta = json.load(open(os.path.join(ROOT, "public", "data", "antakya", "meta.json")))
R = 6378137.0


def expand(b, m):
    lat = (b[1] + b[3]) / 2
    return [b[0] - m / (111320 * math.cos(math.radians(lat))), b[1] - m / 111320, b[2] + m / (111320 * math.cos(math.radians(lat))), b[3] + m / 111320]


def tile_range(b, z):
    n = 2 ** z
    x0 = int((b[0] + 180) / 360 * n); x1 = int((b[2] + 180) / 360 * n)
    y = lambda lat: int((1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n)
    return x0, x1, y(b[3]), y(b[1])


def tile_bounds_3857(x, y, z):
    size = 2 * math.pi * R / 2 ** z
    minx = -math.pi * R + x * size; maxy = math.pi * R - y * size
    return minx, maxy - size, minx + size, maxy


def sources(scene):
    out = []
    for f in sorted(glob.glob(os.path.join(SRC, scene, "*.tif"))):
        with rasterio.open(f) as s:
            out.append((f, transform_bounds(s.crs, "EPSG:3857", *s.bounds), transform_bounds(s.crs, "EPSG:4326", *s.bounds)))
    return out


def union_ll(srcs):
    return [min(s[2][0] for s in srcs), min(s[2][1] for s in srcs), max(s[2][2] for s in srcs), max(s[2][3] for s in srcs)]


def run(scene):
    srcs = sources(scene)
    if not srcs:
        sys.exit(f"no source GeoTIFFs in {SRC}/{scene}")
    area = union_ll(srcs)
    levels = [(z, area) for z in (13, 14, 15, 16, 17)] + [(18, expand(meta["contextBounds"], 900))]
    jobs = []
    for z, b in levels:
        x0, x1, y0, y1 = tile_range(b, z)
        jobs += [(z, x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]
    print(scene, len(srcs), "sources,", len(jobs), "tiles", flush=True)
    done = [0]

    def worker(chunk):
        handles = [(rasterio.open(f), b3857) for f, b3857, _ in srcs]
        try:
            for z, x, y in chunk:
                path = os.path.join(OUT, scene, str(z), str(x), f"{y}.jpg")
                bb = tile_bounds_3857(x, y, z)
                mosaic = np.zeros((3, 256, 256), dtype=np.uint8)
                for h, sb in handles:
                    if sb[2] < bb[0] or sb[0] > bb[2] or sb[3] < bb[1] or sb[1] > bb[3]:
                        continue
                    part = np.zeros((3, 256, 256), dtype=np.uint8)
                    reproject(source=rasterio.band(h, [1, 2, 3]), destination=part, dst_transform=from_bounds(*bb, 256, 256), dst_crs="EPSG:3857",
                              src_nodata=0, dst_nodata=0, resampling=Resampling.bilinear if z >= 17 else Resampling.average)
                    empty = mosaic.max(axis=0) == 0
                    mosaic[:, empty] = part[:, empty]          # fill gaps; first source wins on overlap
                if mosaic.max() == 0:
                    continue                                    # outside every scene: no tile, the Sentinel-2 base shows through
                os.makedirs(os.path.dirname(path), exist_ok=True)
                Image.fromarray(np.transpose(mosaic, (1, 2, 0))).save(path, quality=82, optimize=True)
                done[0] += 1
        finally:
            for h, _ in handles:
                h.close()

    k = 10
    with ThreadPoolExecutor(k) as ex:
        list(ex.map(worker, [jobs[i::k] for i in range(k)]))
    print(scene, "written", done[0], flush=True)
    return area


if __name__ == "__main__":
    areas = [run(s) for s in (sys.argv[1:] or ["post", "pre"])]
    area = [max(a[0] for a in areas), max(a[1] for a in areas), min(a[2] for a in areas), min(a[3] for a in areas)] if len(areas) > 1 else areas[0]
    json.dump({"minzoom": 13, "maxzoom": 18, "bounds": area, "innerBounds": meta["contextBounds"],
               "scenes": {"pre": "2022-12-22", "post": "2023-02-11"}, "source": "Maxar Open Data Program, CC BY-NC 4.0"},
              open(os.path.join(OUT, "tiles.json"), "w"), indent=2)
    print("done", [round(v, 4) for v in area])
