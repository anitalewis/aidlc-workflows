// covers: scope:classic, audit:CHANGE_ACCEPTED
//
// The guard matrix (tests/harness/guard-matrix.ts), no model: A scope composed for
// the person, written the way the composer writes one, with \`guard_policy: off\`
// in its frontmatter. Guard Policy off never refuses or asks the person again; on,
// they are asked at most once and the way out works; no refusal comes back after
// its step. A case blocked today is a test.todo named after its block.

import { composedCell, guardMatrixSuite } from "../harness/guard-matrix.ts";

const BLOCK_1 = "a checkpoint wants a fresh review under Guard Policy off or relaxed, and the review cap refuses it";
const BLOCK_4 = "the second Unit's own files record a change to the first Unit's reviewed source, naming no path";

guardMatrixSuite("a composed scope with the guards off", [
  { cell: { policy: "off", review: "advisory", plan: "on" }, change: "later-unit-edit", options: { composed: composedCell("guard-cell", "off", "advisory") }, label: "on a composed scope", recordBlocked: BLOCK_4 },
  { cell: { policy: "off", review: "advisory", plan: "on" }, change: "hand-edit-source", options: { composed: composedCell("guard-cell", "off", "advisory") }, label: "on a composed scope", blocked: BLOCK_1 },
]);
