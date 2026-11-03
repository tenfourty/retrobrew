import { describe, expect, it } from 'vitest';
import { generateRoomKey } from './crypto/aead';
import { toB64url } from './crypto/bytes';
import { generateSigningKeys, signerFrom } from './crypto/sign';
import { buildShareLink, isRehearsalLink, isStartLink, newBoardId, parseShareLink, roomIdFor } from './link';

async function sample() {
  const signer = await signerFrom(await generateSigningKeys(false));
  return { boardId: newBoardId(), roomKey: generateRoomKey(), hostPub: signer.pub };
}

describe('share link', () => {
  it('round-trips through the URL fragment only', async () => {
    const link = await sample();
    const url = new URL(buildShareLink('https://example.test/app/', link));
    expect(url.search).toBe('');
    const parsed = parseShareLink(url.hash);
    expect(parsed?.boardId).toBe(link.boardId);
    expect(parsed?.hostPub).toBe(link.hostPub);
    expect(toB64url(parsed!.roomKey)).toBe(toB64url(link.roomKey));
  });

  it('accepts the fragment with or without its leading #', async () => {
    const hash = new URL(buildShareLink('https://example.test/', await sample())).hash;
    expect(parseShareLink(hash.slice(1))).not.toBeNull();
  });

  it('returns null for incomplete or mangled links', async () => {
    const link = await sample();
    const k = toB64url(link.roomKey);
    expect(parseShareLink('')).toBeNull();
    expect(parseShareLink(`#b=${link.boardId}&h=${link.hostPub}`)).toBeNull();
    expect(parseShareLink(`#b=${link.boardId}&k=${k.slice(0, 20)}&h=${link.hostPub}`)).toBeNull();
    expect(parseShareLink(`#b=${link.boardId}&k=${k}&h=${link.hostPub.slice(0, 40)}`)).toBeNull();
    expect(parseShareLink(`#b=bad id!&k=${k}&h=${link.hostPub}`)).toBeNull();
    expect(parseShareLink(`#b=${link.boardId}&k=%%%&h=${link.hostPub}`)).toBeNull();
  });

  it('makes board IDs of 22 URL-safe characters', () => {
    expect(newBoardId()).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});

describe('roomIdFor', () => {
  it('is stable, separates purposes and never contains the key', async () => {
    const key = generateRoomKey();
    const webrtc = await roomIdFor(key, 'webrtc');
    expect(webrtc).toBe(await roomIdFor(key, 'webrtc'));
    expect(webrtc).not.toBe(await roomIdFor(key, 'relay'));
    expect(webrtc).toMatch(/^[0-9a-f]{32}$/);
    expect(webrtc).not.toContain(toB64url(key));
  });
});

describe('start link', () => {
  it('recognises #start and #start with options, with or without the #', () => {
    for (const hash of ['#start', 'start', '#start&rehearsal']) expect(isStartLink(hash)).toBe(true);
  });

  it('leaves share links, other fragments and look-alikes alone', () => {
    for (const hash of ['', '#', '#b=abc&k=def&h=ghi', '#faq', '#started', '#b=start']) expect(isStartLink(hash)).toBe(false);
  });
});

describe('isRehearsalLink', () => {
  it('is true only for a start link that names rehearsal', () => {
    expect(isRehearsalLink('#start&rehearsal')).toBe(true);
    expect(isRehearsalLink('start&rehearsal')).toBe(true);
    expect(isRehearsalLink('#start&x=1&rehearsal')).toBe(true);
    expect(isRehearsalLink('#start')).toBe(false);
    expect(isRehearsalLink('#start&rehearsals')).toBe(false);
    expect(isRehearsalLink('#rehearsal')).toBe(false);
    expect(isRehearsalLink('#b=abc&rehearsal')).toBe(false);
  });
});
