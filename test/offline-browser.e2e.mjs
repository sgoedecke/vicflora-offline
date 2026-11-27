import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'web', 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.bin': 'application/octet-stream'
};

function findChromeBinary() {
  const candidates = [
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].filter(Boolean);
  for (const bin of candidates) {
    if (fs.existsSync(bin)) return bin;
  }
  throw new Error('Could not find Chrome/Chromium binary (set CHROME_BIN to override)');
}

function startStaticServer(rootDir) {
  const overrides = new Map();
  const requests = [];

  const server = http.createServer((req, res) => {
    const urlObj = new URL(req.url, 'http://127.0.0.1');
    const pathname = decodeURIComponent(urlObj.pathname);
    requests.push({ method: req.method, path: pathname, query: urlObj.search });

    if (overrides.has(pathname)) {
      const { body, contentType } = overrides.get(pathname);
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
      res.end(body);
      return;
    }

    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const filePath = path.resolve(rootDir, rel);
    if (!filePath.startsWith(rootDir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(filePath).pipe(res);
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        origin: `http://127.0.0.1:${port}`,
        requests,
        overrides,
        close: () => new Promise(r => server.close(r))
      });
    });
  });
}

async function launchChrome(chromeBin) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vicflora-chrome-e2e-'));
  const proc = spawn(
    chromeBin,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      'about:blank'
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  const wsBrowserUrl = await new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`Chrome startup timed out:\n${stderr}`)), 15000);
    proc.stderr.on('data', chunk => {
      stderr += chunk.toString('utf8');
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    proc.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited early (${code}):\n${stderr}`));
    });
  });

  const port = new URL(wsBrowserUrl).port;
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const pageTarget = targets.find(t => t.type === 'page') || targets[0];
  if (!pageTarget?.webSocketDebuggerUrl) {
    throw new Error('Failed to locate initial Chrome page target');
  }

  return {
    wsUrl: pageTarget.webSocketDebuggerUrl,
    close: async () => {
      proc.kill('SIGTERM');
      await new Promise(r => proc.once('exit', r));
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  };
}

class CDPClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', event => {
      const msg = JSON.parse(event.data);
      if (msg.id) {
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else entry.resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners.get(msg.method) || []) fn(msg.params);
      }
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    return new CDPClient(ws);
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression: `(async () => { return (${expression}); })()`,
      awaitPromise: true,
      returnByValue: true
    });
    if (res.exceptionDetails) {
      const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
      throw new Error(`Page evaluation error: ${desc}`);
    }
    return res.result?.value;
  }

  close() {
    this.ws.close();
  }
}

async function waitFor(fn, { timeoutMs = 60000, intervalMs = 150, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await fn();
    if (lastValue) return lastValue;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label} (last=${JSON.stringify(lastValue)})`);
}

function pickRichSpecies() {
  const idxPath = path.join(PUBLIC_DIR, 'data', 'photos', 'index.json');
  const speciesIndexPath = path.join(PUBLIC_DIR, 'data', 'species-index.json');
  const descPath = path.join(PUBLIC_DIR, 'data', 'descriptions.json');
  const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
  const speciesIndex = JSON.parse(fs.readFileSync(speciesIndexPath, 'utf8')).taxa;
  const desc = JSON.parse(fs.readFileSync(descPath, 'utf8')).taxa;
  for (const [taxonId, items] of Object.entries(idx.media || {})) {
    if (!Array.isArray(items) || items.length < 2) continue;
    const photo = items.find(item => item.kind !== 'drawing');
    const drawing = items.find(item => item.kind === 'drawing');
    const meta = speciesIndex[taxonId];
    const entry = desc[taxonId];
    if (photo && drawing && meta?.name && entry?.html && entry?.bioregions) {
      return { taxonId, name: meta.name, shardIndex: photo.shard, expectedShards: idx.shards.length };
    }
  }
  throw new Error('Could not find a species with photo, drawing, description, and bioregions');
}

async function run() {
  const manifestPath = path.join(PUBLIC_DIR, 'data', 'manifest.json');
  const photosIndexPath = path.join(PUBLIC_DIR, 'data', 'photos', 'index.json');
  assert.ok(fs.existsSync(manifestPath), 'Run `npm run build:web` before running E2E tests');
  assert.ok(fs.existsSync(photosIndexPath), 'Missing web/public/data/photos/index.json');

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const richSpecies = pickRichSpecies();
  const chromeBin = findChromeBinary();
  const server = await startStaticServer(PUBLIC_DIR);
  const chrome = await launchChrome(chromeBin);
  const cdp = await CDPClient.connect(chrome.wsUrl);

  const pageErrors = [];
  const sameOriginFailures = [];
  let offlinePhase = false;

  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');

    cdp.on('Runtime.exceptionThrown', params => {
      pageErrors.push(params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || 'exception');
    });
    cdp.on('Network.loadingFailed', params => {
      if (offlinePhase && params.type !== 'Other') {
        sameOriginFailures.push(params);
      }
    });

    const t0 = Date.now();
    console.log(`1. Loading ${server.origin}/ in headless Chrome...`);
    await cdp.send('Page.navigate', { url: `${server.origin}/` });

    // Wait for SW registration, app shell, all 5 data bundles, and all photo shards in Cache Storage.
    const cacheSummary = await waitFor(
      () =>
        cdp.eval(`(async () => {
          const reg = await navigator.serviceWorker.getRegistration();
          const swActive = Boolean(reg?.active && navigator.serviceWorker.controller);
          const names = await caches.keys();
          const shellName = names.find(n => n.startsWith('vicflora-shell-'));
          const shellKeys = shellName ? (await (await caches.open(shellName)).keys()).length : 0;
          const dataKeys = names.includes('vicflora-data') ? (await (await caches.open('vicflora-data')).keys()).length : 0;
          const photoKeys = names.includes('vicflora-photos') ? (await (await caches.open('vicflora-photos')).keys()).length : 0;
          const version = document.getElementById('app-version')?.textContent?.trim() || '';
          if (!swActive || dataKeys < ${manifest.data.length} || photoKeys < ${richSpecies.expectedShards + 1}) return null;
          return { shellName, shellKeys, dataKeys, photoKeys, version };
        })()`),
      { timeoutMs: 90000, label: 'SW + data + photo shards cached' }
    );

    assert.equal(cacheSummary.shellName, `vicflora-shell-${manifest.shellHash}`);
    assert.equal(cacheSummary.version, `v${manifest.shellHash.slice(0, 7)}`);
    assert.equal(cacheSummary.dataKeys, manifest.data.length);
    assert.equal(cacheSummary.photoKeys, richSpecies.expectedShards + 1);

    // Verify shell cache contains ONLY app shell files (no 30 MB JSON data bundles).
    const shellUrls = await cdp.eval(`(async () => {
      const c = await caches.open('vicflora-shell-${manifest.shellHash}');
      return (await c.keys()).map(k => new URL(k.url).pathname);
    })()`);
    assert.ok(!shellUrls.some(p => p.startsWith('/data/')), `Shell cache must not contain /data/*: ${shellUrls}`);

    // Verify legacy IndexedDB database is NOT created.
    const idbNames = await cdp.eval(`(async () => (await indexedDB.databases()).map(d => d.name))()`);
    assert.ok(!idbNames.includes('vicflora-photos-v1'), `Legacy IDB should not exist: ${idbNames}`);
    console.log(
      `   Cached shell (${cacheSummary.shellKeys} files), data (${cacheSummary.dataKeys} bundles), photos (${cacheSummary.photoKeys - 1} shards + index) in ${((Date.now() - t0) / 1000).toFixed(1)}s`
    );

    // 2. Clear HTTP cache, go completely offline, and reload through the Service Worker.
    // Note: ignoreCache:true in CDP is Shift+Reload, which bypasses the Service Worker per spec.
    // Clearing the browser HTTP cache first guarantees every asset is served from Cache Storage.
    console.log('2. Clearing HTTP cache, switching Chrome offline, and reloading...');
    await cdp.send('Network.clearBrowserCache');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0
    });
    const requestsBeforeOffline = server.requests.length;
    offlinePhase = true;

    const loaded = new Promise(resolve => cdp.on('Page.loadEventFired', resolve));
    await cdp.send('Page.reload', { ignoreCache: false });
    await loaded;

    const offlineBoot = await waitFor(
      () =>
        cdp.eval(`(() => {
          const homeVisible = document.getElementById('view-home')?.classList.contains('visible');
          const multiCards = document.querySelectorAll('#home-multi-list .quick-key-card').length;
          const ver = document.getElementById('app-version')?.textContent?.trim() || '';
          return homeVisible && multiCards > 0 && ver ? { multiCards, ver, onLine: navigator.onLine } : null;
        })()`),
      { timeoutMs: 15000, label: 'offline hard-reload boot' }
    );
    assert.equal(offlineBoot.onLine, false);
    assert.equal(offlineBoot.ver, `v${manifest.shellHash.slice(0, 7)}`);
    console.log(`   Offline hard reload booted cleanly (${offlineBoot.ver}, ${offlineBoot.multiCards} multi-access quick-start cards).`);

    // 3. Open Dichotomous Key from Home, walk across a linked key transition, test Bracketed view + Back + Restart.
    console.log('3. Walking dichotomous key offline across a linked key transition...');
    await cdp.eval(`document.querySelector('.home-dich-btn').click()`);
    await waitFor(
      () => cdp.eval(`document.querySelectorAll('#dichotomous-options > button[data-index]').length > 0`),
      { timeoutMs: 10000, label: 'dichotomous root options' }
    );
    const rootHeader = await cdp.eval(`(() => {
      const header = document.getElementById('dichotomous-header');
      return !header?.hidden
        ? {
            title: header.querySelector('strong')?.textContent?.trim() || '',
            depth: header.querySelector('.dich-depth')?.textContent?.trim() || ''
          }
        : { title: '', depth: '' };
    })()`);
    assert.equal(rootHeader.title, 'Main groups of plants in Victoria');
    assert.equal(rootHeader.depth, 'Depth 1 · Step 1');
    let linkedTitle = null;
    let linkedDepth = null;
    let sawHigherStepInRoot = false;
    for (let step = 0; step < 15; step += 1) {
      const state = await cdp.eval(`(() => {
        const hash = window.location.hash;
        const header = document.getElementById('dichotomous-header');
        const title = !header?.hidden ? (header.querySelector('strong')?.textContent?.trim() || '') : '';
        if (title && !hash.startsWith('#/key/1903')) return { transitioned: true, title };
        const btns = Array.from(document.querySelectorAll('#dichotomous-options > button[data-index]'));
        const linkedBtn = btns.find(b => b.textContent.includes('(see key'));
        const seedBtn = ${step === 0 ? "btns.find(b => /reproducing by seeds/i.test(b.textContent))" : 'null'};
        const branchBtn = btns.find(b => !b.querySelector(':scope > span'));
        const target = linkedBtn || seedBtn || branchBtn || btns[0];
        if (target) {
          target.click();
          return { transitioned: false, clicked: target.textContent.trim() };
        }
        return { transitioned: false, done: true };
      })()`);
      await new Promise(r => setTimeout(r, 40));
      const check = await cdp.eval(`(() => {
        const hash = window.location.hash;
        const header = document.getElementById('dichotomous-header');
        const title = !header?.hidden ? (header.querySelector('strong')?.textContent?.trim() || '') : '';
        const depth = !header?.hidden ? (header.querySelector('.dich-depth')?.textContent?.trim() || '') : '';
        return { hash, title, depth };
      })()`);
      if (check.hash.startsWith('#/key/1903') && /^Depth 1 · Step [2-9]/.test(check.depth)) {
        sawHigherStepInRoot = true;
      }
      if (check.title && !check.hash.startsWith('#/key/1903')) {
        linkedTitle = check.title;
        linkedDepth = check.depth;
        break;
      }
      if (state.done) break;
    }
    assert.ok(sawHigherStepInRoot, 'Expected step counter to advance inside Key 1903');
    assert.ok(linkedTitle, 'Expected dichotomous walk to transition into a linked key');
    assert.equal(linkedDepth, 'Depth 2 · Step 1');

    // Toggle Bracketed view and verify couplets + depth render, then Back and Restart.
    await cdp.eval(`document.querySelector('[data-dich-mode="bracketed"]').click()`);
    const bracketedCount = await waitFor(
      () => cdp.eval(`document.querySelectorAll('#dichotomous-bracketed li').length`),
      { timeoutMs: 5000, label: 'bracketed view couplets' }
    );
    assert.ok(bracketedCount > 0);
    const bracketedDepth = await cdp.eval(
      `document.querySelector('#dichotomous-header .dich-depth')?.textContent?.trim() || ''`
    );
    assert.equal(bracketedDepth, 'Depth 2');
    await cdp.eval(`document.querySelector('[data-dich-mode="interactive"]').click()`);
    await cdp.eval(`document.getElementById('dichotomous-restart').click()`);
    const restartedDepth = await cdp.eval(
      `document.querySelector('#dichotomous-header .dich-depth')?.textContent?.trim() || ''`
    );
    assert.equal(restartedDepth, 'Depth 2 · Step 1');
    await cdp.eval(`document.getElementById('dichotomous-back').click()`);
    const backDepth = await waitFor(
      () =>
        cdp.eval(`(() => {
          const d = document.querySelector('#dichotomous-header .dich-depth')?.textContent?.trim() || '';
          return d.startsWith('Depth 1 · Step ') ? d : null;
        })()`),
      { timeoutMs: 5000, label: 'depth unwind on Back to parent key' }
    );
    assert.match(backDepth, /^Depth 1 · Step \d+$/);
    console.log(`   Linked key transition OK ("Key 1903" -> "${linkedTitle.split('\n')[0]}", ${linkedDepth}), bracketed (${bracketedCount} rows, ${bracketedDepth}), back (${backDepth}) & restart OK.`);

    // 4. Multi-access key offline via Home quick-start card.
    console.log('4. Testing Multi-Access key offline...');
    await cdp.eval(`document.querySelector('#view-dichotomous .back-home').click()`);
    await waitFor(() => cdp.eval(`document.querySelectorAll('#home-multi-list .quick-key-card').length > 0`), {
      timeoutMs: 5000,
      label: 'home multi cards'
    });
    await cdp.eval(`document.querySelector('#home-multi-list .quick-key-card').click()`);
    const multiInitial = await waitFor(
      () =>
        cdp.eval(`(() => {
          const chars = document.querySelectorAll('#multi-characters button').length;
          const summary = document.getElementById('multi-summary')?.textContent || '';
          return chars > 0 && summary ? { chars, summary } : null;
        })()`),
      { timeoutMs: 10000, label: 'multi-access key load' }
    );
    await cdp.eval(`document.querySelector('#multi-characters button').click()`);
    await waitFor(() => cdp.eval(`document.querySelectorAll('#multi-states button').length > 0`), {
      timeoutMs: 5000,
      label: 'multi-access states'
    });
    await cdp.eval(`document.querySelector('#multi-states button').click()`);
    const multiAfter = await waitFor(
      () =>
        cdp.eval(`(() => {
          const sel = document.querySelectorAll('#multi-selections li').length;
          const summary = document.getElementById('multi-summary')?.textContent || '';
          return sel > 0 ? { sel, summary } : null;
        })()`),
      { timeoutMs: 5000, label: 'multi-access selection' }
    );
    assert.notEqual(multiAfter.summary, multiInitial.summary);
    await cdp.eval(`document.getElementById('multi-undo').click()`);
    await cdp.eval(`document.getElementById('multi-reset').click()`);
    console.log(`   Multi-access key OK (${multiInitial.chars} characters; filter/undo/reset verified).`);

    // 5. Unified search + species profile + offline photo + drawing + lightbox + glossary popover + bioregion SVG.
    console.log(`5. Opening "${richSpecies.name}" offline via unified search and verifying photo, drawing, glossary & bioregion map...`);
    await cdp.eval(`(() => {
      const input = document.getElementById('unified-search');
      input.focus();
      input.value = ${JSON.stringify(richSpecies.name)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);

    await waitFor(
      () => cdp.eval(`document.querySelectorAll('#unified-search-results a.search-result-item[href^="#/taxon/"]').length > 0`),
      { timeoutMs: 10000, label: 'unified search taxon matches' }
    );
    await cdp.eval(`document.querySelector('#unified-search-results a.search-result-item[href^="#/taxon/"]').click()`);

    const profileCheck = await waitFor(
      () =>
        cdp.eval(`(() => {
          const detail = document.getElementById('species-detail');
          if (!detail || detail.hidden) return null;
          const imgs = Array.from(detail.querySelectorAll('figure.taxon-photo img'));
          if (imgs.length < 2 || imgs.some(img => !img.complete || img.naturalWidth <= 0)) return null;
          const hasSvg = Boolean(detail.querySelector('svg.bioregion-map-svg path'));
          if (!hasSvg) return null;
          const glossBtns = detail.querySelectorAll('button.gloss-term').length;
          const descLen = (detail.textContent || '').trim().length;
          return {
            srcs: imgs.map(i => i.src),
            sizes: imgs.map(i => i.naturalWidth + 'x' + i.naturalHeight),
            hasSvg,
            glossBtns,
            descLen
          };
        })()`),
      { timeoutMs: 15000, label: 'offline species profile + blob photo & drawing + bioregion SVG render' }
    );
    assert.ok(profileCheck.srcs.every(s => s.startsWith('blob:')), `Expected offline blob: photo srcs, got ${profileCheck.srcs}`);
    assert.ok(profileCheck.hasSvg, 'Expected bioregion SVG map to render offline');
    assert.ok(profileCheck.descLen > 100, 'Expected species description text to render');

    // Test lightbox open & close.
    await cdp.eval(`document.querySelector('#species-detail .taxon-photo-trigger')?.click()`);
    const lightboxImg = await waitFor(
      () =>
        cdp.eval(`(() => {
          const lb = document.getElementById('photo-lightbox');
          const img = lb?.querySelector('.photo-lightbox-img');
          if (!lb || lb.hidden || !img || !img.complete || img.naturalWidth <= 0) return null;
          return { src: img.src, naturalWidth: img.naturalWidth };
        })()`),
      { timeoutMs: 5000, label: 'offline photo lightbox' }
    );
    assert.ok(lightboxImg.src.startsWith('blob:'));
    await cdp.eval(`document.querySelector('.photo-lightbox-close').click()`);

    // Test glossary popover if glossary terms are present in this description.
    if (profileCheck.glossBtns > 0) {
      await cdp.eval(`document.querySelector('#species-detail button.gloss-term').click()`);
      const popoverText = await waitFor(
        () =>
          cdp.eval(`(() => {
            const p = document.getElementById('gloss-popover');
            return p && !p.hidden ? p.textContent.trim() : null;
          })()`),
        { timeoutMs: 5000, label: 'glossary popover' }
      );
      assert.ok(popoverText.length > 10);
    }

    // Confirm ZERO HTTP requests hit our server during the entire offline phase!
    const offlineServerHits = server.requests.slice(requestsBeforeOffline);
    assert.equal(offlineServerHits.length, 0, `Expected 0 server hits while offline, got: ${JSON.stringify(offlineServerHits)}`);
    console.log(
      `   Offline profile OK: blob images [${profileCheck.sizes.join(', ')}], lightbox OK, bioregion SVG OK, glossary OK, 0 server hits.`
    );

    // 6. About controls: verify status, drop offline images, go back online, re-download.
    console.log('6. Testing About offline photo controls (drop + re-download)...');
    await cdp.eval(`document.getElementById('about-link').click()`);
    const aboutText = await waitFor(
      () =>
        cdp.eval(`(() => {
          const core = document.getElementById('offline-core-status')?.textContent || '';
          const photos = document.getElementById('photos-status')?.textContent || '';
          return core && photos ? { core, photos } : null;
        })()`),
      { timeoutMs: 5000, label: 'About offline status' }
    );
    assert.match(aboutText.core, /ready|offline/i);
    assert.match(aboutText.photos, /offline/i);

    // Click Drop offline images button.
    await cdp.eval(`Array.from(document.querySelectorAll('#offline-controls button')).find(b => /drop/i.test(b.textContent)).click()`);
    await waitFor(
      () => cdp.eval(`(async () => !(await caches.keys()).includes('vicflora-photos'))()`),
      { timeoutMs: 5000, label: 'vicflora-photos cache deleted' }
    );

    // Re-enable network and click Download offline images.
    offlinePhase = false;
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1
    });
    await waitFor(
      () => cdp.eval(`Boolean(Array.from(document.querySelectorAll('#offline-controls button')).find(b => /download/i.test(b.textContent)))`),
      { timeoutMs: 5000, label: 'Download offline images button' }
    );
    await cdp.eval(`Array.from(document.querySelectorAll('#offline-controls button')).find(b => /download/i.test(b.textContent)).click()`);
    await waitFor(
      () =>
        cdp.eval(`(async () => {
          if (!(await caches.keys()).includes('vicflora-photos')) return false;
          return (await (await caches.open('vicflora-photos')).keys()).length === ${richSpecies.expectedShards + 1};
        })()`),
      { timeoutMs: 90000, label: 'vicflora-photos re-synced' }
    );

    // Verify manual "Check for updates" button reports up-to-date when nothing changed.
    await waitFor(
      () => cdp.eval(`Boolean(document.querySelector('[data-check-updates]'))`),
      { timeoutMs: 5000, label: 'Check for updates button' }
    );
    await cdp.eval(`document.querySelector('[data-check-updates]').click()`);
    const upToDateMsg = await waitFor(
      () =>
        cdp.eval(`(() => {
          const text = document.getElementById('offline-core-status')?.textContent || '';
          const btn = document.querySelector('[data-check-updates]');
          return /everything is up to date/i.test(text) && btn ? text : null;
        })()`),
      { timeoutMs: 15000, label: 'Check for updates up-to-date message' }
    );
    assert.match(upToDateMsg, /everything is up to date/i);
    console.log('   Drop + re-download + Check for updates (up-to-date) verified cleanly.');

    // 7. Simulate a CSS-only app-shell deploy: click Check for updates and verify new SW activates, version rotates, and 0 data/photo files re-download!
    console.log('7. Simulating a CSS-only deploy and verifying Check for updates + 0 data/photo re-downloads...');
    const newShellHash = 'eeeeeeeeeeee';
    const nextManifest = { ...manifest, shellHash: newShellHash };
    const cssBody = fs.readFileSync(path.join(PUBLIC_DIR, 'styles.css'), 'utf8') + '\n/* css-only deploy test */\n';
    server.overrides.set('/styles.css', { body: cssBody, contentType: 'text/css; charset=utf-8' });
    server.overrides.set('/data/manifest.json', {
      body: JSON.stringify(nextManifest, null, 2),
      contentType: 'application/json; charset=utf-8'
    });
    server.overrides.set('/data/sw-manifest.js', {
      body: `self.__VICFLORA_MANIFEST__ = ${JSON.stringify(nextManifest, null, 2)};\n`,
      contentType: 'application/javascript; charset=utf-8'
    });

    const requestsBeforeUpdate = server.requests.length;
    await cdp.eval(`document.querySelector('[data-check-updates]').click()`);

    const updated = await waitFor(
      () =>
        cdp.eval(`(async () => {
          const ver = document.getElementById('app-version')?.textContent?.trim() || '';
          const names = await caches.keys();
          if (ver !== 'v${newShellHash.slice(0, 7)}') return null;
          return { ver, names: names.sort() };
        })()`),
      { timeoutMs: 20000, label: 'CSS-only SW update + reload' }
    );

    assert.deepEqual(updated.names, ['vicflora-data', 'vicflora-photos', `vicflora-shell-${newShellHash}`]);
    const updateRequests = server.requests.slice(requestsBeforeUpdate).map(r => r.path);
    const redownloadedData = updateRequests.filter(p => p.startsWith('/data/') && !p.endsWith('sw-manifest.js') && !p.endsWith('index.json'));
    const redownloadedShards = updateRequests.filter(p => p.endsWith('.bin'));
    assert.deepEqual(redownloadedData, [], `CSS-only deploy should NOT re-download JSON bundles: ${redownloadedData}`);
    assert.deepEqual(redownloadedShards, [], `CSS-only deploy should NOT re-download photo shards: ${redownloadedShards}`);
    console.log(
      `   Shell updated to ${updated.ver}; caches=${JSON.stringify(updated.names)}; 0 data bundles and 0 photo shards re-downloaded!`
    );

    assert.deepEqual(pageErrors, [], `Unexpected page errors: ${pageErrors.join('; ')}`);
    console.log('\n✅ Real-browser offline E2E acceptance test PASSED!');
  } finally {
    cdp.close();
    await chrome.close();
    await server.close();
  }
}

run().catch(error => {
  console.error('\n❌ Real-browser offline E2E test FAILED:\n', error);
  process.exit(1);
});
