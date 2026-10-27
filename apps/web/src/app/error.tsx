"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { homePath } from "@/lib/content.ts";
import { getUi } from "@/lib/ui-copy.ts";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const pathname = usePathname() ?? "/";
  const locale = pathname === "/en" || pathname.startsWith("/en/") ? "en" : "zh-CN";
  const ui = getUi(locale);
  useEffect(() => { console.error(error); }, [error]);
  return (
    <main lang={locale} className="nw-w nw-head">
      <div className="nw-stb" role="alert" style={{ borderTop: 0 }}>
        <div className="nw-big" aria-hidden="true">500</div>
        <h3>{ui.states.errorTitle}</h3>
        <p>{ui.states.errorPrefix}{ui.states.errorBody}</p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="nw-btn nw-pri" type="button" onClick={() => reset()}>{ui.states.retry}</button>
          <Link className="nw-btn" href={homePath(locale)} style={{ marginTop: 20 }}>{ui.states.backHome}</Link>
        </div>
      </div>
    </main>
  );
}
