import { $ } from "../dom.mjs";

export function openModal(selector) {
  const element = $(selector);
  element.classList.add("open");
  element.setAttribute("aria-hidden", "false");
}

export function closeModal(selector) {
  const element = $(selector);
  element.classList.remove("open");
  element.setAttribute("aria-hidden", "true");
}

export function bindBackdropClose(selector, close) {
  $(selector).onclick = (event) => {
    if (event.target === $(selector)) close();
  };
}
