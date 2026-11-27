// Tests of the "Add to Safari" button on store pages, against a small stand-in
// for the page.
//
//     node tests/store.js

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "safari-extension", "store.js"), "utf8");
const FIRST = "a".repeat(32);
const SECOND = "b".repeat(32);

let passed = 0;
let failed = 0;

function equal(message, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log("  ok    " + message);
  } else {
    failed++;
    console.log("  FAIL  " + message + " - got " + a + ", expected " + e);
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.style = {};
    this.listeners = [];
    this.text = "";
    this.offsetWidth = 10;
    this.offsetHeight = 10;
  }
  get textContent() {
    return this.text + this.children.map((child) => child.textContent).join("");
  }
  set textContent(value) {
    this.text = value;
    this.children = [];
  }
  get nextSibling() {
    const siblings = this.parentNode.children;
    return siblings[siblings.indexOf(this) + 1] || null;
  }
  getClientRects() {
    return [1];
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  getAttribute(name) {
    return name in this.attributes ? this.attributes[name] : null;
  }
  hasAttribute(name) {
    return name in this.attributes;
  }
  removeAttribute(name) {
    delete this.attributes[name];
  }
  addEventListener(name, listener) {
    this.listeners.push(listener);
  }
  appendChild(child) {
    return this.insertBefore(child, null);
  }
  insertBefore(child, before) {
    child.parentNode = this;
    const at = before ? this.children.indexOf(before) : this.children.length;
    this.children.splice(at, 0, child);
    return child;
  }
  removeChild(child) {
    this.children.splice(this.children.indexOf(child), 1);
    child.parentNode = null;
    return child;
  }
  cloneNode() {
    const clone = new FakeElement(this.tagName);
    clone.text = this.text;
    clone.attributes = { ...this.attributes };
    clone.style = { ...this.style };
    return clone;
  }
  contains(element) {
    return element === this || this.children.some((child) => child.contains(element));
  }
  all() {
    return this.children.reduce((out, child) => out.concat(child, child.all()), []);
  }
  click() {
    this.clicked = true;
    if (this.onClicked) {
      this.onClicked();
    }
    this.listeners.forEach((listener) => listener({ preventDefault() {}, stopPropagation() {} }));
  }
}

// Loads store.js on a page of the Chrome Web Store for extension `id`, in a
// WebKit that is `tooOld` or new enough.
function page(id, tooOld) {
  const root = new FakeElement("HTML");
  const body = root.appendChild(new FakeElement("BODY"));
  const sent = [];
  const saved = [];
  const timers = [];
  let onMessage = null;
  let onChange = null;
  const location = {
    hostname: "chromewebstore.google.com",
    pathname: "/detail/x/" + id,
    href: "https://chromewebstore.google.com/detail/x/" + id
  };
  const document = {
    documentElement: root,
    body,
    visibilityState: "visible",
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll(selector) {
      if (selector === "button") {
        return root.all().filter((element) => element.tagName === "BUTTON");
      }
      if (selector === "[data-w2s-hidden]") {
        return root.all().filter((element) => element.hasAttribute("data-w2s-hidden"));
      }
      return [];
    },
    createElement(tagName) {
      const element = new FakeElement(tagName.toUpperCase());
      if (element.tagName === "A") {
        element.onClicked = () => saved.push(element.download);
      }
      return element;
    }
  };
  const windowObject = { addEventListener() {} };
  windowObject.top = windowObject;
  vm.runInNewContext(SOURCE, {
    window: windowObject,
    document,
    location,
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    safari: { self: {
      tab: { dispatchMessage(name, message) { sent.push({ name, message }); } },
      addEventListener(name, listener) { onMessage = listener; },
      removeEventListener() {}
    } },
    MutationObserver: function (callback) {
      onChange = callback;
      this.observe = () => {};
    },
    setTimeout(callback) { timers.push(callback); },
    atob: (data) => Buffer.from(data, "base64").toString("binary"),
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    Blob: function () {},
    Uint8Array,
    WebKitRequirement: { met: () => !tooOld }
  });
  return {
    body,
    location,
    saved,
    jobs: () => sent.filter((entry) => entry.name === "w2s-convert").map((entry) => entry.message.job),
    button: () => root.all().find((element) => element.hasAttribute("data-w2s-button")),
    // What the page's changing has the script do.
    changed() {
      onChange();
      timers.splice(0).forEach((callback) => callback());
    },
    navigate(next) {
      location.pathname = "/detail/x/" + next;
      location.href = "https://chromewebstore.google.com/detail/x/" + next;
    },
    receive(name, message) {
      onMessage({ name, message });
    }
  };
}

function storeButton() {
  const button = new FakeElement("BUTTON");
  button.text = "Add to Chrome";
  return button;
}

console.log("A conversion under way");

{
  const tab = page(FIRST);
  tab.button().click();
  const job = tab.jobs()[0];
  tab.receive("w2s-progress", { job, stage: "convert" });
  tab.body.appendChild(storeButton());
  tab.changed();
  equal("keeps its progress on the button that replaces the floating one",
    [tab.button().textContent, tab.button().style.position], ["Converting…", undefined]);
  tab.button().click();
  equal("and a click on that button starts no other", tab.jobs().length, 1);
  tab.receive("w2s-progress", { job, stage: "sign" });
  equal("which goes on showing its progress", tab.button().textContent, "Signing…");
  tab.receive("w2s-converted", { job, fileName: "Example.safariextz", data: "AA==" });
  equal("and its archive is saved when it finishes",
    [tab.saved, tab.button().textContent], [["Example.safariextz"], "Open “Example.safariextz” to install"]);
}

{
  const tab = page(FIRST);
  tab.body.appendChild(storeButton());
  tab.changed();
  tab.button().click();
  const job = tab.jobs()[0];
  tab.body.children.splice(0);
  tab.body.appendChild(storeButton());
  tab.changed();
  equal("survives the store re-rendering its button", tab.button().textContent, "Downloading…");
  tab.receive("w2s-converted", { job, fileName: "Example.safariextz", data: "AA==" });
  equal("and its archive is saved", tab.saved, ["Example.safariextz"]);
}

{
  const tab = page(FIRST);
  tab.button().click();
  const job = tab.jobs()[0];
  tab.navigate(SECOND);
  tab.button().style = {};
  tab.body.removeChild(tab.button());
  tab.changed();
  equal("leaves the next extension's button as it is", tab.button().textContent, "Add to Safari");
  tab.receive("w2s-progress", { job, stage: "convert" });
  equal("whatever its progress", tab.button().textContent, "Add to Safari");
  tab.receive("w2s-converted", { job, fileName: "First.safariextz", data: "AA==" });
  equal("has its archive saved after the page moves on", [tab.saved, tab.button().textContent],
    [["First.safariextz"], "Add to Safari"]);
  tab.navigate(FIRST);
  tab.body.removeChild(tab.button());
  tab.changed();
  equal("and shows as saved on coming back", tab.button().textContent, "Open “First.safariextz” to install");
}

{
  const tab = page(FIRST);
  tab.button().click();
  tab.receive("w2s-failed", { job: tab.jobs()[0], message: "no" });
  equal("that fails says so", tab.button().textContent, "Couldn’t convert — try again");
  tab.button().click();
  equal("and may be tried again", tab.jobs().length, 2);
  tab.receive("w2s-converted", { job: "another page's", fileName: "Other.safariextz", data: "AA==" });
  equal("while another job's archive is not saved", tab.saved, []);
}

console.log("In a WebKit older than the extension needs");

equal("the store keeps its own button, with no button of the extension's beside it",
  page(FIRST, true).button() === undefined, true);

console.log("\n" + passed + " checks passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
