// Shared bits for channel-level presentation options the form modules offer:
// a station ID at the top of the hour, and era-matched commercials.
import type { ContentDef } from "../yaml.js";
import type { Field } from "./module.js";
import { parseCollectionRef } from "../collection-ref.js";

export interface StationOptions { stationIdSource?: "search" | "collection"; stationId?: string; matchEra?: boolean }

/** The station-ID content def (key STATION_ID), or null when none is set. */
export function stationIdContent(o: StationOptions): ContentDef | null {
  if (!o.stationId) return null;
  if (o.stationIdSource === "search") return { key: "STATION_ID", kind: "search", order: "shuffle", query: o.stationId, raw: {} };
  const { type, name } = parseCollectionRef(o.stationId);
  const kind = type === "smart" ? "smart_collection" : type === "multi" ? "multi_collection" : type === "playlist" ? "playlist" : "collection";
  return { key: "STATION_ID", kind, order: "shuffle", collection: type === "playlist" ? undefined : name, playlist: type === "playlist" ? name : undefined, raw: {} };
}

export const STATION_FIELDS: Field[] = [
  { type: "checkbox", key: "matchEra", label: "Match commercials to the show's era", help: "Breaks use commercials from within a few years of the show airing (by year in the file name or metadata), so 90s shows get 90s ads." },
  { type: "select", key: "stationIdSource", label: "Station ID before the top of the hour", options: [{ value: "collection", label: "From a collection" }, { value: "search", label: "From a search query" }], default: "collection" },
  { type: "collection", key: "stationId", label: "Station ID collection (blank = none)", help: "A short ident (under a minute) that ends exactly on the hour whenever a show's padding reaches it.", showIf: { key: "stationIdSource", equals: "collection" } },
  { type: "query", key: "stationId", label: "Station ID search (blank = none)", placeholder: 'library_name:"Station IDs"', showIf: { key: "stationIdSource", equals: "search" } },
];
