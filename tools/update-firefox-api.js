#!/usr/bin/env node
// Writes webext2safari/runtime/firefox-api.json, the part of Firefox's
// extension API schemas a Firefox build's namespaces take from them: the enums
// of each namespace's types, which Firefox gives an extension as objects of
// constants (browser.tabs.UpdatePropertyName.TITLE), from a Firefox source
// tree:
//
//   node tools/update-firefox-api.js FIREFOX_SRC
//
// FIREFOX_SRC needs toolkit/components/extensions/schemas and
// browser/components/extensions/schemas. Each namespace also takes the
// permissions one of which it needs, the manifest key it needs, and whether
// content scripts have it.

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.join(ROOT, "webext2safari", "runtime", "firefox-api.json");
const DIRS = ["toolkit/components/extensions/schemas", "browser/components/extensions/schemas"];

// Firefox's schema files are JSON with line comments, which never sit inside
// a string in them.
function parse(text) {
  return JSON.parse(text.split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n"));
}

function main() {
  const src = process.argv[2];
  if (!src) {
    throw new Error("usage: node tools/update-firefox-api.js FIREFOX_SRC");
  }
  const out = {};
  for (const dir of DIRS) {
    for (const name of fs.readdirSync(path.join(src, dir)).sort()) {
      if (!name.endsWith(".json")) {
        continue;
      }
      for (const ns of parse(fs.readFileSync(path.join(src, dir, name), "utf8"))) {
        if (!ns.namespace || ns.namespace === "manifest") {
          continue;
        }
        const entry = out[ns.namespace] || (out[ns.namespace] = {});
        (ns.types || []).forEach((type) => {
          if (type.id && type.type === "string" && Array.isArray(type.enum)) {
            (entry.types = entry.types || []).push({
              id: ns.namespace + "." + type.id,
              enum: type.enum.map((value) => typeof value === "string" ? value : value.name)
            });
          }
        });
        (ns.permissions || []).forEach((permission) => {
          const manifestKey = /^manifest:(.+)$/.exec(permission);
          const list = manifestKey ? (entry.manifestKeys = entry.manifestKeys || []) :
            (entry.permissions = entry.permissions || []);
          const value = manifestKey ? manifestKey[1] : permission;
          if (list.indexOf(value) < 0) {
            list.push(value);
          }
        });
        if ((ns.allowedContexts || []).indexOf("content") >= 0) {
          entry.content = true;
        }
      }
    }
  }
  const sorted = {};
  Object.keys(out).sort().forEach((name) => {
    if (out[name].types) {
      sorted[name] = out[name];
    }
  });
  fs.writeFileSync(OUTPUT, JSON.stringify(sorted) + "\n");
  console.log(OUTPUT + ": " + Object.keys(sorted).length + " namespaces, " +
    fs.statSync(OUTPUT).size + " bytes");
}

main();
