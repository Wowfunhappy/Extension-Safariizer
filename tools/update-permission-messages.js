#!/usr/bin/env node
// Writes webext2safari/runtime/permission-messages.json, what Chrome tells a
// user an extension may do, from a Chromium source tree:
//
//   node tools/update-permission-messages.js CHROMIUM_SRC
//
// CHROMIUM_SRC needs chrome/common/extensions/permissions/
// (chrome_api_permissions.cc, chrome_permission_message_rules.cc),
// extensions/common/permissions/extensions_api_permissions.cc and
// chrome/app/generated_resources.grd. The file holds Chrome's rules in the
// order Chrome applies them, each with its message in English as Chrome
// shows it on the Mac, the permission each API permission name gives, and
// the names whose permission gives access to every site.

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.join(ROOT, "webext2safari", "runtime", "permission-messages.json");

function read(src, file) {
  return fs.readFileSync(path.join(src, file), "utf8");
}

// The English messages, by name, with their placeholders as $1, $2 ...; of
// a message given for several platforms, the one the Mac has.
function messages(grd) {
  const out = {};
  const conditions = [];
  const lines = grd.split("\n");
  let current = null;
  for (const line of lines) {
    const open = /<if expr="([^"]*)">/.exec(line);
    if (open) {
      conditions.push(open[1]);
    }
    if (/<\/if>/.test(line)) {
      conditions.pop();
    }
    const start = /<message name="(IDS_EXTENSION_PROMPT_WARNING_[A-Z0-9_]+)"/.exec(line);
    if (start) {
      current = { name: start[1], text: "", mac: conditions.every((c) => !/is_chromeos|is_android|is_win|is_linux/.test(c) ||
        /is_mac|not is_chromeos/.test(c)) };
      current.text = line.slice(line.indexOf(">", line.indexOf("<message")) + 1);
    } else if (current) {
      current.text += "\n" + line;
    }
    if (current && /<\/message>/.test(line)) {
      const text = current.text.replace(/<\/message>[\s\S]*$/, "")
        .replace(/<ph name="[^"]*">\s*(\$\d)?[\s\S]*?<\/ph>/g, "$1")
        .replace(/<ex>[\s\S]*?<\/ex>/g, "").replace(/\s+/g, " ").trim()
        .replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
      if (current.mac || !(current.name in out)) {
        out[current.name] = text;
      }
      current = null;
    }
  }
  return out;
}

// API permission names, by the permission each gives, and those that give
// access to every site.
// Names Chromium gives by a constant.
const NAMED = {
  "declarative_net_request::kDeclarativeNetRequestPermission": "declarativeNetRequest",
  "declarative_net_request::kFeedbackAPIPermission": "declarativeNetRequestFeedback"
};

function permissionNames(sources) {
  const names = {};
  const everySite = [];
  for (const source of sources) {
    const re = /\{APIPermissionID::(k\w+),\s*("([^"]+)"|[\w:]+)([^}]*)\}/g;
    let m;
    while ((m = re.exec(source))) {
      const name = m[3] || NAMED[m[2]];
      if (!name) {
        throw new Error("no name for the constant " + m[2]);
      }
      names[name] = m[1];
      if (/kFlagImpliesFullURLAccess/.test(m[4])) {
        everySite.push(name);
      }
    }
    const alias = /Alias\("([^"]+)",\s*"([^"]+)"\)/g;
    while ((m = alias.exec(source))) {
      names[m[1]] = names[m[2]];
    }
  }
  return { names, everySite };
}

// Chrome's rules, in order: the message or the messages a formatter picks
// from, and the permissions a rule needs and those it takes in as well.
function rules(source, strings) {
  const body = source.replace(/\/\/[^\n]*/g, "").slice(source.replace(/\/\/[^\n]*/g, "").indexOf("rules_arr[] = {"));
  const list = body.slice(body.indexOf("{") + 1, body.indexOf("};\n"));
  const out = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === "{") {
      if (depth === 0) {
        start = i;
      }
      depth++;
    } else if (list[i] === "}") {
      depth--;
      if (depth === 0) {
        out.push(list.slice(start + 1, i));
      }
    }
  }
  return out.map((text) => {
    const sets = [];
    text.replace(/\{([^{}]*)\}/g, (_, inner) => {
      sets.push(inner.match(/APIPermissionID::k\w+/g) ? inner.match(/APIPermissionID::(k\w+)/g)
        .map((id) => id.slice("APIPermissionID::".length)) : []);
      return _;
    });
    const required = sets[sets.length - 2];
    const optional = sets[sets.length - 1];
    const ids = (text.match(/IDS_EXTENSION_PROMPT_WARNING_\w+/g) || []);
    const formatter = (/make_unique<(\w+)>/.exec(text) || [])[1] || "Default";
    if (/GetEnterpriseReportingPrivatePermissionMessageId/.test(text)) {
      ids.push("IDS_EXTENSION_PROMPT_WARNING_ENTERPRISE_REPORTING_PRIVATE_ENABLED_LINUX_AND_MACOS");
    }
    const rule = { format: formatter.replace(/(PermissionMessage)?Formatter$/, ""), required, optional };
    if (formatter !== "USBDevicesFormatter") {
      rule.messages = ids.map((id) => {
        if (!(id in strings)) {
          throw new Error("no message " + id);
        }
        return strings[id];
      });
    }
    return rule;
  });
}

function main() {
  const src = process.argv[2];
  if (!src) {
    console.error("usage: node tools/update-permission-messages.js CHROMIUM_SRC");
    process.exit(2);
  }
  const strings = messages(read(src, "chrome/app/generated_resources.grd"));
  const permissions = permissionNames([
    read(src, "chrome/common/extensions/permissions/chrome_api_permissions.cc"),
    read(src, "extensions/common/permissions/extensions_api_permissions.cc")
  ]);
  const out = {
    rules: rules(read(src, "chrome/common/extensions/permissions/chrome_permission_message_rules.cc"), strings),
    permissions: permissions.names,
    everySite: permissions.everySite,
    hostAndSubdomains: strings.IDS_EXTENSION_PROMPT_WARNING_HOST_AND_SUBDOMAIN,
    hostAndSubdomainsInList: strings.IDS_EXTENSION_PROMPT_WARNING_HOST_AND_SUBDOMAIN_LIST
  };
  fs.writeFileSync(OUTPUT, JSON.stringify(out) + "\n");
  console.log(OUTPUT + ": " + out.rules.length + " rules, " + Object.keys(out.permissions).length +
    " permission names, " + fs.statSync(OUTPUT).size + " bytes");
}

main();
