# Pre-release review — two passes, all findings resolved

Adversarial workflow review of the uncommitted 0.9.3 change, over two passes.

| | agents | raised | survived refutation | fixed |
| --- | --- | --- | --- | --- |
| Pass 1 — the whole change | 40 | 34 | 33 | 33 |
| Pass 2 — the 33 fixes + the optimization | 26 | 21 | 21 | 21 |

Pass 2 was pointed at what pass 1's fixes broke or missed, and at the two least-reviewed files: the
per-session matcher memo added last, and `remote.ts`, which was rewritten from scratch mid-session.
It found that the memo was wrong, which is exactly why it was pointed there.

## Pass 2, the ones worth remembering

**The memo revalidated only LEAF directories.** `stateForDir` walks every ancestor to the filesystem
root to build the matcher, but the revalidation stamped only the directories the edited files live
in. A session editing under `<repo>/sub/` never stat'd `<repo>/.observatoryignore` — the canonical
place — so creating, editing or deleting it changed nothing. The repo-private tier was worse: it only
exists at a repository root, which is almost never a leaf, so that whole tier sat outside
revalidation. And because the same string stamps the change-map disk cache and the counts sidecar,
the staleness outlived the process: a cold reader served pre-rule counts beside a filtered edit list.
Fixed with an ancestor closure; the guarding test now fails without it.

**A remote config dir could run a command on the other machine.** The `$`-leading form is passed to
the remote shell unquoted so `$HOME/.claude` works — which makes `$(...)` command substitution,
executed there, from a value `prefs.json` and the options window both accepted unvalidated. Now
refused at both doors, with the legitimate forms still accepted.

**Two privacy violations, one of them pre-existing.** `docs/internal/dash-review-findings.md` quoted a
real user prompt verbatim in a public repo, and the README's dash frame published a live session's id
prefix and counts. The privacy gate matched only full UUIDs, so neither tripped it — the product
DISPLAYS a session by its first 8 characters, which is the form a leak actually takes. The gate now
catches that shape, and immediately found a third instance in `docs/DEMO.md` that predates this work.

**The dash's unreadable-ignore-file report was inert** — it read a map only the child process
populates. **`__problems` reached only the terminal**, so both editors still drew a view that could
not be built as an empty one. **`displayIgnoreContext` had zero callers**, so the show-hidden
setting's only test was pointed at dead code.

**Four tests could not fail:** the promptWindows stamp (its half was `0 <= 0` behind an `if` that
never ran), the remote disk cache (the in-process Map answered), the ancestor case above, and the
`$EDITOR` failure (the harness pins a working editor). All four now fail when their fix is reverted.

## Method

Every fix in both passes has a test, and each was verified by mutation — revert the fix in the built
artifact, confirm the test fails, restore. Where a claim could not be honestly asserted through the
harness (that an editor failure survives the next payload), the test says so and the check is narrowed
rather than left to pass for the wrong reason.
