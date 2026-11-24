import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Glossary } from '../web/public/modules/glossary.js';
import {
  buildTaxonIndex,
  findInfraspecificTaxa,
  findSoleInfraspecificProfile,
  hasOwnDescription,
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

test('findSoleInfraspecificProfile resolves single-child species lacking a description', () => {
  const spNoDesc = '11111111-1111-1111-1111-111111111111';
  const spNoDescVar = '22222222-2222-2222-2222-222222222222';
  const spWithDesc = '33333333-3333-3333-3333-333333333333';
  const spWithDescSubsp = '44444444-4444-4444-4444-444444444444';
  const spMulti = '55555555-5555-5555-5555-555555555555';
  const spMultiA = '66666666-6666-6666-6666-666666666666';
  const spMultiB = '77777777-7777-7777-7777-777777777777';

  const descriptions = {
    [spNoDesc]: {
      name: 'Hibbertia fasciculata',
      rank: 'SPECIES',
      html: '<div class="notes"><p>1 variety in Victoria. Profile provided under variety.</p></div>'
    },
    [spNoDescVar]: {
      name: 'Hibbertia fasciculata var. prostrata',
      rank: 'VARIETY',
      html: '<div class="description"><p>Erect to spreading shrubs.</p></div>'
    },
    [spWithDesc]: {
      name: 'Acacia dealbata',
      rank: 'SPECIES',
      html: '<div class="description"><p>Tree or shrub.</p></div>'
    },
    [spWithDescSubsp]: {
      name: 'Acacia dealbata subsp. dealbata',
      rank: 'SUBSPECIES',
      html: '<div class="description"><p>Tall tree.</p></div>'
    },
    [spMulti]: {
      name: 'Sinapis alba',
      rank: 'SPECIES',
      html: '<div class="notes"><p>2 subspecies in Victoria.</p></div>'
    },
    [spMultiA]: {
      name: 'Sinapis alba subsp. alba',
      rank: 'SUBSPECIES',
      html: '<div class="description"><p>Subsp. alba.</p></div>'
    },
    [spMultiB]: {
      name: 'Sinapis alba subsp. dissecta',
      rank: 'SUBSPECIES',
      html: '<div class="description"><p>Subsp. dissecta.</p></div>'
    }
  };

  const index = buildTaxonIndex({}, descriptions);
  assert.equal(hasOwnDescription(descriptions[spNoDesc]), false);
  assert.equal(hasOwnDescription(descriptions[spWithDesc]), true);

  const resolved = findSoleInfraspecificProfile(index, spNoDesc, descriptions);
  assert.equal(resolved?.entry.id, spNoDescVar);
  assert.equal(resolved?.taxon.rank, 'VARIETY');
  assert.equal(findSoleInfraspecificProfile(index, spWithDesc, descriptions), null);
  assert.equal(findSoleInfraspecificProfile(index, spMulti, descriptions), null);
});

test('bundled Hypericum perforatum and Hibbertia fasciculata resolve their sole infraspecific profiles', () => {
  const keys = JSON.parse(fs.readFileSync(new URL('../web/public/data/dichotomous-keys.json', import.meta.url), 'utf8')).keys;
  const descriptions = JSON.parse(fs.readFileSync(new URL('../web/public/data/descriptions.json', import.meta.url), 'utf8')).taxa;
  const index = buildTaxonIndex(keys, descriptions);

  const hypericum = findSoleInfraspecificProfile(index, '6494d110-7304-47b0-9e13-19ddf43d9224', descriptions);
  assert.equal(hypericum?.entry.name, 'Hypericum perforatum subsp. veronense');
  assert.equal(hasOwnDescription(hypericum?.taxon), true);

  const hibbertia = findSoleInfraspecificProfile(index, '68cbbf3e-7606-4126-9176-030173b88c18', descriptions);
  assert.equal(hibbertia?.entry.name, 'Hibbertia fasciculata var. prostrata');
  assert.equal(hasOwnDescription(hibbertia?.taxon), true);
});

test('displayed app version matches service worker cache version', () => {
  const html = fs.readFileSync(new URL('../web/public/index.html', import.meta.url), 'utf8');
  const sw = fs.readFileSync(new URL('../web/public/service-worker.js', import.meta.url), 'utf8');
  const htmlVersion = html.match(/class="app-version"[^>]*>(v\d+)</)?.[1];
  const swVersion = sw.match(/CACHE_NAME\s*=\s*'vicflora-offline-(v\d+)'/)?.[1];
  assert.ok(htmlVersion, 'Expected .app-version badge in index.html');
  assert.equal(htmlVersion, swVersion);
});
