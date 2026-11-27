// Offscreen lifecycle and messaging in a simulated Safari.
// node tests/offscreen.js
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { FakeBrowser } = require("./fake-safari");
const W2S = require("../webext2safari/js/node.js");
const wait = () => new Promise(resolve => setTimeout(resolve, 50));

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wex-offscreen-"));
  fs.cpSync(path.join(__dirname, "../webext2safari/runtime"), path.join(root, "wex"),
    { recursive: true });
  fs.writeFileSync(path.join(root, "wex/wex-config.js"),
    "var WEX_CONFIG = " + JSON.stringify({ extensionId: "test.offscreen",
      manifest: { name: "Offscreen fixture", version: "1", background: {service_worker: "workers/tasks.mjs"},
        permissions: ["offscreen"] },
      backgroundPage: "wex-global-page.html", backgroundWorker: true, contentScripts: [] }) + ";");
  fs.writeFileSync(path.join(root, "audio.html"),
    '<script src="wex/wex-config.js"></script><script src="wex/wex-core.js"></script>' +
    '<script src="wex/wex-page.js"></script><script src="audio.js"></script>');
  fs.writeFileSync(path.join(root, "audio.js"),
    'chrome.runtime.onMessage.addListener((m, sender) => m.sender ? Promise.resolve(' +
    '"chrome-extension://" + sender.id + "/workers/tasks.mjs" === sender.url) : ' +
    'm.ping ? Promise.resolve("pong") : undefined);');
  // The converter adapts the extension's own address, as it would in a bundle.
  const tree = W2S.node.readDirectory(root);
  assert.strictEqual(W2S.javascript.adaptChromeOrigins(tree, ["wex"]), 1);
  fs.writeFileSync(path.join(root, "audio.js"), tree.read("audio.js"));
  return root;
}

// Model the browser loading an iframe's HTML/scripts in a separate host realm.
function harness(root) {
  const browser = new FakeBrowser(root, { bundleId: "test.offscreen", popup: false });
  const wex = name => path.join(root, "wex", name);
  const global = browser.createGlobalPage([
    wex("wex-config.js"), wex("wex-core.js"), wex("wex-global.js")
  ]);
  const frames = [];
  let holdLoads = false;
  function attachFrames(owner, tab) {
    for (const parent of [owner.document.body, owner.document.documentElement]) {
      const append = parent.appendChild;
      const remove = parent.removeChild;
      parent.appendChild = function (frame) {
        append.call(this, frame);
        if (frame.tagName !== "IFRAME") return frame;
        frames.push(frame);
        frame.finishLoad = () => {
          if (!frame.parentNode) return;
          const sandbox = browser.baseGlobals("offscreen");
          sandbox.location = { href: frame.src, protocol: "safari-extension:" };
          sandbox.window = sandbox.self = sandbox;
          sandbox.parent = owner;
          sandbox.safari = { extension: tab ? { baseURI: browser.baseURI } : browser.extensionObject() };
          const context = browser.engine.addContext("host", { url: frame.src, sandbox,
            tab: tab || null, frameId: tab ? browser.engine.nextFrameId++ : 0 });
          frame.engineContext = context;
          sandbox.browser = context.browser;
          const nativeFetch = sandbox.fetch;
          sandbox.fetch = url => nativeFetch(new URL(url, frame.src).href);
          frame.contentWindow = sandbox;
          const html = browser.readBundleFile(frame.src);
          const scripts = Array.from(html.matchAll(/<script\b[^>]*src="([^"]+)"[^>]*>/g),
            m => path.join(root, new URL(m[1], frame.src).href.slice(browser.baseURI.length)));
          browser.run(sandbox, scripts);
          if (frame.onload) frame.onload();
        };
        if (!holdLoads) setTimeout(frame.finishLoad, 0);
        return frame;
      };
      parent.removeChild = function (frame) {
        if (frame.engineContext) frame.engineContext.alive = false;
        return remove.call(this, frame);
      };
    }
  }
  attachFrames(global);
  function contentPage(url) {
    const window = browser.activeBrowserWindow || browser.openWindow();
    const tab = window.openTab("foreground");
    tab.url = url;
    const { sandbox } = browser.createContentFrame(tab, []);
    const pagehide = [];
    sandbox.addEventListener = (name, fn) => { if (name === "pagehide") pagehide.push(fn); };
    sandbox.removeEventListener = (name, fn) => {
      const i = pagehide.indexOf(fn);
      if (name === "pagehide" && i >= 0) pagehide.splice(i, 1);
    };
    browser.run(sandbox, [wex("wex-config.js"), wex("wex-core.js"), wex("wex-content.js")]);
    attachFrames(sandbox, tab);
    return { tab, sandbox, disconnect: () => pagehide.slice().forEach(fn => fn()) };
  }
  return { browser, global, frames, contentPage, hold: value => { holdLoads = value; } };
}

// A worker's offscreen document talks to it through navigator.serviceWorker,
// with the ports it transfers, and the worker answers through its clients.
async function workerChannel() {
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, "worker.html"),
      '<script src="wex/wex-config.js"></script><script src="wex/wex-core.js"></script>' +
      '<script src="wex/wex-page.js"></script><script src="worker.js"></script>');
    fs.writeFileSync(path.join(root, "worker.js"), [
      "window.__got = [];",
      "navigator.serviceWorker.onmessage = (e) => window.__got.push(['page', e.data,",
      "  e.source === navigator.serviceWorker.controller]);",
      "navigator.serviceWorker.ready.then((registration) => {",
      "  const channel = new MessageChannel();",
      "  channel.port1.onmessage = (e) => { window.__got.push(['port', e.data]); channel.port1.close(); };",
      "  registration.active.postMessage('hello', [channel.port2]);",
      "});"
    ].join("\n"));
    const h = harness(root);
    let received = null;
    h.global.onmessage = (e) => {
      received = [e.data, e.ports.length, e.source && e.source.url];
      e.ports[0].postMessage("reply");
      e.ports[0].close();
    };
    await h.global.chrome.offscreen.createDocument({ url: "worker.html", reasons: ["DOM_PARSER"] });
    await wait();
    assert.deepStrictEqual(received, ["hello", 1, h.global.chrome.runtime.getURL("worker.html")]);
    const clients = await h.global.clients.matchAll();
    assert.strictEqual(clients.length, 1);
    assert.strictEqual(clients[0].url, h.global.chrome.runtime.getURL("worker.html"));
    clients[0].postMessage("to the page");
    await wait();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(h.frames[0].contentWindow.__got)),
      [["port", "reply"], ["page", "to the page", true]]);
    await h.global.chrome.offscreen.closeDocument();
    console.log("Worker messaging with the offscreen document, ports and clients passed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function lifecycle() {
  const root = fixture();
  try {
    const h = harness(root);
    const { runtime, offscreen } = h.global.chrome;
    const contexts = () => runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    assert.strictEqual(await offscreen.hasDocument(), false);
    assert.strictEqual((await contexts()).length, 0);
    assert.strictEqual((await runtime.getContexts({ contextTypes: ["BACKGROUND"] })).length, 1);
    for (const url of ["https://example.com/a.html", "../a.html", "/../a.html",
      "safari-extension://test.offscreen.evil/token/a.html", "missing.html"]) {
      await assert.rejects(offscreen.createDocument({ url, reasons: ["DOM_PARSER"] }));
      assert.strictEqual(await offscreen.hasDocument(), false);
    }
    h.hold(true);
    let loaded = false;
    const pending = offscreen.createDocument({ url: "/audio.html", reasons: ["DOM_PARSER"] }).then(() => { loaded = true; });
    await wait();
    assert.strictEqual(loaded, false, "creation must await the document's scripts");
    assert.strictEqual((await contexts()).length, 0);
    await assert.rejects(offscreen.createDocument({ url: "audio.html", reasons: ["DOM_PARSER"] }), /single/);
    h.frames[0].finishLoad();
    await pending;
    assert.strictEqual(await runtime.sendMessage({ ping: true }), "pong");
    assert.strictEqual(await runtime.sendMessage({ sender: true }), true,
      "generic Chrome URL construction agrees with the manifest worker sender");
    assert.strictEqual(h.global.WEX.chromeExtensionOrigin("other-extension"), "chrome-extension://other-extension");
    assert.strictEqual(await offscreen.hasDocument(), true);
    const context = (await contexts())[0];
    assert.strictEqual(context.documentUrl, runtime.getURL("audio.html"));
    for (const filter of [{ documentUrls: [runtime.getURL("other.html")] },
      { contextIds: [] }, { incognito: true }, { tabIds: [1] }]) {
      assert.strictEqual((await runtime.getContexts(filter)).length, 0);
    }
    assert.strictEqual((await runtime.getContexts({ contextIds: [context.contextId] })).length, 1);
    assert.strictEqual((await new Promise(resolve => runtime.getContexts(
      { documentUrls: [context.documentUrl] }, resolve))).length, 1);
    await offscreen.closeDocument();
    assert.strictEqual(h.frames[0].parentNode, null);
    assert.strictEqual(await offscreen.hasDocument(), false);
    assert.strictEqual((await contexts()).length, 0);
    await assert.rejects(offscreen.closeDocument(), /No current offscreen document/);
    const cancelled = offscreen.createDocument({ url: "audio.html", reasons: ["DOM_PARSER"] });
    const rejected = assert.rejects(cancelled, /closed before loading/);
    await offscreen.closeDocument();
    await rejected;
    const failed = offscreen.createDocument({ url: "audio.html", reasons: ["DOM_PARSER"] });
    const loadError = assert.rejects(failed, /Page failed to load/);
    h.frames[h.frames.length - 1].onerror();
    await loadError;
    h.hold(false);
    await offscreen.createDocument({ url: runtime.getURL("audio.html"), reasons: ["DOM_PARSER"] });
    assert.notStrictEqual((await contexts())[0].contextId, context.contextId);
    assert.strictEqual(await runtime.sendMessage({ ping: true }), "pong");
    await offscreen.closeDocument();
    console.log("Offscreen lifecycle, filtering, messaging and failure recovery passed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function audioHost() {
  const root = fixture();
  try {
    const h = harness(root);
    const { runtime, offscreen } = h.global.chrome;
    const create = () => offscreen.createDocument({ url: "audio.html", reasons: ["AUDIO_PLAYBACK"] });
    await assert.rejects(create(), /accessible/);
    assert.strictEqual(await offscreen.hasDocument(), false);
    const page = h.contentPage("https://example.com/typing");
    await wait();
    h.hold(true);
    let loaded = false;
    const pending = create().then(() => { loaded = true; });
    await wait();
    assert.strictEqual(loaded, false);
    await assert.rejects(create(), /single/);
    assert.strictEqual(h.frames.length, 1);
    assert.strictEqual(h.frames[0].parentNode, page.sandbox.document.body);
    assert.strictEqual(h.global.document.body.children.length, 0);
    h.frames[0].finishLoad();
    await pending;
    assert.strictEqual(await offscreen.hasDocument(), true);
    assert.strictEqual(await runtime.sendMessage({ ping: true }), "pong");
    assert.strictEqual((await runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).length, 1);
    const closing = offscreen.closeDocument();
    await Promise.all([closing, offscreen.closeDocument()]);
    assert.strictEqual(h.frames[0].parentNode, null, "close resolves after the remote frame is removed");
    assert.strictEqual(await offscreen.hasDocument(), false);
    h.hold(false);
    await create();
    page.disconnect(); // The engine does this when the host page navigates/closes.
    await wait();
    assert.strictEqual(await offscreen.hasDocument(), false);
    assert.strictEqual(h.frames[1].parentNode, null);
    await create();
    assert.strictEqual(await runtime.sendMessage({ ping: true }), "pong");
    await offscreen.closeDocument();
    h.hold(true);
    const cancelled = create();
    const rejected = assert.rejects(cancelled, /closed before loading/);
    await wait();
    await offscreen.closeDocument();
    await rejected;
    assert.strictEqual(h.frames[h.frames.length - 1].parentNode, null);
    assert.strictEqual(await offscreen.hasDocument(), false);
    console.log("Generic AUDIO_PLAYBACK hosting, readiness, messaging, cleanup and recreation passed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

lifecycle().then(audioHost).then(workerChannel).then(() => process.exit(0), error => { console.error(error); process.exit(1); });
