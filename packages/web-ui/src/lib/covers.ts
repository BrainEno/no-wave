/**
 * 默认封面：API 目前不返回封面图，所有作品使用抽象占位图。
 * 同一个 slug 永远得到同一张图（FNV-1a 哈希），不依赖运行环境。
 */
export type DefaultCover = { name: string; src: string; width: number; height: number };

export const defaultCovers: readonly DefaultCover[] = [
  { name: "ember", src: "/covers/cover-ember-16x10.jpg", width: 2400, height: 1500 },
  { name: "oxblood", src: "/covers/cover-oxblood-4x5.jpg", width: 1200, height: 1500 },
  { name: "bone", src: "/covers/cover-bone-1x1.jpg", width: 1200, height: 1200 },
  { name: "night", src: "/covers/cover-night-3x4.jpg", width: 900, height: 1200 },
];

export const heroCover: DefaultCover = defaultCovers[0]!;

export function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function pickDefaultCover(seed: string): DefaultCover {
  return defaultCovers[hashSeed(seed) % defaultCovers.length]!;
}
