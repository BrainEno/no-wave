/**
 * One definition of a link an author may put into a Lexical document.
 *
 * The editor and the comment composer both accept an HTTP(S) URL or a
 * site-absolute path. A protocol-relative address, credentials, control
 * characters and backslashes are refused everywhere: the server-side content
 * adapter applies the same boundary to persisted blocks.
 *
 * Keeping this in `lib/` rather than inside a component also makes the rule
 * testable without a browser. The writing desk used to carry a second copy with
 * one extra layer of escaping, which turned the character class into an ASCII
 * range and rejected every `https://` link (issue #154).
 */
const UNSAFE_EDITOR_HREF_CHARACTERS = /[\u0000-\u0020\u007f\\]/;

/** Return the trimmed, safe href, or `null` when the value must be refused. */
export function sanitizeEditorHref(raw: string): string | null {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value || value.startsWith("//") || UNSAFE_EDITOR_HREF_CHARACTERS.test(value)) return null;
  if (value.startsWith("/")) return value;
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
    return value;
  } catch {
    return null;
  }
}
