import { MODULE_ID, TEMPLATES, renderModuleTemplate, buildInitiativeModeOptions, buildDisciplineOptions, buildMoraleTriggerOptions } from "./shared.js";
import { GroupManager } from "./group-manager.js";

/** Manager dialogs stay on the requesting client; only writes route to the GM. */
export async function openPresetManager() {
  if (!game.user.isGM) return;
  const presets = GroupManager.getPresets();
  const content = await renderModuleTemplate(TEMPLATES.PRESETS, {
    presets: Object.entries(presets).map(([id, value]) => ({ id, ...value })),
  });
  return foundry.applications.api.DialogV2.wait({
    window: { title: game.i18n.localize("SCI.Card.Presets") }, content,
    buttons: [
      { action: "new", label: "SCI.Create", callback: () => { void editPreset(); } },
      { action: "close", label: "SCI.Cancel" },
    ],
    render: (_event, dialog) => {
      for (const button of dialog.element.querySelectorAll("[data-preset-action]")) {
        button.addEventListener("click", async () => {
          const id = button.closest("[data-preset-id]").dataset.presetId;
          button.disabled = true;
          try {
            if (button.dataset.presetAction === "edit") { await dialog.close(); await editPreset(id); return; }
            const confirmed = await foundry.applications.api.DialogV2.confirm({ window: { title: game.i18n.localize("SCI.Card.DeletePreset") } });
            if (!confirmed) return;
            await GroupManager.deletePreset(id);
            await dialog.close();
            void openPresetManager();
          } catch (error) { ui.notifications.error(error.message); }
          finally { button.disabled = false; }
        });
      }
    },
  });
}

async function editPreset(id = null) {
  const preset = id ? GroupManager.getPresets()[id] : {};
  if (!preset) return ui.notifications.warn(game.i18n.localize("SCI.Errors.StaleDocument"));
  const content = await renderModuleTemplate(TEMPLATES.GROUP_FORM, {
    name: preset.name ?? "", img: preset.img ?? "icons/svg/combat.svg", color: preset.color ?? "#7b68ee",
    initModeOptions: buildInitiativeModeOptions(preset.initiativeMode ?? game.settings.get(MODULE_ID, "defaultInitiativeMode")),
    moraleEnabled: true, moraleTriggerOptions: buildMoraleTriggerOptions(preset.moraleTrigger ?? "both"),
    disciplineOptions: buildDisciplineOptions(preset.discipline ?? "standard"),
  });
  const data = await foundry.applications.api.DialogV2.wait({
    window: { title: game.i18n.localize("SCI.Card.Presets") }, content,
    buttons: [
      { action: "save", label: "SCI.Confirm", default: true, callback: (_event, _button, dialog) => {
        const field = id => dialog.element.querySelector(`#${id}`).value;
        return { name: field("g-name"), img: field("g-img"), color: field("g-color"), initiativeMode: field("g-init-mode"), discipline: field("g-discipline"), moraleTrigger: field("g-morale-trigger") };
      } },
      { action: "cancel", label: "SCI.Cancel", callback: () => null },
    ],
    render: (_event, dialog) => {
      dialog.element.querySelector("#g-img-picker").addEventListener("click", () => {
        new foundry.applications.apps.FilePicker.implementation({ type: "image", callback: path => { dialog.element.querySelector("#g-img").value = path; } }).render({ force: true });
      });
    },
  });
  try {
    if (data) {
      if (id) await GroupManager.updatePreset(id, data);
      else await GroupManager.savePreset(data.name, data);
    }
  } catch (error) { ui.notifications.error(error.message); }
  void openPresetManager();
}
