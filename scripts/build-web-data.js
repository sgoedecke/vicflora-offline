#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const TAXON_URL = /\/flora\/taxon\/([0-9a-f-]{36})/i;
const INFRASPECIFIC_RANKS = new Set(['SUBSPECIES', 'VARIETY', 'FORM']);
const INFRASPECIFIC_MARKER = /\b(subsp\.|var\.|f\.)\b/;
const LOWERCASE_WORDS = new Set(['of', 'and', 'the', 'in']);
const FIGURE_NUM_RE = '\\d+(?:[a-z]+(?:(?:\\s*[,–—-]\\s*|&[nm]dash;)[a-z]+)*)?';

const KEY_COMMON_ALIASES = {
  acacia: ['Wattle', 'Wattles'],
  asteraceae: ['Daisy', 'Daisies'],
  brassicaceae: ['Brassicas', 'Mustards', 'Cresses'],
  cyperaceae: ['Sedge', 'Sedges'],
  eucalypts: ['Eucalypt', 'Gum', 'Gums', 'Gum trees', 'Eucalyptus'],
  eucalyptus: ['Eucalypt', 'Eucalypts', 'Gum', 'Gums', 'Gum trees'],
  fabaceae: ['Pea', 'Peas', 'Legumes'],
  juncaceae: ['Rush', 'Rushes'],
  poaceae: ['Grass', 'Grasses'],
  orchidaceae: ['Orchid', 'Orchids'],
  ranunculus: ['Buttercup', 'Buttercups'],
  ptilotus: ['Mulla-mulla', 'Feather-heads'],
  banksia: ['Banksias'],
  grevillea: ['Grevilleas', 'Spider-flowers'],
  melaleuca: ['Paperbark', 'Paperbarks', 'Honey-myrtles'],
  leptospermum: ['Tea-tree', 'Tea-trees'],
  callistemon: ['Bottlebrush', 'Bottlebrushes'],
  hibbertia: ['Guinea-flower', 'Guinea-flowers'],
  drosera: ['Sundew', 'Sundews'],
  lomandra: ['Mat-rush', 'Mat-rushes'],
  dianella: ['Flax-lily', 'Flax-lilies']
};

function stripInaccessibleFigureRefs(html, { glossary = false } = {}) {
  if (!html || typeof html !== 'string') return html;
  let cleaned = html.replace(
    new RegExp(`\\s*\\(\\s*Figures?\\s+${FIGURE_NUM_RE}\\s*\\)`, 'gi'),
    ''
  );
  if (glossary) {
    cleaned = cleaned.replace(
      new RegExp(`\\.?\\s*Figures?\\s+${FIGURE_NUM_RE}\\s*;`, 'gi'),
      ';'
    );
    cleaned = cleaned.replace(
      new RegExp(`\\s*Figures?\\s+${FIGURE_NUM_RE}\\.?(?=\\s*(?:</p>|$))`, 'gi'),
      ''
    );
  }
  return cleaned
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function collectKeyAliases(title, scopeName = null, scopeEntry = null) {
  const seen = new Set();
  const out = [];
  const add = value => {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(trimmed);
  };
  for (const label of [title, scopeName]) {
    if (!label) continue;
    const aliases = KEY_COMMON_ALIASES[String(label).trim().toLowerCase()];
    if (aliases) aliases.forEach(add);
  }
  if (scopeEntry?.vernacular) add(scopeEntry.vernacular);
  for (const alt of scopeEntry?.vernaculars || []) add(alt);
  return out;
}

const DATA_BUNDLES = [
  { id: 'bioregions', file: 'bioregions.json' },
  { id: 'glossary', file: 'glossary.json' },
  { id: 'searchIndex', file: 'search-index.json' },
  { id: 'speciesIndex', file: 'species-index.json' },
  { id: 'dichotomous', file: 'dichotomous-keys.json' },
  { id: 'multi', file: 'multi-keys.json' },
  { id: 'descriptions', file: 'descriptions.json' }
];

const STATIC_SHELL_FILES = [
  'index.html',
  'styles.css',
  'app.js',
  'manifest.json',
  'favicon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadJSON(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function writeJSON(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data));
}

function taxonIdFromUrl(url) {
  const match = typeof url === 'string' && TAXON_URL.exec(url);
  return match ? match[1] : null;
}

function normalizeKeyTitle(title) {
  if (!title || typeof title !== 'string') return title;
  const patterns = [
    /^key\s+to\s+the\s+/i,
    /^key\s+to\s+/i,
    /^key:\s*/i,
    /^key\s+/i
  ];

  let cleaned = title.trim();
  for (const pattern of patterns) {
    if (pattern.test(cleaned)) {
      cleaned = cleaned.replace(pattern, '');
      break;
    }
  }

  const categoryPattern = /^(?:the\s+)?(families|genera|species|subfamilies|subgenera|tribes|subtribes|orders|suborders|sections|subsections)\s+of\s+/i;
  if (categoryPattern.test(cleaned)) {
    cleaned = cleaned.replace(categoryPattern, '');
  }

  // Bryophyte keys use the "Key to Pottiaceae genera" form
  const trailingCategoryPattern = /\s+(genera|species|subspecies|varieties)$/i;
  cleaned = cleaned.replace(trailingCategoryPattern, '').trim();

  return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : cleaned;
}

function titleCase(value) {
  return value.replace(/\w+/g, (word, index) => {
    const lower = word.toLowerCase();
    if (index > 0 && LOWERCASE_WORDS.has(lower)) {
      return lower;
    }
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  });
}

function normalizeMultiKeyTitle(title) {
  if (!title || typeof title !== 'string') return '';
  const pattern = /^(?:multi[\s-]*access\s+key|key)\s+to\s+(?:the\s+)?/i;
  const cleaned = title
    .trim()
    .replace(pattern, '')
    .replace(/_updated.*$/i, '')
    .replace(/(\bVictoria)\d+$/i, '$1')
    .replace(/\s+(?:of|in)\s+Victoria$/i, '')
    .trim();
  return cleaned ? titleCase(cleaned) : titleCase(title.trim());
}

function cleanMultiKeyId(fileName) {
  return String(fileName)
    .replace(/^key-/, '')
    .replace(/-complete\.json$/i, '')
    .replace(/\.json$/i, '');
}

function lastEdited(rawKey) {
  const times = [rawKey.timestamp_created, rawKey.timestamp_modified].filter(Boolean).sort();
  return times[times.length - 1] || '';
}

function compileDichotomousKey(id, rawKey) {
  const title = rawKey.key_title ? normalizeKeyTitle(rawKey.key_title) : `Key ${id}`;
  const scopeRaw = rawKey.taxonomic_scope;
  const scopeName = scopeRaw?.item_name ? normalizeKeyTitle(scopeRaw.item_name) : null;
  const scopeTaxonId = taxonIdFromUrl(scopeRaw?.url);
  const scope =
    scopeName || scopeTaxonId
      ? {
          ...(scopeName ? { name: scopeName } : {}),
          ...(scopeTaxonId ? { taxonId: scopeTaxonId } : {})
        }
      : null;

  const items = (rawKey.items || []).map(item => {
    const out = {
      id: item.item_id,
      name: item.item_name || ''
    };
    const taxonId = taxonIdFromUrl(item.url);
    if (taxonId) out.taxonId = taxonId;
    else if (item.url) out.url = item.url;
    if (item.to_key) out.toKey = String(item.to_key);
    return out;
  });

  const leads = (rawKey.leads || []).map(lead => {
    const out = {
      id: lead.lead_id,
      parent: lead.parent_id,
      text: lead.lead_text || ''
    };
    if (lead.item) out.item = lead.item;
    return out;
  });

  const compiled = {
    title,
    root: rawKey.first_step?.root_node_id,
    items,
    leads
  };
  if (scope) compiled.scope = scope;
  return compiled;
}

// KeyBase contains some keys uploaded more than once under the same title.
// Keep every key navigable, but precompute one canonical searchable entry per
// title: prefer the copy a parent key links to, then the most recently edited.
function buildSearchableKeys(compiledKeys, editedById) {
  const linked = new Set();
  for (const key of Object.values(compiledKeys)) {
    for (const item of key.items || []) {
      if (item.toKey) linked.add(String(item.toKey));
    }
  }

  const byTitle = new Map();
  for (const [id, key] of Object.entries(compiledKeys)) {
    const title = key.title || `Key ${id}`;
    const candidate = { id, title, linked: linked.has(id), edited: editedById.get(id) || '' };
    const current = byTitle.get(title);
    if (
      !current ||
      (candidate.linked && !current.linked) ||
      (candidate.linked === current.linked && candidate.edited > current.edited)
    ) {
      byTitle.set(title, candidate);
    }
  }

  return [...byTitle.values()]
    .map(({ id, title }) => ({ id, title }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

function compileMultiKey(fileName, rawKey) {
  const id = cleanMultiKeyId(fileName);
  const title = normalizeMultiKeyTitle(rawKey.title || id);

  const features = (rawKey.features || []).map(f => {
    const out = { id: f.id, name: f.name || '', type: f.type };
    if (f.parent) out.parent = f.parent;
    return out;
  });

  const states = (rawKey.states || []).map(s => ({
    id: s.id,
    name: s.name || '',
    feature: s.feature
  }));

  const entities = (rawKey.entities || []).map(e => {
    const out = { id: e.id, name: e.name || e.title || '' };
    const profileEntry = e.text?.find(
      item => typeof item?.path === 'string' && item.path.includes('/flora/taxon/')
    );
    const rawUrl = e.url || profileEntry?.path || null;
    const taxonId = taxonIdFromUrl(rawUrl);
    if (taxonId) out.taxonId = taxonId;
    else if (rawUrl) out.url = rawUrl;
    return out;
  });

  const scores = {};
  for (const [stateId, row] of Object.entries(rawKey.decompressedScores || {})) {
    let encoded = '';
    for (let i = 0; i < row.length; i += 1) {
      const code = row[i] ?? 0;
      if (!Number.isInteger(code) || code < 0 || code > 9) {
        throw new Error(`Invalid multi-access score ${code} in ${fileName} state ${stateId} index ${i}`);
      }
      encoded += String(code);
    }
    scores[stateId] = encoded;
  }

  const compiled = {
    title,
    features,
    states,
    entities,
    scores
  };
  if (rawKey.decompressedMeasures && Object.keys(rawKey.decompressedMeasures).length) {
    compiled.measures = rawKey.decompressedMeasures;
  }

  return { id, key: compiled };
}

function hasOwnDescriptionHtml(html) {
  return Boolean(html && /class="description"/.test(html));
}

function buildSpeciesIndexAndDescriptions(dichotomousKeys, multiKeys, rawDescriptionsTaxa) {
  const records = new Map();

  function ensureRecord(id, name = '') {
    let entry = records.get(id);
    if (!entry) {
      entry = {
        id,
        name,
        vernacular: null,
        vernaculars: [],
        rank: null,
        parentId: null,
        children: [],
        hasOwnDesc: false,
        soleChildId: null,
        toKey: null,
        keys: []
      };
      records.set(id, entry);
    } else if (!entry.name && name) {
      entry.name = name;
    }
    return entry;
  }

  for (const [keyId, key] of Object.entries(dichotomousKeys)) {
    const scopeId = key.scope?.taxonId;
    if (scopeId) {
      const entry = ensureRecord(scopeId, key.scope.name || '');
      if (!entry.toKey) entry.toKey = String(keyId);
    }
    for (const item of key.items || []) {
      if (!item.taxonId) continue;
      const entry = ensureRecord(item.taxonId, item.name || '');
      if (!entry.keys.includes(keyId)) entry.keys.push(keyId);
      if (item.toKey && !entry.toKey) entry.toKey = String(item.toKey);
    }
  }

  for (const key of Object.values(multiKeys)) {
    for (const entity of key.entities || []) {
      if (!entity.taxonId) continue;
      ensureRecord(entity.taxonId, entity.name || '');
    }
  }

  const slimDescriptions = {};
  for (const [id, taxon] of Object.entries(rawDescriptionsTaxa || {})) {
    const cleanHtml = taxon?.html ? stripInaccessibleFigureRefs(taxon.html) : null;
    if (taxon?.name) {
      const entry = ensureRecord(id, taxon.name);
      entry.name = taxon.name;
      if (taxon.vernacular) entry.vernacular = taxon.vernacular;
      if (Array.isArray(taxon.vernaculars) && taxon.vernaculars.length) {
        entry.vernaculars = taxon.vernaculars.filter(Boolean);
      }
      if (taxon.rank) entry.rank = taxon.rank;
      if (taxon.parentId) entry.parentId = taxon.parentId;
      entry.hasOwnDesc = hasOwnDescriptionHtml(cleanHtml);
    } else if (records.has(id)) {
      const entry = records.get(id);
      if (taxon?.vernacular) entry.vernacular = taxon.vernacular;
      if (Array.isArray(taxon?.vernaculars) && taxon.vernaculars.length) {
        entry.vernaculars = taxon.vernaculars.filter(Boolean);
      }
      if (taxon?.rank) entry.rank = taxon.rank;
      if (taxon?.parentId) entry.parentId = taxon.parentId;
      entry.hasOwnDesc = hasOwnDescriptionHtml(cleanHtml);
    }

    const descOut = {};
    if (cleanHtml) descOut.html = cleanHtml;
    if (taxon?.bioregions) descOut.bioregions = taxon.bioregions;
    if (Object.keys(descOut).length) {
      slimDescriptions[id] = descOut;
    }
  }

  // Derive exact parentId / children links for infraspecific taxa.
  // Use saved parentId from GraphQL when present, otherwise match exact
  // binomial species prefix (verified 100% identical to runtime scanning).
  const speciesByName = new Map();
  for (const entry of records.values()) {
    if (!entry.name) continue;
    const isSpecies = entry.rank
      ? entry.rank === 'SPECIES'
      : !INFRASPECIFIC_MARKER.test(entry.name) && entry.name.trim().split(/\s+/).length === 2;
    if (isSpecies) {
      speciesByName.set(entry.name, entry.id);
    }
  }

  for (const entry of records.values()) {
    if (!entry.name) continue;
    const isInfra = entry.rank
      ? INFRASPECIFIC_RANKS.has(entry.rank)
      : INFRASPECIFIC_MARKER.test(entry.name);
    if (!isInfra) continue;

    let parentId = entry.parentId && records.has(entry.parentId) ? entry.parentId : null;
    if (!parentId) {
      const match = entry.name.match(/^(.+?)\s+(?:subsp\.|var\.|f\.)\s+/);
      if (match && speciesByName.has(match[1])) {
        parentId = speciesByName.get(match[1]);
      } else {
        for (const [spName, spId] of speciesByName.entries()) {
          if (spId !== entry.id && entry.name.startsWith(`${spName} `)) {
            parentId = spId;
            break;
          }
        }
      }
    }

    if (parentId && parentId !== entry.id) {
      entry.parentId = parentId;
      const parent = records.get(parentId);
      if (parent && !parent.children.includes(entry.id)) {
        parent.children.push(entry.id);
      }
    }
  }

  for (const entry of records.values()) {
    if (entry.children.length > 1) {
      entry.children.sort((a, b) =>
        (records.get(a)?.name || '').localeCompare(records.get(b)?.name || '')
      );
    }
    if (!entry.hasOwnDesc && entry.children.length === 1) {
      const childId = entry.children[0];
      if (slimDescriptions[childId]?.html) {
        entry.soleChildId = childId;
      }
      const child = records.get(childId);
      if (child) {
        if (!entry.vernacular && child.vernacular) {
          entry.vernacular = child.vernacular;
        }
        if (!entry.vernaculars.length && child.vernaculars.length) {
          entry.vernaculars = [...child.vernaculars];
        }
      }
    }
  }

  // Omit null/false/empty optional fields to keep species-index.json compact.
  const compactIndex = {};
  for (const [id, entry] of records.entries()) {
    const out = { name: entry.name };
    if (entry.vernacular) out.vernacular = entry.vernacular;
    if (entry.vernaculars.length) out.vernaculars = entry.vernaculars;
    if (entry.rank) out.rank = entry.rank;
    if (entry.parentId) out.parentId = entry.parentId;
    if (entry.children.length) out.children = entry.children;
    if (entry.hasOwnDesc) out.hasOwnDesc = true;
    if (entry.soleChildId) out.soleChildId = entry.soleChildId;
    if (entry.toKey) out.toKey = entry.toKey;
    if (entry.keys.length) out.keys = entry.keys;
    compactIndex[id] = out;
  }

  return { speciesIndex: compactIndex, descriptions: slimDescriptions };
}

function compilePhotosIndex(rawIndex) {
  const credits = [];
  const creditIds = new Map();
  function internCredit(raw) {
    const value = raw || 'VicFlora';
    if (!creditIds.has(value)) {
      creditIds.set(value, credits.length);
      credits.push(value);
    }
    return creditIds.get(value);
  }

  const media = {};
  const taxonIds = new Set([
    ...Object.keys(rawIndex.taxa || {}),
    ...Object.keys(rawIndex.drawings || {})
  ]);

  for (const taxonId of taxonIds) {
    const items = [];
    const primary = rawIndex.taxa?.[taxonId];
    if (Array.isArray(primary) && primary.length >= 5 && primary[3]) {
      const [shard, offset, length, hash, attribution, url, rawKind, rawCaption] = primary;
      const item = {
        shard,
        offset,
        length,
        hash,
        kind: rawKind === 'drawing' ? 'drawing' : 'photo',
        credit: internCredit(attribution),
        url: url || ''
      };
      if (typeof rawCaption === 'string' && rawCaption) item.caption = rawCaption;
      items.push(item);
    }

    const drawing = rawIndex.drawings?.[taxonId];
    if (Array.isArray(drawing) && drawing.length >= 5 && drawing[3]) {
      const [shard, offset, length, hash, attribution, url, rawCaption] = drawing;
      if (!items.some(existing => existing.hash === hash)) {
        const item = {
          shard,
          offset,
          length,
          hash,
          kind: 'drawing',
          credit: internCredit(attribution),
          url: url || ''
        };
        if (typeof rawCaption === 'string' && rawCaption) item.caption = rawCaption;
        items.push(item);
      }
    }

    if (items.length) {
      media[taxonId] = items;
    }
  }

  return {
    version: rawIndex.version,
    format: rawIndex.format,
    maxDimension: rawIndex.maxDimension,
    quality: rawIndex.quality,
    generatedAt: rawIndex.generatedAt,
    cdnPrefix: rawIndex.cdnPrefix,
    totalBytes: rawIndex.totalBytes,
    totalImages: rawIndex.totalImages,
    taxaCount: rawIndex.taxaCount ?? Object.keys(media).length,
    drawingsCount: rawIndex.drawingsCount ?? 0,
    shards: rawIndex.shards || [],
    credits,
    media
  };
}

async function main() {
  const root = process.cwd();
  const webDataDir = path.join(root, 'web', 'public', 'data');
  await fs.mkdir(webDataDir, { recursive: true });

  // Bundle every scraped KeyBase key directly.
  const dichotomous = {};
  const editedById = new Map();
  const scrapedKeyIds = (await fs.readdir(path.join(root, 'keybase-data')))
    .filter(name => /^\d+\.json$/.test(name))
    .map(name => name.replace(/\.json$/, ''))
    .sort((a, b) => Number(a) - Number(b));

  for (const id of scrapedKeyIds) {
    const filePath = path.join(root, 'keybase-data', `${id}.json`);
    const key = await loadJSON(filePath);
    const normalized = key.keybase || key;
    editedById.set(id, lastEdited(normalized));
    dichotomous[id] = compileDichotomousKey(id, normalized);
  }

  const searchableKeys = buildSearchableKeys(dichotomous, editedById);
  await writeJSON(path.join(webDataDir, 'dichotomous-keys.json'), {
    searchableKeys,
    keys: dichotomous
  });

  // Build multi-access dataset with clean stable IDs, pre-cleaned titles, and compact score strings.
  const multi = {};
  const multiKeyFiles = (await fs.readdir(path.join(root, 'vicflora-data')))
    .filter(name => name.startsWith('key-') && name.endsWith('-complete.json'))
    .sort();

  for (const fileName of multiKeyFiles) {
    const filePath = path.join(root, 'vicflora-data', fileName);
    const rawKey = await loadJSON(filePath);
    const { id, key } = compileMultiKey(fileName, rawKey);
    if (multi[id]) {
      throw new Error(`Duplicate compiled multi-access key id: ${id} (from ${fileName})`);
    }
    multi[id] = key;
  }
  await writeJSON(path.join(webDataDir, 'multi-keys.json'), {
    keys: multi
  });

  // Build lightweight species-index.json + slimmed minified descriptions.json.
  // Keep generated bundles deterministic (no build-time timestamps) so unchanged data hashes stay stable.
  const descriptionsPath = path.join(root, 'vicflora-data', 'taxon-descriptions.json');
  const rawDescriptions = (await fileExists(descriptionsPath))
    ? await loadJSON(descriptionsPath)
    : { taxa: {} };
  const { speciesIndex, descriptions } = buildSpeciesIndexAndDescriptions(
    dichotomous,
    multi,
    rawDescriptions.taxa || {}
  );
  await writeJSON(path.join(webDataDir, 'species-index.json'), {
    taxa: speciesIndex
  });
  await writeJSON(path.join(webDataDir, 'descriptions.json'), {
    ...(rawDescriptions.generatedAt ? { generatedAt: rawDescriptions.generatedAt } : {}),
    taxa: descriptions
  });

  // Compact key directory for instant unified search (taxa come from species-index.json).
  const searchIndex = {
    multiAccessKeys: Object.entries(multi)
      .map(([id, entry]) => {
        const title = entry.title || id;
        const aliases = collectKeyAliases(title);
        const out = {
          id,
          title,
          entities: Array.isArray(entry.entities) ? entry.entities.length : 0
        };
        if (aliases.length) out.aliases = aliases;
        return out;
      })
      .sort((a, b) => a.title.localeCompare(b.title)),
    dichotomousKeys: searchableKeys
      .map(({ id, title }) => {
        const scope = dichotomous[id]?.scope?.name || null;
        const scopeTaxonId = dichotomous[id]?.scope?.taxonId || null;
        const scopeEntry = scopeTaxonId ? speciesIndex[scopeTaxonId] : null;
        const aliases = collectKeyAliases(title, scope, scopeEntry);
        const out = scope ? { id, title, scope } : { id, title };
        if (aliases.length) out.aliases = aliases;
        return out;
      })
      .sort((a, b) => {
        if (a.id === '1903') return -1;
        if (b.id === '1903') return 1;
        return a.title.localeCompare(b.title);
      })
  };
  await writeJSON(path.join(webDataDir, 'search-index.json'), searchIndex);

  // Glossary (see scripts/fetch-glossary.js), minified with inaccessible printed figure refs removed.
  const glossaryPath = path.join(root, 'vicflora-data', 'glossary.json');
  if (await fileExists(glossaryPath)) {
    const rawGlossary = await loadJSON(glossaryPath);
    const cleanedGlossary = rawGlossary.map(term =>
      term?.definition
        ? { ...term, definition: stripInaccessibleFigureRefs(term.definition, { glossary: true }) }
        : term
    );
    await writeJSON(path.join(webDataDir, 'glossary.json'), cleanedGlossary);
  } else {
    await writeJSON(path.join(webDataDir, 'glossary.json'), []);
  }

  // Bioregion map geometry (see scripts/fetch-bioregions.js), minified.
  const bioregionsPath = path.join(root, 'vicflora-data', 'bioregions.json');
  if (await fileExists(bioregionsPath)) {
    await writeJSON(path.join(webDataDir, 'bioregions.json'), await loadJSON(bioregionsPath));
  } else {
    await writeJSON(path.join(webDataDir, 'bioregions.json'), { regions: [] });
  }

  // Species photo shards and normalized index (see scripts/fetch-photos.js).
  const photosSrcDir = path.join(root, 'vicflora-data', 'photos');
  const photosDestDir = path.join(webDataDir, 'photos');
  await fs.mkdir(photosDestDir, { recursive: true });
  const photosIndexSrc = path.join(photosSrcDir, 'index.json');
  if (await fileExists(photosIndexSrc)) {
    const photosIndex = await loadJSON(photosIndexSrc);
    const shards = photosIndex.shards || [];
    // Validate every shard (name, size, SHA-256) BEFORE removing any existing web shards.
    for (const shard of shards) {
      if (typeof shard.file !== 'string' || !/^photos-\d+(?:-[a-f0-9]+)?\.bin$/.test(shard.file)) {
        throw new Error(`Invalid photo shard filename in index.json: ${shard.file}`);
      }
      const srcShard = path.join(photosSrcDir, shard.file);
      const stat = await fs.stat(srcShard).catch(() => null);
      if (!stat || stat.size !== shard.bytes) {
        throw new Error(
          `Photo shard integrity check failed for ${shard.file}: expected ${shard.bytes} bytes, got ${stat ? stat.size : 'missing'}.`
        );
      }
      if (shard.sha256) {
        const bytes = await fs.readFile(srcShard);
        const actualSha = crypto.createHash('sha256').update(bytes).digest('hex');
        if (actualSha !== shard.sha256) {
          throw new Error(`Photo shard SHA-256 mismatch for ${shard.file}: expected ${shard.sha256}, got ${actualSha}.`);
        }
      }
    }

    const expectedFiles = new Set(shards.map(s => s.file));
    for (const shard of shards) {
      await fs.copyFile(path.join(photosSrcDir, shard.file), path.join(photosDestDir, shard.file));
    }
    const compiledPhotosIndex = compilePhotosIndex(photosIndex);
    await writeJSON(path.join(photosDestDir, 'index.json'), compiledPhotosIndex);
    for (const name of await fs.readdir(photosDestDir)) {
      if (/^photos-.*\.bin$/.test(name) && !expectedFiles.has(name)) {
        await fs.unlink(path.join(photosDestDir, name));
      }
    }
  } else {
    for (const name of await fs.readdir(photosDestDir)) {
      if (/^photos-.*\.bin$/.test(name)) {
        await fs.unlink(path.join(photosDestDir, name));
      }
    }
    await writeJSON(path.join(photosDestDir, 'index.json'), {
      version: '0',
      totalBytes: 0,
      totalImages: 0,
      taxaCount: 0,
      drawingsCount: 0,
      shards: [],
      credits: [],
      media: {}
    });
  }

  // Build content-addressed manifest for the Service Worker and unified offline sync.
  const webPublicDir = path.join(root, 'web', 'public');
  const manifest = await buildManifest(webPublicDir);
  await writeJSON(path.join(webDataDir, 'manifest.json'), manifest);
  await fs.writeFile(
    path.join(webDataDir, 'sw-manifest.js'),
    `self.__VICFLORA_MANIFEST__ = ${JSON.stringify(manifest, null, 2)};\n`
  );

  console.log(`✅ Web data bundle generated (shell ${manifest.shellHash}, data ${manifest.dataHash}).`);
}

async function hashFile(filePath) {
  const bytes = await fs.readFile(filePath);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  return { sha256, hash: sha256.slice(0, 12), bytes: bytes.byteLength };
}

async function buildManifest(webPublicDir) {
  const modulesDir = path.join(webPublicDir, 'modules');
  const moduleFiles = (await fs.readdir(modulesDir))
    .filter(name => name.endsWith('.js'))
    .sort()
    .map(name => `modules/${name}`);

  const shellRelativeFiles = [
    ...STATIC_SHELL_FILES.slice(0, 3),
    ...moduleFiles,
    ...STATIC_SHELL_FILES.slice(3)
  ];

  const shellEntries = [];
  const shellHasher = crypto.createHash('sha256');
  for (const relPath of shellRelativeFiles) {
    const absPath = path.join(webPublicDir, relPath);
    if (!(await fileExists(absPath))) continue;
    const { sha256 } = await hashFile(absPath);
    shellEntries.push(`./${relPath}`);
    shellHasher.update(`${relPath}:${sha256}\n`);
  }

  const dataEntries = [];
  const dataHasher = crypto.createHash('sha256');
  for (const bundle of DATA_BUNDLES) {
    const relPath = `data/${bundle.file}`;
    const absPath = path.join(webPublicDir, relPath);
    const { sha256, hash, bytes } = await hashFile(absPath);
    dataEntries.push({
      id: bundle.id,
      path: `./${relPath}`,
      url: `./${relPath}?v=${hash}`,
      hash,
      sha256,
      bytes
    });
    dataHasher.update(`${relPath}:${sha256}\n`);
  }

  const dataHash = dataHasher.digest('hex').slice(0, 12);
  const shellHash = shellHasher.digest('hex').slice(0, 12);

  return {
    shellHash,
    dataHash,
    shell: ['./', ...shellEntries],
    data: dataEntries
  };
}

module.exports = {
  DATA_BUNDLES,
  buildManifest,
  cleanMultiKeyId,
  compileDichotomousKey,
  compileMultiKey,
  compilePhotosIndex,
  buildSearchableKeys,
  buildSpeciesIndexAndDescriptions,
  normalizeKeyTitle,
  normalizeMultiKeyTitle,
  stripInaccessibleFigureRefs
};

if (require.main === module) {
  main().catch(error => {
    console.error('Error generating web data bundle:', error.message);
    process.exit(1);
  });
}
