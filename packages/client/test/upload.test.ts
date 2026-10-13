import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { configureClient, resetClientForTests, startAttachmentUpload } from "../src/index.ts";

/** A stand-in for XMLHttpRequest that records what is sent and answers when told to. */
class FakeXhr {
  static last: FakeXhr;
  method = "";
  url = "";
  headers: Record<string, string> = {};
  body: unknown;
  status = 0;
  responseText = "";
  withCredentials = false;
  upload: { onprogress?: (e: { loaded: number }) => void } = {};
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: unknown) {
    this.body = body;
  }
  abort() {
    this.onabort?.();
  }
  answer(status: number, json: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(json);
    this.onload?.();
  }
}

beforeEach(() => {
  resetClientForTests();
  (globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeXhr;
});

test("an_upload_goes_to_the_conversation_with_the_bearer", async () => {
  configureClient({ baseUrl: "https://a.test", authorization: () => "Bearer t1" });
  const request = startAttachmentUpload("c1", new Blob(["hello"], { type: "text/plain" }));
  const xhr = FakeXhr.last;
  assert.equal(xhr.method, "POST");
  assert.equal(xhr.url, "https://a.test/api/v1/conversations/c1/attachments");
  assert.equal(xhr.headers.authorization, "Bearer t1");
  assert.equal(xhr.withCredentials, false);
  xhr.answer(201, { id: "f1", name: "hello.txt", size_bytes: 5, kind: "file-text" });
  const attachment = await request.done;
  assert.equal(attachment.fileId, "f1");
});

test("an_upload_reports_its_progress", () => {
  const seen: number[] = [];
  startAttachmentUpload("c1", new Blob(["x"]), (sent) => seen.push(sent));
  FakeXhr.last.upload.onprogress?.({ loaded: 42 });
  assert.deepEqual(seen, [42]);
});

test("a_refused_upload_rejects_with_its_status", async () => {
  const request = startAttachmentUpload("c1", new Blob(["x"]));
  FakeXhr.last.answer(413, { error: "too_large" });
  await assert.rejects(request.done, (err: { status: number }) => err.status === 413);
});
