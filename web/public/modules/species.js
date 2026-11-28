export const VICFLORA_TAXON_URL = 'https://vicflora.rbg.vic.gov.au/flora/taxon/';
const TAXON_URL = /\/flora\/taxon\/([0-9a-f-]{36})/i;

export function taxonIdFromUrl(url) {
  const match = url && TAXON_URL.exec(url);
  return match ? match[1] : null;
}

export function taxonUrlFromId(taxonId) {
  return taxonId ? `${VICFLORA_TAXON_URL}${taxonId}` : null;
}

// Hydrates the build-time compiled species-index.json into a Map keyed by taxon UUID.
export function loadSpeciesIndex(bundle) {
  const taxa = bundle?.taxa || bundle || {};
  const index = new Map();
  for (const [id, raw] of Object.entries(taxa)) {
    if (!raw || typeof raw !== 'object') continue;
    index.set(id, {
      id,
      name: raw.name || '',
      vernacular: raw.vernacular || null,
      vernaculars: Array.isArray(raw.vernaculars) ? raw.vernaculars : [],
      rank: raw.rank || null,
      parentId: raw.parentId || null,
      children: Array.isArray(raw.children) ? raw.children : [],
      hasOwnDesc: Boolean(raw.hasOwnDesc),
      soleChildId: raw.soleChildId || null,
      toKey: raw.toKey ? String(raw.toKey) : null,
      keys: Array.isArray(raw.keys) ? raw.keys : []
    });
  }
  return index;
}

// O(k) lookup using build-time compiled parent/child links instead of scanning all taxa.
export function findInfraspecificTaxa(index, taxonId) {
  const entry = index.get(taxonId);
  if (!entry?.children?.length) return [];
  const matches = [];
  for (const childId of entry.children) {
    const child = index.get(childId);
    if (child) matches.push(child);
  }
  return matches;
}

export function hasOwnDescription(taxon) {
  return Boolean(taxon?.html && /class="description"/.test(taxon.html));
}

// O(1) resolution using build-time precomputed soleChildId.
export function findSoleInfraspecificProfile(index, taxonId, descriptions = {}) {
  const entry = index.get(taxonId);
  const childId = entry?.soleChildId;
  if (!childId) return null;
  const child = index.get(childId);
  const childTaxon = descriptions[childId];
  if (!child || !childTaxon?.html) return null;
  return { entry: child, taxon: childTaxon };
}

function normalizeSearchText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[-/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function searchTaxa(index, query, limit = 30) {
  const q = query.trim().toLowerCase().replace(/\b(?:ssp\.?|subspecies)\b/g, 'subsp.');
  const qNorm = normalizeSearchText(q);
  if (q.length < 2) return [];
  const scored = [];
  for (const entry of index.values()) {
    const name = entry.name.toLowerCase();
    const commonNames = [entry.vernacular, ...(entry.vernaculars || [])]
      .filter(Boolean)
      .map(normalizeSearchText);
    let score = -1;
    if (name.startsWith(q)) score = 0;
    else if (commonNames.some(v => v.startsWith(qNorm))) score = 1;
    else if (name.includes(q)) score = 2;
    else if (commonNames.some(v => v.includes(qNorm))) score = 3;
    if (score >= 0) scored.push({ entry, score });
  }
  scored.sort((a, b) => a.score - b.score || a.entry.name.localeCompare(b.entry.name));
  return scored.slice(0, limit).map(({ entry }) => entry);
}
