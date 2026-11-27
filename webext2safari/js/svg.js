// Giving bundled SVG images in stylesheets an explicit MIME type.

(function (W2S) {
  "use strict";

  var bytes = W2S.bytes;
  var tree = W2S.tree;

  // Whole comments and strings are matched first so their apparent url()
  // calls are not rewritten. Escaped CSS URLs are left to the browser.
  var TOKENS = /\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\burl\(\s*(?:"([^"\\]*)"|'([^'\\]*)'|([^()'"\\]*))\s*\)/gi;

  var SCHEME = /^[A-Za-z][A-Za-z0-9+\-.]*$/;

  // The parts of a URL as Python's urllib.parse.urlsplit finds them.
  function urlsplit(url) {
    url = url.replace(/^[\x00-\x20]+/, "").replace(/[\t\r\n]/g, "");
    var scheme = "", netloc = "", fragment = "";
    var colon = url.indexOf(":");
    if (colon > 0 && SCHEME.test(url.slice(0, colon))) {
      scheme = url.slice(0, colon).toLowerCase();
      url = url.slice(colon + 1);
    }
    if (url.slice(0, 2) === "//") {
      var end = url.length;
      ["/", "?", "#"].forEach(function (c) {
        var at = url.indexOf(c, 2);
        if (at >= 0 && at < end) {
          end = at;
        }
      });
      netloc = url.slice(2, end);
      url = url.slice(end);
    }
    var hash = url.indexOf("#");
    if (hash >= 0) {
      fragment = url.slice(hash + 1);
      url = url.slice(0, hash);
    }
    var question = url.indexOf("?");
    if (question >= 0) {
      url = url.slice(0, question);
    }
    return { scheme: scheme, netloc: netloc, path: url, fragment: fragment };
  }

  // Python's urllib.parse.unquote: %XX sequences decoded as UTF-8.
  function unquote(value) {
    if (value.indexOf("%") < 0) {
      return value;
    }
    return value.replace(/(?:%[0-9A-Fa-f]{2})+/g, function (run) {
      var raw = new Uint8Array(run.length / 3);
      for (var i = 0; i < raw.length; i++) {
        raw[i] = parseInt(run.substr(i * 3 + 1, 2), 16);
      }
      return bytes.text(raw);
    });
  }

  function inlineCss(css, filename, bundle) {
    var count = 0;
    var rewritten = css.replace(TOKENS, function (match, double, single, bare) {
      var value = double !== undefined ? double : single !== undefined ? single : bare;
      if (value === undefined) {
        return match;
      }
      var parsed = urlsplit(value.trim());
      if (parsed.scheme || parsed.netloc || !/\.svg$/.test(parsed.path.toLowerCase())) {
        return match;
      }
      var path = unquote(parsed.path);
      var directory = path.charAt(0) === "/" ? "" : tree.dirname(filename);
      var target = tree.normalize(tree.join(directory, path.replace(/^\/+/, "")));
      if (!target || !bundle.isFile(target)) {
        return match;
      }
      var fragment = parsed.fragment ? "#" + parsed.fragment : "";
      count++;
      return 'url("data:image/svg+xml;base64,' + bytes.base64(bundle.read(target)) + fragment + '")';
    });
    return { css: rewritten, count: count };
  }

  // Inlines the SVG images every stylesheet in `bundle` refers to. Returns
  // how many references were rewritten.
  function inlineBundleCss(bundle) {
    var count = 0;
    bundle.paths().forEach(function (path) {
      if (!/\.css$/.test(path.toLowerCase())) {
        return;
      }
      var decoded = bytes.decodeKeepingEncoding(bundle.read(path));
      var result = inlineCss(decoded.text, path, bundle);
      if (result.count) {
        bundle.write(path, decoded.encode(result.css));
        count += result.count;
      }
    });
    return count;
  }

  W2S.svg = {
    urlsplit: urlsplit,
    unquote: unquote,
    inlineCss: inlineCss,
    inlineBundleCss: inlineBundleCss,
    TOKENS: TOKENS
  };
})(typeof globalThis.W2S === "object" ? globalThis.W2S : (globalThis.W2S = {}));
