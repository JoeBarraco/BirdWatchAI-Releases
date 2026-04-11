// BirdWatchAI Screensaver — Preload script
// Exposes a safe API to the renderer via contextBridge.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('screensaverAPI', {
    // Receive settings from main process
    onSettings: (callback) => {
        ipcRenderer.on('init-settings', (_event, settings) => callback(settings));
    },

    // Signal user activity (mouse click) to main so it can quit
    signalActivity: () => {
        ipcRenderer.send('user-activity');
    },

    // Config window: load / save settings
    getSettings: () => ipcRenderer.invoke('get-settings'),
    saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
});
