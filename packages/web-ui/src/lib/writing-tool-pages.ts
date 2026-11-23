/**
 * The stand-alone local proofreading pages. They are listed in two places — at
 * the end of the open tool panel and in the desk's own navigation — and both
 * read this list, so a tool added here cannot be reachable from one and not the
 * other. Each opens in a new tab: the editor's unsaved input lives only in this
 * page, and leaving it would discard what the author has not saved yet.
 */
export const DEEP_WRITING_TOOLS = [
  { href: "/write/overlap", label: "段落审阅", hint: "在备份中找出重复与近似的段落" },
  { href: "/write/terms", label: "术语审阅", hint: "核对偏好词与变体在各篇的分布" },
  { href: "/write/cadence", label: "标点与节奏", hint: "检查配对、隐形字符与停顿长度" },
  { href: "/write/parallel", label: "双语对照", hint: "对齐多语言或多修订版本的结构" },
  { href: "/write/collections", label: "文稿集合", hint: "检查、拆分与核对本机备份" },
  { href: "/write/merge", label: "三方合并", hint: "以共同基线核对两份改稿" },
  { href: "/write/vault", label: "加密备份", hint: "为备份做加密副本，或解密" },
] as const;
