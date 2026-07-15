import type { HistoryEntry } from "../../main/history/historyStore.js";

const list = requireElement<HTMLOListElement>("history-list");
const emptyMessage = requireElement<HTMLParagraphElement>("empty-history");
const errorMessage = requireElement<HTMLParagraphElement>("error-message");
const search = requireElement<HTMLInputElement>("history-search");
const clearButton = requireElement<HTMLButtonElement>("clear-history");
const activeConfig = requireElement<HTMLElement>("active-config");

let entries: HistoryEntry[] = [];

search.addEventListener("input", renderHistory);
clearButton.addEventListener("click", () => {
  if (!window.confirm("Clear all transcription history? This cannot be undone.")) {
    return;
  }
  void clearHistory();
});
window.settingsApi.onHistoryReload(() => {
  void reloadHistory();
});

void loadSettings();

async function loadSettings(): Promise<void> {
  try {
    const [config] = await Promise.all([
      window.settingsApi.getConfig(),
      reloadHistory(),
    ]);
    activeConfig.textContent = JSON.stringify(config, null, 2);
  } catch (error) {
    showError(error);
  }
}

async function reloadHistory(): Promise<void> {
  try {
    const loadedEntries = await window.settingsApi.listHistory();
    entries = [...loadedEntries].sort(
      (left, right) => Date.parse(right.completedAt) - Date.parse(left.completedAt),
    );
    renderHistory();
  } catch (error) {
    showError(error);
  }
}

async function clearHistory(): Promise<void> {
  clearButton.disabled = true;
  try {
    await window.settingsApi.clearHistory();
    entries = [];
    renderHistory();
  } catch (error) {
    showError(error);
  } finally {
    clearButton.disabled = false;
  }
}

function renderHistory(): void {
  const query = search.value.trim().toLocaleLowerCase();
  const visibleEntries = entries.filter((entry) =>
    entry.text.toLocaleLowerCase().includes(query),
  );
  list.replaceChildren(...visibleEntries.map(renderEntry));
  emptyMessage.hidden = visibleEntries.length !== 0;
  emptyMessage.textContent =
    entries.length === 0
      ? "No transcription history yet."
      : "No history entries match your search.";
}

function renderEntry(entry: HistoryEntry): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "history-entry";
  item.dataset.sessionId = entry.sessionId;

  const text = document.createElement("p");
  text.className = "entry-text";
  text.textContent = entry.text;

  const meta = document.createElement("div");
  meta.className = "entry-meta";

  const details = document.createElement("span");
  details.textContent = `${relativeTime(entry.completedAt)} · ${formatDuration(entry.audioDurationMilliseconds)} · ${Math.round(entry.transcriptionMilliseconds)} ms transcription`;

  const actions = document.createElement("span");
  actions.className = "entry-actions";

  const profile = document.createElement("span");
  profile.className = "profile";
  profile.textContent = entry.profile;

  const copy = document.createElement("button");
  copy.className = "copy-button";
  copy.type = "button";
  copy.textContent = "Copy";
  copy.setAttribute("aria-label", `Copy ${entry.sessionId}`);
  copy.addEventListener("click", () => {
    void window.settingsApi.copyText(entry.text).catch(showError);
  });

  actions.append(profile, copy);
  meta.append(details, actions);
  item.append(text, meta);
  return item;
}

function relativeTime(completedAt: string): string {
  const elapsedSeconds = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(completedAt)) / 1_000),
  );
  if (elapsedSeconds < 60) {
    return "just now";
  }
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m ago`;
  }
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `${elapsedHours}h ago`;
  }
  return `${Math.floor(elapsedHours / 24)}d ago`;
}

function formatDuration(milliseconds: number): string {
  return `${(milliseconds / 1_000).toFixed(1)}s audio`;
}

function showError(error: unknown): void {
  errorMessage.textContent =
    error instanceof Error ? error.message : `Settings error: ${String(error)}`;
  errorMessage.hidden = false;
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`Missing settings element: ${id}`);
  }
  return element as T;
}
