/**
 * A multipart form flattened into one in-memory buffer.
 *
 * The desktop app's webview reaches the network through a custom protocol that drops the file-backed
 * parts of a multipart body (WebView2 and WebKit alike): the request leaves with the fields but an
 * empty file, and the server stores nothing. A body that is a single `ArrayBuffer` crosses that
 * protocol intact, so the client can be asked (`inMemoryUploads`, `config.ts`) to serialise the form
 * itself before sending. The browser and the phone never need this and keep sending the `FormData`
 * as it is.
 */

/**
 * Serialise `form` the way the platform would put it on the wire, and return the bytes with the
 * `Content-Type` header that names their boundary. The caller must send that header as is: the
 * boundary is chosen here, so a different one would make the body unreadable.
 *
 * Costs the whole file in memory, which is why it is opt-in.
 */
export async function multipartBody(form: FormData): Promise<{ body: ArrayBuffer; contentType: string }> {
  const response = new Response(form);
  return { body: await response.arrayBuffer(), contentType: response.headers.get("content-type")! };
}
