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
    return { status: 'skipped', target };
  } catch (_) {
    // continue to download
  }

  const url = `https://keybase.rbg.vic.gov.au/keys/export/${id}?format=json`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const body = await res.text();
  await fs.writeFile(target, body);
  return { status: 'downloaded', target };
}

async function main() {
  const [htmlPath = 'keybase-list.html', outputDir = 'keybase-data'] = process.argv.slice(2);

  try {
    const { entries, summary } = await downloadAllKeybaseKeys({ htmlPath, outputDir });

    console.log(`📋 Found ${entries.length} keys`);
    console.log(`⬇️  Downloaded ${summary.downloaded.length} new keys`);
    if (summary.skipped.length) {
      console.log(`🔁 Skipped ${summary.skipped.length} existing keys`);
    }
    if (summary.failed.length) {
      console.log(`⚠️  Failed downloads: ${summary.failed.map(f => f.id).join(', ')}`);
    }
    console.log('✅ Done');
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('Error:', error.message);
    process.exit(1);
  });
}

async function loadKeyEntries(htmlPath) {
  const html = await fs.readFile(htmlPath, 'utf8');
  return parseKeyList(html);
}

async function downloadAllKeybaseKeys(options = {}) {
  const {
    htmlPath = 'keybase-list.html',
    outputDir = 'keybase-data',
    delayMs = 1000
  } = options;

  const entries = await loadKeyEntries(htmlPath);

  if (!entries.length) {
    throw new Error('No keys found in HTML list.');
  }

  await ensureDir(outputDir);

  const summary = {
    downloaded: [],
    skipped: [],
    failed: []
  };

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    try {
      const result = await downloadKey(entry.id, entry.title, outputDir);
      if (result.status === 'downloaded') {
        console.log(`⬇️  Downloaded ${entry.id} (${entry.title})`);
        summary.downloaded.push(entry);
        if (delayMs) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      } else {
        summary.skipped.push(entry);
        console.log(`🔁 Skipping ${entry.id} (${entry.title}) – already downloaded`);
      }
    } catch (error) {
      console.warn(`⚠️  Failed to download ${entry.id}: ${error.message}`);
      summary.failed.push({ ...entry, error: error.message });
    }
  }

  return { entries, summary, outputDir: path.resolve(outputDir) };
}

module.exports = {
  parseKeyList,
  loadKeyEntries,
  downloadAllKeybaseKeys
};
