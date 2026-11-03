import { generateRoomKey, importRoomKey } from '../crypto/aead';
import { fingerprint, generateSigningKeys, signerFrom, type Signer } from '../crypto/sign';
import { createBoard } from '../engine/board';
import { HostSession, type HostOptions, type SavedBoard } from '../session/host';
import { ParticipantSession, type ParticipantOptions } from '../session/participant';
import { HybridTransport } from '../transport/hybrid';
import { MemoryNetwork } from '../transport/memory';
import type { RoomTransport } from '../transport/types';

export const BOARD = 'board-0001';

// A meeting over two in-memory networks, one per path, so a test can lose, delay or cut either.
export class TestRoom {
  readonly direct = new MemoryNetwork('direct');
  readonly relay = new MemoryNetwork('relayed');
  roomKey!: CryptoKey;
  hostSigner!: Signer;
  hostId!: string;
  saved: SavedBoard | null = null;

  static async create(): Promise<TestRoom> {
    const room = new TestRoom();
    room.roomKey = await importRoomKey(generateRoomKey());
    room.hostSigner = await signerFrom(await generateSigningKeys(true));
    room.hostId = await fingerprint(room.hostSigner.pub);
    return room;
  }

  // directPath: false gives the peer a direct network of its own, so its direct path never connects. 'later' joins
  // the direct network unconnected: room.direct.connect(id, 'host') brings the path up when the test says.
  transport(id: string, directPath: boolean | 'later' = true): RoomTransport {
    const direct = directPath === 'later' ? this.direct.join(id, { connect: false })
      : directPath ? this.direct.join(id) : new MemoryNetwork('direct').join(id);
    return new HybridTransport(direct, this.relay.join(id));
  }

  host(id = 'host', o: Partial<HostOptions> = {}): HostSession {
    return new HostSession({
      roomKey: this.roomKey, signer: this.hostSigner, hostId: this.hostId, epoch: 1,
      state: this.saved?.state ?? createBoard({ boardId: BOARD, boardName: 'Team', ownerId: this.hostId, ownerName: 'Olu' }),
      tabs: this.saved?.tabs,
      save: async (saved) => { this.saved = structuredClone(saved); },
      measure: () => 0, // the size cap has its own tests (src/protocol/size.test.ts)
      ...o,
      transport: o.transport ?? this.transport(id),
    });
  }

  async person(name: string, o: Partial<ParticipantOptions> & { directPath?: boolean | 'later'; signer?: Signer } = {}) {
    const signer = o.signer ?? await signerFrom(await generateSigningKeys(false));
    const rejects: string[] = [];
    const session = new ParticipantSession({
      transport: o.transport ?? this.transport(name, o.directPath ?? true), roomKey: this.roomKey, signer, hostPub: this.hostSigner.pub,
      boardId: BOARD, name, onReject: (m) => rejects.push(m), ...o,
    });
    return { name, signer, session, rejects, id: await fingerprint(signer.pub) };
  }
}
