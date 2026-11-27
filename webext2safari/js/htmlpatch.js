// Putting the extension-page bridge into the extension's own HTML pages.
//
// The engine hands an extension page only the parts of the WebExtension API
// that need the engine, so every page the extension opens needs the bridge,
// which completes it, loaded before anything else on the page runs.

(function (W2S) {
  "use strict";

  var bytes = W2S.bytes;

  var HEAD_RE = /<head\b[^>]*>/i;
  var HTML_RE = /<html\b[^>]*>/i;
  var MARKER = "wex-bridge";

  // Script tags for `scripts`, with paths relative to the page.
  function scriptTags(pageRelativePath, scripts) {
    var depth = pageRelativePath.split("/").length - 1;
    var prefix = new Array(depth + 1).join("../");
    var tags = ["<!-- " + MARKER + " -->"];
    scripts.forEach(function (script) {
      tags.push('<script src="' + prefix + script + '"></script>');
    });
    return tags.join("");
  }

  // `html` with its comments blanked at the same offsets, so that nothing in
  // a comment is taken for a tag. The parser ends "<!-->" and "<!--->" where
  // they stand, and a comment left open at the end of the document.
  function withoutComments(html) {
    return html.replace(/<!--(?:-?>|[\s\S]*?(?:--!?>|$))/g, function (comment) {
      return new Array(comment.length + 1).join(" ");
    });
  }

  // Inserts `tags` as early in the document as it is safe to put them. A
  // script placed ahead of the document's charset declaration would make the
  // browser guess the encoding, so a declaration near the top of the head
  // stays first, unless a script of the page's own comes before it.
  function inject(html, tags) {
    if (html.indexOf(MARKER) >= 0) {
      return { html: html, changed: false };
    }
    var source = withoutComments(html);
    var head = HEAD_RE.exec(source);
    if (head) {
      var insertAt = head.index + head[0].length;
      var charset = /<meta\b[^>]*?(charset\s*=|http-equiv\s*=\s*["']?content-type)[^>]*>/ig;
      charset.lastIndex = insertAt;
      var found = charset.exec(source.slice(0, insertAt + 1024));
      if (found && !/<script\b/i.test(source.slice(insertAt, found.index))) {
        insertAt = found.index + found[0].length;
      }
      return { html: html.slice(0, insertAt) + tags + html.slice(insertAt), changed: true };
    }
    var opening = HTML_RE.exec(source);
    if (opening) {
      var end = opening.index + opening[0].length;
      return { html: html.slice(0, end) + "<head>" + tags + "</head>" + html.slice(end), changed: true };
    }
    // A fragment with no structure at all; the parser will hoist these anyway.
    // A byte order mark stays first, the one place the browser reads a page's
    // encoding from it. A doctype stays first too, or the page is laid out in
    // quirks mode, and so does a charset declaration no script comes before.
    var at = source.charCodeAt(0) === 0xFEFF ? 1 : 0;
    var doctype = /^\s*<!doctype[^>]*>/i.exec(source);
    if (doctype) {
      at = doctype[0].length;
    }
    var declaration = /<meta\b[^>]*?(charset\s*=|http-equiv\s*=\s*["']?content-type)[^>]*>/i
      .exec(source.slice(at, at + 1024));
    if (declaration && !/<script\b/i.test(source.slice(at, at + declaration.index))) {
      at += declaration.index + declaration[0].length;
    }
    return { html: html.slice(0, at) + tags + html.slice(at), changed: true };
  }

  // A page's text and how to write it back. A page that begins with a UTF-16
  // byte order mark is UTF-16 to a browser, and is kept so; any other is
  // handled as bytes.decodeKeepingEncoding handles it.
  function decodePage(data) {
    var little = data[0] === 0xFF && data[1] === 0xFE;
    if (!little && !(data[0] === 0xFE && data[1] === 0xFF)) {
      return bytes.decodeKeepingEncoding(data);
    }
    var low = little ? 0 : 1;
    var text = "";
    for (var i = 0; i + 1 < data.length; i += 2) {
      text += String.fromCharCode(data[i + low] | (data[i + 1 - low] << 8));
    }
    return {
      text: text,
      encode: function (value) {
        var out = new Uint8Array(value.length * 2);
        for (var j = 0; j < value.length; j++) {
          var unit = value.charCodeAt(j);
          out[j * 2 + low] = unit & 255;
          out[j * 2 + 1 - low] = unit >> 8;
        }
        return out;
      }
    };
  }

  // Adds the bridge to the page at `path` in `tree`. Returns whether it was
  // added.
  function patchFile(tree, path, scripts) {
    var decoded = decodePage(tree.read(path));
    var result = inject(decoded.text, scriptTags(path, scripts));
    if (!result.changed) {
      return false;
    }
    tree.write(path, decoded.encode(result.html));
    return true;
  }

  // Every HTML file in the tree that should get the bridge.
  function findPages(tree, skipDirs, skipFiles) {
    var skip = Object.create(null);
    (skipDirs || []).forEach(function (name) { skip[name] = true; });
    var skipped = (skipFiles || []).map(function (f) { return W2S.tree.normalize(f); });
    var out = [];
    tree.walk("", skip).forEach(function (entry) {
      entry.files.forEach(function (name) {
        if (!/\.(html|htm|xhtml)$/.test(name.toLowerCase())) {
          return;
        }
        var full = W2S.tree.join(entry.dir, name);
        if (skipped.indexOf(full) < 0) {
          out.push(full);
        }
      });
    });
    return out.sort(W2S.tree.compare);
  }

  W2S.htmlpatch = {
    scriptTags: scriptTags,
    inject: inject,
    patchFile: patchFile,
    findPages: findPages
  };
})(typeof globalThis.W2S === "object" ? globalThis.W2S : (globalThis.W2S = {}));
