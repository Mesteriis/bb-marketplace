import { z } from "zod";
import { providerKind } from "./providers.ts";

export const connectionInput = z.object({
  kind:providerKind,
  origin:z.url().max(300),
  organization:z.string().trim().max(100),
  label:z.string().trim().min(1).max(80),
  username:z.string().trim().max(128),
  token:z.string().min(1).max(4096).regex(/^[^\s\x00-\x1f\x7f]+$/),
});
export type ConnectionInput = z.infer<typeof connectionInput>;
export const connectionCheck = z.object({
  username:z.string(), repositories:z.array(z.string()), hasMore:z.boolean(),
});
export type ConnectionCheck = z.infer<typeof connectionCheck>;

export function detectProvider(input:string) {
  const value = input.trim();
  if (!value || value.length > 1000 || /[\s\\]/.test(value)) return null;
  const scp = /^git@([\w.-]+):([^?#]+)$/.exec(value);
  try {
    const url = new URL(scp ? "https://" + scp[1] + "/" + scp[2] : value.includes("://") ? value : "https://" + value);
    const ssh = url.protocol === "ssh:" && url.username === "git" && !url.password;
    if ((!ssh && url.protocol !== "https:") || (!ssh && url.username) || url.password || url.search || url.hash) return null;
    const origin = ssh ? "https://" + url.hostname : url.origin;
    const host = url.hostname;
    if (url.port && ["github.com","api.github.com","dev.azure.com","ssh.dev.azure.com","gitea.com"].includes(host)) return null;
    if (host === "github.com" || host === "api.github.com") return {kind:"github" as const,origin,organization:""};
    if (host === "dev.azure.com" || host === "ssh.dev.azure.com") {
      const parts = url.pathname.split("/").filter(Boolean);
      return {kind:"azure" as const,origin:"https://dev.azure.com",organization:parts[parts[0] === "v3" ? 1 : 0] ?? ""};
    }
    if (host === "gitea.com") return {kind:"gitea" as const,origin,organization:""};
    return {kind:null,origin,organization:""};
  } catch { return null; }
}
