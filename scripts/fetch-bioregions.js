#!/usr/bin/env node

// Fetches Victoria's 28 bioregion polygons into vicflora-data/bioregions.json
// and backfills structured per-taxon bioregion status (native / introduced /
// uncertain) into vicflora-data/taxon-descriptions.json.
//
// Usage:
//   node scripts/fetch-bioregions.js                # polygons + missing taxon bioregions
//   node scripts/fetch-bioregions.js --polygons     # only refresh bioregion polygons
//   node scripts/fetch-bioregions.js --refresh      # re-fetch bioregions for all taxa

const fs = require('fs').promises;
const path = require('path');

const ENDPOINT = 'https://vicflora.rbg.vic.gov.au/graphql';
const BIOREGION_IDS = Array.from({ length: 28 }, (_, i) => i + 1);
const BATCH_SIZE = 100;
const REQUEST_DELAY_MS = 250;
const SIMPLIFY_TOLERANCE_DEG = 0.012;
const MIN_RING_AREA_SQ_DEG = 0.0003;

const root = path.resolve(__dirname, '..');
const bioregionsOutPath = path.join(root, 'vicflora-data', 'bioregions.json');
const descriptionsPath = path.join(root, 'vicflora-data', 'taxon-descriptions.json');

function parseArgs(argv) {
  return {
    polygonsOnly: argv.includes('--polygons'),
    refresh: argv.includes('--refresh')
  };
}

async function queryGraphQL(query) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'vicflora-offline' },
        body: JSON.stringify({ query })
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (body.errors?.length && !body.data) {
        throw new Error(body.errors[0].message);
      }
      return body.data || {};
    } catch (error) {
      if (attempt >= 3) throw error;
      console.warn(`Retrying GraphQL request (${attempt}/3): ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
    }
  }
}

function perpDistSq(p, a, b) {
  let dx = b[0] - a[0];
  let dy = b[1] - a[1];
  if (dx !== 0 || dy !== 0) {
    const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      a = b;
    } else if (t > 0) {
      dx = p[0] - (a[0] + dx * t);
      dy = p[1] - (a[1] + dy * t);
      return dx * dx + dy * dy;
    }
  }
  dx = p[0] - a[0];
  dy = p[1] - a[1];
  return dx * dx + dy * dy;
}

function simplifyDP(pts, sqTol) {
  if (pts.length <= 2) return pts;
  let maxSq = 0;
  let idx = 0;
  const last = pts.length - 1;
  for (let i = 1; i < last; i += 1) {
    const d = perpDistSq(pts[i], pts[0], pts[last]);
    if (d > maxSq) {
      maxSq = d;
      idx = i;
    }
  }
  if (maxSq > sqTol) {
    const left = simplifyDP(pts.slice(0, idx + 1), sqTol);
    const right = simplifyDP(pts.slice(idx), sqTol);
    return left.slice(0, -1).concat(right);
  }
  return [pts[0], pts[last]];
}

function ringAreaSqDeg(ring) {
  let area = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return Math.abs(area) / 2;
}

function simplifyRing(ring, tol) {
  if (!Array.isArray(ring) || ring.length < 4) return null;
  if (ringAreaSqDeg(ring) < MIN_RING_AREA_SQ_DEG) return null;
  const open = ring.slice(0, -1);
  const half = Math.floor(open.length / 2);
  const sqTol = tol * tol;
  const first = simplifyDP(open.slice(0, half + 1), sqTol);
  const second = simplifyDP(open.slice(half).concat([open[0]]), sqTol);
  const merged = first.slice(0, -1).concat(second.slice(0, -1));
  if (merged.length < 3) return null;
  return merged;
}

function extractPolygons(geometry) {
  let coords = geometry?.coordinates;
  if (typeof coords === 'string') coords = JSON.parse(coords);
  const rawPolygons = geometry?.type === 'Polygon' ? [coords] : (coords || []);
  const polygons = [];
  for (const poly of rawPolygons) {
    const outer = simplifyRing(poly[0], SIMPLIFY_TOLERANCE_DEG);
    if (!outer) continue;
    const holes = [];
    for (let h = 1; h < poly.length; h += 1) {
      const hole = simplifyRing(poly[h], SIMPLIFY_TOLERANCE_DEG);
      if (hole) holes.push(hole);
    }
    polygons.push([outer, ...holes]);
  }
  return polygons;
}

function normalizeBioregionName(name) {
  if (!name) return '';
  return name.replace(/Highlands-(Southern|Northern|Far)/g, 'Highlands - $1');
}

function summarizeTaxonBioregions(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const native = new Set();
  const introduced = new Set();
  const uncertain = new Set();

  for (const row of rows) {
    const code = row?.bioregionCode;
    if (!code) continue;
    if (row.occurrenceStatus && row.occurrenceStatus !== 'PRESENT') continue;

    if (row.establishmentMeans === 'NATIVE' || row.establishmentMeans === 'NATIVE_REINTRODUCED') {
      native.add(code);
    } else if (row.establishmentMeans === 'INTRODUCED') {
      introduced.add(code);
    } else {
      uncertain.add(code);
    }
  }

  // If a taxon has conflicting rows for the same bioregion, prefer native > introduced > uncertain.
  for (const code of native) {
    introduced.delete(code);
    uncertain.delete(code);
  }
  for (const code of introduced) {
    uncertain.delete(code);
  }

  const out = {};
  if (native.size) out.n = [...native].sort();
  if (introduced.size) out.i = [...introduced].sort();
  if (uncertain.size) out.u = [...uncertain].sort();
  return Object.keys(out).length ? out : null;
}

async function fetchBioregionPolygons() {
  const fields = BIOREGION_IDS.map(
    id => `b${id}: bioregion(id: ${id}) { properties { id code name } geometry { type coordinates } }`
  ).join('\n');

  const data = await queryGraphQL(`{ ${fields} }`);
  const rawRegions = [];
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;

  for (const id of BIOREGION_IDS) {
    const item = data[`b${id}`];
    if (!item?.properties?.code || !item?.geometry) continue;
    const polygons = extractPolygons(item.geometry);
    for (const poly of polygons) {
      for (const ring of poly) {
        for (const [lon, lat] of ring) {
          if (lon < minLon) minLon = lon;
          if (lon > maxLon) maxLon = lon;
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
        }
      }
    }
    rawRegions.push({
      id: Number(item.properties.id) || id,
      code: item.properties.code,
      name: normalizeBioregionName(item.properties.name),
      polygons
    });
  }

  const pad = 10;
  const width = 560;
  const midLat = (minLat + maxLat) / 2;
  const cosLat = Math.cos((midLat * Math.PI) / 180);
  const spanX = (maxLon - minLon) * cosLat;
  const spanY = maxLat - minLat;
  const scale = (width - pad * 2) / spanX;
  const height = Math.round(spanY * scale + pad * 2);

  const projectPoint = ([lon, lat]) => [
    Math.round(((lon - minLon) * cosLat * scale + pad) * 10) / 10,
    Math.round(((maxLat - lat) * scale + pad) * 10) / 10
  ];

  const regions = rawRegions
    .map(region => ({
      code: region.code,
      name: region.name,
      // Each polygon is an array of rings ([outer, ...holes]); each ring is flat [x0, y0, x1, y1, ...].
      polygons: region.polygons.map(poly =>
        poly.map(ring => {
          const flat = [];
          for (const pt of ring) {
            const [x, y] = projectPoint(pt);
            flat.push(x, y);
          }
          return flat;
        })
      )
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const payload = {
    generatedAt: new Date().toISOString(),
    projection: {
      width,
      height,
      pad,
      minLon: Math.round(minLon * 10000) / 10000,
      maxLon: Math.round(maxLon * 10000) / 10000,
      minLat: Math.round(minLat * 10000) / 10000,
      maxLat: Math.round(maxLat * 10000) / 10000,
      cosLat: Math.round(cosLat * 1000000) / 1000000,
      scale: Math.round(scale * 10000) / 10000
    },
    regions
  };

  await fs.writeFile(bioregionsOutPath, JSON.stringify(payload));
  const stat = await fs.stat(bioregionsOutPath);
  console.log(`Saved ${regions.length} bioregions to ${bioregionsOutPath} (${(stat.size / 1024).toFixed(1)} KB)`);
  return payload;
}

async function backfillTaxonBioregions({ refresh = false } = {}) {
  const store = JSON.parse(await fs.readFile(descriptionsPath, 'utf8'));
  const allIds = Object.keys(store.taxa || {});
  const todo = refresh
    ? allIds
    : allIds.filter(id => !Object.prototype.hasOwnProperty.call(store.taxa[id], 'bioregions'));

  console.log(`${allIds.length} taxa in descriptions, ${todo.length} to fetch bioregions for.`);
  if (!todo.length) return;

  let withBioregions = 0;
  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    const batch = todo.slice(i, i + BATCH_SIZE);
    const fields = batch
      .map(
        (id, index) =>
          `t${index}: taxonConcept(id: "${id}") { bioregions { bioregionCode occurrenceStatus establishmentMeans } }`
      )
      .join('\n');

    const data = await queryGraphQL(`{ ${fields} }`);
    batch.forEach((id, index) => {
      const taxon = data[`t${index}`];
      const summary = summarizeTaxonBioregions(taxon?.bioregions);
      if (summary) {
        store.taxa[id].bioregions = summary;
        withBioregions += 1;
      } else {
        store.taxa[id].bioregions = null;
      }
    });

    if ((i + BATCH_SIZE) % 1000 === 0 || i + BATCH_SIZE >= todo.length) {
      store.generatedAt = new Date().toISOString();
      await fs.writeFile(descriptionsPath, JSON.stringify(store));
      console.log(
        `Fetched bioregions for ${Math.min(i + BATCH_SIZE, todo.length)}/${todo.length} (${withBioregions} with data)`
      );
    }
    await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY_MS));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await fetchBioregionPolygons();
  if (!args.polygonsOnly) {
    await backfillTaxonBioregions({ refresh: args.refresh });
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('Error fetching bioregions:', error.message);
    process.exit(1);
  });
}

module.exports = { summarizeTaxonBioregions };
