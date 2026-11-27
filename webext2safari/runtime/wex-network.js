// Preserve the identity of the browser an extension was built for on its
// native requests, without touching websites: that browser's user agent and
// client hints, and its address for the extension, chrome-extension://<id>,
// or a Firefox build's moz-extension://<uuid> (WEX.WEB_ORIGIN).
(function (g) {
  "use strict";
  var config = WEX.CONFIG, native = WEX.native;
  if (!native || !native.webRequest) return;
  var webOrigin = WEX.WEB_ORIGIN;
  var hosts = webOrigin ? config.networkHosts || [] : [];
  var ownOrigin = WEX.origin.toLowerCase();
  var identity = WEX.requestIdentity();
  var changedRequests = Object.create(null);
  // A WebSocket handshake counts as well: Chrome sends an extension's own
  // origin on it, and servers that admit the extension check for that.
  function allowed(url) {
    return /^(https?|wss?):\/\//i.test(url) && WEX.matchesAny(url, hosts);
  }

  function ownRequest(details) {
    var documentURL = String(details.documentUrl || "");
    var initiator = String(details.initiator || "").toLowerCase();
    return documentURL.indexOf(WEX.baseURI) === 0 || initiator === ownOrigin;
  }

  // Every request the extension's own documents make names the browser it
  // was built for, as that browser's would: its user agent, which
  // navigator.userAgent gives too, and, from a Chrome build to a secure
  // address, Chrome's client hints, which navigator.userAgentData agrees
  // with. A website's requests, and those of a content script, which runs as
  // part of the page, keep Safari's.
  var IDENTITY_HEADERS = /^(user-agent|sec-ch-ua(-.*)?)$/i;
  function withIdentity(headers, secure) {
    var out = headers.filter(function (header) {
      return !IDENTITY_HEADERS.test(header.name);
    });
    out.push({ name: "User-Agent", value: identity.userAgent });
    if (secure) {
      identity.clientHints.forEach(function (header) {
        out.push({ name: header.name, value: header.value });
      });
    }
    return out;
  }

  // Within its host permissions, such a request names the extension by the
  // address the web knows it by, in its Origin (which extraHeaders is
  // required to change): an Origin of the extension's own becomes that one,
  // and a write that has none is given it, while a GET without one stays
  // without, and an Origin of another site stays as it is. Null where the
  // Origin stays.
  function withOrigin(headers, details) {
    var out = headers.slice();
    var found = false;
    for (var i = 0; i < out.length; i++) {
      if (out[i].name.toLowerCase() !== "origin") continue;
      var value = String(out[i].value || "").toLowerCase();
      if (value !== ownOrigin && value !== "null" && value !== webOrigin) return null;
      out[i] = { name: out[i].name, value: webOrigin };
      found = true;
    }
    if (!found) {
      if (/^(GET|HEAD)$/.test(String(details.method || "GET").toUpperCase())) return null;
      out.push({ name: "Origin", value: webOrigin });
    }
    return out;
  }

  function ownRequestHeaders(details) {
    if (details.requestId) delete changedRequests[details.requestId];
    if (!ownRequest(details)) return;
    var headers = withIdentity(details.requestHeaders || [], /^(https|wss):/i.test(details.url));
    var originated = allowed(details.url) ? withOrigin(headers, details) : null;
    if (originated) {
      headers = originated;
      if (details.requestId) changedRequests[details.requestId] = { tabId: details.tabId };
    }
    return { requestHeaders: headers };
  }

  // The wire request uses Chrome's identity, but WebKit still checks CORS
  // against the real Safari origin. Translate only that exact echoed origin
  // for requests we changed; do not widen the server's CORS policy.
  function allowOwnOrigin(details) {
    if (!changedRequests[details.requestId] || !allowed(details.url) || !ownRequest(details)) return;
    var changed = false;
    var headers = (details.responseHeaders || []).map(function (header) {
      if (header.name.toLowerCase() !== "access-control-allow-origin" ||
          header.value !== webOrigin) return header;
      changed = true;
      return { name: header.name, value: ownOrigin };
    });
    if (changed) return { responseHeaders: headers };
  }

  // A site that lets the extension's pages frame it names the extension as
  // Chrome does, in its Content-Security-Policy's frame-ancestors. Each such
  // directive names the extension's own origin here beside it.
  var chromeOrigin = webOrigin ? webOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : null;
  var chromeSource = chromeOrigin ? new RegExp("\\s" + chromeOrigin + "/?(?=\\s|$)", "i") : null;
  function framedHere(header, details) {
    if (!chromeSource || header.name.toLowerCase() !== "content-security-policy" || details.type !== "sub_frame") {
      return null;
    }
    var found = false;
    var value = String(header.value || "").split(";").map(function (directive) {
      if (!/^\s*frame-ancestors\s/i.test(directive) || !chromeSource.test(directive.replace(/\s+$/, ""))) {
        return directive;
      }
      found = true;
      return directive.replace(/\s+$/, "") + " " + WEX.origin;
    }).join(";");
    return found ? value : null;
  }

  function letOwnPagesFrame(details) {
    if (!allowed(details.url)) return;
    var changed = false;
    var headers = (details.responseHeaders || []).map(function (header) {
      var value = framedHere(header, details);
      if (value === null) {
        return header;
      }
      changed = true;
      return { name: header.name, value: value };
    });
    if (changed) return { responseHeaders: headers };
  }

  // Safari runs no content script in a frame of one of the extension's pages
  // outside a tab: its popovers, its bars and the pages of its global page.
  // A site in such a frame has there what the content side gives it in a tab
  // (wex-content.js): from a Chrome build, the extension's Chrome origin
  // among its ancestors (WEX.ancestorPatterns), and, where the manifest's
  // `externally_connectable` lets the site in, Chrome's `chrome.runtime` for
  // web pages, which reaches the extension through the page that frames it
  // (WEX.framedPageRelay). Both run from a script put first in the site's
  // document, which its Content-Security-Policy lets run by a nonce. A frame
  // of the global page itself, which has no such page to reach, has only the
  // ancestor.
  var engineRequest = native.webRequest;
  var chromeBuild = !!webOrigin && /^chrome-extension:/i.test(webOrigin);
  var connectable = ((config.manifest || {}).externally_connectable || {}).matches || [];
  var framesSites = !config.firefoxBuild && typeof engineRequest.filterResponseData === "function" &&
    typeof g.TextEncoder === "function" && (chromeBuild || connectable.length > 0);
  var globalPageAddress = String(g.location && g.location.href || "").split(/[?#]/)[0];
  var framedSites = Object.create(null);

  function newNonce() {
    var bytes = new Uint8Array(16);
    g.crypto.getRandomValues(bytes);
    return WEX.bytesToBase64(bytes);
  }

  function framedSiteScript(site) {
    var parts = [];
    if (site.page && connectable.length && WEX.matchesAny(site.url, connectable)) {
      var token = JSON.stringify(WEX.uid("page"));
      parts.push("(" + WEX.pageRuntime + ")(" + token + ", " + JSON.stringify(WEX.runtimeId) + ");",
        "(" + WEX.framedPageRelay + ")(" + token + ", " + JSON.stringify(ownOrigin) + ");");
    }
    if (chromeBuild) {
      parts.push("(" + WEX.ancestorPatterns + ")(" + JSON.stringify(ownOrigin) + ", " + JSON.stringify(webOrigin) + ");");
    }
    if (!parts.length) {
      return null;
    }
    return "<script nonce=\"" + site.nonce + "\">" + parts.join("\n").replace(/<\/(script)/gi, "<\\/$1") +
      "</script>";
  }

  // A policy that lets the script with `nonce` run beside what it lets run
  // itself. A policy with no rule for scripts, or one that lets every inline
  // script run, stays as it is.
  var SCRIPT_RULES = ["script-src-elem", "script-src", "default-src"];
  function withNonce(value, nonce) {
    return String(value).split(",").map(function (policy) {
      var directives = policy.split(";");
      var names = directives.map(function (directive) {
        return (/^\s*(\S*)/.exec(directive)[1] || "").toLowerCase();
      });
      var at = SCRIPT_RULES.map(function (name) {
        return names.indexOf(name);
      }).filter(function (i) {
        return i >= 0;
      })[0];
      if (at === undefined) {
        return policy;
      }
      var sources = directives[at].trim().split(/\s+/).slice(1);
      var lower = sources.map(function (source) {
        return source.toLowerCase();
      });
      var keyed = lower.some(function (source) {
        return /^'(nonce-|sha(256|384|512)-|strict-dynamic')/.test(source);
      });
      if (lower.indexOf("'unsafe-inline'") >= 0 && !keyed) {
        return policy;
      }
      sources = sources.filter(function (source) {
        return source.toLowerCase() !== "'none'";
      });
      sources.push("'nonce-" + nonce + "'");
      directives[at] = /^\s*/.exec(directives[at])[0] + names[at] + " " + sources.join(" ");
      return directives.join(";");
    }).join(",");
  }

  // Where the script goes in the document's first bytes: just inside its
  // <head> tag, or else past its doctype, or else at its start, past a UTF-8
  // byte order mark. -1 while the place may be in bytes yet to come, and
  // null for a document in UTF-16, which the script's bytes would not suit.
  var HEAD_SCAN = 2048;
  function scriptPlace(bytes, ended) {
    var text = String.fromCharCode.apply(null, bytes.subarray(0, HEAD_SCAN));
    if (/^(\xFE\xFF|\xFF\xFE)/.test(text)) {
      return null;
    }
    var complete = ended || bytes.length >= HEAD_SCAN;
    var head = /<head[\s>\/]/i.exec(text);
    if (head) {
      var close = text.indexOf(">", head.index);
      if (close >= 0) {
        return close + 1;
      }
    }
    if (!complete) {
      return -1;
    }
    var start = text.slice(0, 3) === "\xEF\xBB\xBF" ? 3 : 0;
    var doctype = /^\s*<!doctype[^>]*>/i.exec(text.slice(start));
    return start + (doctype ? doctype[0].length : 0);
  }

  function filterFramedSite(details) {
    var requestId = details.requestId;
    if (details.tabId !== -1 || details.type !== "sub_frame" || framedSites[requestId] || !ownRequest(details)) {
      return;
    }
    var filter;
    try {
      filter = engineRequest.filterResponseData(requestId);
    } catch (e) {
      return;
    }
    var site = framedSites[requestId] = {
      nonce: newNonce(),
      url: details.url,
      html: true,
      page: String(details.documentUrl || "").split(/[?#]/)[0] !== globalPageAddress
    };
    var held = null;
    var placed = false;
    function place(ended) {
      var at = scriptPlace(held, ended);
      if (at === -1) {
        return;
      }
      var bytes = held;
      var script = site.html && at !== null ? framedSiteScript(site) : null;
      placed = true;
      held = null;
      if (script === null) {
        filter.write(bytes);
        return;
      }
      filter.write(bytes.slice(0, at));
      filter.write(new g.TextEncoder().encode(script));
      filter.write(bytes.slice(at));
    }
    filter.ondata = function (event) {
      if (placed) {
        filter.write(event.data);
        return;
      }
      var more = new Uint8Array(event.data);
      if (held) {
        var both = new Uint8Array(held.length + more.length);
        both.set(held);
        both.set(more, held.length);
        more = both;
      }
      held = more;
      place(false);
    };
    filter.onstop = function () {
      if (!placed && held) {
        place(true);
      }
      filter.close();
      delete framedSites[requestId];
    };
    filter.onerror = function () {
      delete framedSites[requestId];
    };
  }

  // The response's headers for a frame of the extension's pages outside a
  // tab: those any frame of its pages has (letOwnPagesFrame), and for a site
  // given the script, a Content-Security-Policy that lets it run. The
  // headers' Content-Type says whether the document is one to give it.
  function framedSiteHeaders(details) {
    var own = letOwnPagesFrame(details);
    var site = framedSites[details.requestId];
    if (!site) {
      return own;
    }
    site.url = details.url;
    var changed = !!own;
    var headers = (own ? own.responseHeaders : details.responseHeaders || []).map(function (header) {
      var name = header.name.toLowerCase();
      if (name === "content-type") {
        site.html = /^\s*text\/html\s*(;|$)/i.test(String(header.value || ""));
      }
      if (name !== "content-security-policy") {
        return header;
      }
      var value = withNonce(header.value, site.nonce);
      if (value === header.value) {
        return header;
      }
      changed = true;
      return { name: header.name, value: value };
    });
    if (changed) return { responseHeaders: headers };
  }

  function forgetFramedSite(details) {
    delete framedSites[details.requestId];
  }

  // A site that sends the browser back to the extension, as a sign-in does
  // when it is done, redirects to the address Chrome gives the extension's
  // page: chrome-extension://<id>/oauth_callback.html?code=... The site sees
  // and names the extension as Chrome does; the tab goes on to that page here,
  // on any site, where the manifest lets the site open it (WEX.pageFromWeb).
  function redirectHere(header, details) {
    if (header.name.toLowerCase() !== "location" || !(details.statusCode >= 300 && details.statusCode < 400)) {
      return null;
    }
    return WEX.pageFromWeb(String(header.value || ""), details.url);
  }

  // Only a site the manifest lets open one of the extension's files can send
  // a frame to it, so only such sites' frames wait on the listener, and none
  // do when the manifest lets no site open any.
  var sites = webOrigin ? WEX.openingSites() : [];
  if (sites.length) native.webRequest.onHeadersReceived.addListener(function (details) {
    var changed = false;
    var headers = (details.responseHeaders || []).map(function (header) {
      var value = redirectHere(header, details);
      if (value === null) {
        return header;
      }
      changed = true;
      return { name: header.name, value: value };
    });
    if (!changed) return;
    watch(details.tabId);
    return { responseHeaders: headers };
  }, { urls: sites, types: ["main_frame", "sub_frame"] }, ["blocking", "responseHeaders", "extraHeaders"]);

  // A request whose address carries the extension's own, from any page or
  // worker, a web page's included, goes to the address as the web knows it.
  // The filter matches the query as well as the path, so only such requests
  // wait on the listener.
  if (webOrigin) native.webRequest.onBeforeRequest.addListener(function (details) {
    var facing = WEX.webFacingText(details.url);
    if (facing !== details.url) return { redirectUrl: facing };
  }, { urls: ["*://*/*safari-extension*"] }, ["blocking"]);

  function forgetRequest(details) {
    delete changedRequests[details.requestId];
  }
  function forgetRedirected(details) {
    if (!allowed(details.redirectUrl || "")) forgetRequest(details);
  }

  // A blocking listener holds every load its filter matches until Safari's
  // main thread, where the global page runs, has answered, and every
  // extension's listeners add up on each load. The listeners above serve only
  // the extension's own documents, so they watch only where those are: tab
  // -1, which holds the global page, its popovers and its bars, and each tab
  // while a frame in it shows one of the extension's pages. A website's loads
  // in any other tab never wait on them.
  var watching = Object.create(null);
  var ownFrames = Object.create(null);
  var WEB = ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"];
  function watch(tabId) {
    if (typeof tabId !== "number" || watching[tabId]) return;
    var own = { urls: hosts, tabId: tabId };
    var frames = { urls: hosts, tabId: tabId, types: ["sub_frame"] };
    var listeners = [[native.webRequest.onBeforeSendHeaders, ownRequestHeaders, { urls: WEB, tabId: tabId },
      ["blocking", "requestHeaders", "extraHeaders"]]];
    // A frame's headers have one listener, which makes every change to them.
    var framed = tabId === -1 && framesSites;
    if (framed) {
      var siteFrames = { urls: ["http://*/*", "https://*/*"], tabId: tabId, types: ["sub_frame"] };
      listeners.push(
        [native.webRequest.onBeforeRequest, filterFramedSite, siteFrames, ["blocking"]],
        [native.webRequest.onHeadersReceived, framedSiteHeaders, siteFrames,
          ["blocking", "responseHeaders", "extraHeaders"]],
        [native.webRequest.onErrorOccurred, forgetFramedSite, siteFrames]);
    }
    if (hosts.length) {
      listeners.push(
        [native.webRequest.onHeadersReceived, allowOwnOrigin, own, ["blocking", "responseHeaders", "extraHeaders"]]);
      if (!framed) {
        listeners.push([native.webRequest.onHeadersReceived, letOwnPagesFrame, frames,
          ["blocking", "responseHeaders", "extraHeaders"]]);
      }
      listeners.push(
        [native.webRequest.onCompleted, forgetRequest, own],
        [native.webRequest.onErrorOccurred, forgetRequest, own],
        [native.webRequest.onBeforeRedirect, forgetRedirected, own]);
    }
    watching[tabId] = listeners.map(function (entry) {
      // Each tab's listeners are functions of their own, so that one tab's
      // can be removed alone.
      var fn = function (details) { return entry[1](details); };
      entry[0].addListener(fn, entry[2], entry[3]);
      return [entry[0], fn];
    });
  }
  function unwatch(tabId) {
    var set = watching[tabId];
    if (!set || tabId === -1) return;
    delete watching[tabId];
    set.forEach(function (entry) {
      try { entry[0].removeListener(entry[1]); } catch (e) { /* already gone */ }
    });
    // The tab's requests still under way end unheard, without their
    // listeners, so they are forgotten with them.
    Object.keys(changedRequests).forEach(function (requestId) {
      if (changedRequests[requestId].tabId === tabId) delete changedRequests[requestId];
    });
  }
  function isOwnPage(url) {
    return String(url || "").indexOf(WEX.baseURI) === 0;
  }
  // A frame that starts toward one of the extension's pages has its tab
  // watched before the page loads anything; its commit settles which frames
  // of the tab show one.
  function frameStarting(details) {
    if (isOwnPage(details.url)) watch(details.tabId);
  }
  function frameCommitted(details) {
    var tabId = details.tabId;
    if (typeof tabId !== "number" || tabId < 0) return;
    var frames = details.frameId === 0 ? {} : ownFrames[tabId] || {};
    if (isOwnPage(details.url)) {
      frames[details.frameId] = true;
    } else {
      delete frames[details.frameId];
    }
    if (Object.keys(frames).length) {
      ownFrames[tabId] = frames;
      watch(tabId);
    } else {
      delete ownFrames[tabId];
      unwatch(tabId);
    }
  }
  watch(-1);
  (function () {
    var navigation = native.webNavigation;
    if (navigation) {
      navigation.onBeforeNavigate.addListener(frameStarting);
      navigation.onCommitted.addListener(frameCommitted);
    }
    if (native.tabs) {
      native.tabs.onRemoved.addListener(function (tabId) {
        delete ownFrames[tabId];
        unwatch(tabId);
      });
      // The tabs that show one of the extension's pages already, from
      // Safari's windows, whose tabs the engine knows by its own ids.
      var app = g.safari && g.safari.application;
      try {
        (app ? app.browserWindows : []).forEach(function (w) {
          (w.tabs || []).forEach(function (t) {
            Promise.resolve(native.tabs.get(t)).then(function (tab) {
              if (tab && isOwnPage(tab.url)) frameCommitted({ tabId: tab.id, frameId: 0, url: tab.url });
            }, function () { /* the tab is closing */ });
          });
        });
      } catch (e) { /* no tabs to look at */ }
    }
  })();
})(this);
