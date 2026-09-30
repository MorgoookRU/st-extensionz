// Drafts: the message you are typing is saved per chat and survives reloads, tab kills on
// phones and chat switching. Sent messages go to a history you can recall with Alt+↑ / Alt+↓.

import { t } from '../core/i18n.js';
import { moduleSettings } from '../core/settings.js';
import { ctx, el, debounce, openPopup, onEvent, registerSlashCommand } from '../core/st.js';
import * as ui from '../core/ui.js';

const ID = 'drafts';
const DRAFT_PREFIX = 'stx:draft:';
const LAST_PREFIX = 'stx:lastdraft:';
const HISTORY_KEY = 'stx:history';

const defaults = {
    enabled: true,
    perChat: true,
    notifyRestore: true,
    historySize: 50,
    historyHotkeys: true,
};

let s = null;
let enabled = false;
let wand = null;
let currentChatKey = null;
let seenChat = false;
let lastSavedValue = null;
let pollTimer = null;
let historyCursor = -1;
let historyStash = '';

const storage = {
    get(key) {
        try {
            return localStorage.getItem(key);
        } catch {
            return null;
        }
    },
    set(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch { /* quota / private mode */ }
    },
    remove(key) {
        try {
            localStorage.removeItem(key);
        } catch { /* ignore */ }
    },
};

function textarea() {
    return /** @type {HTMLTextAreaElement|null} */ (document.getElementById('send_textarea'));
}

function chatKey() {
    if (!s.perChat) return '__global';
    try {
        const id = ctx().getCurrentChatId?.();
        return id ? String(id) : null;
    } catch {
        return null;
    }
}

function setInputValue(value) {
    const input = textarea();
    if (!input) return;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    lastSavedValue = value;
}

function saveDraft(force = false) {
    const input = textarea();
    if (!enabled || !input || !currentChatKey) return;
    const value = input.value;
    if (!force && value === lastSavedValue) return;
    lastSavedValue = value;
    if (value.trim()) {
        storage.set(DRAFT_PREFIX + currentChatKey, value);
        storage.set(LAST_PREFIX + currentChatKey, value);
    } else {
        storage.remove(DRAFT_PREFIX + currentChatKey);
    }
}
const saveDraftDebounced = debounce(() => saveDraft(), 300);

function restoreDraftFor(key, { replace }) {
    const input = textarea();
    if (!input || !key) return;
    const draft = storage.get(DRAFT_PREFIX + key) ?? '';
    if (replace) {
        setInputValue(draft);
    } else if (!input.value.trim() && draft) {
        setInputValue(draft);
    } else {
        lastSavedValue = input.value;
        return;
    }
    if (draft && s.notifyRestore) toastr.info(t('drafts.restored'), '', { timeOut: 1800 });
}

function onChatChanged() {
    if (!enabled) return;
    const nextKey = chatKey();
    if (nextKey === currentChatKey) return;
    // Save what is in the box for the chat we are leaving before swapping content.
    saveDraft(true);
    // When switching between chats the box belongs to the new chat; on the very first load keep
    // whatever the user may already have typed.
    const replace = seenChat && s.perChat;
    currentChatKey = nextKey;
    historyCursor = -1;
    if (!nextKey) return;
    restoreDraftFor(nextKey, { replace });
    seenChat = true;
}

// ------------------------------------------------------------------ history

function getHistory() {
    try {
        const parsed = JSON.parse(storage.get(HISTORY_KEY) ?? '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function setHistory(items) {
    storage.set(HISTORY_KEY, JSON.stringify(items.slice(0, Math.max(1, s.historySize))));
}

function onMessageSent(messageId) {
    if (!enabled) return;
    const message = ctx().chat?.[messageId];
    if (message?.is_user && message.mes?.trim()) {
        const items = getHistory();
        if (items[0]?.text !== message.mes) {
            items.unshift({ text: message.mes, time: Date.now(), chat: ctx().name2 ?? '' });
            setHistory(items);
        }
    }
    historyCursor = -1;
    if (currentChatKey) storage.remove(DRAFT_PREFIX + currentChatKey);
    lastSavedValue = '';
}

function onTextareaKeyDown(event) {
    if (!enabled || !s.historyHotkeys || !event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    const items = getHistory();
    if (!items.length) return;
    event.preventDefault();
    event.stopPropagation();

    const input = textarea();
    if (historyCursor === -1) historyStash = input.value;
    historyCursor += event.key === 'ArrowUp' ? 1 : -1;
    historyCursor = Math.max(-1, Math.min(items.length - 1, historyCursor));
    setInputValue(historyCursor === -1 ? historyStash : items[historyCursor].text);
    input.setSelectionRange(input.value.length, input.value.length);
}

function insertIntoInput(text) {
    const input = textarea();
    if (!input) return;
    if (input.value.trim() && currentChatKey) storage.set(LAST_PREFIX + currentChatKey, input.value);
    setInputValue(text);
    saveDraft(true);
    input.focus();
}

function formatTime(timestamp) {
    try {
        return new Date(timestamp).toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch {
        return '';
    }
}

export function openHistory() {
    const list = el('div', { class: 'stx-results' });
    const makeItem = (text, meta, onRemove) => {
        const item = el('div', { class: 'stx-result', tabindex: 0 },
            el('div', { class: 'stx-result-meta', text: meta }),
            el('div', { class: 'stx-result-snippet stx-prewrap', text: text.length > 400 ? `${text.slice(0, 400)}…` : text }),
        );
        if (onRemove) {
            const remove = el('div', { class: 'menu_button stx-small-btn fa-solid fa-xmark stx-corner-btn', title: t('common.delete') });
            remove.addEventListener('click', (event) => {
                event.stopPropagation();
                onRemove();
            });
            item.append(remove);
        }
        const use = () => {
            popup.completeCancelled();
            insertIntoInput(text);
        };
        item.addEventListener('click', use);
        item.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') use();
        });
        return item;
    };

    const render = () => {
        list.replaceChildren();
        const last = currentChatKey ? storage.get(LAST_PREFIX + currentChatKey) : null;
        if (last) {
            list.append(el('div', { class: 'stx-section-title', text: t('drafts.lastDraft') }));
            list.append(makeItem(last, t('drafts.lastDraftMeta'), null));
        }
        const items = getHistory();
        list.append(el('div', { class: 'stx-section-title', text: t('drafts.sent', { count: items.length }) }));
        if (!items.length) list.append(el('div', { class: 'stx-note', text: t('drafts.empty') }));
        items.forEach((entry, index) => {
            const meta = [formatTime(entry.time), entry.chat].filter(Boolean).join(' · ');
            list.append(makeItem(entry.text, meta, () => {
                const all = getHistory();
                all.splice(index, 1);
                setHistory(all);
                render();
            }));
        });
    };

    const clear = ui.button(t('drafts.clearHistory'), 'fa-trash-can', () => {
        setHistory([]);
        render();
    });

    const content = el('div', { class: 'stx-popup' },
        el('h3', { class: 'stx-popup-title' }, el('i', { class: 'fa-solid fa-clock-rotate-left' }), ' ', t('drafts.historyTitle')),
        el('small', { class: 'stx-note', text: t('drafts.historyHint') }),
        list,
        el('div', { class: 'stx-row' }, clear),
    );
    const popup = openPopup(content, { wide: true });
    render();
    return popup;
}

// ------------------------------------------------------------------ module API

function onVisibility() {
    if (document.visibilityState === 'hidden') saveDraft(true);
}

function init() {
    s = moduleSettings(ID);
    onEvent('CHAT_CHANGED', onChatChanged);
    onEvent('MESSAGE_SENT', onMessageSent);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', () => saveDraft(true));
    $(document).on('input', '#send_textarea', () => {
        if (enabled) saveDraftDebounced();
    });
    // Capture phase: runs before SillyTavern's own ArrowUp handler ("edit last message").
    window.addEventListener('keydown', (event) => {
        if (event.target instanceof HTMLElement && event.target.id === 'send_textarea') onTextareaKeyDown(event);
    }, true);

    registerSlashCommand({
        name: 'input-history',
        helpString: t('drafts.slashHelp'),
        callback: () => {
            if (enabled) openHistory();
        },
    });
}

async function enable() {
    enabled = true;
    wand = await ui.addWandItem({ id: 'stx_history_wand', icon: 'fa-clock-rotate-left', label: t('drafts.menu'), onClick: () => openHistory(), order: 30 });
    currentChatKey = null;
    onChatChanged();
    // Programmatic changes (sending, slash commands) do not fire "input"; a cheap poll catches them.
    clearInterval(pollTimer);
    pollTimer = setInterval(() => saveDraft(), 1500);
}

function disable() {
    saveDraft(true);
    enabled = false;
    clearInterval(pollTimer);
    pollTimer = null;
    wand?.remove();
    wand = null;
}

function onLanguageChange() {
    wand?.setLabel(t('drafts.menu'));
}

function buildSettings(root) {
    root.append(
        ui.row(ui.button(t('drafts.menu'), 'fa-clock-rotate-left', () => openHistory())),
        ui.checkbox(s, 'perChat', t('drafts.perChat'), {
            hint: t('drafts.perChatHint'),
            onChange: () => {
                currentChatKey = chatKey();
                lastSavedValue = null;
                saveDraft(true);
            },
        }),
        ui.checkbox(s, 'notifyRestore', t('drafts.notifyRestore')),
        ui.checkbox(s, 'historyHotkeys', t('drafts.historyHotkeys'), { hint: t('drafts.historyHotkeysHint') }),
        ui.numberInput(s, 'historySize', t('drafts.historySize'), { min: 5, max: 500, onChange: () => setHistory(getHistory()) }),
    );
}

export default {
    id: ID,
    icon: 'fa-floppy-disk',
    order: 30,
    defaults,
    titleKey: 'drafts.title',
    descKey: 'drafts.desc',
    init,
    enable,
    disable,
    buildSettings,
    onLanguageChange,
};
