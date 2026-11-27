// Reading a WebExtension manifest and normalising it into one shape.
//
// Manifest V2 and V3 disagree about where several things live — the toolbar
// button, the background scripts, the host permissions — and Firefox and
// Chrome each add keys of their own. Everything downstream reads the
// normalised view produced here rather than the raw manifest.

(function (W2S) {
  "use strict";

  var bytes = W2S.bytes;
  var pyjson = W2S.pyjson;
  var list = W2S.patterns.list;
  var truthy = pyjson.truthy;
  var str = pyjson.str;

  function get(object, key) {
    return pyjson.isPlainObject(object) && Object.prototype.hasOwnProperty.call(object, key)
      ? object[key] : undefined;
  }

  // The first of `values` Python would call true, or the last of them.
  function or() {
    for (var i = 0; i < arguments.length - 1; i++) {
      if (truthy(arguments[i])) {
        return arguments[i];
      }
    }
    return arguments[arguments.length - 1];
  }

  function lstripSlash(value) {
    return value.replace(/^\/+/, "");
  }

  function ManifestError(message) {
    var error = new Error(message);
    error.name = "ManifestError";
    return error;
  }

  // Parses a manifest.json, tolerating the ways they arrive in the wild.
  function load(raw) {
    // A BOM, which a JSON parser rejects.
    if (raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF) {
      raw = raw.subarray(3);
    }
    var source = bytes.text(raw);
    var data;
    try {
      data = pyjson.parse(source);
    } catch (e) {
      // Some published manifests carry // or /* */ comments or trailing
      // commas, which Chrome accepts and a JSON parser does not.
      var stripped = source
        .replace(/("(?:\\[^\n]|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, function (match, quoted) {
          return quoted || "";
        })
        .replace(/("(?:\\[^\n]|[^"\\])*")|,(\s*[}\]])/g, function (match, quoted, closing) {
          return quoted || closing;
        });
      try {
        data = pyjson.parse(stripped);
      } catch (e2) {
        throw ManifestError("could not parse manifest.json: " + e2.message);
      }
    }
    if (!pyjson.isPlainObject(data)) {
      throw ManifestError("manifest.json does not hold an object");
    }
    return data;
  }

  // Normalises an icon declaration into {size: bundle-relative path}. An icon
  // path may be written root-relative, which names the same file and has to
  // lose its leading slash before it can be looked up.
  function iconMap(value, defaultSize) {
    var out = Object.create(null);
    if (typeof value === "string") {
      out[defaultSize] = lstripSlash(value);
    } else if (pyjson.isPlainObject(value)) {
      Object.keys(value).forEach(function (key) {
        out[key] = lstripSlash(str(value[key]));
      });
    }
    return out;
  }

  // A filesystem- and identifier-safe form of an extension's name.
  function slug(name) {
    var out = String(name).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
    return out || "extension";
  }

  function parseJsonFile(tree, path) {
    var raw = tree.read(path);
    if (!raw) {
      return undefined;
    }
    try {
      return pyjson.parse(bytes.text(raw).replace(/^\uFEFF/, ""));
    } catch (e) {
      return undefined;
    }
  }

  var MSG_RE = /__MSG_([A-Za-z0-9_@]+)__/g;

  // A normalised view of a manifest. `root` is the tree of the extension's
  // own files, for the locale catalogues.
  function Manifest(data, root) {
    this.data = data;
    this.root = root;
    this.version = Number(or(get(data, "manifest_version"), 2)) | 0;
    this.notes = [];
    this._messages = null;
  }

  // -- localisation ---------------------------------------------------- //

  // The default locale's message catalogue, loaded once.
  Manifest.prototype.messages = function () {
    if (this._messages === null) {
      this._messages = {};
      var locales = [get(this.data, "default_locale"), "en", "en_US"].filter(truthy);
      for (var i = 0; i < locales.length; i++) {
        var path = "_locales/" + str(locales[i]) + "/messages.json";
        if (!this.root.isFile(path)) {
          continue;
        }
        var messages = parseJsonFile(this.root, path);
        if (messages !== undefined) {
          this._messages = pyjson.isPlainObject(messages) ? messages : {};
          break;
        }
      }
    }
    return this._messages;
  };

  // Resolves the __MSG_name__ references a manifest string may contain. The
  // browser does this before the extension ever sees the manifest, so
  // anything copied into Info.plist has to have it done too.
  Manifest.prototype.localize = function (value) {
    if (!value || value.indexOf("__MSG_") < 0) {
      return value;
    }
    var messages = this.messages();
    return value.replace(MSG_RE, function (match, name) {
      var entry = get(messages, name);
      if (entry === undefined || entry === null) {
        var lowered = name.toLowerCase();
        var keys = Object.keys(messages);
        for (var i = 0; i < keys.length; i++) {
          if (keys[i].toLowerCase() === lowered) {
            entry = messages[keys[i]];
            break;
          }
        }
      }
      if (pyjson.isPlainObject(entry) && truthy(get(entry, "message"))) {
        return str(entry.message);
      }
      return match;
    });
  };

  // -- identity -------------------------------------------------------- //

  Object.defineProperties(Manifest.prototype, {
    name: { get: function () {
      return this.localize(str(or(get(this.data, "name"), "Extension")));
    } },
    shortName: { get: function () {
      return this.localize(str(or(get(this.data, "short_name"), this.name)));
    } },
    versionString: { get: function () {
      return str(or(get(this.data, "version"), "1.0"));
    } },
    description: { get: function () {
      return this.localize(str(or(get(this.data, "description"), "")));
    } },
    // Whoever the manifest names as its author or developer, or "".
    author: { get: function () {
      var author = or(get(this.data, "author"), get(this.data, "developer"));
      if (pyjson.isPlainObject(author)) {
        author = get(author, "name");
      }
      return truthy(author) ? this.localize(str(author)) : "";
    } },
    // The host of the homepage the manifest names, without "www.", or "".
    homepageHost: { get: function () {
      var homepage = this.homepage;
      if (homepage && homepage.indexOf("://") >= 0) {
        var host = homepage.split("://").slice(1).join("://").split("/")[0].split(":")[0];
        if (host) {
          return host.indexOf("www.") === 0 ? host.slice(4) : host;
        }
      }
      return "";
    } },
    homepage: { get: function () {
      var developer = get(this.data, "developer");
      return str(or(get(this.data, "homepage_url"), get(this.data, "developer_url"),
                    pyjson.isPlainObject(developer) ? get(developer, "url") : undefined, ""));
    } },
    defaultLocale: { get: function () {
      var value = get(this.data, "default_locale");
      return value === undefined ? null : value;
    } }
  });

  Manifest.prototype.geckoId = function () {
    var settings = or(get(this.data, "browser_specific_settings"), get(this.data, "applications"), {});
    var gecko = or(get(settings, "gecko"), {});
    var id = get(gecko, "id");
    return id === undefined ? null : id;
  };

  // -- permissions ----------------------------------------------------- //

  // Permission names, excluding host patterns.
  Manifest.prototype.apiPermissions = function () {
    var out = [];
    var data = this.data;
    ["permissions", "optional_permissions"].forEach(function (key) {
      list(or(get(data, key), [])).forEach(function (entry) {
        if (typeof entry === "string" && entry.indexOf("://") < 0 && entry !== "<all_urls>" &&
            out.indexOf(entry) < 0) {
          out.push(entry);
        }
      });
    });
    return out;
  };

  Manifest.prototype.wantsContextMenus = function () {
    var permissions = this.apiPermissions();
    return permissions.indexOf("contextMenus") >= 0 || permissions.indexOf("menus") >= 0;
  };

  // True when a permission reaches every site, which Safari allows only with
  // access to every site: `tabs` shows the address of every tab, and
  // `activeTab` lets the extension into whatever site the user is on.
  // The pages that may message the extension (`externally_connectable.matches`).
  Manifest.prototype.externallyConnectablePatterns = function () {
    var allowed = get(this.data, "externally_connectable");
    var matches = allowed && Array.isArray(allowed.matches) ? allowed.matches : [];
    return matches.filter(function (m) { return typeof m === "string"; });
  };

  // Chrome's `debugger` permission reaches every site, as WebKit's input
  // from extensions and its Web Inspector access need.
  Manifest.prototype.reachesEverySite = function () {
    var permissions = this.apiPermissions();
    return ["tabs", "activeTab", "debugger"].some(function (p) { return permissions.indexOf(p) >= 0; });
  };

  // True when the content bridge has to be present beyond declared matches:
  // on-demand injection runs in the content-script world, which only exists
  // where the bundle injects something, and the bridge in a page is what
  // identifies its tab. An extension with a background or a toolbar button is
  // one that works with tabs.
  Manifest.prototype.needsBridgeEverywhere = function () {
    // A new-tab page tells a new tab from one a link opens by the address
    // Safari announces, which it withholds for a page outside the access.
    if (truthy(get(this.data, "background")) || this.action().key ||
        truthy(get(get(this.data, "chrome_url_overrides"), "newtab"))) {
      return true;
    }
    var permissions = this.apiPermissions();
    return ["scripting", "tabs", "activeTab", "webRequest", "webNavigation", "contextMenus",
            "menus"].some(function (p) { return permissions.indexOf(p) >= 0; });
  };

  // -- background ------------------------------------------------------ //

  // {kind, value}: kind is "page", "scripts" or null. MV3 service workers and
  // MV2 script lists both come back as "scripts"; a background HTML page
  // comes back as "page" and is used as the global page directly.
  Manifest.prototype.background = function () {
    var bg = get(this.data, "background");
    if (!truthy(bg)) {
      return { kind: null, value: null };
    }
    if (Array.isArray(bg)) {
      return { kind: "scripts", value: bg.slice() };
    }
    var scripts = get(bg, "scripts");
    var page = get(bg, "page");
    var worker = get(bg, "service_worker");
    // Firefox MV3 extensions often declare both; the script list is the one
    // written to run in a page.
    if (truthy(scripts)) {
      return { kind: "scripts", value: list(scripts).slice() };
    }
    if (truthy(page)) {
      return { kind: "page", value: str(page) };
    }
    if (truthy(worker)) {
      this.notes.push(
        "the background service worker runs in the global page, which is a " +
        "document: importScripts is provided, its fetch event fires for what the " +
        "extension's own pages load from it, and its install and activate events never fire");
      return { kind: "scripts", value: [str(worker)] };
    }
    return { kind: null, value: null };
  };

  // The service worker script the background runs as, if it is one.
  Manifest.prototype.backgroundWorker = function () {
    var bg = get(this.data, "background");
    if (!pyjson.isPlainObject(bg) || truthy(get(bg, "scripts")) || truthy(get(bg, "page"))) {
      return null;
    }
    var worker = get(bg, "service_worker");
    return truthy(worker) ? lstripSlash(str(worker)) : null;
  };

  Manifest.prototype.backgroundIsModule = function () {
    var bg = get(this.data, "background");
    return pyjson.isPlainObject(bg) && get(bg, "type") === "module";
  };

  // -- action ---------------------------------------------------------- //

  // The toolbar button declaration, whichever key holds it.
  Manifest.prototype.action = function () {
    var keys = ["action", "browser_action", "page_action"];
    for (var i = 0; i < keys.length; i++) {
      var value = get(this.data, keys[i]);
      if (pyjson.isPlainObject(value)) {
        return { key: keys[i], value: value };
      }
      if (value === null) {
        return { key: keys[i], value: {} };
      }
    }
    return { key: null, value: {} };
  };

  Manifest.prototype.popupPage = function () {
    var action = this.action().value;
    var popup = or(get(action, "default_popup"), get(action, "popup"));
    return truthy(popup) ? lstripSlash(str(popup)) : null;
  };

  // The page the extension adds to the developer tools, from the bundle root.
  Manifest.prototype.devtoolsPage = function () {
    var page = get(this.data, "devtools_page");
    return truthy(page) ? lstripSlash(str(page)) : null;
  };

  // The pages the manifest serves sandboxed, as given, from the bundle root,
  // and the sandbox flags their policy names, or Chrome's when it names none.
  Manifest.prototype.sandboxPages = function () {
    var pages = get(get(this.data, "sandbox"), "pages");
    return Array.isArray(pages) ? pages.filter(function (p) {
      return typeof p === "string" && p;
    }).map(function (p) {
      return lstripSlash(p);
    }) : [];
  };

  Manifest.prototype.sandboxFlags = function () {
    var csp = get(this.data, "content_security_policy");
    var policy = csp && typeof csp === "object" ? get(csp, "sandbox") : get(get(this.data, "sandbox"),
      "content_security_policy");
    var m = /(?:^|;)\s*sandbox((?:\s+[a-z-]+)*)\s*(?:;|$)/i.exec(typeof policy === "string" ? policy : "");
    return m ? m[1].trim() : "allow-scripts allow-forms allow-popups allow-modals";
  };

  Manifest.prototype.actionTitle = function () {
    var action = this.action().value;
    return this.localize(str(or(get(action, "default_title"), get(action, "title"), this.shortName)));
  };

  Manifest.prototype.actionIcons = function () {
    var action = this.action().value;
    return iconMap(or(get(action, "default_icon"), get(action, "icons")), "16");
  };

  Manifest.prototype.icons = function () {
    return iconMap(get(this.data, "icons"), "128");
  };

  // -- pages ----------------------------------------------------------- //

  Manifest.prototype.optionsPage = function () {
    var optionsUi = get(this.data, "options_ui");
    if (pyjson.isPlainObject(optionsUi) && truthy(get(optionsUi, "page"))) {
      return lstripSlash(str(optionsUi.page));
    }
    var page = get(this.data, "options_page");
    return truthy(page) ? lstripSlash(str(page)) : null;
  };

  Manifest.prototype.sidebarPage = function () {
    var sidebar = or(get(this.data, "sidebar_action"), get(this.data, "side_panel"));
    if (pyjson.isPlainObject(sidebar)) {
      var panel = or(get(sidebar, "default_panel"), get(sidebar, "default_path"));
      if (truthy(panel)) {
        return lstripSlash(str(panel));
      }
    }
    return null;
  };

  // -- content scripts ------------------------------------------------- //

  // Normalised content-script groups, in manifest order.
  Manifest.prototype.contentScripts = function () {
    var groups = [];
    list(or(get(this.data, "content_scripts"), [])).forEach(function (entry) {
      if (!pyjson.isPlainObject(entry)) {
        return;
      }
      var group = {
        matches: list(or(get(entry, "matches"), [])).map(str),
        js: list(or(get(entry, "js"), [])).map(function (p) { return lstripSlash(str(p)); }),
        css: list(or(get(entry, "css"), [])).map(function (p) { return lstripSlash(str(p)); }),
        run_at: str(or(get(entry, "run_at"), "document_idle")),
        all_frames: truthy(get(entry, "all_frames")),
        match_about_blank: truthy(get(entry, "match_about_blank"))
      };
      ["exclude_matches", "include_globs", "exclude_globs"].forEach(function (key) {
        if (truthy(get(entry, key))) {
          group[key] = list(entry[key]).map(str);
        }
      });
      if (truthy(get(entry, "world"))) {
        group.world = str(entry.world).toUpperCase();
      }
      groups.push(group);
    });
    return groups;
  };

  // -- declarativeNetRequest ------------------------------------------- //

  Manifest.prototype.dnrRulesets = function () {
    var block = or(get(this.data, "declarative_net_request"), {});
    var out = [];
    list(or(get(block, "rule_resources"), [])).forEach(function (res) {
      if (!pyjson.isPlainObject(res) || !truthy(get(res, "path"))) {
        return;
      }
      out.push({
        id: str(or(get(res, "id"), res.path)),
        path: lstripSlash(str(res.path)),
        enabled: Object.prototype.hasOwnProperty.call(res, "enabled") ? truthy(res.enabled) : true
      });
    });
    return out;
  };

  // -- locales --------------------------------------------------------- //

  // Locale directories that actually ship in the bundle. Asking for one that
  // is not there logs a console error on every page that looks up a message,
  // so the runtime is told which exist.
  Manifest.prototype.locales = function () {
    if (!this.root.isDir("_locales")) {
      return [];
    }
    var root = this.root;
    var listing = root.list("_locales");
    return listing.dirs.concat(listing.files).sort(W2S.tree.compare).filter(function (entry) {
      return root.isFile("_locales/" + entry + "/messages.json");
    });
  };

  // Catalogues bundled with the bridge so i18n never blocks a host page.
  Manifest.prototype.localeMessages = function () {
    var catalogues = Object.create(null);
    var root = this.root;
    this.locales().forEach(function (locale) {
      var messages = parseJsonFile(root, "_locales/" + locale + "/messages.json");
      if (pyjson.isPlainObject(messages)) {
        catalogues[locale] = messages;
      }
    });
    return catalogues;
  };

  W2S.manifest = {
    load: load,
    Manifest: Manifest,
    slug: slug,
    get: get,
    or: or,
    ManifestError: ManifestError
  };
})(typeof globalThis.W2S === "object" ? globalThis.W2S : (globalThis.W2S = {}));
