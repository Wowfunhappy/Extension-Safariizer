// Writing an XML property list the way Python 3's plistlib does.

(function (W2S) {
  "use strict";

  var pyjson = W2S.pyjson;

  var HEADER =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
    '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n';

  // A plist string cannot hold most control characters; they are dropped.
  function escape(value) {
    return value
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
      .replace(/\r\n/g, "\n").replace(/\r/g, "\n")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // A real is marked by wrapping its value in pyjson.PyFloat; a plain number
  // is written as an integer.
  function dumps(value) {
    var lines = [];

    function write(item, depth) {
      var indent = new Array(depth + 1).join("\t");
      if (typeof item === "string") {
        lines.push(indent + "<string>" + escape(item) + "</string>");
      } else if (item === true) {
        lines.push(indent + "<true/>");
      } else if (item === false) {
        lines.push(indent + "<false/>");
      } else if (item instanceof pyjson.PyFloat) {
        lines.push(indent + "<real>" + pyjson.floatRepr(item.value) + "</real>");
      } else if (typeof item === "number" || item instanceof pyjson.PyInt) {
        lines.push(indent + "<integer>" + String(item) + "</integer>");
      } else if (Array.isArray(item)) {
        if (!item.length) {
          lines.push(indent + "<array/>");
          return;
        }
        lines.push(indent + "<array>");
        item.forEach(function (entry) { write(entry, depth + 1); });
        lines.push(indent + "</array>");
      } else if (item && typeof item === "object") {
        var keys = Object.keys(item).sort(function (a, b) { return a < b ? -1 : a > b ? 1 : 0; });
        if (!keys.length) {
          lines.push(indent + "<dict/>");
          return;
        }
        lines.push(indent + "<dict>");
        keys.forEach(function (key) {
          lines.push(indent + "\t<key>" + escape(key) + "</key>");
          write(item[key], depth + 1);
        });
        lines.push(indent + "</dict>");
      } else {
        throw new TypeError("unsupported plist value: " + item);
      }
    }

    write(value, 0);
    return HEADER + lines.join("\n") + "\n</plist>\n";
  }

  W2S.plist = { dumps: dumps };
})(typeof globalThis.W2S === "object" ? globalThis.W2S : (globalThis.W2S = {}));
