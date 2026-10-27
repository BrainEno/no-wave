import { getUi } from "@/lib/ui-copy.ts";

export const metadata = { title: "登录", robots: { index: false, follow: false } };

export default function SignInPage() {
  const ui = getUi("zh-CN");
  return (
    <main className="nw-w nw-head">
      <h1><span className="nw-zh">{ui.signIn.title}</span> <i>Sign in</i></h1>
      <p className="nw-ep" style={{ marginTop: 24 }}>{ui.signIn.body}</p>
      <p className="nw-m" lang="en" style={{ marginTop: 12 }}>{getUi("en").signIn.body}</p>
      <div style={{ height: 140 }} />
    </main>
  );
}
