// Regenerates the capability probe's Info.plist and its images.
//
//     node tools/build-probe.js [-o DIR]
//
// The probe's JavaScript is written by hand; only the pieces that are tedious
// to maintain as text, the property list and the flat-colour PNGs, are
// generated, into DIR (default probe/Capability Probe.safariextension).

"use strict";

const fs = require("fs");
const path = require("path");
const W2S = require("../webext2safari/js/node.js");

const ROOT = path.resolve(__dirname, "..");

// A flat square with a border, built pixel by pixel.
function square(size, border, fill) {
  const inset = Math.max(1, Math.floor(size / 4));
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inner = inset <= x && x < size - inset && inset <= y && y < size - inset;
      pixels.set((inner ? fill : border).concat(255), (y * size + x) * 4);
    }
  }
  return pixels;
}

function main() {
  const args = process.argv.slice(2);
  const index = args.indexOf("-o");
  const bundle = index >= 0 && args[index + 1] ? path.resolve(args[index + 1])
    : path.join(ROOT, "probe", "Capability Probe.safariextension");
  fs.mkdirSync(bundle, { recursive: true });

  function png(name, size, border, fill) {
    fs.writeFileSync(path.join(bundle, name), W2S.png.write(size, size, square(size, border, fill)));
  }
  for (const size of [32, 48, 64, 96, 128]) {
    png("Icon-" + size + ".png", size, [26, 92, 160], [255, 255, 255]);
  }
  png("toolbar.png", 16, [32, 32, 32], [32, 32, 32]);
  // The image the probe asks the global page to block. It is its own file so
  // a blocked load can be told apart from a load that never started.
  png("probe-blocked.png", 8, [200, 40, 40], [200, 40, 40]);

  const real = (value) => new W2S.pyjson.PyFloat(value);
  const info = {
    "Author": "webext2safari",
    "Builder Version": "9537.78.2",
    "CFBundleDisplayName": "Capability Probe",
    "CFBundleIdentifier": "com.webext2safari.capability-probe",
    "CFBundleInfoDictionaryVersion": "6.0",
    "CFBundleShortVersionString": "1.0",
    "CFBundleVersion": "1.0",
    "Description": "Reports which legacy Safari extension capabilities work on this browser build.",
    "ExtensionInfoDictionaryVersion": "1.0",
    "Chrome": {
      "Database Quota": real(104857600),
      "Global Page": "global.html",
      "Popovers": [{
        "Identifier": "probe-popover",
        "Filename": "popover.html",
        "Width": real(520),
        "Height": real(620)
      }],
      "Toolbar Items": [{
        "Identifier": "probe-toolbar",
        "Image": "toolbar.png",
        "Include By Default": true,
        "Label": "Probe",
        "Palette Label": "Capability Probe",
        "Tool Tip": "Legacy Safari capability probe",
        "Popover": "probe-popover"
      }]
    },
    "Content": {
      "Scripts": { "Start": ["content.js"] },
      "Whitelist": ["http://*/*", "https://*/*"]
    },
    "Permissions": { "Website Access": { "Level": "All", "Include Secure Pages": true } }
  };
  fs.writeFileSync(path.join(bundle, "Info.plist"), W2S.plist.dumps(info));

  console.log("wrote " + bundle);
}

main();
