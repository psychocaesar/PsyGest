import { writeTextFile } from '@tauri-apps/plugin-fs';
import { open as dialogOpen, save as dialogSave, ask, message as dialogMessage } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { initDb, loadAll, saveAll, saveSettingsOnly, migrateFromJSON, exportAllData, importAllData, autoBackup, getAnamnese, saveAnamnese, searchAll, getDocuments, getDocumentsByPatient, getDocument, createDocument, updateDocument, deleteDocument as dbDeleteDocument, deletePatientCascade, savePwaCode, loadPwaCodes, markPwaCodeImported, createQuestionnaireCode, getQuestionnaireCodesByPatient, updateQuestionnaireCodeStatut, getQuestionnaireCodeByCode, expireQuestionnaireCodesLocally, insertQuestionnaireResultat, getResultatsByPatient, getResultatsByPatientAndSlug, createAlerteQuestionnaire, getAlertesByPatient, getAlertesNonLues, marquerAlertesLues } from './db.js';

// ===== STORAGE CONFIG =====
let _db = null; // instance SQLite partagée

const DEFAULT_SETTINGS = {
  prenom: '',
  nom: '',
  rpps: '',
  siret: '',
  adresse: '',
  tel: '',
  email: '',
  tauxUrssaf: 23.2,
  tarifConsultation: 60,
  dureeConsultation: 50,
  calendlyUrl: '',
  objectifCA: 0,
  pwaUrl: '',
  pwaApiKey: '',
};

// ===== STATE =====
let state = {
  patients: [],
  factures: [],
  seances: [],
  charges: [],
  nextFactureNum: 1,
  settings: { ...DEFAULT_SETTINGS },
};

// Current facture ID shown in aperçu (for email button)
let _currentApercuId = null;

let _dbInitFailed = false;
let _dbInitError = '';

async function loadState() {
  try {
    _db = await initDb();
    const migrated = await migrateFromJSON(_db);
    const loaded = await loadAll(_db);
    state.patients = loaded.patients;
    state.factures = loaded.factures;
    state.seances = loaded.seances;
    state.charges = loaded.charges;
    state.nextFactureNum = loaded.nextFactureNum || 1;
    state.settings = { ...DEFAULT_SETTINGS, ...loaded.settings };
    if (migrated) {
      // Affiche la notification après le premier rendu
      setTimeout(() => toast('Migration effectuée — vos données ont été importées dans la nouvelle base de données ✓'), 800);
    }
    // Attendu (pas fire-and-forget) : une sauvegarde en tâche de fond en concurrence
    // avec une écriture (ex. création d'un patient juste après le lancement) peut
    // faire échouer l'écriture avec "database is locked".
    try { await autoBackup(_db); } catch (e) { console.error('autoBackup:', e); }
    return state.patients.length > 0 || state.factures.length > 0 || migrated;
  } catch (e) {
    console.error('loadState:', e);
    _dbInitFailed = true;
    _dbInitError = (e && (e.message || String(e))) || 'erreur inconnue';
    return false;
  }
}

// Mutex pour sérialiser les écritures et éviter SQLITE_BUSY
let _saveMutex = Promise.resolve();
async function saveState() {
  _saveMutex = _saveMutex.then(async () => {
    try {
      if (!_db) { console.warn('saveState: DB non initialisée'); return; }
      await saveAll(_db, state);
    } catch (e) {
      console.error('saveState:', e);
      toast('Erreur lors de la sauvegarde.', 'error');
      const detail = (e && (e.message || String(e))) || 'erreur inconnue';
      dialogMessage(`Détail technique (à transmettre si besoin) :\n\n${detail}`, { title: 'Échec de la sauvegarde', kind: 'error' });
    }
  });
  return _saveMutex;
}

// ===== NAVIGATION =====
const pageNames = {
  dashboard: 'Tableau de bord',
  patients: 'Dossiers patients',
  factures: 'Factures',
  agenda: 'Agenda',
  documents: 'Documents & Courriers',
  'document-editor': 'Éditeur de document',
  charges: 'Charges & URSSAF',
  stats: 'Statistiques',
  settings: 'Réglages',
};

function navigate(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('page-' + page).classList.add('active');
  const btn = document.querySelector(`[data-page="${page}"]`);
  if (btn) btn.classList.add('active');
  document.getElementById('topbar-title').textContent = pageNames[page] || page;
  closeSidebar();
  if (page === 'dashboard') refreshDashboard();
  if (page === 'factures') renderFactures();
  if (page === 'patients') renderPatients();
  if (page === 'charges') refreshCharges();
  if (page === 'stats') refreshStats();
  if (page === 'agenda') renderAgenda();
  if (page === 'documents') renderDocuments();
  if (page === 'settings') loadSettingsForm();
}
window.navigate = navigate;

document.querySelectorAll('[data-page]').forEach(btn => {
  btn.addEventListener('click', () => navigate(btn.dataset.page));
});

// ===== SIDEBAR MOBILE =====
function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('backdrop').classList.add('show');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('backdrop').classList.remove('show');
}
window.openSidebar = openSidebar;
window.closeSidebar = closeSidebar;

// ===== THEME =====
(function () {
  const btn = document.getElementById('themeToggle');
  const root = document.documentElement;
  let dark = matchMedia('(prefers-color-scheme:dark)').matches;
  if (dark) root.setAttribute('data-theme', 'dark');
  btn.addEventListener('click', () => {
    dark = !dark;
    root.setAttribute('data-theme', dark ? 'dark' : 'light');
    btn.innerHTML = dark
      ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>'
      : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  });
})();

// ===== MODAL =====
function openModal(id) {
  if (id === 'modalNewFacture') {
    document.getElementById('f-numero').value = formatNum(state.nextFactureNum);
    populatePatientSelects();
    document.getElementById('f-date').value = today();
    document.getElementById('f-montant').value = state.settings.tarifConsultation || '';
    document.getElementById('f-duree').value = state.settings.dureeConsultation || 50;
  }
  if (id === 'modalNewSeance') {
    populatePatientSelects();
    document.getElementById('s-date').value = today();
  }
  document.getElementById(id).classList.add('open');
}
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
document.querySelectorAll('.modal-overlay').forEach(o => {
  o.addEventListener('click', e => { if (e.target === o) o.classList.remove('open'); });
});
window.openModal = openModal;
window.closeModal = closeModal;

// ===== TOAST =====
function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = 'toast';
  const icon = type === 'success' ? 'check-circle' : type === 'error' ? 'alert-circle' : 'info';
  el.innerHTML = `<i data-lucide="${icon}"></i>${escapeHtml(msg)}`;
  document.getElementById('toasts').appendChild(el);
  lucide.createIcons();
  setTimeout(() => el.remove(), 3500);
}

// ===== HELPERS =====
// Échappe tout texte non fiable (saisi par le praticien ou importé depuis une source
// externe — ICS/Calendly, synchro PWA) avant injection dans un template HTML.
// Toujours utiliser cette fonction plutôt que d'interpoler une chaîne brute dans du
// innerHTML — aucune CSP n'agit comme filet de sécurité par ailleurs.
const _escapeHtmlMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, c => _escapeHtmlMap[c]);
}
function today() { return new Date().toISOString().split('T')[0]; }
function formatNum(n) { return 'FAC-' + new Date().getFullYear() + '-' + String(n).padStart(4, '0'); }
function formatDate(d) { if (!d) return '—'; return new Date(d + 'T12:00:00').toLocaleDateString('fr-FR'); }
function formatAmount(a) { return Number(a).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'; }
function getInitials(prenom, nom) { return ((prenom || '')[0] || '') + ((nom || '')[0] || '').toUpperCase(); }
function urssafRate() { return (state.settings.tauxUrssaf ?? 23.2) / 100; }
function dataFilePath() {
  // Affiche un chemin lisible selon l'OS
  const home = '~';
  return `${home}/Documents/PsyGest/psygest.db`;
}

// ===== PATIENTS =====
async function savePatient() {
  const prenom = document.getElementById('p-prenom').value.trim();
  const nom = document.getElementById('p-nom').value.trim();
  if (!prenom || !nom) { toast('Prénom et nom requis.', 'error'); return; }
  if (!document.getElementById('p-rgpd').checked) { toast('Consentement RGPD requis.', 'error'); return; }
  state.patients.push({
    id: String(Date.now()), prenom, nom,
    naissance: document.getElementById('p-naissance').value,
    tel: document.getElementById('p-tel').value,
    email: document.getElementById('p-email').value,
    motif: document.getElementById('p-motif').value,
    sourceOrientation: document.getElementById('p-source')?.value || '',
    dateCreation: new Date().toISOString(),
    rgpd: true,
  });
  await saveState();
  closeModal('modalNewPatient');
  ['p-prenom', 'p-nom', 'p-naissance', 'p-tel', 'p-email', 'p-motif'].forEach(id => {
    document.getElementById(id).value = '';
  });
  const srcEl = document.getElementById('p-source');
  if (srcEl) srcEl.value = '';
  document.getElementById('p-rgpd').checked = false;
  toast(`Dossier de ${prenom} ${nom} créé ✓`);
  refreshSidebarCounts();
  renderPatients();
  refreshDashboard();
}
window.savePatient = savePatient;

// renderPatients is defined in the clinical section below (with openPatient support)

// ===== FACTURES =====
function populatePatientSelects() {
  ['f-patient', 's-patient'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    sel.innerHTML = '<option value="">Sélectionner…</option>' +
      state.patients.map(p => `<option value="${p.id}">${escapeHtml(p.prenom)} ${escapeHtml(p.nom)}</option>`).join('');
  });
}

async function saveFacture() {
  const patientId = parseInt(document.getElementById('f-patient').value);
  const date = document.getElementById('f-date').value;
  const montant = parseFloat(document.getElementById('f-montant').value);
  if (!patientId || !date || isNaN(montant) || montant <= 0) {
    toast('Veuillez remplir tous les champs requis.', 'error');
    return;
  }
  const facture = {
    id: String(Date.now()),
    numero: formatNum(state.nextFactureNum),
    patientId, date, montant,
    prestation: document.getElementById('f-prestation').value || 'Consultation psychologique',
    duree: document.getElementById('f-duree').value,
    statut: document.getElementById('f-statut').value,
    notes: document.getElementById('f-notes').value,
    dateCreation: new Date().toISOString(),
    numSeq: state.nextFactureNum,
  };
  state.factures.push(facture);
  state.nextFactureNum++;
  await saveState();
  closeModal('modalNewFacture');
  ['f-montant', 'f-notes'].forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('f-patient').value = '';
  toast(`Facture ${facture.numero} créée ✓`);
  refreshSidebarCounts();
  refreshDashboard();
  renderFactures();
}
window.saveFacture = saveFacture;

let _filterText = '';
let _filterStatus = '';
window.filterFactures = v => { _filterText = v.toLowerCase(); renderFactures(); };
window.filterFacturesStatus = v => { _filterStatus = v; renderFactures(); };

function factureBadge(f) {
  if (f.type === 'avoir') return '<span class="badge badge-muted">Avoir</span>';
  if (f.statut === 'payee') return '<span class="badge badge-success">Payée</span>';
  if (f.statut === 'annulee') return '<span class="badge badge-error">Annulée</span>';
  return '<span class="badge badge-warning">En attente</span>';
}

function renderFactures() {
  const tbody = document.getElementById('factures-table');
  let factures = state.factures.slice().reverse();
  if (_filterText) factures = factures.filter(f => {
    const p = state.patients.find(pp => pp.id === f.patientId);
    return f.numero.toLowerCase().includes(_filterText) ||
      (p && `${p.prenom} ${p.nom}`.toLowerCase().includes(_filterText));
  });
  if (_filterStatus) factures = factures.filter(f => f.statut === _filterStatus);
  if (!factures.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div style="padding:var(--space-8);text-align:center;color:var(--color-text-muted);font-size:var(--text-sm);">Aucune facture trouvée.</div></td></tr>`;
    return;
  }
  tbody.innerHTML = factures.map(f => {
    const patient = state.patients.find(p => p.id === f.patientId);
    const hasEmail = !!(patient && patient.email);
    const canAvoir = f.type !== 'avoir' && f.statut !== 'annulee';
    return `<tr class="tr-clickable" onclick="apercuFacture(${f.id})">
      <td><span class="td-name">${escapeHtml(f.numero)}</span></td>
      <td>${patient ? `<span class="td-name">${escapeHtml(patient.prenom)} ${escapeHtml(patient.nom)}</span>` : '<span style="color:var(--color-text-muted)">—</span>'}</td>
      <td>${formatDate(f.date)}</td>
      <td>${escapeHtml(f.prestation)}</td>
      <td><strong>${formatAmount(f.montant)}</strong></td>
      <td>${factureBadge(f)}</td>
      <td onclick="event.stopPropagation()">
        <button class="btn btn-ghost btn-sm" onclick="apercuFacture(${f.id})" title="Aperçu"><i data-lucide="eye"></i></button>
        ${hasEmail ? `<button class="btn btn-ghost btn-sm" onclick="sendByEmail(${f.id})" title="Envoyer par mail"><i data-lucide="mail"></i></button>` : ''}
        ${f.statut !== 'payee' && f.statut !== 'annulee' ? `<button class="btn btn-ghost btn-sm" onclick="markPaid(${f.id})" title="Marquer payée" style="color:var(--color-success)"><i data-lucide="check"></i></button>` : ''}
        ${canAvoir ? `<button class="btn btn-ghost btn-sm" onclick="openAvoirModal(${f.id})" title="Émettre un avoir" style="color:var(--color-error)"><i data-lucide="rotate-ccw"></i></button>` : ''}
      </td>
    </tr>`;
  }).join('');
  lucide.createIcons();
}

async function markPaid(id) {
  const f = state.factures.find(f => String(f.id) === String(id));
  if (f) {
    f.statut = 'payee';
    await saveState();
    renderFactures();
    refreshDashboard();
    if (_currentPatientId) renderPatientInfos(_currentPatientId);
    toast('Facture marquée comme payée ✓');
  }
}
window.markPaid = markPaid;

function openNewFactureForPatient(patientId) {
  openModal('modalNewFacture');
  setTimeout(() => {
    document.getElementById('f-patient').value = patientId;
    document.getElementById('f-date').value = today();
  }, 50);
}
window.openNewFactureForPatient = openNewFactureForPatient;

function apercuFacture(id) {
  const f = state.factures.find(f => String(f.id) === String(id));
  if (!f) return;
  _currentApercuId = id;
  const patient = state.patients.find(p => p.id === f.patientId);
  const s = state.settings;
  const nomPraticien = [s.prenom, s.nom].filter(Boolean).join(' ') || 'Praticien';
  const tva = 'TVA non applicable — art. 261-4-1° du Code général des impôts';
  const origine = f.type === 'avoir' ? state.factures.find(o => String(o.id) === String(f.factureOrigineId)) : null;
  const reglement = f.statut === 'payee' ? 'Réglée' : 'Paiement à réception de la facture';

  document.getElementById('apercu-content').innerHTML = `
    <div class="invoice-preview" id="print-zone">
      <div class="invoice-header">
        <div class="invoice-from">
          <strong>${escapeHtml(nomPraticien)}</strong>
          Psychologue<br>
          ${s.adresse ? escapeHtml(s.adresse).replace(/\n/g, '<br>') + '<br>' : ''}
          ${s.rpps ? 'N° RPPS : ' + escapeHtml(s.rpps) + '<br>' : '<span style="color:var(--color-error);font-weight:600;">⚠ N° RPPS manquant — mention obligatoire, à renseigner dans Réglages</span><br>'}
          ${s.siret ? 'SIRET : ' + escapeHtml(s.siret) + '<br>' : ''}
          ${s.tel ? 'Tél : ' + escapeHtml(s.tel) : ''}
        </div>
        <div class="invoice-number">
          <div style="font-size:12px;color:#888;margin-bottom:4px;">${f.type === 'avoir' ? 'AVOIR' : 'FACTURE'}</div>
          <div class="inv-num">${escapeHtml(f.numero)}</div>
          <div style="font-size:12px;color:#888;margin-top:6px;">Date : ${formatDate(f.date)}</div>
          <div style="font-size:12px;color:#888;">Émise le : ${formatDate(f.dateCreation.split('T')[0])}</div>
        </div>
      </div>
      ${origine ? `<div style="font-size:12px;color:#888;margin-bottom:var(--space-3);">Annule et remplace la facture <strong>${escapeHtml(origine.numero)}</strong> du ${formatDate(origine.date)}.</div>` : ''}
      <div class="invoice-patient">
        <strong>Patient :</strong> ${patient ? `${escapeHtml(patient.prenom)} ${escapeHtml(patient.nom)}` : '—'}
        ${patient && patient.email ? `<br>Email : ${escapeHtml(patient.email)}` : ''}
        ${patient && patient.tel ? `<br>Tél : ${escapeHtml(patient.tel)}` : ''}
      </div>
      <table class="invoice-table">
        <thead><tr>
          <th>Description</th>
          <th style="text-align:right">Durée</th>
          <th style="text-align:right">Montant TTC</th>
        </tr></thead>
        <tbody>
          <tr>
            <td>${escapeHtml(f.prestation)}</td>
            <td style="text-align:right">${f.duree || 50} min</td>
            <td style="text-align:right">${formatAmount(f.montant)}</td>
          </tr>
        </tbody>
      </table>
      <div class="invoice-total">
        <div class="total-line"><span>Sous-total HT</span><span>${formatAmount(f.montant)}</span></div>
        <div class="total-line"><span>TVA</span><span>${tva}</span></div>
        <div class="total-line total-ttc"><span>TOTAL TTC</span><span>${formatAmount(f.montant)}</span></div>
      </div>
      <div style="font-size:12px;color:#888;margin-top:var(--space-2);">Conditions de règlement : ${reglement}.</div>
      <div class="invoice-footer">
        <strong>Psychologue — ${tva}</strong><br>
        Numérotation chronologique continue sans trou — Conforme art. L441-3 Code de commerce.<br>
        Données conservées conformément au RGPD. Consentement patient enregistré.
      </div>
    </div>
    <p style="font-size:var(--text-xs);color:var(--color-text-muted);margin-top:var(--space-4);text-align:center;">
      <i data-lucide="database" style="width:12px;height:12px;vertical-align:middle;"></i>
      Stockée dans <code>${dataFilePath()}</code>
    </p>`;

  // Bouton email — visible si le patient a un email
  const emailBtn = document.getElementById('facture-email-btn');
  if (patient && patient.email) {
    emailBtn.style.display = '';
  } else {
    emailBtn.style.display = 'none';
  }

  lucide.createIcons();
  openModal('modalApercu');
}
window.apercuFacture = apercuFacture;

// ===== AVOIR (annulation de facture) =====
let _avoirFactureId = null;

function openAvoirModal(id) {
  const f = state.factures.find(f => String(f.id) === String(id));
  if (!f) return;
  if (f.type === 'avoir') { toast("Un avoir ne peut pas lui-même faire l'objet d'un avoir.", 'error'); return; }
  if (f.statut === 'annulee') { toast('Cette facture est déjà annulée par un avoir.', 'error'); return; }
  _avoirFactureId = f.id;
  const patient = state.patients.find(p => p.id === f.patientId);
  document.getElementById('avoir-facture-summary').innerHTML = `
    <div><strong>${escapeHtml(f.numero)}</strong> — ${patient ? `${escapeHtml(patient.prenom)} ${escapeHtml(patient.nom)}` : '—'}</div>
    <div style="font-size:var(--text-sm);color:var(--color-text-muted);margin-top:4px;">${escapeHtml(f.prestation)} · ${formatDate(f.date)} · <strong>${formatAmount(f.montant)}</strong></div>
  `;
  document.getElementById('av-motif').value = '';
  openModal('modalAvoir');
}
window.openAvoirModal = openAvoirModal;

async function saveAvoir() {
  const f = state.factures.find(f => String(f.id) === String(_avoirFactureId));
  if (!f) { closeModal('modalAvoir'); return; }
  const motif = document.getElementById('av-motif').value.trim();
  if (!motif) { toast('Le motif est requis.', 'error'); return; }

  const avoir = {
    id: String(Date.now()),
    numero: formatNum(state.nextFactureNum),
    patientId: f.patientId,
    date: today(),
    montant: -Math.abs(Number(f.montant)),
    prestation: `Avoir sur facture ${f.numero} — ${motif}`,
    duree: f.duree,
    statut: 'payee',
    notes: '',
    dateCreation: new Date().toISOString(),
    numSeq: state.nextFactureNum,
    type: 'avoir',
    factureOrigineId: f.id,
  };
  state.factures.push(avoir);
  state.nextFactureNum++;
  f.statut = 'annulee';

  await saveState();
  closeModal('modalAvoir');
  toast(`Avoir ${avoir.numero} émis — facture ${f.numero} annulée ✓`);
  refreshSidebarCounts();
  refreshDashboard();
  renderFactures();
  if (_currentPatientId) renderPatientInfos(_currentPatientId);
}
window.saveAvoir = saveAvoir;

function sendCurrentFactureByEmail() {
  if (_currentApercuId) sendByEmail(_currentApercuId);
}
window.sendCurrentFactureByEmail = sendCurrentFactureByEmail;

async function sendByEmail(id) {
  const f = state.factures.find(f => String(f.id) === String(id));
  if (!f) return;
  const patient = state.patients.find(p => p.id === f.patientId);
  if (!patient || !patient.email) {
    toast('Aucun email renseigné pour ce patient.', 'error');
    return;
  }
  const s = state.settings;
  const praticien = [s.prenom, s.nom].filter(Boolean).join(' ') || 'Votre psychologue';
  const subject = `Facture ${f.numero} – ${formatDate(f.date)}`;
  const body = [
    `Bonjour ${patient.prenom},`,
    '',
    `Veuillez trouver ci-dessous le récapitulatif de votre séance du ${formatDate(f.date)}.`,
    '',
    `  Facture : ${f.numero}`,
    `  Prestation : ${f.prestation}`,
    `  Durée : ${f.duree || 50} min`,
    `  Montant TTC : ${formatAmount(f.montant)}`,
    `  Statut : ${f.statut === 'payee' ? 'Payée' : 'En attente de paiement'}`,
    '',
    'TVA non applicable — art. 261-4-1° du Code général des impôts.',
    '',
    `Cordialement,`,
    praticien,
    s.tel ? `Tél : ${s.tel}` : '',
  ].filter(l => l !== undefined).join('\n');

  const mailto = `mailto:${patient.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  try {
    await openUrl(mailto);
  } catch (e) {
    // Fallback si openUrl échoue
    window.location.href = mailto;
  }
}
window.sendByEmail = sendByEmail;

function printFacture() {
  const printZone = document.getElementById('print-zone');
  if (!printZone) return;
  document.getElementById('print-container').innerHTML = printZone.outerHTML;
  window.print();
  setTimeout(() => { document.getElementById('print-container').innerHTML = ''; }, 1500);
}
window.printFacture = printFacture;

// ===== SÉANCES — STATUTS =====
const SEANCE_STATUTS = {
  planifie:  { label: 'Planifié',  badge: 'badge-muted',    cal: ['#ede9e3','#7a7468'] },
  confirme:  { label: 'Confirmé',  badge: 'badge-primary',  cal: ['#d4ddd5','#344436'] },
  present:   { label: 'Présent ✓', badge: 'badge-success',  cal: ['#d4e8ce','#427a32'] },
  absent:    { label: 'Absent',    badge: 'badge-warning',  cal: ['#f0e2d4','#9e6030'] },
  annule:    { label: 'Annulé',    badge: 'badge-error',    cal: ['#f5dde1','#a0354a'] },
  no_show:   { label: 'No-show',   badge: 'badge-warning',  cal: ['#fde8cc','#9e5e10'] },
};

// Couleurs calendrier par mode de séance (écrasées par statut si annulé/no_show)
const SEANCE_MODE_CAL = {
  presentiel: ['#ddeaf8','#1a5fa8'],
  visio:      ['#e8d8f0','#6b2fa0'],
  telephone:  ['#e5e5e5','#555555'],
};

// ===== AGENDA =====
let agendaView = 'liste';
let calendarDate = new Date();

function renderAgenda() {
  if (agendaView === 'calendrier') {
    renderCalendar();
  } else {
    renderSeances();
  }
}

function switchAgendaView(view) {
  agendaView = view;
  document.getElementById('tab-liste').classList.toggle('active', view === 'liste');
  document.getElementById('tab-calendrier').classList.toggle('active', view === 'calendrier');
  document.getElementById('agenda-liste-view').style.display = view === 'liste' ? '' : 'none';
  document.getElementById('agenda-calendrier-view').style.display = view === 'calendrier' ? '' : 'none';
  if (view === 'calendrier') renderCalendar();
  else renderSeances();
}
window.switchAgendaView = switchAgendaView;

function toggleICSPanel() {
  const panel = document.getElementById('ics-panel');
  const isHidden = panel.style.display === 'none';
  panel.style.display = isHidden ? '' : 'none';
  if (isHidden && state.settings.calendlyUrl) {
    document.getElementById('calendly-url').value = state.settings.calendlyUrl;
  }
}
window.toggleICSPanel = toggleICSPanel;

// ===== SÉANCES - LISTE =====
async function saveSeance() {
  const patientId = document.getElementById('s-patient').value || null;
  const date = document.getElementById('s-date').value;
  const heure = document.getElementById('s-heure').value;
  if (!date || !heure) { toast('Date et heure requises.', 'error'); return; }
  const editId = document.getElementById('s-edit-id').value;
  const statut = document.getElementById('s-statut').value || 'planifie';
  const mode = document.getElementById('s-mode')?.value || 'presentiel';
  const honoraires = parseFloat(document.getElementById('s-honoraires')?.value) || null;
  const lienVisio = document.getElementById('s-lien-visio')?.value || '';
  const noteSeance = document.getElementById('s-note-seance').value;
  if (editId) {
    const s = state.seances.find(s => String(s.id) === editId);
    if (s) {
      s.patientId = patientId; s.date = date; s.heure = heure;
      s.duree = document.getElementById('s-duree').value;
      s.type = document.getElementById('s-type').value;
      s.statut = statut; s.noteInterne = noteSeance;
      s.mode = mode; s.honoraires = honoraires; s.lienVisio = lienVisio;
    }
  } else {
    state.seances.push({
      id: String(Date.now()), patientId, date, heure,
      duree: document.getElementById('s-duree').value,
      type: document.getElementById('s-type').value,
      statut, noteInterne: noteSeance, facture: false, note: '',
      mode, honoraires, lienVisio,
    });
  }
  await saveState();
  closeModal('modalNewSeance');
  document.getElementById('s-edit-id').value = '';
  document.getElementById('s-note-seance').value = '';
  if (document.getElementById('s-lien-visio')) document.getElementById('s-lien-visio').value = '';
  document.getElementById('seance-modal-title').textContent = 'Planifier une séance';
  document.getElementById('seance-modal-btn').innerHTML = '<i data-lucide="calendar-plus"></i> Planifier';
  lucide.createIcons();
  toast(editId ? 'Séance mise à jour ✓' : 'Séance planifiée ✓');
  renderAgenda();
}
window.saveSeance = saveSeance;

// Helper centralisé — évite String() coercion répétée partout
function findSeance(id) {
  return state.seances.find(s => s.id === String(id));
}

function openEditSeance(id) {
  const s = findSeance(id);
  if (!s) return;
  populatePatientSelects();
  document.getElementById('s-edit-id').value = id;
  document.getElementById('s-patient').value = s.patientId || '';
  document.getElementById('s-date').value = s.date;
  document.getElementById('s-heure').value = s.heure || '10:00';
  document.getElementById('s-duree').value = s.duree || 50;
  document.getElementById('s-type').value = s.type || 'individuel';
  document.getElementById('s-statut').value = s.statut || 'planifie';
  document.getElementById('s-note-seance').value = s.noteInterne || '';
  if (document.getElementById('s-mode')) document.getElementById('s-mode').value = s.mode || 'presentiel';
  if (document.getElementById('s-honoraires')) document.getElementById('s-honoraires').value = s.honoraires ?? '';
  if (document.getElementById('s-lien-visio')) document.getElementById('s-lien-visio').value = s.lienVisio || '';
  _toggleLienVisio(s.mode || 'presentiel');
  document.getElementById('seance-modal-title').textContent = 'Modifier la séance';
  document.getElementById('seance-modal-btn').innerHTML = '<i data-lucide="save"></i> Enregistrer';
  lucide.createIcons();
  document.getElementById('modalNewSeance').classList.add('open');
}

function _toggleLienVisio(mode) {
  const group = document.getElementById('s-lien-visio-group');
  if (group) group.style.display = mode === 'visio' ? '' : 'none';
}
window.openEditSeance = openEditSeance;
window._toggleLienVisio = _toggleLienVisio;

async function setSeanceStatut(id, statut) {
  const s = findSeance(id);
  if (!s) return;
  s.statut = statut;
  await saveState();
  renderAgenda();
  toast(`Séance marquée : ${SEANCE_STATUTS[statut]?.label || statut}`);
}
window.setSeanceStatut = setSeanceStatut;

function renderSeances() {
  const tbody = document.getElementById('seances-table');
  const seances = state.seances.slice().sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return (a.heure || '') < (b.heure || '') ? 1 : -1;
  });
  if (!seances.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div style="padding:var(--space-8);text-align:center;color:var(--color-text-muted);font-size:var(--text-sm);">Aucune séance planifiée. Cliquez sur "Nouvelle séance" ou importez depuis Calendly.</div></td></tr>`;
    return;
  }
  const types = { individuel: 'Individuel', couple: 'Couple', famille: 'Famille', bilan: 'Bilan' };
  tbody.innerHTML = seances.map(s => {
    const patient = s.patientId ? state.patients.find(p => p.id === s.patientId) : null;
    const patientLabel = patient ? `${escapeHtml(patient.prenom)} ${escapeHtml(patient.nom)}`
      : (s.note ? escapeHtml(s.note) : '<span style="color:var(--color-text-faint)">—</span>');
    const st = SEANCE_STATUTS[s.statut || 'planifie'] || SEANCE_STATUTS.planifie;
    const statutBadge = `<span class="badge ${st.badge}">${escapeHtml(st.label)}</span>`;
    // Boutons statut rapide
    const sid = String(s.id);
    const quickBtns = s.statut !== 'present'
      ? `<button class="btn btn-ghost btn-sm" onclick="setSeanceStatut('${sid}','present')" title="Marquer présent" style="color:var(--color-success)"><i data-lucide="user-check"></i></button>`
      : '';
    const absentBtn = s.statut !== 'absent'
      ? `<button class="btn btn-ghost btn-sm" onclick="setSeanceStatut('${sid}','absent')" title="Marquer absent" style="color:var(--color-warning)"><i data-lucide="user-x"></i></button>`
      : '';
    const annuleBtn = s.statut !== 'annule'
      ? `<button class="btn btn-ghost btn-sm" onclick="setSeanceStatut('${sid}','annule')" title="Annuler la séance" style="color:var(--color-error)"><i data-lucide="x-circle"></i></button>`
      : '';
    return `<tr>
      <td>${formatDate(s.date)}</td><td>${s.heure || '—'}</td>
      <td>${patientLabel}</td>
      <td>${escapeHtml(types[s.type] || s.type)}</td><td>${s.duree} min</td>
      <td>${statutBadge}</td>
      <td style="white-space:nowrap;">
        <button class="btn btn-ghost btn-sm" onclick="openEditSeance('${sid}')" title="Modifier"><i data-lucide="pencil"></i></button>
        ${quickBtns}${absentBtn}${annuleBtn}
        ${s.patientId && s.statut !== 'annule' ? `<button class="btn btn-ghost btn-sm" onclick="factureFromSeance('${sid}')" title="Créer facture" style="color:var(--color-primary)"><i data-lucide="file-plus"></i></button>` : ''}
        <button class="btn btn-ghost btn-sm" onclick="deleteSeance('${sid}')" title="Supprimer" style="color:var(--color-error)"><i data-lucide="trash-2"></i></button>
      </td>
    </tr>`;
  }).join('');
  lucide.createIcons();
}

async function deleteSeance(id) {
  state.seances = state.seances.filter(s => s.id !== String(id));
  await saveState();
  renderAgenda();
  toast('Séance supprimée.');
}
window.deleteSeance = deleteSeance;

function factureFromSeance(id) {
  const s = findSeance(id);
  if (!s) return;
  openModal('modalNewFacture');
  setTimeout(() => {
    if (s.patientId) document.getElementById('f-patient').value = s.patientId;
    document.getElementById('f-date').value = s.date;
    document.getElementById('f-duree').value = s.duree;
    document.getElementById('f-numero').value = formatNum(state.nextFactureNum);
  }, 50);
}
window.factureFromSeance = factureFromSeance;

// ===== CALENDRIER (vue mois) =====
function renderCalendar() {
  const container = document.getElementById('calendar-container');
  if (!container) return;

  const year = calendarDate.getFullYear();
  const month = calendarDate.getMonth();
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const todayStr = today();

  // Décalage : lundi = 0
  let startDow = firstDay.getDay();
  startDow = startDow === 0 ? 6 : startDow - 1;

  const monthLabel = firstDay.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });

  let html = `
    <div class="calendar-header">
      <button class="btn btn-ghost btn-sm" onclick="calPrev()"><i data-lucide="chevron-left"></i></button>
      <span class="calendar-month-title">${monthLabel}</span>
      <button class="btn btn-ghost btn-sm" onclick="calNext()"><i data-lucide="chevron-right"></i></button>
    </div>
    <div class="calendar-grid">
      <div class="cal-dow">Lun</div><div class="cal-dow">Mar</div><div class="cal-dow">Mer</div>
      <div class="cal-dow">Jeu</div><div class="cal-dow">Ven</div>
      <div class="cal-dow cal-weekend">Sam</div><div class="cal-dow cal-weekend">Dim</div>
  `;

  // Cellules vides au début
  for (let i = 0; i < startDow; i++) {
    html += `<div class="cal-day cal-empty"></div>`;
  }

  for (let d = 1; d <= lastDay.getDate(); d++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const daySeances = state.seances.filter(s => s.date === dateStr)
      .sort((a, b) => (a.heure || '') < (b.heure || '') ? -1 : 1);
    const isToday = dateStr === todayStr;

    html += `<div class="cal-day${isToday ? ' cal-today' : ''}" onclick="addSeanceOnDay('${dateStr}')">
      <div class="cal-day-num">${d}</div>`;

    daySeances.forEach(s => {
      const patient = s.patientId ? state.patients.find(p => p.id === s.patientId) : null;
      const label = patient
        ? `${s.heure || ''} ${escapeHtml(patient.prenom[0])}.${escapeHtml(patient.nom)}`
        : `${s.heure || ''} ${escapeHtml(s.note || 'Rendez-vous')}`;
      const st = SEANCE_STATUTS[s.statut || 'planifie'] || SEANCE_STATUTS.planifie;
      const calColor = (s.statut === 'annule' || s.statut === 'no_show')
        ? st.cal
        : (SEANCE_MODE_CAL[s.mode] || SEANCE_MODE_CAL.presentiel);
      const title = escapeHtml(`${patient ? patient.prenom + ' ' + patient.nom : (s.note || 'RDV')} – ${s.heure || ''} (${s.duree} min) · ${st.label}`);
      html += `<div class="cal-event" style="background:${calColor[0]};color:${calColor[1]};" title="${title}" onclick="event.stopPropagation();openEditSeance(${s.id})">${label.trim()}</div>`;
    });

    html += `</div>`;
  }

  // Remplissage de la dernière ligne
  const total = startDow + lastDay.getDate();
  const rem = total % 7;
  if (rem !== 0) {
    for (let i = 0; i < 7 - rem; i++) html += `<div class="cal-day cal-empty"></div>`;
  }

  html += `</div>`;
  container.innerHTML = html;
  lucide.createIcons();
}

function calPrev() {
  calendarDate = new Date(calendarDate.getFullYear(), calendarDate.getMonth() - 1, 1);
  renderCalendar();
}
function calNext() {
  calendarDate = new Date(calendarDate.getFullYear(), calendarDate.getMonth() + 1, 1);
  renderCalendar();
}
function addSeanceOnDay(dateStr) {
  populatePatientSelects();
  document.getElementById('s-date').value = dateStr;
  document.getElementById('s-edit-id').value = '';
  if (document.getElementById('s-mode')) document.getElementById('s-mode').value = 'presentiel';
  if (document.getElementById('s-honoraires')) document.getElementById('s-honoraires').value = state.settings.honorairesDefaut || state.settings.tarifConsultation || '';
  if (document.getElementById('s-duree')) document.getElementById('s-duree').value = state.settings.dureeAgenda || state.settings.dureeConsultation || 50;
  _toggleLienVisio('presentiel');
  document.getElementById('modalNewSeance').classList.add('open');
}
window.calPrev = calPrev;
window.calNext = calNext;
window.addSeanceOnDay = addSeanceOnDay;

// ===== ICS IMPORT =====
// Convertit un horodatage ICS en date/heure locales Europe/Paris.
// Les flux ICS "flottants" ou TZID=Europe/Paris (le cas le plus courant pour un
// cabinet français) sont déjà en heure locale : les chiffres se lisent tels
// quels. Mais certains générateurs (cal.com notamment) exportent en UTC
// (suffixe "Z") — sans conversion, l'horaire importé serait décalé d'1h à 2h
// selon l'heure d'été/hiver.
function icsLocalDateTime(datePart, timePart, isUTC) {
  if (!isUTC || !timePart) {
    return {
      date: datePart && datePart.length >= 8
        ? `${datePart.substring(0, 4)}-${datePart.substring(4, 6)}-${datePart.substring(6, 8)}`
        : null,
      heure: timePart && timePart.length >= 4 ? `${timePart.substring(0, 2)}:${timePart.substring(2, 4)}` : null,
    };
  }
  const utcMs = Date.UTC(
    +datePart.substring(0, 4), +datePart.substring(4, 6) - 1, +datePart.substring(6, 8),
    +timePart.substring(0, 2), +timePart.substring(2, 4)
  );
  const [d, t] = new Date(utcMs).toLocaleString('sv-SE', { timeZone: 'Europe/Paris' }).split(' ');
  return { date: d, heure: t.substring(0, 5) };
}

function parseICS(text) {
  const events = [];
  // Dépliage des lignes (RFC 5545 : continuation = espace/tab en début)
  const unfolded = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
  const lines = unfolded.split('\n');

  let inEvent = false;
  let cur = {};

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === 'BEGIN:VEVENT') { inEvent = true; cur = {}; continue; }
    if (line === 'END:VEVENT') {
      if (inEvent && cur.date) events.push(cur);
      inEvent = false;
      continue;
    }
    if (!inEvent) continue;

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    // La clé peut avoir des paramètres : DTSTART;TZID=Europe/Paris:20240115T100000
    const keyPart = line.substring(0, colonIdx);
    const key = keyPart.split(';')[0].toUpperCase();
    const value = line.substring(colonIdx + 1);

    if (key === 'DTSTART') {
      const isUTC = /Z$/.test(value);
      const v = value.replace(/Z$/, '');
      const bare = v.includes('T') ? v.split('T') : [v, null];
      const { date, heure } = icsLocalDateTime(bare[0], bare[1], isUTC);
      if (date) cur.date = date;
      if (heure) cur.heure = heure;
    }
    if (key === 'DTEND') {
      const isUTC = /Z$/.test(value);
      const v = value.replace(/Z$/, '');
      const bare = v.includes('T') ? v.split('T') : [v, null];
      const { date: endDate, heure: endHeure } = icsLocalDateTime(bare[0], bare[1], isUTC);
      if (endHeure && cur.heure && cur.date) {
        const startMs = new Date(`${cur.date}T${cur.heure}:00`).getTime();
        // DTEND peut tomber le lendemain (ex. UTC proche de minuit) — on utilise sa
        // propre date locale plutôt que de supposer la même que DTSTART.
        const endMs = new Date(`${endDate || cur.date}T${endHeure}:00`).getTime();
        cur.duree = Math.max(5, Math.round((endMs - startMs) / 60000));
      }
    }
    if (key === 'SUMMARY') cur.note = value.replace(/\\n/g, ' ').replace(/\\,/g, ',');
    if (key === 'UID') cur.uid = value;
  }
  return events;
}

async function importICSFile() {
  try {
    const path = await dialogOpen({
      filters: [{ name: 'Calendrier iCal', extensions: ['ics', 'ifb'] }],
    });
    if (!path) return;
    const content = await readTextFile(path);
    const events = parseICS(content);
    await importICSEvents(events);
  } catch (e) {
    toast("Erreur lors de l'import du fichier iCal.", 'error');
    console.error(e);
  }
}
window.importICSFile = importICSFile;

async function importICSUrl() {
  const urlInput = document.getElementById('calendly-url');
  const url = urlInput?.value?.trim();
  if (!url) { toast('Entrez une URL iCal.', 'error'); return; }

  // Sauvegarder l'URL dans les réglages
  state.settings.calendlyUrl = url;
  await saveState();

  toast('Téléchargement du calendrier…', 'info');
  await refreshICSFeed({ silent: false });
}
window.importICSUrl = importICSUrl;

// ── Auto-refresh du flux iCal (Doctolib/cal.com/Apple Calendar…) ───────────────
// Récupère périodiquement le flux configuré dans Réglages tant que l'app tourne.
// Silencieux sauf quand de nouvelles séances sont réellement importées — sinon un
// toast toutes les 15 min pour "rien de nouveau" serait vite agaçant.
const ICS_AUTO_REFRESH_MS = 15 * 60 * 1000;
let _icsAutoRefreshTimer = null;
let _icsAutoRefreshInFlight = false;

async function refreshICSFeed({ silent = false } = {}) {
  const url = (state.settings.calendlyUrl || '').trim();
  if (!url || _icsAutoRefreshInFlight) return;
  _icsAutoRefreshInFlight = true;
  try {
    const fetchUrl = url.replace(/^webcal:\/\//i, 'https://');
    const resp = await fetch(fetchUrl);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    const events = parseICS(text);
    await importICSEvents(events, { silent });
  } catch (e) {
    console.error('refreshICSFeed:', e);
    if (!silent) toast(`Impossible de charger le calendrier : ${e.message}. Essayez l'import par fichier .ics.`, 'error');
  } finally {
    _icsAutoRefreshInFlight = false;
  }
}
window.refreshICSFeed = refreshICSFeed;

function startICSAutoRefresh() {
  if (_icsAutoRefreshTimer) return;
  // Premier essai peu après le démarrage (état déjà chargé), puis à intervalle régulier.
  setTimeout(() => refreshICSFeed({ silent: true }), 30000);
  _icsAutoRefreshTimer = setInterval(() => refreshICSFeed({ silent: true }), ICS_AUTO_REFRESH_MS);
}

async function importICSEvents(events, { silent = false } = {}) {
  if (!events.length) {
    if (!silent) toast('Aucun événement trouvé dans ce fichier.', 'error');
    return;
  }

  // Déduplications sur uid ou date+heure
  const existingUids = new Set(state.seances.map(s => s.uid).filter(Boolean));
  const existingSlots = new Set(state.seances.map(s => s.date + 'T' + (s.heure || '')));

  let added = 0;
  for (const ev of events) {
    const slot = ev.date + 'T' + (ev.heure || '');
    if (ev.uid && existingUids.has(ev.uid)) continue;
    if (!ev.uid && existingSlots.has(slot)) continue;

    const seance = {
      id: String(Date.now()),
      patientId: null,
      date: ev.date,
      heure: ev.heure || '00:00',
      duree: ev.duree || state.settings.dureeConsultation || 50,
      type: 'individuel',
      facture: false,
      note: ev.note || '',
      uid: ev.uid || null,
    };
    state.seances.push(seance);
    existingUids.add(ev.uid);
    existingSlots.add(slot);
    added++;
  }

  if (added === 0) {
    if (!silent) toast('Aucune nouvelle séance (tous les événements existent déjà).');
    return;
  }

  await saveState();
  renderAgenda();
  toast(`${added} séance(s) importée(s) ✓ — liez les patients depuis la liste.`);
}

// ===== CHARGES =====
async function addCharge() {
  const desc = document.getElementById('charge-desc').value.trim();
  const montant = parseFloat(document.getElementById('charge-montant').value);
  if (!desc || isNaN(montant) || montant <= 0) { toast('Description et montant requis.', 'error'); return; }
  state.charges.push({
    id: String(Date.now()), desc, montant,
    cat: document.getElementById('charge-cat').value,
    date: today(),
  });
  await saveState();
  document.getElementById('charge-desc').value = '';
  document.getElementById('charge-montant').value = '';
  toast('Charge ajoutée ✓');
  refreshCharges();
}
window.addCharge = addCharge;

async function deleteCharge(id) {
  state.charges = state.charges.filter(c => c.id !== id);
  await saveState();
  refreshCharges();
  toast('Charge supprimée.');
}
window.deleteCharge = deleteCharge;

const catLabels = { loyer: 'Loyer', materiel: 'Matériel', formation: 'Formation', assurance: 'Assurance', logiciel: 'Logiciel', autre: 'Autre' };

function refreshCharges() {
  const ca = state.factures.filter(f => f.statut === 'payee').reduce((s, f) => s + Number(f.montant), 0);
  const urssaf = ca * urssafRate();
  const totalCharges = state.charges.reduce((s, c) => s + Number(c.montant), 0);
  const net = ca - urssaf - totalCharges;
  document.getElementById('charges-ca').textContent = formatAmount(ca);
  document.getElementById('charges-urssaf').textContent = formatAmount(urssaf);
  document.getElementById('charges-total').textContent = formatAmount(totalCharges);
  document.getElementById('charges-net').textContent = formatAmount(net);
  const tbody = document.getElementById('charges-table');
  if (!state.charges.length) {
    tbody.innerHTML = `<tr><td colspan="5"><div style="padding:var(--space-8);text-align:center;color:var(--color-text-muted);font-size:var(--text-sm);">Aucune charge saisie.</div></td></tr>`;
    return;
  }
  tbody.innerHTML = state.charges.slice().reverse().map(c =>
    `<tr><td>${escapeHtml(c.desc)}</td><td><span class="badge badge-muted">${escapeHtml(catLabels[c.cat] || c.cat)}</span></td><td>${formatAmount(c.montant)}</td><td>${formatDate(c.date)}</td><td><button class="btn btn-ghost btn-sm" onclick="deleteCharge(${c.id})" style="color:var(--color-error)"><i data-lucide="trash-2"></i></button></td></tr>`
  ).join('');
  lucide.createIcons();
}

// ===== DASHBOARD =====
function refreshDashboard() {
  const now = new Date();
  const thisMonth = now.getMonth();
  const thisYear = now.getFullYear();
  const facturesMonth = state.factures.filter(f => {
    const d = new Date(f.date);
    return d.getMonth() === thisMonth && d.getFullYear() === thisYear;
  });
  const caMonth = facturesMonth.filter(f => f.statut === 'payee').reduce((s, f) => s + Number(f.montant), 0);
  const impayees = state.factures.filter(f => f.statut === 'en_attente');
  const caTotal = state.factures.filter(f => f.statut === 'payee').reduce((s, f) => s + Number(f.montant), 0);
  const urssaf = caTotal * urssafRate();

  document.getElementById('kpi-ca').textContent = formatAmount(caMonth);
  document.getElementById('kpi-seances').textContent = facturesMonth.length;
  document.getElementById('kpi-patients').textContent = state.patients.length;
  document.getElementById('kpi-impayees').textContent = impayees.length;
  document.getElementById('kpi-impayees-sub').textContent = impayees.length
    ? formatAmount(impayees.reduce((s, f) => s + Number(f.montant), 0)) + ' en attente'
    : 'Aucune impayée ✓';
  document.getElementById('urssaf-montant').textContent = formatAmount(urssaf) + ' provisionnés';
  document.getElementById('urssaf-ca').textContent = 'sur ' + formatAmount(caTotal) + ' CA';
  const pct = caTotal > 0 ? Math.min(100, Math.round(urssaf / caTotal * 100)) : 0;
  document.getElementById('urssaf-bar').style.width = pct + '%';

  // Bloc objectif CA mensuel
  const objectifCA = parseFloat(state.settings.objectifCA) || 0;
  const objBar = document.getElementById('objectif-bar');
  if (objBar) {
    if (objectifCA > 0) {
      const pctObj = Math.min(100, Math.round(caMonth / objectifCA * 100));
      const colObj = pctObj < 50 ? 'var(--color-error)' : pctObj < 80 ? 'var(--color-warning)' : 'var(--color-success)';
      const seancesRestantes = Math.max(0, Math.ceil((objectifCA - caMonth) / (state.settings.tarifConsultation || 60)));
      objBar.style.display = '';
      objBar.innerHTML = `<div class="charges-title" style="color:${colObj};">🎯 Objectif CA mensuel</div>
        <div class="bar-track"><div class="bar-fill" style="width:${pctObj}%;background:${colObj};"></div></div>
        <div class="bar-labels">
          <span>${formatAmount(caMonth)} réalisés sur ${formatAmount(objectifCA)} visés (${pctObj}%)</span>
          <span style="color:var(--color-text-muted);">${seancesRestantes > 0 ? seancesRestantes + ' séance(s) restante(s)' : '✓ Objectif atteint'}</span>
        </div>`;
    } else {
      objBar.style.display = 'none';
    }
  }

  const last5 = state.factures.slice(-5).reverse();
  const tbody = document.getElementById('dashboard-factures-table');
  if (!last5.length) {
    tbody.innerHTML = `<tr><td colspan="5"><div style="padding:var(--space-8);text-align:center;color:var(--color-text-muted);font-size:var(--text-sm);">Aucune facture — créez-en une avec le bouton ci-dessus.</div></td></tr>`;
    return;
  }
  tbody.innerHTML = last5.map(f => {
    const patient = state.patients.find(p => p.id === f.patientId);
    return `<tr class="tr-clickable" onclick="apercuFacture(${f.id})"><td>${escapeHtml(f.numero)}</td><td>${patient ? escapeHtml(patient.prenom) + ' ' + escapeHtml(patient.nom) : '—'}</td><td>${formatDate(f.date)}</td><td>${formatAmount(f.montant)}</td><td>${factureBadge(f)}</td></tr>`;
  }).join('');
}

// ===== STATS =====

let _statsCurrentTab = 'overview';

function getStatsPeriod() {
  const period = document.getElementById('stats-period')?.value || 'year';
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  switch (period) {
    case 'month': {
      const from = `${y}-${String(m+1).padStart(2,'0')}-01`;
      return { from, to: today() };
    }
    case 'quarter': {
      const q = Math.floor(m / 3);
      const fm = q * 3;
      return { from: `${y}-${String(fm+1).padStart(2,'0')}-01`, to: today() };
    }
    case 'year':
      return { from: `${y}-01-01`, to: today() };
    case 'year-1':
      return { from: `${y-1}-01-01`, to: `${y-1}-12-31` };
    case 'custom':
      return {
        from: document.getElementById('stats-date-from')?.value || `${y}-01-01`,
        to:   document.getElementById('stats-date-to')?.value   || today(),
      };
    default:
      return { from: `${y}-01-01`, to: today() };
  }
}

function onStatsPeriodChange() {
  const isCustom = document.getElementById('stats-period')?.value === 'custom';
  const cd = document.getElementById('stats-custom-dates');
  if (cd) cd.style.display = isCustom ? 'flex' : 'none';
  refreshStats();
}
window.onStatsPeriodChange = onStatsPeriodChange;

function switchStatsTab(tab) {
  _statsCurrentTab = tab;
  const tabs = ['overview', 'patients', 'financier', 'activite'];
  tabs.forEach(t => {
    document.getElementById(`stats-tab-${t}`).classList.toggle('active', t === tab);
  });
  document.querySelectorAll('#stats-tabs .tab-btn').forEach((btn, i) => {
    btn.classList.toggle('active', tabs[i] === tab);
  });
  const { from, to } = getStatsPeriod();
  if (tab === 'overview')  renderStatsOverview(from, to);
  if (tab === 'patients')  renderStatsPatients(from, to);
  if (tab === 'financier') renderStatsFinancier(from, to);
  if (tab === 'activite')  renderStatsActivite(from, to);
}
window.switchStatsTab = switchStatsTab;

function refreshStats() {
  const { from, to } = getStatsPeriod();
  if (_statsCurrentTab === 'overview')  renderStatsOverview(from, to);
  if (_statsCurrentTab === 'patients')  renderStatsPatients(from, to);
  if (_statsCurrentTab === 'financier') renderStatsFinancier(from, to);
  if (_statsCurrentTab === 'activite')  renderStatsActivite(from, to);
}

// ── SVG helpers ────────────────────────────────────────────

function svgLineChart(data, { width=580, height=180, color='#5a6e5c', label='' } = {}) {
  if (!data.length) return '<p style="color:var(--color-text-muted);text-align:center;padding:var(--space-6);">Aucune donnée</p>';
  const max = Math.max(...data.map(d=>d.v), 1);
  const PL=48, PR=16, PT=16, PB=36;
  const W=width-PL-PR, H=height-PT-PB;
  const xs = (i) => PL + (i/(data.length-1||1))*W;
  const ys = (v) => PT + H - (v/max)*H;
  const pts = data.map((d,i) => `${xs(i)},${ys(d.v)}`).join(' ');
  const area = `${PL},${PT+H} ${pts} ${xs(data.length-1)},${PT+H}`;
  const gridLines = [0,.25,.5,.75,1].map(f => {
    const y = PT+H*(1-f), val = label==='€' ? formatAmount(max*f) : Math.round(max*f);
    return `<line x1="${PL}" y1="${y}" x2="${PL+W}" y2="${y}" stroke="#e5e5e0" stroke-width="1"/>
            <text x="${PL-4}" y="${y+4}" text-anchor="end" font-size="9" fill="#aaa">${val}</text>`;
  }).join('');
  const xLabels = data.map((d,i) => {
    if (i % Math.ceil(data.length/8) !== 0) return '';
    return `<text x="${xs(i)}" y="${PT+H+14}" text-anchor="middle" font-size="9" fill="#aaa">${escapeHtml(d.l)}</text>`;
  }).join('');
  return `<svg width="100%" viewBox="0 0 ${width} ${height}" style="display:block;overflow:visible;">
    ${gridLines}
    <polygon points="${area}" fill="${color}" opacity=".12"/>
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${data.map((d,i)=>`<circle cx="${xs(i)}" cy="${ys(d.v)}" r="3" fill="${color}"><title>${escapeHtml(d.l)}: ${d.v}</title></circle>`).join('')}
    ${xLabels}
  </svg>`;
}

function svgBarChart(data, { width=580, height=180, color='#5a6e5c', label='' } = {}) {
  if (!data.length) return '<p style="color:var(--color-text-muted);text-align:center;padding:var(--space-6);">Aucune donnée</p>';
  const max = Math.max(...data.map(d=>d.v), 1);
  const PL=48, PR=16, PT=16, PB=36;
  const W=width-PL-PR, H=height-PT-PB;
  const gap=W/data.length, bw=gap*.65;
  const gridLines = [0,.25,.5,.75,1].map(f => {
    const y = PT+H*(1-f), val = label==='€' ? formatAmount(max*f) : Math.round(max*f);
    return `<line x1="${PL}" y1="${y}" x2="${PL+W}" y2="${y}" stroke="#e5e5e0" stroke-width="1"/>
            <text x="${PL-4}" y="${y+4}" text-anchor="end" font-size="9" fill="#aaa">${val}</text>`;
  }).join('');
  const bars = data.map((d,i) => {
    const x=PL+i*gap+(gap-bw)/2, bh=(d.v/max)*H, y=PT+H-bh;
    return `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" fill="${color}" rx="2"><title>${escapeHtml(d.l)}: ${d.v}</title></rect>
            <text x="${x+bw/2}" y="${PT+H+14}" text-anchor="middle" font-size="9" fill="#aaa">${escapeHtml(d.l)}</text>`;
  }).join('');
  return `<svg width="100%" viewBox="0 0 ${width} ${height}" style="display:block;overflow:visible;">
    ${gridLines}${bars}
  </svg>`;
}

function svgPieChart(data) {
  const nonEmpty = data.filter(d=>d.v>0);
  if (!nonEmpty.length) return '<p style="color:var(--color-text-muted);text-align:center;padding:var(--space-6);">Aucune donnée</p>';
  const total = nonEmpty.reduce((s,d)=>s+d.v,0);
  const COLORS = ['#5a6e5c','#9e6030','#b88a1c','#427a32','#a0354a','#7c5cbf','#2a7ab5','#666'];
  const cx=90, cy=90, r=75;
  let angle = -Math.PI/2;
  const paths = nonEmpty.map((d,i) => {
    const a = (d.v/total)*2*Math.PI;
    const x1=cx+r*Math.cos(angle), y1=cy+r*Math.sin(angle);
    angle += a;
    const x2=cx+r*Math.cos(angle), y2=cy+r*Math.sin(angle);
    return `<path d="M${cx},${cy}L${x1},${y1}A${r},${r},0,${a>Math.PI?1:0},1,${x2},${y2}Z"
      fill="${COLORS[i%COLORS.length]}" stroke="white" stroke-width="1.5">
      <title>${escapeHtml(d.l)}: ${d.v} (${Math.round(d.v/total*100)}%)</title></path>`;
  }).join('');
  const legend = nonEmpty.map((d,i) => `<div style="display:flex;align-items:center;gap:6px;font-size:var(--text-xs);">
    <span style="width:10px;height:10px;border-radius:50%;background:${COLORS[i%COLORS.length]};flex-shrink:0;display:inline-block;"></span>
    <span>${escapeHtml(d.l)} — ${Math.round(d.v/total*100)}%</span>
  </div>`).join('');
  return `<div style="display:flex;gap:var(--space-5);align-items:center;flex-wrap:wrap;">
    <svg viewBox="0 0 180 180" style="width:160px;height:160px;flex-shrink:0;">${paths}</svg>
    <div style="display:flex;flex-direction:column;gap:var(--space-2);">${legend}</div>
  </div>`;
}

function svgStackedBar(data, { width=580, height=200 } = {}) {
  if (!data.length) return '<p style="color:var(--color-text-muted);text-align:center;padding:var(--space-6);">Aucune donnée</p>';
  const maxCA = Math.max(...data.map(d=>d.ca), 1);
  const PL=56, PR=16, PT=16, PB=36;
  const W=width-PL-PR, H=height-PT-PB;
  const gap=W/data.length, bw=gap*.65;
  const C = { net:'#427a32', charges:'#9e6030', urssaf:'#b88a1c' };
  const gridLines = [0,.25,.5,.75,1].map(f => {
    const y=PT+H*(1-f);
    return `<line x1="${PL}" y1="${y}" x2="${PL+W}" y2="${y}" stroke="#e5e5e0" stroke-width="1"/>
            <text x="${PL-4}" y="${y+4}" text-anchor="end" font-size="9" fill="#aaa">${formatAmount(maxCA*f)}</text>`;
  }).join('');
  const bars = data.map((d,i) => {
    const x=PL+i*gap+(gap-bw)/2, baseY=PT+H;
    const uH=(d.urssaf/maxCA)*H, cH=(d.charges/maxCA)*H;
    const net=Math.max(0,d.ca-d.charges-d.urssaf), nH=(net/maxCA)*H;
    return `<rect x="${x}" y="${baseY-uH}" width="${bw}" height="${uH}" fill="${C.urssaf}"><title>URSSAF: ${formatAmount(d.urssaf)}</title></rect>
            <rect x="${x}" y="${baseY-uH-cH}" width="${bw}" height="${cH}" fill="${C.charges}"><title>Charges: ${formatAmount(d.charges)}</title></rect>
            <rect x="${x}" y="${baseY-uH-cH-nH}" width="${bw}" height="${nH}" fill="${C.net}" rx="2"><title>Net: ${formatAmount(net)}</title></rect>
            <text x="${x+bw/2}" y="${PT+H+14}" text-anchor="middle" font-size="9" fill="#aaa">${escapeHtml(d.l)}</text>`;
  }).join('');
  const legend = `<g>
    <rect x="${PL}" y="${height-10}" width="8" height="8" fill="${C.net}"/>
    <text x="${PL+12}" y="${height-3}" font-size="9" fill="#666">Net</text>
    <rect x="${PL+52}" y="${height-10}" width="8" height="8" fill="${C.charges}"/>
    <text x="${PL+64}" y="${height-3}" font-size="9" fill="#666">Charges</text>
    <rect x="${PL+128}" y="${height-10}" width="8" height="8" fill="${C.urssaf}"/>
    <text x="${PL+140}" y="${height-3}" font-size="9" fill="#666">URSSAF estimé</text>
  </g>`;
  return `<svg width="100%" viewBox="0 0 ${width} ${height+14}" style="display:block;overflow:visible;">
    ${gridLines}${bars}${legend}
  </svg>`;
}

// ── Helpers période ──────────────────────────────────────

function last12Months() {
  const now = new Date();
  return Array.from({length:12},(_,i)=>{
    const d = new Date(now.getFullYear(), now.getMonth()-11+i, 1);
    const y=d.getFullYear(), m=d.getMonth();
    const lastDay = new Date(y,m+1,0).getDate();
    return {
      l: d.toLocaleDateString('fr-FR',{month:'short',year:'2-digit'}),
      from: `${y}-${String(m+1).padStart(2,'0')}-01`,
      to:   `${y}-${String(m+1).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`,
    };
  });
}

function inRange(date, from, to) { return date >= from && date <= to; }

function kpiCard(label, value, sub='', trend='') {
  return `<div class="kpi-card"><div class="kpi-label">${label}</div>
    <div class="kpi-value${trend?' kpi-trend-'+trend:''}">${value}</div>
    ${sub?`<div class="kpi-sub">${sub}</div>`:''}
  </div>`;
}

function chartSection(title, content) {
  return `<div class="stats-chart-section">
    <div class="stats-chart-title">${title}</div>
    <div class="stats-chart-body">${content}</div>
  </div>`;
}

// ── Onglet 1 — Vue d'ensemble ────────────────────────────

function renderStatsOverview(from, to) {
  const el = document.getElementById('stats-tab-overview');
  if (!el) return;
  const taux = urssafRate();
  const facPeriod = state.factures.filter(f => inRange(f.date, from, to));
  const seancesPeriod = state.seances.filter(s => inRange(s.date, from, to));
  const payees = facPeriod.filter(f => f.statut === 'payee');
  const ca = payees.reduce((s,f)=>s+Number(f.montant),0);
  const chargesPeriod = state.charges.filter(c=>inRange(c.date,from,to));
  const totalCharges = chargesPeriod.reduce((s,c)=>s+Number(c.montant),0);
  const urssaf = ca * taux;
  const netRevenu = ca - totalCharges - urssaf;
  const seancesRealisees = seancesPeriod.filter(s=>s.statut==='present').length;
  const seancesPlanifiees = seancesPeriod.filter(s=>['planifie','confirme','present'].includes(s.statut)).length;
  const tauxRemplissage = seancesPlanifiees > 0 ? Math.round(seancesRealisees/seancesPlanifiees*100) : 0;
  const patActifs = new Set(seancesPeriod.filter(s=>s.patientId).map(s=>s.patientId)).size;
  const panierMoyen = seancesRealisees > 0 ? ca/seancesRealisees : 0;
  const nbAnnulees = seancesPeriod.filter(s=>s.statut==='annule'||s.statut==='no_show').length;
  const totalPlanifieesAvecAnnul = seancesPeriod.filter(s=>['planifie','confirme','present','annule','no_show'].includes(s.statut)).length;
  const tauxAnnulation = totalPlanifieesAvecAnnul > 0 ? Math.round(nbAnnulees/totalPlanifieesAvecAnnul*100) : 0;

  const months = last12Months();
  const caByMonth = months.map(m => ({
    l: m.l,
    v: Math.round(state.factures.filter(f=>f.statut==='payee'&&inRange(f.date,m.from,m.to)).reduce((s,f)=>s+Number(f.montant),0)),
  }));
  const seancesByMonth = months.map(m => ({
    l: m.l,
    v: state.seances.filter(s=>s.statut==='present'&&inRange(s.date,m.from,m.to)).length,
  }));

  // Motifs de consultation (anamnèse)
  const motifsRaw = state.patients.map(p => {
    const a = p._anamnese;
    return p.motif || (a?.motif_principal) || '';
  }).filter(Boolean);
  const motifsCount = {};
  motifsRaw.forEach(m => { const k = m.slice(0,30); motifsCount[k] = (motifsCount[k]||0)+1; });
  const motifData = Object.entries(motifsCount).sort((a,b)=>b[1]-a[1]).slice(0,6)
    .map(([l,v])=>({l,v}));

  el.innerHTML = `
    <div class="kpi-grid kpi-grid-6">
      ${kpiCard('CA de la période', formatAmount(ca), '', ca>0?'up':'')}
      ${kpiCard('Séances réalisées', seancesRealisees)}
      ${kpiCard('Patients actifs', patActifs)}
      ${kpiCard('Taux de remplissage', tauxRemplissage+'%', seancesPlanifiees+' planifiées')}
      ${kpiCard('Revenu net estimé', formatAmount(netRevenu), 'CA – charges – URSSAF', netRevenu>=0?'up':'warning')}
      ${kpiCard('Taux d\'annulation', tauxAnnulation+'%', nbAnnulees+' annulée(s) / no-show', tauxAnnulation>20?'warning':'')}
    </div>
    <div class="stats-charts-grid">
      ${chartSection('CA mensuel — 12 mois glissants', svgLineChart(caByMonth,{color:'#5a6e5c',label:'€'}))}
      ${chartSection('Séances réalisées par mois', svgBarChart(seancesByMonth,{color:'#427a32'}))}
      ${chartSection('Répartition des motifs de consultation', svgPieChart(motifData))}
    </div>`;
}

// ── Onglet 2 — Patients ──────────────────────────────────

function renderStatsPatients(from, to) {
  const el = document.getElementById('stats-tab-patients');
  if (!el) return;
  const seancesPeriod = state.seances.filter(s=>inRange(s.date,from,to));
  const patientsActifIds = new Set(seancesPeriod.filter(s=>s.patientId).map(s=>s.patientId));
  const nouveaux = state.patients.filter(p=>p.dateCreation&&p.dateCreation.slice(0,10)>=from&&p.dateCreation.slice(0,10)<=to).length;
  const enCours = patientsActifIds.size;
  const termines = state.patients.filter(p=>p.cloture).length;

  const dureesArr = [];
  for (const p of state.patients) {
    const ps = state.seances.filter(s=>s.patientId===p.id).map(s=>s.date).sort();
    if (ps.length >= 2) {
      const diff = (new Date(ps[ps.length-1]+'T12:00')-new Date(ps[0]+'T12:00'))/(1000*60*60*24*7);
      dureesArr.push(diff);
    }
  }
  const dureeMoy = dureesArr.length ? Math.round(dureesArr.reduce((a,b)=>a+b,0)/dureesArr.length) : 0;

  const patAvecSeances = state.patients.filter(p=>state.seances.some(s=>s.patientId===p.id));
  const seancesMoy = patAvecSeances.length
    ? Math.round(state.seances.filter(s=>s.patientId).length / patAvecSeances.length * 10)/10
    : 0;

  // Sources d'orientation
  const sourceLabels = {
    medecin:'Médecin traitant', psychiatre:'Psychiatre', confrere:'Confrère psychologue',
    bouche_a_oreille:'Bouche à oreille', site_internet:'Site internet',
    mon_soutien_psy:'Mon Soutien Psy', employeur:'Employeur', autre:'Autre',
  };
  const srcCount = {};
  state.patients.forEach(p => {
    if (p.sourceOrientation) {
      const k = sourceLabels[p.sourceOrientation] || p.sourceOrientation;
      srcCount[k] = (srcCount[k]||0)+1;
    }
  });
  const srcData = Object.entries(srcCount).sort((a,b)=>b[1]-a[1]).map(([l,v])=>({l,v}));

  const months = last12Months();
  const patActifByMonth = months.map(m => {
    const ids = new Set(state.seances.filter(s=>s.patientId&&inRange(s.date,m.from,m.to)).map(s=>s.patientId));
    return { l: m.l, v: ids.size };
  });

  el.innerHTML = `
    <div class="kpi-grid">
      ${kpiCard('Nouveaux patients', nouveaux, 'sur la période')}
      ${kpiCard('Patients actifs', enCours, 'au moins 1 séance')}
      ${kpiCard('Dossiers clôturés', termines, 'total')}
      ${kpiCard('Durée moy. de suivi', dureeMoy+' sem.', 'par patient')}
      ${kpiCard('Séances moy./patient', seancesMoy, 'tous patients confondus')}
    </div>
    <div class="stats-charts-grid">
      ${chartSection('Patients actifs par mois — 12 mois glissants', svgBarChart(patActifByMonth,{color:'#5a6e5c'}))}
      ${chartSection("Sources d'orientation", srcData.length ? svgPieChart(srcData) : '<p style="color:var(--color-text-muted);padding:var(--space-4);">Renseignez le champ « Comment nous avez-vous connu ? » dans les fiches patients.</p>')}
    </div>`;
}

// ── Onglet 3 — Financier ─────────────────────────────────

function renderStatsFinancier(from, to) {
  const el = document.getElementById('stats-tab-financier');
  if (!el) return;
  const taux = urssafRate();
  const facPeriod = state.factures.filter(f=>inRange(f.date,from,to));
  const payees = facPeriod.filter(f=>f.statut==='payee');
  const ca = payees.reduce((s,f)=>s+Number(f.montant),0);
  const chargesPeriod = state.charges.filter(c=>inRange(c.date,from,to));
  const totalCharges = chargesPeriod.reduce((s,c)=>s+Number(c.montant),0);
  const urssaf = ca * taux;
  const net = ca - totalCharges - urssaf;
  const impayeesAll = state.factures.filter(f=>f.statut==='en_attente');
  const montantImpayees = impayeesAll.reduce((s,f)=>s+Number(f.montant),0);

  const paiementsAvecDate = state.factures.filter(f=>f.statut==='payee'&&f.dateCreation);
  const delaiMoy = paiementsAvecDate.length
    ? Math.round(paiementsAvecDate.reduce((s,f)=>{
        const diff=(new Date(f.date+'T12:00')-new Date(f.dateCreation.slice(0,10)+'T12:00'))/(1000*60*60*24);
        return s+Math.max(0,diff);
      },0)/paiementsAvecDate.length)
    : 0;

  const months = last12Months();
  const stackData = months.map(m => {
    const mCA = state.factures.filter(f=>f.statut==='payee'&&inRange(f.date,m.from,m.to)).reduce((s,f)=>s+Number(f.montant),0);
    const mCharges = state.charges.filter(c=>inRange(c.date,m.from,m.to)).reduce((s,c)=>s+Number(c.montant),0);
    return { l:m.l, ca:mCA, charges:mCharges, urssaf:mCA*taux };
  });
  const netByMonth = months.map(m=>{
    const d = stackData[months.indexOf(m)];
    return { l:m.l, v:Math.max(0,Math.round(d.ca-d.charges-d.urssaf)) };
  });

  // Répartition charges par catégorie
  const catLabels = { loyer:'Loyer',materiel:'Matériel',formation:'Formation',
    assurance:'Assurance',logiciel:'Logiciel',autre:'Autre' };
  const catCount = {};
  chargesPeriod.forEach(c=>{ const k=catLabels[c.cat]||c.cat; catCount[k]=(catCount[k]||0)+Number(c.montant); });
  const catData = Object.entries(catCount).sort((a,b)=>b[1]-a[1]).map(([l,v])=>({l,v:Math.round(v)}));

  // Tableau impayées
  const impayeesRows = impayeesAll.map(f => {
    const patient = state.patients.find(p=>p.id===f.patientId);
    const jours = Math.floor((Date.now()-new Date(f.date+'T12:00').getTime())/86400000);
    return `<tr>
      <td>${patient?escapeHtml(patient.prenom)+' '+escapeHtml(patient.nom):'—'}</td>
      <td>${escapeHtml(f.numero)}</td>
      <td>${formatDate(f.date)}</td>
      <td>${formatAmount(f.montant)}</td>
      <td><span class="badge badge-${jours>30?'error':'warning'}">${jours}j</span></td>
      <td><button class="btn btn-ghost btn-sm" style="color:var(--color-success);" onclick="markPaid(${f.id});setTimeout(()=>renderStatsFinancier('${from}','${to}'),300);">
        <i data-lucide="check"></i> Payée
      </button></td>
    </tr>`;
  }).join('');

  // Sélecteur URSSAF trimestriel
  const now = new Date();
  const yearOpts = [now.getFullYear(), now.getFullYear()-1].map(y=>`<option value="${y}">${y}</option>`).join('');

  el.innerHTML = `
    <div class="kpi-grid">
      ${kpiCard('CA total', formatAmount(ca), 'factures payées')}
      ${kpiCard('Charges déductibles', formatAmount(totalCharges), 'sur la période', totalCharges>0?'warning':'')}
      ${kpiCard('URSSAF estimé', formatAmount(urssaf), `taux ${(taux*100).toFixed(1)} %`)}
      ${kpiCard('Résultat net estimé', formatAmount(net), 'CA – charges – URSSAF', net>=0?'up':'warning')}
      ${kpiCard('Factures impayées', formatAmount(montantImpayees), impayeesAll.length+' facture(s)', impayeesAll.length?'warning':'')}
      ${kpiCard('Délai moy. de paiement', delaiMoy+'j', 'entre émission et paiement')}
    </div>
    <div class="stats-charts-grid">
      ${chartSection('CA / Charges / URSSAF par mois', svgStackedBar(stackData))}
      ${chartSection('Résultat net mensuel', svgBarChart(netByMonth,{color:'#427a32',label:'€'}))}
      ${chartSection('Répartition des charges par catégorie', svgPieChart(catData))}
    </div>
    ${impayeesAll.length ? `
    <div class="stats-chart-section">
      <div class="stats-chart-title">Factures impayées</div>
      <div class="table-container">
        <table>
          <thead><tr><th>Patient</th><th>N°</th><th>Date</th><th>Montant</th><th>Retard</th><th></th></tr></thead>
          <tbody>${impayeesRows}</tbody>
        </table>
      </div>
    </div>` : ''}
    <div class="stats-chart-section">
      <div class="stats-chart-title">Déclaration URSSAF trimestrielle</div>
      <div style="display:flex;gap:var(--space-3);align-items:center;flex-wrap:wrap;margin-bottom:var(--space-4);">
        <select class="form-select" id="urssaf-q" style="max-width:120px;" onchange="renderUrssafTrimestriel()">
          <option value="1">T1 (Jan–Mar)</option>
          <option value="2">T2 (Avr–Jun)</option>
          <option value="3">T3 (Jul–Sep)</option>
          <option value="4" selected>T4 (Oct–Déc)</option>
        </select>
        <select class="form-select" id="urssaf-y" style="max-width:100px;" onchange="renderUrssafTrimestriel()">${yearOpts}</select>
      </div>
      <div id="urssaf-trim-display"></div>
    </div>`;
  lucide.createIcons();
  renderUrssafTrimestriel();
}

function renderUrssafTrimestriel() {
  const q = parseInt(document.getElementById('urssaf-q')?.value || '4');
  const y = parseInt(document.getElementById('urssaf-y')?.value || new Date().getFullYear());
  const startMonth = (q-1)*3+1;
  const from = `${y}-${String(startMonth).padStart(2,'0')}-01`;
  const endMonth = q*3;
  const lastDay = new Date(y,endMonth,0).getDate();
  const to = `${y}-${String(endMonth).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
  const taux = urssafRate();

  const facPeriod = state.factures.filter(f=>f.statut==='payee'&&inRange(f.date,from,to));
  const caIndiv = facPeriod.filter(f=>{
    const s = state.seances.find(ss=>ss.id===f.seanceId);
    return !s || s.type==='individuel' || s.type==='famille';
  }).reduce((s,f)=>s+Number(f.montant),0);
  const caEntreprise = facPeriod.filter(f=>{
    const s = state.seances.find(ss=>ss.id===f.seanceId);
    return s && s.type==='entreprise';
  }).reduce((s,f)=>s+Number(f.montant),0);
  const caTotal = facPeriod.reduce((s,f)=>s+Number(f.montant),0);
  const cotisations = caTotal * taux;
  const deadlines = {1:'30 avril',2:'31 juillet',3:'31 octobre',4:'31 janvier N+1'};

  const el = document.getElementById('urssaf-trim-display');
  if (!el) return;
  el.innerHTML = `
    <div class="kpi-grid" style="margin-bottom:var(--space-4);">
      ${kpiCard('CA séances individuelles', formatAmount(caIndiv))}
      ${kpiCard('CA entreprise', formatAmount(caEntreprise))}
      ${kpiCard('CA total T'+q+' '+y, formatAmount(caTotal))}
      ${kpiCard('Cotisations dues', formatAmount(cotisations), `taux ${(taux*100).toFixed(1)}%`,'warning')}
    </div>
    <div class="alert alert-warning">
      <i data-lucide="calendar"></i>
      <div>Date limite de déclaration T${q} : <strong>${deadlines[q]}</strong> — sur <a href="https://www.autoentrepreneur.urssaf.fr" target="_blank" style="color:inherit;">autoentrepreneur.urssaf.fr</a></div>
    </div>
    <button class="btn btn-secondary btn-sm" onclick="exportURSSAFTrimestriel(${q},${y})">
      <i data-lucide="download"></i> Exporter CSV
    </button>`;
  lucide.createIcons();
}
window.renderUrssafTrimestriel = renderUrssafTrimestriel;

async function exportURSSAFTrimestriel(q, y) {
  const startMonth = (q-1)*3+1;
  const from = `${y}-${String(startMonth).padStart(2,'0')}-01`;
  const endMonth = q*3;
  const lastDay = new Date(y,endMonth,0).getDate();
  const to = `${y}-${String(endMonth).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
  const facPeriod = state.factures.filter(f=>f.statut==='payee'&&inRange(f.date,from,to));
  const taux = urssafRate();

  try {
    const path = await dialogSave({
      defaultPath: `urssaf-T${q}-${y}.csv`,
      filters: [{ name: 'Fichier CSV', extensions: ['csv'] }],
    });
    if (!path) return;
    const headers = ['N° Facture','Date','Patient','Prestation','Montant TTC (€)','Type'];
    const rows = facPeriod.map(f => {
      const patient = state.patients.find(p=>p.id===f.patientId);
      const seance = state.seances.find(s=>s.id===f.seanceId);
      return [f.numero, f.date, patient?`${patient.prenom} ${patient.nom}`:'',
        f.prestation||'Consultation', String(f.montant).replace('.',','),
        seance?.type||'individuel'];
    });
    const caTotal = facPeriod.reduce((s,f)=>s+Number(f.montant),0);
    const summary = [
      [], ['CA TOTAL T'+q+' '+y, '', '', '', String(caTotal).replace('.',','), ''],
      ['COTISATIONS URSSAF ESTIMÉES', '', '', '', String(Math.round(caTotal*taux*100)/100).replace('.',','), ''],
    ];
    const csv = '﻿' + [headers,...rows,...summary]
      .map(r=>r.map(v=>`"${String(v||'').replace(/"/g,'""')}"`).join(';'))
      .join('\r\n');
    await writeTextFile(path, csv);
    toast('Export URSSAF T'+q+' exporté ✓');
  } catch(e) { toast("Erreur lors de l'export.", 'error'); }
}
window.exportURSSAFTrimestriel = exportURSSAFTrimestriel;

// ── Onglet 4 — Activité clinique ─────────────────────────

function renderStatsActivite(from, to) {
  const el = document.getElementById('stats-tab-activite');
  if (!el) return;
  const seancesPeriod = state.seances.filter(s=>inRange(s.date,from,to));

  // PHQ-9 & GAD-7 moyennes (dernier score par patient actif)
  const patientsActifIds = new Set(seancesPeriod.filter(s=>s.patientId).map(s=>s.patientId));
  let phqScores = [], gadScores = [];
  for (const pid of patientsActifIds) {
    const p = state.patients.find(pp=>pp.id===pid);
    if (!p) continue;
    const phq = (p.questionnaires||[]).filter(q=>q.type==='phq9').sort((a,b)=>b.date.localeCompare(a.date))[0];
    const gad = (p.questionnaires||[]).filter(q=>q.type==='gad7').sort((a,b)=>b.date.localeCompare(a.date))[0];
    if (phq) phqScores.push(phq.score);
    if (gad) gadScores.push(gad.score);
  }
  const phqMoy = phqScores.length ? Math.round(phqScores.reduce((a,b)=>a+b,0)/phqScores.length*10)/10 : null;
  const gadMoy = gadScores.length ? Math.round(gadScores.reduce((a,b)=>a+b,0)/gadScores.length*10)/10 : null;

  // Bilans réalisés dans la période
  const bilans = state.seances.filter(s=>s.type==='bilan'&&inRange(s.date,from,to)).length;

  // Documents générés dans la période (count from all patients' docs — we don't have in state,
  // so we show note: use a simple query indicator)
  const nbNotes = state.patients.flatMap(p=>p.notes||[]).filter(n=>inRange(n.date,from,to)).length;

  // Répartition par type de séance
  const typeLabels = { individuel:'Individuel', couple:'Couple', famille:'Famille',
    bilan:'Bilan', entreprise:'Entreprise' };
  const typeCount = {};
  seancesPeriod.forEach(s=>{
    const k = typeLabels[s.type]||s.type;
    typeCount[k]=(typeCount[k]||0)+1;
  });
  const typeData = Object.entries(typeCount).sort((a,b)=>b[1]-a[1]).map(([l,v])=>({l,v}));

  // PHQ-9 évolution moyenne par mois
  const months = last12Months();
  const phqByMonth = months.map(m => {
    const scores = state.patients.flatMap(p=>(p.questionnaires||[]).filter(q=>q.type==='phq9'&&inRange(q.date,m.from,m.to)).map(q=>q.score));
    return { l:m.l, v: scores.length ? Math.round(scores.reduce((a,b)=>a+b,0)/scores.length*10)/10 : 0 };
  });

  el.innerHTML = `
    <div class="kpi-grid">
      ${kpiCard('Score PHQ-9 moyen', phqMoy!==null?phqMoy+'/27':'—', phqScores.length+' patients', phqMoy!==null&&phqMoy<=9?'up':'warning')}
      ${kpiCard('Score GAD-7 moyen', gadMoy!==null?gadMoy+'/21':'—', gadScores.length+' patients', gadMoy!==null&&gadMoy<=9?'up':'warning')}
      ${kpiCard('Bilans réalisés', bilans, 'sur la période')}
      ${kpiCard('Notes cliniques', nbNotes, 'rédigées sur la période')}
    </div>
    <div class="stats-charts-grid">
      ${chartSection('Répartition par type de consultation', svgPieChart(typeData))}
      ${chartSection('Évolution moyenne PHQ-9 (12 mois)', svgLineChart(phqByMonth,{color:'#a0354a'}))}
    </div>
    <div class="alert alert-info" style="margin-top:var(--space-5);">
      <i data-lucide="info"></i>
      <div>Ces données agrégées sont destinées à votre usage professionnel uniquement. Elles ne constituent pas un outil de recherche ou de publication.</div>
    </div>`;
  lucide.createIcons();
}

// ── Export 2035 ──────────────────────────────────────────

async function export2035() {
  const y = new Date().getFullYear();
  const s = state.settings;
  const praticien = escapeHtml(`${s.prenom||''} ${s.nom||''}`.trim() || 'Praticien');
  const taux = urssafRate();

  const months = Array.from({length:12},(_,i)=>{
    const d = new Date(y,i,1);
    return {
      label: d.toLocaleDateString('fr-FR',{month:'long'}),
      from: `${y}-${String(i+1).padStart(2,'0')}-01`,
      to:   `${y}-${String(i+1).padStart(2,'0')}-${String(new Date(y,i+1,0).getDate()).padStart(2,'0')}`,
    };
  });

  const rows = months.map(m => {
    const mFac = state.factures.filter(f=>f.statut==='payee'&&inRange(f.date,m.from,m.to));
    const mSea = state.seances.filter(s=>inRange(s.date,m.from,m.to)&&s.statut==='present');
    const caIndiv = mFac.filter(f=>{const ss=state.seances.find(s2=>s2.id===f.seanceId);return !ss||ss.type!=='entreprise';}).reduce((a,f)=>a+Number(f.montant),0);
    const caEnt   = mFac.filter(f=>{const ss=state.seances.find(s2=>s2.id===f.seanceId);return ss&&ss.type==='entreprise';}).reduce((a,f)=>a+Number(f.montant),0);
    const total   = caIndiv + caEnt;
    return { label:m.label, seances:mSea.length, caIndiv, caEnt, total };
  });

  const totalAnnuel = rows.reduce((a,r)=>({seances:a.seances+r.seances,caIndiv:a.caIndiv+r.caIndiv,caEnt:a.caEnt+r.caEnt,total:a.total+r.total}),{seances:0,caIndiv:0,caEnt:0,total:0});

  const catLabels = { loyer:'Loyer',materiel:'Matériel',formation:'Formation',assurance:'Assurance',logiciel:'Logiciel',autre:'Autre' };
  const chargesAnno = state.charges.filter(c=>c.date.startsWith(y+''));
  const catTotals = {};
  chargesAnno.forEach(c=>{ const k=catLabels[c.cat]||c.cat; catTotals[k]=(catTotals[k]||0)+Number(c.montant); });
  const totalChargesAnn = chargesAnno.reduce((a,c)=>a+Number(c.montant),0);
  const urssafAnn = totalAnnuel.total * taux;
  const netAnn = totalAnnuel.total - totalChargesAnn - urssafAnn;

  const html = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
  <style>
    body{font-family:Georgia,serif;font-size:10pt;color:#111;margin:0;padding:2.5cm;}
    h1{font-size:14pt;margin-bottom:.5rem;} h2{font-size:11pt;border-bottom:1px solid #aaa;padding-bottom:.3rem;margin-top:2rem;}
    table{width:100%;border-collapse:collapse;margin-top:1rem;font-size:9pt;}
    th{background:#eee;padding:5px 8px;text-align:left;border:1px solid #ccc;}
    td{padding:5px 8px;border:1px solid #ddd;}
    .total{font-weight:700;background:#f5f5f5;}
    .footer{margin-top:3rem;padding-top:1rem;border-top:1px solid #aaa;font-size:8pt;color:#666;font-style:italic;}
    @media print{body{padding:1.5cm;}}
  </style></head><body>
  <h1>Préparation déclaration fiscale — Année ${y}</h1>
  <p>${praticien} — Psychologue libéral<br>
  ${s.siret?'SIRET : '+escapeHtml(s.siret)+'&nbsp;&nbsp;':''}${s.rpps?'N° RPPS : '+escapeHtml(s.rpps):''}</p>

  <h2>A — Recettes</h2>
  <table>
    <thead><tr><th>Mois</th><th>Séances</th><th>CA individuel</th><th>CA entreprise</th><th>Total mensuel</th></tr></thead>
    <tbody>
      ${rows.map(r=>`<tr><td>${r.label}</td><td>${r.seances}</td><td>${formatAmount(r.caIndiv)}</td><td>${formatAmount(r.caEnt)}</td><td>${formatAmount(r.total)}</td></tr>`).join('')}
      <tr class="total"><td>TOTAL ${y}</td><td>${totalAnnuel.seances}</td><td>${formatAmount(totalAnnuel.caIndiv)}</td><td>${formatAmount(totalAnnuel.caEnt)}</td><td>${formatAmount(totalAnnuel.total)}</td></tr>
    </tbody>
  </table>

  <h2>B — Dépenses déductibles</h2>
  <table>
    <thead><tr><th>Catégorie</th><th>Montant annuel</th></tr></thead>
    <tbody>
      ${Object.entries(catTotals).map(([k,v])=>`<tr><td>${escapeHtml(k)}</td><td>${formatAmount(v)}</td></tr>`).join('')}
      <tr class="total"><td>TOTAL CHARGES</td><td>${formatAmount(totalChargesAnn)}</td></tr>
    </tbody>
  </table>

  <h2>C — Cotisations URSSAF estimées</h2>
  <p>CA annuel : ${formatAmount(totalAnnuel.total)} × ${(taux*100).toFixed(1)} % = <strong>${formatAmount(urssafAnn)}</strong></p>

  <h2>D — Résultat net estimé</h2>
  <p>${formatAmount(totalAnnuel.total)} − ${formatAmount(totalChargesAnn)} − ${formatAmount(urssafAnn)} = <strong>${formatAmount(netAnn)}</strong></p>

  <div class="footer">Document préparatoire établi à partir des données saisies dans PsyGest. À vérifier avec votre comptable ou l'URSSAF avant déclaration officielle.</div>
  </body></html>`;

  document.getElementById('print-container').innerHTML = html;
  window.print();
  setTimeout(()=>{ document.getElementById('print-container').innerHTML=''; }, 3000);
}
window.export2035 = export2035;

// ===== SETTINGS =====
function loadSettingsForm() {
  const s = state.settings;
  document.getElementById('set-prenom').value = s.prenom || '';
  document.getElementById('set-nom').value = s.nom || '';
  document.getElementById('set-rpps').value = s.rpps || '';
  document.getElementById('set-siret').value = s.siret || '';
  document.getElementById('set-adresse').value = s.adresse || '';
  document.getElementById('set-tel').value = s.tel || '';
  document.getElementById('set-email').value = s.email || '';
  document.getElementById('set-taux-urssaf').value = s.tauxUrssaf ?? 23.2;
  document.getElementById('set-tarif').value = s.tarifConsultation ?? 60;
  document.getElementById('set-duree').value = s.dureeConsultation ?? 50;
  document.getElementById('set-objectif-ca').value = s.objectifCA || '';
  document.getElementById('set-pwa-url').value = s.pwaUrl || '';
  document.getElementById('set-pwa-api-key').value = s.pwaApiKey || '';
  if (document.getElementById('set-honoraires-defaut')) document.getElementById('set-honoraires-defaut').value = s.honorairesDefaut || '';
  if (document.getElementById('set-duree-agenda')) document.getElementById('set-duree-agenda').value = s.dureeAgenda || '';
  if (document.getElementById('set-heure-debut')) document.getElementById('set-heure-debut').value = s.heureDebut || '08:00';
  if (document.getElementById('set-heure-fin')) document.getElementById('set-heure-fin').value = s.heureFin || '19:00';
}

async function saveSettings() {
  state.settings = {
    ...state.settings,
    prenom: document.getElementById('set-prenom').value.trim(),
    nom: document.getElementById('set-nom').value.trim(),
    rpps: document.getElementById('set-rpps').value.trim(),
    siret: document.getElementById('set-siret').value.trim(),
    adresse: document.getElementById('set-adresse').value.trim(),
    tel: document.getElementById('set-tel').value.trim(),
    email: document.getElementById('set-email').value.trim(),
    tauxUrssaf: parseFloat(document.getElementById('set-taux-urssaf').value) || 23.2,
    tarifConsultation: parseFloat(document.getElementById('set-tarif').value) || 60,
    dureeConsultation: parseInt(document.getElementById('set-duree').value) || 50,
    objectifCA: parseFloat(document.getElementById('set-objectif-ca').value) || 0,
    pwaUrl: document.getElementById('set-pwa-url').value.trim().replace(/\/$/, ''),
    pwaApiKey: document.getElementById('set-pwa-api-key').value.trim(),
    honorairesDefaut: parseFloat(document.getElementById('set-honoraires-defaut')?.value) || null,
    dureeAgenda: parseInt(document.getElementById('set-duree-agenda')?.value) || null,
    heureDebut: document.getElementById('set-heure-debut')?.value || '08:00',
    heureFin: document.getElementById('set-heure-fin')?.value || '19:00',
  };
  try {
    await saveSettingsOnly(_db, state.settings, state.nextFactureNum);
    refreshSidebarCounts();
    toast('Réglages enregistrés ✓');
  } catch (e) {
    console.error('saveSettings:', e);
    toast('Erreur lors de la sauvegarde des réglages.', 'error');
  }
}
window.saveSettings = saveSettings;

function toggleApiKeyVisibility() {
  const input = document.getElementById('set-pwa-api-key');
  const icon = document.getElementById('api-key-eye-icon');
  if (input.type === 'password') {
    input.type = 'text';
    icon.setAttribute('data-lucide', 'eye-off');
  } else {
    input.type = 'password';
    icon.setAttribute('data-lucide', 'eye');
  }
  lucide.createIcons();
}
window.toggleApiKeyVisibility = toggleApiKeyVisibility;

async function testerConnexionPi() {
  const statusEl = document.getElementById('pi-ping-status');
  const url = normalizeUrl(document.getElementById('set-pwa-url').value);
  const key = document.getElementById('set-pwa-api-key').value.trim();
  if (!url || !key) {
    statusEl.textContent = '⚠️ URL et clé API requises.';
    return;
  }
  statusEl.textContent = 'Test en cours…';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(`${url}/api/resultats`, {
      headers: { 'x-api-key': key },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      statusEl.innerHTML = '<span style="color:var(--color-success)">✅ Pi accessible</span>';
    } else if (res.status === 401 || res.status === 403) {
      statusEl.innerHTML = `<span style="color:var(--color-error)">❌ Clé API invalide — vérifiez la clé dans les réglages</span>`;
    } else {
      statusEl.innerHTML = `<span style="color:var(--color-error)">❌ Erreur HTTP ${res.status} — vérifiez l'URL</span>`;
    }
  } catch (e) {
    console.error('testerConnexionPi error:', e.name, e.message);
    if (e.name === 'AbortError') {
      statusEl.innerHTML = `<span style="color:var(--color-error)">❌ Délai dépassé (10s) — Pi injoignable ou réseau lent</span>`;
    } else if (e.message && e.message.includes('SSL') || e.message && e.message.includes('certificate')) {
      statusEl.innerHTML = `<span style="color:var(--color-error)">❌ Erreur SSL/TLS — certificat invalide ?</span>`;
    } else {
      statusEl.innerHTML = `<span style="color:var(--color-error)">❌ Pi inaccessible — ${e.message || e.name}</span>`;
    }
  }
}
window.testerConnexionPi = testerConnexionPi;

// ===== EXPORT / IMPORT =====
async function exportData() {
  try {
    const path = await dialogSave({
      defaultPath: `psygest-backup-${today()}.json`,
      filters: [{ name: 'Sauvegarde PsyGest', extensions: ['json'] }],
    });
    if (path) {
      const data = await exportAllData(_db);
      await writeTextFile(path, JSON.stringify(data, null, 2));
      toast('Sauvegarde exportée ✓');
    }
  } catch (e) {
    toast("Erreur lors de l'export.", 'error');
  }
}
window.exportData = exportData;

async function importData() {
  try {
    const confirmed = await ask(
      "Cette opération va remplacer toutes vos données actuelles. Continuer ?",
      { title: "Confirmer l'import", kind: 'warning' }
    );
    if (!confirmed) return;
    const path = await dialogOpen({
      filters: [{ name: 'Sauvegarde PsyGest', extensions: ['json'] }],
    });
    if (!path) return;
    const { readTextFile } = await import('@tauri-apps/plugin-fs');
    const content = await readTextFile(path);
    const imported = JSON.parse(content);
    // Accepte v1 (patients[]) et v2 (_version:2)
    if (!imported._version && !Array.isArray(imported.patients)) {
      toast('Fichier invalide : structure incorrecte.', 'error');
      return;
    }
    await importAllData(_db, imported);
    const loaded = await loadAll(_db);
    state.patients = loaded.patients;
    state.factures = loaded.factures;
    state.seances = loaded.seances;
    state.charges = loaded.charges;
    state.nextFactureNum = loaded.nextFactureNum || 1;
    state.settings = { ...DEFAULT_SETTINGS, ...loaded.settings };
    refreshSidebarCounts();
    navigate('dashboard');
    toast('Données importées ✓');
  } catch (e) {
    toast("Erreur lors de l'import : " + (e.message || e), 'error');
  }
}
window.importData = importData;

async function exportCSV() {
  try {
    const path = await dialogSave({
      defaultPath: `factures-psygest-${today()}.csv`,
      filters: [{ name: 'Fichier CSV', extensions: ['csv'] }],
    });
    if (!path) return;
    const headers = ['N° Facture', 'Date', 'Patient', 'Prestation', 'Durée (min)', 'Montant TTC (€)', 'Statut'];
    const rows = state.factures.map(f => {
      const patient = state.patients.find(p => p.id === f.patientId);
      return [
        f.numero, f.date,
        patient ? `${patient.prenom} ${patient.nom}` : '',
        f.prestation, f.duree || '',
        String(f.montant).replace('.', ','),
        f.statut === 'payee' ? 'Payée' : f.statut === 'en_attente' ? 'En attente' : 'Annulée',
      ];
    });
    const csv = '﻿' + [headers, ...rows]
      .map(r => r.map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(';'))
      .join('\r\n');
    await writeTextFile(path, csv);
    toast('Export CSV réussi ✓');
  } catch (e) {
    toast("Erreur lors de l'export CSV.", 'error');
  }
}
window.exportCSV = exportCSV;

// ===== SIDEBAR COUNTS =====
function refreshSidebarCounts() {
  document.getElementById('nb-patients').textContent = state.patients.length;
  document.getElementById('nb-factures').textContent = state.factures.length;
  const s = state.settings;
  const nom = [s.prenom, s.nom].filter(Boolean).join(' ');
  const userNameEl = document.querySelector('.user-name');
  const userAvatarEl = document.querySelector('.user-avatar');
  if (userNameEl) userNameEl.textContent = nom || 'Praticien';
  if (userAvatarEl) userAvatarEl.textContent = s.nom ? s.nom[0].toUpperCase() : '?';
}

// ===== PATIENT DETAIL =====
let _currentPatientId = null;

function openPatient(id) {
  const sid = String(id);
  const p = state.patients.find(p => String(p.id) === sid);
  if (!p) return;
  _currentPatientId = sid;
  // Ensure clinical sub-objects exist
  if (!p.notes) p.notes = [];
  if (!p.questionnaires) p.questionnaires = [];
  if (!p.objectifs) p.objectifs = { valeurs: {}, objectifs: [], engagements: [] };

  renderPatientDashboard(id);
  renderPatientInfos(id);

  switchPatientTab('infos');
  navigate('patient-detail');
}

async function renderPatientDashboard(id) {
  const p = state.patients.find(p => p.id === id);
  if (!p) return;
  const container = document.getElementById('pd-dashboard');
  if (!container) return;

  // Compute age
  let age = '—';
  if (p.naissance) {
    const birth = new Date(p.naissance + 'T12:00:00');
    const now = new Date();
    let a = now.getFullYear() - birth.getFullYear();
    const m = now.getMonth() - birth.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) a--;
    age = a + ' ans';
  }

  const patSeances = state.seances.filter(s => s.patientId === p.id);
  const patFactures = state.factures.filter(f => f.patientId === p.id);

  // KPIs
  const totalSeances = patSeances.length;
  const datesSeances = patSeances.map(s => s.date).sort();
  const firstSeance = datesSeances[0] ? formatDate(datesSeances[0]) : '—';

  // Prochaine séance
  const todayStr = today();
  const upcoming = patSeances
    .filter(s => s.date >= todayStr && s.statut !== 'annule')
    .sort((a, b) => a.date.localeCompare(b.date) || (a.heure || '').localeCompare(b.heure || ''));
  const nextSeance = upcoming[0]
    ? `${formatDate(upcoming[0].date)} ${upcoming[0].heure || ''} (${SEANCE_STATUTS[upcoming[0].statut]?.label || upcoming[0].statut})`
    : '—';

  // Impayées
  const unpaidCount = patFactures.filter(f => f.statut === 'en_attente').length;

  // Alertes
  const now2 = Date.now();
  const unpaidOld = patFactures.filter(f =>
    f.statut === 'en_attente' &&
    Math.floor((now2 - new Date(f.date + 'T12:00:00').getTime()) / 86400000) > 30
  );
  const lastSeanceDate = datesSeances.reverse()[0] || null;
  const daysSinceSeance = lastSeanceDate
    ? Math.floor((now2 - new Date(lastSeanceDate + 'T12:00:00').getTime()) / 86400000)
    : 999;
  const lastNote = (p.notes || []).slice().sort((a, b) => b.date.localeCompare(a.date))[0] || null;
  const daysSinceNote = lastNote
    ? Math.floor((now2 - new Date(lastNote.date + 'T12:00:00').getTime()) / 86400000)
    : 999;

  const alertsHTML = [
    unpaidOld.length ? `<span class="badge badge-error" style="font-size:11px;">🔴 Impayé &gt; 30j</span>` : '',
    (daysSinceSeance > 21 && patSeances.length > 0) ? `<span class="badge badge-warning" style="font-size:11px;">🟡 Inactif &gt; 21j</span>` : '',
    ((p.notes || []).length > 0 && daysSinceNote > 21) ? `<span class="badge badge-warning" style="font-size:11px;">🟡 Pas de note &gt; 21j</span>` : '',
  ].filter(Boolean).join('');

  const clotureLabel = p.cloture ? 'Réouvrir' : 'Clôturer';
  const clotureBadge = p.cloture ? `<span class="badge badge-muted"><i data-lucide="archive" style="width:12px;height:12px;"></i> Dossier clôturé</span>` : '';

  container.innerHTML = `
    <div class="pd-header-bar">
      <div class="pd-identity">
        <div class="patient-avatar" style="width:40px;height:40px;font-size:var(--text-sm);flex-shrink:0;">${getInitials(p.prenom, p.nom)}</div>
        <div style="min-width:0;">
          <div style="font-family:var(--font-display);font-size:var(--text-lg);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(p.prenom)} ${escapeHtml(p.nom)} ${clotureBadge}</div>
          <div style="font-size:var(--text-xs);color:var(--color-text-muted);">${age}${p.naissance ? ' · né(e) le ' + formatDate(p.naissance) : ''}${p.tel ? ' · ' + escapeHtml(p.tel) : ''}${p.email ? ' · ' + escapeHtml(p.email) : ''}</div>
        </div>
      </div>
      <div class="pd-header-stats">
        <div class="pd-stat"><span class="pd-stat-val">${totalSeances}</span><span class="pd-stat-lbl">séances</span></div>
        <div class="pd-stat"><span class="pd-stat-val">${firstSeance}</span><span class="pd-stat-lbl">1ère séance</span></div>
        <div class="pd-stat"><span class="pd-stat-val" style="${unpaidCount > 0 ? 'color:var(--color-error)' : ''}">${unpaidCount}</span><span class="pd-stat-lbl">impayée${unpaidCount > 1 ? 's' : ''}</span></div>
        ${alertsHTML ? `<div class="pd-stat">${alertsHTML}</div>` : ''}
      </div>
      <div class="pd-header-actions">
        <button class="btn btn-primary btn-sm" onclick="openNewSeanceForPatient('${id}')"><i data-lucide="plus"></i> Séance</button>
        <button class="btn btn-ghost btn-sm" onclick="exportDossierPDF()"><i data-lucide="file-down"></i></button>
        <button class="btn btn-ghost btn-sm" onclick="toggleClotureDossier()" title="${clotureLabel}"><i data-lucide="archive"></i></button>
        <button class="btn btn-ghost btn-sm" onclick="navigate('patients')"><i data-lucide="arrow-left"></i> Retour</button>
        <button class="btn btn-danger btn-sm" onclick="deleteCurrentPatient()"><i data-lucide="trash-2"></i></button>
      </div>
    </div>`;
  lucide.createIcons();
}
window.renderPatientDashboard = renderPatientDashboard;

function openNewSeanceForPatient(patientId) {
  populatePatientSelects();
  document.getElementById('s-date').value = today();
  document.getElementById('s-patient').value = patientId;
  document.getElementById('modalNewSeance').classList.add('open');
}
window.openNewSeanceForPatient = openNewSeanceForPatient;

function buildDualScoreChart(phq9Data, gad7Data) {
  const W = 380, H = 160, PAD = { top: 10, right: 16, bottom: 36, left: 32 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;
  const maxScore = 27;

  // Build union of dates, last 10 combined
  const allDates = [...new Set([...phq9Data.map(q => q.date), ...gad7Data.map(q => q.date)])].sort();
  const last10 = allDates.slice(-10);

  const xScale = i => last10.length === 1 ? PAD.left + chartW / 2 : PAD.left + (i / (last10.length - 1)) * chartW;
  const yScale = v => PAD.top + chartH - (v / maxScore) * chartH;

  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;">`;

  // Axes
  svg += `<line x1="${PAD.left}" y1="${PAD.top}" x2="${PAD.left}" y2="${PAD.top + chartH}" stroke="currentColor" stroke-opacity=".2" stroke-width="1"/>`;
  svg += `<line x1="${PAD.left}" y1="${PAD.top + chartH}" x2="${PAD.left + chartW}" y2="${PAD.top + chartH}" stroke="currentColor" stroke-opacity=".2" stroke-width="1"/>`;

  // Y ticks
  [0, 9, 18, 27].forEach(v => {
    const y = yScale(v);
    svg += `<text x="${PAD.left - 4}" y="${y + 4}" text-anchor="end" font-size="9" fill="currentColor" opacity=".5">${v}</text>`;
    svg += `<line x1="${PAD.left}" y1="${y}" x2="${PAD.left + chartW}" y2="${y}" stroke="currentColor" stroke-opacity=".08" stroke-width="1" stroke-dasharray="3,3"/>`;
  });

  // PHQ-9 line
  const phq9Points = last10.map((d, i) => {
    const q = phq9Data.filter(q => q.date <= d).slice(-1)[0];
    return q ? { x: xScale(i), y: yScale(q.score), score: q.score } : null;
  }).filter(Boolean);
  if (phq9Points.length > 1) {
    svg += `<polyline points="${phq9Points.map(p => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="var(--color-primary)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  }
  phq9Points.forEach(pt => {
    svg += `<circle cx="${pt.x}" cy="${pt.y}" r="3.5" fill="var(--color-primary)" stroke="white" stroke-width="1.5"/>`;
  });

  // GAD-7 line
  const gad7Points = last10.map((d, i) => {
    const q = gad7Data.filter(q => q.date <= d).slice(-1)[0];
    return q ? { x: xScale(i), y: yScale(q.score), score: q.score } : null;
  }).filter(Boolean);
  if (gad7Points.length > 1) {
    svg += `<polyline points="${gad7Points.map(p => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="var(--color-gold)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  }
  gad7Points.forEach(pt => {
    svg += `<circle cx="${pt.x}" cy="${pt.y}" r="3.5" fill="var(--color-gold)" stroke="white" stroke-width="1.5"/>`;
  });

  // X labels
  last10.forEach((d, i) => {
    const dateObj = new Date(d + 'T12:00:00');
    const lbl = `${String(dateObj.getDate()).padStart(2,'0')}/${String(dateObj.getMonth()+1).padStart(2,'0')}`;
    svg += `<text x="${xScale(i)}" y="${H - 4}" text-anchor="middle" font-size="9" fill="currentColor" opacity=".5">${lbl}</text>`;
  });

  // Legend
  svg += `<rect x="${PAD.left}" y="${PAD.top}" width="10" height="3" fill="var(--color-primary)" rx="1"/>`;
  svg += `<text x="${PAD.left + 13}" y="${PAD.top + 4}" font-size="9" fill="currentColor" opacity=".7">PHQ-9</text>`;
  svg += `<rect x="${PAD.left + 55}" y="${PAD.top}" width="10" height="3" fill="var(--color-gold)" rx="1"/>`;
  svg += `<text x="${PAD.left + 68}" y="${PAD.top + 4}" font-size="9" fill="currentColor" opacity=".7">GAD-7</text>`;

  svg += `</svg>`;
  return svg;
}

function renderPatientInfos(id) {
  const p = state.patients.find(p => p.id === id);
  if (!p) return;
  const factures = state.factures.filter(f => f.patientId === id)
    .sort((a, b) => b.date.localeCompare(a.date));
  const caTotal = factures.filter(f => f.statut === 'payee').reduce((s, f) => s + Number(f.montant), 0);

  const hasEmail = !!(p && p.email);
  const facturesHTML = factures.length ? factures.map(f => {
    const canAvoir = f.type !== 'avoir' && f.statut !== 'annulee';
    let payeeCell;
    if (f.type === 'avoir' || f.statut === 'annulee') {
      payeeCell = `<span style="color:var(--color-text-faint);padding:0 var(--space-2);">—</span>`;
    } else if (f.statut === 'payee') {
      payeeCell = `<span style="color:var(--color-success);padding:0 var(--space-2);">✓</span>`;
    } else {
      payeeCell = `<button class="btn btn-ghost btn-sm" onclick="markPaid(${f.id})" title="Marquer payée" style="color:var(--color-success)"><i data-lucide="check-circle"></i></button>`;
    }
    return `<tr>
      <td><span class="td-name">${escapeHtml(f.numero)}</span></td>
      <td>${formatDate(f.date)}</td>
      <td>${escapeHtml(f.prestation)}</td>
      <td><strong>${formatAmount(f.montant)}</strong></td>
      <td>${factureBadge(f)}</td>
      <td style="text-align:center;">
        <button class="btn btn-ghost btn-sm" onclick="apercuFacture(${f.id})" title="Voir la facture"><i data-lucide="eye"></i></button>
      </td>
      <td style="text-align:center;">
        ${hasEmail
          ? `<button class="btn btn-ghost btn-sm" onclick="sendByEmail(${f.id})" title="Envoyer par mail" style="color:var(--color-primary)"><i data-lucide="mail"></i></button>`
          : `<span title="Aucun email renseigné" style="color:var(--color-text-faint);padding:0 var(--space-2);">—</span>`}
      </td>
      <td style="text-align:center;">${payeeCell}</td>
      <td style="text-align:center;">
        ${canAvoir
          ? `<button class="btn btn-ghost btn-sm" onclick="openAvoirModal(${f.id})" title="Émettre un avoir" style="color:var(--color-error)"><i data-lucide="rotate-ccw"></i></button>`
          : `<span style="color:var(--color-text-faint);padding:0 var(--space-2);">—</span>`}
      </td>
    </tr>`;
  }).join('') : `<tr><td colspan="9"><div style="padding:var(--space-6);text-align:center;color:var(--color-text-muted);font-size:var(--text-sm);">Aucune facture pour ce patient.</div></td></tr>`;

  document.getElementById('pd-infos-content').innerHTML = `
    <div style="padding:var(--space-5);border-bottom:1px solid var(--color-divider);">
      <div style="font-size:var(--text-xs);font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--color-text-muted);margin-bottom:var(--space-3);">Informations</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-3);font-size:var(--text-sm);">
        <div><span style="color:var(--color-text-muted);font-size:var(--text-xs);">Dossier créé le</span><br>${formatDate(p.dateCreation?.split('T')[0])}</div>
        <div><span style="color:var(--color-text-muted);font-size:var(--text-xs);">CA total encaissé</span><br><strong>${formatAmount(caTotal)}</strong></div>
      </div>
      ${p.motif ? `<div style="margin-top:var(--space-3);font-size:var(--text-sm);"><span style="color:var(--color-text-muted);font-size:var(--text-xs);">Motif de consultation</span><br>${escapeHtml(p.motif)}</div>` : ''}
    </div>
    <div style="padding:var(--space-4) var(--space-5) var(--space-3);display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--color-divider);">
      <div style="font-size:var(--text-xs);font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--color-text-muted);">Factures (${factures.length})</div>
      <button class="btn btn-primary btn-sm" onclick="openNewFactureForPatient(${id})"><i data-lucide="plus"></i> Nouvelle facture</button>
    </div>
    <table>
      <thead><tr>
        <th>N°</th><th>Date</th><th>Prestation</th><th>Montant</th><th>Statut</th>
        <th style="text-align:center;">Aperçu</th>
        <th style="text-align:center;">Mail</th>
        <th style="text-align:center;">Payée</th>
        <th style="text-align:center;">Avoir</th>
      </tr></thead>
      <tbody id="pd-factures-tbody">${facturesHTML}</tbody>
    </table>`;
  lucide.createIcons();
}
window.openPatient = openPatient;

async function toggleClotureDossier() {
  const p = state.patients.find(p => p.id === _currentPatientId);
  if (!p) return;
  p.cloture = !p.cloture;
  await saveState();
  toast(p.cloture ? `Dossier de ${p.prenom} ${p.nom} clôturé.` : `Dossier de ${p.prenom} ${p.nom} réouvert.`);
  renderPatientDashboard(_currentPatientId);
}
window.toggleClotureDossier = toggleClotureDossier;

async function deleteCurrentPatient() {
  const p = state.patients.find(p => p.id === _currentPatientId);
  if (!p) return;
  const factures = state.factures.filter(f => f.patientId === p.id);
  const detail = factures.length
    ? `et ses ${factures.length} facture(s) associée(s)`
    : '';
  const msg = `Supprimer définitivement le dossier de ${p.prenom} ${p.nom} ${detail} ? ` +
    `Cette action supprime aussi l'anamnèse, les documents générés (courriers, attestations, comptes-rendus) ` +
    `et l'historique des questionnaires liés à ce patient. Elle est irréversible.`;
  const confirmed = await ask(msg, { title: 'Confirmer la suppression', kind: 'warning' });
  if (!confirmed) return;

  try {
    await deletePatientCascade(_db, p.id);
  } catch (e) {
    console.error('deleteCurrentPatient:', e);
    toast('Erreur lors de la suppression du dossier — rien n\'a été supprimé.', 'error');
    return;
  }

  state.patients = state.patients.filter(p => p.id !== _currentPatientId);
  state.factures = state.factures.filter(f => f.patientId !== _currentPatientId);
  state.seances = state.seances.filter(s => s.patientId !== _currentPatientId);
  _currentPatientId = null;
  await saveState();
  refreshSidebarCounts();
  refreshDashboard();
  navigate('patients');
  toast(`Dossier supprimé.`);
}
window.deleteCurrentPatient = deleteCurrentPatient;

function switchPatientTab(tab) {
  const tabs = ['infos', 'anamnes', 'notes', 'questionnaires', 'objectifs', 'documents'];
  tabs.forEach(t => {
    document.getElementById(`pd-tab-${t}`).classList.toggle('active', t === tab);
  });
  document.querySelectorAll('#pd-tabs .tab-btn').forEach((btn, i) => {
    btn.classList.toggle('active', tabs[i] === tab);
  });
  if (tab === 'anamnes') renderAnamneseTab();
  if (tab === 'notes') renderNotes();
  if (tab === 'questionnaires') { renderQuestionnaires(); renderOngletQuestionnaires(); }
  if (tab === 'objectifs') renderObjectifs();
  if (tab === 'documents') renderPatientDocuments(_currentPatientId);
}
window.switchPatientTab = switchPatientTab;

// Make patient cards clickable
function renderPatients(filter = '') {
  const grid = document.getElementById('patient-grid');
  const patients = state.patients.filter(p =>
    !filter || `${p.prenom} ${p.nom}`.toLowerCase().includes(filter.toLowerCase())
  );
  if (!patients.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:48px;height:48px;margin:0 auto var(--space-4)"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>
      <h3>Aucun patient</h3><p>Ajoutez votre premier dossier patient.</p>
      <button class="btn btn-primary" onclick="openModal('modalNewPatient')"><i data-lucide="user-plus"></i> Ajouter</button>
    </div>`;
    lucide.createIcons();
    return;
  }
  const now_ = Date.now();
  grid.innerHTML = patients.map(p => {
    const factures = state.factures.filter(f => f.patientId === p.id);
    const ca = factures.reduce((s, f) => s + (f.statut === 'payee' ? Number(f.montant) : 0), 0);
    const patSeances = state.seances.filter(s => s.patientId === p.id);
    const lastSeanceDate = patSeances.map(s => s.date).sort().reverse()[0] || null;
    const daysSinceSeance = lastSeanceDate ? Math.floor((now_ - new Date(lastSeanceDate + 'T12:00:00').getTime()) / 86400000) : 999;
    const unpaidOld = state.factures.filter(f => f.patientId === p.id && f.statut === 'en_attente' && Math.floor((now_ - new Date(f.date + 'T12:00:00').getTime()) / 86400000) > 30);
    return `<div class="patient-card${p.cloture ? ' patient-card-cloture' : ''}" onclick="openPatient('${p.id}')">
      <div class="patient-card-header">
        <div class="patient-avatar">${getInitials(p.prenom, p.nom)}</div>
        <div style="flex:1;">
          <div class="patient-name">${escapeHtml(p.prenom)} ${escapeHtml(p.nom)}</div>
          <div class="patient-info">${p.naissance ? 'né(e) le ' + formatDate(p.naissance) : 'Date non renseignée'}</div>
        </div>
        ${p.cloture ? '<span class="badge badge-muted" style="flex-shrink:0;">Clôturé</span>' : ''}
        ${unpaidOld.length ? '<span class="badge badge-error" style="font-size:10px;flex-shrink:0;">Impayé</span>' : ''}
        ${daysSinceSeance > 21 && patSeances.length > 0 ? '<span class="badge badge-warning" style="font-size:10px;flex-shrink:0;">Inactif</span>' : ''}
      </div>
      ${p.tel ? `<div style="font-size:var(--text-xs);color:var(--color-text-muted);margin-bottom:4px;">📞 ${escapeHtml(p.tel)}</div>` : ''}
      <div class="patient-stats">
        <div><div class="patient-stat-label">Séances</div><div class="patient-stat-val">${factures.length}</div></div>
        <div><div class="patient-stat-label">CA total</div><div class="patient-stat-val">${formatAmount(ca)}</div></div>
        <div><div class="patient-stat-label">Depuis</div><div class="patient-stat-val">${formatDate(p.dateCreation.split('T')[0])}</div></div>
      </div>
      <div class="rgpd-badge"><i data-lucide="shield-check" style="width:13px;height:13px;"></i> RGPD consenti</div>
    </div>`;
  }).join('');
  lucide.createIcons();
}
window.filterPatients = v => renderPatients(v);

// Register patient-detail page name
pageNames['patient-detail'] = 'Dossier patient';

// ===== NOTES =====
const NOTE_TEMPLATES = {
  libre: '',
  eval_initiale: `## Motif de consultation\n\n## Histoire du problème\n\n## Facteurs de maintien\n\n## Objectifs thérapeutiques\n\n## Plan de traitement proposé\n`,
  seance_tcc: `## Revue de la semaine\n\n## Travail en séance\n\n## Pensées automatiques identifiées\n\n## Restructuration cognitive\n\n## Tâches pour la prochaine séance\n`,
  seance_act: `## Revue des engagements\n\n## Processus travaillés (défusion / acceptance / valeurs / engagement)\n\n## Exercices réalisés\n\n## Engagements pour la prochaine séance\n`,
  bilan: `## Résumé du suivi\n\n## Évolution observée\n\n## Objectifs atteints\n\n## Recommandations\n`,
};
const NOTE_TEMPLATE_LABELS = {
  libre: 'Libre', eval_initiale: 'Éval. initiale (TCC)',
  seance_tcc: 'Séance TCC', seance_act: 'Séance ACT', bilan: 'Bilan',
};
let _editingNoteId = null;

function applyNoteTemplate() {
  const tpl = document.getElementById('note-template').value;
  const ta = document.getElementById('note-contenu');
  if (!ta.value || confirm('Remplacer le contenu par le template ?')) {
    ta.value = NOTE_TEMPLATES[tpl] || '';
  }
}
window.applyNoteTemplate = applyNoteTemplate;

function renderNotes() {
  const p = state.patients.find(p => p.id === _currentPatientId);
  if (!p) return;
  if (!p.notes) p.notes = [];

  // Populate séance select
  const seanceSel = document.getElementById('note-seance');
  const patSeances = state.seances.filter(s => s.patientId === p.id).sort((a, b) => b.date.localeCompare(a.date));
  seanceSel.innerHTML = '<option value="">— aucune —</option>' +
    patSeances.map(s => `<option value="${s.id}">${formatDate(s.date)} ${s.heure || ''}</option>`).join('');

  if (!document.getElementById('note-date').value) {
    document.getElementById('note-date').value = today();
  }

  const list = document.getElementById('notes-list');
  if (!p.notes.length) {
    list.innerHTML = `<div style="text-align:center;padding:var(--space-8);color:var(--color-text-muted);font-size:var(--text-sm);">Aucune note — créez-en une ci-dessus.</div>`;
    return;
  }
  const sorted = p.notes.slice().sort((a, b) => b.date.localeCompare(a.date));
  list.innerHTML = sorted.map(n => {
    const preview = escapeHtml((n.contenu || '').replace(/^#+\s*/gm, '').trim().slice(0, 120));
    return `<div class="note-card">
      <div class="note-card-header">
        <span class="note-card-date">${formatDate(n.date)}</span>
        <span class="note-card-template"><span class="badge badge-primary">${escapeHtml(NOTE_TEMPLATE_LABELS[n.template] || n.template)}</span></span>
      </div>
      <div class="note-card-preview">${preview || '<em>Note vide</em>'}</div>
      <div class="note-card-actions">
        <button class="btn btn-ghost btn-sm" onclick="editNote(${n.id})"><i data-lucide="pencil"></i> Modifier</button>
        <button class="btn btn-ghost btn-sm" style="color:var(--color-error)" onclick="deleteNote(${n.id})"><i data-lucide="trash-2"></i> Supprimer</button>
      </div>
    </div>`;
  }).join('');
  lucide.createIcons();
}

function editNote(id) {
  const p = state.patients.find(p => p.id === _currentPatientId);
  if (!p) return;
  const n = p.notes.find(n => n.id === id);
  if (!n) return;
  _editingNoteId = id;
  document.getElementById('note-date').value = n.date;
  document.getElementById('note-seance').value = n.seanceId || '';
  document.getElementById('note-template').value = n.template || 'libre';
  document.getElementById('note-contenu').value = n.contenu || '';
  document.getElementById('note-contenu').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
window.editNote = editNote;

async function saveNote() {
  const p = state.patients.find(p => p.id === _currentPatientId);
  if (!p) return;
  if (!p.notes) p.notes = [];
  const date = document.getElementById('note-date').value;
  const contenu = document.getElementById('note-contenu').value.trim();
  if (!date) { toast('Date requise.', 'error'); return; }
  if (_editingNoteId) {
    const n = p.notes.find(n => n.id === _editingNoteId);
    if (n) {
      n.date = date;
      n.seanceId = document.getElementById('note-seance').value || null;
      n.template = document.getElementById('note-template').value;
      n.contenu = contenu;
    }
  } else {
    p.notes.push({
      id: String(Date.now()),
      date, contenu,
      seanceId: document.getElementById('note-seance').value || null,
      template: document.getElementById('note-template').value,
      dateCreation: new Date().toISOString(),
    });
  }
  await saveState();
  resetNoteEditor();
  renderNotes();
  toast('Note enregistrée ✓');
}
window.saveNote = saveNote;

function resetNoteEditor() {
  _editingNoteId = null;
  document.getElementById('note-date').value = today();
  document.getElementById('note-template').value = 'libre';
  document.getElementById('note-contenu').value = '';
  document.getElementById('note-seance').value = '';
}
window.resetNoteEditor = resetNoteEditor;

async function deleteNote(id) {
  const p = state.patients.find(p => p.id === _currentPatientId);
  if (!p) return;
  if (!confirm('Supprimer cette note ?')) return;
  p.notes = p.notes.filter(n => n.id !== id);
  await saveState();
  renderNotes();
  toast('Note supprimée.');
}
window.deleteNote = deleteNote;

// ===== QUESTIONNAIRES =====
const PHQ9_QUESTIONS = [
  'Peu d\'intérêt ou de plaisir à faire les choses',
  'Se sentir triste, déprimé(e) ou désespéré(e)',
  'Difficultés à s\'endormir ou à rester endormi(e), ou au contraire dormir trop',
  'Se sentir fatigué(e) ou manquer d\'énergie',
  'Avoir peu d\'appétit ou manger trop',
  'Avoir une mauvaise opinion de soi-même, se sentir nul(le), ou avoir l\'impression d\'avoir déçu sa famille ou s\'être déçu(e)',
  'Avoir du mal à se concentrer, par exemple pour lire le journal ou regarder la télévision',
  'Bouger ou parler tellement lentement que les autres auraient pu le remarquer, ou au contraire être si agité(e) que vous vous déplacez beaucoup plus que d\'habitude',
  'Avoir des pensées qu\'il vaudrait mieux mourir ou qu\'on voudrait se faire du mal d\'une façon ou d\'une autre',
];
const GAD7_QUESTIONS = [
  'Se sentir nerveux(se), anxieux(se) ou à bout',
  'Ne pas être capable d\'arrêter de s\'inquiéter ou de contrôler ses inquiétudes',
  'S\'inquiéter trop à propos de différentes choses',
  'Avoir du mal à se détendre',
  'Être tellement agité(e) qu\'il est difficile de rester en place',
  'Devenir facilement irritable ou irrité(e)',
  'Avoir peur que quelque chose de terrible puisse arriver',
];
const Q_OPTIONS = ['Jamais', 'Plusieurs jours', 'Plus de la moitié du temps', 'Presque tous les jours'];

function phq9Interpretation(score) {
  if (score <= 4) return { label: 'Minimal', color: '#427a32' };
  if (score <= 9) return { label: 'Léger', color: '#7a7432' };
  if (score <= 14) return { label: 'Modéré', color: '#9e6030' };
  if (score <= 19) return { label: 'Modérément sévère', color: '#c87030' };
  return { label: 'Sévère', color: '#a0354a' };
}
function gad7Interpretation(score) {
  if (score <= 4) return { label: 'Minimal', color: '#427a32' };
  if (score <= 9) return { label: 'Léger', color: '#7a7432' };
  if (score <= 14) return { label: 'Modéré', color: '#9e6030' };
  return { label: 'Sévère', color: '#a0354a' };
}

let _activePassation = null; // { type, reponses[] }

function startQuestionnaire(type) {
  _activePassation = { type, reponses: [] };
  renderPassation(type);
}
window.startQuestionnaire = startQuestionnaire;

function renderPassation(type) {
  const questions = type === 'phq9' ? PHQ9_QUESTIONS : GAD7_QUESTIONS;
  const el = document.getElementById(`qpassation-${type}`);
  el.classList.add('active');
  el.innerHTML = `<div style="margin-bottom:var(--space-4);">` +
    questions.map((q, i) => `
      <div class="question-step" id="qstep-${type}-${i}">
        <div class="question-text">${i + 1}. ${q}</div>
        <div class="question-options">
          ${Q_OPTIONS.map((opt, v) => `
            <label class="question-option" id="qopt-${type}-${i}-${v}">
              <input type="radio" name="q-${type}-${i}" value="${v}" onchange="selectOption('${type}',${i},${v})">
              <span>${v} — ${opt}</span>
            </label>`).join('')}
        </div>
      </div>`).join('') +
    `</div>
    <div style="display:flex;gap:var(--space-2);">
      <button class="btn btn-primary" onclick="submitQuestionnaire('${type}')"><i data-lucide="check"></i> Calculer le score</button>
      <button class="btn btn-ghost" onclick="cancelPassation('${type}')">Annuler</button>
    </div>`;
  lucide.createIcons();
}

function selectOption(type, qi, val) {
  Q_OPTIONS.forEach((_, v) => {
    document.getElementById(`qopt-${type}-${qi}-${v}`)?.classList.toggle('selected', v === val);
  });
}
window.selectOption = selectOption;

async function submitQuestionnaire(type) {
  const p = state.patients.find(p => p.id === _currentPatientId);
  if (!p) return;
  if (!p.questionnaires) p.questionnaires = [];
  const questions = type === 'phq9' ? PHQ9_QUESTIONS : GAD7_QUESTIONS;
  const reponses = [];
  for (let i = 0; i < questions.length; i++) {
    const sel = document.querySelector(`input[name="q-${type}-${i}"]:checked`);
    if (!sel) { toast(`Répondez à toutes les questions (question ${i + 1} manquante).`, 'error'); return; }
    reponses.push(parseInt(sel.value));
  }
  const score = reponses.reduce((s, v) => s + v, 0);
  const interp = type === 'phq9' ? phq9Interpretation(score) : gad7Interpretation(score);
  p.questionnaires.push({
    id: String(Date.now()), type, date: today(), reponses, score, interpretation: interp.label,
  });
  await saveState();
  document.getElementById(`qpassation-${type}`).classList.remove('active');
  _activePassation = null;
  renderQuestionnaires();
  toast(`${type.toUpperCase()} enregistré — Score : ${score} (${interp.label}) ✓`);
}
window.submitQuestionnaire = submitQuestionnaire;

function cancelPassation(type) {
  document.getElementById(`qpassation-${type}`).classList.remove('active');
  _activePassation = null;
}
window.cancelPassation = cancelPassation;

async function deletePassation(id) {
  const p = state.patients.find(p => p.id === _currentPatientId);
  if (!p) return;
  if (!confirm('Supprimer cette passation ?')) return;
  p.questionnaires = p.questionnaires.filter(q => q.id !== id);
  await saveState();
  renderQuestionnaires();
}
window.deletePassation = deletePassation;

function renderQuestionnaires() {
  const p = state.patients.find(p => p.id === _currentPatientId);
  if (!p || !p.questionnaires) return;
  ['phq9', 'gad7'].forEach(type => {
    const passations = p.questionnaires.filter(q => q.type === type)
      .sort((a, b) => a.date.localeCompare(b.date));
    const histEl = document.getElementById(`qhistory-${type}`);
    if (!passations.length) {
      histEl.innerHTML = `<div style="font-size:var(--text-xs);color:var(--color-text-muted);padding:var(--space-2) 0;">Aucune passation enregistrée.</div>`;
      document.getElementById(`qchart-${type}`).innerHTML = '';
      return;
    }
    histEl.innerHTML = passations.slice().reverse().map(q => {
      const interp = type === 'phq9' ? phq9Interpretation(q.score) : gad7Interpretation(q.score);
      return `<div class="passation-row">
        <span style="flex:1;">${formatDate(q.date)}</span>
        <strong style="min-width:30px;text-align:right;">${q.score}</strong>
        <span class="badge" style="background:${interp.color}22;color:${interp.color};">${escapeHtml(q.interpretation)}</span>
        <button class="btn btn-ghost btn-sm" onclick="deletePassation(${q.id})" style="color:var(--color-error);padding:2px 6px;"><i data-lucide="trash-2" style="width:13px;height:13px;"></i></button>
      </div>`;
    }).join('');
    lucide.createIcons();
    document.getElementById(`qchart-${type}`).innerHTML = buildScoreChart(passations, type);
  });
}

function buildScoreChart(passations, type) {
  if (passations.length < 1) return '';
  const maxScore = type === 'phq9' ? 27 : 21;
  const W = 460, H = 160, PAD = { top: 10, right: 16, bottom: 36, left: 32 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  // Thresholds for background bands
  const bands = type === 'phq9'
    ? [{ min: 0, max: 4, color: '#42a32a22' }, { min: 5, max: 9, color: '#a0a02222' }, { min: 10, max: 14, color: '#c8782222' }, { min: 15, max: 19, color: '#c8602222' }, { min: 20, max: 27, color: '#a0354a22' }]
    : [{ min: 0, max: 4, color: '#42a32a22' }, { min: 5, max: 9, color: '#a0a02222' }, { min: 10, max: 14, color: '#c8782222' }, { min: 15, max: 21, color: '#a0354a22' }];

  const xScale = i => passations.length === 1 ? PAD.left + chartW / 2 : PAD.left + (i / (passations.length - 1)) * chartW;
  const yScale = v => PAD.top + chartH - (v / maxScore) * chartH;

  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:${W}px;">`;

  // Background bands
  bands.forEach(b => {
    const y1 = yScale(b.max);
    const y2 = yScale(b.min);
    svg += `<rect x="${PAD.left}" y="${y1}" width="${chartW}" height="${y2 - y1}" fill="${b.color}" />`;
  });

  // Axes
  svg += `<line x1="${PAD.left}" y1="${PAD.top}" x2="${PAD.left}" y2="${PAD.top + chartH}" stroke="currentColor" stroke-opacity=".2" stroke-width="1"/>`;
  svg += `<line x1="${PAD.left}" y1="${PAD.top + chartH}" x2="${PAD.left + chartW}" y2="${PAD.top + chartH}" stroke="currentColor" stroke-opacity=".2" stroke-width="1"/>`;

  // Y axis labels
  const yTicks = type === 'phq9' ? [0, 5, 10, 15, 20, 27] : [0, 5, 10, 15, 21];
  yTicks.forEach(v => {
    const y = yScale(v);
    svg += `<text x="${PAD.left - 4}" y="${y + 4}" text-anchor="end" font-size="9" fill="currentColor" opacity=".5">${v}</text>`;
    svg += `<line x1="${PAD.left}" y1="${y}" x2="${PAD.left + chartW}" y2="${y}" stroke="currentColor" stroke-opacity=".08" stroke-width="1" stroke-dasharray="3,3"/>`;
  });

  // Line
  if (passations.length > 1) {
    const pts = passations.map((q, i) => `${xScale(i)},${yScale(q.score)}`).join(' ');
    svg += `<polyline points="${pts}" fill="none" stroke="#5a6e5c" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  }

  // Points + X labels
  passations.forEach((q, i) => {
    const x = xScale(i), y = yScale(q.score);
    const interp = type === 'phq9' ? phq9Interpretation(q.score) : gad7Interpretation(q.score);
    svg += `<circle cx="${x}" cy="${y}" r="4" fill="${interp.color}" stroke="white" stroke-width="1.5"/>`;
    svg += `<title>${formatDate(q.date)}: ${q.score} (${escapeHtml(q.interpretation)})</title>`;
    // X date label (short)
    const d = new Date(q.date + 'T12:00:00');
    const lbl = `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}`;
    svg += `<text x="${x}" y="${H - 4}" text-anchor="middle" font-size="9" fill="currentColor" opacity=".5">${lbl}</text>`;
  });

  svg += `</svg>`;
  return svg;
}

// ===== OBJECTIFS =====
const DOMAINES = ['famille', 'relations', 'travail', 'sante', 'loisirs', 'developpement', 'spiritualite', 'engagement'];
const DOMAINE_LABELS = { famille: 'Famille', relations: 'Relations', travail: 'Travail', sante: 'Santé', loisirs: 'Loisirs', developpement: 'Développement personnel', spiritualite: 'Spiritualité', engagement: 'Engagement citoyen' };
const STATUT_COLORS = { en_cours: 'badge-primary', atteint: 'badge-success', abandonne: 'badge-muted' };
const STATUT_LABELS = { en_cours: 'En cours', atteint: 'Atteint', abandonne: 'Abandonné' };

function renderObjectifs() {
  const p = state.patients.find(p => p.id === _currentPatientId);
  if (!p || !p.objectifs) return;

  // Valeurs
  const valeursGrid = document.getElementById('valeurs-grid');
  valeursGrid.innerHTML = DOMAINES.map(d => `
    <div class="valeur-card">
      <div class="valeur-domaine">${escapeHtml(DOMAINE_LABELS[d])}</div>
      <textarea class="form-textarea" id="valeur-${d}" placeholder="Ce qui compte pour moi…" rows="3" style="font-size:var(--text-sm);">${escapeHtml((p.objectifs.valeurs && p.objectifs.valeurs[d]) || '')}</textarea>
    </div>`).join('');

  // Objectifs
  const objList = document.getElementById('objectifs-list');
  const objs = p.objectifs.objectifs || [];
  if (!objs.length) {
    objList.innerHTML = `<div style="text-align:center;padding:var(--space-6);color:var(--color-text-muted);font-size:var(--text-sm);">Aucun objectif défini.</div>`;
  } else {
    objList.innerHTML = objs.map(o => `
      <div class="objectif-card">
        <div class="objectif-body">
          <div class="objectif-title">${escapeHtml(o.intitule)}</div>
          <div class="objectif-meta">${escapeHtml(DOMAINE_LABELS[o.domaine] || o.domaine)} · ${formatDate(o.dateCreation?.split('T')[0])}</div>
          ${o.notes ? `<div style="font-size:var(--text-xs);color:var(--color-text-muted);margin-top:4px;">${escapeHtml(o.notes)}</div>` : ''}
        </div>
        <div style="display:flex;flex-direction:column;gap:var(--space-2);align-items:flex-end;">
          <span class="badge ${STATUT_COLORS[o.statut] || 'badge-muted'}">${escapeHtml(STATUT_LABELS[o.statut] || o.statut)}</span>
          <div style="display:flex;gap:var(--space-1);">
            <button class="btn btn-ghost btn-sm" onclick="editObjectif(${o.id})"><i data-lucide="pencil"></i></button>
            <button class="btn btn-ghost btn-sm" style="color:var(--color-error)" onclick="deleteObjectif(${o.id})"><i data-lucide="trash-2"></i></button>
          </div>
        </div>
      </div>`).join('');
    lucide.createIcons();
  }

  // Engagements
  const engList = document.getElementById('engagements-list');
  const engs = p.objectifs.engagements || [];
  if (!engs.length) {
    engList.innerHTML = `<div style="text-align:center;padding:var(--space-4);color:var(--color-text-muted);font-size:var(--text-sm);">Aucun engagement enregistré.</div>`;
  } else {
    engList.innerHTML = engs.slice().reverse().map(e => `
      <div class="engagement-item">
        <input type="checkbox" ${e.realise ? 'checked' : ''} onchange="toggleEngagement(${e.id})">
        <div style="flex:1;">
          <div class="${e.realise ? 'engagement-done' : ''}">${escapeHtml(e.texte)}</div>
          <div style="font-size:var(--text-xs);color:var(--color-text-muted);">${formatDate(e.date)}</div>
        </div>
        <button class="btn btn-ghost btn-sm" style="color:var(--color-error)" onclick="deleteEngagement(${e.id})"><i data-lucide="trash-2" style="width:13px;height:13px;"></i></button>
      </div>`).join('');
    lucide.createIcons();
  }
}

async function saveValeurs() {
  const p = state.patients.find(p => p.id === _currentPatientId);
  if (!p || !p.objectifs) return;
  if (!p.objectifs.valeurs) p.objectifs.valeurs = {};
  DOMAINES.forEach(d => {
    p.objectifs.valeurs[d] = document.getElementById(`valeur-${d}`)?.value?.trim() || '';
  });
  await saveState();
  toast('Valeurs enregistrées ✓');
}
window.saveValeurs = saveValeurs;

function openModal_NewObjectif() { openModal('modalNewObjectif'); }

async function saveObjectif() {
  const p = state.patients.find(p => p.id === _currentPatientId);
  if (!p || !p.objectifs) return;
  const intitule = document.getElementById('obj-intitule').value.trim();
  if (!intitule) { toast('Intitulé requis.', 'error'); return; }
  const editId = document.getElementById('obj-edit-id').value;
  if (editId) {
    const o = p.objectifs.objectifs.find(o => o.id === parseInt(editId));
    if (o) {
      o.intitule = intitule;
      o.domaine = document.getElementById('obj-domaine').value;
      o.statut = document.getElementById('obj-statut').value;
      o.notes = document.getElementById('obj-notes').value.trim();
    }
  } else {
    if (!p.objectifs.objectifs) p.objectifs.objectifs = [];
    p.objectifs.objectifs.push({
      id: String(Date.now()), intitule,
      domaine: document.getElementById('obj-domaine').value,
      statut: document.getElementById('obj-statut').value,
      notes: document.getElementById('obj-notes').value.trim(),
      dateCreation: new Date().toISOString(),
    });
  }
  await saveState();
  closeModal('modalNewObjectif');
  document.getElementById('obj-intitule').value = '';
  document.getElementById('obj-notes').value = '';
  document.getElementById('obj-edit-id').value = '';
  renderObjectifs();
  toast('Objectif enregistré ✓');
}
window.saveObjectif = saveObjectif;

function editObjectif(id) {
  const p = state.patients.find(p => p.id === _currentPatientId);
  if (!p) return;
  const o = p.objectifs.objectifs.find(o => o.id === id);
  if (!o) return;
  document.getElementById('obj-intitule').value = o.intitule;
  document.getElementById('obj-domaine').value = o.domaine;
  document.getElementById('obj-statut').value = o.statut;
  document.getElementById('obj-notes').value = o.notes || '';
  document.getElementById('obj-edit-id').value = id;
  openModal('modalNewObjectif');
}
window.editObjectif = editObjectif;

async function deleteObjectif(id) {
  const p = state.patients.find(p => p.id === _currentPatientId);
  if (!p) return;
  if (!confirm('Supprimer cet objectif ?')) return;
  p.objectifs.objectifs = p.objectifs.objectifs.filter(o => o.id !== id);
  await saveState();
  renderObjectifs();
  toast('Objectif supprimé.');
}
window.deleteObjectif = deleteObjectif;

async function addEngagement() {
  const p = state.patients.find(p => p.id === _currentPatientId);
  if (!p || !p.objectifs) return;
  if (!p.objectifs.engagements) p.objectifs.engagements = [];
  const texte = document.getElementById('engagement-text').value.trim();
  if (!texte) { toast('Texte de l\'engagement requis.', 'error'); return; }
  p.objectifs.engagements.push({ id: String(Date.now()), texte, date: today(), realise: false });
  await saveState();
  document.getElementById('engagement-text').value = '';
  renderObjectifs();
  toast('Engagement ajouté ✓');
}
window.addEngagement = addEngagement;

async function toggleEngagement(id) {
  const p = state.patients.find(p => p.id === _currentPatientId);
  if (!p) return;
  const e = p.objectifs.engagements.find(e => e.id === id);
  if (e) e.realise = !e.realise;
  await saveState();
  renderObjectifs();
}
window.toggleEngagement = toggleEngagement;

async function deleteEngagement(id) {
  const p = state.patients.find(p => p.id === _currentPatientId);
  if (!p) return;
  p.objectifs.engagements = p.objectifs.engagements.filter(e => e.id !== id);
  await saveState();
  renderObjectifs();
}
window.deleteEngagement = deleteEngagement;

// ===== EXPORT DOSSIER PDF =====
function exportDossierPDF() {
  if (!_currentPatientId) return;
  openModal('modalExportPDF');
}
window.exportDossierPDF = exportDossierPDF;

async function genererPDF() {
  const p = state.patients.find(p => p.id === _currentPatientId);
  if (!p) return;

  const optInfos          = document.getElementById('pdf-opt-infos')?.checked ?? true;
  const optQuestionnaires = document.getElementById('pdf-opt-questionnaires')?.checked ?? true;
  const optNotes          = document.getElementById('pdf-opt-notes')?.checked ?? true;
  const optDetailItems    = document.getElementById('pdf-opt-detail-items')?.checked ?? false;

  closeModal('modalExportPDF');

  const s = state.settings;
  const praticien = escapeHtml([s.prenom, s.nom].filter(Boolean).join(' ') || 'Praticien');
  const dateGen = formatDate(today());
  const seancesPatient = state.seances.filter(se => se.patientId === p.id);
  const datesSeances = seancesPatient.map(se => se.date).sort();
  const debutSuivi = datesSeances.length ? formatDate(datesSeances[0]) : '—';

  // Données async
  const anamnese = await getAnamnese(_db, String(p.id));
  const resultats = await getResultatsByPatient(_db, String(p.id));
  const documents = await getDocumentsByPatient(_db, String(p.id));
  const objectifs = p.objectifs || { valeurs: {}, objectifs: [], engagements: [] };

  // ── Page de garde ──────────────────────────────────────────────────────────
  let html = `
  <div class="dossier-header">
    <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px;">Document confidentiel — dossier de suivi psychologique</div>
    <div class="dossier-patient-name">${escapeHtml(p.prenom)} ${escapeHtml(p.nom)}</div>
    <div style="font-size:12px;color:#555;margin-top:4px;">
      ${p.naissance ? 'Né(e) le ' + formatDate(p.naissance) + ' · ' : ''}Début de suivi : ${debutSuivi}
    </div>
    <div style="font-size:11px;color:#888;margin-top:8px;">
      Document généré le ${dateGen} par ${praticien}, Psychologue${s.rpps ? ' · N° RPPS : ' + escapeHtml(s.rpps) : ''}${s.adresse ? ' · ' + escapeHtml(s.adresse).replace(/\n/g, ', ') : ''}
    </div>
  </div>`;

  // ── Section 1 : Informations générales & anamnèse ─────────────────────────
  if (optInfos) {
    html += `<div class="dossier-section page-break">
      <div class="dossier-section-title">1 — Informations générales</div>
      <table class="dossier-score-table">
        ${p.naissance ? `<tr><th>Date de naissance</th><td>${formatDate(p.naissance)}</td></tr>` : ''}
        ${p.motif ? `<tr><th>Motif de consultation</th><td>${escapeHtml(p.motif)}</td></tr>` : ''}
        <tr><th>Début de suivi</th><td>${debutSuivi}</td></tr>
        ${seancesPatient.length ? `<tr><th>Séances enregistrées</th><td>${seancesPatient.length}</td></tr>` : ''}
        ${p.sourceOrientation ? `<tr><th>Source d'orientation</th><td>${escapeHtml(p.sourceOrientation)}</td></tr>` : ''}
      </table>`;

    if (anamnese) {
      const champAnamnese = [
        ['Motif principal', anamnese.motif_principal],
        ['Depuis', anamnese.motif_depuis],
        ['Contexte d\'apparition', anamnese.contexte_apparition],
        ['Facteurs déclenchants', anamnese.facteurs_declenchants],
        ['Évolution', anamnese.evolution],
        ['Antécédents personnels', anamnese.atcd_personnels],
        ['Antécédents familiaux', anamnese.atcd_familiaux],
        ['Situation professionnelle', anamnese.situation_pro],
        ['Situation familiale', anamnese.situation_familiale],
        ['Orientation thérapeutique', anamnese.orientation_therapeutique],
        ['Objectifs de prise en charge', anamnese.objectifs_prise_en_charge],
      ].filter(([, v]) => v);
      if (champAnamnese.length) {
        html += `<div style="margin-top:14px;"><div class="dossier-section-title" style="font-size:12px;">Anamnèse</div>
          <table class="dossier-score-table" style="margin-top:8px;">
            ${champAnamnese.map(([k, v]) => `<tr><th style="width:35%;">${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('')}
          </table></div>`;
      }
    }
    html += `</div>`;
  }

  // ── Section 2 : Questionnaires ────────────────────────────────────────────
  if (optQuestionnaires) {
    const slugsAvecResultats = [...new Set(resultats.map(r => r.questionnaire_slug))];
    html += `<div class="dossier-section page-break">
      <div class="dossier-section-title">2 — Résultats des questionnaires</div>
      <div style="font-size:11px;color:#888;margin-bottom:12px;font-style:italic;">Ces outils sont des aides au repérage clinique, non des outils diagnostiques.</div>`;

    if (!slugsAvecResultats.length) {
      html += `<div style="color:#888;font-size:13px;">Aucune passation enregistrée via la PWA.</div>`;
    } else {
      for (const slug of slugsAvecResultats) {
        const meta = QUESTIONNAIRE_META[slug] || { label: slug, titre: '', scoreMax: 100 };
        const rows = resultats.filter(r => r.questionnaire_slug === slug).sort((a, b) => a.date_passation.localeCompare(b.date_passation));
        html += `<div style="margin-bottom:20px;">
          <div class="dossier-section-title" style="font-size:12px;">${escapeHtml(meta.label)} — ${escapeHtml(meta.titre)}</div>
          <table class="dossier-score-table" style="margin-top:8px;">
            <thead><tr><th>Date</th><th>Score</th><th>Interprétation</th><th>Évolution</th></tr></thead>
            <tbody>${rows.map((r, i) => {
              const prev = i > 0 ? rows[i - 1] : null;
              let delta = '—';
              if (prev && r.score_total !== null && prev.score_total !== null) {
                const d = r.score_total - prev.score_total;
                delta = (d > 0 ? '↑ +' : d < 0 ? '↓ ' : '→ ') + d;
              }
              return `<tr><td>${formatDate(r.date_passation.slice(0,10))}</td><td>${r.score_total ?? '—'} / ${meta.scoreMax}</td><td>${escapeHtml(r.interpretation || '—')}</td><td>${delta}</td></tr>`;
            }).join('')}</tbody>
          </table>
          <div style="margin-top:10px;">${buildEvolutionSvgForPrint(rows, meta)}</div>
        </div>`;
      }
    }
    html += `</div>`;
  }

  // ── Section 3 : Notes cliniques & objectifs ACT ───────────────────────────
  if (optNotes) {
    const notes = (p.notes || []).slice().sort((a, b) => a.date.localeCompare(b.date));
    html += `<div class="dossier-section page-break">
      <div class="dossier-section-title">3 — Notes cliniques</div>
      ${notes.length ? notes.map(n => `
        <div class="dossier-note">
          <div class="dossier-note-meta">${formatDate(n.date)} · ${escapeHtml(NOTE_TEMPLATE_LABELS[n.template] || n.template)}</div>
          <div class="dossier-note-content">${escapeHtml(n.contenu)}</div>
        </div>`).join('')
      : '<div style="color:#888;font-size:13px;">Aucune note clinique enregistrée.</div>'}`;

    // Objectifs ACT
    if ((objectifs.objectifs || []).length || Object.values(objectifs.valeurs || {}).some(Boolean)) {
      html += `<div style="margin-top:18px;"><div class="dossier-section-title" style="font-size:12px;">Objectifs ACT</div>
        ${DOMAINES.filter(d => objectifs.valeurs?.[d]).map(d =>
          `<div style="font-size:13px;margin:4px 0;"><strong>${escapeHtml(DOMAINE_LABELS[d])} :</strong> ${escapeHtml(objectifs.valeurs[d])}</div>`
        ).join('')}
        ${(objectifs.objectifs || []).length ? `<table class="dossier-score-table" style="margin-top:8px;">
          <thead><tr><th>Objectif</th><th>Statut</th></tr></thead>
          <tbody>${objectifs.objectifs.map(o => `<tr><td>${escapeHtml(o.intitule)}</td><td>${escapeHtml(STATUT_LABELS[o.statut]||o.statut)}</td></tr>`).join('')}</tbody>
        </table>` : ''}
      </div>`;
    }
    html += `</div>`;
  }

  // ── Section 4 : Documents générés ────────────────────────────────────────
  html += `<div class="dossier-section">
    <div class="dossier-section-title">4 — Documents générés</div>
    ${documents.length ? `<table class="dossier-score-table">
      <thead><tr><th>Titre</th><th>Type</th><th>Date</th><th>Statut</th></tr></thead>
      <tbody>${documents.map(d => `<tr><td>${escapeHtml(d.titre)}</td><td>${escapeHtml(DOC_TYPE_LABELS[d.type] || d.type)}</td><td>${formatDate(d.date_creation.slice(0,10))}</td><td>${escapeHtml(d.statut)}</td></tr>`).join('')}</tbody>
    </table>`
    : '<div style="color:#888;font-size:13px;">Aucun document généré.</div>'}
  </div>`;

  // ── Pied de page ──────────────────────────────────────────────────────────
  html += `<div class="dossier-footer">
    Document généré par PsyGest le ${dateGen} — Usage clinique exclusif<br>
    Secret professionnel (art. 226-13 Code pénal) · Données de santé soumises au RGPD
  </div>`;

  document.getElementById('print-container').innerHTML = html;
  window.print();
  setTimeout(() => { document.getElementById('print-container').innerHTML = ''; }, 2500);
}
window.genererPDF = genererPDF;

function buildEvolutionSvgForPrint(rows, meta) {
  if (rows.length < 1) return '';
  const W = 460, H = 120, PAD = { t: 10, r: 16, b: 28, l: 32 };
  const iW = W - PAD.l - PAD.r, iH = H - PAD.t - PAD.b;
  const scoreMax = meta.scoreMax;
  const xScale = i => rows.length === 1 ? PAD.l + iW / 2 : PAD.l + (i / (rows.length - 1)) * iW;
  const yScale = v => PAD.t + iH - (v / scoreMax) * iH;
  const points = rows.map((r, i) => ({ x: xScale(i), y: yScale(r.score_total ?? 0), score: r.score_total, date: r.date_passation.slice(5, 10) }));
  const polyline = points.map(p => `${p.x},${p.y}`).join(' ');
  const circles = points.map(p => `<circle cx="${p.x}" cy="${p.y}" r="4" fill="#2c6b4f" stroke="white" stroke-width="1.5"><title>${p.date} — ${p.score}</title></circle>`).join('');
  const xLabels = points.map(p => `<text x="${p.x}" y="${H - 4}" text-anchor="middle" font-size="9" fill="#888">${p.date}</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:${W}px;">
    <line x1="${PAD.l}" y1="${PAD.t}" x2="${PAD.l}" y2="${PAD.t+iH}" stroke="#ccc" stroke-width="1"/>
    <line x1="${PAD.l}" y1="${PAD.t+iH}" x2="${PAD.l+iW}" y2="${PAD.t+iH}" stroke="#ccc" stroke-width="1"/>
    <polyline points="${polyline}" fill="none" stroke="#2c6b4f" stroke-width="2"/>
    ${circles}${xLabels}
  </svg>`;
}

// ===== ANAMNÈSE =====
let _currentTraitements = [];

async function renderAnamneseTab() {
  const el = document.getElementById('pd-tab-anamnes');
  if (!el) return;
  const data = await getAnamnese(_db, _currentPatientId);
  if (data) _currentTraitements = data.traitements || [];
  else _currentTraitements = [];

  const v = (key) => escapeHtml((data && data[key]) ? data[key] : '');
  const sel = (key, val) => (data && data[key]) === val ? 'selected' : '';
  const modif = data ? (data.date_modification ? new Date(data.date_modification).toLocaleString('fr-FR') : '—') : '—';

  el.innerHTML = `
    <div style="padding:var(--space-5);">
      <div class="anamnes-section">
        <div class="anamnes-section-title">A — Motif de consultation</div>
        <div class="form-group"><label>Motif principal</label><textarea class="form-textarea" id="an-motif_principal" rows="3">${v('motif_principal')}</textarea></div>
        <div class="form-group"><label>Depuis quand</label><input class="form-input" id="an-motif_depuis" value="${v('motif_depuis')}"></div>
        <div class="form-group"><label>Tentatives antérieures</label><textarea class="form-textarea" id="an-tentatives_anterieures" rows="2">${v('tentatives_anterieures')}</textarea></div>
      </div>
      <div class="anamnes-section">
        <div class="anamnes-section-title">B — Histoire du problème</div>
        <div class="form-group"><label>Contexte d'apparition</label><textarea class="form-textarea" id="an-contexte_apparition" rows="2">${v('contexte_apparition')}</textarea></div>
        <div class="form-group"><label>Facteurs déclenchants</label><textarea class="form-textarea" id="an-facteurs_declenchants" rows="2">${v('facteurs_declenchants')}</textarea></div>
        <div class="form-group"><label>Évolution</label><textarea class="form-textarea" id="an-evolution" rows="2">${v('evolution')}</textarea></div>
      </div>
      <div class="anamnes-section">
        <div class="anamnes-section-title">C — Antécédents</div>
        <div class="form-group"><label>Antécédents personnels</label><textarea class="form-textarea" id="an-atcd_personnels" rows="2">${v('atcd_personnels')}</textarea></div>
        <div class="form-group"><label>Antécédents familiaux</label><textarea class="form-textarea" id="an-atcd_familiaux" rows="2">${v('atcd_familiaux')}</textarea></div>
        <div class="form-group"><label>Hospitalisations</label><textarea class="form-textarea" id="an-hospitalisations" rows="2">${v('hospitalisations')}</textarea></div>
        <div class="form-group"><label>Événements de vie significatifs (optionnel)</label><textarea class="form-textarea" id="an-traumatismes" rows="2">${v('traumatismes')}</textarea></div>
      </div>
      <div class="anamnes-section">
        <div class="anamnes-section-title">D — Situation actuelle</div>
        <div class="form-row">
          <div class="form-group"><label>Situation professionnelle</label>
            <select class="form-select" id="an-situation_pro">
              <option value="">—</option>
              <option value="CDI" ${sel('situation_pro','CDI')}>CDI</option>
              <option value="CDD" ${sel('situation_pro','CDD')}>CDD</option>
              <option value="Indépendant" ${sel('situation_pro','Indépendant')}>Indépendant</option>
              <option value="Sans emploi" ${sel('situation_pro','Sans emploi')}>Sans emploi</option>
              <option value="Retraité" ${sel('situation_pro','Retraité')}>Retraité</option>
              <option value="Étudiant" ${sel('situation_pro','Étudiant')}>Étudiant</option>
              <option value="Autre" ${sel('situation_pro','Autre')}>Autre</option>
            </select>
          </div>
          <div class="form-group"><label>Situation familiale</label>
            <select class="form-select" id="an-situation_familiale">
              <option value="">—</option>
              <option value="Célibataire" ${sel('situation_familiale','Célibataire')}>Célibataire</option>
              <option value="En couple" ${sel('situation_familiale','En couple')}>En couple</option>
              <option value="Marié·e" ${sel('situation_familiale','Marié·e')}>Marié·e</option>
              <option value="Séparé·e" ${sel('situation_familiale','Séparé·e')}>Séparé·e</option>
              <option value="Divorcé·e" ${sel('situation_familiale','Divorcé·e')}>Divorcé·e</option>
              <option value="Veuf·ve" ${sel('situation_familiale','Veuf·ve')}>Veuf·ve</option>
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>Enfants</label><input class="form-input" id="an-enfants" value="${v('enfants')}"></div>
          <div class="form-group"><label>Lieu de vie</label><input class="form-input" id="an-lieu_vie" value="${v('lieu_vie')}"></div>
        </div>
      </div>
      <div class="anamnes-section">
        <div class="anamnes-section-title">E — Traitements et suivis</div>
        <div id="an-traitements-list"></div>
        <button class="btn btn-secondary btn-sm" onclick="addTraitement()" style="margin-bottom:var(--space-3);"><i data-lucide="plus"></i> Ajouter un traitement</button>
        <div class="form-group"><label>Autres suivis</label><textarea class="form-textarea" id="an-autres_suivis" rows="2">${v('autres_suivis')}</textarea></div>
      </div>
      <div class="anamnes-section">
        <div class="anamnes-section-title">F — Hypothèses et orientation</div>
        <div class="form-group"><label>Hypothèses diagnostiques</label><textarea class="form-textarea" id="an-hypotheses_diagnostiques" rows="2">${v('hypotheses_diagnostiques')}</textarea></div>
        <div class="form-group"><label>Orientation thérapeutique</label><textarea class="form-textarea" id="an-orientation_therapeutique" rows="2">${v('orientation_therapeutique')}</textarea></div>
        <div class="form-group"><label>Objectifs de prise en charge</label><textarea class="form-textarea" id="an-objectifs_prise_en_charge" rows="2">${v('objectifs_prise_en_charge')}</textarea></div>
        <div class="form-group"><label>Indication de suivi</label>
          <select class="form-select" id="an-indication_suivi">
            <option value="">—</option>
            <option value="Court terme" ${sel('indication_suivi','Court terme')}>Court terme</option>
            <option value="Moyen terme" ${sel('indication_suivi','Moyen terme')}>Moyen terme</option>
            <option value="Long terme" ${sel('indication_suivi','Long terme')}>Long terme</option>
            <option value="À réévaluer" ${sel('indication_suivi','À réévaluer')}>À réévaluer</option>
          </select>
        </div>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:var(--space-3);">
        <div style="font-size:var(--text-xs);color:var(--color-text-muted);">Dernière modification : ${modif}</div>
        <div style="display:flex;align-items:center;gap:var(--space-3);">
          <label style="display:flex;align-items:center;gap:var(--space-2);font-size:var(--text-xs);color:var(--color-text-muted);">
            <input type="checkbox" id="anamnes-include-pdf" checked> Inclure dans l'export PDF
          </label>
          <button class="btn btn-primary" onclick="saveAnamneseForm()"><i data-lucide="save"></i> Enregistrer</button>
        </div>
      </div>
    </div>`;
  lucide.createIcons();
  renderTraitements();
}
window.renderAnamneseTab = renderAnamneseTab;

function renderTraitements() {
  const el = document.getElementById('an-traitements-list');
  if (!el) return;
  if (!_currentTraitements.length) {
    el.innerHTML = `<div style="color:var(--color-text-faint);font-size:var(--text-xs);margin-bottom:var(--space-2);">Aucun traitement renseigné.</div>`;
    return;
  }
  el.innerHTML = _currentTraitements.map((t, i) => `
    <div class="traitement-row">
      <input class="form-input" placeholder="Médicament" value="${escapeHtml(t.nom)}" oninput="_currentTraitements[${i}].nom=this.value">
      <input class="form-input" placeholder="Posologie" value="${escapeHtml(t.posologie)}" oninput="_currentTraitements[${i}].posologie=this.value">
      <input class="form-input" placeholder="Prescripteur" value="${escapeHtml(t.prescripteur)}" oninput="_currentTraitements[${i}].prescripteur=this.value">
      <button class="btn btn-ghost btn-sm" style="color:var(--color-error);" onclick="removeTraitement(${i})"><i data-lucide="trash-2"></i></button>
    </div>`).join('');
  lucide.createIcons();
}
window.renderTraitements = renderTraitements;

function addTraitement() {
  _currentTraitements.push({ nom: '', posologie: '', prescripteur: '' });
  renderTraitements();
}
window.addTraitement = addTraitement;

function removeTraitement(idx) {
  _currentTraitements.splice(idx, 1);
  renderTraitements();
}
window.removeTraitement = removeTraitement;

async function saveAnamneseForm() {
  const g = id => document.getElementById(id)?.value || '';
  const data = {
    motif_principal: g('an-motif_principal'),
    motif_depuis: g('an-motif_depuis'),
    tentatives_anterieures: g('an-tentatives_anterieures'),
    contexte_apparition: g('an-contexte_apparition'),
    facteurs_declenchants: g('an-facteurs_declenchants'),
    evolution: g('an-evolution'),
    atcd_personnels: g('an-atcd_personnels'),
    atcd_familiaux: g('an-atcd_familiaux'),
    hospitalisations: g('an-hospitalisations'),
    traumatismes: g('an-traumatismes'),
    situation_pro: g('an-situation_pro'),
    situation_familiale: g('an-situation_familiale'),
    enfants: g('an-enfants'),
    lieu_vie: g('an-lieu_vie'),
    traitements: _currentTraitements,
    autres_suivis: g('an-autres_suivis'),
    hypotheses_diagnostiques: g('an-hypotheses_diagnostiques'),
    orientation_therapeutique: g('an-orientation_therapeutique'),
    objectifs_prise_en_charge: g('an-objectifs_prise_en_charge'),
    indication_suivi: g('an-indication_suivi'),
  };
  await saveAnamnese(_db, _currentPatientId, data);
  toast('Anamnèse enregistrée ✓');
  // refresh mod date
  renderAnamneseTab();
}
window.saveAnamneseForm = saveAnamneseForm;

// ===== GLOBAL SEARCH =====
let _searchTimeout = null;

function handleGlobalSearch(query) {
  clearTimeout(_searchTimeout);
  if (query.length < 2) {
    hideSearchResults();
    return;
  }
  _searchTimeout = setTimeout(async () => {
    const data = await searchAll(_db, query);
    renderSearchResults(data, query);
    showSearchResults();
  }, 150);
}
window.handleGlobalSearch = handleGlobalSearch;

function highlight(text, query) {
  const escapedText = escapeHtml(text || '');
  if (!text || !query) return escapedText;
  const escapedQuery = escapeHtml(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return escapedText.replace(new RegExp(`(${escapedQuery})`, 'gi'), '<mark>$1</mark>');
}

function renderSearchResults(data, query) {
  const panel = document.getElementById('search-results-panel');
  if (!panel) return;
  const { patients, notes, factures, seances } = data;
  let html = '';

  if (patients.length) {
    html += `<div class="search-result-group">Patients</div>`;
    html += patients.map(p => `
      <div class="search-result-item" onclick="openPatient('${p.id}');hideSearchResults();document.getElementById('global-search').value='';">
        <div class="search-result-main">${highlight(p.prenom + ' ' + p.nom, query)}</div>
      </div>`).join('');
  }

  if (notes.length) {
    html += `<div class="search-result-group">Notes cliniques</div>`;
    html += notes.map(n => {
      const patient = state.patients.find(pp => pp.id == n.patient_id);
      const preview = (n.contenu || '').replace(/^#+\s*/gm, '').trim().slice(0, 80);
      return `<div class="search-result-item" onclick="openPatient('${n.patient_id}');switchPatientTab('notes');hideSearchResults();document.getElementById('global-search').value='';">
        <div class="search-result-main">${formatDate(n.date)} · ${patient ? escapeHtml(patient.prenom) + ' ' + escapeHtml(patient.nom) : '—'}</div>
        <div class="search-result-sub">${highlight(preview, query)}</div>
      </div>`;
    }).join('');
  }

  if (factures.length) {
    html += `<div class="search-result-group">Factures</div>`;
    html += factures.map(f => {
      const patient = state.patients.find(pp => pp.id == f.patient_id);
      return `<div class="search-result-item" onclick="openPatient('${f.patient_id}');switchPatientTab('infos');hideSearchResults();document.getElementById('global-search').value='';">
        <div class="search-result-main">${highlight(f.numero, query)}</div>
        <div class="search-result-sub">${patient ? escapeHtml(patient.prenom) + ' ' + escapeHtml(patient.nom) : '—'} · ${formatDate(f.date)} · ${formatAmount(f.montant)}</div>
      </div>`;
    }).join('');
  }

  if (seances.length) {
    html += `<div class="search-result-group">Séances</div>`;
    html += seances.map(s => {
      const patient = s.patient_id ? state.patients.find(pp => pp.id == s.patient_id) : null;
      return `<div class="search-result-item" onclick="navigate('agenda');hideSearchResults();document.getElementById('global-search').value='';">
        <div class="search-result-main">${formatDate(s.date)} ${s.heure || ''} · ${patient ? escapeHtml(patient.prenom) + ' ' + escapeHtml(patient.nom) : '—'}</div>
      </div>`;
    }).join('');
  }

  if (!html) {
    html = `<div class="search-empty">Aucun résultat pour « ${escapeHtml(query)} »</div>`;
  }

  panel.innerHTML = html;
}

function showSearchResults() {
  const panel = document.getElementById('search-results-panel');
  if (panel && panel.innerHTML) panel.style.display = '';
}
window.showSearchResults = showSearchResults;

function hideSearchResults() {
  const panel = document.getElementById('search-results-panel');
  if (panel) panel.style.display = 'none';
}
window.hideSearchResults = hideSearchResults;

function handleSearchKeydown(e) {
  if (e.key === 'Escape') hideSearchResults();
}
window.handleSearchKeydown = handleSearchKeydown;

document.addEventListener('click', e => {
  const wrap = document.getElementById('search-wrap');
  if (wrap && !wrap.contains(e.target)) hideSearchResults();
});

// ===== KEYBOARD SHORTCUTS =====
function toggleShortcutsPanel() {
  const panel = document.getElementById('shortcuts-panel');
  if (panel) panel.style.display = panel.style.display === 'none' ? '' : 'none';
}
window.toggleShortcutsPanel = toggleShortcutsPanel;

document.addEventListener('keydown', e => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key === 'k') {
    e.preventDefault();
    document.getElementById('global-search')?.focus();
    return;
  }
  if (e.key === 'Escape') {
    const openModal = document.querySelector('.modal-overlay.open');
    if (openModal) { openModal.classList.remove('open'); return; }
    hideSearchResults();
    return;
  }
  if (!_currentPatientId) return;
  const inInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  if (inInput) return;
  if (ctrl && !e.shiftKey && e.key === 'n') {
    e.preventDefault();
    populatePatientSelects();
    document.getElementById('s-date').value = today();
    document.getElementById('s-patient').value = _currentPatientId;
    document.getElementById('modalNewSeance').classList.add('open');
    return;
  }
  if (ctrl && e.shiftKey && e.key === 'N') {
    e.preventDefault();
    switchPatientTab('notes');
    return;
  }
  if (ctrl && e.key === 'f') {
    e.preventDefault();
    openNewFactureForPatient(_currentPatientId);
    return;
  }
  if (ctrl && e.key === 'p') {
    e.preventDefault();
    exportDossierPDF();
    return;
  }
});

// ===== DOCUMENTS =====

const DOC_TYPE_LABELS = {
  liaison_medecin: 'Lettre de liaison — Médecin traitant',
  liaison_psychiatre: 'Lettre de liaison — Psychiatre',
  attestation_suivi: 'Attestation de suivi psychologique',
  attestation_presence: 'Attestation de présence',
  cr_psychometrique: 'Compte-rendu de bilan psychométrique',
  cr_orientation: "Compte-rendu de bilan d'orientation professionnelle",
  mdph: 'Volet psychologique — Dossier MDPH',
};

let _docState = {
  id: null, patientId: null, type: 'liaison_medecin',
  titre: '', contenu: '', statut: 'brouillon', destinataire: '', params: {},
};
let _docManualEdit = false;
let _docPatientCache = null; // { patient, anamnese, seances }
let _docAllDocs = [];
let _docTests = []; // [{nom, score, interpretation}] for template cr_psychometrique

// — Helpers ———————————————————————————————————————————————

function extractCityFromAddress(adresse) {
  if (!adresse) return 'Nîmes';
  const m = adresse.match(/\d{5}\s+([A-ZÀ-Ÿa-zà-ÿ\s-]+)/);
  return m ? m[1].trim() : 'Nîmes';
}

function generateDocTitle(type) {
  const p = _docPatientCache?.patient;
  const suffix = p ? ` — ${p.prenom} ${p.nom}` : '';
  return (DOC_TYPE_LABELS[type] || type) + suffix;
}

async function loadDocPatientCache(patientId) {
  if (!patientId) { _docPatientCache = null; return; }
  const patient = state.patients.find(p => p.id === patientId) || null;
  const anamnese = patient ? await getAnamnese(_db, patientId) : null;
  const seances = state.seances
    .filter(s => s.patientId === patientId)
    .sort((a, b) => a.date.localeCompare(b.date));
  _docPatientCache = { patient, anamnese, seances };
}

// — List view ————————————————————————————————————————————

async function renderDocuments() {
  try { _docAllDocs = await getDocuments(_db); } catch (_) { _docAllDocs = []; }
  const patFilter = document.getElementById('doc-filter-patient');
  if (patFilter) {
    const prev = patFilter.value;
    patFilter.innerHTML = '<option value="">— Tous les patients —</option>'
      + state.patients.map(p => `<option value="${p.id}">${escapeHtml(p.prenom)} ${escapeHtml(p.nom)}</option>`).join('');
    patFilter.value = prev;
  }
  renderDocumentsList();
}
window.renderDocuments = renderDocuments;

function renderDocumentsList() {
  const tbody = document.getElementById('documents-tbody');
  if (!tbody) return;
  const typeF = document.getElementById('doc-filter-type')?.value || '';
  const patF  = document.getElementById('doc-filter-patient')?.value || '';
  const docs  = _docAllDocs.filter(d =>
    (!typeF || d.type === typeF) && (!patF || d.patient_id === patF)
  );
  if (!docs.length) {
    tbody.innerHTML = `<tr><td colspan="6"><div style="padding:var(--space-8);text-align:center;color:var(--color-text-muted);">Aucun document.</div></td></tr>`;
    return;
  }
  tbody.innerHTML = docs.map(d => `<tr>
    <td>${formatDate(d.date_creation?.slice(0,10))}</td>
    <td style="font-size:var(--text-xs);">${escapeHtml(DOC_TYPE_LABELS[d.type] || d.type)}</td>
    <td>${d.patient_nom ? escapeHtml(d.patient_nom) : '—'}</td>
    <td>${d.titre ? escapeHtml(d.titre) : '—'}</td>
    <td>${docStatusBadge(d.statut)}</td>
    <td><button class="btn btn-ghost btn-sm" onclick="openDocumentEditor('${d.id}')"><i data-lucide="edit-3"></i></button></td>
  </tr>`).join('');
  lucide.createIcons();
}
window.renderDocumentsList = renderDocumentsList;

function docStatusBadge(statut) {
  return statut === 'finalise'
    ? '<span class="doc-status-badge doc-status-finalise">Finalisé</span>'
    : '<span class="doc-status-badge doc-status-brouillon">Brouillon</span>';
}

// — Open new / existing ——————————————————————————————————

async function newDocument(patientId = null) {
  _docState = { id: null, patientId, type: 'liaison_medecin',
    titre: '', contenu: '', statut: 'brouillon', destinataire: '', params: {} };
  _docManualEdit = false;
  _docTests = [];
  await loadDocPatientCache(patientId);
  _docState.titre = generateDocTitle('liaison_medecin');
  navigate('document-editor');
  await renderDocumentEditor();
}
window.newDocument = newDocument;

async function newDocumentForPatient() { await newDocument(_currentPatientId); }
window.newDocumentForPatient = newDocumentForPatient;

async function openDocumentEditor(id) {
  try {
    const doc = await getDocument(_db, id);
    if (!doc) return;
    _docState = { id: doc.id, patientId: doc.patient_id || null, type: doc.type,
      titre: doc.titre, contenu: doc.contenu, statut: doc.statut,
      destinataire: doc.destinataire || '', params: {} };
    _docTests = [];
    _docManualEdit = !!doc.contenu;
    await loadDocPatientCache(doc.patient_id);
    navigate('document-editor');
    await renderDocumentEditor();
  } catch (e) {
    console.error('openDocumentEditor:', e);
    toast('Erreur lors de l\'ouverture du document.', 'error');
  }
}
window.openDocumentEditor = openDocumentEditor;

// — Editor render ————————————————————————————————————————

async function renderDocumentEditor() {
  const isFinalized = _docState.statut === 'finalise';
  const titleBar = document.getElementById('doc-editor-title-bar');
  if (titleBar) titleBar.textContent = _docState.titre || DOC_TYPE_LABELS[_docState.type] || 'Document';

  const btnDraft    = document.getElementById('doc-btn-draft');
  const btnFinalize = document.getElementById('doc-btn-finalize');
  const btnReopen   = document.getElementById('doc-btn-reopen');
  const btnEdit     = document.getElementById('doc-btn-edit-content');
  if (btnDraft)    btnDraft.style.display    = isFinalized ? 'none' : '';
  if (btnFinalize) btnFinalize.style.display = isFinalized ? 'none' : '';
  if (btnReopen)   btnReopen.style.display   = isFinalized ? '' : 'none';
  if (btnEdit)     btnEdit.disabled          = isFinalized;

  const statusEl = document.getElementById('doc-preview-status');
  if (statusEl) statusEl.innerHTML = docStatusBadge(_docState.statut);

  const formEl = document.getElementById('doc-editor-form');
  if (!formEl) return;

  const patient = _docPatientCache?.patient;
  const patientBlock = patient
    ? `<div class="form-group"><label>Patient</label><div style="padding:var(--space-2) 0;font-weight:600;">${escapeHtml(patient.prenom)} ${escapeHtml(patient.nom)}</div></div>`
    : `<div class="form-group"><label>Patient</label>
       <select class="form-select" id="dp-patient" ${isFinalized?'disabled':''} onchange="onDocPatientChange()">
         <option value="">— Aucun patient —</option>
         ${state.patients.map(p => `<option value="${p.id}" ${p.id === _docState.patientId ? 'selected':''}>
           ${escapeHtml(p.prenom)} ${escapeHtml(p.nom)}</option>`).join('')}
       </select></div>`;

  formEl.innerHTML = `
    <div class="form-group"><label>Type de document</label>
      <select class="form-select" id="dp-type" ${isFinalized?'disabled':''} onchange="onDocTypeChange()">
        ${Object.entries(DOC_TYPE_LABELS).map(([v,l]) =>
          `<option value="${v}" ${v === _docState.type ? 'selected':''}>${l}</option>`).join('')}
      </select>
    </div>
    ${patientBlock}
    <div class="form-group"><label>Titre du document</label>
      <input class="form-input" id="dp-titre" value="${escapeHtml(_docState.titre)}" ${isFinalized?'disabled':''}
        oninput="_docState.titre=this.value;document.getElementById('doc-editor-title-bar').textContent=this.value||'Document';">
    </div>
    <hr style="margin:var(--space-4) 0;border:none;border-top:1px solid var(--color-border);">
    <div id="doc-specific-fields">${renderDocTypeFields(_docState.type, isFinalized)}</div>
  `;

  if (_docState.type === 'cr_psychometrique') { _docTests = []; renderDocTests(); }

  lucide.createIcons();

  if (_docManualEdit && _docState.contenu) {
    document.getElementById('doc-preview-area').innerHTML = renderDocumentHTML(_docState.contenu);
  } else {
    _docManualEdit = false;
    await updateDocumentPreview();
  }

  // ensure content editor hidden
  const wrap = document.getElementById('doc-content-editor-wrap');
  const area = document.getElementById('doc-preview-area');
  if (wrap) wrap.style.display = 'none';
  if (area) area.style.display = '';
  const btnEC = document.getElementById('doc-btn-edit-content');
  if (btnEC) btnEC.innerHTML = '<i data-lucide="edit-3"></i> Modifier le contenu';
  lucide.createIcons();
}

function renderDocTypeFields(type, disabled = false) {
  const d = disabled ? 'disabled' : '';
  const onc = `oninput="onDocFieldChange()"`;
  const oncs = `onchange="onDocFieldChange()"`;

  const field = (label, id, placeholder = '', inputType = 'text') => `
    <div class="form-group"><label>${label}</label>
      <input class="form-input" type="${inputType}" id="${id}" placeholder="${placeholder}" ${d} ${onc}>
    </div>`;

  const ta = (label, id, rows = 4, placeholder = '') => `
    <div class="form-group"><label>${label}</label>
      <textarea class="form-textarea" id="${id}" rows="${rows}" placeholder="${placeholder}" ${d} ${onc}></textarea>
    </div>`;

  const sel = (label, id, options) => `
    <div class="form-group"><label>${label}</label>
      <select class="form-select" id="${id}" ${d} ${oncs}>
        ${options.map(([v,l]) => `<option value="${v}">${l}</option>`).join('')}
      </select>
    </div>`;

  const regen = `<button type="button" class="btn btn-ghost btn-sm" onclick="regenDocPreview()"
    style="width:100%;margin-bottom:var(--space-3);" ${d}>
    <i data-lucide="refresh-cw"></i> Re-générer depuis le formulaire
  </button>`;

  const seances = _docPatientCache?.seances || [];

  switch (type) {
    case 'liaison_medecin':
      return regen
        + field('Médecin destinataire', 'dp-destinataire', 'Dr Nom Prénom')
        + field('Adresse du cabinet (optionnel)', 'dp-adresse-dest', 'Adresse…')
        + sel('Motif de la liaison', 'dp-motif-liaison', [
            ['debut','Début de suivi'], ['etape',"Point d'étape"], ['fin','Fin de suivi'],
            ['preoccupant','Situation préoccupante'], ['autre','Autre']])
        + ta('Contenu libre', 'dp-contenu-libre', 6, 'Observations cliniques, éléments pertinents…');

    case 'liaison_psychiatre':
      return regen
        + field('Psychiatre destinataire', 'dp-destinataire', 'Dr Nom Prénom')
        + field('Adresse du cabinet (optionnel)', 'dp-adresse-dest', 'Adresse…')
        + sel('Motif de la liaison', 'dp-motif-liaison', [
            ['debut','Début de suivi'], ['etape',"Point d'étape"], ['fin','Fin de suivi'],
            ['preoccupant','Situation préoccupante'], ['autre','Autre']])
        + sel('Nature de la demande', 'dp-nature-demande', [
            ['evaluation','Évaluation psychiatrique'], ['traitement','Traitement médicamenteux'],
            ['hospitalisation','Hospitalisation'], ['coordination','Coordination'], ['autre','Autre']])
        + ta('Contenu libre', 'dp-contenu-libre', 6, 'Contexte clinique, éléments pertinents…');

    case 'attestation_suivi':
      return regen
        + field('Destinataire', 'dp-destinataire', 'À qui de droit')
        + sel('Fréquence approximative', 'dp-frequence', [
            ['hebdomadaire','Hebdomadaire'], ['bimensuelle','Bimensuelle'],
            ['mensuelle','Mensuelle'], ['irreguliere','Irrégulière']])
        + field("Motif de l'attestation (optionnel)", 'dp-motif-attestation', 'ex. Demande employeur, MDPH…');

    case 'attestation_presence': {
      const opts = seances.length
        ? seances.slice().sort((a,b)=>b.date.localeCompare(a.date))
            .map(s=>`<option value="${s.id}">${formatDate(s.date)}${s.heure?' '+s.heure:''}</option>`).join('')
        : '<option value="">Aucune séance enregistrée</option>';
      return regen
        + `<div class="form-group"><label>Séance</label>
             <select class="form-select" id="dp-seance-id" ${d} ${oncs}>${opts}</select>
           </div>`
        + field('Destinataire', 'dp-destinataire', 'À qui de droit');
    }

    case 'cr_psychometrique':
      return regen
        + field('Motif du bilan', 'dp-motif-bilan', 'Difficultés scolaires, orientation…')
        + field('Date(s) de passation', 'dp-dates-passation', 'ex. 15/01/2025')
        + `<div class="form-group"><label>Tests utilisés</label>
             <div id="doc-tests-list"></div>
             <button type="button" class="btn btn-ghost btn-sm" onclick="addDocTest()" style="margin-top:var(--space-2);" ${d}>
               <i data-lucide="plus"></i> Ajouter un test
             </button>
           </div>`
        + ta('Synthèse clinique', 'dp-synthese', 5)
        + ta('Conclusions et recommandations', 'dp-conclusions', 5)
        + field('Destinataire', 'dp-destinataire', '');

    case 'cr_orientation':
      return regen
        + ta('Contexte de la demande', 'dp-contexte', 3)
        + ta('Démarche utilisée', 'dp-demarche', 3)
        + ta('Compétences identifiées', 'dp-competences', 3)
        + ta('Intérêts et valeurs professionnels', 'dp-interets', 3)
        + ta("Pistes d'orientation", 'dp-pistes', 3)
        + ta('Recommandations', 'dp-recommandations', 3)
        + field('Destinataire', 'dp-destinataire', '');

    case 'mdph':
      return regen
        + field("Date d'évaluation", 'dp-date-eval', '', 'date')
        + sel('Type de handicap concerné', 'dp-type-handicap', [
            ['psychique','Psychique'], ['cognitif','Cognitif'],
            ['mental','Mental'], ['mixte','Mixte']])
        + ta('Limitations fonctionnelles', 'dp-limitations', 4)
        + ta('Retentissement sur la vie quotidienne', 'dp-quotidien', 3)
        + ta('Retentissement sur la vie professionnelle', 'dp-professionnel', 3)
        + ta('Aides et compensations en place', 'dp-aides', 3)
        + ta('Préconisations', 'dp-preconisations', 3);

    default: return '';
  }
}

// Tests répétables (template cr_psychometrique)
function addDocTest() {
  _docTests.push({ nom: '', score: '', interpretation: '' });
  renderDocTests();
}
window.addDocTest = addDocTest;

function removeDocTest(i) {
  _docTests.splice(i, 1);
  renderDocTests();
  onDocFieldChange();
}
window.removeDocTest = removeDocTest;

function renderDocTests() {
  const c = document.getElementById('doc-tests-list');
  if (!c) return;
  c.innerHTML = _docTests.map((t, i) => `
    <div style="display:grid;grid-template-columns:1fr 80px 1fr auto;gap:var(--space-2);margin-bottom:var(--space-2);align-items:start;">
      <input class="form-input" placeholder="Nom du test" value="${escapeHtml(t.nom)}"
        oninput="_docTests[${i}].nom=this.value;onDocFieldChange()">
      <input class="form-input" placeholder="Score" value="${escapeHtml(t.score)}"
        oninput="_docTests[${i}].score=this.value;onDocFieldChange()">
      <input class="form-input" placeholder="Interprétation" value="${escapeHtml(t.interpretation)}"
        oninput="_docTests[${i}].interpretation=this.value;onDocFieldChange()">
      <button class="btn btn-ghost btn-sm" style="color:var(--color-error);" onclick="removeDocTest(${i})">
        <i data-lucide="x"></i>
      </button>
    </div>`).join('');
  lucide.createIcons();
}

// — Form change handlers ————————————————————————————————

function onDocTypeChange() {
  const newType = document.getElementById('dp-type')?.value;
  if (!newType) return;
  _docState.type = newType;
  const titleEl = document.getElementById('dp-titre');
  if (titleEl && (!titleEl.value || Object.values(DOC_TYPE_LABELS).some(l => titleEl.value.startsWith(l.split(' — ')[0])))) {
    titleEl.value = generateDocTitle(newType);
    _docState.titre = titleEl.value;
    const tb = document.getElementById('doc-editor-title-bar');
    if (tb) tb.textContent = _docState.titre;
  }
  const sf = document.getElementById('doc-specific-fields');
  if (sf) sf.innerHTML = renderDocTypeFields(newType, false);
  _docTests = [];
  if (newType === 'cr_psychometrique') renderDocTests();
  lucide.createIcons();
  _docManualEdit = false;
  updateDocumentPreview();
}
window.onDocTypeChange = onDocTypeChange;

function onDocFieldChange() {
  if (!_docManualEdit) updateDocumentPreview();
}
window.onDocFieldChange = onDocFieldChange;

async function onDocPatientChange() {
  const patientId = document.getElementById('dp-patient')?.value || null;
  _docState.patientId = patientId;
  await loadDocPatientCache(patientId);
  const titleEl = document.getElementById('dp-titre');
  if (titleEl) {
    _docState.titre = generateDocTitle(_docState.type);
    titleEl.value = _docState.titre;
    const tb = document.getElementById('doc-editor-title-bar');
    if (tb) tb.textContent = _docState.titre;
  }
  if (_docState.type === 'attestation_presence') {
    const seances = _docPatientCache?.seances || [];
    const el = document.getElementById('dp-seance-id');
    if (el) el.innerHTML = seances.length
      ? seances.slice().sort((a,b)=>b.date.localeCompare(a.date))
          .map(s=>`<option value="${s.id}">${formatDate(s.date)}${s.heure?' '+s.heure:''}</option>`).join('')
      : '<option value="">Aucune séance enregistrée</option>';
  }
  _docManualEdit = false;
  await updateDocumentPreview();
}
window.onDocPatientChange = onDocPatientChange;

async function regenDocPreview() {
  _docManualEdit = false;
  await updateDocumentPreview();
}
window.regenDocPreview = regenDocPreview;

// — Preview ——————————————————————————————————————————————

function g(id) { const el = document.getElementById(id); return el ? el.value : ''; }

async function updateDocumentPreview() {
  if (_docManualEdit) return;
  const params = {
    destinataire: g('dp-destinataire'),
    adresse_dest: g('dp-adresse-dest'),
    motif_liaison: g('dp-motif-liaison') || 'debut',
    nature_demande: g('dp-nature-demande') || 'evaluation',
    contenu_libre: g('dp-contenu-libre'),
    frequence: g('dp-frequence') || 'hebdomadaire',
    motif_attestation: g('dp-motif-attestation'),
    seance_id: g('dp-seance-id'),
    motif_bilan: g('dp-motif-bilan'),
    dates_passation: g('dp-dates-passation'),
    tests: _docTests,
    synthese: g('dp-synthese'),
    conclusions: g('dp-conclusions'),
    contexte: g('dp-contexte'),
    demarche: g('dp-demarche'),
    competences: g('dp-competences'),
    interets: g('dp-interets'),
    pistes: g('dp-pistes'),
    recommandations: g('dp-recommandations'),
    date_eval: g('dp-date-eval'),
    type_handicap: g('dp-type-handicap') || 'psychique',
    limitations: g('dp-limitations'),
    quotidien: g('dp-quotidien'),
    professionnel: g('dp-professionnel'),
    aides: g('dp-aides'),
    preconisations: g('dp-preconisations'),
  };
  _docState.destinataire = params.destinataire;

  let body = '';
  const cache = _docPatientCache;
  switch (_docState.type) {
    case 'liaison_medecin':     body = tplLiaisonMedecin(params, cache);    break;
    case 'liaison_psychiatre':  body = tplLiaisonPsychiatre(params, cache); break;
    case 'attestation_suivi':   body = tplAttestationSuivi(params, cache);  break;
    case 'attestation_presence':body = tplAttestationPresence(params, cache);break;
    case 'cr_psychometrique':   body = tplCRPsychometrique(params, cache);  break;
    case 'cr_orientation':      body = tplCROrientation(params, cache);     break;
    case 'mdph':                body = tplMDPH(params, cache);              break;
  }
  _docState.contenu = body;
  const area = document.getElementById('doc-preview-area');
  if (area) area.innerHTML = renderDocumentHTML(body);
}

function renderDocumentHTML(bodyHTML) {
  const s = state.settings;
  const praticien = escapeHtml(`${s.prenom || ''} ${s.nom || ''}`.trim() || 'Praticien');
  const city = escapeHtml(extractCityFromAddress(s.adresse));
  const dateFormatted = formatDate(today());
  return `<div class="doc-document">
    <div class="doc-doc-header">
      <div class="doc-praticien-info">
        <strong>${praticien}</strong><br>
        Psychologue<br>
        ${s.rpps ? `N° RPPS&nbsp;: ${escapeHtml(s.rpps)}<br>` : ''}
        ${s.siret ? `SIRET&nbsp;: ${escapeHtml(s.siret)}<br>` : ''}
        ${s.adresse ? `${escapeHtml(s.adresse)}<br>` : ''}
        ${s.tel ? `Tél.&nbsp;: ${escapeHtml(s.tel)}<br>` : ''}
        ${escapeHtml(s.email || '')}
      </div>
      <div class="doc-date-lieu">${city}, le ${dateFormatted}</div>
    </div>
    <div class="doc-doc-body">${bodyHTML}</div>
    <div class="doc-doc-signature">
      <p>${praticien}<br><em>Psychologue</em></p>
    </div>
    <div class="doc-doc-footer">
      Document confidentiel — Secret professionnel (art.&nbsp;226-13 du Code pénal) —
      ${praticien}, Psychologue${s.rpps ? ', N° RPPS&nbsp;: ' + escapeHtml(s.rpps) : ''}
    </div>
  </div>`;
}

// — 7 templates ——————————————————————————————————————————

function tplPatientHeader(patient) {
  if (!patient) return '[Patient non renseigné]';
  return `<strong>${escapeHtml(patient.prenom)} ${escapeHtml(patient.nom.toUpperCase())}</strong>`;
}

function tplPrenomNom(patient) {
  if (!patient) return '[Patient]';
  return `${escapeHtml(patient.prenom)} ${escapeHtml(patient.nom.toUpperCase())}`;
}

function nl2br(str) { return escapeHtml(str || '').replace(/\n/g, '<br>'); }

function tplLiaisonMedecin(params, cache) {
  const p = cache?.patient;
  const a = cache?.anamnese;
  const seances = cache?.seances || [];
  const pn = tplPrenomNom(p);
  const naissance = p?.naissance ? formatDate(p.naissance) : '—';
  const premiereSeance = seances[0] ? formatDate(seances[0].date) : '—';
  const motif = escapeHtml(a?.motif_principal || p?.motif || '…');
  const destBlock = params.destinataire
    ? `<p><strong>Dr ${escapeHtml(params.destinataire)}</strong>${params.adresse_dest ? '<br>'+nl2br(params.adresse_dest) : ''}</p>` : '';
  return `${destBlock}
    <p><strong>Objet&nbsp;: Prise en charge psychologique de ${pn}</strong></p>
    <p>Confrère/Consœur,</p>
    <p>Je me permets de vous adresser ce courrier concernant ${tplPatientHeader(p)},
    né(e) le ${naissance}, que j'accompagne en consultation de psychologie depuis le ${premiereSeance}.</p>
    <p>${pn} consulte pour ${motif}.</p>
    ${params.contenu_libre ? `<p>${nl2br(params.contenu_libre)}</p>` : ''}
    <p>Je reste disponible pour tout échange complémentaire.</p>
    <p>Confraternellement,</p>`;
}

function tplLiaisonPsychiatre(params, cache) {
  const p = cache?.patient;
  const a = cache?.anamnese;
  const seances = cache?.seances || [];
  const pn = tplPrenomNom(p);
  const naissance = p?.naissance ? formatDate(p.naissance) : '—';
  const premiereSeance = seances[0] ? formatDate(seances[0].date) : '—';
  const motif = escapeHtml(a?.motif_principal || p?.motif || '…');
  const destBlock = params.destinataire
    ? `<p><strong>Dr ${escapeHtml(params.destinataire)}</strong>${params.adresse_dest ? '<br>'+nl2br(params.adresse_dest) : ''}</p>` : '';
  const natureLabels = {
    evaluation:'Évaluation psychiatrique', traitement:'Traitement médicamenteux',
    hospitalisation:'Hospitalisation', coordination:'Coordination', autre:'Autre',
  };
  const objet = natureLabels[params.nature_demande] || 'Coordination psychiatrique';
  let traitements = '';
  if (a?.traitements?.length) {
    const liste = a.traitements.map(t => t.medicament || String(t)).filter(Boolean).join(', ');
    if (liste) traitements = `<p>Traitements en cours&nbsp;: ${escapeHtml(liste)}.</p>`;
  }
  return `${destBlock}
    <p><strong>Objet&nbsp;: ${objet} — ${pn}</strong></p>
    <p>Confrère/Consœur,</p>
    <p>Je me permets de vous contacter concernant ${tplPatientHeader(p)}, né(e) le ${naissance},
    que j'accompagne en suivi psychologique depuis le ${premiereSeance}.</p>
    <p>${pn} consulte pour ${motif}.</p>
    ${traitements}
    ${params.contenu_libre ? `<p>${nl2br(params.contenu_libre)}</p>` : ''}
    <p>Je reste disponible pour tout échange et vous adresse mes confraternelles salutations.</p>
    <p>Confraternellement,</p>`;
}

function tplAttestationSuivi(params, cache) {
  const p = cache?.patient;
  const seances = cache?.seances || [];
  const pn = tplPrenomNom(p);
  const naissance = p?.naissance ? formatDate(p.naissance) : '—';
  const premiereSeance = seances[0] ? formatDate(seances[0].date) : '—';
  const nb = seances.length;
  const freqLabels = {
    hebdomadaire:'hebdomadaire', bimensuelle:'bimensuelle',
    mensuelle:'mensuelle', irreguliere:'irrégulière',
  };
  const freq = freqLabels[params.frequence] || 'variable';
  const s = state.settings;
  const praticien = escapeHtml(`${s.prenom || ''} ${s.nom || ''}`.trim() || 'Praticien');
  return `<h2 style="text-align:center;font-size:13pt;text-transform:uppercase;margin-bottom:2rem;letter-spacing:.05em;">
      Attestation de suivi psychologique</h2>
    <p>Je soussigné(e), ${praticien}, Psychologue${s.rpps?', N° RPPS&nbsp;: '+escapeHtml(s.rpps):''}, exerçant en libéral,</p>
    <p>atteste que ${tplPatientHeader(p)}, né(e) le ${naissance},
    bénéficie d'un suivi psychologique depuis le ${premiereSeance}.</p>
    <p>À ce jour, <strong>${nb} séance${nb>1?'s ont':'a'} été réalisée${nb>1?'s':''}</strong>,
    à une fréquence ${freq}.</p>
    ${params.motif_attestation ? `<p>Motif&nbsp;: ${escapeHtml(params.motif_attestation)}.</p>` : ''}
    <p>Cette attestation est établie à la demande de l'intéressé(e) et pour faire valoir
    ${escapeHtml(params.destinataire) || 'à qui de droit'}.</p>`;
}

function tplAttestationPresence(params, cache) {
  const p = cache?.patient;
  const seances = cache?.seances || [];
  const seance = seances.find(s => s.id === params.seance_id) || seances[seances.length-1] || null;
  const dateSeance = seance ? formatDate(seance.date) : '—';
  const heureDebut = seance?.heure || null;
  let heureFin = null;
  if (heureDebut && seance?.duree) {
    const [h, m] = heureDebut.split(':').map(Number);
    const tot = h * 60 + m + (seance.duree || 50);
    heureFin = `${String(Math.floor(tot/60)).padStart(2,'0')}:${String(tot%60).padStart(2,'0')}`;
  }
  const heureStr = heureDebut ? ` de <strong>${heureDebut}</strong> à <strong>${heureFin||'—'}</strong>` : '';
  const s = state.settings;
  const praticien = escapeHtml(`${s.prenom || ''} ${s.nom || ''}`.trim() || 'Praticien');
  return `<h2 style="text-align:center;font-size:13pt;text-transform:uppercase;margin-bottom:2rem;letter-spacing:.05em;">
      Attestation de présence</h2>
    <p>Je soussigné(e), ${praticien}, Psychologue${s.rpps?', N° RPPS&nbsp;: '+escapeHtml(s.rpps):''},</p>
    <p>atteste que ${tplPatientHeader(p)} s'est présenté(e) en consultation de psychologie
    le <strong>${dateSeance}</strong>${heureStr}.</p>
    <p>Cette attestation est établie à la demande de l'intéressé(e) et pour faire valoir
    ${escapeHtml(params.destinataire) || 'à qui de droit'}.</p>`;
}

function tplCRPsychometrique(params, cache) {
  const p = cache?.patient;
  const pn = tplPrenomNom(p);
  const naissance = p?.naissance ? formatDate(p.naissance) : '—';
  let age = '—';
  if (p?.naissance) {
    const birth = new Date(p.naissance + 'T12:00:00');
    const now = new Date();
    let a = now.getFullYear() - birth.getFullYear();
    if (now.getMonth() - birth.getMonth() < 0 || (now.getMonth() === birth.getMonth() && now.getDate() < birth.getDate())) a--;
    age = a + ' ans';
  }
  const testsRows = (params.tests||[]).map(t =>
    `<tr><td style="border:1px solid #ccc;padding:6px 10px;">${escapeHtml(t.nom||'—')}</td>
     <td style="border:1px solid #ccc;padding:6px 10px;text-align:center;">${escapeHtml(t.score||'—')}</td>
     <td style="border:1px solid #ccc;padding:6px 10px;">${escapeHtml(t.interpretation||'—')}</td></tr>`
  ).join('');
  const testsTable = testsRows
    ? `<table style="width:100%;border-collapse:collapse;margin:1rem 0;font-size:10pt;">
         <thead><tr>
           <th style="border:1px solid #ccc;padding:6px 10px;text-align:left;background:#f5f5f5;">Test</th>
           <th style="border:1px solid #ccc;padding:6px 10px;text-align:center;background:#f5f5f5;">Score</th>
           <th style="border:1px solid #ccc;padding:6px 10px;text-align:left;background:#f5f5f5;">Interprétation</th>
         </tr></thead><tbody>${testsRows}</tbody></table>`
    : '<p><em>Aucun test renseigné.</em></p>';
  const h3 = (n, t) => `<h3 style="font-size:11pt;text-decoration:underline;margin:1.5rem 0 .5rem;">${n}. ${t}</h3>`;
  return `<h2 style="text-align:center;font-size:13pt;text-transform:uppercase;margin-bottom:2rem;letter-spacing:.05em;">
      Compte-rendu de bilan psychométrique</h2>
    ${h3(1,'Identification')}
    <p><strong>Patient&nbsp;:</strong> ${pn}<br>
    <strong>Date de naissance&nbsp;:</strong> ${naissance} (${age})<br>
    ${params.dates_passation ? `<strong>Date(s) de passation&nbsp;:</strong> ${params.dates_passation}<br>` : ''}
    ${params.destinataire ? `<strong>Destinataire&nbsp;:</strong> ${escapeHtml(params.destinataire)}` : ''}</p>
    ${h3(2,'Motif et contexte de la demande')}
    <p>${nl2br(params.motif_bilan) || '—'}</p>
    ${h3(3,'Résultats des évaluations')}
    ${testsTable}
    ${h3(4,'Synthèse clinique')}
    <p>${nl2br(params.synthese) || '—'}</p>
    ${h3(5,'Conclusions et recommandations')}
    <p>${nl2br(params.conclusions) || '—'}</p>`;
}

function tplCROrientation(params, cache) {
  const p = cache?.patient;
  const pn = tplPrenomNom(p);
  const naissance = p?.naissance ? formatDate(p.naissance) : '—';
  const sec = (n, t, c) => c
    ? `<h3 style="font-size:11pt;text-decoration:underline;margin:1.5rem 0 .5rem;">${n}. ${t}</h3><p>${nl2br(c)}</p>`
    : '';
  return `<h2 style="text-align:center;font-size:13pt;text-transform:uppercase;margin-bottom:2rem;letter-spacing:.05em;">
      Compte-rendu de bilan d'orientation professionnelle</h2>
    <p><strong>Patient&nbsp;:</strong> ${pn}<br>
    <strong>Date de naissance&nbsp;:</strong> ${naissance}<br>
    ${params.destinataire ? `<strong>Destinataire&nbsp;:</strong> ${escapeHtml(params.destinataire)}` : ''}</p>
    ${sec(1,'Contexte et objectifs du bilan', params.contexte)}
    ${sec(2,'Démarche méthodologique', params.demarche)}
    ${sec(3,'Compétences et ressources identifiées', params.competences)}
    ${sec(4,'Intérêts et valeurs professionnels', params.interets)}
    ${sec(5,"Pistes d'orientation envisagées", params.pistes)}
    ${sec(6,'Recommandations et prochaines étapes', params.recommandations)}`;
}

function tplMDPH(params, cache) {
  const p = cache?.patient;
  const pn = tplPrenomNom(p);
  const naissance = p?.naissance ? formatDate(p.naissance) : '—';
  const typeLabels = { psychique:'Psychique', cognitif:'Cognitif', mental:'Mental', mixte:'Mixte' };
  const typeH = typeLabels[params.type_handicap] || '';
  const sec = (t, c) => c
    ? `<h3 style="font-size:11pt;text-decoration:underline;margin:1.5rem 0 .5rem;">${t}</h3><p>${nl2br(c)}</p>`
    : '';
  return `<h2 style="text-align:center;font-size:13pt;text-transform:uppercase;margin-bottom:2rem;letter-spacing:.05em;">
      Volet psychologique — Dossier MDPH</h2>
    <p><strong>Patient&nbsp;:</strong> ${pn}<br>
    <strong>Date de naissance&nbsp;:</strong> ${naissance}<br>
    ${params.date_eval ? `<strong>Date d'évaluation&nbsp;:</strong> ${formatDate(params.date_eval)}<br>` : ''}
    ${typeH ? `<strong>Type de handicap&nbsp;:</strong> ${typeH}` : ''}</p>
    ${sec('Limitations fonctionnelles', params.limitations)}
    ${sec('Retentissement sur la vie quotidienne', params.quotidien)}
    ${sec('Retentissement sur la vie professionnelle', params.professionnel)}
    ${sec('Aides et compensations en place', params.aides)}
    ${sec('Préconisations', params.preconisations)}
    <div style="margin-top:2rem;padding:1rem;border:1px solid #bbb;background:#f9f9f9;font-size:9pt;font-style:italic;">
      Ce document est établi dans le cadre d'une demande MDPH. Il est couvert par le secret professionnel
      et ne peut être transmis qu'à la MDPH concernée ou au médecin coordonnateur.
    </div>`;
}

// — Content edit ——————————————————————————————————————————

function toggleDocContentEdit() {
  if (_docState.statut === 'finalise') return;
  const wrap = document.getElementById('doc-content-editor-wrap');
  const area = document.getElementById('doc-preview-area');
  const btn  = document.getElementById('doc-btn-edit-content');
  if (wrap.style.display === 'none') {
    document.getElementById('doc-content-textarea').value = _docState.contenu || '';
    wrap.style.display = '';
    area.style.display = 'none';
    if (btn) btn.innerHTML = '<i data-lucide="eye"></i> Voir la prévisualisation';
  } else {
    cancelDocContentEdit();
  }
  lucide.createIcons();
}
window.toggleDocContentEdit = toggleDocContentEdit;

function applyDocContentEdit() {
  _docState.contenu = document.getElementById('doc-content-textarea').value;
  _docManualEdit = true;
  document.getElementById('doc-preview-area').innerHTML = renderDocumentHTML(_docState.contenu);
  document.getElementById('doc-content-editor-wrap').style.display = 'none';
  document.getElementById('doc-preview-area').style.display = '';
  const btn = document.getElementById('doc-btn-edit-content');
  if (btn) btn.innerHTML = '<i data-lucide="edit-3"></i> Modifier le contenu';
  lucide.createIcons();
}
window.applyDocContentEdit = applyDocContentEdit;

function cancelDocContentEdit() {
  document.getElementById('doc-content-editor-wrap').style.display = 'none';
  document.getElementById('doc-preview-area').style.display = '';
  const btn = document.getElementById('doc-btn-edit-content');
  if (btn) btn.innerHTML = '<i data-lucide="edit-3"></i> Modifier le contenu';
  lucide.createIcons();
}
window.cancelDocContentEdit = cancelDocContentEdit;

// — Save / Finalize / Delete / Print ———————————————————

async function saveDocumentDraft() {
  if (_docState.statut === 'finalise') return;
  const titleEl = document.getElementById('dp-titre');
  if (titleEl) _docState.titre = titleEl.value || DOC_TYPE_LABELS[_docState.type];
  const data = { patient_id: _docState.patientId, type: _docState.type,
    titre: _docState.titre || DOC_TYPE_LABELS[_docState.type],
    contenu: _docState.contenu, statut: 'brouillon', destinataire: _docState.destinataire };
  try {
    if (_docState.id) { await updateDocument(_db, _docState.id, data); }
    else { _docState.id = await createDocument(_db, data); }
    _docState.statut = 'brouillon';
    toast('Brouillon enregistré ✓');
  } catch (e) {
    console.error('saveDocumentDraft:', e);
    toast('Erreur lors de la sauvegarde.', 'error');
  }
}
window.saveDocumentDraft = saveDocumentDraft;

async function finalizeDocument() {
  if (!_docManualEdit) await updateDocumentPreview();
  const titleEl = document.getElementById('dp-titre');
  if (titleEl) _docState.titre = titleEl.value || DOC_TYPE_LABELS[_docState.type];
  const data = { patient_id: _docState.patientId, type: _docState.type,
    titre: _docState.titre || DOC_TYPE_LABELS[_docState.type],
    contenu: _docState.contenu, statut: 'finalise', destinataire: _docState.destinataire };
  try {
    if (_docState.id) { await updateDocument(_db, _docState.id, data); }
    else { _docState.id = await createDocument(_db, data); }
    _docState.statut = 'finalise';
    toast('Document finalisé ✓');
    await renderDocumentEditor();
  } catch (e) {
    console.error('finalizeDocument:', e);
    toast('Erreur lors de la finalisation.', 'error');
  }
}
window.finalizeDocument = finalizeDocument;

async function reopenDocument() {
  if (!_docState.id) return;
  try {
    await updateDocument(_db, _docState.id, {
      patient_id: _docState.patientId, type: _docState.type,
      titre: _docState.titre, contenu: _docState.contenu,
      statut: 'brouillon', destinataire: _docState.destinataire,
    });
    _docState.statut = 'brouillon';
    toast('Document rouvert en brouillon.');
    await renderDocumentEditor();
  } catch (e) { toast('Erreur.', 'error'); }
}
window.reopenDocument = reopenDocument;

async function deleteCurrentDocument() {
  if (!_docState.id) { navigate('documents'); return; }
  const ok = await ask('Supprimer ce document définitivement ?', { title: 'Confirmation', kind: 'warning' });
  if (!ok) return;
  try {
    await dbDeleteDocument(_db, _docState.id);
    toast('Document supprimé.');
    navigate('documents');
  } catch (e) { toast('Erreur lors de la suppression.', 'error'); }
}
window.deleteCurrentDocument = deleteCurrentDocument;

function printDocument() {
  const area = document.getElementById('doc-preview-area');
  if (!area) return;
  document.getElementById('print-container').innerHTML =
    `<div class="doc-print-page">${area.innerHTML}</div>`;
  window.print();
  setTimeout(() => { document.getElementById('print-container').innerHTML = ''; }, 2000);
}
window.printDocument = printDocument;

// — Patient tab ———————————————————————————————————————————

async function renderPatientDocuments(patientId) {
  const container = document.getElementById('pd-documents-list');
  if (!container) return;
  try {
    const docs = await getDocumentsByPatient(_db, patientId);
    if (!docs.length) {
      container.innerHTML = `<div class="empty-state" style="padding:var(--space-8);">
        <i data-lucide="scroll" style="width:32px;height:32px;"></i>
        <p>Aucun document pour ce patient.</p>
        <button class="btn btn-primary btn-sm" onclick="newDocumentForPatient()">
          <i data-lucide="plus"></i> Créer un document
        </button>
      </div>`;
      lucide.createIcons();
      return;
    }
    container.innerHTML = `<div class="table-container"><table>
      <thead><tr><th>Date</th><th>Type</th><th>Titre</th><th>Statut</th><th></th></tr></thead>
      <tbody>${docs.map(d => `<tr>
        <td>${formatDate(d.date_creation?.slice(0,10))}</td>
        <td style="font-size:var(--text-xs);">${escapeHtml(DOC_TYPE_LABELS[d.type] || d.type)}</td>
        <td>${d.titre ? escapeHtml(d.titre) : '—'}</td>
        <td>${docStatusBadge(d.statut)}</td>
        <td><button class="btn btn-ghost btn-sm" onclick="openDocumentEditor('${d.id}')">
          <i data-lucide="edit-3"></i></button></td>
      </tr>`).join('')}
      </tbody></table></div>`;
    lucide.createIcons();
  } catch (e) {
    container.innerHTML = `<div style="color:var(--color-text-muted);padding:var(--space-4);">Erreur lors du chargement.</div>`;
  }
}

// ===== Pi — Questionnaires à distance =====

// ── Méta questionnaires ────────────────────────────────────────────────────────
const QUESTIONNAIRE_META = {
  phq9:   { label: 'PHQ-9',    titre: 'Dépression',              scoreMax: 27,  seuilAlerte: 5  },
  gad7:   { label: 'GAD-7',    titre: 'Anxiété généralisée',     scoreMax: 21,  seuilAlerte: 5  },
  isi:    { label: 'ISI',      titre: 'Insomnie',                scoreMax: 28,  seuilAlerte: 4  },
  pcl5:   { label: 'PCL-5',    titre: 'Stress post-traumatique', scoreMax: 80,  seuilAlerte: 10 },
  aaq2:   { label: 'AAQ-II',   titre: 'Flexibilité psychologique',scoreMax: 49, seuilAlerte: 5  },
  cfq:    { label: 'CFQ',      titre: 'Fusion cognitive',        scoreMax: 49,  seuilAlerte: 5  },
  qips:   { label: 'QIPS',     titre: 'Pleine conscience',       scoreMax: 39,  seuilAlerte: 8  },
  iesr:   { label: 'IES-R',    titre: 'Impact événement',        scoreMax: 88,  seuilAlerte: 8  },
  audit:  { label: 'AUDIT',    titre: 'Alcool',                  scoreMax: 40,  seuilAlerte: 4  },
  dast10: { label: 'DAST-10',  titre: 'Drogues',                 scoreMax: 10,  seuilAlerte: 2  },
  had:    { label: 'HAD',      titre: 'Anxiété & Dépression',    scoreMax: 42,  seuilAlerte: 3, sousScoress: ['anxiete','depression'] },
  lsas:   { label: 'LSAS',     titre: 'Phobie sociale',          scoreMax: 144, seuilAlerte: 10 },
  bdi2:   { label: 'BDI-II',   titre: 'Dépression (Beck)',       scoreMax: 63,  seuilAlerte: 5  },
  rathus: { label: 'Rathus',   titre: 'Assertivité',             scoreMax: 90,  seuilAlerte: -10, inverseAlerte: true },
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function normalizeUrl(raw) {
  const s = (raw || '').trim().replace(/\/$/, '');
  if (!s) return '';
  if (/^http:\/\//i.test(s)) return s.replace(/^http:\/\//i, 'https://');
  return /^https:\/\//i.test(s) ? s : `https://${s}`;
}

function piRequest(path, options = {}) {
  const url = normalizeUrl(state.settings.pwaUrl);
  const key = (state.settings.pwaApiKey || '').trim();
  if (!url || !key) throw new Error('URL et clé API non configurées dans les Réglages (section Connexion Pi).');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  return fetch(`${url}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, ...(options.headers || {}) },
    signal: controller.signal,
  }).then(async res => {
    clearTimeout(timer);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (_) {
      throw new Error(`Le Pi a renvoyé une réponse non-JSON (HTTP ${res.status}). Vérifiez l'URL et la clé API.`);
    }
    if (!res.ok) throw new Error(data.erreur || data.error || `Erreur HTTP ${res.status}`);
    return data;
  }).catch(e => {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error('Pi inaccessible — délai dépassé (10s). Vérifiez que vous êtes sur le réseau cabinet ou connecté à Tailscale.');
    throw e;
  });
}

function genererCodeLocal(slug) {
  const chiffres = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  const lettres = Array.from({ length: 2 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random() * 26)]).join('');
  return `${slug.toUpperCase()}-${chiffres}-${lettres}`;
}

function copierPresse(texte) {
  navigator.clipboard.writeText(texte).then(() => toast('Copié ✓'));
}
window.copierPresse = copierPresse;

// ── Génération de code ─────────────────────────────────────────────────────────

async function genererCode() {
  const p = state.patients.find(p => p.id === _currentPatientId);
  if (!p) return;

  const slug = document.getElementById('qi-slug').value;
  const jours = parseInt(document.getElementById('qi-duree').value) || 7;
  if (!slug) { toast('Choisissez un questionnaire.', 'error'); return; }

  const meta = QUESTIONNAIRE_META[slug];
  if (!meta) { toast('Questionnaire inconnu.', 'error'); return; }

  const now = new Date();
  const dateCreation = now.toISOString();
  let code, dateExpiration, synchro;

  try {
    // Le Pi génère le code et le stocke lui-même
    const res = await piRequest('/api/codes', {
      method: 'POST',
      body: JSON.stringify({ questionnaire: slug.toUpperCase(), ttl_heures: jours * 24 }),
    });
    code = res.code;
    // expires_at est un timestamp Unix sur le Pi
    dateExpiration = res.expires_at
      ? new Date(res.expires_at * 1000).toISOString()
      : new Date(now.getTime() + jours * 86400000).toISOString();
    synchro = true;
  } catch (e) {
    // Fallback : code local si Pi inaccessible
    code = genererCodeLocal(slug);
    dateExpiration = new Date(now.getTime() + jours * 86400000).toISOString();
    synchro = false;
  }

  await createQuestionnaireCode(_db, {
    patientId: String(p.id),
    code,
    slug,
    dateCreation,
    dateExpiration,
    statut: synchro ? 'en_attente' : 'non_synchronisé',
  });

  if (!synchro) {
    toast('Pi inaccessible — code créé localement, à synchroniser plus tard.', 'error');
  }

  await renderOngletQuestionnaires();

  const pwaUrl = (state.settings.pwaUrl || '').trim();
  const lien = `${pwaUrl}?code=${code}`;
  const expStr = new Date(dateExpiration).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });

  document.getElementById('qi-result').innerHTML = `
    <div class="code-result-box">
      <div class="code-result-badge">${code}</div>
      <div style="font-size:var(--text-sm);color:var(--color-text-muted);margin:var(--space-2) 0;">
        ${synchro ? '✅ Transmis au Pi' : '⚠️ Non synchronisé avec le Pi'} · Expire le ${expStr}
      </div>
      <div style="font-size:var(--text-xs);color:var(--color-text-muted);margin-bottom:var(--space-3);word-break:break-all;">${escapeHtml(lien)}</div>
      <div style="display:flex;gap:var(--space-2);flex-wrap:wrap;">
        <button class="btn btn-primary btn-sm" onclick="copierPresse('${escapeHtml(lien)}')"><i data-lucide="link"></i> Copier le lien</button>
        <button class="btn btn-secondary btn-sm" onclick="copierPresse('${code}')"><i data-lucide="copy"></i> Copier le code</button>
        ${!synchro ? `<button class="btn btn-ghost btn-sm" onclick="reessayerSynchroCode('${code}')"><i data-lucide="refresh-cw"></i> Réessayer</button>` : ''}
      </div>
    </div>`;
  lucide.createIcons();
}
window.genererCode = genererCode;

async function reessayerSynchroCode(code) {
  const row = await getQuestionnaireCodeByCode(_db, code);
  if (!row) return;
  try {
    await piRequest('/api/codes', {
      method: 'POST',
      body: JSON.stringify({ code: row.code, questionnaire_slug: row.questionnaire_slug, expires_at: row.date_expiration }),
    });
    await updateQuestionnaireCodeStatut(_db, code, 'en_attente');
    toast('Code synchronisé avec le Pi ✓');
    await renderOngletQuestionnaires();
  } catch (e) {
    toast(`Échec : ${e.message}`, 'error');
  }
}
window.reessayerSynchroCode = reessayerSynchroCode;

// ── Onglet Questionnaires — rendu complet ─────────────────────────────────────

async function renderOngletQuestionnaires() {
  const p = state.patients.find(p => p.id === _currentPatientId);
  if (!p) return;

  // Mettre à jour statuts expirés localement (sans appel réseau)
  await expireQuestionnaireCodesLocally(_db);

  const codes = await getQuestionnaireCodesByPatient(_db, String(p.id));
  const resultats = await getResultatsByPatient(_db, String(p.id));
  const alertes = await getAlertesByPatient(_db, String(p.id));

  const alertesNonLues = alertes.filter(a => !a.lu);
  const tabBtn = document.querySelector('#pd-tabs .tab-btn[onclick*="questionnaires"]');
  if (tabBtn) {
    const badge = tabBtn.querySelector('.alert-badge-tab');
    if (alertesNonLues.length) {
      if (!badge) tabBtn.insertAdjacentHTML('beforeend', `<span class="alert-badge-tab badge badge-error" style="margin-left:4px;font-size:10px;">${alertesNonLues.length}</span>`);
      else badge.textContent = alertesNonLues.length;
    } else if (badge) badge.remove();
  }

  const el = document.getElementById('qi-remote-section');
  if (!el) return;

  const statutBadge = s => ({
    'en_attente':      '<span class="badge badge-warning">🟡 En attente</span>',
    'complété':        '<span class="badge badge-success">✅ Complété</span>',
    'expiré':          '<span class="badge badge-error">🔴 Expiré</span>',
    'non_synchronisé': '<span class="badge badge-muted">⚠️ Non synchronisé</span>',
  }[s] || `<span class="badge">${escapeHtml(s)}</span>`);

  const tableauCodes = codes.length ? `
    <table>
      <thead><tr><th>Questionnaire</th><th>Code</th><th>Envoyé le</th><th>Expire le</th><th>Statut</th><th></th></tr></thead>
      <tbody>
        ${codes.map(c => {
          const meta = QUESTIONNAIRE_META[c.questionnaire_slug] || {};
          const action = c.statut === 'non_synchronisé'
            ? `<button class="btn btn-ghost btn-sm" onclick="reessayerSynchroCode('${c.code}')"><i data-lucide="refresh-cw"></i></button>`
            : '';
          return `<tr>
            <td>${escapeHtml(meta.label || c.questionnaire_slug)} — ${escapeHtml(meta.titre || '')}</td>
            <td><code>${escapeHtml(c.code)}</code></td>
            <td>${formatDate(c.date_creation.slice(0,10))}</td>
            <td>${formatDate(c.date_expiration.slice(0,10))}</td>
            <td>${statutBadge(c.statut)}</td>
            <td>${action}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>` : `<p style="color:var(--color-text-muted);font-size:var(--text-sm);">Aucun code généré pour ce patient.</p>`;

  // Alertes actives
  const alertesHtml = alertes.length ? `
    <div style="margin-bottom:var(--space-4);">
      ${alertes.filter(a => !a.lu).map(a => `
        <div class="alert alert-error" style="margin-bottom:var(--space-2);">
          <i data-lucide="alert-triangle"></i>
          <div>${escapeHtml(a.message)}</div>
        </div>`).join('')}
    </div>` : '';

  // Graphiques & tableaux évolution par slug
  const slugsAvecResultats = [...new Set(resultats.map(r => r.questionnaire_slug))];
  const evolutionHtml = slugsAvecResultats.map(slug => renderEvolutionSlug(slug, resultats.filter(r => r.questionnaire_slug === slug))).join('');

  el.innerHTML = `
    <div class="alert alert-info" style="margin-bottom:var(--space-4);">
      <i data-lucide="info"></i>
      <div class="clinical-disclaimer" style="margin:0;">Ces outils sont des aides au repérage clinique, non des outils diagnostiques.</div>
    </div>

    ${alertesHtml}

    <!-- Génération de code -->
    <div class="card" style="margin-bottom:var(--space-5);">
      <div class="section-header" style="margin-bottom:var(--space-3);">
        <h3 class="section-title" style="font-size:var(--text-base);">Envoyer un questionnaire à distance</h3>
        <button class="btn btn-secondary btn-sm" onclick="synchroniserResultats()"><i data-lucide="refresh-cw"></i> Synchroniser avec le Pi</button>
      </div>
      <div style="display:flex;gap:var(--space-3);flex-wrap:wrap;align-items:flex-end;margin-bottom:var(--space-3);">
        <div class="form-group" style="margin:0;min-width:220px;">
          <label style="font-size:var(--text-xs);">Questionnaire</label>
          <select class="form-select" id="qi-slug">
            <option value="">— choisir —</option>
            ${Object.entries(QUESTIONNAIRE_META).map(([k,v]) => `<option value="${k}">${v.label} — ${v.titre}</option>`).join('')}
          </select>
        </div>
        <div class="form-group" style="margin:0;">
          <label style="font-size:var(--text-xs);">Validité</label>
          <select class="form-select" id="qi-duree">
            <option value="3">3 jours</option>
            <option value="7" selected>7 jours</option>
            <option value="14">14 jours</option>
            <option value="30">30 jours</option>
          </select>
        </div>
        <button class="btn btn-primary" onclick="genererCode()"><i data-lucide="key"></i> Générer le code</button>
      </div>
      <div id="qi-result"></div>
    </div>

    <!-- Tableau des codes -->
    <div style="margin-bottom:var(--space-6);">
      <h3 class="section-title" style="font-size:var(--text-base);margin-bottom:var(--space-3);">Historique des codes envoyés</h3>
      <div class="table-container">${tableauCodes}</div>
    </div>

    <!-- Évolution -->
    ${evolutionHtml ? `<div>
      <h3 class="section-title" style="font-size:var(--text-base);margin-bottom:var(--space-3);">Évolution des scores</h3>
      ${evolutionHtml}
    </div>` : ''}
  `;
  lucide.createIcons();
}
window.renderOngletQuestionnaires = renderOngletQuestionnaires;

// ── Vue évolution par questionnaire ───────────────────────────────────────────

function renderEvolutionSlug(slug, resultats) {
  const meta = QUESTIONNAIRE_META[slug] || { label: slug, scoreMax: 100, seuilAlerte: null };
  if (resultats.length < 1) return '';

  const sorted = [...resultats].sort((a, b) => a.date_passation.localeCompare(b.date_passation));

  // Graphique SVG
  const W = 500, H = 160, PAD = { t: 16, r: 20, b: 32, l: 40 };
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const scoreMax = meta.scoreMax;

  const xStep = sorted.length > 1 ? innerW / (sorted.length - 1) : innerW / 2;
  const yScale = v => innerH - (v / scoreMax) * innerH;

  const points = sorted.map((r, i) => ({
    x: PAD.l + (sorted.length > 1 ? i * xStep : innerW / 2),
    y: PAD.t + yScale(r.score_total ?? 0),
    score: r.score_total,
    date: r.date_passation.slice(0, 10),
    interp: r.interpretation || '',
  }));

  const polyline = points.map(p => `${p.x},${p.y}`).join(' ');

  // Seuil clinique
  const seuilY = meta.seuilAlerte ? PAD.t + yScale(meta.seuilAlerte) : null;
  const seuilLine = seuilY ? `<line x1="${PAD.l}" y1="${seuilY}" x2="${W - PAD.r}" y2="${seuilY}" stroke="var(--color-warning)" stroke-width="1" stroke-dasharray="4,3" opacity="0.7"/>` : '';

  // Marqueurs de séances du patient actuel dans la plage de dates
  const patientSeances = _currentPatientId
    ? state.seances.filter(s => s.patientId === _currentPatientId && (s.statut === 'present' || s.statut === 'planifie' || s.statut === 'confirme'))
    : [];
  const dateMin = sorted[0].date_passation.slice(0, 10);
  const dateMax = sorted[sorted.length - 1].date_passation.slice(0, 10);
  const xFromDate = dateStr => {
    if (sorted.length < 2) return PAD.l + innerW / 2;
    const t0 = new Date(dateMin).getTime(), t1 = new Date(dateMax).getTime();
    const t = new Date(dateStr).getTime();
    if (t1 === t0) return PAD.l + innerW / 2;
    return PAD.l + ((t - t0) / (t1 - t0)) * innerW;
  };
  const seanceMarkers = patientSeances
    .filter(s => s.date >= dateMin && s.date <= dateMax)
    .map(s => {
      const x = xFromDate(s.date);
      return `<line x1="${x}" y1="${PAD.t}" x2="${x}" y2="${PAD.t + innerH}" stroke="#2c6b4f" stroke-width="1" stroke-dasharray="3,3" opacity="0.45"><title>Séance du ${formatDate(s.date)}</title></line>`;
    }).join('');

  const circles = points.map(p => `
    <circle cx="${p.x}" cy="${p.y}" r="5" fill="var(--color-primary)" stroke="white" stroke-width="2">
      <title>${p.date} — Score ${p.score} — ${escapeHtml(p.interp)}</title>
    </circle>`).join('');

  const xLabels = points.map(p => `<text x="${p.x}" y="${H - 6}" text-anchor="middle" font-size="10" fill="var(--color-text-muted)">${p.date.slice(5)}</text>`).join('');
  const yLabels = [0, Math.round(scoreMax / 2), scoreMax].map(v => `<text x="${PAD.l - 6}" y="${PAD.t + yScale(v) + 4}" text-anchor="end" font-size="10" fill="var(--color-text-muted)">${v}</text>`).join('');

  const svg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:${W}px;display:block;overflow:visible;">
    ${seuilLine}
    ${seanceMarkers}
    <polyline points="${polyline}" fill="none" stroke="var(--color-primary)" stroke-width="2"/>
    ${circles}
    ${xLabels}
    ${yLabels}
  </svg>`;

  // Tableau récapitulatif avec delta
  const lignes = sorted.map((r, i) => {
    const prev = i > 0 ? sorted[i - 1] : null;
    let deltaHtml = '—';
    if (prev && r.score_total !== null && prev.score_total !== null) {
      const delta = r.score_total - prev.score_total;
      const seuil = meta.seuilAlerte ?? 5;
      const color = delta > seuil ? 'var(--color-error)' : delta < -seuil ? 'var(--color-success)' : 'var(--color-text-muted)';
      const arrow = delta > 0 ? '↑' : delta < 0 ? '↓' : '→';
      deltaHtml = `<span style="color:${color};font-weight:600;">${arrow} ${delta > 0 ? '+' : ''}${delta}</span>`;
    }
    const consentBadge = r.consentement_recueilli
      ? `<span style="color:var(--color-success);font-size:var(--text-xs);">✓</span>`
      : `<span style="color:var(--color-text-muted);font-size:var(--text-xs);">—</span>`;
    return `<tr>
      <td>${formatDate(r.date_passation.slice(0,10))}</td>
      <td><strong>${r.score_total ?? '—'}</strong></td>
      <td style="font-size:var(--text-xs);">${escapeHtml(r.interpretation || '—')}</td>
      <td>${deltaHtml}</td>
      <td style="text-align:center;">${consentBadge}</td>
    </tr>`;
  }).join('');

  return `<div class="questionnaire-block" style="margin-bottom:var(--space-5);">
    <div class="questionnaire-title">${escapeHtml(meta.label)} — ${escapeHtml(meta.titre)}</div>
    <div style="margin:var(--space-3) 0;">${svg}</div>
    <div class="table-container">
      <table>
        <thead><tr><th>Date</th><th>Score</th><th>Interprétation</th><th>Évolution</th><th style="text-align:center;" title="Consentement RGPD recueilli">RGPD</th></tr></thead>
        <tbody>${lignes}</tbody>
      </table>
    </div>
  </div>`;
}

// ── Synchronisation des résultats ─────────────────────────────────────────────

// Le champ "severity" renvoyé par le Pi est soit une chaîne simple ("Léger"),
// soit un objet JSON encodé en chaîne pour les questionnaires à sous-scores
// (ex. HAD, LSAS, IESR) — on en extrait un libellé lisible dans les deux cas.
function interpretationDepuisSeverity(raw) {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && obj.label) return obj.label;
  } catch (_) {}
  return raw;
}

async function synchroniserResultats() {
  const btn = document.querySelector('[onclick="synchroniserResultats()"]');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i data-lucide="loader"></i> Synchronisation…'; lucide.createIcons(); }

  try {
    // Le Pi ne filtre que sur son propre statut "exported" (pas de paramètre
    // "since" côté serveur) : on ne récupère que ce qui n'a jamais été marqué
    // exporté, puis on marque explicitement ce qu'on a réellement importé.
    const resultats = await piRequest('/api/resultats');

    if (!resultats.length) {
      toast('Aucun nouveau résultat sur le Pi.');
      return;
    }

    const now = new Date().toISOString();
    let importes = 0;
    const idsExportes = [];

    for (const r of resultats) {
      const codeRow = await getQuestionnaireCodeByCode(_db, r.code);
      if (!codeRow) continue; // résultat sans code connu localement (ex. donnée de test côté Pi) — on ne le marque pas exporté, il resera visible au prochain essai

      const slug = (r.questionnaire || '').toLowerCase();
      const datePassation = r.submitted_at ? new Date(r.submitted_at * 1000).toISOString() : now;
      const interpretation = interpretationDepuisSeverity(r.severity);
      let itemScores = null;
      try { itemScores = r.answers ? JSON.parse(r.answers) : null; } catch (_) {}

      await insertQuestionnaireResultat(_db, {
        patientId: codeRow.patient_id,
        slug,
        code: r.code,
        datePassation,
        scoreTotal: r.score ?? null,
        interpretation,
        detailsJson: r.answers || null,
        synchroDate: now,
        consentementRecueilli: r.consentement_recueilli ? 1 : 0,
      });

      await updateQuestionnaireCodeStatut(_db, r.code, 'complété', datePassation);

      // Alertes de détérioration
      await verifierAlertes(_db, codeRow.patient_id, {
        questionnaire_slug: slug,
        code: r.code,
        date_passation: datePassation,
        score_total: r.score ?? null,
        details: itemScores ? { item_scores: itemScores } : null,
      });

      idsExportes.push(r.id);
      importes++;
    }

    // Marque côté Pi les résultats réellement importés, pour ne plus les
    // re-télécharger à la prochaine synchro.
    if (idsExportes.length) {
      await piRequest('/api/resultats/exporter', {
        method: 'POST',
        body: JSON.stringify({ ids: idsExportes }),
      });
    }

    toast(`${importes} résultat${importes > 1 ? 's' : ''} synchronisé${importes > 1 ? 's' : ''} ✓`);
    await renderOngletQuestionnaires();
    refreshPatientBadges();

  } catch (e) {
    toast(e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="refresh-cw"></i> Synchroniser avec le Pi'; lucide.createIcons(); }
  }
}
window.synchroniserResultats = synchroniserResultats;

// ── Alertes de détérioration ──────────────────────────────────────────────────

const SEUILS_ALERTE = {
  phq9: 5, gad7: 5, had: 3, bdi2: 5, isi: 4, pcl5: 10,
  aaq2: 5, cfq: 5, lsas: 10, qips: 8, iesr: 8, audit: 4, dast10: 2, rathus: -10,
};

async function verifierAlertes(db, patientId, resultat) {
  const slug = resultat.questionnaire_slug;
  const seuil = SEUILS_ALERTE[slug];

  // Alerte spéciale BDI-II item 9 (idées suicidaires)
  if (slug === 'bdi2' && resultat.details) {
    const item9 = resultat.details.item_scores?.[8] ?? null;
    if (item9 !== null && item9 >= 2) {
      await createAlerteQuestionnaire(db, {
        patientId,
        slug,
        code: resultat.code,
        datePassation: resultat.date_passation,
        typeAlerte: 'item_critique',
        message: `⚠️ Réponse notable à l'item idées suicidaires (BDI-II). Score item 9 : ${item9}. Passation du ${formatDate(resultat.date_passation.slice(0,10))}.`,
        scoreActuel: resultat.score_total,
        scorePrecedent: null,
      });
    }
  }

  if (seuil == null) return;

  // Comparer avec la passation précédente
  const historique = await getResultatsByPatientAndSlug(db, patientId, slug);
  const precedent = historique.length >= 2 ? historique[historique.length - 2] : null;
  if (!precedent || resultat.score_total == null || precedent.score_total == null) return;

  const delta = resultat.score_total - precedent.score_total;
  const deterioration = slug === 'rathus' ? delta <= seuil : delta >= seuil;

  if (deterioration) {
    const meta = QUESTIONNAIRE_META[slug] || { label: slug };
    const sign = delta > 0 ? '+' : '';
    await createAlerteQuestionnaire(db, {
      patientId,
      slug,
      code: resultat.code,
      datePassation: resultat.date_passation,
      typeAlerte: 'deterioration',
      message: `Score ${meta.label} en hausse significative (${sign}${delta} points depuis le ${formatDate(precedent.date_passation.slice(0,10))}). Dernière passation : ${resultat.score_total}.`,
      scoreActuel: resultat.score_total,
      scorePrecedent: precedent.score_total,
    });
  }
}

function refreshPatientBadges() {
  // Recharge la liste pour mettre à jour les badges sur les vignettes patient
  const grid = document.getElementById('patient-grid');
  if (grid && grid.closest('#page-patients')?.classList.contains('active')) renderPatients();
}

// ── Compat legacy renderPwaCodes (appelé depuis switchPatientTab ancien) ───────
async function renderPwaCodes() { /* remplacé par renderOngletQuestionnaires */ }
window.renderPwaCodes = renderPwaCodes;

// ── pwaImporterResultats legacy → redirige ────────────────────────────────────
async function pwaImporterResultats() { await synchroniserResultats(); }
window.pwaImporterResultats = pwaImporterResultats;

// ===== INIT =====
async function init() {
  const hasData = await loadState();
  lucide.createIcons();
  refreshDashboard();
  refreshSidebarCounts();
  if (_dbInitFailed) {
    toast("Impossible d'initialiser la base de données locale — rien ne pourra être enregistré.", 'error');
    dialogMessage(
      `Détail technique (à transmettre si besoin) :\n\n${_dbInitError}`,
      { title: "Échec d'initialisation de la base de données", kind: 'error' }
    );
  }
  if (!hasData) navigate('settings');
  if (!_dbInitFailed) startICSAutoRefresh();
}

init();
