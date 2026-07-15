const $ = (selector) => document.querySelector(selector);

const THEME_STORAGE_KEY = "amux-code:color-theme";
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
const readStoredTheme = () => {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : null;
  } catch {
    return null;
  }
};
const storedTheme = readStoredTheme();
let followsSystemTheme = storedTheme === null;
let colorTheme = storedTheme ?? (systemTheme.matches ? "dark" : "light");

const applyColorTheme = (theme) => {
  colorTheme = theme;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#101310" : "#f2f3ee");
};

applyColorTheme(colorTheme);

const elements = {
  themeToggle: $("#theme-toggle"),
  themeToggleIcon: $("#theme-toggle-icon"),
  projectSelect: $("#project-select"),
  pinnedConversationsButton: $("#pinned-conversations-button"),
  promptOverviewButton: $("#prompt-overview-button"),
  newProjectButton: $("#new-project-button"),
  newAgentButton: $("#new-agent-button"),
  deleteProjectButton: $("#delete-project-button"),
  agentList: $("#agent-list"),
  emptyState: $("#empty-state"),
  emptyTitle: $("#empty-title"),
  emptyCopy: $("#empty-copy"),
  emptyAction: $("#empty-action"),
  agentWorkspace: $("#agent-workspace"),
  engineMark: $("#engine-mark"),
  agentName: $("#agent-name"),
  agentMeta: $("#agent-meta"),
  projectPath: $("#project-path"),
  runState: $("#run-state"),
  contextControl: $("#context-control"),
  contextLabel: $("#context-label"),
  contextTrack: $(".context-track"),
  contextFill: $("#context-fill"),
  contextDetail: $("#context-detail"),
  agentEffortSelect: $("#agent-effort-select"),
  compactButton: $("#compact-button"),
  interruptButton: $("#interrupt-button"),
  pinConversationButton: $("#pin-conversation-button"),
  deleteAgentButton: $("#delete-agent-button"),
  messageList: $("#message-list"),
  composerWrap: $("#composer-wrap"),
  composer: $("#composer"),
  prompt: $("#prompt"),
  sendButton: $("#send-button"),
  attachButton: $("#attach-button"),
  fileInput: $("#file-input"),
  attachmentList: $("#attachment-list"),
  projectDialog: $("#project-dialog"),
  projectForm: $("#project-form"),
  projectNameInput: $("#project-name-input"),
  projectCwdInput: $("#project-cwd-input"),
  agentDialog: $("#agent-dialog"),
  agentForm: $("#agent-form"),
  agentNameInput: $("#agent-name-input"),
  agentProjectPath: $("#agent-project-path"),
  engineInput: $("#engine-input"),
  modelInput: $("#model-input"),
  modelOptions: $("#model-options"),
  effortInput: $("#effort-input"),
  sideQuestionButton: $("#side-question-button"),
  sidePanel: $("#side-panel"),
  closeSidePanel: $("#close-side-panel"),
  sideThread: $("#side-thread"),
  sideForm: $("#side-form"),
  sideQuestionInput: $("#side-question-input"),
  sideQuestionSend: $("#side-question-send"),
  promptOverviewDialog: $("#prompt-overview-dialog"),
  closePromptOverview: $("#close-prompt-overview"),
  refreshPromptOverview: $("#refresh-prompt-overview"),
  promptOverviewCopy: $("#prompt-overview-copy"),
  promptOverviewList: $("#prompt-overview-list"),
  promptScopeButtons: [...document.querySelectorAll("[data-prompt-scope]")],
  pinnedConversationsDialog: $("#pinned-conversations-dialog"),
  closePinnedConversations: $("#close-pinned-conversations"),
  pinnedConversationsList: $("#pinned-conversations-list"),
  quotaStrip: $("#quota-strip"),
  quotaPopover: $("#quota-popover"),
  toast: $("#toast"),
};

const renderThemeToggle = () => {
  const nextTheme = colorTheme === "light" ? "dark" : "light";
  const translated = nextTheme === "dark" ? "mörkt" : "ljust";
  const label = `Byt till ${translated} tema`;
  elements.themeToggle.setAttribute("aria-label", label);
  elements.themeToggle.title = label;
  elements.themeToggleIcon.textContent = nextTheme === "dark" ? "☾" : "☀";
};

const setColorTheme = (theme, persist) => {
  applyColorTheme(theme);
  if (persist) {
    followsSystemTheme = false;
    try { localStorage.setItem(THEME_STORAGE_KEY, theme); } catch {}
  }
  renderThemeToggle();
};

elements.themeToggle.addEventListener("click", () => {
  setColorTheme(colorTheme === "light" ? "dark" : "light", true);
});
renderThemeToggle();

systemTheme.addEventListener("change", (event) => {
  if (followsSystemTheme) setColorTheme(event.matches ? "dark" : "light", false);
});

window.addEventListener("storage", (event) => {
  if (event.key !== THEME_STORAGE_KEY) return;
  const stored = event.newValue === "light" || event.newValue === "dark" ? event.newValue : null;
  followsSystemTheme = stored === null;
  setColorTheme(stored ?? (systemTheme.matches ? "dark" : "light"), false);
});

const route = new URL(location.href);
const state = {
  config: null,
  projects: [],
  projectId: route.searchParams.get("project"),
  agentId: route.searchParams.get("agent"),
  eventSource: null,
  attachedAgentId: null,
  seenEventIds: new Set(),
  liveMessage: null,
  attachments: [],
  pendingMessage: null,
  sending: false,
  controlPending: false,
  pinPending: false,
  promptOverviewScope: "all",
  promptOverviewRequest: 0,
  toastTimer: null,
  snapshot: route.searchParams.get("snapshot") === "1",
};

const selectedProject = () => state.projects.find((project) => project.id === state.projectId) ?? null;
const selectedAgent = () => selectedProject()?.agents.find((agent) => agent.id === state.agentId) ?? null;

const api = async (url, options = {}) => {
  const response = await fetch(url, options);
  const type = response.headers.get("content-type") ?? "";
  const body = type.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    const error = new Error(body?.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.detail = body?.detail;
    throw error;
  }
  return body;
};

const errorText = (error) => ({
  "cwd-not-a-directory": "Mappen finns inte eller är inte en katalog på servern.",
  "idempotency-key-conflict": "Försöket ändrades efter att det skickades. Försök igen.",
  "turn-in-progress": "Agenten arbetar redan. Vänta eller avbryt den pågående turnen.",
  "agent-not-running": "Agenten har ingen pågående turn att avbryta.",
  "interrupt-not-ready": "Codex startar fortfarande turnen. Försök igen om ett ögonblick.",
  "compact-needs-session": "Skicka först ett meddelande så agenten får en session att compacta.",
  "unknown-effort": "Den effort-nivån stöds inte av den valda motorn.",
  "side-question-needs-session": "Skicka först ett vanligt meddelande så agenten får en session.",
  "side-question-claude-only": "Sidofrågor stöds för Claude-agenter i den här versionen.",
  "side-question-failed": `Sidofrågan misslyckades${error.detail ? `: ${error.detail}` : "."}`,
  "body-too-large": "Filen är större än 25 MB.",
}[error.message] ?? error.message);

const showToast = (text, kind = "normal") => {
  clearTimeout(state.toastTimer);
  elements.toast.textContent = text;
  elements.toast.className = `toast visible${kind === "error" ? " error" : ""}`;
  state.toastTimer = setTimeout(() => { elements.toast.className = "toast"; }, 4_500);
};

const persistRoute = () => {
  const url = new URL(location.href);
  if (state.projectId) url.searchParams.set("project", state.projectId);
  else url.searchParams.delete("project");
  if (state.agentId) url.searchParams.set("agent", state.agentId);
  else url.searchParams.delete("agent");
  history.replaceState(null, "", url);
};

const setDialogBusy = (form, busy) => {
  for (const field of form.elements) field.disabled = busy;
};

const openProjectDialog = () => {
  elements.projectForm.reset();
  elements.projectForm.dataset.key = crypto.randomUUID();
  elements.projectDialog.showModal();
  queueMicrotask(() => elements.projectNameInput.focus());
};

const effortLabel = (effort) => ({
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
}[effort] ?? effort);

const replaceEffortOptions = (select, engine, selected = null) => {
  const efforts = state.config?.efforts?.[engine] ?? [];
  select.replaceChildren(...efforts.map((effort) => {
    const option = document.createElement("option");
    option.value = effort;
    option.textContent = effortLabel(effort);
    return option;
  }));
  select.value = efforts.includes(selected)
    ? selected
    : (state.config?.defaultEffort?.[engine] ?? efforts[0] ?? "");
};

const updateModelOptions = (resetValue = true) => {
  const engine = elements.engineInput.value;
  const options = state.config?.models?.[engine] ?? [];
  elements.modelOptions.replaceChildren(...options.map((model) => {
    const option = document.createElement("option");
    option.value = model;
    return option;
  }));
  if (resetValue || !elements.modelInput.value) elements.modelInput.value = options[0] ?? "";
  replaceEffortOptions(elements.effortInput, engine,
    resetValue ? state.config?.defaultEffort?.[engine] : elements.effortInput.value);
};

const openAgentDialog = () => {
  const project = selectedProject();
  if (!project) { openProjectDialog(); return; }
  elements.agentForm.reset();
  elements.agentForm.dataset.key = crypto.randomUUID();
  elements.engineInput.value = "claude";
  updateModelOptions(true);
  elements.agentProjectPath.textContent = project.cwd;
  elements.agentDialog.showModal();
  queueMicrotask(() => elements.agentNameInput.focus());
};

const closeDialogs = () => {
  for (const dialog of [elements.projectDialog, elements.agentDialog]) {
    if (dialog.open) dialog.close();
  }
};

const agentButton = (agent) => {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `agent-button${agent.id === state.agentId ? " active" : ""}`;
  button.dataset.agentId = agent.id;
  button.setAttribute("aria-pressed", String(agent.id === state.agentId));

  const dot = document.createElement("span");
  dot.className = `agent-dot${agent.running ? " running" : ""}`;
  dot.setAttribute("aria-hidden", "true");
  const copy = document.createElement("span");
  copy.className = "agent-button-copy";
  const name = document.createElement("span");
  name.className = "agent-button-name";
  name.textContent = agent.name;
  const meta = document.createElement("span");
  meta.className = "agent-button-meta";
  const context = Number.isFinite(agent.context?.percent) ? ` · ${Math.round(agent.context.percent)}%` : "";
  meta.textContent = `${agent.engine} · ${agent.model} · ${effortLabel(agent.effort)}${context}`;
  copy.append(name, meta);
  button.append(dot, copy);
  button.addEventListener("click", () => selectAgent(agent.id));
  return button;
};

const normalizeSelection = () => {
  if (!state.projects.some((project) => project.id === state.projectId)) {
    state.projectId = state.projects[0]?.id ?? null;
    state.agentId = null;
  }
  const project = selectedProject();
  if (!project?.agents.some((agent) => agent.id === state.agentId)) {
    state.agentId = project?.agents[0]?.id ?? null;
  }
};

const renderProjectSelect = () => {
  const options = state.projects.map((project) => {
    const option = document.createElement("option");
    option.value = project.id;
    option.textContent = project.name;
    return option;
  });
  if (!options.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Inga projekt";
    options.push(option);
  }
  const create = document.createElement("option");
  create.value = "__create__";
  create.textContent = "＋ Nytt projekt…";
  options.push(create);
  elements.projectSelect.replaceChildren(...options);
  elements.projectSelect.value = state.projectId ?? "";
};

const compactNumber = (value) => {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return String(Math.round(value));
};

const relativeDuration = (milliseconds) => {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${seconds}s`;
};

const renderContext = (agent) => {
  const context = agent.context;
  const percent = Number.isFinite(context?.percent) ? context.percent : null;
  const used = context?.usedTokens;
  const windowTokens = context?.windowTokens;
  elements.contextControl.classList.toggle("warning", percent !== null && percent >= 60 && percent < 85);
  elements.contextControl.classList.toggle("critical", percent !== null && percent >= 85);
  elements.contextFill.style.width = `${percent ?? 0}%`;
  elements.contextTrack.setAttribute("aria-valuenow", String(Math.round(percent ?? 0)));
  elements.contextLabel.textContent = Number.isFinite(used) && Number.isFinite(windowTokens)
    ? `${compactNumber(used)} / ${compactNumber(windowTokens)} · ${Math.round(percent)} %`
    : Number.isFinite(used) ? `${compactNumber(used)} tokens` : "Ingen mätning";

  const details = [];
  if (Number.isFinite(context?.lastInputTokens) || Number.isFinite(context?.lastOutputTokens)) {
    details.push(`senast ${compactNumber(context?.lastInputTokens ?? 0)} in / ${compactNumber(context?.lastOutputTokens ?? 0)} ut`);
  }
  if (agent.autoCompact?.dueAt && !agent.running) {
    details.push(`auto-compact om ${relativeDuration(agent.autoCompact.dueAt - Date.now())}`);
  } else {
    details.push("auto över 60 % efter 5 min idle");
  }
  elements.contextDetail.textContent = details.join(" · ");
  elements.contextControl.title = Number.isFinite(context?.processedTokens)
    ? `Aktuell kontext, inte abonnemangskvot. Sessionen har processat ${compactNumber(context.processedTokens)} tokens.`
    : "Aktuell kontext, inte abonnemangskvot.";
};

const updateAgentHeader = () => {
  const project = selectedProject();
  const agent = selectedAgent();
  if (!agent || !project) return;
  elements.engineMark.textContent = agent.engine === "claude" ? "C" : "X";
  elements.engineMark.classList.toggle("codex", agent.engine === "codex");
  elements.agentName.textContent = agent.name;
  elements.agentMeta.textContent = `${agent.engine} · ${agent.model} · ${effortLabel(agent.effort)}`;
  elements.projectPath.textContent = project.cwd;
  elements.projectPath.title = project.cwd;
  elements.runState.textContent = agent.operation === "interrupting"
    ? "Avbryter…"
    : ["compact", "auto-compact"].includes(agent.operation)
      ? "Compactar…"
      : agent.running ? "Arbetar…" : "Klar";
  elements.runState.classList.toggle("running", agent.running);
  renderContext(agent);
  replaceEffortOptions(elements.agentEffortSelect, agent.engine, agent.effort);
  elements.agentEffortSelect.disabled = state.controlPending;
  elements.compactButton.disabled = agent.running || !agent.sessionId || state.controlPending;
  elements.compactButton.title = agent.sessionId
    ? "Sammanfatta native-sessionens kontext nu"
    : "Skicka ett meddelande först";
  elements.interruptButton.classList.toggle("hidden", !agent.running);
  elements.interruptButton.disabled = !agent.running || agent.operation === "interrupting" || state.controlPending;
  elements.pinConversationButton.disabled = state.pinPending;
  elements.pinConversationButton.textContent = agent.pinnedAt ? "Avpinna" : "Pinna";
  elements.pinConversationButton.setAttribute("aria-pressed", String(Boolean(agent.pinnedAt)));
  elements.pinConversationButton.classList.toggle("pinned", Boolean(agent.pinnedAt));
  elements.sideQuestionButton.hidden = agent.engine !== "claude";
  elements.sideQuestionButton.disabled = agent.engine !== "claude" || !agent.sessionId;
  elements.sideQuestionButton.title = agent.sessionId
    ? "Fråga en separat fork utan att avbryta huvuduppgiften"
    : "Skicka ett vanligt meddelande först";
  elements.prompt.disabled = agent.running;
  elements.sendButton.disabled = agent.running || state.sending;
  elements.attachButton.disabled = agent.running;
};

const renderChrome = () => {
  normalizeSelection();
  persistRoute();
  renderProjectSelect();
  const project = selectedProject();
  const agent = selectedAgent();
  elements.agentList.replaceChildren(...(project?.agents ?? []).map(agentButton));
  const pinnedCount = state.projects.reduce((count, item) =>
    count + item.agents.filter((agent) => agent.pinnedAt).length, 0);
  elements.pinnedConversationsButton.textContent = pinnedCount ? `Pinnade (${pinnedCount})` : "Pinnade";
  elements.newAgentButton.disabled = !project;
  elements.deleteProjectButton.disabled = !project;

  if (!project) {
    elements.emptyTitle.textContent = "Skapa ditt första projekt";
    elements.emptyCopy.textContent = "Ange projektets namn och arbetsmapp. Därefter kan du skapa Claude- och Codex-agenter som arbetar i mappen.";
    elements.emptyAction.textContent = "Nytt projekt";
    elements.emptyState.classList.remove("hidden");
    elements.agentWorkspace.classList.add("hidden");
  } else if (!agent) {
    elements.emptyTitle.textContent = `Skapa en agent i ${project.name}`;
    elements.emptyCopy.textContent = `Agenten ärver arbetsmappen ${project.cwd}. Välj Claude eller Codex och en modell.`;
    elements.emptyAction.textContent = "Ny agent";
    elements.emptyState.classList.remove("hidden");
    elements.agentWorkspace.classList.add("hidden");
  } else {
    elements.emptyState.classList.add("hidden");
    elements.agentWorkspace.classList.remove("hidden");
    updateAgentHeader();
  }

  if (agent?.id !== state.attachedAgentId) attachAgent(agent);
  if (!agent) detachAgent();
};

const refreshProjects = async () => {
  const payload = await api("/api/projects");
  state.projects = payload.projects;
  renderChrome();
};

const detachAgent = () => {
  state.eventSource?.close();
  state.eventSource = null;
  state.attachedAgentId = null;
  state.seenEventIds.clear();
  state.liveMessage = null;
  state.attachments = [];
  state.controlPending = false;
  elements.messageList.replaceChildren();
  elements.sideThread.replaceChildren();
  elements.sidePanel.classList.add("hidden");
  renderAttachments();
};

const messageElement = (role, text, extraClass = "") => {
  const article = document.createElement("article");
  article.className = `message ${role}${extraClass ? ` ${extraClass}` : ""}`;
  const label = document.createElement("div");
  label.className = "message-role";
  label.textContent = role === "user" ? "Du" : role === "assistant" ? "Agent" : "System";
  const body = document.createElement("div");
  body.className = "message-body";
  body.textContent = text;
  article.append(label, body);
  elements.messageList.append(article);
  return article;
};

const renderMessageAttachments = (article, attachments = []) => {
  if (!attachments.length) return;
  const list = document.createElement("div");
  list.className = "message-attachments";
  for (const attachment of attachments) {
    const link = document.createElement("a");
    link.className = "message-attachment";
    link.href = attachment.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    if (attachment.image) {
      const image = document.createElement("img");
      image.src = attachment.url;
      image.alt = "";
      link.append(image);
    }
    const name = document.createElement("span");
    name.textContent = attachment.name;
    link.append(name);
    list.append(link);
  }
  article.append(list);
};

const assistantText = (event) => (event.message?.content ?? [])
  .filter((block) => block.type === "text" && typeof block.text === "string")
  .map((block) => block.text)
  .join("");

const ensureLiveMessage = () => {
  if (!state.liveMessage) state.liveMessage = messageElement("assistant", "", "live");
  return state.liveMessage.querySelector(".message-body");
};

const renderResult = (event) => {
  const parts = [];
  if (Number.isFinite(event.duration_ms)) parts.push(`${(event.duration_ms / 1000).toFixed(1)} s`);
  if (Number.isFinite(event.total_cost_usd)) parts.push(`$${event.total_cost_usd.toFixed(4)}`);
  const usage = event.usage;
  const input = usage?.input_tokens ?? usage?.inputTokens;
  const output = usage?.output_tokens ?? usage?.outputTokens;
  if (Number.isFinite(input) || Number.isFinite(output)) parts.push(`${input ?? 0} in · ${output ?? 0} ut`);
  const session = event.session_id ? `session ${String(event.session_id).slice(0, 8)}` : null;
  if (session) parts.push(session);
  if (!parts.length) return;
  const meta = document.createElement("div");
  meta.className = "message meta";
  meta.textContent = `✓ ${parts.join(" · ")}`;
  elements.messageList.append(meta);
};

const renderEvent = (event) => {
  if (event.webId && state.seenEventIds.has(event.webId)) return;
  if (event.webId) state.seenEventIds.add(event.webId);

  if (event.type === "web" && event.subtype === "user") {
    state.liveMessage?.classList.remove("live");
    state.liveMessage = null;
    const article = messageElement("user", event.text);
    renderMessageAttachments(article, event.attachments);
  } else if (event.type === "stream_event"
      && event.event?.type === "content_block_delta"
      && event.event.delta?.type === "text_delta") {
    ensureLiveMessage().textContent += event.event.delta.text;
  } else if (event.type === "assistant") {
    const text = assistantText(event);
    if (!text) return;
    if (state.liveMessage) {
      state.liveMessage.querySelector(".message-body").textContent = text;
      state.liveMessage.classList.remove("live");
      state.liveMessage = null;
    } else {
      messageElement("assistant", text);
    }
  } else if (event.type === "result") {
    renderResult(event);
  } else if (event.type === "web" && event.subtype === "context") {
    const agent = selectedAgent();
    if (agent) {
      agent.context = event.context;
      renderContext(agent);
    }
  } else if (event.type === "web" && event.subtype === "settings") {
    const agent = selectedAgent();
    if (agent) {
      agent.effort = event.effort;
      updateAgentHeader();
    }
  } else if (event.type === "web" && event.subtype === "compact-start") {
    const agent = selectedAgent();
    if (agent) {
      agent.running = true;
      agent.operation = event.automatic ? "auto-compact" : "compact";
      updateAgentHeader();
    }
    messageElement("notice", event.automatic
      ? "Auto-compact startade efter 5 minuters idle över 60 % context."
      : "Compact startade…", "notice");
  } else if (event.type === "web" && event.subtype === "compacted") {
    if (event.metadata?.pre_tokens && event.metadata?.post_tokens) {
      messageElement("notice", `Kontext compactad: ${compactNumber(event.metadata.pre_tokens)} → ${compactNumber(event.metadata.post_tokens)} tokens.`, "notice");
    }
  } else if (event.type === "web" && event.subtype === "compact-result") {
    if (event.message) messageElement("notice", event.message, "notice");
  } else if (event.type === "web" && event.subtype === "compact-done") {
    const agent = selectedAgent();
    if (agent) {
      agent.running = false;
      agent.operation = null;
      updateAgentHeader();
    }
    if (event.code !== 0 && !event.interrupted) {
      messageElement("error", event.error || event.stderr || "Compact misslyckades.", "error");
    }
    refreshProjects().catch(() => {});
  } else if (event.type === "web" && ["interrupt-requested", "interrupt-acknowledged"].includes(event.subtype)) {
    const agent = selectedAgent();
    if (agent) {
      agent.operation = "interrupting";
      updateAgentHeader();
    }
  } else if (event.type === "web" && event.subtype === "interrupted") {
    messageElement("notice", "Turnen avbröts. Agentens session och kontext finns kvar.", "notice");
  } else if (event.type === "web" && event.subtype === "interrupt-failed") {
    messageElement("error", `Kunde inte avbryta: ${event.error}`, "error");
  } else if (event.type === "web" && event.subtype === "permission-denied") {
    messageElement(
      "error",
      event.message || "Åtgärden stoppades av agentens behörighetspolicy.",
      "error permission-denied",
    );
  } else if (event.type === "web" && event.subtype === "turn-done") {
    state.liveMessage?.classList.remove("live");
    state.liveMessage = null;
    const agent = selectedAgent();
    if (agent) {
      agent.running = false;
      agent.operation = null;
      updateAgentHeader();
    }
    if (event.code !== 0 && !event.interrupted && !event.permissionDenied) {
      messageElement("error", event.error || event.stderr || `Turn misslyckades (exit ${event.code})`, "error");
    }
    refreshProjects().catch(() => {});
    if (elements.promptOverviewDialog.open) loadPromptOverview();
  } else if (event.type === "web" && event.subtype === "protocol-error") {
    messageElement("error", `Protokollfel: ${event.line}`, "error");
  } else if (event.type === "web" && event.subtype === "history-unavailable") {
    messageElement("notice", "Sessionen finns registrerad men dess äldre historik kunde inte läsas.", "notice");
  }
  requestAnimationFrame(() => elements.messageList.lastElementChild?.scrollIntoView({ block: "end" }));
};

function attachAgent(agent) {
  detachAgent();
  if (!agent) return;
  state.attachedAgentId = agent.id;
  if (state.snapshot) {
    api(`/api/agents/${agent.id}/history`).then((payload) => {
      for (const event of payload.events) renderEvent(event);
      requestAnimationFrame(() => {
        window.scrollTo({ top: 0, left: 0, behavior: "auto" });
        document.documentElement.dataset.snapshotReady = "true";
      });
    }).catch((error) => showToast(errorText(error), "error"));
    return;
  }
  state.eventSource = new EventSource(`/api/agents/${agent.id}/events`);
  state.eventSource.onopen = () => updateAgentHeader();
  state.eventSource.onmessage = (message) => {
    try { renderEvent(JSON.parse(message.data)); } catch {}
  };
  state.eventSource.onerror = () => {
    elements.runState.textContent = "Återansluter…";
    elements.runState.classList.add("running");
  };
}

const selectProject = (projectId) => {
  state.projectId = projectId;
  state.agentId = state.projects.find((project) => project.id === projectId)?.agents[0]?.id ?? null;
  renderChrome();
};

function selectAgent(agentId) {
  state.agentId = agentId;
  renderChrome();
}

const promptStatus = (status) => ({
  accepted: "Accepterad",
  running: "Arbetar",
  completed: "Klar",
  failed: "Misslyckad",
  interrupted: "Avbruten",
  permission_denied: "Behöver behörighet",
}[status] ?? status);

const promptSource = (source) => ({
  web: "Code",
  discord: "Discord",
  cli: "amux",
  bridge: "Brygga",
  api: "API",
}[source] ?? source);

const promptTime = (timestamp) => Number.isFinite(timestamp)
  ? new Intl.DateTimeFormat("sv-SE", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(timestamp))
  : "Okänd tid";

const promptOverviewUrl = () => {
  const query = new URLSearchParams({ scope: state.promptOverviewScope, limit: "100" });
  if (state.promptOverviewScope === "project" && state.projectId) {
    query.set("projectId", state.projectId);
  }
  if (state.promptOverviewScope === "agent" && state.agentId) {
    query.set("agentId", state.agentId);
  }
  return `/api/prompts?${query}`;
};

const renderPromptOverview = (prompts = []) => {
  if (!prompts.length) {
    const empty = document.createElement("p");
    empty.className = "prompt-overview-empty";
    empty.textContent = "Inga skickade frågor på den här nivån ännu.";
    elements.promptOverviewList.replaceChildren(empty);
    return;
  }
  elements.promptOverviewList.replaceChildren(...prompts.map((prompt) => {
    const item = document.createElement("article");
    item.className = "prompt-overview-item";
    item.title = prompt.operationKey;

    const heading = document.createElement("div");
    heading.className = "prompt-overview-meta";
    const target = document.createElement("strong");
    target.textContent = `${prompt.projectName} › ${prompt.agentName}`;
    const time = document.createElement("time");
    time.dateTime = prompt.acceptedAt ? new Date(prompt.acceptedAt).toISOString() : "";
    time.textContent = promptTime(prompt.acceptedAt);
    heading.append(target, time);

    const preview = document.createElement("p");
    preview.className = "prompt-overview-preview";
    preview.textContent = prompt.preview
      ? `${prompt.preview}${prompt.previewTruncated ? "…" : ""}`
      : "Frågan skickades före leveransjournalen; textutdrag saknas.";

    const badges = document.createElement("div");
    badges.className = "prompt-overview-badges";
    const source = document.createElement("span");
    source.textContent = promptSource(prompt.source);
    const status = document.createElement("span");
    status.className = `prompt-status ${prompt.turnStatus}`;
    status.textContent = promptStatus(prompt.turnStatus);
    badges.append(source, status);
    item.append(heading, preview, badges);
    return item;
  }));
};

const loadPromptOverview = async () => {
  if ((state.promptOverviewScope === "project" && !selectedProject())
      || (state.promptOverviewScope === "agent" && !selectedAgent())) {
    state.promptOverviewScope = "all";
  }
  const requestId = ++state.promptOverviewRequest;
  elements.refreshPromptOverview.disabled = true;
  for (const button of elements.promptScopeButtons) {
    const scope = button.dataset.promptScope;
    button.disabled = (scope === "project" && !selectedProject())
      || (scope === "agent" && !selectedAgent());
    button.setAttribute("aria-selected", String(scope === state.promptOverviewScope));
  }
  const context = state.promptOverviewScope === "project"
    ? selectedProject()?.name
    : state.promptOverviewScope === "agent"
      ? selectedAgent()?.name
      : "alla projekt";
  elements.promptOverviewCopy.textContent = `Senast accepterade frågor för ${context}. Journalförs före agentstart.`;
  try {
    const payload = await api(promptOverviewUrl());
    if (requestId === state.promptOverviewRequest) renderPromptOverview(payload.prompts);
  } catch (error) {
    if (requestId === state.promptOverviewRequest) {
      renderPromptOverview([]);
      showToast(errorText(error), "error");
    }
  } finally {
    if (requestId === state.promptOverviewRequest) elements.refreshPromptOverview.disabled = false;
  }
};

const openPromptOverview = () => {
  if (!elements.promptOverviewDialog.open) elements.promptOverviewDialog.showModal();
  loadPromptOverview();
};

const pinnedConversations = () => state.projects
  .flatMap((project) => project.agents
    .filter((agent) => agent.pinnedAt)
    .map((agent) => ({ project, agent })))
  .sort((a, b) => b.agent.pinnedAt - a.agent.pinnedAt);

const renderPinnedConversations = () => {
  const pinned = pinnedConversations();
  if (!pinned.length) {
    const empty = document.createElement("p");
    empty.className = "prompt-overview-empty";
    empty.textContent = "Inga pinnade konversationer ännu.";
    elements.pinnedConversationsList.replaceChildren(empty);
    return;
  }
  elements.pinnedConversationsList.replaceChildren(...pinned.map(({ project, agent }) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pinned-conversation-item";
    const copy = document.createElement("span");
    copy.className = "pinned-conversation-copy";
    const name = document.createElement("strong");
    name.textContent = agent.name;
    const meta = document.createElement("span");
    meta.textContent = `${project.name} · ${agent.engine} · ${agent.running ? "Arbetar" : "Klar"}`;
    copy.append(name, meta);
    const arrow = document.createElement("span");
    arrow.className = "pinned-conversation-arrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = "→";
    button.append(copy, arrow);
    button.addEventListener("click", () => {
      state.projectId = project.id;
      state.agentId = agent.id;
      renderChrome();
      elements.pinnedConversationsDialog.close();
    });
    return button;
  }));
};

const openPinnedConversations = () => {
  renderPinnedConversations();
  if (!elements.pinnedConversationsDialog.open) elements.pinnedConversationsDialog.showModal();
};

const renderAttachments = () => {
  elements.attachmentList.replaceChildren(...state.attachments.map((attachment, index) => {
    const chip = document.createElement("div");
    chip.className = "attachment-chip";
    if (attachment.image) {
      const image = document.createElement("img");
      image.src = attachment.url;
      image.alt = "";
      chip.append(image);
    }
    const name = document.createElement("span");
    name.className = "attachment-chip-name";
    name.textContent = attachment.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Ta bort ${attachment.name}`);
    remove.addEventListener("click", () => {
      state.attachments.splice(index, 1);
      renderAttachments();
    });
    chip.append(name, remove);
    return chip;
  }));
};

const uploadFiles = async (files) => {
  const project = selectedProject();
  const agent = selectedAgent();
  if (!project || !agent || agent.running) return;
  for (const file of files) {
    try {
      showToast(`Laddar upp ${file.name}…`);
      const attachment = await api(`/api/projects/${project.id}/uploads?name=${encodeURIComponent(file.name)}`, {
        method: "POST",
        headers: { "content-type": file.type || "application/octet-stream" },
        body: file,
      });
      state.attachments.push(attachment);
      renderAttachments();
    } catch (error) {
      showToast(`${file.name}: ${errorText(error)}`, "error");
    }
  }
  if (files.length) showToast(`${files.length} fil${files.length === 1 ? "" : "er"} redo`);
};

const submitMessage = async () => {
  const agent = selectedAgent();
  const prompt = elements.prompt.value.trim();
  if (!agent || !prompt || agent.running || state.sending) return;
  const fingerprint = JSON.stringify({ prompt, attachments: state.attachments.map((attachment) => attachment.path) });
  if (!state.pendingMessage || state.pendingMessage.fingerprint !== fingerprint) {
    state.pendingMessage = { key: crypto.randomUUID(), fingerprint };
  }
  state.sending = true;
  updateAgentHeader();
  try {
    await api(`/api/agents/${agent.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt,
        attachments: state.attachments.map(({ path, name }) => ({ path, name })),
        idempotencyKey: state.pendingMessage.key,
        source: "web",
      }),
    });
    agent.running = true;
    agent.operation = "turn";
    elements.prompt.value = "";
    elements.prompt.style.height = "auto";
    state.attachments = [];
    state.pendingMessage = null;
    renderAttachments();
    if (elements.promptOverviewDialog.open) loadPromptOverview();
  } catch (error) {
    showToast(errorText(error), "error");
  } finally {
    state.sending = false;
    updateAgentHeader();
  }
};

const appendSideMessage = (kind, text) => {
  const item = document.createElement("div");
  item.className = `side-message ${kind}`;
  item.textContent = text;
  elements.sideThread.append(item);
  item.scrollIntoView({ block: "end" });
  return item;
};

elements.projectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setDialogBusy(elements.projectForm, true);
  try {
    const project = await api("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: elements.projectNameInput.value,
        cwd: elements.projectCwdInput.value,
        idempotencyKey: elements.projectForm.dataset.key,
      }),
    });
    elements.projectDialog.close();
    state.projectId = project.id;
    state.agentId = null;
    await refreshProjects();
    openAgentDialog();
  } catch (error) {
    showToast(errorText(error), "error");
  } finally {
    setDialogBusy(elements.projectForm, false);
  }
});

elements.agentForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const project = selectedProject();
  if (!project) return;
  setDialogBusy(elements.agentForm, true);
  try {
    const agent = await api(`/api/projects/${project.id}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: elements.agentNameInput.value,
        engine: elements.engineInput.value,
        model: elements.modelInput.value,
        effort: elements.effortInput.value,
        idempotencyKey: elements.agentForm.dataset.key,
      }),
    });
    elements.agentDialog.close();
    state.agentId = agent.id;
    await refreshProjects();
    elements.prompt.focus();
  } catch (error) {
    showToast(errorText(error), "error");
  } finally {
    setDialogBusy(elements.agentForm, false);
  }
});

elements.sideForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const agent = selectedAgent();
  const question = elements.sideQuestionInput.value.trim();
  if (!agent || !question) return;
  const key = crypto.randomUUID();
  appendSideMessage("question", question);
  const pending = appendSideMessage("answer pending", "Claude tänker vid sidan av…");
  elements.sideQuestionInput.value = "";
  elements.sideQuestionSend.disabled = true;
  try {
    const result = await api(`/api/agents/${agent.id}/side-questions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question, idempotencyKey: key }),
    });
    pending.className = "side-message answer";
    pending.textContent = result.answer;
  } catch (error) {
    pending.className = "side-message answer";
    pending.textContent = errorText(error);
  } finally {
    elements.sideQuestionSend.disabled = false;
  }
});

elements.agentEffortSelect.addEventListener("change", async () => {
  const agent = selectedAgent();
  if (!agent || state.controlPending) return;
  const previous = agent.effort;
  const effort = elements.agentEffortSelect.value;
  agent.effort = effort;
  state.controlPending = true;
  updateAgentHeader();
  try {
    const updated = await api(`/api/agents/${agent.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ effort, idempotencyKey: crypto.randomUUID() }),
    });
    agent.effort = updated.effort;
    showToast(agent.running
      ? `${effortLabel(effort)} sparad för nästa turn.`
      : `Effort ändrad till ${effortLabel(effort)}.`);
  } catch (error) {
    agent.effort = previous;
    showToast(errorText(error), "error");
  } finally {
    state.controlPending = false;
    updateAgentHeader();
  }
});

elements.pinConversationButton.addEventListener("click", async () => {
  const agent = selectedAgent();
  if (!agent || state.pinPending) return;
  const pinned = !agent.pinnedAt;
  state.pinPending = true;
  updateAgentHeader();
  try {
    const updated = await api(`/api/agents/${agent.id}/pin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned, idempotencyKey: crypto.randomUUID() }),
    });
    agent.pinnedAt = updated.pinnedAt;
    await refreshProjects();
    if (elements.pinnedConversationsDialog.open) renderPinnedConversations();
  } catch (error) {
    showToast(errorText(error), "error");
  } finally {
    state.pinPending = false;
    if (selectedAgent()) updateAgentHeader();
  }
});

elements.compactButton.addEventListener("click", async () => {
  const agent = selectedAgent();
  if (!agent || agent.running || !agent.sessionId || state.controlPending) return;
  state.controlPending = true;
  updateAgentHeader();
  try {
    await api(`/api/agents/${agent.id}/compact`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
    });
    agent.running = true;
    agent.operation = "compact";
  } catch (error) {
    showToast(errorText(error), "error");
  } finally {
    state.controlPending = false;
    updateAgentHeader();
  }
});

elements.interruptButton.addEventListener("click", async () => {
  const agent = selectedAgent();
  if (!agent || !agent.running || state.controlPending) return;
  const previousOperation = agent.operation;
  state.controlPending = true;
  agent.operation = "interrupting";
  updateAgentHeader();
  try {
    await api(`/api/agents/${agent.id}/interrupt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
    });
  } catch (error) {
    agent.operation = previousOperation;
    showToast(errorText(error), "error");
  } finally {
    state.controlPending = false;
    updateAgentHeader();
  }
});

elements.projectSelect.addEventListener("change", () => {
  if (elements.projectSelect.value === "__create__") {
    elements.projectSelect.value = state.projectId ?? "";
    openProjectDialog();
  } else {
    selectProject(elements.projectSelect.value);
  }
});
elements.pinnedConversationsButton.addEventListener("click", openPinnedConversations);
elements.closePinnedConversations.addEventListener("click", () => elements.pinnedConversationsDialog.close());
elements.promptOverviewButton.addEventListener("click", openPromptOverview);
elements.closePromptOverview.addEventListener("click", () => elements.promptOverviewDialog.close());
elements.refreshPromptOverview.addEventListener("click", loadPromptOverview);
for (const button of elements.promptScopeButtons) {
  button.addEventListener("click", () => {
    state.promptOverviewScope = button.dataset.promptScope;
    loadPromptOverview();
  });
}
elements.newProjectButton.addEventListener("click", openProjectDialog);
elements.newAgentButton.addEventListener("click", openAgentDialog);
elements.emptyAction.addEventListener("click", () => selectedProject() ? openAgentDialog() : openProjectDialog());
elements.engineInput.addEventListener("change", () => updateModelOptions(true));
elements.attachButton.addEventListener("click", () => elements.fileInput.click());
elements.fileInput.addEventListener("change", () => {
  uploadFiles([...elements.fileInput.files]);
  elements.fileInput.value = "";
});
elements.composer.addEventListener("submit", (event) => { event.preventDefault(); submitMessage(); });
elements.prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    submitMessage();
  }
});
elements.prompt.addEventListener("input", () => {
  elements.prompt.style.height = "auto";
  elements.prompt.style.height = `${Math.min(elements.prompt.scrollHeight, 180)}px`;
});

for (const type of ["dragenter", "dragover"]) {
  elements.composerWrap.addEventListener(type, (event) => {
    event.preventDefault();
    elements.composerWrap.classList.add("dragging");
  });
}
for (const type of ["dragleave", "drop"]) {
  elements.composerWrap.addEventListener(type, (event) => {
    event.preventDefault();
    elements.composerWrap.classList.remove("dragging");
  });
}
elements.composerWrap.addEventListener("drop", (event) => uploadFiles([...event.dataTransfer.files]));

elements.deleteAgentButton.addEventListener("click", async () => {
  const agent = selectedAgent();
  if (!agent || !confirm(`Ta bort agenten ${agent.name} från listan? Dess native sessionfil behålls.`)) return;
  try {
    await api(`/api/agents/${agent.id}`, { method: "DELETE" });
    state.agentId = null;
    await refreshProjects();
  } catch (error) { showToast(errorText(error), "error"); }
});

elements.deleteProjectButton.addEventListener("click", async () => {
  const project = selectedProject();
  if (!project || !confirm(`Ta bort projektet ${project.name} och dess agentposter? Sessioner och uppladdade filer raderas inte.`)) return;
  try {
    await api(`/api/projects/${project.id}`, { method: "DELETE" });
    state.projectId = null;
    state.agentId = null;
    await refreshProjects();
  } catch (error) { showToast(errorText(error), "error"); }
});

elements.sideQuestionButton.addEventListener("click", () => {
  elements.sidePanel.classList.remove("hidden");
  elements.sideQuestionInput.focus();
});
elements.closeSidePanel.addEventListener("click", () => elements.sidePanel.classList.add("hidden"));

for (const button of document.querySelectorAll("[data-close-dialog]")) {
  button.addEventListener("click", closeDialogs);
}
for (const dialog of [elements.projectDialog, elements.agentDialog]) {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
}
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") elements.sidePanel.classList.add("hidden");
});

// ---------- Weekly quota (Claude + Codex) ----------

const QUOTA_POLL_MS = 5 * 60 * 1_000;
const QUOTA_STALE_MS = 60 * 1_000;
const QUOTA_WARN_PERCENT = 70;
const QUOTA_CRITICAL_PERCENT = 90;
const QUOTA_ENGINES = ["claude", "codex"];
const QUOTA_ENGINE_LABELS = { claude: "Claude", codex: "Codex" };
const QUOTA_MANAGE_LINKS = {
  claude: { label: "Hantera Claude-kvot", url: "https://claude.ai/settings/usage" },
  codex: { label: "Hantera Codex-kvot", url: "https://chatgpt.com/codex/settings/usage" },
};
const QUOTA_ERROR_TEXTS = {
  credentials_unavailable: "Inloggningsuppgifter saknas på servern",
  credentials_expired: "Claude-token har gått ut, kör en Claude-tur så förnyas den",
  network_error: "Nätverksfel mot usage-API:t",
  invalid_response: "Oväntat svar från usage-API:t",
  no_limits_in_response: "Usage-svaret saknade kvotrader",
  no_session_files: "Inga Codex-sessionsfiler hittades",
  no_rate_limit_events: "Inga rate limit-händelser i sessionerna ännu",
  fetch_failed: "Kunde inte nå /api/quota",
};

let quotaSnapshot = null;
let quotaFetchedAt = 0;
let quotaPopoverEngine = null;

const quotaSeverityClass = (usedPercent) => {
  if (usedPercent >= QUOTA_CRITICAL_PERCENT) return "critical";
  if (usedPercent >= QUOTA_WARN_PERCENT) return "warning";
  return "ok";
};

const quotaErrorText = (data) =>
  QUOTA_ERROR_TEXTS[data?.error] || `Kvotdata otillgänglig (${data?.error || "okänt fel"})`;

const claudeLimitLabel = (limit) => {
  if (limit.kind === "session") return "Session (5 h)";
  if (limit.kind === "weekly_all") return "Vecka · alla modeller";
  if (limit.kind === "weekly_scoped") return `Vecka · ${limit.scopeName || "modell"}`;
  return limit.kind;
};

const codexWindowLabel = (window, limit) => {
  const scope = limit.limitId && limit.limitId !== "codex" ? ` · ${limit.limitId}` : "";
  if (window.windowMinutes === 10_080) return `Vecka${scope}`;
  if (window.windowMinutes && window.windowMinutes % 60 === 0) {
    return `${window.windowMinutes / 60} h${scope}`;
  }
  return `${window.windowMinutes ?? "?"} min${scope}`;
};

const quotaRows = (engine, data) => {
  if (engine === "claude") {
    return data.limits.map((limit) => ({
      label: claudeLimitLabel(limit),
      usedPercent: limit.usedPercent,
      resetsAt: limit.resetsAt,
    }));
  }
  return data.limits.flatMap((limit) => limit.windows.map((window) => ({
    label: codexWindowLabel(window, limit),
    usedPercent: window.usedPercent,
    resetsAt: window.resetsAt,
    capturedAt: limit.capturedAt,
  })));
};

const quotaHeadline = (rows) => rows.find((row) => row.label.startsWith("Vecka")) || rows[0];

const formatQuotaReset = (iso) => {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const formatted = date.toLocaleString("sv-SE", {
    weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
  return `återställs ${formatted}`;
};

const formatQuotaCaptured = (iso) => {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `mätt ${date.toLocaleString("sv-SE", { hour: "2-digit", minute: "2-digit" })}`;
};

const buildQuotaTrack = (usedPercent) => {
  const track = document.createElement("span");
  track.className = "quota-track";
  const fill = document.createElement("span");
  fill.style.width = `${usedPercent}%`;
  track.append(fill);
  return track;
};

const renderQuotaStrip = () => {
  elements.quotaStrip.replaceChildren();
  for (const engine of QUOTA_ENGINES) {
    const data = quotaSnapshot?.[engine];
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "quota-chip";
    chip.dataset.engine = engine;
    const name = document.createElement("span");
    name.className = "quota-chip-name";
    name.textContent = QUOTA_ENGINE_LABELS[engine];
    chip.append(name);

    if (quotaSnapshot === null) {
      chip.classList.add("loading");
      const value = document.createElement("span");
      value.className = "quota-chip-value";
      value.textContent = "…";
      chip.append(value);
      chip.title = "Hämtar kvotdata";
    } else if (!data?.ok) {
      chip.classList.add("unavailable");
      const value = document.createElement("span");
      value.className = "quota-chip-value";
      value.textContent = "—";
      chip.append(value);
      chip.title = quotaErrorText(data);
    } else {
      const rows = quotaRows(engine, data);
      const headline = quotaHeadline(rows);
      const worstUsed = Math.max(...rows.map((row) => row.usedPercent));
      chip.classList.add(quotaSeverityClass(worstUsed));
      chip.append(buildQuotaTrack(headline.usedPercent));
      const value = document.createElement("span");
      value.className = "quota-chip-value";
      value.textContent = `${Math.round(100 - headline.usedPercent)}% kvar`;
      chip.append(value);
      chip.title = `${QUOTA_ENGINE_LABELS[engine]} · ${headline.label}: ${headline.usedPercent}% använt`;
    }
    chip.setAttribute("aria-expanded", String(quotaPopoverEngine === engine));
    chip.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleQuotaPopover(engine);
    });
    elements.quotaStrip.append(chip);
  }
};

const closeQuotaPopover = () => {
  quotaPopoverEngine = null;
  elements.quotaPopover.hidden = true;
  renderQuotaStrip();
};

const renderQuotaPopover = () => {
  const engine = quotaPopoverEngine;
  if (!engine) return;
  const data = quotaSnapshot?.[engine];
  const popover = elements.quotaPopover;
  popover.replaceChildren();

  const heading = document.createElement("h2");
  heading.textContent = `${QUOTA_ENGINE_LABELS[engine]} · veckokvot`;
  popover.append(heading);

  if (!data?.ok) {
    const message = document.createElement("p");
    message.className = "quota-popover-error";
    message.textContent = quotaErrorText(data);
    popover.append(message);
  } else {
    let capturedAt = null;
    for (const row of quotaRows(engine, data)) {
      const rowElement = document.createElement("div");
      rowElement.className = `quota-row ${quotaSeverityClass(row.usedPercent)}`;
      const head = document.createElement("div");
      head.className = "quota-row-head";
      const label = document.createElement("span");
      label.textContent = row.label;
      const value = document.createElement("span");
      value.textContent = `${Math.round(100 - row.usedPercent)}% kvar`;
      head.append(label, value);
      rowElement.append(head, buildQuotaTrack(row.usedPercent));
      const reset = formatQuotaReset(row.resetsAt);
      if (reset) {
        const detail = document.createElement("small");
        detail.textContent = reset;
        rowElement.append(detail);
      }
      if (row.capturedAt) capturedAt = row.capturedAt;
      popover.append(rowElement);
    }

    const footer = document.createElement("div");
    footer.className = "quota-popover-footer";
    const freshness = document.createElement("span");
    freshness.textContent = engine === "codex"
      ? formatQuotaCaptured(capturedAt) || "ur senaste Codex-sessionen"
      : formatQuotaCaptured(data.fetchedAt) || "";
    const manage = document.createElement("a");
    manage.href = QUOTA_MANAGE_LINKS[engine].url;
    manage.target = "_blank";
    manage.rel = "noreferrer";
    manage.textContent = QUOTA_MANAGE_LINKS[engine].label;
    footer.append(freshness, manage);
    popover.append(footer);
  }

  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "button compact quiet quota-refresh";
  refresh.textContent = "Uppdatera nu";
  refresh.addEventListener("click", () => refreshQuota(true));
  popover.append(refresh);
};

const toggleQuotaPopover = (engine) => {
  if (quotaPopoverEngine === engine) {
    closeQuotaPopover();
    return;
  }
  quotaPopoverEngine = engine;
  renderQuotaPopover();
  const chip = elements.quotaStrip.querySelector(`[data-engine="${engine}"]`);
  const rect = chip.getBoundingClientRect();
  const popover = elements.quotaPopover;
  popover.hidden = false;
  popover.style.top = `${rect.bottom + 8}px`;
  popover.style.right = `${Math.max(12, window.innerWidth - rect.right)}px`;
  renderQuotaStrip();
};

const refreshQuota = async (force = false) => {
  try {
    quotaSnapshot = await api(`/api/quota${force ? "?refresh=1" : ""}`);
    quotaFetchedAt = Date.now();
  } catch {
    quotaSnapshot = {
      claude: { ok: false, error: "fetch_failed" },
      codex: { ok: false, error: "fetch_failed" },
    };
  }
  renderQuotaStrip();
  if (quotaPopoverEngine) renderQuotaPopover();
};

document.addEventListener("click", (event) => {
  if (quotaPopoverEngine && !elements.quotaPopover.contains(event.target)) {
    closeQuotaPopover();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && quotaPopoverEngine) closeQuotaPopover();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && Date.now() - quotaFetchedAt > QUOTA_STALE_MS) refreshQuota();
});

const init = async () => {
  try {
    [state.config] = await Promise.all([api("/api/config")]);
    await refreshProjects();
  } catch (error) {
    showToast(`Kunde inte starta: ${errorText(error)}`, "error");
  }
  renderQuotaStrip();
  refreshQuota();
  setInterval(refreshQuota, QUOTA_POLL_MS);
};

init();
setInterval(() => {
  if (selectedAgent()) updateAgentHeader();
}, 15_000);
