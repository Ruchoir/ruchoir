/**
 * The design-system components, as the app imports them (`@/components/ds`).
 *
 * The components live in `packages/design-system` (`@ruchoir/design-system`), shared with Ruchoir
 * Lab; this file re-exports them so the app's imports stay short. `FileIcon` stays here: it draws the
 * file families of the app's own Drive, which nothing outside the app has.
 */
export * from "@ruchoir/design-system";
export { FileIcon } from "./FileIcon";
export type { FileIconProps } from "./FileIcon";
