/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Test builds only (`--mode e2e`): comma-separated relay URLs that replace PUBLIC_RELAYS. See src/config.ts.
  readonly VITE_RELAYS?: string;
}
