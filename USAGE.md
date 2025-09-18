# Offline Usage Guide

## 1. Scrape the data (only when you need to refresh)

```bash
npm run scrape:multi          # multi-access keys into vicflora-data/
npm run scrape:identification # KeyBase exports into keybase-data/
```

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
