import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@/lib/framework/link.tsx";
import type { WritingVaultWorkbench } from "@/lib/writing-vault-controller.ts";
import type { VaultReview } from "@/lib/writing-vault-payload.ts";
import { WritingCollectionDocument } from "./writing-collection-document.tsx";
import { MERGE_ROLE_LABELS } from "./writing-merge-review.tsx";
import { catalogueLocaleLabel } from "./catalogue-versions.tsx";
import { WritingVaultTextPreview } from "./writing-vault-text-preview.tsx";

export const VAULT_KIND_LABELS = {
  backup: "单篇文稿备份",
  collection: "文稿集合",
  "merge-plan": "三方取舍计划",
};

/** This is a literal local review, never a Lexical import, image load, server identity or restore action. */
export function WritingVaultReview({
  review,
  controller,
}: {
  review: VaultReview;
  controller: WritingVaultWorkbench;
}) {
  const [selected, setSelected] = useState(review.documents[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [locale, setLocale] = useState("all");
  const [page, setPage] = useState(0);
  const [raw, setRaw] = useState(false);
  const document = review.documents.find((item) => item.id === selected);
  const visible = useMemo(
    () =>
      review.documents.filter((item) => {
        const draft = item.backup.draft;
        return (
          (locale === "all" || draft.locale === locale) &&
          (!query ||
            draft.title.includes(query) ||
            draft.summary.includes(query))
        );
      }),
    [review.documents, query, locale],
  );
  const region = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (selected) region.current?.focus();
  }, [selected]);
  const decisions = review.plan?.decisions ?? [];
  const pages = Math.max(1, Math.ceil(decisions.length / 12));
  const current = Math.min(page, pages - 1);
  const hidden = document && !visible.some((item) => item.id === document.id);
  function move(direction: -1 | 1) {
    if (!visible.length) return;
    const index = visible.findIndex((item) => item.id === selected);
    setSelected(
      visible[(index + direction + visible.length) % visible.length]!.id,
    );
  }
  return (
    <section className="nw-vault-review" aria-label="本机载荷只读复核">
      <h2>{VAULT_KIND_LABELS[review.kind]} · 只读复核</h2>
      <p>
        完整载荷已通过原有结构校验，共 {review.bytes.toLocaleString("zh-CN")}{" "}
        字节。预览只读，不会拆分或改写输出；下载保持原文件的 BOM、JSON
        空白、字段顺序与换行。
      </p>
      <p>
        结构有效、SHA-256
        和解密认证都不证明作者身份、共同基线、图片所有权、可发布性或服务器保存结果。文件不含图片原始字节，也不装载其中的图片或链接。
      </p>
      <details>
        <summary>原始明文字节 SHA-256（仅本机对照，不是签名）</summary>
        <code className="nw-collection-digest">{review.digest}</code>
      </details>
      {review.documents.length ? (
        <>
          <div className="nw-collection-filter-grid">
            <label>
              复核标题或摘要筛选
              <input
                type="search"
                value={query}
                maxLength={120}
                autoComplete="off"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <label>
              复核文稿语言
              <select
                value={locale}
                onChange={(event) => setLocale(event.target.value)}
              >
                <option value="all">全部语言</option>
                {["zh-CN", "zh-TW", "en"].map((value) => (
                  <option key={value} value={value}>
                    {catalogueLocaleLabel(value)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              查看文件内文稿
              <select
                value={selected}
                onChange={(event) => setSelected(event.target.value)}
              >
                {review.documents.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.id} · {item.backup.draft.title || "（无标题）"} ·{" "}
                    {catalogueLocaleLabel(item.backup.draft.locale)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p>
            筛选可见 {visible.length} / {review.documents.length}{" "}
            篇；筛选和查看均不改变加密或解密文件的成员。
            {hidden ? "当前查看文稿被筛选隐藏，仍保留查看位置。" : ""}
          </p>
          <ul className="nw-vault-document-list" aria-label="筛选后的复核文稿">
            {visible.map((item) => (
              <li key={item.id}>
                <button
                  className="nw-btn"
                  type="button"
                  aria-pressed={selected === item.id}
                  onClick={() => setSelected(item.id)}
                >
                  {item.id} · {item.backup.draft.title || "（无标题）"}
                </button>
              </li>
            ))}
          </ul>
          <div className="nw-authoring-actions">
            <button
              className="nw-btn"
              type="button"
              disabled={!visible.length}
              onClick={() => move(-1)}
            >
              上一份可见文稿
            </button>
            <button
              className="nw-btn"
              type="button"
              disabled={!visible.length}
              onClick={() => move(1)}
            >
              下一份可见文稿
            </button>
            <button
              className="nw-btn"
              type="button"
              onClick={() => {
                setQuery("");
                setLocale("all");
              }}
            >
              清除复核筛选
            </button>
          </div>
          <div ref={region} tabIndex={-1}>
            {document ? (
              <WritingCollectionDocument
                key={document.id}
                row={{ entry: document }}
              />
            ) : null}
          </div>
        </>
      ) : null}
      {review.plan ? (
        <section aria-label="加密工作台中的只读取舍计划">
          <h3>计划不含正文，也不自动恢复取舍</h3>
          <p>
            已记录 {decisions.length}{" "}
            项明确取舍；这里只验证计划语法、自附摘要和内部来源引用。不知道这些条目是否属于您稍后选择的原文，也不知道还有多少冲突未解决。必须回三方工作台重新选择三份原文件、预览并确认。
          </p>
          <dl>
            {Object.entries(review.plan.sources).map(([role, digest]) => (
              <div key={role}>
                <dt>
                  {MERGE_ROLE_LABELS[role as keyof typeof MERGE_ROLE_LABELS]}
                  来源摘要
                </dt>
                <dd>
                  <code className="nw-collection-digest">{digest}</code>
                </dd>
              </div>
            ))}
          </dl>
          <p>
            人工取舍第 {current + 1} / {pages}{" "}
            页，只分页显示，不省略文件中的其他取舍。
          </p>
          <ol start={current * 12 + 1}>
            {decisions.slice(current * 12, current * 12 + 12).map((item) => (
              <li key={item.unit}>
                <code>{item.unit}</code> → {MERGE_ROLE_LABELS[item.choice]}
              </li>
            ))}
          </ol>
          <div className="nw-authoring-actions">
            <button
              className="nw-btn"
              type="button"
              disabled={current === 0}
              onClick={() => setPage(current - 1)}
            >
              上一页取舍
            </button>
            <button
              className="nw-btn"
              type="button"
              disabled={current + 1 >= pages}
              onClick={() => setPage(current + 1)}
            >
              下一页取舍
            </button>
            <Link className="nw-btn" href="/write/merge">
              前往三方合并（不携带文件）
            </Link>
          </div>
        </section>
      ) : null}
      <details onToggle={(event) => setRaw(event.currentTarget.open)}>
        <summary>查看原始 JSON（分页纯文字，含私密内容）</summary>
        {raw ? (
          <WritingVaultTextPreview controller={controller} review={review} />
        ) : null}
      </details>
    </section>
  );
}
