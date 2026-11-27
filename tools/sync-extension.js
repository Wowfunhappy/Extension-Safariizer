// Brings changes made in the built Extension Safariizer bundle, as Extension
// Builder makes them to its Info.plist and Settings.plist, back to
// safari-extension/.
//
//     node tools/sync-extension.js [-o DIR]
//
// DIR is where tools/build-extension.js built the bundle (default ./dist).
// A file changed in the bundle since the build replaces its source, and one
// added to the bundle is added to the source. A change to a file the build
// makes from elsewhere (the converter, the runtime, the icons, global.html)
// is reported and left, as is a source file changed since the build too.

"use strict";

const fs = require("fs");
const path = require("path");
const build = require("./build-extension.js");

function parseArguments() {
  const args = process.argv.slice(2);
  let output = path.resolve(__dirname, "..", "dist");
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-o" && args[i + 1]) {
      output = path.resolve(args[++i]);
    } else {
      throw new Error("usage: node tools/sync-extension.js [-o DIR]");
    }
  }
  return output;
}

function main() {
  const output = parseArguments();
  const changes = build.bundleChanges(output);
  if (!fs.existsSync(build.recordPath(output))) {
    throw new Error("no build is recorded in " + output + "; build with tools/build-extension.js first");
  }
  if (!changes.length) {
    console.log("The built bundle has no changes.");
  }
  const bundleDir = build.bundleDirectory(output);
  const record = JSON.parse(fs.readFileSync(build.recordPath(output), "utf8"));
  // A file its source already matches, by whatever route, is in step with it.
  for (const name of build.bundlePaths(bundleDir)) {
    const source = path.join(build.SOURCE, name);
    if (fs.existsSync(source)) {
      const now = build.hash(fs.readFileSync(source));
      if (build.hash(fs.readFileSync(path.join(bundleDir, name))) === now) {
        record[name] = now;
      }
    }
  }
  let left = 0;
  for (const change of changes) {
    const source = path.join(build.SOURCE, change.path);
    const sourceExists = fs.existsSync(source);
    if (change.built && !sourceExists) {
      console.log("left    " + change.path + " (made by the build, not from safari-extension/)");
      left++;
      continue;
    }
    if (sourceExists && build.hash(fs.readFileSync(source)) !== change.built) {
      console.log("left    " + change.path + " (changed in safari-extension/ since the build as well)");
      left++;
      continue;
    }
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.copyFileSync(path.join(bundleDir, change.path), source);
    // The source now holds this change, so the record takes it as the bundle's
    // starting point, and a later edit of the source is no conflict with it.
    record[change.path] = build.hash(fs.readFileSync(source));
    console.log((sourceExists ? "updated " : "added   ") + "safari-extension/" + change.path);
  }
  fs.writeFileSync(build.recordPath(output), JSON.stringify(record, null, 1) + "\n");
  if (left) {
    console.log(left + " change" + (left === 1 ? " was" : "s were") + " left; bring " +
      (left === 1 ? "it" : "them") + " over by hand, then delete " + bundleDir + " so the next build replaces it.");
    process.exitCode = 1;
  }
}

main();
