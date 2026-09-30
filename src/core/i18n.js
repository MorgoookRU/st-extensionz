import { STRINGS } from './strings.js';
import { ctx } from './st.js';

let language = 'en';
const listeners = new Set();

function detectLanguage() {
    const candidates = [];
    try {
        candidates.push(ctx().getCurrentLocale?.());
    } catch { /* older ST */ }
    candidates.push(...(navigator.languages ?? []), navigator.language);
    for (const candidate of candidates) {
        const code = String(candidate ?? '').toLowerCase().slice(0, 2);
        if (code === 'ru' || code === 'uk' || code === 'be') return 'ru';
    }
    return 'en';
}

export function setLanguage(preference) {
    const next = preference === 'ru' || preference === 'en' ? preference : detectLanguage();
    const changed = next !== language;
    language = next;
    if (changed) listeners.forEach(fn => fn(language));
}

export function getLanguage() {
    return language;
}

/**
 * Translates a key. `{name}` placeholders are replaced from `vars`.
 * @param {string} key
 * @param {Record<string, any>} [vars]
 */
export function t(key, vars) {
    const template = STRINGS[language]?.[key] ?? STRINGS.en[key] ?? key;
    return vars ? template.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? '')) : template;
}

export function onLanguageChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}
