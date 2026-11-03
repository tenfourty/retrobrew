import { useEffect, useState } from 'preact/hooks';

// "Wide" is 768 px and up; "phone" is below (docs/product/mvp-screens.md, Conventions). Some screens differ in what
// they hold, not just how they look, so they ask here rather than leaving it all to CSS.
export const WIDE_QUERY = '(min-width: 768px)';

export function useWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(WIDE_QUERY);
    const update = () => setWide(query.matches);
    query.addEventListener('change', update);
    update();
    return () => query.removeEventListener('change', update);
  }, []);
  return wide;
}
