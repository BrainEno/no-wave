import { useEffect, useState, useSyncExternalStore } from "react";
import { Link } from "@/lib/framework/link.tsx";
import type { CatalogueController } from "@/lib/authoring-catalogue-controller.ts";
import { CollectionExportController } from "@/lib/writing-collection-export.ts";
import { CollectionDownloadLease } from "@/lib/writing-collection-browser.ts";
import { catalogueLocaleLabel } from "./catalogue-versions.tsx";

export function WritingCollectionExportPanel({ catalogue, disabled }: { catalogue: CatalogueController; disabled: boolean }) {
  const [download] = useState(() => new CollectionDownloadLease());
  const [queue] = useState(() => new CollectionExportController({
    current: () => {
      const state = catalogue.getSnapshot();
      return { actor: state.actor, selected: state.selected, scope: state.filters.scope, ready: state.status === "ready" && !state.restoring };
    },
    authorize: (actor, fingerprint) => catalogue.authorizeExport(actor, fingerprint),
    onRefused: catalogue.refuseAccount, onLimited: catalogue.respectReadCooldown,
  }));
  const state = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);
  const [message, setMessage] = useState("");
  const [clock, setClock] = useState(0);
  const source = catalogue.getSnapshot();
  const remaining = Math.max(0, Math.ceil((state.retryAt - clock) / 1000));
  const running = state.status === "running";
  useEffect(() => {
    queue.invalidate(); download.release(); setMessage("");
    return () => { queue.invalidate(); download.release(); };
  }, [queue, download, source.actor, source.selected, source.filters.scope, disabled]);
  useEffect(() => {
    if (!state.retryAt) return;
    const tick = () => setClock(Date.now()); tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [state.retryAt]);
  async function save() {
    setMessage("");
    try {
      const artifact = await queue.authorizedDownload();
      if (artifact) { download.download(artifact, artifact.current); setMessage("集合已交给浏览器下载；请妥善保管未加密的正文文件。"); }
    } catch (error) { setMessage(error instanceof Error ? error.message : "生成正文下载失败。"); }
  }
  return <section className="nw-collection-export" aria-label="正文集合备份">
    <details>
      <summary>所选正文集合备份（最多 20 个语言版本）</summary>
      <p>与 CSV 索引不同，此操作会逐篇读取所选正文并生成未加密的本机集合。不会自动加入其他语言，不包含图片原文件，也不会保存、发布或还原作品。</p>
      <p>每篇沿用严格单篇备份格式，整体上限 16 MiB；无法无损转换或读取失败时停止，不会略过文稿伪装成完整备份。只支持在用目录，回收站须先确认还原。读取期间改选、翻页或离开会废弃本次结果。</p>
      <div className="nw-authoring-actions">
        <button className="nw-btn" type="button" disabled={disabled || running || state.downloading || remaining > 0 || source.filters.scope !== "active" || !source.selected.length || source.selected.length > 20} onClick={() => { void queue.start(); }}>读取所选正文并准备集合</button>
        {running ? <button className="nw-btn" type="button" onClick={() => queue.cancel()}>停止正文读取</button> : null}
        <button className="nw-btn" type="button" disabled={disabled || state.status !== "complete" || state.downloading} onClick={() => { void save(); }}>{state.downloading ? "正在核验下载账户…" : "下载已校验正文集合"}</button>
        <button className="nw-btn" type="button" disabled={running || state.downloading || !state.plan} onClick={() => { queue.invalidate(); download.release(); setMessage(""); }}>清除暂存正文</button>
        <Link className="nw-btn" href="/write/collections">打开本机集合工具</Link>
      </div>
      {state.plan ? <p role="status">已完整读取 {state.completed} / {state.plan.selected.length} 个所选版本。{running && state.completed === state.plan.selected.length ? "正在生成 SHA-256 集合摘要……" : running ? "逐篇读取中；没有并行或自动重试。" : "各篇为各自读取时的版本，不是跨请求快照。"}</p> : null}
      {remaining > 0 ? <p role="status">请求受限，至少等待 {remaining} 秒后手动继续。</p> : null}
      {state.error ? <p role="alert">{state.error}</p> : null}
      {message ? <p role="status">{message}</p> : null}
      {state.progress.length ? <ol>{state.progress.map(item => <li key={item.key}>《{item.title}》 · {catalogueLocaleLabel(item.locale)} · {item.changedFields.length ? `与选择时有 ${item.changedFields.length} 项元数据不同，集合采用本次读取值` : "已核对所选版本"}</li>)}</ol> : null}
      {state.prepared ? <div className="nw-collection-ready"><p>完整集合：{state.prepared.collection.entries.length} 篇 / {new Set(state.prepared.collection.entries.map(entry => entry.group)).size} 组，实际 {new Intl.NumberFormat("zh-CN").format(state.prepared.bytes)} 字节。</p><code>{state.prepared.collection.digest}</code><p>SHA-256 用于检查意外损坏，不是来源签名或所有权证明。下载当下还会核验实际会话与当前选择。正文只暂存在本页内存，不写入浏览器存储。</p></div> : null}
    </details>
  </section>;
}
