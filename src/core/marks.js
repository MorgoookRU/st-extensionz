// Mark engine: decorates rendered chat text with <span> marks without touching chat data.
//
// Several modules (redaction, cliché radar) want to wrap pieces of message text. If each of
// them ran its own MutationObserver they would keep re-triggering each other, so they all
// register "decorators" here and a single observer re-applies every active decorator whenever
// SillyTavern (re)renders a message, including every streamed token.
//
// Mutation observer callbacks run as microtasks, i.e. before the browser paints, so marks are
// applied before the user can see the unmarked text.

import { getChatElement } from './st.js';

const MARK_ATTR = 'data-stx-mark';
const SKIP_TAGS = new Set(['TEXTAREA', 'INPUT', 'SCRIPT', 'STYLE', 'SELECT', 'OPTION', 'BUTTON', 'SVG', 'svg', 'CANVAS', 'IFRAME', 'NOSCRIPT', 'TEMPLATE']);
const BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'UL', 'OL', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'DETAILS', 'SUMMARY', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'ASIDE', 'NAV', 'FIGURE', 'FIGCAPTION', 'DL', 'DT', 'DD', 'HR', 'CENTER', 'MAIN']);

/**
 * @typedef {object} TextBlock
 * @property {string} text Concatenated text of the block (<br> becomes "\n")
 * @property {{node: Text, start: number, end: number}[]} segments
 */

/**
 * @typedef {object} MarkRange
 * @property {number} start
 * @property {number} end
 * @property {string} cls CSS class for the mark
 * @property {string} [title] Tooltip
 * @property {string|number} [group] Marks sharing a group can be handled together
 */

/**
 * @typedef {object} Decorator
 * @property {string} id
 * @property {number} order Lower runs first
 * @property {string} targets CSS selector of the containers the decorator handles
 * @property {() => boolean} isActive
 * @property {(text: string, info: object) => MarkRange[]} getRanges
 * @property {() => void} [beforePass] Called once before a batch of containers is processed
 */

function nearestBlock(node, root, cache) {
    let current = node.parentElement;
    const path = [];
    while (current && current !== root) {
        if (cache.has(current)) {
            const found = cache.get(current);
            path.forEach(p => cache.set(p, found));
            return found;
        }
        path.push(current);
        if (BLOCK_TAGS.has(current.tagName)) {
            path.forEach(p => cache.set(p, current));
            return current;
        }
        current = current.parentElement;
    }
    path.forEach(p => cache.set(p, root));
    return root;
}

/**
 * Collects text of a container grouped by block-level elements.
 * @param {HTMLElement} root
 * @returns {TextBlock[]}
 */
export function collectBlocks(root) {
    const blocks = [];
    const cache = new Map();
    let current = null;
    let currentBlockEl = null;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
        acceptNode(node) {
            if (node.nodeType === Node.ELEMENT_NODE) {
                if (SKIP_TAGS.has(node.tagName) || node.classList.contains('stx-nomark')) {
                    return NodeFilter.FILTER_REJECT;
                }
            }
            return NodeFilter.FILTER_ACCEPT;
        },
    });

    let node;
    while ((node = walker.nextNode())) {
        if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.tagName === 'BR' && current) current.text += '\n';
            continue;
        }
        const value = node.nodeValue;
        if (!value) continue;
        const blockEl = nearestBlock(node, root, cache);
        if (!current || blockEl !== currentBlockEl) {
            current = { text: '', segments: [] };
            currentBlockEl = blockEl;
            blocks.push(current);
        }
        current.segments.push({ node, start: current.text.length, end: current.text.length + value.length });
        current.text += value;
    }
    return blocks;
}

/**
 * Wraps the given ranges of a block into mark spans. Overlapping ranges produce one span
 * carrying all classes, so decorators never nest into each other.
 * @param {TextBlock} block
 * @param {MarkRange[]} ranges
 */
export function applyRanges(block, ranges) {
    if (!ranges.length) return;
    for (const segment of block.segments) {
        const covering = ranges.filter(r => r.start < segment.end && r.end > segment.start);
        if (!covering.length) continue;

        const length = segment.end - segment.start;
        const cuts = new Set([0, length]);
        for (const range of covering) {
            cuts.add(Math.max(0, Math.min(length, range.start - segment.start)));
            cuts.add(Math.max(0, Math.min(length, range.end - segment.start)));
        }
        const points = [...cuts].sort((a, b) => a - b);
        const text = segment.node.nodeValue;
        const fragment = document.createDocumentFragment();

        for (let i = 0; i < points.length - 1; i++) {
            const from = points[i];
            const to = points[i + 1];
            if (from === to) continue;
            const piece = text.slice(from, to);
            const absFrom = segment.start + from;
            const absTo = segment.start + to;
            const active = covering.filter(r => r.start <= absFrom && r.end >= absTo);
            if (!active.length) {
                fragment.append(document.createTextNode(piece));
                continue;
            }
            const span = document.createElement('span');
            span.setAttribute(MARK_ATTR, '');
            span.className = ['stx-mark', ...new Set(active.map(r => r.cls))].join(' ');
            const titles = [...new Set(active.map(r => r.title).filter(Boolean))];
            if (titles.length) span.title = titles.join('\n');
            const group = active.find(r => r.group !== undefined)?.group;
            if (group !== undefined) span.dataset.stxGroup = String(group);
            span.textContent = piece;
            fragment.append(span);
        }
        segment.node.replaceWith(fragment);
    }
}

/** Removes all marks from a container, restoring the original text nodes. */
export function unwrapMarks(root) {
    const marks = root.querySelectorAll(`[${MARK_ATTR}]`);
    if (!marks.length) return false;
    for (const mark of marks) {
        mark.replaceWith(...mark.childNodes);
    }
    root.normalize();
    return true;
}

function messageInfo(container) {
    const mes = container.closest('.mes');
    return {
        container,
        mes,
        mesId: Number(mes?.getAttribute('mesid')),
        isUser: mes?.getAttribute('is_user') === 'true',
        isSystem: mes?.getAttribute('is_system') === 'true',
        isReasoning: container.classList.contains('mes_reasoning'),
    };
}

class MarkEngine {
    constructor() {
        /** @type {Decorator[]} */
        this.decorators = [];
        this.observer = null;
        this.observedChat = null;
        this.version = 0;
        /** @type {WeakMap<Element, {text: string, marks: number, version: number}>} */
        this.processed = new WeakMap();
        /** @type {WeakMap<Element, {windowStart: number, count: number, pausedUntil: number}>} */
        this.rate = new WeakMap();
    }

    /**
     * Circuit breaker: streaming re-renders a message at most a few dozen times per second, so
     * hundreds of passes per second can only mean a fight with another script. Back off for a while.
     */
    throttled(container) {
        const now = Date.now();
        const entry = this.rate.get(container) ?? { windowStart: now, count: 0, pausedUntil: 0 };
        if (now < entry.pausedUntil) return true;
        if (now - entry.windowStart > 1000) {
            entry.windowStart = now;
            entry.count = 0;
        }
        entry.count++;
        this.rate.set(container, entry);
        if (entry.count > 150) {
            entry.pausedUntil = now + 3000;
            console.warn('[Extensionz] A message is being re-rendered in a loop by another script; pausing marks for it.');
            return true;
        }
        return false;
    }

    /** @param {Decorator} decorator */
    register(decorator) {
        this.decorators = this.decorators.filter(d => d.id !== decorator.id);
        this.decorators.push(decorator);
        this.decorators.sort((a, b) => a.order - b.order);
    }

    get allTargets() {
        return [...new Set(this.decorators.map(d => d.targets))].join(', ');
    }

    active() {
        return this.decorators.filter(d => {
            try {
                return d.isActive();
            } catch {
                return false;
            }
        });
    }

    /** Re-applies every decorator to every rendered message. Call after settings changes. */
    refresh() {
        const chat = getChatElement();
        if (!chat || !this.decorators.length) return;
        const active = this.active();
        this.version++;
        this.ensureObserver(chat, active.length > 0);
        active.forEach(d => d.beforePass?.());
        for (const container of chat.querySelectorAll(this.allTargets)) {
            this.process(container, active);
        }
        this.observer?.takeRecords();
    }

    snapshot(container) {
        return {
            text: container.textContent,
            marks: container.querySelectorAll(`[${MARK_ATTR}]`).length,
            version: this.version,
        };
    }

    process(container, active) {
        // Skip containers whose text and marks are exactly as we left them. Besides saving work,
        // this breaks ping-pong loops with other extensions that also observe message DOM.
        const before = this.snapshot(container);
        const last = this.processed.get(container);
        if (last && last.text === before.text && last.marks === before.marks && last.version === before.version) return;

        this.decorate(container, active);
        this.processed.set(container, this.snapshot(container));
    }

    decorate(container, active) {
        unwrapMarks(container);
        const decorators = active.filter(d => container.matches(d.targets));
        if (!decorators.length) return;

        const info = messageInfo(container);
        for (const block of collectBlocks(container)) {
            if (!block.text.trim()) continue;
            const ranges = [];
            for (const decorator of decorators) {
                try {
                    const result = decorator.getRanges(block.text, info);
                    if (result?.length) ranges.push(...result);
                } catch (error) {
                    console.warn(`[Extensionz] Decorator ${decorator.id} failed`, error);
                }
            }
            if (ranges.length) applyRanges(block, ranges);
        }
    }

    ensureObserver(chat, needed) {
        if (!needed) {
            this.observer?.disconnect();
            this.observer = null;
            this.observedChat = null;
            return;
        }
        if (this.observer && this.observedChat === chat) return;
        this.observer?.disconnect();
        this.observer = new MutationObserver(records => this.onMutations(records));
        this.observer.observe(chat, { childList: true, subtree: true, characterData: true });
        this.observedChat = chat;
    }

    onMutations(records) {
        const selector = this.allTargets;
        const containers = new Set();
        for (const record of records) {
            const target = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
            const container = target?.closest?.(selector);
            if (container) {
                containers.add(container);
                continue;
            }
            for (const added of record.addedNodes) {
                if (added.nodeType !== Node.ELEMENT_NODE) continue;
                if (added.matches(selector)) containers.add(added);
                added.querySelectorAll(selector).forEach(c => containers.add(c));
            }
        }
        if (!containers.size) return;

        const active = this.active();
        if (!active.length) return;
        active.forEach(d => d.beforePass?.());
        for (const container of containers) {
            if (container.isConnected && !this.throttled(container)) this.process(container, active);
        }
        // Drop the records produced by our own DOM changes, otherwise we would loop forever.
        this.observer?.takeRecords();
    }
}

export const markEngine = new MarkEngine();
