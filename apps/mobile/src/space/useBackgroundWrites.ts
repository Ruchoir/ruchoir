import { backgroundWritesAllowed } from "../logic/preview";
import { useSpace } from "./SpaceProvider";

/** Whether the app may write on its own account here: never while the space is looked at as a role. */
export function useBackgroundWrites(): boolean {
  return backgroundWritesAllowed(useSpace().current);
}
