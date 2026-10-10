/**
 * Wiki sidebar preferences (components/WikiSidebar.tsx), kept in localStorage:
 * whether the panel is collapsed to its icon rail, and which categories are
 * open. Pure apart from createLocalPref, which touches `window` only when its
 * methods run (never during server rendering).
 */

/** "1" collapsed, "0" expanded. Absent until the reader first toggles. */
export const SIDEBAR_COLLAPSED_KEY = 'kompl_wiki_sidebar_collapsed';

/** JSON array of open category names (the format since #176). */
export const SIDEBAR_OPEN_KEY = 'kompl_wiki_sidebar_open';

/**
 * With no stored choice, windows narrower than 1200px start collapsed: below
 * that the sidebar, the article and the contents panel squeeze the text well
 * under its ~70-character measure. Media queries see the real window width;
 * the `zoom: 0.9` on html doesn't change it.
 */
export const NARROW_QUERY = '(max-width: 1199.98px)';

/** "1"/"true" → collapsed, "0"/"false" → expanded, anything else → no choice yet. */
export function parseCollapsedPref(raw: string | null): boolean | null {
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return null;
}

/** The reader's choice wins; without one, narrow windows start collapsed. */
export function resolveCollapsed(raw: string | null, isNarrow: boolean): boolean {
  return parseCollapsedPref(raw) ?? isNarrow;
}

/** Stored open categories; nothing stored or anything unreadable → `fallback`. */
export function parseOpenCategories(raw: string | null, fallback: readonly string[]): Set<string> {
  if (raw === null) return new Set(fallback);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set(fallback);
    return new Set(parsed.filter((x): x is string => typeof x === 'string'));
  } catch {
    return new Set(fallback);
  }
}

export function serializeOpenCategories(open: Iterable<string>): string {
  return JSON.stringify([...open]);
}

type ShortcutKeys = Pick<
  KeyboardEvent,
  'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'repeat' | 'isComposing'
>;

/**
 * Ctrl+. toggles the sidebar, on every platform. Not ⌘+., which macOS uses
 * for Cancel / Stop, and not Ctrl+B, Firefox's bookmarks sidebar. Key repeat
 * and IME composition are ignored (some Chinese IMEs use Ctrl+. to switch
 * punctuation).
 */
export function isToggleShortcut(e: ShortcutKeys): boolean {
  return (
    e.key === '.' &&
    e.ctrlKey &&
    !e.metaKey &&
    !e.altKey &&
    !e.shiftKey &&
    !e.repeat &&
    !e.isComposing
  );
}

/**
 * Inline script rendered as the sidebar's first child during server rendering
 * and hydration. It runs while the HTML is parsed, before the first paint, and
 * sets `data-collapsed` on the sidebar so CSS shows the stored state at once.
 * Same rule as resolveCollapsed (a test runs one against the other). ES5, and
 * every browser API is guarded: if it fails, the page shows the expanded
 * server render and React applies the stored state after hydration.
 */
export const SIDEBAR_BOOT_SCRIPT =
  '(function(){var r=null,n=false;' +
  `try{r=localStorage.getItem(${JSON.stringify(SIDEBAR_COLLAPSED_KEY)})}catch(e){}` +
  `try{n=matchMedia(${JSON.stringify(NARROW_QUERY)}).matches}catch(e){}` +
  'var c=r==="1"||r==="true"?true:r==="0"||r==="false"?false:n;' +
  'var s=document.currentScript;' +
  'if(s&&s.parentElement)s.parentElement.setAttribute("data-collapsed",c?"true":"false")})()';

export interface LocalPref {
  /** Stored value, read once then cached so snapshots stay stable. */
  read(): string | null;
  /** Store and notify subscribers. */
  write(value: string): void;
  /** For useSyncExternalStore; also fires when another tab changes the key. */
  subscribe(listener: () => void): () => void;
}

/**
 * A string in localStorage, shaped for useSyncExternalStore. Storage errors
 * (private mode, blocked storage, quota) are swallowed: the value then lives
 * in memory for the rest of the visit.
 */
export function createLocalPref(key: string): LocalPref {
  let cached: string | null | undefined;
  const listeners = new Set<() => void>();
  return {
    read() {
      if (cached === undefined) {
        try {
          cached = window.localStorage.getItem(key);
        } catch {
          cached = null;
        }
      }
      return cached;
    },
    write(value) {
      cached = value;
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // Kept in memory only; the choice still applies until the tab closes.
      }
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      const onStorage = (e: StorageEvent) => {
        if (e.key !== key && e.key !== null) return;
        cached = undefined;
        listener();
      };
      window.addEventListener('storage', onStorage);
      return () => {
        listeners.delete(listener);
        window.removeEventListener('storage', onStorage);
      };
    },
  };
}
