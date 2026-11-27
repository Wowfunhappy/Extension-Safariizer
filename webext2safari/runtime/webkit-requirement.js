// The least WebKit a legacy Safari extension runs in.
//
// WebKit gives its version in the user agent the way Safari does, 27.2 in
// "... (KHTML, like Gecko) Version/27.2 Safari/605.1.15", and that is the
// version compared with WEBKIT_MINIMUM, which webkit-minimum.js, loaded just
// before this, defines. A user agent that gives no version is too old; with
// no minimum defined, any WebKit is new enough.
//
// The global page loads both ahead of its other scripts, and calls
// WebKitRequirement.start(name) before anything of the extension starts. In
// an older WebKit, that tells the user the extension named `name` needs a
// newer one, keeps the scripts after it in the page from running, and returns
// false. A content script asks WebKitRequirement.met(), which tells no one.
//
// It depends on nothing else, so any legacy Safari extension can carry it.

var WebKitRequirement = (function (g) {
  "use strict";

  // Whether version `have` is at least `need`, both as text such as "27.2".
  // A part one of them lacks counts as 0, so 28 is at least 27.2.
  function atLeast(have, need) {
    var a = have.split(".").map(Number);
    var b = need.split(".").map(Number);
    for (var i = 0; i < Math.max(a.length, b.length); i++) {
      if ((a[i] || 0) !== (b[i] || 0)) {
        return (a[i] || 0) > (b[i] || 0);
      }
    }
    return true;
  }

  var minimum = g.WEBKIT_MINIMUM;
  var version = /\bVersion\/(\d+(?:\.\d+)*)/.exec(String(g.navigator && g.navigator.userAgent || ""));
  var enough = !minimum || !!version && atLeast(version[1], String(minimum));

  function met() {
    return enough;
  }

  function start(name) {
    if (enough) {
      return true;
    }
    // While the page is still being read, what follows this script in it is
    // read as text, and none of its scripts run.
    var doc = g.document;
    if (doc && doc.readyState === "loading") {
      doc.write("<plaintext hidden>");
    }
    g.alert(name + " requires a newer version of WebKit. Please update to the latest " +
            "version of Aqua WebKit to use " + name + ".");
    return false;
  }

  return { met: met, start: start };
})(this);
