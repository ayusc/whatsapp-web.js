'use strict';

/* Require Optional Dependencies */
try {
    var fs = require('fs-extra');
    var AdmZip = require('adm-zip');
    var archiver = require('archiver');
} catch {
    fs = undefined;
    AdmZip = undefined;
    archiver = undefined;
}

const path = require('path');
const { Events } = require('./../util/Constants');
const BaseAuthStrategy = require('./BaseAuthStrategy');

/**
 * Remote-based authentication
 */
class RemoteAuth extends BaseAuthStrategy {
    constructor({ clientId, dataPath, store, backupSyncIntervalMs } = {}) {
        if (!fs || !AdmZip || !archiver) {
            throw new Error('Optional Dependencies [fs-extra, adm-zip, archiver] are required to use RemoteAuth.');
        }
        super();

        const idRegex = /^[-_\w]+$/i;
        this.clientId = clientId && idRegex.test(clientId) ? clientId : 'default';

        if (!backupSyncIntervalMs || backupSyncIntervalMs < 60000) {
            throw new Error('Invalid backupSyncIntervalMs. Must be >= 60000ms.');
        }

        if (!store) throw new Error('Remote database store is required.');

        this.store = store;
        this.backupSyncIntervalMs = backupSyncIntervalMs;
        this.dataPath = path.resolve(dataPath || './.wwebjs_auth/');
        this.sessionName = `RemoteAuth-${this.clientId}`;
        this.userDataDir = path.join(this.dataPath, this.sessionName);
        this.tempDir = path.join(this.dataPath, `wwebjs_temp_session_${this.clientId}`);
        this.requiredDirs = ['Default', 'IndexedDB', 'Local Storage'];
    }

    async beforeBrowserInitialized() {
        const puppeteerOpts = this.client.options.puppeteer;

        if (puppeteerOpts.userDataDir && puppeteerOpts.userDataDir !== this.userDataDir) {
            throw new Error('RemoteAuth is not compatible with a user-supplied userDataDir.');
        }

        await this.extractRemoteSession();

        this.client.options.puppeteer = {
            ...puppeteerOpts,
            userDataDir: this.userDataDir
        };
    }

    async afterAuthReady() {
        const sessionExists = await this.store.sessionExists({ session: this.sessionName });

        if (!sessionExists) {
            await this.delay(60000); // Delay to allow stable session creation
            await this.storeRemoteSession({ emit: true });
        }

        this.backupSync = setInterval(() => {
            this.storeRemoteSession();
        }, this.backupSyncIntervalMs);
    }

    async logout() {
        await this.disconnect();
    }

    async destroy() {
        clearInterval(this.backupSync);
    }

    async disconnect() {
        await this.deleteRemoteSession();

        if (await this.isValidPath(this.userDataDir)) {
            await fs.promises.rm(this.userDataDir, { recursive: true, force: true }).catch(() => {});
        }

        clearInterval(this.backupSync);
    }

    async storeRemoteSession(options) {
        const finalZipPath = `${this.sessionName}.zip`;
        const partialZipPath = `${this.sessionName}.zip.partial`;

        if (await this.isValidPath(partialZipPath)) {
            await fs.promises.unlink(partialZipPath).catch(() => {});
        }

        await this.compressSession();

        if (await this.isValidPath(finalZipPath)) {
            try {
                await this.store.save({ session: this.sessionName, path: finalZipPath });
            } catch (error) {
                console.error('[RemoteAuth] Failed to upload zip to remote store:', error.message);
            }
        } else {
            console.warn(`[RemoteAuth] Zip file ${finalZipPath} was not created.`);
        }

        await fs.promises.rm(this.tempDir, { recursive: true, force: true }).catch(() => {});

        if (options && options.emit) {
            this.client.emit(Events.REMOTE_SESSION_SAVED);
        }
    }

    async extractRemoteSession() {
        const compressedSessionPath = `${this.sessionName}.zip`;

        if (await this.store.sessionExists({ session: this.sessionName })) {
            await this.store.extract({ session: this.sessionName, path: compressedSessionPath });

            if (await this.isValidPath(compressedSessionPath)) {
                try {
                    await this.unCompressSession(compressedSessionPath);
                } catch (error) {
                    console.error('[RemoteAuth] Failed to unzip session:', error.message);
                    await fs.promises.unlink(compressedSessionPath).catch(() => {});
                }
            } else {
                console.warn(`[RemoteAuth] Zip file ${compressedSessionPath} not found after extraction.`);
            }
        } else {
            await fs.promises.mkdir(this.userDataDir, { recursive: true });
        }
    }

    async deleteRemoteSession() {
        const sessionExists = await this.store.sessionExists({ session: this.sessionName });
        if (sessionExists) {
            await this.store.delete({ session: this.sessionName });
        }
    }

    async compressSession() {
        const tempZipPath = `${this.sessionName}.zip.partial`;
        const finalZipPath = `${this.sessionName}.zip`;
        const archive = archiver('zip');
        const stream = fs.createWriteStream(tempZipPath);

        await fs.copy(this.userDataDir, this.tempDir).catch(() => {});
        await this.deleteMetadata();

        return new Promise((resolve, reject) => {
            archive.directory(this.tempDir, false).on('error', reject).pipe(stream);

            stream.on('close', async () => {
                try {
                    await fs.promises.rename(tempZipPath, finalZipPath);
                    resolve();
                } catch (err) {
                    reject(err);
                }
            });

            archive.finalize();
        });
    }

    async unCompressSession(compressedSessionPath) {
        await new Promise((resolve, reject) => {
            const zip = new AdmZip(compressedSessionPath);
            zip.extractAllToAsync(this.userDataDir, false, false, err => {
                if (err) reject(err);
                else resolve();
            });
        });

        await fs.promises.unlink(compressedSessionPath).catch(() => {});
    }

    async deleteMetadata() {
        const sessionDirs = [this.tempDir, path.join(this.tempDir, 'Default')];

        for (const dir of sessionDirs) {
            if (!(await this.isValidPath(dir))) continue;

            const sessionFiles = await fs.promises.readdir(dir).catch(() => []);
            for (const element of sessionFiles) {
                if (!this.requiredDirs.includes(element)) {
                    const dirElement = path.join(dir, element);
                    const stats = await fs.promises.lstat(dirElement).catch(() => null);
                    if (!stats) continue;

                    if (stats.isDirectory()) {
                        await fs.promises.rm(dirElement, { recursive: true, force: true }).catch(() => {});
                    } else {
                        await fs.promises.unlink(dirElement).catch(() => {});
                    }
                }
            }
        }
    }

    async isValidPath(p) {
        try {
            await fs.promises.access(p);
            return true;
        } catch {
            return false;
        }
    }

    async delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = RemoteAuth;
