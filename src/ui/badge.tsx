import type { ComponentChildren } from 'preact';
import { cx } from './cx';

// A small label beside a name, such as "Rehearsal" (design/system/components/Badge).
export function Badge(props: { children?: ComponentChildren; className?: string }) {
  return <span className={cx('rb-badge', props.className)}>{props.children}</span>;
}
