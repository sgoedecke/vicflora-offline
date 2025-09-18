#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');
const readline = require('readline');

function createInterface() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
}

function ask(rl, prompt) {
  return new Promise(resolve => rl.question(prompt, answer => resolve(answer.trim())));
}

async function loadKeyFile(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  return parsed.keybase || parsed;
}

function buildIndex(keyData) {
  const leadsByParent = new Map();
  const items = new Map();

  (keyData.leads || []).forEach(lead => {
    if (!leadsByParent.has(lead.parent_id)) {
      leadsByParent.set(lead.parent_id, []);
    }
    leadsByParent.get(lead.parent_id).push(lead);
  });

  (keyData.items || []).forEach(item => {
    items.set(item.item_id, item);
  });

  return { leadsByParent, items };
}

function printOptions(options, itemsIndex) {
  options.forEach((lead, idx) => {
    const item = lead.item ? itemsIndex.get(lead.item) : null;
    const lines = [];
    lines.push(`${idx + 1}. ${lead.lead_text}`);
    if (item) {
      lines.push(`   → ${item.item_name}${item.to_key ? ` (see key ${item.to_key})` : ''}`);
    }
    console.log(lines.join('\n'));
  });
}

function prepareKeyContext(keyData, fileName = null) {
  const root = keyData.first_step?.root_node_id;
  if (!root) {
    throw new Error('Key missing first_step.root_node_id');
  }

  const { leadsByParent, items } = buildIndex(keyData);
  const keyId = keyData.key_id ? String(keyData.key_id) : fileName;
  return {
    keyId,
    key: keyData,
    leadsByParent,
    items,
    root
  };
}

function printKeyHeader(keyData) {
  console.log(`\n🔑 ${keyData.key_title}`);
  if (keyData.taxonomic_scope?.item_name) {
    console.log(`📚 Scope: ${keyData.taxonomic_scope.item_name}`);
  }
  console.log('\nCommands: number = choose, b = back, r = restart, q = quit\n');
}

async function runNavigator(preparedKeys, startKeyId = '1903') {
  const startContext = preparedKeys.get(startKeyId);
  if (!startContext) {
    throw new Error(`Start key ${startKeyId} not found`);
  }

  const rl = createInterface();
  const stack = [];

  function pushState(context) {
    stack.push({
      context,
      current: context.root,
      history: [],
      headerShown: false
    });
  }

  function resetToStart() {
    stack.length = 0;
    pushState(startContext);
  }

  resetToStart();

  let running = true;
  while (running && stack.length) {
    const state = stack[stack.length - 1];
    const { context } = state;

    if (!state.headerShown) {
      printKeyHeader(context.key);
      state.headerShown = true;
    }

    const options = context.leadsByParent.get(state.current) || [];
    if (!options.length) {
      console.log('\n(No leads here. b to back, r to restart, q to quit)');
      const resp = await ask(rl, '> ');
      if (resp === 'b') {
        if (state.history.length) {
          state.current = state.history.pop();
        } else if (stack.length > 1) {
          stack.pop();
        } else {
          console.log('Already at start.');
        }
      } else if (resp === 'r') {
        resetToStart();
      } else if (resp === 'q') {
        running = false;
      }
      continue;
    }

    console.log('\n' + '='.repeat(40));
    printOptions(options, context.items);
    const resp = await ask(rl, '\nChoose option: ');

    if (resp === 'q') {
      running = false;
      break;
    }
    if (resp === 'b') {
      if (state.history.length) {
        state.current = state.history.pop();
      } else if (stack.length > 1) {
        stack.pop();
      } else {
        console.log('Already at start.');
      }
      continue;
    }
    if (resp === 'r') {
      resetToStart();
      continue;
    }

    const index = Number.parseInt(resp, 10) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= options.length) {
      console.log('Invalid choice');
      continue;
    }

    const selected = options[index];
    if (selected.item) {
      const item = context.items.get(selected.item);
      console.log('\n' + '-'.repeat(40));
      if (item?.item_name) {
        console.log(`🎉 ${item.item_name}`);
      } else {
        console.log('🎉 Result');
      }
      if (item?.url) {
        console.log(`🔗 ${item.url}`);
      }

      const targetKeyId = item?.to_key ? String(item.to_key) : null;
      if (targetKeyId) {
        const nextContext = preparedKeys.get(targetKeyId);
        if (nextContext) {
          console.log(`➡️  Leads to key ${targetKeyId}: ${nextContext.key.key_title}`);
          console.log('-'.repeat(40));
          pushState(nextContext);
          continue;
        }
        console.log(`⚠️  Linked key ${targetKeyId} not found in dataset.`);
      }

      console.log('-'.repeat(40));
      const cont = await ask(rl, 'Enter to continue, q to quit, r to restart: ');
      if (cont === 'q') {
        running = false;
      } else if (cont === 'r') {
        resetToStart();
      }
      continue;
    }

    state.history.push(state.current);
    state.current = selected.lead_id;
  }

  rl.close();
}

async function runKey(input, startKeyId = '1903') {
  if (input instanceof Map) {
    return runNavigator(input, startKeyId);
  }

  const context = prepareKeyContext(input);
  const keyId = context.keyId || startKeyId;
  const prepared = new Map([[keyId, context]]);
  return runNavigator(prepared, keyId);
}

async function main() {
  const dataDir = path.resolve(process.argv[2] || 'keybase-data');
  const startKeyId = process.argv[3] ? String(process.argv[3]) : '1903';
  const files = (await fs.readdir(dataDir).catch(() => [])).filter(f => f.endsWith('.json'));

  if (!files.length) {
    console.error('No JSON key exports found. Run the scraper first.');
    process.exit(1);
  }

  const preparedKeys = new Map();
  for (const file of files.sort()) {
    try {
      const key = await loadKeyFile(path.join(dataDir, file));
      const context = prepareKeyContext(key, path.parse(file).name);
      if (!context.keyId) {
        console.warn(`Skipping ${file}: Missing key identifier`);
        continue;
      }
      preparedKeys.set(context.keyId, context);
    } catch (error) {
      console.warn(`Skipping ${file}: ${error.message}`);
    }
  }

  if (!preparedKeys.size) {
    console.error('Could not load any keys.');
    process.exit(1);
  }

  if (!preparedKeys.has(startKeyId)) {
    console.error(`Start key ${startKeyId} not found in dataset.`);
    process.exit(1);
  }

  console.log(`Starting dichotomous key navigation from key ${startKeyId}.`);
  await runKey(preparedKeys, startKeyId);
}

if (require.main === module) {
  main().catch(error => {
    console.error('Error:', error.message);
    process.exit(1);
  });
}

module.exports = { loadKeyFile, runKey };
