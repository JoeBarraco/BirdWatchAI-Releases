// BirdWatchAI Screensaver — Configuration window logic

const transitionEl  = document.getElementById('transition');
const intervalEl    = document.getElementById('interval');
const sortModeEl    = document.getElementById('sortMode');
const showCaptionEl = document.getElementById('showCaption');
const showProgressEl= document.getElementById('showProgress');
const statusMsg     = document.getElementById('status-msg');

// Load current settings into the form
async function loadSettings() {
    const settings = await window.screensaverAPI.getSettings();

    transitionEl.value  = settings.transition  || 'random';
    intervalEl.value    = String(settings.interval || 6000);
    sortModeEl.value    = settings.sortMode    || 'random';
    showCaptionEl.checked  = settings.showCaption  !== false;
    showProgressEl.checked = settings.showProgress !== false;
}

// Save settings and close
document.getElementById('btn-save').addEventListener('click', async () => {
    const settings = {
        transition:   transitionEl.value,
        interval:     parseInt(intervalEl.value, 10),
        sortMode:     sortModeEl.value,
        showCaption:  showCaptionEl.checked,
        showProgress: showProgressEl.checked,
    };

    await window.screensaverAPI.saveSettings(settings);

    statusMsg.textContent = 'Settings saved!';
    setTimeout(() => window.close(), 600);
});

// Cancel — close without saving
document.getElementById('btn-cancel').addEventListener('click', () => {
    window.close();
});

// Init
loadSettings();
