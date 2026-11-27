// The converter's global page.
//
// A store page's "Add to Safari" button (store.js) asks for an extension by
// its page's address, and an address entered in the extension's preference
// in Safari's Preferences opens convert.html, which asks for the extension
// at that address the same way. This downloads the extension, converts it with the
// JavaScript converter in converter/, signs the result with this browser's
// own self-signed identity, and hands the .safariextz back to the page that
// asked, which saves it as a download. Progress goes back to that page as it
// happens.

(function () {
  "use strict";

  var IDENTITY_KEY = "signingIdentity";
  var URL_SETTING = "convertUrl";

  var bytes = W2S.bytes;
  var webstore = W2S.webstore;

  function send(page, name, message) {
    try {
      page.dispatchMessage(name, message);
    } catch (e) {
      // The tab closed or moved on; nobody is waiting for this any more.
    }
  }

  // -- network ------------------------------------------------------- //

  // How long a request may go without receiving anything before it counts as
  // stalled. A large download that keeps arriving may take as long as it needs.
  var STALL_TIMEOUT = 60000;

  function fetchBytes(url, onProgress) {
    return new Promise(function (resolve, reject) {
      var request = new XMLHttpRequest();
      var watchdog = null;
      function watch() {
        clearTimeout(watchdog);
        watchdog = setTimeout(function () {
          request.abort();
          reject(new Error("the download stalled; check the network connection"));
        }, STALL_TIMEOUT);
      }
      request.open("GET", url);
      request.responseType = "arraybuffer";
      request.onprogress = function (event) {
        watch();
        if (onProgress && event.lengthComputable && event.total) {
          onProgress(event.loaded / event.total);
        }
      };
      request.onload = function () {
        clearTimeout(watchdog);
        if (request.status >= 200 && request.status < 300 && request.response &&
            request.response.byteLength) {
          resolve(new Uint8Array(request.response));
        } else if (request.status >= 200 && request.status < 300) {
          // The Chrome Web Store answers 204 with nothing for an extension it
          // no longer offers.
          reject(new Error("the store offers no download for this extension; it may have been taken down"));
        } else {
          reject(new Error("the download failed with status " + request.status));
        }
      };
      request.onerror = function () {
        clearTimeout(watchdog);
        reject(new Error("the download failed; check the network connection"));
      };
      watch();
      request.send();
    });
  }

  function fetchJson(url) {
    return fetchBytes(url).then(function (data) {
      return JSON.parse(bytes.text(data));
    });
  }

  // A file of this extension's own bundle.
  function bundleFile(path) {
    return new Promise(function (resolve, reject) {
      var request = new XMLHttpRequest();
      request.open("GET", safari.extension.baseURI + path);
      request.responseType = "arraybuffer";
      request.onload = function () {
        if (request.response && request.response.byteLength) {
          resolve(new Uint8Array(request.response));
        } else {
          reject(new Error("the converter's own file " + path + " is missing"));
        }
      };
      request.onerror = function () {
        reject(new Error("the converter's own file " + path + " could not be read"));
      };
      request.send();
    });
  }

  var runtimePromise = null;

  function runtime() {
    if (!runtimePromise) {
      var out = {};
      runtimePromise = Promise.all(W2S.convert.RUNTIME_FILES.concat(W2S.convert.RUNTIME_DATA).map(function (name) {
        return bundleFile("runtime/" + name).then(function (data) { out[name] = data; });
      })).then(function () {
        return out;
      }, function (error) {
        runtimePromise = null;
        throw error;
      });
    }
    return runtimePromise;
  }

  // Where to download the extension a request names: {url, source}, where
  // `source` is what the converter is told the extension came from. A store
  // page's address names what the page offers; any other web address is the
  // extension's archive itself (.crx, .xpi or .zip).
  function resolveDownload(request) {
    var chromeId = webstore.extensionId(request.url);
    if (chromeId) {
      return Promise.resolve({ url: webstore.downloadUrl(chromeId), source: request.url,
                               listing: webstore.chromeListing(chromeId, null, request.publisher) });
    }
    var addon = webstore.firefoxAddon(request.url);
    if (addon) {
      var shown = request.file && /^https:\/\/addons\.mozilla\.org\/[^?#]*\.xpi(\?|$)/.test(request.file)
        ? request.file : null;
      return fetchJson(webstore.firefoxApiUrl(addon)).then(function (info) {
        var file = info && info.current_version && info.current_version.file;
        if (!shown && (!file || !file.url)) {
          throw new Error("Firefox Add-ons offers no file for this add-on");
        }
        return { url: shown || file.url, source: request.url,
                 listing: webstore.firefoxListing(info, navigator.language) };
      }, function (error) {
        // The file the page offers is converted without what the listing says.
        if (shown) {
          return { url: shown, source: request.url, listing: null };
        }
        throw error;
      });
    }
    if (/^https?:\/\/[^\/?#]+/i.test(request.url)) {
      return Promise.resolve({ url: webstore.rawArchiveUrl(request.url) || request.url,
                               source: request.url });
    }
    return Promise.reject(new Error("this is not the web address of an extension's store " +
                                    "page or of its .crx, .xpi or .zip file"));
  }

  // -- images -------------------------------------------------------- //

  var IMAGE_TYPES = {
    jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    bmp: "image/bmp", ico: "image/x-icon", svg: "image/svg+xml", png: "image/png"
  };

  // Decodes an icon the converter cannot decode itself, such as a JPEG or an
  // SVG, by drawing it on a canvas.
  function convertImage(data, path) {
    return new Promise(function (resolve) {
      var extension = (/\.([a-z0-9]+)$/i.exec(path) || [])[1] || "";
      var type = IMAGE_TYPES[extension.toLowerCase()] || "application/octet-stream";
      var image = new Image();
      image.onload = function () {
        var width = image.naturalWidth || 128;
        var height = image.naturalHeight || 128;
        // A vector image is drawn at the largest size the bundle needs.
        if (type === "image/svg+xml" && Math.max(width, height) < 128) {
          var scale = 128 / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        try {
          var canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          var context = canvas.getContext("2d");
          context.drawImage(image, 0, 0, width, height);
          var pixels = context.getImageData(0, 0, width, height).data;
          resolve({ width: width, height: height, pixels: new Uint8Array(pixels.buffer) });
        } catch (e) {
          resolve(null);
        }
      };
      image.onerror = function () { resolve(null); };
      image.src = "data:" + type + ";base64," + bytes.base64(data);
    });
  }
  convertImage.svg = true;

  // -- signing ------------------------------------------------------- //

  // This browser's signing identity, made the first time it is needed and
  // kept in the global page's storage, so every extension converted here is
  // signed by the same certificate.
  function identity() {
    var stored = null;
    try {
      stored = JSON.parse(localStorage.getItem(IDENTITY_KEY) || "null");
    } catch (e) {
      stored = null;
    }
    if (!stored) {
      stored = W2S.rsa.createIdentity();
      try {
        localStorage.setItem(IDENTITY_KEY, JSON.stringify(stored));
      } catch (e) {
        // Unsaved, the next conversion makes another; Safari accepts either.
      }
    }
    return W2S.rsa.loadIdentity(stored);
  }

  // A download name for the archive: what Safari will call the extension.
  function archiveName(displayName) {
    return displayName.replace(/[\/:\\?%*|"<>\x00-\x1f]/g, "-").trim() + ".safariextz";
  }

  // -- conversion ---------------------------------------------------- //

  var busy = [];

  function convert(page, request) {
    var job = request.job;
    // One conversion at a time per page; a store page that moved on to
    // another extension while one runs is told to wait for it.
    if (busy.indexOf(page) >= 0) {
      send(page, "w2s-failed", { job: job, message: "another extension is still being " +
                                 "converted from this page; try again when it is done" });
      return;
    }
    busy.push(page);
    function progress(stage, fraction) {
      send(page, "w2s-progress", { job: job, stage: stage, fraction: fraction });
    }

    progress("download", 0);
    resolveDownload(request).then(function (download) {
      return Promise.all([
        fetchBytes(download.url, function (fraction) { progress("download", fraction); }),
        runtime()
      ]).then(function (results) {
        progress("convert");
        return W2S.convert.convert({
          source: download.source,
          archive: results[0],
          runtime: results[1],
          convertImage: convertImage,
          uiLanguage: navigator.language,
          listing: download.listing
        });
      });
    }).then(function (result) {
      progress("sign");
      // Yield so the page can show the stage before the work blocks.
      return new Promise(function (resolve) { setTimeout(resolve, 0); }).then(function () {
        rememberBundle(request.url, result.bundleId);
        var archive = W2S.convert.pack(result, identity());
        send(page, "w2s-converted", {
          job: job,
          fileName: archiveName(result.displayName),
          name: result.displayName,
          data: bytes.base64(archive)
        });
      });
    }).catch(function (error) {
      send(page, "w2s-failed", { job: job, message: error && error.message || String(error) });
    }).then(function () {
      busy.splice(busy.indexOf(page), 1);
    });
  }

  // -- what is installed --------------------------------------------- //

  // The bundle each store page's extension was converted to, by the key the
  // store page names it by, so that the page can show it installed. An
  // extension this converter made answers another extension asking which it
  // is, while it is installed and enabled.
  var BUNDLES_KEY = "convertedBundles";

  function storeKey(url) {
    var id = webstore.extensionId(url);
    if (id) {
      return "chrome:" + id;
    }
    var addon = webstore.firefoxAddon(url);
    return addon ? "firefox:" + addon : null;
  }

  function loadBundles() {
    try {
      return JSON.parse(localStorage.getItem(BUNDLES_KEY) || "{}") || {};
    } catch (e) {
      return {};
    }
  }

  function rememberBundle(url, bundleId) {
    var key = storeKey(url);
    if (!key || !bundleId) {
      return;
    }
    var bundles = loadBundles();
    bundles[key] = bundleId;
    try {
      localStorage.setItem(BUNDLES_KEY, JSON.stringify(bundles));
    } catch (e) { /* the page cannot show it installed */ }
  }

  function isInstalled(key) {
    var bundleId = loadBundles()[key];
    if (!bundleId || typeof browser === "undefined" || !browser.runtime ||
        typeof browser.runtime.sendMessage !== "function") {
      return Promise.resolve(false);
    }
    return browser.runtime.sendMessage(bundleId, { __wex: "identify" }).then(function (reply) {
      return !!(reply && reply.id);
    }, function () {
      return false;
    });
  }

  safari.application.addEventListener("message", function (event) {
    if (!event.message || !event.target || !event.target.page) {
      return;
    }
    var page = event.target.page;
    if (event.name === "w2s-convert") {
      convert(page, event.message);
    } else if (event.name === "w2s-status") {
      var key = String(event.message.extension);
      isInstalled(key).then(function (installed) {
        send(page, "w2s-status", { extension: key, installed: installed });
      });
    }
  }, false);

  // -- the preference ------------------------------------------------ //

  // An address entered in the preference opens a tab that converts the
  // extension there. The setting is emptied once it has been read, and when
  // this page loads, so the field is blank each time the preferences are
  // opened. An open preferences window goes on showing the address, and
  // reports nothing if the same one is entered there again. Emptying the
  // setting is itself a change, one with no address in it.
  safari.extension.settings[URL_SETTING] = "";
  safari.extension.settings.addEventListener("change", function (event) {
    if (event.key !== URL_SETTING || !event.newValue) {
      return;
    }
    var url = String(event.newValue).trim();
    safari.extension.settings[URL_SETTING] = "";
    if (!url) {
      return;
    }
    // A Chrome extension's id names its store page, and an address may be
    // entered without its scheme. A colon before digits starts a port.
    if (/^[a-p]{32}$/.test(url)) {
      url = "https://chromewebstore.google.com/detail/" + url;
    } else if (!/^[a-z][a-z0-9+.\-]*:(?!\d)/i.test(url)) {
      url = "https://" + url;
    }
    openPage("convert.html#" + encodeURIComponent(url));
  }, false);

  // Opens one of this extension's pages in a new tab. Safari's tab.url
  // lowercases the extension's identifier in the address, which its loader
  // then does not recognize, so the tab goes to a blank address of its own
  // first, by which the engine's id for it is learned, and the engine's
  // browser.tabs.update takes it to the page.
  function openPage(path) {
    var browserWindow = safari.application.activeBrowserWindow || safari.application.openBrowserWindow();
    var tab = browserWindow.openTab("foreground");
    var marker = "about:blank#w2s-" + Date.now() + "-" + Math.floor(Math.random() * 1e9);
    var timer = setTimeout(function () {
      browser.tabs.onUpdated.removeListener(updated);
    }, 10000);
    function updated(tabId, change, info) {
      if ((change && change.url || info && info.url) !== marker) {
        return;
      }
      clearTimeout(timer);
      browser.tabs.onUpdated.removeListener(updated);
      browser.tabs.update(tabId, { url: safari.extension.baseURI + path });
    }
    browser.tabs.onUpdated.addListener(updated);
    tab.url = marker;
  }
})();
