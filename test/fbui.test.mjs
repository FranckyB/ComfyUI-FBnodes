import assert from "node:assert/strict";
import test from "node:test";
import { quantize, scrubbedValue, scrubSteps, sumValue } from "../js/fbui/scrub.mjs";
import { cardHeight, rowKind, rowTops, segmentFits, visibleRows } from "../js/fbui/card_math.mjs";
import { CARD_PADDING, GROUP_HEIGHT, ROW_GAP, ROW_HEIGHT } from "../js/fbui/theme.mjs";

test("scrub values are clamped and rounded", () => {
    assert.equal(quantize(0.1 + 0.2, { decimals: 2 }), 0.3);
    assert.equal(quantize(5, { min: 0, max: 1, decimals: 2 }), 1);
    assert.equal(quantize("junk", { min: 2, decimals: 0 }), 2);
});

test("typed sums are evaluated", () => {
    assert.equal(sumValue("1024*1.5"), 1536);
    assert.equal(sumValue("(1920-64)/2"), 928);
    assert.equal(sumValue("-(2+3)"), -5);
    assert.equal(sumValue("1/0"), null);
    assert.equal(sumValue("alert(1)"), null);
});

test("scrub steps follow the widget range", () => {
    assert.deepEqual(scrubSteps({ min: 0, max: 1, step: 0.1 }, true), { step: 0.05, fineStep: 0.01, decimals: 2 });
    assert.equal(scrubSteps({ min: 0, max: 16384, step: 10 }, false, true).step, 8);
    assert.equal(scrubSteps({ min: 0, max: 100, step: 10 }, false).step, 1);
    assert.equal(scrubbedValue(10, 2, false, { step: 1 }), 10);
    assert.equal(scrubbedValue(10, 3 + 8, false, { step: 1, decimals: 0 }), 12);
});

test("card rows fold into groups and follow `when`", () => {
    const rows = [
        { widget: "a" },
        { widget: "b", when: (v) => v.mode === "on" },
        { group: "more", label: "More" },
        { widget: "c", inGroup: "more" },
    ];
    assert.deepEqual(visibleRows(rows, { mode: "off" }, { more: false }).map((r) => r.widget ?? r.group), ["a", "more"]);
    assert.deepEqual(visibleRows(rows, { mode: "on" }, { more: true }).map((r) => r.widget ?? r.group), ["a", "b", "more", "c"]);
    const shown = visibleRows(rows, { mode: "off" }, { more: false });
    assert.equal(cardHeight(shown), CARD_PADDING * 2 + ROW_HEIGHT + GROUP_HEIGHT + ROW_GAP);
    assert.deepEqual(rowTops(shown), [CARD_PADDING, CARD_PADDING + ROW_HEIGHT + ROW_GAP]);
});

test("controls are picked from the widget", () => {
    assert.equal(rowKind({}, { type: "number" }), "scrub");
    assert.equal(rowKind({}, { type: "toggle" }), "switch");
    assert.equal(rowKind({}, { type: "combo" }, ["fit", "crop"]), "segment");
    assert.equal(rowKind({}, { type: "combo" }, ["a", "b", "c", "d", "e"]), "select");
    assert.equal(rowKind({ kind: "text" }, { type: "combo" }), "text");
    assert.equal(segmentFits(["a very long option label", "another long label"]), false);
});
