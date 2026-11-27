import { taxonUrlFromId } from './species.js';

// Lucid score codes (as used by VicFlora's Lucid player):
// 0 absent/unscored, 1 common, 2 rare, 3 uncertain, 4 common & misinterpreted,
// 5 rare & misinterpreted. VicFlora keys retain uncertain and misinterpreted
// scores, so any non-zero score counts as a match.
// Scores are compiled as compact digit strings ("01020..."), one char per entity.
function isMatchingScoreChar(code) {
  return code >= 49 && code <= 53; // '1'..'5'
}

// Lucid measures are [type, outsideMin, normalMin, normalMax, outsideMax].
// Type 3 means "uncertain" and matches any value.
function parseMeasure(raw) {
  if (!Array.isArray(raw) || !raw.length) return null;
  if (raw[0] === 3) return { any: true };
  if (raw.length < 5) return null;
  const [, outsideMin, normalMin, normalMax, outsideMax] = raw;
  const min = Number.isFinite(outsideMin) ? outsideMin : normalMin;
  const max = Number.isFinite(outsideMax) ? outsideMax : normalMax;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { any: false, min, max };
}

export class MultiAccessSession {
  constructor(keyData) {
    this.keyData = keyData;
    this.scores = keyData.scores || {};
    this.measures = keyData.measures || {};
    this.entities = keyData.entities || [];
    // Score strings are indexed by entity position, so keep both id and index.
    this.taxonIds = this.entities.map(entity => String(entity.id));
    this.taxonIndex = new Map(this.taxonIds.map((id, index) => [id, index]));
    this.entityById = new Map(this.entities.map(entity => [String(entity.id), entity]));
    this.featureById = new Map((keyData.features || []).map(feature => [feature.id, feature]));
    this.statesByFeature = new Map();
    (keyData.states || []).forEach(state => {
      if (!this.statesByFeature.has(state.feature)) {
        this.statesByFeature.set(state.feature, []);
      }
      this.statesByFeature.get(state.feature).push(state);
    });
    this.selectedStates = new Map();
    this.reset();
  }

  reset() {
    this.selectedStates.clear();
    this.recomputePossibleTaxa();
  }

  getCharacterById(characterId) {
    return this.featureById.get(characterId);
  }

  getStatesByCharacter(characterId) {
    return this.statesByFeature.get(characterId) || [];
  }

  getCharacterDisplayName(characterId) {
    const character = this.getCharacterById(characterId);
    if (!character) return `Character ${characterId}`;

    const name = (character.name || '').trim();
    const parent = character.parent ? this.getCharacterById(character.parent) : null;
    const parentName = (parent?.name || '').trim();
    const hasParentName = parentName.length > 0;

    if (character.type === 2 || name.length === 0) {
      if (hasParentName && name.length === 0) {
        return parentName;
      }
      if (hasParentName && name.length > 0) {
        if (parentName.toLowerCase() === name.toLowerCase()) {
          return parentName;
        }
        if (parentName.toLowerCase().includes(name.toLowerCase())) {
          return parentName;
        }
        return `${parentName} (${name})`;
      }
    }

    if (name.length > 0) {
      return name;
    }

    if (hasParentName) {
      return parentName;
    }

    return `Character ${characterId}`;
  }

  getSelection(characterId) {
    return this.selectedStates.get(characterId) || null;
  }

  stateMatchesTaxon(stateId, taxonId) {
    const row = this.scores[stateId] ?? this.scores[String(stateId)];
    if (!row) return false;
    const idx = this.taxonIndex.get(taxonId);
    if (idx === undefined) return false;
    return isMatchingScoreChar(row.charCodeAt(idx));
  }

  getMeasure(characterId, taxonId) {
    return parseMeasure(this.measures[String(characterId)]?.[taxonId]);
  }

  numericMatchesTaxon(characterId, taxonId, value) {
    const measure = this.getMeasure(characterId, taxonId);
    if (!measure) return false;
    return measure.any || (value >= measure.min && value <= measure.max);
  }

  taxonMatchesSelection(characterId, selection, taxonId) {
    if (selection.type === 'numeric') {
      return this.numericMatchesTaxon(characterId, taxonId, selection.value);
    }
    return this.stateMatchesTaxon(selection.value, taxonId);
  }

  recomputePossibleTaxa() {
    const selections = Array.from(this.selectedStates.entries());
    this.possibleTaxa = new Set();
    this.eliminatedTaxa = new Set();
    for (const taxonId of this.taxonIds) {
      const keep = selections.every(([characterId, selection]) =>
        this.taxonMatchesSelection(characterId, selection, taxonId)
      );
      (keep ? this.possibleTaxa : this.eliminatedTaxa).add(taxonId);
    }
  }

  // A character is worth asking about if some answer would remove some, but
  // not all, of the remaining taxa.
  isCharacterRelevant(characterId) {
    const character = this.getCharacterById(characterId);
    if (!character || this.possibleTaxa.size < 2) return false;

    if (character.type === 2) {
      const signatures = new Set();
      for (const taxonId of this.possibleTaxa) {
        const measure = this.getMeasure(characterId, taxonId);
        signatures.add(!measure ? 'none' : measure.any ? 'any' : `${measure.min}:${measure.max}`);
        if (signatures.size > 1) return true;
      }
      return false;
    }

    const total = this.possibleTaxa.size;
    return this.getStatesByCharacter(characterId).some(state => {
      let matches = 0;
      for (const taxonId of this.possibleTaxa) {
        if (this.stateMatchesTaxon(state.id, taxonId)) matches += 1;
      }
      return matches > 0 && matches < total;
    });
  }

  getRelevantCharacters() {
    const features = this.keyData.features || [];
    return features
      .filter(feature => {
        if (feature.type === 0 || this.selectedStates.has(feature.id)) {
          return false;
        }
        return this.isCharacterRelevant(feature.id);
      })
      .sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === 1 ? -1 : 1;
        }
        return (a.name || '').localeCompare(b.name || '');
      });
  }

  getTaxonName(taxonId) {
    const entity = this.entityById.get(String(taxonId));
    return entity?.name || `Taxon ${taxonId}`;
  }

  getTaxonId(taxonId) {
    const entity = this.entityById.get(String(taxonId));
    return entity?.taxonId || null;
  }

  getTaxonUrl(taxonId) {
    const entity = this.entityById.get(String(taxonId));
    if (!entity) return null;
    if (entity.taxonId) return taxonUrlFromId(entity.taxonId);
    return entity.url || null;
  }

  // Range of values across the remaining taxa that have a measurement.
  getMeasurementRange(characterId) {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let count = 0;

    for (const taxonId of this.possibleTaxa) {
      const measure = this.getMeasure(characterId, taxonId);
      if (!measure || measure.any) continue;
      if (measure.min < min) min = measure.min;
      if (measure.max > max) max = measure.max;
      count += 1;
    }

    return count ? { min, max, count } : null;
  }

  applySelection(characterId, selection) {
    const before = this.possibleTaxa.size;
    this.selectedStates.set(characterId, selection);
    this.recomputePossibleTaxa();
    return {
      eliminated: before - this.possibleTaxa.size,
      remaining: this.possibleTaxa.size
    };
  }

  chooseState(characterId, stateId) {
    const exists = this.getStatesByCharacter(characterId).some(state => state.id === stateId);
    if (!exists) {
      return { eliminated: 0, remaining: this.possibleTaxa.size };
    }
    return this.applySelection(characterId, { type: 'state', value: stateId });
  }

  applyNumericSelection(characterId, rawValue) {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) {
      return { eliminated: 0, remaining: this.possibleTaxa.size };
    }
    return this.applySelection(characterId, { type: 'numeric', value });
  }

  undoLastSelection() {
    const lastKey = Array.from(this.selectedStates.keys()).pop();
    if (lastKey === undefined) {
      return null;
    }

    const selection = this.selectedStates.get(lastKey);
    this.selectedStates.delete(lastKey);
    this.recomputePossibleTaxa();
    return {
      characterId: lastKey,
      selection
    };
  }

  serialize() {
    return Array.from(this.selectedStates.entries());
  }

  restore(entries) {
    this.selectedStates.clear();
    (entries || []).forEach(([characterId, selection]) => {
      if (!this.getCharacterById(characterId)) return;
      if (selection?.type === 'numeric' && Number.isFinite(selection.value)) {
        this.selectedStates.set(characterId, { type: 'numeric', value: selection.value });
      } else if (selection?.type === 'state' && this.getStatesByCharacter(characterId).some(s => s.id === selection.value)) {
        this.selectedStates.set(characterId, { type: 'state', value: selection.value });
      }
    });
    this.recomputePossibleTaxa();
  }

  remainingTaxa(limit = 25) {
    const list = Array.from(this.possibleTaxa)
      .map(id => ({
        id,
        name: this.getTaxonName(id),
        taxonId: this.getTaxonId(id),
        url: this.getTaxonUrl(id)
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      total: list.length,
      sample: list.slice(0, limit)
    };
  }

  selections() {
    const details = [];
    for (const [characterId, selection] of this.selectedStates) {
      const characterName = this.getCharacterDisplayName(characterId);
      if (selection?.type === 'numeric') {
        details.push({
          characterId,
          characterName,
          type: 'numeric',
          value: selection.value,
          stateId: null,
          stateName: `${selection.value}`
        });
        continue;
      }

      const state = this.getStatesByCharacter(characterId).find(s => s.id === selection?.value);
      details.push({
        characterId,
        characterName,
        type: 'state',
        stateId: selection?.value ?? null,
        stateName: state?.name || `State ${selection?.value}`
      });
    }
    return details;
  }
}

export function listMultiKeys(bundle) {
  return Object.entries(bundle || {})
    .map(([id, key]) => ({
      id,
      title: key.title || id,
      entities: key.entities?.length || 0,
      characters: key.features?.length || 0,
      data: key
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
}
