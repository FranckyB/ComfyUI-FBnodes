import assert from "node:assert/strict";
import test from "node:test";
import { cropPixels, cropViewRect, dragCrop, dragPad, fitRect, hitCrop, isFullCrop, lockPad, padFitRect } from "../js/common/stage_math.js";

const FULL = { left_pct: 0, right_pct: 100, top_pct: 0, bottom_pct: 100 };

test("pictures fit the view with a margin, centred", () => {
    const fit = fitRect(1000, 500, 220, 220, 10);
    assert.equal(fit.width, 200);
    assert.equal(fit.height, 100);
    assert.equal(fit.x, 10);
    assert.equal(fit.y, 60);
});

test("the whole crop edge is the handle; corners take both edges", () => {
    const rect = { x: 100, y: 100, width: 200, height: 100 };
    assert.equal(hitCrop({ x: 200, y: 102 }, rect), "n");
    assert.equal(hitCrop({ x: 296, y: 150 }, rect), "e");
    assert.equal(hitCrop({ x: 104, y: 196 }, rect), "sw");
    assert.equal(hitCrop({ x: 200, y: 150 }, rect), "move");
    assert.equal(hitCrop({ x: 50, y: 50 }, rect), null);
    assert.equal(hitCrop({ x: 90, y: 150 }, rect), "w", "the band reaches outside the rect too");
});

test("crop drags clamp to the picture and keep a minimum size", () => {
    assert.deepEqual(dragCrop("w", FULL, -10, 0), FULL);
    assert.equal(dragCrop("e", { ...FULL, left_pct: 40 }, -80, 0).right_pct, 41);
    const moved = dragCrop("move", { left_pct: 10, right_pct: 50, top_pct: 10, bottom_pct: 50 }, 80, -30);
    assert.deepEqual(moved, { left_pct: 60, right_pct: 100, top_pct: 0, bottom_pct: 40 });
});

test("crop pixels mirror the backend's rounding", () => {
    const px = cropPixels({ left_pct: 10, right_pct: 90, top_pct: 25, bottom_pct: 100 }, 1000, 400);
    assert.deepEqual(px, { left: 100, right: 100, top: 100, bottom: 0, width: 800, height: 300 });
    assert.equal(cropPixels({ left_pct: 99.99, right_pct: 100, top_pct: 0, bottom_pct: 100 }, 10, 10).width, 1);
    assert.ok(isFullCrop(FULL));
    assert.deepEqual(cropViewRect({ left_pct: 50, right_pct: 100, top_pct: 0, bottom_pct: 50 }, { x: 10, y: 20, width: 200, height: 100 }), { x: 110, y: 20, width: 100, height: 50 });
});

import { bestGrid } from "../js/common/grid_math.js";

test("a batch lays out at the largest size the box allows", () => {
    // Four portraits in a wide box: one row of four.
    assert.deepEqual(
        (({ columns, rows }) => ({ columns, rows }))(bestGrid(4, 768, 1024, 2000, 700)),
        { columns: 4, rows: 1 },
    );
    // Four squares in a square box: two by two.
    const square = bestGrid(4, 512, 512, 1000, 1000);
    assert.equal(square.columns, 2);
    assert.equal(square.width, 500);
    // One picture fills the box's limiting side.
    const one = bestGrid(1, 1000, 500, 800, 800);
    assert.deepEqual([one.columns, one.rows, one.width, one.height], [1, 1, 800, 400]);
    // Gaps are left between cells.
    assert.equal(bestGrid(2, 100, 100, 210, 100, 10).width, 100);
});

test("pad edges drag outward in whole pixels and never below zero", () => {
    const start = { left: 10, right: 0, top: 0, bottom: 5 };
    assert.deepEqual(dragPad("w", start, -20.4, 0), { left: 30, right: 0, top: 0, bottom: 5 });
    assert.deepEqual(dragPad("se", start, 7.6, -9), { left: 10, right: 8, top: 0, bottom: 0 });
});

test("moving the pad slides the canvas, the picture kept inside", () => {
    const start = { left: 10, right: 30, top: 0, bottom: 0 };
    assert.deepEqual(dragPad("move", start, 4, 5), { left: 6, right: 34, top: 0, bottom: 0 });
    assert.deepEqual(dragPad("move", start, 50, 0), { left: 0, right: 40, top: 0, bottom: 0 });
});

test("a locked ratio holds: edges drive their axis, corners and new ratios cover", () => {
    const none = { left: 0, right: 0, top: 0, bottom: 0 };
    assert.deepEqual(lockPad(none, "", 1000, 1000, 16 / 9), { left: 389, right: 389, top: 0, bottom: 0 });
    assert.deepEqual(lockPad(none, "", 1600, 900, 1), { left: 0, right: 0, top: 350, bottom: 350 });
    // Dragging the right edge of a 1:1 lock out by 200 grows the height evenly.
    assert.deepEqual(lockPad({ ...none, right: 200 }, "e", 1000, 1000, 1), { left: 0, right: 200, top: 100, bottom: 100 });
    // An edge pulled inside the minimum canvas stops there.
    assert.deepEqual(lockPad({ ...none, top: 50 }, "n", 1000, 500, 1), { left: 0, right: 0, top: 500, bottom: 0 });
    // Shrinking an edge shrinks the other axis too.
    assert.deepEqual(lockPad({ left: 100, right: 0, top: 100, bottom: 100 }, "w", 1000, 900, 1), { left: 100, right: 0, top: 100, bottom: 100 });
    assert.deepEqual(lockPad({ left: 0, right: 0, top: 50, bottom: 50 }, "w", 1000, 900, 1), { left: 0, right: 0, top: 50, bottom: 50 });
    // A corner covers: the dragged sides take the change.
    assert.deepEqual(lockPad({ ...none, right: 10, bottom: 300 }, "se", 1000, 1000, 1), { left: 0, right: 300, top: 0, bottom: 300 });
});

test("the padded canvas fits the view, the picture placed inside it", () => {
    const base = { x: 0, y: 0, width: 100, height: 100 };
    const rect = padFitRect(100, 100, base, { left: 100, right: 0, top: 0, bottom: 0 }, 200, 100);
    assert.deepEqual(rect, { x: 100, y: 0, width: 100, height: 100, scale: 1 });
});
