// Every string the feedback sheet shows (docs/product/feedback.md, "The sheet"). Copy rules apply: src/copy-rules.test.ts scans this folder.
import type { FeedbackKind, TroubleSource } from './schema';

export const COPY = {
  title: 'Send feedback',
  button: 'Send feedback',
  kindLabel: 'What is it?',
  kinds: { broke: 'Something broke', idea: 'An idea', other: 'Something else' } satisfies Record<FeedbackKind, string>,
  messageLabel: 'Your message',
  messageHint: "Tell us what happened and what you were doing. Please leave out names and anything private. We can't see your meeting.",
  cutNotice: 'That was longer than 2,000 characters, so it was cut. Check the end before you send.',
  linkRefused: 'That looks like a meeting link. Anyone with it can open your meeting, so please take it out.',
  reportSummary: "The report we'll send with it",
  jsonSummary: 'Show exactly what is sent',
  jsonLabel: 'The exact request, as it will be sent',
  copyJson: 'Copy',
  copied: 'Copied',
  messageStandIn: '(your message)',
  noReport: "We couldn't prepare a report, so only your message will go.",
  emailLabel: "Your email, only if you'd like a reply",
  emailHint: "This goes to the Retrobrew owner only, never into the report, and we use it just to reply to this message. It's deleted after 90 days, or sooner if you ask.",
  emailInvalid: "That doesn't look like an email address",
  consent: 'Sending shares your message and this report with Retrobrew. An automated reader, run with a model provider, sorts it first and a person may read it. It leaves out your meeting\'s topics, names and link. If you add an email, only the owner sees it. Your message is kept for 30 days at most.',
  consentLink: 'More in the FAQ',
  consentHref: '/#privacy-feedback',
  send: 'Send',
  sending: 'Sending…',
  sendingStatus: 'Sending your feedback…',
  cancel: 'Cancel',
  sent: 'Thanks. Your feedback is sent.',
  sentEmail: 'If we reply, it will come from the owner of Retrobrew to the address you gave.',
  done: 'Done',
  failed: "Couldn't send that. Your message is still here. Try again, or copy it and send it another way.",
  failedRate: 'Lots of feedback is arriving right now. Try again in a few minutes.',
  failedRejected: "That message couldn't be sent. Try shortening it.",
  copyMessage: 'Copy what you wrote',
  offline: "You're offline, so this can't be sent yet. It will work once you're back online.",
  troubleDescription: 'The app noticed a problem',
} as const;

/** Why the sheet was opened in trouble, one line per source. */
export const TROUBLE_LINES: Record<TroubleSource, string> = {
  startup: 'The app noticed that the meeting could not start.',
  save: 'The app noticed that a save failed.',
  connection: 'The app noticed that the connection was lost.',
  error: 'The app noticed that something went wrong on this page.',
};
