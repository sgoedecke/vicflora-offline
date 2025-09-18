const VicFloraClient = require('./vicflora-scraper');

class IdentificationKeyScraper {
  constructor() {
    this.client = new VicFloraClient();
  }

  async tryIdentificationKeyById(id) {
    const query = `
      query($id: ID!) {
        identificationKey(id: $id) {
          id
          title
          taxonomicScope
          geographicScope
          created
          modified
        }
      }
    `;

    try {
      const data = await this.client.graphqlRequest(query, { id: id.toString() });
      return data.identificationKey;
    } catch (error) {
      if (error.message.includes('Cannot return null')) {
        return null; // ID doesn't exist
      }
      throw error;
    }
  }

  async downloadKeyBaseKey(id) {
    const keyData = await this.client.fetchKeyBaseKey(id);
    return keyData;
  }

  async downloadKeyBaseKeys(keys) {
    const results = [];

    for (const key of keys) {
      try {
        const keybaseData = await this.downloadKeyBaseKey(key.id);
        results.push({
          keybase: keybaseData,
          metadata: key
        });
        console.log(`⬇️  Downloaded KeyBase export for ${key.id}: ${key.title}`);
      } catch (error) {
        console.warn(`Failed to download KeyBase export for ${key.id}: ${error.message}`);
      }
    }

    return results;
  }

  async bruteForceIdentificationKeys(startId = 1, maxId = 1000) {
    console.log(`Brute forcing identification key IDs from ${startId} to ${maxId}...`);
    const foundKeys = [];

    for (let id = startId; id <= maxId; id++) {
      try {
        const key = await this.tryIdentificationKeyById(id);
        if (key) {
          console.log(`✓ Found identification key ${id}: ${key.title}`);
          foundKeys.push(key);
        } else if (id % 100 === 0) {
          console.log(`Checked up to ID ${id}...`);
        }
      } catch (error) {
        console.warn(`Error checking ID ${id}:`, error.message);
      }
    }

    return foundKeys;
  }

  async extractNuxtPayload(pageUrl) {
    console.log(`Extracting window.__NUXT__ payload from ${pageUrl}`);
    // Note: This would require headless browser capability
    console.warn('NUXT payload extraction not implemented (requires headless browser)');
    return null;
  }

  async searchForKeyPages() {
    // Try to find key-related pages through the NUXT payload
    const baseUrl = 'https://vicflora.rbg.vic.gov.au';
    const testPages = [
      '/pages/home',
      '/pages/flora',
      '/pages/keys'
    ];

    const keyIds = new Set();

    for (const page of testPages) {
      try {
        const url = baseUrl + page;
        const nuxtData = await this.extractNuxtPayload(url);

        if (nuxtData) {
          // Search for identification key references in the payload
          const jsonStr = JSON.stringify(nuxtData);

          // Look for patterns that might contain key IDs
          const keyPatterns = [
            /identificationKey.*?(\d+)/gi,
            /"id":\s*(\d+).*?"identification/gi,
            /key.*?id.*?(\d+)/gi
          ];

          for (const pattern of keyPatterns) {
            let match;
            while ((match = pattern.exec(jsonStr)) !== null) {
              const id = parseInt(match[1]);
              if (id && id > 0 && id < 10000) {
                keyIds.add(id);
              }
            }
          }
        }
      } catch (error) {
        console.warn(`Failed to extract from ${page}:`, error.message);
      }
    }

    console.log(`Found ${keyIds.size} potential key IDs from NUXT payloads`);
    return Array.from(keyIds).sort((a, b) => a - b);
  }

  async attemptSolrSearch() {
    // Try different Solr field combinations to find identification keys
    const searchQuery = `
      query($input: SearchInput!) {
        search(input: $input) {
          docs {
            id
          }
        }
      }
    `;

    const searchTerms = [
      { q: "*:*", fq: ["object_type:identification_key"] },
      { q: "*:*", fq: ["type:IdentificationKey"] },
      { q: "*:*", fq: ["class:identification_key"] },
      { q: "identification key", fq: [] },
      { q: "dichotomous key", fq: [] }
    ];

    for (const terms of searchTerms) {
      try {
        console.log(`Trying Solr search with:`, terms);
        const data = await this.client.graphqlRequest(searchQuery, { input: terms });

        if (data.search && data.search.docs && data.search.docs.length > 0) {
          console.log(`✓ Found ${data.search.docs.length} results with Solr search`);
          return data.search.docs;
        }
      } catch (error) {
        console.warn(`Solr search failed:`, error.message);
      }
    }

    return [];
  }

  async discoverIdentificationKeys() {
    console.log('Starting identification key discovery...');

    const strategies = [
      () => this.searchForKeyPages(),
      () => this.attemptSolrSearch(),
      () => this.bruteForceIdentificationKeys(1, 100)
    ];

    const allKeyIds = new Set();
    const foundKeys = [];

    for (const strategy of strategies) {
      try {
        const results = await strategy();

        if (Array.isArray(results)) {
          if (results.length > 0 && typeof results[0] === 'number') {
            // This is a list of IDs
            results.forEach(id => allKeyIds.add(id));
          } else if (results.length > 0 && results[0].id) {
            // This is a list of key objects
            foundKeys.push(...results);
            results.forEach(key => allKeyIds.add(parseInt(key.id)));
          }
        }
      } catch (error) {
        console.warn('Strategy failed:', error.message);
      }
    }

    // Validate any discovered IDs that we haven't already confirmed
    for (const id of allKeyIds) {
      if (!foundKeys.find(key => parseInt(key.id) === id)) {
        try {
          const key = await this.tryIdentificationKeyById(id);
          if (key) {
            foundKeys.push(key);
          }
        } catch (error) {
          console.warn(`Failed to validate ID ${id}:`, error.message);
        }
      }
    }

    console.log(`Discovery complete: found ${foundKeys.length} identification keys`);
    return foundKeys;
  }

  async getIdentificationKeyDetail(id) {
    // Try to get more detailed information about a specific identification key
    // This would need to be expanded based on what fields are actually available
    const query = `
      query($id: ID!) {
        identificationKey(id: $id) {
          id
          title
          taxonomicScope
          geographicScope
          created
          modified
        }
      }
    `;

    return await this.client.graphqlRequest(query, { id: id.toString() });
  }
}

module.exports = IdentificationKeyScraper;
