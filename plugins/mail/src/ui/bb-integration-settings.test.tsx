// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it } from "vitest";
import { BbIntegrationSettings, folderProblem } from "./bb-integration-settings.tsx";
import { fakeCall } from "./testing/bb-fixtures.ts";

installTestPluginRuntime();
afterEach(cleanup);

describe("BbIntegrationSettings", () => {
  it("says why a folder setting is not used", () => {
    expect(folderProblem("mail-attachments")).toBeNull();
    expect(folderProblem(".git/hooks")).toBe("Mail does not write into .git");
    const fake = fakeCall({ bindings_list: () => ({ bindings: [] }) });
    render(
      <BbIntegrationSettings
        values={{ attachmentFolder: ".hidden", patchFolder: "mail-patches", taskTarget: "local", devNotifications: false }}
        call={fake.call}
        hint="Change it in BB."
      />,
    );
    expect(screen.getByRole("alert").textContent).toBe("Mail does not write into folders that start with a dot; mail-attachments/ is used instead.");
    expect(screen.getByText("Make a task puts tasks in: Mail's own Tasks")).toBeTruthy();
    expect(screen.getByText("Dev notifications: off.")).toBeTruthy();
  });

  it("lists binding rules and removes one", async () => {
    const fake = fakeCall({
      bindings_list: () => ({
        bindings: [{ kind: "domain", value: "example.org", projectId: "p-api", projectName: "api", removed: false, createdAt: "2026-11-16T08:00:00.000Z" }],
      }),
      binding_remove: () => ({ ok: true }),
    });
    render(
      <BbIntegrationSettings
        values={{ attachmentFolder: "mail-attachments", patchFolder: "mail-patches", taskTarget: "auto", devNotifications: true }}
        call={fake.call}
        hint="Change it in BB."
      />,
    );
    expect(await screen.findByText("example.org")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(fake.to("binding_remove")).toEqual([{ kind: "domain", value: "example.org" }]));
  });
});
