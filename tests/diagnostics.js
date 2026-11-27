// Exercises the diagnostic client without Safari, UI automation, or real timers.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const source = fs.readFileSync(path.join(__dirname, "../diagnostics/client.js"), "utf8")
  .replace("__ENDPOINT__", JSON.stringify("http://127.0.0.1:8765/test-token"));

function host(replies, offline = false) {
  const timers = new Map();
  const listeners = new Map();
  const requests = [];
  let nextTimer = 0;
  let active = 0;
  let peak = 0;
  const sandbox = {
    location: {href: "safari-extension://example/token/background/main.html"},
    AbortController,
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, {fn, delay}); return id; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); },
    async fetch(url, init) {
      active++; peak = Math.max(peak, active);
      requests.push({url, body: init.body && JSON.parse(init.body)});
      await new Promise(resolve => setImmediate(resolve));
      active--;
      if (offline) throw new Error("server unavailable");
      return {ok: true, status: 200, json: async () => url.endsWith("/poll") ?
        (replies.shift() || {jobs: [], stop: false}) : {ok: true}};
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  function fire(delay) {
    const entry = Array.from(timers).find(([, timer]) => timer.delay === delay);
    assert(entry, "Expected timer at " + delay + "ms");
    timers.delete(entry[0]);
    return entry[1].fn();
  }
  return {sandbox, timers, listeners, requests, fire, peak: () => peak};
}

async function main() {
  const test = host([
    {jobs: [{id: "one", name: "probe", code: "window.runs = (window.runs || 0) + 1; Promise.resolve({answer: 42})"}]},
    {jobs: []},
    {jobs: [], stop: true}
  ]);
  assert.strictEqual(test.requests.length, 0, "startup is delayed");
  await test.fire(5000);
  assert.strictEqual(test.sandbox.runs, 1);
  assert.strictEqual(test.requests[0].body.events[0].type, "connected");
  test.listeners.get("error")({message: "example error", filename: "example.js", lineno: 4});
  await test.fire(1500);
  const events = test.requests.flatMap(r => r.body ? r.body.events : []);
  assert.deepStrictEqual(events.find(e => e.id === "one").value, {answer: 42});
  assert(events.some(e => e.type === "error" && e.message === "example error"));
  assert.strictEqual(test.peak(), 1, "requests never overlap");
  await test.fire(1500);
  assert.strictEqual(test.sandbox.__wexLocalDiagnostics, undefined);
  assert.strictEqual(test.listeners.size, 0);
  assert.strictEqual(test.timers.size, 0);

  const offline = host([], true);
  await offline.fire(5000);
  for (let i = 1; i < 10; i++) await offline.fire(1500);
  assert.strictEqual(offline.requests.length, 10);
  assert.strictEqual(offline.timers.size, 0, "a missing server stops polling");
  assert.strictEqual(offline.listeners.size, 0);

  const stalled = host([{jobs: [{id: "slow", code: "new Promise(() => {})"}]}]);
  const polling = stalled.fire(5000);
  for (let i = 0; i < 10 && !Array.from(stalled.timers.values()).some(t => t.delay === 15000); i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  stalled.fire(15000);
  await polling;
  await stalled.fire(1500);
  assert(stalled.requests.some(r => r.body && r.body.events.some(e =>
    e.id === "slow" && e.error.message.includes("not cancelled"))));
  stalled.sandbox.__wexLocalDiagnostics.stop();
  console.log("Diagnostic client: delayed startup, serial requests, results, errors, timeouts and cleanup passed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
