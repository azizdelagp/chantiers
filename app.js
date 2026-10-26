/* Suivi chantiers MYL Services / LCQ Bâtiment */
(function () {
  'use strict';

  const CFG = window.APP_CONFIG || {};
  const DEMO = !CFG.API_URL || /[?&]demo/.test(location.search);
  const SOCIETES = ['MYL Services', 'LCQ Bâtiment'];

  // ---------------------------------------------------------------- stockage local
  const LS = {
    get(k, d) { try { const v = localStorage.getItem('ch_' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('ch_' + k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  };

  // File d'attente des envois (IndexedDB : garde les photos même sans réseau)
  const Outbox = {
    db: null,
    open() {
      if (this.db) return Promise.resolve(this.db);
      return new Promise((res, rej) => {
        const r = indexedDB.open('chantiers', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('outbox', { keyPath: 'id' });
        r.onsuccess = () => { this.db = r.result; res(this.db); };
        r.onerror = () => rej(r.error);
      });
    },
    tx(mode, fn) {
      return this.open().then(db => new Promise((res, rej) => {
        const t = db.transaction('outbox', mode);
        const out = fn(t.objectStore('outbox'));
        t.oncomplete = () => res(out && out.result);
        t.onerror = () => rej(t.error);
      }));
    },
    all() { return this.tx('readonly', s => s.getAll()).catch(() => []); },
    put(item) { return this.tx('readwrite', s => s.put(item)); },
    del(id) { return this.tx('readwrite', s => s.delete(id)); }
  };

  // ---------------------------------------------------------------- serveur
  const Demo = {
    db() {
      return LS.get('demoDb', null) || {
        interventions: [],
        chantiers: [{ nom: 'Résidence Les Pins', ville: 'Avignon' }],
        gars: [{ nom: 'Mohamed', prix: 150 }, { nom: 'Karim', prix: 150 }]
      };
    },
    save(db) { return LS.set('demoDb', db); },
    ensure(list, nom, extra) {
      if (nom && !list.some(x => x.nom.toLowerCase() === nom.toLowerCase())) list.push(Object.assign({ nom }, extra));
    },
    get() { return Promise.resolve(Object.assign({ ok: true, sheetUrl: '' }, this.db())); },
    post(b) {
      const db = this.db();
      if (b.action === 'add') {
        if (!db.interventions.some(i => i.id === b.id)) {
          this.ensure(db.chantiers, b.chantier, { ville: b.ville || '' });
          (b.gars || []).forEach(g => this.ensure(db.gars, g.nom, { prix: g.prix }));
          db.interventions.push({
            id: b.id, date: b.date, chantier: b.chantier, ville: b.ville, societe: b.societe, gars: b.gars,
            total: (b.gars || []).reduce((s, g) => s + (+g.prix || 0), 0), travaux: b.travaux, auteur: b.auteur,
            createdAt: new Date().toISOString(),
            photos: (b.photos || []).map(p => 'data:' + p.type + ';base64,' + p.data)
          });
        }
      } else if (b.action === 'addChantier') this.ensure(db.chantiers, b.nom, { ville: b.ville || '' });
      else if (b.action === 'addGars') {
        const g = db.gars.find(x => x.nom.toLowerCase() === b.nom.toLowerCase());
        if (g) g.prix = b.prix; else db.gars.push({ nom: b.nom, prix: b.prix });
      }
      if (!this.save(db)) { // mémoire pleine (photos) : on garde sans les photos
        db.interventions.forEach(i => { i.photos = []; });
        this.save(db);
      }
      return Promise.resolve({ ok: true });
    }
  };

  async function apiGet(params) {
    if (DEMO) return Demo.get(params);
    const q = new URLSearchParams(Object.assign({}, params, { key: CFG.TEAM_KEY }));
    const r = await fetch(CFG.API_URL + '?' + q.toString());
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'Erreur serveur');
    return j;
  }

  async function apiPost(body) {
    if (DEMO) return Demo.post(body);
    // Corps en texte simple : évite le blocage "CORS" des navigateurs avec Google Apps Script
    const r = await fetch(CFG.API_URL, { method: 'POST', body: JSON.stringify(Object.assign({}, body, { key: CFG.TEAM_KEY })) });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'Erreur serveur');
    return j;
  }

  // ---------------------------------------------------------------- état
  const S = {
    data: LS.get('cache', { interventions: [], chantiers: [], gars: [], sheetUrl: '' }),
    outbox: [],
    vue: 'liste',
    filtres: LS.get('filtres', { chantier: '', gars: '', societe: '' }),
    auteur: LS.get('auteur', ''),
    syncing: false,
    horsLigne: false,
    majLe: LS.get('majLe', null),
    draft: null,
    recherche: '',
    groupe: LS.get('groupe', 'mois')
  };

  // ---------------------------------------------------------------- utilitaires
  const svg = (d, w) => '<svg class="i" viewBox="0 0 24 24" width="' + (w || 22) + '" height="' + (w || 22) + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
  const ICO = {
    micro: w => svg('<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5M8 22h8"/>', w),
    stop: w => svg('<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>', w),
    liste: w => svg('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>', w),
    reglages: w => svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>', w),
    maj: w => svg('<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8M21 3v5h-5"/>', w),
    loupe: w => svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>', w),
    photo: w => svg('<path d="M3 8a2 2 0 0 1 2-2h2l2-2h6l2 2h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="4"/>', w),
    galerie: w => svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>', w),
    fermer: w => svg('<path d="M18 6 6 18M6 6l12 12"/>', w),
    chevron: w => svg('<path d="m6 9 6 6 6-6"/>', w),
    plus: w => svg('<path d="M12 5v14M5 12h14"/>', w),
    lieu: w => svg('<path d="M12 22s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/>', w),
    partage: w => svg('<path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7M16 6l-4-4-4 4M12 2v14"/>', w)
  };
  const $ = (s, el) => (el || document).querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const euros = n => (Number(n) || 0).toLocaleString('fr-FR', { maximumFractionDigits: 2 }) + ' €';
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const sameName = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

  function dateLabel(s) {
    const p = String(s || '').split('-').map(Number);
    if (p.length !== 3 || !p[0]) return s || '';
    const d = new Date(p[0], p[1] - 1, p[2]);
    const t = new Date(); t.setHours(0, 0, 0, 0);
    const diff = Math.round((t - d) / 86400000);
    if (diff === 0) return "Aujourd'hui";
    if (diff === 1) return 'Hier';
    const o = { weekday: 'long', day: 'numeric', month: 'short' };
    if (d.getFullYear() !== t.getFullYear()) o.year = 'numeric';
    return d.toLocaleDateString('fr-FR', o);
  }

  function badge(soc) {
    if (soc === 'MYL Services') return '<span class="badge myl">MYL Services</span>';
    if (soc === 'LCQ Bâtiment') return '<span class="badge lcq">LCQ Bâtiment</span>';
    return soc ? '<span class="badge aucune">' + esc(soc) + '</span>' : '';
  }

  let toastTimer;
  function toast(msg, ms) {
    let el = $('#toast');
    if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; document.body.appendChild(el); }
    el.textContent = msg; el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), ms || 2600);
  }

  // Toutes les interventions : celles en attente d'envoi + celles du serveur
  function toutes() {
    const pend = S.outbox.map(o => Object.assign({}, o, {
      pending: true,
      total: o.gars.reduce((s, g) => s + (+g.prix || 0), 0),
      photos: o.photos.map(p => 'data:' + p.type + ';base64,' + p.data)
    }));
    const ids = new Set(pend.map(p => p.id));
    return pend.concat(S.data.interventions.filter(i => !ids.has(i.id)));
  }

  // Chantiers triés : les plus récemment utilisés d'abord
  function chantiersTries() {
    const last = {};
    toutes().forEach(i => { if (!last[i.chantier] || i.date > last[i.chantier]) last[i.chantier] = i.date; });
    const list = S.data.chantiers.slice();
    toutes().forEach(i => { if (i.chantier && !list.some(c => sameName(c.nom, i.chantier))) list.push({ nom: i.chantier, ville: i.ville || '' }); });
    return list.sort((a, b) => (last[b.nom] || '').localeCompare(last[a.nom] || '') || a.nom.localeCompare(b.nom, 'fr'));
  }

  function tousLesGars() {
    const list = S.data.gars.slice();
    S.outbox.forEach(o => o.gars.forEach(g => { if (!list.some(x => sameName(x.nom, g.nom))) list.push({ nom: g.nom, prix: g.prix }); }));
    return list.sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
  }

  // ---------------------------------------------------------------- synchro
  async function rafraichir() {
    try {
      const j = await apiGet({ action: 'all' });
      S.data = { interventions: j.interventions || [], chantiers: j.chantiers || [], gars: j.gars || [], sheetUrl: j.sheetUrl || '' };
      S.horsLigne = false;
      S.majLe = Date.now();
      LS.set('cache', S.data);
      LS.set('majLe', S.majLe);
    } catch (e) {
      S.horsLigne = true;
    }
    render();
  }

  async function envoyer() {
    if (S.syncing) return;
    S.syncing = true;
    renderEtat();
    let erreur = null;
    for (const item of S.outbox.slice()) {
      try {
        const body = Object.assign({ action: 'add' }, item);
        delete body.createdAt;
        await apiPost(body);
        await Outbox.del(item.id);
        S.outbox = S.outbox.filter(o => o.id !== item.id);
      } catch (e) { erreur = e; break; }
    }
    S.syncing = false;
    if (erreur && /Code équipe/.test(erreur.message)) toast(erreur.message, 5000);
    await rafraichir();
  }

  // ---------------------------------------------------------------- rendu
  function render() {
    const app = $('#app');
    if (!S.auteur) { app.innerHTML = vueBienvenue(); return; }
    app.innerHTML = (S.vue === 'reglages' ? vueReglages() : vueListe()) + nav();
    renderEtat();
  }

  function renderEtat() {
    const el = $('#etat');
    if (!el) return;
    let t;
    if (S.syncing) t = 'Envoi…';
    else if (S.outbox.length) t = S.outbox.length + ' en attente d\'envoi';
    else if (S.horsLigne) t = 'Hors ligne';
    else if (S.majLe) t = 'À jour';
    else t = '';
    el.textContent = t;
  }

  function nav() {
    return '<nav class="bas">' +
      '<button class="onglet ' + (S.vue === 'liste' ? 'actif' : '') + '" data-act="vue" data-vue="liste">' + ICO.liste() + 'Interventions</button>' +
      '<button class="fab" data-act="saisie" aria-label="Nouvelle intervention">' + ICO.micro(30) + '<span>Nouvelle</span></button>' +
      '<button class="onglet ' + (S.vue === 'reglages' ? 'actif' : '') + '" data-act="vue" data-vue="reglages">' + ICO.reglages() + 'Réglages</button>' +
      '</nav>';
  }

  function vueBienvenue() {
    const noms = ['Aziz'].concat(tousLesGars().map(g => g.nom).filter(n => !sameName(n, 'Aziz')));
    return '<div class="bienvenue"><img class="logo" src="icon-192.png" alt=""><h2>Qui êtes-vous ?</h2>' +
      '<p class="note">Votre prénom sera noté sur chaque intervention que vous ajoutez.</p>' +
      '<div class="chips">' + noms.map(n => '<button class="chip" data-act="moi" data-nom="' + esc(n) + '">' + esc(n) + '</button>').join('') + '</div>' +
      '<div class="bloc"><label class="t">Ou tapez votre prénom</label><input type="text" id="moi-input" autocomplete="given-name" placeholder="Prénom">' +
      '<button class="btn large" style="margin-top:10px" data-act="moi-ok">C\'est moi</button></div></div>';
  }

  function filtrer() {
    const f = S.filtres;
    const q = norm(S.recherche || '');
    return toutes().filter(i =>
      (!f.chantier || i.chantier === f.chantier) &&
      (!f.societe || i.societe === f.societe) &&
      (!f.gars || (i.gars || []).some(g => sameName(g.nom, f.gars))) &&
      (!q || norm([i.chantier, i.ville, i.travaux, i.auteur, (i.gars || []).map(g => g.nom).join(' ')].join(' ')).includes(q)));
  }

  // Avec un filtre "gars", on compte son prix à lui
  function totalDe(i) {
    const f = S.filtres;
    return f.gars ? (i.gars || []).filter(g => sameName(g.nom, f.gars)).reduce((s, g) => s + (+g.prix || 0), 0) : (+i.total || 0);
  }

  function statsHtml(list) {
    const t = new Date(); t.setHours(0, 0, 0, 0);
    const lundi = new Date(t); lundi.setDate(t.getDate() - ((t.getDay() + 6) % 7));
    const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const sem = list.filter(i => i.date >= iso(lundi));
    const mois = list.filter(i => i.date >= iso(new Date(t.getFullYear(), t.getMonth(), 1)));
    const somme = l => l.reduce((s, i) => s + totalDe(i), 0);
    const nomMois = t.toLocaleDateString('fr-FR', { month: 'long' });
    return '<div class="h-mois"><span>' + nomMois + '</span><b>' + euros(somme(mois)) + '</b></div>' +
      '<div class="h-sem"><span><b>' + euros(somme(sem)) + '</b> cette semaine</span><span><b>' + sem.length + '</b> intervention' + (sem.length > 1 ? 's' : '') + '</span></div>';
  }

  function listeHtml(list, toutesNb) {
    if (!list.length) {
      return '<div class="vide"><p class="vide-t">Aucune intervention' + (toutesNb ? ' trouvée' : ' pour l\'instant') + '</p>' +
        (toutesNb ? '<button class="btn sec" data-act="effacer">Effacer les filtres</button>' :
          '<p>Appuyez sur <b>Nouvelle</b> en bas de l\'écran, puis dites tout d\'un coup :</p><p class="exemple">« Chantier Avignon, aujourd\'hui, Mohamed et Karim, MYL Services, nettoyage fin de chantier, 150 euros chacun. »</p>') +
        '</div>';
    }
    const parMois = S.groupe !== 'chantier';
    const cle = i => parMois ? (String(i.date || '').slice(0, 7) || 'sans-date') : (i.chantier || '(sans chantier)');
    const groupes = {};
    list.forEach(i => { const k = cle(i); (groupes[k] = groupes[k] || []).push(i); });
    const tri = (a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || '');
    Object.values(groupes).forEach(g => g.sort(tri));
    const ordre = Object.keys(groupes).sort((a, b) => parMois ? b.localeCompare(a) : tri(groupes[a][0], groupes[b][0]));
    const plies = LS.get('plies', []);
    const pl = (n, mot) => n + ' ' + mot + (n > 1 ? 's' : '');
    let h = '<div class="resume"><span>' + pl(list.length, 'intervention') + ' · ' + (parMois ? ordre.length + ' mois' : pl(ordre.length, 'chantier')) + '</span>' +
      '<b>' + euros(list.reduce((s, i) => s + totalDe(i), 0)) + (S.filtres.gars ? ' pour ' + esc(S.filtres.gars) : '') + '</b></div>';
    ordre.forEach(k => {
      const g = groupes[k];
      const id = (parMois ? 'm:' : 'c:') + k;
      const plie = plies.includes(id);
      let titre, sous;
      if (parMois) {
        const [y, m] = k.split('-').map(Number);
        titre = y ? new Date(y, m - 1, 1).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }) : 'Sans date';
        sous = pl(g.length, 'intervention') + ' · ' + pl(new Set(g.map(i => i.chantier)).size, 'chantier');
      } else {
        const ville = (g.find(i => i.ville) || {}).ville || ((S.data.chantiers.find(c => c.nom === k) || {}).ville) || '';
        titre = k;
        sous = (ville && !sameName(ville, k) ? esc(ville) + ' · ' : '') + pl(g.length, 'intervention');
      }
      h += '<section class="groupe' + (plie ? ' plie' : '') + '">' +
        '<button class="g-tete" data-act="plier" data-nom="' + esc(id) + '">' +
        '<span class="g-nom"><b>' + esc(titre) + '</b><small>' + sous + '</small></span>' +
        '<span class="g-tot">' + euros(g.reduce((s, i) => s + totalDe(i), 0)) + '</span>' +
        '<span class="g-fleche">' + ICO.chevron(18) + '</span></button>' +
        (plie ? '' : '<div class="g-corps">' + g.map(i => carte(i, parMois)).join('') + '</div>') + '</section>';
    });
    return h;
  }

  function vueListe() {
    const f = S.filtres;
    const all = toutes();
    const list = filtrer();
    const chantiers = Array.from(new Set(all.map(i => i.chantier).concat(S.data.chantiers.map(c => c.nom)))).filter(Boolean).sort((a, b) => a.localeCompare(b, 'fr'));
    const gars = tousLesGars().map(g => g.nom);
    const actif = f.chantier || f.gars || f.societe || S.recherche;

    let h = '<header class="tete"><div class="titre"><h1>Suivi chantiers</h1><p>MYL Services · LCQ Bâtiment</p></div>' +
      '<span class="sync" id="etat"></span><button class="ico-btn" data-act="refresh" aria-label="Actualiser">' + ICO.maj(20) + '</button></header><main>' +
      '<div class="chiffres" id="stats">' + statsHtml(list) + '</div>' +
      '<div class="vue-choix">' +
      '<button data-act="groupe" data-v="mois" class="' + (S.groupe !== 'chantier' ? 'on' : '') + '">Par mois</button>' +
      '<button data-act="groupe" data-v="chantier" class="' + (S.groupe === 'chantier' ? 'on' : '') + '">Par chantier</button></div>';
    if (DEMO) h += '<div class="demo">Mode essai : les données restent sur ce téléphone.</div>';
    h += '<div class="recherche">' + ICO.loupe(18) + '<input type="search" id="recherche" placeholder="Rechercher (chantier, travaux, gars…)" value="' + esc(S.recherche || '') + '"></div>' +
      '<div class="filtres">' +
      '<div class="seg-f">' + ['', 'MYL Services', 'LCQ Bâtiment'].map(v =>
        '<button data-act="f-soc" data-v="' + v + '" class="' + (f.societe === v ? 'on ' : '') + (v === 'MYL Services' ? 'myl' : v ? 'lcq' : '') + '">' + (v ? v.split(' ')[0] : 'Tout') + '</button>').join('') + '</div>' +
      sel('chantier', 'Tous les chantiers', chantiers, f.chantier) +
      sel('gars', 'Tous les gars', gars, f.gars) +
      (actif ? '<button class="effacer" data-act="effacer">Effacer</button>' : '') + '</div>' +
      '<div id="liste">' + listeHtml(list, all.length) + '</div>';
    return h + '</main>';
  }

  function sel(name, tous, opts, val) {
    return '<select class="pill' + (val ? ' on' : '') + '" data-filtre="' + name + '"><option value="">' + tous + '</option>' +
      opts.map(o => '<option' + (o === val ? ' selected' : '') + '>' + esc(o) + '</option>').join('') + '</select>';
  }

  function srcPhoto(p, taille) {
    return p.startsWith('data:') ? p : 'https://drive.google.com/thumbnail?id=' + encodeURIComponent(p) + '&sz=w' + taille;
  }

  function couleur(nom) {
    let h = 0;
    for (const c of norm(nom)) h = (h * 31 + c.charCodeAt(0)) % 360;
    return 'hsl(' + h + ',55%,45%)';
  }

  function carte(i, montrerChantier) {
    const soc = i.societe === 'MYL Services' ? 'myl' : i.societe === 'LCQ Bâtiment' ? 'lcq' : 'aucune';
    const nb = (i.photos || []).length;
    const photos = (i.photos || []).map(p =>
      '<img loading="lazy" src="' + esc(srcPhoto(p, 400)) + '" data-act="photo" data-id="' + esc(p.startsWith('data:') ? '' : p) + '" ' +
      'data-full="' + esc(p.startsWith('data:') ? p : srcPhoto(p, 1600)) + '" onerror="window.__photoSecours(this)" alt="Photo">').join('');
    const p = String(i.date || '').split('-').map(Number);
    const d = p.length === 3 && p[0] ? new Date(p[0], p[1] - 1, p[2]) : null;
    const rel = dateLabel(i.date);
    const colDate = d ? '<div class="c-date"><small>' + d.toLocaleDateString('fr-FR', { weekday: 'short' }).replace('.', '') + '</small><b>' + d.getDate() + '</b><small>' +
      d.toLocaleDateString('fr-FR', { month: 'short' }).replace('.', '') + '</small></div>' : '<div class="c-date"></div>';
    return '<article class="carte ' + soc + (i.pending ? ' attente' : '') + '">' + colDate + '<div class="c-corps">' +
      '<div class="l1"><span class="rel">' + (rel === "Aujourd'hui" || rel === 'Hier' ? rel : '') + '</span>' +
      (i.pending ? '<span class="badge attente">En attente d\'envoi</span>' : badge(i.societe)) + '</div>' +
      (montrerChantier ? '<p class="c-chantier">' + ICO.lieu(15) + esc(i.chantier || 'Sans chantier') + (i.ville && !sameName(i.ville, i.chantier) ? ' <small>· ' + esc(i.ville) + '</small>' : '') + '</p>' : '') +
      (i.travaux ? '<p class="travaux">' + esc(i.travaux) + '</p>' : '<p class="travaux vide-tr">Travaux non précisés</p>') +
      ((i.gars || []).length ? '<ul class="gars-l">' + i.gars.map(g =>
        '<li>' + esc(g.nom) + ' <b>' + euros(g.prix) + '</b></li>').join('') + '</ul>' : '') +
      (photos ? '<div class="photos n' + Math.min(nb, 3) + '">' + photos + '</div>' : '') +
      '<div class="pied"><span>Ajouté par ' + esc(i.auteur || '?') + (nb ? ' · ' + nb + ' photo' + (nb > 1 ? 's' : '') : '') + '</span>' +
      '<span class="tot">' + euros(i.total) + '</span></div></div></article>';
  }

  // Photo invisible publiquement (compte Google qui bloque le partage) : on la demande au script
  const photoCache = new Map();
  window.__photoSecours = async function (img) {
    const id = img.dataset.id;
    if (!id || img.dataset.secours) return;
    img.dataset.secours = '1';
    try {
      if (!photoCache.has(id)) {
        const j = await apiGet({ action: 'photo', id });
        photoCache.set(id, 'data:' + j.type + ';base64,' + j.data);
      }
      img.src = photoCache.get(id);
      img.dataset.full = photoCache.get(id);
    } catch (e) { /* hors ligne */ }
  };

  function vueReglages() {
    const ch = chantiersTries();
    const gars = tousLesGars();
    const url = location.origin + location.pathname;
    return '<header class="tete"><div class="titre"><h1>Réglages</h1><p>Chantiers, gars et partage</p></div><span class="sync" id="etat"></span></header><main>' +
      '<div class="bloc"><h3>Vous</h3><p style="margin:0 0 8px">Vous êtes <b>' + esc(S.auteur) + '</b>.</p>' +
      '<button class="btn sec" data-act="changer-moi">Changer de prénom</button></div>' +

      '<div class="bloc"><h3>Chantiers <small>' + ch.length + '</small></h3>' +
      (ch.length ? '<ul class="liste-simple">' + ch.map(c => '<li><span>' + esc(c.nom) + '</span><small>' + esc(c.ville) + '</small></li>').join('') + '</ul>'
        : '<p class="note">Aucun chantier pour l\'instant. Ajoutez-les ici, ou dites simplement « chantier … » en dictant : il sera créé tout seul.</p>') +
      '<div class="ajout"><input type="text" id="ch-nom" placeholder="Nom du chantier"><input type="text" id="ch-ville" placeholder="Ville">' +
      '<button class="btn" data-act="add-chantier" aria-label="Ajouter le chantier">' + ICO.plus(20) + '</button></div></div>' +

      '<div class="bloc"><h3>Les gars <small>' + gars.length + '</small></h3>' +
      (gars.length ? '<ul class="liste-simple">' + gars.map(g => '<li><span>' + esc(g.nom) + '</span><small>' + euros(g.prix) + ' habituel</small></li>').join('') + '</ul>'
        : '<p class="note">Ajoutez chaque gars avec son prix habituel : l\'appli le reconnaîtra quand vous direz son prénom.</p>') +
      '<div class="ajout"><input type="text" id="g-nom" placeholder="Prénom"><input type="number" id="g-prix" inputmode="decimal" placeholder="Prix €">' +
      '<button class="btn" data-act="add-gars" aria-label="Ajouter le gars">' + ICO.plus(20) + '</button></div>' +
      '<p class="note">Pour changer le prix habituel d\'un gars, ajoutez-le à nouveau avec le nouveau prix.</p></div>' +

      '<div class="bloc"><h3>Partager l\'appli aux gars</h3>' +
      '<button class="btn jaune large" data-act="partager">' + ICO.partage(20) + 'Envoyer le lien</button>' +
      '<p class="note" style="word-break:break-all">' + esc(url) + '</p>' +
      '<p class="note"><b>Android :</b> ouvrir le lien dans Chrome → menu ⋮ → « Ajouter à l\'écran d\'accueil ».<br>' +
      '<b>iPhone :</b> ouvrir le lien dans Safari → bouton Partager → « Sur l\'écran d\'accueil ».</p></div>' +

      (S.data.sheetUrl ? '<div class="bloc"><h3>Tableau Google Sheets</h3><a class="btn sec large" href="' + esc(S.data.sheetUrl) + '" target="_blank" rel="noopener">Ouvrir le tableau</a>' +
        '<p class="note">Les corrections faites dans le tableau apparaissent dans l\'appli.</p></div>' : '') +

      '<div class="bloc"><h3>Comment dicter</h3><p class="note">Dites tout d\'un coup, dans l\'ordre que vous voulez :<br>' +
      '<i>« Chantier Avignon, hier, Mohamed et Karim, LCQ Bâtiment, pose du placo, 150 euros chacun. »</i><br><br>' +
      '• Date : « aujourd\'hui », « hier », « lundi », « le 12 octobre »…<br>' +
      '• Prix : « 150 euros chacun », « 300 euros au total », « Mohamed 150, Karim 120 euros »<br>' +
      '• Sans prix dicté, le prix habituel du gars est utilisé.<br>• Tout le reste va dans « Travaux réalisés ».</p></div>' +
      '</main>';
  }

  // ---------------------------------------------------------------- saisie
  function nouveauDraft() {
    return { transcript: '', date: today(), chantierSel: '', newNom: '', newVille: '', societe: LS.get('lastSociete', ''),
      gars: [], travaux: '', photos: [], trouve: {} };
  }

  function ouvrirSaisie(avecMicro) {
    S.draft = nouveauDraft();
    const el = document.createElement('div');
    el.className = 'ecran';
    el.id = 'saisie';
    el.innerHTML = '<header class="tete"><div class="titre"><h1>Nouvelle intervention</h1></div><button class="ico-btn" data-act="fermer" aria-label="Fermer">' + ICO.fermer(22) + '</button></header>' +
      '<main><section class="etape"><h2><span>1</span>Parlez</h2>' +
      '<div class="micro-zone"><button class="micro" id="micro" data-act="micro" aria-label="Dicter">' + ICO.micro(54) + '</button>' +
      '<p class="micro-txt" id="micro-txt">Appuyez et dites tout d\'un coup</p>' +
      '<p class="astuce" id="micro-astuce">Le chantier, la date, qui a travaillé, la société, les travaux et les prix.</p></div>' +
      '<label class="t" for="dictee">Ce que vous avez dit</label>' +
      '<textarea id="dictee" placeholder="Exemple : chantier Avignon, aujourd\'hui, Mohamed et Karim, MYL Services, nettoyage fin de chantier, 150 euros chacun"></textarea></section>' +
      '<div id="champs"></div></main>' +
      '<div class="barre-save"><button class="btn jaune" data-act="enregistrer">Enregistrer l\'intervention</button></div>';
    document.body.appendChild(el);
    document.body.style.overflow = 'hidden';
    let t;
    $('#dictee').addEventListener('input', e => {
      S.draft.transcript = e.target.value;
      clearTimeout(t);
      t = setTimeout(analyser, 500);
    });
    renderChamps();
    if (avecMicro) Micro.start();
  }

  function fermerSaisie() {
    Micro.stop(true);
    const el = $('#saisie');
    if (el) el.remove();
    document.body.style.overflow = '';
    S.draft = null;
  }

  function appliquer(res) {
    const d = S.draft;
    if (!d) return;
    const trouve = {};
    if (res.date) { d.date = res.date; trouve.date = res.dateTrouvee !== false; }
    if (res.chantier && res.chantier.nom) {
      trouve.chantier = true;
      const connu = chantiersTries().find(c => sameName(c.nom, res.chantier.nom));
      if (connu) d.chantierSel = connu.nom;
      else { d.chantierSel = '__new'; d.newNom = res.chantier.nom; d.newVille = res.chantier.ville || ''; }
    }
    if (res.societe) { d.societe = res.societe; trouve.societe = true; }
    else if (d.chantierSel && d.chantierSel !== '__new') {
      const last = toutes().filter(i => i.chantier === d.chantierSel && i.societe).sort((a, b) => b.date.localeCompare(a.date))[0];
      if (last) d.societe = last.societe;
    }
    if (res.gars && res.gars.length) {
      d.gars = res.gars.map(g => {
        const connu = tousLesGars().find(x => sameName(x.nom, g.nom));
        const prix = g.prix == null || g.prix === '' ? (connu ? +connu.prix || 0 : 0) : +g.prix || 0;
        return { nom: connu ? connu.nom : g.nom, prix, prixDefaut: g.prixDefaut || g.prix == null };
      });
      trouve.gars = true;
    } else if (res.prixSeul != null) d.gars.forEach(g => { g.prix = res.prixSeul; g.prixDefaut = false; });
    if (res.travaux != null) { d.travaux = res.travaux; trouve.travaux = !!res.travaux; }
    d.trouve = trouve;
    renderChamps();
  }

  function statutIA(txt) {
    const a = $('#micro-astuce');
    if (a) a.innerHTML = txt;
  }

  // 1) rangement immédiat sur le téléphone  2) l'IA Gemini (gratuite, via le script Google) corrige et complète
  let iaSeq = 0;
  function analyser() {
    const d = S.draft;
    if (!d) return Promise.resolve();
    const texte = (d.transcript || '').trim();
    appliquer(window.Dictee.parseDictee(texte, { gars: tousLesGars(), chantiers: chantiersTries() }));
    d.analyseDe = texte;
    if (DEMO || texte.length < 8) return Promise.resolve();
    const seq = ++iaSeq;
    statutIA('<span class="spin"></span> Rangement de votre dictée…');
    const t = new Date();
    d.iaEnCours = apiPost({ action: 'analyser', texte,
      aujourdhui: today(), jour: t.toLocaleDateString('fr-FR', { weekday: 'long' }) })
      .then(j => {
        if (seq !== iaSeq || !S.draft) return;
        if (j.ia && j.resultat) { appliquer(j.resultat); statutIA('<b class="ok">C\'est rangé.</b> Vérifiez ci-dessous puis enregistrez.'); }
        else statutIA('Rangement simple utilisé. Vérifiez les cases ci-dessous.');
      })
      .catch(() => { if (seq === iaSeq) statutIA('Pas de réseau : rangement simple utilisé. Vérifiez les cases.'); });
    return d.iaEnCours;
  }

  function renderChamps() {
    const d = S.draft;
    const el = $('#champs');
    if (!d || !el) return;
    const ok = k => d.trouve[k] ? '<span class="trouve">rempli</span>' : '';
    const ch = chantiersTries();
    const garsDispo = tousLesGars();
    d.gars.forEach(g => { if (!garsDispo.some(x => sameName(x.nom, g.nom))) garsDispo.push({ nom: g.nom, prix: g.prix }); });
    const total = d.gars.reduce((s, g) => s + (+g.prix || 0), 0);

    el.innerHTML =
      '<section class="etape"><h2><span>2</span>Vérifiez</h2><p class="note">Les cases se remplissent toutes seules. Corrigez si besoin.</p>' +
      '<label class="t" for="f-date">Date ' + ok('date') + '</label><input type="date" id="f-date" value="' + esc(d.date) + '">' +
      '<label class="t" for="f-chantier">Chantier ' + ok('chantier') + '</label>' +
      '<select id="f-chantier"><option value="">— Choisir —</option>' +
      ch.map(c => '<option value="' + esc(c.nom) + '"' + (d.chantierSel === c.nom ? ' selected' : '') + '>' + esc(c.nom) + (c.ville && !sameName(c.ville, c.nom) ? ' · ' + esc(c.ville) : '') + '</option>').join('') +
      '<option value="__new"' + (d.chantierSel === '__new' ? ' selected' : '') + '>+ Nouveau chantier…</option></select>' +
      (d.chantierSel === '__new' ? '<div class="new-ch"><input type="text" id="f-newnom" placeholder="Nom du chantier" value="' + esc(d.newNom) + '">' +
        '<input type="text" id="f-newville" placeholder="Ville" value="' + esc(d.newVille) + '"></div>' : '') +
      '<label class="t">Société ' + ok('societe') + '</label><div class="seg">' +
      '<button data-act="societe" data-v="MYL Services" class="myl ' + (d.societe === 'MYL Services' ? 'on' : '') + '">MYL Services</button>' +
      '<button data-act="societe" data-v="LCQ Bâtiment" class="lcq ' + (d.societe === 'LCQ Bâtiment' ? 'on' : '') + '">LCQ Bâtiment</button></div>' +

      '<label class="t">Qui a travaillé ' + ok('gars') + '</label><div class="chips">' +
      garsDispo.map(g => '<button class="chip ' + (d.gars.some(x => sameName(x.nom, g.nom)) ? 'on' : '') + '" data-act="toggle-gars" data-nom="' + esc(g.nom) + '">' + esc(g.nom) + '</button>').join('') +
      '<button class="chip plus" data-act="nouveau-gars">+ Autre</button></div>' +
      (d.gars.length ? '<div class="prix-l">' + d.gars.map((g, i) =>
        '<div class="row"><div>' + esc(g.nom) + (g.prixDefaut ? '<small>prix habituel</small>' : '') + '</div>' +
        '<input type="number" inputmode="decimal" data-prix="' + i + '" value="' + esc(g.prix) + '" aria-label="Prix ' + esc(g.nom) + '"></div>').join('') +
        '</div><div class="total" id="f-total">Total : ' + euros(total) + '</div>' : '') +
      '<label class="t" for="f-travaux">Travaux réalisés ' + ok('travaux') + '</label>' +
      '<textarea id="f-travaux" placeholder="Ex. : nettoyage fin de chantier">' + esc(d.travaux) + '</textarea></section>' +

      '<section class="etape"><h2><span>3</span>Photos <small>' + (d.photos.length || '') + '</small></h2><div class="photos-btn">' +
      '<button class="btn" data-act="camera">' + ICO.photo(20) + 'Photo</button><button class="btn sec" data-act="galerie">' + ICO.galerie(20) + 'Galerie</button></div>' +
      '<div class="vignettes">' + d.photos.map((p, i) => '<div><img src="' + p.url + '" alt="Photo ' + (i + 1) + '"><button data-act="suppr-photo" data-i="' + i + '" aria-label="Retirer">' + ICO.fermer(14) + '</button></div>').join('') + '</div>' +
      '</section>';

    $('#f-date').onchange = e => { d.date = e.target.value; };
    $('#f-chantier').onchange = e => {
      d.chantierSel = e.target.value;
      if (d.chantierSel && d.chantierSel !== '__new' && !d.societe) {
        const last = toutes().find(i => i.chantier === d.chantierSel && i.societe);
        if (last) d.societe = last.societe;
      }
      renderChamps();
    };
    const nn = $('#f-newnom'); if (nn) nn.oninput = e => { d.newNom = e.target.value; };
    const nv = $('#f-newville'); if (nv) nv.oninput = e => { d.newVille = e.target.value; };
    $('#f-travaux').oninput = e => { d.travaux = e.target.value; };
    el.querySelectorAll('[data-prix]').forEach(inp => {
      inp.oninput = e => {
        const g = d.gars[+e.target.dataset.prix];
        g.prix = parseFloat(String(e.target.value).replace(',', '.')) || 0;
        g.prixDefaut = false;
        $('#f-total').textContent = 'Total : ' + euros(d.gars.reduce((s, x) => s + (+x.prix || 0), 0));
      };
    });
  }

  // Compression des photos (réseau de chantier souvent faible)
  function compresser(file) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const max = 1600;
        const r = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * r);
        c.height = Math.round(img.naturalHeight * r);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        res(c.toDataURL('image/jpeg', 0.72));
      };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Photo illisible')); };
      img.src = url;
    });
  }

  async function ajouterPhotos(files) {
    if (!S.draft) return;
    for (const f of Array.from(files || [])) {
      try {
        const url = await compresser(f);
        S.draft.photos.push({ url, data: url.split(',')[1] });
      } catch (e) { toast('Photo illisible'); }
    }
    renderChamps();
  }

  async function enregistrer() {
    const d = S.draft;
    const ta = $('#dictee');
    Micro.stop(true);
    if (ta) d.transcript = ta.value;
    // On n'enregistre pas une dictée pas encore rangée
    if ((d.transcript || '').trim() !== (d.analyseDe || '')) analyser();
    if (d.iaEnCours) {
      toast('Rangement en cours…', 1500);
      await Promise.race([d.iaEnCours, new Promise(r => setTimeout(r, 15000))]);
      d.iaEnCours = null;
      if (!S.draft) return;
    }
    let chantier = d.chantierSel === '__new' ? d.newNom.trim() : d.chantierSel;
    let ville = d.chantierSel === '__new' ? d.newVille.trim() : ((chantiersTries().find(c => c.nom === chantier) || {}).ville || '');
    if (!chantier) { toast('Choisissez le chantier'); $('#f-chantier').focus(); return; }
    if (!d.gars.length && !confirm('Aucun gars sélectionné. Enregistrer quand même ?')) return;
    if (!d.societe && !confirm('Aucune société choisie (MYL / LCQ). Enregistrer quand même ?')) return;
    const item = {
      id: uid(), date: d.date || today(), chantier, ville, societe: d.societe || '',
      gars: d.gars.map(g => ({ nom: g.nom, prix: +g.prix || 0 })),
      travaux: (d.travaux || '').trim(), auteur: S.auteur, createdAt: new Date().toISOString(),
      photos: d.photos.map(p => ({ type: 'image/jpeg', data: p.data }))
    };
    try { await Outbox.put(item); } catch (e) { /* IndexedDB indisponible : on tente quand même l'envoi */ }
    S.outbox.unshift(item);
    if (item.societe) LS.set('lastSociete', item.societe);
    fermerSaisie();
    S.vue = 'liste';
    render();
    toast('Intervention enregistrée');
    envoyer();
  }

  // ---------------------------------------------------------------- micro
  const Micro = {
    rec: null, on: false, base: '', fin: '', vides: 0, aParle: false,
    SR: window.SpeechRecognition || window.webkitSpeechRecognition,

    ui() {
      const b = $('#micro'), t = $('#micro-txt');
      if (!b) return;
      b.classList.toggle('ecoute', this.on);
      b.innerHTML = this.on ? ICO.stop(44) : ICO.micro(54);
      t.textContent = this.on ? "J'écoute… appuyez pour terminer" : (S.draft && S.draft.transcript ? 'Appuyez pour ajouter quelque chose' : "Appuyez et dites tout d'un coup");
    },

    sansMicro(msg) {
      this.on = false;
      this.ui();
      const a = $('#micro-astuce');
      if (a) a.innerHTML = msg + '<br>Touchez la case ci-dessous, puis le <b>micro du clavier</b> pour dicter.';
      const t = $('#dictee');
      if (t) t.focus();
    },

    merge(acc, t) {
      t = t.trim();
      if (!acc) return t;
      if (!t) return acc;
      const a = acc.toLowerCase(), b = t.toLowerCase();
      if (b.startsWith(a)) return t;        // bug Android : le texte est répété en entier
      if (a.endsWith(b)) return acc;
      return acc + ' ' + t;
    },

    texte(extra) {
      return [this.base, this.fin, extra || ''].map(s => s.trim()).filter(Boolean).join(' ');
    },

    start() {
      if (!this.SR) { this.sansMicro('La dictée directe n\'est pas disponible ici.'); return; }
      if (this.on) return;
      this.on = true;
      this.base = ($('#dictee').value || '').trim();
      this.fin = '';
      this.vides = 0;
      this.lancer();
      this.ui();
    },

    lancer() {
      const rec = new this.SR();
      this.rec = rec;
      rec.lang = 'fr-FR';
      rec.continuous = true;
      rec.interimResults = true;
      this.aParle = false;
      rec.onresult = e => {
        let fin = '', interim = '';
        for (let i = 0; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) fin = this.merge(fin, r[0].transcript);
          else interim += ' ' + r[0].transcript;
        }
        this.fin = fin;
        this.aParle = true;
        const ta = $('#dictee');
        if (ta) { ta.value = this.texte(interim); S.draft.transcript = this.texte(); }
      };
      rec.onerror = e => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          this.rec = null;
          this.sansMicro('Le micro est bloqué pour l\'appli.');
        } else if (e.error === 'network') {
          this.rec = null;
          this.sansMicro('La dictée a besoin d\'internet.');
        }
      };
      rec.onend = () => {
        if (this.rec !== rec) { this.finir(); return; }
        this.base = this.texte();
        this.fin = '';
        this.vides = this.aParle ? 0 : this.vides + 1;
        // Relance tant qu'on n'a pas appuyé sur stop (le téléphone coupe après un silence)
        if (this.on && this.vides < 2) {
          try { this.lancer(); return; } catch (err) { /* on arrête */ }
        }
        this.on = false;
        this.finir();
      };
      try { rec.start(); } catch (err) { this.sansMicro('Impossible de démarrer la dictée.'); }
    },

    finir() {
      this.ui();
      const ta = $('#dictee');
      if (ta && S.draft) { S.draft.transcript = ta.value; analyser(); }
    },

    stop(silencieux) {
      if (!this.on && !this.rec) return;
      this.on = false;
      const rec = this.rec;
      if (silencieux) this.rec = null;
      try { rec && rec.stop(); } catch (e) { /* déjà arrêté */ }
      if (!silencieux) this.ui();
    },

    toggle() { this.on ? this.stop() : this.start(); }
  };

  // ---------------------------------------------------------------- actions
  const actions = {
    vue(el) { S.vue = el.dataset.vue; render(); window.scrollTo(0, 0); },
    groupe(el) { S.groupe = el.dataset.v; LS.set('groupe', S.groupe); render(); },
    'f-soc'(el) { S.filtres.societe = el.dataset.v; LS.set('filtres', S.filtres); render(); },
    effacer() { S.filtres = { chantier: '', gars: '', societe: '' }; S.recherche = ''; LS.set('filtres', S.filtres); render(); },
    plier(el) {
      const nom = el.dataset.nom;
      let p = LS.get('plies', []);
      p = p.includes(nom) ? p.filter(x => x !== nom) : p.concat(nom);
      LS.set('plies', p);
      render();
    },
    saisie() { ouvrirSaisie(true); },
    fermer() {
      const d = S.draft;
      if (d && (d.transcript || d.photos.length || d.travaux) && !confirm('Abandonner cette intervention ?')) return;
      fermerSaisie();
    },
    micro() { Micro.toggle(); },
    societe(el) { S.draft.societe = S.draft.societe === el.dataset.v ? '' : el.dataset.v; renderChamps(); },
    'toggle-gars'(el) {
      const d = S.draft, nom = el.dataset.nom;
      const i = d.gars.findIndex(g => sameName(g.nom, nom));
      if (i >= 0) d.gars.splice(i, 1);
      else {
        const g = tousLesGars().find(x => sameName(x.nom, nom)) || { prix: 0 };
        d.gars.push({ nom, prix: +g.prix || 0, prixDefaut: true });
      }
      renderChamps();
    },
    'nouveau-gars'() {
      const nom = (prompt('Prénom du gars ?') || '').trim();
      if (!nom) return;
      const prix = parseFloat(String(prompt('Prix pour ' + nom + ' (€) ?', '') || '0').replace(',', '.')) || 0;
      S.draft.gars.push({ nom, prix, prixDefaut: false });
      renderChamps();
    },
    camera() { $('#camera').click(); },
    galerie() { $('#galerie').click(); },
    'suppr-photo'(el) { S.draft.photos.splice(+el.dataset.i, 1); renderChamps(); },
    enregistrer() { enregistrer(); },
    refresh() { toast('Actualisation…', 1200); envoyer(); },
    photo(el) {
      const lb = document.createElement('div');
      lb.className = 'lightbox';
      lb.innerHTML = '<img alt="Photo" src="' + esc(el.dataset.full || el.src) + '"><button aria-label="Fermer">' + ICO.fermer(22) + '</button>';
      lb.onclick = () => lb.remove();
      const big = lb.querySelector('img');
      big.onerror = () => { if (big.src !== el.src) big.src = el.src; };
      document.body.appendChild(lb);
    },
    moi(el) { setMoi(el.dataset.nom); },
    'moi-ok'() { setMoi(($('#moi-input').value || '').trim()); },
    'changer-moi'() {
      const n = (prompt('Votre prénom ?', S.auteur) || '').trim();
      if (n) setMoi(n);
    },
    async 'add-chantier'() {
      const nom = $('#ch-nom').value.trim(), ville = $('#ch-ville').value.trim();
      if (!nom) { toast('Indiquez le nom du chantier'); return; }
      if (!S.data.chantiers.some(c => sameName(c.nom, nom))) S.data.chantiers.push({ nom, ville });
      render();
      try { await apiPost({ action: 'addChantier', nom, ville }); toast('Chantier ajouté'); rafraichir(); }
      catch (e) { toast('Pas de réseau : réessayez plus tard'); }
    },
    async 'add-gars'() {
      const nom = $('#g-nom').value.trim();
      const prix = parseFloat(String($('#g-prix').value).replace(',', '.')) || 0;
      if (!nom) { toast('Indiquez le prénom'); return; }
      const g = S.data.gars.find(x => sameName(x.nom, nom));
      if (g) g.prix = prix; else S.data.gars.push({ nom, prix });
      render();
      try { await apiPost({ action: 'addGars', nom, prix }); toast(nom + ' enregistré'); rafraichir(); }
      catch (e) { toast('Pas de réseau : réessayez plus tard'); }
    },
    async partager() {
      const url = location.origin + location.pathname;
      const text = 'Appli chantiers MYL / LCQ : ouvre ce lien puis « Ajouter à l\'écran d\'accueil ». ' + url;
      try {
        if (navigator.share) { await navigator.share({ title: 'Chantiers', text, url }); return; }
      } catch (e) { return; }
      location.href = 'https://wa.me/?text=' + encodeURIComponent(text);
    }
  };

  function setMoi(nom) {
    if (!nom) { toast('Indiquez votre prénom'); return; }
    S.auteur = nom;
    LS.set('auteur', nom);
    render();
  }

  document.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (!el || !actions[el.dataset.act]) return;
    e.preventDefault();
    actions[el.dataset.act](el, e);
  });
  document.addEventListener('change', e => {
    const f = e.target.dataset && e.target.dataset.filtre;
    if (!f) return;
    S.filtres[f] = e.target.value;
    LS.set('filtres', S.filtres);
    render();
  });
  document.addEventListener('input', e => {
    if (e.target.id !== 'recherche') return;
    S.recherche = e.target.value;
    const list = filtrer();
    $('#liste').innerHTML = listeHtml(list, toutes().length);
    $('#stats').innerHTML = statsHtml(list);
  });
  ['camera', 'galerie'].forEach(id => {
    document.getElementById(id).addEventListener('change', e => { ajouterPhotos(e.target.files); e.target.value = ''; });
  });
  window.addEventListener('online', envoyer);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !S.draft) envoyer(); });

  // ---------------------------------------------------------------- démarrage
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    // Nouvelle version en ligne : on recharge tout seul une fois
    const avait = !!navigator.serviceWorker.controller;
    let recharge = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (avait && !recharge && !S.draft) { recharge = true; location.reload(); }
    });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
      document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
    }).catch(() => {});
  }
  render();
  Outbox.all().then(items => {
    S.outbox = (items || []).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    render();
    envoyer();
  });
})();
