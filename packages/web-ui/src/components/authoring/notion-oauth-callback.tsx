import { useEffect, useRef, useState } from "react";
import {
  NOTION_OAUTH_DENIED_MESSAGE,
  announceNotionOAuth,
  exchangeNotionOAuthCode,
  parseNotionOAuthCallback,
} from "@/lib/notion-oauth.ts";

/**
 * Where Notion sends the authorization popup back to (ADR 0053).
 *
 * The first thing this page does is take the code off the address bar, so it is
 * not in the history, a bookmark or a later Referer. Then it has our API redeem
 * the code, hands the outcome to the desk that started the authorization — over
 * the channel named after the state, never `window.opener` — and closes itself.
 * The token is never rendered here; the page only says whether it worked.
 */
export function NotionOAuthCallback() {
  const [phase, setPhase] = useState<"working" | "done" | "failed">("working");
  const [message, setMessage] = useState("正在完成 Notion 授权…");
  const started = useRef(false);

  useEffect(() => {
    // Once per page load, even if an effect runs twice in development.
    if (started.current) return;
    started.current = true;
    const callback = parseNotionOAuthCallback(window.location.search);
    window.history.replaceState(null, "", window.location.pathname);

    if (callback.kind === "invalid") {
      setPhase("failed");
      setMessage("这个页面只用于完成 Notion 授权。请回到导入页，点「用 Notion 授权」。");
      return;
    }
    if (callback.kind === "denied") {
      if (callback.state !== null) announceNotionOAuth(callback.state, { kind: "notion-oauth", ok: false, message: NOTION_OAUTH_DENIED_MESSAGE });
      setPhase("failed");
      setMessage(`${NOTION_OAUTH_DENIED_MESSAGE}可以关闭这个窗口。`);
      return;
    }
    void (async () => {
      const outcome = await exchangeNotionOAuthCode(callback.code, callback.state);
      announceNotionOAuth(callback.state, outcome);
      if (outcome.ok) {
        setPhase("done");
        setMessage("授权完成，令牌已交给导入页。可以关闭这个窗口。");
        window.close();
      } else {
        setPhase("failed");
        setMessage(outcome.message);
      }
    })();
  }, []);

  return (
    <section className="nw-import">
      <div className="nw-import-head">
        <h1><span className="nw-zh">Notion 授权</span> <i>Authorize</i></h1>
      </div>
      <p className="nw-ep" role={phase === "failed" ? "alert" : "status"}>{message}</p>
      {phase === "working" ? null : (
        <p className="nw-m">令牌只交给发起授权的导入页，本站不保存；刷新或离开导入页后即失效。</p>
      )}
    </section>
  );
}
