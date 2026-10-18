#!/usr/bin/env node
/* Corrige la météo d'Open-Meteo avec les stations de Météo-France (pluie et températures).
 *
 *   node scripts/pluvio.mjs site/data/wx.json
 *
 * Source : données climatologiques quotidiennes de Météo-France (data.gouv.fr, licence ouverte),
 * fichiers « latest » mis à jour chaque jour, départements 64, 65 et voisins (40, 32, 31).
 *   RR : pluie de 6 h UTC le jour J à 6 h UTC le lendemain, affectée au jour J ;
 *   TN : minimale de 18 h UTC la veille à 18 h UTC ; TX : maximale de 6 h UTC à 6 h UTC le lendemain.
 *
 * Contrôles : valeurs marquées « douteuses » par Météo-France (code qualité 2) écartées ;
 * pluviomètre à sec alors que ses voisins ont tous reçu plus de 15 mm écarté ce jour-là ;
 * écart de température station/modèle de plus de 8 °C écarté.
 *
 * Pluie : écart = mesure − modèle au même endroit (le modèle est interpolé comme sur la carte, et pris
 * aux 2/3 sur le jour J et 1/3 sur J+1 pour respecter l'horaire 6 h–6 h). Chaque point de grille reçoit
 * la moyenne des écarts voisins pondérée par la distance (noyau de 8 km, rien au-delà de 25 km).
 * Températures : même principe, après avoir ramené le modèle à l'altitude de la station
 * (−0,65 °C par 100 m) ; une station n'influence que les points d'altitude voisine (noyau de 400 m),
 * dans un rayon de 30 km ; correction bornée à ±4 °C.
 * Le fichier n'est corrigé qu'une fois (champ « stations »). */
import fs from "node:fs";
import zlib from "node:zlib";

const DEPTS = ["64", "65", "40", "32", "31"];
const BASE = "https://meteofrance.s3.sbg.io.cloud.ovh.net/data/synchro_ftp/BASE/QUOT/";
const LAPSE = -0.0065;

const km = (a, b) => {
  const dy = (a.lat - b.lat) * 111.32, dx = (a.lon - b.lon) * 111.32 * Math.cos((a.lat + b.lat) * Math.PI / 360);
  return Math.hypot(dx, dy);
};
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

async function fetchDept(d) {
  const y = new Date().getUTCFullYear();
  for (const per of [`${y - 1}-${y}`, `${y}-${y + 1}`, `${y - 2}-${y - 1}`]) {
    const url = `${BASE}Q_${d}_latest-${per}_RR-T-Vent.csv.gz`;
    try {
      const res = await fetch(url, { headers: { "User-Agent": "cepometre/1.0" } });
      if (!res.ok) continue;
      const txt = zlib.gunzipSync(Buffer.from(await res.arrayBuffer())).toString("latin1");
      console.log("  " + url.split("/").pop() + " : " + Math.round(txt.length / 1024) + " Ko");
      return txt;
    } catch (e) { console.log("  " + url + " : " + e.message); }
  }
  return null;
}

function parse(txt, wanted, qc) {
  const lines = txt.split(/\r?\n/);
  const head = lines[0].split(";").map((s) => s.trim().toUpperCase());
  const col = (n) => head.indexOf(n);
  const I = { id: col("NUM_POSTE"), name: col("NOM_USUEL"), lat: col("LAT"), lon: col("LON"), alt: col("ALTI"), date: col("AAAAMMJJ"),
              rr: col("RR"), qrr: col("QRR"), tn: col("TN"), qtn: col("QTN"), tx: col("TX"), qtx: col("QTX") };
  if ([I.id, I.lat, I.lon, I.date, I.rr].some((i) => i < 0)) throw new Error("colonnes inattendues : " + head.slice(0, 12).join(","));
  const num = (v) => { const x = parseFloat(String(v ?? "").trim().replace(",", ".")); return isFinite(x) ? x : null; };
  const st = new Map();
  for (let k = 1; k < lines.length; k++) {
    const f = lines[k].split(";");
    if (f.length <= I.rr) continue;
    const ds = f[I.date].trim();
    const date = ds.slice(0, 4) + "-" + ds.slice(4, 6) + "-" + ds.slice(6, 8);
    if (!wanted.has(date)) continue;
    const id = f[I.id].trim();
    let s = st.get(id);
    if (!s) {
      s = { id, name: (f[I.name] || "").trim(), lat: num(f[I.lat]), lon: num(f[I.lon]), alt: num(f[I.alt]) ?? 0, rr: new Map(), tn: new Map(), tx: new Map() };
      st.set(id, s);
    }
    const take = (vi, qi, map, lo, hi) => {
      if (vi < 0) return;
      const v = num(f[vi]);
      if (v == null) return;
      if (qi >= 0 && String(f[qi]).trim() === "2") { qc.doubtful++; return; }     // « douteuse » pour Météo-France
      if (v < lo || v > hi) { qc.absurd++; return; }
      map.set(date, v);
    };
    take(I.rr, I.qrr, s.rr, 0, 400);
    take(I.tn, I.qtn, s.tn, -40, 40);
    take(I.tx, I.qtx, s.tx, -35, 48);
  }
  return [...st.values()].filter((s) => s.lat != null && s.lon != null);
}

export async function correctFile(file) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  if (data.stations && data.stations.applied) { console.log("Déjà corrigé le " + data.stations.applied + " : rien à faire."); return; }
  if (data.gauges && data.gauges.applied) { console.log("Fichier déjà corrigé par l'ancienne méthode : rien à faire (il faut repartir du fichier brut)."); return; }
  const n = data.n, dates = [];
  for (let t = 0; t < n; t++) { const d = new Date(data.d0 + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + t); dates.push(d.toISOString().slice(0, 10)); }
  const wanted = new Set(dates), qc = { doubtful: 0, absurd: 0, dry: 0, tempOut: 0 };
  console.log("Stations Météo-France :");
  let stations = [];
  for (const d of DEPTS) {
    const txt = await fetchDept(d);
    if (txt) { try { stations = stations.concat(parse(txt, wanted, qc)); } catch (e) { console.log("  " + d + " : " + e.message); } }
  }

  // Grille : accès par indices, interpolation identique à celle de la carte (maille fine si complète, sinon maille de base).
  const K = data.k || 3, grid = new Map();
  const nodes = data.pts.map((p) => { const x = { i: p[0], j: p[1], lat: p[0] * data.latB, lon: p[1] * data.lonB, el: p[2], p }; grid.set(p[0] + "," + p[1], x); return x; });
  const corners = (lat, lon, kk) => {
    const fi = lat / (kk * data.latB), fj = lon / (kk * data.lonB), i0 = Math.floor(fi), j0 = Math.floor(fj), a = fi - i0, b = fj - j0;
    return [[i0, j0, (1 - a) * (1 - b)], [i0 + 1, j0, a * (1 - b)], [i0, j0 + 1, (1 - a) * b], [i0 + 1, j0 + 1, a * b]]
      .map(([i, j, w]) => ({ x: grid.get(i * kk + "," + j * kk), w }));
  };
  const interp = (lat, lon) => {
    let c = corners(lat, lon, 1);
    if (c.some((o) => !o.x)) c = corners(lat, lon, K).filter((o) => o.x);
    const ws = c.reduce((s, o) => s + o.w, 0);
    if (!c.length || ws < 0.25) return null;
    return { c: c.map((o) => ({ x: o.x, w: o.w / ws })), el: c.reduce((s, o) => s + o.x.el * o.w, 0) / ws };
  };
  const val = (ip, off, t) => ip.c.reduce((s, o) => s + o.w * o.x.p[3 + off * n + t] / 10, 0);
  stations = stations.filter((s) => (s.ip = interp(s.lat, s.lon)));
  if (!stations.length) { console.log("Aucune station exploitable : météo laissée telle quelle."); return; }

  // --- Pluie : contrôle « pluviomètre à sec », écarts avec le modèle
  for (const s of stations) s.nb = stations.filter((o) => o !== s && km(o, s) <= 20);
  let sumObs = 0, sumMod = 0;
  for (const s of stations) {
    s.eR = new Map(); s.o14 = 0; s.m14 = 0;
    dates.forEach((date, t) => {
      if (!s.rr.has(date)) return;
      const v = s.rr.get(date);
      const nbv = s.nb.map((o) => o.rr.get(date)).filter((x) => x != null);
      if (v < 1 && nbv.length >= 3 && median(nbv) >= 15) { qc.dry++; return; }
      const m = t + 1 < n ? (2 / 3) * val(s.ip, 0, t) + (1 / 3) * val(s.ip, 0, t + 1) : val(s.ip, 0, t);
      s.eR.set(t, v - m);
      sumObs += v; sumMod += m;
    });
  }
  // --- Températures : écarts après mise à l'altitude de la station
  for (const s of stations) {
    s.eN = new Map(); s.eX = new Map();
    const dz = LAPSE * (s.alt - s.ip.el);
    dates.forEach((date, t) => {
      for (const [obs, off, out] of [[s.tn, 1, s.eN], [s.tx, 2, s.eX]]) {
        if (!obs.has(date)) continue;
        const e = obs.get(date) - (val(s.ip, off, t) + dz);
        if (Math.abs(e) > 8) { qc.tempOut++; continue; }
        out.set(t, e);
      }
    });
  }

  // --- Application à chaque point de grille
  let rainChanged = 0, rainMoved = 0, tCount = 0, tAbs = 0;
  const tBias = { nn: 0, nx: 0, tn: 0, tx: 0 };
  stations.forEach((s) => { s.eN.forEach((e) => { tBias.tn += e; tBias.nn++; }); s.eX.forEach((e) => { tBias.tx += e; tBias.nx++; }); });
  for (const x of nodes) {
    const nearR = [], nearT = [];
    for (const s of stations) {
      const d = km(s, x);
      if (d <= 25) nearR.push({ s, w: Math.exp(-((d / 8) ** 2)) });
      if (d <= 30) nearT.push({ s, w: Math.exp(-((d / 12) ** 2)) * Math.exp(-(((x.el - s.alt) / 400) ** 2)) });
    }
    if (nearR.length) {
      const add = new Array(n).fill(0);
      for (let t = 0; t < n; t++) {
        let w = 0, e = 0;
        for (const o of nearR) if (o.s.eR.has(t)) { w += o.w; e += o.w * o.s.eR.get(t); }
        if (w < 1e-4) continue;
        const corr = e / (w + 0.1);
        if (t + 1 < n) { add[t] += (2 / 3) * corr; add[t + 1] += (1 / 3) * corr; } else add[t] += corr;
      }
      for (let t = 0; t < n; t++) {
        const before = x.p[3 + t], after = Math.max(0, Math.round(before + add[t] * 10));
        if (after !== before) { x.p[3 + t] = after; rainChanged++; rainMoved += Math.abs(after - before) / 10; }
      }
    }
    if (nearT.length) {
      for (const [off, key] of [[1, "eN"], [2, "eX"]]) {
        for (let t = 0; t < n; t++) {
          let w = 0, e = 0;
          for (const o of nearT) { const m = o.s[key]; if (m.has(t)) { w += o.w; e += o.w * m.get(t); } }
          if (w < 1e-3) continue;
          const corr = Math.max(-4, Math.min(4, e / (w + 0.3)));
          x.p[3 + off * n + t] = Math.round(x.p[3 + off * n + t] + corr * 10);
          tCount++; tAbs += Math.abs(corr);
        }
      }
    }
  }
  // Une minimale ne doit jamais dépasser la maximale.
  for (const x of nodes) for (let t = 0; t < n; t++) {
    const a = 3 + n + t, b = 3 + 2 * n + t;
    if (x.p[a] > x.p[b]) { const m = Math.round((x.p[a] + x.p[b]) / 2); x.p[a] = m; x.p[b] = m; }
  }

  const iToday = dates.indexOf(new Date().toISOString().slice(0, 10));
  const from = Math.max(0, (iToday < 0 ? n : iToday) - 14);
  data.stations = {
    applied: new Date().toISOString(), count: stations.length,
    rainBias: sumObs && sumMod ? Math.round((sumObs / sumMod - 1) * 100) : null,
    tnBias: tBias.nn ? +(tBias.tn / tBias.nn).toFixed(1) : null, txBias: tBias.nx ? +(tBias.tx / tBias.nx).toFixed(1) : null,
    tempMeanCorr: tCount ? +(tAbs / tCount).toFixed(2) : 0, qc,
    // [lat, lon, altitude, nom, pluie mesurée 14 j, pluie du modèle 14 j, dernière minimale, dernière maximale]
    list: stations.map((s) => {
      let o = 0, m = 0, c = 0;
      s.eR.forEach((e, t) => { if (t >= from && t < (iToday < 0 ? n : iToday)) { o += s.rr.get(dates[t]); m += s.rr.get(dates[t]) - e; c++; } });
      const lastT = (map) => { for (let t = n - 1; t >= 0; t--) if (map.has(dates[t])) return map.get(dates[t]); return null; };
      return [+s.lat.toFixed(4), +s.lon.toFixed(4), Math.round(s.alt || 0), s.name, c ? Math.round(o * 10) / 10 : null, c ? Math.round(m * 10) / 10 : null, lastT(s.tn), lastT(s.tx)];
    })
  };
  fs.writeFileSync(file, JSON.stringify(data));
  console.log(`${stations.length} stations. Pluie : ${rainChanged} valeurs corrigées (${Math.round(rainMoved)} mm déplacés), mesuré/modèle ${data.stations.rainBias >= 0 ? "+" : ""}${data.stations.rainBias} %. ` +
    `Températures : écart moyen station − modèle ${data.stations.tnBias} °C (minimales), ${data.stations.txBias} °C (maximales), correction moyenne ${data.stations.tempMeanCorr} °C. ` +
    `Contrôles : ${qc.doubtful} douteuses, ${qc.absurd} absurdes, ${qc.dry} pluviomètres à sec, ${qc.tempOut} températures aberrantes écartés.`);
}

if (import.meta.url === "file://" + process.argv[1]) {
  correctFile(process.argv[2] || "site/data/wx.json").catch((e) => { console.log("Correction par les stations impossible : " + e.message); });
}
