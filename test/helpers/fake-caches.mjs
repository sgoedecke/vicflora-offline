export class FakeCache {
  constructor(origin = 'https://vicflora.test/') {
    this.origin = origin;
    this.entries = new Map();
    this.putError = null;
  }

  _key(requestOrUrl) {
    const raw = typeof requestOrUrl === 'string' ? requestOrUrl : requestOrUrl.url;
    return new URL(raw, this.origin).href;
  }

  async put(requestOrUrl, response) {
    if (this.putError) throw this.putError;
    const key = this._key(requestOrUrl);
    const bytes = new Uint8Array(await response.clone().arrayBuffer());
    this.entries.set(key, {
      bytes,
      status: response.status,
      headers: new Headers(response.headers)
    });
  }

  async match(requestOrUrl, { ignoreSearch = false } = {}) {
    const target = this._key(requestOrUrl);
    let record = this.entries.get(target);
    if (!record && ignoreSearch) {
      const targetUrl = new URL(target);
      for (const [key, value] of this.entries.entries()) {
        const candidate = new URL(key);
        if (candidate.origin === targetUrl.origin && candidate.pathname === targetUrl.pathname) {
          record = value;
          break;
        }
      }
    }
    if (!record) return undefined;
    return new Response(record.bytes.slice(), {
      status: record.status,
      headers: new Headers(record.headers)
    });
  }

  async delete(requestOrUrl) {
    return this.entries.delete(this._key(requestOrUrl));
  }

  async keys() {
    return Array.from(this.entries.keys(), url => ({ url }));
  }
}

export class FakeCacheStorage {
  constructor(origin = 'https://vicflora.test/') {
    this.origin = origin;
    this.stores = new Map();
  }

  async open(name) {
    if (!this.stores.has(name)) {
      this.stores.set(name, new FakeCache(this.origin));
    }
    return this.stores.get(name);
  }

  async keys() {
    return Array.from(this.stores.keys());
  }

  async delete(name) {
    return this.stores.delete(name);
  }
}
