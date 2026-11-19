// The plugin API: the only methods another plugin's server may call.
// Everything else in the contract refuses a plugin caller (the guard in
// src/adapters/bb/plugin-guard.ts); these are reached only with the owner's
// grant. A change that breaks a caller raises the version.

export const PLUGIN_API_VERSION = 1;

/** A plugin caller on a method outside the plugin API. */
export const PLUGIN_CALLER_MESSAGE = "Other plugins reach Makosh Mail only through its plugin API";

/** Methods a plugin caller may reach, each through the grant check. */
export const PLUGIN_API_METHODS: readonly string[] = [];
