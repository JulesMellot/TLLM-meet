'use strict';

// TLLM*meet: the page after leaving a call (/apres/<room>). What was spent in the room comes from
// this browser (sessionStorage, written by TllmRoom.js); whether the room is still open comes from
// GET /api/room/<id>.

(function () {
    const $ = (id) => document.getElementById(id);
    const roomId = decodeURIComponent(window.location.pathname.split('/').filter(Boolean).pop() || '');
    let visit = null;
    try {
        visit = JSON.parse(sessionStorage.getItem('tllm-after'));
    } catch {
        visit = null;
    }
    if (visit && visit.room !== roomId) visit = null;

    const hour = (ms) => new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
    const spent = (ms) => {
        const min = Math.max(1, Math.round(ms / 60000));
        return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
    };

    $('afterBack').href = `/join/${encodeURIComponent(roomId)}`;
    if (visit) {
        $('afterDuration').textContent = spent(visit.leftAt - visit.joinedAt);
        $('afterArrived').textContent = hour(visit.joinedAt);
        $('afterPeak').textContent = String(visit.maxPeers || 1);
        $('afterSpent').hidden = false;
    }

    fetch(`/api/room/${encodeURIComponent(roomId)}`, { cache: 'no-store' })
        .then((res) => (res.ok ? res.json() : null))
        .then((info) => {
            const name = info?.name || roomId;
            document.title = `${name} · TLLM*meet`;
            if (visit?.endedForAll) {
                $('afterTitle').textContent = `Vous avez terminé ${name} pour tout le monde`;
                $('afterLead').textContent =
                    'Tous les participants sont sortis. Le lien reste valable pour une prochaine fois.';
                $('afterBack').textContent = 'Rouvrir la salle';
            } else {
                $('afterTitle').textContent = `Vous êtes sorti de ${name}`;
                $('afterLead').textContent = info?.active
                    ? 'La visio continue sans vous. Le lien reste valable tant que la salle est ouverte.'
                    : 'La salle est maintenant fermée. Le lien reste valable pour une prochaine fois.';
            }
            $('afterNote').textContent =
                'Les notes partagées et le tableau blanc restent dans la salle six heures après le départ du dernier participant. Ils s’exportent depuis la visio.';
        })
        .catch(() => {
            $('afterLead').textContent = 'Le lien reste valable pour revenir.';
        });
})();
