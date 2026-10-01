import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { readFileSync } from "node:fs";

function icphPwa() {
  return {
    name: "icph-pwa",
    apply: "build",
    generateBundle(_options, bundle) {
      const precacheUrls = ["/", "/manifest.webmanifest", "/icons/icph-192.png", "/icons/icph-512.png", ...Object.keys(bundle)
        .filter((fileName) => fileName !== "service-worker.js")
        .map((fileName) => `/${fileName}`)];
      const worker = readFileSync(new URL("./src/service-worker.js", import.meta.url), "utf8")
        .replace("__ICPH_PRECACHE_URLS__", JSON.stringify(precacheUrls));
      this.emitFile({ type: "asset", fileName: "service-worker.js", source: worker });
    }
  };
}

export default defineConfig({
  plugins: [react(), icphPwa()],
  build: {
    target: "esnext"
  },
  optimizeDeps: {
    esbuildOptions: {
      target: "esnext"
    }
  }
});
