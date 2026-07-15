const root = document.querySelector<HTMLDivElement>("#app");

if (root === null) {
  throw new Error("Renderer root element is missing.");
}

root.textContent = "WhisperDictation";
