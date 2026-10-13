// Expo's own flat config (React, hooks, TypeScript, import rules), as the web uses Next's.
import expo from "eslint-config-expo/flat.js";

export default [
  ...expo,
  { ignores: ["dist-check/**", ".expo/**"] },
];
