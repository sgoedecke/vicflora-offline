// Everyday words (or units) that are in the VicFlora glossary but would just add
// noise if every occurrence in the keys were marked as a glossary term.
const STOP_TERMS = new Set([
  'in', 'mm', 'cm', 'dm', 'm', 'flower', 'hair', 'fruit', 'erect', 'entire', 'seed',
  'lateral', 'shrub', 'spreading', 'perennial', 'annual', 'segment', 'simple', 'herb',
  'scale', 'bristle', 'toothed', 'free', 'spine', 'cell', 'pod', 'nut', 'tree', 'wing',
  'bud', 'fertile', 'persistent', 'distinct', 'fused', 'grass', 'triangular', 'forest',
  'section', 'axis', 'woolly', 'compressed', 'succulent', 'silky', 'cone', 'species',
  'habitat', 'aquatic', 'inflated', 'grassland', 'globular', 'conical', 'marginal',
  'deciduous', 'juvenile leaves', 'glandular hair', 'head', 'vein', 'opposite', 'alternate'
]);

const SKIP_SELECTOR = 'a, .region, .scientific_name, .gloss, .taxon, .lead-dest, .vernacular, .sole-infraspecific-note, .taxon-photo, button.link';

function normalize(word) {
  return word.toLowerCase().replace(/\s+/g, ' ');
}

export class Glossary {
  constructor(terms) {
    this.terms = new Map(terms.map(term => [normalize(term.name), term]));
    const names = terms
      .map(term => term.name)
      .filter(name => /^[a-z][a-z' -]*[a-z]$/.test(name) && !STOP_TERMS.has(normalize(name)))
      .sort((a, b) => b.length - a.length)
      .map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'));
    this.pattern = names.length ? new RegExp(`\\b(?:${names.join('|')})(?:e?s)?\\b`, 'gi') : null;
  }

  // Resolves plurals and terms whose definition lives on a related term (e.g. "bulbel" → "bulblet").
  lookup(word) {
    const key = normalize(word);
    const candidates = [key, key.replace(/es$/, ''), key.replace(/s$/, '')];
    const term = candidates.map(candidate => this.terms.get(candidate)).find(Boolean);
    if (!term) return null;
    let definition = term.definition;
    let definedBy = null;
    if (!definition) {
      for (const [, relatedName] of term.related) {
        const related = this.terms.get(normalize(relatedName));
        if (related?.definition) {
          definition = related.definition;
          definedBy = related.name;
          break;
        }
      }
    }
    return { ...term, definition, definedBy };
  }

  annotate(root) {
    if (!this.pattern || !root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: node =>
        node.parentElement?.closest(SKIP_SELECTOR) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    for (const node of nodes) {
      const text = node.nodeValue;
      this.pattern.lastIndex = 0;
      let match;
      let last = 0;
      const fragment = document.createDocumentFragment();
      while ((match = this.pattern.exec(text))) {
        if (!this.lookup(match[0])) continue;
        fragment.append(text.slice(last, match.index));
        const span = document.createElement('span');
        span.className = 'gloss';
        span.dataset.gloss = match[0];
        span.textContent = match[0];
        fragment.append(span);
        last = match.index + match[0].length;
      }
      if (last === 0) continue;
      fragment.append(text.slice(last));
      node.replaceWith(fragment);
    }
  }
}
