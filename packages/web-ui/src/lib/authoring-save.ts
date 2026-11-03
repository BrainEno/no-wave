/**
 * 写作台保存时的两个纯决策（issue #168）：作品语言与幂等键。
 *
 * 这两件事都很小，但都很容易「看起来对」：语言写死 `zh-CN` 并不会报错，只会让
 * 英文作者永远写不出英文作品；幂等键不生成也不会报错，只会在弱网重试时给作者
 * 多出一篇重复的文章。所以它们放在 `lib/` 里、各有测试，而不是埋在组件的事件
 * 处理函数里。
 */

/** 写作台允许创作/保留的作品语言。与 API 的 `SUPPORTED_ARTICLE_LOCALES` 一致。 */
export const AUTHORING_LOCALES = ["zh-CN", "en"] as const;
export type AuthoringLocale = (typeof AUTHORING_LOCALES)[number];

export const DEFAULT_AUTHORING_LOCALE: AuthoringLocale = "zh-CN";

/**
 * 保存这篇作品时用哪个语言。
 *
 * 编辑既有作品时**保留作品自己的 `locale`**，即使它不在写作台的下拉框里：
 * 历史上存下的 `zh-TW`（或将来任何新增语言）作品，打开再保存不能悄悄被改成
 * 别的语言——那等于把作品的正文翻译成另一种语言，而原文并没有变。
 *
 * 新建作品用作者在下拉框里选的语言；没选就是默认语言。
 */
export function resolveAuthoringLocale(article: { locale?: unknown } | null | undefined, chosen?: string | null): AuthoringLocale {
  // An existing work keeps its own locale even when the desk does not offer it —
  // but only when it is a locale the API would accept. Anything else would be a
  // save the API rejects, so the author's own choice is the better answer.
  const existing = article?.locale;
  if (typeof existing === "string" && isValidArticleLocale(existing)) return existing as AuthoringLocale;
  if (isAuthoringLocale(chosen)) return chosen;
  return DEFAULT_AUTHORING_LOCALE;
}

/**
 * Every locale the API stores translations in.
 *
 * Wider than `AUTHORING_LOCALES`: the desk lets an author *read* a `zh-TW` work
 * without letting them *create* one, and a save of an existing work must keep it.
 */
export const ARTICLE_LOCALES = ["zh-CN", "zh-TW", "en"] as const;

export function isValidArticleLocale(value: unknown): value is (typeof ARTICLE_LOCALES)[number] {
  return typeof value === "string" && (ARTICLE_LOCALES as readonly string[]).includes(value);
}

export function isAuthoringLocale(value: unknown): value is AuthoringLocale {
  return typeof value === "string" && (AUTHORING_LOCALES as readonly string[]).includes(value);
}

/**
 * 保存新建作品时是否该带 `Idempotency-Key`，带哪一个。
 *
 * 契约（`docs/architecture/rest-idempotency.md`）：**一次用户意图一个键**，只在
 * 同一意图的重试里复用。翻译成写作台的行为就是：
 *
 * - 一次「保存/发布」动作第一次发生 → 生成一个新键；
 * - 同一个动作因为网络失败而重试 → 复用这个键（服务端因此能识别为重放，而不是
 *   再建一篇）；
 * - 保存成功之后，下一次点击是一次新的意图 → 换一个新键。
 *
 * 编辑既有作品不带键：`PUT` 本来就是幂等的（同一个 id、同一份内容，写两次结果
 * 一样），而服务端的幂等键只作用于创建。
 */
export type CreateIntent = { key: string | null };

/** 还没有待完成的意图。 */
export const NO_CREATE_INTENT: CreateIntent = Object.freeze({ key: null });

/** 作品的语言下拉框：新建时可选，编辑时只读。 */
export const AUTHORING_LOCALE_LABELS: Readonly<Record<AuthoringLocale, string>> = Object.freeze({
  "zh-CN": "简体中文",
  en: "English",
});

/**
 * 开始一次创建：没有待完成的键就生成一个，有就说明这是同一次意图的重试。
 *
 * `mint` 由调用方注入（生产传 `crypto.randomUUID`），测试因此不需要打桩全局。
 */
export function beginCreateIntent(intent: CreateIntent, mint: () => string): { key: string; intent: CreateIntent } {
  const key = intent.key ?? mint();
  return { key, intent: { key } };
}

/**
 * 结束一次创建。成功则清掉键（下次点击是新意图）；失败则保留，下一次重试复用。
 *
 * 「成功」以服务端返回一篇作品为准，而不是以 HTTP 状态为准：作者真的看到作品之
 * 前，重试都该是同一个意图。
 */
export function finishCreateIntent(intent: CreateIntent, succeeded: boolean): CreateIntent {
  return succeeded ? NO_CREATE_INTENT : { key: intent.key };
}
