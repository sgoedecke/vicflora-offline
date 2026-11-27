import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MultiAccessSession } from '../web/public/modules/multiaccess.js';
import { createNavigatorFromData, listSearchableKeys } from '../web/public/modules/dichotomous.js';

const readJSON = file => JSON.parse(readFileSync(new URL(`../web/public/data/${file}`, import.meta.url)));
const multiBundle = readJSON('multi-keys.json');
const dichBundle = readJSON('dichotomous-keys.json');
const multiKeys = multiBundle.keys;
const dichKeys = dichBundle.keys;

// Independent reading of the compiled Lucid score strings ('0'-'5' per taxon index)
// where 1-5 mean present (common, rare, uncertain, misinterpreted).
function expectedForState(key, stateId) {
  const row = key.scores[stateId];
  return key.entities
    .filter((_, i) => {
      const score = row.charCodeAt(i) - 48;
      return score >= 1 && score <= 5;
    })
    .map(e => String(e.id))
    .sort();
}

function expectedForMeasure(key, characterId, value) {
  const measures = key.measures[String(characterId)] || {};
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
const familiesKey = Object.values(multiKeys).find(k => k.title.toLowerCase().includes('families of flowering plants'));
const lifeform = familiesKey.features.find(f => f.name === 'Habit' && f.type === 1);

test('compiled multi-access keys use clean IDs, clean titles, and compact score strings', () => {
  for (const [keyId, key] of Object.entries(multiKeys)) {
    assert.ok(!keyId.startsWith('key-') && !keyId.endsWith('.json'), `dirty multi-key id: ${keyId}`);
    assert.ok(key.title && !key.title.endsWith('.json'), `dirty title: ${key.title}`);
    assert.equal('decompressedScores' in key, false);
    assert.equal('decompressedMeasures' in key, false);
    for (const [stateId, row] of Object.entries(key.scores)) {
      assert.equal(typeof row, 'string', `${keyId} state ${stateId} should be a digit string`);
      assert.equal(row.length, key.entities.length);
    }
  }
});

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
    for (const [characterId, measures] of Object.entries(key.measures || {})) {
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
      const linkIndex = options.findIndex(o => o.item?.toKey);
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
  assert.deepEqual(restored.getOptions().map(o => o.lead.id), nav.getOptions().map(o => o.lead.id));

  assert.throws(() => restored.restore({ stack: [{ keyId: 'missing', currentLeadId: 1, history: [] }] }));
});

test('dichotomous search lists every key title once, picking the canonical copy', () => {
  const entries = listSearchableKeys(dichBundle);
  assert.deepEqual(entries, dichBundle.searchableKeys);
  const titles = entries.map(e => e.title);
  assert.equal(new Set(titles).size, titles.length);
  assert.equal(new Set(Object.values(dichKeys).map(k => k.title)).size, titles.length);

  const idFor = title => entries.find(e => e.title === title)?.id;
  assert.equal(idFor('Hibbertia'), '2245');
  // Linked from the Taraxacum key (and has the 2023 edits), unlike orphaned 9769
  assert.equal(idFor('Taraxacum species group 1 in Victoria'), '9770');
  // 6144 is an orphaned re-upload with scope/geography swapped
  assert.equal(idFor('Nematolepis'), '4212');
  // Both linked from the dicot family key; 5871 is the later edit
  assert.equal(idFor('Proteaceae'), '5871');
});

test('bracketed layout numbers every couplet depth-first and covers every lead', () => {
  for (const [id, key] of Object.entries(dichKeys)) {
    const { couplets } = createNavigatorFromData(dichKeys, id).getBracketed();
    const realLeads = key.leads.filter(lead => lead.text !== '[link through]');
    assert.equal(couplets.flatMap(c => c.leads).length, realLeads.length, `key ${id}`);
    couplets.forEach((couplet, index) => {
      assert.equal(couplet.number, index + 1);
      for (const lead of couplet.leads) {
        assert.ok(lead.item || lead.goto > couplet.number, `key ${id} couplet ${couplet.number} dead end`);
        if (lead.goto) assert.equal(couplets[lead.goto - 1].parentNumber, couplet.number);
      }
    });
  }

  const { couplets } = createNavigatorFromData(dichKeys, '2245').getBracketed();
  assert.equal(couplets[0].leads[0].goto, 2);
  assert.equal(couplets[1].parentNumber, 1);
});

test('bracketed view tracks the step-by-step position', () => {
  const nav = createNavigatorFromData(dichKeys, '2245');
  nav.chooseOption(0);
  nav.chooseOption(0);
  const { numberByNode, currentNodeId, pathNodeIds } = nav.getBracketed();
  assert.equal(numberByNode.get(currentNodeId), 3);
  assert.deepEqual(pathNodeIds.map(n => numberByNode.get(n)), [1, 2]);
});

test('"[link through]" leads continue into the single member\'s key', () => {
  const nav = createNavigatorFromData(dichKeys, '1904');
  const path = [];
  const find = () => nav.getOptions().findIndex(o => o.item?.name === 'Isoetaceae');
  // Walk the ferns key until the Isoetaceae lead is offered.
  const walk = () => {
    if (find() >= 0) return true;
    const options = nav.getOptions();
    for (let i = 0; i < options.length; i++) {
      if (options[i].item) continue;
      nav.chooseOption(i);
      path.push(i);
      if (walk()) return true;
      nav.back();
      path.pop();
    }
    return false;
  };
  assert.ok(walk());
  const option = nav.getOptions()[find()];
  assert.equal(option.via?.name, 'Isoetes');
  const outcome = nav.chooseOption(find());
  assert.equal(outcome.type, 'key-transition');
  assert.equal(nav.getHeader().keyId, '1914');
  assert.ok(nav.exitKey());
  assert.equal(nav.getHeader().keyId, '1904');
});
