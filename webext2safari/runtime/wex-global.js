// The WebExtension API, completed on the global page of a legacy Safari
// extension.
//
// WebKit provides the parts of the `browser` namespace that need the engine:
// messaging, script and style injection, webRequest, declarativeNetRequest,
// webNavigation, cookies, and tab events. The global page is the one context
// with the whole `safari.*` object graph - browser windows and tabs, toolbar
// items, popovers, the settings store - so everything built on that lives
// here. The popover reaches it directly; extension pages in tabs and content
// scripts reach it through the engine's runtime messaging.
//
// Loaded by the global page after wex-config.js and wex-core.js and before
// any of the extension's own background scripts.

(function (g) {
  "use strict";

  var CONFIG = WEX.CONFIG;
  var native = WEX.native;
  var app = WEX.safari.application;
  var ext = WEX.safari.extension;
  var log = WEX.log;
  var Event = WEX.Event;
  var done = WEX.done;
  var settle = WEX.settle;

  // In a WebKit older than the runtime needs, the user is told, and neither
  // the runtime nor the extension's background scripts start
  // (webkit-requirement.js, which the global page loads ahead of the runtime).
  if (g.WebKitRequirement && !g.WebKitRequirement.start(CONFIG.name)) {
    return;
  }

  if (!native) {
    log.error("this WebKit provides no `browser` namespace for extensions; " +
      "the extension cannot run");
    return;
  }

  if (WEX.forgetEarlierInstall(g, ext.settings, ["wex-storage"])) {
    log.debug("first start: removed the data an earlier install left");
  }
  WEX.recordDatabases(g);
  WEX.installSandboxFrames(g);
  WEX.installNetworkFixups(g);
  WEX.installWebFacingAddresses(g);
  WEX.installExtensionOrigin(g);
  WEX.installExtensionUrlBase(g);
  WEX.installExtensionHostAlias(g);
  WEX.installIdleCallback(g);
  WEX.installNetworkInformation(g);

  // Keep a runtime registration of the content bridge as a backstop for the
  // Info.plist list. Safari can omit that static injection even on a fresh
  // install; an updated extension can instead keep its old list until it is
  // relaunched. The guard, run()'s phase tracking and applies() keep the two
  // injection paths from running the extension's scripts twice.
  (function registerBridge() {
    if (!CONFIG.bridgeWhitelist || typeof ext.addContentScript !== "function") {
      return;
    }
    var key = "wex.bridgeScripts";
    var store = ext.settings || WEX.localStorageOf(g);
    var handles = [];
    function remove(urls) {
      (urls || []).forEach(function (url) {
        try { ext.removeContentScript(url); } catch (e) { /* already withdrawn */ }
      });
    }
    var injected = CONFIG.injectedScripts || {};
    try {
      // Reloads may leave dynamic registrations behind too. Only remove the
      // handles owned by this bridge, never the extension's registrations.
      var previous = store && JSON.parse(store.getItem(key) || "[]");
      if (Array.isArray(previous)) { remove(previous); }
      if (store && previous && previous.length) { store.setItem(key, "[]"); }
    } catch (e) { /* storage may be unavailable */ }
    try {
      var source = WEX.readTextSync("wex/wex-bridge.js");
      if (source == null) { throw new Error("could not read wex/wex-bridge.js"); }
      var start = "if (typeof WEXContent === 'undefined' || !WEXContent) {\n" +
        source + "\n}\nif (WEXContent) WEXContent.run('document_start');";
      var end = "if (typeof WEXContent !== 'undefined' && WEXContent) " +
        "WEXContent.run('document_end');";
      handles.push(ext.addContentScript(start, CONFIG.bridgeWhitelist, [], false));
      handles.push(ext.addContentScript(end, CONFIG.bridgeWhitelist, [], true));
      if (!handles[0] || !handles[1]) {
        throw new Error("Safari rejected the bridge's script registration");
      }
      [[injected.start || [], false], [injected.end || [], true]].forEach(function (phase) {
        phase[0].forEach(function (file) {
          var copy = WEX.readTextSync(file);
          var handle = copy == null ? null : ext.addContentScript(copy, CONFIG.bridgeWhitelist, [], phase[1]);
          if (handle) {
            handles.push(handle);
          } else {
            log.warn("could not register the content script " + file);
          }
        });
      });
    } catch (e) {
      remove(handles.filter(function (url) { return !!url; }));
      handles = [];
      log.warn("could not register the content bridge at runtime", e);
    }
    try {
      if (store) { store.setItem(key, JSON.stringify(handles)); }
    } catch (e) { /* the active registrations still work without storage */ }
    g.addEventListener("unload", function () { remove(handles); }, false);
  })();

  // A background service worker loads its other scripts with importScripts,
  // which a page does not have. Each script is fetched and run in the global
  // scope before the call returns, as in a worker, and a relative path is
  // resolved against the page, which sits beside the worker.
  if (CONFIG.backgroundWorker && typeof g.importScripts === "undefined") {
    g.importScripts = function () {
      Array.prototype.slice.call(arguments).forEach(function (path) {
        var url = new g.URL(String(path), g.location.href).href;
        var source = WEX.readTextSync(WEX.extPath(url) || url);
        if (source == null) {
          throw new g.DOMException("Failed to load " + path, "NetworkError");
        }
        runInGlobalScope(source, url);
      });
    };
  }

  // Runs a script as an inline script element, which runs as it is inserted
  // and shares the global scope with every other script, so that its
  // top-level `let`, `const` and `class` are seen by the scripts after it, as
  // a worker's imported scripts are. What it throws is thrown to the caller.
  // A page whose policy refuses inline scripts runs it as global code
  // instead, where those declarations stay its own.
  var scriptRuns = 0;
  function runInGlobalScope(source, url) {
    var marker = "__wexScriptRan" + ++scriptRuns;
    var failure = null;
    var failed = false;
    function caught(e) {
      if (!failed) {
        failed = true;
        failure = e.error !== undefined && e.error !== null ? e.error : new Error(e.message);
      }
      e.preventDefault();
    }
    var script = g.document.createElement("script");
    script.textContent = source + "\n;self." + marker + " = true;\n//# sourceURL=" + url;
    g.addEventListener("error", caught, true);
    try {
      (g.document.head || g.document.documentElement).appendChild(script);
    } finally {
      g.removeEventListener("error", caught, true);
      if (script.parentNode) {
        script.parentNode.removeChild(script);
      }
    }
    // A script that reached its end succeeded, whatever error events it
    // caused on the way: one of them can be an imported script's failure
    // that it caught.
    if (g[marker]) {
      delete g[marker];
      return;
    }
    if (failed) {
      throw failure;
    }
    (0, eval)(WEX.asScript(source) + "\n//# sourceURL=" + url);
  }

  // ------------------------------------------------------------------ //
  // Diagnostics
  // ------------------------------------------------------------------ //
  // A short record of what the global page has been doing, kept for the
  // debug channel to publish onto web pages, where it can be read without an
  // inspector. This is what turns "clicking the button does nothing" into
  // something readable.
  var diagnostics = [];

  function note(message) {
    diagnostics.push({ at: Date.now(), message: String(message) });
    if (diagnostics.length > 60) {
      diagnostics.shift();
    }
    log.debug(message);
  }

  g.__wexDiagnostics = diagnostics;
  g.__wexNote = note;

  // A background script that throws is recorded, because from the outside a
  // broken background looks exactly like a broken bridge, and so is a
  // rejection no one handles, each with what was thrown: an Error's stack,
  // or the value itself.
  function described(value) {
    if (value instanceof Error) {
      return String(value.name) + ": " + String(value.message) +
        (value.stack ? " @ " + String(value.stack).split("\n").slice(0, 3).join(" | ") : "");
    }
    try {
      return JSON.stringify(value).slice(0, 300);
    } catch (e) {
      return String(value);
    }
  }

  try {
    g.addEventListener("error", function (e) {
      note("error: " + (e && e.message ? e.message : "unknown") +
        (e && e.filename ? " (" + String(e.filename).split("/").pop() +
          ":" + (e.lineno || 0) + ")" : "") +
        (e && e.error !== undefined && e.error !== null ? " thrown: " + described(e.error) : ""));
    });
    g.addEventListener("unhandledrejection", function (e) {
      note("unhandled rejection: " + described(e && e.reason));
    });
  } catch (e) { /* ignore */ }

  // What the global page can say about itself, for whoever is looking.
  function state() {
    var popover = null;
    try {
      var list = ext.popovers || [];
      popover = {
        count: list.length,
        identifiers: list.map(function (p) {
          return p.identifier;
        }),
        contentURL: list[0] ? String(list[0].contentURL || "") : null,
        visible: list[0] ? !!list[0].visible : null
      };
    } catch (e) {
      popover = { error: String(e && e.message ? e.message : e) };
    }

    var toolbar = null;
    try {
      var items = ext.toolbarItems || [];
      toolbar = {
        count: items.length,
        identifiers: items.map(function (i) {
          return i.identifier;
        }),
        hasShowPopover: items.length ? typeof items[0].showPopover === "function" : null
      };
    } catch (e) {
      toolbar = { error: String(e && e.message ? e.message : e) };
    }

    var tabs = allTabs();
    return {
      name: CONFIG.name,
      extensionId: CONFIG.extensionId,
      baseURI: WEX.baseURI,
      declaredPopup: CONFIG.popupPage || null,
      popover: popover,
      toolbar: toolbar,
      clickListeners: actionOnClicked.listeners.length,
      tabs: {
        open: tabs.length,
        identified: tabs.filter(function (t) {
          return idBySafariTab.has(t);
        }).length
      },
      log: diagnostics.slice(-25)
    };
  }

  g.__wexState = state;

  // Commands the debug channel accepts. Each one exercises a single step of
  // the path a toolbar click takes, so a failure can be pinned to the step
  // that fails rather than inferred from the whole thing doing nothing.
  function runDebugCommand(command) {
    note("debug command: " + command);
    var po = popoverEl();
    var items = toolbarItems();

    if (command === "showPopover") {
      if (!items.length) {
        note("  no toolbar item to show a popover from");
        return;
      }
      var item = items[0];
      note("  toolbar item '" + item.identifier + "', showPopover is " +
        typeof item.showPopover);
      try {
        item.showPopover();
        note("  showPopover() returned; popover.visible is now " +
          (po ? String(po.visible) : "(no popover)"));
      } catch (e) {
        note("  showPopover() threw: " + (e && e.message ? e.message : e));
      }
      return;
    }

    if (command === "inspectPopover") {
      if (!po) {
        note("  there is no popover");
        return;
      }
      var keys = [];
      for (var k in po) {
        keys.push(k);
      }
      note("  popover properties: " + keys.join(","));
      note("  identifier=" + po.identifier + " visible=" + po.visible +
        " width=" + po.width + " height=" + po.height +
        " contentURL='" + String(po.contentURL || "") + "'" +
        " contentWindow=" + (po.contentWindow ? "present" : "null"));
      return;
    }

    if (command === "reportClick") {
      reportToolbarClick();
      return;
    }

    if (command === "openOptions") {
      openExtensionPage(CONFIG.optionsPage || "").catch(function (error) { log.error(error); });
      return;
    }

    note("  unknown command");
  }

  // ------------------------------------------------------------------ //
  // Tabs and windows
  // ------------------------------------------------------------------ //
  // WebKit identifies a tab by its page, and that id is what messaging,
  // webRequest and webNavigation carry. Safari identifies a tab by its
  // SafariBrowserTab object, and WebKit's tabs.get gives the id of the page a
  // SafariBrowserTab shows. Each tab is looked up as Safari shows it: the tabs
  // open at startup, each tab that opens, and a tab whose page WebKit
  // replaces, which Chrome reports with tabs.onReplaced.
  //
  // A tab showing no page of WebKit's is given a provisional id, so the
  // extension can still be told about it. Once it shows a page the tab goes
  // by that page's id, and the provisional id still names the tab in a call.
  var safariTabById = new Map();
  var idBySafariTab = new Map();
  var provisionalIds = new Map();
  var retiredIds = new Map();
  var nextProvisionalId = WEX.PROVISIONAL_TAB_ID;
  var engineTabs = {};
  var lookups = new Map();
  // The tabs the runtime opens for itself, hidden, and the ids of their
  // pages, which no other page takes: they are not the extension's to see.
  var runtimeTabs = new Set();
  var runtimeTabIds = {};
  // The pages of the empty tabs Safari keeps in its windows of hidden tabs.
  var placeholderIds = {};

  function isPlaceholder(tab) {
    var w = tab && tab.browserWindow;
    return !!w && w.visible === false && w.tabs[0] === tab;
  }
  var tabsOnReplaced = new Event("tabs.onReplaced");

  function bindTab(id, tab) {
    var provisional = provisionalIds.has(tab);
    var replaced = provisional ? provisionalIds.get(tab) : idBySafariTab.get(tab);
    if (replaced !== undefined && replaced !== id) {
      if (provisional) {
        retiredIds.set(replaced, tab);
      }
      safariTabById.delete(replaced);
      setTimeout(function () {
        tabsOnReplaced.emit(id, replaced);
      }, 0);
      // A tab's group goes with it to its new id.
      if (typeof tabGroupState !== "undefined" && tabGroupState.members[replaced] != null) {
        tabGroupState.members[id] = tabGroupState.members[replaced];
        delete tabGroupState.members[replaced];
        saveTabGroups();
      }
      // So does the side panel set for it, which Chrome keeps for a tab
      // whatever it shows.
      if (panelTabs[replaced]) {
        panelTabs[id] = panelTabs[replaced];
        delete panelTabs[replaced];
      }
    }
    var previousTab = safariTabById.get(id);
    if (previousTab !== undefined && previousTab !== tab) {
      idBySafariTab.delete(previousTab);
    }
    safariTabById.set(id, tab);
    idBySafariTab.set(tab, id);
    provisionalIds.delete(tab);
    if (runtimeTabs.has(tab)) {
      runtimeTabIds[id] = true;
    }
    if (isPlaceholder(tab)) {
      placeholderIds[id] = true;
    }
  }

  function unbindTab(id) {
    var tab = safariTabById.get(id);
    if (tab !== undefined) {
      idBySafariTab.delete(tab);
      // The provisional ids the tab went by name no tab once it is gone.
      retiredIds.forEach(function (retired, key) {
        if (retired === tab) {
          retiredIds.delete(key);
        }
      });
    }
    safariTabById.delete(id);
  }

  // Asks WebKit for the id of the page the tab shows, and resolves with it,
  // or with undefined for a tab that shows none or has closed. An open tab
  // that shows none is given a provisional id.
  function lookUp(tab) {
    var pending = lookups.get(tab);
    if (pending) {
      return pending;
    }
    function pageless() {
      lookups.delete(tab);
      if (tab.browserWindow && !idBySafariTab.has(tab) && !provisionalIds.has(tab) && !runtimeTabs.has(tab)) {
        provisionalIds.set(tab, nextProvisionalId++);
      }
      return undefined;
    }
    pending = Promise.resolve().then(function () {
      return native.tabs.get(tab);
    }).then(function (info) {
      if (!info || typeof info.id !== "number") {
        return pageless();
      }
      lookups.delete(tab);
      engineTabs[info.id] = info;
      bindTab(info.id, tab);
      return info.id;
    }, pageless);
    lookups.set(tab, pending);
    return pending;
  }

  // The id the extension knows the tab by, once the tab has been looked up.
  function identify(tab) {
    if (idBySafariTab.has(tab)) {
      return Promise.resolve(idBySafariTab.get(tab));
    }
    return lookUp(tab).then(function () {
      return idForTab(tab);
    });
  }

  // Every tab not known by a page of WebKit's is looked up.
  function identifyAll() {
    var waits = [];
    eachSafariTab(function (t) {
      if (!idBySafariTab.has(t)) {
        waits.push(lookUp(t));
      }
    });
    return Promise.all(waits);
  }

  // A call that describes tabs, made once every tab has been looked up.
  function afterIdentified(fn) {
    return function () {
      var self = this;
      var args = arguments;
      return identifyAll().then(function () {
        return fn.apply(self, args);
      });
    };
  }

  // Safari's URL setter lowercases the extension identifier, but its resource
  // loader requires the original case. Use WebKit for extension navigations.
  // Where a tab was sent, until it shows something other than an empty
  // page: Chrome describes such a tab by the address it is loading.
  var pendingUrls = new Map();
  // The tab an extension names as one's opener.
  var openers = new Map();

  function pendingUrlFor(t) {
    var pending = pendingUrls.get(t);
    var shown = String(t && t.url || "");
    if (pending && shown && shown !== "about:blank" && shown.indexOf("about:blank#") !== 0) {
      pendingUrls.delete(t);
      return null;
    }
    return pending || null;
  }

  // The engine says the tab with page `id` has committed or finished loading
  // `shown`, which settles where it was sent even where Safari gives no
  // address, as for a page outside the extension's website access. The blank
  // page a tab passes through on its way to an extension's page settles
  // nothing.
  function pendingUrlReached(id, shown) {
    var tab = safariTabById.get(id);
    if (tab && !/^about:blank(#|$)/i.test(String(shown || ""))) {
      pendingUrls.delete(tab);
    }
  }

  // An empty tab sent to the extension's new-tab page stays empty until the
  // page loads, as a new tab does.
  function navigateTab(tab, url, asNewTab) {
    // A blank page has nothing to load.
    if (/^about:blank(#|$)/i.test(url)) {
      pendingUrls.delete(tab);
    } else {
      pendingUrls.set(tab, url);
    }
    if (!/^safari-extension:/i.test(url)) {
      tab.url = url;
      return Promise.resolve();
    }
    return pageOf(tab, asNewTab).then(function (tabId) {
      return native.tabs.update(tabId, { url: url });
    });
  }

  // The id of the page the tab shows. A tab that shows none is given a blank
  // page first, and so is an empty tab unless it is to stay one: Safari
  // announces a navigation to a page another extension may not see with no
  // address, as it does a new tab's Top Sites, so another extension's new-tab
  // page would take the tab's place; a blank page it announces with its own.
  function pageOf(tab, keepEmpty) {
    return identify(tab).then(function (id) {
      if (safariTabById.get(id) === tab && (keepEmpty || tab.url !== "")) {
        return id;
      }
      return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () {
          cleanup();
          reject(new Error("Could not identify the Safari tab for navigation."));
        }, 10000);
        function created() {
          lookUp(tab).then(function (found) {
            if (found !== undefined) {
              cleanup();
              resolve(found);
            }
          });
        }
        function cleanup() {
          clearTimeout(timer);
          native.tabs.onCreated.removeListener(created);
          native.tabs.onUpdated.removeListener(created);
        }
        native.tabs.onCreated.addListener(created);
        native.tabs.onUpdated.addListener(created);
        try {
          tab.url = "about:blank";
        } catch (error) {
          cleanup();
          reject(error);
        }
      });
    });
  }

  // The id the extension knows the tab by: its page's, or a provisional one
  // when it shows no page. A tab not looked up yet has none until it has
  // been; the calls and events that tell the extension of tabs wait for that.
  function idForTab(tab) {
    var id = idBySafariTab.get(tab);
    if (id === undefined) {
      id = provisionalIds.get(tab);
    }
    if (id === undefined) {
      lookUp(tab);
    }
    return id;
  }

  function tabForId(id) {
    var wanted = Number(id);
    var tab = safariTabById.get(wanted) || retiredIds.get(wanted);
    if (tab) {
      return tab;
    }
    if (wanted >= WEX.PROVISIONAL_TAB_ID) {
      allTabs();
      var found = null;
      provisionalIds.forEach(function (value, key) {
        if (value === wanted) {
          found = key;
        }
      });
      return found;
    }
    return null;
  }

  function isSafariWindow(target) {
    return !!target && typeof target === "object" && "activeTab" in target && "tabs" in target;
  }

  function isSafariTab(target) {
    return !!target && typeof target === "object" && "browserWindow" in target;
  }

  // Safari keeps hidden tabs in a window it never shows, after an empty tab
  // of its own. That window and that tab are not the extension's to see,
  // nor are the runtime's own tabs.
  function shownWindows() {
    return app.browserWindows.filter(function (w) {
      return w.visible !== false;
    });
  }

  function shownTabs(w) {
    return w.tabs.filter(function (t, i) {
      return !(w.visible === false && i === 0) && !runtimeTabs.has(t) &&
        !runtimeTabIds[idBySafariTab.get(t)];
    });
  }

  function eachSafariTab(fn) {
    try {
      app.browserWindows.forEach(function (w) {
        shownTabs(w).forEach(fn);
      });
    } catch (e) {
      log.error("could not enumerate tabs", e);
    }
  }

  function allTabs() {
    var out = [];
    eachSafariTab(function (t) {
      idForTab(t);
      out.push(t);
    });
    return out;
  }

  var windowIds = new Map();
  var windowById = new Map();
  var nextWindowId = 1;

  function windowIdFor(w) {
    if (!w) {
      return -1;
    }
    var id = windowIds.get(w);
    if (id === undefined) {
      id = nextWindowId++;
      windowIds.set(w, id);
      windowById.set(id, w);
    }
    return id;
  }

  function windowForId(id) {
    if (id === -2) {
      return app.activeBrowserWindow;
    }
    if (typeof id !== "number") {
      return null;
    }
    app.browserWindows.forEach(windowIdFor);
    var w = windowById.get(id);
    return w && w.visible !== false ? w : null;
  }

  // Safari keeps a hidden tab in a window the extension does not see. The
  // extension sees the tab where it was hidden from: the window and place it
  // comes back to, or the window in front when that is not known.
  var hiddenTabHomes = new WeakMap();

  function isHiddenTab(t) {
    return !!t.browserWindow && t.browserWindow.visible === false;
  }

  function tabWindow(t) {
    var w = t.browserWindow;
    if (!w || w.visible !== false) {
      return w;
    }
    var home = hiddenTabHomes.get(t);
    if (home && app.browserWindows.indexOf(home.window) >= 0) {
      return home.window;
    }
    return app.activeBrowserWindow || shownWindows()[0] || w;
  }

  function tabPosition(t) {
    var w = t.browserWindow;
    if (!w) {
      return 0;
    }
    if (w.visible !== false) {
      return w.tabs.indexOf(t);
    }
    var home = hiddenTabHomes.get(t);
    return home ? home.index : tabWindow(t).tabs.length;
  }

  // The hidden tabs that belong to window `w`.
  function hiddenTabsOf(w) {
    var out = [];
    app.browserWindows.forEach(function (other) {
      if (other.visible === false) {
        shownTabs(other).forEach(function (t) {
          if (tabWindow(t) === w) {
            out.push(t);
          }
        });
      }
    });
    return out;
  }

  function noWindowError(id) {
    return CONFIG.firefoxBuild ? "Invalid window ID: " + id : "No window with id: " + id + ".";
  }

  // Whether a window id names no window. WINDOW_ID_CURRENT with no window
  // open is the caller's to answer.
  function unknownWindow(id) {
    return id != null && id !== -2 && !windowForId(id);
  }

  function activeTab() {
    var w = app.activeBrowserWindow;
    return w ? w.activeTab : null;
  }

  function activeTabId() {
    var t = activeTab();
    return t ? idForTab(t) : null;
  }

  var tabStatus = {};

  // Chrome gives an extension with the tabs permission every tab's address
  // and title, an empty string for a tab that has not committed one; Safari
  // leaves out those of a page outside the extension's website access, which
  // such an extension is then given as Chrome gives a tab with none.
  var SEES_EVERY_TAB = WEX.declares("tabs");

  function withheldTabFields(info) {
    ["url", "title"].forEach(function (key) {
      if (info[key] === undefined) {
        if (SEES_EVERY_TAB) {
          info[key] = "";
        } else {
          delete info[key];
        }
      }
    });
    return info;
  }

  // A tabs.Tab, as Safari describes the tab.
  function tabInfo(t) {
    if (!t) {
      return null;
    }
    var id = idForTab(t);
    var w = tabWindow(t);
    var isActive = !!w && w.activeTab === t;
    var pending = pendingUrlFor(t);
    var info = {
      id: id,
      index: tabPosition(t),
      windowId: windowIdFor(w),
      openerTabId: openers.has(t) && tabForId(openers.get(t)) ? openers.get(t) : undefined,
      active: isActive,
      selected: isActive,
      highlighted: isActive,
      pinned: false,
      groupId: groupIdOf(id),
      audible: false,
      discarded: false,
      autoDiscardable: true,
      incognito: !!t.private,
      // Safari leaves out the address and title of a page the extension
      // does not see, as Chrome does; an empty tab, as Safari's Top Sites,
      // is about:blank.
      title: t.url === undefined && !pending ? undefined : t.title || "",
      url: pending || (t.url === undefined ? undefined : t.url || "about:blank"),
      pendingUrl: pending || undefined,
      favIconUrl: undefined,
      status: pending ? "loading" : tabStatus[id] || "complete",
      width: 0,
      height: 0
    };
    if (info.url === undefined) {
      info.title = undefined;
    }
    return withheldTabFields(info);
  }

  // A tabs.Tab for a tab object of the engine's: what Safari knows of the
  // tab, with the engine's word on what it is showing.
  function describeEngineTab(tab) {
    if (!tab) {
      return null;
    }
    var info = tabInfo(safariTabById.get(tab.id)) || {
      index: -1,
      windowId: -1,
      active: false,
      selected: false,
      highlighted: false,
      pinned: false,
      groupId: -1,
      audible: false,
      discarded: false,
      autoDiscardable: true
    };
    Object.keys(tab).forEach(function (key) {
      info[key] = tab[key];
    });
    info.groupId = groupIdOf(tab.id);
    var pending = pendingUrlFor(safariTabById.get(tab.id));
    if (pending && (!info.url || /^about:blank(#|$)/.test(info.url))) {
      info.url = pending;
      info.pendingUrl = pending;
    }
    if ("url" in tab && !info.url) {
      info.url = "about:blank";
    }
    return withheldTabFields(info);
  }

  function describeTabId(id) {
    var t = tabForId(id);
    if (t) {
      return Promise.resolve(tabInfo(t));
    }
    return tabError(native.tabs.get(Number(id)), id).then(describeEngineTab);
  }

  function windowInfo(w, populate) {
    if (!w) {
      return null;
    }
    // A legacy Safari window reports no geometry. Extensions read these to
    // place a window they are about to open - usually centring it - so leaving
    // them undefined turns that arithmetic into NaN. Describe the screen
    // instead, which is the closest true statement available and keeps the
    // numbers finite.
    var width = 1024;
    var height = 768;
    try {
      if (g.screen && g.screen.availWidth) {
        width = g.screen.availWidth;
        height = g.screen.availHeight;
      }
    } catch (e) { /* ignore */ }

    return {
      id: windowIdFor(w),
      focused: w === app.activeBrowserWindow,
      incognito: !!(w.activeTab && w.activeTab.private),
      type: "normal",
      state: "normal",
      alwaysOnTop: false,
      left: 0,
      top: 0,
      width: width,
      height: height,
      tabs: populate ? shownTabs(w).concat(hiddenTabsOf(w)).map(tabInfo) : undefined
    };
  }

  // A URL an extension passes to action.setIcon and the like. Chrome
  // resolves a relative one against the calling script, which for a
  // background service worker is the worker's own file: "../icons/x.png"
  // from background/worker.js names icons/x.png. The global page stands for
  // the worker, and sits beside it.
  function callerUrl(path) {
    var p = String(path == null ? "" : path);
    if (!p || p.charAt(0) === "/" || /^[a-z][a-z0-9+.\-]*:/i.test(p)) {
      return WEX.extUrl(p);
    }
    try {
      return WEX.extUrl(new g.URL(p, g.location.href).href);
    } catch (e) {
      return WEX.extUrl(p);
    }
  }

  // A URL an extension sends a tab to, with tabs.create, tabs.update or
  // windows.create, or shows as its popup, with setPopup. Chrome resolves a
  // relative one against the extension's root, whichever page or worker
  // names it; Firefox against the caller.
  // An address on the web that names the extension names it as the web
  // knows it (WEX.webFacingText), and the extension's own address as the
  // browser it was made for gives it is the extension's page here.
  // The extension's page an address of its own, as the browser it was made
  // for gives it, names, or null.
  function ownPageFor(url) {
    var web = WEX.WEB_ORIGIN;
    var u = String(url || "");
    if (!web || u.slice(0, web.length + 1).toLowerCase() !== web.toLowerCase() + "/") {
      return null;
    }
    return WEX.baseURI + u.slice(web.length + 1);
  }

  // The extension's page a tab showing `from` opens for an address of its
  // own, or null. As in Chrome, a page on the web opens only what the
  // manifest's web_accessible_resources gives it (WEX.pageFromWeb), and so
  // does a page Safari hides the address of, which `from` leaves undefined.
  // One of the extension's pages opens any, as its own link, and so does an
  // empty tab or a browser page, as an address typed there, unless tabOrigins
  // has it opened by a page on the web.
  var NOT_THE_WEB = /^(about:|safari-extension:|topsites:|bookmarks:|history:|reader:|$)/i;

  function pageForTabAt(url, from) {
    return from !== undefined && NOT_THE_WEB.test(String(from)) ?
      ownPageFor(url) : WEX.pageFromWeb(url, from);
  }

  // Where each tab's next page comes from, as Safari announces its
  // navigations: what the tab shows when it is sent to an address of the
  // extension's, and otherwise the address it is sent to, which a redirect
  // can leave for one of the extension's. A failed load shows the address it
  // failed on, so this is what can say which site sent it there.
  var navigationSources = new Map();

  // What an empty tab counts as opened by: { from: the address of the web
  // page behind it when it opened, or the page it last went to }, or null for
  // none. A site's window.open and a link with a target open such a tab, and
  // Safari does not say who asked. A tab opens over the page it is opened
  // from, so that page is its source, unless a popover is showing, which
  // then may be what opened it. The extension's tabs.create and tabs.update
  // give Safari its Safari address, to which this makes no difference.
  var tabOrigins = new WeakMap();
  var shownTab = null;
  var shownBefore = null;

  function noteShownTab(t) {
    if (t && t !== shownTab) {
      shownBefore = shownTab;
      shownTab = t;
    }
  }

  function popoverShowing() {
    try {
      return (ext.popovers || []).some(function (po) {
        return !!po.visible;
      });
    } catch (e) {
      return false;
    }
  }

  function isWebAddress(from) {
    return from === undefined || !NOT_THE_WEB.test(String(from));
  }

  function pageBehind(tab) {
    var w = tab.browserWindow;
    if (!w || w.visible === false || popoverShowing()) {
      return null;
    }
    // A tab opened in front may already be its window's active one.
    var behind = w.activeTab && w.activeTab !== tab ? w.activeTab : shownTab !== tab ? shownTab : shownBefore;
    if (!behind) {
      return null;
    }
    try {
      var from = behind.url;
      return isWebAddress(from) ? { from: from } : null;
    } catch (e) {
      return { from: undefined };
    }
  }

  function noteNewTab(tab) {
    if (!tabOrigins.has(tab)) {
      tabOrigins.set(tab, pageBehind(tab));
    }
  }

  // What a tab about to navigate counts as showing, for pageForTabAt.
  function navigationSource(tab) {
    var from = tab.url;
    var origin = from !== undefined && NOT_THE_WEB.test(String(from)) && !/^safari-extension:/i.test(String(from)) ?
      tabOrigins.get(tab) : null;
    return origin ? origin.from : from;
  }

  function navigationUrl(path) {
    var p = String(path == null ? "" : path);
    var own = ownPageFor(p);
    if (own) {
      return own;
    }
    if (/^https?:/i.test(p)) {
      return WEX.webFacingText(callerUrl(p));
    }
    if (CONFIG.firefoxBuild || !p || p.charAt(0) === "/" || /^[a-z][a-z0-9+.\-]*:/i.test(p)) {
      return callerUrl(p);
    }
    try {
      var resolved = new g.URL(p, "https://root.invalid/");
      return WEX.extUrl(resolved.pathname + resolved.search + resolved.hash);
    } catch (e) {
      return WEX.extUrl(p);
    }
  }

  // The engine's error for a tab it does not have, as the browser the
  // extension was built for words it.
  function tabError(promise, id) {
    return Promise.resolve(promise).then(null, function (error) {
      var message = String(error && error.message || error);
      if (message === "No tab with this id.") {
        message = CONFIG.firefoxBuild ? "Invalid tab ID: " + id : "No tab with id: " + id + ".";
      }
      throw new Error(message);
    });
  }

  // A browser's own pages (chrome://, about:addons) are not Safari's: Safari
  // hands such an address to another application, after asking the user
  // which. The browser the extension was built for refuses one it cannot
  // open, before any tab opens.
  var BROWSER_PAGE = /^(chrome|chrome-untrusted|chrome-search|chrome-native|devtools|edge|brave|opera|vivaldi|moz-extension|resource|view-source):/i;

  // Chrome's addresses that crash or hang the browser, which it refuses an
  // extension with an error of its own.
  var KILL_URL = /^(chrome:\/\/|about:)(crash|kill|hang|shorthang|inducebrowsercrashforrealz|uithreadhang|delayeduithreadhang|gpuclean|gpucrash|gpuhang|memory-exhaust|memory-pressure-critical|memory-pressure-moderate|quit|restart)\/?$/i;

  // The browser's new-tab page, which every browser opens: a new tab opens
  // empty, as Safari's, and becomes the extension's own new-tab page where it
  // has one.
  var NEW_TAB_URL = /^(chrome:\/\/newtab\/?|about:newtab)$/i;

  function newTabTarget() {
    var page = ((CONFIG.manifest || {}).chrome_url_overrides || {}).newtab;
    return page ? WEX.extUrl(String(page).replace(/^\/+/, "")) : "topsites://";
  }

  function unopenableUrlError(url) {
    var u = String(url == null ? "" : url);
    if (NEW_TAB_URL.test(u)) {
      return null;
    }
    if (!CONFIG.firefoxBuild && KILL_URL.test(u)) {
      return "I'm sorry. I'm afraid I can't do that.";
    }
    var browserPage = BROWSER_PAGE.test(u) && !WEX.isExtUrl(navigationUrl(u));
    var aboutPage = /^about:/i.test(u) && !/^about:(blank|srcdoc)([?#]|$)/i.test(u);
    if (!browserPage && !aboutPage) {
      return null;
    }
    return CONFIG.firefoxBuild ? "Illegal URL: " + u : "Invalid url: \"" + u + "\".";
  }

  // Extension pages open in tabs, where the engine gives them the `browser`
  // namespace and wex-page.js completes it. A page that is already open is
  // brought forward instead of being opened again. A tab reports the address
  // it was sent to only once the load commits, so the tabs opened here are
  // remembered by the address they were given.
  var openedPages = [];

  // Whether a tab opened here is still on its way to its page, or shows it.
  // Safari gives no address for a page outside the extension's website access.
  function stillOpening(entry) {
    var shown = entry.tab.url;
    if (shown === undefined) {
      return false;
    }
    var bare = function (url) {
      return String(url).split(/[?#]/)[0].toLowerCase();
    };
    return !shown || /^about:blank(#|$)/i.test(shown) || bare(shown) === bare(entry.url);
  }

  function openExtensionPage(path) {
    var url = WEX.extUrl(path);
    var page = url.split("#")[0];
    var tabs = allTabs();
    openedPages = openedPages.filter(function (entry) {
      return tabs.indexOf(entry.tab) >= 0 && stillOpening(entry);
    });
    var existing = tabs.filter(function (t) {
      return String(t.url || "").split("#")[0] === page;
    }).concat(openedPages.filter(function (entry) {
      return entry.url === page;
    }).map(function (entry) {
      return entry.tab;
    }))[0];
    if (existing) {
      try {
        existing.activate();
        if (existing.browserWindow && existing.browserWindow.activate) {
          existing.browserWindow.activate();
        }
      } catch (e) { /* ignore */ }
      var opening = openedPages.filter(function (entry) { return entry.tab === existing; })[0];
      return opening ? opening.pending : Promise.resolve(existing);
    }
    var w = app.activeBrowserWindow || app.openBrowserWindow();
    var t = w.openTab("foreground");
    var entry = { url: page, tab: t };
    entry.pending = navigateTab(t, url).then(function () { return t; }).catch(function (error) {
      openedPages = openedPages.filter(function (other) { return other !== entry; });
      throw error;
    });
    openedPages.push(entry);
    return entry.pending;
  }

  // ------------------------------------------------------------------ //
  // Storage
  // ------------------------------------------------------------------ //
  // IndexedDB on the global page is the default backend: it holds as much as
  // the bundle's database quota allows, where localStorage stops at about
  // five megabytes. Its contents are read into memory once, so reads answer
  // at once, and changes are written in batches; values an earlier version
  // kept in localStorage move into it. `settings` writes through to Safari's
  // extension settings, which survives a website-data reset but is meant for
  // small values.
  var STORAGE_DATABASE = "wex-storage";
  var STORAGE_ITEMS = "items";

  function indexedDbBackend(prefix) {
    // Taken now, as a sandbox the extension loads may take the globals away.
    var KeyRange = g.IDBKeyRange;
    var oldStore = WEX.localStorageOf(g);
    var data = Object.create(null);
    var pending = Object.create(null);
    // Why each key's latest change could not be saved.
    var failed = Object.create(null);
    var db = null;
    var writes = Promise.resolve();

    function saveInOneTransaction(batch, keys) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORAGE_ITEMS, "readwrite");
        var store = tx.objectStore(STORAGE_ITEMS);
        keys.forEach(function (k) {
          if (batch[k] === null) {
            store.delete(prefix + k);
          } else {
            store.put(batch[k], prefix + k);
          }
        });
        tx.oncomplete = function () { resolve(); };
        tx.onerror = tx.onabort = function () {
          reject(tx.error || new Error("the change could not be saved"));
        };
      });
    }

    // Saves the changes made so far together. When that fails each is tried
    // alone, so that one that cannot be saved costs the others nothing, and
    // the call that made it hears why. This never rejects.
    function write() {
      var keys = Object.keys(pending);
      if (!db || !keys.length) {
        return Promise.resolve();
      }
      var batch = pending;
      pending = Object.create(null);
      function saved() {
        keys.forEach(function (k) {
          delete failed[k];
        });
      }
      return saveInOneTransaction(batch, keys).then(saved, function (error) {
        if (keys.length === 1) {
          failed[keys[0]] = error;
          return undefined;
        }
        return keys.reduce(function (previous, k) {
          return previous.then(function () {
            return saveInOneTransaction(batch, [k]);
          }).then(function () {
            delete failed[k];
          }, function (alone) {
            failed[k] = alone;
          });
        }, Promise.resolve());
      });
    }

    // Values the localStorage backend kept, which free its quota once here.
    function adoptLocalStorage() {
      try {
        var store = oldStore;
        var found = [];
        for (var i = 0; i < store.length; i++) {
          var key = store.key(i);
          if (key.indexOf(prefix) === 0) {
            found.push(key);
          }
        }
        found.forEach(function (key) {
          var k = key.slice(prefix.length);
          if (!(k in data)) {
            data[k] = pending[k] = store.getItem(key);
          }
        });
        if (found.length) {
          writes = writes.then(write).then(function () {
            found.forEach(function (key) {
              if (!(key.slice(prefix.length) in failed)) {
                store.removeItem(key);
              }
            });
          });
        }
      } catch (e) { /* nothing to adopt */ }
    }

    var ready = new Promise(function (resolve) {
      var request;
      try {
        request = g.indexedDB.open(STORAGE_DATABASE, 1);
      } catch (e) {
        log.warn("IndexedDB is unavailable; storage will not persist across restarts");
        resolve();
        return;
      }
      request.onupgradeneeded = function () {
        request.result.createObjectStore(STORAGE_ITEMS);
      };
      request.onerror = function () {
        log.warn("IndexedDB could not be opened; storage will not persist across restarts");
        resolve();
      };
      request.onsuccess = function () {
        db = request.result;
        var tx = db.transaction(STORAGE_ITEMS, "readonly");
        var cursor = tx.objectStore(STORAGE_ITEMS)
          .openCursor(KeyRange.bound(prefix, prefix + "\uffff"));
        cursor.onsuccess = function () {
          var at = cursor.result;
          if (at) {
            data[String(at.key).slice(prefix.length)] = at.value;
            at["continue"]();
          }
        };
        tx.oncomplete = function () {
          adoptLocalStorage();
          resolve();
        };
        tx.onerror = function () {
          resolve();
        };
      };
    });

    return {
      ready: ready,
      keys: function () {
        return Object.keys(data);
      },
      get: function (k) {
        return k in data ? data[k] : null;
      },
      set: function (k, v) {
        data[k] = pending[k] = v;
      },
      remove: function (k) {
        delete data[k];
        pending[k] = null;
      },
      // Settles once every change so far has been tried, and rejects if one
      // of `keys` could not be saved.
      flush: function (keys) {
        writes = writes.then(write, write);
        return writes.then(function () {
          var unsaved = (keys || []).filter(function (k) {
            return k in failed;
          })[0];
          if (unsaved !== undefined) {
            throw failed[unsaved];
          }
        });
      }
    };
  }

  function localStorageBackend(prefix) {
    var store = WEX.localStorageOf(g);
    return {
      keys: function () {
        var out = [];
        for (var i = 0; i < store.length; i++) {
          var k = store.key(i);
          if (k.indexOf(prefix) === 0) {
            out.push(k.slice(prefix.length));
          }
        }
        return out;
      },
      get: function (k) {
        return store.getItem(prefix + k);
      },
      set: function (k, v) {
        store.setItem(prefix + k, v);
      },
      remove: function (k) {
        store.removeItem(prefix + k);
      }
    };
  }

  function settingsBackend(settings, prefix) {
    return {
      keys: function () {
        var out = [];
        for (var i = 0; i < settings.length; i++) {
          var k = settings.key(i);
          if (k.indexOf(prefix) === 0) {
            out.push(k.slice(prefix.length));
          }
        }
        return out;
      },
      get: function (k) {
        var v = settings.getItem(prefix + k);
        return v == null ? null : v;
      },
      set: function (k, v) {
        settings.setItem(prefix + k, v);
      },
      remove: function (k) {
        settings.removeItem(prefix + k);
      }
    };
  }

  function memoryBackend() {
    var data = Object.create(null);
    return {
      keys: function () {
        return Object.keys(data);
      },
      get: function (k) {
        return k in data ? data[k] : null;
      },
      set: function (k, v) {
        data[k] = v;
      },
      remove: function (k) {
        delete data[k];
      }
    };
  }

  var storageOnChanged = new Event("storage.onChanged");

  // A lone surrogate counts as the three bytes of the replacement character.
  function utf8Length(text) {
    var bytes = 0;
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (c < 0x80) {
        bytes += 1;
      } else if (c < 0x800) {
        bytes += 2;
      } else if (c >= 0xd800 && c < 0xdc00 && i + 1 < text.length &&
          text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) < 0xe000) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    }
    return bytes;
  }

  function makeStorageArea(backend, areaName) {
    function read(k) {
      var raw = backend.get(k);
      if (raw == null) {
        return undefined;
      }
      try {
        return JSON.parse(raw);
      } catch (e) {
        return raw;
      }
    }

    function selected(query) {
      if (query == null) {
        return backend.keys();
      }
      if (typeof query === "string") {
        return [query];
      }
      if (Array.isArray(query)) {
        return query;
      }
      return Object.keys(query);
    }

    // A change must reach both the area's own onChanged and the aggregate
    // chrome.storage.onChanged; a removal reports only an oldValue.
    function announce(changes) {
      if (!Object.keys(changes).length) {
        return;
      }
      area.onChanged.emit(changes);
      storageOnChanged.emit(changes, areaName);
    }

    // A backend that loads its contents first, and saves them after, is
    // waited for.
    function whenReady(fn) {
      return backend.ready ? backend.ready.then(fn) : fn();
    }

    function saved(changes, cb) {
      var saving = backend.flush ? backend.flush(Object.keys(changes)) : Promise.resolve();
      return settle(saving.then(function () {
        announce(changes);
      }, function (e) {
        announce(changes);
        throw new Error("storage quota exceeded: " + (e && e.message ? e.message : e));
      }), cb);
    }

    var area = {
      QUOTA_BYTES: 104857600,
      QUOTA_BYTES_PER_ITEM: 104857600,
      MAX_ITEMS: 1000000,
      onChanged: new Event("storage." + areaName + ".onChanged"),

      get: function (query, cb) {
        return whenReady(function () {
          var result = {};
          var defaults = (query && typeof query === "object" && !Array.isArray(query)) ? query : null;
          selected(query).forEach(function (k) {
            var v = read(k);
            if (v !== undefined) {
              result[k] = v;
            } else if (defaults && k in defaults) {
              result[k] = defaults[k];
            }
          });
          return done(cb, result);
        });
      },

      set: function (items, cb) {
        // The values as they are now, as a browser takes them during the
        // call: the caller is free to change its objects once it returns. A
        // value JSON leaves out of an object, as undefined or a function, is
        // left out of the call, as Chrome leaves it.
        var entries = [];
        var unreadable = null;
        try {
          Object.keys(items || {}).forEach(function (k) {
            var json = JSON.stringify(items[k]);
            if (json !== undefined) {
              entries.push({ key: k, json: json });
            }
          });
        } catch (e) {
          unreadable = e;
        }
        return whenReady(function () {
          var changes = {};
          try {
            entries.forEach(function (entry) {
              var k = entry.key;
              // Chrome reports, and writes, only a value that differs from
              // the one kept, where Firefox reports every value set.
              if (!CONFIG.firefoxBuild && backend.get(k) === entry.json) {
                return;
              }
              var oldValue = read(k);
              backend.set(k, entry.json);
              changes[k] = { newValue: JSON.parse(entry.json) };
              if (oldValue !== undefined) {
                changes[k].oldValue = oldValue;
              }
            });
            if (unreadable) {
              throw unreadable;
            }
          } catch (e) {
            announce(changes);
            return WEX.fail(cb, "storage quota exceeded: " + (e && e.message ? e.message : e));
          }
          return saved(changes, cb);
        });
      },

      remove: function (query, cb) {
        var keys = Array.isArray(query) ? query.slice() : [query];
        return whenReady(function () {
          var changes = {};
          // Only a key that has a value is reported removed.
          keys.forEach(function (k) {
            var oldValue = read(k);
            if (oldValue !== undefined) {
              changes[k] = { oldValue: oldValue };
            }
            backend.remove(k);
          });
          return saved(changes, cb);
        });
      },

      clear: function (cb) {
        return whenReady(function () {
          var changes = {};
          backend.keys().forEach(function (k) {
            changes[k] = { oldValue: read(k) };
            backend.remove(k);
          });
          return saved(changes, cb);
        });
      },

      // Chrome counts each of the keys asked about that has a value, all of
      // them for null, as the UTF-8 bytes of the key and of the value's JSON.
      getBytesInUse: function (query, cb) {
        if (typeof query === "function") {
          cb = query;
          query = null;
        }
        return whenReady(function () {
          var total = 0;
          selected(query).forEach(function (k) {
            var raw = backend.get(k);
            if (raw != null) {
              total += utf8Length(String(k)) + utf8Length(String(raw));
            }
          });
          return done(cb, total);
        });
      },

      getKeys: function (cb) {
        return whenReady(function () {
          return done(cb, backend.keys());
        });
      },

      setAccessLevel: function (_, cb) {
        return done(cb);
      }
    };
    return area;
  }

  function chooseBackend(areaName) {
    var kind = CONFIG.storage || "local";
    var prefix = "wex." + areaName + ".";
    if (kind === "settings") {
      var settings = ext.secureSettings || ext.settings;
      if (settings) {
        return settingsBackend(settings, prefix);
      }
      log.warn("safari.extension.settings is unavailable; storage falls back to localStorage");
    }
    try {
      if (g.indexedDB && g.IDBKeyRange) {
        return indexedDbBackend(prefix);
      }
    } catch (e) { /* fall through */ }
    try {
      if (WEX.localStorageOf(g)) {
        return localStorageBackend(prefix);
      }
    } catch (e) { /* fall through */ }
    log.warn("localStorage is unavailable; storage will not persist across restarts");
    return memoryBackend();
  }

  // ------------------------------------------------------------------ //
  // Toolbar item, badge and popover
  // ------------------------------------------------------------------ //
  function toolbarItems() {
    try {
      return ext.toolbarItems || [];
    } catch (e) {
      return [];
    }
  }

  function popoverEl() {
    try {
      var list = ext.popovers || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i].identifier === CONFIG.popoverId) {
          return list[i];
        }
      }
      // The side panel's popover is not the popup's.
      return list.filter(function (p) {
        return p.identifier !== WEX.SIDE_PANEL_POPOVER;
      })[0] || null;
    } catch (e) {
      return null;
    }
  }

  var tabBadges = {};
  var globalBadge = "";
  // The badge colors the extension sets, for the whole toolbar item and by
  // tab, which Safari's badge does not take: it is drawn in Safari's colors,
  // and its text is white.
  var badgeColors = { background: { __global: [0, 0, 0, 255] }, text: { __global: [255, 255, 255, 255] } };

  function colorArray(color) {
    if (Array.isArray(color)) {
      return color.slice(0, 4).map(Number);
    }
    var canvas = g.document.createElement("canvas");
    canvas.width = canvas.height = 1;
    var context = canvas.getContext("2d");
    context.fillStyle = String(color);
    context.fillRect(0, 0, 1, 1);
    return Array.prototype.slice.call(context.getImageData(0, 0, 1, 1).data);
  }

  function setBadgeColor(kind, details, cb) {
    var d = details || {};
    badgeColors[kind][d.tabId != null ? d.tabId : "__global"] = colorArray(d.color);
    return done(cb);
  }

  function badgeColor(kind, details, cb) {
    var d = details || {};
    var colors = badgeColors[kind];
    return done(cb, (d.tabId != null && colors[d.tabId]) || colors.__global);
  }
  var tabTitles = {};
  var tabIcons = {};
  var DECLARED_POPUP = CONFIG.popupPage || null;
  // What the bundle declares for the toolbar item, which it shows on a tab
  // with nothing set for it when nothing is set for every tab.
  var declaredToolbar = null;

  function rememberDeclaredToolbar() {
    var item = declaredToolbar ? null : toolbarItems()[0];
    if (item) {
      declaredToolbar = { title: item.toolTip, icon: item.image };
    }
  }

  rememberDeclaredToolbar();

  // The popup set for a tab alone: a bundle path, or "" for none.
  var tabPopups = {};
  var actionDisabled = false;
  // Whether the action is enabled on a tab, where the extension says so for
  // that tab alone; and the tabs whose page a declarativeContent rule shows
  // the action on, whatever else is set.
  var tabActionEnabled = {};
  var declaredShown = {};

  function actionEnabledFor(id) {
    if (id != null && declaredShown[id]) {
      return true;
    }
    return id != null && tabActionEnabled[id] != null ? tabActionEnabled[id] : !actionDisabled;
  }

  // action.enable and disable, for a tab or for every tab.
  function setActionEnabled(enabled) {
    return function (tabId, cb) {
      if (typeof tabId === "function") {
        cb = tabId;
        tabId = undefined;
      }
      if (typeof tabId === "number") {
        tabActionEnabled[tabId] = enabled;
      } else {
        actionDisabled = !enabled;
      }
      refreshToolbar();
      return done(cb);
    };
  }

  // The bundle path of the popup a tab shows, or "" for none.
  function popupFor(id) {
    return id != null && tabPopups[id] != null ? tabPopups[id] : CONFIG.popupPage || "";
  }


  // Safari toolbar badges hold a number and there is one per toolbar item, so
  // the active tab's badge is the one on show. A non-numeric Chrome badge (a
  // dot, a "!") has no numeric equivalent; show 1 so the marker is at least
  // visible.
  function badgeNumber(text) {
    if (!text) {
      return 0;
    }
    var n = parseInt(text, 10);
    return isNaN(n) ? 1 : n;
  }

  function stateForTab(store, id) {
    return (id != null && store[id] != null) ? store[id] : store.__global;
  }

  // There is one toolbar item per browser window, and each shows the state
  // of its own window's active tab.
  function refreshToolbar() {
    rememberDeclaredToolbar();
    var declared = declaredToolbar || {};
    toolbarItems().forEach(function (item) {
      var t = null;
      try {
        t = item.browserWindow ? item.browserWindow.activeTab : activeTab();
      } catch (e) { /* ignore */ }
      var id = t ? idForTab(t) : null;
      var badge = (id != null && tabBadges[id] != null) ? tabBadges[id] : globalBadge;
      var title = stateForTab(tabTitles, id);
      var icon = stateForTab(tabIcons, id) || declared.icon;
      if (title == null) {
        title = declared.title;
      }
      try {
        item.badge = badgeNumber(badge);
      } catch (e) { /* ignore */ }
      try {
        if (title != null && item.toolTip !== title) {
          item.toolTip = title;
        }
      } catch (e) { /* ignore */ }
      try {
        if (icon && item.image !== icon) {
          item.image = icon;
        }
      } catch (e) { /* ignore */ }
      try {
        item.disabled = !actionEnabledFor(id);
      } catch (e) { /* ignore */ }
      // The side panel's popover stays while it shows.
      if (openPanel && openPanel.window === item.browserWindow) {
        return;
      }
      fitToPopup(item, popupFor(id) ? popoverFor(popupFor(id)) : clickPanelPopover(id));
    });
  }

  // A toolbar item carries a popover or a native extension menu, not both.
  // Safari shows an item's menu as its button is pressed, as a pop-up
  // button's, and then reports no command for the click. So a click does
  // what Chrome's left click does: it shows the popup, or is reported as
  // action.onClicked. The menu of the extension's action-context items, which
  // Chrome shows on a right click, is the item's only where a click has
  // nothing else to do. A window opened later has the item the bundle
  // declares until it is brought in line.
  function fitToPopup(item, po) {
    try {
      var clicked = typeof actionOnClicked !== "undefined" && actionOnClicked && actionOnClicked.listeners.length > 0;
      if (po) {
        if (item.menu) {
          item.menu = null;
        }
        if (item.popover !== po) {
          item.popover = po;
        }
        return;
      }
      var menu = clicked ? null : nativeActionMenuForToolbar(item);
      if (item.popover) {
        item.popover = null;
      }
      if (item.menu !== menu) {
        item.menu = menu;
      }
      if (item.command !== CONFIG.actionCommand) {
        item.command = CONFIG.actionCommand;
      }
    } catch (e) {
      note("could not change what the toolbar item does: " +
        (e && e.message ? e.message : e));
    }
  }

  function popoverShow() {
    var items = toolbarItems();
    for (var i = 0; i < items.length; i++) {
      try {
        if (items[i].showPopover) {
          items[i].showPopover();
          return true;
        }
      } catch (e) { /* try the next one */ }
    }
    return false;
  }

  // The popover, made if there is none yet. One popover serves every tab:
  // it rests on a blank page, and is taken to the popup of the tab it opens
  // over just before it shows, so that, as in a browser, none of the popup
  // runs until it is opened.
  function popoverFor(path) {
    var po = popoverEl();
    if (po) {
      return po;
    }
    try {
      return ext.createPopover(CONFIG.popoverId, WEX.extUrl(WEX.POPUP_PLACEHOLDER),
        CONFIG.popupWidth || 400, CONFIG.popupHeight || 560);
    } catch (e) {
      note("could not make a popover for " + path + ": " + (e && e.message ? e.message : e));
      return null;
    }
  }

  function setPopupPage(path) {
    CONFIG.popupPage = path || null;
    if (path) {
      popoverFor(path);
    }
    refreshToolbar();
  }

  // A browser closes the popup's document when the popup closes, which ends
  // its timers and disconnects its ports. Once the popover has shown and
  // hidden again, it goes back to its blank page.
  var popupWatch = null;

  function wantedPopoverForToolbar(item) {
    var win = item && item.browserWindow;
    var tab = win && win.activeTab;
    var id = tab ? idForTab(tab) : null;
    var path = popupFor(id);
    return path ? popoverFor(path) : clickPanelPopover(id);
  }

  function showToolbarPopover(item) {
    var po = wantedPopoverForToolbar(item) || (item && item.popover);
    if (!item || !po) {
      return false;
    }
    try {
      if (item.menu) {
        item.menu = null;
      }
      item.popover = po;
      item.showPopover();
      return true;
    } catch (e) {
      return false;
    }
  }

  function watchPopupClose(po) {
    if (popupWatch) {
      clearInterval(popupWatch);
    }
    var shown = false;
    popupWatch = setInterval(function () {
      var visible = false;
      try {
        visible = !!po.visible;
      } catch (e) { /* closing */ }
      if (visible) {
        shown = true;
        return;
      }
      if (!shown) {
        return;
      }
      clearInterval(popupWatch);
      popupWatch = null;
      try {
        po.contentWindow.location.replace(WEX.extUrl(WEX.POPUP_PLACEHOLDER));
      } catch (e) { /* the popover went away */ }
    }, 400);
  }

  // ------------------------------------------------------------------ //
  // The side panel
  // ------------------------------------------------------------------ //
  // Safari has no side panel. The extension's shows in a popover of its
  // toolbar button, tall and narrow as Chrome's panel is, beside the page it
  // is for. Its behavior and its default options outlast a restart, as
  // Chrome keeps them.
  var SIDE_PANEL_KEY = "wex.sidePanel";
  var SIDE_PANEL_WIDTH = 360;
  var sidePanelOnOpened = new Event("sidePanel.onOpened");
  var sidePanelOnClosed = new Event("sidePanel.onClosed");
  var panelDefaults = {
    path: String((((CONFIG.manifest || {}).side_panel || {}).default_path) || "").replace(/^\/+/, "") || null,
    enabled: true
  };
  var panelTabs = {};
  var panelBehavior = { openPanelOnActionClick: false };
  var openPanel = null;

  (function loadPanel() {
    try {
      var kept = JSON.parse(settingsItem(SIDE_PANEL_KEY) || "null");
      if (kept) {
        panelBehavior.openPanelOnActionClick = !!kept.openPanelOnActionClick;
        if (kept.defaults) {
          panelDefaults = kept.defaults;
        }
      }
    } catch (e) { /* the manifest's */ }
  })();

  function savePanel() {
    settingsItem(SIDE_PANEL_KEY, JSON.stringify({
      openPanelOnActionClick: panelBehavior.openPanelOnActionClick, defaults: panelDefaults
    }));
  }

  // The panel a tab shows: its own options, or the extension's defaults.
  function panelFor(tabId) {
    var own = tabId != null ? panelTabs[tabId] : null;
    return {
      path: own && own.path != null ? own.path : panelDefaults.path,
      enabled: (own && own.enabled != null ? own.enabled : panelDefaults.enabled) !== false,
      tabSpecific: !!(own && own.path != null)
    };
  }

  function panelPopover(path) {
    var url = WEX.extUrl(path);
    var po = null;
    try {
      (ext.popovers || []).forEach(function (p) {
        if (p.identifier === WEX.SIDE_PANEL_POPOVER) {
          po = p;
        }
      });
    } catch (e) { /* none yet */ }
    if (!po) {
      var height = 640;
      try {
        height = Math.max(400, Math.min(900, (g.screen.availHeight || 760) - 140));
      } catch (e) { /* the default */ }
      try {
        po = ext.createPopover(WEX.SIDE_PANEL_POPOVER, url, SIDE_PANEL_WIDTH, height);
      } catch (e) {
        note("could not make the side panel's popover: " + (e && e.message ? e.message : e));
        return null;
      }
    } else if (String(po.contentURL || "") !== url) {
      try {
        po.contentURL = url;
      } catch (e) { /* it keeps its page */ }
    }
    return po;
  }

  // The panel the toolbar button shows when clicked in a tab, if the
  // extension asked for that and the tab has an enabled panel.
  function clickPanelPopover(tabId) {
    var panel = panelFor(tabId);
    return panelBehavior.openPanelOnActionClick && panel.enabled && panel.path ?
      panelPopover(panel.path) : null;
  }

  function panelShown(po, w) {
    if (openPanel && openPanel.popover === po) {
      return;
    }
    var t = w && w.activeTab;
    var tabId = t ? idForTab(t) : undefined;
    var panel = panelFor(tabId);
    var info = { windowId: windowIdFor(w), path: panel.path };
    if (panel.tabSpecific) {
      info.tabId = tabId;
    }
    var context = extensionContext("SIDE_PANEL", WEX.extUrl(panel.path));
    context.windowId = info.windowId;
    context.tabId = panel.tabSpecific ? tabId : -1;
    openPanel = { popover: po, window: w, info: info, context: context };
    sidePanelOnOpened.emit(info);
    var watch = setInterval(function () {
      var visible = true;
      try {
        visible = !!po.visible;
      } catch (e) {
        visible = false;
      }
      if (!visible) {
        clearInterval(watch);
        var closed = openPanel;
        openPanel = null;
        if (closed) {
          sidePanelOnClosed.emit(closed.info);
        }
        refreshToolbar();
      }
    }, 400);
  }

  function itemForWindow(w) {
    return toolbarItems().filter(function (item) {
      return item.browserWindow === w;
    })[0] || null;
  }

  // Shows the panel of `tabId`, or of window `w`'s active tab, by its
  // toolbar button. Returns Chrome's error when there is none to show.
  function showPanel(w, tabId) {
    var t = tabId != null ? tabForId(tabId) : w && w.activeTab;
    var id = t ? idForTab(t) : tabId;
    var panel = panelFor(id);
    if (!panel.enabled || !panel.path) {
      return tabId != null ? "No active side panel for tabId: " + tabId :
        "No active side panel for windowId: " + windowIdFor(w);
    }
    var win = w || (t && t.browserWindow) || app.activeBrowserWindow;
    var item = itemForWindow(win);
    var po = panelPopover(panel.path);
    if (!item || !po) {
      return "No browser window for " + (tabId != null ? "tabId: " + tabId : "windowId: " + windowIdFor(win));
    }
    try {
      if (item.popover !== po) {
        item.command = null;
        item.popover = po;
      }
      item.showPopover();
    } catch (e) {
      return "No browser window for windowId: " + windowIdFor(win);
    }
    panelShown(po, win);
    return null;
  }

  function hidePanel() {
    if (openPanel) {
      try {
        openPanel.popover.hide();
      } catch (e) { /* closing already */ }
    }
  }

  // Brings the panel on show in line with the options of the tab it shows
  // over, which is what Chrome's follows: it closes when that tab's panel is
  // disabled, and goes to the panel's new page when that has changed.
  function followOptions() {
    if (!openPanel) {
      return;
    }
    var shownTab = openPanel.window && openPanel.window.activeTab;
    var id = shownTab ? idForTab(shownTab) : null;
    var panel = panelFor(id);
    if (!panel.enabled) {
      hidePanel();
      return;
    }
    if (!panel.path || panel.path === openPanel.info.path) {
      return;
    }
    openPanel.info.path = panel.path;
    if (panel.tabSpecific) {
      openPanel.info.tabId = id;
    } else {
      delete openPanel.info.tabId;
    }
    openPanel.context.documentUrl = WEX.extUrl(panel.path);
    openPanel.context.tabId = panel.tabSpecific ? id : -1;
    var po = panelPopover(panel.path);
    try {
      var page = po && po.contentWindow;
      if (page && page.location) {
        page.location.replace(WEX.extUrl(panel.path));
      }
    } catch (e) { /* the popover can be closing */ }
  }

  // Whether the panel's page at `href` is the page `url` names: the same
  // file, with every query parameter of `url` at the same value. A panel can
  // name the tab it is for in its query, and can add its own parameters to
  // the address once it has loaded.
  function onPanelPage(href, url) {
    var parts = function (u) {
      var s = String(u || "").split("#")[0];
      var q = s.indexOf("?");
      var params = {};
      (q < 0 ? "" : s.slice(q + 1)).split("&").forEach(function (pair) {
        if (pair) {
          var eq = pair.indexOf("=");
          params[eq < 0 ? pair : pair.slice(0, eq)] = eq < 0 ? "" : pair.slice(eq + 1);
        }
      });
      return { file: q < 0 ? s : s.slice(0, q), params: params };
    };
    var page = parts(href);
    var wanted = parts(url);
    return page.file === wanted.file && Object.keys(wanted.params).every(function (k) {
      return page.params[k] === wanted.params[k];
    });
  }

  function makeSidePanel() {
    var windowOrTab = function (options, cb, act) {
      var o = options || {};
      if (o.tabId == null && o.windowId == null) {
        return WEX.fail(cb, "At least one of `tabId` and `windowId` must be provided");
      }
      if (o.tabId != null && !tabForId(o.tabId)) {
        return WEX.fail(cb, "No tab with id: " + o.tabId + ".");
      }
      var w = o.windowId != null ? windowForId(o.windowId) : null;
      if (o.windowId != null && !w) {
        return WEX.fail(cb, "No window with id: " + o.windowId + ".");
      }
      var error = act(o, w);
      return error ? WEX.fail(cb, error) : done(cb);
    };
    return {
      onOpened: sidePanelOnOpened,
      onClosed: sidePanelOnClosed,
      setOptions: function (options, cb) {
        var o = options || {};
        if (o.tabId != null && !tabForId(o.tabId)) {
          return WEX.fail(cb, "No tab with id: " + o.tabId + ".");
        }
        var target = o.tabId != null ? (panelTabs[o.tabId] = panelTabs[o.tabId] || {}) : panelDefaults;
        if (o.path != null) {
          target.path = String(o.path).replace(/^\/+/, "");
        }
        if (o.enabled != null) {
          target.enabled = !!o.enabled;
        }
        if (o.tabId == null) {
          savePanel();
        }
        followOptions();
        refreshToolbar();
        return done(cb);
      },
      getOptions: function (options, cb) {
        var c = WEX.shiftCallback(options, cb);
        var panel = panelFor(c.opts.tabId);
        var out = { enabled: panel.enabled };
        if (panel.path) {
          out.path = panel.path;
        }
        if (c.opts.tabId != null) {
          out.tabId = c.opts.tabId;
        }
        return done(c.cb, out);
      },
      setPanelBehavior: function (behavior, cb) {
        if (behavior && behavior.openPanelOnActionClick != null) {
          panelBehavior.openPanelOnActionClick = !!behavior.openPanelOnActionClick;
          savePanel();
          refreshToolbar();
        }
        return done(cb);
      },
      getPanelBehavior: function (cb) {
        return done(cb, { openPanelOnActionClick: panelBehavior.openPanelOnActionClick });
      },
      getLayout: function (cb) {
        return done(cb, { side: "right" });
      },
      open: function (options, cb) {
        return windowOrTab(options, cb, function (o, w) {
          var error = showPanel(w, o.tabId);
          if (!error) {
            openedPanel = { window: w || app.activeBrowserWindow, tabId: o.tabId };
          }
          return error;
        });
      },
      close: function (options, cb) {
        return windowOrTab(options, cb, function (o, w) {
          if (!openPanel) {
            return null;
          }
          if (o.tabId != null) {
            if (openPanel.info.tabId !== o.tabId) {
              return "No active tab-specific side panel for tabId: " + o.tabId;
            }
          } else if (openPanel.window !== w) {
            return "No active side panel for windowId: " + o.windowId;
          }
          openedPanel = null;
          hidePanel();
          return null;
        });
      }
    };
  }

  // The rules that change response headers, which the global page applies
  // (WEX.installResponseHeaderRules), read again after any change to the
  // rules, here or in one of the extension's pages.
  var refreshResponseRules = function () {};

  // A popover takes the keyboard from the page it opens over, where Chrome's
  // popup and side panel leave it, and the click on the page that hides the
  // popover is one that brings the page's window back to the front: Safari
  // gives the page its mousedown and mouseup, and none of the mousemoves of
  // a drag that click starts. While one of the extension's popovers shows,
  // the bridge in the page it opens over watches for that click, gives the
  // page the move to where the drag ended, as Chrome would have, and says
  // whether it was a drag. A side panel the extension opened itself, as one
  // that shows the result of something the user is to do on the page, shows
  // again after the drag that hid it, as Chrome's stays open beside the page.
  var openedPanel = null;

  function watchPageUnderPopover(w, isPanel) {
    var tab = w && w.activeTab;
    var tabId = tab ? idForTab(tab) : null;
    if (tabId == null || !native.tabs || typeof native.tabs.connect !== "function") {
      return;
    }
    var port;
    try {
      port = native.tabs.connect(tabId, { name: WEX.INTERNAL_PORT + "popover-focus", frameId: 0 });
    } catch (e) {
      return;
    }
    port.onMessage.addListener(function (m) {
      if (!isPanel || !m || !m.activation) {
        return;
      }
      var reopen = openedPanel;
      openedPanel = null;
      var showing = false;
      try {
        showing = !!(openPanel && openPanel.popover.visible);
      } catch (e) { /* it is hidden */ }
      if (!reopen || !m.dragged || showing) {
        return;
      }
      var error = showPanel(reopen.window, reopen.tabId);
      if (error) {
        note("could not show the side panel again: " + error);
      }
    });
  }

  // ------------------------------------------------------------------ //
  // Web pages the extension lets in
  // ------------------------------------------------------------------ //
  // A page the manifest's `externally_connectable` matches messages the
  // extension through its content side, or, in a frame of one of the
  // extension's pages outside a tab, through that page. Its messages and
  // ports reach onMessageExternal and onConnectExternal beside those of
  // other extensions, which the engine delivers, from a web page's sender:
  // no id, the page's address and origin, and its tab, where it has one.
  var PAGE_UNREACHABLE = "Could not establish connection. Receiving end does not exist.";
  var pageMessages = new Event("runtime.onMessageExternal");
  var pageConnections = new Event("runtime.onConnectExternal");

  function alsoFromPages(engineEvent, pageEvent) {
    return {
      addListener: function (fn) {
        engineEvent.addListener.apply(engineEvent, arguments);
        pageEvent.addListener(fn);
      },
      removeListener: function (fn) {
        engineEvent.removeListener(fn);
        pageEvent.removeListener(fn);
      },
      hasListener: function (fn) {
        return pageEvent.hasListener(fn);
      },
      hasListeners: function () {
        return pageEvent.hasListeners();
      }
    };
  }

  // A site in a frame of one of the extension's pages outside a tab, whose
  // requests that page carries (wex-page.js), is described as Chrome
  // describes a frame of an extension page: by its address and origin, with
  // no tab. Null when what carries the requests is not such a page.
  function framedSender(site, sender) {
    if (typeof site !== "string" || !sender || sender.tab || !WEX.isExtUrl(String(sender.url || ""))) {
      return null;
    }
    return { url: site };
  }

  // The sender of a page the manifest lets in, or null for any other.
  function pageSender(sender) {
    var allowed = (CONFIG.manifest || {}).externally_connectable;
    var url = String(sender && sender.url || "");
    if (!allowed || !allowed.matches || !WEX.matchesAny(url, allowed.matches)) {
      return null;
    }
    var s = WEX.describeSender(sender, true);
    delete s.id;
    var origin = /^[a-z][a-z0-9+.\-]*:\/\/[^\/]*/i.exec(url);
    s.origin = origin ? origin[0] : "null";
    return s;
  }

  // Chrome's delivery of one message: the first sendResponse answers it, and
  // a listener that returns true or a promise keeps it waiting.
  function deliverPageMessage(message, sender) {
    var from = pageSender(sender);
    var listeners = pageMessages.listeners.slice();
    if (!from || !listeners.length) {
      return Promise.resolve({ error: PAGE_UNREACHABLE });
    }
    return new Promise(function (resolve) {
      var answered = false;
      var waiting = false;
      var sendResponse = function (value) {
        if (!answered) {
          answered = true;
          resolve({ response: value });
        }
      };
      listeners.forEach(function (fn) {
        var result;
        try {
          result = fn(message, from, sendResponse);
        } catch (e) {
          log.error("listener for runtime.onMessageExternal threw", e);
        }
        if (result === true) {
          waiting = true;
        } else if (result && typeof result.then === "function") {
          waiting = true;
          result.then(sendResponse, function (e) {
            if (!answered) {
              answered = true;
              resolve({ error: e && e.message ? e.message : String(e) });
            }
          });
        }
      });
      if (!answered && !waiting) {
        answered = true;
        resolve({ closed: true });
      }
    });
  }

  function connectPage(port, sender, name) {
    var from = pageSender(sender);
    if (!from || !pageConnections.hasListeners()) {
      try {
        port.postMessage({ error: PAGE_UNREACHABLE });
      } catch (e) { /* gone already */ }
      port.disconnect();
      return;
    }
    var open = true;
    var external = {
      name: name,
      sender: from,
      onMessage: new Event("port.onMessage"),
      onDisconnect: new Event("port.onDisconnect"),
      postMessage: function (message) {
        if (!open) {
          throw new Error("Attempting to use a disconnected port object");
        }
        port.postMessage({ message: message });
      },
      disconnect: function () {
        if (open) {
          open = false;
          port.disconnect();
        }
      }
    };
    port.onMessage.addListener(function (m) {
      external.onMessage.emit(m && m.message, external);
    });
    port.onDisconnect.addListener(function () {
      if (open) {
        open = false;
        external.onDisconnect.emit(external);
      }
    });
    pageConnections.emit(external);
  }

  // ------------------------------------------------------------------ //
  // The debugger
  // ------------------------------------------------------------------ //
  // Chrome's debugger speaks the Chrome DevTools Protocol with a tab, and
  // WebKit speaks a protocol of its own. Each command is carried out by what
  // does the same here: WebKit's input from extensions for `Input`, the
  // engine's captures, tabs, navigation and network events for `Page` and
  // `Network`, and, for what only it can do, the tab's Web Inspector backend:
  // evaluating in the page's own world and reporting its console. A method
  // none of these carries out fails as Chrome fails one it does not have.
  var DEBUGGER_VERSIONS = ["1.0", "1.1", "1.2", "1.3"];
  var debuggerOnEvent = new Event("debugger.onEvent");
  var debuggerOnDetach = new Event("debugger.onDetach");
  var debuggees = {};
  var debugTargetIds = {};
  // The page a tab shows now, by the id an extension attached to it with.
  var movedDebuggees = {};
  var CDP_METHOD_NOT_FOUND = -32601;
  var CDP_INVALID_PARAMS = -32602;
  var CDP_SERVER_ERROR = -32000;

  function hostAqua() {
    try {
      return g.__wexAqua || g.aqua || null;
    } catch (e) {
      return null;
    }
  }

  // An error as Chrome reports a protocol error: the error object's JSON.
  function cdpError(code, message, data) {
    var body = { code: code };
    if (data !== undefined) {
      body.data = data;
    }
    body.message = message;
    return new Error(JSON.stringify(body));
  }

  function missingParam(name) {
    return cdpError(CDP_INVALID_PARAMS, "Invalid parameters",
      "Failed to deserialize params." + name + " - BINDINGS: mandatory field missing");
  }

  function debuggeeFormat(format, target) {
    var t = target || {};
    var kind = t.tabId != null ? "tab" : t.extensionId != null ? "background page" : "target";
    var id = t.tabId != null ? t.tabId : t.extensionId != null ? t.extensionId : t.targetId;
    return format.replace("*", kind).replace("*", String(id));
  }

  function targetIdForTab(tabId) {
    if (!debugTargetIds[tabId]) {
      var hex = "";
      for (var i = 0; i < 32; i++) {
        hex += "0123456789ABCDEF".charAt(Math.floor(Math.random() * 16));
      }
      debugTargetIds[tabId] = hex;
    }
    return debugTargetIds[tabId];
  }

  function tabIdForTarget(targetId) {
    var found = null;
    Object.keys(debugTargetIds).forEach(function (tabId) {
      if (debugTargetIds[tabId] === targetId) {
        found = Number(tabId);
      }
    });
    return found;
  }

  // The tab a debuggee names, or Chrome's error for it.
  function debuggeeTab(target) {
    var t = target || {};
    if (t.tabId == null && t.extensionId == null && t.targetId == null) {
      return { error: "Either tab id or extension id must be specified." };
    }
    var tabId = t.tabId != null ? Number(t.tabId) : t.targetId != null ? tabIdForTarget(t.targetId) : null;
    if (tabId != null && movedDebuggees[tabId] !== undefined) {
      tabId = movedDebuggees[tabId];
    }
    var tab = tabId != null ? tabForId(tabId) : null;
    if (!tab) {
      return { error: debuggeeFormat("No * with given id *.", t) };
    }
    return { tabId: tabId, tab: tab, name: t.tabId != null ? t : { tabId: tabId } };
  }

  // Chrome's ExtensionMayAttachToURL: a blank page, a web page, and the
  // extension's own pages; a browser page, another extension's page, and a
  // file the extension has no access to are refused.
  function debugUrlError(url) {
    var u = String(url == null ? "" : url);
    if (!u || /^about:(blank)?([#?]|$)/i.test(u) || /^(https?|data|blob):/i.test(u)) {
      return null;
    }
    if (/^safari-extension:/i.test(u)) {
      return u.indexOf(WEX.origin) === 0 ? null :
        "Cannot access a chrome-extension:// URL of different extension";
    }
    if (/^file:/i.test(u)) {
      return "Cannot navigate to a file URL without local file access.";
    }
    return "Cannot access a chrome:// URL";
  }

  // The session of an extension attached to a tab.
  function DebugSession(tabId) {
    this.tabId = tabId;
    this.debuggee = { tabId: tabId };
    this.enabled = {};
    this.queue = Promise.resolve();
    this.inspector = null;
    this.failPending = [];
    this.listeners = [];
    this.closed = false;
  }

  DebugSession.prototype.emit = function (method, params) {
    if (!this.closed) {
      debuggerOnEvent.emit({ tabId: this.debuggee.tabId }, method, params || {});
    }
  };

  // Commands that act on the page run in the order they are sent, as
  // Chrome's do.
  DebugSession.prototype.inOrder = function (fn) {
    var run = this.queue.then(fn, fn);
    this.queue = run.then(function () {}, function () {});
    return run;
  };

  DebugSession.prototype.listen = function (event, fn, filter, extra) {
    if (filter) {
      event.addListener(fn, filter, extra);
    } else {
      event.addListener(fn);
    }
    this.listeners.push({ event: event, fn: fn, filter: filter });
  };

  // WebKit has swapped in another page for the tab, whose id is `tabId`. In
  // Chrome a navigation leaves a tab its id and its debugger, so the session
  // goes on with the new page, and goes on telling the extension of the tab
  // by the id it attached with, which still names the tab in a call.
  DebugSession.prototype.moveTo = function (tabId) {
    var self = this;
    var inspector = inspectorSessions[self.tabId];
    if (inspector) {
      inspector.lost();
    }
    delete debuggees[self.tabId];
    self.tabId = tabId;
    debuggees[tabId] = self;
    movedDebuggees[self.debuggee.tabId] = tabId;
    if (self.watchingNetwork) {
      self.listeners = self.listeners.filter(function (l) {
        if (l.filter) {
          l.event.removeListener(l.fn);
        }
        return !l.filter;
      });
      self.watchingNetwork = false;
      self.watchNetwork();
    }
    if (self.enabled.Runtime || self.enabled.Log) {
      self.page().catch(function () {});
    }
  };

  DebugSession.prototype.close = function (reason) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    delete debuggees[this.tabId];
    delete movedDebuggees[this.debuggee.tabId];
    this.listeners.forEach(function (l) {
      try {
        l.event.removeListener(l.fn);
      } catch (e) { /* gone with the page */ }
    });
    this.failPending.slice().forEach(function (fail) {
      fail(new Error("Detached while handling command."));
    });
    if (this.inspector) {
      var aqua = hostAqua();
      var tabId = this.tabId;
      this.inspector.then(function (inspector) {
        if (inspector && !inspector.closed) {
          inspector.closed = true;
          delete inspectorSessions[tabId];
          aqua.inspector.detach(tabId).catch(function () {});
        }
      }, function () {});
    }
    if (reason) {
      debuggerOnDetach.emit({ tabId: this.debuggee.tabId }, reason);
    }
  };

  // ---- The Web Inspector backend ---------------------------------------
  // Attached when a command first needs it, and again after the user's own
  // Web Inspector has taken the tab and let it go.
  var inspectorSessions = {};
  var inspectorListening = false;

  function listenToInspector(aqua) {
    if (inspectorListening) {
      return;
    }
    inspectorListening = true;
    aqua.inspector.onMessage.addListener(function (tabId, text) {
      var inspector = inspectorSessions[tabId];
      if (inspector) {
        inspector.receive(JSON.parse(text));
      }
    });
    aqua.inspector.onDetach.addListener(function (tabId) {
      var inspector = inspectorSessions[tabId];
      if (inspector) {
        inspector.lost();
      }
    });
  }

  function InspectorSession(session) {
    this.session = session;
    this.tabId = session.tabId;
    this.nextId = 1;
    this.waiting = {};
    this.pageTarget = null;
    this.targets = {};
    this.closed = false;
    this.ready = null;
    this.onReady = null;
    this.onLost = null;
  }

  InspectorSession.prototype.receive = function (message) {
    var self = this;
    var params = message.params || {};
    // A command the backend could not hand to the page's target.
    if (message.id != null && message.error && self.waiting[message.id]) {
      var failed = self.waiting[message.id];
      delete self.waiting[message.id];
      failed.reject(cdpError(message.error.code || CDP_SERVER_ERROR, message.error.message));
      return;
    }
    switch (message.method) {
      case "Target.targetCreated":
        var info = params.targetInfo || {};
        if (info.type === "page") {
          self.targets[info.targetId] = true;
          if (!info.isProvisional) {
            self.pageTarget = info.targetId;
          }
          self.enableDomains(info.targetId);
          if (self.onReady && self.pageTarget) {
            self.onReady();
            self.onReady = null;
          }
        }
        return;
      case "Target.didCommitProvisionalTarget":
        self.pageTarget = params.newTargetId;
        return;
      case "Target.targetDestroyed":
        delete self.targets[params.targetId];
        // No answer comes from a target that has gone.
        Object.keys(self.waiting).forEach(function (id) {
          var waiter = self.waiting[id];
          if (waiter.target === params.targetId) {
            delete self.waiting[id];
            waiter.reject(cdpError(CDP_SERVER_ERROR, "Inspected target navigated or closed"));
          }
        });
        return;
      case "Target.dispatchMessageFromTarget":
        var inner = JSON.parse(params.message);
        if (inner.id != null && self.waiting[inner.id]) {
          var w = self.waiting[inner.id];
          delete self.waiting[inner.id];
          if (inner.error) {
            w.reject(cdpError(inner.error.code || CDP_SERVER_ERROR, inner.error.message));
          } else {
            w.resolve(inner.result || {});
          }
        } else if (inner.method && params.targetId === self.pageTarget) {
          self.session.fromPage(inner.method, inner.params || {});
        }
        return;
    }
  };

  // Sends a command to the page's target and resolves with its result.
  InspectorSession.prototype.send = function (method, params, targetId) {
    var self = this;
    var aqua = hostAqua();
    var id = self.nextId++;
    var target = targetId || self.pageTarget;
    return new Promise(function (resolve, reject) {
      self.waiting[id] = { resolve: resolve, reject: reject, target: target };
      aqua.inspector.sendMessage(self.tabId, JSON.stringify({
        id: id, method: "Target.sendMessageToTarget",
        params: {
          targetId: target,
          message: JSON.stringify({ id: id, method: method, params: params || {} })
        }
      })).catch(function (e) {
        delete self.waiting[id];
        reject(cdpError(CDP_SERVER_ERROR, e && e.message ? e.message : String(e)));
      });
    });
  };

  // Turns on, in a page target, the domains the session's enabled domains
  // are reported from.
  InspectorSession.prototype.enableDomains = function (targetId) {
    if (this.session.enabled.Runtime || this.session.enabled.Log) {
      this.send("Console.enable", {}, targetId).catch(function () {});
    }
  };

  InspectorSession.prototype.lost = function () {
    var self = this;
    self.closed = true;
    delete inspectorSessions[self.tabId];
    Object.keys(self.waiting).forEach(function (id) {
      self.waiting[id].reject(cdpError(CDP_SERVER_ERROR, "Inspected target navigated or closed"));
    });
    self.waiting = {};
    if (self.onLost) {
      self.onLost(cdpError(CDP_SERVER_ERROR, "Inspected target navigated or closed"));
    }
    if (self.session.inspector && !self.session.closed) {
      self.session.inspector = null;
    }
  };

  DebugSession.prototype.page = function () {
    var self = this;
    if (self.inspector) {
      return self.inspector;
    }
    var aqua = hostAqua();
    if (!aqua || !aqua.inspector) {
      return Promise.reject(cdpError(CDP_SERVER_ERROR, "Not supported"));
    }
    listenToInspector(aqua);
    var inspector = new InspectorSession(self);
    inspectorSessions[self.tabId] = inspector;
    self.inspector = new Promise(function (resolve, reject) {
      inspector.onLost = reject;
      inspector.onReady = function () {
        resolve(inspector);
      };
      aqua.inspector.attach(self.tabId).then(function () {
        if (inspector.pageTarget) {
          inspector.onReady = null;
          resolve(inspector);
        }
      }, function (e) {
        delete inspectorSessions[self.tabId];
        self.inspector = null;
        reject(cdpError(CDP_SERVER_ERROR, e && e.message ? e.message : String(e)));
      });
    });
    return self.inspector;
  };

  // ---- Values -------------------------------------------------------------
  // A Chrome RemoteObject for one of WebKit's. WebKit's numbers that JSON
  // cannot hold come with a description alone, which Chrome gives as an
  // unserializable value.
  var CDP_SUBTYPES = ["array", "null", "node", "regexp", "date", "map", "set", "weakmap", "weakset",
    "iterator", "generator", "error", "proxy", "promise", "typedarray", "arraybuffer", "dataview"];

  function cdpRemoteObject(o) {
    var out = { type: o.type };
    var subtype = o.subtype;
    if (o.type === "object" && o.className === "Promise") {
      subtype = "promise";
    }
    if (subtype && CDP_SUBTYPES.indexOf(subtype) >= 0) {
      out.subtype = subtype;
    }
    if (o.type === "function" || o.type === "object") {
      if (o.className) {
        out.className = o.className;
      }
    }
    if (o.type === "number" && (o.value === undefined || o.value === null) && o.description) {
      out.unserializableValue = o.description;
      out.description = o.description;
    } else if (o.type === "bigint") {
      out.unserializableValue = String(o.description || o.value) + "n";
      out.description = String(o.description || o.value) + "n";
    } else if ("value" in o) {
      out.value = o.value;
      if (o.type === "number") {
        out.description = String(o.value);
      }
    }
    if (o.type !== "undefined" && o.type !== "string" && o.type !== "boolean" && o.description != null &&
        out.description == null) {
      out.description = o.description;
    }
    return out;
  }

  // V8's wording of the syntax errors protocol clients test for.
  var V8_SYNTAX_ERRORS = [
    [/^Return statements are only valid inside functions\.?$/, "Illegal return statement"]
  ];

  function cdpException(o, scriptId) {
    var exception = cdpRemoteObject(o);
    var description = String(o.description || "");
    if (o.className === "SyntaxError") {
      V8_SYNTAX_ERRORS.forEach(function (pair) {
        var message = description.replace(/^SyntaxError: /, "");
        if (pair[0].test(message)) {
          description = "SyntaxError: " + pair[1];
        }
      });
    }
    exception.description = description;
    var details = { exceptionId: 1, text: "Uncaught", lineNumber: 0, columnNumber: 0, exception: exception };
    if (o.className === "SyntaxError") {
      details.scriptId = String(scriptId);
    }
    return details;
  }

  var evaluations = 0;

  // Runtime.evaluate, in the page's own world.
  function evaluateInPage(session, p) {
    if (p.expression == null) {
      return Promise.reject(missingParam("expression"));
    }
    var group = "wex-" + (++evaluations);
    var expression = String(p.expression);
    return session.page().then(function (inspector) {
      var run = function (source) {
        return inspector.send("Runtime.evaluate", {
          expression: source, objectGroup: group, returnByValue: false,
          includeCommandLineAPI: !!p.includeCommandLineAPI,
          doNotPauseOnExceptionsAndMuteConsole: !!p.silent,
          emulateUserGesture: !!p.userGesture
        });
      };
      var evaluated = !p.replMode ? run(expression) :
        inspector.send("Runtime.parse", { source: expression }).then(function (parsed) {
          if (parsed.result === "none" || !/\bawait\b/.test(expression)) {
            return run(expression);
          }
          // Code with `await` at its top level, which Chrome's REPL mode runs
          // and a script cannot: run as the body of an async function, which
          // returns the value of its last statement when that is an
          // expression, as the REPL's completion value is.
          var body = /^\s*\{[\s\S]*\}\s*$/.test(expression) ?
            expression.replace(/^\s*\{/, "").replace(/\}\s*$/, "") : expression;
          var trimmed = body.replace(/[;\s]+$/, "");
          var split = Math.max(trimmed.lastIndexOf(";"), trimmed.lastIndexOf("\n"));
          var last = trimmed.slice(split + 1);
          var returning = /\S/.test(last) ? "(async () => {\n" + trimmed.slice(0, split + 1) +
            "\nreturn (" + last + ");\n})()" : null;
          var wrapped = "(async () => {\n" + expression + "\n})()";
          var parses = function (source) {
            return source ? inspector.send("Runtime.parse", { source: source }).then(function (r) {
              return r.result === "none";
            }) : Promise.resolve(false);
          };
          return parses(returning).then(function (ok) {
            return ok ? run(returning) : parses(wrapped).then(function (plain) {
              return run(plain ? wrapped : expression);
            });
          });
        });
      return evaluated.then(function (r) {
        var result = r.result || { type: "undefined" };
        if (!r.wasThrown && p.awaitPromise && result.className === "Promise" && result.objectId) {
          return inspector.send("Runtime.awaitPromise", {
            promiseObjectId: result.objectId, returnByValue: !!p.returnByValue
          });
        }
        if (!r.wasThrown && p.returnByValue && result.objectId) {
          return inspector.send("Runtime.callFunctionOn", {
            objectId: result.objectId, functionDeclaration: "function () { return this; }",
            returnByValue: true
          });
        }
        return r;
      }).then(function (r) {
        var out = { result: cdpRemoteObject(r.result || { type: "undefined" }) };
        if (r.wasThrown) {
          out.exceptionDetails = cdpException(r.result || {}, evaluations);
        }
        inspector.send("Runtime.releaseObjectGroup", { objectGroup: group }).catch(function () {});
        return out;
      });
    });
  }

  // ---- Console --------------------------------------------------------------
  var CONSOLE_TYPES = {
    dir: "dir", dirxml: "dirxml", table: "table", trace: "trace", clear: "clear",
    startGroup: "startGroup", startGroupCollapsed: "startGroupCollapsed", endGroup: "endGroup",
    assert: "assert", timing: "timeEnd", profile: "profile", profileEnd: "profileEnd"
  };

  function cdpStackTrace(trace) {
    var frames = (trace && (trace.callFrames || trace)) || [];
    if (!frames.length) {
      return undefined;
    }
    return {
      callFrames: frames.map(function (f) {
        return {
          functionName: f.functionName || "", scriptId: String(f.scriptId || "0"), url: f.url || "",
          lineNumber: Math.max(0, (f.lineNumber || 1) - 1), columnNumber: Math.max(0, (f.columnNumber || 1) - 1)
        };
      })
    };
  }

  DebugSession.prototype.fromPage = function (method, params) {
    var self = this;
    if (method === "Console.messageAdded") {
      self.lastConsoleMessage = params.message || {};
      self.reportConsole(self.lastConsoleMessage);
    } else if (method === "Console.messageRepeatCountUpdated" && self.lastConsoleMessage) {
      self.reportConsole(self.lastConsoleMessage);
    }
  };

  DebugSession.prototype.reportConsole = function (m) {
    var timestamp = m.timestamp ? m.timestamp * 1000 : Date.now();
    if (m.source === "console-api" && this.enabled.Runtime) {
      var type = CONSOLE_TYPES[m.type] ||
        ({ warning: "warning", error: "error", info: "info", debug: "debug" })[m.level] || "log";
      var args = (m.parameters || []).map(cdpRemoteObject);
      if (!args.length) {
        args = [{ type: "string", value: m.text || "" }];
      }
      var event = { type: type, args: args, executionContextId: 1, timestamp: timestamp };
      var trace = cdpStackTrace(m.stackTrace);
      if (trace) {
        event.stackTrace = trace;
      }
      this.emit("Runtime.consoleAPICalled", event);
    } else if (m.source === "javascript" && m.level === "error" && this.enabled.Runtime) {
      var details = {
        exceptionId: 1, text: "Uncaught", lineNumber: Math.max(0, (m.line || 1) - 1),
        columnNumber: Math.max(0, (m.column || 1) - 1), url: m.url || "",
        exception: { type: "object", subtype: "error", className: "Error", description: m.text || "" }
      };
      var stack = cdpStackTrace(m.stackTrace);
      if (stack) {
        details.stackTrace = stack;
      }
      this.emit("Runtime.exceptionThrown", { timestamp: timestamp, exceptionDetails: details });
    } else if (m.source !== "console-api" && this.enabled.Log) {
      this.emit("Log.entryAdded", {
        entry: {
          source: m.source || "other",
          level: m.level === "warning" ? "warning" : m.level === "error" ? "error" :
            m.level === "debug" ? "verbose" : "info",
          text: m.text || "", timestamp: timestamp, url: m.url || undefined,
          lineNumber: m.line ? m.line - 1 : undefined
        }
      });
    }
  };

  // ---- Network and page events ----------------------------------------------
  var CDP_RESOURCE_TYPES = {
    main_frame: "Document", sub_frame: "Document", stylesheet: "Stylesheet", script: "Script",
    image: "Image", font: "Font", xmlhttprequest: "XHR", ping: "Ping", csp_report: "CSPViolationReport",
    media: "Media", websocket: "WebSocket", object: "Other", other: "Other"
  };

  function cdpHeaders(list) {
    var out = {};
    (list || []).forEach(function (h) {
      out[h.name] = out[h.name] ? out[h.name] + "\n" + (h.value || "") : h.value || "";
    });
    return out;
  }

  function mimeTypeOf(headers) {
    var type = "";
    (headers || []).forEach(function (h) {
      if (String(h.name).toLowerCase() === "content-type") {
        type = String(h.value || "").split(";")[0].trim();
      }
    });
    return type;
  }

  DebugSession.prototype.watchNetwork = function () {
    var self = this;
    if (self.watchingNetwork || !native.webRequest) {
      return;
    }
    self.watchingNetwork = true;
    var filter = { urls: ["<all_urls>"], tabId: self.tabId };
    var documentUrls = {};
    var stamp = function (d) {
      return (d.timeStamp || Date.now()) / 1000;
    };
    self.listen(native.webRequest.onBeforeRequest, function (d) {
      if (!self.enabled.Network) {
        return;
      }
      documentUrls[d.requestId] = d.documentUrl || d.url;
      self.emit("Network.requestWillBeSent", {
        requestId: String(d.requestId), loaderId: String(d.requestId),
        documentURL: d.type === "main_frame" ? d.url : d.documentUrl || "",
        request: { url: d.url, method: d.method || "GET", headers: {}, initialPriority: "Medium",
          referrerPolicy: "strict-origin-when-cross-origin" },
        timestamp: stamp(d), wallTime: (d.timeStamp || Date.now()) / 1000,
        initiator: { type: "other" }, redirectHasExtraInfo: false,
        type: CDP_RESOURCE_TYPES[d.type] || "Other", frameId: String(d.frameId || 0)
      });
    }, filter);
    self.listen(native.webRequest.onResponseStarted, function (d) {
      if (!self.enabled.Network) {
        return;
      }
      var statusText = String(d.statusLine || "").replace(/^\S+\s+\d+\s*/, "");
      self.emit("Network.responseReceived", {
        requestId: String(d.requestId), loaderId: String(d.requestId), timestamp: stamp(d),
        type: CDP_RESOURCE_TYPES[d.type] || "Other", frameId: String(d.frameId || 0),
        hasExtraInfo: false,
        response: {
          url: d.url, status: d.statusCode, statusText: statusText,
          headers: cdpHeaders(d.responseHeaders), mimeType: mimeTypeOf(d.responseHeaders),
          fromDiskCache: !!d.fromCache, connectionReused: false, connectionId: 0,
          encodedDataLength: 0, securityState: /^https:/i.test(d.url) ? "secure" : "insecure"
        }
      });
    }, filter, ["responseHeaders"]);
    self.listen(native.webRequest.onCompleted, function (d) {
      delete documentUrls[d.requestId];
      if (self.enabled.Network) {
        self.emit("Network.loadingFinished", { requestId: String(d.requestId), timestamp: stamp(d),
          encodedDataLength: 0 });
      }
    }, filter);
    self.listen(native.webRequest.onErrorOccurred, function (d) {
      delete documentUrls[d.requestId];
      if (self.enabled.Network) {
        var canceled = d.error === "net::ERR_ABORTED";
        self.emit("Network.loadingFailed", { requestId: String(d.requestId), timestamp: stamp(d),
          type: CDP_RESOURCE_TYPES[d.type] || "Other", errorText: canceled ? "" : d.error || "net::ERR_FAILED",
          canceled: canceled });
      }
    }, filter);
  };

  DebugSession.prototype.watchPage = function () {
    var self = this;
    if (self.watchingPage || !native.webNavigation) {
      return;
    }
    self.watchingPage = true;
    var mine = function (d) {
      return d.tabId === self.tabId && d.frameId === 0;
    };
    self.listen(native.webNavigation.onCommitted, function (d) {
      if (!mine(d)) {
        return;
      }
      var url = String(d.url || "");
      var frame = { id: String(self.tabId), loaderId: String(d.timeStamp || Date.now()), url: url,
        domainAndRegistry: "", securityOrigin: /^[a-z][a-z0-9+.-]*:\/\/[^\/]*/i.test(url) ?
          /^[a-z][a-z0-9+.-]*:\/\/[^\/]*/i.exec(url)[0] : "://", mimeType: "text/html",
        secureContextType: /^https:/i.test(url) ? "Secure" : "InsecureScheme",
        crossOriginIsolatedContextType: "NotIsolated", gatedAPIFeatures: [] };
      if (self.enabled.Page) {
        self.emit("Page.frameNavigated", { frame: frame, type: "Navigation" });
      }
      if (self.enabled.Runtime) {
        self.emit("Runtime.executionContextsCleared", {});
        self.emitContext(url);
      }
    });
    self.listen(native.webNavigation.onDOMContentLoaded, function (d) {
      if (mine(d) && self.enabled.Page) {
        self.emit("Page.domContentEventFired", { timestamp: (d.timeStamp || Date.now()) / 1000 });
      }
    });
    self.listen(native.webNavigation.onCompleted, function (d) {
      if (mine(d) && self.enabled.Page) {
        self.emit("Page.loadEventFired", { timestamp: (d.timeStamp || Date.now()) / 1000 });
      }
    });
  };

  // The JavaScript dialogs the tab's page opens, while Page is enabled.
  DebugSession.prototype.watchDialogs = function () {
    var self = this;
    var dialogs = hostAqua().dialog;
    if (self.watchingDialogs || !dialogs) {
      return;
    }
    self.watchingDialogs = true;
    self.listen(dialogs.onOpen, function (tabId, dialog) {
      if (tabId !== self.tabId || !self.enabled.Page) {
        return;
      }
      var tab = tabForId(self.tabId);
      self.emit("Page.javascriptDialogOpening", { url: String(tab && tab.url || ""),
        frameId: String(self.tabId), message: String(dialog.message || ""), type: dialog.type,
        hasBrowserHandler: true, defaultPrompt: dialog.type === "prompt" ? String(dialog.defaultText || "") : "" });
    });
  };

  DebugSession.prototype.emitContext = function (url) {
    var origin = /^[a-z][a-z0-9+.-]*:\/\/[^\/]*/i.exec(String(url || ""));
    this.emit("Runtime.executionContextCreated", {
      context: { id: 1, origin: origin ? origin[0] : "://", name: "",
        uniqueId: targetIdForTab(this.tabId) + "-1",
        auxData: { isDefault: true, type: "default", frameId: String(this.tabId) } }
    });
  };

  // ---- Input ------------------------------------------------------------------
  var MOUSE_EVENT_TYPES = {
    mousePressed: "mouseDown", mouseReleased: "mouseUp", mouseMoved: "mouseMoved", mouseWheel: "scrollWheel"
  };
  var MOUSE_BUTTONS = { "": null, none: null, left: "left", right: "right", middle: "middle" };

  // Chrome's modifier bits: Alt 1, Control 2, Meta 4, Shift 8.
  function modifierList(bits) {
    var out = [];
    var b = Number(bits) || 0;
    if (b & 1) {
      out.push("option");
    }
    if (b & 2) {
      out.push("control");
    }
    if (b & 4) {
      out.push("command");
    }
    if (b & 8) {
      out.push("shift");
    }
    return out;
  }

  function dispatchMouse(session, p) {
    if (!(p.type in MOUSE_EVENT_TYPES)) {
      return Promise.reject(p.type == null ? missingParam("type") :
        cdpError(CDP_INVALID_PARAMS, "Unexpected event type '" + p.type + "'"));
    }
    if (typeof p.x !== "number") {
      return Promise.reject(missingParam("x"));
    }
    if (typeof p.y !== "number") {
      return Promise.reject(missingParam("y"));
    }
    var button = p.button == null ? "" : String(p.button);
    if (!(button in MOUSE_BUTTONS)) {
      return Promise.reject(cdpError(CDP_INVALID_PARAMS, "Invalid mouse button"));
    }
    var event = { type: MOUSE_EVENT_TYPES[p.type], x: p.x, y: p.y, modifiers: modifierList(p.modifiers) };
    if (p.type === "mouseWheel") {
      if (typeof p.deltaX !== "number" || typeof p.deltaY !== "number") {
        return Promise.reject(cdpError(CDP_INVALID_PARAMS,
          "'deltaX' and 'deltaY' are expected for mouseWheel event"));
      }
      event.deltaX = p.deltaX;
      event.deltaY = p.deltaY;
    } else {
      if (MOUSE_BUTTONS[button]) {
        event.button = MOUSE_BUTTONS[button];
      }
      if (typeof p.buttons === "number") {
        event.buttons = p.buttons;
      }
      if (p.type === "mousePressed" || p.type === "mouseReleased") {
        event.clickCount = Math.max(1, Number(p.clickCount) || 0);
      }
      if (p.type === "mouseMoved" && (Number(p.buttons) || 0) !== 0) {
        event.type = "mouseDragged";
      }
    }
    return session.inOrder(function () {
      return hostAqua().input.dispatchMouseEvent(session.tabId, event);
    }).then(function () {
      return {};
    }, inputFailure);
  }

  function inputFailure(e) {
    throw cdpError(CDP_SERVER_ERROR, e && e.message ? e.message : String(e));
  }

  // macOS virtual key codes, by the `code` a key event names.
  var MAC_KEY_CODES = {
    KeyA: 0, KeyS: 1, KeyD: 2, KeyF: 3, KeyH: 4, KeyG: 5, KeyZ: 6, KeyX: 7, KeyC: 8, KeyV: 9,
    IntlBackslash: 10, KeyB: 11, KeyQ: 12, KeyW: 13, KeyE: 14, KeyR: 15, KeyY: 16, KeyT: 17,
    Digit1: 18, Digit2: 19, Digit3: 20, Digit4: 21, Digit6: 22, Digit5: 23, Equal: 24, Digit9: 25,
    Digit7: 26, Minus: 27, Digit8: 28, Digit0: 29, BracketRight: 30, KeyO: 31, KeyU: 32,
    BracketLeft: 33, KeyI: 34, KeyP: 35, Enter: 36, KeyL: 37, KeyJ: 38, Quote: 39, KeyK: 40,
    Semicolon: 41, Backslash: 42, Comma: 43, Slash: 44, KeyN: 45, KeyM: 46, Period: 47, Tab: 48,
    Space: 49, Backquote: 50, Backspace: 51, Escape: 53, MetaRight: 54, MetaLeft: 55, ShiftLeft: 56,
    CapsLock: 57, AltLeft: 58, ControlLeft: 59, ShiftRight: 60, AltRight: 61, ControlRight: 62,
    F17: 64, NumpadDecimal: 65, NumpadMultiply: 67, NumpadAdd: 69, NumLock: 71, NumpadDivide: 75,
    NumpadEnter: 76, NumpadSubtract: 78, F18: 79, F19: 80, NumpadEqual: 81, Numpad0: 82,
    Numpad1: 83, Numpad2: 84, Numpad3: 85, Numpad4: 86, Numpad5: 87, Numpad6: 88, Numpad7: 89,
    F20: 90, Numpad8: 91, Numpad9: 92, F5: 96, F6: 97, F7: 98, F3: 99, F8: 100, F9: 101, F11: 103,
    F13: 105, F16: 106, F14: 107, F10: 109, ContextMenu: 110, F12: 111, F15: 113, Insert: 114,
    Home: 115, PageUp: 116, Delete: 117, F4: 118, End: 119, F2: 120, PageDown: 121, F1: 122,
    ArrowLeft: 123, ArrowRight: 124, ArrowDown: 125, ArrowUp: 126
  };

  // The `code` of a key a Windows virtual key code names, for the keys that
  // name no `code`.
  var WINDOWS_KEY_CODES = {
    8: "Backspace", 9: "Tab", 13: "Enter", 16: "ShiftLeft", 17: "ControlLeft", 18: "AltLeft",
    20: "CapsLock", 27: "Escape", 32: "Space", 33: "PageUp", 34: "PageDown", 35: "End", 36: "Home",
    37: "ArrowLeft", 38: "ArrowUp", 39: "ArrowRight", 40: "ArrowDown", 45: "Insert", 46: "Delete",
    91: "MetaLeft", 92: "MetaRight", 93: "ContextMenu", 186: "Semicolon", 187: "Equal", 188: "Comma",
    189: "Minus", 190: "Period", 191: "Slash", 192: "Backquote", 219: "BracketLeft",
    220: "Backslash", 221: "BracketRight", 222: "Quote"
  };

  // The text AppKit gives a key that types none: its function-key character.
  var MAC_KEY_CHARACTERS = {
    Enter: "\r", NumpadEnter: "\u0003", Tab: "\t", Space: " ", Backspace: "\u007f", Escape: "\u001b",
    ArrowUp: "\uf700", ArrowDown: "\uf701", ArrowLeft: "\uf702", ArrowRight: "\uf703",
    Insert: "\uf727", Delete: "\uf728", Home: "\uf729", End: "\uf72b", PageUp: "\uf72c",
    PageDown: "\uf72d", F1: "\uf704", F2: "\uf705", F3: "\uf706", F4: "\uf707", F5: "\uf708",
    F6: "\uf709", F7: "\uf70a", F8: "\uf70b", F9: "\uf70c", F10: "\uf70d", F11: "\uf70e",
    F12: "\uf70f"
  };

  // The keys whose text a page gets as typed from their key down alone. Chrome's
  // `rawKeyDown` types nothing, and leaves that to the `char` that follows.
  var TYPING_KEYS = { Enter: 1, NumpadEnter: 1, Space: 1 };

  var MODIFIER_CODES = {
    ShiftLeft: "shift", ShiftRight: "shift", ControlLeft: "control", ControlRight: "control",
    AltLeft: "option", AltRight: "option", MetaLeft: "command", MetaRight: "command",
    CapsLock: "capsLock"
  };

  function keyCodeName(p) {
    if (p.code && MAC_KEY_CODES[p.code] !== undefined) {
      return p.code;
    }
    var vk = p.windowsVirtualKeyCode != null ? p.windowsVirtualKeyCode : p.nativeVirtualKeyCode;
    if (vk != null) {
      if (WINDOWS_KEY_CODES[vk]) {
        return WINDOWS_KEY_CODES[vk];
      }
      if (vk >= 65 && vk <= 90) {
        return "Key" + String.fromCharCode(vk);
      }
      if (vk >= 48 && vk <= 57) {
        return "Digit" + String.fromCharCode(vk);
      }
      if (vk >= 112 && vk <= 123) {
        return "F" + (vk - 111);
      }
    }
    var key = String(p.key || "");
    if (key.length === 1 && /[a-z]/i.test(key)) {
      return "Key" + key.toUpperCase();
    }
    if (key.length === 1 && /[0-9]/.test(key)) {
      return "Digit" + key;
    }
    if (key === " ") {
      return "Space";
    }
    return MAC_KEY_CODES[key] !== undefined ? key : null;
  }

  // The editing commands a key's own key bindings do not perform, which a
  // page gets from Safari's Edit menu, performed as the menu performs them.
  // A command that cannot be performed now is passed over, as Chrome passes
  // it over.
  var MENU_ACTIONS = { selectall: "selectAll:", copy: "copy:", cut: "cut:", paste: "paste:",
    pasteasplaintext: "pasteAsPlainText:", pasteandmatchstyle: "pasteAsPlainText:", "delete": "delete:",
    undo: "undo:", redo: "redo:", uppercaseword: "uppercaseWord:", lowercaseword: "lowercaseWord:",
    capitalizeword: "capitalizeWord:" };

  function runEditingCommands(session, commands) {
    var actions = (commands || []).map(function (c) {
      return MENU_ACTIONS[String(c).replace(/:$/, "").toLowerCase()];
    }).filter(Boolean);
    var input = hostAqua().input;
    return actions.reduce(function (previous, action) {
      return previous.then(function () {
        return input.performEditingAction(session.tabId, action);
      }).then(null, function () {});
    }, Promise.resolve());
  }

  function dispatchKey(session, p) {
    var types = { keyDown: 1, keyUp: 1, rawKeyDown: 1, "char": 1 };
    if (!(p.type in types)) {
      return Promise.reject(p.type == null ? missingParam("type") :
        cdpError(CDP_INVALID_PARAMS, "Unexpected event type '" + p.type + "'"));
    }
    var aqua = hostAqua();
    var modifiers = modifierList(p.modifiers);
    var text = p.text == null ? "" : String(p.text);
    if (p.type === "char") {
      return session.inOrder(function () {
        return text ? aqua.input.insertText(session.tabId, text) : null;
      }).then(function () {
        return {};
      }, inputFailure);
    }
    var code = keyCodeName(p);
    var keyCode = code ? MAC_KEY_CODES[code] : null;
    if (keyCode == null) {
      if (p.type === "keyDown" && text) {
        // A key macOS has no code for, as a character from another layout:
        // its text, typed.
        return session.inOrder(function () {
          return aqua.input.insertText(session.tabId, text);
        }).then(function () {
          return {};
        }, inputFailure);
      }
      return Promise.resolve({});
    }
    var event;
    var modifier = MODIFIER_CODES[code];
    if (modifier) {
      // A modifier key changes the flags: held from its key down until its
      // key up.
      modifiers = modifiers.filter(function (m) {
        return m !== modifier;
      });
      if (p.type !== "keyUp") {
        modifiers.push(modifier);
      }
      event = { type: "flagsChanged", keyCode: keyCode, modifiers: modifiers };
    } else {
      var keyCharacters = MAC_KEY_CHARACTERS[code] || "";
      var characters = p.type === "rawKeyDown" ? (TYPING_KEYS[code] ? "" : keyCharacters) :
        text || keyCharacters;
      var plain = p.unmodifiedText != null && p.unmodifiedText !== "" ? String(p.unmodifiedText) :
        String(p.key || "").length === 1 ? String(p.key).toLowerCase() : characters || keyCharacters;
      event = { type: p.type === "keyUp" ? "keyUp" : "keyDown", keyCode: keyCode,
        characters: characters, charactersIgnoringModifiers: plain || characters, modifiers: modifiers,
        isRepeat: !!p.autoRepeat };
    }
    return session.inOrder(function () {
      return aqua.input.dispatchKeyEvent(session.tabId, event).then(function () {
        if (event.type === "keyDown") {
          return runEditingCommands(session, p.commands);
        }
      });
    }).then(function () {
      return {};
    }, inputFailure);
  }

  // ---- Page -------------------------------------------------------------------
  function captureScreenshot(session, p) {
    var format = p.format == null ? "png" : String(p.format);
    if (format !== "png" && format !== "jpeg") {
      return Promise.reject(cdpError(CDP_SERVER_ERROR, "Unsupported image format: " + format));
    }
    var options = { format: format };
    if (format === "jpeg") {
      options.quality = p.quality == null ? 80 : Math.max(0, Math.min(100, Number(p.quality)));
    }
    if (p.clip) {
      var c = p.clip;
      options.rect = { x: c.x, y: c.y, width: c.width, height: c.height };
      options.scale = (Number(c.scale) || 1) * (g.devicePixelRatio || 1);
    }
    return native.tabs.captureTab(session.tabId, options).then(function (url) {
      return { data: String(url).replace(/^data:[^,]*,/, "") };
    }, function (e) {
      throw cdpError(CDP_SERVER_ERROR, e && e.message ? e.message : String(e));
    });
  }

  function layoutMetrics(session) {
    return native.tabs.executeScript(session.tabId, {
      code: "(function () { var d = document.documentElement, v = window.visualViewport; return {" +
        " x: window.scrollX, y: window.scrollY, w: d.clientWidth, h: d.clientHeight," +
        " vw: v ? v.width : innerWidth, vh: v ? v.height : innerHeight, scale: v ? v.scale : 1," +
        " sw: Math.max(d.scrollWidth, document.body ? document.body.scrollWidth : 0)," +
        " sh: Math.max(d.scrollHeight, document.body ? document.body.scrollHeight : 0) }; })();"
    }).then(function (results) {
      var m = results && results[0];
      if (!m) {
        throw cdpError(CDP_SERVER_ERROR, "Cannot get layout metrics");
      }
      var layout = { pageX: m.x, pageY: m.y, clientWidth: m.w, clientHeight: m.h };
      var visual = { offsetX: 0, offsetY: 0, pageX: m.x, pageY: m.y, clientWidth: m.vw,
        clientHeight: m.vh, scale: m.scale, zoom: 1 };
      var content = { x: 0, y: 0, width: m.sw, height: m.sh };
      return { layoutViewport: layout, visualViewport: visual, contentSize: content,
        cssLayoutViewport: layout, cssVisualViewport: visual, cssContentSize: content };
    }, function (e) {
      throw cdpError(CDP_SERVER_ERROR, e && e.message ? e.message : String(e));
    });
  }

  function navigatePage(session, p) {
    if (p.url == null) {
      return Promise.reject(missingParam("url"));
    }
    var tab = tabForId(session.tabId);
    var url = String(p.url);
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) {
      return Promise.reject(cdpError(CDP_INVALID_PARAMS, "Cannot navigate to invalid URL"));
    }
    return Promise.resolve(navigateTab(tab, url)).then(function () {
      return { frameId: String(session.tabId), loaderId: String(Date.now()) };
    });
  }

  function frameTree(session) {
    var tab = tabForId(session.tabId);
    var url = String(tab && tab.url || "about:blank");
    var origin = /^[a-z][a-z0-9+.-]*:\/\/[^\/]*/i.exec(url);
    return { frameTree: { frame: { id: String(session.tabId), loaderId: "0", url: url,
      domainAndRegistry: "", securityOrigin: origin ? origin[0] : "://", mimeType: "text/html",
      secureContextType: /^https:/i.test(url) ? "Secure" : "InsecureScheme",
      crossOriginIsolatedContextType: "NotIsolated", gatedAPIFeatures: [] } } };
  }

  function browserVersion() {
    var ua = String(g.navigator.userAgent);
    var chrome = /Chrome\/[\d.]+/.exec(ua);
    return { protocolVersion: "1.3", product: chrome ? chrome[0] : "Chrome", revision: "",
      userAgent: ua, jsVersion: "" };
  }

  // The protocol's methods, each with the session and its parameters.
  var CDP_METHODS = {
    "Input.dispatchMouseEvent": dispatchMouse,
    "Input.dispatchKeyEvent": dispatchKey,
    "Input.insertText": function (session, p) {
      if (p.text == null) {
        return Promise.reject(missingParam("text"));
      }
      return session.inOrder(function () {
        return hostAqua().input.insertText(session.tabId, String(p.text));
      }).then(function () {
        return {};
      }, inputFailure);
    },
    "Page.captureScreenshot": captureScreenshot,
    "Page.getLayoutMetrics": layoutMetrics,
    "Page.navigate": navigatePage,
    "Page.reload": function (session, p) {
      return native.tabs.reload(session.tabId, { bypassCache: !!p.ignoreCache }).then(function () {
        return {};
      });
    },
    "Page.getFrameTree": frameTree,
    "Page.bringToFront": function (session) {
      var tab = tabForId(session.tabId);
      try {
        tab.activate();
        tab.browserWindow.activate();
      } catch (e) { /* the window stays where it is */ }
      return Promise.resolve({});
    },
    "Page.enable": function (session) {
      session.enabled.Page = true;
      session.watchPage();
      session.watchDialogs();
      return Promise.resolve({});
    },
    "Page.disable": function (session) {
      session.enabled.Page = false;
      return Promise.resolve({});
    },
    "Page.handleJavaScriptDialog": function (session, p) {
      if (p.accept === undefined) {
        return Promise.reject(missingParam("accept"));
      }
      var dialogs = hostAqua().dialog;
      var answer = { accept: !!p.accept };
      if (typeof p.promptText === "string") {
        answer.text = p.promptText;
      }
      return Promise.resolve().then(function () {
        return dialogs.answer(session.tabId, answer);
      }).then(function () {
        if (session.enabled.Page) {
          session.emit("Page.javascriptDialogClosed", { frameId: String(session.tabId),
            result: answer.accept, userInput: answer.accept && answer.text !== undefined ? answer.text : "" });
        }
        return {};
      }, function () {
        throw cdpError(CDP_SERVER_ERROR, "No dialog is showing");
      });
    },
    "Runtime.evaluate": evaluateInPage,
    "Runtime.enable": function (session) {
      var first = !session.enabled.Runtime;
      session.enabled.Runtime = true;
      session.watchPage();
      if (first) {
        var tab = tabForId(session.tabId);
        session.emitContext(tab && tab.url);
      }
      return session.page().then(function (inspector) {
        return inspector.send("Console.enable", {});
      }).then(function () {
        return {};
      }, function () {
        return {};
      });
    },
    "Runtime.disable": function (session) {
      session.enabled.Runtime = false;
      return Promise.resolve({});
    },
    "Runtime.runIfWaitingForDebugger": function () {
      return Promise.resolve({});
    },
    "Log.enable": function (session) {
      session.enabled.Log = true;
      return session.page().then(function (inspector) {
        return inspector.send("Console.enable", {});
      }).then(function () {
        return {};
      }, function () {
        return {};
      });
    },
    "Log.disable": function (session) {
      session.enabled.Log = false;
      return Promise.resolve({});
    },
    "Network.enable": function (session) {
      session.enabled.Network = true;
      session.watchNetwork();
      return Promise.resolve({});
    },
    "Network.disable": function (session) {
      session.enabled.Network = false;
      return Promise.resolve({});
    },
    "Browser.getVersion": function () {
      return Promise.resolve(browserVersion());
    }
  };

  function makeDebugger() {
    native.tabs.onRemoved.addListener(function (tabId) {
      if (!debuggees[tabId] && !debugTargetIds[tabId]) {
        return;
      }
      var tab = safariTabById.get(tabId);
      var replacement = tab && tab.browserWindow ? lookUp(tab) : Promise.resolve(undefined);
      replacement.then(function (newId) {
        var replaced = newId !== undefined && newId !== tabId;
        if (debuggees[tabId]) {
          if (replaced) {
            debuggees[tabId].moveTo(newId);
          } else {
            debuggees[tabId].close("target_closed");
          }
        }
        if (replaced && debugTargetIds[tabId]) {
          debugTargetIds[newId] = debugTargetIds[tabId];
        }
        delete debugTargetIds[tabId];
      });
    });
    return {
      DetachReason: { TARGET_CLOSED: "target_closed", CANCELED_BY_USER: "canceled_by_user" },
      TargetInfoType: { PAGE: "page", BACKGROUND_PAGE: "background_page", WORKER: "worker",
        OTHER: "other" },
      onEvent: debuggerOnEvent,
      onDetach: debuggerOnDetach,
      attach: function (target, requiredVersion, cb) {
        var found = debuggeeTab(target);
        if (found.error) {
          return WEX.fail(cb, found.error);
        }
        var urlError = debugUrlError(found.tab.url);
        if (urlError) {
          return WEX.fail(cb, urlError);
        }
        if (DEBUGGER_VERSIONS.indexOf(String(requiredVersion)) < 0) {
          return WEX.fail(cb, "Requested protocol version is not supported: " + requiredVersion + ".");
        }
        if (debuggees[found.tabId]) {
          return WEX.fail(cb, debuggeeFormat("Another debugger is already attached to the * with id: *.",
            found.name));
        }
        debuggees[found.tabId] = new DebugSession(found.tabId);
        return done(cb);
      },
      detach: function (target, cb) {
        var found = debuggeeTab(target);
        if (found.error) {
          return WEX.fail(cb, found.error);
        }
        var session = debuggees[found.tabId];
        if (!session) {
          return WEX.fail(cb, debuggeeFormat("Debugger is not attached to the * with id: *.", found.name));
        }
        session.close(null);
        return done(cb);
      },
      sendCommand: function (target, method, commandParams, cb) {
        if (typeof commandParams === "function") {
          cb = commandParams;
          commandParams = undefined;
        }
        var found = debuggeeTab(target);
        if (found.error) {
          return WEX.fail(cb, found.error);
        }
        var session = debuggees[found.tabId];
        if (!session) {
          return WEX.fail(cb, debuggeeFormat("Debugger is not attached to the * with id: *.", found.name));
        }
        var handler = CDP_METHODS[method];
        if (!handler) {
          return settle(Promise.reject(cdpError(CDP_METHOD_NOT_FOUND, "'" + method + "' wasn't found")), cb);
        }
        var failWith;
        var result = new Promise(function (resolve, reject) {
          failWith = reject;
          session.failPending.push(reject);
          Promise.resolve().then(function () {
            return handler(session, commandParams || {});
          }).then(resolve, reject);
        });
        var forget = function () {
          var i = session.failPending.indexOf(failWith);
          if (i >= 0) {
            session.failPending.splice(i, 1);
          }
        };
        result.then(forget, forget);
        return settle(result, cb);
      },
      getTargets: function (cb) {
        return settle(identifyAll().then(function () {
          var out = [];
          eachSafariTab(function (t) {
            var id = idForTab(t);
            if (id === undefined) {
              return;
            }
            var url = t.url === undefined ? "" : String(t.url || "about:blank");
            out.push({ type: "page", id: targetIdForTab(id), title: t.title || url, url: url,
              attached: !!debuggees[id], tabId: id });
          });
          return out;
        }), cb);
      }
    };
  }

  // ------------------------------------------------------------------ //
  // Context menus
  // ------------------------------------------------------------------ //
  // Safari's page context menu is flat: nested items there collapse, with a
  // child shown under its parents' titles. Its toolbar extension menus are
  // native trees, so action-context items retain their submenus and state.
  var menuItems = {};
  var menuSeq = 1;
  var MENU_COMMAND = "wex-menu:";
  var MENUS_KEY = "wex.menus";
  var MAX_MENU_ITEMS = 1000;

  // An extension whose background is an event page or a service worker
  // keeps its menu items across restarts, which it may create only when it
  // is installed; Chrome and Firefox keep them for it.
  var LAZY_BACKGROUND = (function () {
    var manifest = CONFIG.manifest || {};
    var background = manifest.background || {};
    return manifest.manifest_version >= 3 || background.persistent === false ||
      !!background.service_worker;
  })();

  function saveMenus() {
    if (!LAZY_BACKGROUND) {
      return;
    }
    var kept = Object.keys(menuItems).map(function (key) {
      var item = {};
      Object.keys(menuItems[key]).forEach(function (k) {
        if (k !== "onclick") {
          item[k] = menuItems[key][k];
        }
      });
      return item;
    });
    settingsItem(MENUS_KEY, JSON.stringify({ seq: menuSeq, items: kept }));
  }

  (function loadMenus() {
    if (!LAZY_BACKGROUND) {
      return;
    }
    try {
      var stored = JSON.parse(settingsItem(MENUS_KEY) || "null");
      if (stored && Array.isArray(stored.items)) {
        stored.items.forEach(function (item) {
          menuItems[String(item.id)] = item;
        });
        menuSeq = stored.seq || menuSeq;
      }
    } catch (e) { /* none kept */ }
  })();

  function menuParentError(parentId) {
    var parent = menuItems[String(parentId)];
    if (!parent) {
      return "Cannot find menu item with id " + parentId;
    }
    if (parent.type !== "normal") {
      return "Parent items must have type \"normal\"";
    }
    return null;
  }

  // Firefox's checks of a new item (browser/components/extensions, ext-menus):
  // no title is needed, and an event page names its items.
  function firefoxMenuCreateError(p, id) {
    if (LAZY_BACKGROUND && !p.id) {
      return "menus.create requires an id for non-persistent background scripts.";
    }
    if (menuItems[String(id)]) {
      return LAZY_BACKGROUND ? "The menu id " + id + " already exists in menus.create." :
        "ID already exists: " + id;
    }
    if (p.parentId != null && !menuItems[String(p.parentId)]) {
      return "Cannot find menu item with id " + p.parentId;
    }
    return null;
  }

  // Chrome's checks of a new item, in its order.
  function menuCreateError(p, id) {
    if (CONFIG.firefoxBuild) {
      return firefoxMenuCreateError(p, id);
    }
    if (p.id == null && LAZY_BACKGROUND && !CONFIG.firefoxBuild) {
      return "Extensions using event pages or Service Workers must pass an id parameter to " +
        "chrome.contextMenus.create";
    }
    if (Object.keys(menuItems).length >= MAX_MENU_ITEMS) {
      return "An extension can create a maximum of " + MAX_MENU_ITEMS + " menu items.";
    }
    if (menuItems[String(id)]) {
      return "Cannot create item with duplicate id " + id;
    }
    if (LAZY_BACKGROUND && p.onclick) {
      return "Extensions using event pages or Service Workers cannot pass an onclick parameter " +
        "to chrome.contextMenus.create. Instead, use the chrome.contextMenus.onClicked event.";
    }
    if (!p.title && (p.type || "normal") !== "separator") {
      return "All menu items except for separators must have a title";
    }
    return p.parentId != null ? menuParentError(p.parentId) : null;
  }

  function removeMenuItem(id) {
    delete menuItems[String(id)];
    Object.keys(menuItems).forEach(function (key) {
      if (menuItems[key] && menuItems[key].parentId === id) {
        removeMenuItem(menuItems[key].id);
      }
    });
  }

  // contextMenus.create returns the item's id, and reports what went wrong to
  // its callback, or to the console when it has none.
  function menuReply(cb, error) {
    setTimeout(function () {
      if (typeof cb === "function") {
        WEX.lastError = error ? { message: error } : null;
        try {
          cb();
        } catch (e) {
          log.error("callback threw", e);
          if (WEX.testException) {
            WEX.testException(e);
          }
        }
        WEX.lastError = null;
      } else if (error) {
        console.error("Unchecked runtime.lastError: " + error);
      }
    }, 0);
  }

  function menuDone(cb, error) {
    return error ? WEX.fail(cb, error) : done(cb);
  }

  function menuItemForCommand(command) {
    var id = command.slice(MENU_COMMAND.length);
    return menuItems[id] || null;
  }

  // A browser puts the selected text where a title says %s, cut to fit a menu.
  var MENU_SELECTION_LENGTH = 64;

  function withSelection(title, info) {
    var text = info && info.selectionText;
    if (!text) {
      return title;
    }
    var shown = text.length > MENU_SELECTION_LENGTH ? text.slice(0, MENU_SELECTION_LENGTH) + "\u2026" : text;
    return title.replace(/%s/g, function () {
      return shown;
    });
  }

  var nativeActionMenus = [];
  var nativeActionMenuSequence = 1;
  var ACTION_MENU_CONTEXTS = ["action", "browser_action", "page_action"];

  function wantsActionMenu(item) {
    return (item.contexts || ["page"]).some(function (context) {
      return context === "all" || ACTION_MENU_CONTEXTS.indexOf(context) >= 0;
    });
  }

  function actionMenuItemVisible(item, url) {
    return item.visible !== false && (!item.documentUrlPatterns || !item.documentUrlPatterns.length ||
      WEX.matchesAny(url || "", item.documentUrlPatterns));
  }

  // The action-menu children under `parentId` for the active tab. An ancestor
  // is retained when one of its descendants belongs on the action menu, even
  // when the ancestor only serves to group those descendants.
  function actionMenuTree(parentId, url) {
    var out = [];
    Object.keys(menuItems).forEach(function (key) {
      var item = menuItems[key];
      if ((item.parentId == null ? null : String(item.parentId)) !==
          (parentId == null ? null : String(parentId)) || !actionMenuItemVisible(item, url)) {
        return;
      }
      var children = actionMenuTree(item.id, url);
      if (wantsActionMenu(item) || children.length) {
        out.push({ item: item, children: children });
      }
    });
    return out;
  }

  function clearNativeMenu(menu) {
    try {
      while (menu.menuItems && menu.menuItems.length) {
        menu.removeMenuItem(0);
      }
    } catch (e) { /* a menu may be disappearing with its window */ }
  }

  function submenuFor(entry, key) {
    if (entry.submenus[key]) {
      return entry.submenus[key];
    }
    try {
      var id = "wex-action-submenu-" + (nativeActionMenuSequence++);
      entry.submenus[key] = ext.createMenu(id);
      return entry.submenus[key];
    } catch (e) {
      return null;
    }
  }

  function appendNativeActionItems(entry, menu, nodes) {
    nodes.forEach(function (node) {
      var item = node.item;
      var nativeItem;
      try {
        var identifier = "wex-action-item-" + entry.number + "-" + String(item.id);
        nativeItem = item.type === "separator" ? menu.appendSeparator(identifier) :
          menu.appendMenuItem(identifier, String(item.title || ""), MENU_COMMAND + String(item.id));
        nativeItem.disabled = item.enabled === false;
        if (item.type === "checkbox" || item.type === "radio") {
          // SafariExtensionMenuItem's constants are UNCHECKED=0 and CHECKED=1.
          nativeItem.checkedState = item.checked ? 1 : 0;
        }
        if (node.children.length) {
          var submenu = submenuFor(entry, String(item.id));
          if (submenu) {
            clearNativeMenu(submenu);
            appendNativeActionItems(entry, submenu, node.children);
            nativeItem.submenu = submenu;
          }
        }
      } catch (e) {
        log.warn("could not add an action menu item", e);
      }
    });
  }

  function actionMenuEntryForToolbar(item) {
    for (var i = 0; i < nativeActionMenus.length; i++) {
      if (nativeActionMenus[i].toolbarItem === item) {
        return nativeActionMenus[i];
      }
    }
    if (!ext || typeof ext.createMenu !== "function") {
      return null;
    }
    try {
      var number = nativeActionMenuSequence++;
      var entry = { toolbarItem: item, number: number, submenus: {}, menu: null };
      entry.menu = ext.createMenu("wex-action-menu-" + number);
      nativeActionMenus.push(entry);
      return entry;
    } catch (e) {
      log.warn("could not make the action's native menu", e);
      return null;
    }
  }

  function rebuildNativeActionMenu(entry) {
    var item = entry && entry.toolbarItem;
    var win = item && item.browserWindow;
    var tab = win && win.activeTab;
    var tree = actionMenuTree(null, tab && tab.url);
    clearNativeMenu(entry.menu);
    if (tree.length) {
      appendNativeActionItems(entry, entry.menu, tree);
    }
    return tree.length ? entry.menu : null;
  }

  function nativeActionMenuForToolbar(item) {
    // Do not create a Safari menu until there is something for it to show.
    var win = item && item.browserWindow;
    var tab = win && win.activeTab;
    if (!actionMenuTree(null, tab && tab.url).length) {
      return null;
    }
    var entry = actionMenuEntryForToolbar(item);
    return entry ? rebuildNativeActionMenu(entry) : null;
  }

  function refreshNativeActionMenus() {
    nativeActionMenus.forEach(function (entry) {
      rebuildNativeActionMenu(entry);
    });
    refreshToolbar();
  }

  function menuContextsFor(info) {
    var out = ["all"];
    if (info.selectionText) {
      out.push("selection");
    }
    if (info.linkUrl) {
      out.push("link");
    }
    if (info.srcUrl && info.mediaType) {
      out.push(info.mediaType);
    }
    if (info.editable) {
      out.push("editable");
    }
    if (info.frameUrl) {
      out.push("frame");
    }
    // "page" is the least specific context, which applies when none of
    // the others but "frame" does.
    if (!info.selectionText && !info.linkUrl && !info.mediaType && !info.editable) {
      out.push("page");
    }
    return out;
  }

  // Safari leaves a disabled item out of a context menu, where a browser would
  // show it greyed.
  function menuApplies(item, info) {
    if (item.enabled === false || item.visible === false) {
      return false;
    }
    if (item.type === "separator") {
      return false;
    }
    var wanted = item.contexts || ["page"];
    var available = menuContextsFor(info);
    // An empty list of patterns, as none, restricts nothing.
    var targets = item.targetUrlPatterns && item.targetUrlPatterns.length ? item.targetUrlPatterns : null;
    function targetMatches(url) {
      return !targets || (!!url && WEX.matchesAny(url, targets));
    }
    var hit = wanted.some(function (c) {
      if (available.indexOf(c) < 0) {
        return false;
      }
      // Chrome holds the link context to targetUrlPatterns by the link,
      // and a media context by the element's source, and no other context.
      if (!CONFIG.firefoxBuild && c === "link") {
        return targetMatches(info.linkUrl);
      }
      if (!CONFIG.firefoxBuild && c === info.mediaType) {
        return targetMatches(info.srcUrl);
      }
      return true;
    });
    if (!hit) {
      return false;
    }
    // Firefox shows an item with targetUrlPatterns only on a link or a
    // media element one of them matches.
    if (CONFIG.firefoxBuild && targets && !targetMatches(info.linkUrl) && !targetMatches(info.srcUrl)) {
      return false;
    }
    // The document is the frame clicked in.
    if (item.documentUrlPatterns && item.documentUrlPatterns.length &&
        !WEX.matchesAny(info.frameUrl || info.pageUrl || "", item.documentUrlPatterns)) {
      return false;
    }
    return true;
  }

  var pendingMenuInfo = {};

  // ------------------------------------------------------------------ //
  // Content scripts registered at run time
  // ------------------------------------------------------------------ //
  // Safari takes content scripts and style sheets at run time too, and runs
  // them in the extension's content-script world beside the bridge.
  var dynamicContentScripts = {};
  // The user scripts (userScripts), by id, and where they are kept.
  var userScriptEntries = {};
  var USER_SCRIPTS_KEY = "wex.userScripts";

  // The scripts for the page's own world, which the engine runs as the
  // page's own scripts start, whatever its policy (the engine's
  // scripting.registerContentScripts): the bundle's (CONFIG.pageWorldScripts)
  // and those the extension registers for that world. The engine keeps them
  // across sessions, so the global page brings its list in line with these
  // as it starts and whenever they change.
  var engineScripting = native && native.scripting &&
    typeof native.scripting.registerContentScripts === "function" ? native.scripting : null;
  var pageWorldSync = Promise.resolve();
  var DYNAMIC_PAGE_WORLD_PREFIX = "wex.dynamic.";
  var PAGE_WORLD_RAN_FILE = "wex/wex-page-world-ran.js";
  var PAGE_WORLD_RAN = "wex-page-world-ran:" + CONFIG.extensionId;
  var PAGE_WORLD_ASK = "wex-page-world-ask:" + CONFIG.extensionId;

  // `counted` adds the file that tells the content scripts registered after
  // the script that it has run (waitForPageWorld).
  function enginePageWorldScript(id, spec, counted) {
    var js = (spec.js || []).filter(function (entry) {
      return typeof entry === "string";
    });
    if (js.length !== (spec.js || []).length) {
      log.warn("the content script " + spec.id + " for the page's world names its code, which only a file can give");
    }
    if (counted && js.length) {
      js = js.concat([PAGE_WORLD_RAN_FILE]);
    }
    return {
      id: id, matches: spec.matches || [], excludeMatches: spec.excludeMatches || [], js: js,
      allFrames: !!spec.allFrames, matchOriginAsFallback: !!spec.matchOriginAsFallback,
      runAt: spec.runAt || "document_idle", world: "MAIN", persistAcrossSessions: true
    };
  }

  function samePageWorldScript(a, b) {
    return ["matches", "excludeMatches", "js", "allFrames", "matchOriginAsFallback", "runAt"].every(function (key) {
      return JSON.stringify(a[key]) === JSON.stringify(b[key]);
    });
  }

  function syncPageWorldScripts() {
    if (!engineScripting) {
      return;
    }
    var wanted = (CONFIG.pageWorldScripts || []).map(function (spec) {
      return enginePageWorldScript(spec.id, spec);
    });
    Object.keys(dynamicContentScripts).forEach(function (id) {
      var spec = dynamicContentScripts[id].spec;
      if (spec.world === "MAIN") {
        wanted.push(enginePageWorldScript(DYNAMIC_PAGE_WORLD_PREFIX + id, spec, true));
      }
    });
    Object.keys(userScriptEntries).forEach(function (id) {
      if (userScriptEntries[id].page) {
        wanted.push(userScriptEntries[id].page);
      }
    });
    wanted = wanted.filter(function (spec) {
      return spec.js.length && spec.matches.length;
    });
    pageWorldSync = pageWorldSync.then(function () {
      return engineScripting.getRegisteredContentScripts();
    }).then(function (registered) {
      var have = {};
      registered.forEach(function (script) {
        have[script.id] = script;
      });
      var stale = registered.filter(function (script) {
        return !wanted.some(function (spec) {
          return spec.id === script.id;
        });
      }).map(function (script) {
        return script.id;
      });
      var changed = wanted.filter(function (spec) {
        return have[spec.id] && !samePageWorldScript(have[spec.id], spec);
      });
      var added = wanted.filter(function (spec) {
        return !have[spec.id];
      });
      return Promise.resolve(stale.length ? engineScripting.unregisterContentScripts({ ids: stale }) : null)
        .then(function () {
          return changed.length ? engineScripting.updateContentScripts(changed) : null;
        }).then(function () {
          return added.length ? engineScripting.registerContentScripts(added) : null;
        });
    }).then(null, function (e) {
      log.warn("could not register the scripts for the page's own world", e);
    });
  }

  function safariPatterns(patterns) {
    var out = [];
    (patterns || []).forEach(function (pattern) {
      var p = String(pattern);
      if (p === "<all_urls>") {
        out.push("http://*/*", "https://*/*");
      } else if (p.indexOf("*://") === 0) {
        out.push("http" + p.slice(1), "https" + p.slice(1));
      } else {
        out.push(p);
      }
    });
    return out;
  }

  // Chrome runs a document's content scripts in the order they were
  // registered, whatever their world. Safari runs the extension's world's
  // before or after the engine's for the page's world as it happens, so a
  // script registered after scripts for the page's world waits for those of
  // them that apply to its frame: each counts its run in the page's world
  // (wex-page-world-ran.js) and announces it, and the script asks for the
  // count, both by events, which reach every world at once.
  function waitForPageWorld(script, before) {
    var scripts = before.map(function (spec) {
      return { matches: spec.matches || [], excludeMatches: spec.excludeMatches || [], allFrames: !!spec.allFrames };
    });
    return "(function (run, self) {\n" +
      "  var scripts = " + JSON.stringify(scripts) + ";\n" +
      "  var d = self.document, url = self.location.href, top = self === self.top, need = 0;\n" +
      "  var match = typeof WEX !== \"undefined\" && WEX && WEX.matchesAny;\n" +
      "  scripts.forEach(function (s) {\n" +
      "    if (match && (top || s.allFrames) && match(url, s.matches) && !match(url, s.excludeMatches)) {\n" +
      "      need += 1;\n" +
      "    }\n" +
      "  });\n" +
      "  function ran() {\n" +
      "    var ask = new CustomEvent(" + JSON.stringify(PAGE_WORLD_ASK) + ", { detail: need, cancelable: true });\n" +
      "    d.dispatchEvent(ask);\n" +
      "    return ask.defaultPrevented;\n" +
      "  }\n" +
      "  if (!need || ran()) {\n" +
      "    return run.call(self);\n" +
      "  }\n" +
      "  d.addEventListener(" + JSON.stringify(PAGE_WORLD_RAN) + ", function wait() {\n" +
      "    if (ran()) {\n" +
      "      d.removeEventListener(" + JSON.stringify(PAGE_WORLD_RAN) + ", wait, true);\n" +
      "      run.call(self);\n" +
      "    }\n" +
      "  }, true);\n" +
      "})(function () {\n" + script + "\n}, this);\n";
  }

  // `before` are the scripts for the page's world registered ahead of it
  // that run no later than it does, which its scripts wait for.
  function addContentScripts(spec, before) {
    var whitelist = safariPatterns(spec.matches);
    var blacklist = safariPatterns(spec.excludeMatches);
    var atEnd = spec.runAt !== "document_start";
    var handles = { scripts: [], sheets: [] };

    function text(entry) {
      if (entry && typeof entry === "object") {
        return entry.code != null ? String(entry.code) : WEX.readTextSync(entry.file);
      }
      return WEX.readTextSync(WEX.extPath(WEX.extUrl(entry)));
    }

    // Safari runs a script it is given in every frame; one Chrome runs in
    // the top frame alone asks first which frame it is in. A script for the
    // page's own world is the engine's (syncPageWorldScripts).
    (spec.world === "MAIN" ? [] : spec.js || []).forEach(function (entry) {
      var source = text(entry);
      if (source == null) {
        return;
      }
      var script = source;
      if (!spec.allFrames) {
        var topOnly = WEX.guardedScript(script, "window === window.top");
        if (topOnly === null) {
          log.warn("the content script " + spec.id + " runs in every frame, as its source could not be followed");
        } else {
          script = topOnly;
        }
      }
      // The bridge makes the content scripts' chrome before the script runs.
      script = "if (typeof WEXContent !== \"undefined\" && WEXContent && WEXContent.prepare) " +
        "WEXContent.prepare();\n" + script;
      if (before && before.length) {
        script = waitForPageWorld(script, before);
      }
      handles.scripts.push(ext.addContentScript(script, whitelist, blacklist, atEnd));
    });
    (spec.css || []).forEach(function (entry) {
      var source = text(entry);
      if (source != null) {
        handles.sheets.push(ext.addContentStyleSheet(source, whitelist, blacklist));
      }
    });
    liveScriptHandles.push(handles);
    return handles;
  }

  // Safari keeps a registration past the reload of the global page that
  // made it, and the scripts that persist are registered again when it
  // starts, so each is withdrawn as the page unloads.
  var liveScriptHandles = [];
  g.addEventListener("unload", function () {
    liveScriptHandles.slice().forEach(removeContentScripts);
  }, false);

  function removeContentScripts(handles) {
    var i = liveScriptHandles.indexOf(handles);
    if (i >= 0) {
      liveScriptHandles.splice(i, 1);
    }
    handles.scripts.forEach(function (url) {
      try {
        ext.removeContentScript(url);
      } catch (e) { /* ignore */ }
    });
    handles.sheets.forEach(function (url) {
      try {
        ext.removeContentStyleSheet(url);
      } catch (e) { /* ignore */ }
    });
  }

  var PHASES = { document_start: 0, document_end: 1, document_idle: 1 };

  // The scripts for the page's world registered ahead of `id` that run no
  // later than it does.
  function pageWorldScriptsBefore(id) {
    if (!engineScripting) {
      return [];
    }
    var spec = dynamicContentScripts[id].spec;
    var ids = Object.keys(dynamicContentScripts);
    return ids.slice(0, ids.indexOf(id)).map(function (other) {
      return dynamicContentScripts[other].spec;
    }).filter(function (other) {
      return other.world === "MAIN" && (other.js || []).length &&
        PHASES[other.runAt] <= PHASES[spec.runAt];
    });
  }

  // Adds a registered script to Safari's. One that waits for scripts for
  // the page's world is added once the engine has them, so that no page
  // waits for a script the engine does not run.
  function addRegistered(entry) {
    var before = entry.spec.world === "MAIN" ? [] : pageWorldScriptsBefore(entry.spec.id);
    if (!before.length) {
      entry.handles = addContentScripts(entry.spec);
      return;
    }
    pageWorldSync.then(function () {
      if (dynamicContentScripts[entry.spec.id] === entry) {
        removeContentScripts(entry.handles);
        entry.handles = addContentScripts(entry.spec, pageWorldScriptsBefore(entry.spec.id));
      }
    });
  }

  // A script that changes keeps its place among the others, as Chrome's
  // updateContentScripts keeps it; the scripts after one for the page's
  // world are added again with what they wait for.
  function registerContentScript(spec) {
    var old = dynamicContentScripts[spec.id];
    if (old) {
      removeContentScripts(old.handles);
    }
    var entry = { spec: spec, handles: { scripts: [], sheets: [] } };
    dynamicContentScripts[spec.id] = entry;
    if (spec.world === "MAIN" || (old && old.spec.world === "MAIN")) {
      syncPageWorldScripts();
      readdFrom(Object.keys(dynamicContentScripts).indexOf(spec.id) + 1);
    }
    addRegistered(entry);
  }

  // Adds again the scripts from position `index` on that are not for the
  // page's world.
  function readdFrom(index) {
    Object.keys(dynamicContentScripts).slice(index).forEach(function (other) {
      var entry = dynamicContentScripts[other];
      if (entry.spec.world !== "MAIN") {
        removeContentScripts(entry.handles);
        entry.handles = { scripts: [], sheets: [] };
        addRegistered(entry);
      }
    });
  }

  // scripting.registerContentScripts as Chrome checks it, and the script as
  // Chrome describes it back: every field given its default, and the files
  // named from the extension's root.
  function scriptIdError(id) {
    if (!id) {
      return "Script's ID must not be empty";
    }
    if (String(id).charAt(0) === "_") {
      return "Script's ID '" + id + "' must not start with '_'";
    }
    return null;
  }

  // URLPattern's parse errors (extensions/common/url_pattern.cc), for the
  // schemes a content script may match.
  function matchPatternError(pattern) {
    var p = String(pattern);
    if (p === "<all_urls>") {
      return null;
    }
    var separator = p.indexOf("://");
    if (separator < 0) {
      return "Missing scheme separator.";
    }
    if (["*", "http", "https", "file", "ftp"].indexOf(p.slice(0, separator)) < 0) {
      return "Invalid scheme.";
    }
    var rest = p.slice(separator + 3);
    var slash = rest.indexOf("/");
    if (slash < 0) {
      return "Empty path.";
    }
    var host = rest.slice(0, slash);
    var colon = host.lastIndexOf(":");
    if (colon >= 0 && host.indexOf("]") < colon) {
      var port = host.slice(colon + 1);
      if (port !== "*" && !/^\d+$/.test(port)) {
        return "Invalid port.";
      }
      host = host.slice(0, colon);
    }
    if (!host && p.slice(0, separator) !== "file") {
      return "Host can not be empty.";
    }
    if (host.indexOf("*", 1) >= 0 || (host.charAt(0) === "*" && host.length > 1 && host.charAt(1) !== ".")) {
      return "Invalid host wildcard.";
    }
    return null;
  }

  function scriptSpecError(script) {
    if (!script.matches) {
      return "Script with ID '" + script.id + "' must specify 'matches'.";
    }
    if (!script.matches.length) {
      return "Script with ID '" + script.id + "' must specify at least one match.";
    }
    var lists = [["matches", script.matches], ["exclude_matches", script.excludeMatches || []]];
    for (var l = 0; l < lists.length; l++) {
      for (var m = 0; m < lists[l][1].length; m++) {
        var patternError = matchPatternError(lists[l][1][m]);
        if (patternError) {
          return "Script with ID '" + script.id + "' has invalid value for " + lists[l][0] + "[" + m +
            "]: " + patternError;
        }
        if (script.matchOriginAsFallback && lists[l][0] === "matches" &&
            !/^[^:]+:\/\/[^\/]*\/\*$/.test(String(lists[l][1][m])) && lists[l][1][m] !== "<all_urls>") {
          return "The path component for scripts with 'match_origin_as_fallback' must be '*'.";
        }
      }
    }
    if (![].concat(script.js || [], script.css || []).length) {
      return "Script with ID '" + script.id + "' must specify at least one js or css file.";
    }
    var kinds = [["javascript", script.js || []], ["css", script.css || []]];
    for (var k = 0; k < kinds.length; k++) {
      for (var i = 0; i < kinds[k][1].length; i++) {
        var path = String(kinds[k][1][i]).replace(/^\/+/, "");
        if (WEX.readTextSync(WEX.extPath(WEX.extUrl(path))) == null) {
          return "Could not load " + kinds[k][0] + " '" + path + "' for script.";
        }
      }
    }
    return null;
  }

  function normalizedScript(script) {
    var out = { id: script.id, matches: script.matches.slice() };
    if (script.excludeMatches) {
      out.excludeMatches = script.excludeMatches.slice();
    }
    ["css", "js"].forEach(function (key) {
      if (script[key]) {
        out[key] = script[key].map(function (file) {
          return String(file).replace(/^\/+/, "");
        });
      }
    });
    out.allFrames = !!script.allFrames;
    out.runAt = script.runAt || "document_idle";
    out.matchOriginAsFallback = !!script.matchOriginAsFallback;
    out.persistAcrossSessions = script.persistAcrossSessions !== false;
    out.world = script.world || "ISOLATED";
    return out;
  }

  // Scripts that persist across sessions come back when the extension
  // starts, as in Chrome.
  var SCRIPTS_KEY = "wex.dynamicScripts";

  function saveContentScripts() {
    settingsItem(SCRIPTS_KEY, JSON.stringify(Object.keys(dynamicContentScripts).map(function (id) {
      return dynamicContentScripts[id].spec;
    }).filter(function (spec) {
      return spec.persistAcrossSessions;
    })));
  }

  (function loadContentScripts() {
    try {
      var stored = JSON.parse(settingsItem(SCRIPTS_KEY) || "null");
      (Array.isArray(stored) ? stored : []).forEach(registerContentScript);
    } catch (e) { /* none kept */ }
    syncPageWorldScripts();
  })();

  function unregisterContentScript(id) {
    var entry = dynamicContentScripts[id];
    if (entry) {
      removeContentScripts(entry.handles);
      var index = Object.keys(dynamicContentScripts).indexOf(id);
      delete dynamicContentScripts[id];
      if (entry.spec.world === "MAIN") {
        syncPageWorldScripts();
        readdFrom(index);
      }
    }
  }

  // ------------------------------------------------------------------ //
  // The chrome namespace
  // ------------------------------------------------------------------ //
  var i18n = WEX.makeI18n();
  var manifest = WEX.localizeManifest(CONFIG.manifest || {}, i18n);

  // What management tells of the extension itself.
  // Chrome's home page for an extension is the manifest's, or, for one the
  // Web Store updates, its page there.
  var STORE_UPDATE_URL = /^https:\/\/clients2\.google\.com\/service\/update2\/crx/;

  function selfInfo() {
    var info = {
      id: WEX.runtimeId,
      name: manifest.name,
      shortName: manifest.short_name || manifest.name,
      description: manifest.description || "",
      version: manifest.version,
      isApp: false,
      enabled: true,
      mayDisable: true,
      type: "extension",
      installType: CONFIG.installType || "normal",
      offlineEnabled: !!manifest.offline_enabled,
      optionsUrl: CONFIG.optionsPage ? WEX.extUrl(CONFIG.optionsPage) : "",
      permissions: (manifest.permissions || []).filter(function (p) {
        return typeof p === "string" && !isHostPattern(p);
      }),
      hostPermissions: (manifest.host_permissions || []).concat((manifest.permissions || []).filter(isHostPattern))
    };
    if (manifest.version_name) {
      info.versionName = String(manifest.version_name);
    }
    var fromStore = typeof manifest.update_url === "string" && STORE_UPDATE_URL.test(manifest.update_url);
    if (typeof manifest.homepage_url === "string" && manifest.homepage_url) {
      info.homepageUrl = manifest.homepage_url;
    } else if (fromStore && CONFIG.extensionId) {
      info.homepageUrl = "https://chromewebstore.google.com/detail/" + CONFIG.extensionId;
    }
    if (typeof manifest.update_url === "string" && manifest.update_url) {
      info.updateUrl = manifest.update_url;
    }
    var icons = manifest.icons && typeof manifest.icons === "object" ? manifest.icons : {};
    var sizes = Object.keys(icons).filter(function (size) {
      return /^\d+$/.test(size) && typeof icons[size] === "string";
    }).sort(function (a, b) {
      return a - b;
    });
    if (sizes.length) {
      info.icons = sizes.map(function (size) {
        return { size: Number(size), url: WEX.extUrl(icons[size]) };
      });
    }
    return info;
  }

  function isHostPattern(p) {
    return typeof p === "string" && (p === "<all_urls>" || p.indexOf("://") > 0);
  }

  var runtimeOnInstalled = new Event("runtime.onInstalled");
  var runtimeOnStartup = new Event("runtime.onStartup");
  var runtimeOnExtensionLoaded = new Event("runtime.onExtensionLoaded");
  var actionOnClicked = new Event("action.onClicked");
  // Whether a click is reported decides whether the toolbar item carries the
  // action-context menu (fitToPopup).
  ["addListener", "removeListener"].forEach(function (name) {
    var change = actionOnClicked[name];
    actionOnClicked[name] = function () {
      var result = change.apply(this, arguments);
      refreshToolbar();
      return result;
    };
  });
  var contextMenusOnClicked = new Event("contextMenus.onClicked");
  var contextMenusOnShown = new Event("contextMenus.onShown");
  var contextMenusOnHidden = new Event("contextMenus.onHidden");
  var commandsOnCommand = new Event("commands.onCommand");
  var alarmsOnAlarm = new Event("alarms.onAlarm");
  var windowsOnCreated = new Event("windows.onCreated");
  var windowsOnRemoved = new Event("windows.onRemoved");
  var sessionsOnChanged = new Event("sessions.onChanged");
  var MAX_SESSION_RESULTS = 25;
  var closedSessions = [];
  var closingWindows = {};
  var nextSessionId = 1;
  var windowsOnFocusChanged = new Event("windows.onFocusChanged");
  var tabsOnActivated = new Event("tabs.onActivated");
  var tabsOnSelectionChanged = new Event("tabs.onSelectionChanged");
  var tabsOnActiveChanged = new Event("tabs.onActiveChanged");
  var tabsOnHighlightChanged = new Event("tabs.onHighlightChanged");
  var tabsOnUpdated = new Event("tabs.onUpdated");
  var tabsOnRemoved = new Event("tabs.onRemoved");
  var tabsOnCreated = new Event("tabs.onCreated");
  var tabsOnMoved = new Event("tabs.onMoved");
  var tabsOnAttached = new Event("tabs.onAttached");
  var tabsOnDetached = new Event("tabs.onDetached");

  // ------------------------------------------------------------------ //
  // Tab groups
  // ------------------------------------------------------------------ //
  // Safari draws no tab groups. The runtime keeps them: which tabs are in
  // which group, and the group's title, color and collapsed state, for
  // Chrome's calls and events. A group's tabs are kept together in their
  // window, and a collapsed group's tabs are hidden from the tab bar with the
  // engine's tabs.hide, the tab a window shows excepted. Groups name their
  // tabs by WebKit's ids, which last as long as the tabs, and are kept with
  // the extension's settings so that they outlast the global page. A later
  // run of the browser restores the tabs under other ids, and after the global
  // page starts: a kept member goes to the tab showing the address kept for it,
  // its own id's tab first, and waits a while for that tab to arrive.
  var TAB_GROUPS_KEY = "wex.tabGroups";
  var TAB_GROUP_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
  var tabGroupsOnCreated = new Event("tabGroups.onCreated");
  var tabGroupsOnUpdated = new Event("tabGroups.onUpdated");
  var tabGroupsOnMoved = new Event("tabGroups.onMoved");
  var tabGroupsOnRemoved = new Event("tabGroups.onRemoved");
  var tabGroupState = { nextId: 1, groups: {}, members: {} };
  // The addresses of the kept members, until the tabs have been looked up.
  var uncheckedGroupMembers = null;
  // The kept members whose tabs have not arrived, with the group of each.
  var KEPT_MEMBER_WAIT = 20000;
  var KEPT_MEMBER_LOOK = 500;
  var waitingMembers = null;
  var waitingMembersLook = null;

  (function loadTabGroups() {
    try {
      var kept = JSON.parse(settingsItem(TAB_GROUPS_KEY) || "null");
      if (kept && kept.groups && kept.members) {
        uncheckedGroupMembers = {};
        Object.keys(kept.members).forEach(function (id) {
          uncheckedGroupMembers[id] = kept.urls && kept.urls[id] || "";
        });
        tabGroupState = { nextId: kept.nextId, groups: kept.groups, members: kept.members };
      }
    } catch (e) { /* none kept */ }
  })();

  function saveTabGroups() {
    if (uncheckedGroupMembers || waitingMembers) {
      return;
    }
    var urls = {};
    Object.keys(tabGroupState.members).forEach(function (id) {
      var t = tabForId(Number(id));
      if (t && t.url) {
        urls[id] = t.url;
      }
    });
    settingsItem(TAB_GROUPS_KEY, JSON.stringify({
      nextId: tabGroupState.nextId, groups: tabGroupState.groups, members: tabGroupState.members, urls: urls
    }));
  }

  function checkKeptGroups() {
    var kept = uncheckedGroupMembers;
    uncheckedGroupMembers = null;
    if (!kept) {
      return;
    }
    waitingMembers = [];
    Object.keys(kept).forEach(function (id) {
      var t = tabForId(Number(id));
      var shown = keptPage(t && t.url);
      if (!shown || shown === "about:blank" || shown !== keptPage(kept[id])) {
        waitingMembers.push({ url: keptPage(kept[id]), groupId: tabGroupState.members[id] });
        delete tabGroupState.members[id];
      }
    });
    placeWaitingMembers();
    if (waitingMembers) {
      waitingMembersLook = setInterval(function () {
        identifyAll().then(placeWaitingMembers);
      }, KEPT_MEMBER_LOOK);
      setTimeout(finishKeptGroups, KEPT_MEMBER_WAIT);
    }
  }

  function keptPage(url) {
    return String(url || "").split("#")[0];
  }

  function placeWaitingMembers() {
    if (!waitingMembers) {
      return;
    }
    waitingMembers = waitingMembers.filter(function (member) {
      var match = member.url && allTabs().filter(function (t) {
        var id = idForTab(t);
        return id !== undefined && keptPage(t.url) === member.url && tabGroupState.members[id] == null;
      })[0];
      if (!match) {
        return true;
      }
      tabGroupState.members[idForTab(match)] = member.groupId;
      return false;
    });
    if (!waitingMembers.length) {
      finishKeptGroups();
    }
  }

  function finishKeptGroups() {
    if (!waitingMembers) {
      return;
    }
    waitingMembers = null;
    clearInterval(waitingMembersLook);
    dropEmptyGroups();
    Object.keys(tabGroupState.groups).forEach(function (groupId) {
      if (tabGroupState.groups[groupId].collapsed) {
        setTabsHidden(groupTabIds(groupId), true);
      }
    });
    saveTabGroups();
  }
  WEX.finishKeptGroups = finishKeptGroups;

  function groupIdOf(tabId) {
    var groupId = tabGroupState.members[tabId];
    return groupId != null && tabGroupState.groups[groupId] ? Number(groupId) : -1;
  }

  // The group's tabs that are open, in tab order.
  function groupTabs(groupId) {
    var out = [];
    allTabs().forEach(function (t) {
      if (groupIdOf(idForTab(t)) === Number(groupId)) {
        out.push(t);
      }
    });
    return out;
  }

  function groupInfo(groupId) {
    var group = tabGroupState.groups[groupId];
    if (!group) {
      return null;
    }
    var first = groupTabs(groupId)[0];
    return {
      id: Number(groupId),
      collapsed: !!group.collapsed,
      color: group.color,
      title: group.title || "",
      windowId: first && first.browserWindow ? windowIdFor(tabWindow(first)) : -1,
      shared: false
    };
  }

  // Groups left with no tab are gone, as in Chrome.
  function dropEmptyGroups() {
    if (waitingMembers) {
      return;
    }
    Object.keys(tabGroupState.groups).forEach(function (groupId) {
      var open = Object.keys(tabGroupState.members).some(function (tabId) {
        return String(tabGroupState.members[tabId]) === groupId && tabForId(Number(tabId));
      });
      if (!open) {
        var info = groupInfo(groupId);
        delete tabGroupState.groups[groupId];
        tabGroupsOnRemoved.emit(info);
      }
    });
    Object.keys(tabGroupState.members).forEach(function (tabId) {
      if (!tabGroupState.groups[tabGroupState.members[tabId]]) {
        delete tabGroupState.members[tabId];
      }
    });
  }

  // Resolves once the engine has answered. A hidden tab's window and place
  // are remembered, and a tab that shows again goes back to them.
  function setTabsHidden(tabIds, hidden) {
    var engine = native.tabs;
    if (!tabIds.length || !engine || typeof engine.hide !== "function") {
      return Promise.resolve();
    }
    var ids = tabIds.filter(function (id) {
      return id < WEX.PROVISIONAL_TAB_ID;
    });
    if (!ids.length) {
      return Promise.resolve();
    }
    var tabs = ids.map(tabForId).filter(Boolean);
    if (hidden) {
      tabs.forEach(function (t) {
        if (!isHiddenTab(t) && t.browserWindow) {
          hiddenTabHomes.set(t, { window: t.browserWindow, index: t.browserWindow.tabs.indexOf(t) });
        }
      });
      return Promise.resolve(engine.hide(ids)).catch(function () {});
    }
    var returning = tabs.filter(isHiddenTab);
    return Promise.resolve(engine.show(ids)).then(function () {
      returning.map(function (t) {
        var home = hiddenTabHomes.get(t);
        hiddenTabHomes.delete(t);
        return { tab: t, home: home };
      }).filter(function (entry) {
        return entry.home && app.browserWindows.indexOf(entry.home.window) >= 0;
      }).sort(function (a, b) {
        return a.home.index - b.home.index;
      }).forEach(function (entry) {
        try {
          entry.home.window.insertTab(entry.tab, Math.min(entry.home.index, entry.home.window.tabs.length));
        } catch (e) { /* the tab stays where the engine put it */ }
      });
    }, function () {});
  }

  // Moves a tab to place `index` of window `w`, and reports the move. A
  // hidden tab stays hidden, and comes back there. Safari's insertTab puts a
  // tab before the one at the place it is given, counting the tab itself, so
  // a move later in its own window names the place after the one it ends at.
  function moveTab(t, w, index) {
    var from = tabWindow(t);
    var fromIndex = tabPosition(t);
    if (isHiddenTab(t)) {
      hiddenTabHomes.set(t, { window: w, index: index });
    } else {
      try {
        w.insertTab(t, from === w && fromIndex < index ? Math.min(index + 1, w.tabs.length) : index);
      } catch (e) {
        log.warn("could not move a tab", e);
        return;
      }
    }
    var id = idForTab(t);
    var toIndex = tabPosition(t);
    if (from !== w) {
      tabsOnDetached.emit(id, { oldWindowId: windowIdFor(from), oldPosition: fromIndex });
      tabsOnAttached.emit(id, { newWindowId: windowIdFor(w), newPosition: toIndex });
    } else if (fromIndex !== toIndex) {
      tabsOnMoved.emit(id, { windowId: windowIdFor(w), fromIndex: fromIndex, toIndex: toIndex });
    }
    if (tabPlaces) {
      tabPlaces = currentTabPlaces();
    }
  }

  // Safari reports no move the user makes by dragging a tab, so while the
  // extension listens for moves the tabs' places are compared once a second.
  var TAB_PLACES_EVERY = 1000;
  var tabPlaces = null;

  function currentTabPlaces() {
    var places = { order: {}, where: {} };
    shownWindows().forEach(function (w) {
      var windowId = windowIdFor(w);
      var ids = [];
      w.tabs.forEach(function (t, index) {
        var id = idForTab(t);
        if (id !== undefined) {
          ids.push(id);
          places.where[id] = { windowId: windowId, index: index };
        }
      });
      places.order[windowId] = ids;
    });
    return places;
  }

  // The tab that moved between two orders of the same tabs: the one without
  // which they agree.
  function tabThatMoved(before, after) {
    function sameWithout(id) {
      var a = before.filter(function (other) { return other !== id; });
      var b = after.filter(function (other) { return other !== id; });
      return a.join() === b.join();
    }
    for (var i = 0; i < after.length; i++) {
      if (before[i] !== after[i]) {
        return sameWithout(after[i]) ? after[i] : sameWithout(before[i]) ? before[i] : after[i];
      }
    }
    return null;
  }

  function compareTabPlaces() {
    var before = tabPlaces;
    var now = currentTabPlaces();
    tabPlaces = now;
    if (!before) {
      return;
    }
    Object.keys(now.where).forEach(function (key) {
      var was = before.where[key];
      var is = now.where[key];
      if (was && was.windowId !== is.windowId) {
        var id = Number(key);
        tabsOnDetached.emit(id, { oldWindowId: was.windowId, oldPosition: was.index });
        tabsOnAttached.emit(id, { newWindowId: is.windowId, newPosition: is.index });
        var t = tabForId(id);
        if (t) {
          leaveGroup(t);
        }
      }
    });
    Object.keys(now.order).forEach(function (windowId) {
      var was = before.order[windowId];
      if (!was) {
        return;
      }
      var after = now.order[windowId].filter(function (id) { return was.indexOf(id) >= 0; });
      var prior = was.filter(function (id) { return after.indexOf(id) >= 0; });
      var moved = tabThatMoved(prior, after);
      if (moved !== null) {
        tabsOnMoved.emit(moved, { windowId: Number(windowId), fromIndex: before.where[moved].index,
          toIndex: now.where[moved].index });
      }
    });
  }

  [tabsOnMoved, tabsOnDetached, tabsOnAttached].forEach(function (event) {
    var add = event.addListener;
    event.addListener = function () {
      if (!tabPlaces) {
        tabPlaces = currentTabPlaces();
        setInterval(compareTabPlaces, TAB_PLACES_EVERY);
      }
      return add.apply(this, arguments);
    };
  });

  // A tab moved to another window on its own leaves its group, as in Chrome.
  // Resolves once a tab that was hidden shows again.
  function leaveGroup(t) {
    var id = idForTab(t);
    if (groupIdOf(id) === -1) {
      return Promise.resolve();
    }
    delete tabGroupState.members[id];
    var shown = isHiddenTab(t) ? setTabsHidden([id], false) : Promise.resolve();
    dropEmptyGroups();
    saveTabGroups();
    groupChanged([id]);
    return shown;
  }

  function groupTabIds(groupId) {
    return groupTabs(groupId).map(idForTab);
  }

  // Places the tabs `ids` together in window `w`, after the group's other
  // tabs there, or where the first of them is.
  function placeInGroup(groupId, w, ids) {
    var others = w.tabs.filter(function (t) {
      return groupIdOf(idForTab(t)) === groupId && ids.indexOf(idForTab(t)) < 0;
    });
    var index = others.length ? w.tabs.indexOf(others[others.length - 1]) + 1 :
      w.tabs.indexOf(tabForId(ids[0]));
    if (index < 0) {
      index = w.tabs.length;
    }
    ids.forEach(function (id) {
      var t = tabForId(id);
      var current = w.tabs.indexOf(t);
      if (current >= 0 && current < index) {
        index -= 1;
      }
      moveTab(t, w, index);
      index += 1;
    });
  }

  function groupChanged(tabIds) {
    tabIds.forEach(function (id) {
      var t = tabForId(id);
      if (t) {
        tabsOnUpdated.emit(id, { groupId: groupIdOf(id) }, tabInfo(t));
      }
    });
  }

  function groupTabsCall(options, cb) {
    var o = options || {};
    var ids = Array.isArray(o.tabIds) ? o.tabIds.slice() : o.tabIds != null ? [o.tabIds] : [];
    if (!ids.length) {
      return WEX.fail(cb, "You must specify at least one tab.");
    }
    for (var i = 0; i < ids.length; i++) {
      if (!tabForId(ids[i])) {
        return WEX.fail(cb, "No tab with id: " + ids[i] + ".");
      }
    }
    ids = ids.map(function (id) {
      return idForTab(tabForId(id));
    });
    var groupId = o.groupId;
    var w;
    var created = false;
    if (groupId != null) {
      if (!tabGroupState.groups[groupId]) {
        return WEX.fail(cb, "No group with id: " + groupId + ".");
      }
      if (o.createProperties) {
        return WEX.fail(cb, "Cannot specify 'createProperties' for an existing group.");
      }
      var members = groupTabs(groupId);
      w = tabWindow(members.length ? members[0] : tabForId(ids[0]));
    } else {
      var windowId = o.createProperties && o.createProperties.windowId;
      w = windowId != null ? windowForId(windowId) : tabWindow(tabForId(ids[0]));
      if (!w) {
        return WEX.fail(cb, "No window with id: " + windowId + ".");
      }
      groupId = tabGroupState.nextId++;
      tabGroupState.groups[groupId] = {
        title: "", collapsed: false,
        color: TAB_GROUP_COLORS[(groupId - 1) % TAB_GROUP_COLORS.length]
      };
      created = true;
    }
    groupId = Number(groupId);
    ids.forEach(function (id) {
      tabGroupState.members[id] = groupId;
      if (uncheckedGroupMembers) {
        delete uncheckedGroupMembers[id];
      }
    });
    if (created) {
      tabGroupsOnCreated.emit(groupInfo(groupId));
    }
    function join() {
      placeInGroup(groupId, w, ids);
      var group = tabGroupState.groups[groupId];
      if (group && group.collapsed) {
        setTabsHidden(ids, true);
      }
      dropEmptyGroups();
      saveTabGroups();
      groupChanged(ids);
      return groupId;
    }
    // A tab hidden with another group shows first, so that the engine knows it
    // is shown and can hide it again.
    var hiddenIds = ids.filter(function (id) {
      return isHiddenTab(tabForId(id));
    });
    if (hiddenIds.length) {
      return settle(setTabsHidden(hiddenIds, false).then(join), cb);
    }
    join();
    return done(cb, groupId);
  }

  function ungroupTabsCall(tabIds, cb) {
    var ids = Array.isArray(tabIds) ? tabIds.slice() : tabIds != null ? [tabIds] : [];
    if (!ids.length) {
      return WEX.fail(cb, "You must specify at least one tab.");
    }
    for (var i = 0; i < ids.length; i++) {
      if (!tabForId(ids[i])) {
        return WEX.fail(cb, "No tab with id: " + ids[i] + ".");
      }
    }
    ids = ids.map(function (id) {
      return idForTab(tabForId(id));
    }).filter(function (id) {
      return groupIdOf(id) !== -1;
    });
    ids.forEach(function (id) {
      delete tabGroupState.members[id];
    });
    setTabsHidden(ids, false);
    dropEmptyGroups();
    saveTabGroups();
    groupChanged(ids);
    return done(cb);
  }

  // Chrome expands a collapsed group when one of its tabs becomes active.
  tabsOnActivated.addListener(function (info) {
    var groupId = groupIdOf(info && info.tabId);
    var group = tabGroupState.groups[groupId];
    if (group && group.collapsed) {
      group.collapsed = false;
      setTabsHidden(groupTabIds(groupId), false);
      saveTabGroups();
      tabGroupsOnUpdated.emit(groupInfo(groupId));
    }
  });

  function makeTabGroups() {
    var noGroup = function (cb, groupId) {
      return WEX.fail(cb, "No group with id: " + groupId + ".");
    };
    return {
      TAB_GROUP_ID_NONE: -1,
      Color: {
        GREY: "grey", BLUE: "blue", RED: "red", YELLOW: "yellow", GREEN: "green",
        PINK: "pink", PURPLE: "purple", CYAN: "cyan", ORANGE: "orange"
      },
      onCreated: tabGroupsOnCreated,
      onUpdated: tabGroupsOnUpdated,
      onMoved: tabGroupsOnMoved,
      onRemoved: tabGroupsOnRemoved,
      get: function (groupId, cb) {
        var info = groupInfo(groupId);
        return info ? done(cb, info) : noGroup(cb, groupId);
      },
      query: function (query, cb) {
        var c = WEX.shiftCallback(query, cb);
        var q = c.opts;
        var windowId = q.windowId === -2 && app.activeBrowserWindow ? windowIdFor(app.activeBrowserWindow) : q.windowId;
        var list = Object.keys(tabGroupState.groups).map(groupInfo).filter(function (info) {
          return info && info.windowId !== -1 &&
            (q.collapsed == null || info.collapsed === q.collapsed) &&
            (q.color == null || info.color === q.color) &&
            (q.title == null || new RegExp("^" + String(q.title).replace(/[.+^${}()|[\]\\]/g, "\\$&")
              .replace(/\*/g, "[\\s\\S]*").replace(/\?/g, "[\\s\\S]") + "$").test(info.title)) &&
            (windowId == null || info.windowId === windowId) &&
            (q.shared == null || info.shared === q.shared);
        });
        return done(c.cb, list);
      },
      update: function (groupId, props, cb) {
        var group = tabGroupState.groups[groupId];
        if (!group) {
          return noGroup(cb, groupId);
        }
        var p = props || {};
        if (p.title != null) {
          group.title = String(p.title);
        }
        if (p.color != null) {
          group.color = p.color;
        }
        if (p.collapsed != null && !!p.collapsed !== !!group.collapsed) {
          group.collapsed = !!p.collapsed;
          setTabsHidden(groupTabIds(groupId), group.collapsed);
        }
        saveTabGroups();
        var info = groupInfo(groupId);
        tabGroupsOnUpdated.emit(info);
        return done(cb, info);
      },
      move: function (groupId, props, cb) {
        if (!tabGroupState.groups[groupId]) {
          return noGroup(cb, groupId);
        }
        var p = props || {};
        var members = groupTabs(groupId);
        var w = p.windowId != null ? windowForId(p.windowId) : members[0] && tabWindow(members[0]);
        if (!w) {
          return WEX.fail(cb, "No window with id: " + p.windowId + ".");
        }
        // The group lands as one block, with `index` of the window's other
        // tabs before it.
        var others = w.tabs.filter(function (t) {
          return members.indexOf(t) < 0;
        });
        var before = typeof p.index === "number" && p.index >= 0 ? Math.min(p.index, others.length) : others.length;
        var previous = null;
        members.forEach(function (t, n) {
          if (isHiddenTab(t)) {
            moveTab(t, w, before + n);
            return;
          }
          var rest = w.tabs.filter(function (other) {
            return other !== t;
          });
          var position = 0;
          if (previous) {
            position = rest.indexOf(previous) + 1;
          } else {
            for (var seen = 0; seen < before && position < rest.length; position++) {
              if (members.indexOf(rest[position]) < 0) {
                seen += 1;
              }
            }
          }
          moveTab(t, w, position);
          previous = t;
        });
        var info = groupInfo(groupId);
        tabGroupsOnMoved.emit(info);
        return done(cb, info);
      }
    };
  }
  var navOnHistoryStateUpdated = new Event("webNavigation.onHistoryStateUpdated");
  var navOnReferenceFragmentUpdated = new Event("webNavigation.onReferenceFragmentUpdated");

  var storageLocal = makeStorageArea(chooseBackend("local"), "local");
  var storageSync = makeStorageArea(chooseBackend("sync"), "sync");
  var storageSession = makeStorageArea(memoryBackend(), "session");

  // ------------------------------------------------------------------ //
  // Alarms
  // ------------------------------------------------------------------ //
  // As each browser keeps them. Chrome checks its alarms when the soonest is
  // due, at most once a second for an MV3 extension and once a minute for an
  // MV2 one, and keeps those that persist across sessions (all, unless the
  // extension says otherwise) through a restart, firing any that came due
  // while it was not running. Firefox keeps them for the session and fires
  // each when it is due.
  var ALARMS_KEY = "wex.alarms";
  var MAX_ALARMS = 500;
  var MAX_ALARM_NAME_BYTES = 1024;
  var ALARM_GRANULARITY = CONFIG.firefoxBuild ? 0 :
    ((CONFIG.manifest || {}).manifest_version >= 3 ? 1000 : 60000);
  var alarmList = [];
  var alarmPollTimer = null;
  var lastAlarmPoll = 0;
  var alarmsStarted = false;

  function findAlarm(name) {
    for (var i = 0; i < alarmList.length; i++) {
      if (alarmList[i].name === name) {
        return alarmList[i];
      }
    }
    return null;
  }

  function removeAlarm(alarm) {
    var i = alarmList.indexOf(alarm);
    if (i >= 0) {
      alarmList.splice(i, 1);
    }
  }

  function publicAlarm(alarm) {
    var out = { name: alarm.name, scheduledTime: alarm.scheduledTime };
    if (alarm.periodInMinutes != null) {
      out.periodInMinutes = alarm.periodInMinutes;
    }
    if (!CONFIG.firefoxBuild) {
      out.persistAcrossSessions = alarm.persistAcrossSessions;
    }
    return out;
  }

  function settingsItem(key, value) {
    try {
      if (arguments.length < 2) {
        return ext.settings ? ext.settings.getItem(key) : WEX.localStorageOf(g).getItem(key);
      }
      if (ext.settings) {
        ext.settings.setItem(key, value);
      } else {
        WEX.localStorageOf(g).setItem(key, value);
      }
    } catch (e) { /* not kept */ }
    return null;
  }

  function saveAlarms() {
    if (!CONFIG.firefoxBuild) {
      settingsItem(ALARMS_KEY, JSON.stringify(alarmList.filter(function (alarm) {
        return alarm.persistAcrossSessions;
      })));
    }
  }

  function loadAlarms() {
    if (CONFIG.firefoxBuild) {
      return;
    }
    var stored = null;
    try {
      stored = JSON.parse(settingsItem(ALARMS_KEY) || "null");
    } catch (e) { /* none kept */ }
    (Array.isArray(stored) ? stored : []).slice(0, MAX_ALARMS).forEach(function (alarm) {
      if (alarm && typeof alarm.name === "string" && typeof alarm.scheduledTime === "number") {
        alarmList.push({
          name: alarm.name,
          scheduledTime: alarm.scheduledTime,
          periodInMinutes: typeof alarm.periodInMinutes === "number" ? alarm.periodInMinutes : undefined,
          persistAcrossSessions: true
        });
      }
    });
  }

  // A lone surrogate counts as the three bytes of the replacement character.
  function utf8Length(text) {
    var bytes = 0;
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (c < 0x80) {
        bytes += 1;
      } else if (c < 0x800) {
        bytes += 2;
      } else if (c >= 0xd800 && c < 0xdc00 && i + 1 < text.length &&
          text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) < 0xe000) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    }
    return bytes;
  }

  function createAlarm(name, info) {
    return new Promise(function (resolve) {
      var hasName = typeof name === "string";
      if (CONFIG.firefoxBuild) {
        name = hasName ? name : "";
      } else {
        if (hasName && info.name != null) {
          throw new Error("Cannot set alarm name in both separate argument and object form.");
        }
        if (alarmList.length >= MAX_ALARMS) {
          throw new Error("An extension cannot have more than " + MAX_ALARMS + " active alarms.");
        }
        name = info.name != null ? String(info.name) : hasName ? name : "";
        if (info.delayInMinutes != null && info.when != null) {
          throw new Error("Cannot set both when and delayInMinutes.");
        }
        if (info.delayInMinutes == null && info.when == null && info.periodInMinutes == null) {
          throw new Error("Must set at least one of when, delayInMinutes, or periodInMinutes.");
        }
        if (utf8Length(name) > MAX_ALARM_NAME_BYTES) {
          throw new Error("Alarm name size is " + utf8Length(name) + " bytes which exceeds the limit of " +
            MAX_ALARM_NAME_BYTES + " bytes.");
        }
        warnShortAlarm("delay", info.delayInMinutes, name);
        warnShortAlarm("period", info.periodInMinutes, name);
      }
      var now = Date.now();
      var delay = info.delayInMinutes != null ? info.delayInMinutes : info.periodInMinutes;
      var alarm = {
        name: name,
        scheduledTime: info.when != null ? Number(info.when) : now + (Number(delay) || 0) * 60000,
        periodInMinutes: info.periodInMinutes != null ? Number(info.periodInMinutes) : undefined,
        persistAcrossSessions: info.persistAcrossSessions !== false
      };
      var existing = findAlarm(name);
      if (existing) {
        removeAlarm(existing);
      }
      alarmList.push(alarm);
      saveAlarms();
      schedulePoll();
      resolve();
    });
  }

  function warnShortAlarm(what, minutes, name) {
    var seconds = ALARM_GRANULARITY / 1000;
    if (minutes != null && minutes * 60000 < ALARM_GRANULARITY) {
      log.warn("Alarm " + what + " is less than the minimum duration of " + seconds + " " +
        (seconds === 1 ? "second" : "seconds") + ". Alarm \"" + name +
        "\" will fire after the minimum duration.");
    }
  }

  function schedulePoll() {
    clearTimeout(alarmPollTimer);
    alarmPollTimer = null;
    if (!alarmsStarted || !alarmList.length) {
      return;
    }
    var now = Date.now();
    var soonest = now + 3600000;
    alarmList.forEach(function (alarm) {
      var due = CONFIG.firefoxBuild ? alarm.scheduledTime :
        Math.max(alarm.scheduledTime, lastAlarmPoll + ALARM_GRANULARITY);
      soonest = Math.min(soonest, due);
    });
    alarmPollTimer = setTimeout(pollAlarms, Math.max(0, soonest - now));
  }

  function pollAlarms() {
    var now = Date.now();
    if (lastAlarmPoll && lastAlarmPoll + ALARM_GRANULARITY > now) {
      schedulePoll();
      return;
    }
    var fired = false;
    for (var i = alarmList.length - 1; i >= 0; i--) {
      var alarm = alarmList[i];
      if (alarm && alarm.scheduledTime <= now) {
        lastAlarmPoll = now;
        fired = true;
        fireAlarm(alarm, now);
      }
    }
    if (fired) {
      saveAlarms();
    }
    schedulePoll();
  }

  // A listener finds the alarm as it stands after this firing, as a browser's
  // does, whose event arrives once the alarm has been dealt with.
  function fireAlarm(alarm, now) {
    var fired = publicAlarm(alarm);
    if (!alarm.periodInMinutes) {
      removeAlarm(alarm);
    } else if (CONFIG.firefoxBuild) {
      alarm.scheduledTime = now + alarm.periodInMinutes * 60000;
    } else {
      var period = alarm.periodInMinutes * 60000;
      alarm.scheduledTime += period * (Math.floor((now - alarm.scheduledTime) / period) + 1);
    }
    alarmsOnAlarm.emit(fired);
  }

  // Alarms that came due while the extension was not running fire once its
  // background scripts have registered their listeners.
  function startAlarms() {
    alarmsStarted = true;
    schedulePoll();
  }

  loadAlarms();

  // Chrome service workers use a separate document for DOM work and audio.
  // Keep that document in its own realm: evaluating its scripts in the global
  // page would collide with the worker's globals and lose runtime messages
  // (the engine does not send a message back to its originating context).
  var offscreenDocument = null;

  function extensionContext(type, url) {
    return {
      contextId: WEX.uid("context"), contextType: type,
      documentId: WEX.uid("document"), documentUrl: url,
      documentOrigin: new g.URL(url).origin,
      tabId: -1, windowId: -1, frameId: -1, incognito: false
    };
  }

  var backgroundContext = extensionContext("BACKGROUND", g.location.href);

  function getContexts(filter, cb) {
    var f = filter || {};
    var contexts = [backgroundContext];
    if (offscreenDocument && offscreenDocument.ready) {
      contexts.push(offscreenDocument.context);
    }
    if (openPanel) {
      contexts.push(openPanel.context);
    }
    var fields = {
      contextIds: "contextId", contextTypes: "contextType",
      documentIds: "documentId", documentUrls: "documentUrl",
      documentOrigins: "documentOrigin", tabIds: "tabId",
      windowIds: "windowId", frameIds: "frameId"
    };
    return done(cb, contexts.filter(function (context) {
      return (f.incognito == null || f.incognito === context.incognito) &&
        Object.keys(fields).every(function (key) {
          return !f[key] || f[key].indexOf(context[fields[key]]) >= 0;
        });
    }));
  }

  // Permissions that name an API of Chrome's this host does not provide.
  var API_PERMISSIONS = ["bookmarks", "contentSettings", "debugger", "declarativeContent",
    "desktopCapture", "dns", "documentScan", "fontSettings", "gcm", "history", "loginState",
    "pageCapture", "platformKeys", "printing", "printingMetrics", "processes", "proxy",
    "readingList", "search", "sessions", "sidePanel", "system", "tabCapture", "tabGroups",
    "topSites", "tts", "ttsEngine", "wallpaper", "webAuthenticationProxy"];

  function permissionAvailable(permission) {
    var api = String(permission).split(".")[0];
    return API_PERMISSIONS.indexOf(api) < 0 || !!(chrome && chrome[api]);
  }

  // A worker's pages talk to it through navigator.serviceWorker, and it to
  // them through `clients`. A page in the global page's process, as the
  // offscreen document and the popover are, is given navigator.serviceWorker
  // (wex-page.js), and connects here: its messages, with the ports they
  // carry, are message events of the global page's, from the page's Client,
  // and that Client's postMessage reaches the page. The offscreen document
  // is listed while it is open, as workers ask whether it is before making
  // one. A page in a tab, in a web process, connects through a shared
  // worker of the extension's (wex-worker-relay.js), which carries ports too.
  var workerClients = [];

  function workerClient(entry) {
    var page = entry.window;
    if (!page) {
      return {
        id: entry.id, url: entry.url, type: "window", frameType: "top-level", focused: false,
        visibilityState: "visible",
        postMessage: function (data, transfer) {
          entry.deliver(data, transferList(transfer));
        }
      };
    }
    var visible = "hidden";
    try {
      visible = page.document.visibilityState || "hidden";
    } catch (e) { /* gone */ }
    return {
      id: entry.id, url: String(page.location.href), type: "window",
      frameType: page.top === page ? "top-level" : "nested", focused: false, visibilityState: visible,
      postMessage: function (data, transfer) {
        entry.deliver(data, transferList(transfer));
      }
    };
  }

  // postMessage's second argument, a list or an options object holding one.
  function transferList(transfer) {
    if (Array.isArray(transfer)) {
      return transfer;
    }
    return transfer && Array.isArray(transfer.transfer) ? transfer.transfer : [];
  }

  function dispatchToWorker(data, transfer, source) {
    var ports = transferList(transfer).filter(function (item) {
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
        Object.defineProperty(event, "source", { value: source });
      } catch (e) { /* left as the engine set it */ }
      g.dispatchEvent(event);
    }, 0);
  }

  if (CONFIG.backgroundWorker) {
    g.__wexServiceWorker = {
      connect: function (page, deliver) {
        workerClients = workerClients.filter(function (entry) {
          return entry.window !== page;
        });
        var entry = { id: WEX.uid("client"), window: page, deliver: deliver };
        // The offscreen document's Client is the one its context names.
        var url = "";
        try {
          url = String(page.location.href);
        } catch (e) { /* gone */ }
        if (offscreenDocument && offscreenDocument.frame && (offscreenDocument.frame.contentWindow === page ||
            url === offscreenDocument.context.documentUrl)) {
          entry.id = offscreenDocument.context.contextId;
        }
        workerClients.push(entry);
        return {
          postMessage: function (data, transfer) {
            dispatchToWorker(data, transfer, workerClient(entry));
          },
          disconnect: function () {
            workerClients = workerClients.filter(function (other) {
              return other !== entry;
            });
          }
        };
      }
    };
    try {
      var relay = new g.SharedWorker(WEX.extUrl(WEX.WORKER_RELAY), { name: "wex-worker-relay" });
      var relayed = {};
      relay.port.onmessage = function (e) {
        var m = e.data || {};
        var ports = Array.prototype.slice.call(e.ports || []);
        if (m.wex === "connect") {
          var entry = relayed[m.id] = {
            id: "relay-" + m.id, window: null, url: String(m.url || ""),
            deliver: function (data, transfer) {
              relay.port.postMessage({ wex: "post", id: m.id, data: data }, transfer.filter(function (item) {
                return item && typeof item.postMessage === "function" && typeof item.start === "function";
              }));
            }
          };
          workerClients.push(entry);
        } else if (m.wex === "post" && relayed[m.id]) {
          dispatchToWorker(m.data, ports, workerClient(relayed[m.id]));
        } else if (m.wex === "close" && relayed[m.id]) {
          var gone = relayed[m.id];
          delete relayed[m.id];
          workerClients = workerClients.filter(function (other) {
            return other !== gone;
          });
        }
      };
      relay.port.start();
      relay.port.postMessage({ wex: "host" });
    } catch (e) {
      log.warn("the extension's pages in tabs cannot reach the worker", e);
    }
  }

  function currentWorkerClients() {
    var out = workerClients.filter(function (entry) {
      if (!entry.window) {
        return true;
      }
      try {
        return !entry.window.closed && !!entry.window.location;
      } catch (e) {
        return false;
      }
    }).map(workerClient);
    if (offscreenDocument && offscreenDocument.ready && !out.some(function (client) {
      return client.id === offscreenDocument.context.contextId;
    })) {
      var context = offscreenDocument.context;
      out.push({
        id: context.contextId, url: context.documentUrl, type: "window",
        frameType: "nested", focused: false, visibilityState: "hidden",
        postMessage: function () {
          throw new g.DOMException("The client is not connected.", "InvalidStateError");
        }
      });
    }
    return out;
  }

  if (CONFIG.backgroundWorker && typeof g.clients === "undefined") {
    g.clients = {
      matchAll: function () {
        return Promise.resolve(currentWorkerClients());
      },
      get: function (id) {
        return Promise.resolve(currentWorkerClients().filter(function (client) {
          return client.id === id;
        })[0]);
      },
      claim: function () {
        return Promise.resolve();
      },
      openWindow: function (url) {
        return Promise.resolve(chrome.tabs.create({ url: String(url) })).then(function () {
          return null;
        });
      }
    };
  }

  // A worker's fetch event, for the requests the extension's own pages make
  // of its address, and their navigations there, as Chrome gives its
  // extension's service worker those of its clients. The engine's webRequest
  // holds such a request while the global page asks the worker's fetch
  // listeners, once the worker has one, and a response a listener gives
  // replaces the load: its body as a data: address, or where it redirects.
  if (CONFIG.backgroundWorker && native && native.webRequest) {
    (function workerFetchEvents() {
      var root = WEX.extUrl("");
      var listening = false;
      var onfetch = null;
      var listeners = [];
      var addListener = g.addEventListener;
      var removeListener = g.removeEventListener;
      function listen() {
        if (listening) {
          return;
        }
        listening = true;
        native.webRequest.onBeforeRequest.addListener(answer,
          { urls: [root.replace(/^([a-z-]+:\/\/[^\/]+\/).*$/i, "$1*")] }, ["blocking"]);
      }
      try {
        Object.defineProperty(g, "onfetch", {
          configurable: true,
          enumerable: true,
          get: function () {
            return onfetch;
          },
          set: function (handler) {
            onfetch = typeof handler === "function" ? handler : null;
            if (onfetch) {
              listen();
            }
          }
        });
      } catch (e) { /* the worker's handler is not heard */ }
      g.addEventListener = function (type, listener) {
        if (String(type) !== "fetch" || this !== g) {
          return addListener.apply(this, arguments);
        }
        if (listener && listeners.indexOf(listener) < 0) {
          listeners.push(listener);
          listen();
        }
      };
      g.removeEventListener = function (type, listener) {
        if (String(type) !== "fetch" || this !== g) {
          return removeListener.apply(this, arguments);
        }
        listeners = listeners.filter(function (entry) {
          return entry !== listener;
        });
      };

      function fromExtension(details) {
        var from = String(details.documentUrl || details.originUrl || details.initiator || "");
        return from.indexOf(root) === 0 || from.indexOf(WEX.origin) === 0 ||
          details.type === "main_frame" || details.type === "sub_frame";
      }

      function bodyAddress(response) {
        return response.arrayBuffer().then(function (buffer) {
          var bytes = new Uint8Array(buffer);
          var binary = "";
          for (var i = 0; i < bytes.length; i += 0x8000) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          }
          var type = response.headers.get("content-type") || "application/octet-stream";
          return "data:" + type.replace(/[\s,]/g, "") + ";base64," + g.btoa(binary);
        });
      }

      function answer(details) {
        if (String(details.url).indexOf(root) !== 0 || !fromExtension(details)) {
          return undefined;
        }
        var request;
        try {
          request = new g.Request(details.url, { method: details.method || "GET" });
        } catch (e) {
          return undefined;
        }
        var answered = null;
        var event = new g.Event("fetch", { cancelable: true });
        var extensions = {
          request: request, clientId: "", resultingClientId: "", replacesClientId: "",
          preloadResponse: Promise.resolve(undefined), handled: Promise.resolve(),
          respondWith: function (response) {
            if (answered) {
              throw new g.DOMException("The event has already been responded to.", "InvalidStateError");
            }
            answered = Promise.resolve(response);
          },
          waitUntil: function () {}
        };
        Object.keys(extensions).forEach(function (name) {
          Object.defineProperty(event, name, { value: extensions[name] });
        });
        listeners.concat(onfetch ? [onfetch] : []).forEach(function (listener) {
          try {
            if (typeof listener === "function") {
              listener.call(g, event);
            } else if (listener && typeof listener.handleEvent === "function") {
              listener.handleEvent(event);
            }
          } catch (e) {
            log.warn("the worker's fetch listener threw", e);
          }
        });
        if (!answered) {
          return undefined;
        }
        return answered.then(function (response) {
          if (!response || typeof response.arrayBuffer !== "function") {
            return { cancel: true };
          }
          if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400 && response.headers.get("location"))) {
            return { redirectUrl: new g.URL(response.headers.get("location"), details.url).href };
          }
          return bodyAddress(response).then(function (address) {
            return { redirectUrl: address };
          });
        }).then(null, function (e) {
          log.warn("the worker's response to " + details.url + " failed", e);
          return { cancel: true };
        });
      }
    })();
  }

  // The rest of a worker's own scope: the worker as a ServiceWorker that is
  // active, its registration, and skipWaiting. A notification the
  // registration is asked to show goes through the web Notification API.
  // ServiceWorkerGlobalScope and WorkerGlobalScope name the scope, as code
  // tells a worker from a page by them, and the global page is an instance
  // of both.
  if (CONFIG.backgroundWorker && typeof g.registration === "undefined") {
    var worker = new g.EventTarget();
    worker.state = "activated";
    var background = (CONFIG.manifest && CONFIG.manifest.background) || {};
    worker.scriptURL = WEX.extUrl(String(background.service_worker || ""));
    worker.onstatechange = null;
    worker.onerror = null;
    // The worker posting to itself.
    worker.postMessage = function (data, transfer) {
      dispatchToWorker(data, transfer, null);
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
    registration.showNotification = function (title, options) {
      try {
        if (typeof g.Notification === "function") {
          new g.Notification(String(title), options || {});
        }
      } catch (e) { /* no notification to show */ }
      return Promise.resolve();
    };
    registration.getNotifications = function () {
      return Promise.resolve([]);
    };
    registration.navigationPreload = {
      enable: function () { return Promise.resolve(); },
      disable: function () { return Promise.resolve(); },
      setHeaderValue: function () { return Promise.resolve(); },
      getState: function () { return Promise.resolve({ enabled: false, headerValue: "true" }); }
    };
    g.serviceWorker = worker;
    g.registration = registration;
    // WorkerNavigator and WorkerLocation name the worker's navigator and
    // location, which code checks the same way.
    [["WorkerGlobalScope", Object.getPrototypeOf(g)], ["ServiceWorkerGlobalScope", Object.getPrototypeOf(g)],
      ["WorkerNavigator", g.navigator && Object.getPrototypeOf(g.navigator)],
      ["WorkerLocation", g.location && Object.getPrototypeOf(g.location)]].forEach(function (entry) {
      if (typeof g[entry[0]] === "undefined" && entry[1]) {
        var Scope = function () {
          throw new TypeError("Illegal constructor");
        };
        Scope.prototype = entry[1];
        g[entry[0]] = Scope;
      }
    });
    // A worker's global has no localStorage, history, customElements,
    // closed or frameElement, and a worker can give it one of its own (a
    // localStorage kept in chrome.storage); a window's are read-only. Here
    // each can be assigned, and reads as what was assigned, which the
    // runtime's own records, kept in the real localStorage, do not see.
    ["localStorage", "history", "customElements", "closed", "frameElement"].forEach(function (name) {
      var own = Object.getOwnPropertyDescriptor(g, name);
      if (!own || !own.configurable || typeof own.get !== "function" || own.set) {
        return;
      }
      var assigned = false;
      var value;
      try {
        Object.defineProperty(g, name, {
          configurable: true,
          enumerable: own.enumerable,
          get: function () {
            return assigned ? value : own.get.call(g);
          },
          set: function (v) {
            assigned = true;
            value = v;
          }
        });
      } catch (e) { /* the window's own stays */ }
    });
    g.skipWaiting = function () {
      return Promise.resolve();
    };
  }

  // Chrome's checks, in its order: the address, one document at a time, the
  // reasons. TESTING is a reason only a browser running tests accepts.
  function createOffscreenDocument(parameters) {
    var p = parameters || {};
    var url;
    try {
      // Resolve dot segments before checking the token-bearing bundle root.
      url = new g.URL(WEX.extUrl(String(p.url || ""))).href;
    } catch (error) {
      url = null;
    }
    if (!url || !p.url || url.indexOf(WEX.extUrl("")) !== 0) {
      return Promise.reject(new Error("Invalid URL."));
    }
    if (offscreenDocument) {
      return Promise.reject(new Error("Only a single offscreen document may be created."));
    }
    var reasons = Array.isArray(p.reasons) ? p.reasons : [];
    if (!reasons.length) {
      return Promise.reject(new Error("A `reason` must be provided."));
    }
    if (reasons.indexOf("TESTING") >= 0 && !CONFIG.testApi) {
      return Promise.reject(new Error("The `TESTING` reason is only available with the " +
        "--offscreen-document-testing commandline switch applied."));
    }
    if (WEX.readTextSync(WEX.extPath(url).split(/[?#]/)[0]) == null) {
      return Promise.reject(new Error("Page failed to load."));
    }
    if (Array.isArray(p.reasons) && p.reasons.indexOf("AUDIO_PLAYBACK") >= 0) {
      return createOffscreenAudioDocument(url);
    }
    return new Promise(function (resolve, reject) {
      var frame = document.createElement("iframe");
      var record = { frame: frame, ready: false,
        context: extensionContext("OFFSCREEN_DOCUMENT", url) };
      offscreenDocument = record;
      frame.style.cssText = "display:none";
      frame.setAttribute("aria-hidden", "true");
      frame.setAttribute("allow", "autoplay");
      var timer;
      function cleanHandlers() {
        clearTimeout(timer);
        frame.onload = frame.onerror = null;
      }
      record.cancel = function (error) {
        cleanHandlers();
        if (frame.parentNode) {
          frame.parentNode.removeChild(frame);
        }
        if (offscreenDocument === record) {
          offscreenDocument = null;
        }
        reject(error);
      };
      frame.onload = function () {
        cleanHandlers();
        record.ready = true;
        resolve();
      };
      frame.onerror = function () {
        record.cancel(new Error("Page failed to load."));
      };
      timer = setTimeout(function () {
        record.cancel(new Error("Offscreen document load timed out: " + url));
      }, 30000);
      frame.src = url;
      try {
        (document.body || document.documentElement).appendChild(frame);
      } catch (error) {
        record.cancel(error);
      }
    });
  }

  function createOffscreenAudioDocument(url) {
    return new Promise(function (resolve, reject) {
      var record = { ready: false, port: null,
        context: extensionContext("OFFSCREEN_DOCUMENT", url) };
      offscreenDocument = record;
      var timer = setTimeout(function () {
        record.cancel(new Error("Offscreen audio document load timed out."));
      }, 30000);
      record.cancel = function (error) {
        clearTimeout(timer);
        if (offscreenDocument !== record) return;
        offscreenDocument = null;
        if (record.port) record.port.disconnect();
        reject(error);
        if (record.finishClose) record.finishClose();
      };
      // A port binds the document's lifetime to its host tab. Navigating or
      // closing that tab disconnects it, allowing the extension to recreate
      // the offscreen document in whichever page is then active.
      g.chrome.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
        if (offscreenDocument !== record) return;
        var tab = tabs && tabs[0];
        if (!tab || !/^https?:\/\//i.test(tab.url || "")) {
          throw new Error("Offscreen audio requires an accessible HTTP or HTTPS page in the active tab.");
        }
        var port = native.tabs.connect(tab.id, {
          name: WEX.INTERNAL_PORT + "offscreen-audio", frameId: 0
        });
        record.port = port;
        port.onMessage.addListener(function (message) {
          if (offscreenDocument !== record) return;
          if (message.error) {
            record.cancel(new Error(message.error));
          } else if (message.closed) {
            record.cancel(new Error("Offscreen document was closed before loading."));
          } else if (message.ready && !record.finishClose) {
            clearTimeout(timer);
            record.ready = true;
            resolve();
          }
        });
        port.onDisconnect.addListener(function () {
          record.cancel(new Error("The offscreen audio host disconnected. Refresh an accessible webpage and retry."));
        });
        port.postMessage({ url: url });
      }).catch(function (error) { record.cancel(error); });
      record.close = function () {
        if (record.closePromise) return record.closePromise;
        if (!record.port) {
          record.cancel(new Error("Offscreen document was closed before loading."));
          return Promise.resolve();
        }
        record.closePromise = new Promise(function (resolveClose) {
          record.finishClose = resolveClose;
          record.port.postMessage({ close: true });
        });
        return record.closePromise;
      };
    });
  }

  function closeOffscreenDocument() {
    if (!offscreenDocument) {
      return Promise.reject(new Error("No current offscreen document."));
    }
    if (offscreenDocument.close) return offscreenDocument.close();
    offscreenDocument.cancel(new Error("Offscreen document was closed before loading."));
    return Promise.resolve();
  }

  // Builds the chrome namespace on the global page's `browser` object.
  // Extension pages reach it by message (wex-page.js).
  function buildNamespace(engine) {
    var messaging = WEX.makeMessaging(engine);
    var tabMessaging = WEX.makeTabMessaging(engine);
    var injection = WEX.makeInjection(engine, function () {
      var t = activeTab();
      return (t ? identify(t) : Promise.resolve(undefined)).then(function (id) {
        if (id == null) {
          throw new Error("No active tab.");
        }
        return id;
      });
    });

    var runtime = {
      id: WEX.runtimeId,
      OnInstalledReason: { INSTALL: "install", UPDATE: "update",
        CHROME_UPDATE: "chrome_update", SHARED_MODULE_UPDATE: "shared_module_update" },
      OnRestartRequiredReason: { APP_UPDATE: "app_update", OS_UPDATE: "os_update",
        PERIODIC: "periodic" },
      PlatformOs: { MAC: "mac", WIN: "win", ANDROID: "android", CROS: "cros",
        LINUX: "linux", OPENBSD: "openbsd", FUCHSIA: "fuchsia" },
      PlatformArch: { ARM: "arm", ARM64: "arm64", X86_32: "x86-32", X86_64: "x86-64",
        MIPS: "mips", MIPS64: "mips64" },
      PlatformNaclArch: { ARM: "arm", X86_32: "x86-32", X86_64: "x86-64",
        MIPS: "mips", MIPS64: "mips64" },
      RequestUpdateCheckStatus: { THROTTLED: "throttled", NO_UPDATE: "no_update",
        UPDATE_AVAILABLE: "update_available" },
      ContextType: { TAB: "TAB", POPUP: "POPUP", BACKGROUND: "BACKGROUND",
        OFFSCREEN_DOCUMENT: "OFFSCREEN_DOCUMENT", SIDE_PANEL: "SIDE_PANEL",
        DEVELOPER_TOOLS: "DEVELOPER_TOOLS" },
      onMessage: messaging.onMessage,
      onMessageExternal: alsoFromPages(messaging.onMessageExternal, pageMessages),
      onConnect: messaging.onConnect,
      onConnectExternal: alsoFromPages(messaging.onConnectExternal, pageConnections),
      onInstalled: runtimeOnInstalled,
      onStartup: runtimeOnStartup,
      onSuspend: new Event("runtime.onSuspend"),
      onSuspendCanceled: new Event("runtime.onSuspendCanceled"),
      onUpdateAvailable: new Event("runtime.onUpdateAvailable"),
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
      getContexts: getContexts,
      getPlatformInfo: function (cb) {
        return done(cb, { os: "mac", arch: "x86-64", nacl_arch: "x86-64" });
      },
      getBackgroundPage: function (cb) {
        return done(cb, g);
      },
      reload: function () {
        g.location.reload();
      },
      requestUpdateCheck: function (cb) {
        return done(cb, "no_update");
      },
      setUninstallURL: function (_, cb) {
        return done(cb);
      },
      openOptionsPage: function (cb) {
        if (!CONFIG.optionsPage) {
          return WEX.fail(cb, "Could not create an options page.");
        }
        return settle(openExtensionPage(CONFIG.optionsPage).then(function () {}), cb);
      }
    };
    // Firefox's runtime.getBrowserInfo, which a build published for Firefox
    // calls without asking whether it is there, and which answers as the
    // Firefox its user agent names. A build for Chrome asks, and takes its
    // presence to mean Firefox, so only a Firefox build has it.
    // The browser's own events of what Safari never does or never tells: an
    // extension enabled again, which starts its global page over as the
    // browser's start does, a restart the browser wants, and a connection
    // from a user script. Firefox's warns of a slow content script.
    if (CONFIG.firefoxBuild) {
      runtime.onPerformanceWarning = new Event("runtime.onPerformanceWarning");
    } else {
      runtime.onEnabled = new Event("runtime.onEnabled");
      runtime.onExtensionLoaded = runtimeOnExtensionLoaded;
      runtime.onRestartRequired = new Event("runtime.onRestartRequired");
      runtime.onBrowserUpdateAvailable = new Event("runtime.onBrowserUpdateAvailable");
      // Chrome restarts the device only in a ChromeOS kiosk session, and
      // elsewhere fails, as here.
      runtime.restart = function () {
        WEX.fail(function () {}, "Function available only for ChromeOS kiosk mode.");
      };
      runtime.restartAfterDelay = function (seconds, cb) {
        return WEX.fail(cb, "API available only for ChromeOS kiosk mode.");
      };
      if (manifest.manifest_version >= 3) {
        runtime.onUserScriptConnect = new Event("runtime.onUserScriptConnect");
        runtime.onUserScriptMessage = new Event("runtime.onUserScriptMessage");
      }
    }
    if (CONFIG.firefoxBuild) {
      runtime.getBrowserInfo = function (cb) {
        var identity = WEX.browserIdentity();
        return done(cb, {
          name: identity.name, vendor: identity.vendor, version: identity.version,
          buildID: identity.buildID
        });
      };
    }
    Object.defineProperty(runtime, "lastError", {
      get: function () {
        // Chrome's is undefined outside a failed call's callback.
        return WEX.lastError || engine.runtime.lastError || undefined;
      },
      set: function (v) {
        WEX.lastError = v;
      }
    });

    var extension = {
      getURL: function (path) {
        return WEX.extUrl(path);
      },
      getBackgroundPage: function () {
        return g;
      },
      getViews: function (opts) {
        var views = [];
        try {
          // A popover resting on its blank page shows no view of the
          // extension's, and the side panel's is no popup.
          var placeholder = WEX.extUrl(WEX.POPUP_PLACEHOLDER);
          (ext.popovers || []).forEach(function (p) {
            var view = p.contentWindow;
            if (!view || (opts && opts.type === "popup" && p.identifier === WEX.SIDE_PANEL_POPOVER)) {
              return;
            }
            try {
              if (String(view.location.href).split(/[?#]/)[0] === placeholder) {
                return;
              }
            } catch (e) {
              return;
            }
            views.push(view);
          });
        } catch (e) { /* ignore */ }
        if (opts && opts.type === "popup") {
          return views;
        }
        if (opts && opts.type === "background") {
          return [g];
        }
        // The extension's pages in tabs are out of the global page's reach.
        if (opts && opts.type) {
          return [];
        }
        return [g].concat(views);
      },
      isAllowedIncognitoAccess: function (cb) {
        return done(cb, false);
      },
      isAllowedFileSchemeAccess: function (cb) {
        return done(cb, false);
      },
      // Safari checks for updates by its own update manifest, which takes no
      // data from the extension.
      setUpdateUrlData: function () {},
      inIncognitoContext: false
    };
    Object.defineProperty(extension, "lastError", {
      configurable: true,
      enumerable: true,
      get: function () {
        return runtime.lastError;
      },
      set: function (v) {
        WEX.lastError = v;
      }
    });
    WEX.addLegacyRequests(extension, engine, true);

    // Moves a tab through its history with the engine's call where it has one,
    // and otherwise from inside its page, which a page the extension cannot
    // reach refuses.
    function historyStep(delta) {
      return function (id, cb) {
        var callback = typeof id === "function" ? id : cb;
        var tabId = typeof id === "number" ? id : activeTabId();
        if (typeof tabId !== "number" || tabId >= WEX.PROVISIONAL_TAB_ID ||
            !native.tabs || typeof native.tabs.executeScript !== "function") {
          return WEX.fail(callback, "Cannot find a next page in history.");
        }
        return settle(tabError(Promise.resolve().then(function () {
          var step = native.tabs[delta < 0 ? "goBack" : "goForward"];
          return typeof step === "function" ? step.call(native.tabs, tabId) :
            native.tabs.executeScript(tabId, { code: "history.go(" + delta + ");void 0;", frameId: 0 });
        }), tabId).then(function () {}), callback);
      };
    }

    var tabs = {
      group: groupTabsCall,
      ungroup: ungroupTabsCall,
      onActivated: tabsOnActivated,
      onUpdated: tabsOnUpdated,
      onRemoved: tabsOnRemoved,
      onCreated: tabsOnCreated,
      onReplaced: tabsOnReplaced,
      onAttached: tabsOnAttached,
      onDetached: tabsOnDetached,
      onMoved: tabsOnMoved,
      onHighlighted: new Event("tabs.onHighlighted"),
      onZoomChange: new Event("tabs.onZoomChange"),
      TAB_ID_NONE: -1,

      query: function (query, cb) {
        var q = query || {};
        var list = allTabs().filter(function (t) {
          var w = tabWindow(t);
          if (q.active != null && (w && w.activeTab === t) !== !!q.active) {
            return false;
          }
          if (q.highlighted != null && (w && w.activeTab === t) !== !!q.highlighted) {
            return false;
          }
          if (q.currentWindow != null && (w === app.activeBrowserWindow) !== !!q.currentWindow) {
            return false;
          }
          if (q.lastFocusedWindow != null && (w === app.activeBrowserWindow) !== !!q.lastFocusedWindow) {
            return false;
          }
          if (q.windowId != null && q.windowId !== -1 && windowForId(q.windowId) !== w) {
            return false;
          }
          if (q.index != null && tabPosition(t) !== q.index) {
            return false;
          }
          if (q.url && !WEX.tabUrlMatches(t.url || "", q.url)) {
            return false;
          }
          // A title pattern matches the whole title, its `*` any run of
          // characters and its `?` any one.
          if (q.title && !new RegExp("^" + String(q.title).replace(/[.+^${}()|[\]\\]/g, "\\$&")
              .replace(/\*/g, "[\\s\\S]*").replace(/\?/g, "[\\s\\S]") + "$").test(String(t.title || ""))) {
            return false;
          }
          if (q.status && q.status !== (pendingUrlFor(t) ? "loading" : tabStatus[idForTab(t)] || "complete")) {
            return false;
          }
          // No tab here is any of these, and every window is a normal one.
          if (q.pinned || q.discarded || q.audible || q.muted || q.frozen || q.autoDiscardable === false ||
              (q.windowType && q.windowType !== "normal")) {
            return false;
          }
          if (q.groupId != null && groupIdOf(idForTab(t)) !== q.groupId) {
            return false;
          }
          return true;
        }).map(tabInfo);
        return done(cb, list);
      },

      get: function (id, cb) {
        return settle(describeTabId(id), cb);
      },

      getCurrent: function (cb) {
        return done(cb, undefined);
      },

      create: function (props, cb) {
        var p = props || {};
        if (p.url && unopenableUrlError(p.url)) {
          return WEX.fail(cb, unopenableUrlError(p.url));
        }
        if (unknownWindow(p.windowId)) {
          return WEX.fail(cb, noWindowError(p.windowId));
        }
        var w = windowForId(p.windowId) || app.activeBrowserWindow;
        var mode = p.active === false ? "background" : "foreground";
        var t;
        if (!w) {
          // A new window opens with an empty tab, which becomes this one.
          w = app.openBrowserWindow();
          t = w.activeTab;
        }
        try {
          t = t || (typeof p.index === "number" ? w.openTab(mode, p.index) : w.openTab(mode));
        } catch (e) {
          t = w.openTab();
        }
        if (typeof p.openerTabId === "number") {
          openers.set(t, p.openerTabId);
        }
        var navigated = Promise.resolve().then(function () {
          return p.url && !NEW_TAB_URL.test(p.url) ? navigateTab(t, navigationUrl(p.url)) : undefined;
        });
        return settle(navigated.then(function () { return identify(t); }).then(function () {
          var info = tabInfo(t);
          info.status = "loading";
          return info;
        }), cb);
      },

      duplicate: function (id, cb) {
        var t = tabForId(id);
        if (!t) {
          return WEX.fail(cb, "No tab with id: " + id + ".");
        }
        return tabs.create({ url: t.url, windowId: windowIdFor(tabWindow(t)), index: tabPosition(t) + 1 }, cb);
      },

      update: function (id, props, cb) {
        if (typeof id === "object" && id !== null) {
          cb = props;
          props = id;
          id = activeTabId();
        } else if (id == null) {
          id = activeTabId();
        }
        var p = props || {};
        var t = tabForId(id);
        var navigated = Promise.resolve();
        if (p.url && unopenableUrlError(p.url)) {
          return WEX.fail(cb, unopenableUrlError(p.url));
        }
        if (p.url) {
          var url = NEW_TAB_URL.test(p.url) ? newTabTarget() : navigationUrl(p.url);
          if (t) {
            navigated = Promise.resolve().then(function () { return navigateTab(t, url); });
          } else {
            navigated = tabError(engine.tabs.update(Number(id), { url: url }), id);
          }
        }
        if (t && typeof p.openerTabId === "number") {
          var opener = tabForId(p.openerTabId);
          if (!opener) {
            return WEX.fail(cb, "No tab with id: " + p.openerTabId + ".");
          }
          if (opener.browserWindow !== t.browserWindow) {
            return WEX.fail(cb, "Tab opener must be in the same window as the updated tab.");
          }
          openers.set(t, p.openerTabId);
        }
        if (t && (p.active || p.highlighted || p.selected)) {
          try {
            t.activate();
          } catch (e) { /* ignore */ }
        }
        return settle(navigated.then(function () {
          return describeTabId(id);
        }), cb);
      },

      remove: function (ids, cb) {
        var unknown = [];
        (Array.isArray(ids) ? ids : [ids]).forEach(function (id) {
          var t = tabForId(id);
          if (!t) {
            unknown.push(Number(id));
            return;
          }
          try {
            t.close();
          } catch (e) { /* ignore */ }
        });
        return settle(unknown.length ? tabError(engine.tabs.remove(unknown), unknown[0]) : Promise.resolve(), cb);
      },

      reload: function (id, props, cb) {
        var args = Array.prototype.slice.call(arguments);
        var callback = typeof args[args.length - 1] === "function" ? args.pop() : null;
        var target = args.length && (typeof args[0] === "number" || args[0] == null) ? args.shift() : null;
        if (target == null) {
          target = activeTabId();
        }
        var options = (args[0] && typeof args[0] === "object") ? args[0] : {};
        if (target == null) {
          return done(callback);
        }
        if (target >= WEX.PROVISIONAL_TAB_ID) {
          var t = tabForId(target);
          if (t) {
            return settle(Promise.resolve().then(function () {
              return navigateTab(t, t.url);
            }), callback);
          }
          return done(callback);
        }
        return settle(tabError(engine.tabs.reload(target, { bypassCache: !!options.bypassCache }), target), callback);
      },

      sendMessage: tabMessaging.sendMessage,
      connect: tabMessaging.connect,
      executeScript: injection.tabs.executeScript,
      insertCSS: injection.tabs.insertCSS,
      removeCSS: injection.tabs.removeCSS,

      // Safari gives the visible part of a tab as a PNG; a JPEG, Chrome's
      // default, is drawn from it.
      captureVisibleTab: function () {
        var args = Array.prototype.slice.call(arguments);
        var callback = typeof args[args.length - 1] === "function" ? args.pop() : null;
        var windowId = typeof args[0] === "number" ? args[0] : -2;
        var options = (args[0] && typeof args[0] === "object" ? args[0] : args[1]) || {};
        var w = windowForId(windowId);
        var tab = w && w.activeTab;
        if (!tab || typeof tab.visibleContentsAsDataURL !== "function") {
          return WEX.fail(callback, "No window with id: " + windowId + ".");
        }
        return settle(new Promise(function (resolve, reject) {
          tab.visibleContentsAsDataURL(function (png) {
            if (!png) {
              reject(new Error("Failed to capture tab: unknown error"));
            } else if (options.format === "png") {
              resolve(png);
            } else {
              var image = new g.Image();
              image.onload = function () {
                var canvas = g.document.createElement("canvas");
                canvas.width = image.naturalWidth;
                canvas.height = image.naturalHeight;
                canvas.getContext("2d").drawImage(image, 0, 0);
                var quality = typeof options.quality === "number" ? options.quality : 92;
                resolve(canvas.toDataURL("image/jpeg", Math.max(0, Math.min(100, quality)) / 100));
              };
              image.onerror = function () {
                reject(new Error("Failed to capture tab: unknown error"));
              };
              image.src = png;
            }
          });
        }), callback);
      },

      // A tab's language, as Chrome tells it from what the page says (its
      // translate code's DeterminePageLanguage): the leading language of
      // its text where the detector is sure of it, or else the language the
      // page declares, or else the leading one it is not sure of; "und" for
      // a page none of these tells, or one the extension cannot read.
      detectLanguage: function (id, cb) {
        var callback = typeof id === "function" ? id : cb;
        var tabId = typeof id === "number" ? id : activeTabId();
        if (typeof tabId !== "number" || !native.tabs || typeof native.tabs.executeScript !== "function") {
          return done(callback, "und");
        }
        var code = "(function(){var d=document,r=d.documentElement,b=d.body;" +
          "return{lang:r&&r.getAttribute('lang')||'',text:String(b&&(b.innerText||b.textContent)||'').slice(0,4096)};})()";
        return settle(Promise.resolve(native.tabs.executeScript(tabId, { code: code, frameId: 0 }))
          .then(function (results) {
            var page = results && results[0] || {};
            return detectLanguages(page.text, PAGE_TEXT_BYTES).then(function (found) {
              var detected = found.languages.length ? found.languages[0].language : null;
              var tags = String(page.lang || "").toLowerCase().split(/[-_]/);
              var declared = /^[a-z]{2,3}$/.test(tags[0]) ? tags[0] : null;
              // Chrome tells Chinese as Simplified or Traditional where the
              // page declares which, and keeps that over a bare "zh".
              if (declared === "zh") {
                declared = tags.some(function (tag) { return /^(hant|tw|hk|mo)$/.test(tag); }) ? "zh-TW" :
                  tags.some(function (tag) { return /^(hans|cn|sg)$/.test(tag); }) ? "zh-CN" : "zh";
              }
              if (found.isReliable && detected) {
                return detected === "zh" && declared && declared.indexOf("zh-") === 0 ? declared : detected;
              }
              return declared || detected || "und";
            });
          }, function () {
            return "und";
          }), callback);
      },

      getZoom: function (id, cb) {
        return done(typeof id === "function" ? id : cb, 1);
      },
      // Safari zooms each page by itself, and lets no extension zoom one or
      // know how far it is zoomed.
      setZoom: function (id, factor, cb) {
        return WEX.fail(typeof factor === "function" ? factor : cb,
          "Zooming a tab is not available in this browser.");
      },
      getZoomSettings: function (id, cb) {
        return done(typeof id === "function" ? id : cb,
          { mode: "automatic", scope: "per-origin", defaultZoomFactor: 1 });
      },
      setZoomSettings: function (id, settings, cb) {
        return WEX.fail(typeof settings === "function" ? settings : cb,
          "Changing a tab's zoom settings is not available in this browser.");
      },
      ZoomSettingsMode: { AUTOMATIC: "automatic", MANUAL: "manual", DISABLED: "disabled" },
      ZoomSettingsScope: { PER_ORIGIN: "per-origin", PER_TAB: "per-tab" },
      // Chrome moves the tabs in the order given, to `index` and the places
      // after it, or each to the end for -1; a tab it does not have fails the
      // whole call before any moves.
      move: function (ids, props, cb) {
        var p = props || {};
        var list = Array.isArray(ids) ? ids : [ids];
        for (var i = 0; i < list.length; i++) {
          if (!tabForId(list[i])) {
            return WEX.fail(cb, CONFIG.firefoxBuild ? "Invalid tab ID: " + list[i] : "No tab with id: " + list[i] + ".");
          }
        }
        if (unknownWindow(p.windowId)) {
          return WEX.fail(cb, noWindowError(p.windowId));
        }
        var moved = list.map(function (id, n) {
          var t = tabForId(id);
          var w = windowForId(p.windowId) || tabWindow(t);
          var leaving = tabWindow(t) !== w;
          moveTab(t, w, typeof p.index === "number" && p.index >= 0 ? p.index + n : w.tabs.length);
          if (leaving) {
            leaveGroup(t);
          }
          return tabInfo(t);
        });
        return done(cb, Array.isArray(ids) ? moved : moved[0]);
      },
      // Safari selects one tab at a time: the first named becomes active.
      highlight: function (info, cb) {
        var d = info || {};
        var w = d.windowId != null ? windowForId(d.windowId) : app.activeBrowserWindow;
        if (!w) {
          return WEX.fail(cb, noWindowError(d.windowId != null ? d.windowId : -2));
        }
        var indexes = Array.isArray(d.tabs) ? d.tabs : [d.tabs];
        for (var i = 0; i < indexes.length; i++) {
          if (!w.tabs[indexes[i]]) {
            return WEX.fail(cb, "No tab at index: " + indexes[i] + ".");
          }
        }
        if (!indexes.length) {
          return WEX.fail(cb, "No highlighted tab");
        }
        try {
          w.tabs[indexes[0]].activate();
        } catch (e) { /* the window stays as it is */ }
        return identifyAll().then(function () {
          return done(cb, windowInfo(w, true));
        });
      },
      // Firefox's captures of any tab, from the engine.
      captureTab: function (id, options, cb) {
        if (typeof id === "object" && id !== null) {
          cb = options;
          options = id;
          id = undefined;
        }
        if (typeof options === "function") {
          cb = options;
          options = undefined;
        }
        var args = id === undefined ? [options || {}] : [Number(id), options || {}];
        return settle(Promise.resolve().then(function () {
          return engine.tabs.captureTab.apply(engine.tabs, args);
        }), cb);
      },
      saveAsPDF: function (pageSettings, cb) {
        return settle(Promise.resolve().then(function () {
          return engine.tabs.saveAsPDF(pageSettings || {});
        }), cb);
      },

      // Safari keeps every tab it shows loaded.
      discard: function (id, cb) {
        var c = typeof id === "function" ? { id: activeTabId(), cb: id } : { id: id, cb: cb };
        return WEX.fail(c.cb, "Cannot discard tab with id: " + c.id + ".");
      },
      goBack: historyStep(-1),
      goForward: historyStep(1)
    };

    // A version 2 manifest's: the tab a window shows, its tabs, a request to
    // a tab's content scripts, and the events of the tab a window shows.
    if (WEX.hasLegacyRequests()) {
      tabs.getSelected = function (windowId, cb) {
        var c = typeof windowId === "function" ? { id: null, cb: windowId } : { id: windowId, cb: cb };
        var w = c.id == null ? app.activeBrowserWindow : windowForId(c.id);
        if (!w) {
          return WEX.fail(c.cb, "No window with id: " + c.id + ".");
        }
        return identify(w.activeTab).then(function () {
          return done(c.cb, tabInfo(w.activeTab));
        });
      };
      tabs.getAllInWindow = function (windowId, cb) {
        var c = typeof windowId === "function" ? { id: null, cb: windowId } : { id: windowId, cb: cb };
        var w = c.id == null ? app.activeBrowserWindow : windowForId(c.id);
        if (!w) {
          return WEX.fail(c.cb, "No window with id: " + c.id + ".");
        }
        return identifyAll().then(function () {
          return done(c.cb, w.tabs.map(tabInfo));
        });
      };
      tabs.sendRequest = function (tabId, request, cb) {
        WEX.answerRequest(engine.tabs.sendMessage(tabId, WEX.legacyRequest(request), {}), cb);
      };
      tabs.onSelectionChanged = tabsOnSelectionChanged;
      tabs.onActiveChanged = tabsOnActiveChanged;
      tabs.onHighlightChanged = tabsOnHighlightChanged;
    }

    var windows = {
      WINDOW_ID_NONE: -1,
      WINDOW_ID_CURRENT: -2,
      onCreated: windowsOnCreated,
      onRemoved: windowsOnRemoved,
      onFocusChanged: windowsOnFocusChanged,
      // Safari tells no extension where a window is or how big.
      onBoundsChanged: new Event("windows.onBoundsChanged"),

      get: function (id, opts, cb) {
        var c = WEX.shiftCallback(opts, cb);
        var w = windowForId(id);
        if (!w) {
          return WEX.fail(c.cb, "No window with id: " + id + ".");
        }
        return done(c.cb, windowInfo(w, c.opts.populate));
      },
      getCurrent: function (opts, cb) {
        var c = WEX.shiftCallback(opts, cb);
        return done(c.cb, windowInfo(app.activeBrowserWindow, c.opts.populate));
      },
      getLastFocused: function (opts, cb) {
        var c = WEX.shiftCallback(opts, cb);
        return done(c.cb, windowInfo(app.activeBrowserWindow, c.opts.populate));
      },
      getAll: function (opts, cb) {
        var c = WEX.shiftCallback(opts, cb);
        return done(c.cb, shownWindows().map(function (w) {
          return windowInfo(w, c.opts.populate);
        }));
      },
      create: function (props, cb) {
        var p = props || {};
        var urls = (Array.isArray(p.url) ? p.url : [p.url]).filter(function (url) {
          return typeof url === "string";
        });
        var refused = urls.map(unopenableUrlError).filter(Boolean)[0];
        if (refused) {
          return WEX.fail(cb, refused);
        }
        var given = p.tabId != null ? tabForId(p.tabId) : null;
        if (p.tabId != null && !given) {
          return WEX.fail(cb, CONFIG.firefoxBuild ? "Invalid tab ID: " + p.tabId : "No tab with id: " + p.tabId + ".");
        }
        var w = app.openBrowserWindow();
        var empty = urls.length ? null : w.activeTab;
        var navigations = urls.map(function (url, i) {
          var t = i === 0 ? w.activeTab : w.openTab("background");
          return NEW_TAB_URL.test(url) ? undefined :
            Promise.resolve().then(function () { return navigateTab(t, navigationUrl(url)); });
        });
        // The tab named comes to the new window, in place of its empty tab.
        var arrived = Promise.resolve();
        if (given) {
          moveTab(given, w, w.tabs.length);
          arrived = leaveGroup(given).then(function () {
            if (given.browserWindow !== w) {
              return;
            }
            try {
              given.activate();
              if (empty && empty !== given) {
                empty.close();
              }
            } catch (e) { /* the window keeps its empty tab */ }
          });
        }
        return settle(arrived.then(function () {
          return Promise.all(navigations);
        }).then(function () {
          return identify(w.activeTab);
        }).then(null, function () {}).then(function () {
          return windowInfo(w, true);
        }), cb);
      },
      update: function (id, props, cb) {
        var w = windowForId(id);
        if (!w) {
          return WEX.fail(cb, "No window with id: " + id + ".");
        }
        if (props && props.focused) {
          try {
            w.activate();
          } catch (e) { /* ignore */ }
        }
        return done(cb, windowInfo(w, true));
      },
      remove: function (id, cb) {
        var w = windowForId(id);
        if (!w) {
          return WEX.fail(cb, noWindowError(id));
        }
        try {
          w.close();
        } catch (e) { /* ignore */ }
        return done(cb);
      }
    };

    var action = {
      onClicked: actionOnClicked,
      // Fired as the user pins or unpins the icon; Safari's toolbar button
      // is there or not by the user's customizing, which is not reported.
      onUserSettingsChanged: new Event("action.onUserSettingsChanged"),

      setIcon: function (details, cb) {
        var d = details || {};
        // Firefox's way of giving up an icon: a tab's takes on the global
        // one, and the global one the manifest's.
        if (CONFIG.firefoxBuild && d.path == null && d.imageData == null) {
          delete tabIcons[d.tabId != null ? d.tabId : "__global"];
          refreshToolbar();
          return done(cb);
        }
        if (!d.path) {
          log.unsupported("an icon given as pixels (setIcon with imageData)");
          return done(cb);
        }
        var image = toolbarImage(
          callerUrl(typeof d.path === "string" ? d.path : pickLargest(d.path) || ""));
        if (image) {
          tabIcons[d.tabId != null ? d.tabId : "__global"] = image;
          refreshToolbar();
        }
        return done(cb);
      },

      setBadgeText: function (details, cb) {
        var d = details || {};
        var text = d.text == null ? "" : String(d.text);
        // A tab's empty text hides the badge on it; its null text gives it
        // the global one again.
        if (d.tabId != null) {
          if (d.text != null) {
            tabBadges[d.tabId] = text;
          } else {
            delete tabBadges[d.tabId];
          }
        } else {
          globalBadge = text;
        }
        refreshToolbar();
        return done(cb);
      },

      getBadgeText: function (details, cb) {
        var d = details || {};
        var text = (d.tabId != null && tabBadges[d.tabId] != null) ? tabBadges[d.tabId] : globalBadge;
        return done(cb, text || "");
      },

      setBadgeBackgroundColor: function (details, cb) {
        return setBadgeColor("background", details, cb);
      },
      getBadgeBackgroundColor: function (details, cb) {
        return badgeColor("background", details, cb);
      },
      setBadgeTextColor: function (details, cb) {
        return setBadgeColor("text", details, cb);
      },
      getBadgeTextColor: function (details, cb) {
        return badgeColor("text", details, cb);
      },

      setTitle: function (details, cb) {
        var d = details || {};
        if (d.tabId != null) {
          tabTitles[d.tabId] = d.title;
        } else {
          tabTitles.__global = d.title;
          toolbarItems().forEach(function (item) {
            try {
              item.toolTip = d.title;
            } catch (e) { /* ignore */ }
          });
        }
        refreshToolbar();
        return done(cb);
      },
      getTitle: function (details, cb) {
        var d = details || {};
        var t = (d.tabId != null && tabTitles[d.tabId] != null) ? tabTitles[d.tabId] : tabTitles.__global;
        var declaredAction = manifest.action || manifest.browser_action || manifest.page_action || {};
        return done(cb, t || declaredAction.default_title || manifest.name || "");
      },

      setPopup: function (details, cb) {
        var d = details || {};
        // Firefox's way of giving up a popup: a tab's takes on the global
        // one, and the global one the manifest's.
        if (CONFIG.firefoxBuild && d.popup === null) {
          if (d.tabId == null) {
            setPopupPage(DECLARED_POPUP);
          } else {
            delete tabPopups[d.tabId];
            refreshToolbar();
          }
          return done(cb);
        }
        var path = d.popup ? WEX.extPath(navigationUrl(d.popup)) : null;
        if (d.tabId == null) {
          setPopupPage(path);
        } else {
          tabPopups[d.tabId] = path || "";
          refreshToolbar();
        }
        return done(cb);
      },
      getPopup: function (details, cb) {
        var c = WEX.shiftCallback(details, cb);
        var path = popupFor(c.opts.tabId);
        return done(c.cb, path ? WEX.extUrl(path) : "");
      },

      enable: setActionEnabled(true),
      disable: setActionEnabled(false),
      // Chrome counts what the extension set, not what declarativeContent
      // shows.
      isEnabled: function (tabId, cb) {
        if (typeof tabId === "function") {
          cb = tabId;
          tabId = undefined;
        }
        var own = typeof tabId === "number" && tabActionEnabled[tabId] != null ?
          tabActionEnabled[tabId] : !actionDisabled;
        return done(cb, own);
      },
      openPopup: function (options, cb) {
        var c = WEX.shiftCallback(options, cb);
        if (unknownWindow(c.opts.windowId)) {
          return WEX.fail(c.cb, noWindowError(c.opts.windowId));
        }
        var w = windowForId(c.opts.windowId) || app.activeBrowserWindow;
        var item = toolbarItems().filter(function (candidate) {
          return !w || candidate.browserWindow === w;
        })[0];
        if (!showToolbarPopover(item)) {
          popoverShow();
        }
        return done(c.cb);
      },
      getUserSettings: function (cb) {
        return done(cb, { isOnToolbar: true });
      },
      // page_action-only members, harmless on a browser action.
      show: setActionEnabled(true),
      hide: setActionEnabled(false)
    };


    var contextMenus = {
      onClicked: contextMenusOnClicked,
      onShown: contextMenusOnShown,
      onHidden: contextMenusOnHidden,
      ACTION_MENU_TOP_LEVEL_LIMIT: 6,
      // Chrome's enums, which extensions read the contexts and types from.
      ContextType: {
        ALL: "all", PAGE: "page", FRAME: "frame", SELECTION: "selection", LINK: "link",
        EDITABLE: "editable", IMAGE: "image", VIDEO: "video", AUDIO: "audio",
        LAUNCHER: "launcher", BROWSER_ACTION: "browser_action", PAGE_ACTION: "page_action",
        ACTION: "action"
      },
      ItemType: { NORMAL: "normal", CHECKBOX: "checkbox", RADIO: "radio", SEPARATOR: "separator" },

      create: function (props, cb) {
        var p = props || {};
        if (CONFIG.firefoxBuild && p.onclick && LAZY_BACKGROUND) {
          throw new Error("Property \"onclick\" cannot be used in menus.create, replace with an " +
            "\"onClicked\" event listener.");
        }
        var id = p.id != null ? p.id : menuSeq++;
        var error = menuCreateError(p, id);
        if (error) {
          menuReply(cb, error);
          return id;
        }
        menuItems[String(id)] = {
          id: id,
          title: p.title,
          type: p.type || "normal",
          contexts: p.contexts || ["page"],
          parentId: p.parentId,
          documentUrlPatterns: p.documentUrlPatterns,
          targetUrlPatterns: p.targetUrlPatterns,
          enabled: p.enabled !== false,
          visible: p.visible !== false,
          checked: !!p.checked,
          onclick: p.onclick
        };
        saveMenus();
        refreshNativeActionMenus();
        menuReply(cb, null);
        return id;
      },
      update: function (id, props, cb) {
        var item = menuItems[String(id)];
        var p = props || {};
        var error = null;
        var type = p.type || (item && item.type);
        if (!item) {
          error = "Cannot find menu item with id " + id;
        } else if (CONFIG.firefoxBuild) {
          error = p.parentId != null && !menuItems[String(p.parentId)] ?
            "Cannot find menu item with id " + p.parentId : null;
        } else if (p.title != null && !String(p.title) && type !== "separator") {
          error = "All menu items except for separators must have a title";
        } else if (p.checked && type !== "checkbox" && type !== "radio") {
          error = "Only items with type \"radio\" or \"checkbox\" can be checked";
        } else if (p.parentId != null) {
          error = menuParentError(p.parentId);
        }
        if (!error) {
          Object.keys(p).forEach(function (k) {
            item[k] = p[k];
          });
          saveMenus();
          refreshNativeActionMenus();
        }
        return menuDone(cb, error);
      },
      remove: function (id, cb) {
        if (!menuItems[String(id)]) {
          return menuDone(cb, "Cannot find menu item with id " + id);
        }
        removeMenuItem(id);
        saveMenus();
        refreshNativeActionMenus();
        return menuDone(cb, null);
      },
      removeAll: function (cb) {
        menuItems = {};
        saveMenus();
        refreshNativeActionMenus();
        return done(cb);
      },
      refresh: function (cb) {
        return done(cb);
      }
    };

    var storage = {
      onChanged: storageOnChanged,
      local: storageLocal,
      sync: storageSync,
      session: storageSession,
      // No policy sets anything, so a query gets back the defaults it gives.
      managed: {
        get: function (query, cb) {
          var c = WEX.shiftCallback(query, cb);
          var defaults = {};
          if (c.opts && typeof c.opts === "object" && !Array.isArray(c.opts)) {
            Object.keys(c.opts).forEach(function (key) {
              defaults[key] = c.opts[key];
            });
          }
          return done(c.cb, defaults);
        },
        getBytesInUse: function (keys, cb) {
          return done(WEX.shiftCallback(keys, cb).cb, 0);
        },
        onChanged: new Event("storage.managed.onChanged")
      }
    };


    // A tab open since before the extension loaded is one the engine does
    // not know until it next loads a page, though Safari knows what it shows.
    var webNavigation = WEX.makeWebNavigation(engine, {
      onHistoryStateUpdated: navOnHistoryStateUpdated,
      onReferenceFragmentUpdated: navOnReferenceFragmentUpdated
    }, function (tabId) {
      var tab = typeof tabId === "number" ? tabForId(tabId) : null;
      if (!tab) {
        return null;
      }
      return {
        tabId: tabId,
        frameId: 0,
        parentFrameId: -1,
        url: tab.url || "about:blank",
        errorOccurred: false,
        processId: -1,
        frameType: "outermost_frame",
        documentLifecycle: "active"
      };
    }, function (tabId) {
      return !!runtimeTabIds[tabId];
    });
    // A page WebKit swaps in for a tab's is reported as Chrome reports it.
    tabsOnReplaced.addListener(function (addedTabId, removedTabId) {
      webNavigation.onTabReplaced.emit({ replacedTabId: removedTabId, tabId: addedTabId, timeStamp: Date.now() });
    });

    var webRequest = WEX.makeWebRequest(engine);

    // The privacy settings of the browser the extension was built for. The
    // engine controls network prediction and hyperlink auditing, and those
    // are its own. A feature Safari does not have (Chrome's Privacy Sandbox,
    // its Google services) is off, which an extension may set it to and no
    // more. Safari decides the rest itself: each reports Safari's value where
    // it is known (no Do Not Track, third-party cookies blocked), or the
    // browser's default, as a setting no extension can control, and a value
    // an extension sets leaves it as it is. Firefox answers such a change
    // with false, and Chrome takes it without effect, its setting still
    // reporting the value in force.
    function changed(cb, effective) {
      return done(cb, CONFIG.firefoxBuild ? effective : undefined);
    }

    function fixedSetting(name, value) {
      return {
        onChange: new Event("privacy." + name + ".onChange"),
        get: function (details, cb) {
          return done(WEX.shiftCallback(details, cb).cb,
            { value: value, levelOfControl: "not_controllable" });
        },
        set: function (details, cb) {
          return changed(cb, false);
        },
        clear: function (details, cb) {
          return changed(WEX.shiftCallback(details, cb).cb, false);
        }
      };
    }

    function absentSetting(name) {
      return {
        onChange: new Event("privacy." + name + ".onChange"),
        get: function (details, cb) {
          return done(WEX.shiftCallback(details, cb).cb,
            { value: false, levelOfControl: "controllable_by_this_extension" });
        },
        set: function (details, cb) {
          if (details && details.value === false) {
            return changed(cb, true);
          }
          if (CONFIG.firefoxBuild) {
            return done(cb, false);
          }
          return WEX.fail(cb, "privacy." + name + " cannot be turned on: this browser has no such feature.");
        },
        clear: function (details, cb) {
          return changed(WEX.shiftCallback(details, cb).cb, true);
        }
      };
    }

    // Browsing data. The engine's cookies, within the extension's website
    // access, are removed, and the caches the engine holds in memory are
    // emptied; the disk cache and the sites' own storage are out of an
    // extension's reach. A removal of which some part can be done succeeds,
    // as there is no telling an extension which part was; one of which none
    // can fails. Cookies have no creation time to tell the newer from, so a
    // removal of only the data since some time leaves them be.
    var BROWSING_DATA_TYPES = ["appcache", "cache", "cacheStorage", "cookies", "downloads",
      "fileSystems", "formData", "history", "indexedDB", "localStorage", "passwords",
      "pluginData", "serverBoundCertificates", "serviceWorkers", "webSQL"];

    function hostCovered(host, hosts) {
      return hosts.some(function (h) {
        return host === h || host.slice(-h.length - 1) === "." + h || h.slice(-host.length - 1) === "." + host;
      });
    }

    function originHosts(list) {
      return (list || []).map(function (origin) {
        try {
          return new URL(String(origin).indexOf("://") < 0 ? "https://" + origin : origin).hostname;
        } catch (e) {
          return String(origin);
        }
      });
    }

    function removeCookies(options) {
      var only = options.origins || options.hostnames ? originHosts(options.origins || options.hostnames) : null;
      var except = options.excludeOrigins ? originHosts(options.excludeOrigins) : [];
      return Promise.resolve(engine.cookies.getAll({})).then(function (cookies) {
        return Promise.all((cookies || []).filter(function (cookie) {
          var host = String(cookie.domain || "").replace(/^\./, "");
          return (!only || hostCovered(host, only)) && !hostCovered(host, except);
        }).map(function (cookie) {
          var host = String(cookie.domain || "").replace(/^\./, "");
          return engine.cookies.remove({
            url: (cookie.secure ? "https://" : "http://") + host + (cookie.path || "/"),
            name: cookie.name,
            storeId: cookie.storeId
          });
        }));
      });
    }

    function removeBrowsingData(options, dataToRemove) {
      var o = options || {};
      var types = dataToRemove || {};
      var work = [];
      if (types.cookies && !(o.since > 0) && engine.cookies) {
        work.push(removeCookies(o));
      }
      if (types.cache && engine.webRequest && engine.webRequest.handlerBehaviorChanged) {
        work.push(Promise.resolve(engine.webRequest.handlerBehaviorChanged()));
      }
      if (!work.length) {
        return Promise.reject(new Error("Removing that browsing data is not available in this browser."));
      }
      return Promise.all(work).then(function () {});
    }

    var browsingData = {
      remove: function (options, dataToRemove, cb) {
        return settle(removeBrowsingData(options, dataToRemove), cb);
      },
      settings: function (cb) {
        var permitted = {};
        BROWSING_DATA_TYPES.forEach(function (type) {
          permitted[type] = type === "cookies" || type === "cache";
        });
        return done(cb, { options: { since: 0 }, dataToRemove: {}, dataRemovalPermitted: permitted });
      }
    };
    BROWSING_DATA_TYPES.forEach(function (type) {
      var method = "remove" + type.charAt(0).toUpperCase() + type.slice(1);
      browsingData[method] = function (options, cb) {
        var c = WEX.shiftCallback(options, cb);
        var only = {};
        only[type] = true;
        return settle(removeBrowsingData(c.opts, only), c.cb);
      };
    });

    var ENGINE = "engine";
    var ABSENT = "absent";
    var PRIVACY_SETTINGS = CONFIG.firefoxBuild ? {
      network: { networkPredictionEnabled: ENGINE, peerConnectionEnabled: true,
        webRTCIPHandlingPolicy: "default", httpsOnlyMode: "never", globalPrivacyControl: false },
      services: { passwordSavingEnabled: true },
      websites: { cookieConfig: { behavior: "reject_third_party", nonPersistentCookies: false },
        firstPartyIsolate: false, hyperlinkAuditingEnabled: ENGINE, protectedContentEnabled: ABSENT,
        referrersEnabled: true, resistFingerprinting: false, thirdPartyCookiesAllowed: false,
        trackingProtectionMode: "never" }
    } : {
      network: { networkPredictionEnabled: ENGINE, webRTCIPHandlingPolicy: "default",
        webRTCMultipleRoutesEnabled: true, webRTCNonProxiedUdpEnabled: true },
      services: { alternateErrorPagesEnabled: ABSENT, autofillAddressEnabled: true,
        autofillCreditCardEnabled: true, autofillEnabled: true, passwordSavingEnabled: true,
        safeBrowsingEnabled: true, safeBrowsingExtendedReportingEnabled: ABSENT,
        searchSuggestEnabled: true, spellingServiceEnabled: ABSENT, translationServiceEnabled: ABSENT },
      websites: { adMeasurementEnabled: ABSENT, doNotTrackEnabled: false, fledgeEnabled: ABSENT,
        hyperlinkAuditingEnabled: ENGINE, protectedContentEnabled: ABSENT, referrersEnabled: true,
        relatedWebsiteSetsEnabled: ABSENT, thirdPartyCookiesAllowed: false, topicsEnabled: ABSENT }
    };
    // Firefox's browserSettings: how Safari behaves, which the extension may
    // read and not change.
    var newTabOverride = ((CONFIG.manifest || {}).chrome_url_overrides || {}).newtab;
    var browserSettings = {};
    var BROWSER_SETTINGS = {
      allowPopupsForUserEvents: true,
      cacheEnabled: true,
      closeTabsByDoubleClick: false,
      contextMenuShowEvent: "mousedown",
      ftpProtocolEnabled: false,
      homepageOverride: "about:home",
      imageAnimationBehavior: "normal",
      newTabPageOverride: newTabOverride ? WEX.extUrl(String(newTabOverride).replace(/^\/+/, "")) : "about:newtab",
      newTabPosition: "atEnd",
      openBookmarksInNewTabs: false,
      openSearchResultsInNewTabs: false,
      openUrlbarResultsInNewTabs: false,
      webNotificationsDisabled: false,
      overrideDocumentColors: "never",
      overrideContentColorScheme: "light",
      useDocumentFonts: true,
      zoomFullPage: true,
      zoomSiteSpecific: false,
      verticalTabs: false
    };
    Object.keys(BROWSER_SETTINGS).forEach(function (name) {
      browserSettings[name] = fixedSetting("browserSettings." + name, BROWSER_SETTINGS[name]);
    });

    var privacy = {};
    Object.keys(PRIVACY_SETTINGS).forEach(function (group) {
      privacy[group] = {};
      Object.keys(PRIVACY_SETTINGS[group]).forEach(function (key) {
        var kind = PRIVACY_SETTINGS[group][key];
        var name = group + "." + key;
        var own = engine.privacy && engine.privacy[group] && engine.privacy[group][key];
        if (kind === ENGINE && own && typeof own.get === "function") {
          privacy[group][key] = own;
        } else if (kind === ABSENT || kind === ENGINE) {
          privacy[group][key] = kind === ABSENT ? absentSetting(name) : fixedSetting(name, true);
        } else {
          privacy[group][key] = fixedSetting(name, kind);
        }
      });
    });
    privacy.IPHandlingPolicy = {
      DEFAULT: "default", DEFAULT_PUBLIC_AND_PRIVATE_INTERFACES: "default_public_and_private_interfaces",
      DEFAULT_PUBLIC_INTERFACE_ONLY: "default_public_interface_only",
      DISABLE_NON_PROXIED_UDP: "disable_non_proxied_udp"
    };

    var declarativeNetRequest = WEX.makeDeclarativeNetRequest(engine, function () {
      refreshResponseRules();
    });
    refreshResponseRules = WEX.installResponseHeaderRules(engine, declarativeNetRequest);

    var scripting = {
      executeScript: injection.scripting.executeScript,
      insertCSS: injection.scripting.insertCSS,
      removeCSS: injection.scripting.removeCSS,
      registerContentScripts: function (scripts, cb) {
        var list = scripts || [];
        var seen = {};
        var specs = [];
        var error = null;
        list.some(function (script) {
          error = scriptIdError(script.id) ||
            (seen[script.id] || dynamicContentScripts[script.id] ?
              "Duplicate script ID '" + script.id + "'" : null) ||
            scriptSpecError(script);
          seen[script.id] = true;
          if (!error) {
            specs.push(normalizedScript(script));
          }
          return !!error;
        });
        if (error) {
          return WEX.fail(cb, error);
        }
        specs.forEach(registerContentScript);
        saveContentScripts();
        return done(cb);
      },
      unregisterContentScripts: function (filter, cb) {
        var c = WEX.shiftCallback(filter, cb);
        var ids = c.opts.ids || Object.keys(dynamicContentScripts);
        var error = null;
        if (c.opts.ids) {
          ids.some(function (id) {
            error = scriptIdError(id) ||
              (dynamicContentScripts[id] ? null : "Nonexistent script ID '" + id + "'");
            return !!error;
          });
        }
        if (error) {
          return WEX.fail(c.cb, error);
        }
        ids.forEach(unregisterContentScript);
        saveContentScripts();
        return done(c.cb);
      },
      updateContentScripts: function (scripts, cb) {
        var specs = [];
        var error = null;
        var seen = {};
        (scripts || []).some(function (s) {
          error = scriptIdError(s.id) || (seen[s.id] ? "Duplicate script ID '" + s.id + "'" : null);
          seen[s.id] = true;
          return !!error;
        });
        (scripts || []).some(function (s) {
          if (error) {
            return true;
          }
          var existing = dynamicContentScripts[s.id];
          error = existing ? null : "Script with ID '" + s.id + "' does not exist or is not fully registered";
          if (!error) {
            var merged = {};
            Object.keys(existing.spec).concat(Object.keys(s)).forEach(function (k) {
              merged[k] = k in s ? s[k] : existing.spec[k];
            });
            error = scriptSpecError(merged);
            if (!error) {
              specs.push(normalizedScript(merged));
            }
          }
          return !!error;
        });
        if (error) {
          return WEX.fail(cb, error);
        }
        specs.forEach(registerContentScript);
        saveContentScripts();
        return done(cb);
      },
      getRegisteredContentScripts: function (filter, cb) {
        var c = WEX.shiftCallback(filter, cb);
        var ids = c.opts.ids || Object.keys(dynamicContentScripts);
        return done(c.cb, ids.filter(function (id) {
          return !!dynamicContentScripts[id];
        }).map(function (id) {
          return JSON.parse(JSON.stringify(dynamicContentScripts[id].spec));
        }));
      },
      ExecutionWorld: { ISOLATED: "ISOLATED", MAIN: "MAIN" }
    };

    // Chrome's user scripts. The world Chrome gives them, a world apart from
    // the page's and from the content scripts', is here the extension's
    // content-script world, which Safari gives each extension one of: their
    // scripts run beside the content scripts, and what they send with
    // runtime.sendMessage or connect arrives as the content scripts' does.
    // A script for the page's own world is the engine's, as a registered
    // content script's is, and names its code by file. The registrations
    // persist across sessions, as Chrome keeps them until the extension
    // changes.
    var userScripts = (function () {
      var USER_PREFIX = "wex.userScript.";
      var WORLDS_KEY = "wex.userScriptWorlds";
      var worlds = {};
      try {
        worlds = JSON.parse(settingsItem(WORLDS_KEY) || "{}") || {};
      } catch (e) { /* none configured */ }

      function idError(id) {
        if (typeof id !== "string" || !id) {
          return "User script ID must not be empty.";
        }
        if (id.charAt(0) === "_") {
          return "ID '" + id + "' must not start with '_'";
        }
        return null;
      }

      function sourcesError(id, js) {
        if (!Array.isArray(js) || !js.length) {
          return "User script with ID '" + id + "' must specify at least one js source.";
        }
        var bad = js.some(function (entry) {
          return !entry || typeof entry !== "object" || (entry.code == null) === (entry.file == null);
        });
        return bad ? "User script with ID '" + id + "' must specify exactly one of 'code' or 'file' as a js source." : null;
      }

      function specError(script) {
        var error = sourcesError(script.id, script.js);
        if (error) {
          return error;
        }
        if (!Array.isArray(script.matches) || !script.matches.length) {
          return "User script with ID '" + script.id + "' must specify at least one match.";
        }
        var bad = null;
        script.matches.concat(script.excludeMatches || []).some(function (pattern) {
          var problem = matchPatternError(pattern);
          if (problem) {
            bad = "Script with ID '" + script.id + "' has invalid value for matches[0]: " + problem;
          }
          return !!problem;
        });
        if (bad) {
          return bad;
        }
        if (script.world != null && script.world !== "USER_SCRIPT" && script.world !== "MAIN") {
          return "Invalid world '" + script.world + "'.";
        }
        if (script.world === "MAIN" && script.js.some(function (entry) {
          return entry.code != null;
        })) {
          return "User script with ID '" + script.id + "' for the page's world must name its code by file.";
        }
        return null;
      }

      // The script as Chrome describes it back, every field given its
      // default.
      function normalized(script) {
        var out = {
          id: script.id,
          js: script.js.map(function (entry) {
            return entry.code != null ? { code: String(entry.code) } : { file: String(entry.file).replace(/^\/+/, "") };
          }),
          matches: script.matches.slice(),
          allFrames: !!script.allFrames,
          runAt: script.runAt || "document_idle",
          world: script.world || "USER_SCRIPT"
        };
        ["excludeMatches", "includeGlobs", "excludeGlobs"].forEach(function (key) {
          if (Array.isArray(script[key]) && script[key].length) {
            out[key] = script[key].slice();
          }
        });
        if (script.worldId != null) {
          out.worldId = String(script.worldId);
        }
        return out;
      }

      // A glob's test of the document's URL: `*` stands for any run of
      // characters and `?` for one.
      function globSource(glob) {
        return String(glob).replace(/[.+^${}()|[\]\\\/]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
      }

      function globTest(spec) {
        var tests = [];
        if (spec.includeGlobs) {
          tests.push("/^(?:" + spec.includeGlobs.map(globSource).join("|") + ")$/.test(location.href)");
        }
        if (spec.excludeGlobs) {
          tests.push("!/^(?:" + spec.excludeGlobs.map(globSource).join("|") + ")$/.test(location.href)");
        }
        return tests.length ? tests.join(" && ") : null;
      }

      // What Safari is given for a script of the user-script world: each
      // source as one content script, which a script's globs guard.
      function contentSpec(spec) {
        var test = globTest(spec);
        return {
          id: USER_PREFIX + spec.id,
          matches: spec.matches,
          excludeMatches: spec.excludeMatches,
          allFrames: spec.allFrames,
          runAt: spec.runAt,
          js: spec.js.map(function (entry) {
            var code = entry.code != null ? entry.code : WEX.readTextSync(WEX.extPath(WEX.extUrl(entry.file)));
            if (code == null || test === null) {
              return code == null ? null : { code: code };
            }
            var guarded = WEX.guardedScript(code, test);
            if (guarded === null) {
              log.warn("the user script " + spec.id + " runs without its globs, as its source could not be followed");
            }
            return { code: guarded === null ? code : guarded };
          }).filter(Boolean)
        };
      }

      function register(spec) {
        unregister(spec.id);
        var entry = { spec: spec };
        if (spec.world === "MAIN") {
          entry.page = enginePageWorldScript(USER_PREFIX + spec.id, {
            id: spec.id, matches: spec.matches, excludeMatches: spec.excludeMatches,
            js: spec.js.map(function (source) {
              return source.file;
            }), allFrames: spec.allFrames, runAt: spec.runAt
          });
        } else {
          entry.handles = addContentScripts(contentSpec(spec));
        }
        userScriptEntries[spec.id] = entry;
        if (entry.page) {
          syncPageWorldScripts();
        }
      }

      function unregister(id) {
        var entry = userScriptEntries[id];
        if (!entry) {
          return;
        }
        delete userScriptEntries[id];
        if (entry.handles) {
          removeContentScripts(entry.handles);
        } else {
          syncPageWorldScripts();
        }
      }

      function save() {
        settingsItem(USER_SCRIPTS_KEY, JSON.stringify(Object.keys(userScriptEntries).map(function (id) {
          return userScriptEntries[id].spec;
        })));
      }

      function filterIds(filter) {
        return filter && Array.isArray(filter.ids) ? filter.ids : Object.keys(userScriptEntries);
      }

      try {
        (JSON.parse(settingsItem(USER_SCRIPTS_KEY) || "[]") || []).forEach(register);
      } catch (e) { /* none kept */ }

      function worldKey(worldId) {
        return worldId == null ? "" : String(worldId);
      }

      return {
        ExecutionWorld: { MAIN: "MAIN", USER_SCRIPT: "USER_SCRIPT" },
        register: function (scripts, cb) {
          var list = Array.isArray(scripts) ? scripts : [];
          var seen = {};
          var specs = [];
          var error = null;
          list.some(function (script) {
            script = script || {};
            error = idError(script.id) ||
              (seen[script.id] || userScriptEntries[script.id] ? "Duplicate script ID '" + script.id + "'" : null) ||
              specError(script);
            seen[script.id] = true;
            if (!error) {
              specs.push(normalized(script));
            }
            return !!error;
          });
          if (error) {
            return WEX.fail(cb, error);
          }
          specs.forEach(register);
          save();
          return done(cb);
        },
        update: function (scripts, cb) {
          var specs = [];
          var error = null;
          var seen = {};
          (Array.isArray(scripts) ? scripts : []).some(function (script) {
            script = script || {};
            error = idError(script.id) || (seen[script.id] ? "Duplicate script ID '" + script.id + "'" : null);
            seen[script.id] = true;
            var existing = !error && userScriptEntries[script.id];
            if (!error && !existing) {
              error = "Script with ID '" + script.id + "' does not exist or is not fully registered";
            }
            if (!error) {
              var merged = {};
              Object.keys(existing.spec).concat(Object.keys(script)).forEach(function (key) {
                merged[key] = key in script ? script[key] : existing.spec[key];
              });
              error = specError(merged);
              if (!error) {
                specs.push(normalized(merged));
              }
            }
            return !!error;
          });
          if (error) {
            return WEX.fail(cb, error);
          }
          specs.forEach(register);
          save();
          return done(cb);
        },
        unregister: function (filter, cb) {
          var c = WEX.shiftCallback(filter, cb);
          var ids = filterIds(c.opts);
          var error = null;
          if (c.opts && Array.isArray(c.opts.ids)) {
            ids.some(function (id) {
              error = idError(id) || (userScriptEntries[id] ? null : "Nonexistent script ID '" + id + "'");
              return !!error;
            });
          }
          if (error) {
            return WEX.fail(c.cb, error);
          }
          ids.forEach(unregister);
          save();
          return done(c.cb);
        },
        getScripts: function (filter, cb) {
          var c = WEX.shiftCallback(filter, cb);
          return done(c.cb, filterIds(c.opts).filter(function (id) {
            return !!userScriptEntries[id];
          }).map(function (id) {
            return JSON.parse(JSON.stringify(userScriptEntries[id].spec));
          }));
        },
        execute: function (details, cb) {
          return injection.userScripts.execute(details, cb);
        },
        // A world's policy and messaging are recorded and told back; the
        // world the scripts run in is the content scripts', whose policy
        // is Safari's, and which may always send messages.
        configureWorld: function (properties, cb) {
          var p = properties || {};
          var key = worldKey(p.worldId);
          var world = {};
          if (p.csp != null) {
            world.csp = String(p.csp);
          }
          if (p.messaging != null) {
            world.messaging = !!p.messaging;
          }
          if (key) {
            world.worldId = key;
          }
          worlds[key] = world;
          settingsItem(WORLDS_KEY, JSON.stringify(worlds));
          return done(cb);
        },
        getWorldConfigurations: function (cb) {
          return done(cb, Object.keys(worlds).map(function (key) {
            return JSON.parse(JSON.stringify(worlds[key]));
          }));
        },
        resetWorldConfiguration: function (worldId, cb) {
          var c = typeof worldId === "function" ? { id: undefined, cb: worldId } : { id: worldId, cb: cb };
          delete worlds[worldKey(c.id)];
          settingsItem(WORLDS_KEY, JSON.stringify(worlds));
          return done(c.cb);
        }
      };
    })();

    // Firefox's way of registering content scripts at run time.
    var contentScripts = {
      register: function (options, cb) {
        var handles = addContentScripts(options || {});
        return done(cb, {
          unregister: function () {
            removeContentScripts(handles);
            return Promise.resolve();
          }
        });
      }
    };

    var cookies = engine.cookies;

    var alarms = {
      onAlarm: alarmsOnAlarm,
      create: function (name, info, cb) {
        if (typeof name === "object" && name !== null) {
          cb = info;
          info = name;
          name = undefined;
        }
        return settle(createAlarm(name, info || {}), cb);
      },
      get: function (name, cb) {
        var found = findAlarm(typeof name === "string" ? name : "");
        return done(typeof name === "function" ? name : cb, found ? publicAlarm(found) : undefined);
      },
      getAll: function (cb) {
        return done(cb, alarmList.map(publicAlarm));
      },
      clear: function (name, cb) {
        var found = findAlarm(typeof name === "string" ? name : "");
        if (found) {
          removeAlarm(found);
          saveAlarms();
        }
        return done(typeof name === "function" ? name : cb, !!found);
      },
      clearAll: function (cb) {
        alarmList = [];
        saveAlarms();
        schedulePoll();
        return done(cb, CONFIG.firefoxBuild ? undefined : true);
      }
    };

    var notifications = makeNotifications();
    var downloads = makeDownloads();


    var namespace = {
      __wex: true,
      __wexNative: engine,
      runtime: runtime,
      extension: extension,
      storage: storage,
      tabs: tabs,
      sessions: makeSessions(tabs, windows),
      sidePanel: makeSidePanel(),
      "debugger": makeDebugger(),
      browserSettings: browserSettings,
      // Firefox's containers, as Firefox has them when they are turned off:
      // Safari keeps one cookie store, and has none to give a container.
      contextualIdentities: (function () {
        var api = {
          onCreated: new Event("contextualIdentities.onCreated"),
          onUpdated: new Event("contextualIdentities.onUpdated"),
          onRemoved: new Event("contextualIdentities.onRemoved"),
          onSiteAssociationChanged: new Event("contextualIdentities.onSiteAssociationChanged")
        };
        ["get", "query", "getSupportedColors", "getSupportedIcons", "create", "update", "move", "remove",
          "setSiteAssociation", "removeSiteAssociation", "getSiteAssociation", "querySiteAssociations"
        ].forEach(function (name) {
          api[name] = function () {
            var cb = arguments[arguments.length - 1];
            return WEX.fail(typeof cb === "function" ? cb : null, "Contextual identities are currently disabled");
          };
        });
        return api;
      })(),
      tabGroups: makeTabGroups(),
      windows: windows,
      i18n: i18n,
      browserAction: action,
      action: action,
      pageAction: action,
      contextMenus: contextMenus,
      menus: contextMenus,
      webNavigation: webNavigation,
      webRequest: webRequest,
      declarativeNetRequest: declarativeNetRequest,
      scripting: scripting,
      userScripts: userScripts,
      contentScripts: contentScripts,
      cookies: cookies,
      alarms: alarms,
      notifications: notifications,
      downloads: downloads,
      commands: makeCommands(),
      tts: makeTts(),
      omnibox: makeOmnibox(),
      declarativeContent: makeDeclarativeContent(),
      dom: WEX.makePageDom(g),
      publicSuffix: WEX.makePublicSuffix(),
      pageCapture: makePageCapture(),
      // Safari's print dialog never asks an extension for printers, so none
      // of these fire.
      printerProvider: {
        onGetPrintersRequested: new Event("printerProvider.onGetPrintersRequested"),
        onGetUsbPrinterInfoRequested: new Event("printerProvider.onGetUsbPrinterInfoRequested"),
        onGetCapabilityRequested: new Event("printerProvider.onGetCapabilityRequested"),
        onPrintRequested: new Event("printerProvider.onPrintRequested")
      },
      // Safari receives no Google Cloud Messaging, so the calls fail as
      // Chrome's do where GCM is disabled, and the events never fire.
      gcm: (function () {
        var GCM_DISABLED = "GCM is disabled";
        return {
          MAX_MESSAGE_SIZE: 4096,
          register: function (senderIds, cb) {
            return WEX.fail(cb, GCM_DISABLED);
          },
          unregister: function (cb) {
            return WEX.fail(cb, GCM_DISABLED);
          },
          send: function (message, cb) {
            return WEX.fail(cb, GCM_DISABLED);
          },
          onMessage: new Event("gcm.onMessage"),
          onMessagesDeleted: new Event("gcm.onMessagesDeleted"),
          onSendError: new Event("gcm.onSendError")
        };
      })(),
      // Safari cannot hand an extension a tab's audio or video, so no tab is
      // ever captured: a capture fails as Chrome's does when it does not
      // start, and the status never changes. A service worker has no
      // `capture`, as in Chrome.
      tabCapture: (function () {
        var NOT_STARTED = "Error starting tab capture";
        var api = {
          getCapturedTabs: function (cb) {
            return done(cb, []);
          },
          getMediaStreamId: function (options, cb) {
            return WEX.fail(typeof options === "function" ? options : cb, NOT_STARTED);
          },
          onStatusChanged: new Event("tabCapture.onStatusChanged")
        };
        if (!CONFIG.backgroundWorker) {
          api.capture = function (options, cb) {
            return WEX.fail(cb, NOT_STARTED);
          };
        }
        return api;
      })(),
      // Everything the bundle asks for is granted at install, except an API
      // this host does not have: an extension that is told it holds
      // `tabGroups` goes on to use chrome.tabGroups.
      permissions: {
        onAdded: new Event("permissions.onAdded"),
        onRemoved: new Event("permissions.onRemoved"),
        contains: function (query, cb) {
          return done(cb, ((query && query.permissions) || []).every(permissionAvailable));
        },
        request: function (query, cb) {
          return done(cb, ((query && query.permissions) || []).every(permissionAvailable));
        },
        remove: function (_, cb) {
          return done(cb, false);
        },
        getAll: function (cb) {
          var declared = (CONFIG.manifest && CONFIG.manifest.permissions) || [];
          return done(cb, {
            permissions: declared.filter(function (p) {
              return typeof p === "string" && p.indexOf("://") < 0 && p !== "<all_urls>" &&
                permissionAvailable(p);
            }),
            origins: ["<all_urls>"]
          });
        }
      },
      idle: {
        onStateChanged: new Event("idle.onStateChanged"),
        queryState: function (_, cb) {
          return done(typeof _ === "function" ? _ : cb, "active");
        },
        setDetectionInterval: function () {}
      },
      // The extension knows of itself alone: Safari tells it of no other.
      management: {
        getSelf: function (cb) {
          return done(cb, selfInfo());
        },
        get: function (id, cb) {
          if (id === WEX.runtimeId || id === CONFIG.extensionId) {
            return done(cb, selfInfo());
          }
          return WEX.fail(cb, "Failed to find extension with id " + id + ".");
        },
        getAll: function (cb) {
          return done(cb, [selfInfo()]);
        },
        getPermissionWarningsById: CONFIG.firefoxBuild ? undefined : function (id, cb) {
          if (id !== WEX.runtimeId && id !== CONFIG.extensionId) {
            return WEX.fail(cb, "Failed to find extension with id " + id + ".");
          }
          try {
            return done(cb, permissionWarnings(CONFIG.manifest || {}));
          } catch (e) {
            return WEX.fail(cb, e.message);
          }
        },
        getPermissionWarningsByManifest: CONFIG.firefoxBuild ? undefined : warningsByManifest,
        // Safari lets only its user uninstall an extension, in its preferences.
        uninstallSelf: function (_, cb) {
          return WEX.fail(typeof _ === "function" ? _ : cb,
            "An extension cannot uninstall itself in this browser.");
        },
        onInstalled: new Event("management.onInstalled"),
        onUninstalled: new Event("management.onUninstalled"),
        onEnabled: new Event("management.onEnabled"),
        onDisabled: new Event("management.onDisabled"),
        ExtensionInstallType: { ADMIN: "admin", DEVELOPMENT: "development", NORMAL: "normal",
          SIDELOAD: "sideload", OTHER: "other" },
        ExtensionType: { EXTENSION: "extension", THEME: "theme" }
      },
      privacy: privacy,
      browsingData: browsingData,
      offscreen: {
        createDocument: function (parameters, cb) {
          return settle(createOffscreenDocument(parameters), cb);
        },
        closeDocument: function (cb) {
          return settle(closeOffscreenDocument(), cb);
        },
        hasDocument: function (cb) {
          return done(cb, !!offscreenDocument && offscreenDocument.ready);
        }
      },
      identity: makeIdentity(),
      proxy: WEX.makeProxy(engine),
      dns: engine.dns,
      sidebarAction: {
        open: function (cb) {
          if (CONFIG.sidebarPage) {
            return settle(openExtensionPage(CONFIG.sidebarPage).then(function () {}), cb);
          }
          return done(cb);
        },
        close: function (cb) {
          return done(cb);
        },
        setPanel: function (details, cb) {
          if (details && details.panel) {
            CONFIG.sidebarPage = details.panel;
          }
          return done(cb);
        },
        isOpen: function (_, cb) {
          var url = CONFIG.sidebarPage ? WEX.extUrl(CONFIG.sidebarPage) : null;
          return done(typeof _ === "function" ? _ : cb, !!url && allTabs().some(function (t) {
            return String(t.url || "").indexOf(url) === 0;
          }));
        },
        // Safari has no sidebar to title or decorate; the sidebar page opens
        // as a tab.
        setTitle: function (_, cb) {
          return done(cb);
        },
        getTitle: function (_, cb) {
          var sidebar = (CONFIG.manifest && CONFIG.manifest.sidebar_action) || {};
          return done(typeof _ === "function" ? _ : cb, sidebar.default_title || manifest.name || "");
        },
        setIcon: function (_, cb) {
          return done(cb);
        },
        getPanel: function (_, cb) {
          return done(typeof _ === "function" ? _ : cb,
            CONFIG.sidebarPage ? WEX.extUrl(CONFIG.sidebarPage) : "");
        },
        toggle: function (cb) {
          return namespace.sidebarAction.open(cb);
        }
      },
      // Firefox's theme, which Safari has none of to share: the current one is
      // the browser's own, as Firefox describes its default, and it cannot
      // be changed, only reset to itself.
      theme: {
        getCurrent: function (_, cb) {
          return done(typeof _ === "function" ? _ : cb, { colors: null, images: null, properties: null });
        },
        update: function (_, __, cb) {
          return WEX.fail(typeof __ === "function" ? __ : cb,
            "Changing the theme is not available in this browser.");
        },
        reset: function (_, cb) {
          return done(typeof _ === "function" ? _ : cb);
        },
        onUpdated: new Event("theme.onUpdated")
      }
    };

    return namespace;
  }

  // The largest of an icon set, whose mask was drawn from the most detail.
  function pickLargest(sizeMap) {
    var keys = Object.keys(sizeMap);
    var sizes = keys.map(Number).filter(function (n) {
      return !isNaN(n);
    }).sort(function (a, b) {
      return a - b;
    });
    if (!sizes.length) {
      return keys.length ? sizeMap[keys[0]] : null;
    }
    return sizeMap[sizes[sizes.length - 1]];
  }

  // ------------------------------------------------------------------ //
  // Toolbar images
  // ------------------------------------------------------------------ //
  // Safari draws a toolbar image as a mask, using only its alpha channel, and
  // takes one only from a file in the bundle. The converter has drawn a mask
  // for each icon the extension may switch to (icons.js), so the icon an
  // extension sets while running is swapped for its mask. An icon with no
  // mask is used as it is, and pixels handed over directly cannot be shown.
  function toolbarImage(url) {
    if (!WEX.isExtUrl(url)) {
      return null;
    }
    var path = WEX.extPath(String(url).split(/[?#]/)[0]);
    try {
      path = decodeURIComponent(path);
    } catch (e) { /* keep it as it is */ }
    var masks = CONFIG.toolbarImages || {};
    return Object.prototype.hasOwnProperty.call(masks, path) ? WEX.extUrl(masks[path]) : url;
  }

  // Safari gives extensions no keyboard shortcuts of its own; the bridge
  // and the extension's pages listen for the ones Chrome would assign
  // (WEX.commandShortcuts), in the pages the extension can reach, and tell
  // the global page which was pressed. Firefox's commands.update keeps a
  // new description; a shortcut it asks for is not taken up.
  var commandDescriptions = {};

  function commandList() {
    var commands = (CONFIG.manifest && CONFIG.manifest.commands) || {};
    var shortcuts = {};
    WEX.commandShortcuts(CONFIG.manifest).forEach(function (s) {
      shortcuts[s.name] = s.text;
    });
    return Object.keys(commands).map(function (name) {
      return {
        name: name,
        description: hasOwnKey(commandDescriptions, name) ? commandDescriptions[name] :
          commands[name].description || "",
        shortcut: shortcuts[name] || ""
      };
    });
  }

  // A shortcut pressed in a tab: the action's own command does what a
  // click on the toolbar button does, and any other is reported.
  var ACTION_COMMANDS = ["_execute_action", "_execute_browser_action", "_execute_page_action"];

  function runCommand(name, sender) {
    var commands = (CONFIG.manifest && CONFIG.manifest.commands) || {};
    if (!hasOwnKey(commands, name)) {
      return;
    }
    var safariTab = sender && sender.tab ? tabForId(sender.tab.id) : activeTab();
    var w = (safariTab && safariTab.browserWindow) || app.activeBrowserWindow;
    if (ACTION_COMMANDS.indexOf(name) >= 0) {
      var item = itemForWindow(w);
      try {
        if (item && item.popover) {
          item.showPopover();
          return;
        }
      } catch (e) { /* reported as a click */ }
      reportToolbarClick();
      return;
    }
    commandsOnCommand.emit(name, safariTab ? tabInfo(safariTab) : undefined);
  }

  function hasOwnKey(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  // ------------------------------------------------------------------ //
  // Downloads
  // ------------------------------------------------------------------ //
  // The extension's downloads. The global page fetches each itself, so that
  // its progress, pausing and cancelling are the extension's to see and do,
  // and then a page of the runtime, in a hidden tab that closes once it is
  // done, hands the file to Safari to save under the name chosen for it.
  // Safari keeps to itself which folder it saves into: an item's filename is
  // the name the file was given, and the file cannot be opened, shown or
  // removed from here. The items are kept across restarts, as a browser's
  // download history is, and one a restart cut short is interrupted. The
  // downloads the user starts in Safari are not the extension's to see.
  var DOWNLOADS_KEY = "wex.downloads";
  var DOWNLOAD_PAGE = "wex/wex-download.html";
  var DOWNLOAD_SAVE_TIMEOUT = 30000;
  var DOWNLOAD_SORT_KEYS = ["bytesReceived", "danger", "endTime", "exists", "filename", "mime", "paused",
    "startTime", "state", "totalBytes", "url", "finalUrl"];
  var DOWNLOAD_FILTER_KEYS = ["bytesReceived", "exists", "filename", "mime", "paused", "endTime", "startTime",
    "totalBytes", "url", "finalUrl", "id", "state", "danger", "error"];
  // The fields whose changes onChanged reports; progress is not among them.
  var DOWNLOAD_CHANGE_KEYS = ["url", "finalUrl", "filename", "danger", "mime", "startTime", "endTime", "state",
    "canResume", "paused", "error", "totalBytes", "fileSize", "exists"];
  var DOWNLOAD_STATES = ["in_progress", "interrupted", "complete"];
  var DOWNLOAD_DANGERS = ["file", "url", "content", "uncommon", "host", "unwanted", "safe", "accepted"];
  var FORBIDDEN_DOWNLOAD_HEADERS = ["accept-charset", "accept-encoding", "access-control-request-headers",
    "access-control-request-method", "access-control-request-private-network", "connection",
    "content-length", "cookie", "cookie2", "date", "dnt", "expect", "host", "keep-alive", "origin", "referer",
    "set-cookie", "te", "trailer", "transfer-encoding", "upgrade", "user-agent", "via"];
  var MIME_EXTENSIONS = { "text/plain": "txt", "text/html": "html", "text/css": "css", "text/csv": "csv",
    "text/javascript": "js", "application/javascript": "js", "application/json": "json",
    "application/pdf": "pdf", "application/zip": "zip", "application/xml": "xml", "text/xml": "xml",
    "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp",
    "image/svg+xml": "svg", "image/bmp": "bmp", "audio/mpeg": "mp3", "video/mp4": "mp4",
    "audio/wav": "wav", "video/webm": "webm" };

  // Whether Chrome takes the name as a portable path relative to the
  // downloads folder.
  function portableRelativePath(name) {
    if (!name || /^[\/\\]|^[A-Za-z]:/.test(name)) {
      return false;
    }
    return name.split(/[\/\\]/).every(function (part) {
      return part !== "" && part.charAt(0) !== "." && !/[.\s]$/.test(part) &&
        !/[<>:"|?*\x00-\x1f\x7f~]/.test(part) &&
        !/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(part);
    });
  }

  // Firefox's refusals of a filename, or null for one it takes.
  function firefoxFilenameError(name) {
    if (/^[\/\\]|^[A-Za-z]:[\/\\]/.test(name)) {
      return "filename must not be an absolute path";
    }
    var parts = name.split(/[\/\\]/);
    if (parts.indexOf("..") >= 0) {
      return "filename must not contain back-references (..)";
    }
    if (parts.some(function (part) { return /[<>:"|?*\x00-\x1f\x7f]/.test(part); })) {
      return "filename must not contain illegal characters";
    }
    return null;
  }

  function dispositionFilename(header) {
    var value = String(header || "");
    var extended = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(value);
    if (extended) {
      try {
        return decodeURIComponent(extended[2].trim());
      } catch (e) { /* fall back on the plain parameter */ }
    }
    var plain = /filename\s*=\s*("((?:[^"\\]|\\.)*)"|[^;]+)/i.exec(value);
    if (plain) {
      return (plain[2] !== undefined ? plain[2].replace(/\\(.)/g, "$1") : plain[1]).trim();
    }
    return "";
  }

  function urlFilename(url) {
    var m = /^[a-z][a-z0-9+.\-]*:\/\/[^\/?#]*([^?#]*)/i.exec(String(url || ""));
    if (!m) {
      return "";
    }
    var last = m[1].split("/").pop();
    try {
      return decodeURIComponent(last);
    } catch (e) {
      return last;
    }
  }

  // The name a download gets from its response when it is given none, as
  // Chrome chooses it.
  function suggestedFilename(url, response, mime) {
    var name = dispositionFilename(response && response.headers.get("Content-Disposition")) ||
      urlFilename(url) || "download";
    name = name.replace(/[\/\\:*?"<>|\x00-\x1f\x7f]+/g, "_").replace(/^[.\s]+|[.\s]+$/g, "") || "download";
    var extension = MIME_EXTENSIONS[String(mime).toLowerCase()];
    if (extension && name.indexOf(".") < 0) {
      name += "." + extension;
    }
    return name;
  }

  function interruptReason(status) {
    if (status === 401 || status === 407) {
      return "SERVER_UNAUTHORIZED";
    }
    if (status === 403) {
      return "SERVER_FORBIDDEN";
    }
    if (status === 404 || status === 410) {
      return "SERVER_BAD_CONTENT";
    }
    return "SERVER_FAILED";
  }

  // Saves a file into Safari's downloads folder. The content bridge in an
  // ordinary web page the user has open saves it, showing nothing and adding
  // nothing to Safari's history, in the bridge's own world and through a link
  // outside the document, where the page's scripts cannot see it. With no such
  // page, the runtime's own page does, in a hidden tab that closes once it
  // has; Safari's history lists that page.
  var SAVING_PAGES_TRIED = 3;
  var SAVING_PAGE_ANSWER = 5000;

  function bridgePages() {
    var active = activeTab();
    var pages = [];
    eachSafariTab(function (t) {
      var id = idBySafariTab.get(t);
      if (id !== undefined && /^https?:/i.test(String(t.url || ""))) {
        if (t === active) {
          pages.unshift(id);
        } else {
          pages.push(id);
        }
      }
    });
    return pages.slice(0, SAVING_PAGES_TRIED);
  }

  function saveFile(bytes, name, type) {
    var view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
    var pages = CONFIG.bridgeWhitelist ? bridgePages() : [];
    function tryPage(i) {
      if (i >= pages.length) {
        return saveInRuntimeTab(view, name, type);
      }
      var port = native.tabs.connect(pages[i], { name: WEX.INTERNAL_PORT + "save", frameId: 0 });
      return WEX.sendFile(port, view, name, type, SAVING_PAGE_ANSWER).catch(function () {
        return tryPage(i + 1);
      });
    }
    return tryPage(0);
  }
  WEX.saveFile = saveFile;

  // A file from one of the extension's pages that cannot save it itself,
  // which WEX.sendFile sends in pieces. A port from anywhere else is refused.
  function receiveSave(port) {
    if (!isExtensionPage(port.sender)) {
      port.disconnect();
      return;
    }
    var save = null;

    function assemble(file) {
      var pieces = [];
      var size = 0;
      for (var i = 0; i < file.total; i++) {
        if (typeof file.pieces[i] !== "string") {
          throw new Error("a piece of the file did not arrive");
        }
        var binary = g.atob(file.pieces[i]);
        var piece = new Uint8Array(binary.length);
        for (var b = 0; b < binary.length; b++) {
          piece[b] = binary.charCodeAt(b);
        }
        pieces.push(piece);
        size += piece.length;
      }
      var bytes = new Uint8Array(size);
      var at = 0;
      pieces.forEach(function (part) {
        bytes.set(part, at);
        at += part.length;
      });
      return bytes;
    }

    function answer(reply) {
      try {
        port.postMessage(reply);
      } catch (e) { /* the page has gone */ }
    }

    port.onMessage.addListener(function (m) {
      if (m.begin) {
        save = { filename: m.begin.filename, type: m.begin.type, total: m.begin.total, pieces: [] };
      } else if (m.chunk && save) {
        save.pieces[m.chunk.index] = m.chunk.data;
      } else if (m.end && save) {
        var file = save;
        save = null;
        Promise.resolve().then(function () {
          return saveFile(assemble(file), file.filename, file.type);
        }).then(function () {
          answer({ ok: true });
        }, function (error) {
          answer({ ok: false, error: String(error && error.message || error) });
        });
      }
    });
  }

  function saveInRuntimeTab(view, name, type) {
    var bytes = view.byteOffset === 0 && view.byteLength === view.buffer.byteLength ? view.buffer :
      view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
    return new Promise(function (resolve, reject) {
      var token = WEX.uid("dl");
      var channel = new g.BroadcastChannel("wex-downloads");
      var tabId = null;
      var finished = false;
      var timer = setTimeout(function () {
        finish(new Error("the download page did not answer"));
      }, DOWNLOAD_SAVE_TIMEOUT);
      function finish(error) {
        if (finished) {
          return;
        }
        finished = true;
        clearTimeout(timer);
        channel.close();
        if (tabId !== null) {
          closeRuntimeTab(tabId);
        }
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      }
      channel.onmessage = function (e) {
        var m = e.data || {};
        if (m.token !== token) {
          return;
        }
        if (m.ready) {
          channel.postMessage({ token: token, bytes: bytes, filename: name, type: type });
        } else if (m.saved) {
          finish();
        } else if (m.failed) {
          finish(new Error(m.failed));
        }
      };
      openRuntimeTab(DOWNLOAD_PAGE, token).then(function (id) {
        tabId = id;
        if (finished) {
          closeRuntimeTab(id);
        }
      }, finish);
    });
  }

  function makeDownloads() {
    var firefox = !!CONFIG.firefoxBuild;
    var onCreated = new Event("downloads.onCreated");
    var onChanged = new Event("downloads.onChanged");
    var onErased = new Event("downloads.onErased");
    var onDeterminingFilename = firefox ? null : new Event("downloads.onDeterminingFilename");
    var UNKNOWN_SIZE = firefox ? -1 : 0;
    var records = [];
    var nextId = 1;

    (function load() {
      try {
        var kept = JSON.parse(settingsItem(DOWNLOADS_KEY) || "null");
        if (kept && Array.isArray(kept.items)) {
          nextId = kept.nextId || 1;
          records = kept.items.map(function (item) {
            if (item.state === "in_progress") {
              item.state = "interrupted";
              item.error = "CRASH";
              item.paused = false;
              item.canResume = false;
            }
            return { item: item };
          });
        }
      } catch (e) { /* no history kept */ }
    })();

    function keep() {
      settingsItem(DOWNLOADS_KEY, JSON.stringify({ nextId: nextId, items: records.map(function (r) {
        return r.item;
      }) }));
    }

    function copy(item) {
      var out = {};
      Object.keys(item).forEach(function (k) {
        if (item[k] !== undefined) {
          out[k] = item[k];
        }
      });
      return out;
    }

    function find(id) {
      for (var i = 0; i < records.length; i++) {
        if (records[i].item.id === id) {
          return records[i];
        }
      }
      return null;
    }

    function invalidId(id) {
      return firefox ? "Invalid download id " + id : "Invalid downloadId";
    }

    // Applies `patch` to the item, and reports the fields that changed.
    function change(rec, patch) {
      var delta = { id: rec.item.id };
      var changed = false;
      Object.keys(patch).forEach(function (k) {
        var previous = rec.item[k];
        if (previous === patch[k]) {
          return;
        }
        rec.item[k] = patch[k];
        if (DOWNLOAD_CHANGE_KEYS.indexOf(k) >= 0) {
          var d = {};
          if (previous !== undefined) {
            d.previous = previous;
          }
          if (patch[k] !== undefined) {
            d.current = patch[k];
          }
          delta[k] = d;
          changed = true;
        }
      });
      if (rec.listed) {
        keep();
        if (changed) {
          onChanged.emit(delta);
        }
      }
    }

    function list(rec) {
      if (!rec.listed) {
        rec.listed = true;
        records.push(rec);
        keep();
        onCreated.emit(copy(rec.item));
      }
    }

    function interrupt(rec, reason) {
      if (rec.item.state !== "in_progress") {
        return;
      }
      stop(rec);
      change(rec, { state: "interrupted", error: reason, paused: false, canResume: false,
        endTime: new Date().toISOString() });
    }

    function stop(rec) {
      rec.chunks = null;
      try {
        if (rec.controller) {
          rec.controller.abort();
        }
      } catch (e) { /* already over */ }
      try {
        if (rec.reader) {
          rec.reader.cancel();
        }
      } catch (e) { /* already over */ }
    }

    // Asks each onDeterminingFilename listener for the file's name, as
    // Chrome does once download has given the caller the item's id, with the
    // name proposed so far as the item's filename. Resolves with the last
    // suggestion made.
    function determineFilename(rec, name) {
      return new Promise(function (resolve) {
        setTimeout(resolve, 0);
      }).then(function () {
        if (!onDeterminingFilename || !onDeterminingFilename.hasListeners()) {
          return name;
        }
        return askForFilename(rec, name);
      });
    }

    function askForFilename(rec, name) {
      var listeners = onDeterminingFilename.listeners.slice();
      var proposed = copy(rec.item);
      proposed.filename = name;
      var waits = listeners.map(function (fn) {
        return new Promise(function (resolve) {
          var answered = false;
          function suggest(suggestion) {
            if (answered) {
              throw new Error(firefox ? "suggest was already called" : "Unexpected determineFilename call");
            }
            answered = true;
            resolve(suggestion && suggestion.filename && portableRelativePath(String(suggestion.filename)) ?
              String(suggestion.filename) : null);
          }
          var returned;
          try {
            returned = fn(copy(proposed), suggest);
          } catch (e) {
            log.error("listener for downloads.onDeterminingFilename threw", e);
          }
          if (!answered && returned !== true) {
            answered = true;
            resolve(null);
          }
        });
      });
      return Promise.all(waits).then(function (suggestions) {
        var chosen = name;
        suggestions.forEach(function (s) {
          if (s) {
            chosen = s;
          }
        });
        return chosen;
      });
    }

    // Reads the response's body, holding while the download is paused.
    function receive(rec, response) {
      if (!response.body || typeof response.body.getReader !== "function") {
        return response.arrayBuffer().then(function (buffer) {
          rec.item.bytesReceived = buffer.byteLength;
          return new Promise(function (resolve) {
            (function settled() {
              if (rec.item.paused) {
                rec.wake = settled;
              } else {
                resolve([buffer]);
              }
            })();
          });
        });
      }
      rec.reader = response.body.getReader();
      return new Promise(function (resolve, reject) {
        function pump() {
          if (rec.item.state !== "in_progress") {
            return;
          }
          if (rec.item.paused) {
            rec.wake = pump;
            return;
          }
          rec.reader.read().then(function (result) {
            if (rec.item.state !== "in_progress") {
              return;
            }
            if (result.done) {
              resolve(rec.chunks);
              return;
            }
            rec.chunks.push(result.value);
            rec.item.bytesReceived += result.value.byteLength;
            pump();
          }, reject);
        }
        pump();
      });
    }

    function start(rec, options, request) {
      var url = options.url;
      var source = options.__wexData || url;
      var response;
      return g.fetch(source, request).then(function (r) {
        response = r;
        var mime = String(r.headers.get("Content-Type") || "").split(";")[0].trim();
        var length = Number(r.headers.get("Content-Length"));
        var total = r.ok && isFinite(length) && length >= 0 && !r.headers.get("Content-Encoding") ?
          length : UNKNOWN_SIZE;
        var patch = { mime: mime, totalBytes: total, fileSize: total };
        if (!firefox) {
          patch.finalUrl = options.__wexData ? url : r.url || url;
        }
        change(rec, patch);
        if (!r.ok && !(firefox && options.allowHttpErrors)) {
          throw { reason: interruptReason(r.status) };
        }
        var given = options.filename ? String(options.filename).split(/[\/\\]/).pop() : "";
        var name = given || suggestedFilename(url, r, mime);
        if (firefox) {
          change(rec, { filename: name });
          return name;
        }
        list(rec);
        rec.started(rec.item.id);
        return determineFilename(rec, options.filename ? String(options.filename) : name).then(function (chosen) {
          var leaf = chosen.split(/[\/\\]/).pop();
          change(rec, { filename: leaf });
          return leaf;
        });
      }, function () {
        throw { reason: "NETWORK_FAILED" };
      }).then(function (name) {
        return receive(rec, response).then(function (chunks) {
          return { name: name, chunks: chunks };
        }, function () {
          throw { reason: "NETWORK_FAILED" };
        });
      }).then(function (got) {
        var blob = new g.Blob(got.chunks, { type: rec.item.mime || "application/octet-stream" });
        rec.chunks = null;
        return new Promise(function (resolve, reject) {
          var reader = new g.FileReader();
          reader.onload = function () {
            resolve(reader.result);
          };
          reader.onerror = function () {
            reject({ reason: "FILE_FAILED" });
          };
          reader.readAsArrayBuffer(blob);
        }).then(function (bytes) {
          if (rec.item.state !== "in_progress") {
            return;
          }
          return saveFile(bytes, got.name, rec.item.mime).then(function () {
            if (rec.item.state !== "in_progress") {
              return;
            }
            var size = bytes.byteLength;
            rec.item.bytesReceived = size;
            change(rec, { state: "complete", endTime: new Date().toISOString(), totalBytes: size,
              fileSize: size, exists: true, canResume: false });
          }, function (error) {
            log.warn("could not save download " + rec.item.id + ": " + (error && error.message));
            throw { reason: "FILE_FAILED" };
          });
        });
      });
    }

    function badHeader(headers) {
      for (var i = 0; i < (headers || []).length; i++) {
        var name = String(headers[i] && headers[i].name);
        var value = String(headers[i] && headers[i].value);
        if (!/^[!#$%&'*+\-.\^_`|~0-9A-Za-z]+$/.test(name)) {
          return "Invalid request header name";
        }
        var lower = name.toLowerCase();
        if (FORBIDDEN_DOWNLOAD_HEADERS.indexOf(lower) >= 0 || /^(proxy|sec)-/.test(lower)) {
          return "Unsafe request header name";
        }
        if (/[\0\r\n]/.test(value)) {
          return "Invalid request header value";
        }
      }
      return null;
    }

    function download(options, cb) {
      var o = options || {};
      var url = String(o.url == null ? "" : o.url);
      var target;
      try {
        target = new g.URL(url);
      } catch (e) {
        target = null;
      }
      if (!target) {
        return WEX.fail(cb, firefox ? "Type error for parameter options (Error processing url: Error: Invalid URL \"" +
          url + "\") for downloads.download." : "Invalid URL");
      }
      if (o.filename != null && o.filename !== "") {
        var refused = firefox ? firefoxFilenameError(String(o.filename)) :
          (portableRelativePath(String(o.filename).replace(/%/g, "_")) ? null : "Invalid filename");
        if (refused) {
          return WEX.fail(cb, refused);
        }
      }
      var headerError = badHeader(o.headers);
      if (headerError) {
        return WEX.fail(cb, headerError);
      }
      var headers = {};
      (o.headers || []).forEach(function (h) {
        headers[h.name] = h.value;
      });
      var controller = typeof g.AbortController === "function" ? new g.AbortController() : null;
      var request = { method: o.method || "GET", headers: headers, credentials: "include",
        signal: controller ? controller.signal : undefined };
      if (o.body != null && request.method !== "GET") {
        request.body = String(o.body);
      }
      var rec = { controller: controller, chunks: [], item: {
        id: nextId++, url: url, finalUrl: firefox ? undefined : url, referrer: "", filename: "",
        incognito: false, danger: "safe", mime: "",
        startTime: new Date().toISOString(), state: "in_progress", paused: false, canResume: false,
        bytesReceived: 0, totalBytes: UNKNOWN_SIZE, fileSize: UNKNOWN_SIZE, exists: !firefox,
        byExtensionId: WEX.runtimeId, byExtensionName: manifest.name || ""
      } };
      if (firefox) {
        rec.item.cookieStoreId = "firefox-default";
      }
      keep();
      var started = new Promise(function (resolve, reject) {
        rec.started = resolve;
        rec.failedToStart = reject;
      });
      if (firefox) {
        list(rec);
        rec.started(rec.item.id);
      }
      start(rec, o, request).catch(function (error) {
        var reason = error && error.reason || "FILE_FAILED";
        if (rec.listed) {
          interrupt(rec, reason);
        } else {
          rec.failedToStart(new Error(reason));
        }
      });
      return settle(started, cb);
    }

    function asTime(value) {
      if (value == null) {
        return null;
      }
      var t = typeof value === "number" ? value : Date.parse(value);
      return isNaN(t) ? null : t;
    }

    function matches(item, q) {
      if (q.query) {
        var text = [item.url, item.finalUrl, item.filename].join(" ").toLowerCase();
        var terms = [].concat(q.query);
        for (var i = 0; i < terms.length; i++) {
          var term = String(terms[i]).toLowerCase();
          var negated = term.charAt(0) === "-";
          var found = text.indexOf(negated ? term.slice(1) : term) >= 0;
          if (found === negated) {
            return false;
          }
        }
      }
      var start = asTime(item.startTime);
      var end = asTime(item.endTime);
      if (q.startedBefore != null && !(start < asTime(q.startedBefore))) {
        return false;
      }
      if (q.startedAfter != null && !(start > asTime(q.startedAfter))) {
        return false;
      }
      if (q.endedBefore != null && !(end !== null && end < asTime(q.endedBefore))) {
        return false;
      }
      if (q.endedAfter != null && !(end !== null && end > asTime(q.endedAfter))) {
        return false;
      }
      if (q.totalBytesGreater != null && !(item.totalBytes > q.totalBytesGreater)) {
        return false;
      }
      if (q.totalBytesLess != null && !(item.totalBytes < q.totalBytesLess)) {
        return false;
      }
      var regexes = { filenameRegex: "filename", urlRegex: "url", finalUrlRegex: "finalUrl" };
      for (var key in regexes) {
        if (q[key] != null && !new RegExp(q[key]).test(String(item[regexes[key]] || ""))) {
          return false;
        }
      }
      for (var j = 0; j < DOWNLOAD_FILTER_KEYS.length; j++) {
        var k = DOWNLOAD_FILTER_KEYS[j];
        if (q[k] === undefined || q[k] === null) {
          continue;
        }
        if ((k === "startTime" || k === "endTime") ? asTime(item[k]) !== asTime(q[k]) : item[k] !== q[k]) {
          return false;
        }
      }
      return true;
    }

    function query(q) {
      q = q || {};
      if (q.limit != null && q.limit < 0) {
        throw new Error("Invalid query limit");
      }
      if (q.state != null && DOWNLOAD_STATES.indexOf(q.state) < 0) {
        throw new Error("Invalid state");
      }
      if (q.danger != null && DOWNLOAD_DANGERS.indexOf(q.danger) < 0) {
        throw new Error("Invalid danger type");
      }
      var order = (q.orderBy || []).filter(function (term) {
        return term !== "";
      }).map(function (term) {
        var descending = term.charAt(0) === "-";
        var key = descending ? term.slice(1) : term;
        if (DOWNLOAD_SORT_KEYS.indexOf(key) < 0) {
          throw new Error("Invalid orderBy field");
        }
        return { key: key, sign: descending ? -1 : 1 };
      });
      ["filenameRegex", "urlRegex", "finalUrlRegex"].forEach(function (key) {
        if (q[key] != null) {
          try {
            new RegExp(q[key]);
          } catch (e) {
            throw new Error("Invalid query filter");
          }
        }
      });
      var found = records.filter(function (r) {
        return matches(r.item, q);
      });
      if (order.length) {
        found.sort(function (a, b) {
          for (var i = 0; i < order.length; i++) {
            var x = a.item[order[i].key];
            var y = b.item[order[i].key];
            if (x !== y) {
              return (x === undefined ? -1 : y === undefined ? 1 : x < y ? -1 : 1) * order[i].sign;
            }
          }
          return 0;
        });
      }
      var limit = q.limit == null ? 1000 : q.limit;
      return limit > 0 ? found.slice(0, limit) : found;
    }

    function withItem(id, cb, fn) {
      var rec = find(id);
      if (!rec) {
        return WEX.fail(cb, invalidId(id));
      }
      try {
        return settle(Promise.resolve(fn(rec)), cb);
      } catch (e) {
        return WEX.fail(cb, e.message);
      }
    }

    function wake(rec) {
      var resume = rec.wake;
      rec.wake = null;
      if (resume) {
        resume();
      }
    }

    records.forEach(function (r) {
      r.listed = true;
    });
    keep();

    var api = {
      onCreated: onCreated,
      onChanged: onChanged,
      onErased: onErased,
      download: download,
      search: function (q, cb) {
        try {
          return done(cb, query(q).map(function (r) {
            var item = copy(r.item);
            if (r.item.state === "in_progress" && r.item.bytesReceived && r.item.totalBytes > 0 && !r.item.paused) {
              var elapsed = Date.now() - asTime(r.item.startTime);
              var rate = r.item.bytesReceived / Math.max(elapsed, 1);
              item.estimatedEndTime = new Date(Date.now() +
                (r.item.totalBytes - r.item.bytesReceived) / rate).toISOString();
            }
            return item;
          }));
        } catch (e) {
          return WEX.fail(cb, e.message);
        }
      },
      pause: function (id, cb) {
        return withItem(id, cb, function (rec) {
          if (rec.item.state !== "in_progress") {
            throw new Error(firefox ? "Download " + id + " cannot be paused since it is in state " +
              rec.item.state : "Download must be in progress");
          }
          change(rec, { paused: true, canResume: true });
        });
      },
      resume: function (id, cb) {
        return withItem(id, cb, function (rec) {
          if (rec.item.state === "interrupted" && !rec.item.canResume) {
            throw new Error(firefox ? "Download " + id + " cannot be resumed" : "DownloadItem.canResume must be true");
          }
          if (rec.item.paused) {
            change(rec, { paused: false, canResume: false });
            wake(rec);
          }
        });
      },
      cancel: function (id, cb) {
        var rec = find(id);
        if (!rec && firefox) {
          return WEX.fail(cb, invalidId(id));
        }
        if (rec && rec.item.state === "in_progress") {
          interrupt(rec, "USER_CANCELED");
        }
        return done(cb);
      },
      erase: function (q, cb) {
        var gone;
        try {
          gone = query(q);
        } catch (e) {
          return WEX.fail(cb, e.message);
        }
        // An erased download reports no more changes.
        gone.forEach(function (r) {
          r.listed = false;
          if (r.item.state === "in_progress") {
            r.item.state = "interrupted";
            stop(r);
          }
        });
        records = records.filter(function (r) {
          return gone.indexOf(r) < 0;
        });
        keep();
        var ids = gone.map(function (r) {
          return r.item.id;
        });
        ids.forEach(function (id) {
          onErased.emit(id);
        });
        return done(cb, ids);
      },
      removeFile: function (id, cb) {
        return withItem(id, cb, function (rec) {
          if (rec.item.state !== "complete") {
            throw new Error(firefox ? "Cannot remove incomplete download id " + id : "Download must be complete");
          }
          if (!rec.item.exists) {
            throw new Error(firefox ? "Could not remove download id " + id + " because the file doesn't exist" :
              "Download file already deleted");
          }
          throw new Error(firefox ? "Could not remove download id " + id : "Unable to remove file");
        });
      },
      getFileIcon: function (id, options, cb) {
        if (typeof options === "function") {
          cb = options;
        }
        return withItem(id, cb, function (rec) {
          if (!rec.item.filename) {
            throw new Error(firefox ? "Invalid download id " + id : "Filename not yet determined");
          }
          throw new Error(firefox ? "Could not get icon for download id " + id : "Icon not found");
        });
      },
      open: function (id, cb) {
        return withItem(id, cb, function (rec) {
          if (rec.item.state !== "complete") {
            throw new Error(firefox ? "Download has not completed." : "Download must be complete");
          }
          throw new Error("Safari does not let extensions open downloaded files.");
        });
      },
      show: function (id, cb) {
        return withItem(id, cb, function () {
          log.warn("downloads.show: Safari does not let extensions show a downloaded file");
          return firefox ? true : undefined;
        });
      },
      showDefaultFolder: function () {
        log.warn("downloads.showDefaultFolder: Safari does not let extensions show its downloads folder");
      }
    };
    if (!firefox) {
      api.onDeterminingFilename = onDeterminingFilename;
      api.acceptDanger = function (id, cb) {
        return withItem(id, cb, function (rec) {
          if (rec.item.state !== "in_progress") {
            throw new Error("Download must be in progress");
          }
          throw new Error("Download must be dangerous");
        });
      };
      api.setShelfEnabled = function () {
        if (!WEX.declares("downloads.shelf")) {
          console.error("Unchecked runtime.lastError: downloads.setShelfEnabled requires the " +
            "\"downloads.shelf\" permission");
        }
      };
      api.setUiOptions = function (options, cb) {
        if (!WEX.declares("downloads.ui")) {
          return WEX.fail(cb, "downloads.setUiOptions requires the \"downloads.ui\" permission");
        }
        return WEX.fail(cb, "Safari does not let extensions hide its downloads.");
      };
    }
    return api;
  }

  // ------------------------------------------------------------------ //
  // Notifications
  // ------------------------------------------------------------------ //
  // The extension's notifications, posted through the web Notification API,
  // which Safari shows in the Notification Center. Each is known by its id
  // until it closes: a click on it is reported, and so is its closing, by the
  // user or by the extension. Safari's notifications have no buttons, no
  // images, no progress bars and no settings button, so a list's items and
  // the context message are added to the text, and the rest is not shown.
  // Safari is asked for permission first; while it gives none, the calls
  // fail as Chrome's do for an extension whose notifications are turned off,
  // and the permission level is "denied".
  var NOTIFICATION_TAG = WEX.uid("wex-notification-");

  function makeNotifications() {
    var firefox = !!CONFIG.firefoxBuild;
    var events = {
      onClicked: new Event("notifications.onClicked"),
      onClosed: new Event("notifications.onClosed"),
      onButtonClicked: new Event("notifications.onButtonClicked"),
      onPermissionLevelChanged: new Event("notifications.onPermissionLevelChanged"),
      onShowSettings: new Event("notifications.onShowSettings")
    };
    if (firefox) {
      events.onShown = new Event("notifications.onShown");
    }
    var shown = {};
    var nextId = 1;
    var permission = null;

    // Resolves with whether Safari lets the extension notify.
    function allowed() {
      if (typeof g.Notification !== "function") {
        return Promise.resolve(false);
      }
      if (g.Notification.permission !== "default") {
        return Promise.resolve(g.Notification.permission === "granted");
      }
      if (!permission) {
        permission = new Promise(function (resolve) {
          try {
            var asked = g.Notification.requestPermission(function (answer) {
              resolve(answer === "granted");
            });
            if (asked && typeof asked.then === "function") {
              asked.then(function (answer) {
                resolve(answer === "granted");
              }, function () {
                resolve(false);
              });
            }
          } catch (e) {
            resolve(false);
          }
        }).then(function (granted) {
          permission = null;
          return granted;
        });
      }
      return permission;
    }

    // A call that runs only while the extension may notify.
    function whileAllowed(cb, fn) {
      return settle(allowed().then(function (granted) {
        if (!granted) {
          throw new Error(firefox ? "Safari does not let this extension show notifications." : "");
        }
        return fn();
      }), cb);
    }

    function text(o) {
      var lines = [String(o.message || "")];
      (Array.isArray(o.items) ? o.items : []).forEach(function (item) {
        lines.push(String(item && item.title || "") + ": " + String(item && item.message || ""));
      });
      if (o.contextMessage) {
        lines.push(String(o.contextMessage));
      }
      return lines.join("\n");
    }

    function post(id, o) {
      var entry = shown[id] = { options: o, closing: false };
      (function show() {
        try {
          var n = new g.Notification(String(o.title || ""), {
            body: text(o),
            icon: o.iconUrl ? callerUrl(o.iconUrl) : undefined,
            tag: NOTIFICATION_TAG + id
          });
          entry.notification = n;
          n.onclick = function () {
            events.onClicked.emit(id);
          };
          n.onshow = function () {
            if (events.onShown) {
              events.onShown.emit(id);
            }
          };
          n.onclose = function () {
            if (shown[id] === entry && !entry.closing) {
              delete shown[id];
              events.onClosed.emit(id, true);
            }
          };
        } catch (e) {
          log.warn("could not post a notification", e);
        }
      })();
    }

    // Closes a notification the extension let go of, or one it replaces.
    function retire(id) {
      var entry = shown[id];
      if (!entry) {
        return false;
      }
      entry.closing = true;
      delete shown[id];
      try {
        if (entry.notification) {
          entry.notification.close();
        }
      } catch (e) { /* already closed */ }
      return true;
    }

    function missing(o) {
      var needed = firefox ? ["type", "title", "message"] : ["type", "iconUrl", "title", "message"];
      return needed.some(function (key) {
        return o[key] === undefined || o[key] === null;
      });
    }

    var api = {
      create: function (id, options, cb) {
        if (typeof id === "object" && id !== null) {
          cb = options;
          options = id;
          id = "";
        }
        var o = options || {};
        if (missing(o)) {
          return WEX.fail(cb, firefox ? "Type error for parameter options (Property \"" +
            ["type", "title", "message"].filter(function (key) { return o[key] == null; })[0] +
            "\" is required) for notifications.create." :
            "Some of the required properties are missing: type, iconUrl, title and message.");
        }
        return whileAllowed(cb, function () {
          var name = id ? String(id) : (firefox ? WEX.uid("n") : String(nextId++) + "-" + WEX.uid(""));
          retire(name);
          post(name, o);
          return name;
        });
      },
      update: function (id, options, cb) {
        return whileAllowed(cb, function () {
          var entry = shown[id];
          if (!entry) {
            return false;
          }
          var merged = {};
          [entry.options, options || {}].forEach(function (source) {
            Object.keys(source).forEach(function (key) {
              merged[key] = source[key];
            });
          });
          retire(id);
          post(id, merged);
          return true;
        });
      },
      clear: function (id, cb) {
        return whileAllowed(cb, function () {
          var cleared = retire(String(id));
          if (cleared) {
            setTimeout(function () {
              events.onClosed.emit(String(id), false);
            }, 0);
          }
          return cleared;
        });
      },
      getAll: function (cb) {
        return whileAllowed(cb, function () {
          var out = {};
          Object.keys(shown).forEach(function (id) {
            out[id] = firefox ? shown[id].options : true;
          });
          return out;
        });
      },
      getPermissionLevel: function (cb) {
        return settle(allowed().then(function (granted) {
          return granted ? "granted" : "denied";
        }), cb);
      }
    };
    Object.keys(events).forEach(function (name) {
      api[name] = events[name];
    });
    return api;
  }

  // ------------------------------------------------------------------ //
  // Permission warnings
  // ------------------------------------------------------------------ //
  // What Chrome tells the user a manifest lets an extension do, worked out as
  // Chrome works it out (ChromePermissionMessageProvider): the permissions
  // the manifest asks for, its hosts and its content scripts' become
  // Chrome's permission ids, and Chrome's rules, applied in order, each take
  // the ids they speak for. The rules and their English messages are in the
  // bundle (tools/update-permission-messages.js), read when first needed.
  var PERMISSION_MESSAGES = "wex/permission-messages.json";
  var permissionMessages = null;

  function messageData() {
    if (!permissionMessages) {
      var text = WEX.readTextSync(PERMISSION_MESSAGES);
      if (text == null) {
        throw new Error("Chrome's permission warnings are missing from the extension.");
      }
      permissionMessages = JSON.parse(text);
    }
    return permissionMessages;
  }

  // A host pattern as Chrome reads it, or null for one that names no host.
  function hostPattern(pattern) {
    var p = String(pattern);
    if (p === "<all_urls>") {
      return { all: true };
    }
    var m = /^(\*|https?|wss?|ftp|file|chrome):\/\/([^\/]*)(\/.*)?$/.exec(p);
    if (!m) {
      return null;
    }
    var host = m[2].replace(/:\d+$|:\*$/, "").toLowerCase();
    var subdomains = host === "*" || host.indexOf("*.") === 0;
    return { scheme: m[1], host: host === "*" ? "" : subdomains ? host.slice(2) : host, subdomains: subdomains };
  }

  // Whether the pattern reaches every site of a registry, as *.com does.
  function patternCoversRegistry(pattern) {
    if (pattern.all || (pattern.subdomains && !pattern.host)) {
      return true;
    }
    if (!pattern.subdomains) {
      return false;
    }
    var labels = pattern.host.split(".");
    var known = WEX.bundledSuffixRules(true)(labels);
    return known > 0 && known >= labels.length;
  }

  // Chrome's list of distinct hosts: one entry for a host under several
  // registries, with the best of them (.com, then .net, then .org).
  function distinctHosts(patterns) {
    var best = [];
    var rank = function (rcd) {
      return rcd === "com" ? 3 : rcd === "net" ? 2 : rcd === "org" ? 1 : 0;
    };
    patterns.forEach(function (pattern) {
      if (pattern.scheme === "file") {
        return;
      }
      var host = (pattern.subdomains ? "*." : "") + pattern.host;
      var labels = host.split(".");
      var known = WEX.bundledSuffixRules(true)(labels);
      var rcd = known && known < labels.length ? labels.slice(-known).join(".") : "";
      var stem = rcd ? host.slice(0, host.length - rcd.length) : host;
      var seen = best.filter(function (entry) {
        return entry.stem === stem;
      })[0];
      if (!seen) {
        best.push({ stem: stem, rcd: rcd });
      } else if (rank(rcd) > rank(seen.rcd)) {
        seen.rcd = rcd;
      }
    });
    var out = [];
    best.forEach(function (entry) {
      if (out.indexOf(entry.stem + entry.rcd) < 0) {
        out.push(entry.stem + entry.rcd);
      }
    });
    return out.sort();
  }

  function settingsHost(url) {
    try {
      return new g.URL(String(url)).hostname.replace(/^www\./, "");
    } catch (e) {
      return String(url);
    }
  }

  // Chrome's permission ids for the manifest, each with its parameter.
  function permissionIds(mf, data) {
    var ids = [];
    function add(id, parameter) {
      if (id && !ids.some(function (e) { return e.id === id && e.parameter === (parameter || ""); })) {
        ids.push({ id: id, parameter: parameter || "" });
      }
    }
    var version3 = mf.manifest_version === 3;
    var explicit = [];
    var everySite = false;
    (Array.isArray(mf.permissions) ? mf.permissions : []).forEach(function (p) {
      if (typeof p !== "string") {
        return;
      }
      var host = hostPattern(p);
      if (host) {
        if (!version3) {
          explicit.push(host);
        }
        return;
      }
      add(data.permissions[p]);
      everySite = everySite || data.everySite.indexOf(p) >= 0;
    });
    if (version3 && Array.isArray(mf.host_permissions)) {
      mf.host_permissions.forEach(function (p) {
        var host = hostPattern(p);
        if (host) {
          explicit.push(host);
        }
      });
    }
    var scriptable = [];
    (Array.isArray(mf.content_scripts) ? mf.content_scripts : []).forEach(function (script) {
      (script && Array.isArray(script.matches) ? script.matches : []).forEach(function (p) {
        var host = hostPattern(p);
        if (host) {
          scriptable.push(host);
        }
      });
    });
    var overrides = mf.chrome_url_overrides || {};
    if (overrides.newtab) {
      add("kNewTabPageOverride");
    }
    var settings = mf.chrome_settings_overrides || {};
    if (settings.homepage) {
      add("kHomepage", settingsHost(settings.homepage));
    }
    if (settings.search_provider && settings.search_provider.search_url) {
      add("kSearchProvider", settingsHost(settings.search_provider.search_url));
    }
    if (Array.isArray(settings.startup_pages) && settings.startup_pages.length) {
      add("kStartupPages", settingsHost(settings.startup_pages[0]));
    }
    var hosts = explicit.concat(scriptable).filter(function (pattern) {
      if (pattern.scheme === "chrome") {
        if (pattern.host === "favicon") {
          add("kFavicon");
        }
        return false;
      }
      return true;
    });
    if (everySite || hosts.some(patternCoversRegistry)) {
      add("kHostsAll");
    } else {
      distinctHosts(hosts).forEach(function (host) {
        add("kHostReadWrite", host);
      });
    }
    return ids;
  }

  function fill(message, values) {
    return message.replace(/\$(\d)/g, function (_, n) {
      return values[Number(n) - 1];
    });
  }

  function permissionWarnings(mf) {
    var data = messageData();
    var remaining = permissionIds(mf, data);
    var out = [];
    data.rules.forEach(function (rule) {
      var has = function (id) {
        return remaining.some(function (e) {
          return e.id === id;
        });
      };
      if (!rule.messages || !rule.required.every(has)) {
        return;
      }
      var taken = rule.required.concat(rule.optional);
      var used = remaining.filter(function (e) {
        return taken.indexOf(e.id) >= 0;
      });
      remaining = remaining.filter(function (e) {
        return taken.indexOf(e.id) < 0;
      });
      var parameters = used.map(function (e) {
        return e.parameter;
      }).filter(Boolean).sort();
      if (rule.format === "HostList") {
        var listed = parameters.length > 3;
        var hosts = parameters.map(function (host) {
          return host.indexOf("*.") === 0 ? fill(listed ? data.hostAndSubdomainsInList : data.hostAndSubdomains,
            [host.slice(2)]) : host;
        });
        out.push(listed ? rule.messages[3] : fill(rule.messages[hosts.length - 1], hosts));
      } else if (rule.format === "SingleParameter") {
        out.push(fill(rule.messages[0], [parameters[0]]));
      } else if (rule.format === "SpaceSeparatedList") {
        out.push(fill(rule.messages[parameters.length === 1 ? 0 : 1], [parameters.join(" ")]));
      } else {
        out.push(rule.messages[0]);
      }
    });
    return out;
  }

  // Whether Chrome would make an extension of the manifest.
  function creatableManifest(mf) {
    var version = typeof mf.version === "string" ? mf.version.split(".") : [];
    return typeof mf.name === "string" && mf.name !== "" && (mf.manifest_version === 2 || mf.manifest_version === 3) &&
      version.length >= 1 && version.length <= 4 && version.every(function (part) {
        return /^(0|[1-9]\d*)$/.test(part) && Number(part) <= 65535;
      });
  }

  function warningsByManifest(manifestStr, cb) {
    var parsed;
    try {
      parsed = JSON.parse(String(manifestStr));
    } catch (e) {
      return WEX.fail(cb, e.message);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return WEX.fail(cb, "Failed to parse manifest.");
    }
    if (!creatableManifest(parsed)) {
      return WEX.fail(cb, "Failed to create extension from manifest.");
    }
    try {
      return done(cb, permissionWarnings(parsed));
    } catch (e) {
      return WEX.fail(cb, e.message);
    }
  }

  // ------------------------------------------------------------------ //
  // Page capture
  // ------------------------------------------------------------------ //
  // pageCapture.saveAsMHTML, written as Chrome writes the archive: a part for
  // each frame the extension may capture and one for each file a frame's
  // document shows. The content bridge in each frame describes its document,
  // so a frame outside the extension's website access is left out, as
  // Chrome leaves out a frame the extension may not capture. The global page
  // fetches the files, and those of their style sheets; one it cannot fetch
  // is left out, and a viewer of the archive loads it from the web.
  var MHTML_TYPE = "application/x-mimearchive";
  var MHTML_TIMEOUT = 10000;
  var MHTML_STYLE_DEPTH = 3;

  // Of a text, as UTF-8, or of bytes as they are.
  function quotedPrintable(text) {
    var bytes = typeof text === "string" ? new g.TextEncoder().encode(text) : text;
    var out = "";
    var line = "";
    function put(piece) {
      if (line.length + piece.length > 75) {
        out += line + "=\r\n";
        line = "";
      }
      line += piece;
    }
    for (var i = 0; i < bytes.length; i++) {
      var b = bytes[i];
      if (b === 13 && bytes[i + 1] === 10) {
        continue;
      }
      if (b === 10) {
        if (/[ \t]$/.test(line)) {
          var last = line.charCodeAt(line.length - 1);
          line = line.slice(0, -1) + "=" + (last < 16 ? "0" : "") + last.toString(16).toUpperCase();
        }
        out += line + "\r\n";
        line = "";
      } else if ((b >= 33 && b <= 126 && b !== 61) || b === 32 || b === 9) {
        put(String.fromCharCode(b));
      } else {
        put("=" + (b < 16 ? "0" : "") + b.toString(16).toUpperCase());
      }
    }
    return out + line;
  }

  function wrappedBase64(bytes) {
    return WEX.bytesToBase64(bytes).replace(/(.{76})/g, "$1\r\n");
  }

  function mhtmlDate(date) {
    var days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    var two = function (n) {
      return (n < 10 ? "0" : "") + n;
    };
    var offset = -date.getTimezoneOffset();
    return days[date.getDay()] + ", " + two(date.getDate()) + " " + months[date.getMonth()] + " " +
      date.getFullYear() + " " + two(date.getHours()) + ":" + two(date.getMinutes()) + ":" +
      two(date.getSeconds()) + " " + (offset < 0 ? "-" : "+") + two(Math.floor(Math.abs(offset) / 60)) +
      two(Math.abs(offset) % 60);
  }

  function mhtmlSubject(title) {
    var text = String(title || "");
    if (/^[\x20-\x7e]*$/.test(text)) {
      return text;
    }
    return "=?utf-8?Q?" + quotedPrintable(text).replace(/=\r\n/g, "").replace(/ /g, "_")
      .replace(/\?/g, "=3F") + "?=";
  }

  function makePageCapture() {
    // A request to the bridge in one frame of the tab, and its answer.
    function askFrame(tabId, frameId, message) {
      return new Promise(function (resolve, reject) {
        var port = native.tabs.connect(tabId, { name: WEX.INTERNAL_PORT + "mhtml", frameId: frameId });
        var settled = false;
        var timer = setTimeout(function () {
          finish(new Error("the frame did not answer"));
        }, MHTML_TIMEOUT);
        function finish(error, value) {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          try {
            port.disconnect();
          } catch (e) { /* already gone */ }
          if (error) {
            reject(error);
          } else {
            resolve(value);
          }
        }
        port.onMessage.addListener(function (m) {
          finish(m && m.error ? new Error(m.error) : null, m);
        });
        port.onDisconnect.addListener(function () {
          finish(new Error("the frame has no bridge"));
        });
        port.postMessage(message);
      });
    }

    function fetchFile(url) {
      return g.fetch(url, { credentials: "include" }).then(function (response) {
        if (!response.ok) {
          return null;
        }
        return response.arrayBuffer().then(function (buffer) {
          var declared = String(response.headers.get("Content-Type") || "application/octet-stream");
          return { url: url, declared: declared, type: declared.split(";")[0].trim(), bytes: new Uint8Array(buffer) };
        });
      }).catch(function () {
        return null;
      });
    }

    // The files the frames show, and those their style sheets name.
    function fetchFiles(urls) {
      var files = [];
      var seen = {};
      function round(list, depth) {
        var fresh = list.filter(function (url) {
          if (seen[url] || !/^https?:/i.test(url)) {
            return false;
          }
          seen[url] = true;
          return true;
        });
        return Promise.all(fresh.map(fetchFile)).then(function (got) {
          var named = [];
          got.forEach(function (file) {
            if (!file) {
              return;
            }
            files.push(file);
            if (file.type === "text/css" && depth < MHTML_STYLE_DEPTH) {
              var css = new g.TextDecoder().decode(file.bytes);
              css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)|@import\s+(['"])([^'"]+)\3/g,
                function (_, q, inUrl, q2, inImport) {
                  try {
                    named.push(new g.URL(inUrl || inImport, file.url).href);
                  } catch (e) { /* not a URL */ }
                  return _;
                });
            }
          });
          return named.length ? round(named, depth + 1) : undefined;
        });
      }
      return round(urls, 0).then(function () {
        return files;
      });
    }

    function archive(pages, files) {
      var boundary = "----MultipartBoundary--" + WEX.uid("").replace(/[^a-z0-9]/gi, "") +
        Math.random().toString(36).slice(2) + "----";
      var top = pages[0];
      var tokens = {};
      pages.forEach(function (page, i) {
        page.token = page.token || (i === 0 ? WEX.uid("f").replace(/[^a-z0-9]/gi, "") : page.token);
        tokens[page.token] = true;
      });
      var text = "From: <Saved by Blink>\r\n" +
        "Snapshot-Content-Location: " + top.url + "\r\n" +
        "Subject: " + mhtmlSubject(top.title) + "\r\n" +
        "Date: " + mhtmlDate(new Date()) + "\r\n" +
        "MIME-Version: 1.0\r\n" +
        "Content-Type: multipart/related;\r\n\ttype=\"text/html\";\r\n\tboundary=\"" + boundary + "\"\r\n\r\n\r\n";
      pages.forEach(function (page) {
        var html = page.html.replace(/wex-mhtml-frame:([a-z0-9]+)/gi, function (_, token) {
          return tokens[token] ? "cid:frame-" + token + "@mhtml.blink" : (page.frames[token] || "about:blank");
        });
        text += "--" + boundary + "\r\n" +
          "Content-Type: " + (page.contentType === "application/xhtml+xml" ? page.contentType : "text/html") +
            "; charset=utf-8\r\n" +
          "Content-ID: <frame-" + page.token + "@mhtml.blink>\r\n" +
          "Content-Transfer-Encoding: quoted-printable\r\n" +
          "Content-Location: " + page.url + "\r\n\r\n" + quotedPrintable(html) + "\r\n\r\n";
      });
      files.forEach(function (file) {
        // A file keeps its own bytes and says what they are in. Quoted-printable
        // takes line ends to be single bytes, which only an ASCII-based charset
        // promises, so a file that names another charset goes as base64.
        var charset = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(file.declared);
        var textual = /^text\/|^image\/svg\+xml$|^application\/(javascript|json|xml)$/.test(file.type) &&
          (!charset || /^(utf-?8|us-ascii)$/i.test(charset[1]));
        text += "--" + boundary + "\r\n" +
          "Content-Type: " + file.declared + "\r\n" +
          "Content-Transfer-Encoding: " + (textual ? "quoted-printable" : "base64") + "\r\n" +
          "Content-Location: " + file.url + "\r\n\r\n" +
          (textual ? quotedPrintable(file.bytes) : wrappedBase64(file.bytes)) +
          "\r\n\r\n";
      });
      return text + "--" + boundary + "--\r\n";
    }

    function capture(tabId) {
      return Promise.resolve(native.webNavigation.getAllFrames({ tabId: tabId })).catch(function () {
        return null;
      }).then(function (frames) {
        var ids = (frames || []).map(function (f) {
          return f.frameId;
        }).filter(function (id) {
          return id !== 0;
        });
        var everyFrame = [0].concat(ids);
        // Each frame first tells its frames who they are, then describes itself.
        return Promise.all(everyFrame.map(function (id) {
          return askFrame(tabId, id, { prepare: true }).catch(function () {
            return null;
          });
        })).then(function () {
          return Promise.all(everyFrame.map(function (id) {
            return askFrame(tabId, id, { serialize: true }).then(function (m) {
              return m.page;
            }, function () {
              return null;
            });
          }));
        });
      }).then(function (pages) {
        if (!pages[0]) {
          throw new Error("Don't have permissions required to capture this page.");
        }
        pages = pages.filter(function (page, i) {
          return page && (i === 0 || page.token);
        });
        var urls = [];
        pages.forEach(function (page) {
          urls = urls.concat(page.resources);
        });
        return fetchFiles(urls).then(function (files) {
          return archive(pages, files);
        });
      });
    }

    return {
      saveAsMHTML: function (details, cb) {
        var d = details || {};
        var tabId = d.tabId;
        return settle(Promise.resolve(typeof tabId === "number" ? native.tabs.get(tabId) : null)
          .catch(function () {
            return null;
          }).then(function (tab) {
            if (!tab) {
              throw new Error("Cannot find the tab for this request.");
            }
            return capture(tabId);
          }).then(function (text) {
            return d.__wexText ? text : new g.Blob([text], { type: MHTML_TYPE });
          }), cb);
      }
    };
  }

  // ------------------------------------------------------------------ //
  // Text to speech
  // ------------------------------------------------------------------ //
  // Chrome's tts, spoken by Safari's speech synthesis here in the global
  // page, so that speech is the browser's, as Chrome's is: what one page of
  // the extension says, another can stop. An utterance's events go to its
  // own onEvent, and to tts.onEvent with its srcId, by which an extension
  // page that asked for the speech hears them.
  var TTS_EVENT_TYPES = ["start", "end", "word", "interrupted", "cancelled", "error", "pause", "resume"];
  var MAX_UTTERANCE_LENGTH = 32768;

  function makeTts() {
    var synth = g.speechSynthesis;
    if (!synth || typeof g.SpeechSynthesisUtterance !== "function") {
      return undefined;
    }
    var onEvent = new Event("tts.onEvent");
    var onVoicesChanged = new Event("tts.onVoicesChanged");
    var nextSource = 1;
    var spoken = [];

    function voices() {
      return synth.getVoices().map(function (v) {
        return { voiceName: v.name, lang: v.lang, remote: !v.localService, eventTypes: TTS_EVENT_TYPES.slice() };
      });
    }
    try {
      synth.addEventListener("voiceschanged", function () {
        onVoicesChanged.emit();
      });
    } catch (e) { /* no voice changes to report */ }

    // Ends an utterance that will not be spoken, or will not be finished, as
    // Chrome reports it.
    function finish(entry, type) {
      if (entry.done) {
        return;
      }
      entry.done = true;
      entry.report({ type: type, charIndex: type === "interrupted" ? entry.charIndex : undefined });
    }

    function speak(text, options, cb) {
      if (typeof options === "function") {
        cb = options;
        options = undefined;
      }
      var o = options || {};
      text = String(text == null ? "" : text);
      if (text.length > MAX_UTTERANCE_LENGTH) {
        return WEX.fail(cb, "Utterance length is too long.");
      }
      var list = synth.getVoices();
      var voice = null;
      if (o.voiceName != null) {
        voice = list.filter(function (v) {
          return v.name === o.voiceName;
        })[0] || null;
      } else if (o.lang) {
        voice = list.filter(function (v) {
          return v.lang === o.lang;
        })[0] || list.filter(function (v) {
          return String(v.lang).split("-")[0] === String(o.lang).split("-")[0];
        })[0] || null;
      }
      var required = o.requiredEventTypes || [];
      if (required.some(function (type) { return TTS_EVENT_TYPES.indexOf(type) < 0; })) {
        return WEX.fail(cb, "Could not find matching TTS voice.");
      }
      var desired = Array.isArray(o.desiredEventTypes) ? o.desiredEventTypes : null;
      var srcId = o.__wexSrcId != null ? o.__wexSrcId : nextSource++;
      var entry = { done: false, charIndex: 0 };
      entry.report = function (event) {
        var isFinal = ["end", "interrupted", "cancelled", "error"].indexOf(event.type) >= 0;
        if (isFinal) {
          entry.done = true;
          spoken.splice(spoken.indexOf(entry), 1);
        }
        if (desired && desired.indexOf(event.type) < 0 && !isFinal) {
          return;
        }
        var e = { type: event.type, isFinalEvent: isFinal, srcId: srcId };
        if (event.charIndex != null) {
          e.charIndex = event.charIndex;
        }
        if (event.length != null) {
          e.length = event.length;
        }
        if (event.errorMessage) {
          e.errorMessage = event.errorMessage;
        }
        if (typeof o.onEvent === "function") {
          try {
            o.onEvent(e);
          } catch (err) {
            log.error("tts onEvent listener threw", err);
          }
        }
        onEvent.emit(e);
      };
      if (!o.enqueue) {
        spoken.slice().forEach(function (other, i) {
          finish(other, i === 0 && other.started ? "interrupted" : "cancelled");
        });
        synth.cancel();
      }
      var u = new g.SpeechSynthesisUtterance(text);
      if (voice) {
        u.voice = voice;
      }
      if (o.lang) {
        u.lang = o.lang;
      }
      if (typeof o.rate === "number") {
        u.rate = Math.max(0.1, Math.min(10, o.rate));
      }
      if (typeof o.pitch === "number") {
        u.pitch = Math.max(0, Math.min(2, o.pitch));
      }
      if (typeof o.volume === "number") {
        u.volume = Math.max(0, Math.min(1, o.volume));
      }
      u.onstart = function () {
        entry.started = true;
        entry.report({ type: "start", charIndex: 0 });
      };
      u.onend = function () {
        if (!entry.done) {
          entry.report({ type: "end", charIndex: text.length });
        }
      };
      u.onboundary = function (e) {
        entry.charIndex = e.charIndex;
        if (e.name === "word" || e.name === undefined) {
          entry.report({ type: "word", charIndex: e.charIndex, length: e.charLength });
        } else if (e.name === "sentence") {
          entry.report({ type: "sentence", charIndex: e.charIndex, length: e.charLength });
        }
      };
      u.onpause = function () {
        entry.report({ type: "pause", charIndex: entry.charIndex });
      };
      u.onresume = function () {
        entry.report({ type: "resume", charIndex: entry.charIndex });
      };
      u.onerror = function (e) {
        if (entry.done) {
          return;
        }
        if (e.error === "interrupted" || e.error === "canceled") {
          finish(entry, entry.started ? "interrupted" : "cancelled");
        } else {
          entry.report({ type: "error", errorMessage: String(e.error || "error") });
        }
      };
      spoken.push(entry);
      synth.speak(u);
      return done(cb);
    }

    return {
      onEvent: onEvent,
      onVoicesChanged: onVoicesChanged,
      speak: speak,
      stop: function () {
        spoken.slice().forEach(function (entry, i) {
          finish(entry, i === 0 && entry.started ? "interrupted" : "cancelled");
        });
        synth.cancel();
      },
      pause: function () {
        synth.pause();
      },
      resume: function () {
        synth.resume();
      },
      isSpeaking: function (cb) {
        return done(cb, !!synth.speaking);
      },
      getVoices: function (cb) {
        return done(cb, voices());
      }
    };
  }

  // ------------------------------------------------------------------ //
  // Declarative content
  // ------------------------------------------------------------------ //
  // Chrome's rules on the pages tabs show, kept across restarts as Chrome
  // keeps them. A rule applies to a tab while one of its PageStateMatchers
  // matches the tab's page: its pageUrl, as an events.UrlFilter, matches the
  // page's address, and each of its css selectors matches an element of the
  // page, which the page reports as it changes. A rule's ShowAction shows the
  // action on the tab, and its RequestContentScript adds its scripts and
  // style sheets to the page once. Safari takes a toolbar icon only from a
  // file, so SetIcon's pixels are not shown, and with no bookmarks to ask, no
  // page is bookmarked.
  var DECLARATIVE_CONTENT_KEY = "wex.declarativeContent";
  var declarativeState = { nextId: 0, rules: [] };
  var pageUrls = {};
  var pageSelectors = {};
  var pageScripted = {};

  (function loadDeclarativeRules() {
    try {
      var kept = JSON.parse(settingsItem(DECLARATIVE_CONTENT_KEY) || "null");
      if (kept && Array.isArray(kept.rules)) {
        declarativeState = kept;
      }
    } catch (e) { /* none kept */ }
  })();

  function declaredSelectors() {
    var all = [];
    declarativeState.rules.forEach(function (rule) {
      (rule.conditions || []).forEach(function (c) {
        (c.css || []).forEach(function (selector) {
          if (all.indexOf(selector) < 0) {
            all.push(selector);
          }
        });
      });
    });
    return all;
  }

  function pageMatches(condition, tabId) {
    if (!condition || condition.instanceType !== "declarativeContent.PageStateMatcher") {
      return false;
    }
    var url = pageUrls[tabId];
    if (condition.pageUrl && !(url && WEX.urlFilterMatches(url, condition.pageUrl))) {
      return false;
    }
    var found = pageSelectors[tabId] || [];
    if ((condition.css || []).some(function (selector) { return found.indexOf(selector) < 0; })) {
      return false;
    }
    return condition.isBookmarked !== true;
  }

  function requestContentScripts(tabId, rule, request) {
    var scripted = pageScripted[tabId] || (pageScripted[tabId] = []);
    if (scripted.indexOf(rule.id) >= 0) {
      return;
    }
    scripted.push(rule.id);
    var options = { allFrames: !!request.allFrames, matchAboutBlank: !!request.matchAboutBlank };
    (request.css || []).forEach(function (file) {
      native.tabs.insertCSS(tabId, { file: file, allFrames: options.allFrames,
        matchAboutBlank: options.matchAboutBlank }).catch(function () {});
    });
    (request.js || []).forEach(function (file) {
      native.tabs.executeScript(tabId, { file: file, allFrames: options.allFrames,
        matchAboutBlank: options.matchAboutBlank }).catch(function () {});
    });
  }

  function applyDeclarativeRules(tabId) {
    var shown = false;
    declarativeState.rules.forEach(function (rule) {
      if (!(rule.conditions || []).some(function (c) { return pageMatches(c, tabId); })) {
        return;
      }
      (rule.actions || []).forEach(function (action) {
        var type = action && action.instanceType;
        if (type === "declarativeContent.ShowAction" || type === "declarativeContent.ShowPageAction") {
          shown = true;
        } else if (type === "declarativeContent.RequestContentScript") {
          requestContentScripts(tabId, rule, action);
        }
      });
    });
    if (shown) {
      declaredShown[tabId] = true;
    } else {
      delete declaredShown[tabId];
    }
    refreshToolbar();
  }

  // A page with selectors to look for reports which of them match, now and
  // each time it changes.
  function watchSelectors(tabId) {
    var selectors = declaredSelectors();
    if (!selectors.length) {
      return;
    }
    var watch = function (selectors) {
      if (window.__wexDeclarativeCss) {
        window.__wexDeclarativeCss(selectors);
        return;
      }
      var current = selectors;
      var last = null;
      var timer = null;
      function check() {
        timer = null;
        var found = current.filter(function (selector) {
          try {
            return !!document.querySelector(selector);
          } catch (e) {
            return false;
          }
        });
        var key = found.join("\n");
        if (key === last) {
          return;
        }
        last = key;
        var api = typeof chrome !== "undefined" && chrome.runtime ? chrome : browser;
        api.runtime.sendMessage({ __wex: "declarativeCss", matches: found });
      }
      window.__wexDeclarativeCss = function (selectors) {
        current = selectors;
        last = null;
        check();
      };
      new MutationObserver(function () {
        if (!timer) {
          timer = setTimeout(check, 200);
        }
      }).observe(document, { childList: true, subtree: true, attributes: true });
      check();
    };
    native.tabs.executeScript(tabId, { code: "(" + watch + ")(" + JSON.stringify(selectors) + ");" })
      .catch(function () {});
  }

  function applyToEveryTab() {
    identifyAll().then(function () {
      eachSafariTab(function (t) {
        var id = idBySafariTab.get(t);
        if (id === undefined) {
          return;
        }
        if (pageUrls[id] === undefined && t.url) {
          pageUrls[id] = t.url;
        }
        applyDeclarativeRules(id);
        watchSelectors(id);
      });
    });
  }

  native.webNavigation.onCommitted.addListener(function (details) {
    if (details.frameId !== 0) {
      return;
    }
    pageUrls[details.tabId] = details.url;
    delete pageSelectors[details.tabId];
    delete pageScripted[details.tabId];
  });
  native.webNavigation.onDOMContentLoaded.addListener(function (details) {
    if (details.frameId === 0) {
      watchSelectors(details.tabId);
    }
  });
  native.tabs.onRemoved.addListener(function (id) {
    delete pageUrls[id];
    delete pageSelectors[id];
    delete pageScripted[id];
  });

  function reportedSelectors(message, sender) {
    if (sender && sender.tab && Array.isArray(message.matches)) {
      pageSelectors[sender.tab.id] = message.matches.map(String);
      applyDeclarativeRules(sender.tab.id);
    }
  }

  function makeDeclarativeContent() {
    function save() {
      settingsItem(DECLARATIVE_CONTENT_KEY, JSON.stringify(declarativeState));
      applyToEveryTab();
    }
    function chosen(ids) {
      return declarativeState.rules.filter(function (rule) {
        return ids == null || ids.indexOf(rule.id) >= 0;
      });
    }
    function invalid() {
      throw new TypeError("Invalid invocation");
    }
    function plain(value) {
      return JSON.parse(JSON.stringify(value));
    }
    var onPageChanged = {
      // The call of an extension page in a tab, whose callback stays there.
      __wexRemote: function (method, argument) {
        return new Promise(function (resolve, reject) {
          var args = argument === undefined ? [] : [argument];
          args.push(function (value) {
            var error = chrome.runtime.lastError;
            if (error) {
              reject(new Error(error.message));
            } else {
              resolve(value);
            }
          });
          onPageChanged[method].apply(onPageChanged, args);
        });
      },
      addRules: function (rules, cb) {
        if (!Array.isArray(rules) || (cb != null && typeof cb !== "function")) {
          invalid();
        }
        var added = [];
        for (var i = 0; i < rules.length; i++) {
          var rule = plain(rules[i] || {});
          if (!Array.isArray(rule.conditions) || !Array.isArray(rule.actions)) {
            invalid();
          }
          if (rule.id == null) {
            rule.id = "_" + declarativeState.nextId++ + "_";
          }
          if (rule.priority == null) {
            rule.priority = 100;
          }
          var taken = chosen([rule.id]).length || added.some(function (r) { return r.id === rule.id; });
          if (taken) {
            WEX.fail(cb, "Duplicate rule ID: " + rule.id);
            return undefined;
          }
          added.push(rule);
        }
        declarativeState.rules = declarativeState.rules.concat(added);
        save();
        if (cb) {
          done(cb, plain(added));
        }
        return undefined;
      },
      removeRules: function (ids, cb) {
        if (typeof ids === "function") {
          cb = ids;
          ids = undefined;
        }
        if ((ids != null && !Array.isArray(ids)) || (cb != null && typeof cb !== "function")) {
          invalid();
        }
        declarativeState.rules = declarativeState.rules.filter(function (rule) {
          return ids != null && ids.indexOf(rule.id) < 0;
        });
        save();
        if (cb) {
          done(cb);
        }
        return undefined;
      },
      getRules: function (ids, cb) {
        if (typeof ids === "function") {
          cb = ids;
          ids = undefined;
        }
        if ((ids != null && !Array.isArray(ids)) || typeof cb !== "function") {
          invalid();
        }
        done(cb, plain(chosen(ids)));
        return undefined;
      }
    };
    applyToEveryTab();
    var declarativeContent = WEX.declarativeContentTypes();
    declarativeContent.onPageChanged = onPageChanged;
    return declarativeContent;
  }

  // ------------------------------------------------------------------ //
  // The address bar
  // ------------------------------------------------------------------ //
  // A search Safari is about to make from its address bar that starts with
  // the manifest's omnibox keyword and a space goes to the extension instead,
  // as Chrome sends what follows its keyword. Safari shows no suggestions and
  // tells of no keystroke, so suggestions are kept to no effect and the input
  // is reported only when entered.
  function makeOmnibox() {
    var keyword = ((CONFIG.manifest || {}).omnibox || {}).keyword;
    if (!keyword) {
      return undefined;
    }
    var omnibox = {
      onInputStarted: new Event("omnibox.onInputStarted"),
      onInputChanged: new Event("omnibox.onInputChanged"),
      onInputEntered: new Event("omnibox.onInputEntered"),
      onInputCancelled: new Event("omnibox.onInputCancelled"),
      onDeleteSuggestion: new Event("omnibox.onDeleteSuggestion"),
      onActionExecuted: new Event("omnibox.onActionExecuted"),
      sendSuggestions: function () {},
      setDefaultSuggestion: function (suggestion, cb) {
        return done(cb);
      }
    };
    var prefix = String(keyword) + " ";
    onAppEvent("beforeSearch", function (e) {
      var query = String(e.query || "");
      if (query.indexOf(prefix) !== 0) {
        return;
      }
      try {
        e.preventDefault();
      } catch (err) { /* the search goes ahead too */ }
      var text = query.slice(prefix.length);
      omnibox.onInputStarted.emit();
      omnibox.onInputEntered.emit(text, "currentTab");
    });
    return omnibox;
  }

  function makeCommands() {
    var commands = {
      onCommand: commandsOnCommand,
      getAll: function (cb) {
        return done(cb, commandList());
      }
    };
    if (CONFIG.firefoxBuild) {
      var known = function (name) {
        return hasOwnKey((CONFIG.manifest && CONFIG.manifest.commands) || {}, name);
      };
      commands.update = function (detail, cb) {
        var d = detail || {};
        if (!known(d.name)) {
          return WEX.fail(cb, "Unknown command \"" + d.name + "\"");
        }
        if (typeof d.description === "string") {
          commandDescriptions[d.name] = d.description;
        }
        return done(cb);
      };
      commands.reset = function (name, cb) {
        if (!known(name)) {
          return WEX.fail(cb, "Unknown command \"" + name + "\"");
        }
        delete commandDescriptions[name];
        return done(cb);
      };
    }
    return commands;
  }


  var chrome = buildNamespace(native);
  WEX.addNativeMessaging(chrome.runtime);

  // A server's challenge to a request of the extension's own pages, which
  // belong to no tab, ends the request with the challenge's response in
  // Chrome (a background has no window to ask the user in), where Safari
  // would put up its login sheet: such a challenge is cancelled, unless the
  // extension answers challenges itself.
  if (native.webRequest && native.webRequest.onAuthRequired && chrome.webRequest) {
    try {
      native.webRequest.onAuthRequired.addListener(function (details) {
        var d = details || {};
        if (d.tabId !== -1 || String(d.documentUrl || "").indexOf(WEX.baseURI) !== 0 ||
            (chrome.webRequest && chrome.webRequest.onAuthRequired.hasListeners())) {
          return undefined;
        }
        return { cancel: true };
      }, { urls: ["<all_urls>"] }, ["blocking"]);
    } catch (e) {
      note("could not keep Safari's login sheet from the extension's own requests: " +
        (e && e.message ? e.message : e));
    }
  }
  // No native application connects to an extension here.
  if (chrome.runtime.connectNative && !CONFIG.firefoxBuild) {
    chrome.runtime.onConnectNative = new Event("runtime.onConnectNative");
  }
  WEX.NAMESPACES.forEach(function (name) {
    if (!WEX.namespaceGranted(name) || chrome[name] === undefined) {
      delete chrome[name];
    }
  });
  // A namespace the extension has without its permission has only the
  // functions it is open with.
  WEX.NAMESPACES.forEach(function (name) {
    var open = WEX.openFunctions(name);
    if (open && chrome[name]) {
      Object.keys(chrome[name]).forEach(function (member) {
        if (typeof chrome[name][member] === "function" || chrome[name][member] instanceof Event) {
          if (open.indexOf(member) < 0) {
            delete chrome[name][member];
          }
        }
      });
    }
  });
  // The developer tools' API is a devtools page's alone, and the captures of
  // any tab are Firefox's.
  delete chrome.devtools;
  // The debugger needs WebKit's input from extensions.
  if (!hostAqua() || !hostAqua().input) {
    delete chrome["debugger"];
  }
  if (chrome.tabs && (!CONFIG.firefoxBuild || !native.tabs || !native.tabs.captureTab)) {
    delete chrome.tabs.captureTab;
    delete chrome.tabs.saveAsPDF;
  }

  // A provisional id an extension kept from before WebKit's id was known
  // still names its tab: the calls that take tab ids are given the tab's
  // current one. Provisional ids lie above anything else these calls take.
  function currentIds(value, depth) {
    if (typeof value === "number") {
      var tab = value >= WEX.PROVISIONAL_TAB_ID ? retiredIds.get(value) : undefined;
      var current = tab !== undefined ? idBySafariTab.get(tab) : undefined;
      return current !== undefined ? current : value;
    }
    if (depth > 3 || !value || typeof value !== "object") {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map(function (item) { return currentIds(item, depth + 1); });
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      return value;
    }
    var copy = {};
    Object.keys(value).forEach(function (key) {
      copy[key] = currentIds(value[key], depth + 1);
    });
    return copy;
  }
  // The calls that describe tabs, or take the active tab's id, wait until
  // every tab has been looked up.
  [["tabs", ["query", "get", "update", "reload", "discard", "goBack", "goForward"]], ["windows", ["get", "getAll", "getCurrent", "getLastFocused"]],
    ["tabGroups", ["get", "query"]]].forEach(function (entry) {
    var area = chrome[entry[0]];
    if (!area) {
      return;
    }
    entry[1].forEach(function (name) {
      if (typeof area[name] === "function") {
        area[name] = afterIdentified(area[name]);
      }
    });
  });
  var translated = [];
  ["tabs", "scripting", "action", "browserAction", "pageAction", "webNavigation",
    "declarativeNetRequest", "windows", "pageCapture", "debugger", "sidePanel", "tabCapture"].forEach(function (name) {
    var area = chrome[name];
    if (!area || translated.indexOf(area) >= 0) {
      return;
    }
    translated.push(area);
    Object.keys(area).forEach(function (key) {
      var fn = area[key];
      if (typeof fn !== "function") {
        return;
      }
      area[key] = function () {
        if (!retiredIds.size) {
          return fn.apply(this, arguments);
        }
        var args = Array.prototype.map.call(arguments, function (arg) {
          return typeof arg === "function" ? arg : currentIds(arg, 0);
        });
        return fn.apply(this, args);
      };
    });
  });

  WEX.addSchemaEnums(chrome);

  // Extension pages learn from this which members the namespace has, so a
  // member it lacks is missing there too, as feature tests expect.
  try {
    var shapeValues = {};
    var shapePaths = WEX.namespaceShape(chrome, shapeValues);
    WEX.localStorageOf(g).setItem(WEX.NAMESPACE_SHAPE_KEY, JSON.stringify({
      version: CONFIG.version, paths: shapePaths, values: shapeValues
    }));
  } catch (e) { /* pages fall back to assuming every member exists */ }

  WEX.installOpenInTab(g, chrome.tabs);

  // ------------------------------------------------------------------ //
  // Calls from other processes
  // ------------------------------------------------------------------ //
  // Extension pages in tabs and content scripts have no way to the objects
  // here, so their calls arrive as messages naming a method of the namespace
  // (WEX.makeRemote). An extension page may call anything; a content script
  // only what a browser gives content scripts.
  var CONTENT_CALLS = /^storage\.(local|sync|session)\.(get|set|remove|clear|getBytesInUse|getKeys)$/;
  var CONTENT_EVENTS = /^storage\.((local|sync|session)\.)?onChanged$/;

  function isExtensionPage(sender) {
    return !!sender && WEX.isExtUrl(sender.url || "");
  }

  function resolvePath(path) {
    var parent = null;
    var value = chrome;
    var parts = String(path).split(".");
    for (var i = 0; i < parts.length; i++) {
      if (value == null || (typeof value !== "object" && typeof value !== "function") ||
          !Object.prototype.hasOwnProperty.call(value, parts[i])) {
        return null;
      }
      parent = value;
      value = value[parts[i]];
    }
    return { parent: parent, value: value };
  }

  function answerCall(message, sender) {
    var path = String(message.path);
    return Promise.resolve().then(function () {
      if (!isExtensionPage(sender) && !CONTENT_CALLS.test(path)) {
        throw new Error(path + " is not available to content scripts");
      }
      if (path === "tabs.getCurrent") {
        return sender.tab ? describeTabId(sender.tab.id) : undefined;
      }
      var target = resolvePath(path);
      if (!target || typeof target.value !== "function") {
        throw new Error(path + " is not a function");
      }
      // The caller's context checked the call's arguments as they were given.
      return (target.value.__wexOriginal || target.value).apply(target.parent, message.args || []);
    }).then(function (value) {
      return { value: value };
    }, function (error) {
      return { error: String(error && error.message ? error.message : error) };
    });
  }

  function serveEvents(port) {
    var trusted = isExtensionPage(port.sender);
    var forwarders = {};

    function unsubscribe(path) {
      if (forwarders[path]) {
        forwarders[path].event.removeListener(forwarders[path].fn);
        delete forwarders[path];
      }
    }

    port.onMessage.addListener(function (m) {
      if (m.unsubscribe) {
        unsubscribe(String(m.unsubscribe));
        return;
      }
      var path = String(m.subscribe);
      if (forwarders[path] || (!trusted && !CONTENT_EVENTS.test(path))) {
        return;
      }
      var target = resolvePath(path);
      if (!target || !target.value || typeof target.value.addListener !== "function") {
        return;
      }
      var fn = function () {
        try {
          port.postMessage({ event: path, args: Array.prototype.slice.call(arguments) });
        } catch (e) {
          unsubscribe(path);
        }
      };
      forwarders[path] = { event: target.value, fn: fn };
      target.value.addListener(fn);
    });

    port.onDisconnect.addListener(function () {
      Object.keys(forwarders).forEach(unsubscribe);
    });
  }

  // Style sheets the manifest declares for content scripts, which the bridge
  // in a frame asks for when the frame is one they belong in.
  function insertDeclaredSheets(files, sender) {
    if (!sender || !sender.tab) {
      return Promise.resolve(true);
    }
    var declared = [];
    (CONFIG.contentScripts || []).forEach(function (group) {
      declared = declared.concat(group.css || []);
    });
    return Promise.all((files || []).filter(function (file) {
      return declared.indexOf(file) >= 0;
    }).map(function (file) {
      return native.tabs.insertCSS(sender.tab.id, {
        file: String(file).replace(/^\/+/, ""),
        frameId: sender.frameId || 0,
        matchAboutBlank: true,
        runAt: "document_start"
      }).catch(function (e) {
        log.debug("could not add " + file + " to a page", e);
      });
    })).then(function () {
      return true;
    });
  }

  // Style sheets a content script inserted and the page's policy refused,
  // added as user style sheets instead.
  function insertRefusedStyles(message, sender) {
    if (!sender || !sender.tab) {
      return;
    }
    var details = { frameId: sender.frameId || 0, matchAboutBlank: true };
    var sheets = (message.files || []).map(function (file) {
      return { file: String(file) };
    });
    if (message.code) {
      sheets.push({ code: String(message.code) });
    }
    sheets.forEach(function (sheet) {
      Object.keys(details).forEach(function (key) {
        sheet[key] = details[key];
      });
      native.tabs.insertCSS(sender.tab.id, sheet).catch(function (e) {
        log.debug("could not add a refused style sheet to a page", e);
      });
    });
  }

  function reportSameDocumentNavigation(message, sender) {
    if (!sender || !sender.tab) {
      return;
    }
    var event = message.how === "fragment"
      ? navOnReferenceFragmentUpdated : navOnHistoryStateUpdated;
    var url = String(message.url || sender.url || "");
    // A rule's pageUrl goes by the address the top frame shows now.
    if (!sender.frameId) {
      pageUrls[sender.tab.id] = url;
      if (declarativeState.rules.length) {
        applyDeclarativeRules(sender.tab.id);
      }
    }
    event.emit({
      tabId: sender.tab.id,
      frameId: sender.frameId || 0,
      parentFrameId: sender.frameId ? 0 : -1,
      url: url,
      processId: -1,
      timeStamp: Date.now(),
      transitionType: "link",
      transitionQualifiers: []
    });
  }

  // ------------------------------------------------------------------ //
  // Language detection
  // ------------------------------------------------------------------ //
  // Chrome's language detector, CLD3, as WebAssembly (wex/cld3.wasm, with
  // its licence beside it, and what loading it needs in wex/cld3.json),
  // loaded here the first time a text's language is asked for. It runs here
  // alone, as each instance holds a heap of its own; the other pages and the
  // content scripts ask here (WEX.detectTextLanguages). Its answer is given
  // as Chrome's i18n.detectLanguage gives it (extensions/renderer/api/
  // i18n_hooks_delegate.cc): the three commonest languages of the text's
  // first 10,000 bytes, each with the share of the bytes it has, none after the
  // first unknown one and none of CLD3's romanized ones (xx-Latn), reliable
  // where each is and the text has 50 bytes or more.
  var CLD3_LANGUAGES = 3;
  var CLD3_TEXT_BYTES = 512;
  var CLD3_RELIABLE_BYTES = 50;
  // How much of a text CLD3 reads (kMaxNumInputBytesToConsider); the rest
  // never reaches the heap.
  var CLD3_INPUT_BYTES = 10000;
  // How much of a page's text tells its language.
  var PAGE_TEXT_BYTES = 4096;
  var NO_LANGUAGE = { isReliable: false, languages: [] };
  var cld3Loading = null;

  function utf8(text) {
    if (typeof g.TextEncoder === "function") {
      return new g.TextEncoder().encode(text);
    }
    // A lone surrogate becomes U+FFFD, as TextEncoder makes it.
    var binary = unescape(encodeURIComponent(text.replace(/[\ud800-\udbff][\udc00-\udfff]|[\ud800-\udfff]/g,
      function (unit) {
        return unit.length === 2 ? unit : String.fromCharCode(0xfffd);
      })));
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  // The module, with what its emscripten build would have given it: the
  // memory and table it imports, its heap's top where it keeps it, and the
  // few library functions it calls, any other one stopping it.
  function startCld3(bytes, layout) {
    var memory = new g.WebAssembly.Memory({ initial: layout.memoryPages, maximum: layout.memoryPages });
    var table = new g.WebAssembly.Table({ initial: layout.tableSize, maximum: layout.tableSize, element: "anyfunc" });
    new Int32Array(memory.buffer)[layout.dynamicTopPointer >> 2] = layout.dynamicBase;
    var exports = null;
    function nothing() {}
    var given = {
      env: {
        memory: memory,
        table: table,
        __table_base: layout.tableBase,
        DYNAMICTOP_PTR: layout.dynamicTopPointer,
        ___cxa_allocate_exception: function (size) {
          return exports._malloc(size);
        },
        ___cxa_uncaught_exceptions: function () {
          return 0;
        },
        ___lock: nothing,
        ___unlock: nothing,
        setTempRet0: nothing,
        ___setErrNo: function (value) {
          new Int32Array(memory.buffer)[exports.___errno_location() >> 2] = value;
          return value;
        },
        ___syscall6: function () {
          return 0;
        },
        ___syscall140: function () {
          return 0;
        },
        ___wasi_fd_write: function (fd, vectors, count, written) {
          var heap = new Int32Array(memory.buffer);
          var total = 0;
          for (var i = 0; i < count; i++) {
            total += heap[(vectors >> 2) + i * 2 + 1];
          }
          heap[written >> 2] = total;
          return 0;
        },
        _emscripten_get_heap_size: function () {
          return memory.buffer.byteLength;
        },
        _emscripten_memcpy_big: function (to, from, count) {
          new Uint8Array(memory.buffer).copyWithin(to, from, from + count);
          return to;
        },
        _emscripten_resize_heap: function () {
          return 0;
        },
        _pthread_equal: function (a, b) {
          return a === b ? 1 : 0;
        }
      },
      global: { NaN: NaN, Infinity: Infinity },
      "global.Math": Math
    };
    var imports = {};
    layout.imports.forEach(function (full) {
      var dot = full.lastIndexOf(".");
      var module = full.slice(0, dot);
      var name = full.slice(dot + 1);
      var source = given[module];
      imports[module] = imports[module] || {};
      imports[module][name] = source && Object.prototype.hasOwnProperty.call(source, name) ? source[name] :
        function () {
          throw new Error("CLD3 stopped in " + name);
        };
    });
    return g.WebAssembly.instantiate(bytes, imports).then(function (result) {
      exports = result.instance.exports;
      layout.constructors.forEach(function (name) {
        exports[name]();
      });
      var handles = {};
      var resultSize = exports._get_SizeLanguageResult();
      // The text's commonest languages, as CLD3 gives them.
      // The heap cannot grow, so a full one stops the detector.
      function allocate(size) {
        var pointer = exports._malloc(size);
        if (!pointer) {
          throw new Error("CLD3 is out of memory");
        }
        return pointer;
      }
      return function (text, limit, maxBytes) {
        var handle = handles[maxBytes] || (handles[maxBytes] = exports._Cld_create(0, maxBytes));
        // Every UTF-16 unit is at least a byte, so this many hold all CLD3
        // reads; a character the byte limit cuts is left out, as CLD3 leaves
        // it out.
        var encoded = utf8(text.length > CLD3_INPUT_BYTES ? text.slice(0, CLD3_INPUT_BYTES) : text);
        var length = Math.min(encoded.length, CLD3_INPUT_BYTES);
        while (length < encoded.length && (encoded[length] & 0xc0) === 0x80) {
          length--;
        }
        encoded = encoded.subarray(0, length);
        var textPointer = allocate(encoded.length + 1);
        var heap8 = new Uint8Array(memory.buffer);
        heap8.set(encoded, textPointer);
        heap8[textPointer + encoded.length] = 0;
        var list = allocate(limit * 4);
        var structs = [];
        for (var i = 0; i < limit; i++) {
          structs.push(allocate(resultSize));
          new Int32Array(memory.buffer)[(list >> 2) + i] = structs[i];
        }
        exports._Cld_findTopNMostFreqLangs(handle, textPointer, limit, list);
        var found = structs.map(function (struct) {
          var heap32 = new Int32Array(memory.buffer);
          var floats = new Float32Array(memory.buffer);
          var bytes8 = new Uint8Array(memory.buffer);
          var name = heap32[struct >> 2];
          var language = "";
          for (var at = name; bytes8[at]; at++) {
            language += String.fromCharCode(bytes8[at]);
          }
          var spans = heap32[(struct >> 2) + 4];
          var spanList = heap32[(struct >> 2) + 5];
          for (var k = 0; k < spans; k++) {
            exports._free(heap32[(spanList >> 2) + k]);
          }
          exports._free(spanList);
          exports._free(name);
          var answer = { language: language, reliable: !!bytes8[struct + 8], proportion: floats[(struct >> 2) + 3] };
          exports._free(struct);
          return answer;
        });
        exports._free(list);
        exports._free(textPointer);
        return { found: found, bytes: encoded.length };
      };
    });
  }

  function cld3() {
    if (!cld3Loading) {
      cld3Loading = Promise.resolve().then(function () {
        var layout = WEX.readJsonSync("wex/cld3.json");
        if (!layout || typeof g.WebAssembly !== "object") {
          throw new Error("no language detector");
        }
        return g.fetch(WEX.extUrl("wex/cld3.wasm")).then(function (response) {
          return response.arrayBuffer();
        }).then(function (bytes) {
          return startCld3(bytes, layout);
        });
      });
      cld3Loading.catch(function (error) {
        log.warn("the language detector could not be loaded", error);
      });
    }
    return cld3Loading;
  }

  // Chrome's answer from CLD3's, for a text of up to `maxBytes`.
  function detectLanguages(text, maxBytes) {
    var sample = String(text == null ? "" : text);
    var loading = cld3();
    return loading.then(function (find) {
      // A detector that stopped partway is started afresh, for the texts
      // that were waiting for it too.
      if (cld3Loading !== loading) {
        return detectLanguages(sample, maxBytes);
      }
      var result;
      try {
        result = find(sample, CLD3_LANGUAGES, maxBytes || CLD3_TEXT_BYTES);
      } catch (e) {
        cld3Loading = null;
        log.warn("the language detector stopped", e);
        return NO_LANGUAGE;
      }
      var reliable = true;
      var languages = [];
      for (var i = 0; i < result.found.length; i++) {
        var entry = result.found[i];
        if (entry.language === "und") {
          break;
        }
        if (/-latn$/i.test(entry.language)) {
          continue;
        }
        reliable = reliable && entry.reliable && result.bytes >= CLD3_RELIABLE_BYTES;
        languages.push({ language: entry.language, percentage: Math.floor(Math.fround(100 * entry.proportion)) });
      }
      return { isReliable: reliable && languages.length > 0, languages: languages };
    }, function () {
      return NO_LANGUAGE;
    });
  }

  WEX.setLanguageDetector(function (text) {
    return detectLanguages(text);
  });

  native.runtime.onMessage.addListener(function (message, sender) {
    if (!WEX.isInternal(message)) {
      return undefined;
    }
    switch (message.__wex) {
      case "rpc":
        return answerCall(message, sender);
      case "test":
        return WEX.testRecord && message.entry ?
          WEX.testRecord(message.entry, sender && sender.url || "?") : undefined;
      case "pageMessage":
        return deliverPageMessage(message.message,
          message.site === undefined ? sender : framedSender(message.site, sender));
      case "css":
        return insertDeclaredSheets(message.files, sender);
      case "openPageForSite":
        openPageForSite(message, sender);
        break;
      case "documentIds":
        return Promise.resolve(WEX.documentIdsKnown());
      case "styles":
        insertRefusedStyles(message, sender);
        break;
      case "navigated":
        reportSameDocumentNavigation(message, sender);
        break;
      case "declarativeCss":
        reportedSelectors(message, sender);
        break;
      case "runtimePage":
        return runtimePageShown(message, sender);
      case "extensionOrigins":
        return Promise.resolve(WEX.learnExtensionOrigins({}));
      case "detectLanguage":
        return detectLanguages(message.text);
      case "command":
        runCommand(String(message.name), sender);
        break;
      case "rulesChanged":
        refreshResponseRules();
        break;
    }
    return undefined;
  });

  // Another extension asking which extension this is, and whether it is
  // running: the converter, to show a store page's extension as installed,
  // and other converted extensions, for the origin of this one's pages.
  if (native.runtime.onMessageExternal) {
    native.runtime.onMessageExternal.addListener(function (message, sender, sendResponse) {
      if (WEX.isInternal(message) && message.__wex === "identify") {
        sendResponse({ id: CONFIG.extensionId, name: CONFIG.name, version: CONFIG.version,
          runtimeId: WEX.runtimeId, origin: WEX.chromeExtensionOrigin(WEX.runtimeId) });
      }
      return undefined;
    });
  }

  // The converted extensions whose Chrome ids the extension's scripts name,
  // asked which origin their pages have now, so that an address the
  // extension builds from one of those ids leads to that extension. Pages
  // read what is known from local storage, and content scripts ask for it.
  // An id asked for that is not known yet is asked about again, at most every
  // ten seconds, as the extension may have been installed since.
  var EXTENSION_ORIGINS_KEY = "wex.extensionOrigins";
  var askedOrigins = {};

  function askExtensionOrigin(id) {
    if ((CONFIG.otherExtensionIds || []).indexOf(id) < 0 ||
        Date.now() - (askedOrigins[id] || 0) < 10000) {
      return;
    }
    askedOrigins[id] = Date.now();
    Promise.resolve().then(function () {
      return native.runtime.sendMessage(WEX.bundleIdFor(id), { __wex: "identify" });
    }).then(function (reply) {
      if (reply && reply.runtimeId === id && typeof reply.origin === "string") {
        var learned = {};
        learned[id] = reply.origin;
        var table = WEX.learnExtensionOrigins(learned);
        try {
          WEX.localStorageOf(g).setItem(EXTENSION_ORIGINS_KEY, JSON.stringify(table));
        } catch (e) { /* pages ask again */ }
      }
    }, function () { /* not installed, or not running */ });
  }

  WEX.learnExtensionOrigins({}, askExtensionOrigin);
  (CONFIG.otherExtensionIds || []).forEach(askExtensionOrigin);

  var debugPorts = [];

  native.runtime.onConnect.addListener(function (port) {
    if (port.name === WEX.INTERNAL_PORT + "events") {
      serveEvents(port);
      return;
    }
    if (port.name.indexOf(WEX.INTERNAL_PORT + "page:") === 0) {
      connectPage(port, port.sender, port.name.slice((WEX.INTERNAL_PORT + "page:").length));
      return;
    }
    if (port.name.indexOf(WEX.INTERNAL_PORT + "framed:") === 0) {
      var framed;
      try {
        framed = JSON.parse(port.name.slice((WEX.INTERNAL_PORT + "framed:").length));
      } catch (e) {
        framed = null;
      }
      framed = Array.isArray(framed) ? framed : [];
      connectPage(port, framedSender(framed[0], port.sender), String(framed[1]));
      return;
    }
    if (port.name === WEX.INTERNAL_PORT + "save") {
      receiveSave(port);
      return;
    }
    if (port.name === WEX.INTERNAL_PORT + "debug") {
      if (!CONFIG.debug) {
        port.disconnect();
        return;
      }
      debugPorts.push(port);
      port.onMessage.addListener(function (m) {
        runDebugCommand(String(m && m.command || ""));
      });
      port.onDisconnect.addListener(function () {
        var i = debugPorts.indexOf(port);
        if (i >= 0) {
          debugPorts.splice(i, 1);
        }
      });
      return;
    }
    // A port nobody here listens for is refused, as it would be if the
    // runtime had no listener of its own.
    if (!WEX.isInternalPort(port) && !chrome.runtime.onConnect.hasListeners()) {
      port.disconnect();
    }
  });

  // ------------------------------------------------------------------ //
  // Tab state
  // ------------------------------------------------------------------ //
  function forgetTabState(id) {
    delete tabBadges[id];
    delete badgeColors.background[id];
    delete badgeColors.text[id];
    delete tabActionEnabled[id];
    delete declaredShown[id];
    delete tabTitles[id];
    delete tabIcons[id];
    delete tabPopups[id];
    delete pendingMenuInfo[id];
  }

  // A closed tab's state, with what was kept for its Safari tab.
  function forgetClosedTab(id, tab) {
    delete announcedTabs[id];
    forgetTabState(id);
    delete panelTabs[id];
    if (tab) {
      openers.delete(tab);
      pendingUrls.delete(tab);
      navigationSources.delete(tab);
    }
  }

  // Resolves with whether the page `id` is one the extension does not see:
  // a page of the runtime's tabs, once those being opened have theirs, or
  // the empty tab of a window of hidden tabs.
  var runtimeTabsOpening = [];

  function unseen(id) {
    return !!(runtimeTabIds[id] || placeholderIds[id]);
  }

  function unseenPage(id) {
    if (unseen(id)) {
      return Promise.resolve(true);
    }
    return Promise.all(runtimeTabsOpening).catch(function () {}).then(function () {
      var waits = [];
      app.browserWindows.forEach(function (w) {
        if (w.visible === false && w.tabs[0]) {
          waits.push(Promise.resolve().then(function () {
            return native.tabs.get(w.tabs[0]);
          }).then(function (info) {
            if (info && typeof info.id === "number") {
              placeholderIds[info.id] = true;
            }
          }, function () {}));
        }
      });
      return Promise.all(waits);
    }).then(function () {
      return unseen(id);
    });
  }

  // Opens a page of the runtime's in a hidden tab, with `token` as its
  // query, and resolves with the tab's id once the page has said which it is.
  // Hiding a tab moves it to another window, and WebKit swaps in a new page
  // for an extension's, so the tab is known by the id of each page it shows.
  var RUNTIME_PAGE_TIMEOUT = 15000;
  var runtimePageWaiters = {};

  function runtimePageShown(message, sender) {
    var id = sender && sender.tab && sender.tab.id;
    if (typeof id === "number") {
      runtimeTabIds[id] = true;
    }
    var waiter = runtimePageWaiters[message.token];
    if (waiter) {
      delete runtimePageWaiters[message.token];
      waiter(id);
    }
    return Promise.resolve(true);
  }

  // A new tab a site's link to the extension's address asks for, where the
  // manifest lets that site open the page. It opens beside the site's tab.
  function openPageForSite(message, sender) {
    var tab = sender && sender.tab;
    var own = tab && WEX.pageFromWeb(message.url, sender.url);
    if (!own) {
      return;
    }
    var opening = { url: own };
    if (tab.windowId !== undefined) {
      opening.windowId = tab.windowId;
    }
    if (typeof tab.index === "number") {
      opening.index = tab.index + 1;
    }
    Promise.resolve(chrome.tabs.create(opening)).catch(function (e) {
      log.warn("could not open " + own, e);
    });
  }

  // A window opened only to hold a runtime tab, there being none to put it in,
  // closes with the last such tab, unless something has been opened in it.
  var runtimeWindows = [];
  var runtimeTabsInUse = 0;

  function closeRuntimeWindows() {
    if (runtimeTabsInUse > 0) {
      return;
    }
    runtimeWindows.splice(0).forEach(function (w) {
      try {
        var blank = w.tabs.every(function (t) {
          return !t.url || t.url === "about:blank";
        });
        if (blank) {
          w.close();
        }
      } catch (e) { /* already closed */ }
    });
  }

  function openRuntimeTab(path, token) {
    var w = app.activeBrowserWindow || shownWindows()[0];
    if (!w) {
      w = app.openBrowserWindow();
      runtimeWindows.push(w);
    }
    runtimeTabsInUse += 1;
    var tab = w.openTab("background");
    runtimeTabs.add(tab);
    var firstId = null;
    var opening = pageOf(tab).then(function (id) {
      firstId = id;
      runtimeTabIds[id] = true;
      return Promise.resolve(native.tabs.hide ? native.tabs.hide([id]) : null).catch(function () {});
    }).then(function () {
      return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () {
          delete runtimePageWaiters[token];
          reject(new Error("the runtime's page did not load"));
        }, RUNTIME_PAGE_TIMEOUT);
        runtimePageWaiters[token] = function (id) {
          clearTimeout(timer);
          resolve(typeof id === "number" ? id : firstId);
        };
        native.tabs.update(firstId, { url: WEX.extUrl(path) + "?" + token }).catch(function (error) {
          clearTimeout(timer);
          delete runtimePageWaiters[token];
          reject(error);
        });
      });
    });
    runtimeTabsOpening.push(opening);
    function opened() {
      runtimeTabs.delete(tab);
      runtimeTabsOpening.splice(runtimeTabsOpening.indexOf(opening), 1);
    }
    opening.then(opened, opened);
    return opening.catch(function (error) {
      if (firstId !== null) {
        closeRuntimeTab(firstId);
      } else {
        try {
          tab.close();
        } catch (e) { /* already closed */ }
        runtimeTabsInUse = Math.max(0, runtimeTabsInUse - 1);
        closeRuntimeWindows();
      }
      throw error;
    });
  }

  function closeRuntimeTab(id) {
    return Promise.resolve(native.tabs.remove(id)).catch(function () {}).then(function () {
      runtimeTabsInUse = Math.max(0, runtimeTabsInUse - 1);
      closeRuntimeWindows();
    });
  }

  // A tab's events go to the extension in the order they happen, and telling
  // of one can wait: on Safari's announcement of a new tab, or on the
  // runtime's tabs. While one waits, those after it queue here behind it.
  // TAB_EVENT_WAIT limits how long one holds up the rest.
  var TAB_EVENT_WAIT = 5000;
  var tabEventQueues = {};

  function queueTabEvent(id, fn) {
    var tail = (tabEventQueues[id] || Promise.resolve()).then(function () {
      return new Promise(function (resolve) {
        var timer = setTimeout(resolve, TAB_EVENT_WAIT);
        function next() {
          clearTimeout(timer);
          resolve();
        }
        Promise.resolve().then(fn).then(next, function (error) {
          log.warn("a tab event could not be told", error);
          next();
        });
      });
    });
    tabEventQueues[id] = tail;
    tail.then(function () {
      if (tabEventQueues[id] === tail) {
        delete tabEventQueues[id];
      }
    });
  }

  // A tab is told of as created before it is told of as active, though Safari
  // activates a new tab before the engine reports it. Activation waits for that
  // report on a tab Safari has just opened.
  var ANNOUNCEMENT_WAIT = 500;
  var openingTabs = new WeakSet();
  var announcedTabs = {};
  var announcementWaiters = {};

  function tabAnnounced(id) {
    announcedTabs[id] = true;
    (announcementWaiters[id] || []).forEach(function (resume) {
      resume();
    });
    delete announcementWaiters[id];
  }

  function whenAnnounced(t, id) {
    if (!openingTabs.has(t) || announcedTabs[id]) {
      return Promise.resolve();
    }
    return new Promise(function (resolve) {
      var timer = setTimeout(resolve, ANNOUNCEMENT_WAIT);
      (announcementWaiters[id] = announcementWaiters[id] || []).push(function () {
        clearTimeout(timer);
        resolve();
      });
    }).then(function () {
      openingTabs.delete(t);
    });
  }

  native.tabs.onCreated.addListener(function (tab) {
    engineTabs[tab.id] = tab;
    // Safari's own announcement of the tab may be a moment behind.
    queueTabEvent(tab.id, function () {
      return new Promise(function (resolve) {
        setTimeout(resolve, 0);
      }).then(identifyAll).then(function () {
        return unseenPage(tab.id);
      }).then(function (hidden) {
        if (!hidden) {
          tabsOnCreated.emit(describeEngineTab(engineTabs[tab.id] || tab));
        }
      }).then(function () {
        tabAnnounced(tab.id);
      }, function (error) {
        tabAnnounced(tab.id);
        throw error;
      });
    });
  });

  native.tabs.onUpdated.addListener(function (id, changeInfo, tab) {
    engineTabs[id] = tab;
    if (changeInfo && changeInfo.status) {
      tabStatus[id] = changeInfo.status;
    }
    if (changeInfo && changeInfo.status === "complete") {
      pendingUrlReached(id, tab && tab.url);
    }
    // A grouped tab's address is kept with its group.
    if (changeInfo && (changeInfo.url || changeInfo.status === "complete") && tabGroupState.members[id] != null) {
      saveTabGroups();
    }
    if (!tabEventQueues[id] && !runtimeTabsOpening.length && !unseen(id) && safariTabById.has(id)) {
      tabsOnUpdated.emit(id, changeInfo, describeEngineTab(tab));
      return;
    }
    queueTabEvent(id, function () {
      return unseenPage(id).then(function (hidden) {
        if (!hidden) {
          tabsOnUpdated.emit(id, changeInfo, describeEngineTab(tab));
        }
      });
    });
  });

  // A page WebKit closes while its Safari tab stays open has been replaced
  // by another, which the tab now shows.
  native.tabs.onRemoved.addListener(function (id, removeInfo) {
    if (tabEventQueues[id]) {
      queueTabEvent(id, function () {
        return tabRemoved(id, removeInfo);
      });
    } else {
      tabRemoved(id, removeInfo);
    }
  });

  function tabRemoved(id, removeInfo) {
    if (unseen(id)) {
      unbindTab(id);
      delete engineTabs[id];
      delete tabStatus[id];
      return undefined;
    }
    var tab = safariTabById.get(id);
    var replacement = tab && tab.browserWindow ? lookUp(tab) : Promise.resolve(undefined);
    return replacement.then(function (newId) {
      if (newId !== undefined && newId !== id) {
        delete engineTabs[id];
        delete tabStatus[id];
        forgetTabState(id);
        return;
      }
      recordClosedTab(describeEngineTab(engineTabs[id]), removeInfo || {});
      var grouped = groupIdOf(id) !== -1;
      delete tabGroupState.members[id];
      unbindTab(id);
      if (grouped) {
        dropEmptyGroups();
        saveTabGroups();
      }
      delete engineTabs[id];
      delete tabStatus[id];
      forgetClosedTab(id, tab);
      tabsOnRemoved.emit(id, removeInfo);
    });
  }

  if (uncheckedGroupMembers) {
    identifyAll().then(checkKeptGroups, checkKeptGroups);
  }
  identifyAll().then(refreshToolbar);

  // Chrome drops what was set for a tab when the tab shows another document.
  native.webNavigation.onCommitted.addListener(function (details) {
    if (details.frameId === 0) {
      pendingUrlReached(details.tabId, details.url);
      forgetTabState(details.tabId);
      // A new document's rules apply once what was set for the tab has gone.
      applyDeclarativeRules(details.tabId);
    }
  });

  // Application events must be registered with useCapture: `activate` and
  // `deactivate` are dispatched non-bubbling, so a bubble-phase listener on
  // the application never sees them.
  // ------------------------------------------------------------------ //
  // Signing in through a web page
  // ------------------------------------------------------------------ //
  // identity.getRedirectURL's address (WEX.identityRedirectURL).
  function identityRedirectURL(path) {
    return WEX.identityRedirectURL(path);
  }

  // identity.launchWebAuthFlow. The provider's page opens in a tab, and the
  // flow ends with the address of the first load in that tab that goes to
  // the redirect address's host, which the provider sends the tab to once
  // the user has signed in; that host serves nothing, and the tab closes.
  // Chrome shows the page in a window of its own. A flow that may not ask
  // the user anything runs in a hidden tab, and fails when its page has
  // loaded without sending it on, as Chrome's does; closing the tab fails
  // the flow as the user turning it down.
  var NON_INTERACTIVE_GRACE = 1000;
  var NON_INTERACTIVE_TIMEOUT = 60000;

  // Safari has no signed-in browser profile, so Chrome's sign-in is as it
  // is with no one signed in. Firefox's identity has no more than the
  // redirect address and the web flow.
  function makeIdentity() {
    var identity = {
      getRedirectURL: function (path) {
        return identityRedirectURL(path);
      },
      launchWebAuthFlow: launchWebAuthFlow
    };
    if (!CONFIG.firefoxBuild) {
      identity.onSignInChanged = new Event("identity.onSignInChanged");
      identity.getAuthToken = function (details, cb) {
        return WEX.fail(WEX.shiftCallback(details, cb).cb, "The user is not signed in.");
      };
      identity.getProfileUserInfo = function (details, cb) {
        return done(WEX.shiftCallback(details, cb).cb, { email: "", id: "" });
      };
      identity.removeCachedAuthToken = function (details, cb) {
        return done(cb);
      };
      identity.clearAllCachedAuthTokens = function (cb) {
        return done(cb);
      };
    }
    return identity;
  }

  function launchWebAuthFlow(details, cb) {
    var d = details || {};
    if (!d.url) {
      return WEX.fail(cb, "The url is missing.");
    }
    var redirectHost;
    try {
      redirectHost = new URL(identityRedirectURL()).host;
    } catch (e) {
      return WEX.fail(cb, "The redirect address cannot be told.");
    }
    var interactive = !!d.interactive;
    var w = app.activeBrowserWindow || app.openBrowserWindow();
    var t = w.openTab(interactive ? "foreground" : "background");
    return settle(new Promise(function (resolve, reject) {
      var finished = false;
      var hiding = false;
      var poll = null;
      var timer = null;
      function isRedirect(url) {
        try {
          return new URL(String(url)).host === redirectHost;
        } catch (e) {
          return false;
        }
      }
      function finish(error, url) {
        if (finished) {
          return;
        }
        finished = true;
        clearInterval(poll);
        clearTimeout(timer);
        app.removeEventListener("beforeNavigate", beforeNavigate, true);
        app.removeEventListener("navigate", navigated, true);
        app.removeEventListener("close", closed, true);
        native.webNavigation.onErrorOccurred.removeListener(navigationFailed);
        try {
          t.close();
        } catch (e) { /* already closed */ }
        if (error) {
          reject(new Error(error));
        } else {
          resolve(url);
        }
      }
      function check(url) {
        if (!finished && isRedirect(url)) {
          finish(null, String(url));
          return true;
        }
        return false;
      }
      function beforeNavigate(e) {
        if (e.target === t && check(e.url)) {
          try {
            e.preventDefault();
          } catch (err) { /* the tab closes anyway */ }
        }
      }
      // A redirect the server makes is seen when the load of the redirect
      // host fails, or when the tab shows its address.
      function navigationFailed(info) {
        if (info && info.frameId === 0 && info.tabId === idForTab(t)) {
          check(info.url);
        }
      }
      function navigated(e) {
        if (e.target !== t || check(t.url) || interactive || d.abortOnLoadForNonInteractive === false) {
          return;
        }
        setTimeout(function () {
          if (!check(t.url)) {
            finish("User interaction required.");
          }
        }, NON_INTERACTIVE_GRACE);
      }
      // Hiding the tab moves it, and a tab closes in the window it leaves.
      function closed(e) {
        if (e.target === t && !hiding) {
          whenClosedForGood(t, function () {
            finish("The user did not approve access.");
          });
        }
      }
      app.addEventListener("beforeNavigate", beforeNavigate, true);
      app.addEventListener("navigate", navigated, true);
      app.addEventListener("close", closed, true);
      native.webNavigation.onErrorOccurred.addListener(navigationFailed);
      poll = setInterval(function () {
        try {
          check(t.url);
        } catch (e) { /* the tab is closing */ }
      }, 250);
      if (!interactive) {
        timer = setTimeout(function () {
          finish("User interaction required.");
        }, d.timeoutMsForNonInteractive || NON_INTERACTIVE_TIMEOUT);
        identify(t).then(function (id) {
          if (safariTabById.get(id) === t && native.tabs.hide) {
            hiding = true;
            return native.tabs.hide([id]);
          }
          return undefined;
        }).catch(function () { /* a background tab serves */ }).then(function () {
          hiding = false;
        });
      }
      navigateTab(t, String(d.url)).catch(function (error) {
        finish(error && error.message ? error.message : String(error));
      });
    }), cb);
  }

  // A tab moved to another window closes in the one it leaves and opens in
  // the other, so `fn` runs for a tab that closes unless it opens again in
  // TAB_MOVE_WAIT.
  var TAB_MOVE_WAIT = 10;
  var closingTabs = new Map();

  function whenClosedForGood(tab, fn) {
    var waiting = closingTabs.get(tab);
    if (waiting) {
      waiting.push(fn);
      return;
    }
    waiting = [fn];
    closingTabs.set(tab, waiting);
    setTimeout(function () {
      if (closingTabs.get(tab) === waiting) {
        closingTabs.delete(tab);
        waiting.forEach(function (run) {
          run();
        });
      }
    }, TAB_MOVE_WAIT);
  }

  function onAppEvent(name, fn) {
    try {
      app.addEventListener(name, fn, true);
    } catch (e) {
      log.warn("could not listen for the " + name + " application event", e);
    }
  }

  var lastActiveTabId = null;
  var lastWindowId = null;

  // A tab still being looked up when another is activated tells of nothing:
  // the extension goes by the last one.
  var activations = 0;

  function emitActivation(t) {
    if (!t || !t.browserWindow) {
      return;
    }
    var activation = ++activations;
    identify(t).then(function (id) {
      return whenAnnounced(t, id).then(function () {
        if (activation === activations) {
          activated(t, id);
        }
      });
    });
  }

  function activated(t, id) {
    var wid = windowIdFor(t.browserWindow);
    if (wid !== lastWindowId) {
      lastWindowId = wid;
      windowsOnFocusChanged.emit(wid);
    }
    if (id === lastActiveTabId) {
      return;
    }
    lastActiveTabId = id;
    tabsOnActivated.emit({ tabId: id, windowId: wid });
    tabsOnSelectionChanged.emit(id, { windowId: wid });
    tabsOnActiveChanged.emit(id, { windowId: wid });
    tabsOnHighlightChanged.emit({ windowId: wid, tabIds: [id] });
  }

  onAppEvent("activate", function (e) {
    if (isSafariWindow(e.target)) {
      noteShownTab(e.target.activeTab);
      emitActivation(e.target.activeTab);
    } else if (isSafariTab(e.target)) {
      noteShownTab(e.target);
      emitActivation(e.target);
    }
    refreshToolbar();
  });

  onAppEvent("validate", refreshToolbar);

  // A browser opens an extension's popup as a new document each time, on
  // the popup page, and popups are written to describe the tab they open
  // over. Safari loads a popover once and keeps it, so just before it shows,
  // the popover is reloaded, or taken back to the popup page if a link moved
  // it elsewhere.
  onAppEvent("popover", function (e) {
    var po = e.target || popoverEl();
    if (po && po.identifier === WEX.SIDE_PANEL_POPOVER) {
      var w = app.activeBrowserWindow;
      var shownTab = w && w.activeTab;
      var panel = panelFor(shownTab ? idForTab(shownTab) : null);
      // Chrome's side panel stays open while the user goes on with the page,
      // and Safari hides a popover at the first click elsewhere, so the
      // panel's page is kept as it is unless the tab has another panel.
      try {
        var panelPage = po.contentWindow;
        if (panelPage && panelPage.location && panel.path &&
            !onPanelPage(panelPage.location.href, WEX.extUrl(panel.path))) {
          panelPage.location.replace(WEX.extUrl(panel.path));
        }
      } catch (err) { /* the popover can be closing */ }
      panelShown(po, w);
      watchPageUnderPopover(w, true);
      return;
    }
    try {
      var page = po && po.contentWindow;
      if (!page || !page.location) {
        return;
      }
      var shown = app.activeBrowserWindow && app.activeBrowserWindow.activeTab;
      var path = popupFor(shown ? idForTab(shown) : null);
      var popup = path ? WEX.extUrl(path) : null;
      note("popover about to show (visible: " + !!po.visible + "), with " + (popup || "no popup"));
      if (popup && String(page.location.href).split("#")[0] !== popup.split("#")[0]) {
        page.location.replace(popup);
      } else {
        page.location.reload();
      }
      watchPopupClose(po);
      watchPageUnderPopover(app.activeBrowserWindow, false);
    } catch (err) { /* the popover can be closing */ }
  });

  // An extension that names a page for new tabs (chrome_url_overrides) has a
  // new tab, which would show Safari's Top Sites, show that page instead.
  // Safari announces the navigation with no address, and gives the tab an
  // empty address. It announces with no address as well a navigation to a
  // page the extension may not see, whose tab's address it withholds, and an
  // extension archive opened over a page, so only an empty tab goes to the
  // extension's page.
  var newTabPage = ((CONFIG.manifest || {}).chrome_url_overrides || {}).newtab;
  if (newTabPage) {
    onAppEvent("beforeNavigate", function (e) {
      if (e.url || !isSafariTab(e.target) || e.target.url !== "") {
        return;
      }
      try {
        e.preventDefault();
      } catch (err) { /* Safari shows its page until the extension's loads */ }
      navigateTab(e.target, WEX.extUrl(String(newTabPage).replace(/^\/+/, "")), true)
        .catch(function (error) {
          note("could not open the new-tab page: " + (error && error.message ? error.message : error));
        });
    });
  }

  // A tab the web sends to the extension's address, as the browser it was
  // made for gives it (the callback of a sign-in, by a script or a refresh,
  // or a link), goes to the extension's page instead, before it goes
  // anywhere; one that ends up on Safari's page for an address it cannot
  // open goes there then. A tab going to the web with the extension's own
  // address in its address takes it as the web knows it
  // (WEX.webFacingText): a link, a script or a form of the extension's.
  eachSafariTab(function (t) {
    tabOrigins.set(t, null);
  });
  noteShownTab(activeTab());

  onAppEvent("beforeNavigate", function (e) {
    if (!isSafariTab(e.target)) {
      return;
    }
    noteNewTab(e.target);
    // Top Sites, announced with no address. A web page's tab going there has
    // left that page; an empty tab stays what it counted as opened by.
    if (!e.url) {
      var origin = tabOrigins.get(e.target);
      if (isWebAddress(e.target.url)) {
        origin = null;
        tabOrigins.set(e.target, null);
      }
      navigationSources.set(e.target, origin ? origin.from : "");
      return;
    }
    var url = String(e.url);
    var from = navigationSource(e.target);
    var toOwn = !!ownPageFor(url);
    navigationSources.set(e.target, toOwn ? from : url);
    // An empty tab sent to the web, which it still is until the page arrives,
    // and a web page's tab sent to an empty page, count as opened by that page.
    if (/^safari-extension:/i.test(url)) {
      tabOrigins.set(e.target, null);
    } else if (!toOwn && NOT_THE_WEB.test(url)) {
      if (isWebAddress(from)) {
        tabOrigins.set(e.target, { from: from });
      }
    } else if (!toOwn && !isWebAddress(e.target.url)) {
      tabOrigins.set(e.target, { from: url });
    }
    var next = pageForTabAt(url, from) || (/^https?:/i.test(url) ? WEX.webFacingText(url) : url);
    if (next === url) {
      return;
    }
    try {
      e.preventDefault();
    } catch (err) { /* the tab is sent on below */ }
    navigateTab(e.target, next).catch(function (error) {
      note("could not send a tab on to " + next + ": " + (error && error.message ? error.message : error));
    });
  });

  onAppEvent("navigate", function (e) {
    var t = e.target;
    var own = isSafariTab(t) && ownPageFor(t.url) ?
      pageForTabAt(t.url, navigationSources.get(t)) : null;
    if (own) {
      navigateTab(t, own).catch(function () { /* the tab stays where it is */ });
    }
  });

  onAppEvent("open", function (e) {
    if (isSafariWindow(e.target) && e.target.visible !== false) {
      windowsOnCreated.emit(windowInfo(e.target, false));
    } else if (isSafariTab(e.target)) {
      closingTabs.delete(e.target);
      noteNewTab(e.target);
      openingTabs.add(e.target);
      lookUp(e.target).then(refreshToolbar);
    }
  });

  onAppEvent("close", function (e) {
    var target = e.target;
    if (isSafariWindow(target)) {
      var wid = windowIds.get(target);
      if (wid !== undefined) {
        windowIds.delete(target);
        windowById.delete(wid);
        windowsOnRemoved.emit(wid);
      }
    } else if (isSafariTab(target) && runtimeTabs.has(target)) {
      return;
    } else if (isSafariTab(target) && provisionalIds.has(target)) {
      // The engine reports the closing of the tabs it has an id for.
      whenClosedForGood(target, function () {
        var id = provisionalIds.get(target);
        if (id !== undefined) {
          provisionalIds.delete(target);
          forgetClosedTab(id, target);
          tabsOnRemoved.emit(id, { windowId: -1, isWindowClosing: false });
        }
      });
    }
  });

  // ------------------------------------------------------------------ //
  // Recently closed tabs and windows
  // ------------------------------------------------------------------ //
  // What sessions.getRecentlyClosed lists: the tabs and windows closed while
  // the extension runs, most recent first. Restoring one opens its pages
  // again, in a tab or a window of their own; Safari keeps no history for
  // the extension to put back.
  function restorableUrl(url) {
    return /^(https?|file|ftp):/i.test(String(url || ""));
  }

  function rememberClosed(entry) {
    closedSessions.unshift(entry);
    closedSessions.length = Math.min(closedSessions.length, MAX_SESSION_RESULTS);
    sessionsOnChanged.emit();
  }

  function recordClosedTab(tab, removeInfo) {
    if (!tab || !restorableUrl(tab.url)) {
      return;
    }
    var closed = { url: tab.url, title: tab.title, favIconUrl: tab.favIconUrl, index: tab.index,
      windowId: removeInfo.windowId, sessionId: String(nextSessionId++) };
    if (removeInfo.isWindowClosing) {
      var group = closingWindows[removeInfo.windowId];
      if (!group) {
        group = closingWindows[removeInfo.windowId] = [];
        setTimeout(function () {
          delete closingWindows[removeInfo.windowId];
          rememberClosed({ lastModified: Math.floor(Date.now() / 1000), window: {
            id: removeInfo.windowId, sessionId: String(nextSessionId++), tabs: group,
            focused: false, incognito: false, alwaysOnTop: false
          } });
        }, 500);
      }
      group.push(closed);
      return;
    }
    rememberClosed({ lastModified: Math.floor(Date.now() / 1000), tab: closed });
  }

  function makeSessions(tabs, windows) {
    var tabValues = {};
    var windowValues = {};
    function valueStore(store) {
      return {
        set: function (id, key, value, cb) {
          (store[id] = store[id] || {})[key] = value;
          return done(cb);
        },
        get: function (id, key, cb) {
          return done(cb, store[id] ? store[id][key] : undefined);
        },
        remove: function (id, key, cb) {
          if (store[id]) {
            delete store[id][key];
          }
          return done(cb);
        }
      };
    }
    var sessions = {
      MAX_SESSION_RESULTS: MAX_SESSION_RESULTS,
      onChanged: sessionsOnChanged,
      getRecentlyClosed: function (filter, cb) {
        var c = WEX.shiftCallback(filter, cb);
        var max = typeof c.opts.maxResults === "number" ? c.opts.maxResults : MAX_SESSION_RESULTS;
        return done(c.cb, JSON.parse(JSON.stringify(closedSessions.slice(0, max))));
      },
      getDevices: function (filter, cb) {
        return done(WEX.shiftCallback(filter, cb).cb, []);
      },
      restore: function (sessionId, cb) {
        if (typeof sessionId === "function") {
          cb = sessionId;
          sessionId = undefined;
        }
        var index = -1;
        closedSessions.some(function (entry, i) {
          var id = (entry.tab || entry.window).sessionId;
          if (sessionId == null || id === String(sessionId)) {
            index = i;
            return true;
          }
          return false;
        });
        if (index < 0) {
          return WEX.fail(cb, sessionId == null ? "There are no recently closed sessions." :
            "Invalid session id: \"" + sessionId + "\".");
        }
        var entry = closedSessions.splice(index, 1)[0];
        sessionsOnChanged.emit();
        var opened = entry.tab ?
          tabs.create({ url: entry.tab.url }).then(function (tab) {
            return { lastModified: Math.floor(Date.now() / 1000), tab: tab };
          }) :
          windows.create({ url: entry.window.tabs.map(function (t) { return t.url; }) }).then(function (w) {
            return { lastModified: Math.floor(Date.now() / 1000), window: w };
          });
        return settle(opened, cb);
      }
    };
    if (CONFIG.firefoxBuild) {
      var forget = function (id, cb) {
        closedSessions = closedSessions.filter(function (entry) {
          return (entry.tab || entry.window).sessionId !== String(id);
        });
        sessionsOnChanged.emit();
        return done(cb);
      };
      var tabStore = valueStore(tabValues);
      var windowStore = valueStore(windowValues);
      sessions.forgetClosedTab = function (windowId, sessionId, cb) {
        return forget(sessionId, cb);
      };
      sessions.forgetClosedWindow = forget;
      sessions.setTabValue = tabStore.set;
      sessions.getTabValue = tabStore.get;
      sessions.removeTabValue = tabStore.remove;
      sessions.setWindowValue = windowStore.set;
      sessions.getWindowValue = windowStore.get;
      sessions.removeWindowValue = windowStore.remove;
    }
    return sessions;
  }

  // ------------------------------------------------------------------ //
  // Toolbar clicks and menus
  // ------------------------------------------------------------------ //
  function reportToolbarClick(item) {
    var win = item && item.browserWindow;
    var tab = win && win.activeTab || activeTab();
    note("toolbar click: reporting action.onClicked to " +
      actionOnClicked.listeners.length + " listener(s)");
    actionOnClicked.emit(tabInfo(tab));
  }

  // A radio item clicked is checked, and the others of its group, the run of
  // radio items among its siblings, are not.
  function checkRadioItem(item) {
    var siblings = Object.keys(menuItems).map(function (key) {
      return menuItems[key];
    }).filter(function (other) {
      return other.parentId === item.parentId;
    });
    var at = siblings.indexOf(item);
    for (var i = at - 1; i >= 0 && siblings[i].type === "radio"; i--) {
      siblings[i].checked = false;
    }
    for (var j = at + 1; j < siblings.length && siblings[j].type === "radio"; j++) {
      siblings[j].checked = false;
    }
    item.checked = true;
  }

  onAppEvent("command", function (e) {
    var command = String(e.command);
    if (command === CONFIG.actionCommand) {
      // Safari cannot clear a command by assigning null, so an action that
      // began command-only and has a popup (or side panel) since is shown
      // from the command.
      if (!showToolbarPopover(e.target)) {
        reportToolbarClick(e.target);
      }
      return;
    }
    if (command.indexOf(MENU_COMMAND) !== 0) {
      return;
    }
    var item = menuItemForCommand(command);
    if (!item) {
      return;
    }
    var tab = activeTab();
    var tabId = tab ? idForTab(tab) : null;
    var info = e.userInfo || pendingMenuInfo[tabId] || {};
    delete pendingMenuInfo[tabId];
    var clickData = {
      menuItemId: item.id,
      parentMenuItemId: item.parentId,
      editable: !!info.editable,
      pageUrl: info.pageUrl || (tab ? tab.url : ""),
      frameUrl: info.frameUrl,
      frameId: info.frameId,
      selectionText: info.selectionText,
      linkUrl: info.linkUrl,
      srcUrl: info.srcUrl,
      mediaType: info.mediaType,
      wasChecked: !!item.checked,
      checked: item.type === "checkbox" ? !item.checked : item.type === "radio" ? true : undefined
    };
    if (item.type === "checkbox") {
      item.checked = !item.checked;
      saveMenus();
    } else if (item.type === "radio") {
      checkRadioItem(item);
      saveMenus();
    }
    if (typeof item.onclick === "function") {
      try {
        item.onclick(clickData, tabInfo(tab));
      } catch (err) {
        log.error("a context menu onclick handler threw", err);
      }
    }
    contextMenusOnClicked.emit(clickData, tabInfo(tab));
    refreshNativeActionMenus();
  });

  // Safari sends this immediately before a native extension menu is shown.
  // Rebuild it for that toolbar item's window, after giving the extension the
  // same opportunity Chrome gives contextMenus.onShown listeners to update it.
  onAppEvent("menu", function (e) {
    var entry = null;
    for (var i = 0; i < nativeActionMenus.length; i++) {
      if (nativeActionMenus[i].menu === e.target) {
        entry = nativeActionMenus[i];
        break;
      }
    }
    if (!entry) {
      return;
    }
    var win = entry.toolbarItem && entry.toolbarItem.browserWindow;
    var tab = win && win.activeTab;
    // What was right-clicked has nothing to do with this menu's items.
    if (tab) {
      delete pendingMenuInfo[idForTab(tab)];
    }
    contextMenusOnShown.emit({ contexts: ["action"], pageUrl: tab && tab.url }, tabInfo(tab));
    rebuildNativeActionMenu(entry);
  });

  // Safari's context menu takes no submenus from an extension, so an item
  // with children is not shown, nor are its children; each other top-level
  // item that applies to what was clicked is.
  onAppEvent("contextmenu", function (e) {
    var tab = activeTab();
    var info = e.userInfo || {};
    if (tab) {
      pendingMenuInfo[idForTab(tab)] = info;
    }
    Object.keys(menuItems).forEach(function (id) {
      var item = menuItems[id];
      if (item.parentId != null || !menuApplies(item, info)) {
        return;
      }
      var hasChildren = Object.keys(menuItems).some(function (other) {
        return menuItems[other].parentId === item.id;
      });
      if (hasChildren) {
        return;
      }
      try {
        e.contextMenu.appendContextMenuItem(MENU_COMMAND + id, withSelection(String(item.title || ""), info));
      } catch (err) { /* the menu may reject an item; keep going */ }
    });
  });

  // ------------------------------------------------------------------ //
  // Boot
  // ------------------------------------------------------------------ //
  // With debugging on, the global page publishes what it knows to every page
  // whose content bridge has asked for it, which writes it onto the document.
  // That channel works whether or not the toolbar button does.
  if (CONFIG.debug) {
    setInterval(function () {
      var current;
      try {
        current = state();
      } catch (e) {
        return;
      }
      debugPorts.slice().forEach(function (port) {
        try {
          port.postMessage({ state: current });
        } catch (e) { /* the page has gone */ }
      });
    }, 2000);
  }

  refreshToolbar();

  // The record of what the extension's tests run, in every context, for the
  // harness that runs them: it reads WEX.testLog, answers a
  // test.sendMessage with WEX.testReply(id, reply), and sends the extension a
  // test.onMessage with WEX.testSend(message).
  if (CONFIG.testApi) {
    var testReplies = {};
    var nextTestMessage = 1;
    WEX.testLog = [];
    var recordTest = function (entry, from) {
      entry.from = from;
      entry.at = Date.now();
      WEX.testLog.push(entry);
      if (entry.kind !== "message") {
        return undefined;
      }
      entry.id = nextTestMessage++;
      return new Promise(function (resolve) {
        testReplies[entry.id] = resolve;
      });
    };
    WEX.testReply = function (id, reply) {
      var resolve = testReplies[id];
      delete testReplies[id];
      if (resolve) {
        resolve(reply);
      }
      return !!resolve;
    };
    WEX.testSend = function (message) {
      chrome.test.onMessage.emit({ data: String(message), lastMessage: true });
    };
    WEX.testRecord = recordTest;
    chrome.test = WEX.makeTestApi(function (entry) {
      return recordTest(entry, "background");
    }, function () {
      return chrome.runtime.lastError;
    });
  }

  WEX.installApiChecks(chrome);
  g.chrome = chrome;
  g.browser = chrome;
  WEX.presentBrowser(g, true);
  WEX.pinRuntimeGlobals(g);

  // A popover can outlive a global-page reload, holding state from the
  // global page that went away. One on show is reloaded so it starts over
  // with this one; the popup's, hidden, goes back to its blank page.
  (ext.popovers || []).forEach(function (po) {
    try {
      var page = po.contentWindow;
      if (!page || !page.chrome || !page.chrome.__wex) {
        return;
      }
      if (po.identifier !== WEX.SIDE_PANEL_POPOVER && !po.visible) {
        page.location.replace(WEX.extUrl(WEX.POPUP_PLACEHOLDER));
      } else {
        page.location.reload();
      }
    } catch (e) { /* a popover can be closing while the global page boots */ }
  });

  // onInstalled/onStartup fire once the extension's background scripts have
  // run and registered their listeners, which for module scripts is when the
  // page has finished loading.
  function announceStart() {
    var key = "wex.installedVersion";
    var previous = null;
    try {
      previous = ext.settings ? ext.settings.getItem(key) : WEX.localStorageOf(g).getItem(key);
    } catch (e) { /* ignore */ }
    var version = manifest.version || CONFIG.version || "0";
    var reason = previous ? (previous === version ? null : "update") : "install";
    try {
      if (ext.settings) {
        ext.settings.setItem(key, version);
      } else {
        WEX.localStorageOf(g).setItem(key, version);
      }
    } catch (e) { /* ignore */ }
    if (reason) {
      runtimeOnInstalled.emit({
        reason: reason,
        previousVersion: previous || undefined,
        temporary: false
      });
    } else {
      runtimeOnStartup.emit();
    }
    runtimeOnExtensionLoaded.emit(reason === "update" ? { reason: reason, previousVersion: previous } :
      { reason: reason || "startup" });
    startAlarms();
    log.debug("global page ready (" + (reason || "no change") + ", version " + version + ")");
  }

  if (g.document && g.document.readyState !== "complete") {
    g.addEventListener("load", function () {
      setTimeout(announceStart, 300);
    });
  } else {
    setTimeout(announceStart, 300);
  }
})(this);
