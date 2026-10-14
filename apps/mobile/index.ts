import { registerRootComponent } from "expo";

// Android's notification task must be defined before anything else runs: a push can start the app
// with no screen at all (ADR 0006).
import "./src/push/background";
import App from "./src/App";

registerRootComponent(App);
