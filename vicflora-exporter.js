const fs = require('fs').promises;
const path = require('path');

class VicFloraExporter {
  constructor(outputDir = './vicflora-data') {
    this.outputDir = outputDir;
  }

  async ensureOutputDir() {
    try {
      await fs.access(this.outputDir);
    } catch {
      await fs.mkdir(this.outputDir, { recursive: true });
    }
  }

  async exportToJSON(data, filename) {
    await this.ensureOutputDir();
    const filepath = path.join(this.outputDir, `${filename}.json`);
    await fs.writeFile(filepath, JSON.stringify(data, null, 2));
    console.log(`Exported to ${filepath}`);
    return filepath;
  }

  async exportMultiAccessKeysToCSV(keys) {
    await this.ensureOutputDir();
    const csvPath = path.join(this.outputDir, 'multi-access-keys-summary.csv');

    const headers = [
      'ID',
      'Title',
      'Total Entities',
      'Total Features',
      'Total States',
      'Scored Entities',
      'Discrete Characters',
      'Numeric Characters',
      'Grouping Characters',
      'Download URL',
      'Downloaded At'
    ];

    const rows = keys.map(key => {
      const analysis = this.analyzeKeyStructure(key);
      return [
        key.metadata?.id || '',
        key.title || '',
        analysis.totalEntities,
        analysis.totalFeatures,
        analysis.totalStates,
        analysis.scoredEntities,
        analysis.characterTypes?.discrete || 0,
        analysis.characterTypes?.numeric || 0,
        analysis.characterTypes?.grouping || 0,
        key.metadata?.originalLocation || '',
        key.metadata?.downloadedAt || ''
      ];
    });

    const csvContent = [headers.join(','), ...rows.map(row => row.join(','))].join('\n');
    await fs.writeFile(csvPath, csvContent);
    console.log(`Exported summary to ${csvPath}`);
    return csvPath;
  }

  async exportCharacterMatrix(keyData, keyId) {
    await this.ensureOutputDir();
    const matrixPath = path.join(this.outputDir, `character-matrix-${keyId}.csv`);

    if (!keyData.entities || !keyData.decompressedScores) {
      console.warn(`No character matrix data available for key ${keyId}`);
      return null;
    }

    // Create headers: Entity ID, Entity Name, then character states
    const maxCharacters = Math.max(
      ...Object.values(keyData.decompressedScores)
        .filter(scores => scores)
        .map(scores => scores.length)
    );

    const headers = [
      'Entity ID',
      'Entity Name',
      ...Array.from({ length: maxCharacters }, (_, i) => `Character ${i + 1}`)
    ];

    const rows = [];
    for (const entity of keyData.entities) {
      const scores = keyData.decompressedScores[entity.id];
      if (scores) {
        const row = [
          entity.id,
          entity.name || entity.title || '',
          ...scores.map(score => score.toString())
        ];
        // Pad with empty values if needed
        while (row.length < headers.length) {
          row.push('');
        }
        rows.push(row);
      }
    }

    const csvContent = [headers.join(','), ...rows.map(row => row.join(','))].join('\n');
    await fs.writeFile(matrixPath, csvContent);
    console.log(`Exported character matrix to ${matrixPath}`);
    return matrixPath;
  }

  async exportCharacterDefinitions(keyData, keyId) {
    await this.ensureOutputDir();
    const defsPath = path.join(this.outputDir, `character-definitions-${keyId}.csv`);

    if (!keyData.features || !keyData.states) {
      console.warn(`No character definition data available for key ${keyId}`);
      return null;
    }

    const headers = [
      'Character ID',
      'Character Name',
      'Character Type',
      'Parent ID',
      'State ID',
      'State Name',
      'State Description'
    ];

    const rows = [];
    for (const feature of keyData.features) {
      const characterType = feature.type === 1 ? 'discrete' :
                           feature.type === 2 ? 'numeric' :
                           feature.type === 0 ? 'grouping' : 'unknown';

      const relevantStates = keyData.states.filter(state => state.feature === feature.id);

      if (relevantStates.length === 0) {
        // Character with no states (e.g., numeric characters)
        rows.push([
          feature.id,
          feature.name || '',
          characterType,
          feature.parent || '',
          '',
          '',
          ''
        ]);
      } else {
        // Character with states
        for (const state of relevantStates) {
          rows.push([
            feature.id,
            feature.name || '',
            characterType,
            feature.parent || '',
            state.id,
            state.name || '',
            (typeof state.text === 'object' ? JSON.stringify(state.text) : state.text) || ''
          ]);
        }
      }
    }

    const csvContent = [headers.join(','), ...rows.map(row => row.join(','))].join('\n');
    await fs.writeFile(defsPath, csvContent);
    console.log(`Exported character definitions to ${defsPath}`);
    return defsPath;
  }

  async exportMeasurements(keyData, keyId) {
    await this.ensureOutputDir();
    const measurePath = path.join(this.outputDir, `measurements-${keyId}.csv`);

    if (!keyData.decompressedMeasures) {
      console.warn(`No measurement data available for key ${keyId}`);
      return null;
    }

    const headers = ['Character ID', 'Entity ID', 'Min Value', 'Max Value', 'Other Values'];
    const rows = [];

    for (const [characterId, entityMeasures] of Object.entries(keyData.decompressedMeasures)) {
      for (const [entityId, measurements] of Object.entries(entityMeasures)) {
        if (measurements && measurements.length > 0) {
          const row = [
            characterId,
            entityId,
            measurements[0] || '',
            measurements[1] || '',
            measurements.slice(2).join(';')
          ];
          rows.push(row);
        }
      }
    }

    if (rows.length === 0) {
      console.log(`No measurement data to export for key ${keyId}`);
      return null;
    }

    const csvContent = [headers.join(','), ...rows.map(row => row.join(','))].join('\n');
    await fs.writeFile(measurePath, csvContent);
    console.log(`Exported measurements to ${measurePath}`);
    return measurePath;
  }

  async exportCompleteKey(keyData) {
    const keyId = keyData.metadata?.id || 'unknown';
    const keyTitle = keyData.title || 'Unknown Key';

    console.log(`\nExporting complete data for ${keyTitle} (ID: ${keyId})`);

    const exports = {};

    // Export raw JSON
    exports.json = await this.exportToJSON(keyData, `key-${keyId}-complete`);

    // Export character matrix
    exports.matrix = await this.exportCharacterMatrix(keyData, keyId);

    // Export character definitions
    exports.definitions = await this.exportCharacterDefinitions(keyData, keyId);

    // Export measurements
    exports.measurements = await this.exportMeasurements(keyData, keyId);

    return exports;
  }

  analyzeKeyStructure(keyData) {
    const analysis = {
      title: keyData.title,
      totalEntities: keyData.entities ? keyData.entities.length : 0,
      totalFeatures: keyData.features ? keyData.features.length : 0,
      totalStates: keyData.states ? keyData.states.length : 0,
      scoredEntities: keyData.decompressedScores ? Object.keys(keyData.decompressedScores).length : 0,
      measuredCharacters: keyData.decompressedMeasures ? Object.keys(keyData.decompressedMeasures).length : 0
    };

    // Character type breakdown
    if (keyData.features) {
      analysis.characterTypes = {};
      keyData.features.forEach(feature => {
        const type = feature.type === 1 ? 'discrete' :
                    feature.type === 2 ? 'numeric' :
                    feature.type === 0 ? 'grouping' : 'unknown';
        analysis.characterTypes[type] = (analysis.characterTypes[type] || 0) + 1;
      });
    }

    return analysis;
  }

  async exportIdentificationKey(keyEntry) {
    await this.ensureOutputDir();

    const id = keyEntry?.keybase?.key_id || keyEntry?.metadata?.id;
    if (!id) {
      console.warn('Identification key entry missing id, skipping export');
      return null;
    }

    const filepath = path.join(this.outputDir, `identification-key-${id}.json`);
    await fs.writeFile(filepath, JSON.stringify(keyEntry, null, 2));
    console.log(`Exported identification key to ${filepath}`);
    return filepath;
  }

  async exportIdentificationKeysSummary(keys) {
    await this.ensureOutputDir();
    const csvPath = path.join(this.outputDir, 'identification-keys-summary.csv');

    const headers = [
      'ID',
      'Title',
      'Taxonomic Scope',
      'Geographic Scope',
      'Created',
      'Modified'
    ];

    const rows = keys.map(key => [
      key.id || '',
      key.title || '',
      key.taxonomicScope || '',
      key.geographicScope || '',
      key.created || '',
      key.modified || ''
    ]);

    const csvContent = [headers.join(','), ...rows.map(row => row.join(','))].join('\n');
    await fs.writeFile(csvPath, csvContent);
    console.log(`Exported identification key summary to ${csvPath}`);
    return csvPath;
  }
}

module.exports = VicFloraExporter;
