// api/lib/cache.js
const store = new Map(); // key -> { value, exp, tags:Set<string> }

function now() { return Date.now(); }

export function getCache(key) {
  const rec = store.get(key);
  if (!rec) return undefined;
  if (rec.exp && rec.exp < now()) { store.delete(key); return undefined; }
  return rec.value;
}

export function setCache(key, value, ttlMs = 30000, tags = []) {
  store.set(key, { value, exp: ttlMs ? now() + ttlMs : 0, tags: new Set(tags) });
  return value;
}

export function delCache(key) { store.delete(key); }

export function invalidateByTag(tag) {
  for (const [k, rec] of store.entries()) {
    if (rec.tags?.has(tag)) store.delete(k);
  }
}

// Helper to build stable keys
export function k(parts) { return parts.filter(Boolean).join("|").toLowerCase(); }