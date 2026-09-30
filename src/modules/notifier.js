// Reply notifier: sound / vibration / blinking tab / system notification when a reply is ready,
// plus a screen wake lock so a phone does not fall asleep (and kill the stream) mid-generation.

import { t } from '../core/i18n.js';
import { moduleSettings } from '../core/settings.js';
import { ctx, onEvent } from '../core/st.js';
import * as ui from '../core/ui.js';
import { isPanicActive } from './panic.js';

const ID = 'notifier';

const defaults = {
    enabled: true,
    onlyWhenHidden: true,
    sound: true,
    volume: 40,
    vibrate: true,
    flashTitle: true,
    systemNotification: false,
    showPreview: false,
    wakeLock: 'generation',
    minDuration: 3,
};

let s = null;
let enabled = false;
let generating = false;
let stoppedByUser = false;
let startedAt = 0;
let notifyTimer = null;
let audioContext = null;
let wakeLock = null;
let titleTimer = null;
let titleBackup = null;

// ------------------------------------------------------------------ sound

function unlockAudio() {
    if (!audioContext) {
        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (AudioCtx) audioContext = new AudioCtx();
        } catch { /* no audio */ }
    }
    if (audioContext?.state === 'suspended') audioContext.resume().catch(() => { });
}

function playChime() {
    unlockAudio();
    if (!audioContext) return;
    const volume = Math.max(0, Math.min(100, Number(s.volume) || 0)) / 100;
    if (!volume) return;
    const now = audioContext.currentTime;
    [[880, 0], [1318.5, 0.13]].forEach(([frequency, offset]) => {
        const osc = audioContext.createOscillator();
        const gain = audioContext.createGain();
        osc.type = 'sine';
        osc.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, now + offset);
        gain.gain.exponentialRampToValueAtTime(0.35 * volume, now + offset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.45);
        osc.connect(gain).connect(audioContext.destination);
        osc.start(now + offset);
        osc.stop(now + offset + 0.5);
    });
}

// ------------------------------------------------------------------ title

function startTitleFlash(text) {
    stopTitleFlash();
    titleBackup = document.title;
    let on = false;
    titleTimer = setInterval(() => {
        if (isPanicActive()) return;
        on = !on;
        document.title = on ? text : titleBackup;
    }, 1000);
}

function stopTitleFlash() {
    if (titleTimer) {
        clearInterval(titleTimer);
        titleTimer = null;
        if (titleBackup !== null && !isPanicActive()) document.title = titleBackup;
    }
    titleBackup = null;
}

// ------------------------------------------------------------------ notifications

async function showSystemNotification(title, body) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const options = { body, tag: 'stx-reply', silent: true, icon: '/favicon.ico' };
    try {
        const notification = new Notification(title, options);
        notification.onclick = () => {
            window.focus();
            notification.close();
        };
        return;
    } catch {
        // Android Chrome only allows notifications through a service worker.
    }
    try {
        const registration = await navigator.serviceWorker?.getRegistration();
        await registration?.showNotification(title, options);
    } catch { /* not available */ }
}

function lastReply() {
    const { chat } = ctx();
    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i];
        if (message && !message.is_user && !message.is_system) return message;
    }
    return null;
}

export function notifyReady({ test = false } = {}) {
    if (!enabled && !test) return;
    if (isPanicActive()) return;
    const hidden = document.visibilityState === 'hidden' || !document.hasFocus();
    if (!test && s.onlyWhenHidden && !hidden) return;

    const reply = lastReply();
    const name = reply?.name || ctx().name2 || 'AI';
    const title = t('notifier.readyTitle', { name });

    if (s.sound) playChime();
    if (s.vibrate) {
        try {
            navigator.vibrate?.([70, 50, 70]);
        } catch { /* ignore */ }
    }
    if (s.flashTitle && (hidden || test)) startTitleFlash(`✉ ${title}`);
    if (s.systemNotification) {
        const body = s.showPreview && reply?.mes ? reply.mes.replace(/\s+/g, ' ').slice(0, 140) : t('notifier.readyBody');
        showSystemNotification(title, body);
    }
}

// ------------------------------------------------------------------ wake lock

async function acquireWakeLock() {
    if (wakeLock || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch { /* denied, e.g. battery saver or insecure context */ }
}

async function releaseWakeLock() {
    const lock = wakeLock;
    wakeLock = null;
    try {
        await lock?.release();
    } catch { /* ignore */ }
}

function syncWakeLock() {
    const wanted = enabled && (s.wakeLock === 'always' || (s.wakeLock === 'generation' && generating));
    if (wanted) acquireWakeLock();
    else releaseWakeLock();
}

// ------------------------------------------------------------------ events

function onGenerationStarted(type, _options, dryRun) {
    if (!enabled || dryRun || type === 'quiet') return;
    clearTimeout(notifyTimer);
    generating = true;
    stoppedByUser = false;
    startedAt = Date.now();
    syncWakeLock();
}

function onGenerationStopped() {
    stoppedByUser = true;
}

function onGenerationEnded() {
    if (!generating) return;
    generating = false;
    syncWakeLock();
    const long = Date.now() - startedAt >= (Number(s.minDuration) || 0) * 1000;
    if (!enabled || stoppedByUser || !long) return;
    // Group chats and auto-continue start the next generation right away; wait a moment so
    // only the final reply triggers a notification.
    clearTimeout(notifyTimer);
    notifyTimer = setTimeout(() => notifyReady(), 1200);
}

function onVisibilityChange() {
    if (document.visibilityState === 'visible') {
        stopTitleFlash();
        syncWakeLock();
    }
}

// ------------------------------------------------------------------ module API

function init() {
    s = moduleSettings(ID);
    onEvent('GENERATION_STARTED', onGenerationStarted);
    onEvent('GENERATION_STOPPED', onGenerationStopped);
    onEvent('GENERATION_ENDED', onGenerationEnded);
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', stopTitleFlash);
    // Browsers only allow audio after a user gesture; prepare the context on the first one.
    ['pointerdown', 'keydown'].forEach(type => window.addEventListener(type, () => {
        if (enabled && s.sound) unlockAudio();
    }, { capture: true, passive: true }));
}

function enable() {
    enabled = true;
    syncWakeLock();
}

function disable() {
    enabled = false;
    clearTimeout(notifyTimer);
    stopTitleFlash();
    releaseWakeLock();
}

function onLanguageChange() { }

function buildSettings(root) {
    const wakeSupported = 'wakeLock' in navigator;
    root.append(
        ui.row(ui.button(t('notifier.test'), 'fa-bell', () => {
            unlockAudio();
            notifyReady({ test: true });
            setTimeout(stopTitleFlash, 4000);
        })),
        ui.checkbox(s, 'onlyWhenHidden', t('notifier.onlyWhenHidden'), { hint: t('notifier.onlyWhenHiddenHint') }),
        ui.checkbox(s, 'sound', t('notifier.sound')),
        ui.range(s, 'volume', t('notifier.volume'), { min: 0, max: 100, step: 5, suffix: '%' }),
        ui.checkbox(s, 'vibrate', t('notifier.vibrate'), { hint: t('notifier.vibrateHint') }),
        ui.checkbox(s, 'flashTitle', t('notifier.flashTitle')),
        ui.checkbox(s, 'systemNotification', t('notifier.systemNotification'), {
            hint: t('notifier.systemNotificationHint'),
            onChange: async (value) => {
                if (value && 'Notification' in window && Notification.permission === 'default') {
                    try {
                        await Notification.requestPermission();
                    } catch { /* ignore */ }
                }
            },
        }),
        ui.checkbox(s, 'showPreview', t('notifier.showPreview')),
        ui.numberInput(s, 'minDuration', t('notifier.minDuration'), { min: 0, max: 600, hint: t('notifier.minDurationHint') }),

        ui.section(t('notifier.sectionWake')),
        ui.select(s, 'wakeLock', t('notifier.wakeLock'), [
            { value: 'generation', label: t('notifier.wakeGeneration') },
            { value: 'always', label: t('notifier.wakeAlways') },
            { value: 'off', label: t('notifier.wakeOff') },
        ], { hint: wakeSupported ? t('notifier.wakeHint') : t('notifier.wakeUnsupported'), onChange: syncWakeLock }),
    );
}

export default {
    id: ID,
    icon: 'fa-bell',
    order: 50,
    defaults,
    titleKey: 'notifier.title',
    descKey: 'notifier.desc',
    init,
    enable,
    disable,
    buildSettings,
    onLanguageChange,
};
