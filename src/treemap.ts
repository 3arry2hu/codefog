export interface TreemapRect<T> {
  x: number;
  y: number;
  w: number;
  h: number;
  item: T;
}

interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

function worstAspect(areas: number[], side: number): number {
  let sum = 0;
  let max = 0;
  let min = Infinity;
  for (const a of areas) {
    sum += a;
    if (a > max) max = a;
    if (a < min) min = a;
  }
  const side2 = side * side;
  const sum2 = sum * sum;
  return Math.max((side2 * max) / sum2, sum2 / (side2 * min));
}

function placeRow<T>(
  row: Array<{ area: number; item: T }>,
  bounds: Bounds,
  out: Array<TreemapRect<T>>,
): void {
  const rowArea = row.reduce((s, r) => s + r.area, 0);
  if (bounds.w >= bounds.h) {
    const colW = rowArea / bounds.h;
    let y = bounds.y;
    for (const r of row) {
      const h = r.area / colW;
      out.push({ x: bounds.x, y, w: colW, h, item: r.item });
      y += h;
    }
    bounds.x += colW;
    bounds.w -= colW;
  } else {
    const rowH = rowArea / bounds.w;
    let x = bounds.x;
    for (const r of row) {
      const w = r.area / rowH;
      out.push({ x, y: bounds.y, w, h: rowH, item: r.item });
      x += w;
    }
    bounds.y += rowH;
    bounds.h -= rowH;
  }
}

/**
 * Squarified treemap (Bruls, Huizing & van Wijk): every rectangle's area is exactly
 * proportional to its weight; items with non-positive weight are dropped.
 */
export function squarify<T>(
  items: Array<{ weight: number; item: T }>,
  width: number,
  height: number,
): Array<TreemapRect<T>> {
  const positive = items.filter((i) => i.weight > 0).sort((a, b) => b.weight - a.weight);
  const total = positive.reduce((s, i) => s + i.weight, 0);
  if (total === 0) return [];

  const scale = (width * height) / total;
  const bounds: Bounds = { x: 0, y: 0, w: width, h: height };
  const out: Array<TreemapRect<T>> = [];
  let row: Array<{ area: number; item: T }> = [];

  for (const { weight, item } of positive) {
    const cell = { area: weight * scale, item };
    const side = Math.min(bounds.w, bounds.h);
    if (
      row.length === 0 ||
      worstAspect([...row.map((r) => r.area), cell.area], side) <=
        worstAspect(row.map((r) => r.area), side)
    ) {
      row.push(cell);
    } else {
      placeRow(row, bounds, out);
      row = [cell];
    }
  }
  if (row.length > 0) placeRow(row, bounds, out);
  return out;
}
