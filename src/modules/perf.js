// Performance: makes SillyTavern lighter on phones without changing how it looks.
//
// Invisible optimizations (on by default):
//  - off-screen messages are not rendered (content-visibility), so per-message blur, big theme
//    avatars and shadows cost nothing until the message scrolls into view;
//  - only the latest N messages stay in the DOM while you are at the bottom of the chat;
//  - huge static backgrounds and theme avatars (e.g. Moonlit Echoes) are downscaled to the
//    screen resolution — the same picture, a fraction of the memory. Animated images are skipped;
//  - chat images decode asynchronously and load lazily.
// Optional tweaks that do change the look (blur, animations, shadows) are off by default.

import { t } from '../core/i18n.js';
import { moduleSettings } from '../core/settings.js';
import { ctx, el, debounce, onEvent, getChatElement, isGeneratingNow, openPopup } from '../core/st.js';
import * as ui from '../core/ui.js';

const ID = 'perf';

const defaults = {
    enabled: true,
    offscreen: true,
    domLimit: true,
    domLimitCount: 60,
    optimizeImages: true,
    imageQuality: 'high',
    lazyImages: true,
    noBlur: false,
    noAnimations: false,
    noShadows: false,
    freezeAnimated: false,
};

const QUALITY_DPR = { max: 3, high: 2, eco: 1.25 };

let s = null;
let enabled = false;
let bgObserver = null;
let avatarObserver = null;
let avatarStyle = null;
let scrollHandler = null;
const imageResults = new Map(); // absolute url -> Promise<result|null>
const avatarRules = new Map(); // theme avatar path -> blob url
let imageQueue = Promise.resolve();
const skipped = new WeakSet();

// ------------------------------------------------------------------ body classes

function applyClasses() {
    const body = document.body;
    body.classList.toggle('stx-perf-cv', enabled && s.offscreen);
    body.classList.toggle('stx-perf-noblur', enabled && s.noBlur);
    body.classList.toggle('stx-perf-noanim', enabled && s.noAnimations);
    body.classList.toggle('stx-perf-noshadow', enabled && s.noShadows);
}

// Remembers which messages the browser currently skips rendering (Chrome 124+).
function onVisibilityState(event) {
    const target = event.target;
    if (!(target instanceof Element) || !target.classList.contains('mes')) return;
    if (event.skipped) skipped.add(target);
    else skipped.delete(target);
}

function countSkipped() {
    const chat = getChatElement();
    return chat ? [...chat.querySelectorAll(':scope > .mes')].filter(mes => skipped.has(mes)).length : 0;
}

/**
 * Placeholder height for messages that were never rendered: the median height of the visible
 * ones. A good estimate keeps the scrollbar from jumping while scrolling through history.
 */
function updatePlaceholderHeight() {
    const chat = getChatElement();
    if (!chat || !enabled || !s.offscreen) return;
    const heights = [...chat.querySelectorAll(':scope > .mes')]
        .slice(-8)
        .filter(mes => !skipped.has(mes))
        .map(mes => mes.getBoundingClientRect().height)
        .filter(h => h > 20)
        .sort((a, b) => a - b);
    if (!heights.length) return;
    const median = heights[Math.floor(heights.length / 2)];
    chat.style.setProperty('--stx-mes-height', `${Math.round(median)}px`);
}
const updatePlaceholderHeightSoon = debounce(updatePlaceholderHeight, 700);

// ------------------------------------------------------------------ DOM limit

function isNearBottom(chat) {
    return chat.scrollHeight - chat.scrollTop - chat.clientHeight < chat.clientHeight * 1.5;
}

/**
 * Removes the oldest rendered messages above the viewport, leaving the same state SillyTavern
 * itself produces when it opens a long chat ("Show more messages" brings them back).
 * Only runs while the user is at the bottom, so history being read is never touched.
 */
function pruneMessages() {
    if (!enabled || !s.domLimit) return 0;
    const chat = getChatElement();
    if (!chat || !isNearBottom(chat) || isGeneratingNow()) return 0;
    if (chat.querySelector('.mes .edit_textarea, .mes .reasoning_edit_textarea')) return 0;

    const messages = chat.querySelectorAll(':scope > .mes');
    const limit = Math.max(10, Number(s.domLimitCount) || 60);
    const excess = messages.length - limit;
    if (excess <= 0) return 0;

    const chatTop = chat.getBoundingClientRect().top;
    const remove = [];
    for (let i = 0; i < excess; i++) {
        if (messages[i].getBoundingClientRect().bottom > chatTop - 200) break;
        remove.push(messages[i]);
    }
    if (!remove.length) return 0;

    const fromBottom = chat.scrollHeight - chat.scrollTop;
    remove.forEach(message => message.remove());
    if (!document.getElementById('show_more_messages')) {
        chat.prepend(el('div', { id: 'show_more_messages', text: 'Show more messages' }));
    }
    chat.scrollTop = chat.scrollHeight - fromBottom;
    return remove.length;
}
const pruneSoon = debounce(pruneMessages, 600);

// ------------------------------------------------------------------ lazy images

function applyLazyImages() {
    // Messages are cloned from this template, so attributes set here apply to every new message.
    document.querySelectorAll('#message_template img').forEach(img => {
        if (enabled && s.lazyImages) {
            img.setAttribute('decoding', 'async');
            img.setAttribute('loading', 'lazy');
        } else {
            img.removeAttribute('decoding');
            img.removeAttribute('loading');
        }
    });
}

// ------------------------------------------------------------------ image optimizer

function targetLongSide() {
    const dpr = Math.min(window.devicePixelRatio || 1, QUALITY_DPR[s.imageQuality] ?? 2);
    const longCss = Math.max(screen.width || 0, screen.height || 0, window.innerWidth, window.innerHeight);
    return Math.round(longCss * dpr);
}

function ascii(bytes, start, length) {
    return String.fromCharCode(...bytes.subarray(start, start + length));
}

/** Reads width/height/animation from the file header without decoding the whole image. */
function sniffImage(bytes) {
    const info = { width: 0, height: 0, animated: false };
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 32) return info;

    if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG') {
        info.width = view.getUint32(16);
        info.height = view.getUint32(20);
        let offset = 8;
        while (offset + 8 < bytes.length) {
            const length = view.getUint32(offset);
            const type = ascii(bytes, offset + 4, 4);
            if (type === 'acTL') info.animated = true;
            if (type === 'IDAT' || type === 'acTL') break;
            offset += 12 + length;
        }
        return info;
    }
    if (ascii(bytes, 0, 4) === 'GIF8') {
        info.width = view.getUint16(6, true);
        info.height = view.getUint16(8, true);
        info.animated = true;
        return info;
    }
    if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
        const chunk = ascii(bytes, 12, 4);
        if (chunk === 'VP8X') {
            info.animated = (bytes[20] & 0x02) !== 0;
            info.width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
            info.height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
        } else if (chunk === 'VP8 ') {
            info.width = view.getUint16(26, true) & 0x3fff;
            info.height = view.getUint16(28, true) & 0x3fff;
        } else if (chunk === 'VP8L') {
            const b = view.getUint32(21, true);
            info.width = 1 + (b & 0x3fff);
            info.height = 1 + ((b >> 14) & 0x3fff);
        }
        return info;
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
        let offset = 2;
        while (offset + 9 < bytes.length) {
            if (bytes[offset] !== 0xff) {
                offset++;
                continue;
            }
            const marker = bytes[offset + 1];
            const length = view.getUint16(offset + 2);
            const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
            if (isSof) {
                info.height = view.getUint16(offset + 5);
                info.width = view.getUint16(offset + 7);
                break;
            }
            offset += 2 + length;
        }
        return info;
    }
    if (ascii(bytes, 4, 4) === 'ftyp') {
        info.animated = ascii(bytes, 8, 64).includes('avis');
    }
    return info;
}

async function encodeCanvas(canvas, opaque) {
    const type = opaque ? 'image/jpeg' : 'image/webp';
    if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) {
        return canvas.convertToBlob({ type, quality: 0.9 });
    }
    return new Promise(resolve => canvas.toBlob(resolve, type, 0.9));
}

async function downscale(url) {
    const response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok) return null;
    const blob = await response.blob();
    const header = new Uint8Array(await blob.slice(0, 256 * 1024).arrayBuffer());
    const info = sniffImage(header);
    if (info.animated && !s.freezeAnimated) return { skipped: 'animated', width: info.width, height: info.height };

    let { width, height } = info;
    let full = null;
    if (!width || !height) {
        full = await createImageBitmap(blob);
        width = full.width;
        height = full.height;
    }

    const target = targetLongSide();
    const longSide = Math.max(width, height);
    if (longSide <= target * 1.15) {
        full?.close();
        return { skipped: 'small', width, height };
    }

    const scale = target / longSide;
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    let bitmap;
    try {
        bitmap = full ? full : await createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
    } catch {
        bitmap = await createImageBitmap(blob);
    }
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const context = canvas.getContext('2d');
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();

    const opaque = header[0] === 0xff && header[1] === 0xd8;
    const out = await encodeCanvas(canvas, opaque);
    if (!out) return null;
    return { url: URL.createObjectURL(out), width, height, newWidth: w, newHeight: h, bytesIn: blob.size, bytesOut: out.size };
}

/** Queued, cached downscale. Images are processed one by one to avoid memory spikes on phones. */
function optimizeImage(url) {
    const absolute = new URL(url, location.href).href;
    if (!imageResults.has(absolute)) {
        const job = imageQueue.then(() => downscale(absolute)).catch(error => {
            console.warn('[Extensionz] Image optimization failed', absolute, error);
            return null;
        });
        imageQueue = job;
        imageResults.set(absolute, job);
    }
    return imageResults.get(absolute);
}

function backgroundSource() {
    const bg = document.getElementById('bg1');
    const match = /url\(\s*["']?(.*?)["']?\s*\)/.exec(bg?.style.backgroundImage ?? '');
    const src = match?.[1];
    return src && !src.startsWith('blob:') && !src.startsWith('data:') ? src : null;
}

let bgToken = 0;
async function syncBackground() {
    const bg = document.getElementById('bg1');
    if (!bg) return;
    const token = ++bgToken;
    const src = enabled && s.optimizeImages ? backgroundSource() : null;
    if (!src) {
        bg.classList.remove('stx-bg-opt');
        return;
    }
    const result = await optimizeImage(src);
    if (token !== bgToken) return;
    if (result?.url && backgroundSource() === src) {
        document.documentElement.style.setProperty('--stx-bg-opt', `url("${result.url}")`);
        bg.classList.add('stx-bg-opt');
    } else {
        bg.classList.remove('stx-bg-opt');
    }
}

function writeAvatarRules() {
    if (!avatarStyle) {
        avatarStyle = el('style', { id: 'stx-perf-avatars' });
        document.head.append(avatarStyle);
    }
    const rules = [];
    if (enabled && s.optimizeImages) {
        for (const [path, blobUrl] of avatarRules) {
            const value = CSS.escape(path);
            // !important in a stylesheet beats the theme's inline custom properties without fighting it.
            rules.push(`.mes[data-avatar-original="${value}"]{--mes-avatar-original-url:url("${blobUrl}") !important}`);
            rules.push(`.mes[data-avatar="${value}"]{--mes-avatar-url:url("${blobUrl}") !important}`);
        }
    }
    avatarStyle.textContent = rules.join('\n');
}

const pendingAvatars = new Set();
function scanThemeAvatars() {
    if (!enabled || !s.optimizeImages) return;
    const paths = new Set();
    document.querySelectorAll('#chat .mes[data-avatar-original]').forEach(mes => paths.add(mes.dataset.avatarOriginal));
    for (const path of paths) {
        if (!path || avatarRules.has(path) || pendingAvatars.has(path)) continue;
        pendingAvatars.add(path);
        optimizeImage(path).then(result => {
            if (result?.url) {
                avatarRules.set(path, result.url);
                writeAvatarRules();
            }
        });
    }
}
const scanThemeAvatarsSoon = debounce(scanThemeAvatars, 400);

function syncImageObservers() {
    const on = enabled && s.optimizeImages;
    if (on && !bgObserver) {
        const bg = document.getElementById('bg1');
        if (bg) {
            bgObserver = new MutationObserver(() => syncBackground());
            bgObserver.observe(bg, { attributes: true, attributeFilter: ['style'] });
        }
        const chat = getChatElement();
        if (chat) {
            avatarObserver = new MutationObserver(() => scanThemeAvatarsSoon());
            avatarObserver.observe(chat, { attributes: true, subtree: true, attributeFilter: ['data-avatar-original'] });
        }
    } else if (!on) {
        bgObserver?.disconnect();
        avatarObserver?.disconnect();
        bgObserver = avatarObserver = null;
    }
    syncBackground();
    writeAvatarRules();
    scanThemeAvatars();
}

// ------------------------------------------------------------------ SillyTavern settings

const ST_TWEAKS = [
    {
        id: 'chat_truncation',
        label: () => t('perf.tweakTruncation'),
        current: pu => pu.chat_truncation || '∞',
        target: 50,
        ok: pu => pu.chat_truncation > 0 && pu.chat_truncation <= 50,
        apply: () => $('#chat_truncation').val(50).trigger('input'),
    },
    {
        id: 'streaming_fps',
        label: () => t('perf.tweakFps'),
        current: pu => pu.streaming_fps,
        target: 20,
        ok: pu => pu.streaming_fps <= 20,
        apply: () => $('#streaming_fps').val(20).trigger('input'),
    },
    {
        id: 'smooth_streaming',
        label: () => t('perf.tweakSmooth'),
        current: pu => (pu.smooth_streaming ? t('perf.on') : t('perf.off')),
        target: () => t('perf.off'),
        ok: pu => !pu.smooth_streaming,
        apply: () => $('#smooth_streaming').prop('checked', false).trigger('input'),
        visual: true,
    },
    {
        id: 'reduced_motion',
        label: () => t('perf.tweakMotion'),
        current: pu => (pu.reduced_motion ? t('perf.on') : t('perf.off')),
        target: () => t('perf.on'),
        ok: pu => !!pu.reduced_motion,
        apply: () => $('#reduced_motion').prop('checked', true).trigger('input'),
        visual: true,
    },
    {
        id: 'fast_ui_mode',
        label: () => t('perf.tweakFastUi'),
        current: pu => (pu.fast_ui_mode ? t('perf.on') : t('perf.off')),
        target: () => t('perf.on'),
        ok: pu => !!pu.fast_ui_mode,
        apply: () => $('#fast_ui_mode').prop('checked', true).trigger('change'),
        visual: true,
    },
];

function buildTweaks() {
    const box = el('div', { class: 'stx-tweaks' });
    const render = () => {
        const pu = ctx().powerUserSettings ?? {};
        box.replaceChildren(...ST_TWEAKS.map(tweak => {
            const ok = tweak.ok(pu);
            const target = typeof tweak.target === 'function' ? tweak.target() : tweak.target;
            const action = ok
                ? el('span', { class: 'stx-tweak-ok fa-solid fa-check', title: t('perf.tweakDone') })
                : ui.button(t('perf.apply'), '', () => {
                    tweak.apply();
                    setTimeout(render, 50);
                }, { cls: 'stx-small-btn' });
            return el('div', { class: 'stx-tweak' },
                el('div', { class: 'stx-tweak-name' },
                    tweak.label(),
                    tweak.visual ? el('span', { class: 'stx-tag', text: t('perf.changesLook') }) : null,
                ),
                el('div', { class: 'stx-tweak-values', text: `${tweak.current(pu)} → ${target}` }),
                action,
            );
        }));
    };
    render();
    return box;
}

// ------------------------------------------------------------------ diagnostics

async function diagnose() {
    const chat = getChatElement();
    const all = document.getElementsByTagName('*');
    let blur = 0;
    for (const element of all) {
        const style = getComputedStyle(element);
        const value = style.backdropFilter || style.webkitBackdropFilter;
        if (value && value !== 'none') blur++;
    }
    const heap = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null;
    const bgSrc = backgroundSource();
    const bgResult = bgSrc ? await imageResults.get(new URL(bgSrc, location.href).href) : null;
    const avatarResults = await Promise.all([...avatarRules.keys()].map(async path => ({ path, result: await imageResults.get(new URL(path, location.href).href) })));
    return {
        dom: all.length,
        messagesInDom: chat ? chat.querySelectorAll(':scope > .mes').length : 0,
        messagesTotal: ctx().chat?.length ?? 0,
        skipped: countSkipped(),
        blur,
        heap,
        bg: bgResult,
        avatars: avatarResults,
    };
}

function decodedMb(width, height) {
    return ((width * height * 4) / 1048576).toFixed(1);
}

function imageLine(result) {
    if (!result) return t('perf.diagNotProcessed');
    if (result.skipped === 'animated') return t('perf.diagAnimated', { w: result.width, h: result.height });
    if (result.skipped === 'small') return t('perf.diagSmall', { w: result.width, h: result.height });
    return t('perf.diagScaled', {
        w: result.width, h: result.height, mb: decodedMb(result.width, result.height),
        nw: result.newWidth, nh: result.newHeight, nmb: decodedMb(result.newWidth, result.newHeight),
    });
}

export async function openDiagnostics() {
    const body = el('div', { class: 'stx-diag', text: t('perf.diagRunning') });
    openPopup(el('div', { class: 'stx-popup' },
        el('h3', { class: 'stx-popup-title' }, el('i', { class: 'fa-solid fa-gauge-high' }), ' ', t('perf.diagTitle')),
        body,
    ), { wide: false });
    const d = await diagnose();
    const row = (label, value) => el('div', { class: 'stx-diag-row' }, el('span', { text: label }), el('b', { text: String(value) }));
    body.replaceChildren(
        row(t('perf.diagDom'), d.dom.toLocaleString()),
        row(t('perf.diagMessages'), `${d.messagesInDom} / ${d.messagesTotal}`),
        row(t('perf.diagSkipped'), s.offscreen ? d.skipped : t('perf.off')),
        row(t('perf.diagBlur'), d.blur),
        d.heap !== null ? row(t('perf.diagHeap'), `${d.heap} MB`) : null,
        row(t('perf.diagBg'), imageLine(d.bg)),
        ...d.avatars.map(({ path, result }) => row(`${t('perf.diagAvatar')} ${decodeURIComponent(path.split('/').pop())}`, imageLine(result))),
        el('small', { class: 'stx-note', text: t('perf.diagHint') }),
    );
}

// ------------------------------------------------------------------ module API

function refreshAll() {
    applyClasses();
    updatePlaceholderHeightSoon();
    applyLazyImages();
    syncImageObservers();
    pruneSoon();
}

function init() {
    s = moduleSettings(ID);
    document.addEventListener('contentvisibilityautostatechange', onVisibilityState, true);
    ['CHARACTER_MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED', 'GENERATION_ENDED', 'CHAT_CHANGED'].forEach(type => {
        onEvent(type, () => {
            if (!enabled) return;
            pruneSoon();
            scanThemeAvatarsSoon();
            updatePlaceholderHeightSoon();
        });
    });
}

function enable() {
    enabled = true;
    const chat = getChatElement();
    if (chat && !scrollHandler) {
        scrollHandler = debounce(() => pruneMessages(), 1200);
        chat.addEventListener('scroll', scrollHandler, { passive: true });
    }
    refreshAll();
}

function disable() {
    enabled = false;
    getChatElement()?.removeEventListener('scroll', scrollHandler);
    scrollHandler = null;
    refreshAll();
}

function onLanguageChange() { }

function buildSettings(root) {
    const refresh = () => refreshAll();
    const reprocessImages = () => {
        imageResults.forEach(job => job.then(r => r?.url && URL.revokeObjectURL(r.url)));
        imageResults.clear();
        avatarRules.clear();
        pendingAvatars.clear();
        refreshAll();
    };

    root.append(
        ui.row(ui.button(t('perf.diagnose'), 'fa-gauge-high', () => openDiagnostics())),

        ui.section(t('perf.sectionInvisible')),
        ui.checkbox(s, 'offscreen', t('perf.offscreen'), { hint: t('perf.offscreenHint'), onChange: refresh }),
        ui.checkbox(s, 'domLimit', t('perf.domLimit'), { hint: t('perf.domLimitHint'), onChange: refresh }),
        ui.numberInput(s, 'domLimitCount', t('perf.domLimitCount'), { min: 10, max: 1000, onChange: refresh }),
        ui.checkbox(s, 'optimizeImages', t('perf.optimizeImages'), { hint: t('perf.optimizeImagesHint'), onChange: reprocessImages }),
        ui.select(s, 'imageQuality', t('perf.imageQuality'), [
            { value: 'max', label: t('perf.qualityMax') },
            { value: 'high', label: t('perf.qualityHigh') },
            { value: 'eco', label: t('perf.qualityEco') },
        ], { onChange: reprocessImages }),
        ui.checkbox(s, 'lazyImages', t('perf.lazyImages'), { onChange: refresh }),

        ui.section(t('perf.sectionVisual')),
        el('small', { class: 'stx-note', text: t('perf.visualHint') }),
        ui.checkbox(s, 'noBlur', t('perf.noBlur'), { onChange: refresh }),
        ui.checkbox(s, 'noAnimations', t('perf.noAnimations'), { onChange: refresh }),
        ui.checkbox(s, 'noShadows', t('perf.noShadows'), { onChange: refresh }),
        ui.checkbox(s, 'freezeAnimated', t('perf.freezeAnimated'), { hint: t('perf.freezeAnimatedHint'), onChange: reprocessImages }),

        ui.section(t('perf.sectionTavern')),
        el('small', { class: 'stx-note', text: t('perf.tavernHint') }),
        buildTweaks(),

        ui.section(t('perf.sectionServer')),
        el('small', { class: 'stx-note', text: t('perf.serverHint') }),
        el('pre', { class: 'stx-code', text: t('perf.serverCommands') }),
    );
}

export default {
    id: ID,
    icon: 'fa-gauge-high',
    order: 60,
    defaults,
    titleKey: 'perf.title',
    descKey: 'perf.desc',
    init,
    enable,
    disable,
    buildSettings,
    onLanguageChange,
};
