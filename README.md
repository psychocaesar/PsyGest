# PsyGest

Application desktop de gestion pour psychologue libéral en exercice solo.
100 % hors-ligne — aucune donnée n'est transmise à un serveur tiers.

## Fonctionnalités

- **Dossiers patients** — création, recherche, conformité RGPD
- **Facturation** — numérotation chronologique sans trou, aperçu, impression PDF
- **Agenda** — planification des séances, conversion séance → facture
- **Charges & URSSAF** — saisie des charges, estimation URSSAF (21,2 % BNC)
- **Réglages** — informations du praticien (RPPS, SIRET, adresse)
- **Export / Import** — sauvegarde JSON complète, export CSV URSSAF

## Prérequis

### Rust
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env
```

### Node.js (≥ 18)
```bash
# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# macOS (Homebrew)
brew install node
```

### Dépendances système (Linux uniquement)
```bash
# Ubuntu 22+
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-dev \
  libappindicator3-dev \
  librsvg2-dev \
  patchelf \
  libssl-dev \
  pkg-config \
  build-essential
```

### Tauri CLI
```bash
# Via npm (recommandé, déjà inclus dans devDependencies)
npx tauri --version
```

## Démarrage

```bash
# 1. Installer les dépendances Node
npm install

# 2. Lancer en mode développement
npm run tauri dev
```

Le premier lancement compile le backend Rust (~2–4 min). Les relances suivantes sont quasi-instantanées.
Au premier lancement, la page **Réglages** s'ouvre automatiquement pour saisir vos informations.

## Build de production

```bash
npm run tauri build
```

L'installateur est généré dans `src-tauri/target/release/bundle/` :
- Linux : `.deb` et `.AppImage`
- macOS : `.dmg` et `.app`

## Données

Fichier de données : `~/Documents/PsyGest/data.json`

> ⚠️ Ce fichier contient des données de santé. Ne placez **pas** ce dossier dans un
> espace synchronisé automatiquement (iCloud, Dropbox, OneDrive, Google Drive).

## Structure du projet

```
psygest/
├── src/
│   ├── index.html          # Structure HTML (sidebar, pages, modales)
│   ├── main.js             # Logique JS (stockage Tauri, navigation, CRUD)
│   ├── style.css           # Design tokens, composants, CSS print
│   └── assets/
│       └── lucide.min.js   # Icônes (bundlé localement, 100 % offline)
├── src-tauri/
│   ├── src/lib.rs          # Enregistrement des plugins Tauri
│   ├── capabilities/
│   │   └── default.json    # Permissions fs + dialog
│   ├── Cargo.toml
│   └── tauri.conf.json
├── vite.config.js
├── package.json
└── README.md
```

## Stack technique

| Couche      | Technologie                           |
|-------------|---------------------------------------|
| Desktop     | Tauri v2 (Rust)                       |
| Frontend    | HTML / CSS / JS vanilla + Vite 6      |
| Icônes      | Lucide (UMD, local — pas de CDN)      |
| Polices     | Google Fonts (Instrument Serif + DM Sans) |
| Stockage    | `@tauri-apps/plugin-fs` → JSON local  |
| Dialogues   | `@tauri-apps/plugin-dialog`           |
| PDF         | `window.print()` + CSS `@media print` |

## Notes légales et comptables

- **Numérotation des factures** : chronologique et sans trou (art. L441-3 C. commerce)
- **Exonération TVA** : art. 261-4-1° du CGI (actes psychologiques)
- **Taux URSSAF 2024** : 21,2 % du CA brut (BNC micro-entreprise, prestations libérales)
- **RGPD** : consentement patient explicite requis ; données stockées localement
