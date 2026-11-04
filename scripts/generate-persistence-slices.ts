/**
 * Checked-in generator for the persistence slice manifest and ownership doc.
 *
 *   pnpm slices:check    # default: prove generated files + layout are current
 *   pnpm slices:generate # refresh both generated files after an intentional slice change
 *
 * Refuses to write when a structural invariant is broken, so a broken layout
 * cannot be "blessed" by regenerating its documentation.
 */
import {
  checkGeneratedFiles,
  validateLayout,
  writeGeneratedFiles,
  DOC_FILE,
  MANIFEST_FILE,
} from "./lib/persistence-slices.ts";

const write = process.argv.includes("--write");
const problems = [...await validateLayout(), ...(write ? [] : await checkGeneratedFiles())];

if (problems.length > 0) {
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  console.error(`\n${problems.length} persistence slice problem(s). Run pnpm slices:generate after fixing the sources.`);
  process.exitCode = 1;
} else if (write) {
  await writeGeneratedFiles();
  console.log(`Generated ${MANIFEST_FILE}`);
  console.log(`Generated ${DOC_FILE}`);
} else {
  console.log("Persistence slice manifest, ownership document and invariants are current.");
}
