import { readFile } from "node:fs/promises";
import type { Plugin } from "vite";

const LICENSES = ["instrument-serif", "inter-tight", "noto-serif-sc", "noto-sans-sc"] as const;

/** A container must distribute the original OFL text, not only the repository. */
export function firstPartyFontLicenses(): Plugin {
  return {
    name: "first-party-font-licenses",
    apply: "build",
    async generateBundle() {
      for (const family of LICENSES) {
        const file = `${family}-OFL.txt`;
        const source = await readFile(new URL(`../../packages/web-ui/src/styles/fonts/${file}`, import.meta.url));
        this.emitFile({ type: "asset", fileName: `font-licenses/${file}`, source });
      }
    },
  };
}
