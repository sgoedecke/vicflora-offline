import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import {
  ringToPath,
  polygonsToPath,
  projectCoords,
  pointInRing,
  pointInRegion,
  findRegionAtPoint,
  normalizeTaxonBioregions,
  LocationTracker
} from '../web/public/modules/bioregions.js';

const require = createRequire(import.meta.url);
const { summarizeTaxonBioregions } = require('../scripts/fetch-bioregions.js');

const bioregionsData = JSON.parse(await fs.readFile(new URL('../vicflora-data/bioregions.json', import.meta.url), 'utf8'));

test('bundled bioregions.json has all 28 Victorian bioregions with valid geometry', () => {
  assert.equal(bioregionsData.regions.length, 28);
  assert.ok(bioregionsData.projection.width > 0);
  assert.ok(bioregionsData.projection.height > 0);

  const codes = new Set(bioregionsData.regions.map(r => r.code));
  assert.equal(codes.size, 28);
  for (const expected of ['GipP', 'VVP', 'Wim', 'LoM', 'VAlp', 'WPro', 'OtR', 'Strz']) {
    assert.ok(codes.has(expected), `expected bioregion ${expected}`);
  }
  for (const region of bioregionsData.regions) {
    assert.ok(region.name.length > 0);
    assert.ok(region.polygons.length > 0, `${region.code} has polygons`);
    assert.ok(polygonsToPath(region.polygons).startsWith('M'), `${region.code} converts to SVG path`);
  }
});

test('ringToPath formats flat coordinate arrays into closed SVG paths', () => {
  assert.equal(ringToPath([0, 0, 10, 0, 10, 10]), 'M0 0L10 0L10 10Z');
  assert.equal(ringToPath([0, 0, 10, 0]), '');
});

test('pointInRing and pointInRegion handle outer rings and holes', () => {
  const outer = [0, 0, 100, 0, 100, 100, 0, 100];
  const hole = [30, 30, 70, 30, 70, 70, 30, 70];
  const region = { code: 'Test', name: 'Test', polygons: [[outer, hole]] };

  assert.equal(pointInRing(15, 15, outer), true);
  assert.equal(pointInRing(150, 15, outer), false);
  assert.equal(pointInRegion(15, 15, region), true);
  assert.equal(pointInRegion(50, 50, region), false);
});

test('projectCoords and findRegionAtPoint locate real Victorian places and reject interstate coords', () => {
  const { projection, regions } = bioregionsData;

  const places = [
    // Melbourne CBD
    { lat: -37.8136, lon: 144.9631, expected: 'GipP' },
    // Horsham (Wimmera)
    { lat: -36.7113, lon: 142.1998, expected: 'Wim' },
    // Mt Hotham / Victorian Alps
    { lat: -36.975, lon: 147.133, expected: 'VAlp' },
    // Ballarat (Victorian Volcanic Plain / Central Victorian Uplands boundary — check inland point near Camperdown)
    { lat: -38.233, lon: 143.15, expected: 'VVP' },
    // Wilsons Promontory inland
    { lat: -39.02, lon: 146.37, expected: 'WPro' }
  ];

  for (const place of places) {
    const pt = projectCoords(place.lat, place.lon, projection);
    assert.ok(pt, `expected projected point for ${place.expected}`);
    const region = findRegionAtPoint(pt.x, pt.y, regions);
    assert.equal(region?.code, place.expected);
  }

  // Interstate / overseas coordinates should never plot inside a Victorian bioregion.
  const outside = [
    { name: 'Sydney', lat: -33.8688, lon: 151.2093 },
    { name: 'Hobart', lat: -42.8821, lon: 147.3272 },
    { name: 'Adelaide', lat: -34.9285, lon: 138.6007 },
    { name: 'Canberra', lat: -35.2809, lon: 149.13 }
  ];
  for (const loc of outside) {
    const pt = projectCoords(loc.lat, loc.lon, projection);
    const region = pt ? findRegionAtPoint(pt.x, pt.y, regions) : null;
    assert.equal(region, null, `${loc.name} should not match a Victorian bioregion`);
  }
});

test('normalizeTaxonBioregions supports structured status and HTML fallback codes', () => {
  const mixed = normalizeTaxonBioregions({ n: ['GipP', 'HSF'], i: ['VVP', 'Wim'], u: ['LoM'] });
  assert.equal(mixed.statusByCode.get('GipP'), 'native');
  assert.equal(mixed.statusByCode.get('VVP'), 'introduced');
  assert.equal(mixed.statusByCode.get('LoM'), 'uncertain');
  assert.deepEqual(mixed.counts, { native: 2, introduced: 2, uncertain: 1, present: 0, total: 5 });

  const fallback = normalizeTaxonBioregions(null, ['GleP', 'VVP', 'GleP']);
  assert.equal(fallback.statusByCode.get('GleP'), 'present');
  assert.equal(fallback.statusByCode.get('VVP'), 'present');
  assert.deepEqual(fallback.counts, { native: 0, introduced: 0, uncertain: 0, present: 2, total: 2 });

  const empty = normalizeTaxonBioregions(null, []);
  assert.equal(empty.counts.total, 0);
});

test('summarizeTaxonBioregions filters non-present occurrences and resolves precedence', () => {
  const summary = summarizeTaxonBioregions([
    { bioregionCode: 'GipP', occurrenceStatus: 'PRESENT', establishmentMeans: 'NATIVE' },
    { bioregionCode: 'GipP', occurrenceStatus: 'PRESENT', establishmentMeans: 'INTRODUCED' },
    { bioregionCode: 'HSF', occurrenceStatus: 'PRESENT', establishmentMeans: 'NATIVE_REINTRODUCED' },
    { bioregionCode: 'VVP', occurrenceStatus: 'PRESENT', establishmentMeans: 'INTRODUCED' },
    { bioregionCode: 'Wim', occurrenceStatus: 'EXCLUDED', establishmentMeans: 'INTRODUCED' },
    { bioregionCode: 'LoM', occurrenceStatus: 'DOUBTFUL', establishmentMeans: 'NATIVE' },
    { bioregionCode: 'OtP', occurrenceStatus: 'PRESENT', establishmentMeans: 'UNCERTAIN' }
  ]);
  assert.deepEqual(summary, {
    n: ['GipP', 'HSF'],
    i: ['VVP'],
    u: ['OtP']
  });
  assert.equal(summarizeTaxonBioregions([]), null);
});

test('LocationTracker does not leak listeners for detached cards or failed/unsupported geolocation', async () => {
  // Unsupported environment never retains listeners.
  const unsupported = new LocationTracker();
  unsupported.isSupported = () => false;
  unsupported.subscribe(() => {}, () => true);
  assert.equal(unsupported.listeners.size, 0);

  // Detached cards are pruned on subsequent subscribe calls even while cached coords prevent notify().
  const tracker = new LocationTracker();
  tracker.isSupported = () => true;
  tracker.coords = { lat: -37.8136, lon: 144.9631 };
  tracker.timestamp = Date.now();
  let firstAlive = true;
  tracker.subscribe(() => {}, () => firstAlive);
  assert.equal(tracker.listeners.size, 1);

  firstAlive = false;
  tracker.subscribe(() => {}, () => true);
  assert.equal(tracker.listeners.size, 1);

  // When geolocation fails and latches, existing listeners are cleared and later subscribes are ignored.
  const failing = new LocationTracker();
  failing.isSupported = () => true;
  failing.acquirePosition = () => Promise.reject({ code: 1 });
  let notified = 0;
  failing.subscribe(() => {
    notified += 1;
  }, () => true);
  assert.equal(failing.listeners.size, 1);
  await failing.ensureLocated();
  assert.equal(notified, 1);
  assert.equal(failing.listeners.size, 0);

  failing.subscribe(() => {}, () => true);
  assert.equal(failing.listeners.size, 0);
});

test('generated offline manifest includes bioregions module and geometry bundle', async () => {
  const manifest = JSON.parse(
    await fs.readFile(new URL('../web/public/data/manifest.json', import.meta.url), 'utf8')
  );
  assert.ok(manifest.shell.includes('./modules/bioregions.js'));
  assert.ok(manifest.data.some(entry => entry.id === 'bioregions' && entry.path === './data/bioregions.json'));
});
