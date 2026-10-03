/* Expression Search Reloaded - background (MV3 event page).
 *
 * Owns the settings (storage.local) and pushes them to the experiment,
 * provides the message list context menu and opens the help page.
 */

/* global ExpressionSearchDefaults */

"use strict";

const { sanitizeOptions } = ExpressionSearchDefaults;
const HELP_URL = "/help/help.html";
const MENU_PARENT = "es-search-for";
const MENU_FIELDS = ["from", "recipients", "subject", "tags", "date"];

async function getOptions() {
  const { options } = await messenger.storage.local.get("options");
  return sanitizeOptions(options);
}

async function applyOptions() {
  try {
    await messenger.ExpressionSearch.setOptions(await getOptions());
  } catch (e) {
    console.error("Expression Search: could not apply options", e);
  }
}

async function createMenus() {
  await messenger.menus.removeAll();
  messenger.menus.create({
    id: MENU_PARENT,
    title: messenger.i18n.getMessage("menuSearchFor"),
    contexts: ["message_list"],
  });
  for (const field of MENU_FIELDS) {
    messenger.menus.create({
      id: `${MENU_PARENT}-${field}`,
      parentId: MENU_PARENT,
      title: messenger.i18n.getMessage(`menuSearchFor_${field}`),
      contexts: ["message_list"],
    });
  }
}

/** Take over the settings of Expression Search 2.x on first run. */
async function migrateLegacySettings() {
  const { options } = await messenger.storage.local.get("options");
  if (options) {
    return;
  }
  const legacy = await messenger.ExpressionSearch.getLegacyPrefs();
  if (legacy) {
    await messenger.storage.local.set({ options: sanitizeOptions(legacy) });
  }
}

// Listeners are registered synchronously at the top level so that the event
// page is woken up for them.

messenger.runtime.onInstalled.addListener(async ({ reason }) => {
  await createMenus();
  if (reason == "install" || reason == "update") {
    await migrateLegacySettings();
    await applyOptions();
  }
  if (reason == "install") {
    await messenger.tabs.create({ url: HELP_URL });
  }
});

messenger.runtime.onStartup.addListener(async () => {
  await createMenus();
  await applyOptions();
});

messenger.storage.onChanged.addListener((changes, area) => {
  if (area == "local" && "options" in changes) {
    applyOptions();
  }
});

messenger.menus.onClicked.addListener(async (info, tab) => {
  const prefix = `${MENU_PARENT}-`;
  if (typeof info.menuItemId != "string" || !info.menuItemId.startsWith(prefix)) {
    return;
  }
  const field = info.menuItemId.substring(prefix.length);
  const message = info.selectedMessages?.messages?.[0];
  if (!message || !MENU_FIELDS.includes(field)) {
    return;
  }
  try {
    await messenger.ExpressionSearch.searchFromMessage(tab.id, message.id, field);
  } catch (e) {
    console.error("Expression Search:", e);
  }
});

messenger.ExpressionSearch.onCommand.addListener(command => {
  switch (command) {
    case "openHelp":
      messenger.tabs.create({ url: HELP_URL });
      break;
    case "openOptions":
      messenger.runtime.openOptionsPage();
      break;
  }
});

applyOptions();
