// Compile the webview JS. tsc checks that the template literal is well-formed TypeScript (the backtick
// trap) but never looks INSIDE the string, so a syntax error in webview JS ships green and the panel is
// blank at runtime with nothing in the build to point at it.
import fs from 'fs';
const src = fs.readFileSync('packages/vscode/src/extension.ts', 'utf8');

// Which identifiers get injected into a <script> tag?
const names = [...new Set([...src.matchAll(/<script nonce="\$\{nonce\}">\$\{(\w+)\}<\/script>/g)].map((m) => m[1]))];
if (!names.length) { console.log('INSTRUMENT BROKEN: no <script nonce> injections found'); process.exit(2); }

// Pull each one's template literal out by scanning to the matching unescaped backtick.
function literalFor(name) {
  const m = new RegExp(`(?:const|let|var)\\s+${name}\\s*(?::[^=]*)?=\\s*\``).exec(src);
  if (!m) return null;
  let i = m.index + m[0].length, depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (c === '$' && src[i + 1] === '{') { depth++; i++; continue; }
    if (c === '}' && depth > 0) { depth--; continue; }
    if (c === '`' && depth === 0) break;
  }
  return src.slice(m.index + m[0].length, i);
}

let ok = 0; const fails = [];
for (const n of names) {
  const body = literalFor(n);
  if (body == null) { fails.push(`${n}: could not locate its template literal`); continue; }
  const js = body.replace(/\$\{[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, '0'); // host-side interpolation → a literal
  try { new Function(js); ok++; } catch (e) { fails.push(`${n} (${body.length}b): ${e.message}`); }
}
console.log(`  webview scripts: ${names.join(', ')}`);
console.log(`  parsed: ${ok}   failed: ${fails.length}`);
for (const f of fails) console.log('  FAIL ' + f);
process.exit(fails.length ? 1 : 0);
