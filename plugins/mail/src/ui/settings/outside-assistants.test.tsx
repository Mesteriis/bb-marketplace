// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PAGE_SETTING_DEFAULTS } from "../../core/page-settings.ts";
import { OutsideAssistants } from "./outside-assistants.tsx";
import type { PageSettingsPort } from "./setting-controls.tsx";

installTestPluginRuntime();
afterEach(cleanup);

function port(mcpAccess: boolean) {
  const save = vi.fn(async () => ({ ok: true as const }));
  const made: PageSettingsPort = { values: { ...PAGE_SETTING_DEFAULTS, mcpAccess }, save };
  return { port: made, save };
}

describe("OutsideAssistants", () => {
  it("shows the switch as read-only, off by default, with the way to turn it on and the assistant's configuration", () => {
    const { port: p, save } = port(false);
    render(<OutsideAssistants port={p} saveServerFile={async () => true} />);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText("Search and read mail through the local MCP server").closest("div")!.parentElement!.textContent).toContain("Off");
    expect(screen.getByText(/bb plugin config makosh-mail set mcpAccess true/)).toBeTruthy();
    expect(screen.getByText(/"command": "node"/).textContent).toContain('"args": ["/path/to/makosh-mail-mcp.mjs"]');
    expect(save).not.toHaveBeenCalled();
  });

  it("Save the server file calls the port once and says where the path goes; a failure is said", async () => {
    const saveServerFile = vi.fn<() => Promise<boolean>>().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    render(<OutsideAssistants port={port(true).port} saveServerFile={saveServerFile} />);
    fireEvent.click(screen.getByRole("button", { name: "Save the server file…" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Saved. Put the file's path into the assistant's configuration below."));
    fireEvent.click(screen.getByRole("button", { name: "Save the server file…" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("The file could not be saved."));
    expect(saveServerFile).toHaveBeenCalledTimes(2);
  });

  it("without a way to save files there is no button", () => {
    render(<OutsideAssistants port={port(true).port} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
