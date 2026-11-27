// Tests of the converter.
//
//     node tests/convert.js

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const plist = require("./plist");
const W2S = require("../webext2safari/js/node.js");

let passed = 0;
let failed = 0;

function equal(message, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log("  ok    " + message);
  } else {
    failed++;
    console.log("  FAIL  " + message + " - got " + a + ", expected " + e);
  }
}

function utf8(data) {
  return data === null || data === undefined ? null : Buffer.from(data).toString("utf8");
}

// Converts the extension whose files `files` maps from path to contents,
// with `extra` options for the converter.
async function convert(files, extra) {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "webext2safari-convert-"));
  try {
    for (const name of Object.keys(files)) {
      const target = path.join(source, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, files[name]);
    }
    const result = await W2S.convert.convert({
      source,
      files: W2S.node.readDirectory(source),
      runtime: W2S.node.runtime(),
      convertImage: W2S.node.convertImage,
      ...extra
    });
    return {
      result,
      text: (name) => utf8(result.files.read(name)),
      config: () => {
        const text = utf8(result.files.read("wex/wex-config.js"));
        return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
      },
      info: () => {
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "webext2safari-plist-")), "Info.plist");
        try {
          fs.writeFileSync(file, result.files.read("Info.plist"));
          return plist.read(file);
        } finally {
          fs.rmSync(path.dirname(file), { recursive: true, force: true });
        }
      }
    };
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
  }
}

// -- the converter's rewrites of the extension's scripts ---------------- //

function chromeOrigins() {
  console.log("Addresses built on chrome-extension://");
  const js = W2S.javascript;
  for (const expression of ["id", "sender.id", "message.sender.id", "chrome.runtime.id"]) {
    const out = js.rewriteChromeOrigins('var url = "chrome-extension://" + ' + expression + ' + "/asset.png";');
    equal("one built on " + expression + " asks the runtime",
      [out.count, out.source.includes("WEX.chromeExtensionOrigin(" + expression + ")"),
        out.source.endsWith(' + "/asset.png";')], [1, true, true]);
  }
  const named = js.rewriteChromeOrigins("'chrome-extension://' + metadata.owner + '/' + arbitraryPath === url");
  equal("no extension name or file name is needed",
    [named.count, named.source.includes("WEX.chromeExtensionOrigin(metadata.owner)")], [1, true]);
  for (const source of [
    "var s = '\\\"chrome-extension://\\\" + sender.id + \\\"/\\\"';",
    '// "chrome-extension://" + sender.id + "/"',
    '/* "chrome-extension://" + sender.id + "/" */',
    '"chrome-extension://" + lookup() + "/"',
    '"chrome-extension://" + ids[index] + "/"',
    '"chrome-extension://" + id /* comment */ + "/"',
    'var re = /"chrome-extension:\\/\\/" + id + "\\/"/;',
    '`"chrome-extension://" + id + "/"`',
    "html`<img src=\"chrome-extension://${id}/a.png\">`",
    "`chrome-extension://${a + b}/x`",
    "`chrome-extension://${id}`"
  ]) {
    equal("left alone: " + source, js.rewriteChromeOrigins(source), { source, count: 0 });
  }
  equal("division is told from a regular expression",
    js.rewriteChromeOrigins('var x = a / b; "chrome-extension://" + id + "/"').count, 1);
  const templated = js.rewriteChromeOrigins("ok = url.startsWith(`chrome-extension://${t}/`) || `a chrome-extension://${cfg.id}/p?${q}`;");
  equal("one built in a template asks the runtime, the template's other parts as they were",
    [templated.count, templated.source.startsWith("ok = url.startsWith(`${(typeof WEX"),
      templated.source.includes("WEX.chromeExtensionOrigin(t)"), templated.source.includes("}/`)"),
      templated.source.includes("`a ${(typeof WEX"), templated.source.includes("WEX.chromeExtensionOrigin(cfg.id)"),
      templated.source.endsWith(")}/p?${q}`;")],
    [2, true, true, true, true, true, true]);
  const once = js.rewriteChromeOrigins('var a = "chrome-extension://" + id + "/";\r\n');
  {
    const renamed = { "resources/dialog/A.js": "resources_/dialog/A.js" };
    const source = 'import X from "/resources/dialog/A.js";\nexport { y } from "../resources/dialog/A.js";\n' +
      'import "/resources/dialog/A.js";\nimport("/resources/dialog/A.js");\nconst key = "/resources/dialog/A.js";';
    equal("module specifiers follow a renamed folder, and other strings stay",
      js.rewriteModuleSpecifiers(source, "common", renamed).source,
      'import X from "/resources_/dialog/A.js";\nexport { y } from "../resources_/dialog/A.js";\n' +
      'import "/resources_/dialog/A.js";\nimport("/resources_/dialog/A.js");\nconst key = "/resources/dialog/A.js";');
  }
  equal("line endings are kept, and a second pass changes nothing",
    [once.count, once.source.endsWith("\r\n"), js.rewriteChromeOrigins(once.source).count], [1, true, 0]);
}

function moduleOriginPaths() {
  console.log("Paths built on a module's origin");
  const js = W2S.javascript;
  for (const source of [
    "const path = `${new URL(import.meta.url).origin}/addons/${id}/main.js`;",
    'const path = new URL(import.meta.url).origin + "/images/icon.svg";'
  ]) {
    const out = js.rewriteModuleOriginPaths(source);
    equal("rewritten once: " + source,
      [out.count, out.source.includes('url.href.split("/").slice(0, 4).join("/")'),
        js.rewriteModuleOriginPaths(out.source).count], [1, true, 0]);
  }
  for (const source of [
    "const s = 'new URL(import.meta.url).origin + \"/file\"';",
    '// new URL(import.meta.url).origin + "/file"',
    "/* `${new URL(import.meta.url).origin}/file` */",
    '`new URL(import.meta.url).origin + "/file"`',
    "`\\${new URL(import.meta.url).origin}/file`",
    "new URL(import.meta.url).origin === location.origin",
    'new URL(otherURL).origin + "/file"',
    "`prefix${new URL(import.meta.url).origin}suffix`",
    'const re = /new URL(import.meta.url).origin + "/file"/;',
    "`unterminated ${new URL(import.meta.url).origin}/file"
  ]) {
    equal("left alone: " + source, js.rewriteModuleOriginPaths(source), { source, count: 0 });
  }
  for (const source of [
    'const ratio = a / b; new URL(import.meta.url).origin + "/file";',
    'const r = /x/; const p = new URL(import.meta.url).origin + "/file";'
  ]) {
    equal("found past a slash: " + source, js.rewriteModuleOriginPaths(source).count, 1);
  }
  const nested = js.rewriteModuleOriginPaths(
    "const s = `${render({path: `${new URL(import.meta.url).origin}/x`})}`;\r\n");
  equal("a nested interpolation is found, and line endings are kept",
    [nested.count, nested.source.endsWith("\r\n")], [1, true]);

  const source = "`${new URL(import.meta.url).origin}/addons/${id}/userscript.js`";
  const rewritten = js.rewriteModuleOriginPaths(source).source;
  for (const [moduleUrl, expected] of [
    ["safari-extension://bundle-TEAM/session-token/content/inject/main.js",
      "safari-extension://bundle-TEAM/session-token/addons/example/userscript.js"],
    ["chrome-extension://bundle/content/inject/main.js", null],
    ["https://example.com/content/inject/main.js", "https://example.com/addons/example/userscript.js"]
  ]) {
    const run = (code) => vm.runInNewContext('const id = "example"; ' +
      code.replace(/import\.meta\.url/g, JSON.stringify(moduleUrl)), { URL });
    equal("evaluates without the runtime for " + moduleUrl.split(":")[0],
      run(rewritten), expected === null ? run(source) : expected);
  }
}

function locationPaths() {
  console.log("Reads of location.pathname, location.origin and location.href");
  const rewrite = (source) => W2S.javascript.rewriteLocationPaths(source).source;
  equal("a read of the window's location asks the runtime, with a fallback",
    [rewrite('if (location.pathname === "/popup.html") go()'),
      rewrite("u = window.location.origin + self.location.pathname"),
      rewrite("q = `${location.pathname}`")],
    ['if ((location.__wexPathname ?? location.pathname) === "/popup.html") go()',
      "u = (window.location.__wexOrigin ?? window.location.origin) + " +
        "(self.location.__wexPathname ?? self.location.pathname)",
      "q = `${(location.__wexPathname ?? location.pathname)}`"]);
  equal("an address is read as the runtime gives it",
    [rewrite("if (!location.href.includes(\"BG.js\")) throw e"), rewrite('location.href = "x"')],
    ['if (!(location.__wexHref ?? location.href).includes("BG.js")) throw e', 'location.href = "x"']);
  equal("an origin is read as the runtime gives the extension's, wherever it is read",
    [rewrite('u = location.origin + "/x.html"'), rewrite("if (event.origin !== location.origin) return"),
      rewrite('const origin=location.origin;b=(origin==="null"?"file:///":origin)+location.pathname;')],
    ['u = (location.__wexOrigin ?? location.origin) + "/x.html"',
      "if (event.origin !== (location.__wexOrigin ?? location.origin)) return",
      'const origin=(location.__wexOrigin ?? location.origin);' +
        'b=(origin==="null"?"file:///":origin)+(location.__wexPathname ?? location.pathname);']);
  for (const source of [
    'location.pathname = "/x"', 'location.pathname += "x"', "location.origin ??= o",
    "router.location.pathname", "a.window.location.pathname", "location?.pathname",
    'x = a / b / c; y = /location.pathname/g.test(s); z = "location.pathname"; // location.pathname\n',
    "f(/[/ + location.pathname)"
  ]) {
    equal("left alone: " + source.trim(), rewrite(source), source);
  }
  equal("division is told from a regular expression",
    rewrite("n = 10 / 2 / location.pathname.length"),
    "n = 10 / 2 / (location.__wexPathname ?? location.pathname).length");
}

function workerGlobals() {
  console.log("A service worker's assignments of window-only globals");
  const rewrite = (source) => W2S.javascript.rewriteWorkerGlobals(source).source;
  equal("an assignment goes to the runtime's worker scope where there is one",
    [rewrite("globalThis.window={},(async()=>{})()"), rewrite("self.document = makeDocument();")],
    ["(globalThis.__wexWorkerScope ?? globalThis).window={},(async()=>{})()",
      "(self.__wexWorkerScope ?? self).document = makeDocument();"]);
  equal("as does one through a name a bundler gives the global, or `this`",
    [rewrite("e.window={}"), rewrite("n.g.window = {}"), rewrite("this.document = d")],
    ["(e.__wexWorkerScope ?? e).window={}", "(n.g.__wexWorkerScope ?? n.g).window = {}",
      "(this.__wexWorkerScope ?? this).document = d"]);
  equal("as do reads through self and globalThis, and a logical assignment",
    [rewrite("globalThis.window === x"), rewrite("x = self.document"), rewrite("globalThis.window ||= {}")],
    ["(globalThis.__wexWorkerScope ?? globalThis).window === x", "x = (self.__wexWorkerScope ?? self).document",
      "(globalThis.__wexWorkerScope ?? globalThis).window ||= {}"]);
  equal("and a read of self.location or globalThis.location as a whole",
    [rewrite("f(globalThis.location)"), rewrite("x = self.location;"), rewrite("self.location.pathname"),
      rewrite("self.location = u"), rewrite("self.location.reload()")],
    ["f((globalThis.__wexWorkerScope ?? globalThis).location)", "x = (self.__wexWorkerScope ?? self).location;",
      "self.location.pathname", "self.location = u", "self.location.reload()"]);
  equal("a destructuring of the global that takes its location, window or document reads the worker's view of it",
    [rewrite("const{atob:W,location:ne}=self;let{fetch:f}=self;"), rewrite("let {location} = globalThis;"),
      rewrite("({ document: d } = self)"), rewrite("const {a: {location: x}} = self"),
      rewrite("x = {location: 1} == self"), rewrite("const {location: l} = self.foo")],
    ["const{atob:W,location:ne}=(self.__wexWorkerSelf ?? self);let{fetch:f}=self;",
      "let {location} = (globalThis.__wexWorkerSelf ?? globalThis);", "({ document: d } = (self.__wexWorkerSelf ?? self))",
      "const {a: {location: x}} = self", "x = {location: 1} == self", "const {location: l} = self.foo"]);
  {
    const guarded = rewrite('var u = "document" in self && self.document.baseURI;');
    const run = (scope) => vm.runInNewContext("var self = this; this.document = { baseURI: 'x' };" +
      (scope ? "Object.defineProperty(this, '__wexWorkerScope', { value: {} });" : "") + guarded + " u");
    equal("a test that the global has a document asks the worker scope, as the read it guards does",
      [run(true), run(false)], [false, "x"]);
  }
  for (const source of [
    "window.document.body", "a.self.window", "self.top", "globalThis.window += 1",
    "f().window = 1", "a[0].window = 1", "el.style.top = 5", "document.window = 1",
    "globalThis.navigator = n", "window = {}", "globalThis.windows = 1"
  ]) {
    equal("left alone: " + source, rewrite(source), source);
  }
  // A window refuses the assignment; the global page of a service worker
  // has a worker scope that takes it.
  const run = (scope) => vm.runInNewContext(
    'Object.defineProperty(globalThis, "window", { value: globalThis, writable: false });' +
    (scope ? "Object.defineProperty(globalThis, '__wexWorkerScope', { value: {} });" : "") +
    '(function () { "use strict"; try { ' + rewrite("globalThis.window = { stub: true }") +
    '; return [window === globalThis, globalThis.__wexWorkerScope.window.stub]; }' +
    " catch (e) { return e.name; } })()");
  equal("the global page of a service worker takes the value in its worker scope",
    run(true), [true, true]);
  equal("elsewhere the assignment is made as written, and a window refuses it",
    run(false), "TypeError");
}

function workerTypeofs() {
  console.log("A service worker's tests for a window");
  const rewrite = (source) => W2S.javascript.rewriteWorkerTypeofs(source).source;
  for (const source of ["typeof window.chrome", "typeof windowId", "typeof window['x']", "typeof window?.x"]) {
    equal("left alone: " + source, rewrite(source), source);
  }
  const test = "(typeof window === 'undefined') + ',' + (typeof document > 'u') + ',' + ('undefined' == typeof window)";
  const run = (scope) => vm.runInNewContext(
    "var window = this, document = {};" +
    (scope ? "Object.defineProperty(this, '__wexWorkerScope', { value: {} });" : "") + rewrite(test));
  equal("in the global page of a service worker they answer as a worker's, and elsewhere as written",
    [run(true), run(false)], ["true,true,true", "false,false,false"]);
  const assigned = vm.runInNewContext("var window = this, document = {}; var self = this;" +
    "Object.defineProperty(this, '__wexWorkerScope', { value: {} });" +
    W2S.javascript.rewriteWorkerGlobals("self.window = self;").source + rewrite(test));
  equal("and as a worker's that gave itself a window", assigned, "false,true,false");
  for (const source of [
    "(function (window, undefined) { return typeof window; })(this)",
    "(window) => typeof window", "window => typeof window", "async (a, window) => { typeof window }",
    "function f(a, window = {}) { return typeof window; }", "({ m(window) { return typeof window; } })",
    "try {} catch (document) { typeof document }", "{ let window = 1; typeof window }",
    "function g() { var x, window; if (x) { return typeof window; } }", "const document = {}; typeof document",
    "x = typeof window?.chrome; y = typeof window"]) {
    const count = W2S.javascript.rewriteWorkerTypeofs(source).count;
    equal("a name the script binds itself is its own: " + source, count, source.startsWith("x =") ? 1 : 0);
  }
  for (const source of ["function f(w) { return typeof window; }", "(function (window) {})(); typeof window",
    "f(window); typeof window", "if (window) { typeof window }", "{ let window = 1; } typeof window",
    "o.window = 1; typeof window", "function g(a = window) { return typeof window; }"]) {
    equal("one it does not bind is the global's: " + source, W2S.javascript.rewriteWorkerTypeofs(source).count, 1);
  }
  // UAParser.js exports itself to the `window` its wrapper is handed, which a
  // worker hands its own global.
  const exported = vm.runInNewContext("var window = this;" +
    "Object.defineProperty(this, '__wexWorkerScope', { value: {} });" +
    rewrite("(function (window) { var isWindow = typeof window !== 'undefined';" +
      " if (isWindow) { window.UAParser = 1; } })(typeof window === 'object' ? window : this);") +
    "typeof UAParser");
  equal("a library a worker hands its global to as `window` exports itself", exported, "number");
}

function extensionProtocols() {
  console.log("The build's own extension protocol");
  const js = W2S.javascript;
  const source = 'a = location.protocol === "chrome-extension:"; ' +
    "b = url.startsWith('chrome-extension://') || url.startsWith(\"moz-extension://\");";
  equal("names Safari's in a Chrome build",
    js.rewriteExtensionProtocols(source, "chrome-extension"),
    { source: 'a = location.protocol === "safari-extension:"; ' +
      "b = url.startsWith('safari-extension://') || url.startsWith(\"moz-extension://\");", count: 2 });
  equal("and only Firefox's in a Firefox build",
    js.rewriteExtensionProtocols(source, "moz-extension").count, 1);
  equal("the bare name as a property's value is a label, and stays",
    js.rewriteExtensionProtocols('m = {type:"connect",client_type:"chrome-extension"}; ' +
      'n = { "kind": "chrome-extension", 2: "chrome-extension" }', "chrome-extension").count, 0);
  equal("while the name in a test, a conditional, a list or a property's longer value is changed",
    js.rewriteExtensionProtocols('a = e.indexOf("chrome-extension"); b = c ? d : "chrome-extension"; ' +
      'f = ["chrome-extension"]; g = {p: "chrome-extension:"}; h = x === "chrome-extension"',
      "chrome-extension").source,
    'a = e.indexOf("safari-extension"); b = c ? d : "safari-extension"; ' +
      'f = ["safari-extension"]; g = {p: "safari-extension:"}; h = x === "safari-extension"');
  equal("as is the start of one, from the hyphen on",
    [js.rewriteExtensionProtocols('isMozilla = document.URL.startsWith("moz-")', "moz-extension").source,
      js.rewriteExtensionProtocols("u.startsWith('chrome-ext')", "chrome-extension").source,
      js.rewriteExtensionProtocols('a = "moz"; b = "moz-icon:"; c = "-moz-"', "moz-extension").count],
    ['isMozilla = document.URL.startsWith("safari-")', "u.startsWith('safari-ext')", 0]);
  const firefoxRegexes = js.rewriteExtensionProtocols(
    "a = /^(?:(?:about|chrome|resource|(?:moz|chrome)-.*):|\\[System)/; " +
    "b = e.match(/^moz-extension:\\/\\//); c = /(chrome|moz|safari)\\-extension:/; d = /moz\\-extension/i",
    "moz-extension");
  equal("a regular expression matches Safari's protocol as it does the build's own",
    firefoxRegexes.source,
    "a = /^(?:(?:about|chrome|resource|(?:moz|chrome|safari)-.*):|\\[System)/; " +
    "b = e.match(/^safari-extension:\\/\\//); c = /(chrome|moz|safari)\\-extension:/; d = /safari\\-extension/i");
  equal("in a Chrome build, Chrome's",
    js.rewriteExtensionProtocols("r = /^(chrome-extension|moz-extension):\\/\\//u", "chrome-extension").source,
    "r = /^(safari-extension|moz-extension):\\/\\//u");
  equal("a file whose slashes follow an increment, or Unicode names, is still read",
    [js.rewriteExtensionProtocols('i = t.tick++/t.total;\nd = { Chrome: "chrome-extension://" };', "chrome-extension").source,
      js.rewriteExtensionProtocols('c = \u03c0 / 4;\nd = "chrome-extension://";', "chrome-extension").count,
      ["x = a + +/re/.source;", "x = a+++/re/.source;"].map((code) =>
        js.tokens(code, true, true).filter((t) => t[0] === "regex").map((t) => t[1]))],
    ['i = t.tick++/t.total;\nd = { Chrome: "safari-extension://" };', 1, [["/re/"], ["/re/"]]]);
  const protocolTree = new W2S.tree.Tree();
  protocolTree.write("UA.js", new Uint8Array(Buffer.from('document.URL.startsWith("moz-")')));
  equal("in any file that names one",
    [W2S.javascript.adaptExtensionProtocols(protocolTree, "moz-extension", []),
      utf8(protocolTree.read("UA.js"))], [1, 'document.URL.startsWith("safari-")']);
  for (const other of ['u = "chrome-extension://" + id + "/x.html"', "u = `chrome-extension://${id}`",
    's = "chrome-extension://abc/"', '// "chrome-extension:"']) {
    equal("left alone: " + other, js.rewriteExtensionProtocols(other, "chrome-extension"),
      { source: other, count: 0 });
  }
}

// -- match patterns and website access ---------------------------------- //

function whitelistScope() {
  console.log("Content-script whitelists held to Website Access");
  const p = W2S.patterns;
  equal("a broad bridge is limited to the permitted hosts",
    p.restrictWhitelist(p.ALL_URLS, ["example.com"]), ["http://example.com/*", "https://example.com/*"]);
  equal("a scheme, a path and a narrower host are kept",
    p.restrictWhitelist(["https://api.example.com/editor/*", "https://unrelated.com/*"], ["*.example.com"]),
    ["https://api.example.com/editor/*"]);
  equal("wildcards intersect both ways",
    [p.restrictWhitelist(["https://*.example.com/*"], ["sub.example.com"]),
      p.restrictWhitelist(["https://*.sub.example.com/*"], ["*.example.com"]),
      p.restrictWhitelist(["https://*/*"], ["*.example.com"])],
    [["https://sub.example.com/*"], ["https://*.sub.example.com/*"],
      ["https://*.example.com/*", "https://example.com/*"]]);
  equal("no permitted host matches nothing", p.restrictWhitelist(p.ALL_URLS, []), []);
}

async function metadata() {
  console.log("Metadata");
  const info = async (manifest, listing) => {
    const out = await convert({ "manifest.json": JSON.stringify(Object.assign({ manifest_version: 3,
      name: "Meta", version: "1.2.3", description: "Says what it does" }, manifest)) }, { listing });
    const plistInfo = out.info();
    return [plistInfo.Author, plistInfo.Website || null];
  };
  const listing = { author: "Store Publisher", website: "https://chromewebstore.google.com/detail/x" };
  equal("a manifest's own author and homepage come first",
    await info({ author: "Ann Author", homepage_url: "https://www.ann.example/ext" }, listing),
    ["Ann Author", "https://www.ann.example/ext"]);
  equal("then the store listing's publisher and page",
    await info({ homepage_url: "https://www.ann.example/ext" }, listing),
    ["Store Publisher", "https://www.ann.example/ext"]);
  equal("for an extension whose manifest names neither", await info({}, listing),
    ["Store Publisher", "https://chromewebstore.google.com/detail/x"]);
  equal("without a listing, the homepage's host stands in",
    await info({ homepage_url: "https://www.ann.example/ext" }),
    ["ann.example", "https://www.ann.example/ext"]);
  equal("and with nothing at all, Safari is told so", await info({}), ["Unknown", null]);
  // What the stores' listings say: a Chrome Web Store page's byline, which
  // names a publisher or a site its owner verified, and Firefox Add-ons' API.
  const ws = W2S.webstore;
  const page = (byline) => '<a href="https://support.google.com/x" target="_blank">badge</a>' +
    '<h1 class="Pa2dE">Name</h1><div><a href="https://support.google.com/y" target="_blank">Learn</a></div>' +
    byline + '<a href="https://other.example" rel="ugc nofollow">later</a>';
  equal("a Chrome listing's byline naming a publisher, with the listing's page",
    ws.chromeListing("abc", page('<a class="cJI8ee" href="./publisher/tj/uc1" rel="ugc nofollow" ' +
      'data-publisher-id="uc1">Tom &amp; Jerry&#39;s</a>')),
    { author: "Tom & Jerry's", website: "https://chromewebstore.google.com/detail/abc" });
  equal("or a site its owner verified, with the site",
    ws.chromeListing("abc", page('<a href="https://cool.example" rel="ugc nofollow" target="_blank">cool.example</a>')),
    { author: "cool.example", website: "https://cool.example" });
  const details = (label, publisher) => '<h1 class="Pa2dE">Name</h1><section><ul>' +
    '<li><div>Version</div><div>1.2.3</div></li>' +
    '<li class="MqICNe T7iRm"><div>' + label + '</div><div>' + publisher + '</div></li>' +
    '</ul></section><p>Visit the developer\'s <a href="https://help.example" rel="ugc nofollow">support site</a></p>';
  equal("the current Chrome listing's plain-text Details publisher, before its support link",
    ws.chromeListing("abc", details("Offered by", "chYer")),
    { author: "chYer", website: "https://chromewebstore.google.com/detail/abc" });
  equal("the Details publisher row when its label is localized, including a verified site",
    ws.chromeListing("abc", details("Angeboten von", '<a href="https://cool.example">cool.example</a>')),
    { author: "cool.example", website: "https://cool.example" });
  equal("or the byline as the page in the browser showed it",
    ws.chromeListing("abc", null, { name: " Ann  B ", url: "https://chromewebstore.google.com/publisher/a/b" }),
    { author: "Ann B", website: "https://chromewebstore.google.com/detail/abc" });
  equal("and no author from a page without one", ws.chromeListing("abc", "<p>gone</p>").author, "");
  equal("Firefox's authors, and its homepage in the browser's language",
    ws.firefoxListing({ authors: [{ name: "Ann" }, { name: "Bo" }], url: "https://addons.mozilla.org/a/",
      homepage: { url: { "en-US": "https://a.example", de: "https://a.example/de" } } }, "de-DE"),
    { author: "Ann, Bo", website: "https://a.example/de" });
  equal("or its page there", ws.firefoxListing({ authors: [], homepage: null, url: "https://addons.mozilla.org/b/" }),
    { author: "", website: "https://addons.mozilla.org/b/" });
  equal("a developer object names its author",
    await info({ developer: { name: "Dev Name", url: "https://dev.example" } }),
    ["Dev Name", "https://dev.example"]);
}

function archiveLinks() {
  console.log("Extension archive links");
  const ws = W2S.webstore;
  const project = "https://gitflic.ru/project/owner/extensions/blob";
  equal("a GitFlic XPI viewer becomes its raw archive download",
    ws.rawArchiveUrl(project + "?file=addon-latest.xpi&commit=abc123"),
    project + "/raw?file=addon-latest.xpi&commit=abc123&inline=false");
  equal("a GitFlic CRX viewer works with an encoded filename and existing download option",
    ws.rawArchiveUrl(project + "?inline=true&file=folder%2Faddon%2ECRX&commit=abc123"),
    project + "/raw?inline=true&file=folder%2Faddon%2ECRX&commit=abc123");
  equal("only GitFlic viewer links that name extension archives are changed",
    [ws.rawArchiveUrl(project + "?file=README.md&commit=abc123"),
      ws.rawArchiveUrl("https://example.com/project/owner/extensions/blob?file=addon.xpi"),
      ws.rawArchiveUrl(project + "/raw?file=addon.xpi&commit=abc123"),
      ws.rawArchiveUrl(project + "?file=bad%ZZ.xpi&commit=abc123")],
    [null, null, null, null]);
}

async function websiteAccess() {
  console.log("Website Access");
  const bundle = async (manifest) => {
    const out = await convert({ "manifest.json": JSON.stringify(manifest) });
    return [out.info().Permissions["Website Access"], JSON.parse(out.text("manifest.json"))];
  };
  let [access, bundled] = await bundle({ manifest_version: 3, name: "Tabs", version: "1",
    permissions: ["tabs"], content_scripts: [{ matches: ["https://a.example/*"], js: [] }] });
  equal("tabs reaches every site", [access.Level, bundled.host_permissions], ["All", ["<all_urls>"]]);
  [access, bundled] = await bundle({ manifest_version: 2, name: "Active", version: "1",
    permissions: ["activeTab", "storage"] });
  equal("as does activeTab in a version 2 manifest",
    [access.Level, bundled.permissions], ["All", ["activeTab", "storage", "<all_urls>"]]);
  [access, bundled] = await bundle({ manifest_version: 3, name: "Some", version: "1",
    permissions: ["storage"], host_permissions: ["https://a.example/*"] });
  equal("other permissions keep their sites",
    [access, bundled.host_permissions.includes("<all_urls>")],
    [{ "Allowed Domains": ["a.example"], "Include Secure Pages": true, Level: "Some" }, false]);
  [access] = await bundle({ manifest_version: 3, name: "New tab", version: "1",
    chrome_url_overrides: { newtab: "newtab.html" } });
  equal("a new-tab page sees the address of every web page a new tab opens to", access.Level, "All");
  const connectable = await convert({ "manifest.json": JSON.stringify({ manifest_version: 3, name: "Pages",
    version: "1", externally_connectable: { matches: ["https://*.b.example/*"] } }) });
  equal("pages externally_connectable names are reached, with no host permission given for them",
    [connectable.info().Permissions["Website Access"], connectable.info().Content.Whitelist,
      JSON.parse(connectable.text("manifest.json")).host_permissions],
    [{ "Allowed Domains": ["*.b.example"], "Include Secure Pages": true, Level: "Some" },
      ["https://*.b.example/*", "https://b.example/*"], undefined]);
  const contentOnly = await convert({
    "manifest.json": JSON.stringify({ manifest_version: 3, name: "Content only", version: "1",
      content_scripts: [{ matches: ["https://content.example/*"], js: ["content.js"] }] }),
    "content.js": "document.documentElement.dataset.injected = 'yes';"
  });
  equal("content-script matches grant the Website Access Safari requires for their injection",
    [contentOnly.info().Permissions["Website Access"], contentOnly.info().Content.Whitelist,
      contentOnly.config().bridgeWhitelist],
    [{ "Allowed Domains": ["content.example"], "Include Secure Pages": true, Level: "Some" },
      ["https://content.example/*"], ["https://content.example/*"]]);
  const offscreenAudio = await convert({
    "manifest.json": JSON.stringify({ manifest_version: 3, name: "Offscreen audio", version: "1",
      background: { service_worker: "background.js" }, action: {}, permissions: ["offscreen"] }),
    "background.js": "chrome.action.onClicked.addListener(() => chrome.offscreen.createDocument(" +
      "{url: 'offscreen.html', reasons: ['AUDIO_PLAYBACK'], justification: 'play'}));",
    "offscreen.html": "<audio autoplay></audio>"
  });
  equal("a toolbar/background bridge can host offscreen audio without Chrome host permissions",
    [offscreenAudio.info().Permissions["Website Access"], offscreenAudio.info().Content.Whitelist,
      offscreenAudio.config().websiteAccess, offscreenAudio.config().bridgeWhitelist],
    [{ "Include Secure Pages": true, Level: "All" }, ["http://*/*", "https://*/*"],
      "All", ["http://*/*", "https://*/*"]]);
  const panels = await convert({ "manifest.json": JSON.stringify({ manifest_version: 3, name: "Panels",
    version: "1", devtools_page: "devtools.html" }), "devtools.html": "<script src=\"d.js\"></script>",
    "d.js": "chrome.devtools.panels.create(\"P\", \"\", \"panel.html\");", "panel.html": "<p>" });
  const plain = await convert({ "manifest.json": JSON.stringify({ manifest_version: 3, name: "No panels",
    version: "1", devtools_page: "devtools.html" }), "devtools.html": "<p>" });
  equal("a devtools page that makes panels runs in a window the Inspector's relay opens",
    [panels.info().WebExtensionDevtoolsPage, panels.config().devtoolsWindowPage,
      !!panels.text("wex/wex-devtools-window.html"), plain.info().WebExtensionDevtoolsPage,
      plain.config().devtoolsWindowPage],
    ["wex/wex-devtools-relay.html", "devtools.html", true, "devtools.html", null]);
}

// -- builds, rulesets and identity -------------------------------------- //

async function firefoxBuild() {
  console.log("A build published on Firefox Add-ons");
  const manifest = JSON.stringify({ manifest_version: 2, name: "Built", version: "1",
    browser_specific_settings: { gecko: { id: "built@example.com" } } });
  const signed = await convert({ "manifest.json": manifest, "META-INF/mozilla.rsa": "signature" });
  const unsigned = await convert({ "manifest.json": manifest });
  equal("is one Mozilla signed, and a gecko id alone does not make one",
    [signed.config().firefoxBuild, unsigned.config().firefoxBuild], [true, false]);
  const key = Buffer.from("fixture public key");
  const keyed = await convert({ "manifest.json": JSON.stringify({ manifest_version: 3, name: "Keyed",
    version: "1", key: key.toString("base64") }) });
  equal("the sign-in redirect address is Firefox's for its gecko id, Chrome's for its id, or none",
    [signed.config().identityRedirectURL, keyed.config().identityRedirectURL, unsigned.config().identityRedirectURL],
    ["https://" + crypto.createHash("sha1").update("built@example.com").digest("hex") + ".extensions.allizom.org/",
      "https://" + W2S.webstore.chromeId(new Uint8Array(crypto.createHash("sha256").update(key).digest())) +
        ".chromiumapp.org/", null]);
}

async function staticRulesets() {
  console.log("Static declarativeNetRequest rulesets");
  const convertRules = (files, manifest) => convert(Object.assign({
    "manifest.json": JSON.stringify(Object.assign({ manifest_version: 3, name: "Rules fixture", version: "1",
      background: { service_worker: "background.js" } }, manifest)),
    "background.js": "/* */"
  }, files));
  const block = (host) => JSON.stringify([{ id: 1, action: { type: "block" },
    condition: { urlFilter: "||" + host + "^" } }]);
  let out = await convertRules({ "rules.json": block("ads.example"), more: block("more.example") },
    { declarative_net_request: { rule_resources: [
      { id: "ads", enabled: true, path: "/rules.json" },
      { id: "more", enabled: false, path: "more" },
      { id: "gone", enabled: true, path: "missing.json" }] } });
  equal("are declared in Info.plist, as stored", out.info().declarative_net_request, { rule_resources: [
    { enabled: true, id: "ads", path: "rules.json" },
    { enabled: false, id: "more", path: "more.txt" }] });
  equal("a missing one is reported, and none goes to the runtime",
    [out.result.notes.some((note) => note.includes("missing.json is not in the bundle")),
      out.text("wex/wex-config.js").includes("dnrRulesets")], [true, false]);
  out = await convertRules({ "rules.json": JSON.stringify([
    { id: 1, action: { type: "modifyHeaders", requestHeaders: [
      { header: "X-Custom", operation: "set", value: "1" }] }, condition: { urlFilter: "||api.example^" } },
    { id: 2, action: { type: "modifyHeaders", responseHeaders: [
      { header: "Content-Security-Policy", operation: "remove" }] }, condition: { urlFilter: "||api.example^" } }
  ]) }, { declarative_net_request: { rule_resources: [{ id: "headers", enabled: true, path: "rules.json" }] } });
  equal("a rule changing a custom X- header is reported",
    [!!out.info().declarative_net_request,
      out.result.notes.some((note) => note.startsWith("1 declarativeNetRequest rule modifies custom X-"))],
    [true, true]);
  equal("the rules that change response headers are recorded for the runtime, which applies them",
    out.config().responseHeaderRules, { headers: [{ action: { responseHeaders: [
      { header: "Content-Security-Policy", operation: "remove" }], type: "modifyHeaders" },
      condition: { urlFilter: "||api.example^" }, id: 2 }] });
  equal("and Info.plist gives WebKit an engine copy without those response actions",
    [out.info().declarative_net_request.rule_resources[0].path,
      JSON.parse(out.text("rules.engine.json"))], ["rules.engine.json", [{
      action: { requestHeaders: [
        { header: "X-Custom", operation: "set", value: "1" }], type: "modifyHeaders" },
      condition: { urlFilter: "||api.example^" }, id: 1
    }]]);
  {
    const domains = Array.from({ length: 160 }, (_, k) => "d" + k + ".example");
    const rules = Array.from({ length: 1000 }, (_, k) => ({ id: k + 1, action: { type: "block" },
      condition: { requestDomains: domains } }));
    rules.push({ id: 5000, action: { type: "allow" }, condition: { requestDomains: domains, urlFilter: "/ok/" } });
    rules.push({ id: 5001, action: { type: "block" }, condition: { urlFilter: "||cheap.example^" } });
    const many = JSON.stringify(rules);
    const big = await convertRules({ "big.json": many, "off.json": many }, { declarative_net_request: { rule_resources: [
      { id: "big", enabled: true, path: "big.json" }, { id: "off", enabled: false, path: "off.json" }] } });
    const named = big.info().declarative_net_request.rule_resources.map((r) => r.path);
    const fitted = JSON.parse(big.text("big.fitted.json"));
    const cost = fitted.reduce((sum, r) => sum + (r.condition.requestDomains ? r.condition.requestDomains.length : 1), 0);
    equal("rulesets that WebKit's form makes more than one content rule list holds are cut to fit, " +
      "keeping every exception and the cheapest rules first, and Info.plist names the cut ones",
      [named, cost <= 140000, cost > 139000, fitted.some((r) => r.id === 5000), fitted.some((r) => r.id === 5001),
        big.text("big.json") === many, big.config().rulesetEngineCosts.big === cost,
        big.result.notes.filter((note) => note.includes("one content rule list holds")).length],
      [["big.fitted.json", "off.fitted.json"], true, true, true, true, true, true, 2]);
  }
  out = await convertRules({ "resources/lib/a.jsm": "x", "rules.json": JSON.stringify([
    { id: 1, action: { type: "redirect", redirect: { extensionPath: "/resources/lib/a.jsm?v=1" } },
      condition: { urlFilter: "|https://cdn.example/a.js|" } },
    { id: 2, action: { type: "redirect", redirect: { extensionPath: "/other.js" } },
      condition: { urlFilter: "|https://cdn.example/b.js|" } }]) },
    { declarative_net_request: { rule_resources: [{ id: "redirect", enabled: true, path: "rules.json" }] } });
  equal("a redirect to a file of the renamed resources folder goes to it by its new name in the engine copy",
    [out.info().declarative_net_request.rule_resources[0].path,
      JSON.parse(out.text("rules.engine.json")).map((r) => r.action.redirect.extensionPath),
      JSON.parse(out.text("rules.json"))[0].action.redirect.extensionPath],
    ["rules.engine.json", ["/resources_/lib/a.jsm?v=1", "/other.js"], "/resources/lib/a.jsm?v=1"]);
  out = await convertRules({}, {});
  equal("with none, Info.plist names none", "declarative_net_request" in out.info(), false);
  out = await convertRules({ "devtools.html": "<!DOCTYPE html><title>d</title>" }, { devtools_page: "/devtools.html" });
  const missingDevtools = await convertRules({}, { devtools_page: "gone.html" });
  equal("a devtools page is named in Info.plist, when it is in the bundle",
    [out.info().WebExtensionDevtoolsPage, "WebExtensionDevtoolsPage" in missingDevtools.info(),
      missingDevtools.result.notes.some((note) => note.includes("devtools page gone.html"))],
    ["devtools.html", false, true]);

}

async function chromeIdentity() {
  console.log("The extension's Chrome identity");
  const ws = W2S.webstore;
  const sha256 = (data) => new Uint8Array(crypto.createHash("sha256").update(data).digest());
  const header = (version, ...fields) => {
    const out = Buffer.alloc(8 + 4 * fields.length);
    out.write("Cr24", 0, "latin1");
    out.writeUInt32LE(version, 4);
    fields.forEach((value, i) => out.writeUInt32LE(value, 8 + 4 * i));
    return out;
  };
  const crx = (...parts) => new Uint8Array(Buffer.concat(parts));
  const id = "abcdefghijklmnopabcdefghijklmnop";
  const key = Buffer.from("fixture public key");
  equal("the store is asked for an extension as by a Chrome that meets a minimum_chrome_version of 148",
    parseInt(new URL(ws.downloadUrl(id)).searchParams.get("prodversion"), 10) >= 148, true);
  equal("comes from a store address, or from the manifest's key",
    [ws.sourceExtensionId("https://chromewebstore.google.com/detail/test/" + id, null, {}),
      ws.sourceExtensionId("/tmp/source", null, { key: key.toString("base64") }),
      ws.sourceExtensionId("/tmp/source", null, {})],
    [id, ws.chromeId(sha256(key)), null]);
  const crx2Key = Buffer.from("another fixture key");
  equal("from a CRX2 archive's public key",
    ws.sourceExtensionId("x.crx", crx(header(2, crx2Key.length, 0), crx2Key), {}), ws.chromeId(sha256(crx2Key)));
  const identifier = Buffer.from("0123456789abcdef");
  const signed = Buffer.concat([Buffer.from([0x0a, 0x10]), identifier]);
  const crx3Header = Buffer.concat([Buffer.from([0x82, 0xf1, 0x04, signed.length]), signed]);
  equal("from a CRX3 archive's signed data",
    ws.sourceExtensionId("x.crx", crx(header(3, crx3Header.length), crx3Header), {}),
    ws.chromeId(new Uint8Array(identifier)));
  equal("and is left out when the archive's header is malformed",
    [Buffer.alloc(0), Buffer.from([0x82, 0xf1, 0x04, 0xff]), Buffer.from([0x0f]),
      Buffer.concat([Buffer.from([0x82, 0xf1, 0x04, 0x20]), Buffer.from("short")])]
      .map((h) => ws.sourceExtensionId("x.crx", crx(header(3, h.length), h), {})),
    [null, null, null, null]);

  const out = await convert({
    "manifest.json": JSON.stringify({ manifest_version: 3, name: "Identity fixture", version: "1",
      key: Buffer.from("fixture").toString("base64"), host_permissions: ["https://api.example.com/*"],
      background: { service_worker: "background.js" } }),
    "background.js": 'fetch("https://api.example.com/session");'
  });
  const page = out.text("wex-global-page.html");
  const config = out.text("wex/wex-config.js");
  equal("the network identity is loaded before the background, in the global page itself",
    [page.indexOf("wex-network.js") < page.indexOf("background.js"),
      out.result.files.isFile("wex/wex-network-page.html")], [true, false]);
  equal("with the extension's Chrome origin and hosts",
    [config.includes('"sourceOrigin": "chrome-extension://'), config.includes('"networkHosts"')], [true, true]);
  const own = ws.chromeId(sha256(Buffer.from("fixture")));
  const other = "ponmlkjihgfedcbaponmlkjihgfedcba";
  const named = await convert({
    "manifest.json": JSON.stringify({ manifest_version: 3, name: "Named fixture", version: "1",
      key: Buffer.from("fixture").toString("base64"), background: { service_worker: "background.js" } }),
    "background.js": `const ids = ["${own}", "${other}"];`
  });
  equal("whose bundle is named by its Chrome id, and the other Chrome ids its scripts name are noted",
    [named.info().CFBundleIdentifier, named.config().otherExtensionIds], ["com.webext2safari." + own, [other]]);
}

// -- style sheets --------------------------------------------------------- //

function svgInCss() {
  console.log("SVG images in style sheets");
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>é &amp; #</text></svg>';
  const data = "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");
  const bundle = () => {
    const tree = new W2S.tree.Tree();
    tree.write("images/test icon.svg", new Uint8Array(Buffer.from(svg, "utf8")));
    return tree;
  };
  const tree = bundle();
  const css = ".a{background:url(../images/test%20icon.svg?cache=1);" +
    "mask:url(\"/images/test icon.svg#view\");content:URL('../images/test icon.svg')}";
  const out = W2S.svg.inlineCss(css, "css/main.css", tree);
  equal("backgrounds, masks and fragments become typed data URLs",
    [out.count, out.css.includes('url("' + data + '")'), out.css.includes('url("' + data + '#view")'),
      W2S.svg.inlineCss(out.css, "css/main.css", tree).count], [3, true, true, 0]);
  for (const other of [
    "/* url(../images/test%20icon.svg) */",
    '.a{content:"url(../images/test%20icon.svg)"}',
    ".a{background:url(https://example.com/test.svg);mask:url(//example.com/test.svg)}",
    ".a{content:url(#view);border-image:url(missing.svg);background:url(icon.png)}",
    ".a{background:url(../../../images/test%20icon.svg)}"
  ]) {
    equal("left alone: " + other, W2S.svg.inlineCss(other, "css/main.css", tree), { css: other, count: 0 });
  }
  const packaged = bundle();
  packaged.write("css/main.css", new Uint8Array(Buffer.from(".a{content:url(../images/test%20icon.svg)}")));
  equal("every style sheet in the bundle, once",
    [W2S.svg.inlineBundleCss(packaged), W2S.svg.inlineBundleCss(packaged)], [1, 0]);
}

// -- files and pages Safari treats differently -------------------------- //

async function reservedFolder() {
  console.log("A top-level resources folder");
  const out = await convert({
    "manifest.json": JSON.stringify({
      manifest_version: 2, name: "Reserved", version: "1",
      background: { scripts: ["resources/lib/main.js"] },
      browser_action: { default_popup: "resources/popup.html" }
    }),
    "resources/lib/main.js": 'var url = chrome.runtime.getURL("resources/lib/data.json");',
    "resources/lib/data.json": "{}",
    "resources/popup.html": '<link rel="stylesheet" href="../style.css"><img src="lib/icon.png">',
    "style.css": "body { background: url(resources/lib/icon.png); }",
    "resources/lib/icon.png": "x"
  });
  equal("is renamed", [out.result.files.isDir("resources"), out.result.files.isDir("resources_")],
    [false, true]);
  equal("and the scripts are left as they are", out.text("resources_/lib/main.js"),
    'var url = chrome.runtime.getURL("resources/lib/data.json");');
  equal("while a style sheet follows it", out.text("style.css"),
    'body { background: url("resources_/lib/icon.png"); }');
  equal("and a page's references inside it stay relative", out.text("resources_/popup.html").includes(
    'src="lib/icon.png"'), true);
  equal("the manifest's paths follow it",
    JSON.parse(out.text("manifest.json")).browser_action, { default_popup: "resources_/popup.html" });
  const config = out.config();
  equal("and the runtime maps the old paths",
    [config.renamedFiles["resources/lib/data.json"], config.popupPage],
    ["resources_/lib/data.json", "resources_/popup.html"]);
}

async function pageWithoutHead() {
  console.log("A page with no head or html element");
  const out = await convert({
    "manifest.json": JSON.stringify({
      manifest_version: 2, name: "Headless", version: "1", background: { page: "global.html" }
    }),
    "global.html": '<!doctypehtml><meta http-equiv="Content-Type"content="text/html; charset=utf-8">' +
      '<script src="a.js"></script>',
    "a.js": "1;"
  });
  const page = out.text("global.html");
  const order = ["<!doctypehtml>", "<meta http-equiv", "wex/wex-core.js", 'src="a.js"'].map((s) => page.indexOf(s));
  equal("keeps its doctype and charset first, and has the bridge before its scripts",
    order.every((index, i) => index >= 0 && (i === 0 || index > order[i - 1])), true);
}

async function chromeData() {
  console.log("The data a Chrome build reads when a call needs it");
  const api = (out, file) => {
    const text = out.text(file);
    return JSON.parse(text.slice(text.indexOf("=") + 1, text.lastIndexOf(";")));
  };
  const chrome = await convert({ "manifest.json": JSON.stringify({ manifest_version: 3, name: "Plain",
    version: "1" }) });
  const firefox = await convert({ "manifest.json": JSON.stringify({ manifest_version: 2, name: "Fox",
    version: "1", browser_specific_settings: { gecko: { id: "fox@example.com" } } }), "META-INF/mozilla.rsa": "x" });
  const files = ["wex/public-suffix-list.txt", "wex/permission-messages.json"];
  equal("goes with a Chrome build alone",
    [files.map((f) => chrome.result.files.isFile(f)), files.map((f) => firefox.result.files.isFile(f)),
      chrome.text("wex/public-suffix-list.txt").split("\n").indexOf("co.uk") >= 0],
    [[true, true], [false, false], true]);
  equal("and management's schemas are those of the calls it has without its permission",
    api(chrome, "wex/wex-api.js").management.functions.map((fn) => fn.name).sort(),
    ["getPermissionWarningsByManifest", "getSelf", "uninstallSelf"]);
}

async function sandboxedPages() {
  console.log("Pages the manifest serves sandboxed");
  const out = await convert({
    "manifest.json": JSON.stringify({ manifest_version: 3, name: "Sandboxes", version: "1",
      sandbox: { pages: ["sandbox/*.html"] },
      content_security_policy: { sandbox: "sandbox allow-scripts allow-modals; script-src 'self' 'unsafe-eval'" } }),
    "host.html": '<!doctype html><iframe src="sandbox/run.html"></iframe><iframe src="other.html"></iframe>',
    "other.html": "<!doctype html><p>other",
    "sandbox/run.html": '<!doctype html><script src="run.js"></script>',
    "sandbox/run.js": "1;"
  });
  equal("get no extension API, and the frames that show them the manifest's sandbox",
    [out.text("sandbox/run.html").includes("wex-page.js"), out.text("host.html").includes("wex-page.js"),
      (out.text("host.html").match(/<iframe[^>]*>/g) || []), out.config().sandboxPages, out.config().sandboxFlags],
    [false, true, ['<iframe sandbox="allow-scripts allow-modals" src="sandbox/run.html">', '<iframe src="other.html">'],
      ["sandbox/run.html"], "allow-scripts allow-modals"]);
}

async function localizedStylesheets() {
  console.log("Style sheets' message references");
  const out = await convert({
    "manifest.json": JSON.stringify({ manifest_version: 3, name: "Styled", version: "1", default_locale: "en" }),
    "_locales/en/messages.json": JSON.stringify({ accent: { message: "teal" } }),
    "top.css": "a { background: url(chrome-extension://__MSG_@@extension_id__/icons/a.png); }",
    "icons/c.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>",
    "css/svg.css": "b { background: url(moz-extension://__MSG_@@extension_id__/icons/c.svg); }",
    "css/deep/inner.css": ".x { background: url(\"chrome-extension://__MSG_@@extension_id__/icons/b.svg\");" +
      " direction: __MSG_@@bidi_dir__; float: __MSG_@@bidi_start_edge__; color: __MSG_ACCENT__;" +
      " content: '__MSG_missing__ __MSG_@@extension_id__'; }"
  });
  const id = out.config().runtimeId;
  equal("are filled in as the browser serves them, and the extension's own addresses lead to its files",
    [out.text("top.css"), out.text("css/deep/inner.css"), /url\(["']?data:image\/svg\+xml/.test(out.text("css/svg.css"))],
    ["a { background: url(./icons/a.png); }",
      ".x { background: url(\"../../icons/b.svg\"); direction: ltr; float: left; color: teal;" +
        " content: '__MSG_missing__ " + id + "'; }", true]);
}

async function backgroundSafari() {
  console.log("The background's view of `safari`");
  const plain = await convert({ "manifest.json": JSON.stringify({ manifest_version: 3, name: "Plain", version: "1",
    background: { service_worker: "sw.js" } }), "sw.js": "if (typeof safari === 'object') old();" });
  const own = await convert({ "manifest.json": JSON.stringify({ manifest_version: 2, name: "Own", version: "1",
    background: { scripts: ["bg.js"] } }), "bg.js": "var safari = makeShim();" });
  equal("is a binding of its own, after the runtime and before the extension's scripts, unless it declares one",
    [/wex-network\.js"><\/script>\s*<script src="wex\/wex-background-globals\.js"><\/script>\s*<script src="sw\.js">/
      .test(plain.text("wex-global-page.html") || ""), plain.text("wex/wex-background-globals.js"),
      /wex-background-globals/.test(own.text("wex-global-page.html")), own.result.files.isFile("wex/wex-background-globals.js")],
    [true, "// The background's scripts find no `safari`, as in the browser they were made for.\nlet safari;\n", false, false]);
}

async function injectedContentScripts() {
  console.log("Content scripts injected by Safari");
  const out = await convert({
    "manifest.json": JSON.stringify({ manifest_version: 3, name: "Injected", version: "1",
      content_scripts: [{ matches: ["<all_urls>"], js: ["main.js"], world: "MAIN" },
        { matches: ["<all_urls>"], js: ["/shared.js", "strict.js"], run_at: "document_start" },
        { matches: ["<all_urls>"], js: ["later.js"] }] }),
    "shared.js": "const answer = 42;\nlet other = answer;\nasync function load() { return answer; }\n" +
      "function plain() { return other; }\n",
    "strict.js": "'use strict';\nvar strictSeen = (function () { return this; })() === undefined;\n" +
      "function strictHelper() { return answer + 1; }\n",
    "later.js": "var laterSum = plain() + strictHelper();\n",
    "main.js": "let page = 1;\n"
  });
  const scripts = out.info().Content.Scripts;
  equal("each file of a group is a copy Safari injects after the bridge, in its group's phase",
    [scripts.Start, scripts.End, out.config().injectedScripts],
    [["wex/wex-bridge.js", "wex/content/1/shared.js", "wex/content/1/strict.js"],
      ["wex/wex-run-end.js", "wex/content/2/later.js"], { end: ["wex/content/2/later.js"],
        files: { "1:0": true, "1:1": true, "2:0": true },
        start: ["wex/content/1/shared.js", "wex/content/1/strict.js"] }]);
  {
    const files = out.result.files;
    const bridge = Buffer.from(files.read("wex/wex-bridge.js")).toString("utf8");
    const at = ["var WEX_CONFIG", "var WEX_API_JSON", "var WEX = (function", "var WEXContent = (function",
      "WEXContent.run(\"document_start\")"].map((text) => bridge.indexOf(text));
    equal("the bridge's files go to Safari as one, in order, and those only it runs are not kept apart",
      [at.every((n, i) => n >= 0 && (i === 0 || n > at[i - 1])),
        ["wex-content.js", "wex-content-api.js", "wex-run-start.js", "wex-config.js", "wex-core.js"]
          .map((name) => files.isFile("wex/" + name))],
      [true, [false, false, false, true, true]]);
  }
  // The copies, run in order in one world, as Safari runs them.
  const asked = [];
  const world = vm.createContext({});
  world.self = vm.runInContext("this", world);
  world.WEXContent = { applies: (n, i) => { asked.push(n + ":" + i); return asked.length !== 4; } };
  for (const name of ["wex/content/1/shared.js", "wex/content/1/strict.js", "wex/content/2/later.js",
    "wex/content/2/later.js"]) {
    vm.runInContext(out.text(name), world);
  }
  equal("and runs where the bridge says its group applies, sharing its top-level names and keeping strict",
    [asked, world.answer, typeof world.load, world.strictSeen, world.laterSum],
    [["1:0", "1:1", "2:0", "2:0"], 42, "function", true, 85]);
  // A script that opens with many comments and no directive, as bundles do.
  const commented = "/* part */\n".repeat(200) + "var commentedSeen = true;\n";
  const started = Date.now();
  const many = await convert({
    "manifest.json": JSON.stringify({ manifest_version: 3, name: "Commented", version: "1",
      content_scripts: [{ matches: ["<all_urls>"], js: ["commented.js"] }] }),
    "commented.js": commented
  });
  equal("a script opening with many comments converts at once", [
    many.text("wex/content/0/commented.js").includes("commentedSeen"), Date.now() - started < 10000], [true, true]);
}

async function reportAliases() {
  console.log("The report's count of calls through a name bound to the API");
  const out = await convert({
    "manifest.json": JSON.stringify({ manifest_version: 3, name: "Aliased", version: "1",
      background: { service_worker: "sw.js" } }),
    "sw.js": "var e = typeof browser === 'object' ? browser : chrome;\n" +
      "e.runtime.sendMessage({}); e.bookmarks.getTree(); var t = location.search.substring(1);\n" +
      "function f(e) { return e.search.substring(1) + e.theme.breakpoints + e.action.method; }\n"
  });
  const report = out.text("wex/CONVERSION-REPORT.txt");
  equal("counts the namespaces' own members, and not a minified name's other uses",
    ["runtime.sendMessage", "bookmarks.getTree", "search.substring", "theme.breakpoints", "action.method"]
      .map((name) => report.includes(name)), [true, true, false, false, false]);
}

function slashes() {
  console.log("A slash after a closing bracket");
  const js = W2S.javascript;
  const regexes = (code) => js.tokens(code, true, true).filter((t) => t[0] === "regex").map((t) => t[1]);
  equal("starts a regular expression after a statement's head",
    [regexes("if(a)/'/.test(b)"), regexes("while(a)/x/.test(b)"), regexes("for(;;)/x/.test(b)"),
      regexes("for await(a of b)/x/.test(a)"), regexes("if(f(a))/x/.test(b)"), regexes("if(a/*c*/)/x/.test(b)")],
    [["/'/"], ["/x/"], ["/x/"], ["/x/"], ["/x/"], ["/x/"]]);
  equal("and after a block", regexes("if(a){b()}/'/.test(c)"), ["/'/"]);
  equal("and divides after anything else",
    [regexes("(a)/b/c"), regexes("f(a)/b/c"), regexes("o.if(a)/b/c"), regexes("a[0]/b/c"), regexes("await(a)/b/c")],
    [[], [], [], [], []]);
  const source = "if(a)/'/.test(b);var s='location.href';if(c)/'/.test(d);";
  equal("a property named as a word that takes a regular expression divides",
    [regexes("x=a.in/2;y='p/q'"), regexes("x=e.default/2/3"), regexes("x=a?.of/2/3"), regexes("x=this.#in/2/3")],
    [[], [], [], []]);
  equal("while the word itself takes one", [regexes("export default /x/.source"), regexes("x in /y/")], [["/x/"], ["/y/"]]);
  equal("a hashbang line is a comment",
    [js.tokens("#!/usr/bin/env node\nvar a=1;", true, true).slice(0, 2).map((t) => t[0]), regexes("#!/usr/bin/env node\n/x/.test(a)")],
    [["comment", "identifier"], ["/x/"]]);
  equal("a comment ends at any line ending",
    ["// c\rvar", "// c var", "// c\r\nvar"].map((code) => js.tokens(code, true, true).map((t) => t[0])),
    new Array(3).fill(["comment", "identifier"]));
  equal("so a string past one keeps its contents", js.rewriteLocationPaths(source), { source, count: 0 });
  const odd = "if(a)/'/.test(b);var u=location.href;";
  equal("and a file with an odd number of quotes in one is still followed",
    js.rewriteLocationPaths(odd).source, "if(a)/'/.test(b);var u=(location.__wexHref ?? location.href);");
  equal("a declaration's list is told from other commas",
    ["var a=1,safari=2", "let a=f(b,c),\nsafari", "const a=[1,2],safari=3", "f(a,safari)", "x=[a,safari]",
      "var o={a,safari}", "var a;b,safari", "x.safari,y"].map((code) => js.declaredInList(code, "safari")),
    [true, true, true, false, false, false, false, false]);
}

function logicalAssignments() {
  console.log("Logical assignments of a window-only global");
  const rewrite = (source) => W2S.javascript.rewriteWorkerGlobals(source).source;
  equal("go to the worker scope through any name for the global",
    ["e.window??={}", "e.window||={}", "e.document&&=1", "self.top??=1"].map(rewrite),
    ["(e.__wexWorkerScope ?? e).window??={}", "(e.__wexWorkerScope ?? e).window||={}",
      "(e.__wexWorkerScope ?? e).document&&=1", "(self.__wexWorkerScope ?? self).top??=1"]);
  equal("while a comparison stays", ["e.window==1", "e.window===1"].map(rewrite), ["e.window==1", "e.window===1"]);
}

function siteAccess() {
  console.log("Website Access of patterns that name no site");
  const domains = W2S.patterns.allowedDomains;
  equal("is none", ["file:///*", "chrome://*/*", "moz-extension://*/*", "about:blank"].map((p) => domains([p])),
    new Array(4).fill({ domains: [], useAll: false }));
  equal("beside a site, the site's",
    domains(["https://foo.com/*", "file:///*"]), { domains: ["foo.com"], useAll: false });
  equal("while a pattern for any site of the network still asks for them all",
    ["ws://*/*", "wss://*/*", "*://*/x"].map((p) => domains([p]).useAll), [true, true, true]);
  equal("and one site of the network names its host", domains(["wss://chat.foo.com/*"]).domains, ["chat.foo.com"]);
}

async function renamedFilesEnd() {
  console.log("Files renamed by the converter");
  const manifest = (more) => JSON.stringify({ manifest_version: 2, name: "Renamed", version: "1", ...more });
  const dimension = 64;
  const icon = Buffer.from(W2S.png.write(dimension, dimension, new Uint8Array(dimension * dimension * 4).fill(200)));

  const icons = await convert({ "manifest.json": manifest({ icons: { 128: "resources/i.png" },
    browser_action: { default_icon: "resources/i.png" } }), "resources/i.png": icon });
  equal("an icon in the renamed folder is read", icons.result.notes.some((n) => n.includes("placeholder")), false);

  const twice = await convert({ "manifest.json": manifest({ background: { scripts: ["resources/bg.mjs"] } }),
    "resources/bg.mjs": "1", "resources/a.mjs": "2", "resources/data": "3" });
  const renamed = twice.config().renamedFiles;
  equal("each old path of a file renamed twice names where it ended up",
    [renamed["resources/a.mjs"], renamed["resources_/a.mjs"], renamed["resources/data"], renamed["resources_/data"]],
    ["resources_/a.mjs.js", "resources_/a.mjs.js", "resources_/data.txt", "resources_/data.txt"]);
  equal("and a background script renamed twice is loaded",
    twice.text("wex-global-page.html").includes('src="resources_/bg.mjs.js"'), true);

  const dotted = await convert({ "manifest.json": manifest({ background: { scripts: ["./bg.mjs", "./sub/../other.js"] } }),
    "bg.mjs": "1", "other.js": "2" });
  equal("a renamed background script written with ./ is loaded",
    [dotted.text("wex-global-page.html").includes('src="bg.mjs.js"'),
      dotted.result.notes.some((n) => n.includes("were skipped"))], [true, false]);

  const cased = await convert({ "manifest.json": manifest({ background: { scripts: ["BG.mjs"] },
    permissions: ["declarativeNetRequest"],
    declarative_net_request: { rule_resources: [{ id: "a", enabled: true, path: "RULES" }] } }),
  "bg.mjs": "1", rules: "[]" });
  equal("a renamed file is found by a name in another case",
    [cased.text("wex-global-page.html").includes('src="bg.mjs.js"'),
      cased.result.notes.some((n) => n.includes("were skipped") || n.includes("is not in the bundle"))], [true, false]);

  const listed = await convert({ "manifest.json": JSON.stringify({ manifest_version: 3, name: "Listed", version: "1",
    web_accessible_resources: [{ resources: ["a.mjs", "resources/b.mjs", "plain", "other.js"], matches: ["<all_urls>"] },
      { resources: ["deep/*.mjs"], matches: ["https://x.example/*"] }] }),
  "a.mjs": "1", "resources/b.mjs": "2", plain: "3", "other.js": "4", "deep/c.mjs": "5" });
  equal("the bundle's manifest names renamed web-accessible files as they now are, and the extension's stays as written",
    [JSON.parse(listed.text("manifest.json")).web_accessible_resources.map((e) => e.resources.slice().sort()),
      listed.config().manifest.web_accessible_resources[0].resources.length],
    [[["a.mjs", "a.mjs.js", "other.js", "plain", "plain.txt", "resources_/b.mjs", "resources_/b.mjs.js"],
      ["deep/*.mjs", "deep/c.mjs.js"]], 4]);

  const text = await convert({ "manifest.json": JSON.stringify({ manifest_version: 2, name: "resources/x", version: "1",
    description: "resources/things", web_accessible_resources: ["resources/a.js"] }), "resources/a.js": "1" });
  const declared = JSON.parse(text.text("manifest.json"));
  equal("a renamed folder's paths follow it in the manifest, and its text stays",
    [declared.name, declared.description, declared.web_accessible_resources],
    ["resources/x", "resources/things", ["resources_/a.js"]]);

  const collide = await convert({ "manifest.json": manifest({}), LICENSE: "license", "license.txt": "text",
    "A.mjs": "module", "a.mjs.js": "script" });
  equal("a new name differing only in case keeps clear of an existing file",
    [collide.text("license.txt"), collide.text("_LICENSE.txt"), collide.text("a.mjs.js"), collide.text("_A.mjs.js")],
    ["text", "license", "script", "module"]);
}

async function earlySheetTexts() {
  const big = "html{--a:1}" + " ".repeat(40 * 1024);
  const result = await convert({
    "manifest.json": JSON.stringify({ manifest_version: 3, name: "Sheets", version: "1",
      content_scripts: [{ matches: ["https://example.com/*"], css: ["plain.css", "image.css", "imports.css", "big.css"] }] }),
    "plain.css": "html{--a:1}",
    "image.css": "html{background:URL(a.png)}",
    "imports.css": "@import 'plain.css';",
    "big.css": big
  });
  equal("a small plain sheet is kept for the frame to show early, and none with an address, or too large",
    result.config().earlySheets, { "plain.css": "html{--a:1}" });
}

async function manifestAndIdentity() {
  console.log("A manifest's strings, and an identifier for a name in another script");
  equal("a trailing comma goes and a string keeps its own",
    W2S.manifest.load(Buffer.from('{ "name": "a, ]", "list": [1, ], /* c */ "x": "b,}", }')),
    { name: "a, ]", list: [1], x: "b,}" });
  const files = (name) => ({ "manifest.json": JSON.stringify({ manifest_version: 2, name, version: "1" }) });
  const ids = await Promise.all(["日本語", "中文", "Plain Name", "日本語 Tool", "中文 Tool", "Café"].map(async (name) =>
    (await convert(files(name))).result.bundleId));
  equal("names in other scripts get identifiers of their own, and a Latin name its slug",
    [/^com\.webext2safari\.extension-[0-9a-f]{16}$/.test(ids[0]), ids[0] !== ids[1], ids[2],
      /^com\.webext2safari\.tool-[0-9a-f]{16}$/.test(ids[3]), ids[3] !== ids[4], ids[5]],
    [true, true, "com.webext2safari.plain-name", true, true, "com.webext2safari.caf"]);
}

async function firefoxWebOrigin() {
  console.log("A Firefox build's address on the web");
  const files = { "manifest.json": JSON.stringify({ manifest_version: 2, name: "Fox origin", version: "1",
    browser_specific_settings: { gecko: { id: "fox-origin@example.com" } }, background: { scripts: ["bg.js"] } }),
  "bg.js": "var own = `moz-extension://${uuid}/page.html`;", "META-INF/mozilla.rsa": "x" };
  const first = await convert(files);
  const again = await convert(files);
  const origin = first.config().webOrigin;
  equal("is moz-extension:// and a uuid that holds for the bundle, and the address built on it asks the runtime",
    [/^moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(origin),
      again.config().webOrigin === origin, first.text("bg.js").includes("WEX.chromeExtensionOrigin(uuid)")],
    [true, true, true]);
}

(async () => {
  chromeOrigins();
  moduleOriginPaths();
  locationPaths();
  workerGlobals();
  workerTypeofs();
  extensionProtocols();
  whitelistScope();
  archiveLinks();
  await metadata();
  await websiteAccess();
  await firefoxBuild();
  await staticRulesets();
  await chromeIdentity();
  svgInCss();
  await reservedFolder();
  await pageWithoutHead();
  await chromeData();
  await sandboxedPages();
  await localizedStylesheets();
  await backgroundSafari();
  await injectedContentScripts();
  await reportAliases();
  await firefoxWebOrigin();
  slashes();
  logicalAssignments();
  siteAccess();
  await renamedFilesEnd();
  await earlySheetTexts();
  await manifestAndIdentity();
  console.log("\n" + passed + " checks passed, " + failed + " failed");
  process.exitCode = failed ? 1 : 0;
})();
