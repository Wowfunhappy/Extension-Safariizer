// Builds the converter's own Safari extension.
//
//     node tools/build-extension.js [-o DIR]
//
// Writes "Extension Safariizer.safariextension" into DIR (default ./dist), for
// Extension Builder to package and sign with a Safari developer certificate.
//
// The bundle holds every file of safari-extension/, Info.plist and
// Settings.plist among them, as they are; tools/sync-extension.js brings
// what Extension Builder changes in the built bundle back there. A build
// records what it put in the bundle, in DIR/Extension Safariizer.built.json,
// and does not replace a bundle with changes still to be brought back.

"use strict";

const fs = require("fs");
const path = require("path");
const W2S = require("../webext2safari/js/node.js");

const ROOT = path.resolve(__dirname, "..");
const SOURCE = path.join(ROOT, "safari-extension");
const CONVERTER = path.join(ROOT, "webext2safari", "js");
const RUNTIME = path.join(ROOT, "webext2safari", "runtime");

const NAME = "Extension Safariizer";
const crypto = require("crypto");

function parseArguments() {
  const args = process.argv.slice(2);
  let output = path.join(ROOT, "dist");
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-o" && args[i + 1]) {
      output = path.resolve(args[++i]);
    } else {
      throw new Error("usage: node tools/build-extension.js [-o DIR]");
    }
  }
  return output;
}

function globalPage() {
  const scripts = ["runtime/webkit-minimum.js", "runtime/webkit-requirement.js"]
    .concat(require(path.join(CONVERTER, "files.json")).map((file) => "converter/" + file))
    .concat(["global.js"]);
  return "<!DOCTYPE html>\n<html>\n<head>\n  <meta charset=\"utf-8\">\n" +
    "  <title>" + NAME + "</title>\n" +
    scripts.map((src) => "  <script src=\"" + src + "\"></script>").join("\n") +
    "\n</head>\n<body></body>\n</html>\n";
}

// The files of safari-extension/, by their paths in it.
function sourceFiles(dir = SOURCE, prefix = "") {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (name.startsWith(".")) {
      continue;
    }
    if (fs.statSync(path.join(dir, name)).isDirectory()) {
      out.push(...sourceFiles(path.join(dir, name), prefix + name + "/"));
    } else {
      out.push(prefix + name);
    }
  }
  return out;
}

function bundleFiles() {
  const files = new W2S.tree.Tree();
  const text = (value) => W2S.bytes.utf8(value);
  for (const name of sourceFiles()) {
    files.write(name, new Uint8Array(fs.readFileSync(path.join(SOURCE, name))));
  }
  for (const file of require(path.join(CONVERTER, "files.json"))) {
    files.write("converter/" + file, new Uint8Array(fs.readFileSync(path.join(CONVERTER, file))));
  }
  files.write("converter/vendor/pako-LICENSE",
              new Uint8Array(fs.readFileSync(path.join(CONVERTER, "vendor", "pako-LICENSE"))));
  for (const name of W2S.convert.RUNTIME_FILES.concat(W2S.convert.RUNTIME_DATA)) {
    files.write("runtime/" + name, new Uint8Array(fs.readFileSync(path.join(RUNTIME, name))));
  }
  files.write("global.html", text(globalPage()));

  return files;
}

// -- the built bundle and its record ------------------------------- //

function bundleDirectory(output) {
  return path.join(output, NAME + ".safariextension");
}

function recordPath(output) {
  return path.join(output, NAME + ".built.json");
}

function hash(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

// The files of a bundle, by their paths in it, leaving out Finder's.
function bundlePaths(dir, prefix = "") {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (name.startsWith(".")) {
      continue;
    }
    if (fs.statSync(path.join(dir, name)).isDirectory()) {
      out.push(...bundlePaths(path.join(dir, name), prefix + name + "/"));
    } else {
      out.push(prefix + name);
    }
  }
  return out;
}

// What changed in the built bundle since the build and is not yet in
// safari-extension/: each file that differs from what the build wrote, or
// that it did not write, and from its source, with what the build wrote
// ({path, built}, `built` null for a new file). Without a record, a bundle
// has no changes to tell.
function bundleChanges(output) {
  const file = recordPath(output);
  if (!fs.existsSync(file)) {
    return [];
  }
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  const dir = bundleDirectory(output);
  return bundlePaths(dir).filter((name) => {
    const now = hash(fs.readFileSync(path.join(dir, name)));
    const source = path.join(SOURCE, name);
    return record[name] !== now && !(fs.existsSync(source) && hash(fs.readFileSync(source)) === now);
  }).map((name) => ({ path: name, built: record[name] || null }));
}

module.exports = { SOURCE, NAME, hash, bundleDirectory, bundlePaths, recordPath, bundleChanges };

function main() {
  const output = parseArguments();
  fs.mkdirSync(output, { recursive: true });
  const unsynced = bundleChanges(output);
  if (unsynced.length) {
    throw new Error("the built bundle has changes not brought back to safari-extension/ (" +
      unsynced.map((change) => change.path).join(", ") + "); run node tools/sync-extension.js, " +
      "or delete " + bundleDirectory(output) + " to discard them");
  }
  const files = bundleFiles();

  const bundleDir = bundleDirectory(output);
  fs.rmSync(bundleDir, { recursive: true, force: true });
  const record = {};
  for (const name of files.paths()) {
    const target = path.join(bundleDir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, files.read(name));
    record[name] = hash(files.read(name));
  }
  fs.writeFileSync(recordPath(output), JSON.stringify(record, null, 1) + "\n");
  console.log(bundleDir);
}

if (require.main === module) {
  main();
}
