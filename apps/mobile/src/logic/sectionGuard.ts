/**
 * What a section's screen does about the caller's right to be there. Only a known answer sends back:
 * while the space or the instance's features are still loading, the screen waits (neither leaves nor
 * shows the legacy sections). Pure, tested by Node.
 */
export type GuardDecision = "wait" | "stay" | "leave";

export function guardDecision(input: { known: boolean; ready: boolean; allowed: boolean }): GuardDecision {
  if (!input.known || !input.ready) return "wait";
  return input.allowed ? "stay" : "leave";
}

type GateView = { invite: boolean; managePeople: boolean; setDefaultChannel: boolean };

/** The member screen's doors: the permission when the instance has them, the legacy role rule otherwise. */
export function memberDoors(supported: boolean, gates: GateView, legacyAdmin: boolean) {
  return {
    invite: supported ? gates.invite : legacyAdmin,
    changeRole: supported ? gates.managePeople : legacyAdmin,
    defaultChannel: supported ? gates.setDefaultChannel : legacyAdmin,
  };
}
