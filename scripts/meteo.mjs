#!/usr/bin/env node
/* Prépare la météo du Cèpomètre pour les Pyrénées-Atlantiques (64) et les Hautes-Pyrénées (65).
 *
 *   node scripts/meteo.mjs site/data/wx.json
 *
 * 1. Grille de base tous les 0,045° (environ 5 km) sur tout le rectangle 64 + 65.
 * 2. Raffinement à 0,015° (environ 1,7 km) dans les mailles où la météo et le relief
 *    varient le plus (montagne, orages localisés), tant que le budget le permet.
 * Budget : MAX_CALLS appels Open-Meteo par passage (4 400 par défaut, soit 8 800
 * par jour pour deux passages, sous la limite gratuite de 10 000), au plus
 * 450 par minute. Un point sur 28 jours compte pour 2 appels.
 * Si Open-Meteo bloque en cours de route, on complète avec le fichier précédent.
 * Aucune dépendance : Node 20 ou plus. */
import fs from "node:fs";
import path from "node:path";

const OUT = process.argv[2] || "site/data/wx.json";
const PREV_URL = process.env.PREV_URL || "";
const BOX = { s: 42.62, n: 43.66, w: -1.80, e: 0.70 };      // 64 + 65 et une petite marge
const LAT_B = 0.015, LON_B = +(0.015 / Math.cos(46 * Math.PI / 180)).toFixed(6);   // même réseau que l'appli
const K = 3;                                               // pas de base = 3 × 0,015°
const PAST = 21, FC = 7, WEIGHT = 2;
const MAX_CALLS = +(process.env.MAX_CALLS || 4400), PER_MIN = +(process.env.PER_MIN || 450), CHUNK = 50;
const DAILY = "precipitation_sum,temperature_2m_max,temperature_2m_min";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let used = 0, minute = [];

async function fetchChunk(pts) {
  const url = "https://api.open-meteo.com/v1/forecast?latitude=" + pts.map((p) => p.lat.toFixed(4)).join(",") +
    "&longitude=" + pts.map((p) => p.lon.toFixed(4)).join(",") +
    "&daily=" + DAILY + "&timezone=Europe%2FParis&past_days=" + PAST + "&forecast_days=" + FC;
  const w = pts.length * WEIGHT;
  for (let attempt = 0; attempt < 4; ) {
    const now = Date.now();
    minute = minute.filter((x) => now - x[0] < 60000);
    const inMin = minute.reduce((s, x) => s + x[1], 0);
    if (inMin + w > PER_MIN && minute.length) { await sleep(minute[0][0] + 61000 - now); continue; }
    minute.push([Date.now(), w]); used += w; attempt++;
    let res;
    try { res = await fetch(url); } catch (e) { await sleep(5000); continue; }
    if (res.status === 429) {
      const reason = ((await res.json().catch(() => ({}))).reason) || "";
      console.log("Open-Meteo 429 :", reason);
      if (/hour|day/i.test(reason)) throw new Error("quota " + reason);
      await sleep(65000); continue;
    }
    if (!res.ok) { console.log("Open-Meteo", res.status); await sleep(5000); continue; }
    const j = await res.json();
    return Array.isArray(j) ? j : [j];
  }
  throw new Error("Open-Meteo ne répond pas");
}

async function fetchAll(points, recs) {
  for (let i = 0; i < points.length; i += CHUNK) {
    if (used + CHUNK * WEIGHT > MAX_CALLS) { console.log("Budget atteint."); return false; }
    const chunk = points.slice(i, i + CHUNK);
    const arr = await fetchChunk(chunk);
    arr.forEach((d, n) => {
      const p = chunk[n];
      recs.set(p.i + "," + p.j, { i: p.i, j: p.j, el: d.elevation, time: d.daily.time,
        r: d.daily.precipitation_sum, tn: d.daily.temperature_2m_min, tx: d.daily.temperature_2m_max });
    });
    process.stdout.write(".");
  }
  return true;
}

const node = (i, j) => ({ i, j, lat: +(i * LAT_B).toFixed(5), lon: +(j * LON_B).toFixed(5) });
const sum = (a) => a.reduce((s, v) => s + (v || 0), 0);

async function main() {
  const recs = new Map();
  let blocked = null;

  // 1. Grille de base
  const coarse = [];
  for (let ci = Math.floor(BOX.s / (K * LAT_B)); ci <= Math.ceil(BOX.n / (K * LAT_B)); ci++)
    for (let cj = Math.floor(BOX.w / (K * LON_B)); cj <= Math.ceil(BOX.e / (K * LON_B)); cj++) coarse.push(node(ci * K, cj * K));
  console.log("Grille de base :", coarse.length, "points");
  try { await fetchAll(coarse, recs); } catch (e) { blocked = e.message; }

  // 2. Raffinement là où ça varie le plus
  if (!blocked) {
    const cells = [];
    for (const p of coarse) {
      const c = [[0, 0], [K, 0], [0, K], [K, K]].map(([a, b]) => recs.get((p.i + a) + "," + (p.j + b)));
      if (c.some((x) => !x)) continue;
      if (c.every((x) => x.el <= 2)) continue;                         // mer
      const els = c.map((x) => x.el), rain = c.map((x) => sum(x.r.slice(0, PAST + 1)));
      const tm = c.map((x) => sum(x.tn.slice(PAST - 6, PAST + 1)) / 7);
      const score = (Math.max(...els) - Math.min(...els)) / 300 + (Math.max(...rain) - Math.min(...rain)) / 20 + (Math.max(...tm) - Math.min(...tm)) / 2;
      cells.push({ i: p.i, j: p.j, score });
    }
    cells.sort((a, b) => b.score - a.score);
    const budget = Math.floor((MAX_CALLS - used) / WEIGHT);
    const fine = [], seen = new Set(recs.keys());
    for (const c of cells) {
      const add = [];
      for (let a = 0; a <= K; a++) for (let b = 0; b <= K; b++) {
        const k = (c.i + a) + "," + (c.j + b);
        if (!seen.has(k)) add.push(node(c.i + a, c.j + b));
      }
      if (fine.length + add.length > budget) break;
      add.forEach((p) => seen.add(p.i + "," + p.j));
      fine.push(...add);
    }
    console.log("\nRaffinement :", fine.length, "points dans", cells.length ? "les mailles les plus variables" : "aucune maille");
    try { await fetchAll(fine, recs); } catch (e) { blocked = e.message; }
  }

  // 3. Fichier précédent pour combler un blocage
  let reused = 0;
  if (blocked && PREV_URL) {
    try {
      const prev = await (await fetch(PREV_URL)).json();
      for (const p of prev.pts) {
        const key = p[0] + "," + p[1];
        if (recs.has(key)) continue;
        const n = prev.n, take = (o) => p.slice(3 + o * n, 3 + (o + 1) * n).map((v) => v / 10);
        recs.set(key, { i: p[0], j: p[1], el: p[2], prevD0: prev.d0, r: take(0), tn: take(1), tx: take(2) });
        reused++;
      }
    } catch (e) { console.log("Fichier précédent indisponible :", e.message); }
  }

  // 4. Écriture compacte : dates communes, valeurs ×10 en entiers
  const ref = [...recs.values()].find((r) => r.time);
  if (!ref) { console.error("Aucune donnée récupérée :", blocked); process.exit(1); }
  const time = ref.time, n = time.length, d0 = time[0];
  const pts = [];
  for (const r of recs.values()) {
    let shift = 0;
    if (r.prevD0) shift = Math.round((new Date(d0) - new Date(r.prevD0)) / 864e5);   // réaligne les anciennes séries
    const pick = (arr) => { const out = []; for (let t = 0; t < n; t++) { const v = arr[t + shift]; out.push(v == null ? (t ? out[t - 1] : 0) : Math.round(v * 10)); } return out; };
    pts.push([r.i, r.j, Math.round(r.el ?? 0), ...pick(r.r), ...pick(r.tn), ...pick(r.tx)]);
  }
  const data = { v: 1, generated: new Date().toISOString(), d0, n, latB: LAT_B, lonB: LON_B, k: K, calls: used, reused, blocked, pts };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(data));
  console.log("\n" + pts.length + " points écrits dans " + OUT + " (" + Math.round(fs.statSync(OUT).size / 1024) + " Ko), " + used + " appels" + (blocked ? ", blocage : " + blocked + ", " + reused + " points repris" : ""));
}
main();
