/* Indice de pousse des cèpes — modèle simple et calable.
 *
 * Idée : une pluie tombée il y a « mu » jours déclenche une pousse.
 * Le délai mu raccourcit quand il fait doux et s'allonge quand il fait frais.
 * On pondère chaque jour de pluie par une courbe en cloche centrée sur mu,
 * on transforme ce cumul « efficace » en score de 0 à 1, puis on module
 * par la température des derniers jours, le gel, la saison et l'essence.
 *
 * Toutes les entrées sont des tableaux journaliers alignés :
 *   days.date[i] (YYYY-MM-DD), days.rain[i] (mm), days.tmin[i], days.tmax[i] (°C)
 */
(function (root) {
  "use strict";

  var DEFAULTS = {
    lagBase: 10,      // délai pluie -> pousse à 15 °C (jours)
    lagPerDeg: 0.35,  // jours de délai en plus par degré sous 15 °C
    lagMin: 6,
    lagMax: 17,
    sigma: 4,         // durée de la pousse après le pic (jours)
    sigmaRise: 1.8,   // montée avant le pic (jours)
    halfSat: 22,      // mm de pluie efficace pour un score pluie de 63 %
    tLow: 10,         // plage de température moyenne idéale (°C)
    tHigh: 20,
    tColdZero: 3,     // en dessous, presque plus rien
    tHotZero: 27,
    soilMargin: 2,    // sol : poussée pleine à partir de tLow + soilMargin, nulle sous tColdZero + soilMargin (°C)
    soilTau: 6,       // inertie du sol (jours)
    soilShift: 0,     // réglage du seuil de sol (°C), calable sur le carnet
    altShift: 0,      // ancien calendrier avancé en altitude : désactivé, la température du sol s'en charge
    altFrom: 300,
    altCap: 50        // avance maximale (jours)
  };

  // Poids par essence dominante (catégories simplifiées de la BD Forêt).
  var ESSENCES = {
    chene:      { label: "Chênes",               w: 1.0 },
    chataignier:{ label: "Châtaignier",          w: 1.0 },
    hetre:      { label: "Hêtre",                w: 1.0 },
    feuillus:   { label: "Mélange de feuillus",  w: 0.85 },
    mixte:      { label: "Feuillus et conifères",w: 0.85 },
    sapin:      { label: "Sapin ou épicéa",      w: 0.8 },
    pin:        { label: "Pins",                 w: 0.55 },
    peuplier:   { label: "Peupleraie",           w: 0.05 },
    robinier:   { label: "Robinier",             w: 0.15 },
    lande:      { label: "Lande, forêt ouverte", w: 0.15 },
    horsforet:  { label: "Hors forêt",           w: 0 },
    inconnu:    { label: "Essence inconnue",     w: null }
  };

  // Classe un libellé BD Forêt (TFV ou essence) dans une catégorie.
  function classifyEssence(text) {
    if (!text) return "inconnu";
    var t = String(text).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    if (/peupl/.test(t)) return "peuplier";
    if (/robinier/.test(t)) return "robinier";
    if (/lande|formation herbacee|ouverte/.test(t)) return "lande";
    if (/mixte|preponderant|feuillus et coniferes|coniferes et feuillus/.test(t)) return "mixte";
    if (/chataign/.test(t)) return "chataignier";
    if (/hetre/.test(t)) return "hetre";
    if (/chene/.test(t)) return "chene";
    if (/sapin|epicea|douglas|meleze/.test(t)) return "sapin";
    if (/pin/.test(t)) return "pin";
    if (/feuillus/.test(t)) return "feuillus";
    if (/conifere/.test(t)) return "sapin";
    return "inconnu";
  }

  /* Saison : poids par mois (cèpes de plaine), interpolés au jour près.
   * En altitude, tout le calendrier avance : la pousse commence plus tôt l'été et finit plus tôt
   * l'automne, parce que le sol se refroidit plus vite. Avance = altShift jours par 100 m au-dessus
   * de altFrom (3,5 j par défaut : environ 4 semaines à 1 100 m, 5 semaines à 1 300 m). */
  var MONTH_W = [0.05, 0.03, 0.05, 0.1, 0.3, 0.6, 0.5, 0.6, 0.9, 1.0, 0.75, 0.2];
  function seasonShift(elevation, p) {
    p = p || DEFAULTS;
    var el = elevation || 0;
    return Math.max(0, Math.min(p.altCap, (el - p.altFrom) / 100 * p.altShift));
  }
  function seasonFromMonths(months, dateStr, elevation, p) {
    var d = new Date(dateStr + "T12:00:00");
    d.setDate(d.getDate() + Math.round(seasonShift(elevation, p)));
    var m = d.getMonth(), day = d.getDate(), dim = new Date(d.getFullYear(), m + 1, 0).getDate();
    var pos = m + (day - 1) / dim - 0.5;              // en mois, 0 = mi-janvier
    var m0 = Math.floor(pos), f = pos - m0;
    var a = months[(m0 + 12) % 12], b = months[(m0 + 13) % 12];
    return a + (b - a) * f;
  }
  function seasonFactor(dateStr, elevation, p) { return seasonFromMonths(MONTH_W, dateStr, elevation, p); }
  function altitudeFactor(el, altMin, altMax) {
    if (el == null || (altMin == null && altMax == null)) return 1;
    if (altMax != null && el > altMax) return Math.max(0, 1 - (el - altMax) / 400);
    if (altMin != null && el < altMin) return Math.max(0, 1 - (altMin - el) / 400);
    return 1;
  }

  function mean(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : NaN; }

  /* Chaleur : moyenne de l'air sur 5 jours ; au-delà de tHigh, la pousse ralentit. */
  function heatFactor(tmean, p) {
    if (isNaN(tmean)) return 0.5;
    if (tmean <= p.tHigh) return 1;
    return Math.max(0.1, (p.tHotZero - tmean) / (p.tHotZero - p.tHigh));
  }
  /* Froid : température du sol estimée. Le sol suit l'air avec retard (moyenne glissante sur
   * environ soilTau jours) et les nuits comptent double, car il se refroidit surtout la nuit :
   * valeur du jour = (2 × minimale + maximale) / 3. En altitude, l'air plus froid donne
   * naturellement un sol plus froid : c'est ainsi que la saison s'y arrête plus tôt. */
  function soilTemp(days, k, dT) {
    var a = 1 / DEFAULTS.soilTau, s = null;
    for (var i = 0; i <= k; i++) {
      var v = (2 * days.tmin[i] + days.tmax[i]) / 3 + (dT || 0);
      s = s == null ? v : s + a * (v - s);
    }
    return s;
  }
  function soilFactor(soilT, p) {
    var hi = p.tLow + p.soilMargin + (p.soilShift || 0), lo = p.tColdZero + p.soilMargin + (p.soilShift || 0);
    if (soilT >= hi) return 1;
    return Math.max(0.05, (soilT - lo) / (hi - lo));
  }

  /* Calcule le score pour le jour d'index k.
   * Renvoie { score (0-100, sans essence), parts: {...} } */
  function scoreDay(days, k, params, opts) {
    var p = Object.assign({}, DEFAULTS, params || {});
    opts = opts || {};
    if (k < 0 || k >= days.date.length) return null;

    var dT = opts.dT || 0;      // décalage de température (correction d'altitude d'un pixel de la carte)
    // Température moyenne des 14 jours précédents, pour fixer le délai.
    var t14 = [];
    for (var i = Math.max(0, k - 14); i < k; i++) t14.push((days.tmin[i] + days.tmax[i]) / 2 + dT);
    var tLag = t14.length ? mean(t14) : 15;
    var mu = Math.min(p.lagMax, Math.max(p.lagMin, p.lagBase + (15 - tLag) * p.lagPerDeg + (p.lagShift || 0)));

    // Pluie efficace : somme des pluies pondérées par la cloche autour de mu.
    var eff = 0, best = { lag: null, mm: 0 };
    var span = Math.ceil(mu + 3 * p.sigma);
    for (var lag = 1; lag <= span; lag++) {
      var j = k - lag;
      if (j < 0) break;
      var r = days.rain[j] || 0;
      if (r <= 0) continue;
      // Cloche asymétrique : rien ne sort quelques jours après la pluie
      // (montée raide), puis la pousse s'étale sur une semaine ou plus.
      var sg = lag < mu ? p.sigmaRise : p.sigma;
      var w = Math.exp(-((lag - mu) * (lag - mu)) / (2 * sg * sg));
      eff += r * w;
      if (r * w > best.mm) best = { lag: lag, mm: r * w, raw: r, date: days.date[j] };
    }
    var rainF = 1 - Math.exp(-eff / p.halfSat);

    // Conditions des 5 derniers jours : douceur et gel.
    var t5 = [], frost = 0;
    for (var q = Math.max(0, k - 4); q <= k; q++) {
      t5.push((days.tmin[q] + days.tmax[q]) / 2 + dT);
      if (days.tmin[q] + dT <= 0) frost++;
    }
    var tm5 = mean(t5);
    var soilT = soilTemp(days, k, dT), soilF = soilFactor(soilT, p), heatF = heatFactor(tm5, p);
    var tempF = heatF * soilF * Math.pow(p.frostPenalty || 0.5, frost);

    // Saison : calendrier propre à l'espèce s'il est fourni, sinon celui des cèpes.
    var seasonF = opts.months ? seasonFromMonths(opts.months, days.date[k], opts.elevation, p) : seasonFactor(days.date[k], opts.elevation, p);

    // Pluie tombée récemment (7 derniers jours), utile pour annoncer la suite.
    var recent = 0;
    for (var z = Math.max(0, k - 7); z < k; z++) recent += days.rain[z] || 0;

    // Réglages propres à certaines espèces (absents pour « Cèpes (tous) », donc sans effet sur eux) :
    // altitude préférée, et besoin d'une humidité entretenue sur la dernière semaine.
    var altF = altitudeFactor(opts.elevation, opts.altMin, opts.altMax);
    var moistF = p.recentHalf ? 0.5 + 0.5 * (1 - Math.exp(-recent / p.recentHalf)) : 1;

    var s = rainF * tempF * seasonF;
    if (altF !== 1) s *= altF;
    if (moistF !== 1) s *= moistF;
    return {
      score: Math.round(100 * s),
      parts: {
        effRain: eff, rainF: rainF, mu: mu, tLag: tLag,
        tMean5: tm5, frost: frost, tempF: tempF,
        seasonF: seasonF, recentRain: recent, trigger: best,
        tLow: p.tLow, tHigh: p.tHigh, altF: altF, moistF: moistF, seasonShift: seasonShift(opts.elevation, p),
        soilT: soilT, soilF: soilF, heatF: heatF,
        soilFull: p.tLow + p.soilMargin + (p.soilShift || 0), soilZero: p.tColdZero + p.soilMargin + (p.soilShift || 0)
      }
    };
  }

  // Applique l'essence (null = inconnue : on laisse le score météo seul).
  function withEssence(score, essenceKey) {
    var e = ESSENCES[essenceKey];
    if (!e || e.w === null) return score;
    return Math.round(score * e.w);
  }

  /* Exposition et pente (relief IGN au point exact).
   * topo = { slope: degrés, aspect: degrés depuis le nord, vers où descend le versant }.
   * Par temps chaud, un versant sud sèche vite et un versant nord garde l'humidité ;
   * quand il fait frais, c'est l'inverse : le sud reste tiède, le nord se refroidit.
   * Effet nul sur terrain plat, plein dès 20° de pente, au plus ±15 %.
   * Une pente très forte (plus de 30°) draine vite : −8 %. */
  var DIRS = ["nord", "nord-est", "est", "sud-est", "sud", "sud-ouest", "ouest", "nord-ouest"];
  function aspectLabel(aspect) { return DIRS[Math.round(((aspect % 360) + 360) % 360 / 45) % 8]; }
  function exposureFactor(topo, tMean5) {
    if (!topo || topo.slope == null || isNaN(tMean5)) return { f: 1, south: 0, heat: 0, strength: 0 };
    var strength = topo.slope < 3 ? 0 : Math.min(1, topo.slope / 20);
    var south = Math.cos((topo.aspect - 180) * Math.PI / 180);       // +1 sud, −1 nord
    var heat = Math.max(-1, Math.min(1, (tMean5 - 13) / 5));         // +1 chaud (18 °C), −1 frais (8 °C)
    var f = 1 - 0.15 * heat * south * strength;
    if (topo.slope > 30) f *= 0.92;
    return { f: f, south: south, heat: heat, strength: strength };
  }
  function withTopo(score, topo, tMean5) {
    return Math.max(0, Math.min(100, Math.round(score * exposureFactor(topo, tMean5).f)));
  }
  // Indice complet d'un coin : météo, puis exposition, puis essence.
  function scoreSpot(days, k, params, opts) {
    var r = scoreDay(days, k, params, opts);
    if (!r) return null;
    var withExpo = withTopo(r.score, opts && opts.topo, r.parts.tMean5);
    return { score: withEssence(withExpo, opts && opts.essence), weather: r.score, expo: exposureFactor(opts && opts.topo, r.parts.tMean5), parts: r.parts };
  }

  /* ---------- Espèces ----------
   * « cepes » est le modèle d'origine, utilisé tel quel (aucun réglage d'espèce).
   * Les autres fiches sont des estimations de départ tirées des connaissances
   * mycologiques courantes ; le carnet sert à les caler, espèce par espèce.
   * months : poids de janvier à décembre. essences : poids par type de forêt
   * (absent = 0, essence inconnue = pas d'effet). Toutes partagent la même météo. */
  var SPECIES = {
    cepes: { label: "Cèpes (tous)", short: "cèpes", group: "Cèpes",
      warn: "Écarte le bolet amer (réseau brun sur le pied, chair amère) et les bolets à pores rouges." },
    aestivalis: { label: "Cèpe d'été", latin: "Boletus aestivalis", short: "cèpes d'été", group: "Détail des cèpes",
      params: { tLow: 14, tHigh: 24, tColdZero: 8, tHotZero: 30, lagBase: 8, halfSat: 22 },
      months: [0, 0, 0, 0.05, 0.4, 0.9, 1, 1, 0.7, 0.3, 0.05, 0], altMax: 1100,
      essences: { chene: 1, hetre: 1, chataignier: 0.9, feuillus: 0.85, mixte: 0.6, sapin: 0.2, pin: 0.2, robinier: 0.1, lande: 0.1 },
      warn: "Écarte le bolet amer (réseau brun sur le pied, chair amère)." },
    aereus: { label: "Tête de nègre", latin: "Boletus aereus", short: "têtes de nègre", group: "Détail des cèpes",
      params: { tLow: 15, tHigh: 25, tColdZero: 9, tHotZero: 31, lagBase: 8, halfSat: 25 },
      months: [0, 0, 0, 0, 0.05, 0.4, 0.8, 1, 1, 0.7, 0.2, 0], altMax: 800,
      essences: { chene: 1, chataignier: 1, feuillus: 0.8, hetre: 0.5, mixte: 0.5, pin: 0.2, lande: 0.15, robinier: 0.1, sapin: 0.05 },
      warn: "Écarte le bolet amer et les bolets à pores rouges." },
    edulis: { label: "Cèpe de Bordeaux", latin: "Boletus edulis", short: "cèpes de Bordeaux", group: "Détail des cèpes",
      params: { tLow: 9, tHigh: 18, tColdZero: 3, tHotZero: 26, lagBase: 10, halfSat: 22 },
      months: [0.02, 0, 0, 0.02, 0.1, 0.3, 0.4, 0.7, 1, 1, 0.7, 0.15],
      essences: { chene: 1, chataignier: 1, hetre: 1, feuillus: 0.85, mixte: 0.85, sapin: 0.8, pin: 0.7, lande: 0.15, robinier: 0.15, peuplier: 0.05 },
      warn: "Écarte le bolet amer (réseau brun sur le pied, chair amère)." },
    pinophilus: { label: "Cèpe des pins", latin: "Boletus pinophilus", short: "cèpes des pins", group: "Détail des cèpes",
      params: { tLow: 7, tHigh: 16, tColdZero: 2, tHotZero: 24, lagBase: 11, halfSat: 22 },
      months: [0, 0, 0, 0.05, 0.2, 0.3, 0.3, 0.5, 0.9, 1, 0.8, 0.2],
      essences: { pin: 1, sapin: 1, mixte: 0.8, hetre: 0.3, chene: 0.2, chataignier: 0.2, feuillus: 0.2, lande: 0.2 },
      warn: "Écarte le bolet amer (réseau brun sur le pied, chair amère)." },
    girolle: { label: "Girolle", latin: "Cantharellus cibarius", short: "girolles", group: "Autres espèces",
      params: { tLow: 12, tHigh: 22, tColdZero: 6, tHotZero: 28, lagBase: 12, sigma: 4.5, sigmaRise: 3, halfSat: 35, recentHalf: 8, lagMax: 18 },
      months: [0, 0, 0, 0, 0.15, 0.6, 0.9, 1, 1, 0.9, 0.5, 0.1],
      essences: { chene: 1, chataignier: 1, hetre: 1, feuillus: 0.9, mixte: 0.9, sapin: 0.8, pin: 0.6, lande: 0.2, robinier: 0.1 },
      warn: "Sosies : fausse girolle (vraies lames fines) et clitocybe de l'olivier, toxique, en touffes sur souches ou racines." },
    trompette: { label: "Trompette de la mort", latin: "Craterellus cornucopioides", short: "trompettes", group: "Autres espèces",
      params: { tLow: 6, tHigh: 15, tColdZero: 1, tHotZero: 22, lagBase: 13, sigma: 4, sigmaRise: 3, halfSat: 40, recentHalf: 10, frostPenalty: 0.7, lagMax: 18 },
      months: [0.05, 0, 0, 0, 0, 0.05, 0.2, 0.4, 0.7, 1, 1, 0.5],
      essences: { hetre: 1, chene: 0.8, feuillus: 0.8, mixte: 0.7, chataignier: 0.6, sapin: 0.4, pin: 0.1 },
      warn: "Peu de sosies dangereux, mais vérifie chaque exemplaire." },
    hydne: { label: "Pied de mouton", latin: "Hydnum repandum", short: "pieds de mouton", group: "Autres espèces",
      params: { tLow: 5, tHigh: 15, tColdZero: 0, tHotZero: 23, lagBase: 12, sigma: 4.5, sigmaRise: 3, halfSat: 30, frostPenalty: 0.8, lagMax: 18 },
      months: [0.1, 0, 0, 0, 0, 0.1, 0.3, 0.6, 0.9, 1, 1, 0.5],
      essences: { hetre: 1, chene: 0.9, sapin: 0.9, feuillus: 0.9, mixte: 0.9, chataignier: 0.8, pin: 0.6 },
      warn: "Aiguillons sous le chapeau, peu de sosies dangereux. En cas de doute, fais vérifier." }
  };
  var SPECIES_ORDER = ["cepes", "aestivalis", "aereus", "edulis", "pinophilus", "girolle", "trompette", "hydne"];

  function speciesOpts(key, opts) {
    var sp = SPECIES[key];
    return Object.assign({}, opts || {}, { months: sp.months, altMin: sp.altMin, altMax: sp.altMax });
  }
  // Score météo d'une espèce. Pour « cepes », c'est exactement scoreDay d'origine.
  function scoreSpecies(days, k, key, userParams, opts) {
    var sp = SPECIES[key];
    if (!sp || !sp.params) return scoreDay(days, k, userParams, opts);
    return scoreDay(days, k, Object.assign({}, sp.params, userParams || {}), speciesOpts(key, opts));
  }
  function withSpeciesEssence(score, key, essenceKey) {
    var sp = SPECIES[key];
    if (!sp || !sp.essences) return withEssence(score, essenceKey);
    if (!essenceKey || essenceKey === "inconnu" || !ESSENCES[essenceKey]) return score;
    return Math.round(score * (sp.essences[essenceKey] || 0));
  }
  // Indice complet d'un coin pour une espèce. Pour « cepes », c'est exactement scoreSpot d'origine.
  function scoreSpotSpecies(days, k, key, userParams, opts) {
    var sp = SPECIES[key];
    if (!sp || !sp.params) return scoreSpot(days, k, userParams, opts);
    var r = scoreSpecies(days, k, key, userParams, opts);
    if (!r) return null;
    var withExpo = withTopo(r.score, opts && opts.topo, r.parts.tMean5);
    return { score: withSpeciesEssence(withExpo, key, opts && opts.essence), weather: r.score, expo: exposureFactor(opts && opts.topo, r.parts.tMean5), parts: r.parts };
  }
  function calibrateSpecies(samples, key) {
    var sp = SPECIES[key];
    if (!sp || !sp.params) return calibrate(samples, {});
    var r = calibrate(samples, sp.params, { months: sp.months, altMin: sp.altMin, altMax: sp.altMax });
    r.base = Object.assign({}, DEFAULTS, sp.params);
    return r;
  }

  // Score sur toute la série (pour un graphique ou le curseur des jours).
  function scoreSeries(days, params, opts) {
    var out = [];
    for (var k = 0; k < days.date.length; k++) {
      var r = scoreDay(days, k, params, opts);
      out.push(r ? r.score : null);
    }
    return out;
  }

  /* Calage sur le carnet.
   * samples : [{ days, k, elevation, found: true|false }]
   * Avec uniquement des trouvailles, on ne cale que le délai (sinon le modèle
   * apprendrait simplement à tout noter haut). Avec au moins deux sorties
   * bredouilles, on cale aussi le seuil de pluie. */
  function calibrate(samples, base, extraOpts) {
    var so = function (smp) { return extraOpts ? Object.assign({ elevation: smp.elevation }, extraOpts) : { elevation: smp.elevation }; };
    base = Object.assign({}, DEFAULTS, base || {});
    var centerSat = base.halfSat;   // valeur de départ de l'espèce (22 mm pour les cèpes)
    var pos = samples.filter(function (s) { return s.found; });
    var neg = samples.filter(function (s) { return !s.found; });
    if (!pos.length) return { params: base, fitted: [], note: "Ajoute au moins une trouvaille." };
    var shifts = [-4, -3, -2, -1, 0, 1, 2, 3, 4];
    var sats = neg.length >= 2 ? [12, 16, 22, 30, 40, 55] : [base.halfSat];
    var els = samples.map(function (s) { return s.elevation || 0; });
    var altOk = neg.length >= 2 && Math.max.apply(null, els) - Math.min.apply(null, els) >= 400;
    var alts = altOk ? [-2, -1, 0, 1, 2, 3] : [base.soilShift || 0];
    var bestScore = -Infinity, best = null;
    shifts.forEach(function (sh) {
      sats.forEach(function (hs) { alts.forEach(function (as) {
        var p = Object.assign({}, base, { lagShift: sh, halfSat: hs, soilShift: as });
        var sp = mean(pos.map(function (s) { return scoreDay(s.days, s.k, p, so(s)).score; }));
        var sn = neg.length ? mean(neg.map(function (s) { return scoreDay(s.days, s.k, p, so(s)).score; })) : 0;
        // Petite pénalité pour rester près des valeurs par défaut.
        var obj = sp - sn - 1.5 * Math.abs(sh) - 0.05 * Math.abs(hs - centerSat) - 0.8 * Math.abs(as - (base.soilShift || 0));
        if (obj > bestScore) { bestScore = obj; best = { lagShift: sh, halfSat: hs, soilShift: as, meanPos: sp, meanNeg: sn }; }
      }); });
    });
    var fitted = ["lagShift"];
    if (sats.length > 1) fitted.push("halfSat");
    if (alts.length > 1) fitted.push("soilShift");
    return {
      params: Object.assign({}, base, { lagShift: best.lagShift, halfSat: best.halfSat, soilShift: best.soilShift }),
      fitted: fitted,
      meanPos: best.meanPos, meanNeg: best.meanNeg,
      note: neg.length >= 2 ? "" : "Ajoute aussi tes sorties bredouilles : sans elles, seul le délai peut être calé."
    };
  }

  root.CepeModel = {
    DEFAULTS: DEFAULTS, ESSENCES: ESSENCES,
    classifyEssence: classifyEssence, scoreDay: scoreDay, scoreSeries: scoreSeries,
    withEssence: withEssence, seasonFactor: seasonFactor, seasonShift: seasonShift, soilTemp: soilTemp, calibrate: calibrate,
    exposureFactor: exposureFactor, withTopo: withTopo, scoreSpot: scoreSpot, aspectLabel: aspectLabel,
    SPECIES: SPECIES, SPECIES_ORDER: SPECIES_ORDER, scoreSpecies: scoreSpecies, scoreSpotSpecies: scoreSpotSpecies,
    withSpeciesEssence: withSpeciesEssence, calibrateSpecies: calibrateSpecies
  };
})(typeof window !== "undefined" ? window : globalThis);
