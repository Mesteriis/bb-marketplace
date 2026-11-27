import type { Scaffold } from "../../core/scaffolds/model.ts";
import { bbPlugin } from "./bb-plugin.ts";
import { goServiceWithWeb } from "./go-service-with-web.ts";
import { pythonServiceUv } from "./python-service-uv.ts";

/** The plugin's own scaffolds, versioned with it (design §13.4 and §13.5). */
export const builtinScaffolds: Scaffold[] = [pythonServiceUv, goServiceWithWeb, bbPlugin];
