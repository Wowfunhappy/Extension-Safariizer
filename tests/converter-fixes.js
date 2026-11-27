// Tests of the converter's archive, image and page handling on input that is
// unusual or hostile.
//
//     node tests/converter-fixes.js

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const url = require("url");
const zlib = require("zlib");
const W2S = require("../webext2safari/js/node.js");

const ROOT = path.resolve(__dirname, "..");

let passed = 0;
let failed = 0;

function equal(message, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log("  ok    " + message);
  } else {
    failed++;
    console.log("  FAIL  " + message + " - got " + a + ", expected " + e);
  }
}

// The name and message `run` throws, or null if it returns.
function thrown(run) {
  try {
    run();
    return null;
  } catch (e) {
    return (e && e.name) + ": " + (e && e.message);
  }
}

function matches(message, actual, pattern) {
  equal(message + " (" + actual + ")", pattern.test(String(actual)), true);
}

// -- building PNGs ----------------------------------------------------- //

function pngChunk(tag, payload) {
  const body = Buffer.concat([Buffer.from(tag, "latin1"), payload]);
  const out = Buffer.alloc(payload.length + 12);
  out.writeUInt32BE(payload.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(zlib.crc32(body), payload.length + 8);
  return out;
}

function pngFile(width, height, depth, colour, interlace, data, extra) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = depth;
  header[9] = colour;
  header[12] = interlace;
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk("IHDR", header)
  ].concat(extra || [], [pngChunk("IDAT", zlib.deflateSync(data)), pngChunk("IEND", Buffer.alloc(0))])));
}

// Packs samples into a scanline at `depth` bits each, after a filter byte.
function scanline(samples, depth) {
  const out = [0];
  if (depth === 16) {
    samples.forEach((s) => out.push(s >> 8, s & 255));
  } else if (depth === 8) {
    samples.forEach((s) => out.push(s));
  } else {
    let acc = 0;
    let bits = 0;
    samples.forEach((s) => {
      acc = (acc << depth) | s;
      bits += depth;
      if (bits === 8) {
        out.push(acc);
        acc = 0;
        bits = 0;
      }
    });
    if (bits) {
      out.push(acc << (8 - bits));
    }
  }
  return out;
}

const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

// The scanlines of an image, interlaced or not, from `sample(x, y, channel)`.
function imageData(width, height, channels, depth, interlace, sample) {
  const bytes = [];
  (interlace ? ADAM7 : [[0, 0, 1, 1]]).forEach(([x0, y0, dx, dy]) => {
    if (x0 >= width) {
      return;
    }
    for (let y = y0; y < height; y += dy) {
      const samples = [];
      for (let x = x0; x < width; x += dx) {
        for (let c = 0; c < channels; c++) {
          samples.push(sample(x, y, c));
        }
      }
      bytes.push.apply(bytes, scanline(samples, depth));
    }
  });
  return Buffer.from(bytes);
}

function hex(data) {
  return Buffer.from(data).toString("hex");
}

// -- building archives ------------------------------------------------- //

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

function u64(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

// A zip of `entries`, each {name: Buffer, data: Buffer, method, crc, size,
// flags, at: index of an earlier entry whose stored bytes it shares}.
function zipFile(entries, options) {
  options = options || {};
  const parts = [];
  const central = [];
  const offsets = [];
  let offset = 0;
  entries.forEach((entry, index) => {
    const name = Buffer.isBuffer(entry.name) ? entry.name : Buffer.from(entry.name);
    const method = entry.method || 0;
    const stored = method === 8 ? zlib.deflateRawSync(entry.data) : entry.data;
    const crc = entry.crc === undefined ? zlib.crc32(entry.data) : entry.crc;
    const size = entry.size === undefined ? entry.data.length : entry.size;
    const flags = entry.flags || 0;
    const fields = Buffer.concat([u16(20), u16(flags), u16(method), u16(0), u16(0), u32(crc),
                                  u32(stored.length), u32(size), u16(name.length), u16(0)]);
    let at = offset;
    if (entry.at === undefined) {
      const local = Buffer.concat([Buffer.from("PK\x03\x04", "latin1"), fields, name, stored]);
      parts.push(local);
      offset += local.length;
    } else {
      at = offsets[entry.at];
    }
    offsets[index] = at;
    central.push(Buffer.concat([Buffer.from("PK\x01\x02", "latin1"), u16(20), fields, u16(0), u16(0),
                                u16(0), u32(0), u32(at), name]));
  });
  const directory = Buffer.concat(central);
  const count = entries.length;
  const tail = [];
  if (options.zip64) {
    tail.push(Buffer.from("PK\x06\x06", "latin1"), u64(44), u16(45), u16(45), u32(0), u32(0),
              u64(count), u64(count), u64(directory.length), u64(offset));
    tail.push(Buffer.from("PK\x06\x07", "latin1"), u32(0), u64(offset + directory.length), u32(1));
    tail.push(Buffer.from("PK\x05\x06", "latin1"), u16(0), u16(0), u16(0xFFFF), u16(0xFFFF),
              u32(0xFFFFFFFF), u32(0xFFFFFFFF), u16(0));
  } else {
    tail.push(Buffer.from("PK\x05\x06", "latin1"), u16(0), u16(0), u16(count), u16(count),
              u32(directory.length), u32(offset), u16(0));
  }
  return new Uint8Array(Buffer.concat([options.prefix || Buffer.alloc(0)].concat(parts, [directory], tail)));
}

function extracted(archive) {
  const tree = new W2S.tree.Tree();
  W2S.zip.extract(archive, tree);
  return tree;
}

// -- the Public Suffix List -------------------------------------------- //

function testPublicSuffix() {
  console.log("Public Suffix List");
  const tool = fs.readFileSync(path.join(ROOT, "tools", "update-public-suffix.js"), "utf8");
  const start = tool.indexOf("function ");
  const body = tool.slice(start, tool.indexOf("async function main"));
  const rules = new Function("url", body + "\nreturn rules;")(url);
  equal("numeric labels stay as they are",
        rules("0.bg\n2000.hu\n*.1.test.example\n!4.example\n"),
        ["0.bg", "2000.hu", "*.1.test.example", "!4.example"]);
  equal("an internationalized rule takes its ASCII form", rules("個人.hk\nÉX.com\n"),
        ["xn--gmqw5a.hk", "xn--x-9fa.com"]);

  const list = fs.readFileSync(path.join(ROOT, "webext2safari", "runtime", "public-suffix-list.txt"), "utf8")
    .split("\n");
  equal("no rule of the shipped list holds an address",
        list.filter((rule) => /(^|\.)\d+\.\d+\.\d+\.\d+(\.|$)/.test(rule)), []);
  ["0.bg", "9.bg", "2000.hu", "611.to", "4.at", "1337.pictures", "2038.io", "1.azurestaticapps.net",
    "7.azurestaticapps.net", "*.1.test.code-builder-stg.platform.salesforce.com"].forEach((rule) => {
    equal("the shipped list has " + rule, list.indexOf(rule) >= 0, true);
  });
}

// -- unpacked directories ---------------------------------------------- //

function testLinks() {
  console.log("Links in an unpacked directory");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "webext2safari-links-"));
  try {
    const shared = path.join(base, "shared");
    const root = path.join(base, "extension");
    fs.mkdirSync(shared);
    fs.mkdirSync(path.join(root, "d"), { recursive: true });
    fs.writeFileSync(path.join(shared, "lib.js"), "shared");
    fs.writeFileSync(path.join(root, "manifest.json"), "{}");
    fs.symlinkSync("..", path.join(root, "d", "up"));
    fs.symlinkSync("self", path.join(root, "self"));
    fs.symlinkSync(path.join(base, "nothing"), path.join(root, "dangling"));
    fs.symlinkSync(shared, path.join(root, "linked"));
    fs.symlinkSync(path.join(shared, "lib.js"), path.join(root, "file.js"));
    fs.writeFileSync(path.join(root, "d", "a.txt"), "a");
    let paths = null;
    let error = thrown(() => { paths = W2S.node.readDirectory(root).paths(); });
    equal("a cycle of links, or a link to nothing, does not stop the reading", error, null);
    equal("every file is read, through links that lead outside too", paths,
          ["d/a.txt", "file.js", "linked/lib.js", "manifest.json"]);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

// -- PNG --------------------------------------------------------------- //

function testPngSizes() {
  console.log("PNG sizes");
  const started = Date.now();
  const short = thrown(() => W2S.png.read(pngFile(1 << 27, 1, 8, 6, 0, Buffer.alloc(10))));
  matches("an image that cannot fill its declared size is refused", short, /UnsupportedPNG: truncated/);
  equal("and is refused at once", Date.now() - started < 1000, true);
  const huge = thrown(() => W2S.png.read(pngFile(0x10000, 0x10000, 8, 6, 0, Buffer.alloc(10))));
  matches("an image over the pixel limit is refused", huge, /UnsupportedPNG: too large/);

  // A stream with far more data than the image needs is not inflated in full.
  const needed = Buffer.from([0, 1, 2, 3, 4]);
  const surplus = pngFile(1, 1, 8, 6, 0, Buffer.concat([needed, Buffer.alloc(8 * 1024 * 1024)]));
  const pako = W2S.pako;
  const RealInflate = pako.Inflate;
  let inflator = null;
  pako.Inflate = function (options) {
    inflator = new RealInflate(options);
    return inflator;
  };
  try {
    equal("what the image needs is decoded", Array.from(W2S.png.read(surplus).pixels), [1, 2, 3, 4]);
  } finally {
    pako.Inflate = RealInflate;
  }
  equal("the rest is left unread", inflator.strm.total_out <= 64 * 1024, true);
}

function testInterlace() {
  console.log("PNG interlacing");
  const types = [[0, 1, 1], [0, 2, 1], [0, 4, 1], [0, 8, 1], [0, 16, 1], [2, 8, 3], [2, 16, 3],
    [3, 1, 1], [3, 2, 1], [3, 4, 1], [3, 8, 1], [4, 8, 2], [4, 16, 2], [6, 8, 4], [6, 16, 4]];
  const sizes = [[1, 1], [1, 9], [9, 1], [2, 2], [3, 5], [4, 4], [5, 3], [8, 8], [9, 9], [17, 11]];
  let wrong = [];
  types.forEach(([colour, depth, channels]) => {
    const maximum = Math.pow(2, depth) - 1;
    const palette = [];
    for (let i = 0; i < 3 * 256; i++) {
      palette.push((i * 37) & 255);
    }
    const extra = colour === 3 ? [pngChunk("PLTE", Buffer.from(palette))] : [];
    sizes.forEach(([width, height]) => {
      const sample = (x, y, c) => (x * 31 + y * 57 + c * 101 + 13) % (maximum + 1);
      const plain = W2S.png.read(pngFile(width, height, depth, colour, 0,
                                         imageData(width, height, channels, depth, false, sample), extra));
      let laced = null;
      try {
        laced = W2S.png.read(pngFile(width, height, depth, colour, 1,
                                     imageData(width, height, channels, depth, true, sample), extra));
      } catch (e) {
        laced = { pixels: [] };
      }
      if (hex(plain.pixels) !== hex(laced.pixels)) {
        wrong.push([colour, depth, width, height]);
      }
    });
  });
  equal("interlaced images decode as their plain twins do, in every type", wrong, []);

  const flat = imageData(9, 9, 4, 8, true, (x, y, c) => [x * 20, y * 20, 7, 255][c]);
  const image = W2S.png.read(pngFile(9, 9, 8, 6, 1, flat));
  const at = (x, y) => Array.from(image.pixels.subarray((y * 9 + x) * 4, (y * 9 + x + 1) * 4));
  equal("a pixel of the first pass", at(8, 8), [160, 160, 7, 255]);
  equal("a pixel of the last pass", at(3, 5), [60, 100, 7, 255]);
  equal("a short interlaced image is refused",
        /truncated/.test(thrown(() => W2S.png.read(pngFile(9, 9, 8, 6, 1, flat.subarray(0, 100))))), true);
  equal("an unknown interlace method is refused",
        /interlace/.test(thrown(() => W2S.png.read(pngFile(1, 1, 8, 6, 2, Buffer.alloc(5))))), true);
}

function testTransparency() {
  console.log("PNG transparency at 16 bits");
  const trns = (values) => {
    const b = Buffer.alloc(values.length * 2);
    values.forEach((v, i) => b.writeUInt16BE(v, i * 2));
    return [pngChunk("tRNS", b)];
  };
  const rgb = W2S.png.read(pngFile(2, 1, 16, 2, 0, Buffer.from(scanline(
    [0x1200, 0x3400, 0x5600, 0x12FF, 0x34FF, 0x56FF], 16)), trns([0x12FF, 0x34FF, 0x56FF])));
  equal("only the exact colour is transparent", Array.from(rgb.pixels),
        [0x12, 0x34, 0x56, 255, 0x12, 0x34, 0x56, 0]);
  const grey = W2S.png.read(pngFile(2, 1, 16, 0, 0, Buffer.from(scanline([0x1200, 0x12FF], 16)), trns([0x12FF])));
  equal("only the exact grey is transparent", Array.from(grey.pixels),
        [0x12, 0x12, 0x12, 255, 0x12, 0x12, 0x12, 0]);
  const eight = W2S.png.read(pngFile(2, 1, 8, 0, 0, Buffer.from(scanline([0x12, 0x13], 8)), trns([0x13])));
  equal("8-bit images still match their sample", Array.from(eight.pixels),
        [0x12, 0x12, 0x12, 255, 0x13, 0x13, 0x13, 0]);
}

// -- ZIP --------------------------------------------------------------- //

function testZipSizes() {
  console.log("ZIP sizes");
  const data = Buffer.alloc(1024 * 1024);
  const quarter = W2S.zip.MAX_TOTAL_SIZE / 4 + 1;
  const declared = [];
  for (let i = 0; i < 4; i++) {
    declared.push({ name: "f" + i, data: Buffer.from("x"), size: quarter });
  }
  const tree = new W2S.tree.Tree();
  matches("an archive declaring too much is refused", thrown(() => W2S.zip.extract(zipFile(declared), tree)),
          /ArchiveError: the archive unpacks to more than/);
  equal("before anything is unpacked", tree.paths(), []);

  matches("a member larger than it declares is stopped",
          thrown(() => extracted(zipFile([{ name: "f", data, method: 8, size: 10 }]))),
          /ArchiveError: File f is larger/);

  const shared = extracted(zipFile([{ name: "a", data, method: 8 }, { name: "b", data, method: 8, at: 0 }]));
  equal("members may share stored data", shared.paths().map((p) => [p, shared.read(p).length]),
        [["a", data.length], ["b", data.length]]);
  equal("an empty deflated member reads",
        extracted(zipFile([{ name: "e", data: Buffer.alloc(0), method: 8 }])).read("e").length, 0);
  const corrupt = zipFile([{ name: "f", data: Buffer.from("hello"), method: 8, crc: 1 }]);
  matches("a wrong checksum is reported", thrown(() => extracted(corrupt)), /ArchiveError: Bad CRC-32/);
}

function testZipNames() {
  console.log("ZIP names");
  const member = (name, flags) => zipFile([{ name, data: Buffer.from("x"), flags }]);
  equal("UTF-8 without the flag is read as UTF-8",
        extracted(member(Buffer.from("icône.png"))).paths(), ["icône.png"]);
  equal("what is not UTF-8 is read as CP437",
        extracted(member(Buffer.from([0x63, 0x82, 0x2E, 0x70, 0x6E, 0x67]))).paths(), ["cé.png"]);
  equal("UTF-8 with the flag is read as UTF-8",
        extracted(member(Buffer.from("é.png"), 0x800)).paths(), ["é.png"]);
}

function testZip64() {
  console.log("ZIP64 records");
  const entries = [{ name: "a.txt", data: Buffer.from("hello"), method: 8 }];
  equal("a zip64 archive reads", extracted(zipFile(entries, { zip64: true })).paths(), ["a.txt"]);
  const prefixed = zipFile(entries, { zip64: true, prefix: Buffer.from("#!/bin/sh\nexit 0\n") });
  let tree = null;
  equal("with data in front of it too", thrown(() => { tree = extracted(prefixed); }), null);
  equal("whose member reads", tree && Buffer.from(tree.read("a.txt")).toString(), "hello");
}

// -- xar --------------------------------------------------------------- //

function testXarNames() {
  console.log("Archive names XML cannot hold");
  const identity = { certificate: new Uint8Array(1), key: null };
  ["a\u0001b.js", "a￾.js", "a￿.js"].forEach((name) => {
    const files = {};
    files[name] = new Uint8Array(1);
    matches("the file " + JSON.stringify(name) + " stops the signing",
            thrown(() => W2S.xar.pack("T.safariextension", files, identity)), /cannot hold/);
  });
  matches("so does such a directory",
          thrown(() => W2S.xar.pack("T.safariextension", { "a\u0001/b.js": new Uint8Array(1) }, identity)),
          /cannot hold/);
  matches("and such a bundle name",
          thrown(() => W2S.xar.pack("T\u0001.safariextension", { "b.js": new Uint8Array(1) }, identity)),
          /cannot hold/);
  equal("the characters of XML pass that check", /cannot hold/.test(String(thrown(() =>
    W2S.xar.pack("T.safariextension", { "a&<>\t\"é.js": new Uint8Array(1) }, identity)))), false);
}

// -- the API scan ------------------------------------------------------ //

function testAliasScan() {
  console.log("Alias scan");
  const started = Date.now();
  W2S.analyze.findAliases(["var a=x" + new Array(64001).join(" ") + "y;\n"]);
  equal("a long run of spaces takes no time", Date.now() - started < 1000, true);
  const cases = [
    ["var a = chrome;", ["a"]],
    ["var a = chrome   ;\n", ["a"]],
    ["var a = chrome   \n", ["a"]],
    ["var a = chrome\r\nvar b = browser\r\n", ["a", "b"]],
    ["var a = 1\rvar b = chrome;", ["b"]],
    ["var a = 1 var b = chrome;", ["b"]],
    ["var a = typeof browser === 'object' ? browser : chrome;", ["a"]],
    ["var a = chrome.tabs;", []],
    ["var a = chrome .tabs;", []],
    ["var a =\n  chrome;", ["a"]],
    ["var a = x, b = 2; let c = browser", ["c"]],
    ["var chrome = browser;", []],
    ["var a = 1", []]
  ];
  cases.forEach(([text, expected]) => {
    equal("aliases of " + JSON.stringify(text), W2S.analyze.findAliases([text]), expected);
  });
}

// -- HTML pages -------------------------------------------------------- //

function testPageComments() {
  console.log("Comments in pages");
  const inject = (html) => W2S.htmlpatch.inject(html, "<T>").html;
  equal("a commented charset is not taken for one",
        inject("<html><head><!-- <meta charset=x> --><title>t</title></head></html>"),
        "<html><head><T><!-- <meta charset=x> --><title>t</title></head></html>");
  equal("a commented head is not taken for one",
        inject("<!-- put in <head> --><html><head></head></html>"),
        "<!-- put in <head> --><html><head><T></head></html>");
  equal("a commented html tag is not taken for one",
        inject("<!-- <html> --><html><body></body></html>"),
        "<!-- <html> --><html><head><T></head><body></body></html>");
  equal("a comment that hides a script does not hold the charset back",
        inject("<head><!-- <script> --><meta charset=utf-8></head>"),
        "<head><!-- <script> --><meta charset=utf-8><T></head>");
  equal("an empty comment ends where it stands",
        inject("<!--><head></head>"), "<!--><head><T></head>");
  equal("a comment left open hides the rest",
        inject("<div></div><!-- <head>"), "<T><div></div><!-- <head>");
  equal("a doctype after a comment stays ahead of the tags",
        inject("<!-- c --><!doctype html><div></div>"), "<!-- c --><!doctype html><T><div></div>");
  equal("the charset is kept ahead of the tags outside comments",
        inject("<html><head><title>t</title><meta charset=utf-8></head></html>"),
        "<html><head><title>t</title><meta charset=utf-8><T></head></html>");
  equal("the marker in a comment still counts",
        W2S.htmlpatch.inject("<!-- wex-bridge --><head></head>", "<T>").changed, false);
}

function testPageEncodings() {
  console.log("Encodings of pages");
  const inject = (html) => W2S.htmlpatch.inject(html, "<T>").html;
  equal("a byte order mark stays ahead of the tags", inject("﻿<div>é</div>"), "﻿<T><div>é</div>");
  equal("and ahead of a doctype", inject("﻿<!doctype html><div></div>"), "﻿<!doctype html><T><div></div>");

  const page = "<!doctype html><html><head><title>é😀</title></head><body>\ud800</body></html>";
  const swapped = (buffer) => Buffer.from(buffer).swap16();
  const little = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(page, "utf16le")]);
  const big = swapped(little);
  [["UTF-16 LE", little, (b) => b.toString("utf16le")],
    ["UTF-16 BE", big, (b) => swapped(b).toString("utf16le")]].forEach(([label, data, decode]) => {
    const tree = new W2S.tree.Tree();
    tree.write("a/p.html", new Uint8Array(data));
    equal(label + " is patched", W2S.htmlpatch.patchFile(tree, "a/p.html", ["wex/x.js"]), true);
    const out = Buffer.from(tree.read("a/p.html"));
    equal(label + " begins with its mark", Array.from(out.subarray(0, 2)), Array.from(data.subarray(0, 2)));
    equal(label + " keeps its text and takes the tags", decode(out.subarray(2)),
          page.replace("<head>", "<head><!-- wex-bridge --><script src=\"../wex/x.js\"></script>"));
  });

  const latin = new W2S.tree.Tree();
  latin.write("p.html", new Uint8Array(Buffer.from("<head></head>\xe9", "latin1")));
  W2S.htmlpatch.patchFile(latin, "p.html", ["x.js"]);
  equal("a page that is not UTF-8 keeps its bytes", Buffer.from(latin.read("p.html")).toString("latin1"),
        "<head><!-- wex-bridge --><script src=\"x.js\"></script></head>\xe9");
}

function main() {
  [testPublicSuffix, testLinks, testPngSizes, testInterlace, testTransparency, testZipSizes, testZipNames,
    testZip64, testXarNames, testAliasScan, testPageComments, testPageEncodings].forEach((test) => {
    try {
      test();
    } catch (e) {
      failed++;
      console.log("  FAIL  " + test.name + " stopped: " + e.name + ": " + e.message);
    }
  });
  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exitCode = failed ? 1 : 0;
}

main();
