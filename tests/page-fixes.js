// Tests of the content bridge's boundary with web pages, of the order and
// timing of content scripts, and of what extension pages and devtools panels
// are given, against the fake Safari.
//
//     node tests/page-fixes.js [PROJECT]
//
// PROJECT is another copy of the project whose runtime and converter to test;
// the default is this one.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { FakeBrowser } = require("./fake-safari");

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, ".."));
const RUNTIME = path.join(ROOT, "webext2safari", "runtime");
const W2S = require(path.join(ROOT, "webext2safari", "js", "node.js"));

let passed = 0;
const failures = [];

function equal(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    passed += 1;
  } else {
    failures.push(name + " - got " + a + ", expected " + b);
  }
}

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms || 30));

const BASE_CONFIG = {
  extensionId: "com.example.test",
  name: "Fixture",
  version: "1",
  manifest: { manifest_version: 3, name: "Fixture", version: "1",
    permissions: ["tabs", "storage", "offscreen", "webNavigation", "contextMenus", "scripting"],
    action: { default_popup: "popup.html" } },
  locales: [],
  storage: "local",
  debug: false,
  popupPage: "popup.html",
  autoSizePopover: false,
  popoverId: "wex-popover",
  toolbarId: "wex-toolbar",
  backgroundPage: "wex-global-page.html",
  contentScripts: []
};

// A bundle of the runtime and `files`, with `config` over the base config.
function bundle(config, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wex-page-fixes-"));
  fs.mkdirSync(path.join(dir, "wex"));
  for (const name of fs.readdirSync(RUNTIME)) {
    fs.copyFileSync(path.join(RUNTIME, name), path.join(dir, "wex", name));
  }
  for (const name of ["wex-api.js", "wex-content-api.js"]) {
    fs.writeFileSync(path.join(dir, "wex", name), "var WEX_API = null;\n");
  }
  fs.writeFileSync(path.join(dir, "wex", "wex-config.js"),
    "var WEX_CONFIG = " + JSON.stringify(Object.assign({}, BASE_CONFIG, config)) + ";\n");
  for (const name of Object.keys(files || {})) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), files[name]);
  }
  return dir;
}

// A running extension: its bundle, browser and global page.
async function start(config, files) {
  const dir = bundle(config, files);
  const wex = (name) => path.join(dir, "wex", name);
  const browser = new FakeBrowser(dir, { bundleId: "com.example.test-TEAM123" });
  const window0 = browser.openWindow();
  const tab = window0.openTab();
  tab.url = "https://example.com/page";
  window0.activeTab = tab;
  await settle();
  const globalPage = browser.createGlobalPage([wex("wex-config.js"), wex("wex-core.js"), wex("wex-global.js")]);
  await settle();
  const bridge = [wex("wex-config.js"), wex("wex-core.js"), wex("wex-content.js"), wex("wex-run-start.js")];
  const pageScripts = [wex("wex-config.js"), wex("wex-core.js"), wex("wex-page.js")];
  return { dir, wex, browser, window0, tab, globalPage, chrome: globalPage.chrome, bridge, pageScripts };
}

// A frame in a tab of its own.
async function contentFrame(h, url) {
  const tab = h.window0.openTab("background");
  tab.url = url;
  await settle();
  return h.browser.createContentFrame(tab, h.bridge, { url });
}

// A DOM just big enough for the bridge's records of what content scripts
// insert: elements that take children, and fragments that give theirs up.
function addMiniDom(h) {
  const realBase = h.browser.baseGlobals.bind(h.browser);
  h.browser.baseGlobals = (label) => {
    const g = realBase(label);
    class Node {
      appendChild(child) {
        const moved = child.nodeType === 11 ? child.kids.splice(0) : [child];
        this.kids = (this.kids || []).concat(moved);
        moved.forEach((kid) => {
          kid.isConnected = true;
          kid.parentNode = this;
        });
        return child;
      }
    }
    class Element extends Node {}
    g.Node = Node;
    g.Element = Element;
    return g;
  };
  return () => { h.browser.baseGlobals = realBase; };
}

function element(frame, name, fields) {
  const el = new frame.sandbox.Element();
  return Object.assign(el, { nodeType: 1, localName: name, nodeName: name.toUpperCase(), isConnected: false,
    textContent: "", sheet: null, getAttribute: (key) => key === "rel" ? el.rel || null : null,
    querySelectorAll: () => [], addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: (e) => { (el.heard = el.heard || []).push(e.type); } }, fields);
}

// A securitypolicyviolation, real or made by the page.
function violation(frame, fields, trusted) {
  const event = new frame.sandbox.Event("securitypolicyviolation");
  for (const key of Object.keys(fields)) {
    Object.defineProperty(event, key, { value: fields[key] });
  }
  if (trusted) {
    Object.defineProperty(event, "isTrusted", { value: true });
  }
  frame.sandbox.document.dispatchEvent(event);
}

// What the page's DOM is handed: every script put into the head.
function watchHead(frame) {
  const seen = [];
  const head = frame.sandbox.document.head;
  const insertBefore = head.insertBefore;
  head.insertBefore = function (el) {
    seen.push(el.textContent);
    return insertBefore.call(this, el);
  };
  return seen;
}

// -- finding 1: a page cannot read the bundle's files ------------------------
async function refusedScripts() {
  const SECRET = "var privateKey = 'not web accessible';";
  const PUBLIC = "var publicScript = 1;";
  const h = await start({ manifest: Object.assign({}, BASE_CONFIG.manifest, {
    web_accessible_resources: [{ resources: ["public.js"], matches: ["https://*/*"] }] }) },
  { "private.js": SECRET, "public.js": PUBLIC });
  const undo = addMiniDom(h);
  const origin = h.browser.baseURI.split("/").slice(0, 3).join("/");
  const privateUrl = h.browser.baseURI + "private.js";
  const publicUrl = h.browser.baseURI + "public.js";

  // A page's own element, without the session token, with a made-up event.
  {
    const frame = await contentFrame(h, "https://evil.example/");
    const seen = watchHead(frame);
    const url = origin + "/private.js";
    const pageScript = element(frame, "script", { src: url, type: "text/plain", parentNode: frame.sandbox.document.head });
    frame.sandbox.document.getElementsByTagName = () => [pageScript];
    violation(frame, { blockedURI: url, effectiveDirective: "script-src" }, false);
    equal("a page's made-up violation for its own script reads nothing", seen, []);
    // The same element and a real violation: the page's own policy can cause one.
    violation(frame, { blockedURI: url, effectiveDirective: "script-src" }, true);
    equal("a real violation for the page's own script reads nothing", seen, []);
  }

  // A style sheet of the page's own, and a content script's, by the same event.
  {
    const frame = await contentFrame(h, "https://site.example/");
    const cssUrl = h.browser.baseURI + "sheet.css";
    const link = element(frame, "link", { href: cssUrl, rel: "stylesheet" });
    frame.sandbox.Node.prototype.appendChild.call(frame.sandbox.document.head, link);
    link.href = privateUrl;
    violation(frame, { blockedURI: privateUrl, effectiveDirective: "style-src" }, true);
    await settle(30);
    equal("a page that changes a link's address does not choose the file",
      frame.context.sheets.map((s) => s.file), []);
    violation(frame, { blockedURI: origin, effectiveDirective: "style-src" }, false);
    await settle(30);
    equal("a made-up violation adds no style sheet", frame.context.sheets.map((s) => s.file), []);
    violation(frame, { blockedURI: origin, effectiveDirective: "style-src" }, true);
    await settle(30);
    equal("a real violation reporting the origin alone adds the link's file",
      frame.context.sheets.map((s) => s.file), ["sheet.css"]);
  }
  undo();
}

// -- finding 14: a fragment's styles ------------------------------------------
async function fragmentStyles() {
  const h = await start({}, {});
  const undo = addMiniDom(h);
  const frame = await contentFrame(h, "https://site.example/");
  undo();
  const style = element(frame, "style", { textContent: "p { color: red }" });
  const fragment = new frame.sandbox.Node();
  Object.assign(fragment, { nodeType: 11, kids: [style], querySelectorAll: () => fragment.kids.slice() });
  frame.sandbox.Node.prototype.appendChild.call(frame.sandbox.document.head, fragment);
  violation(frame, { blockedURI: "inline", effectiveDirective: "style-src-elem" }, true);
  await settle(30);
  equal("a refused style inserted through a fragment is added", frame.context.sheets.map((s) => s.code),
    ["p { color: red }"]);
}

// -- finding 5: the audio frame ------------------------------------------------
async function audioFrame() {
  const h = await start({ backgroundWorker: true, manifest: Object.assign({}, BASE_CONFIG.manifest, {
    background: { service_worker: "worker.js" } }) }, { "audio.html": "<p>" });

  async function host(shadow) {
    const tab = h.window0.openTab();
    tab.url = "https://evil.example/";
    h.window0.activeTab = tab;
    await settle();
    const frame = h.browser.createContentFrame(tab, h.bridge, { url: "https://evil.example/" });
    const doc = frame.sandbox.document;
    const make = doc.createElement;
    let root = null;
    if (shadow) {
      doc.createElement = (tag) => {
        const el = make(tag);
        el.attachShadow = (init) => {
          root = { mode: init.mode, kids: [], appendChild(child) { this.kids.push(child); child.parentNode = this; return child; },
            removeChild(child) { this.kids.splice(this.kids.indexOf(child), 1); child.parentNode = null; return child; } };
          return root;
        };
        return el;
      };
    }
    const created = h.chrome.offscreen.createDocument({ url: "audio.html", reasons: ["AUDIO_PLAYBACK"] }).catch(() => {});
    await settle(80);
    const iframe = doc.__elements.find((el) => el.tagName === "IFRAME");
    return { frame, doc, iframe, root, created, tab };
  }

  const hidden = await host(true);
  const inPage = hidden.doc.body.children.find((el) => el === hidden.iframe);
  const hostElement = hidden.doc.body.children[hidden.doc.body.children.length - 1];
  equal("the audio frame is in a closed shadow root, out of the document the page can read",
    [!!inPage, hidden.root && hidden.root.mode, hidden.root && hidden.root.kids[0] === hidden.iframe,
      hostElement.src === undefined, JSON.stringify(Object.keys(hostElement.attributes)).includes("safari-extension")],
    [false, "closed", true, true, false]);
  equal("and it has the document's address", hidden.iframe.src, h.browser.baseURI + "audio.html");
  const blank = { href: "about:blank" };
  hidden.iframe.contentWindow = { location: blank };
  const said = [];
  const closing = h.chrome.offscreen.hasDocument();
  await closing;
  // The blank document's load is not the extension's: nothing is ready, and creation still waits.
  hidden.iframe.onload();
  await settle(30);
  said.push(await Promise.race([hidden.created.then(() => "created"), settle(20).then(() => "waiting")]));
  blank.href = h.browser.baseURI + "audio.html";
  Object.defineProperty(blank, "href", { get() { throw new Error("another origin"); } });
  hidden.iframe.onload();
  said.push(await Promise.race([hidden.created.then(() => "created"), settle(50).then(() => "waiting")]));
  equal("the frame is ready at the extension's document, not the blank one before it", said, ["waiting", "created"]);
  await h.chrome.offscreen.closeDocument();
  await settle(30);
  equal("and closing takes both the frame and its host from the page",
    [hidden.iframe.parentNode, hidden.doc.body.children.indexOf(hostElement) < 0], [null, true]);

  const plain = await host(false);
  equal("with no shadow root the frame goes in the document, and the audio works",
    [plain.iframe.parentNode === plain.doc.body, plain.iframe.src], [true, h.browser.baseURI + "audio.html"]);
  plain.iframe.onload();
  await plain.created;
  equal("and it opens", await h.chrome.offscreen.hasDocument(), true);
  await h.chrome.offscreen.closeDocument();
}

// -- finding 3: manifest order ----------------------------------------------
async function convertManifest(manifest, files) {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "wex-page-fixes-convert-"));
  fs.writeFileSync(path.join(source, "manifest.json"), JSON.stringify(Object.assign(
    { manifest_version: 3, name: "Order", version: "1" }, manifest)));
  for (const name of Object.keys(files)) {
    fs.writeFileSync(path.join(source, name), files[name]);
  }
  const result = await W2S.convert.convert({ source, files: W2S.node.readDirectory(source),
    runtime: W2S.node.runtime(), convertImage: W2S.node.convertImage });
  const text = Buffer.from(result.files.read("wex/wex-config.js")).toString("utf8");
  const config = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  return Object.assign(config.injectedScripts, { config, files: config.injectedScripts.files, bundle: result.files });
}

async function manifestOrder() {
  const all = ["<all_urls>"];
  const atStart = "document_start";
  const plain = "var a = 1;\n";
  // Valid script the scanner cannot follow: `/` after `}` reads as a regular expression.
  const unfollowed = "var o = {}/2; var s = \"/\";\n";

  let injected = await convertManifest({ content_scripts: [
    { matches: all, js: ["content.js"], run_at: atStart },
    { matches: all, js: ["inject.js"], run_at: atStart, world: "MAIN" }] }, { "content.js": plain, "inject.js": plain });
  equal("a MAIN script is the engine's, and an isolated one before it in its phase stays a copy Safari injects",
    [injected.start, injected.files, injected.config.pageWorldScripts],
    [["wex/content/0/content.js"], { "0:0": true }, [{ allFrames: false, excludeMatches: [], id: "wex.main.1",
      js: ["inject.js"], matchOriginAsFallback: false, matches: all, runAt: atStart }]]);

  injected = await convertManifest({ content_scripts: [
    { matches: all, js: ["lib.js", "app.js"] }] }, { "lib.js": plain, "app.js": unfollowed });
  equal("a file before one the scanner cannot follow is left to the bridge",
    [injected.end, injected.files], [[], {}]);

  injected = await convertManifest({ content_scripts: [
    { matches: all, js: ["inject.js"], world: "MAIN" },
    { matches: all, js: ["a.js", "b.js"] }] }, { "inject.js": plain, "a.js": plain, "b.js": plain });
  equal("files after the last one the bridge runs stay copies Safari injects",
    [injected.end, injected.files], [["wex/content/1/a.js", "wex/content/1/b.js"], { "1:0": true, "1:1": true }]);

  injected = await convertManifest({ content_scripts: [
    { matches: all, js: ["early.js"], run_at: atStart },
    { matches: all, js: ["inject.js"], world: "MAIN", run_at: atStart },
    { matches: all, js: ["late.js"] }] }, { "early.js": plain, "inject.js": plain, "late.js": plain });
  equal("copies stay in both phases around a MAIN script",
    [injected.start, injected.end, injected.files],
    [["wex/content/0/early.js"], ["wex/content/2/late.js"], { "0:0": true, "2:0": true }]);

  injected = await convertManifest({ content_scripts: [
    { matches: all, js: ["globbed.js"], world: "MAIN", include_globs: ["*://*/keep*"], exclude_globs: ["*skip*"] }] },
  { "globbed.js": "let shared = 1;\nwindow.__globbedRan = shared;\n" });
  const globbed = injected.config.pageWorldScripts[0];
  const runGlobbed = (href) => {
    const page = { location: { href } };
    page.window = page;
    vm.runInNewContext(Buffer.from(injected.bundle.read(globbed.js[0])).toString("utf8"), page);
    return page.__globbedRan;
  };
  equal("a MAIN script with globs runs from a copy that asks them first",
    [globbed.js, runGlobbed("https://a.example/keep/1"), runGlobbed("https://a.example/other"),
      runGlobbed("https://a.example/keep/skip")],
    [["wex/main/0/globbed.js"], 1, undefined, undefined]);

  injected = await convertManifest({ content_scripts: [
    { matches: all, js: ["a.js", "b.js"], run_at: atStart },
    { matches: all, js: ["c.js"] }] }, { "a.js": plain, "b.js": plain, "c.js": plain });
  equal("an extension with nothing for the bridge to run keeps every copy, and the frames' reads it saves",
    [injected.start, injected.end, injected.files],
    [["wex/content/0/a.js", "wex/content/0/b.js"], ["wex/content/1/c.js"], { "0:0": true, "0:1": true, "1:0": true }]);

  // And the order the bridge then runs them in.
  const h = await start({
    injectedScripts: { files: {}, start: [], end: [] },
    contentScripts: [
      { matches: ["*://order.example/*"], js: ["content.js"], css: [], run_at: atStart },
      { matches: ["*://order.example/*"], js: ["inject.js"], css: [], run_at: atStart, world: "MAIN" }]
  }, { "content.js": "window.__heardAtInject = 'listening';", "inject.js": "window.__injectSawContent = 1;" });
  const frame = await contentFrame(h, "https://order.example/");
  equal("the bridge runs the isolated script, and nothing of the MAIN one",
    [frame.sandbox.__heardAtInject, frame.sandbox.__injectSawContent,
      frame.sandbox.document.__elements.some((el) => /__injectSawContent/.test(el.textContent || ""))],
    ["listening", undefined, false]);
}

// -- finding 4: style sheets at document_start -------------------------------
async function sheetTiming() {
  const groups = [{ matches: ["*://css.example/*"], js: ["c.js"], css: ["content.css"], all_frames: false }];
  const files = { "c.js": "window.__ran = 1;", "content.css": "p { color: red }" };
  const chromeBuild = await start({ contentScripts: groups, injectedScripts: { files: {}, start: [], end: [] } }, files);
  let frame = await contentFrame(chromeBuild, "https://css.example/");
  await settle(50);
  equal("a Chrome build's style sheets go in as the document starts, whatever run_at says, before the scripts",
    [frame.context.sheets.map((s) => s.file), frame.sandbox.__ran], [["content.css"], undefined]);
  vm.runInContext(fs.readFileSync(chromeBuild.wex("wex-run-end.js"), "utf8"), frame.context.vmContext);
  await settle(50);
  equal("and only once", [frame.context.sheets.length, frame.sandbox.__ran], [1, 1]);

  const firefoxBuild = await start({ firefoxBuild: true, contentScripts: groups,
    injectedScripts: { files: {}, start: [], end: [] } }, files);
  frame = await contentFrame(firefoxBuild, "https://css.example/");
  await settle(50);
  const atStart = frame.context.sheets.length;
  vm.runInContext(fs.readFileSync(firefoxBuild.wex("wex-run-end.js"), "utf8"), frame.context.vmContext);
  await settle(50);
  equal("a Firefox build keeps them with the group's scripts", [atStart, frame.context.sheets.length], [0, 1]);
}

// -- finding 6: a frame in the popover ----------------------------------------
async function popoverFrame() {
  const h = await start({ autoSizePopover: true }, {});
  const sizes = [];
  const popover = h.browser.popover;
  const held = { width: popover.width, height: popover.height };
  for (const side of ["width", "height"]) {
    Object.defineProperty(popover, side, { configurable: true, get: () => held[side],
      set: (value) => { held[side] = value; sizes.push(side); } });
  }
  const shape = (width, height) => ({ scrollWidth: width, scrollHeight: height,
    getBoundingClientRect: () => ({ top: 0, width, height }), getAttribute: () => null,
    setAttribute() {}, removeAttribute() {}, style: { setProperty() {} } });

  const realBase = h.browser.baseGlobals.bind(h.browser);
  const topPage = h.browser.createExtensionPage(h.pageScripts, h.browser.baseURI + "popup.html");
  h.browser.baseGlobals = (label) => Object.assign(realBase(label), { top: topPage, parent: topPage });
  const inner = h.browser.createExtensionPage(h.pageScripts, h.browser.baseURI + "inner.html");
  h.browser.baseGlobals = realBase;
  popover.contentWindow = topPage;
  inner.document.documentElement = shape(210, 90);
  inner.document.body = shape(210, 90);
  inner.getComputedStyle = () => ({ position: "relative", marginBottom: "0px" });
  let hidden = 0;
  popover.hide = () => { hidden += 1; };
  inner.dispatchEvent(new inner.Event("load"));
  inner.close();
  equal("a frame in the popover neither resizes nor hides it", [sizes, hidden], [[], 0]);
  topPage.document.documentElement = shape(320, 200);
  topPage.document.body = shape(320, 200);
  topPage.getComputedStyle = () => ({ position: "relative", marginBottom: "0px" });
  topPage.dispatchEvent(new topPage.Event("load"));
  topPage.close();
  equal("the popup itself does both", [sizes.sort(), hidden], [["height", "width"], 1]);
}

// -- finding 7: scripts in the page's world ---------------------------------
async function mainWorld() {
  const h = await start({}, { "value.js": "40 + 2" });
  const frame = await contentFrame(h, "https://site.example/");
  const tabId = frame.tab ? frame.tab.engineId : (await h.chrome.tabs.query({ url: "https://site.example/*" }))[0].id;
  const engine = h.globalPage.WEX.native.scripting;
  const lastCall = () => engine.calls[engine.calls.length - 1];
  const run = (details) => h.chrome.scripting.executeScript(Object.assign({ target: { tabId }, world: "MAIN" }, details));
  equal("a function goes to the engine's call, and its value comes back",
    (await run({ func: function (a) { return a + 1; }, args: [1] })).map((r) => [r.frameId, r.result]), [[0, 2]]);
  equal("as a call for the page's world", [lastCall().world, lastCall().target, lastCall().args], ["MAIN", { tabId }, [1]]);
  const file = await run({ files: ["/value.js"], injectImmediately: true });
  equal("and so does a file", [file[0].result, lastCall().files, lastCall().injectImmediately], [42, ["value.js"], true]);
  equal("a result carries this runtime's document id, as every context knows it",
    file[0].documentId, (await h.chrome.webNavigation.getFrame({ tabId, frameId: 0 })).documentId);
  equal("nothing given back is null", (await run({ func: function () {} }))[0].result, null);
  await run({ func: function () {}, target: { tabId, allFrames: true } });
  equal("all frames are asked for", lastCall().target, { tabId, allFrames: true });
  await run({ func: function () {}, target: { tabId, documentIds: [file[0].documentId] } });
  equal("a document goes as its frame", lastCall().target, { tabId, frameIds: [0] });
  const before = engine.calls.length;
  const refused = await run({ func: function () {}, target: { tabId, documentIds: ["NO-SUCH-DOCUMENT"] } }).then(() => "ran", (e) => e.message);
  equal("and one that is no document is refused without asking",
    [refused, engine.calls.length - before], ["No document with id NO-SUCH-DOCUMENT in tab with id " + tabId, 0]);
  const exec = (job) => {
    try {
      return frame.sandbox.WEXContent.exec(job).result;
    } catch (e) {
      return /content-script world only/.test(e.message) ? "refused" : "threw " + e.message;
    }
  };
  const func = String(function () { return 7; });
  equal("the content bridge's exec runs a job in its own world, named or not",
    [exec({ func }), exec({ func, world: "ISOLATED" })], [7, 7]);
  equal("and refuses one for the page's world, which it cannot reach",
    [exec({ func, world: "MAIN" }), exec({ func, world: "USER_SCRIPT" })], ["refused", "refused"]);
}

// -- finding 8: one event for one move ----------------------------------------
async function historyEvents() {
  const h = await start({}, {});
  const seen = [];
  h.chrome.webNavigation.onReferenceFragmentUpdated.addListener((d) => seen.push("fragment " + d.url));
  h.chrome.webNavigation.onHistoryStateUpdated.addListener((d) => seen.push("history " + d.url));
  const frame = h.browser.createContentFrame(h.tab, h.bridge, { url: "https://example.com/page" });
  const fire = (type, fields) => frame.sandbox.dispatchEvent(Object.assign(new frame.sandbox.Event(type), fields));

  frame.sandbox.location.href = "https://example.com/page#b";
  fire("popstate");
  fire("hashchange", { oldURL: "https://example.com/page", newURL: "https://example.com/page#b" });
  await settle(100);
  equal("a fragment move with both events is one fragment event", seen, ["fragment https://example.com/page#b"]);

  seen.length = 0;
  frame.sandbox.location.href = "https://example.com/page2";
  fire("popstate");
  await settle(100);
  equal("a history move alone is a history event", seen, ["history https://example.com/page2"]);

  seen.length = 0;
  frame.sandbox.location.href = "https://example.com/page3#c";
  fire("popstate");
  fire("hashchange", { oldURL: "https://example.com/page2", newURL: "https://example.com/page3#c" });
  await settle(100);
  equal("a move that changes more than the fragment is one history event", seen, ["history https://example.com/page3#c"]);

  seen.length = 0;
  frame.sandbox.location.href = "https://example.com/page3#d";
  fire("hashchange", { oldURL: "https://example.com/page3#c", newURL: "https://example.com/page3#d" });
  await settle(100);
  equal("hashchange alone is a fragment event", seen, ["fragment https://example.com/page3#d"]);

  seen.length = 0;
  frame.sandbox.location.href = "https://example.com/page3#f";
  fire("hashchange", { oldURL: "https://example.com/page3#d", newURL: "https://example.com/page3#e" });
  fire("hashchange", { oldURL: "https://example.com/page3#e", newURL: "https://example.com/page3#f" });
  await settle(100);
  equal("two quick moves are told each by its own address", seen,
    ["fragment https://example.com/page3#e", "fragment https://example.com/page3#f"]);
}

// -- style sheets before the first paint --------------------------------------
async function earlyStyleSheets() {
  const h = await start({
    contentScripts: [{ matches: ["https://site.example/*"], css: ["a.css", "b.css"], js: [], run_at: "document_start" }],
    earlySheets: { "a.css": "html{--a:1}" }
  }, { "a.css": "html{--a:1}", "b.css": "html{background:url(x.png)}" });
  const realBase = h.browser.baseGlobals.bind(h.browser);
  h.browser.baseGlobals = (label) => {
    const g = realBase(label);
    g.CSSStyleSheet = class {
      replaceSync(text) {
        this.text = text;
      }
    };
    g.document.adoptedStyleSheets = [];
    return g;
  };
  const tab = h.window0.openTab("background");
  tab.url = "https://site.example/";
  await settle();
  const frame = h.browser.createContentFrame(tab, h.bridge, { url: "https://site.example/" });
  equal("a frame shows the sheet the converter kept as it starts, and only that",
    frame.sandbox.document.adoptedStyleSheets.map((sheet) => sheet.text), ["html{--a:1}"]);
  await settle(100);
  equal("and takes it away once the engine has added its own", frame.sandbox.document.adoptedStyleSheets, []);
}

// -- findings 9 and 10: namespaces and views ----------------------------------
async function namespaces() {
  const h = await start({}, {});
  await settle(100);
  const page = h.browser.createExtensionPage(h.pageScripts, h.browser.baseURI + "popup.html");
  const run = (code, where) => {
    try {
      return vm.runInContext(code, where || page);
    } catch (e) {
      return e.name;
    }
  };
  equal("a namespace stand-in has what every object has",
    [run("chrome.tabs.hasOwnProperty('query')"), run("chrome.tabs.hasOwnProperty('nothing')"),
      run("typeof chrome.tabs.toString"), run("typeof ('' + chrome.tabs)"), run("typeof chrome.tabs.query.toString")],
    [true, false, "function", "string", "function"]);
  equal("and `in` does not break on a method's own members",
    [run("'prototype' in chrome.tabs.query"), run("'query' in chrome.tabs"), run("'nothing' in chrome.tabs")],
    [true, true, false]);
  equal("a missing member is still missing", run("typeof chrome.tabs.nothing"), "undefined");

  const views = (where) => JSON.parse(run(`JSON.stringify([
    chrome.extension.getViews().length, chrome.extension.getViews({}).length,
    chrome.extension.getViews({ type: "popup" }).length, chrome.extension.getViews({ type: "tab" }).length,
    chrome.extension.getViews({ tabId: 5 }).length])`, where));
  equal("the popup finds itself among popups and not among tabs", views(page), [1, 1, 1, 0, 0]);
  const tab = h.window0.openTab("background");
  await settle();
  const options = h.browser.createTabPage(tab, h.pageScripts, h.browser.baseURI + "options.html");
  equal("a page in a tab finds itself among tabs and not among popups, listed for any tab until it knows its own",
    views(options), [1, 1, 0, 1, 1]);
  await settle(50);
  const current = await new Promise((resolve) => {
    options.__ownTab = resolve;
    vm.runInContext("chrome.tabs.getCurrent().then(__ownTab)", options);
  });
  const listed = (filter) => run(`chrome.extension.getViews(${JSON.stringify(filter)}).length`, options);
  equal("once it does, it is listed for its own tab and window alone",
    [listed({ tabId: current.id }), listed({ tabId: current.id + 1 }), listed({ windowId: current.windowId }),
      listed({ windowId: current.windowId + 1 }), listed({ windowId: -2 })], [1, 0, 1, 0, 1]);
}

// -- finding 11: devtools in a Firefox build ----------------------------------
async function devtoolsEval() {
  const source = fs.readFileSync(path.join(RUNTIME, "wex-devtools.js"), "utf8").replace(/\}\)\(this\);\s*$/, "})(__g);");
  const listeners = [];
  const port = {
    onMessage: { addListener: (fn) => listeners.push(fn) },
    onDisconnect: { addListener() {} },
    postMessage(m) {
      setImmediate(() => listeners.forEach((fn) => fn(Object.assign({ id: m.id },
        m.expression === "bad" ? { info: { isException: true, value: "boom" } } : m.op === "eval" ? { result: 42 } : {}))));
    }
  };
  const make = (firefoxBuild) => {
    const parts = () => ({ style: {}, appendChild() {}, addEventListener() {} });
    const g = { location: { pathname: "/wex/wex-devtools-window.html", search: "?tab=5" }, setInterval: () => 0,
      document: { body: parts(), head: parts(), createElement: parts, getElementById: parts, title: "" },
      chrome: { tabs: { get: () => Promise.resolve({}), getCurrent() {}, remove() {} } } };
    class Event { addListener() {} emit() {} }
    new Function("WEX", "__g", source)({ CONFIG: { devtoolsWindowPage: "d.html", name: "X", firefoxBuild },
      native: { runtime: { connect: () => port } }, INTERNAL_PORT: "w:", Event,
      extUrl: (p) => p, done: (cb, v) => Promise.resolve(v), fail: (cb, m) => Promise.reject(new Error(m)) }, g);
    return g.__wexDevtoolsHost.devtools.inspectedWindow;
  };
  const firefox = make(true);
  equal("a Firefox build's eval gives the array Firefox gives",
    [await firefox.eval("good"), await firefox.eval("bad")],
    [[42, null], [null, { isException: true, value: "boom" }]]);
  const chrome = make(false);
  equal("a Chrome build's promise gives the result, and rejects on an exception",
    [await chrome.eval("good"), await chrome.eval("bad").catch((e) => e.value)], [42, "boom"]);
  equal("and the callback form is the same for both",
    await new Promise((resolve) => firefox.eval("good", (result, info) => resolve([result, info === undefined]))),
    [42, true]);
}

// -- finding 12: ports inside a worker's message ------------------------------
async function workerPorts() {
  const h = await start({ backgroundWorker: true, manifest: Object.assign({}, BASE_CONFIG.manifest, {
    background: { service_worker: "worker.js" } }) }, {});
  await settle(50);
  const page = h.browser.createExtensionPage(h.pageScripts, h.browser.baseURI + "popup.html");
  const heard = [];
  page.navigator.serviceWorker.addEventListener("message", (e) => heard.push(e));
  const client = (await h.globalPage.clients.matchAll()).slice(-1)[0];
  const channel = new MessageChannel();
  const other = new MessageChannel();
  let thrown = null;
  try {
    client.postMessage({ port: channel.port1, n: 1 }, [channel.port1]);
    client.postMessage({ n: 2 }, [other.port1]);
  } catch (e) {
    thrown = e.name;
  }
  await settle(30);
  equal("a worker's message with a port inside its data reaches the page",
    [thrown, heard.map((e) => [e.data.n, e.ports.length]), !!(heard[0] && heard[0].data.port)],
    [null, [[1, 1], [2, 1]], true]);
  let answer = null;
  if (heard[0]) {
    const echoed = new Promise((resolve) => { channel.port2.onmessage = (e) => resolve(e.data); });
    heard[0].data.port.postMessage("through");
    answer = await Promise.race([echoed, settle(100).then(() => "nothing")]);
  }
  equal("and the port it carries works", answer, "through");
  [channel.port1, channel.port2, other.port1, other.port2].forEach((p) => p.close());
  if (heard[0] && heard[0].data.port) {
    heard[0].data.port.close();
  }
  heard.forEach((e) => e.ports.forEach((p) => p.close()));
}

// -- finding 13: keydown in the popover ---------------------------------------
async function popoverKeys() {
  const h = await start({}, {});
  const realBase = h.browser.baseGlobals.bind(h.browser);
  h.browser.baseGlobals = (label) => {
    const g = realBase(label);
    const list = [];
    const proto = {
      addEventListener(type, fn) { list.push([type, fn]); },
      removeEventListener(type, fn) {
        const i = list.findIndex((entry) => entry[0] === type && entry[1] === fn);
        if (i >= 0) {
          list.splice(i, 1);
        }
      }
    };
    g.EventTarget = function () {};
    g.EventTarget.prototype = proto;
    delete g.addEventListener;
    delete g.removeEventListener;
    Object.setPrototypeOf(g, proto);
    g.__fire = (e) => list.filter((entry) => entry[0] === e.type).slice().forEach((entry) => entry[1](e));
    return g;
  };
  const page = h.browser.createExtensionPage(h.pageScripts, h.browser.baseURI + "popup.html");
  h.browser.baseGlobals = realBase;
  const heard = [];
  page.__log = (value) => heard.push(value);
  vm.runInContext("addEventListener('keydown', function (e) { __log(e.defaultPrevented); });", page);
  const key = { type: "keydown", key: "j", defaultPrevented: false, target: null, metaKey: false, ctrlKey: false,
    altKey: false, preventDefault() { this.defaultPrevented = true; } };
  page.__fire(key);
  equal("a bare addEventListener hears a key before the popover silences it, which it then does",
    [heard, key.defaultPrevented], [[false], true]);
}

// -- a site framed by the extension's page ------------------------------------
// A site in a frame of the extension's page, recognising the extension by
// its ancestor origin with a pattern for a Chrome address.
async function framedSite() {
  // A Chrome build whose id comes from its manifest's key, and its page-world
  // script as the converter writes it, which the engine runs in a site's
  // own world.
  const { publicKey } = require("crypto").generateKeyPairSync("rsa", { modulusLength: 1024 });
  const key = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const converted = await convertManifest({ key, content_scripts: [{ matches: ["<all_urls>"], js: ["c.js"] }],
    web_accessible_resources: [{ resources: ["panel.html"], matches: ["<all_urls>"] }] }, { "c.js": "1;" });
  const CHROME_ORIGIN = converted.config.webOrigin || converted.config.sourceOrigin;
  const chromeId = CHROME_ORIGIN.slice("chrome-extension://".length);
  const safariOrigin = "safari-extension://com.webext2safari." + chromeId + "-team123";
  const registration = converted.config.pageWorldScripts.find((spec) => spec.id === "wex.page-world");
  const pageWorldSource = Buffer.from(converted.bundle.read("wex/page-world.js")).toString("utf8");
  const pageWorld = (ancestorOrigins, isTop) => {
    // WebKit's URL, which gives a safari-extension: URL its scheme and host
    // as its origin, and other URLs of a scheme it does not know "null"; a
    // MessageEvent whose origin and source are getters; and the frame's
    // parent, which records what is posted to it.
    const world = vm.createContext({ NodeURL: URL, ancestorOrigins, isTop });
    vm.runInContext("class URL { constructor(u, b) { this.u = new NodeURL(u, b); } get href() { return this.u.href; } }" +
      "Object.defineProperty(URL.prototype, 'protocol', { configurable: true, get() { return this.u.protocol; } });" +
      "Object.defineProperty(URL.prototype, 'host', { configurable: true, get() { return this.u.host; } });" +
      "Object.defineProperty(URL.prototype, 'origin', { configurable: true, get() {" +
      "  return this.u.protocol === 'safari-extension:' ? 'safari-extension://' + this.u.host : this.u.origin; } });" +
      "class MessageEvent { constructor(type, init) { this.type = type; this.data = init.data;" +
      "  this.realOrigin = init.origin; this.realSource = init.source; } }" +
      "Object.defineProperty(MessageEvent.prototype, 'origin', { configurable: true, get() { return this.realOrigin; } });" +
      "Object.defineProperty(MessageEvent.prototype, 'source', { configurable: true, get() { return this.realSource; } });" +
      "class CustomEvent { constructor(type, init) { this.type = type; this.detail = init.detail; } }" +
      "var opened = []; var dispatched = [];" +
      "var document = { dispatchEvent(e) { dispatched.push([e.type, e.detail]); } };" +
      "var posted = []; var realParent = { closed: false, postMessage(m, t) { posted.push([m, t]); } };" +
      "var window = { parent: realParent, open(u) { opened.push(u); return 'site window'; } };" +
      "window.top = isTop ? window : {}; window.window = window;" +
      "var location = { href: 'https://site.example/panel', ancestorOrigins: ancestorOrigins };",
    world);
    vm.runInContext("(function (window) {" + pageWorldSource + "}).call(window, window)", world);
    return { run: (source) => vm.runInContext(source, world) };
  };
  equal("the extension's page-world script runs in every frame of the pages the bridge goes into, as they start",
    [registration.matches, registration.allFrames, registration.runAt], [converted.config.bridgeWhitelist, true, "document_start"]);
  const framed = pageWorld([safariOrigin], false);
  const recognise = "(function (o) { var m = o.match(/^chrome-extension:\\/\\/([a-p]{32})$/); return m && m[1]; })";
  equal("a site framed by the extension's page recognises it by its Chrome origin",
    [framed.run(recognise + "(" + JSON.stringify(safariOrigin) + ")"),
      framed.run(recognise + "(" + JSON.stringify(safariOrigin.toUpperCase()) + ")"),
      framed.run("/^chrome-extension:/.test(" + JSON.stringify(safariOrigin) + ")"),
      framed.run("(/^chrome-extension:\\/\\/(\\w+)/).exec(" + JSON.stringify(safariOrigin) + ")[1]")],
    [chromeId, chromeId, true, chromeId]);
  equal("a pattern that matches the Safari origin, and any other string, answer as they are",
    [framed.run("/^safari-extension:\\/\\/(.+)$/.exec(" + JSON.stringify(safariOrigin) + ")[1]"),
      framed.run("'https://site.example'.match(/^chrome-extension:/)"),
      framed.run("/^chrome-extension:/.test('safari-extension://other.bundle')"),
      framed.run("String.prototype.match.length + RegExp.prototype.exec.length + RegExp.prototype.test.length")],
    [safariOrigin.slice("safari-extension://".length), null, false, 3]);
  equal("the URL origins of the extension's Safari and Chrome addresses are its Chrome origin",
    [framed.run("new URL(" + JSON.stringify(safariOrigin) + ").origin"),
      framed.run("new URL(" + JSON.stringify(CHROME_ORIGIN + "/panel.html") + ").origin"),
      framed.run("new URL('chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba').origin"),
      framed.run("new URL('https://site.example/a').origin"),
      framed.run("new URL('safari-extension://other.bundle/').origin"),
      framed.run("new URL('moz-extension://abc/').origin")],
    [CHROME_ORIGIN, CHROME_ORIGIN, "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba", "https://site.example",
      "safari-extension://other.bundle", "null"]);
  equal("the extension's page sends from its Chrome origin, and what the site posts to that origin reaches it",
    JSON.parse(framed.run("(function () {" +
      "var fromPage = new MessageEvent('message', { origin: " + JSON.stringify(safariOrigin) + ", source: realParent });" +
      "var fromSite = new MessageEvent('message', { origin: 'https://other.example', source: {} });" +
      "window.parent.postMessage({ a: 1 }, " + JSON.stringify(CHROME_ORIGIN) + ");" +
      "window.parent.postMessage('b', { targetOrigin: " + JSON.stringify(CHROME_ORIGIN + "/") + " });" +
      "window.parent.postMessage('c', 'https://other.example');" +
      "return JSON.stringify([fromPage.origin, fromPage.source === window.parent, window.parent === window.parent," +
      "  window.parent !== realParent, window.parent.closed, fromSite.origin, fromSite.source === window.parent," +
      "  posted.map(function (p) { return typeof p[1] === 'object' ? p[1].targetOrigin : p[1]; })]); })()")),
    [CHROME_ORIGIN, true, true, true, false, "https://other.example", false,
      [safariOrigin, safariOrigin, "https://other.example"]]);
  const otherAncestor = pageWorld(["https://elsewhere.example"], false);
  const topFrame = pageWorld([], true);
  equal("a frame another site's page holds, and a top frame, are left alone",
    [otherAncestor.run("/^chrome-extension:/.test(" + JSON.stringify(safariOrigin) + ")"),
      topFrame.run("/^chrome-extension:/.test(" + JSON.stringify(safariOrigin) + ")")], [false, false]);
  equal("a site's window.open of the extension's page is told to the extension's side, and others open",
    JSON.parse(topFrame.run("JSON.stringify([window.open(" + JSON.stringify(CHROME_ORIGIN + "/panel.html") + ").closed," +
      " window.open('https://other.example/'), dispatched, opened])")),
    [false, "site window", [["wex-open:" + CHROME_ORIGIN, CHROME_ORIGIN + "/panel.html"]], ["https://other.example/"]]);
  const firefox = await convertManifest({ content_scripts: [{ matches: ["<all_urls>"], js: ["c.js"] }],
    browser_specific_settings: { gecko: { id: "order@example" } } }, { "c.js": "1;" });
  equal("a Firefox build, whose browser gives no ancestor origins, puts nothing into a site's world",
    firefox.config.pageWorldScripts, []);
}

async function main() {
  for (const test of [refusedScripts, fragmentStyles, audioFrame, manifestOrder, sheetTiming, popoverFrame,
    mainWorld, historyEvents, earlyStyleSheets, namespaces, devtoolsEval, workerPorts, popoverKeys, framedSite]) {
    try {
      await test();
    } catch (e) {
      failures.push(test.name + " threw: " + (e && e.stack || e));
    }
  }
  failures.forEach((failure) => console.log("FAIL " + failure));
  console.log(passed + " checks passed, " + failures.length + " failed");
  process.exit(failures.length ? 1 : 0);
}

main();
