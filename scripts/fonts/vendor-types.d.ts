/** Narrow build-tool surfaces used here; these packages do not ship declarations. */
declare module "fontkit" {
  export function create(bytes: Uint8Array): { characterSet: number[] };
}

declare module "subset-font" {
  export default function subsetFont(input: Uint8Array, text: string, options: {
    targetFormat: "woff2";
    preserveNameIds: number[];
    variationAxes?: Record<string, number | { min: number; max: number }>;
  }): Promise<Buffer>;
}
