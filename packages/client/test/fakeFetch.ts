// A stand-in for `fetch` that records each request and answers from a queue, so the tests assert on
// what actually leaves the client rather than on a mock's bookkeeping.

export type Call = { url: string; init: RequestInit };

export function fakeFetch(...answers: { status?: number; body?: unknown }[]): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    const answer = answers.shift() ?? { status: 204 };
    const status = answer.status ?? 200;
    const text = answer.body === undefined ? null : JSON.stringify(answer.body);
    return new Response(status === 204 ? null : text, { status });
  }) as typeof fetch;
  return calls;
}

export function header(call: Call, name: string): string | null {
  return new Headers(call.init.headers).get(name);
}
