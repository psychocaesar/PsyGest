import { writeTextFile } from '@tauri-apps/plugin-fs';
import { open as dialogOpen, save as dialogSave, ask } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { initDb, loadAll, saveAll, migrateFromJSON, exportAllData, importAllData } from './db.js';

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
  tauxUrssaf: 21.2,
  tarifConsultation: 60,
  dureeConsultation: 50,
  calendlyUrl: '',
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
    return state.patients.length > 0 || state.factures.length > 0 || migrated;
  } catch (e) {
    console.error('loadState:', e);
    return false;
  }
}

async function saveState() {
  try {
    await saveAll(_db, state);
  } catch (e) {
    console.error('saveState:', e);
    toast('Erreur lors de la sauvegarde.', 'error');
  }
}

// ===== NAVIGATION =====
const pageNames = {
  dashboard: 'Tableau de bord',
  patients: 'Dossiers patients',
  factures: 'Factures',
  agenda: 'Agenda',
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
  el.innerHTML = `<i data-lucide="${icon}"></i>${msg}`;
  document.getElementById('toasts').appendChild(el);
  lucide.createIcons();
  setTimeout(() => el.remove(), 3500);
}

// ===== HELPERS =====
function today() { return new Date().toISOString().split('T')[0]; }
function formatNum(n) { return 'FAC-' + new Date().getFullYear() + '-' + String(n).padStart(4, '0'); }
function formatDate(d) { if (!d) return '—'; return new Date(d + 'T12:00:00').toLocaleDateString('fr-FR'); }
function formatAmount(a) { return Number(a).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'; }
function getInitials(prenom, nom) { return ((prenom || '')[0] || '') + ((nom || '')[0] || '').toUpperCase(); }
function urssafRate() { return (state.settings.tauxUrssaf ?? 21.2) / 100; }
function dataFilePath() {
  // Affiche un chemin lisible selon l'OS
  const home = '~';
  return `${home}/Documents/PsyGest/data.json`;
}

// ===== PATIENTS =====
async function savePatient() {
  const prenom = document.getElementById('p-prenom').value.trim();
  const nom = document.getElementById('p-nom').value.trim();
  if (!prenom || !nom) { toast('Prénom et nom requis.', 'error'); return; }
  if (!document.getElementById('p-rgpd').checked) { toast('Consentement RGPD requis.', 'error'); return; }
  state.patients.push({
    id: Date.now(), prenom, nom,
    naissance: document.getElementById('p-naissance').value,
    tel: document.getElementById('p-tel').value,
    email: document.getElementById('p-email').value,
    motif: document.getElementById('p-motif').value,
    dateCreation: new Date().toISOString(),
    rgpd: true,
  });
  await saveState();
  closeModal('modalNewPatient');
  ['p-prenom', 'p-nom', 'p-naissance', 'p-tel', 'p-email', 'p-motif'].forEach(id => {
    document.getElementById(id).value = '';
  });
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
      state.patients.map(p => `<option value="${p.id}">${p.prenom} ${p.nom}</option>`).join('');
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
    id: Date.now(),
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
    const badge = f.statut === 'payee'
      ? '<span class="badge badge-success">Payée</span>'
      : f.statut === 'annulee'
        ? '<span class="badge badge-error">Annulée</span>'
        : '<span class="badge badge-warning">En attente</span>';
    const hasEmail = !!(patient && patient.email);
    return `<tr class="tr-clickable" onclick="apercuFacture(${f.id})">
      <td><span class="td-name">${f.numero}</span></td>
      <td>${patient ? `<span class="td-name">${patient.prenom} ${patient.nom}</span>` : '<span style="color:var(--color-text-muted)">—</span>'}</td>
      <td>${formatDate(f.date)}</td>
      <td>${f.prestation}</td>
      <td><strong>${formatAmount(f.montant)}</strong></td>
      <td>${badge}</td>
      <td onclick="event.stopPropagation()">
        <button class="btn btn-ghost btn-sm" onclick="apercuFacture(${f.id})" title="Aperçu"><i data-lucide="eye"></i></button>
        ${hasEmail ? `<button class="btn btn-ghost btn-sm" onclick="sendByEmail(${f.id})" title="Envoyer par mail"><i data-lucide="mail"></i></button>` : ''}
        ${f.statut !== 'payee' ? `<button class="btn btn-ghost btn-sm" onclick="markPaid(${f.id})" title="Marquer payée" style="color:var(--color-success)"><i data-lucide="check"></i></button>` : ''}
      </td>
    </tr>`;
  }).join('');
  lucide.createIcons();
}

async function markPaid(id) {
  const f = state.factures.find(f => f.id === id);
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
  const f = state.factures.find(f => f.id === id);
  if (!f) return;
  _currentApercuId = id;
  const patient = state.patients.find(p => p.id === f.patientId);
  const s = state.settings;
  const nomPraticien = [s.prenom, s.nom].filter(Boolean).join(' ') || 'Praticien';
  const tva = 'Non soumis à TVA (Art. 261-4-1° du CGI)';

  document.getElementById('apercu-content').innerHTML = `
    <div class="invoice-preview" id="print-zone">
      <div class="invoice-header">
        <div class="invoice-from">
          <strong>${nomPraticien}</strong>
          Psychologue<br>
          ${s.adresse ? s.adresse.replace(/\n/g, '<br>') + '<br>' : ''}
          ${s.rpps ? 'N° RPPS : ' + s.rpps + '<br>' : ''}
          ${s.siret ? 'SIRET : ' + s.siret + '<br>' : ''}
          ${s.tel ? 'Tél : ' + s.tel : ''}
        </div>
        <div class="invoice-number">
          <div style="font-size:12px;color:#888;margin-bottom:4px;">FACTURE</div>
          <div class="inv-num">${f.numero}</div>
          <div style="font-size:12px;color:#888;margin-top:6px;">Date : ${formatDate(f.date)}</div>
          <div style="font-size:12px;color:#888;">Émise le : ${formatDate(f.dateCreation.split('T')[0])}</div>
        </div>
      </div>
      <div class="invoice-patient">
        <strong>Patient :</strong> ${patient ? `${patient.prenom} ${patient.nom}` : '—'}
        ${patient && patient.email ? `<br>Email : ${patient.email}` : ''}
        ${patient && patient.tel ? `<br>Tél : ${patient.tel}` : ''}
      </div>
      <table class="invoice-table">
        <thead><tr>
          <th>Description</th>
          <th style="text-align:right">Durée</th>
          <th style="text-align:right">Montant TTC</th>
        </tr></thead>
        <tbody>
          <tr>
            <td>${f.prestation}</td>
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

function sendCurrentFactureByEmail() {
  if (_currentApercuId) sendByEmail(_currentApercuId);
}
window.sendCurrentFactureByEmail = sendCurrentFactureByEmail;

async function sendByEmail(id) {
  const f = state.factures.find(f => f.id === id);
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
    'Non soumis à TVA (Art. 261-4-1° du CGI).',
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
  const patientId = parseInt(document.getElementById('s-patient').value) || null;
  const date = document.getElementById('s-date').value;
  const heure = document.getElementById('s-heure').value;
  if (!date || !heure) { toast('Date et heure requises.', 'error'); return; }
  const editId = document.getElementById('s-edit-id').value;
  const statut = document.getElementById('s-statut').value || 'planifie';
  const noteSeance = document.getElementById('s-note-seance').value;
  if (editId) {
    const s = state.seances.find(s => String(s.id) === editId);
    if (s) {
      s.patientId = patientId; s.date = date; s.heure = heure;
      s.duree = document.getElementById('s-duree').value;
      s.type = document.getElementById('s-type').value;
      s.statut = statut; s.noteInterne = noteSeance;
    }
  } else {
    state.seances.push({
      id: Date.now(), patientId, date, heure,
      duree: document.getElementById('s-duree').value,
      type: document.getElementById('s-type').value,
      statut, noteInterne: noteSeance, facture: false, note: '',
    });
  }
  await saveState();
  closeModal('modalNewSeance');
  document.getElementById('s-edit-id').value = '';
  document.getElementById('s-note-seance').value = '';
  document.getElementById('seance-modal-title').textContent = 'Planifier une séance';
  document.getElementById('seance-modal-btn').innerHTML = '<i data-lucide="calendar-plus"></i> Planifier';
  lucide.createIcons();
  toast(editId ? 'Séance mise à jour ✓' : 'Séance planifiée ✓');
  renderAgenda();
}
window.saveSeance = saveSeance;

function openEditSeance(id) {
  const s = state.seances.find(s => s.id === id);
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
  document.getElementById('seance-modal-title').textContent = 'Modifier la séance';
  document.getElementById('seance-modal-btn').innerHTML = '<i data-lucide="save"></i> Enregistrer';
  lucide.createIcons();
  document.getElementById('modalNewSeance').classList.add('open');
}
window.openEditSeance = openEditSeance;

async function setSeanceStatut(id, statut) {
  const s = state.seances.find(s => s.id === id);
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
    const patientLabel = patient ? `${patient.prenom} ${patient.nom}` : (s.note || '<span style="color:var(--color-text-faint)">—</span>');
    const st = SEANCE_STATUTS[s.statut || 'planifie'] || SEANCE_STATUTS.planifie;
    const statutBadge = `<span class="badge ${st.badge}">${st.label}</span>`;
    // Boutons statut rapide
    const quickBtns = s.statut !== 'present'
      ? `<button class="btn btn-ghost btn-sm" onclick="setSeanceStatut(${s.id},'present')" title="Marquer présent" style="color:var(--color-success)"><i data-lucide="user-check"></i></button>`
      : '';
    const absentBtn = s.statut !== 'absent'
      ? `<button class="btn btn-ghost btn-sm" onclick="setSeanceStatut(${s.id},'absent')" title="Marquer absent" style="color:var(--color-warning)"><i data-lucide="user-x"></i></button>`
      : '';
    const annuleBtn = s.statut !== 'annule'
      ? `<button class="btn btn-ghost btn-sm" onclick="setSeanceStatut(${s.id},'annule')" title="Annuler la séance" style="color:var(--color-error)"><i data-lucide="x-circle"></i></button>`
      : '';
    return `<tr>
      <td>${formatDate(s.date)}</td><td>${s.heure || '—'}</td>
      <td>${patientLabel}</td>
      <td>${types[s.type] || s.type}</td><td>${s.duree} min</td>
      <td>${statutBadge}</td>
      <td style="white-space:nowrap;">
        <button class="btn btn-ghost btn-sm" onclick="openEditSeance(${s.id})" title="Modifier"><i data-lucide="pencil"></i></button>
        ${quickBtns}${absentBtn}${annuleBtn}
        ${s.patientId && s.statut !== 'annule' ? `<button class="btn btn-ghost btn-sm" onclick="factureFromSeance(${s.id})" title="Créer facture" style="color:var(--color-primary)"><i data-lucide="file-plus"></i></button>` : ''}
        <button class="btn btn-ghost btn-sm" onclick="deleteSeance(${s.id})" title="Supprimer" style="color:var(--color-error)"><i data-lucide="trash-2"></i></button>
      </td>
    </tr>`;
  }).join('');
  lucide.createIcons();
}

async function deleteSeance(id) {
  state.seances = state.seances.filter(s => s.id !== id);
  await saveState();
  renderAgenda();
  toast('Séance supprimée.');
}
window.deleteSeance = deleteSeance;

function factureFromSeance(id) {
  const s = state.seances.find(s => s.id === id);
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
        ? `${s.heure || ''} ${patient.prenom[0]}.${patient.nom}`
        : `${s.heure || ''} ${s.note || 'Rendez-vous'}`;
      const st = SEANCE_STATUTS[s.statut || 'planifie'] || SEANCE_STATUTS.planifie;
      const title = `${patient ? patient.prenom + ' ' + patient.nom : (s.note || 'RDV')} – ${s.heure || ''} (${s.duree} min) · ${st.label}`;
      html += `<div class="cal-event" style="background:${st.cal[0]};color:${st.cal[1]};" title="${title}" onclick="event.stopPropagation();openEditSeance(${s.id})">${label.trim()}</div>`;
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
  document.getElementById('modalNewSeance').classList.add('open');
}
window.calPrev = calPrev;
window.calNext = calNext;
window.addSeanceOnDay = addSeanceOnDay;

// ===== ICS IMPORT =====
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
      const v = value.replace(/Z$/, '');
      const bare = v.includes('T') ? v.split('T') : [v, null];
      const datePart = bare[0];
      const timePart = bare[1];
      if (datePart && datePart.length >= 8) {
        cur.date = `${datePart.substring(0, 4)}-${datePart.substring(4, 6)}-${datePart.substring(6, 8)}`;
      }
      if (timePart && timePart.length >= 4) {
        cur.heure = `${timePart.substring(0, 2)}:${timePart.substring(2, 4)}`;
      }
    }
    if (key === 'DTEND') {
      const v = value.replace(/Z$/, '');
      const bare = v.includes('T') ? v.split('T') : [v, null];
      const timePart = bare[1];
      if (timePart && cur.heure && cur.date) {
        const startMs = new Date(`${cur.date}T${cur.heure}:00`).getTime();
        const endH = timePart.substring(0, 2);
        const endM = timePart.substring(2, 4);
        const endMs = new Date(`${cur.date}T${endH}:${endM}:00`).getTime();
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
  try {
    // Remplacer webcal:// par https://
    const fetchUrl = url.replace(/^webcal:\/\//i, 'https://');
    const resp = await fetch(fetchUrl);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    const events = parseICS(text);
    await importICSEvents(events);
  } catch (e) {
    toast(`Impossible de charger le calendrier : ${e.message}. Essayez l'import par fichier .ics.`, 'error');
    console.error(e);
  }
}
window.importICSUrl = importICSUrl;

async function importICSEvents(events) {
  if (!events.length) {
    toast('Aucun événement trouvé dans ce fichier.', 'error');
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
      id: Date.now() + Math.random(),
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
    toast('Aucune nouvelle séance (tous les événements existent déjà).');
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
    id: Date.now(), desc, montant,
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
    `<tr><td>${c.desc}</td><td><span class="badge badge-muted">${catLabels[c.cat] || c.cat}</span></td><td>${formatAmount(c.montant)}</td><td>${formatDate(c.date)}</td><td><button class="btn btn-ghost btn-sm" onclick="deleteCharge(${c.id})" style="color:var(--color-error)"><i data-lucide="trash-2"></i></button></td></tr>`
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

  const last5 = state.factures.slice(-5).reverse();
  const tbody = document.getElementById('dashboard-factures-table');
  if (!last5.length) {
    tbody.innerHTML = `<tr><td colspan="5"><div style="padding:var(--space-8);text-align:center;color:var(--color-text-muted);font-size:var(--text-sm);">Aucune facture — créez-en une avec le bouton ci-dessus.</div></td></tr>`;
    return;
  }
  tbody.innerHTML = last5.map(f => {
    const patient = state.patients.find(p => p.id === f.patientId);
    const badge = f.statut === 'payee'
      ? '<span class="badge badge-success">Payée</span>'
      : '<span class="badge badge-warning">En attente</span>';
    return `<tr class="tr-clickable" onclick="apercuFacture(${f.id})"><td>${f.numero}</td><td>${patient ? patient.prenom + ' ' + patient.nom : '—'}</td><td>${formatDate(f.date)}</td><td>${formatAmount(f.montant)}</td><td>${badge}</td></tr>`;
  }).join('');
}

// ===== STATS =====
function refreshStats() {
  const ca = state.factures.filter(f => f.statut === 'payee').reduce((s, f) => s + Number(f.montant), 0);
  const nb = state.factures.length;
  const payees = state.factures.filter(f => f.statut === 'payee').length;
  document.getElementById('stats-ca').textContent = formatAmount(ca);
  document.getElementById('stats-nb').textContent = nb;
  document.getElementById('stats-moy').textContent = nb ? formatAmount(ca / (payees || 1)) : '0 €';
  document.getElementById('stats-taux').textContent = nb ? Math.round(payees / nb * 100) + ' %' : '—';
}

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
  document.getElementById('set-taux-urssaf').value = s.tauxUrssaf ?? 21.2;
  document.getElementById('set-tarif').value = s.tarifConsultation ?? 60;
  document.getElementById('set-duree').value = s.dureeConsultation ?? 50;
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
    tauxUrssaf: parseFloat(document.getElementById('set-taux-urssaf').value) || 21.2,
    tarifConsultation: parseFloat(document.getElementById('set-tarif').value) || 60,
    dureeConsultation: parseInt(document.getElementById('set-duree').value) || 50,
  };
  await saveState();
  refreshSidebarCounts();
  toast('Réglages enregistrés ✓');
}
window.saveSettings = saveSettings;

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
  const p = state.patients.find(p => p.id === id);
  if (!p) return;
  _currentPatientId = id;
  // Ensure clinical sub-objects exist
  if (!p.notes) p.notes = [];
  if (!p.questionnaires) p.questionnaires = [];
  if (!p.objectifs) p.objectifs = { valeurs: {}, objectifs: [], engagements: [] };

  document.getElementById('pd-avatar').textContent = getInitials(p.prenom, p.nom);
  document.getElementById('pd-name').textContent = `${p.prenom} ${p.nom}`;
  document.getElementById('pd-sub').textContent = [
    p.naissance ? 'Né(e) le ' + formatDate(p.naissance) : null,
    p.tel || null,
    p.email || null,
  ].filter(Boolean).join(' · ');

  renderPatientInfos(id);

  // Clôture badge + bouton
  const badge = document.getElementById('pd-cloture-badge');
  const label = document.getElementById('pd-cloture-label');
  if (p.cloture) {
    badge.style.display = '';
    label.textContent = 'Réouvrir';
  } else {
    badge.style.display = 'none';
    label.textContent = 'Clôturer';
  }
  lucide.createIcons();

  switchPatientTab('infos');
  navigate('patient-detail');
}

function renderPatientInfos(id) {
  const p = state.patients.find(p => p.id === id);
  if (!p) return;
  const factures = state.factures.filter(f => f.patientId === id)
    .sort((a, b) => b.date.localeCompare(a.date));
  const caTotal = factures.filter(f => f.statut === 'payee').reduce((s, f) => s + Number(f.montant), 0);

  const hasEmail = !!(p && p.email);
  const facturesHTML = factures.length ? factures.map(f => {
    const badge = f.statut === 'payee'
      ? '<span class="badge badge-success">Payée</span>'
      : f.statut === 'annulee'
        ? '<span class="badge badge-error">Annulée</span>'
        : '<span class="badge badge-warning">En attente</span>';
    return `<tr>
      <td><span class="td-name">${f.numero}</span></td>
      <td>${formatDate(f.date)}</td>
      <td>${f.prestation}</td>
      <td><strong>${formatAmount(f.montant)}</strong></td>
      <td>${badge}</td>
      <td style="text-align:center;">
        <button class="btn btn-ghost btn-sm" onclick="apercuFacture(${f.id})" title="Voir la facture"><i data-lucide="eye"></i></button>
      </td>
      <td style="text-align:center;">
        ${hasEmail
          ? `<button class="btn btn-ghost btn-sm" onclick="sendByEmail(${f.id})" title="Envoyer par mail" style="color:var(--color-primary)"><i data-lucide="mail"></i></button>`
          : `<span title="Aucun email renseigné" style="color:var(--color-text-faint);padding:0 var(--space-2);">—</span>`}
      </td>
      <td style="text-align:center;">
        ${f.statut !== 'payee'
          ? `<button class="btn btn-ghost btn-sm" onclick="markPaid(${f.id})" title="Marquer payée" style="color:var(--color-success)"><i data-lucide="check-circle"></i></button>`
          : `<span style="color:var(--color-success);padding:0 var(--space-2);">✓</span>`}
      </td>
    </tr>`;
  }).join('') : `<tr><td colspan="8"><div style="padding:var(--space-6);text-align:center;color:var(--color-text-muted);font-size:var(--text-sm);">Aucune facture pour ce patient.</div></td></tr>`;

  document.getElementById('pd-infos-content').innerHTML = `
    <div style="padding:var(--space-5);border-bottom:1px solid var(--color-divider);">
      <div style="font-size:var(--text-xs);font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--color-text-muted);margin-bottom:var(--space-3);">Informations</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-3);font-size:var(--text-sm);">
        <div><span style="color:var(--color-text-muted);font-size:var(--text-xs);">Dossier créé le</span><br>${formatDate(p.dateCreation?.split('T')[0])}</div>
        <div><span style="color:var(--color-text-muted);font-size:var(--text-xs);">CA total encaissé</span><br><strong>${formatAmount(caTotal)}</strong></div>
      </div>
      ${p.motif ? `<div style="margin-top:var(--space-3);font-size:var(--text-sm);"><span style="color:var(--color-text-muted);font-size:var(--text-xs);">Motif de consultation</span><br>${p.motif}</div>` : ''}
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
  const badge = document.getElementById('pd-cloture-badge');
  const label = document.getElementById('pd-cloture-label');
  if (p.cloture) {
    badge.style.display = '';
    label.textContent = 'Réouvrir';
    toast(`Dossier de ${p.prenom} ${p.nom} clôturé.`);
  } else {
    badge.style.display = 'none';
    label.textContent = 'Clôturer';
    toast(`Dossier de ${p.prenom} ${p.nom} réouvert.`);
  }
  lucide.createIcons();
}
window.toggleClotureDossier = toggleClotureDossier;

async function deleteCurrentPatient() {
  const p = state.patients.find(p => p.id === _currentPatientId);
  if (!p) return;
  const factures = state.factures.filter(f => f.patientId === p.id);
  const msg = factures.length
    ? `Supprimer définitivement le dossier de ${p.prenom} ${p.nom} et ses ${factures.length} facture(s) associée(s) ? Cette action est irréversible.`
    : `Supprimer définitivement le dossier de ${p.prenom} ${p.nom} ? Cette action est irréversible.`;
  const confirmed = await ask(msg, { title: 'Confirmer la suppression', kind: 'warning' });
  if (!confirmed) return;
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
  const tabs = ['infos', 'notes', 'questionnaires', 'objectifs'];
  tabs.forEach(t => {
    document.getElementById(`pd-tab-${t}`).classList.toggle('active', t === tab);
  });
  document.querySelectorAll('#pd-tabs .tab-btn').forEach((btn, i) => {
    btn.classList.toggle('active', tabs[i] === tab);
  });
  if (tab === 'notes') renderNotes();
  if (tab === 'questionnaires') renderQuestionnaires();
  if (tab === 'objectifs') renderObjectifs();
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
  grid.innerHTML = patients.map(p => {
    const factures = state.factures.filter(f => f.patientId === p.id);
    const ca = factures.reduce((s, f) => s + (f.statut === 'payee' ? Number(f.montant) : 0), 0);
    return `<div class="patient-card${p.cloture ? ' patient-card-cloture' : ''}" onclick="openPatient(${p.id})">
      <div class="patient-card-header">
        <div class="patient-avatar">${getInitials(p.prenom, p.nom)}</div>
        <div style="flex:1;">
          <div class="patient-name">${p.prenom} ${p.nom}</div>
          <div class="patient-info">${p.naissance ? 'né(e) le ' + formatDate(p.naissance) : 'Date non renseignée'}</div>
        </div>
        ${p.cloture ? '<span class="badge badge-muted" style="flex-shrink:0;">Clôturé</span>' : ''}
      </div>
      ${p.tel ? `<div style="font-size:var(--text-xs);color:var(--color-text-muted);margin-bottom:4px;">📞 ${p.tel}</div>` : ''}
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
    const preview = (n.contenu || '').replace(/^#+\s*/gm, '').trim().slice(0, 120);
    return `<div class="note-card">
      <div class="note-card-header">
        <span class="note-card-date">${formatDate(n.date)}</span>
        <span class="note-card-template"><span class="badge badge-primary">${NOTE_TEMPLATE_LABELS[n.template] || n.template}</span></span>
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
      id: Date.now(),
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
    id: Date.now(), type, date: today(), reponses, score, interpretation: interp.label,
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
        <span class="badge" style="background:${interp.color}22;color:${interp.color};">${q.interpretation}</span>
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
    svg += `<title>${formatDate(q.date)}: ${q.score} (${q.interpretation})</title>`;
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
      <div class="valeur-domaine">${DOMAINE_LABELS[d]}</div>
      <textarea class="form-textarea" id="valeur-${d}" placeholder="Ce qui compte pour moi…" rows="3" style="font-size:var(--text-sm);">${(p.objectifs.valeurs && p.objectifs.valeurs[d]) || ''}</textarea>
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
          <div class="objectif-title">${o.intitule}</div>
          <div class="objectif-meta">${DOMAINE_LABELS[o.domaine] || o.domaine} · ${formatDate(o.dateCreation?.split('T')[0])}</div>
          ${o.notes ? `<div style="font-size:var(--text-xs);color:var(--color-text-muted);margin-top:4px;">${o.notes}</div>` : ''}
        </div>
        <div style="display:flex;flex-direction:column;gap:var(--space-2);align-items:flex-end;">
          <span class="badge ${STATUT_COLORS[o.statut] || 'badge-muted'}">${STATUT_LABELS[o.statut] || o.statut}</span>
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
          <div class="${e.realise ? 'engagement-done' : ''}">${e.texte}</div>
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
      id: Date.now(), intitule,
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
  p.objectifs.engagements.push({ id: Date.now(), texte, date: today(), realise: false });
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
  const p = state.patients.find(p => p.id === _currentPatientId);
  if (!p) return;
  const s = state.settings;
  const praticien = [s.prenom, s.nom].filter(Boolean).join(' ') || 'Praticien';
  const factures = state.factures.filter(f => f.patientId === p.id);
  const caTotal = factures.filter(f => f.statut === 'payee').reduce((sum, f) => sum + Number(f.montant), 0);
  const seancesPatient = state.seances.filter(s => s.patientId === p.id);
  const datesSeances = seancesPatient.map(s => s.date).sort();
  const periode = datesSeances.length >= 2
    ? `${formatDate(datesSeances[0])} – ${formatDate(datesSeances[datesSeances.length - 1])}`
    : datesSeances.length === 1 ? formatDate(datesSeances[0]) : '—';

  const notes = (p.notes || []).slice().sort((a, b) => a.date.localeCompare(b.date));
  const objectifs = p.objectifs || { valeurs: {}, objectifs: [], engagements: [] };
  const phq9 = (p.questionnaires || []).filter(q => q.type === 'phq9').sort((a, b) => a.date.localeCompare(b.date));
  const gad7 = (p.questionnaires || []).filter(q => q.type === 'gad7').sort((a, b) => a.date.localeCompare(b.date));

  let html = `
  <div class="dossier-header">
    <div class="dossier-praticien">${praticien} — Psychologue${s.rpps ? ' · N° RPPS : ' + s.rpps : ''}${s.adresse ? ' · ' + s.adresse.replace(/\n/g, ', ') : ''}</div>
    <div class="dossier-patient-name">${p.prenom} ${p.nom}</div>
    <div style="font-size:12px;color:#555;">
      ${p.naissance ? 'Né(e) le ' + formatDate(p.naissance) + ' · ' : ''}
      Dossier créé le ${formatDate(p.dateCreation?.split('T')[0])} · Document généré le ${formatDate(today())}
    </div>
  </div>

  <div class="dossier-section">
    <div class="dossier-section-title">Résumé du suivi</div>
    <table class="dossier-score-table">
      <tr><th>Séances enregistrées</th><td>${seancesPatient.length}</td><th>Séances facturées</th><td>${factures.length}</td></tr>
      <tr><th>CA total encaissé</th><td>${formatAmount(caTotal)}</td><th>Période</th><td>${periode}</td></tr>
      ${p.motif ? `<tr><th>Motif de consultation</th><td colspan="3">${p.motif}</td></tr>` : ''}
    </table>
  </div>

  <div class="dossier-section page-break">
    <div class="dossier-section-title">Valeurs et objectifs thérapeutiques</div>
    ${DOMAINES.filter(d => objectifs.valeurs?.[d]).map(d =>
      `<div style="margin-bottom:8px;font-size:13px;"><strong>${DOMAINE_LABELS[d]} :</strong> ${objectifs.valeurs[d]}</div>`
    ).join('') || '<div style="color:#888;font-size:13px;">Aucune valeur renseignée.</div>'}
    ${(objectifs.objectifs || []).length ? `
      <div style="margin-top:14px;">
        <table class="dossier-score-table">
          <thead><tr><th>Objectif</th><th>Domaine</th><th>Statut</th><th>Créé le</th></tr></thead>
          <tbody>
            ${objectifs.objectifs.map(o => `<tr><td>${o.intitule}</td><td>${DOMAINE_LABELS[o.domaine]||o.domaine}</td><td>${STATUT_LABELS[o.statut]||o.statut}</td><td>${formatDate(o.dateCreation?.split('T')[0])}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>` : ''}
  </div>

  <div class="dossier-section">
    <div class="dossier-section-title">Scores PHQ-9 (Dépression)</div>
    ${phq9.length ? `<table class="dossier-score-table">
      <thead><tr><th>Date</th><th>Score /27</th><th>Interprétation</th></tr></thead>
      <tbody>${phq9.map(q => `<tr><td>${formatDate(q.date)}</td><td>${q.score}</td><td>${q.interpretation}</td></tr>`).join('')}</tbody>
    </table>
    <div style="margin-top:12px;">${buildScoreChart(phq9, 'phq9')}</div>`
    : '<div style="color:#888;font-size:13px;">Aucune passation enregistrée.</div>'}
  </div>

  <div class="dossier-section">
    <div class="dossier-section-title">Scores GAD-7 (Anxiété)</div>
    ${gad7.length ? `<table class="dossier-score-table">
      <thead><tr><th>Date</th><th>Score /21</th><th>Interprétation</th></tr></thead>
      <tbody>${gad7.map(q => `<tr><td>${formatDate(q.date)}</td><td>${q.score}</td><td>${q.interpretation}</td></tr>`).join('')}</tbody>
    </table>
    <div style="margin-top:12px;">${buildScoreChart(gad7, 'gad7')}</div>`
    : '<div style="color:#888;font-size:13px;">Aucune passation enregistrée.</div>'}
  </div>

  <div class="dossier-section page-break">
    <div class="dossier-section-title">Notes cliniques</div>
    ${notes.length ? notes.map(n => `
      <div class="dossier-note">
        <div class="dossier-note-meta">${formatDate(n.date)} · ${NOTE_TEMPLATE_LABELS[n.template] || n.template}</div>
        <div class="dossier-note-content">${(n.contenu || '').replace(/</g, '&lt;')}</div>
      </div>`).join('')
    : '<div style="color:#888;font-size:13px;">Aucune note clinique enregistrée.</div>'}
  </div>

  <div class="dossier-footer">
    Document confidentiel — Secret professionnel (art. 226-13 Code pénal)<br>
    Données de santé soumises au RGPD — usage exclusivement clinique
  </div>`;

  document.getElementById('print-container').innerHTML = html;
  window.print();
  setTimeout(() => { document.getElementById('print-container').innerHTML = ''; }, 2000);
}
window.exportDossierPDF = exportDossierPDF;

// ===== INIT =====
async function init() {
  const hasData = await loadState();
  lucide.createIcons();
  refreshDashboard();
  refreshSidebarCounts();
  if (!hasData) navigate('settings');
}

init();
