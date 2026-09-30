// Folders: quick access to SillyTavern's data folders from the interface.
// Inside the Android app (window.TavernApp) a folder opens in the app's built-in file manager and the
// changed lists are refreshed on return; elsewhere the module shows the folder's path with a copy button.

import { t } from '../core/i18n.js';
import { moduleSettings } from '../core/settings.js';
import { ctx, el, openPopup, registerSlashCommand } from '../core/st.js';
import * as ui from '../core/ui.js';

const ID = 'folders';

const FOLDERS = [
    { id: 'root', path: '', icon: 'fa-folder-tree' },
    { id: 'characters', path: 'characters', icon: 'fa-address-card' },
    { id: 'chats', path: 'chats', icon: 'fa-comments' },
    { id: 'groupChats', path: 'group chats', icon: 'fa-users' },
    { id: 'backgrounds', path: 'backgrounds', icon: 'fa-image' },
    { id: 'personas', path: 'User Avatars', icon: 'fa-user' },
    { id: 'worlds', path: 'worlds', icon: 'fa-book-atlas' },
    { id: 'images', path: 'user/images', icon: 'fa-images' },
    { id: 'files', path: 'user/files', icon: 'fa-paperclip' },
    { id: 'themes', path: 'themes', icon: 'fa-palette' },
    { id: 'extensions', path: 'extensions', icon: 'fa-puzzle-piece' },
    { id: 'backups', path: 'backups', icon: 'fa-box-archive' },
];

// Where the "open folder" buttons go inside SillyTavern's own panels.
const PANEL_BUTTONS = [
    { after: '#external_import_button', path: 'characters', key: 'characters' },
    { after: '#world_import_button', path: 'worlds', key: 'worlds' },
    { after: '#add_background_button_top', path: 'backgrounds', key: 'backgrounds' },
    { after: '#create_dummy_persona', path: 'User Avatars', key: 'personas' },
];

const defaults = {
    enabled: true,
    panelButtons: true,
};

let s = null;
let enabled = false;
let wand = null;
let userHandle = null;

function appBridge() {
    return window.TavernApp && typeof window.TavernApp.openFolder === 'function' ? window.TavernApp : null;
}

async function getHandle() {
    if (userHandle) return userHandle;
    try {
        const response = await fetch('/api/users/me', { headers: ctx().getRequestHeaders() });
        if (response.ok) userHandle = (await response.json())?.handle;
    } catch { /* single-user installs */ }
    userHandle ||= 'default-user';
    return userHandle;
}

function currentChatFolder() {
    const c = ctx();
    if (c.groupId || c.characterId === undefined) return null;
    const avatar = c.characters?.[c.characterId]?.avatar;
    return avatar ? `chats/${avatar.replace(/\.[^.]+$/, '')}` : null;
}

function environment() {
    if (appBridge()) return 'app';
    return /Android/i.test(navigator.userAgent) ? 'termux' : 'desktop';
}

async function displayPath(path) {
    const handle = await getHandle();
    return ['SillyTavern', 'data', handle, path].filter(Boolean).join('/');
}

/** Opens a data folder. Returns true when the Android app handled it. */
export async function openFolder(path) {
    const bridge = appBridge();
    if (bridge) {
        bridge.openFolder(path);
        return true;
    }
    const full = await displayPath(path);
    try {
        await navigator.clipboard.writeText(full);
        toastr.info(t('folders.copied', { path: full }), '', { timeOut: 5000 });
    } catch {
        toastr.info(full, t('folders.pathTitle'), { timeOut: 8000 });
    }
    return false;
}

export async function openFoldersPopup() {
    const env = environment();
    const list = el('div', { class: 'stx-folders' });
    const chatFolder = currentChatFolder();
    const entries = [...FOLDERS];
    if (chatFolder) entries.splice(3, 0, { id: 'currentChat', path: chatFolder, icon: 'fa-comment-dots' });

    for (const folder of entries) {
        const pathLabel = el('small', { class: 'stx-folder-path', text: folder.path ? `…/${folder.path}` : '/' });
        const action = ui.button(env === 'app' ? t('folders.open') : t('folders.copyPath'), env === 'app' ? 'fa-folder-open' : 'fa-copy', () => openFolder(folder.path), { cls: 'stx-small-btn' });
        list.append(el('div', { class: 'stx-folder-row' },
            el('i', { class: `fa-solid fa-fw ${folder.icon} stx-folder-icon` }),
            el('div', { class: 'stx-folder-text' },
                el('div', { class: 'stx-folder-name', text: t(`folders.${folder.id}`) }),
                pathLabel,
            ),
            action,
        ));
    }

    openPopup(el('div', { class: 'stx-popup' },
        el('h3', { class: 'stx-popup-title' }, el('i', { class: 'fa-solid fa-folder-open' }), ' ', t('folders.title')),
        el('small', { class: 'stx-note', text: t(`folders.hint.${env}`) }),
        el('div', { class: 'stx-folder-root' }, el('i', { class: 'fa-solid fa-folder' }), ' ', await displayPath('')),
        list,
    ), { wide: true });
}

// ------------------------------------------------------------------ panel buttons

function injectPanelButtons() {
    for (const spec of PANEL_BUTTONS) {
        const anchor = document.querySelector(spec.after);
        if (!anchor || anchor.parentElement?.querySelector(`.stx-folder-btn[data-folder="${spec.path}"]`)) continue;
        const button = el('div', {
            class: 'menu_button fa-solid fa-folder-open stx-folder-btn',
            title: t('folders.openThis', { name: t(`folders.${spec.key}`) }),
            dataset: { folder: spec.path },
        });
        anchor.after(button);
    }
}

function removePanelButtons() {
    document.querySelectorAll('.stx-folder-btn').forEach(button => button.remove());
}

function syncPanelButtons() {
    if (enabled && s.panelButtons) injectPanelButtons();
    else removePanelButtons();
}

// ------------------------------------------------------------------ changes made in the Android file manager

// Refreshes the SillyTavern lists that show a changed folder; anything else needs a page reload.
const REFRESHERS = {
    characters: () => ctx().getCharacters(),
    worlds: () => ctx().updateWorldInfoList(),
    backgrounds: async () => (await import('/scripts/backgrounds.js')).getBackgrounds(),
    'User Avatars': async () => (await import('/scripts/personas.js')).getUserAvatars(true),
};
const NO_REFRESH_NEEDED = new Set(['chats', 'group chats', 'user', 'backups']);

async function onFilesChanged(event) {
    const folders = event.detail?.folders ?? [];
    let needsReload = false;
    for (const folder of folders) {
        if (NO_REFRESH_NEEDED.has(folder)) continue;
        try {
            if (REFRESHERS[folder]) await REFRESHERS[folder]();
            else needsReload = true;
        } catch (error) {
            console.warn('[Extensionz] folders: refresh failed', folder, error);
            needsReload = true;
        }
    }
    if (needsReload) {
        toastr.info(t('folders.reloadHint'), '', { timeOut: 8000, onclick: () => location.reload() });
    } else if (folders.length) {
        toastr.success(t('folders.refreshed'), '', { timeOut: 2500 });
    }
}

// ------------------------------------------------------------------ module API

function init() {
    s = moduleSettings(ID);
    window.addEventListener('tavernapp:files-changed', event => onFilesChanged(event));
    $(document).on('click', '.stx-folder-btn', function (event) {
        event.preventDefault();
        event.stopPropagation();
        openFolder(this.dataset.folder ?? '');
    });
    registerSlashCommand({
        name: 'folder',
        aliases: ['folders'],
        helpString: t('folders.slashHelp'),
        unnamedArg: { description: FOLDERS.map(f => f.id).join(' | '), enumList: FOLDERS.map(f => f.id) },
        callback: async (_, value) => {
            if (!enabled) return '';
            if (!value) {
                await openFoldersPopup();
                return '';
            }
            const folder = FOLDERS.find(f => f.id.toLowerCase() === value.toLowerCase() || f.path.toLowerCase() === value.toLowerCase());
            const path = folder ? folder.path : value;
            await openFolder(path);
            return displayPath(path);
        },
    });
}

async function enable() {
    enabled = true;
    wand = await ui.addWandItem({ id: 'stx_folders_wand', icon: 'fa-folder-open', label: t('folders.menu'), onClick: () => openFoldersPopup(), order: 35 });
    syncPanelButtons();
}

function disable() {
    enabled = false;
    wand?.remove();
    wand = null;
    removePanelButtons();
}

function onLanguageChange() {
    wand?.setLabel(t('folders.menu'));
    if (enabled && s.panelButtons) {
        removePanelButtons();
        injectPanelButtons();
    }
}

function buildSettings(root) {
    root.append(
        ui.row(ui.button(t('folders.menu'), 'fa-folder-open', () => openFoldersPopup())),
        ui.checkbox(s, 'panelButtons', t('folders.panelButtons'), { hint: t('folders.panelButtonsHint'), onChange: syncPanelButtons }),
        el('small', { class: 'stx-note', text: t(`folders.hint.${environment()}`) }),
    );
}

export default {
    id: ID,
    icon: 'fa-folder-open',
    order: 35,
    defaults,
    titleKey: 'folders.moduleTitle',
    descKey: 'folders.desc',
    init,
    enable,
    disable,
    buildSettings,
    onLanguageChange,
};
