// App-wide page navigation, so any screen can link to another page without
// threading callbacks through props. App listens for the event and switches.
export type Page = "dashboard" | "library" | "browse" | "collections" | "channels" | "overlays" | "pods" | "build" | "preview" | "streaming" | "settings" | "logs" | "troubleshoot";

export const NAV_GROUPS: { label: string; items: { id: Page; label: string; icon: string }[] }[] = [
  { label: "", items: [{ id: "dashboard", label: "Dashboard", icon: "⌂" }] },
  { label: "Media", items: [{ id: "library", label: "Library", icon: "▤" }, { id: "browse", label: "Browse", icon: "▦" }, { id: "collections", label: "Collections", icon: "❏" }] },
  { label: "Programming", items: [{ id: "channels", label: "Channels", icon: "☰" }, { id: "overlays", label: "Overlays", icon: "◩" }, { id: "pods", label: "Pods", icon: "◫" }] },
  { label: "Output", items: [{ id: "build", label: "Build", icon: "⟳" }, { id: "preview", label: "Preview", icon: "▶" }, { id: "streaming", label: "Streaming", icon: "◉" }] },
  { label: "System", items: [{ id: "settings", label: "Settings", icon: "⚙" }, { id: "logs", label: "Logs", icon: "≡" }, { id: "troubleshoot", label: "Troubleshooting", icon: "✚" }] },
];
export const PAGES: Page[] = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id));
/** old URLs that moved, so bookmarks keep working */
export const PAGE_ALIASES: Record<string, Page> = { connect: "settings" };

/** go to a page; `params` become the query string (e.g. which channel Preview opens) */
export const navigate = (page: Page | string, params?: Record<string, string>) =>
  window.dispatchEvent(new CustomEvent("tvn:navigate", { detail: { page, search: params ? `?${new URLSearchParams(params)}` : "" } }));
