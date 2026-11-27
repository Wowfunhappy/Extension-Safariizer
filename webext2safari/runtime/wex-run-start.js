// Injection point for the extension's document_start content scripts.
// Listed last in the bundle's document-start script list, so the bridge above
// it is ready by the time the extension's own code runs.
if (typeof WEXContent !== "undefined" && WEXContent) {
  WEXContent.run("document_start");
}
