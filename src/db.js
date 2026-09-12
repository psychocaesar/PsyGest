/**
 * db.js — Couche d'accès SQLite pour PsyGest
 * Toutes les fonctions SQL sont ici ; main.js n'appelle jamais SQL directement.
 */
import Database from '@tauri-apps/plugin-sql';
import { documentDir, join } from '@tauri-apps/api/path';
import { mkdir, exists, readTextFile, writeTextFile, readDir, remove, BaseDirectory } from '@tauri-apps/plugin-fs';

// ─── Initialisation ───────────────────────────────────────────────────────────

/**
 * Ouvre (ou crée) la base de données, applique le schéma, retourne l'instance.
 * Chemin : ~/Documents/PsyGest/psygest.db
 */
export async function initDb() {
  // Crée le répertoire si besoin
  try {
    await mkdir('PsyGest', { baseDir: BaseDirectory.Document, recursive: true });
  } catch (_) {}

  const docDir = await documentDir();
  const dbFilePath = await join(docDir, 'PsyGest', 'psygest.db');
  // Le parseur d'URL de sqlx-sqlite ne reconnaît que mode/cache/immutable/vfs — tout
  // autre paramètre (dont _busy_timeout, _journal_mode, _synchronous) fait échouer la
  // connexion avec "unknown query parameter" avant même d'ouvrir le fichier. Les pragmas
  // doivent donc être posés après coup, en SQL classique.
  const db = await Database.load(`sqlite:${dbFilePath}`);
  // journal_mode=WAL est persisté dans le fichier lui-même (pas besoin de le reposer à
  // chaque connexion du pool) ; busy_timeout et synchronous sont par connexion, reposés
  // ici au mieux pour la connexion initiale.
  await db.execute('PRAGMA journal_mode = WAL');
  await db.execute('PRAGMA busy_timeout = 10000'); // attend jusqu'à 10s si la DB est occupée (évite SQLITE_BUSY)
  await db.execute('PRAGMA synchronous = NORMAL'); // compromis sécurité/perf sur SSD
  await applySchema(db);
  return db;
}

async function applySchema(db) {
  const tables = [
    `CREATE TABLE IF NOT EXISTS settings (
       key TEXT PRIMARY KEY,
       value TEXT
     )`,
    `CREATE TABLE IF NOT EXISTS patients (
       id TEXT PRIMARY KEY,
       nom TEXT NOT NULL,
       prenom TEXT NOT NULL,
       date_naissance TEXT,
       email TEXT,
       telephone TEXT,
       adresse TEXT,
       mutuelle TEXT,
       mon_soutien_psy INTEGER DEFAULT 0,
       motif TEXT,
       notes_generales TEXT,
       date_creation TEXT NOT NULL,
       actif INTEGER DEFAULT 1,
       cloture INTEGER DEFAULT 0,
       rgpd INTEGER DEFAULT 0
     )`,
    `CREATE TABLE IF NOT EXISTS seances (
       id TEXT PRIMARY KEY,
       patient_id TEXT,
       date TEXT NOT NULL,
       heure TEXT,
       duree INTEGER,
       type TEXT,
       statut TEXT DEFAULT 'planifie',
       facture INTEGER DEFAULT 0,
       note_ics TEXT,
       uid TEXT,
       note_interne TEXT
     )`,
    `CREATE TABLE IF NOT EXISTS factures (
       id TEXT PRIMARY KEY,
       patient_id TEXT NOT NULL,
       seance_id TEXT,
       numero TEXT NOT NULL UNIQUE,
       date TEXT NOT NULL,
       montant REAL NOT NULL,
       prestation TEXT,
       duree INTEGER,
       statut TEXT DEFAULT 'en_attente',
       mode_paiement TEXT,
       date_paiement TEXT,
       notes_privees TEXT,
       date_creation TEXT,
       num_seq INTEGER
     )`,
    `CREATE TABLE IF NOT EXISTS charges (
       id TEXT PRIMARY KEY,
       date TEXT NOT NULL,
       libelle TEXT NOT NULL,
       montant REAL NOT NULL,
       categorie TEXT
     )`,
    `CREATE TABLE IF NOT EXISTS notes_cliniques (
       id TEXT PRIMARY KEY,
       patient_id TEXT NOT NULL,
       seance_id TEXT,
       date TEXT NOT NULL,
       template TEXT DEFAULT 'libre',
       contenu TEXT,
       date_creation TEXT NOT NULL,
       date_modification TEXT
     )`,
    `CREATE TABLE IF NOT EXISTS questionnaires (
       id TEXT PRIMARY KEY,
       patient_id TEXT NOT NULL,
       type TEXT NOT NULL,
       date TEXT NOT NULL,
       reponses TEXT NOT NULL,
       score INTEGER NOT NULL,
       interpretation TEXT
     )`,
    `CREATE TABLE IF NOT EXISTS objectifs (
       id TEXT PRIMARY KEY,
       patient_id TEXT NOT NULL,
       type TEXT NOT NULL,
       domaine TEXT,
       contenu TEXT NOT NULL,
       statut TEXT DEFAULT 'en_cours',
       date_creation TEXT NOT NULL,
       notes_progression TEXT,
       realise INTEGER DEFAULT 0
     )`,
    `CREATE TABLE IF NOT EXISTS anamnese (
       id TEXT PRIMARY KEY,
       patient_id TEXT NOT NULL UNIQUE,
       motif_principal TEXT, motif_depuis TEXT, tentatives_anterieures TEXT,
       contexte_apparition TEXT, facteurs_declenchants TEXT, evolution TEXT,
       atcd_personnels TEXT, atcd_familiaux TEXT, hospitalisations TEXT, traumatismes TEXT,
       situation_pro TEXT, situation_familiale TEXT, enfants TEXT, lieu_vie TEXT,
       traitements TEXT, autres_suivis TEXT,
       hypotheses_diagnostiques TEXT, orientation_therapeutique TEXT,
       objectifs_prise_en_charge TEXT, indication_suivi TEXT,
       date_creation TEXT, date_modification TEXT,
       FOREIGN KEY (patient_id) REFERENCES patients(id)
     )`,
    `CREATE TABLE IF NOT EXISTS documents (
       id TEXT PRIMARY KEY,
       patient_id TEXT,
       type TEXT NOT NULL,
       titre TEXT NOT NULL,
       contenu TEXT NOT NULL,
       statut TEXT DEFAULT 'brouillon',
       destinataire TEXT,
       date_creation TEXT NOT NULL,
       date_modification TEXT,
       FOREIGN KEY (patient_id) REFERENCES patients(id)
     )`,
    `CREATE TABLE IF NOT EXISTS pwa_codes (
       code TEXT PRIMARY KEY,
       patient_id TEXT NOT NULL,
       questionnaire TEXT NOT NULL,
       created_at TEXT NOT NULL,
       expires_at TEXT NOT NULL,
       imported INTEGER DEFAULT 0
     )`,
    `CREATE TABLE IF NOT EXISTS questionnaire_codes (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       patient_id TEXT NOT NULL,
       code TEXT NOT NULL UNIQUE,
       questionnaire_slug TEXT NOT NULL,
       date_creation TEXT NOT NULL,
       date_expiration TEXT NOT NULL,
       statut TEXT NOT NULL DEFAULT 'en_attente',
       date_completion TEXT,
       FOREIGN KEY (patient_id) REFERENCES patients(id)
     )`,
    `CREATE TABLE IF NOT EXISTS questionnaire_resultats (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       patient_id TEXT NOT NULL,
       questionnaire_slug TEXT NOT NULL,
       code TEXT NOT NULL,
       date_passation TEXT NOT NULL,
       score_total INTEGER,
       interpretation TEXT,
       details_json TEXT,
       synchro_date TEXT NOT NULL,
       FOREIGN KEY (patient_id) REFERENCES patients(id)
     )`,
    `CREATE TABLE IF NOT EXISTS alertes_questionnaires (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       patient_id TEXT NOT NULL,
       questionnaire_slug TEXT NOT NULL,
       code TEXT NOT NULL,
       date_passation TEXT NOT NULL,
       type_alerte TEXT NOT NULL,
       message TEXT NOT NULL,
       score_actuel INTEGER,
       score_precedent INTEGER,
       lu INTEGER DEFAULT 0,
       date_creation TEXT NOT NULL,
       FOREIGN KEY (patient_id) REFERENCES patients(id)
     )`,
  ];
  for (const sql of tables) {
    await db.execute(sql);
  }
  // Migrations — colonnes ajoutées après la création initiale
  const migrations = [
    'ALTER TABLE patients ADD COLUMN source_orientation TEXT',
    'ALTER TABLE pwa_codes ADD COLUMN imported INTEGER DEFAULT 0',
    'ALTER TABLE questionnaire_resultats ADD COLUMN consentement_recueilli INTEGER DEFAULT 0',
    'ALTER TABLE seances ADD COLUMN mode TEXT DEFAULT \'presentiel\'',
    'ALTER TABLE seances ADD COLUMN honoraires REAL',
    'ALTER TABLE seances ADD COLUMN lien_visio TEXT',
    'ALTER TABLE factures ADD COLUMN type TEXT DEFAULT \'facture\'',
    'ALTER TABLE factures ADD COLUMN facture_origine_id TEXT',
    'ALTER TABLE factures ADD COLUMN type_prestation TEXT DEFAULT \'soin\'',
  ];
  for (const sql of migrations) {
    try { await db.execute(sql); } catch (_) {}
  }
}

// ─── Chargement complet (→ state) ─────────────────────────────────────────────

/**
 * Charge toutes les tables et retourne un objet compatible avec state{} de main.js.
 * Les données cliniques (notes, questionnaires, objectifs) sont incluses par patient.
 */
export async function loadAll(db) {
  // Requêtes séquentielles (pas de Promise.all) : avec un pool de connexions,
  // des lectures concurrentes peuvent ouvrir plusieurs connexions SQLite en
  // parallèle, dont certaines sans le PRAGMA busy_timeout posé après coup sur
  // la première — ça provoque un "database is locked" si une écriture
  // survient en même temps (ex. autoBackup() au démarrage + création patient).
  const settingsRows = await db.select('SELECT key, value FROM settings');
  const patientRows = await db.select('SELECT * FROM patients WHERE actif = 1 ORDER BY nom, prenom');
  const seanceRows = await db.select('SELECT * FROM seances ORDER BY date DESC, heure DESC');
  const factureRows = await db.select('SELECT * FROM factures ORDER BY date DESC');
  const chargeRows = await db.select('SELECT * FROM charges ORDER BY date DESC');
  const noteRows = await db.select('SELECT * FROM notes_cliniques ORDER BY date DESC');
  const questionnaireRows = await db.select('SELECT * FROM questionnaires ORDER BY date ASC');
  const objectifRows = await db.select('SELECT * FROM objectifs');

  // Settings → objet
  const settings = {};
  for (const row of settingsRows) {
    settings[row.key] = row.value;
  }
  // Cast numériques
  if (settings.tauxUrssaf) settings.tauxUrssaf = parseFloat(settings.tauxUrssaf);
  if (settings.tarifConsultation) settings.tarifConsultation = parseFloat(settings.tarifConsultation);
  if (settings.dureeConsultation) settings.dureeConsultation = parseInt(settings.dureeConsultation);
  if (settings.objectifCA) settings.objectifCA = parseFloat(settings.objectifCA);
  if (settings.honorairesDefaut) settings.honorairesDefaut = parseFloat(settings.honorairesDefaut) || null;
  if (settings.dureeAgenda) settings.dureeAgenda = parseInt(settings.dureeAgenda) || null;

  // nextFactureNum
  const nextFactureNum = parseInt(settings._nextFactureNum || '1');
  delete settings._nextFactureNum;

  // Patients → camelCase + données cliniques imbriquées
  const patients = patientRows.map(row => {
    const patientId = row.id;

    // Notes cliniques
    const notes = noteRows
      .filter(n => n.patient_id === patientId)
      .map(n => ({
        id: n.id, date: n.date,
        seanceId: n.seance_id || null,
        template: n.template,
        contenu: n.contenu || '',
        dateCreation: n.date_creation,
      }));

    // Questionnaires
    const questionnaires = questionnaireRows
      .filter(q => q.patient_id === patientId)
      .map(q => ({
        id: q.id, type: q.type, date: q.date,
        reponses: JSON.parse(q.reponses || '[]'),
        score: q.score,
        interpretation: q.interpretation,
      }));

    // Objectifs (valeurs + objectifs + engagements)
    const objRows = objectifRows.filter(o => o.patient_id === patientId);
    const valeurs = {};
    const objectifsArr = [];
    const engagements = [];
    for (const o of objRows) {
      if (o.type === 'valeur') {
        valeurs[o.domaine] = o.contenu;
      } else if (o.type === 'objectif') {
        objectifsArr.push({
          id: o.id, intitule: o.contenu, domaine: o.domaine,
          statut: o.statut, notes: o.notes_progression || '',
          dateCreation: o.date_creation,
        });
      } else if (o.type === 'engagement') {
        engagements.push({
          id: o.id, texte: o.contenu,
          date: o.date_creation, realise: o.realise === 1,
        });
      }
    }

    return {
      id: row.id,
      prenom: row.prenom,
      nom: row.nom,
      naissance: row.date_naissance || '',
      tel: row.telephone || '',
      email: row.email || '',
      motif: row.motif || '',
      dateCreation: row.date_creation,
      rgpd: row.rgpd === 1,
      cloture: row.cloture === 1,
      sourceOrientation: row.source_orientation || '',
      notes,
      questionnaires,
      objectifs: { valeurs, objectifs: objectifsArr, engagements },
    };
  });

  // Séances → camelCase
  const seances = seanceRows.map(row => ({
    id: row.id,
    patientId: row.patient_id || null,
    date: row.date,
    heure: row.heure || '',
    duree: row.duree || 50,
    type: row.type || 'individuel',
    statut: row.statut || 'planifie',
    facture: row.facture === 1,
    note: row.note_ics || '',
    uid: row.uid || null,
    noteInterne: row.note_interne || '',
    mode: row.mode || 'presentiel',
    honoraires: row.honoraires ?? null,
    lienVisio: row.lien_visio || '',
  }));

  // Factures → camelCase
  const factures = factureRows.map(row => ({
    id: row.id,
    numero: row.numero,
    patientId: row.patient_id,
    date: row.date,
    montant: row.montant,
    prestation: row.prestation || 'Consultation psychologique',
    duree: row.duree || 50,
    statut: row.statut || 'en_attente',
    notes: row.notes_privees || '',
    dateCreation: row.date_creation || row.date,
    numSeq: row.num_seq || 0,
    type: row.type || 'facture',
    factureOrigineId: row.facture_origine_id || null,
    typePrestation: row.type_prestation || 'soin',
  }));

  // Charges → camelCase
  const charges = chargeRows.map(row => ({
    id: row.id,
    desc: row.libelle,
    montant: row.montant,
    cat: row.categorie || 'autre',
    date: row.date,
  }));

  return { patients, factures, seances, charges, settings, nextFactureNum };
}

// ─── Sauvegarde complète (state → DB) ─────────────────────────────────────────

/**
 * Écrase toutes les tables avec l'état courant de state{}.
 * Utilise INSERT OR REPLACE pour gérer créations et mises à jour.
 */
export async function saveAll(db, state) {
  await db.execute('BEGIN IMMEDIATE');
  try {
    await saveSettings(db, state);
    await savePatientsAll(db, state.patients);
    await saveSeancesAll(db, state.seances);
    await saveFacturesAll(db, state.factures);
    await saveChargesAll(db, state.charges);
    await db.execute('COMMIT');
  } catch (originalError) {
    try { await db.execute('ROLLBACK'); } catch (_) {}
    throw originalError;
  }
}

// Source unique de vérité pour la sérialisation des settings
function buildSettingsPairs(settings, nextFactureNum) {
  const s = settings;
  return [
    ['prenom', s.prenom || ''],
    ['nom', s.nom || ''],
    ['rpps', s.rpps || ''],
    ['siret', s.siret || ''],
    ['adresse', s.adresse || ''],
    ['tel', s.tel || ''],
    ['email', s.email || ''],
    ['tauxUrssaf', String(s.tauxUrssaf ?? 23.2)],
    ['tarifConsultation', String(s.tarifConsultation ?? 60)],
    ['dureeConsultation', String(s.dureeConsultation ?? 50)],
    ['calendlyUrl', s.calendlyUrl || ''],
    ['objectifCA', String(s.objectifCA ?? 0)],
    ['pwaUrl', s.pwaUrl || ''],
    ['pwaApiKey', s.pwaApiKey || ''],
    ['honorairesDefaut', String(s.honorairesDefaut ?? '')],
    ['dureeAgenda', String(s.dureeAgenda ?? '')],
    ['heureDebut', s.heureDebut || '08:00'],
    ['heureFin', s.heureFin || '19:00'],
    ['_nextFactureNum', String(nextFactureNum ?? 1)],
    ['_derniereSynchro', s._derniereSynchro || ''],
  ];
}

async function saveSettings(db, state) {
  await db.execute('DELETE FROM settings');
  for (const [key, value] of buildSettingsPairs(state.settings, state.nextFactureNum)) {
    await db.execute('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value]);
  }
}

async function savePatientsAll(db, patients) {
  await db.execute('DELETE FROM patients');
  await db.execute('DELETE FROM notes_cliniques');
  await db.execute('DELETE FROM questionnaires');
  await db.execute('DELETE FROM objectifs');

  for (const p of patients) {
    await db.execute(
      `INSERT INTO patients (id,nom,prenom,date_naissance,email,telephone,motif,
         notes_generales,date_creation,actif,cloture,rgpd,source_orientation)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        String(p.id), p.nom, p.prenom, p.naissance || null, p.email || null,
        p.tel || null, p.motif || null, null,
        p.dateCreation || new Date().toISOString(),
        1, p.cloture ? 1 : 0, p.rgpd ? 1 : 0,
        p.sourceOrientation || null,
      ]
    );

    // Notes cliniques
    for (const n of (p.notes || [])) {
      await db.execute(
        `INSERT INTO notes_cliniques (id,patient_id,seance_id,date,template,contenu,date_creation)
         VALUES (?,?,?,?,?,?,?)`,
        [String(n.id), String(p.id), n.seanceId || null, n.date,
         n.template || 'libre', n.contenu || '', n.dateCreation || n.date]
      );
    }

    // Questionnaires
    for (const q of (p.questionnaires || [])) {
      await db.execute(
        `INSERT INTO questionnaires (id,patient_id,type,date,reponses,score,interpretation)
         VALUES (?,?,?,?,?,?,?)`,
        [String(q.id), String(p.id), q.type, q.date,
         JSON.stringify(q.reponses || []), q.score, q.interpretation || null]
      );
    }

    // Objectifs : valeurs
    const obj = p.objectifs || {};
    for (const [domaine, contenu] of Object.entries(obj.valeurs || {})) {
      if (!contenu) continue;
      const vid = `${p.id}_v_${domaine}`;
      await db.execute(
        `INSERT OR REPLACE INTO objectifs (id,patient_id,type,domaine,contenu,statut,date_creation)
         VALUES (?,?,?,?,?,?,?)`,
        [vid, String(p.id), 'valeur', domaine, contenu, 'en_cours', new Date().toISOString()]
      );
    }
    // Objectifs : objectifs thérapeutiques
    for (const o of (obj.objectifs || [])) {
      await db.execute(
        `INSERT OR REPLACE INTO objectifs (id,patient_id,type,domaine,contenu,statut,date_creation,notes_progression)
         VALUES (?,?,?,?,?,?,?,?)`,
        [String(o.id), String(p.id), 'objectif', o.domaine || null, o.intitule,
         o.statut || 'en_cours', o.dateCreation || new Date().toISOString(), o.notes || null]
      );
    }
    // Objectifs : engagements
    for (const e of (obj.engagements || [])) {
      await db.execute(
        `INSERT OR REPLACE INTO objectifs (id,patient_id,type,contenu,realise,date_creation)
         VALUES (?,?,?,?,?,?)`,
        [String(e.id), String(p.id), 'engagement', e.texte, e.realise ? 1 : 0, e.date || new Date().toISOString()]
      );
    }
  }
}

async function saveSeancesAll(db, seances) {
  await db.execute('DELETE FROM seances');
  for (const s of seances) {
    await db.execute(
      `INSERT INTO seances (id,patient_id,date,heure,duree,type,statut,facture,note_ics,uid,note_interne,mode,honoraires,lien_visio)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        String(s.id), s.patientId ? String(s.patientId) : null, s.date,
        s.heure || null, s.duree || 50, s.type || 'individuel',
        s.statut || 'planifie', s.facture ? 1 : 0,
        s.note || null, s.uid || null, s.noteInterne || null,
        s.mode || 'presentiel', s.honoraires ?? null, s.lienVisio || null,
      ]
    );
  }
}

async function saveFacturesAll(db, factures) {
  await db.execute('DELETE FROM factures');
  for (const f of factures) {
    await db.execute(
      `INSERT INTO factures (id,patient_id,numero,date,montant,prestation,duree,statut,
         notes_privees,date_creation,num_seq,type,facture_origine_id,type_prestation)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        String(f.id), String(f.patientId), f.numero, f.date, f.montant,
        f.prestation || 'Consultation psychologique', f.duree || 50,
        f.statut || 'en_attente', f.notes || null,
        f.dateCreation || f.date, f.numSeq || 0,
        f.type || 'facture', f.factureOrigineId || null, f.typePrestation || 'soin',
      ]
    );
  }
}

async function saveChargesAll(db, charges) {
  await db.execute('DELETE FROM charges');
  for (const c of charges) {
    await db.execute(
      'INSERT INTO charges (id,date,libelle,montant,categorie) VALUES (?,?,?,?,?)',
      [String(c.id), c.date, c.desc, c.montant, c.cat || 'autre']
    );
  }
}

// ─── Sauvegarde ciblée des settings ───────────────────────────────────────────

/**
 * Sauvegarde uniquement les settings — sans transaction globale,
 * sans toucher aux patients/séances/factures.
 */
export async function saveSettingsOnly(db, settings, nextFactureNum) {
  for (const [key, value] of buildSettingsPairs(settings, nextFactureNum)) {
    await db.execute('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value]);
  }
}

// ─── Anamnèse ──────────────────────────────────────────────────────────────────

export async function getAnamnese(db, patientId) {
  const rows = await db.select('SELECT * FROM anamnese WHERE patient_id = ?', [patientId]);
  if (!rows.length) return null;
  const r = rows[0];
  return { ...r, traitements: JSON.parse(r.traitements || '[]') };
}

export async function saveAnamnese(db, patientId, data) {
  const now = new Date().toISOString();
  const existing = await db.select('SELECT id, date_creation FROM anamnese WHERE patient_id = ?', [patientId]);
  const id = existing.length ? existing[0].id : crypto.randomUUID();
  const dateCreation = existing.length ? existing[0].date_creation || now : now;
  await db.execute(
    `INSERT OR REPLACE INTO anamnese (id,patient_id,motif_principal,motif_depuis,tentatives_anterieures,
     contexte_apparition,facteurs_declenchants,evolution,atcd_personnels,atcd_familiaux,hospitalisations,
     traumatismes,situation_pro,situation_familiale,enfants,lieu_vie,traitements,autres_suivis,
     hypotheses_diagnostiques,orientation_therapeutique,objectifs_prise_en_charge,indication_suivi,
     date_creation,date_modification)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, patientId,
     data.motif_principal||null, data.motif_depuis||null, data.tentatives_anterieures||null,
     data.contexte_apparition||null, data.facteurs_declenchants||null, data.evolution||null,
     data.atcd_personnels||null, data.atcd_familiaux||null, data.hospitalisations||null,
     data.traumatismes||null, data.situation_pro||null, data.situation_familiale||null,
     data.enfants||null, data.lieu_vie||null,
     JSON.stringify(data.traitements||[]), data.autres_suivis||null,
     data.hypotheses_diagnostiques||null, data.orientation_therapeutique||null,
     data.objectifs_prise_en_charge||null, data.indication_suivi||null,
     dateCreation, now]
  );
}

// ─── Recherche globale ─────────────────────────────────────────────────────────

export async function searchAll(db, query) {
  const like = `%${query}%`;
  const patients = await db.select(`SELECT id, nom, prenom FROM patients WHERE LOWER(nom || ' ' || prenom) LIKE LOWER(?) AND actif = 1 LIMIT 5`, [like]);
  const notes = await db.select(`SELECT id, patient_id, date, template, contenu FROM notes_cliniques WHERE LOWER(contenu) LIKE LOWER(?) ORDER BY date DESC LIMIT 5`, [like]);
  const factures = await db.select(`SELECT id, numero, date, montant, statut, patient_id FROM factures WHERE LOWER(numero) LIKE LOWER(?) LIMIT 5`, [like]);
  const seances = await db.select(`SELECT id, date, heure, patient_id, type FROM seances WHERE date LIKE ? OR note_ics LIKE ? LIMIT 5`, [like, like]);
  return { patients, notes, factures, seances };
}

// ─── Migration JSON → SQLite ───────────────────────────────────────────────────

const JSON_PATH = 'PsyGest/data.json';
const JSON_BAK  = 'PsyGest/data.json.bak';

/**
 * Si data.json existe, importe les données et renomme le fichier en .bak.
 * Retourne true si une migration a eu lieu.
 */
export async function migrateFromJSON(db) {
  const hasJson = await exists(JSON_PATH, { baseDir: BaseDirectory.Document });
  if (!hasJson) return false;

  let json;
  try {
    const content = await readTextFile(JSON_PATH, { baseDir: BaseDirectory.Document });
    json = JSON.parse(content);
  } catch (e) {
    console.error('Migration : impossible de lire data.json', e);
    return false;
  }

  // Vérifie qu'il ne s'agit pas déjà d'un marqueur de migration
  if (json._migrated) return false;

  console.log('Migration data.json → SQLite...');

  // Construit un state compatible et le sauvegarde
  const migState = {
    patients: (json.patients || []).map(p => ({
      ...p,
      id: String(p.id),
      notes: (p.notes || []).map(n => ({ ...n, id: String(n.id) })),
      questionnaires: (p.questionnaires || []).map(q => ({ ...q, id: String(q.id) })),
      objectifs: p.objectifs || { valeurs: {}, objectifs: [], engagements: [] },
    })),
    factures: (json.factures || []).map(f => ({ ...f, id: String(f.id), patientId: String(f.patientId) })),
    seances: (json.seances || []).map(s => ({ ...s, id: String(s.id), patientId: s.patientId ? String(s.patientId) : null })),
    charges: (json.charges || []).map(c => ({ ...c, id: String(c.id) })),
    settings: json.settings || {},
    nextFactureNum: json.nextFactureNum || 1,
  };

  await saveAll(db, migState);

  // Écrit le backup et marque le JSON comme migré
  await writeTextFile(JSON_BAK, JSON.stringify(json, null, 2), { baseDir: BaseDirectory.Document });
  await writeTextFile(JSON_PATH, JSON.stringify({ _migrated: true, date: new Date().toISOString() }), { baseDir: BaseDirectory.Document });

  console.log('Migration terminée.');
  return true;
}

// ─── Documents ────────────────────────────────────────────────────────────────

export async function getDocuments(db) {
  return await db.select(`
    SELECT d.*, p.prenom || ' ' || p.nom AS patient_nom
    FROM documents d
    LEFT JOIN patients p ON d.patient_id = p.id
    ORDER BY d.date_creation DESC
  `);
}

export async function getDocumentsByPatient(db, patientId) {
  return await db.select(
    'SELECT * FROM documents WHERE patient_id = ? ORDER BY date_creation DESC',
    [patientId]
  );
}

export async function getDocument(db, id) {
  const rows = await db.select('SELECT * FROM documents WHERE id = ?', [id]);
  return rows[0] || null;
}

export async function createDocument(db, data) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.execute(
    `INSERT INTO documents (id, patient_id, type, titre, contenu, statut, destinataire, date_creation, date_modification)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, data.patient_id || null, data.type, data.titre, data.contenu,
     data.statut || 'brouillon', data.destinataire || null, now, now]
  );
  return id;
}

export async function updateDocument(db, id, data) {
  const now = new Date().toISOString();
  await db.execute(
    `UPDATE documents SET type=?, titre=?, contenu=?, statut=?, destinataire=?, date_modification=? WHERE id=?`,
    [data.type, data.titre, data.contenu, data.statut, data.destinataire || null, now, id]
  );
}

export async function deleteDocument(db, id) {
  await db.execute('DELETE FROM documents WHERE id = ?', [id]);
}

// ─── Suppression RGPD (droit à l'effacement, art. 17) ──────────────────────────

/**
 * Purge toutes les données liées à un patient dans les tables NON couvertes par
 * saveAll() — anamnèse, documents générés, codes/résultats/alertes de la PWA
 * questionnaires. (patients/factures/seances/notes_cliniques/questionnaires/
 * objectifs sont purgés séparément par saveAll() une fois le patient retiré de
 * state en mémoire.) Sans ce nettoyage, "supprimer" un dossier ne supprime en
 * réalité ni l'anamnèse ni les courriers/attestations générés — le vrai contenu
 * clinique restait orphelin dans la base malgré la disparition du patient de
 * l'interface.
 */
export async function deletePatientCascade(db, patientId) {
  const id = String(patientId);
  await db.execute('BEGIN IMMEDIATE');
  try {
    await db.execute('DELETE FROM anamnese WHERE patient_id = ?', [id]);
    await db.execute('DELETE FROM documents WHERE patient_id = ?', [id]);
    await db.execute('DELETE FROM questionnaire_codes WHERE patient_id = ?', [id]);
    await db.execute('DELETE FROM questionnaire_resultats WHERE patient_id = ?', [id]);
    await db.execute('DELETE FROM alertes_questionnaires WHERE patient_id = ?', [id]);
    await db.execute('DELETE FROM pwa_codes WHERE patient_id = ?', [id]);
    await db.execute('COMMIT');
  } catch (e) {
    try { await db.execute('ROLLBACK'); } catch (_) {}
    throw e;
  }
}

// ─── Export / Import complet ───────────────────────────────────────────────────

/** Sérialise toutes les tables en un objet JSON exportable. */
export async function exportAllData(db) {
  const patients = await db.select('SELECT * FROM patients');
  const factures = await db.select('SELECT * FROM factures');
  const seances = await db.select('SELECT * FROM seances');
  const charges = await db.select('SELECT * FROM charges');
  const settingsRows = await db.select('SELECT key, value FROM settings');
  const notes = await db.select('SELECT * FROM notes_cliniques');
  const questionnaires = await db.select('SELECT * FROM questionnaires');
  const objectifs = await db.select('SELECT * FROM objectifs');
  const anamnese = await db.select('SELECT * FROM anamnese');
  const documents = await db.select('SELECT * FROM documents');
  const questionnaire_codes = await db.select('SELECT * FROM questionnaire_codes');
  const questionnaire_resultats = await db.select('SELECT * FROM questionnaire_resultats');
  const alertes_questionnaires = await db.select('SELECT * FROM alertes_questionnaires');
  const settings = Object.fromEntries(settingsRows.map(r => [r.key, r.value]));
  return {
    patients, factures, seances, charges, settings, notes, questionnaires, objectifs,
    anamnese, documents, questionnaire_codes, questionnaire_resultats, alertes_questionnaires,
    _version: 2,
  };
}

// Colonnes réelles de chaque table (tenues à jour avec applySchema, migrations incluses).
// Listées explicitement (plutôt que déduites des clés du JSON importé) pour éviter
// toute injection via des noms de colonnes arbitraires dans un fichier importé.
const TABLE_COLUMNS = {
  patients: ['id','nom','prenom','date_naissance','email','telephone','adresse','mutuelle',
    'mon_soutien_psy','motif','notes_generales','date_creation','actif','cloture','rgpd',
    'source_orientation'],
  seances: ['id','patient_id','date','heure','duree','type','statut','facture','note_ics','uid',
    'note_interne','mode','honoraires','lien_visio'],
  factures: ['id','patient_id','seance_id','numero','date','montant','prestation','duree','statut',
    'mode_paiement','date_paiement','notes_privees','date_creation','num_seq','type','facture_origine_id',
    'type_prestation'],
  charges: ['id','date','libelle','montant','categorie'],
  notes_cliniques: ['id','patient_id','seance_id','date','template','contenu','date_creation','date_modification'],
  questionnaires: ['id','patient_id','type','date','reponses','score','interpretation'],
  objectifs: ['id','patient_id','type','domaine','contenu','statut','date_creation','notes_progression','realise'],
  anamnese: ['id','patient_id','motif_principal','motif_depuis','tentatives_anterieures',
    'contexte_apparition','facteurs_declenchants','evolution','atcd_personnels','atcd_familiaux',
    'hospitalisations','traumatismes','situation_pro','situation_familiale','enfants','lieu_vie',
    'traitements','autres_suivis','hypotheses_diagnostiques','orientation_therapeutique',
    'objectifs_prise_en_charge','indication_suivi','date_creation','date_modification'],
  documents: ['id','patient_id','type','titre','contenu','statut','destinataire','date_creation','date_modification'],
  questionnaire_codes: ['id','patient_id','code','questionnaire_slug','date_creation','date_expiration','statut','date_completion'],
  questionnaire_resultats: ['id','patient_id','questionnaire_slug','code','date_passation','score_total',
    'interpretation','details_json','synchro_date','consentement_recueilli'],
  alertes_questionnaires: ['id','patient_id','questionnaire_slug','code','date_passation','type_alerte',
    'message','score_actuel','score_precedent','lu','date_creation'],
};

/** Importe un backup v2 (tables brutes) ou v1 (ancien state{}) dans la DB. */
export async function importAllData(db, data) {
  if (data._version === 2) {
    // Backup v2 : tables brutes
    await db.execute('BEGIN TRANSACTION');
    try {
      for (const table of ['settings', ...Object.keys(TABLE_COLUMNS)]) {
        await db.execute(`DELETE FROM ${table}`);
      }
      for (const [table, columns] of Object.entries(TABLE_COLUMNS)) {
        const placeholders = columns.map(() => '?').join(',');
        const sql = `INSERT INTO ${table} (${columns.join(',')}) VALUES (${placeholders})`;
        for (const row of (data[table] || [])) {
          // Colonnes absentes du backup (ajoutées par une migration depuis) → null,
          // rattrapé au chargement par les valeurs par défaut de loadAll().
          await db.execute(sql, columns.map(c => row[c] ?? null));
        }
      }
      for (const [key, value] of Object.entries(data.settings || {})) {
        await db.execute('INSERT OR REPLACE INTO settings VALUES (?,?)', [key, String(value)]);
      }
      await db.execute('COMMIT');
    } catch (e) {
      await db.execute('ROLLBACK');
      throw e;
    }
  } else {
    // Backup v1 (ancien data.json) : réutilise migrateFromJSON logic via saveAll
    const migState = {
      patients: (data.patients || []).map(p => ({ ...p, id: String(p.id) })),
      factures: (data.factures || []).map(f => ({ ...f, id: String(f.id), patientId: String(f.patientId) })),
      seances: (data.seances || []).map(s => ({ ...s, id: String(s.id) })),
      charges: (data.charges || []).map(c => ({ ...c, id: String(c.id) })),
      settings: data.settings || {},
      nextFactureNum: data.nextFactureNum || 1,
    };
    await saveAll(db, migState);
  }
}

// ─── Sauvegarde automatique locale ─────────────────────────────────────────────

const BACKUPS_DIR = 'PsyGest/backups';
const AUTO_BACKUP_RETENTION = 30; // conserve les 30 dernières sauvegardes auto (~1 mois à raison d'1/jour)

/**
 * Écrit un export JSON complet dans ~/Documents/PsyGest/backups/ une fois par
 * jour (au premier lancement de la journée), puis purge les plus anciennes
 * au-delà de AUTO_BACKUP_RETENTION. Ce dossier peut ensuite être répliqué vers
 * un NAS/serveur par un outil externe (Syncthing, etc.) — PsyGest ne parle à
 * aucun serveur distant lui-même.
 * Best-effort : une erreur ici ne doit jamais empêcher le démarrage de l'app.
 * Retourne true si une nouvelle sauvegarde a été écrite.
 */
export async function autoBackup(db) {
  try {
    await mkdir(BACKUPS_DIR, { baseDir: BaseDirectory.Document, recursive: true });
    const todayStr = new Date().toISOString().slice(0, 10);
    const filePath = `${BACKUPS_DIR}/psygest-backup-${todayStr}.json`;
    if (await exists(filePath, { baseDir: BaseDirectory.Document })) return false;

    const data = await exportAllData(db);
    await writeTextFile(filePath, JSON.stringify(data, null, 2), { baseDir: BaseDirectory.Document });

    const entries = await readDir(BACKUPS_DIR, { baseDir: BaseDirectory.Document });
    const files = entries
      .map(e => e.name)
      .filter(n => n && /^psygest-backup-\d{4}-\d{2}-\d{2}\.json$/.test(n))
      .sort(); // tri lexical = tri chronologique (format AAAA-MM-JJ)
    const toDelete = files.slice(0, Math.max(0, files.length - AUTO_BACKUP_RETENTION));
    for (const f of toDelete) {
      try { await remove(`${BACKUPS_DIR}/${f}`, { baseDir: BaseDirectory.Document }); } catch (_) {}
    }
    return true;
  } catch (e) {
    console.error('autoBackup:', e);
    return false;
  }
}

// ─── Questionnaire Codes (Phase 3) ────────────────────────────────────────────

export async function createQuestionnaireCode(db, { patientId, code, slug, dateCreation, dateExpiration }) {
  await db.execute(
    `INSERT INTO questionnaire_codes (patient_id, code, questionnaire_slug, date_creation, date_expiration, statut)
     VALUES (?, ?, ?, ?, ?, 'en_attente')`,
    [patientId, code, slug, dateCreation, dateExpiration]
  );
}

export async function getQuestionnaireCodesByPatient(db, patientId) {
  return db.select(
    `SELECT * FROM questionnaire_codes WHERE patient_id = ? ORDER BY date_creation DESC`,
    [patientId]
  );
}

export async function updateQuestionnaireCodeStatut(db, code, statut, dateCompletion = null) {
  await db.execute(
    `UPDATE questionnaire_codes SET statut = ?, date_completion = ? WHERE code = ?`,
    [statut, dateCompletion, code]
  );
}

export async function getQuestionnaireCodeByCode(db, code) {
  const rows = await db.select(`SELECT * FROM questionnaire_codes WHERE code = ?`, [code]);
  return rows[0] || null;
}

export async function expireQuestionnaireCodesLocally(db) {
  const now = new Date().toISOString();
  await db.execute(
    `UPDATE questionnaire_codes SET statut = 'expiré'
     WHERE statut = 'en_attente' AND date_expiration < ?`,
    [now]
  );
}

// ─── Questionnaire Résultats (Phase 3) ────────────────────────────────────────

export async function insertQuestionnaireResultat(db, { patientId, slug, code, datePassation, scoreTotal, interpretation, detailsJson, synchroDate, consentementRecueilli = 0 }) {
  const existing = await db.select(
    `SELECT id FROM questionnaire_resultats WHERE code = ?`, [code]
  );
  if (existing.length) return; // déjà importé
  await db.execute(
    `INSERT INTO questionnaire_resultats
       (patient_id, questionnaire_slug, code, date_passation, score_total, interpretation, details_json, synchro_date, consentement_recueilli)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [patientId, slug, code, datePassation, scoreTotal, interpretation, detailsJson, synchroDate, consentementRecueilli ? 1 : 0]
  );
}

export async function getResultatsByPatient(db, patientId) {
  return db.select(
    `SELECT * FROM questionnaire_resultats WHERE patient_id = ? ORDER BY date_passation ASC`,
    [patientId]
  );
}

export async function getResultatsByPatientAndSlug(db, patientId, slug) {
  return db.select(
    `SELECT * FROM questionnaire_resultats WHERE patient_id = ? AND questionnaire_slug = ? ORDER BY date_passation ASC`,
    [patientId, slug]
  );
}

// ─── Alertes Questionnaires (Phase 3) ─────────────────────────────────────────

export async function createAlerteQuestionnaire(db, { patientId, slug, code, datePassation, typeAlerte, message, scoreActuel, scorePrecedent }) {
  const now = new Date().toISOString();
  await db.execute(
    `INSERT INTO alertes_questionnaires
       (patient_id, questionnaire_slug, code, date_passation, type_alerte, message, score_actuel, score_precedent, lu, date_creation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    [patientId, slug, code, datePassation, typeAlerte, message, scoreActuel ?? null, scorePrecedent ?? null, now]
  );
}

export async function getAlertesByPatient(db, patientId) {
  return db.select(
    `SELECT * FROM alertes_questionnaires WHERE patient_id = ? ORDER BY date_creation DESC`,
    [patientId]
  );
}

export async function getAlertesNonLues(db) {
  return db.select(
    `SELECT * FROM alertes_questionnaires WHERE lu = 0 ORDER BY date_creation DESC`
  );
}

export async function marquerAlertesLues(db, patientId) {
  await db.execute(
    `UPDATE alertes_questionnaires SET lu = 1 WHERE patient_id = ? AND lu = 0`,
    [patientId]
  );
}

// ─── PWA Codes (legacy) ───────────────────────────────────────────────────────

export async function savePwaCode(db, { code, patientId, questionnaire, createdAt, expiresAt }) {
  await db.execute(
    `INSERT OR REPLACE INTO pwa_codes (code, patient_id, questionnaire, created_at, expires_at, imported)
     VALUES (?, ?, ?, ?, ?, 0)`,
    [code, patientId, questionnaire, createdAt, expiresAt]
  );
}

export async function loadPwaCodes(db) {
  return db.select('SELECT * FROM pwa_codes ORDER BY created_at DESC');
}

export async function markPwaCodeImported(db, code) {
  await db.execute('UPDATE pwa_codes SET imported = 1 WHERE code = ?', [code]);
}
