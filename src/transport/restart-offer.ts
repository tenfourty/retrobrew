// How long a restarted offer waits for the connection to gather its candidates before it goes out.
export const RESTART_GATHER_MS = 2000;

// Trystero keeps ready offers in a pool and, when it hands out one older than a minute, refreshes it: it rolls the
// connection's offer back, restarts its ICE and makes a new offer. In Chrome the rolled-back connection makes an offer
// with no transport in it (no ICE credentials, no candidates), so the other page has nothing to connect to and the
// connection fails after 23 s. A connection built from this class does not roll its offer back, and makes
// the ICE restart straight from the offer it holds, which Chrome gives a new set of credentials and candidates. The
// candidates are found just after the offer is set, and Trystero drops those found before it attaches a handler to the
// pooled connection, so the restart offer is also not finished being set until its candidates are gathered (or
// RESTART_GATHER_MS has passed), and its SDP carries them, as a fresh offer's does.
export function withRestartableOffers(Base: typeof RTCPeerConnection, gatherMs = RESTART_GATHER_MS): typeof RTCPeerConnection {
  const restartOffers = new WeakSet<object>();
  class RestartableConnection extends Base {
    // The deprecated callback overload of createOffer is not offered here; Trystero uses the promise form.
    // @ts-expect-error the override narrows createOffer's overloads
    override async createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
      const offer = await super.createOffer(options);
      if (options?.iceRestart) restartOffers.add(offer);
      return offer;
    }

    override async setLocalDescription(description?: RTCLocalSessionDescriptionInit): Promise<void> {
      // Trystero rolls back a connection that has made an offer only to refresh a pooled offer, or in glare on a
      // non-initiator, which a data-only connection never reaches.
      if (description?.type === 'rollback' && this.signalingState === 'have-local-offer') return;
      if (!description || !restartOffers.has(description)) return super.setLocalDescription(description);
      const gathered = this.gathered(gatherMs);
      await super.setLocalDescription(description);
      await gathered;
    }

    // Resolves when the connection has found its candidates (it reports the end of them, or its gathering completes),
    // or after ms. It starts listening at once, so the candidates of a gathering that starts as the description is set
    // are not missed.
    private gathered(ms: number): Promise<void> {
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.removeEventListener('icecandidate', onCandidate);
          this.removeEventListener('icegatheringstatechange', onState);
          resolve();
        };
        const onCandidate = (event: Event) => { if (!(event as RTCPeerConnectionIceEvent).candidate) done(); };
        const onState = () => { if (this.iceGatheringState === 'complete') done(); };
        const timer = setTimeout(done, ms);
        this.addEventListener('icecandidate', onCandidate);
        this.addEventListener('icegatheringstatechange', onState);
      });
    }
  }
  return RestartableConnection as unknown as typeof RTCPeerConnection;
}
