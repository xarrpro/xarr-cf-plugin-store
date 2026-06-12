import {
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
  createPublicKey,
  createPrivateKey,
  type KeyObject,
} from "node:crypto";

// 生成 Ed25519 密钥对,返回 PEM 文本与 raw 公钥 hex(供服务端 importKey "raw")
export function generateKeypair(): { privatePem: string; publicPem: string; publicHex: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return { privatePem, publicPem, publicHex: rawPublicHex(publicKey) };
}

// 从 spki 公钥提取 32 字节 raw 公钥的 hex
export function rawPublicHex(publicKey: KeyObject): string {
  const jwk = publicKey.export({ format: "jwk" }) as { x?: string };
  if (!jwk.x) throw new Error("无法提取 Ed25519 公钥");
  // jwk.x 是 base64url 的 raw 公钥
  return Buffer.from(jwk.x, "base64url").toString("hex");
}

// 对 message(sha256 hex 字符串)用私钥 PEM 签名,返回签名 hex
export function signHex(messageHex: string, privatePem: string): string {
  const key = createPrivateKey(privatePem);
  const sig = nodeSign(null, Buffer.from(messageHex), key);
  return sig.toString("hex");
}

// 本地验签(测试用):与服务端 verifyEd25519 语义一致
export function verifyHex(messageHex: string, signatureHex: string, publicPem: string): boolean {
  const key = createPublicKey(publicPem);
  return nodeVerify(null, Buffer.from(messageHex), key, Buffer.from(signatureHex, "hex"));
}
