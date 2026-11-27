// Producing the icon set a .safariextension bundle expects.
//
// Safari looks for Icon-32/48/64/96/128.png at the root of the bundle and for
// a small image to put in the toolbar. A WebExtension declares neither at
// those sizes, so the largest icon it does ship is decoded and scaled down to
// each of them. PNGs are decoded here; other formats are handed to the
// host's `convertImage`, which turns them into a PNG or into pixels, and
// SVGs too when it has an `svg` property that is true. An extension whose
// icons cannot be decoded gets a plain placeholder, and the report says so. The toolbar image is drawn by template.js, because Safari
// uses only its alpha channel.

(function (W2S) {
  "use strict";

  var png = W2S.png;
  var template = W2S.template;
  var tree = W2S.tree;
  var bytes = W2S.bytes;

  var BUNDLE_SIZES = [32, 48, 64, 96, 128];
  var LARGEST = 128;
  var TOOLBAR_SIZE = 16;

  // Toolbar masks for the icons an extension may set while running live
  // here, at the same relative path as the icon they were drawn from.
  var RUNTIME_DIR = "wex/toolbar";

  // Icon folders can hold more than icons (a folder of flags, say); these keep
  // drawing masks for the files the manifest does not name from taking long.
  var RUNTIME_MAX_PER_FOLDER = 64;
  var RUNTIME_MAX_SIDE = 512;

  // Declared icons that exist, smallest first; a key that is not a pixel
  // size counts as 0.
  function existing(iconMap, root) {
    var out = [];
    Object.keys(iconMap || {}).forEach(function (key) {
      var size = /^\s*[-+]?\d+\s*$/.test(key) ? parseInt(key, 10) : 0;
      out.push([size, iconMap[key]]);
    });
    out.sort(function (a, b) { return a[0] - b[0] || tree.compare(a[1], b[1]); });
    return out.filter(function (entry) { return root.isFile(entry[1]); });
  }

  // Decodes the largest usable icon in `iconMap`. The largest is preferred
  // because every size the bundle needs is derived by scaling down from it.
  function decode(root, iconMap, convertImage) {
    var candidates = existing(iconMap, root).reverse();
    function attempt(index) {
      if (index >= candidates.length) {
        return Promise.resolve(null);
      }
      var relative = candidates[index][1];
      var lower = relative.toLowerCase();
      // An SVG is drawn only by a host whose convertImage says it can.
      if (/\.svg$/.test(lower) && !(convertImage && convertImage.svg)) {
        return attempt(index + 1);
      }
      var data = root.read(relative);
      if (/\.png$/.test(lower)) {
        try {
          return Promise.resolve(png.read(data));
        } catch (e) {
          return attempt(index + 1);
        }
      }
      if (!convertImage) {
        return attempt(index + 1);
      }
      return Promise.resolve(convertImage(data, relative)).then(function (converted) {
        if (converted instanceof Uint8Array) {
          return png.read(converted);
        }
        return converted || Promise.reject(new Error("not converted"));
      }).catch(function () {
        return attempt(index + 1);
      });
    }
    return attempt(0);
  }

  // A plain square, coloured from the extension's name so bundles differ.
  function placeholderPixels(size, seed) {
    var digest = bytes.crc32(bytes.utf8(seed));
    var red = 60 + (digest & 0x7F);
    var green = 60 + ((digest >>> 8) & 0x7F);
    var blue = 60 + ((digest >>> 16) & 0x7F);
    var inset = Math.max(1, Math.floor(size / 8));
    var pixels = new Uint8Array(size * size * 4);
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var offset = (y * size + x) * 4;
        var edge = x < inset || y < inset || x >= size - inset || y >= size - inset;
        pixels[offset] = edge ? red >> 1 : red;
        pixels[offset + 1] = edge ? green >> 1 : green;
        pixels[offset + 2] = edge ? blue >> 1 : blue;
        pixels[offset + 3] = 255;
      }
    }
    return pixels;
  }

  // Writes a toolbar mask and its @2x twin; Safari reads the twin on Retina.
  function writeMasks(bundle, directory, name, image) {
    var stem = /\.png$/i.test(name) ? name.slice(0, -4) : name;
    [[1, ".png"], [2, "@2x.png"]].forEach(function (variant) {
      var size = TOOLBAR_SIZE * variant[0];
      bundle.write(tree.join(directory, stem + variant[1]),
                   png.write(size, size, template.toolbarImage(image.pixels, image.width,
                                                               image.height, size)));
    });
  }

  function fitLargest(image) {
    if (Math.max(image.width, image.height) > LARGEST) {
      return { width: LARGEST, height: LARGEST,
               pixels: png.resize(image.pixels, image.width, image.height, LARGEST, LARGEST) };
    }
    return image;
  }

  // Draws toolbar masks for the icons an extension may set while running.
  // Safari takes a toolbar image only from a file in the bundle, so a mask
  // cannot be drawn at the moment the extension asks for a new icon. Instead,
  // one is drawn now for every PNG in the folders the manifest's icons live
  // in, which is where extensions keep the icons they switch between.
  // Returns {icon path: mask path}, both relative to the bundle.
  function buildRuntimeMasks(bundle, iconMaps) {
    var folders = Object.create(null);
    var declared = Object.create(null);
    iconMaps.forEach(function (iconMap) {
      Object.keys(iconMap || {}).forEach(function (key) {
        var path = iconMap[key];
        folders[tree.dirname(path)] = true;
        declared[tree.normalize(path)] = true;
      });
    });

    var masks = Object.create(null);
    Object.keys(folders).sort(tree.compare).forEach(function (folder) {
      if (!bundle.isDir(folder)) {
        return;
      }
      var listing = bundle.list(folder);
      var names = listing.dirs.concat(listing.files).sort(tree.compare).filter(function (n) {
        return /\.png$/.test(n.toLowerCase()) && n.indexOf("@2x") < 0;
      });
      var extras = 0;
      names.forEach(function (name) {
        var relative = tree.normalize(tree.join(folder, name));
        var named = declared[relative] === true;
        if (!named) {
          extras++;
          if (extras > RUNTIME_MAX_PER_FOLDER) {
            return;
          }
        }
        var image;
        try {
          image = png.read(bundle.read(relative));
        } catch (e) {
          return;
        }
        if (!named && Math.max(image.width, image.height) > RUNTIME_MAX_SIDE) {
          return;
        }
        var destination = tree.join(RUNTIME_DIR, tree.dirname(relative));
        writeMasks(bundle, destination, name, fitLargest(image));
        masks[relative] = tree.join(RUNTIME_DIR, relative);
      });
    });
    return masks;
  }

  // Writes the bundle icons and the toolbar image. Resolves to
  // {toolbarImage, placeholder}.
  function build(bundle, sourceRoot, iconMap, actionIconMap, name, convertImage) {
    var mainMap = Object.keys(iconMap || {}).length ? iconMap : actionIconMap;
    var hasAction = Object.keys(actionIconMap || {}).length > 0;
    return Promise.all([
      decode(sourceRoot, mainMap, convertImage),
      hasAction ? decode(sourceRoot, actionIconMap, convertImage) : null
    ]).then(function (decoded) {
      var main = decoded[0];
      var placeholder = !main;
      if (!main) {
        main = { width: LARGEST, height: LARGEST, pixels: placeholderPixels(LARGEST, name) };
      }
      // Everything is derived from one scaled copy at the largest size the
      // bundle needs, so the source is only walked once however big it is.
      var master = png.resize(main.pixels, main.width, main.height, LARGEST, LARGEST);
      BUNDLE_SIZES.forEach(function (size) {
        var scaled = size === LARGEST ? master : png.resize(master, LARGEST, LARGEST, size, size);
        bundle.write("Icon-" + size + ".png", png.write(size, size, scaled));
      });
      // Masks are drawn from a copy no larger than the bundle's largest icon,
      // which holds far more detail than a 32px image can show.
      var source = decoded[1] ? fitLargest(decoded[1])
        : { width: LARGEST, height: LARGEST, pixels: master };
      writeMasks(bundle, "wex", "toolbar-icon.png", source);
      return { toolbarImage: "wex/toolbar-icon.png", placeholder: placeholder };
    });
  }

  W2S.icons = {
    build: build,
    buildRuntimeMasks: buildRuntimeMasks,
    placeholderPixels: placeholderPixels
  };
})(typeof globalThis.W2S === "object" ? globalThis.W2S : (globalThis.W2S = {}));
