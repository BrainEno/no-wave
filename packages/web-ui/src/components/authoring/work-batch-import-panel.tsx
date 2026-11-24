import { useState, useRef } from "react";
import { Link } from "@/lib/framework/link.tsx";
import {
  type ParsedImportItem,
  SUPPORTED_WORK_TYPES,
  parseDocxBytes,
  parseTextOrMarkdown,
  parseHtmlContent,
  parseUserDataInput,
  applyBatchPatch,
  validateImportItem,
  extractParagraphs,
} from "@/lib/work-import-utils.ts";
import { NotionImport } from "./notion-import.tsx";
import type { WorkType } from "@/lib/content.ts";

const EXAMPLE_JSON = `[
  {
    "title": "关于文学的断想",
    "author": "卡尔维诺",
    "workType": "other",
    "locale": "zh-CN",
    "summary": "经典作品是那些你经常听人家说我正在重读的作品。",
    "content": "经典作品是那些你经常听人家说我正在重读……\\n\\n一部经典作品是一本每次重读都像初读那样带来发现的书。"
  },
  {
    "title": "夜巡者手记",
    "author": "青年作者",
    "workType": "novel",
    "locale": "zh-CN",
    "content": "钟楼在午夜敲响了十二下。\\n\\n雾气从运河的方向缓慢漫延过来。"
  }
]`;

export function WorkBatchImportPanel({ onImportComplete }: { onImportComplete?: () => void }) {
  const [importMode, setImportMode] = useState<"doc" | "data" | "notion">("doc");
  const [items, setItems] = useState<ParsedImportItem[]>([]);
  const [rawText, setRawText] = useState("");
  const [isProcessingFiles, setIsProcessingFiles] = useState(false);
  const [importProgress, setImportProgress] = useState<{ current: number; total: number; title: string } | null>(null);
  const [importResults, setImportResults] = useState<{ success: number; failed: number; errors: string[] } | null>(null);

  // 批量补全控制状态
  const [patchAuthor, setPatchAuthor] = useState("");
  const [patchWorkType, setPatchWorkType] = useState<WorkType>("other");
  const [patchLocale, setPatchLocale] = useState("zh-CN");

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 处理文档文件上传 (doc, docx, txt, md, html)
  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setIsProcessingFiles(true);
    setImportResults(null);

    const newItems: ParsedImportItem[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const name = file.name;
      const baseName = name.replace(/\.[^.]+$/, "");
      const ext = name.toLowerCase().split(".").pop();

      try {
        let title = baseName;
        let content = "";

        if (ext === "docx") {
          const buffer = await file.arrayBuffer();
          const parsed = parseDocxBytes(new Uint8Array(buffer), baseName);
          title = parsed.title;
          content = parsed.content;
        } else if (ext === "txt" || ext === "md" || ext === "markdown") {
          const text = await file.text();
          const parsed = parseTextOrMarkdown(text, baseName);
          title = parsed.title;
          content = parsed.content;
        } else if (ext === "html" || ext === "htm") {
          const text = await file.text();
          const parsed = parseHtmlContent(text, baseName);
          title = parsed.title;
          content = parsed.content;
        } else {
          // 其它格式尝试纯文本读取
          const text = await file.text();
          const parsed = parseTextOrMarkdown(text, baseName);
          title = parsed.title;
          content = parsed.content;
        }

        const item: ParsedImportItem = {
          id: `file-${Date.now()}-${i}`,
          title: title || baseName,
          content: content || "",
          author: "",
          summary: content ? content.slice(0, 100) : "",
          workType: "other",
          locale: "zh-CN",
          publish: false,
          sourceName: name,
          validationErrors: [],
        };
        item.validationErrors = validateImportItem(item);
        newItems.push(item);
      } catch (err) {
        console.error(`解析文件 ${name} 失败:`, err);
      }
    }

    setItems(prev => [...prev, ...newItems]);
    setIsProcessingFiles(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  // 解析粘贴的数据
  function handleParseRawData() {
    setImportResults(null);
    const parsed = parseUserDataInput(rawText);
    if (parsed.length > 0) {
      setItems(prev => [...prev, ...parsed]);
      setRawText("");
    }
  }

  // 批量补充作者
  function handleBatchApplyAuthor() {
    if (!patchAuthor.trim()) return;
    setItems(prev =>
      prev.map(item => {
        const author = item.author.trim() ? item.author : patchAuthor.trim();
        const updated = { ...item, author };
        updated.validationErrors = validateImportItem(updated);
        return updated;
      })
    );
  }

  // 批量指定体裁
  function handleBatchApplyWorkType() {
    setItems(prev =>
      prev.map(item => {
        const updated = { ...item, workType: patchWorkType };
        updated.validationErrors = validateImportItem(updated);
        return updated;
      })
    );
  }

  // 批量指定语言
  function handleBatchApplyLocale() {
    setItems(prev =>
      prev.map(item => {
        const updated = { ...item, locale: patchLocale };
        updated.validationErrors = validateImportItem(updated);
        return updated;
      })
    );
  }

  // 批量自动生成摘要
  function handleBatchGenerateSummary() {
    setItems(prev =>
      applyBatchPatch(prev, { fillSummaryFromContent: true })
    );
  }

  // 单条更新
  function updateItem(id: string, updates: Partial<ParsedImportItem>) {
    setItems(prev =>
      prev.map(item => {
        if (item.id === id) {
          const updated = { ...item, ...updates };
          updated.validationErrors = validateImportItem(updated);
          return updated;
        }
        return item;
      })
    );
  }

  // 移除单条
  function removeItem(id: string) {
    setItems(prev => prev.filter(item => item.id !== id));
  }

  // 执行最终批量写入导入
  async function executeBatchImport() {
    const validItems = items.filter(it => it.validationErrors.length === 0);
    if (validItems.length === 0) return;

    setImportProgress({ current: 0, total: validItems.length, title: "准备中..." });
    let successCount = 0;
    let failedCount = 0;
    const errors: string[] = [];
    const successfulIds: string[] = [];

    for (let i = 0; i < validItems.length; i++) {
      const item = validItems[i];
      setImportProgress({ current: i + 1, total: validItems.length, title: item.title });

      const paragraphs = extractParagraphs(item.content);
      const contentBlocks = (paragraphs.length ? paragraphs : [item.content || ""]).map((text, idx) => ({
        id: `p-${idx + 1}`,
        type: "paragraph" as const,
        text,
      }));

      try {
        const response = await fetch("/api/authoring/articles", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: item.title.trim(),
            summary: item.summary.trim(),
            locale: item.locale,
            workType: item.workType,
            contentBlocks,
            contentBlocksVersion: 1,
            publish: item.publish,
          }),
        });

        if (response.ok) {
          successCount++;
          successfulIds.push(item.id);
        } else {
          const body = await response.json().catch(() => ({}));
          const msg = (body as { error?: { message?: string } })?.error?.message || `HTTP ${response.status}`;
          failedCount++;
          errors.push(`《${item.title}》: ${msg}`);
        }
      } catch (err) {
        failedCount++;
        errors.push(`《${item.title}》: ${err instanceof Error ? err.message : "网络错误"}`);
      }
    }

    setImportProgress(null);
    setImportResults({ success: successCount, failed: failedCount, errors });
    // 移除已成功导入的条目
    setItems(prev => prev.filter(item => !successfulIds.includes(item.id)));
    if (onImportComplete && successCount > 0) {
      onImportComplete();
    }
  }

  const missingAuthorCount = items.filter(it => !it.author.trim()).length;
  const invalidCount = items.filter(it => it.validationErrors.length > 0).length;
  const validCount = items.length - invalidCount;

  return (
    <div className="nw-import-panel nw-imp">
      {/* 导入模式切换导航 */}
      <div className="nw-authoring-actions nw-mb-20">
        <button
          className={`nw-btn ${importMode === "doc" ? "nw-pri" : ""}`}
          type="button"
          onClick={() => setImportMode("doc")}
        >
          📄 文档上传（doc / docx / txt / md）
        </button>
        <button
          className={`nw-btn ${importMode === "data" ? "nw-pri" : ""}`}
          type="button"
          onClick={() => setImportMode("data")}
        >
          🔄 用户已有数据批量接入（JSON / CSV）
        </button>
        <button
          className={`nw-btn ${importMode === "notion" ? "nw-pri" : ""}`}
          type="button"
          onClick={() => setImportMode("notion")}
        >
          📓 Notion 批量导入
        </button>
      </div>

      {/* 模式 1: 文档文件上传 */}
      {importMode === "doc" && (
        <section className="nw-imp-card">
          <h3>上传文学文档</h3>
          <p className="nw-m">
            支持拖拽或选择单个/多个 <code>.docx</code>, <code>.txt</code>, <code>.md</code>, <code>.html</code> 文件。
            系统将自动提取文稿标题与正文段落，并可在下方进行批量补充后一键转入作品草稿。
          </p>
          <div className="nw-imp-in">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".docx,.txt,.md,.markdown,.html,.htm"
              className="nw-imp-file"
              onChange={e => void handleFiles(e.target.files)}
            />
            <button
              className="nw-btn nw-pri"
              type="button"
              disabled={isProcessingFiles}
              onClick={() => fileInputRef.current?.click()}
            >
              {isProcessingFiles ? "正在解析文件……" : "选择或批量拖入文档文件 +"}
            </button>
          </div>
        </section>
      )}

      {/* 模式 2: 用户数据接入 (JSON / CSV) */}
      {importMode === "data" && (
        <section className="nw-imp-card nw-imp-card--solid">
          <h3>已有数据批量接入接口</h3>
          <p className="nw-m">
            支持从 Substack, WordPress, Hexo, Typecho 等平台导出的 JSON 或 CSV 数据。
            智能识别标题、正文、作者、体裁、摘要等字段；缺失的字段可在下方一键批量补齐。
          </p>
          <div className="nw-imp-in">
            <textarea
              value={rawText}
              onChange={e => setRawText(e.target.value)}
              placeholder={`在此粘贴 JSON 数组或 CSV 文本...\n例如：\n${EXAMPLE_JSON}`}
              rows={8}
              className="nw-imp-mono"
            />
          </div>
          <div className="nw-authoring-actions nw-mt-12">
            <button
              className="nw-btn nw-pri"
              type="button"
              disabled={!rawText.trim()}
              onClick={handleParseRawData}
            >
              解析并载入待导入清单
            </button>
            <button
              className="nw-btn"
              type="button"
              onClick={() => setRawText(EXAMPLE_JSON)}
            >
              填入示例 JSON
            </button>
          </div>
        </section>
      )}

      {/* 模式 3: Notion 导入 */}
      {importMode === "notion" && (
        <section className="nw-imp-list">
          <NotionImport />
        </section>
      )}

      {/* 批量补齐与导入清单审查区 */}
      {items.length > 0 && (
        <section className="nw-imp-review">
          <div className="nw-imp-head">
            <h3>
              待导入清单（共 {items.length} 篇 · {validCount} 篇就绪 · {invalidCount} 篇待补充）
            </h3>
            <button className="nw-btn" type="button" onClick={() => setItems([])}>
              清空清单
            </button>
          </div>

          {/* 缺失字段批量补全工具栏 (用户重点要求的“自补/批量补齐”) */}
          <div className="nw-imp-tools">
            <h4>
              ⚡ 缺失字段一键批量补齐（自补工具）
            </h4>
            <div className="nw-imp-fields">
              {/* 批量补充作者 */}
              <div className="nw-imp-field">
                <span className="nw-m">补充作者:</span>
                <input
                  type="text"
                  placeholder="作者姓名"
                  value={patchAuthor}
                  onChange={e => setPatchAuthor(e.target.value)}
                  className="nw-imp-mini"
                />
                <button className="nw-btn" type="button" onClick={handleBatchApplyAuthor}>
                  应用到缺失项 {missingAuthorCount > 0 ? `(${missingAuthorCount})` : ""}
                </button>
              </div>

              {/* 批量指定体裁 */}
              <div className="nw-imp-field">
                <span className="nw-m">统一体裁:</span>
                <select
                  value={patchWorkType}
                  onChange={e => setPatchWorkType(e.target.value as WorkType)}
                  className="nw-imp-input"
                >
                  {SUPPORTED_WORK_TYPES.map(t => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
                <button className="nw-btn" type="button" onClick={handleBatchApplyWorkType}>
                  全量应用
                </button>
              </div>

              {/* 批量指定语言 */}
              <div className="nw-imp-field">
                <span className="nw-m">语言:</span>
                <select
                  value={patchLocale}
                  onChange={e => setPatchLocale(e.target.value)}
                  className="nw-imp-input"
                >
                  <option value="zh-CN">简体中文</option>
                  <option value="en">English</option>
                  <option value="zh-TW">繁體中文</option>
                </select>
                <button className="nw-btn" type="button" onClick={handleBatchApplyLocale}>
                  全量应用
                </button>
              </div>

              {/* 批量生成摘要 */}
              <button className="nw-btn" type="button" onClick={handleBatchGenerateSummary}>
                从正文自动生成摘要
              </button>
            </div>
          </div>

          {/* 待导入文章卡片/表格 */}
          <div className="nw-imp-table-wrap">
            <table className="nw-imp-table">
              <thead>
                <tr className="nw-imp-trhead">
                  <th>状态</th>
                  <th>标题</th>
                  <th>作者</th>
                  <th>体裁</th>
                  <th>语言</th>
                  <th>字数</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map(item => (
                  <tr key={item.id} className="nw-imp-tr">
                    <td className="nw-imp-td">
                      {item.validationErrors.length === 0 ? (
                        <span className="nw-imp-ok">✅ 就绪</span>
                      ) : (
                        <span className="nw-imp-bad" title={item.validationErrors.join("、")}>
                          ⚠️ {item.validationErrors[0]}
                        </span>
                      )}
                    </td>
                    <td className="nw-imp-td">
                      <input
                        type="text"
                        value={item.title}
                        onChange={e => updateItem(item.id, { title: e.target.value })}
                        className="nw-imp-input"
                      />
                    </td>
                    <td className="nw-imp-td">
                      <input
                        type="text"
                        placeholder="作者"
                        value={item.author}
                        onChange={e => updateItem(item.id, { author: e.target.value })}
                        className="nw-imp-input"
                      />
                    </td>
                    <td className="nw-imp-td">
                      <select
                        value={item.workType}
                        onChange={e => updateItem(item.id, { workType: e.target.value as WorkType })}
                        className="nw-imp-input nw-imp-input--sel"
                      >
                        {SUPPORTED_WORK_TYPES.map(t => (
                          <option key={t.value} value={t.value}>{t.label}</option>
                        ))}
                      </select>
                    </td>
                    <td className="nw-imp-td">
                      <select
                        value={item.locale}
                        onChange={e => updateItem(item.id, { locale: e.target.value })}
                        className="nw-imp-input nw-imp-input--sel"
                      >
                        <option value="zh-CN">中文</option>
                        <option value="en">EN</option>
                        <option value="zh-TW">繁体</option>
                      </select>
                    </td>
                    <td className="nw-imp-td">
                      <span className="nw-m">{item.content.length} 字</span>
                    </td>
                    <td className="nw-imp-td">
                      <button
                        type="button"
                        onClick={() => removeItem(item.id)}
                        className="nw-imp-del"
                        title="移除此项"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 进度与执行按钮 */}
          {importProgress && (
            <div className="nw-imp-note">
              <p>
                ⏳ 正在导入第 {importProgress.current} / {importProgress.total} 篇：《{importProgress.title}》……
              </p>
            </div>
          )}

          {importResults && (
            <div className="nw-imp-note nw-imp-note--result">
              <p>
                🎉 批量导入完成：成功写入 {importResults.success} 篇草稿{importResults.failed > 0 ? `，失败 ${importResults.failed} 篇` : ""}！
              </p>
              {importResults.errors.length > 0 && (
                <ul className="nw-imp-errlist">
                  {importResults.errors.map((err, i) => (
                    <li key={i}>{err}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="nw-authoring-actions nw-mt-20">
            <button
              className="nw-btn nw-pri"
              type="button"
              disabled={validCount === 0 || importProgress !== null}
              onClick={() => void executeBatchImport()}
            >
              {importProgress !== null
                ? "正在批量写入数据库……"
                : `确认批量导入已就绪作品 (${validCount} 篇)`}
            </button>
            <Link className="nw-btn" href="/write">
              返回写作台
            </Link>
          </div>
        </section>
      )}
    </div>
  );
}
