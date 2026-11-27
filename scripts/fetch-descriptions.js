#!/usr/bin/env node

// Fetches VicFlora taxon profiles (description, distribution/habitat, notes) for
// every taxon linked from the scraped KeyBase keys, multi-access keys, accepted
// infraspecific children of species, and accepted taxa cross-referenced inside
// descriptions, storing sanitized HTML in vicflora-data/taxon-descriptions.json.
// Already-fetched taxa are skipped.
//
// Usage:
//   node scripts/fetch-descriptions.js              # all taxa
//   node scripts/fetch-descriptions.js --key 2168   # only taxa in the given key(s)
//   node scripts/fetch-descriptions.js --limit 100  # stop after N new taxa

const fs = require('fs').promises;
const path = require('path');

const { summarizeTaxonBioregions } = require('./fetch-bioregions');

const ENDPOINT = 'https://vicflora.rbg.vic.gov.au/graphql';
const BATCH_SIZE = 50;
const CHILDREN_BATCH_SIZE = 100;
const REQUEST_DELAY_MS = 500;
const TAXON_URL = /\/flora\/taxon\/([0-9a-f-]{36})/i;
const INFRASPECIFIC_RANKS = new Set(['SUBSPECIES', 'VARIETY', 'FORM']);

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

function taxonIdFromUrl(url) {
  const match = typeof url === 'string' && TAXON_URL.exec(url);
  return match ? match[1] : null;
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
    const scopeId = taxonIdFromUrl(key.taxonomic_scope?.url);
    if (scopeId && !taxa.has(scopeId)) {
      taxa.set(scopeId, key.taxonomic_scope.item_name || null);
    }
    for (const item of key.items || []) {
      const itemId = taxonIdFromUrl(item?.url);
      if (itemId && !taxa.has(itemId)) taxa.set(itemId, item.item_name);
    }
  }

  if (!keyFilter.length) {
    const multiDir = path.join(root, 'vicflora-data');
    const multiFiles = (await fs.readdir(multiDir)).filter(
      name => name.startsWith('key-') && name.endsWith('-complete.json')
    );
    for (const file of multiFiles) {
      const key = JSON.parse(await fs.readFile(path.join(multiDir, file), 'utf8'));
      for (const entity of key.entities || []) {
        const profileEntry = entity.text?.find(
          item => typeof item?.path === 'string' && item.path.includes('/flora/taxon/')
        );
        const entityId = taxonIdFromUrl(entity.url || profileEntry?.path);
        if (entityId && !taxa.has(entityId)) taxa.set(entityId, entity.name || null);
      }
    }
  }

  return taxa;
}

function collectLinkedTaxonIds(taxaStore) {
  const ids = new Set();
  for (const entry of Object.values(taxaStore)) {
    if (!entry?.html) continue;
    for (const match of entry.html.matchAll(/data-taxon="([0-9a-f-]{36})"/gi)) {
      ids.add(match[1]);
    }
  }
  return ids;
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

async function queryGraphQL(query) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'vicflora-offline' },
        body: JSON.stringify({ query })
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      return body.data || {};
    } catch (error) {
      if (attempt >= 3) throw error;
      console.warn(`Retrying batch (${attempt}/3): ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
    }
  }
}

async function fetchBatch(ids) {
  const fields = ids
    .map(
      (id, index) => `t${index}: taxonConcept(id: "${id}") {
        id
        taxonRank
        taxonomicStatus
        taxonName { fullName }
        preferredVernacularName { name }
        currentProfile { profile }
        bioregions { bioregionCode occurrenceStatus establishmentMeans }
      }`
    )
    .join('\n');

  const data = await queryGraphQL(`{ ${fields} }`);
  return ids.map((_, index) => data[`t${index}`] || null);
}

async function fetchAcceptedChildren(speciesIds) {
  const children = new Map();
  for (let i = 0; i < speciesIds.length; i += CHILDREN_BATCH_SIZE) {
    const batch = speciesIds.slice(i, i + CHILDREN_BATCH_SIZE);
    const fields = batch
      .map(
        (id, index) => `t${index}: taxonConcept(id: "${id}") {
          children {
            id
            taxonRank
            taxonomicStatus
            taxonName { fullName }
          }
        }`
      )
      .join('\n');
    const data = await queryGraphQL(`{ ${fields} }`);
    for (const parent of Object.values(data)) {
      for (const child of parent?.children || []) {
        if (child?.id && child.taxonomicStatus === 'ACCEPTED' && INFRASPECIFIC_RANKS.has(child.taxonRank)) {
          children.set(child.id, child.taxonName?.fullName || null);
        }
      }
    }
    if ((i + CHILDREN_BATCH_SIZE) % 1000 === 0 || i + CHILDREN_BATCH_SIZE >= speciesIds.length) {
      console.log(`Checked children for ${Math.min(i + CHILDREN_BATCH_SIZE, speciesIds.length)}/${speciesIds.length} species (${children.size} accepted infraspecific taxa found)`);
    }
    await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY_MS));
  }
  return children;
}

async function fetchParentSpecies(infraspecificIds) {
  const parents = new Map();
  for (let i = 0; i < infraspecificIds.length; i += CHILDREN_BATCH_SIZE) {
    const batch = infraspecificIds.slice(i, i + CHILDREN_BATCH_SIZE);
    const fields = batch
      .map(
        (id, index) => `t${index}: taxonConcept(id: "${id}") {
          parent {
            id
            taxonRank
            taxonomicStatus
            taxonName { fullName }
          }
        }`
      )
      .join('\n');
    const data = await queryGraphQL(`{ ${fields} }`);
    for (const row of Object.values(data)) {
      const parent = row?.parent;
      if (parent?.id && parent.taxonomicStatus === 'ACCEPTED') {
        parents.set(parent.id, parent.taxonName?.fullName || null);
      }
    }
    await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY_MS));
  }
  return parents;
}

async function fetchAndStore(store, ids, fallbackNames, { acceptedOnly = false } = {}) {
  let stored = 0;
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const results = await fetchBatch(batch);
    batch.forEach((id, index) => {
      const taxon = results[index];
      if (acceptedOnly && (!taxon || taxon.taxonomicStatus !== 'ACCEPTED')) return;
      const profile = taxon?.currentProfile?.profile;
      const bioregions = summarizeTaxonBioregions(taxon?.bioregions);
      store.taxa[id] = {
        name: taxon?.taxonName?.fullName || fallbackNames.get(id) || null,
        rank: taxon?.taxonRank || null,
        vernacular: taxon?.preferredVernacularName?.name || null,
        html: profile ? sanitizeProfile(profile) : null,
        bioregions
      };
      stored += 1;
    });
    store.generatedAt = new Date().toISOString();
    await fs.writeFile(outPath, JSON.stringify(store));
    console.log(`Fetched ${Math.min(i + BATCH_SIZE, ids.length)}/${ids.length} (${stored} stored)`);
    await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY_MS));
  }
  return stored;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let store = { taxa: {} };
  try {
    store = JSON.parse(await fs.readFile(outPath, 'utf8'));
  } catch {
    // First run.
  }

  // 1. Direct key taxa (dichotomous items & scopes + multi-access entities).
  const taxa = await collectTaxa(args.keys);
  const directTodo = [...taxa.keys()].filter(id => !(id in store.taxa)).slice(0, args.limit);
  console.log(`${taxa.size} key taxa referenced, ${directTodo.length} to fetch.`);
  if (directTodo.length) {
    await fetchAndStore(store, directTodo, taxa);
  }

  if (args.keys.length || Number.isFinite(args.limit)) return;

  // 2. Accepted infraspecific children (subspecies/varieties/forms) of all species.
  const speciesIds = Object.entries(store.taxa)
    .filter(([, entry]) => entry?.rank === 'SPECIES')
    .map(([id]) => id);
  const children = await fetchAcceptedChildren(speciesIds);
  const childTodo = [...children.keys()].filter(id => !(id in store.taxa));
  console.log(`${childTodo.length} missing accepted infraspecific children to fetch.`);
  if (childTodo.length) {
    await fetchAndStore(store, childTodo, children);
  }

  // 3. Accepted parent species of infraspecific taxa (for profiles whose parent wasn't in a key).
  const infraspecificIds = Object.entries(store.taxa)
    .filter(([, entry]) => INFRASPECIFIC_RANKS.has(entry?.rank))
    .map(([id]) => id);
  const parents = await fetchParentSpecies(infraspecificIds);
  const parentTodo = [...parents.keys()].filter(id => !(id in store.taxa));
  console.log(`${parentTodo.length} missing accepted parent species to fetch.`);
  if (parentTodo.length) {
    await fetchAndStore(store, parentTodo, parents);
  }

  // 4. Accepted taxa cross-referenced via data-taxon links inside bundled descriptions.
  const linkedIds = [...collectLinkedTaxonIds(store.taxa)].filter(id => !(id in store.taxa));
  console.log(`${linkedIds.length} unbundled data-taxon link targets to check (keeping ACCEPTED only).`);
  if (linkedIds.length) {
    await fetchAndStore(store, linkedIds, new Map(), { acceptedOnly: true });
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('Error fetching descriptions:', error.message);
    process.exit(1);
  });
}

module.exports = { sanitizeProfile };
