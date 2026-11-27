// JSON read and written the way Python's json module does it.
//
// The bundle's wex-config.js embeds the extension's manifest and catalogues
// as Python writes them, with sorted keys and Python's spelling of numbers.
// JavaScript cannot tell 1.0 from 1, so a parsed float is kept as a PyFloat,
// and an integer too large for a double keeps its digits in a PyInt; both
// behave as numbers in arithmetic and comparisons.

(function (W2S) {
  "use strict";

  function PyFloat(value) {
    this.value = value;
  }
  PyFloat.prototype.valueOf = function () { return this.value; };
  PyFloat.prototype.toString = function () { return floatRepr(this.value); };

  function PyInt(digits) {
    this.digits = digits;
  }
  PyInt.prototype.valueOf = function () { return Number(this.digits); };
  PyInt.prototype.toString = function () { return this.digits; };

  // Python's repr of a float: the shortest digits that round-trip, written
  // positionally between 1e-4 and 1e16 and in exponent form outside it.
  function floatRepr(value) {
    if (value !== value) {
      return "NaN";
    }
    if (value === Infinity) {
      return "Infinity";
    }
    if (value === -Infinity) {
      return "-Infinity";
    }
    if (value === 0) {
      return 1 / value < 0 ? "-0.0" : "0.0";
    }
    var parts = value.toExponential().split("e");
    var digits = parts[0].replace(".", "");
    var negative = digits[0] === "-";
    if (negative) {
      digits = digits.slice(1);
    }
    var exponent = Number(parts[1]);
    var out;
    if (exponent < -4 || exponent >= 16) {
      out = digits[0] + (digits.length > 1 ? "." + digits.slice(1) : "") + "e" +
        (exponent < 0 ? "-" : "+") + (Math.abs(exponent) < 10 ? "0" : "") + Math.abs(exponent);
    } else if (exponent < 0) {
      out = "0." + new Array(-exponent).join("0") + digits;
    } else if (digits.length <= exponent + 1) {
      out = digits + new Array(exponent + 2 - digits.length).join("0") + ".0";
    } else {
      out = digits.slice(0, exponent + 1) + "." + digits.slice(exponent + 1);
    }
    return (negative ? "-" : "") + out;
  }

  function SyntaxErrorAt(message, position) {
    var error = new Error(message + " at character " + position);
    error.name = "JSONError";
    return error;
  }

  // Parses JSON as Python's json.loads does, which also accepts NaN and
  // Infinity. Objects keep their keys in insertion order.
  function parse(source) {
    var i = 0;

    function whitespace() {
      while (i < source.length) {
        var c = source[i];
        if (c === " " || c === "\t" || c === "\n" || c === "\r") {
          i++;
        } else {
          break;
        }
      }
    }

    function value() {
      whitespace();
      var c = source[i];
      if (c === "{") {
        return object();
      }
      if (c === "[") {
        return array();
      }
      if (c === '"') {
        return string();
      }
      if (source.startsWith("true", i)) {
        i += 4;
        return true;
      }
      if (source.startsWith("false", i)) {
        i += 5;
        return false;
      }
      if (source.startsWith("null", i)) {
        i += 4;
        return null;
      }
      if (source.startsWith("NaN", i)) {
        i += 3;
        return new PyFloat(NaN);
      }
      if (source.startsWith("Infinity", i)) {
        i += 8;
        return new PyFloat(Infinity);
      }
      if (source.startsWith("-Infinity", i)) {
        i += 9;
        return new PyFloat(-Infinity);
      }
      return number();
    }

    function number() {
      var match = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?/y;
      match.lastIndex = i;
      var found = match.exec(source);
      if (!found) {
        throw SyntaxErrorAt("Expecting value", i);
      }
      i += found[0].length;
      if (found[1] || found[2]) {
        return new PyFloat(Number(found[0]));
      }
      var parsed = Number(found[0]);
      if (!Number.isSafeInteger(parsed)) {
        return new PyInt(BigInt(found[0]).toString());
      }
      return parsed;
    }

    function string() {
      i++;
      var out = "";
      for (;;) {
        var start = i;
        while (i < source.length && source[i] !== '"' && source[i] !== "\\" &&
               source.charCodeAt(i) >= 0x20) {
          i++;
        }
        out += source.slice(start, i);
        if (i >= source.length) {
          throw SyntaxErrorAt("Unterminated string", start);
        }
        var c = source[i];
        if (c === '"') {
          i++;
          return out;
        }
        if (c !== "\\") {
          throw SyntaxErrorAt("Invalid control character", i);
        }
        var escape = source[i + 1];
        i += 2;
        var simple = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        if (escape in simple) {
          out += simple[escape];
        } else if (escape === "u" && /^[0-9a-fA-F]{4}$/.test(source.substr(i, 4))) {
          out += String.fromCharCode(parseInt(source.substr(i, 4), 16));
          i += 4;
        } else {
          throw SyntaxErrorAt("Invalid \\escape", i - 2);
        }
      }
    }

    function array() {
      i++;
      var out = [];
      whitespace();
      if (source[i] === "]") {
        i++;
        return out;
      }
      for (;;) {
        out.push(value());
        whitespace();
        if (source[i] === ",") {
          i++;
          continue;
        }
        if (source[i] === "]") {
          i++;
          return out;
        }
        throw SyntaxErrorAt("Expecting ',' delimiter", i);
      }
    }

    function object() {
      i++;
      var out = {};
      whitespace();
      if (source[i] === "}") {
        i++;
        return out;
      }
      for (;;) {
        whitespace();
        if (source[i] !== '"') {
          throw SyntaxErrorAt("Expecting property name enclosed in double quotes", i);
        }
        var key = string();
        whitespace();
        if (source[i] !== ":") {
          throw SyntaxErrorAt("Expecting ':' delimiter", i);
        }
        i++;
        var item = value();
        if (key === "__proto__") {
          Object.defineProperty(out, key, { value: item, enumerable: true, writable: true,
                                            configurable: true });
        } else {
          out[key] = item;
        }
        whitespace();
        if (source[i] === ",") {
          i++;
          continue;
        }
        if (source[i] === "}") {
          i++;
          return out;
        }
        throw SyntaxErrorAt("Expecting ',' delimiter", i);
      }
    }

    var result = value();
    whitespace();
    if (i < source.length) {
      throw SyntaxErrorAt("Extra data", i);
    }
    return result;
  }

  function quote(value, ensureAscii) {
    var pattern = ensureAscii ? /[\\"]|[^ -~]/g : /[\\"\u0000-\u001f]/g;
    return '"' + value.replace(pattern, function (c) {
      var named = { '"': '\\"', "\\": "\\\\", "\n": "\\n", "\r": "\\r", "\t": "\\t",
                    "\b": "\\b", "\f": "\\f" };
      return named[c] || "\\u" + ("000" + c.charCodeAt(0).toString(16)).slice(-4);
    }) + '"';
  }

  function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) &&
      !(value instanceof PyFloat) && !(value instanceof PyInt);
  }

  function compare(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  // json.dumps(value, indent=2, sort_keys=True, ensure_ascii=ensureAscii,
  // separators=(",", ": ")).
  function dumps(value, ensureAscii) {
    function write(item, depth) {
      if (item === null || item === undefined) {
        return "null";
      }
      if (item === true) {
        return "true";
      }
      if (item === false) {
        return "false";
      }
      if (typeof item === "string") {
        return quote(item, ensureAscii);
      }
      if (typeof item === "number") {
        return Number.isInteger(item) ? String(item) : floatRepr(item);
      }
      if (item instanceof PyFloat || item instanceof PyInt) {
        return String(item);
      }
      var inner = "\n" + new Array(depth + 2).join("  ");
      var outer = "\n" + new Array(depth + 1).join("  ");
      if (Array.isArray(item)) {
        if (!item.length) {
          return "[]";
        }
        return "[" + inner + item.map(function (entry) {
          return write(entry, depth + 1);
        }).join("," + inner) + outer + "]";
      }
      var keys = Object.keys(item).sort(compare);
      if (!keys.length) {
        return "{}";
      }
      return "{" + inner + keys.map(function (key) {
        return quote(key, ensureAscii) + ": " + write(item[key], depth + 1);
      }).join("," + inner) + outer + "}";
    }
    return write(value, 0);
  }

  // Python's truthiness, for values that came out of parse.
  function truthy(value) {
    if (value === null || value === undefined || value === false || value === "" || value === 0) {
      return false;
    }
    if (value instanceof PyFloat) {
      return value.value !== 0;
    }
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    if (isPlainObject(value)) {
      return Object.keys(value).length > 0;
    }
    return true;
  }

  // Python's str() of a value from parse, for the places the converter turns
  // a manifest value into text.
  function str(value) {
    if (typeof value === "string") {
      return value;
    }
    if (value === true) {
      return "True";
    }
    if (value === false) {
      return "False";
    }
    if (value === null || value === undefined) {
      return "None";
    }
    if (typeof value === "number") {
      return Number.isInteger(value) ? String(value) : floatRepr(value);
    }
    if (value instanceof PyFloat || value instanceof PyInt) {
      return String(value);
    }
    return JSON.stringify(value);
  }

  W2S.pyjson = {
    PyFloat: PyFloat,
    PyInt: PyInt,
    parse: parse,
    dumps: dumps,
    truthy: truthy,
    str: str,
    isPlainObject: isPlainObject,
    floatRepr: floatRepr
  };
})(typeof globalThis.W2S === "object" ? globalThis.W2S : (globalThis.W2S = {}));
