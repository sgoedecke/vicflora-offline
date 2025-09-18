#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');
const fetch = require('node-fetch');

async function parseKeyList(html) {
  const entries = [];
  const regex = /<a\s+href="https:\/\/keybase\.rbg\.vic\.gov\.au\/keys\/show\/(\d+)">([^<]+)<\/a>/g;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const id = match[1];
    const title = match[2].trim();
    entries.push({ id, title });
  }
  return entries;
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function downloadKey(id, title, outDir) {
  const target = path.join(outDir, `${id}.json`);
  try {
    await fs.access(target);
    console.log(`🔁 Skipping ${id} (${title}) – already downloaded`);
    return;
  } catch (_) {
    // continue to download
  }

  const url = `https://keybase.rbg.vic.gov.au/keys/export/${id}?format=json`;
  console.log(`⬇️  Downloading ${id} (${title})`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const body = await res.text();
  await fs.writeFile(target, body);
}

async function main() {
  const [htmlPath = 'keybase-list.html', outputDir = 'keybase-data'] = process.argv.slice(2);

  const html = await fs.readFile(htmlPath, 'utf8');
  const keys = await parseKeyList(html);

  if (keys.length === 0) {
    console.error('No keys found in HTML.');
    process.exit(1);
  }

  console.log(`📋 Found ${keys.length} keys`);
  await ensureDir(outputDir);

  for (let i = 0; i < keys.length; i++) {
    const entry = keys[i];
    try {
      await downloadKey(entry.id, entry.title, outputDir);
    } catch (error) {
      console.warn(`⚠️  Failed to download ${entry.id}: ${error.message}`);
    }
    if (i % 25 === 24) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  console.log('✅ Done');
}

if (require.main === module) {
  main().catch(error => {
    console.error('Error:', error.message);
    process.exit(1);
  });
}

module.exports = { parseKeyList };
