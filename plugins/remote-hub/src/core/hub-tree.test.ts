import { describe, expect, it } from "vitest";
import { buildTree, type TreeGuest, type TreeInput } from "./hub-tree.ts";

const guest = (vmid: number, name: string, kind: "lxc" | "qemu", status = "running", extra: Partial<TreeGuest> = {}): TreeGuest => ({ vmid, name, kind, node: "pve", status, template: false, available: status === "running", ...extra });

const input = (over: Partial<TreeInput> = {}): TreeInput => ({
  profiles: [
    { id: "pve1", name: "Proxmox", protocol: "pve", group: null, detail: "remotehub@pve@10.34.10.2" },
    { id: "s1", name: "rdp-ssh-test", protocol: "ssh", group: "Стенд", detail: "tester@10.34.10.65" },
    { id: "r1", name: "win-test", protocol: "rdp", group: "Стенд", detail: "admin@10.34.10.70" },
  ],
  connections: {
    pve1: { outcome: "ok", nodes: ["pve"], guests: [guest(110, "db", "lxc"), guest(111, "omw", "qemu"), guest(152, "astra-linux", "qemu", "stopped"), guest(165, "rdp-ssh-test", "lxc"), guest(9000, "svc-template", "lxc", "stopped", { template: true })] },
  },
  expanded: ["pve1"],
  query: "",
  filter: "all",
  ...over,
});

const shape = (rows: ReturnType<typeof buildTree>) => rows.map((r) => (r.type === "group" ? `# ${r.title} (${r.count})` : r.type === "profile" ? `${r.name} [${r.protocol}]${r.guestCount === null ? "" : " " + r.guestCount}` : r.type === "node" ? `  node ${r.node}` : r.type === "guest" ? `  ${r.name} ${r.kind} ${r.vmid}${r.available ? "" : " off"}` : `  ! ${r.outcome}`));

describe("buildTree", () => {
  it("lists ungrouped connections first, then each group by name, with a Proxmox connection's node and guests under it", () => {
    expect(shape(buildTree(input()))).toEqual([
      "# null (1)",
      "Proxmox [pve] 5",
      "  node pve",
      "  db lxc 110",
      "  omw qemu 111",
      "  astra-linux qemu 152 off",
      "  rdp-ssh-test lxc 165",
      "  svc-template lxc 9000 off",
      "# Стенд (2)",
      "rdp-ssh-test [ssh]",
      "win-test [rdp]",
    ]);
  });

  it("a collapsed Proxmox connection shows only its row and its guest count", () => {
    expect(shape(buildTree(input({ expanded: [] })))).toEqual(["# null (1)", "Proxmox [pve] 5", "# Стенд (2)", "rdp-ssh-test [ssh]", "win-test [rdp]"]);
  });

  it("the running filter keeps the node and the running guests", () => {
    expect(shape(buildTree(input({ filter: "running" }))).slice(0, 6)).toEqual(["# null (1)", "Proxmox [pve] 5", "  node pve", "  db lxc 110", "  omw qemu 111", "  rdp-ssh-test lxc 165"]);
  });

  it("the LXC and VM filters keep only that kind and drop the node shell", () => {
    expect(shape(buildTree(input({ filter: "lxc" }))).slice(1, 5)).toEqual(["Proxmox [pve] 5", "  db lxc 110", "  rdp-ssh-test lxc 165", "  svc-template lxc 9000 off"]);
    expect(shape(buildTree(input({ filter: "qemu" }))).slice(1, 4)).toEqual(["Proxmox [pve] 5", "  omw qemu 111", "  astra-linux qemu 152 off"]);
  });

  it("a search matches connection names and guests by name or VMID, opens the Proxmox connection it finds guests in, and drops empty groups", () => {
    expect(shape(buildTree(input({ expanded: [], query: "RDP-ssh" })))).toEqual(["# null (1)", "Proxmox [pve] 5", "  rdp-ssh-test lxc 165", "# Стенд (1)", "rdp-ssh-test [ssh]"]);
    expect(shape(buildTree(input({ expanded: [], query: "152" })))).toEqual(["# null (1)", "Proxmox [pve] 5", "  astra-linux qemu 152 off"]);
    expect(shape(buildTree(input({ query: "nothing-like-this" })))).toEqual([]);
  });

  it("a connection that could not be read shows its outcome instead of guests", () => {
    const rows = buildTree(input({ connections: { pve1: { outcome: "keychain_needs_approval", nodes: [], guests: [] } } }));
    expect(shape(rows).slice(0, 3)).toEqual(["# null (1)", "Proxmox [pve] 0", "  ! keychain_needs_approval"]);
  });

  it("a Proxmox connection whose guests were not read yet has no count", () => {
    expect(shape(buildTree(input({ connections: {}, expanded: [] }))).slice(0, 2)).toEqual(["# null (1)", "Proxmox [pve]"]);
  });
});
