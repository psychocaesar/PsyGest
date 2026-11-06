// Charge de vraies fonctions de src/main.js dans un bac à sable node:vm, sans Tauri ni
// navigateur. main.js est un module qui démarre l'app (SQLite, DOM) dès son chargement :
// on n'en extrait donc que les déclarations nécessaires, par leur nom, et on fournit
// des doublures pour le reste (state, document, saveState…). Si une fonction est
// renommée ou supprimée, extraire() échoue : le test le signale au lieu de passer à vide.
import fs from 'node:fs';
import vm from 'node:vm';

const SRC = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

// Avance après un littéral (chaîne, gabarit, regex) ou un commentaire commençant en i.
// Renvoie l'index juste après, ou -1 si i n'en commence pas un.
function sauterLitteral(s, i, precedent) {
  const c = s[i];
  if (c === '/' && s[i + 1] === '/') return s.indexOf('\n', i) + 1 || s.length;
  if (c === '/' && s[i + 1] === '*') return s.indexOf('*/', i + 2) + 2;
  if (c === '"' || c === "'") {
    for (let j = i + 1; j < s.length; j++) {
      if (s[j] === '\\') j++;
      else if (s[j] === c) return j + 1;
    }
  }
  if (c === '`') {
    for (let j = i + 1; j < s.length; j++) {
      if (s[j] === '\\') j++;
      else if (s[j] === '`') return j + 1;
      else if (s[j] === '$' && s[j + 1] === '{') j = finBloc(s, j + 1) - 1;
    }
  }
  // Regex : un « / » là où une expression peut commencer.
  if (c === '/' && (precedent === undefined || '(,=:[!&|?{};+-*%<>~^'.includes(precedent))) {
    let classe = false;
    for (let j = i + 1; j < s.length; j++) {
      if (s[j] === '\\') j++;
      else if (s[j] === '[') classe = true;
      else if (s[j] === ']') classe = false;
      else if (s[j] === '/' && !classe) {
        while (/[a-z]/i.test(s[j + 1])) j++;
        return j + 1;
      }
      else if (s[j] === '\n') break;
    }
  }
  return -1;
}

// Index juste après l'accolade fermante qui correspond à celle en position i.
function finBloc(s, i) {
  let depth = 0, precedent;
  while (i < s.length) {
    const apres = sauterLitteral(s, i, precedent);
    if (apres > i) { i = apres; precedent = 'x'; continue; }
    const c = s[i];
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
    if (!/\s/.test(c)) precedent = c;
    i++;
  }
  throw new Error('Accolade non fermée');
}

// Fin d'une instruction `const X = …;` : le premier « ; » hors parenthèses/accolades.
function finInstruction(s, i) {
  let depth = 0, precedent;
  while (i < s.length) {
    const apres = sauterLitteral(s, i, precedent);
    if (apres > i) { i = apres; precedent = 'x'; continue; }
    const c = s[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ';' && depth === 0) return i + 1;
    if (!/\s/.test(c)) precedent = c;
    i++;
  }
  throw new Error('Instruction non terminée');
}

// Index juste après la parenthèse fermante qui correspond à celle en position i.
function finParentheses(s, i) {
  let depth = 0, precedent;
  while (i < s.length) {
    const apres = sauterLitteral(s, i, precedent);
    if (apres > i) { i = apres; precedent = 'x'; continue; }
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i + 1;
    if (!/\s/.test(c)) precedent = c;
    i++;
  }
  throw new Error('Parenthèse non fermée');
}

export function extraire(nom) {
  const fn = new RegExp(`^(async )?function ${nom}\\(`, 'm').exec(SRC);
  if (fn) {
    // Le corps commence après les paramètres, qui peuvent contenir des accolades
    // (déstructuration : `function f({ silent = false } = {})`).
    const finParams = finParentheses(SRC, fn.index + fn[0].length - 1);
    return SRC.slice(fn.index, finBloc(SRC, SRC.indexOf('{', finParams)));
  }
  // `var` plutôt que `const` : seules les déclarations var/function deviennent des
  // propriétés du contexte, lisibles depuis le test.
  const decl = new RegExp(`^(const|let) ${nom} =`, 'm').exec(SRC);
  if (decl) return 'var' + SRC.slice(decl.index + decl[1].length, finInstruction(SRC, decl.index));
  throw new Error(`Introuvable dans src/main.js : ${nom}`);
}

// Document factice : chaque id renvoie toujours le même élément, créé à la demande,
// avec les valeurs de départ fournies (ex. { 'f-montant': { value: '60' } }).
export function faireDocument(valeurs = {}) {
  const elements = {};
  return {
    elements,
    getElementById(id) {
      if (!elements[id]) {
        elements[id] = {
          id, value: '', textContent: '', innerHTML: '', checked: false,
          style: {}, classList: { add() {}, remove() {}, contains: () => false },
          ...(valeurs[id] || {}),
        };
      }
      return elements[id];
    },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

// Interface de l'app neutralisée : ces fonctions touchent au DOM ou à SQLite et ne
// font pas partie de ce qu'on teste.
const UI_NEUTRE = [
  'saveState', 'closeModal', 'openModal', 'toast', 'refreshSidebarCounts', 'refreshDashboard',
  'renderFactures', 'renderPatientInfos', 'renderAgenda', 'navigate', 'updateFactureTvaHint',
];

// Crée un bac à sable avec les déclarations `noms` extraites de main.js.
// `globaux` fournit l'état et les doublures (state, document, ask…).
export function charger(noms, globaux = {}) {
  const appels = [];
  const neutres = Object.fromEntries(UI_NEUTRE.map(n => [n, (...args) => { appels.push([n, ...args]); }]));
  const ctx = vm.createContext({
    console, appels,
    lucide: { createIcons() {} },
    document: faireDocument(),
    ...neutres,
    ...globaux,
  });
  vm.runInContext(noms.map(extraire).join('\n\n'), ctx, { filename: 'src/main.js (extraits)' });
  return ctx;
}

// Recopie une valeur du bac à sable dans le contexte du test : les tableaux et objets
// créés dans vm n'ont pas les mêmes prototypes, ce qui fausse assert.deepStrictEqual.
export const brut = v => JSON.parse(JSON.stringify(v));
