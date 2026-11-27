// The global page's rules on pages, sign-in, tab events, menus, downloads,
// page capture and what a site's new tab may open, in a simulated Safari.
// node tests/global-fixes-3.js
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { FakeBrowser } = require("./fake-safari");

const RUNTIME = process.env.WEX_RUNTIME || path.join(__dirname, "..", "webext2safari", "runtime");
const BUNDLE_ID = "com.example.test-TEAM123";
const WEB = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const PROVISIONAL = 0x40000000;

let passed = 0;
const failures = [];
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms || 30));

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

function fixture(change) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wex-global-fixes-3-"));
  fs.cpSync(RUNTIME, path.join(dir, "wex"), { recursive: true });
  fs.writeFileSync(path.join(dir, "wex", "wex-api.js"), "var WEX_API = null;\n");
  fs.writeFileSync(path.join(dir, "wex", "wex-content-api.js"), "var WEX_API = null;\n");
  const config = {
    extensionId: "com.example.test",
    name: "Fixture",
    version: "1",
    sourceOrigin: WEB,
    identityRedirectURL: "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/",
    manifest: {
      manifest_version: 3, name: "Fixture", version: "1",
      action: { default_popup: "popup.html" },
      web_accessible_resources: [{ resources: ["public.html"], matches: ["https://login.example/*"] }],
      permissions: ["tabs", "storage", "webRequest", "webNavigation", "contextMenus", "downloads", "identity",
        "declarativeContent", "pageCapture", "scripting", "<all_urls>"]
    },
    storage: "local",
    contextMenus: true,
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
  fs.writeFileSync(path.join(dir, "wex", "wex-config.js"), "var WEX_CONFIG = " + JSON.stringify(config) + ";\n");
  return dir;
}

async function start(change) {
  const dir = fixture(change);
  const browser = new FakeBrowser(dir, { bundleId: BUNDLE_ID });
  const win = browser.openWindow();
  const first = win.openTab();
  first.url = "https://first.example/";
  win.activeTab = first;
  await settle();
  const wex = (name) => path.join(dir, "wex", name);
  const page = browser.createGlobalPage([wex("wex-config.js"), wex("wex-core.js"), wex("wex-global.js")]);
  await settle();
  return { dir, browser, win, first, page, chrome: page.chrome, wex, item: browser.toolbarItems[0] };
}

function announce(browser, target, url) {
  const event = { target, url, prevented: false, __stopped: false,
    preventDefault() { this.prevented = true; } };
  browser.application.fire("beforeNavigate", event, true);
  return event;
}

const addRules = (chrome, rules) => new Promise((resolve) => chrome.declarativeContent.onPageChanged.addRules(rules, resolve));

// -- declarativeContent -------------------------------------------------------
test("rules apply to a page a tab goes on to", async () => {
  const h = await start();
  const dc = h.chrome.declarativeContent;
  await h.chrome.action.disable();
  await addRules(h.chrome, [{ conditions: [new dc.PageStateMatcher({ pageUrl: { hostSuffix: "first.example" } })],
    actions: [new dc.ShowAction()] }]);
  await settle();
  h.first.navigate("https://first.example/next");
  await settle();
  h.first.activate();
  equal("a ShowAction rule's action stays shown after a navigation to a page it names", h.item.disabled, false);
  h.first.navigate("https://other.example/");
  await settle();
  h.first.activate();
  equal("and goes away on a page it does not name", h.item.disabled, true);
  const opened = h.win.openTab();
  opened.navigate("https://first.example/new");
  await settle();
  opened.activate();
  equal("and shows on a new tab that lands on one", h.item.disabled, false);
});

test("what was set for a tab still goes with its document", async () => {
  const h = await start();
  await h.chrome.action.setBadgeText({ text: "7", tabId: h.first.engineId });
  await addRules(h.chrome, []);
  h.first.navigate("https://first.example/next");
  await settle();
  equal("a tab's badge is dropped when the tab shows another document",
    await h.chrome.action.getBadgeText({ tabId: h.first.engineId }), "");
});

test("a rule's pageUrl goes by the address a same-document navigation reaches", async () => {
  const h = await start();
  const dc = h.chrome.declarativeContent;
  await h.chrome.action.disable();
  await addRules(h.chrome, [{ conditions: [new dc.PageStateMatcher({ pageUrl: { pathPrefix: "/watch" } })],
    actions: [new dc.ShowAction()] }]);
  await settle();
  h.first.activate();
  equal("the action is hidden elsewhere on the site", h.item.disabled, true);
  const frame = h.browser.createContentFrame(h.first, [h.wex("wex-config.js"), h.wex("wex-core.js"), h.wex("wex-content.js")]);
  await settle();
  await frame.sandbox.WEXContent.chrome.runtime.sendMessage({ __wex: "navigated", how: "history", url: "https://first.example/watch?v=1" })
    .catch(() => {});
  await settle();
  h.first.activate();
  equal("and shows once pushState reaches the address the rule names", h.item.disabled, false);
});

// -- sign-in -------------------------------------------------------------------
test("a flow that may not ask the user runs in its hidden tab", async () => {
  const h = await start();
  const flow = h.chrome.identity.launchWebAuthFlow({ url: "https://accounts.example/auth", interactive: false });
  let settled = null;
  flow.then((url) => { settled = url; }, (e) => { settled = e.message; });
  await settle(40);
  equal("hiding its tab does not end it", settled, null);
  const hidden = h.browser.browserWindows.find((w) => w.visible === false);
  const tab = hidden && hidden.tabs[hidden.tabs.length - 1];
  equal("its page opens in the hidden window", tab && tab.url, "https://accounts.example/auth");
  announce(h.browser, tab, "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/cb?code=1");
  await settle();
  equal("and it ends with the address the provider sends it to", settled,
    "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/cb?code=1");

  const refused = h.chrome.identity.launchWebAuthFlow({ url: "https://accounts.example/auth", interactive: false,
    timeoutMsForNonInteractive: 40 });
  equal("one that stays on the provider's page fails as needing the user",
    await refused.then(() => "resolved", (e) => e.message), "User interaction required.");
});

test("a sign-in tab the user moves stays a sign-in tab, and closing one turns it down", async () => {
  const h = await start();
  let settled = null;
  h.chrome.identity.launchWebAuthFlow({ url: "https://accounts.example/auth", interactive: true })
    .then((url) => { settled = url; }, (e) => { settled = e.message; });
  await settle();
  const tab = h.win.tabs[h.win.tabs.length - 1];
  tab.moveTo(h.browser.openWindow());
  await settle();
  equal("a tab dragged to another window goes on", settled, null);
  tab.close();
  await settle();
  equal("and closing it declines", settled, "The user did not approve access.");
});

// -- tab events ------------------------------------------------------------------
test("a tab's events come in the order they happen", async () => {
  const h = await start();
  const seen = [];
  h.chrome.tabs.onCreated.addListener((t) => seen.push("created " + t.id));
  h.chrome.tabs.onUpdated.addListener((id, c) => seen.push("updated " + id + " " + (c.status || "url")));
  h.chrome.tabs.onRemoved.addListener((id) => seen.push("removed " + id));
  const tab = h.win.openTab("background");
  await new Promise((resolve) => setTimeout(resolve, 0));
  tab.navigate("https://new.example/");
  const id = tab.engineId;
  await settle();
  equal("onUpdated comes after onCreated", seen,
    ["created " + id, "updated " + id + " loading", "updated " + id + " url", "updated " + id + " complete"]);

  seen.length = 0;
  const brief = h.win.openTab("background");
  const briefId = brief.engineId;
  await new Promise((resolve) => setTimeout(resolve, 0));
  brief.close();
  await settle();
  equal("onRemoved comes after onCreated", seen, ["created " + briefId, "removed " + briefId]);

  seen.length = 0;
  h.browser.engine.emitHost("tabs.onUpdated", id, { title: "T" }, h.browser.engine.describeTab(tab));
  equal("and a tab whose onCreated has fired has its updates told at once", seen, ["updated " + id + " url"]);
});

test("the extension goes by the last tab activated", async () => {
  const h = await start();
  const seen = [];
  h.chrome.tabs.onActivated.addListener((info) => seen.push(info.tabId));
  await settle();
  const fresh = h.win.openTab("background");
  fresh.activate();
  h.first.activate();
  await settle();
  equal("a tab still being looked up does not take the last word", seen[seen.length - 1], h.first.engineId);
  fresh.activate();
  await settle();
  equal("and it is told of when it is activated later", seen[seen.length - 1], fresh.engineId);
});

test("a pageless tab keeps its id when it moves", async () => {
  const h = await start();
  const seen = [];
  h.chrome.tabs.onRemoved.addListener((id) => seen.push(id));
  const tab = h.win.openTab("background", undefined, { pageless: true });
  await settle();
  const before = (await h.chrome.tabs.query({})).map((t) => t.id).filter((id) => id >= PROVISIONAL);
  tab.moveTo(h.browser.openWindow());
  await settle();
  const after = (await h.chrome.tabs.query({})).map((t) => t.id).filter((id) => id >= PROVISIONAL);
  equal("moving to another window neither removes it nor changes its id", [seen, after], [[], before]);
  tab.close();
  await settle();
  equal("and closing it is told", seen, before);
});

test("a retired provisional id names its tab to pageCapture", async () => {
  const h = await start();
  const tab = h.win.openTab("background", undefined, { pageless: true });
  await settle();
  const old = (await h.chrome.tabs.query({})).map((t) => t.id).filter((id) => id >= PROVISIONAL)[0];
  tab.showPage();
  await settle();
  await h.chrome.tabs.query({});
  // An object of the global page's own realm, as the extension's code makes.
  const details = vm.runInContext("({ tabId: " + old + " })", h.page);
  const error = await h.chrome.pageCapture.saveAsMHTML(details).then(() => "resolved", (e) => e.message);
  equal("it is not taken for a tab that is not there",
    [typeof old, error === "Cannot find the tab for this request."], ["number", false]);
});

// -- requests ----------------------------------------------------------------------
test("a challenge to the extension's own request ends it with or without webRequest", async () => {
  const h = await start((config) => {
    config.manifest.permissions = config.manifest.permissions.filter((p) => p !== "webRequest");
  });
  equal("the namespace is not there", h.chrome.webRequest, undefined);
  const outcome = await h.browser.engine.request({ url: "https://example.com/feed", tabId: -1,
    documentUrl: h.browser.baseURI + "wex-global-page.html" }, { challenge: true })
    .then((o) => o.challenge, (e) => e.message);
  equal("the challenge is cancelled", outcome, "cancelled");
});

// -- menus -------------------------------------------------------------------------
function rightClick(h, info) {
  const items = [];
  h.browser.application.fire("contextmenu", { target: h.first, userInfo: info, __stopped: false,
    contextMenu: { appendContextMenuItem: (command) => items.push(command) } }, true);
  return items;
}

test("a title's %s shows the selected text, cut to fit", async () => {
  const h = await start();
  const titles = (info) => {
    const items = [];
    h.browser.application.fire("contextmenu", { target: h.first, userInfo: info, __stopped: false,
      contextMenu: { appendContextMenuItem: (command, title) => items.push(title) } }, true);
    return items;
  };
  await new Promise((resolve) => h.chrome.contextMenus.create({ id: "s", title: "Find %s now", contexts: ["all"] }, resolve));
  equal("the text", titles({ pageUrl: "https://example.com/", selectionText: "picked" }), ["Find picked now"]);
  equal("a long one", titles({ pageUrl: "https://example.com/", selectionText: "x".repeat(80) }),
    ["Find " + "x".repeat(64) + "\u2026 now"]);
  equal("and with none it stays", titles({ pageUrl: "https://example.com/" }), ["Find %s now"]);
  equal("a $ in the text is only text", titles({ pageUrl: "https://example.com/", selectionText: "$&" }), ["Find $& now"]);
});

test("top-level items are shown, and an item with a submenu is not", async () => {
  const h = await start();
  const create = (o) => new Promise((resolve) => h.chrome.contextMenus.create(o, resolve));
  const update = (id, o) => new Promise((resolve) => h.chrome.contextMenus.update(id, o, resolve));
  await create({ id: "p", title: "Parent", contexts: ["page"] });
  await create({ id: "c", parentId: "p", title: "Child", contexts: ["page"] });
  await create({ id: "g", parentId: "c", title: "Grandchild", contexts: ["page"] });
  await create({ id: "alone", title: "Alone", contexts: ["page"] });
  await create({ id: "also", title: "Also", contexts: ["page"] });
  const info = { pageUrl: "https://first.example/" };
  equal("several top-level items are each shown, and nothing of the submenu",
    rightClick(h, info), ["wex-menu:alone", "wex-menu:also"]);
  await create({ id: "off", title: "Off", contexts: ["page"], enabled: false });
  await update("also", { visible: false });
  equal("a hidden or disabled item is not", rightClick(h, info), ["wex-menu:alone"]);
  await create({ id: "link", title: "Link", contexts: ["link"] });
  equal("an item for another context only where it applies, as a page item does not on a link",
    rightClick(h, { pageUrl: "https://first.example/", linkUrl: "https://first.example/l" }), ["wex-menu:link"]);
});

test("a menu click is told only what its own right-click found", async () => {
  const h = await start();
  const clicks = [];
  h.chrome.contextMenus.onClicked.addListener((info) => clicks.push(info));
  await new Promise((resolve) => h.chrome.contextMenus.create({ id: "m", title: "M", contexts: ["all"] }, resolve));
  const click = () => h.browser.application.fire("command", { command: "wex-menu:m", target: h.item, __stopped: false }, true);
  const linked = { pageUrl: "https://first.example/", linkUrl: "https://first.example/link", selectionText: "sel" };

  rightClick(h, linked);
  click();
  await settle();
  equal("the right-click's click has its link", clicks[0].linkUrl, linked.linkUrl);
  click();
  await settle();
  equal("a later click has none", clicks[1].linkUrl, undefined);

  rightClick(h, linked);
  h.first.navigate("https://first.example/next");
  await settle();
  click();
  await settle();
  equal("nor does one after the tab has gone on to another page", [clicks[2].linkUrl, clicks[2].selectionText], [undefined, undefined]);

  rightClick(h, linked);
  const menu = { __stopped: false };
  h.browser.application.fire("menu", menu, true);
  click();
  await settle();
  equal("an unrelated menu leaves a right-click's info alone", clicks[3].linkUrl, linked.linkUrl);
});

// -- downloads ------------------------------------------------------------------------
test("an erased download is not saved", async () => {
  const h = await start();
  h.page.WEX.CONFIG.bridgeWhitelist = null;
  h.browser.webResponses["https://files.test/a"] = { headers: { "Content-Type": "text/plain", "Content-Length": "3" }, body: "abc" };
  // The file is read back, with the body all received, until `release`.
  let release = null;
  const reading = new Promise((resolve) => {
    const Reader = h.page.FileReader;
    h.page.FileReader = function () {
      const reader = new Reader();
      const read = reader.readAsArrayBuffer;
      reader.readAsArrayBuffer = function (blob) {
        release = () => read.call(reader, blob);
        resolve();
      };
      return reader;
    };
  });
  const id = await h.chrome.downloads.download({ url: "https://files.test/a" });
  await reading;
  const state = (await h.chrome.downloads.search({ id }))[0].state;
  await h.chrome.downloads.erase({ id });
  release();
  await settle(300);
  equal("nothing lands in Downloads", [state, h.browser.savedDownloads.map((d) => d.filename)], ["in_progress", []]);
});

// -- page capture ---------------------------------------------------------------------
test("an archive keeps each file's bytes and says what charset each is in", async () => {
  const h = await start();
  const page = { url: "https://first.example/", title: "T", contentType: "text/html", token: null, frames: {},
    html: "<html><head><meta charset=\"windows-1252\"></head><body>é</body></html>",
    resources: ["https://cdn.example/a.css", "https://cdn.example/s.js", "https://cdn.example/u.css", "https://cdn.example/n.txt"] };
  h.page.WEX.native.tabs.connect = function () {
    const heard = [];
    return { onMessage: { addListener: (f) => heard.push(f) }, onDisconnect: { addListener() {} }, disconnect() {},
      postMessage(m) { setTimeout(() => heard.forEach((f) => f(m.prepare ? { prepared: true } : { page })), 0); } };
  };
  const latin = Buffer.from([0x62, 0x7b, 0xe9, 0x7d]);
  const sjis = Buffer.from([0x76, 0x3d, 0x82, 0xa0]);
  h.browser.webResponses["https://cdn.example/a.css"] = { headers: { "Content-Type": "text/css; charset=iso-8859-1" }, body: latin };
  h.browser.webResponses["https://cdn.example/s.js"] = { headers: { "Content-Type": "application/javascript; charset=shift_jis" }, body: sjis };
  h.browser.webResponses["https://cdn.example/u.css"] = { headers: { "Content-Type": "text/css; charset=utf-8" }, body: "a{content:\"é=\"}" };
  h.browser.webResponses["https://cdn.example/n.txt"] = { headers: { "Content-Type": "text/plain" }, body: latin };
  const text = await h.chrome.pageCapture.saveAsMHTML({ tabId: h.first.engineId, __wexText: true });
  const part = (url) => text.split("\r\n--").find((p) => p.includes("\r\nContent-Location: " + url + "\r\n"));
  const body = (p) => p.split("\r\n\r\n")[1].trim();
  equal("the page is UTF-8, and says so", /Content-Type: text\/html; charset=utf-8\r\n/.test(part("https://first.example/")), true);
  equal("a Latin-1 style sheet keeps its bytes and its charset",
    [/Content-Type: text\/css; charset=iso-8859-1\r\n/.test(part("https://cdn.example/a.css")),
      Buffer.from(body(part("https://cdn.example/a.css")), "base64").equals(latin)], [true, true]);
  equal("as does a Shift JIS script",
    [/charset=shift_jis\r\n/.test(part("https://cdn.example/s.js")),
      Buffer.from(body(part("https://cdn.example/s.js")), "base64").equals(sjis)], [true, true]);
  equal("a UTF-8 file stays quoted-printable",
    [/Content-Transfer-Encoding: quoted-printable/.test(part("https://cdn.example/u.css")),
      body(part("https://cdn.example/u.css"))], [true, "a{content:\"=C3=A9=3D\"}"]);
  equal("and a file that names no charset goes byte for byte", body(part("https://cdn.example/n.txt")), "b{=E9}");
});

// -- what a site's new tab opens -----------------------------------------------------
const PUBLIC = WEB + "/public.html";
const PRIVATE = WEB + "/options.html?do=wipe";

test("a new tab over a web page opens only what that page may", async () => {
  const h = await start();
  const base = h.browser.baseURI;
  let tab = h.win.openTab("background");
  let event = announce(h.browser, tab, PRIVATE);
  await settle();
  equal("a site's window.open in the background does not open a page not web-accessible",
    [event.prevented, tab.url], [false, ""]);

  tab = h.win.openTab("foreground");
  event = announce(h.browser, tab, PRIVATE);
  await settle();
  equal("nor in front, when the tab is already its window's active one",
    [event.prevented, tab.url], [false, ""]);
  h.win.activeTab = h.first;

  tab = h.browser.openWindow().openTab("foreground");
  event = announce(h.browser, tab, PRIVATE);
  await settle();
  equal("nor in a window of its own", [event.prevented, tab.url], [false, ""]);

  tab = h.win.openTab("background");
  tab._url = PRIVATE;
  announce(h.browser, tab, PRIVATE);
  h.browser.application.fire("navigate", { target: tab, __stopped: false }, true);
  await settle();
  equal("nor once it shows Safari's page for the address", tab.url, PRIVATE);

  tab = h.win.openTab("background");
  h.browser.popover.visible = true;
  event = announce(h.browser, tab, PRIVATE);
  h.browser.popover.visible = false;
  await settle();
  equal("nor when a popover opens after the tab did", event.prevented, false);

  tab = h.win.openTab("background");
  announce(h.browser, tab, "https://elsewhere.example/");
  event = announce(h.browser, tab, PRIVATE);
  await settle();
  equal("nor when sent on before its first page arrives", event.prevented, false);

  tab = h.win.openTab("background");
  announce(h.browser, tab, null);
  event = announce(h.browser, tab, PRIVATE);
  await settle();
  equal("nor once announced as empty", event.prevented, false);

  const Tab = h.first.constructor;
  tab = new Tab(h.browser, h.win, "about:blank");
  h.win.tabs.push(tab);
  event = announce(h.browser, tab, PRIVATE);
  h.browser.application.fire("open", { target: tab, __stopped: false }, true);
  await settle();
  equal("nor when Safari tells of the navigation before the tab", event.prevented, false);

  const shown = h.win.openTab("background");
  shown._url = "https://shown.example/";
  announce(h.browser, shown, "about:blank");
  shown._url = "about:blank";
  event = announce(h.browser, shown, PRIVATE);
  await settle();
  equal("nor a web page's tab sent to an empty page", event.prevented, false);

  h.first.url = "https://login.example/done";
  tab = h.win.openTab("background");
  event = announce(h.browser, tab, PUBLIC + "?code=1");
  await settle();
  equal("a page the manifest gives the site opens", [event.prevented, tab.url], [true, base + "public.html?code=1"]);

  h.first.url = "https://evil.example/";
  tab = h.win.openTab("background");
  event = announce(h.browser, tab, PUBLIC);
  await settle();
  equal("but not for a site it does not name", event.prevented, false);
});

test("a new tab opens any of the extension's pages with no web page behind it", async () => {
  const h = await start();
  const base = h.browser.baseURI;
  h.browser.popover.visible = true;
  let tab = h.win.openTab("foreground");
  let event = announce(h.browser, tab, PRIVATE);
  h.browser.popover.visible = false;
  await settle();
  equal("a popover's link", [event.prevented, tab.url], [true, base + "options.html?do=wipe"]);
  h.win.activeTab = h.first;

  const own = h.win.openTab("background");
  own.url = base + "options.html";
  h.win.activeTab = own;
  tab = h.win.openTab("background");
  event = announce(h.browser, tab, PRIVATE);
  await settle();
  equal("an extension page's link", [event.prevented, tab.url], [true, base + "options.html?do=wipe"]);
  own.url = "about:blank";
  tab = h.win.openTab("background");
  event = announce(h.browser, tab, PRIVATE);
  await settle();
  equal("an address typed over an empty tab", [event.prevented, tab.url], [true, base + "options.html?do=wipe"]);
  h.win.activeTab = h.first;

  h.first.url = "https://first.example/";
  announce(h.browser, h.first, null);
  h.first.url = "";
  event = announce(h.browser, h.first, PRIVATE);
  await settle();
  equal("and one typed over Top Sites a web page's tab went on to", event.prevented, true);
});

test("the extension's own calls open its pages whatever is in front", async () => {
  const h = await start();
  const base = h.browser.baseURI;
  h.first.url = "https://evil.example/";
  const made = await h.chrome.tabs.create({ url: PRIVATE });
  await settle();
  equal("tabs.create", h.win.tabs.find((t) => t.engineId === made.id).url, base + "options.html?do=wipe");
  const blank = await h.chrome.tabs.create({});
  await settle();
  await h.chrome.tabs.update(blank.id, { url: PRIVATE });
  await settle();
  const tab = h.win.tabs.find((t) => t.engineId === blank.id);
  equal("tabs.update of a tab it opened empty", tab.url, base + "options.html?do=wipe");
  const event = announce(h.browser, tab, base + "options.html?again=1");
  equal("and Safari's announcement of its Safari address is left alone", event.prevented, false);

  const popup = h.browser.createExtensionPage([h.wex("wex-config.js"), h.wex("wex-core.js"), h.wex("wex-page.js")],
    base + "popup.html");
  await settle();
  h.browser.popover.visible = true;
  const before = h.win.tabs.length;
  popup.open(PRIVATE);
  await settle();
  h.browser.popover.visible = false;
  equal("a popup's window.open of its own page", [h.win.tabs.length - before, h.win.tabs[h.win.tabs.length - 1].url],
    [1, base + "options.html?do=wipe"]);
});

// -- declarativeContent and lastError in an extension page ---------------------------
test("an extension page in a tab has the rules' functions", async () => {
  const h = await start();
  const tab = h.win.openTab("background");
  const url = h.browser.baseURI + "options.html";
  tab.url = url;
  await settle();
  const page = h.browser.createTabPage(tab, [h.wex("wex-config.js"), h.wex("wex-core.js"), h.wex("wex-page.js")], url);
  await settle();
  const c = page.chrome;
  const dc = c.declarativeContent;
  const call = (method, ...args) => new Promise((resolve) => dc.onPageChanged[method](...args, (value) =>
    resolve([value === undefined ? null : value, c.runtime.lastError ? c.runtime.lastError.message : null])));
  const rule = { id: "r", conditions: [new dc.PageStateMatcher({ pageUrl: { hostSuffix: "first.example" } })],
    actions: [new dc.ShowAction()] };
  const added = await call("addRules", [rule]);
  equal("addRules answers with the rules, and the global page has them",
    [added[0].map((r) => [r.id, r.priority]), added[1], (await new Promise((resolve) =>
      h.chrome.declarativeContent.onPageChanged.getRules(resolve))).map((r) => r.id)],
    [[["r", 100]], null, ["r"]]);
  const again = await call("addRules", [rule]);
  equal("a failed call's callback has lastError", [again[0], again[1]], [null, "Duplicate rule ID: r"]);
  equal("lastError is gone after it", c.runtime.lastError, undefined);
  equal("getRules answers", (await call("getRules"))[0].map((r) => r.id), ["r"]);
  equal("and by id", (await call("getRules", ["nope"]))[0], []);
  equal("removeRules takes ids", (await call("removeRules", ["nope"]))[1], null);
  equal("which leave the others", (await call("getRules"))[0].map((r) => r.id), ["r"]);
  await call("removeRules");
  equal("and with none removes every rule", (await call("getRules"))[0], []);
  equal("the event is not one to listen to", typeof dc.onPageChanged.addListener, "undefined");

});

test("an extension page's extension.lastError is runtime.lastError", async () => {
  const h = await start();
  const tab = h.win.openTab("background");
  const url = h.browser.baseURI + "options.html";
  tab.url = url;
  await settle();
  const c = h.browser.createTabPage(tab, [h.wex("wex-config.js"), h.wex("wex-core.js"), h.wex("wex-page.js")], url).chrome;
  await settle();
  const during = await new Promise((resolve) => c.tabs.get(99999, () => resolve(c.extension.lastError && c.extension.lastError.message)));
  equal("during a failed call's callback", typeof during, "string");
  equal("undefined outside one", c.extension.lastError, undefined);
  c.extension.lastError = { message: "x" };
  equal("and one to assign, as Chrome's is", c.runtime.lastError && c.runtime.lastError.message, "x");
  c.extension.lastError = null;
});

test("a worker's fetch listener answers the requests of the extension's pages", async () => {
  const h = await start();
  const base = h.browser.baseURI;
  const asked = [];
  h.page.onfetch = (event) => {
    asked.push(event.request.url);
    if (event.request.url.indexOf(base + "data?") === 0) {
      event.respondWith(Promise.resolve(new h.page.Response("clientData=1",
        { headers: { "content-type": "text/javascript" } })));
    } else if (/\.user\.css$/.test(event.request.url)) {
      event.respondWith(h.page.Response.redirect(base + "edit.html"));
    }
  };
  await settle();
  const engine = h.browser.engine;
  const fromPopup = (url, type) => engine.request({ url, type, documentUrl: base + "popup.html" });
  const made = await fromPopup(base + "data?dark=0", "script");
  const moved = await fromPopup(base + "a.user.css", "main_frame");
  const left = await fromPopup(base + "popup.js", "script");
  const fromSite = await engine.request({ url: base + "data?dark=0", type: "script", documentUrl: "https://site.example/" });
  equal("its response is the load's, a redirect sends the load on, and what it leaves alone loads as it is",
    [made.redirectUrl, moved.redirectUrl, left.redirectUrl, left.cancel],
    ["data:text/javascript;base64,Y2xpZW50RGF0YT0x", base + "edit.html", undefined, false]);
  equal("and a site's load of the extension's address is not the worker's", [fromSite.redirectUrl, asked.length], [undefined, 3]);
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
