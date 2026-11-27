#!/usr/bin/env node

// Fetches VicFlora hero images and botanical line drawings for all bundled
// species and infraspecific taxa, downscales them to 400px WebP (q70), and
// packs them into stable hash-bucketed (~1.2 MB) content-hashed binary shards
// plus a compact index in vicflora-data/photos/.
//
// Usage:
//   node scripts/fetch-photos.js                    # fetch & pack all taxa
//   node scripts/fetch-photos.js --limit 50         # test on first N taxa (writes to .cache)
//   node scripts/fetch-photos.js --pack-only        # repack shards from cache
//   node scripts/fetch-photos.js --refresh-missing  # re-query taxa with null cached metadata
//   node scripts/fetch-photos.js --concurrency 4    # parallel image downloads/encodes

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const ENDPOINT = 'https://vicflora.rbg.vic.gov.au/graphql';
const CDN_PREFIX = 'https://vicflora-cdn.rbg.vic.gov.au/assets/canto/preview/';
const TARGET_RANKS = new Set(['SPECIES', 'SUBSPECIES', 'VARIETY', 'FORM']);
const GQL_BATCH_SIZE = 50;
const GQL_DELAY_MS = 250;
const MAX_DIMENSION = 400;
const WEBP_QUALITY = 70;
const NUM_SHARDS = 80;

const root = path.resolve(__dirname, '..');
const descriptionsPath = path.join(root, 'vicflora-data', 'taxon-descriptions.json');
const cacheDir = path.join(root, '.cache', 'vicflora-photos');
const metaCachePath = path.join(cacheDir, 'metadata.json');
const drawingCachePath = path.join(cacheDir, 'drawings-metadata.json');
const webpCacheDir = path.join(cacheDir, 'webp');
const defaultOutDir = path.join(root, 'vicflora-data', 'photos');

function parseArgs(argv) {
  const args = {
    limit: Infinity,
    packOnly: false,
    refreshMissing: false,
    allowPartial: false,
    concurrency: 4,
    outDir: null
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--limit' || arg.startsWith('--limit=')) {
      const raw = arg.startsWith('--limit=') ? arg.slice('--limit='.length) : argv[++i];
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`Invalid --limit value: ${raw}. Expected a positive integer.`);
      }
      args.limit = n;
    } else if (arg === '--pack-only') args.packOnly = true;
    else if (arg === '--refresh-missing') args.refreshMissing = true;
    else if (arg === '--allow-partial') args.allowPartial = true;
    else if (arg === '--out' || arg.startsWith('--out=')) {
      const raw = arg.startsWith('--out=') ? arg.slice('--out='.length) : argv[++i];
      if (!raw) throw new Error('Missing path for --out.');
      args.outDir = path.resolve(raw);
    } else if (arg === '--concurrency' || arg.startsWith('--concurrency=')) {
      const raw = arg.startsWith('--concurrency=') ? arg.slice('--concurrency='.length) : argv[++i];
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`Invalid --concurrency value: ${raw}. Expected a positive integer.`);
      }
      args.concurrency = n;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function cleanText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function normalizePersonName(name) {
  // Normalize "Last, First." -> "first last" for deduplication comparison only.
  const cleaned = cleanText(name)
    .replace(/^(?:\(c\)|©)\s*/i, '')
    .replace(/\.+$/, '')
    .trim();
  const parts = cleaned.split(',').map(s => s.replace(/\.+$/, '').trim()).filter(Boolean);
  if (parts.length === 2) return `${parts[1]} ${parts[0]}`.toLowerCase();
  return cleaned.toLowerCase();
}

function formatAttribution(img) {
  if (!img) return 'VicFlora';
  const creator = cleanText(img.creator);
  const owner = cleanText(img.copyrightOwner);
  const license = cleanText(img.license);
  const rights = cleanText(img.rights);

  const parts = [];
  if (creator) parts.push(creator);
  else if (owner) parts.push(owner);

  const shouldAddOwner = Boolean(
    owner &&
    creator &&
    normalizePersonName(owner) !== normalizePersonName(creator) &&
    !normalizePersonName(creator).includes(normalizePersonName(owner))
  );

  if (license) {
    if (shouldAddOwner) parts.push(owner);
    parts.push(license);
  } else if (rights) {
    const normRights = normalizePersonName(rights);
    if (creator && normRights === normalizePersonName(creator)) {
      parts[0] = `© ${creator}`;
    } else if (owner && !creator && normRights === normalizePersonName(owner)) {
      parts[0] = `© ${owner}`;
    } else {
      parts.push(rights);
    }
  } else if (shouldAddOwner) {
    parts.push(owner);
  }

  return parts.join(' · ') || 'VicFlora';
}

function formatDrawingCaption(rawCaption, scientificName = '') {
  if (typeof rawCaption !== 'string' || !rawCaption.trim()) return '';
  // VicFlora illustration captions append "<br/><b>Source:</b> ..." and "<br/><b>Illustration:</b> ...".
  const firstSegment = rawCaption.split(/<br\s*\/?>\s*<b>\s*(?:Source|Illustration|Photo|Image|Copyright)\s*:/i)[0];
  let text = cleanText(firstSegment);
  if (!text) return '';
  text = text
    .replace(/\s*\(?\b(?:Source|Illustration|Photo|Image|Copyright)\s*:.*$/i, '')
    .trim();
  if (!text) return '';
  const cleanName = cleanText(scientificName);
  if (cleanName && text.toLowerCase().startsWith(cleanName.toLowerCase())) {
    text = text.slice(cleanName.length).replace(/^[\s.,;:\-–—]+/, '').trim();
  }
  return text;
}

function pickBestDrawing(images, heroImageId) {
  if (!Array.isArray(images) || !images.length) return null;
  const illustrations = images.filter(
    img =>
      img &&
      img.subtype === 'Illustration' &&
      (img.previewUrl || img.thumbnailUrl) &&
      String(img.id) !== String(heroImageId || '')
  );
  if (!illustrations.length) return null;
  const fov = illustrations.find(img => img.subjectCategory === 'Flora of Victoria Figure');
  return fov || illustrations[0];
}

async function queryGraphQL(query) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'vicflora-offline' },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(30000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (Array.isArray(body.errors) && body.errors.length) {
        throw new Error(`GraphQL errors: ${body.errors.map(e => e.message).join('; ')}`);
      }
      if (!body.data) throw new Error('GraphQL response missing data');
      return body.data;
    } catch (error) {
      if (attempt >= 4) throw error;
      console.warn(`Retrying GraphQL batch (${attempt}/4): ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
    }
  }
}

async function fetchMetadata(taxonIds, metaCache, { refreshMissing = false } = {}) {
  const todo = taxonIds.filter(id => !(id in metaCache) || (refreshMissing && metaCache[id] === null));
  if (!todo.length) {
    console.log(`Metadata cache complete (${taxonIds.length} taxa).`);
    return;
  }
  console.log(`Fetching image metadata for ${todo.length}/${taxonIds.length} taxa...`);

  for (let i = 0; i < todo.length; i += GQL_BATCH_SIZE) {
    const batch = todo.slice(i, i + GQL_BATCH_SIZE);
    const fields = batch
      .map(
        (id, idx) => `t${idx}: taxonConcept(id: "${id}") {
          heroImage {
            id
            creator
            copyrightOwner
            license
            rights
            previewUrl
            thumbnailUrl
          }
        }`
      )
      .join('\n');

    const data = await queryGraphQL(`{ ${fields} }`);
    batch.forEach((id, idx) => {
      const hero = data[`t${idx}`]?.heroImage || null;
      if (hero && (hero.previewUrl || hero.thumbnailUrl)) {
        metaCache[id] = {
          imageId: String(hero.id),
          url: hero.previewUrl || hero.thumbnailUrl,
          attribution: formatAttribution(hero)
        };
      } else {
        metaCache[id] = null;
      }
    });

    const tmpMeta = `${metaCachePath}.tmp`;
    await fsp.writeFile(tmpMeta, JSON.stringify(metaCache));
    await fsp.rename(tmpMeta, metaCachePath);
    const done = Math.min(i + GQL_BATCH_SIZE, todo.length);
    if (done % 500 === 0 || done === todo.length) {
      const withImg = Object.values(metaCache).filter(Boolean).length;
      console.log(`  Metadata ${done}/${todo.length} (${withImg} with hero images so far)`);
    }
    if (done < todo.length) {
      await new Promise(resolve => setTimeout(resolve, GQL_DELAY_MS));
    }
  }
}

async function fetchDrawingMetadata(taxonIds, metaCache, drawingCache, { refreshMissing = false } = {}) {
  const todo = taxonIds.filter(
    id => !(id in drawingCache) || (refreshMissing && drawingCache[id]?.drawing === null)
  );
  if (!todo.length) {
    console.log(`Drawing metadata cache complete (${taxonIds.length} taxa).`);
    return;
  }
  console.log(`Fetching botanical drawing metadata for ${todo.length}/${taxonIds.length} taxa...`);

  for (let i = 0; i < todo.length; i += GQL_BATCH_SIZE) {
    const batch = todo.slice(i, i + GQL_BATCH_SIZE);
    const fields = batch
      .map(
        (id, idx) => `t${idx}: taxonConcept(id: "${id}") {
          taxonName { fullName }
          heroImage {
            id
            subtype
            caption
          }
          images(first: 25) {
            data {
              id
              subtype
              subjectCategory
              caption
              creator
              copyrightOwner
              license
              rights
              previewUrl
              thumbnailUrl
            }
          }
        }`
      )
      .join('\n');

    const data = await queryGraphQL(`{ ${fields} }`);
    batch.forEach((id, idx) => {
      const node = data[`t${idx}`] || null;
      const hero = node?.heroImage || null;
      const heroId = hero?.id ? String(hero.id) : (metaCache[id]?.imageId || null);
      const heroSubtype = hero?.subtype || null;
      const fullName = node?.taxonName?.fullName || '';
      const heroCaption = heroSubtype === 'Illustration' ? formatDrawingCaption(hero?.caption, fullName) : '';
      const imgs = node?.images?.data || [];
      const best = heroSubtype === 'Illustration' ? null : pickBestDrawing(imgs, heroId);

      drawingCache[id] = {
        heroSubtype,
        heroCaption: heroCaption || undefined,
        drawing: best
          ? {
              imageId: String(best.id),
              url: best.previewUrl || best.thumbnailUrl,
              attribution: formatAttribution(best),
              caption: formatDrawingCaption(best.caption, fullName) || undefined
            }
          : null
      };
    });

    const tmpPath = `${drawingCachePath}.tmp`;
    await fsp.writeFile(tmpPath, JSON.stringify(drawingCache));
    await fsp.rename(tmpPath, drawingCachePath);
    const done = Math.min(i + GQL_BATCH_SIZE, todo.length);
    if (done % 500 === 0 || done === todo.length) {
      const withDrawing = Object.values(drawingCache).filter(x => x?.drawing).length;
      const heroIllusts = Object.values(drawingCache).filter(x => x?.heroSubtype === 'Illustration').length;
      console.log(
        `  Drawings metadata ${done}/${todo.length} (${withDrawing} paired drawings, ${heroIllusts} hero illustrations)`
      );
    }
    if (done < todo.length) {
      await new Promise(resolve => setTimeout(resolve, GQL_DELAY_MS));
    }
  }
}

function safeImageFileName(imageId) {
  return `${String(imageId).replace(/[^a-zA-Z0-9_-]/g, '_')}.webp`;
}

async function downloadAndTranscodeOne(imageId, url) {
  const destPath = path.join(webpCacheDir, safeImageFileName(imageId));
  const tmpSrc = path.join(webpCacheDir, `.tmp-${imageId.replace(/[^a-zA-Z0-9_-]/g, '_')}.src`);
  const tmpOut = `${destPath}.tmp.webp`;

  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'vicflora-offline' },
        signal: AbortSignal.timeout(30000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      await fsp.writeFile(tmpSrc, buffer);
      await execFileAsync('magick', [
        tmpSrc,
        '-auto-orient',
        '-strip',
        '-resize',
        `${MAX_DIMENSION}x${MAX_DIMENSION}>`,
        '-quality',
        String(WEBP_QUALITY),
        tmpOut
      ], { timeout: 30000 });
      await fsp.rename(tmpOut, destPath);
      await fsp.unlink(tmpSrc).catch(() => {});
      return;
    } catch (error) {
      await fsp.unlink(tmpSrc).catch(() => {});
      await fsp.unlink(tmpOut).catch(() => {});
      if (attempt >= 3) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
}

async function downloadAndTranscodeAll(uniqueImages, concurrency) {
  const existing = new Set(await fsp.readdir(webpCacheDir));
  const todo = uniqueImages.filter(({ imageId }) => !existing.has(safeImageFileName(imageId)));
  if (!todo.length) {
    console.log(`All ${uniqueImages.length} unique images already cached as WebP.`);
    return [];
  }

  console.log(`Downloading & transcoding ${todo.length}/${uniqueImages.length} images (concurrency=${concurrency})...`);
  let nextIdx = 0;
  let completed = 0;
  const failures = [];
  const startTime = Date.now();

  async function worker() {
    while (nextIdx < todo.length) {
      const current = todo[nextIdx++];
      try {
        await downloadAndTranscodeOne(current.imageId, current.url);
      } catch (error) {
        failures.push({ ...current, error: error.message });
        console.warn(`  ⚠️  Failed ${current.imageId}: ${error.message}`);
      }
      completed += 1;
      if (completed % 100 === 0 || completed === todo.length) {
        const elapsedSec = (Date.now() - startTime) / 1000;
        const rate = completed / Math.max(elapsedSec, 0.1);
        const etaSec = Math.round((todo.length - completed) / Math.max(rate, 0.01));
        console.log(`  Encoded ${completed}/${todo.length} (${rate.toFixed(1)} img/s, ETA ~${etaSec}s, ${failures.length} failed)`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return failures;
}

function shardBucketForImage(imageId, shardCount = NUM_SHARDS) {
  const hex = crypto.createHash('sha256').update(String(imageId)).digest('hex').slice(0, 8);
  return parseInt(hex, 16) % shardCount;
}

function isValidWebpBuffer(buf) {
  return (
    Buffer.isBuffer(buf) &&
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  );
}

async function packShards(taxonIds, metaCache, drawingCache, targetOutDir, { allowPartial = false } = {}) {
  const sortedIds = [...taxonIds].sort();

  // Gather unique images (both primary hero images and paired botanical drawings)
  // and verify cached WebP files exist before modifying output.
  const uniqueImages = new Map(); // imageId -> { imageId, bucket }
  const missingImages = [];
  function collectImage(imageId) {
    if (!imageId || uniqueImages.has(imageId)) return;
    const filePath = path.join(webpCacheDir, safeImageFileName(imageId));
    if (!fs.existsSync(filePath)) {
      missingImages.push(imageId);
      return;
    }
    uniqueImages.set(imageId, {
      imageId,
      bucket: shardBucketForImage(imageId, NUM_SHARDS)
    });
  }

  for (const taxonId of sortedIds) {
    const meta = metaCache[taxonId];
    if (meta) collectImage(meta.imageId);
    const drawing = drawingCache?.[taxonId]?.drawing;
    if (drawing) collectImage(drawing.imageId);
  }

  if (missingImages.length && !allowPartial) {
    throw new Error(
      `${missingImages.length} cached WebP image(s) are missing (e.g. ${missingImages.slice(0, 5).join(', ')}). Re-run without --pack-only or pass --allow-partial.`
    );
  }
  if (!uniqueImages.size) {
    throw new Error('Refusing to pack empty photo set (0 cached WebP images found).');
  }

  // Group into stable hash buckets so adding/updating one species only changes 1 shard.
  const bucketLists = Array.from({ length: NUM_SHARDS }, () => []);
  for (const item of uniqueImages.values()) {
    bucketLists[item.bucket].push(item.imageId);
  }
  for (const list of bucketLists) {
    list.sort();
  }

  // Stage into a temp directory next to targetOutDir, then promote atomically.
  const stagingDir = path.join(path.dirname(targetOutDir), `.photos-staging-${process.pid}-${Date.now()}`);
  await fsp.mkdir(stagingDir, { recursive: true });

  try {
    const imageLocations = new Map(); // imageId -> { shard, offset, length, imgHash }
    const shards = [];
    let totalImageBytes = 0;

    for (const list of bucketLists) {
      if (!list.length) continue;
      const shardIndex = shards.length;
      const buffers = [];
      let offset = 0;

      for (const imageId of list) {
        const filePath = path.join(webpCacheDir, safeImageFileName(imageId));
        const buf = await fsp.readFile(filePath);
        if (!isValidWebpBuffer(buf)) {
          throw new Error(`Invalid WebP header in cached image ${imageId}`);
        }
        const imgHash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
        imageLocations.set(imageId, { shard: shardIndex, offset, length: buf.length, imgHash });
        buffers.push(buf);
        offset += buf.length;
        totalImageBytes += buf.length;
      }

      const combined = Buffer.concat(buffers, offset);
      const sha256 = crypto.createHash('sha256').update(combined).digest('hex');
      const file = `photos-${String(shardIndex).padStart(2, '0')}-${sha256.slice(0, 12)}.bin`;
      await fsp.writeFile(path.join(stagingDir, file), combined);
      shards.push({ file, sha256, bytes: offset, count: list.length });
    }

    const taxaEntries = {};
    const drawingEntries = {};
    for (const taxonId of sortedIds) {
      const meta = metaCache[taxonId];
      const drawingInfo = drawingCache?.[taxonId] || null;
      if (meta) {
        const loc = imageLocations.get(meta.imageId);
        if (loc) {
          const compactUrl = meta.url.startsWith(CDN_PREFIX)
            ? meta.url.slice(CDN_PREFIX.length)
            : meta.url;
          const row = [loc.shard, loc.offset, loc.length, loc.imgHash, meta.attribution, compactUrl];
          if (drawingInfo?.heroSubtype === 'Illustration') {
            row.push('drawing');
            if (drawingInfo.heroCaption) row.push(drawingInfo.heroCaption);
          }
          taxaEntries[taxonId] = row;
        }
      }

      const drawing = drawingInfo?.drawing;
      if (drawing) {
        const loc = imageLocations.get(drawing.imageId);
        if (loc) {
          const compactUrl = drawing.url.startsWith(CDN_PREFIX)
            ? drawing.url.slice(CDN_PREFIX.length)
            : drawing.url;
          const row = [loc.shard, loc.offset, loc.length, loc.imgHash, drawing.attribution, compactUrl];
          if (drawing.caption) row.push(drawing.caption);
          drawingEntries[taxonId] = row;
        }
      }
    }

    const packVersion = crypto
      .createHash('sha256')
      .update(shards.map(s => `${s.file}:${s.sha256}`).join('|'))
      .digest('hex')
      .slice(0, 12);

    const index = {
      version: packVersion,
      format: 'image/webp',
      maxDimension: MAX_DIMENSION,
      quality: WEBP_QUALITY,
      generatedAt: new Date().toISOString(),
      cdnPrefix: CDN_PREFIX,
      totalBytes: totalImageBytes,
      totalImages: imageLocations.size,
      taxaCount: Object.keys(taxaEntries).length,
      drawingsCount: Object.keys(drawingEntries).length,
      shards,
      taxa: taxaEntries,
      drawings: drawingEntries
    };

    await fsp.writeFile(path.join(stagingDir, 'index.json'), JSON.stringify(index));

    // Swap staged directory into targetOutDir.
    const backupDir = `${targetOutDir}.bak-${process.pid}-${Date.now()}`;
    const hadExisting = fs.existsSync(targetOutDir);
    if (hadExisting) {
      await fsp.rename(targetOutDir, backupDir);
    }
    try {
      await fsp.rename(stagingDir, targetOutDir);
    } catch (error) {
      if (hadExisting && fs.existsSync(backupDir)) {
        await fsp.rename(backupDir, targetOutDir).catch(() => {});
      }
      throw error;
    }
    if (hadExisting) {
      await fsp.rm(backupDir, { recursive: true, force: true });
    }

    console.log(
      `✅ Packed ${index.totalImages} unique images (${index.taxaCount} taxa, ${index.drawingsCount} paired drawings) into ${shards.length} shard(s) (${(totalImageBytes / 1024 / 1024).toFixed(2)} MB total) in ${path.relative(root, targetOutDir)}.`
    );
    return index;
  } catch (error) {
    await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await fsp.mkdir(webpCacheDir, { recursive: true });

  const descriptions = JSON.parse(await fsp.readFile(descriptionsPath, 'utf8')).taxa || {};
  let taxonIds = Object.entries(descriptions)
    .filter(([, entry]) => TARGET_RANKS.has(entry?.rank))
    .map(([id]) => id)
    .sort();

  const isLimited = Number.isFinite(args.limit);
  if (isLimited) {
    taxonIds = taxonIds.slice(0, args.limit);
  }

  // Never let a --limit smoke test overwrite production shards unless --out is explicit.
  const targetOutDir = args.outDir || (isLimited ? path.join(cacheDir, 'test-out') : defaultOutDir);

  let metaCache = {};
  try {
    metaCache = JSON.parse(await fsp.readFile(metaCachePath, 'utf8'));
  } catch {
    // First run.
  }

  let drawingCache = {};
  try {
    drawingCache = JSON.parse(await fsp.readFile(drawingCachePath, 'utf8'));
  } catch {
    // First drawing fetch.
  }

  if (!args.packOnly) {
    await fetchMetadata(taxonIds, metaCache, { refreshMissing: args.refreshMissing });
    await fetchDrawingMetadata(taxonIds, metaCache, drawingCache, { refreshMissing: args.refreshMissing });

    const uniqueMap = new Map();
    for (const id of taxonIds) {
      const meta = metaCache[id];
      if (meta && !uniqueMap.has(meta.imageId)) {
        uniqueMap.set(meta.imageId, { imageId: meta.imageId, url: meta.url });
      }
      const drawing = drawingCache[id]?.drawing;
      if (drawing && !uniqueMap.has(drawing.imageId)) {
        uniqueMap.set(drawing.imageId, { imageId: drawing.imageId, url: drawing.url });
      }
    }
    const failures = await downloadAndTranscodeAll([...uniqueMap.values()], args.concurrency);
    if (failures.length) {
      console.warn(`⚠️  ${failures.length} images failed to download/transcode.`);
      if (!args.allowPartial) {
        throw new Error(`Aborting pack due to ${failures.length} failed image(s). Re-run to retry or pass --allow-partial.`);
      }
    }
  }

  await packShards(taxonIds, metaCache, drawingCache, targetOutDir, { allowPartial: args.allowPartial });
}

if (require.main === module) {
  main().catch(error => {
    console.error('Error fetching photos:', error.message);
    process.exit(1);
  });
}

module.exports = {
  formatAttribution,
  formatDrawingCaption,
  pickBestDrawing,
  cleanText,
  normalizePersonName,
  shardBucketForImage,
  isValidWebpBuffer
};
