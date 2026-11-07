/**
 * Checked-in generator for the published REST contract.
 *
 *   pnpm openapi:check   # default: prove docs/api/openapi.json matches the API
 *   pnpm openapi:write   # refresh the file after an intentional contract change
 *
 * The document itself is built by the API (`apps/api/src/transport/rest/openapi/`),
 * from the same route table the dispatcher uses. This script is only the file
 * half: without it the repository would carry no readable contract, and with a
 * hand-written file the contract would drift the first time somebody renamed a
 * route. `API_URL` is not involved — nothing here starts a server.
 */
import { OPENAPI_FILE, checkOpenApiFile, writeOpenApiFile } from "./lib/openapi-contract.ts";

const write = process.argv.includes("--write");
const problems = write ? [] : await checkOpenApiFile();

if (write) {
  const written = await writeOpenApiFile();
  console.log(`Generated ${written} from the REST route table.`);
} else if (problems.length > 0) {
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  console.error(`\n${problems.length} OpenAPI contract problem(s).`);
  process.exitCode = 1;
} else {
  console.log(`${OPENAPI_FILE} matches the REST route table.`);
}
