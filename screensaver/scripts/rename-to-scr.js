// Post-build script: rename the portable .exe to .scr for Windows screensaver registration.
// Windows treats .scr files identically to .exe but recognises them as screensavers
// in the Personalization > Lock screen > Screen saver settings panel.

const fs   = require('fs');
const path = require('path');
const glob = require('path');

const distDir = path.join(__dirname, '..', 'dist');

if (!fs.existsSync(distDir)) {
    console.log('dist/ not found — run "npm run build" first.');
    process.exit(1);
}

const files = fs.readdirSync(distDir);
let renamed = false;

for (const file of files) {
    if (file.endsWith('.exe') && file.toLowerCase().includes('screensaver')) {
        const oldPath = path.join(distDir, file);
        const newName = file.replace(/\.exe$/i, '.scr');
        const newPath = path.join(distDir, newName);

        fs.renameSync(oldPath, newPath);
        console.log(`Renamed: ${file} -> ${newName}`);
        renamed = true;
    }
}

if (!renamed) {
    console.log('No matching .exe found in dist/. Available files:');
    files.forEach(f => console.log(`  ${f}`));
}
