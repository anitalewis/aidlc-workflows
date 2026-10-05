// covers: scope:classic, audit:REVIEW_REQUESTED
//
// The guard matrix (tests/harness/guard-matrix.ts), no model: At Unit 2's
// checkpoint the person asks for another review before they approve. Guard Policy
// off never refuses or asks the person again; on, they are asked at most once and
// the way out works; no refusal comes back after its step. A case blocked today is
// a test.todo named after its block.

import { guardMatrixSuite } from "../harness/guard-matrix.ts";

const BLOCK_2 = "the review cap refuses a second review the person asks for under Guard Policy off";
const BLOCK_4 = "the second Unit's own files record a change to the first Unit's reviewed source, naming no path";

guardMatrixSuite("the person asks for a second review after one cycle", [
  { cell: { policy: "off", review: "advisory", plan: "on" }, change: "second-review", blocked: BLOCK_2 },
  { cell: { policy: "off", review: "adversarial", plan: "on" }, change: "second-review", recordBlocked: BLOCK_4 },
  { cell: { policy: "strict", review: "advisory", plan: "on" }, change: "second-review" },
  { cell: { policy: "strict", review: "adversarial", plan: "on" }, change: "second-review" },
]);
