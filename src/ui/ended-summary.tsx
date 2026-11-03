import type { ComponentChildren } from 'preact';

// The ended board, read-only, as one list in two parts (design/system/components/EndedSummary): "Discussed", numbered
// 1, 2, 3 in the order the topics were finished, then "Not discussed", left out when it would be empty.
export function EndedSummary(props: { discussed: ComponentChildren[]; notDiscussed: ComponentChildren[] }) {
  return (
    <section className="rb-summary" aria-label="Final board">
      <h2 className="rb-summary-title">Discussed</h2>
      {props.discussed.length ? (
        <ol className="rb-summary-list">{props.discussed.map((item, i) => <li key={i}>{item}</li>)}</ol>
      ) : <p className="rb-summary-none">None</p>}
      {props.notDiscussed.length ? (
        <>
          <h2 className="rb-summary-title">Not discussed</h2>
          <ul className="rb-summary-list">{props.notDiscussed.map((item, i) => <li key={i}>{item}</li>)}</ul>
        </>
      ) : null}
    </section>
  );
}
