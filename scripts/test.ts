import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  nodeTestArguments,
  TEST_GROUPS,
  type TestGroup,
} from "./lib/test-discovery.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** Exactly one closed-set group; all Node arguments/paths are assembled here. */
export async function runDiscoveredTests(
  argv: readonly string[],
): Promise<number> {
  if (
    argv.length !== 1 ||
    !(TEST_GROUPS as readonly string[]).includes(argv[0]!)
  )
    throw new Error(`Usage: node scripts/test.ts ${TEST_GROUPS.join("|")}`);
  const args = nodeTestArguments(argv[0] as TestGroup, root);
  return new Promise<number>((resolveExit, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      stdio: "inherit",
      shell: false,
      env: process.env,
    });
    const interrupt = () => child.kill("SIGINT");
    const terminate = () => child.kill("SIGTERM");
    const detach = () => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    };
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    child.once("error", (error) => {
      detach();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      detach();
      resolveExit(code ?? (signal === "SIGINT" ? 130 : 143));
    });
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = await runDiscoveredTests(process.argv.slice(2));
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Unable to discover tests.",
    );
    process.exitCode = 1;
  }
}
