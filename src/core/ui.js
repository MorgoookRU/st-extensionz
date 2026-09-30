// Small DOM builders for settings controls and the wand ("magic wand") menu.
// All controls use SillyTavern's own classes so they follow the active theme.

import { el, delay } from './st.js';
import { save } from './settings.js';

let uid = 0;
const nextId = (prefix) => `stx_${prefix}_${++uid}`;

function note(text) {
    return text ? el('small', { class: 'stx-note', text }) : null;
}

export function checkbox(obj, key, label, { hint, onChange } = {}) {
    const id = nextId('cb');
    const input = el('input', { type: 'checkbox', id });
    input.checked = !!obj[key];
    input.addEventListener('change', () => {
        obj[key] = input.checked;
        save();
        onChange?.(input.checked);
    });
    return el('div', { class: 'stx-field' },
        el('label', { class: 'checkbox_label stx-check', for: id }, input, el('span', { text: label })),
        note(hint),
    );
}

export function select(obj, key, label, options, { hint, onChange } = {}) {
    const id = nextId('sel');
    const input = el('select', { id, class: 'text_pole' },
        options.map(option => el('option', { value: option.value, text: option.label })));
    input.value = String(obj[key]);
    input.addEventListener('change', () => {
        obj[key] = input.value;
        save();
        onChange?.(input.value);
    });
    return el('div', { class: 'stx-field' },
        el('label', { for: id, class: 'stx-label', text: label }),
        input,
        note(hint),
    );
}

export function range(obj, key, label, { min = 0, max = 100, step = 1, suffix = '', hint, onChange } = {}) {
    const id = nextId('rng');
    const input = el('input', { type: 'range', id, min, max, step });
    input.value = String(obj[key]);
    const value = el('span', { class: 'stx-range-value', text: `${obj[key]}${suffix}` });
    input.addEventListener('input', () => {
        obj[key] = Number(input.value);
        value.textContent = `${input.value}${suffix}`;
        save();
        onChange?.(obj[key]);
    });
    return el('div', { class: 'stx-field' },
        el('label', { for: id, class: 'stx-label' }, label, ' ', value),
        input,
        note(hint),
    );
}

export function textInput(obj, key, label, { hint, placeholder = '', onChange } = {}) {
    const id = nextId('txt');
    const input = el('input', { type: 'text', id, class: 'text_pole', placeholder });
    input.value = String(obj[key] ?? '');
    input.addEventListener('input', () => {
        obj[key] = input.value;
        save();
        onChange?.(input.value);
    });
    return el('div', { class: 'stx-field' },
        el('label', { for: id, class: 'stx-label', text: label }),
        input,
        note(hint),
    );
}

export function numberInput(obj, key, label, { min, max, step = 1, hint, onChange } = {}) {
    const id = nextId('num');
    const input = el('input', { type: 'number', id, class: 'text_pole', min, max, step });
    input.value = String(obj[key]);
    input.addEventListener('change', () => {
        let value = Number(input.value);
        if (!Number.isFinite(value)) value = obj[key];
        if (min !== undefined) value = Math.max(min, value);
        if (max !== undefined) value = Math.min(max, value);
        input.value = String(value);
        obj[key] = value;
        save();
        onChange?.(value);
    });
    return el('div', { class: 'stx-field' },
        el('label', { for: id, class: 'stx-label', text: label }),
        input,
        note(hint),
    );
}

export function textarea(obj, key, label, { hint, placeholder = '', rows = 6, onChange, debounceMs = 400 } = {}) {
    const id = nextId('ta');
    const input = el('textarea', { id, class: 'text_pole stx-textarea', rows, placeholder, spellcheck: 'false' });
    input.value = String(obj[key] ?? '');
    let timer = null;
    input.addEventListener('input', () => {
        obj[key] = input.value;
        save();
        clearTimeout(timer);
        timer = setTimeout(() => onChange?.(input.value), debounceMs);
    });
    const wrapper = el('div', { class: 'stx-field' },
        el('label', { for: id, class: 'stx-label', text: label }),
        input,
        note(hint),
    );
    wrapper.setValue = (text) => {
        input.value = text;
        obj[key] = text;
        save();
        onChange?.(text);
    };
    return wrapper;
}

export function colorInput(obj, key, label, { onChange } = {}) {
    const id = nextId('clr');
    const input = el('input', { type: 'color', id, class: 'stx-color' });
    input.value = String(obj[key]);
    input.addEventListener('input', () => {
        obj[key] = input.value;
        save();
        onChange?.(input.value);
    });
    return el('div', { class: 'stx-field stx-inline' },
        input,
        el('label', { for: id, text: label }),
    );
}

const CODE_NAMES = {
    Space: 'Space', Escape: 'Esc', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
    Backslash: '\\', Semicolon: ';', Quote: '\'', Comma: ',', Period: '.', Slash: '/', ArrowUp: '↑', ArrowDown: '↓',
    ArrowLeft: '←', ArrowRight: '→', Enter: 'Enter', Backspace: 'Backspace', Delete: 'Del', Insert: 'Ins',
    Home: 'Home', End: 'End', PageUp: 'PgUp', PageDown: 'PgDn', Pause: 'Pause', ScrollLock: 'ScrLk',
};

/** Layout-independent combo string, e.g. "Alt+KeyX". Uses KeyboardEvent.code so it works with any keyboard layout. */
export function comboFromEvent(event) {
    const parts = [];
    if (event.ctrlKey) parts.push('Ctrl');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    if (event.metaKey) parts.push('Meta');
    parts.push(event.code);
    return parts.join('+');
}

export function formatCombo(combo) {
    if (!combo) return '—';
    return combo.split('+').map(part => {
        if (part.startsWith('Key')) return part.slice(3);
        if (part.startsWith('Digit')) return part.slice(5);
        if (part.startsWith('Numpad')) return `Num${part.slice(6)}`;
        return CODE_NAMES[part] ?? part;
    }).join(' + ');
}

const MODIFIER_CODES = new Set(['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight']);

export function hotkeyInput(obj, key, label, { hint, placeholder = '', clearLabel = '✕', onChange } = {}) {
    const id = nextId('hk');
    const input = el('input', { type: 'text', id, class: 'text_pole stx-hotkey', readonly: true, placeholder });
    input.value = formatCombo(obj[key]);
    input.addEventListener('keydown', (event) => {
        if (MODIFIER_CODES.has(event.code)) return;
        event.preventDefault();
        event.stopPropagation();
        obj[key] = comboFromEvent(event);
        input.value = formatCombo(obj[key]);
        save();
        onChange?.(obj[key]);
    });
    const clear = el('div', { class: 'menu_button stx-small-btn', title: clearLabel, text: '✕' });
    clear.addEventListener('click', () => {
        obj[key] = '';
        input.value = formatCombo('');
        save();
        onChange?.('');
    });
    return el('div', { class: 'stx-field' },
        el('label', { for: id, class: 'stx-label', text: label }),
        el('div', { class: 'stx-inline' }, input, clear),
        note(hint),
    );
}

export function button(label, icon, onClick, { title, cls = '' } = {}) {
    const node = el('div', { class: `menu_button menu_button_icon stx-btn ${cls}`, title: title ?? label },
        icon ? el('i', { class: `fa-solid ${icon}` }) : null,
        el('span', { text: label }),
    );
    node.addEventListener('click', onClick);
    return node;
}

export function section(title) {
    return el('div', { class: 'stx-section-title', text: title });
}

export function row(...children) {
    return el('div', { class: 'stx-row' }, ...children);
}

// ---------------------------------------------------------------- wand menu

async function getWandContainer() {
    for (let i = 0; i < 100; i++) {
        const menu = document.getElementById('extensionsMenu');
        if (menu) {
            let container = document.getElementById('stx_wand_container');
            if (!container) {
                container = el('div', { id: 'stx_wand_container', class: 'extension_container' });
                menu.append(container);
            }
            return container;
        }
        await delay(100);
    }
    return null;
}

/**
 * Adds an entry to SillyTavern's wand menu (the one with "Generate Image", "Token Counter", ...).
 * @returns {Promise<{item: HTMLElement, setLabel: (s: string) => void, setIcon: (s: string) => void, setActive: (b: boolean) => void, remove: () => void}>}
 */
export async function addWandItem({ id, icon, label, onClick, order = 0 }) {
    const container = await getWandContainer();
    const iconEl = el('div', { class: `fa-solid fa-fw ${icon} extensionsMenuExtensionButton` });
    const labelEl = el('span', { text: label });
    const item = el('div', { id, class: 'list-group-item flex-container flexGap5 interactable stx-wand-item', tabindex: 0, dataset: { order: String(order) } }, iconEl, labelEl);
    item.addEventListener('click', onClick);
    item.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onClick(event);
        }
    });
    if (container) {
        const after = [...container.children].find(child => Number(child.dataset.order) > order);
        container.insertBefore(item, after ?? null);
    }
    return {
        item,
        setLabel: (text) => { labelEl.textContent = text; },
        setIcon: (next) => { iconEl.className = `fa-solid fa-fw ${next} extensionsMenuExtensionButton`; },
        setActive: (active) => item.classList.toggle('stx-active', !!active),
        remove: () => item.remove(),
    };
}
