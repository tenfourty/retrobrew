/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Test builds only (`--mode e2e`): comma-separated relay URLs that replace PUBLIC_RELAYS. See src/config.ts.
  readonly VITE_RELAYS?: string;
}

// The short build ID (src/build/revision.ts): seven hex digits, "dev" for a local build, or "unknown". Filled in by vite.config.ts.
declare const __RB_REVISION__: string;

// Where the feedback feature may run (src/build/feedback-flag.ts): "https://retrobrew.app" in the production image,
// "self" in dev and `--mode e2e` (the stub), and "" in every other build, which compiles the feature out.
declare const __RB_FEEDBACK_ORIGIN__: string;
