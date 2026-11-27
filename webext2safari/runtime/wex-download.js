// The page that saves a file for chrome.downloads.
//
// Safari saves what a page's link with a download attribute points to, and
// keeps the global page out of its downloads. The global page opens this
// page in a hidden tab, with the download's token as its query. The page
// tells the global page it is there, and is sent the file's bytes on the
// extension's "wex-downloads" broadcast channel. It saves them under the name
// it is given and reports back.

(function (g) {
  "use strict";

  var DOWNLOAD_START_WAIT = 500;
  var token = String(g.location.search).slice(1);
  var channel = new g.BroadcastChannel("wex-downloads");

  channel.onmessage = function (e) {
    var m = e.data || {};
    if (m.token !== token || !m.bytes) {
      return;
    }
    try {
      var blob = new g.Blob([m.bytes], { type: m.type || "application/octet-stream" });
      var link = g.document.createElement("a");
      link.href = g.URL.createObjectURL(blob);
      link.download = m.filename;
      g.document.body.appendChild(link);
      link.click();
      // The global page closes this tab on hearing this, which is to wait
      // until the download has started.
      g.setTimeout(function () {
        channel.postMessage({ token: token, saved: true });
      }, DOWNLOAD_START_WAIT);
    } catch (err) {
      channel.postMessage({ token: token, failed: String(err && err.message || err) });
    }
  };

  // The global page learns from the message which tab this is, before the
  // page asks for the file.
  function ready() {
    channel.postMessage({ token: token, ready: true });
  }
  var engine = g.browser && g.browser.runtime;
  if (engine && typeof engine.sendMessage === "function") {
    engine.sendMessage({ __wex: "runtimePage", token: token }).then(ready, ready);
  } else {
    ready();
  }
})(this);
