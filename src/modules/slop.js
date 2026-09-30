// Cliché radar: underlines overused LLM phrases ("slop") in AI replies, shows per-chat stats
// and can quietly ask the model to avoid the phrases it overuses in the current chat.

import { t } from '../core/i18n.js';
import { moduleSettings, moduleDefaultsOf } from '../core/settings.js';
import { markEngine } from '../core/marks.js';
import { buildMatcher, findAll, countWords, foldForSearch } from '../core/text.js';
import { ctx, el, openPopup, onEvent, registerSlashCommand, jumpToMessage, debounce } from '../core/st.js';
import * as ui from '../core/ui.js';

const ID = 'slop';
const PROMPT_KEY = 'stx_antislop';

const DEFAULT_PHRASES = `# English
/shiver(?:s|ed)? (?:ran |run |runs |running |went |sent )?(?:up|down) (?:his|her|their|my|your) spine/
/sends? (?:a )?shivers?/
barely above a whisper
/(?:a )?mix(?:ture)? of \\w+ and \\w+/
ministrations
ozone
palpable
testament to
tapestry
unspoken
/(?:the )?air (?:was |grew |became )?(?:thick|heavy|charged) with/
maybe, just maybe
/bit(?:es|ing)? (?:down on )?(?:his|her|their|my|your) (?:lower )?lip/
/mischievous (?:glint|twinkle|grin|smile)/
/(?:sparkling|glinting|twinkling) with (?:mischief|amusement)/
husky
/(?:his|her|their) voice (?:barely )?(?:a )?whisper/
pang of
/knuckles (?:turning |turned |went )?white/
/can(?:'|’)t help but/
/(?:jolt|surge|spark) of (?:electricity|pleasure|desire)/
/something (?:primal|feral)/
primal
/(?:flicker|glint|hint) of (?:something|amusement|mischief)/
/breath (?:he|she|they|I) didn(?:'|’)t (?:know|realize) (?:he|she|they|I) (?:was|were) holding/
/(?:the )?world (?:narrowed|faded|fell away)/
/wave of (?:heat|warmth|pleasure|relief|emotion)/
orbs
delve
smirk
/ever so (?:slightly|gently|softly)/
dance of
/(?:it|this) (?:wasn(?:'|’)t|isn(?:'|’)t) (?:just )?about/
/(?:low|throaty) (?:chuckle|growl|rumble)/
musky
/(?:predatory|wolfish) (?:grin|smile)/
/(?:voice|tone) (?:dripping|laced|thick) with/
/(?:heart|pulse) (?:hammering|pounding|racing)/
# Русский
/(?:мурашк\\p{L}*|холодок|дрожь) (?:пробежал\\p{L}*|побежал\\p{L}*|прошл\\p{L}*) (?:по|вдоль) (?:спине|коже|позвоночнику)/
/мурашк\\p{L}* по (?:коже|спине)/
/(?:едва|чуть) (?:громче|слышнее) (?:шёпота|шепота)/
едва слышно
едва заметн*
едва уловим*
/(?:смесь|смешение) \\p{L}+ и \\p{L}+/
/в воздухе (?:повис\\p{L}*|витал\\p{L}*|чувствовал\\p{L}*)/
/воздух (?:стал |был |словно )?(?:густ|тяжел|тяжёл|наэлектризован)\\p{L}*/
озорн*
ухмыл*
усмехн*
усмешк*
/сердце (?:пропустило|пропустил\\p{L}*) (?:удар|пару ударов)/
/электрическ\\p{L}* (?:разряд|ток)/
/волн\\p{L}* (?:тепла|жара|возбуждения|облегчения|удовольствия)/
терпк*
мускусн*
озон*
/(?:при|за)куси(?:л|ла|ли|в) (?:нижнюю )?губ\\p{L}*/
/в (?:его|её|ее|их|моих|твоих) глазах (?:мелькнул\\p{L}*|вспыхнул\\p{L}*|блеснул\\p{L}*|плясал\\p{L}*)/
/что-то (?:тёмное|темное|первобытное|хищное|звериное)/
первобытн*
собственническ*
/костяшки (?:пальцев )?побелел\\p{L}*/
/не (?:мог|могла|могли|могу) не/
/(?:тень|призрак|намёк|намек) (?:улыбки|усмешки)/
/уголк\\p{L}* (?:губ|рта) (?:дрогнул\\p{L}*|приподнял\\p{L}*|дёрнул\\p{L}*|дернул\\p{L}*)/
/(?:может быть|возможно), (?:только|просто) (?:может быть|возможно)/
/(?:низк|хрипл|бархатн)\\p{L}* (?:голос|смешок|рык|рокот)/
/(?:хищн|волчь)\\p{L}* (?:ухмылк|улыбк|оскал)\\p{L}*/
/(?:сердце|пульс) (?:колотил\\p{L}*|бешено|забил\\p{L}*)/
/не (?:просто|только) [\\p{L} ]{2,30}[,—–-]+ (?:а|это)/`;

const defaults = {
    enabled: true,
    highlight: true,
    style: 'wavy',
    color: '#e5a50a',
    phrases: DEFAULT_PHRASES,
    injectAvoid: false,
    injectTop: 8,
    injectScope: 40,
    injectDepth: 1,
    injectTemplate: 'Avoid these overused phrases and clichés; use fresh, specific wording instead: {phrases}.',
};

let s = null;
let enabled = false;
let matcher = { regex: null, errors: [], count: 0 };
let wand = null;
let statusEl = null;

function rebuild() {
    matcher = buildMatcher(s.phrases, { smart: true });
    if (statusEl) {
        statusEl.textContent = matcher.errors.length
            ? t('slop.phrasesErrors', { count: matcher.count, errors: matcher.errors.join(', ') })
            : t('slop.phrasesCount', { count: matcher.count });
        statusEl.classList.toggle('stx-error', matcher.errors.length > 0);
    }
}

function applyStyleVars() {
    document.body.style.setProperty('--stx-slop', s.color || '#e5a50a');
    document.body.classList.toggle('stx-slop-bg', s.style === 'background');
    document.body.classList.toggle('stx-slop-dotted', s.style === 'dotted');
}

function normalizePhrase(text) {
    return foldForSearch(text).replace(/\s+/g, ' ').replace(/[*_"«»“”]/g, '').trim();
}

/**
 * @param {{lastN?: number}} [options]
 */
function analyze({ lastN } = {}) {
    const { chat } = ctx();
    const phrases = new Map();
    const perMessage = [];
    let words = 0;
    let hits = 0;
    let aiMessages = 0;

    for (let id = chat.length - 1; id >= 0; id--) {
        const message = chat[id];
        if (!message || message.is_user || message.is_system || !message.mes) continue;
        if (lastN && aiMessages >= lastN) break;
        aiMessages++;
        const found = findAll(matcher.regex, message.mes);
        const messageWords = countWords(message.mes);
        words += messageWords;
        hits += found.length;
        perMessage.unshift({ id, hits: found.length, words: messageWords });
        for (const [, , text] of found) {
            const key = normalizePhrase(text);
            const entry = phrases.get(key) ?? { text: key, count: 0, lastId: id };
            entry.count++;
            phrases.set(key, entry);
        }
    }

    const top = [...phrases.values()].sort((a, b) => b.count - a.count);
    const per1000 = words ? (hits / words) * 1000 : 0;
    return { words, hits, per1000, top, perMessage, aiMessages };
}

function grade(per1000, words) {
    if (words < 300) return { key: 'slop.gradeTooLittle', cls: 'stx-grade-na' };
    if (per1000 < 2) return { key: 'slop.gradeClean', cls: 'stx-grade-ok' };
    if (per1000 < 5) return { key: 'slop.gradeOk', cls: 'stx-grade-fine' };
    if (per1000 < 10) return { key: 'slop.gradeMany', cls: 'stx-grade-warn' };
    return { key: 'slop.gradeSlop', cls: 'stx-grade-bad' };
}

function buildInstruction(top) {
    const list = top.slice(0, Math.max(1, s.injectTop)).map(p => `"${p.text}"`).join(', ');
    return list ? String(s.injectTemplate || defaults.injectTemplate).replace('{phrases}', list) : '';
}

function updateInjection() {
    const c = ctx();
    if (typeof c.setExtensionPrompt !== 'function') return;
    let value = '';
    if (enabled && s.injectAvoid && matcher.regex) {
        const { top } = analyze({ lastN: s.injectScope });
        value = buildInstruction(top.filter(p => p.count >= 2).length ? top.filter(p => p.count >= 2) : top);
    }
    // position 1 = in-chat at depth, role 0 = system
    c.setExtensionPrompt(PROMPT_KEY, value, 1, Number(s.injectDepth) || 0, false, 0);
}
const updateInjectionDebounced = debounce(updateInjection, 500);

export function openStats() {
    const stats = analyze();
    const g = grade(stats.per1000, stats.words);
    const max = Math.max(1, ...stats.perMessage.map(m => m.hits));
    const recent = stats.perMessage.slice(-40);

    const bars = el('div', { class: 'stx-bars', title: t('slop.chartTitle') },
        recent.map(m => {
            const bar = el('div', { class: 'stx-bar', title: `#${m.id}: ${m.hits}`, style: `height:${Math.max(4, (m.hits / max) * 100)}%` });
            bar.addEventListener('click', () => {
                popup.completeCancelled();
                jumpToMessage(m.id);
            });
            return bar;
        }));

    const topMax = stats.top[0]?.count ?? 1;
    const table = el('div', { class: 'stx-top' },
        stats.top.slice(0, 30).map(p => el('div', { class: 'stx-top-row' },
            el('span', { class: 'stx-top-text', text: p.text }),
            el('span', { class: 'stx-top-bar' }, el('span', { style: `width:${(p.count / topMax) * 100}%` })),
            el('span', { class: 'stx-top-count', text: String(p.count) }),
        )));

    const copy = ui.button(t('slop.copyInstruction'), 'fa-copy', async () => {
        const text = buildInstruction(stats.top);
        if (!text) return;
        try {
            await navigator.clipboard.writeText(text);
            toastr.success(t('slop.copied'));
        } catch {
            toastr.info(text, '', { timeOut: 10000 });
        }
    });

    const content = el('div', { class: 'stx-popup stx-slop-stats' },
        el('h3', { class: 'stx-popup-title' }, el('i', { class: 'fa-solid fa-broom' }), ' ', t('slop.statsTitle')),
        el('div', { class: 'stx-kpis' },
            kpi(t('slop.kpiIndex'), stats.per1000.toFixed(1), t('slop.kpiIndexHint')),
            kpi(t('slop.kpiHits'), String(stats.hits)),
            kpi(t('slop.kpiMessages'), String(stats.aiMessages)),
            kpi(t('slop.kpiWords'), stats.words.toLocaleString()),
        ),
        el('div', { class: `stx-grade ${g.cls}`, text: t(g.key) }),
        recent.length ? el('div', { class: 'stx-section-title', text: t('slop.chartTitle') }) : null,
        recent.length ? bars : null,
        el('div', { class: 'stx-section-title', text: t('slop.topTitle') }),
        stats.top.length ? table : el('div', { class: 'stx-note', text: t('slop.noHits') }),
        el('div', { class: 'stx-row' }, copy),
        el('small', { class: 'stx-note', text: t('slop.statsHint') }),
    );
    const popup = openPopup(content, { wide: true });
    return popup;
}

function kpi(label, value, hint) {
    return el('div', { class: 'stx-kpi', title: hint ?? '' },
        el('div', { class: 'stx-kpi-value', text: value }),
        el('div', { class: 'stx-kpi-label', text: label }),
    );
}

// ------------------------------------------------------------------ module API

function init() {
    s = moduleSettings(ID);
    rebuild();
    markEngine.register({
        id: 'slop',
        order: 20,
        targets: '.mes_text',
        isActive: () => enabled && s.highlight && !!matcher.regex,
        getRanges: (text, info) => {
            if (info.isUser || info.isSystem) return [];
            const title = t('slop.markTitle');
            return findAll(matcher.regex, text).map(([start, end]) => ({ start, end, cls: 'stx-slop', title }));
        },
    });

    ['CHAT_CHANGED', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED'].forEach(type => {
        onEvent(type, () => {
            if (enabled && s.injectAvoid) updateInjectionDebounced();
        });
    });

    registerSlashCommand({
        name: 'slop',
        helpString: t('slop.slashHelp'),
        callback: () => {
            if (!enabled) return '';
            openStats();
            return String(analyze().per1000.toFixed(2));
        },
    });
}

async function enable() {
    enabled = true;
    applyStyleVars();
    wand = await ui.addWandItem({ id: 'stx_slop_wand', icon: 'fa-broom', label: t('slop.menu'), onClick: () => openStats(), order: 40 });
    markEngine.refresh();
    updateInjection();
}

function disable() {
    enabled = false;
    wand?.remove();
    wand = null;
    markEngine.refresh();
    updateInjection();
}

function onLanguageChange() {
    wand?.setLabel(t('slop.menu'));
    rebuild();
    if (enabled) markEngine.refresh();
}

function buildSettings(root) {
    const refresh = () => {
        applyStyleVars();
        markEngine.refresh();
    };
    const phrases = ui.textarea(s, 'phrases', t('slop.phrases'), {
        rows: 8,
        hint: t('slop.phrasesHint'),
        onChange: () => {
            rebuild();
            markEngine.refresh();
            updateInjectionDebounced();
        },
    });
    statusEl = el('small', { class: 'stx-note stx-status' });
    phrases.append(statusEl);
    rebuild();

    root.append(
        ui.row(ui.button(t('slop.menu'), 'fa-broom', () => openStats())),
        ui.checkbox(s, 'highlight', t('slop.highlight'), { onChange: refresh }),
        ui.select(s, 'style', t('slop.style'), [
            { value: 'wavy', label: t('slop.styleWavy') },
            { value: 'dotted', label: t('slop.styleDotted') },
            { value: 'background', label: t('slop.styleBackground') },
        ], { onChange: refresh }),
        ui.colorInput(s, 'color', t('slop.color'), { onChange: refresh }),
        phrases,
        ui.row(ui.button(t('common.resetDefaults'), 'fa-rotate-left', () => phrases.setValue(moduleDefaultsOf(ID).phrases))),

        ui.section(t('slop.sectionInject')),
        ui.checkbox(s, 'injectAvoid', t('slop.injectAvoid'), { hint: t('slop.injectAvoidHint'), onChange: updateInjection }),
        ui.numberInput(s, 'injectTop', t('slop.injectTop'), { min: 1, max: 30, onChange: updateInjection }),
        ui.numberInput(s, 'injectScope', t('slop.injectScope'), { min: 5, max: 500, onChange: updateInjection }),
        ui.numberInput(s, 'injectDepth', t('slop.injectDepth'), { min: 0, max: 50, onChange: updateInjection }),
        ui.textInput(s, 'injectTemplate', t('slop.injectTemplate'), { hint: t('slop.injectTemplateHint'), onChange: updateInjectionDebounced }),
    );
}

export default {
    id: ID,
    icon: 'fa-broom',
    order: 40,
    defaults,
    titleKey: 'slop.title',
    descKey: 'slop.desc',
    init,
    enable,
    disable,
    buildSettings,
    onLanguageChange,
};
