// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));

import { ConnectPage } from "./connect-page.tsx";

afterEach(cleanup);

function page(initialKind?: "ssh" | "rdp") {
  const ssh = { onSshOpen: vi.fn(), onAttach: vi.fn(), onClose: vi.fn() };
  const rdp = { onRdpOpen: vi.fn(), onAttach: vi.fn(), onClose: vi.fn(), onDecision: vi.fn(), onScreenshot: vi.fn() };
  return render(<ConnectPage ssh={ssh as never} rdp={rdp as never} initialKind={initialKind} />);
}

describe("ConnectPage", () => {
  it("shows SSH first, with the kind switch pressed accordingly", () => {
    const { container } = page();
    expect(screen.getByText("SSH").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("RDP").getAttribute("aria-pressed")).toBe("false");
    const panes = container.querySelectorAll(".rh-kind-pane");
    expect((panes[0] as HTMLElement).hidden).toBe(false);
    expect((panes[1] as HTMLElement).hidden).toBe(true);
  });

  it("switching to RDP shows the RDP form (password field included) and keeps the SSH page mounted", () => {
    const { container } = page();
    fireEvent.click(screen.getByText("RDP"));
    const panes = container.querySelectorAll(".rh-kind-pane");
    expect((panes[0] as HTMLElement).hidden).toBe(true);
    expect((panes[1] as HTMLElement).hidden).toBe(false);
    expect(container.querySelector('input[type="password"]')).toBeTruthy();
    expect(container.querySelector('input[placeholder="host"]')).toBeTruthy(); // the SSH form is still there
    expect(screen.getByText("RDP").getAttribute("aria-pressed")).toBe("true");
  });

  it("can start on RDP", () => {
    const { container } = page("rdp");
    expect((container.querySelectorAll(".rh-kind-pane")[1] as HTMLElement).hidden).toBe(false);
  });
});
