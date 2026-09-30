// "Dad came" / panic mode.
// One tap hides character images and backgrounds and covers "interesting" sentences with
// solid black bars, like a declassified document. Nothing in the chat data is changed:
// everything is CSS + temporary <span> marks, and a second tap restores the view exactly.

import { t, getLanguage } from '../core/i18n.js';
import { moduleSettings, moduleDefaultsOf, save } from '../core/settings.js';
import { markEngine } from '../core/marks.js';
import { buildMatcher, findAll, sentenceRanges, expandToWord, trimRange, wordRanges } from '../core/text.js';
import { ctx, el, hashString, registerSlashCommand, onEvent } from '../core/st.js';
import * as ui from '../core/ui.js';

const ID = 'panic';
const STATE_KEY = 'stx:panic';

const DEFAULT_KEYWORDS = `# Русский: романтика и 18+
поцел*
целов*
облиз*
обнаж*
голый, голая, голые, голым, "голое", "голого", "голой"
раздев*, разделся, разделась, разденься
нагот*
грудь, груди, грудью
сосок, соски, сосков
бёдр*
ягодиц*
задниц*
промежност*
"член", "члена", "члену", "членом"
пенис*
эрекц*
возбужд*
стон*, застон*, простон*
секс*
трах*
оргазм*
похот*
вожделе*
страстн*
эрот*
интимн*
ласка*
трусик*
лифчик*
нижнее бельё
мастурб*
минет*
сперм*
влагалищ*
клитор*
постел*
# Насилие
"кровь", "крови", "кровью"
окровавл*
убий*
пытк*
"труп", "трупа", "трупу", "трупом", "трупы", "трупов"
# Мат
хуй, хуе*, хуё*, хуя*
пизд*
ебат*, ебал*, ебан*, ёбан*, выеб*, заеб*
бляд*, блять
сука, суки, сучк*
# English
kiss*
lick*
naked, nude
undress*
breast*, boob*, nipple*
thigh*
"butt", "butts", ass
cock, dick, penis
erect*
arous*
moan*, groan*
sex*
fuck*
orgasm*
lust*
horny
cum
panties, lingerie, bra
blood, bloody
murder*
torture*`;

const defaults = {
    enabled: true,
    active: false,
    rememberState: true,
    // images
    hideImages: true,
    hideBackground: true,
    imageMode: 'hide',
    hidePanels: true,
    // text
    redactText: true,
    redactMode: 'sentence',
    keywords: DEFAULT_KEYWORDS,
    smartForms: true,
    redactReasoning: true,
    noise: 0,
    redactNames: false,
    barColor: '#000000',
    peekOnHold: false,
    // extras
    blurInput: true,
    pauseMedia: true,
    stopGeneration: false,
    disguiseTab: true,
    disguiseTitle: '',
    // triggers
    hotkey: 'Alt+KeyX',
    doubleEscape: true,
    floatingButton: false,
    fabPosition: { x: 0.92, y: 0.62 },
    threeFingerTap: false,
};

const DOC_FAVICON = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path fill="#4a86e8" d="M29 2H10a4 4 0 0 0-4 4v36a4 4 0 0 0 4 4h28a4 4 0 0 0 4-4V15z"/>' +
    '<path fill="#a1c2fa" d="M29 2v13h13z"/><path fill="#fff" d="M14 24h20v2.6H14zm0 6h20v2.6H14zm0 6h14v2.6H14z"/></svg>');

let s = null;
let keywordMatcher = { regex: null, errors: [], count: 0 };
let namesRegex = null;
let wand = null;
let fab = null;
let savedTitle = null;
let savedFavicons = null;
let titleObserver = null;
let pausedMedia = [];
let pausedSpeech = false;
let lastEscape = 0;
let groupSeq = 0;
let keywordStatus = null;
let enabled = false;

function isActive() {
    return enabled && !!s.active;
}

// ------------------------------------------------------------------ matching

function rebuildKeywords() {
    keywordMatcher = buildMatcher(s.keywords, { smart: s.smartForms });
    updateKeywordStatus();
}

function updateKeywordStatus() {
    if (!keywordStatus) return;
    const { count, errors } = keywordMatcher;
    keywordStatus.textContent = errors.length
        ? t('panic.keywordsErrors', { count, errors: errors.join(', ') })
        : t('panic.keywordsCount', { count });
    keywordStatus.classList.toggle('stx-error', errors.length > 0);
}

function collectNames() {
    const c = ctx();
    const names = new Set();
    const add = (name) => {
        const value = String(name ?? '').trim();
        if (!value || value.length < 2) return;
        names.add(value);
        for (const part of value.split(/\s+/)) {
            if (part.length >= 3) names.add(part);
        }
    };
    add(c.name1);
    add(c.name2);
    for (const message of c.chat ?? []) add(message?.name);
    if (c.groupId) {
        const group = c.groups?.find(g => g.id == c.groupId);
        for (const avatar of group?.members ?? []) {
            add(c.characters?.find(ch => ch.avatar === avatar)?.name);
        }
    }
    return [...names];
}

function rebuildNames() {
    namesRegex = s.redactNames ? buildMatcher(collectNames(), { smart: true }).regex : null;
}

function redactionRanges(text, info) {
    if (info.isReasoning && !s.redactReasoning) return [];
    const ranges = [];
    const cls = 'stx-redact';
    const push = (start, end) => ranges.push({ start, end, cls, group: ++groupSeq });

    if (s.redactText) {
        const hits = findAll(keywordMatcher.regex, text);
        const noise = Math.max(0, Math.min(100, Number(s.noise) || 0));

        if (s.redactMode === 'word') {
            for (const [start, end] of hits) push(...expandToWord(text, start, end));
            if (noise > 0) {
                wordRanges(text).forEach(([start, end], index) => {
                    if (hashString(`${text.slice(start, end)}#${index}`) % 100 < noise) push(start, end);
                });
            }
        } else if (s.redactMode === 'paragraph') {
            const whole = trimRange(text, 0, text.length);
            if (whole && (hits.length || (noise > 0 && hashString(text) % 100 < noise))) push(...whole);
        } else {
            for (const [start, end] of sentenceRanges(text, getLanguage())) {
                const hit = hits.some(([hStart, hEnd]) => hStart < end && hEnd > start);
                const noisy = noise > 0 && hashString(text.slice(start, end)) % 100 < noise;
                if (hit || noisy) push(start, end);
            }
        }
    }

    if (namesRegex) {
        for (const [start, end] of findAll(namesRegex, text)) push(start, end);
    }
    return ranges;
}

// ------------------------------------------------------------------ apply / restore

function applyBodyClasses() {
    const body = document.body;
    const on = isActive();
    body.classList.toggle('stx-panic', on);
    body.classList.toggle('stx-p-img', on && s.hideImages);
    body.classList.toggle('stx-p-bg', on && s.hideBackground);
    body.classList.toggle('stx-p-blur', on && s.imageMode === 'blur');
    body.classList.toggle('stx-p-panels', on && s.hidePanels);
    body.classList.toggle('stx-p-input', on && s.blurInput);
    body.classList.toggle('stx-p-names', on && s.redactNames);
    body.classList.toggle('stx-p-peek', on && s.peekOnHold);
    body.style.setProperty('--stx-bar', s.barColor || '#000');
}

function disguiseTab(on) {
    if (on) {
        if (savedTitle === null) savedTitle = document.title;
        const title = s.disguiseTitle?.trim() || t('panic.defaultTitle');
        document.title = title;
        if (!savedFavicons) {
            const icons = [...document.querySelectorAll('link[rel~="icon"]')];
            savedFavicons = icons.map(link => ({ link, href: link.getAttribute('href') }));
            if (!icons.length) {
                const link = el('link', { rel: 'icon', 'data-stx-temp': '1' });
                document.head.append(link);
                savedFavicons.push({ link, href: null });
            }
        }
        savedFavicons.forEach(({ link }) => link.setAttribute('href', DOC_FAVICON));
        if (!titleObserver) {
            titleObserver = new MutationObserver(() => {
                if (isActive() && s.disguiseTab && document.title !== title) document.title = title;
            });
            titleObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
        }
    } else {
        titleObserver?.disconnect();
        titleObserver = null;
        if (savedTitle !== null) document.title = savedTitle;
        savedTitle = null;
        savedFavicons?.forEach(({ link, href }) => {
            if (link.dataset.stxTemp) link.remove();
            else if (href !== null) link.setAttribute('href', href);
        });
        savedFavicons = null;
    }
}

function pauseMedia() {
    pausedMedia = [];
    for (const media of document.querySelectorAll('audio, video')) {
        if (!media.paused) {
            media.pause();
            pausedMedia.push(media);
        }
    }
    for (const frame of document.querySelectorAll('iframe[src*="youtube"]')) {
        try {
            frame.contentWindow?.postMessage(JSON.stringify({ event: 'command', func: 'pauseVideo', args: [] }), '*');
            pausedMedia.push(frame);
        } catch { /* cross-origin frame without the JS API */ }
    }
    if (window.speechSynthesis?.speaking && !window.speechSynthesis.paused) {
        window.speechSynthesis.pause();
        pausedSpeech = true;
    }
}

function resumeMedia() {
    for (const media of pausedMedia) {
        if (media instanceof HTMLIFrameElement) {
            try {
                media.contentWindow?.postMessage(JSON.stringify({ event: 'command', func: 'playVideo', args: [] }), '*');
            } catch { /* ignore */ }
        } else if (media.isConnected) {
            media.play().catch(() => { });
        }
    }
    pausedMedia = [];
    if (pausedSpeech) window.speechSynthesis?.resume();
    pausedSpeech = false;
}

function refreshView() {
    applyBodyClasses();
    rebuildNames();
    markEngine.refresh();
    updateTriggers();
}

/**
 * @param {boolean} [force] true = activate, false = deactivate, undefined = toggle
 */
export function setPanic(force) {
    if (!enabled) return false;
    const next = force === undefined ? !s.active : !!force;
    if (next === !!s.active) return next;
    s.active = next;
    save();
    // ST saves settings with a delay; keep a synchronous copy so a reload a moment later still opens hidden.
    try {
        localStorage.setItem(STATE_KEY, next ? '1' : '0');
    } catch { /* storage unavailable */ }

    if (next) {
        if (s.stopGeneration) {
            try {
                ctx().stopGeneration();
            } catch { /* nothing is generating */ }
        }
        if (s.pauseMedia) pauseMedia();
        if (s.disguiseTab) disguiseTab(true);
        // Drops the on-screen keyboard on phones and hides the caret in the input.
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    } else {
        disguiseTab(false);
        resumeMedia();
    }
    refreshView();
    return next;
}

export function isPanicActive() {
    return isActive();
}

// ------------------------------------------------------------------ triggers

function updateTriggers() {
    const on = isActive();
    if (wand) {
        wand.setLabel(on ? t('panic.menuOff') : t('panic.menuOn'));
        wand.setIcon(on ? 'fa-eye' : 'fa-user-secret');
        wand.setActive(on);
    }
    if (fab) {
        fab.classList.toggle('stx-active', on);
        fab.querySelector('i').className = `fa-solid ${on ? 'fa-eye' : 'fa-user-secret'}`;
        fab.title = on ? t('panic.menuOff') : t('panic.menuOn');
    }
}

function onKeyDown(event) {
    if (!enabled) return;
    if (event.target instanceof HTMLElement && event.target.classList.contains('stx-hotkey')) return;

    if (s.hotkey && ui.comboFromEvent(event) === s.hotkey) {
        event.preventDefault();
        event.stopPropagation();
        setPanic();
        return;
    }
    if (s.doubleEscape && event.key === 'Escape' && !event.repeat) {
        const now = Date.now();
        if (now - lastEscape < 450) {
            lastEscape = 0;
            setPanic();
        } else {
            lastEscape = now;
        }
    }
}

let lastTripleTap = 0;
function onTouchStart(event) {
    if (!enabled || !s.threeFingerTap || event.touches.length < 3) return;
    const now = Date.now();
    if (now - lastTripleTap < 700) return;
    lastTripleTap = now;
    event.preventDefault();
    setPanic();
}

function createFab() {
    if (fab) return;
    fab = el('div', { id: 'stx_panic_fab', class: 'stx-fab', role: 'button', tabindex: 0 }, el('i', { class: 'fa-solid fa-user-secret' }));
    placeFab();
    let start = null;
    let moved = false;

    fab.addEventListener('pointerdown', (event) => {
        start = { x: event.clientX, y: event.clientY };
        moved = false;
        fab.setPointerCapture(event.pointerId);
    });
    fab.addEventListener('pointermove', (event) => {
        if (!start) return;
        if (!moved && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 8) return;
        moved = true;
        s.fabPosition = {
            x: Math.min(1, Math.max(0, event.clientX / window.innerWidth)),
            y: Math.min(1, Math.max(0, event.clientY / window.innerHeight)),
        };
        placeFab();
    });
    fab.addEventListener('pointerup', () => {
        if (start && moved) save();
        if (start && !moved) setPanic();
        start = null;
    });
    fab.addEventListener('pointercancel', () => { start = null; });
    fab.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setPanic();
        }
    });
    document.body.append(fab);
    updateTriggers();
}

function placeFab() {
    if (!fab) return;
    const size = 44;
    const x = Math.round((s.fabPosition?.x ?? 0.92) * window.innerWidth - size / 2);
    const y = Math.round((s.fabPosition?.y ?? 0.62) * window.innerHeight - size / 2);
    fab.style.left = `${Math.min(window.innerWidth - size - 4, Math.max(4, x))}px`;
    fab.style.top = `${Math.min(window.innerHeight - size - 4, Math.max(4, y))}px`;
}

function destroyFab() {
    fab?.remove();
    fab = null;
}

function syncFab() {
    if (enabled && s.floatingButton) createFab();
    else destroyFab();
}

let touchListening = false;
function syncTouch() {
    // A non-passive touch listener slows down scrolling a bit, so only attach it when needed.
    const needed = enabled && s.threeFingerTap;
    if (needed === touchListening) return;
    touchListening = needed;
    if (needed) window.addEventListener('touchstart', onTouchStart, { passive: false, capture: true });
    else window.removeEventListener('touchstart', onTouchStart, { capture: true });
}

// Hold-to-peek: press and hold a black bar to read it, release to hide again.
let peekTimer = null;
function onPointerDown(event) {
    if (!isActive() || !s.peekOnHold) return;
    const mark = event.target instanceof Element ? event.target.closest('.stx-redact') : null;
    if (!mark) return;
    const group = mark.dataset.stxGroup;
    const container = mark.closest('.mes_text, .mes_reasoning') ?? mark.parentElement;
    peekTimer = setTimeout(() => {
        const marks = group ? container.querySelectorAll(`.stx-redact[data-stx-group="${group}"]`) : [mark];
        marks.forEach(m => m.classList.add('stx-peek'));
    }, 350);
}
function endPeek() {
    clearTimeout(peekTimer);
    document.querySelectorAll('.stx-peek').forEach(m => m.classList.remove('stx-peek'));
}

// ------------------------------------------------------------------ module API

function init() {
    s = moduleSettings(ID);
    rebuildKeywords();

    markEngine.register({
        id: 'redact',
        order: 10,
        targets: '.mes_text, .mes_reasoning',
        isActive: () => isActive() && (s.redactText || s.redactNames),
        getRanges: redactionRanges,
    });

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', placeFab);
    document.addEventListener('pointerdown', onPointerDown, true);
    // Element focus changes also fire "blur" in the capture phase, so only the window's own blur ends a peek.
    ['pointerup', 'pointercancel'].forEach(type => window.addEventListener(type, endPeek, true));
    window.addEventListener('blur', endPeek);

    onEvent('CHAT_CHANGED', () => {
        if (isActive()) refreshView();
    });

    registerSlashCommand({
        name: 'panic',
        aliases: ['dadcame'],
        helpString: t('panic.slashHelp'),
        unnamedArg: { description: 'on | off | toggle', enumList: ['on', 'off', 'toggle'] },
        callback: (_, value) => {
            const arg = value.toLowerCase();
            const result = setPanic(arg === 'on' ? true : arg === 'off' ? false : undefined);
            return result ? 'on' : 'off';
        },
    });
}

async function enable() {
    enabled = true;
    if (s.rememberState) {
        try {
            const stored = localStorage.getItem(STATE_KEY);
            if (stored !== null) s.active = stored === '1';
        } catch { /* storage unavailable */ }
    } else {
        s.active = false;
    }
    wand = await ui.addWandItem({ id: 'stx_panic_wand', icon: 'fa-user-secret', label: t('panic.menuOn'), onClick: () => setPanic(), order: 10 });
    syncFab();
    syncTouch();
    if (s.active && s.disguiseTab) disguiseTab(true);
    refreshView();
}

function disable() {
    if (s.active) {
        disguiseTab(false);
        resumeMedia();
        s.active = false;
        save();
        try {
            localStorage.setItem(STATE_KEY, '0');
        } catch { /* storage unavailable */ }
    }
    enabled = false;
    wand?.remove();
    wand = null;
    destroyFab();
    syncTouch();
    refreshView();
}

function onLanguageChange() {
    updateTriggers();
    updateKeywordStatus();
    if (isActive() && s.disguiseTab && !s.disguiseTitle?.trim()) document.title = t('panic.defaultTitle');
}

function buildSettings(root) {
    const refresh = () => refreshView();

    root.append(
        ui.row(
            ui.button(t('panic.toggleNow'), 'fa-user-secret', () => setPanic()),
        ),

        ui.section(t('panic.sectionTriggers')),
        ui.hotkeyInput(s, 'hotkey', t('panic.hotkey'), { hint: t('panic.hotkeyHint'), placeholder: t('panic.hotkeyPlaceholder') }),
        ui.checkbox(s, 'doubleEscape', t('panic.doubleEscape')),
        ui.checkbox(s, 'floatingButton', t('panic.floatingButton'), { hint: t('panic.floatingButtonHint'), onChange: syncFab }),
        ui.checkbox(s, 'threeFingerTap', t('panic.threeFingerTap'), { hint: t('panic.threeFingerTapHint'), onChange: syncTouch }),
        ui.checkbox(s, 'rememberState', t('panic.rememberState'), { hint: t('panic.rememberStateHint') }),

        ui.section(t('panic.sectionImages')),
        ui.checkbox(s, 'hideImages', t('panic.hideImages'), { onChange: refresh }),
        ui.checkbox(s, 'hideBackground', t('panic.hideBackground'), { onChange: refresh }),
        ui.select(s, 'imageMode', t('panic.imageMode'), [
            { value: 'hide', label: t('panic.imageModeHide') },
            { value: 'blur', label: t('panic.imageModeBlur') },
        ], { onChange: refresh }),
        ui.checkbox(s, 'hidePanels', t('panic.hidePanels'), { hint: t('panic.hidePanelsHint'), onChange: refresh }),

        ui.section(t('panic.sectionText')),
        ui.checkbox(s, 'redactText', t('panic.redactText'), { onChange: refresh }),
        ui.select(s, 'redactMode', t('panic.redactMode'), [
            { value: 'sentence', label: t('panic.modeSentence') },
            { value: 'word', label: t('panic.modeWord') },
            { value: 'paragraph', label: t('panic.modeParagraph') },
        ], { onChange: refresh }),
    );

    const keywords = ui.textarea(s, 'keywords', t('panic.keywords'), {
        rows: 8,
        hint: t('panic.keywordsHint'),
        onChange: () => {
            rebuildKeywords();
            refresh();
        },
    });
    keywordStatus = el('small', { class: 'stx-note stx-status' });
    keywords.append(keywordStatus);
    updateKeywordStatus();

    root.append(
        keywords,
        ui.row(
            ui.button(t('common.resetDefaults'), 'fa-rotate-left', () => {
                keywords.setValue(moduleDefaultsOf(ID).keywords);
            }),
        ),
        ui.checkbox(s, 'smartForms', t('panic.smartForms'), {
            hint: t('panic.smartFormsHint'),
            onChange: () => {
                rebuildKeywords();
                refresh();
            },
        }),
        ui.checkbox(s, 'redactReasoning', t('panic.redactReasoning'), { onChange: refresh }),
        ui.checkbox(s, 'redactNames', t('panic.redactNames'), { hint: t('panic.redactNamesHint'), onChange: refresh }),
        ui.range(s, 'noise', t('panic.noise'), { min: 0, max: 60, step: 5, suffix: '%', hint: t('panic.noiseHint'), onChange: refresh }),
        ui.colorInput(s, 'barColor', t('panic.barColor'), { onChange: refresh }),
        ui.checkbox(s, 'peekOnHold', t('panic.peekOnHold'), { hint: t('panic.peekOnHoldHint'), onChange: refresh }),

        ui.section(t('panic.sectionExtras')),
        ui.checkbox(s, 'blurInput', t('panic.blurInput'), { onChange: refresh }),
        ui.checkbox(s, 'pauseMedia', t('panic.pauseMedia')),
        ui.checkbox(s, 'stopGeneration', t('panic.stopGeneration')),
        ui.checkbox(s, 'disguiseTab', t('panic.disguiseTab'), {
            onChange: (value) => {
                if (isActive()) disguiseTab(value);
            },
        }),
        ui.textInput(s, 'disguiseTitle', t('panic.disguiseTitle'), {
            placeholder: t('panic.defaultTitle'),
            onChange: () => {
                if (isActive() && s.disguiseTab) {
                    disguiseTab(false);
                    disguiseTab(true);
                }
            },
        }),
    );
}

export default {
    id: ID,
    icon: 'fa-user-secret',
    order: 10,
    defaults,
    titleKey: 'panic.title',
    descKey: 'panic.desc',
    init,
    enable,
    disable,
    buildSettings,
    onLanguageChange,
};
