// Turning a colour icon into a toolbar image.
//
// Safari draws a toolbar image as a mask: only its alpha channel counts, and
// the button face is painted in the toolbar's own ink. A colour icon handed
// over as it is therefore becomes a solid silhouette, and a white glyph on a
// coloured tile becomes a plain tile.
//
// So the mask is drawn from the icon's colours rather than its alpha alone.
// The colour that covers most of the icon is taken to be its body and kept
// solid; anything that differs from it clearly enough, such as the glyph on
// the tile, is cut out, and a thin outline of the icon's own shape is kept so
// a busy icon does not fall apart into specks. The result is sharpened after
// scaling so it stays legible at toolbar size.

(function (W2S) {
  "use strict";

  var png = W2S.png;

  // How far a colour has to be from the body colour, on a scale where 1 is
  // black against white, before it is cut out: fully kept below the first
  // value, fully cut above the second.
  var CUT_FROM = 0.10;
  var CUT_TO = 0.30;

  // After scaling, alpha below the first value becomes transparent and above
  // the second becomes opaque, which undoes the grey haze scaling leaves.
  var SHARPEN_FROM = 0.2;
  var SHARPEN_TO = 0.8;

  // A shape that fills this much of its bounding box is a plain tile, whose
  // outline says nothing the tile does not.
  var TILE_FILL = 0.9;

  function smoothstep(low, high, value) {
    var t = (value - low) / (high - low);
    if (t <= 0) {
      return 0;
    }
    if (t >= 1) {
      return 1;
    }
    return t * t * (3 - 2 * t);
  }

  function toByte(value) {
    return Math.trunc(value * 255 + 0.5);
  }

  // The colour covering most of the icon's visible area. Colours are grouped
  // by their top four bits per channel, so shading within one flat colour
  // counts as that colour; the body colour is the average of the largest
  // group. What counts as visible is judged against the icon's own opacity,
  // since some extensions declare a half-transparent icon to show before
  // they have started.
  function bodyColour(pixels) {
    var mostOpaque = 0;
    for (var i = 3; i < pixels.length; i += 4) {
      if (pixels[i] > mostOpaque) {
        mostOpaque = pixels[i];
      }
    }
    if (!mostOpaque) {
      return null;
    }
    var threshold = (mostOpaque + 1) >> 1;
    var groups = new Map();
    for (i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] < threshold) {
        continue;
      }
      var red = pixels[i], green = pixels[i + 1], blue = pixels[i + 2];
      var key = ((red >> 4) << 8) | ((green >> 4) << 4) | (blue >> 4);
      var group = groups.get(key);
      if (!group) {
        groups.set(key, [1, red, green, blue]);
      } else {
        group[0] += 1;
        group[1] += red;
        group[2] += green;
        group[3] += blue;
      }
    }
    // The largest group, ties broken the way Python's max() compares lists.
    var best = null;
    groups.forEach(function (candidate) {
      if (!best) {
        best = candidate;
        return;
      }
      for (var j = 0; j < 4; j++) {
        if (candidate[j] !== best[j]) {
          if (candidate[j] > best[j]) {
            best = candidate;
          }
          return;
        }
      }
    });
    if (!best) {
      return null;
    }
    return [best[1] / best[0], best[2] / best[0], best[3] / best[0]];
  }

  // How different a colour looks from the body colour, from 0 to 1: a
  // weighted distance that follows the eye more closely than plain RGB
  // distance.
  function difference(red, green, blue, body) {
    var meanRed = (red + body[0]) / 2;
    var dRed = red - body[0];
    var dGreen = green - body[1];
    var dBlue = blue - body[2];
    var squared = (2 + meanRed / 256) * dRed * dRed +
      4 * dGreen * dGreen +
      (2 + (255 - meanRed) / 256) * dBlue * dBlue;
    return Math.sqrt(squared) / 765;
  }

  // Alpha-only pixels: the icon's alpha, less whatever differs from the body.
  function cutDetails(pixels, body) {
    var out = new Uint8Array(pixels.length);
    for (var i = 0; i < pixels.length; i += 4) {
      var alpha = pixels[i + 3];
      if (!alpha) {
        continue;
      }
      var keep = 1 - smoothstep(CUT_FROM, CUT_TO, difference(pixels[i], pixels[i + 1],
                                                             pixels[i + 2], body));
      out[i + 3] = toByte(alpha / 255 * keep);
    }
    return out;
  }

  function alphaOnly(pixels) {
    var out = new Uint8Array(pixels.length);
    for (var i = 3; i < pixels.length; i += 4) {
      out[i] = pixels[i];
    }
    return out;
  }

  function sharpen(pixels) {
    for (var i = 3; i < pixels.length; i += 4) {
      pixels[i] = toByte(smoothstep(SHARPEN_FROM, SHARPEN_TO, pixels[i] / 255));
    }
  }

  // True when the shape is a plain rectangle filling its bounding box.
  function isTile(solid, size) {
    var count = 0, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (var i = 0; i < solid.length; i++) {
      if (!solid[i]) {
        continue;
      }
      var x = i % size, y = Math.floor(i / size);
      count++;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    if (!count) {
      return true;
    }
    return count >= TILE_FILL * ((maxX - minX + 1) * (maxY - minY + 1));
  }

  // Draws the silhouette's edge pixels back into the mask.
  function keepOutline(mask, silhouette, size) {
    var solid = new Array(size * size);
    for (var i = 0; i < size * size; i++) {
      solid[i] = silhouette[i * 4 + 3] >= 128;
    }
    if (isTile(solid, size)) {
      return;
    }
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        i = y * size + x;
        if (!solid[i]) {
          continue;
        }
        var edge = x === 0 || y === 0 || x === size - 1 || y === size - 1 ||
          !solid[i - 1] || !solid[i + 1] || !solid[i - size] || !solid[i + size];
        if (edge) {
          mask[i * 4 + 3] = Math.max(mask[i * 4 + 3], silhouette[i * 4 + 3]);
        }
      }
    }
  }

  // A `size`-pixel square toolbar mask drawn from an RGBA icon.
  function toolbarImage(pixels, width, height, size) {
    var silhouette = png.resize(alphaOnly(pixels), width, height, size, size);
    var body = bodyColour(pixels);
    if (!body) {
      return silhouette;
    }
    var mask = png.resize(cutDetails(pixels, body), width, height, size, size);
    sharpen(mask);
    keepOutline(mask, silhouette, size);
    return mask;
  }

  W2S.template = { toolbarImage: toolbarImage };
})(typeof globalThis.W2S === "object" ? globalThis.W2S : (globalThis.W2S = {}));
