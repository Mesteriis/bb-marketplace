// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { isTrackerImage } from "./trackers.ts";

function img(attributes: Record<string, string>): Element {
  const element = document.createElement("img");
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
}

const SRC = "https://images.example.org/a.png";

describe("isTrackerImage", () => {
  it("finds pixels by size attributes and inline style", () => {
    expect(isTrackerImage(img({ src: SRC, width: "1", height: "1" }))).toBe(true);
    expect(isTrackerImage(img({ src: SRC, height: "2" }))).toBe(true);
    expect(isTrackerImage(img({ src: SRC, style: "width:1px;height:1px" }))).toBe(true);
    expect(isTrackerImage(img({ src: SRC, style: "display: none" }))).toBe(true);
    expect(isTrackerImage(img({ src: SRC, style: "visibility:hidden !important" }))).toBe(true);
    expect(isTrackerImage(img({ src: SRC, style: "opacity:0" }))).toBe(true);
    expect(isTrackerImage(img({ src: SRC, style: "opacity:0.0" }))).toBe(true);
  });

  it("finds listed open-tracking hosts, exact or by suffix", () => {
    expect(isTrackerImage(img({ src: "https://mailtrack.io/trace/x.png" }))).toBe(true);
    expect(isTrackerImage(img({ src: "https://u1.ct.sendgrid.net/wf/open?x=1" }))).toBe(true);
    expect(isTrackerImage(img({ src: "https://ct.sendgrid.net.example.org/open" }))).toBe(false);
  });

  it("keeps ordinary images, data: images and the fixture's pixel.gif", () => {
    expect(isTrackerImage(img({ src: SRC, width: "600", height: "200" }))).toBe(false);
    expect(isTrackerImage(img({ src: SRC, style: "width:20px;opacity:0.5" }))).toBe(false);
    expect(isTrackerImage(img({ src: "data:image/png;base64,AAAA", width: "1", height: "1" }))).toBe(false);
    expect(isTrackerImage(img({ src: "https://tracker.example.org/pixel.gif" }))).toBe(false);
    expect(isTrackerImage(img({ width: "1" }))).toBe(false);
  });
});
