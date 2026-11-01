/**
 * @file carousel-settings.js
 * @description The Carousel Settings window, and greying out its button when Carousel cannot be used.
 * @version Foundry V14+
 */

import { MODULE_ID, TEMPLATES } from "./shared.js";
import { carouselAvailability } from "./carousel-squads.js";

const MENU_KEY = "carouselSettings";
const NUMBER_FIELDS = Object.freeze(["carouselMembersShown", "carouselPreviewCount"]);
const BOOLEAN_FIELDS = Object.freeze(["carouselSquadCards", "carouselFadeEdges", "carouselShowHealth", "carouselShowNext", "carouselDimDefeated", "carouselShowInitiative", "carouselShowMorale", "carouselShowCaptain"]);
const CHOICE_FIELDS = Object.freeze(["carouselExpandDirection", "carouselMemberOrder", "carouselCollapse", "carouselDefeated"]);

const UNAVAILABLE_NOTICES = Object.freeze({
  notInstalled: "SCI.Carousel.Unavailable.NotInstalled",
  notEnabled: "SCI.Carousel.Unavailable.NotEnabled",
  unsupported: "SCI.Carousel.Unavailable.Unsupported",
});

function selectOptions(key) {
  const { choices } = game.settings.settings.get(`${MODULE_ID}.${key}`);
  const current = game.settings.get(MODULE_ID, key);
  return Object.entries(choices).map(([value, label]) => ({ value, label, selected: value === current }));
}

/** Built on demand so the window's classes are only needed where Foundry provides them. */
function createSettingsApplication() {
  const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
  return class CarouselSettings extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
      id: "sci-carousel-settings",
      tag: "form",
      window: { title: "SCI.Carousel.Settings.Title", contentClasses: ["standard-form"] },
      position: { width: 520 },
      form: { handler: CarouselSettings.#onSubmit, closeOnSubmit: true },
    };

    static PARTS = {
      form: { template: TEMPLATES.CAROUSEL_SETTINGS },
      footer: { template: "templates/generic/form-footer.hbs" },
    };

    async _prepareContext() {
      const availability = carouselAvailability();
      const available = availability === "available";
      return {
        available,
        notice: available ? null : UNAVAILABLE_NOTICES[availability],
        values: Object.fromEntries([...NUMBER_FIELDS, ...BOOLEAN_FIELDS].map((key) => [key, game.settings.get(MODULE_ID, key)])),
        directionOptions: selectOptions("carouselExpandDirection"),
        orderOptions: selectOptions("carouselMemberOrder"),
        collapseOptions: selectOptions("carouselCollapse"),
        defeatedOptions: selectOptions("carouselDefeated"),
        buttons: available ? [{ type: "submit", icon: "fa-solid fa-floppy-disk", label: "SETTINGS.Save" }] : [],
      };
    }

    static async #onSubmit(_event, _form, formData) {
      if (carouselAvailability() !== "available") return;
      const values = formData.object;
      for (const key of [...NUMBER_FIELDS, ...BOOLEAN_FIELDS, ...CHOICE_FIELDS]) {
        const value = BOOLEAN_FIELDS.includes(key) ? values[key] === true : values[key];
        if (value !== game.settings.get(MODULE_ID, key)) await game.settings.set(MODULE_ID, key, value);
      }
    }
  };
}

/** Registers the menu and the hook that greys its button. Call during init. */
export function registerCarouselMenu() {
  game.settings.registerMenu(MODULE_ID, MENU_KEY, {
    name: "SCI.Carousel.Settings.Name",
    label: "SCI.Carousel.Settings.Label",
    hint: "SCI.Carousel.Settings.Hint",
    icon: "fa-solid fa-layer-group",
    type: createSettingsApplication(),
    restricted: true,
  });

  Hooks.on("renderSettingsConfig", (_app, element) => {
    const availability = carouselAvailability();
    if (availability === "available") return;
    const button = element.querySelector(`button[data-action="openSubmenu"][data-key="${MODULE_ID}.${MENU_KEY}"]`);
    if (!button) return;
    button.disabled = true;
    button.setAttribute("aria-disabled", "true");
    const hint = button.closest(".form-group")?.querySelector(".hint");
    if (hint) hint.textContent = game.i18n.localize(UNAVAILABLE_NOTICES[availability]);
  });
}
