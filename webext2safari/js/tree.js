// An in-memory directory tree, holding an extension's files while it is
// converted.
//
// Lookups ignore case and Unicode normalization, as the Mac file system does:
// an extension whose manifest names "Icons/16.png" for a file stored as
// "icons/16.png" works in Safari, and works here. Paths are relative and use
// "/"; "." and ".." components are resolved, and a path that climbs out of
// the tree names nothing.

(function (W2S) {
  "use strict";

  function fold(path) {
    return path.normalize("NFC").toLowerCase();
  }

  // The components of a relative path, or null for one that leaves the tree.
  function components(path) {
    var out = [];
    var parts = String(path).split("/");
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (part === "" || part === ".") {
        continue;
      }
      if (part === "..") {
        if (!out.length) {
          return null;
        }
        out.pop();
        continue;
      }
      out.push(part.normalize("NFC"));
    }
    return out;
  }

  function normalize(path) {
    var parts = components(path);
    return parts ? parts.join("/") : null;
  }

  function dirname(path) {
    var index = path.lastIndexOf("/");
    return index < 0 ? "" : path.slice(0, index);
  }

  function basename(path) {
    return path.slice(path.lastIndexOf("/") + 1);
  }

  function join() {
    return Array.prototype.filter.call(arguments, function (part) { return part; }).join("/");
  }

  function compare(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function Tree() {
    this.files = new Map();
    this.dirs = new Map();
  }

  // The stored spelling of `parts`, reusing the spelling of every directory
  // that already exists.
  Tree.prototype._spell = function (parts) {
    var spelled = [];
    for (var i = 0; i < parts.length; i++) {
      var existing = this.dirs.get(fold(parts.slice(0, i + 1).join("/")));
      spelled.push(existing ? basename(existing) : parts[i]);
    }
    return spelled.join("/");
  };

  Tree.prototype.write = function (path, data) {
    var parts = components(path);
    if (!parts || !parts.length) {
      throw new Error("not a file path: " + path);
    }
    var key = fold(parts.join("/"));
    var existing = this.files.get(key);
    if (existing) {
      existing.data = data;
      return existing.path;
    }
    var directory = this._spell(parts.slice(0, -1));
    var dirParts = directory ? directory.split("/") : [];
    for (var i = 0; i < dirParts.length; i++) {
      var prefix = dirParts.slice(0, i + 1).join("/");
      if (!this.dirs.has(fold(prefix))) {
        this.dirs.set(fold(prefix), prefix);
      }
    }
    var stored = join(directory, parts[parts.length - 1]);
    this.files.set(key, { path: stored, data: data });
    return stored;
  };

  Tree.prototype._entry = function (path) {
    var normalized = normalize(path);
    return normalized === null ? null : this.files.get(fold(normalized)) || null;
  };

  Tree.prototype.read = function (path) {
    var entry = this._entry(path);
    return entry ? entry.data : null;
  };

  Tree.prototype.isFile = function (path) {
    return !!this._entry(path);
  };

  Tree.prototype.isDir = function (path) {
    var normalized = normalize(path);
    if (normalized === null) {
      return false;
    }
    return normalized === "" || this.dirs.has(fold(normalized));
  };

  // The path a file is stored under, in its stored spelling.
  Tree.prototype.storedPath = function (path) {
    var entry = this._entry(path);
    return entry ? entry.path : null;
  };

  Tree.prototype.remove = function (path) {
    var normalized = normalize(path);
    if (normalized !== null) {
      this.files.delete(fold(normalized));
    }
  };

  Tree.prototype.rename = function (from, to) {
    var data = this.read(from);
    this.remove(from);
    return this.write(to, data);
  };

  // Moves every file under directory `from` under `to`, and forgets `from`.
  // Returns [old, new] for each file moved.
  Tree.prototype.renameDir = function (from, to) {
    var base = normalize(from);
    var target = normalize(to);
    if (!base || !target) {
      return [];
    }
    var prefix = fold(base) + "/";
    var self = this;
    var moved = [];
    this.paths().forEach(function (path) {
      if (fold(path).indexOf(prefix) === 0) {
        moved.push([path, self.rename(path, join(target, path.slice(base.length + 1)))]);
      }
    });
    Array.from(this.dirs.keys()).forEach(function (key) {
      if (key === fold(base) || key.indexOf(prefix) === 0) {
        self.dirs.delete(key);
      }
    });
    return moved;
  };

  // Every file's stored path, sorted.
  Tree.prototype.paths = function () {
    var out = [];
    this.files.forEach(function (entry) { out.push(entry.path); });
    return out.sort(compare);
  };

  // The immediate subdirectories and files of `directory`, each sorted.
  Tree.prototype.list = function (directory) {
    var base = normalize(directory || "");
    var prefix = base ? fold(base) + "/" : "";
    var dirs = [];
    var files = [];
    this.dirs.forEach(function (spelled, key) {
      if (key.indexOf(prefix) === 0 && key.length > prefix.length &&
          key.indexOf("/", prefix.length) < 0) {
        dirs.push(basename(spelled));
      }
    });
    this.files.forEach(function (entry, key) {
      if (key.indexOf(prefix) === 0 && key.indexOf("/", prefix.length) < 0) {
        files.push(basename(entry.path));
      }
    });
    return { dirs: dirs.sort(compare), files: files.sort(compare) };
  };

  // Every directory under `directory`, itself first, as os.walk lists them
  // top-down; `skip` names directories not to descend into at any depth.
  Tree.prototype.walk = function (directory, skip) {
    var out = [];
    var self = this;
    var skipped = skip || {};
    function isSkipped(name) {
      return Object.prototype.hasOwnProperty.call(skipped, name);
    }
    function visit(path) {
      var listing = self.list(path);
      var dirs = listing.dirs.filter(function (name) { return !isSkipped(name); });
      out.push({ dir: path, dirs: dirs, files: listing.files });
      dirs.forEach(function (name) { visit(join(path, name)); });
    }
    visit(normalize(directory || "") || "");
    return out;
  };

  // A tree holding the part of this one under `directory`.
  Tree.prototype.subtree = function (directory) {
    var base = normalize(directory || "");
    var out = new Tree();
    var prefix = base ? fold(base) + "/" : "";
    var cut = base ? base.length + 1 : 0;
    this.files.forEach(function (entry, key) {
      if (key.indexOf(prefix) === 0) {
        out.write(entry.path.slice(cut), entry.data);
      }
    });
    return out;
  };

  // The path from directory `from` to `to`, as Python's posixpath.relpath
  // gives it.
  function relpath(to, from) {
    function parts(path) {
      var out = [];
      path.split("/").forEach(function (part) {
        if (part === "" || part === ".") {
          return;
        }
        if (part === ".." && out.length && out[out.length - 1] !== "..") {
          out.pop();
        } else {
          out.push(part);
        }
      });
      return out;
    }
    var target = parts(to);
    var base = parts(from);
    var common = 0;
    while (common < target.length && common < base.length && target[common] === base[common]) {
      common++;
    }
    var out = [];
    for (var i = common; i < base.length; i++) {
      out.push("..");
    }
    out = out.concat(target.slice(common));
    return out.length ? out.join("/") : ".";
  }

  W2S.tree = {
    Tree: Tree,
    relpath: relpath,
    normalize: normalize,
    dirname: dirname,
    basename: basename,
    join: join,
    compare: compare,
    fold: fold
  };
})(typeof globalThis.W2S === "object" ? globalThis.W2S : (globalThis.W2S = {}));
