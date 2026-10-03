/* Expression Search Reloaded - help page. */

"use strict";

document.getElementById("openOptions").addEventListener("click", () => {
  messenger.runtime.openOptionsPage();
});

const label = messenger.i18n.getMessage("helpOpenOptions");
if (label) {
  document.getElementById("openOptions").textContent = label;
}
document.title = messenger.i18n.getMessage("helpTitle") || document.title;
