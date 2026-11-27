// Writing a signed .safariextz, which is a xar archive.
//
// The archive is a 28-byte header, a zlib-compressed XML table of contents,
// and a heap. The heap starts with the SHA-1 of the compressed table of
// contents and the RSA signature of that digest; the files' zlib-compressed
// contents follow. The table of contents names the certificate that verifies
// the signature, and Safari installs the archive's one top-level
// .safariextension directory.

(function (W2S) {
  "use strict";

  var bytes = W2S.bytes;
  var hash = W2S.hash;
  var rsa = W2S.rsa;

  // Safari accepts an archive only when its signature names exactly three
  // certificates, and the second is an Apple Worldwide Developer Relations
  // intermediate. These are Apple's own published certificates, which
  // Extension Builder includes in every archive it signs.
  var APPLE_WWDR_CERTIFICATE =
    "MIIEIzCCAwugAwIBAgIBGTANBgkqhkiG9w0BAQUFADBiMQswCQYDVQQGEwJVUzETMBEGA1UEChMK" +
    "QXBwbGUgSW5jLjEmMCQGA1UECxMdQXBwbGUgQ2VydGlmaWNhdGlvbiBBdXRob3JpdHkxFjAUBgNV" +
    "BAMTDUFwcGxlIFJvb3QgQ0EwHhcNMDgwMjE0MTg1NjM1WhcNMTYwMjE0MTg1NjM1WjCBljELMAkG" +
    "A1UEBhMCVVMxEzARBgNVBAoMCkFwcGxlIEluYy4xLDAqBgNVBAsMI0FwcGxlIFdvcmxkd2lkZSBE" +
    "ZXZlbG9wZXIgUmVsYXRpb25zMUQwQgYDVQQDDDtBcHBsZSBXb3JsZHdpZGUgRGV2ZWxvcGVyIFJl" +
    "bGF0aW9ucyBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCC" +
    "AQoCggEBAMo4VKbLVqrIJDlI6Yzu7F+4fyaRvDRTes58Y4Bhd2RepQcjtjn+UC0VVlhwLX7EbsFK" +
    "hT4v8N6EGqFXya97GP9q+hUSSRUIGayq2yoy7ZZjaFIVPYyK7L9rGJXgA6wBfZcFZ84OhZU3au0J" +
    "tq5nzVFkn8Zc0bxXbmc1gHY2pIeBbjiP2CsVTnsl2Fq/ToPBjdKT1RpxtWCcnTNOVfkSWAyGuBYN" +
    "weV3RY1QSLorLeSUheHoxJ3GaKWwo/xnfnC6AllLd0KRObn1zeFM78A7SIym5SFd/Wpqu6cWNWDS" +
    "5q3zRinJ6MOL6XnAamFnFbLw/eVovGJfbs+Z3e8bY/6SZasCAwEAAaOBrjCBqzAOBgNVHQ8BAf8E" +
    "BAMCAYYwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQUiCcXCam2GGCL7Ou69kdZxVJUo7cwHwYD" +
    "VR0jBBgwFoAUK9BpR5R2Cf70a40uQKb3R01/CF4wNgYDVR0fBC8wLTAroCmgJ4YlaHR0cDovL3d3" +
    "dy5hcHBsZS5jb20vYXBwbGVjYS9yb290LmNybDAQBgoqhkiG92NkBgIBBAIFADANBgkqhkiG9w0B" +
    "AQUFAAOCAQEA2jIAlsVUlNM7gjdmfS5o1cPGuMsmjEiQzxMkakaOY9Tw0BMG3djEwTcV8jMTOSYt" +
    "zi5VQOMLA6/6EsLnDSG41YDPrCgvzi2zTq+GGQTG6VDdTClHECP8bLsbmGtIieFbnd5G2zWFNe8+" +
    "0OJYSzj07XVaH1xwHVY5EuXhDRHkiSUGvdW0FY5e0FmXkOlLgeLfGK9EdB4ZoDpHzJEdOusjWv6l" +
    "LZf3e7vWh0ZChetSPSayY6i0scqP9Mzis8hH4L+aWYP62phTKoL1fGUuldkzXfXtZcwxN8VaBOhr" +
    "4eeIA0p1npsoy0pAiGVDdd3LOiUjxZ5X+C7O0qmSXnMuLyV1FQ==";
  var APPLE_ROOT_CERTIFICATE =
    "MIIEuzCCA6OgAwIBAgIBAjANBgkqhkiG9w0BAQUFADBiMQswCQYDVQQGEwJVUzETMBEGA1UEChMK" +
    "QXBwbGUgSW5jLjEmMCQGA1UECxMdQXBwbGUgQ2VydGlmaWNhdGlvbiBBdXRob3JpdHkxFjAUBgNV" +
    "BAMTDUFwcGxlIFJvb3QgQ0EwHhcNMDYwNDI1MjE0MDM2WhcNMzUwMjA5MjE0MDM2WjBiMQswCQYD" +
    "VQQGEwJVUzETMBEGA1UEChMKQXBwbGUgSW5jLjEmMCQGA1UECxMdQXBwbGUgQ2VydGlmaWNhdGlv" +
    "biBBdXRob3JpdHkxFjAUBgNVBAMTDUFwcGxlIFJvb3QgQ0EwggEiMA0GCSqGSIb3DQEBAQUAA4IB" +
    "DwAwggEKAoIBAQDkkakJH5HbHkdQ6wXtXnmELes2oldMVeyLGYne+Uts9QerIjAC6Bg++FAJ039B" +
    "qJj50cpmnCRrEdCju+QbKsMflZ56DKRHi1vUFjczy8QPTc4UadHJGXL1XQ7Vf1+b8iUDulWPTV0N" +
    "8WQ1IxVLFVkds5T39pyez1C6wVhQZ48ItCD3y6wsIG9wtj8BMIy3Q88PnT3zK0koGsj+zrW5Dtle" +
    "HNbLPbU6rfQPDgCSC7EhFi501TwN22IWq6NxkkdTVcGvL0Gz+PvjcM3mo0xFfh9Ma1CWQYnEdGIL" +
    "EINBhzOKgbEwWOxaBDKMaLOPHd5lc/9nXmW8Sdh2nzMUZaF3lMktAgMBAAGjggF6MIIBdjAOBgNV" +
    "HQ8BAf8EBAMCAQYwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQUK9BpR5R2Cf70a40uQKb3R01/" +
    "CF4wHwYDVR0jBBgwFoAUK9BpR5R2Cf70a40uQKb3R01/CF4wggERBgNVHSAEggEIMIIBBDCCAQAG" +
    "CSqGSIb3Y2QFATCB8jAqBggrBgEFBQcCARYeaHR0cHM6Ly93d3cuYXBwbGUuY29tL2FwcGxlY2Ev" +
    "MIHDBggrBgEFBQcCAjCBthqBs1JlbGlhbmNlIG9uIHRoaXMgY2VydGlmaWNhdGUgYnkgYW55IHBh" +
    "cnR5IGFzc3VtZXMgYWNjZXB0YW5jZSBvZiB0aGUgdGhlbiBhcHBsaWNhYmxlIHN0YW5kYXJkIHRl" +
    "cm1zIGFuZCBjb25kaXRpb25zIG9mIHVzZSwgY2VydGlmaWNhdGUgcG9saWN5IGFuZCBjZXJ0aWZp" +
    "Y2F0aW9uIHByYWN0aWNlIHN0YXRlbWVudHMuMA0GCSqGSIb3DQEBBQUAA4IBAQBcNplMLXi37Yyb" +
    "3PN3m/J20ncwT8EfhYOFG5k9RzfyqZtAjizUsZAS2L70c5vu0mQPy3lPNNiiPvl4/2vIB+x9OYOL" +
    "UyDTOMSxv5pPCmv/K/xZpwUJfBdAVhEedNO3iyM7R6PVbyTi69G3cN8PReEnyvFteO3ntRcXqNx+" +
    "IjXKJdXZD9Zr1KIkIxH3oayPc4FgxhtbCS+SsvhESPBgOJ4V9T0mZyCKM2r3DYLP3uujL/lTaltk" +
    "wGMzd/c6ByxW69oPIQ7aunMZT7XZNn/Bh1XZp5m5MkL72NVxnn6hUrcbvZNCJBIqxw8dtk2cXmPI" +
    "S4AXUKqK1drk/NAJBzewdXUh";

  var SIGNATURE_SIZE = 256;
  var CHECKSUM_SIZE = 20;
  // Seconds between the Unix epoch and 2001-01-01, where Apple's clock starts.
  var APPLE_EPOCH = 978307200;

  function escape(value) {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // Characters XML 1.0 cannot hold, even escaped.
  var NOT_XML = /[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]/;

  // A <name> element. A table of contents with any other characters in it
  // would make the archive unreadable, so such a name stops the signing.
  function nameElement(value) {
    if (NOT_XML.test(value)) {
      throw new Error("the file name " + JSON.stringify(value) + " has a character a " +
                      ".safariextz cannot hold");
    }
    return "<name>" + escape(value) + "</name>";
  }

  function isoTime(date) {
    return date.toISOString().replace(/\.\d+Z$/, "");
  }

  function wrap(value, width) {
    var lines = [];
    for (var i = 0; i < value.length; i += width) {
      lines.push(value.substr(i, width));
    }
    return lines.join("\n");
  }

  // Groups "a/b/c" paths into a tree of directories, each sorted by name.
  function tree(files) {
    var root = { dirs: Object.create(null), files: [] };
    Object.keys(files).sort().forEach(function (path) {
      var parts = path.split("/");
      var node = root;
      for (var i = 0; i < parts.length - 1; i++) {
        node = node.dirs[parts[i]] || (node.dirs[parts[i]] = { dirs: Object.create(null), files: [] });
      }
      node.files.push({ name: parts[parts.length - 1], data: files[path] });
    });
    return root;
  }

  // Packs `files`, a map from bundle-relative path to contents, into a signed
  // archive whose single directory is `rootName`, signed by `identity` as
  // rsa.loadIdentity returns it.
  function pack(rootName, files, identity, options) {
    options = options || {};
    var now = options.now || new Date();
    var heap = [];
    var heapOffset = CHECKSUM_SIZE + SIGNATURE_SIZE;
    var nextId = 1;
    var xml = [];

    function line(depth, value) {
      xml.push(new Array(depth + 1).join(" ") + value);
    }

    function addFile(depth, entry) {
      var compressed = W2S.pako.deflate(entry.data, { level: 6 });
      line(depth, '<file id="' + (nextId++) + '">');
      line(depth + 1, nameElement(entry.name));
      line(depth + 1, "<type>file</type>");
      line(depth + 1, "<mode>0644</mode>");
      line(depth + 1, "<data>");
      line(depth + 2, "<length>" + compressed.length + "</length>");
      line(depth + 2, "<offset>" + heapOffset + "</offset>");
      line(depth + 2, "<size>" + entry.data.length + "</size>");
      line(depth + 2, '<encoding style="application/x-gzip"/>');
      line(depth + 2, '<extracted-checksum style="sha1">' + bytes.hex(hash.sha1(entry.data)) +
        "</extracted-checksum>");
      line(depth + 2, '<archived-checksum style="sha1">' + bytes.hex(hash.sha1(compressed)) +
        "</archived-checksum>");
      line(depth + 1, "</data>");
      line(depth, "</file>");
      heap.push(compressed);
      heapOffset += compressed.length;
    }

    function addDirectory(depth, dirName, node) {
      line(depth, '<file id="' + (nextId++) + '">');
      line(depth + 1, nameElement(dirName));
      line(depth + 1, "<type>directory</type>");
      line(depth + 1, "<mode>0755</mode>");
      Object.keys(node.dirs).sort().forEach(function (child) {
        addDirectory(depth + 1, child, node.dirs[child]);
      });
      node.files.forEach(function (entry) { addFile(depth + 1, entry); });
      line(depth, "</file>");
    }

    var certificates = [identity.certificate, bytes.fromBase64(APPLE_WWDR_CERTIFICATE),
                        bytes.fromBase64(APPLE_ROOT_CERTIFICATE)];

    xml.push('<?xml version="1.0" encoding="UTF-8"?>');
    line(0, "<xar>");
    line(1, "<toc>");
    line(2, "<signature-creation-time>" + (now.getTime() / 1000 - APPLE_EPOCH).toFixed(1) +
      "</signature-creation-time>");
    line(2, '<checksum style="sha1">');
    line(3, "<size>" + CHECKSUM_SIZE + "</size>");
    line(3, "<offset>0</offset>");
    line(2, "</checksum>");
    line(2, "<creation-time>" + isoTime(now) + "</creation-time>");
    line(2, '<signature style="RSA">');
    line(3, "<offset>" + CHECKSUM_SIZE + "</offset>");
    line(3, "<size>" + SIGNATURE_SIZE + "</size>");
    line(3, '<KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#">');
    line(4, "<X509Data>");
    certificates.forEach(function (cert) {
      line(5, "<X509Certificate>" + wrap(bytes.base64(cert), 72) + "</X509Certificate>");
    });
    line(4, "</X509Data>");
    line(3, "</KeyInfo>");
    line(2, "</signature>");
    addDirectory(2, rootName, tree(files));
    line(1, "</toc>");
    line(0, "</xar>");

    var toc = bytes.utf8(xml.join("\n") + "\n");
    var compressedToc = W2S.pako.deflate(toc, { level: 9 });
    var checksum = hash.sha1(compressedToc);
    var signature = rsa.signSha1(identity.key, compressedToc);
    if (signature.length !== SIGNATURE_SIZE) {
      throw new Error("the signing key must be a 2048-bit RSA key");
    }

    var header = new Uint8Array(28);
    var view = new DataView(header.buffer);
    view.setUint32(0, 0x78617221);
    view.setUint16(4, 28);
    view.setUint16(6, 1);
    view.setUint32(8, 0);
    view.setUint32(12, compressedToc.length);
    view.setUint32(16, 0);
    view.setUint32(20, toc.length);
    view.setUint32(24, 1);

    return bytes.concat([header, compressedToc, checksum, signature].concat(heap));
  }

  W2S.xar = { pack: pack };
})(typeof globalThis.W2S === "object" ? globalThis.W2S : (globalThis.W2S = {}));
