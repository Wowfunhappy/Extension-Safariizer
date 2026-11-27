// The WebExtension API for injected content scripts, plus the machinery that
// decides which of the extension's content scripts belong on this page.
//
// Safari injects one flat list of scripts into every page the bundle's
// whitelist covers; the manifest's per-script match patterns have nowhere to
// go. So this file is what Safari injects, and it evaluates the extension's
// own content scripts itself, only where the manifest says they belong.
//
// Runs in the extension's isolated world, once per frame. Messaging is the
// engine's; storage lives on the global page and is reached through it.

var WEXContent = (function (g) {
  "use strict";

  // Safari also runs injected scripts on the extension's own pages, which have
  // their own bridge and must not get this one.
  if (g.location.protocol === "safari-extension:") {
    return null;
  }

  var CONFIG = WEX.CONFIG;
  var log = WEX.log;
  var native = WEX.native;

  if (!native) {
    log.error("this WebKit provides no `browser` namespace for extensions; " +
      "the extension's content scripts cannot run");
    return null;
  }

  var hostSafari = WEX.safari;
  var hostTab = hostSafari && hostSafari.self && hostSafari.self.tab;

  // The way back from the web: a site sends the browser to the extension's
  // address as the browser it was made for gives it, chrome-extension://<id>,
  // which Safari cannot open, as a sign-in's callback. A redirect is turned
  // around on its way (wex-network.js); a site's script, link or form, which
  // the Navigation API announces with where it goes, is cancelled, and a
  // refresh its page asks for is overtaken, and the frame goes to the
  // extension's page instead, where the manifest lets the site open it
  // (WEX.pageFromWeb). Where it does not, the navigation is cancelled, which
  // keeps macOS from asking for an application to open the address. A click
  // on a link to the address is announced as no navigation, so the click is
  // cancelled instead, and the frame goes to the page, or for a link that opens
  // a new tab, the global page opens it there.
  (function returnFromWeb() {
    var web = WEX.WEB_ORIGIN;
    if (!web || !/^https?:$/.test(g.location.protocol)) {
      return;
    }
    function ownPage(url) {
      return WEX.pageFromWeb(url, g.location.href);
    }
    function namesExtension(url) {
      return String(url || "").slice(0, web.length + 1).toLowerCase() === web.toLowerCase() + "/";
    }
    try {
      g.document.addEventListener("click", function (e) {
        var link = e.target && e.target.closest && e.target.closest("a[href], area[href]");
        if (!link || e.defaultPrevented || !namesExtension(link.href)) {
          return;
        }
        e.preventDefault();
        var own = ownPage(link.href);
        var target = String(link.getAttribute("target") || "").toLowerCase();
        if (!e.metaKey && (!target || target === "_self" || target === "_parent" || target === "_top")) {
          if (own) {
            go(own);
          }
        } else if (own && e.isTrusted) {
          tell("openPageForSite", { url: String(link.href) });
        }
      }, true);
    } catch (e) { /* such links fail as Safari fails them */ }
    var sent = false;
    function go(target) {
      if (sent) {
        return;
      }
      sent = true;
      try {
        g.location.replace(target);
      } catch (e) {
        sent = false;
      }
    }
    try {
      var navigation = g.navigation;
      if (navigation && typeof navigation.addEventListener === "function") {
        navigation.addEventListener("navigate", function (e) {
          var own = e.destination ? ownPage(e.destination.url) : null;
          if (!own) {
            if (e.destination && namesExtension(e.destination.url) && e.cancelable) {
              e.preventDefault();
            }
            return;
          }
          if (e.cancelable) {
            e.preventDefault();
          }
          go(own);
        });
      }
    } catch (e) { /* such navigations fail as Safari fails them */ }
    // What follows only matters to an extension a site can open a page of.
    if (!WEX.openingSites().length) {
      return;
    }
    // A site's window.open happens in the page's world, where a stand-in
    // (WEX.openStandIn, registered for that world by the global page) tells
    // this one of a call for the extension's address and gives the page a
    // window of its own to hold. The call opens the page only if the manifest
    // gives it to the site, and only on a gesture of the user's, which a page
    // cannot make up as it can the event.
    var opening = "wex-open:" + web;
    try {
      g.document.addEventListener(opening, function (e) {
        var url = String(e.detail || "");
        var activation = g.navigator.userActivation;
        if (namesExtension(url) && ownPage(url) && activation && activation.isActive) {
          tell("openPageForSite", { url: url });
        }
      }, true);
    } catch (e) { /* such a call fails as Safari fails it */ }
    function refreshTarget(node) {
      if (!node || node.nodeName !== "META" ||
          String(node.getAttribute("http-equiv") || "").toLowerCase() !== "refresh") {
        return null;
      }
      var m = /^\s*[\d.]*\s*[;,]?\s*(?:url\s*=\s*)?["']?([^"']*)/i.exec(node.getAttribute("content") || "");
      return m ? ownPage(m[1].trim()) : null;
    }
    function scan(root) {
      if (!root || !root.querySelectorAll && root.nodeName !== "META") {
        return;
      }
      var metas = root.nodeName === "META" ? [root] : root.querySelectorAll("meta[http-equiv]");
      for (var i = 0; i < metas.length; i++) {
        var own = refreshTarget(metas[i]);
        if (own) {
          go(own);
          return;
        }
      }
    }
    // A refresh is asked for in the head, which is watched as it is built:
    // the root's and the head's own children, and not the whole document,
    // whose every node would otherwise make a record as the page is parsed
    // (a large page loads a tenth slower so). A refresh in the body is found
    // once the document is parsed.
    try {
      scan(g.document);
      if (typeof g.MutationObserver === "function") {
        var watched = [];
        var observer = new g.MutationObserver(function (records) {
          for (var r = 0; r < records.length; r++) {
            var added = records[r].addedNodes;
            for (var n = 0; n < added.length; n++) {
              var node = added[n];
              if (node.nodeName === "HTML" || node.nodeName === "HEAD") {
                watch(node);
              }
              scan(node);
            }
          }
        });
        var watch = function (node) {
          if (node && watched.indexOf(node) < 0) {
            watched.push(node);
            observer.observe(node, { childList: true });
          }
        };
        watch(g.document);
        watch(g.document.documentElement);
        watch(g.document.head);
        g.document.addEventListener("DOMContentLoaded", function () {
          if (g.document.body) {
            scan(g.document.body);
          }
        });
      }
    } catch (e) { /* such refreshes fail as Safari fails them */ }
  })();

  // The origins of the other converted extensions the global page knows,
  // for addresses built from their ids (WEX.chromeExtensionOrigin).
  if ((CONFIG.otherExtensionIds || []).length) {
    Promise.resolve().then(function () {
      return native.runtime.sendMessage({ __wex: "extensionOrigins" });
    }).then(function (table) {
      WEX.learnExtensionOrigins(table);
    }, function () { /* none known */ });
  }

  // Safari can evaluate an injected script more than once for the same
  // document - reliably so while an extension is being reloaded from Extension
  // Builder, which leaves earlier injections registered. A second evaluation
  // would install a second bridge: every message answered twice, every port
  // opened twice, and each of the extension's own content scripts run again.
  // The bridge marks its own world, and a second evaluation there hands back
  // the bridge that is already there. A second evaluation in a world of its
  // own asks the document whether a bridge is there by an event that the
  // first one cancels: its name holds the bundle's session token, which no
  // page knows, so no page can listen for it or answer it, and the page's
  // document carries no mark. The name names the extension, because every
  // converted extension's bridge shares the document with the others'.
  var MARKER = "data-wex-bridge-" +
    String(CONFIG.extensionId || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  var WORLD_MARKER = "__wexBridge:" + MARKER;
  if (g[WORLD_MARKER]) {
    return g.__wexContent || null;
  }
  try {
    Object.defineProperty(g, WORLD_MARKER, { value: true, configurable: true });
  } catch (e) { /* the document is asked */ }
  var BRIDGE_QUESTION = "wex-bridge:" + MARKER + ":" + String(WEX.baseURI).split("/").slice(-2, -1)[0];
  try {
    var asked = new g.Event(BRIDGE_QUESTION, { cancelable: true });
    if (!g.document.dispatchEvent(asked)) {
      return null;
    }
    g.document.addEventListener(BRIDGE_QUESTION, function (e) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);
  } catch (e) { /* the world's mark alone */ }

  var IS_TOP = (g === g.top);

  // Evaluated for an injection into a document that loaded before the
  // extension started, the bridge serves the injection alone: Chrome runs a
  // manifest's content scripts only in documents that load after.
  var STARTED_LATE = !!g.__wexLateBridge;
  try {
    delete g.__wexLateBridge;
  } catch (e) { /* it stays */ }

  function frameId() {
    try {
      return native.runtime.getFrameId(g);
    } catch (e) {
      return IS_TOP ? 0 : -1;
    }
  }

  var messaging = WEX.makeMessaging(native);
  var remote = WEX.makeRemote(native);

  // With debugging on, the bridge keeps a record of its own on the document,
  // which says what went wrong on this side even when the global page never
  // hears from it.
  var BRIDGE_LOG = "data-wex-bridge-log";
  var bridgeLog = [];

  function debugNote(message) {
    if (!CONFIG.debug) {
      return;
    }
    bridgeLog.push(String(message));
    if (bridgeLog.length > 20) {
      bridgeLog.shift();
    }
    try {
      g.document.documentElement.setAttribute(BRIDGE_LOG, JSON.stringify(bridgeLog));
    } catch (e) { /* ignore */ }
  }

  function tell(kind, fields) {
    var message = fields || {};
    message.__wex = kind;
    native.runtime.sendMessage(message).catch(function (e) {
      // The global page may be reloading; there is nobody to tell.
      debugNote(kind + " went unanswered: " + errorMessage(e));
    });
  }

  // ------------------------------------------------------------------ //
  // Storage, carried out on the global page
  // ------------------------------------------------------------------ //
  function makeRemoteArea(areaName) {
    var path = "storage." + areaName + ".";
    function op(name, args, cb) {
      return WEX.settle(remote.call(path + name, args), cb);
    }
    return {
      onChanged: remote.event(path + "onChanged"),
      get: function (query, cb) {
        if (typeof query === "function") {
          cb = query;
          query = null;
        }
        return op("get", [query], cb);
      },
      set: function (items, cb) {
        return op("set", [items], cb);
      },
      remove: function (keys, cb) {
        return op("remove", [keys], cb);
      },
      clear: function (cb) {
        return op("clear", [], cb);
      },
      getBytesInUse: function (keys, cb) {
        if (typeof keys === "function") {
          cb = keys;
          keys = null;
        }
        return op("getBytesInUse", [keys], cb);
      },
      getKeys: function (cb) {
        return op("getKeys", [], cb);
      },
      // Every area is open to content scripts here. Extensions test for this
      // method to learn whether storage.session is, and fall back on another
      // area when it is missing, which the background then does not share.
      setAccessLevel: function (options, cb) {
        return WEX.done(WEX.shiftCallback(options, cb).cb);
      }
    };
  }

  // ------------------------------------------------------------------ //
  // The chrome namespace
  // ------------------------------------------------------------------ //
  var i18n = WEX.makeI18n();
  var manifest = WEX.localizeManifest(CONFIG.manifest || {}, i18n);

  var runtime = {
    id: WEX.runtimeId,
    onMessage: messaging.onMessage,
    onConnect: messaging.onConnect,
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
    getFrameId: function (target) {
      return native.runtime.getFrameId(target);
    },
    getPlatformInfo: function (cb) {
      return WEX.done(cb, { os: "mac", arch: "x86-64", nacl_arch: "x86-64" });
    }
  };
  Object.defineProperty(runtime, "lastError", {
    get: function () {
      // Chrome's is undefined outside a failed call's callback.
      return WEX.lastError || native.runtime.lastError || undefined;
    },
    set: function (v) {
      WEX.lastError = v;
    }
  });

  var chrome = {
    __wex: true,
    __wexNative: native,
    runtime: runtime,
    extension: {
      getURL: function (path) {
        return WEX.extUrl(path);
      },
      inIncognitoContext: false
    },
    i18n: i18n,
    storage: {
      onChanged: remote.event("storage.onChanged"),
      local: makeRemoteArea("local"),
      sync: makeRemoteArea("sync"),
      session: makeRemoteArea("session"),
      managed: {
        get: function (q, cb) {
          return WEX.done(WEX.shiftCallback(q, cb).cb, {});
        }
      }
    }
    // Deliberately no chrome.tabs here. A browser does not give content
    // scripts one, and extensions routinely use `chrome.tabs` as the test for
    // which context they are running in - defining it makes a content script
    // take the extension-page branch and fail in ways that are hard to trace.
    // The same reasoning applies to every other background-only namespace.
  };
  if (native.dom) {
    chrome.dom = native.dom;
  }
  if (!WEX.namespaceGranted("storage")) {
    delete chrome.storage;
  }

  // ------------------------------------------------------------------ //
  // Injection on demand (tabs.executeScript / scripting.executeScript)
  // ------------------------------------------------------------------ //
  function evaluate(source, url) {
    return (0, eval)(source + (url ? "\n//# sourceURL=" + url : ""));
  }

  function evaluateContentScript(source, url) {
    try {
      return evaluate(WEX.asScript(source), url);
    } catch (e) {
      log.error("content script failed" + (url ? " (" + url + ")" : ""), e);
      return undefined;
    }
  }

  function entryFor(list, element) {
    return list.filter(function (entry) {
      return entry.element === element;
    })[0] || null;
  }

  // Whether a violation's address can stand for `url`: the address itself,
  // its origin, its scheme, or none at all.
  function reportedAs(blocked, url) {
    var given = blocked.toLowerCase().split("#")[0].replace(/:$/, "");
    var full = url.toLowerCase().split("#")[0];
    var origin = full.slice(0, full.indexOf("/", full.indexOf("://") + 3));
    return !given || given === full || given === origin || given === origin + "/" ||
      given === full.slice(0, full.indexOf(":"));
  }

  // A page's policy can refuse the <style> and stylesheet <link> elements a
  // content script inserts, which reports a securitypolicyviolation. A refused
  // one is handed to the engine, which adds its rules as a user style sheet the
  // policy does not govern. So that a page cannot choose what is read, only a
  // real violation counts, and it acts only on an element a content script
  // inserted, for the address a content script gave it; the event's address
  // only narrows the choice among those elements, as an engine may report an
  // address by its origin or its scheme alone. The page's own elements are
  // never touched. Only those content scripts insert are recorded, through
  // this world's own copies of the DOM's insertion methods, which the page's
  // scripts do not share. Elements are recorded before they are inserted, while
  // a fragment still holds its children.
  var insertedStyles = [];

  function isStyleElement(node) {
    var tag = node && node.nodeType === 1 ? String(node.localName) : "";
    return tag === "style" ||
      (tag === "link" && /(^|\s)stylesheet(\s|$)/i.test(node.getAttribute("rel") || ""));
  }

  function noteStyle(element) {
    if (entryFor(insertedStyles, element)) {
      return;
    }
    if (insertedStyles.length > 50) {
      insertedStyles = insertedStyles.filter(function (entry) {
        return entry.element.isConnected && !entry.element.sheet;
      });
    }
    insertedStyles.push({ element: element, url: element.href ? String(element.href) : null });
  }

  function noteInserted(node) {
    if (!node || node.nodeType !== 1 && node.nodeType !== 11) {
      return;
    }
    var found = node.nodeType === 1 ? [node] : [];
    if (node.querySelectorAll) {
      found = found.concat(Array.prototype.slice.call(
        node.querySelectorAll("style, link[rel~='stylesheet' i]")));
    }
    found.forEach(function (element) {
      if (isStyleElement(element)) {
        noteStyle(element);
      }
    });
  }

  function recordInsertions(proto, name, nodeArguments) {
    var original = proto && proto[name];
    if (typeof original !== "function") {
      return;
    }
    proto[name] = function () {
      var given = arguments;
      var args = nodeArguments ? nodeArguments.map(function (i) { return given[i]; })
        : Array.prototype.slice.call(given);
      try {
        args.forEach(noteInserted);
      } catch (e) { /* the insertion goes ahead unrecorded */ }
      return original.apply(this, given);
    };
  }

  // The address a content script gives an element it inserted without one.
  function noteAddress(element) {
    var entry = entryFor(insertedStyles, element);
    if (entry && !entry.url && element.href) {
      entry.url = String(element.href);
    }
  }

  function watchAddresses(maker, name) {
    var proto = maker && maker.prototype;
    var own = proto && Object.getOwnPropertyDescriptor(proto, name);
    if (!own || !own.set) {
      return;
    }
    Object.defineProperty(proto, name, {
      configurable: true,
      enumerable: own.enumerable,
      get: own.get,
      set: function (value) {
        own.set.call(this, value);
        noteAddress(this);
      }
    });
  }

  if (g.Node && g.Element) {
    recordInsertions(g.Node.prototype, "appendChild", [0]);
    recordInsertions(g.Node.prototype, "insertBefore", [0]);
    recordInsertions(g.Node.prototype, "replaceChild", [0]);
    recordInsertions(g.Element.prototype, "insertAdjacentElement", [1]);
    recordInsertions(g.Range && g.Range.prototype, "insertNode", [0]);
    ["append", "prepend", "before", "after", "replaceWith", "replaceChildren"].forEach(function (name) {
      recordInsertions(g.Element.prototype, name, null);
    });
    ["append", "prepend", "replaceChildren"].forEach(function (name) {
      recordInsertions(g.DocumentFragment && g.DocumentFragment.prototype, name, null);
    });
    watchAddresses(g.HTMLLinkElement, "href");
    var setAttribute = g.Element.prototype.setAttribute;
    if (typeof setAttribute === "function") {
      g.Element.prototype.setAttribute = function (name) {
        var result = setAttribute.apply(this, arguments);
        if (String(name).toLowerCase() === "href") {
          noteAddress(this);
        }
        return result;
      };
    }
  }

  function applyRefusedStyles(event) {
    var directive = String(event.effectiveDirective || event.violatedDirective || "");
    if (!event.isTrusted || !/^(style-src|default-src)/.test(directive) || /-attr$/.test(directive)) {
      return;
    }
    var blocked = String(event.blockedURI || "");
    var code = [];
    var files = [];
    insertedStyles = insertedStyles.filter(function (entry) {
      var el = entry.element;
      if (!el.isConnected || el.sheet) {
        return false;
      }
      if (el.localName === "style") {
        if ((blocked === "inline" || !blocked) && el.textContent) {
          code.push(el.textContent);
          return false;
        }
        return true;
      }
      if (entry.url && WEX.isExtUrl(entry.url) && reportedAs(blocked, entry.url)) {
        files.push(WEX.extPath(entry.url).replace(/[?#].*$/, ""));
        return false;
      }
      return true;
    });
    if (code.length || files.length) {
      tell("styles", { code: code.join("\n"), files: files });
    }
  }
  document.addEventListener("securitypolicyviolation", applyRefusedStyles, true);

  // Carries out one injection in this frame. Called by the code the extension
  // pages hand to the engine's tabs.executeScript (WEX.makeInjection). Where
  // the job is to be awaited and its result is a promise, the frame is
  // reported as pending, and what the promise settles to is told to the
  // extension's pages under the job's token, as JSON, or as a failure. A
  // job that reports errors gives the message of what its code throws or
  // its promise rejects with, as `error`, where the frame's result would be.
  // The job runs in this world, the extension's content-script world, and one
  // that names any other world is refused: the page's own world is the
  // engine's, which scripting.executeScript with world "MAIN" reaches.
  function exec(job) {
    if (job && job.world != null && job.world !== "ISOLATED") {
      throw new Error("WEXContent.exec runs code in the content-script world only, not in world " +
        JSON.stringify(String(job.world)) + "; for the page's own world, call " +
        "chrome.scripting.executeScript({ target: { tabId }, world: \"MAIN\", func }) from an extension page.");
    }
    makeChrome();
    if (!job.reportErrors) {
      return execute(job);
    }
    try {
      return execute(job);
    } catch (e) {
      return { frameId: frameId(), error: errorMessage(e) };
    }
  }

  // What Firefox reports for an error: its message, a thrown string itself,
  // and for anything else that it was unexpected.
  function errorMessage(e) {
    if (e && typeof e.message === "string") {
      return e.message;
    }
    return typeof e === "string" ? e : "An unexpected error occurred";
  }

  function execute(job) {
    var result;
    var sources = job.sources || [];
    // A job of independent files leaves the files after one that fails to
    // parse or throws to run; only the last can decide the frame's result.
    sources.forEach(function (s, i) {
      if (job.independentFiles && i < sources.length - 1) {
        evaluateContentScript(s.code, s.url);
      } else {
        result = evaluate(WEX.asScript(s.code), s.url);
      }
    });
    if (job.func) {
      result = evaluate("(" + job.func + ")").apply(null, job.args || []);
    }
    if (job.settle && result && typeof result.then === "function") {
      var id = frameId();
      Promise.resolve(result).then(function (value) {
        tell("settled", { token: job.settle, frameId: id, result: WEX.resultValue(value) });
      }, function (e) {
        tell("settled", { token: job.settle, frameId: id, failed: true, error: errorMessage(e) });
      });
      return { frameId: id, settle: job.settle };
    }
    return { frameId: frameId(), result: WEX.resultValue(result) };
  }

  // ------------------------------------------------------------------ //
  // Web pages the extension lets in
  // ------------------------------------------------------------------ //
  // A page the manifest's `externally_connectable` matches has Chrome's
  // `chrome.runtime` for web pages (WEX.pageRuntime, which the global page
  // registers for the page's world), whose requests come here to go on to the
  // global page.
  function installPageRuntime() {
    var allowed = (CONFIG.manifest || {}).externally_connectable;
    var matches = allowed && allowed.matches;
    if (CONFIG.firefoxBuild || !matches || !matches.length || !WEX.matchesAny(g.location.href, matches)) {
      return;
    }
    var token = WEX.pageRuntimeToken;
    var host = WEX.pageRuntimeHost(native, function (data) {
      g.document.dispatchEvent(new g.CustomEvent("wex-external-reply-" + token, { detail: JSON.stringify(data) }));
    });
    g.document.addEventListener("wex-external-" + token, function (event) {
      var data;
      try {
        data = JSON.parse(event.detail);
      } catch (e) {
        return;
      }
      host.handle(data);
    });
  }

  // ------------------------------------------------------------------ //
  // Context menu information
  // ------------------------------------------------------------------ //
  // Safari builds its context menu in the browser process and tells the global
  // page nothing about what was right-clicked. The page side has to gather it
  // and hand it over on the event itself, before the menu is built.
  function installContextMenuReporting() {
    document.addEventListener("contextmenu", function (e) {
      if (!hostTab || !hostTab.setContextMenuEventUserInfo) {
        return;
      }
      var target = e.target;
      var info = {
        pageUrl: IS_TOP ? g.location.href : undefined,
        frameUrl: IS_TOP ? undefined : g.location.href,
        frameId: frameId(),
        editable: isEditable(target),
        selectionText: String(g.getSelection ? g.getSelection() : "").slice(0, 1024) || undefined
      };
      var link = closestTag(target, "a");
      if (link && link.href) {
        info.linkUrl = link.href;
      }
      var tag = target && target.nodeName ? target.nodeName.toLowerCase() : "";
      if (tag === "img" && target.src) {
        info.srcUrl = target.src;
        info.mediaType = "image";
      } else if ((tag === "video" || tag === "audio") && target.currentSrc) {
        info.srcUrl = target.currentSrc;
        info.mediaType = tag;
      }
      try {
        WEX.withSafari(g, function () {
          hostTab.setContextMenuEventUserInfo(e, info);
        });
      } catch (err) { /* the host may have removed this frame */ }
    }, true);
  }

  function isEditable(el) {
    if (!el || !el.nodeName) {
      return false;
    }
    var tag = el.nodeName.toLowerCase();
    if (tag === "textarea") {
      return true;
    }
    if (tag === "input") {
      return !/^(button|checkbox|color|file|hidden|image|radio|range|reset|submit)$/i.test(el.type || "text");
    }
    return !!el.isContentEditable;
  }

  function closestTag(el, tag) {
    var cur = el;
    while (cur && cur.nodeName) {
      if (cur.nodeName.toLowerCase() === tag) {
        return cur;
      }
      cur = cur.parentNode;
    }
    return null;
  }

  // ------------------------------------------------------------------ //
  // Same-document navigation
  // ------------------------------------------------------------------ //
  // The engine reports navigations that load a document. The ones that stay
  // in the document - a fragment change, a history entry - are reported from
  // here, and the global page turns them into webNavigation events. One move
  // can fire popstate and then hashchange, and is one event: popstate waits
  // briefly for a hashchange, which reports the move as a fragment change
  // unless more than the fragment changed.
  var HASHCHANGE_WAIT = 50;

  function installHistoryReporting() {
    var waiting = null;
    function withoutFragment(url) {
      return String(url || "").split("#")[0];
    }
    function reportWaiting() {
      if (waiting) {
        clearTimeout(waiting.timer);
        tell("navigated", { how: "history", url: waiting.url });
        waiting = null;
      }
    }
    g.addEventListener("hashchange", function (e) {
      var moved = !!waiting && !!e.oldURL && withoutFragment(e.oldURL) !== withoutFragment(e.newURL);
      if (waiting) {
        clearTimeout(waiting.timer);
        waiting = null;
      }
      tell("navigated", { how: moved ? "history" : "fragment", url: e.newURL || g.location.href });
    });
    g.addEventListener("popstate", function () {
      reportWaiting();
      waiting = { url: g.location.href, timer: setTimeout(reportWaiting, HASHCHANGE_WAIT) };
    });
    // pushState and replaceState fire neither; the Navigation API announces
    // them. A change of the fragment alone is hashchange's to report.
    var navigation = g.navigation;
    if (navigation && typeof navigation.addEventListener === "function") {
      var address = String(g.location.href);
      navigation.addEventListener("currententrychange", function (e) {
        var was = address;
        address = String(g.location.href);
        if ((e.navigationType === "push" || e.navigationType === "replace") &&
            (was === address || withoutFragment(was) !== withoutFragment(address))) {
          tell("navigated", { how: "history", url: address });
        }
      });
    }
  }

  // ------------------------------------------------------------------ //
  // Running the extension's own content scripts
  // ------------------------------------------------------------------ //
  // An about:blank or about:srcdoc frame is matched by the address of the
  // document that made it, its parent's or its opener's, as Chrome matches
  // it; null where that document is out of reach.
  function creatorUrl() {
    var w = g;
    try {
      while (String(w.location.href).lastIndexOf("about:", 0) === 0) {
        var up = w !== w.top ? w.parent : w.opener;
        if (!up || up === w) {
          return null;
        }
        w = up;
      }
      return String(w.location.href);
    } catch (e) {
      return null;
    }
  }

  function groupApplies(group) {
    var url = g.location.href;
    if (!IS_TOP && !group.all_frames) {
      return false;
    }
    if (url.lastIndexOf("about:", 0) === 0) {
      url = group.match_about_blank ? creatorUrl() : null;
      if (!url) {
        return false;
      }
    }
    if (!WEX.matchesAny(url, group.matches)) {
      return false;
    }
    if (group.exclude_matches && WEX.matchesAny(url, group.exclude_matches)) {
      return false;
    }
    if (group.include_globs && group.include_globs.length && !WEX.globsAny(url, group.include_globs)) {
      return false;
    }
    if (group.exclude_globs && WEX.globsAny(url, group.exclude_globs)) {
      return false;
    }
    return true;
  }

  var ranPhases = {};
  var injectedScripts = (CONFIG.injectedScripts || {}).files || {};
  var appliedScripts = {};

  // Whether file `i` of content script group `n`, which Safari injects, is
  // to run in this document: where its group applies, and once.
  function applies(n, i) {
    var group = (CONFIG.contentScripts || [])[n];
    var key = n + ":" + i;
    if (!group || appliedScripts[key] || !groupApplies(group)) {
      return false;
    }
    appliedScripts[key] = true;
    makeChrome();
    return true;
  }

  // The engine's copy of a style sheet arrives after the page's first paint.
  // Until it does, the frame shows its own copy of those the converter kept
  // the text of (earlySheets).
  function earlySheet(file) {
    var text = (CONFIG.earlySheets || {})[file];
    if (text === undefined) {
      return null;
    }
    var sheet = new g.CSSStyleSheet();
    sheet.replaceSync(text);
    return sheet;
  }

  function insertSheets(files) {
    var early = [];
    try {
      early = files.map(earlySheet).filter(Boolean);
      g.document.adoptedStyleSheets = g.document.adoptedStyleSheets.concat(early);
    } catch (e) {
      early = [];
      debugNote("no early style sheets here: " + errorMessage(e));
    }
    function dropEarly() {
      if (early.length) {
        g.document.adoptedStyleSheets = g.document.adoptedStyleSheets.filter(function (sheet) {
          return early.indexOf(sheet) < 0;
        });
      }
    }
    native.runtime.sendMessage({ __wex: "css", files: files }).then(dropEarly, function (e) {
      debugNote("css went unanswered: " + errorMessage(e));
    });
  }

  function run(phase) {
    if (ranPhases[phase] || STARTED_LATE) {
      return;
    }
    ranPhases[phase] = true;

    var groups = CONFIG.contentScripts || [];

    // document_idle has no separate injection point here; it runs with
    // document_end, which is the closest the host offers.
    function slotOf(group) {
      return (group.run_at || "document_idle") === "document_start" ? "document_start" : "document_end";
    }

    // Style sheets are added by the engine, which keeps them out of the
    // page's sight. Only an extension page can ask it to, so the global page
    // does the asking. Chrome adds a group's style sheets as the document
    // starts, whatever its run_at says; a Firefox build keeps them with the
    // group's scripts.
    var sheets = [];
    groups.forEach(function (group) {
      if ((CONFIG.firefoxBuild ? slotOf(group) : "document_start") === phase && groupApplies(group)) {
        sheets = sheets.concat(group.css || []);
      }
    });
    if (sheets.length) {
      insertSheets(sheets);
    }

    groups.forEach(function (group, index) {
      // A group for the page's own world is the engine's to run: the global
      // page registers it there (CONFIG.pageWorldScripts).
      if (slotOf(group) !== phase || group.world === "MAIN" || !groupApplies(group)) {
        return;
      }

      if ((group.js || []).length) {
        makeChrome();
      }

      // A manifest may name a file from the bundle's root, as "/lib/x.js".
      // Safari injects the files the converter gave it, which ask applies()
      // whether to run.
      (group.js || []).forEach(function (file, i) {
        if (injectedScripts[index + ":" + i]) {
          return;
        }
        var source = WEX.readTextSync(String(file).replace(/^\/+/, ""));
        if (source == null) {
          log.error("could not read the content script " + file);
          return;
        }
        evaluateContentScript(source, WEX.extUrl(file));
      });
    });
  }

  // ------------------------------------------------------------------ //
  // The page, for pageCapture.saveAsMHTML
  // ------------------------------------------------------------------ //
  // Each frame the bridge is in describes its document: the markup as it now
  // stands, with the values of its form fields, and the files it shows. A
  // frame learns from its parent which of the parent's frame elements it is
  // by a token the parent posts to it, so that the parent's markup can point
  // at the frame's part of the archive.
  var mhtmlToken = null;
  var mhtmlChildren = [];

  g.addEventListener("message", function (e) {
    if (e.source === g.parent && e.source !== g && e.data && typeof e.data.__wexMhtmlFrame === "string") {
      mhtmlToken = e.data.__wexMhtmlFrame;
    }
  }, true);

  function mhtmlFrameElements(root) {
    return Array.prototype.slice.call(root.querySelectorAll("iframe, frame"));
  }

  function prepareMhtml() {
    mhtmlChildren = mhtmlFrameElements(document).map(function (el) {
      var token = WEX.uid("f").replace(/[^a-z0-9]/gi, "");
      try {
        el.contentWindow.postMessage({ __wexMhtmlFrame: token }, "*");
      } catch (e) {
        return null;
      }
      return { element: el, token: token };
    });
  }

  function urlsInCss(text, base, out) {
    String(text || "").replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)|@import\s+(['"])([^'"]+)\3/g,
      function (_, q, inUrl, q2, inImport) {
        var raw = inUrl || inImport;
        if (raw && !/^(data|blob|javascript|about):/i.test(raw) && raw.charAt(0) !== "#") {
          try {
            out.push(new URL(raw, base).href);
          } catch (e) { /* not a URL */ }
        }
        return _;
      });
  }

  function serializeMhtml() {
    var doc = document;
    var base = doc.baseURI;
    var resources = [];
    var add = function (url) {
      if (url && !/^(data|blob|javascript|about):/i.test(url)) {
        try {
          resources.push(new URL(url, base).href);
        } catch (e) { /* not a URL */ }
      }
    };
    var root = doc.documentElement;
    var clone = root.cloneNode(true);
    // The runtime's marks on the page are not the page's.
    Array.prototype.slice.call(clone.attributes).forEach(function (attribute) {
      if (attribute.name.indexOf("data-wex-") === 0) {
        clone.removeAttribute(attribute.name);
      }
    });
    // Form fields keep what the user entered.
    var fields = root.querySelectorAll("input, textarea, select");
    var copies = clone.querySelectorAll("input, textarea, select");
    for (var f = 0; f < fields.length && f < copies.length; f++) {
      var field = fields[f];
      var copy = copies[f];
      var tag = field.tagName.toLowerCase();
      if (tag === "textarea") {
        copy.textContent = field.value;
      } else if (tag === "select") {
        for (var o = 0; o < field.options.length && o < copy.options.length; o++) {
          if (field.options[o].selected) {
            copy.options[o].setAttribute("selected", "");
          } else {
            copy.options[o].removeAttribute("selected");
          }
        }
      } else if (field.type === "checkbox" || field.type === "radio") {
        if (field.checked) {
          copy.setAttribute("checked", "");
        } else {
          copy.removeAttribute("checked");
        }
      } else if (field.type !== "file" && field.type !== "password") {
        copy.setAttribute("value", field.value);
      }
    }
    // Frame elements point at the frames' parts by their tokens.
    var frames = {};
    var cloneFrames = mhtmlFrameElements(clone);
    mhtmlFrameElements(root).forEach(function (el, i) {
      var child = mhtmlChildren.filter(function (c) {
        return c && c.element === el;
      })[0];
      if (child && cloneFrames[i]) {
        frames[child.token] = el.getAttribute("src") || "";
        cloneFrames[i].setAttribute("src", "wex-mhtml-frame:" + child.token);
      }
    });
    // Media are not kept, as Chrome keeps no video or sound; a video's poster
    // is.
    Array.prototype.forEach.call(clone.querySelectorAll("img, image, video, input[type=image], picture > source, " +
      "link, [style], [background]"), function (el) {
      var tag = el.tagName.toLowerCase();
      if (tag === "video") {
        add(el.getAttribute("poster"));
      } else if (tag === "link") {
        if (/(^|\s)(stylesheet|icon|shortcut|apple-touch-icon)(\s|$)/i.test(el.getAttribute("rel") || "")) {
          add(el.getAttribute("href"));
        }
      } else if (/^(img|image|input|source)$/.test(tag)) {
        ["src", "href", "xlink:href"].forEach(function (name) {
          if (el.hasAttribute(name)) {
            add(el.getAttribute(name));
          }
        });
        (el.getAttribute("srcset") || "").split(",").forEach(function (candidate) {
          add(candidate.trim().split(/\s+/)[0]);
        });
      }
      if (el.hasAttribute("background")) {
        add(el.getAttribute("background"));
      }
      if (el.hasAttribute("style")) {
        urlsInCss(el.getAttribute("style"), base, resources);
      }
    });
    Array.prototype.forEach.call(doc.images, function (img) {
      add(img.currentSrc);
    });
    Array.prototype.forEach.call(clone.querySelectorAll("style"), function (style) {
      urlsInCss(style.textContent, base, resources);
    });
    if (!clone.querySelector("meta[charset], meta[http-equiv='Content-Type' i]")) {
      var head = clone.querySelector("head");
      if (head) {
        var meta = doc.createElement("meta");
        meta.setAttribute("http-equiv", "Content-Type");
        meta.setAttribute("content", "text/html; charset=UTF-8");
        head.insertBefore(meta, head.firstChild);
      }
    }
    var type = doc.doctype;
    var doctype = type ? "<!DOCTYPE " + type.name + (type.publicId ? " PUBLIC \"" + type.publicId + "\"" : "") +
      (type.systemId ? (type.publicId ? "" : " SYSTEM") + " \"" + type.systemId + "\"" : "") + ">" : "";
    return {
      url: String(g.location.href),
      title: doc.title,
      token: IS_TOP ? null : mhtmlToken,
      contentType: doc.contentType || "text/html",
      html: doctype + clone.outerHTML,
      frames: frames,
      resources: resources.filter(function (url, i) {
        return resources.indexOf(url) === i;
      })
    };
  }

  function serveMhtml(port) {
    port.onMessage.addListener(function (m) {
      try {
        if (m.prepare) {
          prepareMhtml();
          port.postMessage({ prepared: true });
        } else if (m.serialize) {
          port.postMessage({ page: serializeMhtml() });
        }
      } catch (e) {
        port.postMessage({ error: String(e && e.message || e) });
      }
    });
  }

  // ------------------------------------------------------------------ //
  // Saving a file on the extension's behalf
  // ------------------------------------------------------------------ //
  // The global page sends a file here in pieces. The download starts from an
  // object URL and a link of this world's own, and the link never joins the
  // document, so the page's scripts see neither the bytes, the name nor the
  // click. A sandboxed document cannot download, and says so, so that the
  // global page saves the file another way.
  var SAVED_URL_KEPT = 60000;

  function base64ToBytes(text) {
    var binary = atob(text);
    var out = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  }

  function receiveSave(port) {
    var save = null;

    function finish() {
      if (String(g.origin) === "null") {
        throw new Error("a sandboxed page cannot save a file");
      }
      for (var i = 0; i < save.total; i++) {
        if (!save.pieces[i]) {
          throw new Error("a piece of the file did not arrive");
        }
      }
      var blob = new Blob(save.pieces, { type: save.type || "application/octet-stream" });
      var url = URL.createObjectURL(blob);
      var link = document.createElement("a");
      link.href = url;
      link.download = save.filename;
      link.click();
      setTimeout(function () {
        try {
          URL.revokeObjectURL(url);
        } catch (e) { /* ignore */ }
      }, SAVED_URL_KEPT);
    }

    port.onMessage.addListener(function (m) {
      if (m.begin) {
        save = { filename: m.begin.filename, type: m.begin.type, total: m.begin.total, pieces: [] };
        port.postMessage({ ready: true });
      } else if (m.chunk && save) {
        save.pieces[m.chunk.index] = base64ToBytes(m.chunk.data);
      } else if (m.end && save) {
        try {
          finish();
          port.postMessage({ ok: true });
        } catch (e) {
          port.postMessage({ error: String(e && e.message || e) });
        }
        save = null;
      }
    });
  }

  native.runtime.onConnect.addListener(function (port) {
    if (port.name === WEX.INTERNAL_PORT + "offscreen-audio") {
      hostOffscreenAudio(port);
      return;
    }
    if (port.name === WEX.INTERNAL_PORT + "save") {
      receiveSave(port);
      return;
    }
    if (port.name === WEX.INTERNAL_PORT + "mhtml") {
      serveMhtml(port);
    }
    if (port.name === WEX.INTERNAL_PORT + "popover-focus") {
      watchUnderPopover(port);
    }
  });

  // One of the extension's popovers shows over this page and has taken the
  // keyboard from it, where Chrome's popup and side panel leave it. The
  // click on the page that hides the popover brings the window back to the
  // front, and Safari gives the page that click's mousedown and mouseup but
  // none of the mousemoves of a drag it starts; the page is given the move
  // to where the drag ended, as Chrome gives it, before it hears the
  // mouseup. The global page hears whether that click was a drag. The
  // listeners that come first, before the page's own, are there from the
  // start and do nothing until a popover shows.
  var underPopover = null;

  function watchUnderPopover(port) {
    if (!IS_TOP || !port.sender ||
        String(port.sender.url || "").indexOf(WEX.extUrl("")) !== 0) {
      port.disconnect();
      return;
    }
    if (underPopover) {
      underPopover.stop();
    }
    var watch = { port: port, refocused: false, down: null, moved: false };
    var onMove = function (e) {
      if (e.isTrusted && watch.down) {
        watch.moved = true;
      }
    };
    var timer = setTimeout(function () {
      watch.stop();
    }, 600000);
    watch.stop = function () {
      clearTimeout(timer);
      g.removeEventListener("mousemove", onMove, true);
      if (underPopover === watch) {
        underPopover = null;
      }
      try {
        port.disconnect();
      } catch (e) { /* gone already */ }
    };
    port.onDisconnect.addListener(watch.stop);
    g.addEventListener("mousemove", onMove, true);
    underPopover = watch;
  }

  if (IS_TOP && g.addEventListener) {
    g.addEventListener("focus", function (e) {
      if (underPopover && e.isTrusted && e.target === g) {
        underPopover.refocused = true;
      }
    }, true);
    g.addEventListener("mousedown", function (e) {
      if (underPopover && e.isTrusted && e.button === 0) {
        underPopover.down = { x: e.clientX, y: e.clientY };
        underPopover.moved = false;
      }
    }, true);
    g.addEventListener("mouseup", function (e) {
      var watch = underPopover;
      if (!watch || !e.isTrusted || e.button !== 0) {
        return;
      }
      var from = watch.down;
      var dragged = !!from && (Math.abs(e.clientX - from.x) > 3 || Math.abs(e.clientY - from.y) > 3);
      if (watch.refocused && dragged && !watch.moved) {
        var init = {
          bubbles: true, cancelable: true, composed: true, view: g, detail: 0,
          screenX: e.screenX, screenY: e.screenY, clientX: e.clientX, clientY: e.clientY,
          ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey,
          button: 0, buttons: 1
        };
        try {
          if (typeof g.PointerEvent === "function") {
            init.pointerId = 1;
            init.pointerType = "mouse";
            init.isPrimary = true;
            e.target.dispatchEvent(new g.PointerEvent("pointermove", init));
          }
          e.target.dispatchEvent(new g.MouseEvent("mousemove", init));
        } catch (err) { /* the page hears the mouseup alone */ }
      }
      try {
        watch.port.postMessage({ activation: watch.refocused, dragged: dragged });
      } catch (err) { /* the popover is gone */ }
      watch.stop();
    }, true);
  }

  // A Safari global page is permanently hidden and cannot start Web Audio.
  // Keep AUDIO_PLAYBACK documents in an extension-origin frame in a normal
  // tab instead. Only the extension host can request one; the web page never
  // receives its runtime messages or access to its cross-origin document. The
  // frame's address holds the bundle's session token and its window takes
  // messages, so it stays out of the page's sight in a closed shadow root
  // where this WebKit has one, and in the document itself where it has not.
  // It is given its address once it is in place, as the first load of a
  // frame is what a page's Resource Timing entries list.
  function audioFrameHolder(frame) {
    try {
      var host = document.createElement("div");
      var root = host.attachShadow({ mode: "closed" });
      root.appendChild(frame);
      host.style.cssText = "all:initial;position:fixed;left:-100px;top:-100px;width:1px;height:1px";
      host.setAttribute("aria-hidden", "true");
      return host;
    } catch (e) {
      return frame;
    }
  }

  function hostOffscreenAudio(port) {
    if (!IS_TOP || !port.sender ||
        String(port.sender.url || "").indexOf(WEX.extUrl("")) !== 0) {
      port.disconnect();
      return;
    }
    var frame = null;
    var holder = null;
    var observer = null;
    function remove() {
      g.removeEventListener("pagehide", pageHidden);
      if (observer) observer.disconnect();
      if (frame) {
        frame.onload = frame.onerror = null;
        if (frame.parentNode) frame.parentNode.removeChild(frame);
        if (holder !== frame && holder.parentNode) holder.parentNode.removeChild(holder);
        frame = holder = null;
      }
    }
    port.onDisconnect.addListener(remove);
    port.onMessage.addListener(function (message) {
      if (message.close) {
        remove();
        port.postMessage({ closed: true });
        return;
      }
      if (frame || typeof message.url !== "string") return;
      var url;
      try {
        url = new URL(message.url).href;
        if (url.indexOf(WEX.extUrl("")) !== 0 ||
            !/\.(?:html?|xhtml)(?:[?#]|$)/i.test(url)) {
          throw new Error("Offscreen documents must belong to this extension.");
        }
      } catch (error) {
        port.postMessage({ error: String(error) });
        return;
      }
      frame = document.createElement("iframe");
      frame.style.cssText = "position:fixed;left:-100px;top:-100px;width:1px;height:1px;" +
        "border:0;pointer-events:none";
      frame.setAttribute("aria-hidden", "true");
      frame.setAttribute("tabindex", "-1");
      frame.setAttribute("allow", "autoplay");
      holder = audioFrameHolder(frame);
      (document.body || document.documentElement).appendChild(holder);
      frame.onload = function () {
        // The load of the blank document a frame starts with is not the
        // extension's; this world can read that one's address, and not its own.
        try {
          if (String(frame.contentWindow.location.href).indexOf("about:") === 0) return;
        } catch (e) { /* the extension's document */ }
        port.postMessage({ ready: true });
      };
      frame.onerror = function () { port.postMessage({ error: "Offscreen document failed to load." }); };
      frame.src = url;
      observer = new MutationObserver(function () {
        if (frame && !document.documentElement.contains(holder)) {
          remove();
          port.disconnect();
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    });
    function pageHidden() {
      remove();
      port.disconnect();
    }
    g.addEventListener("pagehide", pageHidden, { once: true });
  }

  // ------------------------------------------------------------------ //
  // Debug channel
  // ------------------------------------------------------------------ //
  // With debugging on, the global page's account of itself is published onto
  // the document, where it can be read from outside the extension, and an
  // attribute set on the document is relayed to the global page as a command.
  // The global page cannot be inspected or scripted from outside on this
  // host, so this is the way to make it do something on demand and watch what
  // happens.
  function installDebugChannel() {
    var COMMAND = "data-wex-command";
    var port = native.runtime.connect({ name: WEX.INTERNAL_PORT + "debug" });
    var open = true;

    port.onMessage.addListener(function (m) {
      try {
        document.documentElement.setAttribute(
          "data-wex-diagnostics", JSON.stringify(m.state || {}));
      } catch (e) { /* ignore */ }
    });
    port.onDisconnect.addListener(function () {
      open = false;
      var error = native.runtime.lastError;
      debugNote("the debug port closed" + (error ? ": " + error.message : ""));
    });

    setInterval(function () {
      var command;
      try {
        command = document.documentElement.getAttribute(COMMAND);
      } catch (e) {
        return;
      }
      if (!command || !open) {
        return;
      }
      try {
        document.documentElement.removeAttribute(COMMAND);
      } catch (e) { /* ignore */ }
      port.postMessage({ command: command });
    }, 250);
  }

  // ------------------------------------------------------------------ //
  // Boot
  // ------------------------------------------------------------------ //
  if (CONFIG.testApi) {
    chrome.test = WEX.makeTestApi(function (entry) {
      return native.runtime.sendMessage({ __wex: "test", entry: entry });
    }, function () {
      return chrome.runtime.lastError;
    });
  }
  // What the extension's content scripts see of the browser: chrome with its
  // checks and enums, the browser presented as the one it was made for, and
  // its requests to the web naming it as the web knows it, in this world,
  // which the page cannot see. The top frame, and a frame a content script
  // applies to, make it at once. Any other frame, as most of a page's frames
  // are for most extensions, makes it just before something of the
  // extension's first runs there: code an injection runs, a script
  // registered at run time, or anything that reads chrome or browser. Making
  // it costs such a frame more than all the rest of the bridge does.
  var made = false;
  function makeChrome() {
    if (made) {
      return;
    }
    made = true;
    WEX.installWebFacingAddresses(g, false);
    WEX.installFileStatusFix(g);
    WEX.installSvgImageFallback(g);
    WEX.installExtensionHostAlias(g);
    WEX.addLegacyRequests(chrome.extension, native, false);
    WEX.addSchemaEnums(chrome);
    WEX.installApiChecks(chrome);
    // Where the names are still the getters below, they become plain
    // properties in place, since an assignment would only reach the setter.
    ["chrome", "browser"].forEach(function (name) {
      var own = Object.getOwnPropertyDescriptor(g, name);
      if (own && own.get) {
        Object.defineProperty(g, name, { value: chrome, writable: true, enumerable: true, configurable: true });
      } else {
        g[name] = chrome;
      }
    });
    WEX.presentBrowser(g);
  }
  if (IS_TOP || (CONFIG.contentScripts || []).some(groupApplies)) {
    makeChrome();
  } else {
    ["chrome", "browser"].forEach(function (name) {
      try {
        Object.defineProperty(g, name, {
          configurable: true, enumerable: true,
          get: function () {
            makeChrome();
            return g[name];
          },
          set: function (value) {
            makeChrome();
            g[name] = value;
          }
        });
      } catch (e) {
        makeChrome();
      }
    });
  }

  installHistoryReporting();
  installPageRuntime();
  WEX.installCommandKeys(g, function (name) {
    tell("command", { name: name });
  });
  // Whether the extension listens for messages in this frame, for
  // tabs.sendMessage to tell a tab nobody listens in; a frame that does not
  // listen leaves the question to the others.
  native.runtime.onMessage.addListener(function (message, sender, respond) {
    if (WEX.isInternal(message) && message.__wex === "listening" &&
        (chrome.runtime.onMessage.hasListeners() ||
         (chrome.extension && chrome.extension.onRequest && chrome.extension.onRequest.hasListeners()))) {
      respond({ listening: true });
    }
    return undefined;
  });
  if (CONFIG.contextMenus) {
    installContextMenuReporting();
  }
  if (IS_TOP) {
    debugNote("bridge up at " + g.location.href + " with " +
      Object.keys(native).join(",") + " from the engine");
    if (CONFIG.debug) {
      installDebugChannel();
    }
  }

  var api = { run: run, exec: exec, chrome: chrome, applies: applies, prepare: makeChrome };
  g.__wexContent = api;
  return api;
})(this);
