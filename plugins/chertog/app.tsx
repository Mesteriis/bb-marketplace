// Chertog — BB frontend entry.
//
// Compiled by `bb plugin build` into dist/app.js. React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time. This file
// only composes: everything it registers lives in src/adapters/bb/app.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { registerChertogApp } from "./src/adapters/bb/index.ts";

export default definePluginApp(registerChertogApp);
