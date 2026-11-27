// Devtools panels in a window of their own.
//
// Safari 7's Web Inspector has no place for an extension's panel. For an
// extension whose devtools page makes panels, the page the Inspector opens
// for a tab is the relay here: it opens a window for that tab, and carries
// out there the devtools calls only it can make. The window runs the
// extension's devtools page, as a hidden frame, and shows each panel it makes
// as a frame of its own, behind a tab of the panel's title. The devtools page
// and its panels share the window, as Chrome's share DevTools, so a devtools
// page reaches into the window `onShown` hands it. Closing the Inspector
// closes the window.

(function (g) {
  "use strict";

  var CONFIG = WEX.CONFIG;
  var native = WEX.native;
  if (!CONFIG.devtoolsWindowPage || !native) {
    return;
  }
  var PORT = WEX.INTERNAL_PORT + "devtools-window:";
  var Event = WEX.Event;
  var path = String(g.location.pathname);

  // ------------------------------------------------------------------ //
  // The relay, in the Web Inspector
  // ------------------------------------------------------------------ //
  function relay() {
    var devtools = native.devtools;
    var tabId = devtools.inspectedWindow.tabId;
    var ports = [];
    var entries = [];

    function entryId(entry) {
      entries.push(entry);
      return entries.length - 1;
    }

    function plainEntry(entry) {
      var out = JSON.parse(JSON.stringify(entry));
      out.__wexEntry = entryId(entry);
      return out;
    }

    function broadcast(message) {
      ports.forEach(function (port) {
        try {
          port.postMessage(message);
        } catch (e) { /* the window is closing */ }
      });
    }

    function answer(port, message) {
      var reply = function (fields) {
        fields.id = message.id;
        try {
          port.postMessage(fields);
        } catch (e) { /* the window is closing */ }
      };
      switch (message.op) {
        case "ping":
          reply({});
          break;
        case "eval":
          devtools.inspectedWindow.eval(message.expression, message.options || {}, function (result, info) {
            reply({ result: result, info: info });
          });
          break;
        case "reload":
          devtools.inspectedWindow.reload(message.options || {});
          reply({});
          break;
        case "getHAR":
          devtools.network.getHAR(function (har) {
            var copy = JSON.parse(JSON.stringify(har || {}));
            copy.entries = (har && har.entries || []).map(plainEntry);
            reply({ result: copy });
          });
          break;
        case "getContent":
          var entry = entries[message.entry];
          if (!entry) {
            reply({ result: [null, ""] });
            break;
          }
          entry.getContent(function (content, encoding) {
            reply({ result: [content, encoding] });
          });
          break;
      }
    }

    native.runtime.onConnect.addListener(function (port) {
      if (port.name !== PORT + tabId) {
        return;
      }
      ports.push(port);
      port.onMessage.addListener(function (message) {
        answer(port, message || {});
      });
      port.onDisconnect.addListener(function () {
        ports.splice(ports.indexOf(port), 1);
      });
    });

    devtools.network.onRequestFinished.addListener(function (entry) {
      if (ports.length) {
        broadcast({ event: "requestFinished", entry: plainEntry(entry) });
      }
    });
    devtools.network.onNavigated.addListener(function (url) {
      broadcast({ event: "navigated", url: url });
    });

    g.chrome.windows.create({
      url: WEX.extUrl("wex/wex-devtools-window.html") + "?tab=" + encodeURIComponent(tabId),
      focused: true
    });
  }

  // ------------------------------------------------------------------ //
  // The window
  // ------------------------------------------------------------------ //
  function host() {
    var doc = g.document;
    var tabId = Number(/[?&]tab=([^&]*)/.exec(g.location.search || "") ?
      decodeURIComponent(/[?&]tab=([^&]*)/.exec(g.location.search)[1]) : NaN);
    var port = native.runtime.connect({ name: PORT + tabId });
    var waiting = {};
    var seq = 0;

    function call(op, fields) {
      var message = fields || {};
      message.op = op;
      message.id = ++seq;
      return new Promise(function (resolve) {
        waiting[message.id] = resolve;
        port.postMessage(message);
      });
    }

    var onRequestFinished = new Event("devtools.network.onRequestFinished");
    var onNavigated = new Event("devtools.network.onNavigated");

    // A HAR entry as the relay sends it, whose content the relay reads.
    function harEntry(plain) {
      var id = plain.__wexEntry;
      delete plain.__wexEntry;
      Object.defineProperty(plain, "getContent", {
        value: function (cb) {
          var read = call("getContent", { entry: id }).then(function (reply) {
            return reply.result;
          });
          if (typeof cb === "function") {
            read.then(function (r) {
              cb(r[0], r[1]);
            });
            return undefined;
          }
          return read.then(function (r) {
            return { content: r[0], encoding: r[1] };
          });
        }
      });
      return plain;
    }

    port.onMessage.addListener(function (message) {
      if (message.event === "requestFinished") {
        onRequestFinished.emit(harEntry(message.entry));
      } else if (message.event === "navigated") {
        onNavigated.emit(message.url);
      } else if (waiting[message.id]) {
        var resolve = waiting[message.id];
        delete waiting[message.id];
        resolve(message);
      }
    });
    // The Inspector has closed: so does its window. A relay that stops
    // answering has closed with it, whether or not its port reports it.
    var closing = false;
    function close() {
      if (closing) {
        return;
      }
      closing = true;
      g.chrome.tabs.getCurrent(function (tab) {
        if (tab) {
          g.chrome.tabs.remove(tab.id);
        }
      });
    }
    port.onDisconnect.addListener(close);
    var answered = true;
    g.setInterval(function () {
      if (!answered) {
        close();
        return;
      }
      answered = false;
      call("ping").then(function () {
        answered = true;
      });
    }, 4000);

    var NO_PANELS = "Sidebar panes are not available in this browser's developer tools.";
    function noPane() {
      var cb = arguments[arguments.length - 1];
      return WEX.fail(typeof cb === "function" ? cb : null, NO_PANELS);
    }

    var panels = [];
    var shown = null;
    var tabs = doc.getElementById("wex-panel-tabs");
    var frames = doc.getElementById("wex-panels");

    function show(panel) {
      if (shown === panel) {
        return;
      }
      var previous = shown;
      shown = panel;
      panels.forEach(function (p) {
        p.frame.style.display = p === panel ? "block" : "none";
        p.tab.className = p === panel ? "wex-selected" : "";
      });
      if (previous) {
        previous.api.onHidden.emit();
      }
      var emitShown = function () {
        if (shown === panel) {
          panel.api.onShown.emit(panel.frame.contentWindow);
        }
      };
      if (panel.loaded) {
        emitShown();
      } else {
        panel.whenLoaded = emitShown;
      }
    }

    function createPanel(title, iconPath, pagePath, cb) {
      var frame = doc.createElement("iframe");
      var tab = doc.createElement("button");
      tab.type = "button";
      tab.textContent = String(title);
      var api = {
        onShown: new Event("ExtensionPanel.onShown"),
        onHidden: new Event("ExtensionPanel.onHidden"),
        onSearch: new Event("ExtensionPanel.onSearch"),
        createStatusBarButton: function () {
          return { onClicked: new Event("Button.onClicked"), update: function () {} };
        },
        show: function () {
          show(panel);
        }
      };
      var panel = { frame: frame, tab: tab, api: api, loaded: false, whenLoaded: null };
      panels.push(panel);
      tab.addEventListener("click", function () {
        show(panel);
      });
      frame.addEventListener("load", function () {
        panel.loaded = true;
        if (panel.whenLoaded) {
          var then = panel.whenLoaded;
          panel.whenLoaded = null;
          then();
        }
      });
      frame.style.display = "none";
      frame.src = WEX.extUrl(String(pagePath).replace(/^\/+/, ""));
      tabs.appendChild(tab);
      frames.appendChild(frame);
      if (!shown) {
        show(panel);
      }
      return WEX.done(cb, api);
    }

    var devtools = {
      inspectedWindow: {
        tabId: tabId,
        eval: function (expression, options, cb) {
          if (typeof options === "function") {
            cb = options;
            options = undefined;
          }
          var evaluated = call("eval", { expression: String(expression), options: options || {} });
          if (typeof cb === "function") {
            evaluated.then(function (reply) {
              cb(reply.result, reply.info);
            });
            return undefined;
          }
          return evaluated.then(function (reply) {
            // Firefox's promise gives the callback's two arguments as an array.
            if (CONFIG.firefoxBuild) {
              return [reply.result, reply.info];
            }
            if (reply.info) {
              throw reply.info.isException ? reply.info : new Error("DevTools API encountered an error");
            }
            return reply.result;
          });
        },
        reload: function (options) {
          call("reload", { options: typeof options === "string" ? { userAgent: options } : options || {} });
        }
      },
      network: {
        onRequestFinished: onRequestFinished,
        onNavigated: onNavigated,
        getHAR: function (cb) {
          var har = call("getHAR").then(function (reply) {
            var log = reply.result || {};
            log.entries = (log.entries || []).map(harEntry);
            return log;
          });
          if (typeof cb === "function") {
            har.then(cb);
            return undefined;
          }
          return har;
        }
      },
      panels: {
        themeName: "default",
        onThemeChanged: new Event("devtools.panels.onThemeChanged"),
        create: createPanel,
        setOpenResourceHandler: function () {},
        openResource: function (url, line, column, cb) {
          var callback = [line, column, cb].filter(function (a) {
            return typeof a === "function";
          })[0];
          return WEX.fail(callback || null, "Resources cannot be opened in this browser's developer tools.");
        },
        elements: { createSidebarPane: noPane,
          onSelectionChanged: new Event("devtools.panels.elements.onSelectionChanged") },
        sources: { createSidebarPane: noPane,
          onSelectionChanged: new Event("devtools.panels.sources.onSelectionChanged") }
      }
    };
    g.__wexDevtoolsHost = { devtools: devtools };

    g.chrome.tabs.get(tabId).then(function (tab) {
      doc.title = CONFIG.name + " \u2014 " + (tab.title || tab.url || "");
    }, function () {
      doc.title = CONFIG.name;
    });

    var style = doc.createElement("style");
    style.textContent =
      "html, body { margin: 0; height: 100%; font: 12px -apple-system-font, 'Lucida Grande', sans-serif; }" +
      "body { display: flex; flex-direction: column; }" +
      "#wex-panel-tabs { display: flex; border-bottom: 1px solid #ccc; background: #f3f3f3; flex: none; }" +
      "#wex-panel-tabs button { border: 0; background: none; padding: 6px 12px; font: inherit; color: #333; }" +
      "#wex-panel-tabs button.wex-selected { background: #fff; box-shadow: inset 0 -2px #1a73e8; }" +
      "#wex-panels { flex: 1; position: relative; }" +
      "#wex-panels iframe { border: 0; width: 100%; height: 100%; position: absolute; top: 0; left: 0; }";
    doc.head.appendChild(style);

    // The extension's devtools page, with no view of its own.
    var page = doc.createElement("iframe");
    page.style.display = "none";
    page.src = WEX.extUrl(String(CONFIG.devtoolsWindowPage).replace(/^\/+/, ""));
    doc.body.appendChild(page);
  }

  if (/\/wex-devtools-relay\.html$/.test(path) && native.devtools) {
    relay();
  } else if (/\/wex-devtools-window\.html$/.test(path)) {
    if (g.document.body) {
      host();
    } else {
      g.document.addEventListener("DOMContentLoaded", host);
    }
  }
})(this);
