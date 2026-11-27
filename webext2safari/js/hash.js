// SHA-1 and SHA-256 over byte arrays.
//
// A .safariextz is checksummed and signed with SHA-1, a certificate is signed
// with SHA-256, and Chrome derives an extension's ID from the SHA-256 of its
// public key. WebCrypto is not available everywhere the converter runs, so
// both are computed here.

(function (W2S) {
  "use strict";

  // Pads a message the way both hashes expect and returns it as big-endian
  // 32-bit words.
  function words(bytes) {
    var length = bytes.length;
    var total = ((length + 9 + 63) >> 6) << 6;
    var padded = new Uint8Array(total);
    padded.set(bytes);
    padded[length] = 0x80;
    var bits = length * 8;
    var view = new DataView(padded.buffer);
    view.setUint32(total - 8, Math.floor(bits / 0x100000000));
    view.setUint32(total - 4, bits >>> 0);
    var out = new Int32Array(total / 4);
    for (var i = 0; i < out.length; i++) {
      out[i] = view.getInt32(i * 4);
    }
    return out;
  }

  function digest(state) {
    var out = new Uint8Array(state.length * 4);
    var view = new DataView(out.buffer);
    state.forEach(function (value, i) { view.setInt32(i * 4, value); });
    return out;
  }

  function sha1(bytes) {
    var m = words(bytes);
    var h0 = 0x67452301, h1 = 0xEFCDAB89 | 0, h2 = 0x98BADCFE | 0, h3 = 0x10325476, h4 = 0xC3D2E1F0 | 0;
    var w = new Int32Array(80);
    for (var block = 0; block < m.length; block += 16) {
      for (var t = 0; t < 16; t++) {
        w[t] = m[block + t];
      }
      for (t = 16; t < 80; t++) {
        var x = w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16];
        w[t] = (x << 1) | (x >>> 31);
      }
      var a = h0, b = h1, c = h2, d = h3, e = h4;
      for (t = 0; t < 80; t++) {
        var f, k;
        if (t < 20) {
          f = (b & c) | (~b & d);
          k = 0x5A827999;
        } else if (t < 40) {
          f = b ^ c ^ d;
          k = 0x6ED9EBA1;
        } else if (t < 60) {
          f = (b & c) | (b & d) | (c & d);
          k = 0x8F1BBCDC | 0;
        } else {
          f = b ^ c ^ d;
          k = 0xCA62C1D6 | 0;
        }
        var temp = (((a << 5) | (a >>> 27)) + f + e + k + w[t]) | 0;
        e = d;
        d = c;
        c = (b << 30) | (b >>> 2);
        b = a;
        a = temp;
      }
      h0 = (h0 + a) | 0;
      h1 = (h1 + b) | 0;
      h2 = (h2 + c) | 0;
      h3 = (h3 + d) | 0;
      h4 = (h4 + e) | 0;
    }
    return digest([h0, h1, h2, h3, h4]);
  }

  var K256 = new Int32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);

  function sha256(bytes) {
    var m = words(bytes);
    var h = new Int32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                            0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    var w = new Int32Array(64);
    function rotr(value, count) {
      return (value >>> count) | (value << (32 - count));
    }
    for (var block = 0; block < m.length; block += 16) {
      for (var t = 0; t < 16; t++) {
        w[t] = m[block + t];
      }
      for (t = 16; t < 64; t++) {
        var s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
        var s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
      }
      var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (t = 0; t < 64; t++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var temp1 = (hh + S1 + ch + K256[t] + w[t]) | 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var temp2 = (S0 + maj) | 0;
        hh = g;
        g = f;
        f = e;
        e = (d + temp1) | 0;
        d = c;
        c = b;
        b = a;
        a = (temp1 + temp2) | 0;
      }
      h[0] = (h[0] + a) | 0;
      h[1] = (h[1] + b) | 0;
      h[2] = (h[2] + c) | 0;
      h[3] = (h[3] + d) | 0;
      h[4] = (h[4] + e) | 0;
      h[5] = (h[5] + f) | 0;
      h[6] = (h[6] + g) | 0;
      h[7] = (h[7] + hh) | 0;
    }
    return digest(Array.prototype.slice.call(h));
  }

  W2S.hash = { sha1: sha1, sha256: sha256 };
})(typeof globalThis.W2S === "object" ? globalThis.W2S : (globalThis.W2S = {}));
