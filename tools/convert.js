// Converts extensions into legacy Safari extension bundles.
//
//     node tools/convert.js EXTENSION... [-o DIR] [--pack] [--quiet]
//         [--bundle-id ID] [--name NAME] [--author NAME]
//         [--storage local|settings] [--popup-size WxH] [--debug]
//
// Each EXTENSION is a .xpi, .crx or .zip, an unpacked directory, or the
// address of the extension's page on the Chrome Web Store or Firefox
// Add-ons, which is downloaded first. The bundle is written into DIR
// (default ./build), and with --pack is also signed into a .safariextz
// beside it, with the identity in dist/signing-identity.json. Each run
// prints the conversion report, or with --quiet only the bundle's path.
//
//   --bundle-id ID       the bundle's CFBundleIdentifier, in place of one
//                        derived from the manifest
//   --name NAME          the extension's name, in Safari and in the
//                        bundle's file name
//   --author NAME        the author Safari's extension list shows, in place
//                        of the manifest's or its homepage's host
//   --storage settings   keeps chrome.storage in Safari's extension
//                        settings, which outlast a website-data reset but
//                        are meant for small values, in place of the
//                        global page's IndexedDB
//   --popup-size WxH     the popover's size before the popup is measured
//                        (default 400x560)
//   --debug              leaves the runtime's diagnostic logging on
//   --test-api MODE      gives the extension chrome.test and browser.test, as
//                        a browser does when it runs extensions' test suites:
//                        "standard" for the W3C proposal's, where a test
//                        passes when it returns, "chrome" for Chromium's,
//                        where it passes when it calls succeed()
//   --test-config FILE   the JSON that chrome.test.getConfig() gives

"use strict";

const fs = require("fs");
const path = require("path");
const W2S = require("../webext2safari/js/node.js");

const ROOT = path.resolve(__dirname, "..");

const USAGE = "usage: node tools/convert.js EXTENSION... [-o DIR] [--pack] [--quiet] " +
  "[--bundle-id ID] [--name NAME] [--author NAME] [--storage local|settings] " +
  "[--popup-size WxH] [--debug] [--test-api standard|chrome] [--test-config FILE]";

function parseArguments() {
  const args = process.argv.slice(2);
  const options = { output: path.join(ROOT, "build"), pack: false, quiet: false, sources: [],
                    converter: {} };
  function value(i) {
    if (args[i + 1] === undefined) {
      throw new Error(args[i] + " needs a value\n" + USAGE);
    }
    return args[i + 1];
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-o" || arg === "--output") {
      options.output = path.resolve(value(i++));
    } else if (arg === "--pack") {
      options.pack = true;
    } else if (arg === "--quiet") {
      options.quiet = true;
    } else if (arg === "--debug") {
      options.converter.debug = true;
    } else if (arg === "--test-api") {
      options.converter.testApi = value(i);
      if (!/^(standard|chrome)$/.test(options.converter.testApi)) {
        throw new Error("--test-api is standard or chrome\n" + USAGE);
      }
      i++;
    } else if (arg === "--test-config") {
      options.converter.testConfig = JSON.parse(fs.readFileSync(value(i), "utf8"));
      i++;
    } else if (arg === "--bundle-id") {
      options.converter.bundleId = value(i++);
    } else if (arg === "--name") {
      options.converter.name = value(i++);
    } else if (arg === "--author") {
      options.converter.author = value(i++);
    } else if (arg === "--storage") {
      options.converter.storage = value(i++);
      if (options.converter.storage !== "local" && options.converter.storage !== "settings") {
        throw new Error("--storage is local or settings\n" + USAGE);
      }
    } else if (arg === "--popup-size") {
      const size = /^(\d+)x(\d+)$/i.exec(value(i++));
      if (!size) {
        throw new Error("--popup-size is WIDTHxHEIGHT, as 400x560\n" + USAGE);
      }
      options.converter.popupSize = [Number(size[1]), Number(size[2])];
    } else if (arg.charAt(0) === "-") {
      throw new Error("unknown option " + arg + "\n" + USAGE);
    } else {
      options.sources.push(arg);
    }
  }
  if (!options.sources.length) {
    throw new Error(USAGE);
  }
  return options;
}

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("downloading " + url + " failed: HTTP " + response.status);
  }
  const data = new Uint8Array(await response.arrayBuffer());
  // The Chrome Web Store answers 204 with nothing for an extension it no
  // longer offers.
  if (!data.length) {
    throw new Error("the store offers no download for " + url + " (HTTP " + response.status +
      "): the extension may have been taken down");
  }
  return data;
}

// The listing's page of a Chrome Web Store extension, or null if it cannot
// be read; the conversion goes ahead without what it says.
async function chromeListingPage(id) {
  try {
    const response = await fetch(W2S.webstore.chromeListingUrl(id));
    return response.ok ? await response.text() : null;
  } catch (e) {
    return null;
  }
}

// The archive a store page offers, and what its listing says of the
// extension, or null when `source` is no such page.
async function storeArchive(source, uiLanguage) {
  const chromeId = W2S.webstore.extensionId(source);
  if (chromeId) {
    const [archive, page] = await Promise.all([download(W2S.webstore.downloadUrl(chromeId)),
                                              chromeListingPage(chromeId)]);
    return { archive, listing: W2S.webstore.chromeListing(chromeId, page) };
  }
  const addon = W2S.webstore.firefoxAddon(source);
  if (addon) {
    const response = await fetch(W2S.webstore.firefoxApiUrl(addon));
    if (!response.ok) {
      throw new Error("looking up " + source + " failed: HTTP " + response.status);
    }
    const details = await response.json();
    return { archive: await download(details.current_version.file.url),
             listing: W2S.webstore.firefoxListing(details, uiLanguage) };
  }
  return null;
}

async function convertOne(source, options) {
  // The browser's language, as Safari's would give it here.
  const uiLanguage = Intl.DateTimeFormat().resolvedOptions().locale;
  const settings = Object.assign({ source, runtime: W2S.node.runtime(), convertImage: W2S.node.convertImage,
                                   uiLanguage }, options.converter);
  const store = await storeArchive(source, uiLanguage);
  if (store) {
    settings.archive = store.archive;
    settings.listing = store.listing;
  } else if (fs.statSync(source).isDirectory()) {
    settings.files = W2S.node.readDirectory(source);
  } else {
    settings.archive = new Uint8Array(fs.readFileSync(source));
  }
  const result = await W2S.convert.convert(settings);
  const bundleDir = path.join(options.output, result.bundleName);
  fs.rmSync(bundleDir, { recursive: true, force: true });
  for (const name of result.files.paths()) {
    const target = path.join(bundleDir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, result.files.read(name));
  }
  if (options.pack) {
    const identityFile = path.join(ROOT, "dist", "signing-identity.json");
    if (!fs.existsSync(identityFile)) {
      fs.mkdirSync(path.dirname(identityFile), { recursive: true });
      fs.writeFileSync(identityFile, JSON.stringify(W2S.rsa.createIdentity()), { mode: 0o600 });
    }
    const identity = W2S.rsa.loadIdentity(JSON.parse(fs.readFileSync(identityFile, "utf8")));
    const archivePath = bundleDir.replace(/\.safariextension$/, ".safariextz");
    fs.writeFileSync(archivePath, W2S.convert.pack(result, identity));
  }
  if (!options.quiet) {
    console.log(result.report);
  }
  console.log(bundleDir);
}

async function main() {
  let options;
  try {
    options = parseArguments();
  } catch (e) {
    console.error(e.message);
    process.exitCode = 2;
    return;
  }
  fs.mkdirSync(options.output, { recursive: true });
  let failed = false;
  for (const source of options.sources) {
    try {
      await convertOne(source, options);
    } catch (e) {
      failed = true;
      console.error(source + ": " + e.message);
    }
  }
  process.exitCode = failed ? 1 : 0;
}

main();
