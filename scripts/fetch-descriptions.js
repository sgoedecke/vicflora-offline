#!/usr/bin/env node

// Fetches VicFlora taxon profiles (description, distribution/habitat, notes) for
// every taxon linked from the scraped KeyBase keys and stores sanitized HTML in
// vicflora-data/taxon-descriptions.json. Already-fetched taxa are skipped.
//
// Usage:
//   node scripts/fetch-descriptions.js              # all taxa
//   node scripts/fetch-descriptions.js --key 2168   # only taxa in the given key(s)
//   node scripts/fetch-descriptions.js --limit 100  # stop after N new taxa

const fs = require('fs').promises;
const path = require('path');
const fetch = require('node-fetch');

const ENDPOINT = 'https://vicflora.rbg.vic.gov.au/graphql';
const BATCH_SIZE = 50;
const REQUEST_DELAY_MS = 1000;
const TAXON_URL = /\/flora\/taxon\/([0-9a-f-]{36})/i;

const root = path.resolve(__dirname, '..');
const outPath = path.join(root, 'vicflora-data', 'taxon-descriptions.json');

function parseArgs(argv) {
  const args = { keys: [], limit: Infinity };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--key') args.keys.push(String(argv[++i]));
    else if (argv[i] === '--limit') args.limit = Number(argv[++i]);
  }
  return args;
}

async function collectTaxa(keyFilter) {
  const dir = path.join(root, 'keybase-data');
  const files = (await fs.readdir(dir)).filter(name => /^\d+\.json$/.test(name));
  const taxa = new Map();
  for (const file of files) {
    const id = file.replace(/\.json$/, '');
    if (keyFilter.length && !keyFilter.includes(id)) continue;
    const raw = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));
    const key = raw.keybase || raw;
    for (const item of key.items || []) {
      const match = item?.url && TAXON_URL.exec(item.url);
      if (match && !taxa.has(match[1])) taxa.set(match[1], item.item_name);
    }
  }
  return taxa;
}

const ALLOWED_TAGS = new Set(['p', 'div', 'span', 'em', 'i', 'strong', 'b', 'br', 'sup', 'sub', 'ul', 'ol', 'li', 'a']);
const ALLOWED_ATTRS = new Set(['class', 'title']);

// Keep a small whitelist of formatting tags. Links to other taxa become
// data-taxon attributes so the app can open them offline.
function sanitizeProfile(html) {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/?([a-z0-9]+)([^>]*)>/gi, (tag, name, attrs) => {
      const lower = name.toLowerCase();
      if (!ALLOWED_TAGS.has(lower)) return '';
      if (tag.startsWith('</')) return `</${lower}>`;
      const kept = [];
      for (const [, attr, value] of attrs.matchAll(/([a-z-]+)\s*=\s*"([^"]*)"/gi)) {
        const attrName = attr.toLowerCase();
        if (ALLOWED_ATTRS.has(attrName)) kept.push(`${attrName}="${value}"`);
        if (lower === 'a' && attrName === 'href') {
          const match = TAXON_URL.exec(value);
          if (match) kept.push(`data-taxon="${match[1]}"`);
        }
      }
      return `<${lower}${kept.length ? ` ${kept.join(' ')}` : ''}>`;
    })
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function fetchBatch(ids) {
  const fields = ids
    .map(
      (id, index) => `t${index}: taxonConcept(id: "${id}") {
        id
        taxonRank
        taxonName { fullName }
        preferredVernacularName { name }
        currentProfile { profile }
      }`
    )
    .join('\n');

  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'vicflora-offline' },
        body: JSON.stringify({ query: `{ ${fields} }` })
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      return Object.values(body.data || {});
    } catch (error) {
      if (attempt >= 3) throw error;
      console.warn(`Retrying batch (${attempt}/3): ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let store = { taxa: {} };
  try {
    store = JSON.parse(await fs.readFile(outPath, 'utf8'));
  } catch {
    // First run.
  }

  const taxa = await collectTaxa(args.keys);
  const todo = [...taxa.keys()].filter(id => !(id in store.taxa)).slice(0, args.limit);
  console.log(`${taxa.size} taxa referenced, ${todo.length} to fetch.`);

  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    const ids = todo.slice(i, i + BATCH_SIZE);
    const results = await fetchBatch(ids);
    ids.forEach((id, index) => {
      const taxon = results[index];
      const profile = taxon?.currentProfile?.profile;
      store.taxa[id] = {
        name: taxon?.taxonName?.fullName || taxa.get(id),
        rank: taxon?.taxonRank || null,
        vernacular: taxon?.preferredVernacularName?.name || null,
        html: profile ? sanitizeProfile(profile) : null
      };
    });
    store.generatedAt = new Date().toISOString();
    await fs.writeFile(outPath, JSON.stringify(store));
    console.log(`Fetched ${Math.min(i + BATCH_SIZE, todo.length)}/${todo.length}`);
    await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY_MS));
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('Error fetching descriptions:', error.message);
    process.exit(1);
  });
}

module.exports = { sanitizeProfile };
