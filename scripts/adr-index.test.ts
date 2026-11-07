import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * Architecture decisions are numbered, and other files cite them by number
 * (audit F-25).
 *
 * The repository shipped two different `0011` ADRs for four days: a citation of
 * "ADR 0011" meant the write rate limits in code and the S3 media storage in one
 * roadmap page, and neither was wrong. Renumbering fixes it once; this guard is
 * what keeps it fixed, because the failure mode is a new file that collides with
 * an old number and a citation that silently starts meaning something else.
 *
 * The rules are the ones the index page promises
 * (`docs/architecture/decisions/README.md`): unique and contiguous numbers, a
 * heading and filename that agree, an index row per file that matches it, and no
 * citation or link that points at a number that does not exist.
 */

const decisionsDirectory = new URL("../docs/architecture/decisions/", import.meta.url).pathname;
const indexFile = "README.md";

/** Leading words a `- Status:` line may start with. */
const KNOWN_STATUSES = new Set(["Accepted", "Superseded", "Proposed", "Rejected", "Deprecated", "Withdrawn"]);

const FILE_NAME = /^(\d{4})-[a-z0-9-]+\.md$/;
const HEADING = /^# ADR (\d{4}): (\S.*)$/m;
const STATUS = /^- Status:\s*(\S.*)$/m;
const DATE = /^- Date:\s*(\d{4}-\d{2}-\d{2})/m;
const CITATION = /\bADR (\d{4})\b/g;
const RELATIVE_LINK = /\]\((\d{4}-[a-z0-9-]+\.md)\)/g;
const INDEX_ROW = /^\| \[(\d{4})\]\(([^)]+)\) \| ([^|]+?) \| ([A-Za-z]+) \| (\d{4}-\d{2}-\d{2}) \|$/gm;

/** One decision file, as parsed. */
export type Adr = {
  file: string;
  number: string;
  title: string;
  status: string;
  date: string;
};

function statusWord(status: string): string {
  const word = /\b[A-Za-z]+/.exec(status.replace(/[*[\]]/g, ""));
  return word?.[0] ?? "";
}

function isCalendarDate(value: string): boolean {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * Check a set of decision files against the index page. Pure: `files` maps a
 * file name to its contents, so the tests below can feed it damaged copies.
 */
export function checkAdrIndex(files: Record<string, string>): string[] {
  const problems: string[] = [];
  const adrs: Adr[] = [];
  const byNumber = new Map<string, string>();

  const names = Object.keys(files).filter((name) => name !== indexFile).sort();

  for (const file of names) {
    const name = FILE_NAME.exec(file);
    if (!name) {
      problems.push(`${file}: is not named NNNN-a-lowercase-slug.md`);
      continue;
    }
    const text = files[file];

    const heading = HEADING.exec(text);
    if (!heading) {
      problems.push(`${file}: needs a "# ADR NNNN: Title" heading`);
      continue;
    }
    if (heading[1] !== name[1]) {
      problems.push(`${file}: heading says ADR ${heading[1]} but the file name says ADR ${name[1]}`);
    }

    const status = STATUS.exec(text);
    if (!status) {
      problems.push(`${file}: needs a "- Status:" line`);
    } else if (!KNOWN_STATUSES.has(statusWord(status[1]))) {
      problems.push(
        `${file}: status starts with "${statusWord(status[1])}", expected one of ${[...KNOWN_STATUSES].join(", ")}`,
      );
    }

    const date = DATE.exec(text);
    if (!date) {
      problems.push(`${file}: needs a "- Date: YYYY-MM-DD" line`);
    } else if (!isCalendarDate(date[1])) {
      problems.push(`${file}: ${date[1]} is not a calendar date`);
    }

    const previous = byNumber.get(name[1]);
    if (previous) {
      problems.push(`ADR ${name[1]} is claimed by both ${previous} and ${file}: numbers must be unique`);
    } else {
      byNumber.set(name[1], file);
    }

    adrs.push({
      file,
      number: name[1],
      title: heading[2].trim(),
      status: status ? statusWord(status[1]) : "",
      date: date?.[1] ?? "",
    });
  }

  // Contiguous from 0001: a gap is usually a rename that abandoned a number.
  for (let expected = 1; expected <= names.length; expected += 1) {
    const number = String(expected).padStart(4, "0");
    if (!byNumber.has(number)) problems.push(`ADR ${number} is missing: numbers run 0001 to ${names.length}`);
  }

  // Citations and links between decisions must name a decision that exists.
  for (const file of names) {
    const text = files[file];
    for (const [, cited] of text.matchAll(CITATION)) {
      if (!byNumber.has(cited)) problems.push(`${file}: cites ADR ${cited}, which does not exist`);
    }
    for (const [, linked] of text.matchAll(RELATIVE_LINK)) {
      if (!Object.hasOwn(files, linked)) problems.push(`${file}: links to ${linked}, which does not exist`);
    }
  }

  // The index page is the list of record: one row per file, matching the file.
  const readme = files[indexFile];
  if (typeof readme !== "string") {
    problems.push(`${indexFile}: the decisions directory needs an index page`);
    return problems;
  }
  const rows = new Map<string, { file: string; title: string; status: string; date: string }>();
  for (const [, number, file, title, status, date] of readme.matchAll(INDEX_ROW)) {
    if (rows.has(number)) problems.push(`${indexFile}: lists ADR ${number} twice`);
    rows.set(number, { file, title: title.trim(), status, date });
  }
  for (const adr of adrs) {
    const row = rows.get(adr.number);
    if (!row) {
      problems.push(`${indexFile}: no row for ADR ${adr.number} (${adr.file})`);
      continue;
    }
    if (row.file !== adr.file) problems.push(`${indexFile}: ADR ${adr.number} links ${row.file}, expected ${adr.file}`);
    if (row.title !== adr.title) problems.push(`${indexFile}: ADR ${adr.number} title "${row.title}" != "${adr.title}"`);
    if (row.status !== adr.status) problems.push(`${indexFile}: ADR ${adr.number} status "${row.status}" != "${adr.status}"`);
    if (row.date !== adr.date) problems.push(`${indexFile}: ADR ${adr.number} date "${row.date}" != "${adr.date}"`);
  }
  for (const [number, row] of rows) {
    if (!byNumber.has(number)) problems.push(`${indexFile}: row for ADR ${number} (${row.file}) has no file`);
  }

  return problems;
}

/** Read the checked-in decisions directory the way the guard sees it. */
function readDecisions(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(decisionsDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    files[entry.name] = readFileSync(join(decisionsDirectory, entry.name), "utf8");
  }
  return files;
}

test("every architecture decision has a unique number, a matching index row and no dangling citation", () => {
  const problems = checkAdrIndex(readDecisions());
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("the guard rejects a second decision under an existing number", () => {
  const files = readDecisions();
  files["0011-a-second-decision-under-the-same-number.md"] = "# ADR 0011: One number too many\n\n- Status: Accepted\n- Date: 2026-11-07\n";
  const problems = checkAdrIndex(files);
  assert.ok(
    problems.some((problem) => problem.includes("ADR 0011 is claimed by both")),
    problems.join("\n"),
  );
  assert.ok(
    problems.some((problem) => problem.includes("no row for ADR 0011") || problem.includes("links")),
    problems.join("\n"),
  );
});

test("the guard rejects a heading that disagrees with the file name", () => {
  const files = readDecisions();
  files["0028-s3-compatible-media-storage.md"] = files["0028-s3-compatible-media-storage.md"].replace(
    "# ADR 0028:",
    "# ADR 0011:",
  );
  assert.ok(
    checkAdrIndex(files).some((problem) => problem.includes("heading says ADR 0011 but the file name says ADR 0028")),
  );
});

test("the guard rejects an index row that drifted from its file", () => {
  const files = readDecisions();
  files[indexFile] = files[indexFile].replace(
    "| [0020](0020-read-aloud-stays-in-the-browser.md) | Read-aloud stays in the browser | Accepted |",
    "| [0020](0020-read-aloud-stays-in-the-browser.md) | Read-aloud stays in the browser | Proposed |",
  );
  assert.ok(checkAdrIndex(files).some((problem) => problem.includes("ADR 0020 status")));
});

test("the guard rejects a citation and a link to a number that does not exist", () => {
  const files = readDecisions();
  files["0027-client-address-behind-a-proxy.md"] += "\nSee ADR 0099 and [the S3 decision](0099-s3-compatible-media-storage.md).\n";
  const problems = checkAdrIndex(files);
  assert.ok(problems.some((problem) => problem.includes("cites ADR 0099")), problems.join("\n"));
  assert.ok(problems.some((problem) => problem.includes("links to 0099-s3-compatible-media-storage.md")), problems.join("\n"));
});
