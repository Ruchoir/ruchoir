import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { configureClient, resetClientForTests, setMyAvatar, startAttachmentUpload, startFileUpload, startFileVersionUpload, uploadFile, uploadFileVersion } from "../src/index.ts";
import { fakeFetch } from "./fakeFetch.ts";

/** Poll until `ready` holds: the in-memory path sends after an asynchronous flattening. */
async function waitFor(ready: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !ready(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(ready(), "timed out");
}

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

test("a_phone_file_name_goes_apart_so_spaces_stay_spaces", () => {
  // React Native writes the part's file name percent-encoded ("a%20b.pdf"): the name field is read first.
  startFileUpload("s1", { uri: "file:///x", name: "Devis client (1).pdf", type: "application/pdf" });
  assert.equal((FakeXhr.last.body as FormData).get("name"), "Devis client (1).pdf");
  startAttachmentUpload("c1", { uri: "file:///y", name: "photo de vacances.jpg", type: "image/jpeg" });
  assert.equal((FakeXhr.last.body as FormData).get("name"), "photo de vacances.jpg");
});

test("a_phone_photo_becomes_the_avatar_over_xhr", async () => {
  // `fetch` in an Expo app cannot send a file named by its path on the phone; XHR can.
  configureClient({ baseUrl: "https://a.test", authorization: () => "Bearer t1" });
  const pending = setMyAvatar({ uri: "file:///photo.jpg", name: "avatar.jpg", type: "image/jpeg" });
  const xhr = FakeXhr.last;
  assert.equal(xhr.method, "PUT");
  assert.equal(xhr.url, "https://a.test/api/v1/users/me/avatar");
  assert.equal(xhr.headers.authorization, "Bearer t1");
  xhr.answer(200, { url: "/api/v1/users/u1/avatar?v=2" });
  assert.equal(await pending, "/api/v1/users/u1/avatar?v=2");
});

test("in_memory_uploads_send_one_array_buffer_with_its_content_type", async () => {
  configureClient({ baseUrl: "https://a.test", authorization: () => "Bearer t1", inMemoryUploads: true });
  startAttachmentUpload("c1", new Blob(["hello"], { type: "text/plain" }));
  await waitFor(() => FakeXhr.last?.body !== undefined);
  assert.ok(FakeXhr.last.body instanceof ArrayBuffer);
  assert.match(FakeXhr.last.headers["Content-Type"], /^multipart\/form-data; boundary=/);
});

test("without_the_option_the_form_data_goes_as_it_is", () => {
  configureClient({ baseUrl: "https://a.test", authorization: () => "Bearer t1" });
  startAttachmentUpload("c1", new Blob(["hello"]));
  assert.ok(FakeXhr.last.body instanceof FormData);
  assert.equal(FakeXhr.last.headers["Content-Type"], undefined);
});

test("an_abort_while_preparing_sends_nothing", async () => {
  configureClient({ baseUrl: "https://a.test", inMemoryUploads: true });
  const request = startAttachmentUpload("c1", new Blob(["x"]));
  request.abort();
  await assert.rejects(request.done, { name: "AbortError" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(FakeXhr.last?.body, undefined);
});

test("in_memory_uploads_apply_to_the_fetch_uploads_too", async () => {
  configureClient({ baseUrl: "https://a.test", authorization: () => "Bearer t1", inMemoryUploads: true });
  const calls = fakeFetch({ body: { id: "f1", name: "a.txt", size_bytes: 1, kind: "file-text" } }, { body: { id: "f1", name: "a.txt", size_bytes: 1, kind: "file-text" } });
  await uploadFile("s1", new File(["a"], "a.txt"));
  await uploadFileVersion("f1", new File(["a"], "a.txt"));
  for (const call of calls) {
    assert.ok(call.init.body instanceof ArrayBuffer);
    const headers = new Headers(call.init.headers);
    assert.match(headers.get("content-type")!, /^multipart\/form-data; boundary=/);
    assert.equal(headers.get("authorization"), "Bearer t1");
  }
});
