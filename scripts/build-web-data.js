#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadJSON(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function writeJSON(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

function normalizeKeyTitle(title) {
  if (!title || typeof title !== 'string') return title;
  const patterns = [
    /^key\s+to\s+the\s+/i,
    /^key\s+to\s+/i,
    /^key:\s*/i,
    /^key\s+/i
  ];

  let cleaned = title.trim();
  for (const pattern of patterns) {
    if (pattern.test(cleaned)) {
      cleaned = cleaned.replace(pattern, '');
      break;
    }
  }

  const categoryPattern = /^(?:the\s+)?(families|genera|species|subfamilies|subgenera|tribes|subtribes|orders|suborders|sections|subsections)\s+of\s+/i;
  if (categoryPattern.test(cleaned)) {
    cleaned = cleaned.replace(categoryPattern, '');
  }

  // Bryophyte keys use the "Key to Pottiaceae genera" form
  const trailingCategoryPattern = /\s+(genera|species|subspecies|varieties)$/i;
  cleaned = cleaned.replace(trailingCategoryPattern, '');

  return cleaned.trim();
}

async function main() {
  const root = process.cwd();
  const configPath = path.join(root, 'web', 'web-config.json');
  const defaultConfig = {
    dichotomousKeys: ['1903', '1906', '1907'],
    multiAccessKeys: null
  };

  let config = defaultConfig;
  if (await fileExists(configPath)) {
    const userConfig = JSON.parse(await fs.readFile(configPath, 'utf8'));
    config = {
      ...defaultConfig,
      ...userConfig
    };
  }

  const webDataDir = path.join(root, 'web', 'public', 'data');
  await fs.mkdir(webDataDir, { recursive: true });

  // Build dichotomous dataset. Start from the configured roots, then include every
  // other scraped key: many (e.g. genus keys under single-genus families like
  // Hibbertia) aren't linked from any parent key via to_key.
  const dichotomous = {};
  const scrapedKeyIds = (await fs.readdir(path.join(root, 'keybase-data')))
    .filter(name => /^\d+\.json$/.test(name))
    .map(name => name.replace(/\.json$/, ''))
    .sort((a, b) => Number(a) - Number(b));
  const pending = [...config.dichotomousKeys.map(id => String(id)), ...scrapedKeyIds];
  const seen = new Set();

  while (pending.length) {
    const id = pending.shift();
    if (seen.has(id)) continue;
    seen.add(id);

    const filePath = path.join(root, 'keybase-data', `${id}.json`);
    if (!(await fileExists(filePath))) {
      console.warn(`⚠️  Missing dichotomous key ${id} at ${filePath}`);
      continue;
    }

    const key = await loadJSON(filePath);
    const normalized = key.keybase || key;
    const cleaned = { ...normalized };

    if (cleaned.key_title) {
      cleaned.key_title = normalizeKeyTitle(cleaned.key_title);
    }

    if (cleaned.key_name) {
      cleaned.key_name = normalizeKeyTitle(cleaned.key_name);
    }

    if (cleaned.taxonomic_scope?.item_name) {
      cleaned.taxonomic_scope = {
        ...cleaned.taxonomic_scope,
        item_name: normalizeKeyTitle(cleaned.taxonomic_scope.item_name)
      };
    }

    dichotomous[id] = cleaned;

    for (const item of normalized.items || []) {
      if (item?.to_key) {
        const nextId = String(item.to_key);
        if (!seen.has(nextId)) {
          pending.push(nextId);
        }
      }
    }
  }
  await writeJSON(path.join(webDataDir, 'dichotomous-keys.json'), {
    generatedAt: new Date().toISOString(),
    keys: dichotomous
  });

  // Build multi-access dataset
  const multi = {};
  let multiKeyFiles = Array.isArray(config.multiAccessKeys) ? config.multiAccessKeys.map(String) : null;

  if (!multiKeyFiles || multiKeyFiles.length === 0) {
    const files = await fs.readdir(path.join(root, 'vicflora-data'));
    multiKeyFiles = files
      .filter(name => name.startsWith('key-') && name.endsWith('-complete.json'))
      .sort();
  }

  for (const fileName of multiKeyFiles) {
    const filePath = path.join(root, 'vicflora-data', fileName);
    if (!(await fileExists(filePath))) {
      console.warn(`⚠️  Missing multi-access key file ${fileName}`);
      continue;
    }
    const key = await loadJSON(filePath);
    const {
      title,
      features = [],
      states = [],
      entities = [],
      decompressedScores = {},
      decompressedMeasures = {},
      metadata = {},
      description = '',
      text = []
    } = key;

    multi[fileName] = {
      title,
      description,
      text,
      features,
      states,
      entities,
      decompressedScores,
      decompressedMeasures,
      metadata
    };
  }
  await writeJSON(path.join(webDataDir, 'multi-keys.json'), {
    generatedAt: new Date().toISOString(),
    keys: multi
  });

  // Taxon descriptions (see scripts/fetch-descriptions.js), lazy-loaded by the app.
  const descriptionsPath = path.join(root, 'vicflora-data', 'taxon-descriptions.json');
  if (await fileExists(descriptionsPath)) {
    await fs.copyFile(descriptionsPath, path.join(webDataDir, 'descriptions.json'));
  } else {
    await fs.writeFile(path.join(webDataDir, 'descriptions.json'), JSON.stringify({ taxa: {} }));
  }

  // Glossary (see scripts/fetch-glossary.js), used for tap-to-define terms.
  const glossaryPath = path.join(root, 'vicflora-data', 'glossary.json');
  if (await fileExists(glossaryPath)) {
    await fs.copyFile(glossaryPath, path.join(webDataDir, 'glossary.json'));
  } else {
    await fs.writeFile(path.join(webDataDir, 'glossary.json'), '[]');
  }

  // Bioregion map geometry (see scripts/fetch-bioregions.js).
  const bioregionsPath = path.join(root, 'vicflora-data', 'bioregions.json');
  if (await fileExists(bioregionsPath)) {
    await fs.copyFile(bioregionsPath, path.join(webDataDir, 'bioregions.json'));
  } else {
    await fs.writeFile(path.join(webDataDir, 'bioregions.json'), JSON.stringify({ regions: [] }));
  }

  // Species photo shards and index (see scripts/fetch-photos.js).
  const crypto = require('crypto');
  const photosSrcDir = path.join(root, 'vicflora-data', 'photos');
  const photosDestDir = path.join(webDataDir, 'photos');
  await fs.mkdir(photosDestDir, { recursive: true });
  const photosIndexSrc = path.join(photosSrcDir, 'index.json');
  if (await fileExists(photosIndexSrc)) {
    const photosIndex = await loadJSON(photosIndexSrc);
    const shards = photosIndex.shards || [];
    // Validate every shard (name, size, SHA-256) BEFORE removing any existing web shards.
    for (const shard of shards) {
      if (typeof shard.file !== 'string' || !/^photos-\d+(?:-[a-f0-9]+)?\.bin$/.test(shard.file)) {
        throw new Error(`Invalid photo shard filename in index.json: ${shard.file}`);
      }
      const srcShard = path.join(photosSrcDir, shard.file);
      const stat = await fs.stat(srcShard).catch(() => null);
      if (!stat || stat.size !== shard.bytes) {
        throw new Error(
          `Photo shard integrity check failed for ${shard.file}: expected ${shard.bytes} bytes, got ${stat ? stat.size : 'missing'}.`
        );
      }
      if (shard.sha256) {
        const bytes = await fs.readFile(srcShard);
        const actualSha = crypto.createHash('sha256').update(bytes).digest('hex');
        if (actualSha !== shard.sha256) {
          throw new Error(`Photo shard SHA-256 mismatch for ${shard.file}: expected ${shard.sha256}, got ${actualSha}.`);
        }
      }
    }

    const expectedFiles = new Set(shards.map(s => s.file));
    for (const shard of shards) {
      await fs.copyFile(path.join(photosSrcDir, shard.file), path.join(photosDestDir, shard.file));
    }
    await fs.copyFile(photosIndexSrc, path.join(photosDestDir, 'index.json'));
    for (const name of await fs.readdir(photosDestDir)) {
      if (/^photos-.*\.bin$/.test(name) && !expectedFiles.has(name)) {
        await fs.unlink(path.join(photosDestDir, name));
      }
    }
  } else {
    for (const name of await fs.readdir(photosDestDir)) {
      if (/^photos-.*\.bin$/.test(name)) {
        await fs.unlink(path.join(photosDestDir, name));
      }
    }
    await fs.writeFile(
      path.join(photosDestDir, 'index.json'),
      JSON.stringify({ version: '0', totalBytes: 0, totalImages: 0, taxaCount: 0, shards: [], taxa: {} })
    );
  }

  // Copy config snapshot for reference
  await writeJSON(path.join(webDataDir, 'config.json'), config);

  console.log('✅ Web data bundle generated.');
}

if (require.main === module) {
  main().catch(error => {
    console.error('Error generating web data bundle:', error.message);
    process.exit(1);
  });
}
