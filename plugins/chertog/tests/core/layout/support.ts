// Test-side views of the layout core. They only reformat results, so expected
// values in the tests stay literals and nothing here repeats the algorithms
// under test.
import type { LayoutGeometry, LayoutNode, LayoutOptions, Rect } from "../../../src/core/layout/index.ts";

export const OPTIONS: LayoutOptions = {
  dividerSize: 4,
  minTileWidth: 240,
  minTileHeight: 120,
  compactWidth: 640,
  dropEdgeFraction: 0.25,
};

/** The tree as a compact literal, with shares rounded to four decimals. */
export function shape(node: LayoutNode): unknown {
  if (node.kind === "group") return { group: node.id, tabs: [...node.tabs], active: node.activeTab };
  return {
    split: node.id,
    direction: node.direction,
    sizes: node.sizes.map((size) => Math.round(size * 10000) / 10000),
    children: node.children.map(shape),
  };
}

type Box = [x: number, y: number, width: number, height: number];

const box = (rect: Rect): Box => [rect.x, rect.y, rect.width, rect.height];

/** Every rectangle of a geometry as `[x, y, width, height]`; dividers are keyed `splitId#index`. */
export function boxes(geometry: LayoutGeometry): Record<string, Box> {
  const result: Record<string, Box> = {};
  for (const group of geometry.groups) result[group.groupId] = box(group.rect);
  for (const divider of geometry.dividers) result[divider.splitId + "#" + divider.index] = box(divider.rect);
  return result;
}

/**
 * Paints every group and divider onto a pixel grid of the work area and
 * reports what is wrong: a fractional or outside rectangle, a pixel covered
 * twice, a pixel left uncovered.
 */
export function coverageProblems(geometry: LayoutGeometry, bounds: Rect): string[] {
  const problems: string[] = [];
  const hits = new Uint8Array(bounds.width * bounds.height);
  const paint = (name: string, rect: Rect): void => {
    const values = [rect.x, rect.y, rect.width, rect.height];
    if (!values.every(Number.isInteger)) {
      problems.push(name + " is not on whole pixels: " + values.join(","));
      return;
    }
    if (
      rect.width < 0 ||
      rect.height < 0 ||
      rect.x < bounds.x ||
      rect.y < bounds.y ||
      rect.x + rect.width > bounds.x + bounds.width ||
      rect.y + rect.height > bounds.y + bounds.height
    ) {
      problems.push(name + " leaves the work area: " + values.join(","));
      return;
    }
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      const row = (y - bounds.y) * bounds.width - bounds.x;
      for (let x = rect.x; x < rect.x + rect.width; x += 1) hits[row + x] += 1;
    }
  };
  for (const group of geometry.groups) paint(group.groupId, group.rect);
  for (const divider of geometry.dividers) paint(divider.splitId + "#" + divider.index, divider.rect);
  let uncovered = 0;
  let overlapped = 0;
  for (const count of hits) {
    if (count === 0) uncovered += 1;
    else if (count > 1) overlapped += 1;
  }
  if (uncovered > 0) problems.push(uncovered + " pixels uncovered");
  if (overlapped > 0) problems.push(overlapped + " pixels covered twice");
  return problems;
}
