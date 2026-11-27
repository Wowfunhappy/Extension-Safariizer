// Reading an Info.plist from Node by asking macOS to convert it to JSON.
// Using the system parser also catches a plist Safari itself would reject.

"use strict";

const { execFileSync } = require("child_process");

function read(filePath) {
  const json = execFileSync("plutil", ["-convert", "json", "-o", "-", filePath],
                            { encoding: "utf8" });
  return JSON.parse(json);
}

module.exports = { read };
