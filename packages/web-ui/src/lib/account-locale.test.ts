import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getUi } from "./ui-copy.ts";

/**
 * The account pages (#406) moved their Chinese into `ui-copy.ts`. Two things
 * must stay true: the Chinese reads exactly as it did before the move, and the
 * English pages never fall back to Chinese. Each pinned string below is copied
 * verbatim from the component literal it replaced.
 */

const HAN = /\p{Script=Han}/u;

function strings(value: unknown, path = ""): [string, string][] {
  if (typeof value === "string") return [[path, value]];
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    strings(child, path === "" ? key : `${path}.${key}`),
  );
}

function at(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (node, key) => (node as Record<string, unknown> | undefined)?.[key],
    value,
  );
}

const PINNED_ZH: [string, string][] = [
  ["errors.serverUnreachable", "暂时无法连接服务器，请稍后重试。"],
  ["errors.mailNotEnabled", "这个站点没有启用邮件功能，无法发送验证邮件。"],
  ["errors.emailTaken", "这个邮箱已经被其他账号使用，请换一个。"],
  ["errors.passwordInvalid", "新密码需要至少 12 个字符，旧密码也不能为空。"],
  ["errors.endDeviceFailed", "结束这台设备失败，请稍后重试。"],
  ["notices.mailSent", "验证邮件已发出，请查收邮箱并按其中的链接完成验证。"],
  ["notices.passwordUpdatedNone", "密码已更新；没有其他设备处于登录状态。"],
  ["notices.deviceSignedOut", "这台设备已退出登录，它手里的令牌即刻失效。"],
  ["signedOut.goSignIn", "前往登录"],
  ["unavailable.backToDesk", "回到写作台"],
  ["unavailable.retrySignIn", "重新登录"],
  ["nav.changePassword", "修改密码"],
];

test("migrated Chinese account copy reads exactly as the component literals did", () => {
  const zh = getUi("zh-CN").account;
  for (const [path, expected] of PINNED_ZH) {
    assert.equal(at(zh, path), expected, path);
  }
});

test("parameterised Chinese notices keep their original wording and numbers", () => {
  const zh = getUi("zh-CN").account as unknown as {
    notices: {
      passwordUpdatedOthers: (n: number) => string;
      othersSignedOut: (n: number) => string;
      emailUpdated: (email: string) => string;
    };
  };
  assert.equal(
    zh.notices.passwordUpdatedOthers(2),
    "密码已更新，其他 2 台设备已退出登录；这个会话保持登录。",
  );
  assert.equal(
    zh.notices.othersSignedOut(2),
    "已让其他 2 台设备退出登录；这台设备保持登录。",
  );
  assert.equal(
    zh.notices.emailUpdated("a@example.test"),
    "邮箱已更新为 a@example.test。这个地址还没有验证标记——验证只是留一个「曾经可达」的记录，不影响登录、写作和发布。",
  );
});

test("the English account copy contains no Han characters at all", () => {
  const leaks = strings(getUi("en").account).filter(([, value]) => HAN.test(value));
  assert.deepEqual(
    leaks.map(([path, value]) => `${path}: ${value.slice(0, 60)}`),
    [],
  );
});

test("every Chinese account key has an English counterpart", () => {
  const zh = strings(getUi("zh-CN").account);
  const en = new Map(strings(getUi("en").account));
  const missing = zh
    .filter(([, value]) => HAN.test(value))
    .map(([path]) => path)
    .filter((path) => !en.has(path));
  assert.deepEqual(missing, []);
});

test("Chinese account copy has no space inside a sentence (a JSX line wrap once inserted one after a comma)", () => {
  // #404 wrapped three sentences across JSX lines; JSX rendered the break as a
  // space after the comma ("地址， 因为"). Copy now lives whole in ui-copy.ts.
  const stray = /[\p{Script=Han}，。；：、！？][ \t]+\p{Script=Han}/u;
  const hits = strings(getUi("zh-CN").account)
    .filter(([, value]) => stray.test(value))
    .map(([path]) => path);
  assert.deepEqual(hits, []);
});

const AUTH_COMPONENTS = [
  "account-panel.tsx",
  "forgot-password-form.tsx",
  "mail-disabled-notice.tsx",
  "reset-password-form.tsx",
  "sign-in-form.tsx",
  "verify-email-panel.tsx",
];

for (const file of AUTH_COMPONENTS) {
  test(`${file} reads copy from the locale it is given, never a hard-coded zh-CN`, () => {
    const source = readFileSync(
      new URL(`../components/auth/${file}`, import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(source, /getUi\(\s*["']zh-CN["']\s*\)/, "hard-coded zh-CN copy");
    assert.match(source, /getUi\(\s*locale\s*\)/, "copy must come from getUi(locale)");
  });
}

const ROUTES: [string, string][] = [
  ["account.tsx", "AccountPanel"],
  ["sign-in.tsx", "SignInForm"],
  ["forgot-password.tsx", "ForgotPasswordForm"],
  ["reset-password.tsx", "ResetPasswordForm"],
  ["verify-email.tsx", "VerifyEmailPanel"],
];

for (const [file, component] of ROUTES) {
  test(`${file} resolves the locale from the URL and passes it to ${component}`, () => {
    const source = readFileSync(
      new URL(`../../../../apps/web-rr/app/routes/${file}`, import.meta.url),
      "utf8",
    );
    assert.match(source, /locale: localeFor\(url\)/, "loader must return the URL locale");
    assert.match(source, /const \{[^}]*\blocale\b[^}]*\} = useLoaderData/, "component must read the loader locale");
    assert.match(source, new RegExp(`<${component}[^>]*locale=\\{locale\\}`), `${component} must receive locale`);
  });
}
