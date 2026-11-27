// Injection point for the extension's document_end and document_idle content
// scripts. The host has no separate idle phase, so both run here.
if (typeof WEXContent !== "undefined" && WEXContent) {
  WEXContent.run("document_end");
}
