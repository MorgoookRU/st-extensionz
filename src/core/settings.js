import { ctx } from './st.js';

const SETTINGS_KEY = 'stExtensionz';
const moduleDefaults = {};

export function registerDefaults(moduleId, defaults) {
    moduleDefaults[moduleId] = defaults;
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeDefaults(target, defaults) {
    for (const [key, value] of Object.entries(defaults)) {
        if (target[key] === undefined) {
            target[key] = structuredClone(value);
        } else if (isPlainObject(value) && isPlainObject(target[key])) {
            mergeDefaults(target[key], value);
        }
    }
    return target;
}

export function getSettings() {
    const store = ctx().extensionSettings;
    if (!isPlainObject(store[SETTINGS_KEY])) {
        store[SETTINGS_KEY] = {};
    }
    return store[SETTINGS_KEY];
}

export function initSettings() {
    const settings = getSettings();
    mergeDefaults(settings, { language: 'auto', modules: {} });
    for (const [id, defaults] of Object.entries(moduleDefaults)) {
        settings.modules[id] = mergeDefaults(isPlainObject(settings.modules[id]) ? settings.modules[id] : {}, defaults);
    }
    return settings;
}

/** Live settings object of a module (mutate it, then call save()). */
export function moduleSettings(moduleId) {
    return getSettings().modules[moduleId];
}

export function moduleDefaultsOf(moduleId) {
    return structuredClone(moduleDefaults[moduleId]);
}

export function save() {
    ctx().saveSettingsDebounced();
}
