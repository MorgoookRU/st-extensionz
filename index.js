// Extensionz — a suite of small SillyTavern quality-of-life extensions.
// Every module can be switched on and off independently in Extensions → Extensionz.

import { el } from './src/core/st.js';
import { initSettings, getSettings, registerDefaults, save } from './src/core/settings.js';
import { setLanguage, t, onLanguageChange } from './src/core/i18n.js';
import * as ui from './src/core/ui.js';
import panic from './src/modules/panic.js';
import chatNavigator from './src/modules/navigator.js';
import drafts from './src/modules/drafts.js';
import slop from './src/modules/slop.js';
import notifier from './src/modules/notifier.js';
import perf from './src/modules/perf.js';
import folders from './src/modules/folders.js';

const VERSION = '1.1.0';
const MODULES = [panic, chatNavigator, drafts, folders, slop, notifier, perf].sort((a, b) => a.order - b.order);

MODULES.forEach(module => registerDefaults(module.id, module.defaults));

async function safely(label, fn) {
    try {
        return await fn();
    } catch (error) {
        console.error(`[Extensionz] ${label} failed`, error);
    }
}

async function setModuleEnabled(module, value) {
    const settings = getSettings().modules[module.id];
    settings.enabled = !!value;
    save();
    await safely(`${module.id}.${value ? 'enable' : 'disable'}`, () => value ? module.enable() : module.disable());
}

function drawer({ title, icon, open, cls = '', headerExtra = null }) {
    const content = el('div', { class: 'inline-drawer-content', style: open ? 'display:block' : '' });
    const node = el('div', { class: `inline-drawer ${cls}` },
        el('div', { class: 'inline-drawer-toggle inline-drawer-header' },
            el('b', { class: 'stx-drawer-title' }, icon ? el('i', { class: `fa-solid fa-fw ${icon}` }) : null, ' ', title),
            headerExtra,
            el('div', { class: `inline-drawer-icon fa-solid ${open ? 'fa-circle-chevron-up up' : 'fa-circle-chevron-down down'}` }),
        ),
        content,
    );
    return { node, content };
}

function isDrawerOpen(selector) {
    const content = document.querySelector(`${selector} > .inline-drawer-content`);
    return !!content && getComputedStyle(content).display !== 'none';
}

function renderSettingsPanel() {
    const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!host) return;

    const previous = document.getElementById('stx_settings');
    const mainOpen = previous ? isDrawerOpen('#stx_settings > .inline-drawer') : false;
    const openModules = new Set(MODULES.filter(m => previous && isDrawerOpen(`#stx_settings .stx-module[data-module="${m.id}"]`)).map(m => m.id));

    const settings = getSettings();
    const main = drawer({ title: 'Extensionz', icon: 'fa-wand-magic-sparkles', open: mainOpen });

    const language = ui.select(settings, 'language', t('core.language'), [
        { value: 'auto', label: t('core.languageAuto') },
        { value: 'ru', label: 'Русский' },
        { value: 'en', label: 'English' },
    ], { onChange: (value) => setLanguage(value) });

    main.content.append(
        el('div', { class: 'stx-intro' },
            el('div', { class: 'stx-note', text: t('core.intro') }),
            el('div', { class: 'stx-version', text: `v${VERSION}` }),
        ),
        language,
    );

    for (const module of MODULES) {
        const moduleSettings = settings.modules[module.id];
        const toggle = el('input', { type: 'checkbox', class: 'stx-switch-input', title: t('core.enableModule') });
        toggle.checked = !!moduleSettings.enabled;
        const switchLabel = el('label', { class: 'stx-switch', title: t('core.enableModule') }, toggle, el('span', { class: 'stx-switch-track' }));
        // Keep clicks on the switch from folding/unfolding the drawer.
        switchLabel.addEventListener('click', event => event.stopPropagation());

        const card = drawer({
            title: t(module.titleKey),
            icon: module.icon,
            open: openModules.has(module.id),
            cls: `stx-module${moduleSettings.enabled ? '' : ' stx-off'}`,
            headerExtra: switchLabel,
        });
        card.node.dataset.module = module.id;
        toggle.addEventListener('change', async () => {
            card.node.classList.toggle('stx-off', !toggle.checked);
            await setModuleEnabled(module, toggle.checked);
        });

        card.content.append(el('p', { class: 'stx-desc', text: t(module.descKey) }));
        safely(`${module.id}.buildSettings`, () => module.buildSettings(card.content));
        main.content.append(card.node);
    }

    const panel = el('div', { id: 'stx_settings', class: 'stx-settings' }, main.node);
    if (previous) previous.replaceWith(panel);
    else host.append(panel);
}

async function start() {
    const settings = initSettings();
    setLanguage(settings.language);

    for (const module of MODULES) {
        await safely(`${module.id}.init`, () => module.init());
    }

    renderSettingsPanel();

    for (const module of MODULES) {
        if (settings.modules[module.id].enabled) {
            await safely(`${module.id}.enable`, () => module.enable());
        }
    }

    onLanguageChange(() => {
        MODULES.forEach(module => safely(`${module.id}.onLanguageChange`, () => module.onLanguageChange?.()));
        renderSettingsPanel();
    });

    console.info(`[Extensionz] v${VERSION} loaded: ${MODULES.filter(m => settings.modules[m.id].enabled).map(m => m.id).join(', ')}`);
}

jQuery(() => {
    start();
});
