// A small PNG reader, resizer and writer.
//
// This handles every PNG colour type at bit depths 1 through 16, interlaced or
// not, and refuses a file that declares more pixels than MAX_PIXELS or holds
// fewer than it declares.

(function (W2S) {
  "use strict";

  var bytes = W2S.bytes;

  var MAGIC = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

  // Samples per pixel for each colour type.
  var CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

  // The most pixels an image may have, 16384 square, far beyond any icon.
  var MAX_PIXELS = 16384 * 16384;

  // Where each pass of an image starts and how far apart its pixels lie: the
  // whole image, or the seven passes of Adam7 interlacing.
  var WHOLE = [{ x: 0, y: 0, dx: 1, dy: 1 }];
  var ADAM7 = [
    { x: 0, y: 0, dx: 8, dy: 8 },
    { x: 4, y: 0, dx: 8, dy: 8 },
    { x: 0, y: 4, dx: 4, dy: 8 },
    { x: 2, y: 0, dx: 4, dy: 4 },
    { x: 0, y: 2, dx: 2, dy: 4 },
    { x: 1, y: 0, dx: 2, dy: 2 },
    { x: 0, y: 1, dx: 1, dy: 2 }
  ];

  function UnsupportedPNG(message) {
    var error = new Error(message);
    error.name = "UnsupportedPNG";
    return error;
  }

  function isPng(data) {
    if (!data || data.length < 8) {
      return false;
    }
    for (var i = 0; i < 8; i++) {
      if (data[i] !== MAGIC[i]) {
        return false;
      }
    }
    return true;
  }

  function be32(data, offset) {
    return ((data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) |
            data[offset + 3]) >>> 0;
  }

  function chunks(data) {
    if (!isPng(data)) {
      throw UnsupportedPNG("not a PNG");
    }
    var out = [];
    var pos = 8;
    while (pos + 8 <= data.length) {
      var length = be32(data, pos);
      out.push({
        tag: bytes.latin1(data.subarray(pos + 4, pos + 8)),
        payload: data.subarray(pos + 8, Math.min(data.length, pos + 8 + length))
      });
      pos += 12 + length;
    }
    return out;
  }

  // Reverses the per-scanline filters PNG applies before compression. `raw`
  // holds every scanline in full.
  function unfilter(raw, height, stride, bpp) {
    var out = new Uint8Array(height * stride);
    var previous = new Uint8Array(stride);
    var pos = 0;
    for (var y = 0; y < height; y++) {
      var filter = raw[pos];
      pos += 1;
      var line = new Uint8Array(stride);
      line.set(raw.subarray(pos, pos + stride));
      pos += stride;
      var i;
      if (filter === 0) {
        // None.
      } else if (filter === 1) {
        for (i = bpp; i < stride; i++) {
          line[i] = (line[i] + line[i - bpp]) & 0xFF;
        }
      } else if (filter === 2) {
        for (i = 0; i < stride; i++) {
          line[i] = (line[i] + previous[i]) & 0xFF;
        }
      } else if (filter === 3) {
        for (i = 0; i < stride; i++) {
          var left = i >= bpp ? line[i - bpp] : 0;
          line[i] = (line[i] + ((left + previous[i]) >> 1)) & 0xFF;
        }
      } else if (filter === 4) {
        for (i = 0; i < stride; i++) {
          var a = i >= bpp ? line[i - bpp] : 0;
          var b = previous[i];
          var c = i >= bpp ? previous[i - bpp] : 0;
          var estimate = a + b - c;
          var da = Math.abs(estimate - a);
          var db = Math.abs(estimate - b);
          var dc = Math.abs(estimate - c);
          var predictor = da <= db && da <= dc ? a : db <= dc ? b : c;
          line[i] = (line[i] + predictor) & 0xFF;
        }
      } else {
        throw UnsupportedPNG("unknown scanline filter " + filter);
      }
      out.set(line, y * stride);
      previous = line;
    }
    return out;
  }

  // Widens sub-byte samples to one byte each.
  function expandBits(line, width, depth, samplesPerPixel) {
    var out = new Uint8Array(width * samplesPerPixel);
    var perByte = 8 / depth;
    var mask = (1 << depth) - 1;
    for (var i = 0; i < out.length; i++) {
      var byte = line[Math.floor(i / perByte)];
      var shift = 8 - depth * ((i % perByte) + 1);
      out[i] = (byte >> shift) & mask;
    }
    return out;
  }

  // Inflates `data`, stopping once `wanted` bytes have come out; a stream
  // that holds more is not read further.
  function inflate(data, wanted) {
    var inflator = new W2S.pako.Inflate();
    var enough = {};
    var parts = [];
    var total = 0;
    inflator.onData = function (chunk) {
      parts.push(chunk);
      total += chunk.length;
      if (total >= wanted) {
        throw enough;
      }
    };
    try {
      inflator.push(data, true);
    } catch (e) {
      if (e !== enough) {
        throw e;
      }
      return bytes.concat(parts);
    }
    if (inflator.err) {
      throw UnsupportedPNG("Error -3 while decompressing data: " + (inflator.msg || "incomplete"));
    }
    return bytes.concat(parts);
  }

  // Decodes a PNG into {width, height, pixels} with RGBA pixels.
  function read(data) {
    var header = null;
    var palette = new Uint8Array(0);
    var transparency = new Uint8Array(0);
    var compressed = [];

    var list = chunks(data);
    for (var n = 0; n < list.length; n++) {
      var chunk = list[n];
      if (chunk.tag === "IHDR") {
        if (chunk.payload.length < 13) {
          throw UnsupportedPNG("truncated image header");
        }
        var p = chunk.payload;
        header = {
          width: be32(p, 0), height: be32(p, 4), depth: p[8], colour: p[9],
          compression: p[10], filter: p[11], interlace: p[12]
        };
      } else if (chunk.tag === "PLTE") {
        palette = chunk.payload;
      } else if (chunk.tag === "tRNS") {
        transparency = chunk.payload;
      } else if (chunk.tag === "IDAT") {
        compressed.push(chunk.payload);
      } else if (chunk.tag === "IEND") {
        break;
      }
    }

    if (!header) {
      throw UnsupportedPNG("no image header");
    }
    var width = header.width, height = header.height, depth = header.depth, colour = header.colour;
    if (header.interlace !== 0 && header.interlace !== 1) {
      throw UnsupportedPNG("unknown interlace method " + header.interlace);
    }
    if (header.compression !== 0 || header.filter !== 0) {
      throw UnsupportedPNG("unsupported compression or filter method");
    }
    if (!(colour in CHANNELS)) {
      throw UnsupportedPNG("unknown colour type " + colour);
    }
    if ([1, 2, 4, 8, 16].indexOf(depth) < 0) {
      throw UnsupportedPNG("unsupported bit depth " + depth);
    }
    if (depth < 8 && colour !== 0 && colour !== 3) {
      throw UnsupportedPNG("bit depth " + depth + " is only valid for grey and palette images");
    }

    if (width * height > MAX_PIXELS) {
      throw UnsupportedPNG("too large: " + width + " by " + height + " pixels");
    }

    var samples = CHANNELS[colour];
    var bitsPerPixel = samples * depth;
    var bpp = Math.max(1, Math.floor(bitsPerPixel / 8));

    // A pass with no pixels in an image this small has no scanlines at all.
    var passes = [];
    var size = 0;
    (header.interlace ? ADAM7 : WHOLE).forEach(function (pass) {
      var columns = Math.ceil((width - pass.x) / pass.dx);
      var rows = Math.ceil((height - pass.y) / pass.dy);
      if (columns > 0 && rows > 0) {
        var stride = Math.floor((columns * bitsPerPixel + 7) / 8);
        passes.push({ x: pass.x, y: pass.y, dx: pass.dx, dy: pass.dy,
                      columns: columns, rows: rows, stride: stride });
        size += rows * (stride + 1);
      }
    });

    var raw = inflate(bytes.concat(compressed), size);
    if (raw.length < size) {
      throw UnsupportedPNG("truncated image data");
    }

    // Palette entries carry their own alpha in a tRNS chunk; grey and
    // truecolour images may name a single fully transparent sample instead,
    // in the image's full depth.
    var greyTransparent = null;
    var rgbTransparent = null;
    if (transparency.length) {
      if (colour === 0 && transparency.length >= 2) {
        greyTransparent = (transparency[0] << 8) | transparency[1];
      } else if (colour === 2 && transparency.length >= 6) {
        rgbTransparent = [(transparency[0] << 8) | transparency[1],
                          (transparency[2] << 8) | transparency[3],
                          (transparency[4] << 8) | transparency[5]];
      }
    }

    var maximum = (1 << depth) - 1;
    var rgba = new Uint8Array(width * height * 4);

    var position = 0;
    passes.forEach(function (pass) {
      var length = pass.rows * (pass.stride + 1);
      var scanned = unfilter(raw.subarray(position, position + length), pass.rows, pass.stride, bpp);
      position += length;
      for (var y = 0; y < pass.rows; y++) {
        var full = scanned.subarray(y * pass.stride, (y + 1) * pass.stride);
        var line = full;
        if (depth < 8) {
          line = expandBits(line, pass.columns, depth, samples);
        } else if (depth === 16) {
          // Keep the high byte of each 16-bit sample.
          var high = new Uint8Array(Math.ceil(line.length / 2));
          for (var h = 0; h < high.length; h++) {
            high[h] = line[h * 2];
          }
          line = high;
        }
        var base = (pass.y + y * pass.dy) * width * 4;
        for (var x = 0; x < pass.columns; x++) {
          var offset = x * samples;
          var out = base + (pass.x + x * pass.dx) * 4;
          if (colour === 0) {
            var value = line[offset];
            var level = depth < 8 ? Math.floor(value * 255 / maximum) : value;
            rgba[out] = rgba[out + 1] = rgba[out + 2] = level;
            rgba[out + 3] = greyTransparent !== null &&
              sampleAt(full, line, depth, offset) === greyTransparent ? 0 : 255;
          } else if (colour === 2) {
            var alpha = 255;
            if (rgbTransparent && sampleAt(full, line, depth, offset) === rgbTransparent[0] &&
                sampleAt(full, line, depth, offset + 1) === rgbTransparent[1] &&
                sampleAt(full, line, depth, offset + 2) === rgbTransparent[2]) {
              alpha = 0;
            }
            rgba[out] = line[offset];
            rgba[out + 1] = line[offset + 1];
            rgba[out + 2] = line[offset + 2];
            rgba[out + 3] = alpha;
          } else if (colour === 3) {
            var index = line[offset];
            var entry = index * 3;
            if (entry + 2 >= palette.length) {
              continue;
            }
            rgba[out] = palette[entry];
            rgba[out + 1] = palette[entry + 1];
            rgba[out + 2] = palette[entry + 2];
            rgba[out + 3] = index < transparency.length ? transparency[index] : 255;
          } else if (colour === 4) {
            rgba[out] = rgba[out + 1] = rgba[out + 2] = line[offset];
            rgba[out + 3] = line[offset + 1];
          } else {
            rgba[out] = line[offset];
            rgba[out + 1] = line[offset + 1];
            rgba[out + 2] = line[offset + 2];
            rgba[out + 3] = line[offset + 3];
          }
        }
      }
    });
    return { width: width, height: height, pixels: rgba };
  }

  // Sample `index` of a scanline in its full depth: from `full`, the scanline
  // as stored, at 16 bits, and otherwise from `line`, its samples one a byte.
  function sampleAt(full, line, depth, index) {
    return depth === 16 ? (full[index * 2] << 8) | full[index * 2 + 1] : line[index];
  }

  // Box-filters RGBA pixels to a new size. Colour is averaged with alpha
  // weighting, so a transparent pixel's colour cannot bleed into its
  // neighbours and leave a halo around the icon.
  function resize(pixels, width, height, newWidth, newHeight) {
    if (width === newWidth && height === newHeight) {
      return pixels;
    }
    var out = new Uint8Array(newWidth * newHeight * 4);
    for (var y = 0; y < newHeight; y++) {
      var y0 = Math.floor(y * height / newHeight);
      var y1 = Math.max(y0 + 1, Math.floor((y + 1) * height / newHeight));
      for (var x = 0; x < newWidth; x++) {
        var x0 = Math.floor(x * width / newWidth);
        var x1 = Math.max(x0 + 1, Math.floor((x + 1) * width / newWidth));
        var red = 0, green = 0, blue = 0, alpha = 0, count = 0;
        for (var sy = y0; sy < y1; sy++) {
          var row = sy * width * 4;
          for (var sx = x0; sx < x1; sx++) {
            var offset = row + sx * 4;
            var a = pixels[offset + 3];
            red += pixels[offset] * a;
            green += pixels[offset + 1] * a;
            blue += pixels[offset + 2] * a;
            alpha += a;
            count++;
          }
        }
        var target = (y * newWidth + x) * 4;
        if (alpha) {
          out[target] = Math.min(255, Math.floor(red / alpha));
          out[target + 1] = Math.min(255, Math.floor(green / alpha));
          out[target + 2] = Math.min(255, Math.floor(blue / alpha));
          out[target + 3] = Math.floor(alpha / count);
        }
      }
    }
    return out;
  }

  function chunkBytes(tag, payload) {
    var body = bytes.concat([bytes.fromLatin1(tag), payload]);
    var out = new Uint8Array(body.length + 8);
    var view = new DataView(out.buffer);
    view.setUint32(0, payload.length);
    out.set(body, 4);
    view.setUint32(body.length + 4, bytes.crc32(body));
    return out;
  }

  // Encodes RGBA pixels as a PNG.
  function write(width, height, pixels) {
    var stride = width * 4;
    var rows = new Uint8Array(height * (stride + 1));
    for (var y = 0; y < height; y++) {
      rows.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
    }
    var header = new Uint8Array(13);
    var view = new DataView(header.buffer);
    view.setUint32(0, width);
    view.setUint32(4, height);
    header[8] = 8;
    header[9] = 6;
    return bytes.concat([
      new Uint8Array(MAGIC),
      chunkBytes("IHDR", header),
      chunkBytes("IDAT", W2S.pako.deflate(rows, { level: 9 })),
      chunkBytes("IEND", new Uint8Array(0))
    ]);
  }

  // The same PNG without its pHYs chunk, or null if it declares no density.
  // Safari sizes a toolbar image from the pixel density the file declares,
  // so an icon saved at 600 DPI arrives under four points wide; without the
  // chunk it is read at the 72 DPI everything else assumes.
  function stripDensity(data) {
    if (!isPng(data)) {
      return null;
    }
    var parts = [data.subarray(0, 8)];
    var pos = 8;
    var found = false;
    while (pos + 8 <= data.length) {
      var end = pos + 12 + be32(data, pos);
      if (end > data.length) {
        return null;
      }
      if (bytes.latin1(data.subarray(pos + 4, pos + 8)) === "pHYs") {
        found = true;
      } else {
        parts.push(data.subarray(pos, end));
      }
      pos = end;
    }
    return found ? bytes.concat(parts) : null;
  }

  W2S.png = {
    isPng: isPng,
    read: read,
    resize: resize,
    write: write,
    stripDensity: stripDensity,
    UnsupportedPNG: UnsupportedPNG
  };
})(typeof globalThis.W2S === "object" ? globalThis.W2S : (globalThis.W2S = {}));
