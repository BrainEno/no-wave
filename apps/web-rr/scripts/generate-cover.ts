/**
 * No Wave 默认封面生成器（TypeScript 版，替代原 generate_cover.py）。
 *
 *   node scripts/generate-cover.ts --post-id abc123 --size 1200x1500 -o out.jpg
 *
 * 同一个 post-id 永远生成同一张图：调色板、框线与随机种子都由 SHA-256 决定，
 * 像素随机数使用与平台无关的确定性 PRNG。依赖：sharp（仅本脚本使用）。
 *
 * 与旧 Python 版的关系：`post-id -> 调色板 / 框线 / 种子` 的选择规则与旧版完全一致；
 * 像素结果不再与 numpy 逐字节相同（PCG64 不在 TypeScript 中复现），但视觉规则
 * 保持一致：色块、框线、位移、横向/纵向条纹遮罩、颗粒。
 */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { pathToFileURL } from "node:url";
import sharp from "sharp";

export type Palette = "ember" | "oxblood" | "bone" | "night";

type PaletteDefinition = {
  /** 第 0 色为底色；第 4 色（cream）用于画框线。 */
  colors: readonly string[];
  /** 各色作为色块出现的权重，与 colors 一一对应。 */
  weights: readonly number[];
};

export const PALETTES: Record<Palette, PaletteDefinition> = {
  ember: {
    colors: ["#D8541F", "#0F0D0C", "#8B1A10", "#E9A98F", "#F2EEE6", "#B13A12"],
    weights: [0.28, 0.22, 0.18, 0.12, 0.08, 0.12],
  },
  oxblood: {
    colors: ["#8B1A10", "#0F0D0C", "#D8541F", "#F2EEE6", "#E9A98F", "#5A0E08"],
    weights: [0.3, 0.25, 0.15, 0.08, 0.1, 0.12],
  },
  bone: {
    colors: ["#F2EEE6", "#0F0D0C", "#D8541F", "#E9A98F", "#8B1A10", "#CFC6B6"],
    weights: [0.3, 0.2, 0.2, 0.1, 0.08, 0.12],
  },
  night: {
    colors: ["#0F0D0C", "#D8541F", "#E9A98F", "#8B1A10", "#F2EEE6", "#2A1410"],
    weights: [0.35, 0.2, 0.12, 0.12, 0.06, 0.15],
  },
};

const PALETTE_NAMES = Object.keys(PALETTES) as Palette[];

export type CoverParameters = {
  palette: Palette;
  /** 32 位种子，由 post-id 的摘要低 32 位得到。 */
  seed: number;
  /** 是否绘制双层框线。 */
  frame: boolean;
};

export type CoverOptions = CoverParameters & {
  width: number;
  height: number;
  /** 形状数量（色块）。 */
  shapes?: number;
  /** 色块最大旋转角度（度）。 */
  angleDegrees?: number;
};

/**
 * 与旧 Python 版相同的选择规则：h = sha256(post-id) 作为大整数，
 * 调色板 = h % 4，种子 = h % 2^32，框线 = (h >> 8) & 1。
 */
export function coverParametersForPostId(postId: string): CoverParameters {
  const digest = createHash("sha256").update(postId).digest("hex");
  const h = BigInt(`0x${digest}`);
  return {
    palette: PALETTE_NAMES[Number(h % 4n)]!,
    seed: Number(h % 4294967296n),
    frame: ((h >> 8n) & 1n) === 1n,
  };
}

/** 确定性 PRNG（mulberry32）。返回 [0, 1) 的浮点数。 */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(random: () => number): number {
  const u = Math.max(random(), Number.MIN_VALUE);
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

function smoothstep(x: number, a: number, b: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * 低分辨率随机网格经双线性插值放大到 width×height，并归一化到 [0, 1]。
 * 与旧版 `fld()` 的平滑场等价用途：位移场与遮罩场。
 */
function smoothField(
  random: () => number,
  width: number,
  height: number,
  scale: number,
): Float32Array {
  const gh = Math.max(2, Math.floor(height / scale));
  const gw = Math.max(2, Math.floor(width / scale));
  const grid = new Float32Array(gh * gw);
  for (let i = 0; i < grid.length; i += 1) grid[i] = random();
  const out = new Float32Array(width * height);
  let min = Infinity;
  let max = -Infinity;
  for (let y = 0; y < height; y += 1) {
    const fy = (y / height) * (gh - 1);
    const y0 = Math.floor(fy);
    const y1 = Math.min(gh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < width; x += 1) {
      const fx = (x / width) * (gw - 1);
      const x0 = Math.floor(fx);
      const x1 = Math.min(gw - 1, x0 + 1);
      const tx = fx - x0;
      const top = grid[y0 * gw + x0]! * (1 - tx) + grid[y0 * gw + x1]! * tx;
      const bottom = grid[y1 * gw + x0]! * (1 - tx) + grid[y1 * gw + x1]! * tx;
      const value = top * (1 - ty) + bottom * ty;
      out[y * width + x] = value;
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  const range = max - min + 1e-6;
  for (let i = 0; i < out.length; i += 1) out[i] = (out[i]! - min) / range;
  return out;
}

/**
 * 沿一个轴做窗口为 k 的移动平均（边缘复制），作用于 RGB 交错的 Float32Array。
 * axis = "x" 为横向（沿宽度），"y" 为纵向（沿高度）。
 */
function boxBlur(
  source: Float32Array,
  width: number,
  height: number,
  k: number,
  axis: "x" | "y",
): Float32Array {
  const out = new Float32Array(source.length);
  const half = Math.floor(k / 2);
  const length = axis === "x" ? width : height;
  const lines = axis === "x" ? height : width;
  for (let line = 0; line < lines; line += 1) {
    for (let c = 0; c < 3; c += 1) {
      const at = (i: number): number => {
        const clamped = Math.min(length - 1, Math.max(0, i));
        const index =
          axis === "x"
            ? (line * width + clamped) * 3 + c
            : (clamped * width + line) * 3 + c;
        return source[index]!;
      };
      let sum = 0;
      for (let i = -half; i < k - half; i += 1) sum += at(i);
      for (let i = 0; i < length; i += 1) {
        const index =
          axis === "x"
            ? (line * width + i) * 3 + c
            : (i * width + line) * 3 + c;
        out[index] = sum / k;
        sum += at(i + k - half) - at(i - half);
      }
    }
  }
  return out;
}

function fillPolygonRotatedRect(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  cx: number,
  cy: number,
  rw: number,
  rh: number,
  angle: number,
  color: [number, number, number],
): void {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const reach = Math.hypot(rw, rh) / 2;
  const x0 = Math.max(0, Math.floor(cx - reach));
  const x1 = Math.min(width - 1, Math.ceil(cx + reach));
  const y0 = Math.max(0, Math.floor(cy - reach));
  const y1 = Math.min(height - 1, Math.ceil(cy + reach));
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      const lx = dx * cos + dy * sin;
      const ly = -dx * sin + dy * cos;
      if (Math.abs(lx) <= rw / 2 && Math.abs(ly) <= rh / 2) {
        const index = (y * width + x) * 3;
        pixels[index] = color[0];
        pixels[index + 1] = color[1];
        pixels[index + 2] = color[2];
      }
    }
  }
}

function stampSquare(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  size: number,
  color: [number, number, number],
): void {
  const half = Math.floor(size / 2);
  for (let yy = y - half; yy <= y - half + size - 1; yy += 1) {
    if (yy < 0 || yy >= height) continue;
    for (let xx = x - half; xx <= x - half + size - 1; xx += 1) {
      if (xx < 0 || xx >= width) continue;
      const index = (yy * width + xx) * 3;
      pixels[index] = color[0];
      pixels[index + 1] = color[1];
      pixels[index + 2] = color[2];
    }
  }
}

function drawFrame(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  color: [number, number, number],
): void {
  const margin = Math.floor(width * 0.09);
  const lineWidth = Math.max(3, Math.floor(width / 400));
  const drawRectangle = (left: number, top: number, right: number, bottom: number) => {
    const steps = Math.max(right - left, bottom - top);
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      const x = Math.round(left + (right - left) * t);
      const y = Math.round(top + (bottom - top) * t);
      stampSquare(pixels, width, height, x, top, lineWidth, color);
      stampSquare(pixels, width, height, x, bottom, lineWidth, color);
      stampSquare(pixels, width, height, left, y, lineWidth, color);
      stampSquare(pixels, width, height, right, y, lineWidth, color);
    }
  };
  drawRectangle(margin, margin, width - margin, height - margin);
  drawRectangle(margin * 2, margin * 2, width - margin * 2, height - margin * 2);
  // 四角连接线，与旧版 d.line() 的装饰一致。
  const corners: Array<[number, number, number, number]> = [
    [margin, margin, margin * 2, margin * 2],
    [width - margin, margin, width - margin * 2, margin * 2],
    [margin, height - margin, margin * 2, height - margin * 2],
    [width - margin, height - margin, width - margin * 2, height - margin * 2],
  ];
  for (const [x0, y0, x1, y1] of corners) {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      stampSquare(
        pixels,
        width,
        height,
        Math.round(x0 + (x1 - x0) * t),
        Math.round(y0 + (y1 - y0) * t),
        lineWidth,
        color,
      );
    }
  }
}

/** 渲染封面为 JPEG 缓冲区。同一组参数总是得到同一个字节序列。 */
export async function renderCover(options: CoverOptions): Promise<Buffer> {
  const { width, height, palette, seed, frame } = options;
  const shapes = options.shapes ?? 8;
  const angleDegrees = options.angleDegrees ?? 22;
  const definition = PALETTES[palette];
  const colors = definition.colors.map(hexToRgb);
  const random = createRandom(seed);

  const pickColor = (): [number, number, number] => {
    let roll = random();
    for (let i = 0; i < definition.weights.length; i += 1) {
      roll -= definition.weights[i]!;
      if (roll < 0) return colors[i]!;
    }
    return colors[colors.length - 1]!;
  };

  // 1. 底色 + 色块
  const pixels = new Uint8ClampedArray(width * height * 3);
  for (let i = 0; i < pixels.length; i += 3) {
    pixels[i] = colors[0]![0];
    pixels[i + 1] = colors[0]![1];
    pixels[i + 2] = colors[0]![2];
  }
  for (let s = 0; s < shapes; s += 1) {
    const color = pickColor();
    const cx = random() * width;
    const cy = random() * height;
    const rw = width * (0.25 + random() * 0.7);
    const rh = height * (0.12 + random() * 0.6);
    const angle = ((random() * 2 - 1) * angleDegrees * Math.PI) / 180;
    fillPolygonRotatedRect(pixels, width, height, cx, cy, rw, rh, angle, color);
  }
  if (frame) drawFrame(pixels, width, height, colors[4]!);

  // 2. 位移场（最近邻采样）
  const a = new Float32Array(pixels.length);
  for (let i = 0; i < pixels.length; i += 1) a[i] = pixels[i]! / 255;
  const fieldX = smoothField(random, width, height, 140);
  const fieldY = smoothField(random, width, height, 200);
  const shifted = new Float32Array(a.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = y * width + x;
      const dx = Math.trunc((fieldX[p]! - 0.5) * width * 0.05);
      const dy = Math.trunc((fieldY[p]! - 0.5) * height * 0.03);
      const sy = Math.min(height - 1, Math.max(0, y + dy));
      const sx = Math.min(width - 1, Math.max(0, x + dx));
      const from = (sy * width + sx) * 3;
      const to = p * 3;
      shifted[to] = a[from]!;
      shifted[to + 1] = a[from + 1]!;
      shifted[to + 2] = a[from + 2]!;
    }
  }

  // 3. 横向 / 纵向条纹遮罩：模糊后与原图按遮罩混合
  const maskH = smoothField(random, width, height, 260);
  const maskV = smoothField(random, width, height, 300);
  const blurredH = boxBlur(shifted, width, height, 241, "x");
  const afterH = new Float32Array(shifted.length);
  for (let p = 0; p < width * height; p += 1) {
    const m = smoothstep(maskH[p]!, 0.45, 0.62);
    for (let c = 0; c < 3; c += 1) {
      const i = p * 3 + c;
      afterH[i] = shifted[i]! * (1 - m) + blurredH[i]! * m;
    }
  }
  const blurredV = boxBlur(afterH, width, height, 161, "y");
  const afterV = new Float32Array(afterH.length);
  for (let p = 0; p < width * height; p += 1) {
    const m = smoothstep(maskV[p]!, 0.5, 0.68);
    for (let c = 0; c < 3; c += 1) {
      const i = p * 3 + c;
      afterV[i] = afterH[i]! * (1 - m) + blurredV[i]! * m;
    }
  }

  // 4. 条纹亮度（列方向随机 + 双线性放大）与颗粒
  const streakColumns = Math.max(6, Math.floor(width / 110));
  const streakGrid = new Float32Array(height * streakColumns);
  for (let i = 0; i < streakGrid.length; i += 1) streakGrid[i] = random();
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const fx = (x / width) * (streakColumns - 1);
      const x0 = Math.floor(fx);
      const x1 = Math.min(streakColumns - 1, x0 + 1);
      const tx = fx - x0;
      const st =
        streakGrid[y * streakColumns + x0]! * (1 - tx) +
        streakGrid[y * streakColumns + x1]! * tx;
      const gain = 1 + 0.16 * (st - 0.5) * 2;
      const grain = gaussian(random) * 0.03;
      const p = (y * width + x) * 3;
      for (let c = 0; c < 3; c += 1) {
        afterV[p + c] = afterV[p + c]! * gain + grain;
      }
    }
  }

  const output = Buffer.alloc(width * height * 3);
  for (let i = 0; i < output.length; i += 1) {
    output[i] = Math.round(Math.min(1, Math.max(0, afterV[i]!)) * 255);
  }
  return sharp(output, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 80, mozjpeg: true })
    .toBuffer();
}

const CLI_OPTIONS = {
  "post-id": { type: "string", default: "default" },
  size: { type: "string", default: "1200x1500" },
  palette: { type: "string" },
  out: { type: "string", short: "o", default: "cover.jpg" },
} satisfies NonNullable<ParseArgsConfig["options"]>;

function parseSize(value: string): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match) throw new Error(`--size must look like 1200x1500, got "${value}".`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 1 || height < 1 || width > 8000 || height > 8000)
    throw new Error("--size dimensions must be between 1 and 8000 pixels.");
  return { width, height };
}

async function main(argv: readonly string[]): Promise<void> {
  const { values } = parseArgs({ args: [...argv], options: CLI_OPTIONS });
  const size = parseSize(values.size);
  if (values.palette !== undefined && !PALETTE_NAMES.includes(values.palette as Palette))
    throw new Error(`--palette must be one of: ${PALETTE_NAMES.join(", ")}.`);
  const derived = coverParametersForPostId(values["post-id"]);
  const palette = (values.palette as Palette | undefined) ?? derived.palette;
  const bytes = await renderCover({
    ...size,
    palette,
    seed: derived.seed,
    frame: derived.frame,
  });
  await writeFile(values.out, bytes);
  process.stdout.write(`${values.out} ${palette}\n`);
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(
      `error   ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
