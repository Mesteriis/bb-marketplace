// Chertog BB adapters: BB's implementations of what the core and the UI
// need from a host. `app` is the window side (the route, the live layer, the
// providers of stage A), `home` the redirect of the stock Home, `server` the
// workspace store and its RPC. The server entry imports `./server/index.ts`
// directly: this module is the window's and pulls in the frontend SDK.
export { CHERTOG_PANEL_PATH, registerChertogApp } from "./app/index.ts";
