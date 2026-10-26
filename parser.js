/* Analyse d'une dictée : "Chantier Avignon, aujourd'hui, Mohamed et Karim, MYL Services,
   nettoyage fin de chantier, 150 euros chacun."
   -> { date, chantier, societe, gars:[{nom,prix,prixDefaut}], travaux } */
(function (root) {
  'use strict';

  const MOIS = { janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, aout: 8,
    septembre: 9, octobre: 10, novembre: 11, decembre: 12 };
  const JOURS = { dimanche: 0, lundi: 1, mardi: 2, mercredi: 3, jeudi: 4, vendredi: 5, samedi: 6 };
  const NOMBRES = { un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8,
    neuf: 9, dix: 10, onze: 11, douze: 12, treize: 13, quatorze: 14, quinze: 15, seize: 16,
    vingt: 20, vingts: 20, trente: 30, quarante: 40, cinquante: 50, soixante: 60 };
  const MONNAIE = new Set(['euros', 'euro', '€', 'eur', 'balles']);
  const CHACUN = new Set(['chacun', 'chacune', 'chaque']);
  const PAR_PERS = new Set(['personne', 'tete', 'gars', 'ouvrier', 'homme', 'jour', 'journee']);
  const LIKE_MYL = new Set(['myl', 'mil', 'mile', 'mille', 'emile', 'emil', 'm', 'y', 'i', 'l', 'el', 'aime',
    'mylle', 'miel', 'mail', 'my', 'mi', 'il', 'hil', 'elle', 'emy', 'me']);
  const LIKE_LCQ = new Set(['lcq', 'l', 'c', 'q', 'elle', 'el', 'ce', 'se', 'ses', 'ces', 'cu', 'cul', 'qu',
    "qu'", 'k', 'lc', 'cq', 'elsa', 'sec', 'c\'est', 'cest', 'ceci', 'cecu', 'lcc', 'lsq']);
  const DEBUT_INUTILE = new Set(['et', 'avec', 'pour', 'puis', 'ensuite', 'alors', 'donc', 'aussi', 'a', 'au', 'aux',
    'chez', 'sur', 'le', 'la', 'les', "l'", 'de', 'du', 'des', "d'", 'ce', 'cet', 'cette', 'matin', 'soir',
    'on', 'nous', 'ils', 'il', 'elles', 'fait', 'ont', 'avons', 'travaux', 'realises', 'realise', 'intervention',
    'societe', 'chantier', 'date', 'prix', 'gars', 'les gars', 'qui', 'ont', 'ete', 'en', 'tout', 'total', 'pas']);
  const FIN_INUTILE = new Set(['et', 'avec', 'pour', 'a', 'au', 'aux', 'chez', 'sur', 'le', 'la', 'les', "l'", 'de',
    'du', 'des', "d'", 'par', 'on', 'ils', 'il', 'ce', 'cet', 'cette', 'en', 'societe', 'date', 'prix', 'pour un']);

  function norm(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/’/g, "'");
  }

  function tokenize(text) {
    const t = String(text || '')
      .replace(/’/g, "'")
      .replace(/€/g, ' € ')
      .replace(/aujourd'\s*hui/gi, 'aujourdhui')
      .replace(/(^|[\s,.;])(d|l|j|qu|c|s|n)'(?=\S)/gi, "$1$2' ");
    const out = [];
    for (const piece of t.split(/\s+/)) {
      if (!piece) continue;
      const m = piece.match(/^(.*?)([,.;:!?…]*)$/);
      const raw = m[1];
      const punct = m[2];
      let n = norm(raw);
      if (!/^\d+[.,]\d+$/.test(n)) n = n.replace(/[^a-z0-9'€/-]/g, '');
      n = n.replace(/^-+|-+$/g, '');
      if (!n) { if (out.length) out[out.length - 1].punct += punct; continue; }
      out.push({ raw, punct, n, used: false });
    }
    return out;
  }

  function lev(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 9;
    const d = [];
    for (let i = 0; i <= a.length; i++) d[i] = [i];
    for (let j = 0; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
    }
    return d[a.length][b.length];
  }

  function sameWord(tok, ref) {
    if (tok === ref) return true;
    if (ref.length >= 5 && lev(tok, ref) <= 1) return true;
    if (ref.length >= 8 && lev(tok, ref) <= 2) return true;
    return false;
  }

  function phraseTokens(s) {
    return tokenize(s).map(t => t.n).filter(Boolean);
  }

  // La séquence `words` commence-t-elle au token i (tokens libres uniquement) ?
  function matchAt(toks, i, words) {
    if (!words.length || i + words.length > toks.length) return false;
    for (let k = 0; k < words.length; k++) {
      const t = toks[i + k];
      if (t.used || !sameWord(t.n, words[k])) return false;
    }
    return true;
  }

  function use(toks, i, len) { for (let k = i; k < i + len; k++) toks[k].used = true; }

  function ymd(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  // ---------- Nombres ----------
  function parseNumberAt(toks, i) {
    const t = toks[i];
    if (!t || t.used) return null;
    if (/^\d+([.,]\d+)?$/.test(t.n)) {
      let value = parseFloat(t.n.replace(',', '.'));
      let len = 1;
      const nx = toks[i + 1];
      if (/^\d{1,3}$/.test(t.n) && nx && !nx.used && /^\d{3}$/.test(nx.n)) { value = value * 1000 + parseInt(nx.n, 10); len = 2; }
      return { value, len, digits: true };
    }
    // Nombres en lettres : "cent cinquante", "deux cents", "quatre-vingt-dix"
    const words = [];
    const owner = [];
    for (let k = i; k < toks.length && k < i + 8; k++) {
      if (toks[k].used) break;
      const parts = toks[k].n.split('-');
      const isNum = parts.every(p => p in NOMBRES || p === 'cent' || p === 'cents' || p === 'mille' || p === 'et');
      if (!isNum) break;
      parts.forEach(p => { words.push(p); owner.push(k); });
    }
    if (!words.length) return null;
    let total = 0, cur = 0, last = -1, any = false;
    for (let w = 0; w < words.length; w++) {
      const p = words[w];
      if (p === 'et') { if (!any) break; continue; }
      if (p === 'cent' || p === 'cents') { cur = (cur || 1) * 100; }
      else if (p === 'mille') { total += (cur || 1) * 1000; cur = 0; }
      else if ((p === 'vingt' || p === 'vingts') && cur % 100 === 4) { cur = cur - 4 + 80; }
      else { cur += NOMBRES[p]; }
      any = true;
      last = owner[w];
    }
    if (!any) return null;
    return { value: total + cur, len: last - i + 1, digits: false };
  }

  // ---------- Date ----------
  function findDate(toks, now) {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.used) continue;
      const n = t.n;
      if (n === 'aujourdhui') { use(toks, i, 1); return ymd(today); }
      if (n === 'avant-hier' || (n === 'avant' && toks[i + 1] && toks[i + 1].n === 'hier')) {
        use(toks, i, n === 'avant' ? 2 : 1);
        return ymd(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 2));
      }
      if (n === 'hier') { use(toks, i, 1); return ymd(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)); }
      if ((n === 'ce' || n === 'cet') && toks[i + 1] && /^(matin|soir|apres-midi|aprem)$/.test(toks[i + 1].n)) {
        use(toks, i, 2); return ymd(today);
      }
      if (n in JOURS) {
        // Pas de "lundi prochain" : on ne note que le passé.
        const diff = (today.getDay() - JOURS[n] + 7) % 7;
        let len = 1;
        if (toks[i + 1] && /^(dernier|passe)$/.test(toks[i + 1].n)) len = 2;
        // "lundi 12 octobre" : on laisse la date complète gagner
        const nx = toks[i + 1];
        if (nx && /^\d{1,2}$/.test(nx.n) && toks[i + 2] && toks[i + 2].n in MOIS) { use(toks, i, 1); continue; }
        use(toks, i, len);
        return ymd(new Date(today.getFullYear(), today.getMonth(), today.getDate() - diff));
      }
      let m = n.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
      if (m) {
        let y = m[3] ? parseInt(m[3], 10) : today.getFullYear();
        if (y < 100) y += 2000;
        const d = new Date(y, parseInt(m[2], 10) - 1, parseInt(m[1], 10));
        if (!m[3] && d > today) d.setFullYear(y - 1);
        use(toks, i, 1);
        if (i > 0 && toks[i - 1].n === 'le') use(toks, i - 1, 1);
        return ymd(d);
      }
      const day = /^(\d{1,2}|1er|premier)$/.test(n) ? (n === '1er' || n === 'premier' ? 1 : parseInt(n, 10)) : null;
      if (day && toks[i + 1] && toks[i + 1].n in MOIS) {
        const mo = MOIS[toks[i + 1].n];
        let len = 2;
        let y = today.getFullYear();
        let explicitYear = false;
        if (toks[i + 2] && /^\d{4}$/.test(toks[i + 2].n)) { y = parseInt(toks[i + 2].n, 10); len = 3; explicitYear = true; }
        const d = new Date(y, mo - 1, day);
        if (!explicitYear && d > today) d.setFullYear(y - 1);
        use(toks, i, len);
        if (i > 0 && toks[i - 1].n === 'le') use(toks, i - 1, 1);
        return ymd(d);
      }
    }
    return null;
  }

  // ---------- Société ----------
  function findSociete(toks) {
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.used) continue;
      if (t.n === 'myl') {
        use(toks, i, 1);
        if (toks[i + 1] && /^services?$/.test(toks[i + 1].n)) use(toks, i + 1, 1);
        return 'MYL Services';
      }
      if (t.n === 'lcq') {
        use(toks, i, 1);
        if (toks[i + 1] && toks[i + 1].n === 'batiment') use(toks, i + 1, 1);
        return 'LCQ Bâtiment';
      }
      const isServices = /^services?$/.test(t.n);
      const isBatiment = t.n === 'batiment';
      if (isServices || isBatiment) {
        const like = isServices ? LIKE_MYL : LIKE_LCQ;
        let k = i - 1;
        while (k >= 0 && i - k <= 4 && !toks[k].used && like.has(toks[k].n)) k--;
        if (k < i - 1) {
          use(toks, k + 1, i - k);
          return isServices ? 'MYL Services' : 'LCQ Bâtiment';
        }
      }
    }
    return null;
  }

  // ---------- Gars ----------
  function findGars(toks, garsList) {
    const firstCount = {};
    garsList.forEach(g => { const f = phraseTokens(g.nom)[0]; if (f) firstCount[f] = (firstCount[f] || 0) + 1; });
    const variants = [];
    garsList.forEach(g => {
      const full = phraseTokens(g.nom);
      if (full.length) variants.push({ g, words: full });
      if (full.length > 1 && firstCount[full[0]] === 1) variants.push({ g, words: [full[0]] });
    });
    variants.sort((a, b) => b.words.length - a.words.length);
    const mentions = [];
    const occurrences = [];
    for (let i = 0; i < toks.length; i++) {
      for (const v of variants) {
        if (matchAt(toks, i, v.words)) {
          use(toks, i, v.words.length);
          let m = mentions.find(x => x.g === v.g);
          if (!m) { m = { g: v.g, idx: i }; mentions.push(m); }
          occurrences.push({ idx: i, m });
          i += v.words.length - 1;
          break;
        }
      }
    }
    mentions.occurrences = occurrences;
    return mentions;
  }

  // ---------- Prix ----------
  function findAmounts(toks, mentions) {
    const garsAt = new Map((mentions.occurrences || []).map(o => [o.idx, o.m]));
    const amounts = [];
    for (let i = 0; i < toks.length; i++) {
      const num = parseNumberAt(toks, i);
      if (!num) continue;
      let j = i + num.len;
      let currency = false;
      if (toks[j] && !toks[j].used && MONNAIE.has(toks[j].n)) { currency = true; j++; }
      let mode = 'simple';
      let target = null;
      const nx = toks[j], nx2 = toks[j + 1];
      if (nx && !nx.used && CHACUN.has(nx.n)) { mode = 'chacun'; j++; }
      else if (nx && !nx.used && nx.n === 'par' && nx2 && PAR_PERS.has(nx2.n)) { mode = 'chacun'; j += 2; }
      else if (nx && !nx.used && (nx.n === 'total' || nx.n === 'tout')) { mode = 'total'; j++; }
      else if (nx && nx2 && !nx.used && (nx.n === 'au' || nx.n === 'en') && (nx2.n === 'total' || nx2.n === 'tout')) { mode = 'total'; j += 2; }
      else if (nx && nx2 && !nx.used && (nx.n === 'pour' || nx.n === 'a') && /^(les|tous|deux|trois|quatre)$/.test(nx2.n) && !garsAt.has(j + 1)) {
        mode = 'total'; j += 2;
        if (toks[j] && /^(deux|trois|quatre|gars)$/.test(toks[j].n)) j++;
      } else if (nx && !nx.used && (nx.n === 'pour' || nx.n === 'a') && garsAt.has(j + 1)) {
        target = garsAt.get(j + 1); j++;
      }
      // Un nombre "nu" n'est un prix que s'il suit directement un gars ou précède "chacun"/"pour X".
      let prevGars = null;
      for (let k = i - 1; k >= 0 && k >= i - 3; k--) {
        if (garsAt.has(k)) { prevGars = garsAt.get(k); break; }
        if (toks[k].used) break;
        if (!/^(a|pour|prix|au|de)$/.test(toks[k].n)) break;
      }
      const accept = currency || mode !== 'simple' || target || (num.digits && prevGars);
      if (!accept || num.value <= 0 || num.value > 100000) continue;
      use(toks, i, j - i);
      // "à 150 euros" / "pour 150 euros" / "prix 150"
      if (i > 0 && !toks[i - 1].used && /^(a|pour|prix|de)$/.test(toks[i - 1].n)) use(toks, i - 1, 1);
      amounts.push({ value: num.value, idx: i, mode, target });
      i = j - 1;
    }
    return amounts;
  }

  function assignPrices(mentions, amounts) {
    const prix = new Map();
    let prevIdx = -1;
    for (const a of amounts) {
      let group;
      if (a.target) group = [a.target];
      else {
        group = mentions.filter(m => m.idx > prevIdx && m.idx < a.idx);
        if (!group.length) group = mentions.filter(m => !prix.has(m.g));
        if (!group.length) group = mentions.slice();
      }
      if (a.mode === 'total' && group.length) {
        const part = Math.round((a.value / group.length) * 100) / 100;
        group.forEach(m => prix.set(m.g, part));
      } else {
        group.forEach(m => prix.set(m.g, a.value));
      }
      prevIdx = a.idx;
    }
    return mentions.map(m => {
      const has = prix.has(m.g);
      return { nom: m.g.nom, prix: has ? prix.get(m.g) : (Number(m.g.prix) || 0), prixDefaut: !has };
    });
  }

  // ---------- Chantier ----------
  function findChantier(toks, chantiers) {
    const villeCount = {};
    chantiers.forEach(c => { const v = norm(c.ville).trim(); if (v) villeCount[v] = (villeCount[v] || 0) + 1; });
    const cands = [];
    chantiers.forEach((c, order) => {
      const nw = phraseTokens(c.nom);
      const vw = phraseTokens(c.ville);
      if (nw.length) cands.push({ c, words: nw, type: 'nom', order });
      if (vw.length && (nw.join(' ') !== vw.join(' '))) cands.push({ c, words: vw, type: 'ville', order });
    });
    cands.sort((a, b) => (b.type === 'nom') - (a.type === 'nom') || b.words.length - a.words.length || a.order - b.order);
    for (const cand of cands) {
      for (let i = 0; i < toks.length; i++) {
        if (!matchAt(toks, i, cand.words)) continue;
        use(toks, i, cand.words.length);
        if (i > 0 && !toks[i - 1].used && toks[i - 1].n === 'chantier') use(toks, i - 1, 1);
        // On retire aussi la ville du même chantier si elle est dite à côté
        const vw = phraseTokens(cand.c.ville);
        if (cand.type === 'nom' && vw.length) {
          for (let k = 0; k < toks.length; k++) {
            if (matchAt(toks, k, vw)) {
              use(toks, k, vw.length);
              if (k > 0 && /^(a|au|sur|de)$/.test(toks[k - 1].n) && !toks[k - 1].used) use(toks, k - 1, 1);
              break;
            }
          }
        }
        return { nom: cand.c.nom, ville: cand.c.ville || '', nouveau: false };
      }
    }
    // Chantier inconnu : "chantier Xxx"
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.used || t.n !== 'chantier') continue;
      const prev = toks[i - 1];
      if (prev && /^(de|du|d'|fin|debut)$/.test(prev.n)) continue;
      let k = i + 1;
      while (toks[k] && !toks[k].used && /^(de|du|d'|des)$/.test(toks[k].n)) k++;
      const start = k;
      const first = toks[k];
      if (!first || first.used || /^(et|avec|pour|on|nous|ils|il|j'|le|les|un|une|ce|a|au)$/.test(first.n) && !/^[A-ZÀ-Ý]/.test(toks[k + 1] ? toks[k + 1].raw : '')) continue;
      const parts = [];
      for (; toks[k] && parts.length < 4; k++) {
        const tk = toks[k];
        if (tk.used) break;
        const isFirst = parts.length === 0;
        const isArticle = /^(la|le|les|l')$/.test(tk.n) && isFirst;
        const isLink = /^(en|sur|de|du|les|la)$/.test(tk.n) && !isFirst && toks[k + 1] && /^[A-ZÀ-Ý]/.test(toks[k + 1].raw);
        const isCap = /^[A-ZÀ-Ý0-9]/.test(tk.raw);
        if (!(isFirst || isArticle || isLink || isCap || /^(la|le|les|l')$/.test(toks[k - 1].n) && parts.length === 1)) break;
        parts.push(tk);
        if (tk.punct) { k++; break; }
      }
      if (!parts.length) continue;
      use(toks, i, 1);
      use(toks, start, parts.length);
      const nom = parts.map(p => p.raw.replace(/'$/, "'")).join(' ').replace(/' /g, "'")
        .replace(/(^|[\s'-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
      return { nom, ville: '', nouveau: true };
    }
    return null;
  }

  // ---------- Travaux (tout le reste) ----------
  function buildTravaux(toks) {
    const segments = [];
    let cur = [];
    toks.forEach(t => {
      if (t.used) { if (cur.length) segments.push(cur); cur = []; }
      else { cur.push(t); if (/[.;:!?]/.test(t.punct)) { segments.push(cur); cur = []; } }
    });
    if (cur.length) segments.push(cur);
    const parts = [];
    for (let seg of segments) {
      let changed = true;
      while (changed && seg.length) {
        changed = false;
        if (DEBUT_INUTILE.has(seg[0].n)) { seg = seg.slice(1); changed = true; }
        if (seg.length && FIN_INUTILE.has(seg[seg.length - 1].n)) { seg = seg.slice(0, -1); changed = true; }
      }
      if (!seg.length) continue;
      if (seg.every(t => /^(et|a|au|de|euros?|chacun)$/.test(t.n))) continue;
      let s = seg.map((t, i) => t.raw + (i < seg.length - 1 ? t.punct : '')).join(' ').replace(/' /g, "'");
      s = s.replace(/^[\s,;:.-]+|[\s,;:-]+$/g, '');
      if (s) parts.push(s);
    }
    let out = parts.join(', ');
    if (out) out = out.charAt(0).toUpperCase() + out.slice(1);
    return out;
  }

  function parseDictee(text, opts) {
    opts = opts || {};
    const now = opts.now || new Date();
    const garsList = opts.gars || [];
    const chantiers = opts.chantiers || [];
    const toks = tokenize(text);
    const date = findDate(toks, now);
    const societe = findSociete(toks);
    const mentions = findGars(toks, garsList);
    const amounts = findAmounts(toks, mentions);
    const chantier = findChantier(toks, chantiers);
    const gars = assignPrices(mentions, amounts);
    // Un prix dit sans aucun gars reconnu : on le garde pour l'afficher
    const prixSeul = !mentions.length && amounts.length ? amounts[0].value : null;
    const travaux = buildTravaux(toks);
    return { date: date || ymd(now), dateTrouvee: !!date, chantier, societe, gars, prixSeul, travaux };
  }

  const api = { parseDictee, norm, tokenize };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Dictee = api;
})(typeof window !== 'undefined' ? window : globalThis);
