import { useRef, useState } from "react";
import { overlapPreview } from "@/lib/writing-overlap-model.ts";

/** Plain text pages only: neither body text, URLs nor serialized nodes become active markup. */
export function OverlapLiteral({
  text,
  label,
  highlights,
}: {
  text: string;
  label: string;
  highlights?: (start: number, end: number) => { text: string; hit: boolean }[];
}) {
  const [position, setPosition] = useState({ witness: text, history: [0] });
  const [jump, setJump] = useState("");
  const [error, setError] = useState("");
  const region = useRef<HTMLElement>(null);
  const history = position.witness === text ? position.history : [0];
  const page = overlapPreview(text, history.at(-1)!);
  const pieces = highlights?.(page.start, page.end);
  function navigate(offsets: number[]) {
    setPosition({ witness: text, history: offsets });
    setJump("");
    setError("");
    region.current?.focus();
  }
  function locate() {
    const offset = Number(jump);
    if (
      !/^\d+$/u.test(jump) ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset >= text.length
    ) {
      setError(
        `请输入 0–${Math.max(0, text.length - 1)} 范围内的整数字符偏移。`,
      );
      return;
    }
    const target = overlapPreview(text, offset);
    navigate([target.start]);
  }
  return (
    <section
      className="nw-overlap-literal"
      aria-label={label}
      tabIndex={-1}
      ref={region}
    >
      <p>
        {label} · UTF-16 偏移 {page.start}–{page.end} / {text.length}；每页最多
        2048 个代码单元，不拆开代理对，可能跨越组合字形。
      </p>
      <pre>
        {pieces
          ? pieces.map((piece, index) =>
              piece.hit ? (
                <mark key={index}>{piece.text}</mark>
              ) : (
                <span key={index}>{piece.text}</span>
              ),
            )
          : page.text || "（空文字）"}
      </pre>
      <div className="nw-authoring-actions">
        <button
          className="nw-btn"
          type="button"
          disabled={history.length < 2}
          onClick={() => navigate(history.slice(0, -1))}
        >
          上一页{label}
        </button>
        <button
          className="nw-btn"
          type="button"
          disabled={!page.more}
          onClick={() => navigate([...history, page.end])}
        >
          下一页{label}
        </button>
        <button
          className="nw-btn"
          type="button"
          disabled={page.start === 0}
          onClick={() => navigate([0])}
        >
          返回{label}开头
        </button>
      </div>
      {page.more ? (
        <p>后续文字未在当前页显示；这不是删节后的完整段落。</p>
      ) : null}
      {text.length > 2048 ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            locate();
          }}
        >
          <label>
            定位{label}字符偏移
            <input
              inputMode="numeric"
              value={jump}
              onChange={(event) => {
                setJump(event.target.value);
                setError("");
              }}
            />
          </label>
          <button className="nw-btn" type="submit">
            定位{label}
          </button>
        </form>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
