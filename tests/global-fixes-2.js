// The global page's saving of files, tab groups, moving and describing tabs,
// alarms, actions and worker messages, in a simulated Safari.
// node tests/global-fixes-2.js
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { FakeBrowser } = require("./fake-safari");

const RUNTIME = path.join(__dirname, "..", "webext2safari", "runtime");
const BUNDLE_ID = "com.example.test-TEAM123";

let passed = 0;
const failures = [];
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms || 30));
const outcome = (promise) => promise.then(() => "resolved", (e) => e.message);

function equal(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    passed += 1;
  } else {
    failures.push(name + ": got " + a + ", expected " + b);
  }
}

// A named group of checks, each with a browser of its own. One that hangs or
// throws costs only itself.
const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function fixture(change, schema) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wex-global-fixes-2-"));
  fs.cpSync(RUNTIME, path.join(dir, "wex"), { recursive: true });
  const api = schema ? "var WEX_API = " + fs.readFileSync(path.join(RUNTIME, "chrome-api.json"), "utf8") + ";\n" :
    "var WEX_API = null;\n";
  fs.writeFileSync(path.join(dir, "wex", "wex-api.js"), api);
  fs.writeFileSync(path.join(dir, "wex", "wex-content-api.js"), "var WEX_API = null;\n");
  const config = {
    extensionId: "com.example.test",
    name: "Fixture",
    version: "1",
    manifest: {
      manifest_version: 3, name: "Fixture", version: "1",
      action: { default_popup: "popup.html" },
      permissions: ["tabs", "storage", "tabGroups", "alarms", "downloads", "management", "offscreen", "<all_urls>"]
    },
    storage: "local",
    popupPage: "popup.html",
    optionsPage: "options.html",
    popoverId: "wex-popover",
    toolbarId: "wex-toolbar",
    actionCommand: "wex-action",
    backgroundPage: "wex-global-page.html",
    backgroundWorker: true,
    bridgeWhitelist: ["http://*/*", "https://*/*"],
    contentScripts: []
  };
  if (change) {
    change(config);
  }
  fs.writeFileSync(path.join(dir, "wex", "wex-config.js"), "var WEX_CONFIG = " + JSON.stringify(config) + ";\n");
  fs.writeFileSync(path.join(dir, "wex", "wex-bridge.js"), ["wex-config.js", "wex-content-api.js", "wex-core.js", "wex-content.js"]
    .map((name) => fs.readFileSync(path.join(dir, "wex", name), "utf8")).join("\n;\n"));
  return dir;
}

const globalFiles = (dir) => ["wex-config.js", "wex-api.js", "wex-core.js", "wex-global.js"]
  .map((name) => path.join(dir, "wex", name));

async function start(change, schema, prepare) {
  const dir = fixture(change, schema);
  const browser = new FakeBrowser(dir, { bundleId: BUNDLE_ID });
  if (prepare) {
    prepare(browser);
  }
  const win = browser.openWindow();
  const first = win.openTab();
  first.url = "https://first.example/";
  win.activeTab = first;
  await settle();
  const page = browser.createGlobalPage(globalFiles(dir));
  await settle();
  return { dir, browser, win, first, page, chrome: page.chrome };
}

// Opens background tabs on each host, and answers the extension's id for each.
async function open(h, win, hosts) {
  const ids = {};
  const made = {};
  for (const host of hosts) {
    made[host] = win.openTab("background");
    made[host].url = "https://" + host + ".example/";
    await settle(5);
  }
  await settle(20);
  for (const host of hosts) {
    ids[host] = (await h.chrome.tabs.query({ url: "https://" + host + ".example/*" }))[0].id;
  }
  return { ids, made };
}

const order = (win) => win.tabs.map((t) => (/\/\/(\w+)\./.exec(t.url) || [null, "_"])[1]).join(" ");
const shownWindow = (browser) => browser.browserWindows.filter((w) => w.visible !== false);

// -- saving a file --------------------------------------------------------
// Records every save port opened from a context, and each one a web page's
// bridge is offered.
function watchSavePorts(native) {
  const seen = [];
  const connect = native.tabs.connect;
  native.tabs.connect = function (tabId, info) {
    if (info && /save$/.test(String(info.name))) {
      seen.push(tabId);
    }
    return connect.apply(this, arguments);
  };
  return seen;
}

function bridgeFrame(h, tab) {
  return h.browser.createContentFrame(tab, ["wex-config.js", "wex-content-api.js", "wex-core.js", "wex-content.js"]
    .map((name) => path.join(h.dir, "wex", name)));
}

async function downloaded(chrome, id) {
  for (let i = 0; i < 100; i++) {
    const item = (await chrome.downloads.search({ id }))[0];
    if (item && item.state !== "in_progress") {
      return item;
    }
    await settle(10);
  }
  return null;
}

test("a download saves from a page's bridge through a link outside the document", async () => {
  const h = await start();
  const frame = bridgeFrame(h, h.first);
  await settle();
  const links = [];
  const makeElement = frame.sandbox.document.createElement;
  frame.sandbox.document.createElement = function (tag) {
    const element = makeElement.call(this, tag);
    if (String(tag).toLowerCase() === "a") {
      links.push(element);
    }
    return element;
  };
  const ports = watchSavePorts(h.chrome.__wexNative);
  const tabsBefore = h.browser.browserWindows.reduce((n, w) => n + w.tabs.length, 0);
  const id = await h.chrome.downloads.download({ url: "data:text/plain,secret", filename: "secret.txt" });
  const item = await downloaded(h.chrome, id);
  await settle(50);
  equal("it completes, saved by the bridge",
    [item && item.state, h.browser.savedDownloads.map((d) => [d.filename, d.text, d.via])],
    ["complete", [["secret.txt", "secret", "content"]]]);
  equal("in the active tab's top frame, through a link that never joins the document, opening no tab",
    [ports.length, links.length, !!links[0].parentNode, h.browser.browserWindows.reduce((n, w) => n + w.tabs.length, 0)],
    [1, 1, false, tabsBefore]);
});

test("a page's bridge that cannot save leaves the file to the runtime's page", async () => {
  const h = await start();
  const frame = bridgeFrame(h, h.first);
  await settle();
  frame.sandbox.origin = "null";
  const id = await h.chrome.downloads.download({ url: "data:text/plain,sandboxed", filename: "sandboxed.txt" });
  const item = await downloaded(h.chrome, id);
  await settle(50);
  equal("it completes through the runtime's page",
    [item && item.state, h.browser.savedDownloads.map((d) => [d.filename, d.text, d.via])],
    ["complete", [["sandboxed.txt", "sandboxed", undefined]]]);
});

test("a download saves with no window open", async () => {
  const h = await start();
  h.browser.browserWindows.slice().forEach((w) => {
    w.tabs.slice().forEach((t) => t.close());
    w.close();
  });
  await settle();
  const id = await h.chrome.downloads.download({ url: "data:text/plain,alone", filename: "alone.txt" });
  const item = await downloaded(h.chrome, id);
  await settle(50);
  equal("it completes", [item && item.state, h.browser.savedDownloads.map((d) => [d.filename, d.text])],
    ["complete", [["alone.txt", "alone"]]]);
  equal("and the window opened for it closes", shownWindow(h.browser).length, 0);
});

test("a page's bridge that does not answer leaves the file to the runtime's page", async () => {
  const h = await start();
  bridgeFrame(h, h.first);
  await settle();
  const native = h.chrome.__wexNative;
  const connect = native.tabs.connect;
  native.tabs.connect = function (tabId, info) {
    if (info && /save$/.test(String(info.name))) {
      const silent = { addListener() {} };
      return { onMessage: silent, onDisconnect: silent, postMessage() {}, disconnect() {} };
    }
    return connect.apply(this, arguments);
  };
  const id = await h.chrome.downloads.download({ url: "data:text/plain,silent", filename: "silent.txt" });
  let item = null;
  for (let i = 0; i < 80 && !(item && item.state !== "in_progress"); i++) {
    await settle(100);
    item = (await h.chrome.downloads.search({ id }))[0];
  }
  await settle(50);
  equal("it completes through the runtime's page",
    [item && item.state, h.browser.savedDownloads.map((d) => [d.filename, d.text, d.via])],
    ["complete", [["silent.txt", "silent", undefined]]]);
});

// -- a site's links to the extension's address ------------------------------
const SITE_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

async function siteFrame(navigation) {
  const h = await start((c) => {
    c.webOrigin = SITE_ORIGIN;
    c.manifest.web_accessible_resources = ["public.html"];
  });
  const frame = h.browser.createContentFrame(h.first, []);
  frame.sandbox.navigation = navigation;
  ["wex-config.js", "wex-content-api.js", "wex-core.js", "wex-content.js"].forEach((name) => {
    vm.runInContext(fs.readFileSync(path.join(h.dir, "wex", name), "utf8"), frame.context.vmContext);
  });
  await settle();
  return { h, frame };
}

function clickOn(document, href, target, isTrusted) {
  const event = {
    type: "click", button: 0, isTrusted, prevented: false,
    target: { closest: () => ({ href, getAttribute: () => target, hasAttribute: () => false }) },
    preventDefault() {
      this.prevented = true;
    }
  };
  document.dispatchEvent(event);
  return event;
}

const openTabs = (browser) => [].concat(...shownWindow(browser).map((w) => w.tabs.map((t) => String(t.url))));

test("a site's link that opens a new tab goes by the manifest", async () => {
  const { h, frame } = await siteFrame(undefined);
  const before = openTabs(h.browser).length;
  const refused = clickOn(frame.sandbox.document, SITE_ORIGIN + "/secret.html", "_blank", true);
  await settle(50);
  equal("one the manifest does not give it is cancelled and opens nothing",
    [refused.prevented, openTabs(h.browser).length], [true, before]);
  const scripted = clickOn(frame.sandbox.document, SITE_ORIGIN + "/public.html", "_blank", false);
  await settle(50);
  equal("a scripted click on a listed one is cancelled and opens nothing",
    [scripted.prevented, openTabs(h.browser).length], [true, before]);
  const opened = clickOn(frame.sandbox.document, SITE_ORIGIN + "/public.html?a=1", "_blank", true);
  await settle(100);
  equal("a click on a listed one opens it in a new tab",
    [opened.prevented, openTabs(h.browser).length, openTabs(h.browser).includes(h.browser.baseURI + "public.html?a=1")],
    [true, before + 1, true]);
  const web = clickOn(frame.sandbox.document, "https://elsewhere.example/", "_blank", true);
  equal("a link elsewhere is left to the browser", web.prevented, false);
});

test("a site's link in the same tab goes by the manifest", async () => {
  const { h, frame } = await siteFrame(undefined);
  const sent = [];
  frame.sandbox.location.replace = (url) => sent.push(url);
  const before = openTabs(h.browser).length;
  const refused = clickOn(frame.sandbox.document, SITE_ORIGIN + "/secret.html", "", true);
  equal("one the manifest does not give it is cancelled and goes nowhere", [refused.prevented, sent], [true, []]);
  const listed = clickOn(frame.sandbox.document, SITE_ORIGIN + "/public.html?a=1", "", true);
  await settle(50);
  equal("a listed one is cancelled, and the frame goes to the page, in the same tab",
    [listed.prevented, sent, openTabs(h.browser).length], [true, [h.browser.baseURI + "public.html?a=1"], before]);
});

test("a site's navigation to a page it may not open is cancelled", async () => {
  let navigate = null;
  await siteFrame({ addEventListener: (name, fn) => {
    if (name === "navigate") {
      navigate = fn;
    }
  } });
  const event = (url) => ({
    destination: { url }, cancelable: true, prevented: false,
    preventDefault() {
      this.prevented = true;
    }
  });
  const refused = event(SITE_ORIGIN + "/secret.html");
  navigate(refused);
  const web = event("https://elsewhere.example/");
  navigate(web);
  equal("one to the extension's address is, and one elsewhere is left alone",
    [refused.prevented, web.prevented], [true, false]);
});

test("an extension page's link to the extension's address goes to the page it names", async () => {
  const h = await start((c) => {
    c.webOrigin = SITE_ORIGIN;
  });
  const popup = h.browser.createExtensionPage(["wex-config.js", "wex-api.js", "wex-core.js", "wex-page.js"]
    .map((name) => path.join(h.dir, "wex", name)), h.browser.baseURI + "popup.html");
  await settle();
  const before = openTabs(h.browser).length;
  const opened = clickOn(popup.document, SITE_ORIGIN + "/options.html?a=1", "_blank", true);
  await settle(100);
  equal("one with a target opens a tab",
    [opened.prevented, openTabs(h.browser).length, openTabs(h.browser).includes(h.browser.baseURI + "options.html?a=1")],
    [true, before + 1, true]);
  const web = clickOn(popup.document, "https://elsewhere.example/", "", true);
  equal("and a link elsewhere is left alone by this", web.prevented, false);
});

test("an extension page with no usable object URLs saves through the global page", async () => {
  const h = await start();
  const frame = bridgeFrame(h, h.first);
  await settle();
  const popup = h.browser.createExtensionPage(["wex-config.js", "wex-api.js", "wex-core.js", "wex-page.js"]
    .map((name) => path.join(h.dir, "wex", name)), h.browser.baseURI + "popup.html");
  await settle();
  const ports = watchSavePorts(popup.chrome.__wexNative);
  const root = await popup.navigator.storage.getDirectory();
  const handle = await root.getFileHandle("page.bin", { create: true });
  const writable = await handle.createWritable();
  await writable.write(new Uint8Array([104, 105]));
  await writable.close();
  const result = await Promise.race([handle.download("from-popup.txt"), settle(2000).then(() => "still waiting")]);
  await settle(50);
  equal("the file is saved under its name", [result, h.browser.savedDownloads.map((d) => [d.filename, d.text, d.via])],
    [true, [["from-popup.txt", "hi", "content"]]]);
  equal("with no port from the extension page to a tab", ports, []);
});

test("a popover hands a file to the global page though its object URLs load", async () => {
  const h = await start();
  bridgeFrame(h, h.first);
  await settle();
  const popup = h.browser.createExtensionPage(["wex-config.js", "wex-api.js", "wex-core.js", "wex-page.js"]
    .map((name) => path.join(h.dir, "wex", name)), h.browser.baseURI + "popup.html");
  await settle();
  popup.URL = Object.assign(function (url, base) {
    return new URL(url, base);
  }, { createObjectURL: () => "blob:usable", revokeObjectURL: () => {} });
  popup.XMLHttpRequest = function () {
    this.open = () => {};
    this.send = () => {
      this.responseText = "x";
      this.onload();
    };
  };
  const links = [];
  const makeElement = popup.document.createElement;
  popup.document.createElement = function (tag) {
    links.push(String(tag).toLowerCase());
    return makeElement.call(this, tag);
  };
  const root = await popup.navigator.storage.getDirectory();
  const handle = await root.getFileHandle("popover.bin", { create: true });
  const writable = await handle.createWritable();
  await writable.write(new Uint8Array([104, 105]));
  await writable.close();
  const result = await Promise.race([handle.download("from-popover.txt"), settle(2000).then(() => "still waiting")]);
  await settle(50);
  equal("the file is saved, and the popover makes no link", [result, links.indexOf("a"),
    h.browser.savedDownloads.map((d) => [d.filename, d.text])], [true, -1, [["from-popover.txt", "hi"]]]);
});

test("a web page cannot save through the global page's port", async () => {
  const h = await start();
  const frame = bridgeFrame(h, h.first);
  await settle();
  const port = frame.sandbox.WEX.native.runtime.connect({ name: frame.sandbox.WEX.INTERNAL_PORT + "save" });
  let disconnected = false;
  port.onDisconnect.addListener(() => {
    disconnected = true;
  });
  port.postMessage({ begin: { filename: "evil.exe", type: "text/plain", total: 1 } });
  port.postMessage({ chunk: { index: 0, data: Buffer.from("evil").toString("base64") } });
  port.postMessage({ end: true });
  await settle(100);
  equal("the port is refused and nothing is saved", [disconnected, h.browser.savedDownloads.length], [true, 0]);
});

// -- callbacks in a build whose calls are checked ---------------------------
test("action.openPopup and offscreen take their callbacks", async () => {
  const h = await start((c) => { c.popupWidth = 400; }, true);
  const called = [];
  h.chrome.action.openPopup(() => called.push("openPopup(cb)"));
  h.chrome.action.openPopup({}, () => called.push("openPopup({}, cb)"));
  h.chrome.offscreen.hasDocument((has) => called.push("hasDocument " + has));
  await settle(50);
  equal("each callback runs", called.sort(), ["hasDocument false", "openPopup(cb)", "openPopup({}, cb)"]);
  const failed = await new Promise((resolve) => {
    h.chrome.offscreen.closeDocument(() => resolve(h.chrome.runtime.lastError && h.chrome.runtime.lastError.message));
    setTimeout(() => resolve("no callback"), 200);
  });
  equal("a failure reaches the callback as lastError", failed, "No current offscreen document.");
  const made = await new Promise((resolve) => {
    h.chrome.offscreen.createDocument({ url: "missing.html", reasons: ["DOM_PARSER"], justification: "x" },
      () => resolve(h.chrome.runtime.lastError && h.chrome.runtime.lastError.message));
    setTimeout(() => resolve("no callback"), 200);
  });
  equal("createDocument reports through its callback too", made, "Page failed to load.");
});

// -- moving and activating tabs ----------------------------------------------
test("tabs.move puts a tab where it was asked, forward and back", async () => {
  const h = await start();
  const { ids } = await open(h, h.win, ["a", "b", "c"]);
  const moved = [];
  h.chrome.tabs.onMoved.addListener((id, info) => moved.push([id, info.fromIndex, info.toIndex]));
  await h.chrome.tabs.move(ids.a, { index: 3 });
  await settle();
  equal("forward", order(h.win), "first b c a");
  await h.chrome.tabs.move(ids.a, { index: 1 });
  await settle();
  equal("and back", order(h.win), "first a b c");
  equal("each told once", moved, [[ids.a, 1, 3], [ids.a, 3, 1]]);
});

test("a tab dragged by hand is told of as moved", async () => {
  const h = await start();
  const { ids, made } = await open(h, h.win, ["a", "b", "c"]);
  const moved = [];
  h.chrome.tabs.onMoved.addListener((id, info) => moved.push([id, info.fromIndex, info.toIndex]));
  h.win.insertTab(made.a, h.win.tabs.length);
  await settle(1100);
  equal("once, by the tab that moved", moved, [[ids.a, 1, 3]]);
});

test("a new tab is told of as created before it is told of as active", async () => {
  const h = await start();
  const heard = [];
  h.chrome.tabs.onCreated.addListener((t) => heard.push(["created", t.id]));
  h.chrome.tabs.onActivated.addListener((i) => heard.push(["activated", i.tabId]));
  // Safari activates the tab as it opens it, before the engine reports it.
  const tab = h.win.openTab("foreground");
  tab.url = "https://new.example/";
  h.browser.application.fire("activate", { target: tab, __stopped: false }, true);
  await settle(50);
  const id = (await h.chrome.tabs.query({ url: "https://new.example/*" }))[0].id;
  equal("in that order", heard.filter((e) => e[1] === id).map((e) => e[0]), ["created", "activated"]);
});

test("goBack and goForward use the engine's calls where it has them", async () => {
  const h = await start();
  const { ids } = await open(h, h.win, ["a"]);
  const calls = [];
  const engine = h.page.WEX.native.tabs;
  engine.goBack = (id) => {
    calls.push(["back", id]);
    return Promise.resolve();
  };
  engine.goForward = (id) => {
    calls.push(["forward", id]);
    return Promise.resolve();
  };
  await h.chrome.tabs.goBack(ids.a);
  await h.chrome.tabs.goForward(ids.a);
  equal("both", calls, [["back", ids.a], ["forward", ids.a]]);
});

// -- tab groups --------------------------------------------------------------
test("kept groups do not claim another tab after a browser restart", async () => {
  const h = await start();
  const { ids } = await open(h, h.win, ["grouped"]);
  const groupId = await h.chrome.tabs.group({ tabIds: [ids.grouped] });
  await settle();
  // A restart: the settings stay, and the engine counts its ids from the start.
  const next = new FakeBrowser(h.dir, { bundleId: BUNDLE_ID });
  next.settings = h.browser.settings;
  const win = next.openWindow();
  const one = win.openTab();
  one.url = "https://one.example/";
  win.activeTab = one;
  const two = win.openTab("background");
  two.url = "https://two.example/";
  await settle();
  const page = next.createGlobalPage(globalFiles(h.dir));
  const chrome = page.chrome;
  const tabs = await chrome.tabs.query({});
  page.WEX.finishKeptGroups();
  equal("the new tab with the id is in no group",
    [tabs.map((t) => t.id).indexOf(ids.grouped) >= 0, tabs.map((t) => t.groupId)], [true, [-1, -1]]);
  equal("and the group is gone", [await chrome.tabGroups.query({}),
    await outcome(chrome.tabGroups.get(groupId))], [[], "No group with id: " + groupId + "."]);
});

test("kept groups find their tabs by address after a browser restart", async () => {
  const h = await start();
  const { ids, made } = await open(h, h.win, ["first", "second", "plain"]);
  const groupId = await h.chrome.tabs.group({ tabIds: [ids.first, ids.second] });
  await h.chrome.tabGroups.update(groupId, { title: "kept", collapsed: true });
  await settle();
  const next = new FakeBrowser(h.dir, { bundleId: BUNDLE_ID });
  next.settings = h.browser.settings;
  const win = next.openWindow();
  const other = win.openTab();
  other.url = "https://other.example/";
  win.activeTab = other;
  const restored = [made.plain.url, made.second.url, made.first.url].map((url) => {
    const t = win.openTab("background");
    t.url = url;
    return t;
  });
  await settle();
  const chrome = next.createGlobalPage(globalFiles(h.dir)).chrome;
  await settle();
  const tabs = await chrome.tabs.query({});
  const inGroup = tabs.filter((t) => t.groupId === groupId).map((t) => t.url).sort();
  equal("the tabs at the kept addresses are in the group",
    inGroup, [made.first.url, made.second.url].sort());
  equal("the group keeps its title and state",
    [(await chrome.tabGroups.get(groupId)).title, (await chrome.tabGroups.get(groupId)).collapsed], ["kept", true]);
  equal("and the tab at another address is in none",
    tabs.filter((t) => t.url === restored[0].url).map((t) => t.groupId), [-1]);
});

test("kept groups wait for tabs restored after the global page starts", async () => {
  const h = await start();
  const { ids, made } = await open(h, h.win, ["late"]);
  const groupId = await h.chrome.tabs.group({ tabIds: [ids.late] });
  await settle();
  const next = new FakeBrowser(h.dir, { bundleId: BUNDLE_ID });
  next.settings = h.browser.settings;
  const win = next.openWindow();
  const first = win.openTab();
  first.url = "https://other.example/";
  win.activeTab = first;
  await settle();
  const chrome = next.createGlobalPage(globalFiles(h.dir)).chrome;
  await settle();
  equal("the group waits", (await chrome.tabGroups.get(groupId)).id, groupId);
  const late = win.openTab("background");
  late.url = made.late.url;
  await new Promise((resolve) => setTimeout(resolve, 700));
  const tabs = await chrome.tabs.query({});
  equal("and takes the tab when it arrives", tabs.filter((t) => t.url === made.late.url).map((t) => t.groupId), [groupId]);
});

test("kept groups outlast the global page", async () => {
  const h = await start();
  const { ids, made } = await open(h, h.win, ["stays", "moves"]);
  const groupId = await h.chrome.tabs.group({ tabIds: [ids.stays, ids.moves] });
  // A grouped tab goes to another address, which is kept with its group.
  made.moves.navigate("https://moved.example/");
  h.browser.engine.emitHost("tabs.onUpdated", ids.moves, { status: "complete" },
    h.browser.engine.describeTab(made.moves));
  await settle();
  const chrome = h.browser.createGlobalPage(globalFiles(h.dir)).chrome;
  equal("its tabs are in it after a reload",
    [(await chrome.tabs.get(ids.stays)).groupId, (await chrome.tabs.get(ids.moves)).groupId], [groupId, groupId]);
});

test("a collapsed group stays in its window, and comes back to its place", async () => {
  const h = await start();
  const { ids } = await open(h, h.win, ["a", "b", "c"]);
  const groupId = await h.chrome.tabs.group({ tabIds: [ids.a, ids.b] });
  const windowId = (await h.chrome.tabs.get(ids.a)).windowId;
  const startOrder = order(h.win);
  await h.chrome.tabGroups.update(groupId, { collapsed: true });
  await settle();
  equal("the group and its tabs report the window",
    [(await h.chrome.tabGroups.get(groupId)).windowId, (await h.chrome.tabs.get(ids.a)).windowId,
      (await h.chrome.tabs.get(ids.a)).active],
    [windowId, windowId, false]);
  equal("queries by window find them",
    [(await h.chrome.tabGroups.query({ windowId })).map((g) => g.id),
      (await h.chrome.tabs.query({ windowId })).map((t) => t.id).indexOf(ids.b) >= 0,
      (await h.chrome.windows.get(windowId, { populate: true })).tabs.map((t) => t.id).indexOf(ids.b) >= 0],
    [[groupId], true, true]);
  const hiddenWindow = h.browser.browserWindows.filter((w) => w.visible === false)[0];
  const hiddenId = hiddenWindow && [...Array(20).keys()].map((n) => n + 1).filter((n) => n !== windowId);
  equal("the window of hidden tabs is not found by any id",
    (await Promise.all((hiddenId || []).map((n) => outcome(h.chrome.windows.get(n))))).indexOf("resolved"), -1);
  await h.chrome.tabGroups.update(groupId, { collapsed: false });
  await settle();
  equal("expanding puts the tabs back in order", order(h.win), startOrder);

  // A group in a window behind another comes back to that window.
  const back = h.browser.openWindow();
  const backTab = back.openTab("foreground");
  backTab.url = "https://back.example/";
  const more = await open(h, back, ["d"]);
  const backId = (await h.chrome.tabs.get(more.ids.d)).windowId;
  const other = await h.chrome.tabs.group({ tabIds: [more.ids.d] });
  await h.chrome.tabGroups.update(other, { collapsed: true });
  await settle();
  await h.chrome.tabGroups.update(other, { collapsed: false });
  await settle();
  equal("and to its own window", (await h.chrome.tabs.get(more.ids.d)).windowId, backId);
});

test("tabGroups.move keeps a group together", async () => {
  const h = await start();
  const { ids } = await open(h, h.win, ["a", "b", "c", "d", "e"]);
  const groupId = await h.chrome.tabs.group({ tabIds: [ids.a, ids.b] });
  await h.chrome.tabGroups.move(groupId, { index: 3 });
  equal("moved forward", order(h.win), "first c d a b e");
  await h.chrome.tabGroups.move(groupId, { index: 1 });
  equal("moved back", order(h.win), "first a b c d e");
  await h.chrome.tabGroups.move(groupId, { index: -1 });
  equal("moved to the end", order(h.win), "first c d e a b");
});

test("a tab hidden with one group joins an expanded one, and hides with it", async () => {
  const h = await start();
  const { ids, made } = await open(h, h.win, ["a", "b", "c"]);
  const first = await h.chrome.tabs.group({ tabIds: [ids.a, ids.b] });
  const second = await h.chrome.tabs.group({ tabIds: [ids.c] });
  await h.chrome.tabGroups.update(first, { collapsed: true });
  await settle();
  await h.chrome.tabs.group({ tabIds: [ids.a], groupId: second });
  await settle();
  equal("it shows, for the engine as well", [made.a.browserWindow === h.win, !!made.a.hidden], [true, false]);
  await h.chrome.tabGroups.update(second, { collapsed: true });
  await settle();
  equal("and collapsing that group hides it", shownWindow(h.browser)[0].tabs.indexOf(made.a), -1);
});

test("a tab moved to another window on its own leaves its group", async () => {
  const h = await start();
  const { ids } = await open(h, h.win, ["a", "b"]);
  const groupId = await h.chrome.tabs.group({ tabIds: [ids.a, ids.b] });
  const other = h.browser.openWindow();
  const tab = other.openTab("foreground");
  tab.url = "https://other.example/";
  await settle();
  const otherId = (await h.chrome.tabs.query({ url: "https://other.example/*" }))[0].windowId;
  const changes = [];
  h.chrome.tabs.onUpdated.addListener((id, change) => changes.push([id, change.groupId]));
  const moved = await h.chrome.tabs.move(ids.a, { windowId: otherId, index: -1 });
  equal("its groupId is none, and the other member stays",
    [moved.groupId, moved.windowId, (await h.chrome.tabs.get(ids.b)).groupId, changes],
    [-1, otherId, groupId, [[ids.a, -1]]]);
});

// -- tabs ---------------------------------------------------------------------
test("tabs.highlight activates the tab and answers with the window", async () => {
  const h = await start();
  await open(h, h.win, ["a", "b"]);
  const win = await h.chrome.tabs.highlight({ tabs: [2] });
  equal("the first tab named is active", [h.win.activeTab === h.win.tabs[2], win && win.tabs.length, win && win.tabs[2].active],
    [true, 3, true]);
  const single = await h.chrome.tabs.highlight({ tabs: 1 });
  equal("a single index works", [h.win.activeTab === h.win.tabs[1], single && single.id], [true, win && win.id]);
  equal("an index with no tab fails", await outcome(h.chrome.tabs.highlight({ tabs: [9] })), "No tab at index: 9.");
});

test("tabs.duplicate opens beside the original in its window", async () => {
  const h = await start();
  const { ids } = await open(h, h.win, ["a", "b"]);
  const back = h.browser.openWindow();
  back.openTab("foreground").url = "https://back.example/";
  await settle();
  h.win.activate();
  await settle();
  const source = (await h.chrome.tabs.query({ url: "https://back.example/*" }))[0];
  const copy = await h.chrome.tabs.duplicate(source.id);
  equal("in a window behind", [copy.windowId, copy.index], [source.windowId, source.index + 1]);
  const beside = await h.chrome.tabs.duplicate(ids.a);
  const original = await h.chrome.tabs.get(ids.a);
  equal("and next to it", [beside.windowId, beside.index], [original.windowId, original.index + 1]);
});

test("moving a tab reports the move", async () => {
  const h = await start();
  const { ids } = await open(h, h.win, ["a", "b"]);
  const events = [];
  h.chrome.tabs.onMoved.addListener((id, info) => events.push(["moved", id, info.fromIndex, info.toIndex]));
  h.chrome.tabs.onDetached.addListener((id, info) => events.push(["detached", id, info.oldPosition]));
  h.chrome.tabs.onAttached.addListener((id, info) => events.push(["attached", id, info.newPosition]));
  await h.chrome.tabs.move(ids.b, { index: 0 });
  equal("within a window", events, [["moved", ids.b, 2, 0]]);
  events.length = 0;
  await h.chrome.tabs.move(ids.b, { index: 0 });
  equal("a tab that stays put reports nothing", events, []);
  const other = h.browser.openWindow();
  other.openTab("foreground").url = "https://other.example/";
  await settle();
  const otherId = (await h.chrome.tabs.query({ url: "https://other.example/*" }))[0].windowId;
  await h.chrome.tabs.move(ids.b, { windowId: otherId, index: 0 });
  equal("between windows", events, [["detached", ids.b, 0], ["attached", ids.b, 0]]);
});

test("goBack and goForward move through the tab's history", async () => {
  const h = await start();
  const frame = bridgeFrame(h, h.first);
  await settle();
  const steps = [];
  frame.sandbox.history = { go: (delta) => steps.push(delta) };
  const id = (await h.chrome.tabs.query({ active: true, currentWindow: true }))[0].id;
  equal("both resolve", [await outcome(h.chrome.tabs.goBack(id)), await outcome(h.chrome.tabs.goForward(id))],
    ["resolved", "resolved"]);
  await h.chrome.tabs.goBack();
  equal("the page goes each way, and the active tab is the default", steps, [-1, 1, -1]);
  const answered = await new Promise((resolve) => h.chrome.tabs.goBack(id, () => resolve(true)));
  equal("a callback runs", answered, true);
  const refused = h.chrome.__wexNative.tabs.executeScript;
  h.chrome.__wexNative.tabs.executeScript = () => Promise.reject(new Error("Cannot access contents of the page."));
  equal("a page the extension cannot reach fails", await outcome(h.chrome.tabs.goBack(id)),
    "Cannot access contents of the page.");
  h.chrome.__wexNative.tabs.executeScript = refused;
  equal("a tab that is not there fails", await outcome(h.chrome.tabs.goBack(987654)), "No tab with id: 987654.");
});

test("tabs.query honours what it cannot match, and the status it reports", async () => {
  const h = await start();
  await open(h, h.win, ["a"]);
  equal("no tab is in a popup, muted or frozen",
    [(await h.chrome.tabs.query({ windowType: "popup" })).length, (await h.chrome.tabs.query({ muted: true })).length,
      (await h.chrome.tabs.query({ frozen: true })).length, (await h.chrome.tabs.query({ autoDiscardable: false })).length],
    [0, 0, 0, 0]);
  equal("every tab is in a normal window", (await h.chrome.tabs.query({ windowType: "normal" })).length, 2);
  // Safari's tab shows its empty page until the load commits.
  const openTab = h.win.openTab;
  h.win.openTab = function () {
    const tab = openTab.apply(this, arguments);
    Object.defineProperty(tab, "url", { get: () => "about:blank", set() {} });
    return tab;
  };
  const made = await h.chrome.tabs.create({ url: "https://slow.example/" });
  equal("a tab reporting loading is found as loading",
    [made.status, (await h.chrome.tabs.get(made.id)).status,
      (await h.chrome.tabs.query({ status: "loading" })).map((t) => t.id).indexOf(made.id) >= 0],
    ["loading", "loading", true]);
});

test("tabs.create opens one tab with no window, and a bad window id fails", async () => {
  const h = await start();
  const bad = "No window with id: 555.";
  equal("a bad window id fails",
    [await outcome(h.chrome.tabs.create({ windowId: 555, url: "https://y.example/" })),
      await outcome(h.chrome.windows.remove(555)),
      await outcome(h.chrome.tabs.move((await h.chrome.tabs.query({}))[0].id, { windowId: 555, index: 0 }))],
    [bad, bad, bad]);
  equal("WINDOW_ID_CURRENT is the window in front",
    (await h.chrome.tabs.create({ windowId: -2, url: "https://current.example/" })).windowId,
    (await h.chrome.windows.getCurrent()).id);
  h.browser.browserWindows.slice().forEach((w) => {
    w.tabs.slice().forEach((t) => t.close());
    w.close();
  });
  await settle();
  const made = await h.chrome.tabs.create({ url: "https://z.example/" });
  equal("with no window, a new one holds just the tab",
    [h.browser.browserWindows[0].tabs.map((t) => t.url), made.windowId !== -1], [["https://z.example/"], true]);
});

test("windows.create brings the tab it is given", async () => {
  const h = await start();
  const { ids, made } = await open(h, h.win, ["a"]);
  const win = await h.chrome.windows.create({ tabId: ids.a });
  await settle();
  equal("the tab is the new window's only one, and active",
    [win.tabs.map((t) => t.id), win.tabs[0].active, (await h.chrome.tabs.get(ids.a)).windowId, made.a.browserWindow === h.win],
    [[ids.a], true, win.id, false]);
  equal("a tab that is not there fails", await outcome(h.chrome.windows.create({ tabId: 987654 })), "No tab with id: 987654.");
});

// -- extension, management and action ----------------------------------------
test("management names each icon's own address", async () => {
  const h = await start((c) => {
    c.manifest.icons = { 16: "icons/16.png", 48: "/icons/48.png" };
  });
  const base = h.browser.baseURI;
  equal("from a relative or a rooted path", (await h.chrome.management.getSelf()).icons,
    [{ size: 16, url: base + "icons/16.png" }, { size: 48, url: base + "icons/48.png" }]);
});

test("extension.getViews tells views by type", async () => {
  const h = await start();
  const href = (views) => views.map((v) => String(v.location.href));
  const self = h.browser.baseURI + "wex-global-page.html";
  equal("a tab's view is no background", h.chrome.extension.getViews({ type: "tab" }), []);
  equal("the background is one", href(h.chrome.extension.getViews({ type: "background" })), [self]);
  equal("and with no type", href(h.chrome.extension.getViews()), [self]);
});

test("extension.lastError is the failure's during its callback", async () => {
  const h = await start();
  const seen = await new Promise((resolve) => {
    h.chrome.tabs.get(987654, () => resolve(h.chrome.extension.lastError && h.chrome.extension.lastError.message));
  });
  equal("during it", seen, "No tab with id: 987654.");
  await settle();
  equal("and not after", h.chrome.extension.lastError, undefined);
});

test("action.getTitle gives the manifest's title", async () => {
  const h = await start((c) => {
    c.manifest.action.default_title = "Declared";
  });
  equal("with nothing set", await h.chrome.action.getTitle({}), "Declared");
  await h.chrome.action.setTitle({ title: "Set" });
  equal("until one is set", await h.chrome.action.getTitle({}), "Set");
});

test("a Firefox build's null gives up what was set on the action", async () => {
  const h = await start((c) => {
    c.firefoxBuild = true;
    c.toolbarImages = { "icons/large.png": "wex/toolbar/icons/large.png" };
  }, false, (browser) => {
    browser.toolbarItems[0].image = browser.baseURI + "declared.png";
  });
  const id = (await h.chrome.tabs.query({}))[0].id;
  const base = h.browser.baseURI;
  await h.chrome.action.setPopup({ tabId: id, popup: "other.html" });
  await h.chrome.action.setPopup({ tabId: id, popup: null });
  equal("a tab's popup takes on the global one", await h.chrome.action.getPopup({ tabId: id }), base + "popup.html");
  await h.chrome.action.setPopup({ popup: "changed.html" });
  equal("which can be changed", await h.chrome.action.getPopup({}), base + "changed.html");
  await h.chrome.action.setPopup({ popup: null });
  equal("and goes back to the manifest's", await h.chrome.action.getPopup({}), base + "popup.html");

  const item = h.browser.toolbarItems[0];
  const declared = h.browser.baseURI + "declared.png";
  await h.chrome.action.setIcon({ tabId: id, path: "icons/large.png" });
  equal("a tab's icon shows", item.image, base + "wex/toolbar/icons/large.png");
  await h.chrome.action.setIcon({ tabId: id, path: null });
  equal("and gives way to the declared one", item.image, declared);
});

// -- alarms -------------------------------------------------------------------
test("an alarm's listener finds it as it stands after firing", async () => {
  const h = await start();
  const seen = {};
  h.chrome.alarms.onAlarm.addListener((alarm) => {
    h.chrome.alarms.get(alarm.name).then((found) => {
      seen[alarm.name] = found ? found.scheduledTime > alarm.scheduledTime : "gone";
    });
  });
  await settle(400);
  await h.chrome.alarms.create("once", { when: Date.now() + 5 });
  await h.chrome.alarms.create("again", { when: Date.now() + 5, periodInMinutes: 1 });
  await settle(1300);
  equal("a one-shot is gone, and a periodic one is rescheduled", [seen.once, seen.again], ["gone", true]);
  equal("a listener can make it again",
    await (async () => {
      h.chrome.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name === "remade") {
          h.chrome.alarms.create("remade", { delayInMinutes: 5 });
        }
      });
      await h.chrome.alarms.create("remade", { when: Date.now() + 5 });
      await settle(1300);
      return (await h.chrome.alarms.get("remade")).name;
    })(), "remade");
});

// -- worker messages ----------------------------------------------------------
test("a worker's postMessage takes either form of transfer", async () => {
  const h = await start();
  const got = [];
  h.page.addEventListener("message", (event) => got.push([event.data && event.data.x, event.ports.length]));
  const channel = new h.page.MessageChannel();
  h.page.serviceWorker.postMessage({ x: 1 }, { transfer: [channel.port1] });
  await settle();
  const other = new h.page.MessageChannel();
  h.page.serviceWorker.postMessage({ x: 2 }, [other.port1]);
  await settle();
  h.page.serviceWorker.postMessage({ x: 3 }, {});
  await settle();
  equal("each arrives with its ports", got, [[1, 1], [2, 1], [3, 0]]);
  got.length = 0;
  const inside = new h.page.MessageChannel();
  let threw = null;
  try {
    h.page.serviceWorker.postMessage({ x: 4, port: inside.port1 }, [inside.port1]);
  } catch (e) {
    threw = e.message;
  }
  await settle();
  equal("a port inside the data is moved", [threw, got], [null, [[4, 1]]]);
  got.length = 0;
  const unsent = new h.page.MessageChannel();
  threw = null;
  try {
    h.page.serviceWorker.postMessage({ x: 5, port: unsent.port1 });
  } catch (e) {
    threw = e.message;
  }
  await settle();
  equal("and one that cannot be moved is handed over as it is", [threw, got], [null, [[5, 0]]]);
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      const result = await Promise.race([fn().then(() => "done"), settle(8000).then(() => "timed out")]);
      if (result !== "done") {
        failures.push(name + ": " + result);
      }
    } catch (e) {
      failures.push(name + ": threw " + (e && e.message));
    }
  }
  console.log(passed + " checks passed, " + failures.length + " failed");
  failures.forEach((failure) => console.log("  FAIL  " + failure));
  process.exit(failures.length ? 1 : 0);
})();
