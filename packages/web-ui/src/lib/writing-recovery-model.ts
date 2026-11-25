import {
  AUTHORING_ARTICLE_ID_PATTERN,
  isAuthoringLocale,
  isRecord,
} from "@no-wave/web-http";
import { isNotificationActor } from "./notification-transport.ts";
import {
  parseWritingBackup,
  previewWritingRestore,
  restoreWritingFields,
  type WritingField,
  type WritingRestore,
} from "./writing-backup.ts";
import type { WritingDraft } from "./writing-session.ts";

export const RECOVERY_LIMITS = Object.freeze({
  entries: 20,
  bytes: 16 * 1024 * 1024,
  entryBytes: 2 * 1024 * 1024 + 4096,
});
export type RecoveryCode =
  | "invalid"
  | "unavailable"
  | "blocked"
  | "timeout"
  | "quota"
  | "revoked"
  | "conflict"
  | "limit"
  | "clock"
  | "stale"
  | "identity"
  | "review_required"
  | "remote_consent";
export class WritingRecoveryFault extends Error {
  readonly code: RecoveryCode;
  constructor(code: RecoveryCode) {
    super(code);
    this.name = "WritingRecoveryFault";
    this.code = code;
  }
}
export type RecoveryBase = {
  articleId: string | null;
  locale: string;
  revision: string | null;
};
export type RecoveryLease = { actor: string; epoch: string };
export type RecoveryControl = {
  version: 1;
  epoch: string;
  actor: string | null;
  enabled: boolean;
  serial: number;
};
export type RecoveryEntry = {
  version: 1;
  id: string;
  actor: string;
  epoch: string;
  writer: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  base: RecoveryBase;
  backup: string;
  outcomeUnknown: boolean;
};
export type RecoveryInput = Pick<
  RecoveryEntry,
  "id" | "writer" | "base" | "backup" | "outcomeUnknown"
> & { expectedRevision: number | null };
export type RecoveryView = {
  control: string | null;
  lease: RecoveryLease | null;
  entries: RecoveryEntry[];
};
export type RecoveryPreview = {
  id: string;
  witness: string;
  context: string;
  restore: WritingRestore;
  differentBase: boolean;
  outcomeUnknown: boolean;
};
export const recoverySize = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;
export function recoveryId(value: unknown): value is string {
  return typeof value === "string" && AUTHORING_ARTICLE_ID_PATTERN.test(value);
}
export function recoveryTime(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value < 253402300800000
  );
}
function closed(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (
    !isRecord(value) ||
    Reflect.ownKeys(value).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !fields.includes(key))
  )
    throw new WritingRecoveryFault("invalid");
  return value;
}
export function parseRecoveryBase(value: unknown): RecoveryBase {
  const row = closed(value, ["articleId", "locale", "revision"]);
  if (
    (row.articleId !== null && !recoveryId(row.articleId)) ||
    typeof row.locale !== "string" ||
    !isAuthoringLocale(row.locale) ||
    (row.revision !== null &&
      (typeof row.revision !== "string" ||
        !/^(0|[1-9][0-9]{0,18})$/.test(row.revision) ||
        BigInt(row.revision) > 9223372036854775807n)) ||
    (row.articleId === null && row.revision !== null)
  )
    throw new WritingRecoveryFault("invalid");
  return {
    articleId: row.articleId as string | null,
    locale: row.locale,
    revision: row.revision as string | null,
  };
}
export function parseRecoveryControl(value: unknown): RecoveryControl {
  const row = closed(value, ["version", "epoch", "actor", "enabled", "serial"]);
  if (
    row.version !== 1 ||
    !recoveryId(row.epoch) ||
    typeof row.enabled !== "boolean" ||
    (row.actor !== null && !isNotificationActor(row.actor)) ||
    (row.enabled && row.actor === null) ||
    typeof row.serial !== "number" ||
    !Number.isSafeInteger(row.serial) ||
    row.serial < 0
  )
    throw new WritingRecoveryFault("invalid");
  return {
    version: 1,
    epoch: row.epoch,
    actor: row.actor as string | null,
    enabled: row.enabled,
    serial: row.serial,
  };
}
export function parseRecoveryEntry(value: unknown): RecoveryEntry {
  try {
    const row = closed(value, [
      "version",
      "id",
      "actor",
      "epoch",
      "writer",
      "revision",
      "createdAt",
      "updatedAt",
      "base",
      "backup",
      "outcomeUnknown",
    ]);
    if (
      row.version !== 1 ||
      !recoveryId(row.id) ||
      !recoveryId(row.epoch) ||
      !recoveryId(row.writer) ||
      !isNotificationActor(row.actor) ||
      typeof row.revision !== "number" ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 1 ||
      !recoveryTime(row.createdAt) ||
      !recoveryTime(row.updatedAt) ||
      row.updatedAt < row.createdAt ||
      typeof row.backup !== "string" ||
      typeof row.outcomeUnknown !== "boolean" ||
      recoverySize(value) > RECOVERY_LIMITS.entryBytes
    )
      throw new WritingRecoveryFault("invalid");
    const base = parseRecoveryBase(row.base);
    const backup = parseWritingBackup(row.backup);
    if (
      Date.parse(backup.createdAt) !== row.updatedAt ||
      backup.draft.locale !== base.locale
    )
      throw new WritingRecoveryFault("invalid");
    return {
      version: 1,
      id: row.id,
      actor: row.actor,
      epoch: row.epoch,
      writer: row.writer,
      revision: row.revision,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      base,
      backup: row.backup,
      outcomeUnknown: row.outcomeUnknown,
    };
  } catch {
    throw new WritingRecoveryFault("invalid");
  }
}

/** A persisted manuscript is hostile input, not a source of account or article authority. */
export function recoveryPreview(
  entry: RecoveryEntry,
  current: WritingDraft,
  base: RecoveryBase,
): RecoveryPreview {
  const parsed = parseRecoveryEntry(entry),
    context = parseRecoveryBase(base);
  return {
    id: parsed.id,
    witness: JSON.stringify(parsed),
    context: JSON.stringify(context),
    restore: previewWritingRestore(current, parseWritingBackup(parsed.backup)),
    differentBase: JSON.stringify(parsed.base) !== JSON.stringify(context),
    outcomeUnknown: parsed.outcomeUnknown,
  };
}
export function applyRecoveryPreview(
  plan: RecoveryPreview,
  current: WritingDraft,
  base: RecoveryBase,
  fields: readonly WritingField[],
  consent: { differentBase: boolean; remoteImages: boolean },
): WritingDraft {
  if (
    JSON.stringify(parseRecoveryBase(base)) !== plan.context ||
    (plan.differentBase && !consent.differentBase)
  )
    throw new WritingRecoveryFault("stale");
  if (
    fields.includes("editorState") &&
    plan.restore.remoteImages > 0 &&
    !consent.remoteImages
  )
    throw new WritingRecoveryFault("remote_consent");
  try {
    return restoreWritingFields(current, plan.restore, fields);
  } catch {
    throw new WritingRecoveryFault("stale");
  }
}
export function recoveryProblem(error: unknown): string {
  const code =
    error instanceof WritingRecoveryFault ? error.code : "unavailable";
  const messages: Record<RecoveryCode, string> = {
    invalid: "本机缓存格式无效，未载入部分内容；可手动下载当前输入后清除缓存。",
    unavailable: "浏览器拒绝本机存储，当前输入仍在页面；请手动下载文稿备份。",
    blocked: "本机存储被其他页面的版本占用；请关闭旧页面后手动重试。",
    timeout: "本机存储未在期限内完成，不能确认已缓存；请下载文稿备份。",
    quota: "浏览器存储空间不足，原缓存未被替换；请下载备份或明确删除旧缓存。",
    revoked: "本机恢复已关闭或账户已变化，旧标签不能重新写入；请重新核对账户。",
    conflict: "本机缓存已被其他操作修改，未覆盖新版本；请刷新列表后重新选择。",
    limit:
      "本机缓存达到 20 份或 16 MiB 上限；不会自动删除旧稿，请先备份并明确删除。",
    clock: "本机时钟回退，未改写缓存时间或旧稿；请核对时钟后重试。",
    stale: "恢复预览已过期，文稿、目标或缓存已变化；请重新预览。",
    identity: "无法确认原登录账户，本机内容已隐藏；不会从缓存推断身份。",
    review_required:
      "恢复稿的上次保存结果未知；请先核对服务器作品列表，再明确解除保存拦截。",
    remote_consent: "恢复正文可能加载远程图片，请先明确同意。",
  };
  return messages[code];
}
