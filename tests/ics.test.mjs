// Import iCal (Doctolib, cal.com…) : lecture du flux, filtre des événements perso,
// rattachement aux dossiers patients, suivi des déplacements et des annulations.
process.env.TZ = 'Europe/Paris';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { charger, brut } from './harness.mjs';

const MAINTENANT = '2026-11-06T10:00:00Z';
const Horloge = class extends Date {
  constructor(...a) { if (a.length) super(...a); else super(MAINTENANT); }
  static now() { return new Date(MAINTENANT).getTime(); }
};

function calendrier(...evenements) {
  const lignes = ['BEGIN:VCALENDAR'];
  for (const e of evenements) {
    lignes.push('BEGIN:VEVENT', `UID:${e.uid}`,
      `DTSTART;TZID=Europe/Paris:${e.debut}`, `DTEND;TZID=Europe/Paris:${e.fin || e.debut}`,
      `SUMMARY:${e.titre}`, ...(e.lignes || []), 'END:VEVENT');
  }
  lignes.push('END:VCALENDAR');
  return lignes.join('\r\n');
}

const PATIENTS = [
  { id: 'p1', prenom: 'Jean-Pierre', nom: 'Dupont' },
  { id: 'p2', prenom: 'Élodie', nom: 'Lefèvre' },
  { id: 'p3', prenom: 'Marie', nom: 'Martin' },
  { id: 'p4', prenom: 'Marie-Anne', nom: 'Martin' },
  { id: 'p5', prenom: 'Jean', nom: 'Dupont' },
];

function bac(state = {}) {
  const ctx = charger([
    'ymd', 'today', 'icsLocalDateTime', 'parseICS', 'icsMotsCles', 'icsEvenementRetenu',
    'nomEnMots', 'patientPourEvenement', 'seanceSuitLeCalendrier', 'importICSEvents',
  ], {
    Date: Horloge,
    state: { patients: PATIENTS, seances: [], settings: { icsFiltre: 'doctolib, cal.com', dureeConsultation: 50 }, ...state },
  });
  ctx.importer = (texte, opts) => ctx.importICSEvents(ctx.parseICS(texte), opts);
  ctx.seance = uid => ctx.state.seances.find(s => s.uid === uid);
  return ctx;
}

test('lecture : lignes repliées, description, organisateur et statut', () => {
  const { parseICS } = bac();
  const [ev] = parseICS([
    'BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:a1',
    'DTSTART:20271004T120000Z', 'DTEND:20271004T125000Z',
    'SUMMARY:Prise d\'informations',
    'DESCRIPTION:Patient : Élodie Lefèvre\\, via le site',
    'ORGANIZER;CN=Cal.com:mailto:no-reply@ca', ' l.com',
    'STATUS:CANCELLED', 'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n'));
  assert.equal(ev.date, '2027-10-04');
  assert.equal(ev.heure, '14:00', 'UTC converti en heure de Paris');
  assert.equal(ev.duree, 50);
  assert.equal(ev.description, 'Patient : Élodie Lefèvre, via le site');
  assert.equal(ev.status, 'CANCELLED');
  assert.match(ev.raw, /cal\.com/i, 'ligne repliée recollée');
});

test('filtre : ne garde que les événements contenant un mot-clé ; vide = tout', () => {
  const { icsMotsCles, icsEvenementRetenu } = bac();
  const mots = icsMotsCles(' Doctolib, cal.com ,');
  assert.deepEqual(brut(mots), ['doctolib', 'cal.com']);
  assert.equal(icsEvenementRetenu({ raw: 'SUMMARY:Alice\nDESCRIPTION:RDV Doctolib' }, mots), true);
  assert.equal(icsEvenementRetenu({ raw: 'ORGANIZER;CN=Cal.com:mailto:x' }, mots), true);
  assert.equal(icsEvenementRetenu({ raw: 'SUMMARY:Dîner chez Marie' }, mots), false);
  assert.equal(icsEvenementRetenu({ raw: 'SUMMARY:Dîner chez Marie' }, icsMotsCles('')), true);
});

test('rattachement : prénom + nom dans le titre, accents et ordre indifférents, nom le plus complet', () => {
  const { patientPourEvenement } = bac();
  const p = note => patientPourEvenement({ note }, PATIENTS);
  assert.equal(p('Jean-Pierre DUPONT'), 'p1', 'Jean-Pierre plutôt que Jean');
  assert.equal(p('Consultation — LEFEVRE Elodie'), 'p2');
  assert.equal(p('Marie Martin'), 'p3');
  assert.equal(p('Marie-Anne Martin'), 'p4');
  assert.equal(p('Dîner chez Marie'), null, 'un prénom seul ne suffit pas');
  assert.equal(p('Martine Dupontel'), null, 'mots entiers seulement');
  assert.equal(patientPourEvenement({ note: 'RDV', description: 'Patient : Élodie Lefèvre' }, PATIENTS), 'p2', 'repli sur la description');
});

test('rattachement : deux homonymes → rien plutôt que le mauvais dossier', () => {
  const { patientPourEvenement } = bac();
  const homonymes = [...PATIENTS, { id: 'x', prenom: 'Paul', nom: 'Durand' }, { id: 'y', prenom: 'Paul', nom: 'Durand' }];
  assert.equal(patientPourEvenement({ note: 'Paul Durand' }, homonymes), null);
});

test('import : filtre, rattachement, identifiants distincts, et un second passage ne refait rien', async () => {
  const ctx = bac();
  const flux = calendrier(
    { uid: 'u1', debut: '20271004T100000', fin: '20271004T105000', titre: 'Marie Martin', lignes: ['DESCRIPTION:Doctolib'] },
    { uid: 'u2', debut: '20271004T120000', titre: 'Paul Inconnu', lignes: ['ORGANIZER;CN=Cal.com:mailto:x@cal.com'] },
    { uid: 'u3', debut: '20271005T190000', titre: 'Dîner chez Marie' },
  );
  await ctx.importer(flux, { depuisFlux: true });
  assert.deepEqual(brut(ctx.state.seances.map(s => [s.uid, s.patientId, s.heure])),
    [['u1', 'p3', '10:00'], ['u2', null, '12:00']], 'le dîner perso est écarté');
  assert.equal(new Set(ctx.state.seances.map(s => s.id)).size, 2, 'deux séances, deux identifiants');
  assert.match(ctx.state.seances[0].id, /^\d+$/, 'identifiant numérique (passé sans guillemets à certains onclick)');

  await ctx.importer(flux, { depuisFlux: true });
  assert.equal(ctx.state.seances.length, 2);
});

test('import : un dossier créé après le rendez-vous est rattaché au passage suivant, sans écraser un lien manuel', async () => {
  const ctx = bac({ patients: [] });
  const flux = calendrier(
    { uid: 'u1', debut: '20271004T100000', titre: 'Marie Martin', lignes: ['DESCRIPTION:Doctolib'] },
    { uid: 'u2', debut: '20271004T110000', titre: 'Élodie Lefèvre', lignes: ['DESCRIPTION:Doctolib'] },
  );
  await ctx.importer(flux, { depuisFlux: true });
  ctx.seance('u2').patientId = 'lien-manuel';
  ctx.state.patients = PATIENTS;
  await ctx.importer(flux, { depuisFlux: true });
  assert.equal(ctx.seance('u1').patientId, 'p3');
  assert.equal(ctx.seance('u2').patientId, 'lien-manuel');
});

test('suivi : déplacement, annulation explicite, retrait du calendrier ; séance déjà traitée intouchable', async () => {
  const ctx = bac();
  const d = 'DESCRIPTION:Doctolib';
  await ctx.importer(calendrier(
    { uid: 'deplace', debut: '20271004T100000', fin: '20271004T105000', titre: 'Marie Martin', lignes: [d] },
    { uid: 'annule', debut: '20271004T120000', titre: 'Élodie Lefèvre', lignes: [d] },
    { uid: 'retire', debut: '20271005T090000', titre: 'Jean-Pierre Dupont', lignes: [d] },
    { uid: 'present', debut: '20271006T090000', titre: 'Marie Martin', lignes: [d] },
    { uid: 'passe', debut: '20260901T090000', titre: 'Marie Martin', lignes: [d] },
  ), { depuisFlux: true });
  ctx.seance('present').statut = 'present';

  await ctx.importer(calendrier(
    { uid: 'deplace', debut: '20271004T110000', fin: '20271004T120000', titre: 'Marie Martin', lignes: [d] },
    { uid: 'annule', debut: '20271004T120000', titre: 'Élodie Lefèvre', lignes: [d, 'STATUS:CANCELLED'] },
    { uid: 'present', debut: '20271006T140000', titre: 'Marie Martin', lignes: [d] },
    { uid: 'nouveau-annule', debut: '20271007T090000', titre: 'Marie Martin', lignes: [d, 'STATUS:CANCELLED'] },
  ), { depuisFlux: true });

  assert.equal(ctx.seance('deplace').heure, '11:00');
  assert.equal(ctx.seance('deplace').duree, 60);
  assert.equal(ctx.seance('annule').statut, 'annule');
  assert.equal(ctx.seance('retire').statut, 'annule', 'retiré du flux = annulé');
  assert.equal(ctx.seance('present').statut, 'present');
  assert.equal(ctx.seance('present').heure, '09:00', 'une séance marquée présente ne bouge plus');
  assert.equal(ctx.seance('passe').statut, undefined, 'une séance passée retirée du flux n’est pas annulée');
  assert.equal(ctx.seance('nouveau-annule'), undefined, 'un rendez-vous déjà annulé n’est pas importé');
});

test('suivi : rien n’est annulé depuis un fichier .ics, ni si le flux est un autre calendrier', async () => {
  const d = 'DESCRIPTION:Doctolib';
  const initial = calendrier(
    { uid: 'a', debut: '20271004T100000', titre: 'Marie Martin', lignes: [d] },
    { uid: 'b', debut: '20271005T100000', titre: 'Marie Martin', lignes: [d] },
  );
  const extrait = calendrier({ uid: 'a', debut: '20271004T100000', titre: 'Marie Martin', lignes: [d] });
  const autreCalendrier = calendrier({ uid: 'z', debut: '20271008T100000', titre: 'Marie Martin', lignes: [d] });

  const fichier = bac();
  await fichier.importer(initial, { depuisFlux: true });
  await fichier.importer(extrait); // import manuel d'un fichier : peut n'être qu'un extrait
  assert.equal(fichier.seance('b').statut, undefined);

  const autre = bac();
  await autre.importer(initial, { depuisFlux: true });
  await autre.importer(autreCalendrier, { depuisFlux: true }); // URL changée
  assert.equal(autre.seance('a').statut, undefined);
  assert.equal(autre.seance('b').statut, undefined);
});

test('suivi : un mot-clé retiré du filtre n’annule pas les rendez-vous qu’il écarte désormais', async () => {
  const ctx = bac();
  const flux = calendrier(
    { uid: 'doc', debut: '20271004T100000', titre: 'Marie Martin', lignes: ['DESCRIPTION:Doctolib'] },
    { uid: 'cal', debut: '20271005T100000', titre: 'Élodie Lefèvre', lignes: ['ORGANIZER;CN=Cal.com:mailto:x'] },
  );
  await ctx.importer(flux, { depuisFlux: true });
  ctx.state.settings.icsFiltre = 'doctolib';
  await ctx.importer(flux, { depuisFlux: true });
  assert.equal(ctx.seance('cal').statut, undefined);
});
