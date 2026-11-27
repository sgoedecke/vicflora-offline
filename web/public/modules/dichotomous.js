const START_KEY_DEFAULT = '1903';

function buildIndex(keyData) {
  const leadsByParent = new Map();
  const leadsById = new Map();
  const items = new Map();

  (keyData.leads || []).forEach(lead => {
    leadsById.set(String(lead.id), lead);
    if (!leadsByParent.has(lead.parent)) {
      leadsByParent.set(lead.parent, []);
    }
    leadsByParent.get(lead.parent).push(lead);
  });

  (keyData.items || []).forEach(item => {
    items.set(item.id, item);
  });

  return { leadsByParent, leadsById, items };
}

function keyContextFromData(keyId, keyData) {
  const root = keyData?.root;
  if (!root) {
    throw new Error(`Key ${keyId} missing root`);
  }
  const { leadsByParent, leadsById, items } = buildIndex(keyData);
  return {
    keyId,
    keyTitle: keyData.title || `Key ${keyId}`,
    taxonomicScope: keyData.scope?.name || null,
    root,
    leadsByParent,
    leadsById,
    items,
    raw: keyData
  };
}

const LINK_THROUGH = '[link through]';

// KeyBase models single-member groups (e.g. a family with one genus) as a lead
// ending at the group, with one "[link through]" child pointing at the member.
function linkThroughItem(context, lead) {
  const children = context.leadsByParent.get(lead.id) || [];
  const link = children.find(child => child.text === LINK_THROUGH && child.item);
  return link ? context.items.get(link.item) || null : null;
}

// Couplets are numbered depth-first, as in printed bracketed keys: the first
// lead's branch is fully numbered before the second lead's.
function buildBracketedKey(context) {
  const couplets = [];
  const numberByNode = new Map();
  const isCouplet = nodeId =>
    (context.leadsByParent.get(nodeId) || []).some(lead => lead.text !== LINK_THROUGH);

  const visit = (nodeId, parentNumber) => {
    const number = couplets.length + 1;
    numberByNode.set(nodeId, number);
    const couplet = { number, parentNumber, nodeId, leads: [] };
    couplets.push(couplet);

    for (const lead of context.leadsByParent.get(nodeId) || []) {
      const item = lead.item ? context.items.get(lead.item) || null : null;
      const entry = { leadId: lead.id, text: lead.text, item, via: null, goto: null };
      if (item) {
        entry.via = linkThroughItem(context, lead);
      } else if (isCouplet(lead.id)) {
        visit(lead.id, number);
        entry.goto = numberByNode.get(lead.id);
      }
      couplet.leads.push(entry);
    }
  };

  visit(context.root, null);
  return { couplets, numberByNode };
}

export class DichotomousNavigator {
  constructor(keysById, startKeyId = START_KEY_DEFAULT) {
    this.keys = keysById;
    this.startKeyId = startKeyId;
    this.stack = [];
    this.reset();
  }

  reset() {
    this.stack = [];
    const start = this.loadKey(this.startKeyId);
    this.pushState(start);
  }

  loadKey(keyId) {
    const raw = this.keys[keyId];
    if (!raw) {
      throw new Error(`Key ${keyId} not found in dataset`);
    }
    return keyContextFromData(keyId, raw);
  }

  pushState(context) {
    this.stack.push({
      context,
      currentLeadId: context.root,
      history: []
    });
  }

  currentState() {
    return this.stack[this.stack.length - 1];
  }

  get currentKeyId() {
    return this.currentState().context.keyId;
  }

  get rootNodeId() {
    return this.currentState().context.root;
  }

  get currentNodeId() {
    return this.currentState().currentLeadId;
  }

  getOptions() {
    const state = this.currentState();
    const { context, currentLeadId } = state;
    const options = context.leadsByParent.get(currentLeadId) || [];
    return options.map(option => {
      const item = option.item ? context.items.get(option.item) : null;
      const via = item ? linkThroughItem(context, option) : null;
      return {
        lead: option,
        item,
        via,
        hasLink: Boolean(item?.toKey || via?.toKey)
      };
    });
  }

  getHeader() {
    const state = this.currentState();
    return {
      keyId: state.context.keyId,
      keyTitle: state.context.keyTitle,
      scope: state.context.taxonomicScope,
      depth: this.stack.length,
      currentLeadId: state.currentLeadId,
      rootNodeId: state.context.root,
      step: state.history.length + 1
    };
  }

  // Navigate directly to a lead node within the current key (for URL deep links),
  // reconstructing the ancestor path from root so Back and Bracketed views work.
  goToLead(leadId) {
    const state = this.currentState();
    const { context } = state;
    const rootStr = String(context.root);
    const targetStr = leadId ? String(leadId) : rootStr;
    if (targetStr === rootStr) {
      state.currentLeadId = context.root;
      state.history = [];
      return true;
    }
    const targetLead = context.leadsById.get(targetStr);
    if (!targetLead || !context.leadsByParent.has(targetLead.id)) {
      return false;
    }

    const ancestors = [];
    const seen = new Set([targetStr]);
    let cursor = targetLead;
    while (cursor && String(cursor.parent) !== rootStr) {
      const parentStr = String(cursor.parent);
      if (seen.has(parentStr)) return false;
      seen.add(parentStr);
      const parentLead = context.leadsById.get(parentStr);
      if (!parentLead) return false;
      ancestors.push(parentLead.id);
      cursor = parentLead;
    }
    ancestors.push(context.root);
    ancestors.reverse();

    state.currentLeadId = targetLead.id;
    state.history = ancestors;
    return true;
  }

  getParentLeadId() {
    const state = this.currentState();
    if (state.history.length) {
      return state.history[state.history.length - 1];
    }
    return null;
  }

  chooseOption(index) {
    const options = this.getOptions();
    const choice = options[index];
    if (!choice) {
      throw new Error('Invalid option index');
    }

    const state = this.currentState();
    const { lead, item, via } = choice;

    if (item) {
      const target = item.toKey ? item : via?.toKey ? via : null;
      if (target) {
        this.openKey(String(target.toKey));
        return {
          type: 'key-transition',
          item: target
        };
      }
      return {
        type: 'result',
        item,
        via
      };
    }

    state.history.push(state.currentLeadId);
    state.currentLeadId = lead.id;
    return {
      type: 'continue'
    };
  }

  openKey(keyId) {
    this.pushState(this.loadKey(String(keyId)));
  }

  hasLinkedKey(keyId) {
    const target = String(keyId);
    for (const item of this.currentState().context.items.values()) {
      if (item?.toKey != null && String(item.toKey) === target) {
        return true;
      }
    }
    return false;
  }

  // Synchronize the key stack with a hash-route keyId: keep the stack on same key,
  // unwind back to an ancestor on Back, push when following a linked key, and start
  // a fresh stack for direct/search/unrelated jumps.
  navigateToKey(keyId, { resetStack = false } = {}) {
    const id = String(keyId);
    if (resetStack) {
      this.startKeyId = id;
      this.reset();
      return;
    }
    if (this.currentKeyId === id) {
      return;
    }
    for (let i = this.stack.length - 1; i >= 0; i -= 1) {
      if (this.stack[i].context.keyId === id) {
        this.stack.length = i + 1;
        return;
      }
    }
    if (this.hasLinkedKey(id)) {
      this.openKey(id);
      return;
    }
    this.startKeyId = id;
    this.reset();
  }

  resetCurrentKey() {
    const state = this.currentState();
    state.currentLeadId = state.context.root;
    state.history = [];
  }

  // Leave the current sub-key, ignoring any step-by-step history within it.
  exitKey() {
    if (this.stack.length > 1) {
      this.stack.pop();
      return true;
    }
    return false;
  }

  getBracketed() {
    const { context, currentLeadId, history } = this.currentState();
    return {
      ...buildBracketedKey(context),
      currentNodeId: currentLeadId,
      pathNodeIds: [...history]
    };
  }

  back() {
    const state = this.currentState();
    if (state.history.length) {
      state.currentLeadId = state.history.pop();
      return true;
    }
    if (this.stack.length > 1) {
      this.stack.pop();
      return true;
    }
    return false;
  }

  findItem(itemId) {
    return this.currentState().context.items.get(itemId) || null;
  }

  serialize() {
    return {
      startKeyId: this.startKeyId,
      stack: this.stack.map(state => ({
        keyId: state.context.keyId,
        currentLeadId: state.currentLeadId,
        history: [...state.history]
      }))
    };
  }

  // Throws if the saved state refers to keys that are no longer bundled.
  restore(saved) {
    if (!saved?.stack?.length) {
      throw new Error('No saved dichotomous state');
    }
    this.stack = saved.stack.map(entry => ({
      context: this.loadKey(String(entry.keyId)),
      currentLeadId: entry.currentLeadId,
      history: Array.isArray(entry.history) ? [...entry.history] : []
    }));
  }
}

export function createNavigatorFromData(rawKeys, startKeyId = START_KEY_DEFAULT) {
  return new DichotomousNavigator(rawKeys, startKeyId);
}

// Returns the build-time deduplicated searchable key list from a compiled
// dichotomous bundle, with a simple fallback for synthetic key maps in tests.
export function listSearchableKeys(bundleOrKeys) {
  if (Array.isArray(bundleOrKeys?.searchableKeys)) {
    return bundleOrKeys.searchableKeys.map(({ id, title }) => ({ id, title }));
  }

  const keys = bundleOrKeys?.keys || bundleOrKeys || {};
  const linked = new Set();
  for (const key of Object.values(keys)) {
    for (const item of key.items || []) {
      if (item?.toKey) linked.add(String(item.toKey));
    }
  }

  const byTitle = new Map();
  for (const [id, key] of Object.entries(keys)) {
    const title = key.title || `Key ${id}`;
    const candidate = { id, title, linked: linked.has(id) };
    const current = byTitle.get(title);
    if (!current || (candidate.linked && !current.linked)) {
      byTitle.set(title, candidate);
    }
  }

  return [...byTitle.values()]
    .map(({ id, title }) => ({ id, title }))
    .sort((a, b) => a.title.localeCompare(b.title));
}
