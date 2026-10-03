const WORLD = 360;
const LON_CELL = 10;
const LAT_CELL = 10;
const LON_CELLS = WORLD / LON_CELL;
const LAT_CELLS = 180 / LAT_CELL;

const longitudeCell = lon => Math.max(0, Math.min(LON_CELLS - 1, Math.floor((lon + 180) / LON_CELL)));
const latitudeCell = lat => Math.max(0, Math.min(LAT_CELLS - 1, Math.floor((lat + 90) / LAT_CELL)));

/** A compact uniform geographic grid for viewport candidate lookup. */
export class SpatialIndex {
  #cells = new Map();
  #entries = [];

  add(entry) {
    const bounds = entry?.bounds;
    if (!bounds || ![bounds.west, bounds.east, bounds.south, bounds.north].every(Number.isFinite)) return;
    this.#entries.push(entry);
    const south = latitudeCell(bounds.south), north = latitudeCell(bounds.north);
    const west = longitudeCell(bounds.west), east = longitudeCell(bounds.east);
    for (let y = south; y <= north; y++) {
      for (let x = west; x <= east; x++) {
        const key = y * LON_CELLS + x;
        let cell = this.#cells.get(key);
        if (!cell) this.#cells.set(key, cell = []);
        cell.push(entry);
      }
    }
  }

  query(view) {
    if (view.east - view.west >= WORLD) return this.#entries;
    const result = new Set();
    const south = latitudeCell(view.south), north = latitudeCell(view.north);
    // Consider every visible world copy while looking up canonical longitude cells.
    const firstCopy = Math.ceil((view.west - 180) / WORLD);
    const lastCopy = Math.floor((view.east + 180) / WORLD);
    for (let copy = firstCopy; copy <= lastCopy; copy++) {
      const shift = WORLD * copy;
      const west = Math.max(-180, view.west - shift);
      const east = Math.min(180, view.east - shift);
      if (west > east) continue;
      for (let y = south; y <= north; y++) {
        for (let x = longitudeCell(west); x <= longitudeCell(east); x++) {
          const cell = this.#cells.get(y * LON_CELLS + x);
          if (cell) for (const entry of cell) result.add(entry);
        }
      }
    }
    return result;
  }

  get size() { return this.#entries.length; }
}
