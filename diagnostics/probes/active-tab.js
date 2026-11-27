// Reads the active tab's frame tree and isolated content-script world.
// No navigation, clicks, script registration, or extension settings changes.
(async () => {
  const native = chrome.__wexNative;
  const inspect = function () {
    const root = document.documentElement;
    return {
      url: location.href,
      readyState: document.readyState,
      bridge: typeof WEXContent,
      extensionId: typeof WEX_CONFIG === 'undefined' ? null : WEX_CONFIG.extensionId,
      baseURI: typeof WEX === 'undefined' ? null : WEX.baseURI,
      markers: root ? Array.from(root.attributes)
        .filter(a => a.name.startsWith('data-wex-bridge'))
        .map(a => [a.name, a.value]) : [],
      extensionScripts: Array.from(document.querySelectorAll('script[src]'))
        .map(s => s.src).filter(url => url.startsWith('safari-extension:')),
      failedExtensionImages: Array.from(document.images)
        .filter(img => img.complete && !img.naturalWidth && img.src.startsWith('safari-extension:'))
        .map(img => img.src),
      fonts: document.fonts ? document.fonts.status : null
    };
  };
  const capture = promise => promise.then(value => ({value}), error => ({error: String(error)}));
  return Promise.all((await chrome.tabs.query({active: true, lastFocusedWindow: true})).map(async tab => {
    const results = await Promise.all([
      capture(native.webNavigation.getAllFrames({tabId: tab.id})),
      capture(native.tabs.executeScript(tab.id, {code: '(' + inspect + ')()'}))
    ]);
    return {tab: {id: tab.id, url: tab.url}, frames: results[0], content: results[1]};
  }));
})()
