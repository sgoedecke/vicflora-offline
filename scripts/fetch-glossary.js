#!/usr/bin/env node

// Fetches the VicFlora glossary into vicflora-data/glossary.json:
// [{ name, definition (sanitized HTML), related: [[relationshipType, term]] }]

const fs = require('fs').promises;
const path = require('path');
const fetch = require('node-fetch');
const { sanitizeProfile } = require('./fetch-descriptions');

const ENDPOINT = 'https://vicflora.rbg.vic.gov.au/graphql';
const outPath = path.resolve(__dirname, '..', 'vicflora-data', 'glossary.json');

async function graphql(query) {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'vicflora-offline' },
    body: JSON.stringify({ query })
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data;
}

async function main() {
  const { glossaryTermFirstLetters: letters } = await graphql('{ glossaryTermFirstLetters }');
  const terms = new Map();
  for (const letter of letters) {
    const data = await graphql(`{
      glossaryTermsByName(name: ${JSON.stringify(letter)}) {
        name
        definition
        isDiscouraged
        relationships { relationshipType { name } relatedTerm { name } }
      }
    }`);
    for (const term of data.glossaryTermsByName || []) {
      terms.set(term.name, {
        name: term.name,
        definition: term.definition ? sanitizeProfile(term.definition) : null,
        discouraged: Boolean(term.isDiscouraged),
        related: (term.relationships || [])
          .map(rel => [rel.relationshipType?.name, rel.relatedTerm?.name])
          .filter(([type, name]) => type && name)
      });
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const list = [...terms.values()].sort((a, b) => a.name.localeCompare(b.name));
  await fs.writeFile(outPath, JSON.stringify(list));
  console.log(`Saved ${list.length} glossary terms.`);
}

if (require.main === module) {
  main().catch(error => {
    console.error('Error fetching glossary:', error.message);
    process.exit(1);
  });
}
