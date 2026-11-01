import type { Locale } from "./content.ts";

/** 2026.10.01（固定 UTC，避免服务端与浏览器时区不一致）。 */
export function dateLabel(value: string, locale: Locale): string {
  return new Date(value).toLocaleDateString(locale === "en" ? "en-US" : "zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "UTC" })
    .replaceAll("/", ".");
}

export function longDate(value: string, locale: Locale): string {
  return new Date(value).toLocaleDateString(locale === "en" ? "en-US" : "zh-CN", { dateStyle: "long", timeZone: "UTC" });
}

export function pad(index: number): string { return String(index).padStart(2, "0"); }

export function initial(name: string): string { return Array.from(name.trim())[0] ?? "·"; }
