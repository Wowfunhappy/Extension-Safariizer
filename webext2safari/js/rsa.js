// RSA keys, PKCS #1 v1.5 signatures and a self-signed certificate.
//
// A .safariextz carries an RSA signature over its table of contents and the
// X.509 certificate of the key that made it. Safari normally insists on an
// Apple-issued certificate; with AllowSelfSignedSafariExtensions loaded it
// accepts one shaped like Extension Builder's, which this makes. Arithmetic is
// done with BigInt.

(function (W2S) {
  "use strict";

  var bytes = W2S.bytes;
  var hash = W2S.hash;

  // Safari reads the team identifier it files an extension under from the
  // certificate's common name, which has to be "Safari Developer: (ID) " and
  // an email address; with anything else after the identifier it finds none
  // and refuses the archive. The identifier stays the same whichever key is
  // generated, so a converted extension can be updated by a later conversion
  // even after a new key is made. Safari ends the extension's address with
  // it, and refuses one in lowercase letters; one of digits alone leaves the
  // address in lowercase, as a Chrome extension's is, which extensions
  // compare origins in.
  var COMMON_NAME = "Safari Developer: (9203582716) webext2safari@localhost";

  function randomBytes(count) {
    var out = new Uint8Array(count);
    var source = globalThis.crypto;
    if (source && source.getRandomValues) {
      for (var i = 0; i < count; i += 65536) {
        source.getRandomValues(out.subarray(i, Math.min(count, i + 65536)));
      }
    } else {
      for (var j = 0; j < count; j++) {
        out[j] = Math.floor(Math.random() * 256);
      }
    }
    return out;
  }

  function toBigInt(value) {
    var digits = bytes.hex(value);
    return BigInt("0x" + (digits || "0"));
  }

  function fromBigInt(value, length) {
    var digits = value.toString(16);
    if (digits.length % 2) {
      digits = "0" + digits;
    }
    var size = Math.max(length || 0, digits.length / 2);
    var out = new Uint8Array(size);
    var offset = size - digits.length / 2;
    for (var i = 0; i < digits.length; i += 2) {
      out[offset + i / 2] = parseInt(digits.substr(i, 2), 16);
    }
    return out;
  }

  function modPow(base, exponent, modulus) {
    var result = 1n;
    base %= modulus;
    while (exponent > 0n) {
      if (exponent & 1n) {
        result = result * base % modulus;
      }
      exponent >>= 1n;
      base = base * base % modulus;
    }
    return result;
  }

  function modInverse(value, modulus) {
    var a = value % modulus, m = modulus;
    var x0 = 0n, x1 = 1n;
    while (a > 1n) {
      var q = a / m;
      var t = m;
      m = a % m;
      a = t;
      t = x0;
      x0 = x1 - q * x0;
      x1 = t;
    }
    return x1 < 0n ? x1 + modulus : x1;
  }

  var SMALL_PRIMES = (function () {
    var out = [];
    for (var n = 3; out.length < 400; n += 2) {
      if (out.every(function (p) { return n % p; })) {
        out.push(n);
      }
    }
    return out;
  })();

  function probablyPrime(n, rounds) {
    var d = n - 1n, r = 0;
    while (!(d & 1n)) {
      d >>= 1n;
      r++;
    }
    var size = (n.toString(16).length + 1) >> 1;
    for (var i = 0; i < rounds; i++) {
      var a = toBigInt(randomBytes(size)) % (n - 3n) + 2n;
      var x = modPow(a, d, n);
      if (x === 1n || x === n - 1n) {
        continue;
      }
      var composite = true;
      for (var j = 1; j < r; j++) {
        x = x * x % n;
        if (x === n - 1n) {
          composite = false;
          break;
        }
      }
      if (composite) {
        return false;
      }
    }
    return true;
  }

  // A random prime of `bits` bits whose top two bits are set, so the product
  // of two of them has exactly twice as many.
  function randomPrime(bits) {
    var raw = randomBytes(bits / 8);
    raw[0] |= 0xC0;
    raw[raw.length - 1] |= 1;
    var candidate = toBigInt(raw);
    var residues = SMALL_PRIMES.map(function (p) { return Number(candidate % BigInt(p)); });
    for (var step = 0; ; step += 2) {
      var sieved = true;
      for (var i = 0; i < SMALL_PRIMES.length; i++) {
        if ((residues[i] + step) % SMALL_PRIMES[i] === 0) {
          sieved = false;
          break;
        }
      }
      if (sieved) {
        var n = candidate + BigInt(step);
        if ((n - 1n) % 65537n && probablyPrime(n, 40)) {
          return n;
        }
      }
    }
  }

  function generateKey(bits) {
    bits = bits || 2048;
    var e = 65537n;
    for (;;) {
      var p = randomPrime(bits / 2);
      var q = randomPrime(bits / 2);
      if (p === q) {
        continue;
      }
      if (p < q) {
        var t = p;
        p = q;
        q = t;
      }
      var n = p * q;
      var phi = (p - 1n) * (q - 1n);
      var d = modInverse(e, phi);
      return {
        n: n, e: e, d: d, p: p, q: q,
        dp: d % (p - 1n), dq: d % (q - 1n), qi: modInverse(q, p)
      };
    }
  }

  // -- DER ------------------------------------------------------------- //

  function tlv(tag, content) {
    var length = content.length;
    var header;
    if (length < 128) {
      header = [tag, length];
    } else {
      var size = [];
      for (var l = length; l > 0; l >>= 8) {
        size.unshift(l & 255);
      }
      header = [tag, 0x80 | size.length].concat(size);
    }
    return bytes.concat([new Uint8Array(header), content]);
  }

  function sequence(items) {
    return tlv(0x30, bytes.concat(items));
  }

  function integer(value) {
    var raw = typeof value === "bigint" ? fromBigInt(value) : value;
    var start = 0;
    while (start < raw.length - 1 && raw[start] === 0 && !(raw[start + 1] & 0x80)) {
      start++;
    }
    raw = raw.subarray(start);
    if (raw[0] & 0x80) {
      raw = bytes.concat([new Uint8Array([0]), raw]);
    }
    return tlv(0x02, raw);
  }

  function oid(dotted) {
    var parts = dotted.split(".").map(Number);
    var out = [parts[0] * 40 + parts[1]];
    parts.slice(2).forEach(function (part) {
      var chunk = [part & 127];
      for (part = Math.floor(part / 128); part > 0; part = Math.floor(part / 128)) {
        chunk.unshift(0x80 | (part & 127));
      }
      out = out.concat(chunk);
    });
    return tlv(0x06, new Uint8Array(out));
  }

  var NULL = new Uint8Array([0x05, 0x00]);

  function bitString(content) {
    return tlv(0x03, bytes.concat([new Uint8Array([0]), content]));
  }

  function utcTime(date) {
    function two(n) { return (n < 10 ? "0" : "") + n; }
    var value = two(date.getUTCFullYear() % 100) + two(date.getUTCMonth() + 1) +
      two(date.getUTCDate()) + two(date.getUTCHours()) + two(date.getUTCMinutes()) +
      two(date.getUTCSeconds()) + "Z";
    return tlv(0x17, bytes.utf8(value));
  }

  function name(commonName) {
    return sequence([tlv(0x31, sequence([oid("2.5.4.3"), tlv(0x0C, bytes.utf8(commonName))]))]);
  }

  function extension(id, critical, value) {
    var items = [oid(id)];
    if (critical) {
      items.push(new Uint8Array([0x01, 0x01, 0xFF]));
    }
    items.push(tlv(0x04, value));
    return sequence(items);
  }

  // -- signatures ------------------------------------------------------ //

  var SHA256_ALGORITHM = sequence([oid("2.16.840.1.101.3.4.2.1"), NULL]);
  var SHA1_ALGORITHM = sequence([oid("1.3.14.3.2.26"), NULL]);

  function digestInfo(algorithm, digest) {
    return sequence([algorithm, tlv(0x04, digest)]);
  }

  // RSASSA-PKCS1-v1_5 over an already-encoded DigestInfo.
  function signDigestInfo(key, info) {
    var size = (key.n.toString(16).length + 1) >> 1;
    var block = new Uint8Array(size);
    block[1] = 1;
    for (var i = 2; i < size - info.length - 1; i++) {
      block[i] = 0xFF;
    }
    block.set(info, size - info.length);
    var m = toBigInt(block);
    // Chinese remainder theorem: two half-size exponentiations.
    var m1 = modPow(m, key.dp, key.p);
    var m2 = modPow(m, key.dq, key.q);
    var h = key.qi * ((m1 - m2) % key.p + key.p) % key.p;
    return fromBigInt(m2 + h * key.q, size);
  }

  function signSha1(key, data) {
    return signDigestInfo(key, digestInfo(SHA1_ALGORITHM, hash.sha1(data)));
  }

  function signSha256(key, data) {
    return signDigestInfo(key, digestInfo(SHA256_ALGORITHM, hash.sha256(data)));
  }

  function publicKeyInfo(key) {
    return sequence([
      sequence([oid("1.2.840.113549.1.1.1"), NULL]),
      bitString(sequence([integer(key.n), integer(key.e)]))
    ]);
  }

  // A DER X.509 certificate for `key`, issued by itself, with the extensions
  // a Safari developer certificate carries: not a CA, for digital
  // signatures, Safari extension signing.
  function certificate(key, options) {
    options = options || {};
    var now = options.now || new Date();
    var notBefore = new Date(now.getTime() - 24 * 3600 * 1000);
    var notAfter = new Date(Date.UTC(now.getUTCFullYear() + 10, now.getUTCMonth(), now.getUTCDate()));
    var serial = randomBytes(8);
    serial[0] &= 0x7F;
    serial[0] |= 0x01;
    var algorithm = sequence([oid("1.2.840.113549.1.1.11"), NULL]);
    var subject = name(options.commonName || COMMON_NAME);
    var tbs = sequence([
      tlv(0xA0, integer(2n)),
      integer(serial),
      algorithm,
      subject,
      sequence([utcTime(notBefore), utcTime(notAfter)]),
      subject,
      publicKeyInfo(key),
      tlv(0xA3, sequence([
        extension("2.5.29.19", true, sequence([])),
        extension("2.5.29.15", true, new Uint8Array([0x03, 0x02, 0x07, 0x80])),
        extension("2.5.29.37", false, sequence([oid("1.2.840.113635.100.4.8")])),
        extension("1.2.840.113635.100.6.1.5", true, NULL)
      ]))
    ]);
    return sequence([tbs, algorithm, bitString(signSha256(key, tbs))]);
  }

  // A signing identity: a key and its certificate, as plain JSON so it can be
  // stored and read back.
  function createIdentity(options) {
    var key = generateKey(2048);
    return serializeIdentity(key, certificate(key, options));
  }

  var KEY_FIELDS = ["n", "e", "d", "p", "q", "dp", "dq", "qi"];

  function serializeIdentity(key, cert) {
    var out = { certificate: bytes.base64(cert) };
    KEY_FIELDS.forEach(function (field) { out[field] = key[field].toString(16); });
    return out;
  }

  function loadIdentity(stored) {
    var key = {};
    KEY_FIELDS.forEach(function (field) { key[field] = BigInt("0x" + stored[field]); });
    return { key: key, certificate: bytes.fromBase64(stored.certificate) };
  }

  W2S.rsa = {
    COMMON_NAME: COMMON_NAME,
    generateKey: generateKey,
    certificate: certificate,
    createIdentity: createIdentity,
    loadIdentity: loadIdentity,
    signSha1: signSha1,
    signSha256: signSha256,
    modPow: modPow,
    toBigInt: toBigInt,
    fromBigInt: fromBigInt,
    randomBytes: randomBytes
  };
})(typeof globalThis.W2S === "object" ? globalThis.W2S : (globalThis.W2S = {}));
