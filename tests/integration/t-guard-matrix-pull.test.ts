// covers: scope:classic, audit:CHANGE_ACCEPTED
//
// The guard matrix (tests/harness/guard-matrix.ts), no model: A pulled commit
// changes the approved requirements while Unit 2 generates. Guard Policy off never
// refuses or asks the person again; on, they are asked at most once and the way
// out works; no refusal comes back after its step. A case blocked today is a
// test.todo named after its block.

import { guardMatrixSuite } from "../harness/guard-matrix.ts";

const BLOCK_4 = "the second Unit's own files record a change to the first Unit's reviewed source, naming no path";

guardMatrixSuite("a pull changes inputs mid-stage", [
  { cell: { policy: "off", review: "advisory", plan: "on" }, change: "pull", recordBlocked: BLOCK_4 },
  { cell: { policy: "relaxed", review: "advisory", plan: "on" }, change: "pull", recordBlocked: BLOCK_4 },
  { cell: { policy: "strict", review: "advisory", plan: "on" }, change: "pull" },
]);
