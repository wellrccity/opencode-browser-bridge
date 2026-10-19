export const DEFAULT_SETTINGS = Object.freeze({
  serverUrl: 'ws://127.0.0.1:8787',
  token: '',
  autoConnect: true,
  preferCdp: true,
  keepAttached: true,
  interceptDialogs: true,
  confirmDialogs: true,
  promptDialogText: '',
  autoSwitchNewTabs: false
});

export async function getSettings() {
  try {
    const stored = await chrome.storage.local.get('settings');
    return { ...DEFAULT_SETTINGS, ...(stored && stored.settings ? stored.settings : {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...(patch || {}) };
  await chrome.storage.local.set({ settings: next });
  return next;
}
