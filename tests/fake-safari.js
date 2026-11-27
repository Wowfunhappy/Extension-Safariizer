// A stand-in for legacy Safari's extension API and for the `browser`
// namespace WebKit gives its extensions, enough of both to run the runtime
// layer outside Safari.
//
// The shapes here follow what the real objects expose: an application with
// browser windows and tabs, a global page whose window other contexts can
// reach, toolbar items and popovers, a settings store, and an engine that
// routes messages, ports, injections, requests and tab events between the
// extension's contexts and keeps its declarativeNetRequest rules.

"use strict";

const vm = require("vm");
const fs = require("fs");
const path = require("path");
const plist = require("./plist");

// ------------------------------------------------------------------ //
// Storage-like objects
// ------------------------------------------------------------------ //
class KeyStore {
  constructor() {
    this.data = new Map();
  }
  get length() {
    return this.data.size;
  }
  key(i) {
    const keys = Array.from(this.data.keys());
    return i < keys.length ? keys[i] : null;
  }
  getItem(k) {
    return this.data.has(k) ? this.data.get(k) : null;
  }
  setItem(k, v) {
    this.data.set(String(k), String(v));
  }
  removeItem(k) {
    this.data.delete(k);
  }
  clear() {
    this.data.clear();
  }
}

// ------------------------------------------------------------------ //
// IndexedDB, as much of it as the runtime's storage uses: one database of
// object stores with out-of-line keys, put, delete and a cursor over a key
// range. Requests and transactions complete on a later turn.
// ------------------------------------------------------------------ //
class FakeIndexedDB {
  constructor() {
    this.databases = new Map();
  }
  open(name) {
    const request = {};
    later(() => {
      let stores = this.databases.get(name);
      const fresh = !stores;
      if (fresh) {
        stores = new Map();
        this.databases.set(name, stores);
      }
      const db = {
        createObjectStore: (store) => stores.set(store, new Map()),
        transaction: (store) => fakeTransaction(stores.get(store))
      };
      request.result = db;
      if (fresh && request.onupgradeneeded) {
        request.onupgradeneeded();
      }
      if (request.onsuccess) {
        request.onsuccess();
      }
    });
    return request;
  }
}

function fakeTransaction(records) {
  const tx = {};
  let open = 0;
  const finish = () => later(() => {
    if (open === 0 && tx.oncomplete) {
      tx.oncomplete();
    }
  });
  const store = {
    put(value, key) {
      records.set(String(key), value);
    },
    delete(key) {
      records.delete(String(key));
    },
    openCursor(range) {
      const keys = Array.from(records.keys()).sort()
        .filter((k) => !range || (k >= range.lower && k <= range.upper));
      const request = {};
      let at = 0;
      open++;
      const step = () => later(() => {
        if (at < keys.length) {
          const key = keys[at++];
          request.result = { key, value: records.get(key), continue: step };
        } else {
          request.result = null;
          open--;
          finish();
        }
        if (request.onsuccess) {
          request.onsuccess();
        }
      });
      step();
      return request;
    }
  };
  tx.objectStore = () => store;
  finish();
  return tx;
}

// ------------------------------------------------------------------ //
// Listener bookkeeping
// ------------------------------------------------------------------ //
class Emitter {
  constructor() {
    this.bubble = [];
    this.capture = [];
  }
  addEventListener(name, fn, useCapture) {
    (useCapture ? this.capture : this.bubble).push({ name, fn });
  }
  removeEventListener(name, fn, useCapture) {
    const list = useCapture ? this.capture : this.bubble;
    const i = list.findIndex((entry) => entry.name === name && entry.fn === fn);
    if (i >= 0) {
      list.splice(i, 1);
    }
  }
  fire(name, event, captureOnly) {
    const lists = captureOnly ? [this.capture] : [this.capture, this.bubble];
    for (const list of lists) {
      for (const entry of list.slice()) {
        if (entry.name !== name) {
          continue;
        }
        if (event.__stopped) {
          return;
        }
        entry.fn(event);
      }
    }
  }
}

// ------------------------------------------------------------------ //
// The engine
// ------------------------------------------------------------------ //
// WebKit's side of the extension API: one `browser` object per context, and
// the routing between them. Everything that crosses between contexts is
// copied through JSON and delivered on a later task, as the engine does.
function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// A copy made in the realm of `fn`, a listener of the receiving context, as
// the engine makes what it delivers in the receiver's own JavaScript world:
// the receiver's `instanceof Object` holds for it.
function cloneFor(fn, value) {
  if (value === undefined) {
    return undefined;
  }
  let proto = typeof fn === "function" ? Object.getPrototypeOf(fn) : null;
  while (proto && !(typeof proto.constructor === "function" && proto.constructor.prototype === proto &&
                    proto.constructor.name === "Function")) {
    proto = Object.getPrototypeOf(proto);
  }
  const realmJSON = proto ? proto.constructor("return JSON")() : JSON;
  return realmJSON.parse(JSON.stringify(value));
}

// A copy made in the realm of the context a response goes back to, as the
// engine makes it there too.
function cloneInContext(context, value) {
  const sandbox = context && context.sandbox;
  if (value === undefined || !sandbox || !vm.isContext(sandbox)) {
    return value;
  }
  return vm.runInContext("JSON", sandbox).parse(JSON.stringify(value));
}

// A page's location, as WebKit gives one: a Location, so that what the
// runtime defines on Location.prototype reaches it, with the address's parts.
function pageLocation(sandbox, href, extra) {
  const url = new URL(href);
  const fields = { href, protocol: url.protocol, origin: url.protocol + "//" + url.host, host: url.host,
                   hostname: url.hostname, port: url.port, pathname: url.pathname, search: url.search,
                   hash: url.hash };
  const location = Object.create(sandbox.Location.prototype);
  for (const name of Object.keys(fields)) {
    Object.defineProperty(location, name, { value: fields[name], enumerable: true, configurable: true, writable: true });
  }
  Object.defineProperty(location, "toString", { value: () => location.href, configurable: true });
  return Object.assign(location, extra || {});
}

// Safari 7's navigator over Aqua WebKit, its fields on the prototype as WebKit
// has them. Its version meets the minimum in webkit-minimum.js.
const SAFARI_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/27.2 Safari/605.1.15";
// Each JavaScript world has a Navigator of its own.
function navigatorClass() {
  const Navigator = class Navigator {};
  for (const [name, value] of Object.entries({
    userAgent: SAFARI_UA, appVersion: SAFARI_UA.slice("Mozilla/".length), platform: "MacIntel",
    vendor: "Apple Computer, Inc.", product: "Gecko", productSub: "20030107", appName: "Netscape",
    appCodeName: "Mozilla", language: "en-US", languages: ["en-US"], onLine: true, cookieEnabled: true,
    hardwareConcurrency: 4, maxTouchPoints: 0
  })) {
    Object.defineProperty(Navigator.prototype, name, { get: () => value, configurable: true, enumerable: true });
  }
  return Navigator;
}

function later(fn) {
  setTimeout(fn, 0);
}

function makeEvent() {
  const list = [];
  return {
    list,
    addListener(fn, filter, spec) {
      list.push({ fn, filter, spec: spec || [] });
    },
    removeListener(fn) {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].fn === fn) {
          list.splice(i, 1);
        }
      }
    },
    hasListener(fn) {
      return list.some((entry) => entry.fn === fn);
    },
    hasListeners() {
      return list.length > 0;
    }
  };
}

function matchPattern(pattern, url) {
  if (pattern === "<all_urls>") {
    return /^(https?|wss?|safari-extension):/.test(url);
  }
  const m = /^(\*|[a-z-]+):\/\/([^/]*)(\/.*)$/.exec(pattern);
  if (!m) {
    return false;
  }
  const escape = (text) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const scheme = m[1] === "*" ? "(https?|wss?)" : m[1];
  const host = m[2] === "*" ? "[^/]*"
    : m[2].startsWith("*.") ? "([^/]*\\.)?" + escape(m[2].slice(2)) : escape(m[2]);
  return new RegExp("^" + scheme + "://" + host + escape(m[3]) + "$").test(url);
}

const NO_RECEIVER = "Could not establish connection. Receiving end does not exist.";

class Engine {
  constructor(browser) {
    this.browser = browser;
    this.contexts = [];
    this.externalSent = [];
    this.answerExternal = null;
    this.nextTabId = 11;
    this.nextFrameId = 101;
    this.nextRequestId = 1;
    this.cookies = [];
  }

  // -- contexts ---------------------------------------------------------
  addContext(kind, fields) {
    const context = Object.assign({
      kind,
      url: "",
      tab: null,
      frameId: 0,
      alive: true,
      onMessage: makeEvent(),
      onConnect: makeEvent(),
      events: {}
    }, fields);
    context.browser = this.makeBrowser(context);
    this.contexts.push(context);
    return context;
  }

  hosts(except) {
    return this.contexts.filter((c) => c.alive && c.kind === "host" && c !== except);
  }

  inTab(tabId, frameId) {
    return this.contexts.filter((c) => c.alive && c.tab && c.tab.engineId === tabId &&
      (frameId == null || c.frameId === frameId));
  }

  tabFor(tabId) {
    for (const w of this.browser.browserWindows) {
      for (const t of w.tabs) {
        if (t.engineId === tabId) {
          return t;
        }
      }
    }
    return null;
  }

  describeTab(tab) {
    return {
      id: tab.engineId,
      url: tab.url,
      title: tab.title,
      status: "complete",
      incognito: false
    };
  }

  senderFor(context) {
    const sender = { url: context.url };
    if (context.tab) {
      sender.tab = this.describeTab(context.tab);
      sender.frameId = context.frameId;
    }
    return sender;
  }

  // An event of the host contexts', fired by the engine.
  // A message another extension sends this one: the first answer any host
  // context's runtime.onMessageExternal listener gives, or undefined.
  deliverExternal(message, sender) {
    return new Promise((resolve) => {
      let answered = false;
      const respond = (value) => {
        if (!answered) {
          answered = true;
          resolve(value);
        }
      };
      for (const context of this.hosts()) {
        const event = context.events["runtime.onMessageExternal"];
        for (const entry of (event ? event.list.slice() : [])) {
          entry.fn(cloneFor(entry.fn, message), cloneFor(entry.fn, sender), respond);
        }
      }
      setTimeout(() => respond(undefined), 50);
    });
  }

  emitHost(path, ...args) {
    for (const context of this.hosts()) {
      const event = context.events[path];
      for (const entry of (event ? event.list.slice() : [])) {
        entry.fn(...cloneFor(entry.fn, args));
      }
    }
  }

  // -- one-shot messages --------------------------------------------------
  dispatch(context, message, sender) {
    return new Promise((resolve) => {
      let waiting = 0;
      let settled = false;
      const respond = (value) => {
        if (!settled) {
          settled = true;
          resolve({ responded: true, value: clone(value) });
        }
      };
      const declined = () => {
        waiting -= 1;
        if (!settled && waiting === 0) {
          settled = true;
          resolve({ responded: false });
        }
      };
      for (const entry of context.onMessage.list.slice()) {
        let result;
        try {
          result = entry.fn(cloneFor(entry.fn, message), cloneFor(entry.fn, sender), respond);
        } catch (e) {
          continue;
        }
        if (result === true) {
          waiting += 1;
        } else if (result && typeof result.then === "function") {
          waiting += 1;
          result.then(respond, declined);
        }
      }
      if (!settled && waiting === 0) {
        settled = true;
        resolve({ responded: false });
      }
    });
  }

  send(from, receivers, message) {
    const listening = receivers.filter((c) => c.onMessage.hasListeners());
    return new Promise((resolve, reject) => {
      later(() => {
        if (!listening.length) {
          reject(new Error(NO_RECEIVER));
          return;
        }
        let remaining = listening.length;
        let settled = false;
        for (const receiver of listening) {
          this.dispatch(receiver, message, this.senderFor(from)).then((outcome) => {
            remaining -= 1;
            if (settled) {
              return;
            }
            if (outcome.responded) {
              settled = true;
              resolve(cloneInContext(from, outcome.value));
            } else if (remaining === 0) {
              settled = true;
              resolve(undefined);
            }
          });
        }
      });
    });
  }

  withCallback(context, promise, callback) {
    if (typeof callback !== "function") {
      return promise;
    }
    promise.then((value) => callback(value), (error) => {
      context.browser.runtime.lastError = { message: error.message };
      try {
        callback();
      } finally {
        delete context.browser.runtime.lastError;
      }
    });
    return undefined;
  }

  // -- ports ----------------------------------------------------------------
  connect(from, receivers, name) {
    const makePort = (sender) => {
      const port = {
        name: name || "",
        onMessage: makeEvent(),
        onDisconnect: makeEvent(),
        connected: true,
        postMessage: (message) => {
          if (!port.connected) {
            throw new Error("Attempting to use a disconnected port object");
          }
          port.send(clone(message));
        },
        disconnect: () => {
          if (port.connected) {
            port.connected = false;
            port.closed();
          }
        }
      };
      if (sender) {
        port.sender = sender;
      }
      return port;
    };
    const receive = (port, message) => {
      for (const entry of port.onMessage.list.slice()) {
        entry.fn(cloneFor(entry.fn, message), port);
      }
    };
    const drop = (port) => {
      if (port.connected) {
        port.connected = false;
        for (const entry of port.onDisconnect.list.slice()) {
          entry.fn(port);
        }
      }
    };

    const opener = makePort(null);
    let far = [];
    let ready = false;
    const queue = [];

    opener.send = (message) => {
      if (!ready) {
        queue.push(message);
        return;
      }
      later(() => far.filter((p) => p.connected).forEach((p) => receive(p, message)));
    };
    opener.closed = () => later(() => far.forEach(drop));

    later(() => {
      const listening = receivers.filter((c) => c.alive && c.onConnect.hasListeners());
      if (!listening.length) {
        from.browser.runtime.lastError = { message: NO_RECEIVER };
        drop(opener);
        delete from.browser.runtime.lastError;
        return;
      }
      far = listening.map((receiver) => {
        const port = makePort(this.senderFor(from));
        port.send = (message) => later(() => opener.connected && receive(opener, message));
        port.closed = () => later(() => {
          if (far.every((p) => !p.connected)) {
            drop(opener);
          }
        });
        for (const entry of receiver.onConnect.list.slice()) {
          entry.fn(port);
        }
        return port;
      });
      ready = true;
      queue.splice(0).forEach((message) => opener.send(message));
    });
    return opener;
  }

  // -- declarativeNetRequest -------------------------------------------------
  // The rules the engine keeps for the extension. Static rulesets are the ones
  // the bundle's Info.plist declares, as WebKit reads them.
  dnrState() {
    if (!this.dnr) {
      const infoPath = path.join(this.browser.bundleRoot, "Info.plist");
      const declared = fs.existsSync(infoPath)
        ? plist.read(infoPath).declarative_net_request || {} : {};
      const resources = declared.rule_resources || [];
      this.dnr = {
        resources,
        enabled: resources.filter((r) => r.enabled).map((r) => r.id),
        dynamicRules: [],
        sessionRules: []
      };
    }
    return this.dnr;
  }

  // -- requests ---------------------------------------------------------------
  // Carries one load through the webRequest events and returns what became of
  // it: whether it was cancelled or redirected, and the headers it ended with.
  async request(details, response) {
    const base = Object.assign({
      requestId: "1-" + this.nextRequestId++,
      method: "GET",
      type: "other",
      frameId: 0,
      parentFrameId: -1,
      tabId: -1,
      timeStamp: Date.now()
    }, details);
    const outcome = {
      cancel: false,
      requestHeaders: clone(base.requestHeaders) || [],
      responseHeaders: clone((response && response.responseHeaders) || [])
    };
    delete base.requestHeaders;

    const fire = async (name, extra) => {
      const verdicts = [];
      for (const context of this.hosts()) {
        const event = context.events["webRequest." + name];
        // An extension sees its own files' requests, never another's.
        if (/^safari-extension:/i.test(base.url) &&
            base.url.toLowerCase().indexOf(this.browser.baseURI.toLowerCase()) !== 0) {
          continue;
        }
        for (const entry of (event ? event.list.slice() : [])) {
          const filter = entry.filter || {};
          if (filter.urls && !filter.urls.some((p) => matchPattern(p, base.url))) {
            continue;
          }
          if (filter.types && filter.types.indexOf(base.type) < 0) {
            continue;
          }
          if (filter.tabId != null && filter.tabId !== base.tabId) {
            continue;
          }
          const seen = clone(Object.assign({}, base, extra));
          if (entry.spec.indexOf("requestHeaders") < 0) {
            delete seen.requestHeaders;
          }
          if (entry.spec.indexOf("responseHeaders") < 0) {
            delete seen.responseHeaders;
          }
          const verdict = await entry.fn(seen);
          if (entry.spec.indexOf("blocking") >= 0 && verdict) {
            verdicts.push(verdict);
            if (verdict.requestHeaders) {
              outcome.requestHeaders = clone(verdict.requestHeaders);
              extra.requestHeaders = outcome.requestHeaders;
            }
            if (verdict.responseHeaders) {
              outcome.responseHeaders = clone(verdict.responseHeaders);
              extra.responseHeaders = outcome.responseHeaders;
            }
          }
        }
      }
      if (verdicts.some((v) => v.cancel)) {
        outcome.cancel = true;
      }
      const redirect = verdicts.find((v) => v.redirectUrl);
      if (redirect && !outcome.redirectUrl) {
        outcome.redirectUrl = redirect.redirectUrl;
      }
      return !outcome.cancel && !outcome.redirectUrl;
    };

    if (!(await fire("onBeforeRequest", {}))) {
      return outcome;
    }
    if (!(await fire("onBeforeSendHeaders", { requestHeaders: outcome.requestHeaders }))) {
      return outcome;
    }
    await fire("onSendHeaders", { requestHeaders: outcome.requestHeaders });
    const answered = {
      statusCode: 200,
      statusLine: "HTTP/1.1 200 OK",
      fromCache: false,
      responseHeaders: outcome.responseHeaders
    };
    if (!(await fire("onHeadersReceived", answered))) {
      return outcome;
    }
    // A server's authentication challenge: a cancel verdict ends the load
    // with the challenge's response, and with none Safari's sheet asks.
    if (response && response.challenge) {
      const challenge = Object.assign({}, answered, { statusCode: 401, statusLine: "HTTP/1.1 401 Unauthorized",
        scheme: "basic", realm: "Realm", isProxy: false, challenger: { host: "example.com", port: 443 } });
      await fire("onAuthRequired", challenge);
      outcome.challenge = outcome.cancel ? "cancelled" : "sheet";
      outcome.cancel = false;
    }
    await fire("onResponseStarted", answered);
    await fire("onCompleted", answered);
    return outcome;
  }

  // -- the `browser` object of one context ---------------------------------
  makeBrowser(context) {
    const engine = this;
    const runtime = {
      onMessage: context.onMessage,
      onConnect: context.onConnect,
      // A message to another extension goes to `engine.answerExternal`, which
      // stands for that extension; with none, nothing receives it.
      sendMessage(...args) {
        const callback = typeof args[args.length - 1] === "function" ? args.pop() : undefined;
        if (args.length >= 2 && typeof args[0] === "string") {
          engine.externalSent.push({ to: args[0], message: clone(args[1]) });
          const answer = engine.answerExternal
            ? Promise.resolve(engine.answerExternal(args[0], clone(args[1])))
            : Promise.reject(new Error(NO_RECEIVER));
          return engine.withCallback(context, answer, callback);
        }
        const receivers = engine.hosts(context);
        return engine.withCallback(context, engine.send(context, receivers, args[0]), callback);
      },
      connect(a, b) {
        const info = typeof a === "string" ? (b || {}) : (a || {});
        if (typeof a === "string") {
          engine.externalSent.push({ to: a, port: info.name });
        }
        return engine.connect(context, engine.hosts(context), info.name);
      }
    };

    if (context.kind === "content") {
      runtime.getFrameId = (target) => {
        const found = engine.contexts.find((c) =>
          !!target && c.sandbox.location === target.location);
        if (!found) {
          throw new Error("Invalid target");
        }
        return found.frameId;
      };
      return { runtime, dom: { openOrClosedShadowRoot: () => null } };
    }

    const event = (path) => {
      context.events[path] = makeEvent();
      return context.events[path];
    };
    runtime.onMessageExternal = event("runtime.onMessageExternal");
    runtime.onConnectExternal = event("runtime.onConnectExternal");
    const api = (fn) => function (...args) {
      const callback = typeof args[args.length - 1] === "function" ? args.pop() : undefined;
      const promise = Promise.resolve().then(() => fn(...args));
      return engine.withCallback(context, promise, callback);
    };
    const framesOf = (tabId, details) => {
      if (!engine.tabFor(tabId)) {
        throw new Error("No tab with this id.");
      }
      const frames = engine.inTab(tabId, details.allFrames ? null
        : (details.frameId == null ? 0 : details.frameId));
      if (!frames.length) {
        // A page that is not on the web is one the extension cannot reach.
        const url = String(engine.tabFor(tabId).url || "");
        throw new Error(url && !/^https?:/.test(url) && details.frameId == null
          ? "The extension has no access to this frame." : "No frame with this id.");
      }
      return frames;
    };

    const tabs = {
      onCreated: event("tabs.onCreated"),
      onUpdated: event("tabs.onUpdated"),
      onRemoved: event("tabs.onRemoved"),
      // A tab ID, or a SafariBrowserTab of an open window.
      get: api((id) => {
        if (id instanceof FakeTab) {
          if (!id.browserWindow || id.browserWindow.tabs.indexOf(id) < 0 ||
              engine.browser.browserWindows.indexOf(id.browserWindow) < 0) {
            throw new TypeError("The tab is not in an open window.");
          }
          if (id.engineId === undefined) {
            throw new Error("No tab with id: undefined.");
          }
          return engine.describeTab(id);
        }
        const tab = engine.tabFor(id);
        if (!tab) {
          throw new Error("No tab with id: " + id + ".");
        }
        return engine.describeTab(tab);
      }),
      update: api((id, props) => {
        const tab = engine.tabFor(id);
        if (!tab) {
          throw new Error("No tab with this id.");
        }
        const before = engine.describeTab(tab);
        tab.navigate(props.url);
        return before;
      }),
      // Safari keeps hidden tabs in a window it never shows, after an empty
      // tab of its own, moving each tab there: it closes in its window and
      // opens in that one.
      hide: api((targets) => {
        const browser = engine.browser;
        return [].concat(targets).map((t) => {
          const tab = t instanceof FakeTab ? t : engine.tabFor(t);
          if (!tab || tab.hidden) {
            return null;
          }
          let hiddenWindow = browser.browserWindows.find((w) => w.visible === false);
          if (!hiddenWindow) {
            hiddenWindow = new FakeWindow(browser);
            hiddenWindow.visible = false;
            browser.browserWindows.push(hiddenWindow);
            browser.application.fire("open", { target: hiddenWindow, __stopped: false }, true);
            hiddenWindow.openTab();
          }
          tab.moveTo(hiddenWindow);
          tab.hidden = true;
          return tab.engineId;
        }).filter((id) => id != null);
      }),
      show: api((targets) => {
        const browser = engine.browser;
        [].concat(targets).forEach((t) => {
          const tab = t instanceof FakeTab ? t : engine.tabFor(t);
          if (tab && tab.hidden) {
            tab.hidden = false;
            tab.moveTo(browser.browserWindows.find((w) => w.visible !== false));
          }
        });
      }),
      reload: api((id) => {
        const tab = engine.tabFor(id);
        if (tab) {
          tab.reloads += 1;
        }
      }),
      remove: api((ids) => {
        for (const id of (Array.isArray(ids) ? ids : [ids])) {
          const tab = engine.tabFor(id);
          if (tab) {
            tab.close();
          }
        }
      }),
      sendMessage(tabId, message, options, callback) {
        if (typeof options === "function") {
          callback = options;
          options = {};
        }
        const frames = engine.inTab(tabId, options && options.frameId);
        return engine.withCallback(context, engine.send(context, frames, message), callback);
      },
      connect(tabId, info) {
        const i = info || {};
        return engine.connect(context, engine.inTab(tabId, i.frameId), i.name);
      },
      executeScript: api((tabId, details) => {
        const results = [];
        let failure = null;
        for (const frame of framesOf(tabId, details)) {
          if (frame.kind !== "content") {
            failure = failure || new Error("Cannot access the contents of an extension page.");
            continue;
          }
          try {
            let code = details.code;
            if (details.file) {
              code = fs.readFileSync(path.join(engine.browser.bundleRoot, details.file), "utf8");
            }
            let value;
            try {
              value = vm.runInContext(code, frame.vmContext);
            } catch (e) {
              // Code that throws gives null, and its exception goes to the
              // frame's console.
              results.push(null);
              continue;
            }
            let copied = null;
            try {
              copied = clone(value);
            } catch (e) { /* not serializable */ }
            results.push(copied === undefined ? null : copied);
          } catch (e) {
            failure = failure || e;
          }
        }
        if (!results.length) {
          throw new Error(failure ? failure.message : "No frame with this id.");
        }
        return results;
      }),
      insertCSS: api((tabId, details) => {
        for (const frame of framesOf(tabId, details)) {
          frame.sheets.push(clone(details));
        }
      }),
      removeCSS: api((tabId, details) => {
        for (const frame of framesOf(tabId, details)) {
          frame.sheets = frame.sheets.filter((sheet) =>
            sheet.code !== details.code || sheet.file !== details.file);
        }
      })
    };

    const scripting = {
      calls: [],
      executeScript: api((details) => {
        scripting.calls.push(details);
        const target = details.target;
        const frames = target.frameIds
          ? target.frameIds.reduce((all, frameId) => all.concat(framesOf(target.tabId, { frameId })), [])
          : framesOf(target.tabId, { allFrames: target.allFrames });
        return frames.map((frame) => {
          let value;
          (details.files || []).forEach((file) => {
            value = vm.runInContext(fs.readFileSync(path.join(engine.browser.bundleRoot, file), "utf8"), frame.vmContext);
          });
          if (details.func) {
            const func = vm.runInContext("(" + details.func + ")", frame.vmContext);
            value = func.apply(null, details.args || []);
          }
          return { frameId: frame.frameId, documentId: "THE-ENGINES-OWN", result: value === undefined ? undefined : clone(value) };
        });
      }),
      // The engine's registered scripts, for the page's own world only, kept
      // across the global page's restarts as the engine keeps them.
      registered: engine.registeredScripts || (engine.registeredScripts = []),
      registerContentScripts: api((scripts) => {
        for (const script of scripts) {
          if (script.world !== "MAIN") {
            throw new Error("Script with ID '" + script.id + "' must be for the \"MAIN\" world");
          }
          if (scripting.registered.some((existing) => existing.id === script.id)) {
            throw new Error("Duplicate script ID '" + script.id + "'");
          }
        }
        scripting.registered.push(...clone(scripts));
      }),
      updateContentScripts: api((scripts) => {
        for (const script of scripts) {
          const index = scripting.registered.findIndex((existing) => existing.id === script.id);
          if (index < 0) {
            throw new Error("Script with ID '" + script.id + "' does not exist or is not fully registered");
          }
          scripting.registered[index] = Object.assign({}, scripting.registered[index], clone(script));
        }
      }),
      getRegisteredContentScripts: api((filter) => clone(scripting.registered.filter((script) =>
        !(filter && filter.ids) || filter.ids.includes(script.id)))),
      unregisterContentScripts: api((filter) => {
        const ids = filter && filter.ids;
        for (const id of ids || []) {
          if (!scripting.registered.some((script) => script.id === id)) {
            throw new Error("Nonexistent script ID '" + id + "'");
          }
        }
        const kept = scripting.registered.filter((script) => ids && !ids.includes(script.id));
        scripting.registered.length = 0;
        scripting.registered.push(...kept);
      })
    };

    const webRequest = {
      MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES: 20,
      ResourceType: { MAIN_FRAME: "main_frame", SCRIPT: "script", IMAGE: "image" },
      handlerBehaviorChanged: api(() => {})
    };
    for (const name of ["onBeforeRequest", "onBeforeSendHeaders", "onSendHeaders",
      "onHeadersReceived", "onAuthRequired", "onResponseStarted", "onBeforeRedirect",
      "onCompleted", "onErrorOccurred"]) {
      webRequest[name] = event("webRequest." + name);
    }

    const webNavigation = {
      getFrame: api((details) => {
        const frame = engine.inTab(details.tabId, details.frameId)[0];
        return frame ? {
          frameId: frame.frameId,
          parentFrameId: frame.frameId ? 0 : -1,
          url: frame.url,
          errorOccurred: false
        } : null;
      }),
      getAllFrames: api((details) => {
        if (!engine.tabFor(details.tabId)) {
          return null;
        }
        return engine.inTab(details.tabId).map((frame) => ({
          frameId: frame.frameId,
          parentFrameId: frame.frameId ? 0 : -1,
          url: frame.url,
          errorOccurred: false
        }));
      })
    };
    for (const name of ["onBeforeNavigate", "onCommitted", "onDOMContentLoaded",
      "onCompleted", "onErrorOccurred", "onCreatedNavigationTarget"]) {
      webNavigation[name] = event("webNavigation." + name);
    }

    const updateRules = (list) => api((options) => {
      const state = engine.dnrState();
      const o = options || {};
      const rules = state[list].filter((rule) => (o.removeRuleIds || []).indexOf(rule.id) < 0);
      for (const rule of o.addRules || []) {
        if (rules.some((r) => r.id === rule.id)) {
          throw new Error("Rule with id " + rule.id + " does not have a unique ID.");
        }
        // The engine knows only some headers.
        const headers = [].concat((rule.action && rule.action.requestHeaders) || [],
          (rule.action && rule.action.responseHeaders) || []);
        const unknown = headers.find((entry) => entry.header.toLowerCase() === "permissions-policy");
        if (unknown) {
          throw new Error("Invalid call to declarativeNetRequest.updateDynamicRules(). The 'addRules' " +
            "value is invalid, because an error with rule at index 0: Rule with id " + rule.id +
            " is invalid. The header `" + unknown.header + "` is not recognized.");
        }
        rules.push(clone(rule));
      }
      state[list] = rules;
    });
    const declarativeNetRequest = {
      MAX_NUMBER_OF_STATIC_RULESETS: 100,
      MAX_NUMBER_OF_ENABLED_STATIC_RULESETS: 50,
      MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES: 30000,
      updateDynamicRules: updateRules("dynamicRules"),
      getDynamicRules: api(() => clone(engine.dnrState().dynamicRules)),
      updateSessionRules: updateRules("sessionRules"),
      getSessionRules: api(() => clone(engine.dnrState().sessionRules)),
      updateEnabledRulesets: api((options) => {
        const state = engine.dnrState();
        const o = options || {};
        const ids = (o.disableRulesetIds || []).concat(o.enableRulesetIds || []);
        for (const id of ids) {
          if (!state.resources.some((r) => r.id === id)) {
            throw new Error("Invalid ruleset id: " + id + ".");
          }
        }
        const enabled = state.enabled.filter((id) =>
          (o.disableRulesetIds || []).indexOf(id) < 0);
        for (const id of o.enableRulesetIds || []) {
          if (enabled.indexOf(id) < 0) {
            enabled.push(id);
          }
        }
        state.enabled = enabled;
      }),
      getEnabledRulesets: api(() => engine.dnrState().enabled.slice()),
      getMatchedRules: api(() => ({ rulesMatchedInfo: [] })),
      isRegexSupported: api((options) => {
        try {
          new RegExp(options.regex);
          return { isSupported: true };
        } catch (e) {
          return { isSupported: false, reason: "syntaxError" };
        }
      }),
      setExtensionActionOptions: api(() => {})
    };

    const sameCookie = (cookie, details) => cookie.name === details.name &&
      (!details.url || details.url.indexOf(cookie.domain) >= 0);
    const cookies = {
      onChanged: event("cookies.onChanged"),
      get: api((details) => engine.cookies.find((c) => sameCookie(c, details)) || null),
      getAll: api((details) => engine.cookies.filter((c) =>
        (!details.name || c.name === details.name) &&
        (!details.url || details.url.indexOf(c.domain) >= 0))),
      set: api((details) => {
        const cookie = {
          name: details.name,
          value: details.value || "",
          domain: details.domain || details.url.split("/")[2],
          hostOnly: !details.domain,
          path: details.path || "/",
          secure: !!details.secure,
          httpOnly: !!details.httpOnly,
          sameSite: details.sameSite || "no_restriction",
          session: details.expirationDate == null,
          storeId: "0"
        };
        engine.cookies = engine.cookies.filter((c) => !sameCookie(c, details));
        engine.cookies.push(cookie);
        engine.emitHost("cookies.onChanged", { removed: false, cookie, cause: "explicit" });
        return cookie;
      }),
      remove: api((details) => {
        const found = engine.cookies.find((c) => sameCookie(c, details));
        engine.cookies = engine.cookies.filter((c) => c !== found);
        return found ? { url: details.url, name: details.name, storeId: "0" } : null;
      }),
      // The one store, which every open tab uses.
      getAllCookieStores: api(() => [{ id: "0",
        tabIds: [].concat(...engine.browser.browserWindows.map((w) => w.tabs.map((t) => t.engineId))) }])
    };

    // The two privacy settings the engine controls.
    const setting = (initial) => {
      let value = initial;
      return {
        get: api(() => ({ value, levelOfControl: "controllable_by_this_extension" })),
        set: api((details) => { value = details.value; }),
        clear: api(() => { value = initial; }),
        onChange: { addListener() {}, removeListener() {}, hasListener() { return false; } }
      };
    };
    const privacy = {
      network: { networkPredictionEnabled: setting(true) },
      websites: { hyperlinkAuditingEnabled: setting(true) }
    };
    return { runtime, tabs, scripting, webRequest, declarativeNetRequest, webNavigation, cookies, privacy };
  }
}

// ------------------------------------------------------------------ //
// Browser model
// ------------------------------------------------------------------ //
class FakeTab {
  // A pageless tab shows no page of WebKit's until showPage.
  constructor(browser, browserWindow, url, pageless) {
    this.browser = browser;
    this.browserWindow = browserWindow;
    this.url = url === undefined ? "about:blank" : url;
    this.title = "";
    this.private = false;
    this.reloads = 0;
    this.engineId = pageless ? undefined : browser.engine.nextTabId++;
  }
  showPage() {
    this.engineId = this.browser.engine.nextTabId++;
    later(() => this.browser.engine.emitHost("tabs.onCreated", this.browser.engine.describeTab(this)));
  }
  // Another page in place of the tab's, as Safari swaps in a preloaded one.
  replacePage() {
    const old = this.engineId;
    this.showPage();
    later(() => this.browser.engine.emitHost("tabs.onRemoved", old, { windowId: -1, isWindowClosing: false }));
  }
  get url() { return this._url; }
  set url(value) {
    this._url = String(value).replace(/^(safari-extension:\/\/)([^/]+)/i,
      (_, scheme, host) => scheme + host.toLowerCase());
    if (this.engineId !== undefined && /^about:blank(#|$)/.test(this._url)) {
      const marker = this._url;
      later(() => this.browser.engine.emitHost("tabs.onUpdated", this.engineId,
        { url: marker }, this.browser.engine.describeTab(this)));
    }
  }
  // Safari's screenshot of the tab: a PNG naming the page it shows.
  visibleContentsAsDataURL(callback) {
    later(() => callback("data:image/png;base64," + Buffer.from(this.url).toString("base64")));
  }
  activate() {
    this.browserWindow.activeTab = this;
    this.browser.application.fire("activate", { target: this, __stopped: false }, true);
  }
  // Safari's move of a tab to another window.
  moveTo(target) {
    const from = this.browserWindow;
    from.tabs.splice(from.tabs.indexOf(this), 1);
    if (from.activeTab === this) {
      from.activeTab = from.tabs[0] || null;
    }
    this.browser.application.fire("close", { target: this, __stopped: false }, true);
    target.tabs.push(this);
    this.browserWindow = target;
    this.browser.application.fire("open", { target: this, __stopped: false }, true);
    from.closeIfOnlyHolding();
  }
  close() {
    const i = this.browserWindow.tabs.indexOf(this);
    if (i >= 0) {
      this.browserWindow.tabs.splice(i, 1);
    }
    later(() => this.browserWindow.closeIfOnlyHolding());
    for (const context of this.browser.engine.inTab(this.engineId)) {
      context.alive = false;
    }
    this.browser.application.fire("close", { target: this, __stopped: false }, true);
    if (this.engineId !== undefined) {
      this.browser.engine.emitHost("tabs.onRemoved", this.engineId,
        { windowId: -1, isWindowClosing: false });
    }
  }
  // A load of another document, as the engine reports one.
  navigate(url) {
    const engine = this.browser.engine;
    this._url = url;
    // WebKit swaps in a new page for an extension's.
    const saver = /\/wex\/wex-download\.html\?(.+)$/.exec(url);
    if (saver) {
      this.replacePage();
      this.browser.runDownloadPage(saver[1], this);
    }
    const details = {
      tabId: this.engineId,
      frameId: 0,
      parentFrameId: -1,
      url,
      processId: -1,
      timeStamp: Date.now()
    };
    const loading = Object.assign(engine.describeTab(this), { status: "loading" });
    engine.emitHost("webNavigation.onBeforeNavigate", details);
    engine.emitHost("tabs.onUpdated", this.engineId, { status: "loading" }, loading);
    engine.emitHost("tabs.onUpdated", this.engineId, { url }, loading);
    engine.emitHost("webNavigation.onCommitted", Object.assign({
      transitionType: "link", transitionQualifiers: []
    }, details));
    engine.emitHost("webNavigation.onDOMContentLoaded", details);
    engine.emitHost("tabs.onUpdated", this.engineId, { status: "complete" },
      engine.describeTab(this));
    engine.emitHost("webNavigation.onCompleted", details);
  }
}

class FakeWindow {
  constructor(browser) {
    this.browser = browser;
    this.tabs = [];
    this.activeTab = null;
  }
  openTab(visibility, index, options) {
    // Safari's new tab has an empty address.
    const tab = new FakeTab(this.browser, this, "", !!(options && options.pageless));
    if (typeof index === "number") {
      this.tabs.splice(index, 0, tab);
    } else {
      this.tabs.push(tab);
    }
    if (!this.activeTab || visibility === "foreground") {
      this.activeTab = tab;
    }
    this.browser.application.fire("open", { target: tab, __stopped: false }, true);
    if (tab.engineId !== undefined) {
      later(() => this.browser.engine.emitHost("tabs.onCreated",
        this.browser.engine.describeTab(tab)));
    }
    return tab;
  }
  // A window of hidden tabs closes once it holds only its empty tab.
  closeIfOnlyHolding() {
    if (this.visible === false && this.tabs.length === 1 && this.browser.browserWindows.indexOf(this) >= 0) {
      this.tabs[0].close();
      this.close();
    }
  }
    insertTab(tab, index) {
    // As Safari does: the tab goes before the one at `index`, counting itself.
    const from = tab.browserWindow.tabs;
    const at = from.indexOf(tab);
    from.splice(at, 1);
    this.tabs.splice(from === this.tabs && at < index ? index - 1 : index, 0, tab);
    tab.browserWindow = this;
    return tab;
  }
  activate() {
    const list = this.browser.browserWindows;
    list.splice(list.indexOf(this), 1);
    list.unshift(this);
    this.browser.application.fire("activate", { target: this, __stopped: false }, true);
  }
  close() {
    const i = this.browser.browserWindows.indexOf(this);
    if (i >= 0) {
      this.browser.browserWindows.splice(i, 1);
    }
    this.browser.application.fire("close", { target: this, __stopped: false }, true);
  }
}

// ------------------------------------------------------------------ //
// The browser as a whole
// ------------------------------------------------------------------ //
// Safari's speech synthesis: one voice, and speech that takes no time, each
// utterance starting, passing its first word and ending in turn.
class FakeSpeech {
  constructor() {
    this.queue = [];
    this.spoken = [];
    this.speaking = false;
  }
  getVoices() {
    return [{ name: "Alex", lang: "en-US", localService: true }];
  }
  addEventListener() {}
  speak(utterance) {
    this.queue.push(utterance);
    this.spoken.push({ text: utterance.text, rate: utterance.rate, voice: utterance.voice && utterance.voice.name });
    if (this.queue.length === 1) {
      this.next();
    }
  }
  next() {
    const u = this.queue[0];
    if (!u) {
      this.speaking = false;
      return;
    }
    this.speaking = true;
    later(() => {
      if (this.queue[0] !== u) {
        return;
      }
      if (u.onstart) u.onstart({});
      if (u.onboundary) u.onboundary({ name: "word", charIndex: 0, charLength: u.text.split(" ")[0].length });
      later(() => {
        if (this.queue[0] !== u) {
          return;
        }
        this.queue.shift();
        if (u.onend) u.onend({});
        this.next();
      });
    });
  }
  cancel() {
    const all = this.queue.splice(0);
    this.speaking = false;
    all.forEach((u, i) => u.onerror && u.onerror({ error: i === 0 ? "interrupted" : "canceled" }));
  }
  pause() {}
  resume() {}
}

// FileReader, over the Blob of Node.
class FakeFileReader {
  read(blob, encode) {
    blob.arrayBuffer().then((buffer) => {
      this.result = encode(buffer);
      if (this.onload) {
        this.onload();
      }
    }, (error) => {
      this.error = error;
      if (this.onerror) {
        this.onerror();
      }
    });
  }
  readAsArrayBuffer(blob) {
    this.read(blob, (buffer) => buffer);
  }
  readAsDataURL(blob) {
    this.read(blob, (buffer) => "data:" + (blob.type || "application/octet-stream") + ";base64," +
      Buffer.from(buffer).toString("base64"));
  }
}

// The native menu objects legacy Safari extensions attach to toolbar items.
// Menu items keep the command Safari reports when one is chosen, and can
// themselves carry another menu as a submenu.
class FakeExtensionMenu {
  constructor(identifier) {
    this.identifier = identifier;
    this.menuItems = [];
    this.visible = false;
  }
  appendMenuItem(identifier, title, command) {
    const item = {
      identifier,
      title,
      command: command || identifier,
      separator: false,
      submenu: null,
      disabled: false,
      checkedState: 0,
      visible: false
    };
    this.menuItems = this.menuItems.filter((entry) => entry.identifier !== identifier);
    this.menuItems.push(item);
    return item;
  }
  appendSeparator(identifier) {
    const item = {
      identifier,
      separator: true,
      submenu: null,
      disabled: false,
      checkedState: 0,
      visible: false
    };
    this.menuItems = this.menuItems.filter((entry) => entry.identifier !== identifier);
    this.menuItems.push(item);
    return item;
  }
  removeMenuItem(index) {
    if (index >= 0 && index < this.menuItems.length) {
      this.menuItems.splice(index, 1);
    }
  }
  hide() {
    this.visible = false;
  }
}

class FakeBrowser {
  constructor(bundleRoot, options) {
    options = options || {};
    this.bundleRoot = bundleRoot;
    this.bundleId = options.bundleId || "com.example.test";
    // A real base URI carries a per-session token in its path; keeping one
    // here is what exercises the URL resolution that has to cope with it.
    this.baseURI = "safari-extension://" + this.bundleId + "/AB12CD34/";
    // The web Notification API: each notification posted, until it closes.
    const posted = this.notifications = [];
    this.NotificationClass = class Notification {
      constructor(title, options) {
        Object.assign(this, { title, body: options.body, tag: options.tag, closed: false });
        posted.push(this);
        later(() => this.onshow && this.onshow());
      }
      close() {
        if (!this.closed) {
          this.closed = true;
          later(() => this.onclose && this.onclose());
        }
      }
    };
    this.NotificationClass.permission = "granted";
    this.NotificationClass.requestPermission = (cb) => cb(this.NotificationClass.permission);
    this.webResponses = {};
    this.webRequests = [];
    this.savedDownloads = [];
    this.refuseDownloads = false;
    this.engine = new Engine(this);
    this.application = new Emitter();
    this.browserWindows = [];
    this.settings = new KeyStore();
    this.secureSettings = new KeyStore();
    this.popover = {
      identifier: "wex-popover",
      contentURL: "",
      contentWindow: null,
      width: 400,
      height: 560,
      visible: false,
      hide: () => {
        this.popover.visible = false;
      }
    };
    this.popovers = options.popup === false ? [] : [this.popover];
    this.menus = [];
    const browser = this;
    this.toolbarItems = [{
      identifier: "wex-toolbar",
      image: "",
      badge: 0,
      toolTip: "",
      disabled: false,
      command: options.popup === false ? "wex-action" : null,
      menu: null,
      popover: options.popup === false ? null : this.popover,
      get browserWindow() {
        return browser.activeBrowserWindow;
      },
      showPopover() {
        (this.popover || browser.popover).visible = true;
      },
      showMenu() {
        if (this.menu) this.menu.visible = true;
      }
    }];
    this.contentScripts = [];
    this.globalPageContext = null;
  }

  openWindow() {
    const w = new FakeWindow(this);
    this.browserWindows.push(w);
    this.application.fire("open", { target: w, __stopped: false }, true);
    return w;
  }

  get activeBrowserWindow() {
    return this.browserWindows[0] || null;
  }

  // What safari.extension is in the global page and the popover.
  extensionObject() {
    const browser = this;
    const add = (kind) => (source, whitelist, blacklist, atEnd) => {
      // Safari's handles are unique for as long as it runs.
      this.addedScripts = (this.addedScripts || 0) + 1;
      const url = this.baseURI + "added-" + this.addedScripts;
      this.contentScripts.push({ kind, url, source, whitelist, blacklist, atEnd });
      return url;
    };
    const remove = (url) => {
      this.contentScripts = this.contentScripts.filter((entry) => entry.url !== url);
    };
    return {
      baseURI: this.baseURI,
      settings: this.settings,
      secureSettings: this.secureSettings,
      toolbarItems: this.toolbarItems,
      get menus() {
        return browser.menus;
      },
      get popovers() {
        return browser.popovers;
      },
      get globalPage() {
        return { contentWindow: browser.globalPageContext };
      },
      // Each identifier has a popover of its own; the extension's popup one
      // is the browser's `popover`.
      createPopover: (identifier, url, width, height) => {
        let po = identifier === this.popover.identifier || this.popovers.length === 0 ? this.popover : null;
        if (!po) {
          po = { identifier, contentURL: "", contentWindow: null, width, height, visible: false,
            hide() { po.visible = false; } };
        }
        po.identifier = identifier;
        po.contentURL = url;
        po.width = width;
        po.height = height;
        this.popovers = this.popovers.filter((p) => p.identifier !== identifier).concat([po]);
        return po;
      },
      createMenu: (identifier) => {
        const menu = new FakeExtensionMenu(identifier);
        this.menus = this.menus.filter((entry) => entry.identifier !== identifier).concat([menu]);
        return menu;
      },
      removeMenu: (identifier) => {
        this.menus = this.menus.filter((entry) => entry.identifier !== identifier);
      },
      addContentScript: add("script"),
      addContentStyleSheet: add("sheet"),
      removeContentScript: remove,
      removeContentStyleSheet: remove
    };
  }

  // The runtime's download page, as the tab it opens would run it: it saves
  // what it is sent into savedDownloads, or refuses it while
  // refuseDownloads is set.
  runDownloadPage(token, tab) {
    const channel = new BroadcastChannel("wex-downloads");
    channel.onmessage = (e) => {
      const m = e.data || {};
      if (m.token !== token || !m.bytes) {
        return;
      }
      if (this.refuseDownloads) {
        channel.postMessage({ token, failed: "refused" });
      } else {
        this.savedDownloads.push({ filename: m.filename, type: m.type, text: Buffer.from(m.bytes).toString() });
        channel.postMessage({ token, saved: true });
      }
      channel.close();
    };
    const sender = { url: tab.url, tab: this.engine.describeTab(tab), frameId: 0 };
    later(() => Promise.all(this.engine.hosts().map((host) =>
      this.engine.dispatch(host, { __wex: "runtimePage", token }, sender)))
      .then(() => channel.postMessage({ token, ready: true })));
  }

  // -- reading bundle files, for the shim's synchronous XHR ------------
  // A file of the bundle as bytes, or null.
  readBundleBytes(url) {
    const prefix = this.baseURI;
    const root = "safari-extension://" + this.bundleId + "/";
    const relative = url.startsWith(prefix) ? url.slice(prefix.length)
      : url.startsWith(root) ? url.slice(root.length) : null;
    if (relative === null) {
      return null;
    }
    try {
      return new Uint8Array(fs.readFileSync(path.join(this.bundleRoot, relative.split(/[?#]/)[0])));
    } catch (e) {
      return null;
    }
  }

  readBundleFile(url) {
    const prefix = this.baseURI;
    let relative;
    if (url.startsWith(prefix)) {
      relative = url.slice(prefix.length);
    } else if (url.startsWith("safari-extension://" + this.bundleId + "/")) {
      relative = url.slice(("safari-extension://" + this.bundleId + "/").length);
    } else {
      return null;
    }
    const full = path.join(this.bundleRoot, relative);
    try {
      return fs.readFileSync(full, "utf8");
    } catch (e) {
      return null;
    }
  }

  // -- shared pieces of every context's global object -----------------
  baseGlobals(label) {
    const browser = this;
    const worldNavigator = navigatorClass();
    // The extension's pages share its localStorage, wherever they show; a
    // content script has the web page's.
    const store = label === "content" ? new KeyStore()
      : (this.extensionStore || (this.extensionStore = new KeyStore()));

    // An XMLHttpRequest is an EventTarget.
    class XMLHttpRequestStub extends EventTarget {
      constructor() {
        super();
        this.status = 200;
        this.responseText = "";
      }
    }
    XMLHttpRequestStub.prototype.open = function (method, url) {
      this._method = String(method || "GET").toUpperCase();
      this._url = url;
      this._address = resolved(url);
    };
    XMLHttpRequestStub.prototype.send = function () {
      const text = browser.readBundleFile(this._address);
      if (text == null) {
        this.status = 404;
        this.responseText = "";
      } else {
        this.status = 200;
        this.responseText = text;
      }
      if (this.onload) {
        this.onload();
      }
    };

    // Safari 7 serves the extension's own files with status 0 whether or not
    // the load succeeded, and fails a missing one as a network error.
    // A relative address resolves against the page's, as a browser resolves it.
    function resolved(address) {
      const base = globals && globals.location && globals.location.href;
      try {
        return base ? new URL(String(address), String(base)).href : String(address);
      } catch (e) {
        return String(address);
      }
    }
    function fetchStub(input, init) {
      const url = resolved(typeof input === "string" ? input : input.url);
      // The web, as the test describes it in webResponses.
      const canned = browser.webResponses[url];
      if (canned) {
        browser.webRequests.push({ url, init: init || {} });
        if (canned.fail) {
          return Promise.reject(new TypeError("Load failed"));
        }
        const response = new Response(typeof canned.body === "function" ? canned.body() : canned.body,
          { status: canned.status || 200, headers: canned.headers || {} });
        Object.defineProperty(response, "url", { value: canned.finalUrl || url });
        return Promise.resolve(response);
      }
      if (/^data:/i.test(url)) {
        return fetch(url);
      }
      const bytes = browser.readBundleBytes(url);
      if (bytes == null) {
        return Promise.reject(new TypeError("Load failed"));
      }
      const text = new TextDecoder().decode(bytes);
      return Promise.resolve({
        status: 0,
        ok: false,
        type: "basic",
        url,
        headers: new Headers(),
        arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
      });
    }

    const documentStub = makeDocumentStub(label);
    documentStub.__onDownloadLink = (link) => {
      const saved = { filename: link.download, via: label, text: null };
      browser.savedDownloads.push(saved);
      const blob = require("buffer").resolveObjectURL(String(link.href));
      if (blob) {
        blob.text().then((text) => {
          saved.text = text;
        });
      }
    };
    const windowListeners = [];
    // An inline script element runs as it is inserted, in the page's global
    // scope; what it throws is reported as an error event on the window.
    documentStub.__runScript = (code) => {
      try {
        vm.runInContext(code, documentStub.__context);
      } catch (error) {
        const event = {
          type: "error", error, message: String(error && error.message),
          preventDefault() {}
        };
        for (const entry of windowListeners.slice()) {
          if (entry.name === "error") {
            entry.fn(event);
          }
        }
      }
    };

    const globals = {
      console: makeConsole(label),
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      XMLHttpRequest: XMLHttpRequestStub,
      fetch: fetchStub,
      Response,
      Headers,
      Blob,
      FileReader: FakeFileReader,
      BroadcastChannel,
      AbortController,
      EventTarget,
      MessageEvent,
      Location: class Location {},
      // What every page has of the platform, as Node has it too.
      URLSearchParams,
      queueMicrotask,
      Request,
      ReadableStream,
      AbortSignal,
      crypto: globalThis.crypto,
      performance: globalThis.performance,
      DOMException,
      structuredClone,
      indexedDB: label === "content" ? undefined
        : (this.extensionDatabase || (this.extensionDatabase = new FakeIndexedDB())),
      IDBKeyRange: { bound: (lower, upper) => ({ lower, upper }) },
      Navigator: worldNavigator,
      navigator: new worldNavigator(),
      FormData,
      WebSocket: globalThis.WebSocket,
      HTMLDocument: class HTMLDocument {},
      document: documentStub,
      Notification: label === "global" ? browser.NotificationClass : undefined,
      addEventListener: (name, fn) => {
        windowListeners.push({ name, fn });
      },
      removeEventListener: (name, fn) => {
        const i = windowListeners.findIndex((entry) => entry.name === name && entry.fn === fn);
        if (i >= 0) {
          windowListeners.splice(i, 1);
        }
      },
      // A window's own listeners and its on<type> handler hear an event
      // dispatched on it.
      dispatchEvent(event) {
        windowListeners.filter((entry) => entry.name === event.type).forEach((entry) => entry.fn(event));
        if (typeof this["on" + event.type] === "function") {
          this["on" + event.type](event);
        }
        return documentStub.dispatchEvent(event);
      },
      MessageChannel,
      MouseEvent: class MouseEvent {
        constructor(type, init) {
          Object.assign(this, init || {});
          this.type = type;
          this.isTrusted = false;
        }
      },
      // Enough of the DOM's globals that an extension's own scripts get far
      // enough to exercise the bridge, rather than dying on a missing name
      // that a real browser would have supplied.
      XMLDocument: class XMLDocument {},
      Node: class Node {},
      Element: class Element {},
      HTMLElement: class HTMLElement {},
      DocumentFragment: class DocumentFragment {},
      MutationObserver: class MutationObserver {
        observe() {}
        disconnect() {}
        takeRecords() {
          return [];
        }
      },
      // The platform's events, which its EventTarget dispatches, marking
      // one stopped for the fake document.
      CustomEvent: class extends CustomEvent {
        stopImmediatePropagation() {
          this.__stopped = true;
          super.stopImmediatePropagation();
        }
      },
      Event: class extends Event {
        stopImmediatePropagation() {
          this.__stopped = true;
          super.stopImmediatePropagation();
        }
      },
      // Binary and URL machinery the runtime's fallbacks build on. A real
      // browser has these; the harness borrows Node's.
      Blob,
      btoa,
      atob,
      File: typeof File !== "undefined" ? File : undefined,
      TextEncoder,
      TextDecoder,
      URL,
      Uint8Array,
      ArrayBuffer,
      Promise,
      getComputedStyle: () => ({ getPropertyValue: () => "" }),
      matchMedia: () => ({ matches: false, addListener() {}, removeListener() {} })
    };
    // A frame's `parent` and `top` are itself unless the caller says otherwise.
    globals.parent = globals;
    globals.frames = [];
    // A window's localStorage is a getter of its own, as WebKit gives it.
    Object.defineProperty(globals, "localStorage", { configurable: true, enumerable: true, get: () => store });
    return globals;
  }

  run(sandbox, scripts) {
    const context = vm.createContext(sandbox);
    const doc = sandbox.document;
    if (doc) {
      doc.__context = context;
      // The document's address is the page's.
      const href = sandbox.location && sandbox.location.href;
      if (href && doc.URL === undefined) {
        doc.URL = doc.documentURI = doc.baseURI = String(href);
      }
    }
    for (const file of scripts) {
      // While a script of the bundle runs, it is the document's current script.
      const relative = path.relative(this.bundleRoot, file);
      if (doc) {
        doc.currentScript = relative.startsWith("..") ? null :
          { tagName: "SCRIPT", nodeName: "SCRIPT", src: this.baseURI + relative.split(path.sep).join("/") };
      }
      try {
        vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
      } finally {
        if (doc) {
          doc.currentScript = null;
        }
      }
    }
    return context;
  }

  // -- the global page ------------------------------------------------
  createGlobalPage(scripts) {
    const browser = this;
    const sandbox = this.baseGlobals("global");
    const url = this.baseURI + (this.globalPagePath || "wex-global-page.html");
    sandbox.location = pageLocation(sandbox, url, { reload: () => {} });
    sandbox.safari = {
      extension: this.extensionObject(),
      application: {
        addEventListener: (name, fn, useCapture) =>
          this.application.addEventListener(name, fn, useCapture),
        removeEventListener: (name, fn, useCapture) =>
          this.application.removeEventListener(name, fn, useCapture),
        get browserWindows() {
          return browser.browserWindows;
        },
        get activeBrowserWindow() {
          return browser.activeBrowserWindow;
        },
        openBrowserWindow: () => {
          const w = this.openWindow();
          w.openTab("foreground");
          return w;
        }
      }
    };
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    sandbox.global = sandbox;
    this.speech = this.speech || new FakeSpeech();
    sandbox.speechSynthesis = this.speech;
    sandbox.SpeechSynthesisUtterance = function (text) {
      this.text = text;
    };
    sandbox.browser = this.engine.addContext("host", { url, sandbox }).browser;
    // WebKit's `aqua`, when a test gives one.
    if (this.aqua) {
      sandbox.aqua = this.aqua;
    }

    this.globalPageContext = sandbox;
    this.run(sandbox, scripts);
    return sandbox;
  }

  // -- an extension page in the popover ----------------------------------
  createExtensionPage(scripts, url) {
    const sandbox = this.baseGlobals("page");
    sandbox.location = pageLocation(sandbox, url);
    sandbox.safari = {
      extension: this.extensionObject(),
      self: this.popover,
      application: {
        addEventListener: (name, fn, useCapture) =>
          this.application.addEventListener(name, fn, useCapture)
      }
    };
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    sandbox.close = () => {};
    sandbox.browser = this.engine.addContext("host", { url, sandbox }).browser;

    this.popover.contentWindow = sandbox;
    this.run(sandbox, scripts);
    return sandbox;
  }

  // -- an extension page in a tab -----------------------------------------
  // It runs in a web content process: the engine gives it `browser`, and
  // Safari gives it a tab proxy and no way to the global page.
  createTabPage(tab, scripts, url) {
    const sandbox = this.baseGlobals("tab page");
    tab._url = url;
    sandbox.location = pageLocation(sandbox, url);
    sandbox.safari = {
      extension: { baseURI: this.baseURI },
      self: {
        tab: {
          dispatchMessage: (name, message) => {
            this.application.fire("message", { name, message, target: tab, __stopped: false });
          },
          // Safari's synchronous message: the global page's listeners may
          // replace the message, which is the answer. Safari finds the page's
          // `safari` when the call runs, and answers nothing without it.
          canLoad: (event, message) => {
            if (!event || event.type !== "beforeload") {
              throw new TypeError("The first argument must be a beforeLoad event object.");
            }
            if (!("safari" in sandbox)) {
              return undefined;
            }
            const delivered = {
              name: "canLoad", message: structuredClone(message), target: tab, __stopped: false
            };
            this.application.fire("message", delivered);
            return structuredClone(delivered.message);
          }
        }
      }
    };
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    sandbox.top = sandbox;
    sandbox.close = () => {};
    const context = this.engine.addContext("host", { url, sandbox, tab, frameId: 0 });
    sandbox.browser = context.browser;

    this.run(sandbox, scripts);
    return sandbox;
  }

  // -- a content script world -----------------------------------------
  createContentFrame(tab, scripts, options) {
    options = options || {};
    const isTop = options.isTop !== false;
    const sandbox = this.baseGlobals("content");
    const pageUrl = options.url || tab.url;
    sandbox.location = {
      href: pageUrl,
      protocol: pageUrl.split(":")[0] + ":",
      origin: pageUrl.split("/").slice(0, 3).join("/"),
      hostname: (pageUrl.split("/")[2] || "").split(":")[0],
      reload: () => {}
    };
    if (options.ancestorOrigins) {
      sandbox.location.ancestorOrigins = options.ancestorOrigins.slice();
    }

    sandbox.closed = false;
    sandbox.safari = {
      extension: { baseURI: this.baseURI },
      self: {
        tab: {
          dispatchMessage: (name, message) => {
            this.application.fire("message", { name, message, target: tab, __stopped: false });
          },
          setContextMenuEventUserInfo: (event, info) => {
            this.pendingUserInfo = info;
          }
        }
      }
    };
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    sandbox.top = isTop ? sandbox : { __isTop: true };
    if (options.noSafariInFrame) {
      sandbox.top.safari = sandbox.safari;
      delete sandbox.safari;
    }

    const context = this.engine.addContext("content", {
      url: pageUrl,
      sandbox,
      tab,
      frameId: isTop ? 0 : this.engine.nextFrameId++,
      sheets: []
    });
    sandbox.browser = context.browser;
    context.vmContext = this.run(sandbox, scripts);

    return { sandbox, context, frameId: context.frameId };
  }
}

// ------------------------------------------------------------------ //
// Minimal DOM
// ------------------------------------------------------------------ //
function makeDocumentStub(label) {
  const listeners = [];
  const elements = [];
  const runScript = {};

  // A canvas's 2D context, which draws nothing: its pixels stay clear.
  function canvasContext(canvas) {
    const pixels = (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(Math.max(0, w * h * 4)) });
    const known = {
      canvas,
      getImageData: (x, y, w, h) => pixels(w, h),
      createImageData: (w, h) => pixels(typeof w === "object" ? w.width : w, typeof w === "object" ? w.height : h),
      measureText: (text) => ({ width: String(text).length * 6 })
    };
    return new Proxy(known, {
      get: (target, name) => name in target ? target[name] : () => {},
      set: (target, name, value) => { target[name] = value; return true; }
    });
  }

  function makeElement(tag) {
    if (String(tag).toLowerCase() === "canvas") {
      const canvas = Object.assign(makeElement("canvas-element"), { tagName: "CANVAS", nodeName: "CANVAS",
        width: 300, height: 150, toDataURL: () => "data:image/png;base64,",
        toBlob: (callback) => setTimeout(() => callback(new Blob([], { type: "image/png" })), 0) });
      canvas.getContext = (type) => type === "2d" ? (canvas.__context || (canvas.__context = canvasContext(canvas))) : null;
      return canvas;
    }
    return {
      tagName: String(tag).toUpperCase(),
      nodeName: String(tag).toUpperCase(),
      style: { cssText: "" },
      textContent: "",
      classList: (() => {
        const names = new Set();
        return { add: (...n) => n.forEach((x) => names.add(x)), remove: (...n) => n.forEach((x) => names.delete(x)),
                 contains: (x) => names.has(x), toggle: (x) => (names.has(x) ? (names.delete(x), false) : (names.add(x), true)) };
      })(),
      attributes: {},
      children: [],
      parentNode: null,
      setAttribute(k, v) {
        this.attributes[k] = String(v);
      },
      getAttribute(k) {
        return k in this.attributes ? this.attributes[k] : null;
      },
      removeAttribute(k) {
        delete this.attributes[k];
      },
      // A link with a download attribute saves what it points to.
      click() {
        if (this.download && runScript.document && runScript.document.__onDownloadLink) {
          runScript.document.__onDownloadLink(this);
        }
      },
      hasAttribute(k) {
        return k in this.attributes;
      },
      appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        if (child.tagName === "SCRIPT" && child.textContent && runScript.document &&
            runScript.document.__context) {
          runScript.document.__runScript(child.textContent);
        }
        return child;
      },
      insertBefore(child) {
        child.parentNode = this;
        this.children.unshift(child);
        return child;
      },
      removeChild(child) {
        const i = this.children.indexOf(child);
        if (i >= 0) {
          this.children.splice(i, 1);
        }
        child.parentNode = null;
        return child;
      },
      remove() {
        if (this.parentNode) {
          this.parentNode.removeChild(this);
        }
      },
      closest() {
        return null;
      },
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
      addEventListener() {},
      removeEventListener() {},
      getBoundingClientRect() {
        return { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 };
      },
      get firstChild() {
        return this.children[0] || null;
      }
    };
  }

  const documentElement = makeElement("html");
  const head = makeElement("head");
  const body = makeElement("body");
  documentElement.appendChild(head);
  documentElement.appendChild(body);

  runScript.document = {
    label,
    readyState: "complete",
    hidden: false,
    cookie: "",
    documentElement,
    head,
    body,
    createElement: (tag) => {
      const el = makeElement(tag);
      elements.push(el);
      return el;
    },
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementsByTagName: () => [],
    createTextNode: (text) => ({ nodeType: 3, textContent: text }),
    createEvent: () => ({
      initEvent(type) {
        this.type = type;
      }
    }),
    createDocumentFragment: () => makeElement("fragment"),
    addEventListener: (name, fn, capture) => {
      listeners.push({ name, fn, capture });
    },
    removeEventListener: () => {},
    dispatchEvent: (event) => {
      for (const entry of listeners.slice()) {
        if (entry.name === event.type && !event.__stopped) {
          entry.fn(event);
        }
      }
      return !event.defaultPrevented;
    },
    __listeners: listeners,
    __elements: elements
  };
  return runScript.document;
}

function makeConsole(label) {
  const prefix = "[" + label + "]";
  const quiet = (...args) => process.env.WEX_VERBOSE && console.log(prefix, ...args);
  const counts = {};
  return {
    log: quiet,
    debug: quiet,
    info: quiet,
    trace: quiet,
    dir: quiet,
    table: quiet,
    group: quiet,
    groupCollapsed: quiet,
    groupEnd: () => {},
    time: () => {},
    timeEnd: () => {},
    timeLog: () => {},
    count: (name = "default") => quiet(name + ": " + (counts[name] = (counts[name] || 0) + 1)),
    countReset: (name = "default") => { delete counts[name]; },
    assert: (ok, ...args) => { if (!ok) quiet("Assertion failed:", ...args); },
    warn: (...args) => process.env.WEX_VERBOSE && console.warn(prefix, ...args),
    error: (...args) => console.error(prefix, ...args)
  };
}

module.exports = { FakeBrowser, KeyStore };
