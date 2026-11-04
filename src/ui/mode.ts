import { useEffect, useState } from 'preact/hooks';

export type Mode = 'business' | 'party';
const STORAGE_KEY = 'rb-mode';

function shade(): 'light' | 'dark' {
  const theme = document.documentElement.getAttribute('data-theme');
  if (theme) return theme.endsWith('dark') ? 'dark' : 'light';
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function getMode(): Mode {
  return (document.documentElement.getAttribute('data-theme') ?? '').startsWith('party') ? 'party' : 'business';
}

// Mode is a per-viewer preference; it never syncs over the share link.
export function setMode(mode: Mode): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', `${mode}-${shade()}`);
  const cls = mode === 'party' ? 'rb-party-burst' : 'rb-business-settle';
  root.classList.remove('rb-party-burst', 'rb-business-settle');
  void root.offsetWidth;
  root.classList.add(cls);
  setTimeout(() => root.classList.remove(cls), 700);
  try { localStorage.setItem(STORAGE_KEY, mode); } catch { /* storage may be blocked */ }
  window.dispatchEvent(new CustomEvent('rb-mode', { detail: mode }));
}

// The theme name for a mode and a shade, such as "party-dark".
export function themeFor(mode: Mode, dark: boolean): string {
  return `${mode}-${dark ? 'dark' : 'light'}`;
}

// Keeps the shade (light or dark) following the device while the page is open, as the landing page does, and leaves the
// chosen mode (business or party) alone. Returns what stops it.
export function followDevice(root: Pick<HTMLElement, 'getAttribute' | 'setAttribute'>, query: Pick<MediaQueryList, 'addEventListener' | 'removeEventListener'>): () => void {
  const change = (event: Pick<MediaQueryListEvent, 'matches'>) => {
    const party = (root.getAttribute('data-theme') ?? '').startsWith('party');
    root.setAttribute('data-theme', themeFor(party ? 'party' : 'business', event.matches));
  };
  query.addEventListener('change', change);
  return () => query.removeEventListener('change', change);
}

export function initMode(): void {
  let stored: string | null = null;
  try { stored = localStorage.getItem(STORAGE_KEY); } catch { /* storage may be blocked */ }
  const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  const mode: Mode = stored === 'party' ? 'party' : 'business';
  document.documentElement.setAttribute('data-theme', themeFor(mode, dark));
  // A device switching between light and dark (by the clock, or by hand) applies live, with no reload.
  const query = window.matchMedia?.('(prefers-color-scheme: dark)');
  if (query) followDevice(document.documentElement, query);
}

export function useMode(): Mode {
  const [mode, set] = useState<Mode>(getMode());
  useEffect(() => {
    const update = () => set(getMode());
    window.addEventListener('rb-mode', update);
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => { window.removeEventListener('rb-mode', update); observer.disconnect(); };
  }, []);
  return mode;
}
