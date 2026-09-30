#!/usr/bin/env node
// Applies phone-friendly server settings to SillyTavern's config.yaml.
//
//   node apply-lite-config.mjs [path/to/SillyTavern]            apply
//   node apply-lite-config.mjs [path/to/SillyTavern] --dry-run  show what would change
//   node apply-lite-config.mjs [path/to/SillyTavern] --revert   restore the backup
//
// Without a path the script looks for SillyTavern in the parent folders of this file
// (the extension lives inside SillyTavern) and in the current directory.
// Comments in config.yaml are preserved. The original file is saved once as
// config.yaml.before-lite. Restart SillyTavern afterwards.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const CHANGES = [
    [['browserLaunch', 'enabled'], false, 'do not try to open a browser on start'],
    [['logging', 'enableAccessLog'], false, 'do not write every HTTP request to disk'],
    [['logging', 'minLogLevel'], 1, 'no debug spam in the Termux console'],
    [['backups', 'common', 'numberOfBackups'], 10, 'keep 10 backups per chat/settings instead of 50'],
    [['backups', 'chat', 'maxTotalBackups'], 100, 'cap chat backups (default: unlimited)'],
    [['backups', 'chat', 'throttleInterval'], 60000, 'full chat backup at most once a minute (default: 10 s)'],
    [['thumbnails', 'quality'], 85, 'smaller thumbnails, invisible at avatar size'],
    [['performance', 'lazyLoadCharacters'], true, 'load full character cards only when opened'],
    [['performance', 'memoryCacheCapacity'], '32mb', 'smaller in-memory character cache (disk cache stays on)'],
    [['skipContentCheck'], true, 'skip the default-content check on every start'],
    [['extensions', 'autoUpdate'], false, 'no git fetch for every extension on each page load (update manually)'],
    [['extensions', 'models', 'autoDownload'], false, 'never download local AI models (hundreds of MB, heavy CPU)'],
];

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const revert = args.includes('--revert');
const explicitPath = args.find(a => !a.startsWith('--'));

function isSillyTavernRoot(dir) {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        return pkg.name === 'sillytavern' && fs.existsSync(path.join(dir, 'server.js'));
    } catch {
        return false;
    }
}

function findRoot() {
    if (explicitPath) {
        const dir = path.resolve(explicitPath);
        if (!isSillyTavernRoot(dir)) throw new Error(`Not a SillyTavern folder: ${dir}`);
        return dir;
    }
    const starts = [path.dirname(fileURLToPath(import.meta.url)), process.cwd()];
    for (const start of starts) {
        let dir = start;
        for (let i = 0; i < 12; i++) {
            if (isSillyTavernRoot(dir)) return dir;
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
    }
    throw new Error('SillyTavern folder not found. Pass it as the first argument.');
}

function main() {
    const root = findRoot();
    const configPath = path.join(root, 'config.yaml');
    const backupPath = `${configPath}.before-lite`;

    if (revert) {
        if (!fs.existsSync(backupPath)) throw new Error(`No backup found: ${backupPath}`);
        fs.copyFileSync(backupPath, configPath);
        console.log(`Restored ${configPath} from backup. Restart SillyTavern.`);
        return;
    }

    if (!fs.existsSync(configPath)) {
        const defaultConfig = path.join(root, 'default', 'config.yaml');
        if (!fs.existsSync(defaultConfig)) throw new Error('config.yaml not found. Start SillyTavern once first.');
        fs.copyFileSync(defaultConfig, configPath);
    }

    // SillyTavern already depends on the "yaml" package; use its copy.
    const requireFromRoot = createRequire(path.join(root, 'package.json'));
    const YAML = requireFromRoot('yaml');
    const source = fs.readFileSync(configPath, 'utf8');
    const doc = YAML.parseDocument(source);

    let changed = 0;
    for (const [keyPath, value, why] of CHANGES) {
        const current = doc.getIn(keyPath);
        const label = keyPath.join('.');
        if (current === value) {
            console.log(`  = ${label}: ${JSON.stringify(value)}`);
            continue;
        }
        console.log(`  * ${label}: ${JSON.stringify(current)} -> ${JSON.stringify(value)}   (${why})`);
        if (!dryRun) doc.setIn(keyPath, value);
        changed++;
    }

    if (dryRun) {
        console.log(`\n${changed} setting(s) would change. Nothing was written (--dry-run).`);
        return;
    }
    if (!changed) {
        console.log('\nAlready optimized, nothing to do.');
        return;
    }
    if (!fs.existsSync(backupPath)) fs.writeFileSync(backupPath, source);
    fs.writeFileSync(configPath, doc.toString());
    console.log(`\n${changed} setting(s) changed. Backup: ${backupPath}`);
    console.log('Restart SillyTavern to apply. Revert with: node apply-lite-config.mjs --revert');
}

try {
    main();
} catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
}
