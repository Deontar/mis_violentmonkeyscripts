# Amazon browser reproduction

Runs the actual userscript in headless Chromium, in an isolated execution world,
against the DOM, images and styles from an external Amazon MHTML capture.
GM storage is mocked; external network requests and captured page scripts are disabled.
The MHTML and generated fixtures, screenshots and frame traces remain outside this repository.

Requires Node.js, Python 3, Playwright and Chromium. In the prepared cloud environment:

```sh
node tests/amazon-browser.cjs /absolute/external/path/Amazon.es.mhtml
```

For another Chromium installation set `CHROMIUM_PATH` to its executable.
If Playwright is unavailable, install it outside the checkout and expose its module directory
through `NODE_PATH`; do not add the input capture to Git.

Eight scenarios assert actual computed visibility in animation frames:
static filtering, unrelated continuous updates, full card replacement, replacement with
delayed title hydration, temporarily replacing the title with loading text,
a genuine lasting title change, reuse of a card for another ASIN, and delayed
hydration of a previously unknown ASIN. The static scenario additionally checks
include mode, any/all tag matching, changing tags, and clearing the filter.
The filtered target is a naturally visible Bosch product, not one of the advertisements
already hidden in the capture. The static scenario checks that filtered cards have
no layout rectangles, the next product fills the first vacated cell, and clearing
the filter restores the original grid positions.
An excluded product must remain hidden after the mutation observer has had time to run.
Each failed scenario produces a nonzero process exit status. Per-frame JSON and screenshots
are saved to a unique temporary directory printed by the runner.

Version 1.0.3 remembers accepted titles by ASIN across DOM replacements and tracks
title changes separately for each card (the capture contains duplicate ASINs).
A changed title must remain stable for `TITLE_SETTLE_MS` (600 ms) before it changes
the filter decision. This also means genuine title changes take that long to apply.
Unknown cards without a title remain hidden while a filter is active. Clearing the
filter reveals them immediately. Filtered cards use `display:none` so Amazon's native
grid reflows the remaining products without empty cells.

The rendering scenarios deliberately test plausible asynchronous DOM operations.
They do not prove that Amazon performs those exact operations in the user's live session.
A saved capture cannot replay Amazon's JavaScript, authenticated session, or the full extension.
The runner reproduces layout and DOM updates in a real browser, not a complete live Amazon session.
