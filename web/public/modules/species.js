const TAXON_URL = /\/flora\/taxon\/([0-9a-f-]{36})/i;

export function taxonIdFromUrl(url) {
  const match = url && TAXON_URL.exec(url);
  return match ? match[1] : null;
}

// One entry per VicFlora taxon linked from any dichotomous key, recording which
// keys it appears in so the lookup can jump back into them.
export function buildTaxonIndex(keys) {
  const index = new Map();
  for (const [keyId, key] of Object.entries(keys)) {
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
  return index;
}

export function searchTaxa(index, query, descriptions = {}, limit = 30) {
  const q = query.trim().toLowerCase();
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
