// The settings rows Save Image+ and Save Video+ share: filename_prefix as a
// Folder | Name pair (as AusBoss's savers), lit chips for on/off widgets (as
// Load Image+'s tools), dropdowns for combo widgets, and three equal columns
// so the rows line up.
import { button, info } from "../fbui/controls.js";
import { el, keepKeyInField } from "../fbui/dom.js";
import { comboValues, findWidget } from "../fbui/widgets.js";

export const THIRDS = "display:grid;grid-template-columns:repeat(3,minmax(0,1fr))";
// A chip row narrower than this shows icons only.
const CHIP_LABELS_MIN = 230;

const splitPrefix = (prefix) => {
    const text = String(prefix ?? "");
    const cut = text.lastIndexOf("/");
    return cut < 0 ? ["", text] : [text.slice(0, cut), text.slice(cut + 1)];
};

// One half of filename_prefix: the folder (before the last /, part 0) or the
// name (part 1). Both write the one widget, so nothing else changes. The
// folder's label carries the keyword help.
export function prefixControl(part, { help, name }) {
    return (node, card) => {
        const input = el("input", "fbui-text");
        input.type = "text";
        input.spellcheck = false;
        input.placeholder = part === 0 ? "the output folder itself" : name;
        input.title = part === 0 ? "Folder in the output folder; / makes subfolders." : "File name; _00001, _00002 … are added when taken.";
        input.addEventListener("change", () => {
            const parts = splitPrefix(findWidget(node, "filename_prefix")?.value);
            parts[part] = part === 0 ? input.value.replace(/^\/+|\/+$/g, "") : input.value.replace(/\//g, "_");
            card.setWidget("filename_prefix", parts[0] ? `${parts[0]}/${parts[1]}` : parts[1]);
        });
        input.addEventListener("keydown", (event) => {
            keepKeyInField(event);
            if (event.key === "Enter") input.blur();
        });
        const label = el("span", "fbui-label");
        label.style.cssText = "display:flex;align-items:center;gap:6px";
        label.append(part === 0 ? "Folder" : "Name");
        if (part === 0) label.append(info(help));
        return {
            element: input,
            label,
            sync() {
                if (document.activeElement !== input) input.value = splitPrefix(findWidget(node, "filename_prefix")?.value)[part];
            },
        };
    };
}

// A chip for a BOOLEAN widget: lit while on (the bright blue fill of an
// enabled choice, as a picked segment), greyed while `active()` says it has
// no effect. -> { element, sync() }
export function chip(node, card, name, { text, icon, title, active = () => true }) {
    const element = button(text, { icon, grow: true, title, onClick: () => card.setWidget(name, !findWidget(node, name)?.value) });
    return {
        element,
        sync() {
            const live = active();
            element.disabled = !live;
            element.classList.toggle("primary", live && Boolean(findWidget(node, name)?.value));
        },
    };
}

// A row of THIRDS; its chips drop their words while it is narrow.
export function chipRow(...items) {
    const field = el("div", "fbui-field");
    field.style.cssText = THIRDS;
    field.append(...items.map((item) => item.element ?? item));
    const chips = items.filter((item) => item.element?.classList.contains("fbui-btn"));
    new ResizeObserver(() => {
        for (const { element } of chips) element.querySelector("span").hidden = field.clientWidth < CHIP_LABELS_MIN;
    }).observe(field);
    return field;
}

// A dropdown for a combo widget, listing its current choices (they may
// follow another setting). `labels` shortens values. -> { element, sync() }
export function comboSelect(node, card, name, { title, labels = {} }) {
    const select = el("select", "fbui-select");
    select.title = title;
    select.addEventListener("change", () => card.setWidget(name, select.value));
    let shown = "";
    return {
        element: select,
        sync() {
            const widget = findWidget(node, name);
            const values = comboValues(widget);
            if (values.join("\n") !== shown) {
                shown = values.join("\n");
                select.replaceChildren(...values.map((value) => Object.assign(el("option", "", labels[value] ?? value), { value, title: value })));
            }
            select.value = String(widget?.value ?? "");
        },
    };
}
