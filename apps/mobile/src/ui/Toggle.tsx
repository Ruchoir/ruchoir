import { Switch, type SwitchProps } from "react-native";

import { useTheme } from "../theme/useTheme";
import { feel } from "./haptics";

/**
 * The design system's switch: on in ink by day; by night the ink turns pale like the knob, so it is on
 * in the accent there, or the knob would vanish into its track. It feels like the system's switch on
 * Android too (on iOS `UISwitch` plays that itself).
 */
export function Toggle({ onValueChange, ...props }: Omit<SwitchProps, "trackColor">) {
  const { c, s, dark } = useTheme();
  return (
    <Switch
      {...props}
      onValueChange={
        onValueChange
          ? (next) => {
              feel(next ? "toggleOn" : "toggleOff");
              return onValueChange(next);
            }
          : undefined
      }
      trackColor={{ true: dark ? c.acc : c.ink, false: s.sunken }}
    />
  );
}
