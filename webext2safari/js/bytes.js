// Byte and text helpers shared by the JavaScript converter.
//
// Every module of the converter attaches itself to the `W2S` namespace on the
// global object, so the same files load as plain scripts in the Safari
// extension's global page and through webext2safari/js/node.js in Node.

(function (W2S) {
  "use strict";

  W2S.pako = globalThis.pako;

  var encoder = new TextEncoder();

  function utf8(text) {
    return encoder.encode(text);
  }

  // Decodes UTF-8, replacing what is not, as Python's errors="replace" does.
  // A byte order mark is kept, as Python keeps it.
  function text(bytes) {
    return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  }

  // Decodes UTF-8, or returns null when the bytes are not valid UTF-8.
  function strictText(bytes) {
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch (e) {
      return null;
    }
  }

  function latin1(bytes) {
    var out = "";
    for (var i = 0; i < bytes.length; i += 8192) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    }
    return out;
  }

  function fromLatin1(value) {
    var out = new Uint8Array(value.length);
    for (var i = 0; i < value.length; i++) {
      out[i] = value.charCodeAt(i) & 255;
    }
    return out;
  }

  // Text written back the way it was read: UTF-8, or Latin-1 for a file that
  // was not valid UTF-8.
  function decodeKeepingEncoding(bytes) {
    var value = strictText(bytes);
    if (value !== null) {
      return { text: value, encode: utf8 };
    }
    return { text: latin1(bytes), encode: fromLatin1 };
  }

  function concat(parts) {
    var length = 0;
    parts.forEach(function (part) { length += part.length; });
    var out = new Uint8Array(length);
    var offset = 0;
    parts.forEach(function (part) {
      out.set(part, offset);
      offset += part.length;
    });
    return out;
  }

  function equal(a, b) {
    if (a.length !== b.length) {
      return false;
    }
    for (var i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        return false;
      }
    }
    return true;
  }

  var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  function base64(bytes) {
    var out = "";
    for (var i = 0; i < bytes.length; i += 3) {
      var a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
      out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)] +
        (i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : "=") +
        (i + 2 < bytes.length ? B64[c & 63] : "=");
    }
    return out;
  }

  function fromBase64(value) {
    value = value.replace(/[^A-Za-z0-9+/]/g, "");
    var out = new Uint8Array(Math.floor(value.length * 3 / 4));
    var bits = 0, count = 0, j = 0;
    for (var i = 0; i < value.length; i++) {
      bits = (bits << 6) | B64.indexOf(value[i]);
      count += 6;
      if (count >= 8) {
        count -= 8;
        out[j++] = (bits >> count) & 255;
      }
    }
    return out.subarray(0, j);
  }

  function hex(bytes) {
    var out = "";
    for (var i = 0; i < bytes.length; i++) {
      out += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
    }
    return out;
  }

  var CRC_TABLE = (function () {
    var table = new Int32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) {
        c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c;
    }
    return table;
  })();

  function crc32(bytes) {
    var crc = -1;
    for (var i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
    }
    return (crc ^ -1) >>> 0;
  }

  W2S.bytes = {
    utf8: utf8,
    text: text,
    strictText: strictText,
    latin1: latin1,
    fromLatin1: fromLatin1,
    decodeKeepingEncoding: decodeKeepingEncoding,
    concat: concat,
    equal: equal,
    base64: base64,
    fromBase64: fromBase64,
    hex: hex,
    crc32: crc32
  };
})(typeof globalThis.W2S === "object" ? globalThis.W2S : (globalThis.W2S = {}));
