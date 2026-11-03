// Puts text on the clipboard. False when the browser refuses (no permission, or no clipboard at all), so the screen
// can show the text in a field to copy by hand instead.
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
