// What the converted extension will and will not be able to do.
//
// The conversion always produces a bundle; whether that bundle works depends
// on which parts of the WebExtension API the extension leans on. This walks
// the extension's own JavaScript, collects the API calls it makes, and grades
// each one against what the Safari runtime layer can actually provide.

(function (W2S) {
  "use strict";

  var bytes = W2S.bytes;

  var FULL = "works";
  var PARTIAL = "degraded";
  var NONE = "unavailable";

  // Grades are keyed by "namespace" or "namespace.member"; the more specific
  // key wins. Anything unlisted is reported as untested rather than guessed at.
  var SUPPORT = {
    "runtime": [FULL, null],
    "runtime.connectNative": [NONE, "no native application can be reached"],
    "runtime.sendNativeMessage": [NONE, "no native application can be reached"],
    "runtime.getPackageDirectoryEntry": [NONE, "no filesystem access"],

    "extension": [FULL, null],
    "storage": [FULL, "kept in the global page's IndexedDB"],
    "i18n": [FULL, null],
    "alarms": [FULL, "timers on the global page, which stays loaded"],

    "tabs": [FULL, null],
    "tabs.setZoom": [NONE, "no zoom control"],
    "tabs.setZoomSettings": [NONE, "no zoom control"],
    "tabs.discard": [NONE, "no tab discarding"],

    "windows": [PARTIAL, "windows open as ordinary browser windows, without a size, " +
                         "position or type"],
    "action": [PARTIAL, "one toolbar button; the badge shows a number only"],
    "browserAction": [PARTIAL, "one toolbar button; the badge shows a number only"],
    "pageAction": [PARTIAL, "mapped onto the same single toolbar button"],

    "contextMenus": [PARTIAL, "the page menu shows top-level items only, and no item with a submenu; action menus are native, shown when the toolbar button is pressed " +
                            "if the action has no popup and no onClicked listener"],
    "menus": [PARTIAL, "the page menu shows top-level items only, and no item with a submenu; action menus are native, shown when the toolbar button is pressed " +
                     "if the action has no popup and no onClicked listener"],

    "webNavigation": [FULL, "provided by the engine"],
    "webNavigation.onHistoryStateUpdated": [PARTIAL, "reported for history entries the " +
                                                     "user moves between, not for pushState"],

    "webRequest": [FULL, "provided by the engine"],
    "webRequest.filterResponseData": [FULL, "provided by the engine, in a Firefox build"],
    "webRequest.getSecurityInfo": [NONE, "no certificate details"],

    "declarativeNetRequest": [FULL, "provided by the engine; redirect and modifyHeaders " +
                                    "rules act only on sites in Website Access, and " +
                                    "modifyHeaders only on headers WebKit allows"],
    "declarativeNetRequest.getMatchedRules": [PARTIAL, "reports only matches on sites in " +
                                                       "Website Access"],
    "declarativeNetRequest.onRuleMatchedDebug": [NONE, "the engine reports no matches as " +
                                                       "they happen"],
    "declarativeNetRequest.testMatchOutcome": [NONE, "the engine cannot test a request " +
                                                     "against the rules"],

    "declarativeContent": [PARTIAL, "rules show the action and add content scripts; " +
                                    "SetIcon's pixels are not shown"],

    "scripting": [FULL, "carried out by the engine"],
    "contentScripts": [FULL, "registered scripts are handed to Safari, which runs them where " +
                             "they match"],

    "cookies": [FULL, "provided by the engine, for the sites the bundle has access to"],
    "downloads": [PARTIAL, "the extension's own downloads are fetched and saved into Safari's " +
                           "downloads folder; the user's are not listed, and saved files " +
                           "cannot be opened, shown or removed"],
    "notifications": [PARTIAL, "shown in the Notification Center with their text, clicks and " +
                               "closing reported; no buttons, images or progress bars"],
    "commands": [PARTIAL, "a shortcut works while a page the extension can reach, or one of " +
                          "its own, has the keyboard"],
    "permissions": [PARTIAL, "everything the bundle asks for is granted at install time"],
    "idle": [NONE, "always reports active"],

    "bookmarks": [NONE, "no bookmarks API"],
    "history": [NONE, "no history API"],
    "topSites": [NONE, "no top-sites API"],
    "sessions": [PARTIAL, "the tabs and windows closed while the extension runs; no other devices"],
    "management": [PARTIAL, "the extension knows itself and no other extension"],
    "browsingData": [PARTIAL, "removes cookies and the in-memory cache only"],
    "privacy": [PARTIAL, "network prediction and hyperlink auditing are the engine's; the rest " +
                         "report Safari's settings and cannot be changed"],
    "proxy": [FULL, "provided by the engine"],
    "identity": [PARTIAL, "the web auth flow works; Chrome's sign-in is as it is with no one " +
                          "signed in"],
    "devtools": [PARTIAL, "devtools pages run with the Web Inspector; panels show in a window " +
                          "of their own"],
    "omnibox": [PARTIAL, "the keyword and a space in Safari's address bar send the rest to " +
                         "the extension; no suggestions are shown"],
    "sidebarAction": [PARTIAL, "the panel opens in a tab"],
    "sidePanel": [PARTIAL, "the panel shows in a popover of the toolbar button"],
    "offscreen": [PARTIAL, "audio documents require an accessible active webpage " +
                           "and close with their host page; other documents use " +
                           "the global page; no audio idle auto-close or separate " +
                           "incognito documents"],
    "runtime.getContexts": [PARTIAL, "reports the background and offscreen documents only"],
    "search": [NONE, "no search API"],
    "tabGroups": [PARTIAL, "the groups are the runtime's: Safari draws none, and a collapsed " +
                           "group's tabs are hidden"],
    "userScripts": [PARTIAL, "user scripts run in the content scripts' world, where their " +
                             "messages arrive as the content scripts' do; one for the page's " +
                             "world names its code by file"],
    "dns": [FULL, "provided by the engine"],
    "tts": [FULL, "spoken by Safari's speech synthesis"],
    "debugger": [PARTIAL, "the commands Safari's inspector and input can carry out"],
    "dom": [FULL, null],
    "theme": [NONE, "Safari's look cannot be changed"],
    "contextualIdentities": [NONE, "Safari has no containers; the calls fail as Firefox's do " +
                                   "with containers off"],
    "printing": [NONE, "no printing API"],
    "gcm": [NONE, "Safari receives no Google Cloud Messaging; the calls fail as Chrome's do " +
                  "with GCM disabled, and the events never fire"],
    "printerProvider": [NONE, "Safari's print dialog never asks an extension for printers; the " +
                              "events never fire"],
    "tabCapture": [NONE, "Safari cannot capture a tab's audio or video; a capture fails as Chrome's " +
                         "does when it does not start, and the status never changes"],
    "pageCapture": [PARTIAL, "frames outside Website Access, and files the extension cannot " +
                             "fetch, are left out of the archive"],
    "publicSuffix": [FULL, "answered from the Public Suffix List the bundle carries"],
    "desktopCapture": [NONE, "no desktop capture"],
    "system": [NONE, "no system information APIs"]
  };

  // Word boundaries, word characters and white space are Unicode's, so a
  // name glued to a non-ASCII letter is not taken for the API.
  var WORD = "[\\p{L}\\p{N}_]";
  var SPACE = "[\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
  var NOT_AFTER_WORD = "(?<!" + WORD + ")";
  var CALL = SPACE + "*\\." + SPACE + "*([A-Za-z_$][\\p{L}\\p{N}_$]*)" + SPACE + "*(?:\\." +
    SPACE + "*([A-Za-z_$][\\p{L}\\p{N}_$]*))?";

  // Cross-browser extensions almost always bind the API to a name of their
  // own — `var ext_api = (typeof browser === 'object') ? browser : chrome;`
  // and its many variants. A binding counts as an alias when its right-hand
  // side mentions `browser` or `chrome` as a value rather than as something
  // to read a property off.
  var ALIAS_RE = new RegExp(NOT_AFTER_WORD + "(?:var|let|const)" + SPACE + "+([A-Za-z_$][\\p{L}\\p{N}_$]*)" +
                            SPACE + "*=" + SPACE + "*([^;\\n\\r\\u2028\\u2029]*)(?:;|$)", "gmu");
  var BARE_API_RE = new RegExp(NOT_AFTER_WORD + "(?:browser|chrome)(?!" + WORD + ")(?!" + SPACE +
                               "*\\.)", "u");

  var SKIP_DIRS = { "node_modules": true, ".git": true, "_metadata": true, "META-INF": true };

  function sources(tree) {
    var out = [];
    tree.walk("", SKIP_DIRS).forEach(function (entry) {
      entry.files.forEach(function (name) {
        if (/\.(js|mjs|html|htm)$/.test(name)) {
          var path = W2S.tree.join(entry.dir, name);
          out.push({ path: path, text: bytes.text(tree.read(path)) });
        }
      });
    });
    return out;
  }

  function findAliases(texts) {
    var aliases = Object.create(null);
    texts.forEach(function (text) {
      ALIAS_RE.lastIndex = 0;
      var match;
      while ((match = ALIAS_RE.exec(text))) {
        if (match[0] === "") {
          ALIAS_RE.lastIndex++;
        }
        var name = match[1];
        if (name !== "chrome" && name !== "browser" && BARE_API_RE.test(match[2])) {
          aliases[name] = true;
        }
      }
    });
    return Object.keys(aliases).sort(W2S.tree.compare);
  }

  // Namespaces of Chrome's and Firefox's that the table does not grade, so
  // that a call through an alias is known for one.
  var OTHER_NAMESPACES = ["accessibilityFeatures", "browserSettings", "captivePortal", "certificateProvider",
    "clipboard", "contentSettings", "documentScan", "enterprise", "find", "fontSettings", "identity",
    "input", "instanceID", "loginState", "pkcs11", "platformKeys", "power", "readingList",
    "storage", "ttsEngine", "vpnProvider", "wallpaper", "webAuthenticationProxy",
    "fileBrowserHandler", "fileSystemProvider", "normandyAddonStudy", "geckoProfiler", "sidebarAction",
    "test", "types", "events"];

  function knownNamespace(name) {
    return Object.prototype.hasOwnProperty.call(SUPPORT, name) || OTHER_NAMESPACES.indexOf(name) >= 0 ||
      Object.keys(SUPPORT).some(function (key) {
        return key.split(".")[0] === name;
      });
  }

  // The members of the namespaces Chrome's schema does not describe, as
  // the runtime has none of them.
  var UNDESCRIBED_MEMBERS = {
    bookmarks: ["create", "get", "getChildren", "getRecent", "getSubTree", "getTree", "move", "remove",
      "removeTree", "search", "update", "onChanged", "onChildrenReordered", "onCreated",
      "onImportBegan", "onImportEnded", "onMoved", "onRemoved"],
    history: ["addUrl", "deleteAll", "deleteRange", "deleteUrl", "getVisits", "search", "onTitleChanged",
      "onVisitRemoved", "onVisited"],
    search: ["get", "query", "search"],
    theme: ["getCurrent", "reset", "update", "onUpdated"],
    topSites: ["get"],
    gcm: ["register", "unregister", "send", "onMessage", "onMessagesDeleted", "onSendError"],
    tabCapture: ["capture", "getCapturedTabs", "getMediaStreamId", "onStatusChanged"],
    printerProvider: ["onGetPrintersRequested", "onGetUsbPrinterInfoRequested", "onGetCapabilityRequested",
      "onPrintRequested"],
    contentScripts: ["register"],
    browserSettings: [], contentSettings: [], fontSettings: [], wallpaper: [],
    readingList: ["addEntry", "query", "removeEntry", "updateEntry", "onEntryAdded", "onEntryRemoved",
      "onEntryUpdated"]
  };
  // Properties that are neither functions, events nor types.
  var PROPERTIES = {
    runtime: ["id", "lastError"], extension: ["inIncognitoContext", "lastError"],
    storage: ["local", "managed", "session", "sync"], tabs: ["TAB_ID_NONE", "TAB_INDEX_NONE"],
    windows: ["WINDOW_ID_CURRENT", "WINDOW_ID_NONE"], tabGroups: ["TAB_GROUP_ID_NONE"],
    contextMenus: ["ACTION_MENU_TOP_LEVEL_LIMIT"], devtools: ["inspectedWindow", "network", "panels"],
    privacy: ["network", "services", "websites"], proxy: ["settings"]
  };

  // Whether `member` is one of namespace `ns`'s in `schema` (Chrome's, as
  // the runtime carries it), where the schema or the table above tells.
  function isMember(schema, ns, member) {
    if (PROPERTIES[ns] && PROPERTIES[ns].indexOf(member) >= 0) {
      return true;
    }
    var described = schema && schema[ns];
    if (described) {
      var names = [];
      (described.functions || []).forEach(function (f) { names.push(f.name); });
      (described.events || []).forEach(function (e) { names.push(typeof e === "string" ? e : e.name); });
      (described.types || []).forEach(function (t) { names.push(String(t.id || t.name || "").split(".").pop()); });
      return names.indexOf(member) >= 0 || !!schema[ns + "." + member];
    }
    if (Object.prototype.hasOwnProperty.call(UNDESCRIBED_MEMBERS, ns)) {
      return UNDESCRIBED_MEMBERS[ns].indexOf(member) >= 0;
    }
    return !schema;
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // Counts every call made through the extension API in `tree`. A name the
  // extension binds the API to is often a short one minified code reuses
  // for anything (`e`), so what it is used for counts only where it names a
  // member of an extension namespace, as Chrome's `schema` tells when given.
  function scan(tree, schema) {
    var files = sources(tree);
    var aliases = findAliases(files.map(function (f) { return f.text; }));
    var patterns = [new RegExp(NOT_AFTER_WORD + "(?:chrome|browser)" + CALL, "gu")]
      .concat(aliases.map(function (alias) {
        // Python's \b before a "$" asks for a word character in front of it.
        var boundary = alias.charAt(0) === "$" ? "(?<=" + WORD + ")" : NOT_AFTER_WORD;
        return new RegExp(boundary + escapeRegExp(alias) + CALL, "gu");
      }));
    var usage = Object.create(null);
    files.forEach(function (file) {
      patterns.forEach(function (pattern, index) {
        pattern.lastIndex = 0;
        var match;
        while ((match = pattern.exec(file.text))) {
          // What a supposed alias is used for counts only where it names a
          // member of an extension namespace.
          if (index > 0 && (!match[2] || !knownNamespace(match[1]) ||
              !isMember(schema, match[1], match[2]))) {
            continue;
          }
          var key = match[2] ? match[1] + "." + match[2] : match[1];
          var entry = usage[key] || (usage[key] = { count: 0, files: Object.create(null) });
          entry.count++;
          entry.files[file.path] = true;
        }
      });
    });
    return usage;
  }

  // The support verdict for one API key, falling back to its namespace.
  function grade(key) {
    if (Object.prototype.hasOwnProperty.call(SUPPORT, key)) {
      return SUPPORT[key];
    }
    var namespace = key.split(".")[0];
    if (Object.prototype.hasOwnProperty.call(SUPPORT, namespace)) {
      return SUPPORT[namespace];
    }
    return [null, null];
  }

  function firstFiles(entry) {
    return Object.keys(entry.files).sort(W2S.tree.compare).slice(0, 3);
  }

  // Groups the scanned usage into buckets by verdict.
  function summarise(usage) {
    var buckets = {};
    buckets[FULL] = [];
    buckets[PARTIAL] = [];
    buckets[NONE] = [];
    buckets.unknown = [];
    var namespaces = Object.create(null);
    var keys = Object.keys(usage).sort(W2S.tree.compare);

    keys.forEach(function (key) {
      var namespace = key.split(".")[0];
      var verdict = grade(key);
      // An object read without a call ("chrome.tabs") only matters as evidence
      // the namespace is used at all.
      if (key.indexOf(".") < 0) {
        namespaces[namespace] = true;
        return;
      }
      // A name no extension namespace has is the text's own, as in
      // "chrome.google.com" or a sentence that ends in "browser.".
      if (!verdict[0] && !knownNamespace(namespace)) {
        return;
      }
      buckets[verdict[0] || "unknown"].push([key, verdict[1], usage[key].count, firstFiles(usage[key])]);
    });

    Object.keys(namespaces).sort(W2S.tree.compare).forEach(function (namespace) {
      if (keys.some(function (k) { return k.indexOf(namespace + ".") === 0; })) {
        return;
      }
      var verdict = grade(namespace);
      if (!verdict[0] && !knownNamespace(namespace)) {
        return;
      }
      buckets[verdict[0] || "unknown"].push([namespace, verdict[1], usage[namespace].count,
                                             firstFiles(usage[namespace])]);
    });
    return buckets;
  }

  function pad(value, width) {
    return value.length >= width ? value : value + new Array(width - value.length + 1).join(" ");
  }

  function padStart(value, width) {
    return value.length >= width ? value : new Array(width - value.length + 1).join(" ") + value;
  }

  // A readable report.
  function render(buckets, manifestNotes, conversionNotes) {
    var lines = [];

    function section(title, entries) {
      if (!entries.length) {
        return;
      }
      lines.push(title);
      entries.forEach(function (entry) {
        var suffix = entry[1] ? " — " + entry[1] : "";
        lines.push("    " + pad(entry[0], 38) + " " + padStart(String(entry[2]), 3) + " call" +
                   (entry[2] === 1 ? "" : "s") + suffix);
        lines.push("        " + entry[3].join(", "));
      });
      lines.push("");
    }

    if (conversionNotes.length) {
      lines.push("Conversion");
      conversionNotes.forEach(function (note) { lines.push("    - " + note); });
      lines.push("");
    }
    if (manifestNotes.length) {
      lines.push("Manifest");
      manifestNotes.forEach(function (note) { lines.push("    - " + note); });
      lines.push("");
    }

    section("Unavailable — these calls fail or do nothing", buckets[NONE]);
    section("Degraded — these behave differently here", buckets[PARTIAL]);
    section("Not recognised — check these by hand", buckets.unknown);
    section("Supported", buckets[FULL]);

    return lines.join("\n").replace(/\s+$/, "") + "\n";
  }

  W2S.analyze = {
    SUPPORT: SUPPORT,
    scan: scan,
    grade: grade,
    summarise: summarise,
    render: render,
    findAliases: findAliases
  };
})(typeof globalThis.W2S === "object" ? globalThis.W2S : (globalThis.W2S = {}));
