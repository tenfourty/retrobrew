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

export function initMode(): void {
  let stored: string | null = null;
  try { stored = localStorage.getItem(STORAGE_KEY); } catch { /* storage may be blocked */ }
  const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  const mode: Mode = stored === 'party' ? 'party' : 'business';
  document.documentElement.setAttribute('data-theme', `${mode}-${dark ? 'dark' : 'light'}`);
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
