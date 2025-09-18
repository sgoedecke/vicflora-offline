#!/usr/bin/env node

const MultiAccessScraper = require('./multi-access-scraper');
const IdentificationKeyScraper = require('./identification-key-scraper');
const VicFloraExporter = require('./vicflora-exporter');

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  try {
    switch (command) {
      case 'multi-access':
        await scrapeMultiAccessKeys();
        break;
      case 'identification':
        await scrapeIdentificationKeys();
        break;
      case 'all':
        await scrapeAllKeys();
        break;
      case 'list':
        await listMultiAccessKeys();
        break;
      case 'analyze':
        await analyzeKey(args[1]);
        break;
      default:
        showHelp();
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

async function scrapeMultiAccessKeys() {
  console.log('=== VicFlora Multi-Access Key Scraper ===\n');

  const scraper = new MultiAccessScraper();
  const exporter = new VicFloraExporter();

  const keys = await scraper.scrapeAllMultiAccessKeys();

  console.log(`\n=== Export Results ===`);
  console.log(`Successfully scraped ${keys.length} multi-access keys`);

  // Export summary
  await exporter.exportToJSON(keys, 'all-multi-access-keys');
  await exporter.exportMultiAccessKeysToCSV(keys);

  // Export individual keys
  for (const key of keys) {
    await exporter.exportCompleteKey(key);
  }

  console.log('\n=== Analysis ===');
  keys.forEach(key => {
    const analysis = exporter.analyzeKeyStructure(key);
    console.log(`${analysis.title}:`);
    console.log(`  Entities: ${analysis.totalEntities} (${analysis.scoredEntities} scored)`);
    console.log(`  Characters: ${analysis.totalFeatures} (${JSON.stringify(analysis.characterTypes)})`);
    console.log(`  States: ${analysis.totalStates}`);
  });
}

async function scrapeIdentificationKeys() {
  console.log('=== VicFlora Identification Key Scraper ===\n');

  const scraper = new IdentificationKeyScraper();
  const exporter = new VicFloraExporter();

  const keys = await scraper.discoverIdentificationKeys();

  if (keys.length === 0) {
    console.log('No identification keys found');
    return;
  }

  const keybaseData = await scraper.downloadKeyBaseKeys(keys);

  console.log(`\n=== Export Results ===`);
  console.log(`Found ${keys.length} identification keys`);

  await exporter.exportToJSON(keys, 'all-identification-keys');
  await exporter.exportIdentificationKeysSummary(keys);

  if (keybaseData.length > 0) {
    for (const entry of keybaseData) {
      await exporter.exportIdentificationKey(entry);
    }
  } else {
    console.warn('No KeyBase exports were downloaded');
  }

  console.log('\n=== Found Keys ===');
  keys.forEach(key => {
    console.log(`ID ${key.id}: ${key.title}`);
    if (key.taxonomicScope) console.log(`  Scope: ${key.taxonomicScope}`);
    if (key.created) console.log(`  Created: ${key.created}`);
  });
}

async function scrapeAllKeys() {
  console.log('=== VicFlora Complete Key Scraper ===\n');

  await scrapeMultiAccessKeys();
  console.log('\n' + '='.repeat(50) + '\n');
  await scrapeIdentificationKeys();
}

async function listMultiAccessKeys() {
  console.log('=== VicFlora Multi-Access Keys List ===\n');

  const scraper = new MultiAccessScraper();
  const keys = await scraper.getMultiAccessKeysList();

  console.log(`Found ${keys.length} multi-access keys:\n`);

  keys.forEach(key => {
    console.log(`ID: ${key.id}`);
    console.log(`Title: ${key.title}`);
    console.log(`Location: ${key.location}`);
    console.log('---');
  });
}

async function analyzeKey(keyId) {
  if (!keyId) {
    console.error('Please provide a key ID to analyze');
    return;
  }

  console.log(`=== Analyzing Key ${keyId} ===\n`);

  const scraper = new MultiAccessScraper();

  try {
    // Get key list to find the location
    const keys = await scraper.getMultiAccessKeysList();
    const keyInfo = keys.find(k => k.id === keyId);

    if (!keyInfo) {
      console.error(`Key ${keyId} not found`);
      return;
    }

    // Download and parse the key
    const keyData = await scraper.downloadAndParseKey(keyInfo);
    const analysis = scraper.analyzeKeyStructure(keyData);

    console.log(`Title: ${analysis.title}`);
    console.log(`Total Entities: ${analysis.totalEntities}`);
    console.log(`Scored Entities: ${analysis.scoredEntities}`);
    console.log(`Total Features: ${analysis.totalFeatures}`);
    console.log(`Character Types:`, analysis.characterTypes);
    console.log(`Total States: ${analysis.totalStates}`);
    console.log(`Measured Characters: ${analysis.measuredCharacters}`);

    // Export the individual key
    const exporter = new VicFloraExporter();
    await exporter.exportCompleteKey(keyData);

  } catch (error) {
    console.error(`Failed to analyze key ${keyId}:`, error.message);
  }
}

function showHelp() {
  console.log(`
VicFlora Key Scraper

Usage:
  node main.js <command>

Commands:
  multi-access    Scrape all multi-access (Lucid) keys
  identification  Discover and scrape identification (dichotomous) keys
  all             Scrape both multi-access and identification keys
  list            List available multi-access keys without downloading
  analyze <id>    Download and analyze a specific multi-access key
  help            Show this help message

Examples:
  node main.js multi-access
  node main.js analyze fabaceae
  node main.js all

Data is exported to ./vicflora-data/ directory in JSON and CSV formats.
  `);
}

if (require.main === module) {
  main();
}

module.exports = { main, scrapeMultiAccessKeys, scrapeIdentificationKeys };
