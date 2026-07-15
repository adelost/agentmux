const $ = (selector) => document.querySelector(selector);

const elements = {
  projectSelect: $("#project-select"),
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
  toast: $("#toast"),
};

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
      }),
    });
    agent.running = true;
    agent.operation = "turn";
    elements.prompt.value = "";
    elements.prompt.style.height = "auto";
    state.attachments = [];
    state.pendingMessage = null;
    renderAttachments();
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

const init = async () => {
  try {
    [state.config] = await Promise.all([api("/api/config")]);
    await refreshProjects();
  } catch (error) {
    showToast(`Kunde inte starta: ${errorText(error)}`, "error");
  }
};

init();
setInterval(() => {
  if (selectedAgent()) updateAgentHeader();
}, 15_000);
