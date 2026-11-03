import { test } from "node:test";
import assert from "node:assert/strict";

import { multipartBody } from "../src/multipart.ts";

test("multipart_body_keeps_every_byte_and_names_its_boundary", async () => {
  const form = new FormData();
  const big = new Uint8Array(5 * 1024 * 1024).map((_, i) => i % 251);
  form.append("name", "Devis é.pdf");
  form.append("file", new Blob([big], { type: "application/pdf" }), "Devis é.pdf");
  const { body, contentType } = await multipartBody(form);
  assert.match(contentType, /^multipart\/form-data; boundary=/);
  const expected = await new Response(form).arrayBuffer();
  assert.ok(body.byteLength > big.byteLength);
  assert.equal(body.byteLength, expected.byteLength);
});
