# webext2safari

Converts a WebExtension — a Firefox `.xpi`, a Chrome `.crx`, a plain `.zip`, an
unpacked directory, or a Chrome Web Store URL — into a legacy Safari `.safariextension` bundle, the pre-WebExtension
format Safari 7 speaks.

The bundles are for Safari 7 running [wowfunhappy/webkit](https://github.com/wowfunhappy/webkit),
which gives legacy extensions the parts of the WebExtensions `browser` namespace that
need the engine: messaging addressed by tab and frame, script and style injection on
demand, scripts for the page's own world, `webRequest`, `declarativeNetRequest`, `webNavigation`, cookies, tab events and
the clipboard. A bundle does not run on a WebKit without them.

The conversion has two halves. The converter, in JavaScript, rewrites the packaging: `manifest.json`
becomes `Info.plist`, background scripts get a global page, extension pages get a bridge
script, icons get rescaled. A JavaScript runtime layer travels with every converted
bundle and completes `chrome.*` / `browser.*`, building what the engine leaves out —
tabs and windows as Safari shows them, storage, the toolbar button, menus, alarms,
`i18n` — on top of Safari's `safari.*` objects, so the
extension's own code runs through that compatibility layer. The converter also
adapts simple Chrome extension URL construction using a generic syntax rule.

Both MV2 and MV3 manifests are accepted.

The converter also comes as a Safari extension, Extension Safariizer, which puts an
"Add to Safari" button on the Chrome Web Store and on Firefox Add-ons. Pressing it
downloads the extension, converts it in the browser, and saves a signed `.safariextz`
that Safari installs when opened. An extension from anywhere else is converted from the
address of its `.crx`, `.xpi` or `.zip`, entered in the extension's preference in
Safari's Preferences. The extension runs the same converter,
`webext2safari/js/`, that runs from the command line (see "Using it").

Chrome Web Store conversions retain the original Chrome extension origin for
HTTP authentication. The identity also comes from a CRX header or a manifest
`key` when available. The runtime restores that origin on native extension
requests within the bundle's host permissions. It does not insert network helpers
into website pages or open helper tabs. For requests it changes, a server's exact
Chrome-origin CORS response is translated back to the real Safari extension origin.
Background authentication requires a WebKit build with `webRequest` hooks for
WebKit 1 extension views; older builds cannot apply these changes to global-page
requests. Synchronous XHR reports its events but cannot apply blocking verdicts.

## Requirements

From the command line, Node.js 18 or later; the converter uses nothing beyond Node's
own modules. Icons that are not PNGs are converted with the system's `sips`. In Safari,
the Extension Safariizer extension needs nothing more.

For live debugging without browser UI automation, see the reusable
[local diagnostics server](diagnostics/README.md). It can temporarily instrument
any converted bundle, collect results, and remove itself afterward.

## Using it

```sh
node tools/convert.js "Example v1.0.xpi" -o build
```

A Chrome Web Store or Firefox Add-ons page's URL works too; the converter downloads the
extension's current `.crx` or `.xpi` and converts that:

```sh
node tools/convert.js "https://chromewebstore.google.com/detail/example/abcdefghijklmnopabcdefghijklmnop"
```

Several at once, and each gets its own bundle:

```sh
node tools/convert.js ~/Downloads/*.xpi -o build
```

Useful options:

| Option | What it does |
| --- | --- |
| `-o DIR` | where bundles are written (default `./build`) |
| `--bundle-id ID` | set `CFBundleIdentifier` explicitly |
| `--name NAME` | override the display name and the bundle's filename |
| `--author NAME` | author shown in Safari's extensions list; taken from the manifest, or its homepage host, otherwise |
| `--storage settings` | keep `chrome.storage` in Safari's extension settings instead of the global page's IndexedDB |
| `--popup-size WxH` | fix the popover's size instead of measuring the popup |
| `--debug` | leave the runtime's diagnostic logging switched on |
| `--test-api MODE` | give the extension `chrome.test` and `browser.test`, as a browser does when it runs extensions' test suites (see "Running extensions' test suites") |
| `--test-config FILE` | the JSON `chrome.test.getConfig()` gives |
| `--pack` | also sign the bundle into a `.safariextz` beside it |
| `--quiet` | print only the path of each bundle |

Each run prints a compatibility report and also writes it to
`<bundle>/wex/CONVERSION-REPORT.txt`. Read it before wondering why something does not
work — it lists, per API, what the extension calls and what this target can provide.

## Installing the result

The output is an unpacked `.safariextension` folder, which is what Safari's Extension
Builder takes. Open Safari's Develop menu → Show Extension Builder, add the folder, and
Install. Extension Builder applies its own certificate; on a stock Safari 7 that has to
be an Apple-issued one, but with `AllowSelfSignedSafariExtensions` loaded a self-signed
certificate is accepted.

A folder can also be packed into a signed `.safariextz`, which installs by opening it:

```sh
node tools/pack-extension.js "build/Example.safariextension"
```

The archive is a xar archive signed with a self-made RSA key, under a certificate chain
of the shape Safari checks for: a leaf certificate for "Safari Developer: (9203582716)
webext2safari@localhost" with Apple's Safari extension marker, then Apple's own WWDR
intermediate and root certificates. Safari accepts it with
`AllowSelfSignedSafariExtensions` loaded. The key and certificate are kept in
`dist/signing-identity.json`, made on first use; `--identity FILE` names another.

Safari sometimes refuses to replace an installed extension with "Safari can't install this
extension" after it has already been replaced once since Safari started. An extension
written by hand with none of this project's code does the same, so the refusal is Safari's.
Quitting and reopening Safari clears it, and the archive then installs as it is.

## The Extension Safariizer Safari extension

```sh
node tools/build-extension.js
```

writes `dist/Extension Safariizer.safariextension` and a signed
`dist/Extension Safariizer.safariextz`. Install the archive, then open an extension's page
on the Chrome Web Store or on addons.mozilla.org: its install button is replaced by
"Add to Safari". Once the extension is converted and installed, the button says
"Installed", in the store's own style for a button that does nothing: the converter
remembers which bundle each store page's extension became, and asks that bundle, through
the engine's messaging between extensions, whether it is there. A converted extension's
runtime answers such a question from another extension out of its own listeners' sight.
The Chrome Web Store's prompts to switch to Chrome, a dialog under its header and a
message box above the item, are hidden as they appear.

The bundle is the files of `safari-extension/`, its `Info.plist`, `Settings.plist` and
128-pixel icon among them, with the converter, the runtime and the global page added. The
built bundle can be opened in Extension Builder to change its metadata;

```sh
node tools/sync-extension.js
```

then brings what changed there back to `safari-extension/`. A build records what it
wrote, in `dist/Extension Safariizer.built.json`, and will not replace a bundle with
changes not yet brought back. A change the sync cannot make (to a file the build makes
from elsewhere, or to one changed in `safari-extension/` since the build as well) is
listed and left.

For an extension on neither store, enter an address in Safari's Preferences, under
Extensions, in Extension Safariizer's "Convert from URL" field, and press Return: the
address of the extension's `.crx`, `.xpi` or `.zip` file (a GitHub release asset, say),
of its store page, or a Chrome extension's id alone. A tab opens to show the conversion,
with a button to try again if it fails. The field is blank each time Safari's Preferences
is opened. A window left open goes on showing the address and ignores the same address
entered again; the tab's button, or reopening Preferences, converts it again. Since an
archive may come from any site, the extension's website
access is all sites; its store script runs on the store pages alone. Safari applies a
change of website access to an installed extension only once it relaunches, so after
updating from a version that had less, relaunch Safari.

The download, the conversion and the signing all happen in the extension's global page;
the result is saved to Downloads under the extension's name, ready to open.

The global page loads the files listed in `webext2safari/js/files.json` in order, and
Node loads the same modules through `webext2safari/js/node.js`. The converter converts
images through a hook: the extension draws them on a canvas, Node calls `sips`.

## What maps to what

| WebExtension | Legacy Safari |
| --- | --- |
| `name`, `version`, `description` | the bundle's display name, version and description, in the browser's language |
| `author`, `developer.name` | the bundle's author, which Safari shows as "by …"; for a manifest that names none, the store listing's: the Chrome Web Store byline's publisher or verified site, or Firefox Add-ons' authors; without either, the homepage's host |
| `homepage_url`, `developer.url` | the bundle's website; for a manifest that names none, the site a Chrome Web Store byline links to, the homepage Firefox Add-ons lists, or else the listing's page |
| `background.scripts`, `background.service_worker` | a generated `wex-global-page.html` that loads them in order, as modules when the manifest says `"type": "module"` |
| `background.page` | used as the global page directly, with the runtime injected into it |
| `browser_action` / `action` / `page_action` | a single toolbar item |
| `default_popup` | the toolbar item's popover, resized to fit the popup once it loads; Safari shows a popover below its toolbar button, so one whose button the toolbar has no room for, listed in its » menu, does not open from there |
| no `default_popup` | the toolbar item's command, reported as `action.onClicked` |
| `options_ui.page`, `options_page` | opened in a tab |
| `content_scripts` | the injected bridge, and a copy of each script that Safari injects after it and that runs where the bridge says its group applies; a script for the page's world, one the converter's scanner cannot follow, and the scripts before either in its phase are run by the bridge, which keeps the manifest's order |
| `content_scripts[].matches` | Website Access and the bundle's whitelist, plus a runtime check per group |
| `permissions` host patterns, `host_permissions` | Website Access |
| `tabs` or `activeTab` without access to every site | Website Access to every site, and `<all_urls>` added to the bundle's `manifest.json`, which the engine takes a tab's access from: Chrome shows such an extension every tab's address |
| `_locales` | the catalogues of the browser's language, each as its JSON's text, in the bridge configuration, so `chrome.i18n` does not synchronously load files in host pages; another language's is read from its file |
| `declarative_net_request.rule_resources` | the same keys in `Info.plist`, which the engine reads |
| `commands` | the shortcuts Chrome would assign, caught in the pages the extension can reach and in its own |

### Content scripts

Safari injects one flat list of scripts into every page the bundle's whitelist covers.
There is nowhere to put per-script match patterns, so the bundle's script list is the
runtime's own bridge, and the bridge fetches and evaluates the extension's content
scripts itself — only on pages whose URL the manifest says they belong on, honouring
`exclude_matches`, `include_globs`, `exclude_globs`, `all_frames` and `match_about_blank`.
`document_idle` runs with `document_end`, which is the closest phase the host offers.
A group for the page's own world (`world: "MAIN"`) is the engine's: the global page
registers it with the engine's `scripting.registerContentScripts`, which runs it as one of
the page's own scripts as the document starts or ends, whatever the page's policy, on the
pages its matches name within the bundle's Website Access. A group with globs runs from a
copy in `wex/main/<group>/` that first asks whether they let it run. Their style sheets are added by the engine, which keeps them out
of the page's `document.styleSheets`. A manifest path from the bundle's root
(`/lib/x.js`) names the same file as one without the slash.

`scripting.executeScript` with `world: "MAIN"` is the engine's `scripting.executeScript`,
which runs in the page's own world, whatever the page's policy, and gives the value back.
The runtime turns the `documentId`s of the call into frames, and gives its own in the results.
Every other world goes through the bridge.

The engine's copy of a style sheet arrives some milliseconds after the page's first paint,
which would show the page without it for a frame. So the converter keeps the text of each
declared sheet up to 32 KB that names no address, and a frame adopts it as a constructed
style sheet as it starts, taking it away once the engine's copy is in, some 50 ms later.
For that time a page can read it in `document.adoptedStyleSheets`. A sheet with `url()` or
`@import` is left out, as an address would resolve against the page and could show it the
extension's; such a sheet, or a larger one, arrives after the first paint.

Safari can omit the bundle's injected scripts on a fresh install, and keeps an updated
extension's old list until it is relaunched. The global page therefore also registers
the bridge, and the copies after it, through Safari's runtime API. The static and runtime
paths share guards that run each content-script phase once per document. The runtime
replaces only its own registrations when the global page restarts.

Safari runs the bridge in every frame of every page the whitelist covers, and most of a
page's frames, ads and embeds, are ones no content script of the extension applies to.
In such a frame the bridge does only what the frame needs whether or not a script runs
there (sending a navigation to the extension's address back to its page, catching its
shortcuts, telling the global page about its context menus, answering whether anyone
listens), and makes the content scripts' `chrome`, with its checks, its enums and the
browser it presents, once something there uses it: code `executeScript` runs, or
anything that reads `chrome` or `browser`, as a script registered at run time does. Its
schemas are carried as JSON text, read then. The top frame, and a frame a content script
applies to, make it at once.
Script whitelists are restricted to Website Access, since Safari can silently
reject a registration that names hosts outside that permission scope.

Scripts registered at run time (`scripting.registerContentScripts`, Firefox's
`contentScripts.register`) are handed to Safari's own `addContentScript`, which runs
them in every frame of the pages they match. One Chrome runs in the top frame alone, as
it does unless the registration asks for `allFrames`, is wrapped as the injected copies
of the manifest's scripts are (see below), in a block that runs where the frame is the
top one; run in every frame, a proxy script that connects from each frame to a background
that closes a tab's earlier connection for each new one would have each copy reconnect at
once, without end. `scripting` checks a registration as
Chrome does, refusing an empty, reserved (`_`) or duplicate ID, a script without
`matches` or files, or with a file the extension does not have, and describes a script
back with each field Chrome fills in. Scripts that persist across sessions, as they do
unless the registration says otherwise, are registered again when the extension starts. One
for the page's own world (`world: "MAIN"`) is registered with the engine instead, as the
manifest's are, and Safari is given nothing of it. The engine keeps those across sessions,
and the global page brings its list in line with the extension's as it starts.
Chrome runs a document's registered scripts in the order they were registered, whatever
their world, and Safari runs its own and the engine's in either order. So each script
for the page's world ends with `wex/wex-page-world-ran.js`, which counts its run in the
document and announces it by an event, and a script registered after such scripts, in
the same phase or a later one, waits until those of them whose matches take in its frame
have run. Safari is given it once the engine has them.

Chrome's `userScripts` (a version 3 manifest's, with the `userScripts` permission) works
the same way. Chrome runs user scripts in a world of their own; Safari gives an extension
one world beside the page's, so they run in the content scripts' world, each source given
to `addContentScript` as it is, at the world's top level, where the next can use what the
one before defined. A script's `includeGlobs` and `excludeGlobs` wrap it in a block that
tests the document's address first. What a user script sends with `runtime.sendMessage` or
`connect` arrives as a content script's message does, through `runtime.onMessage` and
`onConnect`. A user script for the page's own world names its code by file and is the
engine's to run, as a registered content script for that world is. `configureWorld` keeps a
world's policy and messaging setting and reports them back; the content scripts' world runs
whatever its page's policy, and its scripts may always send messages. The scripts are kept
across sessions, as Chrome keeps them. `userScripts.execute` runs code or files in a tab's
frames through the same path as `scripting.executeScript`, and gives each frame's result, or
the error the code threw.

What the runtime itself puts into a site's own world is registered the same way, from files
the converter writes: `wex/page-world.js`, in every frame of the pages the bridge goes into,
which gives `window.open` a stand-in for the extension's address (for an extension a site
may open a page of) and lets a frame below one of the extension's pages see its Chrome
origin (below), and `wex/page-runtime.js`, `chrome.runtime` for the pages
`externally_connectable` names. A content script's own `<script>` element in a page is the
page's script, and the page's policy holds against it, as in Chrome.

`tabs.executeScript` and `scripting.executeScript` go through the engine, which runs the
code in the content-script world, beside the bridge. A frame whose code throws gives
`null` among `tabs.executeScript`'s results, as in Chrome, and is left out of
`scripting.executeScript`'s, which name each frame. Given several `files`, a Chrome build
runs them all, as Chrome does: one that fails to parse or throws leaves the rest to run,
and only the last decides the frame's result. A Firefox build stops at the first that
throws, as Firefox does. `scripting.executeScript` gives what
a promise the function returns settles to, in either world, and leaves out a frame where
it is rejected. `tabs.executeScript` follows the browser the extension was built for: in a
Chrome build it gives a promise as it is, as an empty object, and `null` for a frame whose
code throws; in a Firefox build it gives what the promise settles to, and fails with what
the code throws or the promise rejects with. That world exists where the bundle
injects something, so an extension that works with tabs has the bridge injected into
every page it has access to. Safari injects into a page as it loads, so a page that loaded
before the extension started has no bridge; an injection there reads and evaluates the
bridge first, which gives its code `chrome` as Chrome's content-script world does, and runs
none of the manifest's content scripts, which Chrome runs only in documents that load
after.

In a browser a content script is a script, so its top-level `let`, `const` and `class`
declarations are seen by the scripts that run after it in the same world. The bridge
evaluates content scripts and injected files, and evaluated code keeps those
declarations to itself; strict code keeps its `var` and function declarations too. So
the bridge first gives the source's top-level `let` and `const` the form `var` and its
top-level classes `var` bindings, and has strict source finish by copying its top-level
names onto the global object, with the `var` names of its statement blocks that are in
no function (`var Messages` inside a bare `{ }` block, say). A `let`, `const` or `class`
named for a window property that would not hold the value as a plain variable (`name`,
`status`, `history` and a few others) stays as written and is seen by its own file alone.
The value a file evaluates to is unchanged. Source whose strings, templates, comments or regular
expressions the scanner cannot follow is evaluated as written.

The content scripts the manifest declares are made ready this way when the extension is
converted, and Safari injects them itself, each in the phase of its group, from a copy in
`wex/content/<group>/`: the source in a statement block that runs where the bridge says the
group applies, once per document, a strict source in a function of its own inside the
block so that it stays strict, and a sloppy source's top-level async functions and
generators, which the block would keep to itself, copied onto the global object too. The
bridge reads and evaluates only what Safari cannot inject: a script for the page's own
world, and one the scanner cannot follow. Reading a file from the bundle is a synchronous
request in every frame it applies to, which holds up the page for as long as the browser
takes to serve it (seconds, while it is busy loading the page's frames), and the scanner
takes a tenth of a second over a large script; done once, when converting, neither
happens as a page loads.

The configuration every frame evaluates first carries the extension's `_locales`
catalogues for the browser's language only, the language the extension is converted in,
each as its JSON's text, which i18n parses when a message is first asked for; a
catalogue in object form is far slower to evaluate, and an extension with thirty languages
carried several megabytes of them into every frame. A language the configuration does
not carry, as after the browser's changes, is read from its file.

### Extension pages

An extension page runs wherever it is opened. The engine gives it `browser` in the
popover and in a tab alike, and the bridge completes the namespace. The parts of the API
built on the global page — storage, `tabs.query`, the toolbar button, menus, alarms —
are calls that travel to the global page as runtime messages, and their events come
back over a port. Messaging, injection, `webRequest`, `declarativeNetRequest`,
`webNavigation` and cookies are the engine's and are carried out in the page itself.
The page's namespace stands in for the global page's: each member is looked up when it
is read, checked against Chrome's schema as it is handed out, and one the page assigns
is the one it reads back, as with any object.

A page in the popover shares a process with the global page and could reach its objects
directly, but they would belong to another JavaScript realm, and extensions test what
they are handed: a popup that asks `tab instanceof Object` gets false for a tab from another
realm, and can conclude it is not on a website. Messages arrive as
the page's own objects, so the popover takes the same route as a tab.
`getBackgroundPage()` still hands the popover the global page's window.

A browser opens a popup as a new document each time, on the popup page, and popups are
written to describe the tab they open over. Safari loads a popover's page as the
extension starts and keeps it, so the popover rests on a blank page of the runtime's
(`wex/wex-popover.html`), and just before it shows it is taken to the popup page, or the
popup is reloaded; none of the popup runs until it is opened (a popup's code may act on
being opened, as by opening a start page), and it describes the tab it opens over. Once the
popover has shown and hidden again it goes back to the blank page, which ends the popup's
document, its timers and its ports, as closing a popup does.

A browser paints a popup over an opaque base of the canvas colour, which shows wherever
neither the page's root nor its body paints a background. A popover's view is
transparent, so while both are transparent, as when a page's rule sets the root's
background to a variable it never defines, the root is given that colour; the body keeps
its own background, which the canvas takes when the root has none.

Safari opens nothing when the global page or a popover calls `window.open`: the call
returns `null`. In Chrome it opens a tab, so the runtime carries it out with
`tabs.create`, and returns something that stands for the window, whose `close()` closes
the tab. In a popover, Safari loads a followed link in the active tab, where Chrome keeps
it in the popup, and does so even for a link to a place in the same page; so a link with
a `target` opens a tab, a link to one of the extension's own pages stays in the popover,
and a link within the page moves to its fragment without navigating. A plain link to the
web loads in the active tab, as it does in Safari's own popovers.

A browser sizes a popup to its page's preferred width, the width of its content laid out
without wrapping more than it must, and to the height of its content at that width. The
popover is fitted the same way, within 180 to 1000 points across and 100 to 760 high, once
the popup loads and again as its content changes, so that it shrinks to a page shorter
than it as well as growing: the root is measured at its content's height (a minimum the
page gives it still counts), with the body made the box that
absolutely positioned content is placed in. The measuring rules go on a style sheet
adopted only while measuring, which changes no attribute or node, so that neither the
page nor the popover's own observers see it; a page that answers a change to its root's
attributes, as a theme's code may, is not refitted for its own answer. A size the
popover already has is not given again, as that is still a resize to the page.

So the options page, a `tabs.create` onto an extension URL and a `windows.create` all
open as ordinary tabs and windows.

An extension's new-tab page (`chrome_url_overrides.newtab`) takes the
place of Safari's Top Sites in a new tab: Safari announces a new tab about to show Top
Sites as a navigation with no address and gives the tab an empty address, and the
runtime sends that tab to the extension's page. A tab that a link or a script opens is
announced with its own address and goes there. Safari announces with no address as well
a navigation to a page the extension may not see, such as another extension's page a
content rule list redirects to, whose tab's address it withholds, and an extension
archive opened over a page, so only an empty tab goes to the extension's page; Top
Sites shown in a tab that already shows a page stays Top Sites. A new tab that a
converted extension sends to one of its own pages (`tabs.create`, `openOptionsPage`)
looks the same to every other extension, so the runtime shows a blank page in it
first, which Safari announces with its address; the blank page stays in the tab's
history, one step back from the extension's page. An extension with a new-tab page has
access to every website, to see the address of each web page a new tab opens to.

A Safari toolbar button can have a command and either a popover or a native menu. An
extension with a declared popup gets the popover; one without gets the command, which is
reported as `action.onClicked`. `action.setPopup` switches that behavior at run time,
for every tab or, with a `tabId`, for one: each window's button follows its active tab,
and the one popover is taken to the popup of the tab it opens over. A window opened
later has the button the bundle declares until the runtime brings it in line, which it
does whenever Safari asks the button to update.

Root-relative URLs in a page (`src="/network/core.js"`, `fetch("/data/x.json")`) are
resolved inside the bundle by the engine and left as written. A relative path handed to
`tabs.create`, `tabs.update`, `windows.create` or `action.setPopup` is resolved against
the extension's root in a Chrome build, whichever page or worker names it, as Chrome
does, and against the calling page in a Firefox build; one handed to `action.setIcon` and
the like against the calling page. `runtime.getURL` resolves the `.` and `..` segments of
the path it is given, none above the root, as Chrome resolves it against the extension's
root: `getURL("./build.info")` is the address of `build.info`.

A relative reference that climbs above the bundle's root stops there, as a browser stops
at the extension's root: from `popup.html`, `../styles/popup.css` is `styles/popup.css`.

A background service worker's generated global page is written beside the worker
(`background/wex-global-page.html` for `background/index.js`), because a worker resolves
relative URLs against its own file: `../config/sites.config` loaded from
`background/index.js` would, from a page at the bundle's root, point outside the bundle.

Chrome gives a message's sender an `origin`, and extensions check an extension page's
against `runtime.getURL("")`, as `sender.origin + "/" === runtime.getURL("")`. Here that
URL carries the bundle's per-session token, so the origin an extension page's sender is
given is the address of the bundle's root without its final slash, token included. In
the extension's own pages a `URL` of one of the extension's addresses reports the same
`origin`, and a `pathname` that is the path within the bundle (`/popup.html`), so that
`origin`, `pathname`, `search` and `hash` still make up the address. So does a message
an extension page gets from one of the extension's pages (`MessageEvent#origin`, which
WebKit gives as the bare origin with its host in lowercase), and the page's own
`window.origin`. A page's own `location` cannot be changed that way and keeps Safari's
values; the converter has the extension's scripts read it as below.

The converter has an extension's own scripts read `location.pathname` as Chrome gives
it: `location.pathname`, and `window.`, `self.`, `globalThis.` or `document.location.pathname`,
are read as `(location.__wexPathname ?? location.pathname)`, which the runtime answers
with the path within the bundle. `location.origin` is read the same way, as
`__wexOrigin`, the origin the runtime gives the extension's URLs, messages and senders, so
that an address built on it works and a comparison with any of those agrees (Construct
games compare it with a `URL`'s to decide how to start their worker). It still names the
page as a `postMessage` target. Where the runtime is absent, or `location` names an object
of the extension's own (a router's, say), the plain property is read. Assignments are
left alone. A read of `location.href` asks for `__wexHref` the same way, which is the
page's own address. A service worker's location is its script's address, and a
background may check it (running only where `location.href` names its own script), so in the global page that stands in for a worker,
`__wexPathname` and `__wexHref` give the worker's path and address. Background scripts
run, in Chrome and Firefox, in a page the browser generates for them at
`_generated_background_page.html`, which a background may check too (setting up its
message handlers only where `location.href` is `getURL("_generated_background_page.html")`),
so the global page the converter generates for them gives that page's path and address,
and its messages' `sender.url` names it; `getURL` and `new URL` give that address as they
do in the browser. Safari runs no global page whose name starts with an underscore, so
the page cannot have the name itself.

A service worker's global has no `window`, `document`, `top`, `localStorage`, `history`,
`customElements`, `closed` or `frameElement`, and a worker can give it one of its own
(`globalThis.window = {}`, or a `localStorage` of its own kept in `chrome.storage`); a window refuses to have them assigned,
with a TypeError in strict code, which stops the rest of the worker. In the global page of
a service worker, `localStorage`, `history`, `customElements`, `closed` and `frameElement`
can be assigned, and read as what was assigned, while the runtime keeps its own records
in the real `localStorage`. `window`, `document` and `top` a window will not let anything
redefine, so an assignment of one of them goes to the runtime's `__wexWorkerScope`
instead, a scratch object the global page of a service worker has: of `top` through
`globalThis`, `self` or `window`, and of `window` or `document` through any name, `this`,
or chain of names, as a bundler names the global (`e.window = {}`),
a logical assignment (`||=`) among them. A read of `window` or `document` through `self` or
`globalThis` goes there too, where it is what the worker assigned, or nothing, as in a
worker (one may set `self.window` to an object with a `localStorage` of its own and read
it back). So does a read of `self.location` or `globalThis.location` as a whole,
rather than of one of its members, where it is the worker's location: the script's address,
under the extension's origin as the runtime gives it (a worker may check the path of the
location it is handed). `"document" in self` and `"window" in globalThis` ask there as
well, so that a test and the read it guards agree (as `self.document.baseURI` read where
`"document" in self`). Anywhere else, and on any other
object, the assignment is made as written. Extensions tell
their worker from their pages by `typeof window === "undefined"` or `typeof document`
(a worker may make its requests itself only when it finds no window, with its pages passing
theirs to it), so in an extension with a service worker those tests answer as the
worker's in the global page that stands in for it, by the runtime's `__wexWorkerScope`:
`"undefined"`, unless the worker gave itself a `window` or `document` (with
`self.window = self` at its start, say), and as written anywhere else;
`typeof window.x` is left alone. `WorkerNavigator`
and `WorkerLocation` name the page's navigator and location there, as
`WorkerGlobalScope` and `ServiceWorkerGlobalScope` name the page.

A string that is the build's own browser's protocol, `"chrome-extension://"` in a Chrome
build and `"moz-extension://"` in one published on Firefox Add-ons, or the start of it
from the hyphen on (`"moz-extension:"`, or `document.URL.startsWith("moz-")`),
names the same part of `safari-extension://` instead, so a test for one of the
extension's own addresses finds them. A regular expression is changed to match Safari's
protocol where it matches the build's own: the protocol written out (`/^moz-extension:/`)
becomes Safari's, and a group with the protocol's first part as an alternative before the
hyphen (`(?:moz|chrome)-.*:`) gains `safari` as another. The
other browser's protocol is left alone, so code that tells browsers apart by protocol
still finds its own. A build counts as Firefox's when Mozilla's signature files are in it.

Message senders from a converted service worker name its manifest-declared script,
instead of the generated HTML page. An address built from an extension's id,
`"chrome-extension://" + id + "/path"` or `` `chrome-extension://${id}/path` ``, where the
id is a name or a property of one, asks the runtime for the origin it stands for: the
extension's own address, with its session token, for its own id (as a check of the
redirect address from `getURL` against the extension's own id needs), another converted
extension's for that one's id, and the Chrome address otherwise, which loads nothing,
as for an extension that is not installed. The converter notes the other Chrome ids the
extension's scripts name, and the global page asks each one's bundle, which answers with
its origin while it is installed and running; extension pages and content scripts get
what it learns. This applies by syntax, without matching extension names, ids or file
names; a tagged template, whose tag sees text and values apart, and an id built by a
call or an index are left as written.

Paths built from `new URL(import.meta.url).origin` also lose Safari's session token.
When that expression is followed by a slash in a template interpolation or string
concatenation, the converter substitutes the bundle root, including the token.
This works in modules injected into a website, where the runtime bridge is not
available. Origin comparisons are unchanged, as is the behavior on other schemes.

### Offscreen documents

`offscreen.createDocument` loads a page of the extension's in a frame, after Chrome's
checks and with its errors: an address outside the extension, a second document, no
`reasons`, or the `TESTING` reason outside a test build. For `AUDIO_PLAYBACK`,
the frame is placed out of view in the active HTTP or HTTPS page, where Safari allows
audio to run. The host page must have the content bridge; refreshing it after installing
the extension provides that bridge. A bundle that needs the bridge everywhere is given
Website Access to every HTTP and HTTPS page even when the original manifest has no host
permissions; the runtime still enforces its original API permissions and content-script
matches. The frame retains the extension's origin and API.
Other offscreen documents use the global page. Creation resolves after the page loads;
`hasDocument`, `closeDocument`, and
`runtime.getContexts` track its lifetime. `getContexts` reports the background and
offscreen documents only. Chrome's audio idle timeout and separate incognito
offscreen documents are not implemented. An audio document closes when its host page
navigates, closes, or removes the frame; the extension can recreate it in the active
page. Safari can leave Web Audio in its hidden global page interrupted indefinitely,
which is why audio documents need a webpage host.

### Requests

`webRequest` is the engine's: every event, for every request a page makes, the main
document included, with blocking verdicts that cancel, redirect, and rewrite request and
response headers. The runtime adds `originUrl`, the name Firefox gives the requesting
document. A Chrome build sees the requests for its own files (`safari-extension:`), as
Chrome shows an extension its `chrome-extension:` requests, and never another
extension's. A Firefox build sees none of them, as Firefox's `<all_urls>` matches no
`moz-extension:` address: listeners may hold every request they hear until the
background has started, and the background's own scripts load after those listeners are
there. The requests for the runtime's files (`wex/` and the global page the converter
writes) are kept from the extension's listeners: the extension has no such files in
Chrome.

`declarativeNetRequest` is the engine's too, and the engine applies the request rules itself.
The manifest's static rulesets are written into `Info.plist` under a
`declarative_net_request` dictionary with the manifest's own keys. A ruleset with response-header
actions gets an engine copy without those actions, which the global page applies itself; the original
file remains for the extension's API. Dynamic rules and the choice of enabled rulesets persist
across launches; session rules last while any of the extension's pages is open. The
runtime narrows `getDynamicRules` and `getSessionRules` by `ruleIds` and fills in the
constants Chrome documents that the engine leaves out.

`block`, `allow`, `allowAllRequests` and `upgradeScheme` act on any URL; `redirect` and
`modifyHeaders` act only on sites in the bundle's Website Access, and `getMatchedRules`
reports only matches there. A static ruleset's request-header changes cover only the headers
WebKit knows, and its rules naming custom `X-` request headers are rejected; the conversion
report counts them. A dynamic or session rule that names a header the engine does not know
(`Permissions-Policy`, or a service's own, such as `example-client-version`) goes to the
engine without it, or, if that leaves it nothing to change, not at all, and the rest of the
update goes through. The extension reads the rule back as it wrote it, and the global page
applies the refused request headers itself, through a blocking `onBeforeSendHeaders` whose
changes the engine merges with every other listener's as Chrome merges them: on the requests
the rule matches, the extension's own included, by the same conditions, priorities and allow
rules as the response headers below. WebKit applies a
`modifyHeaders` rule's `requestHeaders` and leaves its `responseHeaders` be, so the global
page applies those itself, through the engine's blocking `onHeadersReceived`, as Chrome
does: the matching rules (by `urlFilter` or `regexFilter`, request and initiator domains,
`domainType` by the sites of the Public Suffix List, resource types, methods and tabs), the higher priority first, where a header a `set` or
`remove` has decided takes no lower rule's change but an append after an append. When a
matching subframe rule removes `X-Frame-Options` or `Frame-Options`, the runtime also removes
that response's equivalent CSP `frame-ancestors` directive, while retaining the rest of the
policy; otherwise the frame the rule expressly unblocks would still become a blank error page. Its
listener asks for only the hosts, and the resource types, the rules name where every rule
names them, so that no other load waits on it, and it is there only while such a rule is. A `redirect`
must name an HTTP or HTTPS address; the engine refuses a rule that redirects to a
`data:` URL. One whose `url` is one of the extension's own pages, as
`runtime.getURL` gives it, goes to the engine as that page's `extensionPath`, and reads
back as the extension wrote it. Engine request actions do not apply to loads from the global page or
the popover; the runtime's response-header actions do.
A content rule list knows nothing of tabs, and the engine takes a rule's `tabIds` or
`excludedTabIds` for no condition, so a session rule with a tab condition does not go to it
as written. One that excludes only the requests of no tab (`excludedTabIds: [-1]`) goes
without the condition, as the engine acts on tabs' requests alone; any other is the
runtime's, which blocks, redirects or upgrades the matching requests of the tabs it names
from the engine's blocking `onBeforeRequest`, under the extension's allow rules, and applies
its headers as it applies refused ones. One for the requests of no tab alone
(`tabIds: [-1]`) so matches nothing. A dynamic rule with a tab condition is refused, as in
Chrome. An allow rule that names tabs cannot exempt a request from the engine's rules.
`displayActionCountAsBadgeText` sets the badge on the toolbar button in the frontmost
window. `onRuleMatchedDebug` never fires, and `testMatchOutcome` is not there. The engine
applies a static ruleset whole, so a static rule `updateStaticRules` disables is
overridden while its ruleset is enabled: an `allow` rule with its condition and priority
is kept among the dynamic rules, under an id from 1990000000 up that `getDynamicRules` and
`getMatchedRules` leave out. An `allow` or `allowAllRequests` rule cannot be disabled so,
and a call that names nothing else fails. `getAvailableStaticRuleCount` is Chrome's allowance of
330,000 less the rules of the enabled rulesets, as the converter counted them. The
namespace's enums (`RuleActionType`, `ResourceType`, `RequestMethod`, `DomainType`,
`HeaderOperation`, `UnsupportedRegexReason`) are Chrome's.

The engine compiles all of an extension's rules into one WebKit content rule list, which
holds at most 150,000 rules, and makes a WebKit rule of each request domain and request
method a rule names. Rulesets within Chrome's allowance can make more (three
enabled rulesets of about 32,000 rules can make about 415,000), and a list over the limit would
leave the engine applying none of the extension's rules. So the converter cuts such rulesets
to 140,000 WebKit rules, leaving room for dynamic and session rules: the rulesets enabled
from the start together, and any other on its own. A cut ruleset keeps every `allow` and
`allowAllRequests` rule, as a block without its exceptions would break sites, then the
other rules, the cheapest in WebKit rules first, the last with as many of its
`requestDomains` as fit.
The cut ruleset is written beside the original as `….fitted.json` and named in
`Info.plist`; the runtime reads the original, so the extension sees its rules as written,
and the conversion report says what was cut. Enabling more rulesets later than fit fails
as the engine fails it, with `Failed to apply rules.`, and leaves the rules that applied.

The engine refuses a rule whose `resourceTypes` names `object`, `csp_report`,
`webtransport` or `webbundle`, though it takes them in `excludedResourceTypes`. Those
types are dropped from a dynamic or session rule's `resourceTypes`, and a rule that
names no other is left out.

The engine takes a `regexFilter` in the content-blocker dialect: groups, `?`, `*` and `+`,
classes and anchors, but no alternation (`a|b`), no counted repetition (`{2,4}`), no
`\d`, `\w` or `\s`, no `\b`, no lookaround, and no anchor inside a group. A dynamic or
session rule's pattern is restated in that dialect: shorthands become classes,
repetition is written out, a group with no quantifier is opened up, and alternatives
become one engine rule each, up to 32, save alternatives that hold a capturing group in
the pattern of a redirect that substitutes from it, whose groups would be numbered
anew. The extension sees its own rule; the engine's
further rules take ids from 1,900,000,000 up, and `getMatchedRules` names the
extension's rule for them. `isRegexSupported` answers for the restated pattern. A
pattern with no such restatement, or a static rule's, goes to the engine as written.

The engine also ignores `requestDomains` on a rule with a `regexFilter`, and applies it
on every host. A `regexFilter` that matches any URL says no more than which schemes the
rule is for, so such a rule is given the equivalent `urlFilter` instead, which the engine
does scope; a redirect that substitutes from such a pattern is left out.

A Firefox build reads and rewrites response bodies with `webRequest.filterResponseData`,
which is the engine's; Chrome has no such call.

### Tabs

The engine identifies a tab by its page, and that id is what messages, requests and
navigations carry. Safari identifies a tab by its `SafariBrowserTab` object, which is
what knows the tab's window, position and whether it is in front. The engine's
`tabs.get` gives the id of the page a `SafariBrowserTab` shows, and the runtime asks it
for each tab: those open as the global page starts, and each one that opens. The
extension sees one tab with one id, whatever tabs share its address and title. The calls
that describe tabs (`tabs.query` and `get`, `windows.get`, `getAll`, `getCurrent` and
`getLastFocused`, `tabGroups.get` and `query`) wait until every tab has been asked for.

When the engine replaces a tab's page while the tab stays open, as Safari does to show a
page it preloaded, the tab goes by the new page's id, and `tabs.onReplaced` reports the
change, as Chrome reports a tab whose page it swaps.

A tab that shows no page of the engine's is given a provisional id, at or above
`0x40000000`. It can be queried, activated, navigated and closed. Once it shows a page,
the tab goes by that page's id, and `tabs.onReplaced` reports the change; the
provisional id still names the tab in any call that takes a tab id.

The engine reports no `documentId`. The runtime gives each document a frame commits an
id of its own, and puts it on `webNavigation` events and frames, on `webRequest` details
and on a message's sender, with `documentLifecycle`, `frameType` and `parentDocumentId`.
An id holds its tab and frame, so any context can tell where it points, and the rest of it is
a digest of the commit, so contexts told of one commit agree. An extension page learns the
ids of earlier commits from the global page as it starts. A call naming an id that is no
document in that tab, or a document its frame has since replaced, is refused.

A browser's own pages are not Safari's, which hands such an address to another
application after asking the user which. `tabs.create`, `tabs.update` and
`windows.create` refuse one before any tab opens, with the error of the browser the
extension was built for: Chrome's `Invalid url: "chrome://extensions/shortcuts".`, for
its `about:` pages as well (`about:blank` aside); the new-tab page,
`chrome://newtab/`, opens as a new tab does, on the extension's own new-tab page where it
has one
(and, for its addresses that crash or hang the browser, `I'm sorry. I'm afraid I can't
do that.`), Firefox's `Illegal URL: about:addons`. A tab the engine does not have fails
with each browser's error, `No tab with id: 5.` or `Invalid tab ID: 5`. `tabs.move`
moves the tabs in the order given, to `index` and the places after it, and moves none
when one is missing. A tab that is still loading the address it was sent to is described
by that address, as `url` and `pendingUrl`, until it shows it. The `openerTabId` an
extension gives a tab is the one the tab reports, while that tab is open.

Safari leaves out the address and title of a page outside the extension's website
access. Chrome gives an extension with the `tabs` permission every tab's, an empty string
for a tab that has committed no address, and extensions read `url` from every tab
`tabs.query` gives them; such an extension gets an empty string for each that Safari
leaves out. One without the permission gets neither, as in Chrome.

In a Chrome build, what a script injected by `executeScript` evaluates to comes back
as Chrome makes it: a node, `document`, `location` or another host object is `{}`, a
value that refers back to an object it is part of is `null`, and functions, `undefined`
and numbers that are not finite are left out (`null` in an array). `tabs.executeScript`
refuses a `cssOrigin`, a file that is not JavaScript and one that is not UTF-8, with
Chrome's errors, and names a missing file as Chrome's `tabs` does (`Failed to load
file: "x".`), where `scripting` names it as `Could not load file: 'x'.`. A tab the
extension cannot reach is refused with Chrome's message for what it shows: `Cannot access a
chrome-extension:// URL of different extension` for another extension's page, `Cannot
access a chrome:// URL` for one of Safari's own, and otherwise `Cannot access contents of
the page.`, which extensions tell apart to ignore the pages no extension reaches.

Safari draws no tab groups, so the runtime keeps them: `tabs.group` and `ungroup`,
`tabGroups.get`, `query`, `update` and `move`, their events, each tab's `groupId`, and
`tabs.query({ groupId })`, as Chrome has them. A group's tabs are kept together in their
window. Collapsing a group hides its tabs from the tab bar with the engine's `tabs.hide`,
except the tab a window shows, and a group expands when one of its tabs becomes active.
A group's title and color are kept and reported, with nothing in Safari to show them.
Groups name their tabs by WebKit's ids, and are kept with the extension's settings so
that they outlast the global page. Safari restores tabs under new ids after the global page has
started, so a kept tab is found again by its address, for twenty seconds after the start. `permissions.contains` reports that a permission for
an API this host lacks, such as `history`, is not held.

`tabs.captureVisibleTab` takes Safari's picture of the visible part of the window's
active tab: a PNG as Safari gives it, or a JPEG drawn from it.

A tab with nothing in it, as Safari's Top Sites, has the address `about:blank`, as an
empty tab has in a browser; extensions call string methods on a tab's `url`. Safari
zooms each page by itself and tells no extension how far: `tabs.getZoom` is `1`,
`tabs.getZoomSettings` is automatic and per-origin at a factor of `1`, and setting
either fails.

### Saving files

Modern extensions save large files through the File System Access API: ask
`navigator.storage` for a directory, open a file handle, stream to it. None of that
exists here, so the runtime provides it, backed by memory. Writes are positional rather
than appended, because a multi-threaded downloader fills different offsets at once, and
they are serialised internally since callers do not await each one.

Handing the finished file to the browser is the harder half. The usual route is an
object URL plus a link with a `download` attribute, and whether a `blob:` URL loads
depends on the kind of view the page is in. So the runtime tests that first, on a
one-byte blob. If it fails in the global page, the file is saved as `downloads` saves
one (see "Downloads"). In another page, the bytes go over a port to the global page, which
does the same. So does a popover, whose object URLs load, but where Safari takes a click on
a link to one as a navigation of the tab beneath it and saves nothing.

`showSaveFilePicker` and `showDirectoryPicker` are provided too. Extensions often ship their
own fallback for browsers that lack them, and those fallbacks take the blob-URL route without
checking that it works — declaring the pickers keeps them from installing one. No dialog
appears. What is picked is a new folder in the engine's private file storage, so a long
recording goes to disk as it is written, and a file there is saved to Downloads a second after
it closes, unless the extension saves it first with the handle's `download()`. The folder is
removed ten minutes after the save or when the page goes away, and a later pick clears any
older than a day. A popover has no private file storage, so its picked files are in memory.

A file saved through the global page passes through memory, twice on the page route. A large
video is slow and memory-hungry there in a way it is not through a link.

`CacheStorage` gets a stand-in that never holds anything when it is missing, so code that
treats a cache miss as routine takes its own fallback path instead of throwing.

### Downloads

The engine has no downloads API, and Safari's global page cannot start a download: a
link with a `download` attribute does nothing there. A navigation in a tab does download,
but once Safari takes the response over, nothing more about it reaches an extension, not
even through `filterResponseData`. So `downloads.download` fetches the file in the global
page, with the extension's method, headers and body and the user's cookies, and reads the
body itself. That is what makes `bytesReceived`, `pause`, `resume` and `cancel` real:
pausing stops reading, so the server is held back rather than buffered against.

When the body is complete, a page saves it through a link with a `download` attribute.
The first choice is an ordinary web page the user has open, the active one if it can: the
bytes go to the content bridge there in pieces, and nothing shows or is added to Safari's
history. The page's scripts have no part in it. The bridge's world has its own copies of
the DOM's methods, and its link never joins the document, so in Safari a page's own
listeners, observers and replaced `Blob`, `createObjectURL` and `click` see nothing of the
file. That needs the bridge, which a bundle carries into the pages it can reach when it has
a background or content scripts.

With no such page, the runtime opens its own page, `wex/wex-download.html`. It opens in a
background tab that the runtime hides at once, in a new
window when none is open, and Safari's history lists it. The bytes reach it over a
`BroadcastChannel`, because an extension page in a tab cannot reach the global page's window, and a `Blob` sent across
does not save while an `ArrayBuffer` does. The tab closes once the file is saved. The
runtime keeps that tab out of `tabs` and `webNavigation`, as Chrome keeps its own pages
out of an extension's view, and leaves out the window Safari keeps hidden tabs in and
the empty tab Safari keeps there.

Chrome's rules apply. A bad URL, filename or header is refused with Chrome's message, and
a download that fails before it starts rejects with the reason, such as
`SERVER_BAD_CONTENT` for a 404. `onDeterminingFilename` is asked for a name, and a
`Content-Disposition` header or the URL supplies one otherwise. `search` and `erase`
filter and order as Chrome does, and the history is kept across restarts; a download that
a restart cut short is `interrupted` with `CRASH`. Firefox builds get Firefox's shape: the
item exists at once, and an HTTP error interrupts it rather than refusing the call.

What Safari keeps to itself stays out of reach. Safari picks the downloads folder and
renames a file whose name is taken, so `filename` is the name the file was given rather
than a full path, and a subfolder in the requested name is dropped. A saved file cannot
be opened, shown in the Finder or removed, and each of those calls fails, except `show`
and `showDefaultFolder`, which report nothing. Downloads the user starts in Safari are not
listed. A `blob:` URL from an extension page is read in that page and sent along with the
call, because the global page cannot read it. Like the File System Access route, the
whole file passes through memory.

### Storage

`chrome.storage.local` and `.sync` are kept by the global page in IndexedDB, which holds
as much as the bundle's 100 MB database quota allows; the global page's local storage
stops at about five megabytes. The store is read into memory when the global page
starts, so reads answer at once, and changes are written in batches, a `set` settling
once its change is saved. Values kept in local storage by an earlier conversion move
over on first start. Content scripts and pages in tabs have no store of their own and
send every read and write to the global page; changes come back to the contexts
listening for them, so `onChanged` fires everywhere. As in Chrome, it reports only the keys
a call changes: a Chrome build's `set` to the value already kept, or a `remove` of a key
with none, is left out. A `set` passes over a value JSON cannot hold, as `undefined`.
`getBytesInUse` counts the keys it is
asked about that have a value, or all of them for `null`, each as the UTF-8 bytes of the
key and of the value's JSON, as Chrome counts them; an extension may tell whether an item
exists by whether it counts any bytes. `storage.managed` holds nothing,
and gives back the defaults it is asked with. `--storage settings` moves the data into
Safari's extension settings instead, which survives a website-data reset but is meant
for small values.

The global page, popovers and the extension's pages in tabs share one `localStorage` and
one IndexedDB, as a WebExtension's pages share its origin's storage.

Safari keeps an extension's local storage, databases and caches when the user uninstalls
it, and clears only its settings. A browser removes them with the extension, and
extensions tell a first install from an update by what they find stored. So on the first
start after an install, which the settings show by holding no installed version, the
global page removes what an earlier install left before the extension's scripts run:
local storage, the caches, and the databases. The runtime notes the name of each
database the extension's pages open, in local storage, so that each is deleted by name
ahead of any opening of it; others an older bundle left are found and deleted as well.

### Cookies

`chrome.cookies` is the engine's. It covers the sites in the bundle's Website Access,
`HttpOnly` cookies included, whether or not a site is open in a tab.

### Clipboard

In the extension's own pages `navigator.clipboard.readText()` and `writeText()` work at
any time, with no user gesture. Content scripts keep the page's clipboard rules.

### What Safari cannot serve

Safari 7 crashes when it loads a bundle file whose name has no extension, and serves a
zero-byte file as a directory. The converter gives every such file an extension
(`serverlist` becomes `serverlist.txt`) and every empty file some content. The runtime
knows the renamed files, and points `getURL`, `fetch` and `XMLHttpRequest` at the stored
name when the extension asks for the original; a reference that goes around those — a
`src` attribute, say — fails to load instead of taking the browser down. The report
lists what was renamed.

A module script that is served with no MIME type is refused, so a `.mjs` file is given a
name ending in `.js` (`core.mjs` becomes `core.mjs.js`). The strings in the extension's
scripts and the `src` and `href` attributes in its pages that name such a file are
pointed at the new name, as are the manifest's background scripts, and the runtime maps
`getURL`, `fetch` and `XMLHttpRequest` for it as for any renamed file. A name assembled
while running, which none of those see, still asks for the old one.

Safari will not install a bundle with a folder named `resources`, in any case, at its
top level; deeper down one is fine. Such a folder becomes `resources_`. The manifest's
paths and the `src`, `href` and stylesheet `url()` references to its files follow it,
and the runtime maps `getURL`, `fetch` and `XMLHttpRequest` for the old paths. So do the
module specifiers in the extension's scripts (`import … from "/resources/…"`, a
re-export's, `import("…")`), which the engine resolves itself; the scripts' other
strings are left as they are, since a path in one may be a key that the extension builds
again while running.

Safari serves every bundle file with status 0, whether or not it loaded, and gives a
MIME type to `.html`, `.js` and `.png` alone. Extensions check `response.ok` or
`status === 200` before using a file of their own, and may never finish starting
without it, so in the global page, extension pages and content scripts,
`fetch` and `XMLHttpRequest` report a file of the extension's that did load as `200 OK`,
with the MIME type its name implies. A missing file still fails as a network error.

Workers do not run the runtime, so a `Worker` an extension page starts from one of the
extension's files, or from a `blob:` or `data:` URL, runs from a blob that installs the
same fix first. A blob's script is read when the worker is made, as pages often revoke the
blob at once. A worker started from a file keeps that file's `location` and resolves
relative URLs in `fetch`, `XMLHttpRequest`, `Request`, `importScripts` and nested workers
against it. A module worker imports the fix as a module before its own. Construct 3
games load their data from a worker and stay black without it. A `SharedWorker` is left
alone, since wrapping it would give every page a worker of its own.

Images bypass that fetch wrapper. A bundled SVG that fails to load in an `img`
is retried as a data URL with an explicit `image/svg+xml` type, both in extension
pages and in controls injected into websites. Only images belonging to this
extension are retried; the website's own images are left alone.
Repeated uses share one fetch, and a pending retry does not replace a newer image
source. Bundled stylesheets also embed their local SVG images as typed data URLs, so CSS
backgrounds, masks and `content: url(...)` images load correctly. Responsive
`picture`/`srcset` images and dynamically generated CSS keep the browser's own
loading behavior.

A browser fills in the `__MSG_name__` references in an extension's stylesheets as it
serves them, as `i18n.getMessage` gives them in the language of its interface; Safari
serves them as they are. So the converter fills them in, in the language of the browser
it runs in: the extension's own messages, and those every extension has (`@@ui_locale`,
`@@bidi_dir`, `@@bidi_start_edge` and the rest). An address of the extension's own,
`chrome-extension://__MSG_@@extension_id__/icons/a.svg`, becomes one relative to the
stylesheet, which reaches the file from an extension page and from a page a content
script styles, and which the step above then embeds. `i18n.getMessage` gives those
predefined messages too: `@@extension_id` is `runtime.id`.

### Toolbar images

Safari draws a toolbar image as a mask: only its alpha channel counts, and the button
is painted in the toolbar's own ink. A colour icon handed over as it is becomes a solid
silhouette, and a white glyph on a coloured tile becomes a plain tile.

So the toolbar image is drawn from the icon's colours. The colour covering most of the
icon is taken to be its body and kept solid; whatever differs from it clearly enough,
such as the glyph on the tile, is cut out. The result is sharpened after scaling, so it
stays legible at 16 pixels, and a one-pixel outline of the icon's shape is kept unless
the icon is a plain tile, so a busy icon does not fall apart into specks. The converter
writes `wex/toolbar-icon.png` and a 32-pixel `toolbar-icon@2x.png` for Retina screens
(`webext2safari/js/template.js`).

Extensions also switch icons while running, through `action.setIcon`. Safari takes a
toolbar image only from a file in the bundle (a `data:` URL is refused with "image needs
to be a safari-extension:// URL for this extension"), so a mask cannot be drawn at that
moment. Instead the converter draws one for every PNG in the folders the manifest's
icons live in, under `wex/toolbar/`, and the runtime swaps the icon the extension names
for its mask. An icon handed over as pixels (`imageData`) cannot be shown, and the
button keeps the icon it had.


A Firefox build's `menus` keeps Firefox's rules instead: an event page names its items
(`menus.create requires an id for non-persistent background scripts.`) and cannot give
them `onclick`, an item needs no title, and an id may not be used twice.

`contextMenus` keeps Chrome's rules: an extension whose background is an event page or
a service worker names its items and gives them no `onclick`, and keeps them across
restarts, as Chrome and Firefox keep them for it; an item's ID is unique and generated
ones are numbers; an extension has at most 1000 items; removing an item removes its
children.

Safari's page context menu takes no submenus from an extension. Each of the extension's
top-level items that applies to what was right-clicked, by its `contexts`,
`documentUrlPatterns` and `targetUrlPatterns`, is appended to it; an item with children is
not, nor are its children, and Safari leaves a disabled item out. The details a click
reports — selection text, link URL, media source, frame — are gathered by the content
bridge and handed over on the context-menu event before the menu is built. A title's `%s`
shows the selected text, cut at 64 characters.

Items for the `action`, `browser_action` or `page_action` context use Safari's native
toolbar-item menu instead, which preserves submenus, disabled and checked state. Safari shows
an item's menu as soon as its button is pressed, as a pop-up button's, and reports no click,
so the menu is the item's only when a click has nothing else to do: the action has no popup
and no `action.onClicked` listener. Otherwise a click shows the popup or reaches
`action.onClicked`, as Chrome's left click does, and the action's menu items, which Chrome
shows on a right click, are not shown.

## How the runtime is put together

Five files, in `webext2safari/runtime/`, ending up in `<bundle>/wex/`:

| File | Runs in | Does |
| --- | --- | --- |
| `wex-config.js` | everywhere | generated per bundle: the manifest, content-script table, locale list, page names, sizes |
| `wex-api.js`, `wex-content-api.js` | extension pages and the global page; content scripts | generated per bundle: the schemas Chrome checks the extension's calls against |
| `wex-core.js` | everywhere | events, match patterns, extension-URL resolution, `i18n`, callback/promise duality, and the adapters over the engine's `browser` that every context shares |
| `wex-global.js` | the global page | everything built on `safari.*` — tabs, windows, storage, the toolbar, alarms, menus — and the answering end of calls from other processes |
| `wex-page.js` | extension pages | gets the page its namespace as calls to the global page, and fits the popover to the popup |
| `wex-content.js` | injected in pages | the content-script API and the content-script loader |

Safari's engine does work for each file an extension injects, in every frame of every
page and for every extension, whether or not the file then runs there: six extensions
injecting seven one-line files each load a page of 60 small frames in about 780 ms,
against about 420 ms with one file each. So what is injected ahead of the extension's
own scripts goes to Safari as one file, `wex-bridge.js`: `wex-config.js`,
`wex-content-api.js`, `wex-core.js`, `wex-content.js` and the document-start trigger, in
that order. The bundle keeps apart only the files its pages and global page load too.
The extension's own scripts stay files of their own, as in the browser it was made for,
where one that fails to parse or throws leaves the others to run.

The runtime's files and the generated `wex-config.js` are ASCII: a page that names no
charset, as an extension's own background page may not, reads its scripts as Latin-1.

Every context starts with the engine's `browser` and replaces it with the completed
namespace, published as `chrome`, and also as `browser` in a Firefox build (see "The
browser an extension was built for"). The engine's object stays reachable to the
runtime, which builds on it.

Every method takes a callback and returns a promise, so code written against Chrome's
callback style and Firefox's `browser.*` promise style both work.

In a Chrome build, a call is checked against the schema of Chrome's API before it does
anything, as Chrome checks it, and one that does not fit throws Chrome's `TypeError`:
`Error in invocation of storage.StorageArea.set(object items, optional function
callback): No matching signature.` Extensions rely on the error, trying an enum value a
newer Chrome added and falling back when it throws. The schemas are Chromium's, read by
`tools/update-chrome-api.js` with Chromium's own loader into
`webext2safari/runtime/chrome-api.json`; the converter writes those of the namespaces the
extension can have into `wex-api.js`, and those content scripts can have into
`wex-content-api.js` (as JSON text, inside `wex-bridge.js`). The checks follow Chromium's `api_signature.cc` and
`argument_spec.cc`: which arguments stand for which parameters, an optional one perhaps
left out, then each value against its whole schema, properties, enums, bounds and all.
An integer is any whole number a double holds exactly, not only one of 32 bits as
Chrome's are: this browser's frame ids are larger (a frame below the top can be
588410519553), and an extension hands them back as it got them.
The call then goes on as Chrome's bindings hand it on, one argument for each parameter,
one left out as `undefined`, and the callback after them: `storage.local.get(callback)`
reaches the call as `(undefined, callback)`, as a polyfill's promise wrapper makes it.
A Firefox build's calls are not checked. Each enum of a namespace's types is there too,
named as Chrome's bindings name its entries: `chrome.offscreen.Reason.AUDIO_PLAYBACK`,
`chrome.runtime.OnInstalledReason.CHROME_UPDATE`.

Every event Chrome's schema gives a namespace is there to listen to, as Chrome's
feature for the event allows it to the extension (`tools/update-chrome-api.js` keeps
the events' names and what each asks of an extension), and a Firefox build's are
Firefox's. An event of something Safari never does or never tells fires never:
`runtime.onEnabled`, `onSuspend`, `onSuspendCanceled`, `onRestartRequired`,
`onBrowserUpdateAvailable`, `onConnectNative` and the user-script events,
`notifications.onShowSettings`, `windows.onBoundsChanged` and
`webRequest.onActionIgnored`.

`runtime.onStartup` fires when Safari starts with the extension installed, and not when
the extension is installed or updated, which `runtime.onInstalled` reports.
`runtime.onExtensionLoaded` fires with each of them, its `reason` `install`, `update` or
`startup`; Safari starting the extension again after it was turned off is a start.

Alarms are each browser's. Chrome keeps them through a restart, unless `alarmInfo` says
`persistAcrossSessions: false`, and fires one that came due meanwhile once the
extension's background scripts have run; it fires them no more than once a second for an
MV3 extension and once a minute for an MV2 one, and refuses an alarm with both `when` and
`delayInMinutes`, with neither those nor `periodInMinutes`, with its name given twice,
with a name over 1024 bytes, or beyond 500. Firefox keeps them for the session and fires
each when it is due.

The runtime's own traffic shares the engine's messaging with the extension's: calls to
the global page and event subscriptions. Its messages carry a `__wex`
key and its ports have names starting with `__wex:`, and neither is shown to the
extension's listeners. The global page answers a call from an extension page whatever
it names, and one from a content script only if it names something a browser gives
content scripts, which is storage.

An extension page has to have its namespace the moment its first script runs, before
it could have asked the global page what the namespace holds. So its members are stand-ins:
reading a property gives the member of that name, calling one calls the global page's
method of that name, and a member named like an event (`onChanged`) is an event. The
global page publishes the paths of its members, and the values of those that are plain
values such as enums and limits, in the extension's local storage; a page's stand-ins
follow that list, so a member the global page lacks is missing, as feature tests
expect, a namespace is an object that lists its members to `for…in` and
`Object.keys` (promise wrappers such as chrome-promise walk them), and
`chrome.contextMenus.ContextType.PAGE` is `"page"`.

WebKit has no `requestIdleCallback`, which extensions call, and the runtime supplies it
in the extension's pages. A Chrome build's pages also get `navigator.connection`, with
the estimates Chrome gives for a fast connection and a `change` event that does not fire. `navigator.locks`, `BroadcastChannel` and `SharedWorker` are
WebKit's own, and the global page, popovers and pages in tabs share their locks,
channels and workers.

A background service worker loads its other scripts with `importScripts`, which runs
each one as an inline script element, so its top-level `let`, `const` and `class` are
seen by the scripts after it, as in a worker. It also finds the worker's own
`serviceWorker`, already activated, its `registration`, and `skipWaiting`; a
notification the registration is asked to show goes through the web `Notification` API.

A page reaches its worker through `navigator.serviceWorker`. The offscreen document and
the popover live in the global page's process, so each is given one: its `ready`
registration's active worker posts to the global page, as a message event whose
`source` is the page's `Client` and whose `ports` are those the page transferred, and the
worker's `clients.matchAll()` lists the page, whose `postMessage` reaches the page's
`navigator.serviceWorker`. Extensions that hand their offscreen document a
`MessageChannel` this way talk to it as in Chrome. A page in a tab is in a web process,
and its `navigator.serviceWorker` reaches the worker through a shared worker of the
extension's, `wex/wex-worker-relay.js`, which the global page connects to as well and
whose ports carry the ports a message transfers; the worker's `clients.matchAll()` lists
the page by its address.

The pages the manifest's `sandbox` names get no extension API, as in Chrome, and the
converter gives every frame of the extension's HTML that shows one the sandbox, with the
flags of the manifest's sandbox policy or Chrome's (`allow-scripts allow-forms
allow-popups allow-modals`), so the page has an origin of its own and may `eval`. A frame a
script points at one is given the sandbox as its address is set.

A browser gives an extension a namespace that needs a permission only when the manifest
asks for it, and extensions test for a namespace to learn what they may do: a filtering engine may take `declarativeNetRequest`'s presence to
mean its filter lists are to become rules there, and block nothing through `webRequest`. So `declarativeNetRequest`,
`webRequest`, `webNavigation`, `cookies`, `downloads`, `notifications`, `contextMenus` and
`menus`, `alarms`, `idle`, `privacy`, `browsingData`, `offscreen`, `identity`, `scripting`,
`tabGroups`, `proxy`, `dns`, `storage`, `management` and Firefox's `theme` are there only
for an extension whose `permissions` or `optional_permissions` name one of the permissions
that give them, in its content scripts as in its pages (save what Firefox gives without
it: `theme.getCurrent` and `theme.onUpdated`), and so are
`runtime.connectNative` and `runtime.sendNativeMessage`, which need `nativeMessaging`.
Every bundle carries the whole runtime; what it leaves out, it leaves out of the API it
builds. In a frame the bridge is injected into, compiling the content-script runtime and
running the core's setup take a few milliseconds.

`runtime.id` is the id the extension's browser gives it: its Chrome Web Store id, or its
id for Firefox, where the converter knows it, and its bundle identifier otherwise.
Extensions compare it with their store id, and build their own addresses from it as
`chrome-extension://<id>/`, which the runtime resolves to the bundle. Some make one of their
addresses from another by setting its host to the id, which in Chrome is that host already;
setting the host of one of the extension's own addresses to its id keeps the bundle's host.

A Chrome build's bundle identifier is made from its Chrome id,
`com.webext2safari.<id>`, and a Firefox build's from its Firefox id, so that a converted
extension can tell another's bundle from the id its browser knows it by. Extensions
message each other through the engine: `runtime.sendMessage` and `runtime.connect` given
another extension's Chrome or Firefox id reach the bundle made from it, and its
`runtime.onMessageExternal` and `runtime.onConnectExternal`, and an id that is not one of
those is taken for a bundle identifier, or the engine's key for a bundle (the bundle
identifier and its signer's developer ID). `sender.id` is the sender's Chrome id where its
bundle was made from one, and the engine's key otherwise. An id naming the extension
itself, including the Chrome id it was converted from, keeps a message internal, and an
internal message's sender is named by the extension's own `runtime.id`.

Web pages that a Chrome build's `externally_connectable.matches` names get Chrome's
`chrome.runtime` for web pages, in the page's own world, from `wex/page-runtime.js`: `sendMessage` and `connect`, which
name the extension by its `runtime.id`, and `lastError`. Their messages and ports reach
`runtime.onMessageExternal` and `runtime.onConnectExternal` with a web page's sender: no
`id`, the page's `url` and `origin`, and its `tab` and `frameId`. Safari runs no content
script in a frame of the extension's popover, its bars or the pages of its global page, so
a page framed directly by one of those gets `chrome.runtime` from the global page instead,
in a script that `webRequest.filterResponseData` puts first in the page's `<head>`. A nonce
added to the page's `Content-Security-Policy` lets that script run. The page's messages
then go to the extension's page that frames it, as window messages from the page's origin,
and on to the global page. Chrome describes a frame of an extension page with no tab, and so
does the sender here: the page's `url` and `origin` only. A page framed by the global page
itself has nothing to reach the extension through, and gets no `chrome.runtime`. Safari can only reach a
page the bundle has access to, so the converter adds those sites to Website Access; the
extension gains no host permission for them. Firefox ignores the key.

`runtime.sendMessage` reads its arguments as each browser's bindings do. After a
callback, one is the message and three are the id, the message and the options; of two,
Chrome takes the first as an extension's id when it is a string or nothing, so
`sendMessage(null, message)` is a message to the extension itself and
`sendMessage("text", {})` one to an extension named "text", and Firefox only when it is a
string that is not empty, taking them otherwise as the message and the options.

`tabs.sendMessage` to a tab where nothing of the extension listens fails as Chrome fails
it, with `Could not establish connection. Receiving end does not exist.`, where the engine
would answer a tab whose content scripts or page do not listen with nothing. The content
bridge in each frame, and the runtime of an extension page shown in a tab, first answer
an internal question of whether the extension listens there.

`proxy` is the engine's, as each browser has it: a Chrome build gets `proxy.settings`
and `onProxyError`; a Firefox build gets `onRequest`, `onError`, and a `proxy.settings`
whose value is Firefox's proxy configuration, given to the engine as Chrome's
(`proxyType` `manual` becomes `fixed_servers` with `http`, `ssl` and `socks` as its
servers and `passthrough` as its bypass list) and read back the same way. A Firefox
build also gets the engine's `dns.resolve`, `tabs.captureTab` and `tabs.saveAsPDF`. An
extension with a `devtools_page` has it named in `Info.plist` as
`WebExtensionDevtoolsPage`, and the engine opens it with each Web Inspector; there it gets
the engine's `devtools.inspectedWindow` and `devtools.network`.

Safari's Web Inspector has no place for an extension's panel, so an extension whose code
makes panels shows them in a window of their own. The page the Inspector opens for such an
extension is the runtime's relay (`wex/wex-devtools-relay.html`), which opens a window for
the inspected tab. The window runs the extension's devtools page as a hidden frame, and
shows each panel `devtools.panels.create` makes as a frame behind a tab of the panel's
title. The devtools page and its panels share the window, as Chrome's share DevTools, so
`onShown` hands the devtools page the panel's own window. In both, `devtools.inspectedWindow`
and `devtools.network` are the engine's, carried out by the relay. Closing the Inspector
closes the window. Sidebar panes, `openResource` and panel icons are not shown.

Safari's popover sounds the alert for a key press its page leaves uncancelled, as
WebKit hands it on to the window; Chrome's and Firefox's popups do not. In a popover, a
key that nothing else cancelled is cancelled after every listener of the page's has had
it, unless it means something there: a shortcut, a key for a field, button or link, Tab,
Escape and Return, a scrolling key in a page that scrolls, and a printable key in a page
that listens for `keypress`, which a cancelled `keydown` does not send.

A call does what it says or fails, with an error the original browser could give, so
that no extension tells its user something happened that did not. Where part of what
was asked can be done and the API has no way to say which part, the call does that part
and succeeds.

A Firefox build's `runtime.getManifest()` gives the manifest as Firefox does after
reading it, the paths of the properties its schemas give a URL format (the background's
page and scripts, the options page, content scripts, popups, icons named by a string,
overrides) made into the extension's addresses, which extensions compare
`location.href` with; a Chrome build's gives it as written.

A Firefox build has Firefox's own namespaces as Firefox has them in a state Safari can
match. `contextualIdentities` is there as with containers turned off: every call fails
with `Contextual identities are currently disabled`, since Safari keeps one cookie store.
`browserSettings` reports how Safari behaves, and cannot be changed by the extension
(`levelOfControl` is `not_controllable`). `commands.update` keeps a new description; a
shortcut it asks for is not taken up. Each enum of Firefox's schemas is there as Firefox gives it, named
by its value in capitals (`browser.tabs.UpdatePropertyName.TITLE`), from
`webext2safari/runtime/firefox-api.json`, which `tools/update-firefox-api.js` writes
from Firefox's schemas.

Inside the browser the extension's address is Safari's, which its pages, senders, loads
and `getURL` all agree on. What leaves the browser is what the browser it was built for
would send: `chrome-extension://<id>/…`, or for a Firefox build `moz-extension://<uuid>/…`,
whose uuid Firefox makes up for each install and the converter makes up from the bundle's
id, the same for every install of the bundle (`i18n.getMessage("@@extension_id")` gives
it, as Firefox's does). Wherever the extension's own address goes to the web, it goes so,
written out, URL-encoded once or twice, or with its slashes escaped as JSON escapes them:

- the address and body of a `fetch`, an `XMLHttpRequest` or a beacon, from the global
  page, the extension's pages, its content scripts and the workers it starts; a body of
  text, form parameters or form fields, and one of bytes, a blob or a stream where it
  reads as UTF-8 text;
- a socket's or an event stream's address, and a socket's messages, text or bytes,
  in the order they are sent;
- a web address opened with `tabs.create`, `tabs.update`, `windows.create` or
  `window.open`, and a tab going to a web address with it in the address, by a link, a
  script or a form;
- the fields of a form an extension page sends to the web;
- the address of any request from any page or worker, a website's own included: the
  global page turns the request to the address as the web knows it, through the
  engine's requests, whose filter (`*://*/*safari-extension*`) holds only such requests.

All of this happens where websites cannot see it: in the extension's own contexts, its
content scripts' world, and the engine. A website's own functions are never changed,
since a site's bot checks notice functions that are not native (their source, their
shape, a fresh frame's to compare with). So a website is handed Safari's address, which
it can load, and the body of a request a website's own script sends goes as the script
wrote it.

A request for one of the extension's own files goes as it is. So a sign-in that sends its
server `getURL("app.html")` as its callback sends what the server knows: a server may
refuse a Safari address and accept this one. With `runtime.id` the extension's store id
and its requests naming the browser it was built for, such a site sees what the browser
would show it. Every request the extension's own documents make (the global page, its
popovers and bars, its pages in tabs, and the workers they start) carries that browser's
`User-Agent`, the one `navigator.userAgent` gives, and a Chrome build's request to a
secure address carries Chrome's client hints, `sec-ch-ua`, `sec-ch-ua-mobile` and
`sec-ch-ua-platform`, naming the brands `navigator.userAgentData` gives; a Firefox build's
carries none, as Firefox sends none. Within the extension's host permissions, its
requests also carry the browser's `Origin`, and its answer is let through CORS. A
website's requests, and those of a content script, which runs as part of the page, keep
Safari's. A synchronous `XMLHttpRequest` from the global page, a popover or a bar goes as
Safari sends it, as the engine applies no verdict to one. These requests through the
engine hold each request they match until the global page answers, so they match only
where the extension's documents are: tab -1, which holds the global page, its popovers
and its bars, and a tab while one of its frames shows one of the extension's pages, from
the moment the frame starts toward it. A website's loads in any other tab never wait on
them.

The way back is taken to the extension's page. A site that sends the browser to
`chrome-extension://<id>/oauth_callback.html?code=…`, which Safari cannot open, has the tab
go to the same path and query in the bundle instead: a redirect's `Location` is
rewritten on its way, from the sites that may open one of the extension's pages (below),
whose pages' and frames' loads alone wait on the engine's request for it; a navigation a
site's script, link or form starts is cancelled when the Navigation API announces it, and
a meta refresh is overtaken, as the head that holds it is parsed or, in the body, once
the document is, by the content-script bridge, which runs on every site; and the extension's
own `tabs.create` or `tabs.update` of such an address opens the page. As in Chrome, a
site opens only the pages the manifest's `web_accessible_resources` gives it, a version 2
manifest's to every site and a version 3 manifest's to the sites its `matches` name; any
other is cancelled. A click on a site's link to the address is announced as no navigation,
so the bridge cancels the click itself: the frame goes to the page the manifest gives the
site, or for a link that opens a new tab, the global page opens it in a tab beside the
site's. Safari does not say who opened a new tab, so
one that opens over a web page, with no popover showing, goes by that page's rights, by
`window.open` or a link's `target` alike: an address of the extension's typed into such a
tab opens only what that site may open, and a popover's or an extension page's link opens
any of the extension's pages.
A site that lets the extension's pages frame it, naming the extension's Chrome address
in its `Content-Security-Policy`'s `frame-ancestors`, gets the extension's Safari
address named beside it, so the extension's pages can frame the site here as in Chrome.
Such a site sees its frame's ancestors in `location.ancestorOrigins`, where Chrome names
the extension by its Chrome origin and Safari by its Safari origin, and WebKit lets no
script change the list. A site can tell which extension frames it by matching that origin
against a pattern for a Chrome address. So in a
web frame below one of the extension's pages, a Chrome build's `wex/page-world.js` (or, in a
frame outside a tab, the script the global page puts first in the frame's document) has a pattern that
does not match the extension's Safari origin, applied to it with `String.prototype.match`,
`RegExp.prototype.exec` or `RegExp.prototype.test`, answer as for its Chrome origin. A site
can also check who sent it a message by comparing the `origin` of `new URL(event.origin)`
with that of the extension's Chrome address. In such a frame, a URL at the extension's Safari
origin has the Chrome origin as its `origin`. A `chrome-extension:` URL, whose origin WebKit
gives as `"null"`, has its scheme and host as its origin, as in Chrome. A site may also compare
the message's `origin` itself with the Chrome address, and post back to the origin it was
given. So in such a frame a message from the extension's
Safari origin has its Chrome origin as `origin`. Where the frame's parent is the extension's
page, `parent` is a stand-in for that window. The stand-in's `postMessage` sends anything
addressed to the Chrome origin to the Safari origin, and the stand-in is also the `source` of
the page's messages, so `event.source === parent` holds. `top` cannot be replaced, and stays
the window itself. `ancestorOrigins` keeps Safari's origin, so a message the site posts to it
reaches the page.

Chrome's `identity` is as Chrome's is with no one signed in, Safari having no signed-in
profile: `getAuthToken` fails with `The user is not signed in.`, `getProfileUserInfo`
gives an empty email and id, and `onSignInChanged` never fires.

`sessions` lists the tabs and windows closed while the extension runs, most recent first,
up to 25, and `onChanged` fires as one closes or is restored. Restoring one opens its
pages again, in a tab or a window; Safari keeps no history for the extension to put back,
so the pages open without it. `getDevices` lists none. A Firefox build also gets
`forgetClosedTab`, `forgetClosedWindow` and the values an extension keeps on a tab or a
window, for the session.

`debugger` speaks Chrome's DevTools Protocol with a tab, carried out by what does the same
in this WebKit. An extension that asks for it is given access to every site, as Chrome's
permission gives it.

- `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent` and `Input.insertText` are WebKit's
  input from extensions, which pages receive as the user's own: trusted events with a user
  gesture. Keys are sent by their macOS key codes. Of a key's `commands`, those Safari's
  Edit menu performs (`selectAll`, `copy`, `cut`, `paste`, `pasteAndMatchStyle`, `delete`,
  `undo`, `redo` and the word case changes) are performed as choosing the menu item
  performs them, with the clipboard access the menu has; one that is disabled is passed
  over, as Chrome passes it over. The other commands are the key's own bindings.
- `Runtime.evaluate` runs in the page's own world through the tab's Web Inspector backend,
  which attaches the first time it is needed; the page's Content Security Policy does not
  apply. `awaitPromise` and `returnByValue` work. In `replMode`, code with a top-level `await`
  runs as the body of an async function, returning its last statement's value when that is
  an expression. A `return` outside a function fails with V8's "Illegal return statement".
  Objects come back without an `objectId`.
- `Runtime.enable` reports the page's console as `Runtime.consoleAPICalled` and its uncaught
  errors as `Runtime.exceptionThrown`; `Log.enable` reports its other console messages.
  Opening the tab's Web Inspector takes the backend over, and evaluation resumes once it
  closes.
- `Page.captureScreenshot` is the engine's capture of the tab, PNG or JPEG, with `clip`.
  `Page.navigate`, `reload`, `getLayoutMetrics`, `getFrameTree` and `bringToFront` work, and
  `Page.enable` reports navigations and loads from the engine's navigation events.
- `Network.enable` reports requests from the engine's `webRequest`, without bodies.
- With `Page.enable`, a JavaScript dialog the page opens is reported as
  `Page.javascriptDialogOpening`. `Page.handleJavaScriptDialog` presses the button of
  Safari's own panel, as the user would, and reports `Page.javascriptDialogClosed`; with no
  dialog open it fails with "No dialog is showing". A dialog the user answers is not
  reported closed. `Emulation.setFocusEmulationEnabled` and every method not named here
  fail as a method Chrome lacks does.

Safari has no side panel. `sidePanel` shows the extension's panel in a popover of its
toolbar button, narrow and tall as Chrome's panel is, beside the page it is for. With
`setPanelBehavior({openPanelOnActionClick: true})` and no popup, clicking the button
shows it; `open` and `close` show and hide it, with Chrome's errors. A panel set for one
tab shows when that tab is active. The behavior and the default options outlast a restart,
`onOpened` and `onClosed` fire as it shows and hides, and while it shows
`runtime.getContexts` lists it as a `SIDE_PANEL` context. Safari hides a popover at the first click elsewhere, where
Chrome's panel stays open, so the panel's page is kept while the popover is hidden and
shows again as it was, unless the tab it opens over has another panel. A panel the
extension opened with `open`, as one that shows the result of something the user is to do
on the page, shows again after a drag on the page hides it.

A popover takes the keyboard from the page it opens over, where Chrome's popup and side
panel leave it, so the click on the page that hides it is one that brings the window back
to the front. Safari gives the page that click's mousedown and mouseup and none of the
mousemoves of a drag it starts. While one of the extension's popovers shows, its bridge in
the page gives the page a move to where such a drag ended before the mouseup, so that a
page script measuring the drag (an area to capture, a box to draw) finds where it ended. `getLayout` reports the right
side. `open` does not require a click, as Chrome's does. `action.onUserSettingsChanged` is
there and never fires: the user adds and removes Safari's toolbar button by customizing
the toolbar, which is not reported.

Safari gives an extension no keyboard shortcuts of its own, so the bridge listens for
them, in the extension's own world where the page cannot see it, and so do the
extension's pages. A command gets the shortcut Chrome assigns it on a Mac: its suggested
key for the Mac, or its default one with Ctrl as Command, for at most four commands. A
shortcut pressed goes no further than the extension, as in Chrome; `_execute_action`
does what a click on the toolbar button does, and any other command is reported to
`commands.onCommand` with the tab. `commands.getAll` gives each shortcut in the Mac's
modifier symbols (`⇧⌘Y`). A shortcut works while a page the bridge is in, or one of the
extension's own, has the keyboard; one Safari's menus already use never reaches a page.

`tts` speaks with Safari's speech synthesis, in the global page, so that speech is the
browser's as Chrome's is: one page of the extension can stop what another started.
`getVoices` lists Safari's voices; an utterance has its `rate`, `pitch`, `volume`, voice
and language, waits with `enqueue` or else cancels those before it, and reports `start`,
`word`, `pause`, `resume`, `end`, `interrupted`, `cancelled` and `error` to its `onEvent`,
an extension page's included.

`omnibox`: Safari reports the searches its address bar makes, and one that starts with
the manifest's keyword and a space goes to `onInputEntered` instead, with what follows
and `currentTab`, as Chrome sends what follows its keyword. Safari shows no suggestions
and tells of no keystroke, so `sendSuggestions` and `setDefaultSuggestion` have nothing to
show and `onInputChanged` never fires.

`declarativeContent` applies its rules to the pages tabs show, and keeps them across a
restart as Chrome does. A `PageStateMatcher` matches by its `pageUrl`, as an
`events.UrlFilter`, and its `css` selectors, which the page reports as its content
changes; `isBookmarked` never matches, there being no bookmarks to ask. `ShowAction` shows
the action on the tab, whatever `action.disable` set, and `RequestContentScript` adds its
scripts and style sheets to the page. `SetIcon` has no effect, as a toolbar image comes
only from a file. `action.enable` and `disable` take a tab, as Chrome's do, and
`isEnabled` counts what the extension set, not what a rule shows. The badge colors the
extension sets are the ones `getBadgeBackgroundColor` and `getBadgeTextColor` read back,
though Safari draws its badge in its own colors.

`pageCapture.saveAsMHTML` writes the archive as Chrome does, a Blob of type
`application/x-mimearchive`: the content bridge in each frame describes its document as it
now stands, form fields included, and the files it shows, and the global page fetches
those files and the ones their style sheets name. A frame learns from a token its parent
posts to it which of the parent's frame elements it is, so that each frame is a part of
its own that its parent points to by `cid:`. A frame outside the extension's website access
has no bridge and is left out, as Chrome leaves out a frame the extension may not capture,
and the call fails with Chrome's error when the top frame is one. Video and sound are not
kept, as Chrome keeps none. A file the global page cannot fetch is left out, and a viewer
loads it from the web; the contents of canvases and closed shadow roots are not kept.

`printerProvider` is there for an extension that asks for it, with its four events, none of
which fires: Safari's print dialog never asks an extension for printers. `gcm` is there too:
Safari receives no Google Cloud Messaging, so `register`, `unregister` and `send` fail as
Chrome's do where GCM is disabled, with `GCM is disabled`, and its events never fire.
`tabCapture` is there as well, since a background may listen for its status as it starts:
Safari cannot hand an extension a
tab's audio or video, so `getCapturedTabs` answers an empty list, `getMediaStreamId` and
`capture` (which a service worker does not have) fail with Chrome's `Error starting tab
capture`, and `onStatusChanged` never fires.

`i18n.detectLanguage` and `tabs.detectLanguage` answer with Chrome's own language detector,
CLD3 (Google, Apache 2.0), as WebAssembly from the cld3-asm package (OJ Kwon, MIT).
`tools/update-language-detector.js` takes the module out of that package's browser
build and writes it to `webext2safari/runtime/cld3.wasm`, with what loading it needs
from the build's emscripten glue (its memory and function table, where its heap starts,
its static constructors) in `cld3.json`, and both licences in `cld3-LICENSE.txt`; every
bundle carries the three in `wex/`. The runtime loads the module in the global page the
first time a language is asked for, giving it the few library functions it calls, and
the extension's other pages and content scripts ask the global page, as each instance
holds a heap of its own (16 MB). A text's answer is Chrome's
(`extensions/renderer/api/i18n_hooks_delegate.cc`): the three commonest languages of its
first 10,000 bytes, as much as CLD3 reads, each with its share of them, none after the first unknown one and none
of CLD3's romanized ones (`xx-Latn`), reliable where each is and the text has 50 bytes or
more; CLD3 places even a word, unreliably (`OK` is Polish to it, as in Chrome). A tab's
language is that of the first 4,096 bytes of its page's text where CLD3 is sure of it, or
else the language the page declares, or else the one CLD3 is not sure of, as Chrome's
translate code decides it; `und` for a page none of these tells, or one the extension
cannot read. A page that declares Chinese as Traditional (`zh-TW`, `zh-HK`, `zh-Hant`) or
Simplified (`zh-CN`, `zh-SG`, `zh-Hans`) is `zh-TW` or `zh-CN`, as in Chrome, even where
CLD3 finds Chinese.

`publicSuffix` answers from the Public Suffix List, its ICANN and private rules alike, as
Chrome does. `tools/update-public-suffix.js` writes the rules to
`webext2safari/runtime/public-suffix-list.txt`. A Chrome build carries the file, and Chrome's
permission warnings beside it, in `wex/`, and a page reads them the first time a call needs
them, so the calls are answered where they are made and stay synchronous in every page. The `display` encoding shows
a label in Unicode when its letters are Latin with accents, or all of one script that
cannot pass for Latin (Chinese and Japanese, Korean, Arabic, Hebrew, Thai, Devanagari);
any other label stays in punycode, which Chrome also falls back to when it cannot rule
out a lookalike.

`dom.openOrClosedShadowRoot` works in the extension's own pages as well as in content
scripts: the runtime keeps each closed shadow root a page attaches. A version 2 manifest
has Chrome's older calls: `extension.sendRequest` with `onRequest` and
`onRequestExternal`, `tabs.sendRequest`, `getSelected` and `getAllInWindow`, and
`tabs.onSelectionChanged`, `onActiveChanged` and `onHighlightChanged`.
`runtime.restart` and `restartAfterDelay` fail as Chrome's do outside ChromeOS kiosk
mode. A namespace's constants are Chrome's (`tabs.TAB_INDEX_NONE`, the
`declarativeNetRequest` limits).

`management` knows the extension itself and no other: `getAll` lists it alone and `get`
of another id fails, as it does in Chrome for one not installed. Its `installType` is
`normal` for an extension converted from a store or an archive and `development` for
one converted from a folder, as Chrome reports one loaded unpacked; some extensions
refuse to run as the latter. Its `homepageUrl` is the manifest's `homepage_url`, or, for
an extension whose manifest names the Web Store's `update_url`, its page in the store, as
Chrome gives it; `updateUrl`, `versionName` and `icons` are the manifest's. `uninstallSelf` fails,
since only the user can uninstall an extension in Safari. Without the `management`
permission an extension has `getSelf` and `uninstallSelf`, and in a Chrome build
`getPermissionWarningsByManifest`, as the browsers give them; with it, the rest.
`getPermissionWarningsByManifest`, and `getPermissionWarningsById` for the extension
itself, give the warnings Chrome shows, in English, worked out as Chrome works them out:
the manifest's permissions, hosts and content scripts become Chrome's permission ids, and
Chrome's rules, in their order, each take the ids they speak for. A host's registry is
read from the Public Suffix List, so that `*.com` warns of every site and a host under
several registries is named once. `tools/update-permission-messages.js` writes the rules,
the permission names and the messages from a Chromium tree into
`webext2safari/runtime/permission-messages.json`. A native messaging port
(`runtime.connectNative`) disconnects at once, with the `error` a browser gives when it
finds no host, and `runtime.sendNativeMessage` fails with the same. `tabs.setZoom` and
`tabs.setZoomSettings` fail, as do `tabs.discard` and `theme.update`.

`browsingData` removes cookies, through the engine's cookie API and within the
extension's website access, keeping to the `origins`, `hostnames` and `excludeOrigins`
given; cookies have no creation time, so a removal of only the data since some time
leaves them be. A removal of the cache empties the caches the engine keeps in memory.
The rest (history, the disk cache, the sites' own storage) is out of an extension's
reach, so a removal that names some of it succeeds for the part that can be done, and
one that names nothing else fails.

`identity.getRedirectURL` is the address the original browser gives: Chrome's
`https://<id>.chromiumapp.org/` for the extension's Chrome id, or Firefox's
`https://<hash>.extensions.allizom.org/` for a Firefox build's gecko id, which a sign-in
provider has on record. `launchWebAuthFlow` opens the provider's page in a tab and ends
with the address of the first load that goes to the redirect host, then closes the tab.
A flow that may not ask the user anything runs in a hidden tab and fails with "User
interaction required." when its page settles without sending it on; closing the tab
fails a flow as the user declining it. `getAuthToken`, which needs Chrome's own Google
account, fails.

`privacy` has the settings of the browser the extension was built for. Network
prediction and hyperlink auditing are the engine's, which the extension controls. A
feature Safari does not have (Chrome's Topics, FLEDGE, ad measurement, related website
sets, protected content, and its Google services) reports off and may be set off, but
not on. Safari decides the rest itself, and each reports Safari's own value where it is
known (no Do Not Track, third-party cookies blocked) and the browser's default
otherwise, as a setting the extension cannot control; a value the extension sets leaves
it as it is, which Firefox answers with `false` and Chrome takes without complaint, as
each does for a setting it cannot change. The extension's pages share the global page's
settings. `theme.getCurrent` describes the browser's own theme, as Firefox describes its
default, and `sidebarAction`, with no sidebar in Safari, opens the sidebar page as a
tab. `runtime` carries Chrome's
enums (`PlatformOs`, `PlatformArch`, `OnInstalledReason`, `ContextType` and the rest),
as do `contextMenus` (`ContextType`, `ItemType`) and `tabs` (`ZoomSettingsMode`,
`ZoomSettingsScope`).

Legacy Safari base URIs carry a per-session token in the path
(`safari-extension://<id>/<token>/`). A root-relative path the page derived from its own
location already has the token; one hardcoded in the extension's source does not.
`getURL` tells them apart, because resolving both the same way either doubles the token
or drops it.

### The browser an extension was built for

Extensions tell browsers apart and take the code they have for the browser they find,
and a build has only ever run in the browser it was made for. So the extension's own
pages and content scripts find that browser:

| | Firefox build | Chrome build |
| --- | --- | --- |
| `navigator.userAgent` | Firefox's for macOS | Chrome's for macOS |
| `navigator.vendor` | `""` | `"Google Inc."` |
| `navigator.userAgentData` | absent | Chrome's client hints |
| `browser` | the namespace | absent |
| `runtime.getBrowserInfo` | Firefox's name, vendor and version | absent |
| `theme`, `contentScripts`, `menus` | present | absent |
| `sidebarAction` | for a manifest with `sidebar_action` | absent |

The version is the browser's current one, Firefox 158 and Chrome 156 at the time of
this runtime, or the least the manifest asks for if that is later; it wants raising as
the browsers move on. `action` is a version 3 manifest's; `browserAction` and
`pageAction` are a version 2 manifest's that names one, as in both browsers. Safari's
`safari` object is not there for the extension's pages and content scripts, which some
use to detect Safari; the runtime keeps it for itself. Safari's own code looks for
`window.safari` when one of its calls runs, and `canLoad` answers nothing without it, so the
runtime puts it back for the length of each Safari call it makes from a page or content
script (`canLoad`, `dispatchMessage`, `setContextMenuEventUserInfo`, a popover's `hide`).
The global page keeps it, since Safari's own tab objects there read `window.safari` and
give no URL or title without it; its scripts instead find the name `safari` bound to
nothing by a script the converter loads after the runtime and before them
(`wex/wex-background-globals.js`, `let safari;`), so a background that takes Safari's
object for an old Safari extension's (building its pages' addresses from
`safari.extension.baseURI`, say) does not. `window.safari` is still Safari's. A bundle in
which a script declares a `safari` of its own goes without the binding, which would
collide with it.
Web pages keep Safari's identity. Firefox's ways of reaching a page's own objects from a
content script (`wrappedJSObject`, `exportFunction`, `cloneInto`) are not there;
extensions test for them before using them.

## What this browser build actually does

Measured with the probe below on Safari 7.0.6 over the backported WebKit, rather
than assumed:

| | |
| --- | --- |
| `beforeload` fires for page subresources | yes — and `preventDefault()` really stops the load |
| `beforeload` sees a detached `new Image()` | **no** — it is a document event, so anything that never joins the document is invisible to it |
| `canLoad` returns what the global page wrote | yes, synchronously |
| `activate`, `deactivate`, `open`, `close` | **capture phase only** — a bubble-phase listener never sees them |
| `navigate`, `beforeNavigate` | both phases |
| Global-page timers | full rate (27ms for a 25ms interval), so the polling backstop works |
| `setContextMenuEventUserInfo` | present, and the details reach the `contextmenu` event |
| Runtime-appended context menu items | appear, and clicking one reaches the `command` event |
| The `popover` application event | fires, both when the popover opens and when it is renavigated |
| Popover resize / renavigate at runtime | both work |
| An injected script runs once per document | **no** — see below |
| `navigator.locks`, `BroadcastChannel`, `SharedWorker` in the global page and popovers | yes, shared with the extension's pages in tabs |
| `requestIdleCallback` | **no** — the runtime supplies it |
| An extension page in a tab shares storage with the global page | yes, `localStorage` and IndexedDB, as the popover does |
| One `executeScript` injection's top-level `let` or `const` is seen by the next | yes; the content scripts the bridge evaluates rely on the rewrite in "Content scripts" |
| `declarativeNetRequest` scopes a `regexFilter` rule by `requestDomains` | **no** — the rule applies on every host |
| `documentId` on navigation events, frames and request details | **no** — the runtime supplies it |
| A content script's `<script src>` for an extension file loads whatever the page's CSP says | yes |
| A global page whose file name starts with `_` | **never runs** |
| Safari's tab objects in a global page without `window.safari` | give no `url` or `title` |
| `safari.self.tab.canLoad` from a page without `window.safari` | **answers nothing** |
| The picture-in-picture API | **no** |
| `declarativeNetRequest` rules leave a tab's requests for extensions' own files alone | yes |
| `beforeload` in extension pages | yes, and the load an element is given while it is announced is dropped |
| A relative reference that climbs above the bundle's root stops there | yes |
| A `webRequest` redirect of a page's `XMLHttpRequest` or `fetch` to a `data:` URL | yes, cross-origin too, with status 200 |
| A `declarativeNetRequest` redirect to anything but HTTP or HTTPS, or the extension's own page by `extensionPath` | **refused** |
| `declarativeNetRequest` `modifyHeaders` changes response headers | **no** — only request headers; the runtime applies the response headers |
| `declarativeNetRequest.updateDynamicRules` before the dynamic rules were ever read | yes |
| `webRequest` tells of a request a `declarativeNetRequest` rule blocks or redirects | **no** — the engine applies the rules before the request reaches it, so a redirected request is told of at its new address and a blocked one not at all |
| A `modifyHeaders` rule with only `requestHeaders`, or only `responseHeaders` | yes |
| A `<video>` or `<audio>` element plays one of the extension's own files | yes |
| The global page, popovers and extension pages post web notifications | yes, granted without asking |
| `modifyHeaders` on any header | **no** — the engine refuses a rule naming one it does not know, such as `Permissions-Policy` |
| A `webRequest` redirect of a page's `XMLHttpRequest` or `fetch` to an extension file | yes, cross-origin too, with status 0, as Safari serves every extension file |
| A top-level bundle folder named `resources` | **refused** at install |

Two of these shape the runtime.

**Injected scripts are evaluated many times per document.** Every page load
permanently adds one more evaluation for every page loaded afterwards: a fresh
document was seen being injected 10, then 22, then 24 times in one session, each
evaluation with its own identity, and the count never falls — closing tabs and
even reinstalling the extension do not reset it. Left alone, a content script
would end up running dozens of times on a page, with every listener, timer and
message multiplied to match. The content bridge therefore turns away every evaluation
after its first, without marking the page: it marks its own world, and an evaluation in
a world of its own asks the document by a cancelable event that the first bridge
cancels, whose name holds the bundle's session token, so a page that has not learned the
token cannot listen for it or answer it. The name names the extension: every converted extension's bridge shares the
document, and one they all used would let the first extension's bridge turn every other
one away. (With the WebKit this was last checked on, a document got one evaluation,
including after reloads from Extension Builder.)
The probe measures this
directly and reports 1 of N evaluations getting past the marker. This is a host
bug rather than something the conversion causes, so it is worth knowing about
for any legacy extension with content scripts, not only converted ones. It was
observed with an extension loaded through Extension Builder; whether a
normally-installed `.safariextz` is affected the same way is untested.

**Content scripts get no background-only namespaces.** A browser gives a content
script no `chrome.tabs`, and extensions lean on that: one may decide which
context it is in with `chrome.tabs ? … : …`, and defining it there would send its
content scripts down the extension-page branch. The content bridge exposes only what a
browser does — `runtime`, `extension`, `storage`, `i18n`, `dom` — and the tests
assert that the rest stay absent.

## Debugging a converted extension

Convert with `--debug` and the runtime opens two channels that work from any web page
through AppleScript, without opening an inspector or the popover — a broken background
looks exactly like a broken bridge from outside.

**Reading.** The global page publishes its state onto every page whose bridge asks for
it, every two seconds, as `data-wex-diagnostics`: how many popovers and toolbar items Safari actually built, the
popover's `contentURL` and visibility, how many `action.onClicked` listeners the
background registered, how many of the open tabs it has identified, and a timestamped
log including any background-script error or rejection no one handles, with what was
thrown: an error's name, message and stack, or the value itself. The bridge keeps a record of its own in
`data-wex-bridge-log`, which says what went wrong on the page's side even when the
global page never hears from it.

The global page itself can be inspected: Extension Builder has an Inspect Global Page
button once the extension is installed. So can the popover (right-click it, Inspect
Element). A page's content-script world cannot, but the global page's console can run
code there through the engine:
`chrome.__wexNative.tabs.executeScript(tabId, { code: "…" })` (a Chrome build's global
page has no `browser`). The page's own world is reached with
`chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func })`.

```sh
osascript -e 'tell application "Safari" to repeat with w in windows' \
  -e 'try' -e 'return (do JavaScript "document.documentElement.getAttribute(\"data-wex-diagnostics\")" in current tab of w) as text' \
  -e 'end try' -e 'end repeat' -e 'end tell'
```

**Driving.** Setting `data-wex-command` on any page relays a command to the global page,
so a step can be exercised on demand instead of by asking someone to click and describe
what happened. `inspectPopover` dumps the popover object's real properties,
`showPopover` calls it directly, `reportClick` fakes a toolbar click, and `openOptions`
opens the options page. Each logs its own outcome, so a failure lands on the step that
failed.

```sh
osascript -e 'tell application "Safari" to do JavaScript \
  "document.documentElement.setAttribute(\"data-wex-command\",\"showPopover\")" \
  in current tab of front window'
```

## Tests

```sh
node tests/run.js                          # the runtime, against a simulated Safari
node tests/convert.js                      # the converter's rewrites, rulesets, website access, identity
node tests/offscreen.js                    # offscreen lifecycle and messaging
node tests/network.js                      # native request identity and absence of page helpers
node tests/i18n-inline.js                  # catalogues carried in the config, and read from their files
node tests/store.js                        # the store pages' "Add to Safari" button
node tests/core-fixes.js                   # match patterns, i18n fallback, the content-script scanner, file system stand-in
node tests/core-fixes-2.js                 # response-header rules, document targeting, injected files, legacy requests
node tests/global-fixes-1.js               # navigations from the web, storage, toolbar, side panel, debugger
node tests/global-fixes-2.js               # saving files, tab groups, moving tabs, alarms, actions
node tests/global-fixes-3.js               # declarativeContent, sign-in, tab events, menus, page capture, a site's new tabs
node tests/page-fixes.js                   # the bridge's boundary with web pages, content-script order, extension pages
node tests/converter-fixes.js              # archives, images and pages that are unusual or hostile
node tests/smoke.js build/*.safariextension  # every converted bundle boots
python3 -m unittest tests/test_diagnostics.py  # the diagnostics server
```

`tests/fake-safari.js` stands in for both halves of the host. For Safari: an application
with windows and tabs, a global page other contexts can reach, toolbar items and
popovers, a settings store. For the engine: a `browser` object per context, and the
routing of messages, ports, injections, requests and tab events between them.
`tests/run.js` builds a fixture bundle and checks storage round-trips and change events,
message passing in every direction, ports, how a Safari tab comes to be known by the
engine's id, content-script gating by pattern and by frame, injection and its return
values, blocking and header-rewriting verdicts, that `declarativeNetRequest` calls
reach the engine from the global page and from extension pages, cookies, alarms, flattened menus, toolbar clicks, that a second injection into
the same document does not run anything twice, that content scripts are not given
background-only namespaces or a way to call them, and that a page in a tab gets the
whole API and the global page's local storage. It also checks string-message callback
and promise overloads, the bundled SVG image fallback, including concurrent loads and
source changes, shared top-level declarations across content scripts and injected
files, storage that outlasts a restart, rule
restatement for the engine's regular expressions, `documentId`, and tab id
replacement. The simulated Safari has an IndexedDB of its own, as much of it as the
runtime's storage uses.
`tests/smoke.js` boots each converted bundle's own generated config and
checks that everything `Info.plist` names is really in the bundle and that Safari can
serve every file in it. It then runs the bundle's whole global page, the extension's
background scripts included, each script on its own as Safari runs them: a runtime file
that throws fails, and what the extension's scripts throw or leave rejected is noted, as
is a background that listens for no message its pages send. With the `fake-indexeddb`
package installed (`NODE_PATH` may point to it), the background gets a whole IndexedDB.
The simulated Safari delivers a message or a response as the engine does, made in the
receiving page's own JavaScript world, and gives each extension page a `Location`.

Set `WEX_VERBOSE=1` to see the runtime's logging during a run.

An installable release also gets a clean-install host check: convert and install a fresh
bundle, open a permitted web page, and run `diagnostics/probes/active-tab.js`. The page
must report its content bridge and extension id without relying on a prior registration.
For changes involving `webRequest`, exercise both an uncached network response and a
page service-worker/cache response, and compare any difference with the source browser
before classifying it as a compatibility limitation. The simulator remains the regression
suite, but it does not stand in for this real-WebKit acceptance check.

### Running extensions' test suites

The browsers test their extension APIs with extensions that run their own tests through
`chrome.test` (Chromium's `chrome/test/data/extensions/api_test`) or `browser.test` (the
web-platform-tests' `web-extensions` directory, written for every browser). Converted
with `--test-api`, such an extension has that API, Chromium's, in every context:

- `--test-api standard` is the W3C proposal's: a test passes when it returns, or when
  the promise it returns resolves, and `succeed()` and `fail()` are themselves failures.
  A Chrome build keeps `browser`, which the web-platform-tests use.
- `--test-api chrome` is what Chromium's own tests expect: a test passes when it calls
  `succeed()`, or when the last of its `callbackPass()` callbacks runs.

What the tests report, from any context, the global page keeps in `WEX.testLog`, in
order: `testStarted`, `testFinished` with its result and the failed assertion's message,
`log`, `message` and, when every test is done, `pass` or `fail`. A harness answers a
`test.sendMessage` with `WEX.testReply(id, reply)` and sends the extension a
`test.onMessage` with `WEX.testSend(message)`; `test.getConfig()` gives the JSON of
`--test-config`.

## Limitations worth knowing before you start

- `declarativeNetRequest` `block` rules stop what pages and content scripts ask for, not the
  global page's own requests, which Safari's content blockers do not cover. Header rules
  apply to those too.
- The bundle needs the WebKit named at the top; on a stock Safari 7 nothing runs.
- Keyboard shortcuts only while a page the extension can reach, or one of its own, has
  the keyboard. No native messaging, no bookmarks or history. Devtools panels
  show in a window of their own, not in the Web Inspector.
- A Chrome build cannot read or rewrite response bodies, as in Chrome; a Firefox build's
  `filterResponseData` is the engine's.
- A background service worker runs in the global page, which is a document. It gets
  `importScripts`, and the page is a `ServiceWorkerGlobalScope` and a
  `WorkerGlobalScope`, which code checks for
  to learn that it runs in a worker, but the worker's `install` and `activate` events never
  fire. Its `fetch` event fires for what the
  extension's own pages load from the extension's address, and for navigations there: the
  engine's `webRequest` holds such a load while the global page asks the worker's `fetch`
  listeners, and a response one gives with `respondWith` replaces the load, its body as a
  `data:` address, or a redirect as the load's redirect. Only a worker with a `fetch`
  listener has its pages' loads held.
- Synchronous messaging built on a `declarativeNetRequest` redirect to a `data:` URL
  fails, since the engine refuses such a redirect; the same built on `webRequest` works.
- An extension that locks its own realm down with a sandbox that takes globals away finds the
  runtime's additions to the realm as it starts, and parts of it may not run.
- Tabs cannot be discarded or zoomed, the theme cannot be changed, and an extension
  cannot uninstall itself; each call fails.
- `web_accessible_resources` governs navigations only. Safari serves any file of the bundle
  to a page that requests it at the address with the session token, and a page can read that
  token from Resource Timing, whose entries name the scripts injected into it.
- The extension's address typed into Safari's address field fails, and macOS asks for an
  application to open it: the address reaches no extension.
- A `window.open` stand-in's `document` offers `open`, `write`, `writeln` and `close`, and
  no other part of a document.
- `browsingData` can remove cookies and the in-memory cache only.
- Windows open as ordinary browser windows: `windows.create` has no say over size,
  position or type.
- Notifications go through the web `Notification` API to the Notification Center, which
  Safari lets every enabled extension use. A notification shows with its text; its click
  and its closing are reported; its buttons, images and progress bar are not shown, and a
  list's items and the context message are added to its text.
- `downloads` sees only the extension's own downloads, holds each file in memory until it
  is saved, and cannot open, show or remove a saved file (see "Downloads"). Saving through
  the File System Access API also holds the file in memory.
- The extension's address is not changed inside a body of bytes that does not read as
  text, such as a protocol buffer, whose format alone says where the address is and which
  lengths around it would change with it, nor inside the body of a request a website's
  own script sends, which neither the engine's requests nor anything a site cannot see
  can change (a request's address is changed). Handing the site Chrome's address instead
  would leave it unable to load it: Safari's `beforeload` lets an extension's content
  script turn an element's load to the real address, which the site then reads back,
  and a site's `fetch`, `XMLHttpRequest` and style sheets announce none.
- The toolbar badge holds a number. A Chrome badge that is a dot or a `!` shows as `1`.
- Safari draws toolbar images in one colour, using only their alpha channel. The
  converter draws the toolbar image from the extension's icon (see "Toolbar images"),
  which keeps a glyph on a tile and most simple icons recognizable; busy, many-coloured
  icons come out noisy, and a hand-made image is better for those.
- Safari reads the size of a toolbar image from the pixel density the PNG declares, not
  from its pixel count, so an icon exported at 600 DPI is 32 pixels across but under four
  points wide and the button shows a speck. Every PNG copied into a bundle has its density
  declaration dropped, and an extension that swaps its icon at runtime is handed the 16px
  one, the size the bundle's own toolbar image is built at.

Extension pages are navigated through WebKit's tab API. Safari's legacy tab URL
setter lowercases extension identifiers, which its resource loader treats as
case-sensitive. New unbound tabs use a unique blank URL to obtain their WebKit id
before loading the requested page.
