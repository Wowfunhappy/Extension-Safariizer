#!/usr/bin/env node
// Writes webext2safari/runtime/chrome-api.json, the part of Chromium's
// extension API schemas Chrome checks a call's arguments against, from a
// Chromium source tree:
//
//   node tools/update-chrome-api.js CHROMIUM_SRC
//
// CHROMIUM_SRC needs tools/json_schema_compiler, tools/json_comment_eater,
// tools/idl_parser, third_party/ply, extensions/common/api and
// chrome/common/extensions/api (with its devtools directory). The schemas are
// read with Chromium's own loader, then given the changes Chromium makes
// before building them into the browser (cpp_bundle_generator.py): no
// descriptions, and every type and reference named with its namespace. Of
// each namespace's and type's events, the names are kept, and of a
// namespace's events, what Chromium's own feature for the event asks of an
// extension: a manifest version or a permission. An event no extension gets
// on Chrome's stable channel is left out. A namespace's constants are kept
// with their values, and an event that takes rules in place of listeners is
// named as one. From
// Chromium's _api_features.json each namespace takes the permissions one of
// which it needs, the manifest key it needs, and whether content scripts have
// it or any of its members, and which of a namespace's functions an extension
// has without the permissions the namespace needs.

"use strict";

const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.join(ROOT, "webext2safari", "runtime", "chrome-api.json");

// The namespaces the runtime gives an extension, by Chrome's names, and those
// whose types they refer to.
const NAMESPACES = [
  "runtime", "extension", "storage", "tabs", "windows", "i18n", "browserAction", "action",
  "pageAction", "contextMenus", "webNavigation", "webRequest", "declarativeNetRequest",
  "scripting", "cookies", "alarms", "notifications", "downloads", "commands", "permissions",
  "idle", "management", "privacy", "browsingData", "offscreen", "identity",
  "devtools.inspectedWindow", "devtools.network", "devtools.panels", "tabGroups", "proxy",
  "dom", "test", "sessions", "sidePanel", "debugger", "tts", "omnibox", "declarativeContent",
  "publicSuffix", "pageCapture"
];

// What a function's or type's description keeps.
const KEPT = ["id", "name", "type", "optional", "$ref", "choices", "properties",
  "additionalProperties", "ignoreAdditionalProperties", "items", "enum", "minimum",
  "maximum", "minLength", "maxLength", "minItems", "maxItems", "isInstanceOf", "preserveNull",
  "parameters", "returns_async", "functions", "events", "serializableFunction",
  "does_not_support_promises"];

const LOADER = `
import json, os, sys
src = sys.argv[1]
sys.path[:0] = [os.path.join(src, "tools", "json_schema_compiler")]
from schema_loader import SchemaLoader
import json_parse
out = {"schemas": {}, "features": {}}
for f in sys.argv[2:]:
    if os.path.basename(f) == "_api_features.json":
        out["features"].update(json_parse.Parse(open(f).read()))
        continue
    for ns in SchemaLoader(os.path.dirname(f)).LoadSchema(os.path.basename(f)):
        out["schemas"][ns["namespace"]] = ns
json.dump(out, sys.stdout)
`;

function schemaFiles(src) {
  const dirs = ["extensions/common/api", "chrome/common/extensions/api",
    "chrome/common/extensions/api/devtools"];
  const files = [path.join(src, "extensions/common/api/_api_features.json"),
    path.join(src, "chrome/common/extensions/api/_api_features.json")];
  for (const dir of dirs) {
    for (const name of fs.readdirSync(path.join(src, dir)).sort()) {
      if (/^[a-z].*\.(json|idl|webidl)$/.test(name) && !/manifest|requirements/.test(name)) {
        files.push(path.join(src, dir, name));
      }
    }
  }
  return files;
}

function load(src) {
  const json = childProcess.execFileSync("python3", ["-I", "-c", LOADER, src].concat(schemaFiles(src)),
    { maxBuffer: 256 * 1024 * 1024, encoding: "utf8" });
  return JSON.parse(json);
}

// _PrefixSchemaWithNamespace in cpp_bundle_generator.py.
function prefixed(schema) {
  const ns = schema.namespace;
  const qualify = (name) => name.indexOf(".") < 0 ? ns + "." + name : name;
  (schema.types || []).forEach((type) => {
    type.id = qualify(type.id);
  });
  (function walk(value) {
    if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === "object") {
      if (typeof value.$ref === "string") {
        value.$ref = qualify(value.$ref);
      }
      Object.keys(value).forEach((key) => walk(value[key]));
    }
  })(schema);
  return schema;
}

function compact(value) {
  if (Array.isArray(value)) {
    return value.map(compact);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const out = {};
  for (const key of KEPT) {
    if (!(key in value)) {
      continue;
    }
    if (key === "properties") {
      out.properties = {};
      for (const name of Object.keys(value.properties)) {
        out.properties[name] = compact(value.properties[name]);
      }
    } else if (key === "events") {
      out.events = value.events.map((event) => event.name);
    } else if (key === "enum") {
      out.enum = value.enum.map((entry) => typeof entry === "string" ? entry : entry.name);
    } else if (key === "returns_async") {
      const r = value.returns_async;
      out.returns_async = {};
      if (r.optional) {
        out.returns_async.optional = true;
      }
      if ("does_not_support_promises" in r) {
        out.returns_async.does_not_support_promises = true;
      }
    } else {
      out[key] = compact(value[key]);
    }
  }
  return out;
}

// What _api_features.json asks of an extension for it to have a namespace, in
// the forms of the namespace an extension can have.
function availability(feature) {
  const out = { permissions: [], manifestKeys: [], content: false };
  [].concat(feature || []).forEach((form) => {
    const contexts = [].concat(form.contexts || []);
    if (form.internal || (contexts.indexOf("privileged_extension") < 0 &&
        contexts.indexOf("content_script") < 0)) {
      return;
    }
    out.content = out.content || contexts.indexOf("content_script") >= 0;
    [].concat(form.dependencies || []).forEach((dependency) => {
      const [kind, name] = dependency.split(":");
      const list = kind === "permission" ? out.permissions : kind === "manifest" ? out.manifestKeys : null;
      if (list && list.indexOf(name) < 0) {
        list.push(name);
      }
    });
  });
  return out;
}

// What a member's own feature asks of an extension, or null when no
// extension gets the member on Chrome's stable channel for the Mac.
function eventLimits(feature) {
  const forms = [].concat(feature || []);
  if (!forms.length) {
    return {};
  }
  const open = forms.filter((form) => !form.internal && !form.feature_flag &&
    (!form.channel || form.channel === "stable") &&
    (!form.platforms || [].concat(form.platforms).indexOf("mac") >= 0));
  if (!open.length) {
    return null;
  }
  const form = open[0];
  const limits = {};
  if (form.min_manifest_version) {
    limits.minManifestVersion = form.min_manifest_version;
  }
  if (form.max_manifest_version) {
    limits.maxManifestVersion = form.max_manifest_version;
  }
  const permissions = [].concat(form.dependencies || []).filter((d) => d.indexOf("permission:") === 0)
    .map((d) => d.slice("permission:".length));
  if (permissions.length) {
    limits.permissions = permissions;
  }
  const manifestKeys = [].concat(form.dependencies || []).filter((d) => d.indexOf("manifest:") === 0)
    .map((d) => d.slice("manifest:".length));
  if (manifestKeys.length) {
    limits.manifestKeys = manifestKeys;
  }
  return limits;
}

// The properties of a namespace, at any depth, that hold an object of a type
// with functions: storage.local, a StorageArea; privacy.network's settings.
function typedProperties(properties, prefix, out) {
  Object.keys(properties || {}).forEach((name) => {
    const property = properties[name];
    if (property.$ref) {
      out[prefix + name] = property.$ref;
    } else if (property.type === "object" && property.properties) {
      typedProperties(property.properties, prefix + name + ".", out);
    }
  });
  return out;
}

// A namespace's functions, its types, and the properties that hold an object
// of one of its types.
function namespaceEntry(schema) {
  const entry = {};
  if (schema.functions && schema.functions.length) {
    entry.functions = compact(schema.functions);
  }
  if (schema.events && schema.events.length) {
    entry.events = schema.events.map((event) => event.name);
    const rules = schema.events.filter((event) => event.options && event.options.supportsRules)
      .map((event) => event.name);
    if (rules.length) {
      entry.ruleEvents = rules;
    }
  }
  if (schema.types && schema.types.length) {
    entry.types = compact(schema.types);
  }
  const constants = {};
  Object.keys(schema.properties || {}).forEach((name) => {
    const value = schema.properties[name].value;
    if (["number", "string", "boolean"].indexOf(typeof value) >= 0) {
      constants[name] = value;
    }
  });
  if (Object.keys(constants).length) {
    entry.constants = constants;
  }
  const properties = typedProperties(schema.properties, "", {});
  if (Object.keys(properties).length) {
    entry.properties = properties;
  }
  return entry;
}

function referencedNamespaces(entry) {
  const found = new Set();
  (function walk(value) {
    if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === "object") {
      if (typeof value.$ref === "string") {
        found.add(value.$ref.slice(0, value.$ref.lastIndexOf(".")));
      }
      Object.keys(value).forEach((key) => walk(value[key]));
    }
  })(entry);
  Object.keys(entry.properties || {}).forEach((name) => {
    const ref = entry.properties[name];
    found.add(ref.slice(0, ref.lastIndexOf(".")));
  });
  return found;
}

function main() {
  const src = process.argv[2];
  if (!src) {
    throw new Error("usage: node tools/update-chrome-api.js CHROMIUM_SRC");
  }
  const loaded = load(path.resolve(src));
  const schemas = loaded.schemas;
  const out = {};
  const pending = NAMESPACES.slice();
  while (pending.length) {
    const name = pending.shift();
    if (out[name]) {
      continue;
    }
    if (!schemas[name]) {
      throw new Error("Chromium has no schema for " + name);
    }
    const entry = namespaceEntry(prefixed(schemas[name]));
    if (entry.events) {
      const limited = {};
      entry.events = entry.events.filter((event) => {
        const limits = eventLimits(loaded.features[name + "." + event]);
        if (limits && Object.keys(limits).length) {
          limited[event] = limits;
        }
        return limits !== null;
      });
      if (Object.keys(limited).length) {
        entry.eventLimits = limited;
      }
    }
    const uses = Array.from(referencedNamespaces(entry)).filter((ns) => ns !== name).sort();
    const needs = availability(loaded.features[name]);
    Object.keys(loaded.features).forEach((feature) => {
      if (feature.indexOf(name + ".") === 0 && availability(loaded.features[feature]).content) {
        needs.content = true;
      }
    });
    if (needs.permissions.length) {
      entry.permissions = needs.permissions;
      const open = (entry.functions || []).map((fn) => fn.name).filter((fn) => {
        const limits = eventLimits(loaded.features[name + "." + fn]);
        return limits && loaded.features[name + "." + fn] && !limits.permissions && !limits.manifestKeys;
      });
      if (open.length) {
        entry.openFunctions = open;
      }
    }
    if (needs.manifestKeys.length) {
      entry.manifestKeys = needs.manifestKeys;
    }
    if (needs.content) {
      entry.content = true;
    }
    if (uses.length) {
      entry.uses = uses;
    }
    out[name] = entry;
    uses.forEach((ns) => {
      if (!out[ns]) {
        pending.push(ns);
      }
    });
  }
  const sorted = {};
  Object.keys(out).sort().forEach((name) => {
    sorted[name] = out[name];
  });
  fs.writeFileSync(OUTPUT, JSON.stringify(sorted) + "\n");
  console.log(OUTPUT + ": " + Object.keys(sorted).length + " namespaces, " +
    fs.statSync(OUTPUT).size + " bytes");
}

main();
