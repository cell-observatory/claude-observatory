/**
 * The remote scanner, as source.
 *
 * It runs on the OTHER machine and applies the same title rule `scanTitle` applies here: the newest
 * `ai-title` in the tail wins, and failing that the first real user prompt in the head — with the
 * same wrapper exclusions, because `<ide_opened_file>` and `<local-command-caveat>` are records Claude
 * Code injects, not anything a human typed.
 *
 * Doing the extraction THERE is the point. The first version shipped a 400-byte sample per session
 * and extracted here, which meant every title was a truncated record: `JSON.parse` rejected all of
 * them, and the textual fallback produced fragments like `de`. Only the finished string crosses the
 * wire now, so a remote title is the same string a local one would be.
 *
 * Bounded reads, always: 64KB from the tail and 256KB from the head, never the whole file. A real
 * transcript runs to tens of megabytes and there may be hundreds of them.
 *
 * Shipped base64-encoded (see `remote.ts`) so no quoting rule of any shell it passes through can
 * corrupt it.
 */
export const REMOTE_SCAN_PY = String.raw`
import os, sys, json

base = os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else '~/.claude')
d = os.path.join(base, 'projects')
if not os.path.isdir(d):
    sys.stdout.write('NOPROJECTS\n')
    sys.exit(0)
sys.stdout.write('OK\n')

WRAPPERS = ('<local-command', '<ide_', '<command-', 'tool_result')
TAIL = 65536
HEAD = 262144

def clean(t):
    t = ' '.join(str(t).split())
    return t[:200]

def text_of(o):
    m = o.get('message') or {}
    c = m.get('content')
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        for part in c:
            if isinstance(part, dict) and isinstance(part.get('text'), str):
                return part['text']
    return ''

def scan(p, size):
    """The newest ai-title, else the first real user prompt. Mirrors scanTitle()."""
    try:
        with open(p, 'rb') as f:
            n = min(size, TAIL)
            if n:
                f.seek(size - n)
                lines = f.read(n).decode('utf-8', 'replace').split('\n')
                if n < size and lines:
                    lines = lines[1:]          # first line of a mid-file read is partial
                for line in reversed(lines):
                    if '"ai-title"' not in line:
                        continue
                    try:
                        o = json.loads(line)
                    except Exception:
                        continue               # partial line, not an error
                    if o.get('type') == 'ai-title' and str(o.get('aiTitle', '')).strip():
                        return clean(o['aiTitle'])
            f.seek(0)
            for line in f.read(min(size, HEAD)).decode('utf-8', 'replace').split('\n'):
                line = line.strip()
                if not line or '"type":"user"' not in line:
                    continue
                if any(w in line for w in WRAPPERS):
                    continue
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                if o.get('isSidechain'):
                    continue                   # a subagent's turn, not the conversation's opening
                t = text_of(o).strip()
                if t and not t.startswith('<'):
                    return clean(t)
    except Exception:
        pass
    return ''

def first_line(p):
    try:
        with open(p, 'rb') as f:
            return f.read(400).decode('utf-8', 'replace').split('\n', 1)[0]
    except Exception:
        return ''

for slug in sorted(os.listdir(d)):
    wd = os.path.join(d, slug)
    if not os.path.isdir(wd):
        continue
    try:
        names = os.listdir(wd)
    except Exception:
        continue
    for n in names:
        if not n.endswith('.jsonl'):
            continue
        p = os.path.join(wd, n)
        try:
            st = os.stat(p)
        except Exception:
            continue
        head = first_line(p)
        bridged = '1' if '"bridge-session"' in head else '0'
        title = '' if bridged == '1' else scan(p, st.st_size)
        row = [slug, n[:-6], str(int(st.st_mtime)), str(st.st_size), bridged, title]
        sys.stdout.write('\t'.join(x.replace('\t', ' ').replace('\n', ' ') for x in row) + '\n')
`;
