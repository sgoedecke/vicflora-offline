function toSet(iterable) {
  return new Set(iterable);
}

function titleCase(value) {
  return value.replace(/\w+/g, word => {
    const lower = word.toLowerCase();
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  });
}

function normalizeKeyTitle(title) {
  if (!title) return '';
  const pattern = /^(?:multi[\s-]*access\s+key|key)\s+to\s+(?:the\s+)?/i;
  let cleaned = title.trim().replace(pattern, '').trim();
  return cleaned ? titleCase(cleaned) : titleCase(title.trim());
}

export class MultiAccessSession {
  constructor(keyData) {
    this.keyData = keyData;
    this.selectedStates = new Map();
    this.eliminatedTaxa = new Set();
    this.reset();
  }

  reset() {
    const scores = this.keyData.decompressedScores || {};
    this.possibleTaxa = toSet(Object.keys(scores));
    this.selectedStates.clear();
    this.eliminatedTaxa.clear();
  }

  getCharacterById(characterId) {
    return this.keyData.features?.find(f => f.id === characterId);
  }

  getStatesByCharacter(characterId) {
    return this.keyData.states?.filter(s => s.feature === characterId) || [];
  }

  getCharacterIndex(characterId) {
    return this.keyData.features?.findIndex(f => f.id === characterId) ?? -1;
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

  isCharacterRelevant(characterId) {
    const charIndex = this.getCharacterIndex(characterId);
    if (charIndex === -1) return false;

    const stateValues = new Set();
    for (const taxonId of this.possibleTaxa) {
      const scores = this.keyData.decompressedScores[taxonId];
      if (!scores || scores[charIndex] === undefined) continue;
      stateValues.add(scores[charIndex]);
      if (stateValues.size > 1) return true;
    }
    return stateValues.size > 1;
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
    const entity = this.keyData.entities?.find(e => String(e.id) === String(taxonId));
    return entity?.name || entity?.title || `Taxon ${taxonId}`;
  }

  getTaxonUrl(taxonId) {
    const entity = this.keyData.entities?.find(e => String(e.id) === String(taxonId));
    if (!entity) return null;

    if (entity.url) return entity.url;

    const profileEntry = entity.text?.find(item => typeof item?.path === 'string' && item.path.includes('/flora/taxon/'));
    return profileEntry?.path || null;
  }

  getMeasurementRange(characterId) {
    const measures = this.keyData.decompressedMeasures?.[String(characterId)];
    if (!measures) return null;

    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let count = 0;

    for (const values of Object.values(measures)) {
      if (!Array.isArray(values)) continue;
      const numericValues = values.slice(1).filter(value => typeof value === 'number' && !Number.isNaN(value));
      if (!numericValues.length) continue;
      const localMin = Math.min(...numericValues);
      const localMax = Math.max(...numericValues);
      if (localMin < min) min = localMin;
      if (localMax > max) max = localMax;
      count += 1;
    }

    if (!count || !Number.isFinite(min) || !Number.isFinite(max)) {
      return null;
    }

    return { min, max, count };
  }

  chooseState(characterId, stateId) {
    const stateList = this.getStatesByCharacter(characterId);
    const selectedIndex = stateList.findIndex(state => state.id === stateId);
    if (selectedIndex === -1) {
      return { eliminated: 0, remaining: this.possibleTaxa.size };
    }

    const newPossible = new Set();
    const eliminatedNow = new Set();
    const charIndex = this.getCharacterIndex(characterId);

    for (const taxonId of this.possibleTaxa) {
      const scores = this.keyData.decompressedScores[taxonId];
      if (!scores) continue;
      const value = scores[charIndex];
      const matches =
        value === selectedIndex ||
        value === 2 ||
        value === 4;
      if (matches) {
        newPossible.add(taxonId);
      } else {
        eliminatedNow.add(taxonId);
        this.eliminatedTaxa.add(taxonId);
      }
    }

    this.possibleTaxa = newPossible;
    this.selectedStates.set(characterId, { type: 'state', value: stateId });

    return {
      eliminated: eliminatedNow.size,
      remaining: newPossible.size
    };
  }

  applyNumericSelection(characterId, rawValue) {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) {
      return { eliminated: 0, remaining: this.possibleTaxa.size };
    }

    const measures = this.keyData.decompressedMeasures?.[String(characterId)] || {};
    const newPossible = new Set();
    const eliminatedNow = new Set();

    for (const taxonId of this.possibleTaxa) {
      const measurement = measures[String(taxonId)] ?? measures[taxonId];
      if (!Array.isArray(measurement) || measurement.length < 2) {
        eliminatedNow.add(taxonId);
        this.eliminatedTaxa.add(taxonId);
        continue;
      }

      const numericValues = measurement.slice(1).filter(num => typeof num === 'number' && !Number.isNaN(num));
      if (!numericValues.length) {
        eliminatedNow.add(taxonId);
        this.eliminatedTaxa.add(taxonId);
        continue;
      }

      const min = Math.min(...numericValues);
      const max = Math.max(...numericValues);
      if (value >= min && value <= max) {
        newPossible.add(taxonId);
      } else {
        eliminatedNow.add(taxonId);
        this.eliminatedTaxa.add(taxonId);
      }
    }

    this.possibleTaxa = newPossible;
    this.selectedStates.set(characterId, { type: 'numeric', value });

    return {
      eliminated: eliminatedNow.size,
      remaining: newPossible.size
    };
  }

  undoLastSelection() {
    if (this.selectedStates.size === 0) {
      return null;
    }

    let lastKey;
    for (const key of this.selectedStates.keys()) {
      lastKey = key;
    }
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

  recomputePossibleTaxa() {
    const snapshot = Array.from(this.selectedStates.entries());
    this.selectedStates.clear();

    this.possibleTaxa = toSet(Object.keys(this.keyData.decompressedScores || {}));
    this.eliminatedTaxa.clear();

    for (const [characterId, selection] of snapshot) {
      if (!selection) continue;
      if (selection.type === 'numeric') {
        this.applyNumericSelection(characterId, selection.value);
      } else {
        this.chooseState(characterId, selection.value);
      }
    }
  }

  remainingTaxa(limit = 25) {
    const list = Array.from(this.possibleTaxa)
      .map(id => ({ id, name: this.getTaxonName(id), url: this.getTaxonUrl(id) }))
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
    .map(([fileName, key]) => ({
      id: fileName,
      title: key.title || fileName,
      displayTitle: normalizeKeyTitle(key.title || fileName),
      entities: key.entities?.length || 0,
      characters: key.features?.length || 0,
      data: key
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
}
