// Thin, version-tolerant wrappers around the SillyTavern extension API.
// Everything goes through SillyTavern.getContext() so the suite does not depend
// on internal file paths that change between releases.

import { t } from './i18n.js';

export const ctx = () => SillyTavern.getContext();

export const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export function debounce(fn, ms) {
    let timer = null;
    const wrapped = (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
    wrapped.flush = (...args) => {
        clearTimeout(timer);
        fn(...args);
    };
    wrapped.cancel = () => clearTimeout(timer);
    return wrapped;
}

export function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** FNV-1a, 32 bit. Stable pseudo-random decisions that do not flicker between re-renders. */
export function hashString(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

/**
 * Subscribes to a SillyTavern event by its event_types key (e.g. 'CHAT_CHANGED').
 * Unknown keys are ignored so older ST builds do not break the whole suite.
 */
export function onEvent(typeKey, handler) {
    const { eventSource, eventTypes } = ctx();
    const type = eventTypes?.[typeKey];
    if (!type) {
        return () => { };
    }
    eventSource.on(type, handler);
    return () => eventSource.removeListener?.(type, handler);
}

export function isGeneratingNow() {
    const stop = document.getElementById('mes_stop');
    return !!stop && getComputedStyle(stop).display !== 'none';
}

export function getChatElement() {
    return document.getElementById('chat');
}

export function getMessageElement(mesId) {
    return document.querySelector(`#chat .mes[mesid="${Number(mesId)}"]`);
}

export function flashElement(element) {
    if (!element) return;
    element.classList.remove('stx-flash');
    void element.offsetWidth;
    element.classList.add('stx-flash');
    setTimeout(() => element.classList.remove('stx-flash'), 2200);
}

/**
 * Scrolls the chat to a message, loading older messages when it is not rendered yet.
 * @param {number} mesId
 * @returns {Promise<HTMLElement|null>}
 */
export async function jumpToMessage(mesId) {
    const id = Number(mesId);
    const { chat } = ctx();
    if (!Number.isInteger(id) || id < 0 || id >= chat.length) {
        return null;
    }

    let element = getMessageElement(id);
    let guard = 0;
    while (!element && guard++ < 500) {
        const more = document.getElementById('show_more_messages');
        if (!more) break;
        more.click();
        await delay(30);
        element = getMessageElement(id);
    }

    if (!element) {
        return null;
    }

    const chatEl = getChatElement();
    if (chatEl) {
        const top = element.getBoundingClientRect().top - chatEl.getBoundingClientRect().top + chatEl.scrollTop;
        chatEl.scrollTo({ top: Math.max(0, top - 12), behavior: 'smooth' });
    } else {
        element.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
    flashElement(element);
    return element;
}

export function scrollChatTo(where) {
    const chatEl = getChatElement();
    if (!chatEl) return;
    chatEl.scrollTo({ top: where === 'top' ? 0 : chatEl.scrollHeight, behavior: 'smooth' });
}

export async function jumpToFirstMessage() {
    let guard = 0;
    while (document.getElementById('show_more_messages') && guard++ < 500) {
        document.getElementById('show_more_messages').click();
        await delay(30);
    }
    scrollChatTo('top');
}

/**
 * Registers a slash command. Silently skips if the parser API is unavailable.
 * @param {object} props
 * @param {string} props.name
 * @param {string[]} [props.aliases]
 * @param {(args: object, value: string) => any} props.callback
 * @param {string} props.helpString
 * @param {{description: string, enumList?: string[], isRequired?: boolean}} [props.unnamedArg]
 */
export function registerSlashCommand({ name, aliases = [], callback, helpString, unnamedArg }) {
    try {
        const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = ctx();
        if (!SlashCommandParser?.addCommandObject || !SlashCommand?.fromProps) return;
        const unnamedArgumentList = unnamedArg ? [
            SlashCommandArgument.fromProps({
                description: unnamedArg.description,
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: !!unnamedArg.isRequired,
                enumList: unnamedArg.enumList ?? [],
            }),
        ] : [];
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name,
            aliases,
            callback: async (args, value) => {
                const result = await callback(args, String(value ?? '').trim());
                return result === undefined || result === null ? '' : String(result);
            },
            helpString,
            unnamedArgumentList,
            returns: 'string',
        }));
    } catch (error) {
        console.warn(`[Extensionz] Failed to register /${name}`, error);
    }
}

export function isMobileDevice() {
    try {
        return !!ctx().isMobile?.() || matchMedia('(pointer: coarse)').matches;
    } catch {
        return false;
    }
}

/**
 * Opens a ST popup with arbitrary DOM content and returns the Popup instance
 * (call `popup.completeCancelled()` to close it programmatically).
 */
export function openPopup(content, options = {}) {
    const { Popup, POPUP_TYPE } = ctx();
    const popup = new Popup(content, POPUP_TYPE.TEXT, '', {
        wide: true,
        allowVerticalScrolling: true,
        leftAlign: true,
        // A visible way to close: phones have no Esc key.
        okButton: t('common.close'),
        cancelButton: false,
        ...options,
    });
    // The corner ✕ that SillyTavern shows only for image popups; it closes like Esc.
    if (popup.closeButton) popup.closeButton.style.display = 'block';
    popup.show();
    return popup;
}

export function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (value === undefined || value === null || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'html') node.innerHTML = value;
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat()) {
        if (child === null || child === undefined || child === false) continue;
        node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
}
