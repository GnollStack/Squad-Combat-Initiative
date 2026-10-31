/** World-scoped squad presets. Invoked with GroupManager as `this`. */
import { MODULE_ID, logger, isGM, INITIATIVE_MODE, MORALE_TRIGGER, sanitizeColor, sanitizeImagePath } from "./shared.js";
import { assertMutationAuthority } from "./mutation-authority.js";
import { normalizeGroupConfig, PRESET_FIELDS } from "./group-contracts.js";

/** Implementation of GroupManager.getPresets; the facade in group-manager.js carries the public contract. */
export function getPresets() {
  try {
    const presets = game.settings.get(MODULE_ID, "groupPresets");
    return foundry.utils.deepClone(presets) ?? {};
  } catch {
    return {};
  }
}

/** Implementation of GroupManager.savePreset; the facade in group-manager.js carries the public contract. */
export async function savePreset(name, data = {}) {
  const log = logger.fn("savePreset");

  if (!isGM()) {
    log.warn("Non-GM attempted to save group preset");
    return null;
  }
  const presetName = String(name ?? "").trim();
  if (!presetName) throw new Error("preset name is required");
  data = normalizeGroupConfig({ ...data, name: presetName }, { partial: false });

  const presets = this.getPresets();
  const existingId = Object.keys(presets).find((id) => presets[id]?.name === presetName);
  const presetId = existingId ?? `preset-${foundry.utils.randomID()}`;

  presets[presetId] = {
    name: presetName,
    img: sanitizeImagePath(data.img, "icons/svg/combat.svg"),
    color: sanitizeColor(data.color, "#7b68ee"),
    initiativeMode: Object.values(INITIATIVE_MODE).includes(data.initiativeMode)
      ? data.initiativeMode
      : game.settings.get(MODULE_ID, "defaultInitiativeMode"),
    discipline: ["standard", "expendable", "elite", "fearless"].includes(data.discipline)
      ? data.discipline
      : "standard",
    moraleTrigger: Object.values(MORALE_TRIGGER).includes(data.moraleTrigger)
      ? data.moraleTrigger
      : MORALE_TRIGGER.BOTH,
  };

  assertMutationAuthority();
  await game.settings.set(MODULE_ID, "groupPresets", presets);
  log.debug(`Saved group preset "${presetName}"`, { presetId, overwrote: !!existingId });
  return presetId;
}

/** Implementation of GroupManager.updatePreset; the facade in group-manager.js carries the public contract. */
export async function updatePreset(presetId, data) {
  const presets = this.getPresets();
  if (!presets[presetId]) throw new Error(game.i18n.localize("SCI.Errors.StaleDocument"));
  const normalized = normalizeGroupConfig({ ...presets[presetId], ...data }, { partial: false });
  if (Object.entries(presets).some(([id, preset]) => id !== presetId && preset.name === normalized.name)) {
    throw new Error(game.i18n.localize("SCI.Errors.PresetNameExists"));
  }
  presets[presetId] = Object.fromEntries(PRESET_FIELDS.map(key => [key, normalized[key]]));
  assertMutationAuthority();
  await game.settings.set(MODULE_ID, "groupPresets", presets);
  return presetId;
}

/** Implementation of GroupManager.deletePreset; the facade in group-manager.js carries the public contract. */
export async function deletePreset(presetId) {
  const log = logger.fn("deletePreset");

  if (!isGM()) {
    log.warn("Non-GM attempted to delete group preset");
    return false;
  }

  const presets = this.getPresets();
  if (!presetId || !(presetId in presets)) return false;

  delete presets[presetId];
  assertMutationAuthority();
  await game.settings.set(MODULE_ID, "groupPresets", presets);
  log.debug("Deleted group preset", { presetId });
  return true;
}
