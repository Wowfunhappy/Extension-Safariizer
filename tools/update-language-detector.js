#!/usr/bin/env node
// Writes the language detector the runtime answers i18n.detectLanguage and
// tabs.detectLanguage with, which is Chrome's, CLD3 (Google, Apache 2.0),
// from its WebAssembly build in the cld3-asm package (OJ Kwon, MIT):
//
//   node tools/update-language-detector.js [CLD3_ASM] [CLD3_LICENSE]
//
// CLD3_ASM is the directory of the cld3-asm package; without it, the
// package is looked for where Node looks for modules. CLD3_LICENSE is a copy
// of CLD3's LICENSE file; without it, the one beside this tool's output is
// kept. Into webext2safari/runtime it writes:
//
//   cld3.wasm          the module, from the package's browser build, where
//                      emscripten keeps it as base64
//   cld3.json          what loading the module needs from that build's
//                      emscripten glue: the memory and function table it
//                      imports, where its heap starts and where it keeps the
//                      heap's top, and its static constructors
//   cld3-LICENSE.txt   CLD3's licence and cld3-asm's, which every bundle
//                      carries beside the module

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const RUNTIME = path.join(ROOT, "webext2safari", "runtime");

function find(source, pattern, what) {
  const match = pattern.exec(source);
  if (!match) {
    throw new Error("could not find " + what + " in the emscripten glue");
  }
  return match;
}

function main() {
  const dir = process.argv[2] ? path.resolve(process.argv[2])
    : path.dirname(require.resolve("cld3-asm/package.json"));
  const glue = fs.readFileSync(path.join(dir, "dist", "cjs", "lib", "browser", "cld3.js"), "utf8");
  const wasm = Buffer.from(find(glue, /data:application\/octet-stream;base64,([A-Za-z0-9+/=]+)/,
    "the module")[1], "base64");
  const module = new WebAssembly.Module(wasm);
  const imports = WebAssembly.Module.imports(module);
  const exports = WebAssembly.Module.exports(module).map((entry) => entry.name);
  const constant = (name) => Number(find(glue, new RegExp("\\b" + name + "=(\\d+)"), name)[1]);
  const table = find(glue, /new WebAssembly\.Table\(\{"initial":(\d+),"maximum":(\d+)/, "the function table");
  const memory = Number(find(glue, /INITIAL_TOTAL_MEMORY=Module\["TOTAL_MEMORY"\]\|\|(\d+)/, "the memory size")[1]);
  const constructors = [];
  glue.replace(/__ATINIT__\.push\(\{func:function\(\)\{(\w+)\(\)\}\}\)/g, (_, name) => constructors.push(name));
  const layout = {
    source: "cld3-asm " + JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version,
    memoryPages: memory / 65536,
    tableSize: Number(table[1]),
    tableBase: Number(find(glue, /env\["__table_base"\]=(\d+)/, "the table base")[1]),
    dynamicBase: constant("DYNAMIC_BASE"),
    dynamicTopPointer: constant("DYNAMICTOP_PTR"),
    constructors,
    // The imports the module names, which the runtime answers by name.
    imports: imports.map((entry) => entry.module + "." + entry.name)
  };
  for (const name of ["_Cld_create", "_Cld_findTopNMostFreqLangs", "_get_SizeLanguageResult", "_malloc", "_free"]
    .concat(constructors)) {
    if (!exports.includes(name)) {
      throw new Error("the module does not export " + name);
    }
  }
  fs.writeFileSync(path.join(RUNTIME, "cld3.wasm"), wasm);
  fs.writeFileSync(path.join(RUNTIME, "cld3.json"), JSON.stringify(layout, null, 1) + "\n");
  const cld3License = process.argv[3] ? fs.readFileSync(path.resolve(process.argv[3]), "utf8") : null;
  const licenseFile = path.join(RUNTIME, "cld3-LICENSE.txt");
  if (cld3License) {
    fs.writeFileSync(licenseFile,
      "The language detector in cld3.wasm is CLD3, Chrome's Compact Language Detector 3,\n" +
      "https://github.com/google/cld3, compiled to WebAssembly by cld3-asm,\n" +
      "https://github.com/kwonoj/cld3-asm.\n\n" +
      "== CLD3 ==\n\n" + cld3License.trim() + "\n\n" +
      "== cld3-asm ==\n\n" + fs.readFileSync(path.join(dir, "LICENSE"), "utf8").trim() + "\n");
  } else if (!fs.existsSync(licenseFile)) {
    throw new Error("give a copy of CLD3's LICENSE the first time");
  }
  console.log("wrote cld3.wasm (" + wasm.length + " bytes), cld3.json and cld3-LICENSE.txt from " + layout.source);
}

main();
