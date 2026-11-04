// -----------------------------------------------------------------------------
// A Scriban-compatible template engine, for ErsatzTV legacy graphics elements.
// -----------------------------------------------------------------------------
// Legacy graphics element files (image/, text/, motion/… under
// templates/graphics-elements) are Scriban templates that ErsatzTV fills in for
// each item before reading them as YAML. This implements the part of Scriban
// those files use, with Scriban's own rules:
//   - text with {{ code }} blocks ({{- / -}} and {{~ / ~}} trim whitespace)
//   - statements: assignment (a = 1, a.b = 1), if / else if / else / end,
//     for x in list … end (for.index, for.first, for.last…), while … end,
//     capture x … end, break / continue, # comments
//   - expressions: literals, variables, member and index access (Epg[1].Title),
//     + - * / // % (strings concatenate), == != < > <= >=, && || !, ?? , ranges
//     (1..3, 1..<3), function calls with spaced arguments (string.replace x "a" "b"),
//     with parentheses (string.upcase(x)), and pipes (x | string.strip)
//   - the built-in objects string, array, math, date, timespan, object, regex
//   - ErsatzTV's own functions: convert_timezone, format_datetime,
//     get_directory_name, get_filename_without_extension
// Values: strings, numbers, booleans, null, arrays, plain objects, and the .NET
// types the variables use — DateTimeOffset (TemplateDate, with its time zone) and
// TimeSpan (TemplateSpan) — whose members read like .NET (Start.Hour, Duration.TotalSeconds).

// ---- .NET-like values ------------------------------------------------------------
const WINDOWS_TZ: Record<string, string> = {
  "eastern standard time": "America/New_York", "central standard time": "America/Chicago", "mountain standard time": "America/Denver",
  "us mountain standard time": "America/Phoenix", "pacific standard time": "America/Los_Angeles", "alaskan standard time": "America/Anchorage",
  "hawaiian standard time": "Pacific/Honolulu", "atlantic standard time": "America/Halifax", "newfoundland standard time": "America/St_Johns",
  "gmt standard time": "Europe/London", "greenwich standard time": "Atlantic/Reykjavik", "w. europe standard time": "Europe/Berlin",
  "central europe standard time": "Europe/Budapest", "romance standard time": "Europe/Paris", "e. europe standard time": "Europe/Chisinau",
  "aus eastern standard time": "Australia/Sydney", "tokyo standard time": "Asia/Tokyo", "utc": "UTC", "coordinated universal time": "UTC",
};
/** An IANA time zone for a .NET / Windows or IANA name ("" if unknown). */
export function ianaZone(id: string): string {
  const s = String(id ?? "").trim();
  if (!s) return "";
  const w = WINDOWS_TZ[s.toLowerCase()];
  if (w) return w;
  try { new Intl.DateTimeFormat("en-US", { timeZone: s }); return s; } catch { return ""; }
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** A DateTimeOffset: an instant, shown in a time zone (IANA, or a fixed offset in minutes). */
export class TemplateDate {
  constructor(readonly ms: number, readonly zone: string | number = "UTC") {}
  /** wall-clock parts in this date's zone */
  parts() {
    if (typeof this.zone === "number") {
      const d = new Date(this.ms + this.zone * 60_000);
      return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), wd: d.getUTCDay(), off: this.zone };
    }
    const f = new Intl.DateTimeFormat("en-US", { timeZone: this.zone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", weekday: "short", hourCycle: "h23" });
    const p: Record<string, string> = {};
    for (const x of f.formatToParts(new Date(this.ms))) p[x.type] = x.value;
    const y = +p.year, mo = +p.month, d = +p.day, h = +p.hour % 24, mi = +p.minute, s = +p.second;
    const off = Math.round((Date.UTC(y, mo - 1, d, h, mi, s) - Math.floor(this.ms / 1000) * 1000) / 60_000);
    return { y, mo, d, h, mi, s, wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday), off };
  }
  get Year() { return this.parts().y; }
  get Month() { return this.parts().mo; }
  get Day() { return this.parts().d; }
  get Hour() { return this.parts().h; }
  get Minute() { return this.parts().mi; }
  get Second() { return this.parts().s; }
  get Millisecond() { return ((this.ms % 1000) + 1000) % 1000; }
  get DayOfWeek() { return WEEKDAYS[this.parts().wd]; }
  get DayOfYear() { const p = this.parts(); return Math.round((Date.UTC(p.y, p.mo - 1, p.d) - Date.UTC(p.y, 0, 1)) / 86_400_000) + 1; }
  get TimeOfDay() { const p = this.parts(); return new TemplateSpan(((p.h * 60 + p.mi) * 60 + p.s) * 1000 + this.Millisecond); }
  get Offset() { return new TemplateSpan(this.parts().off * 60_000); }
  get Date() { const p = this.parts(); return new TemplateDate(this.ms - (((p.h * 60 + p.mi) * 60 + p.s) * 1000 + this.Millisecond), this.zone); }
  get DateTime() { return this; }
  get LocalDateTime() { return this; }
  get UtcDateTime() { return new TemplateDate(this.ms, "UTC"); }
  get Ticks() { return (this.ms + 62_135_596_800_000) * 10_000; }
  toString() { return formatNetDate(this, "G") + " " + formatNetDate(this, "zzz"); }
}

/** A TimeSpan. */
export class TemplateSpan {
  constructor(readonly ms: number) {}
  get TotalMilliseconds() { return this.ms; }
  get TotalSeconds() { return this.ms / 1000; }
  get TotalMinutes() { return this.ms / 60_000; }
  get TotalHours() { return this.ms / 3_600_000; }
  get TotalDays() { return this.ms / 86_400_000; }
  get Days() { return Math.trunc(this.ms / 86_400_000); }
  get Hours() { return Math.trunc(this.ms / 3_600_000) % 24; }
  get Minutes() { return Math.trunc(this.ms / 60_000) % 60; }
  get Seconds() { return Math.trunc(this.ms / 1000) % 60; }
  get Milliseconds() { return Math.trunc(this.ms) % 1000; }
  toString() {
    const a = Math.abs(this.ms), p2 = (n: number) => String(n).padStart(2, "0");
    const d = Math.floor(a / 86_400_000), h = Math.floor(a / 3_600_000) % 24, m = Math.floor(a / 60_000) % 60, s = Math.floor(a / 1000) % 60, f = Math.round(a % 1000);
    return `${this.ms < 0 ? "-" : ""}${d ? `${d}.` : ""}${p2(h)}:${p2(m)}:${p2(s)}${f ? `.${String(f).padStart(3, "0")}0000` : ""}`;
  }
}

/** .NET custom / standard date format strings ("h:mm tt", "yyyy-MM-dd", "t", "D"…). */
export function formatNetDate(dt: TemplateDate, fmt: string): string {
  const std: Record<string, string> = { d: "M/d/yyyy", D: "dddd, MMMM d, yyyy", t: "h:mm tt", T: "h:mm:ss tt", f: "dddd, MMMM d, yyyy h:mm tt", F: "dddd, MMMM d, yyyy h:mm:ss tt",
    g: "M/d/yyyy h:mm tt", G: "M/d/yyyy h:mm:ss tt", M: "MMMM d", m: "MMMM d", Y: "MMMM yyyy", y: "MMMM yyyy", s: "yyyy'-'MM'-'dd'T'HH':'mm':'ss", u: "yyyy'-'MM'-'dd HH':'mm':'ss'Z'", o: "yyyy'-'MM'-'dd'T'HH':'mm':'ss.fffffffzzz", O: "yyyy'-'MM'-'dd'T'HH':'mm':'ss.fffffffzzz" };
  if (!fmt) fmt = "G";
  if (fmt.length === 1 && std[fmt]) { if (fmt === "u") dt = new TemplateDate(dt.ms, "UTC"); fmt = std[fmt]; }
  const p = dt.parts();
  const p2 = (n: number) => String(n).padStart(2, "0");
  const h12 = p.h % 12 || 12;
  const off = p.off, sign = off < 0 ? "-" : "+", oh = Math.floor(Math.abs(off) / 60), om = Math.abs(off) % 60;
  let out = "";
  for (let i = 0; i < fmt.length;) {
    const c = fmt[i];
    if (c === "'" || c === '"') { const j = fmt.indexOf(c, i + 1); out += fmt.slice(i + 1, j < 0 ? undefined : j); i = j < 0 ? fmt.length : j + 1; continue; }
    if (c === "\\") { out += fmt[i + 1] ?? ""; i += 2; continue; }
    if (c === "%" && fmt.length > 1) { i++; continue; }
    let n = 1; while (fmt[i + n] === c) n++;
    const run = (v: string) => { out += v; i += n; };
    switch (c) {
      case "y": run(n <= 1 ? String(p.y % 100) : n === 2 ? p2(p.y % 100) : String(p.y).padStart(n, "0")); break;
      case "M": run(n >= 4 ? MONTHS[p.mo - 1] : n === 3 ? MONTHS[p.mo - 1].slice(0, 3) : n === 2 ? p2(p.mo) : String(p.mo)); break;
      case "d": run(n >= 4 ? WEEKDAYS[p.wd] : n === 3 ? WEEKDAYS[p.wd].slice(0, 3) : n === 2 ? p2(p.d) : String(p.d)); break;
      case "H": run(n >= 2 ? p2(p.h) : String(p.h)); break;
      case "h": run(n >= 2 ? p2(h12) : String(h12)); break;
      case "m": run(n >= 2 ? p2(p.mi) : String(p.mi)); break;
      case "s": run(n >= 2 ? p2(p.s) : String(p.s)); break;
      case "f": case "F": run(String(dt.Millisecond).padStart(3, "0").padEnd(n, "0").slice(0, n)); break;
      case "t": run(n >= 2 ? (p.h < 12 ? "AM" : "PM") : (p.h < 12 ? "A" : "P")); break;
      case "z": run(n >= 3 ? `${sign}${p2(oh)}:${p2(om)}` : n === 2 ? `${sign}${p2(oh)}` : `${sign}${oh}`); break;
      case "K": run(`${sign}${p2(oh)}:${p2(om)}`); break;
      case "g": run("A.D."); break;
      default: out += c.repeat(n); i += n;
    }
  }
  return out;
}

/** strftime-style formats (Scriban's date.to_string). */
function strftime(dt: TemplateDate, fmt: string): string {
  const p = dt.parts(), p2 = (n: number) => String(n).padStart(2, "0");
  const map: Record<string, () => string> = {
    a: () => WEEKDAYS[p.wd].slice(0, 3), A: () => WEEKDAYS[p.wd], b: () => MONTHS[p.mo - 1].slice(0, 3), B: () => MONTHS[p.mo - 1],
    c: () => formatNetDate(dt, "ddd MMM d HH:mm:ss yyyy"), C: () => p2(Math.floor(p.y / 100)), d: () => p2(p.d), D: () => formatNetDate(dt, "MM/dd/yy"),
    e: () => String(p.d).padStart(2, " "), F: () => formatNetDate(dt, "yyyy-MM-dd"), h: () => MONTHS[p.mo - 1].slice(0, 3), H: () => p2(p.h),
    I: () => p2(p.h % 12 || 12), j: () => String(dt.DayOfYear).padStart(3, "0"), k: () => String(p.h).padStart(2, " "), l: () => String(p.h % 12 || 12).padStart(2, " "),
    L: () => String(dt.Millisecond).padStart(3, "0"), m: () => p2(p.mo), M: () => p2(p.mi), n: () => "\n", N: () => String(dt.Millisecond).padStart(3, "0") + "000000",
    p: () => (p.h < 12 ? "AM" : "PM"), P: () => (p.h < 12 ? "am" : "pm"), r: () => formatNetDate(dt, "hh:mm:ss tt"), R: () => formatNetDate(dt, "HH:mm"),
    s: () => String(Math.floor(dt.ms / 1000)), S: () => p2(p.s), t: () => "\t", T: () => formatNetDate(dt, "HH:mm:ss"), u: () => String(p.wd || 7), w: () => String(p.wd),
    x: () => formatNetDate(dt, "MM/dd/yy"), X: () => formatNetDate(dt, "HH:mm:ss"), y: () => p2(p.y % 100), Y: () => String(p.y), Z: () => formatNetDate(dt, "zzz"), z: () => formatNetDate(dt, "zzz").replace(":", ""), "%": () => "%",
  };
  return fmt.replace(/%([a-zA-Z%])/g, (m, k: string) => (map[k] ? map[k]() : m));
}

// ---- tokens ----------------------------------------------------------------------
type Tok =
  | { t: "num"; v: number; ws: boolean }
  | { t: "str"; v: string; ws: boolean }
  | { t: "id"; v: string; ws: boolean }
  | { t: "op"; v: string; ws: boolean }
  | { t: "nl"; ws: boolean }
  | { t: "text"; v: string; ws: boolean }
  | { t: "eof"; ws: boolean };

const OPS = ["..<", "..", "==", "!=", "<=", ">=", "&&", "||", "??", "//", "+", "-", "*", "/", "%", "<", ">", "!", "=", "|", "(", ")", "[", "]", "{", "}", ",", ".", ":", "?", ";"];

export class TemplateError extends Error {}

function lexCode(src: string, out: Tok[]) {
  let i = 0;
  let ws = true;
  while (i < src.length) {
    const c = src[i];
    if (c === "\n") { out.push({ t: "nl", ws }); i++; ws = true; continue; }
    if (/\s/.test(c)) { i++; ws = true; continue; }
    if (c === "#") { // comment to end of line ("##" … "##" block comments too)
      if (src.startsWith("##", i)) { const j = src.indexOf("##", i + 2); i = j < 0 ? src.length : j + 2; continue; }
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i; while (j < src.length && /[0-9_]/.test(src[j])) j++;
      if (src[j] === "." && /[0-9]/.test(src[j + 1] ?? "")) { j++; while (j < src.length && /[0-9]/.test(src[j])) j++; }
      if (/[eE]/.test(src[j] ?? "") && /[0-9+-]/.test(src[j + 1] ?? "")) { j += 2; while (j < src.length && /[0-9]/.test(src[j])) j++; }
      out.push({ t: "num", v: Number(src.slice(i, j).replace(/_/g, "")), ws }); i = j; ws = false; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1, s = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\" && j + 1 < src.length) {
          const e = src[j + 1];
          s += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e === "0" ? "\0" : e === "b" ? "\b" : e === "f" ? "\f" : e === "u" ? String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)) : e;
          j += e === "u" ? 6 : 2;
        } else s += src[j++];
      }
      out.push({ t: "str", v: s, ws }); i = j + 1; ws = false; continue;
    }
    if (c === "`") { const j = src.indexOf("`", i + 1); out.push({ t: "str", v: src.slice(i + 1, j < 0 ? undefined : j), ws }); i = j < 0 ? src.length : j + 1; ws = false; continue; }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1; while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      out.push({ t: "id", v: src.slice(i, j), ws }); i = j; ws = false; continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new TemplateError(`unexpected character "${c}"`);
    out.push({ t: "op", v: op, ws }); i += op.length; ws = false;
  }
}

/** Template text -> tokens (text runs between code blocks are single text tokens). */
function lex(tpl: string): Tok[] {
  const out: Tok[] = [];
  let i = 0, trimNext: "" | "-" | "~" = "";
  const trimStart = (s: string, how: string) => (how === "-" ? s.replace(/^\s+/, "") : how === "~" ? s.replace(/^[ \t]*\r?\n?/, "") : s);
  while (i < tpl.length) {
    const open = tpl.indexOf("{{", i);
    let text = tpl.slice(i, open < 0 ? undefined : open);
    text = trimStart(text, trimNext);
    if (open < 0) { if (text) out.push({ t: "text", v: text, ws: false }); break; }
    let j = open + 2, lead: "" | "-" | "~" = "";
    if (tpl[j] === "-" || tpl[j] === "~") { lead = tpl[j] as "-" | "~"; j++; }
    if (lead === "-") text = text.replace(/\s+$/, "");
    else if (lead === "~") text = text.replace(/[ \t]*$/, "");
    if (text) out.push({ t: "text", v: text, ws: false });
    // the block's end, skipping }} inside strings
    let k = j, q = "";
    for (; k < tpl.length; k++) {
      const ch = tpl[k];
      if (q) { if (ch === "\\") k++; else if (ch === q) q = ""; continue; }
      if (ch === '"' || ch === "'" || ch === "`") { q = ch; continue; }
      if (ch === "}" && tpl[k + 1] === "}") break;
    }
    if (k >= tpl.length) throw new TemplateError("a {{ block isn't closed with }}");
    let code = tpl.slice(j, k);
    trimNext = "";
    if (code.endsWith("-") || code.endsWith("~")) { trimNext = code.slice(-1) as "-" | "~"; code = code.slice(0, -1); }
    lexCode(code, out);
    out.push({ t: "nl", ws: true });
    i = k + 2;
  }
  out.push({ t: "eof", ws: true });
  return out;
}

// ---- syntax tree --------------------------------------------------------------------
type Expr =
  | { k: "lit"; v: unknown }
  | { k: "var"; name: string }
  | { k: "member"; obj: Expr; name: string }
  | { k: "index"; obj: Expr; idx: Expr }
  | { k: "call"; fn: Expr; args: Expr[] }
  | { k: "pipe"; left: Expr; fn: Expr; args: Expr[] }
  | { k: "bin"; op: string; a: Expr; b: Expr }
  | { k: "un"; op: string; a: Expr }
  | { k: "cond"; c: Expr; a: Expr; b: Expr }
  | { k: "array"; items: Expr[] }
  | { k: "object"; entries: [string, Expr][] };
type Stmt =
  | { k: "text"; v: string }
  | { k: "out"; e: Expr }
  | { k: "assign"; target: Expr; e: Expr }
  | { k: "if"; branches: { c: Expr | null; body: Stmt[] }[] }
  | { k: "for"; name: string; list: Expr; body: Stmt[]; limit?: Expr; offset?: Expr; reversed?: boolean }
  | { k: "while"; c: Expr; body: Stmt[] }
  | { k: "capture"; target: Expr; body: Stmt[] }
  | { k: "break" } | { k: "continue" };

class Parser {
  private i = 0;
  constructor(private toks: Tok[]) {}
  private peek(o = 0) { return this.toks[Math.min(this.i + o, this.toks.length - 1)]; }
  private next() { return this.toks[this.i++]; }
  private isOp(v: string, o = 0) { const t = this.peek(o); return t.t === "op" && t.v === v; }
  private isId(v: string, o = 0) { const t = this.peek(o); return t.t === "id" && t.v === v; }
  private expectOp(v: string) { if (!this.isOp(v)) throw new TemplateError(`expected "${v}"`); this.next(); }
  private atStmtEnd() { const t = this.peek(); return t.t === "nl" || t.t === "eof" || t.t === "text" || (t.t === "op" && t.v === ";"); }

  program(): Stmt[] { const s = this.block([]); if (this.peek().t !== "eof") throw new TemplateError(`unexpected "${(this.peek() as any).v}"`); return s; }

  private block(stops: string[]): Stmt[] {
    const out: Stmt[] = [];
    for (;;) {
      const t = this.peek();
      if (t.t === "eof") return out;
      if (t.t === "text") { this.next(); out.push({ k: "text", v: t.v }); continue; }
      if (t.t === "nl" || (t.t === "op" && t.v === ";")) { this.next(); continue; }
      if (t.t === "id" && stops.includes(t.v)) return out;
      out.push(this.statement());
    }
  }

  private statement(): Stmt {
    const t = this.peek();
    if (t.t === "id") {
      switch (t.v) {
        case "if": { this.next(); return this.ifRest(); }
        case "for": {
          this.next();
          const nt = this.next();
          if (nt.t !== "id") throw new TemplateError("for needs a variable name");
          if (!this.isId("in")) throw new TemplateError("for needs 'in'");
          this.next();
          const list = this.expr();
          const s: Stmt = { k: "for", name: nt.v, list, body: [] };
          while (this.peek().t === "id" && ["limit", "offset", "reversed"].includes((this.peek() as any).v)) {
            const p = (this.next() as any).v as string;
            if (p === "reversed") (s as any).reversed = true;
            else { this.expectOp(":"); (s as any)[p] = this.unary(); }
          }
          s.body = this.block(["end", "else"]);
          if (this.isId("else")) { this.next(); this.block(["end"]); } // for … else: not used by elements
          this.endKw();
          return s;
        }
        case "while": { this.next(); const c = this.expr(); const body = this.block(["end"]); this.endKw(); return { k: "while", c, body }; }
        case "capture": { this.next(); const target = this.postfix(); const body = this.block(["end"]); this.endKw(); return { k: "capture", target, body }; }
        case "break": this.next(); return { k: "break" };
        case "continue": this.next(); return { k: "continue" };
        case "end": case "else": throw new TemplateError(`"${t.v}" without a matching if / for`);
        case "func": case "wrap": case "with": case "case": case "tablerow": throw new TemplateError(`"${t.v}" isn't supported in graphics elements here`);
      }
    }
    // assignment?
    const save = this.i;
    if (t.t === "id") {
      try {
        const target = this.postfix(false);
        if (this.isOp("=") ) { this.next(); return { k: "assign", target, e: this.expr() }; }
      } catch { /* not an assignment */ }
      this.i = save;
    }
    return { k: "out", e: this.expr() };
  }
  private endKw() { if (!this.isId("end")) throw new TemplateError('missing "end"'); this.next(); }
  private ifRest(): Stmt {
    const branches: { c: Expr | null; body: Stmt[] }[] = [];
    let c: Expr | null = this.expr();
    for (;;) {
      const body = this.block(["else", "end"]);
      branches.push({ c, body });
      if (this.isId("end")) { this.next(); break; }
      if (!this.isId("else")) throw new TemplateError('missing "end" after if');
      this.next();
      if (this.isId("if")) { this.next(); c = this.expr(); continue; }
      const last = this.block(["end"]);
      branches.push({ c: null, body: last });
      this.endKw();
      break;
    }
    return { k: "if", branches };
  }

  // expression, lowest precedence first
  expr(): Expr {
    let e = this.ternary();
    while (this.isOp("|")) {
      this.next();
      const fn = this.postfix(false);
      e = { k: "pipe", left: e, fn, args: this.spacedArgs() };
    }
    return e;
  }
  private ternary(): Expr {
    const c = this.coalesce();
    if (this.isOp("?")) { this.next(); const a = this.coalesce(); this.expectOp(":"); const b = this.coalesce(); return { k: "cond", c, a, b }; }
    return c;
  }
  private bin(next: () => Expr, ops: string[], words: Record<string, string> = {}): Expr {
    let a = next.call(this);
    for (;;) {
      const t = this.peek();
      const op = t.t === "op" && ops.includes(t.v) ? t.v : t.t === "id" && words[t.v] ? words[t.v] : null;
      if (!op) return a;
      this.next();
      a = { k: "bin", op, a, b: next.call(this) };
    }
  }
  private coalesce(): Expr { return this.bin(this.or, ["??"]); }
  private or(): Expr { return this.bin(this.and, ["||"], { or: "||" }); }
  private and(): Expr { return this.bin(this.equality, ["&&"], { and: "&&" }); }
  private equality(): Expr { return this.bin(this.compare, ["==", "!="]); }
  private compare(): Expr { return this.bin(this.range, ["<", ">", "<=", ">="]); }
  private range(): Expr { return this.bin(this.additive, ["..", "..<"]); }
  private additive(): Expr { return this.bin(this.mult, ["+", "-"]); }
  private mult(): Expr { return this.bin(this.unary, ["*", "/", "//", "%"]); }
  private unary(): Expr {
    if (this.isOp("!") || this.isOp("-") || this.isOp("+")) { const op = (this.next() as any).v; return { k: "un", op, a: this.unary() }; }
    if (this.isId("not")) { this.next(); return { k: "un", op: "!", a: this.unary() }; }
    return this.call();
  }
  /** a value, then — when it's followed by spaced arguments — a call */
  private call(): Expr {
    const e = this.postfix(true);
    if ((e.k === "var" || e.k === "member") && this.startsArg()) return { k: "call", fn: e, args: this.spacedArgs() };
    return e;
  }
  private startsArg(): boolean {
    const t = this.peek();
    if (!t.ws) return false;
    if (t.t === "num" || t.t === "str") return true;
    if (t.t === "id") return !["and", "or", "not", "in", "end", "else", "limit", "offset", "reversed"].includes(t.v);
    if (t.t === "op") return t.v === "(" || t.v === "[" || (t.v === "-" && (this.peek(1).t === "num") && !this.peek(1).ws);
    return false;
  }
  private spacedArgs(): Expr[] {
    const args: Expr[] = [];
    while (!this.atStmtEnd() && this.startsArgLoose()) {
      if (this.isOp("-")) { this.next(); args.push({ k: "un", op: "-", a: this.postfix(true) }); }
      else args.push(this.postfix(true));
    }
    return args;
  }
  private startsArgLoose(): boolean {
    const t = this.peek();
    if (t.t === "num" || t.t === "str") return true;
    if (t.t === "id") return !["and", "or", "not", "end", "else"].includes(t.v);
    if (t.t === "op") return t.v === "(" || t.v === "[" || (t.v === "-" && this.peek(1).t === "num");
    return false;
  }
  private postfix(allowCallParens = true): Expr {
    let e = this.primary();
    for (;;) {
      if (this.isOp(".") && this.peek(1).t === "id") { this.next(); e = { k: "member", obj: e, name: (this.next() as any).v }; continue; }
      if (this.isOp("[") && !this.peek().ws) { this.next(); const idx = this.expr(); this.expectOp("]"); e = { k: "index", obj: e, idx }; continue; }
      if (allowCallParens && this.isOp("(") && !this.peek().ws && (e.k === "var" || e.k === "member")) {
        this.next();
        const args: Expr[] = [];
        while (!this.isOp(")")) { args.push(this.expr()); if (this.isOp(",")) this.next(); else break; }
        this.expectOp(")");
        e = { k: "call", fn: e, args };
        continue;
      }
      return e;
    }
  }
  private primary(): Expr {
    const t = this.next();
    switch (t.t) {
      case "num": return { k: "lit", v: t.v };
      case "str": return { k: "lit", v: t.v };
      case "id":
        if (t.v === "true") return { k: "lit", v: true };
        if (t.v === "false") return { k: "lit", v: false };
        if (t.v === "null" || t.v === "nil") return { k: "lit", v: null };
        return { k: "var", name: t.v };
      case "op":
        if (t.v === "(") { const e = this.expr(); this.expectOp(")"); return e; }
        if (t.v === "[") { const items: Expr[] = []; while (!this.isOp("]")) { items.push(this.expr()); if (this.isOp(",")) this.next(); else break; } this.expectOp("]"); return { k: "array", items }; }
        if (t.v === "{") {
          const entries: [string, Expr][] = [];
          while (!this.isOp("}")) {
            while (this.peek().t === "nl") this.next();
            if (this.isOp("}")) break;
            const kt = this.next(); const key = kt.t === "id" || kt.t === "str" ? String(kt.v) : "";
            this.expectOp(":"); entries.push([key, this.expr()]);
            while (this.peek().t === "nl") this.next();
            if (this.isOp(",")) this.next();
          }
          this.expectOp("}");
          return { k: "object", entries };
        }
    }
    throw new TemplateError(`unexpected ${t.t === "nl" || t.t === "eof" ? "end of line" : `"${(t as any).v}"`}`);
  }
}

// ---- evaluation -----------------------------------------------------------------------
type Fn = ((...args: any[]) => unknown) & { __tpl?: true };
const fn = (f: (...args: any[]) => unknown): Fn => Object.assign(f, { __tpl: true as const });
const isFn = (v: unknown): v is Fn => typeof v === "function";

export function toText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isFinite(v) ? (Number.isInteger(v) ? String(v) : String(Math.round(v * 1e12) / 1e12)) : String(v);
  if (Array.isArray(v)) return `[${v.map((x) => (typeof x === "string" ? `"${x}"` : toText(x))).join(", ")}]`;
  if (v instanceof TemplateDate || v instanceof TemplateSpan) return v.toString();
  if (typeof v === "object") return `{${Object.entries(v as object).map(([k, x]) => `${k}: ${toText(x)}`).join(", ")}}`;
  return String(v);
}
const truthy = (v: unknown) => !(v == null || v === false);
const num = (v: unknown) => { if (typeof v === "number") return v; if (typeof v === "boolean") return v ? 1 : 0; if (v instanceof TemplateSpan) return v.ms; const n = Number(String(v ?? "").trim()); return Number.isFinite(n) ? n : 0; };
const str = (v: unknown) => toText(v);
const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null ? [] : typeof v === "string" ? [...v] : typeof v === "object" && Symbol.iterator in (v as object) ? [...(v as Iterable<unknown>)] : [v]);
const regexOpts = (o?: unknown) => { const s = String(o ?? ""); return (s.includes("i") ? "i" : "") + (s.includes("m") ? "m" : "") + (s.includes("s") ? "s" : ""); };
const netRegex = (p: unknown) => String(p ?? "").replace(/\(\?<([A-Za-z_]\w*)>/g, "(?<$1>");

const BUILTINS: Record<string, Record<string, Fn>> = {
  string: {
    append: fn((t, w) => str(t) + str(w)), prepend: fn((t, b) => str(b) + str(t)),
    capitalize: fn((t) => { const s = str(t); return s.charAt(0).toUpperCase() + s.slice(1); }),
    capitalizewords: fn((t) => str(t).replace(/(^|\s)(\S)/g, (_, a, b) => a + b.toUpperCase())),
    contains: fn((t, v) => str(t).includes(str(v))), empty: fn((t) => str(t) === ""), whitespace: fn((t) => str(t).trim() === ""),
    starts_with: fn((t, v) => str(t).startsWith(str(v))), ends_with: fn((t, v) => str(t).endsWith(str(v))),
    downcase: fn((t) => str(t).toLowerCase()), upcase: fn((t) => str(t).toUpperCase()),
    handleize: fn((t) => str(t).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")),
    lstrip: fn((t) => str(t).replace(/^\s+/, "")), rstrip: fn((t) => str(t).replace(/\s+$/, "")), strip: fn((t) => str(t).trim()),
    strip_newlines: fn((t) => str(t).replace(/\r?\n/g, "")),
    pad_left: fn((t, w) => str(t).padStart(num(w))), pad_right: fn((t, w) => str(t).padEnd(num(w))),
    remove: fn((t, r) => str(t).split(str(r)).join("")), remove_first: fn((t, r) => str(t).replace(str(r), "")),
    remove_last: fn((t, r) => { const s = str(t), x = str(r), i = s.lastIndexOf(x); return i < 0 || !x ? s : s.slice(0, i) + s.slice(i + x.length); }),
    replace: fn((t, m, r) => { const s = str(t), x = str(m); return x ? s.split(x).join(str(r)) : s; }),
    replace_first: fn((t, m, r) => str(t).replace(str(m), () => str(r))),
    size: fn((t) => str(t).length), slice: fn((t, s, l) => { const x = str(t); const st = num(s) < 0 ? x.length + num(s) : num(s); return l == null ? x.slice(st) : x.substr(st, num(l)); }),
    slice1: fn((t, s, l) => { const x = str(t); const st = num(s) < 0 ? x.length + num(s) : num(s); return x.substr(st, l == null ? 1 : num(l)); }),
    split: fn((t, sep) => str(t).split(str(sep)).filter((x) => x !== "")),
    truncate: fn((t, l, e) => { const s = str(t), n = num(l), el = e == null ? "..." : str(e); return s.length <= n ? s : s.slice(0, Math.max(0, n - el.length)) + el; }),
    truncatewords: fn((t, c, e) => { const w = str(t).split(/\s+/).filter(Boolean); const n = num(c); return w.length <= n ? w.join(" ") : w.slice(0, n).join(" ") + (e == null ? "..." : str(e)); }),
    to_int: fn((t) => { const n = parseInt(str(t), 10); return Number.isFinite(n) ? n : null; }), to_long: fn((t) => { const n = parseInt(str(t), 10); return Number.isFinite(n) ? n : null; }),
    to_float: fn((t) => { const n = parseFloat(str(t)); return Number.isFinite(n) ? n : null; }), to_double: fn((t) => { const n = parseFloat(str(t)); return Number.isFinite(n) ? n : null; }),
    literal: fn((t) => JSON.stringify(str(t))), escape: fn((t) => str(t).replace(/[\\"]/g, "\\$&")),
    md5: fn(() => { throw new TemplateError("string.md5 isn't supported here"); }),
    equals_ignore_case: fn((a, b) => str(a).toLowerCase() === str(b).toLowerCase()),
    index_of: fn((t, v) => str(t).indexOf(str(v))),
  },
  array: {
    add: fn((l, v) => [...asList(l), v]), add_range: fn((l, v) => [...asList(l), ...asList(v)]), compact: fn((l) => asList(l).filter((x) => x != null)),
    concat: fn((l, v) => [...asList(l), ...asList(v)]), contains: fn((l, v) => asList(l).some((x) => x === v || str(x) === str(v))),
    first: fn((l) => asList(l)[0] ?? null), last: fn((l) => { const a = asList(l); return a[a.length - 1] ?? null; }),
    insert_at: fn((l, i, v) => { const a = [...asList(l)]; a.splice(num(i), 0, v); return a; }), remove_at: fn((l, i) => { const a = [...asList(l)]; a.splice(num(i) < 0 ? a.length + num(i) : num(i), 1); return a; }),
    join: fn((l, d) => asList(l).map(str).join(d == null ? "" : str(d))), limit: fn((l, n) => asList(l).slice(0, num(n))), offset: fn((l, n) => asList(l).slice(num(n))),
    map: fn((l, m) => asList(l).map((x) => (x != null && typeof x === "object" ? (x as any)[str(m)] : null))), reverse: fn((l) => [...asList(l)].reverse()),
    size: fn((l) => asList(l).length), sort: fn((l, m) => [...asList(l)].sort((a, b) => { const x = m == null ? a : (a as any)?.[str(m)], y = m == null ? b : (b as any)?.[str(m)]; return typeof x === "number" && typeof y === "number" ? x - y : str(x).localeCompare(str(y)); })),
    uniq: fn((l) => [...new Set(asList(l))]), cycle: fn(() => { throw new TemplateError("array.cycle isn't supported here"); }),
    filter: fn(() => { throw new TemplateError("array.filter isn't supported here"); }),
  },
  math: {
    abs: fn((v) => Math.abs(num(v))), ceil: fn((v) => Math.ceil(num(v))), floor: fn((v) => Math.floor(num(v))),
    round: fn((v, p) => { const f = 10 ** num(p ?? 0); return Math.round(num(v) * f) / f; }),
    divided_by: fn((a, b) => { const x = num(a), y = num(b); return Number.isInteger(x) && Number.isInteger(y) && typeof b === "number" && Number.isInteger(b) ? Math.trunc(x / y) : x / y; }),
    minus: fn((a, b) => num(a) - num(b)), plus: fn((a, b) => num(a) + num(b)), times: fn((a, b) => num(a) * num(b)), modulo: fn((a, b) => num(a) % num(b)),
    format: fn((v, f) => formatNetNumber(num(v), str(f))), is_number: fn((v) => typeof v === "number"),
    uuid: fn(() => crypto.randomUUID()), random: fn((a, b) => Math.floor(num(a) + Math.random() * (num(b) - num(a)))),
  },
  date: {
    now: fn(() => new TemplateDate(Date.now(), defaultZone)),
    add_days: fn((d, n) => shift(d, num(n) * 86_400_000)), add_hours: fn((d, n) => shift(d, num(n) * 3_600_000)),
    add_minutes: fn((d, n) => shift(d, num(n) * 60_000)), add_seconds: fn((d, n) => shift(d, num(n) * 1000)), add_milliseconds: fn((d, n) => shift(d, num(n))),
    add_months: fn((d, n) => addMonths(d, num(n))), add_years: fn((d, n) => addMonths(d, num(n) * 12)),
    to_string: fn((d, f) => (d instanceof TemplateDate ? strftime(d, str(f)) : "")),
    parse: fn((t) => { const ms = Date.parse(str(t)); return Number.isFinite(ms) ? new TemplateDate(ms, defaultZone) : null; }),
  },
  timespan: {
    from_days: fn((n) => new TemplateSpan(num(n) * 86_400_000)), from_hours: fn((n) => new TemplateSpan(num(n) * 3_600_000)),
    from_minutes: fn((n) => new TemplateSpan(num(n) * 60_000)), from_seconds: fn((n) => new TemplateSpan(num(n) * 1000)), from_milliseconds: fn((n) => new TemplateSpan(num(n))),
    parse: fn((t) => { const m = /^(-)?(?:(\d+)\.)?(\d+):(\d+)(?::(\d+(?:\.\d+)?))?$/.exec(str(t).trim()); if (!m) return null; const v = ((+(m[2] ?? 0) * 24 + +m[3]) * 60 + +m[4]) * 60_000 + +(m[5] ?? 0) * 1000; return new TemplateSpan(m[1] ? -v : v); }),
  },
  object: {
    default: fn((v, d) => (v == null || v === "" ? d : v)), has_key: fn((o, k) => o != null && typeof o === "object" && str(k) in (o as object)),
    has_value: fn((o, k) => o != null && typeof o === "object" && (o as any)[str(k)] != null), keys: fn((o) => (o && typeof o === "object" ? Object.keys(o) : [])),
    values: fn((o) => (o && typeof o === "object" ? Object.values(o) : [])), size: fn((o) => (o == null ? 0 : typeof o === "string" || Array.isArray(o) ? (o as any).length : Object.keys(o as object).length)),
    typeof: fn((o) => (o == null ? null : typeof o === "string" ? "string" : typeof o === "boolean" ? "boolean" : typeof o === "number" ? (Number.isInteger(o) ? "number" : "number") : Array.isArray(o) ? "array" : o instanceof TemplateDate ? "datetime" : o instanceof TemplateSpan ? "timespan" : "object")),
    format: fn((v, f) => (typeof v === "number" ? formatNetNumber(v, str(f)) : v instanceof TemplateDate ? formatNetDate(v, str(f)) : str(v))),
  },
  regex: {
    escape: fn((t) => str(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    match: fn((t, p, o) => { const m = new RegExp(netRegex(p), regexOpts(o)).exec(str(t)); return m ? [...m].map((x) => x ?? "") : []; }),
    matches: fn((t, p, o) => [...str(t).matchAll(new RegExp(netRegex(p), regexOpts(o) + "g"))].map((m) => [...m].map((x) => x ?? ""))),
    replace: fn((t, p, r, o) => str(t).replace(new RegExp(netRegex(p), regexOpts(o) + "g"), str(r).replace(/\$\{(\w+)\}/g, "$<$1>"))),
    split: fn((t, p, o) => str(t).split(new RegExp(netRegex(p), regexOpts(o)))),
    unescape: fn((t) => str(t).replace(/\\(.)/g, "$1")),
  },
};
let defaultZone: string | number = "UTC";
const shift = (d: unknown, ms: number) => (d instanceof TemplateDate ? new TemplateDate(d.ms + ms, d.zone) : null);
function addMonths(d: unknown, n: number) {
  if (!(d instanceof TemplateDate)) return null;
  const p = d.parts();
  const total = p.y * 12 + (p.mo - 1) + n, y = Math.floor(total / 12), mo = total % 12;
  const day = Math.min(p.d, new Date(Date.UTC(y, mo + 1, 0)).getUTCDate());
  return new TemplateDate(d.ms + (Date.UTC(y, mo, day) - Date.UTC(p.y, p.mo - 1, p.d)), d.zone);
}
/** .NET numeric formats: "0.00", "#,##0", "N2", "F1", "P0", "D3", "C". */
export function formatNetNumber(v: number, f: string): string {
  const m = /^([NFPDCnfpdc])(\d*)$/.exec(f);
  if (m) {
    const d = m[2] === "" ? (m[1].toUpperCase() === "D" ? 0 : 2) : +m[2];
    switch (m[1].toUpperCase()) {
      case "N": return v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
      case "F": return v.toFixed(d);
      case "P": return (v * 100).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) + " %";
      case "D": return String(Math.trunc(v)).padStart(d, "0");
      case "C": return v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: d, maximumFractionDigits: d });
    }
  }
  if (!f) return String(v);
  const [intPart, frac = ""] = f.split(".");
  const minFrac = (frac.match(/0/g) ?? []).length, maxFrac = (frac.match(/[0#]/g) ?? []).length;
  const minInt = (intPart.match(/0/g) ?? []).length;
  let s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: minFrac, maximumFractionDigits: maxFrac, useGrouping: intPart.includes(","), minimumIntegerDigits: Math.max(1, minInt) });
  if (minInt === 0 && s.startsWith("0.")) s = s.slice(1);
  return (v < 0 ? "-" : "") + s;
}

class Break {} class Continue {}

export interface RenderOptions {
  /** functions callable by name (convert_timezone, format_datetime…) */
  functions?: Record<string, (...args: any[]) => unknown>;
  /** the zone date.now and parsed dates show in */
  zone?: string | number;
}

/** Fill in a Scriban template with these variables. Throws TemplateError. */
export function renderTemplate(tpl: string, vars: Record<string, unknown>, opts: RenderOptions = {}): string {
  const prog = new Parser(lex(tpl)).program();
  defaultZone = opts.zone ?? "UTC";
  const globals: Record<string, unknown> = { ...BUILTINS };
  for (const [k, f] of Object.entries(opts.functions ?? {})) globals[k] = fn(f);
  const scope: Record<string, unknown> = Object.create(null);
  const lookup = (name: string): unknown => (name in scope ? scope[name] : name in vars ? vars[name] : globals[name]);
  let out = "";
  const ev = (e: Expr, asCallee = false): unknown => {
    switch (e.k) {
      case "lit": return e.v;
      case "var": { const v = lookup(e.name); return isFn(v) && !asCallee ? v() : v; }
      case "member": {
        const o = ev(e.obj);
        if (o == null) return null;
        let v: unknown;
        if (o instanceof TemplateDate || o instanceof TemplateSpan) v = (o as any)[e.name];
        else if (typeof o === "string") v = e.name === "size" ? o.length : undefined;
        else if (Array.isArray(o)) v = e.name === "size" ? o.length : undefined;
        else if (typeof o === "object") v = (o as any)[e.name] ?? (o as any)[e.name.charAt(0).toUpperCase() + e.name.slice(1)];
        if (v === undefined) return null;
        return isFn(v) && !asCallee ? v() : v;
      }
      case "index": {
        const o = ev(e.obj), i = ev(e.idx);
        if (o == null) return null;
        if (Array.isArray(o) || typeof o === "string") { const n = num(i); const a = o as any; return a[n < 0 ? a.length + n : n] ?? null; }
        if (typeof o === "object") return (o as any)[str(i)] ?? null;
        return null;
      }
      case "call": case "pipe": {
        const f = ev(e.fn, true);
        if (!isFn(f)) throw new TemplateError(`${describe(e.fn)} isn't a function`);
        const args = e.args.map((a) => ev(a));
        return e.k === "pipe" ? f(ev(e.left), ...args) : f(...args);
      }
      case "un": { const a = ev(e.a); return e.op === "!" ? !truthy(a) : e.op === "-" ? -num(a) : num(a); }
      case "cond": return truthy(ev(e.c)) ? ev(e.a) : ev(e.b);
      case "array": return e.items.map((x) => ev(x));
      case "object": return Object.fromEntries(e.entries.map(([k, x]) => [k, ev(x)]));
      case "bin": {
        if (e.op === "&&") return truthy(ev(e.a)) && truthy(ev(e.b));
        if (e.op === "||") return truthy(ev(e.a)) || truthy(ev(e.b));
        if (e.op === "??") { const a = ev(e.a); return a ?? ev(e.b); }
        const a = ev(e.a), b = ev(e.b);
        switch (e.op) {
          case "+": return typeof a === "string" || typeof b === "string" ? str(a) + str(b) : a instanceof TemplateDate && b instanceof TemplateSpan ? new TemplateDate(a.ms + b.ms, a.zone) : num(a) + num(b);
          case "-": return a instanceof TemplateDate && b instanceof TemplateDate ? new TemplateSpan(a.ms - b.ms) : a instanceof TemplateDate && b instanceof TemplateSpan ? new TemplateDate(a.ms - b.ms, a.zone) : num(a) - num(b);
          case "*": return typeof a === "string" ? a.repeat(Math.max(0, num(b))) : num(a) * num(b);
          case "/": return num(a) / num(b);
          case "//": return Math.floor(num(a) / num(b));
          case "%": return num(a) % num(b);
          case "==": return eq(a, b);
          case "!=": return !eq(a, b);
          case "<": return cmp(a, b) < 0;
          case ">": return cmp(a, b) > 0;
          case "<=": return cmp(a, b) <= 0;
          case ">=": return cmp(a, b) >= 0;
          case "..": { const r: number[] = []; for (let i = num(a); i <= num(b); i++) r.push(i); return r; }
          case "..<": { const r: number[] = []; for (let i = num(a); i < num(b); i++) r.push(i); return r; }
        }
      }
    }
    return null;
  };
  const assign = (target: Expr, v: unknown) => {
    if (target.k === "var") { scope[target.name] = v; return; }
    if (target.k === "member" || target.k === "index") {
      let o = ev(target.obj);
      if (o == null && target.obj.k === "var") { o = {}; scope[target.obj.name] = o; }
      if (o && typeof o === "object") (o as any)[target.k === "member" ? target.name : str(ev(target.idx))] = v;
      return;
    }
    throw new TemplateError("can't assign to that");
  };
  let steps = 0;
  const run = (body: Stmt[]) => {
    for (const s of body) {
      if (++steps > 2_000_000) throw new TemplateError("the template runs for too long (a loop that never ends?)");
      switch (s.k) {
        case "text": out += s.v; break;
        case "out": { const v = ev(s.e); out += toText(v); break; }
        case "assign": assign(s.target, ev(s.e)); break;
        case "if": for (const b of s.branches) { if (b.c == null || truthy(ev(b.c))) { run(b.body); break; } } break;
        case "for": {
          let list = asList(ev(s.list));
          if (s.offset) list = list.slice(num(ev(s.offset)));
          if (s.limit) list = list.slice(0, num(ev(s.limit)));
          if (s.reversed) list = [...list].reverse();
          const had = s.name in scope, prev = scope[s.name], prevFor = scope.for;
          for (let i = 0; i < list.length; i++) {
            scope[s.name] = list[i];
            scope.for = { index: i, index0: i, rindex: list.length - i, rindex0: list.length - i - 1, first: i === 0, last: i === list.length - 1, even: i % 2 === 0, odd: i % 2 === 1, length: list.length, changed: i === 0 || list[i] !== list[i - 1] };
            try { run(s.body); } catch (x) { if (x instanceof Break) break; if (x instanceof Continue) continue; throw x; }
          }
          if (had) scope[s.name] = prev; else delete scope[s.name];
          scope.for = prevFor;
          break;
        }
        case "while": {
          let guard = 0;
          while (truthy(ev(s.c))) {
            if (++guard > 100_000) throw new TemplateError("a while loop ran 100,000 times");
            try { run(s.body); } catch (x) { if (x instanceof Break) break; if (x instanceof Continue) continue; throw x; }
          }
          break;
        }
        case "capture": { const saved = out; out = ""; run(s.body); const v = out; out = saved; assign(s.target, v); break; }
        case "break": throw new Break();
        case "continue": throw new Continue();
      }
    }
  };
  run(prog);
  return out;
}
const describe = (e: Expr): string => (e.k === "var" ? e.name : e.k === "member" ? `${describe(e.obj)}.${e.name}` : "that");
function eq(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === "number" || typeof b === "number") { if (typeof a === "number" && typeof b === "number") return a === b; if (typeof a === "boolean" || typeof b === "boolean") return a === b; return num(a) === num(b) && str(a).trim() !== "" && str(b).trim() !== ""; }
  if (a instanceof TemplateDate && b instanceof TemplateDate) return a.ms === b.ms;
  if (a instanceof TemplateSpan && b instanceof TemplateSpan) return a.ms === b.ms;
  return a === b || (typeof a === "string" && typeof b === "string" && a === b);
}
function cmp(a: unknown, b: unknown): number {
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  if (a instanceof TemplateDate && b instanceof TemplateDate) return a.ms - b.ms;
  return num(a) - num(b);
}

/** Check a template's syntax without filling it in ("" when fine). */
export function templateSyntaxError(tpl: string): string {
  try { new Parser(lex(tpl)).program(); return ""; } catch (e) { return (e as Error).message; }
}
