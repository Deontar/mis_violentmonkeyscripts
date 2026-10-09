// ==UserScript==
// @name         Amazon.es: filtrar por tags
// @namespace    https://github.com/Deontar/mis_violentmonkeyscripts
// @version      1.0.3
// @description  Excluye o muestra productos por palabras de sus títulos.
// @match        https://www.amazon.es/*
// @match        https://amazon.es/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
    'use strict';
    const SELECTOR = '[data-component-type="s-search-result"][data-asin]';
    const KEY = 'amazon-tags-v1';
    const normalize = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
    let saved = {};
    try { saved = GM_getValue(KEY, {}) || {}; } catch (error) { console.warn('Amazon tags:', error); }
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647';
    document.body.append(host);
    const shadow = host.attachShadow({ mode: 'open' });
    // Solo plantilla estática: los tags nunca se insertan como HTML.
    shadow.innerHTML = `<style>
      :host{all:initial} details{font:14px system-ui;color:#17202a;background:white;
      border:1px solid #888;border-radius:10px;padding:12px;width:290px;box-shadow:0 3px 16px #0003}
      summary{cursor:pointer;font-weight:bold} label{display:block;margin-top:10px}
      textarea,select,button{box-sizing:border-box;font:inherit;width:100%;margin-top:5px}
      textarea{height:75px} button{cursor:pointer;padding:5px} p{margin:10px 0 0;font-size:12px}
    </style><details open><summary>Filtrar productos por tags</summary>
      <label>Tags separados por comas<textarea placeholder="manual, portátil, cuchillas"></textarea></label>
      <label>Acción<select id="mode"><option value="exclude">Excluir coincidencias</option><option value="include">Solo coincidencias</option></select></label>
      <label>Coincidir con<select id="logic"><option value="any">Cualquier tag</option><option value="all">Todos los tags</option></select></label>
      <button type="button">Limpiar filtro</button>
      <p>Busca fragmentos del título sin distinguir mayúsculas ni tildes.</p><p id="status" role="status"></p>
    </details>`;
    const input = shadow.querySelector('textarea');
    const mode = shadow.querySelector('#mode');
    const logic = shadow.querySelector('#logic');
    const status = shadow.querySelector('#status');
    input.value = typeof saved.tags === 'string' ? saved.tags : '';
    mode.value = saved.mode === 'include' ? 'include' : 'exclude';
    logic.value = saved.logic === 'all' ? 'all' : 'any';
    const hiddenStyle = document.createElement('style');
    // Quita la tarjeta del flujo: la cuadrícula de Amazon reacomoda las demás.
    hiddenStyle.textContent = '[data-amazon-tags-hidden="true"]{display:none!important}';
    document.head.append(hiddenStyle);
    // ASIN identifica al producto incluso cuando Amazon reemplaza su nodo DOM.
    const titles = new Map();
    const cardTitles = new WeakMap();
    const TITLE_SETTLE_MS = 600;
    let titleTimer;
    const observerOptions = { childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: ['data-asin', 'data-component-type', 'data-amazon-tags-hidden'] };
    const observer = new MutationObserver(records => {
        const relevant = records.some(record => {
            const element = record.target.nodeType === 1 ? record.target : record.target.parentElement;
            if (element?.closest(SELECTOR)) return true;
            return [...record.addedNodes, ...record.removedNodes].some(node =>
                node.nodeType === 1 && (node.matches(SELECTOR) || node.querySelector(SELECTOR)));
        });
        if (relevant) schedule();
    });
    function apply() {
        // Las escrituras del filtro no deben disparar otra ejecución del filtro.
        observer.disconnect();
        try {
            clearTimeout(titleTimer);
            let nextTitleCheck = Infinity;
            const now = Date.now();
            const tags = [...new Set(input.value.split(',').map(normalize).filter(Boolean))];
            let count = 0;
            let hidden = 0;
            document.querySelectorAll(SELECTOR).forEach(card => {
                if (!card.dataset.asin) return;
                count++;
                const title = card.querySelector('h2');
                const currentText = normalize(title?.textContent || '');
                const asin = card.dataset.asin;
                let record = cardTitles.get(card);
                if (!record || record.asin !== asin) {
                    record = { asin, text: titles.get(asin) || '', candidate: '', since: now };
                    cardTitles.set(card, record);
                }
                if (!record.text && currentText) {
                    record.text = currentText;
                    titles.set(asin, currentText);
                } else if (record.text) {
                    if (!currentText || currentText === record.text) {
                        record.candidate = '';
                    } else {
                        // Un título distinto debe permanecer estable antes de reemplazar al conocido.
                        if (record.candidate !== currentText) {
                            record.candidate = currentText;
                            record.since = now;
                        }
                        const remaining = TITLE_SETTLE_MS - (now - record.since);
                        if (remaining <= 0) {
                            record.text = currentText;
                            titles.set(asin, currentText);
                            record.candidate = '';
                        } else nextTitleCheck = Math.min(nextTitleCheck, remaining);
                    }
                }
                const text = record?.text || '';
                const match = tags.length > 0 && Boolean(text) &&
                    (logic.value === 'all' ? tags.every(tag => text.includes(tag)) : tags.some(tag => text.includes(tag)));
                // Sin título ni historial, no expone una tarjeta pendiente de clasificación.
                const hide = tags.length > 0 && (!text || (mode.value === 'include' ? !match : match));
                if (hide) {
                    if (card.getAttribute('data-amazon-tags-hidden') !== 'true') card.setAttribute('data-amazon-tags-hidden', 'true');
                    hidden++;
                } else if (card.hasAttribute('data-amazon-tags-hidden')) card.removeAttribute('data-amazon-tags-hidden');
            });
            const message = `${count - hidden} visibles · ${hidden} ocultos · ${count} cargados`;
            if (status.textContent !== message) status.textContent = message;
            // Acota el historial en sesiones largas; no depende de procesos ni de almacenamiento remoto.
            while (titles.size > 1000) titles.delete(titles.keys().next().value);
            if (Number.isFinite(nextTitleCheck)) titleTimer = setTimeout(schedule, Math.max(1, nextTitleCheck));
        } finally {
            observer.observe(document.body, observerOptions);
        }
    }
    let pending = false;
    function schedule() {
        if (pending) return;
        pending = true;
        queueMicrotask(() => { pending = false; apply(); });
    }
    function update() {
        try { GM_setValue(KEY, { tags: input.value, mode: mode.value, logic: logic.value }); }
        catch (error) { console.warn('No se pudo guardar el filtro:', error); }
        schedule();
    }
    input.addEventListener('input', update);
    mode.addEventListener('change', update);
    logic.addEventListener('change', update);
    shadow.querySelector('button').addEventListener('click', () => { input.value = ''; update(); });
    apply();
})();
