import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MultiAccessSession } from '../web/public/modules/multiaccess.js';
import { createNavigatorFromData } from '../web/public/modules/dichotomous.js';

const readJSON = file => JSON.parse(readFileSync(new URL(`../web/public/data/${file}`, import.meta.url)));
const multiKeys = readJSON('multi-keys.json').keys;
const dichKeys = readJSON('dichotomous-keys.json').keys;

// Independent reading of the raw Lucid data: scores are a state x taxon matrix
// where 1-5 mean present (common, rare, uncertain, misinterpreted).
function expectedForState(key, stateId) {
  const row = key.decompressedScores[stateId];
  return key.entities.filter((_, i) => row[i] >= 1 && row[i] <= 5).map(e => String(e.id)).sort();
}

function expectedForMeasure(key, characterId, value) {
  const measures = key.decompressedMeasures[String(characterId)] || {};
  return key.entities
    .filter(e => {
      const m = measures[String(e.id)];
      if (!m) return false;
      if (m[0] === 3) return true;
      return m.length === 5 && value >= m[1] && value <= m[4];
    })
    .map(e => String(e.id))
    .sort();
}

const sorted = set => [...set].sort();
const familiesKey = Object.values(multiKeys).find(k => k.title.includes('families of flowering plants'));
const lifeform = familiesKey.features.find(f => f.name === 'Habit' && f.type === 1);

test('every key starts with all of its taxa', () => {
  for (const key of Object.values(multiKeys)) {
    const session = new MultiAccessSession(key);
    assert.equal(session.possibleTaxa.size, key.entities.length, key.title);
  }
});

test('regression: Habit = Tree keeps only tree families', () => {
  const session = new MultiAccessSession(familiesKey);
  const tree = session.getStatesByCharacter(lifeform.id).find(s => s.name === 'Tree');
  const result = session.chooseState(lifeform.id, tree.id);
  const names = session.remainingTaxa(Infinity).sample.map(t => t.name);
  assert.equal(result.remaining, 53);
  assert.ok(names.includes('Myrtaceae'));
  assert.ok(!names.includes('Aizoaceae'));
});

test('every single state selection matches the raw score matrix', () => {
  for (const key of Object.values(multiKeys)) {
    const session = new MultiAccessSession(key);
    for (const state of key.states) {
      session.reset();
      session.chooseState(state.feature, state.id);
      assert.deepEqual(sorted(session.possibleTaxa), expectedForState(key, state.id), `${key.title}: ${state.name}`);
    }
  }
});

test('selections on different characters combine with AND, and undo reverses them', () => {
  const session = new MultiAccessSession(familiesKey);
  const [first, second] = familiesKey.features.filter(f => f.type === 1);
  const stateA = session.getStatesByCharacter(first.id)[0];
  const stateB = session.getStatesByCharacter(second.id)[0];
  session.chooseState(first.id, stateA.id);
  const afterFirst = sorted(session.possibleTaxa);
  session.chooseState(second.id, stateB.id);
  const matchesB = new Set(expectedForState(familiesKey, stateB.id));
  assert.deepEqual(sorted(session.possibleTaxa), expectedForState(familiesKey, stateA.id).filter(id => matchesB.has(id)));
  assert.equal(session.possibleTaxa.size + session.eliminatedTaxa.size, familiesKey.entities.length);

  assert.equal(session.undoLastSelection().characterId, second.id);
  assert.deepEqual(sorted(session.possibleTaxa), afterFirst);
});

test('numeric selections use the outside range and keep uncertain taxa', () => {
  let checked = 0;
  for (const key of Object.values(multiKeys)) {
    for (const [characterId, measures] of Object.entries(key.decompressedMeasures || {})) {
      const sample = Object.values(measures).find(m => m && m[0] === 1 && m.length === 5);
      if (!sample) continue;
      for (const value of [sample[1], sample[4], (sample[2] + sample[3]) / 2]) {
        const session = new MultiAccessSession(key);
        session.applyNumericSelection(Number(characterId), value);
        assert.deepEqual(sorted(session.possibleTaxa), expectedForMeasure(key, characterId, value), `${key.title}: char ${characterId} = ${value}`);
        checked += 1;
      }
    }
  }
  assert.ok(checked > 0);
});

test('relevant characters always split the remaining taxa', () => {
  const session = new MultiAccessSession(familiesKey);
  session.chooseState(lifeform.id, session.getStatesByCharacter(lifeform.id)[0].id);
  const relevant = session.getRelevantCharacters();
  assert.ok(relevant.length > 0);
  assert.ok(!relevant.some(c => c.id === lifeform.id));
  for (const character of relevant.filter(c => c.type === 1)) {
    const counts = session.getStatesByCharacter(character.id).map(state =>
      [...session.possibleTaxa].filter(id => session.stateMatchesTaxon(state.id, id)).length
    );
    assert.ok(counts.some(n => n > 0 && n < session.possibleTaxa.size), character.name);
  }
});

test('multi-access selections survive serialize/restore', () => {
  const session = new MultiAccessSession(familiesKey);
  session.chooseState(lifeform.id, session.getStatesByCharacter(lifeform.id)[1].id);
  const saved = JSON.parse(JSON.stringify(session.serialize()));

  const restored = new MultiAccessSession(familiesKey);
  restored.restore(saved);
  assert.deepEqual(sorted(restored.possibleTaxa), sorted(session.possibleTaxa));
  assert.deepEqual(restored.selections(), session.selections());

  const ignoresBadData = new MultiAccessSession(familiesKey);
  ignoresBadData.restore([[999999, { type: 'state', value: 1 }], [lifeform.id, { type: 'state', value: -1 }]]);
  assert.equal(ignoresBadData.possibleTaxa.size, familiesKey.entities.length);
});

test('dichotomous progress survives serialize/restore, including across linked keys', () => {
  // Find a path of option indices from the root of key 1903 to a link into another key.
  function pathToLink() {
    const queue = [[]];
    while (queue.length) {
      const path = queue.shift();
      const probe = createNavigatorFromData(dichKeys, '1903');
      path.forEach(i => probe.chooseOption(i));
      const options = probe.getOptions();
      const linkIndex = options.findIndex(o => o.item?.to_key);
      if (linkIndex >= 0) return [...path, linkIndex];
      options.forEach((o, i) => { if (!o.item) queue.push([...path, i]); });
    }
    return null;
  }

  const nav = createNavigatorFromData(dichKeys, '1903');
  pathToLink().forEach(i => nav.chooseOption(i));
  const continueIndex = nav.getOptions().findIndex(o => !o.item);
  if (continueIndex >= 0) nav.chooseOption(continueIndex);
  assert.ok(nav.stack.length >= 2, 'walk should cross into a linked key');
  const saved = JSON.parse(JSON.stringify(nav.serialize()));

  const restored = createNavigatorFromData(dichKeys, saved.startKeyId);
  restored.restore(saved);
  assert.deepEqual(restored.serialize(), nav.serialize());
  assert.deepEqual(restored.getHeader(), nav.getHeader());
  assert.deepEqual(restored.getOptions().map(o => o.lead.lead_id), nav.getOptions().map(o => o.lead.lead_id));

  assert.throws(() => restored.restore({ stack: [{ keyId: 'missing', currentLeadId: 1, history: [] }] }));
});
