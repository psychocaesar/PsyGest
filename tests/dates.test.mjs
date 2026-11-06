// Dates : PsyGest raisonne en jour local (Europe/Paris). toISOString() est en UTC et
// donnait la veille entre minuit et 1 h (2 h en été) — y compris pour la date d'une facture.
process.env.TZ = 'Europe/Paris';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { charger } from './harness.mjs';

// Horloge figée : `new Date()` sans argument renvoie l'instant donné.
const horloge = iso => class extends Date {
  constructor(...a) { if (a.length) super(...a); else super(iso); }
  static now() { return new Date(iso).getTime(); }
};

const bac = maintenant => charger(['ymd', 'today', 'jourLocal', 'icsLocalDateTime'], maintenant ? { Date: horloge(maintenant) } : {});

test('today() à 0 h 30 heure de Paris donne bien le jour même (hiver et été)', () => {
  assert.equal(bac('2026-11-06T23:30:00Z').today(), '2026-11-07', '00:30 le 7/11 en hiver (UTC+1)');
  assert.equal(bac('2027-07-14T22:30:00Z').today(), '2027-07-15', '00:30 le 15/07 en été (UTC+2)');
  assert.equal(bac('2027-07-14T21:30:00Z').today(), '2027-07-14', '23:30 le 14/07 : encore la veille');
});

test('jourLocal() : un horodatage UTC est ramené au jour de Paris, une date seule ne bouge pas', () => {
  const { jourLocal } = bac();
  assert.equal(jourLocal('2026-11-06T23:30:00.000Z'), '2026-11-07');
  assert.equal(jourLocal('2026-11-06T12:00:00.000Z'), '2026-11-06');
  assert.equal(jourLocal('2026-09-12'), '2026-09-12');
  assert.equal(jourLocal(''), '');
  assert.equal(jourLocal(null), null);
});

test('iCal : horaire UTC converti en heure de Paris (été comme hiver), heure locale lue telle quelle', () => {
  const { icsLocalDateTime } = bac();
  const brut = o => ({ ...o });
  assert.deepEqual(brut(icsLocalDateTime('20270614', '093000', true)), { date: '2027-06-14', heure: '11:30' });
  assert.deepEqual(brut(icsLocalDateTime('20271214', '104500', true)), { date: '2027-12-14', heure: '11:45' });
  assert.deepEqual(brut(icsLocalDateTime('20271231', '233000', true)), { date: '2028-01-01', heure: '00:30' }, 'changement de jour et d’année');
  assert.deepEqual(brut(icsLocalDateTime('20271004', '100000', false)), { date: '2027-10-04', heure: '10:00' });
});
