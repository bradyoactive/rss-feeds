/**
 * The two assertions every feed's offline suite is written against.
 *
 * Deliberately hand-rolled rather than pulled from @std/assert: these suites
 * run with nothing but `deno test --allow-read`, and a registry dependency
 * would be the only thing standing between a fixture and a green run.
 *
 * This is test-only code, and the one thing the vals themselves share. Their
 * runtime helpers (`esc`, `slugify`, `clamp`, …) stay duplicated per val on
 * purpose: each deploys to val.town as a single self-contained `main.ts`, so a
 * shared runtime module would have to be imported across esm.town, which is
 * what lets one feed's edit break another's deploy.
 */

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

/** Identity for primitives, structural for arrays and plain objects. */
export function assertEquals<T>(actual: T, expected: T, label = "value") {
  const equal = Object.is(actual, expected) ||
    (typeof actual === "object" && actual !== null &&
      JSON.stringify(actual) === JSON.stringify(expected));
  if (!equal) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}
