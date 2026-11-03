# Lean Coffee rules

These are the MVP rules the host engine (`src/engine/`) enforces. The facilitator's browser is the only place they are checked: participants send commands, and the host applies or refuses each one. Every refusal message below is exact, and `src/engine/messages.ts` holds the same text under the same keys. Each rule gets a unit test before its code.

The screens that show these rules are in [mvp-screens.md](mvp-screens.md). How commands and views travel is in [sync-protocol.md](sync-protocol.md).

## People and roles

- **Joining.** Anyone with the share link joins by giving a name. The name is trimmed and cut to 60 characters; a name that is empty after trimming is refused. Joining from the same device again keeps the person's identity, votes and topics, and only updates the name.
- **Identity.** A person is their device key: their ID is the fingerprint of the key that signs their messages. Commands are attributed to the signing key, never to the connection they arrived on.
- **Roles.** The person who created the meeting is its `owner`. In the MVP nobody else can be made a facilitator, but the rules treat `owner` and `facilitator` alike and call both "facilitator". Everyone else is a `guest`. Someone with no attendee entry is treated as a guest: facilitator controls need an explicit role.
- **Only people who have joined** can use any command other than `join`.
- **Up to 60 attendees.** A join that would add a 61st person is refused. Someone already on the list can always rejoin.
- **Joining after the end** is allowed, so latecomers can see the final board.
- **A join that changes nothing** (same person, same name) is accepted but does not change the board's version (`seq`). Only the person who joined gets a reply.

## Phases and columns

A meeting is always in one of three phases. It starts in `topics`.

| Phase | Columns in use | What happens |
| --- | --- | --- |
| `topics` | Ideas, plus Discussed if the meeting has been back from a discussion | People add topics and vote |
| `discussion` | To discuss, Discussing, Discussed | The facilitator picks topics one at a time; people can still add topics and vote |
| `ended` | All, read-only | The final board. Only `join` and `reopenMeeting` are accepted |

```
topics ──startDiscussion──► discussion ──endMeeting──► ended
   ▲                           │   ▲                     │
   └───────backToTopics────────┘   └────reopenMeeting────┘
topics ──endMeeting──► ended
```

The column IDs are `ideas`, `toDiscuss`, `discussing` and `discussed`. These invariants hold after every command:
- in `topics`, no topic is in To discuss or Discussing;
- in `discussion`, no topic is in Ideas;
- at most one topic is in Discussing;
- a timer exists only for the topic in Discussing, and a time-up vote exists only for the current timer.

### Ordering and numbering

- Each topic has a number, its `topicId`, shown as "#4". Numbers are never reused.
- **Ideas** is ordered by `position`, lowest first, then `topicId`. A new topic in Ideas gets a `position` one lower than the lowest in Ideas, so the newest is first.
- **To discuss** is ordered by vote count, highest first, then `position`, lowest first, then `topicId`. "The top-voted topic" means the first topic in this order. A new topic in To discuss gets a `position` one higher than the highest in To discuss.
- **A topic added to an empty column** gets `position` 0.
- **Discussed** is shown in `discussedOrder`, the order topics were finished.

## Limits

| Limit | Value | Refusal |
| --- | --- | --- |
| Topic length | 1 to 280 characters after trimming. Characters are Unicode code points, so an emoji counts as one. Line breaks are replaced by spaces before counting | `emptyTopic`, `topicTooLong` |
| Topics on a board | 60, counting every column | `tooManyTopics` |
| Board size | The full-refresh relay event stays at or under 44 KB (see the sync protocol's Size section). Checked on `addTopic`, on an `editTopic` that makes a topic longer, and on a `join` that adds someone or lengthens a name | `boardFull`, `meetingFullSize` |
| Attendees | 60, the owner included | `meetingFull` |
| Name | 60 characters, longer names are cut | `emptyName` if empty |
| Meeting name | 80 characters, set at creation in the UI | Not a command |
| Vote allowance | 3, 5, 8 or 10 per person | `badVoteAllowance`, `fewerVotes` |
| Timebox | 1, 2, 3, 4, 5, 10, 15, 20 or 30 minutes | `badTimebox` |
| Extension | 1 to 5 minutes | `badExtension` |

Very long topics or names in some scripts, such as Chinese text or emoji, fill a board before it reaches 60 topics or 60 people; the size cap refuses the next topic or join and says so. A typical meeting (30 English topics, 15 people) uses about a quarter of the cap. Boards that break the limits, saved before them or in an imported file, are handled as described in [Boards over the limits](#boards-over-the-limits).

## How commands are checked

For every command the host checks, in this order, and stops at the first failure:
0. **The command is one this host knows and is well formed.** A `cmd` whose inner command is unknown, malformed or a `join` is refused with `badCommand`. Like every refusal it still counts as applied for acknowledgement (see the sync protocol), so it can never block the commands after it.
1. **The sender has joined** (except for `join`). Otherwise `notAttendee`.
2. **The sender is a facilitator**, for facilitator commands. Otherwise `facilitatorOnly`.
3. **The meeting hasn't ended**, for every command except `join` and `reopenMeeting`. Otherwise `ended`.
4. **The command's own preconditions**, in the order listed in its row below.

A refused command changes nothing on the board. An accepted command that changes the board increases `seq` by one and is saved before anyone is told (see the sync protocol).

## Commands

"Facilitator" in the Who column means `owner` or `facilitator`. Commands that act on the discussion name the topic, and where it matters the round, they mean, so a delayed retry can never land on a different topic or vote.

### Joining and topics

| Command | Who | Preconditions, in order | Effects |
| --- | --- | --- | --- |
| `join {name}` | Anyone | Name not empty (`emptyName`); a new person only if fewer than 60 attendees (`meetingFull`); a new person or a longer name keeps the board within the size cap (`meetingFullSize`) | Adds the person as a guest, or updates their name |
| `addTopic {text}` | Anyone who has joined | Phase `topics` or `discussion`; text not empty (`emptyTopic`); at most 280 characters (`topicTooLong`); fewer than 60 topics (`tooManyTopics`); within the size cap (`boardFull`) | In `topics`: a new Ideas topic, first in Ideas. In `discussion`: a new To discuss topic, with `position` after every topic in To discuss. The sender is its author |
| `editTopic {topicId, text}` | The topic's author | Topic exists (`noSuchTopic`); sender is its author (`notYourTopicToEdit`); topic in Ideas or To discuss (`cantEditNow`); at most 280 characters (`topicTooLong`); if the text gets longer, within the size cap (`boardFull`) | Replaces the text. Text that is empty after trimming deletes the topic, exactly as `deleteTopic` would |
| `deleteTopic {topicId}` | The author or a facilitator | Topic exists (`noSuchTopic`); sender is its author or a facilitator (`notYourTopic`); topic in Ideas or To discuss (`discussedStays`) | Removes the topic and its dots. Everyone who voted on it gets those votes back |

### Votes

| Command | Who | Preconditions, in order | Effects |
| --- | --- | --- | --- |
| `addVote {topicId}` | Anyone who has joined | Topic exists (`noSuchTopic`); topic in Ideas or To discuss (`voteNotOpen`); sender has a vote left (`noVotesLeft`) | Adds one of the sender's dots to the topic. A person may put several dots on one topic |
| `removeVote {topicId}` | Anyone who has joined | Topic exists (`noSuchTopic`); topic in Ideas or To discuss (`votesSpent`); sender has a dot on it (`notYourVote`) | Removes one of the sender's dots from the topic, giving the vote back |
| `raiseAllowance {votes}` | Facilitator | `votes` is 3, 5, 8 or 10 (`badVoteAllowance`); not lower than the current allowance (`fewerVotes`) | Sets the allowance for everyone. The same value is accepted and changes nothing |
| `clearVotes` | Facilitator | None | Removes every dot on Ideas and To discuss topics. Dots on Discussing and Discussed topics stay. The allowance is unchanged |
| `setShowVotes {value}` | Facilitator | None | Turns Show votes on or off. It starts on |

### Phases

| Command | Who | Preconditions, in order | Effects |
| --- | --- | --- | --- |
| `startDiscussion` | Facilitator | Phase `topics` (`alreadyDiscussion`); at least one topic in Ideas (`noTopicsYet`) | Phase becomes `discussion`. Every Ideas topic moves to To discuss, keeping its `position` |
| `backToTopics` | Facilitator | Phase `discussion` (`alreadyTopics`); nothing in Discussing (`finishFirst`) | Phase becomes `topics`. Every To discuss topic moves to Ideas, keeping its `position`. Discussed topics stay in Discussed |
| `endMeeting` | Facilitator | None beyond the general checks (the UI confirms first) | If a topic is in Discussing, it moves to Discussed and is appended to `discussedOrder`. The timer and any time-up vote are cleared. `endedAt` becomes the host's clock time and phase becomes `ended` |
| `reopenMeeting` | Facilitator | Phase `ended` (`notEnded`) | Phase becomes `discussion` and `endedAt` is cleared. Any Ideas topics (a meeting ended from the topics phase) move to To discuss, as `startDiscussion` would move them |

### Discussion

| Command | Who | Preconditions, in order | Effects |
| --- | --- | --- | --- |
| `discussTopic {topicId, minutes, realMinutes?}` | Facilitator | Phase `discussion` (`notDiscussion`); `minutes` is a timebox (`badTimebox`); topic exists (`noSuchTopic`); topic in To discuss (`notInToDiscuss`); nothing in Discussing (`oneAtATime`) | Moves the topic to Discussing and starts a timer with the next round (see Timers and rounds). It replaces the skeleton's `startTimer` |
| `stopTimer {topicId}` | Facilitator | Topic is the one in Discussing (`notBeingDiscussed`); a timer exists (`noTimer`) | Clears the timer and any time-up vote. The topic stays in Discussing, untimed |
| `restartTimer {topicId, minutes, realMinutes?}` | Facilitator | Topic is the one in Discussing (`notBeingDiscussed`); `minutes` is a timebox (`badTimebox`) | Starts a fresh timer with the next round, whether the topic was timed, untimed or out of time. Closes any time-up vote |
| `returnTopic {topicId}` | Facilitator | Topic is the one in Discussing (`notBeingDiscussed`) | Moves the topic back to To discuss and clears the timer and any vote. Its dots stay on it, so it can be picked again later |
| `voteToContinue {topicId, round, choice}` | Anyone who has joined, facilitators included | A time-up vote is open for that topic and round (`voteClosed`); `choice` is `extend`, `none` or `end` (`badChoice`); the sender hasn't voted in this round (`alreadyVoted`) | Adds the sender to `voters` and adds one to `totals[choice]`. A ballot can't be changed or withdrawn |
| `extendTopic {topicId, round, minutes}` | Facilitator | A time-up vote is open for that topic and round (`voteClosed`); `minutes` is 1 to 5 (`badExtension`) | Starts a fresh timer of `minutes` with the next round, using the same minute length as the timer it replaces. Closes the vote |
| `finishTopic {topicId}` | Facilitator | Topic is the one in Discussing (`notBeingDiscussed`) | Moves the topic to Discussed, appends it to `discussedOrder`, and clears the timer and any vote. Allowed at any time, not only after time up |
| `setTimerSound {sound}` | Facilitator | `sound` is a sound ID (`badSound`) | Sets the board's timer sound |

## Votes

- **Allowance.** Everyone has the same allowance, 3 to start with. A facilitator can raise it to 5, 8 or 10 with `raiseAllowance`, never lower it.
- **Votes left** is the allowance minus every dot the person has on any topic, in any column. So dots on topics that are being discussed or have been discussed still count as spent.
- **Where dots can move.** Dots can be added or removed only on topics in Ideas and To discuss. While a topic is in Discussing its dots are locked; once it is in Discussed they are spent for good. A topic returned to To discuss is open again, so its dots can be removed or added once more.
- **Reset all votes** clears only Ideas and To discuss topics, so it gives back only those votes. If people have spent their allowance on discussed topics, the facilitator allows more votes instead.
- **Deleting a topic** gives its dots back to the people who placed them.
- **Moving between phases** keeps every dot where it is.

## Discussion

### One topic at a time

Only one topic can be in Discussing. To pick another, the facilitator first finishes or returns the current one. Back to topics and starting another topic are both refused while a topic is in Discussing.

### Timers and rounds

- **Timeboxes** are 1, 2, 3, 4, 5, 10, 15, 20 or 30 minutes; **extensions** are 1 to 5 minutes. The timer runs on the host's clock: `{topicId, startedAt, endsAt, round, minuteMs}`.
- **Minute length.** `minuteMs` is 60,000 ms, except on rehearsal boards (see below). `endsAt` is `startedAt + minutes × minuteMs`.
- **Rounds only ever go up.** `voteRound` is a board-wide counter, saved with the board. Every new timer (`discussTopic`, `restartTimer`, `extendTopic`) first adds one to `voteRound` and takes that value as its `round`. A ballot names its round, so a ballot meant for an old timer can never count towards a new vote, even for the same topic.
- **Untimed.** After `stopTimer` the topic stays in Discussing with no timer, until the facilitator finishes it, returns it or starts a timer again (`restartTimer`).

### Time up

- **Time up is a host tick, not a command.** The host runs `tick(now)` once a second, with the clock injected, and once straight after resuming. When `now >= timer.endsAt` and no vote is open for that timer's round, it opens the time-up vote: `continueVote = {topicId, round, voters: [], totals: {extend: 0, none: 0, end: 0}}`. This goes through the same path as a command: `seq` goes up, the board is saved and sent.
- **The timer stays** at 0:00 while the vote is open, until the facilitator decides.
- **Everyone may vote once**, the facilitator included: Keep going (`extend`), No preference (`none`) or Move on (`end`). Ballots can't be changed.
- **Retrobrew never shows or stores who chose what.** The host keeps only who has voted (`voters`, to allow one ballot each) and the three totals, so no person-to-choice mapping is on any screen, in the host's storage or in a backup file. The facilitator's own choice, kept on their device to highlight their button, stays out of the saved board and backups too. This is not secrecy: someone in the meeting who records relay traffic could work out who chose what (see the accepted gaps in [sync-protocol.md](sync-protocol.md)).
- **The facilitator decides.** The vote is advisory. The facilitator can:
  - keep going, with `extendTopic` for 1 to 5 minutes;
  - move on, with `finishTopic`;
  - keep talking untimed, with `stopTimer`;
  - start a fresh timebox with `restartTimer`, or return the topic with `returnTopic`.

  Each of these closes the vote. The screens put the option the room leans towards first (see [mvp-screens.md](mvp-screens.md)).

### Finishing

`finishTopic` is the only way into Discussed during a meeting, apart from `endMeeting`. Finished topics stay on the board for good: they can't be edited, deleted, voted on or moved back.

## Ending and reopening

- `endMeeting` is allowed in `topics` and `discussion`. A topic in Discussing is finished first, so it is counted as discussed.
- An ended meeting is read-only. Every command except `join` and `reopenMeeting` is refused with `ended`, including adding topics and voting.
- `reopenMeeting` returns the meeting to `discussion`, never to `topics`. Votes, `discussedOrder` and `voteRound` carry on from where they were.

## Rehearsal boards

- A board is a rehearsal board only if it was created from `/app/#start&rehearsal`. The `rehearsal` flag is set at creation and never changes. No button in the app leads there; only the link does.
- On a rehearsal board one timebox "minute" lasts **10 seconds** (`minuteMs = 10,000`), for timeboxes and extensions alike. A 5-minute timebox runs for 50 seconds.
- **Use real minutes.** `discussTopic` and `restartTimer` accept `realMinutes: true`. On a rehearsal board it makes that timer use 60,000 ms minutes, and an extension of that timer uses real minutes too. On other boards the flag changes nothing.
- Everything else about a rehearsal board follows the normal rules.

## What each person receives

The host builds each person's view with `redactFor(state, viewerId)`, which always returns a new object. These rules hold on both paths; [sync-protocol.md](sync-protocol.md) describes how the relay path splits a view into a shared part and a personal part.

### Topics and dots

- Every viewer gets each topic's **vote count** and **their own** dots on it. Nobody is ever sent anyone else's voter IDs, whatever Show votes says.
- **Show votes off, in the topics phase:** nobody gets counts for Ideas topics, the facilitator included, on screen. Every viewer sees only their own dots there. The one exception is the facilitator's own Copy as text, which is built on the facilitator's device and carries every real count (see [mvp-screens.md](mvp-screens.md), Copy as text); nothing is sent to anyone for it.
- **Once discussion starts,** counts are sent to everyone whatever Show votes says, so everyone sees the same To discuss order. The same applies when the meeting has ended.
- Counts on Discussed topics are always sent; they were already public when the topics were discussed.

### The time-up vote

- Everyone gets the open vote's topic and round, **whether they themselves have voted**, and the **turnout**: how many have voted (N) and how many are here (M). M is the number of attendees online, raised to N if fewer.
- The **totals** go to people who have voted, and to facilitators at all times.
- The `voters` list is never sent to anyone, facilitators included. That keeps the views from showing who voted what, though it is not a secrecy guarantee (see the accepted gaps).
- A person's own choice stays on their device, to highlight their button. The host never sends it back.

### People

- Everyone gets the attendee list (ID, name, role) and `online`: the attendees the host has heard from in the last 15 seconds. The host itself is always online.
- A change in who is online doesn't change `seq` or save the board. It goes out with the next send, and on its own at most every 5 seconds.

## Saved boards from before the MVP

When the host loads a saved board that lacks the MVP fields:
- `phase` is derived: any topic outside Ideas (in To discuss, Discussing or Discussed) means `discussion`, and any Ideas topics then move to To discuss; otherwise `topics`.
- `voteRound` starts at 0, `continueVote` at `null`, `timerSound` at `chime`, `rehearsal` at `false`, `endedAt` at `null`.
- `discussedOrder` lists the Discussed topics by `position`, then `topicId`.
- A timer with no `round` takes the next round, and `minuteMs` 60,000.

For every board, on load:
- a timer whose `endsAt` is more than an hour in the past is cleared, and its topic stays in Discussing, untimed;
- a timer that ran out within the last hour opens its time-up vote at the first tick after the host resumes.

## Boards over the limits

When the host loads a saved board, or imports a meeting file, it checks the limits:
- **Nothing is cut or dropped.** The board loads exactly as it was saved, whatever its size, topic count, attendee count or text lengths.
- **Growth is refused until it fits.** While the board breaks a limit, every command that would grow past that limit is refused with its usual message (`tooManyTopics`, `meetingFull`, `topicTooLong`, `boardFull` or `meetingFullSize`). Everything else, including deleting topics, works as normal.
- **The facilitator is told.** While the board is over a limit, the facilitator sees the banner "This meeting is bigger than Retrobrew's limits. It runs as normal, but new topics and people can't be added until some topics are deleted."

## Refusal messages

These are the exact strings for `src/engine/messages.ts`. They follow the design system's content rules: sentence case, no full stop on a single sentence, no exclamation marks, "topic" never "card".

| Key | Message |
| --- | --- |
| `notAttendee` | Join the meeting first |
| `emptyName` | Add your name first |
| `meetingFull` | This meeting is full. It can have up to 60 people |
| `facilitatorOnly` | Only a facilitator can do that |
| `ended` | This meeting has ended |
| `notEnded` | This meeting hasn't ended |
| `emptyTopic` | Write a topic first |
| `topicTooLong` | Topics can be up to 280 characters |
| `tooManyTopics` | This meeting has 60 topics, which is as many as it can hold |
| `boardFull` | This board is full. Delete some topics before adding more |
| `meetingFullSize` | This meeting is full |
| `noSuchTopic` | That topic no longer exists |
| `notYourTopic` | You can only delete topics you created |
| `notYourTopicToEdit` | You can only edit topics you created |
| `cantEditNow` | Topics can't be edited once they're being discussed |
| `discussedStays` | Topics that have been discussed stay on the board |
| `voteNotOpen` | You can only vote on topics that haven't been discussed |
| `votesSpent` | Votes on discussed topics stay spent |
| `noVotesLeft` | You have no votes left |
| `notYourVote` | You can only remove your own votes |
| `badVoteAllowance` | Choose 3, 5, 8 or 10 votes |
| `fewerVotes` | The vote allowance can only go up |
| `alreadyDiscussion` | The discussion has already started |
| `noTopicsYet` | Add a topic before starting the discussion |
| `alreadyTopics` | The meeting is already collecting topics |
| `notDiscussion` | Start the discussion first |
| `finishFirst` | Finish or return the topic being discussed first |
| `oneAtATime` | Another topic is already being discussed |
| `notInToDiscuss` | Only topics in To discuss can be picked |
| `notBeingDiscussed` | That topic isn't being discussed |
| `noTimer` | There's no timer to stop |
| `badTimebox` | Choose 1, 2, 3, 4, 5, 10, 15, 20 or 30 minutes |
| `badExtension` | Keep going for 1 to 5 minutes |
| `voteClosed` | That vote has closed |
| `alreadyVoted` | You've already voted |
| `badChoice` | Choose keep going, no preference or move on |
| `badSound` | Choose one of the timer sounds |
| `badCommand` | That change isn't possible here. Reload the page and try again |
| `staleTab` | This page has been away too long. Reload it to carry on |
| `tooManyTabs` | This meeting was opened in too many tabs. Reload this page |

The sound IDs are `chime`, `bell`, `woodblock` and `pips`.

## Open choices made

Where the design left a choice open, these are the readings taken.

1. **Check order.** Joined, then facilitator, then ended, then the command's own checks. So a guest who tries `reopenMeeting` sees `facilitatorOnly`, and anyone adding a topic after the end sees `ended`.
2. **The ended phase refuses everything** except `join` and `reopenMeeting`, including `setShowVotes` and `setTimerSound`.
3. **Characters are code points**, and line breaks become spaces, so topics are always one line.
4. **`startDiscussion` needs at least one Ideas topic.** The action bar only offers it then.
5. **Reopening an ended meeting from the topics phase** moves its Ideas topics to To discuss, because the design reopens into `discussion`.
6. **Real minutes are carried on the timer** as `minuteMs`, set by a `realMinutes` flag on `discussTopic` and `restartTimer`; extensions reuse it. The design's timer shape gains this one field.
7. **Show votes off hides counts on Ideas topics only.** Counts on Discussed topics (after Back to topics) stay visible, because they were public when those topics were discussed.
8. **`stopTimer` with no timer is refused** (`noTimer`), rather than accepted as a no-op.
9. **Giving the same allowance again** is accepted and changes nothing; only a lower one is refused.
10. **A meeting name is capped at 80 characters**, so the size cap holds.
11. **Sound IDs** are `chime` (the default), `bell`, `woodblock` and `pips`.
12. **Migrated `discussedOrder`** follows `position`, then `topicId`, because older boards didn't record the finishing order.
13. **Boards over the limits** load unchanged and refuse growth until they fit again.
14. **The `boardFull` message says "Delete some topics"** rather than "Finish or delete": finished topics stay on the board and still count towards its size, so only deleting makes room.
