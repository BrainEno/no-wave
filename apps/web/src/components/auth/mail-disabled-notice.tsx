import Link from "next/link";
import { MAIL_DISABLED_NOTICE } from "@/lib/mail-copy.ts";

/**
 * What the mail-dependent pages show instead of a form that cannot work.
 *
 * No `"use client"`: it has no state, and keeping it server-rendered means the
 * copy is in the HTML for a visitor who arrived from a link in an old mail. It
 * is also imported by client components (`AccountPanel`), which is why it only
 * imports copy — never anything that reads `process.env`.
 *
 * The two links are not decoration. A visitor who needs their password back has
 * been sent here by something, and "no" without a next step is the least useful
 * answer a page can give.
 */
export function MailDisabledNotice({ locale = "zh-CN" }: { locale?: "zh-CN" | "en" }) {
  const en = locale === "en";
  return (
    <section className="nw-auth-panel" aria-labelledby="nw-mail-off">
      <h1 id="nw-mail-off">
        <span className="nw-zh">{MAIL_DISABLED_NOTICE.title}</span> <i>{MAIL_DISABLED_NOTICE.titleEn}</i>
      </h1>
      <p className="nw-ep" style={{ marginTop: 24 }}>
        {en ? MAIL_DISABLED_NOTICE.bodyEn : MAIL_DISABLED_NOTICE.body}
      </p>
      <div className="nw-auth-switch">
        <Link className="nw-btn nw-pri" href="/sign-in">{en ? MAIL_DISABLED_NOTICE.actionEn : MAIL_DISABLED_NOTICE.action}</Link>
        <Link className="nw-btn" href="/write">{en ? "Back to the desk" : "回到写作台"}</Link>
      </div>
    </section>
  );
}
