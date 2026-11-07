// -----------------------------------------------------------------------------
// Pluggable scheduling modules
// -----------------------------------------------------------------------------
// A scheduling module turns a channel's saved config into the engine's PlayoutDoc
// IR — the shared SchedulingEngine + emitter then build the playout. Modules also
// declare their web-UI options as a generic field schema so the frontend can
// render a form for any module without bespoke code. Drop a new module into the
// registry and it becomes a selectable scheduling mode.
import type { PlayoutDoc } from "../yaml.js";

/** Show a field only when another field in the same group equals a value. */
export interface ShowIf { key: string; equals: string | string[]; }

/** A single web-UI form field a module exposes. The frontend renders these. */
export type Field =
  | { type: "text" | "textarea" | "query"; key: string; label: string; help?: string; placeholder?: string; default?: string; showIf?: ShowIf }
  | { type: "number"; key: string; label: string; help?: string; default?: number; min?: number; max?: number; showIf?: ShowIf }
  | { type: "select"; key: string; label: string; help?: string; options: { value: string; label: string }[]; default?: string; showIf?: ShowIf }
  | { type: "checkbox"; key: string; label: string; help?: string; default?: boolean; showIf?: ShowIf }
  // a dropdown of the user's collections (value is "<type>::<name>")
  | { type: "collection"; key: string; label: string; help?: string; showIf?: ShowIf }
  | { type: "overlays"; key: string; label: string; help?: string; showIf?: ShowIf }
  // a multi-select of the user's local libraries (value is a string[] of names)
  | { type: "libraries"; key: string; label: string; help?: string; showIf?: ShowIf }
  // tick-boxes of the tags found in the filler the sibling fields pick (value is a string[]):
  // `libraries` / `collection` name those sibling keys (the collection wins when set)
  | { type: "tags"; key: string; label: string; help?: string; libraries?: string; collection?: string; showIf?: ShowIf }
  // a dropdown of the other channels (value is the channel name)
  | { type: "channel"; key: string; label: string; help?: string; showIf?: ShowIf }
  // a repeatable group of fields (e.g. the list of schedule blocks)
  | { type: "list"; key: string; label: string; help?: string; addLabel?: string; itemTitle?: string; fields: Field[]; showIf?: ShowIf };

export interface ModuleSummary { valid: boolean; error?: string; [k: string]: any; }

export interface SchedulingModule {
  id: string;
  label: string;
  description: string;
  editor: "yaml" | "form" | "pods" | "grid"; // how the UI edits this channel's config
  fileExts: string[];             // config file extensions this module owns
  saveExt: string;                // extension used when creating a channel of this mode
  defaultConfig(): string;        // initial raw config for a new channel
  schema?(): Field[];             // form fields (editor === "form")
  compile(raw: string): PlayoutDoc;
  summarize(raw: string): ModuleSummary;
}
