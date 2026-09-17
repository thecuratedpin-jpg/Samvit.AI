// tests/helpers/fake-store.js
// Fake Netlify Blobs store for testing - supports conditional writes (onlyIfNew, onlyIfMatch)

export function createFakeStore(initialData = {}) {
  const data = new Map(Object.entries(initialData));
  const metadata = new Map();

  return {
    async get(key, { type } = {}) {
      const value = data.get(key);
      if (value === undefined) return null;
      if (type === 'json') return JSON.parse(value);
      return value;
    },

    async getWithMetadata(key, { type } = {}) {
      const value = data.get(key);
      if (value === undefined) return null;
      const meta = metadata.get(key) || { etag: `etag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
      if (type === 'json') return { data: JSON.parse(value), etag: meta.etag };
      return { data: value, etag: meta.etag };
    },

    async setJSON(key, value, options = {}) {
      const existing = data.get(key);
      if (options.onlyIfNew && existing !== undefined) {
        return { modified: false };
      }
      if (options.onlyIfMatch) {
        const meta = metadata.get(key);
        if (!meta || meta.etag !== options.onlyIfMatch) {
          return {modified:false};
        }
      }
      const newEtag = `etag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      data.set(key, JSON.stringify(value));
      metadata.set(key, { etag: newEtag });
      return { modified: true, etag: newEtag };
    },

    list({paginate=false,prefix=''}={}) {
      const blobs=[...data.keys()].filter(key=>key.startsWith(prefix)).map(key=>({key}));
      return paginate?(async function*(){yield {blobs,directories:[]};})():Promise.resolve({blobs,directories:[]});
    },
    async delete(key) {
      data.delete(key);
      metadata.delete(key);
    },

    _data: data,
    _metadata: metadata,
  };
}

export function createFlakyStore(initialData = {}, { failOnNthWrite = 3 } = {}) {
  const baseStore = createFakeStore(initialData);
  let writeCount = 0;

  return {
    ...baseStore,
    async setJSON(key, value, options = {}) {
      writeCount++;
      if (writeCount >= failOnNthWrite) {
        writeCount = 0; // Reset for next test
        throw new Error('Simulated store failure');
      }
      return baseStore.setJSON(key, value, options);
    },
  };
}

export function createFailingStore(initialData = {}) {
  const baseStore = createFakeStore(initialData);
  return {
    ...baseStore,
    async get() { throw new Error('Store unavailable'); },
    async getWithMetadata() { throw new Error('Store unavailable'); },
    async setJSON() { throw new Error('Store unavailable'); },
  };
}