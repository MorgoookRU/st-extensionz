// Text matching utilities shared by the modules.
//
// Keyword list syntax (one entry per line, or comma-separated):
//   поцелуй          -> "smart" word forms: поцелуя, поцелуем, поцелуями ... (kiss -> kisses, kissed, kissing)
//   поцел*           -> explicit wildcard: any word starting with "поцел"
//   "кровь"          -> exact word only, no extra forms
//   дрожь по спине   -> phrase, any whitespace between words
//   /регулярка/      -> raw JavaScript regular expression (case-insensitive, unicode)
//   # comment        -> ignored
// Letters "е" and "ё" are treated as the same letter, apostrophes ' and ’ as well.

const WORD_CHAR = '[\\p{L}\\p{N}_]';
const WORD_BOUNDARY_BEFORE = `(?<!${WORD_CHAR})`;
const WORD_BOUNDARY_AFTER = `(?!${WORD_CHAR})`;
const CYRILLIC_WORD = /^[\p{Script=Cyrillic}-]+$/u;
const LATIN_WORD = /^[a-z]+$/i;
const CYRILLIC_SOFT_ENDING = /[аеёиоуыэюяйь]$/i;
const WORD_RE = /[\p{L}\p{N}_'’-]/u;

function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function foldLetters(escaped) {
    return escaped
        .replace(/[её]/g, '[её]')
        .replace(/[ЕЁ]/g, '[ЕЁ]')
        .replace(/['’]/g, '[\'’]');
}

function tokenPattern(token, smart) {
    if (token.includes('*')) {
        return token.split('*').map(part => foldLetters(escapeRegex(part))).join(`${WORD_CHAR}*`);
    }
    if (smart && CYRILLIC_WORD.test(token)) {
        let stem = token;
        if (stem.length > 4 && CYRILLIC_SOFT_ENDING.test(stem)) {
            stem = stem.slice(0, -1);
        }
        return `${foldLetters(escapeRegex(stem))}\\p{L}{0,3}`;
    }
    if (smart && LATIN_WORD.test(token)) {
        return `${escapeRegex(token)}(?:s|es|ed|d|ing|er|ers|y)?`;
    }
    return foldLetters(escapeRegex(token));
}

/**
 * Splits the raw list into entries. Regex lines are kept intact (they may contain commas).
 * @param {string} raw
 * @returns {string[]}
 */
export function parseEntries(raw) {
    const entries = [];
    for (const line of String(raw ?? '').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        if (/^\/.+\/[a-z]*$/i.test(trimmed)) {
            entries.push(trimmed);
            continue;
        }
        for (const part of trimmed.split(',')) {
            const entry = part.trim();
            if (entry) entries.push(entry);
        }
    }
    return entries;
}

/**
 * Builds one global, case-insensitive, unicode-aware RegExp for a keyword list.
 * @param {string|string[]} source Raw list text or already parsed entries.
 * @param {{smart?: boolean}} [options]
 * @returns {{regex: RegExp|null, errors: string[], count: number}}
 */
export function buildMatcher(source, { smart = true } = {}) {
    const entries = Array.isArray(source) ? source : parseEntries(source);
    const plain = [];
    const raw = [];
    const errors = [];

    for (const entry of entries) {
        const regexMatch = entry.match(/^\/(.+)\/([a-z]*)$/i);
        if (regexMatch) {
            try {
                new RegExp(regexMatch[1], 'giu');
                raw.push(regexMatch[1]);
            } catch {
                errors.push(entry);
            }
            continue;
        }

        const quoted = entry.match(/^"(.+)"$/) || entry.match(/^«(.+)»$/);
        const text = quoted ? quoted[1] : entry;
        const tokens = text.split(/\s+/).filter(Boolean);
        if (!tokens.length) continue;
        plain.push(tokens.map(token => tokenPattern(token, smart && !quoted)).join('\\s+'));
    }

    // Longer alternatives first, so phrases win over their own first word.
    plain.sort((a, b) => b.length - a.length);

    const parts = [];
    if (plain.length) parts.push(`${WORD_BOUNDARY_BEFORE}(?:${plain.join('|')})${WORD_BOUNDARY_AFTER}`);
    if (raw.length) parts.push(...raw.map(r => `(?:${r})`));

    if (!parts.length) {
        return { regex: null, errors, count: 0 };
    }

    try {
        return { regex: new RegExp(parts.join('|'), 'giu'), errors, count: plain.length + raw.length };
    } catch (error) {
        console.warn('[Extensionz] Failed to build matcher', error);
        return { regex: null, errors: [...errors, String(error?.message ?? error)], count: 0 };
    }
}

/**
 * @param {RegExp} regex Global regex
 * @param {string} text
 * @returns {Array<[number, number, string]>} [start, end, matchedText]
 */
export function findAll(regex, text) {
    const hits = [];
    if (!regex || !text) return hits;
    regex.lastIndex = 0;
    let match;
    let guard = 0;
    while ((match = regex.exec(text)) && guard++ < 10000) {
        if (match[0].length === 0) {
            regex.lastIndex++;
            continue;
        }
        hits.push([match.index, match.index + match[0].length, match[0]]);
    }
    return hits;
}

/** Trims whitespace off a [start, end) range. Returns null for an empty range. */
export function trimRange(text, start, end) {
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    return end > start ? [start, end] : null;
}

/** Grows a range to full words on both sides. */
export function expandToWord(text, start, end) {
    while (start > 0 && WORD_RE.test(text[start - 1])) start--;
    while (end < text.length && WORD_RE.test(text[end])) end++;
    return [start, end];
}

const segmenters = new Map();

function getSegmenter(language, granularity) {
    const key = `${language}:${granularity}`;
    if (!segmenters.has(key)) {
        try {
            segmenters.set(key, new Intl.Segmenter(language, { granularity }));
        } catch {
            segmenters.set(key, null);
        }
    }
    return segmenters.get(key);
}

/**
 * Sentence ranges of a text block (whitespace-trimmed).
 * @returns {Array<[number, number]>}
 */
export function sentenceRanges(text, language = 'en') {
    const ranges = [];
    const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? getSegmenter(language, 'sentence') : null;

    if (segmenter) {
        for (const { index, segment } of segmenter.segment(text)) {
            // Intl.Segmenter keeps line breaks inside a sentence in rare cases; split on them too.
            let offset = index;
            for (const piece of segment.split(/(\n+)/)) {
                const range = trimRange(text, offset, offset + piece.length);
                if (range && !/^\n+$/.test(piece)) ranges.push(range);
                offset += piece.length;
            }
        }
        return ranges;
    }

    const re = /[^.!?…\n]+(?:[.!?…]+["»”’')\]]*|\n|$)/g;
    let match;
    while ((match = re.exec(text))) {
        if (!match[0]) {
            re.lastIndex++;
            continue;
        }
        const range = trimRange(text, match.index, match.index + match[0].length);
        if (range) ranges.push(range);
    }
    return ranges;
}

/** Word ranges of a text. */
export function wordRanges(text) {
    const ranges = [];
    const re = /[\p{L}\p{N}][\p{L}\p{N}_'’-]*/gu;
    let match;
    while ((match = re.exec(text))) {
        ranges.push([match.index, match.index + match[0].length]);
    }
    return ranges;
}

/** Normalizes text for loose comparisons: lower case, ё -> е. Keeps string length. */
export function foldForSearch(text) {
    return String(text ?? '').toLowerCase().replace(/ё/g, 'е');
}

export function countWords(text) {
    const matches = String(text ?? '').match(/[\p{L}\p{N}]+/gu);
    return matches ? matches.length : 0;
}
