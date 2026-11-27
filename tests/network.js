// Native authentication headers and absence of website-visible helpers.
// node tests/network.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const source = fs.readFileSync(path.join(__dirname, "../webext2safari/runtime/wex-network.js"), "utf8");
const safariOrigin = "safari-extension://test-team";
const baseURI = safariOrigin + "/token/";
const chromeOrigin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const api = "https://api.example.com/session";
const CHROME_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/156.0.0.0 Safari/537.36";
const BRANDS = "\"Google Chrome\";v=\"156\", \"Chromium\";v=\"156\", \"Not.A/Brand\";v=\"99\"";
const SAFARI_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_9_5) AppleWebKit/537.78.2 (KHTML, like Gecko) " +
  "Version/7.0.6 Safari/537.78.2";
function harness(sourceOrigin = chromeOrigin, manifest = { web_accessible_resources: ["*.html"] }, windows = [],
  filters = null) {
  const listeners = {};
  const webRequest = {};
  if (filters) {
    // The engine's StreamFilter, recording what the listener writes.
    webRequest.filterResponseData = (requestId) => {
      const filter = { written: [], write(bytes) { this.written.push(Buffer.from(bytes)); },
        close() { this.closed = true; }, output() { return Buffer.concat(this.written).toString("utf8"); } };
      filters[requestId] = filter;
      return filter;
    };
  }
  const webNavigation = {};
  const tabEvents = {};
  function event(table, name) {
    listeners[name] = [];
    table[name] = {
      addListener(fn, filter, spec) { listeners[name].push({ fn, filter, spec }); },
      removeListener(fn) { listeners[name] = listeners[name].filter(entry => entry.fn !== fn); }
    };
  }
  for (const name of ["onBeforeRequest", "onBeforeSendHeaders", "onHeadersReceived", "onCompleted",
    "onErrorOccurred", "onBeforeRedirect"]) {
    event(webRequest, name);
  }
  event(webNavigation, "onBeforeNavigate");
  event(webNavigation, "onCommitted");
  event(tabEvents, "onRemoved");
  const tabs = new Proxy({}, { get: (target, name) => name === "onRemoved" ? tabEvents.onRemoved :
    name === "get" ? (tab) => Promise.resolve({ id: tab.engineId, url: tab.url }) : forbidden });
  const originalFetch = () => Promise.resolve(new Response("direct", { status: 401 }));
  const forbidden = () => { throw new Error("Network compatibility must not touch a page or open a tab"); };
  const background = { WEX: {
    CONFIG: { sourceOrigin, networkHosts: ["https://api.example.com/*", "wss://relay.example.com/*"], manifest },
    WEB_ORIGIN: sourceOrigin,
    webFacingText: (text) => text.split(baseURI.slice(0, -1)).join(sourceOrigin),
    requestIdentity: () => ({ userAgent: CHROME_UA, clientHints: [{ name: "sec-ch-ua", value: BRANDS },
      { name: "sec-ch-ua-mobile", value: "?0" }, { name: "sec-ch-ua-platform", value: "\"macOS\"" }] }),
    origin: safariOrigin, baseURI,
    native: { webRequest, webNavigation, tabs,
      runtime: new Proxy({}, { get: () => forbidden }) },
    matchesAny: (url, patterns) => patterns.some(pattern => url.startsWith(pattern.slice(0, -1))),
    // As the runtime gives them from the manifest's web_accessible_resources.
    openingSites: () => [].concat(...(manifest.web_accessible_resources || []).map(entry =>
      typeof entry === "string" ? ["http://*/*", "https://*/*"] :
        entry.resources && entry.resources.length && entry.matches ? entry.matches : []))
      .filter((match, i, all) => /^(\*|https?):\/\//.test(match) && all.indexOf(match) === i),
    // The pages a site may open: all but private.html.
    bytesToBase64: (bytes) => Buffer.from(bytes).toString("base64"),
    uid: (prefix) => prefix + "-1",
    runtimeId: chromeOrigin.slice("chrome-extension://".length),
    ancestorPatterns: function ancestorPatterns(safari, chrome) {},
    pageRuntime: function pageRuntime(token, id) {},
    framedPageRelay: function framedPageRelay(token, origin) {},
    pageFromWeb: (url, from) => url.startsWith(chromeOrigin + "/") && !url.includes("private.html") && from ?
      baseURI + url.slice(chromeOrigin.length + 1) : null
  }, safari: { application: { browserWindows: windows } },
  TextEncoder, crypto: globalThis.crypto, location: { href: baseURI + "wex-global-page.html" },
  fetch: originalFetch, document: new Proxy({}, { get: () => forbidden }),
    chrome: { tabs: new Proxy({}, { get: () => forbidden }) } };
  vm.runInNewContext(source, background);
  assert.strictEqual(background.fetch, originalFetch, "leave background fetch unchanged");
  return listeners;
}
const hooks = harness();
// The extension's own documents' listeners start out on tab -1 alone, where
// the global page, popovers and bars load; a website's tabs are left alone.
assert.equal(hooks.onBeforeSendHeaders.length, 1);
assert.deepEqual(Array.from(hooks.onBeforeSendHeaders[0].spec), ["blocking", "requestHeaders", "extraHeaders"]);
assert.deepEqual(Array.from(hooks.onHeadersReceived[1].spec), ["blocking", "responseHeaders", "extraHeaders"]);
assert.equal(hooks.onBeforeSendHeaders[0].filter.tabId, -1);
assert(hooks.onHeadersReceived.slice(1).every(entry => entry.filter.tabId === -1));
assert(hooks.onCompleted.concat(hooks.onErrorOccurred, hooks.onBeforeRedirect).every(entry => entry.filter.tabId === -1));
const rewrite = hooks.onBeforeSendHeaders[0].fn;
const cors = hooks.onHeadersReceived[1].fn;
const completed = hooks.onCompleted[0].fn;
const failed = hooks.onErrorOccurred[0].fn;
const headers = [{ name: "Content-Type", value: "application/json" },
  { name: "Origin", value: safariOrigin }, { name: "Authorization", value: "fixture" }];
const changed = rewrite({ url: api, documentUrl: baseURI + "popup.html", requestHeaders: headers });
assert.equal(changed.requestHeaders[1].value, chromeOrigin);
assert.equal(changed.requestHeaders[2].value, "fixture");
assert.equal(headers[1].value, safariOrigin, "leave the original event object unchanged");
assert.equal(rewrite({ url: api, initiator: safariOrigin.toUpperCase(), requestHeaders: headers })
  .requestHeaders[1].value, chromeOrigin, "origin identity is case-insensitive");
assert.equal(rewrite({ url: api, initiator: "https://example.com", requestHeaders: headers }), undefined,
  "website requests keep their identity");
assert.equal(rewrite({ url: api, documentUrl: safariOrigin + ".attacker/token/popup.html",
  requestHeaders: headers }), undefined, "lookalike extension URLs are not trusted");
const header = (result, name) => {
  const found = (result.requestHeaders || []).filter(h => h.name.toLowerCase() === name.toLowerCase());
  return found.length ? found.map(h => h.value).join(" | ") : null;
};
assert.equal(header(rewrite({ url: "https://other.example.com/", initiator: safariOrigin,
  requestHeaders: headers }), "Origin"), safariOrigin, "the Origin stays within host permissions");
assert.equal(header(rewrite({ url: api, initiator: safariOrigin, requestHeaders: [
  { name: "Origin", value: "https://custom.example.com" }
] }), "Origin"), "https://custom.example.com", "preserve unrelated explicit origins");
assert.equal(header(rewrite({ url: api, initiator: safariOrigin, requestHeaders: [] }), "Origin"), null,
  "do not add an Origin to requests without one");
const handshake = [{ name: "Upgrade", value: "websocket" }, { name: "Origin", value: safariOrigin }];
assert.equal(header(rewrite({ url: "wss://relay.example.com/chrome/u", method: "GET", type: "websocket",
  initiator: safariOrigin, requestHeaders: handshake }), "Origin"), chromeOrigin,
  "a WebSocket handshake within host permissions names the extension as Chrome does");
assert.equal(header(rewrite({ url: "wss://other.example.com/socket", method: "GET", type: "websocket",
  initiator: safariOrigin, requestHeaders: handshake }), "Origin"), safariOrigin,
  "a WebSocket handshake outside host permissions keeps Safari's origin");

// Every request of the extension's own documents names the browser it was
// built for, whatever its host permissions; a website's keeps Safari's.
assert.deepEqual(Array.from(hooks.onBeforeSendHeaders[0].filter.urls),
  ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"]);
const named = rewrite({ url: "https://translate.example/auth", method: "GET", initiator: safariOrigin,
  requestHeaders: [{ name: "User-Agent", value: SAFARI_UA }, { name: "Accept", value: "*/*" }] });
assert.deepEqual([header(named, "User-Agent"), header(named, "sec-ch-ua"), header(named, "sec-ch-ua-mobile"),
  header(named, "sec-ch-ua-platform"), header(named, "Accept")],
  [CHROME_UA, BRANDS, "?0", "\"macOS\"", "*/*"], "the browser's user agent and client hints");
const plain = rewrite({ url: "http://plain.example/", documentUrl: baseURI + "popup.html",
  requestHeaders: [{ name: "user-agent", value: SAFARI_UA }, { name: "Sec-CH-UA", value: "stale" }] });
assert.deepEqual([header(plain, "User-Agent"), header(plain, "sec-ch-ua")], [CHROME_UA, null],
  "client hints go to secure addresses alone, as Chrome sends them");
assert.equal(rewrite({ url: "https://site.example/", initiator: "https://site.example",
  documentUrl: "https://site.example/", requestHeaders: [{ name: "User-Agent", value: SAFARI_UA }] }), undefined,
  "a website's requests keep Safari's user agent");
const unknown = harness(null);
assert.deepEqual([unknown.onBeforeSendHeaders.length, unknown.onHeadersReceived.length, unknown.onBeforeRequest.length],
  [1, 0, 0], "a build the web knows by no address still names its browser, and nothing else");
const unnamed = unknown.onBeforeSendHeaders[0].fn({ url: api, method: "POST", initiator: safariOrigin,
  requestHeaders: [{ name: "Origin", value: safariOrigin }] });
assert.deepEqual([header(unnamed, "User-Agent"), header(unnamed, "Origin")], [CHROME_UA, safariOrigin]);

const request = { url: api, initiator: safariOrigin, documentUrl: baseURI + "wex-global-page.html",
  method: "POST", requestId: "wk1-global-request", tabId: -1, frameId: 0, requestHeaders: headers };
rewrite(request);
const responseHeaders = [{ name: "Access-Control-Allow-Origin", value: chromeOrigin },
  { name: "Access-Control-Allow-Credentials", value: "true" }, { name: "X-Fixture", value: "yes" }];
const response = { ...request, statusCode: 200, responseHeaders };
const adjusted = cors(response);
assert.equal(adjusted.responseHeaders[0].value, safariOrigin, "CORS checks use the real Safari origin");
assert.equal(adjusted.responseHeaders[1].value, "true", "keep credential policy intact");
assert.equal(adjusted.responseHeaders[2].value, "yes");
assert.equal(responseHeaders[0].value, chromeOrigin, "leave the original response event unchanged");
assert.equal(cors({ ...response, statusCode: 401 }).responseHeaders[0].value, safariOrigin,
  "CORS handling does not hide failed authentication responses");
assert.equal(cors({ ...response, requestId: "unknown" }), undefined, "only translate requests we changed");
assert.equal(cors({ ...response, documentUrl: "https://example.com/", initiator: "https://example.com" }),
  undefined, "website responses retain their original CORS policy");
assert.equal(cors({ ...response, url: "https://other.example.com/" }), undefined,
  "responses outside host permissions are unchanged");
for (const value of ["*", "null", "https://another.example.com", safariOrigin]) {
  assert.equal(cors({ ...response, responseHeaders: [{ name: "Access-Control-Allow-Origin", value }] }),
    undefined, "preserve a CORS policy that did not echo the Chrome identity");
}
completed(response);
assert.equal(cors(response), undefined, "finished requests are forgotten");
rewrite(request);
failed(request);
assert.equal(cors(response), undefined, "failed requests are forgotten");
rewrite(request);
rewrite({ ...request, initiator: "https://example.com", documentUrl: "https://example.com/" });
assert.equal(cors(response), undefined, "reusing a request ID cannot translate website responses");
rewrite(request);
hooks.onBeforeRedirect[0].fn({ ...response, redirectUrl: "https://other.example.com/" });
assert.equal(cors(response), undefined, "redirects outside permissions are forgotten");
rewrite({ ...request, requestHeaders: [] });
assert.equal(cors(response).responseHeaders[0].value, safariOrigin, "write requests with no Origin also get CORS translation");
assert.equal(header(rewrite({ ...request, method: "POST", requestHeaders: [] }), "Origin"),
  chromeOrigin, "supply the identity for extension write requests without Origin");
rewrite({ ...request, requestHeaders: [{ name: "Origin", value: "https://custom.example.com" }] });
assert.equal(cors(response), undefined, "unrelated explicit request origins do not activate CORS translation");
// A site that sends the tab back to the extension's Chrome address lands it on
// the extension's page here, with the same path and query.
const signIn = hooks.onHeadersReceived[0];
assert.deepEqual(Array.from(signIn.filter.types), ["main_frame", "sub_frame"]);
assert.deepEqual(Array.from(signIn.filter.urls), ["http://*/*", "https://*/*"], "on any site");
const redirected = signIn.fn({ url: api, statusCode: 302, responseHeaders: [
  { name: "Location", value: chromeOrigin + "/oauth_callback.html?code=c&state=s" },
  { name: "Cache-Control", value: "no-store" }] });
assert.deepEqual(redirected.responseHeaders.map(h => h.value),
  [baseURI + "oauth_callback.html?code=c&state=s", "no-store"]);
assert.equal(signIn.fn({ url: api, statusCode: 302, responseHeaders: [
  { name: "Location", value: "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/page.html" }] }), undefined,
  "another extension's address is left as the site sent it");
assert.equal(signIn.fn({ url: api, statusCode: 200, responseHeaders: [
  { name: "Location", value: chromeOrigin + "/page.html" }] }), undefined, "only redirects are followed");
assert.equal(signIn.fn({ url: "https://elsewhere.example/", statusCode: 302, responseHeaders: [
  { name: "Location", value: chromeOrigin + "/private.html" }] }), undefined,
  "a page the manifest keeps from sites is left as the site sent it");
const framing = hooks.onHeadersReceived[2];
assert.deepEqual(Array.from(framing.filter.types), ["sub_frame"]);
// A site that lets the extension's Chrome pages frame it lets its pages here
// frame it too, and no one else.
const csp = (value, extra) => framing.fn({ url: api, statusCode: 200, type: "sub_frame", ...extra,
  responseHeaders: [{ name: "Content-Security-Policy", value }] });
const framed = csp("default-src 'self'; frame-ancestors 'self' " + chromeOrigin +
  " chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba; img-src *");
assert.equal(framed.responseHeaders[0].value, "default-src 'self'; frame-ancestors 'self' " + chromeOrigin +
  " chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba " + safariOrigin + "; img-src *");
assert.equal(csp("frame-ancestors " + chromeOrigin + "/").responseHeaders[0].value,
  "frame-ancestors " + chromeOrigin + "/ " + safariOrigin);
assert.equal(csp("frame-ancestors 'self' chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba"), undefined,
  "another extension's permission to frame the site is not this extension's");
assert.equal(csp("default-src " + chromeOrigin), undefined, "only frame-ancestors names who may frame");
assert.equal(csp("frame-ancestors " + chromeOrigin + "x"), undefined, "a longer origin is another origin");
assert.equal(csp("frame-ancestors " + chromeOrigin, { type: "main_frame" }), undefined,
  "a top-level page has no ancestors");
// A request whose address carries the extension's Safari address goes to the
// one the web knows, and only such requests are held for it.
const facing = hooks.onBeforeRequest[0];
assert.deepEqual(Array.from(facing.filter.urls), ["*://*/*safari-extension*"]);
assert.deepEqual(facing.fn({ url: "https://site.example/a?cb=" + baseURI + "cb.html" }),
  { redirectUrl: "https://site.example/a?cb=" + chromeOrigin + "/cb.html" });
assert.equal(facing.fn({ url: "https://site.example/a?cb=x" }), undefined);
// A tab is watched while a frame in it shows one of the extension's pages,
// from the moment the frame starts toward one, and only then.
const count = () => hooks.onBeforeSendHeaders.length;
hooks.onBeforeNavigate[0].fn({ tabId: 7, frameId: 0, url: "https://site.example/" });
assert.equal(count(), 1, "a website's navigation leaves its tab alone");
hooks.onBeforeNavigate[0].fn({ tabId: 7, frameId: 0, url: baseURI + "options.html" });
assert.equal(count(), 2);
assert.equal(hooks.onBeforeSendHeaders[1].filter.tabId, 7);
hooks.onCommitted[0].fn({ tabId: 7, frameId: 0, url: baseURI + "options.html" });
hooks.onCommitted[0].fn({ tabId: 7, frameId: 3, url: baseURI + "frame.html" });
hooks.onCommitted[0].fn({ tabId: 7, frameId: 0, url: "https://site.example/" });
assert.equal(count(), 1, "a tab that moves on to a website is let go, its frames with it");
assert.equal(hooks.onHeadersReceived.length, 3);
hooks.onCommitted[0].fn({ tabId: 8, frameId: 0, url: "https://site.example/" });
hooks.onCommitted[0].fn({ tabId: 8, frameId: 2, url: baseURI + "frame.html" });
assert.equal(count(), 2, "a website that frames one of the extension's pages");
hooks.onCommitted[0].fn({ tabId: 8, frameId: 2, url: "https://other.example/" });
assert.equal(count(), 1);
hooks.onCommitted[0].fn({ tabId: 9, frameId: 0, url: baseURI + "options.html" });
hooks.onRemoved[0].fn(9);
assert.equal(count(), 1, "a closed tab is let go");
assert.equal(hooks.onBeforeSendHeaders[0].filter.tabId, -1, "tab -1 is always watched");
signIn.fn({ url: api, tabId: 11, statusCode: 302, responseHeaders: [
  { name: "Location", value: chromeOrigin + "/oauth_callback.html" }] });
assert.equal(hooks.onBeforeSendHeaders[1].filter.tabId, 11, "a tab sent to the extension's page is watched");
// A site may send a frame to the extension only where the manifest lets it
// open one of its files.
const sitesOf = manifest => harness(chromeOrigin, manifest).onHeadersReceived
  .filter(entry => entry.filter.types && entry.filter.types.includes("main_frame"))
  .map(entry => Array.from(entry.filter.urls));
assert.deepEqual(sitesOf({}), [], "no site may open any file");
assert.deepEqual(sitesOf({ web_accessible_resources: [{ resources: ["a.html"], matches: ["https://one.example/*",
  "file:///*"] }, { resources: ["b.png"], extension_ids: ["x"] }] }), [["https://one.example/*"]]);
// A site in a frame of one of the extension's pages outside a tab, where
// Safari runs no content script, gets a script first in its document, which
// its Content-Security-Policy lets run by a nonce: the extension's Chrome
// origin among its ancestors, and, where externally_connectable lets the
// site in and a page of the extension frames it, chrome.runtime for web pages.
{
  const filters = {};
  const framedHooks = harness(chromeOrigin, { web_accessible_resources: ["*.html"],
    externally_connectable: { matches: ["https://api.example.com/*"] } }, [], filters);
  const before = framedHooks.onBeforeRequest.find(entry => entry.filter.types &&
    entry.filter.types.includes("sub_frame"));
  const received = framedHooks.onHeadersReceived.filter(entry => entry.filter.tabId === -1 && entry.filter.types &&
    entry.filter.types.includes("sub_frame"));
  assert.deepEqual([before.filter.tabId, Array.from(before.filter.urls), Array.from(before.spec), received.length],
    [-1, ["http://*/*", "https://*/*"], ["blocking"], 1], "one listener makes every change to a frame's headers");
  const heads = received[0].fn;
  let n = 0;
  const load = (url, documentUrl, responseHeaders, chunks, extra) => {
    const requestId = "frame-" + (++n);
    const details = { requestId, url, documentUrl, tabId: -1, type: "sub_frame", ...extra };
    before.fn(details);
    const filter = filters[requestId];
    const headers = heads({ ...details, statusCode: 200, responseHeaders });
    if (filter) {
      chunks.forEach(chunk => filter.ondata({ data: new TextEncoder().encode(chunk).buffer }));
      filter.onstop();
    }
    const nonce = filter && (/<script nonce="([^"]+)">/.exec(filter.output()) || [])[1];
    return { filter, headers, nonce, output: filter && filter.output(),
      policy: headers && headers.responseHeaders.filter(h => /security/i.test(h.name)).map(h => h.value) };
  };
  const html = { name: "Content-Type", value: "text/html; charset=utf-8" };
  const policy = (value) => ({ name: "Content-Security-Policy", value });
  const app = "https://api.example.com/app";
  const popup = baseURI + "popup.html";

  const inPopover = load(app, popup, [html, policy("script-src 'nonce-abc' 'strict-dynamic'; frame-ancestors " +
    chromeOrigin)], ["<!DOCTYPE html>\n<html><he", "ad lang=\"en\"><title>t</title>", "<body>b</body>"]);
  const script = /<script nonce="[^"]+">([^]*?)<\/script>/.exec(inPopover.output);
  assert.deepEqual(inPopover.policy, ["script-src 'nonce-abc' 'strict-dynamic' 'nonce-" + inPopover.nonce +
    "'; frame-ancestors " + chromeOrigin + " " + safariOrigin], "the nonce joins the frame's other changes");
  assert.equal(inPopover.output.replace(script[0], ""),
    "<!DOCTYPE html>\n<html><head lang=\"en\"><title>t</title><body>b</body>", "the document is otherwise the site's");
  assert(inPopover.output.indexOf("<head lang=\"en\">" + script[0]) > 0, "the script comes first in the head");
  assert.deepEqual([/ancestorPatterns.*\}\)\("safari-extension:\/\/test-team", "chrome-extension:/.test(script[1]),
    /pageRuntime.*\}\)\("page-1", "abcdefghijklmnopabcdefghijklmnop"\)/.test(script[1]),
    /framedPageRelay.*\}\)\("page-1", "safari-extension:\/\/test-team"\)/.test(script[1]), inPopover.filter.closed],
    [true, true, true, true]);

  const otherSite = load("https://other.example/", popup, [html], ["<html><head></head></html>"]);
  assert.deepEqual([/ancestorPatterns/.test(otherSite.output), /pageRuntime/.test(otherSite.output)], [true, false],
    "a site externally_connectable leaves out has only the ancestor");
  const inGlobalPage = load(app, baseURI + "wex-global-page.html", [html], ["<head></head>"]);
  assert.deepEqual([/ancestorPatterns/.test(inGlobalPage.output), /pageRuntime/.test(inGlobalPage.output)],
    [true, false], "a frame of the global page has no page to reach the extension through");
  const data = load(app, popup, [{ name: "Content-Type", value: "application/json" }, policy("default-src 'none'")],
    ["{\"a\":1}"]);
  assert.equal(data.output, "{\"a\":1}", "a document that is not HTML is the site's as sent");
  assert(/^default-src 'nonce-[^']+'$/.test(data.policy[0]), "'none' gives way to the nonce");
  const bare = load(app, popup, [html], ["plain"]);
  assert(/^<script nonce="[^"]+">[^]*<\/script>plain$/.test(bare.output), "with no head or doctype, at the start");
  const doctypeOnly = load(app, popup, [html], ["﻿<!doctype html><p>x"]);
  assert(/^﻿<!doctype html><script nonce=/.test(doctypeOnly.output), "past the byte order mark and doctype");
  const header = load(app, popup, [html], ["<!doctype html><header>", "</header>"]);
  assert(/^<!doctype html><script /.test(header.output), "a <header> is not the head");

  const rules = (value) => load(app, popup, [policy(value)], []).policy;
  assert.equal(rules("script-src 'self' 'unsafe-inline'"), undefined, "every inline script runs already");
  assert.equal(rules("img-src *"), undefined, "no rule for scripts");
  assert(/^script-src-elem 'self' 'nonce-[^']+'; script-src 'none'$/.test(
    rules("script-src-elem 'self'; script-src 'none'")[0]), "the rule for script elements is the one that decides");
  assert(/^script-src 'unsafe-inline' 'sha256-x' 'nonce-[^']+', default-src 'nonce-[^']+'$/.test(
    rules("script-src 'unsafe-inline' 'sha256-x', default-src 'none'")[0]), "each policy of a header");

  assert.equal(load(app, popup, [html], [], { tabId: 5 }).filter, undefined, "a tab's frames have content scripts");
  assert.equal(load(app, "https://site.example/", [html], [], { initiator: "https://site.example" }).filter,
    undefined, "a site's own frames are left alone");
  assert.equal(load(app, popup, [html], [], { type: "main_frame" }).filter, undefined);
  const plainHooks = harness(chromeOrigin, undefined, [], null);
  assert(!plainHooks.onBeforeRequest.some(entry => entry.filter.types), "an engine with no response filters");
}
// A tab that already shows one of the extension's pages when the global page
// starts is watched, found among Safari's windows.
(async () => {
  const started = harness(chromeOrigin, undefined, [{ tabs: [{ engineId: 21, url: baseURI + "options.html" },
    { engineId: 22, url: "https://site.example/" }] }, { tabs: [] }]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(started.onBeforeSendHeaders.map((entry) => entry.filter.tabId), [-1, 21]);
  console.log("Native identity, scoped CORS, cleanup, sign-in redirects, framing and no website/tab helper checks passed");
})();
