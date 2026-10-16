"use strict";

(function exposeCardView() {
  const MOBILE_OFFSET_STRENGTH = 0.45;
  const MOBILE_ROTATION_STRENGTH = 0.6;

  function imagePath(card) {
    if (!card?.character) return "";
    if (card.joker) return "/images/hagechopa/hagechopa_joker.png";
    return `/images/${card.character}/${card.character}_${card.number}.png`;
  }

  function createCardFront(card) {
    const front = document.createElement("span");
    front.className = `card-face card-front ${card.character || ""}`;
    if (!card.name) return front;

    const image = document.createElement("img");
    image.className = "card-image hidden";
    image.src = imagePath(card);
    image.alt = `${card.name}${card.number ?? "ジョーカー"}`;

    const fallback = document.createElement("span");
    fallback.className = "card-fallback";
    const name = document.createElement("span");
    name.className = "card-name";
    name.textContent = card.name;
    const mark = document.createElement("span");
    mark.className = "card-mark";
    mark.textContent = card.mark;
    const number = document.createElement("span");
    number.className = "card-number";
    number.textContent = card.number ?? "★";
    fallback.append(name, mark, number);

    const createCorner = (position) => {
      const corner = document.createElement("span");
      corner.className = `card-corner ${position}`;
      const cornerNumber = document.createElement("b");
      cornerNumber.textContent = card.number ?? "★";
      const cornerMark = document.createElement("i");
      cornerMark.textContent = card.mark;
      corner.append(cornerNumber, cornerMark);
      return corner;
    };
    const imageName = document.createElement("span");
    imageName.className = "card-image-name";
    imageName.textContent = card.name;

    image.addEventListener("load", () => {
      image.classList.remove("hidden");
      fallback.classList.add("hidden");
      front.classList.add("has-image");
    }, { once: true });
    image.addEventListener("error", () => image.remove(), { once: true });
    front.append(createCorner("top-left"), image, fallback, imageName, createCorner("bottom-right"));
    return front;
  }

  function createCardBack() {
    const back = document.createElement("span");
    back.className = "card-face card-back";
    return back;
  }

  function createCard(card, index, onFlip) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "memory-card";
    button.dataset.index = index;
    const flipper = document.createElement("span");
    flipper.className = "card-flipper";
    flipper.append(createCardBack(), createCardFront(card));
    button.append(flipper);
    if (onFlip) button.addEventListener("click", () => onFlip(index));
    return button;
  }

  function updateCard(button, card, index, canFlip) {
    button.style.setProperty("--card-x", `${card.xOffset || 0}px`);
    button.style.setProperty("--card-y", `${card.yOffset || 0}px`);
    button.style.setProperty("--card-rotation", `${card.rotation || 0}deg`);
    button.style.setProperty("--card-x-mobile", `${(card.xOffset || 0) * MOBILE_OFFSET_STRENGTH}px`);
    button.style.setProperty("--card-y-mobile", `${(card.yOffset || 0) * MOBILE_OFFSET_STRENGTH}px`);
    button.style.setProperty("--card-rotation-mobile", `${(card.rotation || 0) * MOBILE_ROTATION_STRENGTH}deg`);
    button.style.zIndex = String(card.zIndex || 1);
    if (card.visible && !button.querySelector(".card-name, .card-image")) {
      button.lastElementChild.lastElementChild.replaceWith(createCardFront(card));
    }
    button.classList.toggle("flipped", card.visible && !card.matched);
    button.classList.toggle("matched", card.matched);
    button.disabled = !canFlip || card.visible || card.matched;
    button.setAttribute("aria-label", card.visible && card.name
      ? `${card.name} ${card.number ?? "ジョーカー"}`
      : `裏向きカード ${index + 1}`);
  }

  window.ChopanCardView = { createCard, updateCard, imagePath };
}());
