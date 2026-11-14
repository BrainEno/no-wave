/** GET/HEAD use weak comparison, but a malformed whole field is not a valid match. */
export function matchesResourceEtag(value: string | null, expected: string): boolean {
  if (!value || value.length > 8192) return false;
  const field = value.replace(/^[ \t]+|[ \t]+$/g, "");
  if (field === "*") return true;
  const token = /[ \t]*(?:W\/)?("[\x21\x23-\x7e\x80-\xff]*")[ \t]*(,|$)/y;
  const target = expected.replace(/^W\//, "");
  let matched = false;
  let index = 0;
  while (index < field.length) {
    token.lastIndex = index;
    const part = token.exec(field);
    if (!part || token.lastIndex <= index || (part[2] === "," && token.lastIndex === field.length)) return false;
    matched ||= part[1] === target;
    index = token.lastIndex;
  }
  return matched;
}
