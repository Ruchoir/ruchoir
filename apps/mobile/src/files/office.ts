/**
 * What the instance's office editor opens, if it has one (`getInstanceCapabilities().office`), and
 * what it does with a given file: the web's `officeActionFor`.
 */
import { getInstanceCapabilities, officeActionFor, type OfficeCapabilities } from "@ruchoir/client";

import { useLoad } from "../data/useLoad";

/** The editor's capabilities when it is on, else null (also while they load). */
export function useOffice(): OfficeCapabilities | null {
  const caps = useLoad("capabilities", (signal) => getInstanceCapabilities(signal));
  return caps.data?.office.enabled ? caps.data.office : null;
}

/** "edit", "convert" (a legacy format made into an editable copy) or nothing, for a file. */
export function editAction(name: string, office: OfficeCapabilities | null): "edit" | "convert" | null {
  const action = officeActionFor(name, office);
  return action === "edit" || action === "convert" ? action : null;
}
