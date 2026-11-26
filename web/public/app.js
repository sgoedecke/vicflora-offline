import { createNavigatorFromData, listSearchableKeys } from './modules/dichotomous.js';
import { MultiAccessSession, listMultiKeys } from './modules/multiaccess.js';
import {
  buildTaxonIndex,
  findInfraspecificTaxa,
  findSoleInfraspecificProfile,
  mergeDescriptionsIntoIndex,
  searchTaxa,
  taxonIdFromUrl
} from './modules/species.js';
import { Glossary } from './modules/glossary.js';
import { PhotoStore, formatBytes } from './modules/photos.js';

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

const photosStatusEl = document.querySelector('#photos-status');

const photoStore = new PhotoStore();
let photoStatus = null;
let photoSyncProgress = null;
let photoSyncLastError = null;
let photoSyncQuotaExceeded = false;
let photoSyncSkippedReason = null;
let lastStatusUpdateAt = 0;
let lastAutoSyncAttemptAt = 0;
let lastPhotoCheckAt = 0;
let appBooted = false;
let descriptionRenderSeq = 0;

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

function saveState() {
  persisted.view = currentView;
  persisted.dichMode = dichMode;
  persisted.speciesId = currentSpeciesId;
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
    refreshPhotoStatus();
    if (!currentSpeciesId) speciesElements.search.focus();
  }
  if (view === 'about') {
    refreshPhotoStatus();
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
  // Clear on focus so the full key list shows; restore if nothing is picked.
  dichElements.search.addEventListener('focus', () => {
    dichElements.search.placeholder = dichElements.search.value || 'Start typing a key…';
    dichElements.search.value = '';
  });
  dichElements.search.addEventListener('blur', () => {
    if (dichNavigator) setDichotomousSearchValue(dichNavigator.startKeyId);
  });

  dichElements.search.addEventListener('change', event => {
    const value = event.target.value;
    if (!value) return;
    const match = Array.from(dichElements.datalist.options).find(option => option.value === value);
    const keyId = match?.dataset.keyId || value.replace(/.*\[(\d+)\]$/, '$1');
    if (!keys[keyId]) return;
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
    const taxonId = taxonIdFromUrl(taxon.url);
    if (taxonId) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'link';
      button.dataset.taxon = taxonId;
      button.dataset.fallbackUrl = taxon.url;
      button.textContent = taxon.name;
      item.appendChild(button);
    } else if (taxon.url) {
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
  taxonIndex = buildTaxonIndex(globalDichKeys, descriptions);
  if (savedState.speciesId) {
    if (taxonIndex.has(savedState.speciesId)) {
      showSpecies(savedState.speciesId);
    } else {
      ensureDescriptionsLoaded().then(() => {
        if (taxonIndex.has(savedState.speciesId)) {
          showSpecies(savedState.speciesId);
        }
      });
    }
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
        mergeDescriptionsIntoIndex(taxonIndex, descriptions);
      })
      .catch(error => {
        descriptionsLoad = null;
        console.warn('Could not load descriptions:', error);
      });
  }
  return descriptionsLoad;
}

const INFRASPECIFIC_RANK_LABELS = {
  SUBSPECIES: 'subspecies',
  VARIETY: 'variety',
  FORM: 'form'
};

function extractNotesHtml(html) {
  if (!html) return '';
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html;
  return Array.from(wrapper.querySelectorAll('.notes'))
    .map(node => node.innerHTML)
    .join('');
}

const photoLightboxEl = document.querySelector('#photo-lightbox');
const lightboxState = {
  items: [],
  index: 0,
  displayName: '',
  returnFocusEl: null
};

function mediaKindLabel(kind) {
  return kind === 'drawing' ? 'Illustration' : 'Photo';
}

function fitLightboxImage() {
  if (!photoLightboxEl || photoLightboxEl.hidden) return;
  const stage = photoLightboxEl.querySelector('.photo-lightbox-stage');
  const img = photoLightboxEl.querySelector('.photo-lightbox-img');
  if (!stage || !img || !img.naturalWidth || !img.naturalHeight) return;

  const style = window.getComputedStyle(stage);
  const padX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  const padY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
  const availW = Math.max(1, stage.clientWidth - padX);
  const availH = Math.max(1, stage.clientHeight - padY);

  const scale = Math.min(availW / img.naturalWidth, availH / img.naturalHeight);
  img.style.width = `${Math.max(1, Math.floor(img.naturalWidth * scale))}px`;
  img.style.height = `${Math.max(1, Math.floor(img.naturalHeight * scale))}px`;
}

function renderLightboxItem() {
  if (!photoLightboxEl || !lightboxState.items.length) return;
  const item = lightboxState.items[lightboxState.index];
  if (!item) return;

  const speciesEl = photoLightboxEl.querySelector('.photo-lightbox-species');
  const switchEl = photoLightboxEl.querySelector('.photo-lightbox-switch');
  const img = photoLightboxEl.querySelector('.photo-lightbox-img');
  const captionEl = photoLightboxEl.querySelector('.photo-lightbox-caption');
  const creditEl = photoLightboxEl.querySelector('.photo-lightbox-credit');

  const label = mediaKindLabel(item.kind);
  speciesEl.textContent = lightboxState.displayName || '';

  if (lightboxState.items.length > 1) {
    switchEl.hidden = false;
    switchEl.innerHTML = '';
    lightboxState.items.forEach((entry, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = mediaKindLabel(entry.kind);
      btn.className = idx === lightboxState.index ? 'active' : '';
      btn.setAttribute('aria-pressed', idx === lightboxState.index ? 'true' : 'false');
      btn.addEventListener('click', event => {
        event.stopPropagation();
        if (lightboxState.index !== idx) {
          lightboxState.index = idx;
          renderLightboxItem();
        }
      });
      switchEl.append(btn);
    });
  } else {
    switchEl.hidden = true;
    switchEl.innerHTML = '';
  }

  img.style.width = '';
  img.style.height = '';
  img.classList.toggle('is-drawing', item.kind === 'drawing');
  img.alt = `${lightboxState.displayName || 'Species'} ${label.toLowerCase()}`;
  img.src = item.src;

  if (item.caption) {
    captionEl.textContent = item.caption;
    captionEl.hidden = false;
  } else {
    captionEl.textContent = '';
    captionEl.hidden = true;
  }
  creditEl.textContent = `${label}: ${item.attribution}`;

  if (img.complete && img.naturalWidth) {
    requestAnimationFrame(fitLightboxImage);
  }
}

function openPhotoLightbox(items, startIndex, displayName, triggerEl) {
  if (!photoLightboxEl || !items.length) return;
  hideGlossaryTerm();
  lightboxState.items = items;
  lightboxState.index = Math.max(0, Math.min(startIndex, items.length - 1));
  lightboxState.displayName = displayName || '';
  lightboxState.returnFocusEl = triggerEl || document.activeElement;

  photoLightboxEl.hidden = false;
  document.body.classList.add('lightbox-open');
  renderLightboxItem();
  photoLightboxEl.querySelector('.photo-lightbox-close')?.focus();
}

function closePhotoLightbox() {
  if (!photoLightboxEl || photoLightboxEl.hidden) return;
  photoLightboxEl.hidden = true;
  document.body.classList.remove('lightbox-open');
  const img = photoLightboxEl.querySelector('.photo-lightbox-img');
  if (img) {
    img.removeAttribute('src');
    img.style.width = '';
    img.style.height = '';
  }
  const focusTarget = lightboxState.returnFocusEl;
  lightboxState.items = [];
  lightboxState.returnFocusEl = null;
  if (focusTarget && focusTarget.isConnected && typeof focusTarget.focus === 'function') {
    focusTarget.focus();
  }
}

function initPhotoLightbox() {
  if (!photoLightboxEl) return;
  const closeBtn = photoLightboxEl.querySelector('.photo-lightbox-close');
  const stage = photoLightboxEl.querySelector('.photo-lightbox-stage');
  const img = photoLightboxEl.querySelector('.photo-lightbox-img');

  closeBtn?.addEventListener('click', closePhotoLightbox);
  stage?.addEventListener('click', closePhotoLightbox);
  img?.addEventListener('load', fitLightboxImage);

  window.addEventListener('resize', fitLightboxImage);
  document.addEventListener('keydown', event => {
    if (photoLightboxEl.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closePhotoLightbox();
    } else if (event.key === 'ArrowRight' && lightboxState.items.length > 1) {
      event.preventDefault();
      lightboxState.index = (lightboxState.index + 1) % lightboxState.items.length;
      renderLightboxItem();
    } else if (event.key === 'ArrowLeft' && lightboxState.items.length > 1) {
      event.preventDefault();
      lightboxState.index = (lightboxState.index - 1 + lightboxState.items.length) % lightboxState.items.length;
      renderLightboxItem();
    }
  });
}

function createPhotoFigure(source, displayName, onOpenFullscreen) {
  if (!source) return null;
  const label = mediaKindLabel(source.kind);
  const figure = document.createElement('figure');
  figure.className = source.kind === 'drawing' ? 'taxon-photo taxon-photo--drawing' : 'taxon-photo';
  figure.dataset.photoKey = source.key || '';
  figure.dataset.photoKind = source.kind || 'photo';
  figure.dataset.photoOffline = source.offline ? 'true' : 'false';

  if (source.deferred) {
    if (source.constrained && source.onlineUrl && navigator.onLine !== false) {
      const note = document.createElement('p');
      note.className = 'taxon-photo-offline-note';
      note.innerHTML = `${label} paused on low-data connection. <button type="button" class="link" data-load-remote-photo="true">Load</button>`;
      figure.append(note);
      return figure;
    }
    const note = document.createElement('p');
    note.className = 'taxon-photo-offline-note';
    note.textContent = `${label} available once synced offline.`;
    figure.append(note);
    return figure;
  }

  if (!source.src) return null;

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'taxon-photo-trigger';
  trigger.setAttribute('aria-label', `View ${displayName || 'species'} ${label.toLowerCase()} full screen`);

  const img = document.createElement('img');
  img.src = source.src;
  img.alt = `${displayName || 'Species'} ${label.toLowerCase()}`;
  img.loading = 'lazy';
  img.decoding = 'async';

  trigger.append(img);
  trigger.addEventListener('click', () => onOpenFullscreen(source, trigger));

  const caption = document.createElement('figcaption');
  caption.className = 'taxon-photo-credit';
  caption.textContent = `${label}: ${source.attribution}`;

  img.addEventListener('error', () => {
    source.failed = true;
    if (!source.offline) {
      const msg = navigator.onLine === false ? `${label} unavailable offline.` : `Could not load ${label.toLowerCase()}.`;
      figure.innerHTML = `<p class="taxon-photo-offline-note">${msg}</p>`;
    } else {
      figure.remove();
    }
  });

  figure.append(trigger);
  if (source.caption) {
    const legend = document.createElement('p');
    legend.className = 'taxon-photo-caption';
    legend.textContent = source.caption;
    figure.append(legend);
  }
  figure.append(caption);
  return figure;
}

async function resolveTaxonMedia(primaryId, fallbackId, options) {
  let sources = await photoStore.getMediaSources(primaryId, options).catch(() => []);
  if (!sources.length && fallbackId) {
    sources = await photoStore.getMediaSources(fallbackId, options).catch(() => []);
  }
  return sources;
}

function createMediaGallery(sources, displayName) {
  const wrapper = document.createElement('div');
  wrapper.className = sources.length > 1 ? 'taxon-media taxon-media--pair' : 'taxon-media';

  const openFromGallery = (clickedSource, triggerEl) => {
    const viewable = sources.filter(s => s.src && !s.deferred && !s.failed);
    const idx = Math.max(0, viewable.findIndex(s => s.key === clickedSource.key && s.kind === clickedSource.kind));
    openPhotoLightbox(viewable, idx, displayName, triggerEl);
  };

  for (const source of sources) {
    const figure = createPhotoFigure(source, displayName, openFromGallery);
    if (figure) wrapper.append(figure);
  }
  return wrapper.childElementCount ? wrapper : null;
}

async function attachTaxonPhoto(container, token, { allowRemote = true, forceRemote = false } = {}) {
  const primaryId = container.dataset.photoPrimaryId;
  const fallbackId = container.dataset.photoFallbackId || null;
  const displayName = container.dataset.photoDisplayName || 'Species photo';
  if (!primaryId) return;

  const sources = await resolveTaxonMedia(primaryId, fallbackId, { allowRemote, forceRemote });
  if (!container.isConnected || container.dataset.renderToken !== token) return;

  const existing = container.querySelector('.taxon-media');
  if (!sources.length) {
    container.dataset.photoState = photoStore.index ? 'none' : 'pending';
    return;
  }

  const allOffline = sources.every(s => s.offline);
  const anyDeferred = sources.some(s => s.deferred);
  container.dataset.photoState = allOffline ? 'offline' : (anyDeferred ? 'deferred' : 'remote');

  // Don't replace an already-rendered offline gallery with the exact same keys.
  if (existing) {
    const existingFigs = Array.from(existing.querySelectorAll('.taxon-photo'));
    const sameOffline =
      existingFigs.length === sources.length &&
      existingFigs.every(
        (fig, i) => fig.dataset.photoOffline === 'true' && fig.dataset.photoKey === (sources[i].key || '')
      );
    if (sameOffline) return;
  }

  const gallery = createMediaGallery(sources, displayName);
  if (!gallery) return;

  if (existing) {
    existing.replaceWith(gallery);
  } else {
    // Only replace the "No description bundled" placeholder when an actual image is rendered.
    const hasRenderedImage = sources.some(s => s.src && !s.deferred);
    const placeholderOnly =
      hasRenderedImage &&
      container.children.length === 1 &&
      container.firstElementChild?.classList.contains('muted');
    if (placeholderOnly) container.innerHTML = '';
    const vernEl = container.querySelector('.vernacular');
    if (vernEl) vernEl.after(gallery);
    else container.prepend(gallery);
  }
}

async function fillDescription(container, taxonId) {
  if (!container || !taxonId) return;
  const token = String(++descriptionRenderSeq);
  container.dataset.renderToken = token;

  await ensureDescriptionsLoaded();
  if (!container.isConnected || container.dataset.renderToken !== token) return;

  const taxon = descriptions[taxonId];
  const soleChild = findSoleInfraspecificProfile(taxonIndex, taxonId, descriptions);
  const primaryPhotoId = soleChild ? soleChild.entry.id : taxonId;
  const fallbackPhotoId = soleChild ? taxonId : '';
  const displayName = soleChild
    ? soleChild.entry.name
    : (taxon?.name || taxonIndex.get(taxonId)?.name || 'Species photo');

  container.dataset.photoPrimaryId = primaryPhotoId;
  container.dataset.photoFallbackId = fallbackPhotoId;
  container.dataset.photoDisplayName = displayName;

  // Render text immediately without waiting on IndexedDB or photo index network fetches.
  if (soleChild) {
    const vernacular = taxon?.vernacular || soleChild.taxon.vernacular;
    const rankLabel = INFRASPECIFIC_RANK_LABELS[soleChild.taxon.rank] || 'infraspecific taxon';
    const parentNotes = extractNotesHtml(taxon?.html);
    container.innerHTML = `
      ${vernacular ? `<p class="vernacular">${escapeHtml(vernacular)}</p>` : ''}
      <p class="sole-infraspecific-note">Only 1 ${rankLabel} in Victoria — showing <button type="button" class="link scientific_name" data-taxon="${escapeHtml(soleChild.entry.id)}">${escapeHtml(soleChild.entry.name)}</button></p>
      ${soleChild.taxon.html}
      ${parentNotes ? `<div class="species-notes">${parentNotes}</div>` : ''}
    `;
    for (const link of container.querySelectorAll('a[data-taxon]')) {
      if (!taxonIndex.has(link.dataset.taxon)) {
        link.removeAttribute('data-taxon');
      }
    }
    annotateGlossary(container);
    attachTaxonPhoto(container, token);
    return;
  }

  const children = findInfraspecificTaxa(taxonIndex, taxonId, descriptions);
  if (taxon?.html || children.length) {
    container.innerHTML = taxon?.html
      ? `
        ${taxon.vernacular ? `<p class="vernacular">${escapeHtml(taxon.vernacular)}</p>` : ''}
        ${taxon.html}
      `
      : (taxon?.vernacular ? `<p class="vernacular">${escapeHtml(taxon.vernacular)}</p>` : '');
    for (const link of container.querySelectorAll('a[data-taxon]')) {
      if (!taxonIndex.has(link.dataset.taxon)) {
        link.removeAttribute('data-taxon');
      }
    }
    annotateGlossary(container);
    if (children.length) {
      const section = document.createElement('div');
      section.className = 'infraspecific-taxa';
      const list = document.createElement('ul');
      list.className = 'key-links';
      list.innerHTML = children
        .map(
          child =>
            `<li><button type="button" class="link scientific_name" data-taxon="${escapeHtml(child.id)}">${escapeHtml(child.name)}</button></li>`
        )
        .join('');
      section.appendChild(list);
      container.appendChild(section);
    }
  }

  attachTaxonPhoto(container, token);
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
  const appearsIn = keyButtons
    ? `<h4>Appears in</h4><ul class="key-links">${keyButtons}</ul>`
    : '';

  detail.innerHTML = `
    <h3>${escapeHtml(descriptions[taxonId]?.name || entry.name)}</h3>
    <div class="taxon-description"><p class="muted">No description bundled for this taxon.</p></div>
    ${ownKey}
    ${appearsIn}
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
  glossary?.annotate(root);
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
}

function initSpecies() {
  speciesElements.search.addEventListener('input', async () => {
    await ensureDescriptionsLoaded();
    renderSpeciesMatches();
  });

  // Taxon links can appear in search results, multi-access results, and inside description notes.
  document.addEventListener('click', async event => {
    const taxonLink = event.target.closest('[data-taxon]');
    if (taxonLink) {
      const id = taxonLink.dataset.taxon;
      event.preventDefault();
      await ensureDescriptionsLoaded();
      if (taxonIndex.has(id)) {
        switchView('species');
        showSpecies(id);
        speciesElements.detail.scrollIntoView({ block: 'start' });
      } else if (taxonLink.dataset.fallbackUrl) {
        window.open(taxonLink.dataset.fallbackUrl, '_blank', 'noopener,noreferrer');
      }
      return;
    }
    const keyButton = event.target.closest('#species-detail [data-open-key]');
    if (keyButton) {
      openDichotomousKey(keyButton.dataset.openKey);
    }
  });
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = Boolean(navigator.serviceWorker.controller);
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || refreshing) return;
    refreshing = true;
    window.location.reload();
  });
  try {
    const registration = await navigator.serviceWorker.register('./service-worker.js');
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        registration.update().catch(() => {});
      }
    });
  } catch (error) {
    console.warn('Service worker registration failed:', error);
  }
}

function renderPhotosStatus() {
  if (!photosStatusEl) return;
  if (photoSyncProgress && photoSyncProgress.phase !== 'done') {
    const { loadedBytes, totalBytes } = photoSyncProgress;
    photosStatusEl.textContent = `Syncing offline species photos (${formatBytes(loadedBytes)} / ${formatBytes(totalBytes)})…`;
    return;
  }
  if (photoSyncQuotaExceeded) {
    photosStatusEl.textContent = 'Offline species photos paused: not enough free storage on this device.';
    return;
  }
  if (!photoStatus?.available) {
    if (photoSyncSkippedReason === 'constrained-network' || photoStatus?.constrainedNetwork) {
      photosStatusEl.innerHTML = 'Offline species photos paused on low-data connection. <button type="button" class="link" data-photo-force-sync="true">Sync now</button>';
      return;
    }
    photosStatusEl.textContent = '';
    return;
  }
  const sizeLabel = formatBytes(photoStatus.totalBytes);
  const countLabel = photoStatus.taxaCount.toLocaleString();
  const drawingDetail = photoStatus.drawingsCount
    ? `, ${photoStatus.drawingsCount.toLocaleString()} with drawings`
    : '';
  const mediaLabel = photoStatus.drawingsCount ? 'photos & drawings' : 'photos';
  if (photoStatus.synced) {
    const persistHint = photoStatus.persisted === false
      ? ' Add to Home Screen so Safari keeps cached photos offline.'
      : '';
    photosStatusEl.textContent = `Offline species ${mediaLabel} ready: ${countLabel} taxa (${sizeLabel}${drawingDetail}) stored separately from app updates.${persistHint}`;
  } else if (!photoStatus.supported) {
    photosStatusEl.textContent = `Species ${mediaLabel} (${countLabel} taxa) load online when connected.`;
  } else if (photoSyncSkippedReason === 'constrained-network' || photoStatus.constrainedNetwork) {
    photosStatusEl.innerHTML = `Offline species ${mediaLabel} paused on low-data connection (${photoStatus.matchedShardCount}/${photoStatus.shardCount} packs synced, ${escapeHtml(sizeLabel)} total). <button type="button" class="link" data-photo-force-sync="true">Sync now</button>`;
  } else {
    const retryNote = photoSyncLastError ? ' Will resume automatically when signal improves.' : '';
    photosStatusEl.textContent = `Offline species ${mediaLabel}: ${photoStatus.matchedShardCount}/${photoStatus.shardCount} packs synced (${sizeLabel} total).${retryNote}`;
  }
}

async function refreshPhotoStatus() {
  try {
    photoStatus = await photoStore.getStatus();
  } catch (error) {
    console.warn('Could not inspect photo status:', error);
  }
  renderPhotosStatus();
}

function refreshVisiblePhotos(imageKeys = null) {
  const keySet = imageKeys ? new Set(imageKeys) : null;
  const containers = [
    !speciesElements.detail.hidden ? speciesElements.detail.querySelector('.taxon-description') : null,
    dichElements.result.classList.contains('visible') ? dichElements.result.querySelector('.taxon-description') : null
  ].filter(Boolean);

  for (const container of containers) {
    const token = container.dataset.renderToken;
    if (!token || !container.dataset.photoPrimaryId) continue;
    if (container.dataset.photoState === 'none' || container.dataset.photoState === 'offline') continue;
    const figs = Array.from(container.querySelectorAll('.taxon-photo'));
    if (figs.length && figs.every(fig => fig.dataset.photoOffline === 'true')) continue;
    if (keySet && figs.length) {
      const hasMatchingNonOffline = figs.some(
        fig => fig.dataset.photoOffline !== 'true' && fig.dataset.photoKey && keySet.has(fig.dataset.photoKey)
      );
      if (!hasMatchingNonOffline) continue;
    }
    attachTaxonPhoto(container, token);
  }
}

function updatePhotoProgressStatus(text) {
  // Never stomp on key errors or non-default status messages.
  const current = statusEl.textContent || '';
  if (current !== READY_MESSAGE && !current.startsWith('Caching offline photos')) return;
  setStatus(text);
}

async function waitForCoreServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await Promise.race([
      navigator.serviceWorker.ready,
      new Promise(resolve => setTimeout(resolve, 15000))
    ]);
  } catch {
    // Proceed even if SW failed to register (e.g. restricted private mode).
  }
}

async function syncPhotosInBackground({ force = false, immediate = false } = {}) {
  const now = Date.now();
  if (!force && !immediate && now - lastAutoSyncAttemptAt < 5000) return;
  lastAutoSyncAttemptAt = now;

  try {
    if (!force) {
      await waitForCoreServiceWorker();
    }
    photoSyncLastError = null;
    photoSyncSkippedReason = null;

    const result = await photoStore.syncPack({
      force,
      onProgress: progress => {
        photoSyncProgress = progress;
        const ts = Date.now();
        if (progress.phase === 'done' || ts - lastStatusUpdateAt >= 500) {
          lastStatusUpdateAt = ts;
          renderPhotosStatus();
          if (progress.phase !== 'done') {
            updatePhotoProgressStatus(
              `Caching offline photos (${formatBytes(progress.loadedBytes)} / ${formatBytes(progress.totalBytes)})…`
            );
          }
        }
      },
      onShardComplete: ({ imageKeys }) => {
        refreshVisiblePhotos(imageKeys);
      }
    });

    photoSyncProgress = null;
    photoSyncQuotaExceeded = Boolean(result.quotaExceeded);
    photoSyncSkippedReason = result.skippedReason || null;
    if (result.upToDate || result.synced) {
      lastPhotoCheckAt = Date.now();
    }
    await refreshPhotoStatus();
    if (result.synced) {
      refreshVisiblePhotos();
    }
    if (statusEl.textContent.startsWith('Caching offline photos')) {
      setStatus(READY_MESSAGE);
    }
  } catch (error) {
    photoSyncProgress = null;
    photoSyncLastError = error.message || 'Network interrupted';
    console.warn('Background photo sync paused:', error);
    await refreshPhotoStatus();
    if (statusEl.textContent.startsWith('Caching offline photos')) {
      setStatus(READY_MESSAGE);
    }
  }
}

const PHOTO_UPDATE_RECHECK_MS = 6 * 60 * 60 * 1000;

function shouldCheckPhotosOnResume() {
  if (!appBooted) return false;
  if (!photoStatus?.synced) return true;
  return Date.now() - lastPhotoCheckAt >= PHOTO_UPDATE_RECHECK_MS;
}

function initPhotos() {
  window.addEventListener('online', () => {
    if (appBooted) syncPhotosInBackground({ immediate: true });
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && shouldCheckPhotosOnResume()) {
      syncPhotosInBackground();
    }
  });
  window.addEventListener('pageshow', () => {
    if (shouldCheckPhotosOnResume()) {
      syncPhotosInBackground();
    }
  });
  document.addEventListener('click', event => {
    if (event.target.closest('[data-photo-force-sync]')) {
      syncPhotosInBackground({ force: true });
      return;
    }
    const loadBtn = event.target.closest('[data-load-remote-photo]');
    if (loadBtn) {
      const container = loadBtn.closest('.taxon-description');
      if (container?.dataset.renderToken) {
        attachTaxonPhoto(container, container.dataset.renderToken, { allowRemote: true, forceRemote: true });
      }
    }
  });
  initPhotoLightbox();
  refreshPhotoStatus();
}

function init() {
  initNavigation();
  initSpecies();
  initPhotos();
  initGlossary();
  registerServiceWorker();
  if (savedState.view && savedState.view !== currentView) {
    switchView(savedState.view);
  }
  loadData()
    .then(() => {
      appBooted = true;
      syncPhotosInBackground({ immediate: true });
    })
    .catch(error => {
      console.error(error);
      setStatus(error.message);
    });
}

init();
