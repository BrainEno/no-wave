import type { JSX, ReactNode } from "react";
import {
  inlineSegments,
  type InlineMark,
  type InlineRun,
} from "@/lib/content-inline.ts";

/**
 * The read side of inline formatting, shared by the article body and the
 * comment body.
 *
 * The rules — which marks exist, what makes a link safe — live in
 * `lib/content-inline.ts`, so they can be tested without a browser. This file
 * only draws what that module decided.
 *
 * A link an author wrote is user-generated content, so it is marked as such:
 * `rel="ugc nofollow noreferrer"` and a new tab, exactly as the comment body
 * has always done it.
 */
const MARK_ELEMENTS: Record<InlineMark, keyof JSX.IntrinsicElements> = {
  bold: "strong",
  italic: "em",
  underline: "u",
  strikethrough: "s",
  code: "code",
};

function marked(text: string, marks: readonly InlineMark[], key: string): ReactNode {
  let child: ReactNode = text;
  for (const mark of marks) {
    const Element = MARK_ELEMENTS[mark];
    child = <Element key={`${key}-${mark}`}>{child}</Element>;
  }
  return child;
}

/**
 * Draw the runs of one block. `idPrefix` keeps the React keys unique when a
 * block carries several runs.
 */
export function InlineRuns({
  runs,
  idPrefix,
}: {
  runs: readonly InlineRun[];
  idPrefix: string;
}): ReactNode {
  return inlineSegments(runs).map((segment, index) => {
    const key = `${idPrefix}-${index}`;
    const child = marked(segment.text, segment.marks, key);
    if (segment.kind === "link") {
      return (
        <a
          key={key}
          href={segment.href}
          rel="ugc nofollow noreferrer"
          target="_blank"
        >
          {child}
        </a>
      );
    }
    return <span key={key}>{child}</span>;
  });
}
