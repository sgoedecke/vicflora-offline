import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { parseRoute, formatRoute, routesEqual } from '../web/public/modules/router.js';
import { createSearchIndex, searchUnified } from '../web/public/modules/search.js';
import { createNavigatorFromData, listSearchableKeys } from '../web/public/modules/dichotomous.js';
import { loadSpeciesIndex } from '../web/public/modules/species.js';

const searchIndexRaw = JSON.parse(
  await fs.readFile(new URL('../web/public/data/search-index.json', import.meta.url), 'utf8')
);
const speciesIndexRaw = JSON.parse(
  await fs.readFile(new URL('../web/public/data/species-index.json', import.meta.url), 'utf8')
);
const dichBundle = JSON.parse(
  await fs.readFile(new URL('../web/public/data/dichotomous-keys.json', import.meta.url), 'utf8')
);
const glossaryRaw = JSON.parse(
  await fs.readFile(new URL('../web/public/data/glossary.json', import.meta.url), 'utf8')
);
const taxonIndex = loadSpeciesIndex(speciesIndexRaw);
const searchIndex = createSearchIndex(searchIndexRaw, taxonIndex, glossaryRaw);

test('parseRoute and formatRoute round-trip all supported hash routes', () => {
  const cases = [
    ['', { view: 'home' }, '#/'],
    ['#/', { view: 'home' }, '#/'],
    ['#/key/1903', { view: 'key', keyId: '1903', leadId: null, mode: 'interactive' }, '#/key/1903'],
    [
      '#/key/1903/step/54321',
      { view: 'key', keyId: '1903', leadId: '54321', mode: 'interactive' },
      '#/key/1903/step/54321'
    ],
    [
      '#/key/1903/bracketed',
      { view: 'key', keyId: '1903', leadId: null, mode: 'bracketed' },
      '#/key/1903/bracketed'
    ],
    ['#/multi', { view: 'multi', keyId: null }, '#/multi'],
    [
      '#/multi/key-80a71d25-f9c5-4ff7-b64e-5888353f317c-complete.json',
      { view: 'multi', keyId: 'key-80a71d25-f9c5-4ff7-b64e-5888353f317c-complete.json' },
      '#/multi/key-80a71d25-f9c5-4ff7-b64e-5888353f317c-complete.json'
    ],
    [
      '#/taxon/862c3252-415d-40f6-9b69-7b02c5677f7c',
      { view: 'taxon', taxonId: '862c3252-415d-40f6-9b69-7b02c5677f7c' },
      '#/taxon/862c3252-415d-40f6-9b69-7b02c5677f7c'
    ],
    [
      '#/glossary/actinomorphic',
      { view: 'glossary', term: 'actinomorphic' },
      '#/glossary/actinomorphic'
    ],
    [
      '#/glossary/juvenile%20leaves',
      { view: 'glossary', term: 'juvenile leaves' },
      '#/glossary/juvenile%20leaves'
    ],
    ['#/about', { view: 'about' }, '#/about'],
    ['#/unknown/path', { view: 'home' }, '#/']
  ];

  for (const [input, expected, canonical] of cases) {
    const parsed = parseRoute(input);
    assert.deepEqual(parsed, expected, `parseRoute(${JSON.stringify(input)})`);
    assert.equal(formatRoute(parsed), canonical, `formatRoute(${JSON.stringify(expected)})`);
    assert.equal(routesEqual(parsed, parseRoute(canonical)), true);
  }

  assert.equal(
    routesEqual(parseRoute('#/key/1903'), parseRoute('#/key/1903/bracketed')),
    false
  );
  assert.equal(
    routesEqual(parseRoute('#/key/1903/step/1'), parseRoute('#/key/1903/step/2')),
    false
  );
});

test('bundled search-index.json and species-index.json cover all taxa, canonical dichotomous keys, and multi-access keys', () => {
  assert.equal(searchIndexRaw.multiAccessKeys.length, 11);
  assert.equal(taxonIndex.size, 8049);

  const expectedDichCount = listSearchableKeys(dichBundle).length;
  assert.equal(searchIndexRaw.dichotomousKeys.length, expectedDichCount);

  const mainGroups = searchIndexRaw.dichotomousKeys.find(k => k.id === '1903');
  assert.ok(mainGroups, 'Main Groups key 1903 must be in search-index.json');
  assert.match(mainGroups.title, /main groups/i);
});

test('unified search groups Multi-Access Keys, Dichotomous Keys, and Taxa together', () => {
  const acacia = searchUnified(searchIndex, 'Acacia');
  assert.ok(
    acacia.multiAccessKeys.some(k => /acacia/i.test(k.title)),
    'Acacia query should return Acacia multi-access key'
  );
  assert.ok(
    acacia.dichotomousKeys.some(k => k.title === 'Acacia'),
    'Acacia query should return Acacia dichotomous key'
  );
  assert.equal(acacia.taxa[0]?.name, 'Acacia');

  const wattles = searchUnified(searchIndex, 'wattles');
  assert.ok(
    wattles.taxa.some(t => /wattle/i.test(t.vernacular || '')),
    'Plural common name "wattles" should match wattle taxa'
  );

  const buttercup = searchUnified(searchIndex, 'buttercup');
  assert.ok(
    buttercup.taxa.some(t => /ranunculus/i.test(t.name) && /buttercup/i.test(t.vernacular || '')),
    '"buttercup" should match Ranunculus common names from search-index.json'
  );

  const key1903 = searchUnified(searchIndex, '1903');
  assert.equal(key1903.dichotomousKeys[0]?.id, '1903');

  const ssp = searchUnified(searchIndex, 'microsorum pustulatum ssp');
  assert.ok(
    ssp.taxa.some(t => /microsorum pustulatum subsp\./i.test(t.name)),
    '"ssp" shorthand should normalize to "subsp."'
  );

  const actinomorphic = searchUnified(searchIndex, 'actinomorphic');
  assert.equal(actinomorphic.glossaryTerms[0]?.name, 'actinomorphic');
  assert.ok(actinomorphic.glossaryTerms[0]?.preview, 'Glossary search result should include definition preview');

  const phyllodes = searchUnified(searchIndex, 'phyllodes');
  assert.ok(
    phyllodes.glossaryTerms.some(g => g.name === 'phyllode'),
    'Plural glossary query "phyllodes" should match "phyllode"'
  );
});

test('unified search expands common names across punctuation, alternates, and keys', () => {
  for (const key of searchIndexRaw.multiAccessKeys) {
    assert.doesNotMatch(key.title, /\b(?:of|in)\s+victoria\b/i, `multi-access card should omit "of/in Victoria": ${key.title}`);
  }

  const redGum = searchUnified(searchIndex, 'river red gum');
  assert.equal(redGum.taxa[0]?.name, 'Eucalyptus camaldulensis');

  const redgumCollapsed = searchUnified(searchIndex, 'redgum');
  assert.ok(redgumCollapsed.taxa.some(t => t.name === 'Eucalyptus camaldulensis'));

  const sweetBursaria = searchUnified(searchIndex, 'sweet bursaria');
  assert.equal(sweetBursaria.taxa[0]?.name, 'Bursaria spinosa');
  assert.equal(sweetBursaria.taxa[0]?.matchedVernacular, 'Sweet Bursaria');

  const ribbonGum = searchUnified(searchIndex, 'ribbon gum');
  assert.equal(ribbonGum.taxa[0]?.name, 'Eucalyptus viminalis');
  assert.equal(ribbonGum.taxa[0]?.matchedVernacular, 'Ribbon Gum');

  const featherHeads = searchUnified(searchIndex, 'feather heads');
  assert.equal(featherHeads.taxa[0]?.name, 'Ptilotus macrocephalus');
  assert.ok(featherHeads.dichotomousKeys.some(k => k.title === 'Ptilotus'));

  const wattles = searchUnified(searchIndex, 'wattles');
  assert.ok(wattles.multiAccessKeys.some(k => k.title === 'Acacia'));
  assert.ok(wattles.dichotomousKeys.some(k => k.title === 'Acacia'));

  const sheOak = searchUnified(searchIndex, 'she-oak');
  assert.ok(sheOak.taxa.some(t => /sheoak/i.test(t.vernacular || '')));

  const gunns = searchUnified(searchIndex, 'gunns alpine');
  assert.equal(gunns.taxa[0]?.name, 'Ranunculus gunnianus');
});

test('loadSpeciesIndex preserves keys, toKey, rank, and vernacular', () => {
  assert.equal(taxonIndex.size, 8049);
  const acacia = [...taxonIndex.values()].find(t => t.name === 'Acacia');
  assert.ok(acacia, 'Acacia genus entry should exist');
  assert.ok(acacia.toKey, 'Acacia genus should link to its dichotomous key');
  assert.ok(acacia.keys.length > 0, 'Acacia genus should record parent keys');
});

test('DichotomousNavigator.goToLead deep-links to any step and reconstructs parent history', () => {
  const nav = createNavigatorFromData(dichBundle.keys, '1903');
  const rootId = nav.currentNodeId;
  const rootOpts = nav.getOptions();
  const firstIdx = rootOpts.findIndex(opt => !opt.item);
  assert.ok(firstIdx >= 0, 'Key 1903 root should have non-terminal leads');
  const step1LeadId = String(rootOpts[firstIdx].lead.id);

  nav.chooseOption(firstIdx);
  const step1Opts = nav.getOptions();
  const secondIdx = step1Opts.findIndex(opt => !opt.item);
  assert.ok(secondIdx >= 0, 'Key 1903 step 1 should have non-terminal leads');
  const step2LeadId = String(step1Opts[secondIdx].lead.id);

  const fresh = createNavigatorFromData(dichBundle.keys, '1903');
  assert.equal(fresh.goToLead(step2LeadId), true);
  assert.equal(String(fresh.currentNodeId), step2LeadId);
  assert.equal(fresh.getHeader().step, 3);
  assert.equal(String(fresh.getParentLeadId()), step1LeadId);
  assert.ok(fresh.getOptions().length > 0, 'goToLead should populate options at target couplet');

  assert.equal(fresh.goToLead(step1LeadId), true);
  assert.equal(fresh.getHeader().step, 2);
  assert.equal(fresh.getParentLeadId(), rootId);

  assert.equal(fresh.goToLead('nonexistent-lead'), false);
});

test('DichotomousNavigator.navigateToKey tracks key-stack depth across linked keys, back, restart, and direct jumps', () => {
  const nav = createNavigatorFromData(dichBundle.keys, '1903');
  assert.equal(nav.getHeader().depth, 1);
  assert.equal(nav.getHeader().step, 1);

  const linkedItem = (dichBundle.keys['1903'].items || []).find(
    item => item?.toKey && dichBundle.keys[String(item.toKey)]
  );
  assert.ok(linkedItem, 'Key 1903 should have a linked child key');
  const childKeyId = String(linkedItem.toKey);

  assert.equal(nav.hasLinkedKey(childKeyId), true);
  nav.navigateToKey(childKeyId);
  assert.equal(nav.currentKeyId, childKeyId);
  assert.equal(nav.getHeader().depth, 2);
  assert.equal(nav.getHeader().step, 1);

  const childBranch = nav.getOptions().find(opt => !opt.item);
  assert.ok(childBranch, 'Child key should have a branch option');
  assert.equal(nav.goToLead(String(childBranch.lead.id)), true);
  assert.equal(nav.getHeader().depth, 2);
  assert.equal(nav.getHeader().step, 2);

  nav.resetCurrentKey();
  assert.equal(nav.currentKeyId, childKeyId);
  assert.equal(nav.getHeader().depth, 2);
  assert.equal(nav.getHeader().step, 1);

  // Returning to an ancestor unwinds the stack.
  nav.navigateToKey('1903');
  assert.equal(nav.currentKeyId, '1903');
  assert.equal(nav.getHeader().depth, 1);

  // Following the linked key again pushes depth back to 2.
  nav.navigateToKey(childKeyId);
  assert.equal(nav.getHeader().depth, 2);

  // Explicit resetStack (e.g. from unified search) starts fresh at depth 1.
  nav.navigateToKey(childKeyId, { resetStack: true });
  assert.equal(nav.currentKeyId, childKeyId);
  assert.equal(nav.getHeader().depth, 1);

  // Jumping to an unrelated key also starts fresh at depth 1.
  const unrelatedKeyId = Object.keys(dichBundle.keys).find(
    id => id !== childKeyId && !nav.hasLinkedKey(id)
  );
  assert.ok(unrelatedKeyId, 'Should find an unrelated key in the dataset');
  nav.navigateToKey(unrelatedKeyId);
  assert.equal(nav.currentKeyId, unrelatedKeyId);
  assert.equal(nav.getHeader().depth, 1);
});

test('manifest precaches search-index.json and router/search modules', async () => {
  const manifest = JSON.parse(
    await fs.readFile(new URL('../web/public/data/manifest.json', import.meta.url), 'utf8')
  );
  assert.ok(
    manifest.data.some(entry => entry.id === 'searchIndex' && entry.path === './data/search-index.json'),
    'manifest.data must include searchIndex'
  );
  assert.ok(manifest.shell.includes('./modules/router.js'), 'manifest.shell must include router.js');
  assert.ok(manifest.shell.includes('./modules/search.js'), 'manifest.shell must include search.js');
});
