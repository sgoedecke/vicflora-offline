import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Glossary } from '../web/public/modules/glossary.js';
import { buildTaxonIndex, searchTaxa } from '../web/public/modules/species.js';

const glossary = new Glossary([
  { name: 'lobe', definition: '<p>a part of an organ.</p>', related: [] },
  { name: 'bulblet', definition: '<p>a small bulb.</p>', related: [] },
  { name: 'bulbel', definition: null, related: [['isVariationOf', 'bulblet']] },
  { name: 'flower', definition: '<p>reproductive structure.</p>', related: [] },
  { name: 'doubly toothed', definition: '<p>teeth on teeth.</p>', related: [] }
]);

test('glossary lookup resolves plurals and case', () => {
  assert.equal(glossary.lookup('Lobes').name, 'lobe');
  assert.equal(glossary.lookup('lobe').name, 'lobe');
  assert.equal(glossary.lookup('stem'), null);
});

test('glossary lookup borrows definitions from related terms', () => {
  const term = glossary.lookup('bulbel');
  assert.equal(term.definition, '<p>a small bulb.</p>');
  assert.equal(term.definedBy, 'bulblet');
});

test('glossary pattern skips stop terms but matches multi-word terms', () => {
  const matches = 'Flower lobes doubly  toothed'.match(glossary.pattern);
  assert.deepEqual(matches, ['lobes', 'doubly  toothed']);
});

test('species search matches scientific and common names', () => {
  const keys = {
    1: { items: [{ item_name: 'Ranunculus amplus', url: 'https://vicflora.rbg.vic.gov.au/flora/taxon/e4bf52c9-a442-45ec-ad1f-7b7106764dbd' }] }
  };
  const index = buildTaxonIndex(keys);
  const descriptions = { 'e4bf52c9-a442-45ec-ad1f-7b7106764dbd': { vernacular: 'Lacy River Buttercup' } };
  assert.equal(searchTaxa(index, 'ranun', descriptions)[0].name, 'Ranunculus amplus');
  assert.equal(searchTaxa(index, 'buttercup', descriptions)[0].name, 'Ranunculus amplus');
  assert.deepEqual(index.get('e4bf52c9-a442-45ec-ad1f-7b7106764dbd').keys, ['1']);
});
