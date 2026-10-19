import { NativeHandoffScreen } from "@/features/auth/NativeHandoffScreen";

/**
 * The page the phone app opens to sign in or to add a passkey (`/n/?c=…` or `/n/?h=…`, ADR 0005):
 * a page of its own, exported like the others, so it loads none of the app.
 */
export default function NativeHandoff() {
  return <NativeHandoffScreen />;
}
