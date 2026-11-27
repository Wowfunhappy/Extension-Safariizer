// Loads the JavaScript converter into Node and returns its W2S namespace.
//
//     const W2S = require("./webext2safari/js/node.js");
//
// The Safari extension loads the same files with script tags, in the order
// files.json lists them. Node adds what only it can do: reading the runtime
// from disk and converting non-PNG icons with the system's `sips`.

"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const FILES = require("./files.json");

globalThis.pako = require("./vendor/pako.min.js");
// Signing keys are drawn from crypto.getRandomValues, which Node 18 keeps off
// the global object.
if (!globalThis.crypto) {
  globalThis.crypto = require("crypto").webcrypto;
}
for (const file of FILES) {
  if (file.indexOf("vendor/") !== 0) {
    require(path.join(__dirname, file));
  }
}

const W2S = globalThis.W2S;

const RUNTIME_DIR = path.join(__dirname, "..", "runtime");

W2S.node = {
  // The runtime files every bundle carries, and the data the converter
  // reads beside them, by name.
  runtime() {
    const out = {};
    for (const name of W2S.convert.RUNTIME_FILES.concat(W2S.convert.RUNTIME_DATA)) {
      out[name] = new Uint8Array(fs.readFileSync(path.join(RUNTIME_DIR, name)));
    }
    return out;
  },

  // Converts an image to PNG with sips; resolves to the PNG, or null.
  convertImage(data, name) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "webext2safari-icons-"));
    try {
      const source = path.join(workspace, path.basename(name));
      const destination = path.join(workspace, "converted.png");
      fs.writeFileSync(source, data);
      childProcess.execFileSync("sips", ["-s", "format", "png", source, "--out", destination],
                                { stdio: "ignore" });
      return Promise.resolve(fs.existsSync(destination)
        ? new Uint8Array(fs.readFileSync(destination)) : null);
    } catch (e) {
      return Promise.resolve(null);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  },

  // Reads an unpacked extension directory into a tree. Links are followed
  // wherever they point, except a link that resolves only to itself, to a
  // directory it sits inside, whose tree would never end, or to nothing; those
  // are left out.
  readDirectory(directory) {
    const files = new W2S.tree.Tree();
    (function walk(dir, relative, ancestors) {
      for (const name of fs.readdirSync(dir).sort()) {
        const full = path.join(dir, name);
        const rel = relative ? relative + "/" + name : name;
        let stat;
        try {
          stat = fs.statSync(full);
        } catch (e) {
          if (e.code === "ELOOP" || e.code === "ENOENT") {
            continue;
          }
          throw e;
        }
        if (stat.isDirectory()) {
          const real = fs.realpathSync(full);
          if (!ancestors.includes(real)) {
            walk(full, rel, ancestors.concat(real));
          }
        } else {
          files.write(rel, new Uint8Array(fs.readFileSync(full)));
        }
      }
    })(directory, "", [fs.realpathSync(directory)]);
    return files;
  }
};

module.exports = W2S;
