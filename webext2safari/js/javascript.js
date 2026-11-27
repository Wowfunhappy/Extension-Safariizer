// Conservative, browser-independent JavaScript URL adaptations.
//
// Literal Chrome origins and paths constructed from a module's origin can be
// adapted without examining extension identities. Template interpolations
// are followed, and the tokens before a slash tell a regular expression from
// division. This is a lexer for limited transformations, not a JavaScript
// parser.

(function (W2S) {
  "use strict";

  var bytes = W2S.bytes;

  var IDENTIFIER = /[\p{ID_Start}_$][\p{ID_Continue}_$\u200c\u200d]*/uy;
  // The characters Python's str.isspace() accepts.
  var SPACE = /[\t\n\x0b\x0c\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;

  var LINE_ENDS = "\n\r\u2028\u2029";
  // Words after which a slash starts a regular expression rather than dividing.
  var REGEX_AFTER_WORDS = ["return", "typeof", "instanceof", "in", "of", "new", "delete",
    "void", "throw", "case", "do", "else", "yield", "await", "default"];

  // Words whose parenthesized head a statement follows.
  var STATEMENT_HEADS = ["if", "while", "for", "with"];

  // The index of the last token at or before `k` that is not a comment, or -1.
  function lastCode(list, k) {
    while (k >= 0 && list[k][0] === "comment") {
      k--;
    }
    return k;
  }

  // Whether a `(` after `list` opens a statement's head, as in `if (a)` or
  // `for await (a of b)`, and not a call of a property named `if`.
  function opensStatementHead(list) {
    var k = lastCode(list, list.length - 1);
    if (k >= 0 && list[k][1] === "await") {
      k = lastCode(list, k - 1);
      return k >= 0 && list[k][1] === "for";
    }
    if (k < 0 || STATEMENT_HEADS.indexOf(list[k][1]) < 0) {
      return false;
    }
    k = lastCode(list, k - 1);
    return k < 0 || list[k][1] !== ".";
  }

  // Whether a slash after `list` starts a regular expression. `afterHead` says
  // the last `)` closed a statement's head, which a statement follows. A `}`
  // takes a regular expression too: it ends a block far more often than
  // anything a script would divide.
  function regexAllowed(list, afterHead) {
    for (var k = list.length - 1; k >= 0; k--) {
      var kind = list[k][0];
      var text = list[k][1];
      if (kind === "comment") {
        continue;
      }
      if (kind === "identifier") {
        // A property may be named as one of the words: `e.default / 2`.
        var before = lastCode(list, k - 1);
        return REGEX_AFTER_WORDS.indexOf(text) >= 0 &&
          (before < 0 || (list[before][1] !== "." && list[before][1] !== "#"));
      }
      if (kind === "punctuation") {
        // After `++` or `--` a slash divides: an increment's operand is never
        // a regular expression. A run of adjacent signs is read in pairs, so
        // an odd one ends with a sign that does take an operand.
        if (text === "+" || text === "-") {
          var run = 1;
          while (k - run >= 0 && list[k - run][1] === text &&
                 list[k - run][3] === list[k - run + 1][2]) {
            run++;
          }
          if (run % 2 === 0) {
            return false;
          }
        }
        if (text === ")") {
          return afterHead;
        }
        return text !== "]" && "0123456789".indexOf(text) < 0;
      }
      return kind === "template_start_expr";
    }
    return true;
  }

  // The index of the line ending at or after `i`, or the length of `source`.
  function lineEndFrom(source, i) {
    while (i < source.length && LINE_ENDS.indexOf(source[i]) < 0) {
      i++;
    }
    return i;
  }

  // The tokens of `source`, or [] where it cannot be followed. A slash
  // outside a comment is followed only with `regex`, which tells a regular
  // expression from division by the token before it.
  function tokens(source, templateExpressions, regex) {
    var out = [];
    var i = 0;
    // Template text is kept opaque; only ${...} is JavaScript. Each code frame
    // records its brace depth so objects and nested templates do not
    // accidentally end an interpolation.
    var modes = [["code", 0]];
    // For each open `(`, whether it opens a statement's head.
    var parens = [];
    var afterHead = false;
    // A hashbang line reads as a comment.
    if (source.startsWith("#!")) {
      i = lineEndFrom(source, 0);
      out.push(["comment", source.slice(0, i), 0, i]);
    }
    while (i < source.length) {
      var start = i;
      var c = source[i];
      var kind;
      if (modes[modes.length - 1][0] === "template") {
        if (c === "`") {
          out.push(["template", c, i, i + 1]);
          modes.pop();
          i += 1;
        } else if (source.startsWith("${", i)) {
          out.push(["template_start_expr", "${", i, i + 2]);
          modes.push(["expression", 0]);
          i += 2;
        } else {
          while (i < source.length && source[i] !== "`" && !source.startsWith("${", i)) {
            i += source[i] === "\\" ? 2 : 1;
          }
          out.push(["template_text", source.slice(start, i), start, i]);
        }
        continue;
      }
      if (SPACE.test(c)) {
        i += 1;
        continue;
      }
      if (source.startsWith("//", i)) {
        i = lineEndFrom(source, i);
        kind = "comment";
      } else if (source.startsWith("/*", i)) {
        var commentEnd = source.indexOf("*/", i + 2);
        if (commentEnd < 0) {
          return [];
        }
        i = commentEnd + 2;
        kind = "comment";
      } else if (c === "`" && templateExpressions) {
        out.push(["template", c, i, i + 1]);
        modes.push(["template", 0]);
        i += 1;
        continue;
      } else if (c === "/" && regex && regexAllowed(out, afterHead)) {
        i += 1;
        var inClass = false;
        while (i < source.length && (source[i] !== "/" || inClass)) {
          if (LINE_ENDS.indexOf(source[i]) >= 0) {
            return [];
          }
          if (source[i] === "\\") {
            i += 1;
          } else if (source[i] === "[") {
            inClass = true;
          } else if (source[i] === "]") {
            inClass = false;
          }
          i += 1;
        }
        if (i >= source.length) {
          return [];
        }
        i += 1;
        while (i < source.length && /[A-Za-z]/.test(source[i])) {
          i += 1;
        }
        kind = "regex";
      } else if (c === "/" && regex) {
        i += 1;
        kind = "punctuation";
      } else if (c === "/" || c === "`") {
        return [];
      } else if (c === '"' || c === "'") {
        i += 1;
        while (i < source.length && source[i] !== c) {
          i += source[i] === "\\" ? 2 : 1;
        }
        if (i >= source.length) {
          return [];
        }
        i += 1;
        kind = "string";
      } else {
        var frame = modes[modes.length - 1];
        if (frame[0] === "expression") {
          if (c === "{") {
            frame[1] += 1;
          } else if (c === "}") {
            if (frame[1] === 0) {
              out.push(["template_end_expr", c, i, i + 1]);
              modes.pop();
              i += 1;
              continue;
            }
            frame[1] -= 1;
          }
        }
        if (c === "(") {
          parens.push(opensStatementHead(out));
        } else if (c === ")") {
          afterHead = parens.pop() === true;
        }
        IDENTIFIER.lastIndex = i;
        var match = IDENTIFIER.exec(source);
        if (match) {
          i = IDENTIFIER.lastIndex;
          kind = "identifier";
        } else {
          i += 1;
          kind = "punctuation";
        }
      }
      out.push([kind, source.slice(start, i), start, i]);
    }
    return modes.length === 1 ? out : [];
  }

  function applyEdits(source, edits) {
    for (var i = edits.length - 1; i >= 0; i--) {
      source = source.slice(0, edits[i][0]) + edits[i][2] + source.slice(edits[i][1]);
    }
    return source;
  }

  var MODULE_ORIGIN = ["new", "URL", "(", "import", ".", "meta", ".", "url", ")", ".", "origin"];

  // Preserves Safari's session token in paths built from a module origin.
  // Only `new URL(import.meta.url).origin` followed by a slash, in a template
  // or string concatenation, is changed. Origin comparisons stay untouched.
  // The expression is self-contained: injected page modules have no WEX API.
  function rewriteModuleOriginPaths(source) {
    var list = tokens(source, true, true);
    var edits = [];
    for (var i = 0; i < list.length - MODULE_ORIGIN.length; i++) {
      var end = i + MODULE_ORIGIN.length;
      var same = true;
      for (var j = 0; j < MODULE_ORIGIN.length; j++) {
        if (list[i + j][1] !== MODULE_ORIGIN[j]) {
          same = false;
          break;
        }
      }
      if (!same) {
        continue;
      }
      var following = list.slice(end, end + 2);
      var concatenated = following.length === 2 && following[0][1] === "+" &&
        following[1][0] === "string" && following[1][1].slice(1, -1).indexOf("/") === 0;
      var interpolated = i > 0 && list[i - 1][0] === "template_start_expr" &&
        following.length === 2 && following[0][0] === "template_end_expr" &&
        following[1][0] === "template_text" && following[1][1].indexOf("/") === 0;
      if (!(concatenated || interpolated)) {
        continue;
      }
      edits.push([list[i][2], list[end - 1][3],
        '(function (url) { return url.protocol === "safari-extension:"' +
        ' ? url.href.split("/").slice(0, 4).join("/") : url.origin; })' +
        "(new URL(import.meta.url))"]);
    }
    return { source: applyEdits(source, edits), count: edits.length };
  }

  // Maps an address of an extension built from its id, as
  // `"chrome-extension://" + id + "/..."` or `` `chrome-extension://${id}/...` ``,
  // or a Firefox build's own as `moz-extension://` and the uuid,
  // to what the runtime gives for it (WEX.chromeExtensionOrigin): the
  // extension's own origin for its own id, another converted extension's for
  // its id, and the address as written otherwise. The id is a name, or a
  // property of one. Comments and string contents are never edited, and
  // neither is a tagged template, whose tag sees text and values apart. The
  // fallback preserves the original behaviour in a page world without the
  // runtime bridge.
  var EXTENSION_PROTOCOLS = ["chrome-extension://", "moz-extension://"];

  function chromeOriginExpression(expression, protocol) {
    return '(typeof WEX !== "undefined" && typeof WEX.chromeExtensionOrigin === "function"' +
      " ? WEX.chromeExtensionOrigin(" + expression + ') : "' + protocol + '" + ' + expression + ")";
  }

  // The extension protocol `text` ends with, or null.
  function endingProtocol(text) {
    for (var i = 0; i < EXTENSION_PROTOCOLS.length; i++) {
      var p = EXTENSION_PROTOCOLS[i];
      if (text.slice(-p.length) === p) {
        return p;
      }
    }
    return null;
  }

  // The index of the token after the name, or property of one, at `i`.
  function afterName(list, i) {
    if (i >= list.length || list[i][0] !== "identifier") {
      return -1;
    }
    var j = i + 1;
    while (j + 1 < list.length && list[j][1] === "." && list[j + 1][0] === "identifier") {
      j += 2;
    }
    return j;
  }

  function rewriteChromeOrigins(source) {
    var list = tokens(source, true, true);
    var edits = [];
    var count = 0;
    for (var i = 0; i < list.length; i++) {
      var token = list[i];
      var j;
      var protocol;
      if (token[0] === "string" && EXTENSION_PROTOCOLS.indexOf(token[1].slice(1, -1)) >= 0) {
        protocol = token[1].slice(1, -1);
        if (i + 1 >= list.length || list[i + 1][1] !== "+") {
          continue;
        }
        j = afterName(list, i + 2);
        if (j < 0 || j + 1 >= list.length || list[j][1] !== "+" || list[j + 1][0] !== "string" ||
            list[j + 1][1].slice(1, -1).indexOf("/") !== 0) {
          continue;
        }
        edits.push([token[2], list[j - 1][3],
          chromeOriginExpression(source.slice(list[i + 2][2], list[j - 1][3]), protocol)]);
        count++;
      } else if (token[0] === "template_text" && (protocol = endingProtocol(token[1])) &&
          i + 1 < list.length && list[i + 1][0] === "template_start_expr") {
        var opening = i;
        while (opening > 0 && list[opening][0] !== "template") {
          opening -= 1;
        }
        var before = opening > 0 ? list[opening - 1] : null;
        if (before && (before[0] === "identifier" || before[1] === ")" || before[1] === "]")) {
          continue;
        }
        j = afterName(list, i + 2);
        if (j < 0 || j + 1 >= list.length || list[j][0] !== "template_end_expr" ||
            list[j + 1][0] !== "template_text" || list[j + 1][1].indexOf("/") !== 0) {
          continue;
        }
        edits.push([token[3] - protocol.length, token[3], ""]);
        edits.push([list[i + 2][2], list[j - 1][3],
          chromeOriginExpression(source.slice(list[i + 2][2], list[j - 1][3]), protocol)]);
        count++;
      }
    }
    return { source: applyEdits(source, edits), count: count };
  }

  // The window's own location, as scripts name it.
  var LOCATION_OWNERS = ["window", "self", "globalThis", "document"];
  // An operator that writes to the property before it.
  var ASSIGNMENT = /^(?:=(?!=)|(?:[-+*\/%&|^]|\*\*|<<|>>>?|&&|\|\||\?\?)=|\+\+|--)/;

  // The punctuation that starts at code[k], its characters adjacent.
  function operatorAfter(code, k) {
    var operator = "";
    while (k < code.length && code[k][0] === "punctuation" && operator.length < 4) {
      if (operator && code[k][2] !== code[k - 1][3]) {
        break;
      }
      operator += code[k][1];
      k += 1;
    }
    return operator;
  }

  // Reads the page's path, origin and address as Chrome gives them. Safari's
  // address for an extension page carries a session token as its first path
  // segment, which `location.pathname` includes and `location.origin` leaves
  // out, and WebKit gives the origin with its host in lowercase; the
  // runtime's `__wexPathname` gives the path within the bundle, and its
  // `__wexOrigin` the origin the runtime gives the extension's URLs, messages
  // and senders (written as Safari spells it, and ending with the token), so
  // that an address built on it works and a comparison with any of those
  // agrees. A service worker's location is its script's address, which the
  // runtime's `__wexPathname` and `__wexHref` give in the global page that
  // stands in for one. A read of the window's location falls back to the plain
  // property where the runtime is absent, as in a page's own world, or where
  // `location` names an object of the extension's own. Assignments and other
  // syntax are left untouched.
  function rewriteLocationPaths(source) {
    var code = tokens(source, true, true).filter(function (t) {
      return t[0] !== "comment";
    });
    var edits = [];
    for (var i = 0; i < code.length; i++) {
      var token = code[i];
      if (token[0] !== "identifier" || token[1] !== "location") {
        continue;
      }
      if (i + 2 >= code.length || code[i + 1][1] !== "." ||
          (code[i + 2][1] !== "pathname" && code[i + 2][1] !== "origin" && code[i + 2][1] !== "href")) {
        continue;
      }
      var start = i;
      if (i > 0 && code[i - 1][1] === ".") {
        if (i < 2 || LOCATION_OWNERS.indexOf(code[i - 2][1]) < 0 ||
            (i > 2 && code[i - 3][1] === ".")) {
          continue;
        }
        start = i - 2;
      }
      var operator = operatorAfter(code, i + 3);
      if (ASSIGNMENT.test(operator)) {
        continue;
      }
      var owner = source.slice(code[start][2], token[3]);
      var name = code[i + 2][1];
      edits.push([code[start][2], code[i + 2][3], "(" + owner + ".__wex" +
        name.charAt(0).toUpperCase() + name.slice(1) + " ?? " + owner + "." + name + ")"]);
    }
    return { source: applyEdits(source, edits), count: edits.length };
  }

  // Properties of a window that a service worker's global does not have, and
  // that a window will not let a script assign or redefine; the runtime
  // makes the others a worker can assign (localStorage, history and the
  // like) assignable in the global page of a service worker.
  var WINDOW_ONLY = ["window", "document", "top"];
  var WINDOW_ONLY_ASSIGNMENT = /\.\s*(?:window|document)\s*(?:\|\||&&|\?\?)?=(?!=)|\b(?:window|self|globalThis)\s*\.\s*top\s*(?:\|\||&&|\?\?)?=(?!=)|\b(?:self|globalThis)\s*\.\s*(?:window|document|location)\b|["'](?:window|document)["']\s+in\s+(?:self|globalThis)\b|\}\s*=\s*(?:self|globalThis)\b/;
  // The members a worker's global has of its own, which a destructuring of
  // the global reads from the worker's view of it.
  var WORKER_OWN = ["location", "window", "document"];
  // The worker's names for its global, through which a read of its `window`
  // or `document` is the worker's own.
  var WORKER_NAMES = ["self", "globalThis"];
  // The global's own names for itself, the only owners a `top` is taken to
  // be the global's for: any object can have a `top`, as a style does.
  var GLOBAL_NAMES = ["window", "self", "globalThis"];

  // A service worker can give its global a `window` or `document` of its own
  // (`globalThis.window = {}`, or through a name a bundler gives the global,
  // `e.window = {}`), which a window, where the global page runs the worker,
  // refuses with a TypeError in strict code. Such an assignment names the
  // runtime's `__wexWorkerScope` as its target, which the global page of a
  // service worker has and which takes the value instead; anywhere else, and
  // for any other object, the assignment is made as written. The owner is a
  // name, `this`, or a chain of names (`n.g`). A read of `self.window` or
  // `globalThis.document` goes to the worker scope as well, where it is
  // what the worker assigned, or nothing, as in a worker (one may
  // set `self.window` to an object with a `localStorage` of its own and
  // read it back). A read of `self.location` or `globalThis.location` as
  // a whole, rather than of one of its members, goes there too, where it is
  // the worker's location (a worker may check the path of the location
  // it is handed). `"document" in self` asks the worker scope as well, so
  // that a test and the read it guards agree (as `self.document` read
  // where `"document" in self`). A destructuring of `self` or `globalThis`
  // that takes its `location`, `window` or `document`
  // (`const {location: l, fetch: f} = self`) destructures the runtime's
  // `__wexWorkerSelf` instead, which answers those from the worker scope and
  // the rest from the global.
  function rewriteWorkerGlobals(source) {
    if (!WINDOW_ONLY_ASSIGNMENT.test(source)) {
      return { source: source, count: 0 };
    }
    var code = tokens(source, true, true).filter(function (t) {
      return t[0] !== "comment";
    });
    function isName(token) {
      return token[0] === "identifier" || (token[0] === "keyword" && token[1] === "this");
    }
    // Whether the object pattern that closes at `close` takes one of the
    // worker's own members.
    function takesWorkerOwn(close) {
      var depth = 0;
      for (var k = close; k >= 0; k--) {
        var text = code[k][1];
        if (code[k][0] === "punctuation" && (text === "}" || text === "]" || text === ")")) {
          depth++;
        } else if (code[k][0] === "punctuation" && (text === "{" || text === "[" || text === "(")) {
          depth--;
          if (depth === 0) {
            return false;
          }
        } else if (depth === 1 && code[k][0] === "identifier" && WORKER_OWN.indexOf(text) >= 0 &&
                   /^(?:\{|,)$/.test(code[k - 1][1]) && /^(?::|,|\}|=)$/.test(code[k + 1][1])) {
          return true;
        }
      }
      return false;
    }
    var edits = [];
    for (var i = 0; i + 2 < code.length; i++) {
      if (code[i][1] === "}" && code[i + 1][1] === "=" && WORKER_NAMES.indexOf(code[i + 2][1]) >= 0 &&
          !(code[i + 3] && /^(?:\.|\?\.|\[|\(|=)$/.test(code[i + 3][1])) && takesWorkerOwn(i)) {
        edits.push([code[i + 2][2], code[i + 2][3],
          "(" + code[i + 2][1] + ".__wexWorkerSelf ?? " + code[i + 2][1] + ")"]);
        continue;
      }
      // `"document" in self` asks the worker scope, as the read after it does.
      if (code[i][0] === "string" && /^(["'])(?:window|document)\1$/.test(code[i][1]) &&
          code[i + 1][1] === "in" && WORKER_NAMES.indexOf(code[i + 2][1]) >= 0 &&
          !(code[i + 3] && /^(?:\.|\?\.|\[)$/.test(code[i + 3][1]))) {
        edits.push([code[i + 2][2], code[i + 2][3],
          "(" + code[i + 2][1] + ".__wexWorkerScope ?? " + code[i + 2][1] + ")"]);
        continue;
      }
      var owner = code[i];
      var property = code[i + 2][1];
      if (property === "location" && isName(owner) && code[i + 1][1] === "." &&
          WORKER_NAMES.indexOf(owner[1]) >= 0 && (i === 0 || !/^(?:\.|\?\.)$/.test(code[i - 1][1])) &&
          !/^(?:\.|\?\.|\[|=|\(|`)/.test(operatorAfter(code, i + 3) || (code[i + 3] ? code[i + 3][1] : ""))) {
        edits.push([owner[2], owner[3], "(" + owner[1] + ".__wexWorkerScope ?? " + owner[1] + ")"]);
        continue;
      }
      if (!isName(owner) || code[i + 1][1] !== "." || WINDOW_ONLY.indexOf(property) < 0) {
        continue;
      }
      var after = operatorAfter(code, i + 3);
      if (!/^(?:=(?![=>])|(?:\|\||&&|\?\?)=)/.test(after)) {
        if (property !== "top" && WORKER_NAMES.indexOf(owner[1]) >= 0 && !ASSIGNMENT.test(after) &&
            (i === 0 || !/^(?:\.|\?\.)$/.test(code[i - 1][1]))) {
          edits.push([owner[2], owner[3], "(" + owner[1] + ".__wexWorkerScope ?? " + owner[1] + ")"]);
        }
        continue;
      }
      var start = i;
      while (start >= 2 && code[start - 1][1] === "." && isName(code[start - 2])) {
        start -= 2;
      }
      if (start > 0 && /^(?:\.|\?\.|\)|\])$/.test(code[start - 1][1])) {
        continue;
      }
      var chain = source.slice(code[start][2], owner[3]);
      if (chain === "document" ||
          (property === "top" && (start !== i || GLOBAL_NAMES.indexOf(owner[1]) < 0))) {
        continue;
      }
      edits.push([code[start][2], owner[3], "(" + chain + ".__wexWorkerScope ?? " + chain + ")"]);
    }
    return { source: applyEdits(source, edits), count: edits.length };
  }

  // Whether `source` declares `name` past the first name of a declaration's
  // list, as in `var a = 1, name = 2`.
  function declaredInList(source, name) {
    if (source.indexOf(name) < 0) {
      return false;
    }
    var code = tokens(source, true, true).filter(function (t) {
      return t[0] !== "comment";
    });
    for (var i = 1; i < code.length; i++) {
      if (code[i][0] !== "identifier" || code[i][1] !== name || code[i - 1][1] !== ",") {
        continue;
      }
      var depth = 0;
      for (var k = i - 1; k >= 0; k--) {
        var text = code[k][1];
        if (code[k][0] === "identifier" && depth === 0 &&
            (text === "var" || text === "let" || text === "const")) {
          return true;
        }
        if (code[k][0] !== "punctuation") {
          continue;
        }
        if (text === ")" || text === "]" || text === "}") {
          depth++;
        } else if (text === "(" || text === "[" || text === "{") {
          if (depth === 0) {
            break;
          }
          depth--;
        } else if (text === ";" && depth === 0) {
          break;
        }
      }
    }
    return false;
  }

  // A service worker has no `window` or `document`, and extensions tell the
  // worker from their pages by that (`typeof window === "undefined"`, which
  // a worker may take to mean it is the one to make requests). In the
  // global page that stands in for a worker, the runtime's
  // `__wexWorkerScope` is there, and the test answers as the worker's: by
  // what the worker gave itself, where its assignments go (a worker that
  // sets `self.window = self` first then finds a
  // window), and otherwise "undefined"; anywhere else it answers as written.
  // `typeof window.x` is left alone.
  var WORKER_TYPEOF = /\btypeof\s+(?:window|document)\b(?!\s*(?:\.|\[|\?\.))/;

  // For each bracket's index in `code`, the index of its partner.
  function bracketPartners(code) {
    var partner = {};
    var open = [];
    for (var k = 0; k < code.length; k++) {
      if (code[k][0] !== "punctuation") {
        continue;
      }
      var text = code[k][1];
      if (text === "(" || text === "[" || text === "{") {
        open.push(k);
      } else if ((text === ")" || text === "]" || text === "}") && open.length) {
        var o = open.pop();
        partner[o] = k;
        partner[k] = o;
      }
    }
    return partner;
  }

  // The index of the bracket that opens the group holding token `k`, or -1.
  function enclosingOpen(code, partner, k) {
    for (var j = k - 1; j >= 0; j--) {
      var text = code[j][0] === "punctuation" ? code[j][1] : "";
      if ((text === ")" || text === "]" || text === "}") && partner[j] !== undefined) {
        j = partner[j];
      } else if (text === "(" || text === "[" || text === "{") {
        return j;
      }
    }
    return -1;
  }

  // Whether tokens `k` and `k + 1` are an arrow.
  function isArrow(code, k) {
    return !!code[k + 1] && code[k][1] === "=" && code[k + 1][1] === ">" &&
      code[k][3] === code[k + 1][2];
  }

  var NOT_FUNCTION_HEADS = ["if", "for", "while", "switch", "with", "catch", "return", "typeof",
    "await", "yield", "new", "in", "of", "instanceof", "delete", "void"];

  // Whether the `{` at `open` begins a function's body.
  function isFunctionBody(code, partner, open) {
    if (open > 1 && isArrow(code, open - 2)) {
      return true;
    }
    var close = open - 1;
    if (close < 0 || code[close][1] !== ")" || partner[close] === undefined) {
      return false;
    }
    var before = code[partner[close] - 1];
    if (!before) {
      return false;
    }
    if (before[1] === "function" || before[1] === "*") {
      return true;
    }
    return before[0] === "identifier" && NOT_FUNCTION_HEADS.indexOf(before[1]) < 0;
  }

  // The character range of the scope a body that starts at token `k` covers:
  // the block it opens, or an arrow's expression, to the end of its group.
  function bodyRange(code, partner, k) {
    if (code[k] && code[k][1] === "{" && partner[k] !== undefined) {
      return [code[k][2], code[partner[k]][3]];
    }
    var open = enclosingOpen(code, partner, k);
    var end = open >= 0 && partner[open] !== undefined ? code[partner[open]][2] : Infinity;
    return code[k] ? [code[k][2], end] : null;
  }

  // The keyword of the declaration whose list has a `,` at `k`, or "".
  function declarationKeyword(code, partner, k) {
    for (var j = k - 1; j >= 0; j--) {
      var text = code[j][1];
      if (code[j][0] === "punctuation") {
        if ((text === ")" || text === "]" || text === "}") && partner[j] !== undefined) {
          j = partner[j];
        } else if (text === ";" || text === "(" || text === "[" || text === "{") {
          return "";
        }
      } else if (code[j][0] === "identifier" && (text === "var" || text === "let" || text === "const")) {
        return text;
      }
    }
    return "";
  }

  // The character ranges where `name` is the script's own binding: a
  // function's parameter, a variable, function or class it declares, or a
  // caught error. A declaration outside any block covers the whole script.
  function boundRanges(code, partner, name) {
    var ranges = [];
    for (var k = 0; k < code.length; k++) {
      if (code[k][0] !== "identifier" || code[k][1] !== name) {
        continue;
      }
      var prev = code[k - 1] ? code[k - 1][1] : "";
      var next = code[k + 1] ? code[k + 1][1] : "";
      if (prev === ".") {
        continue;
      }
      // A single parameter of an arrow.
      if (isArrow(code, k + 1)) {
        ranges.push(bodyRange(code, partner, k + 3));
        continue;
      }
      // A parameter in a list, or a caught error.
      var open = enclosingOpen(code, partner, k);
      if ((prev === "(" || prev === ",") && (next === "," || next === ")" || next === "=") &&
          open >= 0 && code[open][1] === "(" && partner[open] !== undefined) {
        var close = partner[open];
        var head = code[open - 1] ? code[open - 1][1] : "";
        if (head === "catch" || (code[close + 1] && code[close + 1][1] === "{" &&
            isFunctionBody(code, partner, close + 1))) {
          ranges.push(bodyRange(code, partner, close + 1));
          continue;
        }
        if (isArrow(code, close + 1)) {
          ranges.push(bodyRange(code, partner, close + 3));
          continue;
        }
      }
      var keyword = prev === "," ? declarationKeyword(code, partner, k - 1) : prev;
      if (["var", "let", "const", "function", "class"].indexOf(keyword) < 0) {
        continue;
      }
      // A variable's scope is its function, the others' their block.
      var scope = open;
      while (keyword === "var" && scope >= 0 && !(code[scope][1] === "{" &&
             isFunctionBody(code, partner, scope))) {
        scope = enclosingOpen(code, partner, scope);
      }
      if (scope >= 0 && code[scope][1] === "{" && partner[scope] !== undefined) {
        ranges.push([code[scope][2], code[partner[scope]][3]]);
      } else if (scope < 0) {
        ranges.push([0, Infinity]);
      }
    }
    return ranges.filter(Boolean);
  }

  function rewriteWorkerTypeofs(source) {
    if (!WORKER_TYPEOF.test(source)) {
      return { source: source, count: 0 };
    }
    var code = tokens(source, true, true).filter(function (t) {
      return t[0] !== "comment";
    });
    var partner = bracketPartners(code);
    var bound = {};
    var edits = [];
    for (var i = 0; i + 1 < code.length; i++) {
      var name = code[i + 1];
      if (code[i][1] !== "typeof" || name[0] !== "identifier" ||
          (name[1] !== "window" && name[1] !== "document")) {
        continue;
      }
      var next = code[i + 2] ? code[i + 2][1] : "";
      if (next === "." || next === "[" || (next === "?" && code[i + 3] && code[i + 3][1] === "." &&
          code[i + 2][3] === code[i + 3][2])) {
        continue;
      }
      // A name the script binds itself is its own.
      bound[name[1]] = bound[name[1]] || boundRanges(code, partner, name[1]);
      if (bound[name[1]].some(function (range) { return name[2] >= range[0] && name[2] < range[1]; })) {
        continue;
      }
      edits.push([code[i][2], name[3], "(typeof __wexWorkerScope === \"object\" && __wexWorkerScope ? " +
        "typeof __wexWorkerScope." + name[1] + " : typeof " + name[1] + ")"]);
    }
    return { source: applyEdits(source, edits), count: edits.length };
  }

  // A regular expression's body, matching Safari's protocol where it matches
  // the build's own: the protocol written out ("moz-extension", or with its
  // hyphen escaped) is Safari's, and a group with the protocol's first part
  // as one alternative, followed by the hyphen (`(?:moz|chrome)-.*:`), has
  // Safari's as another.
  function protocolRegexBody(body, home) {
    var hyphen = home.indexOf("-");
    var prefix = home.slice(0, hyphen);
    var written = new RegExp(prefix + "\\\\?-" + home.slice(hyphen + 1), "g");
    return body.replace(written, function (match) {
      return "safari" + match.slice(prefix.length);
    }).replace(/\((\?:)?([\w|]+)\)(?=\\?-)/g, function (group, nonCapturing, alternatives) {
      var names = alternatives.split("|");
      if (names.indexOf(prefix) < 0 || names.indexOf("safari") >= 0) {
        return group;
      }
      return "(" + (nonCapturing || "") + alternatives + "|safari)";
    });
  }

  // Whether the token at `i` of `code` is the value of an object literal's
  // property: `{` or `,`, then a name, a string or a number, then `:`. A
  // conditional's `? x :` has `?` where the `{` or `,` would be.
  function propertyValue(code, i) {
    if (i < 3 || code[i - 1][1] !== ":") {
      return false;
    }
    var key = code[i - 2];
    var named = key[0] === "identifier" || key[0] === "string" || /^[0-9]/.test(key[1]);
    return named && (code[i - 3][1] === "{" || code[i - 3][1] === ",");
  }

  // Names Safari's protocol where the extension names its own browser's. A
  // string that is `home` + "://" or the start of it, from the hyphen on (as
  // in `location.protocol === "chrome-extension:"`, a test for one of the
  // extension's own addresses, or `document.URL.startsWith("moz-")`),
  // names the same part of Safari's instead, and a regular expression matches
  // Safari's as it does the build's own. Only the protocol of the browser the
  // build was made for is changed, so code that tells browsers apart by
  // protocol still finds that browser. A string that an address is built
  // from with `+` is left alone, and so is the protocol's bare name as the
  // value of an object literal's property (`{ client_type: "chrome-extension" }`),
  // a label the extension sends or keeps rather than a test of an address.
  function rewriteExtensionProtocols(source, home) {
    var full = home + "://";
    var hyphen = home.indexOf("-");
    var code = tokens(source, true, true).filter(function (t) {
      return t[0] !== "comment";
    });
    var edits = [];
    for (var i = 0; i < code.length; i++) {
      var token = code[i];
      if (token[0] === "regex") {
        var end = token[1].lastIndexOf("/");
        var body = protocolRegexBody(token[1].slice(1, end), home);
        if (body !== token[1].slice(1, end)) {
          edits.push([token[2], token[3], "/" + body + token[1].slice(end)]);
        }
        continue;
      }
      var text = token[0] === "string" ? token[1].slice(1, -1) : null;
      if (text === null || text.length <= hyphen || full.indexOf(text) !== 0) {
        continue;
      }
      if (i + 1 < code.length && code[i + 1][1] === "+") {
        continue;
      }
      if (text === home && propertyValue(code, i)) {
        continue;
      }
      var quote = token[1].charAt(0);
      edits.push([token[2], token[3],
        quote + "safari" + text.slice(hyphen) + quote]);
    }
    return { source: applyEdits(source, edits), count: edits.length };
  }

  // The reference, in the form it was written, to the new name of the
  // renamed file it names, or null. `here` is the bundle directory a relative
  // reference starts from; a bare path may also name a file from the
  // bundle's root, as getURL takes one.
  function renamedReference(reference, here, renamed) {
    var cut = reference.length;
    ["?", "#"].forEach(function (mark) {
      var at = reference.indexOf(mark);
      if (at >= 0) {
        cut = Math.min(cut, at);
      }
    });
    var path = reference.slice(0, cut);
    var rest = reference.slice(cut);
    if (!path || path.indexOf("\\") >= 0 || /^[A-Za-z][A-Za-z0-9+.\-]*:/.test(path)) {
      return null;
    }
    var candidates;
    if (path.charAt(0) === "/") {
      candidates = [["root", path.replace(/^\/+/, "")]];
    } else if (path.indexOf("./") === 0 || path.indexOf("../") === 0) {
      candidates = [["here", W2S.tree.join(here, path)]];
    } else {
      candidates = [["here", W2S.tree.join(here, path)], ["bundle", path]];
    }
    for (var i = 0; i < candidates.length; i++) {
      var resolved = W2S.tree.normalize(candidates[i][1]);
      if (resolved === null || !Object.prototype.hasOwnProperty.call(renamed, resolved)) {
        continue;
      }
      var target = renamed[resolved];
      if (candidates[i][0] === "root") {
        return "/" + target + rest;
      }
      if (candidates[i][0] === "bundle") {
        return target + rest;
      }
      var relative = W2S.tree.relpath(target, here || ".");
      if (path.indexOf("./") === 0 && relative.charAt(0) !== ".") {
        relative = "./" + relative;
      }
      return relative + rest;
    }
    return null;
  }

  // Points the strings that name a renamed file at its new name.
  function rewriteRenamedReferences(source, here, renamed) {
    var edits = [];
    tokens(source, true, true).forEach(function (token) {
      if (token[0] !== "string") {
        return;
      }
      var replacement = renamedReference(token[1].slice(1, -1), here, renamed);
      if (replacement !== null) {
        var quote = token[1].charAt(0);
        edits.push([token[2], token[3], quote + replacement + quote]);
      }
    });
    return { source: applyEdits(source, edits), count: edits.length };
  }

  // Rewrites the module specifiers in `source` that name a renamed file: the
  // string after `from` (an import or a re-export), after `import` (an
  // import for its effects), and in `import(...)`. A specifier is only ever
  // an address, unlike other strings, which a script may build keys from.
  function rewriteModuleSpecifiers(source, here, renamed) {
    var edits = [];
    var list = tokens(source, true, true);
    list.forEach(function (token, i) {
      if (token[0] !== "string") {
        return;
      }
      var before = list[i - 1] || [];
      var further = list[i - 2] || [];
      var specifier = (before[0] === "identifier" && (before[1] === "from" || before[1] === "import")) ||
        (before[0] === "punctuation" && before[1] === "(" && further[0] === "identifier" && further[1] === "import");
      if (!specifier) {
        return;
      }
      var replacement = renamedReference(token[1].slice(1, -1), here, renamed);
      if (replacement !== null) {
        var quote = token[1].charAt(0);
        edits.push([token[2], token[3], quote + replacement + quote]);
      }
    });
    return { source: applyEdits(source, edits), count: edits.length };
  }

  function adaptModuleSpecifiers(tree, renamed, skipDirs) {
    return adapt(tree, skipDirs, "", function (source, dir) {
      return rewriteModuleSpecifiers(source, dir, renamed);
    });
  }

  // Applies `rewrite` to every .js and .mjs file outside `skipDirs` whose text
  // contains `needle`. Returns the number of edits.
  function adapt(tree, skipDirs, needle, rewrite) {
    var skip = Object.create(null);
    (skipDirs || []).forEach(function (name) { skip[name] = true; });
    var count = 0;
    tree.walk("", skip).forEach(function (entry) {
      entry.files.forEach(function (name) {
        if (!/\.(js|mjs)$/.test(name)) {
          return;
        }
        var path = W2S.tree.join(entry.dir, name);
        var decoded = bytes.decodeKeepingEncoding(tree.read(path));
        if (decoded.text.indexOf(needle) < 0) {
          return;
        }
        var result = rewrite(decoded.text, entry.dir);
        if (result.count) {
          tree.write(path, decoded.encode(result.source));
          count += result.count;
        }
      });
    });
    return count;
  }

  function adaptChromeOrigins(tree, skipDirs) {
    return adapt(tree, skipDirs, "-extension://", rewriteChromeOrigins);
  }

  function adaptModuleOriginPaths(tree, skipDirs) {
    return adapt(tree, skipDirs, "import", rewriteModuleOriginPaths);
  }

  // Only a source that names the protocol's first part before a hyphen, or
  // as an alternative of a group, has anything the rewrite changes.
  function adaptExtensionProtocols(tree, home, skipDirs) {
    var prefix = home.slice(0, home.indexOf("-"));
    var named = new RegExp(prefix + "(?:\\\\?-|[|)])");
    return adapt(tree, skipDirs, prefix, function (source) {
      return named.test(source) ? rewriteExtensionProtocols(source, home) : { source: source, count: 0 };
    });
  }

  function adaptRenamedReferences(tree, renamed, needle, skipDirs) {
    return adapt(tree, skipDirs, needle, function (source, dir) {
      return rewriteRenamedReferences(source, dir, renamed);
    });
  }

  function adaptLocationPaths(tree, skipDirs) {
    return adapt(tree, skipDirs, "location.", rewriteLocationPaths);
  }

  function adaptWorkerGlobals(tree, skipDirs) {
    return adapt(tree, skipDirs, "=", rewriteWorkerGlobals);
  }

  function adaptWorkerTypeofs(tree, skipDirs) {
    return adapt(tree, skipDirs, "typeof", rewriteWorkerTypeofs);
  }

  W2S.javascript = {
    tokens: tokens,
    declaredInList: declaredInList,
    rewriteModuleOriginPaths: rewriteModuleOriginPaths,
    rewriteChromeOrigins: rewriteChromeOrigins,
    adaptChromeOrigins: adaptChromeOrigins,
    adaptModuleOriginPaths: adaptModuleOriginPaths,
    rewriteLocationPaths: rewriteLocationPaths,
    renamedReference: renamedReference,
    adapt: adapt,
    rewriteRenamedReferences: rewriteRenamedReferences,
    adaptRenamedReferences: adaptRenamedReferences,
    rewriteModuleSpecifiers: rewriteModuleSpecifiers,
    adaptModuleSpecifiers: adaptModuleSpecifiers,
    rewriteExtensionProtocols: rewriteExtensionProtocols,
    adaptExtensionProtocols: adaptExtensionProtocols,
    adaptLocationPaths: adaptLocationPaths,
    rewriteWorkerGlobals: rewriteWorkerGlobals,
    adaptWorkerGlobals: adaptWorkerGlobals,
    rewriteWorkerTypeofs: rewriteWorkerTypeofs,
    adaptWorkerTypeofs: adaptWorkerTypeofs
  };
})(typeof globalThis.W2S === "object" ? globalThis.W2S : (globalThis.W2S = {}));
