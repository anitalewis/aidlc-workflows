// covers: scope:classic, audit:CHANGE_ACCEPTED
//
// The guard matrix (tests/harness/guard-matrix.ts), no model: A team's own plugin
// (a synthetic one, composed by its hook) whose scope says `guard_policy: off` and
// puts Requirements, Units Generation, Code Generation and Build and Test under it
// with `adds.scopes`. Guard Policy off never refuses or asks the person again; on,
// they are asked at most once and the way out works; no refusal comes back after
// its step. A case blocked today is a test.todo named after its block.

import { guardMatrixSuite, pluginCell } from "../harness/guard-matrix.ts";

const BLOCK_1 = "a checkpoint wants a fresh review under Guard Policy off or relaxed, and the review cap refuses it";
const BLOCK_2 = "the review cap refuses a second review the person asks for under Guard Policy off";
const BLOCK_4 = "the second Unit's own files record a change to the first Unit's reviewed source, naming no path";

guardMatrixSuite("a plugin's scope with the guards off", [
  { cell: { policy: "off", review: "advisory", plan: "on" }, change: "later-unit-edit", options: { composed: pluginCell("team-flow", "off", "advisory") }, label: "on a plugin's scope", recordBlocked: BLOCK_4 },
  { cell: { policy: "off", review: "advisory", plan: "on" }, change: "hand-edit-source", options: { composed: pluginCell("team-flow", "off", "advisory") }, label: "on a plugin's scope", blocked: BLOCK_1 },
  { cell: { policy: "off", review: "advisory", plan: "on" }, change: "later-unit-edit-unclaimed", options: { composed: pluginCell("team-flow", "off", "advisory") }, label: "on a plugin's scope", blocked: BLOCK_1 },
  { cell: { policy: "off", review: "advisory", plan: "on" }, change: "second-review", options: { composed: pluginCell("team-flow", "off", "advisory") }, label: "on a plugin's scope", blocked: BLOCK_2 },
]);
