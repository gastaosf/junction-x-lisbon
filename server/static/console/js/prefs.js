// Per-browser preferences, kept in localStorage. Nothing here reaches the server or the agent.
//
// Keys: theme ("dark"|"light"), stageTheme, sound (bool), notifications (bool),
// density ("board"|"tiles"|"focus"), sort, cueDraft:<run>:<pid>.

const PREFIX = "astrolabio:";

export const DEFAULTS = {
  theme: "dark",
  stageTheme: "dark",
  sound: true,
  notifications: false,
  density: "tiles",
  sort: "default",
};

// Private mode, a full disk or a test runner: fall back to memory so the page keeps working.
function openStorage() {
  try {
    const storage = globalThis.localStorage;
    const probe = PREFIX + "probe";
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return storage;
  } catch (_) {
    const memory = new Map();
    return {
      getItem: (key) => (memory.has(key) ? memory.get(key) : null),
      setItem: (key, value) => { memory.set(key, String(value)); },
      removeItem: (key) => { memory.delete(key); },
    };
  }
}

const storage = openStorage();
const listeners = new Map(); // key -> Set<fn>

function notify(key, value) {
  for (const fn of listeners.get(key) || []) {
    try {
      fn(value, key);
    } catch (err) {
      console.error("prefs listener failed", err);
    }
  }
}

function read(key) {
  const raw = storage.getItem(PREFIX + key);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return undefined;
  }
}

export const prefs = {
  /** The stored value, else `fallback`, else the built-in default for that key. */
  get(key, fallback) {
    const value = read(key);
    if (value !== undefined && value !== null) return value;
    return fallback !== undefined ? fallback : DEFAULTS[key];
  },

  /** Store a value; null or undefined removes the key (a sent cue clears its draft this way). */
  set(key, value) {
    try {
      if (value === null || value === undefined) storage.removeItem(PREFIX + key);
      else storage.setItem(PREFIX + key, JSON.stringify(value));
    } catch (_) {
      // Quota exceeded: the preference is lost, the page is not.
    }
    notify(key, this.get(key));
  },

  remove(key) {
    this.set(key, null);
  },

  /** Call `fn(value, key)` when the key changes, in this tab or another. Returns an unsubscribe. */
  onChange(key, fn) {
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key).add(fn);
    return () => listeners.get(key).delete(fn);
  },
};

// Another tab changed a preference (theme, sound): follow it.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (event) => {
    if (!event.key || !event.key.startsWith(PREFIX)) return;
    const key = event.key.slice(PREFIX.length);
    notify(key, prefs.get(key));
  });
}
