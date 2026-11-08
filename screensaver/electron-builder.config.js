// electron-builder configuration.
//
// This lives in a .js file rather than package.json's "build" field because
// signing has to be conditional: a developer build on a machine with no
// certificate must still produce a working .scr, while a release build on a
// machine that has one must produce a signed .scr without anyone editing
// config first.
//
// Signing is opt-in through the environment. Set ONE of:
//
//   CSC_LINK + CSC_KEY_PASSWORD    path to a .pfx and its password
//   BWAI_CERT_SHA1                 thumbprint of a cert in the Windows store
//   BWAI_CERT_SUBJECT              subject name of a cert in the Windows store
//
// The store options are what an EV certificate on a hardware token needs,
// since its private key cannot be exported to a .pfx.
//
// With none of them set, nothing is signed and the build is unchanged.

const certFile    = process.env.CSC_LINK || process.env.BWAI_CERT_FILE || '';
const certSha1    = process.env.BWAI_CERT_SHA1 || '';
const certSubject = process.env.BWAI_CERT_SUBJECT || '';

const signing = !!(certFile || certSha1 || certSubject);

const win = {
    target: [{ target: 'dir', arch: ['x64'] }],
    icon: '../images/favicon-96x96.png',
    // This gate controls both signtool AND rcedit's resource editing. It is
    // off for unsigned builds: with no certificate there is nothing to sign,
    // and rcedit needs a toolchain that is not worth requiring from anyone
    // who just wants to run the screensaver locally.
    signAndEditExecutable: signing,
};

if (signing) {
    win.signtoolOptions = {
        signingHashAlgorithms: ['sha256'],
        rfc3161TimeStampServer:
            process.env.BWAI_TIMESTAMP_URL || 'http://timestamp.digicert.com',
        ...(certFile ? {
            certificateFile: certFile,
            certificatePassword: process.env.CSC_KEY_PASSWORD,
        } : {}),
        ...(certSha1 ? { certificateSha1: certSha1 } : {}),
        ...(certSubject ? { certificateSubjectName: certSubject } : {}),
    };
    console.log('[build] code signing enabled');
} else {
    console.log('[build] no certificate configured — producing an unsigned build');
}

module.exports = {
    appId: 'com.birdwatchai.screensaver',
    productName: 'BirdWatchAI Community Feed',
    win,
    files: [
        'main.js',
        'preload.js',
        'lib/**/*',
        'slideshow.html',
        'slideshow.css',
        'slideshow.js',
        'config.html',
        'config.css',
        'config.js',
        'icon.ico',
        // koffi is a native addon, needed for the Screen Saver Settings
        // preview thumbnail (lib/winpreview.js).
        'node_modules/koffi/**/*',
    ],
    // A native .node cannot be loaded from inside an asar archive.
    asarUnpack: ['**/node_modules/koffi/**'],
    extraMetadata: {
        main: 'main.js',
    },
};
