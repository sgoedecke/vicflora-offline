# Offline Usage Guide

## 1. Scrape the data (only when you need to refresh)

```bash
npm run scrape:multi          # multi-access keys into vicflora-data/
npm run scrape:identification # KeyBase exports into keybase-data/
```

If a Lucid key is missing from the VicFlora API (e.g. the bryophyte suite), add
its CDN metadata to `vicflora-data/manual-multi-access-keys.json` before
running `npm run scrape:multi`. Each entry needs an `id`, `title`, and
`location` (the `https://vicflora-cdn.rbg.vic.gov.au/lucid-keys/*.js` URL).

Before running `npm run scrape:identification`, make sure `keybase-list.html` contains the latest list of keys from https://keybase.rbg.vic.gov.au/keys/list. Paste the `<div id="list">...</div>` HTML into the file and the downloader will do the rest.

## 2. Explore keys offline

### Multi-access keys (Lucid)

```bash
npm run key
```

1. Pick a key from the list of `key-*-complete.json` files.
2. Choose observable character states in any order.
3. Watch the candidate taxa shrink until you reach a single match (or a small shortlist).

### Dichotomous keys (KeyBase)

```bash
npm run key:dichotomous
```

1. The CLI loads key `1903` (“Key to the main groups of plants in Victoria”).
2. Select the lead that matches your specimen.
3. When a lead points to another key (e.g. “Dicotyledons”), the CLI automatically loads it so you can keep going without restarting.
4. Continue until you reach a terminal taxon. Use `b`, `r`, or `q` to backtrack, restart, or quit.

## Data directories

- `vicflora-data/`: all multi-access key exports, CSV summaries, and the `keybase-keys.json` list.
- `keybase-data/`: raw KeyBase JSON exports, one file per key ID.

Keep both folders if you want the CLIs to function without an internet connection.

## 3. Progressive Web App (PWA)

```bash
npm run build:web
```

- Open the generated `web/public/index.html` (or host the folder).
- The app will prompt the browser to cache assets for offline use. On iOS, use “Add to Home Screen”.
- Adjust `web/web-config.json` before building to choose which seed keys ship with the bundle.
- The build step automatically loads any linked `to_key` references reachable from those seeds.
- Deploying via Netlify? The provided `netlify.toml` already points Netlify at the correct
  build command and publish directory—just hook up the repo and deploy.
