#!/usr/bin/env node
/* Corrige la pluie d'Open-Meteo avec les pluviomètres de Météo-France.
 *
 *   node scripts/pluvio.mjs site/data/wx.json
 *
 * Source : données climatologiques quotidiennes de Météo-France (data.gouv.fr, licence ouverte),
 * fichiers « latest » mis à jour chaque jour, départements 64, 65 et voisins (40, 32, 31).
 * RR = pluie de 6 h UTC le jour J à 6 h UTC le lendemain, affectée au jour J.
 *
 * Méthode : à chaque pluviomètre et chaque jour, écart = mesure − pluie du modèle au même endroit.
 * Chaque point de la grille reçoit la moyenne des écarts des pluviomètres voisins, pondérée par
 * la distance (noyau gaussien de 8 km, rien au-delà de 25 km), puis on borne à zéro.
 * Un orage manqué par le modèle mais mesuré par un pluviomètre est ainsi rajouté autour de lui.
 * Le fichier n'est corrigé qu'une fois (champ « gauges »). */
import fs from "node:fs";
import zlib from "node:zlib";

const DEPTS = ["64", "65", "40", "32", "31"];
const BASE = "https://meteofrance.s3.sbg.io.cloud.ovh.net/data/synchro_ftp/BASE/QUOT/";
const L_KM = 8, MAX_KM = 25, LAMBDA = 0.1;

const km = (a, b) => {
  const dy = (a.lat - b.lat) * 111.32, dx = (a.lon - b.lon) * 111.32 * Math.cos((a.lat + b.lat) * Math.PI / 360);
  return Math.hypot(dx, dy);
};

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

function parse(txt, wanted) {
  const lines = txt.split(/\r?\n/);
  const head = lines[0].split(";").map((s) => s.trim().toUpperCase());
  const col = (n) => head.indexOf(n);
  const iId = col("NUM_POSTE"), iName = col("NOM_USUEL"), iLat = col("LAT"), iLon = col("LON"), iAlt = col("ALTI"), iDate = col("AAAAMMJJ"), iRR = col("RR");
  if ([iId, iLat, iLon, iDate, iRR].some((i) => i < 0)) throw new Error("colonnes inattendues : " + head.slice(0, 12).join(","));
  const st = new Map();
  for (let k = 1; k < lines.length; k++) {
    const f = lines[k].split(";");
    if (f.length <= iRR) continue;
    const ds = f[iDate].trim();
    const date = ds.slice(0, 4) + "-" + ds.slice(4, 6) + "-" + ds.slice(6, 8);
    if (!wanted.has(date)) continue;
    const rr = f[iRR].trim();
    if (rr === "") continue;
    const v = parseFloat(rr.replace(",", "."));
    if (!isFinite(v) || v < 0 || v > 500) continue;
    const id = f[iId].trim();
    let s = st.get(id);
    if (!s) {
      s = { id, name: (f[iName] || "").trim(), lat: parseFloat(f[iLat].replace(",", ".")), lon: parseFloat(f[iLon].replace(",", ".")), alt: parseFloat((f[iAlt] || "0").replace(",", ".")), rr: new Map() };
      st.set(id, s);
    }
    s.rr.set(date, v);
  }
  return [...st.values()];
}

export async function correctFile(file) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  if (data.gauges && data.gauges.applied) { console.log("Pluie déjà corrigée le " + data.gauges.applied + " : rien à faire."); return; }
  const n = data.n, dates = [];
  for (let t = 0; t < n; t++) { const d = new Date(data.d0 + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + t); dates.push(d.toISOString().slice(0, 10)); }
  const wanted = new Set(dates);
  console.log("Pluviomètres Météo-France :");
  let stations = [];
  for (const d of DEPTS) {
    const txt = await fetchDept(d);
    if (txt) { try { stations = stations.concat(parse(txt, wanted)); } catch (e) { console.log("  " + d + " : " + e.message); } }
  }
  const nodes = data.pts.map((p) => ({ lat: p[0] * data.latB, lon: p[1] * data.lonB, p }));
  const latMin = Math.min(...nodes.map((x) => x.lat)) - 0.2, latMax = Math.max(...nodes.map((x) => x.lat)) + 0.2;
  const lonMin = Math.min(...nodes.map((x) => x.lon)) - 0.3, lonMax = Math.max(...nodes.map((x) => x.lon)) + 0.3;
  stations = stations.filter((s) => s.lat > latMin && s.lat < latMax && s.lon > lonMin && s.lon < lonMax && s.rr.size);
  if (!stations.length) { console.log("Aucun pluviomètre exploitable : pluie laissée telle quelle."); return; }

  // Pluie du modèle à chaque pluviomètre (4 points de grille les plus proches, pondérés par 1/d²) et écarts.
  const rain = (p, t) => p[3 + t] / 10;
  let sumObs = 0, sumMod = 0;
  for (const s of stations) {
    const near = nodes.map((x) => ({ x, d: km(s, x) })).sort((a, b) => a.d - b.d).slice(0, 4);
    s.err = new Map();
    s.sumObs = 0; s.sumMod = 0;
    dates.forEach((date, t) => {
      if (!s.rr.has(date)) return;
      let w = 0, m = 0;
      for (const { x, d } of near) { const ww = 1 / Math.max(0.3, d) ** 2; w += ww; m += ww * rain(x.p, t); }
      m /= w;
      s.err.set(t, s.rr.get(date) - m);
      s.sumObs += s.rr.get(date); s.sumMod += m;
    });
    sumObs += s.sumObs; sumMod += s.sumMod;
  }

  // Correction de chaque point de grille, jour par jour.
  let changed = 0, absAdd = 0;
  for (const x of nodes) {
    const near = stations.map((s) => ({ s, d: km(s, x) })).filter((o) => o.d <= MAX_KM);
    if (!near.length) continue;
    for (let t = 0; t < n; t++) {
      let w = 0, e = 0;
      for (const { s, d } of near) {
        if (!s.err.has(t)) continue;
        const ww = Math.exp(-((d / L_KM) ** 2));
        w += ww; e += ww * s.err.get(t);
      }
      if (w < 1e-4) continue;
      const corr = e / (w + LAMBDA);
      const before = x.p[3 + t];
      const after = Math.max(0, Math.round(before + corr * 10));
      if (after !== before) { x.p[3 + t] = after; changed++; absAdd += Math.abs(after - before) / 10; }
    }
  }
  const last14 = dates.slice(Math.max(0, dates.indexOf(new Date().toISOString().slice(0, 10)) - 14));
  data.gauges = {
    applied: new Date().toISOString(), stations: stations.length,
    bias: sumObs && sumMod ? Math.round((sumObs / sumMod - 1) * 100) : null,   // % d'écart mesuré/modèle aux pluviomètres
    list: stations.map((s) => {
      let o = 0, m = 0; s.err.forEach((e, t) => { if (last14.includes(dates[t])) { o += s.rr.get(dates[t]); m += s.rr.get(dates[t]) - e; } });
      return [+s.lat.toFixed(4), +s.lon.toFixed(4), Math.round(s.alt || 0), s.name, Math.round(o * 10) / 10, Math.round(m * 10) / 10];
    })
  };
  fs.writeFileSync(file, JSON.stringify(data));
  console.log(`${stations.length} pluviomètres, ${changed} valeurs corrigées (${Math.round(absAdd)} mm déplacés au total). ` +
    `Aux pluviomètres, la pluie mesurée vaut ${data.gauges.bias == null ? "?" : (data.gauges.bias >= 0 ? "+" : "") + data.gauges.bias + " %"} de celle du modèle.`);
}

if (import.meta.url === "file://" + process.argv[1]) {
  correctFile(process.argv[2] || "site/data/wx.json").catch((e) => { console.log("Correction par pluviomètres impossible : " + e.message); });
}
