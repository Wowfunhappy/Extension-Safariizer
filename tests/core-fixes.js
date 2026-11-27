// Match patterns and their Safari forms, i18n's fallback, the scanner behind
// content scripts, the File System Access stand-in, sends of blobs to the web,
// window.open's stand-in and extension ids, each on the runtime's foundations
// by themselves.
// Run with: node tests/core-fixes.js [project root]
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(process.argv[2] || path.join(__dirname, ".."));
const coreSource = fs.readFileSync(path.join(root, "webext2safari/runtime/wex-core.js"), "utf8");
const patternsSource = fs.readFileSync(path.join(root, "webext2safari/js/patterns.js"), "utf8");

const BASE = "safari-extension://com.webext2safari.foo-TEAM123/AB12/";
const WEB_ORIGIN = "chrome-extension://" + "a".repeat(32);

function core(config, extra) {
  const context = vm.createContext(Object.assign({
    WEX_CONFIG: config || {},
    navigator: { language: "en-US" },
    safari: { extension: { baseURI: BASE } },
    location: { href: BASE + "page.html" },
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, URL, Blob, TextEncoder, TextDecoder, btoa, DOMException
  }, extra || {}));
  vm.runInContext(coreSource, context);
  const g = vm.runInContext("this", context);
  return { g, WEX: g.WEX };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    failures.push(name);
    console.log("  FAIL  " + name + "\n        " + String(e.message).split("\n").slice(0, 6).join("\n        "));
  }
}

// ---- 1. i18n ---------------------------------------------------------- //
function i18nFor(language, catalogues, locales, files) {
  const requests = [];
  function FakeRequest() {}
  FakeRequest.prototype.open = function (method, url) {
    this.wanted = url;
  };
  FakeRequest.prototype.send = function () {
    const locale = (/_locales\/([^/]+)\//.exec(this.wanted) || [])[1];
    requests.push(locale);
    const file = files && files[locale];
    this.status = file ? 200 : 404;
    this.responseText = file ? JSON.stringify(file) : "";
  };
  const carried = {};
  Object.keys(catalogues).forEach((name) => {
    carried[name] = JSON.stringify(catalogues[name]);
  });
  const { WEX } = core({ locales, defaultLocale: "en", localeMessages: carried },
    { navigator: { language }, XMLHttpRequest: FakeRequest });
  return { i18n: WEX.makeI18n(), requests };
}

async function i18nTests() {
  const en = { name: { message: "Example" }, greeting: { message: "Hello $1" }, Mixed: { message: "Either case" } };
  await test("a message the browser's locale lacks comes from the default locale", () => {
    const { i18n } = i18nFor("de-DE", { en, de: { name: { message: "Beispiel" } } }, ["en", "de"]);
    assert.strictEqual(i18n.getMessage("name"), "Beispiel");
    assert.strictEqual(i18n.getMessage("greeting", ["x"]), "Hello x");
    assert.strictEqual(i18n.getMessage("mixed"), "Either case");
    assert.strictEqual(i18n.getMessage("missing"), "");
  });
  await test("a regional catalogue falls back to its language, then the default", () => {
    const { i18n } = i18nFor("de-AT", {
      en, de: { greeting: { message: "Hallo $1" } }, de_AT: { name: { message: "Servus" } }
    }, ["en", "de", "de_AT"]);
    assert.strictEqual(i18n.getMessage("name"), "Servus");
    assert.strictEqual(i18n.getMessage("greeting", ["x"]), "Hallo x");
    assert.strictEqual(i18n.getMessage("mixed"), "Either case");
  });
  await test("the search ends at the default locale, with no request past it", () => {
    const { i18n, requests } = i18nFor("en-US", { en }, ["en", "en_GB"], { en_GB: { other: { message: "No" } } });
    assert.strictEqual(i18n.getMessage("other"), "");
    assert.deepStrictEqual(requests, []);
  });
  await test("a catalogue is read from its file only when a message needs it", () => {
    const { i18n, requests } = i18nFor("de-DE", { en }, ["en", "de"], { de: { name: { message: "Datei" } } });
    assert.strictEqual(i18n.getMessage("name"), "Datei");
    assert.strictEqual(i18n.getMessage("greeting", ["x"]), "Hello x");
    assert.strictEqual(i18n.getMessage("greeting", ["y"]), "Hello y");
    assert.deepStrictEqual(requests, ["de"]);
  });
}

// ---- 2, 3, 14b. match patterns ---------------------------------------- //
async function matchTests() {
  const { WEX } = core({});
  const table = (rows) => {
    rows.forEach(([pattern, url, expected]) => {
      assert.strictEqual(WEX.matchesAny(url, [pattern]), expected, pattern + " on " + url);
    });
  };
  await test("a URL's fragment is no part of what a pattern matches", () => table([
    ["https://example.com/page", "https://example.com/page#top", true],
    ["*://*/*.pdf", "https://example.com/doc.pdf#page=2", true],
    ["*://example.com/secret", "https://example.com/secret#x", true],
    ["https://example.com/page", "https://example.com/page?q=1#top", false],
    ["https://example.com/page?q=*", "https://example.com/page?q=1#top", true]
  ]));
  await test("a pattern's wildcard does not reach into a fragment", () => table([
    ["*://example.com/*.pdf", "https://example.com/x#.pdf", false]
  ]));
  await test("ports in a pattern", () => table([
    ["http://localhost:*/*", "http://localhost:3000/a", true],
    ["http://localhost:*/*", "http://localhost/a", true],
    ["*://*.example.com:*/*", "https://sub.example.com:8443/", true],
    ["*://*.example.com:*/*", "https://example.com/", true],
    ["http://*:8080/*", "http://example.com:8080/", true],
    ["http://*:8080/*", "http://example.com:9000/", false],
    ["http://*:8080/*", "http://example.com/", false],
    ["http://localhost:8080/*", "http://localhost:8080/a", true],
    ["http://localhost:8080/*", "http://localhost:9000/a", false],
    ["http://localhost:8080/*", "http://localhost/a", false],
    ["http://example.com:80/*", "http://example.com/a", true],
    ["https://example.com:443/*", "https://example.com/a", true],
    ["https://example.com:80/*", "https://example.com/a", false],
    ["http://localhost/*", "http://localhost:3000/a", true],
    ["http://:8080/*", "http://example.com:8080/", false],
    ["http://[::1]:8080/*", "http://[::1]:8080/a", true],
    ["http://[::1]/*", "http://[::1]:8080/a", true]
  ]));
  await test("a path is matched in its own case, a scheme and a host in either", () => table([
    ["https://example.com/Admin/*", "https://example.com/admin/x", false],
    ["https://example.com/Admin/*", "https://example.com/Admin/x", true],
    ["https://EXAMPLE.com/a", "https://example.com/a", true],
    ["https://example.com/a", "HTTPS://Example.COM/a", true],
    ["*://*.Example.com/a", "https://sub.example.COM/a", true]
  ]));

  const context = vm.createContext({});
  vm.runInContext(patternsSource, context);
  const patterns = vm.runInContext("W2S.patterns", context);
  const plain = (value) => JSON.parse(JSON.stringify(value));
  await test("Safari's whitelist names a host without its port", () => {
    assert.deepStrictEqual(plain(patterns.toSafari("http://localhost:*/*")), ["http://localhost/*"]);
    assert.deepStrictEqual(plain(patterns.toSafari("https://example.com:8443/a/*")), ["https://example.com/a/*"]);
    assert.deepStrictEqual(plain(patterns.toSafari("*://*.example.com:*/*")), [
      "http://*.example.com/*", "http://example.com/*", "https://*.example.com/*", "https://example.com/*"]);
    assert.deepStrictEqual(plain(patterns.toSafari("http://[::1]/*")), ["http://[::1]/*"]);
  });
  await test("Website Access names a host without its port", () => {
    assert.deepStrictEqual(plain(patterns.allowedDomains(["http://localhost:*/*", "https://a.example:8443/*"])),
      { domains: ["localhost", "a.example"], useAll: false });
    assert.deepStrictEqual(plain(patterns.allowedDomains(["http://*:8080/*"])), { domains: [], useAll: true });
    const allowed = patterns.allowedDomains(["http://localhost:3000/*"]);
    const built = patterns.buildWhitelist(["http://localhost:3000/*"]);
    assert.deepStrictEqual(plain(patterns.restrictWhitelist(built.entries, allowed.domains)), ["http://localhost/*"]);
  });
}

// ---- 4, 5. the scanner ------------------------------------------------- //
// A window with the accessors a page's has, in a world of its own.
function pageWorld() {
  const context = vm.createContext({});
  vm.runInContext(`
    self = this;
    var pageName = "", pageStatus = "";
    Object.defineProperty(this, "name", { get() { return pageName; }, set(v) { pageName = String(v); }, configurable: true });
    Object.defineProperty(this, "status", { get() { return pageStatus; }, set(v) { pageStatus = String(v); }, configurable: true });
    Object.defineProperty(this, "history", { get() { return { length: 1 }; }, configurable: true });
    function run(source) { return (0, eval)(source); }
  `, context);
  return (source) => {
    context.source = source;
    return vm.runInContext("run(source)", context);
  };
}

async function scannerTests() {
  const { WEX } = core({});
  const run = (sources) => {
    const world = pageWorld();
    sources.forEach((source) => world(WEX.asScript(source)));
    return world;
  };
  await test("a sloppy let or const of a window's accessor is a variable", () => {
    const world = run(['let name = null; const status = { ok: true }; const history = []; history.push(1);' +
      'var seen = [name === null, status.ok, history.length];']);
    assert.strictEqual(world("JSON.stringify(seen)"), "[true,true,1]");
    assert.strictEqual(world("pageName"), "");
    assert.strictEqual(world("pageStatus"), "");
  });
  await test("a declarator or pattern of such a name keeps the whole declaration", () => {
    const world = run(['const a = 1, name = { n: 1 }; var one = [a, name.n];',
      'const { status, b } = { status: { s: 2 }, b: 3 }; var two = [status.s, b];']);
    assert.strictEqual(world("JSON.stringify([one, two])"), "[[1,1],[2,3]]");
    assert.strictEqual(world("pageName + pageStatus"), "");
  });
  await test("a class of such a name is left as it is", () => {
    const world = run(["class status { static s() { return 1; } } var got = status.s();"]);
    assert.strictEqual(world("got"), 1);
    assert.strictEqual(world("pageStatus"), "");
  });
  await test("a strict source's such name is not handed to the page", () => {
    const world = run(['"use strict"; const name = "token"; let status = 2; function history() {} var shared = 3;']);
    assert.strictEqual(world("pageName"), "");
    assert.strictEqual(world("pageStatus"), "");
    assert.strictEqual(world("shared"), 3);
  });
  await test("other sloppy names are still shared with later scripts", () => {
    const world = run(["const shared = 1; let other = 2; class Later {}", "var seen = shared + other + typeof Later;"]);
    assert.strictEqual(world("seen"), "3function");
  });
  await test("a strict source's destructured names reach later scripts", () => {
    const world = run(['"use strict"; const { p, q: renamed, r = [1, 2], "quoted key": s, [("k")]: t, u: { v }, ...others } = ' +
      '{ p: 1, q: 2, "quoted key": 3, k: 4, u: { v: 5 }, extra: 6 };',
    '"use strict"; let [a, , [b], c = `x${[1, 2]}`, ...d] = [1, 2, [3]], plain = 4, { e } = { e: 5 };',
    '"use strict"; var { f } = { f: 6 }, g2 = 7; { var { h } = { h: 8 }; }']);
    assert.strictEqual(world("JSON.stringify([p, renamed, r, s, t, v, others])"),
      '[1,2,[1,2],3,4,5,{"extra":6}]');
    assert.strictEqual(world("JSON.stringify([a, b, c, d, plain, e])"), '[1,3,"x1,2",[],4,5]');
    assert.strictEqual(world("JSON.stringify([f, g2, h])"), "[6,7,8]");
    assert.strictEqual(world("typeof q"), "undefined");
  });
  await test("a statement after a declaration with no semicolon adds no names", () => {
    const out = WEX.asScript('"use strict";\nconst a = 1\nfoo(), bar\nvar b = 2,\n  c = 3\n');
    ["a", "b", "c"].forEach((name) => assert.ok(out.includes('self["' + name + '"]'), name));
    assert.ok(!out.includes('self["bar"]'));
    assert.strictEqual(WEX.asScript('const a = 1\nfoo(), name\n'), 'var a = 1\nfoo(), name\n');
  });
}

// ---- 6, 8, 9, 14a. the File System Access stand-in --------------------- //
function fileSystem(extra) {
  function Answering() {}
  Answering.prototype.open = function () {};
  Answering.prototype.send = function () {
    setTimeout(() => {
      this.responseText = "x";
      if (this.onload) this.onload();
    }, 1);
  };
  const saved = [];
  const document = {
    createElement() {
      const link = { click() { saved.push(link.download); }, parentNode: null };
      return link;
    },
    body: { appendChild() {} },
    addEventListener() {}
  };
  const { g, WEX } = core({}, Object.assign({ XMLHttpRequest: Answering, document }, extra));
  WEX.installFileSystemFallback(g);
  return { g, saved };
}

const text = async (handle) => Buffer.from(await (await handle.getFile()).arrayBuffer()).toString();

async function fileSystemTests() {
  await test("every download started before blob URLs are known finishes", async () => {
    const { g, saved } = fileSystem();
    const root = await g.navigator.storage.getDirectory();
    const handles = await Promise.all(["a", "b", "c"].map((name) => root.getFileHandle(name, { create: true })));
    const outcome = await Promise.race([
      Promise.all(handles.map((handle) => handle.download())),
      wait(500).then(() => "still waiting")
    ]);
    assert.deepStrictEqual(Array.from(outcome), [true, true, true]);
    assert.deepStrictEqual(saved, ["a", "b", "c"]);
  });
  await test("a new writable starts empty, so a shorter save leaves no tail", async () => {
    const { g } = fileSystem();
    const handle = await g.showSaveFilePicker({ suggestedName: "s.txt" });
    let writable = await handle.createWritable();
    await writable.write("hello world");
    await writable.close();
    const again = await g.showSaveFilePicker({ suggestedName: "s.txt" });
    writable = await again.createWritable();
    await writable.write("bye");
    await writable.close();
    assert.strictEqual(await text(again), "bye");
  });
  await test("keepExistingData starts from the file's data", async () => {
    const { g } = fileSystem();
    const root = await g.navigator.storage.getDirectory();
    const handle = await root.getFileHandle("k", { create: true });
    let writable = await handle.createWritable();
    await writable.write("hello world");
    await writable.close();
    writable = await handle.createWritable({ keepExistingData: true });
    await writable.write("HELLO");
    await writable.close();
    assert.strictEqual(await text(handle), "HELLO world");
  });
  await test("what a writable writes shows after close, and never after abort", async () => {
    const { g } = fileSystem();
    const root = await g.navigator.storage.getDirectory();
    const handle = await root.getFileHandle("t", { create: true });
    let writable = await handle.createWritable();
    await writable.write("committed");
    assert.strictEqual(await text(handle), "");
    await writable.close();
    assert.strictEqual(await text(handle), "committed");
    writable = await handle.createWritable({ keepExistingData: true });
    await writable.write("XXXXX");
    await writable.abort();
    assert.strictEqual(await text(handle), "committed");
    await assert.rejects(writable.write("late"), (e) => e.name === "TypeError");
  });
  await test("writes in any order and seeks and truncates land in the writable", async () => {
    const { g } = fileSystem();
    const root = await g.navigator.storage.getDirectory();
    const handle = await root.getFileHandle("o", { create: true });
    const writable = await handle.createWritable();
    writable.write({ type: "write", position: 3, data: "def" });
    writable.write({ type: "write", position: 0, data: "abc" });
    writable.seek(6);
    writable.write("gh");
    writable.truncate(7);
    await writable.close();
    assert.strictEqual(await text(handle), "abcdefg");
  });
  await test("a position past 2 GiB is not taken for another", async () => {
    const { g } = fileSystem();
    const root = await g.navigator.storage.getDirectory();
    const handle = await root.getFileHandle("big", { create: true });
    const writable = await handle.createWritable();
    await writable.write("AAAA");
    const far = Math.pow(2, 31);
    await writable.write({ type: "write", position: far, data: "Z" });
    await writable.close();
    const store = handle._store;
    assert.strictEqual(store.length, far + 1);
    assert.strictEqual(store.bytes[0], 65);
    assert.strictEqual(store.bytes[far], 90);
  });
  await test("a missing entry fails as NotFoundError, a wrong kind as TypeMismatchError", async () => {
    const { g } = fileSystem();
    const root = await g.navigator.storage.getDirectory();
    await assert.rejects(root.getFileHandle("missing"), (e) => e.name === "NotFoundError");
    await assert.rejects(root.getDirectoryHandle("missing"), (e) => e.name === "NotFoundError");
    await root.getDirectoryHandle("d", { create: true });
    await root.getFileHandle("f", { create: true });
    await assert.rejects(root.getFileHandle("d"), (e) => e.name === "TypeMismatchError");
    await assert.rejects(root.getDirectoryHandle("f"), (e) => e.name === "TypeMismatchError");
    await assert.rejects(root.getFileHandle("constructor"), (e) => e.name === "NotFoundError");
  });
  await test("a directory is iterated asynchronously", async () => {
    const { g } = fileSystem();
    const root = await g.navigator.storage.getDirectory();
    const file = await root.getFileHandle("f", { create: true });
    const directory = await root.getDirectoryHandle("d", { create: true });
    const entries = [];
    for await (const [name, handle] of root.entries()) entries.push([name, handle]);
    assert.ok(entries.length === 2 && entries[0][1] === file && entries[1][0] === "d");
    const direct = [];
    for await (const [name] of root) direct.push(name);
    assert.deepStrictEqual(direct, ["f", "d"]);
    const keys = [];
    for await (const name of root.keys()) keys.push(name);
    assert.deepStrictEqual(keys, ["f", "d"]);
    const values = [];
    for await (const handle of root.values()) values.push(handle);
    assert.ok(values[1] === directory);
    assert.strictEqual(typeof root.keys().next, "function");
  });
  await test("isSameEntry gives a promise", async () => {
    const { g } = fileSystem();
    const root = await g.navigator.storage.getDirectory();
    const file = await root.getFileHandle("f", { create: true });
    const answer = file.isSameEntry(file);
    assert.strictEqual(typeof answer.then, "function");
    assert.strictEqual(await answer, true);
    assert.strictEqual(await file.isSameEntry(root), false);
  });
  await test("move gives an entry its new name and place", async () => {
    const { g } = fileSystem();
    const root = await g.navigator.storage.getDirectory();
    const file = await root.getFileHandle("old", { create: true });
    await file.move("new");
    assert.strictEqual(file.name, "new");
    assert.strictEqual(await root.getFileHandle("new"), file);
    await assert.rejects(root.getFileHandle("old"), /could not be found|NotFound/);
    const directory = await root.getDirectoryHandle("d", { create: true });
    await file.move(directory, "there");
    assert.strictEqual(file.name, "there");
    assert.strictEqual(await directory.getFileHandle("there"), file);
    await assert.rejects(root.getFileHandle("new"), /could not be found|NotFound/);
    await file.move(root);
    assert.strictEqual(await root.getFileHandle("there"), file);
  });
}

// ---- 7. pageFromWeb ---------------------------------------------------- //
async function pageFromWebTests() {
  const { WEX } = core({ webOrigin: WEB_ORIGIN, manifest: { web_accessible_resources: ["res/*"] } });
  const open = (rest) => WEX.pageFromWeb(WEB_ORIGIN + "/" + rest, "https://evil.example/");
  await test("tabs and line breaks do not hide a climb out of what a site may open", () => {
    ["res/.\t./secret.html", "res/\t../secret.html", "res/..\t/secret.html", "res/.\n./secret.html",
      "res/.\r./secret.html", "res/../\tsecret.html"].forEach((rest) => {
      assert.strictEqual(open(rest), null, JSON.stringify(rest));
    });
  });
  await test("a listed page opens, without the characters a URL's parser drops", () => {
    assert.strictEqual(open("res/ok.html"), BASE + "res/ok.html");
    assert.strictEqual(open("res/o\tk.html"), BASE + "res/ok.html");
    assert.strictEqual(open("secret.html"), null);
    assert.strictEqual(open("res/../secret.html"), null);
  });
}

// ---- 10. blobs on their way to the web --------------------------------- //
function webFacing() {
  const log = [];
  class Socket {
    constructor() {
      this.readyState = 1;
    }
    send(data) {
      if (this.closed) throw new Error("sent after close");
      log.push("socket send " + (data instanceof ArrayBuffer || Object.prototype.toString.call(data) === "[object ArrayBuffer]" ? "bytes" : typeof data));
    }
    close(code) {
      this.closed = true;
      log.push("socket close " + code);
    }
  }
  class Request {
    open(method, url, isAsync) {
      this.sync = isAsync === false;
      this.readyState = 1;
      this.status = 0;
    }
    send(body) {
      log.push((this.sync ? "sync send " : "send ") + (body === undefined ? "empty" : body.constructor.name));
      this.status = 200;
      this.readyState = 4;
    }
    abort() {
      log.push("abort");
    }
  }
  const { g, WEX } = core({ webOrigin: WEB_ORIGIN }, { WebSocket: Socket, XMLHttpRequest: Request, Proxy, Reflect });
  WEX.installWebFacingAddresses(g, false);
  return { g, log };
}

async function webFacingTests() {
  await test("a socket closes after the blob sent before it", async () => {
    const { g, log } = webFacing();
    const unhandled = [];
    const note = (e) => unhandled.push(e);
    process.on("unhandledRejection", note);
    const socket = new g.WebSocket("wss://x.example/");
    socket.send(new Blob(["bye"]));
    socket.close(1000);
    const closing = socket.readyState;
    await wait(20);
    process.removeListener("unhandledRejection", note);
    assert.deepStrictEqual(log, ["socket send bytes", "socket close 1000"]);
    assert.deepStrictEqual(unhandled, []);
    assert.strictEqual(closing, 2);
  });
  await test("a socket with nothing waiting closes at once", () => {
    const { g, log } = webFacing();
    const socket = new g.WebSocket("wss://x.example/");
    socket.close(1000);
    assert.deepStrictEqual(log, ["socket close 1000"]);
  });
  await test("a synchronous request with a blob has gone when send returns", () => {
    const { g, log } = webFacing();
    const request = new g.XMLHttpRequest();
    request.open("POST", "https://x.example/", false);
    request.send(new Blob(["b"]));
    assert.strictEqual(request.status, 200);
    assert.deepStrictEqual(log, ["sync send Blob"]);
  });
  await test("aborting a request whose blob is being read sends nothing of it", async () => {
    const { g, log } = webFacing();
    const request = new g.XMLHttpRequest();
    request.open("POST", "https://x.example/", true);
    request.send(new Blob(["b"]));
    assert.deepStrictEqual(log, []);
    request.abort();
    await wait(20);
    assert.deepStrictEqual(log, ["send empty", "abort"]);
  });
  await test("opening a request again drops the blob of the send before", async () => {
    const { g, log } = webFacing();
    const request = new g.XMLHttpRequest();
    request.open("POST", "https://x.example/", true);
    request.send(new Blob(["b"]));
    request.open("GET", "https://x.example/", true);
    await wait(20);
    assert.deepStrictEqual(log, []);
  });
  await test("an asynchronous request's blob goes once it is read", async () => {
    const { g, log } = webFacing();
    const request = new g.XMLHttpRequest();
    request.open("POST", "https://x.example/", true);
    request.send(new Blob(["b"]));
    await wait(20);
    assert.strictEqual(log.length, 1);
    assert.ok(log[0].startsWith("send "));
  });
  await test("a blob that cannot be read here goes as it is", async () => {
    const { g, log } = webFacing();
    const blob = new Blob(["b"]);
    blob.arrayBuffer = undefined;
    const request = new g.XMLHttpRequest();
    request.open("POST", "https://x.example/", true);
    request.send(blob);
    await wait(20);
    assert.deepStrictEqual(log, ["send Blob"]);
  });
}

// ---- 11, 12. extension addresses and ids ------------------------------- //
async function idTests() {
  const { WEX } = core({ extensionId: "com.webext2safari.foo" });
  await test("an extension's address ends at its own host", () => {
    const sibling = "safari-extension://com.webext2safari.foo-TEAM123.evil-XYZ/tok/page.html";
    assert.strictEqual(WEX.isExtUrl(sibling), false);
    assert.strictEqual(WEX.isExtUrl(BASE + "a.html"), true);
    assert.strictEqual(WEX.isExtUrl("safari-extension://com.webext2safari.foo-TEAM123"), true);
    assert.strictEqual(WEX.isExtUrl("safari-extension://com.webext2safari.foo-TEAM123?x"), true);
    const described = WEX.describeSender({ id: "com.webext2safari.foo-TEAM123.evil-XYZ", url: sibling }, true);
    assert.strictEqual(described.origin, "safari-extension://com.webext2safari.foo-TEAM123.evil-XYZ");
  });
  await test("a file of another extension is not reported as the extension's own", async () => {
    const { g, WEX: own } = core({});
    g.fetch = () => Promise.resolve({
      status: 0, type: "basic", url: "safari-extension://com.webext2safari.foo-TEAM123.evil-XYZ/t/a.txt"
    });
    g.Response = function () {};
    g.Headers = function () {};
    own.installFileStatusFix(g);
    const response = await g.fetch("safari-extension://com.webext2safari.foo-TEAM123.evil-XYZ/t/a.txt");
    assert.strictEqual(response.status, 0);
  });
  await test("a sibling bundle's id is not the extension's own", async () => {
    const sent = [];
    const native = { runtime: { sendMessage(...args) { sent.push(args); return Promise.resolve(); } } };
    const runtime = WEX.makeMessaging(native);
    await runtime.sendMessage("com.webext2safari.foo-bar-TEAM123", { a: 1 });
    await runtime.sendMessage("com.webext2safari.foo-bar", { a: 2 });
    assert.deepStrictEqual(sent.map((args) => args.length), [2, 2]);
    assert.strictEqual(sent[0][0], "com.webext2safari.foo-bar-TEAM123");
  });
  await test("the extension's own ids keep a message internal", async () => {
    const sent = [];
    const native = { runtime: { sendMessage(...args) { sent.push(args); return Promise.resolve(); } } };
    const runtime = WEX.makeMessaging(native);
    await runtime.sendMessage("com.webext2safari.foo-TEAM123", { a: 1 });
    await runtime.sendMessage("com.webext2safari.foo-team123", { a: 2 });
    await runtime.sendMessage("com.webext2safari.foo", { a: 3 });
    assert.deepStrictEqual(sent.map((args) => args.length), [1, 1, 1]);
  });
}

// ---- 12b. pickers beside an engine's own file handles ------------------- //
async function nativeHandleTests() {
  class NativeDirectory {
    getFileHandle(name) {
      const handle = new NativeFile();
      handle.name = name;
      return Promise.resolve(handle);
    }
  }
  class NativeFile {
    move(directory, name) {
      if (name === undefined) {
        throw new TypeError("Not enough arguments");
      }
      this.moved = [directory, name];
      return Promise.resolve();
    }
  }
  const { g, WEX } = core({}, { FileSystemFileHandle: NativeFile, FileSystemDirectoryHandle: NativeDirectory, FileSystemHandle: NativeFile });
  WEX.installFileSystemFallback(g);
  await test("the engine's classes stay, and the pickers stand in beside them", () => {
    assert.strictEqual(g.FileSystemFileHandle, NativeFile);
    assert.strictEqual(typeof g.showSaveFilePicker, "function");
  });
  await test("move takes a name, or a directory, on the engine's handles", async () => {
    const directory = new NativeDirectory();
    const file = await directory.getFileHandle("a.txt");
    await file.move("b.txt");
    assert.deepStrictEqual(file.moved, [directory, "b.txt"]);
    const other = new NativeDirectory();
    await file.move(other);
    assert.deepStrictEqual(file.moved, [other, "a.txt"]);
  });
  await test("a picked file saves once after it closes, unless the extension saves it first", async () => {
    const { g: page, WEX: runtime } = core({});
    runtime.installFileSystemFallback(page);
    const picked = await page.showSaveFilePicker({ suggestedName: "p.txt" });
    assert.strictEqual(picked.name, "p.txt");
    let writer = await picked.createWritable();
    await writer.write("x");
    await writer.close();
    assert.strictEqual(typeof picked._saving, "object");
    clearTimeout(picked._saving);
    const plain = await (await page.navigator.storage.getDirectory()).getFileHandle("q.txt", { create: true });
    writer = await plain.createWritable();
    await writer.write("x");
    await writer.close();
    assert.strictEqual(plain._saving, undefined);
  });
  await test("two picks of one name are two files, and a picked directory starts empty", async () => {
    const { g: page, WEX: runtime } = core({});
    runtime.installFileSystemFallback(page);
    const a = await page.showSaveFilePicker({ suggestedName: "same.txt" });
    const b = await page.showSaveFilePicker({ suggestedName: "same.txt" });
    assert.notStrictEqual(a, b);
    const folder = await page.showDirectoryPicker();
    const names = [];
    for await (const name of folder.keys()) names.push(name);
    assert.deepStrictEqual(names, []);
    const inFolder = await folder.getFileHandle("in.txt", { create: true });
    const writer = await inFolder.createWritable();
    await writer.close();
    assert.strictEqual(typeof inFolder._saving, "object");
    clearTimeout(inFolder._saving);
  });
  await test("a pick older than a day is cleared by the next", async () => {
    const { g: page, WEX: runtime } = core({});
    runtime.installFileSystemFallback(page);
    const top = await page.navigator.storage.getDirectory();
    const picked = await top.getDirectoryHandle("wex-picked", { create: true });
    await picked.getDirectoryHandle(String(Date.now() - 2 * 24 * 3600 * 1000) + "-old", { create: true });
    const recent = String(Date.now() - 3600 * 1000) + "-recent";
    await picked.getDirectoryHandle(recent, { create: true });
    await page.showDirectoryPicker();
    await wait(10);
    const names = [];
    for await (const name of picked.keys()) names.push(name);
    assert.ok(names.includes(recent));
    assert.ok(!names.some((n) => n.endsWith("-old")));
  });
}

// ---- 13. window.open --------------------------------------------------- //
async function openTests() {
  const opened = () => {
    const calls = [];
    const { g, WEX } = core({});
    WEX.installOpenInTab(g, {
      create(options) { calls.push(["create", options]); return Promise.resolve({ id: 7 }); },
      update(id, options) { calls.push(["update", id, options]); return Promise.resolve({ id }); },
      remove() { return Promise.resolve(); }
    });
    return { g, calls };
  };
  await test("what window.open gives can be sent elsewhere", async () => {
    for (const send of [
      (w) => { w.location.href = "https://x.example/a"; },
      (w) => { w.location = "https://x.example/a"; },
      (w) => { w.location.assign("https://x.example/a"); },
      (w) => { w.location.replace("https://x.example/a"); }
    ]) {
      const { g, calls } = opened();
      const win = g.open("");
      send(win);
      await wait(1);
      assert.strictEqual(JSON.stringify(calls),
        JSON.stringify([["create", {}], ["update", 7, { url: "https://x.example/a" }]]));
      assert.strictEqual(win.location.href, "https://x.example/a");
      assert.strictEqual(String(win.location), "https://x.example/a");
    }
  });
  await test("its address starts as the one it was opened at", () => {
    const { g } = opened();
    assert.strictEqual(g.open("https://x.example/b").location.href, "https://x.example/b");
    assert.strictEqual(g.open().location.href, "about:blank");
  });
  await test("what is written to its document shows in the new tab", async () => {
    const written = "data:text/html;charset=utf-8," + encodeURIComponent("<p>one</p>two\n");
    for (const finish of [(w) => w.document.close(), () => {}]) {
      const { g, calls } = opened();
      const win = g.open("");
      win.document.open();
      win.document.write("<p>", "one</p>");
      win.document.writeln("two");
      finish(win);
      await wait(5);
      assert.strictEqual(JSON.stringify(calls),
        JSON.stringify([["create", {}], ["update", 7, { url: written }]]));
    }
  });
}

// ---- 14c. the stand-in WritableStream ---------------------------------- //
async function streamTests() {
  await test("a sink is started, and its write told of the controller", async () => {
    const { g, WEX } = core({});
    WEX.installStreamFallback(g);
    const calls = [];
    let controller = null;
    let begin = null;
    const stream = new g.WritableStream({
      start(c) {
        controller = c;
        calls.push("start");
        return new Promise((resolve) => { begin = resolve; });
      },
      write(chunk, c) { calls.push(["write", chunk, c === controller]); },
      close() { calls.push("close"); }
    });
    assert.deepStrictEqual(calls, ["start"]);
    const writer = stream.getWriter();
    const written = writer.write("a");
    const closed = writer.close();
    await wait(1);
    assert.deepStrictEqual(calls, ["start"]);
    begin();
    await Promise.all([written, closed]);
    assert.deepStrictEqual(calls, ["start", ["write", "a", true], "close"]);
  });
  await test("a sink's controller can fail the stream", async () => {
    const { g, WEX } = core({});
    WEX.installStreamFallback(g);
    let controller = null;
    const stream = new g.WritableStream({ start(c) { controller = c; } });
    controller.error(new Error("broken"));
    await assert.rejects(stream.getWriter().write("a"), /broken/);
  });
}

(async function () {
  await i18nTests();
  await matchTests();
  await scannerTests();
  await fileSystemTests();
  await pageFromWebTests();
  await webFacingTests();
  await idTests();
  await nativeHandleTests();
  await openTests();
  await streamTests();
  console.log(passed + " core checks passed, " + failures.length + " failed");
  process.exit(failures.length ? 1 : 0);
})();
