#!/usr/bin/env node
/*
 * Fetch a page with a saved GDUFS VPN session in headless Chrome.
 *
 * The script is intentionally generic:
 *   - injects cookies produced by gdufs_auth.py;
 *   - optionally fills and submits a search form; and
 *   - returns the rendered title/text/HTML.
 *
 * Research-specific parsing belongs to the calling research skill.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/155.0.0.0 Safari/537.36";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key.startsWith("--")) continue;
    out[key.slice(2)] = value;
    i += 1;
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${file}`);
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (fs.existsSync(candidate)) return candidate;
  }
  return "";
}

function findChrome(explicit) {
  if (explicit) return explicit;
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;

  const command = process.platform === "win32" ? "where.exe" : "which";
  for (const name of [
    "chrome",
    "google-chrome",
    "chromium",
    "chromium-browser",
    "msedge",
    "microsoft-edge",
  ]) {
    const result = spawnSync(command, [name], { encoding: "utf8" });
    if (result.status === 0 && result.stdout.trim()) {
      return result.stdout.trim().split(/\r?\n/)[0];
    }
  }

  if (process.platform === "win32") {
    const roots = [
      process.env.ProgramFiles,
      process.env["ProgramFiles(x86)"],
      process.env.LOCALAPPDATA,
    ].filter(Boolean);
    return firstExisting(
      roots.flatMap((root) => [
        path.join(root, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
      ]),
    );
  }
  if (process.platform === "darwin") {
    return firstExisting([
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]);
  }
  return "";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cookiesPath = args.cookies;
  const url = args.url;
  const outPath = args.out;
  const waitMs = Number(args["wait-ms"] || 15000);
  const searchTerm = args["search-term"] || "";
  const searchInput = args["search-input"] || 'input[name="terms"]';
  const searchSubmit = args["search-submit"] || 'button[type="submit"]';
  const searchReady = args["search-ready"] || searchInput;
  const resultUrlContains = args["result-url-contains"] || "";
  const resultText = args["result-text"] || "";
  const resultSelector = args["result-selector"] || "";
  const chromePath = findChrome(args.chrome);

  if (!cookiesPath || !url || !outPath) {
    throw new Error(
      "Usage: --cookies FILE --url URL --out FILE [--wait-ms N] " +
        "[--search-term TERM --search-input SELECTOR --search-submit SELECTOR " +
        "--search-ready SELECTOR --result-url-contains TEXT --result-text REGEX]",
    );
  }
  if (!chromePath) {
    throw new Error(
      "Chrome/Chromium not found. Set CHROME_PATH or pass --chrome.",
    );
  }

  const cookies = JSON.parse(fs.readFileSync(cookiesPath, "utf8"));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "gdufs-headless-"));
  const portFile = path.join(profile, "DevToolsActivePort");
  const child = spawn(
    chromePath,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--window-size=1440,1000",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let ws;
  try {
    await waitForFile(portFile, 20000);
    const [port] = fs.readFileSync(portFile, "utf8").trim().split(/\r?\n/);
    const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
    const page = targets.find((item) => item.type === "page");
    if (!page) throw new Error("No page target found");

    ws = new WebSocket(page.webSocketDebuggerUrl);
    let nextId = 0;
    const pending = new Map();
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });

    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (!msg.id || !pending.has(msg.id)) return;
      const item = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) item.reject(new Error(JSON.stringify(msg.error)));
      else item.resolve(msg.result);
    });
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });

    await send("Page.enable");
    await send("Runtime.enable");
    await send("Network.enable");
    await send("Network.setUserAgentOverride", {
      userAgent: DEFAULT_UA,
      acceptLanguage: "zh-CN,zh;q=0.9",
      platform: "Win32",
    });
    await send("Page.addScriptToEvaluateOnNewDocument", {
      source: `Object.defineProperty(navigator, "webdriver", { get: () => false });
               window.chrome = window.chrome || { runtime: {} };`,
    });

    for (const cookie of cookies) {
      const host = String(cookie.domain || "").replace(/^\./, "");
      if (!host) continue;
      try {
        await send("Network.setCookie", {
          name: cookie.name,
          value: cookie.value,
          url: `https://${host}${cookie.path || "/"}`,
          domain: cookie.domain || undefined,
          path: cookie.path || "/",
          secure: Boolean(cookie.secure),
          httpOnly: Boolean(cookie.httpOnly),
          sameSite: cookie.sameSite || "Lax",
          expires:
            cookie.expires && cookie.expires > 0 ? cookie.expires : undefined,
        });
      } catch {
        // A cookie for another domain may be rejected; the VPN cookies are
        // the only required ones and are reported separately by the caller.
      }
    }

    const snapshotExpression = `JSON.stringify({
      href: location.href,
      title: document.title,
      text: (document.body ? document.body.innerText : "").slice(0, 20000),
      hasSearchForm: Boolean(document.querySelector(${JSON.stringify(
        searchReady,
      )})),
      hasResultSelector: ${
        resultSelector
          ? `Boolean(document.querySelector(${JSON.stringify(
              resultSelector,
            )}))`
          : "true"
      }
    })`;
    const evaluateSnapshot = async () => {
      const evaluated = await send("Runtime.evaluate", {
        expression: snapshotExpression,
        returnByValue: true,
        awaitPromise: true,
      });
      return JSON.parse(evaluated.result.value);
    };
    const pollSnapshot = async (attempts, predicate) => {
      let last = null;
      for (let i = 0; i < attempts; i += 1) {
        try {
          last = await evaluateSnapshot();
          if (predicate(last)) return last;
        } catch {
          // Navigation can temporarily destroy the execution context.
        }
        await sleep(1500);
      }
      return last;
    };

    await send("Page.navigate", { url });
    await sleep(waitMs);
    let snapshot = await pollSnapshot(
      searchTerm ? 40 : 30,
      searchTerm
        ? (item) => item.hasSearchForm === true
        : (item) =>
            ((item.title || "").length > 0 ||
              (item.text || "").length > 1500) &&
            // A direct page load (no search-form submission) can still wait
            // for result markers; each condition stays inert when the caller
            // omits the matching flag.
            (!resultUrlContains ||
              (item.href || "").includes(resultUrlContains)) &&
            (!resultSelector || item.hasResultSelector === true) &&
            (!resultText || new RegExp(resultText, "i").test(item.text || "")),
    );

    if (searchTerm) {
      let submitted = false;
      for (let i = 0; i < 12 && !submitted; i += 1) {
        try {
          const result = await send("Runtime.evaluate", {
            expression: `(() => {
              const input = document.querySelector(${JSON.stringify(
                searchInput,
              )});
              const form = input && input.form;
              if (!input || !form) return false;
              input.value = ${JSON.stringify(searchTerm)};
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
              const button = document.querySelector(${JSON.stringify(
                searchSubmit,
              )});
              if (button) button.click();
              else HTMLFormElement.prototype.submit.call(form);
              return true;
            })()`,
            returnByValue: true,
            awaitPromise: true,
          });
          submitted = result.result.value === true;
        } catch {
          // retry after a service-worker reload
        }
        if (!submitted) await sleep(1500);
      }
      if (!submitted) throw new Error("Search form not found");
      await sleep(waitMs);
      snapshot = await pollSnapshot(
        40,
        (item) =>
          (!resultUrlContains ||
            (item.href || "").includes(resultUrlContains)) &&
          (!resultSelector || item.hasResultSelector === true) &&
          (!resultText ||
            new RegExp(resultText, "i").test(item.text || "") ||
            (item.text || "").length > 4000),
      );
    }

    const htmlResult = await send("Runtime.evaluate", {
      expression: `document.documentElement ? document.documentElement.outerHTML : ""`,
      returnByValue: true,
      awaitPromise: true,
    });
    const html = htmlResult.result.value || "";
    fs.writeFileSync(outPath, html, "utf8");
    console.log(
      JSON.stringify(
        {
          href: snapshot?.href || "",
          title: snapshot?.title || "",
          text: snapshot?.text || "",
          html_bytes: Buffer.byteLength(html, "utf8"),
          html_path: outPath,
        },
        null,
        2,
      ),
    );
  } finally {
    try {
      if (ws && ws.readyState === WebSocket.OPEN) ws.close();
    } catch {
      // ignore
    }
    try {
      child.kill();
    } catch {
      // ignore
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
