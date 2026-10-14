/**
 * The phone's own document scanner (step 6c): Apple's VisionKit on an iPhone, Google's ML Kit scanner
 * on Android (through Google Play services), both finding the page's edges and straightening it,
 * page after page. `react-native-document-scanner-plugin` bridges them.
 *
 * Reached only where its native module is present: Expo Go has none, and importing the library
 * there throws at once. Where it is missing, or fails (an Android phone without Google Play
 * services), the scan screen takes photos instead, as it did before.
 */
import { TurboModuleRegistry } from "react-native";

export function hasDocumentScanner(): boolean {
  return TurboModuleRegistry.get("DocumentScanner") != null;
}

/** The pages scanned, as file URIs; none when the person cancelled; null when the scanner could not run. */
export async function scanDocument(): Promise<string[] | null> {
  if (!hasDocumentScanner()) return null;
  try {
    // Loaded here, on demand, rather than imported at the top, for the reason above.
    const { default: scanner } = await import("react-native-document-scanner-plugin");
    const result = await scanner.scanDocument({ croppedImageQuality: 85 });
    if (result.status !== "success") return [];
    return (result.scannedImages ?? []).map((path) => (path.startsWith("/") ? `file://${path}` : path));
  } catch {
    return null;
  }
}
