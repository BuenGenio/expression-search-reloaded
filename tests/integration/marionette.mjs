// Minimal Marionette client and headless Thunderbird launcher used by the
// integration tests. No dependencies beyond Node.js >= 20.
//
// The launcher always starts a *separate* Thunderbird instance with
// -no-remote, --headless and a throw-away profile, so it never touches the
// user's real profile or an already running Thunderbird.

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export class Marionette {
  #socket = null;
  #buffer = Buffer.alloc(0);
  #pending = new Map();
  #nextId = 1;
  #handshake = null;

  async connect(port, host = "127.0.0.1", timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await this.#tryConnect(port, host);
        return this.#handshake;
      } catch (e) {
        if (Date.now() > deadline) {
          throw new Error(`Could not connect to Marionette on ${port}: ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }

  #tryConnect(port, host) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ port, host });
      let settled = false;
      socket.once("error", err => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
      socket.on("data", chunk => this.#onData(chunk));
      socket.once("connect", () => {
        this.#socket = socket;
        this.#handshakeResolver = handshake => {
          settled = true;
          this.#handshake = handshake;
          resolve(handshake);
        };
      });
      socket.once("close", () => {
        for (const { reject: rej } of this.#pending.values()) {
          rej(new Error("Marionette connection closed"));
        }
        this.#pending.clear();
        if (!settled) {
          settled = true;
          reject(new Error("closed before handshake"));
        }
      });
    });
  }

  #handshakeResolver = null;

  #onData(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      const colon = this.#buffer.indexOf(":");
      if (colon == -1) {
        return;
      }
      const length = parseInt(this.#buffer.subarray(0, colon).toString(), 10);
      if (this.#buffer.length < colon + 1 + length) {
        return;
      }
      const body = this.#buffer.subarray(colon + 1, colon + 1 + length).toString("utf8");
      this.#buffer = this.#buffer.subarray(colon + 1 + length);
      const packet = JSON.parse(body);
      if (!Array.isArray(packet)) {
        this.#handshakeResolver?.(packet);
        this.#handshakeResolver = null;
        continue;
      }
      const [, id, error, result] = packet;
      const pending = this.#pending.get(id);
      if (!pending) {
        continue;
      }
      this.#pending.delete(id);
      if (error) {
        const err = new Error(`${pending.name}: ${error.error}: ${error.message}\n${error.stacktrace || ""}`);
        err.marionette = error;
        pending.reject(err);
      } else {
        pending.resolve(result);
      }
    }
  }

  send(name, params = {}) {
    const id = this.#nextId++;
    const body = Buffer.from(JSON.stringify([0, id, name, params]), "utf8");
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, name });
      this.#socket.write(`${body.length}:`);
      this.#socket.write(body);
    });
  }

  async startSession() {
    await this.send("WebDriver:NewSession", { capabilities: {} });
    await this.send("Marionette:SetContext", { value: "chrome" });
    await this.send("WebDriver:SetTimeouts", { script: 120000 });
  }

  /**
   * Run `script` (a function body) in the chrome context of the current
   * chrome window. The body may `return` a value or a Promise.
   */
  async exec(script, args = []) {
    const result = await this.send("WebDriver:ExecuteScript", {
      // Allow top-level await; `arguments` still refers to the script args.
      script: `return (async () => {\n${script}\n})();`,
      args,
      newSandbox: false,
      sandbox: "es-test",
    });
    return result?.value;
  }

  async installAddon(addonPath) {
    const result = await this.send("Addon:Install", {
      path: addonPath,
      temporary: true,
    });
    return result?.value;
  }

  async quit() {
    try {
      await this.send("Marionette:Quit", { flags: ["eForceQuit"] });
    } catch {
      // The connection drops while quitting.
    }
    this.#socket?.destroy();
  }
}

const TEST_PREFS = {
  "marionette.port": null, // filled in by launchThunderbird
  "mail.shell.checkDefaultClient": false,
  "mail.provider.suppress_dialog_on_startup": true,
  "mailnews.start_page.enabled": false,
  "datareporting.policy.dataSubmissionEnabled": false,
  "datareporting.policy.dataSubmissionPolicyBypassNotification": true,
  "toolkit.telemetry.reportingpolicy.firstRun": false,
  "app.update.disabledForTesting": true,
  "app.update.auto": false,
  "extensions.experiments.enabled": true,
  "extensions.autoDisableScopes": 0,
  "mailnews.database.global.indexer.enabled": false,
  "mail.biff.show_alert": false,
  "mail.biff.play_sound": false,
  "mail.inappnotifications.enabled": false,
  "browser.dom.window.dump.enabled": true,
  "devtools.console.stdout.chrome": true,
};

/** A currently unused local TCP port, so that parallel runs never collide. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export async function launchThunderbird({
  binary = process.env.THUNDERBIRD_BIN || "/snap/bin/thunderbird",
  profileDir,
  port,
  logFile,
  extraPrefs = {},
} = {}) {
  port ??= await freePort();
  fs.rmSync(profileDir, { recursive: true, force: true });
  fs.mkdirSync(profileDir, { recursive: true });
  const prefs = { ...TEST_PREFS, ...extraPrefs, "marionette.port": port };
  const userJs = Object.entries(prefs)
    .map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
    .join("\n");
  fs.writeFileSync(path.join(profileDir, "user.js"), userJs + "\n");

  const out = logFile ? fs.openSync(logFile, "w") : "ignore";
  const child = spawn(
    binary,
    [
      "--headless",
      "-no-remote",
      "-profile",
      profileDir,
      "--marionette",
      "--remote-allow-system-access",
    ],
    {
      env: { ...process.env, MOZ_HEADLESS: "1", MOZ_CRASHREPORTER_DISABLE: "1" },
      stdio: ["ignore", out, out],
      detached: false,
    }
  );
  const client = new Marionette();
  await client.connect(port);
  await client.startSession();
  return { child, client };
}
