// ==UserScript==
// @name         EA FC26 Tracker Bridge
// @namespace    https://github.com/local/fut-tracker
// @version      2.5
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

    // ── Native fill ──────────────────────────────────────────────────────────
    // Opens the web app's own "Search the Transfer Market" screen with the criteria
    // already set, the way the web app does it (found in FC Artemis, 2026-09-30):
    // new UTSearchCriteriaDTO → UTMarketSearchFiltersViewController.initWithSearchCriteria
    // → pushViewController on the current tab. No synthetic events, nothing sent to EA,
    // works from any screen.
    //
    // Holo / pristine share base player, rarity and rating with the standard card, and
    // EA returns at most 21 cheapest listings, so only EA's server-side defId filter
    // reaches them. The form never holds our id: the wrapped searchTransferMarket hands
    // EA a copy of the criteria with defId = [ea_id]. Standard cards get no defId.
    const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const VARIANTS = new Set(['holographic', 'pristine']);
    const MASK = 0xffffff;  // definitionId & MASK = base player (maskedDefId)
    let _exact = null;      // { id, rarity }: the variant the next searches of that player get

    function callChain(owner, methods) {
        return methods.reduce((o, m) => (o && typeof o[m] === 'function' ? o[m]() : null), owner);
    }

    function nativeReady() {
        return typeof W.UTSearchCriteriaDTO === 'function'
            && typeof W.UTMarketSearchFiltersViewController === 'function'
            && typeof W.getAppMain === 'function';
    }

    function hookSearch() {
        const item = W.services?.Item;
        if (!item || typeof item.searchTransferMarket !== 'function') return false;
        if (item.searchTransferMarket.__futTracker) return true;
        const original = item.searchTransferMarket;
        const wrapped = function (criteria, ...rest) {
            // Loose match on purpose (player + rarity, not object identity): missing the
            // defId would show standard cards at the variant's higher max price.
            if (_exact && criteria && (criteria.maskedDefId & MASK) === (_exact.id & MASK)
                && Array.isArray(criteria.rarities) && criteria.rarities.includes(_exact.rarity)) {
                const copy = Object.assign(Object.create(Object.getPrototypeOf(criteria)), criteria,
                                           { defId: [_exact.id] });
                return original.call(this, copy, ...rest);
            }
            return original.call(this, criteria, ...rest);
        };
        wrapped.__futTracker = true;
        item.searchTransferMarket = wrapped;
        return true;
    }

    // Returns true when the search screen was opened.
    function nativeFill(data) {
        const exact = VARIANTS.has(data.variant);
        if (exact && !hookSearch()) throw new Error('services.Item.searchTransferMarket not found');
        const nav = callChain(W.getAppMain(),
            ['getRootViewController', 'getPresentedViewController', 'getCurrentViewController']);
        if (!nav || typeof nav.pushViewController !== 'function') return false;

        const assetId = data.ea_id & MASK;
        const criteria = new W.UTSearchCriteriaDTO();
        criteria.type = W.SearchType?.PLAYER ?? 'player';
        criteria.maskedDefId = assetId;
        criteria.rarities = [data.rarity_id];
        if (data.max_buy_now > 0) criteria.maxBuy = data.max_buy_now;

        const controller = new W.UTMarketSearchFiltersViewController();
        controller.initWithSearchCriteria(criteria);
        const player = W.repositories?.Item?.getStaticDataByDefId?.(assetId);
        if (player && controller.viewmodel) controller.viewmodel.playerData = player;  // name box

        _exact = exact ? { id: data.ea_id, rarity: data.rarity_id } : null;
        nav.pushViewController(controller);
        console.log(`[FUT Tracker] search opened: ${data.name} rarity ${data.rarity_id} max ${data.max_buy_now}`
                    + (exact ? ` · exact ${data.variant} id ${data.ea_id}` : ''));
        return true;
    }

    async function fill(data) {
        // Native path needs the EA ids (cards discovered before v2.5 have no rarity id
        // until the next "Resetear Todo").
        if (data.ea_id > 0 && Number.isInteger(data.rarity_id) && nativeReady()) {
            if (nativeFill(data)) return;
        }
        if (VARIANTS.has(data.variant)) {
            // The DOM form can't pick a variant: it would list standard cards at this price.
            console.error(`[FUT Tracker] ${data.name} is ${data.variant}: native search unavailable, not filled`);
            return;
        }
        _exact = null;
        await domFill(data);
    }

    // Legacy DOM fill: types into the search form (only when the native path is unavailable).
    async function domFill(data) {
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
        if (!nativeReady() && !isTransferMarketReady()) { scheduleNext(1500); return; }

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
    console.log('[FUT Tracker] Bridge v2.5 active — native fetch() localhost:' + PORT);
})();
