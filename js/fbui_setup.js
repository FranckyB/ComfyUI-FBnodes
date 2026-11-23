// Shared look for FBnodes: node colours, the kit stylesheet, and graph
// zoom/drop over our panels. See docs/UI_RULES.md.
import { installAppearance } from "./fbui/appearance.mjs";
import { installPassthrough } from "./fbui/passthrough.mjs";
import { ensureKitCss } from "./fbui/theme.mjs";

installAppearance({ settingsPrefix: "FBnodes", category: "FBnodes" });
ensureKitCss();
installPassthrough();
