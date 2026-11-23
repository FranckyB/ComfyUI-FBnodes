// How to lay a batch of same-shaped pictures out as large as a box allows:
// the column count whose grid gives each picture the biggest scale. No DOM,
// for node:test. Used by the Save Image+ grid and the review screen.

export function bestGrid(count, itemW, itemH, boxW, boxH, gap = 0) {
    const n = Math.max(1, Math.floor(count) || 1);
    const w = Math.max(1, itemW || 1);
    const h = Math.max(1, itemH || 1);
    let best = null;
    for (let columns = 1; columns <= n; columns++) {
        const rows = Math.ceil(n / columns);
        const cellW = (boxW - gap * (columns - 1)) / columns;
        const cellH = (boxH - gap * (rows - 1)) / rows;
        const scale = Math.min(cellW / w, cellH / h);
        // Ties go to fewer columns: the same size with fewer empty slots.
        if (scale > 0 && (!best || scale > best.scale + 1e-9)) best = { columns, rows, scale };
    }
    best ??= { columns: n, rows: 1, scale: 0 };
    return { ...best, width: w * best.scale, height: h * best.scale };
}
