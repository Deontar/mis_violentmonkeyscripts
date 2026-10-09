/* Run against an EXTERNAL MHTML capture. No fixture or result is stored in the checkout. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const fixture = process.argv[2];
if (!fixture) throw new Error('Usage: node tests/amazon-browser.cjs /external/Amazon.es.mhtml');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-browser-'));
const prepared = path.join(output, 'fixture.html');
const conversion = spawnSync('python3', [path.join(__dirname, 'prepare_amazon_fixture.py'), fixture, prepared], { encoding: 'utf8' });
if (conversion.status !== 0) throw new Error(conversion.stderr);
console.log(conversion.stdout.trim());
const markup = fs.readFileSync(prepared, 'utf8');
const source = fs.readFileSync(path.join(__dirname, '..', 'amazon-tags.user.js'), 'utf8');
const selector = '[data-component-type="s-search-result"][data-asin]';
const results = [];

(async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    try {
        for (const scenario of ['static', 'unrelated-updates', 'complete-replacement', 'incomplete-replacement', 'temporary-title', 'lasting-title', 'asin-reuse', 'unknown-title']) {
            const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            // Fulfill just the captured page; never contact Amazon or any remote resource.
            await page.route('**/*', route => route.request().isNavigationRequest()
                ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: markup }) : route.abort());
            try {
                await page.goto('https://www.amazon.es/s?offline-userscript-test', { waitUntil: 'load' });
                const layoutBefore = await page.evaluate(selector => {
                    const visible = [...document.querySelectorAll(selector)].filter(card => card.getBoundingClientRect().width > 0);
                    const position = card => {
                        const rect = card.getBoundingClientRect();
                        return { asin: card.dataset.asin, x: rect.x + scrollX, y: rect.y + scrollY };
                    };
                    return { first: position(visible[0]), follower: position(visible[1]) };
                }, selector);
                // An isolated execution world approximates the userscript sandbox; GM storage is mocked.
                const session = await context.newCDPSession(page);
                const { frameTree } = await session.send('Page.getFrameTree');
                const { executionContextId } = await session.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'userscript-test' });
                const injection = await session.send('Runtime.evaluate', {
                    contextId: executionContextId,
                    expression: `globalThis.GM_getValue = () => ({ tags: 'BÓSCH', mode: 'exclude', logic: 'any' }); globalThis.GM_setValue = () => {};\n${source}`,
                });
                assert(!injection.exceptionDetails, 'Userscript initialization failed');
                const baseline = await page.evaluate(selector => {
                    const normalize = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
                    const cards = [...document.querySelectorAll(selector)].filter(c => c.dataset.asin);
                    const matches = cards.filter(c => normalize(c.querySelector('h2')?.textContent || '').includes('bosch'));
                    const hidden = cards.filter(c => c.getAttribute('data-amazon-tags-hidden') === 'true');
                    const target = matches[0];
                    target.dataset.testTarget = 'true';
                    target.scrollIntoView({ block: 'center' });
                    return { cards: cards.length, matches: matches.length, hidden: hidden.length };
                }, selector);
                assert(baseline.cards > 0 && baseline.matches > 0, 'Capture must contain real matching products');
                assert.equal(baseline.hidden, baseline.matches);
                if (scenario === 'static') {
                    const layout = await page.evaluate(({ selector, layoutBefore }) => {
                        const cards = [...document.querySelectorAll(selector)];
                        const filtered = cards.filter(c => c.getAttribute('data-amazon-tags-hidden') === 'true');
                        const follower = cards.find(c => c.dataset.asin === layoutBefore.follower.asin && c.getBoundingClientRect().width > 0);
                        const rect = follower.getBoundingClientRect();
                        return {
                            collapsed: filtered.every(c => c.getClientRects().length === 0),
                            follower: { x: rect.x + scrollX, y: rect.y + scrollY },
                        };
                    }, { selector, layoutBefore });
                    assert(layout.collapsed, 'Filtered cards still occupy layout space');
                    assert(Math.abs(layout.follower.x - layoutBefore.first.x) < 1 && Math.abs(layout.follower.y - layoutBefore.first.y) < 1, 'The next product did not fill the vacated grid cell');
                }
                const trace = await page.evaluate(async scenario => {
                    let card = document.querySelector('[data-test-target="true"]');
                    const originalTitle = card.querySelector('h2').textContent;
                    const frames = [];
                    const start = performance.now();
                    let step = 0;
                    await new Promise(resolve => {
                        function frame() {
                            const elapsed = performance.now() - start;
                            if (elapsed >= 150 && step === 0) {
                                step++;
                                if (scenario.endsWith('replacement')) {
                                    const replacement = card.cloneNode(true);
                                    replacement.removeAttribute('data-amazon-tags-hidden');
                                    if (scenario === 'incomplete-replacement') replacement.querySelector('h2').remove();
                                    card.replaceWith(replacement);
                                    card = replacement;
                                } else if (scenario === 'temporary-title') card.querySelector('h2').textContent = 'Cargando producto…';
                                else if (scenario === 'lasting-title') card.querySelector('h2').textContent = 'Producto manual';
                                else if (scenario === 'asin-reuse') {
                                    card.dataset.asin = 'TEST-NEW-ASIN';
                                    card.querySelector('h2').textContent = 'Producto manual';
                                } else if (scenario === 'unknown-title') {
                                    const replacement = card.cloneNode(true);
                                    replacement.dataset.asin = 'TEST-UNKNOWN-ASIN';
                                    replacement.removeAttribute('data-amazon-tags-hidden');
                                    replacement.querySelector('h2').remove();
                                    card.replaceWith(replacement);
                                    card = replacement;
                                }
                            }
                            if (elapsed >= 500 && step === 1) {
                                step++;
                                if (scenario === 'incomplete-replacement') {
                                    const title = document.createElement('h2'); title.textContent = originalTitle; card.append(title);
                                } else if (scenario === 'temporary-title') card.querySelector('h2').textContent = originalTitle;
                                else if (scenario === 'unknown-title') {
                                    const title = document.createElement('h2'); title.textContent = 'Producto manual'; card.append(title);
                                }
                            }
                            if (scenario === 'unrelated-updates') {
                                const widget = document.querySelector('#offline-noise') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'offline-noise' }));
                                widget.textContent = String(elapsed);
                            }
                            const rect = card.getBoundingClientRect();
                            frames.push({ ms: Math.round(elapsed), hidden: getComputedStyle(card).display === 'none', height: Math.round(rect.height), width: Math.round(rect.width) });
                            if (elapsed < 1100) requestAnimationFrame(frame); else resolve();
                        }
                        requestAnimationFrame(frame);
                    });
                    return frames;
                }, scenario);
                fs.writeFileSync(path.join(output, `${scenario}.json`), JSON.stringify(trace, null, 2));
                await page.screenshot({ path: path.join(output, `${scenario}.png`) });
                // Ignore the very frame in which the test mutates the DOM; the observer has not run yet.
                const visibleFrames = trace.filter(f => f.ms >= 200 && f.ms < 500 && !f.hidden);
                assert.equal(errors.length, 0, errors.join('\n'));
                if (scenario === 'asin-reuse') {
                    assert.equal(trace.filter(f => f.ms >= 200 && f.ms < 500 && f.hidden).length, 0, 'A new nonmatching ASIN inherited the old filter');
                } else assert.equal(visibleFrames.length, 0, `${visibleFrames.length} rendered frames exposed an excluded product`);
                if (['lasting-title', 'asin-reuse', 'unknown-title'].includes(scenario)) {
                    assert(trace.filter(f => f.ms >= 950).every(f => !f.hidden), 'A genuine new title/product remained hidden');
                } else assert(trace.filter(f => f.ms >= 950).every(f => f.hidden), 'The excluded product became visible after hydration');
                if (scenario === 'static') {
                    const controls = await page.evaluate(async selector => {
                        const panel = [...document.querySelectorAll('div')].find(x => x.shadowRoot).shadowRoot;
                        const input = panel.querySelector('textarea');
                        const mode = panel.querySelector('#mode');
                        const logic = panel.querySelector('#logic');
                        const count = () => [...document.querySelectorAll(selector)].filter(c => c.dataset.asin && c.getAttribute('data-amazon-tags-hidden') === 'true').length;
                        const wait = () => new Promise(resolve => setTimeout(resolve, 40));
                        mode.value = 'include'; mode.dispatchEvent(new Event('change')); await wait();
                        const included = count();
                        mode.value = 'exclude'; input.value = 'bosch, TAG-QUE-NO-EXISTE'; logic.value = 'all'; input.dispatchEvent(new Event('input')); await wait();
                        const all = count();
                        logic.value = 'any'; logic.dispatchEvent(new Event('change')); await wait();
                        const any = count();
                        input.value = 'TAG-QUE-NO-EXISTE'; input.dispatchEvent(new Event('input')); await wait();
                        const changed = count();
                        input.value = 'bosch'; input.dispatchEvent(new Event('input')); await wait();
                        panel.querySelector('button').click(); await wait();
                        return { included, all, any, changed, cleared: count() };
                    }, selector);
                    assert.deepEqual(controls, { included: baseline.cards - baseline.matches, all: 0, any: baseline.matches, changed: 0, cleared: 0 });
                    const restored = await page.evaluate(({ selector, asin }) => {
                        const card = [...document.querySelectorAll(selector)].find(c => c.dataset.asin === asin && c.getBoundingClientRect().width > 0);
                        const rect = card.getBoundingClientRect();
                        return { x: rect.x + scrollX, y: rect.y + scrollY };
                    }, { selector, asin: layoutBefore.follower.asin });
                    assert(Math.abs(restored.x - layoutBefore.follower.x) < 1 && Math.abs(restored.y - layoutBefore.follower.y) < 1, 'Clearing the filter failed to restore grid positions');
                }
                results.push({ scenario, status: 'PASS', ...baseline });
            } catch (error) {
                results.push({ scenario, status: 'FAIL', error: error.message });
            } finally { await context.close(); }
        }
    } finally { await browser.close(); }
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
    console.table(results);
    console.log(`Evidence (external to repository): ${output}`);
    if (results.some(result => result.status === 'FAIL')) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
