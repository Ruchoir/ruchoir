// Expo's Metro configuration, which knows the pnpm workspace on its own (SDK 52 and later): it
// watches the repository root and resolves `@ruchoir/client` from its source.
const { getDefaultConfig } = require("expo/metro-config");

module.exports = getDefaultConfig(__dirname);
