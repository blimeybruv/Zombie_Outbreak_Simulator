// Uniform-grid spatial hash, rebuilt from scratch each time it is used.
//
// Queries return ids sorted ascending, never in cell order: callers accumulate
// floats over the results, and CLAUDE.md requires id order for that.

export class SpatialHash {
  private readonly cols: number;
  private readonly cellStart: Int32Array;
  private readonly cellCount: Int32Array;
  private ids = new Int32Array(0);
  private xs = new Float64Array(0);
  private ys = new Float64Array(0);
  private cellOf = new Int32Array(0);
  private n = 0;
  private order = new Int32Array(0);
  private px = new Float64Array(0);
  private py = new Float64Array(0);

  constructor(
    size: number,
    private readonly cell: number,
  ) {
    this.cols = Math.ceil(size / cell);
    this.cellStart = new Int32Array(this.cols * this.cols + 1);
    this.cellCount = new Int32Array(this.cols * this.cols);
  }

  private cellIndex(x: number, y: number): number {
    const max = this.cols - 1;
    let cx = Math.floor(x / this.cell);
    let cy = Math.floor(y / this.cell);
    cx = cx < 0 ? 0 : cx > max ? max : cx;
    cy = cy < 0 ? 0 : cy > max ? max : cy;
    return cy * this.cols + cx;
  }

  /** Inserts entities in the order given; pass ids ascending so each cell stays sorted. */
  rebuild(count: number, id: (i: number) => number, x: (i: number) => number, y: (i: number) => number): void {
    if (this.ids.length < count) {
      const cap = Math.max(count, this.ids.length * 2, 64);
      this.ids = new Int32Array(cap);
      this.xs = new Float64Array(cap);
      this.ys = new Float64Array(cap);
      this.cellOf = new Int32Array(cap);
    }
    this.n = count;
    this.cellCount.fill(0);
    if (this.order.length < count) {
      const cap = Math.max(count, this.order.length * 2, 64);
      this.order = new Int32Array(cap);
      this.px = new Float64Array(cap);
      this.py = new Float64Array(cap);
    }
    const { order, px, py } = this;
    for (let i = 0; i < count; i++) {
      order[i] = id(i);
      px[i] = x(i);
      py[i] = y(i);
      const c = this.cellIndex(px[i]!, py[i]!);
      this.cellOf[i] = c;
      this.cellCount[c]!++;
    }
    let acc = 0;
    for (let c = 0; c < this.cellCount.length; c++) {
      this.cellStart[c] = acc;
      acc += this.cellCount[c]!;
    }
    this.cellStart[this.cellCount.length] = acc;
    const fill = this.cellCount;
    fill.fill(0);
    for (let i = 0; i < count; i++) {
      const c = this.cellOf[i]!;
      const slot = this.cellStart[c]! + fill[c]!++;
      this.ids[slot] = order[i]!;
      this.xs[slot] = px[i]!;
      this.ys[slot] = py[i]!;
    }
  }

  get count(): number {
    return this.n;
  }

  /** Ids within radius r of (x, y), ascending, written into `out`; returns the count. */
  query(x: number, y: number, r: number, out: number[]): number {
    out.length = 0;
    const max = this.cols - 1;
    const c0x = Math.max(0, Math.floor((x - r) / this.cell));
    const c1x = Math.min(max, Math.floor((x + r) / this.cell));
    const c0y = Math.max(0, Math.floor((y - r) / this.cell));
    const c1y = Math.min(max, Math.floor((y + r) / this.cell));
    const rSq = r * r;
    for (let cy = c0y; cy <= c1y; cy++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const c = cy * this.cols + cx;
        for (let s = this.cellStart[c]!, e = this.cellStart[c + 1]!; s < e; s++) {
          const dx = this.xs[s]! - x;
          const dy = this.ys[s]! - y;
          if (dx * dx + dy * dy <= rSq) out.push(this.ids[s]!);
        }
      }
    }
    if (out.length > 1) out.sort((a, b) => a - b);
    return out.length;
  }
}
