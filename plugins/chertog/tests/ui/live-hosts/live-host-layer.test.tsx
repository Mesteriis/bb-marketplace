// The stable live host layer (docs/spec.md, section 4 "Стабильный host" and
// the acceptance rows "Живая iframe-панель" and "Освобождение и деградация").
// A physical move of an iframe to another DOM node reloads its page, so every
// check here is about the node staying where it is: same node, same parent,
// same sibling order, content mounted once.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { use, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Rect } from "../../../src/core/layout/index.ts";
import { LiveHostLayer, type LiveHostInstance } from "../../../src/ui/live-hosts/index.ts";
import {
  draftOf,
  frameOf,
  host,
  hostOrder,
  layerRoot,
  lifecycle,
  probeInstance,
  rect,
  rects,
} from "./support.tsx";

afterEach(() => {
  vi.restoreAllMocks();
});

interface Step {
  name: string;
  instances: readonly LiveHostInstance[];
  rects: ReadonlyMap<string, Rect>;
  gestureActive?: boolean;
}

describe("LiveHostLayer: one stable container per instance", () => {
  it("keeps the same host node, iframe and mount count through rebuilds, hides and shows", () => {
    const a = lifecycle();
    const b = lifecycle();
    const first = probeInstance("inst-a", "panel-a", a);
    const second = probeInstance("inst-b", "panel-b", b);
    const both = [first, second];

    const view = render(
      <LiveHostLayer instances={both} rects={rects({ "panel-a": rect(0, 0, 800, 600) })} />,
    );
    const root = layerRoot(view.container);
    const hostA = host(view.container, "inst-a");
    const hostB = host(view.container, "inst-b");
    const frameA = frameOf(hostA);
    const frameB = frameOf(hostB);

    const steps: Step[] = [
      { name: "first split", instances: both, rects: rects({ "panel-a": rect(0, 0, 398, 600), "panel-b": rect(402, 0, 398, 600) }) },
      { name: "panels swap sides", instances: both, rects: rects({ "panel-a": rect(402, 0, 398, 600), "panel-b": rect(0, 0, 398, 600) }) },
      { name: "instance moves to another group", instances: [{ ...first, panelId: "panel-c" }, second], rects: rects({ "panel-c": rect(0, 302, 800, 298), "panel-b": rect(0, 0, 800, 298) }) },
      { name: "back to one tile", instances: both, rects: rects({ "panel-a": rect(0, 0, 800, 600) }) },
      { name: "two tiles again", instances: both, rects: rects({ "panel-a": rect(0, 0, 398, 600), "panel-b": rect(402, 0, 398, 600) }) },
      { name: "divider drag in progress", instances: both, rects: rects({ "panel-a": rect(0, 0, 250, 600), "panel-b": rect(254, 0, 546, 600) }), gestureActive: true },
      { name: "neighbour maximized", instances: both, rects: rects({ "panel-b": rect(0, 0, 800, 600) }) },
      { name: "restored", instances: both, rects: rects({ "panel-a": rect(0, 0, 250, 600), "panel-b": rect(254, 0, 546, 600) }) },
      { name: "another named layout, neither panel on it", instances: both, rects: rects({}) },
      { name: "back to the first layout", instances: both, rects: rects({ "panel-a": rect(0, 0, 398, 600), "panel-b": rect(402, 0, 398, 600) }) },
      { name: "caller lists the instances in another order", instances: [second, first], rects: rects({ "panel-a": rect(0, 0, 398, 600), "panel-b": rect(402, 0, 398, 600) }) },
      { name: "compact: one panel shown", instances: both, rects: rects({ "panel-b": rect(0, 0, 500, 600) }) },
      { name: "wide again", instances: both, rects: rects({ "panel-a": rect(0, 0, 398, 600), "panel-b": rect(402, 0, 398, 600) }) },
    ];

    for (const step of steps) {
      view.rerender(<LiveHostLayer instances={step.instances} rects={step.rects} gestureActive={step.gestureActive} />);

      expect(layerRoot(view.container), step.name).toBe(root);
      expect(host(view.container, "inst-a"), step.name).toBe(hostA);
      expect(host(view.container, "inst-b"), step.name).toBe(hostB);
      expect(hostA.parentElement, step.name).toBe(root);
      expect(hostB.parentElement, step.name).toBe(root);
      expect(frameOf(hostA), step.name).toBe(frameA);
      expect(frameOf(hostB), step.name).toBe(frameB);
      expect(hostOrder(view.container), step.name).toEqual(["inst-a", "inst-b"]);
      expect(root.childElementCount, step.name).toBe(2);
      expect([a.mounts, a.unmounts], step.name).toEqual([1, 0]);
      expect([b.mounts, b.unmounts], step.name).toEqual([1, 0]);
    }

    expect(frameA.getAttribute("src")).toBe("https://frame.test/inst-a");
    expect(frameB.getAttribute("src")).toBe("https://frame.test/inst-b");
  });

  it("removes a container once, on explicit close, and leaves the neighbour mounted", () => {
    const a = lifecycle();
    const b = lifecycle();
    const first = probeInstance("inst-a", "panel-a", a);
    const second = probeInstance("inst-b", "panel-b", b);
    const split = rects({ "panel-a": rect(0, 0, 398, 600), "panel-b": rect(402, 0, 398, 600) });

    const view = render(<LiveHostLayer instances={[first, second]} rects={split} />);
    const hostB = host(view.container, "inst-b");
    const frameB = frameOf(hostB);
    expect([a.mounts, a.unmounts]).toEqual([1, 0]);

    view.rerender(<LiveHostLayer instances={[second]} rects={rects({ "panel-b": rect(0, 0, 800, 600) })} />);

    expect([a.mounts, a.unmounts]).toEqual([1, 1]);
    expect([b.mounts, b.unmounts]).toEqual([1, 0]);
    expect(hostOrder(view.container)).toEqual(["inst-b"]);
    expect(host(view.container, "inst-b")).toBe(hostB);
    expect(frameOf(hostB)).toBe(frameB);

    // Further rebuilds do not unmount the closed instance a second time.
    view.rerender(<LiveHostLayer instances={[second]} rects={rects({})} />);
    view.rerender(<LiveHostLayer instances={[second]} rects={rects({ "panel-b": rect(0, 0, 640, 480) })} />);
    expect([a.mounts, a.unmounts]).toEqual([1, 1]);
    expect([b.mounts, b.unmounts]).toEqual([1, 0]);
  });

  it("appends a new instance after the open ones and does not remount them", () => {
    const a = lifecycle();
    const b = lifecycle();
    const c = lifecycle();
    const first = probeInstance("inst-a", "panel-a", a);
    const second = probeInstance("inst-b", "panel-b", b);
    const third = probeInstance("inst-c", "panel-c", c);
    const none = rects({});

    const view = render(<LiveHostLayer instances={[first, second]} rects={none} />);
    const hostA = host(view.container, "inst-a");
    const hostB = host(view.container, "inst-b");
    const frameA = frameOf(hostA);
    const frameB = frameOf(hostB);

    // The caller puts the new instance first; the DOM keeps opening order.
    view.rerender(<LiveHostLayer instances={[third, first, second]} rects={none} />);
    const hostC = host(view.container, "inst-c");
    const frameC = frameOf(hostC);
    expect(hostOrder(view.container)).toEqual(["inst-a", "inst-b", "inst-c"]);
    expect(host(view.container, "inst-a")).toBe(hostA);
    expect(host(view.container, "inst-b")).toBe(hostB);
    expect([a.mounts, a.unmounts, b.mounts, b.unmounts, c.mounts, c.unmounts]).toEqual([1, 0, 1, 0, 1, 0]);

    // Closing the one in the middle leaves both neighbours' nodes in place.
    view.rerender(<LiveHostLayer instances={[third, first]} rects={none} />);
    expect(hostOrder(view.container)).toEqual(["inst-a", "inst-c"]);
    expect(host(view.container, "inst-a")).toBe(hostA);
    expect(host(view.container, "inst-c")).toBe(hostC);
    expect(frameOf(hostA)).toBe(frameA);
    expect(frameOf(hostC)).toBe(frameC);
    expect(frameB.isConnected).toBe(false);
    expect([a.mounts, a.unmounts, b.mounts, b.unmounts, c.mounts, c.unmounts]).toEqual([1, 0, 1, 1, 1, 0]);
  });

  it("treats an instance ID opened again after its close as a new instance, placed last", () => {
    const a = lifecycle();
    const b = lifecycle();
    const first = probeInstance("inst-a", "panel-a", a);
    const second = probeInstance("inst-b", "panel-b", b);
    const none = rects({});

    const view = render(<LiveHostLayer instances={[first, second]} rects={none} />);
    const closedHost = host(view.container, "inst-a");
    view.rerender(<LiveHostLayer instances={[second]} rects={none} />);
    view.rerender(<LiveHostLayer instances={[first, second]} rects={none} />);

    expect(hostOrder(view.container)).toEqual(["inst-b", "inst-a"]);
    expect(host(view.container, "inst-a")).not.toBe(closedHost);
    expect([a.mounts, a.unmounts]).toEqual([2, 1]);
    expect([b.mounts, b.unmounts]).toEqual([1, 0]);
  });

  it("renders one container for an instance ID listed twice, with the first entry's panel", () => {
    const a = lifecycle();
    const first = probeInstance("inst-a", "panel-a", a);
    const view = render(
      <LiveHostLayer
        instances={[first, { ...first, panelId: "panel-b" }]}
        rects={rects({ "panel-a": rect(0, 0, 100, 100), "panel-b": rect(200, 0, 100, 100) })}
      />,
    );

    expect(hostOrder(view.container)).toEqual(["inst-a"]);
    expect(host(view.container, "inst-a").style.left).toBe("0px");
    expect([a.mounts, a.unmounts]).toEqual([1, 0]);
  });

  it("keeps the textarea's text and selection through geometry changes and a hide", () => {
    const a = lifecycle();
    const b = lifecycle();
    const both = [probeInstance("inst-a", "panel-a", a), probeInstance("inst-b", "panel-b", b)];
    const view = render(
      <LiveHostLayer instances={both} rects={rects({ "panel-a": rect(0, 0, 398, 600), "panel-b": rect(402, 0, 398, 600) })} />,
    );
    const draft = draftOf(host(view.container, "inst-a"));
    fireEvent.change(draft, { target: { value: "unsent draft" } });
    draft.setSelectionRange(2, 6);

    view.rerender(<LiveHostLayer instances={both} rects={rects({ "panel-a": rect(402, 0, 398, 600), "panel-b": rect(0, 0, 398, 600) })} />);
    view.rerender(<LiveHostLayer instances={both} rects={rects({ "panel-b": rect(0, 0, 800, 600) })} />);
    view.rerender(<LiveHostLayer instances={both} rects={rects({})} gestureActive />);
    view.rerender(<LiveHostLayer instances={both} rects={rects({ "panel-a": rect(0, 0, 800, 600) })} />);

    expect(draftOf(host(view.container, "inst-a"))).toBe(draft);
    expect(draft.value).toBe("unsent draft");
    expect(draft.selectionStart).toBe(2);
    expect(draft.selectionEnd).toBe(6);
  });
});

describe("LiveHostLayer: geometry and visibility", () => {
  it("places a visible container on whole pixels, rounding shared edges the same way", () => {
    const view = render(
      <LiveHostLayer
        instances={[probeInstance("inst-a", "panel-a", lifecycle()), probeInstance("inst-b", "panel-b", lifecycle())]}
        rects={rects({ "panel-a": rect(10.4, 19.6, 300.2, 199.7), "panel-b": rect(310.6, 19.6, 100.3, 199.7) })}
      />,
    );
    const hostA = host(view.container, "inst-a");
    const hostB = host(view.container, "inst-b");

    expect(hostA.style.position).toBe("absolute");
    expect(hostA.style.left).toBe("10px");
    expect(hostA.style.top).toBe("20px");
    // Right edge 310.6 rounds to 311, bottom edge 219.3 to 219.
    expect(hostA.style.width).toBe("301px");
    expect(hostA.style.height).toBe("199px");
    expect(hostA.style.visibility).toBe("visible");
    expect(hostA.style.pointerEvents).toBe("auto");
    expect(hostA.style.zIndex).toBe("0");
    expect(hostA.style.overflow).toBe("hidden");
    expect(hostA.style.display).toBe("");
    expect(hostA.hasAttribute("inert")).toBe(false);
    expect(hostA.hasAttribute("aria-hidden")).toBe(false);
    expect(hostA.getAttribute("data-visible")).toBe("true");
    expect(hostA.getAttribute("data-panel-id")).toBe("panel-a");

    // The neighbour starts on the pixel the first one ends on.
    expect(hostB.style.left).toBe("311px");
    expect(hostB.style.width).toBe("100px");
  });

  it("hides without display:none, keeps the last geometry and takes the container out of input and the accessibility tree", () => {
    const both = [probeInstance("inst-a", "panel-a", lifecycle())];
    const view = render(<LiveHostLayer instances={both} rects={rects({ "panel-a": rect(40, 50, 320, 240) })} />);
    const hostA = host(view.container, "inst-a");

    view.rerender(<LiveHostLayer instances={both} rects={rects({})} />);

    expect(hostA.style.visibility).toBe("hidden");
    expect(hostA.style.pointerEvents).toBe("none");
    expect(hostA.style.display).toBe("");
    expect(hostA.hasAttribute("inert")).toBe(true);
    expect(hostA.getAttribute("aria-hidden")).toBe("true");
    expect(hostA.getAttribute("data-visible")).toBe("false");
    expect([hostA.style.left, hostA.style.top, hostA.style.width, hostA.style.height]).toEqual(["40px", "50px", "320px", "240px"]);

    view.rerender(<LiveHostLayer instances={both} rects={rects({ "panel-a": rect(0, 0, 640, 480) })} />);

    expect(hostA.style.visibility).toBe("visible");
    expect(hostA.style.pointerEvents).toBe("auto");
    expect(hostA.hasAttribute("inert")).toBe(false);
    expect(hostA.hasAttribute("aria-hidden")).toBe(false);
    expect([hostA.style.left, hostA.style.top, hostA.style.width, hostA.style.height]).toEqual(["0px", "0px", "640px", "480px"]);
  });

  it("mounts an instance opened on a hidden panel as a hidden container of zero size", () => {
    const a = lifecycle();
    const view = render(<LiveHostLayer instances={[probeInstance("inst-a", "panel-a", a)]} rects={rects({})} />);
    const hostA = host(view.container, "inst-a");

    expect(hostA.style.visibility).toBe("hidden");
    expect(hostA.hasAttribute("inert")).toBe(true);
    expect([hostA.style.left, hostA.style.top, hostA.style.width, hostA.style.height]).toEqual(["0px", "0px", "0px", "0px"]);
    expect([a.mounts, a.unmounts]).toEqual([1, 0]);
  });

  it.each([
    ["a NaN coordinate", rect(Number.NaN, 0, 100, 100)],
    ["an infinite width", rect(0, 0, Number.POSITIVE_INFINITY, 100)],
  ])("hides a container whose rectangle has %s", (_name, broken) => {
    const view = render(
      <LiveHostLayer instances={[probeInstance("inst-a", "panel-a", lifecycle())]} rects={rects({ "panel-a": broken })} />,
    );
    const hostA = host(view.container, "inst-a");

    expect(hostA.style.visibility).toBe("hidden");
    expect(hostA.hasAttribute("inert")).toBe(true);
    expect([hostA.style.left, hostA.style.top, hostA.style.width, hostA.style.height]).toEqual(["0px", "0px", "0px", "0px"]);
  });

  it("clamps a negative size to zero", () => {
    const view = render(
      <LiveHostLayer instances={[probeInstance("inst-a", "panel-a", lifecycle())]} rects={rects({ "panel-a": rect(30, 40, -5, -1) })} />,
    );
    const hostA = host(view.container, "inst-a");

    expect([hostA.style.left, hostA.style.top, hostA.style.width, hostA.style.height]).toEqual(["30px", "40px", "0px", "0px"]);
  });

  it("orders layers with z-index and leaves the DOM order alone", () => {
    const both = [probeInstance("inst-a", "panel-a", lifecycle()), probeInstance("inst-b", "panel-b", lifecycle())];
    const overlap = rects({ "panel-a": rect(0, 0, 400, 300), "panel-b": rect(100, 100, 400, 300) });
    const view = render(<LiveHostLayer instances={both} rects={overlap} layers={new Map([["panel-a", 2]])} />);

    expect(host(view.container, "inst-a").style.zIndex).toBe("2");
    expect(host(view.container, "inst-b").style.zIndex).toBe("0");
    expect(hostOrder(view.container)).toEqual(["inst-a", "inst-b"]);

    view.rerender(<LiveHostLayer instances={both} rects={overlap} layers={new Map([["panel-b", 3]])} />);

    expect(host(view.container, "inst-a").style.zIndex).toBe("0");
    expect(host(view.container, "inst-b").style.zIndex).toBe("3");
    expect(hostOrder(view.container)).toEqual(["inst-a", "inst-b"]);
  });
});

describe("LiveHostLayer: pointer", () => {
  it("never takes the pointer on the root and stays in its own stacking context", () => {
    const view = render(
      <LiveHostLayer instances={[probeInstance("inst-a", "panel-a", lifecycle())]} rects={rects({ "panel-a": rect(0, 0, 100, 100) })} />,
    );
    const root = layerRoot(view.container);

    expect(root.style.pointerEvents).toBe("none");
    expect(root.style.position).toBe("absolute");
    expect(root.style.inset).toBe("0px");
    expect(root.style.overflow).toBe("hidden");
    // Contained z-indexes: a raised host cannot rise above a dialog or the palette.
    expect(root.style.isolation).toBe("isolate");
    expect(root.style.zIndex).toBe("0");

    view.rerender(
      <LiveHostLayer instances={[probeInstance("inst-a", "panel-a", lifecycle())]} rects={rects({ "panel-a": rect(0, 0, 100, 100) })} gestureActive />,
    );
    expect(root.style.pointerEvents).toBe("none");
  });

  it("gives every container pointer-events none during a gesture and returns it afterwards", () => {
    const both = [probeInstance("inst-a", "panel-a", lifecycle()), probeInstance("inst-b", "panel-b", lifecycle())];
    const shown = rects({ "panel-a": rect(0, 0, 398, 600) });
    const view = render(<LiveHostLayer instances={both} rects={shown} />);
    const hostA = host(view.container, "inst-a");
    const hostB = host(view.container, "inst-b");
    expect([hostA.style.pointerEvents, hostB.style.pointerEvents]).toEqual(["auto", "none"]);

    view.rerender(<LiveHostLayer instances={both} rects={shown} gestureActive />);
    expect([hostA.style.pointerEvents, hostB.style.pointerEvents]).toEqual(["none", "none"]);
    // A gesture does not hide anything.
    expect(hostA.style.visibility).toBe("visible");
    expect(hostA.hasAttribute("inert")).toBe(false);

    view.rerender(<LiveHostLayer instances={both} rects={shown} gestureActive={false} />);
    expect([hostA.style.pointerEvents, hostB.style.pointerEvents]).toEqual(["auto", "none"]);
  });
});

describe("LiveHostLayer: content", () => {
  it("calls renderContent with the instance ID and not again when only geometry changes", () => {
    const calls: string[] = [];
    const instances: LiveHostInstance[] = [
      { instanceId: "inst-a", panelId: "panel-a", renderContent: (id) => (calls.push(id), <p>content of {id}</p>) },
    ];
    const view = render(<LiveHostLayer instances={instances} rects={rects({ "panel-a": rect(0, 0, 100, 100) })} />);
    expect(calls).toEqual(["inst-a"]);

    view.rerender(<LiveHostLayer instances={instances} rects={rects({ "panel-a": rect(5, 5, 300, 200) })} />);
    view.rerender(<LiveHostLayer instances={instances} rects={rects({})} gestureActive />);
    view.rerender(<LiveHostLayer instances={[{ ...instances[0]!, panelId: "panel-z" }]} rects={rects({ "panel-z": rect(0, 0, 50, 50) })} />);

    expect(calls).toEqual(["inst-a"]);
    expect(screen.getByText("content of inst-a")).toBeTruthy();
  });

  it("re-renders in place, without a remount, when the caller passes a new renderContent", () => {
    const a = lifecycle();
    const view = render(
      <LiveHostLayer instances={[probeInstance("inst-a", "panel-a", a)]} rects={rects({ "panel-a": rect(0, 0, 100, 100) })} />,
    );
    const frame = frameOf(host(view.container, "inst-a"));

    view.rerender(
      <LiveHostLayer instances={[probeInstance("inst-a", "panel-a", a)]} rects={rects({ "panel-a": rect(0, 0, 100, 100) })} />,
    );

    expect(frameOf(host(view.container, "inst-a"))).toBe(frame);
    expect([a.mounts, a.unmounts, a.renders]).toEqual([1, 0, 2]);
  });

  it("shows a loading state for a slow instance and does not remount its neighbour", async () => {
    const a = lifecycle();
    let finish: (text: string) => void = () => {};
    const pending = new Promise<string>((resolve) => {
      finish = resolve;
    });
    function Slow(): ReactNode {
      return <p>{use(pending)}</p>;
    }
    const instances: LiveHostInstance[] = [
      probeInstance("inst-a", "panel-a", a),
      { instanceId: "inst-slow", panelId: "panel-b", renderContent: () => <Slow /> },
    ];
    const split = rects({ "panel-a": rect(0, 0, 398, 600), "panel-b": rect(402, 0, 398, 600) });

    const view = await act(async () => render(<LiveHostLayer instances={instances} rects={split} />));
    const hostA = host(view.container, "inst-a");
    const frameA = frameOf(hostA);
    const slowHost = host(view.container, "inst-slow");

    expect(slowHost.querySelector('[data-panel-state="loading"]')).not.toBeNull();
    expect(hostA.querySelector(":scope > [data-panel-state]")).toBeNull();
    expect(hostA.style.display).toBe("");
    expect([a.mounts, a.unmounts]).toEqual([1, 0]);

    await act(async () => {
      finish("slow content is here");
      await pending;
    });

    expect(slowHost.textContent).toBe("slow content is here");
    expect(slowHost.querySelector("[data-panel-state]")).toBeNull();
    expect(host(view.container, "inst-slow")).toBe(slowHost);
    expect(host(view.container, "inst-a")).toBe(hostA);
    expect(frameOf(hostA)).toBe(frameA);
    expect([a.mounts, a.unmounts]).toEqual([1, 0]);
  });

  it("marks only the instance whose content crashed as lost and retries it on a click", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const a = lifecycle();
    let attempts = 0;
    let broken = true;
    function Fragile(): ReactNode {
      attempts += 1;
      if (broken) throw new Error("renderer went away");
      return <p>recovered content</p>;
    }
    const instances: LiveHostInstance[] = [
      probeInstance("inst-a", "panel-a", a),
      { instanceId: "inst-bad", panelId: "panel-b", renderContent: () => <Fragile /> },
    ];
    const split = rects({ "panel-a": rect(0, 0, 398, 600), "panel-b": rect(402, 0, 398, 600) });

    const failures: [string, string][] = [];
    const onContentError = (id: string, error: unknown) => {
      failures.push([id, error instanceof Error ? error.message : String(error)]);
    };

    const view = render(<LiveHostLayer instances={instances} rects={split} onContentError={onContentError} />);
    const hostA = host(view.container, "inst-a");
    const frameA = frameOf(hostA);
    const badHost = host(view.container, "inst-bad");

    expect(badHost.querySelector('[data-panel-state="lost"]')).not.toBeNull();
    expect(failures).toEqual([["inst-bad", "renderer went away"]]);
    expect(hostA.querySelector(":scope > [data-panel-state]")).toBeNull();
    expect([a.mounts, a.unmounts]).toEqual([1, 0]);

    // No retry happens on its own: a rebuild leaves the lost state as it is.
    const attemptsAfterCrash = attempts;
    view.rerender(
      <LiveHostLayer instances={instances} rects={rects({ "panel-b": rect(0, 0, 800, 600) })} onContentError={onContentError} />,
    );
    expect(attempts).toBe(attemptsAfterCrash);
    expect(badHost.querySelector('[data-panel-state="lost"]')).not.toBeNull();

    broken = false;
    fireEvent.click(badHost.querySelector("button") as HTMLButtonElement);

    expect(badHost.textContent).toBe("recovered content");
    expect(failures).toEqual([["inst-bad", "renderer went away"]]);
    expect(host(view.container, "inst-bad")).toBe(badHost);
    expect(frameOf(hostA)).toBe(frameA);
    expect([a.mounts, a.unmounts]).toEqual([1, 0]);
  });
});
