// A collection reference that carries its type, encoded as "<type>::<name>" so a
// single dropdown value expresses both. Legacy values without a "<type>::" prefix
// are treated as a manual collection name (backward compatible).

export const COLLECTION_KINDS = ["collection", "smart", "multi", "playlist"] as const;
export type CollKind = typeof COLLECTION_KINDS[number];

export const COLLECTION_LABEL: Record<CollKind, string> = {
  collection: "manual", smart: "smart", multi: "multi", playlist: "playlist",
};

/** Parse a collection reference value into its type + name. */
export function parseCollectionRef(value: string): { type: CollKind; name: string } {
  const s = value ?? "";
  const i = s.indexOf("::");
  if (i > 0) {
    const t = s.slice(0, i) as CollKind;
    if ((COLLECTION_KINDS as readonly string[]).includes(t)) return { type: t, name: s.slice(i + 2) };
  }
  return { type: "collection", name: s };
}

/** Build a "<type>::<name>" reference value. */
export function makeCollectionRef(type: CollKind, name: string): string { return `${type}::${name}`; }

/** The YAML content-def key that resolves each collection type. */
export function collectionContentField(type: CollKind): "collection" | "smart_collection" | "multi_collection" | "playlist" {
  return type === "smart" ? "smart_collection" : type === "multi" ? "multi_collection" : type === "playlist" ? "playlist" : "collection";
}
