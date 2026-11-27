// Shared foundations for the WebExtension compatibility layer.
//
// Loaded first in every context the converted extension runs in: the global
// page, extension pages, and injected content scripts. It defines
// the `WEX` namespace of helpers the context-specific layers build on, and
// nothing that depends on which context it is in.
//
// `WEX_CONFIG` (wex-config.js, written by the converter) is already defined by
// the time this runs.

var WEX = (function (g) {
  "use strict";

  var CONFIG = g.WEX_CONFIG || {};

  // The page's own XMLHttpRequest, as it is before the extension's code
  // runs: a background made for a service worker, which has none, may put a
  // shim of its own in its place, and a monitoring library wraps its methods
  // to record the page's requests, neither of which the runtime's reads of
  // the bundle go through.
  var PageXHR = g.XMLHttpRequest;
  var xhrOpen = PageXHR && PageXHR.prototype.open;
  var xhrSend = PageXHR && PageXHR.prototype.send;

  // The context's own localStorage, as it is when the runtime starts: in the
  // global page of a service worker the worker can give its global a
  // localStorage of its own (installWorkerGlobals), and the runtime keeps
  // its records in the real one.
  var LOCAL_STORAGE = (function () {
    try {
      return g.localStorage;
    } catch (e) {
      return null;
    }
  })();

  function localStorageOf(global) {
    if (global === g) {
      return LOCAL_STORAGE;
    }
    try {
      return global.localStorage;
    } catch (e) {
      return null;
    }
  }

  // ------------------------------------------------------------------ //
  // Events
  // ------------------------------------------------------------------ //
  // chrome.* event objects: addListener/removeListener/hasListener, plus an
  // `emit` the shim uses internally. Listener exceptions are contained so one
  // bad listener cannot stop the others from running.
  function Event(name) {
    this.name = name || "";
    this.listeners = [];
  }
  Event.prototype.addListener = function (fn) {
    if (typeof fn === "function" && this.listeners.indexOf(fn) < 0) {
      this.listeners.push(fn);
    }
  };
  Event.prototype.removeListener = function (fn) {
    var i = this.listeners.indexOf(fn);
    if (i >= 0) {
      this.listeners.splice(i, 1);
    }
  };
  Event.prototype.hasListener = function (fn) {
    return this.listeners.indexOf(fn) >= 0;
  };
  Event.prototype.hasListeners = function () {
    return this.listeners.length > 0;
  };
  Event.prototype.emit = function () {
    var args = arguments;
    var out = [];
    this.listeners.slice().forEach(function (fn) {
      try {
        out.push(fn.apply(null, args));
      } catch (e) {
        WEX.log.error("listener for " + this.name + " threw", e);
        if (WEX.testException) {
          WEX.testException(e);
        }
      }
    }, this);
    return out;
  };
  // Blocking events (webRequest) need the first non-undefined return value.
  Event.prototype.emitForResult = function () {
    var results = this.emit.apply(this, arguments);
    for (var i = 0; i < results.length; i++) {
      if (results[i] !== undefined && results[i] !== null) {
        return results[i];
      }
    }
    return undefined;
  };

  // ------------------------------------------------------------------ //
  // Callback / promise duality
  // ------------------------------------------------------------------ //
  // Chrome-style APIs take a callback; Firefox-style (`browser.*`) return a
  // promise. Every shimmed method does both, so code written against either
  // dialect works unchanged. The callback is deferred so a caller that also
  // reads the return value is never re-entered before it gets it.
  function done(cb, value) {
    if (typeof cb === "function") {
      setTimeout(function () {
        try {
          cb(value);
        } catch (e) {
          WEX.log.error("callback threw", e);
          if (WEX.testException) {
            WEX.testException(e);
          }
        }
      }, 0);
    }
    return Promise.resolve(value);
  }

  // runtime.lastError is the failure's only while its callback runs.
  function fail(cb, message) {
    if (typeof cb === "function") {
      setTimeout(function () {
        WEX.lastError = { message: String(message) };
        try {
          cb(undefined);
        } catch (e) {
          WEX.log.error("callback threw", e);
          if (WEX.testException) {
            WEX.testException(e);
          }
        }
        WEX.lastError = null;
      }, 0);
      return Promise.resolve(undefined);
    }
    return Promise.reject(new Error(String(message)));
  }

  // Some call sites pass options they may omit, with the callback sliding into
  // the options position.
  function shiftCallback(opts, cb) {
    if (typeof opts === "function") {
      return { opts: {}, cb: opts };
    }
    return { opts: opts || {}, cb: cb };
  }

  // ------------------------------------------------------------------ //
  // Extension URLs
  // ------------------------------------------------------------------ //
  // Legacy Safari base URIs carry a random per-session token in the path:
  // "safari-extension://<bundle-id>-<team>/<token>/". A root-relative path the
  // page derived from its own location already contains that token, while a
  // path hardcoded in the extension's source ("/images/icon.png") does not.
  // Resolving both against baseURI would double the token; resolving both
  // against the origin would drop it. Tell them apart by looking for the token.
  // Safari's own extension object. The extension's code does not see it
  // (see "The browser an extension was built for"), so the runtime keeps it,
  // and a frame whose world lacks one finds its top frame's.
  var hostSafari = (function () {
    try {
      return g.__wexSafari || g.safari ||
        (g.top && (g.top.__wexSafari || g.top.safari)) || null;
    } catch (e) {
      return null;
    }
  })();

  var baseURI = (function () {
    try {
      var host = hostSafari;
      if (host && host.extension && host.extension.baseURI) {
        return host.extension.baseURI;
      }
    } catch (e) { /* fall through to the page's own address */ }
    // A world Safari injected nothing into has no extension object; a
    // bridge evaluated there for an injection is told the address.
    try {
      var late = g.__wexLateBridge;
      if (late && late.baseURI) {
        return late.baseURI;
      }
    } catch (e) { /* fall through */ }
    // An extension page names its own bundle in its address.
    try {
      var own = /^safari-extension:\/\/[^\/]+\/[^\/]+\//.exec(g.location.href);
      return own ? own[0] : "";
    } catch (e) {
      return "";
    }
  })();
  var origin = baseURI.replace(/^([a-z][a-z0-9+.\-]*:\/\/[^\/]*)\/.*$/i, "$1");
  var basePath = baseURI.slice(origin.length);

  function extUrl(path) {
    var p = String(path == null ? "" : path);
    if (p === "") {
      return baseURI;
    }
    if (/^[a-z][a-z0-9+.\-]*:/i.test(p)) {
      return served(p);
    }
    if (p.charAt(0) === "/") {
      if ((p + "/").indexOf(basePath) === 0) {
        return served(origin + p);
      }
      return served(baseURI + withinRoot(p.replace(/^\/+/, "")));
    }
    return served(baseURI + withinRoot(p));
  }

  // A path from the extension's root with its "." and ".." segments
  // resolved, as a URL resolves them, none climbing above the root.
  function withinRoot(p) {
    var match = /^([^?#]*)(.*)$/.exec(p);
    if (!/(^|\/)\.\.?(\/|$)/.test(match[1])) {
      return p;
    }
    var out = [];
    var segments = match[1].split("/");
    segments.forEach(function (segment, i) {
      var last = i === segments.length - 1;
      if (segment === "..") {
        out.pop();
        if (last) {
          out.push("");
        }
      } else if (segment === ".") {
        if (last) {
          out.push("");
        }
      } else {
        out.push(segment);
      }
    });
    return out.join("/") + match[2];
  }

  // Safari cannot serve a bundle file whose name has no extension, so the
  // converter gives each such file one and records the change. A URL naming
  // the file as the extension knows it is pointed at the file as it is
  // stored.
  var RENAMED = CONFIG.renamedFiles || {};
  var HAS_RENAMED = Object.keys(RENAMED).length > 0;

  // A path finds its file in any case, as on the Mac file system.
  function foldPath(path) {
    return path.normalize("NFC").toLowerCase();
  }
  var RENAMED_FOLDED = Object.create(null);
  Object.keys(RENAMED).forEach(function (path) {
    RENAMED_FOLDED[foldPath(path)] = RENAMED[path];
  });

  // Chrome and Firefox run a manifest's background scripts in a page they
  // generate at this address, which extensions build with getURL or
  // `new URL` and compare with their own to learn they are in the
  // background. Here the converter generates the global page for them, which
  // Safari would not run under a name that starts with an underscore; it
  // gives its address as the browser's (backgroundStandIn, the senders of
  // its messages). A background page of the extension's own, or a service
  // worker, has no such page in the browser either.
  var BACKGROUND_PAGE_ALIAS = "_generated_background_page.html";
  var GENERATED_BACKGROUND = (function () {
    var background = CONFIG.manifest && CONFIG.manifest.background;
    return background && Array.isArray(background.scripts) && !background.page &&
      !CONFIG.backgroundWorker && CONFIG.backgroundPage ? String(CONFIG.backgroundPage) : null;
  })();

  function served(url) {
    if (!HAS_RENAMED || !isExtUrl(url)) {
      return url;
    }
    var match = /^([^?#]*)(.*)$/.exec(url);
    var path = extPath(match[1]);
    var stored;
    try {
      stored = RENAMED_FOLDED[foldPath(decodeURIComponent(path))];
    } catch (e) {
      stored = RENAMED_FOLDED[foldPath(path)];
    }
    return typeof stored === "string" ? baseURI + stored + match[2] : url;
  }

  // The path, from the bundle root with a leading slash, of the file stored
  // for a path the extension names that way, as in a redirect's
  // extensionPath.
  function servedPath(path) {
    var match = /^\/?([^?#]*)(.*)$/.exec(path);
    var stored;
    try {
      stored = RENAMED_FOLDED[foldPath(decodeURIComponent(match[1]))];
    } catch (e) {
      stored = RENAMED_FOLDED[foldPath(match[1])];
    }
    return typeof stored === "string" ? "/" + stored + match[2] : path;
  }

  // True for any URL belonging to this extension, however it was resolved.
  function isExtUrl(url) {
    if (!url) {
      return false;
    }
    var u = String(url);
    return u.indexOf(origin) === 0 && (!origin || "/?#".indexOf(u.charAt(origin.length)) >= 0);
  }

  // The path of an extension URL relative to the bundle root, with the session
  // token removed. Used to match a URL back to a manifest-declared page.
  function extPath(url) {
    var u = String(url || "");
    if (!isExtUrl(u)) {
      return null;
    }
    var rest = u.slice(origin.length);
    if (rest.indexOf(basePath) === 0) {
      rest = rest.slice(basePath.length);
    }
    return rest.replace(/^\/+/, "");
  }

  // The id runtime.id reports: the one the extension's browser gives it,
  // its store id where it is known. The runtime's own plumbing goes by the
  // bundle's, CONFIG.extensionId.
  var RUNTIME_ID = CONFIG.runtimeId || CONFIG.extensionId;

  // Used by the converter's generic adaptation of Chrome URL construction.
  // Another extension's ID must never resolve to our own bundle.
  // The origin an address built from an extension's Chrome id stands for:
  // the extension's own for its own id, that of another converted extension
  // for its id once it has said what it is (learnExtensionOrigins), and the
  // Chrome address otherwise, which loads nothing here, as for an extension
  // that is not installed.
  var extensionOrigins = {};
  var missedOrigin = null;

  function chromeExtensionOrigin(id) {
    if (id === CONFIG.extensionId || id === RUNTIME_ID || (WEB_ID && id === WEB_ID)) {
      return baseURI.replace(/\/$/, "");
    }
    if (Object.prototype.hasOwnProperty.call(extensionOrigins, id)) {
      return extensionOrigins[id];
    }
    if (missedOrigin) {
      missedOrigin(String(id));
    }
    return "chrome-extension://" + id;
  }

  function learnExtensionOrigins(table, onMiss) {
    Object.keys(table || {}).forEach(function (id) {
      if (typeof table[id] === "string") {
        extensionOrigins[id] = table[id];
      }
    });
    if (onMiss) {
      missedOrigin = onMiss;
    }
    return extensionOrigins;
  }

  // ------------------------------------------------------------------ //
  // Match patterns and globs
  // ------------------------------------------------------------------ //
  function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // Letters in either case, for the parts of an address that have no case.
  function eitherCase(reSource) {
    return reSource.replace(/[a-z]/gi, function (letter) {
      return "[" + letter.toLowerCase() + letter.toUpperCase() + "]";
    });
  }

  // The port an address of each scheme leaves out.
  var DEFAULT_PORTS = { http: "80", https: "443", ws: "80", wss: "443" };

  // Compiles a WebExtension match pattern into a regex.
  // Scheme, host and path each have their own wildcard rules: `*` as a scheme
  // means http or https, a leading `*.` in the host also matches the bare
  // domain, and `*` in the path matches any run of characters. The host may
  // end in a port, or in `:*` for any port, and one with no port matches any.
  // The path is matched in its own case and against the path and query alone:
  // a URL's fragment is no part of what a pattern matches.
  function compileMatch(pattern) {
    var p = String(pattern);
    if (p === "<all_urls>") {
      return /^(https?|file|ftp|ws|wss):\/\//i;
    }
    var m = /^(\*|[a-z][a-z0-9+.\-]*):\/\/([^\/]*)(\/.*)?$/i.exec(p);
    if (!m) {
      return null;
    }
    var scheme = m[1];
    var host = m[2];
    var path = m[3] || "/*";

    var schemeRe = eitherCase(scheme === "*" ? "(https?|ws|wss)" : escapeRe(scheme));

    var port = /:(\*|\d+)$/.exec(host);
    if (port) {
      host = host.slice(0, port.index);
      if (!host) {
        return null;
      }
    }

    var hostRe;
    if (host === "*" || host === "") {
      hostRe = "[^/]*";
    } else if (host.indexOf("*.") === 0) {
      // "*.example.com" matches example.com and any subdomain of it.
      hostRe = "(?:[^/]*\\.)?" + eitherCase(escapeRe(host.slice(2)));
    } else {
      hostRe = eitherCase(escapeRe(host));
    }
    if (!port || port[1] === "*") {
      hostRe += "(?::\\d+)?";
    } else {
      hostRe += DEFAULT_PORTS[scheme.toLowerCase()] === port[1] ? "(?::" + port[1] + ")?" : ":" + port[1];
    }

    var pathRe = escapeRe(path).replace(/\\\*/g, "[^#]*");

    try {
      return new RegExp("^" + schemeRe + "://" + hostRe + pathRe + "(?:#.*)?$");
    } catch (e) {
      return null;
    }
  }

  // include_globs / exclude_globs use shell-style wildcards over the whole URL.
  function compileGlob(glob) {
    try {
      return new RegExp(
        "^" + escapeRe(glob).replace(/\\\*/g, ".*").replace(/\\\?/g, ".") + "$"
      );
    } catch (e) {
      return null;
    }
  }

  var matchCache = {};
  function cachedMatch(pattern) {
    if (!(pattern in matchCache)) {
      matchCache[pattern] = compileMatch(pattern);
    }
    return matchCache[pattern];
  }

  function matchesAny(url, patterns) {
    if (!patterns || !patterns.length) {
      return false;
    }
    for (var i = 0; i < patterns.length; i++) {
      var re = cachedMatch(patterns[i]);
      if (re && re.test(url)) {
        return true;
      }
    }
    return false;
  }

  var globCache = {};
  function globsAny(url, globs) {
    if (!globs || !globs.length) {
      return false;
    }
    for (var i = 0; i < globs.length; i++) {
      if (!(globs[i] in globCache)) {
        globCache[globs[i]] = compileGlob(globs[i]);
      }
      var re = globCache[globs[i]];
      if (re && re.test(url)) {
        return true;
      }
    }
    return false;
  }

  // chrome.tabs.query({url: ...}) takes match patterns too.
  function tabUrlMatches(url, patterns) {
    return matchesAny(url, Array.isArray(patterns) ? patterns : [patterns]);
  }

  // ------------------------------------------------------------------ //
  // Evaluating a file as a script
  // ------------------------------------------------------------------ //
  // Scripts share one global scope: the top-level declarations of one, `let`,
  // `const` and `class` included, are seen by the scripts after it. Evaluated
  // code keeps its `let`, `const` and `class` declarations to itself, and
  // strict evaluated code its `var` and function declarations as well. So
  // source to be run by an indirect eval, as content scripts and injected
  // files are, has its top-level `let` and `const` made `var` and its
  // top-level classes `var` bindings, and strict source ends by copying its
  // top-level names onto the global object, with the `var` names of its
  // statement blocks outside any function. A `let`, `const` or `class` of a
  // name in WINDOW_ACCESSORS stays as written and is not copied, and is
  // seen by its own source alone. Source the scanner cannot follow is returned
  // as it is.
  //
  // With `options.block`, the source is to run inside a statement block of a
  // script, where a sloppy source's top-level async functions and generators
  // are the block's own, so those names are copied onto the global object at
  // its end as well; `options.followed` is set when the scanner followed the
  // whole source.
  var WORD = /[A-Za-z_$\u00aa-\u167f\u1681-\u1fff\u200c-\u2027\u202a-\u202e\u2030-\u205e\u2060-\u2fff\u3001-\ufefe\uff00-\uffff][\w$\u00aa-\u167f\u1681-\u1fff\u200c-\u2027\u202a-\u202e\u2030-\u205e\u2060-\u2fff\u3001-\ufefe\uff00-\uffff]*/y;
  // The words whose parenthesis a statement block follows.
  var BLOCK_HEADS = { "if": true, "for": true, "while": true, "with": true, "catch": true, "switch": true };
  // The words a statement block follows.
  var BLOCK_WORDS = { "else": true, "try": true, "finally": true, "do": true };
  var REGEX_AFTER_WORD = {
    "return": true, "typeof": true, "instanceof": true, "in": true, "of": true,
    "new": true, "delete": true, "void": true, "throw": true, "case": true,
    "do": true, "else": true, "yield": true, "await": true
  };
  // The words strict code cannot name a binding.
  var STRICT_RESERVED = /^(?:break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|export|extends|false|finally|for|function|if|implements|import|in|instanceof|interface|let|new|null|package|private|protected|public|return|static|super|switch|this|throw|true|try|typeof|var|void|while|with|yield)$/;

  // Properties of the window with a setter that makes a string of what it is
  // given, one the page shares (`name`), or no setter. A declaration of one
  // shadows it in a script, where an assignment would not hold the value, and
  // would hand the page what `name` is given.
  var WINDOW_ACCESSORS = /^(?:closed|crypto|customElements|defaultStatus|history|indexedDB|localStorage|name|navigator|sessionStorage|status)$/;

  function asScript(source, options) {
    var src = String(source);
    var block = !!(options && options.block);
    var blockNames = [];
    var n = src.length;
    var strict = false;
    var edits = [];
    var names = [];
    var stack = [];
    var prev = null;
    var newline = false;
    var classPending = false;
    var inClassBody = false;
    // The depth of the brackets a strict declaration whose names are
    // copied out is at, while its list of declarators may go on, or -1.
    var declaring = -1;
    // Whether that declaration is a `let` or `const`, and its edit where one
    // makes it a `var`.
    var declaringLexical = false;
    var declaringEdit = null;
    var i = 0;

    function wordAt(at) {
      WORD.lastIndex = at;
      var m = WORD.exec(src);
      return m ? m[0] : "";
    }
    function isSpace(ch) {
      return ch === " " || ch === "\t" || ch === "\v" || ch === "\f" || ch === "\u00a0" ||
        ch === "\ufeff" || /[\u1680\u2000-\u200a\u202f\u205f\u3000]/.test(ch);
    }
    function isLineEnd(ch) {
      return ch === "\n" || ch === "\r" || ch === "\u2028" || ch === "\u2029";
    }
    // The next character that is not space or a comment.
    function nextAt(at) {
      while (at < n) {
        if (isSpace(src[at]) || isLineEnd(src[at])) {
          at++;
        } else if (src[at] === "/" && src[at + 1] === "/") {
          while (at < n && !isLineEnd(src[at])) {
            at++;
          }
        } else if (src[at] === "/" && src[at + 1] === "*") {
          var end = src.indexOf("*/", at + 2);
          at = end < 0 ? n : end + 2;
        } else {
          break;
        }
      }
      return at;
    }
    // Where template text that starts at `at` ends: after its closing
    // backquote, or after the "${" that opens an expression.
    function templateFrom(at) {
      while (at < n) {
        if (src[at] === "\\") {
          at += 2;
        } else if (src[at] === "`") {
          return { end: at + 1, expression: false };
        } else if (src[at] === "$" && src[at + 1] === "{") {
          return { end: at + 2, expression: true };
        } else {
          at++;
        }
      }
      return null;
    }
    function take(kind, text) {
      prev = { kind: kind, text: text };
      newline = false;
    }
    function afterTemplate(part) {
      i = part.end;
      if (part.expression) {
        stack.push("${");
        take("punct", "${");
      } else {
        take("template", "`");
      }
    }
    // Whether the scan is in no function, object or expression: each open
    // bracket is a statement block's brace ("{b") or a for loop's head ("(f").
    function inBlocksOnly() {
      for (var k = 0; k < stack.length; k++) {
        if (stack[k] !== "{b" && stack[k] !== "(f") {
          return false;
        }
      }
      return true;
    }
    function declaredName(at) {
      var name = wordAt(nextAt(at));
      return name && !/^(?:extends|in|instanceof|of)$/.test(name) ? name : "";
    }
    // Where an initialiser that starts at `at` ends: at the comma or the
    // closing bracket after it.
    function initialiserEnd(at) {
      var depth = 0;
      at = nextAt(at);
      while (at < n) {
        var ch = src[at];
        if (ch === "'" || ch === "\"") {
          at++;
          while (at < n && src[at] !== ch) {
            at += src[at] === "\\" ? 2 : 1;
          }
          at++;
        } else if (ch === "`") {
          at = templateEnd(at + 1);
        } else if (ch === "(" || ch === "[" || ch === "{") {
          depth++;
          at++;
        } else if (ch === ")" || ch === "]" || ch === "}") {
          if (!depth) {
            return at;
          }
          depth--;
          at++;
        } else if (ch === "," && !depth) {
          return at;
        } else {
          at++;
        }
        at = nextAt(at);
      }
      return at;
    }
    // Where a template whose text starts at `at` ends.
    function templateEnd(at) {
      var part = templateFrom(at);
      while (part && part.expression) {
        var close = initialiserEnd(part.end);
        while (src[close] === ",") {
          close = initialiserEnd(close + 1);
        }
        part = close < n ? templateFrom(close + 1) : null;
      }
      return part ? part.end : n;
    }
    // Adds the names the binding pattern at `at` binds to `out`, and gives
    // where the pattern ends. What it cannot follow ends the reading.
    function patternNames(at, out) {
      var open = src[at];
      var close = open === "{" ? "}" : "]";
      at = nextAt(at + 1);
      while (at < n && src[at] !== close) {
        if (src[at] === ",") {
          at = nextAt(at + 1);
          continue;
        }
        var spread = src.slice(at, at + 3) === "...";
        if (spread) {
          at = nextAt(at + 3);
        }
        var shorthand = "";
        if (open === "{" && !spread) {
          var ch = src[at];
          if (ch === "[") {
            at = initialiserEnd(at + 1) + 1;
          } else if (ch === "'" || ch === "\"") {
            at++;
            while (at < n && src[at] !== ch) {
              at += src[at] === "\\" ? 2 : 1;
            }
            at++;
          } else if (/[0-9.]/.test(ch)) {
            while (at < n && /[\w.]/.test(src[at])) {
              at++;
            }
          } else {
            shorthand = wordAt(at);
            at += shorthand.length;
          }
          at = nextAt(at);
        }
        if (open === "{" && !spread && src[at] !== ":") {
          if (!shorthand) {
            return n;
          }
          out.push(shorthand);
        } else {
          if (open === "{" && !spread) {
            at = nextAt(at + 1);
          }
          if (src[at] === "{" || src[at] === "[") {
            at = patternNames(at, out);
          } else {
            var target = wordAt(at);
            if (!target) {
              return n;
            }
            out.push(target);
            at += target.length;
          }
          at = nextAt(at);
        }
        if (src[at] === "=") {
          at = nextAt(initialiserEnd(at + 1));
        }
      }
      return at + 1;
    }
    // Takes note of the names the declarator at `at` binds: a strict source's
    // are copied out, and in a sloppy source a name in WINDOW_ACCESSORS keeps
    // its declaration as written.
    function noteDeclarator(at) {
      var first = nextAt(at);
      var bound = [];
      if (src[first] === "{" || src[first] === "[") {
        patternNames(first, bound);
      } else if (declaredName(first)) {
        bound.push(declaredName(first));
      }
      bound.forEach(function (name) {
        var shadows = declaringLexical && WINDOW_ACCESSORS.test(name);
        if (declaringEdit) {
          if (shadows) {
            declaringEdit[2] = src.substr(declaringEdit[0], declaringEdit[1]);
          }
        } else if (!shadows && !STRICT_RESERVED.test(name)) {
          names.push(name);
        }
      });
    }
    function beginDeclaration(depth, lexical, edit, at) {
      declaring = depth;
      declaringLexical = lexical;
      declaringEdit = edit;
      noteDeclarator(at);
    }
    // Whether a token ends an expression, so that a word on the next line
    // starts another statement.
    function endsValue(token) {
      if (token.kind === "punct") {
        return token.text === ")" || token.text === "]" || token.text === "}";
      }
      return token.kind !== "word" || REGEX_AFTER_WORD[token.text] !== true &&
        token.text !== "const" && token.text !== "let" && token.text !== "var";
    }
    // Whether the directives the source opens with include "use strict".
    function isStrict() {
      var at = nextAt(0);
      while (src[at] === "'" || src[at] === "\"") {
        var quote = src[at];
        var end = at + 1;
        while (end < n && src[end] !== quote && !isLineEnd(src[end])) {
          end += src[end] === "\\" ? 2 : 1;
        }
        if (src[end] !== quote) {
          return false;
        }
        if (src.slice(at + 1, end) === "use strict") {
          return true;
        }
        at = nextAt(end + 1);
        if (src[at] === ";") {
          at = nextAt(at + 1);
        }
      }
      return false;
    }
    strict = isStrict();

    while (i < n) {
      var c = src[i];
      if (stack.length < declaring) {
        declaring = -1;
      }
      if (isLineEnd(c)) {
        newline = true;
        i++;
        continue;
      }
      if (isSpace(c)) {
        i++;
        continue;
      }
      if (c === "/" && src[i + 1] === "/") {
        while (i < n && !isLineEnd(src[i])) {
          i++;
        }
        continue;
      }
      if (c === "/" && src[i + 1] === "*") {
        var close = src.indexOf("*/", i + 2);
        if (close < 0) {
          return src;
        }
        if (/[\n\r\u2028\u2029]/.test(src.slice(i, close))) {
          newline = true;
        }
        i = close + 2;
        continue;
      }
      var start = i;
      if (c === "'" || c === "\"") {
        i++;
        while (i < n && src[i] !== c) {
          if (isLineEnd(src[i])) {
            return src;
          }
          i += src[i] === "\\" ? 2 : 1;
        }
        if (i >= n) {
          return src;
        }
        i++;
        take("string", c);
        continue;
      }
      if (c === "`") {
        var part = templateFrom(i + 1);
        if (!part) {
          return src;
        }
        afterTemplate(part);
        continue;
      }
      if (c === "/") {
        var regexAllowed = !prev ||
          prev.kind === "punct" && ")]".indexOf(prev.text) < 0 &&
            prev.text !== "++" && prev.text !== "--" ||
          prev.kind === "word" && REGEX_AFTER_WORD[prev.text] === true;
        if (regexAllowed) {
          var inClass = false;
          i++;
          while (i < n && (src[i] !== "/" || inClass)) {
            if (isLineEnd(src[i])) {
              return src;
            }
            if (src[i] === "\\") {
              i++;
            } else if (src[i] === "[") {
              inClass = true;
            } else if (src[i] === "]") {
              inClass = false;
            }
            i++;
          }
          if (i >= n) {
            return src;
          }
          i++;
          while (i < n && /[\w$]/.test(src[i])) {
            i++;
          }
          take("regex", "/");
        } else {
          i += src[i + 1] === "=" ? 2 : 1;
          take("punct", "/");
        }
        continue;
      }
      if (/[0-9]/.test(c) || c === "." && /[0-9]/.test(src[i + 1] || "")) {
        while (i < n && /[\w.]/.test(src[i])) {
          i++;
        }
        take("number", src.slice(start, i));
        continue;
      }
      var word = wordAt(i);
      if (word) {
        i += word.length;
        var member = prev && prev.kind === "punct" && (prev.text === "." || prev.text === "?.");
        var atStart = !prev || newline ||
          prev.kind === "punct" && (prev.text === ";" || prev.text === "}");
        if (declaring === stack.length && newline && prev && endsValue(prev) &&
            word !== "in" && word !== "instanceof" && word !== "of") {
          declaring = -1;
        }
        if (!stack.length && !member && atStart) {
          var after = nextAt(i);
          var next = src[after] || "";
          var name;
          if (word === "const" || word === "let" && (wordAt(after) || next === "[" || next === "{")) {
            var edit = null;
            if (!strict) {
              edit = [start, word.length, "var"];
              edits.push(edit);
            }
            beginDeclaration(0, true, edit, i);
          } else if (word === "class" && (name = declaredName(i))) {
            if (!WINDOW_ACCESSORS.test(name)) {
              if (strict) {
                names.push(name);
              } else {
                edits.push([start, word.length, "var " + name + " = class"]);
                classPending = true;
              }
            }
          } else if (strict && word === "var") {
            beginDeclaration(0, false, null, i);
          } else if ((strict || block) && (word === "function" ||
              word === "async" && wordAt(after) === "function")) {
            var at = word === "async" ? nextAt(after + "function".length) : after;
            var generator = src[at] === "*";
            if (generator) {
              at = nextAt(at + 1);
            }
            name = wordAt(at);
            if (name && !WINDOW_ACCESSORS.test(name)) {
              if (strict) {
                names.push(name);
              } else if (generator || word === "async") {
                blockNames.push(name);
              }
            }
          }
        }
        if (strict && word === "var" && stack.length && !member && inBlocksOnly() &&
            (atStart || prev.kind === "punct" && (prev.text === "{" || prev.text === "("))) {
          beginDeclaration(stack.length, false, null, i);
        }
        take("word", word);
        continue;
      }
      if (c === "?" && src[i + 1] === "." && !/[0-9]/.test(src[i + 2] || "")) {
        i += 2;
        take("punct", "?.");
        continue;
      }
      if ((c === "+" || c === "-") && src[i + 1] === c) {
        i += 2;
        take("punct", c + c);
        continue;
      }
      if (c === "(" || c === "[" || c === "{") {
        var entry = c;
        if (c === "{" && classPending && !stack.length) {
          classPending = false;
          inClassBody = true;
        } else if (c === "{" && (!prev ||
            prev.kind === "punct" && (prev.text === ";" || prev.text === "{" || prev.text === "}") ||
            prev.kind === "word" && BLOCK_WORDS[prev.text] === true || prev.blockHead)) {
          entry = "{b";
        } else if (c === "(" && prev && prev.kind === "word" && BLOCK_HEADS[prev.text] === true) {
          entry = prev.text === "for" ? "(f" : "(k";
        }
        stack.push(entry);
      } else if (c === ")" || c === "]") {
        var opened = stack.pop();
        if (!opened || opened.charAt(0) !== (c === ")" ? "(" : "[")) {
          return src;
        }
        if (opened !== "(") {
          i++;
          take("punct", c);
          prev.blockHead = opened !== "[";
          continue;
        }
      } else if (c === "}") {
        var open = stack.pop();
        if (open === "${") {
          var rest = templateFrom(i + 1);
          if (!rest) {
            return src;
          }
          afterTemplate(rest);
          continue;
        }
        if (!open || open.charAt(0) !== "{") {
          return src;
        }
        if (!stack.length && inClassBody) {
          inClassBody = false;
          edits.push([i + 1, 0, ";"]);
        }
      } else if (declaring === stack.length) {
        // A declaration's further declarators: "var a = 1, b = 2;".
        if (c === ";") {
          declaring = -1;
        } else if (c === ",") {
          noteDeclarator(i + 1);
        }
      }
      i++;
      take("punct", c);
    }
    if (stack.length || classPending || inClassBody) {
      return src;
    }

    var parts = [];
    var from = 0;
    edits.forEach(function (edit) {
      parts.push(src.slice(from, edit[0]), edit[2]);
      from = edit[0] + edit[1];
    });
    parts.push(src.slice(from));
    var out = parts.join("");
    // A var statement leaves the source's completion value, which an
    // injection gives back, as it was.
    if (names.length) {
      out += "\n;var __wexGlobalNames = function () {" + names.map(function (name) {
        return "try{self[" + JSON.stringify(name) + "]=" + name + ";}catch(e){}";
      }).join("") + "}();";
    }
    if (blockNames.length) {
      out += "\n;" + blockNames.map(function (name) {
        return "try{self[" + JSON.stringify(name) + "]=" + name + ";}catch(e){}";
      }).join("");
    }
    if (options) {
      options.followed = true;
    }
    return out;
  }

  // ------------------------------------------------------------------ //
  // Keyboard shortcuts
  // ------------------------------------------------------------------ //
  // The shortcuts Chrome gives the manifest's commands on a Mac: each
  // command's suggested key for the Mac, or its default one, where "Ctrl"
  // is Command, for at most four commands, as Chrome assigns no more. Each
  // is the command's name, its modifiers, the key's code (KeyboardEvent.code)
  // and the shortcut as Chrome writes it on a Mac, in the Mac's modifier
  // symbols (Shift, Command and Y as "\u21e7\u2318Y").
  var SHORTCUT_KEYS = {
    Comma: ["Comma", 188, ","], Period: ["Period", 190, "."], Home: ["Home", 36, "\u2196"],
    End: ["End", 35, "\u2198"], PageUp: ["PageUp", 33, "\u21de"], PageDown: ["PageDown", 34, "\u21df"],
    Space: ["Space", 32, "Space"], Insert: ["Insert", 45, "Insert"], Delete: ["Delete", 46, "\u2326"],
    Up: ["ArrowUp", 38, "\u2191"], Down: ["ArrowDown", 40, "\u2193"], Left: ["ArrowLeft", 37, "\u2190"],
    Right: ["ArrowRight", 39, "\u2192"]
  };
  var MAX_SHORTCUTS = 4;

  function parseShortcut(text) {
    var parts = String(text || "").split("+").map(function (part) {
      return part.trim();
    });
    var key = parts.pop();
    var mods = { meta: false, ctrl: false, alt: false, shift: false };
    for (var i = 0; i < parts.length; i++) {
      var mod = parts[i];
      if (mod === "Ctrl" || mod === "Command") {
        mods.meta = true;
      } else if (mod === "MacCtrl") {
        mods.ctrl = true;
      } else if (mod === "Alt") {
        mods.alt = true;
      } else if (mod === "Shift") {
        mods.shift = true;
      } else {
        return null;
      }
    }
    if (!mods.meta && !mods.ctrl && !mods.alt) {
      return null;
    }
    var code;
    var keyCode;
    var label;
    if (/^[A-Z]$/.test(key)) {
      code = "Key" + key;
      keyCode = key.charCodeAt(0);
      label = key;
    } else if (/^[0-9]$/.test(key)) {
      code = "Digit" + key;
      keyCode = key.charCodeAt(0);
      label = key;
    } else if (/^F([1-9]|1[0-2])$/.test(key)) {
      code = key;
      keyCode = 111 + Number(key.slice(1));
      label = key;
    } else if (Object.prototype.hasOwnProperty.call(SHORTCUT_KEYS, key)) {
      code = SHORTCUT_KEYS[key][0];
      keyCode = SHORTCUT_KEYS[key][1];
      label = SHORTCUT_KEYS[key][2];
    } else {
      return null;
    }
    var text = (mods.ctrl ? "\u2303" : "") + (mods.alt ? "\u2325" : "") +
      (mods.shift ? "\u21e7" : "") + (mods.meta ? "\u2318" : "") + label;
    return { mods: mods, code: code, keyCode: keyCode, text: text };
  }

  function commandShortcuts(manifest) {
    var commands = (manifest && manifest.commands) || {};
    var out = [];
    Object.keys(commands).forEach(function (name) {
      var suggested = commands[name] && commands[name].suggested_key;
      var text = typeof suggested === "string" ? suggested :
        suggested && (suggested.mac || suggested["default"]);
      var shortcut = out.length < MAX_SHORTCUTS ? parseShortcut(text) : null;
      if (shortcut) {
        shortcut.name = name;
        out.push(shortcut);
      }
    });
    return out;
  }

  // Listens on window `g`, in the extension's own world, for the commands'
  // shortcuts, and calls `run` with the name of the one pressed. The key
  // goes no further, as Chrome keeps a shortcut's key from the page.
  function installCommandKeys(g, run) {
    var shortcuts = commandShortcuts(CONFIG.manifest);
    if (!shortcuts.length || !g.addEventListener) {
      return;
    }
    g.addEventListener("keydown", function (e) {
      if (!e.isTrusted || e.repeat) {
        return;
      }
      for (var i = 0; i < shortcuts.length; i++) {
        var s = shortcuts[i];
        if (e.metaKey === s.mods.meta && e.ctrlKey === s.mods.ctrl && e.altKey === s.mods.alt &&
            e.shiftKey === s.mods.shift && (e.code ? e.code === s.code : e.keyCode === s.keyCode)) {
          e.preventDefault();
          e.stopImmediatePropagation();
          run(s.name);
          return;
        }
      }
    }, true);
  }

  // A source that begins with a "use strict" directive. A comment's body
  // holds no "*/", so that each part of the prologue matches one way, and a
  // source without the directive fails at once.
  var STRICT_SOURCE = /^(?:\s|\/\/[^\n]*\n|\/\*(?:[^*]|\*+[^*\/])*\*+\/)*(["'])use strict\1/;

  // Source to inject as a script that runs only where `test`, an
  // expression, is true: the source as asScript makes it for a statement
  // block, in a block that tests first, and a strict source in a function
  // of its own inside the block so that it stays strict. Null for source
  // the scanner cannot follow.
  function guardedScript(source, test) {
    var scan = { block: true };
    var prepared = asScript(source, scan);
    if (!scan.followed) {
      return null;
    }
    var body = STRICT_SOURCE.test(prepared) ?
      "(function () {\n" + prepared + "\n}).call(this);" : prepared;
    return "if (" + test + ") {\n" + body + "\n}\n";
  }

  // ------------------------------------------------------------------ //
  // Reading bundled resources
  // ------------------------------------------------------------------ //
  function readTextSync(path) {
    try {
      var x = new PageXHR();
      xhrOpen.call(x, "GET", extUrl(path), false);
      xhrSend.call(x);
      if (x.status && x.status >= 400) {
        return null;
      }
      return x.responseText;
    } catch (e) {
      return null;
    }
  }

  function readJsonSync(path) {
    var text = readTextSync(path);
    if (text == null) {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  // ------------------------------------------------------------------ //
  // i18n
  // ------------------------------------------------------------------ //
  // The browser's language as Chrome writes it ("pt-BR"): Safari gives it
  // in lowercase ("pt-br").
  function uiLanguage() {
    return String(navigator.language || "en").split("-").map(function (part, i) {
      if (i === 0) {
        return part.toLowerCase();
      }
      if (part.length === 2) {
        return part.toUpperCase();
      }
      return part.length === 4 ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() : part;
    }).join("-");
  }

  // The converter records which _locales directories actually exist, so a
  // missing locale is never requested - a failed load logs a console error on
  // every page that asks for one.
  function localeCandidates() {
    var available = CONFIG.locales || [];
    var full = uiLanguage().replace(/-/g, "_");
    var lang = full.split("_")[0];
    var out = [];
    // A locale's folder may be named in any case ("pt_br").
    function offer(name) {
      var wanted = String(name || "").toLowerCase();
      for (var i = 0; wanted && i < available.length; i++) {
        if (String(available[i]).toLowerCase() === wanted && out.indexOf(available[i]) < 0) {
          out.push(available[i]);
          return;
        }
      }
    }
    offer(full);
    offer(lang);
    offer(CONFIG.defaultLocale);
    offer("en");
    // Regional variants of the default locale, e.g. "en_US" when only "en_GB"
    // ships, so something in the right language is still preferred over none.
    available.forEach(function (name) {
      if (name.split("_")[0] === lang) {
        offer(name);
      }
    });
    return out;
  }

  // The messages a browser defines for every extension, which its own
  // catalogues cannot replace: its id, and the UI locale and the direction
  // its language is written in.
  var RTL_LANGUAGES = ["ar", "ckb", "dv", "fa", "he", "iw", "ps", "sd", "ug", "ur", "yi"];

  function predefinedMessage(name) {
    var locale = uiLanguage().replace(/-/g, "_");
    var rtl = RTL_LANGUAGES.indexOf(locale.split("_")[0].toLowerCase()) >= 0;
    switch (name.toLowerCase()) {
      case "@@extension_id":
        // Firefox's is the uuid of the extension's address.
        return CONFIG.firefoxBuild && WEB_ID ? WEB_ID : RUNTIME_ID;
      case "@@ui_locale":
        return locale;
      case "@@bidi_dir":
        return rtl ? "rtl" : "ltr";
      case "@@bidi_reversed_dir":
        return rtl ? "ltr" : "rtl";
      case "@@bidi_start_edge":
        return rtl ? "right" : "left";
      case "@@bidi_end_edge":
        return rtl ? "left" : "right";
      default:
        return null;
    }
  }

  function makeI18n() {
    var candidates = null;
    var catalogues = [];

    // Candidate `i`'s catalogue, read the first time it is needed, or null.
    // The config carries the catalogues of the browser's language, each as
    // its JSON's text, so that no page waits on a synchronous load of an
    // extension URL; another is read from its file.
    function catalogue(i) {
      if (catalogues[i] !== undefined) {
        return catalogues[i];
      }
      var carried = CONFIG.localeMessages || {};
      var messages = null;
      if (Object.prototype.hasOwnProperty.call(carried, candidates[i])) {
        var text = carried[candidates[i]];
        try {
          messages = typeof text === "string" ? JSON.parse(text) : text;
        } catch (e) {
          messages = null;
        }
      } else {
        messages = readJsonSync("_locales/" + candidates[i] + "/messages.json");
      }
      if (!messages || typeof messages !== "object") {
        catalogues[i] = null;
        return null;
      }
      var lowercased = Object.create(null);
      Object.keys(messages).forEach(function (k) {
        lowercased[k.toLowerCase()] = messages[k];
      });
      catalogues[i] = { messages: messages, lowercased: lowercased };
      return catalogues[i];
    }

    // A message from the first catalogue that has it, in a browser's order:
    // the browser's locale, its language, then the default locale, where the
    // search ends. The candidates after that are for an extension with none
    // of those.
    function findEntry(name) {
      if (!candidates) {
        candidates = localeCandidates();
      }
      var ending = String(CONFIG.defaultLocale || "").toLowerCase();
      var found = false;
      for (var i = 0; i < candidates.length; i++) {
        var book = catalogue(i);
        if (book) {
          found = true;
          var entry = Object.prototype.hasOwnProperty.call(book.messages, name) ?
            book.messages[name] : book.lowercased[name.toLowerCase()];
          if (entry) {
            return entry;
          }
        }
        if (found && String(candidates[i]).toLowerCase() === ending) {
          return null;
        }
      }
      return null;
    }

    // Chrome looks message names up case-insensitively, and a message body may
    // reference named $PLACEHOLDER$ entries whose `content` maps $1..$9 onto
    // the caller's substitutions.
    function getMessage(name, substitutions) {
      var predefined = predefinedMessage(String(name == null ? "" : name));
      if (predefined !== null) {
        return predefined;
      }
      var entry = findEntry(String(name == null ? "" : name));
      if (!entry) {
        return "";
      }
      var subs = substitutions == null
        ? []
        : (Array.isArray(substitutions) ? substitutions : [substitutions]);

      // One pass over the message, as Chrome makes it: a substitution's own
      // text, a price such as "$1.99" among them, is not read again.
      function fill(str) {
        return String(str == null ? "" : str).replace(/\$(\$+|\d)/g, function (_, d) {
          if (d.charAt(0) === "$") {
            return d;
          }
          var v = subs[Number(d) - 1];
          return v == null ? "" : String(v);
        });
      }

      var body = String(entry.message == null ? "" : entry.message);
      body = body.replace(/\$([A-Za-z0-9_@]+)\$/g, function (whole, phName) {
        var placeholders = entry.placeholders;
        if (!placeholders) {
          return whole;
        }
        var ph = placeholders[phName];
        if (!ph) {
          var lc = phName.toLowerCase();
          for (var k in placeholders) {
            if (k.toLowerCase() === lc) {
              ph = placeholders[k];
              break;
            }
          }
        }
        return ph ? String(ph.content == null ? "" : ph.content) : whole;
      });
      return fill(body);
    }

    return {
      getMessage: getMessage,
      getUILanguage: function () {
        return uiLanguage();
      },
      getAcceptLanguages: function (cb) {
        return done(cb, [uiLanguage()]);
      },
      detectLanguage: function (text, cb) {
        return settle(detectTextLanguages(text), cb);
      }
    };
  }

  // Applies __MSG_name__ substitution to a manifest value, the way the browser
  // does before the extension ever sees it.
  // The manifest runtime.getManifest gives. Firefox gives its own after
  // reading it, with the paths of these properties made into addresses of
  // the extension's (its schemas' relativeUrl and strictRelativeUrl formats),
  // which extensions compare location.href with; Chrome gives it as written.
  var FIREFOX_URL_PROPERTIES = [
    "background.service_worker", "background.page", "background.scripts.*", "options_page",
    "options_ui.page", "content_scripts.*.css.*", "content_scripts.*.js.*", "devtools_page",
    "action.default_icon", "action.default_popup", "action.theme_icons.*.light", "action.theme_icons.*.dark",
    "browser_action.default_icon", "browser_action.default_popup", "browser_action.theme_icons.*.light",
    "browser_action.theme_icons.*.dark", "page_action.default_icon", "page_action.default_popup",
    "sidebar_action.default_icon", "sidebar_action.default_panel", "chrome_url_overrides.newtab",
    "chrome_url_overrides.bookmarks", "chrome_url_overrides.history",
    "declarative_net_request.rule_resources.*.path", "protocol_handlers.*.uriTemplate",
    "user_scripts.api_script", "chrome_settings_overrides.search_provider.favicon_url"
  ];

  function manifestAsGiven(manifest) {
    var copy = JSON.parse(JSON.stringify(manifest || {}));
    if (!CONFIG.firefoxBuild) {
      return copy;
    }
    FIREFOX_URL_PROPERTIES.forEach(function (path) {
      (function resolve(holder, parts) {
        if (!holder || typeof holder !== "object") {
          return;
        }
        var keys = parts[0] === "*" ? Object.keys(holder) : [parts[0]];
        keys.forEach(function (key) {
          if (parts.length > 1) {
            resolve(holder[key], parts.slice(1));
          } else if (typeof holder[key] === "string") {
            // The extension's root is the bundle's, under Safari's token.
            var value = holder[key];
            try {
              holder[key] = /^[a-z][a-z0-9+.\-]*:/i.test(value) ? value :
                new URL(value.replace(/^\/+(?!\/)/, ""), baseURI).href;
            } catch (e) { /* left as written */ }
          }
        });
      })(copy, path.split("."));
    });
    return copy;
  }

  function localizeManifest(value, i18n) {
    if (typeof value === "string") {
      return value.replace(/__MSG_([A-Za-z0-9_@]+)__/g, function (whole, name) {
        var text = i18n.getMessage(name);
        return text || whole;
      });
    }
    if (Array.isArray(value)) {
      return value.map(function (v) {
        return localizeManifest(v, i18n);
      });
    }
    if (value && typeof value === "object") {
      var out = {};
      Object.keys(value).forEach(function (k) {
        out[k] = localizeManifest(value[k], i18n);
      });
      return out;
    }
    return value;
  }

  // ------------------------------------------------------------------ //
  // Reading the extension's own files
  // ------------------------------------------------------------------ //
  // Safari 7 serves a bundle file with status 0, however the load went, and
  // gives a MIME type to .html, .js and .png files alone. Extensions check
  // `response.ok` or `status === 200` before using a file of their own, so a
  // load that delivered the file is reported as 200 OK, with the type its
  // name implies. A missing file still fails, as it does in Safari: as a
  // network error.
  var MIME_TYPES = {
    css: "text/css",
    json: "application/json",
    map: "application/json",
    svg: "image/svg+xml",
    txt: "text/plain",
    wasm: "application/wasm",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    otf: "font/otf",
    gif: "image/gif",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    ico: "image/x-icon",
    mjs: "text/javascript",
    xml: "application/xml"
  };

  function absoluteUrl(g, url) {
    try {
      return new g.URL(String(url), g.location.href).href;
    } catch (e) {
      return String(url);
    }
  }

  // Reports a file of this extension that loaded with status 0 as 200 OK, to
  // fetch and XMLHttpRequest in `g`. It refers to nothing outside itself, as
  // it also runs inside workers (see workerSource).
  // The constructors it uses are the ones there when it is installed, as a
  // script can take globals away later (a sandbox may remove those
  // its own code does not use).
  function fileStatusFix(g, origin, types) {
    var URLClass = g.URL;
    var HeadersClass = g.Headers;
    var ResponseClass = g.Response;
    var place = g.location;
    function isOwn(url) {
      var u = String(url || "");
      return !!url && u.indexOf(origin) === 0 && (!origin || "/?#".indexOf(u.charAt(origin.length)) >= 0);
    }
    function absolute(url) {
      try {
        return new URLClass(String(url), place.href).href;
      } catch (e) {
        return String(url);
      }
    }
    function typeFor(url) {
      var name = String(url).split(/[?#]/)[0].split("/").pop();
      var dot = name.lastIndexOf(".");
      return dot < 0 ? null : types[name.slice(dot + 1).toLowerCase()] || null;
    }
    if (typeof g.fetch === "function" && typeof g.Response === "function" &&
        !g.fetch.__wexStatusFixed) {
      var innerFetch = g.fetch;
      var fixedFetch = function (input, init) {
        var asked = typeof input === "string" ? input : (input && input.url);
        return innerFetch.apply(this, arguments).then(function (response) {
          var url = response.url || absolute(asked);
          if (response.status !== 0 || response.type === "opaque" || !isOwn(url)) {
            return response;
          }
          return response.arrayBuffer().then(function (body) {
            var headers = new HeadersClass(response.headers);
            var type = typeFor(url);
            if (type && !headers.get("content-type")) {
              headers.set("Content-Type", type);
            }
            var fixed = new ResponseClass(body, { status: 200, statusText: "OK", headers: headers });
            try {
              Object.defineProperty(fixed, "url", { value: url, configurable: true });
            } catch (e) { /* the URL stays empty */ }
            return fixed;
          });
        });
      };
      fixedFetch.__wexStatusFixed = true;
      fixedFetch.__wexPatched = innerFetch.__wexPatched;
      g.fetch = fixedFetch;
    }

    var proto = g.XMLHttpRequest && g.XMLHttpRequest.prototype;
    var statusDesc = proto && Object.getOwnPropertyDescriptor(proto, "status");
    var textDesc = proto && Object.getOwnPropertyDescriptor(proto, "statusText");
    if (!statusDesc || !statusDesc.get || proto.__wexStatusFixed) {
      return;
    }
    proto.__wexStatusFixed = true;
    var innerOpen = proto.open;
    proto.open = function (method, url) {
      this.__wexOwnFile = isOwn(absolute(url));
      this.__wexFailed = false;
      if (this.__wexOwnFile && !this.__wexWatching) {
        this.__wexWatching = true;
        var xhr = this;
        this.addEventListener("error", function () {
          xhr.__wexFailed = true;
        });
      }
      return innerOpen.apply(this, arguments);
    };
    var delivered = function (xhr) {
      if (!xhr.__wexOwnFile || xhr.__wexFailed || xhr.readyState !== 4) {
        return false;
      }
      var type = xhr.responseType;
      return (!type || type === "text") ? xhr.responseText.length > 0 : xhr.response != null;
    };
    Object.defineProperty(proto, "status", {
      configurable: true,
      get: function () {
        var status = statusDesc.get.call(this);
        return status === 0 && delivered(this) ? 200 : status;
      }
    });
    if (textDesc && textDesc.get) {
      Object.defineProperty(proto, "statusText", {
        configurable: true,
        get: function () {
          var text = textDesc.get.call(this);
          return statusDesc.get.call(this) === 0 && delivered(this) ? "OK" : text;
        }
      });
    }
  }

  function installFileStatusFix(g) {
    try {
      fileStatusFix(g, origin, MIME_TYPES);
    } catch (e) {
      log.warn("could not adjust fetch and XMLHttpRequest for the extension's own files", e);
    }
  }

  // Gives a worker started from `base`, a file of the extension, the
  // location and the relative URLs it would have there, inside the blob it
  // runs from (see installWorkerFixups). It refers to nothing outside itself.
  function workerBaseFix(g, base) {
    var URLClass = g.URL;
    function absolute(url) {
      try {
        return new URLClass(String(url), base).href;
      } catch (e) {
        return url;
      }
    }
    var location = new URLClass(base);
    Object.defineProperty(g, "location", { configurable: true, get: function () { return location; } });
    if (typeof g.fetch === "function") {
      var innerFetch = g.fetch;
      g.fetch = function (input, init) {
        return innerFetch.call(this, typeof input === "string" ? absolute(input) : input, init);
      };
    }
    if (typeof g.Request === "function") {
      var InnerRequest = g.Request;
      g.Request = function Request(input, init) {
        return new InnerRequest(typeof input === "string" ? absolute(input) : input, init);
      };
      g.Request.prototype = InnerRequest.prototype;
    }
    var proto = g.XMLHttpRequest && g.XMLHttpRequest.prototype;
    if (proto) {
      var innerOpen = proto.open;
      proto.open = function (method, url) {
        var args = Array.prototype.slice.call(arguments);
        args[1] = absolute(url);
        return innerOpen.apply(this, args);
      };
    }
    if (typeof g.importScripts === "function") {
      var innerImport = g.importScripts;
      g.importScripts = function () {
        return innerImport.apply(g, Array.prototype.map.call(arguments, absolute));
      };
    }
    if (typeof g.Worker === "function") {
      var InnerWorker = g.Worker;
      g.Worker = function Worker(url, options) {
        return new InnerWorker(absolute(url), options);
      };
      g.Worker.prototype = InnerWorker.prototype;
    }
  }

  // The script a wrapped worker runs: the fixes, then the worker's own
  // script. A blob's script is read now and run in place, as a page may
  // revoke the blob as soon as the worker is made, long before the worker
  // could import it. A module worker imports a module of the fixes first, as
  // a module's own statements run after everything it imports.
  function workerSource(g, url, isModule) {
    var blob = /^blob:/i.test(url);
    var local = !blob && !/^data:/i.test(url);
    var own = null;
    if (blob) {
      var xhr = new g.XMLHttpRequest();
      xhr.open("GET", url, false);
      xhr.send();
      own = xhr.responseText;
    }
    var fixes = "(" + fileStatusFix + ")(self, " + JSON.stringify(origin) + ", " +
      JSON.stringify(MIME_TYPES) + ");\n" +
      (local ? "(" + workerBaseFix + ")(self, " + JSON.stringify(url) + ");\n" : "") +
      (webFacingWorkerScript("self") || "") + "\n";
    if (!isModule) {
      return fixes + (own !== null ? own : "importScripts(" + JSON.stringify(url) + ");") + "\n";
    }
    var fixesUrl = g.URL.createObjectURL(new g.Blob([fixes], { type: "text/javascript" }));
    return "import " + JSON.stringify(fixesUrl) + ";\n" +
      (own !== null ? own : "import " + JSON.stringify(url) + ";") + "\n";
  }

  // Workers do not run this runtime, so a worker an extension page starts
  // from one of the extension's files, or from a blob or data URL it made,
  // runs from a blob that installs the same fixes first. A blob that can no
  // longer be read starts the worker as it is. A worker given a
  // file keeps that file's location and its relative URLs (workerBaseFix).
  // A SharedWorker is left alone: wrapping it would give every page a worker
  // of its own.
  function installWorkerFixups(g) {
    if (typeof g.Worker !== "function" || typeof g.Blob !== "function" ||
        !g.URL || typeof g.URL.createObjectURL !== "function" || g.Worker.__wexWrapped) {
      return;
    }
    var NativeWorker = g.Worker;
    var WrappedWorker = function Worker(scriptURL, options) {
      var url = absoluteUrl(g, scriptURL);
      if (!isExtUrl(url) && !/^(blob|data):/i.test(url)) {
        return new NativeWorker(scriptURL, options);
      }
      var isModule = !!(options && options.type === "module");
      var source;
      try {
        source = workerSource(g, url, isModule);
      } catch (e) {
        return new NativeWorker(scriptURL, options);
      }
      var wrapper = g.URL.createObjectURL(new g.Blob([source], { type: "text/javascript" }));
      return new NativeWorker(wrapper, options);
    };
    WrappedWorker.prototype = NativeWorker.prototype;
    WrappedWorker.__wexWrapped = true;
    g.Worker = WrappedWorker;
  }

  // Image loads bypass fetch, so its MIME fix cannot help an <img> whose
  // bundled SVG Safari served without a type. Retry only failed local SVG
  // images with an explicitly typed data URL. Data URLs also work in the
  // global page and popover, where blob URLs may be unavailable.
  function installSvgImageFallback(g) {
    var doc = g.document;
    if (!baseURI || !doc || !doc.addEventListener || doc.__wexSvgImages ||
        typeof g.fetch !== "function") {
      return;
    }
    doc.__wexSvgImages = true;
    var sources = Object.create(null);
    doc.addEventListener("error", function (event) {
      var img = event.target;
      if (!img || String(img.tagName).toLowerCase() !== "img" || img.srcset ||
          (img.parentNode && String(img.parentNode.tagName).toLowerCase() === "picture")) {
        return;
      }
      var source = img.src;
      if (!source || source.indexOf(baseURI) !== 0 || !/\.svg(?:[?#]|$)/i.test(source)) {
        return;
      }
      var hash = source.indexOf("#");
      var url = hash < 0 ? source : source.slice(0, hash);
      var fragment = hash < 0 ? "" : source.slice(hash);
      if (!sources[url]) {
        sources[url] = g.fetch(url).then(function (response) {
          if (!response.ok) {
            throw new Error("could not load SVG: " + url);
          }
          return response.text();
        }).then(function (text) {
          return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(text);
        }).catch(function () {
          // A missing file stays a failed image, without repeated requests.
          return null;
        });
      }
      sources[url].then(function (data) {
        // A framework may have reused this element while the file loaded.
        if (data && img.src === source && !img.srcset &&
            !(img.parentNode && String(img.parentNode.tagName).toLowerCase() === "picture")) {
          img.src = data + fragment;
        }
      });
    }, true);
  }

  // ------------------------------------------------------------------ //
  // Opening pages from the global page and the popover
  // ------------------------------------------------------------------ //
  // Safari opens nothing when the global page or a popover calls
  // window.open: the call returns null. In Chrome it opens a tab, so it is
  // carried out with tabs.create. What comes back stands in for the window
  // that would have opened, since callers go on to focus or close it, or to
  // send it elsewhere through its location. A document in it is not at hand.
  function installOpenInTab(g, tabs) {
    var nativeOpen = g.open;

    function absolute(url) {
      try {
        return new g.URL(String(url), g.location.href).href;
      } catch (e) {
        return String(url);
      }
    }

    g.open = function (url, target) {
      var name = String(target == null ? "" : target).toLowerCase();
      if ((name === "_self" || name === "_parent" || name === "_top") && nativeOpen) {
        return nativeOpen.apply(g, arguments);
      }
      var created = tabs.create(url ? { url: absolute(url) } : {});
      var address = url ? absolute(url) : "about:blank";
      var go = function (next) {
        address = absolute(next);
        Promise.resolve(created).then(function (tab) {
          if (tab && tab.id != null) {
            return tabs.update(tab.id, { url: address });
          }
          return undefined;
        }).catch(function (e) {
          log.warn("could not open " + address, e);
        });
      };
      var place = {
        assign: go,
        replace: go,
        reload: function () {},
        toString: function () {
          return address;
        }
      };
      Object.defineProperty(place, "href", {
        enumerable: true,
        get: function () {
          return address;
        },
        set: go
      });
      var stand = {
        closed: false,
        opener: g,
        focus: function () {},
        blur: function () {},
        postMessage: function () {},
        close: function () {
          stand.closed = true;
          Promise.resolve(created).then(function (tab) {
            if (tab && tab.id != null) {
              return tabs.remove(tab.id);
            }
            return undefined;
          }).catch(function () {});
        }
      };
      Object.defineProperty(stand, "location", {
        enumerable: true,
        get: function () {
          return place;
        },
        set: go
      });
      // What is written to the new window's document shows there at the end
      // of the task, or when the document closes.
      var written = null;
      var showing = null;
      function show() {
        clearTimeout(showing);
        showing = null;
        if (written !== null) {
          go("data:text/html;charset=utf-8," + encodeURIComponent(written));
        }
      }
      function write() {
        written = (written || "") + Array.prototype.join.call(arguments, "");
        if (showing === null) {
          showing = setTimeout(show, 0);
        }
      }
      stand.document = {
        open: function () {
          written = "";
          return stand.document;
        },
        write: write,
        writeln: function () {
          write(Array.prototype.join.call(arguments, "") + "\n");
        },
        close: show
      };
      Promise.resolve(created).catch(function (e) {
        log.warn("could not open " + url, e);
      });
      return stand;
    };
  }

  // ------------------------------------------------------------------ //
  // Making an extension page's own network calls work
  // ------------------------------------------------------------------ //
  // Three things an extension page takes for granted are not true here.
  //
  // Its own files load with status 0 (see installFileStatusFix).
  //
  // A bundle file with no extension in its name is stored under another name
  // (see `served`), so fetch and XMLHttpRequest are pointed at the stored
  // file when they ask for one.
  //
  // CacheStorage may be missing outright. Extensions treat a cache miss as
  // routine, so standing in with a cache that never holds anything lets that
  // code take its own fallback path instead of throwing.
  // ------------------------------------------------------------------ //
  // The extension's address, as the web sees it
  // ------------------------------------------------------------------ //
  // Inside the browser the extension's address is Safari's, which its pages,
  // senders and loads all agree on. What leaves the browser is what the
  // browser it was made for would send: a server that is told the
  // extension's address, as a sign-in's callback, knows it as
  // chrome-extension://<id>, or moz-extension://<uuid> for a Firefox build,
  // whose uuid Firefox makes up for each install and the converter makes up
  // for each bundle (CONFIG.webOrigin). The address goes out so, written out,
  // URL-encoded once or twice, or with its slashes escaped as JSON may
  // escape them. The way back, a site sending a tab to that address, is
  // taken to the extension's page (wex-global.js, wex-network.js,
  // wex-content.js).
  var WEB_ORIGIN = (function () {
    var given = String(CONFIG.webOrigin || CONFIG.sourceOrigin || "");
    return /^(chrome-extension:\/\/[a-p]{32}|moz-extension:\/\/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12})$/.test(given)
      ? given : null;
  })();
  var WEB_ID = WEB_ORIGIN ? WEB_ORIGIN.slice(WEB_ORIGIN.indexOf("://") + 3) : null;
  var webAddressForms = null;

  // The forms of the extension's address, each a pattern's source and flags
  // and what it becomes, to be applied in order.
  function webAddressPatterns() {
    if (webAddressForms) {
      return webAddressForms;
    }
    webAddressForms = [];
    var own = /^safari-extension:\/\/([^\/]+)\/([^\/]+)\/$/i.exec(baseURI);
    if (!WEB_ORIGIN || !own) {
      return webAddressForms;
    }
    var scheme = WEB_ORIGIN.slice(0, WEB_ORIGIN.indexOf(":"));
    var after = "(?![A-Za-z0-9._~-])";
    [[":", "/"], [":", "\\/"], ["%3A", "%2F"], ["%253A", "%252F"]].forEach(function (form) {
      var colon = form[0];
      var slash = form[1];
      var safari = "safari-extension" + colon + slash + slash + own[1] + slash + own[2];
      webAddressForms.push([escapeRe(safari) + after, "gi", scheme + colon + slash + slash + WEB_ID]);
    });
    return webAddressForms;
  }

  // A function that gives a text with the extension's address in each of
  // its forms as the web knows it, made from those forms by itself, so that
  // it can be written into a page's own world.
  function makeWebFacingText(forms) {
    var compiled = forms.map(function (form) {
      return [new RegExp(form[0], form[1]), form[2]];
    });
    return function (text) {
      if (typeof text !== "string" || text.toLowerCase().indexOf("safari-extension") < 0) {
        return text;
      }
      for (var i = 0; i < compiled.length; i++) {
        text = text.replace(compiled[i][0], compiled[i][1]);
      }
      return text;
    };
  }

  var webFacingTextOf = null;

  function webFacingText(text) {
    if (!webFacingTextOf) {
      webFacingTextOf = makeWebFacingText(webAddressPatterns());
    }
    return webFacingTextOf(text);
  }

  // The sites the manifest's web_accessible_resources let open one of the
  // extension's files, as match patterns: every site for a version 2
  // manifest's entries, the `matches` of a version 3 manifest's. None when
  // no site may open any, which pageFromWeb then never gives a page for.
  function openingSites() {
    var resources = (CONFIG.manifest || {}).web_accessible_resources;
    var sites = [];
    (Array.isArray(resources) ? resources : []).forEach(function (entry) {
      var matches = typeof entry === "string" ? ["http://*/*", "https://*/*"] :
        entry && Array.isArray(entry.resources) && entry.resources.length &&
        Array.isArray(entry.matches) ? entry.matches : [];
      matches.forEach(function (match) {
        match = String(match);
        if ((match === "<all_urls>" || /^(\*|https?):\/\//i.test(match)) && sites.indexOf(match) < 0) {
          sites.push(match);
        }
      });
    });
    return sites;
  }

  // The extension's page that `url`, an address of the extension's as the web
  // knows it, names, where a page at `from` may open it, or null. As in
  // Chrome, a site opens only what the manifest's web_accessible_resources
  // gives it: a version 2 manifest's paths for every site, a version 3
  // manifest's to the sites its `matches` name.
  function pageFromWeb(url, from) {
    // A URL's parser takes tabs and line breaks out wherever they are, so the
    // checks below see the address it will.
    var u = String(url || "").replace(/[\t\n\r]/g, "");
    if (!WEB_ORIGIN || u.slice(0, WEB_ORIGIN.length + 1).toLowerCase() !== WEB_ORIGIN.toLowerCase() + "/") {
      return null;
    }
    // The path's "." and ".." segments are resolved as a URL resolves them,
    // so that the file checked is the file opened; a redirect's Location
    // comes as the site wrote it. One that climbs only once decoded
    // ("..%2F") names no file a browser serves, and opens nothing.
    var rest = withinRoot(u.slice(WEB_ORIGIN.length + 1));
    var path = rest.split(/[?#]/)[0];
    try {
      path = decodeURIComponent(path);
    } catch (e) { /* as written */ }
    if (/(^|[\/\\])\.\.?([\/\\]|$)/.test(path)) {
      return null;
    }
    function listed(glob) {
      var parts = String(glob).replace(/^\/+/, "").split("*").map(escapeRe);
      return new RegExp("^" + parts.join(".*") + "$").test(path);
    }
    var resources = (CONFIG.manifest || {}).web_accessible_resources;
    var open = Array.isArray(resources) && resources.some(function (entry) {
      if (typeof entry === "string") {
        return listed(entry);
      }
      return !!entry && Array.isArray(entry.resources) && entry.resources.some(listed) &&
        Array.isArray(entry.matches) && matchesAny(String(from || ""), entry.matches);
    });
    return open ? baseURI + rest : null;
  }

  // Puts the address as the web knows it into what `g` sends to the web:
  // requests' addresses and bodies, beacons, sockets' and event streams'
  // addresses and sockets' messages, and, with `pageForms`, the forms the
  // page submits. A body of bytes, a blob or a stream is the address's as
  // well where it reads as text; one that does not is sent as it is, since
  // where the address sits in it, and what in it says how long it is, only
  // its format knows. A request for a file of the extension's own goes as it
  // is. The function stands on its own, `facingText` aside, so that it can
  // run in a worker.
  function webFacingInstaller(g, pageForms, facingText) {
    if (g.__wexWebFacing) {
      return;
    }
    try {
      Object.defineProperty(g, "__wexWebFacing", { value: true, configurable: true });
    } catch (e) {
      return;
    }
    function leaves(url) {
      try {
        return /^(https?|wss?):$/i.test(new g.URL(String(url), g.location.href).protocol);
      } catch (e) {
        return false;
      }
    }
    var decoder = null;
    var encoder = null;
    try {
      decoder = new g.TextDecoder("utf-8", { fatal: true });
      encoder = new g.TextEncoder();
    } catch (e) { /* bytes go as they are */ }
    // Bytes as the web knows them, or null where they do not change.
    function facingBytes(bytes) {
      if (!decoder) {
        return null;
      }
      var text;
      try {
        text = decoder.decode(bytes);
      } catch (e) {
        return null;
      }
      var facing = facingText(text);
      return facing === text ? null : encoder.encode(facing);
    }
    // A body that can be read at once, as the web knows it.
    function facingBody(body) {
      if (typeof body === "string") {
        return facingText(body);
      }
      try {
        if (g.URLSearchParams && body instanceof g.URLSearchParams) {
          var text = body.toString();
          var next = facingText(text);
          return next === text ? body : new g.URLSearchParams(next);
        }
        if (g.FormData && body instanceof g.FormData && typeof body.forEach === "function") {
          var changed = false;
          var copy = new g.FormData();
          body.forEach(function (value, name) {
            var v = typeof value === "string" ? facingText(value) : value;
            changed = changed || v !== value;
            if (typeof v === "string") {
              copy.append(name, v);
            } else {
              copy.append(name, v, v && v.name);
            }
          });
          return changed ? copy : body;
        }
        if (g.ArrayBuffer && body instanceof g.ArrayBuffer) {
          var bytes = facingBytes(new g.Uint8Array(body));
          return bytes ? bytes.buffer : body;
        }
        if (g.ArrayBuffer && g.ArrayBuffer.isView && g.ArrayBuffer.isView(body)) {
          var viewed = facingBytes(new g.Uint8Array(body.buffer, body.byteOffset, body.byteLength));
          if (!viewed) {
            return body;
          }
          return g.DataView && body instanceof g.DataView ? new g.DataView(viewed.buffer) : viewed;
        }
      } catch (e) { /* sent as it is */ }
      return body;
    }
    // Whether the body is one that is read later: a blob, or a stream.
    function laterBody(body) {
      return !!body && ((g.Blob && body instanceof g.Blob) ||
        (g.ReadableStream && body instanceof g.ReadableStream));
    }
    // A blob's or a stream's body as the web knows it, once read: a blob of
    // the same type, or the stream's bytes.
    function facingLater(body) {
      var read;
      try {
        read = g.Blob && body instanceof g.Blob && typeof body.arrayBuffer === "function" ?
          body.arrayBuffer() : new g.Response(body).arrayBuffer();
      } catch (e) {
        // A body that cannot be read here goes as it is.
        return Promise.resolve(body);
      }
      return read.then(function (buffer) {
        var bytes = facingBytes(new g.Uint8Array(buffer));
        if (g.Blob && body instanceof g.Blob) {
          return bytes ? new g.Blob([bytes], { type: body.type }) : body;
        }
        return bytes || new g.Uint8Array(buffer);
      });
    }
    try {
      if (typeof g.fetch === "function") {
        var fetch = g.fetch;
        var facingFetch = function (input, init) {
          var self = this;
          var url = typeof input === "string" ? input :
            input && typeof input.href === "string" ? input.href :
            input && typeof input.url === "string" ? input.url : null;
          if (url === null || !leaves(url)) {
            return fetch.apply(this, arguments);
          }
          var facing = facingText(url);
          var request = typeof input === "string" || typeof input.url !== "string" ? facing : input;
          var options = init;
          function withBody(body) {
            var copied = {};
            Object.keys(options || {}).forEach(function (key) {
              copied[key] = options[key];
            });
            copied.body = body;
            if (g.ReadableStream && body instanceof g.ReadableStream) {
              copied.duplex = "half";
            }
            return copied;
          }
          if (options && options.body != null) {
            if (laterBody(options.body)) {
              return facingLater(options.body).then(function (body) {
                if (typeof request !== "string" && facing !== url) {
                  request = new g.Request(facing, request);
                }
                return fetch.call(self, request, withBody(body));
              });
            }
            var body = facingBody(options.body);
            if (body !== options.body) {
              options = withBody(body);
            }
          } else if (typeof request !== "string" && request.body && !request.bodyUsed) {
            // A request that carries its own body.
            return request.clone().arrayBuffer().then(function (buffer) {
              var bytes = facingBytes(new g.Uint8Array(buffer));
              var made = facing !== url || bytes ? new g.Request(facing, bytes ? { method: request.method,
                headers: request.headers, body: bytes, credentials: request.credentials, mode: request.mode,
                cache: request.cache, redirect: request.redirect, referrer: request.referrer,
                integrity: request.integrity, signal: request.signal } : request) : request;
              return fetch.call(self, made, options);
            });
          }
          if (typeof request !== "string" && facing !== url) {
            request = new g.Request(facing, request);
          }
          return fetch.call(this, request, options);
        };
        facingFetch.__wexPatched = true;
        g.fetch = facingFetch;
      }
    } catch (e) { /* requests go as written */ }
    try {
      var xhr = g.XMLHttpRequest && g.XMLHttpRequest.prototype;
      if (xhr) {
        var open = xhr.open;
        var send = xhr.send;
        xhr.open = function (method, url) {
          var args = Array.prototype.slice.call(arguments);
          var out = leaves(url);
          try {
            Object.defineProperty(this, "__wexLeaves", { value: out, configurable: true, writable: true });
            Object.defineProperty(this, "__wexBlocking", {
              value: arguments.length > 2 && !arguments[2], configurable: true, writable: true
            });
            Object.defineProperty(this, "__wexPendingBody", { value: null, configurable: true, writable: true });
          } catch (e) { /* bodies go as written */ }
          if (out) {
            args[1] = facingText(String(url));
          }
          return open.apply(this, args);
        };
        xhr.open.__wexPatched = true;
        xhr.send = function (body) {
          if (!this.__wexLeaves || body == null) {
            return send.apply(this, arguments);
          }
          if (g.Blob && body instanceof g.Blob) {
            // A blob takes a while to read, and a synchronous request has to
            // have gone by the time send returns, so it goes as it is.
            if (this.__wexBlocking) {
              return send.apply(this, arguments);
            }
            var request = this;
            var pending = { body: body };
            var go = function (facing) {
              if (request.__wexPendingBody === pending) {
                request.__wexPendingBody = null;
                send.call(request, facing);
              }
            };
            request.__wexPendingBody = pending;
            facingLater(body).then(go, function () {
              go(body);
            });
            return undefined;
          }
          return send.call(this, facingBody(body));
        };
        // A request whose blob is still being read goes out with no body to
        // be aborted at once, so that it reports its abort as any request does.
        if (typeof xhr.abort === "function") {
          var abort = xhr.abort;
          xhr.abort = function () {
            if (this.__wexPendingBody) {
              this.__wexPendingBody = null;
              try {
                send.call(this);
              } catch (e) { /* aborted as it is */ }
            }
            return abort.apply(this, arguments);
          };
        }
      }
    } catch (e) { /* requests go as written */ }
    try {
      var nav = g.navigator;
      if (nav && typeof nav.sendBeacon === "function") {
        var beacon = nav.sendBeacon;
        nav.sendBeacon = function (url, data) {
          if (!leaves(url)) {
            return beacon.apply(this, arguments);
          }
          var target = facingText(String(url));
          if (laterBody(data)) {
            var navigator = this;
            facingLater(data).then(function (facing) {
              beacon.call(navigator, target, facing);
            });
            return true;
          }
          return beacon.call(this, target, facingBody(data));
        };
      }
    } catch (e) { /* beacons go as written */ }
    ["WebSocket", "EventSource"].forEach(function (name) {
      var Native = g[name];
      if (typeof Native !== "function" || typeof g.Proxy !== "function") {
        return;
      }
      try {
        var facing = new g.Proxy(Native, {
          construct: function (target, args, newTarget) {
            var list = Array.prototype.slice.call(args);
            if (list.length && leaves(list[0])) {
              list[0] = facingText(String(list[0]));
            }
            return Reflect.construct(target, list, newTarget === facing ? target : newTarget);
          }
        });
        Object.defineProperty(g, name, { value: facing, configurable: true, writable: true });
      } catch (e) { /* addresses go as written */ }
    });
    // A socket's messages go in the order they are sent, so one sent while a
    // blob before it is still being read waits its turn, as does closing it.
    try {
      var socket = g.WebSocket && g.WebSocket.prototype;
      if (socket && typeof socket.send === "function") {
        var socketSend = socket.send;
        socket.send = function (data) {
          var ws = this;
          if (!ws.__wexQueue && !laterBody(data)) {
            return socketSend.call(ws, facingBody(data));
          }
          var before = ws.__wexQueue || Promise.resolve();
          // A blob goes as its bytes: the engine reads one in its own time, and
          // close() right after it would lose it.
          var turn = before.then(function () {
            return laterBody(data) ? facingLater(data).then(function (facing) {
              return g.Blob && facing instanceof g.Blob ? facing.arrayBuffer() : facing;
            }) : facingBody(data);
          }).then(function (facing) {
            socketSend.call(ws, facing);
          }, function () {
            socketSend.call(ws, data);
          }).then(null, function () { /* the socket had closed */ });
          try {
            Object.defineProperty(ws, "__wexQueue", { value: turn, configurable: true, writable: true });
          } catch (e) { /* sent in turn */ }
          turn.then(function () {
            if (ws.__wexQueue === turn) {
              ws.__wexQueue = null;
            }
          });
          return undefined;
        };
        if (typeof socket.close === "function") {
          var socketClose = socket.close;
          socket.close = function () {
            var ws = this;
            var args = arguments;
            if (!ws.__wexQueue) {
              return socketClose.apply(ws, args);
            }
            // CLOSING to the extension from now, as the engine will say once
            // the sends before this have gone.
            try {
              Object.defineProperty(ws, "readyState", { value: 2, configurable: true });
            } catch (e) { /* it reads as the engine has it */ }
            ws.__wexQueue.then(function () {
              delete ws.readyState;
              socketClose.apply(ws, args);
            });
            return undefined;
          };
        }
      }
    } catch (e) { /* messages go as written */ }
    try {
      if (pageForms && g.document && g.HTMLFormElement) {
        g.document.addEventListener("submit", function (e) {
          var form = e.target;
          if (!(form instanceof g.HTMLFormElement) || !leaves(form.action || g.location.href)) {
            return;
          }
          Array.prototype.forEach.call(form.elements || [], function (field) {
            if (typeof field.value === "string" && field.type !== "file") {
              var next = facingText(field.value);
              if (next !== field.value) {
                field.value = next;
              }
            }
          });
        }, true);
      }
    } catch (e) { /* forms go as written */ }
  }

  // What the extension sends to the web from `g`, its own context; forms
  // only where `g` is one of its pages.
  function installWebFacingAddresses(g, pageForms) {
    if (webAddressPatterns().length) {
      webFacingInstaller(g, pageForms !== false, webFacingText);
    }
  }

  // The script that does the same where the runtime is not, on the global
  // named `global`: a worker the extension starts ("self").
  function webFacingWorkerScript(global) {
    if (!webAddressPatterns().length) {
      return null;
    }
    return "(" + webFacingInstaller + ")(" + (global || "window") + ", false, (" + makeWebFacingText + ")(" +
      JSON.stringify(webAddressPatterns()) + "));";
  }

  function installNetworkFixups(g) {
    function fix(url) {
      if (!HAS_RENAMED || typeof url !== "string") {
        return url;
      }
      var absolute;
      try {
        absolute = new g.URL(url, g.location.href).href;
      } catch (e) {
        return url;
      }
      var stored = served(absolute);
      return stored === absolute ? url : stored;
    }

    try {
      if (typeof g.fetch === "function" && !g.fetch.__wexPatched) {
        var nativeFetch = g.fetch.bind(g);
        var patchedFetch = function (input, init) {
          if (typeof input === "string") {
            return nativeFetch(fix(input), init);
          }
          if (input && typeof input.url === "string" && fix(input.url) !== input.url) {
            return nativeFetch(fix(input.url), init);
          }
          return nativeFetch(input, init);
        };
        patchedFetch.__wexPatched = true;
        g.fetch = patchedFetch;
      }
    } catch (e) {
      log.warn("could not adjust fetch for renamed files", e);
    }

    try {
      var proto = g.XMLHttpRequest && g.XMLHttpRequest.prototype;
      if (proto && !proto.open.__wexPatched) {
        var nativeOpen = proto.open;
        var patchedOpen = function (method, url) {
          var args = Array.prototype.slice.call(arguments);
          args[1] = fix(url);
          return nativeOpen.apply(this, args);
        };
        patchedOpen.__wexPatched = true;
        proto.open = patchedOpen;
      }
    } catch (e) {
      log.warn("could not adjust XMLHttpRequest for renamed files", e);
    }

    installFileStatusFix(g);
    installWorkerFixups(g);
    installSvgImageFallback(g);
    installStreamFallback(g);
    installFileSystemFallback(g);

    try {
      if (typeof g.caches === "undefined") {
        var emptyCache = {
          match: function () {
            return Promise.resolve(undefined);
          },
          matchAll: function () {
            return Promise.resolve([]);
          },
          add: function () {
            return Promise.resolve();
          },
          addAll: function () {
            return Promise.resolve();
          },
          put: function () {
            return Promise.resolve();
          },
          "delete": function () {
            return Promise.resolve(false);
          },
          keys: function () {
            return Promise.resolve([]);
          }
        };
        g.caches = {
          open: function () {
            return Promise.resolve(emptyCache);
          },
          has: function () {
            return Promise.resolve(false);
          },
          "delete": function () {
            return Promise.resolve(false);
          },
          keys: function () {
            return Promise.resolve([]);
          },
          match: function () {
            return Promise.resolve(undefined);
          }
        };
        log.debug("CacheStorage is unavailable; standing in with one that never hits");
      }
    } catch (e) { /* leave it alone */ }
  }

  // ------------------------------------------------------------------ //
  // A stand-in for the File System Access API
  // ------------------------------------------------------------------ //
  // Extensions that save large files write them through OPFS: ask
  // navigator.storage for a directory, open a file handle, and stream to it.
  // None of that exists here, and an extension whose only save path is that
  // API cannot write anything at all.
  //
  // What follows is the same surface backed by memory. Writes are positional,
  // because a multi-threaded downloader fills different offsets at once, so
  // the backing store is a buffer that grows and is written at an offset
  // rather than a list of appended chunks. The whole file therefore sits in
  // memory until it is saved, which is the real cost of this approach.
  // Hands a file's bytes to the global page at the far end of `port`, which
  // saves them as a download. They travel in pieces, because a message
  // crosses processes as text and a whole video in one message would be a
  // very large string. Resolves once the file has been saved.
  var SAVE_CHUNK = 512 * 1024;

  function bytesToBase64(bytes) {
    var binary = "";
    var step = 0x8000;
    for (var i = 0; i < bytes.length; i += step) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    }
    return g.btoa(binary);
  }

  // Sends a file over a port in pieces. A receiver that says it is ready before
  // the file is complete has `readyWithin` milliseconds to say so, where given;
  // one that does not is taken to be gone.
  function sendFile(port, bytes, filename, type, readyWithin) {
    return new Promise(function (resolve, reject) {
      var total = Math.ceil(bytes.length / SAVE_CHUNK) || 1;
      var index = 0;
      var settled = false;
      var waiting = readyWithin ? setTimeout(function () {
        finish("the page did not answer");
      }, readyWithin) : null;

      function finish(error) {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(waiting);
        try {
          port.disconnect();
        } catch (e) { /* already gone */ }
        if (error) {
          reject(new Error(error));
        } else {
          resolve(true);
        }
      }

      port.onMessage.addListener(function (m) {
        if (m && m.ready) {
          clearTimeout(waiting);
          return;
        }
        finish(m && m.ok ? null : ((m && m.error) || "the page could not save the file"));
      });
      port.onDisconnect.addListener(function () {
        finish("the page went away before the file was saved");
      });

      port.postMessage({
        begin: { filename: filename, type: type || "application/octet-stream", total: total }
      });
      // Sent a piece at a time so a large file does not block the page.
      (function next() {
        if (settled) {
          return;
        }
        if (index >= total) {
          port.postMessage({ end: true });
          return;
        }
        var slice = bytes.subarray(index * SAVE_CHUNK, (index + 1) * SAVE_CHUNK);
        port.postMessage({ chunk: { index: index, data: bytesToBase64(slice) } });
        index += 1;
        setTimeout(next, 0);
      })();
    });
  }

  function installFileSystemFallback(g) {
    // An engine's own File System Access has no pickers: the pickers stand in
    // beside it, and its handles take the forms of move() it lacks.
    var nativeFiles = typeof g.FileSystemFileHandle !== "undefined";
    if (nativeFiles) {
      installHandleMove(g);
      if (typeof g.showSaveFilePicker !== "undefined") {
        return;
      }
    }

    function toBytes(data) {
      if (data == null) {
        return Promise.resolve(new Uint8Array(0));
      }
      if (data instanceof g.Uint8Array) {
        return Promise.resolve(data);
      }
      if (g.ArrayBuffer && data instanceof g.ArrayBuffer) {
        return Promise.resolve(new Uint8Array(data));
      }
      if (data.buffer && typeof data.byteLength === "number") {
        return Promise.resolve(new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength));
      }
      if (typeof data === "string") {
        if (typeof TextEncoder !== "undefined") {
          return Promise.resolve(new TextEncoder().encode(data));
        }
        var out = new Uint8Array(data.length);
        for (var i = 0; i < data.length; i++) {
          out[i] = data.charCodeAt(i) & 0xff;
        }
        return Promise.resolve(out);
      }
      // A Blob. Prefer arrayBuffer(), and fall back to a reader where it is
      // missing, which is the case on older engines.
      if (typeof data.arrayBuffer === "function") {
        return data.arrayBuffer().then(function (buffer) {
          return new Uint8Array(buffer);
        });
      }
      return new Promise(function (resolve, reject) {
        var reader = new g.FileReader();
        reader.onload = function () {
          resolve(new Uint8Array(reader.result));
        };
        reader.onerror = function () {
          reject(reader.error || new Error("could not read the data being written"));
        };
        reader.readAsArrayBuffer(data);
      });
    }

    // A position or a size as a whole number of bytes, at any size of file.
    function byteOffset(value) {
      var offset = Math.floor(Number(value));
      return offset > 0 ? offset : 0;
    }

    // What a handle or directory call fails with, as the API names it.
    function fileError(name, message) {
      try {
        return new g.DOMException(message, name);
      } catch (e) {
        var error = new Error(message);
        error.name = name;
        return error;
      }
    }

    function Store() {
      this.bytes = new Uint8Array(0);
      this.length = 0;
    }
    Store.prototype.reserve = function (needed) {
      if (needed <= this.bytes.length) {
        return;
      }
      var grown;
      try {
        grown = new Uint8Array(Math.max(needed, this.bytes.length * 2, 1 << 16));
      } catch (e) {
        // Room to spare may be more than an array can hold.
        grown = new Uint8Array(needed);
      }
      grown.set(this.bytes.subarray(0, this.length));
      this.bytes = grown;
    };
    Store.prototype.writeAt = function (position, data) {
      var at = byteOffset(position);
      this.reserve(at + data.length);
      this.bytes.set(data, at);
      this.length = Math.max(this.length, at + data.length);
    };
    Store.prototype.truncate = function (size) {
      this.reserve(size);
      if (size < this.length) {
        this.bytes.fill(0, size, this.length);
      }
      this.length = size;
    };
    Store.prototype.blob = function (type) {
      return new g.Blob([this.bytes.subarray(0, this.length)],
        type ? { type: type } : undefined);
    };

    // A stream writes to a store of its own, empty unless asked to start from
    // the file's data, which becomes the file's when the stream is closed.
    function FileSystemWritableFileStream(handle, keepExistingData) {
      this._handle = handle;
      this._store = new Store();
      if (keepExistingData) {
        this._store.writeAt(0, handle._store.bytes.subarray(0, handle._store.length));
      }
      this._position = 0;
      this._queue = Promise.resolve();
      this._finished = false;
    }
    // Writes are serialised: the caller may not await each one, and two
    // overlapping grows of the backing buffer would lose data.
    FileSystemWritableFileStream.prototype._enqueue = function (fn) {
      var self = this;
      function run() {
        if (self._finished) {
          throw new TypeError("Cannot write to a closed stream");
        }
        return fn();
      }
      this._queue = this._queue.then(run, run);
      return this._queue;
    };
    FileSystemWritableFileStream.prototype.write = function (input) {
      var self = this;
      // A blob's `type` is its MIME type, not a command's.
      var command = input && typeof input === "object" && !(g.Blob && input instanceof g.Blob) &&
        (input.type === "write" || input.type === "seek" || input.type === "truncate") ?
        input : { type: "write", data: input };
      return this._enqueue(function () {
        if (command.type === "seek") {
          self._position = byteOffset(command.position);
          return undefined;
        }
        if (command.type === "truncate") {
          self._store.truncate(byteOffset(command.size));
          return undefined;
        }
        return toBytes(command.data).then(function (bytes) {
          var at = command.position == null ? self._position : byteOffset(command.position);
          self._store.writeAt(at, bytes);
          self._position = at + bytes.length;
        });
      });
    };
    FileSystemWritableFileStream.prototype.seek = function (position) {
      var self = this;
      return this._enqueue(function () {
        self._position = byteOffset(position);
      });
    };
    FileSystemWritableFileStream.prototype.truncate = function (size) {
      var self = this;
      return this._enqueue(function () {
        self._store.truncate(byteOffset(size));
      });
    };
    FileSystemWritableFileStream.prototype.close = function () {
      var self = this;
      return this._enqueue(function () {
        self._finished = true;
        self._handle._store = self._store;
      });
    };
    FileSystemWritableFileStream.prototype.abort = function () {
      this._finished = true;
      return this._queue.then(function () {}, function () {});
    };

    function FileSystemHandle(name, kind) {
      this.name = name;
      this.kind = kind;
    }
    FileSystemHandle.prototype.isSameEntry = function (other) {
      return Promise.resolve(other === this);
    };

    function FileSystemFileHandle(name, parent) {
      FileSystemHandle.call(this, name, "file");
      this._parent = parent || null;
      this._store = new Store();
      this._type = "";
    }
    FileSystemFileHandle.prototype = Object.create(FileSystemHandle.prototype);
    FileSystemFileHandle.prototype.constructor = FileSystemFileHandle;
    FileSystemFileHandle.prototype.createWritable = function (options) {
      return Promise.resolve(new FileSystemWritableFileStream(this, !!(options && options.keepExistingData)));
    };
    FileSystemFileHandle.prototype.getFile = function () {
      var blob = this._store.blob(this._type);
      // Callers read `name` off what getFile returns when naming a download.
      try {
        blob.name = this.name;
        blob.lastModified = Date.now();
      } catch (e) { /* a Blob may refuse extra properties */ }
      return Promise.resolve(blob);
    };

    function FileSystemDirectoryHandle(name) {
      FileSystemHandle.call(this, name, "directory");
      this._entries = Object.create(null);
    }
    FileSystemDirectoryHandle.prototype = Object.create(FileSystemHandle.prototype);
    FileSystemDirectoryHandle.prototype.constructor = FileSystemDirectoryHandle;
    FileSystemDirectoryHandle.prototype._entry = function (name, options, kind, make) {
      var key = String(name);
      if (!this._entries[key]) {
        if (!options || !options.create) {
          return Promise.reject(fileError("NotFoundError",
            "A requested file or directory could not be found: " + key));
        }
        this._entries[key] = make(key);
      }
      if (this._entries[key].kind !== kind) {
        return Promise.reject(fileError("TypeMismatchError",
          "The path names an entry of another kind: " + key));
      }
      return Promise.resolve(this._entries[key]);
    };
    FileSystemDirectoryHandle.prototype.getFileHandle = function (name, options) {
      var self = this;
      return this._entry(name, options, "file", function (key) {
        return new FileSystemFileHandle(key, self);
      });
    };
    FileSystemDirectoryHandle.prototype.getDirectoryHandle = function (name, options) {
      return this._entry(name, options, "directory", function (key) {
        return new FileSystemDirectoryHandle(key);
      });
    };
    FileSystemDirectoryHandle.prototype.removeEntry = function (name) {
      delete this._entries[String(name)];
      return Promise.resolve();
    };
    // An async iterator over the entries there now, each as `pick` gives it.
    function entryIterator(directory, pick) {
      var names = Object.keys(directory._entries);
      var at = 0;
      var iterator = {
        next: function () {
          while (at < names.length) {
            var name = names[at++];
            if (directory._entries[name]) {
              return Promise.resolve({ value: pick(name, directory._entries[name]), done: false });
            }
          }
          return Promise.resolve({ value: undefined, done: true });
        }
      };
      if (typeof Symbol === "function" && Symbol.asyncIterator) {
        iterator[Symbol.asyncIterator] = function () {
          return iterator;
        };
      }
      return iterator;
    }
    FileSystemDirectoryHandle.prototype.keys = function () {
      return entryIterator(this, function (name) {
        return name;
      });
    };
    FileSystemDirectoryHandle.prototype.values = function () {
      return entryIterator(this, function (name, handle) {
        return handle;
      });
    };
    FileSystemDirectoryHandle.prototype.entries = function () {
      return entryIterator(this, function (name, handle) {
        return [name, handle];
      });
    };
    if (typeof Symbol === "function" && Symbol.asyncIterator) {
      FileSystemDirectoryHandle.prototype[Symbol.asyncIterator] = FileSystemDirectoryHandle.prototype.entries;
    }

    if (!nativeFiles) {
      g.FileSystemHandle = FileSystemHandle;
      g.FileSystemFileHandle = FileSystemFileHandle;
      g.FileSystemDirectoryHandle = FileSystemDirectoryHandle;
      g.FileSystemWritableFileStream = FileSystemWritableFileStream;
    }

    // Saving what was written.
    //
    // The usual way to hand a file to the browser is an object URL plus a
    // link with a download attribute. Whether a blob: URL loads depends on
    // the kind of view the page is in, so it is tested on something tiny
    // first, and if it will not load, the bytes are handed to the global page.
    // A popover's object URLs load, but Safari takes a click on a link to one
    // as a navigation of the tab beneath it and saves nothing, so a popover
    // always hands the bytes over.
    var blobUrlTest = null;

    function inPopover() {
      try {
        return !!WEX.safari && !!WEX.safari.self && typeof WEX.safari.self.hide === "function";
      } catch (e) {
        return false;
      }
    }

    function blobUrlsUsable() {
      if (blobUrlTest) {
        return blobUrlTest;
      }
      blobUrlTest = new Promise(function (resolve) {
        var url;
        try {
          url = g.URL.createObjectURL(new g.Blob(["x"]));
        } catch (e) {
          resolve(false);
          return;
        }
        var request = new g.XMLHttpRequest();
        var answered = false;
        function settle(value) {
          if (!answered) {
            answered = true;
            try {
              g.URL.revokeObjectURL(url);
            } catch (e) { /* ignore */ }
            log.debug("blob: URLs are " + (value ? "usable" : "not usable") +
              " from this page");
            resolve(value);
          }
        }
        try {
          request.open("GET", url, true);
          request.onload = function () {
            settle(request.responseText === "x");
          };
          request.onerror = function () {
            settle(false);
          };
          request.send();
        } catch (e) {
          settle(false);
        }
        setTimeout(function () {
          settle(false);
        }, 3000);
      });
      return blobUrlTest;
    }

    function saveViaAnchor(blob, filename) {
      var url = g.URL.createObjectURL(blob);
      var link = g.document.createElement("a");
      link.href = url;
      link.download = filename;
      link.textContent = filename;
      (g.document.body || g.document.documentElement).appendChild(link);
      link.click();
      setTimeout(function () {
        try {
          g.URL.revokeObjectURL(url);
        } catch (e) { /* ignore */ }
        if (link.parentNode) {
          link.parentNode.removeChild(link);
        }
      }, 4000);
    }

    // Hands the bytes to the global page, which saves them as it saves a
    // download.
    function saveViaGlobalPage(bytes, filename, type) {
      if (!native || !native.runtime) {
        return Promise.reject(new Error("this page cannot save a file"));
      }
      return sendFile(native.runtime.connect({ name: INTERNAL_PORT + "save" }), bytes, filename, type);
    }

    // Saves a file through a link where blob URLs work here, and through the
    // global page where they do not. `bytesOf` gives the bytes for that.
    function saveBlob(blob, filename, type, bytesOf) {
      return (inPopover() ? Promise.resolve(false) : blobUrlsUsable()).then(function (usable) {
        if (usable) {
          saveViaAnchor(blob, filename);
          log.debug("saved " + filename + " through a download link");
          return true;
        }
        return bytesOf().then(function (bytes) {
          // The global page saves files as downloads do.
          if (typeof WEX.saveFile === "function") {
            return WEX.saveFile(bytes, filename, type).then(function () {
              return true;
            });
          }
          log.debug("blob URLs do not work here; saving " + filename +
            " through the global page instead");
          return saveViaGlobalPage(bytes, filename, type);
        });
      });
    }

    FileSystemFileHandle.prototype.download = function (name) {
      var self = this;
      clearTimeout(this._saving);
      var filename = String(name || this.name || "download");
      return this.getFile().then(function (blob) {
        return saveBlob(blob, filename, self._type, function () {
          return Promise.resolve(self._store.bytes.subarray(0, self._store.length));
        });
      });
    };

    if (nativeFiles && typeof g.FileSystemFileHandle.prototype.download === "undefined") {
      g.FileSystemFileHandle.prototype.download = function (name) {
        clearTimeout(this._saving);
        var filename = String(name || this.name || "download");
        return this.getFile().then(function (file) {
          return saveBlob(file, filename, file.type, function () {
            return file.arrayBuffer().then(function (buffer) {
              return new Uint8Array(buffer);
            });
          });
        });
      };
    }

    // move(name), move(directory) or move(directory, name).
    FileSystemFileHandle.prototype.move = function (first, second) {
      var directory = first instanceof FileSystemDirectoryHandle ? first : this._parent;
      var given = first instanceof FileSystemDirectoryHandle ? second : first;
      var name = given == null ? this.name : String(given);
      if (this._parent && this._parent._entries[this.name] === this) {
        delete this._parent._entries[this.name];
      }
      if (directory) {
        directory._entries[name] = this;
      }
      this._parent = directory;
      this.name = name;
      return Promise.resolve();
    };

    var root = new FileSystemDirectoryHandle("");

    // Providing these keeps an extension's own File System Access fallback
    // from installing one of its own, which would take the blob-URL route
    // without checking that it works from here. What is picked is a folder of
    // its own in the storage the engine keeps on disk where it has one, so a
    // long recording does not sit in memory, and a file there is saved once it
    // closes, which is when a picked file would be on disk.
    var PICKED_FOLDER = "wex-picked";
    var SAVED_AFTER_CLOSE = 1000;
    var SAVED_FILE_KEPT = 10 * 60 * 1000;
    var PICKED_FOLDER_KEPT = 24 * 60 * 60 * 1000;
    var closingStreams = new WeakMap();

    function picksAreRemoved(picked, folder) {
      return function () {
        return picked.removeEntry(folder.name, { recursive: true }).then(null, function () {
          /* it goes when a later pick clears what has aged */
        });
      };
    }

    function clearOldPicks(picked) {
      if (typeof picked.keys !== "function") {
        return;
      }
      var names = picked.keys();
      function next() {
        return names.next().then(function (item) {
          if (item.done) {
            return undefined;
          }
          if (Date.now() - parseInt(item.value, 10) > PICKED_FOLDER_KEPT) {
            picked.removeEntry(item.value, { recursive: true }).then(null, function () {});
          }
          return next();
        });
      }
      next().then(null, function () {});
    }

    function savesAfterClose(handle, remove) {
      var createWritable = handle.createWritable;
      function closed() {
        clearTimeout(handle._saving);
        handle._saving = setTimeout(function () {
          handle.download().then(function () {
            setTimeout(remove, SAVED_FILE_KEPT);
          }, function (e) {
            log.warn("could not save " + handle.name, e);
          });
        }, SAVED_AFTER_CLOSE);
      }
      handle.createWritable = function () {
        return createWritable.apply(handle, arguments).then(function (stream) {
          closingStreams.set(stream, closed);
          var close = stream.close;
          stream.close = function () {
            return close.call(stream).then(function (result) {
              closed();
              return result;
            });
          };
          if (typeof stream.getWriter === "function") {
            var getWriter = stream.getWriter;
            stream.getWriter = function () {
              var writer = getWriter.call(stream);
              var closeWriter = writer.close;
              writer.close = function () {
                return closeWriter.call(writer).then(function (result) {
                  closed();
                  return result;
                });
              };
              return writer;
            };
          }
          return stream;
        });
      };
      return handle;
    }

    function pickedDirectory(directory, remove) {
      var getFileHandle = directory.getFileHandle;
      var getDirectoryHandle = directory.getDirectoryHandle;
      directory.getFileHandle = function () {
        return getFileHandle.apply(directory, arguments).then(function (handle) {
          return savesAfterClose(handle, remove);
        });
      };
      directory.getDirectoryHandle = function () {
        return getDirectoryHandle.apply(directory, arguments).then(function (sub) {
          return pickedDirectory(sub, remove);
        });
      };
      return directory;
    }

    // A stream piped into a picked file closes without a call to its close().
    function watchPipes() {
      var readable = g.ReadableStream && g.ReadableStream.prototype;
      if (!readable || typeof readable.pipeTo !== "function") {
        return;
      }
      var pipeTo = readable.pipeTo;
      readable.pipeTo = function (destination) {
        var piped = pipeTo.apply(this, arguments);
        var closed = closingStreams.get(destination);
        if (!closed || (arguments[1] && arguments[1].preventClose)) {
          return piped;
        }
        return piped.then(function (result) {
          closed();
          return result;
        });
      };
    }

    function newPick() {
      var storage = g.navigator.storage;
      var top = nativeFiles && storage && typeof storage.getDirectory === "function" ?
        storage.getDirectory().then(null, function () {
          return root;
        }) : Promise.resolve(root);
      return top.then(function (directory) {
        return directory.getDirectoryHandle(PICKED_FOLDER, { create: true });
      }).then(function (picked) {
        clearOldPicks(picked);
        return picked.getDirectoryHandle(Date.now() + "-" + Math.random().toString(36).slice(2), { create: true }).then(function (folder) {
          var remove = picksAreRemoved(picked, folder);
          if (g.addEventListener) {
            g.addEventListener("pagehide", remove);
          }
          return pickedDirectory(folder, remove);
        });
      });
    }

    if (typeof g.showSaveFilePicker === "undefined") {
      watchPipes();
      g.showSaveFilePicker = function (options) {
        var opts = options || {};
        return newPick().then(function (folder) {
          return folder.getFileHandle(String(opts.suggestedName || "download"), { create: true });
        });
      };
      g.showDirectoryPicker = newPick;
      g.showOpenFilePicker = function () {
        return Promise.reject(new Error("opening files is not available here"));
      };
    }

    try {
      if (!g.navigator.storage) {
        g.navigator.storage = {};
      }
      if (typeof g.navigator.storage.getDirectory !== "function") {
        g.navigator.storage.getDirectory = function () {
          return Promise.resolve(root);
        };
      }
    } catch (e) {
      // navigator may be read-only; expose the root where callers can still
      // reach it rather than leaving them with nothing.
      g.__wexStorageRoot = root;
      log.warn("navigator.storage could not be extended", e);
    }

    log.debug("File System Access is unavailable; standing in with an in-memory one");
  }

  // move(name) and move(directory), beside the engine's move(directory, name).
  // A handle's directory is the one that gave it.
  function installHandleMove(g) {
    var files = g.FileSystemFileHandle.prototype;
    var directories = g.FileSystemDirectoryHandle && g.FileSystemDirectoryHandle.prototype;
    var move = files.move;
    if (typeof move !== "function" || !directories || typeof directories.getFileHandle !== "function") {
      return;
    }
    var parents = new WeakMap();
    var getFileHandle = directories.getFileHandle;
    directories.getFileHandle = function () {
      var directory = this;
      return getFileHandle.apply(this, arguments).then(function (handle) {
        parents.set(handle, directory);
        return handle;
      });
    };
    files.move = function (first, second) {
      if (second === undefined && first instanceof g.FileSystemDirectoryHandle) {
        return move.call(this, first, this.name);
      }
      if (second === undefined && parents.has(this)) {
        return move.call(this, parents.get(this), String(first));
      }
      return move.apply(this, arguments);
    };
  }

  // A minimal WritableStream, for engines without one. Extensions pipe
  // downloads through it, and its absence stops a download before it starts.
  function installStreamFallback(g) {
    if (typeof g.WritableStream !== "undefined") {
      return;
    }
    function WritableStream(sink) {
      var underlying = sink || {};
      var controller = {
        error: function (reason) {
          queue = Promise.reject(reason);
          queue.then(null, function () {});
        }
      };
      var queue = Promise.resolve(underlying.start ? underlying.start(controller) : undefined);
      queue.then(null, function () {});
      this.locked = false;
      this.getWriter = function () {
        return {
          write: function (chunk) {
            queue = queue.then(function () {
              return underlying.write ? underlying.write(chunk, controller) : undefined;
            });
            return queue;
          },
          close: function () {
            queue = queue.then(function () {
              return underlying.close ? underlying.close() : undefined;
            });
            return queue;
          },
          abort: function (reason) {
            return underlying.abort ? Promise.resolve(underlying.abort(reason)) : Promise.resolve();
          },
          releaseLock: function () {},
          ready: Promise.resolve(),
          closed: Promise.resolve()
        };
      };
    }
    g.WritableStream = WritableStream;
    log.debug("WritableStream is unavailable; standing in with a minimal one");
  }

  // ------------------------------------------------------------------ //
  // Logging
  // ------------------------------------------------------------------ //
  // Quiet unless the bundle was converted with debug logging on, so a
  // converted extension does not spam every page's console.
  var DEBUG = !!CONFIG.debug;
  var TAG = "[" + (CONFIG.name || "wex") + "]";

  var log = {
    debug: function () {
      if (!DEBUG) {
        return;
      }
      var args = [TAG].concat(Array.prototype.slice.call(arguments));
      try {
        console.log.apply(console, args);
      } catch (e) { /* console may be unavailable */ }
    },
    warn: function () {
      var args = [TAG].concat(Array.prototype.slice.call(arguments));
      try {
        console.warn.apply(console, args);
      } catch (e) { /* ignore */ }
    },
    error: function () {
      var args = [TAG].concat(Array.prototype.slice.call(arguments));
      try {
        console.error.apply(console, args);
      } catch (e) { /* ignore */ }
    },
    // Records an API the target cannot provide. The call still returns a
    // plausible value so the extension keeps running.
    unsupported: function (api) {
      if (!log._seen) {
        log._seen = {};
      }
      if (log._seen[api]) {
        return;
      }
      log._seen[api] = true;
      if (DEBUG) {
        log.warn(api + " is not available in this extension host; ignoring the call");
      }
    }
  };

  // ------------------------------------------------------------------ //
  // Misc
  // ------------------------------------------------------------------ //
  var counter = 0;
  function uid(prefix) {
    counter += 1;
    return (prefix || "u") + counter + "-" + Math.floor(Math.random() * 0x7fffffff).toString(36);
  }

  // ------------------------------------------------------------------ //
  // Web pages the extension lets in
  // ------------------------------------------------------------------ //
  // A page the manifest's `externally_connectable` matches has Chrome's
  // `chrome.runtime` for web pages, whose sendMessage and connect name the
  // extension they reach. It runs in the page's own world, and its requests
  // come to the extension's side as events on the document: in a tab, to
  // the page's content side (wex-content.js), and in a frame of one of the
  // extension's pages outside a tab, where Safari runs no content script,
  // through the page that frames it (framedPageRelay, wex-page.js).
  var PAGE_UNREACHABLE = "Could not establish connection. Receiving end does not exist.";

  // The token naming the events between a page's `chrome.runtime` and the
  // extension's side of the page: the extension's own, as the page's side is
  // a script of the bundle's (the converter's wex/page-runtime.js).
  var PAGE_RUNTIME_TOKEN = "id-" + String(RUNTIME_ID || "").replace(/[^A-Za-z0-9_-]/g, "_");

  // The page's side. One `chrome.runtime` serves every extension that lets
  // the page in, each reached by its id through the events of its own token.
  function pageRuntime(token, extensionId) {
    var ROUTES = "__wexRoutes";
    var doc = document;
    var chromeObject = window.chrome;
    if (!chromeObject || typeof chromeObject !== "object") {
      chromeObject = {};
      try {
        window.chrome = chromeObject;
      } catch (e) {
        return;
      }
    }
    var runtime = chromeObject.runtime;
    if (runtime && !runtime[ROUTES]) {
      return;
    }
    if (!runtime) {
      runtime = {};
      Object.defineProperty(runtime, ROUTES, { value: {} });
      define(runtime);
      chromeObject.runtime = runtime;
    }
    var route = runtime[ROUTES][extensionId] = { token: token, waiting: {}, ports: {} };
    doc.addEventListener("wex-external-reply-" + token, function (event) {
      var data;
      try {
        data = JSON.parse(event.detail);
      } catch (e) {
        return;
      }
      if (data.kind === "reply" && route.waiting[data.seq]) {
        var finish = route.waiting[data.seq];
        delete route.waiting[data.seq];
        finish(data.reply);
      } else if (data.kind === "portMessage" && route.ports[data.port]) {
        route.ports[data.port].message(data.message);
      } else if (data.kind === "portDisconnect" && route.ports[data.port]) {
        route.ports[data.port].closed(data.error);
      }
    });

    function define(runtime) {
      var routes = runtime[ROUTES];
      var seq = 0;
      var UNREACHABLE = "Could not establish connection. Receiving end does not exist.";
      function send(route, data) {
        doc.dispatchEvent(new CustomEvent("wex-external-" + route.token, { detail: JSON.stringify(data) }));
      }
      function withLastError(message, fn) {
        if (message) {
          runtime.lastError = { message: message };
        }
        try {
          fn();
        } finally {
          delete runtime.lastError;
        }
      }
      function needsId(name, signature) {
        return new TypeError("Error in invocation of runtime." + name + "(" + signature + "): chrome.runtime." +
          name + "() called from a webpage must specify an Extension ID (string) for its first argument.");
      }
      runtime.sendMessage = function (extensionId, message, options, callback) {
        if (typeof extensionId !== "string") {
          throw needsId("sendMessage",
            "optional string extensionId, any message, optional object options, optional function callback");
        }
        if (typeof options === "function") {
          callback = options;
        }
        var route = routes[extensionId];
        var n = ++seq;
        var promise = new Promise(function (resolve, reject) {
          var finish = function (reply) {
            if (typeof callback === "function") {
              withLastError(reply.error || (reply.closed ?
                "The message port closed before a response was received." : null), function () {
                callback(reply.response);
              });
              resolve();
            } else if (reply.error) {
              reject(new Error(reply.error));
            } else {
              resolve(reply.response);
            }
          };
          if (!route) {
            setTimeout(function () {
              finish({ error: UNREACHABLE });
            }, 0);
            return;
          }
          route.waiting[n] = finish;
          send(route, { kind: "message", seq: n, message: message });
        });
        return typeof callback === "function" ? undefined : promise;
      };
      runtime.connect = function (extensionId, connectInfo) {
        if (typeof extensionId !== "string") {
          throw needsId("connect", "optional string extensionId, optional object connectInfo");
        }
        var route = routes[extensionId];
        var n = ++seq;
        var listeners = { message: [], disconnect: [] };
        var open = true;
        var event = function (list) {
          return {
            addListener: function (fn) {
              if (typeof fn === "function" && list.indexOf(fn) < 0) {
                list.push(fn);
              }
            },
            removeListener: function (fn) {
              var i = list.indexOf(fn);
              if (i >= 0) {
                list.splice(i, 1);
              }
            },
            hasListener: function (fn) {
              return list.indexOf(fn) >= 0;
            },
            hasListeners: function () {
              return list.length > 0;
            }
          };
        };
        var port = {
          name: connectInfo && connectInfo.name != null ? String(connectInfo.name) : "",
          onMessage: event(listeners.message),
          onDisconnect: event(listeners.disconnect),
          postMessage: function (message) {
            if (!open || !route) {
              throw new Error("Attempting to use a disconnected port object");
            }
            send(route, { kind: "post", port: n, message: message });
          },
          disconnect: function () {
            if (open) {
              open = false;
              if (route) {
                delete route.ports[n];
                send(route, { kind: "disconnect", port: n });
              }
            }
          }
        };
        var closed = function (error) {
          if (!open) {
            return;
          }
          open = false;
          if (route) {
            delete route.ports[n];
          }
          withLastError(error, function () {
            listeners.disconnect.slice().forEach(function (fn) {
              fn(port);
            });
          });
        };
        if (!route) {
          setTimeout(function () {
            closed(UNREACHABLE);
          }, 0);
          return port;
        }
        route.ports[n] = {
          message: function (message) {
            listeners.message.slice().forEach(function (fn) {
              fn(message, port);
            });
          },
          closed: closed
        };
        send(route, { kind: "connect", port: n, name: port.name });
        return port;
      };
    }
  }

  // The page's side in a frame of one of the extension's pages: the
  // requests of pageRuntime go to the frame's parent, the extension's page,
  // as window messages, and the answers it posts back come to pageRuntime as
  // document events. A message that leaves the page says where the page is
  // now, and the last one it sends says the page is going. It runs before
  // ancestorPatterns, and keeps the frame's own parent and the messages'
  // own origin and source.
  function framedPageRelay(token, extensionOrigin) {
    "use strict";
    var doc = document;
    var here = location;
    var parentWindow = window.parent;
    var originOf = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "origin").get;
    var sourceOf = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "source").get;
    var send = function (request) {
      parentWindow.postMessage({ __wexExternal: request, url: here.href }, extensionOrigin);
    };
    doc.addEventListener("wex-external-" + token, function (event) {
      send(String(event.detail));
    });
    window.addEventListener("pagehide", function () {
      send(JSON.stringify({ kind: "gone" }));
    });
    window.addEventListener("message", function (event) {
      var data = event.data;
      if (sourceOf.call(event) !== parentWindow || originOf.call(event) !== extensionOrigin || !data ||
          typeof data.__wexExternalReply !== "string") {
        return;
      }
      event.stopImmediatePropagation();
      doc.dispatchEvent(new CustomEvent("wex-external-reply-" + token, { detail: data.__wexExternalReply }));
    }, true);
  }

  // The extension's side for one page: carries out the page's requests,
  // parsed from pageRuntime's events, through the global page, and gives
  // the page each answer with `toPage`. A request's `site` is the page's
  // address when an extension page carries it for a site in its frame, and
  // undefined when the page's own content side does, whose sender the
  // engine describes. `close` disconnects the page's open ports.
  function pageRuntimeHost(engine, toPage) {
    var ports = {};
    function handle(data, site) {
      if (!data || typeof data !== "object") {
        return;
      }
      if (data.kind === "message") {
        var request = { __wex: "pageMessage", message: data.message };
        if (site !== undefined) {
          request.site = site;
        }
        engine.runtime.sendMessage(request).then(function (reply) {
          toPage({ kind: "reply", seq: data.seq, reply: reply || { error: PAGE_UNREACHABLE } });
        }, function () {
          toPage({ kind: "reply", seq: data.seq, reply: { error: PAGE_UNREACHABLE } });
        });
      } else if (data.kind === "connect") {
        var name = site === undefined ? "page:" + data.name : "framed:" + JSON.stringify([site, String(data.name)]);
        var port = engine.runtime.connect({ name: INTERNAL_PORT + name });
        var error;
        ports[data.port] = port;
        port.onMessage.addListener(function (m) {
          if (m && m.error) {
            error = m.error;
          } else {
            toPage({ kind: "portMessage", port: data.port, message: m && m.message });
          }
        });
        port.onDisconnect.addListener(function () {
          delete ports[data.port];
          toPage({ kind: "portDisconnect", port: data.port, error: error });
        });
      } else if (data.kind === "post" && ports[data.port]) {
        ports[data.port].postMessage({ message: data.message });
      } else if (data.kind === "disconnect" && ports[data.port]) {
        ports[data.port].disconnect();
        delete ports[data.port];
      }
    }
    function close() {
      Object.keys(ports).forEach(function (n) {
        try {
          ports[n].disconnect();
        } catch (e) { /* gone already */ }
      });
      ports = {};
    }
    return { handle: handle, close: close };
  }

  // A site's window.open for the extension's address, `web` with its slash,
  // which a site calls to open a page the manifest gives it: in the page's
  // own world, a stand-in tells the extension's side of the page of the call
  // by the event `opening`, and gives the page a window of its own to hold.
  // The extension's side opens the page only on a gesture of the user's.
  function openStandIn(web, opening) {
    var open = window.open;
    window.open = function (url) {
      var to;
      try {
        to = new URL(url, location.href).href;
      } catch (e) { /* not an address */ }
      if (!to || to.slice(0, web.length).toLowerCase() !== web) {
        return open.apply(this, arguments);
      }
      document.dispatchEvent(new CustomEvent(opening, { detail: to }));
      return { closed: false, focus: function () {}, blur: function () {}, close: function () {}, postMessage: function () {} };
    };
  }

  // ------------------------------------------------------------------ //
  // Sites framed by the extension's pages
  // ------------------------------------------------------------------ //
  // Chrome gives a site in a frame of one of the extension's pages the
  // extension's Chrome origin in `location.ancestorOrigins`, and a site can
  // tell which extension frames it by matching that origin against a
  // pattern for a Chrome address. Safari gives the extension's Safari
  // origin, and WebKit lets no script change the list or its entries. In
  // such a frame, a pattern that does not match the extension's Safari
  // origin, applied to it with String.prototype.match, RegExp.prototype.exec
  // or RegExp.prototype.test, answers as for the Chrome origin. A site can
  // also tell who sends it a message by comparing the URL origin of the
  // message's origin with that of the extension's Chrome address. There a
  // URL at the extension's Safari origin has the Chrome origin as its
  // `origin`, and a chrome-extension: URL, whose origin WebKit gives as
  // "null", has its scheme and host, as Chrome gives it. A site may compare
  // the message's origin itself with the extension's Chrome address, and
  // post back to that address. There a message from the extension's Safari origin has the
  // Chrome origin as its `origin`, and where the frame's parent is the
  // extension's page, `parent` is a stand-in for it whose postMessage sends
  // to the Safari origin what the site addresses to the Chrome origin, and
  // which is the `source` of the page's messages. (`top` cannot be replaced,
  // and stays the window itself.) ancestorOrigins keeps Safari's origin, so
  // a message the site posts to it reaches the page.
  function ancestorPatterns(safariOrigin, chromeOrigin) {
    "use strict";
    var stringMatch = String.prototype.match;
    var regExpExec = RegExp.prototype.exec;
    var regExpTest = RegExp.prototype.test;
    var isSafariOrigin = function (value) {
      return typeof value === "string" && value.length === safariOrigin.length &&
        value.toLowerCase() === safariOrigin;
    };
    String.prototype.match = function match(pattern) {
      var found = stringMatch.apply(this, arguments);
      return found === null && isSafariOrigin(this) ? stringMatch.call(chromeOrigin, pattern) : found;
    };
    RegExp.prototype.exec = function exec(value) {
      var found = regExpExec.apply(this, arguments);
      return found === null && isSafariOrigin(value) ? regExpExec.call(this, chromeOrigin) : found;
    };
    RegExp.prototype.test = function test(value) {
      return regExpTest.apply(this, arguments) ||
        (isSafariOrigin(value) && regExpTest.call(this, chromeOrigin));
    };
    var urlOrigin = typeof URL === "function" && Object.getOwnPropertyDescriptor(URL.prototype, "origin");
    var urlProtocol = urlOrigin && Object.getOwnPropertyDescriptor(URL.prototype, "protocol");
    var urlHost = urlOrigin && Object.getOwnPropertyDescriptor(URL.prototype, "host");
    if (urlOrigin && urlOrigin.get && urlOrigin.configurable && urlProtocol && urlHost) {
      Object.defineProperty(URL.prototype, "origin", {
        configurable: true,
        enumerable: urlOrigin.enumerable,
        get: function origin() {
          var value = urlOrigin.get.call(this);
          if (isSafariOrigin(value)) {
            return chromeOrigin;
          }
          if (value === "null" && urlProtocol.get.call(this) === "chrome-extension:" && urlHost.get.call(this)) {
            return "chrome-extension://" + urlHost.get.call(this);
          }
          return value;
        }
      });
    }
    var realParent = null;
    var stand = null;
    try {
      realParent = window.parent;
      var ancestors = location.ancestorOrigins;
      if (realParent && realParent !== window && ancestors && ancestors.length &&
          isSafariOrigin(String(ancestors[0]).toLowerCase()) && typeof Proxy === "function") {
        var toSafari = function (target) {
          return typeof target === "string" && target.replace(/\/$/, "").toLowerCase() === chromeOrigin ?
            safariOrigin : target;
        };
        var postMessage = function postMessage(message, targetOrigin) {
          var args = Array.prototype.slice.call(arguments);
          if (targetOrigin && typeof targetOrigin === "object") {
            args[1] = Object.assign({}, targetOrigin, { targetOrigin: toSafari(targetOrigin.targetOrigin) });
          } else {
            args[1] = toSafari(targetOrigin);
          }
          return realParent.postMessage.apply(realParent, args);
        };
        var bound = {};
        stand = new Proxy(realParent, {
          get: function (target, name) {
            if (name === "postMessage") {
              return postMessage;
            }
            var value = target[name];
            if (typeof value !== "function") {
              return value;
            }
            if (!bound[name] || bound[name].of !== value) {
              bound[name] = { of: value, fn: value.bind(target) };
            }
            return bound[name].fn;
          },
          set: function (target, name, value) {
            target[name] = value;
            return true;
          }
        });
        Object.defineProperty(window, "parent", {
          configurable: true,
          enumerable: true,
          get: function () {
            return stand;
          }
        });
      }
    } catch (e) {
      stand = null;
    }
    var eventOrigin = typeof MessageEvent === "function" &&
      Object.getOwnPropertyDescriptor(MessageEvent.prototype, "origin");
    var eventSource = eventOrigin && Object.getOwnPropertyDescriptor(MessageEvent.prototype, "source");
    if (eventOrigin && eventOrigin.get && eventOrigin.configurable) {
      Object.defineProperty(MessageEvent.prototype, "origin", {
        configurable: true,
        enumerable: eventOrigin.enumerable,
        get: function origin() {
          var value = eventOrigin.get.call(this);
          return isSafariOrigin(value) ? chromeOrigin : value;
        }
      });
    }
    if (stand && eventSource && eventSource.get && eventSource.configurable) {
      Object.defineProperty(MessageEvent.prototype, "source", {
        configurable: true,
        enumerable: eventSource.enumerable,
        get: function source() {
          var value = eventSource.get.call(this);
          return value === realParent ? stand : value;
        }
      });
    }
  }

  // ------------------------------------------------------------------ //
  // The engine's `browser` namespace
  // ------------------------------------------------------------------ //
  // WebKit installs `browser` in the extension's pages and in its
  // content-script world, holding the parts of the WebExtension API that need
  // the engine. Each context layer publishes a fuller namespace as `chrome`,
  // and as `browser` for a Firefox build, so the engine's object is kept here
  // for the layers to build on; a layer that runs again finds it there.
  var native = (function () {
    var b = g.browser || g.chrome;
    if (b && b.__wex) {
      return b.__wexNative || null;
    }
    return g.browser && g.browser.runtime ? g.browser : null;
  })();

  // The runtime's own traffic shares the engine's messaging with the
  // extension's. Its messages are objects carrying this key and its ports have
  // names starting with this prefix; neither is shown to the extension.
  var INTERNAL_KEY = "__wex";
  var INTERNAL_PORT = "__wex:";

  function isInternal(message) {
    return !!message && typeof message === "object" &&
      typeof message[INTERNAL_KEY] === "string";
  }

  function isInternalPort(port) {
    return String(port && port.name).indexOf(INTERNAL_PORT) === 0;
  }

  // The namespaces the global page provides, which an extension page in a
  // tab has to know without asking.
  var NAMESPACES = [
    "runtime", "extension", "storage", "tabs", "windows", "i18n", "browserAction",
    "action", "pageAction", "contextMenus", "menus", "webNavigation", "webRequest",
    "declarativeNetRequest", "scripting", "userScripts", "contentScripts", "cookies", "alarms",
    "notifications", "downloads", "commands", "permissions", "idle", "management",
    "privacy", "browsingData", "offscreen", "identity", "devtools", "sidebarAction",
    "tabGroups", "theme", "proxy", "dns", "sessions", "contextualIdentities", "browserSettings",
    "sidePanel", "debugger", "tts", "omnibox", "declarativeContent", "dom", "publicSuffix", "pageCapture",
    "printerProvider", "gcm", "tabCapture"
  ];

  // The popover a side panel shows in, which keeps the size it is given.
  var SIDE_PANEL_POPOVER = "wex-sidepanel";
  // The blank page the popup's popover rests on while it is hidden.
  var POPUP_PLACEHOLDER = "wex/wex-popover.html";
  // The shared worker that carries a page's messages to the background's
  // service worker from a web process (wex-worker-relay.js).
  var WORKER_RELAY = "wex/wex-worker-relay.js";

  // The permissions that give an extension a namespace: a browser leaves a
  // namespace out unless the manifest asks for one of them, and extensions
  // test for a namespace to learn what they may do. A filtering
  // engine may take declarativeNetRequest's presence to mean its filters are
  // to become rules there. A permission the extension may ask for while running
  // (optional_permissions) counts, since permissions.request grants it.
  var NAMESPACE_PERMISSIONS = {
    declarativeNetRequest: ["declarativeNetRequest", "declarativeNetRequestWithHostAccess",
      "declarativeNetRequestFeedback"],
    webRequest: ["webRequest"],
    webNavigation: ["webNavigation"],
    cookies: ["cookies"],
    downloads: ["downloads"],
    notifications: ["notifications"],
    contextMenus: ["contextMenus", "menus"],
    menus: ["contextMenus", "menus"],
    alarms: ["alarms"],
    idle: ["idle"],
    privacy: ["privacy"],
    browsingData: ["browsingData"],
    offscreen: ["offscreen"],
    identity: ["identity"],
    scripting: ["scripting"],
    userScripts: ["userScripts"],
    tabGroups: ["tabGroups"],
    proxy: ["proxy"],
    dns: ["dns"],
    sessions: ["sessions"],
    contextualIdentities: ["contextualIdentities"],
    browserSettings: ["browserSettings"],
    sidePanel: ["sidePanel"],
    "debugger": ["debugger"],
    tts: ["tts"],
    declarativeContent: ["declarativeContent"],
    publicSuffix: ["publicSuffix"],
    pageCapture: ["pageCapture"],
    printerProvider: ["printerProvider"],
    gcm: ["gcm"],
    tabCapture: ["tabCapture"],
    storage: ["storage"],
    management: ["management"],
    theme: ["theme"]
  };

  // Whether the browser the extension was built for has a namespace, for
  // this manifest. Firefox alone has `theme`, `contentScripts`, `dns`, and
  // `menus` as its name for context menus. `devtools` is an extension's with
  // a devtools page. `sidebarAction` is Firefox's for a
  // manifest with a `sidebar_action`. `action` and `userScripts` are a
  // version 3 manifest's; `browserAction` and `pageAction` are a version 2
  // manifest's that names one.
  function namespaceBelongs(name) {
    var manifest = CONFIG.manifest || {};
    var version3 = manifest.manifest_version === 3;
    switch (name) {
      case "theme":
      case "contentScripts":
      case "menus":
      case "dns":
      case "contextualIdentities":
      case "browserSettings":
        return !!CONFIG.firefoxBuild;
      case "sidePanel":
      case "debugger":
      case "tts":
      case "declarativeContent":
      case "dom":
      case "publicSuffix":
      case "pageCapture":
      case "printerProvider":
      case "gcm":
      case "tabCapture":
        return !CONFIG.firefoxBuild;
      case "devtools":
        return !!manifest.devtools_page;
      case "omnibox":
        return !!manifest.omnibox;
      case "sidebarAction":
        return !!CONFIG.firefoxBuild && !!manifest.sidebar_action;
      case "action":
      case "userScripts":
        return version3;
      case "browserAction":
        return !version3 && !!manifest.browser_action;
      case "pageAction":
        return !version3 && !!manifest.page_action;
      default:
        return true;
    }
  }

  // Whether the manifest asks for a permission, required or optional.
  function declares(permission) {
    var manifest = CONFIG.manifest || {};
    return [].concat(manifest.permissions || [], manifest.optional_permissions || [])
      .indexOf(permission) >= 0;
  }

  function namespaceGranted(name) {
    if (!namespaceBelongs(name)) {
      return false;
    }
    return permissionGranted(name) || !!openFunctions(name);
  }

  function permissionGranted(name) {
    var needs = NAMESPACE_PERMISSIONS[name];
    return !needs || needs.some(declares);
  }

  // The functions of a namespace an extension has without the permission the
  // namespace needs, or null: management's own calls about the extension,
  // and Chrome's reading of a manifest's warnings, which Firefox lacks; and
  // Firefox's reading of the current theme, which only changing it needs
  // the permission for.
  function openFunctions(name) {
    if (permissionGranted(name)) {
      return null;
    }
    if (name === "theme") {
      return CONFIG.firefoxBuild ? ["getCurrent", "onUpdated"] : null;
    }
    if (name !== "management") {
      return null;
    }
    return CONFIG.firefoxBuild ? ["getSelf", "uninstallSelf"] :
      ["getSelf", "uninstallSelf", "getPermissionWarningsByManifest"];
  }

  // runtime.connectNative and sendNativeMessage, which a browser gives an
  // extension that asks for nativeMessaging. There is no native application
  // to reach: a port disconnects at once, and a message fails, with the error
  // a browser gives when it finds no host.
  var NO_NATIVE_HOST = "Specified native messaging host not found.";

  function addNativeMessaging(runtime) {
    if (!runtime || !declares("nativeMessaging")) {
      return;
    }
    runtime.connectNative = function (application) {
      log.unsupported("chrome.runtime.connectNative");
      var port = {
        name: String(application || ""),
        onMessage: new Event("port.onMessage"),
        onDisconnect: new Event("port.onDisconnect"),
        postMessage: function () {},
        disconnect: function () {},
        error: null
      };
      setTimeout(function () {
        var error = { message: NO_NATIVE_HOST };
        port.error = error;
        WEX.lastError = error;
        try {
          port.onDisconnect.emit(port);
        } finally {
          WEX.lastError = null;
        }
      }, 0);
      return port;
    };
    runtime.sendNativeMessage = function (_, __, cb) {
      log.unsupported("chrome.runtime.sendNativeMessage");
      return fail(typeof __ === "function" ? __ : cb, NO_NATIVE_HOST);
    };
  }

  // ------------------------------------------------------------------ //
  // The browser an extension was built for
  // ------------------------------------------------------------------ //
  // Extensions tell browsers apart and take the code they have for the one
  // they find, and a build has only run in the browser it was made for. So
  // the extension's pages and content scripts find that browser: a build
  // published on Firefox Add-ons finds Firefox's user agent and `browser`, a
  // Chrome build Chrome's user agent, vendor and client hints and no
  // `browser`, and neither finds Safari's `safari` object, except in the
  // global page: Safari's own tab objects there read `window.safari`, and
  // give no url or title without it. Web pages keep Safari's identity. The
  // version is the browser's at the time of this runtime, or the least the
  // manifest asks for if that is later.
  var FIREFOX_VERSION = 158;
  var CHROME_VERSION = 156;

  function browserIdentity() {
    var manifest = CONFIG.manifest || {};
    if (CONFIG.firefoxBuild) {
      var gecko = (manifest.browser_specific_settings || manifest.applications || {}).gecko || {};
      var firefox = Math.max(FIREFOX_VERSION, parseInt(gecko.strict_min_version, 10) || 0);
      return {
        name: "Firefox",
        vendor: "Mozilla",
        version: firefox + ".0",
        buildID: "20181001000000",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:" + firefox + ".0) " +
          "Gecko/20100101 Firefox/" + firefox + ".0",
        appVersion: "5.0 (Macintosh)",
        navigatorVendor: "",
        productSub: "20100101",
        oscpu: "Intel Mac OS X 10.15"
      };
    }
    var chrome = Math.max(CHROME_VERSION, parseInt(manifest.minimum_chrome_version, 10) || 0);
    var userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/" + chrome + ".0.0.0 Safari/537.36";
    return {
      name: "Chrome",
      vendor: "Google",
      version: chrome + ".0.0.0",
      major: String(chrome),
      userAgent: userAgent,
      appVersion: userAgent.slice("Mozilla/".length),
      navigatorVendor: "Google Inc.",
      productSub: "20030107"
    };
  }

  // What a request names the browser as: the user agent navigator.userAgent
  // gives, and in a Chrome build the client hints Chrome sends with a request
  // to a secure address, naming the brands navigator.userAgentData gives.
  function requestIdentity() {
    var identity = browserIdentity();
    return {
      userAgent: identity.userAgent,
      clientHints: CONFIG.firefoxBuild ? [] : [
        { name: "sec-ch-ua", value: userAgentData(identity).brands.map(function (b) {
          return "\"" + b.brand + "\";v=\"" + b.version + "\"";
        }).join(", ") },
        { name: "sec-ch-ua-mobile", value: "?0" },
        { name: "sec-ch-ua-platform", value: "\"macOS\"" }
      ]
    };
  }

  // Chrome's navigator.userAgentData.
  function userAgentData(identity) {
    var brands = [
      { brand: "Google Chrome", version: identity.major },
      { brand: "Chromium", version: identity.major },
      { brand: "Not.A/Brand", version: "99" }
    ];
    var low = { brands: brands, mobile: false, platform: "macOS" };
    var high = {
      architecture: "x86",
      bitness: "64",
      formFactors: ["Desktop"],
      fullVersionList: brands.map(function (b) {
        return { brand: b.brand, version: b.version === "99" ? "99.0.0.0" : identity.version };
      }),
      model: "",
      platformVersion: "10.15.7",
      uaFullVersion: identity.version,
      wow64: false
    };
    return {
      brands: brands,
      mobile: false,
      platform: "macOS",
      getHighEntropyValues: function (hints) {
        var out = { brands: brands, mobile: false, platform: "macOS" };
        (Array.isArray(hints) ? hints : []).forEach(function (hint) {
          if (Object.prototype.hasOwnProperty.call(high, hint)) {
            out[hint] = high[hint];
          }
        });
        return Promise.resolve(out);
      },
      toJSON: function () {
        return low;
      }
    };
  }

  // Safari's own code looks up `safari` on the page's window when one of its
  // calls runs, and canLoad answers nothing without it. A call made while it
  // is set aside (presentBrowser) is made with it back in place for the
  // call's length; page code cannot run in between.
  function withSafari(g, fn) {
    var hidden = false;
    try {
      hidden = !("safari" in g) && !!g.__wexSafari;
    } catch (e) { /* treated as present */ }
    if (!hidden) {
      return fn();
    }
    try {
      g.safari = g.__wexSafari;
    } catch (e) {
      return fn();
    }
    try {
      return fn();
    } finally {
      try {
        delete g.safari;
      } catch (e) { /* stays */ }
    }
  }

  function presentBrowser(g, keepSafari) {
    var identity = browserIdentity();
    var navigatorProto = (g.Navigator && g.Navigator.prototype) || g.navigator;
    function define(name, value) {
      try {
        Object.defineProperty(navigatorProto, name, {
          get: function () { return value; }, configurable: true, enumerable: true
        });
      } catch (e) { /* the navigator keeps Safari's */ }
    }
    if (navigatorProto) {
      define("userAgent", identity.userAgent);
      define("appVersion", identity.appVersion);
      define("vendor", identity.navigatorVendor);
      define("productSub", identity.productSub);
      if (CONFIG.firefoxBuild) {
        define("oscpu", identity.oscpu);
      } else {
        define("userAgentData", userAgentData(identity));
      }
    }
    // The W3C test suites are written for `browser`, which their test builds
    // keep.
    if (!CONFIG.firefoxBuild && CONFIG.testApi !== "standard") {
      try {
        delete g.browser;
      } catch (e) { /* not removable */ }
    }
    try {
      if (g.safari && !keepSafari) {
        Object.defineProperty(g, "__wexSafari", { value: g.safari, configurable: true });
        delete g.safari;
      }
    } catch (e) { /* not removable */ }
    // WebKit's `aqua`, which Chrome has no counterpart of, is the runtime's
    // to build on.
    try {
      if (g.aqua) {
        Object.defineProperty(g, "__wexAqua", { value: g.aqua, configurable: true });
        delete g.aqua;
      }
    } catch (e) { /* not removable */ }
  }

  // Tab ids at and above this stand for tabs WebKit's id is not known for.
  var PROVISIONAL_TAB_ID = 0x40000000;

  // Gives a promise's outcome to a Chrome-style callback, when there is one.
  function settle(promise, cb) {
    if (typeof cb !== "function") {
      return promise;
    }
    return promise.then(function (value) {
      try {
        cb(value);
      } catch (e) {
        log.error("callback threw", e);
        if (WEX.testException) {
          WEX.testException(e);
        }
      }
      return value;
    }, function (error) {
      WEX.lastError = { message: String(error && error.message ? error.message : error) };
      try {
        cb(undefined);
      } catch (e) {
        log.error("callback threw", e);
        if (WEX.testException) {
          WEX.testException(e);
        }
      }
      WEX.lastError = null;
    });
  }

  // identity.getRedirectURL: the address the browser the extension was built
  // for gives, which the sign-in provider has on record (Chrome's names the
  // extension's id, Firefox's a hash of it). Chrome answers it at once, in
  // every context, so each answers it itself.
  function identityRedirectURL(path) {
    var base = CONFIG.identityRedirectURL ||
      "https://" + String(CONFIG.extensionId).toLowerCase().replace(/[^a-z0-9-]/g, "-") + ".chromiumapp.org/";
    return base + String(path || "").replace(/^\/+/, "");
  }

  // An event of the engine's, seen through an adapter: `adapt` turns the
  // extension's listener into the one the engine is given.
  function adaptEvent(source, adapt, options) {
    var o = options || {};
    var pairs = [];

    function indexOf(fn) {
      for (var i = 0; i < pairs.length; i++) {
        if (pairs[i].fn === fn) {
          return i;
        }
      }
      return -1;
    }

    return {
      addListener: function (fn) {
        if (typeof fn !== "function" || (!o.repeatable && indexOf(fn) >= 0)) {
          return;
        }
        var extra = Array.prototype.slice.call(arguments, 1);
        var adapted = adapt(fn, extra);
        pairs.push({ fn: fn, adapted: adapted });
        source.addListener.apply(source, [adapted].concat(o.passArguments ? extra : []));
      },
      removeListener: function (fn) {
        for (var i = pairs.length - 1; i >= 0; i--) {
          if (pairs[i].fn === fn) {
            source.removeListener(pairs[i].adapted);
            pairs.splice(i, 1);
          }
        }
      },
      hasListener: function (fn) {
        return indexOf(fn) >= 0;
      },
      hasListeners: function () {
        return pairs.length > 0;
      }
    };
  }

  // The extension's origin as Chrome-written code checks it. Chrome gives an
  // extension page's sender the origin of runtime.getURL(""), and code tests
  // them against each other as `sender.origin + "/" === getURL("")` or as
  // `sender.origin === new URL(getURL("")).origin`. Here getURL("") carries
  // the bundle's per-session token, which a URL's origin leaves out, so the
  // extension's origin is that URL without its final slash, and in the
  // extension's own pages a URL of the extension reports it as its origin
  // (installExtensionOrigin).
  var extensionOrigin = baseURI.replace(/\/$/, "");

  // Chrome's documentId, which the engine does not report: an id for each
  // document a frame commits, kept until the frame commits another. An id
  // holds its tab and frame, so any context can tell where it points, and ends
  // in a digest of the commit, which every context told of that commit agrees
  // on. A document committed before a context was listening gets the digest of
  // its place until the global page's ids arrive (learnDocumentIds).
  var documentIds = {};
  var DOCUMENT_ID = /^[0-9A-F]{32}$/;
  var TAB_DIGITS = 10;
  var FRAME_DIGITS = 14;
  var DIGEST_DIGITS = 8;

  function hexDigits(value, width) {
    var text = value.toString(16);
    while (text.length < width) {
      text = "0" + text;
    }
    return text;
  }

  // FNV-1a.
  function digestOf(text) {
    var hash = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
      hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
    }
    return hexDigits(hash >>> 0, DIGEST_DIGITS);
  }

  function newDocumentId(tabId, frameId, commit) {
    var digest = digestOf(commit !== undefined ? String(commit) : tabId + ":" + frameId);
    return (hexDigits(tabId, TAB_DIGITS) + hexDigits(frameId, FRAME_DIGITS) + digest).toUpperCase();
  }

  // The id of the document in a frame. `commit` names a commit, so that
  // every listener told of one commit sees the same new id.
  function documentIdFor(tabId, frameId, commit) {
    if (typeof tabId !== "number" || tabId < 0 || typeof frameId !== "number" || frameId < 0) {
      return undefined;
    }
    var key = tabId + ":" + frameId;
    var entry = documentIds[key];
    if (!entry || commit !== undefined && entry.commit !== commit) {
      if (commit !== undefined && frameId === 0) {
        Object.keys(documentIds).forEach(function (other) {
          if (other.indexOf(tabId + ":") === 0) {
            delete documentIds[other];
          }
        });
      }
      entry = documentIds[key] = { id: newDocumentId(tabId, frameId, commit), commit: commit };
    }
    return entry.id;
  }

  // The ids the global page knows, which it heard the commits of, for a context
  // that started after them. A commit this context heard itself stands.
  function learnDocumentIds(known) {
    Object.keys(known || {}).forEach(function (key) {
      if (!documentIds[key] || documentIds[key].commit === undefined) {
        documentIds[key] = known[key];
      }
    });
  }

  function commitOf(details) {
    return String(details.timeStamp) + " " + details.url;
  }

  // The document fields Chrome gives a frame's details: `navigation` for a
  // frame's own navigation, which has no document of its own yet.
  function describeDocument(details, commit, navigation) {
    if (!details || typeof details !== "object" || typeof details.frameId !== "number") {
      return details;
    }
    var top = details.frameId === 0;
    if (details.frameType === undefined) {
      details.frameType = top ? "outermost_frame" : "sub_frame";
    }
    if (!navigation && details.documentId === undefined) {
      details.documentId = documentIdFor(details.tabId, details.frameId, commit);
    }
    if (!navigation && details.documentLifecycle === undefined) {
      details.documentLifecycle = "active";
    }
    if (!top && details.parentDocumentId === undefined && details.parentFrameId >= 0) {
      details.parentDocumentId = documentIdFor(details.tabId, details.parentFrameId);
    }
    return details;
  }

  // A sender as the browser describes one. A message from within the
  // extension names it by its own id, as runtime.id gives it; one from
  // another extension keeps the engine's id for that extension, which
  // includes its signer and so names one alone.
  function describeSender(sender, external) {
    var s = sender || {};
    if (!external || s.id === undefined) {
      s.id = RUNTIME_ID;
    } else if (chromeIdOfBundle(s.id)) {
      s.id = chromeIdOfBundle(s.id);
    }
    if (s.tab && typeof s.frameId === "number" && s.documentId === undefined) {
      s.documentId = documentIdFor(s.tab.id, s.frameId);
      s.documentLifecycle = "active";
    }
    // A service worker runs inside a generated HTML page. Messages still
    // identify its manifest-declared script, as they do in a worker host,
    // and background scripts the page the browser generates for them.
    var worker = CONFIG.manifest && CONFIG.manifest.background &&
      CONFIG.manifest.background.service_worker;
    if (CONFIG.backgroundPage && !s.tab && s.url === extUrl(CONFIG.backgroundPage)) {
      if (worker) {
        s.url = extUrl(worker);
      } else if (GENERATED_BACKGROUND) {
        s.url = extUrl(BACKGROUND_PAGE_ALIAS);
      }
    }
    if (s.origin === undefined && s.url) {
      var m = /^[a-z][a-z0-9+.\-]*:\/\/[^\/]*/i.exec(s.url);
      if (isExtUrl(s.url)) {
        s.origin = extensionOrigin;
      } else if (m) {
        s.origin = m[0];
      }
    }
    return s;
  }

  // The members of a namespace, as dotted paths ("runtime.getURL"), so an
  // extension page can tell which of the global page's members exist before
  // it could ask. Published by the global page, read by extension pages.
  var NAMESPACE_SHAPE_KEY = "wex.namespaceShape";

  // `values`, when given, receives the members that are strings, numbers or
  // booleans, as the enums and limits are, so a page has their values too.
  function namespaceShape(namespace, values) {
    var paths = [];
    function walk(object, prefix, depth) {
      Object.keys(object).forEach(function (name) {
        if (name.indexOf("__") === 0) {
          return;
        }
        var value = object[name];
        var path = prefix ? prefix + "." + name : name;
        paths.push(path);
        if (values && (typeof value === "string" || typeof value === "number" ||
            typeof value === "boolean")) {
          values[path] = value;
        }
        if (depth < 4 && value && typeof value === "object" && !Array.isArray(value) &&
            typeof value.addListener !== "function") {
          walk(value, path, depth + 1);
        }
      });
    }
    walk(namespace, "", 0);
    return paths;
  }

  // WEX, kept from code that takes globals away: a sandbox may
  // replace every global it does not need with one
  // that throws, and leave alone only those it cannot redefine. The
  // runtime reaches everything else through WEX or what it took at load.
  function pinRuntimeGlobals(g) {
    try {
      Object.defineProperty(g, "WEX", { value: g.WEX, writable: false });
    } catch (e) { /* left as it is */ }
  }

  // requestIdleCallback, which WebKit leaves out of extension pages though
  // web pages have it. A callback runs once the page's other work allows,
  // or when its timeout is up, and is told how long it may take.
  // navigator.connection, which Chrome gives its pages and workers and
  // WebKit does not: estimates of the connection, as Chrome gives them for a
  // fast one, and a change event that does not fire.
  function installNetworkInformation(g) {
    var nav = g.navigator;
    if (CONFIG.firefoxBuild || !nav || nav.connection || typeof g.EventTarget !== "function") {
      return;
    }
    try {
      var connection = new g.EventTarget();
      connection.effectiveType = "4g";
      connection.downlink = 10;
      connection.rtt = 50;
      connection.saveData = false;
      connection.onchange = null;
      Object.defineProperty(nav, "connection", { value: connection, configurable: true });
    } catch (e) { /* the navigator stays as WebKit has it */ }
  }

  // A frame a script points at a page the manifest serves sandboxed is given
  // the sandbox, with the manifest's flags, before the page loads in it, as
  // Chrome serves such a page; the converter has given the sandbox to the
  // frames the extension's HTML names.
  function installSandboxFrames(g) {
    var pages = CONFIG.sandboxPages || [];
    var Frame = g.HTMLIFrameElement;
    if (!pages.length || !Frame) {
      return;
    }
    function sandboxed(value) {
      try {
        var url = new g.URL(String(value), g.document.baseURI);
        return isExtUrl(url.href) && pages.indexOf(extPath(url.href).split(/[?#]/)[0]) >= 0;
      } catch (e) {
        return false;
      }
    }
    function prepare(frame, value) {
      if (sandboxed(value) && !frame.hasAttribute("sandbox")) {
        frame.setAttribute("sandbox", CONFIG.sandboxFlags || "allow-scripts allow-forms allow-popups allow-modals");
      }
    }
    var descriptor = Object.getOwnPropertyDescriptor(Frame.prototype, "src");
    if (descriptor && descriptor.set) {
      Object.defineProperty(Frame.prototype, "src", {
        configurable: true, enumerable: descriptor.enumerable, get: descriptor.get,
        set: function (value) {
          prepare(this, value);
          descriptor.set.call(this, value);
        }
      });
    }
    var setAttribute = g.Element.prototype.setAttribute;
    g.Element.prototype.setAttribute = function (name, value) {
      if (this instanceof Frame && String(name).toLowerCase() === "src") {
        prepare(this, value);
      }
      return setAttribute.apply(this, arguments);
    };
  }

  // The databases an extension's pages open, by name, kept in its local
  // storage, which outlasts the extension in Safari: a first start after a
  // new install deletes them by name, ahead of any opening of them.
  var DATABASES_KEY = "wex.databases";

  function recordDatabases(g) {
    var idb = g.indexedDB;
    if (!idb || typeof idb.open !== "function") {
      return;
    }
    var open = idb.open;
    try {
      idb.open = function (name) {
        try {
          var names = JSON.parse(localStorageOf(g).getItem(DATABASES_KEY) || "[]");
          if (names.indexOf(String(name)) < 0) {
            names.push(String(name));
            localStorageOf(g).setItem(DATABASES_KEY, JSON.stringify(names));
          }
        } catch (e) { /* no storage to note it in */ }
        return open.apply(this, arguments);
      };
    } catch (e) { /* left as it is */ }
  }

  // Safari keeps an extension's local storage, databases and caches when the
  // user uninstalls it, and clears its settings. A browser removes them with
  // the extension, so on its first start, when its settings hold no
  // installed version, what Safari kept from an earlier install is removed
  // before the extension's own scripts run. The databases named in `known`
  // are the runtime's own.
  function forgetEarlierInstall(g, settings, known) {
    try {
      if (!settings || settings.getItem("wex.installedVersion") !== null) {
        return false;
      }
    } catch (e) {
      return false;
    }
    var idb = g.indexedDB;
    var deleted = {};
    function remove(name) {
      if (idb && !deleted[name]) {
        deleted[name] = true;
        try {
          idb.deleteDatabase(name);
        } catch (e) { /* already gone */ }
      }
    }
    (known || []).forEach(remove);
    try {
      JSON.parse(localStorageOf(g).getItem(DATABASES_KEY) || "[]").forEach(remove);
      localStorageOf(g).clear();
    } catch (e) { /* no storage to clear */ }
    if (idb && typeof idb.databases === "function") {
      idb.databases().then(function (list) {
        (list || []).forEach(function (db) {
          remove(db.name);
        });
      }, function () {});
    }
    if (g.caches && typeof g.caches.keys === "function") {
      g.caches.keys().then(function (keys) {
        keys.forEach(function (key) {
          g.caches["delete"](key);
        });
      }, function () {});
    }
    return true;
  }

  // A browser paints a popup over an opaque base of the default canvas
  // colour, which shows wherever neither the root nor the body, whose
  // background the canvas takes when the root has none, paints one. A
  // popover's view is transparent, and the page behind it would show
  // through. While both are transparent the root is given the base colour,
  // which leaves the body's own background where the page draws it; the
  // page's styles are looked at again as they change, and the base is taken
  // away once either paints a background.
  function installPopupCanvas(g) {
    var doc = g.document;
    var root = doc && doc.documentElement;
    if (!root || typeof g.getComputedStyle !== "function") {
      return;
    }
    var BASE = "canvas";
    var applied = false;
    var pending = false;
    var observer = null;

    function transparent(element) {
      var style = g.getComputedStyle(element);
      return /^(transparent|rgba\(.*,\s*0\))$/.test(style.backgroundColor) &&
        (!style.backgroundImage || style.backgroundImage === "none");
    }

    function check() {
      pending = false;
      try {
        if (applied && root.style.getPropertyValue("background-color") === BASE) {
          root.style.removeProperty("background-color");
        }
        applied = false;
        if (!root.style.getPropertyValue("background-color") && transparent(root) &&
            (!doc.body || transparent(doc.body))) {
          root.style.setProperty("background-color", BASE);
          applied = true;
        }
      } catch (e) { /* left as it is */ }
      if (observer) {
        observer.takeRecords();
      }
    }

    function schedule() {
      if (!pending) {
        pending = true;
        g.setTimeout(check, 0);
      }
    }

    check();
    if (typeof g.MutationObserver === "function") {
      observer = new g.MutationObserver(schedule);
      observer.observe(root, { attributes: true, attributeFilter: ["class", "style"], childList: true });
      var watchBody = function () {
        if (doc.body) {
          observer.observe(doc.body, { attributes: true, attributeFilter: ["class", "style"] });
        }
        if (doc.head) {
          observer.observe(doc.head, { childList: true, subtree: true, characterData: true });
        }
      };
      watchBody();
      doc.addEventListener("DOMContentLoaded", function () {
        watchBody();
        schedule();
      });
    }
    // A stylesheet that finishes loading, and rules a script inserts into a
    // sheet, change the page's styles without changing its document.
    doc.addEventListener("load", schedule, true);
    g.addEventListener("load", schedule);
    g.setInterval(check, 1000);
  }

  function installIdleCallback(g) {
    if (typeof g.requestIdleCallback === "function" || typeof g.setTimeout !== "function") {
      return;
    }
    var BUDGET = 50;
    var pending = {};
    var nextHandle = 1;
    function now() {
      return g.performance && g.performance.now ? g.performance.now() : Date.now();
    }
    g.requestIdleCallback = function (callback, options) {
      if (typeof callback !== "function") {
        throw new TypeError("Failed to execute 'requestIdleCallback': " +
          "parameter 1 is not of type 'IdleRequestCallback'.");
      }
      var handle = nextHandle++;
      var timeout = options && options.timeout > 0 ? Number(options.timeout) : 0;
      var timedOut = false;
      var expiry = null;
      function run() {
        if (!pending[handle]) {
          return;
        }
        delete pending[handle];
        var start = now();
        callback({
          didTimeout: timedOut,
          timeRemaining: function () {
            return Math.max(0, BUDGET - (now() - start));
          }
        });
      }
      pending[handle] = g.setTimeout(function () {
        if (expiry !== null) {
          g.clearTimeout(expiry);
        }
        run();
      }, 1);
      if (timeout) {
        expiry = g.setTimeout(function () {
          timedOut = true;
          run();
        }, timeout);
      }
      return handle;
    };
    g.cancelIdleCallback = function (handle) {
      if (pending[handle]) {
        g.clearTimeout(pending[handle]);
        delete pending[handle];
      }
    };
  }

  // Code builds an address of the extension's own from its origin, as
  // `new URL(path, location.origin)`, expecting one of the extension's files.
  // Here those live under the session token, which Safari's origin leaves out
  // and the runtime's ends with, so in the extension's own pages a relative
  // path resolved against either origin is resolved against its root
  // instead, as getURL resolves it, and names the file it would name in a
  // browser (served).

  function installExtensionUrlBase(g) {
    var NativeURL = g.URL;
    if (typeof NativeURL !== "function" || typeof g.Proxy !== "function" || !baseURI) {
      return;
    }
    var bases = [origin.toLowerCase(), extensionOrigin.toLowerCase()];
    var patched = new g.Proxy(NativeURL, {
      construct: function (target, args, newTarget) {
        var list = Array.prototype.slice.call(args);
        var relative = list.length > 1 && list[1] != null ? String(list[0]) : null;
        if (relative !== null && !/^[a-z][a-z0-9+.\-]*:/i.test(relative) &&
            relative.slice(0, 2) !== "//" && (relative + "/").indexOf(basePath) !== 0 &&
            bases.indexOf(String(list[1]).toLowerCase().replace(/\/$/, "")) >= 0) {
          list[0] = relative.replace(/^\/+/, "");
          list[1] = baseURI;
        }
        // A DOM constructor refuses to be built for a proxy of itself.
        return Reflect.construct(target, list, newTarget === patched ? target : newTarget);
      }
    });
    try {
      Object.defineProperty(g, "URL", { value: patched, configurable: true, writable: true });
    } catch (e) { /* the host keeps URL as it is */ }
  }

  // In Chrome the host of the extension's addresses is its id, and code
  // makes one of its addresses from another by setting the host to the id
  // (`url.hostname = chrome.i18n.getMessage("@@extension_id")`). Here the
  // host is the bundle's, so setting the host or hostname of one of the
  // extension's own addresses to its id keeps the bundle's host.
  function installExtensionHostAlias(g) {
    var proto = g.URL && g.URL.prototype;
    if (!proto || !baseURI) {
      return;
    }
    var ownHost = origin.replace(/^[a-z][a-z0-9+.\-]*:\/\//i, "").toLowerCase();
    var id = String(RUNTIME_ID || "").toLowerCase();
    var protocol = Object.getOwnPropertyDescriptor(proto, "protocol");
    var host = Object.getOwnPropertyDescriptor(proto, "host");
    if (!id || id === ownHost || !protocol || !protocol.get || !host || !host.get) {
      return;
    }
    function keepsHost(url, value) {
      return String(value).toLowerCase() === id &&
        protocol.get.call(url).toLowerCase() === origin.split("//")[0].toLowerCase() &&
        host.get.call(url).toLowerCase() === ownHost;
    }
    ["host", "hostname"].forEach(function (name) {
      var native = Object.getOwnPropertyDescriptor(proto, name);
      if (!native || !native.set || !native.configurable) {
        return;
      }
      Object.defineProperty(proto, name, {
        configurable: true,
        enumerable: native.enumerable,
        get: native.get,
        set: function (value) {
          if (!keepsHost(this, value)) {
            native.set.call(this, value);
          }
        }
      });
    });
  }

  // BACKGROUND_PAGE_ALIAS where `g` is the global page the converter
  // generated for background scripts, or null.
  function generatedBackgroundOf(g) {
    var here = String(g.location && g.location.href || "").split(/[?#]/)[0];
    return GENERATED_BACKGROUND && here === baseURI + GENERATED_BACKGROUND ? BACKGROUND_PAGE_ALIAS : null;
  }

  // The path of the service worker the global page `g` stands in for, as
  // the manifest names it, or null where it is not the global page of one.
  function workerScript(g) {
    var background = CONFIG.manifest && CONFIG.manifest.background;
    var worker = background && typeof background.service_worker === "string" ? background.service_worker : null;
    var page = CONFIG.backgroundPage ? String(CONFIG.backgroundPage) : null;
    if (!worker || !page) {
      return null;
    }
    var here = String(g.location && g.location.href || "").split(/[?#]/)[0];
    return here === baseURI + page ? worker.replace(/^\/+/, "") : null;
  }

  // URL#origin for the extension's own URLs gives the extension's origin, so
  // `new URL(chrome.runtime.getURL("")).origin` agrees with an extension
  // page's sender, and URL#pathname gives the path within the bundle, as in
  // Chrome: origin, pathname, search and hash still make up the href. Only
  // the extension's own pages get this; content scripts compare origins with
  // the messages of the extension's frames, which carry the real one.
  function installExtensionOrigin(g) {
    var proto = g.URL && g.URL.prototype;
    var native = proto && Object.getOwnPropertyDescriptor(proto, "origin");
    var nativePath = proto && Object.getOwnPropertyDescriptor(proto, "pathname");
    if (!native || typeof native.get !== "function" || !baseURI) {
      return;
    }
    var prefix = baseURI.toLowerCase();
    function own(url) {
      return String(url.href).toLowerCase().indexOf(prefix) === 0;
    }
    Object.defineProperty(proto, "origin", {
      configurable: true,
      enumerable: native.enumerable,
      get: function () {
        return own(this) ? extensionOrigin : native.get.call(this);
      }
    });
    // So do a message from one of the extension's own pages and the page's
    // own window.origin, which WebKit gives as the bare origin in lowercase.
    var bareOrigin = origin.toLowerCase();
    var eventProto = g.MessageEvent && g.MessageEvent.prototype;
    var eventOrigin = eventProto && Object.getOwnPropertyDescriptor(eventProto, "origin");
    if (eventOrigin && typeof eventOrigin.get === "function") {
      try {
        Object.defineProperty(eventProto, "origin", {
          configurable: true,
          enumerable: eventOrigin.enumerable,
          get: function () {
            var value = eventOrigin.get.call(this);
            return String(value).toLowerCase() === bareOrigin ? extensionOrigin : value;
          }
        });
      } catch (e) { /* messages keep WebKit's origin */ }
    }
    try {
      if (String(g.origin).toLowerCase() === bareOrigin) {
        Object.defineProperty(g, "origin", { configurable: true, enumerable: true, value: extensionOrigin });
      }
    } catch (e) { /* the window keeps WebKit's origin */ }
    // A page's location cannot be changed so, but the converter has the
    // extension's reads of location.pathname, location.origin and
    // location.href ask for these instead. A service worker's location is
    // its script's address, so where the global page stands in for one,
    // its location reads as the worker's; where it stands in for the page a
    // browser generates for background scripts, as that page's.
    var locationProto = g.Location && g.Location.prototype;
    var worker = workerScript(g);
    var standIn = worker || generatedBackgroundOf(g);
    // A service worker's own `window`, `document` and the like, which the
    // converter has its assignments make here, as a window refuses them.
    // Its `location`, which the converter has reads of `self.location` and
    // `globalThis.location` as a whole ask for, is the worker's, as a
    // WorkerLocation gives it: the script's address, under the extension's
    // origin as the runtime gives it.
    if (worker) {
      try {
        var scriptURL = new g.URL(baseURI + worker);
        var workerLocation = {
          href: scriptURL.href, origin: extensionOrigin, protocol: scriptURL.protocol,
          host: scriptURL.host, hostname: scriptURL.hostname, port: scriptURL.port,
          pathname: "/" + worker, search: "", hash: ""
        };
        Object.defineProperty(workerLocation, "toString", {
          value: function () {
            return workerLocation.href;
          }
        });
        var workerScope = { location: workerLocation };
        Object.defineProperty(g, "__wexWorkerScope", { configurable: true, value: workerScope });
        // The global as the worker destructures it: its own location,
        // window and document from the scope, the rest from the global.
        Object.defineProperty(g, "__wexWorkerSelf", { configurable: true, value: new g.Proxy(g, {
          get: function (target, name) {
            return name === "location" || name === "window" || name === "document" ?
              workerScope[name] : Reflect.get(target, name);
          }
        }) });
      } catch (e) { /* the assignments are made as written */ }
    }
    if (locationProto) {
      try {
        Object.defineProperty(locationProto, "__wexPathname", {
          configurable: true,
          get: function () {
            if (standIn && this === g.location) {
              return "/" + standIn;
            }
            var path = this.pathname;
            return own(this) && path.indexOf(basePath) === 0
              ? "/" + path.slice(basePath.length) : path;
          }
        });
        Object.defineProperty(locationProto, "__wexHref", {
          configurable: true,
          get: function () {
            return standIn && this === g.location ? baseURI + standIn : this.href;
          }
        });
        Object.defineProperty(locationProto, "__wexOrigin", {
          configurable: true,
          get: function () {
            return own(this) ? extensionOrigin : this.origin;
          }
        });
      } catch (e) { /* reads fall back to the location's own values */ }
    }
    if (!nativePath || typeof nativePath.get !== "function" ||
        typeof nativePath.set !== "function") {
      return;
    }
    Object.defineProperty(proto, "pathname", {
      configurable: true,
      enumerable: nativePath.enumerable,
      get: function () {
        var path = nativePath.get.call(this);
        return own(this) && path.indexOf(basePath) === 0
          ? "/" + path.slice(basePath.length) : path;
      },
      set: function (value) {
        var path = String(value);
        if (own(this) && (path + "/").indexOf(basePath) !== 0) {
          path = basePath + path.replace(/^\//, "");
        }
        nativePath.set.call(this, path);
      }
    });
  }

  // Whether an extension id names this extension: its own id, the engine's
  // key for it, or the Chrome id it was converted from.
  // The bundle another converted extension is in, from the id its browser
  // knows it by, as the converter makes it (deriveBundleId): a Chrome id's
  // bundle is com.webext2safari and the id, a Firefox id's is made from it.
  // Any other id is taken for a bundle's own.
  var CONVERTED_PREFIX = "com.webext2safari.";

  function bundleComponents(candidate) {
    var parts = [];
    String(candidate).split(".").forEach(function (raw) {
      var cleaned = raw.replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
      if (cleaned) {
        parts.push(/^[A-Za-z]/.test(cleaned) ? cleaned : "x" + cleaned);
      }
    });
    return parts.join(".") || CONVERTED_PREFIX + "extension";
  }

  function bundleIdFor(id) {
    var name = String(id);
    if (/^[a-p]{32}$/.test(name)) {
      return CONVERTED_PREFIX + name;
    }
    if (name.charAt(0) === "{" || name.indexOf("@") >= 0) {
      var local = name.replace(/^[{}]+|[{}]+$/g, "").replace(/@/g, ".");
      var slug = local.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "extension";
      return bundleComponents(CONVERTED_PREFIX + slug);
    }
    return name;
  }

  // The Chrome id of a converted Chrome build, from its bundle's id as the
  // engine gives it (with the developer's team after a hyphen), or null.
  function chromeIdOfBundle(bundle) {
    var m = /^com\.webext2safari\.([a-p]{32})(?:-[A-Za-z0-9]+)?$/.exec(String(bundle || ""));
    return m ? m[1] : null;
  }

  function namesSelf(id) {
    if (id == null || id === "") {
      return true;
    }
    var name = String(id);
    var own = String(CONFIG.extensionId);
    var source = /^chrome-extension:\/\/([a-p]{32})$/.exec(CONFIG.sourceOrigin || "");
    // The engine's key for the extension is the host of its address.
    var key = origin.replace(/^[^:]*:\/\//, "").toLowerCase();
    return name === own || name === RUNTIME_ID || (!!key && name.toLowerCase() === key) ||
      !!(source && name === source[1]);
  }

  // ------------------------------------------------------------------ //
  // proxy
  // ------------------------------------------------------------------ //
  // The engine has Chrome's proxy.settings and onProxyError, and Firefox's
  // onRequest and onError. A build gets its own browser's members. Firefox's
  // proxy.settings is a BrowserSetting whose value is Firefox's proxy
  // configuration, given to the engine as Chrome's.
  function proxyServer(text, scheme) {
    var match = /^\s*(?:([a-z0-9]+):\/\/)?([^:\/\s]+|\[[^\]]+\])(?::(\d+))?\s*$/i.exec(String(text || ""));
    if (!match) {
      return null;
    }
    var server = { scheme: match[1] ? match[1].toLowerCase() : scheme, host: match[2] };
    if (match[3]) {
      server.port = Number(match[3]);
    }
    return server;
  }

  function serverText(server) {
    return server ? server.host + (server.port ? ":" + server.port : "") : "";
  }

  function chromeProxyConfig(value) {
    var v = value || {};
    switch (v.proxyType) {
      case "none":
        return { mode: "direct" };
      case "autoDetect":
        return { mode: "auto_detect" };
      case "autoConfig":
        return { mode: "pac_script", pacScript: { url: String(v.autoConfigUrl || "") } };
      case "manual":
        var rules = {};
        var http = proxyServer(v.http, "http");
        var ssl = proxyServer(v.ssl, "http");
        var socks = proxyServer(v.socks, Number(v.socksVersion) === 4 ? "socks4" : "socks5");
        if (http && v.httpProxyAll) {
          rules.singleProxy = http;
        } else {
          if (http) {
            rules.proxyForHttp = http;
          }
          if (ssl) {
            rules.proxyForHttps = ssl;
          }
          if (socks) {
            rules.fallbackProxy = socks;
          }
        }
        if (v.passthrough) {
          rules.bypassList = String(v.passthrough).split(/[\s,]+/).filter(Boolean);
        }
        return { mode: "fixed_servers", rules: rules };
      default:
        return { mode: "system" };
    }
  }

  function firefoxProxyConfig(config) {
    var c = config || {};
    var out = {
      proxyType: "system", autoConfigUrl: "", autoLogin: false, proxyDNS: false,
      httpProxyAll: false, socksVersion: 5, passthrough: "", http: "", ssl: "", socks: "",
      respectBeConservative: true
    };
    var rules = c.rules || {};
    switch (c.mode) {
      case "direct":
        out.proxyType = "none";
        break;
      case "auto_detect":
        out.proxyType = "autoDetect";
        break;
      case "pac_script":
        out.proxyType = "autoConfig";
        out.autoConfigUrl = (c.pacScript && c.pacScript.url) || "";
        break;
      case "fixed_servers":
        out.proxyType = "manual";
        var single = rules.singleProxy;
        if (single && /^socks/.test(single.scheme)) {
          out.socks = serverText(single);
          out.socksVersion = single.scheme === "socks4" ? 4 : 5;
        } else if (single) {
          out.http = serverText(single);
          out.httpProxyAll = true;
        }
        out.http = out.http || serverText(rules.proxyForHttp);
        out.ssl = serverText(rules.proxyForHttps);
        if (rules.fallbackProxy) {
          out.socks = serverText(rules.fallbackProxy);
          out.socksVersion = rules.fallbackProxy.scheme === "socks4" ? 4 : 5;
        }
        out.passthrough = (rules.bypassList || []).join(", ");
        break;
    }
    return out;
  }

  function firefoxProxySettings(setting) {
    var onChange = new Event("proxy.settings.onChange");
    if (setting.onChange && typeof setting.onChange.addListener === "function") {
      setting.onChange.addListener(function (details) {
        onChange.emit({ value: firefoxProxyConfig(details && details.value),
          levelOfControl: details && details.levelOfControl });
      });
    }
    return {
      onChange: onChange,
      get: function (details, cb) {
        var c = shiftCallback(details, cb);
        return settle(Promise.resolve(setting.get(c.opts)).then(function (result) {
          return { value: firefoxProxyConfig(result && result.value),
            levelOfControl: result && result.levelOfControl };
        }), c.cb);
      },
      set: function (details, cb) {
        var d = details || {};
        return settle(Promise.resolve(setting.set({ value: chromeProxyConfig(d.value) })).then(function () {
          return true;
        }), cb);
      },
      clear: function (details, cb) {
        var c = shiftCallback(details, cb);
        return settle(Promise.resolve(setting.clear({})).then(function () {
          return true;
        }), c.cb);
      }
    };
  }

  function makeProxy(native) {
    var engineProxy = native && native.proxy;
    if (!engineProxy) {
      return undefined;
    }
    if (!CONFIG.firefoxBuild) {
      return { settings: engineProxy.settings, onProxyError: engineProxy.onProxyError };
    }
    return {
      onRequest: engineProxy.onRequest,
      onError: engineProxy.onError,
      settings: engineProxy.settings ? firefoxProxySettings(engineProxy.settings) : undefined
    };
  }

  // ------------------------------------------------------------------ //
  // devtools
  // ------------------------------------------------------------------ //
  // The engine's devtools for a devtools page. Safari's Web Inspector has no
  // place for an extension's panel, so devtools.panels makes none and says
  // so, which leaves the rest of the page running.
  var NO_PANELS = "Panels are not available in this browser's developer tools.";

  function makeDevtools(native) {
    var engineDevtools = native && native.devtools;
    if (!engineDevtools) {
      return undefined;
    }
    function noPanel() {
      var cb = arguments[arguments.length - 1];
      return fail(typeof cb === "function" ? cb : null, NO_PANELS);
    }
    var sidebarHost = { createSidebarPane: noPanel, onSelectionChanged: new Event("devtools.panels.elements.onSelectionChanged") };
    return {
      inspectedWindow: engineDevtools.inspectedWindow,
      network: engineDevtools.network,
      panels: {
        themeName: "default",
        onThemeChanged: new Event("devtools.panels.onThemeChanged"),
        create: noPanel,
        setOpenResourceHandler: function () {},
        openResource: noPanel,
        elements: sidebarHost,
        sources: { createSidebarPane: noPanel, onSelectionChanged: new Event("devtools.panels.sources.onSelectionChanged") }
      }
    };
  }

  // runtime.sendMessage, connect, onMessage and onConnect, and their
  // counterparts for other extensions, for one context.
  function makeMessaging(native) {
    function externalEvent(source, isPort) {
      if (!source || typeof source.addListener !== "function") {
        return new Event(isPort ? "runtime.onConnectExternal" : "runtime.onMessageExternal");
      }
      return adaptEvent(source, function (fn) {
        if (isPort) {
          return function (port) {
            if (isInternalPort(port)) {
              return;
            }
            describeSender(port.sender, true);
            fn(port);
          };
        }
        return function (message, sender, sendResponse) {
          if (isInternal(message)) {
            return undefined;
          }
          return fn(message, describeSender(sender, true), sendResponse);
        };
      });
    }

    return {
      onMessageExternal: externalEvent(native.runtime.onMessageExternal, false),
      onConnectExternal: externalEvent(native.runtime.onConnectExternal, true),

      onMessage: adaptEvent(native.runtime.onMessage, function (fn) {
        return function (message, sender, sendResponse) {
          if (isInternal(message)) {
            return undefined;
          }
          return fn(message, describeSender(sender), sendResponse);
        };
      }),

      onConnect: adaptEvent(native.runtime.onConnect, function (fn) {
        return function (port) {
          if (isInternalPort(port)) {
            return;
          }
          describeSender(port.sender);
          fn(port);
        };
      }),

      // Optional extensionId first argument, optional options, optional callback.
      // Which arguments are which, as each browser's bindings tell
      // (Chromium's MassageSendMessageArguments, Firefox's ext-runtime.js):
      // after the callback, one is the message and three are the id, the
      // message and the options. Of two, Chrome takes the first as the id
      // when it could be one, a string or nothing; Firefox only when it is a
      // string that is not empty, and otherwise the message and the options.
      sendMessage: function () {
        var args = Array.prototype.slice.call(arguments);
        var cb = typeof args[args.length - 1] === "function" ? args.pop() : null;
        var target = null;
        if (args.length > 2) {
          target = args.shift();
        } else if (args.length === 2) {
          var first = args[0];
          if (CONFIG.firefoxBuild ? typeof first === "string" && first !== "" :
              typeof first === "string" || first == null) {
            target = args.shift();
          }
        }
        var message = args.shift();
        if (!namesSelf(target)) {
          return settle(native.runtime.sendMessage(bundleIdFor(target), message), cb);
        }
        return settle(native.runtime.sendMessage(message), cb);
      },

      connect: function (a, b) {
        var info = (typeof a === "string" || a == null) ? (b || {}) : a;
        if (typeof a === "string" && !namesSelf(a)) {
          return native.runtime.connect(bundleIdFor(a), { name: info.name || "" });
        }
        return native.runtime.connect({ name: info.name || "" });
      }
    };
  }

  // Chrome's messages of a version 2 manifest: extension.sendRequest and
  // onRequest, a channel of their own beside runtime's, onRequestExternal for
  // other extensions', and tabs.sendRequest to a tab's content scripts. A
  // listener answers with sendResponse, at once or later.
  function legacyRequest(request) {
    var message = { request: request };
    message[INTERNAL_KEY] = "request";
    return message;
  }

  function hasLegacyRequests() {
    return !CONFIG.firefoxBuild && (CONFIG.manifest || {}).manifest_version < 3;
  }

  function requestEvent(source, external) {
    return adaptEvent(source, function (fn) {
      return function (message, sender, sendResponse) {
        if (!isInternal(message) || message[INTERNAL_KEY] !== "request") {
          return undefined;
        }
        fn(message.request, describeSender(sender, external), sendResponse);
        return true;
      };
    });
  }

  function answerRequest(sent, cb) {
    sent.then(function (response) {
      if (typeof cb === "function") {
        cb(response);
      }
    }, function (error) {
      if (typeof cb === "function") {
        fail(cb, error && error.message ? error.message : String(error));
      }
    });
  }

  function addLegacyRequests(extension, native, external) {
    if (!hasLegacyRequests()) {
      return;
    }
    extension.onRequest = requestEvent(native.runtime.onMessage, false);
    if (external && native.runtime.onMessageExternal) {
      extension.onRequestExternal = requestEvent(native.runtime.onMessageExternal, true);
    }
    extension.sendRequest = function () {
      var args = Array.prototype.slice.call(arguments);
      var cb = typeof args[args.length - 1] === "function" ? args.pop() : null;
      // The checks hand on the id, the request and the callback, whichever
      // of them the call left out.
      if (args.length === 3) {
        args.pop();
      }
      var request = args.pop();
      var target = args.length ? args[0] : null;
      answerRequest(namesSelf(target) ? native.runtime.sendMessage(legacyRequest(request)) :
        native.runtime.sendMessage(bundleIdFor(target), legacyRequest(request)), cb);
    };
  }

  // ------------------------------------------------------------------ //
  // Public suffixes
  // ------------------------------------------------------------------ //
  // chrome.publicSuffix, answered where it is called, as Chrome answers it
  // (extensions/renderer/api/public_suffix_util.cc), from the Public Suffix
  // List's rules, ICANN and private alike. A hostname is read as a URL's
  // host is, and a trailing dot stays on what is returned. The display
  // encoding gives a label in Unicode when its letters are all of one script
  // that cannot pass for Latin, or Latin with accents, and in punycode
  // otherwise, as Chrome does for a label it cannot vouch for.
  var PUNYCODE = { base: 36, tMin: 1, tMax: 26, skew: 38, damp: 700, initialBias: 72, initialN: 128 };

  function punycodeToUnicode(label) {
    var input = label.slice(4);
    var output = [];
    var basic = input.lastIndexOf("-");
    var i;
    for (i = 0; i < Math.max(basic, 0); i++) {
      output.push(input.charCodeAt(i));
    }
    function adapt(delta, points, first) {
      var k = 0;
      delta = first ? Math.floor(delta / PUNYCODE.damp) : delta >> 1;
      delta += Math.floor(delta / points);
      for (; delta > ((PUNYCODE.base - PUNYCODE.tMin) * PUNYCODE.tMax) >> 1; k += PUNYCODE.base) {
        delta = Math.floor(delta / (PUNYCODE.base - PUNYCODE.tMin));
      }
      return Math.floor(k + (PUNYCODE.base - PUNYCODE.tMin + 1) * delta / (delta + PUNYCODE.skew));
    }
    var n = PUNYCODE.initialN;
    var bias = PUNYCODE.initialBias;
    var at = 0;
    for (var index = basic > 0 ? basic + 1 : 0; index < input.length;) {
      var old = at;
      for (var w = 1, k = PUNYCODE.base; ; k += PUNYCODE.base) {
        if (index >= input.length) {
          return null;
        }
        var c = input.charCodeAt(index++);
        var digit = c >= 48 && c < 58 ? c - 22 : c >= 97 && c < 123 ? c - 97 : PUNYCODE.base;
        if (digit >= PUNYCODE.base) {
          return null;
        }
        at += digit * w;
        var t = k <= bias ? PUNYCODE.tMin : k >= bias + PUNYCODE.tMax ? PUNYCODE.tMax : k - bias;
        if (digit < t) {
          break;
        }
        w *= PUNYCODE.base - t;
      }
      bias = adapt(at - old, output.length + 1, old === 0);
      n += Math.floor(at / (output.length + 1));
      at %= output.length + 1;
      output.splice(at++, 0, n);
    }
    var out = "";
    for (i = 0; i < output.length; i++) {
      out += output[i] > 0xFFFF ? String.fromCharCode(0xD800 + ((output[i] - 0x10000) >> 10),
        0xDC00 + ((output[i] - 0x10000) & 0x3FF)) : String.fromCharCode(output[i]);
    }
    return out;
  }

  // Scripts a label may be shown in, by their code points.
  var DISPLAY_SCRIPTS = [
    /^[a-z0-9\-\u00c0-\u024f]+$/,
    /^[0-9\-\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u30fc]+$/,
    /^[0-9\-\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]+$/,
    /^[0-9\-\u0600-\u06ff]+$/,
    /^[0-9\-\u0590-\u05ff]+$/,
    /^[0-9\-\u0e00-\u0e7f]+$/,
    /^[0-9\-\u0900-\u097f]+$/
  ];

  function displayLabel(label) {
    if (label.indexOf("xn--") !== 0) {
      return label;
    }
    var unicode = punycodeToUnicode(label);
    if (unicode === null) {
      return label;
    }
    for (var i = 0; i < DISPLAY_SCRIPTS.length; i++) {
      if (DISPLAY_SCRIPTS[i].test(unicode) && (i !== 0 || /[^\x00-\x7f]/.test(unicode))) {
        return unicode;
      }
    }
    return label;
  }

  // The rules of the Public Suffix List, ICANN's alone when `icannOnly`, as
  // the number of a host's last labels that make its public suffix, or 0
  // when no rule applies.
  function suffixRules(text, icannOnly) {
    var normal = {};
    var wildcard = {};
    var exception = {};
    var lines = String(text || "").split("\n");
    for (var r = 0; r < lines.length; r++) {
      var rule = lines[r];
      if (rule === "// private") {
        if (icannOnly) {
          break;
        }
        continue;
      }
      if (!rule) {
        continue;
      }
      if (rule.charAt(0) === "!") {
        exception[rule.slice(1)] = true;
      } else if (rule.indexOf("*.") === 0) {
        wildcard[rule.slice(2)] = true;
      } else {
        normal[rule] = true;
      }
    }
    return function knownLabels(labels) {
      var i;
      for (i = 0; i < labels.length; i++) {
        if (exception[labels.slice(i).join(".")]) {
          return labels.length - i - 1;
        }
      }
      for (i = 0; i < labels.length; i++) {
        var n = labels.length - i;
        if (normal[labels.slice(i).join(".")] || (n > 1 && wildcard[labels.slice(i + 1).join(".")])) {
          return n;
        }
      }
      return 0;
    };
  }

  // The list a bundle for Chrome carries, as does one for Firefox with
  // declarativeNetRequest, read when a call first needs it.
  var SUFFIX_LIST = "wex/public-suffix-list.txt";
  var bundledRules = {};

  function bundledSuffixRules(icannOnly) {
    var key = icannOnly ? "icann" : "all";
    if (!bundledRules[key]) {
      var text = readTextSync(SUFFIX_LIST);
      if (text == null) {
        throw new Error("The Public Suffix List is missing from the extension.");
      }
      bundledRules[key] = suffixRules(text, icannOnly);
    }
    return bundledRules[key];
  }

  // ------------------------------------------------------------------ //
  // Language detection
  // ------------------------------------------------------------------ //
  // A text's languages are told by Chrome's detector, which the global page
  // runs (wex-global.js) and installs here; any other page, and a content
  // script, asks the global page.
  var NO_LANGUAGE = { isReliable: false, languages: [] };
  var languageDetector = null;

  function setLanguageDetector(detect) {
    languageDetector = detect;
  }

  function detectTextLanguages(text) {
    if (languageDetector) {
      return languageDetector(text);
    }
    // The detector reads no more than its first 10,000 bytes, which are
    // never more than this many characters.
    var sample = String(text == null ? "" : text).slice(0, 10000);
    return Promise.resolve().then(function () {
      return native.runtime.sendMessage({ __wex: "detectLanguage", text: sample });
    }).then(function (found) {
      return found && Array.isArray(found.languages) ? found : NO_LANGUAGE;
    }, function () {
      return NO_LANGUAGE;
    });
  }

  function makePublicSuffix() {
    return CONFIG.firefoxBuild ? undefined : publicSuffixApi(function () {
      return bundledSuffixRules(false);
    });
  }

  function publicSuffixFrom(text) {
    var rules = suffixRules(text, false);
    return publicSuffixApi(function () {
      return rules;
    });
  }

  function publicSuffixApi(rules) {
    function knownLabels(labels) {
      return rules()(labels);
    }

    function invalid(signature) {
      return new TypeError("Error in invocation of publicSuffix." + signature + ": Invalid hostname");
    }

    // The host as Chrome canonicalizes it, or null for one it refuses.
    function parse(hostname) {
      var h = String(hostname);
      if (/[%\/\\?#@\s]/.test(h) || (/:/.test(h) && !/^\[[0-9a-fA-F:.]+\]$/.test(h))) {
        return null;
      }
      var host;
      try {
        host = new g.URL("http://" + h + "/").hostname;
      } catch (e) {
        return null;
      }
      if (/^\[[0-9a-f:.]+\]$/.test(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
        return { host: host, ip: true };
      }
      var dot = host.charAt(host.length - 1) === ".";
      var labels = (dot ? host.slice(0, -1) : host).split(".");
      for (var i = 0; i < labels.length; i++) {
        if (!/^[a-z0-9_\-]+$/.test(labels[i])) {
          return null;
        }
      }
      return { host: host, ip: false, labels: labels, dot: dot ? "." : "" };
    }

    function knownSuffix(parsed) {
      if (parsed.ip) {
        return null;
      }
      var n = knownLabels(parsed.labels);
      return n ? parsed.labels.slice(-n).join(".") + parsed.dot : null;
    }

    function domain(parsed, options) {
      var o = options || {};
      if (parsed.ip) {
        return o.allowIPAddress ? parsed.host : null;
      }
      var labels = parsed.labels;
      var known = knownLabels(labels);
      var shown = function (list) {
        var out = list.join(".") + parsed.dot;
        return o.encoding === "display" ? list.map(displayLabel).join(".") + parsed.dot : out;
      };
      if (known === labels.length) {
        return o.allowPlainSuffix ? shown(labels) : null;
      }
      if (!known && !o.allowUnknownSuffix) {
        return null;
      }
      return shown(labels.slice(-(Math.max(known, 1) + 1)));
    }

    return {
      isKnownSuffix: function (hostname) {
        var parsed = parse(hostname);
        if (!parsed) {
          throw invalid("isKnownSuffix(string hostname)");
        }
        return !parsed.ip && knownLabels(parsed.labels) === parsed.labels.length;
      },
      getKnownSuffix: function (hostname) {
        var parsed = parse(hostname);
        if (!parsed) {
          throw invalid("getKnownSuffix(string hostname)");
        }
        return knownSuffix(parsed);
      },
      getDomain: function (hostname, options) {
        var parsed = parse(hostname);
        if (!parsed) {
          throw invalid("getDomain(string hostname, optional publicSuffix.DomainOptions options)");
        }
        return domain(parsed, options);
      }
    };
  }

  // dom.openOrClosedShadowRoot for an extension's own pages, which the
  // engine gives content scripts alone. The runtime runs before the page's
  // scripts, and keeps each closed shadow root as it is attached.
  function makePageDom(g) {
    var proto = g.Element && g.Element.prototype;
    if (!proto || typeof proto.attachShadow !== "function" || typeof g.WeakMap !== "function") {
      return undefined;
    }
    var closed = new g.WeakMap();
    var attach = proto.attachShadow;
    proto.attachShadow = function (init) {
      var root = attach.apply(this, arguments);
      if (init && init.mode === "closed") {
        closed.set(this, root);
      }
      return root;
    };
    return {
      openOrClosedShadowRoot: function (element) {
        if (!(element instanceof g.HTMLElement)) {
          throw new TypeError("Error in invocation of dom.openOrClosedShadowRoot(HTMLElement element): " +
            "No matching signature.");
        }
        return element.shadowRoot || closed.get(element) || null;
      }
    };
  }

  // The kinds of declarativeContent's conditions and actions, which a rule
  // names by their instanceType.
  function declarativeContentTypes() {
    var types = {};
    ["PageStateMatcher", "ShowAction", "ShowPageAction", "SetIcon", "RequestContentScript"]
      .forEach(function (type) {
        function Instance(options) {
          var self = this instanceof Instance ? this : Object.create(Instance.prototype);
          Object.keys(options || {}).forEach(function (key) {
            self[key] = options[key];
          });
          self.instanceType = "declarativeContent." + type;
          return self;
        }
        types[type] = Instance;
      });
    return types;
  }

  // tabs.sendMessage and tabs.connect, for the extension's pages. A message
  // to a tab no frame of which listens fails as Chrome fails it, where the
  // engine would answer it with nothing: the bridge in each frame that has
  // a listener says so first.
  var NO_TAB_RECEIVER = "Could not establish connection. Receiving end does not exist.";

  // The frame of a tab that an id points to, or null for an id that is not one
  // of a document in that tab, or is of a document the frame has since replaced.
  function frameOfDocument(tabId, documentId) {
    var text = String(documentId);
    if (!DOCUMENT_ID.test(text) || parseInt(text.slice(0, TAB_DIGITS), 16) !== Number(tabId)) {
      return null;
    }
    var frame = parseInt(text.slice(TAB_DIGITS, TAB_DIGITS + FRAME_DIGITS), 16);
    var known = documentIds[tabId + ":" + frame];
    if (known && known.commit !== undefined && known.id !== text &&
        text !== newDocumentId(Number(tabId), frame)) {
      return null;
    }
    return frame;
  }

  var NO_DOCUMENT_FRAME = -1;

  // The frame a call's options name, by document or by frame id.
  function namedFrame(tabId, given) {
    if (given.documentId != null) {
      var frame = frameOfDocument(tabId, given.documentId);
      return frame !== null ? frame : NO_DOCUMENT_FRAME;
    }
    return given.frameId;
  }

  function makeTabMessaging(native) {
    return {
      sendMessage: function (id, message, opts, cb) {
        var c = shiftCallback(opts, cb);
        var options = {};
        var frame = namedFrame(id, c.opts);
        if (frame === NO_DOCUMENT_FRAME) {
          return settle(Promise.reject(new Error(NO_TAB_RECEIVER)), c.cb);
        }
        if (frame != null) {
          options.frameId = frame;
        }
        var asked = Promise.resolve(native.tabs.sendMessage(id, { __wex: "listening" }, options));
        return settle(asked.then(function (answer) {
          if (!answer || answer.listening !== true) {
            throw new Error(NO_TAB_RECEIVER);
          }
          return native.tabs.sendMessage(id, message, options);
        }), c.cb);
      },
      connect: function (id, info) {
        var i = info || {};
        var options = { name: i.name || "" };
        var frame = namedFrame(id, i);
        if (frame != null) {
          options.frameId = frame;
        }
        return native.tabs.connect(id, options);
      }
    };
  }

  // ------------------------------------------------------------------ //
  // Checking a call's arguments
  // ------------------------------------------------------------------ //
  // Chrome checks every call to its API against the API's schema before the
  // call does anything, and throws a TypeError for one that does not fit. The
  // converter writes the schemas of the namespaces the extension can have as
  // WEX_API, in the form Chrome builds them into the browser; the checks
  // follow Chrome's (extensions/renderer/bindings/api_signature.cc and
  // argument_spec.cc), and so do their errors.
  // Chrome's ids fit in 32 bits and this browser's frame ids do not (a frame
  // below the top is 588410519553), so a whole number a double holds exactly
  // counts as an integer, that an id the browser gives can be handed back.
  function isInteger(value) {
    return typeof value === "number" && isFinite(value) && Math.floor(value) === value &&
      Math.abs(value) <= 9007199254740991 && !(value === 0 && 1 / value < 0);
  }

  function isBinary(value) {
    return (typeof ArrayBuffer === "function" && value instanceof ArrayBuffer) ||
      (typeof ArrayBuffer === "function" && typeof ArrayBuffer.isView === "function" &&
       ArrayBuffer.isView(value));
  }

  function valueTypeName(value) {
    if (value === null) {
      return "null";
    }
    if (value === undefined) {
      return "undefined";
    }
    if (isInteger(value)) {
      return "integer";
    }
    if (typeof value === "number") {
      return "number";
    }
    if (typeof value === "boolean" || typeof value === "string" || typeof value === "function") {
      return typeof value;
    }
    if (Array.isArray(value)) {
      return "array";
    }
    if (isBinary(value)) {
      return "binary";
    }
    if (typeof value === "object") {
      return "object";
    }
    return "other";
  }

  function makeApiChecker(api) {
    var specs = {};
    Object.keys(api).forEach(function (ns) {
      (api[ns].types || []).forEach(function (type) {
        specs[type.id] = type;
      });
    });

    function kind(spec) {
      if (spec.$ref) {
        return "ref";
      }
      if (spec.choices) {
        return "choices";
      }
      return spec.type;
    }

    function typeName(spec) {
      switch (kind(spec)) {
        case "number":
          return "number";
        case "object":
          return spec.isInstanceOf || "object";
        case "array":
          return "array";
        case "ref":
          return spec.$ref;
        case "choices":
          return "[" + spec.choices.map(typeName).join("|") + "]";
        default:
          return spec.type;
      }
    }

    // IsCorrectType: the value's basic type only.
    function isCorrectType(spec, value) {
      switch (kind(spec)) {
        case "integer":
          return isInteger(value) || (typeof value === "number" && value === 0);
        case "number":
          return typeof value === "number";
        case "boolean":
          return typeof value === "boolean";
        case "string":
          return typeof value === "string";
        case "object":
          return value !== null && typeof value === "object" && !Array.isArray(value);
        case "array":
          return Array.isArray(value);
        case "binary":
          return isBinary(value);
        case "function":
          return typeof value === "function";
        case "ref":
          return specs[spec.$ref] ? isCorrectType(specs[spec.$ref], value) : true;
        case "choices":
          return spec.choices.some(function (choice) {
            return isCorrectType(choice, value);
          });
        default:
          return true;
      }
    }

    function invalidType(spec, value) {
      return "Invalid type: expected " + typeName(spec) + ", found " + valueTypeName(value) + ".";
    }

    function bounds(spec, value) {
      if (spec.minimum != null && value < spec.minimum) {
        return "Value must be at least " + spec.minimum + ".";
      }
      if (spec.maximum != null && value > spec.maximum) {
        return "Value must be at most " + spec.maximum + ".";
      }
      return null;
    }

    function constructorNamed(value, name) {
      var current = value;
      while (current !== null && (typeof current === "object" || typeof current === "function")) {
        var ctor = null;
        try {
          ctor = current.constructor;
        } catch (e) { /* no constructor to read */ }
        if (ctor && ctor.name === name) {
          return true;
        }
        current = Object.getPrototypeOf(current);
      }
      return false;
    }

    function checkObject(spec, value) {
      var properties = spec.properties || {};
      var keys = Object.keys(value);
      var seen = {};
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var property = null;
        if (hasOwn(properties, key)) {
          property = properties[key];
          seen[key] = true;
        } else if (spec.additionalProperties) {
          property = spec.additionalProperties;
        } else if (spec.ignoreAdditionalProperties) {
          continue;
        } else {
          return "Unexpected property: '" + key + "'.";
        }
        var propertyValue = value[key];
        if (propertyValue == null) {
          if (!property.optional && property !== spec.additionalProperties) {
            return "Missing required property '" + key + "'.";
          }
          continue;
        }
        var error = check(property, propertyValue);
        if (error && !(property === spec.additionalProperties && property.type === "any")) {
          return "Error at property '" + key + "': " + error;
        }
      }
      var names = Object.keys(properties);
      for (var j = 0; j < names.length; j++) {
        if (!properties[names[j]].optional && !seen[names[j]]) {
          return "Missing required property '" + names[j] + "'.";
        }
      }
      if (spec.isInstanceOf && !constructorNamed(value, spec.isInstanceOf)) {
        return "Value must be an instance of " + spec.isInstanceOf + ".";
      }
      return null;
    }

    // ParseArgument: the value against the whole of its spec; an error, or
    // null when it fits.
    function check(spec, value) {
      if (!isCorrectType(spec, value)) {
        return invalidType(spec, value);
      }
      var length;
      switch (kind(spec)) {
        case "integer":
          return bounds(spec, value);
        case "number":
          if (value !== value || value === Infinity || value === -Infinity) {
            return "Value must not be NaN or Infinity.";
          }
          return bounds(spec, value);
        case "string":
          length = value.length;
          if (spec.minLength != null && length < spec.minLength) {
            return "String must have at least " + spec.minLength + " characters; found " + length + ".";
          }
          if (spec.maxLength != null && length > spec.maxLength) {
            return "String must have at most " + spec.maxLength + " characters; found " + length + ".";
          }
          if (spec.enum && spec.enum.indexOf(value) < 0) {
            return "Value must be one of " + spec.enum.slice().sort().join(", ") + ".";
          }
          return null;
        case "object":
          return checkObject(spec, value);
        case "array":
          length = value.length;
          if (spec.minItems != null && length < spec.minItems) {
            return "Array must have at least " + spec.minItems + " items; found " + length + ".";
          }
          if (spec.maxItems != null && length > spec.maxItems) {
            return "Array must have at most " + spec.maxItems + " items; found " + length + ".";
          }
          for (var i = 0; i < length; i++) {
            var error = spec.items ? check(spec.items, value[i]) : null;
            if (error) {
              return "Error at index " + i + ": " + error;
            }
          }
          return null;
        case "ref":
          return specs[spec.$ref] ? check(specs[spec.$ref], value) : null;
        case "choices":
          for (var c = 0; c < spec.choices.length; c++) {
            if (!check(spec.choices[c], value)) {
              return null;
            }
          }
          return "Value did not match any choice.";
        default:
          return null;
      }
    }

    // ResolveArguments: whether the arguments can stand, in order, for the
    // parameters, an optional one perhaps left out; `out` gets the argument
    // each parameter has.
    function resolve(provided, expected, out) {
      if (!provided.length && !expected.length) {
        return true;
      }
      if (provided.length > expected.length) {
        return false;
      }
      if (provided.length) {
        var value = provided[0];
        var canMatch = false;
        if (expected[0].optional && value == null) {
          canMatch = true;
          out[out.length - expected.length] = undefined;
        } else if (isCorrectType(expected[0], value)) {
          canMatch = true;
          out[out.length - expected.length] = { value: value };
        }
        if (canMatch && resolve(provided.slice(1), expected.slice(1), out)) {
          return true;
        }
      }
      if (expected[0].optional) {
        out[out.length - expected.length] = undefined;
        if (resolve(provided, expected.slice(1), out)) {
          return true;
        }
      }
      return false;
    }

    // Whether the arguments fit the method, and if so "callback" when the
    // last of them is taken as its callback.
    function resolveProvided(fn, provided, out) {
      var expected = fn.parameters || [];
      var async = fn.returns_async;
      if (!async) {
        return resolve(provided, expected, out);
      }
      var optional = async.does_not_support_promises ? !!async.optional : true;
      var last = provided[provided.length - 1];
      if (!optional) {
        return provided.length > 0 && typeof last === "function" &&
          resolve(provided.slice(0, -1), expected, out) && "callback";
      }
      if (provided.length && (typeof last === "function" || last == null) &&
          resolve(provided.slice(0, -1), expected, out)) {
        return "callback";
      }
      return resolve(provided, expected, out);
    }

    function signature(fn) {
      var pieces = (fn.parameters || []).map(function (spec) {
        return (spec.optional ? "optional " : "") + typeName(spec) + " " + spec.name;
      });
      if (fn.returns_async) {
        var optional = fn.returns_async.does_not_support_promises ? !!fn.returns_async.optional : true;
        pieces.push((optional ? "optional " : "") + "function callback");
      }
      return pieces.join(", ");
    }

    // The call as Chrome's bindings hand it on: the error Chrome throws for
    // it, or null when it fits, and its arguments one to each parameter, a
    // parameter left out as undefined, followed by the callback when the
    // method takes one.
    function matchCall(name, fn, args) {
      var provided = Array.prototype.slice.call(args);
      var expected = fn.parameters || [];
      var resolved = new Array(expected.length);
      var error = null;
      var fit = resolveProvided(fn, provided, resolved);
      if (!fit) {
        error = "No matching signature.";
      } else {
        for (var i = 0; i < expected.length && !error; i++) {
          var detail = resolved[i] ? check(expected[i], resolved[i].value) : null;
          if (detail) {
            error = "Error at parameter '" + expected[i].name + "': " + detail;
          }
        }
      }
      if (error) {
        return { error: "Error in invocation of " + name + "(" + signature(fn) + "): " + error };
      }
      var normalized = resolved.map(function (r) {
        return r ? r.value : undefined;
      });
      if (fn.returns_async) {
        var last = provided[provided.length - 1];
        normalized.push(fit === "callback" && typeof last === "function" ? last : undefined);
      }
      return { error: null, args: normalized };
    }

    function callError(name, fn, args) {
      return matchCall(name, fn, args).error;
    }

    // The methods the schemas describe, by where they are found from
    // chrome ("storage.local.get"), with the name Chrome gives each in its
    // errors ("storage.StorageArea.get").
    var methods = {};
    Object.keys(api).forEach(function (ns) {
      (api[ns].functions || []).forEach(function (fn) {
        methods[ns + "." + fn.name] = { name: ns + "." + fn.name, fn: fn };
      });
      Object.keys(api[ns].properties || {}).forEach(function (path) {
        var type = specs[api[ns].properties[path]];
        (type && type.functions || []).forEach(function (fn) {
          methods[ns + "." + path + "." + fn.name] = { name: type.id + "." + fn.name, fn: fn };
        });
      });
    });

    // The method at `path`, checking its calls. The marks on it are
    // configurable, so that a proxy around it may answer for them as it
    // likes.
    function wrap(path, original) {
      var method = methods[path];
      if (!method || typeof original !== "function" || original.__wexChecked) {
        return original;
      }
      var checked = function () {
        var call = matchCall(method.name, method.fn, arguments);
        if (call.error) {
          throw new TypeError(call.error);
        }
        return original.apply(this, call.args);
      };
      try {
        Object.defineProperty(checked, "__wexChecked", { value: true, configurable: true });
        Object.defineProperty(checked, "__wexOriginal", { value: original, configurable: true });
      } catch (e) { /* unmarked */ }
      return checked;
    }

    function member(root, path) {
      var value = root;
      path.split(".").forEach(function (part) {
        value = value != null ? value[part] : undefined;
      });
      return value;
    }

    // Puts the checks on the members of `root`, a context's chrome made of
    // plain objects. Extension pages, whose namespace stands in for the
    // global page's, check through `wrap` as they hand out each member.
    function install(root) {
      Object.keys(methods).forEach(function (path) {
        var dot = path.lastIndexOf(".");
        var holder = member(root, path.slice(0, dot));
        var key = path.slice(dot + 1);
        if (holder && (typeof holder === "object" || typeof holder === "function")) {
          var checked = wrap(path, holder[key]);
          if (checked !== holder[key]) {
            try {
              holder[key] = checked;
            } catch (e) { /* the member stays as it is */ }
          }
        }
      });
    }

    return { install: install, callError: callError, wrap: wrap };
  }

  // The checks for this context, when the converter wrote its schemas.
  var contextChecker;

  // The schemas: WEX_API, or, in content scripts, WEX_API_JSON, its text,
  // which a frame that never makes its chrome passes over unread.
  var apiSchemasRead;
  function apiSchemas() {
    if (apiSchemasRead === undefined) {
      apiSchemasRead = g.WEX_API !== undefined ? g.WEX_API :
        typeof g.WEX_API_JSON === "string" ? JSON.parse(g.WEX_API_JSON) : null;
    }
    return apiSchemasRead;
  }

  function apiChecker() {
    if (contextChecker === undefined) {
      var api = apiSchemas();
      contextChecker = api && typeof api === "object" && !CONFIG.firefoxBuild ? makeApiChecker(api) : null;
    }
    return contextChecker;
  }

  function installApiChecks(root) {
    if (apiChecker()) {
      apiChecker().install(root);
    }
  }

  // Each enum of a namespace's own types, and each of its constants, as the
  // browser's bindings give them. An enum entry is named by its value:
  // chrome.offscreen.Reason.AUDIO_PLAYBACK is "AUDIO_PLAYBACK", and
  // chrome.runtime.OnInstalledReason.CHROME_UPDATE is "chrome_update". Firefox
  // only upper-cases the value for the name; Chrome also turns what is not a
  // letter, a digit or an underscore into one, and puts one before a digit.
  function enumEntryName(value) {
    if (CONFIG.firefoxBuild) {
      return String(value).toUpperCase();
    }
    var name = String(value).toUpperCase().replace(/[^A-Z0-9_]/g, "_");
    return /^[0-9]/.test(name) ? "_" + name : name;
  }

  function addSchemaEnums(root) {
    var api = apiSchemas();
    if (!api || typeof api !== "object") {
      return;
    }
    Object.keys(api).forEach(function (ns) {
      var target = root;
      ns.split(".").forEach(function (part) {
        target = target != null ? target[part] : undefined;
      });
      if (!target || typeof target !== "object") {
        return;
      }
      (api[ns].types || []).forEach(function (type) {
        var name = type.id.slice(ns.length + 1);
        if (!type.enum || type.id.indexOf(ns + ".") !== 0 || name.indexOf(".") >= 0 ||
            target[name] !== undefined) {
          return;
        }
        var values = {};
        type.enum.forEach(function (value) {
          values[enumEntryName(value)] = value;
        });
        try {
          target[name] = values;
        } catch (e) { /* the namespace keeps what it has */ }
      });
      // The namespace's constants, as the schema gives them.
      var constants = api[ns].constants || {};
      Object.keys(constants).forEach(function (name) {
        if (target[name] === undefined) {
          try {
            target[name] = constants[name];
          } catch (e) { /* the namespace keeps what it has */ }
        }
      });
    });
  }

  // ------------------------------------------------------------------ //
  // The test API
  // ------------------------------------------------------------------ //
  // chrome.test and browser.test, which a browser gives extensions only when
  // it runs their test suites, and which a build made with CONFIG.testApi has.
  // It follows Chromium's: with CONFIG.testApi "standard", a test passes when
  // it returns, or when the promise it returns resolves, as the W3C test
  // proposal has it; with "chrome", when it calls succeed() or its last
  // callbackPass() callback runs. Every context reports what it runs to the
  // global page, which keeps the record in WEX.testLog.
  var TEST_FAILURE = "chrome.test.failure";

  function sameValue(a, b) {
    if (a === b) {
      return a !== 0 || 1 / a === 1 / b;
    }
    return a !== a && b !== b;
  }

  function isPlainObject(obj) {
    if (typeof obj !== "object" || obj === null) {
      return false;
    }
    var proto = Object.getPrototypeOf(obj);
    return proto === null || proto === Object.prototype;
  }

  function checkEqStandard(expected, actual) {
    var i;
    if (Array.isArray(expected)) {
      if (!Array.isArray(actual) || expected.length !== actual.length) {
        return false;
      }
      for (i = 0; i < expected.length; i++) {
        if (!checkEqStandard(expected[i], actual[i])) {
          return false;
        }
      }
      return true;
    }
    if (isPlainObject(expected)) {
      if (!isPlainObject(actual)) {
        return false;
      }
      var keys = Object.keys(expected);
      if (!checkEqStandard(keys, Object.keys(actual))) {
        return false;
      }
      return keys.every(function (key) {
        return checkEqStandard(expected[key], actual[key]);
      });
    }
    return sameValue(expected, actual);
  }

  function collectionItems(collection, isMap) {
    var items = [];
    collection.forEach(function (value, key) {
      items.push(isMap ? [key, value] : value);
    });
    return items;
  }

  function checkCollectionEq(expected, actual, isMap) {
    if (expected.size !== actual.size) {
      return false;
    }
    var actualItems = collectionItems(actual, isMap);
    var matched = [];
    return collectionItems(expected, isMap).every(function (item) {
      for (var i = 0; i < actualItems.length; i++) {
        if (matched.indexOf(i) < 0 && (isMap ?
            checkEqChrome(item[0], actualItems[i][0]) && checkEqChrome(item[1], actualItems[i][1]) :
            checkEqChrome(item, actualItems[i]))) {
          matched.push(i);
          return true;
        }
      }
      return false;
    });
  }

  function checkEqChrome(expected, actual) {
    var p;
    if ((expected === null) !== (actual === null)) {
      return false;
    }
    if (expected === actual) {
      return true;
    }
    if (typeof expected === "number" && typeof actual === "number" && expected !== expected &&
        actual !== actual) {
      return true;
    }
    if (typeof expected !== typeof actual) {
      return false;
    }
    if (typeof expected === "function") {
      return expected.toString() === actual.toString();
    }
    if (typeof expected !== "object") {
      return false;
    }
    if (Array.isArray(expected) !== Array.isArray(actual) ||
        (Array.isArray(expected) && expected.length !== actual.length)) {
      return false;
    }
    if ((actual instanceof ArrayBuffer) !== (expected instanceof ArrayBuffer)) {
      return false;
    }
    if (actual instanceof ArrayBuffer) {
      return checkEqChrome(Array.prototype.slice.call(new Uint8Array(expected)),
        Array.prototype.slice.call(new Uint8Array(actual)));
    }
    if (expected instanceof Date) {
      return actual instanceof Date && sameValue(expected.getTime(), actual.getTime());
    }
    if (expected instanceof String || expected instanceof Number || expected instanceof Boolean) {
      return Object.getPrototypeOf(expected) === Object.getPrototypeOf(actual) &&
        sameValue(expected.valueOf(), actual.valueOf());
    }
    if (typeof Map === "function" && expected instanceof Map) {
      return actual instanceof Map && checkCollectionEq(expected, actual, true);
    }
    if (typeof Set === "function" && expected instanceof Set) {
      return actual instanceof Set && checkCollectionEq(expected, actual, false);
    }
    for (p in actual) {
      if (hasOwn(actual, p) && !hasOwn(expected, p)) {
        return false;
      }
    }
    for (p in expected) {
      if (hasOwn(expected, p) && !hasOwn(actual, p)) {
        return false;
      }
    }
    for (p in expected) {
      if (!checkEqChrome(expected[p], actual[p])) {
        return false;
      }
    }
    return true;
  }

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function errorText(e) {
    return e && typeof e === "object" && "message" in e ? String(e.message) : String(e);
  }

  // `report(entry)` hands an entry to the global page's record and returns a
  // promise of the harness's reply, for the entries that wait for one.
  // `lastError()` reads the context's runtime.lastError.
  function makeTestApi(report, lastError) {
    var standard = CONFIG.testApi === "standard";
    var checkEq = standard ? checkEqStandard : checkEqChrome;
    var test = {};
    var tests = [];
    var currentTest = null;
    var testsFailed = 0;
    var testCount = 1;
    var pendingCallbacks = 0;
    var pendingPromiseRejections = 0;
    var runTestsResolve = null;
    var runTestsReject = null;
    var exceptionHandler = null;
    var originalFail = null;

    function testName(fn) {
      return (fn && (fn.name || fn.generatedName)) || "(no test)";
    }

    function send(entry) {
      try {
        return Promise.resolve(report(entry));
      } catch (e) {
        return Promise.reject(e);
      }
    }

    function handleException(message, error) {
      if (error === TEST_FAILURE) {
        return;
      }
      if (exceptionHandler) {
        try {
          exceptionHandler(message || "Unknown error", error);
        } catch (e) { /* the handler's own failure is already reported */ }
        return;
      }
      try {
        failInternal("Exception running " + testName(currentTest) + ": " + (message || "Unknown error"));
      } catch (e) { /* reported */ }
    }

    function testDone() {
      setTimeout(runNextTest, 0);
    }

    function finished(result, description, message) {
      var data = {
        testName: testName(currentTest),
        result: result,
        remainingTests: tests.length,
        assertionDescription: description
      };
      if (message !== undefined) {
        data.message = message;
      }
      test.onTestFinished.emit(data);
      send({ kind: "testFinished", testName: data.testName, result: result,
             remainingTests: data.remainingTests, assertionDescription: description,
             message: message || "" });
    }

    function failInternal(message) {
      if (originalFail && (test.fail.__wexOriginal || test.fail) !== originalFail) {
        test.fail(message);
        return;
      }
      testsFailed++;
      test.log("(  FAILED  ) " + testName(currentTest));
      var description = String(message || "Assertion FAIL");
      var stack = String(new Error().stack || "");
      finished(false, description, description + " \n " + stack);
      testDone();
      throw TEST_FAILURE;
    }

    function succeedInternal() {
      test.assertEq(0, pendingPromiseRejections, "Test had pending promise rejections. This is " +
        "likely the result of not waiting for the promise returned by `assertPromiseRejects()` " +
        "to resolve. Instead, use `await assertPromiseRejects(...)` or " +
        "`assertPromiseRejects(...).then(...).`.");
      test.log("(  SUCCESS )");
      finished(true, testName(currentTest) + " PASS");
      testDone();
    }

    function safeApply(fn, args) {
      try {
        if (fn) {
          return fn.apply(undefined, args);
        }
      } catch (e) {
        if (e === TEST_FAILURE) {
          throw e;
        }
        handleException(errorText(e), e);
      }
      return undefined;
    }

    function handleImplicitResult(result) {
      if (result && typeof result.then === "function") {
        result.then(function () {
          succeedInternal();
        }).then(null, function (e) {
          handleException(errorText(e), e);
        });
        return;
      }
      if (result !== undefined) {
        failInternal("Test functions with implicit passing enabled must return undefined or a Promise.");
        return;
      }
      if (pendingCallbacks > 0) {
        failInternal("Test returned undefined but has pending callbacks. Did you forget to return a Promise?");
        return;
      }
      succeedInternal();
    }

    function runNextTest() {
      pendingCallbacks = 0;
      pendingPromiseRejections = 0;
      currentTest = tests.shift();
      if (!currentTest) {
        allTestsDone();
        return;
      }
      try {
        test.log("( RUN      ) " + testName(currentTest));
        test.onTestStarted.emit({ testName: testName(currentTest) });
        send({ kind: "testStarted", testName: testName(currentTest) });
        var result = currentTest.call(undefined);
        if (standard) {
          handleImplicitResult(result);
        } else if (result && typeof result.then === "function") {
          result.then(null, function (e) {
            handleException(errorText(e), e);
          });
        }
      } catch (e) {
        handleException(errorText(e), e);
      }
    }

    function allTestsDone() {
      var resolve = runTestsResolve;
      var reject = runTestsReject;
      var message = testsFailed > 0 ? "Failed " + testsFailed + " of " + testCount + " tests" : null;
      currentTest = null;
      testsFailed = 0;
      testCount = 1;
      pendingCallbacks = 0;
      pendingPromiseRejections = 0;
      runTestsResolve = null;
      runTestsReject = null;
      tests = [];
      if (!message) {
        test.notifyPass();
        if (resolve) {
          resolve();
        }
      } else {
        test.notifyFail(message);
        if (reject) {
          reject(new Error(message));
        }
      }
    }

    function assertBool(value, expected, message) {
      if (typeof value !== "boolean") {
        failInternal("API Test Error in " + testName(currentTest) + ": " +
          "assertTrue and assertFalse require a boolean condition.");
      }
      if (value !== expected) {
        failInternal(message);
      }
    }

    function checkThrownError(e, expectedError, customMessage) {
      if (e === TEST_FAILURE || expectedError === undefined || expectedError === null) {
        return;
      }
      var actual = errorText(e);
      if (expectedError instanceof RegExp) {
        var failMessage = actual + " should match " + expectedError;
        test.assertTrue(expectedError.test(actual),
          customMessage ? customMessage + "\n" + failMessage : failMessage);
        return;
      }
      if (actual !== expectedError) {
        var base = "Expected error: \"" + expectedError + "\", actual: \"" + actual + "\"";
        failInternal(customMessage ? customMessage + "\n" + base : base);
      }
    }

    function json(value) {
      try {
        return JSON.stringify(value);
      } catch (e) {
        return undefined;
      }
    }

    test.onTestStarted = new Event("test.onTestStarted");
    test.onTestFinished = new Event("test.onTestFinished");
    test.onMessage = new Event("test.onMessage");

    test.getConfig = function (cb) {
      return done(cb, JSON.parse(JSON.stringify(CONFIG.testConfig || {})));
    };
    test.log = function (message) {
      send({ kind: "log", message: String(message) });
    };
    test.notifyPass = function (message) {
      send({ kind: "pass", message: message === undefined ? "" : String(message) });
    };
    test.notifyFail = function (message) {
      send({ kind: "fail", message: String(message) });
    };
    test.sendMessage = function (message, cb) {
      var reply = send({ kind: "message", message: String(message), wantsReply: typeof cb === "function" });
      if (typeof cb === "function") {
        reply.then(function (value) {
          cb(value);
        });
        return undefined;
      }
      return reply;
    };
    test.sendScriptResult = function (result) {
      return send({ kind: "scriptResult", result: json(result) === undefined ? null : JSON.parse(json(result)) });
    };
    test.waitForRoundTrip = function (message, cb) {
      return done(cb, message);
    };
    test.fail = function (message) {
      if (standard) {
        var text = "chrome.test.fail() is not allowed when implicit test results are enabled. " +
          "Use assertions, throw exceptions, or return a promise that rejects instead.";
        failInternal(message ? text + " Original failure message: " + message : text);
      } else {
        failInternal(message);
      }
    };
    test.succeed = function () {
      if (standard) {
        failInternal("chrome.test.succeed() is not allowed when implicit test results are enabled. " +
          "Either return a promise that resolves or return undefined to indicate test passing.");
      } else {
        succeedInternal();
      }
    };
    test.runTests = function (list) {
      if (runTestsResolve !== null) {
        throw new Error("chrome.test.runTests is already running.");
      }
      tests = Array.prototype.slice.call(list || []);
      testCount = tests.length;
      return new Promise(function (resolve, reject) {
        runTestsResolve = resolve;
        runTestsReject = reject;
        runNextTest();
      });
    };
    test.assertTrue = function (value, message) {
      assertBool(value, true, message);
    };
    test.assertFalse = function (value, message) {
      assertBool(value, false, message);
    };
    test.checkDeepEq = function (value, other) {
      return checkEq(value, other);
    };
    test.assertEq = function (value, other, message) {
      if (test.checkDeepEq(value, other)) {
        return;
      }
      var text = "API Test Error in " + testName(currentTest) + (message ? ": " + message : "");
      if (typeof value === "object" || typeof other === "object") {
        text += "\n" + (json(value) || "" + value) + " did not deep-equal " + (json(other) || "" + other);
      } else {
        text += "\n" + value + " did not deep-equal " + other;
        if (typeof value !== typeof other) {
          text += " (type mismatch)\nType: " + typeof value + "\nOther Type:" + typeof other;
        }
      }
      failInternal(text);
    };
    test.assertNe = function (value, other, message) {
      if (!test.checkDeepEq(value, other)) {
        return;
      }
      failInternal("API Test Error in " + testName(currentTest) + (message ? ": " + message : "") +
        "\nExpected unequal values, but both are " + json(value));
    };
    test.assertNoLastError = function () {
      var error = lastError();
      if (error != undefined) {
        failInternal("lastError.message == " + error.message);
      }
    };
    test.assertLastError = function (expectedError) {
      test.assertEq(typeof expectedError, "string");
      var error = lastError();
      test.assertTrue(error != undefined, "No lastError, but expected " + expectedError);
      test.assertEq(expectedError, error.message);
    };
    test.assertThrows = function (fn, expectedError, message) {
      test.assertTrue(typeof fn === "function");
      var thrown;
      var threw = false;
      try {
        fn();
      } catch (e) {
        thrown = e;
        threw = true;
      }
      if (!threw) {
        var text = "Did not throw error: " + fn;
        failInternal(message ? message + "\n" + text : text);
        return;
      }
      checkThrownError(thrown, expectedError, message);
    };
    test.assertPromiseRejects = function (promise, expectedMessage) {
      pendingPromiseRejections++;
      return promise.then(function () {
        pendingPromiseRejections--;
        failInternal("Promise did not reject. Expected error: " + expectedMessage);
      }, function (e) {
        pendingPromiseRejections--;
        if (expectedMessage instanceof RegExp) {
          test.assertTrue(expectedMessage.test(e.toString()),
            "'" + (e && e.message) + "' should match '" + expectedMessage + "'");
        } else {
          test.assertEq("string", typeof expectedMessage);
          test.assertEq(expectedMessage, e.toString());
        }
      });
    };
    test.callbackAdded = function () {
      pendingCallbacks++;
      var called = false;
      return function () {
        if (called) {
          failInternal("Callback has already been run.");
          return;
        }
        called = true;
        pendingCallbacks--;
        if (pendingCallbacks === 0) {
          succeedInternal();
        }
      };
    };
    test.callback = function (fn, expectedError) {
      if (fn) {
        test.assertEq(typeof fn, "function");
      }
      var completed = test.callbackAdded();
      return function () {
        if (expectedError == null) {
          test.assertNoLastError();
        } else {
          test.assertLastError(expectedError);
        }
        var result;
        if (fn) {
          result = safeApply(fn, arguments);
        }
        completed();
        return result;
      };
    };
    test.callbackPass = function (fn) {
      return test.callback(fn);
    };
    test.callbackFail = function (expectedError, fn) {
      return test.callback(fn, expectedError);
    };
    test.listenOnce = function (event, fn) {
      if (fn) {
        var completed = test.callbackAdded();
        var once = function () {
          event.removeListener(once);
          safeApply(fn, arguments);
          completed();
        };
        event.addListener(once);
        return undefined;
      }
      return new Promise(function (resolve) {
        var listener = function () {
          event.removeListener(listener);
          resolve(arguments.length === 1 ? arguments[0] : Array.prototype.slice.call(arguments));
        };
        event.addListener(listener);
      });
    };
    test.listenForever = function (event, fn) {
      var completed = test.callbackAdded();
      var listener = function () {
        safeApply(fn, arguments);
      };
      event.addListener(listener);
      return function () {
        event.removeListener(listener);
        completed();
      };
    };
    test.loadScript = function (url) {
      if (typeof g.importScripts === "function" && !g.document) {
        try {
          g.importScripts(url);
        } catch (e) {
          return Promise.reject(new Error("Unable to load script: \"" + url + "\""));
        }
        return Promise.resolve();
      }
      return new Promise(function (resolve, reject) {
        var script = g.document.createElement("script");
        script.onload = resolve;
        script.onerror = function () {
          reject(new Error("Unable to load script: \"" + url + "\""));
        };
        script.src = url;
        (g.document.body || g.document.documentElement).appendChild(script);
      });
    };
    test.isProcessingUserGesture = function () {
      return false;
    };
    test.runWithUserGesture = function (cb) {
      test.assertEq(typeof cb, "function");
      return cb();
    };
    test.setExceptionHandler = function (cb) {
      test.assertEq(typeof cb, "function");
      exceptionHandler = cb;
    };
    originalFail = test.fail;

    // An exception the test's code does not catch in an API callback or an
    // event listener fails the test that is running, as Chrome's bindings
    // report it to the test; one elsewhere does not.
    WEX.testException = function (e) {
      if (currentTest) {
        handleException(errorText(e), e);
      }
    };

    return test;
  }

  // ------------------------------------------------------------------ //
  // Reaching the global page from another process
  // ------------------------------------------------------------------ //
  // Content scripts and extension pages in tabs run in web content processes,
  // away from the global page and everything it builds on `safari.*`. Their
  // calls to that part of the API travel as runtime messages naming the
  // method, and its events come back over a port.
  function makeRemote(native) {
    var port = null;
    var subscriptions = {};

    function call(path, args) {
      return native.runtime.sendMessage({ __wex: "rpc", path: path, args: args || [] })
        .then(function (reply) {
          if (!reply) {
            throw new Error("the extension's background page did not answer");
          }
          if (reply.error) {
            throw new Error(reply.error);
          }
          return reply.value;
        });
    }

    function subscribed() {
      return Object.keys(subscriptions).filter(function (path) {
        return subscriptions[path].length > 0;
      });
    }

    function open() {
      if (port) {
        return port;
      }
      port = native.runtime.connect({ name: INTERNAL_PORT + "events" });
      // A new port's far end knows nothing of what earlier ports listened to.
      var opened = port;
      subscribed().forEach(function (path) {
        opened.postMessage({ subscribe: path });
      });
      port.onMessage.addListener(function (m) {
        (subscriptions[m.event] || []).slice().forEach(function (fn) {
          try {
            fn.apply(null, m.args || []);
          } catch (e) {
            log.error("listener for " + m.event + " threw", e);
          }
        });
      });
      // The far end goes away when the global page reloads.
      port.onDisconnect.addListener(function () {
        port = null;
        setTimeout(function () {
          if (!port && subscribed().length) {
            open();
          }
        }, 2000);
      });
      return port;
    }

    function event(path) {
      var list = subscriptions[path] || (subscriptions[path] = []);
      return {
        addListener: function (fn) {
          if (typeof fn !== "function" || list.indexOf(fn) >= 0) {
            return;
          }
          list.push(fn);
          if (list.length === 1) {
            // A port this opens has subscribed to the path already.
            if (port) {
              port.postMessage({ subscribe: path });
            } else {
              open();
            }
          }
        },
        removeListener: function (fn) {
          var i = list.indexOf(fn);
          if (i < 0) {
            return;
          }
          list.splice(i, 1);
          if (!list.length && port) {
            port.postMessage({ unsubscribe: path });
          }
        },
        hasListener: function (fn) {
          return list.indexOf(fn) >= 0;
        },
        hasListeners: function () {
          return list.length > 0;
        }
      };
    }

    return { call: call, event: event };
  }

  // ------------------------------------------------------------------ //
  // webRequest
  // ------------------------------------------------------------------ //
  var WEB_REQUEST_EVENTS = [
    "onBeforeRequest", "onBeforeSendHeaders", "onSendHeaders", "onHeadersReceived",
    "onAuthRequired", "onResponseStarted", "onBeforeRedirect", "onCompleted",
    "onErrorOccurred"
  ];

  // The engine's webRequest, with the fields Firefox names differently filled
  // in. The same function may be registered more than once with different
  // filters, and each registration counts separately.
  // Chrome shows an extension the requests for its own files, as the engine
  // does. The runtime's files, which the extension has no part of in Chrome,
  // are left out.
  function runtimeRequest(url) {
    var full = String(url || "");
    if (full.toLowerCase().indexOf(baseURI.toLowerCase()) !== 0) {
      return false;
    }
    var path = full.slice(baseURI.length).split(/[?#]/)[0];
    return /^wex\//.test(path) || /(^|\/)wex-global-page\.html$/.test(path);
  }

  // Firefox shows an extension no request for its own files, which its
  // `<all_urls>` does not match, so its listeners do not hold the loads of
  // its own background scripts (which may hold every request until the
  // background has started, when the background loads after them).
  function hiddenRequest(url) {
    return runtimeRequest(url) || (!!CONFIG.firefoxBuild &&
      String(url || "").toLowerCase().indexOf(baseURI.toLowerCase()) === 0);
  }

  function makeWebRequest(native) {
    var source = native.webRequest;
    var out = {
      MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES:
        source.MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES || 20,
      // Chrome's option enums. Extensions read them to learn which options a
      // browser takes; the engine accepts each of them.
      OnBeforeRequestOptions: { BLOCKING: "blocking", REQUEST_BODY: "requestBody", EXTRA_HEADERS: "extraHeaders" },
      OnBeforeSendHeadersOptions: { BLOCKING: "blocking", REQUEST_HEADERS: "requestHeaders", EXTRA_HEADERS: "extraHeaders" },
      OnSendHeadersOptions: { REQUEST_HEADERS: "requestHeaders", EXTRA_HEADERS: "extraHeaders" },
      OnHeadersReceivedOptions: { BLOCKING: "blocking", RESPONSE_HEADERS: "responseHeaders", EXTRA_HEADERS: "extraHeaders" },
      OnAuthRequiredOptions: { BLOCKING: "blocking", RESPONSE_HEADERS: "responseHeaders", ASYNC_BLOCKING: "asyncBlocking", EXTRA_HEADERS: "extraHeaders" },
      OnResponseStartedOptions: { RESPONSE_HEADERS: "responseHeaders", EXTRA_HEADERS: "extraHeaders" },
      OnBeforeRedirectOptions: { RESPONSE_HEADERS: "responseHeaders", EXTRA_HEADERS: "extraHeaders" },
      OnCompletedOptions: { RESPONSE_HEADERS: "responseHeaders", EXTRA_HEADERS: "extraHeaders" },
      OnErrorOccurredOptions: { EXTRA_HEADERS: "extraHeaders" },
      IgnoredActionType: { REDIRECT: "redirect", REQUEST_HEADERS: "request_headers",
                           RESPONSE_HEADERS: "response_headers", AUTH_CREDENTIALS: "auth_credentials" },
      ResourceType: source.ResourceType || {},
      handlerBehaviorChanged: function (cb) {
        return settle(source.handlerBehaviorChanged(), cb);
      }
    };
    // The engine merges every extension's verdicts as Chrome does, and tells
    // none whose were set aside.
    if (!CONFIG.firefoxBuild) {
      out.onActionIgnored = new Event("webRequest.onActionIgnored");
    }
    // Firefox's response filters are the engine's.
    if (CONFIG.firefoxBuild && typeof source.filterResponseData === "function") {
      out.filterResponseData = function (requestId) {
        return source.filterResponseData(requestId);
      };
    }
    WEB_REQUEST_EVENTS.forEach(function (name) {
      out[name] = adaptEvent(source[name], function (fn) {
        return function (details) {
          if (details && hiddenRequest(details.url)) {
            return undefined;
          }
          if (details && details.originUrl === undefined) {
            // WebKit names the requesting origin `initiator` on requests
            // where it has no document URL. Firefox extensions use
            // `originUrl` to associate a third-party resource with the page
            // that loaded it, including blocking its scripts.
            details.originUrl = details.documentUrl || details.initiator;
          }
          if (details && details.tabId >= 0) {
            describeDocument(details, undefined,
              details.type === "main_frame" || details.type === "sub_frame");
          }
          return fn.apply(null, arguments);
        };
      }, { repeatable: true, passArguments: true });
    });
    return out;
  }

  // ------------------------------------------------------------------ //
  // declarativeNetRequest
  // ------------------------------------------------------------------ //
  // The engine's declarativeNetRequest, which applies the rules itself and
  // reads the static rulesets from Info.plist. Rule lists can be narrowed by
  // `ruleIds`, as Chrome's can; the members Chrome documents and the engine
  // leaves out are filled in.
  // Chrome's guaranteed static rules and the global pool beyond them.
  var STATIC_RULE_ALLOWANCE = 330000;

  var DNR_CONSTANTS = {
    MAX_NUMBER_OF_STATIC_RULESETS: 100,
    MAX_NUMBER_OF_ENABLED_STATIC_RULESETS: 50,
    MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES: 30000,
    MAX_NUMBER_OF_REGEX_RULES: 1000,
    GUARANTEED_MINIMUM_STATIC_RULES: 30000,
    DYNAMIC_RULESET_ID: "_dynamic",
    SESSION_RULESET_ID: "_session",
    // Chrome's enums, which extensions build their rules from.
    RuleActionType: {
      BLOCK: "block", REDIRECT: "redirect", ALLOW: "allow", UPGRADE_SCHEME: "upgradeScheme",
      MODIFY_HEADERS: "modifyHeaders", ALLOW_ALL_REQUESTS: "allowAllRequests"
    },
    ResourceType: {
      MAIN_FRAME: "main_frame", SUB_FRAME: "sub_frame", STYLESHEET: "stylesheet",
      SCRIPT: "script", IMAGE: "image", FONT: "font", OBJECT: "object",
      XMLHTTPREQUEST: "xmlhttprequest", PING: "ping", CSP_REPORT: "csp_report",
      MEDIA: "media", WEBSOCKET: "websocket", WEBTRANSPORT: "webtransport",
      WEBBUNDLE: "webbundle", OTHER: "other"
    },
    RequestMethod: {
      CONNECT: "connect", DELETE: "delete", GET: "get", HEAD: "head", OPTIONS: "options",
      PATCH: "patch", POST: "post", PUT: "put", OTHER: "other"
    },
    DomainType: { FIRST_PARTY: "firstParty", THIRD_PARTY: "thirdParty" },
    HeaderOperation: { APPEND: "append", SET: "set", REMOVE: "remove" },
    UnsupportedRegexReason: {
      SYNTAX_ERROR: "syntaxError", MEMORY_LIMIT_EXCEEDED: "memoryLimitExceeded"
    }
  };

  // The engine ignores `requestDomains` on a rule that has a `regexFilter`,
  // and applies the rule on every host. A regexFilter that matches any URL
  // says no more than which schemes the rule is for, so such a rule is handed
  // over with the equivalent `urlFilter`, which the engine does scope to the
  // domains. A redirect that substitutes from the regex has no urlFilter
  // form; it is left out rather than redirecting every page on the web.
  var ANY_URL_REGEX = /^\^?(?:(https\?|https|http|wss\?|wss|ws|\[\^:\]\+|\[a-z\]\+):(?:\\?\/){2})?\.[*+]\$?$/;
  var SCHEME_URL_FILTERS = {
    "https?": "|http", "https": "|https://", "http": "|http://",
    "wss?": "|ws", "wss": "|wss://", "ws": "|ws://"
  };

  // `originals` gets each scoped rule as the extension gave it, by its id.
  function scopeRegexRules(options, originals) {
    if (!options || !Array.isArray(options.addRules)) {
      return options;
    }
    var rules = [];
    options.addRules.forEach(function (rule) {
      var c = rule && rule.condition;
      var any = c && typeof c.regexFilter === "string" && Array.isArray(c.requestDomains) &&
        c.requestDomains.length ? ANY_URL_REGEX.exec(c.regexFilter) : null;
      if (!any) {
        rules.push(rule);
        return;
      }
      if (rule.action && rule.action.redirect && rule.action.redirect.regexSubstitution != null) {
        log.unsupported("declarativeNetRequest regexSubstitution redirects limited by requestDomains");
        return;
      }
      var scoped = JSON.parse(JSON.stringify(rule));
      originals[rule.id] = rule;
      delete scoped.condition.regexFilter;
      if (SCHEME_URL_FILTERS[any[1]]) {
        scoped.condition.urlFilter = SCHEME_URL_FILTERS[any[1]];
      }
      rules.push(scoped);
    });
    var out = {};
    Object.keys(options).forEach(function (key) {
      out[key] = options[key];
    });
    out.addRules = rules;
    return out;
  }

  // The engine takes a regexFilter in the content-blocker dialect: groups,
  // `?`, `*` and `+`, classes and anchors, but no alternation, no counted
  // repetition and no `\d`, `\w` or `\s`. Most of what it lacks can be said
  // in what it has, alternation as more than one pattern. The patterns that
  // together match what `source` matches, or null when there are none: for
  // `\b`, lookaround, a back-reference, or more alternatives than
  // MAX_REGEX_ALTERNATIVES. With `keepGroups`, for a pattern a substitution
  // refers into, each pattern numbers its capturing groups as `source` does,
  // so none is made of alternatives that hold a capturing group.
  var MAX_REGEX_ALTERNATIVES = 32;
  var MAX_REGEX_REPEAT = 16;
  var REGEX_SHORTHANDS = { d: "0-9", w: "A-Za-z0-9_", s: " \\t\\n\\r\\f\\v" };

  function adaptRegex(source, keepGroups) {
    var src = String(source);
    var i = 0;

    function unsupported() {
      throw adaptRegex;
    }
    // A class's contents, its shorthands spelt out.
    function classBody(negated) {
      var body = "";
      while (i < src.length && src[i] !== "]") {
        var c = src[i];
        if (c === "\\") {
          var e = src[i + 1];
          if (e === undefined) {
            unsupported();
          }
          if (REGEX_SHORTHANDS[e]) {
            body += REGEX_SHORTHANDS[e];
          } else if (REGEX_SHORTHANDS[e.toLowerCase()]) {
            unsupported();
          } else {
            body += c + e;
          }
          i += 2;
        } else {
          body += c;
          i++;
        }
      }
      if (src[i] !== "]") {
        unsupported();
      }
      i++;
      return { kind: "class", negated: negated, body: body };
    }
    function atom() {
      var c = src[i];
      if (c === "(") {
        var capturing = true;
        if (src[i + 1] === "?") {
          if (src[i + 2] !== ":") {
            unsupported();
          }
          capturing = false;
          i += 3;
        } else {
          i++;
        }
        var inner = alternation();
        if (src[i] !== ")") {
          unsupported();
        }
        i++;
        return { kind: "group", capturing: capturing, inner: inner };
      }
      if (c === "[") {
        i++;
        var negated = src[i] === "^";
        if (negated) {
          i++;
        }
        return classBody(negated);
      }
      if (c === "\\") {
        var e = src[i + 1];
        if (e === undefined || /[1-9bBkpPu]/.test(e) && !(e === "u" && /^[0-9A-Fa-f]{4}$/.test(src.substr(i + 2, 4)))) {
          unsupported();
        }
        if (REGEX_SHORTHANDS[e]) {
          i += 2;
          return { kind: "class", negated: false, body: REGEX_SHORTHANDS[e] };
        }
        if (REGEX_SHORTHANDS[e.toLowerCase()]) {
          i += 2;
          return { kind: "class", negated: true, body: REGEX_SHORTHANDS[e.toLowerCase()] };
        }
        var length = e === "u" ? 6 : e === "x" ? 4 : 2;
        var text = src.substr(i, length);
        i += length;
        return { kind: "char", text: text, char: /[A-Za-z0-9]/.test(e) ? null : e };
      }
      if (c === "{" && /^\{\d+(,\d*)?\}/.test(src.slice(i))) {
        unsupported();
      }
      i++;
      if (c === "^" || c === "$") {
        return { kind: "anchor", text: c };
      }
      return { kind: "char", text: c, char: c === "." ? null : c };
    }
    function quantified() {
      var a = atom();
      var q = null;
      var m;
      if (/[*+?]/.test(src[i] || "")) {
        q = { text: src[i] };
        i++;
      } else if ((m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i)))) {
        if (a.kind === "anchor") {
          unsupported();
        }
        q = { min: Number(m[1]), max: m[2] ? (m[3] === "" ? Infinity : Number(m[3])) : Number(m[1]) };
        i += m[0].length;
      }
      if (q && src[i] === "?") {
        q.lazy = true;
        i++;
      }
      return { atom: a, q: q };
    }
    function sequence() {
      var items = [];
      while (i < src.length && src[i] !== "|" && src[i] !== ")") {
        items.push(quantified());
      }
      return items;
    }
    function alternation() {
      var alternatives = [sequence()];
      while (src[i] === "|") {
        i++;
        alternatives.push(sequence());
      }
      return alternatives;
    }

    function limit(list) {
      if (list.length > MAX_REGEX_ALTERNATIVES) {
        unsupported();
      }
      return list;
    }
    function hasCapture(alternatives) {
      return alternatives.some(function (items) {
        return items.some(function (item) {
          return item.atom.kind === "group" &&
            (item.atom.capturing || hasCapture(item.atom.inner));
        });
      });
    }
    // A class that stands for a group whose every alternative is one
    // character, or null.
    function asClass(alternatives) {
      var body = "";
      for (var a = 0; a < alternatives.length; a++) {
        var items = alternatives[a];
        if (items.length !== 1 || items[0].q) {
          return null;
        }
        var x = items[0].atom;
        if (x.kind === "class" && !x.negated) {
          body += x.body;
        } else if (x.kind === "char" && x.char !== null) {
          body += /[\\\]\[^-]/.test(x.char) ? "\\" + x.char : x.char;
        } else if (x.kind === "char" && x.text[0] === "\\") {
          body += x.text;
        } else {
          return null;
        }
      }
      return body;
    }
    function render(alternatives) {
      if (keepGroups && alternatives.length > 1 && hasCapture(alternatives)) {
        unsupported();
      }
      var out = [];
      alternatives.forEach(function (items) {
        out = out.concat(renderSequence(items));
      });
      return limit(out);
    }
    function renderSequence(items) {
      var out = [""];
      items.forEach(function (item) {
        var forms = renderItem(item);
        var next = [];
        out.forEach(function (head) {
          forms.forEach(function (tail) {
            next.push(head + tail);
          });
        });
        out = limit(next);
      });
      return out;
    }
    function renderAtom(a) {
      if (a.kind === "class") {
        return ["[" + (a.negated ? "^" : "") + a.body + "]"];
      }
      if (a.kind === "group") {
        var open = a.capturing ? "(" : "(?:";
        var merged = a.inner.length > 1 ? asClass(a.inner) : null;
        if (merged !== null) {
          return [open + "[" + merged + "])"];
        }
        return render(a.inner).map(function (inner) {
          return open + inner + ")";
        });
      }
      return [a.text];
    }
    function renderItem(item) {
      var q = item.q;
      // A group that captures nothing and repeats nothing is its contents,
      // which the engine takes where it refuses an anchor inside a group.
      if (!q && item.atom.kind === "group" && !item.atom.capturing) {
        var merged = item.atom.inner.length > 1 ? asClass(item.atom.inner) : null;
        return merged !== null ? ["[" + merged + "]"] : render(item.atom.inner);
      }
      var forms = renderAtom(item.atom);
      if (!q) {
        return forms;
      }
      if (forms.length !== 1) {
        unsupported();
      }
      var one = forms[0];
      var lazy = q.lazy ? "?" : "";
      if (q.text) {
        return [one + q.text + lazy];
      }
      if (q.min > MAX_REGEX_REPEAT || q.max !== Infinity && q.max > MAX_REGEX_REPEAT ||
          q.max < q.min) {
        unsupported();
      }
      if (hasCapture(item.atom.kind === "group" ? item.atom.inner : []) ||
          item.atom.kind === "group" && item.atom.capturing) {
        unsupported();
      }
      var out = "";
      for (var n = 0; n < q.min; n++) {
        out += one;
      }
      if (q.max === Infinity) {
        return [out + one + "*" + lazy];
      }
      var optional = "";
      for (var k = q.min; k < q.max; k++) {
        optional = "(?:" + one + optional + ")?" + lazy;
      }
      return [out + optional];
    }

    try {
      var tree = alternation();
      if (i !== src.length) {
        return null;
      }
      return render(tree);
    } catch (e) {
      if (e === adaptRegex) {
        return null;
      }
      throw e;
    }
  }

  // A rule whose regexFilter the engine needed in another form is kept as the
  // extension gave it, with the ids of the engine's further rules for it when
  // it took more than one pattern. Those ids come from a range of their own,
  // and are known only here: the extension sees its own rules.
  var SPLIT_RULE_ID_BASE = 1900000000;

  // A record marked `local` is of a rule the engine holds no part of, whose
  // response headers the runtime alone applies.
  function splitStore(kind) {
    var key = "wex.dnr.split." + kind;
    return {
      load: function () {
        try {
          var stored = JSON.parse(localStorageOf(g).getItem(key) || "null");
          return stored && typeof stored === "object" ? stored : {};
        } catch (e) {
          return {};
        }
      },
      save: function (splits) {
        try {
          if (Object.keys(splits).length) {
            localStorageOf(g).setItem(key, JSON.stringify(splits));
          } else {
            localStorageOf(g).removeItem(key);
          }
        } catch (e) { /* the engine's rules stand without the record */ }
      }
    };
  }

  // The engine's session rules end with the session, and local storage
  // outlasts it, so the global page's start ends the session rules only the
  // runtime holds.
  function endLocalSessionRules() {
    var store = splitStore("session");
    var splits = store.load();
    var ended = Object.keys(splits).filter(function (id) {
      return splits[id].local;
    });
    ended.forEach(function (id) {
      delete splits[id];
    });
    if (ended.length) {
      store.save(splits);
    }
  }

  // Resource types the engine refuses in a rule's `resourceTypes`, as it
  // never loads such a resource: a rule is narrowed to the rest, and a rule
  // left with none, which could never match, is left out.
  var UNLOADED_RESOURCE_TYPES = ["object", "csp_report", "webtransport", "webbundle"];

  function loadableRules(rules) {
    var out = [];
    (rules || []).forEach(function (rule) {
      var types = rule && rule.condition && rule.condition.resourceTypes;
      if (!Array.isArray(types) || !types.some(function (t) {
        return UNLOADED_RESOURCE_TYPES.indexOf(t) >= 0;
      })) {
        out.push(rule);
        return;
      }
      var kept = types.filter(function (t) {
        return UNLOADED_RESOURCE_TYPES.indexOf(t) < 0;
      });
      if (!kept.length) {
        log.unsupported("declarativeNetRequest rules for " + types.join(", ") + " requests");
        return;
      }
      var copy = JSON.parse(JSON.stringify(rule));
      copy.condition.resourceTypes = kept;
      out.push(copy);
    });
    return out;
  }

  // Safari's content rule lists know nothing of tabs, and the engine takes a
  // rule's tabIds or excludedTabIds for no condition at all. The engine acts
  // on the requests of tabs alone, so a rule that excludes only the requests
  // of no tab (excludedTabIds [-1]) goes to it without the condition, and
  // any other with a tab condition is the runtime's to apply (requestRules),
  // where one for the requests of no tab alone (tabIds [-1]) matches nothing.
  function untabbed(list) {
    return (list || []).filter(function (id) {
      return id !== -1;
    });
  }

  function tabScoped(rule) {
    var c = rule && rule.condition;
    return !!c && (Array.isArray(c.tabIds) || untabbed(c.excludedTabIds).length > 0);
  }

  function hasTabCondition(rule) {
    var c = rule && rule.condition;
    return !!c && (c.tabIds != null || c.excludedTabIds != null);
  }

  // The engine's form of one update, and the record as it will be once the
  // engine has taken it.
  function splitRegexRules(options, splits) {
    var next = JSON.parse(JSON.stringify(splits));
    var remove = (options.removeRuleIds || []).slice();
    remove.slice().forEach(function (id) {
      if (Object.prototype.hasOwnProperty.call(next, id)) {
        if (next[id].local) {
          remove = remove.filter(function (other) {
            return other !== id;
          });
        }
        remove = remove.concat(next[id].ids);
        delete next[id];
      }
    });
    var used = {};
    Object.keys(next).forEach(function (id) {
      next[id].ids.forEach(function (extra) {
        used[extra] = true;
      });
    });
    var candidate = SPLIT_RULE_ID_BASE;
    function allocate() {
      while (used[candidate]) {
        candidate++;
      }
      used[candidate] = true;
      return candidate;
    }
    // A rule added under an id the engine has free is new, whatever the
    // record says of an earlier rule of that id, as of a session rule from
    // before the browser restarted.
    (options.addRules || []).forEach(function (rule) {
      if (rule && Object.prototype.hasOwnProperty.call(next, rule.id)) {
        delete next[rule.id];
      }
    });
    var add = [];
    loadableRules(options.addRules).forEach(function (rule) {
      var given = rule;
      // A redirect to one of the extension's own pages names it by its path,
      // as the engine takes it; the extension reads the rule back as it
      // wrote it.
      var path = ownRedirectPath(rule);
      if (path === null && HAS_RENAMED && rule && rule.action && rule.action.type === "redirect" &&
          rule.action.redirect && typeof rule.action.redirect.extensionPath === "string" &&
          servedPath(rule.action.redirect.extensionPath) !== rule.action.redirect.extensionPath) {
        path = rule.action.redirect.extensionPath;
      }
      if (tabScoped(rule)) {
        next[rule.id] = { rule: given, ids: [], local: true };
        return;
      }
      if (hasTabCondition(rule)) {
        var everyTab = JSON.parse(JSON.stringify(rule));
        delete everyTab.condition.excludedTabIds;
        next[rule.id] = { rule: given, ids: [] };
        rule = everyTab;
      }
      if (path !== null) {
        var own = JSON.parse(JSON.stringify(rule));
        delete own.action.redirect.url;
        own.action.redirect.extensionPath = servedPath(path);
        next[rule.id] = { rule: given, ids: [] };
        rule = own;
      }
      var c = rule && rule.condition;
      var forms = c && typeof c.regexFilter === "string" ? adaptRegex(c.regexFilter,
        !!(rule.action && rule.action.redirect && rule.action.redirect.regexSubstitution != null)) : null;
      if (!forms || forms.length === 1 && forms[0] === c.regexFilter) {
        add.push(rule);
        return;
      }
      var copies = forms.map(function (form, k) {
        var copy = JSON.parse(JSON.stringify(rule));
        copy.condition.regexFilter = form;
        if (k > 0) {
          copy.id = allocate();
        }
        return copy;
      });
      add = add.concat(copies);
      next[rule.id] = {
        rule: given,
        ids: copies.slice(1).map(function (copy) {
          return copy.id;
        })
      };
    });
    var out = {};
    Object.keys(options).forEach(function (key) {
      out[key] = options[key];
    });
    if (remove.length) {
      out.removeRuleIds = remove;
    } else {
      delete out.removeRuleIds;
    }
    out.addRules = add;
    return { options: out, splits: next };
  }

  // The path within the bundle that a redirect rule's `url` names, for one
  // to an address of the extension's own (Safari's, or its browser's as the
  // web sees it); null for any other rule.
  function ownRedirectPath(rule) {
    var url = rule && rule.action && rule.action.type === "redirect" && rule.action.redirect &&
      rule.action.redirect.url;
    if (typeof url !== "string") {
      return null;
    }
    var path = extPath(url);
    if (path === null && WEB_ORIGIN && url.toLowerCase().indexOf(WEB_ORIGIN.toLowerCase() + "/") === 0) {
      path = url.slice(WEB_ORIGIN.length + 1);
    }
    return path === null ? null : "/" + path;
  }

  // The engine's rules as the extension made them.
  function joinSplitRules(rules, splits) {
    var extra = {};
    Object.keys(splits).forEach(function (id) {
      splits[id].ids.forEach(function (n) {
        extra[n] = true;
      });
    });
    var joined = (rules || []).filter(function (rule) {
      return !extra[rule.id];
    }).map(function (rule) {
      return Object.prototype.hasOwnProperty.call(splits, rule.id) ? splits[rule.id].rule : rule;
    });
    Object.keys(splits).forEach(function (id) {
      if (splits[id].local) {
        joined.push(splits[id].rule);
      }
    });
    return joined;
  }

  // The extension's rule that an engine rule id stands for.
  function splitOwner(id, splits) {
    var owner = id;
    Object.keys(splits).forEach(function (key) {
      if (splits[key].ids.indexOf(id) >= 0) {
        owner = Number(key);
      }
    });
    return owner;
  }

  // ------------------------------------------------------------------ //
  // Response headers of declarativeNetRequest rules
  // ------------------------------------------------------------------ //
  // WebKit applies a modifyHeaders rule's request headers and leaves its
  // response headers be, so the global page applies those itself, from the
  // engine's blocking onHeadersReceived, as Chrome would: the rules whose
  // conditions match, the higher priority first, where a header that a set
  // or remove has decided takes no lower rule's change but an append after
  // an append. A static ruleset's such rules are the ones the converter
  // recorded (CONFIG.responseHeaderRules). Its listener asks only for the
  // hosts and resource types the rules name, where every rule names them,
  // so that other loads do not wait on it.
  function urlFilterRegExp(filter, caseSensitive) {
    var f = String(filter);
    var prefix = "";
    var suffix = "";
    if (f.indexOf("||") === 0) {
      prefix = "^[a-z][a-z0-9+.\\-]*:\\/\\/(?:[^\\/?#]*\\.)?";
      f = f.slice(2);
    } else if (f.charAt(0) === "|") {
      prefix = "^";
      f = f.slice(1);
    }
    if (f.length && f.charAt(f.length - 1) === "|") {
      suffix = "$";
      f = f.slice(0, -1);
    }
    var body = f.split("").map(function (ch) {
      if (ch === "*") {
        return ".*";
      }
      if (ch === "^") {
        return "(?:[^A-Za-z0-9_.%\\-]|$)";
      }
      return ch.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
    }).join("");
    return new RegExp(prefix + body + suffix, caseSensitive ? "" : "i");
  }

  function hostOf(url) {
    var m = /^[a-z][a-z0-9+.\-]*:\/\/(?:[^@\/?#]*@)?(\[[^\]]*\]|[^:\/?#]*)/i.exec(String(url || ""));
    return m ? m[1].toLowerCase() : "";
  }

  function inDomains(host, domains) {
    return (domains || []).some(function (d) {
      var domain = String(d).toLowerCase();
      return host === domain || host.slice(-domain.length - 1) === "." + domain;
    });
  }

  // The site of a host, its registrable domain, for a rule's domainType. The
  // list is read when the rules are prepared, and only if one of them has a
  // domainType, so that no request waits on the read. Without the list a
  // host is its own site.
  var siteSuffixes = null;
  var siteListRead = false;

  function readSiteList() {
    if (siteListRead) {
      return;
    }
    siteListRead = true;
    try {
      var rules = bundledSuffixRules(false);
      siteSuffixes = publicSuffixApi(function () {
        return rules;
      });
    } catch (e) { /* no list to read */ }
  }

  function siteOf(host) {
    if (!siteSuffixes) {
      return host;
    }
    try {
      return siteSuffixes.getDomain(host, { allowUnknownSuffix: true, allowIPAddress: true }) || host;
    } catch (e) {
      return host;
    }
  }

  // The host of the top frame of a request's page, or "" where the details
  // do not tell it, which no rule's topDomains then names.
  function topHost(d, host) {
    if (d.type === "main_frame") {
      return host;
    }
    var ancestors = d.frameAncestors;
    if (ancestors && ancestors.length) {
      return hostOf(ancestors[ancestors.length - 1].url);
    }
    return d.frameId === 0 ? hostOf(d.initiator || d.documentUrl) : "";
  }

  // A test of one pattern of a header condition's values: `*` is any number
  // of characters, `?` zero or one, each escaped by a backslash, and case
  // does not count.
  function headerValuePattern(pattern) {
    var text = String(pattern);
    var body = "";
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (ch === "\\" && (text.charAt(i + 1) === "*" || text.charAt(i + 1) === "?")) {
        i++;
        body += "\\" + text.charAt(i);
      } else if (ch === "*") {
        body += "[\\s\\S]*";
      } else if (ch === "?") {
        body += "[\\s\\S]?";
      } else {
        body += ch.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
      }
    }
    return new RegExp("^" + body + "$", "i");
  }

  // Whether any of a rule's header conditions holds of a response's headers:
  // a header of the name, of a value among `values` where it names some, none
  // of whose values is among `excludedValues`.
  function headerConditionTest(conditions) {
    var tests = conditions.map(function (info) {
      return {
        name: String(info.header || "").toLowerCase(),
        values: info.values ? info.values.map(headerValuePattern) : null,
        excluded: info.excludedValues ? info.excludedValues.map(headerValuePattern) : null
      };
    });
    function anyOf(patterns, value) {
      return patterns.some(function (pattern) {
        return pattern.test(value);
      });
    }
    return function (headers) {
      return tests.some(function (test) {
        var found = headers.filter(function (h) {
          return String(h.name).toLowerCase() === test.name;
        }).map(function (h) {
          return String(h.value);
        });
        if (!found.length) {
          return false;
        }
        if (test.excluded && found.some(function (value) {
          return anyOf(test.excluded, value);
        })) {
          return false;
        }
        return !test.values || found.some(function (value) {
          return anyOf(test.values, value);
        });
      });
    };
  }

  // A rule as it is matched: its own copy, with `domains` and `excludedDomains`
  // read as the initiator conditions they stand for, and its patterns
  // compiled. Null for a pattern that does not compile.
  function preparedRule(rule) {
    var copy = JSON.parse(JSON.stringify(rule));
    var c = copy.condition = copy.condition || {};
    if (c.domains && !c.initiatorDomains) {
      c.initiatorDomains = c.domains;
    }
    if (c.excludedDomains && !c.excludedInitiatorDomains) {
      c.excludedInitiatorDomains = c.excludedDomains;
    }
    copy.rank = copy.priority || 1;
    try {
      copy.urlRegExp = c.regexFilter != null ?
        new RegExp(c.regexFilter, c.isUrlFilterCaseSensitive ? "" : "i") :
        urlFilterRegExp(c.urlFilter == null ? "*" : c.urlFilter, !!c.isUrlFilterCaseSensitive);
      if (c.responseHeaders && c.responseHeaders.length) {
        copy.headersWanted = headerConditionTest(c.responseHeaders);
      }
      if (c.excludedResponseHeaders && c.excludedResponseHeaders.length) {
        copy.headersRefused = headerConditionTest(c.excludedResponseHeaders);
      }
    } catch (e) {
      return null;
    }
    return copy;
  }

  function ruleMatches(rule, d) {
    var c = rule.condition || {};
    var url = String(d.url || "");
    if (c.urlFilter != null && !rule.urlRegExp.test(url)) {
      return false;
    }
    if (c.regexFilter != null && !rule.urlRegExp.test(url)) {
      return false;
    }
    var host = hostOf(url);
    if (c.requestDomains && !inDomains(host, c.requestDomains)) {
      return false;
    }
    if (c.excludedRequestDomains && inDomains(host, c.excludedRequestDomains)) {
      return false;
    }
    var initiator = hostOf(d.initiator || d.documentUrl);
    if (c.initiatorDomains && !inDomains(initiator, c.initiatorDomains)) {
      return false;
    }
    if (c.excludedInitiatorDomains && inDomains(initiator, c.excludedInitiatorDomains)) {
      return false;
    }
    if (c.domainType) {
      var thirdParty = !!initiator && siteOf(initiator) !== siteOf(host);
      if ((c.domainType === "thirdParty") !== thirdParty) {
        return false;
      }
    }
    var type = d.type;
    if (c.resourceTypes ? c.resourceTypes.indexOf(type) < 0 :
        (c.excludedResourceTypes ? c.excludedResourceTypes.indexOf(type) >= 0 : type === "main_frame")) {
      return false;
    }
    var method = String(d.method || "GET").toLowerCase();
    if (c.requestMethods && c.requestMethods.indexOf(method) < 0) {
      return false;
    }
    if (c.excludedRequestMethods && c.excludedRequestMethods.indexOf(method) >= 0) {
      return false;
    }
    if (c.tabIds && c.tabIds.indexOf(d.tabId) < 0) {
      return false;
    }
    if (c.excludedTabIds && c.excludedTabIds.indexOf(d.tabId) >= 0) {
      return false;
    }
    if (c.topDomains || c.excludedTopDomains) {
      var top = topHost(d, host);
      if (c.topDomains && !inDomains(top, c.topDomains)) {
        return false;
      }
      if (c.excludedTopDomains && inDomains(top, c.excludedTopDomains)) {
        return false;
      }
    }
    if (rule.headersWanted && !rule.headersWanted(d.responseHeaders || [])) {
      return false;
    }
    if (rule.headersRefused && rule.headersRefused(d.responseHeaders || [])) {
      return false;
    }
    return true;
  }

  // The rules that can exempt a response from header changes, by the hosts
  // they name, so that a response asks only those its host could match.
  function allowIndex(rules) {
    var index = { hosts: Object.create(null), others: [] };
    rules.forEach(function (rule) {
      var c = rule.condition;
      var named = c.requestDomains && c.requestDomains.length ? c.requestDomains : null;
      if (!named && rule.action.type === "allow" && c.urlFilter != null) {
        var anchored = /^\|\|([a-z0-9.\-]+)[\^\/]/i.exec(c.urlFilter);
        named = anchored ? [anchored[1]] : null;
      }
      if (!named || rule.action.type !== "allow") {
        index.others.push(rule);
        return;
      }
      named.forEach(function (domain) {
        var key = String(domain).toLowerCase();
        (index.hosts[key] || (index.hosts[key] = [])).push(rule);
      });
    });
    return index;
  }

  // The highest priority among the index's rules that match a response, or 0.
  // An `allowAllRequests` rule is matched against the frame's own request or,
  // for a request from within a frame, the document that made it, so far as
  // the details tell.
  function allowedAtPriority(index, d) {
    var best = 0;
    function consider(rule) {
      if (rule.rank <= best) {
        return;
      }
      var subject = d;
      if (rule.action.type === "allowAllRequests" && d.type !== "main_frame" && d.type !== "sub_frame") {
        var page = d.documentUrl || d.initiator;
        if (!page) {
          return;
        }
        subject = { url: page, type: d.frameId === 0 ? "main_frame" : "sub_frame", method: "get",
          tabId: d.tabId, frameId: d.frameId, initiator: page };
      }
      if (ruleMatches(rule, subject)) {
        best = rule.rank;
      }
    }
    index.others.forEach(consider);
    var labels = hostOf(d.url).split(".");
    for (var i = 0; i < labels.length; i++) {
      var named = index.hosts[labels.slice(i).join(".")];
      if (named) {
        named.forEach(consider);
      }
    }
    return best;
  }

  // The response headers of `headers` as the matching rules leave them, or
  // null when no rule changes them, or, with `list` "requestHeaders", the
  // request headers. An allow rule, of `allows`, stops a change of its
  // priority or a lower one, as it does in Chrome.
  function applyResponseRules(rules, d, headers, allows, list) {
    var which = list || "responseHeaders";
    var matched = rules.filter(function (rule) {
      return ruleMatches(rule, d);
    });
    if (matched.length && allows) {
      var allowed = allowedAtPriority(allows, d);
      if (allowed) {
        matched = matched.filter(function (rule) {
          return rule.rank > allowed;
        });
      }
    }
    if (!matched.length) {
      return null;
    }
    var out = (headers || []).slice();
    var decided = {};
    matched.forEach(function (rule) {
      (rule.action[which] || []).forEach(function (info) {
        var name = String(info.header || "").toLowerCase();
        var op = info.operation;
        if (decided[name] && (decided[name] !== "append" || op !== "append")) {
          return;
        }
        decided[name] = op;
        if (op === "remove" || op === "set") {
          out = out.filter(function (h) {
            return String(h.name).toLowerCase() !== name;
          });
        }
        if (op === "set" || op === "append") {
          out.push({ name: info.header, value: String(info.value) });
        }
      });
    });
    // Sites increasingly send frame-ancestors beside X-Frame-Options. An
    // extension rule that expressly removes X-Frame-Options from a subframe
    // is asking to make that frame embeddable; leaving the equivalent CSP
    // directive would turn the load into a blank error document. Remove only
    // that directive, from that matching subframe response, and keep every
    // other part of its policy.
    if (which === "responseHeaders" && d.type === "sub_frame" &&
        (decided["x-frame-options"] === "remove" || decided["frame-options"] === "remove")) {
      out = out.reduce(function (kept, header) {
        if (String(header.name).toLowerCase() !== "content-security-policy") {
          kept.push(header);
          return kept;
        }
        var value = String(header.value || "").split(";").filter(function (directive) {
          return !/^\s*frame-ancestors(?:\s|$)/i.test(directive);
        }).join(";").replace(/^\s+|\s+$/g, "");
        if (value) {
          kept.push({ name: header.name, value: value });
        }
        return kept;
      }, []);
    }
    return out;
  }

  function isAllowRule(rule) {
    var type = rule && rule.action && rule.action.type;
    return type === "allow" || type === "allowAllRequests";
  }

  // The rules of a static ruleset's file, or null.
  function readStaticRules(rulesetId) {
    var resources = ((CONFIG.manifest || {}).declarative_net_request || {}).rule_resources || [];
    var resource = resources.filter(function (r) {
      return r && r.id === rulesetId;
    })[0];
    var rules = resource ? readJsonSync(String(resource.path)) : null;
    return Array.isArray(rules) ? rules : null;
  }

  // A ruleset's allow rules, read once, and only by an extension whose rules
  // change response headers, when those rules are prepared.
  var staticAllowCache = {};

  function staticAllowRules(rulesetId) {
    if (!Object.prototype.hasOwnProperty.call(staticAllowCache, rulesetId)) {
      staticAllowCache[rulesetId] = (readStaticRules(rulesetId) || []).filter(isAllowRule);
    }
    return staticAllowCache[rulesetId];
  }

  // The request headers of a dynamic or session rule that the engine
  // refused (makeDeclarativeNetRequest), which the rule still names as the
  // extension wrote it, are applied the same way, from the engine's blocking
  // onBeforeSendHeaders, which the engine merges with every other listener's
  // changes as Chrome does: a rule's own request headers stay the engine's,
  // and the runtime adds those the engine would not take.
  // Where a redirect or upgradeScheme rule sends `url`, as Chrome works it
  // out: to the rule's url, to one of the extension's files, by the
  // regexFilter's substitution, or by a transform of the address's parts.
  function requestActionTarget(rule, url) {
    if (rule.action.type === "upgradeScheme") {
      return url.replace(/^http:/i, "https:").replace(/^ws:/i, "wss:");
    }
    var r = rule.action.redirect || {};
    if (typeof r.url === "string") {
      return r.url;
    }
    if (typeof r.extensionPath === "string") {
      return extUrl(servedPath(r.extensionPath).replace(/^\/+/, ""));
    }
    if (typeof r.regexSubstitution === "string" && rule.condition.regexFilter != null) {
      var m = new RegExp(rule.condition.regexFilter, rule.condition.isUrlFilterCaseSensitive ? "" : "i").exec(url);
      return m ? r.regexSubstitution.replace(/\\(\d)/g, function (whole, n) {
        return m[Number(n)] == null ? "" : m[Number(n)];
      }) : null;
    }
    var t = r.transform;
    if (!t) {
      return null;
    }
    var u;
    try {
      u = new URL(url);
    } catch (e) {
      return null;
    }
    if (t.scheme) {
      u.protocol = t.scheme + ":";
    }
    ["host", "port", "username", "password"].forEach(function (part) {
      if (t[part] != null) {
        u[part === "host" ? "hostname" : part] = t[part];
      }
    });
    if (t.path != null) {
      u.pathname = t.path;
    }
    if (t.query != null) {
      u.search = t.query;
    } else if (t.queryTransform) {
      var params = u.searchParams;
      (t.queryTransform.removeParams || []).forEach(function (key) {
        params["delete"](key);
      });
      (t.queryTransform.addOrReplaceParams || []).forEach(function (p) {
        if (params.has(p.key) || !p.replaceOnly) {
          params.set(p.key, p.value);
        }
      });
    }
    if (t.fragment != null) {
      u.hash = t.fragment;
    }
    return u.href;
  }

  function installResponseHeaderRules(native, dnr) {
    endLocalSessionRules();
    var event = native.webRequest && native.webRequest.onHeadersReceived;
    if (!event || !dnr) {
      return function () {};
    }
    var responses = headerListener(event, "responseHeaders", ["blocking", "responseHeaders", "extraHeaders"]);
    var requests = native.webRequest.onBeforeSendHeaders ? headerListener(native.webRequest.onBeforeSendHeaders,
      "requestHeaders", ["blocking", "requestHeaders", "extraHeaders"]) : null;
    var engineDnr = native.declarativeNetRequest || {};
    var actions = native.webRequest.onBeforeRequest ? requestRules(native.webRequest.onBeforeRequest) : null;

    function listen(next, nextAllows) {
      responses.listen(next, nextAllows);
    }

    // The rules with a tab condition that block, redirect or upgrade a
    // request (tabScoped), applied from the engine's blocking
    // onBeforeRequest to the requests of tabs, as the engine applies its own:
    // the highest priority first, where an allow rule of the extension's at
    // that priority or above lets the request be, and of one priority a
    // block before an upgrade before a redirect, as in Chrome.
    var ACTION_ORDER = { block: 0, upgradeScheme: 1, redirect: 2 };

    function requestRules(source) {
      var listener = null;
      return { listen: function (rules, allows) {
        if (listener) {
          try {
            source.removeListener(listener);
          } catch (e) { /* gone already */ }
          listener = null;
        }
        if (!rules.length) {
          return;
        }
        rules = rules.slice().sort(function (a, b) {
          return b.rank - a.rank || ACTION_ORDER[a.action.type] - ACTION_ORDER[b.action.type];
        });
        listener = function (d) {
          if (!(d.tabId >= 0)) {
            return undefined;
          }
          var rule = rules.filter(function (candidate) {
            return ruleMatches(candidate, d);
          })[0];
          if (!rule || (allows && allowedAtPriority(allows, d) >= rule.rank)) {
            return undefined;
          }
          var target = requestActionTarget(rule, d.url);
          if (rule.action.type === "block") {
            return { cancel: true };
          }
          return target && target !== d.url ? { redirectUrl: target } : undefined;
        };
        try {
          source.addListener(listener, { urls: ["<all_urls>"] }, ["blocking"]);
        } catch (e) {
          log.error("could not apply declarativeNetRequest rules for particular tabs", e);
          listener = null;
        }
      } };
    }

    // The rules whose request headers the engine refused, each with only
    // those: what the extension's rule names that the engine's rule of that
    // id does not.
    function refusedRequestRules(given, engine) {
      var byId = {};
      (engine || []).forEach(function (rule) {
        if (rule && rule.id != null) {
          byId[rule.id] = rule;
        }
      });
      var out = [];
      (given || []).forEach(function (rule) {
        var action = rule && rule.action;
        if (!action || action.type !== "modifyHeaders" || !Array.isArray(action.requestHeaders)) {
          return;
        }
        var held = byId[rule.id] && byId[rule.id].action && byId[rule.id].action.requestHeaders || [];
        var taken = {};
        held.forEach(function (entry) {
          taken[String(entry && entry.header).toLowerCase()] = true;
        });
        var refused = action.requestHeaders.filter(function (entry) {
          return !taken[String(entry && entry.header).toLowerCase()];
        });
        if (refused.length) {
          var copy = JSON.parse(JSON.stringify(rule));
          copy.action.requestHeaders = refused;
          delete copy.action.responseHeaders;
          out.push(copy);
        }
      });
      return out;
    }

    function engineRules(name) {
      return typeof engineDnr[name] === "function" ?
        Promise.resolve(engineDnr[name]()).then(null, function () { return []; }) : Promise.resolve([]);
    }

    // `allowing` gives the allow rules that can exempt a request, read only
    // when some rule's request headers are the runtime's to apply.
    function refreshRequests(given, allowing) {
      if (!requests) {
        return Promise.resolve();
      }
      return Promise.all([engineRules("getDynamicRules"), engineRules("getSessionRules")]).then(function (engine) {
        var all = prepared(refusedRequestRules(given[0], engine[0]).concat(refusedRequestRules(given[1], engine[1])));
        all.sort(function (a, b) {
          return b.rank - a.rank;
        });
        var exempting = all.length ? allowing() : [];
        requests.listen(all, exempting.length ? allowIndex(exempting) : null);
      });
    }
    // A blocking listener of `source` that applies the rules it is given
    // to the request's `which` headers.
    function headerListener(source, which, spec) {
      var rules = [];
      var allows = null;
      var listener = null;
      return { listen: function (next, nextAllows) {
        if (listener) {
          try {
            source.removeListener(listener);
          } catch (e) { /* gone already */ }
          listener = null;
        }
        rules = next;
        allows = nextAllows;
        if (!rules.length) {
          return;
        }
        var hosts = [];
        var everyNamesHosts = rules.every(function (rule) {
          var domains = rule.condition && rule.condition.requestDomains;
          if (!domains || !domains.length) {
            return false;
          }
          domains.forEach(function (domain) {
            hosts.push("*://" + domain + "/*", "*://*." + domain + "/*");
          });
          return true;
        });
        var types = [];
        var everyNamesTypes = rules.every(function (rule) {
          var named = rule.condition && rule.condition.resourceTypes;
          (named || []).forEach(function (type) {
            if (types.indexOf(type) < 0) {
              types.push(type);
            }
          });
          return !!(named && named.length);
        });
        var filter = { urls: everyNamesHosts ? hosts : ["<all_urls>"] };
        if (everyNamesTypes) {
          filter.types = types;
        }
        listener = function (d) {
          var headers = applyResponseRules(rules, d, d[which], allows, which);
          var out;
          if (headers) {
            out = {};
            out[which] = headers;
          }
          return out;
        };
        try {
          source.addListener(listener, filter, spec);
        } catch (e) {
          log.error("could not apply rules that change " + (which === "requestHeaders" ? "request" : "response") +
            " headers", e);
          listener = null;
        }
    } };
      }

    function withResponseHeaders(list) {
      return (list || []).filter(function (rule) {
        return rule && rule.action && rule.action.type === "modifyHeaders" &&
          Array.isArray(rule.action.responseHeaders) && rule.action.responseHeaders.length;
      });
    }

    function withAllow(list) {
      return (list || []).filter(isAllowRule);
    }

    function prepared(list) {
      return list.map(preparedRule).filter(Boolean);
    }

    function refresh() {
      var disabled = {};
      var enabledRulesets = [];
      try {
        disabled = JSON.parse(localStorageOf(g).getItem("wex.dnr.disabledStaticRules") || "{}") || {};
      } catch (e) { /* none disabled */ }
      var recorded = CONFIG.responseHeaderRules || {};
      return Promise.all([
        dnr.getEnabledRulesets().then(function (enabled) {
          var out = [];
          enabledRulesets = enabled || [];
          enabledRulesets.forEach(function (id) {
            var list = Object.prototype.hasOwnProperty.call(recorded, id) ? recorded[id] : null;
            var off = disabled[id] || {};
            withResponseHeaders(Array.isArray(list) ? list : []).forEach(function (rule) {
              if (!Object.prototype.hasOwnProperty.call(off, rule.id)) {
                out.push(rule);
              }
            });
          });
          return out;
        }, function () { return []; }),
        dnr.getDynamicRules().then(null, function () { return []; }),
        dnr.getSessionRules().then(null, function () { return []; })
      ]).then(function (lists) {
        var all = prepared(lists[0].concat(withResponseHeaders(lists[1]), withResponseHeaders(lists[2])));
        all.sort(function (a, b) {
          return b.rank - a.rank;
        });
        var exempting = [];
        if (all.length) {
          // An allow rule below every change can stop none of them.
          var lowest = all[all.length - 1].rank;
          exempting = withAllow(lists[1]).concat(withAllow(lists[2]));
          enabledRulesets.forEach(function (id) {
            exempting = exempting.concat(staticAllowRules(id));
          });
          exempting = prepared(exempting.filter(function (rule) {
            return (rule.priority || 1) >= lowest;
          }));
        }
        if (all.concat(exempting).some(function (rule) {
          return rule.condition.domainType;
        })) {
          readSiteList();
        }
        listen(all, exempting.length ? allowIndex(exempting) : null);
        if (actions) {
          var local = prepared(lists[1].concat(lists[2]).filter(function (rule) {
            return tabScoped(rule) && rule.action && ACTION_ORDER.hasOwnProperty(rule.action.type);
          }));
          var allowingLocal = [];
          if (local.length) {
            allowingLocal = withAllow(lists[1]).concat(withAllow(lists[2]));
            enabledRulesets.forEach(function (id) {
              allowingLocal = allowingLocal.concat(staticAllowRules(id));
            });
            allowingLocal = prepared(allowingLocal);
            if (local.concat(allowingLocal).some(function (rule) {
              return rule.condition.domainType;
            })) {
              readSiteList();
            }
          }
          actions.listen(local, allowingLocal.length ? allowIndex(allowingLocal) : null);
        }
        return refreshRequests([lists[1], lists[2]], function () {
          var allowing = withAllow(lists[1]).concat(withAllow(lists[2]));
          enabledRulesets.forEach(function (id) {
            allowing = allowing.concat(staticAllowRules(id));
          });
          return prepared(allowing);
        });
      });
    }

    refresh();
    return refresh;
  }

  // `changed`, when given, is told after each change to the rules.
  function makeDeclarativeNetRequest(native, changed) {
    var source = native.declarativeNetRequest;
    function told(result) {
      if (typeof changed === "function") {
        try {
          changed();
        } catch (e) { /* the change stands */ }
      }
      return result;
    }

    function call(name, args, cb) {
      if (!source || typeof source[name] !== "function") {
        return fail(cb, "declarativeNetRequest." + name + " is not available in this WebKit");
      }
      var promise;
      try {
        promise = Promise.resolve(source[name].apply(source, args));
      } catch (e) {
        promise = Promise.reject(e);
      }
      return settle(promise, cb);
    }

    var stores = { dynamic: splitStore("dynamic"), session: splitStore("session") };

    function compiles(regex) {
      try {
        return !!new RegExp(regex);
      } catch (e) {
        return false;
      }
    }

    function getRules(name, kind) {
      return function (filter, cb) {
        var c = shiftCallback(filter, cb);
        var ids = c.opts.ruleIds;
        return settle(call(name, []).then(function (engineRules) {
          var splits = stores[kind].load();
          var present = {};
          (engineRules || []).forEach(function (rule) {
            present[rule.id] = true;
          });
          var kept = {};
          Object.keys(splits).forEach(function (id) {
            if (present[id] || splits[id].local) {
              kept[id] = splits[id];
            }
          });
          if (Object.keys(kept).length !== Object.keys(splits).length) {
            stores[kind].save(kept);
          }
          var rules = joinSplitRules(engineRules, kept);
          return ids ? rules.filter(function (rule) {
            return ids.indexOf(rule.id) >= 0;
          }) : rules;
        }), c.cb);
      };
    }

    // The engine knows only some headers, and refuses a rule that names
    // another in `modifyHeaders`; it says which, and the header is left out
    // of every rule of the update it goes to, and a rule that leaves nothing
    // to change does not go to it. The runtime applies response headers
    // itself, so a rule keeps those it names (keepResponseRules).
    var UNKNOWN_HEADER = /Rule with id \d+ is invalid\. The header `([^`]+)` is not recognized/;

    function withoutHeader(options, header) {
      var lower = header.toLowerCase();
      var out = {};
      Object.keys(options).forEach(function (key) {
        out[key] = options[key];
      });
      out.addRules = [];
      (options.addRules || []).forEach(function (rule) {
        if (!rule || !rule.action) {
          out.addRules.push(rule);
          return;
        }
        var copy = JSON.parse(JSON.stringify(rule));
        ["requestHeaders", "responseHeaders"].forEach(function (list) {
          if (Array.isArray(copy.action[list])) {
            copy.action[list] = copy.action[list].filter(function (entry) {
              return String(entry && entry.header).toLowerCase() !== lower;
            });
            if (!copy.action[list].length) {
              delete copy.action[list];
            }
          }
        });
        if (copy.action.type === "modifyHeaders" && !copy.action.requestHeaders &&
            !copy.action.responseHeaders) {
          return;
        }
        out.addRules.push(copy);
      });
      return out;
    }

    // The record, as the update leaves it, of each rule that lost a header to
    // the engine, which the extension goes on seeing as it wrote it: `given` is
    // the update as made, `sent` as the engine took it, and `refused` the
    // headers it would not have.
    function keepRefusedRules(splits, given, sent, refused) {
      var extras = {};
      var kept = {};
      Object.keys(splits).forEach(function (id) {
        splits[id].ids.forEach(function (extra) {
          extras[extra] = true;
        });
      });
      (sent.addRules || []).forEach(function (rule) {
        if (rule) {
          kept[rule.id] = true;
        }
      });
      (given.addRules || []).forEach(function (rule) {
        var action = rule && rule.action;
        var headers = action ? [].concat(action.requestHeaders || [], action.responseHeaders || []) : [];
        if (extras[rule && rule.id] || !headers.some(function (entry) {
          return refused[String(entry && entry.header).toLowerCase()];
        })) {
          return;
        }
        var own = Object.prototype.hasOwnProperty.call(splits, rule.id) ? splits[rule.id].rule : rule;
        var record = kept[rule.id] ? { rule: own, ids: [] } : { rule: own, ids: [], local: true };
        if (kept[rule.id] && splits[rule.id]) {
          record.ids = splits[rule.id].ids;
        }
        splits[rule.id] = record;
      });
    }

    // Chrome makes a context's updates one after another, each from the rules
    // the one before left, with the options as they were when it was called.
    var updatesDone = { dynamic: Promise.resolve(), session: Promise.resolve() };

    function updateRules(name, kind) {
      return function (options, cb) {
        var given = JSON.parse(JSON.stringify(options || {}));
        var run = updatesDone[kind].then(function () {
          return applyUpdate(name, kind, given);
        });
        updatesDone[kind] = run.then(function () {}, function () {});
        return settle(run, cb);
      };
    }

    function applyUpdate(name, kind, options) {
      var store = stores[kind];
      var tabbed = kind === "dynamic" ? (options.addRules || []).filter(hasTabCondition)[0] : null;
      if (tabbed) {
        return Promise.reject(new Error("Rule with id " + tabbed.id + " specifies a value for \"tabIds\" or " +
          "\"excludedTabIds\" key. These are only supported for session-scoped rules."));
      }
      var originals = {};
      var update = splitRegexRules(scopeRegexRules(options, originals), store.load());
      Object.keys(originals).forEach(function (id) {
        update.splits[id] = { rule: originals[id], ids: update.splits[id] ? update.splits[id].ids : [] };
      });
      var attempts = 0;
      var refused = {};
      var sent = update.options;
      function attempt(engineOptions) {
        sent = engineOptions;
        return Promise.resolve().then(function () {
          return call(name, [engineOptions]);
        }).catch(function (error) {
          var unknown = UNKNOWN_HEADER.exec(String(error && error.message));
          if (!unknown || ++attempts > 50) {
            throw error;
          }
          log.unsupported("declarativeNetRequest rules that change the " + unknown[1] + " header");
          refused[unknown[1].toLowerCase()] = true;
          return attempt(withoutHeader(engineOptions, unknown[1]));
        });
      }
      return attempt(update.options).then(function (result) {
        if (attempts) {
          keepRefusedRules(update.splits, update.options, sent, refused);
        }
        store.save(update.splits);
        return told(result);
      });
    }

    var updateDynamicRules = updateRules("updateDynamicRules", "dynamic");

    // Single rules of a static ruleset. The engine applies a ruleset whole,
    // so a rule the extension disables is overridden while its ruleset is
    // enabled: an `allow` rule with its condition and priority, which takes
    // precedence over a rule of that priority that blocks, redirects,
    // upgrades or changes headers, is kept among the dynamic rules under an
    // id of a range of its own, which the extension never sees. Nothing
    // overrides an `allow` or `allowAllRequests` rule so, and such a rule
    // stays enabled; a call that can disable nothing it names fails.
    var OVERRIDE_RULE_ID_BASE = 1990000000;
    var DISABLED_KEY = "wex.dnr.disabledStaticRules";
    var staticRuleCache = {};

    function loadDisabled() {
      try {
        var stored = JSON.parse(localStorageOf(g).getItem(DISABLED_KEY) || "null");
        return stored && typeof stored === "object" ? stored : {};
      } catch (e) {
        return {};
      }
    }

    function saveDisabled(disabled) {
      try {
        localStorageOf(g).setItem(DISABLED_KEY, JSON.stringify(disabled));
      } catch (e) { /* the overrides stand without the record */ }
    }

    function staticRules(rulesetId) {
      if (!Object.prototype.hasOwnProperty.call(staticRuleCache, rulesetId)) {
        staticRuleCache[rulesetId] = readStaticRules(rulesetId);
      }
      return staticRuleCache[rulesetId];
    }

    function overridable(rule) {
      var type = rule && rule.action && rule.action.type;
      return !!type && type !== "allow" && type !== "allowAllRequests";
    }

    // Brings the overrides in line with the disabled rules and the enabled
    // rulesets, and saves the record.
    function applyOverrides(disabled, enabled) {
      var used = {};
      Object.keys(disabled).forEach(function (rulesetId) {
        Object.keys(disabled[rulesetId]).forEach(function (ruleId) {
          if (disabled[rulesetId][ruleId] != null) {
            used[disabled[rulesetId][ruleId]] = true;
          }
        });
      });
      var next = OVERRIDE_RULE_ID_BASE;
      var removeRuleIds = [];
      var addRules = [];
      Object.keys(disabled).forEach(function (rulesetId) {
        var active = enabled.indexOf(rulesetId) >= 0;
        var rules = staticRules(rulesetId) || [];
        Object.keys(disabled[rulesetId]).forEach(function (ruleId) {
          var current = disabled[rulesetId][ruleId];
          var rule = rules.filter(function (r) {
            return r && String(r.id) === ruleId;
          })[0];
          if (!active || !overridable(rule)) {
            if (current != null) {
              removeRuleIds.push(current);
              disabled[rulesetId][ruleId] = null;
            }
            return;
          }
          if (current != null) {
            return;
          }
          while (used[next]) {
            next++;
          }
          used[next] = true;
          disabled[rulesetId][ruleId] = next;
          addRules.push({
            id: next,
            priority: rule.priority || 1,
            action: { type: "allow" },
            condition: JSON.parse(JSON.stringify(rule.condition || {}))
          });
        });
      });
      if (!removeRuleIds.length && !addRules.length) {
        saveDisabled(disabled);
        return Promise.resolve();
      }
      return updateDynamicRules({ removeRuleIds: removeRuleIds, addRules: addRules }).then(function () {
        saveDisabled(disabled);
      });
    }

    function enabledRulesets() {
      return call("getEnabledRulesets", []).then(function (ids) {
        return ids || [];
      });
    }

    // Changes to the overrides run one after another, each from the record
    // the one before saved, so that two never take the same id.
    var overridesDone = Promise.resolve();

    function inOverrideOrder(step) {
      var run = overridesDone.then(step);
      overridesDone = run.then(function () {}, function () {});
      return run;
    }

    var out = {
      onRuleMatchedDebug: new Event("declarativeNetRequest.onRuleMatchedDebug"),
      updateDynamicRules: updateDynamicRules,
      updateSessionRules: updateRules("updateSessionRules", "session"),
      getDynamicRules: (function (get) {
        return function (filter, cb) {
          var c = shiftCallback(filter, cb);
          return settle(get(c.opts).then(function (rules) {
            return rules.filter(function (rule) {
              return rule.id < OVERRIDE_RULE_ID_BASE;
            });
          }), c.cb);
        };
      })(getRules("getDynamicRules", "dynamic")),
      getSessionRules: getRules("getSessionRules", "session"),
      updateEnabledRulesets: function (options, cb) {
        return settle(call("updateEnabledRulesets", [options || {}]).then(function (result) {
          return inOverrideOrder(function () {
            return enabledRulesets().then(function (enabled) {
              return applyOverrides(loadDisabled(), enabled);
            });
          }).then(function () {
            return told(result);
          });
        }), cb);
      },
      getEnabledRulesets: function (cb) {
        return call("getEnabledRulesets", [], cb);
      },
      getMatchedRules: function (filter, cb) {
        var c = shiftCallback(filter, cb);
        var args = typeof filter === "object" && filter ? [filter] : [];
        return settle(call("getMatchedRules", args).then(function (matched) {
          var splits = {
            _dynamic: stores.dynamic.load(),
            _session: stores.session.load()
          };
          ((matched && matched.rulesMatchedInfo) || []).forEach(function (info) {
            var rule = info && info.rule;
            if (rule && splits[rule.rulesetId]) {
              rule.ruleId = splitOwner(rule.ruleId, splits[rule.rulesetId]);
            }
          });
          if (matched && Array.isArray(matched.rulesMatchedInfo)) {
            matched.rulesMatchedInfo = matched.rulesMatchedInfo.filter(function (info) {
              return !(info && info.rule && info.rule.ruleId >= OVERRIDE_RULE_ID_BASE);
            });
          }
          return matched;
        }), c.cb);
      },
      getDisabledRuleIds: function (options, cb) {
        var c = shiftCallback(options, cb);
        var mine = loadDisabled()[c.opts.rulesetId] || {};
        return done(c.cb, Object.keys(mine).map(Number));
      },
      updateStaticRules: function (options, cb) {
        var o = options || {};
        var rules = staticRules(o.rulesetId);
        if (!rules) {
          return fail(cb, "Invalid ruleset id: " + o.rulesetId + ".");
        }
        var byId = {};
        rules.forEach(function (rule) {
          if (rule) {
            byId[rule.id] = rule;
          }
        });
        return settle(inOverrideOrder(function () {
          var disabled = loadDisabled();
          var mine = disabled[o.rulesetId] = disabled[o.rulesetId] || {};
          var disable = (o.disableRuleIds || []).filter(function (id) {
            return !Object.prototype.hasOwnProperty.call(mine, id) && (!byId[id] || overridable(byId[id]));
          });
          var enable = (o.enableRuleIds || []).filter(function (id) {
            return Object.prototype.hasOwnProperty.call(mine, id);
          });
          if ((o.disableRuleIds || []).length && !disable.length && !enable.length &&
              (o.disableRuleIds || []).some(function (id) {
                return !Object.prototype.hasOwnProperty.call(mine, id);
              })) {
            throw new Error("An allow rule of a static ruleset cannot be disabled in this browser.");
          }
          var removeRuleIds = [];
          enable.forEach(function (id) {
            if (mine[id] != null) {
              removeRuleIds.push(mine[id]);
            }
            delete mine[id];
          });
          disable.forEach(function (id) {
            mine[id] = null;
          });
          var cleared = removeRuleIds.length
            ? updateDynamicRules({ removeRuleIds: removeRuleIds }) : Promise.resolve();
          return cleared.then(enabledRulesets).then(function (enabled) {
            return applyOverrides(disabled, enabled);
          });
        }).then(told), cb);
      },
      isRegexSupported: function (options, cb) {
        var o = options || {};
        if (typeof o.regex === "string" && adaptRegex(o.regex, !!o.requireCapturing) && compiles(o.regex)) {
          return settle(Promise.resolve({ isSupported: true }), cb);
        }
        return call("isRegexSupported", [o], cb);
      },
      // The rules still free for static rulesets, from Chrome's allowance and
      // the rule counts the converter recorded for each ruleset.
      getAvailableStaticRuleCount: function (cb) {
        if (source && typeof source.getAvailableStaticRuleCount === "function") {
          return call("getAvailableStaticRuleCount", [], cb);
        }
        var counts = CONFIG.rulesetRuleCounts || {};
        return settle(call("getEnabledRulesets", []).then(function (ids) {
          var used = 0;
          (ids || []).forEach(function (id) {
            used += Object.prototype.hasOwnProperty.call(counts, id) ? counts[id] : 0;
          });
          return Math.max(0, STATIC_RULE_ALLOWANCE - used);
        }), cb);
      },
      setExtensionActionOptions: function (options, cb) {
        return call("setExtensionActionOptions", [options || {}], cb);
      }
    };
    Object.keys(DNR_CONSTANTS).forEach(function (name) {
      out[name] = source && source[name] != null ? source[name] : DNR_CONSTANTS[name];
    });
    return out;
  }

  // ------------------------------------------------------------------ //
  // webNavigation
  // ------------------------------------------------------------------ //
  // One events.UrlFilter against one URL.
  function urlFilterMatches(url, filter) {
    var u;
    try {
      u = new g.URL(url);
    } catch (e) {
      return false;
    }
    var host = u.hostname;
    var path = u.pathname;
    var query = u.search.replace(/^\?/, "");
    // The url* conditions see the URL without its fragment.
    var whole = u.href.replace(/#[\s\S]*$/, "");
    function endsWith(s, v) {
      return s.slice(s.length - v.length) === v;
    }
    var tests = {
      hostContains: function (v) { return ("." + host + ".").indexOf(v) >= 0; },
      hostEquals: function (v) { return host === v; },
      hostPrefix: function (v) { return host.indexOf(v) === 0; },
      hostSuffix: function (v) { return endsWith(host + ".", v) || endsWith(host, v); },
      pathContains: function (v) { return path.indexOf(v) >= 0; },
      pathEquals: function (v) { return path === v; },
      pathPrefix: function (v) { return path.indexOf(v) === 0; },
      pathSuffix: function (v) { return endsWith(path, v); },
      queryContains: function (v) { return query.indexOf(v) >= 0; },
      queryEquals: function (v) { return query === v; },
      queryPrefix: function (v) { return query.indexOf(v) === 0; },
      querySuffix: function (v) { return endsWith(query, v); },
      urlContains: function (v) { return whole.indexOf(v) >= 0; },
      urlEquals: function (v) { return whole === v; },
      urlPrefix: function (v) { return whole.indexOf(v) === 0; },
      urlSuffix: function (v) { return endsWith(whole, v); },
      urlMatches: function (v) { return new RegExp(v).test(whole); },
      originAndPathMatches: function (v) { return new RegExp(v).test(u.origin + path); },
      schemes: function (v) { return v.indexOf(u.protocol.replace(/:$/, "")) >= 0; },
      ports: function (v) {
        var port = Number(u.port) || { "http:": 80, "https:": 443, "ws:": 80, "wss:": 443 }[u.protocol];
        return v.some(function (p) {
          return Array.isArray(p) ? (port >= p[0] && port <= p[1]) : port === p;
        });
      }
    };
    for (var key in filter) {
      if (tests[key] && filter[key] != null) {
        try {
          if (!tests[key](filter[key])) {
            return false;
          }
        } catch (e) {
          return false;
        }
      }
    }
    return true;
  }

  // The engine's webNavigation events, each listener with the URL filter it
  // was registered under. `extras` are the events the engine leaves to the
  // runtime. `topFrame` describes the top frame of a tab the engine has no
  // record of, as Safari knows it, or gives null. The navigations of the
  // runtime's own pages, and of the tabs `runtimeTab` names, are not the
  // extension's to see.
  function makeWebNavigation(native, extras, topFrame, runtimeTab) {
    var source = native.webNavigation;

    function filtered(event, name) {
      return adaptEvent(event, function (fn, extra) {
        var filters = extra[0] && extra[0].url;
        return function (details) {
          if (details && (runtimeRequest(details.url) ||
              (runtimeTab && runtimeTab(details.tabId)))) {
            return undefined;
          }
          describeDocument(details, name === "onCommitted" ? commitOf(details) : undefined,
            name === "onBeforeNavigate" || name === "onCreatedNavigationTarget");
          if (!filters || !filters.length) {
            return fn.apply(null, arguments);
          }
          var url = String(details && details.url);
          for (var i = 0; i < filters.length; i++) {
            if (urlFilterMatches(url, filters[i])) {
              return fn.apply(null, arguments);
            }
          }
          return undefined;
        };
      });
    }

    // Each commit is a new document, whether or not the extension listens.
    if (source.onCommitted && typeof source.onCommitted.addListener === "function") {
      source.onCommitted.addListener(function (details) {
        if (details) {
          documentIdFor(details.tabId, details.frameId, commitOf(details));
        }
      });
    }

    var out = {
      onTabReplaced: new Event("webNavigation.onTabReplaced"),
      getFrame: function (details, cb) {
        if (details && details.documentId != null && details.frameId == null) {
          var named = frameOfDocument(details.tabId, details.documentId);
          if (named === null) {
            return settle(Promise.resolve(null), cb);
          }
          details = { tabId: details.tabId, frameId: named };
        }
        return settle(source.getFrame(details).then(function (frame) {
          if (!frame && topFrame && details && Number(details.frameId) === 0) {
            frame = topFrame(details.tabId);
          }
          if (frame && frame.tabId === undefined && details) {
            frame.tabId = details.tabId;
          }
          if (frame && frame.frameId === undefined && details) {
            frame.frameId = Number(details.frameId);
          }
          if (frame && frame.url === undefined) {
            frame.url = "";
          }
          return describeDocument(frame);
        }), cb);
      },
      getAllFrames: function (details, cb) {
        return settle(source.getAllFrames(details).then(function (frames) {
          if (!frames && topFrame) {
            var top = topFrame(details && details.tabId);
            frames = top ? [top] : null;
          }
          return frames && frames.map(function (frame) {
            if (frame.tabId === undefined) {
              frame.tabId = details.tabId;
            }
            // The engine gives no address for a frame holding another extension's page.
            if (frame.url === undefined) {
              frame.url = "";
            }
            return describeDocument(frame);
          });
        }), cb);
      }
    };
    ["onBeforeNavigate", "onCommitted", "onDOMContentLoaded", "onCompleted",
      "onErrorOccurred", "onCreatedNavigationTarget"].forEach(function (name) {
      out[name] = filtered(source[name], name);
    });
    Object.keys(extras || {}).forEach(function (name) {
      out[name] = filtered(extras[name], name);
    });
    return out;
  }

  // ------------------------------------------------------------------ //
  // Injection on demand
  // ------------------------------------------------------------------ //
  // tabs.executeScript, insertCSS and removeCSS, and their scripting.*
  // successors, carried out by the engine. Scripts are handed to the content
  // bridge in the target frame, which runs them where they were asked to run
  // and reports which frame it is; a frame without the bridge evaluates them
  // directly. `activeTabId` returns a promise for the tab to use when the
  // caller names none.
  // A script's result as Chrome hands it back (content::V8ValueConverter):
  // a host object, such as a node, `document` or `location`, is an empty
  // object; a value that refers back to an object it is part of is null; a
  // function, undefined or a number that is not finite is left out of an
  // object, and is null in an array, which keeps its indexes alone. It runs
  // in the frame, by its source, so it refers to nothing outside itself. A
  // Firefox build's result is its JSON, as Firefox clones it.
  function scriptValue(x) {
    var path = [];
    function convert(value, depth) {
      var type = typeof value;
      if (value === null || type === "string" || type === "boolean") {
        return value;
      }
      if (type === "number") {
        return isFinite(value) ? value : undefined;
      }
      if (type !== "object" || depth > 100) {
        return undefined;
      }
      if (path.indexOf(value) >= 0) {
        return null;
      }
      var out;
      path.push(value);
      if (Array.isArray(value)) {
        out = [];
        for (var i = 0; i < value.length; i++) {
          var item = convert(value[i], depth + 1);
          out.push(item === undefined ? null : item);
        }
      } else {
        out = {};
        if (Object.prototype.toString.call(value) === "[object Object]") {
          Object.keys(value).forEach(function (key) {
            var item = convert(value[key], depth + 1);
            if (item !== undefined) {
              out[key] = item;
            }
          });
        }
      }
      path.pop();
      return out;
    }
    return convert(x, 0);
  }

  function jsonValue(x) {
    var t;
    try {
      t = JSON.stringify(x);
    } catch (e) {
      t = "null";
    }
    return t === undefined ? undefined : JSON.parse(t);
  }

  // The source of the function a frame turns its result into a value with.
  var RESULT_VALUE_SOURCE = String(CONFIG.firefoxBuild ? jsonValue : scriptValue);

  var BRIDGE_FILE = "wex/wex-bridge.js";

  function makeInjection(native, activeTabId) {
    function tabIdOr(id) {
      return typeof id === "number" ? Promise.resolve(id) : activeTabId();
    }

    function bundlePath(file) {
      return extPath(extUrl(file));
    }

    // A file the call names, with the error of the call's API: tabs'
    // executeScript, or scripting's in a Chrome build.
    function source(file, scripting) {
      var text = readTextSync(bundlePath(file));
      if (text == null) {
        throw new Error(scripting && !CONFIG.firefoxBuild ? "Could not load file: '" + file + "'." :
          "Failed to load file: \"" + file + "\". ");
      }
      return { code: text, url: extUrl(bundlePath(file)) };
    }

    function scriptingSource(file) {
      return source(file, true);
    }

    // Whether a file's bytes are UTF-8, for one whose text has the character
    // that stands in for what could not be read, which a UTF-8 file may hold
    // itself. x-user-defined gives each byte over 0x7F as U+F780 and up; a
    // file whose bytes cannot be read so counts as UTF-8.
    function readsAsUtf8(path) {
      var text;
      try {
        var x = new PageXHR();
        xhrOpen.call(x, "GET", extUrl(path), false);
        x.overrideMimeType("text/plain; charset=x-user-defined");
        xhrSend.call(x);
        text = x.responseText;
      } catch (e) {
        return true;
      }
      var following = 0;
      var low = 0x80;
      var high = 0xBF;
      for (var i = 0; i < text.length; i++) {
        var c = text.charCodeAt(i);
        if (c >= 0x80 && (c < 0xF780 || c > 0xF7FF)) {
          return true;
        }
        var b = c & 0xFF;
        if (following) {
          if (b < low || b > high) {
            return false;
          }
          following--;
          low = 0x80;
          high = 0xBF;
        } else if (b >= 0x80) {
          if (b < 0xC2 || b > 0xF4) {
            return false;
          }
          following = b < 0xE0 ? 1 : b < 0xF0 ? 2 : 3;
          low = b === 0xE0 ? 0xA0 : b === 0xF0 ? 0x90 : 0x80;
          high = b === 0xED ? 0x9F : b === 0xF4 ? 0x8F : 0xBF;
        }
      }
      return !following;
    }

    // What Chrome's tabs.executeScript refuses before it injects anything.
    function legacyScriptError(d) {
      if (CONFIG.firefoxBuild) {
        return null;
      }
      if (d.cssOrigin != null) {
        return "CSS origin should be specified only for CSS code.";
      }
      if (d.file && !/\.m?js$/i.test(String(d.file).split(/[?#]/)[0])) {
        return "Could not load file '" + d.file + "' for content script, content scripts can only be " +
          "loaded from supported JavaScript files such as .js files.";
      }
      var text = d.file ? readTextSync(bundlePath(d.file)) : null;
      if (text != null && text.indexOf("\ufffd") >= 0 && !readsAsUtf8(bundlePath(d.file))) {
        return "Could not load file '" + d.file + "' for content script. It isn't UTF-8 encoded.";
      }
      return null;
    }

    // The code each frame runs: the bridge's exec. A frame whose document
    // loaded before the extension started has no bridge, as Safari injects
    // only as a page loads, so it reads and evaluates the bridge first, which
    // gives the code `chrome` there as a browser's content-script world has it,
    // and runs none of the manifest's content scripts. Where even that fails,
    // the same work is done in place, telling a settled promise over the
    // engine's own messaging.
    function codeFor(job) {
      return "(function(j){var b=this.__wexContent;" +
        "if(!b&&j.bridge){try{var x=new XMLHttpRequest();x.open('GET',j.bridge,false);x.send();" +
        "this.__wexLateBridge={baseURI:j.base};(0,eval)(x.responseText);b=this.__wexContent;}catch(e){}}" +
        "if(b&&b.exec){return b.exec(j);}" +
        "var f=0;try{f=browser.runtime.getFrameId(window);}catch(e){}" +
        "function m(e){return e&&typeof e.message==='string'?e.message:" +
        "typeof e==='string'?e:'An unexpected error occurred';}" +
        "var v=" + RESULT_VALUE_SOURCE + ";" +
        "var r;try{j.sources.forEach(function(s,i){" +
        "if(j.independentFiles&&i<j.sources.length-1){try{(0,eval)(s.code);}catch(e){console.error(e);}}" +
        "else{r=(0,eval)(s.code);}});" +
        "if(j.func){r=(0,eval)('('+j.func+')').apply(null,j.args||[]);}}" +
        "catch(e){if(j.reportErrors){return{frameId:f,error:m(e)};}throw e;}" +
        "if(j.settle&&r&&typeof r.then==='function'){var B=this.browser||this.chrome;" +
        "Promise.resolve(r).then(function(x){B.runtime.sendMessage({__wex:'settled',token:j.settle,frameId:f,result:v(x)});}," +
        "function(e){B.runtime.sendMessage({__wex:'settled',token:j.settle,frameId:f,failed:true,error:m(e)});});" +
        "return{frameId:f,settle:j.settle};}" +
        "return{frameId:f,result:v(r)};" +
        "}).call(this," + JSON.stringify(job) + ")";
    }

    function copy(from, names) {
      var out = {};
      names.forEach(function (name) {
        if (from[name] != null) {
          out[name] = from[name];
        }
      });
      return out;
    }

    // The frames a target names, by frame id or by document, or null.
    function targetFrames(tabId, target) {
      if (target.frameIds && target.frameIds.length) {
        return target.frameIds;
      }
      var named = target.documentIds || [];
      if (!named.length) {
        return null;
      }
      return named.map(function (documentId) {
        var frame = frameOfDocument(tabId, documentId);
        if (frame === null) {
          throw new Error("No document with id " + documentId + " in tab with id " + tabId);
        }
        return frame;
      });
    }

    // One engine call per frame named, or one for the whole tab.
    function eachTarget(tabId, target, call) {
      var frameIds;
      try {
        frameIds = targetFrames(tabId, target);
      } catch (e) {
        return Promise.reject(e);
      }
      if (!frameIds) {
        return call(target.allFrames ? { allFrames: true } : {});
      }
      return Promise.all(frameIds.map(function (frameId) {
        return call({ frameId: frameId });
      })).then(function (lists) {
        return Array.prototype.concat.apply([], lists);
      });
    }

    // What a frame's awaited result settles to, told under the job's token
    // and the frame's id, which may come before or after the engine reports
    // the frame pending. The token is this page's own, as every extension
    // page hears every frame's answer.
    var settling = {};
    var nextToken = 1;
    var tokenPrefix = "s" + Math.random().toString(36).slice(2) + "-";

    function newSettleToken() {
      return tokenPrefix + nextToken++;
    }

    // Settles as the frame's answer, or as a failure once the frame's
    // document goes, by navigation or the tab's closing, before it answers.
    function awaitSettled(key, tabId, frameId) {
      var entry = settlement(key);
      var nav = native.webNavigation && native.webNavigation.onCommitted;
      var removed = native.tabs && native.tabs.onRemoved;
      function gone(details) {
        // A commit in the top frame replaces every frame of the tab.
        if (details && details.tabId === tabId && (details.frameId === frameId || details.frameId === 0)) {
          entry.resolve({ failed: true, error: "The frame was removed before its script finished." });
        }
      }
      function closed(id) {
        if (id === tabId) {
          entry.resolve({ failed: true, error: "The tab was closed before its script finished." });
        }
      }
      if (nav) {
        nav.addListener(gone);
      }
      if (removed) {
        removed.addListener(closed);
      }
      return entry.promise.then(function (message) {
        delete settling[key];
        if (nav) {
          nav.removeListener(gone);
        }
        if (removed) {
          removed.removeListener(closed);
        }
        return message;
      });
    }

    function settlement(key) {
      if (!settling[key]) {
        var entry = {};
        entry.promise = new Promise(function (resolve) {
          entry.resolve = resolve;
        });
        settling[key] = entry;
      }
      return settling[key];
    }

    native.runtime.onMessage.addListener(function (message) {
      if (isInternal(message) && message.__wex === "settled" &&
          String(message.token).indexOf(tokenPrefix) === 0) {
        settlement(message.token + ":" + message.frameId).resolve(message);
      }
      return undefined;
    });

    // One entry per frame that ran the job: what the bridge reported, or
    // null where the extension's code threw, as the engine gives it. A frame
    // whose awaited result was pending gives what it settled to, or null
    // where it was rejected; for a job that reports errors, the rejection's
    // message as `error`.
    function run(tabId, job, where) {
      job.bridge = extUrl(BRIDGE_FILE);
      job.base = baseURI;
      var details = copy(where, ["frameId", "allFrames", "matchAboutBlank", "runAt"]);
      details.code = codeFor(job);
      return native.tabs.executeScript(tabId, details).then(function (results) {
        return Promise.all((results || []).map(function (r) {
          if (!r || !r.settle) {
            return r;
          }
          return awaitSettled(r.settle + ":" + r.frameId, tabId, r.frameId).then(function (message) {
            if (message.failed) {
              return job.reportErrors ? { frameId: r.frameId, error: message.error } : null;
            }
            return { frameId: r.frameId, result: message.result };
          });
        }));
      });
    }

    function legacyArguments(id, details, cb) {
      if (typeof id === "object" && id !== null) {
        return { id: null, details: id, cb: details };
      }
      return { id: id, details: details || {}, cb: cb };
    }

    function legacyStyle(method) {
      return function (id, details, cb) {
        var a = legacyArguments(id, details, cb);
        return settle(tabIdOr(a.id).then(function (tabId) {
          var d = copy(a.details, ["code", "frameId", "allFrames", "matchAboutBlank",
            "runAt", "cssOrigin"]);
          if (a.details.file) {
            d.file = bundlePath(a.details.file);
          }
          return native.tabs[method](tabId, d);
        }), a.cb);
      };
    }

    // The engine's errors are Safari's; a Chrome build gives Chrome's
    // (extensions/browser/scripting_utils.cc), and a Firefox build names a
    // missing tab as Firefox does.
    // A page no extension can reach has a message of its own in Chrome, by
    // what the page is: another extension's page, or one of the browser's.
    function unreachablePage(url) {
      var u = String(url || "");
      if (/^safari-extension:/i.test(u)) {
        return u.indexOf(WEX.origin) === 0 ? null :
          "Cannot access a chrome-extension:// URL of different extension";
      }
      if (u && !/^(https?|file|data|blob|about):/i.test(u)) {
        return "Cannot access a chrome:// URL";
      }
      return null;
    }

    function chromeErrors(target) {
      return function (error) {
        var message = String(error && error.message || error);
        if (CONFIG.firefoxBuild && message === "No tab with this id.") {
          message = "Invalid tab ID: " + target.tabId;
        }
        if (!CONFIG.firefoxBuild) {
          var frameIds = target.frameIds || [];
          if (message === "No tab with this id.") {
            message = "No tab with id: " + target.tabId;
          } else if (message === "No frame with this id." && frameIds.length) {
            message = "No frame with id " + frameIds[0] + " in tab with id " + target.tabId;
          } else if (message === "The extension has no access to this frame.") {
            message = "Cannot access contents of the page. Extension manifest must request " +
              "permission to access the respective host.";
            if (!frameIds.length && native.tabs && typeof native.tabs.get === "function") {
              var general = message;
              return Promise.resolve(native.tabs.get(target.tabId)).then(function (tab) {
                return unreachablePage(tab && tab.url) || general;
              }, function () {
                return general;
              }).then(function (chosen) {
                throw new Error(chosen);
              });
            }
          } else if (/^Cannot access contents of url ".*"\.$/.test(message)) {
            message += " Extension manifest must request permission to access this host.";
          }
        }
        throw new Error(message);
      };
    }

    // A frame whose code threw cannot be named, and is left out.
    function injectionResults(tabId, results) {
      return results.filter(Boolean).map(function (result) {
        if (!CONFIG.firefoxBuild) {
          result.documentId = documentIdFor(tabId, result.frameId);
          if (result.error === undefined && result.result === undefined) {
            result.result = null;
          }
        }
        return result;
      });
    }

    // The page's own world is the engine's to reach. The documents a call
    // names go to it as frames, as the ids are this runtime's.
    function inPageWorld(tabId, d, target) {
      var call = { target: { tabId: tabId }, world: "MAIN" };
      var frameIds = targetFrames(tabId, target);
      if (frameIds) {
        call.target.frameIds = frameIds;
      } else if (target.allFrames) {
        call.target.allFrames = true;
      }
      if (d.files) {
        call.files = d.files.map(bundlePath);
      }
      var func = d.func || d["function"];
      if (func) {
        call.func = func;
        call.args = d.args || [];
      }
      if (d.injectImmediately) {
        call.injectImmediately = true;
      }
      return native.scripting.executeScript(call).then(function (results) {
        return injectionResults(tabId, results);
      });
    }

    function scriptingStyle(method) {
      return function (details, cb) {
        var d = details || {};
        var target = d.target || {};
        var sheets = (d.files || []).map(function (file) {
          return { file: bundlePath(file) };
        });
        if (d.css != null) {
          sheets.push({ code: String(d.css) });
        }
        return settle(tabIdOr(target.tabId).then(function (tabId) {
          return eachTarget(tabId, target, function (where) {
            return Promise.all(sheets.map(function (sheet) {
              var one = copy(where, ["frameId", "allFrames"]);
              one.cssOrigin = String(d.origin || "author").toLowerCase();
              if (sheet.file) {
                one.file = sheet.file;
              } else {
                one.code = sheet.code;
              }
              return native.tabs[method](tabId, one);
            }));
          });
        }).then(function () {
          return undefined;
        }, chromeErrors(target)), cb);
      };
    }

    return {
      tabs: {
        // Firefox's waits for a promise the code gives, and fails with what
        // the code throws or the promise rejects with; Chrome's gives the
        // promise as it is, and null for a frame whose code throws.
        executeScript: function (id, details, cb) {
          var a = legacyArguments(id, details, cb);
          return settle(tabIdOr(a.id).then(function (tabId) {
            var d = a.details;
            var refused = legacyScriptError(d);
            if (refused) {
              throw new Error(refused);
            }
            var job = {
              sources: d.file ? [source(d.file)] : [{ code: String(d.code || "") }]
            };
            if (CONFIG.firefoxBuild) {
              job.settle = newSettleToken();
              job.reportErrors = true;
            }
            if (d.runAt == null && d.run_at != null) {
              d.runAt = d.run_at;
            }
            return run(tabId, job, d);
          }).then(function (results) {
            var failed = results.filter(function (r) {
              return r && r.error != null;
            })[0];
            if (failed) {
              throw new Error(failed.error);
            }
            return results.map(function (r) {
              return r && (r.result !== undefined || CONFIG.firefoxBuild) ? r.result : null;
            });
          }).then(null, chromeErrors({ tabId: a.id })), a.cb);
        },
        insertCSS: legacyStyle("insertCSS"),
        removeCSS: legacyStyle("removeCSS")
      },

      scripting: {
        executeScript: function (details, cb) {
          var d = details || {};
          var target = d.target || {};
          return settle(tabIdOr(target.tabId).then(function (tabId) {
            if (d.world === "MAIN") {
              return inPageWorld(tabId, d, target);
            }
            var job = {
              sources: (d.files || []).map(scriptingSource),
              settle: newSettleToken(),
              // Chrome runs every file it is given whatever an earlier one
              // does; Firefox stops at the first that throws.
              independentFiles: !CONFIG.firefoxBuild
            };
            var func = d.func || d["function"];
            if (func) {
              job.func = String(func);
              job.args = d.args || [];
            }
            return eachTarget(tabId, target, function (where) {
              if (d.injectImmediately) {
                where.runAt = "document_start";
              }
              return run(tabId, job, where);
            }).then(function (results) {
              return injectionResults(tabId, results);
            });
          }).then(null, chromeErrors(target)), cb);
        },
        insertCSS: scriptingStyle("insertCSS"),
        removeCSS: scriptingStyle("removeCSS")
      },

      // Chrome's userScripts.execute. The user-script world is the content
      // scripts' here; code for the page's own world is evaluated there,
      // under the page's policy.
      userScripts: {
        execute: function (details, cb) {
          var d = details || {};
          var target = d.target || {};
          return settle(tabIdOr(target.tabId).then(function (tabId) {
            var js = Array.isArray(d.js) ? d.js : [];
            if (!js.length || js.some(function (entry) {
              return !entry || typeof entry !== "object" || (entry.code == null) === (entry.file == null);
            })) {
              throw new Error("Each script injection must specify exactly one of 'code' or 'file' as a js source.");
            }
            var sources = js.map(function (entry) {
              return entry.code != null ? { code: String(entry.code) } : scriptingSource(entry.file);
            });
            if (d.world === "MAIN") {
              return inPageWorld(tabId, {
                func: "function (codes) { var r; for (var i = 0; i < codes.length; i++) { r = (0, eval)(codes[i]); } return r; }",
                args: [sources.map(function (source) {
                  return source.code;
                })],
                injectImmediately: d.injectImmediately
              }, target);
            }
            var job = { sources: sources, settle: newSettleToken(), reportErrors: true };
            return eachTarget(tabId, target, function (where) {
              if (d.injectImmediately) {
                where.runAt = "document_start";
              }
              return run(tabId, job, where);
            }).then(function (results) {
              return injectionResults(tabId, results);
            });
          }).then(null, chromeErrors(target)), cb);
        }
      }
    };
  }
  return {
    CONFIG: CONFIG,
    Event: Event,
    done: done,
    fail: fail,
    shiftCallback: shiftCallback,
    lastError: null,
    baseURI: baseURI,
    origin: origin,
    basePath: basePath,
    extUrl: extUrl,
    isExtUrl: isExtUrl,
    extPath: extPath,
    chromeExtensionOrigin: chromeExtensionOrigin,
    learnExtensionOrigins: learnExtensionOrigins,
    webFacingText: webFacingText,
    pageFromWeb: pageFromWeb,
    openingSites: openingSites,
    installWebFacingAddresses: installWebFacingAddresses,
    webFacingWorkerScript: webFacingWorkerScript,
    WEB_ORIGIN: WEB_ORIGIN,
    WEB_ID: WEB_ID,
    compileMatch: compileMatch,
    matchesAny: matchesAny,
    describeSender: describeSender,
    globsAny: globsAny,
    tabUrlMatches: tabUrlMatches,
    asScript: asScript,
    localStorageOf: localStorageOf,
    guardedScript: guardedScript,
    commandShortcuts: commandShortcuts,
    installCommandKeys: installCommandKeys,
    adaptRegex: adaptRegex,
    readTextSync: readTextSync,
    readJsonSync: readJsonSync,
    makeI18n: makeI18n,
    localizeManifest: localizeManifest,
    installNetworkFixups: installNetworkFixups,
    installFileStatusFix: installFileStatusFix,
    installWorkerFixups: installWorkerFixups,
    installExtensionOrigin: installExtensionOrigin,
    installExtensionUrlBase: installExtensionUrlBase,
    installExtensionHostAlias: installExtensionHostAlias,
    installIdleCallback: installIdleCallback,
    recordDatabases: recordDatabases,
    installSandboxFrames: installSandboxFrames,
    forgetEarlierInstall: forgetEarlierInstall,
    installPopupCanvas: installPopupCanvas,
    bundleIdFor: bundleIdFor,
    installNetworkInformation: installNetworkInformation,
    pinRuntimeGlobals: pinRuntimeGlobals,
    namespaceShape: namespaceShape,
    NAMESPACE_SHAPE_KEY: NAMESPACE_SHAPE_KEY,
    installSvgImageFallback: installSvgImageFallback,
    installOpenInTab: installOpenInTab,
    installFileSystemFallback: installFileSystemFallback,
    installStreamFallback: installStreamFallback,
    sendFile: sendFile,
    bytesToBase64: bytesToBase64,
    native: native,
    INTERNAL_PORT: INTERNAL_PORT,
    NAMESPACES: NAMESPACES,
    safari: hostSafari,
    presentBrowser: presentBrowser,
    makeProxy: makeProxy,
    makeTestApi: makeTestApi,
    SIDE_PANEL_POPOVER: SIDE_PANEL_POPOVER,
    POPUP_PLACEHOLDER: POPUP_PLACEHOLDER,
    WORKER_RELAY: WORKER_RELAY,
    manifestAsGiven: manifestAsGiven,
    runtimeId: RUNTIME_ID,
    resultValue: CONFIG.firefoxBuild ? jsonValue : scriptValue,
    RESULT_VALUE_SOURCE: RESULT_VALUE_SOURCE,
    makeApiChecker: makeApiChecker,
    installApiChecks: installApiChecks,
    apiChecker: apiChecker,
    addSchemaEnums: addSchemaEnums,
    addNativeMessaging: addNativeMessaging,
    declares: declares,
    makeDevtools: makeDevtools,
    withSafari: withSafari,
    browserIdentity: browserIdentity,
    requestIdentity: requestIdentity,
    namespaceGranted: namespaceGranted,
    openFunctions: openFunctions,
    PROVISIONAL_TAB_ID: PROVISIONAL_TAB_ID,
    isInternal: isInternal,
    isInternalPort: isInternalPort,
    settle: settle,
    makeMessaging: makeMessaging,
    addLegacyRequests: addLegacyRequests,
    makePageDom: makePageDom,
    makePublicSuffix: makePublicSuffix,
    detectTextLanguages: detectTextLanguages,
    setLanguageDetector: setLanguageDetector,
    publicSuffixFrom: publicSuffixFrom,
    bundledSuffixRules: bundledSuffixRules,
    declarativeContentTypes: declarativeContentTypes,
    urlFilterMatches: urlFilterMatches,
    hasLegacyRequests: hasLegacyRequests,
    legacyRequest: legacyRequest,
    answerRequest: answerRequest,
    makeTabMessaging: makeTabMessaging,
    makeRemote: makeRemote,
    makeWebRequest: makeWebRequest,
    makeDeclarativeNetRequest: makeDeclarativeNetRequest,
    installResponseHeaderRules: installResponseHeaderRules,
    urlFilterRegExp: urlFilterRegExp,
    applyResponseRules: applyResponseRules,
    documentIdsKnown: function () {
      return documentIds;
    },
    learnDocumentIds: learnDocumentIds,
    makeWebNavigation: makeWebNavigation,
    makeInjection: makeInjection,
    uid: uid,
    identityRedirectURL: identityRedirectURL,
    pageRuntime: pageRuntime,
    pageRuntimeToken: PAGE_RUNTIME_TOKEN,
    openStandIn: openStandIn,
    framedPageRelay: framedPageRelay,
    pageRuntimeHost: pageRuntimeHost,
    ancestorPatterns: ancestorPatterns,
    log: log
  };
})(this);
