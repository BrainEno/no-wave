import type { FontFamily, FontSourceReceipt } from "../lib/font-assets.ts";

/** Immutable public inputs, not a moving Google Fonts CSS response. */
export type FontSource = {
  id: string;
  family: FontFamily;
  style: "normal" | "italic";
  variable: boolean;
  blob: string;
  sha256: string;
  licenseId: string;
  licenseBlob: string;
  licenseSha256: string;
  characterCount: number;
  coverageSha256: string;
};

export const FONT_SOURCES: readonly FontSource[] = [
  {
    characterCount: 333, coverageSha256: "e740725ae4a3c5c01023bdc6468ccc8744491e679347fd8b3d48a020de7acd33",
    id: "instrument-serif", family: "Instrument Serif", style: "normal", variable: false,
    blob: "36fac00ef9b7d523236df6536cb09c712bb2c7e4", sha256: "498efd461f6ddfcb7a111bf9a565709d2085d48201d501ead960d93e84ffbb88",
    licenseId: "instrument-serif", licenseBlob: "669ce7917bec662fcf7244d37f49c4277f6fbd73", licenseSha256: "129ed7618959716959f2941fdd5b49e0ad6e6c1d78726761786a00253d865521",
  },
  {
    characterCount: 333, coverageSha256: "e740725ae4a3c5c01023bdc6468ccc8744491e679347fd8b3d48a020de7acd33",
    id: "instrument-serif-italic", family: "Instrument Serif", style: "italic", variable: false,
    blob: "192c3eda9864241ad280e9bcc84e258c80a4a588", sha256: "08939b8bdf534afec24ae0ef5e03f948940cd9a8fe08e7fecbad040e62327385",
    licenseId: "instrument-serif", licenseBlob: "669ce7917bec662fcf7244d37f49c4277f6fbd73", licenseSha256: "129ed7618959716959f2941fdd5b49e0ad6e6c1d78726761786a00253d865521",
  },
  {
    characterCount: 2504, coverageSha256: "ce5a983944739d26f48bacb6188a99f79c5954efff6cad15f38142d44330bf8d",
    id: "inter-tight", family: "Inter Tight", style: "normal", variable: true,
    blob: "7d64212163dc15e7f3de5487672668dbde589365", sha256: "b81b73dcb64df3c230cabade7df6c5773bf863233f24c9ee51087519f1f88b6f",
    licenseId: "inter-tight", licenseBlob: "18d0da5dfcf4b1703293ed87f8e3efcf34aa643f", licenseSha256: "50240ab035cf1b6b3307940235481d515c4b6de3ab1fa843dbe59e7892cb9d58",
  },
  {
    characterCount: 30928, coverageSha256: "a85f721c08eae942f929c23585ca4f21c8b23c0c8c019fcc59bd0a1f82eaab4d",
    id: "noto-serif-sc", family: "Noto Serif SC", style: "normal", variable: true,
    blob: "eab063faf229160a52d3760f5555150e4eb9e5bf", sha256: "050080d9255a86808f2945bffac582b31ef32bc36411ce29563b4961670c66f9",
    licenseId: "noto-serif-sc", licenseBlob: "94d1bf7b52481343e2983fb7751e8b7abe1ea07b", licenseSha256: "5e0da210fb04058a8c0087985d2d456b931c2579811a49655721d3cf0c36b6d6",
  },
  {
    characterCount: 30890, coverageSha256: "9f3bd0dadf3bf8fa8b8af72d1e5dcbfe5a1b975022b336736f1096330505b4d5",
    id: "noto-sans-sc", family: "Noto Sans SC", style: "normal", variable: true,
    blob: "fb0637bafbcd804fe32152370a1225990745b4bc", sha256: "a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da",
    licenseId: "noto-sans-sc", licenseBlob: "1c9f43281b8f216c5461fe9ac729afbade7724e4", licenseSha256: "1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9",
  },
];

export const LATIN_COMMON_CODEPOINTS = [
  ...Array.from({ length: 224 }, (_, index) => index + 32),
  ...Array.from({ length: 112 }, (_, index) => index + 0x2000),
  ...[..."←→↑↓−±○●"].map((character) => character.codePointAt(0)!),
];

export function fontSourceReceipt(source: FontSource): FontSourceReceipt {
  return { id: source.id, blob: source.blob, sha256: source.sha256,
    license: `${source.licenseId}-OFL.txt`, licenseSha256: source.licenseSha256,
    family: source.family, style: source.style, weights: source.id === "noto-serif-sc" ? ["400", "500 700"] : [source.variable ? "400 700" : "400"],
    characterCount: source.characterCount, coverageSha256: source.coverageSha256 };
}
