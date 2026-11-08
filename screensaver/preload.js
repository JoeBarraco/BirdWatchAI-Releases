// BirdWatchAI Community Feed — Preload script
// Exposes a safe API to the renderer via contextBridge.
//
// Note what is NOT here: anything that hands the renderer an access token. The
// slideshow receives finished photo records and never touches Supabase or the
// session itself.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('screensaverAPI', {
    // Receive settings from main process
    onSettings: (callback) => {
        ipcRenderer.on('init-settings', (_event, settings) => callback(settings));
    },

    // Receive each feed load / refresh from the main process
    onFeed: (callback) => {
        ipcRenderer.on('feed-update', (_event, result) => callback(result));
    },

    // Signal user activity (mouse click) to main so it can quit
    signalActivity: () => {
        ipcRenderer.send('user-activity');
    },

    // Config window: load / save settings
    getSettings: () => ipcRenderer.invoke('get-settings'),
    saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

    // Config window: community account (unlocks private-community feeders)
    authStatus:  () => ipcRenderer.invoke('auth-status'),
    authRequest: (email) => ipcRenderer.invoke('auth-request', email),
    authVerify:  (email, code) => ipcRenderer.invoke('auth-verify', email, code),
    authSignOut: () => ipcRenderer.invoke('auth-signout'),

    // Config window: feeder list and photo cache
    listFeeders: () => ipcRenderer.invoke('list-feeders'),
    cacheStats:  () => ipcRenderer.invoke('cache-stats'),
    clearCache:  () => ipcRenderer.invoke('cache-clear'),
});
