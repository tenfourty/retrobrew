import type { RefObject } from 'preact';
import { useEffect } from 'preact/hooks';

// Publishes an element's height as a CSS custom property on <html>, such as --mtg-bottom for the phone dock. The page
// pads itself and sets scroll-padding from these, so nothing hides under a sticky bar and a focused control is never
// covered (docs/product/mvp-screens.md, Accessibility).
export function useInset(ref: RefObject<HTMLElement | null>, property: string, present: boolean): void {
  useEffect(() => {
    const el = ref.current;
    const root = document.documentElement;
    if (!el) { root.style.setProperty(property, '0px'); return undefined; }
    const update = () => root.style.setProperty(property, `${Math.ceil(el.getBoundingClientRect().height)}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => { observer.disconnect(); root.style.setProperty(property, '0px'); };
  }, [present, property]);
}
