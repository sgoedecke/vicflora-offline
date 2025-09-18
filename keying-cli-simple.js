#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');
const readline = require('readline');

// Use a simpler approach with readline but configured to minimize echo issues
function createInterface() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });
  return rl;
}

function askQuestion(rl, question) {
  return new Promise((resolve) => {
    // Write the question directly to stdout
    process.stdout.write(question);

    // Listen for a single line of input
    rl.once('line', (answer) => {
      resolve(answer.trim());
    });
  });
}

class KeyingCLI {
  constructor() {
    this.keyData = null;
    this.selectedStates = new Map();
    this.possibleTaxa = new Set();
    this.eliminatedTaxa = new Set();
  }

  async loadKey(keyFile) {
    try {
      const data = await fs.readFile(keyFile, 'utf8');
      this.keyData = JSON.parse(data);

      this.possibleTaxa = new Set(Object.keys(this.keyData.decompressedScores || {}));

      console.log(`\n🌿 ${this.keyData.title}`);
      console.log(`📊 ${this.keyData.entities?.length || 0} taxa, ${this.keyData.features?.length || 0} characters`);
      console.log(`🎯 Starting with ${this.possibleTaxa.size} possible taxa\n`);

      return true;
    } catch (error) {
      console.error(`Error loading key: ${error.message}`);
      return false;
    }
  }

  getCharacterById(characterId) {
    return this.keyData.features?.find(f => f.id === characterId);
  }

  getStatesByCharacter(characterId) {
    return this.keyData.states?.filter(s => s.feature === characterId) || [];
  }

  isCharacterRelevant(characterId) {
    const remainingTaxa = Array.from(this.possibleTaxa);
    const stateValues = new Set();

    for (const taxonId of remainingTaxa) {
      const scores = this.keyData.decompressedScores[taxonId];
      if (!scores) continue;

      const characterIndex = this.keyData.features.findIndex(f => f.id === characterId);
      if (characterIndex === -1 || scores[characterIndex] === undefined) continue;

      stateValues.add(scores[characterIndex]);
    }

    return stateValues.size > 1;
  }

  getRelevantCharacters() {
    if (!this.keyData.features) return [];

    return this.keyData.features
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

  updatePossibleTaxa(characterId, selectedStateId) {
    const newPossible = new Set();
    const newEliminated = new Set();

    const states = this.getStatesByCharacter(characterId);
    const selectedStatePosition = states.findIndex(state => state.id === selectedStateId);

    if (selectedStatePosition === -1) {
      console.log(`Warning: Could not find state ${selectedStateId} for character ${characterId}`);
      return { eliminated: 0, remaining: this.possibleTaxa.size };
    }

    for (const taxonId of this.possibleTaxa) {
      const scores = this.keyData.decompressedScores[taxonId];
      if (!scores) continue;

      const characterIndex = this.keyData.features.findIndex(f => f.id === characterId);
      if (characterIndex === -1) continue;

      const taxonValue = scores[characterIndex];

      const matches = taxonValue === selectedStatePosition ||
                     taxonValue === 2 ||
                     taxonValue === 4;

      if (matches) {
        newPossible.add(taxonId);
      } else {
        newEliminated.add(taxonId);
        this.eliminatedTaxa.add(taxonId);
      }
    }

    this.possibleTaxa = newPossible;
    return { eliminated: newEliminated.size, remaining: newPossible.size };
  }

  getTaxonName(taxonId) {
    const entity = this.keyData.entities?.find(e => e.id === parseInt(taxonId));
    return entity?.name || entity?.title || `Taxon ${taxonId}`;
  }

  formatStateDescription(state) {
    let desc = state.name || `State ${state.id}`;

    if (state.text) {
      try {
        const links = typeof state.text === 'string' ? JSON.parse(state.text) : state.text;
        if (Array.isArray(links)) {
          const hasImage = links.some(link => link.caption === 'Image');
          const hasInfo = links.some(link => link.caption === 'Information');
          if (hasImage) desc += ' 📷';
          if (hasInfo) desc += ' ℹ️';
        }
      } catch (e) {
        // Ignore parsing errors
      }
    }

    return desc;
  }

  showRemainingCandidates() {
    console.log('\n📋 Remaining candidates:');

    const sortedTaxa = Array.from(this.possibleTaxa)
      .map(id => ({ id, name: this.getTaxonName(id) }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const maxToShow = this.possibleTaxa.size <= 20 ? this.possibleTaxa.size : 20;

    sortedTaxa.slice(0, maxToShow).forEach((taxon, i) => {
      console.log(`  ${i + 1}. ${taxon.name}`);
    });

    if (this.possibleTaxa.size > maxToShow) {
      console.log(`  ... and ${this.possibleTaxa.size - maxToShow} more`);
    }

    // Show progress info
    const totalTaxa = this.possibleTaxa.size + this.eliminatedTaxa.size;
    const progress = Math.round((this.eliminatedTaxa.size / totalTaxa) * 100);
    console.log(`\n🔍 Progress: ${this.eliminatedTaxa.size}/${totalTaxa} eliminated (${progress}%)`);

    // Show current selections if any
    if (this.selectedStates.size > 0) {
      console.log('\n📝 Your selections so far:');
      for (const [charId, stateId] of this.selectedStates) {
        const char = this.getCharacterById(charId);
        const state = this.keyData.states?.find(s => s.id === stateId);
        console.log(`   • ${char?.name || `Character ${charId}`}: ${state?.name || `State ${stateId}`}`);
      }
    }

    console.log(''); // Empty line
  }

  displayResults() {
    console.log('\n' + '='.repeat(60));
    console.log('🔬 IDENTIFICATION RESULTS');
    console.log('='.repeat(60));

    if (this.possibleTaxa.size === 0) {
      console.log('❌ No taxa match your selections. You may have made an error.');
      console.log('Try backing out and selecting different character states.');
    } else if (this.possibleTaxa.size === 1) {
      const taxonId = Array.from(this.possibleTaxa)[0];
      const name = this.getTaxonName(taxonId);
      console.log(`🎯 IDENTIFIED: ${name}`);
      console.log(`\nTaxon ID: ${taxonId}`);
    } else {
      console.log(`🤔 ${this.possibleTaxa.size} possible taxa remaining:\n`);

      const sortedTaxa = Array.from(this.possibleTaxa)
        .map(id => ({ id, name: this.getTaxonName(id) }))
        .sort((a, b) => a.name.localeCompare(b.name));

      sortedTaxa.slice(0, 15).forEach((taxon, index) => {
        console.log(`${index + 1}. ${taxon.name} (ID: ${taxon.id})`);
      });

      if (this.possibleTaxa.size > 15) {
        console.log(`... and ${this.possibleTaxa.size - 15} more`);
      }

      if (this.possibleTaxa.size <= 10) {
        console.log('\n💡 Continue keying to narrow down further, or examine these taxa manually.');
      }
    }

    if (this.selectedStates.size > 0) {
      console.log('\n📝 Your selections:');
      for (const [charId, stateId] of this.selectedStates) {
        const char = this.getCharacterById(charId);
        const state = this.keyData.states?.find(s => s.id === stateId);
        console.log(`   ${char?.name || `Character ${charId}`}: ${state?.name || `State ${stateId}`}`);
      }
    }

    console.log('\n' + '='.repeat(60));
  }

  async runKeying() {
    const rl = createInterface();

    try {
      while (true) {
        if (this.possibleTaxa.size <= 5) {
          this.displayResults();
          if (this.possibleTaxa.size === 1) {
            break;
          }
        }

        const relevantChars = this.getRelevantCharacters();

        if (relevantChars.length === 0) {
          console.log('\n🎉 No more useful characters to distinguish remaining taxa!');
          this.displayResults();
          break;
        }

        console.log(`\n📋 Select a character to examine (${this.possibleTaxa.size} taxa remaining):`);

        if (this.possibleTaxa.size > 50) {
          console.log('💡 Tip: Start with obvious features like plant habit or leaf arrangement');
        } else if (this.possibleTaxa.size > 10) {
          console.log('💡 Tip: Look for distinctive features like flower color or fruit shape');
        } else {
          console.log('💡 Almost there! Focus on detailed characteristics');
        }

        console.log(`💡 You can view the ${this.possibleTaxa.size} remaining candidates at any time\n`);

        relevantChars.forEach((char, index) => {
          const typeLabel = char.type === 1 ? '🔢' : char.type === 2 ? '📏' : '❓';
          console.log(`${index + 1}. ${typeLabel} ${char.name || `Character ${char.id}`}`);
        });

        // Always show the "show remaining" option when there are multiple taxa
        if (this.possibleTaxa.size > 1) {
          console.log(`${relevantChars.length + 1}. 👀 Show remaining ${this.possibleTaxa.size} candidates`);
          console.log(`${relevantChars.length + 2}. ❌ Quit keying`);
        } else {
          console.log(`${relevantChars.length + 1}. ❌ Quit keying`);
        }

        const charAnswer = await askQuestion(rl, '\n👉 Select character: ');
        const charIndex = parseInt(charAnswer) - 1;

        const maxOptions = this.possibleTaxa.size > 1
          ? relevantChars.length + 2
          : relevantChars.length + 1;

        if (isNaN(charIndex) || charIndex < 0 || charIndex >= maxOptions) {
          console.log('❌ Invalid selection. Please enter a number from the list.\n');
          continue;
        }

        // Handle show remaining taxa option
        if (this.possibleTaxa.size > 1 && charIndex === relevantChars.length) {
          this.showRemainingCandidates();
          continue;
        }

        const quitIndex = this.possibleTaxa.size > 1
          ? relevantChars.length + 1
          : relevantChars.length;

        if (charIndex === quitIndex) {
          break;
        }

        const character = relevantChars[charIndex];
        const states = this.getStatesByCharacter(character.id);

        if (states.length === 0) {
          if (character.type === 2) {
            console.log(`\n📏 ${character.name || `Character ${character.id}`} is a numeric character.`);
            console.log('Numeric character support not yet implemented in this CLI.\n');
            continue;
          } else {
            console.log('\nNo states found for this character.\n');
            continue;
          }
        }

        console.log(`\n🔍 ${character.name || `Character ${character.id}`}`);

        states.forEach((state, index) => {
          console.log(`${index + 1}. ${this.formatStateDescription(state)}`);
        });

        console.log(`${states.length + 1}. ⬅️  Back to character selection`);

        const stateAnswer = await askQuestion(rl, '\n👁️  What do you observe? ');
        const stateIndex = parseInt(stateAnswer) - 1;

        if (isNaN(stateIndex) || stateIndex < 0 || stateIndex >= states.length + 1) {
          console.log('❌ Invalid selection. Please enter a number from the list.\n');
          continue;
        }

        if (stateIndex === states.length) {
          continue;
        }

        const state = states[stateIndex];

        this.selectedStates.set(character.id, state.id);
        const result = this.updatePossibleTaxa(character.id, state.id);

        console.log(`\n✅ Selected: ${character.name} = ${state.name}`);
        console.log(`📉 Eliminated ${result.eliminated} taxa, ${result.remaining} remaining`);

        const totalTaxa = this.possibleTaxa.size + this.eliminatedTaxa.size;
        const progress = Math.round((this.eliminatedTaxa.size / totalTaxa) * 100);
        const progressBar = '█'.repeat(Math.floor(progress / 5)) + '░'.repeat(20 - Math.floor(progress / 5));
        console.log(`🔍 Progress: [${progressBar}] ${progress}% identified\n`);

        if (result.remaining === 0) {
          console.log('❌ No taxa match your selections!');
          this.displayResults();
          break;
        }
      }
    } finally {
      rl.close();
    }

    if (this.possibleTaxa.size !== 1) {
      this.displayResults();
    }
  }
}

async function listAvailableKeys() {
  try {
    const files = await fs.readdir('./vicflora-data');
    const keyFiles = files.filter(f => f.startsWith('key-') && f.endsWith('-complete.json'));

    console.log('\n🔑 Available identification keys:\n');

    for (let i = 0; i < keyFiles.length; i++) {
      const file = keyFiles[i];
      try {
        const data = await fs.readFile(path.join('./vicflora-data', file), 'utf8');
        const keyData = JSON.parse(data);
        const entityCount = keyData.entities?.length || 0;
        const charCount = keyData.features?.length || 0;

        console.log(`${i + 1}. ${keyData.title}`);
        console.log(`   📄 ${file}`);
        console.log(`   📊 ${entityCount} taxa, ${charCount} characters\n`);
      } catch (e) {
        console.log(`${i + 1}. ${file} (unable to read details)\n`);
      }
    }

    return keyFiles;
  } catch (error) {
    console.error('Error listing keys:', error.message);
    return [];
  }
}

async function main() {
  console.log('🌿 VicFlora Interactive Plant Identification Key');
  console.log('===============================================');

  const keyFiles = await listAvailableKeys();

  if (keyFiles.length === 0) {
    console.log('No key files found. Please run the scraper first with: node main.js multi-access');
    return;
  }

  const rl = createInterface();

  try {
    const selection = await askQuestion(rl, '🔑 Select a key: ');
    const keyIndex = parseInt(selection) - 1;

    if (keyIndex < 0 || keyIndex >= keyFiles.length) {
      console.log('Invalid selection.');
      return;
    }

    const keyFile = path.join('./vicflora-data', keyFiles[keyIndex]);
    const cli = new KeyingCLI();

    const success = await cli.loadKey(keyFile);
    if (!success) return;

    await cli.runKeying();

  } finally {
    rl.close();
  }
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = KeyingCLI;