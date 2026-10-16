#!/usr/bin/env node
/*
 * Download a file (for example a HeinOnline section PDF) through the GDUFS
 * library VPN in headless Chrome.
 *
 * LibVPN answers the first request of a fresh browser profile with a Service
 * Worker bootstrap page instead of the real resource, so plain HTTP clients
 * (curl, requests) never reach the proxied content.  This helper runs a real
 * Chrome, injects the cookies produced by gdufs_auth.py, waits until the
 * Service Worker controls the page, and then lets Chrome write the response
 * to disk.  An in-page fetch fallback covers hosts that answer inline
 * (Content-Disposition not set to attachment), where the navigation itself
 * never produces a download.
 *
 * Research-specific parsing belongs to the calling research skill.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/155.0.0.0 Safari/537.36";
const PDF_MAGIC = Buffer.from("%PDF-", "ascii");
const CHUNK_BYTES = 1024 * 1024;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const value = argv[i + 1];
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

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function looksLikeBootstrapPage(text) {
  return text.includes("Service Worker") && text.length < 1200;
}

/*
 * LibVPN answers the first request of a fresh profile with a Service Worker
 * bootstrap page that only installs for the directory of the requested path.
 * A warm-up under an unrelated directory therefore leaves the target
 * uncontrolled, so try the caller's page URL first and fall back to a page
 * derived from the target's own handle.
 */
function warmupCandidates(url, explicit) {
  const candidates = [];
  const add = (value) => {
    if (value && !candidates.includes(value)) candidates.push(value);
  };
  add(explicit);
  try {
    const parsed = new URL(url);
    const handle = parsed.searchParams.get("handle");
    const collection = parsed.searchParams.get("collection");
    if (handle) {
      const query = new URLSearchParams({ handle });
      if (collection) query.set("collection", collection);
      add(
        `https://libvpn.gdufs.edu.cn/-https://heinonline.org/HOL/Page?${query.toString()}`,
      );
    }
    add(`https://libvpn.gdufs.edu.cn/-https://heinonline.org/HOL/Welcome`);
    add(`${parsed.origin}/`);
  } catch {
    // A malformed URL is reported later by the navigation itself.
  }
  return candidates;
}

// Downloads land under a Chrome-chosen name; pick the newest finished file.
function newestDownload(downloadDir) {
  const entries = fs
    .readdirSync(downloadDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const file = path.join(downloadDir, entry.name);
      const stat = fs.statSync(file);
      return { file, size: stat.size, mtime: stat.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return entries.find((item) => !item.file.endsWith(".crdownload")) || null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cookiesPath = args.cookies;
  const url = args.url;
  const outPath = args.out;
  const waitMs = Number(args["wait-ms"] || 15000);
  const timeoutMs = Number(args["timeout-ms"] || 120000);
  const maxBytes = Number(args["max-bytes"] || 80 * 1024 * 1024);
  const selector = args.selector || "";
  const chromePath = findChrome(args.chrome);
  const warmup = args.warmup || "";

  if (!cookiesPath || !url || !outPath) {
    throw new Error(
      "Usage: --cookies FILE --url URL --out FILE [--warmup URL] " +
        "[--selector CSS] [--wait-ms N] [--timeout-ms N] [--max-bytes N]",
    );
  }
  if (!chromePath) {
    throw new Error(
      "Chrome/Chromium not found. Set CHROME_PATH or pass --chrome.",
    );
  }

  const cookies = JSON.parse(fs.readFileSync(cookiesPath, "utf8"));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "gdufs-download-"));
  const downloadDir = path.join(profile, "downloads");
  fs.mkdirSync(downloadDir, { recursive: true });
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

  const report = {
    url,
    requested_url: url,
    status: "failed",
    method: "",
    service_worker_controlled: false,
    bytes: 0,
    sha256: "",
    content_type: "",
    out_path: "",
    warnings: [],
  };

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
    for (const command of ["Browser.setDownloadBehavior", "Page.setDownloadBehavior"]) {
      try {
        await send(command, {
          behavior: "allow",
          downloadPath: downloadDir,
          eventsEnabled: true,
        });
        break;
      } catch {
        // Fall back to the page-scoped command on older CDP revisions.
      }
    }

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

    const evaluate = async (expression) => {
      const result = await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) {
        throw new Error(
          "Runtime error: " +
            JSON.stringify(result.exceptionDetails).slice(0, 400),
        );
      }
      return result.result ? result.result.value : undefined;
    };
    const pageState = () =>
      evaluate(`JSON.stringify({
        href: location.href,
        title: document.title,
        text: (document.body ? document.body.innerText : "").slice(0, 2000),
        controlled: Boolean(navigator.serviceWorker && navigator.serviceWorker.controller)
      })`);
    const waitForServiceWorker = async (budgetMs) => {
      const deadline = Date.now() + budgetMs;
      let state = null;
      while (Date.now() < deadline) {
        try {
          state = JSON.parse(await pageState());
          if (state.controlled) return state;
          if (looksLikeBootstrapPage(state.text || "")) {
            // The bootstrap page reloads itself once the worker activates;
            // nudge it in case the reload was suppressed in headless mode.
            await sleep(1500);
            await send("Page.navigate", { url: warmup || url });
          }
        } catch {
          // Navigation can temporarily destroy the execution context.
        }
        await sleep(1000);
      }
      return state;
    };

    let state = null;
    for (const candidate of warmupCandidates(url, warmup)) {
      await send("Page.navigate", { url: candidate });
      await sleep(waitMs);
      state = await waitForServiceWorker(Math.max(waitMs, 25000));
      if (state && state.controlled) {
        report.warmup_url = candidate;
        break;
      }
      report.warnings.push(
        `Service Worker did not control ${candidate}; trying the next warm-up URL.`,
      );
    }
    report.service_worker_controlled = Boolean(state && state.controlled);
    if (!report.service_worker_controlled) {
      report.warnings.push(
        "Service Worker never took control; the download may return the LibVPN bootstrap page.",
      );
    }

    const downloadViaNavigation = async () => {
      if (selector) {
        const clicked = await evaluate(`(() => {
          const node = document.querySelector(${JSON.stringify(selector)});
          if (!node) return false;
          node.click();
          return true;
        })()`);
        if (!clicked) throw new Error(`Download selector not found: ${selector}`);
      } else {
        await send("Page.navigate", { url });
      }
      const deadline = Date.now() + timeoutMs;
      let previous = -1;
      while (Date.now() < deadline) {
        await sleep(1000);
        const candidate = newestDownload(downloadDir);
        if (!candidate) {
          previous = -1;
          continue;
        }
        if (candidate.size > maxBytes) {
          throw new Error(
            `Download exceeds --max-bytes (${candidate.size} bytes).`,
          );
        }
        if (candidate.size > 0 && candidate.size === previous) {
          return candidate.file;
        }
        previous = candidate.size;
      }
      throw new Error("Timed out waiting for the browser download to finish.");
    };

    let file = "";
    try {
      file = await downloadViaNavigation();
      report.method = selector ? "click" : "navigation";
    } catch (navError) {
      report.warnings.push(`Navigation download failed: ${navError.message}`);
    }

    let buffer = null;
    if (file) buffer = fs.readFileSync(file);
    const isPdf = buffer ? buffer.subarray(0, 5).equals(PDF_MAGIC) : false;

    if (!isPdf) {
      // The server may answer inline, so the navigation never triggers a
      // download.  Re-request the resource from inside the controlled page.
      try {
        const meta = JSON.parse(
          await evaluate(`(async () => {
            const response = await fetch(${JSON.stringify(url)}, {
              credentials: "include",
              redirect: "follow",
            });
            const buffer = await response.arrayBuffer();
            window.__gdufsDownload = new Uint8Array(buffer);
            return JSON.stringify({
              ok: response.ok,
              status: response.status,
              type: response.headers.get("content-type") || "",
              length: window.__gdufsDownload.length,
            });
          })()`),
        );
        report.content_type = meta.type || report.content_type;
        if (!meta.ok) {
          throw new Error(`HTTP ${meta.status} from in-page fetch`);
        }
        if (meta.length > maxBytes) {
          throw new Error(`Download exceeds --max-bytes (${meta.length} bytes).`);
        }
        const chunks = [];
        for (let offset = 0; offset < meta.length; offset += CHUNK_BYTES) {
          const part = await evaluate(`(() => {
            const view = window.__gdufsDownload.subarray(${offset}, ${offset + CHUNK_BYTES});
            let binary = "";
            for (let i = 0; i < view.length; i += 1) {
              binary += String.fromCharCode(view[i]);
            }
            return btoa(binary);
          })()`);
          chunks.push(Buffer.from(part, "base64"));
        }
        const fetched = Buffer.concat(chunks);
        if (fetched.subarray(0, 5).equals(PDF_MAGIC)) {
          buffer = fetched;
          report.method = "in-page-fetch";
        } else {
          report.warnings.push(
            "In-page fetch returned no PDF payload; the response is most likely a login, paywall or error page.",
          );
        }
      } catch (fetchError) {
        report.warnings.push(`In-page fetch failed: ${fetchError.message}`);
      }
    }

    if (buffer && buffer.subarray(0, 5).equals(PDF_MAGIC)) {
      fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
      fs.writeFileSync(outPath, buffer);
      report.status = "ok";
      report.bytes = buffer.length;
      report.sha256 = sha256(buffer);
      report.out_path = path.resolve(outPath);
    } else if (buffer && buffer.length) {
      // Keep the unexpected payload for diagnosis instead of writing it to
      // the requested .pdf path.
      const debugPath = path.resolve(outPath) + ".html";
      fs.writeFileSync(debugPath, buffer);
      report.status = "unexpected-content";
      report.bytes = buffer.length;
      report.out_path = debugPath;
      report.warnings.push(
        `Downloaded payload is not a PDF; raw response kept at ${debugPath}`,
      );
    } else {
      report.status = "failed";
    }
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

  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "ok") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
