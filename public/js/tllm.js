'use strict';

/**
 * TLLM*meet - small UI glue kept out of Room.js to ease upstream merges.
 * Wires the items of the "Plus" menu that replace buttons removed from the bottom bar.
 */

// Libraries only needed by rare actions are loaded on first use instead of on every page load.
const TLLM_LAZY_LIBS = {
    html2canvas: 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js',
    jspdf: 'https://cdn.jsdelivr.net/npm/jspdf@3.0.4/dist/jspdf.umd.min.js',
    pdfjs: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',
};
const tllmLoaded = {};

window.tllmLoadLib = function (name) {
    const src = TLLM_LAZY_LIBS[name];
    if (!src) return Promise.reject(new Error('Unknown library ' + name));
    tllmLoaded[name] ||= new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.onload = resolve;
        script.onerror = () => {
            delete tllmLoaded[name];
            reject(new Error('Unable to load ' + name));
        };
        document.head.appendChild(script);
    });
    return tllmLoaded[name];
};

(function () {
    function onReady(fn) {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
        else fn();
    }

    onReady(() => {
        const settingsItem = document.getElementById('tllmSettingsItem');
        const gridItem = document.getElementById('tllmLayoutGridItem');
        const speakerItem = document.getElementById('tllmLayoutSpeakerItem');
        const settingsButton = document.getElementById('settingsButton');

        if (settingsItem && settingsButton) {
            settingsItem.addEventListener('click', () => settingsButton.click());
        }

        const setView = (mode) => {
            if (typeof setParticipantViewMode === 'function') setParticipantViewMode(mode);
        };
        if (gridItem) gridItem.addEventListener('click', () => setView('grid'));
        if (speakerItem) speakerItem.addEventListener('click', () => setView('speaker-top'));
    });
})();
