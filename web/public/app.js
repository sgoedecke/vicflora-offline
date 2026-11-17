import { createNavigatorFromData, listSearchableKeys } from './modules/dichotomous.js';
import { MultiAccessSession, listMultiKeys } from './modules/multiaccess.js';
import { buildTaxonIndex, searchTaxa, taxonIdFromUrl } from './modules/species.js';
import { Glossary } from './modules/glossary.js';

const statusEl = document.querySelector('#status');
const viewButtons = document.querySelectorAll('header nav button');
const aboutLink = document.querySelector('#about-link');
const views = {
  dichotomous: document.querySelector('#view-dichotomous'),
  multi: document.querySelector('#view-multi'),
  species: document.querySelector('#view-species'),
  about: document.querySelector('#view-about')
};

const dichElements = {
  search: document.querySelector('#dichotomous-key-search'),
  datalist: document.querySelector('#dichotomous-key-list'),
  header: document.querySelector('#dichotomous-header'),
  options: document.querySelector('#dichotomous-options'),
  result: document.querySelector('#dichotomous-result'),
  bracketed: document.querySelector('#dichotomous-bracketed'),
  modeButtons: document.querySelectorAll('[data-dich-mode]'),
  glossaryToggle: document.querySelector('#glossary-toggle'),
  back: document.querySelector('#dichotomous-back'),
  restart: document.querySelector('#dichotomous-restart')
};

const multiElements = {
  select: document.querySelector('#multi-key-select'),
  summary: document.querySelector('#multi-summary'),
  characters: document.querySelector('#multi-characters'),
  states: document.querySelector('#multi-states'),
  selections: document.querySelector('#multi-selections'),
  remaining: document.querySelector('#multi-remaining'),
  reset: document.querySelector('#multi-reset'),
  undo: document.querySelector('#multi-undo')
};

const speciesElements = {
  search: document.querySelector('#species-search'),
  matches: document.querySelector('#species-matches'),
  detail: document.querySelector('#species-detail')
};

let dichNavigator = null;
let multiSession = null;
let globalDichKeys = {};
let multiState = {
  currentCharacterId: null,
  currentKey: null,
  currentKeyInfo: null
};
let currentView = 'dichotomous';
let dichResultItemId = null;
let dichResult = null;
let multiLoad = null;
let descriptionsLoad = null;
let descriptions = {};
let taxonIndex = new Map();
let currentSpeciesId = null;
let glossary = null;
const glossaryPopover = document.querySelector('#gloss-popover');

const READY_MESSAGE = 'Ready to use offline. Add to Home Screen for easy access.';
const STORAGE_KEY = 'vicflora-offline-state-v1';

// Progress is saved so it survives Android killing the app in the background
// (e.g. while switching to the camera). `savedState` is the snapshot from
// launch; `persisted` is what gets written back as the user goes.
function readSavedState() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

const savedState = readSavedState();
const persisted = { ...savedState };
let dichMode = savedState.dichMode === 'bracketed' ? 'bracketed' : 'interactive';
let glossaryEnabled = savedState.glossaryEnabled !== false;

function saveState() {
  persisted.view = currentView;
  persisted.dichMode = dichMode;
  persisted.speciesId = currentSpeciesId;
  persisted.glossaryEnabled = glossaryEnabled;
  if (dichNavigator) {
    persisted.dich = { ...dichNavigator.serialize(), resultItemId: dichResultItemId };
  }
  if (multiSession && multiState.currentKey) {
    persisted.multi = { key: multiState.currentKey, selections: multiSession.serialize() };
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
  } catch {
    // Storage can be unavailable (private browsing, quota); progress just won't persist.
  }
}

async function fetchJSON(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load ${url}: ${response.status}`);
  }
  return response.json();
}

function setStatus(message) {
  statusEl.textContent = message || '';
}

function formatMeasurement(value) {
  if (!Number.isFinite(value)) return '';
  return Number(value).toLocaleString(undefined, {
    maximumFractionDigits: 2,
    minimumFractionDigits: Number.isInteger(Number(value)) ? 0 : 1
  });
}

function switchView(view) {
  if (!views[view]) return;
  currentView = view;
  Object.entries(views).forEach(([name, section]) => {
    const isActive = name === view;
    section.classList.toggle('visible', isActive);
    const button = Array.from(viewButtons).find(btn => btn.dataset.view === name);
    if (button) {
      button.classList.toggle('active', isActive);
      button.setAttribute('aria-selected', isActive ? 'true' : 'false');
    }
  });

  if (aboutLink) {
    aboutLink.classList.toggle('active', view === 'about');
  }

  if (view === 'multi') {
    ensureMultiLoaded();
  }
  if (view === 'species') {
    ensureDescriptionsLoaded();
    if (!currentSpeciesId) speciesElements.search.focus();
  }
  saveState();
}

function initNavigation() {
  viewButtons.forEach(button => {
    button.addEventListener('click', () => switchView(button.dataset.view));
  });

  aboutLink?.addEventListener('click', () => switchView('about'));
}

function populateDichotomousSelect(keys) {
  const entries = listSearchableKeys(keys);

  const index1903 = entries.findIndex(entry => entry.id === '1903');
  if (index1903 > 0) {
    const [primary] = entries.splice(index1903, 1);
    entries.unshift(primary);
  }

  dichElements.datalist.innerHTML = '';
  entries.forEach(entry => {
    const option = document.createElement('option');
    option.value = `${entry.title} [${entry.id}]`;
    option.dataset.keyId = entry.id;
    dichElements.datalist.appendChild(option);
  });
  return entries;
}

function setDichotomousSearchValue(keyId) {
  const title = globalDichKeys[keyId]?.key_title || `Key ${keyId}`;
  dichElements.search.value = `${title} [${keyId}]`;
}

function itemLabel(item, via) {
  if (!item) return '';
  const name = item.item_name || '';
  const viaName = via ? ` → ${via.item_name || ''}` : '';
  const key = item.to_key || via?.to_key;
  return `${name}${viaName}${key ? ` (see key ${key})` : ''}`;
}

function renderDichotomous() {
  if (!dichNavigator) return;
  dichResultItemId = null;
  dichResult = null;
  const header = dichNavigator.getHeader();

  dichElements.header.innerHTML = `
    <strong>${header.keyTitle}</strong>
    ${header.scope ? `<br/><span>${header.scope}</span>` : ''}
    <br/><small>Depth ${header.depth}</small>
  `;

  dichElements.modeButtons.forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.dichMode === dichMode));
  });

  dichElements.options.innerHTML = '';
  dichElements.result.classList.remove('visible');
  dichElements.result.innerHTML = '';

  const bracketed = dichMode === 'bracketed';
  dichElements.options.hidden = bracketed;
  dichElements.bracketed.hidden = !bracketed;
  if (bracketed) {
    renderBracketed();
    saveState();
    return;
  }
  dichElements.bracketed.innerHTML = '';

  const options = dichNavigator.getOptions();
  if (options.length === 0) {
    dichElements.options.innerHTML = '<p>No leads available. Use back or restart.</p>';
    saveState();
    return;
  }

  options.forEach((option, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.index = index;
    button.innerHTML = `
      <strong>${index + 1}. ${option.lead.lead_text}</strong>
      ${option.item ? `<br/><span>${itemLabel(option.item, option.via)}</span>` : ''}
    `;
    button.addEventListener('click', () => handleDichotomousChoice(index));
    annotateGlossary(button.querySelector('strong'));
    dichElements.options.appendChild(button);
  });
  saveState();
}

const LEAD_MARKS = ['', '′', '″', '‴'];

function renderBracketed() {
  const { couplets, numberByNode, currentNodeId, pathNodeIds } = dichNavigator.getBracketed();
  const onPath = new Set(pathNodeIds);
  const list = dichElements.bracketed;
  list.innerHTML = '';

  couplets.forEach(couplet => {
    const li = document.createElement('li');
    li.className = 'couplet';
    li.id = `couplet-${couplet.number}`;
    li.classList.toggle('on-path', onPath.has(couplet.nodeId));
    li.classList.toggle('current', couplet.nodeId === currentNodeId && couplets.length > 1);

    couplet.leads.forEach((lead, index) => {
      const row = document.createElement('div');
      row.className = 'lead';

      const label = document.createElement('span');
      label.className = 'lead-number';
      label.textContent = `${couplet.number}${LEAD_MARKS[index] ?? String.fromCharCode(97 + index)}`;
      if (index === 0 && couplet.parentNumber) {
        const from = document.createElement('button');
        from.type = 'button';
        from.className = 'link from';
        from.dataset.goto = couplet.parentNumber;
        from.setAttribute('aria-label', `Back to couplet ${couplet.parentNumber}`);
        from.textContent = `(${couplet.parentNumber})`;
        label.append(' ', from);
      }

      const text = document.createElement('span');
      text.className = 'lead-text';
      text.innerHTML = lead.text;
      annotateGlossary(text);

      const dest = document.createElement('span');
      dest.className = 'lead-dest';
      if (lead.goto) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'link';
        button.dataset.goto = lead.goto;
        button.textContent = `→ ${lead.goto}`;
        dest.append(button);
      } else if (lead.item) {
        const keyTarget = lead.item.to_key || lead.via?.to_key;
        const name = document.createElement(keyTarget ? 'button' : 'span');
        name.className = 'taxon';
        if (keyTarget) {
          name.type = 'button';
          name.classList.add('link');
          name.dataset.openKey = keyTarget;
          name.title = `Open key ${keyTarget}`;
        }
        name.textContent = lead.via
          ? `${lead.item.item_name} → ${lead.via.item_name}`
          : lead.item.item_name || '';
        if (keyTarget) name.append(' ›');
        dest.append(name);
      }

      row.append(label, text, dest);
      li.append(row);
    });
    list.append(li);
  });

  const current = numberByNode.get(currentNodeId);
  if (current > 1) {
    scrollToCouplet(current, { flash: false, smooth: false });
  }
}

function scrollToCouplet(number, { flash = true, smooth = true } = {}) {
  const target = document.getElementById(`couplet-${number}`);
  if (!target) return;
  target.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
  if (flash) {
    target.classList.remove('flash');
    void target.offsetWidth;
    target.classList.add('flash');
  }
}

function setDichMode(mode) {
  if (mode === dichMode) return;
  const result = dichResult;
  dichMode = mode;
  renderDichotomous();
  if (mode === 'interactive' && result) {
    showResult(result.item, result.via);
  }
}

function showResult(item, via = null) {
  dichResultItemId = item.item_id ?? null;
  dichResult = { item, via };
  dichElements.result.classList.add('visible');
  const lines = [];
  if (item.to_key) {
    lines.push(
      `<h3><button type="button" class="link" data-next-key="${item.to_key}">${item.item_name || 'Result'}</button></h3>`
    );
  } else {
    lines.push(`<h3>${item.item_name || 'Result'}</h3>`);
  }
  if (via) {
    lines.push(`<p>Represented in Victoria by <strong>${via.item_name || ''}</strong>.</p>`);
  }
  lines.push('<div class="taxon-description"></div>');
  if (item.url) {
    lines.push(`<p><a href="${item.url}" target="_blank" rel="noopener">Open VicFlora entry</a></p>`);
  }
  if (via?.url) {
    lines.push(`<p><a href="${via.url}" target="_blank" rel="noopener">Open VicFlora entry for ${via.item_name || ''}</a></p>`);
  }
  if (item.to_key) {
    lines.push(`<p>Leads to key ${item.to_key}.</p>`);
  }
  dichElements.result.innerHTML = lines.join('');
  fillDescription(
    dichElements.result.querySelector('.taxon-description'),
    taxonIdFromUrl(via?.url) || taxonIdFromUrl(item.url)
  );
  saveState();

  const linkButton = dichElements.result.querySelector('button[data-next-key]');
  if (linkButton) {
    linkButton.addEventListener('click', () => {
      const nextKey = linkButton.dataset.nextKey;
      try {
        dichNavigator = createNavigatorFromData(globalDichKeys, String(nextKey));
        setDichotomousSearchValue(String(nextKey));
        renderDichotomous();
      } catch (error) {
        setStatus(error.message);
      }
    });
  }
}

function handleDichotomousChoice(index) {
  if (!dichNavigator) return;
  try {
    const outcome = dichNavigator.chooseOption(index);
    if (outcome.type === 'result') {
      showResult(outcome.item, outcome.via);
    } else if (outcome.type === 'key-transition') {
      showResult(outcome.item);
      renderDichotomous();
    } else {
      renderDichotomous();
    }
  } catch (error) {
    setStatus(error.message);
  }
}

function bindDichotomousControls(keys) {
  dichElements.search.addEventListener('change', event => {
    const value = event.target.value;
    const match = Array.from(dichElements.datalist.options).find(option => option.value === value);
    const keyId = match?.dataset.keyId || value.replace(/.*\[(\d+)\]$/, '$1');
    try {
      dichNavigator = createNavigatorFromData(keys, keyId);
      renderDichotomous();
    } catch (error) {
      setStatus(error.message);
    }
  });

  dichElements.back.addEventListener('click', () => {
    if (!dichNavigator) return;
    if (dichMode === 'bracketed') {
      if (dichNavigator.exitKey()) {
        renderDichotomous();
      } else {
        setStatus('Already in the starting key.');
      }
      return;
    }
    if (!dichNavigator.back()) {
      setStatus('Already at root of the starting key.');
    } else {
      renderDichotomous();
    }
  });

  dichElements.modeButtons.forEach(button => {
    button.addEventListener('click', () => setDichMode(button.dataset.dichMode));
  });

  dichElements.bracketed.addEventListener('click', event => {
    const target = event.target.closest('button');
    if (!target) return;
    if (target.dataset.goto) {
      scrollToCouplet(target.dataset.goto);
    } else if (target.dataset.openKey) {
      try {
        dichNavigator.openKey(target.dataset.openKey);
        renderDichotomous();
        dichElements.header.scrollIntoView({ block: 'start' });
      } catch (error) {
        setStatus(error.message);
      }
    }
  });

  dichElements.restart.addEventListener('click', () => {
    if (dichNavigator) {
      dichNavigator.reset();
      renderDichotomous();
    }
  });
}

function populateMultiSelect(list) {
  multiElements.select.innerHTML = '';
  list.forEach(entry => {
    const option = document.createElement('option');
    option.value = entry.id;
    const label = entry.displayTitle || entry.title || entry.id;
    option.textContent = `${label} (${entry.entities} taxa)`;
    multiElements.select.appendChild(option);
  });
  return list;
}

function renderMultiSummary(session, keyInfo) {
  const totalTaxa = session.possibleTaxa.size + session.eliminatedTaxa.size;
  const remaining = session.possibleTaxa.size;
  const progress = totalTaxa ? Math.round(((totalTaxa - remaining) / totalTaxa) * 100) : 0;
  const title = keyInfo.displayTitle || keyInfo.title;
  multiElements.summary.innerHTML = `
    <strong>${title}</strong><br/>
    ${keyInfo.entities} taxa · ${keyInfo.characters} characters<br/>
    Remaining: ${remaining} (${progress}% filtered)
  `;
}

function renderMultiCharacters(session) {
  const characters = session.getRelevantCharacters();
  multiElements.characters.innerHTML = '';

  characters.forEach(char => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = session.getCharacterDisplayName(char.id);
    if (char.type === 2) {
      button.dataset.type = 'numeric';
    }
    button.addEventListener('click', () => {
      multiState.currentCharacterId = char.id;
      renderMultiStates(session, char.id);
    });
    multiElements.characters.appendChild(button);
  });

  if (characters.length === 0) {
    multiElements.characters.innerHTML = '<p>No more useful characters. Review remaining taxa.</p>';
  }
}

function renderMultiStates(session, characterId) {
  const states = session.getStatesByCharacter(characterId);
  multiElements.states.innerHTML = '';
  const baseCharacter = session.getCharacterById(characterId);
  const characterName = session.getCharacterDisplayName(characterId);
  const statesCard = multiElements.states.closest('.card');

  if (baseCharacter?.type === 2) {
    const selection = session.getSelection(characterId);
    const range = session.getMeasurementRange(characterId);

    const container = document.createElement('div');
    container.className = 'numeric-character';

    if (range) {
      const rangeInfo = document.createElement('p');
      rangeInfo.className = 'numeric-range';
      rangeInfo.textContent = `Observed range: ${formatMeasurement(range.min)} – ${formatMeasurement(range.max)} (${range.count} taxa scored)`;
      container.appendChild(rangeInfo);
    }

    const form = document.createElement('form');
    form.className = 'numeric-form';

    const label = document.createElement('label');
    label.textContent = 'Enter value:';

    const input = document.createElement('input');
    input.type = 'number';
    input.step = 'any';
    input.placeholder = 'Enter measurement';
    if (selection?.type === 'numeric' && Number.isFinite(selection.value)) {
      input.value = selection.value;
    }

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = 'Apply';

    label.appendChild(input);
    form.append(label, submit);
    container.appendChild(form);

    form.addEventListener('submit', event => {
      event.preventDefault();
      const value = parseFloat(input.value);
      if (!Number.isFinite(value)) {
        setStatus(`Enter a numeric value for ${characterName}.`);
        input.focus();
        return;
      }
      const result = session.applyNumericSelection(characterId, value);
      setStatus(`Selected ${characterName}: ${formatMeasurement(value)}. Eliminated ${result.eliminated} taxa.`);
      renderMultiAll(session);
    });

    multiElements.states.appendChild(container);
    statesCard?.classList.add('active');

    if (range) {
      input.min = String(range.min);
      input.max = String(range.max);
    }

    requestAnimationFrame(() => {
      input.focus({ preventScroll: false });
    });
    return;
  }

  if (!states.length) {
    multiElements.states.innerHTML = '<p>No states to choose for this character.</p>';
    statesCard?.classList.remove('active');
    return;
  }

  states.forEach(state => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = state.name || `State ${state.id}`;
    button.addEventListener('click', () => {
      const result = session.chooseState(characterId, state.id);
      setStatus(`Selected ${characterName}: ${state.name || state.id}. Eliminated ${result.eliminated} taxa.`);
      renderMultiAll(session);
    });
    multiElements.states.appendChild(button);
  });

  statesCard?.classList.add('active');

  requestAnimationFrame(() => {
    const topOffset = statesCard?.getBoundingClientRect().top ?? 0;
    if (Math.abs(topOffset) > 20) {
      statesCard?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    const firstButton = multiElements.states.querySelector('button');
    if (firstButton) {
      firstButton.focus({ preventScroll: true });
    }
  });
}

function renderMultiSelections(session) {
  const selections = session.selections();
  multiElements.selections.innerHTML = '';
  if (!selections.length) {
    multiElements.selections.innerHTML = '<li>No selections yet.</li>';
    return;
  }
  selections.forEach(selection => {
    const li = document.createElement('li');
    if (selection.type === 'numeric') {
      li.textContent = `${selection.characterName}: ${formatMeasurement(selection.value)}`;
    } else {
      li.textContent = `${selection.characterName}: ${selection.stateName}`;
    }
    multiElements.selections.appendChild(li);
  });
}

function renderMultiRemaining(session) {
  const { total, sample } = session.remainingTaxa();
  multiElements.remaining.innerHTML = '';

  const summary = document.createElement('p');
  const count = document.createElement('strong');
  count.textContent = String(total);
  summary.append(count, ' taxa remaining.');
  multiElements.remaining.appendChild(summary);

  if (!sample.length) {
    return;
  }

  const list = document.createElement('ol');
  sample.forEach(taxon => {
    const item = document.createElement('li');
    if (taxon.url) {
      const link = document.createElement('a');
      link.href = taxon.url;
      link.textContent = taxon.name;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      item.appendChild(link);
    } else {
      item.textContent = taxon.name;
    }
    list.appendChild(item);
  });
  multiElements.remaining.appendChild(list);
}

function renderMultiAll(session) {
  if (!session || !multiState.currentKey) return;
  renderMultiSummary(session, multiState.currentKeyInfo);
  renderMultiCharacters(session);
  if (multiState.currentCharacterId) {
    renderMultiStates(session, multiState.currentCharacterId);
  }
  if (!multiState.currentCharacterId) {
    multiElements.states.closest('.card')?.classList.remove('active');
  }
  renderMultiSelections(session);
  renderMultiRemaining(session);
  saveState();
}

function startMultiSession(keyInfo) {
  multiSession = new MultiAccessSession(keyInfo.data);
  multiState.currentKey = keyInfo.id;
  multiState.currentKeyInfo = keyInfo;
  multiState.currentCharacterId = null;
}

function bindMultiControls(list) {
  multiElements.select.addEventListener('change', event => {
    const id = event.target.value;
    const keyInfo = list.find(entry => entry.id === id);
    if (!keyInfo) {
      setStatus('Key not found in dataset');
      return;
    }
    startMultiSession(keyInfo);
    renderMultiAll(multiSession);
  });

  multiElements.reset.addEventListener('click', () => {
    if (!multiSession) return;
    multiSession.reset();
    multiState.currentCharacterId = null;
    renderMultiAll(multiSession);
  });

  multiElements.undo.addEventListener('click', () => {
    if (!multiSession) return;
    const undone = multiSession.undoLastSelection?.();
    if (!undone) {
      setStatus('No selections to undo.');
      return;
    }
    multiState.currentCharacterId = undone.characterId;
    const characterName = multiSession.getCharacterDisplayName
      ? multiSession.getCharacterDisplayName(undone.characterId)
      : (multiSession.getCharacterById?.(undone.characterId)?.name || undone.characterId);

    let removedLabel;
    if (undone.selection?.type === 'numeric') {
      removedLabel = formatMeasurement(undone.selection.value);
    } else {
      const state = multiSession.getStatesByCharacter(undone.characterId).find(s => s.id === undone.selection?.value);
      removedLabel = state?.name || undone.selection?.value;
    }

    renderMultiAll(multiSession);
    setStatus(`Removed ${characterName}: ${removedLabel}.`);
  });
}

async function loadData() {
  setStatus('Loading key bundles…');
  const [dichotomousBundle] = await Promise.all([fetchJSON('./data/dichotomous-keys.json'), loadGlossary()]);

  globalDichKeys = dichotomousBundle.keys || {};
  const dichEntries = populateDichotomousSelect(globalDichKeys);
  if (dichEntries.length) {
    dichNavigator = createNavigatorFromData(globalDichKeys, dichEntries[0].id);
    const saved = savedState.dich;
    if (saved) {
      try {
        const restored = createNavigatorFromData(globalDichKeys, String(saved.startKeyId));
        restored.restore(saved);
        dichNavigator = restored;
      } catch (error) {
        console.warn('Could not restore saved dichotomous progress:', error);
      }
    }
    setDichotomousSearchValue(dichNavigator.startKeyId);
    renderDichotomous();
    const savedResult = saved?.resultItemId != null ? dichNavigator.findItem(saved.resultItemId) : null;
    if (savedResult && !savedResult.to_key) {
      showResult(savedResult);
    }
  }
  bindDichotomousControls(globalDichKeys);
  taxonIndex = buildTaxonIndex(globalDichKeys);
  if (savedState.speciesId && taxonIndex.has(savedState.speciesId)) {
    showSpecies(savedState.speciesId);
  }

  setStatus(READY_MESSAGE);
}

// The multi-access bundle is large, so it is only parsed when that tab is used.
function ensureMultiLoaded() {
  if (!multiLoad) {
    multiLoad = loadMultiData().catch(error => {
      multiLoad = null;
      console.error(error);
      setStatus(error.message);
    });
  }
  return multiLoad;
}

async function loadMultiData() {
  setStatus('Loading multi-access keys…');
  multiElements.summary.textContent = 'Loading multi-access keys…';
  const multiBundle = await fetchJSON('./data/multi-keys.json');

  const multiList = listMultiKeys(multiBundle.keys || {});
  if (multiList.length) {
    populateMultiSelect(multiList);
    const saved = savedState.multi;
    const savedInfo = saved && multiList.find(entry => entry.id === saved.key);
    const keyInfo = savedInfo || multiList[0];
    startMultiSession(keyInfo);
    if (savedInfo) {
      multiSession.restore(saved.selections);
    }
    multiElements.select.value = keyInfo.id;
    renderMultiAll(multiSession);
  } else {
    multiElements.summary.textContent = '';
  }
  bindMultiControls(multiList);

  setStatus(READY_MESSAGE);
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);
}

// Descriptions are only fetched when first needed (a key result or the Species tab).
function ensureDescriptionsLoaded() {
  if (!descriptionsLoad) {
    descriptionsLoad = fetchJSON('./data/descriptions.json')
      .then(bundle => {
        descriptions = bundle.taxa || {};
      })
      .catch(error => {
        descriptionsLoad = null;
        console.warn('Could not load descriptions:', error);
      });
  }
  return descriptionsLoad;
}

async function fillDescription(container, taxonId) {
  if (!container || !taxonId) return;
  await ensureDescriptionsLoaded();
  const taxon = descriptions[taxonId];
  if (!taxon?.html) return;
  container.innerHTML = `
    ${taxon.vernacular ? `<p class="vernacular">${escapeHtml(taxon.vernacular)}</p>` : ''}
    ${taxon.html}
  `;
  annotateGlossary(container);
}

function showSpecies(taxonId) {
  const entry = taxonIndex.get(taxonId);
  if (!entry) return;
  currentSpeciesId = taxonId;
  speciesElements.matches.innerHTML = '';
  const detail = speciesElements.detail;
  detail.hidden = false;

  const keyButtons = entry.keys
    .map(keyId => {
      const title = globalDichKeys[keyId]?.key_title || `Key ${keyId}`;
      return `<li><button type="button" class="link" data-open-key="${escapeHtml(keyId)}">${escapeHtml(title)}</button></li>`;
    })
    .join('');
  const ownKey = entry.toKey && globalDichKeys[entry.toKey]
    ? `<p><button type="button" class="secondary" data-open-key="${escapeHtml(entry.toKey)}">Open key to ${escapeHtml(globalDichKeys[entry.toKey].key_title)}</button></p>`
    : '';

  detail.innerHTML = `
    <h3>${escapeHtml(descriptions[taxonId]?.name || entry.name)}</h3>
    <div class="taxon-description"><p class="muted">No description bundled for this taxon.</p></div>
    ${ownKey}
    <h4>Appears in</h4>
    <ul class="key-links">${keyButtons}</ul>
    <p><a href="https://vicflora.rbg.vic.gov.au/flora/taxon/${escapeHtml(taxonId)}" target="_blank" rel="noopener">Open VicFlora entry</a></p>
  `;
  fillDescription(detail.querySelector('.taxon-description'), taxonId);
  saveState();
}

function openDichotomousKey(keyId) {
  try {
    dichNavigator = createNavigatorFromData(globalDichKeys, String(keyId));
    setDichotomousSearchValue(String(keyId));
    switchView('dichotomous');
    renderDichotomous();
  } catch (error) {
    setStatus(error.message);
  }
}

function renderSpeciesMatches() {
  const results = searchTaxa(taxonIndex, speciesElements.search.value, descriptions);
  speciesElements.matches.innerHTML = results
    .map(entry => {
      const vernacular = descriptions[entry.id]?.vernacular;
      return `<li><button type="button" data-taxon="${escapeHtml(entry.id)}">
        <span class="scientific_name">${escapeHtml(entry.name)}</span>
        ${vernacular ? `<small>${escapeHtml(vernacular)}</small>` : ''}
      </button></li>`;
    })
    .join('');
}

async function loadGlossary() {
  try {
    glossary = new Glossary(await fetchJSON('./data/glossary.json'));
  } catch (error) {
    console.warn('Could not load glossary:', error);
  }
}

function annotateGlossary(root) {
  if (glossaryEnabled) glossary?.annotate(root);
}

const RELATIONSHIP_LABELS = {
  'isOpposedTo': 'Opposite',
  'isRelatedTo(cf.)': 'Compare',
  'hasExactSynonym': 'Synonym',
  'hasPartiallyOverlappingSynonym': 'Similar',
  'hasApproximatelyEqualSynonym': 'Similar',
  'hasVariation': 'Variant',
  'isVariationOf': 'Variant of',
  'hasPlural': 'Plural',
  'isPluralOf': 'Singular',
  'hasAbbreviation': 'Abbreviation',
  'isAbbreviationOf': 'Abbreviation of',
  'hasAdjective': 'Adjective',
  'isAdjectiveOf': 'Noun'
};

function showGlossaryTerm(word) {
  const term = glossary?.lookup(word);
  if (!term) return;
  const related = term.related
    .filter(([, name]) => name !== term.definedBy)
    .map(([type, name]) => {
      const label = RELATIONSHIP_LABELS[type] || 'See';
      const link = glossary.lookup(name)
        ? `<button type="button" class="link" data-gloss="${escapeHtml(name)}">${escapeHtml(name)}</button>`
        : escapeHtml(name);
      return `<li><span>${label}:</span> ${link}</li>`;
    })
    .join('');
  glossaryPopover.innerHTML = `
    <button type="button" class="gloss-close" aria-label="Close">×</button>
    <h3>${escapeHtml(term.name)}</h3>
    ${term.definedBy ? `<p class="muted">Variant of <strong>${escapeHtml(term.definedBy)}</strong></p>` : ''}
    <div class="gloss-definition">${term.definition || '<p class="muted">No definition.</p>'}</div>
    ${related ? `<ul class="gloss-related">${related}</ul>` : ''}
  `;
  glossaryPopover.hidden = false;
}

function hideGlossaryTerm() {
  glossaryPopover.hidden = true;
}

// Capture phase so tapping a term inside a lead button shows the definition
// instead of choosing the lead.
function initGlossary() {
  document.addEventListener(
    'click',
    event => {
      const term = event.target.closest('[data-gloss]');
      if (term) {
        event.preventDefault();
        event.stopPropagation();
        showGlossaryTerm(term.dataset.gloss);
        return;
      }
      if (!glossaryPopover.hidden && (!glossaryPopover.contains(event.target) || event.target.closest('.gloss-close'))) {
        hideGlossaryTerm();
      }
    },
    true
  );
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') hideGlossaryTerm();
  });

  dichElements.glossaryToggle.checked = glossaryEnabled;
  dichElements.glossaryToggle.addEventListener('change', () => {
    glossaryEnabled = dichElements.glossaryToggle.checked;
    const result = dichResult;
    renderDichotomous();
    if (dichMode === 'interactive' && result) showResult(result.item, result.via);
    if (currentSpeciesId) showSpecies(currentSpeciesId);
    saveState();
  });
}

function initSpecies() {
  speciesElements.search.addEventListener('input', async () => {
    await ensureDescriptionsLoaded();
    renderSpeciesMatches();
  });

  // Taxon links can appear in search results and inside description notes anywhere in the app.
  document.addEventListener('click', event => {
    const taxonLink = event.target.closest('[data-taxon]');
    if (taxonLink && taxonIndex.has(taxonLink.dataset.taxon)) {
      event.preventDefault();
      switchView('species');
      showSpecies(taxonLink.dataset.taxon);
      speciesElements.detail.scrollIntoView({ block: 'start' });
      return;
    }
    const keyButton = event.target.closest('#species-detail [data-open-key]');
    if (keyButton) {
      openDichotomousKey(keyButton.dataset.openKey);
    }
  });
}

async function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('./service-worker.js');
    } catch (error) {
      console.warn('Service worker registration failed:', error);
    }
  }
}

function init() {
  initNavigation();
  initSpecies();
  initGlossary();
  registerServiceWorker();
  if (savedState.view && savedState.view !== currentView) {
    switchView(savedState.view);
  }
  loadData().catch(error => {
    console.error(error);
    setStatus(error.message);
  });
}

init();
