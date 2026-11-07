import { useEffect, useState, type FormEvent } from "react";
import { normalizeDisplayName, type AuthorProfile } from "@/lib/author-profile.ts";

/**
 * The author byline, where the writer can actually see and change it.
 *
 * Registration now creates a default profile, but the desk still has to render
 * the name and let a legacy account with no profile create one. Keeping the
 * fetch/save in the workspace and this as a presentational form means the same
 * panel can be reused by any framework that mounts the desk.
 */

type AuthorProfilePanelProps = {
  profile: AuthorProfile | null;
  onSave(displayName: string): Promise<void>;
};

export function AuthorProfilePanel({ profile, onSave }: AuthorProfilePanelProps) {
  const [displayName, setDisplayName] = useState(profile?.displayName ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => {
    setDisplayName(profile?.displayName ?? "");
  }, [profile?.displayName]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setStatus("");
    const name = normalizeDisplayName(displayName);
    if (!name) {
      setError("笔名不能为空，且不得超过 120 个字符。");
      return;
    }
    setBusy(true);
    try {
      await onSave(name);
      setStatus("笔名已保存。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存笔名失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="nw-authoring-profile" aria-labelledby="nw-author-profile-title" data-author-profile>
      <h2 id="nw-author-profile-title"><span className="nw-zh">作者资料</span> <i>Author profile</i></h2>
      <p className="nw-m">
        当前笔名：<strong data-author-profile-name>{profile?.displayName ?? "未设置"}</strong>
        {profile ? null : <> · 保存后会补建作者资料，公开页面才能显示署名。</>}
      </p>
      <form className="nw-auth-form" onSubmit={(event) => void submit(event)}>
        <label>笔名
          <input
            name="displayName"
            type="text"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            maxLength={120}
            required
            placeholder="无浪作者"
            data-author-profile-input
          />
        </label>
        <button className="nw-btn" type="submit" disabled={busy} data-author-profile-save>
          {busy ? "保存中…" : "保存笔名"}
        </button>
      </form>
      {error ? <p className="nw-auth-error" role="alert">{error}</p> : null}
      {status ? <p className="nw-auth-status" role="status">{status}</p> : null}
    </section>
  );
}
