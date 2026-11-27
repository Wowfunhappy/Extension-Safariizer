// Evaluated on any converted extension's global page.
(async () => {
  const manifest = chrome.runtime.getManifest();
  return {
    name: manifest.name,
    version: manifest.version,
    extensionId: chrome.runtime.id,
    baseURI: safari.extension.baseURI,
    language: navigator.language,
    nativeAPIs: Object.keys(chrome.__wexNative || {}),
    bridgeWhitelist: typeof WEX !== 'undefined' ? WEX.CONFIG.bridgeWhitelist : null,
    bridgeRegistrations: safari.extension.settings.getItem('wex.bridgeScripts'),
    runtimeDiagnostics: window.__wexDiagnostics || [],
    tabs: (await chrome.tabs.query({})).map(tab => ({
      id: tab.id, url: tab.url, title: tab.title, active: tab.active, status: tab.status
    }))
  };
})()
