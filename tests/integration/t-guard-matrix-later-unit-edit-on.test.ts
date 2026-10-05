// covers: scope:classic, audit:CHANGE_ACCEPTED
//
// The guard matrix (tests/harness/guard-matrix.ts), no model: Unit 2's work edits
// a file Unit 1 made and the person approved, and claims it, with the guards on.
// Guard Policy off never refuses or asks the person again; on, they are asked at
// most once and the way out works; no refusal comes back after its step. A case
// blocked today is a test.todo named after its block.

import { guardMatrixSuite } from "../harness/guard-matrix.ts";

const BLOCK_4 = "the second Unit's own files record a change to the first Unit's reviewed source, naming no path";

guardMatrixSuite("a later Unit edits an approved Unit's file, with the guards on", [
  { cell: { policy: "relaxed", review: "advisory", plan: "on" }, change: "later-unit-edit", recordBlocked: BLOCK_4 },
  { cell: { policy: "strict", review: "advisory", plan: "on" }, change: "later-unit-edit" },
  { cell: { policy: "strict", review: "adversarial", plan: "on" }, change: "later-unit-edit" },
]);
