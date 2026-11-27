function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function parseRoute(hash) {
  const raw = String(hash || '').trim().replace(/^#/, '');
  const trimmed = raw.replace(/^\/+|\/+$/g, '');
  if (!trimmed) {
    return { view: 'home' };
  }

  const parts = trimmed.split('/').map(safeDecode);
  const [section, first, second, third] = parts;

  if (section === 'key' && first) {
    if (second === 'bracketed' && parts.length === 3) {
      return { view: 'key', keyId: first, leadId: null, mode: 'bracketed' };
    }
    if (second === 'step' && third && parts.length === 4) {
      return { view: 'key', keyId: first, leadId: third, mode: 'interactive' };
    }
    if (parts.length === 2) {
      return { view: 'key', keyId: first, leadId: null, mode: 'interactive' };
    }
    return { view: 'key', keyId: first, leadId: null, mode: 'interactive' };
  }

  if (section === 'multi') {
    return { view: 'multi', keyId: first || null };
  }

  if (section === 'taxon' && first) {
    return { view: 'taxon', taxonId: first };
  }

  if (section === 'about') {
    return { view: 'about' };
  }

  return { view: 'home' };
}

export function formatRoute(route) {
  if (!route || route.view === 'home') {
    return '#/';
  }

  if (route.view === 'key' && route.keyId) {
    const keyPart = encodeURIComponent(String(route.keyId));
    if (route.mode === 'bracketed') {
      return `#/key/${keyPart}/bracketed`;
    }
    if (route.leadId) {
      return `#/key/${keyPart}/step/${encodeURIComponent(String(route.leadId))}`;
    }
    return `#/key/${keyPart}`;
  }

  if (route.view === 'multi') {
    return route.keyId ? `#/multi/${encodeURIComponent(String(route.keyId))}` : '#/multi';
  }

  if (route.view === 'taxon' && route.taxonId) {
    return `#/taxon/${encodeURIComponent(String(route.taxonId))}`;
  }

  if (route.view === 'about') {
    return '#/about';
  }

  return '#/';
}

export function routesEqual(a, b) {
  if (!a || !b || a.view !== b.view) return false;
  if (a.view === 'key') {
    return a.keyId === b.keyId && a.leadId === b.leadId && a.mode === b.mode;
  }
  if (a.view === 'multi') {
    return a.keyId === b.keyId;
  }
  if (a.view === 'taxon') {
    return a.taxonId === b.taxonId;
  }
  return true;
}
