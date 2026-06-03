import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { resolve, dirname } from "node:path";

const usersFile = resolve("data", "users.json");
const sessions = new Map();

function ensureUsersFile() {
  const dir = dirname(usersFile);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(usersFile)) writeFileSync(usersFile, JSON.stringify({ users: [] }, null, 2), "utf8");
}

function loadUsers() {
  ensureUsersFile();
  try {
    return JSON.parse(readFileSync(usersFile, "utf8")).users || [];
  } catch {
    return [];
  }
}

function saveUsers(users) {
  ensureUsersFile();
  writeFileSync(usersFile, JSON.stringify({ users }, null, 2), "utf8");
}

function hashPassword(password, saltHex = randomBytes(16).toString("hex")) {
  const derived = scryptSync(password, saltHex, 64);
  return `${saltHex}:${derived.toString("hex")}`;
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = (stored || "").split(":");
  if (!saltHex || !hashHex) return false;
  const actual = scryptSync(password, saltHex, 64);
  const expected = Buffer.from(hashHex, "hex");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function registerUser(username, password) {
  const name = String(username || "").trim();
  if (name.length < 3) throw new Error("用户名至少 3 个字符");
  if (String(password || "").length < 6) throw new Error("密码至少 6 位");
  const users = loadUsers();
  if (users.some((u) => u.username.toLowerCase() === name.toLowerCase())) {
    throw new Error("用户名已存在");
  }
  const user = {
    id: randomBytes(8).toString("hex"),
    username: name,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString()
  };
  users.push(user);
  saveUsers(users);
  return { id: user.id, username: user.username, createdAt: user.createdAt };
}

export function loginUser(username, password) {
  const name = String(username || "").trim();
  const users = loadUsers();
  const found = users.find((u) => u.username.toLowerCase() === name.toLowerCase());
  if (!found || !verifyPassword(password, found.passwordHash)) {
    throw new Error("用户名或密码错误");
  }
  const token = randomBytes(24).toString("hex");
  sessions.set(token, { userId: found.id, username: found.username, issuedAt: Date.now() });
  return { token, user: { id: found.id, username: found.username } };
}

export function logoutUser(token) {
  if (!token) return;
  sessions.delete(token);
}

export function getUserByToken(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  return { id: session.userId, username: session.username };
}

