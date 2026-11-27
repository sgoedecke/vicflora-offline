const SVG_NS = 'http://www.w3.org/2000/svg';

export function ringToPath(flat) {
  if (!Array.isArray(flat) || flat.length < 6) return '';
  let d = `M${flat[0]} ${flat[1]}`;
  for (let i = 2; i < flat.length; i += 2) {
    d += `L${flat[i]} ${flat[i + 1]}`;
  }
  return `${d}Z`;
}

export function polygonsToPath(polygons) {
  if (!Array.isArray(polygons)) return '';
  const parts = [];
  for (const poly of polygons) {
    for (const ring of poly) {
      const seg = ringToPath(ring);
      if (seg) parts.push(seg);
    }
  }
  return parts.join('');
}

export function projectCoords(lat, lon, projection) {
  if (!projection || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const { minLon, maxLon, minLat, maxLat, cosLat, scale, pad } = projection;
  if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) return null;
  return {
    x: (lon - minLon) * cosLat * scale + pad,
    y: (maxLat - lat) * scale + pad
  };
}

export function pointInRing(x, y, flat) {
  if (!Array.isArray(flat) || flat.length < 6) return false;
  let inside = false;
  const n = flat.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const xi = flat[i];
    const yi = flat[i + 1];
    const xj = flat[j];
    const yj = flat[j + 1];
    const intersects = (yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function pointInRegion(x, y, region) {
  if (!region?.polygons?.length) return false;
  for (const poly of region.polygons) {
    if (!poly.length || !pointInRing(x, y, poly[0])) continue;
    let inHole = false;
    for (let h = 1; h < poly.length; h += 1) {
      if (pointInRing(x, y, poly[h])) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

export function findRegionAtPoint(x, y, regions) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Array.isArray(regions)) return null;
  for (const region of regions) {
    if (pointInRegion(x, y, region)) return region;
  }
  return null;
}

export function normalizeTaxonBioregions(bioregions, fallbackCodes = []) {
  const statusByCode = new Map();
  let native = 0;
  let introduced = 0;
  let uncertain = 0;
  let present = 0;

  if (bioregions && typeof bioregions === 'object') {
    for (const code of bioregions.n || []) {
      if (!statusByCode.has(code)) {
        statusByCode.set(code, 'native');
        native += 1;
      }
    }
    for (const code of bioregions.i || []) {
      if (!statusByCode.has(code)) {
        statusByCode.set(code, 'introduced');
        introduced += 1;
      }
    }
    for (const code of bioregions.u || []) {
      if (!statusByCode.has(code)) {
        statusByCode.set(code, 'uncertain');
        uncertain += 1;
      }
    }
  } else if (Array.isArray(fallbackCodes)) {
    for (const raw of fallbackCodes) {
      const code = String(raw || '').trim();
      if (code && !statusByCode.has(code)) {
        statusByCode.set(code, 'present');
        present += 1;
      }
    }
  }

  return {
    statusByCode,
    counts: {
      native,
      introduced,
      uncertain,
      present,
      total: statusByCode.size
    }
  };
}

export function extractRegionCodesFromContainer(container) {
  if (!container) return [];
  return Array.from(container.querySelectorAll('.region'))
    .map(el => el.textContent.trim())
    .filter(Boolean);
}

// Offline-capable GPS location tracker. Automatically requests device location
// when a map is shown; if geolocation is unavailable, denied, or outside
// Victoria, no dot is shown.
export class LocationTracker {
  constructor() {
    this.coords = null;
    this.timestamp = 0;
    this.attempted = false;
    this.pending = null;
    this.listeners = new Set();
  }

  isSupported() {
    return typeof navigator !== 'undefined' && Boolean(navigator.geolocation);
  }

  canUpdate() {
    return this.isSupported() && (!this.attempted || Boolean(this.coords) || Boolean(this.pending));
  }

  pruneDisconnected() {
    for (const entry of this.listeners) {
      if (entry.isAlive && !entry.isAlive()) {
        this.listeners.delete(entry);
      }
    }
  }

  subscribe(listener, isAlive = null) {
    this.pruneDisconnected();
    if (!this.canUpdate()) {
      return () => {};
    }
    const entry = { listener, isAlive };
    this.listeners.add(entry);
    return () => this.listeners.delete(entry);
  }

  notify() {
    for (const entry of Array.from(this.listeners)) {
      if (entry.isAlive && !entry.isAlive()) {
        this.listeners.delete(entry);
        continue;
      }
      entry.listener(this.coords);
    }
    if (!this.canUpdate()) {
      this.listeners.clear();
    }
  }

  getPositionOnce(options) {
    return new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, options);
    });
  }

  async acquirePosition() {
    try {
      // High accuracy wakes hardware GPS when offline on phones.
      return await this.getPositionOnce({
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 600000
      });
    } catch (err) {
      if (err?.code === 1) throw err;
      return this.getPositionOnce({
        enableHighAccuracy: false,
        timeout: 15000,
        maximumAge: 600000
      });
    }
  }

  ensureLocated() {
    if (!this.isSupported()) return Promise.resolve(null);
    if (this.coords && Date.now() - this.timestamp < 600000) return Promise.resolve(this.coords);
    if (this.pending) return this.pending;
    if (this.attempted && !this.coords) return Promise.resolve(null);

    this.attempted = true;
    this.pending = this.acquirePosition()
      .then(pos => {
        this.coords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        this.timestamp = Date.now();
        this.pending = null;
        this.notify();
        return this.coords;
      })
      .catch(() => {
        this.coords = null;
        this.pending = null;
        this.notify();
        return null;
      });
    return this.pending;
  }
}

export const locationTracker = new LocationTracker();

let bioregionsPromise = null;
let bioregionsCache = null;

export function ensureBioregionsLoaded(fetchImpl = fetch) {
  if (bioregionsCache) return Promise.resolve(bioregionsCache);
  if (!bioregionsPromise) {
    bioregionsPromise = fetchImpl('./data/bioregions.json')
      .then(res => {
        if (!res.ok) throw new Error(`Failed to load bioregions: ${res.status}`);
        return res.json();
      })
      .then(data => {
        bioregionsCache = data;
        return data;
      })
      .catch(error => {
        bioregionsPromise = null;
        console.warn('Could not load bioregions map data:', error);
        return null;
      });
  }
  return bioregionsPromise;
}

function createSvgElement(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, String(v));
  }
  return el;
}

export function createBioregionMap(bioregionData, taxonBioregions, { proseContainer = null, tracker = locationTracker } = {}) {
  if (!bioregionData?.regions?.length || !bioregionData?.projection) return null;

  const fallbackCodes = extractRegionCodesFromContainer(proseContainer);
  const { statusByCode, counts } = normalizeTaxonBioregions(taxonBioregions, fallbackCodes);
  if (!counts.total) return null;

  const { regions, projection } = bioregionData;

  const card = document.createElement('div');
  card.className = 'bioregion-map-card';

  const stage = document.createElement('div');
  stage.className = 'bioregion-map-stage';

  const svg = createSvgElement('svg', {
    class: 'bioregion-map-svg',
    viewBox: `0 0 ${projection.width} ${projection.height}`,
    role: 'img',
    'aria-label': 'Victorian bioregion distribution map'
  });

  const regionsLayer = createSvgElement('g', { class: 'bioregion-layer' });
  const userLayer = createSvgElement('g', { class: 'bioregion-user-layer', hidden: 'true' });

  const userHalo = createSvgElement('circle', { class: 'bioregion-user-halo', r: '10' });
  const userDot = createSvgElement('circle', { class: 'bioregion-user-dot', r: '4.5' });
  userLayer.append(userHalo, userDot);

  // Render absent regions first so recorded regions draw cleanly on top along shared edges.
  const orderedRegions = [...regions].sort((a, b) => {
    const aPresent = statusByCode.has(a.code) ? 1 : 0;
    const bPresent = statusByCode.has(b.code) ? 1 : 0;
    return aPresent - bPresent;
  });

  for (const region of orderedRegions) {
    const status = statusByCode.get(region.code) || 'absent';
    const path = createSvgElement('path', {
      d: polygonsToPath(region.polygons),
      'fill-rule': 'evenodd',
      class: 'bioregion-shape',
      'data-code': region.code,
      'data-status': status
    });
    regionsLayer.append(path);
  }

  svg.append(regionsLayer, userLayer);
  stage.append(svg);

  const legend = document.createElement('div');
  legend.className = 'bioregion-legend';

  const legendItems = [];
  if (counts.native) legendItems.push({ status: 'native', label: 'Native' });
  if (counts.introduced) legendItems.push({ status: 'introduced', label: 'Introduced' });
  if (counts.uncertain) legendItems.push({ status: 'uncertain', label: 'Uncertain' });
  if (counts.present) legendItems.push({ status: 'present', label: 'Recorded' });
  legendItems.push({ status: 'absent', label: 'Not recorded' });

  for (const item of legendItems) {
    const entry = document.createElement('span');
    entry.className = 'bioregion-legend-item';
    const swatch = document.createElement('span');
    swatch.className = `bioregion-swatch bioregion-swatch--${item.status}`;
    entry.append(swatch, document.createTextNode(item.label));
    legend.append(entry);
  }

  const userLegendItem = document.createElement('span');
  userLegendItem.className = 'bioregion-legend-item bioregion-legend-user';
  userLegendItem.hidden = true;
  const userSwatch = document.createElement('span');
  userSwatch.className = 'bioregion-swatch bioregion-swatch--user';
  userLegendItem.append(userSwatch, document.createTextNode('You'));
  legend.append(userLegendItem);

  let unsubscribe = null;

  function updateLocation(coords) {
    if (!card.isConnected) {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      return;
    }

    const userPoint = coords ? projectCoords(coords.lat, coords.lon, projection) : null;
    const userRegion = userPoint ? findRegionAtPoint(userPoint.x, userPoint.y, regions) : null;

    if (userPoint && userRegion) {
      userHalo.setAttribute('cx', userPoint.x.toFixed(1));
      userHalo.setAttribute('cy', userPoint.y.toFixed(1));
      userDot.setAttribute('cx', userPoint.x.toFixed(1));
      userDot.setAttribute('cy', userPoint.y.toFixed(1));
      userLayer.removeAttribute('hidden');
      userLegendItem.hidden = false;
    } else {
      userLayer.setAttribute('hidden', 'true');
      userLegendItem.hidden = true;
    }
  }

  card.append(stage, legend);

  queueMicrotask(() => {
    if (!card.isConnected) return;
    updateLocation(tracker.coords);
    if (tracker.canUpdate?.() ?? true) {
      unsubscribe = tracker.subscribe(updateLocation, () => card.isConnected);
      tracker.ensureLocated();
    }
  });

  return card;
}
