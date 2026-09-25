const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const targets = [
    path.join(root, 'server.js'),
    path.join(root, 'launcher.js'),
    path.join(root, 'src'),
    path.join(root, 'scripts')
];

const skipDirs = new Set(['node_modules', '.git', 'test-data', 'data', 'documents', '.wwebjs_auth', '.wwebjs_cache']);

function walk(entry, out) {
    if (!fs.existsSync(entry)) return;
    const stat = fs.statSync(entry);
    if (stat.isDirectory()) {
        const name = path.basename(entry);
        if (skipDirs.has(name)) return;
        for (const child of fs.readdirSync(entry)) walk(path.join(entry, child), out);
        return;
    }
    if (stat.isFile() && entry.endsWith('.js')) out.push(entry);
}

const files = [];
for (const target of targets) walk(target, files);

let failed = false;
for (const file of files.sort()) {
    const result = spawnSync(process.execPath, ['-c', file], { stdio: 'inherit' });
    if (result.status !== 0) failed = true;
}

if (failed) process.exit(1);
console.log(`Syntax OK: ${files.length} JavaScript files checked.`);
