// The config carries the catalogues of the browser's language, each as its
// JSON's text, and i18n reads another from its file.
// Run with: node tests/i18n-inline.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const source = fs.readFileSync(path.join(__dirname, "../webext2safari/runtime/wex-core.js"), "utf8");
const en = {
  name: { message: "Example" },
  greeting: { message: "Hello $WHO$", placeholders: { who: { content: "$1" } } }
};
const files = { de: { name: { message: "Datei" } } };
let requests = [];
function FakeRequest() {}
FakeRequest.prototype.open = function (method, url) {
  this.wanted = url;
};
FakeRequest.prototype.send = function () {
  const locale = (/_locales\/([^/]+)\//.exec(this.wanted) || [])[1];
  requests.push(locale);
  this.status = files[locale] ? 200 : 404;
  this.responseText = files[locale] ? JSON.stringify(files[locale]) : "";
};
function bridge(language, catalogues) {
  const carried = {};
  for (const name of Object.keys(catalogues)) {
    carried[name] = JSON.stringify(catalogues[name]);
  }
  const context = vm.createContext({
    navigator: { language },
    WEX_CONFIG: { locales: ["en", "de", "en_GB"], defaultLocale: "en", localeMessages: carried },
    XMLHttpRequest: FakeRequest,
    console, setTimeout, clearTimeout
  });
  vm.runInContext(source, context);
  return context.WEX;
}
const wex = bridge("en-US", { en });
const i18n = wex.makeI18n();
assert.strictEqual(i18n.getMessage("NAME"), "Example");
assert.strictEqual(i18n.getMessage("greeting", ["world"]), "Hello world");
assert.strictEqual(i18n.getMessage("missing"), "");
assert.strictEqual(wex.localizeManifest({ name: "__MSG_name__" }, i18n).name, "Example");
assert.strictEqual(bridge("de-DE", { en, de: { name: { message: "Beispiel" } } }).makeI18n().getMessage("name"), "Beispiel");
assert.strictEqual(bridge("en-GB", { en, en_GB: { name: { message: "British" } } }).makeI18n().getMessage("name"), "British");
assert.strictEqual(bridge("fr-FR", { en }).makeI18n().getMessage("name"), "Example");
assert.deepStrictEqual(requests, []);
// A language the config does not carry, as after the browser's changes.
assert.strictEqual(bridge("de-DE", { en }).makeI18n().getMessage("name"), "Datei");
assert.deepStrictEqual(requests, ["de"]);
assert.strictEqual(bridge("en", {}).makeI18n().getMessage("name"), "");
console.log("11 i18n checks passed; carried catalogues read without a request");
