"use strict";

(function exposeCardView() {
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

    image.addEventListener("load", () => {
      image.classList.remove("hidden");
      fallback.classList.add("hidden");
      front.classList.add("has-image");
    }, { once: true });
    image.addEventListener("error", () => image.remove(), { once: true });
    front.append(image, fallback);
    return front;
  }

  function createCardBack() {
    const back = document.createElement("span");
    back.className = "card-face card-back";
    const image = document.createElement("img");
    image.className = "card-back-image hidden";
    image.src = "/images/card_back.png";
    image.alt = "";
    image.addEventListener("load", () => {
      image.classList.remove("hidden");
      back.classList.add("has-image");
    }, { once: true });
    image.addEventListener("error", () => image.remove(), { once: true });
    back.append(image);
    return back;
  }

  function createCard(card, index, onFlip) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "memory-card";
    button.dataset.index = index;
    button.append(createCardBack(), createCardFront(card));
    if (onFlip) button.addEventListener("click", () => onFlip(index));
    return button;
  }

  function updateCard(button, card, index, canFlip) {
    if (card.visible && !button.querySelector(".card-name, .card-image")) {
      button.lastElementChild.replaceWith(createCardFront(card));
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
