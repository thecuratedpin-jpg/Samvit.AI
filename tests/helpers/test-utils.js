// tests/helpers/test-utils.js
// Test utilities for mocking Netlify context and request objects

export function mockRequest(body, method = 'POST', headers = {}) {
  return {
    method,
    headers: new Headers(headers),
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

export function mockContext(env = {}, clientContext = {}) {
  return {
    env,
    clientContext,
    ip: '127.0.0.1',
  };
}

export function mockNetlifyEnv(envVars = {}) {
  return {
    get: (key) => envVars[key],
  };
}

export function createMockStore() {
  const data = new Map();
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
    async delete(key) {
      data.delete(key);
      metadata.delete(key);
    },
    _data: data,
    _metadata: metadata,
  };
}