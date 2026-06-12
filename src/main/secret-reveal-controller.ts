import { applyIcons } from "@goblin-systems/goblin-design-system";

type SecretDetailBinding = {
  container: HTMLElement;
  content: string;
  maskedLength: number;
  persistentReveal: boolean;
};

type SecretRevealListener = () => void;

const secretDetailBindings = new Map<string, SecretDetailBinding>();
const secretRevealListeners = new Set<SecretRevealListener>();

let altRevealActive = false;
let isInitialised = false;

export function initSecretRevealController(): void {
  if (isInitialised) return;
  isInitialised = true;

  window.addEventListener("keydown", handleAltStateChange);
  window.addEventListener("keyup", handleAltStateChange);
  window.addEventListener("blur", resetAltRevealState);
  document.addEventListener("visibilitychange", handleVisibilityChange);
}

export function isSecretRevealActive(): boolean {
  return altRevealActive;
}

export function subscribeSecretReveal(listener: SecretRevealListener): () => void {
  secretRevealListeners.add(listener);
  return () => {
    secretRevealListeners.delete(listener);
  };
}

export function bindSecretDetailReveal(options: {
  bindingId: string;
  container: HTMLElement;
  content: string;
  maskedLength?: number;
}): void {
  const existing = secretDetailBindings.get(options.bindingId);
  secretDetailBindings.set(options.bindingId, {
    container: options.container,
    content: options.content,
    maskedLength: options.maskedLength ?? Math.min(options.content.length, 40),
    persistentReveal: existing?.persistentReveal ?? false,
  });

  renderBinding(options.bindingId);
}

export function clearSecretDetailReveal(bindingId: string): void {
  secretDetailBindings.delete(bindingId);
}

function handleAltStateChange(event: KeyboardEvent): void {
  if (event.key !== "Alt" && !event.altKey) return;
  setAltRevealActive(event.getModifierState("Alt"));
}

function handleVisibilityChange(): void {
  if (!document.hidden) return;
  resetAltRevealState();
}

function resetAltRevealState(): void {
  setAltRevealActive(false);
}

function setAltRevealActive(nextState: boolean): void {
  if (altRevealActive === nextState) return;
  altRevealActive = nextState;
  renderAllBindings();
  secretRevealListeners.forEach((listener) => listener());
}

function renderAllBindings(): void {
  secretDetailBindings.forEach((_, bindingId) => renderBinding(bindingId));
}

function renderBinding(bindingId: string): void {
  const binding = secretDetailBindings.get(bindingId);
  if (!binding) return;

  const isRevealed = altRevealActive || binding.persistentReveal;
  const isPersistentlyRevealed = binding.persistentReveal;

  binding.container.replaceChildren();

  const row = document.createElement("div");
  row.className = "masked-content-row";

  const text = document.createElement("span");
  text.className = isRevealed ? "secret-text" : "masked-text";
  text.textContent = isRevealed ? binding.content : "•".repeat(binding.maskedLength);

  const button = document.createElement("button");
  button.className = "icon-btn icon-btn-sm";
  button.type = "button";
  button.title = isPersistentlyRevealed ? "Hide secret" : "Reveal secret";
  button.setAttribute("aria-label", isPersistentlyRevealed ? "Hide secret" : "Reveal secret");
  button.innerHTML = `<i data-lucide="${isPersistentlyRevealed ? "eye-off" : "eye"}"></i>`;
  button.addEventListener("click", () => {
    binding.persistentReveal = !binding.persistentReveal;
    renderBinding(bindingId);
  });

  row.append(text, button);
  binding.container.appendChild(row);
  applyIcons();
}
