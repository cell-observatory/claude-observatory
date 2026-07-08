package com.cellobservatory.observatory.core

/**
 * Language-agnostic class-span detection for grouping edits by class — faithful port of core's
 * classes.ts (regex + brace/indent matching, not a parser; good enough for a review tree).
 */
data class ClassSpan(val name: String, val start: Int, val end: Int)

object Classes {
    private val PY = Regex("""^(\s*)class\s+([A-Za-z_$][\w$]*)\s*(?:\([^)]*\))?\s*:\s*(?:#.*)?$""")
    private val BRACE = Regex("""^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)""")

    fun detectClasses(text: String): List<ClassSpan> {
        val lines = text.split("\n")
        val out = mutableListOf<ClassSpan>()
        for (i in lines.indices) {
            val line = lines[i]
            val py = PY.find(line)
            if (py != null) {
                val indent = py.groupValues[1].length
                var end = i
                for (j in i + 1 until lines.size) {
                    if (lines[j].isBlank()) continue
                    val ind = lines[j].length - lines[j].trimStart().length
                    if (ind <= indent) break
                    end = j
                }
                out.add(ClassSpan(py.groupValues[2], i, end))
                continue
            }
            val br = BRACE.find(line)
            if (br != null) {
                val openLine = findOpenBrace(lines, i)
                if (openLine >= 0) {
                    val end = matchBrace(lines, openLine)
                    if (end >= i) out.add(ClassSpan(br.groupValues[1], i, end))
                }
            }
        }
        return out
    }

    /** Innermost span containing [line] — smallest span wins for nested classes. */
    fun classAt(spans: List<ClassSpan>, line: Int): ClassSpan? =
        spans.filter { line in it.start..it.end }.minByOrNull { it.end - it.start }

    private fun findOpenBrace(lines: List<String>, from: Int): Int {
        for (i in from until minOf(lines.size, from + 6)) if ('{' in lines[i]) return i
        return -1
    }

    private fun matchBrace(lines: List<String>, openLine: Int): Int {
        var depth = 0
        var started = false
        for (i in openLine until lines.size) {
            for (ch in lines[i]) {
                if (ch == '{') { depth++; started = true }
                else if (ch == '}') { depth--; if (started && depth == 0) return i }
            }
        }
        return lines.size - 1
    }
}
