import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { Glossary } from '../web/public/modules/glossary.js';
import {
  VICFLORA_TAXON_URL,
  findInfraspecificTaxa,
  findSoleInfraspecificProfile,
  hasOwnDescription,
  loadSpeciesIndex,
  searchTaxa,
  taxonUrlFromId
} from '../web/public/modules/species.js';

const require = createRequire(import.meta.url);
const {
  buildSpeciesIndexAndDescriptions,
  compileDichotomousKey
} = require('../scripts/build-web-data.js');

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

test('species search matches scientific and common names directly from species-index', () => {
  const id = 'e4bf52c9-a442-45ec-ad1f-7b7106764dbd';
  const compiledKeys = {
    1: compileDichotomousKey('1', {
      key_id: '1',
      key_title: 'Ranunculus',
      first_step: { root_node_id: 1 },
      items: [{ item_id: 1, item_name: 'Ranunculus amplus', url: `${VICFLORA_TAXON_URL}${id}` }],
      leads: []
    })
  };
  const rawDescriptions = {
    [id]: { name: 'Ranunculus amplus', rank: 'SPECIES', vernacular: 'Lacy River Buttercup', html: '<div class="description"><p>Herb.</p></div>' }
  };
  const { speciesIndex } = buildSpeciesIndexAndDescriptions(compiledKeys, {}, rawDescriptions);
  const index = loadSpeciesIndex({ taxa: speciesIndex });

  assert.equal(searchTaxa(index, 'ranun')[0].name, 'Ranunculus amplus');
  assert.equal(searchTaxa(index, 'buttercup')[0].name, 'Ranunculus amplus');
  assert.deepEqual(index.get(id).keys, ['1']);
  assert.equal(taxonUrlFromId(id), `${VICFLORA_TAXON_URL}${id}`);
});

test('compiled species-index precomputes subspecies, taxonomic scopes, and parent/child links', () => {
  const speciesId = '11111111-1111-1111-1111-111111111111';
  const subspId = '22222222-2222-2222-2222-222222222222';
  const genusId = '33333333-3333-3333-3333-333333333333';
  const compiledKeys = {
    10: compileDichotomousKey('10', {
      key_id: '10',
      key_title: 'Microsorum',
      first_step: { root_node_id: 1 },
      taxonomic_scope: {
        item_name: 'Microsorum',
        url: `${VICFLORA_TAXON_URL}${genusId}`
      },
      items: [
        {
          item_id: 1,
          item_name: 'microsorum pustulatum',
          url: `${VICFLORA_TAXON_URL}${speciesId}`
        }
      ],
      leads: []
    })
  };
  const rawDescriptions = {
    [genusId]: { name: 'Microsorum', rank: 'GENUS', vernacular: null },
    [speciesId]: { name: 'Microsorum pustulatum', rank: 'SPECIES', vernacular: 'Kangaroo Fern' },
    [subspId]: { name: 'Microsorum pustulatum subsp. pustulatum', rank: 'SUBSPECIES', vernacular: 'Kangaroo Fern' }
  };

  const { speciesIndex } = buildSpeciesIndexAndDescriptions(compiledKeys, {}, rawDescriptions);
  const index = loadSpeciesIndex({ taxa: speciesIndex });

  assert.equal(index.get(genusId).toKey, '10');
  assert.equal(index.get(speciesId).name, 'Microsorum pustulatum');
  assert.equal(index.get(subspId).name, 'Microsorum pustulatum subsp. pustulatum');
  assert.equal(index.get(subspId).parentId, speciesId);
  assert.deepEqual(index.get(speciesId).children, [subspId]);
  assert.deepEqual(index.get(subspId).keys, []);

  assert.equal(searchTaxa(index, 'microsorum pustulatum ssp')[0].id, subspId);
  assert.equal(searchTaxa(index, 'microsorum pustulatum subspecies')[0].id, subspId);

  assert.deepEqual(
    findInfraspecificTaxa(index, speciesId).map(entry => entry.id),
    [subspId]
  );
  assert.deepEqual(findInfraspecificTaxa(index, genusId), []);
  assert.deepEqual(findInfraspecificTaxa(index, subspId), []);
});

test('findSoleInfraspecificProfile resolves single-child species lacking a description in O(1)', () => {
  const spNoDesc = '11111111-1111-1111-1111-111111111111';
  const spNoDescVar = '22222222-2222-2222-2222-222222222222';
  const spWithDesc = '33333333-3333-3333-3333-333333333333';
  const spWithDescSubsp = '44444444-4444-4444-4444-444444444444';
  const spMulti = '55555555-5555-5555-5555-555555555555';
  const spMultiA = '66666666-6666-6666-6666-666666666666';
  const spMultiB = '77777777-7777-7777-7777-777777777777';

  const rawDescriptions = {
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

  const { speciesIndex, descriptions: slimDescriptions } = buildSpeciesIndexAndDescriptions({}, {}, rawDescriptions);
  const index = loadSpeciesIndex({ taxa: speciesIndex });

  assert.equal(hasOwnDescription(slimDescriptions[spNoDesc]), false);
  assert.equal(hasOwnDescription(slimDescriptions[spWithDesc]), true);
  assert.equal(index.get(spNoDesc).soleChildId, spNoDescVar);
  assert.equal(index.get(spWithDesc).soleChildId, null);
  assert.equal(index.get(spMulti).soleChildId, null);

  const resolved = findSoleInfraspecificProfile(index, spNoDesc, slimDescriptions);
  assert.equal(resolved?.entry.id, spNoDescVar);
  assert.equal(resolved?.entry.rank, 'VARIETY');
  assert.equal(findSoleInfraspecificProfile(index, spWithDesc, slimDescriptions), null);
  assert.equal(findSoleInfraspecificProfile(index, spMulti, slimDescriptions), null);
});

test('bundled species-index resolves Hypericum perforatum and Hibbertia fasciculata sole infraspecific profiles', () => {
  const speciesIndexData = JSON.parse(fs.readFileSync(new URL('../web/public/data/species-index.json', import.meta.url), 'utf8'));
  const descriptions = JSON.parse(fs.readFileSync(new URL('../web/public/data/descriptions.json', import.meta.url), 'utf8')).taxa;
  const index = loadSpeciesIndex(speciesIndexData);

  const hypericum = findSoleInfraspecificProfile(index, '6494d110-7304-47b0-9e13-19ddf43d9224', descriptions);
  assert.equal(hypericum?.entry.name, 'Hypericum perforatum subsp. veronense');
  assert.equal(hasOwnDescription(hypericum?.taxon), true);

  const hibbertia = findSoleInfraspecificProfile(index, '68cbbf3e-7606-4126-9176-030173b88c18', descriptions);
  assert.equal(hibbertia?.entry.name, 'Hibbertia fasciculata var. prostrata');
  assert.equal(hasOwnDescription(hibbertia?.taxon), true);
});

test('compiled JSON bundles are minified and strip duplicated metadata', () => {
  for (const rel of [
    '../web/public/data/dichotomous-keys.json',
    '../web/public/data/multi-keys.json',
    '../web/public/data/species-index.json',
    '../web/public/data/descriptions.json',
    '../web/public/data/glossary.json',
    '../web/public/data/bioregions.json'
  ]) {
    const raw = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
    assert.ok(!raw.includes('\n  '), `${rel} should be minified without pretty indentation`);
  }

  const dichRaw = fs.readFileSync(new URL('../web/public/data/dichotomous-keys.json', import.meta.url), 'utf8');
  assert.equal(dichRaw.includes(VICFLORA_TAXON_URL), false, 'dichotomous-keys.json must not repeat VicFlora taxon URL prefix');
  const dichData = JSON.parse(dichRaw);
  assert.ok(Array.isArray(dichData.searchableKeys) && dichData.searchableKeys.length > 0);
  const sampleKey = dichData.keys['1903'];
  assert.equal('source' in sampleKey, false);
  assert.equal('breadcrumbs' in sampleKey, false);
  assert.equal('created_by_id' in sampleKey, false);
  assert.equal('modified_by_id' in sampleKey, false);
  assert.equal('notes' in sampleKey, false);

  const descData = JSON.parse(fs.readFileSync(new URL('../web/public/data/descriptions.json', import.meta.url), 'utf8'));
  const sampleDesc = descData.taxa['6494d110-7304-47b0-9e13-19ddf43d9224'];
  assert.equal('name' in sampleDesc, false, 'descriptions.json omits index metadata moved to species-index.json');
  assert.equal('vernacular' in sampleDesc, false);
  assert.ok(typeof sampleDesc.html === 'string' && sampleDesc.html.length > 0);
});

test('app version badge is derived dynamically from the generated SW manifest', () => {
  const html = fs.readFileSync(new URL('../web/public/index.html', import.meta.url), 'utf8');
  const sw = fs.readFileSync(new URL('../web/public/service-worker.js', import.meta.url), 'utf8');
  const manifest = JSON.parse(
    fs.readFileSync(new URL('../web/public/data/manifest.json', import.meta.url), 'utf8')
  );
  const swManifestSrc = fs.readFileSync(new URL('../web/public/data/sw-manifest.js', import.meta.url), 'utf8');

  assert.match(html, /id="app-version"[^>]*class="app-version"/);
  assert.match(sw, /importScripts\('\.\/data\/sw-manifest\.js'\)/);
  assert.match(sw, /vicflora-shell-\$\{MANIFEST\.shellHash\}/);
  assert.ok(/^[a-f0-9]{12}$/.test(manifest.shellHash));
  assert.ok(swManifestSrc.includes(manifest.shellHash));
});
