const START_KEY_DEFAULT = '1903';

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

function keyContextFromData(keyId, keyData) {
  const root = keyData?.first_step?.root_node_id;
  if (!root) {
    throw new Error(`Key ${keyId} missing first_step.root_node_id`);
  }
  const { leadsByParent, items } = buildIndex(keyData);
  return {
    keyId,
    keyTitle: keyData.key_title || `Key ${keyId}`,
    taxonomicScope: keyData.taxonomic_scope?.item_name || null,
    root,
    leadsByParent,
    items,
    raw: keyData
  };
}

const LINK_THROUGH = '[link through]';

// KeyBase models single-member groups (e.g. a family with one genus) as a lead
// ending at the group, with one "[link through]" child pointing at the member.
function linkThroughItem(context, lead) {
  const children = context.leadsByParent.get(lead.lead_id) || [];
  const link = children.find(child => child.lead_text === LINK_THROUGH && child.item);
  return link ? context.items.get(link.item) || null : null;
}

// Couplets are numbered depth-first, as in printed bracketed keys: the first
// lead's branch is fully numbered before the second lead's.
function buildBracketedKey(context) {
  const couplets = [];
  const numberByNode = new Map();
  const isCouplet = nodeId =>
    (context.leadsByParent.get(nodeId) || []).some(lead => lead.lead_text !== LINK_THROUGH);

  const visit = (nodeId, parentNumber) => {
    const number = couplets.length + 1;
    numberByNode.set(nodeId, number);
    const couplet = { number, parentNumber, nodeId, leads: [] };
    couplets.push(couplet);

    for (const lead of context.leadsByParent.get(nodeId) || []) {
      const item = lead.item ? context.items.get(lead.item) || null : null;
      const entry = { leadId: lead.lead_id, text: lead.lead_text, item, via: null, goto: null };
      if (item) {
        entry.via = linkThroughItem(context, lead);
      } else if (isCouplet(lead.lead_id)) {
        visit(lead.lead_id, number);
        entry.goto = numberByNode.get(lead.lead_id);
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
        hasLink: Boolean(item?.to_key || via?.to_key)
      };
    });
  }

  getHeader() {
    const state = this.currentState();
    return {
      keyId: state.context.keyId,
      keyTitle: state.context.keyTitle,
      scope: state.context.taxonomicScope,
      depth: this.stack.length
    };
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
      const target = item.to_key ? item : via?.to_key ? via : null;
      if (target) {
        this.openKey(String(target.to_key));
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
    state.currentLeadId = lead.lead_id;
    return {
      type: 'continue'
    };
  }

  openKey(keyId) {
    this.pushState(this.loadKey(String(keyId)));
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

function lastEdited(key) {
  const times = [key.timestamp_created, key.timestamp_modified].filter(Boolean).sort();
  return times[times.length - 1] || '';
}

// KeyBase contains some keys uploaded more than once under the same title.
// Keep every key navigable, but only list one per title in search: prefer the
// copy a parent key links to, then the most recently edited.
export function listSearchableKeys(rawKeys) {
  const linked = new Set();
  for (const key of Object.values(rawKeys)) {
    for (const item of key.items || []) {
      if (item?.to_key) linked.add(String(item.to_key));
    }
  }

  const byTitle = new Map();
  for (const [id, key] of Object.entries(rawKeys)) {
    const title = key.key_title || `Key ${id}`;
    const candidate = { id, title, linked: linked.has(id), edited: lastEdited(key) };
    const current = byTitle.get(title);
    if (
      !current ||
      (candidate.linked && !current.linked) ||
      (candidate.linked === current.linked && candidate.edited > current.edited)
    ) {
      byTitle.set(title, candidate);
    }
  }

  return [...byTitle.values()]
    .map(({ id, title }) => ({ id, title }))
    .sort((a, b) => a.title.localeCompare(b.title));
}
