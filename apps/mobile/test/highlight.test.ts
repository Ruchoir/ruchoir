import { test } from "node:test";
import assert from "node:assert/strict";

import { highlight, runsFromHtml } from "../src/logic/highlight.ts";

test("spans_become_runs_with_their_tone", () => {
  assert.deepEqual(runsFromHtml('<span class="hljs-keyword">let</span> x = <span class="hljs-number">1</span>;'), [
    { text: "let", tone: "keyword" },
    { text: " x = ", tone: "plain" },
    { text: "1", tone: "number" },
    { text: ";", tone: "plain" },
  ]);
});

test("entities_are_read_back", () => {
  assert.deepEqual(runsFromHtml("a &lt; b &amp;&amp; c"), [{ text: "a < b && c", tone: "plain" }]);
});

test("a_class_title_reads_as_a_type", () => {
  assert.deepEqual(runsFromHtml('<span class="hljs-title class_">Foo</span>'), [{ text: "Foo", tone: "type" }]);
});

test("the_whole_code_is_kept", () => {
  const code = "fn main() {\n    println!(\"hi\");\n}";
  const { runs, language } = highlight(code, "rust");
  assert.equal(runs.map((r) => r.text).join(""), code);
  assert.equal(language, "rust");
});
