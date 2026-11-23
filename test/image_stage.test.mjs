import assert from "node:assert/strict";
import test from "node:test";
import { cropPixels, cropViewRect, dragCrop, fitRect, hitCrop, isFullCrop } from "../js/common/stage_math.mjs";

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
