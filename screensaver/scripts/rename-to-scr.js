// Post-build script: rename the main .exe to .scr inside the unpacked build directory.
// The `dir` target produces dist/win-unpacked/ with the real Electron exe + supporting
// DLLs/resources.  Renaming the exe to .scr is all Windows needs to treat it as a
// screensaver — it's the same PE format.
//
// The target is whatever electron-builder named after `build.productName`, so this
// keeps working when the product is renamed. It used to match on the literal string
// "screensaver", which silently failed the build the moment the name changed.

const fs   = require('fs');
const path = require('path');

const unpackedDir = path.join(__dirname, '..', 'dist', 'win-unpacked');

if (!fs.existsSync(unpackedDir)) {
    console.log('dist/win-unpacked/ not found — run "npm run build" first.');
    process.exit(1);
}

const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8')
);
const productName = (pkg.build && pkg.build.productName) || pkg.name;

const files = fs.readdirSync(unpackedDir);

// Electron ships several .exe files in the unpacked output (the app, plus
// crash handlers and helpers). Only the one named after the product is ours.
const target = files.find(f => f.toLowerCase() === `${productName.toLowerCase()}.exe`);

if (!target) {
    console.log(`No "${productName}.exe" found in dist/win-unpacked/. Files:`);
    files.forEach(f => console.log(`  ${f}`));
    process.exit(1);
}

const newName = target.replace(/\.exe$/i, '.scr');
fs.renameSync(path.join(unpackedDir, target), path.join(unpackedDir, newName));
console.log(`Renamed: ${target} -> ${newName}`);

console.log('');
console.log('Build complete!  Next steps:');
console.log('  Run scripts\\install.bat to install the screensaver.');
