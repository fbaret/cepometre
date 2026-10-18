#!/usr/bin/env python3
"""Précalcul des couches fixes du Cèpomètre (64 + 65), à lancer une seule fois.

    python scripts/statique.py DOSSIER_SORTIE

Produit, sur une grille de 250 m environ (pas en degrés) couvrant le 64 et le 65 :
  - l'essence dominante de la forêt (BD Forêt V2 de l'IGN) et la part de forêt de la cellule ;
  - la pente et l'exposition (service d'altimétrie de l'IGN, méthode de Horn).
Fichiers : static.json (description de la grille) et static.bin.gz (4 plans d'octets).

Seule dépendance : numpy. Les archives .7z sont extraites avec la commande 7z.
Les catégories et la classification reprennent exactement celles de l'appli (model.js).
"""
import gzip
import io
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unicodedata
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np

# ---------------------------------------------------------------- grille
BOX = dict(s=42.62, n=43.66, w=-1.80, e=0.70)          # même rectangle que la météo
D_LAT = 0.00225                                        # ≈ 250 m
D_LON = round(0.00225 / math.cos(math.radians(43.14)), 6)   # ≈ 250 m à la latitude moyenne
SUB = 5                                                # 5 × 5 sous-points par cellule (≈ 50 m)
L93_RES = 25.0                                         # raster intermédiaire en Lambert-93, 25 m

DEPTS = ["D064", "D065"]
BDFORET_URL = ("https://data.geopf.fr/telechargement/download/BDFORET/"
               "BDFORET_2-0__SHP_LAMB93_{d}_2014-04-01/BDFORET_2-0__SHP_LAMB93_{d}_2014-04-01.7z")
ALTI_URL = "https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json"

CATS = ["horsforet", "chene", "chataignier", "hetre", "feuillus", "mixte", "sapin", "pin",
        "peuplier", "robinier", "lande", "inconnu"]
CAT = {k: i for i, k in enumerate(CATS)}
FOREST = [CAT[k] for k in ("chene", "chataignier", "hetre", "feuillus", "mixte", "sapin", "pin",
                           "peuplier", "robinier", "inconnu")]


def log(*a):
    print(*a, flush=True)


# ---------------------------------------------------------------- classification (copie de model.js)
def classify(text):
    if not text:
        return CAT["inconnu"]
    t = unicodedata.normalize("NFD", str(text).lower())
    t = "".join(c for c in t if unicodedata.category(c) != "Mn")
    if "peupl" in t: return CAT["peuplier"]
    if "robinier" in t: return CAT["robinier"]
    if re.search(r"lande|formation herbacee|ouverte", t): return CAT["lande"]
    if re.search(r"mixte|preponderant|feuillus et coniferes|coniferes et feuillus", t): return CAT["mixte"]
    if "chataign" in t: return CAT["chataignier"]
    if "hetre" in t: return CAT["hetre"]
    if "chene" in t: return CAT["chene"]
    if re.search(r"sapin|epicea|douglas|meleze", t): return CAT["sapin"]
    if "pin" in t: return CAT["pin"]
    if "feuillus" in t: return CAT["feuillus"]
    if "conifere" in t: return CAT["sapin"]
    return CAT["inconnu"]


# ---------------------------------------------------------------- Lambert-93 (GRS80, LCC 2SP)
_A, _E = 6378137.0, 0.0818191910428158
_L0, _P0, _P1, _P2, _X0, _Y0 = math.radians(3), math.radians(46.5), math.radians(44), math.radians(49), 700000.0, 6600000.0


def _m(p): return np.cos(p) / np.sqrt(1 - _E**2 * np.sin(p)**2)
def _t(p): return np.tan(np.pi / 4 - p / 2) / ((1 - _E * np.sin(p)) / (1 + _E * np.sin(p)))**(_E / 2)


_N = (math.log(_m(_P1)) - math.log(_m(_P2))) / (math.log(_t(_P1)) - math.log(_t(_P2)))
_F = _m(_P1) / (_N * _t(_P1)**_N)
_R0 = _A * _F * _t(_P0)**_N


def to_l93(lat, lon):
    p, l = np.radians(lat), np.radians(lon)
    r = _A * _F * _t(p)**_N
    g = _N * (l - _L0)
    return _X0 + r * np.sin(g), _Y0 + _R0 - r * np.cos(g)


# ---------------------------------------------------------------- lecture shapefile (polygones + dbf)
def read_dbf(path):
    raw = open(path, "rb").read()
    nrec = int.from_bytes(raw[4:8], "little")
    hlen = int.from_bytes(raw[8:10], "little")
    rlen = int.from_bytes(raw[10:12], "little")
    fields, pos = [], 32
    while raw[pos] != 0x0D:
        name = raw[pos:pos + 11].split(b"\0")[0].decode("ascii", "replace")
        fields.append((name, chr(raw[pos + 11]), raw[pos + 16]))
        pos += 32
    enc = "utf-8"
    cpg = path[:-4] + ".cpg"
    if os.path.exists(cpg):
        c = open(cpg).read().strip().lower()
        enc = {"utf-8": "utf-8", "utf8": "utf-8"}.get(c, "latin-1" if ("1252" in c or "8859" in c or "latin" in c) else "utf-8")
    texts = []
    for i in range(nrec):
        rec = raw[hlen + i * rlen: hlen + (i + 1) * rlen]
        off, parts = 1, []
        for name, typ, size in fields:
            v = rec[off:off + size]
            off += size
            if typ == "C":
                try: s = v.decode(enc)
                except UnicodeDecodeError: s = v.decode("latin-1")
                parts.append(s.strip())
        texts.append(" | ".join(p for p in parts if p))
    return texts


def read_shp(path):
    """Renvoie une liste de (anneaux, bbox) ; anneaux = liste de tableaux (n, 2)."""
    raw = open(path, "rb").read()
    pos, out = 100, []
    while pos + 8 <= len(raw):
        clen = int.from_bytes(raw[pos + 4:pos + 8], "big") * 2
        c = raw[pos + 8:pos + 8 + clen]
        pos += 8 + clen
        st = int.from_bytes(c[0:4], "little")
        if st not in (5, 15, 25):
            out.append(None); continue
        bbox = np.frombuffer(c[4:36], "<f8")
        nparts = int.from_bytes(c[36:40], "little")
        npts = int.from_bytes(c[40:44], "little")
        parts = np.frombuffer(c[44:44 + 4 * nparts], "<i4")
        pts = np.frombuffer(c[44 + 4 * nparts: 44 + 4 * nparts + 16 * npts], "<f8").reshape(-1, 2)
        bounds = list(parts) + [npts]
        out.append(([pts[bounds[k]:bounds[k + 1]] for k in range(nparts)], bbox))
    return out


# ---------------------------------------------------------------- remplissage de polygones (règle pair-impair)
def rasterize(shapes, cats, x0, ytop, res, width, height):
    """Remplit un raster uint8 (ligne 0 = nord). Centre du pixel (r, c) : (x0 + (c+.5)res, ytop - (r+.5)res).
    Méthode : toutes les intersections arête/ligne de balayage en une fois, triées, appariées par polygone."""
    rows_all, xs_all, ids_all = [], [], []
    for sid, shp in enumerate(shapes):
        if shp is None or cats[sid] == 0:
            continue
        rings, bbox = shp
        if bbox[2] < x0 or bbox[0] > x0 + width * res or bbox[3] < ytop - height * res or bbox[1] > ytop:
            continue
        for ring in rings:
            a, b = ring[:-1], ring[1:]
            ya, yb = a[:, 1], b[:, 1]
            ymin, ymax = np.minimum(ya, yb), np.maximum(ya, yb)
            keep = ymax > ymin
            if not keep.any():
                continue
            a, b, ymin, ymax = a[keep], b[keep], ymin[keep], ymax[keep]
            r_lo = np.floor((ytop - ymax) / res - 0.5).astype(np.int64) + 1
            r_hi = np.floor((ytop - ymin) / res - 0.5).astype(np.int64)
            r_lo = np.maximum(r_lo, 0); r_hi = np.minimum(r_hi, height - 1)
            cnt = np.maximum(r_hi - r_lo + 1, 0)
            if cnt.sum() == 0:
                continue
            e = np.repeat(np.arange(len(cnt)), cnt)
            r = r_lo[e] + (np.arange(cnt.sum()) - np.repeat(np.cumsum(cnt) - cnt, cnt))
            y = ytop - (r + 0.5) * res
            xa, ya2, xb, yb2 = a[e, 0], a[e, 1], b[e, 0], b[e, 1]
            x = xa + (y - ya2) * (xb - xa) / (yb2 - ya2)
            rows_all.append(r); xs_all.append(x); ids_all.append(np.full(len(r), sid, np.int64))
    if not rows_all:
        return np.zeros((height, width), np.uint8)
    R, X, I = np.concatenate(rows_all), np.concatenate(xs_all), np.concatenate(ids_all)
    order = np.lexsort((X, I, R))
    R, X, I = R[order], X[order], I[order]
    key = R * (I.max() + 1) + I
    start = np.r_[True, key[1:] != key[:-1]]
    gstart = np.maximum.accumulate(np.where(start, np.arange(len(key)), 0))
    first = ((np.arange(len(key)) - gstart) % 2 == 0)
    idx = np.nonzero(first)[0]
    idx = idx[idx + 1 < len(key)]
    idx = idx[key[idx + 1] == key[idx]]
    r, xa, xb, sid = R[idx], X[idx], X[idx + 1], I[idx]
    c0 = np.ceil((xa - x0) / res - 0.5).astype(np.int64)
    c1 = np.ceil((xb - x0) / res - 0.5).astype(np.int64)        # exclusif
    c0 = np.clip(c0, 0, width); c1 = np.clip(c1, 0, width)
    ok = c1 > c0
    r, c0, c1, val = r[ok], c0[ok], c1[ok], np.asarray(cats, np.int16)[sid[ok]]
    # La BD Forêt est une partition : différences cumulées par ligne.
    diff = np.zeros((height, width + 1), np.int16)
    np.add.at(diff, (r, c0), val)
    np.add.at(diff, (r, c1), -val)
    out = np.cumsum(diff[:, :width], axis=1)
    return np.clip(out, 0, 255).astype(np.uint8)


# ---------------------------------------------------------------- étapes
def grid_shape():
    rows = int(round((BOX["n"] - BOX["s"]) / D_LAT))
    cols = int(round((BOX["e"] - BOX["w"]) / D_LON))
    return rows, cols


def download_bdforet(workdir):
    shp_paths = []
    for d in DEPTS:
        url = BDFORET_URL.format(d=d)
        arch = os.path.join(workdir, d + ".7z")
        log("Téléchargement", url)
        for attempt in range(4):
            try:
                with urllib.request.urlopen(url, timeout=300) as r, open(arch, "wb") as f:
                    shutil.copyfileobj(r, f)
                break
            except Exception as e:
                log("  échec", e); time.sleep(10 * (attempt + 1))
        else:
            raise RuntimeError("téléchargement impossible : " + url)
        out = os.path.join(workdir, d)
        subprocess.run(["7z", "x", "-y", "-o" + out, arch], check=True, stdout=subprocess.DEVNULL)
        found = [os.path.join(dp, f) for dp, _, fs in os.walk(out) for f in fs
                 if f.upper().startswith("FORMATION_VEGETALE") and f.lower().endswith(".shp")]
        if not found:
            found = [os.path.join(dp, f) for dp, _, fs in os.walk(out) for f in fs if f.lower().endswith(".shp")]
        log("  couches :", found)
        shp_paths += found
    return shp_paths


def forest_layer(shp_paths):
    """Essence dominante (catégorie) et nombre de sous-points boisés (0-25) par cellule de 250 m."""
    rows, cols = grid_shape()
    # Emprise Lambert-93 du rectangle (avec marge).
    la = np.array([BOX["s"], BOX["s"], BOX["n"], BOX["n"]]); lo = np.array([BOX["w"], BOX["e"], BOX["w"], BOX["e"]])
    xs, ys = to_l93(la, lo)
    x0, x1 = xs.min() - 2000, xs.max() + 2000
    y0, y1 = ys.min() - 2000, ys.max() + 2000
    W, H = int((x1 - x0) / L93_RES) + 1, int((y1 - y0) / L93_RES) + 1
    log("Raster Lambert-93 :", W, "×", H)
    l93 = np.zeros((H, W), np.uint8)
    for p in shp_paths:
        shapes = read_shp(p)
        texts = read_dbf(p[:-4] + ".dbf")
        cats = [classify(t) for t in texts]
        hist = np.bincount(cats, minlength=len(CATS))
        log(" ", os.path.basename(p), len(shapes), "polygones ;", {CATS[i]: int(n) for i, n in enumerate(hist) if n})
        part = rasterize(shapes, cats, x0, y1, L93_RES, W, H)
        l93 = np.where(part > 0, part, l93)
    # Échantillonnage aux 5 × 5 sous-points de chaque cellule.
    cat_out = np.zeros((rows, cols), np.uint8)
    frac_out = np.zeros((rows, cols), np.uint8)
    sub_lat_off = (np.arange(SUB) + 0.5) / SUB * D_LAT
    sub_lon = BOX["w"] + (np.arange(cols * SUB) + 0.5) / SUB * D_LON
    forest_mask = np.zeros(256, bool); forest_mask[FOREST] = True
    for r in range(rows):
        lat_top = BOX["n"] - r * D_LAT
        lats = lat_top - sub_lat_off                                   # 5 sous-lignes, du nord au sud
        LA, LO = np.meshgrid(lats, sub_lon, indexing="ij")             # (5, cols*5)
        X, Y = to_l93(LA, LO)
        ci = ((X - x0) / L93_RES).astype(np.int64); ri = ((y1 - Y) / L93_RES).astype(np.int64)
        v = l93[np.clip(ri, 0, H - 1), np.clip(ci, 0, W - 1)]
        v = v.reshape(SUB, cols, SUB).transpose(1, 0, 2).reshape(cols, SUB * SUB)
        isf = forest_mask[v]
        frac_out[r] = isf.sum(1)
        counts = np.stack([(v == k).sum(1) for k in range(len(CATS))], 1)
        fc = counts.copy(); fc[:, [i for i in range(len(CATS)) if i not in FOREST]] = 0
        dom = fc.argmax(1)
        dom = np.where(fc.max(1) > 0, dom, np.where(counts[:, CAT["lande"]] > 0, CAT["lande"], 0))
        cat_out[r] = dom
    return cat_out, frac_out


def _post_alti(lats, lons):
    body = json.dumps({"lon": "|".join("%.6f" % x for x in lons), "lat": "|".join("%.6f" % x for x in lats),
                       "resource": "ign_rge_alti_wld", "delimiter": "|", "indent": "false",
                       "measures": "false", "zonly": "true"}).encode()
    for attempt in range(6):
        try:
            req = urllib.request.Request(ALTI_URL, data=body, method="POST",
                                         headers={"Content-Type": "application/json", "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=120) as r:
                z = json.load(r)["elevations"]
            if len(z) == len(lats):
                return np.array([v if isinstance(v, (int, float)) and v > -9000 else np.nan for v in z], float)
        except Exception as e:
            log("  altimétrie, nouvel essai :", e)
        time.sleep(2 * (attempt + 1))
    return np.full(len(lats), np.nan)


def relief_layer(get_alti=None):
    """Altitudes aux centres des cellules, puis pente (degrés) et exposition (degrés, vers où descend le versant)."""
    rows, cols = grid_shape()
    lat_c = BOX["n"] - (np.arange(rows) + 0.5) * D_LAT
    lon_c = BOX["w"] + (np.arange(cols) + 0.5) * D_LON
    LA, LO = np.meshgrid(lat_c, lon_c, indexing="ij")
    la, lo = LA.ravel(), LO.ravel()
    get = get_alti or _post_alti
    chunks = [(i, la[i:i + 5000], lo[i:i + 5000]) for i in range(0, len(la), 5000)]
    z = np.full(len(la), np.nan)
    log("Altimétrie :", len(la), "points en", len(chunks), "requêtes")
    t0 = time.time()

    def job(ch):
        i, a, b = ch
        time.sleep(0.25 * (i // 5000 % 4))          # étale les départs : au plus ~4 requêtes par seconde
        return i, get(a, b)

    with ThreadPoolExecutor(max_workers=4) as ex:
        for k, (i, vals) in enumerate(ex.map(job, chunks)):
            z[i:i + len(vals)] = vals
            if k % 10 == 0:
                log("  ", k + 1, "/", len(chunks), "(%.0f s)" % (time.time() - t0))
    Z = z.reshape(rows, cols)
    dy = D_LAT * 111320.0
    dx = (D_LON * 111320.0 * np.cos(np.radians(lat_c)))[:, None]
    P = np.pad(Z, 1, mode="edge")
    a, b, c = P[:-2, :-2], P[:-2, 1:-1], P[:-2, 2:]
    d, f = P[1:-1, :-2], P[1:-1, 2:]
    g, h, i = P[2:, :-2], P[2:, 1:-1], P[2:, 2:]
    dzdx = ((c + 2 * f + i) - (a + 2 * d + g)) / (8 * dx)
    dzdy = ((a + 2 * b + c) - (g + 2 * h + i)) / (8 * dy)
    slope = np.degrees(np.arctan(np.hypot(dzdx, dzdy)))
    aspect = (np.degrees(np.arctan2(-dzdx, -dzdy)) + 360) % 360
    s8 = np.where(np.isfinite(slope), np.clip(np.round(slope), 0, 89), 255).astype(np.uint8)
    a8 = np.where(np.isfinite(aspect) & (s8 != 255), np.round(aspect / 2) % 180, 255).astype(np.uint8)
    return s8, a8, int(np.isfinite(z).sum())


def write(outdir, cat, frac, slope, aspect, stats):
    rows, cols = grid_shape()
    os.makedirs(outdir, exist_ok=True)
    buf = cat.tobytes() + frac.tobytes() + slope.tobytes() + aspect.tobytes()
    with open(os.path.join(outdir, "static.bin.gz"), "wb") as f:
        f.write(gzip.compress(buf, 9))
    head = dict(v=1, built=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), n=BOX["n"], s=BOX["s"], w=BOX["w"], e=BOX["e"],
                dLat=D_LAT, dLon=D_LON, rows=rows, cols=cols, sub=SUB, cats=CATS,
                planes=["cat", "frac(0-%d)" % (SUB * SUB), "slope(deg,255=?)", "aspect/2(255=?)"], stats=stats)
    with open(os.path.join(outdir, "static.json"), "w") as f:
        json.dump(head, f)
    log("Écrit :", outdir, "(", os.path.getsize(os.path.join(outdir, "static.bin.gz")) // 1024, "Ko compressés )")


def main():
    outdir = sys.argv[1] if len(sys.argv) > 1 else "static-cache"
    tmp_out = outdir + ".tmp"
    shutil.rmtree(tmp_out, ignore_errors=True)
    with tempfile.TemporaryDirectory() as wd:
        shp = download_bdforet(wd)
        cat, frac = forest_layer(shp)
    slope, aspect, nz = relief_layer()
    stats = dict(forest_cells=int((frac > 0).sum()), cells=int(cat.size), alti_points=nz,
                 cats={CATS[i]: int(n) for i, n in enumerate(np.bincount(cat.ravel(), minlength=len(CATS)))})
    log("Bilan :", stats)
    write(tmp_out, cat, frac, slope, aspect, stats)
    shutil.rmtree(outdir, ignore_errors=True)
    os.replace(tmp_out, outdir)          # le dossier final n'existe qu'en cas de succès complet


if __name__ == "__main__":
    main()
