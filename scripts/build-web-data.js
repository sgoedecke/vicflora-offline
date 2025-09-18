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

async function main() {
  const root = process.cwd();
  const configPath = path.join(root, 'web', 'web-config.json');
  const defaultConfig = {
    dichotomousKeys: ['1903', '1906', '1907'],
    multiAccessKeys: [
      'key-115cc464-6167-4b50-9c3a-72f0bc8ff745-complete.json',
      'key-2aca28ae-4324-47d1-a43f-d20522e72fea-complete.json'
    ]
  };

  let config = defaultConfig;
  if (await fileExists(configPath)) {
    config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  }

  const webDataDir = path.join(root, 'web', 'public', 'data');
  await fs.mkdir(webDataDir, { recursive: true });

  // Build dichotomous dataset
  const dichotomous = {};
  for (const id of config.dichotomousKeys) {
    const filePath = path.join(root, 'keybase-data', `${id}.json`);
    if (!(await fileExists(filePath))) {
      console.warn(`⚠️  Missing dichotomous key ${id} at ${filePath}`);
      continue;
    }
    const key = await loadJSON(filePath);
    dichotomous[id] = key.keybase || key;
  }
  await writeJSON(path.join(webDataDir, 'dichotomous-keys.json'), {
    generatedAt: new Date().toISOString(),
    keys: dichotomous
  });

  // Build multi-access dataset
  const multi = {};
  for (const fileName of config.multiAccessKeys) {
    const filePath = path.join(root, 'vicflora-data', fileName);
    if (!(await fileExists(filePath))) {
      console.warn(`⚠️  Missing multi-access key file ${fileName}`);
      continue;
    }
    const key = await loadJSON(filePath);
    multi[fileName] = key;
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
