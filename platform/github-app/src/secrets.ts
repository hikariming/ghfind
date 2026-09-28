async function cipherKey(env: Env) {
  return crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(env.SESSION_SECRET),
    ),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}
export async function seal(env: Env, value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await cipherKey(env),
    new TextEncoder().encode(value),
  );
  return `${Buffer.from(iv).toString("base64url")}.${Buffer.from(encrypted).toString("base64url")}`;
}
export async function unseal(env: Env, value: string) {
  const [iv, data] = value.split(".");
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: Buffer.from(iv, "base64url") },
      await cipherKey(env),
      Buffer.from(data, "base64url"),
    ),
  );
}
