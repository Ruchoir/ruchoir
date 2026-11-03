import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { createClient, resetClientForTests } from "../src/index.ts";
import { fakeFetch } from "./fakeFetch.ts";

beforeEach(() => resetClientForTests());

const session = {
  file: { id: "f1", space_id: "s1", name: "plan.docx", kind: "file", size_bytes: 1, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
  url: "https://office.test/x",
  access_token: "t",
  access_token_ttl: 1,
  mode: "edit",
  config: "{}",
  member_name: "Alice",
};

test("an_office_session_sends_the_embedding_origin_only_when_given", async () => {
  const calls = fakeFetch({ body: session }, { body: session });
  const client = createClient({ baseUrl: "https://a.test" });
  await client.openOfficeSession("f1", { theme: "light", embedOrigin: "ruchoir-app://localhost" });
  await client.openOfficeSession("f1", { theme: "light" });
  const first = JSON.parse(String(calls[0].init.body));
  const second = JSON.parse(String(calls[1].init.body));
  assert.equal(first.embed_origin, "ruchoir-app://localhost");
  assert.equal("embed_origin" in second, false);
});
