import type { ComponentChildren } from 'preact';
import type { ColumnState } from './components';
import { cx } from './cx';

export interface TabItem<T extends string> {
  id: T;
  label: string;
  count?: number;
  // A column state, so the selected tab's underline takes the column's colour.
  state?: ColumnState;
}

export const tabId = (base: string, id: string) => `${base}-tab-${id}`;
export const tabPanelId = (base: string, id: string) => `${base}-panel-${id}`;

// An accessible tab list with counts (design/system/components/Tabs). Arrow keys, Home and End move between tabs and
// select them; only the selected tab is in the Tab order. Each tab controls a TabPanel with the same base and id.
export function Tabs<T extends string>(props: { label: string; base: string; tabs: TabItem<T>[]; selected: T; onSelect: (id: T) => void }) {
  const move = (e: KeyboardEvent, index: number) => {
    const last = props.tabs.length - 1;
    const next = e.key === 'ArrowRight' ? (index === last ? 0 : index + 1)
      : e.key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
        : e.key === 'Home' ? 0 : e.key === 'End' ? last : -1;
    if (next === -1) return;
    e.preventDefault();
    props.onSelect(props.tabs[next].id);
    document.getElementById(tabId(props.base, props.tabs[next].id))?.focus();
  };
  return (
    <div className="rb-tabs" role="tablist" aria-label={props.label}>
      {props.tabs.map((tab, index) => (
        <button key={tab.id} type="button" role="tab" id={tabId(props.base, tab.id)} className={cx('rb-tab', tab.state && `rb-st-${tab.state}`)}
          aria-selected={tab.id === props.selected ? 'true' : 'false'} aria-controls={tabPanelId(props.base, tab.id)}
          tabIndex={tab.id === props.selected ? 0 : -1} onClick={() => props.onSelect(tab.id)} onKeyDown={(e) => move(e, index)}>
          {tab.label}{tab.count !== undefined ? ' ' : null}
          {tab.count !== undefined ? <span className="rb-tab-count">{tab.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

// Every panel stays in the page, hidden unless its tab is selected, so each tab's aria-controls names a real panel.
// A panel is in the Tab order itself: its first content may be text only (an empty column, the Discussing topic), and then
// nothing in it could be reached from the tab list.
export function TabPanel(props: { base: string; id: string; hidden: boolean; children: ComponentChildren }) {
  return (
    <div role="tabpanel" id={tabPanelId(props.base, props.id)} aria-labelledby={tabId(props.base, props.id)} hidden={props.hidden} tabIndex={0}>
      {props.children}
    </div>
  );
}
