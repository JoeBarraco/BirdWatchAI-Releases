// Post-build script: rename the main .exe to .scr inside the unpacked build directory.
// The `dir` target produces dist/win-unpacked/ with the real Electron exe + supporting
// DLLs/resources.  Renaming the exe to .scr is all Windows needs to treat it as a
// screensaver — it's the same PE format.

const fs   = require('fs');
const path = require('path');

const unpackedDir = path.join(__dirname, '..', 'dist', 'win-unpacked');

if (!fs.existsSync(unpackedDir)) {
    console.log('dist/win-unpacked/ not found — run "npm run build" first.');
    process.exit(1);
}

const files = fs.readdirSync(unpackedDir);
let renamed = false;

for (const file of files) {
    if (file.endsWith('.exe') && file.toLowerCase().includes('screensaver')) {
        const oldPath = path.join(unpackedDir, file);
        const newName = file.replace(/\.exe$/i, '.scr');
        const newPath = path.join(unpackedDir, newName);

        fs.renameSync(oldPath, newPath);
        console.log(`Renamed: ${file} -> ${newName}`);
        renamed = true;
    }
}

if (!renamed) {
    console.log('No screensaver .exe found in dist/win-unpacked/. Files:');
    files.forEach(f => console.log(`  ${f}`));
    process.exit(1);
}

console.log('');
console.log('Build complete!  Next steps:');
console.log('  Run scripts\\install.bat to install the screensaver.');
