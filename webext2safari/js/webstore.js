// Chrome Web Store and Firefox Add-ons identities and download addresses.

(function (W2S) {
  "use strict";

  var bytes = W2S.bytes;
  var hash = W2S.hash;

  // An extension ID is 32 letters from a to p.
  var EXTENSION_ID = /(?<![a-z])([a-p]{32})(?![a-z])/g;

  var STORE_HOSTS = ["chromewebstore.google.com", "chrome.google.com"];

  // The Chrome version reported to the update service, which offers nothing
  // for an extension whose minimum_chrome_version is newer. It is a stable
  // Chrome release, and needs raising as extensions come to require newer ones.
  var PRODUCT_VERSION = "156.0.8078.80";

  function downloadUrl(id) {
    return "https://clients2.google.com/service/update2/crx?response=redirect" +
      "&prodversion=" + PRODUCT_VERSION + "&acceptformat=crx2,crx3&x=id%3D" + id + "%26uc";
  }

  // The extension ID in a Chrome Web Store URL, or null for anything else.
  function extensionId(source) {
    var url;
    try {
      url = new URL(source);
    } catch (e) {
      return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    if (STORE_HOSTS.indexOf(url.hostname) < 0) {
      return null;
    }
    if (url.hostname === "chrome.google.com" && url.pathname.indexOf("/webstore/") !== 0) {
      return null;
    }
    var found = url.pathname.match(EXTENSION_ID);
    return found ? found[found.length - 1] : null;
  }

  // The slug or numeric ID in a Firefox Add-ons page's URL, or null.
  function firefoxAddon(source) {
    var url;
    try {
      url = new URL(source);
    } catch (e) {
      return null;
    }
    if (url.hostname !== "addons.mozilla.org") {
      return null;
    }
    var match = /\/addon\/([^/?#]+)/.exec(url.pathname);
    if (!match) {
      return null;
    }
    // A slug whose escapes are not UTF-8 is kept as the address spells it.
    try {
      return decodeURIComponent(match[1]);
    } catch (e) {
      return match[1];
    }
  }

  function firefoxApiUrl(addon) {
    return "https://addons.mozilla.org/api/v5/addons/addon/" + encodeURIComponent(addon) + "/";
  }

  // The downloadable address behind a repository's file-view page, when it
  // names an extension archive. GitFlic keeps the filename in `file`, so the
  // viewer's own address ends in /blob and otherwise downloads HTML.
  function rawArchiveUrl(source) {
    var url;
    try {
      url = new URL(source);
    } catch (e) {
      return null;
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") ||
        url.hostname !== "gitflic.ru" || !/\/blob\/?$/.test(url.pathname)) {
      return null;
    }
    var match = /(?:^\?|&)file=([^&]*)/i.exec(url.search);
    if (!match) {
      return null;
    }
    var file = match[1].replace(/\+/g, " ");
    try {
      file = decodeURIComponent(file);
    } catch (e) {
      // A malformed escape cannot reliably name an archive.
      return null;
    }
    if (!/\.(?:crx|xpi|zip)$/i.test(file)) {
      return null;
    }
    url.pathname = url.pathname.replace(/\/?$/, "/raw");
    if (!/(?:^\?|&)inline=/i.test(url.search)) {
      url.search += (url.search ? "&" : "?") + "inline=false";
    }
    return url.href;
  }

  // The listing's own page for an extension of the Chrome Web Store.
  function chromeListingUrl(id) {
    return "https://chromewebstore.google.com/detail/" + id;
  }

  var ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: "\u00a0" };

  function htmlText(html) {
    return String(html).replace(/<[^>]*>/g, "").replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, function (all, name) {
      if (name.charAt(0) === "#") {
        var code = name.charAt(1).toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all;
      }
      return Object.prototype.hasOwnProperty.call(ENTITIES, name.toLowerCase()) ? ENTITIES[name.toLowerCase()] : all;
    }).replace(/\s+/g, " ").trim();
  }

  function htmlHref(attributes) {
    var href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attributes);
    return href ? htmlText(href[1] === undefined ? href[2] : href[1]) : "";
  }

  function publisherValue(html) {
    var link = /<a\b([^>]*)>[\s\S]*?<\/a>/i.exec(html);
    return { name: htmlText(html), url: link ? htmlHref(link[1]) : "" };
  }

  // The current store puts the publisher in its Details list, as a value
  // after "Offered by". T7iRm identifies that row even when the label is
  // localized. Older pages put the publisher in a link beneath the title.
  function detailsPublisher(html) {
    var rows = String(html).match(/<li\b[\s\S]*?<\/li>/gi) || [];
    for (var i = 0; i < rows.length; i++) {
      var row = /^<li\b([^>]*)>([\s\S]*)<\/li>$/i.exec(rows[i]);
      var cells = row && /^\s*<div\b[^>]*>([\s\S]*?)<\/div>\s*<div\b[^>]*>([\s\S]*?)<\/div>/i.exec(row[2]);
      if (!cells) {
        continue;
      }
      var className = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(row[1]);
      className = className ? (className[1] === undefined ? className[2] : className[1]) : "";
      if ((" " + className + " ").indexOf(" T7iRm ") < 0 &&
          htmlText(cells[1]).toLowerCase() !== "offered by") {
        continue;
      }
      var found = publisherValue(cells[2]);
      return found.name ? found : null;
    }
    return null;
  }

  // What a Chrome Web Store listing's page says of its extension: who
  // offers it in the Details list, or on older pages in the byline beneath
  // the title, and the website that name points to, or else the listing's
  // page. `byline` is the name and address when they are already known from
  // the page as a browser shows it.
  function chromeListing(id, html, byline) {
    var found = byline || (html && detailsPublisher(html)) || null;
    if (!found && html) {
      var title = html.search(/<h1\b/i);
      var rest = title >= 0 ? html.slice(title) : "";
      var link = /<a\b([^>]*\brel="[^"]*\bugc\b[^"]*"[^>]*)>([\s\S]*?)<\/a>/i.exec(rest);
      if (link) {
        found = { name: htmlText(link[2]), url: htmlHref(link[1]) };
      }
    }
    var name = found ? String(found.name || "").replace(/\s+/g, " ").trim() : "";
    var url = found ? String(found.url || "") : "";
    var own = /^https?:\/\//i.test(url) && STORE_HOSTS.every(function (host) {
      return url.toLowerCase().indexOf("//" + host) < 0;
    });
    return { author: name, website: own ? url : chromeListingUrl(id) };
  }

  // A text of Firefox Add-ons' API, which is one string, or one per
  // language: the one in `language`, English, or the first.
  function firefoxText(value, language) {
    if (!value || typeof value === "string") {
      return value || "";
    }
    var lang = String(language || "").split("-")[0];
    return value[language] || value[lang] || value["en-US"] || value.en || value[Object.keys(value)[0]] || "";
  }

  // What Firefox Add-ons says of an add-on (`details`, its API's answer):
  // its authors, its homepage, or else its page there.
  function firefoxListing(details, language) {
    details = details || {};
    var authors = (Array.isArray(details.authors) ? details.authors : []).map(function (author) {
      return String(author && author.name || "").trim();
    }).filter(Boolean);
    var homepage = details.homepage;
    homepage = homepage && typeof homepage === "object" && "url" in homepage ? homepage.url : homepage;
    return {
      author: authors.join(", "),
      website: firefoxText(homepage, language) || String(details.url || "")
    };
  }

  function chromeId(raw) {
    var out = "";
    for (var i = 0; i < 16; i++) {
      out += String.fromCharCode(97 + (raw[i] >> 4)) + String.fromCharCode(97 + (raw[i] & 15));
    }
    return out;
  }

  // A length-delimited field from a CRX3 protobuf header.
  function protobufBytes(data, wanted) {
    var offset = 0;
    function varint() {
      var value = 0;
      for (var shift = 0; shift < 70; shift += 7) {
        if (offset >= data.length) {
          throw new Error("truncated protobuf");
        }
        var byte = data[offset++];
        value += (byte & 127) * Math.pow(2, shift);
        if (!(byte & 128)) {
          return value;
        }
      }
      throw new Error("invalid protobuf integer");
    }
    while (offset < data.length) {
      var tag = varint();
      var wire = tag % 8;
      if (wire === 0) {
        varint();
        continue;
      }
      var length = { 1: 8, 5: 4 }[wire];
      if (wire === 2) {
        length = varint();
      }
      if (length === undefined || offset + length > data.length) {
        throw new Error("invalid protobuf field");
      }
      var start = offset;
      offset += length;
      if (Math.floor(tag / 8) === wanted && wire === 2) {
        return data.subarray(start, offset);
      }
    }
    return new Uint8Array(0);
  }

  // Chrome's identity for the extension, recovered from the store URL, the
  // .crx header or the manifest's key, without changing the Safari bundle's
  // identity. `archive` is the downloaded or given file, if there is one.
  function sourceExtensionId(source, archive, manifest) {
    var storeId = extensionId(source);
    if (storeId) {
      return storeId;
    }
    try {
      if (archive && archive.length >= 16 && bytes.latin1(archive.subarray(0, 4)) === "Cr24") {
        var version = W2S.zip.uint32(archive, 4);
        var length = W2S.zip.uint32(archive, 8);
        if (length > 16 * 1024 * 1024) {
          return null;
        }
        if (version === 2) {
          var key = archive.subarray(16, 16 + length);
          if (key.length && key.length === length) {
            return chromeId(hash.sha256(key));
          }
        } else if (version === 3) {
          var signed = protobufBytes(archive.subarray(12, 12 + length), 10000);
          var identifier = protobufBytes(signed, 1);
          if (identifier.length === 16) {
            return chromeId(identifier);
          }
        }
      }
      var manifestKey = manifest && manifest.key;
      if (manifestKey && typeof manifestKey === "string") {
        return chromeId(hash.sha256(bytes.fromBase64(manifestKey)));
      }
    } catch (e) {
      return null;
    }
    return null;
  }

  W2S.webstore = {
    STORE_HOSTS: STORE_HOSTS,
    downloadUrl: downloadUrl,
    extensionId: extensionId,
    firefoxAddon: firefoxAddon,
    firefoxApiUrl: firefoxApiUrl,
    rawArchiveUrl: rawArchiveUrl,
    chromeListingUrl: chromeListingUrl,
    chromeListing: chromeListing,
    firefoxListing: firefoxListing,
    chromeId: chromeId,
    sourceExtensionId: sourceExtensionId
  };
})(typeof globalThis.W2S === "object" ? globalThis.W2S : (globalThis.W2S = {}));
