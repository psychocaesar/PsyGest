// CA et cotisations (régime réel BNC) : le CA se compte hors taxes, les cotisations
// s'estiment sur le bénéfice (CA − charges), jamais sur le CA, et jamais en négatif.
// On fait tourner les vraies fonctions d'affichage (page Charges & URSSAF, tableau de
// bord) avec un faux document, puis on lit ce qu'elles affichent.
process.env.TZ = 'Europe/Paris'; // PsyGest est conçu pour un cabinet en France

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { charger, faireDocument } from './harness.mjs';

const ANNEE = new Date().getFullYear();
const MOIS = String(new Date().getMonth() + 1).padStart(2, '0');

function facture(montant, extra = {}) {
  return { id: String(Math.random()), numero: 'FAC', patientId: 'p1', patientNom: 'Alice Martin',
    date: `${ANNEE}-${MOIS}-01`, montant, statut: 'payee', type: 'facture', typePrestation: 'soin', ...extra };
}

function afficher({ factures = [], charges = [], settings = { tauxUrssaf: 42 } } = {}) {
  const state = { patients: [{ id: 'p1', prenom: 'Alice', nom: 'Martin' }], factures, charges, seances: [], settings };
  const ctx = charger([
    'TAUX_TVA_ANALYSE_PRATIQUE', 'factureMontants', 'facturePatientNom', 'urssafRate', 'estRecette',
    'formatAmount', 'formatDate', 'escapeHtml', 'factureBadge', 'catLabels', 'refreshCharges', 'refreshDashboard',
  ], { state });
  ctx.document = faireDocument();
  ctx.refreshCharges();
  ctx.refreshDashboard();
  const txt = id => ctx.document.getElementById(id).textContent;
  return { ctx, txt, euros: n => ctx.formatAmount(n) };
}

test('cotisations = taux × bénéfice (CA − charges), pas × CA', () => {
  const { txt, euros } = afficher({
    factures: [facture(1000)],
    charges: [{ id: 'c1', desc: 'Loyer', montant: 400, cat: 'loyer', date: `${ANNEE}-${MOIS}-01` }],
  });
  assert.equal(txt('charges-ca'), euros(1000));
  assert.equal(txt('charges-urssaf'), euros(252), '42 % de 600');
  assert.equal(txt('charges-net'), euros(348));
  assert.equal(txt('urssaf-montant'), euros(252) + ' provisionnés', 'même montant sur le tableau de bord');
});

test('charges supérieures au CA : cotisations à zéro, jamais négatives', () => {
  const { txt, euros } = afficher({
    factures: [facture(300)],
    charges: [{ id: 'c1', desc: 'Loyer', montant: 800, cat: 'loyer', date: `${ANNEE}-${MOIS}-01` }],
  });
  assert.equal(txt('charges-urssaf'), euros(0));
  assert.equal(txt('charges-net'), euros(-500));
});

test('le CA est hors taxes : la TVA des analyses de pratiques n’est pas un revenu', () => {
  const { txt, euros } = afficher({
    factures: [facture(75), facture(60, { typePrestation: 'analyse_pratique' })],
  });
  assert.equal(txt('charges-ca'), euros(125), '75 + 50 HT, pas 135');
  assert.equal(txt('kpi-ca'), euros(125));
  assert.equal(txt('charges-urssaf'), euros(52.5));
});

test('taux personnalisé dans les Réglages, 42 % par défaut', () => {
  assert.equal(afficher({ factures: [facture(1000)], settings: { tauxUrssaf: 30 } }).txt('charges-urssaf'),
    afficher().euros(300));
  assert.equal(afficher({ factures: [facture(1000)], settings: {} }).txt('charges-urssaf'),
    afficher().euros(420));
});

test('une facture en attente de paiement ne compte pas dans le CA', () => {
  const { txt, euros } = afficher({ factures: [facture(60), facture(80, { statut: 'en_attente' })] });
  assert.equal(txt('charges-ca'), euros(60));
  assert.equal(txt('kpi-impayees'), 1);
});

test('avoir sur une facture payée : le CA revient à zéro, il ne devient pas négatif', () => {
  const origine = facture(60, { id: 'f1', statut: 'annulee' });
  const avoir = facture(-60, { id: 'f2', type: 'avoir', statut: 'payee', factureOrigineId: 'f1' });
  const { txt, euros } = afficher({ factures: [origine, avoir] });
  assert.equal(txt('charges-ca'), euros(0));
  assert.equal(txt('kpi-ca'), euros(0));
  assert.equal(txt('kpi-seances'), 0, 'ni la facture annulée ni l’avoir ne sont des séances facturées');
});

test('avoir sur une facture impayée : ni CA négatif, ni impayé fantôme', () => {
  const origine = facture(60, { id: 'f1', statut: 'annulee' });
  const avoir = facture(-60, { id: 'f2', type: 'avoir', statut: 'payee', factureOrigineId: 'f1' });
  const { txt, euros } = afficher({ factures: [origine, avoir, facture(90)] });
  assert.equal(txt('charges-ca'), euros(90));
  assert.equal(txt('kpi-impayees'), 0);
});
