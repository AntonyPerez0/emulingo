export function load(key, fallback) {
  try {
    const raw = localStorage.getItem('emulingo:' + key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch { return fallback; }
}

export function save(key, value) {
  try { localStorage.setItem('emulingo:' + key, JSON.stringify(value)); } catch {}
}

export function remove(key) {
  try { localStorage.removeItem('emulingo:' + key); } catch {}
}
