import { getRuntime } from '../runtime.js';
/**
 * Safe Expression Evaluator
 *
 * Evaluates condition expressions against a workflow context object.
 * Supports: property access, comparison operators, logical operators,
 * string methods (.includes, .startsWith), and literal values.
 *
 * NO eval(), NO Function() constructor, NO arbitrary code execution.
 */

// ---- Token Types -----------------------------------------------------------

const TOKEN_TYPES = {
  STRING: 'STRING',
  NUMBER: 'NUMBER',
  BOOLEAN: 'BOOLEAN',
  NULL: 'NULL',
  IDENTIFIER: 'IDENTIFIER',
  DOT: 'DOT',
  OPEN_PAREN: 'OPEN_PAREN',
  CLOSE_PAREN: 'CLOSE_PAREN',
  OPERATOR: 'OPERATOR',
  LOGICAL: 'LOGICAL',
  NOT: 'NOT',
} as const;

type TokenType = (typeof TOKEN_TYPES)[keyof typeof TOKEN_TYPES];

interface Token {
  type: TokenType;
  value: string | number | boolean | null;
}

// ---- Tokenizer -------------------------------------------------------------

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < expr.length) {
    // Skip whitespace
    if (/\s/.test(expr[i])) { i++; continue; }

    // String literals
    if (expr[i] === "'" || expr[i] === '"') {
      const quote = expr[i];
      let value = '';
      i++;
      while (i < expr.length && expr[i] !== quote) {
        if (expr[i] === '\\') { i++; value += expr[i] || ''; }
        else { value += expr[i]; }
        i++;
      }
      i++; // skip closing quote
      tokens.push({ type: TOKEN_TYPES.STRING, value });
      continue;
    }

    // Numbers
    if (/[0-9]/.test(expr[i]) || (expr[i] === '-' && /[0-9]/.test(expr[i + 1]))) {
      let num = '';
      if (expr[i] === '-') { num += '-'; i++; }
      while (i < expr.length && /[0-9.]/.test(expr[i])) { num += expr[i]; i++; }
      tokens.push({ type: TOKEN_TYPES.NUMBER, value: parseFloat(num) });
      continue;
    }

    // Comparison operators
    if (expr.slice(i, i + 3) === '===') { tokens.push({ type: TOKEN_TYPES.OPERATOR, value: '===' }); i += 3; continue; }
    if (expr.slice(i, i + 3) === '!==') { tokens.push({ type: TOKEN_TYPES.OPERATOR, value: '!==' }); i += 3; continue; }
    if (expr.slice(i, i + 2) === '==') { tokens.push({ type: TOKEN_TYPES.OPERATOR, value: '===' }); i += 2; continue; }
    if (expr.slice(i, i + 2) === '!=') { tokens.push({ type: TOKEN_TYPES.OPERATOR, value: '!==' }); i += 2; continue; }
    if (expr.slice(i, i + 2) === '>=') { tokens.push({ type: TOKEN_TYPES.OPERATOR, value: '>=' }); i += 2; continue; }
    if (expr.slice(i, i + 2) === '<=') { tokens.push({ type: TOKEN_TYPES.OPERATOR, value: '<=' }); i += 2; continue; }
    if (expr[i] === '>') { tokens.push({ type: TOKEN_TYPES.OPERATOR, value: '>' }); i++; continue; }
    if (expr[i] === '<') { tokens.push({ type: TOKEN_TYPES.OPERATOR, value: '<' }); i++; continue; }

    // Logical operators
    if (expr.slice(i, i + 2) === '&&') { tokens.push({ type: TOKEN_TYPES.LOGICAL, value: '&&' }); i += 2; continue; }
    if (expr.slice(i, i + 2) === '||') { tokens.push({ type: TOKEN_TYPES.LOGICAL, value: '||' }); i += 2; continue; }

    // Not operator
    if (expr[i] === '!') { tokens.push({ type: TOKEN_TYPES.NOT, value: '!' }); i++; continue; }

    // Dot
    if (expr[i] === '.') { tokens.push({ type: TOKEN_TYPES.DOT, value: '.' }); i++; continue; }

    // Parens
    if (expr[i] === '(') { tokens.push({ type: TOKEN_TYPES.OPEN_PAREN, value: '(' }); i++; continue; }
    if (expr[i] === ')') { tokens.push({ type: TOKEN_TYPES.CLOSE_PAREN, value: ')' }); i++; continue; }

    // Identifiers (including keywords)
    if (/[a-zA-Z_$]/.test(expr[i])) {
      let id = '';
      while (i < expr.length && /[a-zA-Z0-9_$]/.test(expr[i])) { id += expr[i]; i++; }
      if (id === 'true') { tokens.push({ type: TOKEN_TYPES.BOOLEAN, value: true }); }
      else if (id === 'false') { tokens.push({ type: TOKEN_TYPES.BOOLEAN, value: false }); }
      else if (id === 'null' || id === 'undefined') { tokens.push({ type: TOKEN_TYPES.NULL, value: null }); }
      else { tokens.push({ type: TOKEN_TYPES.IDENTIFIER, value: id }); }
      continue;
    }

    // Comma (skip, used in function args)
    if (expr[i] === ',') { i++; continue; }

    throw new Error(`Unexpected character: ${expr[i]} at position ${i}`);
  }

  return tokens;
}

// ---- Resolver --------------------------------------------------------------

interface ResolveResult {
  value: unknown;
  nextIndex: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- context is an arbitrary nested object
type ContextObject = Record<string, any>;

function resolveProperty(context: ContextObject, tokens: Token[], start: number): ResolveResult {
  let value: unknown = context;
  let i = start;

  // First token must be an identifier
  if (tokens[i]?.type !== TOKEN_TYPES.IDENTIFIER) {
    throw new Error(`Expected identifier at position ${i}`);
  }

  // Handle 'context.' prefix — skip it as context IS the root
  if (tokens[i].value === 'context' && tokens[i + 1]?.type === TOKEN_TYPES.DOT) {
    i += 2;
  }

  // Walk the property chain
  while (i < tokens.length) {
    if (tokens[i].type === TOKEN_TYPES.IDENTIFIER) {
      value = (value as ContextObject)?.[tokens[i].value as string];
      i++;

      // Check for method call
      if (tokens[i]?.type === TOKEN_TYPES.OPEN_PAREN) {
        const methodName = tokens[i - 1].value as string;
        const allowedMethods = ['includes', 'startsWith', 'endsWith', 'toLowerCase', 'toUpperCase'];
        if (!allowedMethods.includes(methodName)) {
          throw new Error(`Method not allowed: ${methodName}`);
        }
        // This is a method call on the parent, so go back
        const parentProp = tokens.slice(start, i - 1);
        let parentValue: unknown = context;
        for (const t of parentProp) {
          if (t.type === TOKEN_TYPES.IDENTIFIER && t.value !== 'context') {
            parentValue = (parentValue as ContextObject)?.[t.value as string];
          }
        }

        i++; // skip (
        // Parse args
        const args: (string | number | boolean)[] = [];
        while (i < tokens.length && tokens[i].type !== TOKEN_TYPES.CLOSE_PAREN) {
          if (tokens[i].type === TOKEN_TYPES.STRING) { args.push(tokens[i].value as string); }
          else if (tokens[i].type === TOKEN_TYPES.NUMBER) { args.push(tokens[i].value as number); }
          else if (tokens[i].type === TOKEN_TYPES.BOOLEAN) { args.push(tokens[i].value as boolean); }
          i++;
        }
        i++; // skip )

        const parentObj = parentValue as ContextObject;
        if (typeof parentObj?.[methodName] === 'function') {
          value = (parentObj[methodName] as (...a: (string | number | boolean)[]) => unknown)(...args);
        } else {
          value = false;
        }
        return { value, nextIndex: i };
      }

      // Check for dot (continue chain)
      if (tokens[i]?.type === TOKEN_TYPES.DOT) {
        i++;
        continue;
      }

      return { value, nextIndex: i };
    }

    break;
  }

  return { value, nextIndex: i };
}

// ---- Evaluator -------------------------------------------------------------

function evaluateTokens(tokens: Token[], context: ContextObject): unknown {
  let i = 0;

  function parseValue(): unknown {
    // Not operator
    if (tokens[i]?.type === TOKEN_TYPES.NOT) {
      i++;
      const val = parseValue();
      return !val;
    }

    // Parenthesized expression
    if (tokens[i]?.type === TOKEN_TYPES.OPEN_PAREN) {
      i++; // skip (
      const val = parseOr();
      if (tokens[i]?.type === TOKEN_TYPES.CLOSE_PAREN) i++; // skip )
      return val;
    }

    // Literals
    if (tokens[i]?.type === TOKEN_TYPES.STRING) { return tokens[i++].value; }
    if (tokens[i]?.type === TOKEN_TYPES.NUMBER) { return tokens[i++].value; }
    if (tokens[i]?.type === TOKEN_TYPES.BOOLEAN) { return tokens[i++].value; }
    if (tokens[i]?.type === TOKEN_TYPES.NULL) { i++; return null; }

    // Property access / method call
    if (tokens[i]?.type === TOKEN_TYPES.IDENTIFIER) {
      const result = resolveProperty(context, tokens, i);
      i = result.nextIndex;
      return result.value;
    }

    throw new Error(`Unexpected token at position ${i}: ${JSON.stringify(tokens[i])}`);
  }

  function parseComparison(): unknown {
    let left: unknown = parseValue();

    while (tokens[i]?.type === TOKEN_TYPES.OPERATOR) {
      const op = tokens[i].value as string;
      i++;
      const right: unknown = parseValue();

      switch (op) {
        case '===': left = left === right; break;
        case '!==': left = left !== right; break;
        case '>': left = (left as number) > (right as number); break;
        case '<': left = (left as number) < (right as number); break;
        case '>=': left = (left as number) >= (right as number); break;
        case '<=': left = (left as number) <= (right as number); break;
        default: throw new Error(`Unknown operator: ${op}`);
      }
    }

    return left;
  }

  function parseAnd(): unknown {
    let left: unknown = parseComparison();
    while (tokens[i]?.type === TOKEN_TYPES.LOGICAL && tokens[i].value === '&&') {
      i++;
      const right = parseComparison();
      left = left && right;
    }
    return left;
  }

  function parseOr(): unknown {
    let left: unknown = parseAnd();
    while (tokens[i]?.type === TOKEN_TYPES.LOGICAL && tokens[i].value === '||') {
      i++;
      const right = parseAnd();
      left = left || right;
    }
    return left;
  }

  return parseOr();
}

// ---- Public API ------------------------------------------------------------

/**
 * Evaluate a condition expression against a context object.
 *
 * @param expression - The condition expression
 * @param context - The workflow context data
 * @returns The result of the expression evaluation
 */
export function evaluateCondition(expression: string, context: Record<string, unknown>): boolean {
  if (!expression || typeof expression !== 'string') return false;

  const { logger } = getRuntime();
  try {
    const tokens = tokenize(expression.trim());
    if (tokens.length === 0) return false;
    const result = evaluateTokens(tokens, context || {});
    return Boolean(result);
  } catch (err) {
    logger.error('[Workflow Evaluator] Expression error', { error: (err as Error).message, expression });
    return false;
  }
}
