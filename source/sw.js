/* Cache hors-ligne du Cèpomètre.
 * - L'appli elle-même : servie depuis le cache, mise à jour en arrière-plan.
 * - La météo : gérée par l'appli elle-même (IndexedDB, 3 jours).
 * - Les morceaux de carte : cache d'abord. Ceux consultés en passant sont
 *   limités à 4 000 ; ceux des « zones gardées » ne sont jamais effacés
 *   automatiquement (cache « cepometre-zones », géré depuis l'appli). */
var VERSION = "cepometre-v10";
var KEEP = ["cepometre-zones"];
var SHELL = [
  "./", "index.html", "manifest.webmanifest", "icon-192.png", "icon-512.png",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css",
  "https://data.geopf.fr/annexes/ressources/legendes/LANDCOVER.FORESTINVENTORY.V2-legend.png"
];
var TILE_LIMIT = 4000;

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(VERSION + "-shell").then(function (c) {
    // Un fichier externe indisponible ne doit pas empêcher l'installation.
    return Promise.all(SHELL.map(function (u) { return c.add(u).catch(function () {}); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf(VERSION) !== 0 && KEEP.indexOf(k) < 0; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

var trimming = false;
function trim(cacheName, max) {
  if (trimming) return Promise.resolve();
  trimming = true;
  return caches.open(cacheName).then(function (c) {
    return c.keys().then(function (keys) {
      if (keys.length <= max) return;
      return Promise.all(keys.slice(0, keys.length - max).map(function (k) { return c.delete(k); }));
    });
  }).finally(function () { trimming = false; });
}

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);

  // Météo : jamais interceptée, l'appli garde sa propre copie dans IndexedDB.
  if (/open-meteo\.com$/.test(url.hostname)) return;

  // Morceaux de carte : cache d'abord (zones gardées comprises).
  var isTile = (url.hostname === "data.geopf.fr" && /GetTile/i.test(url.search)) || /tile\.opentopomap\.org$/.test(url.hostname);
  if (isTile) {
    e.respondWith(caches.match(req.url).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res.ok) {
          var copy = res.clone();
          caches.open(VERSION + "-tiles").then(function (c) { return c.put(req.url, copy); }).then(function () { return trim(VERSION + "-tiles", TILE_LIMIT); });
        }
        return res;
      });
    }));
    return;
  }

  // Données du serveur : jamais en cache ici, l'appli garde sa copie dans IndexedDB.
  if (url.origin === self.location.origin && url.pathname.indexOf("/data/") >= 0) return;

  // Appli, polices, légende : cache, puis mise à jour en arrière-plan.
  if (url.origin === self.location.origin || /cdnjs\.cloudflare\.com|fonts\.(googleapis|gstatic)\.com/.test(url.hostname) || /\/legendes\//.test(url.pathname)) {
    e.respondWith(caches.match(req).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (res.ok || res.type === "opaque") { var copy = res.clone(); caches.open(VERSION + "-shell").then(function (c) { c.put(req, copy); }); }
        return res;
      }).catch(function () { return hit; });
      return hit || net;
    }));
  }
});
