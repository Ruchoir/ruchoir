/**
 * A client for one instance, for an app that talks to several at once (the phone and desktop apps).
 *
 * Each client holds its own options (address, bearer, socket factory, what a 401 does) and every
 * call bound to them, so a request started for one instance always finishes there, with that
 * instance's token, whatever another client does meanwhile. The web never builds one: it uses the
 * module-level calls, which are the default client's (see `configureClient`).
 */
import { createApi } from "./api.ts";
import { createCalendarApi } from "./calendar.ts";
import { withOptions, type ClientOptions } from "./config.ts";
import { makeTransport, type Transport } from "./http.ts";

export type RuchoirClient = ReturnType<typeof createApi> &
  ReturnType<typeof createCalendarApi> &
  Pick<Transport, "apiBase" | "apiOrigin" | "absoluteUrl" | "authInit"> & {
    /** This client's options, as they stand now. */
    options: () => ClientOptions;
    /** Change some of this client's options; the others keep their value. */
    configure: (patch: Partial<ClientOptions>) => void;
  };

/** A client for the instance at `options.baseUrl`, the defaults filling what is left out. */
export function createClient(options: Partial<ClientOptions> & { baseUrl: string }): RuchoirClient {
  let current = withOptions(options);
  const transport = makeTransport(() => current);
  return {
    ...createApi(transport),
    ...createCalendarApi(transport),
    apiBase: transport.apiBase,
    apiOrigin: transport.apiOrigin,
    absoluteUrl: transport.absoluteUrl,
    authInit: transport.authInit,
    options: () => current,
    configure: (patch) => {
      current = withOptions(patch, current);
    },
  };
}
