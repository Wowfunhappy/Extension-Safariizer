# Extension diagnostics

A reusable local server for debugging **any converted extension**, without
driving Safari's UI or repeatedly pasting commands into its console. It uses
Python 3.7+ and the standard library; it adds no dependency to the converter.

The server temporarily adds a client to the bundle's global page, located using
`Info.plist`. The client sends results and uncaught global-page errors to a
JSON-lines log. It waits five seconds before connecting, makes one request at a
time, and leaves console methods untouched. Normal conversions do not include it.

## Start a session

From the project directory, substitute the bundle you want to inspect:

```sh
python3 diagnostics/diagnose.py serve 'build/Example.safariextension' \
  --session diagnostics/sessions/example
```

Choose a new session directory for each run, or omit `--session` to generate one.
The server prints the directory it uses. `--port` defaults to `8765`; `--port 0`
chooses an available port. Only `127.0.0.1` is bound, with a fresh random token
embedded in the temporary client.

Reload the extension once in Extension Builder yourself. A `connected` event
should appear after about five seconds:

```sh
tail -f diagnostics/sessions/example/events.jsonl
```

The tool does not open tabs, refresh pages, operate controls, or change extension
settings. Refresh a website yourself when testing content-script startup.

## Collect diagnostics

In another terminal, queue one of the generic probes:

```sh
python3 diagnostics/diagnose.py queue diagnostics/sessions/example diagnostics/probes/extension-state.js
python3 diagnostics/diagnose.py queue diagnostics/sessions/example diagnostics/probes/active-tab.js
python3 diagnostics/diagnose.py queue diagnostics/sessions/example diagnostics/probes/assets.js
```

| Probe | Result |
| --- | --- |
| `extension-state.js` | Manifest identity, bundle URL, registered bridge, runtime notes, open tabs |
| `active-tab.js` | Frame tree, content bridge, injected script URLs, failed extension images |
| `assets.js` | Manifest icon dimensions and SVG loading with an explicit media type; edit `additionalPaths` for other images |

Each script is a JavaScript expression evaluated on the **global page**. An async
IIFE can return a Promise whose value becomes the result. For example:

```js
(async () => {
  return {manifest: chrome.runtime.getManifest(), tabs: await chrome.tabs.query({})};
})()
```

Use the native `chrome.__wexNative.tabs.executeScript` API, as in `active-tab.js`,
to inspect a content-script world. The global page has `chrome` in every build;
a Chrome build has no `browser` there. The content bridge's
`WEXContent.exec({func: String(yourFunction), args: []}).result` also runs in the
content-script world, and refuses a job that names another world. For a page-world
value, call the extension's own API from the global page:

```js
(async () => {
  const [tab] = await chrome.tabs.query({active: true, lastFocusedWindow: true});
  const results = await chrome.scripting.executeScript({
    target: {tabId: tab.id}, world: 'MAIN',
    func: () => ({hasChrome: typeof window.chrome, title: document.title})
  });
  return results.map(r => r.result);
})()
```

The engine runs that function in the page's own world, where the page's globals are,
and returns JSON-compatible results. A missing bridge or native frame-access error is
itself useful evidence; the server cannot bypass that engine boundary.

Commands are dispatched once per session, including across extension reloads.
They move from `pending/` to `dispatched/` before delivery. If a connection drops
between dispatch and result, there is no automatic retry: inspect the log, then
queue another command when appropriate. A new client does not replay old commands.
Use one extension per session.

Jobs time out after 15 seconds. This stops waiting for the result; it cannot
cancel JavaScript that is still running. Prefer bounded, read-only snapshots to
timers, persistent listeners, or repair commands. Return small summaries: large
events are truncated and the client queue is bounded. The client captures
uncaught global-page errors and rejections, not every console log or page error.
Custom probes can report with `window.__wexLocalDiagnostics.send({...})`.

## Stop and clean up

Press **Ctrl-C** in the server terminal. It briefly gives the client a stop
response, removes its script tag and file, and preserves the logs. If the server
is killed or crashes, recover with:

```sh
python3 diagnostics/diagnose.py cleanup diagnostics/sessions/example
```

Cleanup removes only the tool's marked tag and its unchanged client file. It
preserves other edits to the global page and will not restore an old page over a
fresh conversion. Reloading the extension also removes any already-loaded
client; an unreachable server makes the client stop after ten failed requests.
If you manually edit the client, cleanup asks you to inspect it before deletion.

The session contains `installation.json`, an original-page backup, dispatched
commands, and `events.jsonl`. Logs and command results can contain tab URLs or
extension data. Session directories are local and git-ignored. Keep the server
available only while debugging: queued
JavaScript runs with the extension global page's privileges.

## Verify the tooling

```sh
python3 -m unittest discover -s tests -p 'test_diagnostics.py'
node tests/diagnostics.js
```

These tests use a temporary fixture bundle, a loopback connection, and a simulated
JavaScript host. They do not control Safari or modify an installed extension.
