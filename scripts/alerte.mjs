#!/usr/bin/env node
/* Alerte : nouveau jour à plus de 80 dans la semaine (cèpes, forêts publiques, 64 + 65).
 *   node scripts/alerte.mjs site/data
 * Calcule, pour chaque jour d'aujourd'hui à J+6, la meilleure case de 250 m en forêt publique
 * (météo ramenée à l'altitude de la case × essence × part de forêt). Écrit data/alertes.json.
 * Si NTFY_TOPIC est défini, envoie une notification ntfy pour chaque jour qui passe à SEUIL ou plus
 * alors qu'il était en dessous au passage précédent (PREV_URL). */
import fs from "node:fs";
import zlib from "node:zlib";
import vm from "node:vm";

const SEUIL = +(process.env.SEUIL || 80), LAPSE = -0.0065;
const dir = process.argv[2] || "site/data";
const ctx = { window: {} }; ctx.globalThis = ctx; vm.createContext(ctx);
vm.runInContext(fs.readFileSync("source/model.js", "utf8"), ctx);
const M = ctx.window.CepeModel;

const wx = JSON.parse(fs.readFileSync(dir + "/wx.json", "utf8"));
const n = wx.n, K = wx.k || 3;
const dates = []; for (let t = 0; t < n; t++) { const d = new Date(wx.d0 + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + t); dates.push(d.toISOString().slice(0, 10)); }
const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Paris" });
const k0 = dates.indexOf(today);
if (k0 < 0) { console.log("Jour courant absent de la météo"); process.exit(0); }
const ks = []; for (let k = k0; k < Math.min(n, k0 + 7); k++) ks.push(k);

const grid = new Map(); let nid = 0;
for (const p of wx.pts) {
  const sl = (o) => p.slice(3 + o * n, 3 + (o + 1) * n).map((v) => v / 10);
  grid.set(p[0] + "," + p[1], { id: nid++, el: p[2], days: { date: dates, rain: sl(0), tmin: sl(1), tmax: sl(2) } });
}
const nodeAt = (lat, lon) => {
  const i = Math.round(lat / wx.latB), j = Math.round(lon / wx.lonB);
  return grid.get(i + "," + j) || grid.get(Math.round(i / K) * K + "," + Math.round(j / K) * K);
};

const H = JSON.parse(fs.readFileSync(dir + "/static.json", "utf8"));
const P = JSON.parse(fs.readFileSync(dir + "/public.json", "utf8"));
const hb = zlib.gunzipSync(fs.readFileSync(dir + "/static.bin.gz")), pb = zlib.gunzipSync(fs.readFileSync(dir + "/public.bin.gz"));
const N = H.rows * H.cols;
const cat = hb.subarray(0, N), frac = hb.subarray(N, 2 * N);
const elev = H.v >= 2 ? new Uint16Array(hb.buffer.slice(hb.byteOffset + 4 * N, hb.byteOffset + 6 * N)) : null;
const pid = new Uint16Array(pb.buffer.slice(pb.byteOffset, pb.byteOffset + 2 * N)), pfrac = pb.subarray(2 * N, 3 * N);
const W = H.cats.map((c) => (c === "horsforet" || c === "lande" ? 0 : c === "inconnu" ? 0.5 : M.withSpeciesEssence(1000, "cepes", c) / 1000));
const full = 0.4 * H.sub * H.sub;

const best = ks.map(() => ({ s: -1 }));
const memo = new Map();
for (let r = 0; r < H.rows; r++) for (let c = 0; c < H.cols; c++) {
  const idx = r * H.cols + c;
  if (pfrac[idx] < 10 || !W[cat[idx]]) continue;
  const lat = H.n - (r + 0.5) * H.dLat, lon = H.w + (c + 0.5) * H.dLon;
  const nd = nodeAt(lat, lon); if (!nd) continue;
  const z = elev && elev[idx] !== 65535 ? elev[idx] : nd.el;
  const dT = Math.round(LAPSE * (z - nd.el) * 2) / 2;            // pas de 0,5 °C : mise en cache
  const w = W[cat[idx]] * Math.min(1, frac[idx] / full);
  const key = nd.id + "|" + dT + "|" + Math.round(z / 50);
  ks.forEach((k, t) => {
    const mk = key + "|" + k;
    let sc = memo.get(mk);
    if (sc == null) { sc = M.scoreDay(nd.days, k, {}, { elevation: z, dT }).score; memo.set(mk, sc); }
    const s = Math.round(sc * w);
    if (s > best[t].s) best[t] = { s, lat, lon, z, forest: pid[idx] ? P.forests[pid[idx] - 1][0] : "Forêt publique" };
  });
}

async function commune(lat, lon) {
  try {
    const r = await fetch(`https://geo.api.gouv.fr/communes?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}&fields=nom,codeDepartement`);
    const a = await r.json(); return a[0] ? `${a[0].nom} (${a[0].codeDepartement})` : "";
  } catch { return ""; }
}
const days = {};
for (let t = 0; t < ks.length; t++) {
  const b = best[t]; if (b.s < 0) continue;
  days[dates[ks[t]]] = { s: b.s, lat: +b.lat.toFixed(5), lon: +b.lon.toFixed(5), z: b.z, forest: b.forest, commune: b.s >= SEUIL ? await commune(b.lat, b.lon) : "" };
}
let prev = {};
try { if (process.env.PREV_URL) { const r = await fetch(process.env.PREV_URL); if (r.ok) prev = (await r.json()).days || {}; } } catch {}
const fresh = Object.entries(days).filter(([d, x]) => x.s >= SEUIL && !(prev[d] && prev[d].s >= SEUIL));
fs.writeFileSync(dir + "/alertes.json", JSON.stringify({ generated: new Date().toISOString(), seuil: SEUIL, days, nouveaux: fresh.map(([d]) => d) }));

const fmt = (d) => new Date(d + "T12:00:00Z").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const lines = Object.entries(days).map(([d, x]) => `${d} : ${x.s} ${x.commune || ""} ${x.forest}`);
console.log("::notice title=alertes::" + ["Seuil " + SEUIL + ", nouveaux jours : " + (fresh.map(([d]) => d).join(", ") || "aucun"), ...lines].join("%0A"));

if (fresh.length && process.env.NTFY_TOPIC) {
  const body = fresh.map(([d, x]) => `${fmt(d)} : ${x.s}/100 vers ${x.commune || "?"}, ${x.forest} (${x.z} m)`).join("\n");
  const [d0, x0] = fresh[0];
  const r = await fetch("https://ntfy.sh/" + process.env.NTFY_TOPIC, {
    method: "POST", body,
    headers: { Title: `Cèpes : ${fresh.length > 1 ? fresh.length + " jours" : "un jour"} à plus de ${SEUIL} cette semaine`.normalize("NFD").replace(/[̀-ͯ]/g, ""),
      Tags: "mushroom", Click: "https://vestra.fr/cepometre/",
      Actions: `view, Carte, https://www.google.com/maps/search/?api=1&query=${x0.lat},${x0.lon}` },
  });
  console.log("Notification envoyée :", r.status, body);
}
