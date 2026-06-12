import { closeModal, openModal } from "@goblin-systems/goblin-design-system";
import type { ScribeDom } from "./dom";

export interface AddBadgeSubmission {
  ids: string[];
  badges: string[];
  color: string;
}

export interface AddBadgeModalController {
  open(ids: string[]): void;
}

export function parseBadgeInput(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function initAddBadgeModal(
  dom: ScribeDom,
  onSubmit: (submission: AddBadgeSubmission) => Promise<void>,
): AddBadgeModalController {
  let pendingIds: string[] = [];
  let pendingColor = "default";

  const colorContainer = document.getElementById("add-badge-colors")!;

  const reset = () => {
    pendingIds = [];
    pendingColor = "default";
    dom.addBadgeInput.value = "";
    colorContainer.querySelectorAll(".badge-color-swatch").forEach((swatch) => {
      swatch.classList.remove("is-selected");
    });
    colorContainer.querySelector<HTMLElement>('[data-color="default"]')?.classList.add("is-selected");
  };

  colorContainer.addEventListener("click", (event) => {
    const swatch = (event.target as HTMLElement).closest<HTMLElement>(".badge-color-swatch");
    if (!swatch) return;

    colorContainer.querySelectorAll(".badge-color-swatch").forEach((candidate) => {
      candidate.classList.remove("is-selected");
    });
    swatch.classList.add("is-selected");
    pendingColor = swatch.dataset.color || "default";
  });

  const confirm = async () => {
    const badges = parseBadgeInput(dom.addBadgeInput.value);

    if (pendingIds.length === 0 || badges.length === 0) {
      closeModal({ backdrop: dom.addBadgeModal });
      reset();
      return;
    }

    await onSubmit({
      ids: [...pendingIds],
      badges,
      color: pendingColor,
    });

    closeModal({ backdrop: dom.addBadgeModal });
    reset();
  };

  dom.addBadgeConfirmBtn.addEventListener("click", () => {
    void confirm();
  });

  dom.addBadgeInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void confirm();
    }
  });

  return {
    open(ids: string[]) {
      pendingIds = [...ids];
      reset();
      pendingIds = [...ids];
      openModal({ backdrop: dom.addBadgeModal });
      dom.addBadgeInput.focus();
    },
  };
}
