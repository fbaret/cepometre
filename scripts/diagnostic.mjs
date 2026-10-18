#!/usr/bin/env node
/* Diagnostic : comment l'indice des cèpes varie avec l'altitude, et pourquoi.
 *   node scripts/diagnostic.mjs site/data
 * Écrit des annotations GitHub (::notice) lisibles dans le résumé du passage. */
import fs from "node:fs";
import zlib from "node:zlib";
import vm from "node:vm";

const dir = process.argv[2] || "site/data";
const ctx = { window: {} }; ctx.globalThis = ctx; vm.createContext(ctx);
vm.runInContext(fs.readFileSync("source/model.js", "utf8"), ctx);
const M = ctx.window.CepeModel;

const wx = JSON.parse(fs.readFileSync(dir + "/wx.json", "utf8"));
const n = wx.n, LAT_B = wx.latB, LON_B = wx.lonB;
const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Paris" });
const date = []; for (let t = 0; t < n; t++) { const d = new Date(wx.d0 + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + t); date.push(d.toISOString().slice(0, 10)); }
const k = date.indexOf(today);
const nodes = wx.pts.map((p) => {
  const sl = (o) => p.slice(3 + o * n, 3 + (o + 1) * n).map((v) => v / 10);
  return { lat: p[0] * LAT_B, lon: p[1] * LON_B, el: p[2], days: { date, rain: sl(0), tmin: sl(1), tmax: sl(2) } };
});

let H = null;
if (fs.existsSync(dir + "/static.json")) {
  H = JSON.parse(fs.readFileSync(dir + "/static.json", "utf8"));
  const buf = zlib.gunzipSync(fs.readFileSync(dir + "/static.bin.gz")), N = H.rows * H.cols;
  Object.assign(H, { cat: buf.subarray(0, N), frac: buf.subarray(N, 2 * N), slope: buf.subarray(2 * N, 3 * N), aspect: buf.subarray(3 * N, 4 * N) });
}

const bands = [[0, 300], [300, 600], [600, 900], [900, 1200], [1200, 1600], [1600, 3500]];
const notice = (title, lines) => console.log("::notice title=" + title + "::" + lines.join("%0A"));
const f1 = (x) => (Math.round(x * 10) / 10).toFixed(1), f2 = (x) => x.toFixed(2);

// 1. Météo seule par tranche d'altitude (points de grille météo)
const L1 = ["Jour : " + today + " (index " + k + "), " + nodes.length + " points météo"];
for (const [a, b] of bands) {
  const sel = nodes.filter((x) => x.el >= a && x.el < b);
  if (!sel.length) continue;
  const r = sel.map((x) => M.scoreDay(x.days, k, {}, { elevation: x.el }));
  const avg = (f) => r.reduce((s, y) => s + f(y), 0) / r.length;
  L1.push(`${a}-${b} m : ${sel.length} pts | indice ${f1(avg((y) => y.score))} | pluie ${f2(avg((y) => y.parts.rainF))} (utile ${f1(avg((y) => y.parts.effRain))} mm) | temp ${f2(avg((y) => y.parts.tempF))} (moy5j ${f1(avg((y) => y.parts.tMean5))} °C, gel ${f1(avg((y) => y.parts.frost))} j) | délai ${f1(avg((y) => y.parts.mu))} j | saison ${f2(avg((y) => y.parts.seasonF))}`);
}
notice("altitude-meteo", L1);

// 2. Forêt et relief par tranche d'altitude (altitude du point météo le plus proche)
if (H) {
  const near = (lat, lon) => {
    let best = null, bd = 1e9;
    for (const x of nodes) { const d = (x.lat - lat) ** 2 + ((x.lon - lon) * 0.73) ** 2; if (d < bd) { bd = d; best = x; } }
    return best;
  };
  const W = {}; H.cats.forEach((c, i) => { W[i] = c === "horsforet" ? 0 : c === "inconnu" ? 0.5 : M.withEssence(1000, c) / 1000; });
  const lande = H.cats.indexOf("lande"), full = 0.4 * H.sub * H.sub;
  const acc = bands.map(() => ({ cells: 0, forest: 0, lande: 0, steep: 0, w: 0, wexp: 0, cats: {} }));
  const step = 4;                                      // une cellule sur 16, suffisant pour des moyennes
  const nodeCache = new Map();
  for (let r = 0; r < H.rows; r += step) for (let c = 0; c < H.cols; c += step) {
    const idx = r * H.cols + c, cat = H.cat[idx];
    const lat = H.n - (r + 0.5) * H.dLat, lon = H.w + (c + 0.5) * H.dLon;
    const key = (r >> 4) + "," + (c >> 4);
    let nd = nodeCache.get(key); if (!nd) { nd = near(lat, lon); nodeCache.set(key, nd); }
    const bi = bands.findIndex(([a, b]) => nd.el >= a && nd.el < b); if (bi < 0) continue;
    const A = acc[bi]; A.cells++;
    if (!cat) continue;
    if (cat === lande) A.lande++;
    else A.forest++;
    A.cats[H.cats[cat]] = (A.cats[H.cats[cat]] || 0) + 1;
    let w = W[cat]; if (cat !== lande) w *= Math.min(1, H.frac[idx] / full);
    const t5 = M.scoreDay(nd.days, k, {}, { elevation: nd.el }).parts.tMean5;
    const s = H.slope[idx];
    const we = s !== 255 ? w * M.exposureFactor({ slope: s, aspect: H.aspect[idx] * 2 }, t5).f : w;
    if (s !== 255 && s > 30) A.steep++;
    A.w += w; A.wexp += we;
  }
  const L2 = ["Par tranche : part de forêt, de lande, pentes > 30°, poids moyen essence×forêt, puis avec exposition (cellules non vides)"];
  bands.forEach(([a, b], i) => {
    const A = acc[i]; if (!A.cells) return;
    const nn = A.forest + A.lande;
    const top = Object.entries(A.cats).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([c, v]) => c + " " + Math.round(100 * v / Math.max(1, nn)) + "%").join(", ");
    L2.push(`${a}-${b} m : forêt ${Math.round(100 * A.forest / A.cells)}% | lande ${Math.round(100 * A.lande / A.cells)}% | pente>30° ${Math.round(100 * A.steep / Math.max(1, nn))}% | poids ${f2(A.w / Math.max(1, nn))} → ${f2(A.wexp / Math.max(1, nn))} | ${top}`);
  });
  notice("altitude-foret", L2);
}

// 3. Points témoins
const spots = [["Iraty", 43.04, -1.08], ["Parbayse", 43.392, -0.564], ["Bois du Bager (Oloron)", 43.11, -0.55], ["Plaine de Pau", 43.33, -0.40]];
const L3 = [];
for (const [name, lat, lon] of spots) {
  let best = null, bd = 1e9;
  for (const x of nodes) { const d = (x.lat - lat) ** 2 + ((x.lon - lon) * 0.73) ** 2; if (d < bd) { bd = d; best = x; } }
  const r = M.scoreDay(best.days, k, {}, { elevation: best.el });
  const p = r.parts, rain14 = best.days.rain.slice(Math.max(0, k - 14), k).reduce((s, v) => s + v, 0);
  let hab = "";
  if (H) {
    const rr = Math.floor((H.n - lat) / H.dLat), cc = Math.floor((lon - H.w) / H.dLon), idx = rr * H.cols + cc;
    hab = ` | cellule : ${H.cats[H.cat[idx]]}, forêt ${H.frac[idx]}/25, pente ${H.slope[idx]}°, expo ${H.aspect[idx] * 2}°`;
  }
  L3.push(`${name} (point météo à ${best.el} m) : indice ${r.score} | pluie 14 j ${f1(rain14)} mm, utile ${f1(p.effRain)} | moy5j ${f1(p.tMean5)} °C, tempF ${f2(p.tempF)}, gel ${p.frost} | délai ${f1(p.mu)} j | saison ${f2(p.seasonF)}${hab}`);
}
notice("points-temoins", L3);
if (wx.gauges) {
  const g = wx.gauges, top = [...g.list].sort((a, b) => b[4] - a[4]).slice(0, 6);
  notice("pluviometres", [`${g.stations} pluviomètres, mesuré/modèle : ${g.bias >= 0 ? "+" : ""}${g.bias} % (corrigé le ${g.applied})`,
    ...top.map((x) => `${x[3]} (${x[2]} m) : ${x[4]} mm mesurés en 14 j, modèle ${x[5]} mm`)]);
}
