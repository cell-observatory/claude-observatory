// Boot the INTERACTIVE path with a faked TTY and assert it paints without throwing.
// `--once` renders directly and never goes through `paint`, so it cannot catch an error on the
// interactive first frame — which is exactly how a temporal-dead-zone crash shipped.
process.stdin.isTTY = true;
process.stdin.setRawMode = () => {};
process.stdout.isTTY = true;
process.stdout.columns = 120;
process.stdout.rows = 30;
let painted = 0;
const real = process.stdout.write.bind(process.stdout);
process.stdout.write = (s) => { painted += s.length; return true; };
// Present a BARE invocation: argv[1] must be the CLI itself and nothing may follow, or the target
// reads its own path as a command name and prints usage instead of opening the app.
const target = process.argv[2];
process.argv = [process.argv[0], target];
let threw = null;
try { require(target); } catch (e) { threw = e; }
setTimeout(() => {
  process.stdout.write = real;
  if (threw) { console.error('THREW: ' + threw.message); process.exit(1); }
  if (painted < 200) { console.error('painted only ' + painted + ' bytes'); process.exit(1); }
  process.exit(0);
}, 1500);
