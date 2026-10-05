import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, lstat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const STORAGE_VERSION = 1;
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const publicFields = ['id', 'provider', 'platform', 'accountId', 'name', 'handle', 'url', 'connectedAt', 'updatedAt'];

export function readEncryptionKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return null;
  const key = Buffer.from(value, 'base64');
  return key.length === 32 && key.toString('base64') === value ? key : null;
}

function sessionId(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return createHash('sha256').update(token).digest('hex');
}

function publicChannel(channel, timestamp) {
  const metadata = Object.fromEntries(publicFields.filter((field) => channel[field] !== undefined).map((field) => [field, channel[field]]));
  const expiresAt = Date.parse(channel.tokens?.expiresAt);
  metadata.requiresReconnect = Number.isFinite(expiresAt) && expiresAt <= timestamp;
  if (Number.isFinite(expiresAt)) metadata.tokenExpiresAt = new Date(expiresAt).toISOString();
  return metadata;
}

export class EncryptedStore {
  constructor({ directory, key, now = Date.now }) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('A 32-byte encryption key is required.');
    this.directory = resolve(directory);
    this.path = join(this.directory, 'channels.enc.json');
    this.key = key;
    this.now = now;
    this.data = { sessions: {}, channels: {} };
    this.queue = Promise.resolve();
  }

  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directoryInfo = await lstat(this.directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('Invalid data directory.');
    let file;
    try {
      const info = await lstat(this.path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024) throw new Error('Invalid encrypted storage file.');
      file = await readFile(this.path, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return this;
      throw error;
    }
    try {
      const envelope = JSON.parse(file);
      if (envelope.version !== STORAGE_VERSION) throw new Error('Unsupported version.');
      const iv = Buffer.from(envelope.iv, 'base64');
      const tag = Buffer.from(envelope.tag, 'base64');
      if (iv.length !== 12 || tag.length !== 16) throw new Error('Invalid encryption envelope.');
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv, { authTagLength: 16 });
      decipher.setAAD(Buffer.from(`emc-channels:${STORAGE_VERSION}`));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
      const data = JSON.parse(plaintext.toString('utf8'));
      if (!data || !data.sessions || !data.channels || typeof data.sessions !== 'object' || typeof data.channels !== 'object' || Array.isArray(data.sessions) || Array.isArray(data.channels)) throw new Error('Invalid data.');
      this.data = data;
    } catch {
      throw new Error('Encrypted channel storage could not be opened. Check the encryption key and restore a valid backup.');
    }
    return this;
  }

  async persist(data) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`emc-channels:${STORAGE_VERSION}`));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
    const envelope = JSON.stringify({ version: STORAGE_VERSION, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
    const temporaryPath = join(this.directory, `.channels-${randomBytes(12).toString('hex')}.tmp`);
    try {
      await writeFile(temporaryPath, envelope, { encoding: 'utf8', flag: 'wx', mode: 0o600, flush: true });
      await rename(temporaryPath, this.path);
    } finally {
      await unlink(temporaryPath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  mutate(operation) {
    const next = this.queue.then(async () => {
      const copy = structuredClone(this.data);
      const result = operation(copy);
      await this.persist(copy);
      this.data = copy;
      return result;
    });
    this.queue = next.catch(() => {});
    return next;
  }

  async createSession() {
    const token = randomBytes(32).toString('base64url');
    const id = sessionId(token);
    const expiresAt = this.now() + SESSION_DURATION_MS;
    await this.mutate((data) => {
      for (const [key, session] of Object.entries(data.sessions)) {
        if (session.expiresAt <= this.now()) {
          delete data.sessions[key];
          delete data.channels[key];
        }
      }
      data.sessions[id] = { expiresAt };
      data.channels[id] = [];
    });
    return { sessionToken: token, expiresAt: new Date(expiresAt).toISOString() };
  }

  getSession(token) {
    const id = sessionId(token);
    const session = id ? this.data.sessions[id] : null;
    return session && session.expiresAt > this.now() ? { id, expiresAt: new Date(session.expiresAt).toISOString() } : null;
  }

  listChannels(token) {
    const session = this.getSession(token);
    if (!session) return null;
    return { channels: (this.data.channels[session.id] || []).map((channel) => publicChannel(channel, this.now())), expiresAt: session.expiresAt };
  }

  async addChannels(token, channels) {
    const session = this.getSession(token);
    if (!session) throw new Error('Session expired.');
    return this.mutate((data) => {
      const list = data.channels[session.id] || [];
      const timestamp = new Date(this.now()).toISOString();
      for (const source of channels) {
        if (!source || typeof source.provider !== 'string' || typeof source.platform !== 'string' || typeof source.accountId !== 'string' || !source.accountId || !source.tokens?.accessToken) throw new Error('Invalid channel data.');
        const existing = list.find((item) => item.provider === source.provider && item.platform === source.platform && item.accountId === source.accountId);
        const metadata = {};
        for (const field of ['provider', 'platform', 'accountId', 'name', 'handle', 'url']) {
          if (typeof source[field] === 'string') metadata[field] = source[field].slice(0, field === 'url' ? 2048 : 256);
        }
        if (!metadata.name) metadata.name = metadata.platform;
        if (existing) Object.assign(existing, metadata, { tokens: structuredClone(source.tokens), updatedAt: timestamp });
        else list.push({ ...metadata, id: randomBytes(16).toString('hex'), tokens: structuredClone(source.tokens), connectedAt: timestamp, updatedAt: timestamp });
      }
      data.channels[session.id] = list;
      return list.map((channel) => publicChannel(channel, this.now()));
    });
  }

  async removeChannel(token, id) {
    const session = this.getSession(token);
    if (!session) return false;
    return this.mutate((data) => {
      const list = data.channels[session.id] || [];
      const filtered = list.filter((item) => item.id !== id);
      data.channels[session.id] = filtered;
      return filtered.length !== list.length;
    });
  }
}
