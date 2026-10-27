/** 路由切换与数据加载时的骨架屏（与真实内容保持相近的栏宽，避免布局跳动）。 */
export default function Loading() {
  return (
    <main className="nw-w" aria-busy="true">
      <div className="nw-head" role="status" aria-label="载入中…">
        <div className="nw-sk" style={{ height: 14, width: 160, marginBottom: 24 }} />
        <div className="nw-sk" style={{ height: "clamp(64px, 11vw, 140px)", width: "55%" }} />
        <div style={{ marginTop: 64 }}>
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} style={{ padding: "28px 0", borderTop: "1px solid var(--ink)" }}>
              <div className="nw-sk" style={{ height: 14, width: 180, marginBottom: 14 }} />
              <div className="nw-sk" style={{ height: 30, width: `${70 - index * 6}%`, marginBottom: 12 }} />
              <div className="nw-sk" style={{ height: 16, width: "42%" }} />
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
