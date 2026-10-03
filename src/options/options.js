/* Expression Search Reloaded - options page. */

/* global ExpressionSearchDefaults */

"use strict";

const { DEFAULT_OPTIONS, SCHEMA, sanitizeOptions } = ExpressionSearchDefaults;
const form = document.getElementById("options");
const statusLine = document.getElementById("status");
const headersInput = document.getElementById("customDBHeaders");
let statusTimer = 0;

function localize() {
  for (const el of document.querySelectorAll("[data-i18n]")) {
    const message = messenger.i18n.getMessage(el.dataset.i18n);
    if (message) {
      el.textContent = message;
    }
  }
  document.documentElement.lang = messenger.i18n.getUILanguage();
}

function showStatus(message, isError = false) {
  statusLine.textContent = message;
  statusLine.classList.toggle("error", isError);
  clearTimeout(statusTimer);
  if (!isError) {
    statusTimer = setTimeout(() => (statusLine.textContent = ""), 2000);
  }
}

/** Fill the saved search location list with all real folders. */
async function populateFolders() {
  const select = form.elements.virtualFolderParent;
  let accounts = [];
  try {
    accounts = await messenger.accounts.list(true);
  } catch (e) {
    console.error(e);
  }
  const add = (folder, depth) => {
    if (folder.isVirtual || folder.isTag || folder.isUnified) {
      return;
    }
    const option = document.createElement("option");
    option.value = folder.id;
    option.textContent = `${" ".repeat(depth)}${folder.name}`;
    select.append(option);
    for (const sub of folder.subFolders || []) {
      add(sub, depth + 1);
    }
  };
  for (const account of accounts) {
    if (account.rootFolder) {
      add({ ...account.rootFolder, name: account.name }, 0);
    }
  }
}

function render(options) {
  for (const [key, [, type]] of Object.entries(SCHEMA)) {
    const el = form.elements[key];
    if (!el) {
      continue;
    }
    if (type == "boolean") {
      el.checked = options[key];
    } else {
      el.value = options[key];
    }
  }
  // A configured folder that no longer exists: show the default.
  const select = form.elements.virtualFolderParent;
  if (select.value != options.virtualFolderParent) {
    select.value = "";
  }
  form.elements.helpShowSeconds.disabled = !options.showHelp;
  form.elements.helpHideSeconds.disabled = !options.showHelp;
}

function readForm() {
  const raw = {};
  for (const [key, [, type]] of Object.entries(SCHEMA)) {
    const el = form.elements[key];
    if (!el) {
      continue;
    }
    if (type == "boolean") {
      raw[key] = el.checked;
    } else if (type == "integer") {
      raw[key] = el.valueAsNumber;
    } else {
      raw[key] = el.value;
    }
  }
  return sanitizeOptions(raw);
}

function validRegex(pattern) {
  if (!pattern) {
    return true;
  }
  try {
    new RegExp(pattern, "gi");
    return true;
  } catch (e) {
    return false;
  }
}

async function save() {
  const options = readForm();
  const match = form.elements.c2sRegexpMatch;
  if (!validRegex(options.c2sRegexpMatch)) {
    match.setCustomValidity(messenger.i18n.getMessage("invalidRegex"));
    match.reportValidity();
    showStatus(messenger.i18n.getMessage("invalidRegex"), true);
    return;
  }
  match.setCustomValidity("");
  await messenger.storage.local.set({ options });
  render(options);
  showStatus(messenger.i18n.getMessage("saved"));
}

async function saveHeaders() {
  const value = headersInput.value.trim().replace(/[\s,;]+/g, " ");
  if (!/^[A-Za-z0-9-]*( [A-Za-z0-9-]+)*$/.test(value)) {
    headersInput.setCustomValidity(messenger.i18n.getMessage("invalidHeaders"));
    headersInput.reportValidity();
    showStatus(messenger.i18n.getMessage("invalidHeaders"), true);
    return;
  }
  headersInput.setCustomValidity("");
  await messenger.ExpressionSearch.setCustomDBHeaders(value);
  headersInput.value = await messenger.ExpressionSearch.getCustomDBHeaders();
  showStatus(messenger.i18n.getMessage("saved"));
}

async function init() {
  localize();
  await populateFolders();
  const { options } = await messenger.storage.local.get("options");
  render(sanitizeOptions(options));
  try {
    headersInput.value = await messenger.ExpressionSearch.getCustomDBHeaders();
  } catch (e) {
    headersInput.disabled = true;
  }

  form.addEventListener("change", event => {
    if (event.target == headersInput) {
      saveHeaders();
    } else {
      save();
    }
  });
  form.addEventListener("submit", event => event.preventDefault());
  document.getElementById("reset").addEventListener("click", async () => {
    await messenger.storage.local.set({ options: { ...DEFAULT_OPTIONS } });
    render(sanitizeOptions(DEFAULT_OPTIONS));
    showStatus(messenger.i18n.getMessage("saved"));
  });
  document.getElementById("openHelp").addEventListener("click", () => {
    messenger.tabs.create({ url: "/help/help.html" });
  });
}

init();
