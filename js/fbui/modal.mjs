// Modals and context menus in the kit's look. One backdrop, one z-index
// scale, Escape and a click outside close, and keys typed inside stay out of
// the canvas.
import { el } from "./dom.mjs";
import { button, ICONS } from "./controls.mjs";
import { ensureKitCss, T, Z_MODAL } from "./theme.mjs";

// Open modals, newest last: Escape closes only the top one.
const stack = [];

// openModal({ title, body, footer, width, height, onClose }) -> { overlay, modal, body, close, isTop }.
// `body` and `footer` are elements (or arrays of elements).
export function openModal({ title = "", body = null, footer = null, width = null, height = null, onClose = null } = {}) {
  ensureKitCss();
  const overlay = el("div", "fbui-overlay");
  const modal = el("div", "fbui-modal");
  const size = (value) => (typeof value === "number" ? `${value}px` : value);
  if (width) modal.style.width = size(width);
  if (height) modal.style.height = size(height);
  const head = el("div", "fbui-modal-head");
  head.append(el("span", "title", title));
  const close = () => {
    if (!overlay.isConnected) return;
    overlay.remove();
    stack.splice(stack.indexOf(close), 1);
    document.removeEventListener("keydown", onKey, true);
    onClose?.();
  };
  head.append(button("", { icon: ICONS.close, small: true, title: "Close (Esc)", onClick: close }));
  modal.append(head);
  const content = el("div", "fbui-modal-body");
  for (const item of [body].flat()) if (item) content.append(item);
  modal.append(content);
  if (footer) {
    const foot = el("div", "fbui-modal-foot");
    for (const item of [footer].flat()) if (item) foot.append(item);
    modal.append(foot);
  }
  overlay.append(modal);
  const onKey = (event) => {
    if (event.key !== "Escape" || stack[stack.length - 1] !== close) return;
    event.stopPropagation();
    close();
  };
  overlay.addEventListener("pointerdown", (event) => {
    if (event.target === overlay) close();
  });
  overlay.addEventListener("keydown", (event) => event.stopPropagation());
  document.addEventListener("keydown", onKey, true);
  document.body.append(overlay);
  stack.push(close);
  return { overlay, modal, body: content, close, isTop: () => stack[stack.length - 1] === close };
}

// prompt({ title, message, value, placeholder, confirmText }) -> Promise<string | null>:
// the trimmed text on OK or Enter, null on Cancel or Escape.
export function prompt({ title = "", message = "", value = "", placeholder = "", confirmText = "OK" } = {}) {
  return new Promise((resolve) => {
    let answer = null;
    const field = el("input", "fbui-text");
    field.type = "text";
    field.spellcheck = false;
    field.value = value;
    field.placeholder = placeholder;
    field.style.width = "min(520px, 70vw)";
    const text = el("div", "", message);
    text.style.cssText = "margin-bottom:8px;max-width:520px;line-height:1.45;color:" + T.label;
    const accept = () => {
      answer = field.value.trim() || null;
      dialog.close();
    };
    field.addEventListener("keydown", (event) => {
      if (event.key === "Enter") accept();
    });
    const dialog = openModal({
      title,
      body: [message ? text : null, field],
      footer: [button("Cancel", { onClick: () => dialog.close() }), button(confirmText, { primary: true, onClick: accept })],
      onClose: () => resolve(answer),
    });
    dialog.overlay.style.zIndex = String(Z_MODAL + stack.length);
    field.focus();
    field.select();
  });
}

// confirm({ title, message, confirmText, danger }) -> Promise<boolean>.
export function confirm({ title = "Are you sure?", message = "", confirmText = "OK", danger = false } = {}) {
  return new Promise((resolve) => {
    let answer = false;
    const text = el("div", "", message);
    text.style.cssText = "max-width:420px;line-height:1.45";
    const cancel = button("Cancel", { onClick: () => dialog.close() });
    const ok = button(confirmText, { primary: !danger, danger, onClick: () => { answer = true; dialog.close(); } });
    if (danger) ok.style.background = T.danger;
    const dialog = openModal({ title, body: text, footer: [cancel, ok], onClose: () => resolve(answer) });
    dialog.overlay.style.zIndex = String(Z_MODAL + stack.length);
    ok.focus();
  });
}

// openMenu(clientX, clientY, [{ label, action, disabled, danger }]) at the
// pointer, kept inside the viewport; closes on pick or any outside press.
export function openMenu(x, y, items) {
  ensureKitCss();
  document.querySelector(".fbui-menu")?.remove();
  const menu = el("div", "fbui-menu");
  const close = () => {
    menu.remove();
    document.removeEventListener("pointerdown", outside, true);
  };
  const outside = (event) => {
    if (menu.contains(event.target)) return;
    close();
    // The press that closes the menu must not also click what is under it.
    const swallow = (click) => {
      click.stopPropagation();
      click.preventDefault();
    };
    document.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => document.removeEventListener("click", swallow, true), 400);
  };
  for (const item of items) {
    const entry = el("button", item.danger ? "danger" : "", item.label);
    entry.type = "button";
    entry.disabled = Boolean(item.disabled);
    if (item.disabled) entry.style.opacity = ".45";
    entry.addEventListener("click", () => {
      close();
      item.action?.();
    });
    menu.append(entry);
  }
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${Math.max(0, x - rect.width)}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${Math.max(0, y - rect.height)}px`;
  setTimeout(() => document.addEventListener("pointerdown", outside, true), 0);
  return { menu, close };
}
