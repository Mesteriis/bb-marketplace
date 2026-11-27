export function callerNamespace(caller: { kind: "client" } | { kind: "plugin"; pluginId: string }): string {
  if (caller.kind !== "plugin") throw new Error("Plugin backend required");
  return caller.pluginId;
}
