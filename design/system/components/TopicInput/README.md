The field for adding a topic, with its submit button.

- Enter submits and keeps focus in the field; so does tapping the button, so a phone keeps its keyboard. Line breaks can't be typed or pasted: they become spaces.
- A topic is 1 to 280 characters, counted as code points, so an emoji counts as one. From 240 characters a counter shows "{n} characters left" ("1 character left" at the end), tied to the field with `aria-describedby`, and the field stops at 280. When a paste or keystroke overflows, only the inserted text is cut and the caret stays where the insertion ended; text being composed with an input method is cut when the composition ends. The counter has no live region of its own: the page's single polite live region announces the thresholds.
- The placeholder is "Add a topic"; the button is "Add topic", or "Add another topic" once the discussion has started.
- Use `hint` for the name notice: "Everyone in the meeting sees this name next to the topics you add".
- Pass `value` and `onValueChange` to control it, so the page can tell whether it holds a draft; `onFocus` and `onBlur` let a phone layout hide the action bar while it has focus.
- Sits above the Ideas column on wide screens, and pinned to the bottom of the screen on phones.
