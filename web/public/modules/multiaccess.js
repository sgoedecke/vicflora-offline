function toSet(iterable) {
  return new Set(iterable);
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

  formatState(state) {
    return state.name || `State ${state.id}`;
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
    this.selectedStates.set(characterId, stateId);

    return {
      eliminated: eliminatedNow.size,
      remaining: newPossible.size
    };
  }

  undoSelection(characterId) {
    if (!this.selectedStates.has(characterId)) return;
    this.selectedStates.delete(characterId);
    this.recomputePossibleTaxa();
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

    const stateId = this.selectedStates.get(lastKey);
    this.selectedStates.delete(lastKey);
    this.recomputePossibleTaxa();
    return {
      characterId: lastKey,
      stateId
    };
  }

  recomputePossibleTaxa() {
    const snapshot = Array.from(this.selectedStates.entries());
    this.selectedStates.clear();

    this.possibleTaxa = toSet(Object.keys(this.keyData.decompressedScores || {}));
    this.eliminatedTaxa.clear();

    for (const [characterId, stateId] of snapshot) {
      this.chooseState(characterId, stateId);
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
    for (const [characterId, stateId] of this.selectedStates) {
      const state = this.getStatesByCharacter(characterId).find(s => s.id === stateId);
      details.push({
        characterId,
        characterName: this.getCharacterDisplayName(characterId),
        stateId,
        stateName: state?.name || `State ${stateId}`
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
      entities: key.entities?.length || 0,
      characters: key.features?.length || 0,
      data: key
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
}
