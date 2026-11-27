// Puts an "Add to Safari" button on extension pages of the Chrome Web Store
// and Firefox Add-ons.
//
// The store's own install button, which Safari cannot use, is hidden and a
// copy of it takes its place, so the copy keeps the store's look. Clicking
// it asks the global page to convert the extension; the button shows the
// progress, and the finished .safariextz is saved as a download. An
// extension already converted and installed shows as "Installed" instead. Both stores
// change pages without reloading, so the button is put back whenever the
// page changes. Where the store's button cannot be found, a floating button
// stands in. The Chrome Web Store's prompts to switch to Chrome are hidden.

(function () {
  "use strict";

  if (window.top !== window || typeof safari === "undefined" || !safari.self ||
      !safari.self.tab) {
    return;
  }

  // In a WebKit older than the extension needs, its global page does not
  // start, and the store keeps its own button (runtime/webkit-requirement.js,
  // which Safari injects ahead of this with the minimum in
  // runtime/webkit-minimum.js).
  if (!WebKitRequirement.met()) {
    return;
  }

  var MARK = "data-w2s-button";
  var HIDDEN = "data-w2s-hidden";

  var STAGES = {
    download: "Downloading…",
    convert: "Converting…",
    sign: "Signing…"
  };

  var current = null;

  // The archive saved for each extension this page has converted, and the
  // extensions found installed, by the key pageExtension() gives them, so
  // that a button the store re-renders still shows it.
  var downloaded = {};
  var installed = {};

  // The conversions under way from this page, as {job, label} by the same
  // key. They outlast a button the store re-renders and the page moving on
  // to another extension, and each finished archive is saved either way.
  var converting = {};

  // The key of the conversion with this job, or null.
  function conversionOf(job) {
    var keys = Object.keys(converting);
    for (var i = 0; i < keys.length; i++) {
      if (converting[keys[i]].job === job) {
        return keys[i];
      }
    }
    return null;
  }

  function chromeExtensionId() {
    if (!/^(chromewebstore|chrome)\.google\.com$/.test(location.hostname)) {
      return null;
    }
    var found = location.pathname.match(/(?:^|[^a-z])([a-p]{32})(?![a-z])/);
    return found ? found[1] : null;
  }

  function firefoxAddon() {
    if (location.hostname !== "addons.mozilla.org") {
      return null;
    }
    var found = /\/addon\/([^/?#]+)/.exec(location.pathname);
    if (!found) {
      return null;
    }
    // Decoded as webstore.firefoxAddon decodes it, so the global page finds
    // the bundle it remembered under the same key.
    try {
      return decodeURIComponent(found[1]);
    } catch (e) {
      return found[1];
    }
  }

  // What this page offers: a key naming the extension, or null.
  function pageExtension() {
    var id = chromeExtensionId();
    if (id) {
      return "chrome:" + id;
    }
    var addon = firefoxAddon();
    return addon ? "firefox:" + addon : null;
  }

  function visible(element) {
    return !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
  }

  // The store's own install button, if it can be found.
  function storeButton() {
    var candidates;
    if (chromeExtensionId()) {
      candidates = document.querySelectorAll("button");
      for (var i = 0; i < candidates.length; i++) {
        var text = candidates[i].textContent.trim();
        if (/^(Add to Chrome|Remove from Chrome)$/.test(text) && visible(candidates[i]) &&
            !candidates[i].hasAttribute(MARK)) {
          return candidates[i];
        }
      }
      return null;
    }
    candidates = document.querySelectorAll(".GetFirefoxButton-button, .InstallButtonWrapper .Button");
    for (var j = 0; j < candidates.length; j++) {
      if (visible(candidates[j]) && !candidates[j].hasAttribute(MARK)) {
        return candidates[j];
      }
    }
    return null;
  }

  // The direct .xpi link Firefox Add-ons shows beside its button.
  function firefoxFile() {
    var link = document.querySelector(".InstallButtonWrapper-download-link, " +
                                      "a[href*='/firefox/downloads/file/']");
    return link ? link.href : null;
  }

  // The current Chrome Web Store names the publisher in the Details list.
  // T7iRm identifies its row when "Offered by" is localized. Older pages
  // instead use a publisher or verified-site link beneath the title.
  function chromePublisher() {
    var rows = document.querySelectorAll("li");
    for (var r = 0; r < rows.length; r++) {
      var cells = rows[r].children;
      if (cells.length < 2) {
        continue;
      }
      var marked = rows[r].classList.contains("T7iRm");
      var label = cells[0].textContent.replace(/\s+/g, " ").trim().toLowerCase();
      if (!marked && label !== "offered by") {
        continue;
      }
      var name = cells[1].textContent.replace(/\s+/g, " ").trim();
      var website = cells[1].querySelector("a[href]");
      return name ? { name: name, url: website ? website.href : "" } : null;
    }
    var title = document.querySelector("h1");
    if (!title) {
      return null;
    }
    var links = document.querySelectorAll("a[rel~='ugc']");
    for (var i = 0; i < links.length; i++) {
      if (title.compareDocumentPosition(links[i]) & Node.DOCUMENT_POSITION_FOLLOWING) {
        var name = links[i].textContent.replace(/\s+/g, " ").trim();
        return name ? { name: name, url: links[i].href } : null;
      }
    }
    return null;
  }

  // Replaces the text of `button`'s deepest text-bearing element.
  function setLabel(button, label) {
    var target = button;
    for (;;) {
      var next = null;
      for (var i = 0; i < target.children.length; i++) {
        if (target.children[i].textContent.trim()) {
          next = target.children[i];
        }
      }
      if (!next) {
        break;
      }
      target = next;
    }
    target.textContent = label;
  }

  function makeButton(original) {
    var button;
    if (original) {
      button = original.cloneNode(true);
      button.removeAttribute("disabled");
      button.removeAttribute("href");
      button.removeAttribute("aria-disabled");
      button.removeAttribute("jsaction");
      button.removeAttribute("jsname");
      button.removeAttribute("id");
      button.style.cursor = "pointer";
    } else {
      button = document.createElement("button");
      button.style.cssText = "position: fixed; right: 24px; bottom: 24px; z-index: 2147483647; " +
        "padding: 12px 22px; border: 0; border-radius: 999px; background: #0b57d0; " +
        "color: #fff; font: 600 15px -apple-system, 'Helvetica Neue', sans-serif; " +
        "box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3); cursor: pointer;";
    }
    button.setAttribute(MARK, "");
    button.setAttribute("title", "Convert this extension into a Safari extension and download it");
    setLabel(button, "Add to Safari");
    button.addEventListener("click", onClick, true);
    return button;
  }

  function onClick(event) {
    event.preventDefault();
    event.stopPropagation();
    start();
  }

  function start() {
    if (!current || converting[current.extension] || downloaded[current.extension] ||
        installed[current.extension]) {
      return;
    }
    var job = String(Date.now()) + Math.random();
    converting[current.extension] = { job: job, label: "Downloading…" };
    show("Downloading…");
    safari.self.tab.dispatchMessage("w2s-convert", {
      job: job,
      url: location.href,
      file: firefoxFile(),
      publisher: chromePublisher()
    });
  }

  function show(label, title) {
    if (current && current.button) {
      setLabel(current.button, label);
      if (title) {
        current.button.setAttribute("title", title);
      }
    }
  }

  // Greys out the button once its archive is saved, naming the file to open,
  // and stops it taking clicks.
  function showDownloaded(fileName) {
    var button = current.button;
    setLabel(button, "Open \u201c" + fileName + "\u201d to install");
    button.setAttribute("title", fileName + " is in your Downloads folder; open it to install it in Safari");
    button.setAttribute("aria-disabled", "true");
    button.style.filter = "grayscale(1)";
    button.style.opacity = "0.55";
    button.style.cursor = "default";
    button.style.pointerEvents = "none";
  }

  // Shows the extension installed, in the store's own style for a button
  // that does nothing, and stops the button taking clicks.
  function showInstalled() {
    var button = current.button;
    setLabel(button, "Installed");
    button.setAttribute("title", "This extension is installed in Safari");
    button.setAttribute("aria-disabled", "true");
    if (button.tagName === "BUTTON") {
      button.setAttribute("disabled", "");
    } else {
      button.classList.add("Button--disabled");
    }
    button.style.filter = "";
    button.style.opacity = "";
    button.style.cursor = "default";
    button.style.pointerEvents = "none";
  }

  // Asks the global page whether the page's extension is installed.
  function checkInstalled() {
    if (current && !converting[current.extension] && !installed[current.extension]) {
      safari.self.tab.dispatchMessage("w2s-status", { extension: current.extension });
    }
  }

  // Puts the button on the page, or back on it after the store re-rendered.
  function install() {
    var extension = pageExtension();
    if (!extension) {
      remove();
      return;
    }
    // A button the store hid with the page it showed before, as it does when
    // it moves to another item, is placed again.
    if (current && current.extension === extension && current.button &&
        document.documentElement.contains(current.button) && visible(current.button)) {
      if (current.floating) {
        // The store's button may have appeared since.
        var late = storeButton();
        if (late) {
          remove();
          install();
        }
      }
      return;
    }
    remove();
    var original = storeButton();
    var button = makeButton(original);
    if (original) {
      original.parentNode.insertBefore(button, original.nextSibling);
      original.setAttribute(HIDDEN, original.style.display);
      original.style.display = "none";
    } else {
      document.body.appendChild(button);
    }
    current = { extension: extension, button: button, floating: !original };
    if (converting[extension]) {
      show(converting[extension].label);
    } else if (installed[extension]) {
      showInstalled();
    } else if (downloaded[extension]) {
      showDownloaded(downloaded[extension]);
    }
    checkInstalled();
  }

  function remove() {
    if (current && current.button && current.button.parentNode) {
      current.button.parentNode.removeChild(current.button);
    }
    var hidden = document.querySelectorAll("[" + HIDDEN + "]");
    for (var i = 0; i < hidden.length; i++) {
      hidden[i].style.display = hidden[i].getAttribute(HIDDEN);
      hidden[i].removeAttribute(HIDDEN);
    }
    current = null;
  }

  function save(fileName, base64) {
    var binary = atob(base64);
    var data = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) {
      data[i] = binary.charCodeAt(i);
    }
    var url = URL.createObjectURL(new Blob([data], { type: "application/octet-stream" }));
    var link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  // -- messages from the global page --------------------------------- //

  function onGlobalPageMessage(event) {
    var message = event.message || {};
    if (event.name === "w2s-status") {
      if (message.installed) {
        installed[message.extension] = true;
        if (current && current.extension === message.extension && !converting[message.extension]) {
          showInstalled();
        }
      }
      return;
    }
    var extension = conversionOf(message.job);
    if (extension === null) {
      return;
    }
    var shown = !!current && current.extension === extension;
    if (event.name === "w2s-progress") {
      var label = STAGES[message.stage] || "Working…";
      if (message.stage === "download" && message.fraction) {
        label = "Downloading… " + Math.round(message.fraction * 100) + "%";
      }
      converting[extension].label = label;
      if (shown) {
        show(label);
      }
    } else if (event.name === "w2s-converted") {
      save(message.fileName, message.data);
      delete converting[extension];
      downloaded[extension] = message.fileName;
      if (shown) {
        showDownloaded(message.fileName);
      }
    } else if (event.name === "w2s-failed") {
      delete converting[extension];
      if (shown) {
        show("Couldn\u2019t convert \u2014 try again", message.message);
      }
    }
  }

  var listening = false;

  function startListening() {
    if (listening) {
      return;
    }
    safari.self.addEventListener("message", onGlobalPageMessage, false);
    listening = true;
  }

  function stopListening() {
    if (!listening) {
      return;
    }
    listening = false;
    safari.self.removeEventListener("message", onGlobalPageMessage, false);
  }

  startListening();
  // An extension installed from its download while the page was in the
  // background shows as installed when the page is looked at again.
  window.addEventListener("focus", checkInstalled);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") {
      checkInstalled();
    }
  });
  window.addEventListener("pagehide", stopListening);
  window.addEventListener("pageshow", function (event) {
    if (event.persisted) {
      startListening();
    }
  });

  // -- the Chrome Web Store's nags ----------------------------------- //

  // The Chrome Web Store asks a browser it does not take for Chrome to
  // switch to Chrome, in a dialog under its header and in a message box
  // above the item. Both are hidden, as they appear: the dialog by the
  // heading it is labelled with, and the message box by its button to install
  // Chrome, which the store logs as 276336.
  function hideNags() {
    if (!chromeExtensionId()) {
      return;
    }
    var nags = Array.prototype.slice.call(
      document.querySelectorAll("[role=dialog][aria-labelledby=promo-header]"));
    var buttons = document.querySelectorAll("main section button[jslog^='276336'], " +
      "main section button[aria-label^='Switch to Chrome']");
    for (var i = 0; i < buttons.length; i++) {
      // The message box is the section's child that holds the button.
      var box = buttons[i];
      while (box.parentNode && box.parentNode.tagName !== "SECTION") {
        box = box.parentNode;
      }
      if (box.parentNode) {
        nags.push(box);
      }
    }
    nags.forEach(function (nag) {
      nag.style.setProperty("display", "none", "important");
    });
  }

  // -- keeping the button on the page -------------------------------- //

  var scheduled = false;

  function schedule() {
    if (scheduled) {
      return;
    }
    scheduled = true;
    setTimeout(function () {
      scheduled = false;
      install();
    }, 250);
  }

  new MutationObserver(function () {
    hideNags();
    schedule();
  }).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("popstate", schedule);
  hideNags();
  install();
})();
