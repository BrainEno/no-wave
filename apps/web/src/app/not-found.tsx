import Link from "next/link";

export const metadata = { title: "404", robots: { index: false, follow: false } };

export default function NotFound() {
  return (
    <main className="nw-w nw-head">
      <div className="nw-stb" role="status" style={{ borderTop: 0 }}>
        <div className="nw-big" aria-hidden="true">404</div>
        <h3>找不到这个页面</h3>
        <p>你访问的内容不存在，或已被移除。<span lang="en" style={{ display: "block", marginTop: 8 }}>The content does not exist or has been removed.</span></p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Link className="nw-btn nw-sec" href="/">回到首页 →</Link>
          <Link className="nw-btn" href="/en" lang="en" style={{ marginTop: 20 }}>Back to home</Link>
        </div>
      </div>
    </main>
  );
}
