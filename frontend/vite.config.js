import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const require = createRequire(import.meta.url);
const bufferPolyfill = require.resolve("buffer/");
const __dirname = dirname(fileURLToPath(import.meta.url));

// Cut the SDK's IBE (Layer B) subtree: confidential-client.js imports ./ibe.js only for a
// non-blocking off-chain-recovery side effect (encryptRandomness). ibe.js pulls in
// vendor/ts-ibe → node `crypto` (randomBytes) + @stablelib, which break in the browser
// (Vite pre-bundles @stablelib with a broken `ChaCha20Poly1305` named export; node crypto
// has no browser randomBytes).
//
// We intercept the LOAD of ibe.js (keyed on the RESOLVED module id) and return a no-op stub,
// so the whole ts-ibe subtree never loads. Keying off the resolved id — rather than the
// importer path — is what makes this reliable: Vite rewrites the SDK's relative "./ibe.js"
// to an absolute "/node_modules/@fairblock/stabletrust/src/ibe.js?v=…" before a resolveId
// matcher can see it, but the load id still ends in `stabletrust/src/ibe.js`. Works for the
// published npm package and the old linked file: dep, in both dev (Vite) and build (Rollup).
function stubIbe() {
  return {
    name: "stub-ibe",
    enforce: "pre",
    load(id) {
      const clean = id.split("?")[0].replace(/\\/g, "/");
      if (/\/stabletrust(-sdk)?\/src\/ibe\.js$/.test(clean)) {
        return "export async function encryptRandomness() { return { queuedEncrypted: null }; }";
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [stubIbe(), react(), wasm(), topLevelAwait()],
  server: {
    port: 5176,
    fs: {
      // The Fairblock SDK is a linked `file:` dep OUTSIDE this app; allow serving its
      // wasm-bindgen `..._bg.wasm` (fetched via /@fs/…) from the repo root.
      allow: [resolve(__dirname, "../..")],
    },
  },
  resolve: {
    alias: { buffer: bufferPolyfill },
  },
  optimizeDeps: {
    exclude: ["@fairblock/stabletrust"],
  },
  define: {
    global: "globalThis",
    "process.env": {},
  },
});
