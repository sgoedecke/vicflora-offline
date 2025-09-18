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
      return {
        lead: option,
        item,
        hasLink: Boolean(item?.to_key)
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
    const { lead, item } = choice;

    if (item) {
      if (item.to_key) {
        const nextKey = this.loadKey(String(item.to_key));
        this.pushState(nextKey);
        return {
          type: 'key-transition',
          item
        };
      }
      return {
        type: 'result',
        item
      };
    }

    state.history.push(state.currentLeadId);
    state.currentLeadId = lead.lead_id;
    return {
      type: 'continue'
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
}

export function createNavigatorFromData(rawKeys, startKeyId = START_KEY_DEFAULT) {
  return new DichotomousNavigator(rawKeys, startKeyId);
}
