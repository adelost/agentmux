// Test adapter: runs the real D1 statements against node:sqlite in memory.

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA = join(dirname(fileURLToPath(import.meta.url)), "..", "schema.sql");

/** WHAT: Builds an in-memory D1 adapter from the real schema. WHY: Keeps tests on the same statements as production. */
export function createTestDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(SCHEMA, "utf8"));
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        bind: (...args) => ({
          run: async () => stmt.run(...args),
          first: async () => stmt.get(...args) ?? null,
          all: async () => ({ success: true, results: stmt.all(...args) }),
        }),
      };
    },
  };
}
