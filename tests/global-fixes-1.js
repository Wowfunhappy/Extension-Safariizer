// The global page's handling of navigations from the web, storage, the
// toolbar, importScripts, the side panel and the debugger, in a simulated Safari.
// node tests/global-fixes-1.js
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { FakeBrowser } = require("./fake-safari");

const RUNTIME = path.join(__dirname, "..", "webext2safari", "runtime");
const WEB = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const PROVISIONAL = 0x40000000;

let passed = 0;
const failures = [];

function equal(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    passed += 1;
  } else {
    failures.push(name + ": got " + a + ", expected " + b);
  }
}

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms || 30));

function fixture(change, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wex-global-fixes-"));
  fs.cpSync(RUNTIME, path.join(dir, "wex"), { recursive: true });
  for (const name of ["wex-api.js", "wex-content-api.js"]) {
    fs.writeFileSync(path.join(dir, "wex", name), "var WEX_API = null;\n");
  }
  const config = {
    extensionId: "com.example.test",
    name: "Fixture",
    version: "1",
    manifest: {
      manifest_version: 3, name: "Fixture", version: "1",
      action: { default_popup: "popup.html" },
      side_panel: { default_path: "panel.html" },
      web_accessible_resources: [{ resources: ["public.html"], matches: ["https://login.example/*"] }],
      permissions: ["tabs", "storage", "sidePanel", "debugger", "webRequest", "webNavigation", "<all_urls>"]
    },
    storage: "local",
    sourceOrigin: WEB,
    popupPage: "popup.html",
    optionsPage: "options.html",
    popoverId: "wex-popover",
    toolbarId: "wex-toolbar",
    actionCommand: "wex-action",
    backgroundPage: "wex-global-page.html",
    backgroundWorker: true,
    contentScripts: []
  };
  if (change) {
    change(config);
  }
  fs.writeFileSync(path.join(dir, "wex", "wex-config.js"),
    "var WEX_CONFIG = " + JSON.stringify(config) + ";\n");
  for (const [name, text] of Object.entries(files || {})) {
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

// WebKit's input and Web Inspector, recording what they are asked. A command
// `hold` names gets no answer.
function fakeAqua(hold) {
  const inspectorListeners = { message: [], detach: [] };
  const calls = [];
  const toInspector = (tabId, message) => setTimeout(() => {
    inspectorListeners.message.forEach((fn) => fn(tabId, JSON.stringify(message)));
  }, 0);
  const none = { addListener() {}, removeListener() {} };
  return {
    calls,
    toInspector,
    input: {
      dispatchKeyEvent: async (tabId, event) => { calls.push(["key", event]); },
      insertText: async (tabId, text) => { calls.push(["text", text]); },
      performEditingAction: async () => {}
    },
    dialog: { onOpen: none },
    inspector: {
      onMessage: { addListener: (fn) => inspectorListeners.message.push(fn) },
      onDetach: { addListener: (fn) => inspectorListeners.detach.push(fn) },
      attach: async (tabId) => {
        calls.push(["attach", tabId]);
        toInspector(tabId, { method: "Target.targetCreated",
          params: { targetInfo: { targetId: "page-1", type: "page" } } });
        await settle(5);
      },
      detach: async () => {},
      sendMessage: async (tabId, text) => {
        const inner = JSON.parse(JSON.parse(text).params.message);
        calls.push(["page", inner.method]);
        if (hold !== inner.method) {
          toInspector(tabId, { method: "Target.dispatchMessageFromTarget",
            params: { targetId: "page-1", message: JSON.stringify({ id: inner.id,
              result: { result: { type: "number", value: 2, description: "2" }, wasThrown: false } }) } });
        }
      }
    }
  };
}

// The extension running in a browser with one window, whose active tab shows
// a page on the web.
async function boot(options) {
  const o = options || {};
  const dir = fixture(o.config, o.files);
  const browser = new FakeBrowser(dir, Object.assign({ bundleId: "com.example.test-TEAM123" }, o.browser));
  const win = browser.openWindow();
  const tab = win.openTab();
  tab.url = "https://example.com/page";
  win.activeTab = tab;
  if (o.aqua) {
    browser.aqua = o.aqua;
  }
  if (o.before) {
    o.before(browser);
  }
  await settle();
  const wex = (name) => path.join(dir, "wex", name);
  const page = browser.createGlobalPage([wex("wex-config.js"), wex("wex-core.js"), wex("wex-global.js")]);
  await settle();
  const [info] = await page.chrome.tabs.query({ url: "https://example.com/*" });
  return { browser, win, tab, page, chrome: page.chrome, id: info.id };
}

function announce(browser, target, url) {
  const event = { target, url, prevented: false, __stopped: false,
    preventDefault() { this.prevented = true; } };
  browser.application.fire("beforeNavigate", event, true);
  return event;
}

function arrive(browser, target) {
  browser.application.fire("navigate", { target, __stopped: false }, true);
}

async function failure(promise) {
  try {
    await promise;
    return "no failure";
  } catch (e) {
    return e.message;
  }
}

async function webNavigation() {
  const { browser, win, tab, chrome, id } = await boot();
  const base = browser.baseURI;

  // A site's navigation to a page the manifest does not give it fails, in
  // either of the events it can reach the global page by.
  let event = announce(browser, tab, WEB + "/options.html?import=https://evil.example/");
  await settle();
  equal("a site's navigation to a page not web-accessible is left alone",
    [event.prevented, tab.url], [false, "https://example.com/page"]);
  tab._url = WEB + "/options.html?import=https://evil.example/";
  arrive(browser, tab);
  await settle();
  equal("and the page Safari shows for it does not open the page either",
    tab.url, WEB + "/options.html?import=https://evil.example/");

  // A redirect a site sends arrives at the address with no announcement of it.
  tab._url = "https://example.com/page";
  announce(browser, tab, "https://evil.example/redirect");
  tab._url = WEB + "/options.html";
  arrive(browser, tab);
  await settle();
  equal("a site's redirect to a page not web-accessible does not open it", tab.url, WEB + "/options.html");

  // Other pages the web controls, and one whose address Safari hides.
  for (const from of ["blob:https://evil.example/1", "data:text/html,x", "ftp://evil.example/", "file:///tmp/x.html", undefined]) {
    tab._url = from;
    event = announce(browser, tab, WEB + "/options.html");
    await settle();
    equal("a tab showing " + from + " does not open a page not web-accessible",
      [event.prevented, tab.url], [false, from]);
    tab._url = WEB + "/options.html";
    arrive(browser, tab);
    await settle();
    equal("nor once it shows Safari's page for the address, from " + from, tab.url, WEB + "/options.html");
  }

  // What the manifest gives a site it opens, by either event.
  tab._url = "https://login.example/done";
  event = announce(browser, tab, WEB + "/public.html?code=1");
  await settle();
  equal("a site opens a page the manifest gives it", [event.prevented, tab.url], [true, base + "public.html?code=1"]);
  tab._url = "https://evil.example/";
  event = announce(browser, tab, WEB + "/public.html");
  await settle();
  equal("and a site the manifest does not name does not", [event.prevented, tab.url], [false, "https://evil.example/"]);
  tab._url = "https://login.example/done";
  announce(browser, tab, WEB + "/public.html");
  tab._url = WEB + "/public.html";
  arrive(browser, tab);
  await settle();
  equal("the page Safari shows for an allowed address opens it", tab.url, base + "public.html");

  // A blank tab and the extension's own pages open any page.
  for (const from of ["", "about:blank", base + "popup.html", "topsites://"]) {
    tab._url = from;
    event = announce(browser, tab, WEB + "/options.html?typed=1");
    await settle();
    equal("a tab showing " + JSON.stringify(from) + " opens any of the extension's pages",
      [event.prevented, tab.url], [true, base + "options.html?typed=1"]);
  }
  tab._url = "";
  announce(browser, tab, null);
  tab._url = WEB + "/options.html";
  arrive(browser, tab);
  await settle();
  equal("as does a tab going on from Top Sites", tab.url, base + "options.html");

  // The extension's own navigation, from a tab on the web.
  tab._url = "https://example.com/page";
  await chrome.tabs.update(id, { url: WEB + "/options.html?own=1" });
  await settle();
  equal("the extension sends a tab on the web to any of its pages", tab.url, base + "options.html?own=1");
  const opened = await chrome.tabs.create({ url: WEB + "/options.html?new=1" });
  await settle();
  equal("and opens any of them in a new tab",
    win.tabs.find((t) => t.engineId === opened.id).url, base + "options.html?new=1");

  // A web address keeps its treatment.
  tab._url = "https://example.com/page";
  event = announce(browser, tab, "https://other.example/x");
  equal("a tab going on to the web goes there", event.prevented, false);
}

async function storage() {
  const { chrome } = await boot();
  const queue = ["job"];
  const setting = chrome.storage.local.set({ queue });
  queue.length = 0;
  await setting;
  equal("set keeps the values as they were when it was called",
    await chrome.storage.local.get("queue"), { queue: ["job"] });

  await chrome.storage.local.set({ x: 1, y: 2 });
  const keys = ["x"];
  const removing = chrome.storage.local.remove(keys);
  keys[0] = "y";
  await removing;
  equal("remove keeps the keys as they were when it was called",
    await chrome.storage.local.get(["x", "y"]), { y: 2 });

  const changes = [];
  chrome.storage.onChanged.addListener((change) => changes.push(change));
  const value = { n: 1 };
  await chrome.storage.local.set({ fresh: value, unset: undefined });
  value.n = 2;
  equal("a new key's change has no oldValue, and the value set",
    [Object.keys(changes[0].fresh), changes[0].fresh.newValue, changes[0].fresh.newValue === value],
    [["newValue"], { n: 1 }, false]);
  await chrome.storage.local.set({ fresh: 5 });
  equal("a key that had a value reports it", [changes[1].fresh.oldValue, changes[1].fresh.newValue], [{ n: 1 }, 5]);
  const cycle = {};
  cycle.self = cycle;
  equal("a value that cannot be stored fails the call",
    /storage quota exceeded/.test(await failure(chrome.storage.local.set({ cycle }))), true);
}

async function storageFailures() {
  const { chrome, page } = await boot();
  await chrome.storage.local.set({ seed: 1 });
  const records = page.indexedDB.databases.get("wex-storage").get("items");
  const put = records.set;
  const onDisk = () => Array.from(records.keys()).sort();

  // A failure of the transaction both changes went in.
  let fails = 1;
  records.set = function (key, value) {
    if (fails > 0) {
      fails -= 1;
      throw new Error("QuotaExceededError");
    }
    return put.call(this, key, value);
  };
  const outcome = (promise) => promise.then(() => "saved", (e) => e.message);
  equal("a passing failure saves both changes of a batch and says so",
    await Promise.all([outcome(chrome.storage.local.set({ a: "A" })), outcome(chrome.storage.local.set({ b: "B" }))]),
    ["saved", "saved"]);
  equal("and they are on disk", onDisk(), ["wex.local.a", "wex.local.b", "wex.local.seed"]);

  // A value that cannot be saved costs only its own call.
  records.set = function (key, value) {
    if (key === "wex.local.big") {
      throw new Error("QuotaExceededError");
    }
    return put.call(this, key, value);
  };
  equal("only the call whose value cannot be saved fails",
    await Promise.all([outcome(chrome.storage.local.set({ big: "too big" })), outcome(chrome.storage.local.set({ small: 1 }))]),
    ["storage quota exceeded: QuotaExceededError", "saved"]);
  equal("a later change is saved, and fails nothing", await outcome(chrome.storage.local.set({ later: 1 })), "saved");
  equal("and all that could be saved is on disk", onDisk(),
    ["wex.local.a", "wex.local.b", "wex.local.later", "wex.local.seed", "wex.local.small"]);
  records.set = put;
  equal("a key that failed saves once it can", await outcome(chrome.storage.local.set({ big: "smaller" })), "saved");
  equal("and is on disk", records.get("wex.local.big"), JSON.stringify("smaller"));
}

async function storageAdoption() {
  const records = new Map();
  const put = records.set;
  records.set = function (key, value) {
    if (key === "wex.local.big") {
      throw new Error("QuotaExceededError");
    }
    return put.call(this, key, value);
  };
  const { browser, chrome } = await boot({ before(b) {
    b.baseGlobals("global");
    b.settings.setItem("wex.installedVersion", "1");
    b.extensionDatabase.databases.set("wex-storage", new Map([["items", records]]));
    b.extensionStore.setItem("wex.local.big", JSON.stringify("too big"));
    b.extensionStore.setItem("wex.local.small", JSON.stringify("fits"));
  } });
  await settle();
  equal("values an earlier version kept in local storage move across",
    [await chrome.storage.local.get(["big", "small"]), records.get("wex.local.small")],
    [{ big: "too big", small: "fits" }, JSON.stringify("fits")]);
  equal("and only those that could be saved leave it",
    [browser.extensionStore.getItem("wex.local.big"), browser.extensionStore.getItem("wex.local.small")],
    [JSON.stringify("too big"), null]);
}

async function toolbar() {
  const { browser, win, tab, chrome, id } = await boot({ before(b) {
    b.toolbarItems[0].image = b.baseURI + "icon.png";
    b.toolbarItems[0].toolTip = "Declared";
  } });
  const item = browser.toolbarItems[0];
  const other = win.openTab("background");
  other.url = "https://two.example/";
  await settle();
  await chrome.action.setIcon({ tabId: id, path: "icons/on.png" });
  await chrome.action.setTitle({ tabId: id, title: "Tab A" });
  equal("a tab's icon and title show on it", [item.image, item.toolTip], [browser.baseURI + "icons/on.png", "Tab A"]);
  other.activate();
  await settle();
  equal("and another tab shows what the bundle declares", [item.image, item.toolTip],
    [browser.baseURI + "icon.png", "Declared"]);
  tab.activate();
  await settle();
  equal("the first tab shows its own again", [item.image, item.toolTip], [browser.baseURI + "icons/on.png", "Tab A"]);
  tab.navigate("https://example.com/next");
  await settle();
  equal("a tab that shows another document goes back to what the bundle declares", [item.image, item.toolTip],
    [browser.baseURI + "icon.png", "Declared"]);
  await chrome.action.setIcon({ path: "icons/all.png" });
  await chrome.action.setTitle({ title: "Every tab" });
  equal("what is set for every tab comes first", [item.image, item.toolTip],
    [browser.baseURI + "icons/all.png", "Every tab"]);
}

async function importScripts() {
  const { page } = await boot({ files: {
    "outer.js": "var outerStep = 1;\ntry { importScripts('optional.js'); } catch (e) { var caughtInner = e.message; }\nvar outerStep = 2;",
    "optional.js": "throw new Error('optional feature');",
    "broken-outer.js": "importScripts('optional.js');\nvar brokenFinished = true;"
  } });
  equal("an imported script that catches its own import's failure does not fail its import",
    (() => {
      try {
        page.importScripts("outer.js");
        return [page.outerStep, page.caughtInner];
      } catch (e) {
        return "threw: " + e.message;
      }
    })(), [2, "optional feature"]);
  equal("one that does not catch it fails",
    (() => {
      try {
        page.importScripts("broken-outer.js");
        return "nothing thrown";
      } catch (e) {
        return [e.message, page.brokenFinished === undefined];
      }
    })(), ["optional feature", true]);
}

async function optionsPage() {
  const { browser, win, chrome } = await boot();
  await chrome.runtime.openOptionsPage();
  await settle();
  const first = browser.activeBrowserWindow.activeTab;
  const count = win.tabs.length;
  await chrome.runtime.openOptionsPage();
  equal("an options page that is open is brought forward",
    [win.tabs.length, browser.activeBrowserWindow.activeTab === first], [count, true]);

  first.url = "https://elsewhere.example/";
  await settle();
  win.tabs[0].activate();
  await chrome.runtime.openOptionsPage();
  await settle();
  const active = browser.activeBrowserWindow.activeTab;
  equal("a tab that has gone elsewhere is not the options page",
    [win.tabs.length, active === first, active.url.split("/").pop()], [count + 1, false, "options.html"]);

  // One outside the extension's website access gives no address.
  const hidden = active;
  Object.defineProperty(hidden, "url", { get() { return undefined; }, set() {}, configurable: true });
  win.tabs[0].activate();
  await chrome.runtime.openOptionsPage();
  await settle();
  equal("nor is one that has gone where Safari gives no address",
    [win.tabs.length, browser.activeBrowserWindow.activeTab === hidden], [count + 2, false]);
}

async function panelOptions() {
  const { browser, win, chrome, id } = await boot();
  const other = win.openTab("background");
  other.url = "https://two.example/";
  await settle();
  const otherId = (await chrome.tabs.query({ url: "https://two.example/*" }))[0].id;
  await chrome.sidePanel.open({ tabId: id });
  const panel = browser.popovers.find((p) => p.identifier === "wex-sidepanel");
  await chrome.sidePanel.setOptions({ tabId: otherId, enabled: false });
  equal("disabling another tab's panel leaves the one on show", panel.visible, true);
  const closes = [];
  chrome.sidePanel.onClosed.addListener((info) => closes.push(info.path));

  const replaced = [];
  panel.contentWindow = { location: { href: browser.baseURI + "panel.html", replace: (url) => replaced.push(url) } };
  await chrome.sidePanel.setOptions({ tabId: otherId, path: "elsewhere.html" });
  equal("another tab's new page leaves the panel on show as it is", replaced, []);
  await chrome.sidePanel.setOptions({ path: "other.html" });
  equal("the panel on show goes to its new page",
    [panel.contentURL, replaced, panel.visible],
    [browser.baseURI + "other.html", [browser.baseURI + "other.html"], true]);
  equal("which the contexts list says",
    (await chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] })).map((c) => c.documentUrl),
    [browser.baseURI + "other.html"]);
  await chrome.sidePanel.setOptions({ path: "other.html" });
  equal("the same page again does not reload it", replaced.length, 1);

  await chrome.sidePanel.setOptions({ tabId: id, enabled: false });
  equal("disabling the panel of the tab it shows over closes it", panel.visible, false);
  await settle(450);
  equal("and it reports the page it had", closes, ["other.html"]);
}

// A side panel named for its tab in its query opens for whichever tab the
// button was clicked in.
async function panelPerTab() {
  const { browser, win, chrome, id } = await boot();
  const other = win.openTab("background");
  other.url = "https://two.example/";
  await settle();
  const otherId = (await chrome.tabs.query({ url: "https://two.example/*" }))[0].id;
  const panelPath = (tabId) => "panel.html?tabId=" + tabId;
  await chrome.sidePanel.setOptions({ tabId: id, path: panelPath(id), enabled: true });
  await chrome.sidePanel.open({ tabId: id });
  const panel = browser.popovers.find((p) => p.identifier === "wex-sidepanel");
  const replaced = [];
  const page = { location: { href: browser.baseURI + panelPath(id), replace(url) { replaced.push(url); this.href = url; } } };
  panel.contentWindow = page;
  browser.application.fire("popover", { target: panel, __stopped: false }, true);
  panel.hide();
  await settle(450);
  equal("a panel already on its tab's page is left as it is", replaced, []);

  page.location.href = browser.baseURI + panelPath(id) + "&view=chat";
  browser.application.fire("popover", { target: panel, __stopped: false }, true);
  panel.hide();
  await settle(450);
  equal("even after the panel adds to its own query", replaced, []);

  other.activate();
  await settle();
  await chrome.sidePanel.setOptions({ tabId: otherId, path: panelPath(otherId), enabled: true });
  await chrome.sidePanel.open({ tabId: otherId });
  browser.application.fire("popover", { target: panel, __stopped: false }, true);
  equal("the panel opened for another tab shows that tab's page",
    [replaced, page.location.href], [[browser.baseURI + panelPath(otherId)], browser.baseURI + panelPath(otherId)]);
}

async function popover() {
  const { browser, chrome, id } = await boot({
    browser: { popup: false },
    config(c) {
      c.popupPage = null;
      delete c.manifest.action.default_popup;
    }
  });
  const item = browser.toolbarItems[0];
  await chrome.sidePanel.open({ tabId: id });
  await settle(5);
  browser.popovers.forEach((p) => p.hide && p.hide());
  await settle(450);
  equal("the side panel's popover is the only one", browser.popovers.map((p) => p.identifier), ["wex-sidepanel"]);
  await chrome.action.setPopup({ popup: "popup.html" });
  await settle();
  equal("a popup set later has a popover of its own",
    [item.popover && item.popover.identifier, browser.popovers.map((p) => p.identifier).sort()],
    ["wex-popover", ["wex-popover", "wex-sidepanel"]]);
}

async function pendingUrls() {
  const { win, chrome } = await boot();
  const blank = await chrome.tabs.create({ url: "about:blank" });
  await settle(40);
  const shown = await chrome.tabs.get(blank.id);
  equal("a blank page has nothing to load", [shown.url, shown.status, shown.pendingUrl === undefined],
    ["about:blank", "complete", true]);

  // A tab outside the extension's website access gives no address.
  const tab = win.openTab("background");
  await settle();
  const describe = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(tab), "url");
  let hidden = false;
  Object.defineProperty(tab, "url", {
    configurable: true,
    get() { return hidden ? undefined : describe.get.call(tab); },
    set(value) { describe.set.call(tab, value); hidden = true; }
  });
  await chrome.tabs.update(tab.engineId, { url: "https://nopermission.example/a" });
  await settle();
  const going = await chrome.tabs.get(tab.engineId);
  equal("a tab being sent where Safari hides the address is described by it",
    [going.url, going.status], ["https://nopermission.example/a", "loading"]);
  tab.navigate("https://nopermission.example/a");
  await settle();
  const there = await chrome.tabs.get(tab.engineId);
  equal("and stops being so once it has loaded", [there.url, there.status, there.pendingUrl === undefined],
    ["", "complete", true]);

  // A tab on its way to an extension's page goes through a blank page.
  const page = await chrome.tabs.create({ url: "options.html" });
  await settle();
  equal("a tab sent to an extension's page arrives",
    (await chrome.tabs.get(page.id)).url.split("/").pop(), "options.html");
}

async function keys() {
  const aqua = fakeAqua();
  const { chrome, id } = await boot({ aqua });
  const target = { tabId: id };
  await chrome.debugger.attach(target, "1.3");
  const send = (p) => chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", p);
  const last = () => aqua.calls[aqua.calls.length - 1][1];

  await send({ type: "rawKeyDown", code: "Space", key: " ", windowsVirtualKeyCode: 32 });
  equal("a raw key down of Space types nothing", [last().characters, last().charactersIgnoringModifiers], ["", " "]);
  await send({ type: "char", text: " " });
  equal("and the char after it types the space", last(), " ");
  await send({ type: "rawKeyDown", code: "Enter", key: "Enter", windowsVirtualKeyCode: 13 });
  equal("a raw key down of Enter types nothing, and is still that key",
    [last().characters, last().charactersIgnoringModifiers, last().keyCode], ["", "\r", 36]);
  await send({ type: "keyDown", code: "Enter", key: "Enter", text: "\r" });
  equal("a key down of Enter types", last().characters, "\r");
  await send({ type: "rawKeyDown", code: "Tab", key: "Tab" });
  equal("a raw key down of Tab keeps its character, which moves the focus as Chrome's does", last().characters, "\t");
  await send({ type: "rawKeyDown", code: "ArrowLeft", key: "ArrowLeft" });
  equal("as an arrow key keeps its", last().characters, "");
}

async function provisionalPanel() {
  const { win, tab, chrome, id } = await boot();
  const pageless = win.openTab("background", undefined, { pageless: true });
  await settle();
  const provisional = (await chrome.tabs.query({})).find((t) => t.id >= PROVISIONAL).id;
  await chrome.sidePanel.setOptions({ tabId: provisional, path: "tab.html" });
  pageless.url = "https://shown.example/";
  pageless.showPage();
  await settle(60);
  const shown = (await chrome.tabs.query({ url: "https://shown.example/*" }))[0].id;
  equal("a tab's panel goes with it once it shows a page",
    (await chrome.sidePanel.getOptions({ tabId: shown })).path, "tab.html");

  await chrome.sidePanel.setOptions({ tabId: id, path: "swapped.html" });
  tab.replacePage();
  await settle(60);
  equal("and when WebKit swaps in another page for the tab",
    (await chrome.sidePanel.getOptions({ tabId: tab.engineId })).path, "swapped.html");
}

async function debuggerAcrossSwap() {
  const aqua = fakeAqua();
  const { browser, tab, chrome, id } = await boot({ aqua });
  const target = { tabId: id };
  const detached = [];
  const events = [];
  chrome.debugger.onDetach.addListener((source, reason) => detached.push([source.tabId, reason]));
  chrome.debugger.onEvent.addListener((source, method) => events.push([source.tabId, method]));
  await chrome.debugger.attach(target, "1.3");
  await chrome.debugger.sendCommand(target, "Network.enable");
  await chrome.debugger.sendCommand(target, "Runtime.enable");
  const targetId = (await chrome.debugger.getTargets()).find((t) => t.tabId === id).id;

  tab.replacePage();
  await settle(60);
  const swapped = tab.engineId;
  equal("a page swapped in for the tab's detaches nothing", detached, []);
  equal("and the backend is attached to the new page",
    aqua.calls.filter((c) => c[0] === "attach").map((c) => c[1]), [id, swapped]);
  equal("a command reaches it by the tab's new id",
    await chrome.debugger.sendCommand({ tabId: swapped }, "Runtime.evaluate", { expression: "1 + 1" }),
    { result: { type: "number", value: 2, description: "2" } });
  equal("and by the id the extension attached with",
    await chrome.debugger.sendCommand(target, "Runtime.evaluate", { expression: "1 + 1" }),
    { result: { type: "number", value: 2, description: "2" } });
  const entry = (await chrome.debugger.getTargets()).find((t) => t.tabId === swapped);
  equal("the target keeps its id, and is attached", [entry.id, entry.attached], [targetId, true]);

  events.length = 0;
  await browser.engine.request({ url: "https://swapped.example/a", type: "image", tabId: swapped });
  await settle();
  equal("its requests are reported, under the id the extension attached with",
    events.filter((e) => e[1] === "Network.requestWillBeSent"), [[id, "Network.requestWillBeSent"]]);

  equal("attaching again is refused, as it is attached",
    /already attached/.test(await failure(chrome.debugger.attach(target, "1.3"))), true);
  tab.close();
  await settle(60);
  equal("closing the tab detaches it, by the id the extension attached with", detached, [[id, "target_closed"]]);
  equal("and leaves nothing attached",
    /No tab with given id/.test(await failure(chrome.debugger.sendCommand(target, "Runtime.evaluate", { expression: "1" }))), true);
}

async function debuggerTargetGone() {
  const aqua = fakeAqua("Runtime.evaluate");
  const { chrome, id } = await boot({ aqua });
  const target = { tabId: id };
  await chrome.debugger.attach(target, "1.3");
  let outcome = "pending";
  chrome.debugger.sendCommand(target, "Runtime.evaluate", { expression: "1" })
    .then(() => { outcome = "answered"; }, (e) => { outcome = JSON.parse(e.message).message; });
  await settle(30);
  aqua.toInspector(id, { method: "Target.targetCreated",
    params: { targetInfo: { targetId: "page-2", type: "page", isProvisional: true } } });
  aqua.toInspector(id, { method: "Target.didCommitProvisionalTarget", params: { oldTargetId: "page-1", newTargetId: "page-2" } });
  await settle();
  equal("a command waits while its target is there", outcome, "pending");
  aqua.toInspector(id, { method: "Target.targetDestroyed", params: { targetId: "page-1" } });
  await settle();
  equal("and fails once it has gone", outcome, "Inspected target navigated or closed");
}

async function debuggerTargets() {
  const aqua = fakeAqua();
  const { win, chrome } = await boot({ aqua });
  const opened = win.openTab("background");
  opened.url = "https://new.example/";
  const targets = await chrome.debugger.getTargets();
  const entry = targets.find((t) => t.url === "https://new.example/");
  equal("a tab that has only just opened is listed by its id",
    [entry && entry.tabId, new Set(targets.map((t) => t.id)).size === targets.length], [opened.engineId, true]);
  let called = null;
  chrome.debugger.getTargets((list) => { called = list.length; });
  await settle();
  equal("the callback form hears the same", called, targets.length);
}

process.on("unhandledRejection", (reason) => {
  failures.push("unhandled rejection: " + (reason && reason.message || reason));
});

async function main() {
  const groups = [webNavigation, storage, storageFailures, storageAdoption, toolbar, importScripts, optionsPage, panelOptions,
    panelPerTab, popover, pendingUrls, keys, provisionalPanel, debuggerAcrossSwap, debuggerTargetGone, debuggerTargets];
  for (const group of groups) {
    try {
      await group();
    } catch (e) {
      failures.push(group.name + " threw: " + (e && e.stack || e));
    }
  }
  console.log(passed + " checks passed, " + failures.length + " failed");
  for (const failure of failures) {
    console.log("  FAIL  " + failure);
  }
  process.exit(failures.length ? 1 : 0);
}

main();
