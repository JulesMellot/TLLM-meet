'use strict';

/**
 * TLLM*meet - small UI glue kept out of Room.js to ease upstream merges.
 * Wires the items of the "Plus" menu that replace buttons removed from the bottom bar.
 */

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
