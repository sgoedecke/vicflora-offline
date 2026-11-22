import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Glossary } from '../web/public/modules/glossary.js';
import {
  buildTaxonIndex,
  findInfraspecificTaxa,
  mergeDescriptionsIntoIndex,
  searchTaxa
} from '../web/public/modules/species.js';

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

test('mergeDescriptionsIntoIndex adds subspecies and taxonomic scopes to search', () => {
  const speciesId = '11111111-1111-1111-1111-111111111111';
  const subspId = '22222222-2222-2222-2222-222222222222';
  const genusId = '33333333-3333-3333-3333-333333333333';
  const keys = {
    10: {
      taxonomic_scope: {
        item_name: 'Microsorum',
        url: `https://vicflora.rbg.vic.gov.au/flora/taxon/${genusId}`
      },
      items: [
        {
          item_name: 'microsorum pustulatum',
          url: `https://vicflora.rbg.vic.gov.au/flora/taxon/${speciesId}`
        }
      ]
    }
  };
  const descriptions = {
    [genusId]: { name: 'Microsorum', rank: 'GENUS', vernacular: null },
    [speciesId]: { name: 'Microsorum pustulatum', rank: 'SPECIES', vernacular: 'Kangaroo Fern' },
    [subspId]: { name: 'Microsorum pustulatum subsp. pustulatum', rank: 'SUBSPECIES', vernacular: 'Kangaroo Fern' }
  };

  const index = buildTaxonIndex(keys);
  assert.equal(index.get(genusId).toKey, '10');
  assert.equal(index.has(subspId), false);

  mergeDescriptionsIntoIndex(index, descriptions);
  assert.equal(index.get(speciesId).name, 'Microsorum pustulatum');
  assert.equal(index.get(subspId).name, 'Microsorum pustulatum subsp. pustulatum');
  assert.deepEqual(index.get(subspId).keys, []);

  assert.equal(searchTaxa(index, 'microsorum pustulatum ssp', descriptions)[0].id, subspId);
  assert.equal(searchTaxa(index, 'microsorum pustulatum subspecies', descriptions)[0].id, subspId);

  assert.deepEqual(
    findInfraspecificTaxa(index, speciesId, descriptions).map(entry => entry.id),
    [subspId]
  );
  assert.deepEqual(findInfraspecificTaxa(index, genusId, descriptions), []);
  assert.deepEqual(findInfraspecificTaxa(index, subspId, descriptions), []);
});
