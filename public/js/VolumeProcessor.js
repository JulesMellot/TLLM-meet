'use strict';
class VolumeProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.silenceThreshold = 0.01;
        // TLLM*meet: one message every 50 ms (the loudest block), not one per 128 samples
        // (about 375 a second, each redrawing the level bars on the main thread)
        this.intervalSec = 0.05;
        this.lastSent = 0;
        this.peak = 0;
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        if (!input || input.length === 0) {
            return true;
        }

        const inputData = input[0];
        if (!inputData || inputData.length === 0) {
            return true;
        }

        let sum = 0;
        for (let i = 0; i < inputData.length; i++) {
            sum += inputData[i] * inputData[i];
        }

        const rms = Math.sqrt(sum / inputData.length);
        const volume = Math.max(0, Math.min(1, rms * 10));

        if (volume > this.peak) this.peak = volume;
        if (currentTime - this.lastSent < this.intervalSec) return true;
        this.lastSent = currentTime;
        const peak = this.peak;
        this.peak = 0;

        // Only send if not silent
        if (peak > this.silenceThreshold) {
            this.port.postMessage({
                type: 'volumeIndicator',
                volume: peak,
            });
        }

        return true;
    }
}

registerProcessor('volume-processor', VolumeProcessor);
