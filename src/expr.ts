// -----------------------------------------------------------------------------
// Safe expression evaluator for mid-roll (and future) rule expressions.
// -----------------------------------------------------------------------------
// Mirrors the ErsatzTV legacy mid-roll expression language, e.g.
//     point > 300 and last_mid_filler > 480 and total_points < 3
// Supported: numbers, variables, ( ), + - * / %, comparisons (> < >= <= == != =),
//            boolean and/or/not (and && ||). No function calls, no property access,
//            no assignment -> safe to run on user-supplied strings.

type Tok =
  | { t: "num"; v: number }
  | { t: "id"; v: string }
  | { t: "op"; v: string }
  | { t: "lp" } | { t: "rp" };

const KEYWORD_OPS: Record<string, string> = { and: "&&", or: "||", not: "!" };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const two = new Set([">=", "<=", "==", "!=", "&&", "||"]);
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    if (c === "(") { toks.push({ t: "lp" }); i++; continue; }
    if (c === ")") { toks.push({ t: "rp" }); i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[0-9._]/.test(src[j])) j++;
      toks.push({ t: "num", v: Number(src.slice(i, j).replace(/_/g, "")) });
      i = j; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      const word = src.slice(i, j);
      const kw = KEYWORD_OPS[word.toLowerCase()];
      if (kw) toks.push({ t: "op", v: kw });
      else toks.push({ t: "id", v: word });
      i = j; continue;
    }
    const pair = src.slice(i, i + 2);
    if (two.has(pair)) { toks.push({ t: "op", v: pair }); i += 2; continue; }
    if ("+-*/%<>=!".includes(c)) { toks.push({ t: "op", v: c }); i++; continue; }
    throw new Error(`Unexpected character '${c}' in expression: ${src}`);
  }
  return toks;
}

export type ExprScope = Record<string, number | boolean>;

class Parser {
  private p = 0;
  constructor(private toks: Tok[], private scope: ExprScope) {}
  private peek(): Tok | undefined { return this.toks[this.p]; }
  private next(): Tok | undefined { return this.toks[this.p++]; }

  parse(): number | boolean {
    const v = this.parseOr();
    if (this.p !== this.toks.length) throw new Error("Trailing tokens in expression");
    return v;
  }
  private parseOr(): any {
    let left = this.parseAnd();
    while (this.isOp("||")) { this.next(); const r = this.parseAnd(); left = truthy(left) || truthy(r); }
    return left;
  }
  private parseAnd(): any {
    let left = this.parseNot();
    while (this.isOp("&&")) { this.next(); const r = this.parseNot(); left = truthy(left) && truthy(r); }
    return left;
  }
  private parseNot(): any {
    if (this.isOp("!")) { this.next(); return !truthy(this.parseNot()); }
    return this.parseCmp();
  }
  private parseCmp(): any {
    let left = this.parseAdd();
    const t = this.peek();
    if (t && t.t === "op" && [">", "<", ">=", "<=", "==", "!=", "="].includes(t.v)) {
      this.next();
      const right = this.parseAdd();
      const a = Number(left), b = Number(right);
      switch (t.v) {
        case ">": return a > b; case "<": return a < b;
        case ">=": return a >= b; case "<=": return a <= b;
        case "==": case "=": return a === b; case "!=": return a !== b;
      }
    }
    return left;
  }
  private parseAdd(): any {
    let left = this.parseMul();
    while (this.isOp("+") || this.isOp("-")) {
      const op = (this.next() as any).v; const r = this.parseMul();
      left = op === "+" ? Number(left) + Number(r) : Number(left) - Number(r);
    }
    return left;
  }
  private parseMul(): any {
    let left = this.parsePrimary();
    while (this.isOp("*") || this.isOp("/") || this.isOp("%")) {
      const op = (this.next() as any).v; const r = this.parsePrimary();
      left = op === "*" ? Number(left) * Number(r) : op === "/" ? Number(left) / Number(r) : Number(left) % Number(r);
    }
    return left;
  }
  private parsePrimary(): any {
    const t = this.next();
    if (!t) throw new Error("Unexpected end of expression");
    if (t.t === "num") return t.v;
    if (t.t === "lp") { const v = this.parseOr(); if (this.peek()?.t !== "rp") throw new Error("Missing )"); this.next(); return v; }
    if (t.t === "id") {
      if (t.v.toLowerCase() === "true") return true;
      if (t.v.toLowerCase() === "false") return false;
      if (!(t.v in this.scope)) throw new Error(`Unknown variable '${t.v}' in expression`);
      return this.scope[t.v];
    }
    if (t.t === "op" && t.v === "-") return -Number(this.parsePrimary());
    throw new Error(`Unexpected token in expression: ${JSON.stringify(t)}`);
  }
  private isOp(v: string): boolean { const t = this.peek(); return !!t && t.t === "op" && t.v === v; }
}

function truthy(v: any): boolean { return typeof v === "boolean" ? v : Number(v) !== 0; }

/** Evaluate an expression string against a variable scope, returning a boolean. */
export function evalExpression(src: string, scope: ExprScope): boolean {
  const toks = tokenize(src);
  const result = new Parser(toks, scope).parse();
  return truthy(result);
}
