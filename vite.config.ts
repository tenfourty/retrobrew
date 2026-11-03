/// <reference types="vitest/config" />
/// <reference types="node" />
import { defineConfig, loadEnv, type Connect, type Plugin } from 'vite';
import preact from '@preact/preset-vite';
import { buildRevision } from './src/build/revision.ts';

// /version.txt names the commit of the build, so anyone can check which build is live.
function versionFile(): Plugin {
  return {
    name: 'retrobrew:version-txt',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.txt', source: `${buildRevision()}\n` });
    },
  };
}

// Where the public pages link to the source and the licence.
const SOURCE_URL = 'https://github.com/tenfourty/retrobrew';
const LICENCE_URL = 'https://github.com/tenfourty/retrobrew/blob/main/LICENSE';

// The short commit the image was built from. The Dockerfile passes REVISION; local builds say "dev".
function shortRevision(): string {
  return (process.env.REVISION ?? 'dev').slice(0, 7);
}

// Fills the hand-written pages' build-time values.
function siteHtml(): Plugin {
  return {
    name: 'retrobrew:site-html',
    transformIndexHtml(html) {
      return html
        .replaceAll('%RB_REVISION%', shortRevision())
        .replaceAll('%RB_SOURCE_URL%', SOURCE_URL)
        .replaceAll('%RB_LICENCE_URL%', LICENCE_URL);
    },
  };
}

// nginx answers these paths with a 301 to the trailing-slash path. The dev and preview
// servers do the same, so the e2e tests see production's behaviour.
const SLASH_REDIRECTS: Record<string, string> = { '/app': '/app/', '/lean-coffee': '/lean-coffee/' };

function slashRedirects(): Plugin {
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const target = SLASH_REDIRECTS[((req as { url?: string }).url ?? '').split('?')[0]];
    if (!target) return next();
    res.statusCode = 301;
    res.setHeader('Location', target);
    res.end();
  };
  return {
    name: 'retrobrew:slash-redirects',
    configureServer(server) { server.middlewares.use(middleware); },
    configurePreviewServer(server) { server.middlewares.use(middleware); },
  };
}

export default defineConfig(({ mode }) => {
  // VITE_RELAYS points the app at test relays, so only the browser battery's builds (`--mode e2e`) may see it.
  // src/config.ts ignores it in other modes, and check:assets also catches it; this stops the build outright.
  if (mode !== 'e2e' && loadEnv(mode, process.cwd(), 'VITE_RELAYS').VITE_RELAYS) {
    throw new Error(`VITE_RELAYS is set, but only --mode e2e builds may use it (this is --mode ${mode}). Unset it and build again.`);
  }
  return {
    base: './',
    plugins: [siteHtml(), slashRedirects(), preact(), versionFile()],
    build: {
      // font-src 'self' blocks data: fonts, so fonts are always emitted as files, however small.
      assetsInlineLimit: (file, content) => (/\.(woff2?|ttf|otf)$/i.test(file) ? false : content.length < 4096),
      rollupOptions: {
        input: {
          landing: 'index.html',
          guide: 'lean-coffee/index.html',
          app: 'app/index.html',
        },
      },
    },
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
      // The CI machine can run these 2 to 3 times slower than a developer machine, and many session tests sign and
      // seal hundreds of messages. A hang is still named by settle() well before this; a test that needs more sets its own.
      testTimeout: 30_000,
    },
  };
});
