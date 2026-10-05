// covers: scope:classic, audit:CHANGE_ACCEPTED
//
// The guard matrix (tests/harness/guard-matrix.ts), no model: The person edits an
// approved file by hand: Unit 1's source after its checkpoint, or the requirements
// after their gate. Guard Policy off never refuses or asks the person again; on,
// they are asked at most once and the way out works; no refusal comes back after
// its step. A case blocked today is a test.todo named after its block.

import { guardMatrixSuite } from "../harness/guard-matrix.ts";

const BLOCK_1 = "a checkpoint wants a fresh review under Guard Policy off or relaxed, and the review cap refuses it";
const BLOCK_4 = "the second Unit's own files record a change to the first Unit's reviewed source, naming no path";

guardMatrixSuite("the person hand-edits an approved file", [
  { cell: { policy: "off", review: "advisory", plan: "on" }, change: "hand-edit-source", blocked: BLOCK_1 },
  { cell: { policy: "relaxed", review: "advisory", plan: "on" }, change: "hand-edit-source", blocked: BLOCK_1 },
  { cell: { policy: "strict", review: "advisory", plan: "on" }, change: "hand-edit-source" },
  { cell: { policy: "off", review: "advisory", plan: "on" }, change: "hand-edit-requirements", recordBlocked: BLOCK_4 },
  { cell: { policy: "strict", review: "advisory", plan: "on" }, change: "hand-edit-requirements" },
]);
