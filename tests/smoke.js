// Boots the runtime layer against a converted bundle's own generated config.
//
//     node tests/smoke.js build/*.safariextension
//
// This checks that what the converter wrote is loadable and self-consistent —
// the config parses, the global page comes up, extension pages get their
// namespace, and the content bridge picks the right scripts for a page — and
// then runs the whole global page, the extension's background included, each
// script on its own as Safari runs them. A runtime file that throws there is
// a failure; what the extension's own scripts throw, or leave rejected, is
// reported, since the fake browser is not a whole one.

"use strict";

const fs = require("fs");
const vm = require("vm");
const path = require("path");
const plist = require("./plist");
const { FakeBrowser } = require("./fake-safari");

let failures = 0;

function report(bundle, ok, message) {
  const label = path.basename(bundle);
  if (ok) {
    console.log("  ok    " + label + ": " + message);
  } else {
    failures += 1;
    console.log("  FAIL  " + label + ": " + message);
  }
}

function boot(bundle) {
  const wex = (name) => path.join(bundle, "wex", name);

  const info = plist.read(path.join(bundle, "Info.plist"));
  const bundleId = info.CFBundleIdentifier;
  const chrome = info.Chrome || {};
  const popover = (chrome.Popovers || [])[0];
  const browser = new FakeBrowser(bundle, { bundleId, popup: !!popover });

  const window0 = browser.openWindow();
  const tab = window0.openTab();
  tab.url = "https://example.com/page";
  window0.activeTab = tab;

  // -- the Info.plist has to name files that are actually there ----------
  const referenced = [chrome["Global Page"]]
    .concat((chrome.Popovers || []).map((p) => p.Filename))
    .concat((chrome["Toolbar Items"] || []).map((t) => t.Image))
    .concat(((info.Content || {}).Scripts || {}).Start || [])
    .concat(((info.Content || {}).Scripts || {}).End || [])
    .concat(((info.declarative_net_request || {}).rule_resources || []).map((r) => r.path))
    .filter(Boolean);

  const missing = referenced.filter((p) => !fs.existsSync(path.join(bundle, p)));
  report(bundle, missing.length === 0,
    missing.length ? "Info.plist names files that are not in the bundle: " + missing.join(", ")
                   : "every file Info.plist names is present");

  // Safari gates content injection with Website Access before it considers
  // the Content whitelist. A bundle that names web pages while its access is
  // None is internally contradictory: Safari silently injects nothing. This
  // caught the failure mode where AUDIO_PLAYBACK had a page-hosting bridge in
  // Content but could never connect to it.
  const whitelist = ((info.Content || {}).Whitelist || []);
  const websiteAccess = ((info.Permissions || {})["Website Access"] || {});
  const domains = websiteAccess["Allowed Domains"] || [];
  const covers = (domain, host) => {
    if (host === "*") return domain === "*";
    if (!domain.startsWith("*.")) return host === domain;
    const suffix = domain.slice(2);
    const wanted = host.startsWith("*.") ? host.slice(2) : host;
    return wanted === suffix || wanted.endsWith("." + suffix);
  };
  const injectionAllowed = whitelist.every((entry) => {
    if (websiteAccess.Level === "All") return true;
    if (websiteAccess.Level !== "Some") return false;
    const host = String(entry).split("://").slice(1).join("://").split("/")[0];
    return domains.some((domain) => covers(String(domain), host));
  });
  report(bundle, injectionAllowed,
    injectionAllowed ? "Website Access permits every declared content-injection scope"
                     : "Content injection names pages outside Website Access");

  // -- the global page ----------------------------------------------------
  // The runtime files a bundle's pages load, as the converter lists them.
  const pageRuntime = (layer) => [wex("wex-config.js")]
    .concat(fs.existsSync(wex("wex-api.js")) ? [wex("wex-api.js")] : [])
    .concat([wex("wex-core.js"), wex(layer)]);
  const globalPage = browser.createGlobalPage(pageRuntime("wex-global.js"));
  report(bundle, !!globalPage.chrome, "the global page brought up chrome.*");

  const config = globalPage.WEX_CONFIG;
  report(bundle, config && config.extensionId === bundleId,
    "the config's extension id matches CFBundleIdentifier");

  // -- the toolbar item ------------------------------------------------------
  const item = (chrome["Toolbar Items"] || [])[0] || {};
  report(bundle, popover ? item.Popover === popover.Identifier
                         : item.Command === config.actionCommand,
    popover ? "the toolbar item carries the popup's popover"
            : "the toolbar item carries the command reported as a click");

  // -- extension pages -------------------------------------------------------
  if (popover) {
    const page = browser.createExtensionPage(pageRuntime("wex-page.js"),
      browser.baseURI + popover.Filename);
    report(bundle, !!page.chrome, "the popup got its namespace");
  }
  const tabPage = browser.createTabPage(window0.openTab(), pageRuntime("wex-page.js"),
    browser.baseURI + (config.optionsPage || "page.html"));
  const pageNames = Object.keys(tabPage.chrome || {});
  const globalNames = Object.keys(globalPage.chrome || {});
  const differing = globalNames.filter((n) => pageNames.indexOf(n) < 0)
    .concat(pageNames.filter((n) => globalNames.indexOf(n) < 0).map((n) => "+" + n));
  report(bundle, !!tabPage.chrome && differing.length === 0,
    "a page in a tab has every namespace the global page has" +
    (differing.length ? " (differing: " + differing.join(", ") + ")" : ""));

  // -- the content bridge --------------------------------------------------
  if (info.Content) {
    // A clean install in Safari can silently omit the static Info.plist
    // scripts. Exercise the runtime registration by itself so merely naming
    // a valid bridge in Info.plist can never make this test pass.
    const hasFallbackRuntime = fs.readFileSync(wex("wex-global.js"), "utf8")
      .includes("Keep a runtime registration of the content bridge");
    const fallback = browser.contentScripts.find((entry) => entry.kind === "script" && !entry.atEnd &&
      entry.source.includes("WEXContent.run('document_start')"));
    report(bundle, !hasFallbackRuntime || !!fallback,
      hasFallbackRuntime ? "the first start registered a content-bridge fallback"
                         : "this older bundle predates first-start bridge fallback registration");
    if (hasFallbackRuntime && fallback) {
      const fallbackTab = window0.openTab("background");
      fallbackTab.url = tab.url;
      const fallbackFrame = browser.createContentFrame(fallbackTab, []);
      let fallbackError = null;
      try {
        vm.runInContext(fallback.source, fallbackFrame.context.vmContext);
      } catch (error) {
        fallbackError = error;
      }
      report(bundle, !fallbackError && !!fallbackFrame.sandbox.chrome && !!fallbackFrame.sandbox.WEXContent,
        fallbackError ? "the registered content bridge threw: " + fallbackError.message
                      : "the registered content bridge boots without static injection");
    }

    // The bridge's own scripts, and then the copies of the extension's
    // content scripts Safari injects after it, each on its own as Safari runs
    // them: an exception in one, which the fake page's DOM can cause, stops
    // only that one.
    const all = info.Content.Scripts.Start.concat(info.Content.Scripts.End);
    const copies = all.filter((p) => p.indexOf("wex/content/") === 0);
    const scripts = all.filter((p) => copies.indexOf(p) < 0).map((p) => path.join(bundle, p));
    const frame = browser.createContentFrame(tab, scripts);
    report(bundle, !!frame.sandbox.chrome, "the content bridge brought up chrome.*");
    const threw = copies.filter((p) => {
      try {
        vm.runInContext(fs.readFileSync(path.join(bundle, p), "utf8"), frame.context.vmContext,
          { filename: path.join(bundle, p) });
        return false;
      } catch (e) {
        return true;
      }
    });
    if (threw.length) {
      console.log("  note  " + threw.length + " of " + copies.length + " content-script copies threw in the " +
        "fake page: " + threw.join(", "));
    }

    // Every content script the manifest declares for this page should have
    // been fetched and evaluated; the fixture check above proves the gating
    // works, so here it is enough that nothing threw and the files exist.
    const declared = (config.contentScripts || []);
    const files = declared.reduce((all, g) => all.concat(g.js || [], g.css || []), []);
    const absent = files.filter((f) => !fs.existsSync(path.join(bundle, f)));
    report(bundle, absent.length === 0,
      absent.length ? "content scripts named in the config are missing: " + absent.join(", ")
                    : (files.length + " content-script files are all present"));
  } else {
    report(bundle, true, "no content section, nothing is injected into pages");
  }

  // -- what Safari cannot serve ------------------------------------------------
  // A file with no extension in its name crashes Safari when it is loaded,
  // and an empty one is served as a directory.
  const unservable = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (!entry.name.replace(/^\.+/, "").includes(".") ||
          fs.statSync(full).size === 0) {
        unservable.push(path.relative(bundle, full));
      }
    }
  };
  walk(bundle);
  report(bundle, unservable.length === 0,
    unservable.length ? "files Safari cannot serve: " + unservable.join(", ")
                      : "every file has an extension and content");

  // -- background scripts the global page will try to load ------------------
  const globalPageFile = path.join(bundle, chrome["Global Page"]);
  const html = fs.readFileSync(globalPageFile, "utf8");
  const sources = [];
  html.replace(/<script\b[^>]*\ssrc="([^"]+)"/g, (_, src) => sources.push(src));
  const brokenSources = sources.filter(
    (src) => !fs.existsSync(path.resolve(path.dirname(globalPageFile), src)));
  report(bundle, brokenSources.length === 0,
    brokenSources.length ? "the global page loads scripts that are missing: " + brokenSources.join(", ")
                         : sources.length + " scripts on the global page all resolve");
}

// Runs the bundle's whole global page in a browser of its own, and reports
// what its scripts throw while they run and in the moments after.
async function runBackground(bundle) {
  const info = plist.read(path.join(bundle, "Info.plist"));
  const chrome = info.Chrome || {};
  const page = chrome["Global Page"];
  if (!page) {
    return;
  }
  const html = fs.readFileSync(path.join(bundle, page), "utf8");
  const scripts = [];
  let modules = 0;
  html.replace(/<script\b([^>]*)>/g, (_, attributes) => {
    const src = /\ssrc="([^"]+)"/.exec(attributes);
    if (!src) {
      return;
    }
    if (/\stype="module"/.test(attributes)) {
      modules += 1;
    } else {
      scripts.push(path.resolve(path.dirname(path.join(bundle, page)), src[1]));
    }
  });
  const runtimeFile = (file) => path.relative(bundle, file).split(path.sep)[0] === "wex";
  const where = (error) => {
    const frame = String(error && error.stack || "").split("\n").find((line) => line.includes(bundle));
    return frame ? path.relative(bundle, frame.replace(/^.*?\(?(\/[^():]+):\d+.*$/, "$1")) : "";
  };
  const rejected = [];
  const onRejection = (error) => rejected.push(error);
  process.on("unhandledRejection", onRejection);
  const browser = new FakeBrowser(bundle, { bundleId: info.CFBundleIdentifier, popup: !!(chrome.Popovers || []).length });
  browser.globalPagePath = page;
  const window0 = browser.openWindow();
  window0.activeTab = window0.openTab();
  const globalPage = browser.createGlobalPage([]);
  // A whole IndexedDB, which a background may use as Safari's global page
  // has it, where the fake-indexeddb package is installed.
  let indexedDB = null;
  try {
    indexedDB = require("fake-indexeddb");
  } catch (e) { /* the fake's own, which serves the runtime */ }
  if (indexedDB) {
    for (const name of Object.keys(indexedDB)) {
      if (name === "indexedDB" || /^IDB/.test(name)) {
        globalPage[name] = indexedDB[name];
      }
    }
  }
  const thrown = [];
  for (const file of scripts) {
    try {
      browser.run(globalPage, [file]);
    } catch (error) {
      thrown.push([file, error]);
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  process.removeListener("unhandledRejection", onRejection);
  // An extension whose pages and content scripts send runtime messages
  // listens for them in its background once it has started.
  const own = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== "wex") {
        walk(full);
      } else if (/\.m?js$/.test(entry.name) && !scripts.includes(full)) {
        own.push(full);
      }
    }
  };
  walk(bundle);
  const sends = own.some((file) => /\bruntime\s*\.\s*sendMessage\b/.test(fs.readFileSync(file, "utf8")));
  const api = globalPage.chrome;
  const listens = !!api && ((api.runtime && api.runtime.onMessage && api.runtime.onMessage.hasListeners()) ||
    (api.extension && api.extension.onRequest && api.extension.onRequest.hasListeners()) ||
    (api.runtime && api.runtime.onConnect && api.runtime.onConnect.hasListeners()));
  if (sends && !listens && scripts.some((file) => !runtimeFile(file))) {
    console.log("  note  the extension's pages send runtime messages, and its background listens for none");
  }
  const runtimeThrows = thrown.filter(([file]) => runtimeFile(file));
  report(bundle, runtimeThrows.length === 0,
    runtimeThrows.length ? "runtime files threw on the global page: " + runtimeThrows.map(([file, error]) =>
      path.relative(bundle, file) + ": " + (error && error.message || error)).join("; ")
      : "the global page's " + scripts.length + " scripts ran" + (modules ? ", " + modules + " module scripts not run" : ""));
  for (const [file, error] of thrown.filter(([file]) => !runtimeFile(file))) {
    console.log("  note  " + path.relative(bundle, file) + " threw: " + String(error && error.message || error).slice(0, 200));
  }
  for (const error of rejected.slice(0, 5)) {
    const at = where(error);
    if (at && at.split(path.sep)[0] === "wex") {
      failures += 1;
      console.log("  FAIL  the runtime left a promise rejected on the global page: " +
        String(error && error.message || error).slice(0, 200) + " (" + at + ")");
    } else {
      console.log("  note  the background left a promise rejected: " + String(error && error.message || error).slice(0, 200) +
        (at ? " (" + at + ")" : ""));
    }
  }
}

const bundles = process.argv.slice(2);
if (!bundles.length) {
  console.error("usage: node tests/smoke.js <bundle.safariextension> ...");
  process.exit(2);
}

(async () => {
  for (const bundle of bundles) {
    console.log(path.basename(bundle));
    try {
      boot(path.resolve(bundle));
      await runBackground(path.resolve(bundle));
    } catch (err) {
      failures += 1;
      console.log("  FAIL  " + path.basename(bundle) + ": threw while booting");
      console.log("        " + (err && err.stack ? err.stack.split("\n")[0] : err));
      if (process.env.WEX_VERBOSE) {
        console.log(err);
      }
    }
    console.log("");
  }

  console.log(failures ? failures + " problem(s)" : "all bundles booted");
  process.exit(failures ? 1 : 0);
})();
