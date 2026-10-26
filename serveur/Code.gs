/**
 * Suivi chantiers MYL Services / LCQ Bâtiment — serveur gratuit Google Apps Script.
 * Écrit les interventions dans un Google Sheets et range les photos dans Drive (un dossier par chantier).
 *
 * Installation : coller ce fichier dans script.google.com, lancer « setup » une fois,
 * puis Déployer > Application Web (Exécuter en tant que : Moi ; Accès : Tout le monde).
 */

// Code d'équipe : doit être identique à TEAM_KEY dans config.js de l'appli.
const TEAM_KEY = '3BHmwxCPbdDhiwoxdqpYze8H';

const ROOT_FOLDER_NAME = 'Suivi chantiers MYL - LCQ';
const SHEET_INTER = 'Interventions';
const SHEET_CHANTIERS = 'Chantiers';
const SHEET_GARS = 'Gars';
const H_INTER = ['ID', 'Date', 'Chantier', 'Ville', 'Société', 'Gars', 'Prix par gars', 'Total (€)',
  'Travaux réalisés', 'Photos', 'Ajouté par', 'Enregistré le'];

/** À lancer une fois depuis l'éditeur : crée le dossier, le tableau et demande les autorisations. */
function setup() {
  const c = cfg_();
  Logger.log('Tableau : ' + SpreadsheetApp.openById(c.ss).getUrl());
  Logger.log('Dossier photos : ' + DriveApp.getFolderById(c.photos).getUrl());
}

function doGet(e) {
  return respond_(() => {
    const q = (e && e.parameter) || {};
    checkKey_(q.key);
    if (q.action === 'photo') return photo_(q.id);
    return all_();
  });
}

function doPost(e) {
  return respond_(() => {
    const b = JSON.parse(e.postData.contents);
    checkKey_(b.key);
    switch (b.action) {
      case 'add': return add_(b);
      case 'analyser': return analyser_(b);
      case 'addChantier': withLock_(() => ensureChantier_(book_(), b.nom, b.ville)); return {};
      case 'addGars': withLock_(() => ensureGars_(book_(), b.nom, b.prix, true)); return {};
      default: throw new Error('Action inconnue');
    }
  });
}

// ---------------------------------------------------------------------------

function respond_(fn) {
  let out;
  try { out = Object.assign({ ok: true }, fn()); }
  catch (err) { out = { ok: false, error: String((err && err.message) || err) }; }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function checkKey_(k) {
  if (k !== TEAM_KEY) throw new Error('Code équipe invalide');
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function cfg_() {
  const p = PropertiesService.getScriptProperties();
  const ss = p.getProperty('SS');
  const photos = p.getProperty('PHOTOS');
  if (ss && photos) return { ss, photos };
  return withLock_(() => {
    const ss2 = p.getProperty('SS');
    const photos2 = p.getProperty('PHOTOS');
    if (ss2 && photos2) return { ss: ss2, photos: photos2 };
    const root = DriveApp.createFolder(ROOT_FOLDER_NAME);
    const book = SpreadsheetApp.create('Suivi chantiers - Interventions');
    DriveApp.getFileById(book.getId()).moveTo(root);
    book.setSpreadsheetTimeZone('Europe/Paris');

    const sh = book.getSheets()[0];
    sh.setName(SHEET_INTER);
    sh.getRange(1, 1, 1, H_INTER.length).setValues([H_INTER]).setFontWeight('bold').setBackground('#1e3a5f').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    sh.getRange('B:B').setNumberFormat('dd/mm/yyyy');
    sh.getRange('L:L').setNumberFormat('dd/mm/yyyy hh:mm');
    sh.getRange('I:J').setWrap(true);
    sh.setColumnWidth(1, 60); sh.hideColumns(1);
    sh.setColumnWidth(3, 180); sh.setColumnWidth(6, 160); sh.setColumnWidth(7, 200);
    sh.setColumnWidth(9, 320); sh.setColumnWidth(10, 260);

    const sc = book.insertSheet(SHEET_CHANTIERS);
    sc.appendRow(['Chantier', 'Ville', 'Ajouté le']);
    sc.getRange(1, 1, 1, 3).setFontWeight('bold'); sc.setFrozenRows(1); sc.setColumnWidth(1, 220);

    const sg = book.insertSheet(SHEET_GARS);
    sg.appendRow(['Prénom', 'Prix habituel (€)', 'Ajouté le']);
    sg.getRange(1, 1, 1, 3).setFontWeight('bold'); sg.setFrozenRows(1);

    const ph = root.createFolder('Photos');
    p.setProperties({ SS: book.getId(), PHOTOS: ph.getId() });
    return { ss: book.getId(), photos: ph.getId() };
  });
}

function book_() { return SpreadsheetApp.openById(cfg_().ss); }

function rows_(sheet) {
  const n = sheet.getLastRow();
  if (n < 2) return [];
  return sheet.getRange(2, 1, n - 1, sheet.getLastColumn()).getValues();
}

function fmtDate_(v, tz) {
  if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  const m = String(v || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
  return String(v || '');
}

function all_() {
  const book = book_();
  const tz = book.getSpreadsheetTimeZone();
  const interventions = rows_(book.getSheetByName(SHEET_INTER)).filter(r => r[2] || r[8]).map((r, i) => {
    const noms = String(r[5] || '').split(/\s*[,;\n]\s*/).filter(Boolean);
    const prix = {};
    String(r[6] || '').split(/\s*[\/\n]\s*/).forEach(part => {
      const m = part.match(/^(.+?)\s*:\s*([\d.,]+)/);
      if (m) prix[m[1].trim().toLowerCase()] = parseFloat(m[2].replace(',', '.'));
    });
    const photos = (String(r[9] || '').match(/[-\w]{25,}/g) || []);
    return {
      id: String(r[0] || 'ligne-' + (i + 2)),
      date: fmtDate_(r[1], tz),
      chantier: String(r[2] || ''),
      ville: String(r[3] || ''),
      societe: String(r[4] || ''),
      gars: noms.map(n => ({ nom: n, prix: prix[n.toLowerCase()] || 0 })),
      total: Number(r[7]) || 0,
      travaux: String(r[8] || ''),
      photos: photos,
      auteur: String(r[10] || ''),
      createdAt: r[11] instanceof Date ? r[11].toISOString() : ''
    };
  });
  const chantiers = rows_(book.getSheetByName(SHEET_CHANTIERS)).filter(r => r[0])
    .map(r => ({ nom: String(r[0]).trim(), ville: String(r[1] || '').trim() }));
  const gars = rows_(book.getSheetByName(SHEET_GARS)).filter(r => r[0])
    .map(r => ({ nom: String(r[0]).trim(), prix: Number(r[1]) || 0 }));
  return { interventions, chantiers, gars, sheetUrl: book.getUrl() };
}

function ensureChantier_(book, nom, ville) {
  nom = String(nom || '').trim();
  if (!nom) return;
  const sh = book.getSheetByName(SHEET_CHANTIERS);
  const rows = rows_(sh);
  const i = rows.findIndex(r => String(r[0]).trim().toLowerCase() === nom.toLowerCase());
  if (i < 0) sh.appendRow([nom, String(ville || '').trim(), new Date()]);
  else if (ville && !rows[i][1]) sh.getRange(i + 2, 2).setValue(String(ville).trim());
}

function ensureGars_(book, nom, prix, updatePrix) {
  nom = String(nom || '').trim();
  if (!nom) return;
  const sh = book.getSheetByName(SHEET_GARS);
  const rows = rows_(sh);
  const i = rows.findIndex(r => String(r[0]).trim().toLowerCase() === nom.toLowerCase());
  if (i < 0) sh.appendRow([nom, Number(prix) || 0, new Date()]);
  else if (updatePrix) sh.getRange(i + 2, 2).setValue(Number(prix) || 0);
}

function idExists_(sheet, id) {
  const n = sheet.getLastRow();
  if (n < 2) return false;
  return sheet.getRange(2, 1, n - 1, 1).getValues().some(r => String(r[0]) === String(id));
}

function folderFor_(chantier) {
  const parent = DriveApp.getFolderById(cfg_().photos);
  const name = String(chantier || 'Sans chantier').replace(/[\\/:*?"<>|]/g, '-').trim() || 'Sans chantier';
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function add_(b) {
  const book = book_();
  const sh = book.getSheetByName(SHEET_INTER);
  if (!b.id) throw new Error('ID manquant');
  if (withLock_(() => idExists_(sh, b.id))) return { dup: true };

  // Photos (hors verrou : c'est l'étape la plus longue)
  const links = [];
  const photos = b.photos || [];
  if (photos.length) {
    const folder = folderFor_(b.chantier);
    photos.forEach((p, i) => {
      const blob = Utilities.newBlob(Utilities.base64Decode(p.data), p.type || 'image/jpeg',
        (b.date || '') + ' ' + (b.chantier || '') + ' - ' + (b.auteur || '') + ' ' + (i + 1) + '.jpg');
      const f = folder.createFile(blob);
      try { f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (err) { /* domaine qui interdit le partage : l'appli passera par le serveur */ }
      links.push('https://drive.google.com/file/d/' + f.getId() + '/view');
    });
  }

  return withLock_(() => {
    if (idExists_(sh, b.id)) return { dup: true };
    ensureChantier_(book, b.chantier, b.ville);
    const gars = (b.gars || []).filter(g => g && g.nom);
    gars.forEach(g => ensureGars_(book, g.nom, g.prix, false));
    const total = gars.reduce((s, g) => s + (Number(g.prix) || 0), 0);
    const d = String(b.date || '').split('-').map(Number);
    const date = d.length === 3 ? new Date(d[0], d[1] - 1, d[2], 12) : new Date();
    sh.appendRow([
      b.id, date, b.chantier || '', b.ville || '', b.societe || '',
      gars.map(g => g.nom).join(', '),
      gars.map(g => g.nom + ' : ' + (Number(g.prix) || 0) + ' €').join(' / '),
      total, b.travaux || '', links.join('\n'), b.auteur || '', new Date()
    ]);
    return { id: b.id };
  });
}

// ---------------------------------------------------------------------------
// IA gratuite (Google Gemini) : range une dictée dans les bonnes cases.
// Clé gratuite à créer sur https://aistudio.google.com/apikey puis à coller dans
// Paramètres du projet > Propriétés du script : GEMINI_KEY

function analyser_(b) {
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty('GEMINI_KEY');
  if (!key) return { ia: false };
  const texte = String(b.texte || '').slice(0, 3000);
  if (!texte.trim()) return { ia: false };
  const book = book_();
  const chantiers = rows_(book.getSheetByName(SHEET_CHANTIERS)).filter(r => r[0]).map(r => r[0] + (r[1] ? ' (' + r[1] + ')' : ''));
  const gars = rows_(book.getSheetByName(SHEET_GARS)).filter(r => r[0]).map(r => r[0] + ' : ' + (Number(r[1]) || 0) + ' €');

  const prompt = [
    'Tu ranges la dictée vocale d\'un chef de chantier (BTP, Marseille / PACA) dans une fiche d\'intervention.',
    'La dictée vient de la reconnaissance vocale du téléphone : il peut y avoir des fautes, des mots mal compris, pas de ponctuation.',
    'Aujourd\'hui : ' + (b.jour || '') + ' ' + (b.aujourdhui || '') + '.',
    'Sociétés possibles : "MYL Services" ou "LCQ Bâtiment" (la dictée peut les déformer : "mil services", "Émile services", "elle cé cu bâtiment", "LCQ"…).',
    'Chantiers déjà connus : ' + (chantiers.join(' ; ') || 'aucun') + '.',
    'Gars connus avec leur prix habituel : ' + (gars.join(' ; ') || 'aucun') + '.',
    '',
    'Règles :',
    '- date : au format AAAA-MM-JJ. "aujourd\'hui", "hier", "avant-hier", un jour de la semaine = le plus récent passé (ou aujourd\'hui), "le 12" = ce mois-ci. Sans date dite : aujourd\'hui.',
    '- chantier : si la dictée parle d\'un chantier connu (par son nom OU sa ville, même mal orthographié), renvoie EXACTEMENT son nom connu. Sinon crée un nom court et propre (ex. "La Ciotat", "Villa Martin") et mets la ville si elle est dite.',
    '- gars : tous les prénoms des personnes qui ont travaillé. Si un prénom ressemble à un gars connu, renvoie l\'orthographe connue. Un prénom inconnu est gardé tel quel, avec une majuscule.',
    '- prix de chaque gars, en euros : "150 euros chacun" = 150 pour chacun ; "300 euros au total / en tout / pour les deux" = partagé à parts égales ; "Mohamed 150, Karim 120" = prix individuels. Si aucun prix n\'est dit pour un gars : prix = null (le prix habituel sera utilisé).',
    '- societe : "MYL Services", "LCQ Bâtiment" ou "" si non dite.',
    '- travaux : uniquement le travail réalisé, réécrit proprement en français correct, phrase courte et claire (ex. "Nettoyage de fin de chantier"). N\'y mets ni la date, ni le chantier, ni les noms, ni la société, ni les prix.',
    '',
    'Dictée : """' + texte + '"""',
    '',
    'Réponds UNIQUEMENT avec ce JSON :',
    '{"date":"AAAA-MM-JJ","chantier":{"nom":"","ville":""},"societe":"","gars":[{"nom":"","prix":null}],"travaux":""}'
  ].join('\n');

  const modeles = (props.getProperty('GEMINI_MODEL') || 'gemini-flash-latest,gemini-2.5-flash,gemini-2.0-flash').split(',');
  let derniere = '';
  for (const m of modeles) {
    const res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + m.trim() + ':generateContent', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': key },
      muteHttpExceptions: true,
      payload: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0 }
      })
    });
    const code = res.getResponseCode();
    if (code === 404) { derniere = 'Modèle ' + m + ' introuvable'; continue; }
    if (code !== 200) return { ia: false, error: 'Gemini ' + code + ' : ' + res.getContentText().slice(0, 200) };
    const j = JSON.parse(res.getContentText());
    const txt = (((j.candidates || [])[0] || {}).content || {}).parts;
    if (!txt || !txt[0]) return { ia: false, error: 'Réponse vide' };
    const r = JSON.parse(String(txt[0].text).replace(/^`{3}(json)?|`{3}$/g, '').trim());
    const soc = /lcq/i.test(r.societe) ? 'LCQ Bâtiment' : /myl/i.test(r.societe) ? 'MYL Services' : '';
    return {
      ia: true,
      resultat: {
        date: /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : (b.aujourdhui || ''),
        chantier: r.chantier && r.chantier.nom ? { nom: String(r.chantier.nom).trim(), ville: String(r.chantier.ville || '').trim() } : null,
        societe: soc,
        gars: (r.gars || []).filter(g => g && g.nom).map(g => ({ nom: String(g.nom).trim(), prix: g.prix == null || g.prix === '' ? null : Number(g.prix) })),
        travaux: String(r.travaux || '').trim()
      }
    };
  }
  return { ia: false, error: derniere };
}

function photo_(id) {
  const file = DriveApp.getFileById(id);
  // Sécurité : uniquement les fichiers rangés dans le dossier Photos
  const photosId = cfg_().photos;
  let ok = false;
  const parents = file.getParents();
  while (parents.hasNext() && !ok) {
    const p = parents.next();
    const gp = p.getParents();
    while (gp.hasNext()) if (gp.next().getId() === photosId) ok = true;
  }
  if (!ok) throw new Error('Photo introuvable');
  const blob = file.getBlob();
  return { type: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) };
}
