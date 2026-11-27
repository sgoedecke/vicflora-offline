function normalizeQuery(query) {
  return String(query || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\b(?:ssp\.?|subspecies)\b/g, 'subsp.');
}

function singularVariants(q) {
  const variants = [];
  if (q.length < 4 || q.includes(' ')) return variants;
  if (q.endsWith('ies') && q.length >= 5) {
    variants.push(`${q.slice(0, -3)}y`);
  }
  if (/(?:shes|ches|sses|xes|zes)$/.test(q) && q.length >= 5) {
    variants.push(q.slice(0, -2));
  }
  if (q.endsWith('s') && !q.endsWith('ss')) {
    variants.push(q.slice(0, -1));
  }
  return variants;
}

function hasWordPrefix(text, q) {
  let idx = text.indexOf(q);
  while (idx >= 0) {
    if (idx === 0 || /[\s\-/(]/.test(text[idx - 1])) {
      return true;
    }
    idx = text.indexOf(q, idx + 1);
  }
  return false;
}

function allTokensMatch(text, tokens) {
  return tokens.length > 1 && tokens.every(token => text.includes(token));
}

function scoreField(text, q, alts, tokens) {
  if (!text) return -1;
  if (text === q) return 0;
  if (text.startsWith(q)) return 1;
  if (hasWordPrefix(text, q)) return 2;
  if (text.includes(q)) return 3;
  for (const alt of alts) {
    if (text === alt || text.startsWith(alt) || hasWordPrefix(text, alt)) return 4;
    if (text.includes(alt)) return 5;
  }
  if (allTokensMatch(text, tokens)) return 6;
  return -1;
}

function normalizeTaxaEntries(source) {
  if (!source) return [];
  if (source instanceof Map) {
    return Array.from(source.values());
  }
  if (Array.isArray(source)) {
    return source;
  }
  if (source.taxa && typeof source.taxa === 'object') {
    return Object.entries(source.taxa).map(([id, entry]) => ({ id, ...entry }));
  }
  if (typeof source === 'object') {
    return Object.entries(source).map(([id, entry]) => ({ id, ...entry }));
  }
  return [];
}

function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<\/?(?:p|div|br|li|ul|ol|h[1-6])\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&deg;/g, '°')
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&times;/g, '×')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeGlossaryEntries(source) {
  if (!source) return [];
  if (Array.isArray(source)) return source;
  if (source.terms instanceof Map) return Array.from(source.terms.values());
  return [];
}

function summarizeGlossaryEntry(entry) {
  const plain = stripHtml(entry.definition);
  if (plain) {
    return plain.length > 100 ? `${plain.slice(0, 99).trimEnd()}…` : plain;
  }
  const firstRelated = Array.isArray(entry.related) ? entry.related[0]?.[1] : null;
  return firstRelated ? `See ${firstRelated}` : null;
}

export function createSearchIndex(raw = {}, taxonSource = null, glossarySource = null) {
  const multiAccessKeys = (raw.multiAccessKeys || []).map(entry => ({
    id: String(entry.id),
    title: entry.title || String(entry.id),
    entities: Number.isFinite(entry.entities) ? entry.entities : null,
    _title: (entry.title || String(entry.id)).toLowerCase()
  }));

  const dichotomousKeys = (raw.dichotomousKeys || []).map(entry => ({
    id: String(entry.id),
    title: entry.title || `Key ${entry.id}`,
    scope: entry.scope || null,
    _id: String(entry.id).toLowerCase(),
    _title: (entry.title || `Key ${entry.id}`).toLowerCase(),
    _scope: (entry.scope || '').toLowerCase()
  }));

  const rawTaxa = taxonSource != null ? normalizeTaxaEntries(taxonSource) : normalizeTaxaEntries(raw.taxa);
  const taxa = rawTaxa.map(entry => ({
    id: String(entry.id),
    name: entry.name || '',
    vernacular: entry.vernacular || null,
    rank: entry.rank || null,
    toKey: entry.toKey ? String(entry.toKey) : null,
    keys: Array.isArray(entry.keys) ? entry.keys.map(String) : [],
    _name: (entry.name || '').toLowerCase(),
    _vernacular: (entry.vernacular || '').toLowerCase()
  }));

  const rawGlossary =
    glossarySource != null
      ? normalizeGlossaryEntries(glossarySource)
      : normalizeGlossaryEntries(raw.glossary);
  const glossaryTerms = rawGlossary
    .filter(entry => entry && entry.name)
    .map(entry => ({
      name: String(entry.name),
      preview: summarizeGlossaryEntry(entry),
      _name: String(entry.name).toLowerCase()
    }));

  const multiKeyById = new Map(multiAccessKeys.map(k => [k.id, k]));
  const dichKeyById = new Map(dichotomousKeys.map(k => [k.id, k]));
  const taxonById = new Map(taxa.map(t => [t.id, t]));

  return {
    multiAccessKeys,
    dichotomousKeys,
    taxa,
    glossaryTerms,
    multiKeyById,
    dichKeyById,
    taxonById
  };
}

export function searchUnified(
  index,
  query,
  { multiLimit = 5, dichLimit = 8, taxonLimit = 20, glossaryLimit = 8 } = {}
) {
  const q = normalizeQuery(query);
  if (!index || q.length < 2) {
    return {
      query: q,
      multiAccessKeys: [],
      dichotomousKeys: [],
      taxa: [],
      glossaryTerms: [],
      total: 0
    };
  }

  const alts = singularVariants(q);
  const tokens = q.split(' ').filter(Boolean);

  const multiScored = [];
  for (const entry of index.multiAccessKeys) {
    const score = scoreField(entry._title, q, alts, tokens);
    if (score >= 0) {
      multiScored.push({ entry, score });
    }
  }
  multiScored.sort((a, b) => a.score - b.score || a.entry.title.localeCompare(b.entry.title));

  const dichScored = [];
  for (const entry of index.dichotomousKeys) {
    let score = -1;
    if (entry._id === q) {
      score = 0;
    } else {
      const titleScore = scoreField(entry._title, q, alts, tokens);
      const scopeScore = entry._scope ? scoreField(entry._scope, q, alts, tokens) : -1;
      if (titleScore >= 0 && scopeScore >= 0) {
        score = Math.min(titleScore, scopeScore + 0.5);
      } else if (titleScore >= 0) {
        score = titleScore;
      } else if (scopeScore >= 0) {
        score = scopeScore + 0.5;
      }
    }
    if (score >= 0) {
      dichScored.push({ entry, score });
    }
  }
  dichScored.sort(
    (a, b) =>
      a.score - b.score ||
      a.entry.title.length - b.entry.title.length ||
      a.entry.title.localeCompare(b.entry.title)
  );

  const taxonScored = [];
  for (const entry of index.taxa) {
    const nameScore = scoreField(entry._name, q, alts, tokens);
    const vernScore = entry._vernacular ? scoreField(entry._vernacular, q, alts, tokens) : -1;
    let score = -1;
    if (nameScore >= 0 && vernScore >= 0) {
      score = Math.min(nameScore, vernScore + 0.5);
    } else if (nameScore >= 0) {
      score = nameScore;
    } else if (vernScore >= 0) {
      score = vernScore + 0.5;
    }
    if (score >= 0) {
      taxonScored.push({ entry, score });
    }
  }
  taxonScored.sort((a, b) => a.score - b.score || a.entry.name.localeCompare(b.entry.name));

  const glossaryScored = [];
  for (const entry of index.glossaryTerms || []) {
    const score = scoreField(entry._name, q, alts, tokens);
    if (score >= 0) {
      glossaryScored.push({ entry, score });
    }
  }
  glossaryScored.sort(
    (a, b) =>
      a.score - b.score ||
      a.entry.name.length - b.entry.name.length ||
      a.entry.name.localeCompare(b.entry.name)
  );

  const multiAccessKeys = multiScored.slice(0, multiLimit).map(({ entry }) => entry);
  const dichotomousKeys = dichScored.slice(0, dichLimit).map(({ entry }) => entry);
  const taxa = taxonScored.slice(0, taxonLimit).map(({ entry }) => entry);
  const glossaryTerms = glossaryScored.slice(0, glossaryLimit).map(({ entry }) => entry);

  return {
    query: q,
    multiAccessKeys,
    dichotomousKeys,
    taxa,
    glossaryTerms,
    total: multiAccessKeys.length + dichotomousKeys.length + taxa.length + glossaryTerms.length
  };
}
