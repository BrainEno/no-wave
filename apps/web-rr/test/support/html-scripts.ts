import { parse, type DefaultTreeAdapterMap } from "parse5";

/** Independent HTTP-test view of active HTML scripts. Do not parse HTML with
 * regexps: quoted delimiters, end-tag whitespace and inert text affect the tree.
 * Template .content is deliberately not an active child of the document. */
export function htmlScripts(html: string): DefaultTreeAdapterMap["element"][] {
  const scripts: DefaultTreeAdapterMap["element"][] = [];
  function visit(node: DefaultTreeAdapterMap["node"]): void {
    if ("tagName" in node && node.tagName === "script" && node.namespaceURI === "http://www.w3.org/1999/xhtml") scripts.push(node);
    if ("childNodes" in node) for (const child of node.childNodes) visit(child);
  }
  visit(parse(html, { scriptingEnabled: true }));
  return scripts;
}

export function inlineScriptText(node: DefaultTreeAdapterMap["element"]): string {
  return node.childNodes.map(child => "value" in child ? child.value : "").join("");
}
