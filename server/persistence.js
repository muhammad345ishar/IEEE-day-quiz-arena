import { randomUUID } from 'node:crypto';
import { mkdir, chmod, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

function validateCounter(counter, filename) {
  if (!Number.isSafeInteger(counter) || counter < 0) {
    throw new Error(`Invalid player ID counter in ${filename}; refusing to reuse IDs.`);
  }
  return counter;
}

function validateSnapshot(snapshot, filename) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
    || typeof snapshot.gameId !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(snapshot.gameId)
    || !['closed', 'lobby', 'running', 'finished'].includes(snapshot.phase)
    || !Array.isArray(snapshot.players) || !Array.isArray(snapshot.questions)) {
    throw new Error(`Invalid game snapshot in ${filename}; restore the file before restarting.`);
  }
  let counter = validateCounter(snapshot.idCounter, filename);
  for (const player of snapshot.players) {
    const match = /^P-(\d+)$/.exec(player?.id);
    const number = match ? Number(match[1]) : NaN;
    if (!Number.isSafeInteger(number) || number < 1) {
      throw new Error(`Invalid player ID in ${filename}; refusing to reuse IDs.`);
    }
    counter = Math.max(counter, number);
  }
  return counter;
}

async function readJsonIfPresent(filename) {
  let source;
  try {
    source = await readFile(filename, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Cannot read ${filename}: ${error.message}`, { cause: error });
  }
  try {
    const parsed = JSON.parse(source);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected a JSON object.');
    await chmod(filename, 0o600);
    return parsed;
  } catch (error) {
    throw new Error(`Cannot load ${filename}: ${error.message}. Refusing to discard saved game data.`, { cause: error });
  }
}

/** Atomic local JSON storage. Public save promises resolve only after durable writes. */
export class JsonStore {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    this._statePath = path.join(this.dataDir, 'state.json');
    this._counterPath = path.join(this.dataDir, 'id-counter.json');
    this._archiveDir = path.join(this.dataDir, 'archives');
    this._initialized = false;
    this._initializing = null;
    this._counter = 0;
    this._durableCounter = 0;
    this._pending = null;
    this._currentBatch = null;
    this._timer = null;
    this._draining = false;
    this._drainPromise = null;
    this._failure = null;
  }

  async init() {
    if (this._initializing) return this._initializing;
    this._initializing = (async () => {
      await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
      await chmod(this.dataDir, 0o700);
      await mkdir(this._archiveDir, { recursive: true, mode: 0o700 });
      await chmod(this._archiveDir, 0o700);
      const [saved, counterFile] = await Promise.all([
        readJsonIfPresent(this._statePath), readJsonIfPresent(this._counterPath),
      ]);
      const savedCounter = saved ? validateSnapshot(saved, this._statePath) : 0;
      const counter = counterFile ? validateCounter(counterFile.counter, this._counterPath) : 0;
      this._counter = Math.max(savedCounter, counter);
      this._durableCounter = counterFile ? counter : -1;
      this._initialized = true;
      return { saved, counter: this._counter };
    })();
    return this._initializing;
  }

  _assertReady() {
    if (!this._initialized) throw new Error('Call JsonStore.init() before saving game data.');
    if (this._failure) throw this._failure;
  }

  async _writeAtomic(filename, data) {
    const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
    let file;
    try {
      file = await open(temporary, 'wx', 0o600);
      await file.writeFile(`${JSON.stringify(data)}\n`, 'utf8');
      await file.sync();
      await file.close();
      file = null;
      await rename(temporary, filename);
      // A directory sync makes the rename durable where the filesystem supports it.
      let directory;
      try {
        directory = await open(path.dirname(filename), 'r');
        await directory.sync();
      } catch (error) {
        if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(error.code)) throw error;
      } finally {
        if (directory) await directory.close();
      }
    } catch (error) {
      if (file) await file.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      throw new Error(`Cannot persist ${filename}: ${error.message}`, { cause: error });
    }
  }

  save(snapshot) {
    let copy;
    try {
      this._assertReady();
      copy = structuredClone(snapshot);
      this._counter = Math.max(this._counter, validateSnapshot(copy, this._statePath));
      copy.idCounter = this._counter;
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const waiters = this._pending?.waiters ?? [];
      waiters.push({ resolve, reject });
      this._pending = { snapshot: copy, counter: this._counter, waiters };
      if (!this._draining) this._schedule();
    });
  }

  _schedule() {
    if (this._timer || this._draining || this._failure) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this._startDrain();
    }, 8);
  }

  _startDrain() {
    if (this._draining || !this._pending || this._failure) return;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    this._draining = true;
    // Consume every internal rejection here; each caller receives the same failure.
    this._drainPromise = this._drain().catch((error) => this._fail(error)).finally(() => {
      this._draining = false;
      this._drainPromise = null;
      if (this._pending && !this._failure) this._schedule();
    });
  }

  async _drain() {
    while (this._pending) {
      const batch = this._pending;
      this._pending = null;
      this._currentBatch = batch;
      // Reserve IDs first: a crash may skip IDs, but can never reissue a saved ID.
      if (batch.counter > this._durableCounter) {
        await this._writeAtomic(this._counterPath, { version: 1, counter: batch.counter });
        this._durableCounter = batch.counter;
      }
      await this._writeAtomic(this._statePath, batch.snapshot);
      this._currentBatch = null;
      for (const waiter of batch.waiters) waiter.resolve();
    }
  }

  _fail(error) {
    this._failure = error;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    for (const batch of [this._currentBatch, this._pending]) {
      if (batch) for (const waiter of batch.waiters) waiter.reject(error);
    }
    this._currentBatch = null;
    this._pending = null;
  }

  async flush() {
    this._assertReady();
    while (this._pending || this._draining) {
      if (!this._draining) this._startDrain();
      if (this._drainPromise) await this._drainPromise;
      if (this._failure) throw this._failure;
    }
  }

  async archive(snapshot) {
    this._assertReady();
    const copy = structuredClone(snapshot);
    validateSnapshot(copy, 'archive snapshot');
    await this.save(copy);
    await this.flush();
    const filename = path.join(this._archiveDir, `${copy.gameId}.json`);
    await this._writeAtomic(filename, copy);
    return filename;
  }
}
