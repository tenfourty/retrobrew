// The sync protocol version (docs/product/sync-protocol.md). Hellos carry it as `pv`; a hello without one is protocol 1.
// Protocol 3 renamed the board and message fields and kept protocol 2's wire layout (the PLAINTEXT_ bytes below).
export const PROTOCOL_VERSION = 3;

// The board name in a version reply. Protocol 1 code shows it as the meeting's name, so it reads as an instruction.
export const VERSION_MESSAGE = 'This meeting was started with a different version of Retrobrew. Reload this page.';

// The first byte of a sealed plaintext says what follows.
export const PLAINTEXT_V1 = 0x7b; // '{': protocol 1, the envelope's JSON as it is
export const PLAINTEXT_V2 = 0x02; // protocol 2: the envelope's JSON, deflated
export const PLAINTEXT_BUNDLE = 0x03; // protocol 2: a relay bundle
export const PLAINTEXT_ITEM = 0x04; // one personal item inside a bundle
