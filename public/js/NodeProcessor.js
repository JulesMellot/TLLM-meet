'use strict';

// TLLM*meet: which noise suppressor to download, and downloading it once.
//
// The full RNNoise (RnnoiseSync.js) is 3.2 MB compressed: on a phone in 4G it delays the microphone
// and eats the data plan. The light one (sfu/RnnoiseLight.*, the original RNNoise model) is about
// 100 KB; it suppresses less, so the browser's own noise suppression runs with it.
// - the full one is already in the browser cache (a previous visit): full, it costs nothing
// - slow or metered connection (mobile network, data saver, 3G or less, under 5 Mbit/s): light
// - browsers that do not say (Safari, Firefox): the speed measured on this page's own scripts
// The URLs come from Room.html, versioned by HtmlInjector (cached for good).
const TllmRnnoise = (function (root) {
    const SLOW_MBPS = 5;
    const FULL_CACHED_KEY = 'tllm.rnnoise.full';
    let chosen = null;
    let loading = null;

    const url = (id, fallback) => root.document?.getElementById(id)?.href || fallback;
    const fullUrl = () => url('rnnoiseFull', '../js/RnnoiseSync.js');

    function storage(write) {
        try {
            if (write === undefined) return root.localStorage.getItem(FULL_CACHED_KEY);
            root.localStorage.setItem(FULL_CACHED_KEY, write);
        } catch (e) {
            return null;
        }
    }

    // Mbit/s measured on the page's own scripts downloaded just now (not from the cache), or null.
    // They arrive in parallel: the bytes are divided by the time from the first to the last one.
    function measuredMbps(perf, origin = root.location?.origin) {
        let bytes = 0;
        let start = Infinity;
        let end = 0;
        for (const e of perf?.getEntriesByType?.('resource') || []) {
            if (!e.transferSize || e.transferSize < 20000 || (origin && !e.name.startsWith(origin))) continue;
            if (!(e.responseEnd > e.responseStart)) continue;
            bytes += e.transferSize;
            start = Math.min(start, e.responseStart);
            end = Math.max(end, e.responseEnd);
        }
        if (bytes < 50000 || !(end > start)) return null;
        return (bytes * 8) / ((end - start) * 1000);
    }

    function choose({ connection, perf, userAgent, fullCached } = {}) {
        if (fullCached) return 'full';
        if (connection) {
            if (connection.saveData) return 'light';
            if (connection.type === 'cellular') return 'light';
            if (connection.effectiveType && connection.effectiveType !== '4g') return 'light';
            if (connection.downlink > 0) return connection.downlink < SLOW_MBPS ? 'light' : 'full';
        }
        const mbps = measuredMbps(perf);
        if (mbps !== null) return mbps < SLOW_MBPS ? 'light' : 'full';
        // Nothing known: a phone is probably on a mobile network
        return /Mobi|Android|iPhone|iPad/i.test(userAgent || '') ? 'light' : 'full';
    }

    function variant() {
        if (!chosen) {
            chosen = choose({
                connection: root.navigator?.connection,
                perf: root.performance,
                userAgent: root.navigator?.userAgent,
                fullCached: storage() === fullUrl(),
            });
            console.info('RNNoise variant', chosen);
        }
        return chosen;
    }

    async function fetchOk(target, read) {
        const response = await fetch(target);
        if (!response.ok) throw new Error('Failed to load ' + target);
        return response[read]();
    }

    // { jsContent, wasmBinary } (wasmBinary only for the light one); downloaded once
    function load() {
        if (!loading) {
            loading = (async () => {
                if (variant() === 'light') {
                    const [jsContent, wasmBinary] = await Promise.all([
                        fetchOk(url('rnnoiseLight', '../sfu/RnnoiseLight.js'), 'text'),
                        fetchOk(url('rnnoiseLightWasm', '../sfu/RnnoiseLight.wasm'), 'arrayBuffer'),
                    ]);
                    return { jsContent, wasmBinary };
                }
                const jsContent = await fetchOk(fullUrl(), 'text');
                storage(fullUrl());
                return { jsContent, wasmBinary: null };
            })();
            loading.catch(() => (loading = null));
        }
        return loading;
    }

    // Downloaded while the page opens, so the microphone does not wait for it
    function prefetch() {
        load().catch((error) => console.warn('RNNoise prefetch failed', error));
    }

    return { choose, measuredMbps, variant, load, prefetch };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) module.exports = TllmRnnoise;

// Handle UI updates and interactions
class UIManager {
    constructor(elements) {
        this.elements = elements;
    }

    updateStatus(message, type = 'info') {
        const timestamp = new Date().toLocaleTimeString();
        const printMessage = `[${timestamp}] ${message}`;
        switch (type) {
            case 'error':
                console.error(printMessage);
                break;
            case 'success':
                console.info(printMessage);
                break;
            case 'warning':
                console.warn(printMessage);
                break;
            default:
                console.log(printMessage);
                break;
        }
    }

    updateUI(isProcessing, noiseSuppressionEnabled) {
        this.updateStatus(
            `Audio processing ${isProcessing ? 'started' : 'stopped'}`,
            isProcessing ? 'success' : 'info'
        );

        this.elements.labelNoiseSuppression.style.color = noiseSuppressionEnabled ? 'lime' : 'white';
    }
}

// Handle audio worklet message processing
class MessageHandler {
    constructor(uiManager, wasmLoader) {
        this.uiManager = uiManager;
        this.wasmLoader = wasmLoader;
    }

    handleMessage(event) {
        if (event.data.type === 'request-wasm') {
            return this.wasmLoader.loadWasmBuffer();
        } else if (event.data.type === 'wasm-ready') {
            this.uiManager.updateStatus('✅ RNNoise WASM initialized successfully', 'success');
        } else if (event.data.type === 'wasm-error') {
            this.uiManager.updateStatus('❌ RNNoise WASM error: ' + event.data.error, 'error');
        } else if (event.data.type === 'vad') {
            if (event.data.isSpeech) {
                //this.uiManager.updateStatus(`🗣️ Speech detected (VAD: ${event.data.probability.toFixed(2)})`, 'info');
            }
        }
    }
}

// Handle only WASM module loading
class WasmLoader {
    constructor(uiManager, getWorkletNode) {
        this.uiManager = uiManager;
        this.getWorkletNode = getWorkletNode;
    }

    async loadWasmBuffer() {
        try {
            const workletNode = this.getWorkletNode();
            if (!workletNode) {
                this.uiManager.updateStatus('⚠️ Worklet node not available, skipping WASM load', 'warning');
                throw new Error('Worklet node is not available');
            }

            this.uiManager.updateStatus('📦 Loading RNNoise sync module...', 'info');

            // TLLM*meet: full or light variant, usually already downloaded while the page opened
            const { jsContent, wasmBinary } = await TllmRnnoise.load();
            this.uiManager.updateStatus('📦 Sending sync module to worklet...', 'info');

            const node = this.getWorkletNode();
            if (node !== workletNode) {
                this.uiManager.updateStatus('⚠️ Worklet node disconnected before WASM could be sent', 'warning');
                throw new Error('Worklet node changed during WASM loading');
            }

            // A copy of the binary is handed over, the downloaded one is kept for the next microphone
            const binary = wasmBinary ? wasmBinary.slice(0) : null;
            node.port.postMessage(
                {
                    type: 'sync-module',
                    jsContent: jsContent,
                    wasmBinary: binary,
                },
                binary ? [binary] : []
            );

            this.uiManager.updateStatus('📦 Sync module sent to worklet', 'info');
        } catch (error) {
            this.uiManager.updateStatus('❌ Failed to load sync module: ' + error.message, 'error');
            console.error('Sync module loading error:', error);
            throw error;
        }
    }
}

// Handle RNNoise processing
class RNNoiseProcessor {
    constructor() {
        this.audioContext = null;
        this.workletNode = null;
        this.mediaStream = null;
        this.sourceNode = null;
        this.destinationNode = null;
        this.isProcessing = false;
        this.noiseSuppressionEnabled = false;
        this.cancelInitialization = null;
        this.muted = false;

        this.initializeUI();
        this.initializeDependencies();
    }

    /**
     * Check if AudioWorklet and WebAssembly are supported.
     * Mobile browsers may lack AudioWorklet or restrict synchronous WASM compilation.
     * @returns {boolean}
     */
    static isSupported() {
        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            const hasAudioWorklet = AudioCtx && 'audioWorklet' in AudioCtx.prototype;
            const hasWebAssembly =
                typeof WebAssembly === 'object' &&
                typeof WebAssembly.Module === 'function' &&
                typeof WebAssembly.Instance === 'function';
            return !!(hasAudioWorklet && hasWebAssembly);
        } catch (e) {
            return false;
        }
    }

    /**
     * Probe whether the device actually supports a 48 kHz sample rate.
     * Creates a temporary AudioContext, checks the real rate, then closes it.
     * @returns {Promise<boolean>}
     */
    static async isSampleRateSupported() {
        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            const ctx = new AudioCtx({ sampleRate: 48000 });
            const actual = ctx.sampleRate;
            await ctx.close();
            return actual === 48000;
        } catch (e) {
            return false;
        }
    }

    initializeUI() {
        this.elements = {
            labelNoiseSuppression: document.getElementById('labelNoiseSuppression'),
            switchNoiseSuppression: document.getElementById('switchNoiseSuppression'),
        };
    }

    initializeDependencies() {
        this.uiManager = new UIManager(this.elements);
        this.wasmLoader = new WasmLoader(this.uiManager, () => this.workletNode);
        this.messageHandler = new MessageHandler(this.uiManager, this.wasmLoader);
    }

    async toggleProcessing(mediaStream = null) {
        this.isProcessing ? this.stopProcessing() : await this.startProcessing(mediaStream);
    }

    async startProcessing(mediaStream = null) {
        if (!mediaStream) {
            throw new Error('No media stream provided to startProcessing');
        }
        this.stopProcessing();
        let audioContext;
        let initializationTimer;
        try {
            this.uiManager.updateStatus('🎤 Starting audio processing...', 'info');

            if (!RNNoiseProcessor.isSupported()) {
                this.uiManager.updateStatus(
                    '⚠️ AudioWorklet or WebAssembly not supported, skipping RNNoise',
                    'warning'
                );
                return null;
            }

            // 48 kHz support is verified by isSampleRateSupported() at init.
            audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
            this.audioContext = audioContext;
            if (audioContext.sampleRate !== 48000) throw new Error('RNNoise requires a 48 kHz audio context');
            this.uiManager.updateStatus(
                `🎵 Audio context created with sample rate: ${this.audioContext.sampleRate}Hz`,
                'info'
            );

            if (audioContext.state === 'suspended') await audioContext.resume();
            if (this.audioContext !== audioContext) return null;
            if (audioContext.state !== 'running') throw new Error('Audio context is not running');

            this.mediaStream = mediaStream;
            if (!this.mediaStream.getAudioTracks().length) {
                throw new Error('No audio tracks found in the provided media stream');
            }

            await audioContext.audioWorklet.addModule('../js/NoiseSuppressionProcessor.js');
            if (this.audioContext !== audioContext) return null;

            const workletNode = new AudioWorkletNode(audioContext, 'NoiseSuppressionProcessor', {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [1],
            });

            this.workletNode = workletNode;
            await new Promise((resolve, reject) => {
                this.cancelInitialization = () => reject(new Error('Audio processing stopped during initialization'));
                initializationTimer = setTimeout(() => reject(new Error('RNNoise initialization timed out')), 10000);
                workletNode.port.onmessage = (event) => {
                    if (this.workletNode !== workletNode) return;
                    if (event.data.type === 'wasm-ready') resolve();
                    if (event.data.type === 'wasm-error') {
                        const error = new Error(event.data.error || 'RNNoise initialization failed');
                        reject(error);
                        if (this.isProcessing) this.onError?.(error);
                    }
                    this.messageHandler.handleMessage(event)?.catch(reject);
                };
                workletNode.onprocessorerror = () => {
                    if (this.workletNode !== workletNode) return;
                    const error = new Error('RNNoise audio worklet failed');
                    reject(error);
                    if (this.isProcessing) this.onError?.(error);
                };
            });
            if (this.workletNode !== workletNode) return null;
            this.cancelInitialization = null;

            this.sourceNode = audioContext.createMediaStreamSource(this.mediaStream);
            this.destinationNode = audioContext.createMediaStreamDestination();
            this.processedStream = this.destinationNode.stream;
            const enabled = mediaStream.getAudioTracks()[0].enabled;
            this.processedStream.getAudioTracks().forEach((track) => {
                track.enabled = enabled;
            });
            mediaStream.getAudioTracks().forEach((track) => {
                track.enabled = true;
            });

            this.sourceNode.connect(this.workletNode);
            this.workletNode.connect(this.destinationNode);
            if (this.muted) this.setMuted(true);

            this.isProcessing = true;
            this.uiManager.updateUI(this.isProcessing, this.noiseSuppressionEnabled);
            this.uiManager.updateStatus('🎤 Audio processing started', 'success');

            // Return the processed MediaStream (with noise suppression)
            return this.destinationNode.stream;
        } catch (error) {
            if (audioContext && this.audioContext !== audioContext) return null;
            this.uiManager.updateStatus('❌ Error: ' + error.message, 'error');
            console.error('RNNoise startProcessing error:', error);
            this.stopProcessing();
            return null;
        } finally {
            clearTimeout(initializationTimer);
        }
    }

    stopProcessing(stopInput = false) {
        this.cancelInitialization?.();
        this.cancelInitialization = null;
        if (this.mediaStream && this.processedStream) {
            const enabled = this.processedStream.getAudioTracks()[0]?.enabled;
            this.mediaStream.getAudioTracks().forEach((track) => {
                track.enabled = enabled !== false;
            });
        }
        if (stopInput) this.mediaStream?.getTracks?.().forEach((track) => track.stop());

        this.mediaStream = null;
        this.processedStream = null;

        // Signal the worklet to free WASM memory before disconnecting
        try {
            this.workletNode?.port?.postMessage({ type: 'destroy' });
        } catch (e) {}

        try {
            this.sourceNode?.disconnect();
        } catch (e) {}
        try {
            this.workletNode?.disconnect();
        } catch (e) {}
        try {
            this.destinationNode?.stream?.getTracks?.().forEach((t) => t.stop());
        } catch (e) {}

        if (this.audioContext && this.audioContext.state !== 'closed') {
            this.audioContext.close().catch((error) => console.warn('Audio context cleanup failed:', error));
        }
        this.audioContext = null;

        this.workletNode = null;
        this.sourceNode = null;
        this.destinationNode = null;
        this.isProcessing = false;
        this.noiseSuppressionEnabled = false;

        this.uiManager.updateUI(this.isProcessing, this.noiseSuppressionEnabled);
        this.uiManager.updateStatus('🛑 Audio processing stopped', 'info');
    }

    // TLLM*meet: while the microphone is muted the worklet outputs silence without running RNNoise
    // (the heaviest audio work of the page, for a track that sends nothing). The audio context keeps
    // running, so unmuting never depends on the browser allowing it to restart.
    setMuted(muted) {
        this.muted = !!muted;
        try {
            this.workletNode?.port?.postMessage({ type: 'mute', muted: this.muted });
        } catch (e) {}
    }

    setNoiseSuppression(enabled) {
        this.noiseSuppressionEnabled = enabled;

        if (this.workletNode) {
            this.workletNode.port.postMessage({
                type: 'enable',
                enabled: this.noiseSuppressionEnabled,
            });
        }

        this.noiseSuppressionEnabled
            ? this.uiManager.updateStatus('🔊 RNNoise enabled - background noise will be suppressed', 'success')
            : this.uiManager.updateStatus('🔇 RNNoise disabled - audio passes through unchanged', 'info');

        this.uiManager.updateUI(this.isProcessing, this.noiseSuppressionEnabled);
    }

    toggleNoiseSuppression() {
        this.setNoiseSuppression(!this.noiseSuppressionEnabled);
    }
}

// TLLM*meet: the noise suppressor is downloaded once the page has loaded, before the microphone needs it
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('load', () => {
        if (typeof BUTTONS !== 'undefined' && BUTTONS.settings?.customNoiseSuppression === false) return;
        if (!RNNoiseProcessor.isSupported()) return;
        TllmRnnoise.prefetch();
    });
}
