# VicFlora Offline Keys

https://imaginative-panda-8c7f64.netlify.app/

VicFlora offers multiple keys to let you identify plants. But the website is pretty slow, and sometimes you're looking at plants where you don't have reception. What if there was a way to use the VicFlora keys without any internet at all?

This project imports the VicFlora keys (both dichotomous and multi-access) and hosts them in a self-contained SPA website that can be saved to your mobile home screen for offline use.

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

#### Bryophyte keys and other manual additions

Some Lucid keys (notably the bryophyte suite) are not exposed through the
VicFlora GraphQL feed. The scraper merges two data sources:

1. `multiAccessKeys` returned by GraphQL.
2. A local fallback list in `vicflora-data/manual-multi-access-keys.json`.

If a key you need isn’t in the GraphQL list, add an entry to
`manual-multi-access-keys.json` with the Lucid bundle URL, for example:

```json
[
  {
    "id": "hornworts-thallose-liverworts",
    "title": "Multi-access key to the hornworts and thallose liverworts of Victoria",
    "location": "https://vicflora-cdn.rbg.vic.gov.au/lucid-keys/thallose-liverworts-and-hornworts.js"
  }
]
```

You can find the CDN URLs by opening the key on VicFlora and watching the
network pane for `https://vicflora-cdn.rbg.vic.gov.au/lucid-keys/*.js` requests.
The scraper automatically tolerates UTF-16 Lucid bundles, so once the entry is
present the next `node main.js multi-access` run will pull it in.

### 2. Dichotomous (KeyBase) keys

```bash
node main.js identification
```

The downloader:

1. Parses `keybase-list.html`. Keep this file synchronised with the HTML list at
   <https://keybase.rbg.vic.gov.au/projects/show/10> (the Flora of Victoria project).
   Copy the `<div id="list">…</div>` markup from the site and paste it into
   `keybase-list.html` before you run the script.
2. Downloads each `https://keybase.rbg.vic.gov.au/keys/export/<id>?format=json`
   export into `keybase-data/<id>.json` (skipping ones that are already saved).
3. Stores the summarised list in `vicflora-data/keybase-keys.json` for reference.

### 3. Offline web app / PWA bundle

```bash
npm run build:web
```

This script gathers the keys referenced in `web/web-config.json`, automatically
pulls in any linked `to_key` chains, and writes `web/public/data/*.json`. The
`web/public/` folder is a self-contained static site: host it from any HTTP
server (or share the files directly) and the app will install as a PWA, caching
everything for offline use. Update `web/web-config.json` to choose the seed keys
you want bundled, then rerun the script.

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

I'm not 100% sure what VicFlora's terms of use are for their key data. I assume it falls under "text" [here](https://vicflora.rbg.vic.gov.au/pages/copyright), which would make it CC BY 4.0. All the data is pulled via public APIs and "export" buttons.

VicFlora (2025). Flora of Victoria, Royal Botanic Gardens Victoria. Available online: https://vicflora.rbg.vic.gov.au (accessed on: 18 Sep. 2025).
