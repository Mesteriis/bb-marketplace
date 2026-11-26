// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { GitWandFrame } from "./gitwand-frame.tsx";

afterEach(cleanup);

const URL_A = "http://localhost:38886/api/v1/plugins/makosh-gitwand/http/ui/index.html?repo=%2Fr";

describe("GitWandFrame", () => {
  it("embeds the UI from the given URL", () => {
    render(<GitWandFrame url={URL_A} />);
    expect(screen.getByTitle("GitWand").getAttribute("src")).toBe(URL_A);
  });

  it("sandboxes the iframe without top navigation and allows the clipboard", () => {
    render(<GitWandFrame url={URL_A} />);
    const frame = screen.getByTitle("GitWand");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin allow-forms allow-popups allow-modals");
    expect(frame.getAttribute("allow")).toBe("clipboard-read; clipboard-write");
  });

  it("explains instead of embedding when BB is not open on a loopback address", () => {
    render(<GitWandFrame url={null} />);
    expect(screen.queryByTitle("GitWand")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe(
      "GitWand открывается только в BB на этом компьютере: откройте BB по адресу http://127.0.0.1 или http://localhost.",
    );
  });
});
