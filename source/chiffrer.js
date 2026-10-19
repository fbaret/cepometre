#!/usr/bin/env node
/* Construit la version à déposer en ligne, chiffrée par mot de passe.
 *
 *   node chiffrer.js "mot de passe"            -> écrit ../a-deposer/
 *   node chiffrer.js "mot de passe" dossier     -> écrit dans « dossier »
 *
 * L'appli (app.html + model.js) est chiffrée en AES-256-GCM avec une clé tirée
 * du mot de passe (PBKDF2-SHA256, 310 000 itérations). Le site ne contient que
 * l'écran de déverrouillage et ce bloc chiffré : sans le mot de passe, le code
 * et les coins du carnet pré-rempli sont illisibles.
 * Le « sel » est gardé dans sel.txt : tant qu'il ne change pas, une nouvelle
 * version avec le même mot de passe n'oblige pas à le retaper sur le téléphone.
 * Aucune dépendance : Node 16 ou plus suffit. */
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");

const pw = process.argv[2];
if (!pw) { console.error('Usage : node chiffrer.js "mot de passe" [dossier de sortie]'); process.exit(1); }
const src = __dirname;
const out = path.resolve(process.argv[3] || path.join(src, "..", "a-deposer"));

let app = fs.readFileSync(path.join(src, "app.html"), "utf8");
const model = fs.readFileSync(path.join(src, "model.js"), "utf8");
const tag = '<script src="model.js"></script>';
if (!app.includes(tag)) { console.error("app.html ne charge plus model.js comme prévu."); process.exit(1); }
app = app.replace(tag, () => "<script>\n" + model + "\n</script>");
// Jeton de l'alerte perso : connu seulement de l'appli déchiffrée et de GitHub (dérivé du mot de passe).
const alertToken = crypto.createHash("sha256").update(pw + ":alerte").digest("hex");
app = app.replace("__ALERT_TOKEN__", alertToken);

const selFile = path.join(src, "sel.txt");
if (!fs.existsSync(selFile)) fs.writeFileSync(selFile, crypto.randomBytes(16).toString("base64") + "\n");
const salt = Buffer.from(fs.readFileSync(selFile, "utf8").trim(), "base64");
const iv = crypto.randomBytes(12), it = 310000;
const key = crypto.pbkdf2Sync(pw, salt, it, 32, "sha256");
const c = crypto.createCipheriv("aes-256-gcm", key, iv);
const ct = Buffer.concat([c.update(app, "utf8"), c.final(), c.getAuthTag()]);
const payload = { v: 1, s: salt.toString("base64"), iv: iv.toString("base64"), it: it, c: ct.toString("base64") };

const lock = fs.readFileSync(path.join(src, "verrou.html"), "utf8").replace("__PAYLOAD__", () => JSON.stringify(payload));
fs.mkdirSync(out, { recursive: true });
for (const old of fs.readdirSync(out)) fs.rmSync(path.join(out, old), { recursive: true, force: true });
fs.writeFileSync(path.join(out, "index.html"), lock);
for (const f of ["sw.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "icon-maskable-512.png"]) {
  fs.copyFileSync(path.join(src, f), path.join(out, f));
}
fs.mkdirSync(path.join(out, "api"), { recursive: true });
fs.writeFileSync(path.join(out, "api", "alerte.php"), fs.readFileSync(path.join(src, "api", "alerte.php"), "utf8")
  .replace("__TOKEN_HASH__", crypto.createHash("sha256").update(alertToken).digest("hex")));
console.log("Version chiffrée écrite dans " + out + " (" + fs.readdirSync(out).length + " fichiers).");
