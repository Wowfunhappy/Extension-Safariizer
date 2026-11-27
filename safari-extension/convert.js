// The page the extension's preference opens for an address entered there.
// It asks the global page to convert the extension at the address, as a
// store page's button does, shows how that goes, and saves the signed
// .safariextz as a download.

(function () {
  "use strict";

  var STAGES = {
    download: "Downloading…",
    convert: "Converting…",
    sign: "Signing…"
  };

  var url = decodeURIComponent(location.hash.slice(1));
  var address = document.getElementById("address");
  var status = document.getElementById("status");
  var detail = document.getElementById("detail");
  var progress = document.getElementById("progress");
  var again = document.getElementById("again");

  function show(text, more, fraction) {
    status.textContent = text;
    detail.textContent = more || "";
    detail.hidden = !more;
    if (fraction === null) {
      progress.hidden = true;
    } else {
      progress.hidden = false;
      if (typeof fraction === "number") {
        progress.value = fraction;
      } else {
        progress.removeAttribute("value");
      }
    }
  }

  function save(fileName, base64) {
    var binary = atob(base64);
    var data = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) {
      data[i] = binary.charCodeAt(i);
    }
    var link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([data], { type: "application/octet-stream" }));
    link.download = fileName;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  function failed(message) {
    document.body.className = "failed";
    show("Couldn’t convert this extension", message, null);
    again.hidden = false;
  }

  var job = null;

  // The global page tells how the conversion goes, as it tells a store page.
  safari.self.addEventListener("message", function (event) {
    var message = event.message || {};
    if (message.job !== job) {
      return;
    }
    if (event.name === "w2s-progress") {
      show(STAGES[message.stage] || "Working…", null,
           message.stage === "download" ? message.fraction || 0 : undefined);
    } else if (event.name === "w2s-converted") {
      save(message.fileName, message.data);
      show("Downloaded " + message.name, message.fileName + " is in your Downloads folder; " +
           "open it to install " + message.name + " in Safari.", null);
    } else if (event.name === "w2s-failed") {
      failed(message.message);
    }
  }, false);

  function start() {
    document.body.className = "";
    again.hidden = true;
    show("Starting…", null);
    job = String(Date.now()) + Math.random();
    safari.self.tab.dispatchMessage("w2s-convert", { job: job, url: url });
  }

  address.textContent = url;
  document.title = "Converting " + url;
  again.addEventListener("click", start, false);
  if (url) {
    start();
  } else {
    failed("Enter an extension’s address in Safari’s Preferences, under Extensions.");
  }
})();
