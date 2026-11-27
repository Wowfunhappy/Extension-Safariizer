// The least WebKit an extension runs in: the user agent's version against the
// minimum, and what the global page does in an older WebKit.
// node tests/webkit-requirement.js
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "webext2safari", "runtime",
  "webkit-requirement.js"), "utf8");
const AQUA = (version) => "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/" + version + " Safari/605.1.15";
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";

let passed = 0;
const failures = [];

function equal(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    passed += 1;
  } else {
    failures.push(name + ": got " + a + ", expected " + b);
  }
}

// The check, loaded where the user agent is `userAgent` and the minimum is
// `minimum`, in a page that is still loading.
function load(userAgent, minimum) {
  const out = { alerts: [], writes: [] };
  const context = vm.createContext({
    WEBKIT_MINIMUM: minimum,
    navigator: { userAgent },
    document: { readyState: "loading", write: (text) => out.writes.push(text) },
    alert: (message) => out.alerts.push(message)
  });
  vm.runInContext(SOURCE, context);
  out.requirement = vm.runInContext("WebKitRequirement", context);
  return out;
}

equal("27.2 is enough for a minimum of 27.1", load(AQUA("27.2"), "27.1").requirement.met(), true);
equal("and for a minimum of 27.2", load(AQUA("27.2"), "27.2").requirement.met(), true);
equal("but not for 27.3", load(AQUA("27.2"), "27.3").requirement.met(), false);
equal("or for 28", load(AQUA("27.2"), "28").requirement.met(), false);
equal("27.10 is later than 27.9", load(AQUA("27.10"), "27.9").requirement.met(), true);
equal("a user agent that gives no version is too old", load(CHROME, "27.2").requirement.met(), false);
equal("with no minimum, any WebKit is new enough", load(CHROME, undefined).requirement.met(), true);

const enough = load(AQUA("27.2"), "27.1");
equal("in a WebKit that is new enough, the global page starts and nobody is told",
  [enough.requirement.start("Example"), enough.alerts, enough.writes], [true, [], []]);

const old = load(AQUA("27.2"), "27.3");
equal("in an older one, it does not start, the rest of the page is read as text, and the user is told",
  [old.requirement.start("Example"), old.writes, old.alerts],
  [false, ["<plaintext hidden>"], ["Example requires a newer version of WebKit. Please update to the " +
    "latest version of Aqua WebKit to use Example."]]);

failures.forEach((failure) => console.log("  FAIL  " + failure));
console.log(passed + " checks passed, " + failures.length + " failed");
process.exitCode = failures.length ? 1 : 0;
