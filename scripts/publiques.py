#!/usr/bin/env python3
"""Forêts publiques (ONF, via la Géoplateforme IGN) sur la grille de 250 m du Cèpomètre.

    python scripts/publiques.py DOSSIER_SORTIE

Produit public.json (liste des forêts) et public.bin.gz : pour chaque cellule de la grille
de statique.py, l'indice de la forêt publique (uint16, 0 = privé ou hors forêt publique)
puis le nombre de sous-points publics (uint8, 0-25).
Couche : ONF.FORETS_PUBLIQUES:ONF_FORETS_PUBLIQUES (forêts relevant du régime forestier :
domaniales, communales, sectionales, syndicales…). Licence ouverte Etalab.
"""
import gzip
import json
import os
import shutil
import sys
import time
import urllib.parse
import urllib.request

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from statique import BOX, D_LAT, D_LON, SUB, L93_RES, grid_shape, to_l93, log  # noqa: E402

WFS = "https://data.geopf.fr/wfs/ows"
LAYER = "ONF.FORETS_PUBLIQUES:ONF_FORETS_PUBLIQUES"
PAGE = 50


def fetch_page(start):
    q = dict(SERVICE="WFS", VERSION="2.0.0", REQUEST="GetFeature", TYPENAMES=LAYER, OUTPUTFORMAT="application/json",
             SRSNAME="EPSG:2154", COUNT=PAGE, STARTINDEX=start, SORTBY="iidtn_frt",
             BBOX="%s,%s,%s,%s,urn:ogc:def:crs:EPSG::4326" % (BOX["s"], BOX["w"], BOX["n"], BOX["e"]))
    url = WFS + "?" + urllib.parse.urlencode(q)
    for attempt in range(6):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "cepometre/1.0 (forets publiques)"})
            with urllib.request.urlopen(req, timeout=300) as r:
                return json.load(r)["features"]
        except Exception as e:
            log("  WFS, nouvel essai :", e)
            time.sleep(5 * (attempt + 1))
    raise RuntimeError("WFS des forêts publiques injoignable (page %d)" % start)


def fetch_all():
    feats, start = [], 0
    while True:
        page = fetch_page(start)
        feats += page
        log("  forêts publiques :", len(feats))
        if len(page) < PAGE:
            return feats
        start += PAGE


def to_shapes(feats):
    """Polygones au format de statique.rasterize : (anneaux, bbox)."""
    shapes = []
    for f in feats:
        g = f.get("geometry") or {}
        polys = g.get("coordinates") or []
        if g.get("type") == "Polygon":
            polys = [polys]
        elif g.get("type") != "MultiPolygon":
            shapes.append(None); continue
        rings = [np.asarray(r, float)[:, :2] for p in polys for r in p if len(r) >= 4]
        if not rings:
            shapes.append(None); continue
        allp = np.concatenate(rings)
        shapes.append((rings, np.array([allp[:, 0].min(), allp[:, 1].min(), allp[:, 0].max(), allp[:, 1].max()])))
    return shapes


def raster_ids(shapes, x0, ytop, W, H):
    """Raster int32 : indice de forêt + 1, 0 hors forêt publique, -1 si deux forêts se chevauchent."""
    from statique import rasterize
    n = len(shapes)
    ones = [1 if s is not None else 0 for s in shapes]
    # rasterize additionne les valeurs : on fait un passage « nombre » et un passage « indice » par paquets de 250.
    count = np.zeros((H, W), np.int32)
    ids = np.zeros((H, W), np.int32)
    for b in range(0, n, 250):
        sub = [s if b <= i < b + 250 else None for i, s in enumerate(shapes)]
        count += rasterize(sub, ones, x0, ytop, L93_RES, W, H)
        vals = [(i - b + 1) if (b <= i < b + 250 and shapes[i] is not None) else 0 for i in range(n)]
        part = rasterize(sub, vals, x0, ytop, L93_RES, W, H).astype(np.int32)
        ids = np.where(part > 0, part + b, ids)
    return np.where(count > 1, -1, np.where(count == 1, ids, 0))


def main():
    outdir = sys.argv[1] if len(sys.argv) > 1 else "public-cache"
    tmp = outdir + ".tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp)
    feats = fetch_all()
    if not feats:
        raise RuntimeError("aucune forêt publique reçue")
    forests = []
    for f in feats:
        p = f.get("properties") or {}
        forests.append([p.get("llib_frt") or "Forêt publique", 1 if str(p.get("cdom_frt", "")).upper() == "OUI" else 0,
                        p.get("iidtn_frt") or "", p.get("cinse_dep") or ""])
    shapes = to_shapes(feats)

    rows, cols = grid_shape()
    la = np.array([BOX["s"], BOX["s"], BOX["n"], BOX["n"]]); lo = np.array([BOX["w"], BOX["e"], BOX["w"], BOX["e"]])
    xs, ys = to_l93(la, lo)
    x0, x1 = xs.min() - 2000, xs.max() + 2000
    y0, y1 = ys.min() - 2000, ys.max() + 2000
    W, H = int((x1 - x0) / L93_RES) + 1, int((y1 - y0) / L93_RES) + 1
    log("Raster Lambert-93 :", W, "×", H, "pour", len(shapes), "forêts")
    l93 = raster_ids(shapes, x0, y1, W, H)

    id_out = np.zeros((rows, cols), "<u2")
    frac_out = np.zeros((rows, cols), np.uint8)
    sub_lat_off = (np.arange(SUB) + 0.5) / SUB * D_LAT
    sub_lon = BOX["w"] + (np.arange(cols * SUB) + 0.5) / SUB * D_LON
    for r in range(rows):
        lats = BOX["n"] - r * D_LAT - sub_lat_off
        LA, LO = np.meshgrid(lats, sub_lon, indexing="ij")
        X, Y = to_l93(LA, LO)
        ci = ((X - x0) / L93_RES).astype(np.int64); ri = ((y1 - Y) / L93_RES).astype(np.int64)
        v = l93[np.clip(ri, 0, H - 1), np.clip(ci, 0, W - 1)]
        v = v.reshape(SUB, cols, SUB).transpose(1, 0, 2).reshape(cols, SUB * SUB)
        frac_out[r] = (v != 0).sum(1)
        best = v.max(1)                                  # une forêt nommée si la cellule en touche une
        id_out[r] = np.where(best > 0, best, 0).astype("<u2")   # 0 : privé, ou chevauchement sans nom

    with open(os.path.join(tmp, "public.bin.gz"), "wb") as f:
        f.write(gzip.compress(id_out.tobytes() + frac_out.tobytes(), 9))
    stats = dict(forests=len(forests), public_cells=int((frac_out >= 10).sum()), touched_cells=int((frac_out > 0).sum()),
                 domaniales=int(sum(x[1] for x in forests)))
    head = dict(v=1, built=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), rows=rows, cols=cols, sub=SUB,
                source=LAYER, planes=["forest index+1 (uint16le, 0 = non public)", "public sub-points (0-%d)" % (SUB * SUB)],
                forests=forests, stats=stats)
    with open(os.path.join(tmp, "public.json"), "w") as f:
        json.dump(head, f, ensure_ascii=False)
    log("Bilan :", stats, "|", os.path.getsize(os.path.join(tmp, "public.bin.gz")) // 1024, "Ko compressés")
    shutil.rmtree(outdir, ignore_errors=True)
    os.replace(tmp, outdir)


if __name__ == "__main__":
    main()
