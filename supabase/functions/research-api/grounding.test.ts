// Run: npm run test:edge   (Node 22+ runs TypeScript directly)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  enforceGrounding,
  extractCitations,
  NOTHING_LEFT,
  splitSentences,
  type GroundingSource,
} from "./grounding.ts";

const S1: GroundingSource = {
  id: "S1",
  title: "Contract Case List 2024.md",
  snippet:
    "In Bhasin v Hrynew, 2014 SCC 71, the Court recognized a general organizing principle of good faith, " +
    "and a duty of honest performance in contractual dealings. See also RSO 1990, c L.7.",
};
const S2: GroundingSource = {
  id: "S2",
  title: "Constitutional Law Case List 2024.md",
  snippet: "R. v. Jordan, 2016 SCC 27 set presumptive ceilings for delay: 18 months in provincial court.",
};

test("keeps citations that are in the sources, removes ones that are not", () => {
  const answer =
    "Canadian law recognizes a duty of honest performance (Bhasin v Hrynew, 2014 SCC 71) [S1]. " +
    "This was extended to the exercise of contractual rights in Callow v Zollinger, 2020 SCC 45 [S1]. " +
    "It also applies to discretionary powers per Wastech Services v Greater Vancouver Sewerage, 2021 SCC 7 [S1].";
  const r = enforceGrounding(answer, [S1]);

  assert.equal(
    r.text,
    "Canadian law recognizes a duty of honest performance (Bhasin v Hrynew, 2014 SCC 71) [S1].",
  );
  assert.equal(r.removed.length, 2);
  assert.match(r.removed[0].reason, /does not appear in your documents/);
  const grounded = Object.fromEntries(r.citations.map((c) => [c.text, c.grounded]));
  assert.equal(grounded["2014 SCC 71"], true);
  assert.equal(grounded["Bhasin v Hrynew"], true);
  assert.equal(grounded["2020 SCC 45"], false);
  assert.equal(grounded["Callow v Zollinger"], false);
});

test("citation matching ignores punctuation style differences", () => {
  // Source writes "R. v. Jordan"; answer writes "R v Jordan". Statute dotted vs undotted.
  const r = enforceGrounding(
    "Delay ceilings come from R v Jordan, 2016 SCC 27 [S2]. The statute is R.S.O. 1990, c. L.7 [S1].",
    [S1, S2],
  );
  assert.equal(r.removed.length, 0, JSON.stringify(r.removed));
  assert.ok(r.citations.every((c) => c.grounded), JSON.stringify(r.citations));
});

test("removes sentences quoting text that is not in any source", () => {
  const answer =
    'The Court said there is "a duty of honest performance in contractual dealings" [S1]. ' +
    'It added that "parties must always disclose every material fact to each other" [S1].';
  const r = enforceGrounding(answer, [S1]);
  assert.equal(r.removed.length, 1);
  assert.match(r.removed[0].sentence, /disclose every material fact/);
  assert.match(r.text, /honest performance in contractual dealings/);
});

test("quote check tolerates ellipses, bracketed edits, curly quotes and case", () => {
  const answer =
    "The Court found “a general organizing principle of good faith … [and] a duty of honest performance” [S1].";
  const r = enforceGrounding(answer, [S1]);
  assert.equal(r.removed.length, 0, JSON.stringify(r.removed));
});

test("removes claims tagged only with sources that do not exist; strips stray tags", () => {
  const r = enforceGrounding("Claim A [S9]. Claim B [S1][S9]. Claim C [S1, S7].", [S1]);
  assert.deepEqual(r.removed.map((x) => x.sentence), ["Claim A [S9]."]);
  assert.equal(r.text, "Claim B [S1]. Claim C [S1].");
});

test("verifies supporting quotes against the specific source they cite", () => {
  const r = enforceGrounding("x", [S1, S2], [
    { source: "S1", text: "a duty of honest performance in contractual dealings" },
    { source: "S1", text: "set presumptive ceilings for delay" }, // actually in S2
    { source: "S2", text: "judges may ignore delay whenever they like" }, // invented
    { source: "S1", text: "good faith" }, // too short to count as evidence
  ]);
  assert.deepEqual(
    r.quotes.map((q) => [q.status, q.foundIn ?? null]),
    [["verified", null], ["misattributed", "S2"], ["not_found", null]],
  );
});

test("list items: drops the failing item, keeps the rest", () => {
  const answer = "Key cases:\n- Bhasin v Hrynew, 2014 SCC 71 [S1]\n- Callow v Zollinger, 2020 SCC 45 [S1]";
  const r = enforceGrounding(answer, [S1]);
  assert.equal(r.text, "Key cases:\n- Bhasin v Hrynew, 2014 SCC 71 [S1]");
});

test("if every sentence fails, says so instead of returning nothing", () => {
  const r = enforceGrounding("Callow v Zollinger, 2020 SCC 45 governs this [S1].", [S1]);
  assert.equal(r.text, NOTHING_LEFT);
});

test("non-citation numbers are not treated as citations", () => {
  const cites = extractCitations("In 2024 USD 500 was paid. The 2023 COVID 19 rules ended.");
  assert.deepEqual(cites, []);
});

test("sentence splitter respects legal abbreviations and quotes", () => {
  assert.deepEqual(splitSentences("See R. v. Jordan, [2016] 1 S.C.R. 631 at para. 5. Next sentence."), [
    "See R. v. Jordan, [2016] 1 S.C.R. 631 at para. 5.",
    "Next sentence.",
  ]);
  assert.deepEqual(splitSentences('He said "Stop. Now." Then left.'), ['He said "Stop. Now."', "Then left."]);
});
