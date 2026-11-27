// Reading .zip, .xpi and .crx archives into a tree.

(function (W2S) {
  "use strict";

  var bytes = W2S.bytes;

  var CP437_HIGH =
    "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌" +
    "█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";

  // The most an archive may unpack to, far beyond any real extension.
  var MAX_TOTAL_SIZE = 4 * 1024 * 1024 * 1024;

  function cp437(raw) {
    var out = "";
    for (var i = 0; i < raw.length; i++) {
      out += raw[i] < 128 ? String.fromCharCode(raw[i]) : CP437_HIGH[raw[i] - 128];
    }
    return out;
  }

  function ArchiveError(message) {
    var error = new Error(message);
    error.name = "ArchiveError";
    return error;
  }

  function uint32(data, offset) {
    return (data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) |
            (data[offset + 3] << 24)) >>> 0;
  }

  function uint16(data, offset) {
    return data[offset] | (data[offset + 1] << 8);
  }

  function uint64(data, offset) {
    return uint32(data, offset) + uint32(data, offset + 4) * 0x100000000;
  }

  // Where a .crx's zip starts, past the header Chrome puts in front of it;
  // 0 for anything that is not a .crx.
  function crxPayloadOffset(data) {
    if (data.length < 16 || bytes.latin1(data.subarray(0, 4)) !== "Cr24") {
      return 0;
    }
    var version = uint32(data, 4);
    if (version === 2) {
      return 16 + uint32(data, 8) + uint32(data, 12);
    }
    if (version === 3) {
      return 12 + uint32(data, 8);
    }
    throw ArchiveError("unsupported CRX version " + version);
  }

  function findEndRecord(data) {
    var start = Math.max(0, data.length - 22 - 65535);
    for (var i = data.length - 22; i >= start; i--) {
      if (data[i] === 0x50 && data[i + 1] === 0x4b && data[i + 2] === 5 && data[i + 3] === 6) {
        return i;
      }
    }
    throw ArchiveError("File is not a zip file");
  }

  // The archive's members as {name, data, isDir}, in central directory order.
  function members(data) {
    var end = findEndRecord(data);
    var count = uint16(data, end + 10);
    var size = uint32(data, end + 12);
    var offset = uint32(data, end + 16);
    var recordStart = end;
    var locator = end - 20;
    if (locator >= 0 && uint32(data, locator) === 0x07064b50) {
      // The record normally sits right before its locator, where data placed
      // in front of the archive cannot throw it off; one with extra data of
      // its own is found by the offset the locator records.
      var record = uint32(data, locator - 56) === 0x06064b50 ? locator - 56 : uint64(data, locator + 8);
      if (uint32(data, record) === 0x06064b50) {
        count = uint64(data, record + 32);
        size = uint64(data, record + 40);
        offset = uint64(data, record + 48);
        recordStart = record;
      }
    }
    // Data placed in front of the archive shifts every offset it records.
    var concat = recordStart - size - offset;
    var position = offset + concat;
    var out = [];
    for (var n = 0; n < count; n++) {
      if (uint32(data, position) !== 0x02014b50) {
        throw ArchiveError("Bad magic number for central directory");
      }
      var flags = uint16(data, position + 8);
      var method = uint16(data, position + 10);
      var crc = uint32(data, position + 16);
      var compressedSize = uint32(data, position + 20);
      var fileSize = uint32(data, position + 24);
      var nameLength = uint16(data, position + 28);
      var extraLength = uint16(data, position + 30);
      var commentLength = uint16(data, position + 32);
      var localOffset = uint32(data, position + 42);
      var rawName = data.subarray(position + 46, position + 46 + nameLength);
      // A name without the UTF-8 flag is UTF-8 anyway when it can be, as the
      // zip tool on a Mac writes it, and CP437, as the format says, otherwise.
      var name = flags & 0x800 ? bytes.text(rawName) : bytes.strictText(rawName);
      if (name === null) {
        name = cp437(rawName);
      }
      var extra = data.subarray(position + 46 + nameLength,
                                position + 46 + nameLength + extraLength);
      for (var e = 0; e + 4 <= extra.length;) {
        var tag = uint16(extra, e);
        var length = uint16(extra, e + 2);
        if (tag === 1) {
          var field = e + 4;
          if (fileSize === 0xFFFFFFFF) {
            fileSize = uint64(extra, field);
            field += 8;
          }
          if (compressedSize === 0xFFFFFFFF) {
            compressedSize = uint64(extra, field);
            field += 8;
          }
          if (localOffset === 0xFFFFFFFF) {
            localOffset = uint64(extra, field);
          }
        }
        e += 4 + length;
      }
      out.push({
        name: name, flags: flags, method: method, crc: crc,
        compressedSize: compressedSize, fileSize: fileSize,
        localOffset: localOffset + concat
      });
      position += 46 + nameLength + extraLength + commentLength;
    }
    return out.map(function (member) {
      return {
        name: member.name,
        isDir: member.name.slice(-1) === "/",
        size: member.fileSize,
        read: function () { return readMember(data, member); }
      };
    });
  }

  // Inflates a member, stopping as soon as it passes the size the archive
  // records for it.
  function inflateMember(raw, member) {
    var inflator = new W2S.pako.Inflate({ raw: true });
    var keep = inflator.onData;
    var total = 0;
    inflator.onData = function (chunk) {
      total += chunk.length;
      if (total > member.fileSize) {
        throw ArchiveError("File " + member.name + " is larger than the archive records");
      }
      keep.call(this, chunk);
    };
    inflator.push(raw, true);
    if (inflator.err) {
      throw inflator.msg || "error " + inflator.err;
    }
    return inflator.result;
  }

  function readMember(data, member) {
    var header = member.localOffset;
    if (uint32(data, header) !== 0x04034b50) {
      throw ArchiveError("Bad magic number for file header: " + member.name);
    }
    if (member.flags & 1) {
      throw ArchiveError("File " + member.name + " is encrypted");
    }
    var start = header + 30 + uint16(data, header + 26) + uint16(data, header + 28);
    var raw = data.subarray(start, start + member.compressedSize);
    var out;
    if (member.method === 0) {
      out = raw;
    } else if (member.method === 8) {
      try {
        out = inflateMember(raw, member);
      } catch (e) {
        throw e && e.name === "ArchiveError" ? e :
          ArchiveError("Error decompressing " + member.name + ": " + e);
      }
      if (!out) {
        throw ArchiveError("Error decompressing " + member.name);
      }
    } else {
      throw ArchiveError("compression method " + member.method + " is not supported: " +
                         member.name);
    }
    if (out.length !== member.fileSize || bytes.crc32(out) !== member.crc) {
      throw ArchiveError("Bad CRC-32 for file " + member.name);
    }
    return out;
  }

  // Unpacks an archive into `tree`, as Python's zipfile.extractall would
  // write it: path components that are empty, "." or ".." are dropped, and a
  // later member with the name of an earlier one replaces it.
  function extract(data, tree) {
    var offset = crxPayloadOffset(data);
    var archive = offset ? data.subarray(offset) : data;
    var list = members(archive);
    var total = 0;
    list.forEach(function (member) {
      total += member.isDir ? 0 : member.size;
    });
    if (total > MAX_TOTAL_SIZE) {
      throw ArchiveError("the archive unpacks to more than " + MAX_TOTAL_SIZE + " bytes");
    }
    list.forEach(function (member) {
      var parts = member.name.split("/").filter(function (part) {
        return part !== "" && part !== "." && part !== "..";
      });
      if (member.isDir || !parts.length) {
        return;
      }
      tree.write(parts.join("/"), member.read());
    });
  }

  W2S.zip = {
    extract: extract,
    members: members,
    MAX_TOTAL_SIZE: MAX_TOTAL_SIZE,
    crxPayloadOffset: crxPayloadOffset,
    uint32: uint32
  };
})(typeof globalThis.W2S === "object" ? globalThis.W2S : (globalThis.W2S = {}));
