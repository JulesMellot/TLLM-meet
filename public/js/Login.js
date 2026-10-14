'use strict';

// TLLM*meet admin login. The server answers with an HttpOnly session cookie (no token in JS).

const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const loginForm = document.getElementById('loginForm');
const loginBtn = document.getElementById('loginButton');
const loginBtnText = document.getElementById('loginBtnText');
const loginBtnLoader = document.getElementById('loginBtnLoader');
const joinRoomForm = document.getElementById('joinRoomForm');
const roomNameInput = document.getElementById('roomNameInput');
const createRoomBtn = document.getElementById('joinSelectRoomButton');
const togglePasswordBtn = document.getElementById('togglePassword');

// Room requested before login (/login?room=xxx): go there right after login
const requestedRoom = new URLSearchParams(window.location.search).get('room');

if (togglePasswordBtn) {
    togglePasswordBtn.onclick = () => {
        const isPassword = passwordInput.type === 'password';
        passwordInput.type = isPassword ? 'text' : 'password';
        togglePasswordBtn.querySelector('i').className = isPassword ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
        const label = isPassword ? 'Masquer le mot de passe' : 'Afficher le mot de passe';
        togglePasswordBtn.title = label;
        togglePasswordBtn.setAttribute('aria-label', label);
        togglePasswordBtn.setAttribute('aria-pressed', isPassword ? 'true' : 'false');
    };
}

function setLoginLoading(loading) {
    loginBtn.disabled = loading;
    loginBtnText.style.display = loading ? 'none' : 'inline';
    loginBtnLoader.classList.toggle('show', loading);
}

function showJoinRoomForm() {
    loginForm.style.display = 'none';
    joinRoomForm.classList.add('show');
    joinRoomForm.style.opacity = '1';
    if (roomNameInput) roomNameInput.focus();
}

function goToRoom(room) {
    window.location.href = '/join/' + encodeURIComponent(room);
}

usernameInput.onkeyup = (e) => {
    if (e.key === 'Enter') login();
};
passwordInput.onkeyup = (e) => {
    if (e.key === 'Enter') login();
};
loginBtn.onclick = () => login();

if (roomNameInput) {
    roomNameInput.onkeyup = (e) => {
        if (e.key === 'Enter') createRoom();
    };
}
createRoomBtn.onclick = () => createRoom();

// Already logged in: skip the form
axios
    .get('/admin/session')
    .then(({ data }) => {
        if (!data?.admin) return;
        if (requestedRoom) return goToRoom(requestedRoom);
        showJoinRoomForm();
    })
    .catch(() => {});

function login() {
    const username = usernameInput.value.trim();
    const password = passwordInput.value;

    if (!username || !password) {
        if (!username) highlightEmpty(usernameInput);
        if (!password) highlightEmpty(passwordInput);
        return;
    }

    setLoginLoading(true);
    hideLoginError();

    axios
        .post('/login', { username, password })
        .then(({ data }) => {
            if (data?.name) window.localStorage.peer_name = data.name;
            if (requestedRoom) return goToRoom(requestedRoom);
            setLoginLoading(false);
            showJoinRoomForm();
        })
        .catch((error) => {
            setLoginLoading(false);
            if (error.response && error.response.status === 429) {
                showLoginError('Trop de tentatives. Réessayez plus tard.');
            } else {
                showLoginError('Identifiant ou mot de passe incorrect.');
            }
        });
}

function createRoom() {
    const name = roomNameInput ? roomNameInput.value.trim() : '';
    createRoomBtn.disabled = true;
    axios
        .post('/admin/rooms', { name })
        .then(({ data }) => goToRoom(data.room))
        .catch(() => {
            createRoomBtn.disabled = false;
            // Session expired: back to the login form
            joinRoomForm.classList.remove('show');
            loginForm.style.display = '';
            showLoginError('Session expirée. Reconnectez-vous.');
        });
}

function highlightEmpty(input) {
    const group = input.closest('.login-input-group');
    if (!group) return;
    group.classList.remove('input-error');
    void group.offsetWidth; // force reflow to restart animation
    group.classList.add('input-error');
    input.focus();
    function clearError() {
        group.classList.remove('input-error');
        input.removeEventListener('input', clearError);
        input.removeEventListener('change', clearError);
        input.removeEventListener('blur', clearError);
    }
    input.addEventListener('input', clearError);
    input.addEventListener('change', clearError);
    input.addEventListener('blur', clearError);
}

function showLoginError(msg) {
    const el = document.getElementById('loginError');
    const text = document.getElementById('loginErrorText');
    if (!el || !text) return;
    text.textContent = msg;
    el.classList.add('show');
}

function hideLoginError() {
    const el = document.getElementById('loginError');
    if (el) el.classList.remove('show');
}
