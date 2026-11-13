// Filter compilation for the subgraph-compatible API. No database needed.
import { test } from "node:test";
import assert from "node:assert/strict";

const { listSql, schema } = await import("../src/subgraph.mjs");
const { pool } = await import("../src/db.mjs");

test("a resolver membership filter matches the chain-prefixed stored ids", () => {
  assert.ok(schema);
  const resolver = "0x231b0ee14048e9dccd1d247744d114a4eb5e8e63-0xee6c4522aab0003e8d14cd40a6af439055fd2577951148c14b6cea9a53475835";
  for (const op of ["resolver_in", "resolver_not_in"]) {
    const { values } = listSql("Domain", { where: { [op]: [resolver] } }, 1);
    assert.deepEqual(values.at(-1), [`1-${resolver}`], op);
  }
  // Scalar equality already did this.
  assert.equal(listSql("Domain", { where: { resolver } }, 1).values.at(-1), `1-${resolver}`);
  // Fields that are not chain-prefixed references keep their values.
  assert.deepEqual(listSql("Domain", { where: { name_in: ["a.eth"] } }, 1).values.at(-1), ["a.eth"]);
});

test.after(() => pool.end());
