The vote shown to everyone when the timer reaches zero, in a Sheet titled "Time's up. Keep going?".

- The topic ("#4 Hiring plan"), then three choices: "Keep going" (`extend`), "No preference" (`none`) and "Move on" (`end`).
- Before voting, a hint: "Retrobrew never shows or stores who chose what. The facilitator decides."
- After voting, the viewer's choice shows pressed with `primary` and every choice is disabled. The totals follow ("Keep going 2 · No preference 1 · Move on 1"), then the turnout ("3 of 5 present have voted").
- After a reload the page only knows that you voted, never what: it says "You've voted" with nothing pressed.
- The facilitator always sees the totals and "3 voted · 5 here", and below them the decision, passed as children: "More time" as a Segmented choice, the two decision buttons with the option the room leans towards first, a note on what Move on does, and a quiet "Start again".
- Border is `timer-up` when it stands alone; inside a Sheet it drops its own panel.
