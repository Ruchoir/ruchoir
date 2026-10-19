import { registerRootComponent } from "expo";

// Android's notification task must be defined before anything else runs: a push can start the app
// with no screen at all (ADR 0006).
import "./src/push/background";
import App from "./src/App";
import { registerWidgets } from "./src/widgets";

registerRootComponent(App);
// The Android widgets are drawn by a task, the app not running (step 6e).
registerWidgets();
