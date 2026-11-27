// Translation of WebExtension match patterns into Safari's whitelist syntax.
//
// Safari's Content > Whitelist entries look like match patterns but
// understand a narrower syntax: the scheme is literal, so a pattern that
// leaves it open has to be written out once per scheme it stands for.

(function (W2S) {
  "use strict";

  var ALL_URLS = ["http://*/*", "https://*/*"];

  // Schemes a Safari content-script whitelist can usefully name.
  var WEB_SCHEMES = ["http", "https"];

  // Schemes whose patterns name sites on the network. A file's address or a
  // browser's own page has a host that is no site, and grants access to none.
  var SITE_SCHEMES = ["*", "http", "https", "ws", "wss", "ftp"];

  function isAllUrls(pattern) {
    return pattern === "<all_urls>" ||
      ["*://*/*", "http://*/*", "https://*/*", "*://*/"].indexOf(pattern) >= 0;
  }

  function pushUnique(list, value) {
    if (list.indexOf(value) < 0) {
      list.push(value);
    }
  }

  // A match pattern's host without the port it may end in. Safari's whitelist
  // and Website Access name hosts alone, so they cover every port of a host;
  // the runtime's own match patterns tell its ports apart.
  function withoutPort(host) {
    return String(host).replace(/:(\*|\d+)$/, "");
  }

  // The Safari whitelist entries one match pattern stands for; empty for a
  // pattern Safari's whitelist cannot express.
  function toSafari(pattern) {
    pattern = String(pattern).trim();
    if (!pattern) {
      return [];
    }
    if (pattern === "<all_urls>") {
      return ALL_URLS.slice();
    }
    var split = pattern.indexOf("://");
    if (split < 0) {
      return [];
    }
    var scheme = pattern.slice(0, split);
    var rest = pattern.slice(split + 3);
    var host, path;
    var slash = rest.indexOf("/");
    if (slash >= 0) {
      host = withoutPort(rest.slice(0, slash));
      path = rest.slice(slash);
    } else {
      host = withoutPort(rest);
      path = "/*";
    }

    var schemes = (scheme === "*" ? WEB_SCHEMES : [scheme]).filter(function (s) {
      return WEB_SCHEMES.indexOf(s) >= 0;
    });
    if (!schemes.length) {
      return [];
    }

    // A match pattern's "*.example.com" also covers the bare domain. Safari's
    // own wildcard does not reliably do that, so name both forms.
    var hosts = [host];
    if (host.indexOf("*.") === 0) {
      hosts.push(host.slice(2));
    }

    var out = [];
    schemes.forEach(function (s) {
      hosts.forEach(function (h) { pushUnique(out, s + "://" + h + path); });
    });
    return out;
  }

  // Collapses match patterns into a Safari whitelist. `collapsed` is true when
  // the result was widened to every web page.
  function buildWhitelist(patterns, cap) {
    cap = cap === undefined ? 400 : cap;
    if (patterns.some(isAllUrls)) {
      return { entries: ALL_URLS.slice(), collapsed: true };
    }
    var entries = [];
    patterns.forEach(function (p) { toSafari(p).forEach(function (e) { pushUnique(entries, e); }); });
    if (!entries.length) {
      return { entries: [], collapsed: false };
    }
    if (entries.length > cap) {
      return { entries: ALL_URLS.slice(), collapsed: true };
    }
    return { entries: entries, collapsed: false };
  }

  // Domains for Safari's Website Access; `useAll` when every site should be
  // granted instead.
  function allowedDomains(patterns, cap) {
    cap = cap === undefined ? 100 : cap;
    if (patterns.some(isAllUrls)) {
      return { domains: [], useAll: true };
    }
    var domains = [];
    for (var i = 0; i < patterns.length; i++) {
      var p = String(patterns[i]);
      var split = p.indexOf("://");
      if (split < 0 || SITE_SCHEMES.indexOf(p.slice(0, split)) < 0) {
        continue;
      }
      var host = withoutPort(p.slice(split + 3).split("/")[0]);
      if (!host || host === "*") {
        return { domains: [], useAll: true };
      }
      pushUnique(domains, host);
    }
    if (!domains.length) {
      return { domains: [], useAll: false };
    }
    if (domains.length > cap) {
      return { domains: [], useAll: true };
    }
    return { domains: domains, useAll: false };
  }

  // Narrows whitelist entries to the hosts Website Access permits, keeping
  // each entry's scheme and path; Safari can silently reject a script
  // registration whose whitelist exceeds Website Access.
  function restrictWhitelist(entries, domains) {
    var allowed = [];
    domains.forEach(function (domain) {
      allowed.push(domain);
      if (domain.indexOf("*.") === 0) {
        allowed.push(domain.slice(2));
      }
    });

    function covers(broad, narrow) {
      return broad === "*" || broad === narrow ||
        (broad.indexOf("*.") === 0 && narrow.endsWith(broad.slice(1)));
    }

    var result = [];
    entries.forEach(function (entry) {
      var split = entry.indexOf("://");
      var scheme = entry.slice(0, split);
      var rest = entry.slice(split + 3);
      var slash = rest.indexOf("/");
      var host = rest.slice(0, slash);
      var path = rest.slice(slash + 1);
      allowed.forEach(function (domain) {
        var intersection = covers(host, domain) ? domain : covers(domain, host) ? host : null;
        if (intersection) {
          pushUnique(result, scheme + "://" + intersection + "/" + path);
        }
      });
    });
    return result;
  }

  // Every host pattern the manifest asks for, wherever it declares them.
  function hostPatterns(manifest) {
    var out = [];
    function add(value) {
      if (typeof value === "string" && (value.indexOf("://") >= 0 || value === "<all_urls>")) {
        pushUnique(out, value);
      }
    }
    ["permissions", "optional_permissions", "host_permissions",
     "optional_host_permissions"].forEach(function (key) {
      list(manifest[key]).forEach(add);
    });
    list(manifest.content_scripts).forEach(function (script) {
      list(script && script.matches).forEach(add);
    });
    return out;
  }

  // A manifest value as a list, the way Python iterates `value or []`.
  function list(value) {
    if (Array.isArray(value)) {
      return value;
    }
    if (typeof value === "string") {
      return value.split("");
    }
    if (W2S.pyjson.isPlainObject(value)) {
      return Object.keys(value);
    }
    return [];
  }

  W2S.patterns = {
    ALL_URLS: ALL_URLS,
    isAllUrls: isAllUrls,
    toSafari: toSafari,
    buildWhitelist: buildWhitelist,
    allowedDomains: allowedDomains,
    restrictWhitelist: restrictWhitelist,
    hostPatterns: hostPatterns,
    list: list
  };
})(typeof globalThis.W2S === "object" ? globalThis.W2S : (globalThis.W2S = {}));
