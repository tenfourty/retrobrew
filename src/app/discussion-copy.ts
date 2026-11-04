// The empty To discuss column (docs/product/mvp-screens.md, The discussion phase). Going back to topics is the
// facilitator's action, so a guest is pointed to the facilitator instead of told to do it.
export function toDiscussEmpty(facilitator: boolean): string {
  return facilitator
    ? 'Every topic has been discussed. Add another, or go back to topics to collect more.'
    : 'Every topic has been discussed. Add another, or ask the facilitator to go back to topics to collect more.';
}
