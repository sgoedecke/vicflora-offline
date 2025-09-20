const VicFloraClient = require('./vicflora-scraper');
const LZString = require('./lz-string');
const fs = require('fs').promises;
const path = require('path');

const EXPECTED_BRYOPHYTE_TITLES = [
  'Multi-access key to the hornworts and thallose liverworts of Victoria',
  'Multi-access key to the leafy liverworts of Victoria',
  'Multi-access key to the mosses of Victoria'
];

class MultiAccessScraper {
  constructor() {
    this.client = new VicFloraClient();
  }

  async getMultiAccessKeysList() {
    const query = `
      query {
        multiAccessKeys {
          id
          title
          location
        }
      }
    `;

    const data = await this.client.graphqlRequest(query);
    return data.multiAccessKeys;
  }

  async loadManualKeyList() {
    const manualPath = path.join(process.cwd(), 'vicflora-data', 'manual-multi-access-keys.json');
    try {
      const raw = await fs.readFile(manualPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter(entry => entry && entry.id && entry.location).map(entry => ({
          id: String(entry.id),
          title: entry.title || entry.id,
          location: entry.location
        }));
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`⚠️  Failed to load manual multi-access key list: ${error.message}`);
      }
    }
    return [];
  }

  async getMultiAccessKeyMetadata(id) {
    const query = `
      query($id: ID!) {
        multiAccessKey(id: $id) {
          id
          title
          description
          characters {
            id
            name
            type
            characterType
            description
            states {
              id
              name
              description
            }
          }
        }
      }
    `;

    const data = await this.client.graphqlRequest(query, { id });
    return data.multiAccessKey;
  }

  parseLucidBundle(jsContent) {
    if (!jsContent) {
      throw new Error('Empty Lucid bundle content');
    }

    const normalized = jsContent
      .replace(/\u0000/g, '')
      .replace(/\uFEFF/g, '')
      .trim();

    // Strip the "var key = " wrapper and parse JSON
    const match = normalized.match(/var\s+key\s*=\s*({[\s\S]*});?\s*$/);
    if (!match) {
      throw new Error('Could not parse Lucid bundle format');
    }

    try {
      return JSON.parse(match[1]);
    } catch (error) {
      throw new Error(`Failed to parse JSON from Lucid bundle: ${error.message}`);
    }
  }

  decompressScores(compressedScores) {
    const decompressed = {};

    for (const [entityId, compressedData] of Object.entries(compressedScores)) {
      try {
        const decompressedString = LZString.decompressFromBase64(compressedData);
        if (decompressedString) {
          // Convert ASCII codes to actual numbers
          const scores = decompressedString.split('').map(char => char.charCodeAt(0) - 48);
          decompressed[entityId] = scores;
        } else {
          console.warn(`Failed to decompress scores for entity ${entityId}`);
          decompressed[entityId] = null;
        }
      } catch (error) {
        console.warn(`Error decompressing scores for entity ${entityId}:`, error.message);
        decompressed[entityId] = null;
      }
    }

    return decompressed;
  }

  decompressMeasures(compressedMeasures) {
    const decompressed = {};

    for (const [characterId, entityMeasures] of Object.entries(compressedMeasures)) {
      decompressed[characterId] = {};

      for (const [entityId, compressedData] of Object.entries(entityMeasures)) {
        try {
          const decompressedString = LZString.decompressFromBase64(compressedData);
          if (decompressedString) {
            // Split colon-delimited measurement ranges
            const measurements = decompressedString.split(':').map(val => parseFloat(val));
            decompressed[characterId][entityId] = measurements;
          } else {
            console.warn(`Failed to decompress measures for character ${characterId}, entity ${entityId}`);
            decompressed[characterId][entityId] = null;
          }
        } catch (error) {
          console.warn(`Error decompressing measures for character ${characterId}, entity ${entityId}:`, error.message);
          decompressed[characterId][entityId] = null;
        }
      }
    }

    return decompressed;
  }

  async downloadAndParseKey(keyInfo) {
    console.log(`Downloading ${keyInfo.title} from ${keyInfo.location}`);

    const jsContent = await this.client.fetchUrl(keyInfo.location);
    const parsedData = this.parseLucidBundle(jsContent);

    // Decompress the matrix data
    const decompressedScores = this.decompressScores(parsedData.scores || {});
    const decompressedMeasures = this.decompressMeasures(parsedData.measures || {});

    return {
      ...parsedData,
      decompressedScores,
      decompressedMeasures,
      metadata: {
        id: keyInfo.id,
        downloadedAt: new Date().toISOString(),
        originalLocation: keyInfo.location
      }
    };
  }

  async scrapeAllMultiAccessKeys() {
    console.log('Fetching list of multi-access keys...');
    const keysList = await this.getMultiAccessKeysList();
    const manualKeys = await this.loadManualKeyList();

    const combined = [...keysList];
    for (const manual of manualKeys) {
      if (!combined.some(key => key.id === manual.id)) {
        combined.push(manual);
      }
    }

    console.log(`Found ${combined.length} multi-access keys`);

    const missingBryophytes = EXPECTED_BRYOPHYTE_TITLES.filter(expected =>
      !combined.some(key => (key.title || '').trim().toLowerCase() === expected.toLowerCase())
    );
    if (missingBryophytes.length) {
      console.warn('⚠️  Missing expected bryophyte multi-access keys:', missingBryophytes.join('; '));
      console.warn('    If VicFlora publishes new keys, re-run the scraper after updating vicflora-data/manual-multi-access-keys.json with their IDs and download URLs.');
    }

    const results = [];

    for (const keyInfo of combined) {
      try {
        const keyData = await this.downloadAndParseKey(keyInfo);

        // Also get additional metadata from GraphQL
        let metadata = null;
        try {
          metadata = await this.getMultiAccessKeyMetadata(keyInfo.id);
        } catch (error) {
          console.warn(`⚠️  Unable to fetch GraphQL metadata for ${keyInfo.title || keyInfo.id}: ${error.message}`);
        }

        results.push({
          ...keyData,
          graphqlMetadata: metadata
        });

        console.log(`✓ Successfully processed ${keyInfo.title}`);
      } catch (error) {
        console.error(`✗ Failed to process ${keyInfo.title}:`, error.message);
      }
    }

    return results;
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
}

module.exports = MultiAccessScraper;
