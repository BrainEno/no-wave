import { articlePath, type ArticleView, type Locale } from "./content.ts";
import { isTagSlug, tagPath, TAG_PAGE_SIZE, type TagView } from "./tag-discovery.ts";
import { feedText, feedTimestamp, xmlText } from "./feed-text.ts";

export type TagFeedFormat = "atom" | "rss";
export type TagFeedInput = { tag: TagView; articles: readonly ArticleView[]; locale: Locale; siteUrl: string; format: TagFeedFormat };
export const TAG_FEED_LIMIT = TAG_PAGE_SIZE;
const EMPTY_UPDATED_AT = "1970-01-01T00:00:00.000Z";
const ATOM_NAMESPACE = "http://www.w3.org/2005/Atom";
const mimeTypes = { atom: "application/atom+xml", rss: "application/rss+xml" } as const;

export function parseTagFeedFormat(value: unknown): TagFeedFormat | null {
  return value === "atom" ? "atom" : value === "xml" ? "rss" : null;
}

export function tagFeedPath(slug: string, locale: Locale, format: TagFeedFormat): string {
  return `${tagPath(slug, locale)}/feed.${format === "atom" ? "atom" : "xml"}`;
}

export function tagFeedLinks(slug: string, locale: Locale) {
  return (["atom", "rss"] as const).map((format) => ({
    href: tagFeedPath(slug, locale, format), type: mimeTypes[format],
    title: `${locale === "en" ? "Subscribe with" : "订阅"} ${format === "atom" ? "Atom" : "RSS"}`,
  }));
}

function publicOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error();
    return url.origin;
  } catch { throw new Error("Invalid public site origin."); }
}

function requireText(value: string): void {
  if (!value.trim()) throw new Error("Invalid required feed metadata.");
}

/** A bounded projection of an already anonymous, published, locale-specific API page. */
export function renderTagFeed({ tag, articles, locale, siteUrl, format }: TagFeedInput) {
  const base = publicOrigin(siteUrl);
  const alternate = new URL(tagPath(tag.slug, locale), base).toString();
  const self = new URL(tagFeedPath(tag.slug, locale, format), base).toString();
  if (tag.locale !== locale) throw new Error("Inconsistent tag feed locale.");
  requireText(tag.name);
  const title = feedText(`#${tag.name} | ${locale === "en" ? "No Wave" : "无浪潮"}`, 200);
  const subtitle = feedText(tag.description || (locale === "en" ? "Recent published writing under this tag." : "这个标签下最近发表的作品。"), 1000);
  const identities = new Set<string>();
  const entries = articles.slice(0, TAG_FEED_LIMIT).map((article) => {
    if (article.locale !== locale) throw new Error("Inconsistent article feed locale.");
    if (!isTagSlug(article.slug)) throw new Error("Invalid feed article identity.");
    if (identities.has(article.slug)) throw new Error("Unexpected duplicate article in feed.");
    identities.add(article.slug);
    requireText(article.title);
    requireText(article.author.displayName);
    const publishedAt = feedTimestamp(article.publishedAt);
    const modifiedAt = article.updatedAt === undefined ? publishedAt : feedTimestamp(article.updatedAt);
    return {
      url: new URL(articlePath(article.slug, locale), base).toString(), title: feedText(article.title, 200),
      author: feedText(article.author.displayName, 200), summary: feedText(article.description, 320),
      publishedAt, updatedAt: modifiedAt > publishedAt ? modifiedAt : publishedAt,
    };
  });
  const updatedAt = entries.reduce((latest, entry) => entry.updatedAt > latest ? entry.updatedAt : latest, entries[0]?.updatedAt ?? EMPTY_UPDATED_AT);
  const type = mimeTypes[format];
  const text = xmlText;
  let body: string;
  if (format === "atom") {
    body = `<feed xmlns="${ATOM_NAMESPACE}" xml:lang="${locale}">\n` +
      `<id>${text(alternate)}</id>\n<title type="text">${text(title)}</title>\n<subtitle type="text">${text(subtitle)}</subtitle>\n` +
      `<updated>${updatedAt}</updated>\n<link rel="self" type="${type}" href="${text(self)}"/>\n` +
      `<link rel="alternate" type="text/html" href="${text(alternate)}"/>\n` +
      entries.map((entry) => `<entry>\n<id>${text(entry.url)}</id>\n<title type="text">${text(entry.title)}</title>\n` +
        `<link rel="alternate" type="text/html" href="${text(entry.url)}"/>\n<author><name>${text(entry.author)}</name></author>\n` +
        `<published>${entry.publishedAt}</published>\n<updated>${entry.updatedAt}</updated>\n` +
        `<summary type="text">${text(entry.summary)}</summary>\n<category term="${text(feedText(tag.name, 200))}"/>\n</entry>`).join("\n") + "\n</feed>\n";
  } else {
    // RSS descriptions may be interpreted as HTML after XML decoding. Escape
    // both layers; Atom instead explicitly labels its summaries as plain text.
    const rssText = (value: string) => text(text(value));
    body = `<rss version="2.0" xmlns:atom="${ATOM_NAMESPACE}" xmlns:dc="http://purl.org/dc/elements/1.1/">\n<channel>\n<title>${text(title)}</title>\n` +
      `<link>${text(alternate)}</link>\n<description>${rssText(subtitle)}</description>\n<language>${locale}</language>\n` +
      `<atom:link href="${text(self)}" rel="self" type="${type}"/>\n<lastBuildDate>${new Date(updatedAt).toUTCString()}</lastBuildDate>\n` +
      entries.map((entry) => `<item>\n<title>${text(entry.title)}</title>\n<link>${text(entry.url)}</link>\n` +
        `<guid isPermaLink="true">${text(entry.url)}</guid>\n<pubDate>${new Date(entry.publishedAt).toUTCString()}</pubDate>\n` +
        `<dc:creator>${text(entry.author)}</dc:creator>\n<description>${rssText(entry.summary)}</description>\n<category>${text(feedText(tag.name, 200))}</category>\n</item>`).join("\n") + "\n</channel>\n</rss>\n";
  }
  return { body: `<?xml version="1.0" encoding="UTF-8"?>\n${body}`, contentType: `${type}; charset=utf-8`, self, alternate, title, updatedAt };
}
