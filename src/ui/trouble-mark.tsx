// The accent dot on a "Send feedback" button while the app has noticed a problem (docs/product/feedback.md, "When the app
// notices trouble"). A mark only: it has no meaning alone, because the banner or sheet line always says what happened. The
// description is hidden text the button points to with `aria-describedby`, so the dot is announced as a problem.
export function troubleProps(id: string, description: string | null): { 'aria-describedby'?: string } {
  return description === null ? {} : { 'aria-describedby': id };
}

export function TroubleMark(props: { id: string; description: string | null }) {
  if (props.description === null) return null;
  return (
    <>
      <span className="fbk-dot" aria-hidden="true" />
      <span id={props.id} hidden>{props.description}</span>
    </>
  );
}
