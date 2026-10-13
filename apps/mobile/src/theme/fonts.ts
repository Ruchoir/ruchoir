/**
 * IBM Plex, embedded in the app (OFL 1.1, see `assets/fonts/OFL.txt`), as the web self-hosts it.
 *
 * React Native picks a face by family name rather than by weight, so each weight is its own family.
 */
export const fontFiles = {
  "IBMPlexSans-Regular": require("../../assets/fonts/IBMPlexSans-Regular.ttf"),
  "IBMPlexSans-Medium": require("../../assets/fonts/IBMPlexSans-Medium.ttf"),
  "IBMPlexSans-SemiBold": require("../../assets/fonts/IBMPlexSans-SemiBold.ttf"),
  "IBMPlexSans-Bold": require("../../assets/fonts/IBMPlexSans-Bold.ttf"),
  "IBMPlexMono-Regular": require("../../assets/fonts/IBMPlexMono-Regular.ttf"),
  "IBMPlexMono-SemiBold": require("../../assets/fonts/IBMPlexMono-SemiBold.ttf"),
};

export const fonts = {
  sans: "IBMPlexSans-Regular",
  sansMedium: "IBMPlexSans-Medium",
  sansSemibold: "IBMPlexSans-SemiBold",
  sansBold: "IBMPlexSans-Bold",
  mono: "IBMPlexMono-Regular",
  monoSemibold: "IBMPlexMono-SemiBold",
} as const;
