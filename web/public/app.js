import { createNavigatorFromData } from './modules/dichotomous.js';
import { MultiAccessSession, listMultiKeys } from './modules/multiaccess.js';

const statusEl = document.querySelector('#status');
const viewButtons = document.querySelectorAll('header nav button');
const views = {
  dichotomous: document.querySelector('#view-dichotomous'),
  multi: document.querySelector('#view-multi'),
  about: document.querySelector('#view-about')
};

const dichElements = {
  search: document.querySelector('#dichotomous-key-search'),
  datalist: document.querySelector('#dichotomous-key-list'),
  header: document.querySelector('#dichotomous-header'),
  options: document.querySelector('#dichotomous-options'),
  result: document.querySelector('#dichotomous-result'),
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

let dichNavigator = null;
let multiSession = null;
let globalDichKeys = {};
let multiState = {
  currentCharacterId: null,
  currentKey: null,
  currentKeyInfo: null
};

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

function switchView(view) {
  Object.entries(views).forEach(([name, section]) => {
    const isActive = name === view;
    section.classList.toggle('visible', isActive);
    const button = Array.from(viewButtons).find(btn => btn.dataset.view === name);
    if (button) {
      button.classList.toggle('active', isActive);
    }
  });
}

function initNavigation() {
  viewButtons.forEach(button => {
    button.addEventListener('click', () => switchView(button.dataset.view));
  });
}

function populateDichotomousSelect(keys) {
  const entries = Object.entries(keys)
    .map(([id, key]) => ({ id, title: key.key_title || `Key ${id}` }))
    .sort((a, b) => a.title.localeCompare(b.title));

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

function renderDichotomous() {
  if (!dichNavigator) return;
  const header = dichNavigator.getHeader();
  const options = dichNavigator.getOptions();

  dichElements.header.innerHTML = `
    <strong>${header.keyTitle}</strong>
    ${header.scope ? `<br/><span>${header.scope}</span>` : ''}
    <br/><small>Depth ${header.depth}</small>
  `;

  dichElements.options.innerHTML = '';
  dichElements.result.classList.remove('visible');
  dichElements.result.innerHTML = '';

  if (options.length === 0) {
    dichElements.options.innerHTML = '<p>No leads available. Use back or restart.</p>';
    return;
  }

  options.forEach((option, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.index = index;
    button.innerHTML = `
      <strong>${index + 1}. ${option.lead.lead_text}</strong>
      ${option.item ? `<br/><span>${option.item.item_name || ''}${option.item.to_key ? ` (see key ${option.item.to_key})` : ''}</span>` : ''}
    `;
    button.addEventListener('click', () => handleDichotomousChoice(index));
    dichElements.options.appendChild(button);
  });
}

function showResult(item) {
  dichElements.result.classList.add('visible');
  const lines = [];
  if (item.to_key) {
    lines.push(
      `<h3><button type="button" class="link" data-next-key="${item.to_key}">${item.item_name || 'Result'}</button></h3>`
    );
  } else {
    lines.push(`<h3>${item.item_name || 'Result'}</h3>`);
  }
  if (item.url) {
    lines.push(`<p><a href="${item.url}" target="_blank" rel="noopener">Open VicFlora entry</a></p>`);
  }
  if (item.to_key) {
    lines.push(`<p>Leads to key ${item.to_key}.</p>`);
  }
  dichElements.result.innerHTML = lines.join('');

  const linkButton = dichElements.result.querySelector('button[data-next-key]');
  if (linkButton) {
    linkButton.addEventListener('click', () => {
      const nextKey = linkButton.dataset.nextKey;
      try {
        dichNavigator = createNavigatorFromData(globalDichKeys, String(nextKey));
        dichElements.select.value = String(nextKey);
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
      showResult(outcome.item);
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
    if (dichNavigator && !dichNavigator.back()) {
      setStatus('Already at root of the starting key.');
    } else {
      renderDichotomous();
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
    option.textContent = `${entry.title} (${entry.entities} taxa)`;
    multiElements.select.appendChild(option);
  });
  return list;
}

function renderMultiSummary(session, keyInfo) {
  const totalTaxa = session.possibleTaxa.size + session.eliminatedTaxa.size;
  const remaining = session.possibleTaxa.size;
  const progress = totalTaxa ? Math.round(((totalTaxa - remaining) / totalTaxa) * 100) : 0;
  multiElements.summary.innerHTML = `
    <strong>${keyInfo.title}</strong><br/>
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
    button.textContent = char.name || `Character ${char.id}`;
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
  const character = session.getCharacterById(characterId);
  const statesCard = multiElements.states.closest('.card');

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
      setStatus(`Selected ${character?.name || characterId}: ${state.name || state.id}. Eliminated ${result.eliminated} taxa.`);
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
    li.textContent = `${selection.characterName}: ${selection.stateName}`;
    multiElements.selections.appendChild(li);
  });
}

function renderMultiRemaining(session) {
  const { total, sample } = session.remainingTaxa();
  const parts = [`<p><strong>${total}</strong> taxa remaining.</p>`];
  if (sample.length) {
    parts.push('<ol>');
    sample.forEach(taxon => {
      parts.push(`<li>${taxon.name}</li>`);
    });
    parts.push('</ol>');
  }
  multiElements.remaining.innerHTML = parts.join('');
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
}

function bindMultiControls(list) {
  multiElements.select.addEventListener('change', event => {
    const id = event.target.value;
    const keyInfo = list.find(entry => entry.id === id);
    if (!keyInfo) {
      setStatus('Key not found in dataset');
      return;
    }
    multiSession = new MultiAccessSession(keyInfo.data);
    multiState.currentKey = id;
    multiState.currentKeyInfo = keyInfo;
    multiState.currentCharacterId = null;
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
    renderMultiAll(multiSession);
    const character = multiSession.getCharacterById(undone.characterId);
    const state = multiSession.getStatesByCharacter(undone.characterId).find(s => s.id === undone.stateId);
    setStatus(`Removed ${character?.name || undone.characterId}: ${state?.name || undone.stateId}.`);
  });
}

async function loadData() {
  setStatus('Loading key bundles…');
  const [dichotomousBundle, multiBundle] = await Promise.all([
    fetchJSON('./data/dichotomous-keys.json'),
    fetchJSON('./data/multi-keys.json')
  ]);

  globalDichKeys = dichotomousBundle.keys || {};
  const dichEntries = populateDichotomousSelect(globalDichKeys);
  if (dichEntries.length) {
    dichNavigator = createNavigatorFromData(globalDichKeys, dichEntries[0].id);
    dichElements.search.value = `${dichEntries[0].title} [${dichEntries[0].id}]`;
    renderDichotomous();
  }
  bindDichotomousControls(globalDichKeys);

  const multiList = listMultiKeys(multiBundle.keys || {});
  if (multiList.length) {
    populateMultiSelect(multiList);
    multiSession = new MultiAccessSession(multiList[0].data);
    multiState.currentKey = multiList[0].id;
    multiState.currentKeyInfo = multiList[0];
    renderMultiAll(multiSession);
  }
  bindMultiControls(multiList);

  setStatus('Ready to use offline. Add to Home Screen for easy access.');
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
  registerServiceWorker();
  loadData().catch(error => {
    console.error(error);
    setStatus(error.message);
  });
}

init();
