/** XML 1.0 text, not HTML or CDATA. Lone UTF-16 surrogates are not legal XML. */
function legalXmlCharacter(character: string): string {
  const point = character.codePointAt(0)!;
  return point === 9 || point === 10 || point === 13 || (point >= 0x20 && point <= 0xd7ff) ||
    (point >= 0xe000 && point <= 0xfffd) || (point >= 0x10000 && point <= 0x10ffff) ? character : "�";
}

export function xmlText(value: string): string {
  return [...value].map(legalXmlCharacter).join("").replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&apos;";
    }
  });
}

/** One lookahead scalar bounds work even when an upstream string is unexpectedly huge. */
export function feedText(value: string, limit: number): string {
  if (!Number.isInteger(limit) || limit < 1 || limit > 4000) throw new Error("Invalid feed text limit.");
  const characters: string[] = [];
  for (const character of value) {
    if (characters.length === limit) return characters.slice(0, -1).join("") + "…";
    characters.push(legalXmlCharacter(character));
  }
  return characters.join("");
}

/** Reject Date.parse's calendar rollover and locale-dependent formats. */
export function feedTimestamp(value: string): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) throw new Error("Invalid feed publication timestamp.");
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);
  const leap = year! % 4 === 0 && (year! % 100 !== 0 || year! % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const millis = Date.parse(value);
  if (year! < 1 || month! < 1 || month! > 12 || day! < 1 || day! > days[month! - 1]! ||
      hour! > 23 || minute! > 59 || second! > 59 || !Number.isFinite(millis)) {
    throw new Error("Invalid feed publication timestamp.");
  }
  return new Date(millis).toISOString();
}
