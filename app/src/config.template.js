'use strict';

/**
 * ==============================================
 * TLLM*meet (fork of MiroTalk SFU v2.6.25) - Configuration File
 * ==============================================
 *
 * This file contains all configurable settings for the MiroTalk SFU application.
 * Environment variables can override most settings (see each section for details).
 *
 * Structure:
 * 1. Core System Configuration
 * 2. Server Settings
 * 3. Media Handling
 * 4. Security & Authentication
 * 5. API Configuration
 * 6. Third-Party Integrations
 * 7. UI/UX Customization
 * 8. Feature Flags
 * 9. Mediasoup (WebRTC) Settings
 */

const dotenv = require('dotenv').config();
const packageJson = require('../../package.json');
const os = require('os');
const fs = require('fs');
const splitChar = ',';

// ==============================================
// 1. Environment Detection & System Configuration
// ==============================================

const IS_DOCKER = fs.existsSync('/.dockerenv');
const ENVIRONMENT = process.env.NODE_ENV || 'development';
const ANNOUNCED_IP = process.env.SFU_ANNOUNCED_IP || '';
const LISTEN_IP = process.env.SFU_LISTEN_IP || '0.0.0.0';
const IPv4 = getIPv4();

// ==============================================
// 2. WebRTC Port Configuration
// ==============================================

const RTC_MIN_PORT = parseInt(process.env.SFU_MIN_PORT) || 40000;
const RTC_MAX_PORT = parseInt(process.env.SFU_MAX_PORT) || 40100;
const NUM_CPUS = os.cpus().length;
const NUM_WORKERS = Math.min(process.env.SFU_NUM_WORKERS || NUM_CPUS, NUM_CPUS);

// ==============================================
// Main Configuration Export
// ==============================================

module.exports = {
    // ==============================================
    // 1. Core System Configuration
    // ==============================================

    system: {
        /**
         * System Information
         * ------------------
         * - Hardware/OS details collected automatically
         * - Used for diagnostics and optimization
         */
        info: {
            environment: ENVIRONMENT,
            os: {
                type: os.type(),
                release: os.release(),
                arch: os.arch(),
            },
            cpu: {
                cores: NUM_CPUS,
                model: os.cpus()[0].model,
            },
            memory: {
                total: (os.totalmem() / 1024 / 1024 / 1024).toFixed(2) + ' GB',
            },
            isDocker: IS_DOCKER,
        },

        /**
         * Console Configuration
         * ---------------------
         * - timeZone: IANA timezone (e.g., 'Europe/Rome')
         * - debug: Enable debug logging in non-production
         * - colors: Colorized console output
         * - json: Log output in JSON format
         * - json_pretty: Pretty-print JSON logs
         */
        console: {
            timeZone: 'UTC',
            debug: ENVIRONMENT !== 'production',
            json: process.env.LOGS_JSON === 'true',
            json_pretty: process.env.LOGS_JSON_PRETTY === 'true',
            colors: process.env.LOGS_JSON === 'true' ? false : true,
        },

        /**
         * External Services Configuration
         * -------------------------------
         * - ip: Services to detect public IP address
         */
        services: {
            ip: ['http://api.ipify.org', 'http://ipinfo.io/ip', 'http://ifconfig.me/ip'],
        },
    },

    // ==============================================
    // 2. Server Configuration
    // ==============================================

    server: {
        /**
         * Host Configuration
         * ------------------
         * - hostUrl: Public URL (e.g., 'https://yourdomain.com')
         * - listen: IP and port to bind to
         */
        hostUrl: process.env.SERVER_HOST_URL || 'https://localhost:3010',
        listen: {
            ip: process.env.SERVER_LISTEN_IP || '0.0.0.0',
            port: process.env.SERVER_LISTEN_PORT || 3010,
        },

        /**
         * Security Settings
         * -----------------
         * - trustProxy: Trust X-Forwarded-For. 'true' trusts the left-most entry (spoofable);
         *               a number N trusts exactly N proxies (Cloudflare + Coolify: TRUST_PROXY=2)
         * - ssl: SSL certificate paths
         * - cors: Cross-origin resource sharing
         */
        trustProxy: require('./ClientIp').parseTrustProxy(process.env.TRUST_PROXY),
        ssl: {
            cert: process.env.SERVER_SSL_CERT || '../ssl/cert.pem',
            key: process.env.SERVER_SSL_KEY || '../ssl/key.pem',
        },
        cors: {
            origin: process.env.CORS_ORIGIN || '*',
            methods: ['GET', 'POST'],
        },

        /**
         * Embed (iframe) Restrictions
         * ---------------------------
         * Controls which origins are allowed to embed MiroTalk SFU in an <iframe>
         * via the HTTP `Content-Security-Policy: frame-ancestors` header
         * (also mirrored to `X-Frame-Options` when possible for legacy browsers).
         *
         * Behavior:
         * - Empty / unset  → header NOT set, embedding allowed anywhere (default).
         * - 'none'         → block ALL embedding (frame-ancestors 'none' + X-Frame-Options: DENY).
         * - 'self'         → only same-origin embedding (frame-ancestors 'self' + X-Frame-Options: SAMEORIGIN).
         * - list           → comma-separated origins, 'self' is always implicitly included.
         *                    Wildcards like https://*.example.com are valid in CSP.
         */
        embed: {
            allowedOrigins: process.env.ALLOWED_EMBED_ORIGINS
                ? process.env.ALLOWED_EMBED_ORIGINS.split(',')
                      .map((o) => o.trim())
                      .filter(Boolean)
                : [],
        },
    },

    // ==============================================
    // 4. Security & Authentication
    // ==============================================

    security: {
        /**
         * IP Whitelisting
         * ------------------------
         * - enabled: Restrict access to specified IPs
         * - allowedIPs: Array of permitted IP addresses
         */
        middleware: {
            IpWhitelist: {
                enabled: process.env.IP_WHITELIST_ENABLED === 'true',
                allowedIPs: process.env.IP_WHITELIST_ALLOWED
                    ? process.env.IP_WHITELIST_ALLOWED.split(splitChar)
                          .map((ip) => ip.trim())
                          .filter((ip) => ip !== '')
                    : ['127.0.0.1', '::1'],
            },
        },

        /**
         * JWT Configuration
         * ------------------------
         * - key: Secret for JWT signing (required, min 32 chars, e.g. `openssl rand -hex 32`).
         *        The server refuses to start if it is missing, weak or a published default.
         * - exp: Token expiration time
         */
        jwt: {
            key: process.env.JWT_SECRET,
            exp: process.env.JWT_EXPIRATION || '1h',
        },

        /**
         * Admin Accounts (TLLM*meet)
         * ==========================
         * Only an admin can create a meeting. Guests join an existing meeting by link, without account.
         *
         * - users        : Admin accounts, from HOST_USERS (required, the server refuses to start without one)
         *                  HOST_USERS=username:password:displayname|username2:password2:displayname2
         *                  (accounts separated by '|', fields by ':'; a 4th field is accepted and ignored)
         *                  Publicly known credentials (admin/admin, guest/guest...) are refused.
         * - sessionHours : Lifetime of the admin session cookie (default: 12)
         * - maxAttempts  : Failed logins allowed per username and IP before a temporary block
         * - minBlockTime : Block duration in minutes
         *
         * The admin is automatically presenter of every meeting they join. Guests never become
         * presenter on their own: only a presenter can promote them during the meeting.
         */
        host: {
            sessionHours: parseInt(process.env.HOST_SESSION_HOURS, 10) || 12,
            maxAttempts: process.env.HOST_MAX_LOGIN_ATTEMPTS || 5,
            minBlockTime: process.env.HOST_MIN_LOGIN_BLOCK_TIME || 15, // in minutes

            // Empty by default: a shipped username/password is a public credential, set your own.
            users: require('./AdminAuth').parseHostUsers(process.env.HOST_USERS),
        },
    },

    // ==============================================
    // 5. API Configuration
    // ==============================================

    /**
     * API Security & Endpoint Configuration
     * ====================================
     * Controls access to the SFU's API endpoints and integration settings.
     *
     * Security Settings:
     * -----------------
     * - keySecret : Authentication secret for API requests
     *               (Always override default in production)
     *
     * Endpoint Control:
     * -----------------
     * - stats      : Enable/disable system statistics endpoint [true/false] (default: true)
     * - meetings   : Enable/disable meetings list endpoint [true/false] (default: true)
     * - meeting    : Enable/disable single meeting operations [true/false] (default: true)
     * - join       : Enable/disable meeting join endpoint [true/false] (default: true)
     * - token      : Enable/disable token generation endpoint [true/false] (default: false)
     *
     * API Documentation:
     * ------------------
     * - Complete API reference: https://docs.mirotalk.com/mirotalk-sfu/api/
     */
    api: {
        keySecret: process.env.API_KEY_SECRET,
        allowed: {
            stats: process.env.API_ALLOW_STATS !== 'false',
            meetings: process.env.API_ALLOW_MEETINGS === 'true',
            meeting: process.env.API_ALLOW_MEETING !== 'false',
            meetingEnd: process.env.API_ALLOW_MEETING_END === 'true',
            join: process.env.API_ALLOW_JOIN !== 'false',
            token: process.env.API_ALLOW_TOKEN === 'true',
        },
    },

    // ==============================================
    // 6. Third-Party Integrations
    // ==============================================

    integrations: {
        /**
         * Whisper Speech-to-Text Configuration
         * ====================================
         * Server-side audio transcription using an OpenAI-compatible
         * Whisper endpoint. Works with the official OpenAI API or any
         * self-hosted, OpenAI-compatible server (whisper.cpp server,
         * faster-whisper / whisper-asr-webservice, etc.).
         *
         * When enabled, the room Transcription panel shows a "Whisper mode"
         * switch. In that mode the browser records short audio segments and
         * sends them here for transcription instead of using the browser's
         * built-in Web Speech API.
         *
         * Core Settings:
         * -------------
         * - enabled    : Enable/disable Whisper transcription [true/false] (default: false)
         * - basePath   : OpenAI-compatible API endpoint (default: 'https://api.openai.com/v1/')
         *                For a self-hosted server use e.g. 'http://localhost:8000/v1/'
         * - apiKey     : API secret key (ALWAYS store in .env). May be empty for
         *                self-hosted servers that don't require authentication.
         * - model      : Whisper model name (default: 'whisper-1')
         * - language   : Optional ISO-639-1 language hint (e.g. 'en'). Empty = auto-detect.
         *
         * Advanced Settings:
         * -----------------
         * - segmentSeconds : Length of each recorded audio segment sent for
         *                    transcription (default: 5 seconds)
         * - maxAudioBytes  : Reject audio segments larger than this (default: 25MB)
         */
        whisper: {
            enabled: process.env.WHISPER_ENABLED === 'true',
            basePath: process.env.WHISPER_BASE_PATH || 'https://api.openai.com/v1/',
            apiKey: process.env.WHISPER_API_KEY || '',
            model: process.env.WHISPER_MODEL || 'whisper-1',
            language: process.env.WHISPER_LANGUAGE || '',
            segmentSeconds: parseInt(process.env.WHISPER_SEGMENT_SECONDS) || 5,
            maxAudioBytes: parseInt(process.env.WHISPER_MAX_AUDIO_BYTES) || 25 * 1024 * 1024,
        },
    },

    // ==============================================
    // 7. UI/UX Customization
    // ==============================================

    ui: {
        /**
         * Branding & Appearance Configuration
         * -----------------------------------
         * Controls all aspects of the application's visual identity, content, and metadata.
         * Supports environment variable overrides for deployment-specific customization.
         *
         * ==============================================
         * LICENSE REQUIRED:
         * ==============================================
         * - https://codecanyon.net/item/mirotalk-sfu-webrtc-realtime-video-conferences/40769970
         */
        brand: {
            /**
             * Application Branding
             * --------------------
             * Core application identity and user interface text elements.
             *
             * Note:
             * Set BRAND_HTML_INJECTION to 'false' to disable HTML injection.
             * This allows for static branding in the public/views folder, without dynamic content injection.
             */
            htmlInjection: process.env.BRAND_HTML_INJECTION !== 'false',

            app: {
                language: process.env.UI_LANGUAGE || 'fr',
                translationMode: process.env.UI_TRANSLATION_MODE || 'native', // auto (native else Google) | native (no Google, default) | google (always Google)
                style: process.env.UI_STYLE || 'sobre', // TLLM*meet look: sobre | papier (public/css/tllm.css)
                name: process.env.APP_NAME || 'TLLM*meet',
                title: process.env.APP_TITLE || '<h1>TLLM*meet</h1>',
                description:
                    process.env.APP_DESCRIPTION ||
                    'Visioconférence privée. Les invités rejoignent par lien, sans compte.',
                joinDescription: process.env.JOIN_DESCRIPTION || 'Pick a room name.<br />How about this one?',
                joinButtonLabel: process.env.JOIN_BUTTON_LABEL || 'JOIN ROOM',
                customizeButtonLabel: process.env.CUSTOMIZE_BUTTON_LABEL || 'CUSTOMIZE ROOM',
                joinLastLabel: process.env.JOIN_LAST_LABEL || 'Your recent room:',
            },

            /**
             * Website Configuration
             * --------------------
             * Site-wide settings including icons and page-specific content.
             */
            site: {
                title: process.env.SITE_TITLE || 'TLLM*meet',
                icon: process.env.SITE_ICON_PATH || '../images/logo.svg',
                appleTouchIcon: process.env.APPLE_TOUCH_ICON_PATH || '../images/logo.svg',
                newRoomTitle: process.env.NEW_ROOM_TITLE || 'Pick name. <br />Share URL. <br />Start conference.',
                newRoomDescription:
                    process.env.NEW_ROOM_DESC || 'Each room has its disposable URL. Just pick a name and share.',
            },

            /**
             * SEO Metadata
             * ------------
             * Search engine optimization elements.
             */
            meta: {
                description: process.env.META_DESCRIPTION || 'TLLM*meet, visioconférence privée.',
                keywords: process.env.META_KEYWORDS || 'visioconférence, réunion',
            },

            /**
             * OpenGraph/Social Media
             * ---------------------
             * Metadata for rich social media sharing.
             */
            og: {
                type: process.env.OG_TYPE || 'app-webrtc',
                siteName: process.env.OG_SITE_NAME || 'TLLM*meet',
                title: process.env.OG_TITLE || 'TLLM*meet',
                description: process.env.OG_DESCRIPTION || 'Rejoindre la visio.',
                image:
                    process.env.OG_IMAGE_URL ||
                    `${process.env.SERVER_HOST_URL || 'https://localhost:3010'}/images/tllm-og.png`,
                url: process.env.OG_URL || process.env.SERVER_HOST_URL || 'https://localhost:3010',
            },

            /**
             * UI Section Visibility
             * ---------------------
             * Toggle display of various page sections.
             * TLLM*meet: upstream landing sections are hidden unless set to 'true'.
             */
            html: {
                topSponsors: process.env.SHOW_TOP_SPONSORS === 'true',
                features: process.env.SHOW_FEATURES === 'true',
                teams: process.env.SHOW_TEAMS === 'true',
                tryEasier: process.env.SHOW_TRY_EASIER === 'true',
                poweredBy: process.env.SHOW_POWERED_BY === 'true',
                sponsors: process.env.SHOW_SPONSORS === 'true',
                pastSponsors: process.env.SHOW_PAST_SPONSORS === 'true',
                advertisers: process.env.SHOW_ADVERTISERS === 'true',
                supportUs: process.env.SHOW_SUPPORT_US === 'true',
                footer: process.env.SHOW_FOOTER !== 'false',
            },

            /**
             * Who Are You? Section
             * ---------------------
             * Prompts users to identify themselves before joining a room.
             * Customizable text and button labels.
             */
            whoAreYou: {
                title: process.env.WHO_ARE_YOU_TITLE || 'TLLM*meet',
                waitingRoomHeading:
                    process.env.WHO_ARE_YOU_WAITING_ROOM_HEADING || "Cette visio n'a pas encore commencé",
                waitingRoomDescription:
                    process.env.WHO_ARE_YOU_WAITING_ROOM_DESCRIPTION ||
                    "Gardez cette page ouverte : vous entrerez automatiquement dès que l'organisateur l'ouvrira.",
                waitingRoomStatus: process.env.WHO_ARE_YOU_WAITING_ROOM_STATUS || 'Vérification…',
                waitingRoomReady: process.env.WHO_ARE_YOU_WAITING_ROOM_READY || 'La visio commence, connexion…',
                waitingRoomWaiting: process.env.WHO_ARE_YOU_WAITING_ROOM_WAITING || "En attente de l'organisateur…",
                waitingRoomHostLink: process.env.WHO_ARE_YOU_WAITING_ROOM_HOST_LINK || 'Vous organisez cette visio ?',
                waitingRoomLoginLink: process.env.WHO_ARE_YOU_WAITING_ROOM_LOGIN_LINK || 'Se connecter',
                waitingRoomElapsedJust:
                    process.env.WHO_ARE_YOU_WAITING_ROOM_ELAPSED_JUST || "Depuis moins d'une minute",
                waitingRoomElapsedMinutes:
                    process.env.WHO_ARE_YOU_WAITING_ROOM_ELAPSED_MINUTES || 'Attente : {minutes}',
                waitingRoomSongUrl: process.env.WHO_ARE_YOU_WAITING_ROOM_SONG_URL || '../sounds/waiting-music.mp3',
            },

            /**
             * Login Page Section
             * ---------------------
             * Customizable heading, description, and button label for the login page.
             */
            login: {
                heading: process.env.LOGIN_HEADING || 'Espace organisateur',
                description: process.env.LOGIN_DESCRIPTION || 'Connectez-vous pour créer une visio.',
                buttonLabel: process.env.LOGIN_BUTTON_LABEL || 'Se connecter',
            },

            /**
             * About/Credits Section
             * ---------------------
             * Contains author information, version, and support links.
             * Supports HTML content for flexible formatting.
             */
            about: {
                imageUrl: process.env.ABOUT_IMAGE_URL || '../images/logo.svg',
                title: `TLLM*meet v${packageJson.version}`,
                html: `
                    <div class="about-content">
                        <p class="about-description">
                            ${process.env.ABOUT_DESCRIPTION || 'Visioconférence privée.'}
                        </p>
                        <dl class="about-details">
                            <div>
                                <dt>Basé sur</dt>
                                <dd>
                                    <a
                                        href="https://github.com/miroslavpejic85/mirotalksfu"
                                        target="_blank"
                                        rel="noopener noreferrer"
                                    >MiroTalk SFU</a> de Miroslav Pejic
                                </dd>
                            </div>
                            <div>
                                <dt>Code source</dt>
                                <dd>
                                    <a
                                        href="${process.env.SOURCE_URL || 'https://github.com/JulesMellot/TLLM-meet'}"
                                        target="_blank"
                                        rel="noopener noreferrer"
                                    >${process.env.SOURCE_URL || 'https://github.com/JulesMellot/TLLM-meet'}</a>
                                </dd>
                            </div>
                            <div>
                                <dt>Licence</dt>
                                <dd>AGPL-3.0</dd>
                            </div>
                        </dl>
                        <footer class="about-footer">
                            MiroTalk SFU &copy; 2021-${new Date().getFullYear()} Miroslav Pejic
                        </footer>
                    </div>
                `,
            },

            //...
        },

        /**
         * Theme definitions — CSS custom properties for each theme.
         * Admins can override individual themes or add new ones.
         * The client merges these with built-in defaults, so you
         * only need to specify the properties you want to change.
         */
        themes: (() => {
            // TLLM*meet: every built-in theme maps to the flat tokens of public/css/tllm.css,
            // so a theme remembered by a browser cannot bring gradients back.
            const tllm = {
                '--body-bg': 'var(--tllm-bg)',
                '--trx-bg': 'var(--tllm-surface)',
                '--msger-bg': 'var(--tllm-surface)',
                '--left-msg-bg': 'var(--tllm-surface-2)',
                '--right-msg-bg': 'var(--tllm-surface-2)',
                '--private-msg-bg': 'var(--tllm-surface-3)',
                '--select-bg': 'var(--tllm-surface-2)',
                '--select-focus-color': 'var(--tllm-accent)',
                '--tab-btn-active': 'var(--tllm-surface-2)',
                '--settings-bg': 'var(--tllm-surface)',
                '--wb-bg': 'var(--tllm-bg)',
                '--btns-bg-color': 'var(--tllm-surface-2)',
                '--dd-color': 'var(--tllm-text)',
                '--room-switch-accent': 'var(--tllm-accent)',
                '--room-switch-ink': '#FFFFFF',
                '--swal-neutral-bg': 'var(--tllm-surface-3)',
                '--swal-focus-bg': 'var(--tllm-accent)',
            };
            const names = ['default', 'dark', 'grey', 'green', 'blue', 'red', 'purple', 'orange', 'pink', 'yellow'];
            return Object.fromEntries(names.map((name) => [name, { ...tllm }]));
        })(),

        /**
         * UI Button Configuration
         * ---------------------
         * Organized by component/functionality area
         */
        buttons: {
            // Popup Configuration
            popup: {
                shareRoomPopup: process.env.SHOW_SHARE_ROOM_POPUP !== 'false',
                shareRoomQrOnHover: process.env.SHOW_SHARE_ROOM_QR_ON_HOVER !== 'false',
            },
            // Main control buttons visible in the UI
            main: {
                shareButton: process.env.SHOW_SHARE_BUTTON !== 'false',
                hideMeButton: process.env.SHOW_HIDE_ME === 'true', // TLLM*meet: off by default (shorter "Plus" menu)
                fullScreenButton: process.env.SHOW_FULLSCREEN_BUTTON !== 'false',
                startAudioButton: process.env.SHOW_AUDIO_BUTTON !== 'false',
                startVideoButton: process.env.SHOW_VIDEO_BUTTON !== 'false',
                startScreenButton: process.env.SHOW_SCREEN_BUTTON !== 'false',
                swapCameraButton: process.env.SHOW_SWAP_CAMERA !== 'false',
                chatButton: process.env.SHOW_CHAT_BUTTON !== 'false',
                participantsButton: process.env.SHOW_PARTICIPANTS_BUTTON !== 'false',
                pollButton: process.env.SHOW_POLL_BUTTON !== 'false',
                speechRecButton: process.env.SHOW_SPEECH_REC_BUTTON === 'true', // TLLM*meet: off by default (shorter "Plus" menu)
                breakoutRoomButton: process.env.SHOW_BREAKOUT_ROOM_BUTTON !== 'false',
                editorButton: process.env.SHOW_EDITOR_BUTTON !== 'false',
                raiseHandButton: process.env.SHOW_RAISE_HAND !== 'false',
                transcriptionButton: process.env.SHOW_TRANSCRIPTION !== 'false',
                whiteboardButton: process.env.SHOW_WHITEBOARD !== 'false',
                documentPiPButton: process.env.SHOW_DOCUMENT_PIP === 'true', // TLLM*meet: off by default (shorter "Plus" menu)
                snapshotRoomButton: process.env.SHOW_SNAPSHOT === 'true', // TLLM*meet: off by default (shorter "Plus" menu)
                emojiRoomButton: process.env.SHOW_EMOJI === 'true', // TLLM*meet: off by default (shorter "Plus" menu)
                settingsButton: process.env.SHOW_SETTINGS !== 'false',
                aboutButton: process.env.SHOW_ABOUT !== 'false',
                exitButton: process.env.SHOW_EXIT_BUTTON !== 'false',
                extraButton: process.env.SHOW_EXTRA_BUTTON !== 'false',
            },
            // Settings panel buttons and options
            settings: {
                fileSharing: process.env.ENABLE_FILE_SHARING !== 'false',
                lockRoomButton: process.env.SHOW_LOCK_ROOM !== 'false',
                unlockRoomButton: process.env.SHOW_UNLOCK_ROOM !== 'false',
                broadcastingButton: process.env.SHOW_BROADCASTING !== 'false',
                lobbyButton: process.env.SHOW_LOBBY !== 'false',
                joinLockButton: process.env.SHOW_JOIN_LOCK !== 'false',
                sendEmailInvitation: process.env.SHOW_EMAIL_INVITE !== 'false',
                micOptionsButton: process.env.SHOW_MIC_OPTIONS !== 'false',
                tabNetworkBtn: process.env.SHOW_NETWORK_TAB !== 'false',
                tabModerator: process.env.SHOW_MODERATOR_TAB !== 'false',
                tabRecording: process.env.SHOW_RECORDING_TAB !== 'false',
                host_only_recording: process.env.HOST_ONLY_RECORDING !== 'false',
                pushToTalk: process.env.ENABLE_PUSH_TO_TALK !== 'false',
                keyboardShortcuts: process.env.SHOW_KEYBOARD_SHORTCUTS !== 'false',
                virtualBackground: process.env.SHOW_VIRTUAL_BACKGROUND !== 'false',
                customNoiseSuppression: process.env.CUSTOM_NOISE_SUPPRESSION_ENABLED !== 'false',
            },

            // Video controls for producer (local user)
            producerVideo: {
                videoPictureInPicture: process.env.ENABLE_PIP !== 'false',
                videoMirrorButton: process.env.SHOW_MIRROR_BUTTON !== 'false',
                pinVideoButton: process.env.SHOW_PIN_BUTTON !== 'false',
                fullScreenButton: process.env.SHOW_FULLSCREEN !== 'false',
                snapShotButton: process.env.SHOW_SNAPSHOT_BUTTON !== 'false',
                focusVideoButton: process.env.SHOW_FOCUS_BUTTON !== 'false',
                muteAudioButton: process.env.SHOW_MUTE_AUDIO !== 'false',
                videoPrivacyButton: process.env.SHOW_PRIVACY_TOGGLE !== 'false',
                audioVolumeInput: process.env.SHOW_VOLUME_CONTROL !== 'false',
                drawingButton: process.env.SHOW_DRAWING_BUTTON !== 'false',
            },

            // Video controls for consumer (remote users)
            consumerVideo: {
                videoPictureInPicture: process.env.ENABLE_PIP !== 'false',
                videoMirrorButton: process.env.SHOW_MIRROR_BUTTON !== 'false',
                pinVideoButton: process.env.SHOW_PIN_BUTTON !== 'false',
                fullScreenButton: process.env.SHOW_FULLSCREEN !== 'false',
                snapShotButton: process.env.SHOW_SNAPSHOT_BUTTON !== 'false',
                focusVideoButton: process.env.SHOW_FOCUS_BUTTON !== 'false',
                hideFromGridButton: process.env.SHOW_HIDE_FROM_GRID_BUTTON !== 'false',
                sendMessageButton: process.env.SHOW_SEND_MESSAGE !== 'false',
                sendFileButton: process.env.SHOW_SEND_FILE !== 'false',
                sendVideoButton: process.env.SHOW_SEND_VIDEO !== 'false',
                muteVideoButton: process.env.SHOW_MUTE_VIDEO !== 'false',
                muteAudioButton: process.env.SHOW_MUTE_AUDIO !== 'false',
                audioVolumeInput: process.env.SHOW_VOLUME_CONTROL !== 'false',
                geolocationButton: process.env.SHOW_GEO_LOCATION !== 'false',
                banButton: process.env.SHOW_BAN_BUTTON !== 'false',
                ejectButton: process.env.SHOW_EJECT_BUTTON !== 'false',
                presenterRoleButton: process.env.SHOW_PRESENTER_ROLE_BUTTON !== 'false',
                drawingButton: process.env.SHOW_DRAWING_BUTTON !== 'false',
            },

            // Controls when video is off
            videoOff: {
                pinVideoButton: process.env.SHOW_PIN_BUTTON !== 'false',
                hideFromGridButton: process.env.SHOW_HIDE_FROM_GRID_BUTTON !== 'false',
                sendMessageButton: process.env.SHOW_SEND_MESSAGE !== 'false',
                sendFileButton: process.env.SHOW_SEND_FILE !== 'false',
                sendVideoButton: process.env.SHOW_SEND_VIDEO !== 'false',
                muteAudioButton: process.env.SHOW_MUTE_AUDIO !== 'false',
                audioVolumeInput: process.env.SHOW_VOLUME_CONTROL !== 'false',
                geolocationButton: process.env.SHOW_GEO_LOCATION !== 'false',
                banButton: process.env.SHOW_BAN_BUTTON !== 'false',
                ejectButton: process.env.SHOW_EJECT_BUTTON !== 'false',
                presenterRoleButton: process.env.SHOW_PRESENTER_ROLE_BUTTON !== 'false',
            },

            // Controls for shared video/audio feeds
            videoShare: {
                pinVideoButton: process.env.SHOW_PIN_BUTTON !== 'false',
                fullScreenButton: process.env.SHOW_FULLSCREEN !== 'false',
            },

            // Chat interface controls
            chat: {
                chatPinButton: process.env.SHOW_CHAT_PIN !== 'false',
                chatMaxButton: process.env.SHOW_CHAT_MAXIMIZE !== 'false',
                chatSaveButton: process.env.SHOW_CHAT_SAVE !== 'false',
                chatEmojiButton: process.env.SHOW_CHAT_EMOJI !== 'false',
                chatMarkdownButton: process.env.SHOW_CHAT_MARKDOWN !== 'false',
                chatSpeechStartButton: process.env.SHOW_CHAT_SPEECH !== 'false',
                chatTyping: process.env.ENABLE_CHAT_TYPING !== 'false',
            },

            // Poll interface controls
            poll: {
                pollPinButton: process.env.SHOW_POLL_PIN !== 'false',
                pollMaxButton: process.env.SHOW_POLL_MAXIMIZE !== 'false',
                pollSaveButton: process.env.SHOW_POLL_SAVE !== 'false',
            },

            // Participants list controls
            participantsList: {
                saveInfoButton: process.env.SHOW_SAVE_INFO !== 'false',
                sendFileAllButton: process.env.SHOW_SEND_FILE_ALL !== 'false',
                ejectAllButton: process.env.SHOW_EJECT_ALL !== 'false',
                sendFileButton: process.env.SHOW_SEND_FILE !== 'false',
                geoLocationButton: process.env.SHOW_GEO_LOCATION !== 'false',
                banButton: process.env.SHOW_BAN_BUTTON !== 'false',
                ejectButton: process.env.SHOW_EJECT_BUTTON !== 'false',
                presenterRoleButton: process.env.SHOW_PRESENTER_ROLE_BUTTON !== 'false',
            },

            // Whiteboard controls
            whiteboard: {
                whiteboardLockButton: process.env.SHOW_WB_LOCK !== 'false',
            },
        },
    },

    // ==============================================
    // 8. Feature Flags
    // ==============================================

    features: {
        /**
         * Survey Configuration (QuestionPro)
         * =================================
         * Settings for user feedback and survey integration
         *
         * Setup Instructions:
         * ------------------
         * 1. Sign up at https://www.questionpro.com/
         * 2. Create survey:
         *    - Use template or custom questions
         *    - Configure survey logic and branching
         * 3. Get survey URL:
         *    - Publish survey
         *    - Copy "Collect Responses" link
         */
        survey: {
            enabled: process.env.SURVEY_ENABLED === 'true',
            url: process.env.SURVEY_URL || '',
        },

        /**
         * Post-Call Redirect
         * ---------------------
         * - enabled: Redirect after call ends
         * - url: Redirect destination URL
         */
        redirect: {
            enabled: process.env.REDIRECT_ENABLED === 'true',
            url: process.env.REDIRECT_URL || '',
        },

        /**
         * Socket.IO createRoom and HTTP /createRoomToken rate limit (per IP)
         * -------------------------------------------------------------------
         * Prevents unauthenticated sockets from spamming arbitrary entries
         * into the in-memory roomList,
         * and throttles room creation token requests.
         */
        createRoomRateLimit: {
            windowMs: Math.max(parseInt(process.env.CREATE_ROOM_RATE_LIMIT_WINDOW_MINUTES, 10) || 1, 1) * 60 * 1000,
            max: Math.max(parseInt(process.env.CREATE_ROOM_RATE_LIMIT_MAX, 10) || 10, 1),
        },
    },

    /**
     * Moderation Configuration
     * =======================
     * Controls global moderation features.
     *
     * Core Settings:
     * --------------
     * - room.maxParticipants: Maximum number of participants allowed per room.
     * - lobby: Enable/disable lobby feature for pre-approval of participants.
     *   Adjust to limit room size and manage server load.
     */
    moderation: {
        room: {
            maxParticipants: parseInt(process.env.ROOM_MAX_PARTICIPANTS) || 1000, // Maximum participants per room
            lobby: process.env.ROOM_LOBBY === 'true', // Enable lobby feature
        },
    },

    // ==============================================
    // 9. Mediasoup (WebRTC) Configuration
    // ==============================================

    /**
     * Mediasoup Integration Resources
     * ==============================
     * Core WebRTC components powering MiroTalk SFU
     *
     * Essential Links:
     * ---------------
     * - 🌐 Website     : https://mediasoup.org
     * - 💬 Forum       : https://mediasoup.discourse.group
     *
     * 📚 Documentation:
     * ----------------
     * - Client API     : https://mediasoup.org/documentation/v3/mediasoup-client/api/
     * - Server API     : https://mediasoup.org/documentation/v3/mediasoup/api/
     * - Protocols      : https://mediasoup.org/documentation/v3/mediasoup/rtp-parameters-and-capabilities/
     *
     * 🔧 Key Components:
     * -----------------
     * - Router         : Manages RTP streams
     * - Transport      : Network connection handler
     * - Producer       : Media sender
     * - Consumer       : Media receiver
     *
     * Mediasoup Configuration
     * -----------------------
     * This configuration defines settings for mediasoup workers, routers,
     * WebRTC servers, and transports. These settings control how the SFU
     * (Selective Forwarding Unit) handles media processing and networking.
     */
    mediasoup: {
        /**
         * Worker Configuration
         * --------------------
         * Workers are separate processes that handle media processing.
         * Multiple workers can run in parallel for load balancing.
         */
        worker: {
            rtcMinPort: RTC_MIN_PORT, // Minimum UDP/TCP port for ICE, DTLS, RTP
            rtcMaxPort: RTC_MAX_PORT, // Maximum UDP/TCP port for ICE, DTLS, RTP

            // Disable Linux io_uring for certain operations (false = use if available)
            disableLiburing: false,

            // Logging level (error, warn, debug, etc.)
            logLevel: process.env.MEDIASOUP_LOG_LEVEL || 'error',

            // Detailed logging for specific components:
            logTags: [
                'info', // General information
                'ice', // ICE (Interactive Connectivity Establishment) events
                'dtls', // DTLS handshake and encryption
                'rtp', // RTP packet flow
                'srtp', // Secure RTP encryption
                'rtcp', // RTCP control protocol
                'rtx', // Retransmissions
                'bwe', // Bandwidth estimation
                'score', // Network score calculations
                'simulcast', // Simulcast layers
                'svc', // Scalable Video Coding
                'sctp', // SCTP data channels
            ],
        },
        numWorkers: NUM_WORKERS, // Number of mediasoup worker processes to create

        /**
         * Router Configuration
         * --------------------
         * Routers manage media streams and define what codecs are supported.
         * Each mediasoup worker can host multiple routers.
         */
        router: {
            // Enable audio level monitoring (for detecting who is speaking)
            audioLevelObserverEnabled: process.env.MEDIASOUP_ROUTER_AUDIO_LEVEL_OBSERVER_ENABLED !== 'false',

            // Disable active speaker detection (uses more CPU)
            activeSpeakerObserverEnabled: process.env.MEDIASOUP_ROUTER_ACTIVE_SPEAKER_OBSERVER_ENABLED === 'true',

            /**
             * Supported Media Codecs
             * ----------------------
             * Defines what codecs the SFU can receive and forward.
             * Order matters - first is preferred during negotiation.
             */
            mediaCodecs: [
                // Opus audio codec (standard for WebRTC)
                {
                    kind: 'audio',
                    mimeType: 'audio/opus',
                    clockRate: 48000, // Standard sample rate for WebRTC
                    channels: 2, // Stereo audio
                },

                // VP8 video codec (widely supported, good for compatibility)
                {
                    kind: 'video',
                    mimeType: 'video/VP8',
                    clockRate: 90000, // Standard video clock rate
                    parameters: {
                        'x-google-start-bitrate': 1000, // Initial bitrate (kbps)
                    },
                },

                // VP9 video codec (better compression than VP8)
                // Profile 0: Most widely supported VP9 profile
                {
                    kind: 'video',
                    mimeType: 'video/VP9',
                    clockRate: 90000,
                    parameters: {
                        'profile-id': 0, // Baseline profile
                        'x-google-start-bitrate': 1000,
                    },
                },

                // VP9 Profile 2: Supports HDR and 10/12-bit color
                {
                    kind: 'video',
                    mimeType: 'video/VP9',
                    clockRate: 90000,
                    parameters: {
                        'profile-id': 2, // Advanced profile
                        'x-google-start-bitrate': 1000,
                    },
                },

                // H.264 Baseline profile (widest hardware support)
                {
                    kind: 'video',
                    mimeType: 'video/h264',
                    clockRate: 90000,
                    parameters: {
                        'packetization-mode': 1, // Required for WebRTC
                        'profile-level-id': '42e01f', // Baseline 3.1
                        'level-asymmetry-allowed': 1, // Allows different levels
                        'x-google-start-bitrate': 1000,
                    },
                },

                // H.264 Main profile (better compression than Baseline)
                {
                    kind: 'video',
                    mimeType: 'video/h264',
                    clockRate: 90000,
                    parameters: {
                        'packetization-mode': 1,
                        'profile-level-id': '4d0032', // Main 4.0
                        'level-asymmetry-allowed': 1,
                        'x-google-start-bitrate': 1000,
                    },
                },
            ],
        },

        /**
         * WebRTC Server Configuration
         * ---------------------------
         * WebRTC servers handle ICE (connection establishment) and DTLS (encryption).
         * Can be disabled if using plain WebRtcTransport instead.
         *
         * Best used when:
         * - Running in controlled environments with fixed IPs
         * - Need to minimize port usage across workers
         * - Using StatefulSets/DaemonSets in Kubernetes
         *
         * Kubernetes considerations:
         * - Requires stable network identity (use StatefulSet)
         * - Needs NodePort/LoadBalancer with externalTrafficPolicy: Local
         * - Port ranges must be carefully allocated to avoid conflicts
         *
         * Optional Config:
         * - https://mediasoup.discourse.group/t/mediasoup-3-17-0-released/6805
         */
        webRtcServerActive: process.env.SFU_SERVER === 'true', // Enable if SFU_SERVER=true
        webRtcServerOptions: {
            // Network interfaces and ports for ICE candidates
            listenInfos: [
                /**
                 * UDP Configuration
                 * Preferred for media transport (lower latency)
                 * Kubernetes implications:
                 * - Each Pod needs unique ports if sharing host network
                 * - Consider using hostPort when not using LoadBalancer
                 */
                {
                    protocol: 'udp',
                    ip: LISTEN_IP, // Local IP to bind to
                    announcedAddress: IPv4, // Public IP sent to clients
                    portRange: {
                        min: RTC_MIN_PORT,
                        max: RTC_MIN_PORT + NUM_WORKERS, // Port range per worker
                    },
                },
                /**
                 * TCP Configuration
                 * Fallback for restrictive networks (higher latency)
                 * Kubernetes implications:
                 * - Helps with networks blocking UDP
                 * - May require separate Service definition in k8s
                 */
                {
                    protocol: 'tcp',
                    ip: LISTEN_IP,
                    announcedAddress: IPv4,
                    portRange: {
                        min: RTC_MIN_PORT,
                        max: RTC_MIN_PORT + NUM_WORKERS,
                    },
                },
            ],
        },

        /**
         * WebRTC Transport Configuration
         * ------------------------------
         * Transports handle the actual media flow between clients and the SFU.
         * These settings affect bandwidth management and network behavior.
         *
         * Preferred when:
         * - Running in cloud environments with auto-scaling
         * - Need dynamic port allocation
         * - Kubernetes Pods are ephemeral
         *
         * Kubernetes considerations:
         * - Requires wide port range exposure (50000-60000 typical)
         * - Works better with ClusterIP Services
         * - More resilient to Pod restarts
         */
        webRtcTransport: {
            // Network interfaces for media transmission
            listenInfos: [
                /**
                 * UDP Transport Settings
                 * Kubernetes implications:
                 * - Needs hostNetwork or privileged Pod for port access
                 * - Consider port range size based on expected scale
                 */
                {
                    protocol: 'udp',
                    ip: LISTEN_IP,
                    announcedAddress: IPv4,
                    portRange: {
                        min: RTC_MIN_PORT,
                        max: RTC_MAX_PORT, // Wider range than WebRtcServer
                    },
                },
                /**
                 * TCP Transport Settings
                 * Kubernetes implications:
                 * - Less efficient but more compatible
                 * - May require different Service configuration
                 */
                {
                    protocol: 'tcp',
                    ip: LISTEN_IP,
                    announcedAddress: IPv4,
                    portRange: {
                        min: RTC_MIN_PORT,
                        max: RTC_MAX_PORT,
                    },
                },
            ],

            iceConsentTimeout: 35, // Timeout for ICE consent (seconds)

            /**
             * Bandwidth Control Settings
             * Kubernetes implications:
             * - These values should be tuned based on Node resources
             * - Consider network plugin overhead (Calico, Cilium etc.)
             */
            initialAvailableOutgoingBitrate: 2500000, // 2.5 Mbps initial bitrate
            minimumAvailableOutgoingBitrate: 1000000, // 1 Mbps minimum guaranteed
            maxIncomingBitrate: 3000000, // 3 Mbps max per producer

            /**
             * Data Channel Settings (mediasoup 3.20.0+)
             * - maxSendMessageSize    : Max size for outgoing SCTP messages (data channels)
             * - maxReceiveMessageSize : Max size for incoming SCTP messages (data channels)
             * Replaces the legacy `maxSctpMessageSize` / `numSctpStreams` options.
             * Kubernetes implications:
             * - Affects memory allocation per transport
             * - Larger sizes may require Pod resource adjustments
             */
            maxSendMessageSize: 262144, // 256 KB max outgoing data-channel message size
            maxReceiveMessageSize: 262144, // 256 KB max incoming data-channel message size
        },
    },
};

// ==============================================
// Helper Functions
// ==============================================

/**
 * Get IPv4 Address
 * ----------------
 * - Prioritizes ANNOUNCED_IP if set
 * - Falls back to local IP detection
 */
function getIPv4() {
    if (ANNOUNCED_IP) return ANNOUNCED_IP;

    switch (ENVIRONMENT) {
        case 'development':
            return IS_DOCKER ? '127.0.0.1' : getLocalIPv4();
        case 'production':
            return ANNOUNCED_IP;
        default:
            return getLocalIPv4();
    }
}

/**
 * Detect Local IPv4 Address
 * -------------------------
 * - Handles different OS network interfaces
 * - Filters out virtual/docker interfaces
 */
function getLocalIPv4() {
    const ifaces = os.networkInterfaces();
    const platform = os.platform();

    const PRIORITY_CONFIG = {
        win32: [{ name: 'Ethernet' }, { name: 'Wi-Fi' }, { name: 'Local Area Connection' }],
        darwin: [{ name: 'en0' }, { name: 'en1' }],
        linux: [{ name: 'eth0' }, { name: 'wlan0' }],
    };

    const VIRTUAL_INTERFACES = {
        all: ['docker', 'veth', 'tun', 'lo'],
        win32: ['Virtual', 'vEthernet', 'Teredo', 'Bluetooth'],
        darwin: ['awdl', 'bridge', 'utun'],
        linux: ['virbr', 'kube', 'cni'],
    };

    const platformPriorities = PRIORITY_CONFIG[platform] || [];
    const virtualExcludes = [...VIRTUAL_INTERFACES.all, ...(VIRTUAL_INTERFACES[platform] || [])];

    // Check priority interfaces first
    for (const { name: ifName } of platformPriorities) {
        const matchingIfaces = platform === 'win32' ? Object.keys(ifaces).filter((k) => k.includes(ifName)) : [ifName];
        for (const interfaceName of matchingIfaces) {
            const addr = findValidAddress(ifaces[interfaceName]);
            if (addr) return addr;
        }
    }

    // Fallback to scanning all non-virtual interfaces
    const fallbackAddress = scanAllInterfaces(ifaces, virtualExcludes);
    if (fallbackAddress) return fallbackAddress;

    return '0.0.0.0';
}

/**
 * Scan All Network Interfaces
 * ---------------------------
 * - Checks all interfaces excluding virtual ones
 */
function scanAllInterfaces(ifaces, excludes) {
    for (const [name, addresses] of Object.entries(ifaces)) {
        if (excludes.some((ex) => name.toLowerCase().includes(ex.toLowerCase()))) {
            continue;
        }
        const addr = findValidAddress(addresses);
        if (addr) return addr;
    }
    return null;
}

/**
 * Find Valid Network Address
 * --------------------------
 * - Filters out internal and link-local addresses
 */
function findValidAddress(addresses) {
    return addresses?.find((addr) => addr.family === 'IPv4' && !addr.internal && !addr.address.startsWith('169.254.'))
        ?.address;
}
