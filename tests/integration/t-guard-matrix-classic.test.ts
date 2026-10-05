// covers: scope:classic, audit:CHANGE_ACCEPTED
//
// The guard matrix (tests/harness/guard-matrix.ts), no model: Classic as it ships
// (Guard Policy off, review advisory), every stage, two Units: the case people
// reported, a later Unit editing an approved Unit's file. Guard Policy off never
// refuses or asks the person again; on, they are asked at most once and the way
// out works; no refusal comes back after its step. A case blocked today is a
// test.todo named after its block.

import { guardMatrixSuite } from "../harness/guard-matrix.ts";

const BLOCK_1 = "a checkpoint wants a fresh review under Guard Policy off or relaxed, and the review cap refuses it";
const BLOCK_4 = "the second Unit's own files record a change to the first Unit's reviewed source, naming no path";

guardMatrixSuite("classic as it ships, two Units", [
  { cell: { policy: "off", review: "advisory", plan: "on" }, change: "later-unit-edit", options: { shipped: true }, label: "classic as it ships", recordBlocked: BLOCK_4 },
  { cell: { policy: "off", review: "advisory", plan: "on" }, change: "later-unit-edit-unclaimed", options: { shipped: true }, label: "classic as it ships", blocked: BLOCK_1 },
]);
