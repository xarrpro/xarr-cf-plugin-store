function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function verifyEd25519(messageHex: string, signatureHex: string, publicKeyHex: string): Promise<boolean> {
  try {
    const pub = await crypto.subtle.importKey("raw", hexToBytes(publicKeyHex), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, pub, hexToBytes(signatureHex), new TextEncoder().encode(messageHex));
  } catch {
    return false;
  }
}
