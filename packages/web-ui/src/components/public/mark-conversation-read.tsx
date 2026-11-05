"use client";

import { useEffect, useRef, useState } from "react";
import { Link } from "@/lib/framework/link.tsx";
import type { Locale } from "@/lib/content.ts";
import { getUi } from "@/lib/ui-copy.ts";

type ReadState = "idle" | "marking" | "marked" | "signed-out" | "missing" | "unconfirmed";

/**
 * The API marks every message received up to the time it handles the request;
 * it does not take a last-seen cursor. Make that an explicit, explained action
 * instead of silently marking a possibly incomplete page as read on mount.
 */
export function MarkConversationRead({ locale, conversationId }: { locale: Locale; conversationId: string }) {
  const ui = getUi(locale).messages;
  const [state, setState] = useState<ReadState>("idle");
  const inFlight = useRef(false);
  const active = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  const hintId = `nw-mark-read-hint-${conversationId}`;
  const target = `${locale === "zh-CN" ? "" : `/${locale}`}/messages/${conversationId}`;

  async function markRead() {
    if (inFlight.current) return;
    inFlight.current = true;
    setState("marking");
    try {
      const response = await fetch(`/api/authoring/inbox/${encodeURIComponent(conversationId)}/read`, {
        method: "PUT",
        credentials: "same-origin",
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      if (!active.current) return;
      if (response.status === 401) { setState("signed-out"); return; }
      if (response.status === 403 || response.status === 404) { setState("missing"); return; }
      if (!response.ok) { setState("unconfirmed"); return; }
      const payload: unknown = await response.json().catch(() => null);
      if (!active.current) return;
      if (typeof payload !== "object" || payload === null || (payload as { data?: unknown }).data !== true) {
        setState("unconfirmed");
        return;
      }
      setState("marked");
    } catch {
      // A lost response may follow a committed write; a retry covers everything
      // received by the later attempt, too. Never silently retry here.
      if (active.current) setState("unconfirmed");
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <div className="nw-mark-read">
      <p className="nw-m nw-mark-read-hint" id={hintId}>{ui.markReadHint}</p>
      <button type="button" className="nw-thread-btn" aria-describedby={hintId} disabled={state === "marking"} onClick={() => void markRead()}>
        {state === "marking" ? ui.markingRead : ui.markRead}
      </button>
      {state === "marked" ? <p className="nw-m nw-mark-read-status" role="status">{ui.markReadSuccess}</p> : null}
      {state === "unconfirmed" ? <p className="nw-m nw-mark-read-status" role="alert">{ui.markReadFailed}</p> : null}
      {state === "missing" ? <p className="nw-m nw-mark-read-status" role="alert">{ui.markReadMissing}</p> : null}
      {state === "signed-out" ? (
        <p className="nw-m nw-mark-read-status" role="alert">{ui.markReadSignIn}{" "}
          <Link target="_blank" rel="noopener noreferrer" href={`/sign-in?next=${encodeURIComponent(target)}`}>
            {getUi(locale).reader.saveSignInAction}
          </Link>
        </p>
      ) : null}
    </div>
  );
}
