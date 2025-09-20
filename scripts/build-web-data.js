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

  // Build dichotomous dataset
  const dichotomous = {};
  const pending = [...config.dichotomousKeys.map(id => String(id))];
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
