/**
 * Dedicated capture entrypoint used by the PreToolUse/PostToolUse hooks.
 *
 * Kept as its OWN esbuild bundle so the hook process pulls in only the zero-dep capture module
 * (never the `diff`-based review/undo engine) — the edit path stays lean. Emits nothing to stdout
 * and always exits 0.
 */
import { runCapture } from '@claude-observatory/core/dist/capture';

runCapture();
process.exit(0);
