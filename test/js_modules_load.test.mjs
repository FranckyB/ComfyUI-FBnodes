// Every script in js/ loads. A name that is removed but still used is a
// ReferenceError only when the module runs, which node --check never sees;
// in ComfyUI it silently kills every node that shares the module.
// ComfyUI's own scripts (app, api, ...) are stand-ins here.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";

const STUB = `
const anything = new Proxy(function () {}, { get: (_t, key) => (key === "then" ? undefined : anything), apply: () => anything, construct: () => anything });
export const app = anything;
export const api = anything;
export const ComfyWidgets = {};
export default anything;
`;
const HOOKS = `
export async function resolve(specifier, context, next) {
  if (/\\/scripts\\/[\\w.]+\\.js$/.test(specifier)) return { url: "data:text/javascript," + encodeURIComponent(${JSON.stringify(STUB)}), shortCircuit: true };
  return next(specifier, context);
}`;
register(`data:text/javascript,${encodeURIComponent(HOOKS)}`);

const element = () => new Proxy({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, dataset: {} }, { get: (t, key) => (key in t ? t[key] : () => element()) });
globalThis.window ??= globalThis;
globalThis.addEventListener ??= () => {};
globalThis.document ??= { getElementById: () => null, createElement: element, head: element(), body: element(), addEventListener() {}, querySelector: () => null };
globalThis.LiteGraph ??= {};

const dir = new URL("../js/", import.meta.url);
for (const file of readdirSync(dir).filter((name) => name.endsWith(".js"))) {
  test(`js/${file} loads`, async () => {
    await assert.doesNotReject(import(new URL(file, dir).href));
  });
}
