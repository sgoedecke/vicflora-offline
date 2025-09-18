const fetch = require('node-fetch');
const fs = require('fs').promises;

class VicFloraClient {
  constructor() {
    this.endpoint = 'https://vicflora.rbg.vic.gov.au/graphql';
    this.cdnBase = 'https://vicflora-cdn.rbg.vic.gov.au';
    this.keybaseEndpoint = 'https://keybase.rbg.vic.gov.au/keys/export';
    this.requestDelay = 1000; // 1 second between requests
    this.lastRequestTime = 0;
  }

  async delay() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.requestDelay) {
      await new Promise(resolve => setTimeout(resolve, this.requestDelay - timeSinceLastRequest));
    }
    this.lastRequestTime = Date.now();
  }

  async graphqlRequest(query, variables = {}) {
    await this.delay();

    const maxRetries = 3;
    let retries = 0;

    while (retries < maxRetries) {
      try {
        const response = await fetch(this.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'VicFlora Research Bot 1.0'
          },
          body: JSON.stringify({ query, variables })
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();

        if (data.errors) {
          throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
        }

        return data.data;
      } catch (error) {
        retries++;
        if (retries >= maxRetries) {
          throw error;
        }
        console.warn(`Request failed, retrying (${retries}/${maxRetries}):`, error.message);
        await new Promise(resolve => setTimeout(resolve, 2000 * retries));
      }
    }
  }

  async fetchUrl(url) {
    await this.delay();

    const maxRetries = 3;
    let retries = 0;

    while (retries < maxRetries) {
      try {
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'VicFlora Research Bot 1.0'
          }
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return await response.text();
      } catch (error) {
        retries++;
        if (retries >= maxRetries) {
          throw error;
        }
        console.warn(`URL fetch failed, retrying (${retries}/${maxRetries}):`, error.message);
        await new Promise(resolve => setTimeout(resolve, 2000 * retries));
      }
    }
  }

  async fetchKeyBaseKey(id, format = 'json') {
    const url = `${this.keybaseEndpoint}/${id}?format=${format}`;
    const response = await this.fetchUrl(url);

    if (format === 'json') {
      try {
        return JSON.parse(response);
      } catch (error) {
        throw new Error(`Failed to parse KeyBase JSON for key ${id}: ${error.message}`);
      }
    }

    return response;
  }
}

module.exports = VicFloraClient;
