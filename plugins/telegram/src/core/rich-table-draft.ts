import { layoutRichTable, type RichTableCell } from "./contract.ts";

type TableLayout = NonNullable<ReturnType<typeof layoutRichTable>>;
export type RichTableOperation = "right" | "down" | "split";

function findCells(layout: TableLayout, row: number, column: number) {
  const anchor = layout.rows[row]?.find((entry) => entry.column === column);
  if (!anchor?.cell.content) return;
  const { colSpan, rowSpan } = anchor.cell;
  const right = layout.rows[row]?.find((entry) => entry.column === column + colSpan);
  const down = layout.rows[row + rowSpan]?.find((entry) => entry.column === column);
  return {
    anchor,
    right: right?.cell.content?.text === "" && right.cell.rowSpan === rowSpan ? right : undefined,
    down: down?.cell.content?.text === "" && down.cell.colSpan === colSpan ? down : undefined,
    split: colSpan > 1 || rowSpan > 1,
  };
}

export function richTableCellActions(layout: TableLayout, row: number, column: number) {
  const cells = findCells(layout, row, column);
  return { right: !!cells?.right, down: !!cells?.down, split: !!cells?.split };
}

export function changeRichTableCells(rows: RichTableCell[][], row: number, column: number, operation: RichTableOperation) {
  const layout = layoutRichTable(rows);
  if (!layout) return;
  const cells = findCells(layout, row, column);
  if (!cells || !cells[operation]) return;
  const { anchor, right, down } = cells;
  const { cell } = anchor;
  const edited = layout.rows.map((entries) => entries.filter((entry) => entry !== anchor
    && (operation !== "right" || entry !== right) && (operation !== "down" || entry !== down)));
  if (operation === "split") {
    for (let y = row; y < row + cell.rowSpan; y++) {
      for (let x = column; x < column + cell.colSpan; x++) {
        edited[y]!.push({ column: x, cell: { ...cell, colSpan: 1, rowSpan: 1,
          content: x === column && y === row ? cell.content : { text: "" } } });
      }
    }
  } else {
    edited[row]!.push({ column, cell: { ...cell,
      colSpan: cell.colSpan + (operation === "right" ? right!.cell.colSpan : 0),
      rowSpan: cell.rowSpan + (operation === "down" ? down!.cell.rowSpan : 0),
    } });
  }
  const next = edited.map((entries) => entries.sort((a, b) => a.column - b.column).map(({ cell }) => cell));
  const checked = layoutRichTable(next);
  if (checked?.width !== layout.width || !checked.rows.every((entries, y) =>
    entries.every((entry, x) => entry.column === edited[y]![x]!.column))) return;
  return next;
}
