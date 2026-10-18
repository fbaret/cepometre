# Cèpomètre

Carte de l'indice de pousse des cèpes (et d'autres espèces) sur les Pyrénées-Atlantiques et les Hautes-Pyrénées.

Deux fois par jour, GitHub récupère la météo (Open-Meteo, modèles Météo-France) sur une grille de 5 km, affinée à 1,7 km là où le relief et la pluie varient le plus, puis publie l'appli et un fichier de données. Le téléphone télécharge ce fichier et fait tous les calculs lui-même, sans appeler Open-Meteo.

## Mise en ligne

L'appli est publiée sur **https://vestra.fr/cepometre/** (hébergement OVH, dossier `www/cepometre`).
La tâche « Mise à jour du Cèpomètre » (GitHub Actions) chiffre l'appli, récupère la météo puis envoie le tout par FTPS,
à chaque modification du code et deux fois par jour (vers 6 h 40 et 18 h 40).

Secrets du dépôt : `CEPO_PASSWORD`, `OVH_FTP_HOST`, `OVH_FTP_USER`, `OVH_FTP_PASSWORD` (et `OVH_FTP_DIR` si le site n'est pas dans `www`).
Protection du site existant : la tâche refuse toute destination qui ne se termine pas par `/cepometre/`, et ne synchronise que ce dossier.

Sur Android : ouvre l'adresse dans Chrome, menu ⋮ > **Installer l'application**.

## Ce qui est public

Le dépôt est privé. La météo publiée (`data/wx.json`) est lisible par tous, mais ne contient que des données publiques. **Ni ton carnet ni tes coins** n'y sont : ils restent sur ton téléphone. L'appli publiée est chiffrée avec ton mot de passe, qui reste dans les secrets de GitHub.

## Forêts et relief

`scripts/statique.py` précalcule, une seule fois, une grille de 250 m sur le 64 et le 65 : essence dominante et part de forêt (BD Forêt V2 de l'IGN, 44 000 polygones), pente et exposition (altimétrie IGN). Le résultat (`data/static.json` + `static.bin.gz`, environ 600 Ko) est gardé dans le cache de GitHub et n'est recalculé que si le script change. La carte multiplie la météo par ces poids ; la case « Tenir compte des arbres et de l'exposition » permet de revenir à la météo seule.

## Budget Open-Meteo

Seuls les passages planifiés (6 h 40 et 18 h 40) et les lancements manuels interrogent Open-Meteo. Une modification du code reprend la dernière météo publiée.


4 400 appels au plus par passage, soit 8 800 par jour, sous la limite gratuite de 10 000. Le script ralentit tout seul pour rester sous 450 appels par minute. Si Open-Meteo bloque, il complète avec le fichier précédent et l'appli l'indique.

## Fichiers

- `source/app.html`, `source/model.js` : l'appli et le modèle.
- `source/verrou.html`, `source/chiffrer.js`, `source/sel.txt` : écran de mot de passe et chiffrement.
- `source/sw.js`, `manifest.webmanifest`, icônes : installation et hors-ligne.
- `scripts/meteo.mjs` : récupération de la météo, grille adaptative.
- `.github/workflows/mise-a-jour.yml` : la tâche planifiée.

Données : Open-Meteo (CC-BY 4.0), IGN Géoplateforme (Plan IGN, photos aériennes, BD Forêt V2, altimétrie), OpenTopoMap.
