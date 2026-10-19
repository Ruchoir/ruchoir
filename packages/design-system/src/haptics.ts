/**
 * A short tap felt under the finger, for the moments a touch screen gives no other feedback: a press
 * held long enough, a sheet let go past its threshold.
 *
 * Android has the Vibration API. Safari on iOS has none, but since iOS 18 toggling a `switch`
 * checkbox plays the system's own light tap, so a hidden one is toggled instead. Both do nothing on a
 * device without them (a desktop, an older iPhone), which is the right answer there.
 */

let iosSwitch: HTMLLabelElement | null = null;

function iosTap() {
  if (!iosSwitch) {
    const label = document.createElement("label");
    label.setAttribute("aria-hidden", "true");
    label.style.cssText = "position:fixed;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;left:-9999px";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.setAttribute("switch", "");
    input.tabIndex = -1;
    label.appendChild(input);
    document.body.appendChild(label);
    iosSwitch = label;
  }
  iosSwitch.click();
}

export type HapticKind = "light" | "medium";

export function haptic(kind: HapticKind = "light") {
  if (typeof window === "undefined") return;
  if (typeof navigator.vibrate === "function") {
    navigator.vibrate(kind === "medium" ? 15 : 8);
    return;
  }
  if (window.matchMedia?.("(pointer: coarse)").matches) iosTap();
}
