import { Button } from './components';
import { cx } from './cx';

export interface ReportListRow { label: string; value: string }

// Labelled rows of a report as a definition list, and the exact JSON in a disclosure under them
// (design/system/components/ReportList). The caller makes the rows and the JSON from one object.
export function ReportList(props: { rows: ReportListRow[]; json?: string; jsonSummary?: string; jsonLabel?: string; copyLabel?: string; onCopy?: () => void; className?: string }) {
  return (
    <div className={cx('rb-report', props.className)}>
      <dl className="rb-report-list">
        {props.rows.map((r) => (
          <div className="rb-report-row" key={r.label}>
            <dt>{r.label}</dt>
            <dd>{r.value}</dd>
          </div>
        ))}
      </dl>
      {props.json != null ? (
        <details className="rb-report-json">
          <summary>{props.jsonSummary}</summary>
          <pre className="rb-report-pre" tabIndex={0} aria-label={props.jsonLabel}>{props.json}</pre>
          {props.onCopy ? <Button variant="secondary" size="sm" onClick={props.onCopy}>{props.copyLabel}</Button> : null}
        </details>
      ) : null}
    </div>
  );
}
