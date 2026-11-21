// Setup for the tests that run in jsdom (see vitest.config.ts). It unmounts
// rendered trees after each test and supplies the two browser APIs the UI
// uses that jsdom does not implement: pointer capture and ResizeObserver.
// An API jsdom does provide is left alone.
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/** Which element holds each captured pointer. A pointer is captured by one element at a time, as in a browser. */
const pointerCaptures = new Map<number, Element>();

if (typeof Element.prototype.setPointerCapture !== "function") {
  Element.prototype.setPointerCapture = function setPointerCapture(this: Element, pointerId: number): void {
    pointerCaptures.set(pointerId, this);
  };
  Element.prototype.releasePointerCapture = function releasePointerCapture(this: Element, pointerId: number): void {
    if (pointerCaptures.get(pointerId) === this) pointerCaptures.delete(pointerId);
  };
  Element.prototype.hasPointerCapture = function hasPointerCapture(this: Element, pointerId: number): boolean {
    return pointerCaptures.get(pointerId) === this;
  };
}

if (typeof globalThis.ResizeObserver !== "function") {
  // jsdom computes no layout, so there is never a size to report: the
  // observer accepts targets and never calls back. A test that needs a
  // resize drives the component's size input directly.
  globalThis.ResizeObserver = class ResizeObserver {
    constructor(_callback: ResizeObserverCallback) {}
    observe(_target: Element, _options?: ResizeObserverOptions): void {}
    unobserve(_target: Element): void {}
    disconnect(): void {}
  };
}

afterEach(() => {
  cleanup();
  pointerCaptures.clear();
});
