const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const chokidar = require('chokidar');

const Logger = require('./Logger');

const log = new Logger('HtmlInjector');

class HtmlInjector {
    constructor(filesPath, config) {
        this.filesPath = filesPath; // Array of file paths to cache
        this.cache = {}; // Object to store cached files
        this.config = config; // Configuration containing metadata (OG, title, etc.)
        this.injectData = this.getInjectData(); // Initialize dynamic injection data
        this.watcher = null; // File watcher instance
        this.preloadPages(filesPath); // Preload pages at startup
        this.watchFiles(filesPath); // Watch files for changes
        log.info('filesPath cached', this.filesPath);
    }

    // Function to get dynamic data for injection (e.g., OG data, title, etc.)
    getInjectData() {
        return {
            APP_NAME: this.config?.app?.name || 'TLLM*meet',
            OG_TYPE: this.config?.og?.type || 'app-webrtc',
            OG_SITE_NAME: this.config?.og?.siteName || 'TLLM*meet',
            OG_TITLE: this.config?.og?.title || 'TLLM*meet',
            OG_DESCRIPTION: this.config?.og?.description || 'Rejoindre la visio.',
            OG_IMAGE: this.config?.og?.image || '/images/tllm-og.png',
            OG_URL: this.config?.og?.url || '/',
            // Add more data here as needed with fallbacks
        };
    }

    // TLLM*meet: add ?v=<content hash> to local JS/CSS so a new deployment is never hidden by a browser
    // or Cloudflare cache (the URL changes whenever the file changes)
    versionAssets(html, filePath) {
        const viewsDir = path.dirname(filePath);
        const publicDir = path.resolve(viewsDir, '..');
        return html.replace(/(src|href)="((?:\.\.)?\/(?:js|css|sfu)\/[^"?#]+)"/g, (match, attr, url) => {
            const file = url.startsWith('/') ? path.join(publicDir, url) : path.resolve(viewsDir, url);
            if (!file.startsWith(publicDir + path.sep)) return match;
            try {
                const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 10);
                return `${attr}="${url}?v=${hash}"`;
            } catch {
                return match; // missing file: leave the reference untouched
            }
        });
    }

    // Function to load a file into the cache
    loadFileToCache(filePath) {
        try {
            const content = this.versionAssets(fs.readFileSync(filePath, 'utf-8'), filePath);
            this.cache[filePath] = content; // Store the content in cache
        } catch (err) {
            log.error(`Error reading file: ${filePath}`, err);
        }
    }

    // Function to preload pages into the cache
    preloadPages(filePaths) {
        filePaths.forEach((filePath) => this.loadFileToCache(filePath));
    }

    // Function to watch files for changes using chokidar
    watchFiles(filePaths) {
        if (this.watcher) {
            this.watcher.close(); // Close existing watcher if any
        }

        this.watcher = chokidar.watch(filePaths, {
            persistent: true,
            ignoreInitial: true, // Ignore initial 'add' events
        });

        this.watcher
            .on('change', (filePath) => {
                log.debug(`File changed: ${filePath}`);
                this.loadFileToCache(filePath);
                log.debug(`Reloaded file ${filePath} into cache`);
            })
            .on('error', (error) => {
                log.error(`Watcher error: ${error.message}`);
            });
    }

    // Function to inject dynamic data (e.g., OG, TITLE, etc.) into a given file
    injectHtml(filePath, res) {
        const html = this.cache[filePath];

        // Always revalidate pages, so they point to the current versioned assets
        if (!res.headersSent) res.set('Cache-Control', 'no-cache');

        // Check if HTML injection is enabled in the config
        if (!this.config?.htmlInjection) {
            return res.send(html?.replace(/{{APP_NAME}}/g, 'TLLM*meet'));
        }

        if (!html) {
            log.error(`File not cached: ${filePath}`);
            if (!res.headersSent) {
                return res.status(500).send('Server Error');
            }
            return;
        }

        try {
            // Replace placeholders with dynamic data (OG, TITLE, etc.)
            const modifiedHTML = html.replace(/{{(APP_NAME|OG_[A-Z_]+)}}/g, (_, key) => {
                const value = this.injectData[key] || '';
                return String(value).replace(/[&<>"']/g, (character) => {
                    const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
                    return entities[character];
                });
            });

            if (!res.headersSent) {
                res.send(modifiedHTML);
            }
        } catch (error) {
            log.error('Error injecting HTML data:', error);
            if (!res.headersSent) {
                res.status(500).send('Server Error');
            }
        }
    }

    // Cleanup watcher when the instance is no longer needed
    cleanup() {
        if (this.watcher) {
            this.watcher.close();
        }
    }
}

module.exports = HtmlInjector;
