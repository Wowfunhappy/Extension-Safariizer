#!/usr/bin/env node
// Writes webext2safari/runtime/public-suffix-list.txt, the rules of the
// Public Suffix List that chrome.publicSuffix answers from:
//
//   node tools/update-public-suffix.js [LIST]
//
// LIST is a copy of public_suffix_list.dat; without one, the list is
// downloaded from publicsuffix.org. Its ICANN and private sections are both
// kept, as Chrome keeps them, one rule a line, with each internationalized
// rule in its ASCII form, as Chrome looks them up; a line "// private" starts
// the private section.

"use strict";

const fs = require("fs");
const path = require("path");
const url = require("url");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.join(ROOT, "webext2safari", "runtime", "public-suffix-list.txt");
const SOURCE = "https://publicsuffix.org/list/public_suffix_list.dat";

// The ASCII form of one label of a rule. An ASCII label is already in that
// form, and domainToASCII would read an all-numeric one, as in "0.bg", as an
// IPv4 address.
function asciiLabel(label) {
  return /^[\x00-\x7f]*$/.test(label) ? label : url.domainToASCII(label);
}

function rules(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    if (/===BEGIN PRIVATE DOMAINS===/.test(raw)) {
      out.push("// private");
    }
    const line = raw.trim().split(/\s/)[0];
    if (!line || line.startsWith("//")) {
      continue;
    }
    const exception = line.startsWith("!");
    const body = exception ? line.slice(1) : line;
    const ascii = body.split(".").map(asciiLabel).join(".");
    if (!ascii || ascii.split(".").some((label) => !label)) {
      throw new Error("could not read the rule " + line);
    }
    out.push((exception ? "!" : "") + ascii.toLowerCase());
  }
  return out;
}

async function main() {
  const given = process.argv[2];
  const text = given ? fs.readFileSync(given, "utf8") : await (await fetch(SOURCE)).text();
  const list = rules(text);
  if (list.length < 1000) {
    throw new Error("the list has only " + list.length + " rules");
  }
  fs.writeFileSync(OUTPUT, list.join("\n") + "\n");
  console.log(OUTPUT + ": " + list.length + " rules, " + fs.statSync(OUTPUT).size + " bytes");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
