// Where a refusal shows: next to the control its command came from ('add', 'card:{n}' or 'top'). A card that is no
// longer on the board has nothing to sit beside, so its refusal shows at the top.
export function refusalPlace(place: string | undefined, topicIds: readonly number[]): string {
  const at = place ?? 'top';
  if (!at.startsWith('card:')) return at;
  return topicIds.some((id) => `card:${id}` === at) ? at : 'top';
}
