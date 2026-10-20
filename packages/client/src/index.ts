/**
 * `@ruchoir/client`: what the web and mobile apps share to speak to the Ruchoir API.
 *
 * Each module is also reachable on its own path (`@ruchoir/client/api`, `/calendar`, `/types`,
 * `/http`, `/fileType`), which is how the web's `lib/data` facade re-exports them unchanged.
 */
export * from "./config.ts";
export * from "./http.ts";
export * from "./types.ts";
export * from "./api.ts";
export * from "./calendar.ts";
export * from "./fileType.ts";
export * from "./client.ts";
