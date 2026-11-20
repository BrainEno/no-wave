import { useEffect, useRef, useState } from "react";
import type { WritingVaultWorkbench } from "@/lib/writing-vault-controller.ts";
import type { VaultReview } from "@/lib/writing-vault-payload.ts";
import type {
  VaultTextPage,
  VaultTextSearch,
} from "@/lib/writing-vault-preview.ts";
import { MergeLiteral } from "./writing-merge-review.tsx";

/** The raw view owns only one bounded page and content-free search offsets, never another full JSON string. */
export function WritingVaultTextPreview({
  controller,
  review,
}: {
  controller: WritingVaultWorkbench;
  review: VaultReview;
}) {
  const [page, setPage] = useState<VaultTextPage | null>(() => {
    try {
      return controller.previewPage(review, 0);
    } catch {
      return null;
    }
  });
  const [anchor, setAnchor] = useState("0");
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<VaultTextSearch | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const serial = useRef(0),
    region = useRef<HTMLDivElement | null>(null);
  useEffect(
    () => () => {
      serial.current++;
      controller.cancelPreviewSearch();
    },
    [controller, review],
  );
  function move(offset: number, direction: "forward" | "backward" = "forward") {
    try {
      const next = controller.previewPage(review, offset, direction);
      setPage(next);
      setAnchor(String(next.start));
      setError("");
      region.current?.focus();
    } catch {
      setPage(null);
      setError("原始文字来源已变化，未显示旧页。请重新读取或解密。");
    }
  }
  function cancel() {
    serial.current++;
    controller.cancelPreviewSearch();
    setSearching(false);
    setResult(null);
  }
  async function search(from: number) {
    const ticket = ++serial.current;
    setSearching(true);
    setResult(null);
    setError("");
    try {
      const found = await controller.searchPreview(review, query, from);
      if (ticket !== serial.current) return;
      setResult(found);
      if (found.hits[0]) move(found.hits[0].start);
    } catch {
      if (ticket === serial.current)
        setError(
          "文字检索无效、已取消或来源变化。最多输入 120 个 Unicode 字符，不接受空条件；没有展开旧结果。",
        );
    } finally {
      if (ticket === serial.current) setSearching(false);
    }
  }
  return (
    <section aria-label="原始 JSON 分页文字">
      <p>
        每页最多 8192 个原始 UTF-8 字节，边界不切断 Unicode
        字符；BOM、空白、转义和换行不改写。分页是显示限制，不截短下载文件。字节偏移从
        0 开始，页末偏移不包含在本页内。
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (/^\d{1,9}$/.test(anchor)) move(Number(anchor));
          else setError("请输入文件范围内的整数字节偏移。");
        }}
      >
        <label>
          跳到原始字节偏移
          <input
            inputMode="numeric"
            value={anchor}
            maxLength={9}
            onChange={(event) => setAnchor(event.target.value)}
          />
        </label>
        <button className="nw-btn" type="submit">
          查看该字节附近
        </button>
      </form>
      {page ? (
        <>
          <p role="status">
            正在显示 [{page.start}, {page.end}) / {review.bytes} 个原始字节。
          </p>
          <div className="nw-authoring-actions">
            <button
              className="nw-btn"
              type="button"
              disabled={page.start === 0}
              onClick={() => move(0)}
            >
              第一页原始文字
            </button>
            <button
              className="nw-btn"
              type="button"
              disabled={page.start === 0}
              onClick={() => move(page.start, "backward")}
            >
              上一页原始文字
            </button>
            <button
              className="nw-btn"
              type="button"
              disabled={page.end === review.bytes}
              onClick={() => move(page.end)}
            >
              下一页原始文字
            </button>
            <button
              className="nw-btn"
              type="button"
              disabled={page.end === review.bytes}
              onClick={() => move(review.bytes, "backward")}
            >
              最后一页原始文字
            </button>
          </div>
          <div ref={region} tabIndex={-1}>
            <MergeLiteral text={page.text} />
          </div>
        </>
      ) : (
        <p role="status">当前没有可显示的原始文字页。</p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void search(0);
        }}
      >
        <label>
          原始 JSON 字面检索
          <input
            type="search"
            value={query}
            maxLength={240}
            autoComplete="off"
            onChange={(event) => {
              cancel();
              setError("");
              setQuery(event.target.value);
            }}
          />
        </label>
        <p>
          匹配原始 JSON 的精确 UTF-8
          字节，不是正文语义搜索；区分大小写、空格、转义和 Unicode
          组合形式，不使用正则。每次最多列 100 处偏移，不创建索引或保存检索词。
        </p>
        <div className="nw-authoring-actions">
          <button
            className="nw-btn"
            type="submit"
            disabled={searching || !query}
          >
            从文件开头检索
          </button>
          {searching ? (
            <button className="nw-btn" type="button" onClick={cancel}>
              停止原始文字检索
            </button>
          ) : null}
          {!searching && result && !result.complete && result.hits.length ? (
            <button
              className="nw-btn"
              type="button"
              onClick={() => {
                void search(result.hits.at(-1)!.start + 1);
              }}
            >
              继续检索后续偏移
            </button>
          ) : null}
        </div>
      </form>
      {searching ? (
        <p role="status">
          正在有界扫描原始字节，可以停止；未完成前不展示匹配。
        </p>
      ) : null}
      {result ? (
        <section aria-label="原始 JSON 字节检索结果">
          <p role="status">
            本次扫描 {result.scannedBytes} 字节，显示 {result.hits.length}{" "}
            处匹配；
            {result.complete
              ? "已到文件末尾。"
              : "达到 100 处上限，尚未穷尽后续字节。"}
          </p>
          <ol>
            {result.hits.map((hit) => (
              <li key={hit.start}>
                <button
                  className="nw-btn"
                  type="button"
                  onClick={() => move(hit.start)}
                >
                  定位字节 [{hit.start}, {hit.end})
                </button>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
