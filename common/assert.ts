/**
 * The two assertions every feed's offline suite is written against.
 *
 * Deliberately hand-rolled: messages read the same in every suite, and the
 * failure label says which field was wrong.
 *
 * This is test-only code. The feeds' runtime helpers (`esc`, `slugify`,
 * `clamp`, …) are duplicated per feed because each was once deployed to
 * val.town as a self-contained `main.ts`.
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
