import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const copy = (value) => structuredClone(value);

/** A serial, atomic JSON store (per Electron userData directory). */
export function createStorage(filePath, onChanged = () => {}) {
  let state;
  let queue = Promise.resolve();

  async function load() {
    if (state !== undefined) return;
    try {
      const raw = JSON.parse(await readFile(filePath, 'utf8'));
      state = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // Do not destroy unreadable/corrupt user data silently.
        throw new Error('Не удалось прочитать локальные данные Time Tracker', { cause: error });
      }
      state = {};
    }
  }

  async function persist() {
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(temporary, filePath);
  }

  // Get requests share the same serialized queue as writes, so reads are
  // consistent and concurrent mutations cannot overwrite each other.
  function transact(action) {
    const job = queue.then(async () => {
      await load();
      return action();
    });
    queue = job.then(() => undefined, () => undefined);
    return job;
  }

  return {
    get(keys) {
      return transact(() => {
        if (keys === null || keys === undefined) return copy(state);
        if (typeof keys === 'string') {
          return own(state, keys) ? { [keys]: copy(state[keys]) } : {};
        }
        if (Array.isArray(keys)) {
          return Object.fromEntries(keys.filter((key) => own(state, key))
            .map((key) => [key, copy(state[key])]));
        }
        if (typeof keys === 'object') {
          return Object.fromEntries(Object.keys(keys).map((key) =>
            [key, copy(own(state, key) ? state[key] : keys[key])]));
        }
        throw new TypeError('Некорректный ключ хранилища');
      });
    },
    set(items) {
      return transact(async () => {
        if (!items || typeof items !== 'object' || Array.isArray(items)) {
          throw new TypeError('Ожидается объект значений');
        }
        const changes = {};
        const previous = state;
        const next = { ...previous };
        for (const [key, value] of Object.entries(items)) {
          if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
            throw new Error('Недопустимый ключ');
          }
          changes[key] = { oldValue: copy(previous[key]), newValue: copy(value) };
          next[key] = copy(value);
        }
        state = next;
        try {
          await persist();
        } catch (error) {
          state = previous;
          throw error;
        }
        if (Object.keys(changes).length) onChanged(changes);
      });
    },
    remove(keys) {
      return transact(async () => {
        const names = Array.isArray(keys) ? keys : [keys];
        const changes = {};
        const previous = state;
        const next = { ...previous };
        for (const key of names) {
          if (own(next, key)) {
            changes[key] = { oldValue: copy(next[key]) };
            delete next[key];
          }
        }
        state = next;
        try {
          await persist();
        } catch (error) {
          state = previous;
          throw error;
        }
        if (Object.keys(changes).length) onChanged(changes);
      });
    },
  };
}
