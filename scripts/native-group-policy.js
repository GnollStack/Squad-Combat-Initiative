/** SCI owns grouping while enabled. Saved native records remain untouched. */
import { MODULE_ID } from "./shared.js";

export function suppressNativeMembership(combatant) {
  const native = combatant.group;
  if (native && typeof native === "object") native.members?.delete(combatant);
  combatant.group = null;
  // Native preparation projects the native group's score onto every member.
  // Restore the member's own persisted value without issuing a document update.
  combatant.initiative = Number.isFinite(combatant._source?.initiative) ? combatant._source.initiative : null;
}

export function disableNativeGrouping() {
  const path = typeof globalThis.dnd5e?.documents?.Combatant5e === "function" ? "dnd5e.documents.Combatant5e" : "Combatant";
  libWrapper.register(MODULE_ID, `${path}.prototype._prepareGroup`, function (wrapped, ...args) {
    const result = wrapped(...args);
    suppressNativeMembership(this);
    return result;
  }, "WRAPPER");
}
