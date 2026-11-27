// Exercises the runtime layer against the fake Safari API.
//
// Run against a converted bundle:
//     node tests/run.js build/Example.safariextension
// or, with no argument, against a small fixture bundle built on the fly.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { FakeBrowser } = require("./fake-safari");

const ROOT = path.resolve(__dirname, "..");
const RUNTIME = path.join(ROOT, "webext2safari", "runtime");

// ------------------------------------------------------------------ //
// Assertions
// ------------------------------------------------------------------ //
let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
  } else {
    failures.push(name + (detail ? " — " + detail : ""));
  }
}

function equal(name, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, same, same ? "" : "got " + JSON.stringify(actual) +
    ", expected " + JSON.stringify(expected));
}

// scripting.executeScript's results without the document ids, which are random.
function injected(results) {
  return results.map((r) => ({ frameId: r.frameId, result: r.result }));
}

function settle(ms) {
  // Let every queued callback and zero-delay timer run.
  return new Promise((resolve) => setTimeout(resolve, ms || 30));
}

// ------------------------------------------------------------------ //
// A fixture bundle
// ------------------------------------------------------------------ //
function buildFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wex-fixture-"));
  fs.mkdirSync(path.join(dir, "wex"));
  fs.mkdirSync(path.join(dir, "_locales", "en"), { recursive: true });

  for (const name of ["wex-core.js", "wex-global.js", "wex-page.js", "wex-content.js",
                      "wex-run-start.js", "wex-run-end.js"]) {
    fs.copyFileSync(path.join(RUNTIME, name), path.join(dir, "wex", name));
  }
  for (const name of ["public-suffix-list.txt", "permission-messages.json", "cld3.wasm", "cld3.json"]) {
    fs.copyFileSync(path.join(RUNTIME, name), path.join(dir, "wex", name));
  }
  // The fixture's calls go unchecked; the checks have tests of their own.
  for (const name of ["wex-api.js", "wex-content-api.js"]) {
    fs.writeFileSync(path.join(dir, "wex", name), "var WEX_API = null;\n");
  }

  fs.writeFileSync(path.join(dir, "_locales", "en", "messages.json"), JSON.stringify({
    appName: { message: "Fixture" },
    greeting: { message: "Hello $WHO$", placeholders: { who: { content: "$1" } } }
  }));

  fs.writeFileSync(path.join(dir, "content-a.js"),
    "window.__contentA = (window.__contentA || 0) + 1;\nconst contentShared = 3;\n" +
    "class ContentHelper { value() { return 4; } }");
  fs.mkdirSync(path.join(dir, "wex", "content", "1"), { recursive: true });
  fs.writeFileSync(path.join(dir, "wex", "content", "1", "late.js"), "var lateCopy = 1;");
  fs.writeFileSync(path.join(dir, "content-b.js"),
    "'use strict';\nwindow.__contentB = (window.__contentB || 0) + 1;\n" +
    "window.__sharedSeen = typeof contentShared === 'number' ? contentShared + new ContentHelper().value() : null;\n" +
    "function contentStrictHelper() { return 5; }\n" +
    "{ var blockVar = 6; }\nif (true) { try { var nestedVar = 8; } catch (e) {} }\n" +
    "for (var loopVar = 0; loopVar < 1; loopVar++) {}\n" +
    "(function () { var functionVar = 9; })();\nvar objectHolder = { a: function () { var methodVar = 1; } };");
  fs.writeFileSync(path.join(dir, "injected.js"), "42;");
  fs.writeFileSync(path.join(dir, "declares.js"), "const declaredConstant = 42;");
  fs.writeFileSync(path.join(dir, "uses.js"), "declaredConstant + 1;");
  fs.writeFileSync(path.join(dir, "auto-size.js"), "WEX.CONFIG.autoSizePopover = true;");
  fs.writeFileSync(path.join(dir, "throws.js"), "throw new TypeError('a file that throws');");
  fs.writeFileSync(path.join(dir, "unparsable.js"), "this is not ( javascript");
  fs.writeFileSync(path.join(dir, "marks.js"), "var filesReached = (typeof filesReached === 'number' ? filesReached : 0) + 1;\nfilesReached;");
  fs.writeFileSync(path.join(dir, "imported.js"), "var importedValue = 7;\nconst importedConstant = 8;");
  fs.writeFileSync(path.join(dir, "imported-user.js"), "var importedSum = importedValue + importedConstant;");
  fs.writeFileSync(path.join(dir, "imported-failing.js"), "throw new Error('import failed');");
  fs.writeFileSync(path.join(dir, "content.css"), "body { color: red; }");
  fs.writeFileSync(path.join(dir, "icon.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><text>é # &amp;</text></svg>');
  fs.writeFileSync(path.join(dir, "serverlist.txt"), "one\ntwo\n");
  fs.writeFileSync(path.join(dir, "rules.json"), JSON.stringify([
    { id: 1, priority: 1, action: { type: "block" },
      condition: { urlFilter: "||tracker.example^", resourceTypes: ["script", "image"] } },
    { id: 2, priority: 1, action: { type: "allow" }, condition: { urlFilter: "||trusted.example^" } }
  ]));
  fs.writeFileSync(path.join(dir, "extra-rules.json"), JSON.stringify([]));
  fs.writeFileSync(path.join(dir, "Info.plist"), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
      '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    '<key>declarative_net_request</key><dict><key>rule_resources</key><array>',
    '<dict><key>enabled</key><true/><key>id</key><string>rules</string>',
    '<key>path</key><string>rules.json</string></dict>',
    '<dict><key>enabled</key><false/><key>id</key><string>extra</string>',
    '<key>path</key><string>extra-rules.json</string></dict>',
    '</array></dict>',
    '</dict></plist>'
  ].join("\n"));

  const config = {
    extensionId: "com.example.test",
    name: "Fixture",
    version: "1.2.3",
    manifest: { manifest_version: 3, name: "__MSG_appName__", version: "1.2.3",
      chrome_url_overrides: { newtab: "newtab.html" }, action: { default_popup: "popup.html" },
      update_url: "https://clients2.google.com/service/update2/crx",
      declarative_net_request: { rule_resources: [{ id: "rules", enabled: true, path: "rules.json" },
        { id: "extra", enabled: false, path: "extra-rules.json" }] },
      permissions: ["tabs", "storage", "webRequest", "webRequestBlocking", "webNavigation",
        "declarativeNetRequest", "cookies", "contextMenus", "alarms", "notifications", "scripting",
        "offscreen", "privacy", "tabGroups", "browsingData", "management", "nativeMessaging", "identity",
        "sidePanel", "debugger", "tts", "declarativeContent", "pageCapture", "gcm", "tabCapture", "userScripts",
        "<all_urls>"],
      omnibox: { keyword: "wx" },
      commands: { _execute_action: { suggested_key: { default: "Ctrl+Shift+Y" } },
        "do-thing": { suggested_key: { default: "Alt+T", mac: "MacCtrl+Shift+D" }, description: "Do it" },
        unbound: { description: "No key" } },
      side_panel: { default_path: "panel.html" },
      externally_connectable: { matches: ["https://example.com/*"] },
      optional_permissions: ["downloads"] },
    locales: ["en"],
    defaultLocale: "en",
    storage: "local",
    debug: false,
    contextMenus: true,
    popupPage: "popup.html",
    popupWidth: 400,
    popupHeight: 560,
    autoSizePopover: false,
    optionsPage: "options.html",
    popoverId: "wex-popover",
    toolbarId: "wex-toolbar",
    actionCommand: "wex-action",
    renamedFiles: { serverlist: "serverlist.txt" },
    identityRedirectURL: "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/",
    rulesetRuleCounts: { rules: 2, extra: 5 },
    responseHeaderRules: { rules: [{ id: 9, priority: 1,
      condition: { urlFilter: "||static-headers.example^", resourceTypes: ["xmlhttprequest"] },
      action: { type: "modifyHeaders", responseHeaders: [{ header: "x-static", operation: "set", value: "yes" }] } }] },
    backgroundPage: "wex-global-page.html",
    backgroundWorker: true,
    bridgeWhitelist: ["http://*/*", "https://*/*"],
    websiteAccess: "All",
    toolbarImages: { "icons/large.png": "wex/toolbar/icons/large.png" },
    injectedScripts: { files: {}, start: [], end: ["wex/content/1/late.js"] },
    contentScripts: [
      { matches: ["*://example.com/*"], js: ["content-a.js"], css: ["content.css"],
        run_at: "document_start", all_frames: false, match_about_blank: false },
      { matches: ["*://*/*"], exclude_matches: ["*://blocked.example/*"],
        js: ["/content-b.js"], css: [], run_at: "document_end",
        all_frames: true, match_about_blank: false }
    ]
  };
  fs.writeFileSync(path.join(dir, "wex", "wex-config.js"),
    "var WEX_CONFIG = " + JSON.stringify(config, null, 2) + ";\n");
  // The bridge's files as one, as the converter gives them to Safari.
  fs.writeFileSync(path.join(dir, "wex", "wex-bridge.js"),
    ["wex-config.js", "wex-content-api.js", "wex-core.js", "wex-content.js", "wex-run-start.js"]
      .map((name) => fs.readFileSync(path.join(dir, "wex", name), "utf8")).join("\n;\n") + "\n");

  return dir;
}

// ------------------------------------------------------------------ //
// The run
// ------------------------------------------------------------------ //
async function main() {
  const bundle = process.argv[2] ? path.resolve(process.argv[2]) : buildFixture();
  const wex = (name) => path.join(bundle, "wex", name);

  // A page that names no charset reads its scripts as Latin-1.
  const nonAscii = fs.readdirSync(RUNTIME).filter((name) => name.endsWith(".js") &&
    /[^\x00-\x7f]/.test(fs.readFileSync(path.join(RUNTIME, name), "utf8")));
  equal("the runtime's scripts are ASCII", nonAscii, []);

  const browser = new FakeBrowser(bundle, { bundleId: "com.example.test-TEAM123" });
  const window0 = browser.openWindow();
  const tab = window0.openTab();
  tab.url = "https://example.com/page";
  tab.title = "Example";
  window0.activeTab = tab;

  // One tab is open before the extension loads and one opens after, so both
  // ways of learning a tab's identity are exercised.
  await settle();
  const stalePopover = [];
  browser.popover.contentWindow = {
    chrome: { __wex: true },
    location: { reload: () => stalePopover.push("reload"), replace: (url) => stalePopover.push(url) }
  };

  // WebKit's input from extensions and Web Inspector access, which record
  // what they are asked; the backend answers evaluations of the expressions
  // the debugger tests use.
  const aquaCalls = [];
  const inspectorListeners = { message: [], detach: [] };
  const toInspector = (tabId, message) => setTimeout(() => {
    inspectorListeners.message.forEach((fn) => fn(tabId, JSON.stringify(message)));
  }, 0);
  const fromPage = (tabId, message) => toInspector(tabId, {
    method: "Target.dispatchMessageFromTarget", params: { targetId: "page-1", message: JSON.stringify(message) }
  });
  const PAGE_ANSWERS = {
    "Runtime.parse": () => ({ result: "none" }),
    "Runtime.evaluate": (params) => params.expression === "1 + 1"
      ? { result: { type: "number", value: 2, description: "2" }, wasThrown: false }
      : { result: { type: "object", subtype: "error", className: "SyntaxError", objectId: "e1",
        description: "SyntaxError: Return statements are only valid inside functions." }, wasThrown: true }
  };
  browser.aqua = {
    input: {
      dispatchMouseEvent: async (tabId, event) => { aquaCalls.push(["mouse", event]); },
      dispatchKeyEvent: async (tabId, event) => { aquaCalls.push(["key", event]); },
      insertText: async (tabId, text) => { aquaCalls.push(["text", text]); },
      performEditingAction: async (tabId, action) => {
        if (action === "redo:") {
          throw new Error("The action is disabled.");
        }
        aquaCalls.push(["edit", action]);
      }
    },
    dialog: {
      onOpen: { listeners: [], addListener(fn) { this.listeners.push(fn); },
        removeListener(fn) { this.listeners = this.listeners.filter((l) => l !== fn); } },
      open: null,
      answer: async (tabId, answer) => {
        if (!browser.aqua.dialog.open) {
          throw new Error("The tab has no open dialog.");
        }
        browser.aqua.dialog.open = null;
        aquaCalls.push(["answer", answer]);
      }
    },
    inspector: {
      onMessage: { addListener: (fn) => inspectorListeners.message.push(fn) },
      onDetach: { addListener: (fn) => inspectorListeners.detach.push(fn) },
      attach: async (tabId) => {
        aquaCalls.push(["attach"]);
        toInspector(tabId, { method: "Target.targetCreated", params: { targetInfo: { targetId: "page-1", type: "page" } } });
        await settle(5);
      },
      detach: async () => { aquaCalls.push(["detach"]); },
      sendMessage: async (tabId, text) => {
        const inner = JSON.parse(JSON.parse(text).params.message);
        aquaCalls.push(["page", inner.method]);
        const answer = PAGE_ANSWERS[inner.method];
        fromPage(tabId, { id: inner.id, result: answer ? answer(inner.params) : {} });
        if (inner.method === "Console.enable") {
          fromPage(tabId, { method: "Console.messageAdded", params: { message: { source: "console-api",
            level: "warning", type: "log", text: "careful", timestamp: 1700000000,
            parameters: [{ type: "string", value: "careful" }] } } });
        }
      }
    }
  };

  // A twin of the first tab, with the same address and title.
  const twin = window0.openTab("background");
  twin.url = tab.url;
  twin.title = tab.title;
  // Another tab open before the extension starts.
  const quietTab = window0.openTab("background");
  quietTab.url = "https://quiet.example/page";
  quietTab.title = "Quiet";
  await settle();

  // The extension as Safari runs it.
  const globalPage = browser.createGlobalPage([
    wex("wex-config.js"), wex("wex-core.js"), wex("wex-global.js")
  ]);
  equal("a hidden popup the global page finds on its start goes back to the popover's blank page",
    stalePopover, [browser.baseURI + "wex/wex-popover.html"]);
  {
    const found = await globalPage.chrome.tabs.query({ url: "https://quiet.example/*" });
    equal("a tab open before the extension started has WebKit's id",
      found.map((t) => t.id), [quietTab.engineId]);
    quietTab.close();
    await settle(20);
  }

  // -- workers ------------------------------------------------------------
  // A worker an extension page starts runs from a blob that first installs
  // the fixes the page has; Safari serves the extension's files to it with
  // status 0, and the worker sees its own file's location.
  {
    const base = globalPage.WEX.baseURI;
    const blobs = {};
    const started = [];
    const PageURL = function (url, relative) { return new URL(url, relative); };
    PageURL.createObjectURL = (blob) => {
      const url = "blob:" + base + Object.keys(blobs).length;
      blobs[url] = blob.text;
      return url;
    };
    const readable = {};
    const page = {
      XMLHttpRequest: class {
        open(method, url) { this.url = url; }
        send() {
          if (!(this.url in readable)) {
            throw new Error("NetworkError: Load failed");
          }
          this.responseText = readable[this.url];
        }
      },
      URL: PageURL,
      Blob: class { constructor(parts) { this.text = parts.join(""); } },
      location: { href: base + "index.html" },
      Worker: function (url, options) { started.push([url, options]); }
    };
    globalPage.WEX.installWorkerFixups(page);
    function runWorker(source) {
      const imported = [];
      const fetched = [];
      const worker = vm.createContext({ URL, Headers, Response, Promise, JSON, Object, Array, String });
      worker.self = worker;
      Object.defineProperty(worker, "location", { configurable: true, get: () => new URL("blob:" + base + "w") });
      worker.importScripts = (...urls) => { imported.push(...urls); };
      worker.fetch = (input) => {
        const url = typeof input === "string" ? input : input.url;
        fetched.push(url);
        return Promise.resolve({ status: 0, type: "basic", url, headers: new Headers(),
          arrayBuffer: () => Promise.resolve(new TextEncoder().encode("{}").buffer) });
      };
      vm.runInContext(source, worker);
      return { worker, imported, fetched };
    }
    new page.Worker("workers/game.js");
    const fromFile = runWorker(blobs[started[0][0]]);
    const response = await fromFile.worker.fetch("data.json");
    equal("a worker started from a file keeps its location, relative URLs and file statuses",
      [fromFile.imported, fromFile.worker.location.href, fromFile.fetched, response.status, response.ok,
        response.headers.get("content-type")],
      [[base + "workers/game.js"], base + "workers/game.js", [base + "workers/data.json"], 200, true,
        "application/json"]);
    readable["blob:" + base + "made-by-the-page"] = "self.ranOwnScript = true;";
    new page.Worker("blob:" + base + "made-by-the-page");
    const fromBlob = runWorker(blobs[started[1][0]]);
    equal("and one started from a blob runs its script, read when the worker was made, after the status fix",
      [fromBlob.imported, fromBlob.worker.ranOwnScript, (await fromBlob.worker.fetch(base + "data.json")).status],
      [[], true, 200]);
    new page.Worker("blob:" + base + "already-revoked");
    equal("while a blob that can no longer be read starts the worker as it is",
      started[2][0], "blob:" + base + "already-revoked");
    started.splice(2, 1);
    new page.Worker("workers/module.js", { type: "module" });
    equal("a module worker imports the fixes, then its own module",
      [blobs[started[2][0]].match(/^import "(blob:[^"]+)";\nimport "([^"]+)";\n$/).slice(2), started[2][1]],
      [[base + "workers/module.js"], { type: "module" }]);
    new page.Worker("https://example.com/w.js");
    equal("and a worker from elsewhere is started as it is", started[3][0], "https://example.com/w.js");
  }
  browser.popover.contentWindow = null;
  const chrome = globalPage.chrome;
  const bridgeRegistrations = browser.contentScripts.slice();
  equal("after an update that changed the injected list, the bridge is registered at both document phases, " +
    "and the content script copies after it",
    bridgeRegistrations.map((entry) => [entry.whitelist, entry.atEnd]).concat([bridgeRegistrations[2].source]),
    [[["http://*/*", "https://*/*"], false], [["http://*/*", "https://*/*"], true],
      [["http://*/*", "https://*/*"], true], "var lateCopy = 1;"]);

  check("the global page exposes chrome", !!chrome);
  {
    // A background made for a service worker may put an XMLHttpRequest shim
    // of its own on the global, or wrap the methods of the page's; the
    // runtime still reads the bundle with the page's own.
    const PageXHR = globalPage.XMLHttpRequest;
    const open = PageXHR.prototype.open;
    globalPage.XMLHttpRequest = function Shim() { throw new Error("a shim answers asynchronously only"); };
    PageXHR.prototype.open = function () { throw new Error("recorded and refused"); };
    const read = globalPage.WEX.readTextSync("wex/wex-config.js");
    globalPage.XMLHttpRequest = PageXHR;
    PageXHR.prototype.open = open;
    check("the runtime reads the bundle with the page's own XMLHttpRequest, whatever the extension made of it",
      typeof read === "string" && read.indexOf("WEX_CONFIG") >= 0);
  }
  {
    // The worker's own localStorage, and the runtime's records in the real one.
    const realStore = globalPage.localStorage;
    vm.runInContext('"use strict"; self.localStorage = { mine: true };', browser.globalPageContext);
    const replaced = globalPage.localStorage;
    globalPage.WEX.localStorageOf(vm.runInContext("this", browser.globalPageContext)).setItem("wex.probe", "1");
    equal("a service worker can give its global a localStorage of its own, and the runtime keeps the real one",
      [replaced.mine, realStore.getItem("wex.probe"), globalPage.navigator instanceof globalPage.WorkerNavigator],
      [true, "1", true]);
    realStore.removeItem("wex.probe");
    Object.defineProperty(globalPage, "localStorage", { configurable: true, enumerable: true, get: () => realStore });
  }
  const announcements = [];
  chrome.runtime.onInstalled.addListener((d) => announcements.push(["installed", d.reason]));
  chrome.runtime.onExtensionLoaded.addListener((d) => announcements.push(["loaded", d.reason]));
  // Every event Chrome's schema gives a namespace the extension has is
  // there to listen to: a missing one throws as a background registers it.
  {
    const api = JSON.parse(fs.readFileSync(path.join(RUNTIME, "chrome-api.json"), "utf8"));
    const missing = [];
    for (const ns of Object.keys(api)) {
      const area = ns.split(".").reduce((o, k) => o && o[k], chrome);
      if (!area) {
        continue;
      }
      for (const name of api[ns].events || []) {
        const limits = (api[ns].eventLimits || {})[name] || {};
        const manifest = globalPage.WEX.CONFIG.manifest;
        if (limits.minManifestVersion > manifest.manifest_version ||
            limits.maxManifestVersion < manifest.manifest_version ||
            (limits.permissions || []).some((p) => manifest.permissions.indexOf(p) < 0)) {
          continue;
        }
        const method = (api[ns].ruleEvents || []).indexOf(name) >= 0 ? "addRules" : "addListener";
        if (!area[name] || typeof area[name][method] !== "function") {
          missing.push(ns + "." + name);
        }
      }
    }
    equal("each namespace has every event of Chrome's", missing, []);
  }
  globalPage.importScripts("imported.js");
  equal("a service worker's importScripts runs the script in the global scope",
    globalPage.importedValue, 7);
  globalPage.importScripts("imported-user.js");
  equal("where a later script sees its top-level constants",
    globalPage.importedSum, 15);
  equal("and what an imported script throws is thrown to the caller",
    (() => {
      try {
        globalPage.importScripts("imported-failing.js");
      } catch (e) {
        return e.message;
      }
      return "nothing thrown";
    })(), "import failed");
  // A Chrome build finds Chrome: its user agent and client hints, and
  // neither Firefox's `browser` nor Safari's `safari`.
  equal("a Chrome build's global page finds Chrome, and keeps Safari's object, which Safari reads",
    [typeof globalPage.browser, typeof globalPage.safari, /Chrome\/156\.0\.0\.0 Safari\/537\.36$/.test(globalPage.navigator.userAgent),
      globalPage.navigator.vendor, globalPage.navigator.userAgentData.brands[0].brand],
    ["undefined", "object", true, "Google Inc.", "Google Chrome"]);
  const firefoxWorld = { console, navigator: { userAgent: "Safari" },
    safari: { extension: { baseURI: "safari-extension://com.example-TEAM/abc/" } } };
  firefoxWorld.self = firefoxWorld;
  vm.createContext(firefoxWorld);
  vm.runInContext("var WEX_CONFIG = " + JSON.stringify({ firefoxBuild: true, manifest: {
    browser_specific_settings: { gecko: { strict_min_version: "160.0" } } } }) + ";", firefoxWorld);
  vm.runInContext(fs.readFileSync(wex("wex-core.js"), "utf8"), firefoxWorld);
  firefoxWorld.browser = { runtime: {} };
  firefoxWorld.WEX.presentBrowser(firefoxWorld);
  equal("a Firefox build finds Firefox, at the least version its manifest asks for",
    [firefoxWorld.navigator.userAgent, typeof firefoxWorld.browser, typeof firefoxWorld.safari,
      firefoxWorld.navigator.vendor, "userAgentData" in firefoxWorld.navigator,
      firefoxWorld.WEX.browserIdentity().version],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:160.0) Gecko/20100101 Firefox/160.0",
      "object", "undefined", "", false, "160.0"]);
  const firefoxHas = (manifest) => {
    const world = { console, navigator: {}, safari: { extension: { baseURI: "safari-extension://x-TEAM/abc/" } } };
    world.self = world;
    vm.createContext(world);
    vm.runInContext("var WEX_CONFIG = " + JSON.stringify({ firefoxBuild: true, manifest }) + ";", world);
    vm.runInContext(fs.readFileSync(wex("wex-core.js"), "utf8"), world);
    return ["theme", "contentScripts", "menus", "sidebarAction", "action", "browserAction", "pageAction"]
      .filter((name) => world.WEX.namespaceGranted(name));
  };
  {
    const world = { console, navigator: {}, safari: { extension: { baseURI: "safari-extension://x-TEAM/abc/" } } };
    world.self = world;
    vm.createContext(world);
    vm.runInContext("var WEX_CONFIG = " + JSON.stringify({ firefoxBuild: true, manifest: {} }) + ";", world);
    vm.runInContext(fs.readFileSync(wex("wex-core.js"), "utf8"), world);
    const event = () => ({ addListener() {}, removeListener() {}, hasListener() { return false; } });
    const engineRequest = { filterResponseData: (id) => ({ filtered: id }) };
    ["onBeforeRequest", "onBeforeSendHeaders", "onSendHeaders", "onHeadersReceived", "onAuthRequired",
      "onResponseStarted", "onBeforeRedirect", "onCompleted", "onErrorOccurred"].forEach((name) => {
      engineRequest[name] = event();
    });
    const firefoxRequest = world.WEX.makeWebRequest({ webRequest: engineRequest });
    equal("a Firefox build filters responses with the engine's filters", firefoxRequest.filterResponseData("7"),
      { filtered: "7" });
    {
      // Firefox shows an extension no request for its own files.
      const registered = [];
      engineRequest.onBeforeRequest = { addListener: (fn) => registered.push(fn), removeListener() {},
        hasListener() { return false; } };
      const ownRequest = world.WEX.makeWebRequest({ webRequest: engineRequest });
      const heard = [];
      ownRequest.onBeforeRequest.addListener((d) => { heard.push(d.url); }, { urls: ["<all_urls>"] }, ["blocking"]);
      registered.forEach((fn) => {
        fn({ url: "safari-extension://x-TEAM/abc/bg/main.js", tabId: -1, type: "script" });
        fn({ url: "https://example.com/a.js", tabId: -1, type: "script" });
      });
      equal("and a Firefox build's listeners hear no request for its own files", heard, ["https://example.com/a.js"]);
    }
    check("and a Chrome build has none", !("filterResponseData" in chrome.webRequest));
  }
  equal("a Firefox build has Firefox's namespaces, as its manifest gives them, and theme to read without the permission",
    [firefoxHas({ manifest_version: 2, browser_action: {}, sidebar_action: {}, permissions: ["menus", "theme"] }),
      firefoxHas({ manifest_version: 3, action: {} })],
    [["theme", "contentScripts", "menus", "sidebarAction", "browserAction"], ["theme", "contentScripts", "action"]]);
  const chromeWorld = (manifest) => {
    const world = { console, navigator: {}, setTimeout, safari: { extension: { baseURI: "safari-extension://x-TEAM/abc/" } } };
    world.self = world;
    vm.createContext(world);
    vm.runInContext("var WEX_CONFIG = " + JSON.stringify({ manifest }) + ";", world);
    vm.runInContext(fs.readFileSync(wex("wex-core.js"), "utf8"), world);
    const runtime = {};
    world.WEX.addNativeMessaging(runtime);
    return ["storage", "management", "declarativeNetRequest"].filter((name) => world.WEX.namespaceGranted(name))
      .concat(Object.keys(runtime), [world.WEX.openFunctions("management")]);
  };
  equal("declarativeNetRequest is there only for a manifest that asks for it",
    [chromeWorld({ manifest_version: 3 }).includes("declarativeNetRequest"),
      chromeWorld({ manifest_version: 3, permissions: ["declarativeNetRequest"] }).includes("declarativeNetRequest")],
    [false, true]);
  equal("storage and native messaging come only with their permissions, and management whole only with its",
    [chromeWorld({ manifest_version: 3 }),
      chromeWorld({ manifest_version: 3, permissions: ["storage", "management"], optional_permissions: ["nativeMessaging"] })],
    [["management", ["getSelf", "uninstallSelf", "getPermissionWarningsByManifest"]],
      ["storage", "management", "connectNative", "sendNativeMessage", null]]);
  equal("a Chrome build, Chrome's",
    ["theme", "contentScripts", "menus", "sidebarAction", "action", "browserAction", "pageAction"]
      .filter((name) => name in chrome), ["action"]);
  check("and the runtime keeps Safari's object for itself",
    firefoxWorld.WEX.safari === firefoxWorld.__wexSafari && !!firefoxWorld.__wexSafari.extension);
  equal("a service worker finds itself active, with a registration",
    [globalPage.serviceWorker.state, globalPage.registration.active === globalPage.serviceWorker,
     await globalPage.skipWaiting()],
    ["activated", true, undefined]);

  // -- URLs -----------------------------------------------------------
  equal("getURL resolves a relative path",
    chrome.runtime.getURL("images/icon.png"),
    browser.baseURI + "images/icon.png");
  equal("getURL keeps an absolute URL untouched",
    chrome.runtime.getURL("https://example.com/x"), "https://example.com/x");
  equal("getURL resolves a root-relative path against the bundle",
    chrome.runtime.getURL("/images/icon.png"),
    browser.baseURI + "images/icon.png");
  equal("getURL does not double the session token",
    chrome.runtime.getURL("/AB12CD34/popup.html"),
    browser.baseURI + "popup.html");
  equal("getURL resolves dot segments, none above the extension's root",
    ["./build.info", "a/./b/../c.js?x=../y", "../../up.html", "/dir/..", "dir/."].map((p) => chrome.runtime.getURL(p)),
    ["build.info", "a/c.js?x=../y", "up.html", "", "dir/"].map((p) => browser.baseURI + p));

  // -- i18n and the manifest -----------------------------------------
  equal("i18n reads the bundled catalogue", chrome.i18n.getMessage("appName"), "Fixture");
  equal("i18n fills named placeholders",
    chrome.i18n.getMessage("greeting", ["world"]), "Hello world");
  equal("i18n looks names up case-insensitively",
    chrome.i18n.getMessage("APPNAME"), "Fixture");
  equal("i18n gives the messages every extension has",
    ["@@extension_id", "@@ui_locale", "@@bidi_dir", "@@bidi_reversed_dir", "@@BIDI_START_EDGE", "@@bidi_end_edge"]
      .map((name) => chrome.i18n.getMessage(name)),
    [chrome.runtime.id, String(globalPage.navigator.language || "en").replace(/-/g, "_"), "ltr", "rtl", "left", "right"]);
  equal("getManifest localises __MSG__ references",
    chrome.runtime.getManifest().name, "Fixture");
  {
    // A text's languages, as Chrome tells them, with its own detector, CLD3:
    // a line of kanji with a single kana word is Chinese to it, as in Chrome.
    const top = async (text) => {
      const found = await chrome.i18n.detectLanguage(text);
      return found.languages.length ? found.languages[0].language : null;
    };
    const samples = {
      ja: "任天堂の公式サイトです。新しいゲームの情報や最新のニュースをお届けします。ニンテンドースイッチのソフトを紹介しています。",
      kanjiHeavy: "任天堂株式会社公式情報。新作発表会開催決定、詳細後日発表予定です。",
      zh: "这是一个关于中国历史和文化的网站，我们提供最新的新闻和信息，欢迎大家访问和阅读。",
      ko: "닌텐도 공식 홈페이지입니다. 새로운 게임 정보와 최신 뉴스를 전해 드립니다.",
      en: "The quick brown fox jumps over the lazy dog while the children watch from the window of their house.",
      fr: "Le renard brun rapide saute par-dessus le chien paresseux pendant que les enfants regardent depuis la fenêtre.",
      de: "Der schnelle braune Fuchs springt über den faulen Hund, während die Kinder aus dem Fenster ihres Hauses schauen.",
      es: "El rápido zorro marrón salta sobre el perro perezoso mientras los niños miran desde la ventana de su casa.",
      ru: "Быстрая коричневая лиса прыгает через ленивую собаку, пока дети смотрят из окна своего дома.",
      uk: "Швидка руда лисиця перестрибує через лінивого собаку, поки діти дивляться з вікна свого будинку і їхня мати готує їжу.",
      ar: "الثعلب البني السريع يقفز فوق الكلب الكسول بينما يشاهد الأطفال من نافذة منزلهم.",
      hi: "तेज़ भूरी लोमड़ी आलसी कुत्ते के ऊपर कूदती है जबकि बच्चे अपने घर की खिड़की से देखते हैं।"
    };
    const found = {};
    for (const name of Object.keys(samples)) {
      found[name] = await top(samples[name]);
    }
    equal("i18n.detectLanguage tells a text's language as Chrome's CLD3 does", found,
      { ja: "ja", kanjiHeavy: "zh", zh: "zh", ko: "ko", en: "en", fr: "fr", de: "de", es: "es", ru: "ru", uk: "uk",
        ar: "ar", hi: "hi" });
    const mixed = await chrome.i18n.detectLanguage(samples.ja + " " + samples.en + " " + samples.ja + samples.ja);
    equal("a page in two writing systems gives each language its share, and a reliable one leads",
      [mixed.isReliable, mixed.languages[0].language, mixed.languages[0].percentage > 60,
        mixed.languages.some((l) => l.language === "en")],
      [true, "ja", true, true]);
    equal("a text under 50 bytes is never reliable, and one CLD3 cannot place gives no language",
      [await chrome.i18n.detectLanguage("OK"), await chrome.i18n.detectLanguage("")],
      [{ isReliable: false, languages: [{ language: "pl", percentage: 100 }] }, { isReliable: false, languages: [] }]);
  }

  // -- addresses built from the extension's origin -----------------------
  const bundleRoot = chrome.runtime.getURL("");
  const bareOrigin = bundleRoot.replace(/^([a-z][a-z0-9+.\-]*:\/\/[^\/]*).*$/i, "$1");
  equal("a path resolved against the extension's origin names a file of the bundle, and for a " +
    "service worker the page Chrome generates for background scripts names nothing it has",
    [new globalPage.URL("/_generated_background_page.html", bareOrigin).href,
     new globalPage.URL("options.html", bareOrigin + "/").href],
    [bundleRoot + "_generated_background_page.html", bundleRoot + "options.html"]);
  equal("while other bases resolve as they always do",
    [new globalPage.URL("x.js", bundleRoot + "a/").href,
     new globalPage.URL("/x", "https://example.com/y").href],
    [bundleRoot + "a/x.js", "https://example.com/x"]);
  check("and the constructor is still URL's",
    new globalPage.URL("https://example.com/") instanceof globalPage.URL &&
    typeof globalPage.URL.createObjectURL === "function");

  // -- storage --------------------------------------------------------
  const changes = [];
  chrome.storage.onChanged.addListener((c, area) => changes.push([area, c]));

  await chrome.storage.local.set({ alpha: 1, beta: { nested: true } });
  const read = await chrome.storage.local.get(["alpha", "beta"]);
  equal("storage round-trips values", read, { alpha: 1, beta: { nested: true } });

  equal("getBytesInUse counts only the keys asked about, as UTF-8 key and JSON",
    [await chrome.storage.local.getBytesInUse("alpha"), await chrome.storage.local.getBytesInUse(["missing"]),
      await chrome.storage.local.getBytesInUse(["alpha", "beta"])],
    [6, 0, 6 + 4 + 15]);

  const withDefaults = await chrome.storage.local.get({ alpha: 99, missing: "fallback" });
  equal("storage.get applies defaults for absent keys",
    withDefaults, { alpha: 1, missing: "fallback" });

  await settle();
  check("storage.onChanged reported the write", changes.length > 0);
  equal("the change names the area", changes[0][0], "local");
  equal("the change carries the new value", changes[0][1].alpha, { oldValue: undefined, newValue: 1 });

  await chrome.storage.local.remove("alpha");
  const afterRemove = await chrome.storage.local.get(null);
  check("storage.remove deletes the key", !("alpha" in afterRemove));

  equal("managed storage, which no policy sets, gives back the defaults asked with",
    [await chrome.storage.managed.get({ whitelist: [] }), await chrome.storage.managed.get("x")],
    [{ whitelist: [] }, {}]);

  await new Promise((resolve) => chrome.storage.local.set({ viaCallback: true }, resolve));
  const cb = await chrome.storage.local.get("viaCallback");
  equal("a callback-style set works too", cb, { viaCallback: true });

  await new Promise((resolve) => setTimeout(resolve, 400));
  equal("a first start is reported as Chrome reports an install",
    announcements, [["installed", "install"], ["loaded", "install"]]);

  // -- tabs -----------------------------------------------------------
  const PROVISIONAL = globalPage.WEX.PROVISIONAL_TAB_ID;
  const early = await chrome.tabs.query({ active: true, currentWindow: true });
  equal("tabs.query finds the active tab", early.length, 1);
  equal("the tab reports its URL", early[0].url, "https://example.com/page");
  equal("each tab is known by its page's id, a twin with the same address and title included",
    [early[0].id, (await chrome.tabs.query({})).some((t) => t.id === twin.engineId)], [tab.engineId, true]);
  const replacements = [];
  chrome.tabs.onReplaced.addListener((added, removed) => replacements.push([added, removed]));
  twin.close();
  await settle(20);

  const filtered = await chrome.tabs.query({ url: "*://example.com/*" });
  equal("tabs.query filters by match pattern", filtered.length, 1);
  const notFiltered = await chrome.tabs.query({ url: "*://other.example/*" });
  equal("a non-matching pattern finds nothing", notFiltered.length, 0);

  // A tab that opens is looked up as Safari announces it.
  const created = [];
  chrome.tabs.onCreated.addListener((t) => created.push(t));
  const laterTab = window0.openTab("background");
  laterTab.url = "https://later.example/";
  await settle();
  const laterFound = await chrome.tabs.query({ url: "*://later.example/*" });
  equal("a tab that opens is known by the engine's id", laterFound[0].id, laterTab.engineId);
  equal("tabs.onCreated reports the tab", created.length, 1);
  equal("with where Safari shows it", created[0] && created[0].index, 1);
  laterTab.url = "";
  equal("an empty tab, as Top Sites, is about:blank",
    (await chrome.tabs.get(laterTab.engineId)).url, "about:blank");
  laterTab.url = "https://later.example/";
  // Safari announces a tab about to show Top Sites with no address, and so
  // a navigation to a page the extension may not see, whose address it
  // withholds, and an extension archive opened over a page.
  for (const url of ["https://linked.example/", null]) {
    browser.application.fire("beforeNavigate",
      { target: laterTab, url, preventDefault() {}, __stopped: false }, true);
  }
  laterTab.url = undefined;
  browser.application.fire("navigate", { target: laterTab }, true);
  await settle();
  equal("a tab that shows a page, announced with no address, is left alone",
    String(laterTab.url).indexOf("newtab.html") < 0, true);
  // The addresses the runtime gives a Safari tab, in order.
  const recordShown = (tab) => {
    const shown = [];
    const property = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(tab), "url");
    Object.defineProperty(tab, "url", { configurable: true, get() { return property.get.call(this); },
      set(value) { shown.push(String(value)); property.set.call(this, value); } });
    return shown;
  };
  laterTab.url = "";
  const shownForNewTab = recordShown(laterTab);
  browser.application.fire("beforeNavigate", { target: laterTab, url: null, preventDefault() {}, __stopped: false }, true);
  await settle();
  equal("an empty tab about to show Top Sites shows the extension's new-tab page instead",
    (await chrome.tabs.get(laterTab.engineId)).url, browser.baseURI + "newtab.html");
  equal("and stays empty until it does, as a new tab", shownForNewTab.includes("about:blank"), false);
  delete laterTab.url;
  laterTab.url = "https://later.example/";
  // Safari announces a page of the extension's to another extension with no
  // address, as it does a new tab's Top Sites, and a blank page with its own.
  const openTab = window0.openTab;
  let shownForMade = null;
  window0.openTab = function (...args) {
    const tab = openTab.apply(this, args);
    shownForMade = recordShown(tab);
    return tab;
  };
  const made = await chrome.tabs.create({ url: "popup.html", active: false });
  window0.openTab = openTab;
  await settle();
  equal("an empty tab sent to one of the extension's pages shows a blank page first",
    [shownForMade[0], (await chrome.tabs.get(made.id)).url], ["about:blank", browser.baseURI + "popup.html"]);
  await chrome.tabs.remove(made.id);
  let unknownExtension = null;
  await chrome.management.get("another-extension").catch((e) => { unknownExtension = e.message; });
  equal("management knows the extension itself, and no other",
    [(await chrome.management.getAll()).map((x) => x.id), (await chrome.management.get("com.example.test")).id,
      unknownExtension, typeof chrome.management.onInstalled.addListener],
    [["com.example.test"], "com.example.test", "Failed to find extension with id another-extension.", "function"]);
  const nativePort = chrome.runtime.connectNative("com.example.native");
  const nativeDisconnect = await new Promise((resolve) => nativePort.onDisconnect.addListener((p) =>
    resolve([p.error && p.error.message, chrome.runtime.lastError && chrome.runtime.lastError.message])));
  equal("a native port disconnects with the error a browser gives when there is no host",
    nativeDisconnect, ["Specified native messaging host not found.", "Specified native messaging host not found."]);
  equal("a tab's zoom is Safari's own, at the default factor",
    [await chrome.tabs.getZoom(laterTab.engineId),
      (await chrome.tabs.getZoomSettings(laterTab.engineId)).defaultZoomFactor], [1, 1]);

  // -- the toolbar button --------------------------------------------
  await chrome.action.setBadgeText({ text: "7" });
  equal("the badge shows the number set", browser.toolbarItems[0].badge, 7);
  await chrome.action.setBadgeText({ text: "" });
  equal("an empty badge clears the button", browser.toolbarItems[0].badge, 0);
  await chrome.action.setTitle({ title: "Tooltip" });
  equal("setTitle updates the tool tip", browser.toolbarItems[0].toolTip, "Tooltip");
  await chrome.action.setIcon({ path: "icons/on.png" });
  equal("a relative icon path is resolved against the calling page",
    browser.toolbarItems[0].image, browser.baseURI + "icons/on.png");
  await chrome.action.setIcon({ path: { 16: "icons/small.png", 38: "icons/large.png" } });
  equal("an icon with a drawn mask is swapped for the mask, from the largest size",
    browser.toolbarItems[0].image, browser.baseURI + "wex/toolbar/icons/large.png");
  await chrome.action.setIcon({ imageData: { width: 1, height: 1, data: [0, 0, 0, 255] } });
  equal("an icon given as pixels leaves the toolbar image as it was",
    browser.toolbarItems[0].image, browser.baseURI + "wex/toolbar/icons/large.png");

  // -- the content script world ---------------------------------------
  // Simulate Builder losing every static registration. The runtime
  // registration must bring up a fresh frame by itself.
  const frame = browser.createContentFrame(tab, []);
  vm.runInContext(bridgeRegistrations[0].source, frame.context.vmContext);
  const content = frame.sandbox;
  check("the content world exposes chrome", !!content.chrome);
  const firstBridge = content.WEXContent;
  const firstCore = content.WEX;
  vm.runInContext(bridgeRegistrations[0].source, frame.context.vmContext);
  check("a repeated runtime registration preserves the existing bridge",
    content.WEXContent === firstBridge && content.WEX === firstCore);

  // Extensions commonly branch on whether a background-only namespace exists to
  // work out which context they are in. Defining one in a content script sends
  // them down the wrong branch, so the content bridge must not have them.
  check("a content script has no chrome.tabs", content.chrome.tabs === undefined);
  check("a content script has no chrome.windows", content.chrome.windows === undefined);
  check("a content script has no chrome.webRequest", content.chrome.webRequest === undefined);
  check("a content script still has chrome.storage", !!content.chrome.storage);
  check("a content script still has chrome.i18n", !!content.chrome.i18n);
  equal("and asks the global page, where the detector runs, a text's language",
    (await content.chrome.i18n.detectLanguage(
      "Le renard brun rapide saute par-dessus le chien paresseux pendant que les enfants regardent.")).languages
      .map((l) => l.language), ["fr"]);
  check("a content script has the engine's chrome.dom", !!content.chrome.dom);
  equal("a content script can ask which frame it is in",
    content.chrome.runtime.getFrameId(content), 0);

  equal("a document_start script matching the page ran", content.__contentA, 1);
  check("a document_end script has not run yet", content.__contentB === undefined);

  content.WEXContent.run("document_end");
  equal("the document_end script ran at its own phase", content.__contentB, 1);
  equal("running a phase twice does not repeat it",
    (content.WEXContent.run("document_end"), content.__contentB), 1);

  await settle();
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tabs[0].id;
  equal("tabs.get describes the tab as Safari shows it",
    (await chrome.tabs.get(tabId)).index, 0);

  // A tab that shows no page of WebKit's has a provisional id until it does.
  const blankTab = window0.openTab("background", undefined, { pageless: true });
  await settle();
  const blankIndex = window0.tabs.indexOf(blankTab);
  const blank = (await chrome.tabs.query({ windowId: (await chrome.windows.getCurrent()).id }))
    .find((t) => t.index === blankIndex);
  check("a tab showing no page of WebKit's has a provisional id", blank && blank.id >= PROVISIONAL);
  blankTab.showPage();
  await settle();
  equal("tabs.onReplaced tells of the change from the provisional id once it shows one",
    replacements, [[blankTab.engineId, blank.id]]);
  equal("which still names the tab in a call",
    (await chrome.tabs.get(blank.id)).id, blankTab.engineId);
  const blankRemovals = [];
  const countRemoval = (id) => blankRemovals.push(id);
  chrome.tabs.onRemoved.addListener(countRemoval);
  const firstPage = blankTab.engineId;
  const navigationReplacements = [];
  const navigationReplaced = (details) => navigationReplacements.push([details.tabId, details.replacedTabId]);
  chrome.webNavigation.onTabReplaced.addListener(navigationReplaced);
  blankTab.replacePage();
  await settle(10);
  chrome.webNavigation.onTabReplaced.removeListener(navigationReplaced);
  equal("a page WebKit replaces in an open tab is reported with tabs.onReplaced, not as a closing",
    [replacements[1], blankRemovals], [[blankTab.engineId, firstPage], []]);
  equal("and with webNavigation.onTabReplaced", navigationReplacements, [[blankTab.engineId, firstPage]]);
  chrome.tabs.onRemoved.removeListener(countRemoval);
  blankTab.close();
  await settle();

  equal("a declared style sheet is added by the engine",
    frame.context.sheets.map((sheet) => sheet.file), ["content.css"]);

  equal("content scripts share their top-level declarations, as scripts do",
    [content.__sharedSeen, typeof content.contentStrictHelper], [7, "function"]);
  equal("a content script Safari injects runs where its group applies, once",
    [content.WEXContent.applies(0, 0), content.WEXContent.applies(0, 0), content.WEXContent.applies(9, 0)],
    [true, false, false]);
  equal("and the var names of its blocks outside functions",
    [content.blockVar, content.nestedVar, content.loopVar, content.functionVar, content.methodVar],
    [6, 8, 1, undefined, undefined]);

  // -- a second injection into the same document -------------------------
  // Safari re-evaluates injected scripts for a document under some conditions,
  // which without a guard would install a second bridge and run every content
  // script again.
  const beforeSecond = { a: content.__contentA, b: content.__contentB };
  for (const file of ["wex-config.js", "wex-core.js", "wex-content.js",
                      "wex-run-start.js", "wex-run-end.js"]) {
    require("vm").runInContext(require("fs").readFileSync(wex(file), "utf8"),
      frame.context.vmContext, { filename: wex(file) });
  }
  equal("a second injection does not re-run a document_start script",
    content.__contentA, beforeSecond.a);
  equal("a second injection does not re-run a document_end script",
    content.__contentB, beforeSecond.b);
  // Every converted extension's bridge shares the document with the others',
  // so the mark that turns a second injection away names this extension; it
  // is in the bridge's own world, and the page's document carries none.
  check("the bridge marks its own world under this extension's name, and not the page",
    content["__wexBridge:data-wex-bridge-com-example-test"] === true &&
    !Array.prototype.some.call(content.document.documentElement.attributes || [],
      (a) => /^data-wex-/.test(a.name)));
  {
    // A second evaluation in a world of its own finds the bridge by an event
    // the first one cancels, whose name holds the session token.
    const doc = content.document;
    const name = "wex-bridge:data-wex-bridge-com-example-test:" + browser.baseURI.split("/").slice(-2, -1)[0];
    const question = new content.Event(name, { cancelable: true });
    equal("a bridge in another world answers whether one is there, by an event no page can name",
      [doc.dispatchEvent(question), question.defaultPrevented], [false, true]);
  }
  check("a second injection keeps the engine's namespace within reach",
    !!content.WEX.native && !content.WEX.native.__wex);

  // -- messaging, content to background --------------------------------
  const received = [];
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    received.push({ message, sender });
    if (message.wants === "reply") {
      sendResponse({ ok: true, from: "background" });
      return true;
    }
    return false;
  });

  const reply = await content.chrome.runtime.sendMessage({ wants: "reply" });
  equal("the background replied to the content script", reply, { ok: true, from: "background" });
  check("the sender describes the tab", received[0].sender.tab &&
    received[0].sender.tab.url === "https://example.com/page" &&
    received[0].sender.tab.id === tabId);
  equal("the sender names the extension", received[0].sender.id, "com.example.test");
  equal("and the document it was sent from",
    received[0].sender.documentId,
    (await chrome.webNavigation.getFrame({ tabId, frameId: received[0].sender.frameId })).documentId);
  equal("and the page's origin", received[0].sender.origin, "https://example.com");
  equal("the extension does not see the runtime's own messages",
    received.filter((r) => r.message && r.message.__wex).length, 0);

  const viaCallback = await new Promise((resolve) =>
    content.chrome.runtime.sendMessage({ wants: "reply" }, resolve));
  equal("a callback-style sendMessage gets the reply",
    viaCallback, { ok: true, from: "background" });

  {
    let refused = null;
    await chrome.gcm.register(["1234"]).catch((e) => { refused = e.message; });
    const viaCallback = await new Promise((resolve) => chrome.gcm.register(["1234"], (id) =>
      resolve([id, chrome.runtime.lastError && chrome.runtime.lastError.message])));
    equal("gcm.register fails as Chrome's does with GCM disabled", [refused, viaCallback],
      ["GCM is disabled", [undefined, "GCM is disabled"]]);
    // A tab is never captured, and a background made for a service worker
    // that listens for capture's status starts.
    let notStarted = null;
    await chrome.tabCapture.getMediaStreamId({ targetTabId: 1 }).catch((e) => { notStarted = e.message; });
    equal("tabCapture is there for a background to listen to, and capturing fails as Chrome's does when it does not start",
      [typeof chrome.tabCapture.onStatusChanged.addListener, await chrome.tabCapture.getCapturedTabs(), notStarted,
        typeof chrome.tabCapture.capture],
      ["function", [], "Error starting tab capture", "undefined"]);
  }
  {
    const self = await chrome.management.getSelf();
    equal("management.getSelf names a Web Store extension's store page as its home page, as Chrome does",
      [self.homepageUrl, self.updateUrl, self.isApp],
      ["https://chromewebstore.google.com/detail/com.example.test", "https://clients2.google.com/service/update2/crx", false]);
  }
  {
    // A page no extension reaches is refused as Chrome refuses it.
    const unreachable = window0.openTab("background");
    const refusal = async (url) => {
      unreachable.url = url;
      return chrome.scripting.executeScript({ target: { tabId: unreachable.engineId }, func: () => 1 })
        .then(() => null, (e) => e.message);
    };
    equal("another extension's page, or a browser page, has Chrome's message for it", [
      await refusal("safari-extension://com.example.other-0000000000/page.html"),
      await refusal("topsites://")], [
      "Cannot access a chrome-extension:// URL of different extension", "Cannot access a chrome:// URL"]);
    unreachable.close();
  }
  {
    // This browser's frame ids are larger than Chrome's 32-bit integers.
    let thrown = null;
    try {
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [588410519553] }, func: () => 1 })
        .catch(() => {});
    } catch (e) {
      thrown = e.message;
    }
    equal("a frame id the browser gives passes the argument check", thrown, null);
  }

  // -- messaging, background to content --------------------------------
  {
    let unheard = null;
    await chrome.tabs.sendMessage(tabId, { ping: 4 }).catch((e) => {
      unheard = e.message;
    });
    equal("a tab whose content scripts do not listen rejects the message, as Chrome does",
      unheard, "Could not establish connection. Receiving end does not exist.");
  }
  content.chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.ping) {
      sendResponse({ pong: message.ping });
      return true;
    }
    return false;
  });

  const pong = await chrome.tabs.sendMessage(tabId, { ping: 5 });
  equal("tabs.sendMessage reached the content script", pong, { pong: 5 });

  // -- a listener that returns false must not answer for another --------
  content.chrome.runtime.onMessage.addListener(() => false);
  const stillPong = await chrome.tabs.sendMessage(tabId, { ping: 6 });
  equal("a listener returning false does not clobber the real reply",
    stillPong, { pong: 6 });

  let refused = null;
  await chrome.tabs.sendMessage(laterTab.engineId, { ping: 7 }).catch((e) => {
    refused = e.message;
  });
  check("a tab with nobody listening rejects the message",
    /Receiving end does not exist/.test(String(refused)));

  // -- ports ------------------------------------------------------------
  const portMessages = [];
  const portsSeen = [];
  chrome.runtime.onConnect.addListener((port) => {
    portsSeen.push(port.name);
    port.onMessage.addListener((m) => {
      portMessages.push(m);
      port.postMessage({ echo: m });
    });
  });

  const port = content.chrome.runtime.connect({ name: "test-port" });
  const portReplies = [];
  port.onMessage.addListener((m) => portReplies.push(m));
  await settle();
  port.postMessage({ hello: 1 });
  await settle();
  equal("the background received the port message", portMessages, [{ hello: 1 }]);
  equal("the content script received the port reply", portReplies, [{ echo: { hello: 1 } }]);

  // -- storage from a content script ------------------------------------
  await content.chrome.storage.local.set({ fromContent: "yes" });
  const seenByBackground = await chrome.storage.local.get("fromContent");
  equal("a content script's write reaches the shared store",
    seenByBackground, { fromContent: "yes" });

  const contentRead = await content.chrome.storage.local.get("beta");
  equal("a content script reads what the background wrote",
    contentRead, { beta: { nested: true } });

  await chrome.storage.session.set({ keyMap: "shared" });
  check("a content script's session area can set its access level",
    typeof content.chrome.storage.session.setAccessLevel === "function" &&
    (await content.chrome.storage.session.setAccessLevel({
      accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" })) === undefined);
  equal("and reads the background's session storage",
    [await content.chrome.storage.session.get("keyMap"),
     await content.chrome.storage.session.getKeys()],
    [{ keyMap: "shared" }, ["keyMap"]]);
  await chrome.storage.session.clear();

  const contentChanges = [];
  content.chrome.storage.onChanged.addListener((c, area) => contentChanges.push([area, c]));
  await settle();
  await chrome.storage.local.set({ broadcast: 1 });
  await settle();
  equal("storage changes reach content scripts",
    contentChanges, [["local", { broadcast: { newValue: 1 } }]]);
  equal("the extension does not see the runtime's own ports",
    portsSeen, ["test-port"]);

  equal("so do its content scripts",
    [typeof content.browser, typeof content.safari, /Chrome\/156/.test(content.navigator.userAgent),
      typeof content.chrome.runtime.sendMessage], ["undefined", "undefined", true, "function"]);

  // A content script gets what a browser gives content scripts and no more.
  const overreach = await content.chrome.__wexNative.runtime.sendMessage(
    { __wex: "rpc", path: "tabs.query", args: [{}] });
  check("a content script cannot call the background-only API",
    !!overreach && /not available to content scripts/.test(String(overreach.error)));

  // -- injection ---------------------------------------------------------
  const results = await chrome.tabs.executeScript(tabId, { file: "injected.js" });
  equal("executeScript returns the value the file evaluated to", results, [42]);

  await chrome.scripting.executeScript({ target: { tabId }, files: ["declares.js"] });
  equal("a file's top-level constants are seen by the files injected after it",
    injected(await chrome.scripting.executeScript({ target: { tabId }, files: ["uses.js"] })),
    [{ frameId: 0, result: 43 }]);

  equal("a file that throws or fails to parse leaves the files after it to run, and the last gives the result",
    injected(await chrome.scripting.executeScript({ target: { tabId },
      files: ["throws.js", "marks.js", "unparsable.js", "injected.js"] })),
    [{ frameId: 0, result: 42 }]);
  equal("and those files did run",
    injected(await chrome.scripting.executeScript({ target: { tabId }, func: () => filesReached })),
    [{ frameId: 0, result: 1 }]);
  equal("a last file that throws leaves its frame out",
    await chrome.scripting.executeScript({ target: { tabId }, files: ["injected.js", "throws.js"] }), []);

  globalPage.WEX.CONFIG.firefoxBuild = true;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["throws.js", "marks.js"] });
    equal("a Firefox build stops at the first file that throws, as Firefox does",
      await chrome.scripting.executeScript({ target: { tabId }, func: () => filesReached }),
      [{ frameId: 0, result: 1 }]);
  } finally {
    globalPage.WEX.CONFIG.firefoxBuild = false;
  }

  const codeResults = await chrome.tabs.executeScript(tabId, { code: "6 * 7" });
  equal("executeScript evaluates code", codeResults, [42]);

  const inWorld = await chrome.tabs.executeScript(tabId, { code: "typeof chrome.runtime.sendMessage" });
  equal("injected code runs beside the bridge", inWorld, ["function"]);

  const funcResults = await chrome.scripting.executeScript({
    target: { tabId },
    func: function (a, b) { return a + b; },
    args: [2, 3]
  });
  equal("scripting.executeScript runs a function with arguments",
    injected(funcResults), [{ frameId: 0, result: 5 }]);
  equal("and gives what a promise it returns settles to, leaving out a frame where it is rejected",
    [injected(await chrome.scripting.executeScript({ target: { tabId },
      func: (n) => new Promise((resolve) => setTimeout(() => resolve({ n }), 20)), args: [4] })),
      await chrome.scripting.executeScript({ target: { tabId }, func: () => Promise.reject(new Error("no")) })],
    [[{ frameId: 0, result: { n: 4 } }], []]);

  equal("an injection that throws gives null for its frame, as Chrome's does",
    await chrome.tabs.executeScript(tabId, { code: "throw new Error('boom')" }), [null]);
  // Firefox's tabs.executeScript waits for a promise, and fails with what the
  // code throws or the promise rejects with.
  globalPage.WEX.CONFIG.firefoxBuild = true;
  try {
    const firefoxInjection = (code) => chrome.tabs.executeScript(tabId, { code })
      .then((r) => r, (e) => "rejected: " + e.message);
    equal("a Firefox build's executeScript gives what a promise settles to, and fails as Firefox's does",
      [await firefoxInjection("new Promise(function (r) { setTimeout(function () { r({ n: 4 }); }, 20); })"),
        await firefoxInjection("6 * 7"),
        await firefoxInjection("Promise.reject(new Error('no'))"),
        await firefoxInjection("throw new Error('boom')"),
        await firefoxInjection("throw { code: 5 }")],
      [[{ n: 4 }], [42], "rejected: no", "rejected: boom", "rejected: An unexpected error occurred"]);
    const forever = firefoxInjection("new Promise(function () {})");
    await settle(60);
    tab.navigate("https://example.com/elsewhere");
    equal("and fails when the frame goes before its promise settles",
      await Promise.race([forever, settle(2000).then(() => "still waiting")]),
      "rejected: The frame was removed before its script finished.");
  } finally {
    globalPage.WEX.CONFIG.firefoxBuild = false;
  }

  await chrome.tabs.insertCSS(tabId, { code: "a { color: blue; }" });
  equal("insertCSS hands the sheet to the engine",
    frame.context.sheets.filter((sheet) => sheet.code === "a { color: blue; }").length, 1);
  await chrome.tabs.removeCSS(tabId, { code: "a { color: blue; }" });
  equal("removeCSS takes it away again",
    frame.context.sheets.filter((sheet) => sheet.code === "a { color: blue; }").length, 0);

  await chrome.scripting.registerContentScripts([{
    id: "dynamic", matches: ["*://example.com/*"], js: ["injected.js"], runAt: "document_start"
  }]);
  {
    const registered = browser.contentScripts.slice(bridgeRegistrations.length);
    const inFrame = (top) => {
      const world = vm.createContext({});
      world.window = vm.runInContext("this", world);
      world.top = top ? world.window : {};
      vm.runInContext(registered[0].source.replace("42;", "var ran = 42;"), world);
      return world.ran;
    };
    equal("a content script registered at run time is handed to Safari, and runs in the top frame alone",
      [registered.map((entry) => [entry.whitelist, entry.atEnd]), inFrame(true), inFrame(false)],
      [[[["http://example.com/*", "https://example.com/*"], false]], 42, undefined]);
  }
  equal("and is listed",
    (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id), ["dynamic"]);
  await chrome.scripting.unregisterContentScripts({ ids: ["dynamic"] });
  equal("unregistering preserves the startup bridge", browser.contentScripts.length, bridgeRegistrations.length);

  await chrome.scripting.registerContentScripts([{
    id: "every-frame", matches: ["*://example.com/*"], js: ["injected.js"], allFrames: true
  }]);
  {
    const source = browser.contentScripts[bridgeRegistrations.length].source;
    let prepared = 0;
    const world = vm.createContext({ WEXContent: { prepare: () => { prepared++; } } });
    equal("and one for every frame as it is, after the bridge makes the content scripts' chrome",
      [source.slice(-4), vm.runInContext(source, world), prepared], ["\n42;", 42, 1]);
  }
  await chrome.scripting.unregisterContentScripts({ ids: ["every-frame"] });

  await chrome.scripting.registerContentScripts([{
    id: "page-world", matches: ["*://example.com/*"], js: ["injected.js"], world: "MAIN"
  }]);
  await settle();
  equal("one for the page's world is the engine's to run, and Safari is given nothing of it",
    [browser.engine.registeredScripts.filter((script) => script.id === "wex.dynamic.page-world"),
      browser.contentScripts.length - bridgeRegistrations.length],
    [[{ id: "wex.dynamic.page-world", matches: ["*://example.com/*"], excludeMatches: [],
      js: ["injected.js", "wex/wex-page-world-ran.js"], allFrames: false, matchOriginAsFallback: false,
      runAt: "document_idle", world: "MAIN", persistAcrossSessions: true }], 0]);
  // A script registered after one for the page's world runs after it in
  // each document, as Chrome runs them in the order they were registered.
  await chrome.scripting.registerContentScripts([{
    id: "after-page-world", matches: ["*://example.com/*"], js: ["injected.js"], runAt: "document_idle"
  }]);
  await settle();
  {
    const added = browser.contentScripts.slice(bridgeRegistrations.length);
    const marker = require("../webext2safari/js/node.js").convert.pageWorldRan(globalPage.WEX.CONFIG.extensionId);
    const order = [];
    // The page's world and the content scripts' share the document; Safari
    // runs the two in either order.
    const runIn = (url, isolatedFirst) => {
      order.length = 0;
      const doc = new EventTarget();
      const isolated = vm.createContext({ document: doc, location: { href: url }, CustomEvent, order,
        WEXContent: { prepare: () => {} }, WEX: { matchesAny: globalPage.WEX.matchesAny } });
      isolated.self = isolated;
      isolated.window = isolated;
      isolated.top = isolated;
      const page = vm.createContext({ document: doc, CustomEvent });
      const runIsolated = () => vm.runInContext(added[0].source.replace("42;", "order.push('content');"), isolated);
      const runPage = () => {
        if (globalPage.WEX.matchesAny(url, ["*://example.com/*"])) {
          order.push("page");
          vm.runInContext(marker, page);
        }
      };
      if (isolatedFirst) {
        runIsolated();
        runPage();
      } else {
        runPage();
        runIsolated();
      }
      return order.slice();
    };
    equal("Safari is given the later script, which runs after the page's world's in either order",
      [added.length, runIn("https://example.com/", true), runIn("https://example.com/", false)],
      [1, ["page", "content"], ["page", "content"]]);
    equal("and at once where no script for the page's world applies",
      runIn("https://other.example/", true), ["content"]);
  }
  await chrome.scripting.unregisterContentScripts({ ids: ["page-world", "after-page-world"] });
  await settle();
  equal("and is withdrawn from the engine with it",
    browser.engine.registeredScripts.filter((script) => script.id === "wex.dynamic.page-world"), []);

  // -- user scripts --------------------------------------------------------
  await chrome.userScripts.register([{
    id: "us", matches: ["*://example.com/*"], js: [{ code: "var userRan = (this.userRan || 0) + 1;" }, { file: "injected.js" }],
    runAt: "document_start", allFrames: true
  }]);
  {
    const registered = browser.contentScripts.slice(bridgeRegistrations.length);
    const world = vm.createContext({ WEXContent: { prepare: () => {} } });
    registered.forEach((entry) => vm.runInContext(entry.source, world));
    equal("a user script is handed to Safari for the content scripts' world, each source in order, at the global scope",
      [registered.map((entry) => [entry.whitelist, entry.atEnd]), world.userRan],
      [[[["http://example.com/*", "https://example.com/*"], false], [["http://example.com/*", "https://example.com/*"], false]], 1]);
  }
  equal("and is listed as Chrome lists it",
    await chrome.userScripts.getScripts({ ids: ["us"] }),
    [{ id: "us", js: [{ code: "var userRan = (this.userRan || 0) + 1;" }, { file: "injected.js" }],
      matches: ["*://example.com/*"], allFrames: true, runAt: "document_start", world: "USER_SCRIPT" }]);
  equal("a second registration under its ID, or one without a source, is refused",
    [await chrome.userScripts.register([{ id: "us", matches: ["*://a.example/*"], js: [{ code: "1" }] }])
      .then(() => "registered", (e) => e.message),
    await chrome.userScripts.register([{ id: "empty", matches: ["*://a.example/*"], js: [] }])
      .then(() => "registered", (e) => e.message)],
    ["Duplicate script ID 'us'", "User script with ID 'empty' must specify at least one js source."]);
  await chrome.userScripts.update([{ id: "us", matches: ["*://example.org/*"], js: [{ code: "1" }] }]);
  equal("an update replaces what Safari runs",
    browser.contentScripts.slice(bridgeRegistrations.length).map((entry) => entry.whitelist),
    [["http://example.org/*", "https://example.org/*"]]);
  await chrome.userScripts.unregister();
  equal("and unregistering takes it away", browser.contentScripts.length, bridgeRegistrations.length);

  await chrome.userScripts.register([{
    id: "globbed", matches: ["*://example.com/*"], includeGlobs: ["*://example.com/a*"], js: [{ code: "var globbed = 1;" }]
  }]);
  {
    const source = browser.contentScripts[bridgeRegistrations.length].source;
    const runAt = (href) => {
      const world = vm.createContext({ WEXContent: { prepare: () => {} }, location: { href } });
      world.window = vm.runInContext("this", world);
      world.top = world.window;
      vm.runInContext(source, world);
      return world.globbed;
    };
    equal("a user script's globs decide where it runs", [runAt("https://example.com/abc"), runAt("https://example.com/b")],
      [1, undefined]);
  }
  await chrome.userScripts.unregister({ ids: ["globbed"] });

  await chrome.userScripts.register([{ id: "page", matches: ["*://example.com/*"], js: [{ file: "injected.js" }], world: "MAIN" }]);
  await settle();
  equal("one for the page's world is the engine's to run",
    browser.engine.registeredScripts.filter((script) => script.id === "wex.userScript.page").map((script) => script.js),
    [["injected.js"]]);
  equal("and names its code by file",
    await chrome.userScripts.register([{ id: "page-code", matches: ["*://example.com/*"], js: [{ code: "1" }], world: "MAIN" }])
      .then(() => "registered", (e) => e.message),
    "User script with ID 'page-code' for the page's world must name its code by file.");
  await chrome.userScripts.unregister({ ids: ["page"] });
  await settle();
  equal("and is withdrawn from the engine with it",
    browser.engine.registeredScripts.filter((script) => script.id === "wex.userScript.page"), []);

  await chrome.userScripts.configureWorld({ csp: "script-src 'self'", messaging: true });
  equal("a world's configuration is kept and told back", await chrome.userScripts.getWorldConfigurations(),
    [{ csp: "script-src 'self'", messaging: true }]);
  await chrome.userScripts.resetWorldConfiguration();
  equal("and reset", await chrome.userScripts.getWorldConfigurations(), []);

  equal("execute runs code in the tab and gives each frame's result",
    injected(await chrome.userScripts.execute({ target: { tabId }, js: [{ code: "6 * 7" }] })),
    [{ frameId: 0, result: 42 }]);

  // -- requests ----------------------------------------------------------
  const engine = browser.engine;
  {
    // A challenge to a request of the extension's own pages, which have no
    // window to ask in.
    const challenged = (tabId) => engine.request({ url: "https://example.com/feed", tabId,
      documentUrl: browser.baseURI + "wex-global-page.html" }, { challenge: true }).then((o) => o.challenge);
    const before = [await challenged(-1), await challenged(tabId)];
    const own = () => undefined;
    chrome.webRequest.onAuthRequired.addListener(own, { urls: ["<all_urls>"] }, ["blocking"]);
    const answering = await challenged(-1);
    chrome.webRequest.onAuthRequired.removeListener(own);
    equal("a challenge to the extension's own request ends it, a tab's goes to Safari's sheet, " +
      "and an extension that answers challenges answers them",
      [before, answering], [["cancelled", "sheet"], "sheet"]);
  }
  const seenRequests = [];
  const blocker = (details) => {
    seenRequests.push(details);
    if (details.url.includes("/ads/")) {
      return { cancel: true };
    }
    return undefined;
  };
  chrome.webRequest.onBeforeRequest.addListener(blocker, { urls: ["<all_urls>"] }, ["blocking"]);

  const blocked = await engine.request({
    url: "https://example.com/ads/banner.gif", type: "image", tabId,
    documentUrl: "https://example.com/page"
  });
  equal("a blocked request comes back blocked", blocked.cancel, true);

  const allowed = await engine.request({
    url: "https://example.com/logo.png", type: "image", tabId
  });
  equal("an allowed request comes back allowed", allowed.cancel, false);
  await engine.request({
    url: "https://cdn.example.net/blocked.js", type: "script", tabId,
    initiator: "https://example.com"
  });
  check("the listener saw all three requests", seenRequests.length === 3);
  equal("the request details name the tab", seenRequests[0].tabId, tabId);
  equal("the requesting document is also given under Firefox's name",
    seenRequests[0].originUrl, "https://example.com/page");
  equal("and WebKit's initiator supplies that name when it gives no document URL",
    seenRequests[2].originUrl, "https://example.com");

  const mainFrame = await engine.request({
    url: "https://example.com/ads/landing", type: "main_frame", tabId
  });
  equal("the main document's own load can be blocked", mainFrame.cancel, true);
  const seenBefore = seenRequests.length;
  const otherExtension = await engine.request({
    url: "safari-extension://com.example.other-TEAM/abc123/ads/content.js", type: "xmlhttprequest", tabId
  });
  const runtimeFile = await engine.request({
    url: browser.baseURI + "wex/ads/wex-core.js", type: "script", tabId
  });
  equal("another extension's file, and the runtime's own, are neither seen nor blocked",
    [otherExtension.cancel, runtimeFile.cancel, seenRequests.length - seenBefore], [false, false, 0]);
  const ownExtension = await engine.request({
    url: browser.baseURI + "ads/content.js", type: "xmlhttprequest", tabId
  });
  equal("a request for the extension's own file is seen, as Chrome shows it",
    [ownExtension.cancel, seenRequests.length - seenBefore], [true, 1]);

  chrome.webRequest.onBeforeRequest.removeListener(blocker);
  check("a removed listener is gone", !chrome.webRequest.onBeforeRequest.hasListener(blocker));
  equal("and then blocks nothing",
    (await engine.request({ url: "https://example.com/ads/x.gif", type: "image" })).cancel, false);

  const observed = [];
  chrome.webRequest.onHeadersReceived.addListener((details) => {
    observed.push(details);
  }, { urls: ["*://*/*.m3u8*"], types: ["xmlhttprequest"] }, ["responseHeaders"]);

  await engine.request({
    url: "https://cdn.example.com/live/master.m3u8?t=1", type: "xmlhttprequest", tabId
  }, { responseHeaders: [{ name: "content-type", value: "application/vnd.apple.mpegurl" }] });
  await engine.request({ url: "https://cdn.example.com/page.html", type: "xmlhttprequest" });

  equal("a watched response reaches onHeadersReceived", observed.length, 1);
  check("it carries the response's headers",
    observed[0] && observed[0].responseHeaders.some(
      (h) => h.name === "content-type" && h.value === "application/vnd.apple.mpegurl"));

  chrome.webRequest.onBeforeSendHeaders.addListener((details) => ({
    requestHeaders: details.requestHeaders.filter((h) => h.name !== "User-Agent")
      .concat([{ name: "User-Agent", value: "Elsewhere/1.0" }])
  }), { urls: ["*://agent.example/*"] }, ["blocking", "requestHeaders"]);
  const rewritten = await engine.request({
    url: "https://agent.example/", type: "main_frame",
    requestHeaders: [{ name: "User-Agent", value: "Safari" }]
  });
  equal("request headers can be rewritten",
    rewritten.requestHeaders, [{ name: "User-Agent", value: "Elsewhere/1.0" }]);

  // -- declarativeNetRequest ------------------------------------------------
  const dnr = chrome.declarativeNetRequest;
  equal("the static rulesets Info.plist enables are enabled",
    await dnr.getEnabledRulesets(), ["rules"]);
  await dnr.updateEnabledRulesets({ enableRulesetIds: ["extra"], disableRulesetIds: ["rules"] });
  equal("rulesets are switched by the engine",
    await new Promise((resolve) => dnr.getEnabledRulesets(resolve)), ["extra"]);
  await dnr.updateEnabledRulesets({ enableRulesetIds: ["rules"], disableRulesetIds: ["extra"] });

  const dynamicRule = { id: 100, priority: 1, action: { type: "block" },
    condition: { urlFilter: "dynamic.example", resourceTypes: ["image"] } };
  await dnr.updateDynamicRules({ addRules: [dynamicRule,
    Object.assign({}, dynamicRule, { id: 101 })] });
  equal("dynamic rules are kept by the engine",
    (await dnr.getDynamicRules()).map((r) => r.id), [100, 101]);
  equal("and can be narrowed by id",
    await dnr.getDynamicRules({ ruleIds: [100] }), [dynamicRule]);
  equal("with a callback in place of the filter",
    (await new Promise((resolve) => dnr.getDynamicRules(resolve))).length, 2);

  let duplicateError = null;
  const duplicateResult = await new Promise((resolve) => {
    dnr.updateDynamicRules({ addRules: [dynamicRule] }, (value) => {
      duplicateError = chrome.runtime.lastError && chrome.runtime.lastError.message;
      resolve(value);
    });
  });
  equal("lastError is undefined outside a failed call's callback, as in Chrome",
    typeof chrome.runtime.lastError, "undefined");
  check("an engine refusal reaches the callback as lastError",
    duplicateResult === undefined && /unique ID/.test(String(duplicateError)), duplicateError);
  let duplicateRejection = null;
  await dnr.updateDynamicRules({ addRules: [dynamicRule] }).catch((e) => {
    duplicateRejection = e.message;
  });
  check("and rejects the promise", /unique ID/.test(String(duplicateRejection)));

  await dnr.updateDynamicRules({ removeRuleIds: [101] });
  await dnr.updateSessionRules({ addRules: [Object.assign({}, dynamicRule, { id: 200 })] });
  equal("session rules are kept apart from dynamic ones",
    [(await dnr.getDynamicRules()).map((r) => r.id), (await dnr.getSessionRules()).map((r) => r.id)],
    [[100], [200]]);
  await dnr.updateSessionRules({ addRules: [
    { id: 201, priority: 1, action: { type: "block" },
      condition: { regexFilter: "^https?://.*", requestDomains: ["ads.example"],
                   resourceTypes: ["main_frame"] } },
    { id: 202, priority: 1, action: { type: "redirect",
                                      redirect: { regexSubstitution: "https://x.example/#\\0" } },
      condition: { regexFilter: "^https?://.*", requestDomains: ["ads.example"] } },
    { id: 203, priority: 1, action: { type: "block" },
      condition: { regexFilter: "^https://ads\\.example/[a-z]+$", requestDomains: ["ads.example"] } }
  ] });
  const scoped = await dnr.getSessionRules();
  equal("a regex that matches any URL is scoped by its domains as a urlFilter",
    browser.engine.dnrState().sessionRules.find((r) => r.id === 201).condition,
    { requestDomains: ["ads.example"], resourceTypes: ["main_frame"], urlFilter: "|http" });
  equal("a regex substitution limited to domains is left out, and other regexes kept",
    scoped.map((r) => r.id), [200, 201, 203]);
  await dnr.updateSessionRules({ removeRuleIds: [201, 203] });
  equal("regex support is the engine's answer",
    [(await dnr.isRegexSupported({ regex: "a+" })).isSupported,
     (await dnr.isRegexSupported({ regex: "(" })).isSupported], [true, false]);
  const alternation = { id: 300, priority: 1, action: { type: "block" },
    condition: { regexFilter: "^https://(ads|track)\\.example/\\d+", resourceTypes: ["image"] } };
  await dnr.updateDynamicRules({ addRules: [alternation] });
  equal("a regex with alternatives is one engine rule for each, in the engine's dialect",
    browser.engine.dnrState().dynamicRules.filter((r) => r.condition.regexFilter)
      .map((r) => [r.id, r.condition.regexFilter]),
    [[300, "^https://(ads)\\.example/[0-9]+"], [1900000000, "^https://(track)\\.example/[0-9]+"]]);
  equal("while the extension sees the rule it made",
    [(await dnr.getDynamicRules()).map((r) => r.id), await dnr.getDynamicRules({ ruleIds: [300] })],
    [[100, 300], [alternation]]);
  equal("and such a regex is supported", (await dnr.isRegexSupported({ regex: "a|b\\d{2}" })).isSupported,
    true);
  await dnr.updateDynamicRules({ removeRuleIds: [300] });
  equal("removing the rule removes every engine rule for it",
    browser.engine.dnrState().dynamicRules.map((r) => r.id), [100]);
  {
    // Updates made one after another, each with its options as called.
    const rule = { id: 350, priority: 1, condition: { urlFilter: "first.example", resourceTypes: ["image"] },
      action: { type: "block" } };
    const both = Promise.all([
      dnr.updateSessionRules({ removeRuleIds: [350], addRules: [rule] }),
      (rule.condition.urlFilter = "second.example",
        dnr.updateSessionRules({ removeRuleIds: [350], addRules: [rule] }))]);
    let failed = null;
    await both.catch((e) => { failed = e.message; });
    const kept = (await dnr.getSessionRules({ ruleIds: [350] })).map((r) => r.condition.urlFilter);
    equal("back-to-back updates replacing one rule both succeed, the later one standing",
      [failed, kept], [null, ["second.example"]]);
    await dnr.updateSessionRules({ removeRuleIds: [350] });
  }
  {
    // Response headers, which WebKit leaves to the global page.
    await dnr.updateSessionRules({ addRules: [
      { id: 340, priority: 2, condition: { urlFilter: "||cors.example^", resourceTypes: ["xmlhttprequest"] },
        action: { type: "modifyHeaders", responseHeaders: [
          { header: "Access-Control-Allow-Origin", operation: "set", value: "*" },
          { header: "x-frame-options", operation: "remove" }] } },
      { id: 341, priority: 1, condition: { urlFilter: "||cors.example^", resourceTypes: ["xmlhttprequest"] },
        action: { type: "modifyHeaders", responseHeaders: [
          { header: "access-control-allow-origin", operation: "set", value: "https://lower.example" }] } }] });
    await settle();
    const answered = (url, type) => engine.request({ url, type, tabId }, { responseHeaders: [
      { name: "X-Frame-Options", value: "DENY" }, { name: "Content-Type", value: "text/plain" }] })
      .then((o) => o.responseHeaders.map((h) => h.name + ": " + h.value));
    equal("a rule's response headers are changed as Chrome changes them, the higher priority deciding",
      [await answered("https://api.cors.example/x", "xmlhttprequest"), await answered("https://other.example/x", "xmlhttprequest"),
        await answered("https://api.cors.example/x", "image")],
      [["Content-Type: text/plain", "Access-Control-Allow-Origin: *"],
        ["X-Frame-Options: DENY", "Content-Type: text/plain"], ["X-Frame-Options: DENY", "Content-Type: text/plain"]]);
    await dnr.updateSessionRules({ addRules: [
      { id: 344, priority: 1, condition: { urlFilter: "||framed.example^", resourceTypes: ["sub_frame"] },
        action: { type: "modifyHeaders", responseHeaders: [
          { header: "x-frame-options", operation: "remove" }] } }
    ] });
    await settle();
    const framed = await engine.request({ url: "https://framed.example/page", type: "sub_frame", tabId },
      { responseHeaders: [
        { name: "X-Frame-Options", value: "SAMEORIGIN" },
        { name: "Content-Security-Policy", value: "default-src 'self'; frame-ancestors 'self'; img-src *" }
      ] });
    equal("removing X-Frame-Options to permit a subframe removes its equivalent CSP directive too",
      framed.responseHeaders.map((h) => h.name + ": " + h.value),
      ["Content-Security-Policy: default-src 'self'; img-src *"]);
    await dnr.updateSessionRules({ removeRuleIds: [340, 341, 344], addRules: [
      { id: 342, condition: { urlFilter: "||cdn.example^", domainType: "thirdParty", resourceTypes: ["script"] },
        action: { type: "modifyHeaders", responseHeaders: [{ header: "x-third", operation: "set", value: "1" }] } }] });
    await settle();
    const thirdOf = (initiator) => engine.request({ url: "https://a.cdn.example/x.js", type: "script", tabId, initiator },
      { responseHeaders: [] }).then((o) => o.responseHeaders.length);
    equal("a rule's domainType tells a third party's load from a first party's by their sites",
      [await thirdOf("https://www.cdn.example"), await thirdOf("https://news.other.example")], [0, 1]);
    await dnr.updateSessionRules({ removeRuleIds: [342] });
    await settle();
    equal("and stop once the rules are gone", await answered("https://api.cors.example/x", "xmlhttprequest"),
      ["X-Frame-Options: DENY", "Content-Type: text/plain"]);
    equal("an enabled static ruleset's rule, as the converter recorded it, changes them too",
      (await answered("https://static-headers.example/x", "xmlhttprequest")).pop(), "x-static: yes");
    await dnr.updateSessionRules({ addRules: [{ id: 343, condition: { regexFilter: "^https://(?:a|b)\\.alt\\.example/",
      resourceTypes: ["xmlhttprequest"] }, action: { type: "modifyHeaders",
      responseHeaders: [{ header: "x-alt", operation: "set", value: "1" }] } }] });
    await settle();
    equal("a regexFilter matches as the extension wrote it, every alternative",
      [(await answered("https://b.alt.example/x", "xmlhttprequest")).pop(),
        (await answered("https://c.alt.example/x", "xmlhttprequest")).pop()], ["x-alt: 1", "Content-Type: text/plain"]);
    await dnr.updateSessionRules({ removeRuleIds: [343] });
    await settle();
  }
  {
    const toOwnPage = { id: 330, priority: 1, condition: { urlFilter: "stats.example", resourceTypes: ["sub_frame"] },
      action: { type: "redirect", redirect: { url: chrome.runtime.getURL("html/stats.html?x=1") } } };
    await dnr.updateDynamicRules({ addRules: [toOwnPage] });
    equal("a redirect to a page of the extension's own goes to the engine by its path, and reads back as written",
      [browser.engine.dnrState().dynamicRules.filter((r) => r.id === 330).map((r) => r.action.redirect),
        await dnr.getDynamicRules({ ruleIds: [330] })],
      [[{ extensionPath: "/html/stats.html?x=1" }], [toOwnPage]]);
    await dnr.updateDynamicRules({ removeRuleIds: [330] });
    const toRenamed = { id: 331, priority: 1, condition: { urlFilter: "list.example", resourceTypes: ["script"] },
      action: { type: "redirect", redirect: { extensionPath: "/serverlist?x=1" } } };
    await dnr.updateDynamicRules({ addRules: [toRenamed] });
    equal("a redirect's extensionPath naming a renamed file goes to the engine by the stored name, " +
      "and reads back as written",
      [browser.engine.dnrState().dynamicRules.filter((r) => r.id === 331).map((r) => r.action.redirect),
        await dnr.getDynamicRules({ ruleIds: [331] })],
      [[{ extensionPath: "/serverlist.txt?x=1" }], [toRenamed]]);
    await dnr.updateDynamicRules({ removeRuleIds: [331] });
  }
  await dnr.updateSessionRules({ addRules: [
    { id: 310, priority: 1, action: { type: "block" },
      condition: { urlFilter: "ads.example", resourceTypes: ["script", "object", "webbundle"] } },
    { id: 311, priority: 1, action: { type: "block" },
      condition: { urlFilter: "ads.example", resourceTypes: ["object"] } }
  ] });
  equal("a rule is narrowed to the resource types the engine loads, and one with none left out",
    browser.engine.dnrState().sessionRules.filter((r) => r.id >= 310).map((r) => [r.id, r.condition.resourceTypes]),
    [[310, ["script"]]]);
  await dnr.updateSessionRules({ removeRuleIds: [310] });
  await dnr.updateSessionRules({ addRules: [
    { id: 320, priority: 1, condition: { urlFilter: "a.example" },
      action: { type: "modifyHeaders", responseHeaders: [
        { header: "Permissions-Policy", operation: "remove" },
        { header: "x-frame-options", operation: "remove" }] } },
    { id: 321, priority: 1, condition: { urlFilter: "a.example" },
      action: { type: "modifyHeaders", responseHeaders: [
        { header: "permissions-policy", operation: "remove" }] } }
  ] });
  equal("a header the engine does not know is left out of a rule, and a rule with nothing left",
    browser.engine.dnrState().sessionRules.filter((r) => r.id >= 320)
      .map((r) => [r.id, r.action.responseHeaders.map((h) => h.header)]),
    [[320, ["x-frame-options"]]]);
  await dnr.updateSessionRules({ removeRuleIds: [320] });
  const overrides = () => browser.engine.dnrState().dynamicRules
    .filter((r) => r.id >= 1990000000).map((r) => [r.action.type, r.priority, r.condition.urlFilter]);
  await dnr.updateStaticRules({ rulesetId: "rules", disableRuleIds: [1] });
  equal("a disabled static rule is overridden by an allow rule of its condition and priority",
    [await dnr.getDisabledRuleIds({ rulesetId: "rules" }), overrides(),
      (await dnr.getDynamicRules()).some((r) => r.id >= 1990000000)],
    [[1], [["allow", 1, "||tracker.example^"]], false]);
  await dnr.updateEnabledRulesets({ disableRulesetIds: ["rules"] });
  const whileOff = overrides();
  await dnr.updateEnabledRulesets({ enableRulesetIds: ["rules"] });
  equal("which stands only while its ruleset is enabled", [whileOff, overrides().length], [[], 1]);
  await dnr.updateStaticRules({ rulesetId: "rules", enableRuleIds: [1] });
  equal("and goes when the rule is enabled again",
    [await dnr.getDisabledRuleIds({ rulesetId: "rules" }), overrides()], [[], []]);
  equal("an allow rule cannot be disabled so",
    await dnr.updateStaticRules({ rulesetId: "rules", disableRuleIds: [2] }).then(() => "succeeded", (e) => e.message),
    "An allow rule of a static ruleset cannot be disabled in this browser.");
  equal("and Chrome's enums are there", [dnr.RuleActionType.BLOCK, dnr.ResourceType.MAIN_FRAME],
    ["block", "main_frame"]);
  equal("matched rules come from the engine", await dnr.getMatchedRules(), { rulesMatchedInfo: [] });
  equal("the static rules left are Chrome's allowance less the enabled rulesets'",
    await dnr.getAvailableStaticRuleCount(), 330000 - 2);
  equal("the engine's limits are passed on", dnr.MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES, 30000);
  equal("and Chrome's others filled in", dnr.MAX_NUMBER_OF_REGEX_RULES, 1000);
  equal("no load waits on the runtime for the rules",
    globalPage.chrome.__wexNative.webRequest.onBeforeRequest.hasListeners(), false);

  // -- requestIdleCallback ----------------------------------------------------
  const idle = await new Promise((resolve) =>
    globalPage.requestIdleCallback((deadline) =>
      resolve([deadline.didTimeout, deadline.timeRemaining() > 0]), { timeout: 500 }));
  let cancelledRan = false;
  globalPage.cancelIdleCallback(globalPage.requestIdleCallback(() => { cancelledRan = true; }));
  await settle();
  equal("requestIdleCallback runs its callback with time to spare, and a cancelled one not at all",
    [idle, cancelledRan], [[false, true], false]);

  // -- captureVisibleTab ------------------------------------------------------
  const shownTab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  equal("a PNG capture is Safari's screenshot of the window's active tab",
    await chrome.tabs.captureVisibleTab(null, { format: "png" }),
    "data:image/png;base64," + Buffer.from(shownTab.url).toString("base64"));
  equal("and a window that is not there fails",
    await chrome.tabs.captureVisibleTab(987654, { format: "png" }).catch((e) => e.message),
    "No window with id: 987654.");

  // -- privacy ---------------------------------------------------------------
  const failure = (promise) => promise.then(() => "succeeded", (e) => e.message);
  await chrome.privacy.network.webRTCIPHandlingPolicy.set({ value: "disable_non_proxied_udp" });
  equal("a protection Safari decides reports its value, which a change leaves as it is",
    [await chrome.privacy.network.webRTCIPHandlingPolicy.get({}),
      (await chrome.privacy.websites.doNotTrackEnabled.get({})).value,
      (await chrome.privacy.websites.thirdPartyCookiesAllowed.get({})).value],
    [{ value: "default", levelOfControl: "not_controllable" }, false, false]);
  equal("a feature Safari lacks is off, and may be set off but not on",
    [await chrome.privacy.websites.topicsEnabled.get({}),
      await failure(chrome.privacy.websites.topicsEnabled.set({ value: false })),
      await failure(chrome.privacy.websites.topicsEnabled.set({ value: true }))],
    [{ value: false, levelOfControl: "controllable_by_this_extension" }, "succeeded",
      "privacy.websites.topicsEnabled cannot be turned on: this browser has no such feature."]);

  // -- signing in through a web page -------------------------------------
  equal("the redirect address is the one Chrome gives the extension",
    chrome.identity.getRedirectURL("cb"), "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/cb");
  const signIn = chrome.identity.launchWebAuthFlow({ url: "https://accounts.example/auth", interactive: true });
  await settle();
  const signInTab = window0.tabs[window0.tabs.length - 1];
  const signInUrl = signInTab.url;
  browser.application.fire("beforeNavigate", { target: signInTab,
    url: "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/cb?code=42",
    preventDefault() {}, __stopped: false }, true);
  equal("a sign-in opens the provider's page, and ends with the address it is sent back to",
    [signInUrl, await signIn, window0.tabs.indexOf(signInTab)],
    ["https://accounts.example/auth", "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/cb?code=42", -1]);
  const declined = chrome.identity.launchWebAuthFlow({ url: "https://accounts.example/auth", interactive: true });
  await settle();
  window0.tabs[window0.tabs.length - 1].close();
  equal("closing its tab turns it down", await failure(declined), "The user did not approve access.");
  tab.activate();

  // -- what Safari cannot do fails, and what it can partly do succeeds -------
  equal("zooming, discarding and uninstalling fail, as does a native message",
    [await failure(chrome.tabs.setZoom(tabId, 1.5)), await failure(chrome.tabs.discard(tabId)),
      await failure(chrome.management.uninstallSelf()),
      await failure(chrome.runtime.sendNativeMessage("com.example.host", {}))],
    ["Zooming a tab is not available in this browser.", "Cannot discard tab with id: " + tabId + ".",
      "An extension cannot uninstall itself in this browser.", "Specified native messaging host not found."]);
  await chrome.cookies.set({ url: "https://tracker.example/", name: "id", value: "1" });
  await chrome.cookies.set({ url: "https://kept.example/", name: "id", value: "2" });
  await chrome.browsingData.remove({ origins: ["https://tracker.example"] }, { cookies: true, history: true });
  equal("browsing data removes the cookies of the origins it names, though not history",
    browser.engine.cookies.filter((c) => /example$/.test(c.domain) && c.name === "id").map((c) => c.domain),
    ["kept.example"]);
  equal("and data none of which it can remove fails",
    await failure(chrome.browsingData.removeHistory({})),
    "Removing that browsing data is not available in this browser.");
  await chrome.browsingData.removeCookies({});
  equal("removing every cookie leaves none",
    browser.engine.cookies.filter((c) => c.domain === "kept.example").length, 0);

  // -- permissions -----------------------------------------------------------
  equal("there are no tab groups, and every tab is outside one",
    [chrome.tabGroups.TAB_GROUP_ID_NONE, await chrome.tabGroups.query({}),
     (await chrome.tabs.query({}))[0].groupId], [-1, [], -1]);
  equal("a permission for an API the host lacks is not held, nor granted on request",
    [await chrome.permissions.contains({ permissions: ["history"] }),
     await chrome.permissions.request({ permissions: ["bookmarks"] }),
     await chrome.permissions.contains({ permissions: ["storage", "tabs"] })],
    [false, false, true]);

  // -- cookies ------------------------------------------------------------
  await chrome.cookies.set({ url: "https://example.com/", name: "session", value: "abc",
    httpOnly: true });
  const cookie = await chrome.cookies.get({ url: "https://example.com/", name: "session" });
  check("cookies come from the engine, HttpOnly ones included",
    cookie && cookie.value === "abc" && cookie.httpOnly === true);

  // -- a frame that does not match --------------------------------------
  const otherTab = window0.openTab("background");
  otherTab.url = "https://blocked.example/page";
  const otherFrame = browser.createContentFrame(otherTab, [
    wex("wex-config.js"), wex("wex-core.js"), wex("wex-content.js"),
    wex("wex-run-start.js"), wex("wex-run-end.js")
  ], { url: "https://blocked.example/page" });
  check("a script whose matches exclude the page did not run",
    otherFrame.sandbox.__contentB === undefined);

  check("a script for a different host did not run",
    otherFrame.sandbox.__contentA === undefined);

  // -- subframes ---------------------------------------------------------
  const subframe = browser.createContentFrame(tab, [
    wex("wex-config.js"), wex("wex-core.js"), wex("wex-content.js"),
    wex("wex-run-start.js"), wex("wex-run-end.js")
  ], { isTop: false, url: "https://example.com/frame" });
  check("all_frames:false kept the script out of a subframe",
    subframe.sandbox.__contentA === undefined);
  equal("all_frames:true let the other script into the subframe",
    subframe.sandbox.__contentB, 1);

  // A subframe none of the content scripts apply to makes its chrome once
  // something there uses it: anything that reads it, or code an injection runs.
  {
    const files = [wex("wex-config.js"), wex("wex-core.js"), wex("wex-content.js"),
      wex("wex-run-start.js"), wex("wex-run-end.js")];
    const idleTab = window0.openTab("background");
    idleTab.url = "https://example.com/framing";
    const idle = browser.createContentFrame(idleTab, files, { isTop: false, url: "https://blocked.example/frame" });
    const before = Object.getOwnPropertyDescriptor(idle.sandbox, "chrome");
    check("a subframe no content script applies to has not made its chrome",
      !!before && typeof before.get === "function" && before.enumerable && before.configurable);
    const made = idle.sandbox.chrome;
    const after = Object.getOwnPropertyDescriptor(idle.sandbox, "chrome");
    equal("reading it makes it, as a plain property, with the browser presented",
      [typeof made.runtime.sendMessage, after.value === made, after.writable,
        idle.sandbox.navigator.userAgent.indexOf("Chrome/") >= 0],
      ["function", true, true, true]);
    const injected = browser.createContentFrame(idleTab, files, { isTop: false, url: "https://blocked.example/other" });
    const ran = injected.sandbox.__wexContent.exec({ sources: [{ code: "typeof chrome.runtime.getURL" }] });
    equal("an injection into such a frame makes it before the code runs",
      [ran.result, typeof Object.getOwnPropertyDescriptor(injected.sandbox, "chrome").get], ["function", "undefined"]);
    idleTab.close();
    await settle();
  }

  // A document that loaded before the extension started has no bridge; an
  // injection brings one for the code, which finds chrome there, and runs
  // none of the manifest's content scripts, as Chrome runs them only in
  // documents that load after.
  {
    const lateTab = window0.openTab("background");
    lateTab.url = "https://example.com/before";
    const late = browser.createContentFrame(lateTab, []);
    // Safari gives a world it injected nothing into no extension object.
    delete late.sandbox.safari;
    await settle();
    const lateId = (await chrome.tabs.query({})).find((t) => t.url === "https://example.com/before").id;
    equal("an injection into a document without the bridge finds chrome",
      await chrome.tabs.executeScript(lateId, { code: "[typeof chrome.runtime.sendMessage, chrome.runtime.getURL('/x.html')]" }),
      [["function", browser.baseURI + "x.html"]]);
    equal("and the manifest's content scripts did not run there",
      [late.sandbox.__contentA, late.sandbox.__contentB], [undefined, undefined]);
    lateTab.close();
    await settle();
  }

  let subframeSender;
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message.reportFrame) subframeSender = sender;
  });
  await subframe.sandbox.chrome.runtime.sendMessage({ reportFrame: true });
  equal("a subframe's messages carry its frame id",
    subframeSender && subframeSender.frameId, subframe.frameId);

  // -- web pages the extension lets in ---------------------------------------
  // A page externally_connectable matches gets Chrome's chrome.runtime for
  // web pages in its own world, which reaches onMessageExternal and
  // onConnectExternal with a web page's sender.
  {
    const pageTab = window0.openTab("background");
    pageTab.url = "https://example.com/page";
    const frame = browser.createContentFrame(pageTab, [
      wex("wex-config.js"), wex("wex-core.js"), wex("wex-content.js"),
      wex("wex-run-start.js"), wex("wex-run-end.js")
    ], { url: "https://example.com/page" });
    const doc = frame.sandbox.document;
    const page = { setTimeout, Promise, JSON, TypeError, Error, Object, document: doc,
      CustomEvent: frame.sandbox.CustomEvent };
    page.window = page;
    // The engine runs the bundle's wex/page-runtime.js in the page's world,
    // as the converter writes it.
    const id = globalPage.WEX.runtimeId;
    require("vm").runInNewContext("(" + globalPage.WEX.pageRuntime + ")(" +
      JSON.stringify(globalPage.WEX.pageRuntimeToken) + ", " + JSON.stringify(id) + ");", page);
    const received = [];
    const answerPages = (message, sender, sendResponse) => {
      received.push([message, sender.id, sender.url, sender.origin, sender.tab && sender.tab.id]);
      if (message.later) {
        setTimeout(() => sendResponse({ later: true }), 5);
        return true;
      }
      if (!message.silent) {
        sendResponse({ echo: message });
      }
      return undefined;
    };
    chrome.runtime.onMessageExternal.addListener(answerPages);
    chrome.runtime.onConnectExternal.addListener((port) => {
      received.push(["port", port.name, port.sender.origin]);
      port.onMessage.addListener((m) => port.postMessage({ back: m }));
    });
    const runtime = page.chrome && page.chrome.runtime;
    let noId;
    try {
      runtime.sendMessage({ x: 1 });
    } catch (e) {
      noId = e.message;
    }
    const replies = await Promise.all([
      runtime.sendMessage(id, { hi: 1 }),
      runtime.sendMessage(id, { later: 1 }),
      new Promise((resolve) => runtime.sendMessage(id, { silent: 1 }, (r) =>
        resolve([r, runtime.lastError && runtime.lastError.message]))),
      runtime.sendMessage("abcdefghijklmnopabcdefghijklmnop", {}).catch((e) => e.message)
    ]);
    const port = runtime.connect(id, { name: "chan" });
    const portReply = new Promise((resolve) => port.onMessage.addListener(resolve));
    port.postMessage({ ping: 1 });
    equal("a page the manifest lets in messages the extension as a web page does in Chrome",
      [typeof runtime, /must specify an Extension ID/.test(noId || ""), replies, await portReply,
        received.map((r) => r.slice(0, 4))],
      ["object", true, [{ echo: { hi: 1 } }, { later: true },
        [undefined, "The message port closed before a response was received."],
        "Could not establish connection. Receiving end does not exist."], { back: { ping: 1 } },
        [[{ hi: 1 }, undefined, "https://example.com/page", "https://example.com"],
          [{ later: 1 }, undefined, "https://example.com/page", "https://example.com"],
          [{ silent: 1 }, undefined, "https://example.com/page", "https://example.com"],
          ["port", "chan", "https://example.com"]]]);
    chrome.runtime.onMessageExternal.removeListener(answerPages);
    check("and a page it does not name gets nothing",
      !otherFrame.sandbox.document.__elements.some((el) => /__wexRoutes/.test(el.textContent || "")));
    pageTab.close();
    await settle();
  }

  let topHeard = 0;
  content.chrome.runtime.onMessage.addListener((message) => {
    if (message.toSubframe) topHeard += 1;
  });
  subframe.sandbox.chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message.toSubframe) reply({ from: "subframe" });
  });
  const subReply = await chrome.tabs.sendMessage(tabId, { toSubframe: true },
    { frameId: subframe.frameId });
  equal("a targeted message reaches the subframe", subReply, { from: "subframe" });
  equal("and only the subframe", topHeard, 0);

  const targetedResults = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [subframe.frameId] }, files: ["injected.js"]
  });
  equal("an injection runs in the requested subframe",
    injected(targetedResults), [{ frameId: subframe.frameId, result: 42 }]);

  const everyFrame = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true }, func: function () { return 1; }
  });
  equal("an injection into all frames reports each frame",
    everyFrame.map((r) => r.frameId).sort(), [0, subframe.frameId]);

  {
    // A popover of the extension has the keyboard: the click on the page
    // that hides it starts a drag Safari gives no mousemoves of.
    const port = globalPage.WEX.native.tabs.connect(tabId,
      { name: globalPage.WEX.INTERNAL_PORT + "popover-focus", frameId: 0 });
    const reports = [];
    port.onMessage.addListener((m) => reports.push(m));
    await settle();
    const heard = [];
    const target = { dispatchEvent: (e) => heard.push([e.type, e.clientX, e.clientY, e.buttons, e.isTrusted]) };
    const mouse = (type, x, y) => ({ type, isTrusted: true, button: 0, clientX: x, clientY: y,
      screenX: x, screenY: y, target });
    content.dispatchEvent({ type: "focus", isTrusted: true, target: vm.runInContext("this", content) });
    content.dispatchEvent(mouse("mousedown", 10, 20));
    content.dispatchEvent(mouse("mouseup", 200, 120));
    await settle();
    equal("a drag that brings the page back from a popover is given its move before its mouseup",
      [heard, reports], [[["mousemove", 200, 120, 1, false]], [{ activation: true, dragged: true }]]);
    content.dispatchEvent(mouse("mousedown", 10, 20));
    content.dispatchEvent(mouse("mouseup", 200, 120));
    await settle();
    equal("and the page's drags after it are its own", heard.length, 1);
  }

  {
    // The commands' shortcuts, pressed in a page.
    const commandsRun = [];
    chrome.commands.onCommand.addListener((name, tab) => commandsRun.push([name, tab && tab.id]));
    const press = (code, mods) => {
      const e = { type: "keydown", isTrusted: true, code, metaKey: !!mods.meta, ctrlKey: !!mods.ctrl,
        altKey: !!mods.alt, shiftKey: !!mods.shift, repeat: false, prevented: false, stopped: false };
      e.preventDefault = () => { e.prevented = true; };
      e.stopImmediatePropagation = () => { e.stopped = true; };
      content.dispatchEvent(e);
      return e.prevented && e.stopped;
    };
    const taken = [press("KeyD", { ctrl: true, shift: true }), press("KeyT", { alt: true }),
      press("KeyD", { ctrl: true })];
    await settle();
    equal("a command's shortcut pressed in a page is reported with the tab, and the page does not get the key",
      [taken, commandsRun], [[true, false, false], [["do-thing", tabId]]]);
    equal("and getAll gives each shortcut as a Mac writes it",
      (await chrome.commands.getAll()).map((c) => [c.name, c.shortcut]),
      [["_execute_action", "\u21e7\u2318Y"], ["do-thing", "\u2303\u21e7D"], ["unbound", ""]]);
  }

  let subframePort;
  subframe.sandbox.chrome.runtime.onConnect.addListener((incoming) => {
    if (incoming.name === "targeted") subframePort = incoming;
  });
  let topPorts = 0;
  content.chrome.runtime.onConnect.addListener(() => {
    topPorts += 1;
  });
  const targetedPort = chrome.tabs.connect(tabId,
    { name: "targeted", frameId: subframe.frameId });
  await settle();
  check("a targeted port opens in the requested subframe", !!subframePort);
  equal("and not in the top frame", topPorts, 0);
  const subframePortMessages = [];
  subframePort.onMessage.addListener((message) => subframePortMessages.push(message));
  targetedPort.postMessage({ privateToSubframe: true });
  await settle();
  equal("the targeted port message reaches its subframe", subframePortMessages,
    [{ privateToSubframe: true }]);

  const topHostedApiFrame = browser.createContentFrame(tab, [
    wex("wex-config.js"), wex("wex-core.js"), wex("wex-content.js")
  ], { isTop: false, noSafariInFrame: true, url: "https://example.com/no-host-api" });
  equal("a subframe can resolve the host API through its top frame",
    topHostedApiFrame.sandbox.WEX.baseURI, browser.baseURI);
  equal("a subframe without its own Safari binding can message the background",
    await topHostedApiFrame.sandbox.chrome.runtime.sendMessage({ wants: "reply" }),
    { ok: true, from: "background" });

  // -- alarms -------------------------------------------------------------
  const fired = [];
  chrome.alarms.onAlarm.addListener((alarm) => fired.push(alarm.name));
  chrome.alarms.create("soon", { delayInMinutes: 0 });
  await settle();
  equal("an alarm fires", fired, ["soon"]);
  const cleared = await chrome.alarms.clear("gone");
  equal("clearing an unknown alarm reports nothing was cleared", cleared, false);

  // -- Chrome's rules for menus and registered scripts -------------------
  {
    const lastErrorOf = (call) => new Promise((resolve) => {
      call(() => resolve(chrome.runtime.lastError ? chrome.runtime.lastError.message : null));
    });
    equal("contextMenus.create refuses what Chrome refuses for a service worker's extension", [
      await lastErrorOf((cb) => chrome.contextMenus.create({ title: "no id" }, cb)),
      await lastErrorOf((cb) => chrome.contextMenus.create({ id: "m1", title: "one" }, cb)),
      await lastErrorOf((cb) => chrome.contextMenus.create({ id: "m1", title: "again" }, cb)),
      await lastErrorOf((cb) => chrome.contextMenus.create({ id: "m2", title: "t", onclick() {} }, cb)),
      await lastErrorOf((cb) => chrome.contextMenus.create({ id: "m3" }, cb)),
      await lastErrorOf((cb) => chrome.contextMenus.create({ id: "m4", title: "c", parentId: "nope" }, cb)),
      await chrome.contextMenus.remove("nope").then(() => null, (e) => e.message)
    ], [
      "Extensions using event pages or Service Workers must pass an id parameter to chrome.contextMenus.create",
      null,
      "Cannot create item with duplicate id m1",
      "Extensions using event pages or Service Workers cannot pass an onclick parameter to " +
        "chrome.contextMenus.create. Instead, use the chrome.contextMenus.onClicked event.",
      "All menu items except for separators must have a title",
      "Cannot find menu item with id nope",
      "Cannot find menu item with id nope"
    ]);
    await chrome.contextMenus.remove("m1");
    {
      // A failure's lastError is its callback's alone: a callback that runs
      // first, of a call that succeeded, sees none.
      const seen = [];
      chrome.contextMenus.remove("nope", () => seen.push(["failed", chrome.runtime.lastError && chrome.runtime.lastError.message]));
      seen.push(["right after", chrome.runtime.lastError || null]);
      await new Promise((resolve) => chrome.contextMenus.create({ id: "m5", title: "five" },
        () => resolve(seen.push(["succeeded", chrome.runtime.lastError || null]))));
      await new Promise((resolve) => setTimeout(resolve, 10));
      seen.sort();
      equal("a failing call's lastError does not reach another call's callback", seen,
        [["failed", "Cannot find menu item with id nope"], ["right after", null], ["succeeded", null]]);
      await chrome.contextMenus.remove("m5");
    }
    const attempt = (p) => p.then(() => "ok", (e) => e.message);
    equal("scripting.registerContentScripts refuses what Chrome refuses", [
      await attempt(chrome.scripting.registerContentScripts([{ id: "", matches: ["<all_urls>"], js: ["content-a.js"] }])),
      await attempt(chrome.scripting.registerContentScripts([{ id: "_x", matches: ["<all_urls>"], js: ["content-a.js"] }])),
      await attempt(chrome.scripting.registerContentScripts([{ id: "a", js: ["content-a.js"] }])),
      await attempt(chrome.scripting.registerContentScripts([{ id: "a", matches: ["<all_urls>"] }])),
      await attempt(chrome.scripting.registerContentScripts([{ id: "a", matches: ["<all_urls>"], js: ["missing.js"] }])),
      await attempt(chrome.scripting.registerContentScripts([
        { id: "d", matches: ["<all_urls>"], js: ["content-a.js"] }, { id: "d", matches: ["<all_urls>"], js: ["content-a.js"] }])),
      await attempt(chrome.scripting.unregisterContentScripts({ ids: ["never"] }))
    ], [
      "Script's ID must not be empty",
      "Script's ID '_x' must not start with '_'",
      "Script with ID 'a' must specify 'matches'.",
      "Script with ID 'a' must specify at least one js or css file.",
      "Could not load javascript 'missing.js' for script.",
      "Duplicate script ID 'd'",
      "Nonexistent script ID 'never'"
    ]);
    await chrome.scripting.registerContentScripts([{ id: "n", matches: ["*://*/*"], js: ["/content-a.js"] }]);
    equal("and describes a script back as Chrome does", await chrome.scripting.getRegisteredContentScripts({ ids: ["n"] }),
      [{ id: "n", matches: ["*://*/*"], js: ["content-a.js"], allFrames: false, runAt: "document_idle",
        matchOriginAsFallback: false, persistAcrossSessions: true, world: "ISOLATED" }]);
    await chrome.scripting.unregisterContentScripts({ ids: ["n"] });
  }

  equal("a browser's own pages are refused before any tab opens, with Chrome's error",
    [await chrome.tabs.create({ url: "chrome://extensions/shortcuts" }).then(() => "opened", (e) => e.message),
      await chrome.windows.create({ url: ["chrome://version"] }).then(() => "opened", (e) => e.message)],
    ['Invalid url: "chrome://extensions/shortcuts".', 'Invalid url: "chrome://version".']);

  {
    const value = globalPage.WEX.resultValue;
    const cyclic = { a: 1 };
    cyclic.bar = cyclic;
    const list = [1, "2", 3.4];
    list.push(list);
    const withExtra = [1, 2];
    withExtra.foo = "bar";
    const shared = { n: 1 };
    equal("a script's result is the value Chrome makes of it", [
      value(cyclic), value(list), value(withExtra), value(new Map([[1, 2]])),
      value({ f() {}, u: undefined, n: NaN, k: 1 }), value([undefined, () => 1, Infinity]),
      value({ x: shared, y: shared }), value(undefined)
    ], [
      { a: 1, bar: null }, [1, "2", 3.4, null], [1, 2], {}, { k: 1 }, [null, null, null],
      { x: { n: 1 }, y: { n: 1 } }, undefined
    ]);
  }

  // -- the side panel -------------------------------------------------------
  // It shows in a popover of the toolbar button, and is reported open, as a
  // context, until it hides.
  {
    const item = browser.toolbarItems[0];
    const opened = [];
    const closed = [];
    chrome.sidePanel.onOpened.addListener((info) => opened.push(info.path));
    chrome.sidePanel.onClosed.addListener((info) => closed.push(info.path));
    equal("sidePanel describes the manifest's panel, and opening needs a tab or a window",
      [await chrome.sidePanel.getOptions({}), await chrome.sidePanel.getPanelBehavior(),
        await chrome.sidePanel.open({}).then(() => "opened", (e) => e.message)],
      [{ enabled: true, path: "panel.html" }, { openPanelOnActionClick: false },
        "At least one of `tabId` and `windowId` must be provided"]);
    const windowId = (await chrome.windows.getCurrent()).id;
    await chrome.sidePanel.open({ windowId });
    const panel = browser.popovers.find((p) => p.identifier === "wex-sidepanel");
    equal("opening shows the panel in a popover of its own, reported as a side panel context",
      [!!panel && panel.visible, panel && panel.contentURL.endsWith("/panel.html"), item.popover === panel, opened,
        (await chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] })).length],
      [true, true, true, ["panel.html"], 1]);
    await chrome.sidePanel.close({ windowId });
    await settle(500);
    equal("closing hides it, reports it closed, and gives the button back its popup",
      [panel.visible, closed, item.popover === browser.popover,
        (await chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] })).length],
      [false, ["panel.html"], true, 0]);
  }

  // -- tab groups -------------------------------------------------------------
  // Safari draws none; the runtime keeps them, with Chrome's calls and events.
  {
    const groupWindow = browser.openWindow();
    const first = groupWindow.openTab();
    first.url = "https://example.com/one";
    const other = groupWindow.openTab();
    other.url = "https://example.org/other";
    const second = groupWindow.openTab();
    second.url = "https://example.com/two";
    await settle(20);
    const ids = {};
    for (const t of await chrome.tabs.query({})) {
      ids[t.url] = t.id;
    }
    const events = [];
    const log = (name) => (info) => events.push([name, info.title, info.collapsed]);
    chrome.tabGroups.onCreated.addListener(log("created"));
    chrome.tabGroups.onUpdated.addListener(log("updated"));
    chrome.tabGroups.onRemoved.addListener(log("removed"));
    const groupId = await chrome.tabs.group({ tabIds: [ids["https://example.com/one"], ids["https://example.com/two"]] });
    const grouped = await chrome.tabs.query({ groupId });
    equal("tabs.group makes a group, with its tabs together and reporting it",
      [typeof groupId, grouped.map((t) => t.url), (await chrome.tabs.get(ids["https://example.org/other"])).groupId,
        groupWindow.tabs.map((t) => t.url).slice(-3)],
      ["number", ["https://example.com/one", "https://example.com/two"], -1,
        ["https://example.com/one", "https://example.com/two", "https://example.org/other"]]);
    const updated = await chrome.tabGroups.update(groupId, { title: "Work", color: "blue" });
    equal("a group is found, queried and updated as in Chrome",
      [updated.title, updated.color, (await chrome.tabGroups.get(groupId)).title,
        (await chrome.tabGroups.query({ title: "Wo*" })).map((g) => g.id),
        await chrome.tabGroups.get(groupId + 99).then(() => "found", (e) => e.message),
        await chrome.tabs.group({ tabIds: [] }).then(() => "grouped", (e) => e.message)],
      ["Work", "blue", "Work", [groupId], "No group with id: " + (groupId + 99) + ".",
        "You must specify at least one tab."]);
    await chrome.tabs.ungroup([ids["https://example.com/one"], ids["https://example.com/two"]]);
    equal("ungrouping its last tab removes the group",
      [events.map((e) => e[0]), await chrome.tabGroups.query({})],
      [["created", "updated", "removed"], []]);
    [first, other, second].forEach((t) => t.close());
    groupWindow.close();
    await settle(20);
  }

  // -- the debugger -----------------------------------------------------------
  // Chrome's protocol, carried out with WebKit's input from extensions and,
  // for evaluating and the console, the tab's Web Inspector backend.
  {
    const tabId = (await chrome.tabs.query({})).find((t) => /^https?:/.test(t.url)).id;
    const target = { tabId };
    const failure = (promise) => promise.then(() => "succeeded", (e) => e.message);
    const events = [];
    chrome.debugger.onEvent.addListener((source, method, params) => events.push([source.tabId, method, params]));
    equal("attaching checks the tab and the protocol version as Chrome does",
      [await failure(chrome.debugger.attach({ tabId: 987654 }, "1.3")),
        await failure(chrome.debugger.attach(target, "2.0")),
        await failure(chrome.debugger.sendCommand(target, "Input.insertText", { text: "x" }))],
      ["No tab with given id 987654.", "Requested protocol version is not supported: 2.0.",
        "Debugger is not attached to the tab with id: " + tabId + "."]);
    await chrome.debugger.attach(target, "1.3");
    equal("and one extension attaches to a tab once",
      await failure(chrome.debugger.attach(target, "1.3")),
      "Another debugger is already attached to the tab with id: " + tabId + ".");

    aquaCalls.length = 0;
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent",
      { type: "mouseMoved", x: 5, y: 6, button: "none", buttons: 0 });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent",
      { type: "mousePressed", x: 10, y: 20, button: "left", buttons: 1, clickCount: 1, modifiers: 8 });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent",
      { type: "mouseMoved", x: 12, y: 22, button: "left", buttons: 1 });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent",
      { type: "mouseWheel", x: 1, y: 2, deltaX: 0, deltaY: 120 });
    equal("mouse events become WebKit's, a move with a button held a drag",
      aquaCalls.map((c) => c[1]),
      [{ type: "mouseMoved", x: 5, y: 6, modifiers: [], buttons: 0 },
        { type: "mouseDown", x: 10, y: 20, modifiers: ["shift"], button: "left", buttons: 1, clickCount: 1 },
        { type: "mouseDragged", x: 12, y: 22, modifiers: [], button: "left", buttons: 1 },
        { type: "scrollWheel", x: 1, y: 2, modifiers: [], deltaX: 0, deltaY: 120 }]);

    aquaCalls.length = 0;
    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent",
      { type: "keyDown", key: "A", code: "KeyA", text: "A", unmodifiedText: "a", modifiers: 8 });
    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent",
      { type: "rawKeyDown", key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 });
    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent",
      { type: "keyDown", key: "Shift", windowsVirtualKeyCode: 16, modifiers: 0 });
    await chrome.debugger.sendCommand(target, "Input.insertText", { text: "hi" });
    equal("key events become WebKit's, by macOS key code, and text is inserted",
      aquaCalls.map((c) => c[1]),
      [{ type: "keyDown", keyCode: 0, characters: "A", charactersIgnoringModifiers: "a", modifiers: ["shift"],
        isRepeat: false },
        { type: "keyDown", keyCode: 123, characters: "\uf702", charactersIgnoringModifiers: "\uf702",
          modifiers: [], isRepeat: false },
        { type: "flagsChanged", keyCode: 56, modifiers: ["shift"] },
        "hi"]);
    aquaCalls.length = 0;
    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent",
      { type: "keyDown", key: "a", code: "KeyA", modifiers: 4, commands: ["selectAll", "redo", "deleteBackward"] });
    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent",
      { type: "keyDown", key: "c", code: "KeyC", modifiers: 4, commands: ["copy"] });
    equal("a key's editing commands are the Edit menu's actions, a disabled one passed over",
      aquaCalls.filter((c) => c[0] === "edit"), [["edit", "selectAll:"], ["edit", "copy:"]]);

    aquaCalls.length = 0;
    await chrome.debugger.sendCommand(target, "Page.enable");
    const openDialog = (dialog) => {
      browser.aqua.dialog.open = dialog;
      browser.aqua.dialog.onOpen.listeners.forEach((fn) => fn(tabId, dialog));
    };
    events.length = 0;
    openDialog({ type: "prompt", message: "Name?", defaultText: "Ann" });
    await chrome.debugger.sendCommand(target, "Page.handleJavaScriptDialog", { accept: true, promptText: "Bo" });
    equal("a page's dialog is reported, and answered as the user would answer it",
      [events.filter((e) => /Dialog/.test(e[1])).map((e) => [e[1], e[2].type || e[2].result,
        e[2].message || e[2].userInput, e[2].defaultPrompt]), aquaCalls],
      [[["Page.javascriptDialogOpening", "prompt", "Name?", "Ann"], ["Page.javascriptDialogClosed", true, "Bo", undefined]],
        [["answer", { accept: true, text: "Bo" }]]]);
    equal("answering when no dialog is open fails as in Chrome",
      [await failure(chrome.debugger.sendCommand(target, "Page.handleJavaScriptDialog", { accept: false })),
        await failure(chrome.debugger.sendCommand(target, "Page.handleJavaScriptDialog", {}))],
      ['{"code":-32000,"message":"No dialog is showing"}',
        '{"code":-32602,"data":"Failed to deserialize params.accept - BINDINGS: mandatory field missing","message":"Invalid parameters"}']);

    equal("a method there is no way to carry out fails as one Chrome lacks",
      [await failure(chrome.debugger.sendCommand(target, "DOM.getDocument", {})),
        await failure(chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "tap", x: 1, y: 1 }))],
      ['{"code":-32601,"message":"\'DOM.getDocument\' wasn\'t found"}',
        '{"code":-32602,"message":"Unexpected event type \'tap\'"}']);

    aquaCalls.length = 0;
    const evaluated = await chrome.debugger.sendCommand(target, "Runtime.evaluate",
      { expression: "1 + 1", returnByValue: true });
    const thrown = await chrome.debugger.sendCommand(target, "Runtime.evaluate",
      { expression: "{ return 1 }", replMode: true });
    equal("evaluating goes to the page's own world, through its Web Inspector backend",
      [evaluated, thrown.exceptionDetails.exception.className, thrown.exceptionDetails.exception.description,
        typeof thrown.exceptionDetails.scriptId, aquaCalls[0]],
      [{ result: { type: "number", value: 2, description: "2" } }, "SyntaxError",
        "SyntaxError: Illegal return statement", "string", ["attach"]]);

    events.length = 0;
    await chrome.debugger.sendCommand(target, "Runtime.enable");
    await settle(20);
    equal("its console is reported once Runtime is enabled",
      events.map((e) => [e[1], e[2].type || null, e[2].args ? e[2].args[0].value : null]),
      [["Runtime.executionContextCreated", null, null], ["Runtime.consoleAPICalled", "warning", "careful"]]);

    chrome.__wexNative.tabs.captureTab = async (id, options) =>
      "data:image/jpeg;base64,SHOT:" + JSON.stringify([id, options]);
    const shot = await chrome.debugger.sendCommand(target, "Page.captureScreenshot",
      { format: "jpeg", quality: 50, clip: { x: 1, y: 2, width: 30, height: 40, scale: 1 } });
    equal("a screenshot is the engine's capture of the tab",
      shot.data, "SHOT:" + JSON.stringify([tabId, { format: "jpeg", quality: 50,
        rect: { x: 1, y: 2, width: 30, height: 40 }, scale: 1 }]));

    aquaCalls.length = 0;
    await chrome.debugger.detach(target);
    await settle(5);
    equal("detaching lets go of the Web Inspector backend",
      [aquaCalls, await failure(chrome.debugger.sendCommand(target, "Input.insertText", { text: "x" }))],
      [[["detach"]], "Debugger is not attached to the tab with id: " + tabId + "."]);
  }

  // -- what Chrome gives that Safari can carry out -------------------------
  {
    // The action, enabled for one tab, and shown by a declarativeContent rule
    // on the pages it names.
    const item = browser.toolbarItems[0];
    const elsewhere = window0.openTab("background");
    elsewhere.navigate("https://elsewhere.example/");
    await settle();
    await chrome.action.disable();
    tab.activate();
    const disabledEverywhere = item.disabled;
    const added = await new Promise((resolve) => chrome.declarativeContent.onPageChanged.addRules([{
      conditions: [new chrome.declarativeContent.PageStateMatcher({ pageUrl: { hostSuffix: "example.com" } })],
      actions: [new chrome.declarativeContent.ShowAction()]
    }], resolve));
    await settle(20);
    tab.activate();
    const shownHere = !item.disabled;
    elsewhere.activate();
    const hiddenElsewhere = item.disabled;
    equal("a declarativeContent rule shows the action on the pages it names, and not elsewhere",
      [disabledEverywhere, shownHere, hiddenElsewhere, added.map((r) => [r.id, r.priority])],
      [true, true, true, [["_0_", 100]]]);
    equal("and isEnabled counts only what the extension set, as Chrome's does",
      await chrome.action.isEnabled(tabId), false);
    await chrome.action.enable(elsewhere.engineId);
    elsewhere.activate();
    const enabledForOne = !item.disabled;
    tab.activate();
    await new Promise((resolve) => chrome.declarativeContent.onPageChanged.removeRules(resolve));
    await settle(20);
    tab.activate();
    equal("a tab the action is enabled for alone has it, and removing the rules hides it again",
      [enabledForOne, item.disabled, await new Promise((resolve) => chrome.declarativeContent.onPageChanged.getRules(resolve))],
      [true, true, []]);
    let invalid = null;
    try {
      chrome.declarativeContent.onPageChanged.addRules("rules");
    } catch (e) {
      invalid = e.constructor.name + ": " + e.message;
    }
    equal("rules of the wrong kind are refused as Chrome refuses them", invalid, "TypeError: Invalid invocation");
    await chrome.action.enable();
    elsewhere.close();
    await settle();

    // Speech, by Safari's speech synthesis.
    const heard = [];
    await chrome.tts.speak("hello world", { rate: 2, onEvent: (e) => heard.push([e.type, e.charIndex]) });
    await settle(20);
    equal("speech is Safari's, with the utterance's events",
      [browser.speech.spoken[browser.speech.spoken.length - 1], heard],
      [{ text: "hello world", rate: 2 }, [["start", 0], ["word", 0], ["end", 11]]]);
    const first = [];
    const second = [];
    const third = [];
    chrome.tts.speak("one", { onEvent: (e) => first.push(e.type) });
    chrome.tts.speak("two", { enqueue: true, onEvent: (e) => second.push(e.type) });
    chrome.tts.speak("three", { onEvent: (e) => third.push(e.type) });
    await settle(30);
    equal("an utterance not queued cancels those before it", [first, second, third],
      [["cancelled"], ["cancelled"], ["start", "word", "end"]]);
    equal("and Safari's voices are tts's", (await chrome.tts.getVoices()).map((v) => [v.voiceName, v.lang]),
      [["Alex", "en-US"]]);

    // The address bar keyword.
    const entered = [];
    chrome.omnibox.onInputEntered.addListener((text, disposition) => entered.push([text, disposition]));
    let prevented = 0;
    for (const query of ["wx find this", "an ordinary search"]) {
      browser.application.fire("beforeSearch",
        { target: tab, query, preventDefault() { prevented += 1; }, __stopped: false }, true);
    }
    equal("a search that starts with the omnibox keyword goes to the extension, and no other",
      [entered, prevented], [[["find this", "currentTab"]], 1]);

    equal("restarting is for ChromeOS kiosk mode alone, as Chrome on a Mac says",
      await chrome.runtime.restartAfterDelay(5).then(() => "restarted", (e) => e.message),
      "API available only for ChromeOS kiosk mode.");
    await chrome.action.setBadgeTextColor({ color: [1, 2, 3, 255], tabId });
    equal("a badge color set is the one read back, for its tab",
      [await chrome.action.getBadgeTextColor({ tabId }), await chrome.action.getBadgeTextColor({})],
      [[1, 2, 3, 255], [255, 255, 255, 255]]);
  }

  // -- toolbar clicks -------------------------------------------------------
  // A toolbar item carries a popover or a command. Without a popup it carries
  // the command, and the command is the click.
  const actionClicks = [];
  const onActionClicked = (t) => actionClicks.push(t);
  chrome.action.onClicked.addListener(onActionClicked);

  await chrome.action.setPopup({ popup: "" });
  equal("without a popup the toolbar item carries the command",
    [browser.toolbarItems[0].command, browser.toolbarItems[0].popover], ["wex-action", null]);
  browser.application.fire("command", { command: "wex-action", __stopped: false }, true);
  await settle();
  equal("the command is reported as a click", actionClicks.length, 1);
  check("the click names the active tab",
    actionClicks[0] && actionClicks[0].url === tab.url && actionClicks[0].id === tabId);

  // Safari has native extension menus for toolbar items, which it shows as
  // the button is pressed, reporting no command for the click. Action-context
  // entries keep their tree and checks there, on an item whose click has
  // nothing else to do: no popup, and no one listening for onClicked.
  chrome.action.onClicked.removeListener(onActionClicked);
  const actionMenuClicks = [];
  let actionMenuShown = 0;
  chrome.contextMenus.onClicked.addListener((info) => actionMenuClicks.push(info));
  chrome.contextMenus.onShown.addListener(() => { actionMenuShown += 1; });
  chrome.contextMenus.create({ id: "action-parent", title: "Interface", contexts: ["action"] });
  chrome.contextMenus.create({ id: "action-popup", title: "Popup", contexts: ["action"],
    parentId: "action-parent", type: "radio", checked: true });
  chrome.contextMenus.create({ id: "action-tab", title: "Tab", contexts: ["action"],
    parentId: "action-parent", type: "radio" });
  const nativeActionMenu = browser.toolbarItems[0].menu;
  equal("action context items make a native toolbar menu, keeping its command",
    [browser.toolbarItems[0].command, nativeActionMenu && nativeActionMenu.menuItems.map((entry) => entry.title)],
    ["wex-action", ["Interface"]]);
  equal("the action menu keeps its submenu and checked state",
    nativeActionMenu.menuItems[0].submenu.menuItems.map((entry) => [entry.title, entry.checkedState]),
    [["Popup", 1], ["Tab", 0]]);
  browser.application.fire("menu", { target: nativeActionMenu, __stopped: false }, true);
  equal("showing the native action menu reports contextMenus.onShown", actionMenuShown, 1);
  browser.application.fire("command",
    { command: "wex-menu:action-tab", target: browser.toolbarItems[0], __stopped: false }, true);
  await settle();
  equal("choosing its radio item reports the action menu click and updates its checks",
    [actionMenuClicks.map((info) => [info.menuItemId, info.checked]),
     nativeActionMenu.menuItems[0].submenu.menuItems.map((entry) => entry.checkedState)],
    [[["action-tab", true]], [0, 1]]);
  chrome.action.onClicked.addListener(onActionClicked);
  equal("an item whose click is reported as onClicked carries no menu, which would take the click",
    browser.toolbarItems[0].menu, null);
  chrome.action.onClicked.removeListener(onActionClicked);
  check("and gets it back when no one listens", !!browser.toolbarItems[0].menu);
  chrome.action.onClicked.addListener(onActionClicked);
  await chrome.contextMenus.removeAll();
  equal("removing the action items detaches the empty native menu", browser.toolbarItems[0].menu, null);

  await chrome.action.setPopup({ popup: "/popup.html" });
  equal("with a popup the toolbar item carries the popover",
    [browser.toolbarItems[0].command, browser.toolbarItems[0].popover === browser.popover],
    ["wex-action", true]);
  browser.popover.visible = false;
  browser.application.fire("command",
    { command: "wex-action", target: browser.toolbarItems[0], __stopped: false }, true);
  equal("a popup set after conversion opens on the ordinary toolbar click without reporting onClicked",
    [browser.popover.visible, actionClicks.length], [true, 1]);
  browser.popover.visible = false;
  chrome.contextMenus.create({ id: "popup-action-menu", title: "Popup setting", contexts: ["action"] });
  equal("an item with a popup carries the popover and no action menu, which would take the click",
    [browser.toolbarItems[0].menu, browser.toolbarItems[0].popover === browser.popover], [null, true]);
  browser.application.fire("command",
    { command: "wex-action", target: browser.toolbarItems[0], __stopped: false }, true);
  equal("and its click shows the popup",
    [browser.toolbarItems[0].menu, browser.toolbarItems[0].popover === browser.popover,
     browser.popover.visible], [null, true, true]);
  equal("which rests on a blank page until it shows", browser.popover.contentURL, "");
  {
    // Chrome resolves a relative popup against the extension's root, from a
    // background in any folder.
    const href = globalPage.location.href;
    globalPage.location.href = browser.baseURI + "background/wex-global-page.html";
    await chrome.action.setPopup({ tabId, popup: "popups/popup.html" });
    globalPage.location.href = href;
    equal("a relative popup is the one at that path from the extension's root",
      await chrome.action.getPopup({ tabId }), browser.baseURI + "popups/popup.html");
    await chrome.action.setPopup({ tabId, popup: "/popup.html" });
  }
  // A window opened later has the toolbar item the bundle declares.
  const laterItem = { identifier: "wex-toolbar", command: "wex-action", popover: null, badge: 0 };
  browser.toolbarItems.push(laterItem);
  browser.application.fire("validate", { command: "wex-action", target: laterItem, __stopped: false }, true);
  equal("and so does the toolbar item of a window opened after",
    [laterItem.command, laterItem.menu, laterItem.popover === browser.popover], ["wex-action", null, true]);
  browser.toolbarItems.pop();

  // A browser opens the popup as a new document each time; the popover is
  // reloaded to match.
  let popoverReloads = 0;
  let popoverReplaced = null;
  const popoverLocation = {
    href: browser.baseURI + "popup.html",
    reload: () => { popoverReloads += 1; },
    replace: (url) => { popoverReplaced = url; }
  };
  browser.popover.contentWindow = { location: popoverLocation };
  browser.application.fire("popover", { target: browser.popover, __stopped: false }, true);
  equal("the popover is reloaded each time it is about to show", popoverReloads, 1);
  popoverLocation.href = browser.baseURI + "options.html";
  browser.application.fire("popover", { target: browser.popover, __stopped: false }, true);
  equal("a popover a link moved elsewhere goes back to the popup page",
    popoverReplaced, browser.baseURI + "popup.html");
  // A browser closes the popup's document when the popup closes.
  browser.popover.visible = true;
  await settle(500);
  browser.popover.visible = false;
  await settle(500);
  equal("once the popover has shown and hidden, it goes back to its blank page",
    popoverReplaced, browser.baseURI + "wex/wex-popover.html");
  equal("and the item keeps its popover", [browser.toolbarItems[0].menu, browser.toolbarItems[0].popover === browser.popover],
    [null, true]);

  // A popup set for one tab is the one that tab shows.
  const [popupTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.action.setPopup({ tabId: popupTab.id, popup: "/other.html" });
  equal("a popup set for a tab is that tab's",
    [await chrome.action.getPopup({ tabId: popupTab.id }), await chrome.action.getPopup({})],
    [browser.baseURI + "other.html", browser.baseURI + "popup.html"]);
  popoverLocation.href = browser.baseURI + "popup.html";
  browser.application.fire("popover", { target: browser.popover, __stopped: false }, true);
  equal("and the popover opening over the tab shows it", popoverReplaced, browser.baseURI + "other.html");
  await chrome.action.setPopup({ tabId: popupTab.id, popup: "" });
  equal("a tab set to have no popup gets the command",
    [browser.toolbarItems[0].command, browser.toolbarItems[0].popover], ["wex-action", null]);
  await chrome.action.setPopup({ tabId: popupTab.id, popup: "/popup.html" });
  equal("and the popover again once it has one",
    [browser.toolbarItems[0].menu, browser.toolbarItems[0].popover === browser.popover], [null, true]);
  await chrome.contextMenus.removeAll();
  browser.popover.contentWindow = null;

  // Safari opens nothing when the global page calls window.open; it opens a
  // tab, as in Chrome.
  const tabsBeforeOpen = window0.tabs.length;
  const opened = globalPage.open("https://opened.example/");
  await settle();
  equal("window.open from the global page opens a tab", window0.tabs.length, tabsBeforeOpen + 1);
  equal("at the address asked for", window0.tabs[window0.tabs.length - 1].url, "https://opened.example/");
  check("and returns something that stands for the window", opened && typeof opened.focus === "function");
  opened.close();
  await settle();
  equal("closing what it returned closes the tab", window0.tabs.length, tabsBeforeOpen);

  // The real Safari URL setter lowercases the identifier. All public navigation
  // paths must reach WebKit instead, retaining query strings and fragments.
  const extensionTarget = browser.baseURI + "page.html?url=https%3A%2F%2Fexample.com%2F&title=Test#section";
  const extensionTab = await chrome.tabs.create({ url: extensionTarget });
  equal("tabs.create preserves extension identifier and parameters", extensionTab.url, extensionTarget);
  const changedTarget = extensionTarget.replace("#section", "#updated");
  const changedTab = await chrome.tabs.update(extensionTab.id, { url: changedTarget });
  equal("tabs.update uses native navigation for a bound tab", changedTab.url, changedTarget);
  let createCalls = 0;
  const callbackTab = await new Promise(resolve => chrome.tabs.create({ url: extensionTarget }, value => {
    createCalls += 1; resolve(value);
  }));
  equal("extension tab callback fires once", createCalls, 1);
  equal("extension tab callback receives the navigated tab", callbackTab.url, extensionTarget);
  const simultaneous = await Promise.all([
    chrome.tabs.create({ url: extensionTarget }),
    chrome.tabs.create({ url: changedTarget })
  ]);
  equal("concurrent extension tabs reach their own URLs", simultaneous.map(t => t.url),
    [extensionTarget, changedTarget]);
  check("concurrent extension tabs have distinct engine ids", simultaneous[0].id !== simultaneous[1].id);
  const extensionWindow = await chrome.windows.create({ url: [extensionTarget, changedTarget] });
  equal("windows.create preserves both extension URLs", extensionWindow.tabs.map(t => t.url),
    [extensionTarget, changedTarget]);
  await chrome.windows.remove(extensionWindow.id);
  const duplicate = await chrome.tabs.duplicate(extensionTab.id);
  equal("duplicate preserves extension URL case", duplicate.url, changedTarget);
  await chrome.tabs.remove([extensionTab.id, callbackTab.id, duplicate.id].concat(simultaneous.map(t => t.id)));

  // -- downloads ------------------------------------------------------------
  {
    const failure = (promise) => promise.then(() => "resolved", (e) => e.message);
    const until = async (fn) => {
      for (let i = 0; i < 100 && !(await fn()); i++) {
        await settle(10);
      }
    };
    const itemOf = async (id) => (await chrome.downloads.search({ id }))[0];
    const completed = (id) => until(async () => {
      const item = await itemOf(id);
      return item && item.state !== "in_progress";
    });
    const created = [];
    const changes = [];
    const erased = [];
    const tabEvents = [];
    const onCreated = (item) => created.push(item);
    const onChanged = (delta) => changes.push(delta);
    const onErased = (id) => erased.push(id);
    const tabCreated = (tab) => tabEvents.push(["created", tab.id]);
    const tabUpdated = (id) => tabEvents.push(["updated", id]);
    const tabRemoved = (id) => tabEvents.push(["removed", id]);
    const navigated = (details) => tabEvents.push(["navigation", details.tabId]);
    chrome.downloads.onCreated.addListener(onCreated);
    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.onErased.addListener(onErased);
    chrome.tabs.onCreated.addListener(tabCreated);
    chrome.tabs.onUpdated.addListener(tabUpdated);
    chrome.tabs.onRemoved.addListener(tabRemoved);
    chrome.webNavigation.onBeforeNavigate.addListener(navigated);
    await settle(100);
    tabEvents.length = 0;
    const tabsBefore = window0.tabs.length;
    // With no page the bridge is in, the runtime's own page saves files.
    const bridgeWhitelist = globalPage.WEX.CONFIG.bridgeWhitelist;
    globalPage.WEX.CONFIG.bridgeWhitelist = null;

    browser.webResponses["https://files.test/report"] = {
      headers: { "Content-Type": "text/csv", "Content-Length": "8" }, body: "a,b\n1,2\n" };
    const id = await chrome.downloads.download({ url: "https://files.test/report", filename: "out/report.csv" });
    check("downloads.download resolves with a number", typeof id === "number");
    await completed(id);
    const item = await itemOf(id);
    equal("a download completes and is saved under its name",
      [item.state, item.filename, browser.savedDownloads.map((d) => [d.filename, d.text, d.type])],
      ["complete", "report.csv", [["report.csv", "a,b\n1,2\n", "text/csv"]]]);
    equal("a completed item describes the file",
      [item.mime, item.totalBytes, item.fileSize, item.bytesReceived, item.exists, item.finalUrl, item.danger,
        item.byExtensionId === chrome.runtime.id, typeof item.endTime],
      ["text/csv", 8, 8, 8, true, "https://files.test/report", "safe", true, "string"]);
    equal("downloads.onCreated reports the item once", created.map((c) => c.id), [id]);
    const stateChange = changes.filter((c) => c.id === id && c.state)[0];
    equal("downloads.onChanged reports the state's change", stateChange && stateChange.state,
      { previous: "in_progress", current: "complete" });
    check("downloads.onChanged reports the name", changes.some((c) => c.id === id && c.filename &&
      c.filename.current === "report.csv"));
    check("downloads.onChanged leaves out progress", !changes.some((c) => "bytesReceived" in c));
    await settle(50);
    equal("the page that saves a download is not the extension's to see", tabEvents, []);
    equal("the page that saves a download closes", window0.tabs.length, tabsBefore);

    // The response names the file, and the extension renames it.
    browser.webResponses["https://files.test/get?id=7"] = { headers: {
      "Content-Type": "application/octet-stream", "Content-Disposition": "attachment; filename=\"data 7.bin\"" },
      body: "seven" };
    const determining = [];
    const registered = [];
    const determine = (item, suggest) => {
      determining.push(item.filename);
      check("onDeterminingFilename comes after download gives the id", registered.indexOf(item.id) >= 0);
      setTimeout(() => suggest({ filename: "renamed-" + item.url.slice(-1) + ".bin" }), 5);
      return true;
    };
    chrome.downloads.onDeterminingFilename.addListener(determine);
    const named = await new Promise((resolve) => chrome.downloads.download({ url: "https://files.test/get?id=7",
      method: "POST", body: "x=1", headers: [{ name: "X-Token", value: "t" }] }, (downloadId) => {
      registered.push(downloadId);
      resolve(downloadId);
    }));
    await completed(named);
    chrome.downloads.onDeterminingFilename.removeListener(determine);
    equal("onDeterminingFilename is asked with the proposed name", determining, ["data 7.bin"]);
    equal("an asynchronous suggestion names the file", (await itemOf(named)).filename, "renamed-7.bin");
    const sent = browser.webRequests.filter((r) => r.url === "https://files.test/get?id=7")[0];
    equal("a download's method, body and headers are sent",
      [sent.init.method, sent.init.body, sent.init.headers, sent.init.credentials],
      ["POST", "x=1", { "X-Token": "t" }, "include"]);
    browser.webResponses["https://files.test/get?id=8"] = browser.webResponses["https://files.test/get?id=7"];
    const fromHeader = await chrome.downloads.download({ url: "https://files.test/get?id=8" });
    await completed(fromHeader);
    equal("Content-Disposition names a file given no name", (await itemOf(fromHeader)).filename, "data 7.bin");
    const fromData = await chrome.downloads.download({ url: "data:text/plain,hello" });
    await completed(fromData);
    equal("a data: URL is saved, named by its type", [(await itemOf(fromData)).filename,
      browser.savedDownloads[browser.savedDownloads.length - 1].text], ["download.txt", "hello"]);

    // Chrome's refusals.
    browser.webResponses["https://files.test/missing"] = { status: 404, body: "" };
    browser.webResponses["https://files.test/down"] = { fail: true };
    const before = created.length;
    equal("downloads.download refuses what Chrome refuses", [
      await failure(chrome.downloads.download({ url: "not a url" })),
      await failure(chrome.downloads.download({ url: "https://files.test/report", filename: "../up.txt" })),
      await failure(chrome.downloads.download({ url: "https://files.test/report", filename: "/abs.txt" })),
      await failure(chrome.downloads.download({ url: "https://files.test/report",
        headers: [{ name: "Cookie", value: "a=b" }] })),
      await failure(chrome.downloads.download({ url: "https://files.test/report",
        headers: [{ name: "Bad Name", value: "x" }] })),
      await failure(chrome.downloads.download({ url: "https://files.test/missing" })),
      await failure(chrome.downloads.download({ url: "https://files.test/down" }))
    ], ["Invalid URL", "Invalid filename", "Invalid filename", "Unsafe request header name",
      "Invalid request header name", "SERVER_BAD_CONTENT", "NETWORK_FAILED"]);
    equal("a download that fails to start has no item", created.length, before);

    // Pausing holds the body back; cancelling ends the download.
    let feed;
    browser.webResponses["https://files.test/slow"] = { headers: { "Content-Length": "6" },
      body: () => new ReadableStream({ start(c) { feed = c; } }) };
    const slow = await chrome.downloads.download({ url: "https://files.test/slow" });
    await chrome.downloads.pause(slow);
    const paused = await itemOf(slow);
    equal("a paused download can resume", [paused.state, paused.paused, paused.canResume],
      ["in_progress", true, true]);
    feed.enqueue(new TextEncoder().encode("abc"));
    feed.enqueue(new TextEncoder().encode("def"));
    feed.close();
    await settle(50);
    equal("a paused download stays in progress", (await itemOf(slow)).state, "in_progress");
    await chrome.downloads.resume(slow);
    await completed(slow);
    equal("a resumed download completes", [(await itemOf(slow)).state,
      browser.savedDownloads[browser.savedDownloads.length - 1].text], ["complete", "abcdef"]);
    browser.webResponses["https://files.test/stuck"] = { body: () => new ReadableStream({ start() {} }) };
    const stuck = await chrome.downloads.download({ url: "https://files.test/stuck" });
    await chrome.downloads.cancel(stuck);
    const cancelled = await itemOf(stuck);
    equal("a cancelled download is interrupted", [cancelled.state, cancelled.error, cancelled.canResume],
      ["interrupted", "USER_CANCELED", false]);
    equal("Chrome's errors for items in the wrong state", [
      await failure(chrome.downloads.resume(stuck)),
      await failure(chrome.downloads.pause(stuck)),
      await failure(chrome.downloads.removeFile(stuck)),
      await failure(chrome.downloads.removeFile(id)),
      await failure(chrome.downloads.getFileIcon(id)),
      await failure(chrome.downloads.acceptDanger(id)),
      await failure(chrome.downloads.pause(9999)),
      await failure(chrome.downloads.cancel(9999))
    ], ["DownloadItem.canResume must be true", "Download must be in progress", "Download must be complete",
      "Unable to remove file", "Icon not found", "Download must be in progress", "Invalid downloadId",
      "resolved"]);

    browser.refuseDownloads = true;
    const refused = await chrome.downloads.download({ url: "data:text/plain,no" });
    await completed(refused);
    browser.refuseDownloads = false;
    equal("a file Safari does not save interrupts its download",
      [(await itemOf(refused)).state, (await itemOf(refused)).error], ["interrupted", "FILE_FAILED"]);

    // Searching and erasing the history.
    equal("downloads.search filters and orders", (await chrome.downloads.search({
      query: ["files.test", "-slow"], state: "complete", orderBy: ["-filename"], limit: 2 })).map((i) => i.filename),
      ["report.csv", "renamed-7.bin"]);
    equal("downloads.search refuses what Chrome refuses", [
      await failure(chrome.downloads.search({ orderBy: ["size"] })),
      await failure(chrome.downloads.search({ limit: -1 })),
      await failure(chrome.downloads.search({ filenameRegex: "(" }))
    ], ["Invalid orderBy field", "Invalid query limit", "Invalid query filter"]);
    equal("downloads.erase removes from the history", [await chrome.downloads.erase({ id: refused }),
      erased, await chrome.downloads.search({ id: refused })], [[refused], [refused], []]);
    check("the history is kept", JSON.parse(globalPage.localStorage.getItem("wex.downloads") ||
      (globalPage.safari.extension.settings && globalPage.safari.extension.settings.getItem("wex.downloads")) ||
      "{}").items.length === (await chrome.downloads.search({})).length);

    // An ordinary web page's bridge saves the file, opening no tab.
    globalPage.WEX.CONFIG.bridgeWhitelist = bridgeWhitelist;
    const pageTab = window0.openTab();
    pageTab.url = "https://bridge.example/";
    window0.activeTab = pageTab;
    await settle();
    const pageFrame = browser.createContentFrame(pageTab, []);
    vm.runInContext(bridgeRegistrations[0].source, pageFrame.context.vmContext);
    await settle();
    const savedBefore = browser.savedDownloads.length;
    const tabsNow = window0.tabs.length;
    const viaPage = await chrome.downloads.download({ url: "data:text/plain,through-the-page",
      filename: "page.txt" });
    await completed(viaPage);
    await settle(50);
    const last = browser.savedDownloads[browser.savedDownloads.length - 1];
    equal("a web page's bridge saves the file, and no tab opens",
      [(await itemOf(viaPage)).state, browser.savedDownloads.length - savedBefore, last.filename, last.via,
        last.text, window0.tabs.length], ["complete", 1, "page.txt", "content", "through-the-page", tabsNow]);
    pageTab.close();
    window0.activeTab = tab;

    chrome.downloads.onCreated.removeListener(onCreated);
    chrome.downloads.onChanged.removeListener(onChanged);
    chrome.downloads.onErased.removeListener(onErased);
    chrome.tabs.onCreated.removeListener(tabCreated);
    chrome.tabs.onUpdated.removeListener(tabUpdated);
    chrome.tabs.onRemoved.removeListener(tabRemoved);
    chrome.webNavigation.onBeforeNavigate.removeListener(navigated);
  }

  // Safari's window of hidden tabs, which it never shows, and its own empty
  // tab there.
  {
    const shownTabs = (await chrome.tabs.query({})).length;
    const shownWindows = (await chrome.windows.getAll()).length;
    const hiddenWindow = browser.openWindow();
    hiddenWindow.visible = false;
    hiddenWindow.openTab();
    hiddenWindow.openTab();
    await settle();
    equal("the window of hidden tabs and its empty tab are left out",
      [(await chrome.tabs.query({})).length, (await chrome.windows.getAll()).length],
      [shownTabs + 1, shownWindows]);
    hiddenWindow.close();
    await settle();
  }

  // -- notifications ----------------------------------------------------------
  {
    const failure = (promise) => promise.then(() => "resolved", (e) => e.message);
    const clicked = [];
    const closed = [];
    const onClicked = (id) => clicked.push(id);
    const onClosed = (id, byUser) => closed.push([id, byUser]);
    chrome.notifications.onClicked.addListener(onClicked);
    chrome.notifications.onClosed.addListener(onClosed);
    const options = { type: "basic", iconUrl: "icon.png", title: "Hello", message: "There",
      contextMessage: "Context" };
    const id = await chrome.notifications.create("greeting", options);
    const generated = await chrome.notifications.create(options);
    await settle();
    const first = browser.notifications[browser.notifications.length - 2];
    equal("a notification is posted with its text", [id, first.title, first.body, typeof generated],
      ["greeting", "Hello", "There\nContext", "string"]);
    first.onclick();
    browser.notifications[browser.notifications.length - 1].close();
    await settle();
    equal("a click on a notification, and the user closing one, are reported",
      [clicked, closed], [["greeting"], [[generated, true]]]);
    equal("notifications.getAll lists those still shown", await chrome.notifications.getAll(), { greeting: true });
    equal("notifications.update replaces one shown, and no other",
      [await chrome.notifications.update("greeting", { title: "Again" }),
        await chrome.notifications.update("gone", { title: "x" }),
        browser.notifications[browser.notifications.length - 1].title, first.closed], [true, false, "Again", true]);
    closed.length = 0;
    equal("notifications.clear closes one, and says whether there was one",
      [await chrome.notifications.clear("greeting"), await chrome.notifications.clear("greeting")], [true, false]);
    await settle();
    equal("and the extension's closing is not the user's", closed, [["greeting", false]]);
    equal("notifications.create needs Chrome's properties",
      await failure(chrome.notifications.create({ title: "No type" })),
      "Some of the required properties are missing: type, iconUrl, title and message.");
    browser.NotificationClass.permission = "denied";
    equal("while Safari gives no permission, the calls fail as Chrome's do for notifications turned off",
      [await chrome.notifications.getPermissionLevel(), await failure(chrome.notifications.create("x", options)),
        await failure(chrome.notifications.getAll())], ["denied", "", ""]);
    browser.NotificationClass.permission = "granted";
    chrome.notifications.onClicked.removeListener(onClicked);
    chrome.notifications.onClosed.removeListener(onClosed);
  }

  // -- management's permission warnings --------------------------------------
  {
    const warn = (manifest) => chrome.management.getPermissionWarningsByManifest(JSON.stringify(Object.assign({
      name: "M", version: "1", manifest_version: 3 }, manifest)));
    equal("permission warnings are Chrome's, with Chrome's rules applied in order", [
      await warn({ permissions: ["tabs"] }),
      await warn({ permissions: ["tabs", "history"] }),
      await warn({ permissions: ["tabs", "storage", "alarms"], host_permissions: ["<all_urls>"] }),
      await warn({ permissions: ["debugger"] }),
      await warn({ host_permissions: ["*://*.com/*"] }),
      await warn({ host_permissions: ["https://www.google.com/*", "https://www.google.de/*"],
        content_scripts: [{ matches: ["*://*.example.org/*"], js: ["a.js"] }] }),
      await warn({ host_permissions: ["https://a.test/*", "https://b.test/*", "https://c.test/*",
        "https://d.test/*"] }),
      await warn({ permissions: ["downloads", "notifications"], chrome_url_overrides: { newtab: "n.html" } }),
      await warn({ manifest_version: 2, permissions: ["https://mail.example.net/*", "storage"] })
    ], [
      ["Read your browsing history"],
      ["Read and change your browsing history on all your signed-in devices"],
      ["Read and change all your data on all websites"],
      ["Access the page debugger backend", "Read and change all your data on all websites"],
      ["Read and change all your data on all websites"],
      ["Read and change your data on all example.org sites and www.google.com"],
      ["Read and change your data on a number of websites"],
      ["Replace the page you see when opening a new tab", "Display notifications", "Manage your downloads"],
      ["Read and change your data on mail.example.net"]
    ]);
    const failure = (promise) => promise.then(() => "resolved", (e) => e.message);
    equal("and fail as Chrome's do", [
      await failure(chrome.management.getPermissionWarningsByManifest("[1]")),
      await failure(chrome.management.getPermissionWarningsByManifest(JSON.stringify({ name: "No version" }))),
      await failure(chrome.management.getPermissionWarningsById("another"))
    ], ["Failed to parse manifest.", "Failed to create extension from manifest.",
      "Failed to find extension with id another."]);
    equal("an extension's own warnings come from its manifest",
      Array.isArray(await chrome.management.getPermissionWarningsById(chrome.runtime.id)), true);
  }

  // -- pageCapture ------------------------------------------------------------
  {
    const failure = (promise) => promise.then(() => "resolved", (e) => e.message);
    const blank = window0.openTab();
    await settle();
    const blankId = (await chrome.tabs.query({})).filter((t) => t.url === "about:blank").pop().id;
    equal("pageCapture.saveAsMHTML fails as Chrome's does", [
      await failure(chrome.pageCapture.saveAsMHTML({ tabId: 99999 })),
      await failure(chrome.pageCapture.saveAsMHTML({ tabId: blankId }))
    ], ["Cannot find the tab for this request.", "Don't have permissions required to capture this page."]);
    blank.close();
  }

  // -- frames a script points at a sandboxed page -----------------------------
  {
    const config = globalPage.WEX.CONFIG;
    const kept = [config.sandboxPages, config.sandboxFlags];
    config.sandboxPages = ["sandbox/run.html"];
    config.sandboxFlags = "allow-scripts";
    class Element {
      constructor() { this.attributes = {}; }
      setAttribute(name, value) { this.attributes[name] = String(value); }
      hasAttribute(name) { return name in this.attributes; }
    }
    class HTMLIFrameElement extends Element {}
    Object.defineProperty(HTMLIFrameElement.prototype, "src", { configurable: true,
      get() { return this.attributes.src; }, set(value) { this.attributes.src = String(value); } });
    const g = { Element, HTMLIFrameElement, URL, document: { baseURI: globalPage.chrome.runtime.getURL("page.html") } };
    globalPage.WEX.installSandboxFrames(g);
    const bySrc = new HTMLIFrameElement();
    bySrc.src = "sandbox/run.html?x";
    const byAttribute = new HTMLIFrameElement();
    byAttribute.setAttribute("src", globalPage.chrome.runtime.getURL("sandbox/run.html"));
    const other = new HTMLIFrameElement();
    other.src = "other.html";
    equal("a frame a script points at a sandboxed page gets the sandbox, and no other frame",
      [bySrc.attributes.sandbox, byAttribute.attributes.sandbox, other.attributes.sandbox],
      ["allow-scripts", "allow-scripts", undefined]);
    config.sandboxPages = kept[0];
    config.sandboxFlags = kept[1];
  }

  // -- what an earlier install left --------------------------------------------
  {
    const world = (installed) => {
      const deleted = [];
      const local = new Map([["wex.databases", JSON.stringify(["app-db", "wex-storage"])], ["token", "old"]]);
      const g = {
        localStorage: { getItem: (k) => local.has(k) ? local.get(k) : null, setItem: (k, v) => local.set(k, String(v)),
          clear: () => local.clear() },
        indexedDB: { deleteDatabase: (name) => deleted.push(name), open: () => ({}),
          databases: () => Promise.resolve([{ name: "app-db" }, { name: "older" }]) }
      };
      const settings = { getItem: (k) => k === "wex.installedVersion" ? installed : null };
      return { g, settings, deleted, local };
    };
    const fresh = world(null);
    fresh.local.set("wex.databases", JSON.stringify(["app-db"]));
    const forgot = globalPage.WEX.forgetEarlierInstall(fresh.g, fresh.settings, ["wex-storage"]);
    const deletedAtOnce = fresh.deleted.slice();
    await settle();
    equal("a first start removes the storage and databases an earlier install left",
      [forgot, deletedAtOnce, fresh.deleted, fresh.local.size], [true, ["wex-storage", "app-db"],
        ["wex-storage", "app-db", "older"], 0]);
    const restart = world("1.2.3");
    equal("and a later start leaves them", [globalPage.WEX.forgetEarlierInstall(restart.g, restart.settings),
      restart.deleted, restart.local.get("token")], [false, [], "old"]);
    const recorded = world("1.2.3");
    globalPage.WEX.recordDatabases(recorded.g);
    recorded.g.indexedDB.open("new-db", 1);
    equal("the databases a page opens are noted by name", JSON.parse(recorded.local.get("wex.databases")),
      ["app-db", "wex-storage", "new-db"]);
  }

  // -- publicSuffix -----------------------------------------------------------
  // Chrome's own cases (public_suffix_util_unittest.cc), over the rules its
  // test list has for them.
  {
    const suffixes = globalPage.WEX.publicSuffixFrom(["jp", "*.bar.jp", "!pref.bar.jp", "priv.no",
      "bar.baz.com", "xn--fiqs8s", "private", "c", "foo.c", "com"].join("\n"));
    const known = (h) => suffixes.getKnownSuffix(h);
    const is = (h) => suffixes.isKnownSuffix(h);
    const domain = (h, o) => suffixes.getDomain(h, o);
    equal("publicSuffix.getKnownSuffix finds the longest known suffix",
      ["jp", "foo.jp", "foo.priv.no", "foo.bar.baz.com", "foo.blah.bar.jp", "192.168.2.1", "green.banana",
        "foo.\u4e2d\u56fd", "foo.private", "sub.foo.c", "b.c", "jp.", "example.jp."].map(known),
      ["jp", "jp", "priv.no", "bar.baz.com", "blah.bar.jp", null, null, "xn--fiqs8s", "private", "foo.c", "c",
        "jp.", "jp."]);
    equal("publicSuffix.isKnownSuffix is true only of a suffix itself",
      ["jp", "foo.jp", "priv.no", "foo.priv.no", "blah.bar.jp", "foo.blah.bar.jp", "192.168.2.1", "green.banana",
        "private", "c", "foo.c", "b.c", "jp.", "example.jp."].map(is),
      [true, false, true, false, true, false, false, false, true, true, true, false, true, false]);
    equal("publicSuffix.getDomain gives the registrable domain",
      ["sub.domain.jp", "a.b.bar.baz.com", "EXAMPLE.JP", "example.jp.", "blah.bar.jp", "sub.blah.bar.jp",
        "pref.bar.jp", "sub.pref.bar.jp", "foo.priv.no", "sub.foo.priv.no", "green.banana", "localhost",
        "jp", "bar.baz.com", "192.168.2.1", "[::1]", "\u4e2d\u56fd", "foo.\u4e2d\u56fd", "foo.xn--fiqs8s"]
        .map((h) => domain(h)),
      ["domain.jp", "b.bar.baz.com", "example.jp", "example.jp.", null, "sub.blah.bar.jp", "pref.bar.jp",
        "pref.bar.jp", "foo.priv.no", "foo.priv.no", null, null, null, null, null, null, null,
        "foo.xn--fiqs8s", "foo.xn--fiqs8s"]);
    equal("publicSuffix.getDomain's options",
      [domain("very.green.banana", { allowUnknownSuffix: true }), domain("localhost", { allowUnknownSuffix: true }),
        domain("apple.pear.banana.", { allowUnknownSuffix: true }), domain("jp", { allowPlainSuffix: true }),
        domain("blah.bar.jp", { allowPlainSuffix: true }), domain("192.168.2.1", { allowIPAddress: true }),
        domain("[::1]", { allowIPAddress: true }), domain("foo.xn--fiqs8s", { encoding: "display" }),
        domain("xn--bs-red.bar.baz.com", { encoding: "display" }),
        domain("xn--80ak6aa92e.com", { encoding: "display" })],
      ["green.banana", "localhost", "pear.banana.", "jp", "blah.bar.jp", "192.168.2.1", "[::1]",
        "foo.\u4e2d\u56fd", "xn--bs-red.bar.baz.com", "xn--80ak6aa92e.com"]);
    equal("an accented Latin label is shown in Unicode", domain("www.xn--bcher-kva.com", { encoding: "display" }),
      "b\u00fccher.com");
    const invalid = ["", ".", "website.example/path", "website.example:443", "user@website.example",
      "https://website.example", "website..example", ".example", ".website.example", "..website.example",
      "\u3002website.example", "website.example..", "*.com", "::1", ".192.168.2.1", ".[::1]", "sub%2edomain.jp"]
      .filter((h) => {
        try {
          suffixes.getDomain(h);
          return true;
        } catch (e) {
          return e.message !== "Error in invocation of publicSuffix.getDomain(string hostname, " +
            "optional publicSuffix.DomainOptions options): Invalid hostname";
        }
      });
    equal("publicSuffix refuses what Chrome refuses", invalid, []);
    equal("and takes what Chrome takes", [domain("foo_bar.jp"), domain("example\u3002jp")],
      ["foo_bar.jp", "example.jp"]);
    const list = globalPage.WEX.publicSuffixFrom(fs.readFileSync(path.join(RUNTIME, "public-suffix-list.txt"), "utf8"));
    equal("the Public Suffix List's rules, private ones too",
      [list.getDomain("www.bbc.co.uk"), list.getDomain("someone.github.io"), list.getKnownSuffix("a.b.ck"),
        list.getDomain("www.ck"), list.isKnownSuffix("co.uk")],
      ["bbc.co.uk", "someone.github.io", "b.ck", "www.ck", true]);
  }

  // -- the diagnostics channel ----------------------------------------------
  const state = globalPage.__wexState();
  check("the global page can describe itself", !!state && state.popover.count >= 1);
  check("it reports how many click listeners are registered",
    typeof state.clickListeners === "number");
  check("and how many tabs it has identified", state.tabs.identified >= 2);

  // -- context menus -------------------------------------------------------
  const clicks = [];
  chrome.contextMenus.onClicked.addListener((info) => clicks.push(info));
  const parentId = chrome.contextMenus.create({ id: "parent", title: "Parent", contexts: ["all"] });
  chrome.contextMenus.create({ id: "child", title: "Child", parentId, contexts: ["all"] });

  const appended = [];
  const userInfo = { pageUrl: "https://example.com/page", selectionText: "picked" };
  browser.application.fire("contextmenu", {
    target: tab,
    userInfo,
    contextMenu: { appendContextMenuItem: (id, title) => appended.push([id, title]) },
    __stopped: false
  }, true);
  equal("a submenu, which Safari's menu cannot have, is not offered", appended, []);
  chrome.contextMenus.remove("parent");
  chrome.contextMenus.create({ id: "only", title: "Only", contexts: ["all"] });
  browser.application.fire("contextmenu", {
    target: tab,
    userInfo,
    contextMenu: { appendContextMenuItem: (id, title) => appended.push([id, title]) },
    __stopped: false
  }, true);
  equal("the extension's one item is, as Chrome shows it at the menu's top level",
    appended, [["wex-menu:only", "Only"]]);

  browser.application.fire("command",
    { command: "wex-menu:only", userInfo, __stopped: false }, true);
  await settle();
  equal("clicking a menu item reports what was under the cursor",
    clicks.length && clicks[0].selectionText, "picked");
  equal("a menu click is not a toolbar click", actionClicks.length, 1);

  // -- the extension page bridge --------------------------------------------
  // runtime.id is the id the extension's browser gives it, where it is known.
  {
    const world = { console, navigator: {}, setTimeout, safari: { extension: { baseURI: "safari-extension://x-TEAM/abc/" } } };
    world.self = world;
    vm.createContext(world);
    vm.runInContext("var WEX_CONFIG = " + JSON.stringify({ extensionId: "com.example.bundle", runtimeId: "abcdefghijklmnopabcdefghijklmnop",
      sourceOrigin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop", manifest: {} }) + ";", world);
    vm.runInContext(fs.readFileSync(wex("wex-core.js"), "utf8"), world);
    equal("the extension is known by its store id, and the bundle's id still names it",
      [world.WEX.runtimeId, world.WEX.chromeExtensionOrigin("abcdefghijklmnopabcdefghijklmnop"),
        world.WEX.chromeExtensionOrigin("com.example.bundle")],
      ["abcdefghijklmnopabcdefghijklmnop", "safari-extension://x-TEAM/abc",
        "safari-extension://x-TEAM/abc"]);
    // A URL class of the world's own, so that Node's stays as it is.
    class WorldURL extends URL {}
    Object.defineProperties(WorldURL.prototype, Object.getOwnPropertyDescriptors(URL.prototype));
    world.URL = WorldURL;
    world.WEX.installExtensionHostAlias(world);
    const made = vm.runInContext("var u = new URL('safari-extension://x-TEAM/abc/picker.html');" +
      "u.hostname = 'abcdefghijklmnopabcdefghijklmnop'; var v = new URL('https://web.example/');" +
      "v.hostname = 'abcdefghijklmnopabcdefghijklmnop'; var w = new URL('safari-extension://x-TEAM/abc/a');" +
      "w.host = 'other.example'; [u.href, v.href, w.href]", world);
    equal("setting the host of one of the extension's addresses to its id keeps the bundle's host",
      made, ["safari-extension://x-TEAM/abc/picker.html", "https://abcdefghijklmnopabcdefghijklmnop/",
        "safari-extension://other.example/abc/a"]);
  }

  // Firefox's getManifest gives its URL properties as the extension's
  // addresses; Chrome's gives the manifest as written.
  for (const firefoxBuild of [true, false]) {
    const world = { console, navigator: {}, setTimeout, URL, safari: { extension: { baseURI: "safari-extension://x-TEAM/abc/" } } };
    world.self = world;
    vm.createContext(world);
    vm.runInContext("var WEX_CONFIG = " + JSON.stringify({ firefoxBuild, manifest: {} }) + ";", world);
    vm.runInContext(fs.readFileSync(wex("wex-core.js"), "utf8"), world);
    const given = world.WEX.manifestAsGiven({ background: { page: "bg.html" }, icons: { 48: "i.png" },
      content_scripts: [{ js: ["/c.js"] }], browser_action: { default_popup: "https://example.com/p.html" } });
    equal((firefoxBuild ? "Firefox's" : "Chrome's") + " getManifest gives its paths " +
      (firefoxBuild ? "as addresses" : "as written"),
      [given.background.page, given.icons[48], given.content_scripts[0].js[0], given.browser_action.default_popup],
      firefoxBuild ? ["safari-extension://x-TEAM/abc/bg.html", "i.png", "safari-extension://x-TEAM/abc/c.js", "https://example.com/p.html"]
        : ["bg.html", "i.png", "/c.js", "https://example.com/p.html"]);
  }

  // A namespace has its schema's enums, named as Chrome names their entries.
  {
    const api = JSON.parse(fs.readFileSync(path.join(RUNTIME, "chrome-api.json"), "utf8"));
    const world = { console, navigator: {}, setTimeout, safari: { extension: { baseURI: "safari-extension://x-TEAM/abc/" } } };
    world.self = world;
    vm.createContext(world);
    vm.runInContext("var WEX_CONFIG = {manifest: {}}; var WEX_API = " +
      JSON.stringify({ offscreen: api.offscreen, runtime: api.runtime }) + ";", world);
    vm.runInContext(fs.readFileSync(wex("wex-core.js"), "utf8"), world);
    const root = { offscreen: {}, runtime: { PlatformOs: "kept" } };
    world.WEX.addSchemaEnums(root);
    const tabsRoot = { TAB_ID_NONE: "kept" };
    world.WEX_API.tabs = api.tabs;
    world.WEX.addSchemaEnums({ tabs: tabsRoot });
    equal("each constant of a namespace is there, as Chrome gives it",
      [tabsRoot.TAB_INDEX_NONE, tabsRoot.MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND, tabsRoot.TAB_ID_NONE],
      [-1, 2, "kept"]);
    equal("each enum of a namespace's types is there, as Chrome's bindings give it",
      [root.offscreen.Reason.AUDIO_PLAYBACK, root.runtime.OnInstalledReason.CHROME_UPDATE, root.runtime.PlatformOs],
      ["AUDIO_PLAYBACK", "chrome_update", "kept"]);
  }

  // What leaves the browser names the extension as the web knows it.
  {
    const base = "safari-extension://com.webext2safari.abcdefghijklmnopabcdefghijklmnop-TEAM/tok/";
    const web = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
    const fetched = [];
    const sent = [];
    const socketSends = [];
    function WebSocket(url) { this.url = url; socketSends.push(["open", url]); }
    WebSocket.prototype.send = function (data) { socketSends.push(["send", data]); };
    function XMLHttpRequest() {}
    XMLHttpRequest.prototype.open = function (method, url) { this.url = url; };
    XMLHttpRequest.prototype.send = function (body) { sent.push([this.url, body]); };
    const world = { console, navigator: {}, setTimeout, URL, URLSearchParams, XMLHttpRequest, TextDecoder, TextEncoder, Uint8Array, ArrayBuffer, DataView, Response, WebSocket, Proxy, Reflect,
      Blob, location: { href: base + "page.html" }, safari: { extension: { baseURI: base } },
      fetch: (input, init) => { fetched.push([String(input), init && init.body]); return Promise.resolve(); } };
    world.self = world;
    vm.createContext(world);
    vm.runInContext("var WEX_CONFIG = {sourceOrigin: '" + web + "', manifest: {}}; var WEX_API = null;", world);
    vm.runInContext(fs.readFileSync(wex("wex-core.js"), "utf8"), world);
    const own = base + "cb.html?x=1";
    equal("the extension's address goes out as the web knows it, in every form it is written in",
      [own, encodeURIComponent(own), encodeURIComponent(encodeURIComponent(own)), JSON.stringify(own).replace(/\//g, "\\/"),
        base.toUpperCase().replace("SAFARI-EXTENSION", "safari-extension") + "x", "safari-extension://other/tok/x", base.slice(0, -1) + "ens/x"]
        .map((t) => world.WEX.webFacingText(t)),
      [web + "/cb.html?x=1", encodeURIComponent(web + "/cb.html?x=1"),
        encodeURIComponent(encodeURIComponent(web + "/cb.html?x=1")), JSON.stringify(web + "/cb.html?x=1").replace(/\//g, "\\/"),
        web + "/x", "safari-extension://other/tok/x", base.slice(0, -1) + "ens/x"]);
    world.WEX.installWebFacingAddresses(world, false);
    world.fetch("https://api.example/login?cb=" + encodeURIComponent(own), { method: "POST", body: JSON.stringify({ redirectUri: own }) });
    world.fetch(base + "data.json");
    world.fetch("https://api.example/form", { body: new URLSearchParams({ cb: own }) });
    const request = new world.XMLHttpRequest();
    request.open("POST", "https://api.example/x?u=" + own);
    request.send(own);
    const local = new world.XMLHttpRequest();
    local.open("GET", base + "file.txt");
    local.send(own);
    const savedFetches = fetched.slice();
    world.WEX_CONFIG.manifest.web_accessible_resources = [{ resources: ["cb.html", "pub/*"], matches: ["https://login.example/*"] }];
    equal("a site opens the extension's pages its manifest gives the site, as Chrome lets it",
      [world.WEX.pageFromWeb(web + "/cb.html?code=1", "https://login.example/done"),
        world.WEX.pageFromWeb(web + "/pub/a/b.html", "https://login.example/"),
        world.WEX.pageFromWeb(web + "/cb.html", "https://evil.example/"),
        world.WEX.pageFromWeb(web + "/options.html", "https://login.example/"),
        world.WEX.pageFromWeb("chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/cb.html", "https://login.example/")],
      [base + "cb.html?code=1", base + "pub/a/b.html", null, null, null]);
    world.WEX_CONFIG.manifest.web_accessible_resources = ["cb.html"];
    equal("and a version 2 manifest's to every site",
      world.WEX.pageFromWeb(web + "/cb.html", "https://evil.example/"), base + "cb.html");
    fetched.length = 0;
    world.own = own;
    vm.runInContext("fetch('https://api.example/b', { method: 'POST', body: new TextEncoder().encode(JSON.stringify({ u: own })).buffer });" +
      "fetch('https://api.example/c', { method: 'POST', body: new Uint8Array([0, 255, 1]) });" +
      "fetch('https://api.example/d', { method: 'POST', body: new Blob([own], { type: 'text/plain' }) });", world);
    await settle(50);
    const decode = (b) => b instanceof Blob ? b.text() : new TextDecoder().decode(b);
    equal("and in bytes and blobs that are text, the rest as they are",
      [await decode(fetched[0][1]), Array.from(fetched[1][1]), await decode(fetched[2][1]), fetched[2][1].type],
      [JSON.stringify({ u: web + "/cb.html?x=1" }), [0, 255, 1], web + "/cb.html?x=1", "text/plain"]);
    fetched.splice(0, 3, ...savedFetches);
    vm.runInContext("var ws = new WebSocket('wss://socket.example/?cb=' + own);" +
      "ws.send(new Blob([own])); ws.send('then ' + own); ws.send(new Uint8Array([0, 255]));", world);
    await settle(50);
    equal("and in a socket's address and messages, which keep their order",
      [socketSends[0], new TextDecoder().decode(new Uint8Array(socketSends[1][1])), socketSends[2][1], Array.from(socketSends[3][1])],
      [["open", "wss://socket.example/?cb=" + web + "/cb.html?x=1"], web + "/cb.html?x=1", "then " + web + "/cb.html?x=1", [0, 255]]);
    equal("in what the extension sends to the web, and not in its requests for its own files",
      [fetched.map((f) => [f[0], String(f[1])]), sent],
      [[["https://api.example/login?cb=" + encodeURIComponent(web + "/cb.html?x=1"), JSON.stringify({ redirectUri: web + "/cb.html?x=1" })],
        [base + "data.json", "undefined"], ["https://api.example/form", new URLSearchParams({ cb: web + "/cb.html?x=1" }).toString()]],
        [["https://api.example/x?u=" + web + "/cb.html?x=1", web + "/cb.html?x=1"], [base + "file.txt", own]]]);
  }

  // The global page that stands in for a service worker has the worker's
  // location, as the extension reads it.
  {
    const base = "safari-extension://x-TEAM/abc/";
    function Location() {}
    const world = { console, navigator: {}, setTimeout, URL, Proxy, Reflect, MessageEvent: function () {}, Location,
      safari: { extension: { baseURI: base } } };
    world.self = world;
    world.location = Object.create(Location.prototype, {
      href: { value: base + "js/wex-global-page.html" }, pathname: { value: "/abc/js/wex-global-page.html" },
      origin: { value: "safari-extension://x-team" } });
    vm.createContext(world);
    vm.runInContext("var WEX_CONFIG = {backgroundPage: 'js/wex-global-page.html', manifest: " +
      "{background: {service_worker: 'js/BG.js'}}}; var WEX_API = null;", world);
    vm.runInContext(fs.readFileSync(wex("wex-core.js"), "utf8"), world);
    world.WEX.installExtensionOrigin(world);
    const other = Object.create(Location.prototype, { href: { value: base + "popup.html" },
      pathname: { value: "/abc/popup.html" } });
    equal("a service worker's global page reads its location as the worker's address, and a page its own",
      [world.location.__wexHref, world.location.__wexPathname, other.__wexHref, other.__wexPathname],
      [base + "js/BG.js", "/js/BG.js", base + "popup.html", "/popup.html"]);
    const workerLocation = world.__wexWorkerScope.location;
    equal("and the worker's location, as a read of self.location as a whole gets it, is its script's",
      [workerLocation.origin + "/", workerLocation.pathname, String(workerLocation)],
      [base, "/js/BG.js", base + "js/BG.js"]);    const { location: destructured, console: kept } = world.__wexWorkerSelf;
    equal("and the global as the worker destructures it gives that location, and the rest as they are",
      [destructured === workerLocation, kept === console], [true, true]);
  }

  // The global page generated for background scripts reads its location as
  // the page Chrome and Firefox generate for them, which getURL and URL name
  // as they do there, so that an extension comparing the two finds itself in
  // the background; another page reads its own.
  {
    const base = "safari-extension://x-team/abc/";
    const Location = function () {};
    const world = { console, navigator: {}, setTimeout, Proxy, Reflect, URL, Location,
      safari: { extension: { baseURI: base } } };
    world.self = world;
    world.location = Object.create(Location.prototype, {
      href: { value: base + "wex-global-page.html" }, pathname: { value: "/abc/wex-global-page.html" },
      origin: { value: "safari-extension://x-team" } });
    vm.createContext(world);
    vm.runInContext("var WEX_CONFIG = {backgroundPage: 'wex-global-page.html', manifest: " +
      "{background: {scripts: ['bg.js']}}}; var WEX_API = null;", world);
    vm.runInContext(fs.readFileSync(wex("wex-core.js"), "utf8"), world);
    world.WEX.installExtensionOrigin(world);
    world.WEX.installExtensionUrlBase(world);
    const other = Object.create(Location.prototype, { href: { value: base + "popup.html" },
      pathname: { value: "/abc/popup.html" } });
    const alias = base + "_generated_background_page.html";
    equal("background scripts' global page reads as the page the browser generates for them",
      [world.location.__wexHref, world.location.__wexPathname, world.WEX.extUrl("_generated_background_page.html"),
        new world.URL("/_generated_background_page.html", "safari-extension://x-team").href,
        other.__wexHref, other.__wexPathname],
      [alias, "/_generated_background_page.html", alias, alias, base + "popup.html", "/popup.html"]);
  }

  // A popup is painted over an opaque base only where neither its root nor
  // its body paints a background.
  {
    const checks = [];
    const world = { console, navigator: {}, setTimeout, setInterval: (fn) => { checks.push(fn); return 0; },
      safari: { extension: { baseURI: "safari-extension://x-TEAM/abc/" } } };
    world.self = world;
    vm.createContext(world);
    vm.runInContext("var WEX_CONFIG = {manifest: {}}; var WEX_API = null;", world);
    vm.runInContext(fs.readFileSync(wex("wex-core.js"), "utf8"), world);
    const sheet = { html: "rgba(0, 0, 0, 0)", body: "rgba(0, 0, 0, 0)" };
    function element(name) {
      const inline = {};
      return { name, style: {
        getPropertyValue: (k) => inline[k] || "",
        setProperty: (k, v) => { inline[k] = v; },
        removeProperty: (k) => { delete inline[k]; }
      } };
    }
    const html = element("html");
    const body = element("body");
    world.document = { documentElement: html, body, head: null, addEventListener() {} };
    world.addEventListener = () => {};
    world.getComputedStyle = (el) => ({ backgroundColor: el.style.getPropertyValue("background-color") || sheet[el.name],
      backgroundImage: "none" });
    world.WEX.installPopupCanvas(world);
    const bare = html.style.getPropertyValue("background-color");
    sheet.body = "rgb(51, 51, 51)";
    checks[0]();
    const withBody = html.style.getPropertyValue("background-color");
    sheet.body = "rgba(0, 0, 0, 0)";
    checks[0]();
    const again = html.style.getPropertyValue("background-color");
    sheet.html = "rgb(1, 2, 3)";
    checks[0]();
    equal("a popup's root gets the base colour only while neither it nor the body paints a background",
      [bare, withBody, again, html.style.getPropertyValue("background-color")], ["canvas", "", "canvas", ""]);
  }

  // A page whose calls are checked: its namespace stands in for the global
  // page's, and hands out each member checked, readable as any object's.
  {
    const api = JSON.parse(fs.readFileSync(path.join(RUNTIME, "chrome-api.json"), "utf8"));
    const apiFile = path.join(os.tmpdir(), "wex-api-" + process.pid + ".js");
    fs.writeFileSync(apiFile, "var WEX_API = " + JSON.stringify({ runtime: api.runtime, storage: api.storage,
      tabs: api.tabs, extensionTypes: api.extensionTypes }) + ";");
    const checkedPage = browser.createExtensionPage([
      wex("wex-config.js"), apiFile, wex("wex-core.js"), wex("wex-page.js")
    ], browser.baseURI + "popup.html");
    const problems = [];
    for (const ns of ["runtime", "storage", "tabs"]) {
      for (const name of Object.getOwnPropertyNames(checkedPage.chrome[ns])) {
        try {
          checkedPage.chrome[ns][name];
        } catch (e) {
          problems.push(ns + "." + name + ": " + e.message);
        }
      }
    }
    let thrown = null;
    try {
      checkedPage.chrome.storage.local.set("invalid");
    } catch (e) {
      thrown = e.message;
    }
    const replacement = () => "replaced";
    checkedPage.chrome.runtime.sendMessage = replacement;
    let afterAssignment;
    try {
      afterAssignment = checkedPage.chrome.runtime.sendMessage === replacement;
    } catch (e) {
      afterAssignment = e.message;
    }
    // Chrome's bindings hand an implementation one argument for each
    // parameter, so a callback given in the place of a parameter left out
    // reaches it as the callback.
    const fromCallback = await new Promise((resolve) => {
      checkedPage.chrome.storage.local.get((items) => resolve(typeof items));
      setTimeout(() => resolve("no callback"), 500);
    });
    equal("a callback in the place of an optional parameter is the callback", fromCallback, "object");
    const named = checkedPage.chrome.runtime.connect({ name: "named-port" });
    equal("a port connected with only its connect info keeps its name", named.name, "named-port");
    named.disconnect();
    equal("a member the page assigns is the one it reads back", afterAssignment, true);
    equal("an extension page's namespace is readable throughout, and checks its calls",
      [problems, thrown, typeof checkedPage.chrome.runtime.getURL("x")],
      [[], "Error in invocation of storage.StorageArea.set(object items, optional function callback): " +
        "No matching signature.", "string"]);
    fs.unlinkSync(apiFile);
  }

  const page = browser.createExtensionPage([
    wex("wex-config.js"), wex("wex-core.js"), wex("wex-page.js")
  ], browser.baseURI + "popup.html");
  check("an extension page gets a chrome object", !!page.chrome);
  equal("an extension page has identity.getRedirectURL's address at once, as Chrome gives it",
    page.chrome.identity.getRedirectURL("cb"), chrome.identity.getRedirectURL("cb"));
  {
    // A site in a frame of the popover, where Safari runs no content script,
    // has Chrome's chrome.runtime for web pages from the script the global
    // page puts in its document, and reaches onMessageExternal and
    // onConnectExternal through the popover's page, as a frame of an
    // extension page, with no tab.
    const extensionOrigin = page.WEX.origin.toLowerCase();
    class FakeMessageEvent {
      constructor(type, init) {
        this.type = type;
        this.data = init.data;
        this.realOrigin = init.origin;
        this.realSource = init.source;
      }
      get origin() { return this.realOrigin; }
      get source() { return this.realSource; }
      stopImmediatePropagation() {}
    }
    const site = (origin, href) => {
      const listeners = [];
      const docListeners = [];
      const fire = (list, event) => list.filter((l) => l.type === event.type).forEach((l) => l.fn(event));
      const parentWindow = {
        postMessage: (data, target) => {
          if (target === extensionOrigin) {
            setTimeout(() => page.dispatchEvent({ type: "message", data: structuredClone(data), origin,
              source: frameWindow, stopImmediatePropagation() {} }), 0);
          }
        }
      };
      const frameWindow = {
        parent: parentWindow,
        addEventListener: (type, fn) => listeners.push({ type, fn }),
        postMessage: (data, target) => {
          if (target === origin) {
            setTimeout(() => fire(listeners, new FakeMessageEvent("message", { data: structuredClone(data),
              origin: extensionOrigin, source: parentWindow })), 0);
          }
        },
        fire: (event) => fire(listeners, event)
      };
      const world = { window: frameWindow, location: { href }, setTimeout, Promise, JSON, TypeError, Error,
        Object, String, MessageEvent: FakeMessageEvent,
        CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
        document: { addEventListener: (type, fn) => docListeners.push({ type, fn }),
          dispatchEvent: (event) => { fire(docListeners, event); return true; } } };
      const token = JSON.stringify("page-test");
      require("vm").runInNewContext("(" + page.WEX.pageRuntime + ")(" + token + ", " +
        JSON.stringify(page.WEX.runtimeId) + ");(" + page.WEX.framedPageRelay + ")(" + token + ", " +
        JSON.stringify(extensionOrigin) + ");", world);
      return frameWindow;
    };
    const framedSite = site("https://example.com", "https://example.com/app");
    const id = page.WEX.runtimeId;
    const heard = [];
    const answerFramed = (message, sender, sendResponse) => {
      heard.push([message, sender.id, sender.url, sender.origin, "tab" in sender]);
      sendResponse({ framed: message });
    };
    const portSenders = [];
    const portClosed = [];
    const notePort = (port) => {
      portSenders.push([port.name, port.sender.url, port.sender.origin, "tab" in port.sender]);
      port.onDisconnect.addListener(() => portClosed.push(port.name));
    };
    chrome.runtime.onMessageExternal.addListener(answerFramed);
    chrome.runtime.onConnectExternal.addListener(notePort);
    const runtime = framedSite.chrome.runtime;
    const reply = await runtime.sendMessage(id, { hello: 1 });
    const port = runtime.connect(id, { name: "framed-chan" });
    const portReply = new Promise((resolve) => port.onMessage.addListener(resolve));
    port.postMessage({ ping: 2 });
    const back = await portReply;
    framedSite.fire({ type: "pagehide" });
    await settle();
    const elsewhere = site("https://elsewhere.example", "https://elsewhere.example/");
    const unanswered = await Promise.race([
      elsewhere.chrome.runtime.sendMessage(id, { hello: 2 }).then(() => "answered"),
      new Promise((resolve) => setTimeout(() => resolve("unanswered"), 30))]);
    chrome.runtime.onMessageExternal.removeListener(answerFramed);
    chrome.runtime.onConnectExternal.removeListener(notePort);
    equal("a site in a frame of the popover messages the extension as a frame of an extension page",
      [reply, back, heard, portSenders, portClosed, unanswered],
      [{ framed: { hello: 1 } }, { back: { ping: 2 } },
        [[{ hello: 1 }, undefined, "https://example.com/app", "https://example.com", false]],
        [["framed-chan", "https://example.com/app", "https://example.com", false]], ["framed-chan"],
        "unanswered"]);
  }
  {
    // Across the two realms, only what arrives as a message is the popup's own.
    page.__viaMessage = (await page.chrome.tabs.query({}))[0];
    page.__fromGlobalPage = (await chrome.tabs.query({}))[0];
    equal("a popup is handed a tab as its own object, not one of the global page's realm",
      require("vm").runInContext("[__viaMessage instanceof Object, __fromGlobalPage instanceof Object]", page),
      [true, false]);
    delete page.__viaMessage;
    delete page.__fromGlobalPage;
  }
  {
    // A popup page of a given height, whose root and body record what is
    // written to their attributes.
    const element = (height) => {
      const attributes = {};
      const writes = [];
      return {
        attributes, writes, scrollWidth: 320, scrollHeight: height,
        getBoundingClientRect: () => ({ top: 0, width: 320, height }),
        getAttribute: (name) => name in attributes ? attributes[name] : null,
        setAttribute(name, value) { attributes[name] = value; writes.push(name); },
        removeAttribute(name) { delete attributes[name]; writes.push(name); },
        style: { setProperty(name, value) { attributes.style = name + ":" + value; writes.push("style"); } }
      };
    };
    const given = { width: [], height: [] };
    const sized = { width: browser.popover.width, height: browser.popover.height };
    for (const side of ["width", "height"]) {
      Object.defineProperty(browser.popover, side, {
        configurable: true,
        get: () => sized[side],
        set: (value) => { sized[side] = value; given[side].push(value); }
      });
    }
    const fittedPage = (rootHeight, bodyHeight, adopts) => {
      const fitting = browser.createExtensionPage([
        wex("wex-config.js"), wex("wex-core.js"), path.join(browser.bundleRoot, "auto-size.js"), wex("wex-page.js")
      ], browser.baseURI + "popup.html");
      const doc = fitting.document;
      doc.documentElement = element(rootHeight);
      doc.body = element(bodyHeight);
      fitting.getComputedStyle = () => ({ position: "relative", marginBottom: "0px" });
      fitting.fitObserverDrops = 0;
      fitting.MutationObserver = class {
        observe() {}
        takeRecords() { fitting.fitObserverDrops += 1; return []; }
      };
      if (adopts) {
        doc.adoptedStyleSheets = [];
        fitting.CSSStyleSheet = class { replaceSync() {} };
      } else {
        fitting.CSSStyleSheet = undefined;
      }
      fitting.dispatchEvent(new fitting.Event("load"));
      return fitting;
    };

    const tall = fittedPage(600, 100, true);
    equal("a popup is as tall as a minimum its page gives its root, past its content",
      [sized.width, sized.height], [320, 600]);
    equal("and its measuring writes no attribute a page could answer, and leaves no sheet behind",
      [tall.document.documentElement.writes, tall.document.body.writes, tall.document.adoptedStyleSheets.length],
      [[], [], 0]);
    await settle(300);
    equal("a size the popover already has is not given again",
      [given.width.length, given.height.length], [1, 1]);

    {
      const quirks = browser.createExtensionPage([
        wex("wex-config.js"), wex("wex-core.js"), path.join(browser.bundleRoot, "auto-size.js"), wex("wex-page.js")
      ], browser.baseURI + "popup.html");
      const doc = quirks.document;
      doc.documentElement = element(70);
      doc.body = Object.assign(element(70), { scrollHeight: 560 });
      doc.scrollingElement = doc.body;
      quirks.getComputedStyle = () => ({ position: "relative", marginBottom: "0px" });
      quirks.MutationObserver = class { observe() {} takeRecords() { return []; } };
      doc.adoptedStyleSheets = [];
      quirks.CSSStyleSheet = class { replaceSync() {} };
      quirks.dispatchEvent(new quirks.Event("load"));
      equal("a popup in quirks mode, whose body scrolls the viewport, is as tall as its content",
        sized.height, 100);
    }

    const noSheets = fittedPage(200, 200, false);
    await settle(300);
    equal("without adoptable sheets, the measuring's style goes again and its records are dropped",
      [noSheets.document.documentElement.attributes.style, noSheets.document.documentElement.writes.length > 0,
        noSheets.fitObserverDrops > 0],
      [undefined, true, true]);

    browser.popover.contentWindow = page;
    for (const side of ["width", "height"]) {
      delete browser.popover[side];
    }
    browser.popover.width = 400;
    browser.popover.height = 560;
  }
  await chrome.privacy.network.networkPredictionEnabled.set({ value: false });
  equal("the privacy settings the engine controls are the engine's, and the rest Chrome's defaults",
    [await chrome.privacy.network.networkPredictionEnabled.get({}),
      await chrome.privacy.services.passwordSavingEnabled.get({})],
    [{ value: false, levelOfControl: "controllable_by_this_extension" },
      { value: true, levelOfControl: "not_controllable" }]);
  await chrome.privacy.network.networkPredictionEnabled.clear({});
  equal("a page's privacy settings are the global page's",
    [typeof page.chrome.privacy.services.passwordSavingEnabled.get,
      Object.keys(page.chrome.privacy.services).includes("passwordSavingEnabled")], ["function", true]);
  equal("and finds Chrome as the global page does",
    [typeof page.browser, typeof page.safari, /Chrome\/156/.test(page.navigator.userAgent)],
    ["undefined", "undefined", true]);
  {
    // What a request names the browser as is what the page sees of it.
    const named = globalPage.WEX.requestIdentity();
    const brands = page.navigator.userAgentData.brands.map((b) => "\"" + b.brand + "\";v=\"" + b.version + "\"").join(", ");
    equal("requests name the browser as navigator.userAgent and navigator.userAgentData do",
      [named.userAgent, named.clientHints.map((h) => h.name + ": " + h.value)],
      [page.navigator.userAgent, ["sec-ch-ua: " + brands, "sec-ch-ua-mobile: ?0", "sec-ch-ua-platform: \"macOS\""]]);
  }
  equal("a namespace is there only for an extension that asks for its permission",
    [chrome, page.chrome].map((api) => ["idle", "browsingData", "identity", "downloads", "declarativeNetRequest"]
      .map((name) => name in api)),
    [[false, true, true, true, true], [false, true, true, true, true]]);

  // The engine resolves a page's root-relative URLs inside the bundle, so
  // they are left as written. A file the converter renamed is asked for under
  // the name it is stored under.
  const rootRelative = new page.XMLHttpRequest();
  rootRelative.open("GET", "/network/blocked.json");
  equal("a root-relative URL is left alone", rootRelative._url, "/network/blocked.json");

  const renamed = new page.XMLHttpRequest();
  renamed.open("GET", "serverlist");
  equal("a request for a renamed file goes to the stored file",
    renamed._url, browser.baseURI + "serverlist.txt");
  equal("getURL names a renamed file as it is stored",
    chrome.runtime.getURL("/serverlist"), browser.baseURI + "serverlist.txt");
  equal("and by its name in another case",
    chrome.runtime.getURL("ServerList?a#b"), browser.baseURI + "serverlist.txt?a#b");

  // Safari serves the extension's own files with status 0.
  const ownFile = await page.fetch(browser.baseURI + "rules.json");
  check("a file of the extension's that loads is reported as 200 OK",
    ownFile.ok && ownFile.status === 200);
  equal("with the type its name implies", ownFile.headers.get("content-type"), "application/json");
  equal("and its content", (await ownFile.json())[0].id, 1);
  Object.defineProperty(ownFile, "url", { value: "rules.json" });
  equal("whose url an extension may redefine", ownFile.url, "rules.json");
  let missingFile = null;
  await page.fetch(browser.baseURI + "missing.json").catch((e) => {
    missingFile = e.message;
  });
  equal("a missing one still fails", missingFile, "Load failed");
  {
    // A script that takes globals away, as a sandbox may.
    const kept = { Headers: page.Headers, Response: page.Response, URL: page.URL };
    delete page.Headers;
    delete page.Response;
    delete page.URL;
    let afterRemoval = null;
    try {
      afterRemoval = (await page.fetch(browser.baseURI + "rules.json")).status;
    } catch (e) {
      afterRemoval = e.message;
    }
    Object.assign(page, kept);
    equal("and stays so after a script removes the globals it is made with", afterRemoval, 200);
  }

  const untouched = new page.XMLHttpRequest();
  untouched.open("GET", "https://example.com/x.json");
  equal("an absolute URL is left alone", untouched._url, "https://example.com/x.json");

  check("a missing CacheStorage is stood in for",
    !!page.caches && typeof page.caches.open === "function");
  const cache = await page.caches.open("anything");
  equal("the stand-in cache reports a miss", await cache.match("/x"), undefined);

  // The File System Access API, which is how extensions save large files.
  check("FileSystemFileHandle is provided", typeof page.FileSystemFileHandle === "function");
  check("FileSystemDirectoryHandle is provided",
    typeof page.FileSystemDirectoryHandle === "function");
  check("navigator.storage.getDirectory is provided",
    typeof page.navigator.storage.getDirectory === "function");
  check("WritableStream is available", typeof page.WritableStream === "function");

  const root = await page.navigator.storage.getDirectory();
  const fileHandle = await root.getFileHandle("download.bin", { create: true });
  const writable = await fileHandle.createWritable();

  // A multi-threaded downloader fills different offsets at once and does not
  // await each write, so the writes below are deliberately out of order and
  // un-awaited until the end.
  writable.write({ type: "write", position: 4, data: new Uint8Array([5, 6, 7, 8]) });
  writable.write({ type: "write", position: 0, data: new Uint8Array([1, 2, 3, 4]) });
  writable.write({ type: "write", position: 8, data: new Uint8Array([9]) });
  await writable.close();

  const saved = await fileHandle.getFile();
  equal("out-of-order positional writes land in the right places",
    Array.from(new Uint8Array(await saved.arrayBuffer())), [1, 2, 3, 4, 5, 6, 7, 8, 9]);

  // Saving. Where a blob URL does not load from the extension page, the
  // bytes go to the global page, which saves them through a web page's bridge.
  // The harness has no working object URLs, which exercises exactly that
  // route. The bridge's link stays out of the document.
  const savedVia = [];
  const nativeCreateElement = content.document.createElement;
  content.document.createElement = function (tag) {
    const el = nativeCreateElement.call(content.document, tag);
    if (String(tag).toLowerCase() === "a") {
      el.click = function () {
        savedVia.push({ download: el.download, attached: !!el.parentNode });
      };
    }
    return el;
  };

  await fileHandle.download("stream.mp4");
  equal("a web page's bridge saves it under the name the extension asked for, through a link outside the document",
    savedVia, [{ download: "stream.mp4", attached: false }]);

  // An extension that declares showSaveFilePicker itself must not be given a
  // second one, and one that has none gets ours so its own fallback never
  // installs.
  check("showSaveFilePicker is provided",
    typeof page.showSaveFilePicker === "function");
  const picked = await page.showSaveFilePicker({ suggestedName: "clip.mp4" });
  equal("the picker returns a handle named as suggested", picked.name, "clip.mp4");

  const reopened = await root.getFileHandle("download.bin");
  check("a handle can be fetched again by name", reopened === fileHandle);
  await root.removeEntry("download.bin");
  let gone = false;
  await root.getFileHandle("download.bin").catch(() => {
    gone = true;
  });
  check("a removed entry is gone", gone);
  equal("the page shares the background's storage",
    (await page.chrome.storage.local.get("fromContent")), { fromContent: "yes" });

  // A page's own broadcast must not come back to it, but must reach the
  // background — which is how a popup talks to its background page.
  let pageHeardItself = false;
  page.chrome.runtime.onMessage.addListener(() => {
    pageHeardItself = true;
    return false;
  });
  received.length = 0;
  await page.chrome.runtime.sendMessage({ from: "popup" });
  await settle();
  check("the background heard the popup", received.length === 1);
  check("the popup did not hear its own broadcast", pageHeardItself === false);

  let popupHeard = null;
  page.chrome.runtime.onMessage.addListener((m) => {
    popupHeard = m;
    return false;
  });
  await chrome.runtime.sendMessage({ from: "background" });
  await settle();
  equal("the popup heard the background", popupHeard, { from: "background" });

  // -- an extension page in a tab ---------------------------------------------
  // It runs in another process: what the engine gives it is carried out in
  // the page, and the rest is carried out by the global page on its behalf.
  // Two in a row, as extensions do on install: the second finds the tab the
  // first opened before that tab has reported where it is going.
  const tabsBefore = window0.tabs.length;
  await Promise.all([chrome.runtime.openOptionsPage(), chrome.runtime.openOptionsPage()]);
  equal("opening the options page twice at once opens one tab",
    window0.tabs.length, tabsBefore + 1);
  const optionsTab = window0.tabs[window0.tabs.length - 1];
  equal("the options page opens in a tab", optionsTab.url, browser.baseURI + "options.html");
  check("in front", window0.activeTab === optionsTab);

  const options = browser.createTabPage(optionsTab, [
    wex("wex-config.js"), wex("wex-core.js"), wex("wex-page.js")
  ], browser.baseURI + "options.html");
  check("a page in a tab gets a chrome object", !!options.chrome);
  equal("with every namespace the global page has",
    Object.keys(options.chrome).sort(), Object.keys(chrome).sort());
  await settle();
  {
    const unheardPage = await chrome.tabs.sendMessage(optionsTab.engineId, { toPage: 1 }).then(() => null, (e) => e.message);
    options.chrome.runtime.onMessage.addListener((message, sender, respond) => {
      if (message.toPage) {
        respond({ fromPage: message.toPage });
      }
    });
    equal("tabs.sendMessage reaches an extension page in a tab that listens, and not one that does not",
      [unheardPage, await chrome.tabs.sendMessage(optionsTab.engineId, { toPage: 2 })],
      ["Could not establish connection. Receiving end does not exist.", { fromPage: 2 }]);
  }

  await chrome.runtime.openOptionsPage();
  equal("an options page that is open is not opened again",
    window0.tabs.filter((t) => t.url === optionsTab.url).length, 1);

  equal("it shares the background's storage",
    await options.chrome.storage.local.get("fromContent"), { fromContent: "yes" });

  globalPage.localStorage.setItem("legacySetting", "from background");
  options.localStorage.setItem("fromOptions", "1");
  equal("its localStorage is the global page's, as the popover's is",
    [options.localStorage.getItem("legacySetting"), globalPage.localStorage.getItem("fromOptions")],
    ["from background", "1"]);
  equal("with callbacks too",
    await new Promise((resolve) => options.chrome.storage.local.get("broadcast", resolve)),
    { broadcast: 1 });

  const optionChanges = [];
  options.chrome.storage.onChanged.addListener((c, area) => optionChanges.push([area, c]));
  await settle();
  await options.chrome.storage.sync.set({ fromOptions: true });
  await settle();
  equal("it hears storage change", optionChanges,
    [["sync", { fromOptions: { newValue: true } }]]);

  equal("it can ask about tabs",
    (await options.chrome.tabs.query({ url: "*://example.com/*" })).map((t) => t.id), [tabId]);
  equal("it knows which tab it is in",
    (await options.chrome.tabs.getCurrent()).id, optionsTab.engineId);
  equal("it reads constants without asking", options.chrome.tabs.TAB_ID_NONE, -1);
  check("a namespace the global page lacks is absent", options.chrome.bookmarks === undefined);
  const pageDnr = options.chrome.__wexNative.declarativeNetRequest;
  const pageGetDynamicRules = pageDnr.getDynamicRules;
  let pageDnrCalls = 0;
  pageDnr.getDynamicRules = function () {
    pageDnrCalls += 1;
    return pageGetDynamicRules.apply(this, arguments);
  };
  equal("it reaches the engine's rules itself",
    (await options.chrome.declarativeNetRequest.getDynamicRules()).map((r) => r.id), [100]);
  equal("through its own engine object", pageDnrCalls, 1);
  pageDnr.getDynamicRules = pageGetDynamicRules;
  await options.chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [100] });
  equal("and its changes are the background's",
    await chrome.declarativeNetRequest.getDynamicRules(), []);

  equal("a method the global page lacks is missing",
    options.chrome.tabs.noSuchMethod, undefined);

  await options.chrome.action.setBadgeText({ text: "3" });
  equal("it can drive the toolbar button", browser.toolbarItems[0].badge, 3);
  await options.chrome.action.setBadgeText({ text: "" });

  check("it has the members the global page has",
    typeof options.chrome.tabs.query === "function" && "query" in options.chrome.tabs);
  equal("and the values of its enums",
    [options.chrome.contextMenus.ContextType.PAGE, options.chrome.contextMenus.ContextType.TAB,
     options.chrome.contextMenus.ItemType.SEPARATOR, options.chrome.runtime.PlatformOs.ANDROID],
    ["page", undefined, "separator", "android"]);
  check("and lacks the ones it lacks, as feature tests expect",
    options.chrome.runtime.getBrowserInfo === undefined &&
    !("getBrowserInfo" in options.chrome.runtime));
  const listed = {};
  for (const key in options.chrome.storage) {
    if (Object.prototype.hasOwnProperty.call(options.chrome.storage, key)) {
      listed[key] = typeof options.chrome.storage[key];
    }
  }
  equal("its namespaces are objects that list their members, as promise wrappers walk them",
    [typeof options.chrome.runtime, typeof options.chrome.storage, listed.local,
     Object.keys(options.chrome.runtime).includes("sendMessage"),
     Object.keys(options.chrome.tabs).includes("query")],
    ["object", "object", "object", true, true]);

  received.length = 0;
  equal("it can message the background",
    await options.chrome.runtime.sendMessage({ wants: "reply" }),
    { ok: true, from: "background" });
  check("and is named as the sender", received[0].sender.url === optionsTab.url &&
    received[0].sender.tab.id === optionsTab.engineId);
  equal("with the extension's origin, which getURL(\"\") extends",
    received[0].sender.origin + "/", options.chrome.runtime.getURL(""));
  equal("and which a URL of the extension reports in the background",
    new globalPage.URL(chrome.runtime.getURL("")).origin, received[0].sender.origin);
  const ownPage = new globalPage.URL(chrome.runtime.getURL("popup.html?x=1#y"));
  equal("and its path is the path within the bundle, the rest making up the href",
    [ownPage.pathname, ownPage.origin + ownPage.pathname + ownPage.search + ownPage.hash],
    ["/popup.html", chrome.runtime.getURL("popup.html?x=1#y")]);
  ownPage.pathname = "/options.html";
  equal("and setting the path keeps the URL within the bundle",
    ownPage.href, chrome.runtime.getURL("options.html?x=1#y"));
  equal("while other URLs keep theirs", new globalPage.URL("https://a.example/b/c").pathname, "/b/c");
  const pageLocation = (href) => {
    const at = new URL(href);
    return Object.assign(Object.create(globalPage.Location.prototype),
      { href, pathname: at.pathname, origin: at.protocol + "//" + at.host });
  };
  const popupLocation = pageLocation(chrome.runtime.getURL("popup.html?x=1"));
  equal("a page's location gives the converter's rewritten reads Chrome's path and origin",
    [popupLocation.__wexPathname, popupLocation.__wexOrigin + popupLocation.__wexPathname,
     pageLocation("https://a.example/b/c").__wexPathname],
    ["/popup.html", chrome.runtime.getURL("popup.html"), "/b/c"]);
  equal("and a path resolved against that origin is one of the extension's files",
    new globalPage.URL("options.html", popupLocation.__wexOrigin).href,
    chrome.runtime.getURL("options.html"));
  const ownBareOrigin = chrome.runtime.getURL("").replace(/^([a-z-]+:\/\/[^/]+).*$/, "$1").toLowerCase();
  equal("a message from one of the extension's pages has that origin too, and others keep theirs",
    [new globalPage.MessageEvent("message", { origin: ownBareOrigin }).origin,
      new globalPage.MessageEvent("message", { origin: "https://a.example" }).origin],
    [received[0].sender.origin, "https://a.example"]);

  // -- other extensions -----------------------------------------------------
  browser.engine.answerExternal = (to, message) => ({ heard: message, by: to });
  const toOther = await chrome.runtime.sendMessage("com.example.other", { ping: 1 });
  await chrome.runtime.sendMessage(chrome.runtime.id, { ping: 2 }).catch(() => {});
  equal("a message to another extension goes to that extension, and one to this extension stays internal",
    [toOther, browser.engine.externalSent.map((sent) => sent.to)],
    [{ heard: { ping: 1 }, by: "com.example.other" }, ["com.example.other"]]);
  browser.engine.answerExternal = null;
  const externalSeen = [];
  chrome.runtime.onMessageExternal.addListener((message, sender, respond) => {
    externalSeen.push([message, sender.id]);
    respond("answered");
  });
  equal("another extension's message reaches onMessageExternal, its sender named as the engine names it",
    [await browser.engine.deliverExternal({ hello: true }, { id: "com.example.other-TEAM999", url: "safari-extension://x/" }),
      externalSeen],
    ["answered", [[{ hello: true }, "com.example.other-TEAM999"]]]);
  externalSeen.length = 0;
  equal("and asking which extension this is gets the runtime's answer, out of the extension's sight",
    [await browser.engine.deliverExternal({ __wex: "identify" }, { id: "com.example.converter-TEAM999" }),
      externalSeen.length],
    [{ id: "com.example.test", name: "Fixture", version: "1.2.3", runtimeId: chrome.runtime.id,
      origin: browser.baseURI.replace(/\/$/, "") }, 0]);
  {
    // Another converted Chrome build is reached in its bundle, named by its
    // Chrome id, and says so as a sender.
    const otherId = "abcdefghijklmnopabcdefghijklmnop";
    const sent = [];
    const engineSend = globalPage.WEX.native.runtime.sendMessage;
    globalPage.WEX.native.runtime.sendMessage = function (target, message) {
      if (typeof target === "string") {
        sent.push(target);
        return Promise.resolve("ok");
      }
      return engineSend.apply(this, arguments);
    };
    await chrome.runtime.sendMessage(otherId, { hi: 1 });
    await chrome.runtime.sendMessage("Example0@example.org", { hi: 1 });
    globalPage.WEX.native.runtime.sendMessage = engineSend;
    await browser.engine.deliverExternal({ hello: 2 }, { id: "com.webext2safari." + otherId + "-TEAM999", url: "safari-extension://y/" });
    equal("another converted extension is reached by its browser's id, and named by it as a sender",
      [sent, externalSeen.map((e) => e[1])],
      [["com.webext2safari." + otherId, "com.webext2safari.example0-example-org"], [otherId]]);
    externalSeen.length = 0;
    globalPage.WEX.learnExtensionOrigins({ [otherId]: "safari-extension://com.webext2safari." + otherId + "-TEAM999/tok" });
    equal("an address built from an extension's id is its origin, its own, another's or none",
      [globalPage.WEX.chromeExtensionOrigin(chrome.runtime.id), globalPage.WEX.chromeExtensionOrigin(otherId),
        globalPage.WEX.chromeExtensionOrigin("ponmlkjihgfedcbaponmlkjihgfedcba")],
      [browser.baseURI.replace(/\/$/, ""), "safari-extension://com.webext2safari." + otherId + "-TEAM999/tok",
        "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba"]);
  }

  // -- proxy and devtools, from the engine --------------------------------
  {
    const WEXg = globalPage.WEX;
    const setting = {
      value: { mode: "system" },
      get: async () => ({ value: setting.value, levelOfControl: "controllable_by_this_extension" }),
      set: async (details) => { setting.value = details.value; },
      clear: async () => { setting.value = { mode: "system" }; },
      onChange: { addListener() {} }
    };
    const engineProxy = { settings: setting, onProxyError: {}, onRequest: {}, onError: {} };
    const chromeProxy = WEXg.makeProxy({ proxy: engineProxy });
    WEXg.CONFIG.firefoxBuild = true;
    let firefoxProxy;
    try {
      firefoxProxy = WEXg.makeProxy({ proxy: engineProxy });
    } finally {
      WEXg.CONFIG.firefoxBuild = false;
    }
    equal("each build gets its own browser's proxy members",
      [Object.keys(chromeProxy).sort(), Object.keys(firefoxProxy).sort()],
      [["onProxyError", "settings"], ["onError", "onRequest", "settings"]]);
    const setResult = await firefoxProxy.settings.set({ value: { proxyType: "manual",
      http: "proxy.example:8080", ssl: "proxy.example:8443", passthrough: "localhost, .local" } });
    equal("Firefox's proxy settings are given to the engine as Chrome's",
      [setResult, setting.value],
      [true, { mode: "fixed_servers", rules: {
        proxyForHttp: { scheme: "http", host: "proxy.example", port: 8080 },
        proxyForHttps: { scheme: "http", host: "proxy.example", port: 8443 },
        bypassList: ["localhost", ".local"] } }]);
    const got = (await firefoxProxy.settings.get({})).value;
    equal("and read back as Firefox's",
      [got.proxyType, got.http, got.ssl, got.passthrough, got.httpProxyAll],
      ["manual", "proxy.example:8080", "proxy.example:8443", "localhost, .local", false]);
    setting.value = { mode: "fixed_servers", rules: { singleProxy: { scheme: "socks5", host: "s.example", port: 1080 } } };
    const socks = (await firefoxProxy.settings.get({})).value;
    equal("a single SOCKS server is Firefox's socks setting", [socks.socks, socks.socksVersion, socks.http],
      ["s.example:1080", 5, ""]);
    const devtools = WEXg.makeDevtools({ devtools: { inspectedWindow: { tabId: 5 }, network: { onNavigated: {} } } });
    equal("a devtools page gets the engine's devtools, and panels that say they cannot be made",
      [devtools.inspectedWindow.tabId, !!devtools.network.onNavigated,
        await devtools.panels.create("Mine", "icon.png", "panel.html").then(() => "made", (e) => e.message),
        WEXg.makeDevtools({}) === undefined],
      [5, true, "Panels are not available in this browser's developer tools.", true]);
  }

  // Scratch Addons loads its settings with a string message and a callback.
  // The callback must be removed before resolving the optional extension id.
  const settingsReply = { manifests: [{ addonId: "example" }], addonsEnabled: { example: true } };
  const settingsListener = (message, sender, respond) => {
    if (message !== "getSettingsInfo") return;
    setTimeout(() => respond(settingsReply), 0);
    return true;
  };
  chrome.runtime.onMessage.addListener(settingsListener);
  // Chrome takes two arguments whose first is a string, or nothing, as an
  // extension's id and the message: ("getSettingsInfo", {}) is a message to
  // an extension of that id, which no extension answers.
  for (const args of [["getSettingsInfo", {}], ["getSettingsInfo", null], ["getSettingsInfo", undefined]]) {
    equal("a string and one more argument name another extension: " + JSON.stringify(args),
      await options.chrome.runtime.sendMessage(...args).then(() => "answered", (e) => e.message),
      "Could not establish connection. Receiving end does not exist.");
  }
  const messageForms = [
    ["getSettingsInfo"],
    [chrome.runtime.id, "getSettingsInfo"],
    [null, "getSettingsInfo"],
    [chrome.runtime.id, "getSettingsInfo", {}],
    [null, "getSettingsInfo", {}]
  ];
  for (const [index, args] of messageForms.entries()) {
    equal("string message overload " + index + " returns the background response",
      await options.chrome.runtime.sendMessage(...args), settingsReply);
    let calls = 0;
    let response;
    await options.chrome.runtime.sendMessage(...args, (value) => {
      calls += 1;
      response = value;
    });
    equal("string message overload " + index + " calls its callback once", calls, 1);
    equal("string message overload " + index + " delivers the callback response", response, settingsReply);
  }
  let contentSettings;
  await content.chrome.runtime.sendMessage("getSettingsInfo", (value) => { contentSettings = value; });
  equal("content scripts also support string messages with callbacks", contentSettings, settingsReply);
  equal("an explicit extension id still accepts an object message",
    await options.chrome.runtime.sendMessage(chrome.runtime.id, { wants: "reply" }),
    { ok: true, from: "background" });
  chrome.runtime.onMessage.removeListener(settingsListener);

  // Bundled SVGs have no MIME type in Safari; images do not use our fetch
  // wrapper. A failed image is retried with the type carried in a data URL.
  const imageFetch = options.fetch;
  const imageRequests = [];
  options.fetch = (url) => { imageRequests.push(url); return imageFetch(url); };
  const brokenImage = (src) => {
    const img = options.document.createElement("img");
    img.src = src;
    options.document.dispatchEvent({ type: "error", target: img });
    return img;
  };
  const svgURL = options.chrome.runtime.getURL("icon.svg");
  const svgImage = brokenImage(svgURL);
  const svgFragment = brokenImage(svgURL + "#view");
  const replacedImage = brokenImage(svgURL);
  replacedImage.src = "https://example.com/new.png";
  const externalImage = brokenImage("https://example.com/icon.svg");
  const foreignImage = brokenImage("safari-extension://another-extension/token/icon.svg");
  const pngImage = brokenImage(options.chrome.runtime.getURL("missing.png"));
  const responsiveImage = options.document.createElement("img");
  responsiveImage.src = svgURL;
  responsiveImage.srcset = svgURL + " 2x";
  options.document.dispatchEvent({ type: "error", target: responsiveImage });
  await settle();
  check("a failed bundled SVG image gets an explicit media type",
    svgImage.src.startsWith("data:image/svg+xml;charset=utf-8,"));
  equal("the SVG bytes survive URL encoding",
    decodeURIComponent(svgImage.src.split(",")[1]), fs.readFileSync(path.join(bundle, "icon.svg"), "utf8"));
  equal("SVG fragments survive the fallback", svgFragment.src, svgImage.src + "#view");
  equal("multiple uses of an SVG share one fetch", imageRequests, [svgURL]);
  equal("a pending SVG does not overwrite a newer source", replacedImage.src, "https://example.com/new.png");
  equal("web images are left to the page", externalImage.src, "https://example.com/icon.svg");
  equal("another extension's image is left alone", foreignImage.src, "safari-extension://another-extension/token/icon.svg");
  check("non-SVG images are left alone", pngImage.src.endsWith("/missing.png"));
  equal("responsive image selection is left to the browser", responsiveImage.src, svgURL);
  const contentImage = content.document.createElement("img");
  contentImage.src = svgURL;
  content.document.dispatchEvent({ type: "error", target: contentImage });
  const hostImage = content.document.createElement("img");
  hostImage.src = "https://example.com/site-icon.svg";
  content.document.dispatchEvent({ type: "error", target: hostImage });
  await settle();
  equal("injected add-on controls can load their bundled SVG icons", contentImage.src, svgImage.src);
  equal("the content fallback leaves the site's own images alone", hostImage.src, "https://example.com/site-icon.svg");
  options.document.dispatchEvent({ type: "error", target: svgImage });
  const missingSVG = brokenImage(options.chrome.runtime.getURL("missing.svg"));
  await settle();
  options.document.dispatchEvent({ type: "error", target: missingSVG });
  await settle();
  equal("missing SVGs and failed data URLs do not cause retry loops", imageRequests.length, 2);
  check("a missing SVG keeps its original source", missingSVG.src.endsWith("/missing.svg"));
  options.fetch = imageFetch;

  equal("it can message content scripts",
    await options.chrome.tabs.sendMessage(tabId, { ping: 9 }), { pong: 9 });
  equal("it can inject scripts",
    await options.chrome.tabs.executeScript(tabId, { code: "1 + 1" }), [2]);

  const optionRequests = [];
  options.chrome.webRequest.onBeforeRequest.addListener((d) => {
    optionRequests.push(d.url);
  }, { urls: ["*://watched.example/*"] });
  await browser.engine.request({ url: "https://watched.example/a", type: "image" });
  equal("it can watch requests", optionRequests, ["https://watched.example/a"]);

  const menuClicks = [];
  options.chrome.contextMenus.create({
    id: "from-options", title: "From options", contexts: ["all"],
    onclick: (info) => menuClicks.push(info.menuItemId)
  });
  await settle();
  browser.application.fire("command",
    { command: "wex-menu:from-options", userInfo: {}, __stopped: false }, true);
  await settle();
  equal("a menu item's onclick runs in the page that made it", menuClicks, ["from-options"]);

  // -- tab bookkeeping --------------------------------------------------------
  {
    // A page outside the extension's website access, whose address Safari
    // keeps from it.
    const withheld = window0.openTab("background");
    withheld._url = undefined;
    withheld.title = "Private";
    await settle();
    const found = (await chrome.tabs.query({})).filter((t) => t.windowId !== undefined && t.index === window0.tabs.indexOf(withheld));
    equal("an extension with the tabs permission gets an address and title for every tab",
      found.map((t) => [t.url, t.title]), [["", ""]]);
    withheld.close();
    await settle();
  }
  const madeTab = await chrome.tabs.create({ url: "https://made.example/", active: false });
  const madeSafariTab = window0.tabs[window0.tabs.length - 1];
  equal("tabs.create reports the engine's id for the tab it made",
    madeTab.id, madeSafariTab.engineId);
  equal("and where it is going", madeTab.url, "https://made.example/");

  const navigations = [];
  const commitDocuments = [];
  const completeDocuments = [];
  chrome.webNavigation.onCommitted.addListener((d) => navigations.push(d.url));
  chrome.webNavigation.onCommitted.addListener((d) => commitDocuments.push(d.documentId));
  chrome.webNavigation.onCommitted.addListener((d) => commitDocuments.push(d.documentId));
  chrome.webNavigation.onCompleted.addListener((d) => completeDocuments.push(d.documentId));
  const documentBefore = (await chrome.webNavigation.getFrame({ tabId, frameId: 0 })).documentId;
  const filteredNavigations = [];
  chrome.webNavigation.onCommitted.addListener((d) => filteredNavigations.push(d.url),
    { url: [{ hostSuffix: "other.example" }] });

  await chrome.action.setBadgeText({ text: "4", tabId });
  window0.activeTab = tab;
  tab.activate();
  equal("a tab's own badge shows while the tab does", browser.toolbarItems[0].badge, 4);

  const updates = [];
  chrome.tabs.onUpdated.addListener((id, info, t) => updates.push([id, info.status, t.index]));
  tab.navigate("https://example.com/next");
  await settle();
  check("a navigation is reported", navigations.includes("https://example.com/next"));
  const documentAfter = (await chrome.webNavigation.getFrame({ tabId, frameId: 0 })).documentId;
  check("as a new document, which every listener and later lookup names alike",
    commitDocuments.length === 2 && commitDocuments[0] === commitDocuments[1] &&
    completeDocuments.includes(commitDocuments[0]) && documentAfter === commitDocuments[0] &&
    documentAfter !== documentBefore, JSON.stringify([commitDocuments, completeDocuments, documentBefore]));
  equal("a listener's URL filter is applied", filteredNavigations, []);
  check("tabs.onUpdated reports loading and complete, with Safari's view of the tab",
    updates.some((u) => u[0] === tabId && u[1] === "loading" && u[2] === 0) &&
    updates.some((u) => u[0] === tabId && u[1] === "complete"));
  equal("a tab's own badge goes when the tab shows another document",
    browser.toolbarItems[0].badge, 0);

  const activations = [];
  chrome.tabs.onActivated.addListener((info) => activations.push(info.tabId));
  laterTab.activate();
  await settle();
  equal("switching tabs is reported", activations, [laterTab.engineId]);

  const removed = [];
  chrome.tabs.onRemoved.addListener((id) => removed.push(id));
  await chrome.tabs.remove(madeTab.id);
  equal("tabs.remove closes the tab", window0.tabs.indexOf(madeSafariTab), -1);
  await settle();
  equal("and its closing is reported", removed, [madeTab.id]);

  // Safari can omit its Info.plist content-script injection, and keeps an
  // updated extension's old list until relaunch, so every start maintains a
  // guarded runtime registration of the bridge and content-script copies.
  const reloadBrowser = new FakeBrowser(bundle, { bundleId: "com.example.test-TEAM123" });
  reloadBrowser.openWindow().openTab();
  const globalFiles = [wex("wex-config.js"), wex("wex-core.js"), wex("wex-global.js")];
  const beforeReload = reloadBrowser.createGlobalPage(globalFiles);
  equal("a first start registers the bridge and its copies", reloadBrowser.contentScripts.length, 3);
  beforeReload.safari.extension.addContentScript("extension-owned", ["https://example.com/*"], [], false);
  reloadBrowser.createGlobalPage(globalFiles);
  const updated = reloadBrowser.contentScripts.filter((entry) => entry.source !== "extension-owned");
  equal("a reload replaces the bridge registration and preserves the extension's own", updated.length, 3);
  reloadBrowser.createGlobalPage(globalFiles);
  equal("the next start replaces them once again without accumulating copies",
    [reloadBrowser.contentScripts.filter((entry) => entry.source === "extension-owned").length,
      reloadBrowser.contentScripts.filter((entry) => entry.source !== "extension-owned").length], [1, 3]);

  // A version 2 manifest's own messages and tab calls, which a version 3
  // manifest's namespaces leave out.
  {
    const v2 = fs.mkdtempSync(path.join(os.tmpdir(), "wex-v2-"));
    fs.cpSync(bundle, v2, { recursive: true });
    const configFile = path.join(v2, "wex", "wex-config.js");
    const v2Config = JSON.parse(fs.readFileSync(configFile, "utf8").replace(/^var WEX_CONFIG = /, "").replace(/;\s*$/, ""));
    v2Config.manifest.manifest_version = 2;
    delete v2Config.manifest.action;
    v2Config.manifest.browser_action = {};
    fs.writeFileSync(configFile, "var WEX_CONFIG = " + JSON.stringify(v2Config) + ";\n");
    const v2Browser = new FakeBrowser(v2, { bundleId: "com.example.test-TEAM123" });
    const v2Window = v2Browser.openWindow();
    const v2Tab = v2Window.openTab();
    v2Tab.url = "https://example.com/";
    const v2Other = v2Window.openTab("background");
    v2Other.url = "https://other.example/";
    v2Window.activeTab = v2Tab;
    const v2Page = v2Browser.createGlobalPage([path.join(v2, "wex", "wex-config.js"),
      path.join(v2, "wex", "wex-core.js"), path.join(v2, "wex", "wex-global.js")]);
    const c2 = v2Page.chrome;
    const requests = [];
    c2.extension.onRequest.addListener((request, sender, sendResponse) => {
      requests.push(request);
      setTimeout(() => sendResponse({ echoed: request }), 5);
    });
    const v2PageTab = v2Window.openTab("background");
    const v2Options = v2Browser.createTabPage(v2PageTab, [path.join(v2, "wex", "wex-config.js"),
      path.join(v2, "wex", "wex-core.js"), path.join(v2, "wex", "wex-page.js")], v2Browser.baseURI + "options.html");
    await settle();
    const response = await new Promise((resolve) => v2Options.chrome.extension.sendRequest({ ask: 1 }, resolve));
    equal("extension.sendRequest reaches onRequest, and its answer comes back, later as at once",
      [requests, response], [[{ ask: 1 }], { echoed: { ask: 1 } }]);
    const selected = await new Promise((resolve) => c2.tabs.getSelected(null, resolve));
    const inWindow = await new Promise((resolve) => c2.tabs.getAllInWindow(resolve));
    equal("tabs.getSelected and getAllInWindow describe the window's tabs",
      [selected.url, inWindow.map((t) => t.url).slice(0, 2)],
      ["https://example.com/", ["https://example.com/", "https://other.example/"]]);
    const legacyEvents = [];
    c2.tabs.onSelectionChanged.addListener((id, info) => legacyEvents.push(["selection", id, typeof info.windowId]));
    c2.tabs.onActiveChanged.addListener((id, info) => legacyEvents.push(["active", id, typeof info.windowId]));
    c2.tabs.onHighlightChanged.addListener((info) => legacyEvents.push(["highlight", info.tabIds[0], typeof info.windowId]));
    v2Other.activate();
    await settle();
    equal("a version 2 manifest's tab events report the tab a window shows, as Chrome calls them",
      legacyEvents, [["selection", v2Other.engineId, "number"], ["active", v2Other.engineId, "number"],
        ["highlight", v2Other.engineId, "number"]]);
    equal("and a version 3 manifest has none of them",
      [chrome.extension.sendRequest, chrome.extension.onRequest, chrome.tabs.getSelected, chrome.tabs.onActiveChanged],
      [undefined, undefined, undefined, undefined]);
  }

  // Storage lives in IndexedDB, which outlasts a restart of the global page;
  // what an earlier version kept in localStorage moves there.
  const storageBrowser = new FakeBrowser(bundle, { bundleId: "com.example.test-TEAM123" });
  storageBrowser.openWindow().openTab();
  const firstRun = storageBrowser.createGlobalPage(globalFiles);
  firstRun.localStorage.setItem("wex.local.legacy", JSON.stringify({ kept: true }));
  await firstRun.chrome.storage.local.set({ fresh: [1, 2, 3] });
  const secondRun = storageBrowser.createGlobalPage(globalFiles);
  equal("stored values outlast a restart of the global page, and older ones move in",
    [await secondRun.chrome.storage.local.get(["fresh", "legacy"]),
     secondRun.localStorage.getItem("wex.local.legacy")],
    [{ fresh: [1, 2, 3], legacy: { kept: true } }, null]);

  // Alarms are Chrome's: they outlast a restart unless the extension says
  // otherwise, and one that came due meanwhile fires once the extension has
  // started.
  {
    const alarmBrowser = new FakeBrowser(bundle, { bundleId: "com.example.test-TEAM123" });
    alarmBrowser.openWindow().openTab();
    const first = alarmBrowser.createGlobalPage(globalFiles);
    await settle(400);
    const errors = [];
    const attempt = (p) => p.then(() => "ok", (e) => e.message);
    errors.push(await attempt(first.chrome.alarms.create("both", { name: "both", delayInMinutes: 1 })));
    errors.push(await attempt(first.chrome.alarms.create("none", {})));
    errors.push(await attempt(first.chrome.alarms.create({ when: Date.now() + 5, delayInMinutes: 1 })));
    errors.push(await attempt(first.chrome.alarms.create("x".repeat(1025), { delayInMinutes: 1 })));
    equal("alarms.create refuses what Chrome refuses, with Chrome's errors", errors, [
      "Cannot set alarm name in both separate argument and object form.",
      "Must set at least one of when, delayInMinutes, or periodInMinutes.",
      "Cannot set both when and delayInMinutes.",
      "Alarm name size is 1025 bytes which exceeds the limit of 1024 bytes."]);
    let called = false;
    first.chrome.alarms.create({ name: "kept", when: Date.now() + 150 }, () => { called = true; });
    await first.chrome.alarms.create("dropped", { when: Date.now() + 150, persistAcrossSessions: false });
    await first.chrome.alarms.create("periodic", { delayInMinutes: 10, periodInMinutes: 10 });
    await settle();
    equal("an alarm can be named in its alarmInfo, and create calls its callback",
      [called, await first.chrome.alarms.get("kept")],
      [true, { name: "kept", scheduledTime: (await first.chrome.alarms.get("kept")).scheduledTime,
        persistAcrossSessions: true }]);
    const second = alarmBrowser.createGlobalPage(globalFiles);
    const firedAfterRestart = [];
    second.chrome.alarms.onAlarm.addListener((alarm) => firedAfterRestart.push(alarm.name));
    equal("alarms that persist outlast a restart of the global page",
      (await second.chrome.alarms.getAll()).map((alarm) => alarm.name).sort(), ["kept", "periodic"]);
    await settle(600);
    equal("and one that came due fires once the extension has started",
      [firedAfterRestart, (await second.chrome.alarms.getAll()).map((alarm) => alarm.name)],
      [["kept"], ["periodic"]]);
    equal("runtime.getVersion is the manifest's version", second.chrome.runtime.getVersion(),
      second.chrome.runtime.getManifest().version);
  }

  // The test API runs tests as Chromium's does, in either of its modes, and
  // reports each one.
  {
    const testWorld = (mode) => {
      const world = { console, navigator: {}, setTimeout, clearTimeout, Promise,
        safari: { extension: { baseURI: "safari-extension://x-TEAM/abc/" } } };
      world.self = world;
      vm.createContext(world);
      vm.runInContext("var WEX_CONFIG = " + JSON.stringify({ testApi: mode, manifest: {} }) + ";", world);
      vm.runInContext(fs.readFileSync(wex("wex-core.js"), "utf8"), world);
      const reports = [];
      const test = world.WEX.makeTestApi((entry) => { reports.push(entry); }, () => undefined);
      return { test, reports };
    };
    const outcome = (reports) => reports.filter((e) => e.kind === "testFinished" || e.kind === "pass" || e.kind === "fail")
      .map((e) => e.kind === "testFinished" ? (e.result ? "PASS " : "FAIL ") + e.testName : e.kind);
    const standard = testWorld("standard");
    await standard.test.runTests([
      function returns() { standard.test.assertEq([1, ["a"]], [1, ["a"]]); },
      async function resolves() { await null; standard.test.assertTrue(true); },
      function asserts() { standard.test.assertEq(1, 2); },
      function throws() { throw new Error("boom"); },
      function succeeds() { standard.test.succeed(); }
    ]).catch(() => {});
    await settle(50);
    equal("in the standard mode a test passes when it returns or its promise resolves",
      outcome(standard.reports),
      ["PASS returns", "PASS resolves", "FAIL asserts", "FAIL throws", "FAIL succeeds", "fail"]);
    const chromeMode = testWorld("chrome");
    await chromeMode.test.runTests([
      function callsSucceed() { setTimeout(() => chromeMode.test.succeed(), 5); },
      function passesByCallback() {
        const done = chromeMode.test.callbackPass((v) => chromeMode.test.assertEq(3, v));
        setTimeout(() => done(3), 5);
      },
      function failsByCallback() {
        const done = chromeMode.test.callbackPass((v) => chromeMode.test.assertEq(3, v));
        // The failed assertion's signal ends the callback, as in a browser.
        setTimeout(() => { try { done(4); } catch (e) { /* chrome.test.failure */ } }, 5);
      }
    ]).catch(() => {});
    await settle(80);
    equal("in Chrome's mode a test passes when it calls succeed() or its callbacks have run",
      outcome(chromeMode.reports), ["PASS callsSucceed", "PASS passesByCallback", "FAIL failsByCallback", "fail"]);
  }

  // Calls are checked against Chrome's schemas, with Chrome's errors.
  {
    const api = JSON.parse(fs.readFileSync(path.join(RUNTIME, "chrome-api.json"), "utf8"));
    const checker = globalPage.WEX.makeApiChecker(api);
    const fn = (ns, name) => api[ns].functions.find((f) => f.name === name);
    const typeFn = (ns, type, name) =>
      api[ns].types.find((t) => t.id === type).functions.find((f) => f.name === name);
    const area = (name) => typeFn("storage", "storage.StorageArea", name);
    const errorOf = (label, spec, args) => checker.callError(label, spec, args);
    const cb = () => {};
    equal("a call that fits its schema passes, in each of its forms", [
      errorOf("storage.StorageArea.set", area("set"), [{ a: 1, b: null }]),
      errorOf("storage.StorageArea.set", area("set"), [{ a: 1 }, cb]),
      errorOf("storage.StorageArea.get", area("get"), []),
      errorOf("storage.StorageArea.get", area("get"), [cb]),
      errorOf("storage.StorageArea.get", area("get"), [["a", "b"], cb]),
      errorOf("storage.StorageArea.get", area("get"), [null, undefined]),
      errorOf("alarms.create", fn("alarms", "create"), [{ periodInMinutes: 1 }]),
      errorOf("alarms.create", fn("alarms", "create"), ["n", { when: 1.5 }, cb]),
      errorOf("runtime.sendMessage", fn("runtime", "sendMessage"), ["text"]),
      errorOf("runtime.sendMessage", fn("runtime", "sendMessage"), ["other-id", { a: 1 }, cb]),
      errorOf("tabs.query", fn("tabs", "query"), [{ active: true, currentWindow: true }, cb]),
      errorOf("tabs.sendMessage", fn("tabs", "sendMessage"), [1, { a: 1 }]),
      errorOf("idle.queryState", fn("idle", "queryState"), [60])
    ], new Array(13).fill(null));
    equal("one that does not throws Chrome's error", [
      errorOf("storage.StorageArea.set", area("set"), ["invalid"]),
      errorOf("runtime.getURL", fn("runtime", "getURL"), []),
      errorOf("runtime.getURL", fn("runtime", "getURL"), [42]),
      errorOf("idle.queryState", fn("idle", "queryState"), [5]),
      errorOf("idle.queryState", fn("idle", "queryState"), [15.5]),
      errorOf("storage.StorageArea.setAccessLevel", area("setAccessLevel"), [{ accessLevel: "INVALID" }]),
      errorOf("alarms.create", fn("alarms", "create"), [{ delayInMinutes: 1, unknown: 1 }]),
      errorOf("tabs.query", fn("tabs", "query"), [{ windowId: "x" }])
    ], [
      "Error in invocation of storage.StorageArea.set(object items, optional function callback): No matching signature.",
      "Error in invocation of runtime.getURL(string path): No matching signature.",
      "Error in invocation of runtime.getURL(string path): No matching signature.",
      "Error in invocation of idle.queryState(integer detectionIntervalInSeconds, optional function callback): " +
        "Error at parameter 'detectionIntervalInSeconds': Value must be at least 15.",
      "Error in invocation of idle.queryState(integer detectionIntervalInSeconds, optional function callback): " +
        "No matching signature.",
      "Error in invocation of storage.StorageArea.setAccessLevel(object accessOptions, optional function callback): " +
        "Error at parameter 'accessOptions': Error at property 'accessLevel': " +
        "Value must be one of TRUSTED_AND_UNTRUSTED_CONTEXTS, TRUSTED_CONTEXTS.",
      "Error in invocation of alarms.create(optional string name, alarms.AlarmCreateInfo alarmInfo, " +
        "optional function callback): Error at parameter 'alarmInfo': Unexpected property: 'unknown'.",
      "Error in invocation of tabs.query(object queryInfo, optional function callback): " +
        "Error at parameter 'queryInfo': Error at property 'windowId': Invalid type: expected integer, found string."
    ]);
    const local = { set: (items) => Promise.resolve(Object.keys(items)) };
    const root = { storage: { local: local }, runtime: { getURL: (p) => "u:" + p } };
    checker.install(root);
    let thrown = null;
    try {
      root.storage.local.set("invalid");
    } catch (e) {
      thrown = e;
    }
    equal("the checks go on the namespace's members and on objects of its types",
      [thrown && thrown.name, root.runtime.getURL("a"), await root.storage.local.set({ k: 1 })],
      ["TypeError", "u:a", ["k"]]);
  }

  // A sandbox may replace every global it can with one that throws;
  // the runtime keeps working for code that took the namespace beforehand.
  const lockedChrome = secondRun.chrome;
  require("vm").runInContext(`
    Object.getOwnPropertyNames(globalThis).forEach(function (name) {
      if (["Object", "Promise", "Proxy", "Array", "JSON", "Error", "console", "Symbol",
           "Reflect", "Function", "String", "Number", "Map", "Set", "WeakMap", "Math", "Date",
           "RegExp", "TypeError", "globalThis"].indexOf(name) >= 0) { return; }
      var d = Object.getOwnPropertyDescriptor(globalThis, name);
      var thrower = function () { throw new Error(name + " is inaccessible"); };
      if (d.configurable) {
        Object.defineProperty(globalThis, name, { configurable: false, get: thrower, set: function () {} });
      } else if (d.writable) {
        Object.defineProperty(globalThis, name, { configurable: false, writable: false,
          value: new Proxy({}, { get: thrower, getPrototypeOf: thrower }) });
      }
    });`, secondRun.document.__context);
  equal("the runtime keeps working once a sandbox takes away the globals it does not pin",
    [await lockedChrome.storage.local.get("fresh"),
     (await lockedChrome.tabs.query({})).length > 0],
    [{ fresh: [1, 2, 3] }, true]);

  // -- report -----------------------------------------------------------------
  console.log("");
  console.log(passed + " checks passed, " + failures.length + " failed");
  if (failures.length) {
    console.log("");
    for (const failure of failures) {
      console.log("  FAIL  " + failure);
    }
    process.exit(1);
  }
}

main().then(() => process.exit(0), (err) => {
  console.error(err);
  process.exit(1);
});
