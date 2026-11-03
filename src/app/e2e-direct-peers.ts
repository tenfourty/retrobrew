export interface DirectPeersHook {
  __rbDirectPeers?: () => string[];
}

// Browser battery builds only (`vite build --mode e2e`): lets a test read the host's direct peers as its Trystero room
// reports them, which says whether the room uses a connection, as the page's raw peer connections cannot. Call it only
// inside `if (import.meta.env.MODE === 'e2e')`, so other builds drop it. Returns the clean-up for stop().
export function exposeDirectPeers(read: () => string[], page: DirectPeersHook = globalThis as DirectPeersHook): () => void {
  page.__rbDirectPeers = read;
  return () => {
    if (page.__rbDirectPeers === read) delete page.__rbDirectPeers;
  };
}
