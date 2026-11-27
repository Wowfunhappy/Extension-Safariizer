// Tests of declarativeNetRequest's response headers and regular expressions,
// document targeting, injected files and results, legacy requests and the
// remote event port, against the fake Safari API.
//
//     node tests/core-fixes-2.js

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = process.env.WEX_ROOT || path.resolve(__dirname, "..");
const RUNTIME = path.join(ROOT, "webext2safari", "runtime");
const { FakeBrowser } = require(path.join(ROOT, "tests", "fake-safari"));

const runSource = fs.readFileSync(path.join(ROOT, "tests", "run.js"), "utf8");
const buildFixture = new Function("fs", "os", "path", "RUNTIME",
  runSource.slice(runSource.indexOf("function buildFixture()"),
    runSource.indexOf("// ------------------------------------------------------------------ //\n// The run")) +
  "; return buildFixture;")(fs, os, path, RUNTIME);
const SCHEMA = fs.readFileSync(path.join(RUNTIME, "chrome-api.json"), "utf8");

let passed = 0;
const failures = [];

function equal(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failures.push(name + " - got " + a + ", expected " + e);
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms || 30));
}

function fixture(edit, schema) {
  const dir = buildFixture();
  const file = path.join(dir, "wex", "wex-config.js");
  const config = JSON.parse(fs.readFileSync(file, "utf8").replace(/^var WEX_CONFIG = /, "").replace(/;\s*$/, ""));
  if (edit) {
    edit(config, dir);
  }
  fs.writeFileSync(file, "var WEX_CONFIG = " + JSON.stringify(config) + ";\n");
  if (schema) {
    for (const name of ["wex-api.js", "wex-content-api.js"]) {
      fs.writeFileSync(path.join(dir, "wex", name), "var WEX_API = " + SCHEMA + ";\n");
    }
  }
  return dir;
}

function start(dir) {
  const wex = (name) => path.join(dir, "wex", name);
  const browser = new FakeBrowser(dir, { bundleId: "com.example.test-TEAM123" });
  const window0 = browser.openWindow();
  const tab = window0.openTab();
  tab.url = "https://example.com/page";
  tab.title = "Example";
  window0.activeTab = tab;
  const page = browser.createGlobalPage([wex("wex-config.js"), wex("wex-api.js"), wex("wex-core.js"), wex("wex-global.js")]);
  const frameFiles = ["wex-config.js", "wex-content-api.js", "wex-core.js", "wex-content.js",
    "wex-run-start.js", "wex-run-end.js"].map(wex);
  return { browser, window0, tab, page, wex, dir, frameFiles, tabId: tab.engineId };
}

// The names of the headers a response is left with.
async function headersLeft(run, url, type, extra, headers) {
  const answered = await run.browser.engine.request(Object.assign({ url, type, tabId: run.tabId }, extra || {}), {
    responseHeaders: headers || [{ name: "X-Frame-Options", value: "DENY" }, { name: "Content-Type", value: "text/html" }]
  });
  return answered.responseHeaders.map((h) => h.name);
}

const REMOVE_XFO = { type: "modifyHeaders", responseHeaders: [{ header: "x-frame-options", operation: "remove" }] };
const KEPT = ["X-Frame-Options", "Content-Type"];
const STRIPPED = ["Content-Type"];

async function legacyRequests() {
  const run = start(fixture((c) => {
    c.manifest.manifest_version = 2;
    delete c.manifest.action;
    c.manifest.browser_action = {};
  }, true));
  await wait();
  const got = [];
  run.page.chrome.extension.onRequest.addListener((request, sender, respond) => {
    got.push(request === undefined ? "nothing" : request);
    respond("ok");
  });
  const frame = run.browser.createContentFrame(run.tab, run.frameFiles, {});
  await wait(50);
  frame.sandbox.chrome.extension.sendRequest({ ask: 1 });
  await wait(40);
  const answer = await new Promise((resolve) => frame.sandbox.chrome.extension.sendRequest({ ask: 2 }, resolve));
  equal("extension.sendRequest sends its request with or without a callback, through the schema's checks",
    [got, answer], [[{ ask: 1 }, { ask: 2 }], "ok"]);
}

async function responseRules() {
  const run = start(fixture());
  await wait();
  const dnr = run.page.chrome.declarativeNetRequest;
  const update = async (options) => {
    await dnr.updateDynamicRules(options);
    await wait();
  };
  await update({ addRules: [
    { id: 1, priority: 1, action: REMOVE_XFO, condition: { urlFilter: "*", resourceTypes: ["sub_frame", "script"] } },
    { id: 2, priority: 5, action: { type: "allow" }, condition: { urlFilter: "||bank.example^", resourceTypes: ["sub_frame"] } },
    { id: 3, priority: 1, action: { type: "allow" }, condition: { urlFilter: "||equal.example^", resourceTypes: ["sub_frame"] } }
  ] });
  equal("a higher allow rule stops a response-header change, an equal one too, and others are changed",
    [await headersLeft(run, "https://bank.example/", "sub_frame"), await headersLeft(run, "https://equal.example/", "sub_frame"),
      await headersLeft(run, "https://other.example/", "sub_frame")],
    [KEPT, KEPT, STRIPPED]);
  await update({ removeRuleIds: [2, 3], addRules: [
    { id: 4, priority: 1, action: { type: "allow" }, condition: { urlFilter: "||low.example^", resourceTypes: ["sub_frame"] } },
    { id: 5, priority: 3, action: REMOVE_XFO, condition: { urlFilter: "||low.example^", resourceTypes: ["sub_frame"] } }
  ] });
  equal("a change above an allow rule stands",
    await headersLeft(run, "https://low.example/", "sub_frame"), STRIPPED);
  await update({ removeRuleIds: [4, 5], addRules: [
    { id: 6, priority: 2, action: { type: "allowAllRequests" },
      condition: { urlFilter: "||framed.example^", resourceTypes: ["main_frame", "sub_frame"] } }
  ] });
  equal("allowAllRequests covers the frame's request and the requests its document makes",
    [await headersLeft(run, "https://framed.example/", "sub_frame"),
      await headersLeft(run, "https://cdn.example/a.js", "script", { frameId: 0, documentUrl: "https://framed.example/" }),
      await headersLeft(run, "https://cdn.example/a.js", "script", { frameId: 0, documentUrl: "https://other.example/" })],
    [KEPT, KEPT, STRIPPED]);
  equal("a static allow rule counts, as its ruleset is enabled",
    await headersLeft(run, "https://trusted.example/a.js", "script"), KEPT);
  await update({ removeRuleIds: [1, 6] });

  await update({ addRules: [
    { id: 7, action: REMOVE_XFO, priority: 1, condition: { urlFilter: "*", domains: ["only.example"], resourceTypes: ["sub_frame"] } },
    { id: 8, action: REMOVE_XFO, priority: 1, condition: { urlFilter: "*", excludedDomains: ["bank.example"], resourceTypes: ["script"] } }
  ] });
  equal("a rule's domains and excludedDomains are read as its initiator's",
    [await headersLeft(run, "https://f.example/", "sub_frame", { initiator: "https://only.example" }),
      await headersLeft(run, "https://f.example/", "sub_frame", { initiator: "https://other.example" }),
      await headersLeft(run, "https://f.example/", "script", { initiator: "https://other.example" }),
      await headersLeft(run, "https://f.example/", "script", { initiator: "https://bank.example" })],
    [STRIPPED, KEPT, STRIPPED, KEPT]);
  await update({ removeRuleIds: [7, 8], addRules: [
    { id: 9, action: REMOVE_XFO, priority: 1, condition: { urlFilter: "||a.example^", resourceTypes: ["sub_frame"],
      responseHeaders: [{ header: "content-type", values: ["text/*"], excludedValues: ["text/plain"] }] } },
    { id: 10, action: REMOVE_XFO, priority: 1, condition: { urlFilter: "||b.example^", resourceTypes: ["sub_frame"],
      excludedResponseHeaders: [{ header: "x-keep" }] } },
    { id: 11, action: REMOVE_XFO, priority: 1, condition: { urlFilter: "||c.example^", resourceTypes: ["sub_frame"],
      topDomains: ["top.example"] } },
    { id: 12, action: REMOVE_XFO, priority: 1, condition: { urlFilter: "||d.example^", resourceTypes: ["sub_frame"],
      excludedTopDomains: ["top.example"] } }
  ] });
  const of = (type) => [{ name: "X-Frame-Options", value: "DENY" }, { name: "Content-Type", value: type }];
  const named = async (url, extra, headers) => (await headersLeft(run, url, "sub_frame", extra, headers)).length;
  equal("a rule's response-header conditions decide whether it applies",
    [await named("https://a.example/", {}, of("text/html")), await named("https://a.example/", {}, of("text/plain")),
      await named("https://a.example/", {}, of("image/png")),
      await named("https://b.example/", {}, of("text/html")),
      await named("https://b.example/", {}, of("text/html").concat({ name: "X-Keep", value: "1" }))],
    [1, 2, 2, 1, 3]);
  const ancestors = (url) => ({ frameAncestors: [{ url: "https://inner.example/" }, { url }] });
  equal("a rule's top domains decide whether it applies",
    [await named("https://c.example/", ancestors("https://top.example/"), of("text/html")),
      await named("https://c.example/", ancestors("https://other.example/"), of("text/html")),
      await named("https://d.example/", ancestors("https://top.example/"), of("text/html")),
      await named("https://d.example/", ancestors("https://other.example/"), of("text/html"))],
    [1, 2, 2, 1]);
}

async function refusedHeaders() {
  const run = start(fixture());
  await wait();
  const dnr = run.page.chrome.declarativeNetRequest;
  const many = [];
  for (let id = 1; id <= 60; id++) {
    many.push({ id, priority: 1, condition: { urlFilter: "site" + id + ".example", resourceTypes: ["sub_frame"] },
      action: { type: "modifyHeaders", requestHeaders: [{ header: "Permissions-Policy", operation: "remove" }],
        responseHeaders: [{ header: "x-frame-options", operation: "remove" }] } });
  }
  let failed = null;
  await dnr.updateDynamicRules({ addRules: many }).catch((e) => {
    failed = e.message;
  });
  equal("any number of rules may name a header the engine refuses",
    [failed, (await dnr.getDynamicRules()).length], [null, 60]);
  await dnr.updateDynamicRules({ removeRuleIds: many.map((rule) => rule.id) });

  const POLICY = { name: "Permissions-Policy", value: "camera=()" };
  const both = { id: 70, priority: 1, condition: { urlFilter: "||both.example^", resourceTypes: ["sub_frame"] },
    action: { type: "modifyHeaders", responseHeaders: [{ header: "Permissions-Policy", operation: "remove" },
      { header: "x-frame-options", operation: "remove" }] } };
  const only = { id: 71, priority: 1, condition: { urlFilter: "||only.example^", resourceTypes: ["sub_frame"] },
    action: { type: "modifyHeaders", responseHeaders: [{ header: "Permissions-Policy", operation: "remove" }] } };
  await dnr.updateDynamicRules({ addRules: [both, only] });
  await wait();
  const engineRules = () => run.browser.engine.dnrState().dynamicRules.map((rule) => rule.id);
  equal("a rule keeps a response header the engine refuses, and reads back as written",
    [await dnr.getDynamicRules({ ruleIds: [70] }), await dnr.getDynamicRules({ ruleIds: [71] }), engineRules()],
    [[both], [only], [70]]);
  const responses = [POLICY, { name: "X-Frame-Options", value: "DENY" }];
  equal("and the runtime applies it",
    [await headersLeft(run, "https://both.example/", "sub_frame", {}, responses),
      await headersLeft(run, "https://only.example/", "sub_frame", {}, responses)],
    [[], ["X-Frame-Options"]]);
  await dnr.updateDynamicRules({ removeRuleIds: [71] });
  await wait();
  equal("removing a rule only the runtime holds ends it",
    [await dnr.getDynamicRules({ ruleIds: [71] }), engineRules(),
      await headersLeft(run, "https://only.example/", "sub_frame", {}, responses)],
    [[], [70], ["Permissions-Policy", "X-Frame-Options"]]);
  await dnr.updateSessionRules({ addRules: [only] });
  await wait();
  const pageTab = run.window0.openTab("background");
  const options = run.browser.createTabPage(pageTab, [run.wex("wex-config.js"), run.wex("wex-api.js"),
    run.wex("wex-core.js"), run.wex("wex-page.js")], run.browser.baseURI + "options.html");
  await wait();
  equal("a session rule only the runtime holds is the same to every page, and applied",
    [await dnr.getSessionRules({ ruleIds: [71] }), await options.chrome.declarativeNetRequest.getSessionRules({ ruleIds: [71] }),
      await headersLeft(run, "https://only.example/", "sub_frame", {}, responses)],
    [[only], [only], ["X-Frame-Options"]]);
  run.page.WEX.installResponseHeaderRules(run.page.WEX.native, dnr);
  await wait();
  equal("and ends as the global page next starts", await dnr.getSessionRules({ ruleIds: [71] }), []);
  await dnr.updateDynamicRules({ addRules: [
    Object.assign({}, only, { id: 72, condition: { urlFilter: "||only2.example^", resourceTypes: ["sub_frame"] } })
  ] });
  equal("a dynamic one is kept with the extension's other rules",
    (await dnr.getDynamicRules()).map((rule) => rule.id).sort(), [70, 72]);

  // A request header the engine refuses is the runtime's to set, beside the
  // headers of the rule the engine took, on the extension's own requests as
  // on any other.
  const setting = { id: 80, priority: 1, condition: { urlFilter: "||api.example/", resourceTypes: ["xmlhttprequest"] },
    action: { type: "modifyHeaders", requestHeaders: [{ header: "User-Agent", operation: "set", value: "rule" },
      { header: "Permissions-Policy", operation: "set", value: "camera=()" }] } };
  await dnr.updateSessionRules({ addRules: [setting] });
  await wait();
  const sent = async (url, extra) => {
    const answered = await run.browser.engine.request(Object.assign({ url, type: "xmlhttprequest", tabId: -1,
      requestHeaders: [{ name: "Accept", value: "*/*" }] }, extra || {}), { responseHeaders: [] });
    return (answered.requestHeaders || []).map((h) => h.name + "=" + h.value);
  };
  equal("a session rule's refused request header is set by the runtime, where the rule matches",
    [run.browser.engine.dnrState().sessionRules.filter((r) => r.id === 80).map((r) => r.action.requestHeaders.length),
      await sent("https://api.example/x"), await sent("https://other.example/x"),
      await sent("https://api.example/x", { type: "script" })],
    [[1], ["Accept=*/*", "Permissions-Policy=camera=()"], ["Accept=*/*"], ["Accept=*/*"]]);
  await dnr.updateSessionRules({ removeRuleIds: [80] });
  await wait();
  equal("and no longer once the rule is gone", await sent("https://api.example/x"), ["Accept=*/*"]);

  // Safari's rule lists know no tabs, and the engine would take a tab
  // condition for none.
  const script = (urlFilter) => ({ urlFilter, resourceTypes: ["script"] });
  const noTab = { id: 90, priority: 1000000, condition: { tabIds: [-1] }, action: { type: "allow" } };
  const everyTab = { id: 91, priority: 1, condition: Object.assign(script("||tracker.example^"), { excludedTabIds: [-1] }),
    action: { type: "block" } };
  const oneTab = { id: 92, priority: 1, condition: Object.assign(script("||tabbed.example^"), { tabIds: [7] }),
    action: { type: "block" } };
  const moved = { id: 93, priority: 1, condition: Object.assign(script("||moved.example^"), { tabIds: [7] }),
    action: { type: "redirect", redirect: { url: "https://new.example/x.js" } } };
  const letBe = { id: 94, priority: 2, condition: Object.assign(script("||tabbed.example/ok"), { tabIds: [7] }),
    action: { type: "allow" } };
  await dnr.updateSessionRules({ addRules: [noTab, everyTab, oneTab, moved, letBe] });
  await wait();
  equal("a rule for no tab's requests is not the engine's, one excluding only those goes to it without the " +
    "condition, one naming a tab is the runtime's, and all read back as written",
    [run.browser.engine.dnrState().sessionRules.filter((r) => r.id >= 90 && r.id < 95)
      .map((r) => [r.id, "excludedTabIds" in r.condition]),
      (await dnr.getSessionRules()).filter((r) => r.id >= 90 && r.id < 95).sort((a, b) => a.id - b.id)],
    [[[91, false]], [noTab, everyTab, oneTab, moved, letBe]]);
  const outcome = async (url, tabId) => {
    const o = await run.browser.engine.request({ url, type: "script", tabId, requestHeaders: [] }, { responseHeaders: [] });
    return o.cancel ? "blocked" : o.redirectUrl || "loaded";
  };
  equal("the runtime blocks and redirects the named tab's requests alone, under its allow rules",
    [await outcome("https://tabbed.example/a.js", 7), await outcome("https://tabbed.example/a.js", 8),
      await outcome("https://moved.example/a.js", 7), await outcome("https://tabbed.example/ok.js", 7),
      await outcome("https://tabbed.example/a.js", -1)],
    ["blocked", "loaded", "https://new.example/x.js", "loaded", "loaded"]);
  let refusedDynamic = null;
  await dnr.updateDynamicRules({ addRules: [Object.assign({}, oneTab, { id: 95 })] })
    .catch((e) => { refusedDynamic = e.message; });
  equal("a dynamic rule may not name tabs, as in Chrome", refusedDynamic,
    "Rule with id 95 specifies a value for \"tabIds\" or \"excludedTabIds\" key. " +
    "These are only supported for session-scoped rules.");
  await dnr.updateSessionRules({ removeRuleIds: [90, 91, 92, 93, 94] });
  await wait();
  equal("and none is applied once removed", await outcome("https://tabbed.example/a.js", 7), "loaded");
}

async function sites() {
  const firstParty = { id: 1, priority: 1, action: REMOVE_XFO,
    condition: { urlFilter: "*", domainType: "firstParty", resourceTypes: ["sub_frame"] } };
  const counted = (run) => {
    const reads = [];
    const read = run.browser.readBundleFile;
    run.browser.readBundleFile = function (url) {
      if (/public-suffix/.test(url)) {
        reads.push(url);
      }
      return read.call(this, url);
    };
    return reads;
  };
  {
    const run = start(fixture());
    const reads = counted(run);
    await wait();
    const dnr = run.page.chrome.declarativeNetRequest;
    await dnr.updateDynamicRules({ addRules: [{ id: 2, priority: 1, action: REMOVE_XFO,
      condition: { urlFilter: "*", resourceTypes: ["script"] } }] });
    await wait();
    await headersLeft(run, "https://x.example/", "script");
    equal("no rule with a domainType, no read of the list", reads.length, 0);
    await dnr.updateDynamicRules({ removeRuleIds: [2], addRules: [firstParty] });
    await wait();
    const before = reads.length;
    equal("sites are told by the list",
      await headersLeft(run, "https://b.example.com/", "sub_frame", { initiator: "https://a.example.com" }), STRIPPED);
    await headersLeft(run, "https://b.example.net/", "sub_frame", { initiator: "https://a.example.com" });
    equal("which the rules' preparation read once, and no request reads", [before, reads.length], [1, 1]);
  }
  {
    const run = start(fixture((c, dir) => {
      fs.unlinkSync(path.join(dir, "wex", "public-suffix-list.txt"));
    }));
    const reads = counted(run);
    await wait();
    await run.page.chrome.declarativeNetRequest.updateDynamicRules({ addRules: [firstParty] });
    await wait();
    equal("without the list a host is its own site",
      [await headersLeft(run, "https://b.example.com/", "sub_frame", { initiator: "https://a.example.com" }),
        await headersLeft(run, "https://a.example.com/x", "sub_frame", { initiator: "https://a.example.com" })],
      [KEPT, STRIPPED]);
    equal("and a list that is not there is looked for once", reads.length, 1);
  }
  const W2S = require(path.join(ROOT, "webext2safari", "js", "node.js"));
  const convert = async (manifest) => {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), "wex-core-fixes-"));
    fs.writeFileSync(path.join(source, "manifest.json"), JSON.stringify(manifest));
    fs.mkdirSync(path.join(source, "META-INF"));
    fs.writeFileSync(path.join(source, "META-INF", "mozilla.rsa"), "x");
    const result = await W2S.convert.convert({ source, files: W2S.node.readDirectory(source),
      runtime: W2S.node.runtime(), convertImage: W2S.node.convertImage });
    return result.files.isFile("wex/public-suffix-list.txt");
  };
  const gecko = { gecko: { id: "fox@example.com" } };
  equal("a Firefox build carries the list only with declarativeNetRequest",
    [await convert({ manifest_version: 2, name: "Fox", version: "1", browser_specific_settings: gecko,
      permissions: ["declarativeNetRequest"] }),
      await convert({ manifest_version: 2, name: "Fox", version: "1", browser_specific_settings: gecko })],
    [true, false]);
}

async function regularExpressions() {
  const run = start(fixture());
  await wait();
  const dnr = run.page.chrome.declarativeNetRequest;
  const supported = async (regex) => (await dnr.isRegexSupported({ regex })).isSupported;
  equal("a quantifier with nothing to repeat is not supported, and a pattern to restate is",
    [await supported("*abc"), await supported("a**"), await supported("+"), await supported("a|b\\d{2}"),
      await supported("^https://x/")],
    [false, false, false, true, true]);
  const rule = { id: 7, priority: 1, action: { type: "block" },
    condition: { regexFilter: "^https?://.*$", requestDomains: ["a.example"], resourceTypes: ["script"] } };
  await dnr.updateDynamicRules({ addRules: [rule] });
  equal("a regex that matches any URL reads back as written, and goes to the engine scoped",
    [await dnr.getDynamicRules({ ruleIds: [7] }),
      run.browser.engine.dnrState().dynamicRules.find((r) => r.id === 7).condition.urlFilter],
    [[rule], "|http"]);
  await dnr.updateDynamicRules({ removeRuleIds: [7] });
  equal("and is gone when removed", [await dnr.getDynamicRules(), run.browser.engine.dnrState().dynamicRules], [[], []]);
}

async function injection() {
  const dir = fixture();
  const valid = path.join(dir, "fffd.js");
  const invalid = path.join(dir, "latin.js");
  fs.writeFileSync(valid, "var replacement = '�'; 'ran';");
  fs.writeFileSync(invalid, Buffer.from([0x27, 0xE9, 0x27, 0x3B]));
  const run = start(dir);
  await wait();
  const chrome = run.page.chrome;
  const top = run.browser.createContentFrame(run.tab, run.frameFiles, { url: "https://example.com/page" });
  const sub = run.browser.createContentFrame(run.tab, run.frameFiles, { isTop: false, url: "https://example.com/frame" });
  await wait(60);
  const call = (file) => new Promise((resolve) => chrome.tabs.executeScript(run.tabId, { file }, (results) => {
    resolve(run.page.WEX.lastError ? run.page.WEX.lastError.message : results);
  }));
  const NOT_UTF8 = "Could not load file 'latin.js' for content script. It isn't UTF-8 encoded.";
  equal("where a file's bytes cannot be read, the character it holds does not refuse it",
    typeof (await call("latin.js")) !== "string", true);
  run.page.XMLHttpRequest.prototype.overrideMimeType = function () {
    const address = this._address;
    Object.defineProperty(this, "responseText", { configurable: true, set() {}, get() {
      const bytes = fs.readFileSync(path.join(dir, address.slice(run.browser.baseURI.length)));
      return Array.from(bytes).map((b) => String.fromCharCode(b < 0x80 ? b : 0xF700 + b)).join("");
    } });
  };
  equal("a UTF-8 file with a replacement character is injected, and one that is not UTF-8 refused",
    [await call("fffd.js"), await call("latin.js")], [["ran"], NOT_UTF8]);

  const hits = [];
  top.sandbox.chrome.runtime.onMessage.addListener((m, s, respond) => {
    hits.push("top");
    respond("top");
  });
  sub.sandbox.chrome.runtime.onMessage.addListener((m, s, respond) => {
    hits.push("sub");
    respond("sub");
  });
  const frames = await chrome.webNavigation.getAllFrames({ tabId: run.tabId });
  const documentId = frames.find((f) => f.frameId === sub.frameId).documentId;
  const nativeFrames = run.page.WEX.native.webNavigation.getAllFrames;
  run.page.WEX.native.webNavigation.getAllFrames = (details) => nativeFrames(details).then((list) => {
    list.forEach((f) => delete f.url);
    return list;
  });
  equal("a frame the engine gives no address for has an empty one",
    (await chrome.webNavigation.getAllFrames({ tabId: run.tabId })).map((f) => f.url), frames.map(() => ""));
  run.page.WEX.native.webNavigation.getAllFrames = nativeFrames;
  const answer = await chrome.tabs.sendMessage(run.tabId, { x: 1 }, { documentId });
  await wait(20);
  equal("tabs.sendMessage reaches the document it names", [hits, answer], [["sub"], "sub"]);
  hits.length = 0;
  const refused = await chrome.tabs.sendMessage(run.tabId, { x: 1 }, { documentId: "NO-SUCH-DOCUMENT" }).then(() => "sent", (e) => e.message);
  await wait(20);
  equal("and nothing for an id that is no document", [hits, refused], [[], "Could not establish connection. Receiving end does not exist."]);
  const where = await chrome.scripting.executeScript({ target: { tabId: run.tabId, documentIds: [documentId] },
    func: () => location.href });
  equal("scripting.executeScript runs in the document it names",
    where.map((r) => [r.frameId, r.result, r.documentId]), [[sub.frameId, "https://example.com/frame", documentId]]);
  const unnamed = await chrome.scripting.executeScript({ target: { tabId: run.tabId, documentIds: ["NO-SUCH-DOCUMENT"] },
    func: () => location.href }).then(() => "ran", (e) => e.message);
  equal("and refuses an id that is no document", unnamed, "No document with id NO-SUCH-DOCUMENT in tab with id " + run.tabId);
  const otherTab = documentId.slice(0, 9) + (documentId.charAt(9) === "F" ? "E" : "F") + documentId.slice(10);
  const elsewhere = await chrome.tabs.sendMessage(run.tabId, { x: 1 }, { documentId: otherTab }).then(() => "sent", () => "refused");
  equal("and an id of a document in another tab", elsewhere, "refused");
  const nothing = await new Promise((resolve) => chrome.tabs.executeScript(run.tabId, { code: "undefined" }, resolve));
  equal("a script that gives undefined gives null", nothing.map((r) => r === null), [true]);
  const voided = await chrome.scripting.executeScript({ target: { tabId: run.tabId }, func: () => {} });
  equal("and so does a function, with its frame's document",
    voided.map((r) => [r.frameId, r.result === null, typeof r.documentId]), [[0, true, "string"]]);
}

async function remoteEvents() {
  const run = start(fixture());
  await wait();
  const ports = [];
  const native = { runtime: {
    connect() {
      const port = { sent: [], onMessage: { addListener() {} }, closed: null,
        onDisconnect: { addListener(fn) { port.closed = fn; } },
        postMessage(message) { port.sent.push(message.subscribe); } };
      ports.push(port);
      return port;
    },
    sendMessage() { return Promise.resolve({}); }
  } };
  const remote = run.page.WEX.makeRemote(native);
  remote.event("storage.onChanged").addListener(() => {});
  remote.event("alarms.onAlarm").addListener(() => {});
  equal("a remote event subscribes once on its port", ports[0].sent, ["storage.onChanged", "alarms.onAlarm"]);
  ports[0].closed();
  await wait(50);
  remote.event("tabs.onUpdated").addListener(() => {});
  await wait(2200);
  equal("a listener added while the far end is away does not lose the others' subscriptions",
    [ports.length, ports[1].sent.slice().sort()], [2, ["alarms.onAlarm", "storage.onChanged", "tabs.onUpdated"]]);
  ports[1].closed();
  await wait(2200);
  equal("and with none added they come back on their own",
    [ports.length, ports[2].sent.slice().sort()], [3, ["alarms.onAlarm", "storage.onChanged", "tabs.onUpdated"]]);
}

async function main() {
  const quiet = console.error;
  console.error = () => {};
  const groups = [legacyRequests, responseRules, refusedHeaders, sites, regularExpressions, injection, remoteEvents];
  for (const group of groups) {
    try {
      await group();
    } catch (e) {
      failures.push(group.name + " threw: " + (e && e.message));
    }
  }
  console.error = quiet;
  console.log(passed + " checks passed, " + failures.length + " failed");
  failures.forEach((failure) => console.log("  FAIL  " + failure));
  process.exit(failures.length ? 1 : 0);
}

main();
