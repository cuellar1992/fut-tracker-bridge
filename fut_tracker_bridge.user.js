// ==UserScript==
// @name         EA FC26 Tracker Bridge
// @namespace    https://github.com/local/fut-tracker
// @version      2.4
// @description  Auto-fills Transfer Market search from EA FC26 Tracker app (localhost:9876)
// @author       local
// @match        https://www.ea.com/ea-sports-fc/ultimate-team/web-app/*
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/cuellar1992/fut-tracker-bridge/main/fut_tracker_bridge.user.js
// @downloadURL  https://raw.githubusercontent.com/cuellar1992/fut-tracker-bridge/main/fut_tracker_bridge.user.js
// ==/UserScript==

(function () {
    'use strict';

    const PORT = 9876;
    const POLL_FILL_MS = 2000; // cooldown after fill (let Ember settle)
    const POLL_ERR_BASE = 3000; // tracker not running — initial backoff
    const POLL_ERR_MAX = 60000; // backoff ceiling
    const POLL_HIDDEN_MS = 5000; // tab in background

    const ni = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

    function mc(el) {
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }

    function setPlayerInput(el, text) {
        ni.call(el, text);
        el.focus();
        el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: text.slice(-1) }));
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: text.slice(-1) }));
    }

    // Type numeric value char-by-char — required for Ember to register internal state
    // Yields to event loop between digits so Ember handlers don't block main thread
    async function typeValue(el, numericValue) {
        const digits = String(numericValue);
        mc(el);
        el.focus();
        ni.call(el, '');
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
        for (const ch of digits) {
            el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: ch }));
            el.dispatchEvent(new KeyboardEvent('keypress', { bubbles: true, cancelable: true, key: ch }));
            ni.call(el, el.value.replace(/\D/g, '') + ch);
            el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: ch }));
            el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: ch }));
            await new Promise(r => setTimeout(r, 0));
        }
        el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Tab' }));
        el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    async function setPrice(maxBuyNow) {
        const filters = document.querySelectorAll('.price-filter');
        const input = filters[3]?.querySelector('input.ut-number-input-control');
        if (input && maxBuyNow) await typeValue(input, maxBuyNow);
    }

    function waitForRarityRow(timeout = 1500) {
        return new Promise(resolve => {
            const start = Date.now();
            function check() {
                const controls = document.querySelectorAll('.inline-list-select.ut-search-filter-control');
                const rarityControl = controls[2];
                const row = rarityControl?.querySelector('.ut-search-filter-control--row');
                if (row && rarityControl.offsetParent !== null) return resolve(row);
                if (Date.now() - start > timeout) return resolve(null);
                setTimeout(check, 150);
            }
            check();
        });
    }

    function waitForDropdownItems(timeout = 1000) {
        return new Promise(resolve => {
            const start = Date.now();
            function check() {
                const items = [...document.querySelectorAll('.inline-list-select.is-open li')];
                if (items.length > 1) return resolve(items);
                if (Date.now() - start > timeout) return resolve([]);
                setTimeout(check, 150);
            }
            check();
        });
    }

    async function selectRarity(rarityName) {
        const rarityRow = await waitForRarityRow(1500);
        if (!rarityRow) return;

        mc(rarityRow);
        const items = await waitForDropdownItems(1000);
        if (!items.length) return;

        const needle = rarityName.toLowerCase().trim();

        const match = items.find(li => li.textContent.trim().toLowerCase() === needle)
            || items.find(li => li.textContent.toLowerCase().includes(needle))
            || items.find(li => needle.includes(li.textContent.trim().toLowerCase()) && li.textContent.trim() !== 'Any');

        if (!match) { mc(rarityRow); return; }
        if (match.classList.contains('selected')) { mc(rarityRow); return; }
        mc(match);
    }

    async function fill(data) {
        const nameEl = document.querySelector('input.ut-text-input-control');
        if (!nameEl) return;

        setPlayerInput(nameEl, data.name);

        await new Promise(r => setTimeout(r, 700));
        const btns = [...document.querySelectorAll('.playerResultsList button')];
        const picked = btns.find(b => b.textContent.includes(String(data.rating))) || btns[0];
        if (picked) mc(picked);

        if (data.rarity) await selectRarity(data.rarity);

        await new Promise(r => setTimeout(r, 200));
        await setPrice(data.max_buy_now);
    }

    let _filling = false;
    let _errDelay = POLL_ERR_BASE;
    let _controller = null;

    function scheduleNext(ms) { setTimeout(poll, ms); }

    // Transfer Market search form fully mounted: name input + 4 price-filter slots
    function isTransferMarketReady() {
        return !!document.querySelector('input.ut-text-input-control')
            && document.querySelectorAll('.price-filter').length >= 4;
    }

    document.addEventListener('visibilitychange', () => {
        if (document.hidden && _controller) _controller.abort();
    });

    async function poll() {
        if (_filling) { scheduleNext(POLL_FILL_MS); return; }
        if (document.hidden) { scheduleNext(POLL_HIDDEN_MS); return; }
        if (!isTransferMarketReady()) { scheduleNext(1500); return; }

        _controller = new AbortController();
        const timer = setTimeout(() => _controller.abort(), 30000);

        try {
            const res = await fetch(`http://127.0.0.1:${PORT}/api/fill`, {
                signal: _controller.signal,
                cache: 'no-store',
            });
            clearTimeout(timer);
            _errDelay = POLL_ERR_BASE;
            const data = await res.json();
            if (data.name) {
                _filling = true;
                fill(data)
                    .catch(err => console.error('[FUT Tracker] fill error:', err))
                    .finally(() => {
                        _filling = false;
                        scheduleNext(POLL_FILL_MS);
                    });
                return;
            }
            // Empty response — long-poll expired server-side, brief pause then repoll
            scheduleNext(1000);
        } catch (e) {
            clearTimeout(timer);
            if (e.name === 'AbortError') {
                // Aborted: tab hidden mid-flight OR 30s client timeout (server hung). Brief pause then repoll.
                scheduleNext(document.hidden ? POLL_HIDDEN_MS : 3000);
            } else {
                // Tracker not running — exponential backoff
                scheduleNext(_errDelay);
                _errDelay = Math.min(_errDelay * 2, POLL_ERR_MAX);
            }
        } finally {
            _controller = null;
        }
    }

    scheduleNext(0);
    console.log('[FUT Tracker] Bridge v2.4 active — native fetch() localhost:' + PORT);
})();
