import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { configureClient, resetClientForTests, startAttachmentUpload, startFileUpload, startFileVersionUpload } from "../src/index.ts";

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

test("file_upload_sends_the_part_and_folder_id", async () => {
  configureClient({ baseUrl: "https://a.test", authorization: () => "Bearer t1" });
  const part = { uri: "file:///photo.jpg", name: "photo.jpg", type: "image/jpeg" };
  const request = startFileUpload("s1", part, "f1");
  const xhr = FakeXhr.last;
  assert.equal(xhr.method, "POST");
  assert.equal(xhr.url, "https://a.test/api/v1/spaces/s1/files");
  assert.equal(xhr.headers.authorization, "Bearer t1");
  const form = xhr.body as FormData;
  assert.equal(form.get("folder_id"), "f1");
  assert.ok(form.has("file"));
  xhr.answer(201, { id: "n1", name: "photo.jpg", size_bytes: 5, kind: "image", is_folder: false });
  const file = await request.done;
  assert.equal(file.id, "n1");
  assert.equal(file.name, "photo.jpg");
});

test("file_upload_reports_progress", () => {
  const seen: number[] = [];
  startFileUpload("s1", new Blob(["x"]), undefined, (sent) => seen.push(sent));
  FakeXhr.last.upload.onprogress?.({ loaded: 7 });
  assert.deepEqual(seen, [7]);
  assert.equal((FakeXhr.last.body as FormData).has("folder_id"), false);
});

test("file_upload_413_rejects_with_its_status", async () => {
  const request = startFileUpload("s1", new Blob(["x"]));
  FakeXhr.last.answer(413, { error: "too_large" });
  await assert.rejects(request.done, (err: { status: number }) => err.status === 413);
});

test("version_upload_goes_to_the_file", async () => {
  configureClient({ baseUrl: "https://a.test", authorization: () => "Bearer t1" });
  const request = startFileVersionUpload("f9", { uri: "file:///devis.pdf", name: "devis.pdf", type: "application/pdf" });
  const xhr = FakeXhr.last;
  assert.equal(xhr.method, "POST");
  assert.equal(xhr.url, "https://a.test/api/v1/files/f9/versions");
  assert.equal(xhr.headers.authorization, "Bearer t1");
  assert.ok((xhr.body as FormData).has("file"));
  xhr.answer(201, { id: "f9", name: "devis.pdf", size_bytes: 9, kind: "file-text", is_folder: false, version_no: 2 });
  const file = await request.done;
  assert.equal(file.id, "f9");
});

test("version_upload_reports_progress", () => {
  const seen: number[] = [];
  startFileVersionUpload("f9", new Blob(["x"]), (sent) => seen.push(sent));
  FakeXhr.last.upload.onprogress?.({ loaded: 3 });
  assert.deepEqual(seen, [3]);
});
