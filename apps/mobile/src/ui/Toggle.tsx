import { Switch, type SwitchProps } from "react-native";

import { useTheme } from "../theme/useTheme";

/**
 * The design system's switch: on in ink by day; by night the ink turns pale like the knob, so it is on
 * in the accent there, or the knob would vanish into its track.
 */
export function Toggle(props: Omit<SwitchProps, "trackColor">) {
  const { c, s, dark } = useTheme();
  return <Switch {...props} trackColor={{ true: dark ? c.acc : c.ink, false: s.sunken }} />;
}
