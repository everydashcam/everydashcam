/** Best-effort preferences only. No cache: feature modules own session values,
 * validation and defaults. Probes, migrations and flows that distinguish a
 * blocked store from a missing key must keep their explicit error handling. */
export function readLocalStorage(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

export function writeLocalStorage(key: string, value: string): boolean {
    try {
        localStorage.setItem(key, value);
        return true;
    } catch {
        return false;
    }
}

export function removeLocalStorage(key: string): boolean {
    try {
        localStorage.removeItem(key);
        return true;
    } catch {
        return false;
    }
}

export function readLocalStorageJson(key: string): unknown {
    const raw = readLocalStorage(key);
    if (raw === null) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

export function writeLocalStorageJson(key: string, value: unknown): boolean {
    try {
        const json = JSON.stringify(value);
        return json !== undefined && writeLocalStorage(key, json);
    } catch {
        return false;
    }
}
