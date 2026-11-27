// Add bundle-relative image paths here to check assets beyond manifest icons.
(async () => {
  const additionalPaths = [];
  const manifest = chrome.runtime.getManifest();
  const action = manifest.action || manifest.browser_action || {};
  const paths = new Set(additionalPaths);
  for (const icons of [manifest.icons, action.default_icon]) {
    for (const path of typeof icons === 'string' ? [icons] : Object.values(icons || {})) paths.add(path);
  }
  const imageResult = src => new Promise(resolve => {
    const img = new Image();
    const finish = value => {
      clearTimeout(timer);
      img.onload = img.onerror = null;
      resolve(value);
    };
    const timer = setTimeout(() => finish('timeout'), 4000);
    img.onload = () => finish({width: img.naturalWidth, height: img.naturalHeight});
    img.onerror = () => finish('failed');
    img.src = src;
  });
  return Promise.all(Array.from(paths).map(async path => {
    const url = chrome.runtime.getURL(path);
    const item = {path, url, direct: await imageResult(url)};
    if (/\.svg(?:[?#]|$)/i.test(path)) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      try {
        const response = await fetch(url, {signal: controller.signal});
        const text = await response.text();
        item.status = response.status;
        item.contentType = response.headers.get('Content-Type');
        item.characters = text.length;
        item.typedData = await imageResult('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text));
      } catch (error) { item.error = String(error); }
      finally { clearTimeout(timer); }
    }
    return item;
  }));
})()
