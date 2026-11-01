/**
 * What a visitor is told when they ask for something this site cannot mail.
 *
 * Its own module on purpose: `mail-feature.ts` reads `process.env`, and a client
 * component that imported it would break the React Router build, where nothing
 * polyfills `process` in the browser. The copy has no such dependency, so both
 * tiers can share one wording from anywhere.
 *
 * One wording for every surface that can be reached while mail is off, so the
 * recovery pages, the account page and the sign-in form cannot drift into three
 * different explanations of the same thing — and the reassurance in the body is
 * deliberate: mail being off must not read as "your account is broken", because
 * an unverified address loses nothing (ADR 0014).
 */
export const MAIL_DISABLED_NOTICE = {
  title: "未启用邮件功能",
  titleEn: "Mail is off",
  body: "这个站点没有启用邮件功能，因此无法发送找回密码或验证邮箱的链接。账号本身不受影响：未验证邮箱也可以登录、写作和发布。",
  bodyEn: "This site has not enabled account mail, so it cannot send password-reset or verification links. Your account is unaffected: an unverified address can sign in, write and publish.",
  action: "前往登录",
  actionEn: "Sign in",
} as const;

/**
 * What the recovery form says when the API answers `409 MAIL_DISABLED`.
 *
 * The two switches are read by two processes and can disagree while somebody is
 * editing an env file: the page thinks mail is on and offers the form, the API
 * knows better and refuses. The API's own message is in English, so the form
 * answers in the visitor's language instead of echoing it.
 */
export const MAIL_DISABLED_FORM_ERROR = "这个站点没有启用邮件功能，无法发送找回密码的链接。";
