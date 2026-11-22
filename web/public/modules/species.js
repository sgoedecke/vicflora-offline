const TAXON_URL = /\/flora\/taxon\/([0-9a-f-]{36})/i;
const INFRASPECIFIC_RANKS = new Set(['SUBSPECIES', 'VARIETY', 'FORM']);
const INFRASPECIFIC_MARKER = /\b(subsp\.|var\.|f\.)\b/;

export function taxonIdFromUrl(url) {
  const match = url && TAXON_URL.exec(url);
  return match ? match[1] : null;
}

// One entry per VicFlora taxon linked from any dichotomous key, recording which
// keys it appears in so the lookup can jump back into them.
export function buildTaxonIndex(keys, descriptions = {}) {
  const index = new Map();
  for (const [keyId, key] of Object.entries(keys)) {
    const scopeId = taxonIdFromUrl(key.taxonomic_scope?.url);
    if (scopeId) {
      let entry = index.get(scopeId);
      if (!entry) {
        entry = { id: scopeId, name: key.taxonomic_scope.item_name || '', keys: [], toKey: null };
        index.set(scopeId, entry);
      }
      if (!entry.toKey) entry.toKey = String(keyId);
    }
    for (const item of key.items || []) {
      const id = taxonIdFromUrl(item?.url);
      if (!id) continue;
      let entry = index.get(id);
      if (!entry) {
        entry = { id, name: item.item_name || '', keys: [], toKey: null };
        index.set(id, entry);
      }
      if (!entry.keys.includes(keyId)) entry.keys.push(keyId);
      if (item.to_key && !entry.toKey) entry.toKey = String(item.to_key);
    }
  }
  mergeDescriptionsIntoIndex(index, descriptions);
  return index;
}

// Adds bundled taxa from descriptions.json (e.g. subspecies and multi-access
// taxa not directly appearing in dichotomous keys) and normalizes names.
export function mergeDescriptionsIntoIndex(index, descriptions = {}) {
  for (const [id, taxon] of Object.entries(descriptions || {})) {
    if (!taxon?.name) continue;
    let entry = index.get(id);
    if (!entry) {
      entry = { id, name: taxon.name, keys: [], toKey: null };
      index.set(id, entry);
    } else {
      entry.name = taxon.name;
    }
  }
  return index;
}

export function findInfraspecificTaxa(index, taxonId, descriptions = {}) {
  const entry = index.get(taxonId);
  const taxon = descriptions[taxonId];
  const speciesName = taxon?.name || entry?.name;
  if (!speciesName) return [];
  if (taxon?.rank && taxon.rank !== 'SPECIES') return [];
  if (!taxon?.rank && (INFRASPECIFIC_MARKER.test(speciesName) || speciesName.trim().split(/\s+/).length !== 2)) {
    return [];
  }
  const prefix = `${speciesName} `;
  const matches = [];
  for (const candidate of index.values()) {
    if (candidate.id === taxonId || !candidate.name.startsWith(prefix)) continue;
    const rank = descriptions[candidate.id]?.rank;
    if (rank ? INFRASPECIFIC_RANKS.has(rank) : INFRASPECIFIC_MARKER.test(candidate.name)) {
      matches.push(candidate);
    }
  }
  matches.sort((a, b) => a.name.localeCompare(b.name));
  return matches;
}

export function searchTaxa(index, query, descriptions = {}, limit = 30) {
  const q = query.trim().toLowerCase().replace(/\b(?:ssp\.?|subspecies)\b/g, 'subsp.');
  if (q.length < 2) return [];
  const scored = [];
  for (const entry of index.values()) {
    const name = entry.name.toLowerCase();
    const vernacular = (descriptions[entry.id]?.vernacular || '').toLowerCase();
    let score = -1;
    if (name.startsWith(q)) score = 0;
    else if (vernacular.startsWith(q)) score = 1;
    else if (name.includes(q)) score = 2;
    else if (vernacular.includes(q)) score = 3;
    if (score >= 0) scored.push({ entry, score });
  }
  scored.sort((a, b) => a.score - b.score || a.entry.name.localeCompare(b.entry.name));
  return scored.slice(0, limit).map(({ entry }) => entry);
}
