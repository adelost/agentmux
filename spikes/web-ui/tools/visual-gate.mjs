#!/usr/bin/env node
/**
 * Visual browser gate for the web-ui (SRC-0027).
 *
 * Boots the real server against a seeded temp data dir, renders the snapshot
 * view (?snapshot=1) in headless Chrome at desktop + mobile viewports and
 * fails loudly on:
 *   - horizontal overflow (document wider than viewport)
 *   - missing key UI surfaces (topbar, sidebar, header controls, composer,
 *     conversation incl. user/assistant/notice/meta messages)
 *   - interactive elements without an accessible name
 *   - page errors / failed asset loads
 *
 * Screenshots land in artifacts/ (gitignored) as review evidence.
 * Requires a Chrome/Chromium binary (CHROME_BIN overrides autodetection).
 * Run: node spikes/web-ui/tools/visual-gate.mjs   (or npm run test:webui:visual)
 */
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeProjectDir } from "../../../core/claude-paths.mjs";
import { createWebUi } from "../server.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_DIR = join(ROOT, "..", "artifacts");
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800, mobile: false, deviceScaleFactor: 1 },
  { name: "mobile", width: 375, height: 740, mobile: true, deviceScaleFactor: 2 },
];

const findChrome = () => {
  const candidates = [
    process.env.CHROME_BIN,
    "google-chrome",
    "chromium",
    "chromium-browser",
    "/opt/google/chrome/chrome",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "pipe" });
      return candidate;
    } catch {}
  }
  throw new Error("no Chrome/Chromium binary found; set CHROME_BIN");
};

const seedWorkspace = () => {
  const root = mkdtempSync(join(tmpdir(), "amux-webui-gate-"));
  const dataDir = join(root, "data");
  const homeDir = join(root, "home");
  const workspace = join(root, "workspace");
  const secondWorkspace = join(root, "workspace-review");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(secondWorkspace, { recursive: true });

  const at = Date.now();
  const project = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "SW00P Game", cwd: workspace };
  const secondProject = { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", name: "Release review", cwd: secondWorkspace };
  const claudeAgent = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "UI-implementation", engine: "claude", model: "claude-opus-4-8" };
  const codexAgent = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "Review-wingman", engine: "codex", model: "gpt-5.6-sol" };

  writeFileSync(join(dataDir, "registry.json"), JSON.stringify({
    schemaVersion: 1,
    projects: [project, secondProject].map((entry) => ({
      ...entry,
      createdAt: at,
      updatedAt: at,
      communicationPolicy: { version: 1, read: "all_agents", send: { mode: "open", allow: {} }, enforced: false },
    })),
    agents: [
      {
        ...claudeAgent,
        projectId: project.id,
        effort: "high",
        sessionId: SESSION_ID,
        context: {
          usedTokens: 124_000,
          windowTokens: 200_000,
          percent: 62,
          lastInputTokens: 1_842,
          lastOutputTokens: 566,
          processedTokens: 412_000,
          updatedAt: at,
        },
        idleSince: at,
        pinnedAt: at,
        createdAt: at,
        updatedAt: at,
      },
      {
        ...codexAgent,
        projectId: secondProject.id,
        effort: "medium",
        sessionId: null,
        context: null,
        idleSince: at,
        pinnedAt: at + 1,
        createdAt: at + 1,
        updatedAt: at + 1,
      },
    ],
    receipts: {},
  }, null, 2));

  const nativeDir = claudeProjectDir(workspace, homeDir);
  mkdirSync(nativeDir, { recursive: true });
  const usage = { input_tokens: 12, cache_read_input_tokens: 123_400, cache_creation_input_tokens: 0, output_tokens: 566 };
  const deniedPrompt = "Run the protected release action.";
  const deniedAt = at + 2_000;
  const deniedPromptHash = createHash("sha256")
    .update(JSON.stringify({ agentId: claudeAgent.id, prompt: deniedPrompt }))
    .digest("hex");
  const registry = JSON.parse(readFileSync(join(dataDir, "registry.json"), "utf8"));
  registry.receipts = {
    messages: {
      "visual-permission-denied": {
        id: claudeAgent.id,
        hash: "visual-only",
        promptHashes: [deniedPromptHash],
        projectId: project.id,
        projectName: project.name,
        agentName: claudeAgent.name,
        promptPreview: deniedPrompt,
        promptPreviewTruncated: false,
        source: "discord",
        acceptedAt: deniedAt,
        completedAt: deniedAt + 100,
        sessionId: SESSION_ID,
        code: 1,
        interrupted: false,
        hasAssistant: false,
        permissionDenied: true,
        denialDetail: "Bash",
        error: "permission denied: Bash",
      },
    },
  };
  writeFileSync(join(dataDir, "registry.json"), JSON.stringify(registry, null, 2));
  writeFileSync(join(nativeDir, `${SESSION_ID}.jsonl`), [
    JSON.stringify({ type: "user", message: { content: "Can you summarize how the landing-recovery module connects to the frame loop after the split?" } }),
    JSON.stringify({ type: "assistant", message: { model: "claude-opus-4-8", usage, content: [{ type: "text", text: "Short version: landing-recovery now owns the complete touchdown state machine.\n\n1. frame() calls landingRecovery.tick(ctx) once per frame.\n2. The module reads canopy state through an explicit ctx, never through globals.\n3. At touchdown, the result is written to session-events as a JumpJudgement.\n\nThe window.__SWOOP.landing probe surface is unchanged, so the gate from #30 still covers initialization order." }] } }),
    JSON.stringify({ type: "system", subtype: "compact_boundary", compactMetadata: { trigger: "auto", preTokens: 158_000, postTokens: 96_000 } }),
    JSON.stringify({ type: "user", message: { content: "Looks good. Run the regression suite and bank a PR when it is green." } }),
    JSON.stringify({ type: "assistant", message: { model: "claude-opus-4-8", usage, content: [{ type: "text", text: "The suite is green (312 tests, 0 skips). PR #41 is open as a draft against master with the gate evidence in its description." }] } }),
    JSON.stringify({ type: "user", timestamp: new Date(deniedAt).toISOString(), message: { content: deniedPrompt } }),
    "",
  ].join("\n"));

  return { root, dataDir, homeDir, project, claudeAgent };
};

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.pageErrors = [];
    this.ready = new Promise((resolveReady, rejectReady) => {
      this.ws.addEventListener("open", resolveReady, { once: true });
      this.ws.addEventListener("error", () => rejectReady(new Error("CDP websocket error")), { once: true });
    });
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message}`));
        else resolve(message.result);
      } else if (message.method === "Runtime.exceptionThrown") {
        this.pageErrors.push(message.params.exceptionDetails?.exception?.description ?? "unknown page exception");
      } else if (message.method === "Network.loadingFailed") {
        this.pageErrors.push(`asset failed: ${message.params.errorText}`);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? "evaluate failed");
    }
    return result.result.value;
  }

  close() { this.ws.close(); }
}

const launchChrome = (chrome, profileDir) => new Promise((resolveLaunch, rejectLaunch) => {
  const child = spawn(chrome, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "--force-color-profile=srgb",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  const timer = setTimeout(() => rejectLaunch(new Error(`Chrome gave no DevTools endpoint. stderr:\n${stderr}`)), 15_000);
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
    if (match) {
      clearTimeout(timer);
      resolveLaunch({ child, browserWsUrl: match[1] });
    }
  });
  child.on("exit", () => rejectLaunch(new Error(`Chrome exited early. stderr:\n${stderr}`)));
});

const pageTargetUrl = async (browser) => {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  return targetId;
};

const GATE_CHECKS = `(() => {
  const visible = (selector) => {
    const node = document.querySelector(selector);
    if (!node) return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const doc = document.documentElement;
  const composerRect = document.querySelector("#composer-wrap")?.getBoundingClientRect() ?? null;
  const lastMessageRect = document.querySelector("#message-list")?.lastElementChild?.getBoundingClientRect() ?? null;
  const quotaChips = [...document.querySelectorAll(".quota-chip")].map((node) => {
    const rect = node.getBoundingClientRect();
    return {
      engine: node.dataset.engine ?? "unknown",
      left: rect.left,
      right: rect.right,
      width: rect.width,
    };
  });
  const unnamed = [...document.querySelectorAll("button, a, input, select, textarea")]
    .filter((node) => !node.closest(".hidden") && !node.hidden && node.type !== "hidden")
    .filter((node) => {
      const label = node.getAttribute("aria-label")
        ?? node.getAttribute("aria-labelledby")
        ?? node.getAttribute("placeholder")
        ?? node.closest("label")?.textContent
        ?? node.textContent;
      return !String(label ?? "").trim();
    })
    .map((node) => node.id || node.className || node.tagName);
  return {
    snapshotReady: doc.dataset.snapshotReady === "true",
    viewportWidth: window.innerWidth,
    horizontalOverflow: Math.max(doc.scrollWidth - doc.clientWidth, document.body.scrollWidth - doc.clientWidth),
    quotaChips,
    surfaces: {
      topbar: visible(".topbar"),
      themeToggle: visible("#theme-toggle"),
      sidebarAgent: visible(".agent-button"),
      contextMeter: visible("#context-control"),
      effortSelect: visible("#agent-effort-select"),
      compactButton: visible("#compact-button"),
      sideQuestionButton: visible("#side-question-button"),
      composer: visible("#composer"),
      userMessage: visible(".message.user"),
      assistantMessage: visible(".message.assistant"),
      compactNotice: visible(".message.notice"),
      permissionDenied: visible(".message.permission-denied"),
    },
    unnamedControls: unnamed,
    composerFlush: composerRect ? Math.abs(composerRect.bottom - window.innerHeight) <= 1 : false,
    lastMessageClear: composerRect && lastMessageRect ? lastMessageRect.bottom <= composerRect.top + 1 : false,
  };
})()`;

const runViewport = async (page, viewport, url) => {
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.deviceScaleFactor,
    mobile: viewport.mobile,
  });
  await page.send("Page.navigate", { url });

  const deadline = Date.now() + 20_000;
  for (;;) {
    const ready = await page.evaluate("document.documentElement.dataset.snapshotReady === 'true'").catch(() => false);
    if (ready) break;
    if (Date.now() > deadline) {
      throw new Error(`snapshotReady timeout on ${viewport.name}. Page errors: ${page.pageErrors.join("; ") || "none"}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }

  // Reading position of a live chat: scrolled to the latest message.
  await page.evaluate("window.scrollTo(0, document.body.scrollHeight), true");
  await new Promise((resolveWait) => setTimeout(resolveWait, 150));

  const report = await page.evaluate(GATE_CHECKS);
  const failures = [];
  if (!report.composerFlush) failures.push("composer is not flush with the viewport bottom at reading position");
  if (!report.lastMessageClear) failures.push("last message is occluded by the composer at reading position");
  if (report.horizontalOverflow > 1) failures.push(`horizontal overflow of ${report.horizontalOverflow}px`);
  const quotaEngines = new Set(report.quotaChips.map((chip) => chip.engine));
  for (const engine of ["claude", "codex"]) {
    if (!quotaEngines.has(engine)) failures.push(`quota chip missing: ${engine}`);
  }
  for (const chip of report.quotaChips) {
    if (chip.left < 0 || chip.right > report.viewportWidth) {
      failures.push(`quota chip ${chip.engine} leaves viewport: `
        + `left ${chip.left.toFixed(1)}px, right ${chip.right.toFixed(1)}px, `
        + `viewport ${report.viewportWidth}px`);
    }
  }
  for (const [surface, ok] of Object.entries(report.surfaces)) {
    if (!ok) failures.push(`surface missing/invisible: ${surface}`);
  }
  if (report.unnamedControls.length) failures.push(`controls without accessible name: ${report.unnamedControls.join(", ")}`);
  if (page.pageErrors.length) failures.push(`page errors: ${page.pageErrors.join("; ")}`);

  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const screenshot = await page.send("Page.captureScreenshot", { format: "png" });
  const artifact = join(ARTIFACT_DIR, `webui-${viewport.name}.png`);
  writeFileSync(artifact, Buffer.from(screenshot.data, "base64"));

  const pasteDispatch = await page.evaluate(`(() => {
    const originalFetch = window.fetch.bind(window);
    window.__pasteUploadCalls = 0;
    window.fetch = (...args) => {
      if (String(args[0]).includes('/uploads?name=')) window.__pasteUploadCalls += 1;
      return originalFetch(...args);
    };
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='), (char) => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], '', { type: 'image/png' }));
    transfer.items.add(new File([bytes], '', { type: 'image/jpeg' }));
    const imagePaste = new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true });
    document.querySelector('#prompt').dispatchEvent(imagePaste);
    document.querySelector('#prompt').dispatchEvent(imagePaste);

    const textTransfer = new DataTransfer();
    textTransfer.setData('text/plain', 'ordinary text paste');
    const textPaste = new ClipboardEvent('paste', { clipboardData: textTransfer, bubbles: true, cancelable: true });
    document.querySelector('#prompt').dispatchEvent(textPaste);
    return { imagePrevented: imagePaste.defaultPrevented, textPrevented: textPaste.defaultPrevented };
  })()`);
  const pasteDeadline = Date.now() + 5_000;
  let pasteReport;
  for (;;) {
    pasteReport = await page.evaluate(`(() => ({
      uploads: window.__pasteUploadCalls,
      chips: document.querySelectorAll('.attachment-chip').length,
      images: document.querySelectorAll('.attachment-chip img').length,
      name: document.querySelector('.attachment-chip-name')?.textContent,
    }))()`);
    if (pasteReport.chips === 2) break;
    if (Date.now() > pasteDeadline) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  if (!pasteDispatch.imagePrevented || pasteDispatch.textPrevented) {
    failures.push("clipboard handler must consume images but preserve ordinary text paste");
  }
  if (pasteReport.uploads !== 2 || pasteReport.chips !== 2 || pasteReport.images !== 2) {
    failures.push("multiple pasted images were not uploaded and previewed exactly once each");
  }
  const pastedNames = await page.evaluate("[...document.querySelectorAll('.attachment-chip-name')].map((node) => node.textContent)");
  if (pastedNames.join(",") !== "pasted-image-1.png,pasted-image-2.jpg") {
    failures.push("pasted image fallback filenames are not deterministic");
  }
  const pasteScreenshot = await page.send("Page.captureScreenshot", { format: "png" });
  const pasteArtifact = join(ARTIFACT_DIR, `webui-${viewport.name}-paste.png`);
  writeFileSync(pasteArtifact, Buffer.from(pasteScreenshot.data, "base64"));

  const themeBefore = await page.evaluate(`(() => ({
    theme: document.documentElement.dataset.theme,
    background: getComputedStyle(document.body).backgroundColor,
  }))()`);
  await page.evaluate("document.querySelector('#theme-toggle').click(), true");
  const themeAfter = await page.evaluate(`(() => ({
    theme: document.documentElement.dataset.theme,
    stored: localStorage.getItem('amux-code:color-theme'),
    background: getComputedStyle(document.body).backgroundColor,
    meta: document.querySelector('meta[name="theme-color"]')?.content,
    label: document.querySelector('#theme-toggle')?.getAttribute('aria-label'),
  }))()`);
  const expectedTheme = themeBefore.theme === "light" ? "dark" : "light";
  const expectedMeta = expectedTheme === "dark" ? "#101310" : "#f2f3ee";
  const expectedLabel = expectedTheme === "dark" ? "Switch to light theme" : "Switch to dark theme";
  if (themeAfter.theme !== expectedTheme || themeAfter.stored !== expectedTheme) {
    failures.push(`theme toggle did not persist ${expectedTheme}`);
  }
  if (themeAfter.background === themeBefore.background) failures.push("theme toggle did not change the rendered palette");
  if (themeAfter.meta !== expectedMeta) failures.push(`theme-color meta did not follow ${expectedTheme}`);
  if (themeAfter.label !== expectedLabel) failures.push("theme toggle accessible label does not describe the next theme");
  const themeScreenshot = await page.send("Page.captureScreenshot", { format: "png" });
  const themeArtifact = join(ARTIFACT_DIR, `webui-${viewport.name}-theme.png`);
  writeFileSync(themeArtifact, Buffer.from(themeScreenshot.data, "base64"));

  await page.send("Page.reload", { ignoreCache: true });
  const reloadDeadline = Date.now() + 20_000;
  for (;;) {
    const ready = await page.evaluate("document.documentElement.dataset.snapshotReady === 'true'").catch(() => false);
    if (ready) break;
    if (Date.now() > reloadDeadline) {
      failures.push("theme persistence reload did not become snapshot-ready");
      break;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  const persistedTheme = await page.evaluate("document.documentElement.dataset.theme");
  if (persistedTheme !== expectedTheme) failures.push(`theme ${expectedTheme} did not survive reload`);
  await page.evaluate("window.scrollTo(0, document.body.scrollHeight), true");

  await page.evaluate("document.querySelector('#prompt-overview-button').click(), true");
  const overlayDeadline = Date.now() + 5_000;
  for (;;) {
    const ready = await page.evaluate("document.querySelector('#prompt-overview-dialog')?.open && document.querySelectorAll('.prompt-overview-item').length === 1");
    if (ready) break;
    if (Date.now() > overlayDeadline) {
      failures.push("sent-prompt overview did not render its persisted receipt");
      break;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  const promptOverlay = await page.evaluate(`(() => {
    const dialog = document.querySelector('#prompt-overview-dialog');
    const tabs = [...document.querySelectorAll('[data-prompt-scope]')];
    return {
      open: Boolean(dialog?.open),
      preview: document.querySelector('.prompt-overview-preview')?.textContent,
      tabs: tabs.map((tab) => ({ name: tab.textContent.trim(), disabled: tab.disabled })),
      overflow: dialog ? Math.max(0, dialog.scrollWidth - dialog.clientWidth) : -1,
    };
  })()`);
  if (!promptOverlay.open) failures.push("sent-prompt overview is not open");
  if (promptOverlay.preview !== "Run the protected release action.") failures.push("sent-prompt preview missing");
  if (promptOverlay.tabs.length !== 3 || promptOverlay.tabs.some((tab) => tab.disabled)) {
    failures.push("all/project/instance prompt scopes are not available");
  }
  if (promptOverlay.overflow > 1) failures.push(`sent-prompt overview overflows ${promptOverlay.overflow}px`);
  const promptScreenshot = await page.send("Page.captureScreenshot", { format: "png" });
  const promptArtifact = join(ARTIFACT_DIR, `webui-${viewport.name}-prompts.png`);
  writeFileSync(promptArtifact, Buffer.from(promptScreenshot.data, "base64"));
  await page.evaluate("document.querySelector('#prompt-overview-dialog').close(), document.querySelector('#pinned-conversations-button').click(), true");
  const pinnedOverlay = await page.evaluate(`(() => ({
    open: Boolean(document.querySelector('#pinned-conversations-dialog')?.open),
    items: document.querySelectorAll('.pinned-conversation-item').length,
    text: document.querySelector('#pinned-conversations-list')?.textContent,
  }))()`);
  if (!pinnedOverlay.open || pinnedOverlay.items !== 2
      || !pinnedOverlay.text?.includes("UI-implementation")
      || !pinnedOverlay.text?.includes("Review-wingman")) {
    failures.push("global pinned-conversation overview is not aggregating projects");
  }
  const pinnedScreenshot = await page.send("Page.captureScreenshot", { format: "png" });
  const pinnedArtifact = join(ARTIFACT_DIR, `webui-${viewport.name}-pinned.png`);
  writeFileSync(pinnedArtifact, Buffer.from(pinnedScreenshot.data, "base64"));
  await page.evaluate("document.querySelector('.pinned-conversation-item').click(), true");
  const pinnedNavigation = await page.evaluate(`(() => ({
    project: document.querySelector('#project-select')?.value,
    agent: new URL(location.href).searchParams.get('agent'),
    heading: document.querySelector('#agent-name')?.textContent,
  }))()`);
  if (pinnedNavigation.project !== "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
      || pinnedNavigation.agent !== "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
      || pinnedNavigation.heading !== "Review-wingman") {
    failures.push("pinned conversation did not navigate across projects to its exact instance");
  }

  return { failures, artifacts: [artifact, pasteArtifact, themeArtifact, promptArtifact, pinnedArtifact] };
};

const main = async () => {
  const chrome = findChrome();
  const seed = seedWorkspace();
  const app = createWebUi({
    dataDir: seed.dataDir,
    homeDir: seed.homeDir,
    legacyDataDir: null,
    // The snapshot view is read-only; any engine spawn from the gate is a bug.
    spawnProcess: () => { throw new Error("visual gate must never spawn an engine process"); },
  });
  const { url } = await app.listen({ port: 0 });
  const profileDir = join(seed.root, "chrome-profile");
  const { child, browserWsUrl } = await launchChrome(chrome, profileDir);

  let failed = false;
  try {
    const browser = new Cdp(browserWsUrl);
    await browser.ready;
    const targetId = await pageTargetUrl(browser);
    const { webSocketDebuggerUrl } = await fetch(
      `http://${new URL(browserWsUrl).host}/json/list`,
    ).then((response) => response.json()).then((targets) => targets.find((target) => target.id === targetId));
    const page = new Cdp(webSocketDebuggerUrl);
    await page.ready;
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Network.enable");

    const snapshotUrl = `${url}/?snapshot=1&project=${seed.project.id}&agent=${seed.claudeAgent.id}`;
    for (const viewport of VIEWPORTS) {
      const { failures, artifacts } = await runViewport(page, viewport, snapshotUrl);
      if (failures.length) {
        failed = true;
        console.error(`✗ ${viewport.name} (${viewport.width}x${viewport.height})`);
        for (const failure of failures) console.error(`    ${failure}`);
      } else {
        console.log(`✓ ${viewport.name} (${viewport.width}x${viewport.height}) — no overflow, all surfaces visible, controls named`);
      }
      for (const artifact of artifacts) console.log(`  screenshot: ${artifact}`);
    }
    page.close();
    browser.close();
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
      child.kill("SIGKILL");
      await Promise.race([
        exited,
        new Promise((resolveWait) => setTimeout(resolveWait, 5_000)),
      ]);
    }
    await app.close();
    rmSync(seed.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }

  if (failed) {
    console.error("visual gate FAILED");
    process.exitCode = 1;
  } else {
    console.log("visual gate PASSED");
  }
};

main().catch((error) => {
  console.error(`visual gate errored: ${error.message}`);
  process.exitCode = 1;
});
