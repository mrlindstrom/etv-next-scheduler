// -----------------------------------------------------------------------------
// Opacity expressions from ErsatzTV legacy graphics elements (NCalc syntax).
// -----------------------------------------------------------------------------
// e.g. "LinearFadePoints(content_seconds, 1.24, 1.44, 9.04, 9.24)" or
// "LinearFadeDuration(content_seconds % 10, 0, 1, 8)". Parameters (seconds):
// content_seconds (into the item), content_total_seconds (its length),
// channel_seconds, time_of_day_seconds. Functions: ErsatzTV's LinearFadePoints /
// LinearFadeDuration, NCalc's Abs Acos Asin Atan Ceiling Cos Exp Floor
// IEEERemainder Log Log10 Max Min Pow Round Sign Sin Sqrt Tan Truncate, and
// if(cond, a, b). Operators: + - * / % ^(xor, as NCalc) ** (power) comparisons
// (= == != <> < > <= >=), && || and or ! not, ?: and bit ops & |.
// parseOpacity() also recognises the forms next can do natively (a fade in, hold,
// fade out — once, or repeating every N seconds) so builds can use next's own timing.

type Node =
  | { k: "num"; v: number } | { k: "str"; v: string } | { k: "bool"; v: boolean }
  | { k: "param"; name: string }
  | { k: "call"; name: string; args: Node[] }
  | { k: "un"; op: string; a: Node }
  | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "cond"; c: Node; a: Node; b: Node };

export const OPACITY_PARAMS = ["content_seconds", "content_total_seconds", "channel_seconds", "time_of_day_seconds"];

function lex(src: string): { t: string; v: string }[] {
  const out: { t: string; v: string }[] = [];
  let i = 0;
  const ops = ["**", "<=", ">=", "==", "!=", "<>", "&&", "||", "<<", ">>", "+", "-", "*", "/", "%", "^", "<", ">", "=", "!", "(", ")", ",", "?", ":", "&", "|", "~"];
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c) && /[0-9]/.test(c === "." ? src[i + 1] ?? "" : c)) {
      let j = i; while (j < src.length && /[0-9.]/.test(src[j])) j++;
      if (/[eE]/.test(src[j] ?? "")) { j++; if (/[+-]/.test(src[j] ?? "")) j++; while (j < src.length && /[0-9]/.test(src[j])) j++; }
      out.push({ t: "num", v: src.slice(i, j) }); i = j; continue;
    }
    if (c === "'" || c === '"') { const j = src.indexOf(c, i + 1); out.push({ t: "str", v: src.slice(i + 1, j < 0 ? undefined : j) }); i = j < 0 ? src.length : j + 1; continue; }
    if (c === "[") { const j = src.indexOf("]", i); out.push({ t: "id", v: src.slice(i + 1, j < 0 ? undefined : j) }); i = j < 0 ? src.length : j + 1; continue; }
    if (/[A-Za-z_]/.test(c)) { let j = i + 1; while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++; out.push({ t: "id", v: src.slice(i, j) }); i = j; continue; }
    const op = ops.find((o) => src.startsWith(o, i));
    if (!op) throw new Error(`unexpected "${c}" in the opacity expression`);
    out.push({ t: "op", v: op }); i += op.length;
  }
  return out;
}

export function parseExpression(src: string): Node {
  const toks = lex(src);
  let i = 0;
  const peek = () => toks[i];
  const isOp = (v: string) => peek()?.t === "op" && peek().v === v;
  const isWord = (v: string) => peek()?.t === "id" && peek().v.toLowerCase() === v;
  const expect = (v: string) => { if (!isOp(v)) throw new Error(`expected "${v}" in the opacity expression`); i++; };
  const ternary = (): Node => { const c = or(); if (isOp("?")) { i++; const a = ternary(); expect(":"); const b = ternary(); return { k: "cond", c, a, b }; } return c; };
  const level = (next: () => Node, ops: string[], words: Record<string, string> = {}) => (): Node => {
    let a = next();
    for (;;) {
      const t = peek();
      const op = t?.t === "op" && ops.includes(t.v) ? t.v : t?.t === "id" && words[t.v.toLowerCase()] ? words[t.v.toLowerCase()] : null;
      if (!op) return a;
      i++;
      a = { k: "bin", op, a, b: next() };
    }
  };
  const unary = (): Node => {
    if (isOp("-") || isOp("!") || isOp("~")) { const op = toks[i++].v; return { k: "un", op, a: unary() }; }
    if (isWord("not")) { i++; return { k: "un", op: "!", a: unary() }; }
    return power();
  };
  const power = (): Node => { const a = primary(); if (isOp("**")) { i++; return { k: "bin", op: "**", a, b: unary() }; } return a; };
  const mult = level(unary, ["*", "/", "%"]);
  const add = level(mult, ["+", "-"]);
  const shift = level(add, ["<<", ">>"]);
  const rel = level(shift, ["<", ">", "<=", ">="]);
  const eqv = level(rel, ["=", "==", "!=", "<>"]);
  const band = level(eqv, ["&"]);
  const bxor = level(band, ["^"]);
  const bor = level(bxor, ["|"]);
  const and = level(bor, ["&&"], { and: "&&" });
  const or = level(and, ["||"], { or: "||" });
  function primary(): Node {
    const t = toks[i++];
    if (!t) throw new Error("the opacity expression ends too soon");
    if (t.t === "num") return { k: "num", v: Number(t.v) };
    if (t.t === "str") return { k: "str", v: t.v };
    if (t.t === "id") {
      if (/^true$/i.test(t.v)) return { k: "bool", v: true };
      if (/^false$/i.test(t.v)) return { k: "bool", v: false };
      if (isOp("(")) {
        i++;
        const args: Node[] = [];
        while (!isOp(")")) { args.push(ternary()); if (isOp(",")) i++; else break; }
        expect(")");
        return { k: "call", name: t.v, args };
      }
      return { k: "param", name: t.v };
    }
    if (t.v === "(") { const e = ternary(); expect(")"); return e; }
    throw new Error(`unexpected "${t.v}" in the opacity expression`);
  }
  const e = ternary();
  if (i < toks.length) throw new Error(`unexpected "${toks[i].v}" in the opacity expression`);
  return e;
}

export function linearFadePoints(t: number, start: number, peakStart: number, peakEnd: number, end: number): number {
  if (t < start || t >= end) return 0;
  if (t < peakStart) return (t - start) / (peakStart - start);
  if (t < peakEnd) return 1;
  return (end - t) / (end - peakEnd);
}
export function linearFadeDuration(t: number, start: number, fade: number, peak: number): number {
  if (fade <= 0) return t >= start && t < start + peak ? 1 : 0;
  return linearFadePoints(t, start, start + fade, start + fade + peak, start + 2 * fade + peak);
}

export function evaluate(e: Node, params: Record<string, number>): number | boolean | string {
  const n = (x: Node) => { const v = evaluate(x, params); return typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : Number(v); };
  const b = (x: Node) => { const v = evaluate(x, params); return typeof v === "boolean" ? v : typeof v === "number" ? v !== 0 : v !== ""; };
  switch (e.k) {
    case "num": case "str": case "bool": return e.v;
    case "param": { const v = params[e.name]; if (v == null) throw new Error(`unknown value "${e.name}" in the opacity expression`); return v; }
    case "un": return e.op === "-" ? -n(e.a) : e.op === "~" ? ~n(e.a) : !b(e.a);
    case "cond": return b(e.c) ? evaluate(e.a, params) : evaluate(e.b, params);
    case "bin": switch (e.op) {
      case "+": { const x = evaluate(e.a, params), y = evaluate(e.b, params); return typeof x === "string" || typeof y === "string" ? String(x) + String(y) : n(e.a) + n(e.b); }
      case "-": return n(e.a) - n(e.b); case "*": return n(e.a) * n(e.b); case "/": return n(e.a) / n(e.b);
      case "%": return n(e.a) % n(e.b); case "**": return n(e.a) ** n(e.b);
      case "<": return n(e.a) < n(e.b); case ">": return n(e.a) > n(e.b); case "<=": return n(e.a) <= n(e.b); case ">=": return n(e.a) >= n(e.b);
      case "=": case "==": return evaluate(e.a, params) == evaluate(e.b, params); // eslint-disable-line eqeqeq
      case "!=": case "<>": return evaluate(e.a, params) != evaluate(e.b, params); // eslint-disable-line eqeqeq
      case "&&": return b(e.a) && b(e.b); case "||": return b(e.a) || b(e.b);
      case "&": return n(e.a) & n(e.b); case "|": return n(e.a) | n(e.b); case "^": return n(e.a) ^ n(e.b);
      case "<<": return n(e.a) << n(e.b); case ">>": return n(e.a) >> n(e.b);
    } break;
    case "call": {
      const a = e.args.map((x) => () => n(x));
      const name = e.name.toLowerCase();
      const need = (c: number) => { if (e.args.length !== c) throw new Error(`${e.name}() needs ${c} values`); };
      switch (name) {
        case "linearfadepoints": need(5); return linearFadePoints(a[0](), a[1](), a[2](), a[3](), a[4]());
        case "linearfadeduration": need(4); return linearFadeDuration(a[0](), a[1](), a[2](), a[3]());
        case "if": need(3); return b(e.args[0]) ? evaluate(e.args[1], params) : evaluate(e.args[2], params);
        case "abs": return Math.abs(a[0]()); case "acos": return Math.acos(a[0]()); case "asin": return Math.asin(a[0]()); case "atan": return Math.atan(a[0]());
        case "ceiling": return Math.ceil(a[0]()); case "cos": return Math.cos(a[0]()); case "exp": return Math.exp(a[0]()); case "floor": return Math.floor(a[0]());
        case "ieeeremainder": { const x = a[0](), y = a[1](); return x - y * Math.round(x / y); }
        case "log": return Math.log(a[0]()) / Math.log(a[1]()); case "log10": return Math.log10(a[0]());
        case "max": return Math.max(a[0](), a[1]()); case "min": return Math.min(a[0](), a[1]()); case "pow": return a[0]() ** a[1]();
        case "round": { const f = 10 ** (e.args.length > 1 ? a[1]() : 0); const v = a[0]() * f; const r = Math.abs(v % 1) === 0.5 ? 2 * Math.round(v / 2) : Math.round(v); return r / f; } // banker's, as .NET
        case "sign": return Math.sign(a[0]()); case "sin": return Math.sin(a[0]()); case "sqrt": return Math.sqrt(a[0]()); case "tan": return Math.tan(a[0]());
        case "truncate": return Math.trunc(a[0]());
      }
      throw new Error(`unknown function ${e.name}() in the opacity expression`);
    }
  }
  return 0;
}

/** How an opacity expression maps onto next's own timing (a fade in, a hold, a fade
 *  out), when it does. `clock`: what the time counts from; `everyS`: repeats with this
 *  period (none = once); times in seconds; fadeIn / fadeOut may differ (next has one). */
export interface NativeFade { clock: "content" | "wall"; everyS?: number; startS: number; fadeInS: number; holdS: number; fadeOutS: number; peak: number }
export type OpacityPlan = { kind: "constant"; opacity: number } | { kind: "fade"; fade: NativeFade } | { kind: "curve"; expr: Node };

/** Read an opacity expression: a constant, a native fade, or (anything else) a curve
 *  that has to be evaluated over time. Throws on a syntax error. */
export function parseOpacity(src: string): OpacityPlan {
  const e = parseExpression(src);
  const constant = (x: Node): number | null => {
    try { const v = evaluate(x, {}); return typeof v === "number" && Number.isFinite(v) ? v : null; } catch { return null; }
  };
  const c = constant(e);
  if (c != null) return { kind: "constant", opacity: Math.max(0, Math.min(1, c)) };
  // [scale *] LinearFade…(<time> [% N], numbers…) [* scale]
  let body = e, peak = 1;
  if (body.k === "bin" && body.op === "*") {
    const l = constant(body.a), r = constant(body.b);
    if (l != null && body.b.k === "call") { peak = l; body = body.b; } else if (r != null && body.a.k === "call") { peak = r; body = body.a; }
  }
  if (body.k === "call" && /^linearfade(points|duration)$/i.test(body.name)) {
    const t = body.args[0];
    let clock: NativeFade["clock"] | null = null, everyS: number | undefined;
    const timeOf = (x: Node): NativeFade["clock"] | null => (x.k === "param" && x.name === "content_seconds" ? "content" : x.k === "param" && (x.name === "time_of_day_seconds" || x.name === "channel_seconds") ? "wall" : null);
    if (t && timeOf(t)) clock = timeOf(t);
    else if (t?.k === "bin" && t.op === "%" && timeOf(t.a) && constant(t.b) != null && constant(t.b)! > 0) { clock = timeOf(t.a); everyS = constant(t.b)!; }
    const nums = body.args.slice(1).map(constant);
    if (clock && nums.every((x) => x != null)) {
      const v = nums as number[];
      const pts = /points/i.test(body.name) ? v : (() => { const [s, f, p] = v; return f <= 0 ? [s, s, s + p, s + p] : [s, s + f, s + f + p, s + 2 * f + p]; })();
      if (pts.length === 4 && pts[0] <= pts[1] && pts[1] <= pts[2] && pts[2] <= pts[3]) {
        // a time_of_day / channel clock without a period is once a day, at that time
        if (clock === "wall" && everyS == null) everyS = 86_400;
        return { kind: "fade", fade: { clock, everyS, startS: pts[0], fadeInS: pts[1] - pts[0], holdS: pts[2] - pts[1], fadeOutS: pts[3] - pts[2], peak: Math.max(0, Math.min(1, peak)) } };
      }
    }
  }
  return { kind: "curve", expr: e };
}
