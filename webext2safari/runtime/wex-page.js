// Completes the `browser` namespace of an extension page.
//
// WebKit gives every extension page the parts of the namespace that need the
// engine. The rest is built on the global page, and a page's calls to it
// travel there as runtime messages, with its events coming back over a port.
// That holds for a page in a tab, which runs in a web content process with
// no other way to the global page, and for a page in the toolbar popover,
// which could reach the global page's objects directly but would then be
// handed objects of another JavaScript realm: an extension that asks
// `tab instanceof Object` of one gets false. Messages arrive as the page's
// own objects.
//
// The converter injects this as the first script of every extension HTML page.

(function (g) {
  "use strict";

  if (g.chrome && g.chrome.__wex) {
    return;
  }

  var native = WEX.native;
  if (!native) {
    WEX.log.error("this WebKit provides no `browser` namespace for extensions; " +
      "this page cannot reach the extension");
    return;
  }

  // The origins of the other converted extensions the global page knows,
  // for addresses built from their ids (WEX.chromeExtensionOrigin).
  try {
    WEX.learnExtensionOrigins(JSON.parse(WEX.localStorageOf(g).getItem("wex.extensionOrigins") || "{}"));
  } catch (e) { /* none known */ }

  // The popover shares a process with the global page, which it can reach.
  var globalWindow = null;
  try {
    globalWindow = WEX.safari.extension.globalPage && WEX.safari.extension.globalPage.contentWindow;
  } catch (e) {
    globalWindow = null;
  }
  var inPopover = false;
  try {
    inPopover = !!WEX.safari.self && typeof WEX.safari.self.hide === "function";
  } catch (e) { /* no Safari proxy in this view */ }
  // A page in a frame of the popover is not the page the popover shows.
  var inFrame = !!g.top && g.top !== g;

  // ------------------------------------------------------------------ //
  // The namespace
  // ------------------------------------------------------------------ //
  function remoteNamespace() {
    var checker = WEX.apiChecker();
    var remote = WEX.makeRemote(native);
    var messaging = WEX.makeMessaging(native);
    var tabMessaging = WEX.makeTabMessaging(native);
    var injection = WEX.makeInjection(native, function () {
      return remote.call("tabs.query", [{ active: true, currentWindow: true }])
        .then(function (tabs) {
          if (!tabs || !tabs.length) {
            throw new Error("No active tab.");
          }
          return tabs[0].id;
        });
    });
    var i18n = WEX.makeI18n();
    var manifest = WEX.localizeManifest(WEX.CONFIG.manifest || {}, i18n);

    var CONSTANTS = {
      "tabs.TAB_ID_NONE": -1,
      "windows.WINDOW_ID_NONE": -1,
      "windows.WINDOW_ID_CURRENT": -2,
      "tabGroups.TAB_GROUP_ID_NONE": -1,
      "contextMenus.ACTION_MENU_TOP_LEVEL_LIMIT": 6,
      "menus.ACTION_MENU_TOP_LEVEL_LIMIT": 6,
      "storage.local.QUOTA_BYTES": 104857600,
      "storage.sync.QUOTA_BYTES": 104857600,
      "storage.sync.QUOTA_BYTES_PER_ITEM": 104857600,
      "storage.sync.MAX_ITEMS": 1000000
    };

    function invoke(path, args) {
      var list = Array.prototype.slice.call(args);
      var cb = typeof list[list.length - 1] === "function" ? list.pop() : null;
      return WEX.settle(remote.call(path, list), cb);
    }

    // The global page's members, as it last published them; null when it has
    // not yet, and every member is then taken to exist. `shapeValues` holds
    // the members that are plain values, as enums are.
    var shapeValues = {};
    var shape = (function () {
      try {
        var stored = JSON.parse(WEX.localStorageOf(g).getItem(WEX.NAMESPACE_SHAPE_KEY) || "null");
        if (stored && stored.version === WEX.CONFIG.version && Array.isArray(stored.paths)) {
          var known = {};
          stored.paths.forEach(function (p) { known[p] = true; });
          if (stored.values && typeof stored.values === "object") {
            shapeValues = stored.values;
          }
          return known;
        }
      } catch (e) { /* no storage to read */ }
      return null;
    })();

    function exists(full) {
      return !shape || Object.prototype.hasOwnProperty.call(shape, full);
    }

    // The names of each published path's members.
    var children = {};
    Object.keys(shape || {}).forEach(function (full) {
      var dot = full.lastIndexOf(".");
      if (dot > 0) {
        var parent = full.slice(0, dot);
        (children[parent] = children[parent] || []).push(full.slice(dot + 1));
      }
    });

    // The members a namespace stand-in lists, as Chrome's namespace objects
    // list theirs to `for...in` and Object.keys.
    function memberNames(path, overrides) {
      var names = (children[path] || []).slice();
      Object.keys(overrides || {}).concat(Object.keys(CONSTANTS).filter(function (full) {
        return full.lastIndexOf(".") === path.length && full.indexOf(path + ".") === 0;
      }).map(function (full) {
        return full.slice(path.length + 1);
      })).forEach(function (name) {
        if (names.indexOf(name) < 0) {
          names.push(name);
        }
      });
      return names;
    }

    // Stands for a namespace or a method of the global page's, whichever it
    // turns out to be used as: calling it calls the method of that name, and
    // reading a property of it gives the member of that name. Members named
    // like events are events, and `overrides` are the members carried out in
    // this page. A member the global page does not have is missing. A
    // top-level namespace, or a path the global page has members under, is
    // an object that lists its members rather than a function.
    function standIn(path, overrides) {
      var members = {};
      var checkedOverrides = {};
      // What the page assigns to a member it keeps, as an object would.
      var assigned = {};
      var isNamespace = path.indexOf(".") < 0 || !!children[path];
      var handler = {
        apply: function (target, self, args) {
          return invoke(path, args);
        },
        has: function (target, name) {
          return typeof name === "string" &&
            (!!(overrides && Object.prototype.hasOwnProperty.call(overrides, name)) ||
             exists(path + "." + name) || name in target);
        },
        set: function (target, name, value) {
          assigned[name] = value;
          return true;
        },
        deleteProperty: function (target, name) {
          delete assigned[name];
          return true;
        },
        get: function (target, name) {
          if (typeof name !== "string") {
            return undefined;
          }
          if (Object.prototype.hasOwnProperty.call(assigned, name)) {
            return assigned[name];
          }
          if (overrides && Object.prototype.hasOwnProperty.call(overrides, name)) {
            var local = overrides[name];
            if (!checker || typeof local !== "function") {
              return local;
            }
            if (!checkedOverrides[name] || checkedOverrides[name].__wexOriginal !== local) {
              checkedOverrides[name] = checker.wrap(path + "." + name, local);
            }
            return checkedOverrides[name];
          }
          if (name === "call" || name === "apply" || name === "bind") {
            return Function.prototype[name];
          }
          // What every object inherits, as hasOwnProperty and toString.
          if (name in Object.prototype) {
            return target[name];
          }
          var full = path + "." + name;
          if (Object.prototype.hasOwnProperty.call(shapeValues, full)) {
            return shapeValues[full];
          }
          if (Object.prototype.hasOwnProperty.call(CONSTANTS, full)) {
            return CONSTANTS[full];
          }
          if (name === "then" || name === "toJSON" || name === "prototype" ||
              /^[A-Z][A-Z0-9_]*$/.test(name) || !exists(full)) {
            return undefined;
          }
          if (!members[name]) {
            members[name] = /^on[A-Z]/.test(name) ? remote.event(full) : standIn(full);
            if (checker) {
              members[name] = checker.wrap(full, members[name]);
            }
          }
          return members[name];
        }
      };
      if (!isNamespace) {
        return new Proxy(function () {}, handler);
      }
      handler.ownKeys = function () {
        return memberNames(path, overrides);
      };
      handler.getOwnPropertyDescriptor = function (target, name) {
        if (typeof name !== "string" || memberNames(path, overrides).indexOf(name) < 0) {
          return undefined;
        }
        return { value: handler.get(target, name), writable: true, enumerable: true, configurable: true };
      };
      return new Proxy({}, handler);
    }

    var runtime = {
      id: WEX.runtimeId,
      onMessage: messaging.onMessage,
      onConnect: messaging.onConnect,
      onMessageExternal: messaging.onMessageExternal,
      onConnectExternal: messaging.onConnectExternal,
      sendMessage: messaging.sendMessage,
      connect: messaging.connect,
      getManifest: function () {
        return WEX.manifestAsGiven(manifest);
      },
      getVersion: function () {
        return String(manifest.version);
      },
      getURL: function (path) {
        return WEX.extUrl(path);
      },
      getBackgroundPage: function (cb) {
        if (globalWindow) {
          return WEX.done(cb, globalWindow);
        }
        return WEX.fail(cb, "the background page cannot be reached from a tab");
      }
    };
    WEX.addNativeMessaging(runtime);
    Object.defineProperty(runtime, "lastError", {
      get: function () {
        // Chrome's is undefined outside a failed call's callback.
        return WEX.lastError || native.runtime.lastError || undefined;
      },
      set: function (v) {
        WEX.lastError = v;
      }
    });

    // A menu item's onclick is a function, which stays in this page; the
    // global page reports the click and it is handed on from here.
    var menuHandlers = {};
    var menuSeq = 1;
    var watchingMenus = false;

    function createMenu(name) {
      return function (props, cb) {
        var p = {};
        Object.keys(props || {}).forEach(function (key) {
          p[key] = props[key];
        });
        if (p.id == null) {
          p.id = "wexpage" + WEX.uid("m") + menuSeq++;
        }
        if (typeof p.onclick === "function") {
          menuHandlers[p.id] = p.onclick;
          delete p.onclick;
          if (!watchingMenus) {
            watchingMenus = true;
            remote.event("contextMenus.onClicked").addListener(function (info, tab) {
              var handler = menuHandlers[info.menuItemId];
              if (handler) {
                handler(info, tab);
              }
            });
          }
        }
        WEX.settle(remote.call(name + ".create", [p]), cb || function () {});
        return p.id;
      };
    }

    // Speech is the global page's. An utterance's onEvent stays here, and
    // hears the global page's events for the utterance, by its srcId.
    var ttsHandlers = {};
    var watchingTts = false;
    var ttsSeq = 0;
    function speak(text, options, cb) {
      if (typeof options === "function") {
        cb = options;
        options = undefined;
      }
      var o = {};
      Object.keys(options || {}).forEach(function (key) {
        o[key] = options[key];
      });
      if (typeof o.onEvent === "function") {
        var srcId = (Date.now() % 1000000) * 1000 + (ttsSeq++ % 1000);
        ttsHandlers[srcId] = o.onEvent;
        delete o.onEvent;
        o.__wexSrcId = srcId;
        if (!watchingTts) {
          watchingTts = true;
          remote.event("tts.onEvent").addListener(function (event) {
            var handler = ttsHandlers[event.srcId];
            if (handler) {
              if (event.isFinalEvent) {
                delete ttsHandlers[event.srcId];
              }
              handler(event);
            }
          });
        }
      }
      return WEX.settle(remote.call("tts.speak", [text, o]), cb);
    }

    // A blob: URL is this page's own, which the global page cannot read, so
    // the file goes to it with the call.
    function download(options, cb) {
      var url = String(options && options.url || "");
      if (!/^blob:/i.test(url)) {
        return WEX.settle(remote.call("downloads.download", [options]), cb);
      }
      var read = g.fetch(url).then(function (response) {
        return response.blob();
      }).then(function (blob) {
        return new Promise(function (resolve, reject) {
          var reader = new g.FileReader();
          reader.onload = function () {
            resolve(reader.result);
          };
          reader.onerror = function () {
            reject(reader.error);
          };
          reader.readAsDataURL(blob);
        });
      });
      return WEX.settle(read.then(function (data) {
        var o = {};
        Object.keys(options).forEach(function (key) {
          o[key] = options[key];
        });
        o.__wexData = data;
        return remote.call("downloads.download", [o]);
      }, function () {
        return remote.call("downloads.download", [options]);
      }), cb);
    }

    // The archive comes from the global page as text, and is a Blob here.
    function saveAsMHTML(details, cb) {
      var d = {};
      Object.keys(details || {}).forEach(function (key) {
        d[key] = details[key];
      });
      d.__wexText = true;
      return WEX.settle(remote.call("pageCapture.saveAsMHTML", [d]).then(function (text) {
        return new g.Blob([text], { type: "application/x-mimearchive" });
      }), cb);
    }

    // An icon path is relative to the page that names it, which the global
    // page cannot know. Pixels cannot be shown at all: Safari takes a toolbar
    // image only from a file in the bundle.
    function absoluteIcon(path) {
      try {
        return new g.URL(String(path), g.location.href).href;
      } catch (e) {
        return path;
      }
    }

    function setIcon(name) {
      return function (details, cb) {
        var d = {};
        Object.keys(details || {}).forEach(function (key) {
          d[key] = details[key];
        });
        if (typeof d.path === "string") {
          d.path = absoluteIcon(d.path);
        } else if (d.path && typeof d.path === "object") {
          var paths = {};
          Object.keys(d.path).forEach(function (size) {
            paths[size] = absoluteIcon(d.path[size]);
          });
          d.path = paths;
        }
        if (d.imageData) {
          d.imageData = true;
        }
        return WEX.settle(remote.call(name + ".setIcon", [d]), cb);
      };
    }

    var local = {
      runtime: runtime,
      extension: {
        getURL: function (path) {
          return WEX.extUrl(path);
        },
        getBackgroundPage: function () {
          return globalWindow;
        },
        // The one view a page can reach is its own. A page in a tab cannot
        // tell its tab's id at once, so a tabId or windowId leaves it listed;
        // the popover is in no tab.
        getViews: function (fetchProperties) {
          var wanted = fetchProperties || {};
          var kind = viewKind();
          if ((wanted.type && wanted.type !== kind) ||
              (wanted.tabId != null && inPopover) ||
              (ownTab && wanted.tabId != null && wanted.tabId !== ownTab.id) ||
              (ownTab && wanted.windowId != null && wanted.windowId !== -2 &&
                wanted.windowId !== ownTab.windowId)) {
            return [];
          }
          return [g];
        },
        isAllowedIncognitoAccess: function (cb) {
          return WEX.done(cb, false);
        },
        isAllowedFileSchemeAccess: function (cb) {
          return WEX.done(cb, false);
        },
        // Safari checks for updates by its own update manifest, which takes no
        // data from the extension.
        setUpdateUrlData: function () {},
        inIncognitoContext: false
      },
      i18n: i18n,
      webRequest: WEX.makeWebRequest(native),
      declarativeNetRequest: WEX.makeDeclarativeNetRequest(native, function () {
        native.runtime.sendMessage({ __wex: "rulesChanged" }).catch(function () {});
      }),
      webNavigation: WEX.makeWebNavigation(native, {
        onHistoryStateUpdated: remote.event("webNavigation.onHistoryStateUpdated"),
        onReferenceFragmentUpdated: remote.event("webNavigation.onReferenceFragmentUpdated")
      }),
      cookies: native.cookies,
      proxy: WEX.makeProxy(native),
      dns: native.dns,
      devtools: WEX.makeDevtools(native) || hostedDevtools()
    };

    Object.defineProperty(local.extension, "lastError", {
      configurable: true,
      enumerable: true,
      get: function () {
        return runtime.lastError;
      },
      set: function (v) {
        WEX.lastError = v;
      }
    });

    // A declarative event's rules are the global page's, with a method of
    // its own for a page's calls, as a callback stays in the page.
    var declarativeContent = WEX.declarativeContentTypes();
    declarativeContent.onPageChanged = {};
    ["addRules", "removeRules", "getRules"].forEach(function (method) {
      declarativeContent.onPageChanged[method] = function () {
        return invoke("declarativeContent.onPageChanged.__wexRemote",
          [method].concat(Array.prototype.slice.call(arguments)));
      };
    });

    var overrides = {
      runtime: runtime,
      tabs: {
        sendMessage: tabMessaging.sendMessage,
        connect: tabMessaging.connect,
        executeScript: injection.tabs.executeScript,
        insertCSS: injection.tabs.insertCSS,
        removeCSS: injection.tabs.removeCSS
      },
      tts: { speak: speak },
      downloads: { download: download },
      dom: WEX.makePageDom(g),
      publicSuffix: WEX.makePublicSuffix(),
      pageCapture: { saveAsMHTML: saveAsMHTML },
      declarativeContent: declarativeContent,
      scripting: {
        executeScript: injection.scripting.executeScript,
        insertCSS: injection.scripting.insertCSS,
        removeCSS: injection.scripting.removeCSS,
        ExecutionWorld: { ISOLATED: "ISOLATED", MAIN: "MAIN" }
      },
      // Chrome answers these at once; a call to the global page would answer
      // with a promise.
      identity: { getRedirectURL: WEX.identityRedirectURL },
      contextMenus: { create: createMenu("contextMenus") },
      menus: { create: createMenu("menus") },
      action: { setIcon: setIcon("action") },
      browserAction: { setIcon: setIcon("browserAction") },
      pageAction: { setIcon: setIcon("pageAction") }
    };

    WEX.addLegacyRequests(local.extension, native, true);
    var namespace = { __wex: true, __wexNative: native };
    WEX.NAMESPACES.filter(WEX.namespaceGranted).forEach(function (name) {
      if (!Object.prototype.hasOwnProperty.call(local, name)) {
        if (exists(name)) {
          namespace[name] = standIn(name, overrides[name]);
        }
      } else if (local[name] !== undefined) {
        namespace[name] = local[name];
      }
    });
    // The rest of runtime is the global page's.
    namespace.runtime = standIn("runtime", runtime);
    return namespace;
  }

  var ownTab = null;

  // The type extension.getViews knows this page by: a page in the popover is
  // a popup, a page in a tab is a tab, and the side panel and a document of
  // the global page's are neither.
  function viewKind() {
    if (inPopover) {
      return WEX.safari.self.identifier === WEX.SIDE_PANEL_POPOVER ? "other" : "popup";
    }
    return globalWindow ? "other" : "tab";
  }

  // The devtools API of a devtools page or panel the runtime shows in a
  // window of its own (wex-devtools.js), which the window provides.
  function hostedDevtools() {
    try {
      var host = g.top !== g && g.top.__wexDevtoolsHost;
      return host ? host.devtools : undefined;
    } catch (e) {
      return undefined;
    }
  }

  // ------------------------------------------------------------------ //
  // The worker, from a page
  // ------------------------------------------------------------------ //
  // A page of an extension whose background is a worker reaches the worker
  // through navigator.serviceWorker. A page in the global page's process,
  // as the offscreen document and the popover are, connects to it there
  // (wex-global.js): the active worker's postMessage reaches the worker,
  // ports and all, and what the worker's Client for this page posts arrives
  // here. A page in a tab, in a web process, connects through a shared
  // worker of the extension's, the same one the global page connects to,
  // whose ports carry ports too (wex-worker-relay.js).
  function workerHost() {
    var candidates = [];
    try {
      if (g.parent !== g) {
        candidates.push(g.parent);
      }
    } catch (e) { /* not reachable */ }
    candidates.push(globalWindow);
    for (var i = 0; i < candidates.length; i++) {
      try {
        if (candidates[i] && candidates[i].__wexServiceWorker) {
          return candidates[i].__wexServiceWorker;
        }
      } catch (e) { /* another origin */ }
    }
    return null;
  }

  function relayHost() {
    if (typeof g.SharedWorker !== "function") {
      return null;
    }
    return {
      connect: function (page, deliver) {
        var relay;
        try {
          relay = new g.SharedWorker(WEX.extUrl(WEX.WORKER_RELAY), { name: "wex-worker-relay" });
        } catch (e) {
          return null;
        }
        relay.port.onmessage = function (e) {
          var m = e.data || {};
          if (m.wex === "post") {
            deliver(m.data, Array.prototype.slice.call(e.ports || []));
          }
        };
        relay.port.start();
        relay.port.postMessage({ wex: "client", id: WEX.uid("page"), url: String(page.location.href) });
        return {
          postMessage: function (data, transfer) {
            var list = Array.isArray(transfer) ? transfer : transfer && Array.isArray(transfer.transfer) ?
              transfer.transfer : [];
            relay.port.postMessage({ wex: "post", data: data }, list);
          },
          disconnect: function () {
            relay.port.postMessage({ wex: "close" });
          }
        };
      }
    };
  }

  function installServiceWorkerContainer() {
    if (!WEX.CONFIG.backgroundWorker) {
      return;
    }
    try {
      if (g.navigator.serviceWorker && g.navigator.serviceWorker.controller) {
        return;
      }
    } catch (e) { /* none */ }
    var host = workerHost() || relayHost();
    if (!host) {
      return;
    }
    var container = new g.EventTarget();
    container.onmessage = null;
    container.onmessageerror = null;
    container.oncontrollerchange = null;
    var worker = new g.EventTarget();
    var background = (WEX.CONFIG.manifest && WEX.CONFIG.manifest.background) || {};
    worker.scriptURL = WEX.extUrl(String(background.service_worker || ""));
    worker.state = "activated";
    worker.onstatechange = null;
    worker.onerror = null;
    var link = host.connect(g, function (data, transfer) {
      var ports = (transfer || []).filter(function (item) {
        return item && typeof item.postMessage === "function" && typeof item.start === "function";
      });
      // A port inside the data can be copied only by being moved.
      var copy = data;
      if (typeof g.structuredClone === "function") {
        try {
          copy = g.structuredClone(data);
        } catch (e) {
          try {
            var moved = g.structuredClone({ data: data, ports: ports }, { transfer: ports });
            copy = moved.data;
            ports = moved.ports;
          } catch (err) { /* handed over as it is */ }
        }
      }
      setTimeout(function () {
        var event = new g.MessageEvent("message", { data: copy, ports: ports, origin: g.location.origin });
        try {
          Object.defineProperty(event, "source", { value: worker });
        } catch (e) { /* left as the engine set it */ }
        if (typeof container.onmessage === "function") {
          container.onmessage(event);
        }
        container.dispatchEvent(event);
      }, 0);
    });
    if (!link) {
      return;
    }
    worker.postMessage = function (data, transfer) {
      link.postMessage(data, transfer);
    };
    var registration = new g.EventTarget();
    registration.active = worker;
    registration.installing = null;
    registration.waiting = null;
    registration.scope = WEX.extUrl("");
    registration.updateViaCache = "imports";
    registration.onupdatefound = null;
    registration.update = function () {
      return Promise.resolve(registration);
    };
    registration.unregister = function () {
      return Promise.resolve(false);
    };
    container.controller = worker;
    container.ready = Promise.resolve(registration);
    container.getRegistration = function () {
      return Promise.resolve(registration);
    };
    container.getRegistrations = function () {
      return Promise.resolve([registration]);
    };
    container.register = function () {
      return Promise.reject(new g.DOMException("An extension's pages cannot register a service worker.",
        "SecurityError"));
    };
    container.startMessages = function () {};
    try {
      Object.defineProperty(g.navigator, "serviceWorker", { value: container, configurable: true });
    } catch (e) {
      return;
    }
    g.addEventListener("unload", function () {
      link.disconnect();
    });
  }

  // ------------------------------------------------------------------ //
  // Boot
  // ------------------------------------------------------------------ //
  WEX.installNetworkFixups(g);
  WEX.installWebFacingAddresses(g);
  WEX.installExtensionOrigin(g);
  WEX.installExtensionUrlBase(g);
  WEX.installExtensionHostAlias(g);
  WEX.installIdleCallback(g);
  WEX.recordDatabases(g);
  WEX.installSandboxFrames(g);
  installServiceWorkerContainer();
  WEX.installNetworkInformation(g);
  WEX.installCommandKeys(g, function (name) {
    native.runtime.sendMessage({ __wex: "command", name: name }).catch(function () {});
  });

  // The documents this page's own listeners did not hear commit.
  native.runtime.sendMessage({ __wex: "documentIds" }).then(WEX.learnDocumentIds, function () {
    /* this page's ids go by the frames' places */
  });

  var chrome = remoteNamespace();
  if (WEX.CONFIG.testApi) {
    chrome.test = WEX.makeTestApi(function (entry) {
      return native.runtime.sendMessage({ __wex: "test", entry: entry });
    }, function () {
      return chrome.runtime.lastError;
    });
  }

  g.chrome = chrome;
  g.browser = chrome;
  WEX.presentBrowser(g);
  WEX.pinRuntimeGlobals(g);

  // Whether the page listens for messages, for tabs.sendMessage to tell a
  // tab nobody listens in, as the content bridge says it for a web page.
  native.runtime.onMessage.addListener(function (message, sender, respond) {
    if (WEX.isInternal(message) && message.__wex === "listening" &&
        chrome.runtime && chrome.runtime.onMessage && chrome.runtime.onMessage.hasListeners()) {
      respond({ listening: true });
    }
    return undefined;
  });

  // A site the manifest's `externally_connectable` matches, in a frame of
  // this page outside a tab, where Safari runs no content script, has
  // Chrome's `chrome.runtime` for web pages from the global page
  // (wex-network.js) and sends its requests here as window messages
  // (WEX.framedPageRelay), to go on to the global page as the site's. The
  // message's origin says which site sends it, and the address the site
  // gives counts only within that origin.
  (function () {
    var allowed = (WEX.CONFIG.manifest || {}).externally_connectable;
    var matches = allowed && allowed.matches;
    if (WEX.CONFIG.firefoxBuild || !matches || !matches.length || typeof Map !== "function") {
      return;
    }
    var hosts = new Map();
    g.addEventListener("message", function (event) {
      var data = event.data;
      var source = event.source;
      if (!data || typeof data.__wexExternal !== "string" || !source || source === g) {
        return;
      }
      event.stopImmediatePropagation();
      var origin = String(event.origin || "");
      var url = String(data.url || "");
      if (url.slice(0, origin.length + 1) !== origin + "/") {
        url = origin + "/";
      }
      var request;
      try {
        request = JSON.parse(data.__wexExternal);
      } catch (e) {
        return;
      }
      var host = hosts.get(source);
      if (request && request.kind === "gone") {
        if (host) {
          hosts.delete(source);
          host.close();
        }
        return;
      }
      if (!WEX.matchesAny(url, matches)) {
        return;
      }
      if (!host) {
        host = WEX.pageRuntimeHost(native, function (reply) {
          try {
            source.postMessage({ __wexExternalReply: JSON.stringify(reply) }, origin);
          } catch (e) { /* the frame is gone */ }
        });
        hosts.set(source, host);
      }
      host.handle(request, url);
    }, true);
  })();

  var label = "page:" + (WEX.extPath(g.location.href) || "?");

  // A link on one of the extension's pages to its address as the browser it
  // was made for gives it, which Safari cannot open, goes to the page that
  // address names: in a new tab if its target asks for one, and otherwise here.
  try {
    g.document.addEventListener("click", function (e) {
      var web = WEX.WEB_ORIGIN;
      var link = web && e.target && e.target.closest && e.target.closest("a[href], area[href]");
      if (!link || e.defaultPrevented || e.button !== 0 ||
          String(link.href).slice(0, web.length + 1).toLowerCase() !== web.toLowerCase() + "/") {
        return;
      }
      e.preventDefault();
      var target = String(link.getAttribute("target") || "").toLowerCase();
      if (e.metaKey || (target && target !== "_self" && target !== "_parent" && target !== "_top")) {
        chrome.tabs.create({ url: String(link.href) });
      } else {
        g.location.href = WEX.baseURI + String(link.href).slice(web.length + 1);
      }
    }, false);
  } catch (e) { /* such links fail as Safari fails them */ }

  if (!inPopover) {
    // A tab's page knows its own tab and window for extension.getViews once
    // the global page has said which they are.
    try {
      chrome.tabs.getCurrent().then(function (tab) {
        ownTab = tab || null;
      }).catch(function () {});
    } catch (e) { /* views are then listed for any tab */ }

    // A page opened as a window of its own dismisses itself with
    // window.close(), which a tab the page did not open ignores. A page in a
    // frame keeps the frame's own close(), which closes nothing, as in Chrome,
    // and not the tab of the page that frames it.
    if (g.top === g) {
      try {
        g.close = function () {
          chrome.tabs.getCurrent().then(function (tab) {
            if (tab) {
              return chrome.tabs.remove(tab.id);
            }
            return undefined;
          }).catch(function () {});
        };
      } catch (e) { /* leave the original in place */ }
    }

    WEX.log.debug("extension page in a tab: " + label);
    return;
  }

  WEX.installOpenInTab(g, chrome.tabs);

  WEX.installPopupCanvas(g);

  // Safari sends a link followed in a popover to the active tab, even one to
  // a place in the same page. In Chrome a link in a popup navigates the
  // popup, unless it opens a new tab. So a link with a target opens a tab, a
  // link to one of the extension's own pages is followed in the popover, and
  // a link within the page moves to its fragment there. A link to the web is
  // left to Safari, which loads it in the tab the popover belongs to.
  try {
    g.document.addEventListener("click", function (e) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey ||
          e.shiftKey || e.altKey) {
        return;
      }
      var link = e.target && e.target.closest && e.target.closest("a[href], area[href]");
      if (!link || link.hasAttribute("download")) {
        return;
      }
      var href = link.href;
      if (!/^(https?|safari-extension):/i.test(href)) {
        return;
      }
      var target = String(link.getAttribute("target") || "").toLowerCase();
      if (target && target !== "_self" && target !== "_parent" && target !== "_top") {
        e.preventDefault();
        g.open(href);
      } else if (WEX.isExtUrl(href) &&
          href.split("#")[0] !== String(g.location.href).split("#")[0]) {
        e.preventDefault();
        g.location.href = href;
      } else if (WEX.isExtUrl(href)) {
        e.preventDefault();
        followFragment(href);
      }
    }, false);
  } catch (e) { /* ignore */ }

  // A move within the page, made without navigating, which Safari would take
  // out of the popover: the URL takes the new fragment, the element it names
  // is scrolled to, and the page hears of it as it would.
  function followFragment(href) {
    var before = String(g.location.href);
    if (href === before) {
      return;
    }
    var hash = href.indexOf("#") >= 0 ? href.slice(href.indexOf("#") + 1) : "";
    try {
      g.history.replaceState(g.history.state, "", href);
    } catch (e) {
      return;
    }
    var name = hash;
    try {
      name = decodeURIComponent(hash);
    } catch (e) { /* use it as written */ }
    var element = name && (g.document.getElementById(name) ||
      g.document.getElementsByName(name)[0]);
    if (element && element.scrollIntoView) {
      element.scrollIntoView();
    }
    try {
      g.dispatchEvent(new g.HashChangeEvent("hashchange", { oldURL: before, newURL: href }));
    } catch (e) { /* no event to make */ }
  }

  // A popup calling window.close() means "dismiss me". In a popover that is
  // safari.self.hide(); the native close() does nothing for a popover. A page
  // in a frame of the popover keeps the frame's own close(), which closes
  // nothing, as in Chrome.
  if (!inFrame) {
    try {
      var nativeClose = g.close ? g.close.bind(g) : null;
      g.close = function () {
        try {
          if (WEX.safari.self && typeof WEX.safari.self.hide === "function") {
            WEX.withSafari(g, function () {
              WEX.safari.self.hide();
            });
            return;
          }
        } catch (e) { /* ignore */ }
        if (nativeClose) {
          try {
            nativeClose();
          } catch (e) { /* ignore */ }
        }
      };
    } catch (e) { /* leave the original in place */ }
  }

  // A popup sized by the manifest expects the viewport to match. A popover's
  // size is set from outside the page, so resizeTo has nothing to act on;
  // swallow it rather than let it throw.
  try {
    g.resizeTo = function () {};
    g.moveTo = function () {};
  } catch (e) { /* ignore */ }

  // A browser popup is sized by its content; a popover is not, so it opens at
  // whatever the converter guessed. Measure the laid-out page and correct the
  // popover to fit, which is what makes an unmodified popup look right. The
  // width is the page's preferred one, as a browser takes it: the width of
  // its content laid out without wrapping more than it must, which a popover
  // wider than the page would otherwise pad with empty space. The height is
  // that of the content laid out at that width, not the viewport's, which a
  // page's own scroll height never falls below, so that a popover shrinks to
  // a page shorter than it as well as growing to a longer one: the root at
  // its content's height, and the body, made the box absolutely positioned
  // content is placed in, with what overflows it.
  // The observer that refits the popover as the page changes.
  var fitObserver = null;

  // Lays the page out under `css` for as long as `measure` runs. A sheet
  // adopted for the moment changes no attribute or node, so neither the
  // page's observers nor the popover's own see the measuring; a page that
  // answers a change to its root's attributes, as theme code does, would
  // otherwise be refitted forever. Where a document cannot adopt a sheet,
  // the rules go on the elements' style attributes, and the records of that
  // are dropped.
  var MEASURE_RULES = {
    width: ":root { width: max-content !important; }",
    height: ":root { width: WIDTHpx !important; height: max-content !important; }",
    body: "body { position: relative !important; }"
  };

  function withRules(doc, rules, measure) {
    if (typeof g.CSSStyleSheet === "function" && Array.isArray(doc.adoptedStyleSheets)) {
      var before = doc.adoptedStyleSheets;
      try {
        var sheet = new g.CSSStyleSheet();
        sheet.replaceSync(rules.join("\n"));
        doc.adoptedStyleSheets = before.concat([sheet]);
      } catch (e) {
        return measure();
      }
      try {
        return measure();
      } finally {
        doc.adoptedStyleSheets = before;
      }
    }
    var targets = [];
    rules.forEach(function (rule) {
      var element = rule.indexOf(":root") === 0 ? doc.documentElement : doc.body;
      var declarations = rule.slice(rule.indexOf("{") + 1, rule.lastIndexOf("}"));
      targets.push({ element: element, declarations: declarations });
    });
    var saved = targets.map(function (t) {
      return t.element.getAttribute("style");
    });
    targets.forEach(function (t) {
      declarations(t.declarations).forEach(function (d) {
        t.element.style.setProperty(d[0], d[1], "important");
      });
    });
    var result = measure();
    targets.forEach(function (t, i) {
      if (saved[i] === null) {
        t.element.removeAttribute("style");
      } else {
        t.element.setAttribute("style", saved[i]);
      }
    });
    if (fitObserver) {
      fitObserver.takeRecords();
    }
    return result;
  }

  function declarations(text) {
    return text.split(";").map(function (part) {
      var colon = part.indexOf(":");
      return colon < 0 ? null : [part.slice(0, colon).trim(),
        part.slice(colon + 1).replace(/!important/, "").trim()];
    }).filter(Boolean);
  }

  function preferredWidth(doc) {
    var root = doc.documentElement;
    return withRules(doc, [MEASURE_RULES.width], function () {
      return Math.ceil(root.getBoundingClientRect().width);
    });
  }

  function contentHeight(doc, width) {
    var root = doc.documentElement;
    var body = doc.body;
    var rules = [MEASURE_RULES.height.replace("WIDTH", String(width))];
    if (g.getComputedStyle(body).position === "static") {
      rules.push(MEASURE_RULES.body);
    }
    return withRules(doc, rules, function () {
      var rootBox = root.getBoundingClientRect();
      var bodyBox = body.getBoundingClientRect();
      var margin = parseFloat(g.getComputedStyle(body).marginBottom) || 0;
      // In quirks mode the body is the page's scrolling element, whose
      // scrollHeight is the viewport's, the popover's own height or more.
      var overflow = doc.scrollingElement === body ? 0 : body.scrollHeight;
      return Math.ceil(Math.max(rootBox.height,
        bodyBox.top - rootBox.top + Math.max(overflow, bodyBox.height) + margin));
    });
  }

  function fitPopover() {
    var self;
    try {
      self = WEX.safari.self;
    } catch (e) {
      return;
    }
    if (!self || typeof self.width !== "number" || self.identifier === WEX.SIDE_PANEL_POPOVER) {
      return;
    }
    var doc = g.document;
    var body = doc.body;
    if (!body) {
      return;
    }
    var width = preferredWidth(doc) || Math.max(body.scrollWidth, doc.documentElement.scrollWidth);
    var height = contentHeight(doc, Math.max(180, Math.min(1000, width))) ||
      Math.max(body.scrollHeight, doc.documentElement.scrollHeight);
    if (!width || !height) {
      return;
    }
    // A size given again is still a resize to the page, and a page that
    // answers a resize by touching the document would be refitted forever.
    var fitWidth = Math.max(180, Math.min(1000, width));
    var fitHeight = Math.max(100, Math.min(760, height));
    try {
      if (self.width !== fitWidth) {
        self.width = fitWidth;
      }
      if (self.height !== fitHeight) {
        self.height = fitHeight;
      }
    } catch (e) { /* the host may refuse a size */ }
  }

  if (WEX.CONFIG.autoSizePopover !== false && !inFrame) {
    try {
      g.addEventListener("load", function () {
        // One pass once the document has laid out, and a second after any
        // scripted first render has had a turn.
        fitPopover();
        setTimeout(fitPopover, 250);
        // A popup that shows more later, a translation say, is refitted
        // the way a browser grows its popup.
        var pending = false;
        var refit = function () {
          if (pending) {
            return;
          }
          pending = true;
          g.requestAnimationFrame(function () {
            pending = false;
            fitPopover();
          });
        };
        if (typeof g.ResizeObserver === "function" && g.document.body) {
          new g.ResizeObserver(refit).observe(g.document.body);
        }
        if (typeof g.MutationObserver === "function") {
          fitObserver = new g.MutationObserver(refit);
          fitObserver.observe(g.document.documentElement,
            { childList: true, subtree: true, attributes: true, characterData: true });
        }
      });
    } catch (e) { /* ignore */ }
  }

  // The macOS text system does not move focus to a button when it is clicked,
  // so a click never blurs the field that holds focus. Forms that only read a
  // field's value on blur would act on a stale value. Blur the focused field
  // as soon as a press lands on something actionable, before the click fires.
  try {
    g.document.addEventListener("mousedown", function (e) {
      var active = g.document.activeElement;
      if (!active || !/^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) {
        return;
      }
      var target = e.target;
      var actionable = target && target.closest &&
        target.closest("button, a[href], [role='button'], input[type='submit']");
      if (actionable && actionable !== active) {
        try {
          active.blur();
        } catch (err) { /* ignore */ }
      }
    }, true);
  } catch (e) { /* ignore */ }

  // Safari's popover sounds the alert for a key press its page leaves
  // uncancelled, though the page acted on it; Chrome's and Firefox's popups
  // do not. A key nothing else cancelled is cancelled once it has reached
  // every listener, which leaves AppKit nothing to sound for, unless it
  // means something here: a shortcut, a key for a field, button or link,
  // Tab, Escape and Return, a scrolling key in a page that scrolls, and a
  // printable key in a page that listens for keypress, which a cancelled
  // keydown would not send.
  var KEPT_KEYS = ["Tab", "Escape", "Enter"];
  var SCROLL_KEYS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " ", "PageUp", "PageDown",
    "Home", "End"];
  var hearsKeypress = false;

  function keyMatters(e) {
    if (e.metaKey || e.ctrlKey || e.altKey || KEPT_KEYS.indexOf(e.key) >= 0) {
      return true;
    }
    var target = e.target;
    if (target && target.closest &&
        target.closest("input, textarea, select, button, a[href], summary, [contenteditable], [tabindex]")) {
      return true;
    }
    if (SCROLL_KEYS.indexOf(e.key) >= 0) {
      var page = g.document.scrollingElement || g.document.documentElement;
      return !!page && (page.scrollHeight > page.clientHeight || page.scrollWidth > page.clientWidth);
    }
    return String(e.key).length === 1 && (hearsKeypress || !!g.onkeypress || !!g.document.onkeypress);
  }

  // The window's own keydown listeners run in the order they were added, so
  // this one is moved behind each one the page adds. A bare
  // addEventListener() call has no `this`, and means the window.
  function silenceKey(e) {
    if (!e.defaultPrevented && !keyMatters(e)) {
      e.preventDefault();
    }
  }

  if (inPopover) {
    try {
      var windowListen = g.addEventListener;
      var windowUnlisten = g.removeEventListener;
      var proto = g.EventTarget && g.EventTarget.prototype;
      var nativeListen = proto && proto.addEventListener;
      if (typeof nativeListen === "function") {
        proto.addEventListener = function (type) {
          var result = nativeListen.apply(this, arguments);
          if (String(type) === "keypress") {
            hearsKeypress = true;
          } else if (String(type) === "keydown" && (this === g || this == null)) {
            windowUnlisten.call(g, "keydown", silenceKey, false);
            windowListen.call(g, "keydown", silenceKey, false);
          }
          return result;
        };
      }
      windowListen.call(g, "keydown", silenceKey, false);
    } catch (e) { /* keys sound as Safari has them */ }
  }

  WEX.log.debug("extension page in the popover: " + label);
})(this);
