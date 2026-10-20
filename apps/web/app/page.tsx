import { AppRoot } from "@/features/app/AppRoot";
import { DesktopEntry } from "@/features/desktop/DesktopEntry";
import { isDesktop } from "@/lib/desktop/runtime";

/**
 * The application shell. The desktop app's build (`build:desktop`) renders the desktop root, with
 * its title bar and instance screens, around the same interface; the web build drops it entirely.
 */
export default function Home() {
  return isDesktop ? <DesktopEntry /> : <AppRoot />;
}
