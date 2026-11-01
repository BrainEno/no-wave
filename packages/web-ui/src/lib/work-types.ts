import type { WorkType } from "./content.ts";

export const workTypes: readonly WorkType[] = ["novel", "short_story", "poetry", "essay", "criticism", "literary_criticism", "nonfiction", "serial", "other"];

/** 查询参数里的 `type`：只接受 API 定义的作品类型，其他值一律视为“全部”。 */
export function parseWorkType(value: string | string[] | undefined): WorkType | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" && (workTypes as readonly string[]).includes(raw) ? raw as WorkType : null;
}

export const PAGE_SIZE = 20;
export const MAX_PAGE = 5001;

export function parsePage(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const page = typeof raw === "string" ? Number(raw) : 1;
  return Number.isSafeInteger(page) && page >= 1 && page <= MAX_PAGE ? page : 1;
}

export function paginate<T>(items: readonly T[], page: number, size = PAGE_SIZE): { visible: T[]; hasNextPage: boolean } {
  const offset = (page - 1) * size;
  return { visible: items.slice(offset, offset + size), hasNextPage: items.length > offset + size };
}

/** 把文本按查询词切成片段，供高亮使用（不使用 dangerouslySetInnerHTML）。 */
export function splitHighlight(text: string, query: string): { text: string; hit: boolean }[] {
  const needle = query.trim();
  if (!needle) return [{ text, hit: false }];
  const lower = text.toLocaleLowerCase();
  const target = needle.toLocaleLowerCase();
  const parts: { text: string; hit: boolean }[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const found = lower.indexOf(target, cursor);
    if (found === -1) { parts.push({ text: text.slice(cursor), hit: false }); break; }
    if (found > cursor) parts.push({ text: text.slice(cursor, found), hit: false });
    parts.push({ text: text.slice(found, found + target.length), hit: true });
    cursor = found + target.length;
  }
  return parts.length ? parts : [{ text, hit: false }];
}

/** 诗歌作品的前两行（取自第一段正文，按换行拆分）。 */
export function firstLines(text: string, count = 2): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, count);
}
