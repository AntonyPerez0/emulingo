// Guarded access to the app's localStorage keys ('emulingo:<key>').
// localStorage can be missing (Node, some embedded views) or throw (blocked
// storage, Safari private mode, quota), so every call is wrapped. save()
// reports failures instead of swallowing them.

const PREFIX = 'emulingo:';
let frozen = false;

function ls() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

export function load(key, fallback) {
  try {
    const raw = ls()?.getItem(PREFIX + key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch { return fallback; }
}

// Returns true when written, or the Error (QuotaExceededError…) otherwise.
export function save(key, value) {
  if (frozen) return true;
  const store = ls();
  if (!store) return new Error('Storage is unavailable');
  try {
    store.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch (e) {
    return e && typeof e === 'object' ? e : new Error(String(e)); // DOMExceptions can come from another realm
  }
}

export function remove(key) {
  try { ls()?.removeItem(PREFIX + key); } catch { /* nothing to remove */ }
}

// Raw keys (with any prefix, e.g. 'ejs-') currently in localStorage.
export function rawKeys(prefix = '') {
  const store = ls();
  const out = [];
  if (!store) return out;
  try {
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k != null && k.startsWith(prefix)) out.push(k);
    }
  } catch { /* storage blocked */ }
  return out;
}

export function rawRemove(fullKey) {
  try { ls()?.removeItem(fullKey); } catch { /* ignore */ }
}

// Erase-everything stops all localStorage writes until the page reloads, so a
// late debounced save or a pagehide flush cannot bring data back.
export function freezeLocalStorage() { frozen = true; }
export function isFrozen() { return frozen; }
