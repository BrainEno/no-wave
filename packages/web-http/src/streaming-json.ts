import { UpstreamResponseError } from "./upstream-errors.ts";

type Expectation = "key-or-end" | "key" | "colon" | "value-or-end" | "value" | "comma-or-end";
type Frame = { kind: "object" | "array"; expect: Expectation };
type NumberState = "minus" | "zero" | "integer" | "dot" | "fraction" | "exponent" | "exponent-sign" | "exponent-digits";
const invalid = () => new UpstreamResponseError("invalid-json");

/**
 * Incremental JSON syntax/UTF-8 validation for large attachments. Retained state is O(depth) plus the current decoded chunk,
 * not O(file): no property names, strings, values or object trees are retained.
 * This is not an importer/schema validator; those still run at the API boundary.
 */
export class StreamingJsonValidator {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private readonly frames: Frame[] = [];
  private readonly maxDepth: number;
  private rootComplete = false;
  private finished = false;
  private token: "none" | "string" | "number" | "literal" = "none";
  private stringIsKey = false;
  private escaped = false;
  private unicodeDigits = 0;
  private numberState: NumberState = "integer";
  private literal = "";
  private literalPosition = 0;

  constructor(maxDepth = 128) {
    if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 256) throw new RangeError("Invalid JSON nesting limit.");
    this.maxDepth = maxDepth;
  }

  write(bytes: Uint8Array): void {
    if (this.finished) throw invalid();
    let text: string;
    try { text = this.decoder.decode(bytes, { stream: true }); } catch { throw invalid(); }
    this.consume(text);
  }

  finish(): void {
    if (this.finished) return;
    let tail: string;
    try { tail = this.decoder.decode(); } catch { throw invalid(); }
    this.consume(tail);
    if (this.token === "number") this.endNumber();
    if (this.token !== "none" || this.frames.length !== 0 || !this.rootComplete) throw invalid();
    this.finished = true;
  }

  private valueComplete(): void {
    const parent = this.frames.at(-1);
    if (!parent) {
      if (this.rootComplete) throw invalid();
      this.rootComplete = true;
    } else {
      if (parent.expect !== "value" && parent.expect !== "value-or-end") throw invalid();
      parent.expect = "comma-or-end";
    }
  }

  private closeFrame(kind: Frame["kind"]): void {
    if (this.frames.at(-1)?.kind !== kind) throw invalid();
    this.frames.pop();
    this.valueComplete();
  }

  private stringCharacter(character: string): void {
    if (this.unicodeDigits) {
      const code = character.charCodeAt(0);
      if (!(code >= 48 && code <= 57 || code >= 65 && code <= 70 || code >= 97 && code <= 102)) throw invalid();
      this.unicodeDigits--;
    } else if (this.escaped) {
      this.escaped = false;
      if (character === "u") this.unicodeDigits = 4;
      else if (!'"\\/bfnrt'.includes(character)) throw invalid();
    } else if (character === "\\") {
      this.escaped = true;
    } else if (character === '"') {
      this.token = "none";
      if (this.stringIsKey) {
        const parent = this.frames.at(-1);
        if (parent?.kind !== "object") throw invalid();
        parent.expect = "colon";
      } else this.valueComplete();
    } else if (character.charCodeAt(0) < 32) throw invalid();
  }

  private endNumber(): void {
    if (!["zero", "integer", "fraction", "exponent-digits"].includes(this.numberState)) throw invalid();
    this.token = "none";
    this.valueComplete();
  }

  /** Returns false for a delimiter, which must be processed again as structure. */
  private numberCharacter(character: string): boolean {
    const digit = character >= "0" && character <= "9";
    switch (this.numberState) {
      case "minus":
        if (!digit) throw invalid();
        this.numberState = character === "0" ? "zero" : "integer";
        return true;
      case "zero":
        if (digit) throw invalid();
        break;
      case "integer":
        if (digit) return true;
        break;
      case "dot":
        if (!digit) throw invalid();
        this.numberState = "fraction";
        return true;
      case "fraction":
        if (digit) return true;
        break;
      case "exponent":
        if (character === "+" || character === "-") { this.numberState = "exponent-sign"; return true; }
        if (!digit) throw invalid();
        this.numberState = "exponent-digits";
        return true;
      case "exponent-sign":
        if (!digit) throw invalid();
        this.numberState = "exponent-digits";
        return true;
      case "exponent-digits":
        if (digit) return true;
        break;
    }
    if ((this.numberState === "zero" || this.numberState === "integer") && character === ".") {
      this.numberState = "dot";
      return true;
    }
    if (["zero", "integer", "fraction"].includes(this.numberState) && (character === "e" || character === "E")) {
      this.numberState = "exponent";
      return true;
    }
    this.endNumber();
    return false;
  }

  private beginValue(character: string): void {
    if (character === "{" || character === "[") {
      if (this.frames.length >= this.maxDepth) throw invalid();
      this.frames.push(character === "{" ? { kind: "object", expect: "key-or-end" } : { kind: "array", expect: "value-or-end" });
    } else if (character === '"') {
      this.token = "string";
      this.stringIsKey = false;
    } else if (character === "-" || character >= "0" && character <= "9") {
      this.token = "number";
      this.numberState = character === "-" ? "minus" : character === "0" ? "zero" : "integer";
    } else if (character === "t" || character === "f" || character === "n") {
      this.token = "literal";
      this.literal = character === "t" ? "true" : character === "f" ? "false" : "null";
      this.literalPosition = 1;
    } else throw invalid();
  }

  private consume(text: string): void {
    for (let position = 0; position < text.length; position++) {
      const character = text[position]!;
      if (this.token === "string") { this.stringCharacter(character); continue; }
      if (this.token === "number" && this.numberCharacter(character)) continue;
      if (this.token === "literal") {
        if (character !== this.literal[this.literalPosition++]) throw invalid();
        if (this.literalPosition === this.literal.length) { this.token = "none"; this.valueComplete(); }
        continue;
      }
      if (character === " " || character === "\r" || character === "\n" || character === "\t") continue;
      const frame = this.frames.at(-1);
      if (!frame) {
        if (this.rootComplete) throw invalid();
        this.beginValue(character);
      } else if (frame.expect === "key-or-end" || frame.expect === "key") {
        if (character === "}" && frame.expect === "key-or-end") this.closeFrame("object");
        else if (character === '"') { this.token = "string"; this.stringIsKey = true; }
        else throw invalid();
      } else if (frame.expect === "colon") {
        if (character !== ":") throw invalid();
        frame.expect = "value";
      } else if (frame.expect === "comma-or-end") {
        if (character === ",") frame.expect = frame.kind === "object" ? "key" : "value";
        else if (character === "}" && frame.kind === "object") this.closeFrame("object");
        else if (character === "]" && frame.kind === "array") this.closeFrame("array");
        else throw invalid();
      } else if (character === "]" && frame.expect === "value-or-end") this.closeFrame("array");
      else this.beginValue(character);
    }
  }
}
