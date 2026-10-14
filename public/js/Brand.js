'use strict';

const brandDataKey = 'brandData';
const brandData = window.sessionStorage.getItem(brandDataKey);

const title = document.getElementById('title');
const icon = document.getElementById('icon');
const appleTouchIcon = document.getElementById('appleTouchIcon');
const newRoomTitle = document.getElementById('newRoomTitle');
const newRoomDescription = document.getElementById('newRoomDescription');

const description = document.getElementById('description');
const keywords = document.getElementById('keywords');

const appTitle = document.getElementById('appTitle');
const appDescription = document.getElementById('appDescription');
const joinDescription = document.getElementById('joinDescription');
const joinRoomBtn = document.getElementById('joinRoomButton');
const customizeRoomBtn = document.getElementById('customizeRoomButton');
const joinLastLabel = document.getElementById('joinLastLabel');

const topSponsors = document.getElementById('topSponsors');
const features = document.getElementById('features');
const teams = document.getElementById('teams');
const tryEasier = document.getElementById('tryEasier');
const poweredBy = document.getElementById('poweredBy');
const sponsors = document.getElementById('sponsors');
const pastSponsors = document.getElementById('pastSponsors');
const advertisers = document.getElementById('advertisers');
const supportUs = document.getElementById('supportUs');
const footer = document.getElementById('footer');

const waitingRoomHeading = document.getElementById('waitingRoomHeading');
const waitingRoomDescription = document.getElementById('waitingRoomDescription');
const waitingRoomStatus = document.getElementById('waitingStatus');
const waitingRoomHostLink = document.getElementById('waitingRoomHostLink');
const waitingRoomLoginLink = document.getElementById('waitingRoomLoginLink');

const loginHeading = document.getElementById('loginHeading');
const loginDescription = document.getElementById('loginDescription');
const loginButton = document.getElementById('loginButton');
//...

// app/src/config.js - ui.brand
let BRAND = {
    app: {
        language: 'en',
        name: 'TLLM*meet',
        title: '<h1>TLLM*meet</h1>',
        description:
            'Visioconférence privée. Les invités rejoignent par lien, sans compte.',
        joinDescription: 'Pick a room name.<br />How about this one?',
        joinButtonLabel: 'JOIN ROOM',
        customizeButtonLabel: 'CUSTOMIZE ROOM',
        joinLastLabel: 'Your recent room:',
    },
    site: {
        title: 'TLLM*meet',
        icon: '../images/logo.svg',
        appleTouchIcon: '../images/logo.svg',
        newRoomTitle: 'Pick name. <br />Share URL. <br />Start conference.',
        newRoomDescription:
            "Each room has its disposable URL. Just pick a room name and share your custom URL. It's that easy.",
    },
    meta: {
        description:
            'TLLM*meet, visioconférence privée.',
        keywords: 'visioconférence, réunion',
    },
    html: {
        topSponsors: false,
        features: false,
        teams: false,
        tryEasier: false,
        poweredBy: false,
        sponsors: false,
        pastSponsors: false,
        advertisers: false,
        supportUs: false,
        footer: true,
    },
    whoAreYou: {
        title: 'TLLM*meet',
        waitingRoomHeading: 'Waiting for host...',
        waitingRoomDescription:
            "The meeting hasn't started yet.<br />You'll join automatically when the host opens the room.",
        waitingRoomStatus: 'Checking room status...',
        waitingRoomReady: 'Room is ready! Joining...',
        waitingRoomWaiting: 'Waiting for host to start the meeting...',
        waitingRoomHostLink: 'Are you the host?',
        waitingRoomLoginLink: 'Login here',
        waitingRoomElapsedJust: 'Just started waiting',
        waitingRoomElapsedMinutes: 'Waiting for {minutes}',
        waitingRoomSongUrl: '',
    },
    login: {
        heading: 'Welcome back',
        description: 'Enter your credentials to continue.',
        buttonLabel: 'Login',
    },
    about: {
        imageUrl: '../images/logo.svg',
        title: '<strong>TLLM*meet</strong>',
        html: `
            <div class="about-content">
                <p class="about-description">Visioconférence privée.</p>
                <dl class="about-details">
                    <div>
                        <dt>Basé sur</dt>
                        <dd>
                            <a href="https://github.com/miroslavpejic85/mirotalksfu" target="_blank" rel="noopener noreferrer"
                                >MiroTalk SFU</a
                            >
                            de Miroslav Pejic
                        </dd>
                    </div>
                    <div>
                        <dt>Licence</dt>
                        <dd>AGPL-3.0</dd>
                    </div>
                </dl>
                <footer class="about-footer">MiroTalk SFU &copy; 2021-${new Date().getFullYear()} Miroslav Pejic</footer>
            </div>
        `,
    },
    //...
};

async function initialize() {
    await getBrand();

    customizeSite();

    customizeMetaTags();

    customizeApp();

    customizeWhoAreYou();

    customizeLogin();

    checkBrand();

    // Notify listeners (e.g. I18n.js) that BRAND is fully resolved.
    document.dispatchEvent(new CustomEvent('brand:ready'));
}

async function getBrand() {
    if (brandData) {
        setBrand(JSON.parse(brandData));
    } else {
        try {
            const response = await fetch('/brand', { timeout: 5000 });
            if (!response.ok) {
                throw new Error('Network response was not ok');
            }
            const data = await response.json();
            const serverBrand = data.message;
            if (serverBrand) {
                setBrand(serverBrand);
                console.log('FETCH BRAND SETTINGS', {
                    serverBrand: serverBrand,
                    clientBrand: BRAND,
                });
                window.sessionStorage.setItem(brandDataKey, JSON.stringify(serverBrand));
            } else {
                console.warn('FETCH BRAND SETTINGS - DISABLED');
            }
        } catch (error) {
            console.error('FETCH GET BRAND ERROR', error.message);
        }
    }
}

// BRAND configurations
function setBrand(data) {
    BRAND = mergeBrand(BRAND, data);
    console.log('Set Brand done');
}

function mergeBrand(current, updated) {
    for (const key of Object.keys(updated)) {
        if (!current.hasOwnProperty(key) || typeof updated[key] !== 'object') {
            current[key] = updated[key];
        } else {
            mergeBrand(current[key], updated[key]);
        }
    }
    return current;
}

// BRAND check
function checkBrand() {
    !BRAND.html.topSponsors && elementDisplay(topSponsors, false);
    !BRAND.html.features && elementDisplay(features, false);
    !BRAND.html.teams && elementDisplay(teams, false);
    !BRAND.html.tryEasier && elementDisplay(tryEasier, false);
    !BRAND.html.poweredBy && elementDisplay(poweredBy, false);
    !BRAND.html.sponsors && elementDisplay(sponsors, false);
    !BRAND.html.pastSponsors && elementDisplay(pastSponsors, false);
    !BRAND.html.advertisers && elementDisplay(advertisers, false);
    !BRAND.html.supportUs && elementDisplay(supportUs, false);
    !BRAND.html.footer && elementDisplay(footer, false);
}

// ELEMENT display mode
function elementDisplay(element, display, mode = 'block') {
    if (!element) return;
    element.style.display = display ? mode : 'none';
}

// APP customize
function customizeApp() {
    if (appTitle && BRAND.app?.title) {
        appTitle.innerHTML = BRAND.app?.title;
    }
    if (appDescription && BRAND.app?.description) {
        appDescription.textContent = BRAND.app.description;
    }
    if (joinDescription && BRAND.app?.joinDescription) {
        joinDescription.innerHTML = BRAND.app.joinDescription;
    }
    if (joinRoomBtn && BRAND.app?.joinButtonLabel) {
        joinRoomBtn.innerText = BRAND.app.joinButtonLabel;
    }
    if (customizeRoomBtn && BRAND.app?.customizeButtonLabel) {
        customizeRoomBtn.innerText = BRAND.app.customizeButtonLabel;
    }
    if (joinLastLabel && BRAND.app?.joinLastLabel) {
        joinLastLabel.innerText = BRAND.app.joinLastLabel;
    }
}

// SITE metadata
function customizeSite() {
    // TLLM*meet look (public/css/tllm.css): sobre | papier
    document.documentElement.dataset.tllmStyle = BRAND.app?.style || 'sobre';
    if (title && BRAND.site?.title) {
        title.textContent = BRAND.site?.title;
    }
    if (icon && BRAND.site?.icon) {
        icon.href = BRAND.site?.icon;
    }
    if (appleTouchIcon && BRAND.site?.appleTouchIcon) {
        appleTouchIcon.href = BRAND.site.appleTouchIcon;
    }
    if (newRoomTitle && BRAND.site?.newRoomTitle) {
        newRoomTitle.innerHTML = BRAND.site?.newRoomTitle;
    }
    if (newRoomDescription && BRAND.site?.newRoomDescription) {
        newRoomDescription.textContent = BRAND.site.newRoomDescription;
    }
}

// SEO metadata
function customizeMetaTags() {
    if (description && BRAND.meta?.description) {
        description.content = BRAND.meta.description;
    }
    if (keywords && BRAND.meta?.keywords) {
        keywords.content = BRAND.meta.keywords;
    }
}

function customizeWhoAreYou() {
    if (waitingRoomHeading && title && BRAND.whoAreYou?.title) title.textContent = BRAND.whoAreYou.title;
    if (waitingRoomHeading && BRAND.whoAreYou?.waitingRoomHeading)
        waitingRoomHeading.textContent = BRAND.whoAreYou.waitingRoomHeading;
    if (waitingRoomDescription && BRAND.whoAreYou?.waitingRoomDescription)
        waitingRoomDescription.innerHTML = BRAND.whoAreYou.waitingRoomDescription;
    if (waitingRoomStatus && BRAND.whoAreYou?.waitingRoomStatus)
        waitingRoomStatus.textContent = BRAND.whoAreYou.waitingRoomStatus;
    if (waitingRoomHostLink && BRAND.whoAreYou?.waitingRoomHostLink)
        waitingRoomHostLink.textContent = BRAND.whoAreYou.waitingRoomHostLink;
    if (waitingRoomLoginLink && BRAND.whoAreYou?.waitingRoomLoginLink)
        waitingRoomLoginLink.textContent = BRAND.whoAreYou.waitingRoomLoginLink;
}

function customizeLogin() {
    if (loginHeading && BRAND.login?.heading) loginHeading.textContent = BRAND.login.heading;
    if (loginDescription && BRAND.login?.description) loginDescription.textContent = BRAND.login.description;
    if (BRAND.login?.buttonLabel) {
        const loginBtnText = document.getElementById('loginBtnText');
        if (loginBtnText) {
            loginBtnText.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i>&nbsp; ' + BRAND.login.buttonLabel;
        } else if (loginButton) {
            loginButton.textContent = BRAND.login.buttonLabel;
        }
    }
}

initialize();
