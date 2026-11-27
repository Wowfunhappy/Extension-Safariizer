// Turning a WebExtension into a legacy Safari .safariextension bundle.
//
// It works on trees in memory, so it runs in the Safari extension's global
// page as well as in Node.

(function (W2S) {
  "use strict";

  var bytes = W2S.bytes;
  var tree = W2S.tree;
  var pyjson = W2S.pyjson;
  var manifestModule = W2S.manifest;
  var patterns = W2S.patterns;
  var htmlpatch = W2S.htmlpatch;
  var get = manifestModule.get;

  // Where the runtime lives inside the produced bundle.
  var WEX_DIR = "wex";
  var CONFIG_JS = WEX_DIR + "/wex-config.js";
  var API_JS = WEX_DIR + "/wex-api.js";
  var CONTENT_API_JS = WEX_DIR + "/wex-content-api.js";
  var CORE_JS = WEX_DIR + "/wex-core.js";
  var GLOBAL_JS = WEX_DIR + "/wex-global.js";
  var PAGE_JS = WEX_DIR + "/wex-page.js";
  var CONTENT_JS = WEX_DIR + "/wex-content.js";
  var NETWORK_JS = WEX_DIR + "/wex-network.js";
  var RUN_START_JS = WEX_DIR + "/wex-run-start.js";
  var RUN_END_JS = WEX_DIR + "/wex-run-end.js";
  // What Safari injects at document start ahead of the extension's own
  // scripts: the files above that the content bridge runs, as one (writeBridge).
  var BRIDGE_JS = WEX_DIR + "/wex-bridge.js";
  var DEVTOOLS_JS = WEX_DIR + "/wex-devtools.js";
  var DEVTOOLS_RELAY = WEX_DIR + "/wex-devtools-relay.html";
  var DEVTOOLS_WINDOW = WEX_DIR + "/wex-devtools-window.html";
  // The page the runtime opens in a hidden tab to save a download.
  var DOWNLOAD_PAGE = WEX_DIR + "/wex-download.html";
  // Loaded after the runtime and before the background's own scripts: binds
  // the name `safari` for them (backgroundGlobals).
  var BACKGROUND_GLOBALS_JS = WEX_DIR + "/wex-background-globals.js";
  // The blank page the popup's popover rests on while it is hidden; the
  // runtime has it show the popup when it opens.
  var POPUP_PLACEHOLDER = WEX_DIR + "/wex-popover.html";
  // Run in the page's world after each script the extension registers for
  // it: counts the runs in the document and announces each, for the content
  // scripts registered after it to wait for (the runtime's waitForPageWorld).
  var PAGE_WORLD_RAN = WEX_DIR + "/wex-page-world-ran.js";

  function pageWorldRan(bundleId) {
    var ran = JSON.stringify("wex-page-world-ran:" + bundleId);
    var ask = JSON.stringify("wex-page-world-ask:" + bundleId);
    return "(function (d) {\n" +
      "  var counted = new CustomEvent(" + ran + ", { cancelable: true });\n" +
      "  d.dispatchEvent(counted);\n" +
      "  if (!counted.defaultPrevented) {\n" +
      "    var count = 1;\n" +
      "    d.addEventListener(" + ran + ", function (e) {\n" +
      "      if (e.cancelable) {\n" +
      "        count += 1;\n" +
      "        e.preventDefault();\n" +
      "      }\n" +
      "    }, true);\n" +
      "    d.addEventListener(" + ask + ", function (e) {\n" +
      "      if (count >= e.detail) {\n" +
      "        e.preventDefault();\n" +
      "      }\n" +
      "    }, true);\n" +
      "  }\n" +
      "  d.dispatchEvent(new CustomEvent(" + ran + "));\n" +
      "})(document);\n";
  }

  var RUNTIME_FILES = ["wex-core.js", "wex-global.js", "wex-page.js", "wex-content.js",
                       "wex-run-start.js", "wex-run-end.js", "wex-network.js", "wex-devtools.js",
                       "wex-download.js", "wex-worker-relay.js"];

  // What the converter reads from the runtime's directory: the schemas of
  // Chrome's API (tools/update-chrome-api.js) and the enums of Firefox's
  // (tools/update-firefox-api.js), and, which a bundle for Chrome carries for
  // the runtime to read when a call needs them, the Public Suffix List's
  // rules (tools/update-public-suffix.js) and Chrome's permission warnings
  // (tools/update-permission-messages.js); and, which every bundle carries,
  // Chrome's language detector, with what loading it needs and its licence
  // (tools/update-language-detector.js).
  var RUNTIME_DATA = ["chrome-api.json", "firefox-api.json", "public-suffix-list.txt",
                      "permission-messages.json", "cld3.wasm", "cld3.json", "cld3-LICENSE.txt"];
  var CHROME_DATA = ["public-suffix-list.txt", "permission-messages.json"];
  var BUNDLE_DATA = ["cld3.wasm", "cld3.json", "cld3-LICENSE.txt"];

  var GENERATED_GLOBAL_PAGE = "wex-global-page.html";

  var POPOVER_ID = "wex-popover";
  var TOOLBAR_ID = "wex-toolbar";
  var ACTION_COMMAND = "wex-action";

  // Version strings Safari's Extension Builder writes into a Safari 7-era
  // bundle.
  var BUILDER_VERSION = "9537.78.2";
  var INFO_DICTIONARY_VERSION = "1.0";
  var DATABASE_QUOTA = 104857600;

  var SKIP_TOP_LEVEL = { "META-INF": true, "_metadata": true, "__MACOSX": true };

  function ConversionError(message) {
    var error = new Error(message);
    error.name = "ConversionError";
    return error;
  }

  function plural(count, one, many) {
    return count === 1 ? one : many;
  }

  // The path from directory `from` to `to`, both relative to the bundle.
  var relpath = tree.relpath;

  function escape(value) {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // -- unpacking ------------------------------------------------------- //

  // The directory holding manifest.json, which is not always the top one.
  function findManifestRoot(files) {
    if (files.isFile("manifest.json")) {
      return "";
    }
    var best = null;
    var bestDepth = null;
    files.walk("", SKIP_TOP_LEVEL).forEach(function (entry) {
      if (entry.files.indexOf("manifest.json") >= 0) {
        var depth = entry.dir ? entry.dir.split("/").length : 1;
        if (bestDepth === null || depth < bestDepth) {
          best = entry.dir;
          bestDepth = depth;
        }
      }
    });
    if (best === null) {
      throw ConversionError("no manifest.json found in the extension");
    }
    return best;
  }

  // -- copying --------------------------------------------------------- //

  function copyTree(source) {
    var bundle = new tree.Tree();
    source.paths().forEach(function (path) {
      var top = path.split("/")[0];
      if (Object.prototype.hasOwnProperty.call(SKIP_TOP_LEVEL, top) || top.charAt(0) === ".") {
        return;
      }
      bundle.write(path, source.read(path));
    });
    return bundle;
  }

  // Gives the engine the website access a permission implies in Chrome. The
  // engine takes an extension's access to websites from the manifest in the
  // bundle. In Chrome `tabs` shows the address of every tab and `activeTab`
  // lets the extension into whatever site the user is on; the engine allows
  // either only with access to every site, so the bundle's manifest asks for
  // it. The extension is still shown its own manifest.
  function grantEverySite(mf, data, bundle, notes) {
    if (!mf.reachesEverySite() || patterns.hostPatterns(data).some(patterns.isAllUrls)) {
      return;
    }
    var key = mf.version >= 3 ? "host_permissions" : "permissions";
    var granted = {};
    Object.keys(data).forEach(function (name) { granted[name] = data[name]; });
    granted[key] = patterns.list(manifestModule.or(get(data, key), [])).concat(["<all_urls>"]);
    bundle.write("manifest.json", bytes.utf8(pyjson.dumps(granted) + "\n"));
    notes.push("the bundle's manifest asks for access to every site, which the engine " +
               "requires for what the tabs and activeTab permissions allow in Chrome");
  }

  // Drops the declared pixel density from every PNG in the bundle. An
  // extension may set its toolbar image at runtime, which hands Safari one of
  // the extension's own PNGs, and Safari reads the size of a toolbar image
  // from the density the file declares.
  function dropPngDensity(bundle) {
    var changed = 0;
    bundle.paths().forEach(function (path) {
      if (!/\.png$/.test(path.toLowerCase())) {
        return;
      }
      var stripped = W2S.png.stripDensity(bundle.read(path));
      if (stripped) {
        bundle.write(path, stripped);
        changed++;
      }
    });
    return changed;
  }

  // Makes every file in the bundle one Safari 7 can serve. Safari crashes when
  // it loads a bundle file whose name has no extension, and serves a
  // zero-byte file as a directory. Returns the map of renamed files and the
  // number of empty files filled.
  function fitToSafari(bundle) {
    var renamed = Object.create(null);
    var filled = 0;
    bundle.walk("").forEach(function (entry) {
      var taken = Object.create(null);
      entry.files.forEach(function (name) { taken[tree.fold(name)] = true; });
      entry.files.forEach(function (name) {
        var path = tree.join(entry.dir, name);
        if (name.replace(/^\.+/, "").indexOf(".") < 0) {
          var candidate = name + ".txt";
          while (taken[tree.fold(candidate)]) {
            candidate = "_" + candidate;
          }
          taken[tree.fold(candidate)] = true;
          var target = tree.join(entry.dir, candidate);
          bundle.rename(path, target);
          renamed[path] = target;
          path = target;
        }
        if (bundle.read(path).length === 0) {
          var empty = /\.(js|css)$/.test(path.toLowerCase()) ? "/* */\n" : "\n";
          bundle.write(path, bytes.utf8(empty));
          filled++;
        }
      });
    });
    return { renamed: renamed, filled: filled };
  }

  // A folder Safari refuses to install a bundle with at its top level, in
  // any case.
  var RESERVED_FOLDER = "resources";

  // Renames a top-level `resources` folder, which Safari will not install.
  // Returns a map from each file's path in it to its new one, with the
  // folder's name and its new one; or an empty map and nulls.
  function renameReservedFolder(bundle) {
    var top = bundle.list("");
    var entry = top.dirs.filter(function (name) {
      return name.toLowerCase() === RESERVED_FOLDER;
    })[0];
    var renamed = Object.create(null);
    if (!entry) {
      return { renamed: renamed, name: null, renamedTo: null };
    }
    var taken = top.dirs.concat(top.files).map(function (name) { return name.toLowerCase(); });
    var next = entry + "_";
    while (taken.indexOf(next.toLowerCase()) >= 0) {
      next += "_";
    }
    bundle.renameDir(entry, next).forEach(function (pair) {
      renamed[entry + pair[1].slice(next.length)] = pair[1];
    });
    return { renamed: renamed, name: entry, renamedTo: next };
  }

  // Manifest keys that hold text or identifiers, never a path, though the
  // text may read like one.
  var MANIFEST_TEXT_KEYS = ["name", "short_name", "description", "author", "version", "version_name",
    "homepage_url", "update_url", "key", "id", "default_title", "default_locale"];

  // The new name of the renamed file that `path` names, in any case, or null.
  function renamedPath(renamed, path) {
    var key = tree.normalize(path);
    if (key === null) {
      return null;
    }
    var folded = tree.fold(key);
    var names = Object.keys(renamed);
    for (var i = 0; i < names.length; i++) {
      if (tree.fold(names[i]) === folded) {
        return renamed[names[i]];
      }
    }
    return null;
  }

  // Adds to the bundle's manifest the name each renamed file now has, beside
  // the name the extension's web_accessible_resources gives it, or a pattern
  // that covers it: the engine goes by the bundle's manifest to tell what a
  // site may load.
  function listRenamedWebResources(bundle, renamed) {
    var data = manifestModule.load(bundle.read("manifest.json"));
    var resources = data.web_accessible_resources;
    if (!Array.isArray(resources)) {
      return;
    }
    function added(globs) {
      var rules = globs.map(function (glob) {
        var parts = String(glob).replace(/^\/+/, "").split("*").map(function (part) {
          return part.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
        });
        return new RegExp("^" + parts.join(".*") + "$");
      });
      var out = [];
      Object.keys(renamed).forEach(function (path) {
        var target = renamed[path];
        if (globs.indexOf(target) < 0 && out.indexOf(target) < 0 && rules.some(function (rule) {
          return rule.test(path) && !rule.test(target);
        })) {
          out.push(target);
        }
      });
      return out;
    }
    var changed = false;
    data.web_accessible_resources = resources.some(function (entry) {
      return typeof entry === "string";
    }) ? (function () {
      var more = added(resources);
      changed = more.length > 0;
      return resources.concat(more);
    })() : resources.map(function (entry) {
      if (!entry || !Array.isArray(entry.resources)) {
        return entry;
      }
      var more = added(entry.resources);
      if (!more.length) {
        return entry;
      }
      changed = true;
      var copy = {};
      Object.keys(entry).forEach(function (key) {
        copy[key] = entry[key];
      });
      copy.resources = entry.resources.concat(more);
      return copy;
    });
    if (changed) {
      bundle.write("manifest.json", bytes.utf8(pyjson.dumps(data) + "\n"));
    }
  }

  // The manifest value with its paths into folder `from` pointing into `to`.
  function renamedManifestPaths(value, from, to) {
    if (Array.isArray(value)) {
      return value.map(function (item) { return renamedManifestPaths(item, from, to); });
    }
    if (pyjson.isPlainObject(value)) {
      var out = Object.create(null);
      Object.keys(value).forEach(function (key) {
        out[key] = MANIFEST_TEXT_KEYS.indexOf(key) >= 0 ? value[key] : renamedManifestPaths(value[key], from, to);
      });
      return out;
    }
    if (typeof value === "string") {
      var match = /^(\/?)([^\/]+)(\/[\s\S]*)$/.exec(value);
      if (match && match[2].toLowerCase() === from.toLowerCase()) {
        return match[1] + to + match[3];
      }
    }
    return value;
  }

  // Points the stylesheets' url() references at renamed files' new names.
  function renameCssReferences(bundle, renamed) {
    var count = 0;
    bundle.walk("").forEach(function (entry) {
      entry.files.forEach(function (name) {
        if (!/\.css$/i.test(name)) {
          return;
        }
        var path = tree.join(entry.dir, name);
        var decoded = bytes.decodeKeepingEncoding(bundle.read(path));
        var adapted = decoded.text.replace(W2S.svg.TOKENS, function (all, double, single, bare) {
          var value = double !== undefined ? double : single !== undefined ? single : bare;
          var next = value !== undefined
            ? W2S.javascript.renamedReference(value.trim(), entry.dir, renamed) : null;
          if (!next) {
            return all;
          }
          count++;
          return 'url("' + next + '")';
        });
        if (adapted !== decoded.text) {
          bundle.write(path, decoded.encode(adapted));
        }
      });
    });
    return count;
  }

  // A browser fills in the __MSG_name__ references of an extension's style
  // sheets as it serves them, in the language of its interface, as
  // i18n.getMessage gives them; Safari serves a bundle's files as they are,
  // so the converter fills them in, in the language of the browser it runs
  // in. An address of the extension's own, "chrome-extension://" and its id,
  // becomes one relative to the style sheet, which reaches the same file from
  // an extension page and from a page a content script styles.
  var RTL_LANGUAGES = ["ar", "ckb", "dv", "fa", "he", "iw", "ps", "sd", "ug", "ur", "yi"];

  function localizeStylesheets(bundle, catalogues, defaultLocale, runtimeId) {
    // The language as Chrome writes it ("pt_BR"), as the runtime gives it:
    // Safari gives it in lowercase ("pt-br").
    var locale = String((typeof navigator !== "undefined" && navigator.language) || "en")
      .split("-").map(function (part, i) {
        if (i === 0) {
          return part.toLowerCase();
        }
        if (part.length === 2) {
          return part.toUpperCase();
        }
        return part.length === 4 ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() : part;
      }).join("_");
    var lang = locale.split("_")[0];
    var rtl = RTL_LANGUAGES.indexOf(lang) >= 0;
    catalogues = catalogues || {};
    var names = Object.keys(catalogues);
    var messages = null;
    // A locale's folder may be named in any case ("pt_br").
    [locale, lang, defaultLocale, "en"].concat(names.filter(function (name) {
      return name.split("_")[0] === lang;
    })).forEach(function (wanted) {
      for (var i = 0; !messages && wanted && i < names.length; i++) {
        if (names[i].toLowerCase() === String(wanted).toLowerCase()) {
          messages = catalogues[names[i]];
        }
      }
    });
    messages = messages || {};
    var predefined = {
      "@@extension_id": runtimeId,
      "@@ui_locale": locale,
      "@@bidi_dir": rtl ? "rtl" : "ltr",
      "@@bidi_reversed_dir": rtl ? "ltr" : "rtl",
      "@@bidi_start_edge": rtl ? "right" : "left",
      "@@bidi_end_edge": rtl ? "left" : "right"
    };
    function message(name) {
      var lowered = name.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(predefined, lowered)) {
        return predefined[lowered];
      }
      var keys = Object.keys(messages);
      for (var i = 0; i < keys.length; i++) {
        var entry = messages[keys[i]];
        if (keys[i].toLowerCase() === lowered && entry && typeof entry.message === "string") {
          return entry.message.replace(/\$\$/g, "$");
        }
      }
      return null;
    }
    var count = 0;
    bundle.walk("").forEach(function (entry) {
      entry.files.forEach(function (name) {
        if (!/\.css$/i.test(name)) {
          return;
        }
        var path = tree.join(entry.dir, name);
        var decoded = bytes.decodeKeepingEncoding(bundle.read(path));
        if (decoded.text.indexOf("__MSG_") < 0) {
          return;
        }
        var depth = entry.dir ? entry.dir.split("/").length : 0;
        var toRoot = depth ? new Array(depth + 1).join("../") : "./";
        var adapted = decoded.text
          .replace(/(?:chrome|moz)-extension:\/\/__MSG_@@extension_id__\//gi, toRoot)
          .replace(/__MSG_([A-Za-z0-9_@]+)__/g, function (all, name) {
            var text = message(name);
            return text === null ? all : text;
          });
        if (adapted !== decoded.text) {
          count++;
          bundle.write(path, decoded.encode(adapted));
        }
      });
    });
    return count;
  }

  // Gives each .mjs file a name Safari serves as JavaScript. Safari gives a
  // MIME type to .html, .js and .png files alone, and refuses a module
  // script that has none. Returns a map from each renamed file's path to its
  // new one.
  function serveModulesAsScripts(bundle) {
    var renamed = Object.create(null);
    bundle.walk("").forEach(function (entry) {
      var taken = Object.create(null);
      entry.files.forEach(function (name) { taken[tree.fold(name)] = true; });
      entry.files.forEach(function (name) {
        if (!/\.mjs$/.test(name)) {
          return;
        }
        var candidate = name + ".js";
        while (taken[tree.fold(candidate)]) {
          candidate = "_" + candidate;
        }
        taken[tree.fold(candidate)] = true;
        var path = tree.join(entry.dir, name);
        var target = tree.join(entry.dir, candidate);
        bundle.rename(path, target);
        renamed[path] = target;
      });
    });
    return renamed;
  }

  // An HTML attribute that names a file the page loads.
  var HTML_REFERENCE = /(\b(?:src|href)\s*=\s*)(["'])([^"'<>]*)\2/gi;

  // Points the pages' src and href attributes at renamed files' new names.
  function renameHtmlReferences(bundle, renamed) {
    var count = 0;
    bundle.walk("").forEach(function (entry) {
      entry.files.forEach(function (name) {
        if (!/\.html?$/i.test(name)) {
          return;
        }
        var path = tree.join(entry.dir, name);
        var decoded = bytes.decodeKeepingEncoding(bundle.read(path));
        var adapted = decoded.text.replace(HTML_REFERENCE, function (all, lead, quote, value) {
          var next = W2S.javascript.renamedReference(value, entry.dir, renamed);
          if (next === null) {
            return all;
          }
          count++;
          return lead + quote + next + quote;
        });
        if (adapted !== decoded.text) {
          bundle.write(path, decoded.encode(adapted));
        }
      });
    });
    return count;
  }

  // The content scripts the manifest declares, injected by Safari itself
  // rather than read by the bridge with a synchronous request in every frame
  // they apply to, which holds up the page while the browser serves it. Each
  // file of a group gets a copy in wex/content/<group>/ that runs where the
  // bridge says the group applies, once per document (the runtime's
  // guardedScript, which keeps its top-level declarations for the scripts
  // after it). A file the scanner cannot follow is left to the bridge, which
  // runs ahead of the copies of its phase. So that a phase keeps the
  // manifest's order, every file before the last one left to the bridge is
  // left to it as well. A group for the page's own world is the engine's
  // (pageWorldScripts).
  function injectContentScripts(bundle, groups, runtime) {
    var out = { start: [], end: [], injected: {}, count: 0 };
    var core = runtime && runtime["wex-core.js"];
    if (!core) {
      return out;
    }
    var coreText = typeof core === "string" ? core : bytes.decodeKeepingEncoding(core).text;
    var guardedScript = new Function(coreText + "\n;return WEX.guardedScript;").call({ WEX_CONFIG: {} });
    var phases = { start: [], end: [] };
    groups.forEach(function (group, n) {
      var phase = (group.run_at || "document_idle") === "document_start" ? phases.start : phases.end;
      (group.world === "MAIN" ? [] : group.js || []).forEach(function (file, i) {
        var path = String(file).replace(/^\/+/, "");
        if (!bundle.isFile(path)) {
          return;
        }
        var entry = { n: n, i: i, path: path, decoded: bytes.decodeKeepingEncoding(bundle.read(path)) };
        entry.guarded = guardedScript(entry.decoded.text,
          "typeof WEXContent !== \"undefined\" && WEXContent && WEXContent.applies(" + n + ", " + i + ")");
        phase.push(entry);
      });
    });
    ["start", "end"].forEach(function (name) {
      var firstCopy = 0;
      phases[name].forEach(function (entry, at) {
        if (entry.guarded === null) {
          firstCopy = at + 1;
        }
      });
      phases[name].slice(firstCopy).forEach(function (entry) {
        var copy = WEX_DIR + "/content/" + entry.n + "/" + entry.path;
        bundle.write(copy, entry.decoded.encode(entry.guarded));
        out[name].push(copy);
        out.injected[entry.n + ":" + entry.i] = true;
        out.count += 1;
      });
    });
    return out;
  }

  // The scripts for web pages' own world, which the global page registers
  // with the engine (scripting.registerContentScripts, world "MAIN") so that
  // they run as a page's own scripts start, whatever its policy: the
  // manifest's groups for that world, and what the runtime puts there
  // (WEX.openStandIn, WEX.ancestorPatterns, WEX.pageRuntime), written into
  // the bundle with what they need of the bundle, as the engine takes
  // scripts as files. A group with globs runs from a copy that asks first
  // whether they let it run.
  function pageWorldScripts(bundle, config, groups, runtime, bundleId, pagePatterns) {
    var specs = [];
    var core = runtime && runtime["wex-core.js"];
    if (!core) {
      return specs;
    }
    var coreText = typeof core === "string" ? core : bytes.decodeKeepingEncoding(core).text;
    var wex = new Function(coreText + "\n;return WEX;").call({ WEX_CONFIG: config });
    var regExpSource = function (glob) {
      return "^" + String(glob).replace(/[.+^${}()|[\]\\\/]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$";
    };
    groups.forEach(function (group, n) {
      if (group.world !== "MAIN" || !(group.js || []).length) {
        return;
      }
      var js = group.js.map(function (file) {
        return String(file).replace(/^\/+/, "");
      }).filter(function (path) {
        return bundle.isFile(path);
      });
      var include = group.include_globs || [];
      var exclude = group.exclude_globs || [];
      if (include.length || exclude.length) {
        var anyOf = function (globs) {
          return JSON.stringify(globs.map(regExpSource)) + ".some(function (s) { return new RegExp(s).test(location.href); })";
        };
        var condition = (include.length ? anyOf(include) : "true") + " && !" + anyOf(exclude);
        js = js.map(function (path) {
          var decoded = bytes.decodeKeepingEncoding(bundle.read(path));
          var guarded = wex.guardedScript(decoded.text, condition);
          if (guarded === null) {
            return path;
          }
          var copy = WEX_DIR + "/main/" + n + "/" + path;
          bundle.write(copy, decoded.encode(guarded));
          return copy;
        });
      }
      specs.push({ id: "wex.main." + n, matches: group.matches || [], excludeMatches: group.exclude_matches || [],
        js: js, allFrames: !!group.all_frames, runAt: group.run_at || "document_idle",
        matchOriginAsFallback: !!(group.match_about_blank || group.match_origin_as_fallback) });
    });
    var web = config.webOrigin || config.sourceOrigin;
    var parts = [];
    if (web && wex.openingSites().length) {
      parts.push("(" + wex.openStandIn + ")(" + JSON.stringify(web.toLowerCase() + "/") + ", " +
        JSON.stringify("wex-open:" + web) + ");");
    }
    if (web && /^chrome-extension:/.test(web)) {
      // A frame of one of the extension's pages, whose Safari origin is the
      // bundle's identifier and the team of the certificate that signs it.
      var own = new RegExp("^safari-extension://" + regExpSource(bundleId).slice(1, -1) + "-[^/]+$", "i");
      parts.push("(function (ancestorPatterns) {\n" +
        "  var ancestors;\n" +
        "  try { ancestors = window.top === window ? null : location.ancestorOrigins; } catch (e) { return; }\n" +
        "  for (var i = 0; ancestors && i < ancestors.length; i++) {\n" +
        "    if (" + own + ".test(String(ancestors[i]))) {\n" +
        "      ancestorPatterns(String(ancestors[i]).toLowerCase(), " + JSON.stringify(web) + ");\n" +
        "      return;\n" +
        "    }\n" +
        "  }\n" +
        "})(" + wex.ancestorPatterns + ");");
    }
    if (parts.length && config.bridgeWhitelist) {
      bundle.write(WEX_DIR + "/page-world.js", bytes.utf8("// Generated by webext2safari.\n" + parts.join("\n") + "\n"));
      specs.push({ id: "wex.page-world", matches: config.bridgeWhitelist, js: [WEX_DIR + "/page-world.js"],
        allFrames: true, runAt: "document_start" });
    }
    if (pagePatterns.length) {
      bundle.write(WEX_DIR + "/page-runtime.js", bytes.utf8("// Generated by webext2safari.\n(" + wex.pageRuntime + ")(" +
        JSON.stringify(wex.pageRuntimeToken) + ", " + JSON.stringify(wex.runtimeId) + ");\n"));
      specs.push({ id: "wex.page-runtime", matches: pagePatterns, js: [WEX_DIR + "/page-runtime.js"],
        allFrames: true, runAt: "document_start" });
    }
    return specs;
  }

  // The catalogues the config carries, each as the text of its JSON: every
  // frame of every page the bridge goes into evaluates the config, and a
  // string is read far faster than the objects it describes, which i18n
  // parses on first use. With the browser's language known, only the
  // catalogues the runtime picks for it are carried (as localeCandidates in
  // the runtime orders them); the runtime reads another from its file.
  function embeddedLocaleMessages(catalogues, available, defaultLocale, language) {
    var names = Object.keys(catalogues);
    if (language) {
      var full = String(language).replace(/-/g, "_");
      var lang = full.split("_")[0];
      var lower = function (name) {
        return String(name || "").toLowerCase();
      };
      names = names.filter(function (name) {
        return lower(name) === lower(full) || lower(name) === lower(lang) ||
          name === defaultLocale || name === "en" || lower(name.split("_")[0]) === lower(lang);
      });
    }
    var out = {};
    names.forEach(function (name) {
      out[name] = JSON.stringify(catalogues[name]);
    });
    return out;
  }

  // -- generated files ------------------------------------------------- //

  // ASCII, as the runtime is: a page that names no charset reads its
  // scripts as Latin-1.
  function writeConfig(bundle, config) {
    bundle.write(CONFIG_JS, bytes.utf8(
      "// Generated by webext2safari. Describes this bundle to the runtime\n" +
      "// layer; every context reads it before anything else runs.\n" +
      "var WEX_CONFIG = " + pyjson.dumps(config, true) + ";\n"));
  }

  // The schemas Chrome checks the extension's calls against, for the
  // namespaces a context of the extension can have: those whose permission or
  // manifest key the extension has, and the namespaces their types come from.
  function apiSubset(api, manifest, forContent, testApi) {
    var declared = [].concat(get(manifest, "permissions") || [], get(manifest, "optional_permissions") || []);
    var chosen = {};
    function add(ns) {
      if (chosen[ns] || !api[ns]) {
        return;
      }
      var entry = api[ns];
      chosen[ns] = {};
      ["functions", "types", "properties", "constants"].forEach(function (key) {
        if (entry[key]) {
          chosen[ns][key] = entry[key];
        }
      });
      (entry.uses || []).forEach(add);
    }
    Object.keys(api).sort().forEach(function (ns) {
      var entry = api[ns];
      if ((ns === "test" && !testApi) || (forContent && !entry.content) ||
          (entry.manifestKeys && !entry.manifestKeys.some(function (k) { return get(manifest, k) != null; }))) {
        return;
      }
      if (entry.permissions && !entry.permissions.some(function (p) { return declared.indexOf(p) >= 0; })) {
        // The functions an extension has without the permission.
        if (entry.openFunctions && !chosen[ns]) {
          add(ns);
          chosen[ns].functions = (entry.functions || []).filter(function (fn) {
            return entry.openFunctions.indexOf(fn.name) >= 0;
          });
        }
        return;
      }
      add(ns);
    });
    return chosen;
  }

  function asciiJson(value) {
    return JSON.stringify(value).replace(/[\u0080-\uffff]/g, function (c) {
      return "\\u" + ("000" + c.charCodeAt(0).toString(16)).slice(-4);
    });
  }

  // A Firefox build gets Firefox's enums, and no schemas to check its calls
  // against.
  function writeApi(bundle, apiData, manifest, firefox, testApi) {
    var api = apiData ? JSON.parse(bytes.text(apiData)) : null;
    [[API_JS, false], [CONTENT_API_JS, true]].forEach(function (file) {
      bundle.write(file[0], bytes.utf8(
        "// Generated by webext2safari. The schemas of the API this extension's\n" +
        "// browser gives it" + (file[1] ? ", as JSON text, which a frame reads only once it\n" +
          "// makes the content script's chrome.\n" : ".\n") +
        (file[1] ?
          "var WEX_API_JSON = " + (api ? JSON.stringify(asciiJson(apiSubset(api, manifest, true, testApi))) : "null") :
          "var WEX_API = " + (api ? asciiJson(apiSubset(api, manifest, false, testApi)) : "null")) + ";\n"));
    });
  }

  // Safari's engine does work for each file an extension injects, in every
  // frame of every page, for every extension, whether or not the file then
  // runs there, and a file costs a frame about as much as a whole extension
  // with one file does. So the bridge's files go to Safari as one, the
  // bundle keeping apart only those its pages use as well. The extension's
  // own scripts stay files of their own, as in the browser it was made for,
  // where one that fails to parse or throws leaves the others to run.
  function writeBridge(bundle) {
    var parts = [CONFIG_JS, CONTENT_API_JS, CORE_JS, CONTENT_JS, RUN_START_JS];
    bundle.write(BRIDGE_JS, bytes.utf8(
      "// Generated by webext2safari: " + parts.map(function (file) {
        return file.slice(WEX_DIR.length + 1);
      }).join(", ") + ", as one script.\n" +
      parts.map(function (file) {
        return bytes.text(bundle.read(file));
      }).join("\n;\n") + "\n"));
    [CONTENT_API_JS, CONTENT_JS, RUN_START_JS].forEach(function (file) {
      bundle.remove(file);
    });
  }

  // A background made for Chrome or Firefox finds no `safari`; one that
  // finds Safari's object takes it for an old Safari extension's. Safari's
  // own code in the global page reads `window.safari`, which stays, so the
  // name is bound for the scripts that follow instead, where a bare
  // `safari` then reads undefined. A script that declares a `safari` of its
  // own anywhere in the bundle would collide with the binding, and then it
  // is left out.
  function backgroundGlobals(bundle) {
    var runtime = {};
    runtime[WEX_DIR] = true;
    var declared = bundle.walk("", runtime).some(function (entry) {
      return entry.files.some(function (name) {
        if (!/\.m?js$/i.test(name)) {
          return false;
        }
        var text = bytes.decodeKeepingEncoding(bundle.read(tree.join(entry.dir, name))).text;
        return /\b(?:var|let|const|function|class)\s+safari\b/.test(text) ||
          W2S.javascript.declaredInList(text, "safari");
      });
    });
    if (declared) {
      return [];
    }
    bundle.write(BACKGROUND_GLOBALS_JS, bytes.utf8(
      "// The background's scripts find no `safari`, as in the browser they were made for.\n" +
      "let safari;\n"));
    return [BACKGROUND_GLOBALS_JS];
  }

  function writeGlobalPage(bundle, page, title, backgroundScripts, asModules, globals) {
    var here = tree.dirname(page);
    function src(path) {
      return relpath(path, here || ".");
    }
    var tags = [CONFIG_JS, API_JS, CORE_JS, GLOBAL_JS, NETWORK_JS].concat(globals).map(function (s) {
      return '  <script src="' + src(s) + '"></script>';
    });
    var kind = asModules ? ' type="module"' : "";
    backgroundScripts.forEach(function (s) {
      tags.push("  <script" + kind + ' src="' + escape(src(s)) + '"></script>');
    });
    bundle.write(page, bytes.utf8(
      "<!DOCTYPE html>\n" +
      "<html>\n" +
      "<head>\n" +
      '  <meta charset="utf-8">\n' +
      "  <title>" + escape(title) + "</title>\n" +
      tags.join("\n") + "\n" +
      "</head>\n" +
      "<body></body>\n" +
      "</html>\n"));
  }

  // -- Info.plist ------------------------------------------------------ //

  // The manifest's declarativeNetRequest rulesets, for Info.plist. The engine
  // reads them from Info.plist under the manifest's own keys, by the name
  // each file is stored under in the bundle. Returns them with the number of
  // rules in each, by ruleset id, which the runtime reports from
  // getAvailableStaticRuleCount, and the rules of each that change response
  // headers, which the runtime applies itself (WebKit applies only request
  // headers) and so need not read the whole ruleset for.
  // The extensionPath a redirect's target file is stored under, with its
  // query and fragment, when the converter renamed the file; otherwise null.
  function storedExtensionPath(renamedFiles, redirect) {
    var given = redirect && typeof redirect.extensionPath === "string" ? redirect.extensionPath : null;
    var match = given !== null ? /^\/?([^?#]*)(.*)$/.exec(given) : null;
    var stored = match ? renamedPath(renamedFiles, match[1]) : null;
    return stored !== null ? "/" + stored + match[2] : null;
  }

  function staticRulesets(mf, bundle, renamedFiles, notes) {
    var out = [];
    var counts = Object.create(null);
    var responseRules = Object.create(null);
    var engineCosts = Object.create(null);
    var loaded = [];
    var customHeaders = 0;
    mf.dnrRulesets().forEach(function (resource) {
      var path = renamedPath(renamedFiles, resource.path) || resource.path;
      if (!bundle.isFile(path)) {
        notes.push("the declarativeNetRequest ruleset " + resource.path + " is not in the " +
                   "bundle, so Info.plist does not name it");
        return;
      }
      var entry = { id: resource.id, enabled: resource.enabled, path: path };
      out.push(entry);
      var rules;
      try {
        rules = pyjson.parse(bytes.text(bundle.read(path)).replace(/^\uFEFF/, ""));
      } catch (e) {
        return;
      }
      var plainRules = JSON.parse(pyjson.dumps(Array.isArray(rules) ? rules : []));
      counts[resource.id] = plainRules.length;
      var engineRules = [];
      var movedResponseHeaders = false;
      var renamedRedirects = 0;
      plainRules.forEach(function (rule) {
        var engineRule = JSON.parse(JSON.stringify(rule));
        var action = rule && typeof rule.action === "object" ? rule.action : null;
        var stored = action && action.type === "redirect" ? storedExtensionPath(renamedFiles, action.redirect) : null;
        if (stored !== null) {
          engineRule.action.redirect.extensionPath = stored;
          renamedRedirects++;
        }
        if (action && action.type === "modifyHeaders") {
          var responseHeaders = Array.isArray(action.responseHeaders) ? action.responseHeaders : [];
          if (responseHeaders.length) {
            movedResponseHeaders = true;
            (responseRules[resource.id] = responseRules[resource.id] || []).push(rule);
            delete engineRule.action.responseHeaders;
          }
          var requestHeaders = Array.isArray(action.requestHeaders) ? action.requestHeaders : [];
          if (requestHeaders.some(function (header) {
            return String(header && header.header || "").toLowerCase().indexOf("x-") === 0;
          })) {
            customHeaders++;
          }
          if (!engineRule.action.requestHeaders && !engineRule.action.responseHeaders) {
            return;
          }
        }
        engineRules.push(engineRule);
      });
      if (movedResponseHeaders || renamedRedirects) {
        var enginePath = path.replace(/(?:\.json|\.txt)?$/, ".engine.json");
        bundle.write(enginePath, bytes.utf8(JSON.stringify(engineRules)));
        entry.path = enginePath;
      }
      if (movedResponseHeaders) {
        notes.push("the declarativeNetRequest ruleset " + resource.id + " changes response headers, " +
                   "which the global page applies because WebKit's engine leaves them unchanged; " +
                   "Info.plist names " + enginePath + " without those response actions");
      }
      if (renamedRedirects) {
        notes.push(renamedRedirects + " redirect" + plural(renamedRedirects, "", "s") + " of the " +
                   "declarativeNetRequest ruleset " + resource.id + " name" + plural(renamedRedirects, "s", "") +
                   " a renamed file, which Info.plist's " + enginePath + " names by its new name");
      }
      var cost = engineRuleCount(engineRules);
      engineCosts[resource.id] = cost;
      loaded.push({ entry: entry, rules: engineRules, cost: cost });
    });
    if (customHeaders) {
      notes.push(customHeaders + " declarativeNetRequest rule" + plural(customHeaders, "", "s") +
                 " modif" + plural(customHeaders, "ies", "y") + " custom X- headers, which " +
                 "WebKit rejects; it changes only the headers on its own list");
    }
    fitEngineLimit(bundle, loaded, engineCosts, notes);
    return { rulesets: out, counts: counts, responseRules: responseRules, engineCosts: engineCosts };
  }

  // The engine compiles all of an extension's rules into one WebKit content
  // rule list, which holds at most ENGINE_RULE_LIMIT rules, and makes many
  // of one declarativeNetRequest rule (engineRuleCost). Rulesets that would
  // make more are cut to fit, so that the engine applies most of them rather
  // than none: the rulesets enabled from the start together, and any other
  // on its own, within STATIC_RULE_BUDGET, which leaves room for dynamic and
  // session rules. A cut ruleset keeps every allow and allowAllRequests
  // rule, as a block without its exceptions would break sites, and then the
  // other rules, the cheapest first, the last of them with as many of its
  // request domains as fit; it is written beside the original, which
  // Info.plist then names. The runtime reads the original, so the extension
  // sees its rules as it wrote them.
  var ENGINE_RULE_LIMIT = 150000;
  var STATIC_RULE_BUDGET = 140000;

  function engineRuleCost(rule) {
    var c = rule && typeof rule.condition === "object" && rule.condition ? rule.condition : {};
    var type = rule && rule.action ? rule.action.type : "";
    var allowAll = type === "allowAllRequests";
    var both = !!(c.initiatorDomains && c.excludedInitiatorDomains) && !allowAll;
    var each = (both ? 2 : 1) + (type === "upgradeScheme" ? 1 : 0);
    var excludeEach = both ? 2 : 1;
    var total = 0;
    var excludedMethods = Array.isArray(c.excludedRequestMethods) && !allowAll ? c.excludedRequestMethods.length : 0;
    if (Array.isArray(c.excludedRequestDomains)) {
      total += c.excludedRequestDomains.length * Math.max(1, excludedMethods) * excludeEach;
    } else if (excludedMethods) {
      total += excludedMethods * excludeEach;
    }
    var methods = Array.isArray(c.requestMethods) && !allowAll ? c.requestMethods.length : 0;
    if (Array.isArray(c.requestDomains) && c.regexFilter === undefined) {
      total += c.requestDomains.length * Math.max(1, methods) * each;
    } else {
      total += Math.max(1, methods) * each;
    }
    return total;
  }

  function engineRuleCount(rules) {
    var plain = JSON.parse(pyjson.dumps(rules));
    var total = 0;
    (Array.isArray(plain) ? plain : []).forEach(function (rule) {
      total += engineRuleCost(rule);
    });
    return total;
  }

  function isException(rule) {
    var type = rule && rule.action ? rule.action.type : "";
    return type === "allow" || type === "allowAllRequests";
  }

  // The rules of `sets` (each {rules}) cut to `budget`, as each set's kept
  // rules, in their original order.
  function cutRules(sets, budget) {
    var left = budget;
    var kept = sets.map(function () {
      return {};
    });
    var trimmed = sets.map(function () {
      return {};
    });
    var rest = [];
    sets.forEach(function (set, s) {
      set.rules.forEach(function (rule, r) {
        if (isException(rule)) {
          kept[s][r] = true;
          left -= engineRuleCost(rule);
        } else {
          rest.push({ s: s, r: r, cost: engineRuleCost(rule) });
        }
      });
    });
    rest.sort(function (a, b) {
      return a.cost - b.cost || a.s - b.s || a.r - b.r;
    });
    for (var i = 0; i < rest.length && left > 0; i++) {
      var item = rest[i];
      if (item.cost <= left) {
        kept[item.s][item.r] = true;
        left -= item.cost;
        continue;
      }
      var rule = sets[item.s].rules[item.r];
      var c = rule.condition || {};
      if (Array.isArray(c.requestDomains) && c.regexFilter === undefined && c.requestDomains.length > 1) {
        var perDomain = item.cost / c.requestDomains.length;
        var fit = Math.floor(left / perDomain);
        if (fit > 0) {
          var copy = JSON.parse(JSON.stringify(rule));
          copy.condition.requestDomains = c.requestDomains.slice(0, fit);
          trimmed[item.s][item.r] = copy;
          left -= fit * perDomain;
        }
      }
      break;
    }
    return sets.map(function (set, s) {
      var out = [];
      set.rules.forEach(function (rule, r) {
        if (trimmed[s][r]) {
          out.push(trimmed[s][r]);
        } else if (kept[s][r]) {
          out.push(rule);
        }
      });
      return out;
    });
  }

  function fitEngineLimit(bundle, loaded, engineCosts, notes) {
    function write(item, rules, together) {
      var keptCost = 0;
      rules.forEach(function (rule) {
        keptCost += engineRuleCost(rule);
      });
      if (keptCost === item.cost) {
        return;
      }
      var cutPath = item.entry.path.replace(/(\.json)?$/, ".fitted.json");
      bundle.write(cutPath, bytes.utf8(JSON.stringify(rules)));
      notes.push("the declarativeNetRequest ruleset " + item.entry.id + " makes about " + item.cost +
                 " rules in WebKit's form, which has one for each request domain and method; " +
                 (together ? "with the other rulesets enabled from the start, " : "") + "that is more than " +
                 "the " + ENGINE_RULE_LIMIT + " one content rule list holds, which would leave the engine " +
                 "applying none of the extension's rules, so " + cutPath + " keeps " + rules.length +
                 " of its " + item.plain.length + " rules, every exception among them, and Info.plist " +
                 "names it");
      item.entry.path = cutPath;
      engineCosts[item.entry.id] = keptCost;
    }
    var enabled = loaded.filter(function (item) {
      return item.entry.enabled;
    });
    var enabledCost = enabled.reduce(function (sum, item) {
      return sum + item.cost;
    }, 0);
    var over = loaded.filter(function (item) {
      return (item.entry.enabled && enabledCost > STATIC_RULE_BUDGET) ||
        (!item.entry.enabled && item.cost > STATIC_RULE_BUDGET);
    });
    over.forEach(function (item) {
      item.plain = JSON.parse(pyjson.dumps(item.rules)).filter(function (rule) {
        return rule && typeof rule === "object";
      });
    });
    var enabledOver = over.filter(function (item) {
      return item.entry.enabled;
    });
    if (enabledOver.length) {
      var cut = cutRules(enabledOver.map(function (item) {
        return { rules: item.plain };
      }), STATIC_RULE_BUDGET);
      enabledOver.forEach(function (item, i) {
        write(item, cut[i], enabledOver.length < enabled.length || enabled.length > 1);
      });
    }
    over.filter(function (item) {
      return !item.entry.enabled;
    }).forEach(function (item) {
      write(item, cutRules([{ rules: item.plain }], STATIC_RULE_BUDGET)[0], false);
    });
  }

  // The bundle's HTML files the manifest's sandbox patterns name; a pattern
  // may hold * for any run of characters within a file's path.
  function sandboxedPages(bundle, patterns) {
    if (!patterns.length) {
      return [];
    }
    var res = patterns.map(function (p) {
      return new RegExp("^" + p.split("*").map(function (part) {
        return part.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
      }).join(".*") + "$");
    });
    return htmlpatch.findPages(bundle, [WEX_DIR], []).filter(function (page) {
      return res.some(function (re) {
        return re.test(page);
      });
    });
  }

  // Gives each frame of the page that shows a sandboxed page the sandbox, and
  // says how many it gave it to.
  function sandboxFrames(bundle, page, sandboxPages, flags) {
    var decoded = bytes.decodeKeepingEncoding(bundle.read(page));
    var count = 0;
    var html = decoded.text.replace(/<iframe\b([^>]*)>/gi, function (tag, attributes) {
      var m = /\ssrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes);
      if (!m || /\ssandbox\b/i.test(attributes)) {
        return tag;
      }
      var src = (m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4]).split(/[?#]/)[0];
      var target = src.charAt(0) === "/" ? src.slice(1) :
        tree.normalize(tree.join(tree.dirname(page) || "", src));
      if (sandboxPages.indexOf(target) < 0) {
        return tag;
      }
      count++;
      return "<iframe sandbox=\"" + flags + "\"" + attributes + ">";
    });
    if (count) {
      bundle.write(page, decoded.encode(html));
    }
    return count;
  }

  // The manifest's devtools page, and the page Info.plist names for the
  // engine to open with each Web Inspector. Safari 7's Web Inspector has no
  // place for an extension's panel, so for an extension whose code makes
  // panels, the Inspector opens the runtime's relay instead, which opens a
  // window that runs the devtools page and shows its panels.
  function devtoolsPage(mf, bundle, notes) {
    var page = mf.devtoolsPage();
    if (!page) {
      return null;
    }
    var path = page.split(/[?#]/)[0];
    if (!bundle.isFile(path)) {
      notes.push("devtools page " + path + " is not in the bundle, so Info.plist does not name it");
      return null;
    }
    var makesPanels = bundle.paths().some(function (file) {
      return /\.m?js$/.test(file) && file.indexOf(WEX_DIR + "/") !== 0 &&
        /\bpanels\s*\.\s*create\s*\(/.test(bytes.text(bundle.read(file)));
    });
    if (!makesPanels) {
      return { info: page, window: null };
    }
    var scripts = [CONFIG_JS, API_JS, CORE_JS, PAGE_JS, DEVTOOLS_JS].map(function (s) {
      return '  <script src="' + s.slice(WEX_DIR.length + 1) + '"></script>';
    }).join("\n");
    [[DEVTOOLS_RELAY, ""], [DEVTOOLS_WINDOW, '<div id="wex-panel-tabs"></div><div id="wex-panels"></div>']]
      .forEach(function (file) {
        bundle.write(file[0], bytes.utf8("<!DOCTYPE html>\n<html>\n<head>\n  <meta charset=\"utf-8\">\n" +
          "  <title></title>\n" + scripts +
          "\n</head>\n<body>" + file[1] + "</body>\n</html>\n"));
      });
    notes.push("Safari's Web Inspector has no place for an extension's panels, so the devtools page " +
               "and its panels show in a window of their own while a tab's Web Inspector is open");
    return { info: DEVTOOLS_RELAY, window: page };
  }

  // The text of the declared style sheets a frame can show before the page's
  // first paint: small ones, and none with an address, which a page could read
  // and which would resolve against the page.
  var EARLY_SHEET_LIMIT = 32 * 1024;

  function earlySheets(bundle, groups) {
    var sheets = {};
    (groups || []).forEach(function (group) {
      (group.css || []).forEach(function (file) {
        var path = String(file).replace(/^\/+/, "");
        if (!bundle.isFile(path)) {
          return;
        }
        var text = bytes.text(bundle.read(path));
        if (text.length <= EARLY_SHEET_LIMIT && !/url\s*\(|@import/i.test(text)) {
          sheets[file] = text;
        }
      });
    });
    return sheets;
  }

  function buildInfoPlist(mf, options, whitelist, websiteAccess, globalPage, toolbarImage,
                          hasContentSection) {
    var chrome = {
      "Database Quota": new pyjson.PyFloat(DATABASE_QUOTA),
      "Global Page": globalPage
    };

    // A toolbar button can have a popover or a command, not both. An extension
    // with a popup gets the popover, showing the popup; one without gets the
    // command, which the runtime reports as action.onClicked.
    var toolbarItem = {
      "Identifier": TOOLBAR_ID,
      "Image": toolbarImage,
      "Include By Default": true,
      "Label": mf.shortName,
      "Palette Label": mf.shortName,
      "Tool Tip": mf.actionTitle()
    };
    if (options.popupPage) {
      // Width and Height are written as reals: a popover declared with
      // integer dimensions was never once seen to open.
      chrome.Popovers = [{
        "Identifier": POPOVER_ID,
        "Filename": POPUP_PLACEHOLDER,
        "Width": new pyjson.PyFloat(options.popupWidth),
        "Height": new pyjson.PyFloat(options.popupHeight)
      }];
      toolbarItem.Popover = POPOVER_ID;
    } else {
      toolbarItem.Command = ACTION_COMMAND;
    }
    chrome["Toolbar Items"] = [toolbarItem];

    var info = {
      "Author": options.author || mf.author || (options.listing && options.listing.author) ||
        mf.homepageHost || "Unknown",
      "Builder Version": BUILDER_VERSION,
      "CFBundleDisplayName": mf.name,
      "CFBundleIdentifier": options.bundleId,
      "CFBundleInfoDictionaryVersion": "6.0",
      "CFBundleShortVersionString": mf.versionString,
      "CFBundleVersion": mf.versionString,
      "Chrome": chrome,
      "Description": mf.description || mf.name,
      "ExtensionInfoDictionaryVersion": INFO_DICTIONARY_VERSION,
      "Permissions": { "Website Access": websiteAccess }
    };
    var website = mf.homepage || (options.listing && options.listing.website);
    if (website) {
      info.Website = website;
    }
    if (options.rulesets.length) {
      info.declarative_net_request = { rule_resources: options.rulesets };
    }
    if (options.devtoolsPage) {
      info.WebExtensionDevtoolsPage = options.devtoolsPage;
    }
    if (hasContentSection) {
      var content = {
        Scripts: {
          Start: [BRIDGE_JS].concat(options.injectedScripts ? options.injectedScripts.start : []),
          End: [RUN_END_JS].concat(options.injectedScripts ? options.injectedScripts.end : [])
        }
      };
      if (whitelist.length) {
        content.Whitelist = whitelist;
      }
      info.Content = content;
    }
    return info;
  }

  // -- identity -------------------------------------------------------- //

  // An identifier Safari will accept: dot-separated components that each
  // start with a letter and hold only letters, digits and hyphens. Firefox
  // add-on ids are routinely GUIDs, whose components start with digits.
  function sanitiseBundleId(candidate) {
    var components = [];
    String(candidate).split(".").forEach(function (raw) {
      var cleaned = raw.replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
      if (!cleaned) {
        return;
      }
      if (!/^[A-Za-z]/.test(cleaned)) {
        cleaned = "x" + cleaned;
      }
      components.push(cleaned);
    });
    return components.join(".") || "com.webext2safari.extension";
  }

  // A stable reverse-DNS identifier for the bundle, made from the id the
  // extension's browser knows it by where it has one, so that another
  // converted extension can work out the bundle from that id: a Chrome
  // build's from its Chrome id, a Firefox build's from its Firefox id. The
  // runtime's bundleIdFor makes the same.
  function deriveBundleId(mf, chromeId, firefox) {
    if (chromeId && !firefox) {
      return "com.webext2safari." + chromeId;
    }
    var gecko = mf.geckoId();
    if (pyjson.truthy(gecko)) {
      gecko = pyjson.str(gecko);
      if (gecko.charAt(0) === "{" || gecko.indexOf("@") >= 0) {
        // A GUID or an addon@vendor id, neither of which is reverse-DNS.
        var local = gecko.replace(/^[{}]+|[{}]+$/g, "").replace(/@/g, ".");
        return sanitiseBundleId("com.webext2safari." + manifestModule.slug(local));
      }
      return sanitiseBundleId(gecko);
    }
    // Letters of another script drop out of an identifier, so a name with
    // any, or with nothing an identifier can hold, is told from other such
    // names by its digest.
    var name = String(mf.name);
    var slugged = "com.webext2safari." + manifestModule.slug(name);
    if (!/[A-Za-z0-9]/.test(name) || /(?!\p{Script=Latin})\p{L}/u.test(name)) {
      slugged += "-" + bytes.hex(W2S.hash.sha1(bytes.utf8(name))).slice(0, 16);
    }
    return sanitiseBundleId(slugged);
  }

  // The bundle's folder name; a slash in the extension's name would make it a
  // path.
  function bundleFileName(displayName) {
    return displayName.replace(/\//g, "-") + ".safariextension";
  }

  // The Chrome ids, other than the extension's own, that its scripts name:
  // the extensions whose addresses it may build, which the runtime asks for
  // their origins if they are converted extensions of their own.
  var MAX_OTHER_IDS = 64;

  function otherExtensionIds(bundle, ownId) {
    var runtime = {};
    runtime[WEX_DIR] = true;
    var found = [];
    bundle.walk("", runtime).forEach(function (entry) {
      entry.files.forEach(function (name) {
        if (!/\.m?js$/i.test(name) || found.length >= MAX_OTHER_IDS) {
          return;
        }
        var text = bytes.decodeKeepingEncoding(bundle.read(tree.join(entry.dir, name))).text;
        (text.match(/\b[a-p]{32}\b/g) || []).forEach(function (id) {
          if (id !== ownId && found.indexOf(id) < 0 && found.length < MAX_OTHER_IDS) {
            found.push(id);
          }
        });
      });
    });
    return found.sort();
  }

  // The address the web knows the extension by: a Chrome build's
  // chrome-extension://<id>, a Firefox build's moz-extension://<uuid>, whose
  // uuid Firefox makes up for each install; the converter makes it up from
  // the bundle's id, so that it holds for every install of the bundle. Null
  // for a Chrome build of no known id.
  function webOrigin(firefox, chromeId, bundleId) {
    if (!firefox) {
      return chromeId ? "chrome-extension://" + chromeId : null;
    }
    var digest = W2S.hash.sha256(bytes.utf8("moz-extension uuid for " + bundleId));
    digest[6] = (digest[6] & 0x0f) | 0x40;
    digest[8] = (digest[8] & 0x3f) | 0x80;
    var hex = bytes.hex(digest.subarray(0, 16));
    return "moz-extension://" + hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" +
      hex.slice(16, 20) + "-" + hex.slice(20, 32);
  }

  // -- conversion ------------------------------------------------------ //

  // Converts one extension. `options.archive` holds the .xpi, .crx or .zip,
  // or `options.files` a tree of its unpacked files; `options.runtime` maps
  // each runtime file's name to its contents. `options.listing`, when the
  // extension came from a store, is what its listing says of it there
  // (webstore.chromeListing, webstore.firefoxListing): Safari shows the
  // listing's author for an extension whose manifest names none, and the
  // listing's page for one that names no homepage. Resolves to {bundleName,
  // files, report, notes}.
  function convert(options) {
    return Promise.resolve().then(function () {
      var unpacked = options.files;
      if (!unpacked) {
        unpacked = new tree.Tree();
        try {
          W2S.zip.extract(options.archive, unpacked);
        } catch (e) {
          throw ConversionError(e.message);
        }
      }
      var root = findManifestRoot(unpacked);
      var source = root ? unpacked.subtree(root) : unpacked;
      return convertSource(source, options);
    });
  }

  // Files Mozilla signs every add-on it publishes with.
  var FIREFOX_SIGNATURES = ["META-INF/mozilla.rsa", "META-INF/cose.sig"];

  // Whether the extension is a build published for Firefox.
  // The address identity.getRedirectURL gives in the browser the extension
  // was built for, which sign-in providers have on record as the one to send
  // the browser back to: Firefox's names the SHA-1 of the extension's id,
  // Chrome's the extension's id. Null when the id is unknown.
  function identityRedirectURL(isFirefox, geckoId, chromeId) {
    if (isFirefox && pyjson.truthy(geckoId)) {
      return "https://" + bytes.hex(W2S.hash.sha1(bytes.utf8(pyjson.str(geckoId)))) +
        ".extensions.allizom.org/";
    }
    return chromeId ? "https://" + chromeId + ".chromiumapp.org/" : null;
  }

  function firefoxBuild(source) {
    return FIREFOX_SIGNATURES.some(function (name) {
      return source.isFile(name);
    });
  }

  function convertSource(source, options) {
    var data = manifestModule.load(source.read("manifest.json"));
    var mf = new manifestModule.Manifest(data, source);
    // Names the icons by their paths in `source`, which they are read from.
    var sourceManifest = mf;
    var chromeId = W2S.webstore.sourceExtensionId(options.source || "", options.archive || null, data);

    var displayName = options.name || mf.name;
    var bundleName = bundleFileName(displayName);
    var notes = [];

    var bundle = copyTree(source);
    var reservedFolder = renameReservedFolder(bundle);
    var reserved = reservedFolder.renamed;
    if (reservedFolder.name !== null) {
      data = renamedManifestPaths(data, reservedFolder.name, reservedFolder.renamedTo);
      mf = new manifestModule.Manifest(data, bundle);
      bundle.write("manifest.json", bytes.utf8(pyjson.dumps(data) + "\n"));
      // The extension's scripts keep their other strings: a path in one may
      // be a key it builds again while running, and the runtime maps getURL,
      // fetch and XMLHttpRequest for the old paths. A module specifier is an
      // address alone, and the engine resolves it.
      var references = renameHtmlReferences(bundle, reserved) +
        renameCssReferences(bundle, reserved);
      var specifiers = W2S.javascript.adaptModuleSpecifiers(bundle, reserved, []);
      notes.push("Safari will not install a bundle with a top-level folder named \"" +
                 reservedFolder.name + "\", so it is \"" + reservedFolder.renamedTo +
                 "\"; the manifest's paths, " + references + " reference" +
                 plural(references, "", "s") + " in the extension's pages and style " +
                 "sheets and " + specifiers + " module specifier" + plural(specifiers, "", "s") +
                 " follow it, and the runtime points getURL, fetch and XMLHttpRequest " +
                 "at the new name");
    }
    grantEverySite(mf, data, bundle, notes);
    dropPngDensity(bundle);
    var bundleId = options.bundleId ? sanitiseBundleId(options.bundleId) :
      deriveBundleId(mf, chromeId, firefoxBuild(source));
    var web = webOrigin(firefoxBuild(source), chromeId, bundleId);
    var localizedSheets = localizeStylesheets(bundle, mf.localeMessages(), mf.defaultLocale,
      firefoxBuild(source) ? web.slice("moz-extension://".length) : chromeId || bundleId);
    if (localizedSheets) {
      notes.push(localizedSheets + " style sheet" + plural(localizedSheets, " has its", "s have their") +
                 " __MSG_ references filled in, as the browser fills them in when it serves them");
    }
    var svgImages = W2S.svg.inlineBundleCss(bundle);
    if (svgImages) {
      notes.push(svgImages + " bundled SVG references in CSS were given an explicit " +
                 "image/svg+xml type using data URLs");
    }
    var fitted = fitToSafari(bundle);
    var renamedFiles = fitted.renamed;
    var renamedModules = serveModulesAsScripts(bundle);
    var moduleCount = Object.keys(renamedModules).length;
    if (moduleCount) {
      var references = W2S.javascript.adaptRenamedReferences(bundle, renamedModules, ".mjs", []) +
        renameHtmlReferences(bundle, renamedModules);
      notes.push("Safari serves only .html, .js and .png files with a type, and refuses a " +
                 "module without one, so " + moduleCount + " .mjs file" +
                 plural(moduleCount, "", "s") + " got a .js name, and " + references +
                 " reference" + plural(references, "", "s") + " to " +
                 plural(moduleCount, "it", "them") + " " + plural(references, "was", "were") +
                 " updated");
    }
    RUNTIME_FILES.forEach(function (name) {
      var contents = options.runtime[name];
      if (!contents) {
        throw ConversionError("the runtime file " + name + " is missing");
      }
      bundle.write(WEX_DIR + "/" + name, contents);
    });
    bundle.write(DOWNLOAD_PAGE, bytes.utf8("<!DOCTYPE html>\n<html>\n<head>\n  <meta charset=\"utf-8\">\n" +
      "  <title></title>\n</head>\n<body>\n  <script src=\"wex-download.js\"></script>\n</body>\n</html>\n"));
    bundle.write(PAGE_WORLD_RAN, bytes.utf8(pageWorldRan(bundleId)));
    bundle.write(POPUP_PLACEHOLDER, bytes.utf8("<!DOCTYPE html>\n<html>\n<head>\n  <meta charset=\"utf-8\">\n" +
      "  <title></title>\n</head>\n<body></body>\n</html>\n"));

    var renamedKeys = Object.keys(renamedFiles).sort(tree.compare);
    if (renamedKeys.length) {
      notes.push("Safari crashes when it loads a bundle file whose name has no " +
                 "extension, so " + renamedKeys.length + " such file" +
                 plural(renamedKeys.length, "", "s") + " got one; the runtime points " +
                 "getURL, fetch and XMLHttpRequest at the new name, and anything " +
                 "else that loads one by its old name fails to find it: " +
                 renamedKeys.map(function (k) { return k + " -> " + renamedFiles[k]; }).join(", "));
    }
    if (fitted.filled) {
      notes.push(fitted.filled + " empty file" + plural(fitted.filled, " was", "s were") +
                 " given placeholder content, because Safari serves a zero-byte file as " +
                 "a directory");
    }
    // The runtime maps getURL, fetch and XMLHttpRequest for every renamed
    // file, looking a path up once, so a file renamed twice has each of its
    // old paths name where it ended up. The manifest's paths name a renamed
    // folder's files by its new name, so those paths are mapped as well.
    Object.keys(renamedModules).forEach(function (path) {
      renamedFiles[path] = renamedModules[path];
    });
    Object.keys(reserved).forEach(function (old) {
      var moved = reserved[old];
      renamedFiles[old] = Object.prototype.hasOwnProperty.call(renamedFiles, moved) ? renamedFiles[moved] : moved;
    });
    listRenamedWebResources(bundle, renamedFiles);

    var popupPage = mf.popupPage();
    var optionsPage = mf.optionsPage();
    var popupSize = options.popupSize || [400, 560];

    var contentGroups = mf.contentScripts();
    var needsEverywhere = mf.needsBridgeEverywhere();

    var config = {
      extensionId: bundleId,
      name: displayName,
      version: mf.versionString,
      manifest: data,
      locales: mf.locales(),
      localeMessages: embeddedLocaleMessages(mf.localeMessages(), mf.locales(),
        mf.defaultLocale, options.uiLanguage),
      defaultLocale: mf.defaultLocale,
      storage: options.storage || "local",
      debug: !!options.debug,
      testApi: options.testApi || null,
      testConfig: options.testConfig || null,
      contentScripts: contentGroups,
      contextMenus: mf.wantsContextMenus(),
      popupPage: popupPage,
      popupWidth: popupSize[0],
      popupHeight: popupSize[1],
      autoSizePopover: !options.popupSize,
      optionsPage: optionsPage,
      sidebarPage: mf.sidebarPage(),
      popoverId: POPOVER_ID,
      toolbarId: TOOLBAR_ID,
      actionCommand: ACTION_COMMAND,
      renamedFiles: renamedFiles,
      backgroundWorker: !!mf.backgroundWorker(),
      sourceOrigin: chromeId ? "chrome-extension://" + chromeId : null,
      // The id the extension's browser gives it, which runtime.id reports:
      // its Chrome Web Store id, or its id for Firefox.
      runtimeId: (firefoxBuild(source) ? mf.geckoId() : chromeId) || bundleId,
      otherExtensionIds: firefoxBuild(source) ? [] : otherExtensionIds(bundle, chromeId),
      webOrigin: web,
      firefoxBuild: firefoxBuild(source),
      // As management reports it: unpacked, as a folder is loaded, or from a
      // store or an archive.
      installType: options.files ? "development" : "normal",
      identityRedirectURL: identityRedirectURL(firefoxBuild(source), mf.geckoId(), chromeId),
      networkHosts: patterns.hostPatterns(data)
    };

    // -- the global page -------------------------------------------------
    var background = mf.background();
    var skipFromPagePatching = [];
    var globalPage;

    if (background.kind === "page") {
      var named = background.value.replace(/^\/+/, "");
      globalPage = tree.normalize(named) || named;
      if (!bundle.isFile(globalPage)) {
        throw ConversionError("the manifest names a background page that is not in the " +
                              "bundle: " + globalPage);
      }
      htmlpatch.patchFile(bundle, bundle.storedPath(globalPage),
                          [CONFIG_JS, API_JS, CORE_JS, GLOBAL_JS, NETWORK_JS].concat(backgroundGlobals(bundle)));
      skipFromPagePatching.push(globalPage);
      notes.push("the extension's own background page is used as the global page");
    } else {
      var scripts = (background.value || []).map(function (s) {
        s = pyjson.str(s).replace(/^\/+/, "");
        return renamedPath(renamedFiles, s) || s;
      });
      var missing = scripts.filter(function (s) { return !bundle.isFile(s); });
      if (missing.length) {
        notes.push("background scripts named in the manifest are missing from the bundle " +
                   "and were skipped: " + missing.join(", "));
        scripts = scripts.filter(function (s) { return missing.indexOf(s) < 0; });
      }
      // A service worker resolves relative URLs against its own script, so its
      // page goes beside it; a page at the bundle's root would send the
      // worker's "../config/x" out of the bundle.
      globalPage = GENERATED_GLOBAL_PAGE;
      var workerDir = tree.dirname(tree.normalize(mf.backgroundWorker() || "") || "");
      if (workerDir) {
        globalPage = workerDir + "/" + GENERATED_GLOBAL_PAGE;
      }
      writeGlobalPage(bundle, globalPage, displayName, scripts, mf.backgroundIsModule(), backgroundGlobals(bundle));
      skipFromPagePatching.push(globalPage);
      if (!scripts.length) {
        notes.push("this extension declares no background scripts; the global page exists " +
                   "only to host the extension APIs");
      }
    }

    config.backgroundPage = globalPage;
    if (chromeId) {
      notes.push("the original Chrome extension origin is retained for HTTP authentication " +
                 "on native extension requests, with matching CORS responses translated to " +
                 "Safari's real origin; global-page authentication needs WebKit's " +
                 "extension-view request hooks, and no website frames or helper tabs are " +
                 "created");
    }
    var adaptedOrigins = W2S.javascript.adaptChromeOrigins(bundle, [WEX_DIR]);
    if (adaptedOrigins) {
      notes.push(adaptedOrigins + " literal Chrome extension URL construction" +
                 plural(adaptedOrigins, " was", "s were") + " adapted to the runtime's " +
                 "extension origin; complex expressions are left untouched");
    }
    var adaptedModules = W2S.javascript.adaptModuleOriginPaths(bundle, [WEX_DIR]);
    if (adaptedModules) {
      notes.push(adaptedModules + " module-origin path construction" +
                 plural(adaptedModules, " was", "s were") + " adapted to preserve Safari's " +
                 "session token");
    }
    var home = config.firefoxBuild ? "moz-extension" : "chrome-extension";
    var adaptedProtocols = W2S.javascript.adaptExtensionProtocols(bundle, home, [WEX_DIR]);
    if (adaptedProtocols) {
      notes.push(adaptedProtocols + " " + home + " protocol string" +
                 plural(adaptedProtocols, "", "s") + " name" + plural(adaptedProtocols, "s", "") +
                 " Safari's protocol instead");
    }
    var adaptedLocations = W2S.javascript.adaptLocationPaths(bundle, [WEX_DIR]);
    if (adaptedLocations) {
      notes.push(adaptedLocations + " read" + plural(adaptedLocations, "", "s") +
                 " of location.pathname or location.origin given Chrome's values, without " +
                 "Safari's session token in the path");
    }
    var adaptedWorkerGlobals = W2S.javascript.adaptWorkerGlobals(bundle, [WEX_DIR]);
    if (adaptedWorkerGlobals) {
      notes.push(adaptedWorkerGlobals + " assignment" + plural(adaptedWorkerGlobals, "", "s") +
                 " of a window-only global such as globalThis.window, which a service worker " +
                 "can make and a window refuses, go" + plural(adaptedWorkerGlobals, "es", "") +
                 " to a scratch object in the global page of a service worker");
    }
    var adaptedTypeofs = mf.backgroundWorker() ? W2S.javascript.adaptWorkerTypeofs(bundle, [WEX_DIR]) : 0;
    if (adaptedTypeofs) {
      notes.push(adaptedTypeofs + " test" + plural(adaptedTypeofs, "", "s") + " of typeof window or " +
                 "typeof document answer" + plural(adaptedTypeofs, "s", "") + " \"undefined\" in the " +
                 "global page of the service worker, as a worker's would");
    }

    var injectedScripts = injectContentScripts(bundle, contentGroups, options.runtime);
    config.injectedScripts = { files: injectedScripts.injected, start: injectedScripts.start,
      end: injectedScripts.end };
    if (injectedScripts.count) {
      notes.push(injectedScripts.count + " content script" + plural(injectedScripts.count, " is", "s are") +
                 " injected by Safari from a copy in wex/content that runs where " +
                 plural(injectedScripts.count, "its", "their") + " match patterns apply, as the " +
                 "bridge decides, so that no page waits while the bridge reads " +
                 plural(injectedScripts.count, "it", "them"));
    }

    // -- sandboxed pages ---------------------------------------------------
    // A page the manifest serves sandboxed has no extension API and an origin
    // of its own, so it gets no bridge, and a frame of an extension page that
    // shows it is sandboxed with the manifest's flags.
    var sandboxPages = sandboxedPages(bundle, mf.sandboxPages());
    sandboxPages.forEach(function (page) {
      skipFromPagePatching.push(page);
    });
    config.sandboxPages = sandboxPages;
    config.sandboxFlags = mf.sandboxFlags();
    if (sandboxPages.length) {
      var framed = 0;
      htmlpatch.findPages(bundle, [WEX_DIR], sandboxPages).forEach(function (page) {
        framed += sandboxFrames(bundle, page, sandboxPages, config.sandboxFlags);
      });
      notes.push(sandboxPages.length + " sandboxed page" + plural(sandboxPages.length, "", "s") +
                 " got no extension API" + (framed ? ", and " + framed + " frame" + plural(framed, "", "s") +
                 " showing " + plural(sandboxPages.length, "it", "them") + " the sandbox" : ""));
    }

    // -- extension pages -------------------------------------------------
    var patched = 0;
    htmlpatch.findPages(bundle, [WEX_DIR], skipFromPagePatching).forEach(function (page) {
      if (htmlpatch.patchFile(bundle, page, [CONFIG_JS, API_JS, CORE_JS, PAGE_JS])) {
        patched++;
      }
    });
    notes.push("the extension-page bridge was added to " + patched + " HTML page" +
               plural(patched, "", "s"));

    if (!popupPage) {
      notes.push("this extension declares no toolbar popup, so clicking its button is " +
                 "reported as action.onClicked");
    }
    if (optionsPage) {
      notes.push("the options page opens in a tab");
    }

    // -- icons -----------------------------------------------------------
    return W2S.icons.build(bundle, source, sourceManifest.icons(), sourceManifest.actionIcons(), displayName,
                           options.convertImage).then(function (icons) {
      if (icons.placeholder) {
        notes.push("none of the extension's icons could be read (SVG icons and a few exotic " +
                   "image formats cannot be decoded here), so a placeholder was generated; " +
                   "replace Icon-*.png and " + icons.toolbarImage + " to fix the look");
      } else {
        notes.push("Safari draws toolbar images in one colour, so the toolbar image was " +
                   "drawn from the extension's icon with its main colour solid and the " +
                   "details that differ from it cut out, and the same was done for the " +
                   "icons it may switch to while running (in wex/toolbar); replace " +
                   "wex/toolbar-icon.png and toolbar-icon@2x.png for a hand-made one");
      }

      config.toolbarImages = W2S.icons.buildRuntimeMasks(bundle, [mf.icons(), mf.actionIcons()]);

      // -- whitelist and website access --------------------------------
      var scriptPatterns = [];
      contentGroups.forEach(function (group) {
        scriptPatterns = scriptPatterns.concat(group.matches);
      });
      // The pages `externally_connectable` lets message a Chrome build are
      // given their means to by the content side, which Safari injects only
      // where the bundle has access. Firefox ignores the key.
      var pagePatterns = config.firefoxBuild ? [] : mf.externallyConnectablePatterns();
      scriptPatterns = scriptPatterns.concat(pagePatterns);
      var hostPermissionPatterns = patterns.hostPatterns(data).concat(pagePatterns);
      // Safari's Website Access gates content injection as well as requests
      // from the extension. Chrome's manifest-declared content scripts get
      // access from their own matches and need not repeat them in
      // host_permissions, so those matches have to contribute here too.
      var websiteAccessPatterns = hostPermissionPatterns.concat(scriptPatterns);
      var whitelist;

      if (needsEverywhere) {
        // The engine runs injected code in the world Safari creates for the
        // bundle's content scripts, and the bridge in a page is what tells the
        // runtime which Safari tab an engine tab id stands for.
        whitelist = patterns.ALL_URLS.slice();
        notes.push("the bundle's Website Access and bridge cover every http and https page, " +
                   "because this extension works with tabs; the " +
                   "extension's own content scripts are still gated by their match patterns");
      } else {
        var built = patterns.buildWhitelist(scriptPatterns);
        whitelist = built.entries;
        if (built.collapsed && scriptPatterns.length) {
          notes.push("the content-script whitelist was widened to every http and https " +
                     "page, either because the extension asked for all sites or because it " +
                     "named too many to list; each script is still gated at runtime by its " +
                     "own match patterns");
        }
      }

      var hasContentSection = contentGroups.length > 0 || needsEverywhere || pagePatterns.length > 0;
      if (!hasContentSection) {
        notes.push("this extension declares no content scripts and needs no page access, " +
                   "so nothing is injected into web pages");
      }

      var allowed = patterns.allowedDomains(websiteAccessPatterns, 50);
      var everySite = mf.reachesEverySite();
      var websiteAccess;
      // A broad bridge is an implementation detail, not a Chrome host
      // permission: the runtime still applies the original manifest's API
      // checks and content-script matches. It nevertheless needs Website
      // Access All or Safari will silently skip the bridge. AUDIO_PLAYBACK
      // offscreen documents in particular use that bridge as their page host.
      if (needsEverywhere || allowed.useAll || everySite) {
        websiteAccess = { "Level": "All", "Include Secure Pages": true };
      } else if (!allowed.domains.length) {
        websiteAccess = { "Level": "None", "Include Secure Pages": true };
      } else {
        websiteAccess = { "Level": "Some", "Allowed Domains": allowed.domains,
                          "Include Secure Pages": true };
        whitelist = patterns.restrictWhitelist(whitelist, allowed.domains);
      }

      config.websiteAccess = websiteAccess.Level;
      config.bridgeWhitelist = hasContentSection && websiteAccess.Level !== "None"
        ? whitelist : null;
      var rulesets = staticRulesets(mf, bundle, renamedFiles, notes);
      config.rulesetRuleCounts = rulesets.counts;
      config.rulesetEngineCosts = rulesets.engineCosts;
      config.responseHeaderRules = rulesets.responseRules;
      var devtools = devtoolsPage(mf, bundle, notes);
      config.devtoolsWindowPage = devtools && devtools.window;
      config.earlySheets = earlySheets(bundle, config.contentScripts);
      config.pageWorldScripts = pageWorldScripts(bundle, config, contentGroups, options.runtime, bundleId, pagePatterns);
      writeConfig(bundle, config);
      // A Firefox build reads the suffix list only for the sites of its declarativeNetRequest rules.
      (config.firefoxBuild ? (mf.apiPermissions().some(function (p) { return /^declarativeNetRequest/.test(p); }) ? ["public-suffix-list.txt"] : []).concat(BUNDLE_DATA) : CHROME_DATA.concat(BUNDLE_DATA)).forEach(function (name) {
        if (options.runtime[name]) {
          bundle.write(WEX_DIR + "/" + name, options.runtime[name]);
        }
      });
      writeApi(bundle, options.runtime[config.firefoxBuild ? "firefox-api.json" : "chrome-api.json"], data,
               config.firefoxBuild, config.testApi);

      if (hasContentSection) {
        writeBridge(bundle);
      }

      // -- Info.plist ----------------------------------------------------
      var info = buildInfoPlist(mf, {
        bundleId: bundleId,
        author: options.author,
        listing: options.listing,
        popupPage: popupPage,
        popupWidth: popupSize[0],
        popupHeight: popupSize[1],
        rulesets: rulesets.rulesets,
        devtoolsPage: devtools && devtools.info,
        injectedScripts: injectedScripts
      }, whitelist, websiteAccess, globalPage, icons.toolbarImage, hasContentSection);
      bundle.write("Info.plist", bytes.utf8(W2S.plist.dumps(info)));

      // -- report --------------------------------------------------------
      var schemaBytes = options.runtime && options.runtime["chrome-api.json"];
      var schema = null;
      try {
        schema = schemaBytes ? JSON.parse(typeof schemaBytes === "string" ? schemaBytes :
          bytes.text(schemaBytes)) : null;
      } catch (e) { /* every alias call counts */ }
      var report = W2S.analyze.render(W2S.analyze.summarise(W2S.analyze.scan(source, schema)),
                                      mf.notes, notes);
      bundle.write(WEX_DIR + "/CONVERSION-REPORT.txt", bytes.utf8(
        displayName + " " + mf.versionString + "\n" + new Array(61).join("=") + "\n\n" + report));

      return {
        bundleName: bundleName,
        displayName: displayName,
        bundleId: bundleId,
        version: mf.versionString,
        files: bundle,
        report: report,
        notes: notes
      };
    });
  }

  // Packs a conversion's result into a signed .safariextz.
  function pack(result, identity) {
    var files = Object.create(null);
    result.files.paths().forEach(function (path) { files[path] = result.files.read(path); });
    return W2S.xar.pack(result.bundleName, files, identity);
  }

  W2S.convert = {
    convert: convert,
    pack: pack,
    RUNTIME_FILES: RUNTIME_FILES,
    pageWorldRan: pageWorldRan,
    RUNTIME_DATA: RUNTIME_DATA,
    sanitiseBundleId: sanitiseBundleId,
    relpath: relpath,
    ConversionError: ConversionError
  };
})(typeof globalThis.W2S === "object" ? globalThis.W2S : (globalThis.W2S = {}));
