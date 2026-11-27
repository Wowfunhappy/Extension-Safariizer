// Signs a .safariextension folder into a .safariextz Safari can install.
//
//     node tools/pack-extension.js BUNDLE.safariextension... [--identity FILE]
//
// Each archive is written beside its folder. It is signed with the identity in
// FILE (default dist/signing-identity.json), which is made if it does not
// exist yet.

"use strict";

const fs = require("fs");
const path = require("path");
const W2S = require("../webext2safari/js/node.js");

const ROOT = path.resolve(__dirname, "..");

function main() {
  const args = process.argv.slice(2);
  let identityFile = path.join(ROOT, "dist", "signing-identity.json");
  const bundles = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--identity" && args[i + 1]) {
      identityFile = path.resolve(args[++i]);
    } else {
      bundles.push(path.resolve(args[i]));
    }
  }
  if (!bundles.length) {
    console.error("usage: node tools/pack-extension.js BUNDLE.safariextension... [--identity FILE]");
    process.exit(2);
  }
  if (!fs.existsSync(identityFile)) {
    fs.mkdirSync(path.dirname(identityFile), { recursive: true });
    fs.writeFileSync(identityFile, JSON.stringify(W2S.rsa.createIdentity()), { mode: 0o600 });
  }
  const identity = W2S.rsa.loadIdentity(JSON.parse(fs.readFileSync(identityFile, "utf8")));

  for (const bundle of bundles) {
    try {
      const files = W2S.node.readDirectory(bundle);
      const archive = W2S.convert.pack({ bundleName: path.basename(bundle), files }, identity);
      const output = bundle.replace(/\.safariextension\/?$/, "") + ".safariextz";
      fs.writeFileSync(output, archive);
      console.log(output);
    } catch (e) {
      console.error(bundle + ": " + e.message);
      process.exitCode = 1;
    }
  }
}

main();
