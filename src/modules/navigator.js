// Navigator: full-text search over the whole chat (including messages that are not rendered
// and alternative swipes) plus per-chat bookmarks that survive message deletion.

import { t } from '../core/i18n.js';
import { moduleSettings, save } from '../core/settings.js';
import { foldForSearch } from '../core/text.js';
import {
    ctx, el, debounce, escapeHtml, jumpToMessage, jumpToFirstMessage, scrollChatTo, openPopup,
    registerSlashCommand, onEvent, getChatElement,
} from '../core/st.js';
import * as ui from '../core/ui.js';

const ID = 'navigator';
const META_KEY = 'stx_bookmarks';
const MAX_RESULTS = 300;

const defaults = {
    enabled: true,
    searchHotkey: 'Ctrl+Shift+KeyF',
    includeSwipes: true,
    includeReasoning: false,
    wholeWords: false,
    showMessageButton: true,
    lastQuery: '',
};

let s = null;
let enabled = false;
let wandSearch = null;
let wandPins = null;
let chatObserver = null;
let highlightTimer = null;

// ------------------------------------------------------------------ search

/** Splits a query into terms; "quoted phrases" stay together. */
function parseQuery(query) {
    const terms = [];
    const re = /"([^"]+)"|(\S+)/g;
    let match;
    while ((match = re.exec(query))) {
        const term = foldForSearch((match[1] ?? match[2]).trim());
        if (term) terms.push(term);
    }
    return terms;
}

function isWordChar(ch) {
    return !!ch && /[\p{L}\p{N}_]/u.test(ch);
}

function findTerm(folded, term, wholeWords, from = 0) {
    let index = folded.indexOf(term, from);
    while (index !== -1 && wholeWords) {
        if (!isWordChar(folded[index - 1]) && !isWordChar(folded[index + term.length])) break;
        index = folded.indexOf(term, index + 1);
    }
    return index;
}

function makeSnippet(text, terms, wholeWords) {
    const folded = foldForSearch(text);
    const first = findTerm(folded, terms[0], wholeWords);
    const start = Math.max(0, first - 70);
    const end = Math.min(text.length, first + terms[0].length + 130);
    const slice = text.slice(start, end);
    const foldedSlice = folded.slice(start, end);

    const marks = [];
    for (const term of terms) {
        let index = findTerm(foldedSlice, term, wholeWords);
        while (index !== -1) {
            marks.push([index, index + term.length]);
            index = findTerm(foldedSlice, term, wholeWords, index + term.length);
        }
    }
    marks.sort((a, b) => a[0] - b[0]);

    let html = '';
    let cursor = 0;
    for (const [from, to] of marks) {
        if (from < cursor) continue;
        html += escapeHtml(slice.slice(cursor, from)) + '<mark>' + escapeHtml(slice.slice(from, to)) + '</mark>';
        cursor = to;
    }
    html += escapeHtml(slice.slice(cursor));
    html = html.replace(/\s+/g, ' ');
    return `${start > 0 ? '…' : ''}${html}${end < text.length ? '…' : ''}`;
}

function searchChat(query, filter) {
    const terms = parseQuery(query);
    if (!terms.length) return { terms, results: [], total: 0 };
    const { chat } = ctx();
    const results = [];
    let total = 0;

    const test = (text) => {
        if (!text) return false;
        const folded = foldForSearch(text);
        return terms.every(term => findTerm(folded, term, s.wholeWords) !== -1);
    };

    for (let id = chat.length - 1; id >= 0; id--) {
        const message = chat[id];
        if (!message) continue;
        if (filter === 'user' && !message.is_user) continue;
        if (filter === 'char' && (message.is_user || message.is_system)) continue;

        const sources = [{ text: message.mes, swipe: null }];
        if (s.includeReasoning && message.extra?.reasoning) sources.push({ text: message.extra.reasoning, swipe: null, reasoning: true });
        if (s.includeSwipes && Array.isArray(message.swipes) && message.swipes.length > 1) {
            message.swipes.forEach((text, index) => {
                if (index !== message.swipe_id) sources.push({ text, swipe: index });
            });
        }

        for (const source of sources) {
            if (!test(source.text)) continue;
            total++;
            if (results.length < MAX_RESULTS) {
                results.push({
                    id,
                    name: message.name,
                    isUser: !!message.is_user,
                    swipe: source.swipe,
                    swipeCount: message.swipes?.length ?? 1,
                    reasoning: !!source.reasoning,
                    snippet: makeSnippet(source.text, terms, s.wholeWords),
                });
            }
        }
    }
    return { terms, results, total };
}

/** Highlights search terms inside a rendered message using the CSS Custom Highlight API. */
function highlightInMessage(element, terms) {
    const HighlightCtor = globalThis.Highlight;
    if (!element || !terms.length || typeof CSS === 'undefined' || !CSS.highlights || typeof HighlightCtor !== 'function') return;
    const container = element.querySelector('.mes_text');
    if (!container) return;
    const ranges = [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
        const folded = foldForSearch(node.nodeValue);
        for (const term of terms) {
            let index = findTerm(folded, term, s.wholeWords);
            while (index !== -1) {
                const range = new Range();
                range.setStart(node, index);
                range.setEnd(node, Math.min(node.nodeValue.length, index + term.length));
                ranges.push(range);
                index = findTerm(folded, term, s.wholeWords, index + term.length);
            }
        }
    }
    if (!ranges.length) return;
    CSS.highlights.set('stx-search', new HighlightCtor(...ranges));
    clearTimeout(highlightTimer);
    highlightTimer = setTimeout(() => CSS.highlights.delete('stx-search'), 6000);
}

export function openSearch(initialQuery) {
    const input = el('input', { type: 'search', class: 'text_pole stx-search-input', placeholder: t('nav.searchPlaceholder'), autocomplete: 'off' });
    input.value = initialQuery ?? s.lastQuery ?? '';

    let filter = 'all';
    const filterButtons = ['all', 'user', 'char'].map(value => {
        const button = el('div', { class: `menu_button stx-chip${value === filter ? ' stx-chip-on' : ''}`, text: t(`nav.filter.${value}`) });
        button.addEventListener('click', () => {
            filter = value;
            filterButtons.forEach(b => b.classList.toggle('stx-chip-on', b === button));
            run();
        });
        return button;
    });

    const wholeWords = ui.checkbox(s, 'wholeWords', t('nav.wholeWords'), { onChange: () => run() });
    const swipes = ui.checkbox(s, 'includeSwipes', t('nav.includeSwipes'), { onChange: () => run() });
    const reasoning = ui.checkbox(s, 'includeReasoning', t('nav.includeReasoning'), { onChange: () => run() });
    const status = el('div', { class: 'stx-search-status' });
    const list = el('div', { class: 'stx-results' });

    const gotoInput = el('input', { type: 'number', class: 'text_pole stx-goto-input', min: 0, placeholder: '#' });
    const gotoButton = ui.button(t('nav.goto'), 'fa-arrow-right', async () => {
        const id = Number(gotoInput.value);
        const { chat } = ctx();
        if (!Number.isInteger(id) || id < 0 || id >= chat.length) {
            toastr.warning(t('nav.gotoInvalid', { max: chat.length - 1 }));
            return;
        }
        popup.completeCancelled();
        await jumpToMessage(id);
    });
    gotoInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') gotoButton.click();
    });

    const toolbar = el('div', { class: 'stx-row stx-search-tools' },
        ui.button(t('nav.toTop'), 'fa-angles-up', async () => {
            popup.completeCancelled();
            await jumpToFirstMessage();
        }),
        ui.button(t('nav.toBottom'), 'fa-angles-down', () => {
            popup.completeCancelled();
            scrollChatTo('bottom');
        }),
        el('div', { class: 'stx-inline stx-goto' }, gotoInput, gotoButton),
    );

    const content = el('div', { class: 'stx-popup stx-search' },
        el('h3', { class: 'stx-popup-title' }, el('i', { class: 'fa-solid fa-magnifying-glass' }), ' ', t('nav.searchTitle')),
        input,
        el('div', { class: 'stx-row stx-filters' }, ...filterButtons),
        el('div', { class: 'stx-row stx-search-options' }, wholeWords, swipes, reasoning),
        status,
        list,
        toolbar,
    );

    function run() {
        const query = input.value.trim();
        s.lastQuery = query;
        save();
        list.replaceChildren();
        if (!query) {
            status.textContent = t('nav.searchHint', { count: ctx().chat.length });
            return;
        }
        const { terms, results, total } = searchChat(query, filter);
        status.textContent = total
            ? (total > results.length ? t('nav.foundMore', { total, shown: results.length }) : t('nav.found', { total }))
            : t('nav.nothing');

        for (const result of results) {
            const meta = [`#${result.id}`, result.name];
            if (result.swipe !== null) meta.push(t('nav.swipeOf', { n: result.swipe + 1, total: result.swipeCount }));
            if (result.reasoning) meta.push(t('nav.reasoning'));
            const item = el('div', { class: `stx-result${result.isUser ? ' stx-result-user' : ''}`, tabindex: 0 },
                el('div', { class: 'stx-result-meta', text: meta.join(' · ') }),
                el('div', { class: 'stx-result-snippet', html: result.snippet }),
            );
            const open = async () => {
                popup.completeCancelled();
                const element = await jumpToMessage(result.id);
                if (result.swipe === null && !result.reasoning) setTimeout(() => highlightInMessage(element, terms), 350);
                if (result.swipe !== null) toastr.info(t('nav.swipeHint', { n: result.swipe + 1 }));
            };
            item.addEventListener('click', open);
            item.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') open();
            });
            list.append(item);
        }
    }

    const debouncedRun = debounce(run, 180);
    input.addEventListener('input', debouncedRun);
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            debouncedRun.flush();
            list.querySelector('.stx-result')?.focus();
        }
    });

    const popup = openPopup(content, { wide: true, large: false, onOpen: () => { input.focus(); input.select(); } });
    run();
    setTimeout(() => input.focus(), 50);
    return popup;
}

// ------------------------------------------------------------------ bookmarks

function getBookmarks() {
    const metadata = ctx().chatMetadata;
    if (!metadata) return [];
    if (!Array.isArray(metadata[META_KEY])) metadata[META_KEY] = [];
    return metadata[META_KEY];
}

function saveBookmarks() {
    const c = ctx();
    if (typeof c.saveMetadataDebounced === 'function') c.saveMetadataDebounced();
    else c.saveMetadata?.();
}

/** Finds the current index of a bookmarked message, even if messages above it were deleted. */
function resolveBookmark(bookmark) {
    const { chat } = ctx();
    const direct = chat[bookmark.mesId];
    if (direct && (!bookmark.sendDate || direct.send_date === bookmark.sendDate)) return bookmark.mesId;
    if (bookmark.sendDate) {
        const index = chat.findIndex(m => m?.send_date === bookmark.sendDate && (!bookmark.name || m.name === bookmark.name));
        if (index !== -1) {
            bookmark.mesId = index;
            return index;
        }
    }
    return -1;
}

function findBookmarkIndex(mesId) {
    return getBookmarks().findIndex(b => resolveBookmark(b) === mesId);
}

function previewOf(message) {
    return String(message?.mes ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

export function toggleBookmark(mesId, note = '') {
    const { chat } = ctx();
    const message = chat[mesId];
    if (!message) return false;
    const bookmarks = getBookmarks();
    const existing = findBookmarkIndex(mesId);
    if (existing !== -1) {
        bookmarks.splice(existing, 1);
        toastr.info(t('nav.pinRemoved', { id: mesId }));
    } else {
        bookmarks.push({ mesId, sendDate: message.send_date ?? '', name: message.name ?? '', preview: previewOf(message), note, created: Date.now() });
        toastr.success(t('nav.pinAdded', { id: mesId }));
    }
    saveBookmarks();
    refreshBookmarkMarks();
    return existing === -1;
}

function refreshBookmarkMarks() {
    const chatEl = getChatElement();
    if (!chatEl) return;
    const pinned = new Set(enabled ? getBookmarks().map(resolveBookmark).filter(i => i >= 0) : []);
    for (const mes of chatEl.querySelectorAll('.mes')) {
        const on = pinned.has(Number(mes.getAttribute('mesid')));
        mes.classList.toggle('stx-pinned', on);
        const btn = mes.querySelector('.stx-pin-btn');
        if (btn) {
            btn.classList.toggle('fa-solid', on);
            btn.classList.toggle('fa-regular', !on);
        }
    }
}
const refreshBookmarkMarksDebounced = debounce(refreshBookmarkMarks, 80);

function injectMessageButtons() {
    const title = t('nav.pinButton');
    const make = () => el('div', { class: 'mes_button stx-pin-btn fa-regular fa-star', title });
    const template = document.querySelector('#message_template .extraMesButtons');
    if (template && !template.querySelector('.stx-pin-btn')) template.prepend(make());
    for (const buttons of document.querySelectorAll('#chat .mes .extraMesButtons')) {
        if (!buttons.querySelector('.stx-pin-btn')) buttons.prepend(make());
    }
    document.querySelectorAll('.stx-pin-btn').forEach(btn => { btn.title = title; });
}

function removeMessageButtons() {
    document.querySelectorAll('.stx-pin-btn').forEach(btn => btn.remove());
    document.querySelectorAll('.mes.stx-pinned').forEach(mes => mes.classList.remove('stx-pinned'));
}

function syncMessageButtons() {
    if (enabled && s.showMessageButton) injectMessageButtons();
    else removeMessageButtons();
    refreshBookmarkMarks();
}

function onPinButtonClick(event) {
    const mes = event.target.closest('.mes');
    if (!mes) return;
    event.stopPropagation();
    toggleBookmark(Number(mes.getAttribute('mesid')));
}

export function openBookmarks() {
    const { chat } = ctx();
    const list = el('div', { class: 'stx-results stx-pins' });
    const header = el('div', { class: 'stx-search-status' });

    const render = () => {
        const bookmarks = getBookmarks();
        list.replaceChildren();
        const items = bookmarks
            .map((bookmark, index) => ({ bookmark, index, mesId: resolveBookmark(bookmark) }))
            .sort((a, b) => (a.mesId < 0) - (b.mesId < 0) || a.mesId - b.mesId);
        header.textContent = items.length ? t('nav.pinsCount', { count: items.length }) : t('nav.pinsEmpty');

        for (const { bookmark, mesId } of items) {
            const broken = mesId < 0;
            const noteInput = el('input', { type: 'text', class: 'text_pole stx-pin-note', placeholder: t('nav.pinNotePlaceholder') });
            noteInput.value = bookmark.note ?? '';
            noteInput.addEventListener('input', () => {
                bookmark.note = noteInput.value;
                saveBookmarks();
            });
            noteInput.addEventListener('click', e => e.stopPropagation());

            const remove = el('div', { class: 'menu_button stx-small-btn fa-solid fa-trash-can', title: t('common.delete') });
            remove.addEventListener('click', (event) => {
                event.stopPropagation();
                const arr = getBookmarks();
                const index = arr.indexOf(bookmark);
                if (index !== -1) arr.splice(index, 1);
                saveBookmarks();
                refreshBookmarkMarks();
                render();
            });

            const message = broken ? null : chat[mesId];
            const item = el('div', { class: `stx-result stx-pin${broken ? ' stx-broken' : ''}`, tabindex: 0 },
                el('div', { class: 'stx-result-meta' },
                    el('i', { class: 'fa-solid fa-star stx-star' }), ' ',
                    broken ? t('nav.pinBroken') : `#${mesId} · ${message?.name ?? bookmark.name}`,
                ),
                el('div', { class: 'stx-result-snippet', text: broken ? bookmark.preview : previewOf(message) }),
                el('div', { class: 'stx-inline' }, noteInput, remove),
            );
            if (!broken) {
                item.addEventListener('click', async () => {
                    popup.completeCancelled();
                    await jumpToMessage(mesId);
                });
            }
            list.append(item);
        }
    };

    const addLast = ui.button(t('nav.pinLast'), 'fa-star', () => {
        const last = ctx().chat.length - 1;
        if (last < 0) return;
        if (findBookmarkIndex(last) === -1) toggleBookmark(last);
        render();
    });

    const content = el('div', { class: 'stx-popup' },
        el('h3', { class: 'stx-popup-title' }, el('i', { class: 'fa-solid fa-star' }), ' ', t('nav.pinsTitle')),
        header,
        list,
        el('div', { class: 'stx-row' }, addLast),
        el('small', { class: 'stx-note', text: t('nav.pinsHint') }),
    );
    const popup = openPopup(content, { wide: true });
    render();
    return popup;
}

// ------------------------------------------------------------------ module API

function onKeyDown(event) {
    if (!enabled || !s.searchHotkey) return;
    if (event.target instanceof HTMLElement && event.target.classList.contains('stx-hotkey')) return;
    if (ui.comboFromEvent(event) === s.searchHotkey) {
        event.preventDefault();
        event.stopPropagation();
        openSearch();
    }
}

function init() {
    s = moduleSettings(ID);
    window.addEventListener('keydown', onKeyDown, true);
    $(document).on('click', '.stx-pin-btn', onPinButtonClick);

    ['CHAT_CHANGED', 'MORE_MESSAGES_LOADED', 'MESSAGE_DELETED', 'CHARACTER_MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED'].forEach(type => {
        onEvent(type, () => {
            if (enabled) refreshBookmarkMarksDebounced();
        });
    });

    registerSlashCommand({
        name: 'chat-search',
        aliases: ['csearch'],
        helpString: t('nav.slashSearch'),
        unnamedArg: { description: 'query' },
        callback: (_, value) => {
            if (enabled) openSearch(value || undefined);
        },
    });
    registerSlashCommand({
        name: 'pin',
        helpString: t('nav.slashPin'),
        unnamedArg: { description: 'message id (default: last)' },
        callback: (_, value) => {
            if (!enabled) return '';
            const id = value === '' ? ctx().chat.length - 1 : Number(value);
            return toggleBookmark(id) ? 'pinned' : 'unpinned';
        },
    });
    registerSlashCommand({
        name: 'pins',
        helpString: t('nav.slashPins'),
        callback: () => {
            if (enabled) openBookmarks();
        },
    });
}

async function enable() {
    enabled = true;
    wandSearch = await ui.addWandItem({ id: 'stx_search_wand', icon: 'fa-magnifying-glass', label: t('nav.menuSearch'), onClick: () => openSearch(), order: 20 });
    wandPins = await ui.addWandItem({ id: 'stx_pins_wand', icon: 'fa-star', label: t('nav.menuPins'), onClick: () => openBookmarks(), order: 21 });
    syncMessageButtons();

    // Newly rendered messages come from the template; older ones may be re-rendered by other code.
    const chatEl = getChatElement();
    if (chatEl && !chatObserver) {
        chatObserver = new MutationObserver(() => {
            if (s.showMessageButton) injectMessageButtons();
            refreshBookmarkMarksDebounced();
        });
        chatObserver.observe(chatEl, { childList: true });
    }
}

function disable() {
    enabled = false;
    wandSearch?.remove();
    wandPins?.remove();
    wandSearch = wandPins = null;
    chatObserver?.disconnect();
    chatObserver = null;
    removeMessageButtons();
}

function onLanguageChange() {
    wandSearch?.setLabel(t('nav.menuSearch'));
    wandPins?.setLabel(t('nav.menuPins'));
    if (enabled && s.showMessageButton) injectMessageButtons();
}

function buildSettings(root) {
    root.append(
        ui.row(
            ui.button(t('nav.menuSearch'), 'fa-magnifying-glass', () => openSearch()),
            ui.button(t('nav.menuPins'), 'fa-star', () => openBookmarks()),
        ),
        ui.hotkeyInput(s, 'searchHotkey', t('nav.searchHotkey'), { placeholder: t('panic.hotkeyPlaceholder') }),
        ui.checkbox(s, 'showMessageButton', t('nav.showMessageButton'), { hint: t('nav.showMessageButtonHint'), onChange: syncMessageButtons }),
    );
}

export default {
    id: ID,
    icon: 'fa-compass',
    order: 20,
    defaults,
    titleKey: 'nav.title',
    descKey: 'nav.desc',
    init,
    enable,
    disable,
    buildSettings,
    onLanguageChange,
};
