import { articlePath, type ArticleView, type Locale } from "./content.ts";
import { isTagSlug } from "./tag-discovery.ts";
import { feedText, feedTimestamp, xmlText } from "./feed-text.ts";

/**
 * Atom/RSS rendering shared by every public feed: one tag's works and the
 * site-wide newest works.
 *
 * Callers decide *which* works and what the channel is called; this decides how
 * a bounded, already anonymous, published, locale-specific list becomes XML.
 * Keeping one renderer keeps one set of guarantees: no HTML in summaries, no
 * cross-locale entries, no duplicate or non-canonical identities, and an
 * `updated` that moves only when a listed work changes.
 */
export type FeedFormat = "atom" | "rss";

export const feedMimeTypes = { atom: "application/atom+xml", rss: "application/rss+xml" } as const;

const EMPTY_UPDATED_AT = "1970-01-01T00:00:00.000Z";
const ATOM_NAMESPACE = "http://www.w3.org/2005/Atom";

export type ArticleFeedInput = {
  articles: readonly ArticleView[];
  locale: Locale;
  siteUrl: string;
  format: FeedFormat;
  /** Already-bounded channel metadata; empty titles are refused. */
  title: string;
  subtitle: string;
  /** Site-relative paths of the HTML page and of this feed itself. */
  alternatePath: string;
  selfPath: string;
  limit: number;
  /** The `category` each entry carries: the tag's name, or the work's genre. */
  category: (article: ArticleView) => string;
};

/** Parses the feed suffix shared by every feed route: `feed.atom` or `feed.xml`. */
export function parseFeedFormat(value: unknown): FeedFormat | null {
  return value === "atom" ? "atom" : value === "xml" ? "rss" : null;
}

/** The visible label of a subscribe button; the same on tag pages and the archive. */
export function feedButtonLabel(locale: Locale, format: FeedFormat): string {
  return `${locale === "en" ? "Subscribe with" : "订阅"} ${format === "atom" ? "Atom" : "RSS"}`;
}

export function feedFileName(format: FeedFormat): string {
  return `feed.${format === "atom" ? "atom" : "xml"}`;
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

export function renderArticleFeed({ articles, locale, siteUrl, format, title: rawTitle, subtitle: rawSubtitle, alternatePath, selfPath, limit, category }: ArticleFeedInput) {
  const base = publicOrigin(siteUrl);
  const alternate = new URL(alternatePath, base).toString();
  const self = new URL(selfPath, base).toString();
  requireText(rawTitle);
  const title = feedText(rawTitle, 200);
  const subtitle = feedText(rawSubtitle, 1000);
  const identities = new Set<string>();
  const entries = articles.slice(0, limit).map((article) => {
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
      category: feedText(category(article), 200),
      publishedAt, updatedAt: modifiedAt > publishedAt ? modifiedAt : publishedAt,
    };
  });
  const updatedAt = entries.reduce((latest, entry) => entry.updatedAt > latest ? entry.updatedAt : latest, entries[0]?.updatedAt ?? EMPTY_UPDATED_AT);
  const type = feedMimeTypes[format];
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
        `<summary type="text">${text(entry.summary)}</summary>\n<category term="${text(entry.category)}"/>\n</entry>`).join("\n") + "\n</feed>\n";
  } else {
    // RSS descriptions may be interpreted as HTML after XML decoding. Escape
    // both layers; Atom instead explicitly labels its summaries as plain text.
    const rssText = (value: string) => text(text(value));
    body = `<rss version="2.0" xmlns:atom="${ATOM_NAMESPACE}" xmlns:dc="http://purl.org/dc/elements/1.1/">\n<channel>\n<title>${text(title)}</title>\n` +
      `<link>${text(alternate)}</link>\n<description>${rssText(subtitle)}</description>\n<language>${locale}</language>\n` +
      `<atom:link href="${text(self)}" rel="self" type="${type}"/>\n<lastBuildDate>${new Date(updatedAt).toUTCString()}</lastBuildDate>\n` +
      entries.map((entry) => `<item>\n<title>${text(entry.title)}</title>\n<link>${text(entry.url)}</link>\n` +
        `<guid isPermaLink="true">${text(entry.url)}</guid>\n<pubDate>${new Date(entry.publishedAt).toUTCString()}</pubDate>\n` +
        `<dc:creator>${text(entry.author)}</dc:creator>\n<description>${rssText(entry.summary)}</description>\n<category>${text(entry.category)}</category>\n</item>`).join("\n") + "\n</channel>\n</rss>\n";
  }
  return { body: `<?xml version="1.0" encoding="UTF-8"?>\n${body}`, contentType: `${type}; charset=utf-8`, self, alternate, title, updatedAt };
}
