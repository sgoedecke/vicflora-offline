# VicFlora Offline Keys

This project lets you scrape VicFlora dichotomous (KeyBase) and multi-access (Lucid) keys for offline use, and provides lightweight CLIs to work through each key type once the data is on disk.

## Repository Overview

- `main.js` – entry point for scraping commands.
- `multi-access-scraper.js` – downloads Lucid multi-access keys and decompresses their matrices.
- `keybase-scraper-simple.js` – reads `keybase-list.html` and downloads the referenced KeyBase JSON exports.
- `vicflora-exporter.js` – writes scraped data into `vicflora-data/` (JSON + CSV summaries).
- `keying-cli-simple.js` – interactive multi-access key CLI (uses files in `vicflora-data/`).
- `keybase-cli.js` – interactive dichotomous key CLI (uses files in `keybase-data/`).

Cached data lives beside the code:

- `vicflora-data/` – multi-access keys and derived CSV exports.
- `keybase-data/` – raw KeyBase JSON exports downloaded from RBG Victoria.

## Prerequisites

```bash
npm install
```

All commands are Node scripts, so no additional tooling is required.

## Scraping Workflow

### 1. Multi-access (Lucid) keys

```bash
node main.js multi-access
```

This fetches every available Lucid bundle, decompresses the matrices, and writes:

- `vicflora-data/all-multi-access-keys.json`
- `vicflora-data/multi-access-keys-summary.csv`
- `vicflora-data/key-<id>-complete.json` plus supporting CSV exports per key

### 2. Dichotomous (KeyBase) keys

```bash
node main.js identification
```

The downloader:

1. Parses `keybase-list.html` (keep this file up to date with the KeyBase website).
2. Downloads each `https://keybase.rbg.vic.gov.au/keys/export/<id>?format=json` export into `keybase-data/<id>.json` (skipping ones you already have).
3. Stores the summarised list in `vicflora-data/keybase-keys.json` for reference.

> Tip: open `keybase-list.html` in a browser, copy the key list HTML from KeyBase, and paste it into the file before running the downloader.

### 3. Offline web app / PWA bundle

```bash
npm run build:web
```

This script gathers the keys referenced in `web/web-config.json` and produces
`web/public/data/*.json`. The `web/public/` folder is a self-contained static
site: host it from any HTTP server (or share the files directly) and the app will
install as a PWA, caching everything for offline use. Update `web/web-config.json`
to include the key IDs or filenames you want bundled, then rerun the script.

## Offline CLI usage

After scraping, you can run either CLI completely offline:

```bash
npm run key            # multi-access key navigation
npm run key:dichotomous # dichotomous key navigation
```

- `keying-cli-simple.js` lists the `key-*-complete.json` files in `vicflora-data/` and guides you through choosing character states until a small taxon set remains.
- `keybase-cli.js` starts at VicFlora key 1903 (“Key to the main groups of plants in Victoria”) and follows each `to_key` link automatically so you can progress through linked dichotomous keys without re-selecting them manually.

### Offline web app

- Host `web/public` (for example with `npx http-server web/public`) or open
  `index.html` directly. The service worker precaches the bundle so you can add it
  to your phone’s home screen and keep using it without connectivity.
- Edit `web/web-config.json` if you want to shrink or expand the bundled keys.

### Deploying to Netlify

Netlify can build and host the PWA directly from this repository. The included
`netlify.toml` config runs `npm run build:web` and publishes `web/public`. To deploy:

1. Push the repo to GitHub/GitLab/Bitbucket.
2. In Netlify, create a new site from git and select this repo.
3. Leave the build command (`npm run build:web`) and publish directory (`web/public`) as
   configured.
4. Deploy. Netlify will regenerate the data bundle during each build.

## Keeping Data Fresh

- Re-run `node main.js multi-access` whenever VicFlora publishes new Lucid key updates.
- Refresh `keybase-list.html` with the latest HTML from KeyBase and re-run `node main.js identification` to pull new dichotomous keys.
- Existing downloads are skipped, so re-running commands only fetches new content.

## npm Scripts

```bash
npm run scrape:multi          # node main.js multi-access
npm run scrape:identification # node main.js identification
npm run scrape:all            # node main.js all
npm run key                   # node keying-cli-simple.js
npm run key:dichotomous       # node keybase-cli.js
```

## License

MIT – please respect VicFlora terms of use when scraping or redistributing data.
