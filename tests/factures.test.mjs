// Facturation : montants HT/TVA/TTC, numérotation sans trou, avoirs, conservation des
// factures (obligations légales : numérotation chronologique continue, factures gardées
// 10 ans même si le dossier patient est supprimé).
process.env.TZ = 'Europe/Paris'; // PsyGest est conçu pour un cabinet en France

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { charger, faireDocument, brut } from './harness.mjs';

const ANNEE = new Date().getFullYear();

function etatDeDepart() {
  return {
    patients: [
      { id: '1700000000001', prenom: 'Alice', nom: 'Martin' },
      { id: '1700000000002', prenom: 'Paul', nom: 'Durand' },
    ],
    factures: [], seances: [], charges: [],
    nextFactureNum: 1,
    settings: { tauxUrssaf: 42 },
  };
}

function bacAFactures(state = etatDeDepart(), globaux = {}) {
  return charger([
    'TAUX_TVA_ANALYSE_PRATIQUE', 'factureMontants', 'facturePatientNom', 'figerNomsPatientsFactures',
    'formatNum', 'formatDate', 'formatAmount', 'ymd', 'today', 'escapeHtml', '_factureEnCours', 'saveFacture', 'openAvoirModal', 'saveAvoir',
  ], { state, _avoirFactureId: null, _currentPatientId: null, ...globaux });
}

async function creerFacture(ctx, { patient = '1700000000001', montant = '60', type = 'soin', statut = 'payee' } = {}) {
  ctx.document = faireDocument({
    'f-patient': { value: patient }, 'f-date': { value: `${ANNEE}-10-04` },
    'f-montant': { value: montant }, 'f-type-prestation': { value: type },
    'f-prestation': { value: 'Consultation psychologique' }, 'f-duree': { value: '50' },
    'f-statut': { value: statut }, 'f-notes': { value: '' },
  });
  await ctx.saveFacture();
  return ctx.state.factures.at(-1);
}

async function emettreAvoir(ctx, facture, motif = 'Montant erroné') {
  ctx.document = faireDocument();
  ctx.openAvoirModal(facture.id); // vide le champ motif, comme dans l'interface
  ctx.document.getElementById('av-motif').value = motif;
  await ctx.saveAvoir();
  return ctx.state.factures.at(-1);
}

test('soin : exonéré, HT = TTC, aucune TVA', () => {
  const { factureMontants } = bacAFactures();
  assert.deepEqual(brut(factureMontants({ montant: 60, typePrestation: 'soin' })), { ht: 60, tva: 0, ttc: 60, tauxTva: 0 });
  assert.deepEqual(brut(factureMontants({ montant: 60 })), { ht: 60, tva: 0, ttc: 60, tauxTva: 0 }, 'type absent = soin');
});

test('analyse de pratiques : TVA 20 % recalculée depuis le TTC saisi', () => {
  const { factureMontants } = bacAFactures();
  assert.deepEqual(brut(factureMontants({ montant: 120, typePrestation: 'analyse_pratique' })), { ht: 100, tva: 20, ttc: 120, tauxTva: 20 });
  assert.deepEqual(brut(factureMontants({ montant: 100, typePrestation: 'analyse_pratique' })), { ht: 83.33, tva: 16.67, ttc: 100, tauxTva: 20 });
});

test('analyse de pratiques : HT + TVA retombe exactement sur le TTC, au centime, pour tout montant', () => {
  const { factureMontants } = bacAFactures();
  for (let cents = 100; cents <= 200000; cents += 7) {
    const m = factureMontants({ montant: cents / 100, typePrestation: 'analyse_pratique' });
    assert.equal(Math.round(m.ht * 100) + Math.round(m.tva * 100), cents, `${cents / 100} €`);
  }
});

test('numéro de facture : FAC-année-numéro sur 4 chiffres', () => {
  const { formatNum } = bacAFactures();
  assert.equal(formatNum(7), `FAC-${ANNEE}-0007`);
  assert.equal(formatNum(1234), `FAC-${ANNEE}-1234`);
});

test('nouvelle facture : numérotée, nom du patient figé dessus, type de prestation gardé', async () => {
  const ctx = bacAFactures();
  const f = await creerFacture(ctx, { type: 'analyse_pratique', montant: '120' });
  assert.equal(f.numero, `FAC-${ANNEE}-0001`);
  assert.equal(f.numSeq, 1);
  assert.equal(ctx.state.nextFactureNum, 2);
  assert.equal(f.patientId, '1700000000001', "l'id patient reste une chaîne (sinon le nom ne s'affiche plus)");
  assert.equal(f.patientNom, 'Alice Martin');
  assert.equal(f.typePrestation, 'analyse_pratique');
  assert.equal(f.montant, 120);
});

test('nouvelle facture : refusée sans patient ou avec un montant nul — aucun numéro consommé', async () => {
  const ctx = bacAFactures();
  await creerFacture(ctx, { patient: '' });
  await creerFacture(ctx, { montant: '0' });
  await creerFacture(ctx, { montant: '' });
  assert.equal(ctx.state.factures.length, 0);
  assert.equal(ctx.state.nextFactureNum, 1);
});

test('nouvelle facture : un double-clic sur « Créer la facture » n’en crée qu’une', async () => {
  const ctx = bacAFactures();
  ctx.document = faireDocument({
    'f-patient': { value: '1700000000001' }, 'f-date': { value: `${ANNEE}-10-04` },
    'f-montant': { value: '60' }, 'f-statut': { value: 'payee' },
  });
  await Promise.all([ctx.saveFacture(), ctx.saveFacture()]);
  assert.equal(ctx.state.factures.length, 1, 'une facture en trop ne peut s’annuler que par un avoir');
  assert.equal(ctx.state.nextFactureNum, 2);
});

test('avoir : annule la facture, montant opposé, même série de numéros, type et nom hérités', async () => {
  const ctx = bacAFactures();
  const f = await creerFacture(ctx, { type: 'analyse_pratique', montant: '120' });
  const avoir = await emettreAvoir(ctx, f);
  assert.equal(avoir.type, 'avoir');
  assert.equal(avoir.montant, -120);
  assert.equal(avoir.numero, `FAC-${ANNEE}-0002`, 'un avoir prend le numéro suivant, sans série à part');
  assert.equal(avoir.factureOrigineId, f.id);
  assert.equal(avoir.typePrestation, 'analyse_pratique');
  assert.equal(avoir.patientNom, 'Alice Martin');
  assert.equal(f.statut, 'annulee');
});

test("avoir : motif obligatoire, pas d'avoir sur un avoir ni sur une facture déjà annulée", async () => {
  const ctx = bacAFactures();
  const f = await creerFacture(ctx);
  await emettreAvoir(ctx, f, '   ');
  assert.equal(ctx.state.factures.length, 1, 'sans motif, rien n’est émis');

  const avoir = await emettreAvoir(ctx, f);
  const ouvertures = () => ctx.appels.filter(a => a[0] === 'openModal').length;
  const avant = ouvertures();
  ctx.openAvoirModal(avoir.id);
  ctx.openAvoirModal(f.id);
  assert.equal(ouvertures(), avant, 'la fenêtre d’avoir ne s’ouvre ni pour un avoir ni pour une facture annulée');
});

test('avoir : un double-clic sur « Émettre l’avoir » n’en crée qu’un', async () => {
  const ctx = bacAFactures();
  const f = await creerFacture(ctx);
  ctx.document = faireDocument();
  ctx.openAvoirModal(f.id);
  ctx.document.getElementById('av-motif').value = 'Erreur';
  await Promise.all([ctx.saveAvoir(), ctx.saveAvoir()]);
  assert.equal(ctx.state.factures.filter(x => x.type === 'avoir').length, 1);
  assert.equal(ctx.state.nextFactureNum, 3, 'un seul numéro consommé');
});

test('numérotation : chronologique et sans trou, factures et avoirs confondus', async () => {
  const ctx = bacAFactures();
  const a = await creerFacture(ctx);
  await creerFacture(ctx, { patient: '1700000000002' });
  await emettreAvoir(ctx, a);
  await creerFacture(ctx, { montant: '0' }); // refusée
  await creerFacture(ctx);
  const seq = ctx.state.factures.map(f => f.numSeq);
  assert.deepEqual(brut(seq), [1, 2, 3, 4]);
  assert.equal(new Set(ctx.state.factures.map(f => f.numero)).size, 4, 'numéros uniques');
});

test('nom figé : une facture garde le nom imprimé, même si le dossier change ensuite', () => {
  const state = etatDeDepart();
  state.factures = [
    { id: 'f1', patientId: '1700000000001', patientNom: null },
    { id: 'f2', patientId: '1700000000002', patientNom: 'Paul Durand-Ancien' },
  ];
  const ctx = bacAFactures(state);
  ctx.figerNomsPatientsFactures();
  assert.equal(state.factures[0].patientNom, 'Alice Martin', 'anciennes factures complétées au chargement');
  assert.equal(state.factures[1].patientNom, 'Paul Durand-Ancien', 'un nom déjà figé n’est jamais réécrit');
  assert.equal(ctx.facturePatientNom(state.factures[1]), 'Paul Durand-Ancien');
});

test('suppression d’un dossier : ses factures sont conservées avec son nom, le reste est supprimé', async () => {
  const state = etatDeDepart();
  state.factures = [
    { id: 'f1', numero: 'FAC-0001', patientId: '1700000000001', patientNom: null },
    { id: 'f2', numero: 'FAC-0002', patientId: '1700000000002', patientNom: 'Paul Durand' },
    { id: 'f3', numero: 'FAC-0003', patientId: '1700000000001', patientNom: null },
  ];
  state.seances = [{ id: 's1', patientId: '1700000000001' }, { id: 's2', patientId: '1700000000002' }];
  const messages = [], cascade = [];
  const ctx = charger(['facturePatientNom', 'deleteCurrentPatient'], {
    state, _db: {}, _currentPatientId: '1700000000001',
    ask: async m => { messages.push(m); return true; },
    deletePatientCascade: async (_db, id) => { cascade.push(id); },
  });
  await ctx.deleteCurrentPatient();
  assert.deepEqual(brut(state.patients.map(p => p.id)), ['1700000000002']);
  assert.deepEqual(brut(state.factures.map(f => f.numero)), ['FAC-0001', 'FAC-0002', 'FAC-0003'], 'aucune facture supprimée');
  assert.equal(state.factures[0].patientNom, 'Alice Martin');
  assert.equal(ctx.facturePatientNom(state.factures[2]), 'Alice Martin', 'toujours lisible sans le dossier');
  assert.deepEqual(brut(state.seances.map(s => s.id)), ['s2']);
  assert.deepEqual(cascade, ['1700000000001']);
  assert.match(messages[0], /2 facture\(s\) sont conservées/);
});

test('suppression d’un dossier : rien ne change si on annule ou si la base refuse', async () => {
  for (const [ask, cascade] of [[async () => false, async () => {}], [async () => true, async () => { throw new Error('verrou'); }]]) {
    const state = etatDeDepart();
    state.factures = [{ id: 'f1', patientId: '1700000000001' }];
    const ctx = charger(['facturePatientNom', 'deleteCurrentPatient'], {
      state, _db: {}, _currentPatientId: '1700000000001', ask, deletePatientCascade: cascade,
      console: { ...console, error() {} }, // échec de base simulé : son message est attendu
    });
    await ctx.deleteCurrentPatient();
    assert.equal(state.patients.length, 2);
    assert.equal(state.factures.length, 1);
  }
});
